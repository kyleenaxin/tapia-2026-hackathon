import path from 'node:path';
import { createPoliteFetcher, createResultCache } from './politeFetch.js';
import { fetchLetterboxd, fetchRottenTomatoes, fetchOmdb } from './adapters.js';

// Wraps each adapter with an on-disk cache of parsed results so repeat runs are instant and sites are hit rarely.
export function createSources({ env = process.env, fetcher = createPoliteFetcher(), cache = createResultCache(), scraping } = {}) {
  const scrapingOn = scraping ?? env.ENABLE_WEB_SCRAPING !== '0';
  const ctx = { fetcher, env };

  async function cached(name, movie, fn, { needsScraping = false } = {}) {
    if (needsScraping && !scrapingOn) return { source: name, status: 'disabled', reason: 'web scraping is turned off (ENABLE_WEB_SCRAPING=0)' };
    const key = `v2:${name}:${movie.id}`;
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
    const res = await fn(movie, ctx);
    if (res.status === 'ok') cache.set(key, res);
    else if (['not-found', 'mismatch', 'no-score', 'blocked', 'unparsed'].includes(res.status)) cache.set(key, res, { negative: true });
    return res;
  }

  return {
    configured: { scraping: scrapingOn, omdb: !!env.OMDB_API_KEY, userAgent: fetcher.userAgent },
    letterboxd: (m) => cached('letterboxd', m, fetchLetterboxd, { needsScraping: true }),
    // hints (such as the IMDb id read from the Letterboxd page) let later tools find the exact film.
    rottenTomatoes: (m, hints = {}) => cached('rottentomatoes', m, (mv, c) => fetchRottenTomatoes(mv, { ...c, hints }), { needsScraping: true }),
    omdb: (m, hints = {}) => cached('omdb', m, (mv, c) => fetchOmdb(mv, { ...c, hints })),
  };
}

export const defaultSources = (root) => createSources({ cache: createResultCache({ file: path.join(root, 'data', 'cache', 'sources.json') }) });
