import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadDefaultCatalog } from './catalogSetup.js';
import { Store } from './store.js';
import { defaultSources } from './agent/sources/index.js';
import { createJobs } from './agent/jobs.js';
import { createWebApp } from './web/app.js';

export function buildApp({ catalog, store, sources, jobs = createJobs({ store, catalog, sources }), publicDir }) {
  return createWebApp({ catalog, store, sources, jobs, publicDir });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional */ }
  const catalog = loadDefaultCatalog();
  const store = new Store({ file: path.join(ROOT, 'data', 'state.json') });
  const sources = defaultSources(ROOT);
  const port = Number(process.env.PORT) || 3000;
  http.createServer(buildApp({ catalog, store, sources })).listen(port, () => {
    console.log(`Up Next is showing at http://localhost:${port}`);
    console.log(`Films: ${catalog.provenance.base}, ${catalog.provenance.movieCount.toLocaleString('en-US')} loaded`);
    for (const n of catalog.provenance.notes) console.log(`  ${n}`);
    console.log(`Live sources: web scraping ${sources.configured.scraping ? 'on' : 'off'}, OMDb ${sources.configured.omdb ? 'on' : 'off'}`);
  });
}
