import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, HttpError } from '../src/store.js';
import { newStore, roomOf } from './helpers.js';

const people = (store, ...names) => names.map((name) => store.createUser({ name }));
const httpError = (status) => (e) => e instanceof HttpError && e.status === status;

// ---------- rooms ----------

test('createRoom: a short code, the host as the first member, and sensible defaults', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  const room = store.createRoom({ hostId: ana.id });
  assert.match(room.code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}$/, 'four consonants, so a code can never spell a word or be confused with a digit');
  assert.deepEqual(room.memberIds, [ana.id]);
  assert.equal(room.hostId, ana.id);
  assert.equal(room.name, 'Movie night');
  assert.equal(room.setting, 'in-person');
  assert.deepEqual(store.roomsOf(ana.id).map((r) => r.code), [room.code]);
});

test('createRoom: validates the setting and the host, and trims the name', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  assert.throws(() => store.createRoom({ hostId: ana.id, setting: 'on-the-moon' }), httpError(400));
  assert.throws(() => store.createRoom({ hostId: 'u_nobody' }), httpError(404));
  const room = store.createRoom({ hostId: ana.id, name: `  ${'x'.repeat(80)}  `, setting: 'online' });
  assert.equal(room.name.length, 50);
  assert.equal(room.setting, 'online');
});

test('createRoom: codes do not collide', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  const codes = new Set(Array.from({ length: 300 }, () => store.createRoom({ hostId: ana.id }).code));
  assert.equal(codes.size, 300);
});

test('getRoom: case-insensitive, and an unknown code is a clean 404', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  const room = store.createRoom({ hostId: ana.id });
  assert.equal(store.getRoom(room.code.toLowerCase()).code, room.code);
  assert.throws(() => store.getRoom('ZZZZ'), httpError(404));
  assert.throws(() => store.getRoom(undefined), httpError(404));
});

test('joinRoom: adds the person once, and unknown people or rooms are 404s', () => {
  const store = newStore();
  const [ana, ben] = people(store, 'Ana', 'Ben');
  const room = store.createRoom({ hostId: ana.id });
  store.joinRoom(room.code, ben.id);
  store.joinRoom(room.code.toLowerCase(), ben.id);
  assert.deepEqual(store.getRoom(room.code).memberIds, [ana.id, ben.id], 'joining twice does not duplicate');
  assert.throws(() => store.joinRoom(room.code, 'u_nobody'), httpError(404));
  assert.throws(() => store.joinRoom('ZZZZ', ben.id), httpError(404));
});

test('leaveRoom: removes only that person', () => {
  const store = newStore();
  const [ana, ben, cy] = people(store, 'Ana', 'Ben', 'Cy');
  const room = roomOf(store, ana, ben, cy);
  store.leaveRoom(room.code, ben.id);
  assert.deepEqual(store.getRoom(room.code).memberIds, [ana.id, cy.id]);
  assert.deepEqual(store.roomsOf(ben.id), []);
  store.leaveRoom(room.code, ben.id);
  assert.deepEqual(store.getRoom(room.code).memberIds, [ana.id, cy.id], 'leaving twice is harmless');
});

// ---------- who can see whom ----------

test('canSee: yourself, and people in a room with you, and nobody else', () => {
  const store = newStore();
  const [ana, ben, cy] = people(store, 'Ana', 'Ben', 'Cy');
  roomOf(store, ana, ben);
  assert.equal(store.canSee(ana.id, ana.id), true);
  assert.equal(store.canSee(cy.id, cy.id), true);
  assert.equal(store.canSee(ana.id, ben.id), true);
  assert.equal(store.canSee(ben.id, ana.id), true, 'symmetric');
  assert.equal(store.canSee(ana.id, cy.id), false);
  assert.equal(store.canSee(cy.id, ana.id), false);
});

test('canSee: not transitive, revoked on leaving, and unaffected by the unused sharing field', () => {
  const store = newStore();
  const [ana, ben, cy] = people(store, 'Ana', 'Ben', 'Cy');
  const r1 = roomOf(store, ana, ben);
  roomOf(store, ben, cy);
  assert.equal(store.canSee(ana.id, cy.id), false, 'a friend of a friend is a stranger');
  store.leaveRoom(r1.code, ben.id);
  assert.equal(store.canSee(ana.id, ben.id), false, 'leaving revokes access at once');
  store.updateUser(cy.id, { sharing: 'friends' });
  store.updateUser(ana.id, { sharing: 'private' });
  assert.equal(store.canSee(ben.id, cy.id), true, 'room membership decides, not the legacy sharing flag');
});

test('peersOf, visibleFriends and followersOf list the same people once each, never yourself', () => {
  const store = newStore();
  const [ana, ben, cy, dee] = people(store, 'Ana', 'Ben', 'Cy', 'Dee');
  roomOf(store, ana, ben, cy);
  roomOf(store, ana, ben);
  roomOf(store, dee, cy);
  const names = (list) => list.map((u) => u.name).sort();
  assert.deepEqual(names(store.peersOf(ana.id)), ['Ben', 'Cy'], 'Ben shares two rooms with Ana but is listed once');
  assert.deepEqual(names(store.visibleFriends(ana.id)), ['Ben', 'Cy']);
  assert.deepEqual(store.followersOf(ana.id).sort(), [ben.id, cy.id].sort());
  assert.deepEqual(names(store.peersOf(cy.id)), ['Ana', 'Ben', 'Dee']);
  assert.deepEqual(store.peersOf(dee.id).map((u) => u.name), ['Cy']);
  people(store, 'Loner');
  assert.deepEqual(store.peersOf(store.listUsers().at(-1).id), []);
});

// ---------- entries ----------

test('addEntry: reports whether it created something, and later edits replace the earlier entry', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  const first = store.addEntry({ userId: ana.id, movieId: 1, status: 'watched', verdict: 'liked' });
  assert.equal(first.created, true);
  const again = store.addEntry({ userId: ana.id, movieId: 1, status: 'watched', verdict: 'disliked' });
  assert.equal(again.created, false);
  assert.equal(store.entriesFor(ana.id).length, 1);
  assert.equal(store.entriesFor(ana.id)[0].verdict, 'disliked');
});

test('addEntry: a watchlist entry never carries a verdict, and bad values are 400s', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  const { entry } = store.addEntry({ userId: ana.id, movieId: 2, status: 'watchlist', verdict: 'liked' });
  assert.equal(entry.verdict, null);
  assert.throws(() => store.addEntry({ userId: ana.id, movieId: 3, status: 'maybe' }), httpError(400));
  assert.throws(() => store.addEntry({ userId: ana.id, movieId: 3, verdict: 'loved' }), httpError(400));
  assert.throws(() => store.addEntry({ userId: 'u_nobody', movieId: 3 }), httpError(404));
});

test('setVerdict only touches watched entries; removeEntry removes only that person\'s entry', () => {
  const store = newStore();
  const [ana, ben] = people(store, 'Ana', 'Ben');
  store.addEntry({ userId: ana.id, movieId: 1, status: 'watched', verdict: 'liked' });
  store.addEntry({ userId: ana.id, movieId: 2, status: 'watchlist' });
  store.addEntry({ userId: ben.id, movieId: 1, status: 'watched', verdict: 'liked' });
  assert.equal(store.setVerdict(ana.id, 1, 'meh'), true);
  assert.equal(store.entriesFor(ana.id).find((e) => e.movieId === 1).verdict, 'meh');
  assert.equal(store.setVerdict(ana.id, 2, 'liked'), false, 'a watchlist item has nothing to rate');
  assert.equal(store.setVerdict(ana.id, 99, 'liked'), false);
  assert.throws(() => store.setVerdict(ana.id, 1, 'loved'), httpError(400));
  store.removeEntry(ana.id, 1);
  assert.deepEqual(store.entriesFor(ana.id).map((e) => e.movieId), [2]);
  assert.equal(store.entriesFor(ben.id).length, 1, 'Ben keeps his own entry for the same movie');
});

// ---------- feedback ----------

test('feedback: every reason is stored, trimmed and capped, and bad kinds are 400s', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  const fb = store.addFeedback({ userId: ana.id, movieId: 1, kind: 'not-my-taste', reason: `  ${'r'.repeat(400)}  `, context: 'group' });
  assert.equal(fb.reason.length, 300);
  assert.equal(fb.context, 'group');
  assert.equal(fb.seeded, false);
  assert.ok(fb.id && fb.at);
  assert.throws(() => store.addFeedback({ userId: ana.id, movieId: 1, kind: 'nonsense' }), httpError(400));
  assert.equal(store.feedbackFor(ana.id).length, 1);
});

test('feedback: a later thumb replaces the opposite signal for the same movie and context only', () => {
  const store = newStore();
  const [ana] = people(store, 'Ana');
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'thumbs-down', reason: 'dull', context: 'solo' });
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'thumbs-up', context: 'solo' });
  assert.deepEqual(store.feedbackFor(ana.id).map((f) => f.kind), ['thumbs-up'], 'changing your mind replaces the veto');
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'thumbs-down', reason: 'changed my mind', context: 'solo' });
  assert.deepEqual(store.feedbackFor(ana.id).map((f) => f.kind), ['thumbs-down']);
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'thumbs-up', context: 'group' });
  assert.equal(store.feedbackFor(ana.id).length, 2, 'a group thumb does not erase the solo one');
  store.addFeedback({ userId: ana.id, movieId: 2, kind: 'thumbs-up', context: 'solo' });
  assert.equal(store.feedbackFor(ana.id).filter((f) => f.movieId === 1).length, 2, 'other movies are untouched');
});

test('feedback: "seen it" does not cancel a thumbs-up, and a thumbs-up is dropped by a later rejection', () => {
  const store = newStore();
  const [ana, ben] = people(store, 'Ana', 'Ben');
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'thumbs-up', context: 'solo' });
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'seen-it', context: 'solo' });
  assert.deepEqual(store.feedbackFor(ana.id).map((f) => f.kind).sort(), ['seen-it', 'thumbs-up']);
  store.addFeedback({ userId: ana.id, movieId: 1, kind: 'wrong-mood', reason: 'not tonight', context: 'solo' });
  assert.deepEqual(store.feedbackFor(ana.id).map((f) => f.kind).sort(), ['seen-it', 'wrong-mood']);
  store.addFeedback({ userId: ben.id, movieId: 1, kind: 'thumbs-up', context: 'solo' });
  assert.equal(store.feedbackFor(ben.id).length, 1, 'feedback is per person');
});

// ---------- events ----------

test('events: each viewer sees only their own analysis, newest first', () => {
  const store = newStore();
  const [ana, ben, cy] = people(store, 'Ana', 'Ben', 'Cy');
  store.addEvent({ type: 'movie_added', actorId: ana.id, movieId: 1, analyses: { [ben.id]: { headline: 'for Ben' }, [cy.id]: { headline: 'for Cy' } } });
  store.addEvent({ type: 'movie_added', actorId: ana.id, movieId: 2, analyses: { [ben.id]: { headline: 'second for Ben' } } });
  const forBen = store.eventsFor(ben.id);
  assert.deepEqual(forBen.map((e) => e.analysis.headline), ['second for Ben', 'for Ben'], 'newest first');
  assert.equal(forBen[0].actorId, ana.id);
  assert.equal(forBen[0].analyses, undefined, 'other viewers\' analyses are not exposed');
  assert.deepEqual(store.eventsFor(cy.id).map((e) => e.analysis.headline), ['for Cy']);
  assert.deepEqual(store.eventsFor(ana.id), [], 'the actor is not told about their own addition');
});

test('events: the log is capped so it cannot grow without bound', () => {
  const store = newStore();
  const [ana, ben] = people(store, 'Ana', 'Ben');
  for (let i = 0; i < 520; i++) store.addEvent({ type: 'movie_added', actorId: ana.id, movieId: i, analyses: { [ben.id]: { n: i } } });
  const seen = store.eventsFor(ben.id);
  assert.equal(seen.length, 500);
  assert.equal(seen[0].analysis.n, 519, 'the newest survive');
  assert.equal(seen.at(-1).analysis.n, 20, 'the oldest are dropped');
});

// ---------- persistence ----------

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')), 'nested', 'state.json');
}

test('persistence: users, rooms, entries, feedback and events survive a restart', () => {
  const file = tmpFile();
  const a = new Store({ file });
  const [ana, ben] = people(a, 'Ana', 'Ben');
  const room = roomOf(a, ana, ben);
  a.addEntry({ userId: ana.id, movieId: 1, status: 'watched', verdict: 'liked' });
  a.addFeedback({ userId: ben.id, movieId: 2, kind: 'not-my-taste', reason: 'slow', context: 'group' });
  a.addEvent({ type: 'movie_added', actorId: ana.id, movieId: 1, analyses: { [ben.id]: { headline: 'hi' } } });

  const b = new Store({ file });
  assert.deepEqual(b.listUsers().map((u) => u.name).sort(), ['Ana', 'Ben']);
  assert.deepEqual(b.getRoom(room.code).memberIds, [ana.id, ben.id]);
  assert.equal(b.canSee(ana.id, ben.id), true);
  assert.equal(b.entriesFor(ana.id)[0].verdict, 'liked');
  assert.equal(b.feedbackFor(ben.id)[0].reason, 'slow');
  assert.equal(b.eventsFor(ben.id)[0].analysis.headline, 'hi');
  const carol = b.createUser({ name: 'Carol' });
  assert.ok(![ana.id, ben.id].includes(carol.id));
  const before = b.feedbackFor(ben.id)[0].id;
  const next = b.addFeedback({ userId: ben.id, movieId: 3, kind: 'wrong-mood', context: 'group' });
  assert.notEqual(next.id, before, 'ids keep counting from where the last run stopped');
  assert.equal(new Set(b.feedbackFor(ben.id).map((f) => f.id)).size, 2);
});

test('persistence: a missing or corrupt state file starts clean instead of crashing', () => {
  const missing = new Store({ file: tmpFile() });
  assert.deepEqual(missing.listUsers(), []);
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  const corrupt = new Store({ file });
  assert.deepEqual(corrupt.listUsers(), []);
  corrupt.createUser({ name: 'Ana' });
  assert.equal(new Store({ file }).listUsers().length, 1, 'and it writes a good file afterwards');
});

test('persistence: a state file from before rooms had member details still loads and works', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    seq: 5,
    users: { u1: { id: 'u1', name: 'Old Ana', prefs: {} }, u2: { id: 'u2', name: 'Old Ben', prefs: {} } },
    entries: [],
    feedback: [],
    rooms: { BCDF: { code: 'BCDF', hostId: 'u1', memberIds: ['u1', 'u2'], name: 'Old room', setting: 'in-person' } },
  }));
  const store = new Store({ file });
  assert.equal(store.getUser('u1').sharing, 'friends', 'missing fields get defaults');
  assert.equal(store.canSee('u1', 'u2'), true);
  const room = store.getRoom('BCDF');
  assert.deepEqual(Object.keys(room.members).sort(), ['u1', 'u2']);
  assert.equal(room.status, 'collecting');
  assert.deepEqual(store.eventsFor('u1'), []);
  store.joinRoom('BCDF', store.createUser({ name: 'New' }).id);
  assert.equal(store.getRoom('BCDF').memberIds.length, 3);
});

test('reset wipes everything', () => {
  const store = newStore();
  const [ana, ben] = people(store, 'Ana', 'Ben');
  roomOf(store, ana, ben);
  store.reset();
  assert.deepEqual(store.listUsers(), []);
  assert.deepEqual(store.roomsOf(ana.id), []);
});
