import test from 'node:test';
import assert from 'node:assert/strict';
import { addMovieWithAgents } from '../src/agent/watcher.js';
import { runJudgeScenario } from '../src/demo/scenario.js';
import { makeCatalog, mv, newStore, addWatched, fixtureCatalog } from './helpers.js';

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
  const sam = store.createUser({ name: 'Sam', sharing: 'friends' });
  addWatched(store, me.id, [1, 2, 3, 4], 'liked');
  addWatched(store, sam.id, [1, 2, 3, 4], 'liked');
  store.follow(me.id, sam.id);
  return { catalog, store, me, sam };
}

test('friend adds a movie: the agent explains what changed and recommends watching it', () => {
  const { catalog, store, me, sam } = world();
  const { event, analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.ok(event);
  const a = analyses[me.id];
  assert.ok(['watch', 'maybe'].includes(a.action));
  assert.match(a.headline, /Sam watched and liked it/);
  assert.ok(a.movieScore.after > a.movieScore.before, `score ${a.movieScore.before} -> ${a.movieScore.after}`);
  assert.ok(a.movieRank.after <= a.movieRank.before);
  assert.ok(a.reasoning.some((r) => /Sam watched and liked it/.test(r)));
  assert.equal(a.trust.overlap, 4);
  assert.equal(a.trust.agreement, 1);
  assert.ok(a.closestInYourHistory.length > 0 && a.closestInYourHistory[0].yourVerdict === 'liked');
  assert.ok(a.alsoConsider.some((x) => x.movie.title === 'SciFi 11'), 'recommends similar movies too');
  assert.ok(a.snapshots.before.length && a.snapshots.after.length);
  assert.equal(store.eventsFor(me.id).length, 1);
});

test('the friend signal also lifts lookalikes of what the friend liked', () => {
  const { catalog, store, me, sam } = world();
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  const lookalike = analyses[me.id].snapshots.after.find((m) => m.title === 'SciFi 11');
  assert.ok(lookalike);
});

test('a movie the follower already watched is compared instead of re-recommended', () => {
  const { catalog, store, me, sam } = world();
  addWatched(store, me.id, [10], 'disliked');
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  const a = analyses[me.id];
  assert.equal(a.action, 'already-seen');
  assert.match(a.headline, /You already watched SciFi 10 and disliked it/);
  assert.ok(a.reasoning.some((r) => /disagree/.test(r)));
});

test('a friend adding something in a genre you avoid gets a skip with the reason', () => {
  const { catalog, store, me, sam } = world();
  store.updateUser(me.id, { prefs: { avoidGenres: ['Horror'] } });
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 21, status: 'watched', verdict: 'liked' });
  assert.equal(analyses[me.id].action, 'skip');
  assert.match(analyses[me.id].headline, /genre you asked to avoid/);
  assert.deepEqual(analyses[me.id].alsoConsider, []);
});

test('a weak match is not pushed just because a friend added it', () => {
  const { catalog, store, me, sam } = world();
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 22, status: 'watched', verdict: 'liked' });
  assert.notEqual(analyses[me.id].action, 'watch');
});

test('watchlist adds trigger the agent too, described as interest rather than a rating', () => {
  const { catalog, store, me, sam } = world();
  const { analyses } = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watchlist' });
  assert.match(analyses[me.id].headline, /added it to their watchlist/);
});

test('privacy: nothing fires when the actor does not share, or for people who do not follow them', () => {
  const { catalog, store, me, sam } = world();
  store.updateUser(sam.id, { sharing: 'private' });
  const r1 = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 10, status: 'watched', verdict: 'liked' });
  assert.equal(r1.event, null);
  assert.equal(store.eventsFor(me.id).length, 0);

  store.updateUser(sam.id, { sharing: 'friends' });
  const outsider = store.createUser({ name: 'Outsider' });
  const r2 = addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 11, status: 'watched', verdict: 'liked' });
  assert.deepEqual(Object.keys(r2.analyses), [me.id]);
  assert.equal(store.eventsFor(outsider.id).length, 0);
});

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
});

test('unknown movie ids are rejected', () => {
  const { catalog, store, sam } = world();
  assert.throws(() => addMovieWithAgents({ store, catalog, actorId: sam.id, movieId: 999 }), /not found/);
});

test('demo scenario: a friend adding a movie visibly changes the top of the list', () => {
  const out = runJudgeScenario({ catalog: fixtureCatalog() });
  const f = out.friendAdded;
  assert.ok(f, 'a friend pick was found in the fixture');
  assert.ok(f.movieRank.after < f.movieRank.before, `${f.movie.title} #${f.movieRank.before} -> #${f.movieRank.after}`);
  assert.ok(f.diff.added.some((x) => x.movie.title === f.movie.title) || f.diff.rose.some((x) => x.movie.title === f.movie.title));
  assert.equal(f.action, 'watch');
  assert.ok(f.alsoConsider.length > 0);
});

test('demo scenario: the disagreement is stored, vetoes the pick and changes the list', () => {
  const out = runJudgeScenario({ catalog: fixtureCatalog() });
  const d = out.disagreement;
  assert.equal(d.illustrative, true, 'seeded example is labeled illustrative');
  assert.ok(!d.after.some((r) => r.title === d.contested.movie.title));
  assert.notDeepEqual(d.before.map((r) => r.title), d.after.map((r) => r.title));
  assert.deepEqual(d.excluded.map((e) => e.name), ['Jordan'], 'the private participant stays out');
});
