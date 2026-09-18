// Entry point for the server-rendered app in src/web.
//
// src/server.js still boots the older JSON API and serves public/index.html, so
// this is kept separate rather than replacing it: `npm run start:web` runs this,
// `npm start` runs the original. Point the host at this one to serve the pages
// in src/web/views.js and src/web/roomViews.js.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadDefaultCatalog } from '../catalogSetup.js';
import { Store } from '../store.js';
import { defaultSources } from '../agent/sources/index.js';
import { createJobs } from '../agent/jobs.js';
import { createWebApp } from './app.js';

export function bootWebApp() {
  const catalog = loadDefaultCatalog();
  const store = new Store({ file: path.join(ROOT, 'data', 'state.json') });
  const sources = defaultSources(ROOT);
  const jobs = createJobs({ store, catalog, sources });
  return { app: createWebApp({ catalog, store, sources, jobs }), catalog, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional */ }
  const { app, catalog } = bootWebApp();
  const port = Number(process.env.PORT) || 3000;
  http.createServer(app).listen(port, () => {
    console.log(`Up Next running at http://localhost:${port}`);
    console.log(`Catalog: ${catalog.provenance.base}, ${catalog.provenance.movieCount} movies`);
  });
}
