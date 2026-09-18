import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../catalogSetup.js';
import { HttpError } from '../store.js';
import { searchCatalog } from '../data/catalog.js';
import { processPreferences } from '../agent/intake.js';
import { jobView } from '../agent/jobs.js';
import { parseCookies, parseForm, assertSameOrigin, SECURITY_HEADERS } from './http.js';
import { welcomeView, modeView, soloView, askView, runView, resultsView, errorView } from './views.js';
import { groupNewView, roomJoinView, roomView, roomTasteView, shelfView, aboutView } from './roomViews.js';
import { applyFeedback } from './feedback.js';
import { judgeView, startJudge } from './judge.js';

const MIME = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function createWebApp({ catalog, store, sources, jobs, publicDir = path.join(ROOT, 'public') }) {
  const provenance = { ...catalog.provenance, omdb: sources.configured.omdb };
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  // ---- responses ----
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };
  const page = (view, status = 200) => ({ status, type: 'text/html; charset=utf-8', body: String(view) });
  const redirect = (to) => ({ status: 303, headers: { Location: to } });
  const json = (data) => ({ status: 200, type: 'application/json', body: JSON.stringify(data) });

  // ---- sessions: an unguessable id in an HttpOnly cookie; created only when a page needs a person ----
  const sessionUser = (req, res, { create = true } = {}) => {
    const id = parseCookies(req.headers.cookie).upnext;
    let user = id ? store.findUser(id) : null;
    if (!user && create) {
      user = store.createUser({});
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `upnext=${user.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    return user;
  };

  const canSeeJob = (job, user) => {
    if (!job) return false;
    if (job.mode === 'judge') return true;
    if (job.actorId === user?.id || job.userId === user?.id) return true;
    if (job.roomCode) {
      try { return store.getRoom(job.roomCode).memberIds.includes(user?.id); } catch { return false; }
    }
    return false;
  };
  const jobFor = (id, user) => {
    const job = jobs.get(id);
    if (!canSeeJob(job, user)) throw new HttpError(404, 'That screening is not available. It may have expired, or belong to someone else.');
    return job;
  };

  const rename = (user, name) => { if (String(name ?? '').trim()) store.updateUser(user.id, { name }); };
  const savedCount = (user) => store.entriesFor(user.id).length;
  const memberInfo = (id) => {
    const u = store.getUser(id);
    const watched = store.entriesFor(id).filter((e) => e.status === 'watched').length;
    return { id, name: u.name, managedBy: u.managedBy, watched, genres: u.prefs.genres, avoid: u.prefs.avoidGenres, ready: watched > 0 || u.prefs.genres.length > 0 || !!u.prefs.mood };
  };
  const requireMember = (room, user) => {
    if (!room.memberIds.includes(user.id)) throw new HttpError(403, 'Join this room first.');
  };

  // ---- pages ----
  route('GET', '/', () => page(welcomeView()));
  route('GET', '/mode', () => page(modeView({ provenance })));
  route('GET', '/about', () => page(aboutView({ provenance, sources: sources.configured })));

  route('GET', '/solo', ({ req, res }) => {
    const user = sessionUser(req, res);
    return page(soloView({ user, genres: catalog.genres, saved: savedCount(user), provenance }));
  });

  route('POST', '/solo', async ({ req, res }) => {
    const user = sessionUser(req, res);
    const form = await parseForm(req);
    rename(user, form.name);
    const intake = processPreferences({ store, catalog, userId: user.id, form });
    const job = jobs.create({ userId: user.id, mode: 'solo', questions: intake.questions, notes: intake.notes, previousFrom: `solo:${user.id}` });
    return redirect(`/run/${job.id}`);
  });

  route('GET', '/run/:id', ({ req, res, params }) => {
    const user = sessionUser(req, res, { create: false });
    const job = jobFor(params.id, user);
    if (job.status === 'asking') return page(askView({ job, provenance }));
    if (job.status === 'done') return redirect(job.mode === 'intake' ? `/room/${job.roomCode}?saved=1` : `/results/${job.id}`);
    if (job.status === 'error') return page(errorView({ message: job.error, provenance }), 500);
    return page(runView({ job, provenance }));
  });

  route('GET', '/run/:id/status', ({ req, res, params }) => json(jobView(jobFor(params.id, sessionUser(req, res, { create: false })))));

  route('POST', '/run/:id/answers', async ({ req, res, params }) => {
    const job = jobFor(params.id, sessionUser(req, res, { create: false }));
    jobs.answer(job, await parseForm(req));
    return redirect(`/run/${job.id}`);
  });

  route('GET', '/results/:id', ({ req, res, params }) => {
    const job = jobFor(params.id, sessionUser(req, res, { create: false }));
    if (job.status !== 'done' || !job.result) return redirect(`/run/${job.id}`);
    return page(resultsView({ job, provenance, readOnly: job.mode === 'judge' }));
  });

  route('POST', '/results/:id/feedback', async ({ req, res, params }) => {
    const user = sessionUser(req, res, { create: false });
    const job = jobFor(params.id, user);
    if (job.mode === 'judge') throw new HttpError(403, 'The walkthrough is read-only.');
    const form = await parseForm(req);
    const { banner } = applyFeedback({ store, catalog, job, user, form });
    const next = jobs.create({ userId: job.userId, actorId: user.id, mode: job.mode, roomCode: job.roomCode, banner, previousFrom: job.mode === 'group' ? `group:${job.roomCode}` : `solo:${job.userId}` });
    return redirect(`/run/${next.id}`);
  });

  // ---- shelf ----
  route('GET', '/shelf', ({ req, res }) => {
    const user = sessionUser(req, res);
    const entries = store.entriesFor(user.id).map((entry) => ({ entry, movie: catalog.byId.get(entry.movieId) })).filter((x) => x.movie);
    const fbs = store.feedbackFor(user.id).map((fb) => ({ fb, movie: catalog.byId.get(fb.movieId) })).filter((x) => x.movie);
    return page(shelfView({
      user,
      watched: entries.filter((x) => x.entry.status === 'watched').reverse(),
      wants: entries.filter((x) => x.entry.status === 'watchlist').reverse(),
      thumbsUp: fbs.filter((x) => x.fb.kind === 'thumbs-up'),
      passed: fbs.filter((x) => x.fb.kind !== 'thumbs-up' && x.fb.kind !== 'seen-it'),
      events: store.eventsFor(user.id),
      provenance,
    }));
  });

  route('POST', '/shelf/add', async ({ req, res }) => {
    const user = sessionUser(req, res);
    const form = await parseForm(req);
    const { addMovieWithAgents } = await import('../agent/watcher.js');
    const { resolveTitle } = await import('../data/catalog.js');
    const r = resolveTitle(catalog, String(form.title ?? '').split('\n')[0]);
    const movie = r.status === 'ok' ? r.movie : r.status === 'ambiguous' ? r.options[0] : null;
    if (!movie) throw new HttpError(404, r.suggestions?.length ? `I could not find that exactly. Did you mean ${r.suggestions.map((m) => `${m.title} (${m.year})`).join(' or ')}?` : 'I could not find that title in the dataset.');
    addMovieWithAgents({ store, catalog, actorId: user.id, movieId: movie.id, status: form.status === 'watchlist' ? 'watchlist' : 'watched', verdict: ['liked', 'meh', 'disliked'].includes(form.verdict) ? form.verdict : null });
    return redirect('/shelf');
  });
  route('POST', '/shelf/remove', async ({ req, res }) => {
    const user = sessionUser(req, res);
    store.removeEntry(user.id, (await parseForm(req)).movie);
    return redirect('/shelf');
  });
  route('POST', '/shelf/verdict', async ({ req, res }) => {
    const user = sessionUser(req, res);
    const form = await parseForm(req);
    store.setVerdict(user.id, form.movie, form.verdict || null);
    return redirect('/shelf');
  });
  route('POST', '/shelf/unfeedback', async ({ req, res }) => {
    const user = sessionUser(req, res);
    const id = (await parseForm(req)).id;
    store.state.feedback = store.state.feedback.filter((f) => !(f.id === id && f.userId === user.id));
    store.save();
    return redirect('/shelf');
  });

  // ---- group mode ----
  route('GET', '/group', ({ req, res }) => page(groupNewView({ user: sessionUser(req, res), provenance })));
  route('POST', '/group', async ({ req, res }) => {
    const user = sessionUser(req, res);
    const form = await parseForm(req);
    rename(user, form.name);
    const room = store.createRoom({ hostId: user.id, name: form.roomName, setting: form.setting === 'online' ? 'online' : 'in-person' });
    return redirect(`/room/${room.code}`);
  });

  route('GET', '/room/:code', ({ req, res, params, query }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    if (!room.memberIds.includes(user.id)) return redirect(`/room/${room.code}/join`);
    const origin = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
    return page(roomView({
      room, viewer: user, members: room.memberIds.map(memberInfo), events: store.eventsFor(user.id),
      inviteUrl: `${origin}/room/${room.code}/join`, provenance,
      flash: query.get('saved') ? 'Taste saved.' : query.get('need') ? 'You need at least two people who have shared their taste.' : null,
    }));
  });

  route('GET', '/room/:code/join', ({ req, res, params }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    if (room.memberIds.includes(user.id)) return redirect(`/room/${room.code}`);
    return page(roomJoinView({ room, hostName: store.getUser(room.hostId).name, user, provenance }));
  });
  route('POST', '/room/:code/join', async ({ req, res, params }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    const form = await parseForm(req);
    rename(user, form.name);
    store.joinRoom(room.code, user.id);
    return redirect(`/room/${room.code}/taste`);
  });
  route('POST', '/room/:code/leave', ({ req, res, params }) => {
    const user = sessionUser(req, res);
    store.leaveRoom(params.code, user.id);
    return redirect('/mode');
  });

  const tasteTarget = (room, user, query, form) => {
    requireMember(room, user);
    const asId = query?.get?.('as') ?? form?.as;
    if (!asId || asId === user.id) return { target: user, isSelf: true };
    const target = store.getUser(asId);
    if (!room.memberIds.includes(target.id) || target.managedBy !== user.id) throw new HttpError(403, 'You can only edit people you added on this device.');
    return { target, isSelf: false };
  };
  route('GET', '/room/:code/taste', ({ req, res, params, query }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    const { target, isSelf } = tasteTarget(room, user, query);
    return page(roomTasteView({ room, target, isSelf, genres: catalog.genres, saved: savedCount(target), provenance }));
  });
  route('POST', '/room/:code/taste', async ({ req, res, params }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    const form = await parseForm(req);
    const { target } = tasteTarget(room, user, null, form);
    rename(target, form.name);
    const intake = processPreferences({ store, catalog, userId: target.id, form });
    if (intake.questions.length) {
      const job = jobs.create({ userId: target.id, actorId: user.id, mode: 'intake', roomCode: room.code, questions: intake.questions, notes: intake.notes });
      return redirect(`/run/${job.id}`);
    }
    return redirect(`/room/${room.code}?saved=1`);
  });
  route('POST', '/room/:code/add-person', async ({ req, res, params }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    if (room.hostId !== user.id) throw new HttpError(403, 'Only the host can add people on this device.');
    const person = store.createUser({ name: (await parseForm(req)).name, managedBy: user.id });
    store.joinRoom(room.code, person.id);
    return redirect(`/room/${room.code}/taste?as=${person.id}`);
  });
  route('POST', '/room/:code/find', ({ req, res, params }) => {
    const user = sessionUser(req, res);
    const room = store.getRoom(params.code);
    if (room.hostId !== user.id) throw new HttpError(403, 'Only the host can start the search.');
    if (room.memberIds.map(memberInfo).filter((m) => m.ready).length < 2) return redirect(`/room/${room.code}?need=1`);
    const job = jobs.create({ userId: user.id, mode: 'group', roomCode: room.code, previousFrom: `group:${room.code}` });
    return redirect(`/run/${job.id}`);
  });

  // ---- judge walkthrough ----
  route('GET', '/judge', ({ req, res, query }) => page(judgeView({ jobs, provenance, jobId: query.get('job') })));
  route('POST', '/judge', () => redirect(`/judge?job=${startJudge({ jobs, catalog, sources }).id}`));

  // ---- typeahead ----
  route('GET', '/api/suggest', ({ query }) => json(searchCatalog(catalog, query.get('q'), 6).map((m) => ({ title: m.title, year: m.year, director: m.directors?.[0] ?? '' }))));

  // ---- static files ----
  const serveStatic = (res, pathname) => {
    const file = path.resolve(publicDir, `.${pathname}`);
    if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
    send(res, 200, MIME[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file), { 'Cache-Control': 'public, max-age=3600' });
    return true;
  };

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (/^\/(site\.css|site\.js|fonts\/[\w.-]+)$/.test(url.pathname) && serveStatic(res, url.pathname)) return;
      }
      if (req.method === 'POST') assertSameOrigin(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const out = await r.handler({ req, res, params, query: url.searchParams });
        return send(res, out.status, out.type ?? 'text/plain', out.body ?? '', out.headers ?? {});
      }
      throw new HttpError(404, 'There is nothing showing at that address.');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error(e);
      const message = e instanceof HttpError ? e.message : 'Something unexpected went wrong. Please try again.';
      if (req.headers.accept?.includes('application/json') && !req.headers.accept.includes('text/html')) return send(res, status, 'application/json', JSON.stringify({ error: message }));
      send(res, status, 'text/html; charset=utf-8', String(errorView({ message, provenance, status })));
    }
  };
}
