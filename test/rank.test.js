import test from 'node:test';
import assert from 'node:assert/strict';
import { rankForUser } from '../src/agent/rank.js';
import { makeCatalog, mv, newStore, addWatched } from './helpers.js';

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

test('friends only influence you when they share and you follow them', () => {
  const { catalog, store, user } = world();
  const sam = store.createUser({ name: 'Sam', sharing: 'friends' });
  addWatched(store, sam.id, [20], 'liked');
  const plain = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!plain.recommendations.find((x) => x.movie.id === 20).reasons.some((r) => r.signal === 'friends'), 'not following: no signal');

  store.follow(user.id, sam.id);
  const followed = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  const rec = followed.recommendations.find((x) => x.movie.id === 20);
  assert.ok(rec.reasons.some((r) => r.signal === 'friends' && /Sam watched and liked it/.test(r.text)));
  assert.ok(rec.score > plain.recommendations.find((x) => x.movie.id === 20).score);

  store.updateUser(sam.id, { sharing: 'private' });
  const revoked = rankForUser({ userId: user.id, store, catalog, limit: 20 });
  assert.ok(!revoked.recommendations.find((x) => x.movie.id === 20).reasons.some((r) => r.signal === 'friends'), 'consent revoked');
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
  store.follow(user.id, twin.id);
  store.follow(user.id, opposite.id);
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
