import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { createLiveSources } from '../src/data/live.js';
import { fixtureCatalog } from './helpers.js';
import { findByTitle } from '../src/data/catalog.js';

async function withServer(fn) {
  const catalog = fixtureCatalog();
  const app = createApp({ catalog, store: new Store(), live: createLiveSources({ env: {} }) });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  try { await fn({ call, catalog, base }); } finally { server.close(); }
}

test('api: meta reports provenance honestly and that no live sources are configured', () =>
  withServer(async ({ call }) => {
    const { body } = await call('GET', '/api/meta');
    assert.equal(body.provenance.base, 'sample-fixture');
    assert.deepEqual(body.live, { tmdb: false, omdb: false });
    assert.equal(body.availabilityChecked, false);
    assert.ok(body.genres.includes('Science Fiction'));
  }));

test('api: movie detail says which sources were not queried instead of inventing reviews', () =>
  withServer(async ({ call, catalog }) => {
    const id = findByTitle(catalog, 'Inception').id;
    const { body } = await call('GET', `/api/movies/${id}`);
    assert.equal(body.reviews.available, false);
    assert.equal(body.sourceStatus.omdb.status, 'unavailable');
    assert.equal(body.sourceStatus.tmdbReviews.status, 'unavailable');
    assert.ok(body.similar.length > 0);
    assert.equal(body.movie.genreSet, undefined, 'internal sets are not leaked');
  }));

test('api: solo flow from empty user to explained recommendations', () =>
  withServer(async ({ call, catalog }) => {
    const u = (await call('POST', '/api/users', { name: 'Robin' })).body;
    assert.equal((await call('PATCH', `/api/users/${u.id}`, { prefs: { genres: ['Science Fiction'], avoidGenres: ['Horror'] } })).status, 200);
    const crowd = (await call('GET', `/api/movies/crowd?userId=${u.id}`)).body;
    assert.ok(crowd.movies.length > 0 && /not a personal recommendation/.test(crowd.note));
    await call('POST', `/api/users/${u.id}/entries`, { movieId: findByTitle(catalog, 'Interstellar').id, status: 'watched', verdict: 'liked' });
    const rec = (await call('GET', `/api/users/${u.id}/recommendations?limit=5`)).body;
    assert.equal(rec.recommendations.length, 5);
    assert.ok(rec.recommendations.every((r) => r.reasons.length && r.movie.genres && !r.movie.genres.includes('Horror')));
    assert.ok(rec.trace.length >= 4);
    assert.equal(rec.scored, undefined, 'the full scored list is not serialized');
  }));

test('api: a friend adding a movie lands in the follower feed with before/after; consent is enforced', () =>
  withServer(async ({ call, catalog }) => {
    const me = (await call('POST', '/api/users', { name: 'Me' })).body;
    const sam = (await call('POST', '/api/users', { name: 'Sam', sharing: 'friends' })).body;
    const lee = (await call('POST', '/api/users', { name: 'Lee', sharing: 'private' })).body;
    for (const t of ['Inception', 'Interstellar']) {
      const id = findByTitle(catalog, t).id;
      await call('POST', `/api/users/${me.id}/entries`, { movieId: id, verdict: 'liked' });
      await call('POST', `/api/users/${sam.id}/entries`, { movieId: id, verdict: 'liked' });
    }
    await call('POST', `/api/users/${me.id}/follow`, { targetId: sam.id });
    await call('POST', `/api/users/${me.id}/follow`, { targetId: lee.id });

    const add = await call('POST', `/api/users/${sam.id}/entries`, { movieId: findByTitle(catalog, 'Arrival').id, status: 'watched', verdict: 'liked' });
    assert.deepEqual(add.body.notified.map((n) => n.viewerId), [me.id]);
    const feed = (await call('GET', `/api/users/${me.id}/feed`)).body;
    assert.equal(feed.length, 1);
    assert.equal(feed[0].analysis.movie.title, 'Arrival');
    assert.ok(feed[0].analysis.snapshots.before.length && feed[0].analysis.snapshots.after.length);

    const visible = (await call('GET', `/api/users/${sam.id}?as=${me.id}`)).body;
    assert.equal(visible.entries.length, 3);
    const hidden = (await call('GET', `/api/users/${lee.id}?as=${me.id}`)).body;
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.entries, undefined);
    const stranger = (await call('POST', '/api/users', { name: 'Stranger' })).body;
    assert.equal((await call('GET', `/api/users/${sam.id}?as=${stranger.id}`)).body.hidden, true, 'not following means no access');
  }));

test('api: collaborators mode returns picks, names who was left out, and explains it', () =>
  withServer(async ({ call }) => {
    const host = (await call('POST', '/api/users', { name: 'Host' })).body;
    const a = (await call('POST', '/api/users', { name: 'A' })).body;
    const b = (await call('POST', '/api/users', { name: 'B', sharing: 'private' })).body;
    await call('POST', `/api/users/${host.id}/follow`, { targetId: a.id });
    await call('POST', `/api/users/${host.id}/follow`, { targetId: b.id });
    const ok = await call('POST', '/api/group/recommendations', { hostId: host.id, participantIds: [a.id, b.id], setting: 'online' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.mode, 'collaborators');
    assert.deepEqual(ok.body.excluded.map((e) => e.name), ['B']);
    const bad = await call('POST', '/api/group/recommendations', { hostId: host.id, participantIds: [b.id] });
    assert.equal(bad.status, 422);
    assert.match(bad.body.error, /at least two/);
  }));

test('api: disagreement is recorded through the API with its reason and validated', () =>
  withServer(async ({ call, catalog }) => {
    const u = (await call('POST', '/api/users', { name: 'Kim' })).body;
    const id = findByTitle(catalog, 'Tenet').id;
    const bad = await call('POST', '/api/feedback', { userId: u.id, movieId: id, kind: 'nonsense' });
    assert.equal(bad.status, 400);
    const ok = await call('POST', '/api/feedback', { userId: u.id, movieId: id, kind: 'not-my-taste', reason: 'Confusing plot' });
    assert.equal(ok.body.reason, 'Confusing plot');
    const list = (await call('GET', `/api/feedback?userId=${u.id}`)).body;
    assert.equal(list[0].movie.title, 'Tenet');
    const rec = (await call('GET', `/api/users/${u.id}/recommendations?limit=20`)).body;
    assert.ok(!rec.recommendations.some((r) => r.movie.id === id));
  }));

test('api: errors are clean JSON; static files are served without path traversal', () =>
  withServer(async ({ call, base }) => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
    assert.equal((await call('GET', '/api/users/u999')).status, 404);
    assert.equal((await call('POST', '/api/users', { name: '   ' })).status, 400);
    const bad = await fetch(`${base}/api/users`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    const trav = await fetch(`${base}/..%2Fpackage.json`);
    assert.equal(trav.status, 404);
  }));

test('api: judge walkthrough runs on a throwaway store and leaves real data untouched', () =>
  withServer(async ({ call }) => {
    const out = (await call('POST', '/api/demo/judge')).body;
    assert.ok(out.recommendation.result.recommendations.length);
    assert.ok(out.friendAdded && out.disagreement.illustrative);
    assert.deepEqual((await call('GET', '/api/users')).body, []);
    const seeded = (await call('POST', '/api/demo/seed')).body;
    assert.ok(seeded.ids.alex);
    assert.equal((await call('POST', '/api/demo/seed')).body.ids.alex, seeded.ids.alex, 'seeding is idempotent');
  }));
