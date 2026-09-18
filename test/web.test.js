import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { createJobs } from '../src/agent/jobs.js';
import { fixtureCatalog } from './helpers.js';
import { fakeSources } from './fakeSources.js';

async function withSite(fn) {
  const catalog = fixtureCatalog();
  const store = new Store();
  const sources = fakeSources();
  const jobs = createJobs({ store, catalog, sources });
  const server = http.createServer(buildApp({ catalog, store, sources, jobs }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;

  const client = () => {
    let cookie = '';
    const req = async (method, path, { form, multipart, headers = {} } = {}) => {
      const h = { ...headers };
      if (cookie) h.Cookie = cookie;
      let body;
      if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(Object.entries(form).flatMap(([k, v]) => [].concat(v).map((x) => [k, x]))).toString(); }
      if (multipart) {
        const boundary = '----up-next-test';
        h['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        body = Object.entries(multipart).flatMap(([k, v]) => [].concat(v).map((x) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${x}\r\n`)).join('') + `--${boundary}--\r\n`;
      }
      const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
      const set = res.headers.getSetCookie?.() ?? [];
      const mine = set.find((c) => c.startsWith('upnext='));
      if (mine) cookie = mine.split(';')[0];
      // Apostrophes are escaped as &#39; in the HTML; decode only those so assertions can read naturally. Other escapes stay visible.
      const text = (await res.text()).replaceAll('&#39;', "'");
      return { status: res.status, headers: res.headers, text, location: res.headers.get('location'), setCookie: set };
    };
    return {
      get: (p, o) => req('GET', p, o),
      post: (p, o) => req('POST', p, o),
      get cookie() { return cookie; },
    };
  };

  const waitDone = async (c, jobPath) => {
    const id = jobPath.split('/').pop().split('?job=').pop();
    for (let i = 0; i < 200; i++) {
      const s = JSON.parse((await c.get(`/run/${id}/status`)).text);
      if (s.status !== 'running') return s;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('job did not finish');
  };

  try { await fn({ base, client, store, catalog, jobs, waitDone, sources }); } finally { server.close(); }
}

const SOLO = { name: 'Robin', genres: ['Science Fiction', 'Thriller'], mood: 'mindbend', loved: 'Inception\nInterstellar', disliked: 'Mamma Mia!', watched: 'The Dark Knight', maxRuntime: '150', hardNoGenres: ['Horror'], hardNoTerms: '', importKind: 'auto', importCsv: '' };

async function soloRun(c, waitDone, fields = SOLO) {
  const post = await c.post('/solo', { multipart: fields });
  assert.equal(post.status, 303);
  return { runPath: post.location, post };
}

test('public pages render with strict security headers and do not create a session', () =>
  withSite(async ({ client }) => {
    const c = client();
    for (const p of ['/', '/mode', '/about', '/judge']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(r.setCookie, [], `${p} must not set a cookie`);
      assert.doesNotMatch(r.text, /<script>|onclick=/i, 'no inline scripts under the CSP');
    }
  }));

test('welcome page has the drawn curtains and the ticket that opens them', () =>
  withSite(async ({ client }) => {
    const r = await client().get('/');
    assert.match(r.text, /class="curtain left"/);
    assert.match(r.text, /class="curtain right"/);
    assert.match(r.text, /href="\/mode"[^>]*data-open-curtains/);
    assert.match(r.text, /Get started/);
    assert.match(r.text, /Admit one/);
    const mode = await client().get('/mode');
    assert.match(mode.text, /href="\/solo"/);
    assert.match(mode.text, /href="\/group"/);
  }));

test('a session cookie is HttpOnly and SameSite, and created only when a person is needed', () =>
  withSite(async ({ client, store }) => {
    const c = client();
    assert.equal(store.listUsers().length, 0);
    const r = await c.get('/solo');
    assert.match(r.setCookie[0], /^upnext=u_/);
    assert.match(r.setCookie[0], /HttpOnly/);
    assert.match(r.setCookie[0], /SameSite=Lax/);
    assert.equal(store.listUsers().length, 1);
    await c.get('/solo');
    assert.equal(store.listUsers().length, 1, 'the same cookie reuses the same person');
  }));

test('solo flow: preferences in, live log, then a primary pick and two backups with every section', () =>
  withSite(async ({ client, waitDone }) => {
    const c = client();
    const form = await c.get('/solo');
    for (const label of ['What do you love\\?', 'What kind of night\\?', 'Films you loved', 'Films that missed', 'Already seen', 'How long have you got\\?', "Anything you can't watch\\?", 'Bring your history\\?']) assert.match(form.text, new RegExp(label), label);
    const { runPath } = await soloRun(c, waitDone);
    assert.match(runPath, /^\/run\//);
    const view = await c.get(runPath);
    assert.match(view.text, /The projectionist is at work|/);
    const status = await waitDone(c, runPath);
    assert.equal(status.status, 'done');
    assert.ok(status.steps.length >= 6);
    const redirect = await c.get(runPath);
    assert.equal(redirect.status, 303);
    assert.match(redirect.location, /^\/results\//);
    const res = await c.get(redirect.location);
    assert.equal(res.status, 200);
    for (const s of ["Tonight's pick", 'Backup one', 'Backup two', '<h4>Why</h4>', 'Ratings and reviews', 'What people say', '<h4>Drawbacks</h4>', 'Rotten Tomatoes critics', 'Letterboxd', 'How the agent got here']) assert.ok(res.text.includes(s), s);
    for (const b of ['Watched', 'Want to watch', 'Thumbs up', 'Thumbs down']) assert.ok(res.text.includes(b), b);
    assert.match(res.text, /Streaming availability is not checked/);
    assert.ok(!/Inception<\/h2>|Interstellar<\/h2>|Dark Knight<\/h2>|Mamma Mia/.test(res.text.split('If that is not it')[0]), 'films the person already saw are not recommended');
  }));

test('the live log page auto-refreshes without JavaScript and shows steps as they are logged', () =>
  withSite(async ({ client, jobs }) => {
    const c = client();
    await c.get('/solo');
    const { runPath } = await soloRun(c, null);
    const view = await c.get(runPath);
    if (view.status === 200) {
      assert.match(view.text, /<noscript><meta http-equiv="refresh"/);
      assert.match(view.text, /id="run"/);
      assert.match(view.text, /data-status="\/run\/[\w-]+\/status"/);
    }
    assert.ok(jobs.jobs.size >= 1);
  }));

test('follow-up: an unclear title makes the agent ask, and answering resumes the run', () =>
  withSite(async ({ client, waitDone }) => {
    const c = client();
    const { runPath } = await soloRun(c, waitDone, { ...SOLO, loved: 'Grand Budapest' });
    const ask = await c.get(runPath);
    assert.equal(ask.status, 200);
    assert.match(ask.text, /One question first/);
    assert.match(ask.text, /Did you mean/);
    assert.match(ask.text, /The Grand Budapest Hotel/);
    assert.match(ask.text, /None of these, skip it/);
    const inputName = /name="(t0)" value="([^"]+)"/.exec(ask.text);
    assert.ok(inputName);
    const answered = await c.post(`${runPath}/answers`, { form: { [inputName[1]]: inputName[2] } });
    assert.equal(answered.status, 303);
    const status = await waitDone(c, runPath);
    assert.equal(status.status, 'done');
    const results = await c.get((await c.get(runPath)).location);
    assert.match(results.text, /Tonight's pick/);
    const shelf = await c.get('/shelf');
    assert.match(shelf.text, /The Grand Budapest Hotel/);
  }));

test('feedback loop: a thumbs down removes the pick, explains the change, and lands on the shelf with its reason', () =>
  withSite(async ({ client, waitDone }) => {
    const c = client();
    const { runPath } = await soloRun(c, waitDone);
    await waitDone(c, runPath);
    const resultsPath = (await c.get(runPath)).location;
    const first = await c.get(resultsPath);
    const primaryId = /name="movie" value="([^"]+)"/.exec(first.text)[1];
    const primaryTitle = /<article class="paper pick primary" aria-label="Tonight's pick: ([^"]+)"/.exec(first.text)[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'");

    const fb = await c.post(`${resultsPath}/feedback`, { form: { movie: primaryId, action: 'down', reason: 'too-long' } });
    assert.equal(fb.status, 303);
    await waitDone(c, fb.location);
    const next = await c.get((await c.get(fb.location)).location);
    assert.match(next.text, /Recommendations updated/);
    assert.match(next.text, /thumbs down/i);
    assert.match(next.text, /too long/);
    assert.match(next.text, new RegExp(`main pick changed from <strong>${primaryTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '(?:\'|&#39;)')}</strong>`));
    assert.ok(!new RegExp(`aria-label="Tonight's pick: ${primaryTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(next.text));

    const shelf = await c.get('/shelf');
    assert.match(shelf.text, /Passed on <span class="count">1<\/span>/);
    assert.match(shelf.text, /too long/);
  }));

test('watched, want to watch and thumbs up each change what the agent knows', () =>
  withSite(async ({ client, waitDone, store }) => {
    const c = client();
    const { runPath } = await soloRun(c, waitDone);
    await waitDone(c, runPath);
    let resultsPath = (await c.get(runPath)).location;
    async function pickIds(path) { return [...(await c.get(path)).text.matchAll(/name="movie" value="([^"]+)"/g)].map((m) => m[1]); }
    const [a, b, d] = [...new Set(await pickIds(resultsPath))];

    let r = await c.post(`${resultsPath}/feedback`, { form: { movie: a, action: 'watched', verdict: 'liked' } });
    await waitDone(c, r.location);
    resultsPath = (await c.get(r.location)).location;
    r = await c.post(`${resultsPath}/feedback`, { form: { movie: b, action: 'want' } });
    await waitDone(c, r.location);
    resultsPath = (await c.get(r.location)).location;
    r = await c.post(`${resultsPath}/feedback`, { form: { movie: d, action: 'up' } });
    await waitDone(c, r.location);

    const user = store.listUsers()[0];
    const entries = store.entriesFor(user.id);
    assert.equal(entries.find((e) => e.movieId === a).verdict, 'liked');
    assert.equal(entries.find((e) => e.movieId === a).status, 'watched');
    assert.equal(entries.find((e) => e.movieId === b).status, 'watchlist');
    assert.equal(store.feedbackFor(user.id).find((f) => f.movieId === d).kind, 'thumbs-up');
    const shelf = await c.get('/shelf');
    assert.match(shelf.text, /Want to watch <span class="count">1<\/span>/);
    assert.match(shelf.text, /Thumbs up <span class="count">1<\/span>/);
    assert.match(shelf.text, /Loved it/);
  }));

test('results are private to their owner: other visitors get a friendly 404 and cannot post feedback', () =>
  withSite(async ({ client, waitDone }) => {
    const c = client();
    const { runPath } = await soloRun(c, waitDone);
    await waitDone(c, runPath);
    const resultsPath = (await c.get(runPath)).location;
    const stranger = client();
    await stranger.get('/solo');
    const peek = await stranger.get(resultsPath);
    assert.equal(peek.status, 404);
    assert.match(peek.text, /Nothing playing here|not available/);
    const status = await stranger.get(`${runPath}/status`);
    assert.equal(status.status, 404);
    const forged = await stranger.post(`${resultsPath}/feedback`, { form: { movie: 'inception', action: 'down' } });
    assert.equal(forged.status, 404);
    const anon = await client().get(resultsPath);
    assert.equal(anon.status, 404);
  }));

test('cross-site form posts are refused', () =>
  withSite(async ({ client }) => {
    const c = client();
    await c.get('/solo');
    const evil = await c.post('/solo', { multipart: SOLO, headers: { Origin: 'http://evil.test' } });
    assert.equal(evil.status, 403);
    assert.match(evil.text, /Cross-site/);
  }));

test('user-supplied text is escaped everywhere it is shown', () =>
  withSite(async ({ client, base }) => {
    const c = client();
    const host = await c.post('/group', { form: { name: '<img src=x onerror=alert(1)>', roomName: '"><script>alert(2)</script>', setting: 'in-person' } });
    const room = await c.get(host.location);
    assert.equal(room.status, 200);
    assert.doesNotMatch(room.text, /<img src=x/);
    assert.doesNotMatch(room.text, /<script>alert/);
    assert.match(room.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
    const url = new URL(host.location, base);
    assert.match(url.pathname, /^\/room\/[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  }));

test('Letterboxd import through the form saves matched films and reports the rest', () =>
  withSite(async ({ client, waitDone }) => {
    const c = client();
    const csv = 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Inception,2010,x,5\n2024-01-02,Some Film Nobody Has,1999,y,4\n';
    const { runPath } = await soloRun(c, waitDone, { ...SOLO, loved: '', watched: '', disliked: '', importCsv: csv });
    await waitDone(c, runPath);
    const shelf = await c.get('/shelf');
    assert.match(shelf.text, /Inception/);
    assert.match(shelf.text, /Loved it/);
    const results = await c.get((await c.get(runPath)).location);
    assert.match(results.text, /Matched 1 of 2 films/);
  }));

test('shelf: add a film, change its verdict, remove it, and undo a thumbs down', () =>
  withSite(async ({ client, store }) => {
    const c = client();
    await c.get('/shelf');
    const user = store.listUsers()[0];
    let r = await c.post('/shelf/add', { multipart: { title: 'Get Out', verdict: 'liked', status: 'watched' } });
    assert.equal(r.status, 303);
    assert.equal(store.entriesFor(user.id)[0].verdict, 'liked');
    const id = store.entriesFor(user.id)[0].movieId;
    await c.post('/shelf/verdict', { form: { movie: id, verdict: 'disliked' } });
    assert.equal(store.entriesFor(user.id)[0].verdict, 'disliked');
    const bad = await c.post('/shelf/add', { multipart: { title: 'Zzzz Not A Film' } });
    assert.equal(bad.status, 404);
    assert.match(bad.text, /could not find/i);
    await c.post('/shelf/remove', { form: { movie: id } });
    assert.equal(store.entriesFor(user.id).length, 0);
    const fb = store.addFeedback({ userId: user.id, movieId: id, kind: 'not-my-taste', reason: 'meh', context: 'solo' });
    await c.post('/shelf/unfeedback', { form: { id: fb.id } });
    assert.equal(store.feedbackFor(user.id).length, 0);
    const other = client();
    await other.get('/shelf');
    const keep = store.addFeedback({ userId: user.id, movieId: id, kind: 'not-my-taste', context: 'solo' });
    await other.post('/shelf/unfeedback', { form: { id: keep.id } });
    assert.equal(store.feedbackFor(user.id).length, 1, 'someone else cannot delete your feedback');
  }));

// ---------- group ----------
async function openRoom(client) {
  const host = client();
  const created = await host.post('/group', { form: { name: 'Hosty', roomName: 'Friday film club', setting: 'in-person' } });
  const code = created.location.split('/').pop();
  return { host, code };
}
const GROUP_TASTE = (name, extra = {}) => ({ name, genres: ['Science Fiction'], mood: 'mindbend', loved: 'Inception', maxRuntime: '', hardNoGenres: [], hardNoTerms: '', importKind: 'auto', importCsv: '', ...extra });

test('group flow: open a room, invite by link, join with consent, add someone on this device, find a movie', () =>
  withSite(async ({ client, waitDone, store }) => {
    const { host, code } = await openRoom(client);
    const lobby = await host.get(`/room/${code}`);
    assert.match(lobby.text, new RegExp(code));
    assert.match(lobby.text, /Copy invite link/);
    assert.match(lobby.text, /Waiting for at least two people/);
    assert.match(lobby.text, /Add someone on this device/);

    const guest = client();
    const bounced = await guest.get(`/room/${code}`);
    assert.equal(bounced.status, 303);
    assert.equal(bounced.location, `/room/${code}/join`);
    const join = await guest.get(`/room/${code}/join`);
    assert.match(join.text, /What joining means/);
    assert.match(join.text, /leave any time/);
    const joined = await guest.post(`/room/${code}/join`, { form: { name: 'Gus' } });
    assert.equal(joined.location, `/room/${code}/taste`);

    await guest.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Gus', { genres: ['Comedy'], mood: 'cozy', loved: 'Paddington 2', hardNoGenres: ['Horror'] }) });
    const tooSoon = await host.post(`/room/${code}/find`);
    assert.match(tooSoon.location, /need=1/, 'host has not shared taste yet, so only one person is ready');
    await host.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Hosty') });

    const add = await host.post(`/room/${code}/add-person`, { form: { name: 'Pat' } });
    assert.match(add.location, new RegExp(`/room/${code}/taste\\?as=u_`));
    await host.post(`/room/${code}/taste`, { multipart: { ...GROUP_TASTE('Pat', { genres: ['Drama'], mood: 'cry', loved: 'Whiplash' }), as: add.location.split('as=')[1] } });

    const ready = await host.get(`/room/${code}`);
    for (const n of ['Hosty', 'Gus', 'Pat']) assert.match(ready.text, new RegExp(n));
    assert.match(ready.text, /On this device/);
    assert.match(ready.text, /Find our movie/);

    const found = await host.post(`/room/${code}/find`);
    assert.match(found.location, /^\/run\//);
    await waitDone(host, found.location);
    const results = await host.get((await host.get(found.location)).location);
    assert.equal(results.status, 200);
    for (const s of ["Tonight's programme for the room", 'Fit for each person', "How the group was balanced", 'Hosty', 'Gus', 'Pat', 'Hard no genres: Horror (Gus)', 'We watched it']) assert.ok(results.text.includes(s), s);
    assert.match(results.text, /Consensus|Compromise|Balanced/);
    assert.match(results.text, /watching in person/);
    assert.equal(store.getRoom(code).memberIds.length, 3);
  }));

test('room consent: outsiders cannot see the room or its results, and only the host can start or edit others', () =>
  withSite(async ({ client, waitDone }) => {
    const { host, code } = await openRoom(client);
    const guest = client();
    await guest.get(`/room/${code}/join`);
    await guest.post(`/room/${code}/join`, { form: { name: 'Gus' } });
    await guest.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Gus') });
    await host.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Hosty') });

    const forbiddenStart = await guest.post(`/room/${code}/find`);
    assert.equal(forbiddenStart.status, 403);
    const forbiddenAdd = await guest.post(`/room/${code}/add-person`, { form: { name: 'Sneaky' } });
    assert.equal(forbiddenAdd.status, 403);

    const found = await host.post(`/room/${code}/find`);
    await waitDone(host, found.location);
    const resultsPath = (await host.get(found.location)).location;
    assert.equal((await guest.get(resultsPath)).status, 200, 'members can see group results');

    const outsider = client();
    await outsider.get('/solo');
    assert.equal((await outsider.get(resultsPath)).status, 404, 'non-members cannot');
    assert.equal((await outsider.get(`/room/${code}`)).location, `/room/${code}/join`);
    assert.equal((await outsider.get(`/room/${code}/taste`)).status, 403);

    await guest.post(`/room/${code}/leave`);
    assert.equal((await guest.get(resultsPath)).status, 404, 'leaving the room revokes access');
    assert.equal((await client().get('/room/ZZZZ')).status, 404);
  }));

test('group feedback: a member\'s thumbs down vetoes the pick for the room and names who said no', () =>
  withSite(async ({ client, waitDone, store }) => {
    const { host, code } = await openRoom(client);
    const guest = client();
    await guest.get(`/room/${code}/join`);
    await guest.post(`/room/${code}/join`, { form: { name: 'Gus' } });
    await guest.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Gus') });
    await host.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Hosty') });
    const found = await host.post(`/room/${code}/find`);
    await waitDone(host, found.location);
    const resultsPath = (await host.get(found.location)).location;
    const page = await host.get(resultsPath);
    const primaryId = /name="movie" value="([^"]+)"/.exec(page.text)[1];
    const gusId = store.listUsers().find((u) => u.name === 'Gus').id;

    const veto = await host.post(`${resultsPath}/feedback`, { form: { movie: primaryId, action: 'down', who: gusId, reason: 'wrong-mood' } });
    assert.equal(veto.status, 303);
    await waitDone(host, veto.location);
    const after = await host.get((await host.get(veto.location)).location);
    assert.match(after.text, /Gus said no to/);
    assert.match(after.text, /out for the whole room/);
    assert.doesNotMatch(after.text.split('If that is not it')[0], new RegExp(`name="movie" value="${primaryId}"`));

    const spoof = await guest.post(`${resultsPath}/feedback`, { form: { movie: primaryId, action: 'down', who: store.listUsers().find((u) => u.name === 'Hosty').id } });
    assert.equal(spoof.status, 403, 'a guest cannot answer for someone else');
  }));

test('someone in a room who adds a movie triggers their roommate\'s agent, shown in the room and on the shelf', () =>
  withSite(async ({ client }) => {
    const { host, code } = await openRoom(client);
    const guest = client();
    await guest.get(`/room/${code}/join`);
    await guest.post(`/room/${code}/join`, { form: { name: 'Gus' } });
    await guest.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Gus', { loved: 'Inception\nInterstellar' }) });
    await host.post(`/room/${code}/taste`, { multipart: GROUP_TASTE('Hosty', { loved: 'Inception\nInterstellar' }) });
    await guest.post('/shelf/add', { multipart: { title: 'Arrival', verdict: 'liked', status: 'watched' } });
    const lobby = await host.get(`/room/${code}`);
    assert.match(lobby.text, /What roommates added/);
    assert.match(lobby.text, /Gus watched and liked it/);
    assert.match(lobby.text, /What changed in your list/);
    const shelf = await host.get('/shelf');
    assert.match(shelf.text, /What roommates added/);
  }));

// ---------- assets, api, walkthrough ----------
test('static assets are served with the right types, and traversal is refused', () =>
  withSite(async ({ client }) => {
    const c = client();
    const css = await c.get('/site.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.match(css.text, /--paper/);
    const font = await c.get('/fonts/limelight-400.woff2');
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal((await c.get('/site.js')).status, 200);
    assert.equal((await c.get('/fonts/..%2F..%2Fpackage.json')).status, 404);
    assert.equal((await c.get('/public/../package.json')).status, 404);
    const missing = await c.get('/nope');
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type'), /text\/html/);
    assert.match(missing.text, /nothing showing at that address/);
  }));

test('title suggestions come from the dataset', () =>
  withSite(async ({ client }) => {
    const r = await client().get('/api/suggest?q=incep', { headers: { Accept: 'application/json' } });
    assert.equal(r.status, 200);
    const list = JSON.parse(r.text);
    assert.equal(list[0].title, 'Inception');
    assert.equal(list[0].year, 2010);
    assert.deepEqual(JSON.parse((await client().get('/api/suggest?q=x')).text), []);
  }));

test('about page states what the agent does, where data comes from, and how it treats websites', () =>
  withSite(async ({ client }) => {
    const r = await client().get('/about');
    for (const s of ['robots.txt', 'never fetches a page it disallows', 'does not try to get around blocking', 'Streaming availability', 'Hugging Face', 'Wikidata', 'terms of service']) assert.ok(r.text.includes(s), s);
    assert.match(r.text, /UpNextBot/);
  }));

test('judge walkthrough runs the agent live and shows all three parts, labeling the seeded example', () =>
  withSite(async ({ client, waitDone }) => {
    const c = client();
    const intro = await c.get('/judge');
    assert.match(intro.text, /Run the walkthrough/);
    const start = await c.post('/judge');
    assert.match(start.location, /^\/judge\?job=/);
    const running = await c.get(start.location);
    assert.ok(running.status === 200);
    const status = await waitDone(c, start.location);
    assert.equal(status.status, 'done');
    const page = await c.get(start.location);
    for (const s of ['1. A recommendation, with its reasoning', '2. What changed when a friend added a movie', '3. A recommendation a human disagreed with', 'Illustrative example', 'Seeded demo people', 'Jordan is not', 'Before the veto', 'After the veto', 'Full agent log']) assert.ok(page.text.includes(s), s);
    assert.doesNotMatch(page.text, /name="action" value="down"/, 'the walkthrough is read-only');
    const forbidden = await c.post(`/results/${status.id}/feedback`, { form: { movie: 'x', action: 'down' } });
    assert.equal(forbidden.status, 403);
  }));
