// A stand-in for src/agent/sources with no network. It records every call so tests can assert on the agent's behavior.
export function fakeSources({ runtimes = {}, defaultRuntime = 110, letterboxd = null, rt = null, scraping = true, omdb = false, fail = false } = {}) {
  const calls = { letterboxd: [], rottenTomatoes: [], omdb: [] };
  const down = (source) => ({ source, status: 'error', reason: 'simulated outage' });
  return {
    calls,
    configured: { scraping, omdb, userAgent: 'UpNextBot/test' },
    async letterboxd(m) {
      calls.letterboxd.push(m.id);
      if (fail) return down('letterboxd');
      if (!scraping) return { source: 'letterboxd', status: 'disabled', reason: 'web scraping is turned off' };
      const value = letterboxd?.[m.id] ?? (m.rating.consensus ?? 7);
      return {
        source: 'letterboxd', status: 'ok', url: `https://letterboxd.com/film/${m.slug ?? m.id}/`, imdbId: 'tt0000001',
        runtime: runtimes[m.id] ?? defaultRuntime,
        ratings: [{ source: 'letterboxd', value, votes: 250000, kind: 'audience', basis: 'live page' }],
      };
    },
    async rottenTomatoes(m) {
      calls.rottenTomatoes.push(m.id);
      if (fail) return down('rottentomatoes');
      if (!scraping) return { source: 'rottentomatoes', status: 'disabled', reason: 'web scraping is turned off' };
      const critic = rt?.[m.id] ?? (m.rating.consensus ?? 7);
      return {
        source: 'rottentomatoes', status: 'ok', url: `https://www.rottentomatoes.com/m/${m.slug ?? m.id}`,
        ratings: [
          { source: 'rottentomatoes', value: critic, votes: 200, kind: 'critic', basis: 'live page', detail: { liked: Math.round(critic * 20), count: 200, certified: critic >= 7.5 } },
          { source: 'rt-audience', value: Math.min(10, critic + 0.2), votes: 50000, votesAtLeast: true, kind: 'audience', basis: 'live page' },
        ],
      };
    },
    async omdb(m) {
      calls.omdb.push(m.id);
      return { source: 'omdb', status: 'unavailable', reason: 'OMDB_API_KEY not set' };
    },
  };
}

import { buildMovie, catalogFromMovies } from '../src/data/catalog.js';

// A small catalog built the same way as the real one (with the title index used by search and title resolution).
export const catalogOf = (list) => catalogFromMovies(list.map(buildMovie), { base: 'test', movieCount: list.length });
