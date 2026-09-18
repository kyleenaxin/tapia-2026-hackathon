import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadDefaultCatalog } from './catalogSetup.js';
import { Store, HttpError } from './store.js';
import { publicMovie, searchCatalog, crowdFavorites, withExtraRatings } from './data/catalog.js';
import { createLiveSources } from './data/live.js';
import { analyzeReviews } from './agent/reviews.js';
import { mostSimilar } from './agent/similarity.js';
import { rankForUser } from './agent/rank.js';
import { rankForGroup } from './agent/group.js';
import { addMovieWithAgents } from './agent/watcher.js';
import { createTrace } from './agent/trace.js';
import { buildProfile, summarizeProfile } from './agent/profile.js';
import { seedDemo } from './demo/seed.js';
import { runJudgeScenario } from './demo/scenario.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

const card = (m) => ({
  id: m.id,
  title: m.title,
  year: m.year,
  runtime: m.runtime,
  genres: m.genres,
  consensus: m.rating.consensus == null ? null : Number(m.rating.consensus.toFixed(1)),
  votes: m.rating.sources.reduce((s, r) => s + (r.votes ?? 0), 0),
});

export function createApp({ catalog, store, live }) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };
  const movieOr404 = (id) => {
    const m = catalog.byId.get(Number(id));
    if (!m) throw new HttpError(404, `movie ${id} not found`);
    return m;
  };
  const publicUser = (u) => ({ id: u.id, name: u.name, sharing: u.sharing, demo: u.demo });

  route('GET', '/api/meta', () => ({
    provenance: catalog.provenance,
    genres: catalog.genres,
    live: live.configured,
    availabilityChecked: false,
  }));

  route('GET', '/api/movies/search', ({ query }) => searchCatalog(catalog, query.get('q')).map(card));

  route('GET', '/api/movies/crowd', ({ query }) => {
    const userId = query.get('userId');
    const genre = query.get('genre');
    const exclude = new Set(userId ? store.entriesFor(userId).map((e) => e.movieId) : []);
    const pool = genre ? { movies: catalog.movies.filter((m) => m.genres.includes(genre)) } : catalog;
    return {
      note: 'Highest-rated titles across all sources. This is what everyone else likes; it is a starting point, not a personal recommendation.',
      movies: crowdFavorites(pool, { limit: 12, exclude }).map(card),
    };
  });

  route('GET', '/api/movies/:id', async ({ params }) => {
    const m = movieOr404(params.id);
    const [omdb, reviewsRes] = await Promise.all([live.omdbRatings(m), live.tmdbReviews(m)]);
    const enriched = withExtraRatings(m, omdb.ratings);
    return {
      movie: publicMovie(enriched),
      sourceStatus: {
        omdb: { status: omdb.status, reason: omdb.reason },
        tmdbReviews: { status: reviewsRes.status, reason: reviewsRes.reason },
      },
      reviews: analyzeReviews(reviewsRes.reviews),
      similar: mostSimilar(m, catalog.movies, { limit: 4 }).map((s) => ({ ...card(s.movie), similarity: Number(s.similarity.toFixed(2)) })),
    };
  });

  route('GET', '/api/users', () => store.listUsers().map(publicUser));
  route('POST', '/api/users', ({ body }) => publicUser(store.createUser({ name: body.name, sharing: body.sharing })));

  route('GET', '/api/users/:id', ({ params, query }) => {
    const owner = store.getUser(params.id);
    const viewerId = query.get('as') ?? owner.id;
    if (!store.canSee(viewerId, owner.id)) {
      return { user: publicUser(owner), hidden: true, reason: `${owner.name} has not shared their history with you.` };
    }
    const entries = store.entriesFor(owner.id).map((e) => ({ ...e, movie: card(catalog.byId.get(e.movieId) ?? { title: 'Unknown', genres: [], rating: { sources: [] } }) }));
    const profile = buildProfile({ user: owner, entries: store.entriesFor(owner.id), catalog, feedback: store.feedbackFor(owner.id) });
    return {
      user: { ...publicUser(owner), prefs: owner.prefs },
      entries,
      profile: summarizeProfile(profile, owner),
      following: store.followingOf(owner.id).map((id) => ({ ...publicUser(store.getUser(id)), visible: store.canSee(owner.id, id) })),
      followers: store.followersOf(owner.id).map((id) => publicUser(store.getUser(id))),
    };
  });

  route('PATCH', '/api/users/:id', ({ params, body }) => {
    const u = store.updateUser(params.id, { prefs: body.prefs, sharing: body.sharing });
    return { ...publicUser(u), prefs: u.prefs };
  });

  route('POST', '/api/users/:id/entries', ({ params, body }) => {
    movieOr404(body.movieId);
    const r = addMovieWithAgents({ store, catalog, actorId: params.id, movieId: Number(body.movieId), status: body.status ?? 'watched', verdict: body.verdict ?? null });
    const notified = Object.values(r.analyses ?? {}).map((a) => ({ viewerId: a.viewerId, action: a.action }));
    return { entry: r.entry, created: r.created, notified };
  });

  route('DELETE', '/api/users/:id/entries/:movieId', ({ params }) => {
    store.removeEntry(params.id, Number(params.movieId));
    return { ok: true };
  });

  route('POST', '/api/users/:id/follow', ({ params, body }) => {
    store.follow(params.id, body.targetId);
    return { ok: true };
  });
  route('DELETE', '/api/users/:id/follow/:targetId', ({ params }) => {
    store.unfollow(params.id, params.targetId);
    return { ok: true };
  });

  route('GET', '/api/users/:id/recommendations', ({ params, query }) =>
    rankForUser({ userId: params.id, store, catalog, limit: Math.min(20, Number(query.get('limit')) || 8), trace: createTrace() }));

  route('GET', '/api/users/:id/feed', ({ params }) => store.eventsFor(params.id).slice(0, 20));

  route('POST', '/api/group/recommendations', ({ body }) =>
    rankForGroup({ hostId: body.hostId, participantIds: body.participantIds ?? [], setting: body.setting === 'online' ? 'online' : 'in-person', store, catalog, limit: Math.min(15, Number(body.limit) || 6), trace: createTrace() }));

  route('POST', '/api/feedback', ({ body }) => {
    movieOr404(body.movieId);
    return store.addFeedback({ userId: body.userId, movieId: Number(body.movieId), kind: body.kind, reason: body.reason, context: body.context === 'group' ? 'group' : 'solo' });
  });
  route('GET', '/api/feedback', ({ query }) =>
    store.feedbackFor(query.get('userId')).map((f) => ({ ...f, movie: card(catalog.byId.get(f.movieId)) })));

  route('POST', '/api/demo/seed', () => ({ ids: seedDemo(store, catalog) }));
  route('POST', '/api/demo/judge', () => runJudgeScenario({ catalog }));

  const sendJson = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 1_000_000) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'invalid JSON body')); }
      });
      req.on('error', reject);
    });

  const serveStatic = (req, res, pathname) => {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(ROOT, 'public', rel);
    if (!file.startsWith(path.resolve(ROOT, 'public') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  };

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
        return sendJson(res, 200, await r.handler({ params, query: url.searchParams, body }));
      }
      throw new HttpError(404, 'no such endpoint');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      sendJson(res, e.status ?? 500, { error: e instanceof HttpError ? e.message : 'internal error' });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional */ }
  const catalog = loadDefaultCatalog();
  const store = new Store({ file: path.join(ROOT, 'data', 'state.json') });
  const live = createLiveSources();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(createApp({ catalog, store, live })).listen(port, () => {
    console.log(`Up Next running at http://localhost:${port}`);
    console.log(`Catalog: ${catalog.provenance.base}, ${catalog.provenance.movieCount} movies; live sources: ${JSON.stringify(live.configured)}`);
    for (const n of catalog.provenance.notes) console.log(`  ${n}`);
  });
}
