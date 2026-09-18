import test from 'node:test';
import assert from 'node:assert/strict';
import { rankForGroup } from '../src/agent/group.js';
import { HttpError } from '../src/store.js';
import { makeCatalog, mv, newStore, addWatched, roomOf } from './helpers.js';

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
  const c = store.createUser({ name: 'Cy' });
  const room = roomOf(store, a, b, c);
  return { catalog, store, a, b, c, room };
}

const run = (w, extra = {}) => rankForGroup({ hostId: w.a.id, participantIds: [w.b.id, w.c.id], store: w.store, catalog: w.catalog, limit: 8, ...extra });

// ---------- who is in the room ----------

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

test('a participant who left the room is left out, named, and their history is unused', () => {
  const w = world();
  addWatched(w.store, w.c.id, [40], 'liked');
  w.store.leaveRoom(w.room.code, w.c.id);
  const r = run(w);
  assert.equal(r.participants.length, 2);
  assert.deepEqual(r.excluded.map((e) => e.name), ['Cy']);
  assert.match(r.excluded[0].reason, /has not joined your screening room/);
  assert.ok(r.notes.some((n) => /Not included: Cy/.test(n)));
  assert.ok(r.recommendations.every((x) => x.perMember.every((p) => p.name !== 'Cy')));
  assert.equal(r.filtered['seen-by-everyone'], undefined, 'Cy having seen it does not count when Cy is not in the room');
});

test('someone who never joined your room cannot be added', () => {
  const w = world();
  const stranger = w.store.createUser({ name: 'Stranger' });
  const r = run(w, { participantIds: [w.b.id, stranger.id] });
  assert.deepEqual(r.excluded.map((e) => e.name), ['Stranger']);
  assert.match(r.excluded[0].reason, /has not joined your screening room/);
  assert.deepEqual(r.participants.map((p) => p.name), ['Ana', 'Ben']);
});

test('sharing a room with someone else in the room is not enough: only the host\'s room counts', () => {
  const w = world();
  const dee = w.store.createUser({ name: 'Dee' });
  roomOf(w.store, w.b, dee);
  const r = run(w, { participantIds: [w.b.id, dee.id] });
  assert.deepEqual(r.excluded.map((e) => e.name), ['Dee']);
});

test('the host and duplicate ids in the participant list are ignored', () => {
  const w = world();
  const r = run(w, { participantIds: [w.a.id, w.b.id, w.b.id, w.c.id, w.c.id] });
  assert.deepEqual(r.participants.map((p) => p.name), ['Ana', 'Ben', 'Cy']);
  assert.deepEqual(r.excluded, []);
});

test('needs at least two people in the room, and the error says who was left out', () => {
  const w = world();
  w.store.leaveRoom(w.room.code, w.b.id);
  w.store.leaveRoom(w.room.code, w.c.id);
  assert.throws(() => run(w), (e) => e instanceof HttpError && e.status === 422 && /at least two people in the room/.test(e.message) && /Ben has not joined/.test(e.message));
  assert.throws(() => rankForGroup({ hostId: w.a.id, participantIds: [], store: w.store, catalog: w.catalog }), (e) => e instanceof HttpError && e.status === 422);
});

test('an unknown participant id is a 404, not a silent skip', () => {
  const w = world();
  assert.throws(() => run(w, { participantIds: [w.b.id, 'u-does-not-exist'] }), (e) => e instanceof HttpError && e.status === 404);
});

// ---------- ranking ----------

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

// ---------- disagreement ----------

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
  assert.equal(w.store.feedbackFor(w.c.id)[0].reason, 'Not tonight');
});

test('a group thumbs-up is a signal, never a veto', () => {
  const w = world();
  for (const u of [w.a, w.b, w.c]) addWatched(w.store, u.id, [21, 22, 23], 'liked');
  const top = run(w).recommendations[0];
  w.store.addFeedback({ userId: w.c.id, movieId: top.movie.id, kind: 'thumbs-up', context: 'group' });
  const after = run(w);
  assert.ok(after.recommendations.some((x) => x.movie.id === top.movie.id), 'still on the list');
  assert.equal(after.filtered['vetoed-by-a-participant'], undefined);
});

test('a group "seen it" is a rewatch flag, not a veto', () => {
  const w = world();
  for (const u of [w.a, w.b, w.c]) addWatched(w.store, u.id, [21, 22, 23], 'liked');
  const top = run(w).recommendations[0];
  w.store.addFeedback({ userId: w.c.id, movieId: top.movie.id, kind: 'seen-it', context: 'group' });
  const after = run(w, { limit: 20 });
  const rec = after.recommendations.find((x) => x.movie.id === top.movie.id);
  assert.ok(rec, 'not removed for the whole room');
  assert.equal(rec.perMember.find((p) => p.name === 'Cy').seen, true);
  assert.ok(rec.tradeoffs.some((t) => /Cy has already seen it/.test(t)));
  assert.equal(after.filtered['vetoed-by-a-participant'], undefined);
});

test('a solo-context rejection does not veto the pick for the group', () => {
  const w = world();
  for (const u of [w.a, w.b, w.c]) addWatched(w.store, u.id, [21, 22, 23], 'liked');
  const top = run(w).recommendations[0];
  w.store.addFeedback({ userId: w.c.id, movieId: top.movie.id, kind: 'not-my-taste', context: 'solo' });
  const after = run(w, { limit: 20 });
  assert.ok(after.recommendations.some((x) => x.movie.id === top.movie.id), 'a private solo rejection is not a group veto');
  assert.equal(after.filtered['vetoed-by-a-participant'], undefined);
});

test('a veto only counts while its author is in the room', () => {
  const w = world();
  for (const u of [w.a, w.b, w.c]) addWatched(w.store, u.id, [21, 22, 23], 'liked');
  const top = run(w).recommendations[0];
  w.store.addFeedback({ userId: w.c.id, movieId: top.movie.id, kind: 'wrong-mood', context: 'group' });
  w.store.leaveRoom(w.room.code, w.c.id);
  const after = run(w);
  assert.ok(after.recommendations.some((x) => x.movie.id === top.movie.id), 'Cy left, so Cy\'s veto no longer applies');
});

// ---------- new hard no's ----------

test('a hard-no word from any participant removes matching films for everyone and is reported by name', () => {
  const w = world();
  w.catalog.movies.push(...makeCatalog([mv(60, 'Clown Party', ['Comedy'], { rating: [9.0, 30000] }), mv(61, 'Quiet Night', ['Comedy'], { overview: 'A killer clown returns.', rating: [9.0, 30000] })]).movies);
  for (const m of w.catalog.movies) w.catalog.byId.set(m.id, m);
  w.store.updateUser(w.b.id, { prefs: { hardNoTerms: ['clown'] } });
  const r = run(w, { limit: 20 });
  const titles = r.recommendations.map((x) => x.movie.title);
  assert.ok(!titles.includes('Clown Party') && !titles.includes('Quiet Night'), 'matched on title and on synopsis');
  assert.equal(r.filtered['hard-no-term'], 2);
  assert.deepEqual(r.constraints.otherHardNos, { Ben: ['clown'] });
});

test('a content flag removes a film only with two pieces of evidence, for everyone in the room', () => {
  const w = world();
  const gory = { text: 'So much gore.', user: 'x', likes: 1 };
  const bloody = { text: 'Bloody and brutal.', user: 'y', likes: 1 };
  const extra = makeCatalog([
    mv(60, 'Gore Fest', ['Comedy'], { rating: [9.0, 30000], reviews: [gory, bloody] }),
    mv(61, 'One Mention', ['Comedy'], { rating: [9.0, 30000], reviews: [gory] }),
  ]).movies;
  w.catalog.movies.push(...extra);
  for (const m of extra) w.catalog.byId.set(m.id, m);
  w.store.updateUser(w.c.id, { prefs: { avoidFlags: ['graphic-violence'] } });
  const r = run(w, { limit: 20 });
  const titles = r.recommendations.map((x) => x.movie.title);
  assert.ok(!titles.includes('Gore Fest'), 'two hits filter it');
  assert.ok(titles.includes('One Mention'), 'one hit is only a caution');
  assert.equal(r.filtered['content-flag'], 1);
  assert.deepEqual(r.constraints.otherHardNos, { Cy: ['graphic-violence'] });
});

test('an era wish, short films and featurettes are removed for the whole group', () => {
  const w = world();
  const extra = makeCatalog([
    mv(60, 'Old Timer', ['Comedy'], { year: 1950, rating: [9.0, 30000] }),
    mv(61, 'Tiny Short', ['Comedy'], { runtime: 12, rating: [9.0, 30000] }),
    mv(62, 'Some Film: Behind the Scenes', ['Comedy'], { rating: [9.0, 30000] }),
  ]).movies;
  w.catalog.movies.push(...extra);
  for (const m of extra) w.catalog.byId.set(m.id, m);
  w.store.updateUser(w.b.id, { prefs: { minYear: 1990 } });
  const r = run(w, { limit: 20 });
  assert.equal(r.constraints.minYear, 1990);
  assert.equal(r.filtered['too-old'], 1);
  assert.equal(r.filtered['not-a-feature'], 2);
  assert.ok(!r.recommendations.some((x) => ['Old Timer', 'Tiny Short', 'Some Film: Behind the Scenes'].includes(x.movie.title)));
});

// ---------- fairness and honesty ----------

test('fairness summary covers every participant and setting-specific notes are honest about availability', () => {
  const w = world();
  const online = run(w, { setting: 'online' });
  assert.deepEqual(online.fairness.map((f) => f.name).sort(), ['Ana', 'Ben', 'Cy']);
  assert.equal(online.fairness.reduce((s, f) => s + f.timesLeastHappy, 0), online.recommendations.length);
  assert.ok(online.notes.some((n) => /availability is not checked/i.test(n)));
  assert.equal(online.setting, 'online');
});

test('in person: the note still says availability is unchecked and no rating is an average of stars', () => {
  const w = world();
  const r = run(w);
  assert.equal(r.setting, 'in-person');
  assert.ok(r.notes.some((n) => /Confirm availability/.test(n)));
  assert.ok(r.notes.some((n) => /not an average of star ratings/.test(n)));
});

test('ties between equally good picks are broken deterministically by id', () => {
  const twins = makeCatalog([
    mv('zeta', 'Twin Z', ['Comedy'], { rating: [7, 3000] }),
    mv('alpha', 'Twin A', ['Comedy'], { rating: [7, 3000] }),
  ]);
  const store = newStore();
  const a = store.createUser({ name: 'Ana' });
  const b = store.createUser({ name: 'Ben' });
  roomOf(store, a, b);
  const r = rankForGroup({ hostId: a.id, participantIds: [b.id], store, catalog: twins, limit: 2 });
  assert.equal(r.recommendations.length, 2);
  const again = rankForGroup({ hostId: a.id, participantIds: [b.id], store, catalog: { ...twins, movies: [...twins.movies].reverse() }, limit: 2 });
  assert.deepEqual(again.recommendations.map((x) => x.movie.id), r.recommendations.map((x) => x.movie.id), 'input order does not change the result');
});
