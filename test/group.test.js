import test from 'node:test';
import assert from 'node:assert/strict';
import { rankForGroup } from '../src/agent/group.js';
import { HttpError } from '../src/store.js';
import { makeCatalog, mv, newStore, addWatched } from './helpers.js';

const action = (id, r = [7, 3000]) => mv(id, `Action ${id}`, ['Action'], { keywords: ['chase'], rating: r });
const romance = (id, r = [7, 3000]) => mv(id, `Romance ${id}`, ['Romance'], { keywords: ['wedding'], rating: r });
const comedy = (id, r = [7, 3000]) => mv(id, `Comedy ${id}`, ['Comedy'], { keywords: ['friendship'], rating: r });

function world() {
  const catalog = makeCatalog([
    action(1), action(2), action(3), action(4),
    romance(11), romance(12), romance(13), romance(14),
    comedy(21), comedy(22), comedy(23), comedy(24),
    action(30, [8.5, 9000]),
    romance(31, [8.5, 9000]),
    mv(40, 'Comedy Duo Pick', ['Comedy'], { keywords: ['friendship'], rating: [8.0, 9000] }),
    mv(50, 'Screamer', ['Horror'], { rating: [9.0, 20000] }),
    mv(51, 'Very Long Saga', ['Comedy'], { runtime: 220, rating: [9.0, 20000] }),
  ]);
  const store = newStore();
  const a = store.createUser({ name: 'Ana' });
  const b = store.createUser({ name: 'Ben' });
  const c = store.createUser({ name: 'Cy', sharing: 'friends' });
  for (const x of [b, c]) store.follow(a.id, x.id);
  return { catalog, store, a, b, c };
}

const run = (w, extra = {}) => rankForGroup({ hostId: w.a.id, participantIds: [w.b.id, w.c.id], store: w.store, catalog: w.catalog, limit: 8, ...extra });

test('hard exclusions from any participant are honored, not averaged away', () => {
  const w = world();
  w.store.updateUser(w.b.id, { prefs: { avoidGenres: ['Horror'], maxRuntime: 130 } });
  const r = run(w);
  const titles = r.recommendations.map((x) => x.movie.title);
  assert.ok(!titles.includes('Screamer'), 'Screamer has 9.0 but Ben avoids Horror');
  assert.ok(!titles.includes('Very Long Saga'), 'runtime cap is the strictest member cap');
  assert.deepEqual(r.constraints.avoidedGenres, { Horror: ['Ben'] });
  assert.equal(r.constraints.maxRuntime, 130);
  assert.equal(r.filtered['avoided-genre'], 1);
  assert.equal(r.filtered['too-long'], 1);
});

test('a participant who has not opted in is left out, named, and their history is unused', () => {
  const w = world();
  w.store.updateUser(w.c.id, { sharing: 'private' });
  addWatched(w.store, w.c.id, [40], 'liked');
  const r = run(w);
  assert.equal(r.participants.length, 2);
  assert.deepEqual(r.excluded.map((e) => e.name), ['Cy']);
  assert.match(r.excluded[0].reason, /not opted in/);
  assert.ok(r.notes.some((n) => /Not included: Cy/.test(n)));
  assert.ok(r.recommendations.every((x) => x.perMember.every((p) => p.name !== 'Cy')));
});

test('a participant you do not follow cannot be added, even if they share', () => {
  const w = world();
  const stranger = w.store.createUser({ name: 'Stranger', sharing: 'friends' });
  const r = run(w, { participantIds: [w.b.id, stranger.id] });
  assert.deepEqual(r.excluded.map((e) => e.name), ['Stranger']);
  assert.match(r.excluded[0].reason, /not someone you follow/);
});

test('needs at least two consenting participants', () => {
  const w = world();
  w.store.updateUser(w.b.id, { sharing: 'private' });
  w.store.updateUser(w.c.id, { sharing: 'private' });
  assert.throws(() => run(w), (e) => e instanceof HttpError && e.status === 422 && /at least two/.test(e.message));
});

test('conflicting tastes: someone lukewarm makes it a labeled compromise, not a fake consensus', () => {
  const w = world();
  addWatched(w.store, w.a.id, [1, 2, 3, 4], 'liked');
  addWatched(w.store, w.b.id, [11, 12, 13, 14], 'liked');
  addWatched(w.store, w.b.id, [1, 2], 'disliked');
  addWatched(w.store, w.c.id, [21, 22, 23, 24], 'liked');
  const r = run(w);
  const pick = r.recommendations.find((x) => x.movie.title === 'Action 30');
  if (pick) {
    assert.notEqual(pick.label, 'Consensus');
    const ben = pick.perMember.find((p) => p.name === 'Ben');
    const ana = pick.perMember.find((p) => p.name === 'Ana');
    assert.ok(ana.fit > ben.fit);
    assert.ok(pick.reasons.some((x) => x.signal === 'group'));
  }
  for (const rec of r.recommendations) {
    assert.ok(['Consensus', 'Compromise', 'Balanced'].includes(rec.label));
    assert.equal(rec.perMember.length, 3);
  }
});

test('overlapping taste yields a consensus pick', () => {
  const w = world();
  for (const u of [w.a, w.b, w.c]) addWatched(w.store, u.id, [21, 22, 23], 'liked');
  const r = rankForGroup({ hostId: w.a.id, participantIds: [w.b.id, w.c.id], store: w.store, catalog: w.catalog, limit: 3 });
  assert.ok(r.recommendations[0].movie.genres.includes('Comedy'), 'the shared taste drives the pick');
  assert.equal(r.recommendations[0].label, 'Consensus');
  assert.equal(r.recommendations[0].favors, null);
});

test('movies some members already saw are flagged and penalized; movies everyone saw are removed', () => {
  const w = world();
  addWatched(w.store, w.a.id, [40], 'liked');
  addWatched(w.store, w.b.id, [40], 'liked');
  addWatched(w.store, w.c.id, [40], 'liked');
  let r = run(w);
  assert.ok(!r.recommendations.some((x) => x.movie.id === 40));
  assert.equal(r.filtered['seen-by-everyone'], 1);

  const w2 = world();
  addWatched(w2.store, w2.a.id, [40], 'liked');
  r = run(w2);
  const rec = r.recommendations.find((x) => x.movie.id === 40);
  if (rec) assert.ok(rec.tradeoffs.some((t) => /Ana has seen it and liked it \(rewatch\)/.test(t)));
});

test('a group-context disagreement vetoes the pick for everyone and is kept on record', () => {
  const w = world();
  for (const u of [w.a, w.b, w.c]) addWatched(w.store, u.id, [21, 22, 23], 'liked');
  const before = run(w);
  const top = before.recommendations[0];
  const fb = w.store.addFeedback({ userId: w.c.id, movieId: top.movie.id, kind: 'wrong-mood', reason: 'Not tonight', context: 'group' });
  const after = run(w);
  assert.ok(!after.recommendations.some((x) => x.movie.id === top.movie.id));
  assert.equal(after.filtered['vetoed-by-a-participant'], 1);
  assert.equal(w.store.feedbackFor(w.c.id)[0].id, fb.id);
});

test('fairness summary covers every participant and setting-specific notes are honest about availability', () => {
  const w = world();
  const online = run(w, { setting: 'online' });
  assert.deepEqual(online.fairness.map((f) => f.name).sort(), ['Ana', 'Ben', 'Cy']);
  assert.equal(online.fairness.reduce((s, f) => s + f.timesLeastHappy, 0), online.recommendations.length);
  assert.ok(online.notes.some((n) => /availability is not checked/i.test(n)));
  assert.equal(online.setting, 'online');
});
