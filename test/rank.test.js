import test from 'node:test';
import assert from 'node:assert/strict';
import { rankForUser, evidenceTrust } from '../src/agent/rank.js';
import { makeCatalog, mv, newStore, addWatched, roomOf } from './helpers.js';

const scifi = (id, r = [7, 1000]) => mv(id, `SciFi ${id}`, ['Science Fiction'], { keywords: ['space'], rating: r });

function world() {
  const catalog = makeCatalog([
    scifi(1), scifi(2), scifi(3), scifi(4), scifi(5), scifi(6),
    scifi(10, [7.0, 2000]),
    scifi(11, [6.9, 2000]),
    mv(20, 'Big Romance', ['Romance'], { keywords: ['wedding'], rating: [8.6, 20000] }),
    mv(21, 'Scary Night', ['Horror'], { rating: [8.0, 9000] }),
    mv(22, 'Marathon Epic', ['Drama'], { runtime: 200, rating: [8.0, 9000] }),
    mv(23, 'Old Classic', ['Drama'], { year: 1950, rating: [8.0, 9000] }),
    mv(24, 'No Ratings Yet', ['Drama'], { rating: null }),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  return { catalog, store, user };
}

test('empty history and no preferences: falls back to crowd ratings and says so', () => {
  const { catalog, store, user } = world();
  const r = rankForUser({ userId: user.id, store, catalog, limit: 5 });
  assert.equal(r.profile.coldStart, true);
  assert.equal(r.recommendations[0].movie.title, 'Big Romance', 'highest crowd rating leads when nothing else is known');
  assert.ok(r.notes.some((n) => /Very little history/.test(n)));
  assert.ok(r.recommendations[0].tradeoffs.some((t) => /leans on crowd ratings/.test(t)));
  assert.ok(r.trace.length === 0, 'trace is only filled when requested');
});

test('history outweighs popularity: a liked genre beats a higher-rated stranger', () => {
  const { catalog, store, user } = world();
  addWatched(store, user.id, [1, 2, 3, 4, 5, 6]);
  const r = rankForUser({ userId: user.id, store, catalog, limit: 3 });
  assert.equal(r.recommendations[0].movie.title, 'SciFi 10');
  assert.match(r.recommendations[0].reasons[0].text, /Similar to SciFi/);
  assert.ok(r.weights.taste > r.weights.crowd);
});

test('hard constraints: seen, avoided genre, runtime and era are removed and counted', () => {
  const { catalog, store, user } = world();
  store.updateUser(user.id, { prefs: { avoidGenres: ['Horror'], maxRuntime: 150, minYear: 1980 } });
  addWatched(store, user.id, [1]);
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  const titles = r.recommendations.map((x) => x.movie.title);
  for (const gone of ['SciFi 1', 'Scary Night', 'Marathon Epic', 'Old Classic']) assert.ok(!titles.includes(gone), gone);
  assert.deepEqual(r.filtered, { 'already-seen': 1, 'avoided-genre': 1, 'too-long': 1, 'too-old': 1 });
});

test('missing ratings are scored neutrally and flagged, not invented', () => {
  const { catalog, store, user } = world();
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  const rec = r.recommendations.find((x) => x.movie.title === 'No Ratings Yet');
  assert.ok(rec);
  assert.equal(rec.components.crowd, 0.5);
  assert.ok(rec.tradeoffs.includes('No rating data available'));
  assert.equal(rec.movie.rating.consensus, null);
});

test('every recommendation carries reasons, confidence, tier and alternatives', () => {
  const { catalog, store, user } = world();
  addWatched(store, user.id, [1, 2, 3]);
  const r = rankForUser({ userId: user.id, store, catalog, limit: 4 });
  for (const rec of r.recommendations) {
    assert.ok(rec.reasons.length > 0);
    assert.ok(['High', 'Medium', 'Low'].includes(rec.confidence.label));
    assert.ok(rec.tier);
    assert.ok(Array.isArray(rec.alternatives));
  }
});

test('disliked movies push similar ones down', () => {
  const { catalog, store, user } = world();
  addWatched(store, user.id, [1, 2, 3, 4], 'liked');
  const base = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  const baseScore = base.recommendations.find((x) => x.movie.title === 'SciFi 10').score;
  addWatched(store, user.id, [5, 6], 'disliked');
  const after = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(after.recommendations.find((x) => x.movie.title === 'SciFi 10').score < baseScore);
});

test('human disagreement is recorded, removes the pick, down-ranks lookalikes, and is explained', () => {
  const { catalog, store, user } = world();
  addWatched(store, user.id, [1, 2, 3, 4, 5, 6]);
  const before = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.equal(before.recommendations[0].movie.title, 'SciFi 10');
  const twinBefore = before.recommendations.find((x) => x.movie.title === 'SciFi 11');

  const fb = store.addFeedback({ userId: user.id, movieId: 10, kind: 'not-my-taste', reason: 'Too slow for me', context: 'solo' });
  assert.equal(store.feedbackFor(user.id).length, 1, 'stored, not discarded');
  assert.equal(fb.reason, 'Too slow for me');

  const after = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!after.recommendations.some((x) => x.movie.id === 10), 'the contested pick is gone');
  assert.equal(after.filtered['rejected-by-you'], 1);
  const twin = after.recommendations.find((x) => x.movie.title === 'SciFi 11');
  assert.ok(twin.score < twinBefore.score, 'a lookalike is down-ranked');
  assert.ok(twin.reasons.some((x) => x.signal === 'feedback' && /Too slow for me/.test(x.text)), 'the human reason is shown');
  assert.ok(twin.components.feedback < 0);
});

test('"seen it" feedback marks the movie as watched instead of penalizing lookalikes', () => {
  const { catalog, store, user } = world();
  store.addFeedback({ userId: user.id, movieId: 10, kind: 'seen-it', reason: '', context: 'solo' });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!r.recommendations.some((x) => x.movie.id === 10));
  assert.equal(r.filtered['already-seen'], 1);
});

test('friends only influence you while you share a screening room with them', () => {
  const { catalog, store, user } = world();
  const sam = store.createUser({ name: 'Sam' });
  addWatched(store, sam.id, [20], 'liked');
  const plain = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!plain.recommendations.find((x) => x.movie.id === 20).reasons.some((r) => r.signal === 'friends'), 'not in a room together: no signal');
  assert.ok(!plain.notes.some((n) => /Friend signals used/.test(n)));

  const room = roomOf(store, user, sam);
  const inRoom = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  const rec = inRoom.recommendations.find((x) => x.movie.id === 20);
  assert.ok(rec.reasons.some((r) => r.signal === 'friends' && /Sam watched and liked it/.test(r.text)));
  assert.ok(rec.score > plain.recommendations.find((x) => x.movie.id === 20).score);
  assert.ok(inRoom.notes.some((n) => /Friend signals used: Sam/.test(n)));

  store.leaveRoom(room.code, sam.id);
  const left = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!left.recommendations.find((x) => x.movie.id === 20).reasons.some((r) => r.signal === 'friends'), 'left the room: no signal');
});

test('friend signals are not transitive: a friend of a friend in another room is not used', () => {
  const { catalog, store, user } = world();
  const sam = store.createUser({ name: 'Sam' });
  const kim = store.createUser({ name: 'Kim' });
  roomOf(store, user, sam);
  roomOf(store, sam, kim);
  addWatched(store, kim.id, [20], 'liked');
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!r.recommendations.find((x) => x.movie.id === 20).reasons.some((x) => x.signal === 'friends'));
});

test('a friend who disagrees with you counts for less than one who agrees', () => {
  const { catalog, store, user } = world();
  addWatched(store, user.id, [1, 2, 3], 'liked');
  const twin = store.createUser({ name: 'Twin' });
  const opposite = store.createUser({ name: 'Opposite' });
  addWatched(store, twin.id, [1, 2, 3], 'liked');
  addWatched(store, opposite.id, [1, 2, 3], 'disliked');
  addWatched(store, twin.id, [20], 'liked');
  addWatched(store, opposite.id, [20], 'liked');
  roomOf(store, user, twin, opposite);
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  const lines = r.recommendations.find((x) => x.movie.id === 20).reasons.filter((x) => x.signal === 'friends');
  assert.match(lines.find((l) => l.friend === 'Twin').text, /100% of 3/);
  assert.match(lines.find((l) => l.friend === 'Opposite').text, /0% of 3/);
  assert.ok(lines.find((l) => l.friend === 'Twin').impact > lines.find((l) => l.friend === 'Opposite').impact);
});

test('diversity: the list is not ten near-duplicates', () => {
  const { catalog, store, user } = world();
  addWatched(store, user.id, [1, 2]);
  const r = rankForUser({ userId: user.id, store, catalog, limit: 5 });
  const genres = new Set(r.recommendations.flatMap((x) => x.movie.genres));
  assert.ok(genres.size >= 2);
});

test('agent trace lists the tool calls it made', () => {
  const { catalog, store, user } = world();
  const steps = [];
  const trace = { steps, step: (tool, input, summary) => steps.push({ tool, summary }) };
  rankForUser({ userId: user.id, store, catalog, trace });
  assert.deepEqual(steps.map((s) => s.tool), ['load_profile', 'search_catalog', 'apply_constraints', 'cross_reference_ratings', 'rank_and_diversify']);
});

// ---------- filter reasons ----------

test('every hard filter is counted under its own code, and none of them leak into the list', () => {
  const gory = { text: 'So much gore.', user: 'x', likes: 1 };
  const bloody = { text: 'Bloody and brutal.', user: 'y', likes: 1 };
  const catalog = makeCatalog([
    mv(1, 'Seen Already', ['Drama']),
    mv(2, 'Turned Down', ['Drama']),
    mv(3, 'Making of Something', ['Drama']),
    mv(4, 'Tiny Short', ['Drama'], { runtime: 15 }),
    mv(5, 'Scary Night', ['Horror']),
    mv(6, 'Clown College', ['Drama']),
    mv(7, 'Gore Fest', ['Drama'], { reviews: [gory, bloody] }),
    mv(8, 'Marathon Epic', ['Drama'], { runtime: 200 }),
    mv(9, 'Old Classic', ['Drama'], { year: 1950 }),
    mv(10, 'Just Fine', ['Drama']),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  store.updateUser(user.id, { prefs: { avoidGenres: ['Horror'], hardNoTerms: ['clown'], avoidFlags: ['graphic-violence'], maxRuntime: 150, minYear: 1980 } });
  addWatched(store, user.id, [1]);
  store.addFeedback({ userId: user.id, movieId: 2, kind: 'not-my-taste', context: 'solo' });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.deepEqual(r.filtered, {
    'already-seen': 1,
    'rejected-by-you': 1,
    'not-a-feature': 2,
    'avoided-genre': 1,
    'hard-no-term': 1,
    'content-flag': 1,
    'too-long': 1,
    'too-old': 1,
  });
  assert.deepEqual(r.recommendations.map((x) => x.movie.title), ['Just Fine']);
});

test('a hard-no word matches the title, synopsis or theme, but only at the start of a word', () => {
  const catalog = makeCatalog([
    mv(1, 'The Clown House', ['Drama']),
    mv(2, 'Quiet Night', ['Drama'], { overview: 'A retired Clown finds peace.' }),
    mv(3, 'Moody Piece', ['Drama'], { themes: ['Dark humor about clowns'] }),
    mv(4, 'Unclownlike Man', ['Drama']),
    mv(5, 'Plain Film', ['Drama']),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  store.updateUser(user.id, { prefs: { hardNoTerms: ['clown'] } });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.equal(r.filtered['hard-no-term'], 3);
  assert.deepEqual(r.recommendations.map((x) => x.movie.title).sort(), ['Plain Film', 'Unclownlike Man']);
});

test('one content mention is a caution on the pick, not a filter', () => {
  const catalog = makeCatalog([mv(1, 'One Mention', ['Drama'], { reviews: [{ text: 'So much gore.', user: 'x', likes: 1 }] })]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  store.updateUser(user.id, { prefs: { avoidFlags: ['graphic-violence'] } });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 5 });
  assert.equal(r.recommendations.length, 1);
  assert.deepEqual(r.filtered, {});
  assert.ok(r.recommendations[0].tradeoffs.some((t) => /Worth a quick check/.test(t)));
});

test('featurettes and shorts are never recommended, whatever their rating', () => {
  const catalog = makeCatalog([
    mv(1, 'Blockbuster: Behind the Scenes', ['Drama'], { rating: [9.9, 90000] }),
    mv(2, 'Film Short', ['Drama'], { runtime: 20, rating: [9.9, 90000] }),
    mv(3, 'Ordinary Feature', ['Drama'], { rating: [6.0, 3000] }),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 5 });
  assert.deepEqual(r.recommendations.map((x) => x.movie.title), ['Ordinary Feature']);
  assert.equal(r.filtered['not-a-feature'], 2);
});

// ---------- mood ----------

test('a mood nudges matching genres up, says so, and warns when a film runs against it', () => {
  const catalog = makeCatalog([
    mv(1, 'Feel Good Comedy', ['Comedy'], { rating: [7.5, 20000] }),
    mv(2, 'Grim War Story', ['War'], { rating: [7.5, 20000] }),
    mv(3, 'Plain Thriller', ['Thriller'], { rating: [7.5, 20000] }),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  store.updateUser(user.id, { prefs: { mood: 'cozy' } });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 3 });
  assert.equal(r.recommendations[0].movie.title, 'Feel Good Comedy');
  assert.ok(r.recommendations[0].reasons.some((x) => x.signal === 'mood' && /Fits your mood/.test(x.text)));
  const grim = r.recommendations.find((x) => x.movie.title === 'Grim War Story');
  assert.ok(grim.tradeoffs.some((t) => /Runs against your mood/.test(t)));
  assert.equal(r.recommendations[2].movie.title, 'Grim War Story', 'the clashing film ranks last');
  assert.equal(r.profile.mood, 'Cozy and comforting');
});

test('an unknown mood is ignored instead of breaking the ranking', () => {
  const catalog = makeCatalog([mv(1, 'A', ['Drama']), mv(2, 'B', ['Comedy'])]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  store.updateUser(user.id, { prefs: { mood: 'not-a-mood' } });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 5 });
  assert.equal(r.recommendations.length, 2);
  assert.equal(r.profile.mood, null);
});

// ---------- how much a crowd rating is trusted ----------

test('evidenceTrust grows with the number of votes and stays within 0.2 and 1', () => {
  assert.equal(evidenceTrust(0), 0.2);
  assert.equal(evidenceTrust(1), 0.2);
  assert.equal(evidenceTrust(30), 0.2, 'a couple of dozen votes are barely evidence');
  assert.ok(evidenceTrust(1000) > evidenceTrust(100));
  assert.ok(evidenceTrust(100000) > evidenceTrust(1000));
  assert.equal(evidenceTrust(1e9), 1);
  for (const v of [0, 5, 50, 500, 5000, 50000, 5e6]) assert.ok(evidenceTrust(v) >= 0.2 && evidenceTrust(v) <= 1);
});

test('a rating from a handful of votes barely moves the rank, while the same rating from many votes does', () => {
  const catalog = makeCatalog([
    mv(1, 'Tiny Hit', ['Drama'], { rating: [9.5, 30] }),
    mv(2, 'Big Hit', ['Drama'], { rating: [9.0, 30000] }),
    mv(3, 'Average Joe', ['Drama'], { rating: [7.0, 30000] }),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 3 });
  assert.deepEqual(r.recommendations.map((x) => x.movie.title), ['Big Hit', 'Tiny Hit', 'Average Joe']);
  const tiny = r.recommendations.find((x) => x.movie.title === 'Tiny Hit');
  const big = r.recommendations.find((x) => x.movie.title === 'Big Hit');
  assert.ok(tiny.components.crowd < big.components.crowd, 'a higher score on 30 votes counts for less than a lower one on 30,000');
  assert.ok(tiny.components.crowd > 0.5 && tiny.components.crowd < 0.6, `shrunk toward neutral: ${tiny.components.crowd}`);
  assert.ok(tiny.tradeoffs.includes('Rating is based on very few votes'));
});

test('review engagement stands in for votes when the source has no real count', () => {
  const proxied = (id, title, votesProxy) => ({ ...mv(id, title, ['Drama'], { rating: null }), ratings: [{ source: 'letterboxd', value: 9, votes: null, votesProxy, kind: 'audience' }] });
  const catalog = makeCatalog([proxied(1, 'Engaged', 90000), proxied(2, 'Quiet', 25), mv(3, 'Baseline', ['Drama'], { rating: [7, 30000] })]);
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  const r = rankForUser({ userId: user.id, store, catalog, limit: 3 });
  assert.equal(r.recommendations[0].movie.title, 'Engaged');
  const quiet = r.recommendations.find((x) => x.movie.title === 'Quiet');
  const engaged = r.recommendations.find((x) => x.movie.title === 'Engaged');
  assert.ok(quiet.components.crowd < engaged.components.crowd);
  assert.ok(!engaged.reasons.find((x) => x.signal === 'crowd').text.includes('ratings counted'), 'a proxy is never presented as a real vote count');
});

// ---------- determinism ----------

test('equal scores are ordered by id, so the same data always gives the same list', () => {
  const build = (order) => makeCatalog(order.map((id) => mv(id, `Film ${id}`, ['Drama'], { rating: [7, 3000] })));
  const store = newStore();
  const user = store.createUser({ name: 'Ada' });
  const a = rankForUser({ userId: user.id, store, catalog: build(['zeta', 'alpha', 'mike']), limit: 3 });
  const b = rankForUser({ userId: user.id, store, catalog: build(['mike', 'zeta', 'alpha']), limit: 3 });
  assert.deepEqual(a.recommendations.map((x) => x.movie.id), b.recommendations.map((x) => x.movie.id));
  assert.equal(new Set(a.recommendations.map((x) => x.movie.id)).size, 3);
});
