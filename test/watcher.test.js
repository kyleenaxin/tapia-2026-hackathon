import test from 'node:test';
import assert from 'node:assert/strict';
import { addMovieWithAgents } from '../src/agent/watcher.js';
import { makeCatalog, mv, newStore, addWatched, roomOf } from './helpers.js';

const scifi = (id, r = [7, 3000]) => mv(id, `SciFi ${id}`, ['Science Fiction'], { keywords: ['space'], rating: r });

function world() {
  const catalog = makeCatalog([
    scifi(1), scifi(2), scifi(3), scifi(4),
    scifi(10, [6.8, 5000]),
    scifi(11, [7.4, 5000]),
    scifi(12, [7.3, 5000]),
    mv(20, 'Rom Com', ['Romance', 'Comedy'], { rating: [7.8, 5000] }),
    mv(21, 'Nightmare', ['Horror'], { rating: [8.0, 5000] }),
    mv(22, 'Late Night Talk', ['Drama'], { rating: [6.0, 5000] }),
  ]);
  const store = newStore();
  const me = store.createUser({ name: 'Me' });
  const sam = store.createUser({ name: 'Sam' });
  addWatched(store, me.id, [1, 2, 3, 4], 'liked');
  addWatched(store, sam.id, [1, 2, 3, 4], 'liked');
  const room = roomOf(store, me, sam);
  return { catalog, store, me, sam, room };
}

// The cutoffs documented for the watcher: they scale with how many films the viewer is choosing among.
const strongCut = (total) => Math.min(Math.max(10, Math.ceil(total * 0.005)), Math.ceil(total / 3));
const maybeCut = (total) => Math.min(Math.max(50, Math.ceil(total * 0.05)), Math.ceil((total * 2) / 3));
const expectedAction = (rank, total) => (rank <= strongCut(total) ? 'watch' : rank <= maybeCut(total) ? 'maybe' : 'skip');

test('roommate adds a movie: the agent explains what changed and recommends watching it', () => {
  const { catalog, store, me, sam } = world();
  const { event, analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.ok(event);
  const a = analyses[me.id];
  assert.ok(['watch', 'maybe'].includes(a.action));
  assert.match(a.headline, /^Watch it: Sam watched and liked it, and SciFi 10 ranks #\d+ of 6 for you \(top \d+%\)/);
  assert.ok(a.movieScore.after > a.movieScore.before, `score ${a.movieScore.before} -> ${a.movieScore.after}`);
  assert.ok(a.movieRank.after <= a.movieRank.before);
  assert.equal(a.movieRank.of, 6, 'ten films, minus the four this viewer has already seen');
  assert.ok(a.reasoning.some((r) => /Sam watched and liked it/.test(r)));
  assert.equal(a.trust.overlap, 4);
  assert.equal(a.trust.agreement, 1);
  assert.ok(a.closestInYourHistory.length > 0 && a.closestInYourHistory[0].yourVerdict === 'liked');
  assert.ok(a.alsoConsider.some((x) => x.movie.title === 'SciFi 11'), 'recommends similar movies too');
  assert.ok(a.snapshots.before.length && a.snapshots.after.length);
  assert.equal(store.eventsFor(me.id).length, 1);
});

test('the headline states the rank, the pool it was ranked in, and where it was before', () => {
  const { catalog, store, me, sam } = world();
  const a = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' }).analyses[me.id];
  const { before, after, of } = a.movieRank;
  assert.ok(after < before, 'the roommate signal moved it up');
  assert.ok(a.headline.includes(`ranks #${after} of ${of} for you`));
  assert.ok(a.headline.includes(`up from #${before} before`));
  assert.match(a.headline, new RegExp(`top ${Math.round((after / of) * 100)}%`));
  assert.ok(a.headline.endsWith('.'));
});

test('a film that did not move says it was already there', () => {
  const { catalog, store, me, sam } = world();
  const a = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 22, status: 'watched', verdict: 'liked' }).analyses[me.id];
  assert.equal(a.movieRank.before, a.movieRank.after);
  assert.match(a.headline, new RegExp(`ranks #${a.movieRank.after} of 6 for you \\(top 100%\\), was #${a.movieRank.before} before\\.$`));
  assert.ok(!/up from/.test(a.headline));
});

test('the roommate signal also lifts lookalikes of what the roommate liked', () => {
  const { catalog, store, me, sam } = world();
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  const lookalike = analyses[me.id].snapshots.after.find((m) => m.title === 'SciFi 11');
  assert.ok(lookalike);
});

test('a movie the viewer already watched is compared instead of re-recommended', () => {
  const { catalog, store, me, sam } = world();
  addWatched(store, me.id, [10], 'disliked');
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  const a = analyses[me.id];
  assert.equal(a.action, 'already-seen');
  assert.match(a.headline, /You already watched SciFi 10 and disliked it/);
  assert.ok(a.reasoning.some((r) => /disagree/.test(r)));
});

test('a roommate adding something in a genre you avoid gets a skip with the reason', () => {
  const { catalog, store, me, sam } = world();
  store.updateUser(me.id, { prefs: { avoidGenres: ['Horror'] } });
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 21, status: 'watched', verdict: 'liked' });
  assert.equal(analyses[me.id].action, 'skip');
  assert.match(analyses[me.id].headline, /genre you asked to avoid/);
  assert.deepEqual(analyses[me.id].alsoConsider, []);
});

test('a hard-no word or content flag on the roommate\'s pick is a skip that names the reason', () => {
  const gory = { text: 'So much gore.', user: 'x', likes: 1 };
  const bloody = { text: 'Bloody and brutal.', user: 'y', likes: 1 };
  const { store, me, sam } = world();
  const catalog = makeCatalog([
    scifi(1), scifi(2), scifi(3), scifi(4), scifi(10),
    mv(30, 'Clown Night', ['Comedy']),
    mv(31, 'Gore Fest', ['Comedy'], { reviews: [gory, bloody] }),
  ]);
  store.updateUser(me.id, { prefs: { hardNoTerms: ['clown'], avoidFlags: ['graphic-violence'] } });
  const add = (id) => addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: id, status: 'watched', verdict: 'liked' }).analyses[me.id];
  assert.match(add(30).headline, /^Skip Clown Night: Sam watched and liked it, but it matches one of your hard no's\.$/);
  assert.match(add(31).headline, /^Skip Gore Fest: Sam watched and liked it, but it has content you asked to avoid\.$/);
});

// filterReason() can return 'not-a-feature', but the watcher's reason table has no text for it, so the headline ends "but undefined."
test('a roommate adding a featurette or a short gets a skip that says it is not a feature film', () => {
  const { store, me, sam } = world();
  const catalog = makeCatalog([scifi(1), scifi(2), scifi(3), scifi(4), scifi(10), mv(32, 'Making of Something', ['Comedy']), mv(33, 'Tiny Short', ['Comedy'], { runtime: 12 })]);
  for (const id of [32, 33]) {
    const a = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: id, status: 'watched', verdict: 'liked' }).analyses[me.id];
    assert.equal(a.action, 'skip');
    assert.ok(!/undefined/.test(a.headline), a.headline);
    assert.match(a.headline, /feature film|featurette|short/i);
  }
});

test('a movie the viewer already turned down is skipped, with the reason', () => {
  const { catalog, store, me, sam } = world();
  store.addFeedback({ userId: me.id, movieId: 10, kind: 'not-my-taste', reason: 'Too slow', context: 'solo' });
  const a = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' }).analyses[me.id];
  assert.equal(a.action, 'skip');
  assert.match(a.headline, /you already rejected it/);
});

test('a weak match is not pushed just because a roommate added it', () => {
  const { catalog, store, me, sam } = world();
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 22, status: 'watched', verdict: 'liked' });
  assert.notEqual(analyses[me.id].action, 'watch');
});

test('watchlist adds trigger the agent too, described as interest rather than a rating', () => {
  const { catalog, store, me, sam } = world();
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watchlist' });
  assert.match(analyses[me.id].headline, /added it to their watchlist/);
});

// ---------- how strong a recommendation has to be, relative to the size of the catalog ----------

test('small catalog: watch, maybe and skip use caps of a third and two thirds of what is left', () => {
  assert.equal(strongCut(6), 2);
  assert.equal(maybeCut(6), 4);
  const seen = {};
  for (const id of [10, 21, 22]) {
    const { catalog, store, me, sam } = world();
    const a = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: id, status: 'watched', verdict: 'liked' }).analyses[me.id];
    assert.equal(a.movieRank.of, 6);
    assert.equal(a.action, expectedAction(a.movieRank.after, 6), `${a.movie.title} at #${a.movieRank.after} of 6`);
    seen[a.action] = true;
  }
  assert.deepEqual(Object.keys(seen).sort(), ['maybe', 'skip', 'watch'], 'the three sample films land in three different bands');
});

test('large catalog: "watch" means roughly the top half percent and "maybe" the top five percent', () => {
  const N = 1200;
  const films = Array.from({ length: N }, (_, i) => mv(`m${String(i).padStart(4, '0')}`, `Film ${i}`, ['Drama'], { rating: [9 - (i * 4) / (N - 1), 30000] }));
  assert.equal(strongCut(N), 10);
  assert.equal(maybeCut(N), 60);
  const seen = {};
  for (const i of [0, 55, 100, 700]) {
    const catalog = makeCatalog(films);
    const store = newStore();
    const me = store.createUser({ name: 'Me' });
    const sam = store.createUser({ name: 'Sam' });
    roomOf(store, me, sam);
    const a = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: films[i].id, status: 'watched', verdict: 'liked' }).analyses[me.id];
    assert.equal(a.movieRank.of, N);
    assert.equal(a.action, expectedAction(a.movieRank.after, N), `Film ${i} at #${a.movieRank.after} of ${N}`);
    assert.ok(a.headline.includes(`of ${N.toLocaleString('en-US')} for you`), 'thousands are formatted');
    seen[a.action] = true;
    if (i === 55) assert.ok(a.movieRank.after > 1 && a.movieRank.after <= strongCut(N) && a.action === 'watch', `sample should sit inside the strong band but not at #1, got #${a.movieRank.after}`);
    if (i === 0) assert.match(a.headline, /\(top 0\.1%\)|\(top 0\.\d%\)/, 'a very high rank reads as a fraction of a percent');
  }
  assert.deepEqual(Object.keys(seen).sort(), ['maybe', 'skip', 'watch'], 'the sample covers all three bands');
});

// ---------- who gets told ----------

test('privacy: nothing fires when the actor shares no room with anyone', () => {
  const { catalog, store, me } = world();
  const loner = store.createUser({ name: 'Loner' });
  const r = addMovieWithAgents({ store, catalog, actorId: loner.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.equal(r.event, null);
  assert.deepEqual(r.analyses, {});
  assert.equal(r.created, true, 'the entry itself is still saved for its owner');
  assert.equal(store.eventsFor(me.id).length, 0);
});

test('privacy: leaving the room stops the roommate from hearing about your additions', () => {
  const { catalog, store, me, sam, room } = world();
  store.leaveRoom(room.code, sam.id);
  const r = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.equal(r.event, null);
  assert.equal(store.eventsFor(me.id).length, 0);
});

test('privacy: only people who share a room with the actor are analysed', () => {
  const { catalog, store, me, sam } = world();
  const kim = store.createUser({ name: 'Kim' });
  roomOf(store, sam, kim);
  const outsider = store.createUser({ name: 'Outsider' });
  const r = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 11, status: 'watched', verdict: 'liked' });
  assert.deepEqual(Object.keys(r.analyses).sort(), [me.id, kim.id].sort());
  assert.equal(store.eventsFor(outsider.id).length, 0);
});

test('privacy: a friend of a friend hears nothing, because rooms are not transitive', () => {
  const { catalog, store, me, sam } = world();
  const kim = store.createUser({ name: 'Kim' });
  roomOf(store, sam, kim);
  const r = addMovieWithAgents({ store, catalog, actorId: me.id, movieId: 11, status: 'watched', verdict: 'liked' });
  assert.deepEqual(Object.keys(r.analyses), [sam.id]);
  assert.equal(store.eventsFor(kim.id).length, 0);
});

test('each viewer gets an analysis from their own history, not the actor\'s', () => {
  const { catalog, store, me, sam } = world();
  const kim = store.createUser({ name: 'Kim' });
  store.updateUser(kim.id, { prefs: { avoidGenres: ['Science Fiction'] } });
  roomOf(store, sam, kim);
  const r = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.equal(r.analyses[kim.id].action, 'skip');
  assert.notEqual(r.analyses[me.id].action, 'skip');
  assert.equal(r.analyses[kim.id].viewerId, kim.id);
  assert.equal(r.analyses[me.id].viewerId, me.id);
  assert.equal(store.eventsFor(kim.id)[0].analysis.viewerId, kim.id, 'each viewer only sees their own analysis in their feed');
});

// ---------- edits ----------

test('re-adding the same entry is a no-op; changing the verdict is a new event', () => {
  const { catalog, store, me, sam } = world();
  addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  const dup = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.equal(dup.event, null);
  assert.equal(dup.created, false);
  assert.equal(store.entriesFor(sam.id).filter((e) => e.movieId === 10).length, 1, 'no duplicate entries');
  const changed = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'disliked' });
  assert.ok(changed.event);
  assert.match(changed.analyses[me.id].headline, /disliked it/);
  assert.equal(store.eventsFor(me.id).length, 2);
});

test('unknown movie ids are rejected before anything is saved', () => {
  const { catalog, store, sam } = world();
  assert.throws(() => addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 999 }), /not found/);
  assert.equal(store.entriesFor(sam.id).length, 4, 'nothing was added');
});
