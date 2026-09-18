import { normTitle } from '../../data/catalog.js';

const num = (v) => Number(String(v ?? '').replace(/[^0-9.]/g, ''));

// ---------- Letterboxd film page ----------
export function parseLetterboxd(html) {
  let agg = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    const json = m[1].replace(/\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\//, '').trim();
    try {
      const o = JSON.parse(json);
      if (o.aggregateRating) { agg = o.aggregateRating; break; }
    } catch { /* try the next block */ }
  }
  const runtime = /(\d{1,3})(?:&nbsp;| |\s)+mins/.exec(html)?.[1];
  const year = /<title>[^<]*\((\d{4})\)/.exec(html)?.[1];
  const imdbId = /imdb\.com\/title\/(tt\d+)/.exec(html)?.[1] ?? null;
  return {
    ratingValue: agg ? Number(agg.ratingValue) : null,
    ratingCount: agg ? Number(agg.ratingCount) : null,
    runtime: runtime ? Number(runtime) : null,
    year: year ? Number(year) : null,
    imdbId,
  };
}

export async function fetchLetterboxd(movie, { fetcher }) {
  if (!movie.url) return { source: 'letterboxd', status: 'skipped', reason: 'no Letterboxd URL for this movie' };
  const res = await fetcher.get(movie.url);
  if (res.status !== 'ok') return { source: 'letterboxd', status: res.status, reason: res.reason ?? `HTTP ${res.http}`, url: movie.url };
  const p = parseLetterboxd(res.body);
  if (p.year && movie.year && Math.abs(p.year - movie.year) > 1) return { source: 'letterboxd', status: 'mismatch', reason: `page is for ${p.year}, expected ${movie.year}`, url: movie.url };
  if (p.ratingValue == null && p.runtime == null) return { source: 'letterboxd', status: 'unparsed', reason: 'page layout not recognized', url: movie.url };
  return {
    source: 'letterboxd',
    status: 'ok',
    url: movie.url,
    runtime: p.runtime,
    imdbId: p.imdbId,
    ratings: p.ratingValue ? [{ source: 'letterboxd', value: p.ratingValue * 2, votes: p.ratingCount || null, kind: 'audience', basis: 'live page' }] : [],
  };
}

// ---------- Wikidata: IMDb id -> Rotten Tomatoes id (open API) ----------
export async function fetchWikidataRtSlug(imdbId, { fetcher }) {
  if (!/^tt\d+$/.test(imdbId ?? '')) return null;
  const query = `SELECT ?rt WHERE { ?f wdt:P345 "${imdbId}" . ?f wdt:P1258 ?rt . }`;
  const res = await fetcher.get(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`, { api: true, accept: 'application/sparql-results+json' });
  if (res.status !== 'ok') return null;
  try {
    const values = JSON.parse(res.body).results.bindings.map((b) => b.rt.value);
    return values.find((v) => v.startsWith('m/'))?.slice(2) ?? null;
  } catch {
    return null;
  }
}

// ---------- Rotten Tomatoes movie page ----------
function extractObject(html, key) {
  const start = html.indexOf(`"${key}":{`);
  if (start === -1) return null;
  let i = html.indexOf('{', start);
  const begin = i;
  let depth = 0;
  let inStr = false;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(begin, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export function parseRottenTomatoes(html) {
  const critics = extractObject(html, 'criticsScore');
  const audience = extractObject(html, 'audienceScore');
  const year = /"releaseYear":"(\d{4})"/.exec(html)?.[1];
  const title = /<title>([^<|]*)\|/.exec(html)?.[1]?.trim();
  return {
    title,
    year: year ? Number(year) : null,
    critics: critics && critics.score ? { score: num(critics.score), count: num(critics.ratingCount) || null, sentiment: critics.sentiment ?? null, certified: !!critics.certified, liked: critics.likedCount ?? null, notLiked: critics.notLikedCount ?? null } : null,
    audience: audience && audience.score ? { score: num(audience.score), count: num(audience.bandedRatingCount) || null, sentiment: audience.sentiment ?? null, liked: audience.likedCount ?? null, notLiked: audience.notLikedCount ?? null } : null,
  };
}

export function rtSlugs(title, year) {
  const base = normTitle(title.replace(/['’]/g, '')).replace(/ /g, '_');
  return [...new Set([base, year ? `${base}_${year}` : null].filter(Boolean))];
}

const titleMatches = (pageTitle, movieTitle) => {
  const a = normTitle((pageTitle ?? '').replace(/\s*\(\d{4}\)\s*$/, ''));
  const b = normTitle(movieTitle);
  return a === b || (b.length >= 5 && a.includes(b)) || (a.length >= 5 && b.includes(a));
};

// Slugs from Wikidata are authoritative (matched by IMDb id). Guessed slugs must pass a title and year check,
// because the same slug can belong to a different film.
export async function fetchRottenTomatoes(movie, { fetcher, hints = {} }) {
  const candidates = [];
  const fromWikidata = await fetchWikidataRtSlug(hints.imdbId, { fetcher });
  if (fromWikidata) candidates.push({ slug: fromWikidata, trusted: true });
  for (const slug of rtSlugs(movie.title, movie.year)) if (slug !== fromWikidata) candidates.push({ slug, trusted: false });

  const tried = [];
  let noScore = null;
  for (const { slug, trusted } of candidates) {
    const url = `https://www.rottentomatoes.com/m/${slug}`;
    const res = await fetcher.get(url);
    tried.push(slug);
    if (res.status === 'blocked' || (res.status === 'error' && !res.http)) return { source: 'rottentomatoes', status: res.status, reason: res.reason, url };
    if (res.status !== 'ok') continue;
    const p = parseRottenTomatoes(res.body);
    if (!trusted) {
      if (!titleMatches(p.title, movie.title)) continue;
      if (movie.year && !p.year) continue;
    }
    if (p.year && movie.year && Math.abs(p.year - movie.year) > 1) continue;
    if (!p.critics && !p.audience) { noScore = { source: 'rottentomatoes', status: 'no-score', reason: 'page has no Tomatometer or Popcornmeter yet', url }; continue; }
    const ratings = [];
    if (p.critics) ratings.push({ source: 'rottentomatoes', value: p.critics.score / 10, votes: p.critics.count, kind: 'critic', basis: 'live page', detail: p.critics });
    if (p.audience) ratings.push({ source: 'rt-audience', value: p.audience.score / 10, votes: p.audience.count, kind: 'audience', basis: 'live page', detail: p.audience });
    return { source: 'rottentomatoes', status: 'ok', url, slug, viaWikidata: trusted, ratings, critics: p.critics, audience: p.audience };
  }
  return noScore ?? { source: 'rottentomatoes', status: 'not-found', reason: `no matching page (${tried.join(', ')})` };
}

// ---------- OMDb (IMDb, Metacritic, RT critics, runtime) ----------
export async function fetchOmdb(movie, { fetcher, env, hints = {} }) {
  const key = env.OMDB_API_KEY;
  if (!key) return { source: 'omdb', status: 'unavailable', reason: 'OMDB_API_KEY not set' };
  const q = new URLSearchParams({ apikey: key, ...(hints.imdbId ? { i: hints.imdbId } : { t: movie.title, ...(movie.year ? { y: String(movie.year) } : {}) }) });
  const res = await fetcher.get(`https://www.omdbapi.com/?${q}`, { api: true });
  if (res.status !== 'ok') return { source: 'omdb', status: res.status, reason: res.reason };
  let d;
  try { d = JSON.parse(res.body); } catch { return { source: 'omdb', status: 'error', reason: 'invalid JSON' }; }
  if (d.Response === 'False') return { source: 'omdb', status: 'not-found', reason: d.Error };
  const ratings = [];
  if (num(d.imdbRating) > 0) ratings.push({ source: 'imdb', value: num(d.imdbRating), votes: num(d.imdbVotes) || null, kind: 'audience', basis: 'OMDb' });
  for (const r of d.Ratings ?? []) {
    if (r.Source === 'Rotten Tomatoes') ratings.push({ source: 'rottentomatoes', value: num(r.Value) / 10, votes: null, kind: 'critic', basis: 'OMDb' });
    if (r.Source === 'Metacritic') ratings.push({ source: 'metacritic', value: num(r.Value.split('/')[0]) / 10, votes: null, kind: 'critic', basis: 'OMDb' });
  }
  const runtime = /(\d+)\s*min/.exec(d.Runtime ?? '')?.[1];
  return { source: 'omdb', status: 'ok', runtime: runtime ? Number(runtime) : null, ratings: ratings.filter((r) => r.value > 0), rated: d.Rated && d.Rated !== 'N/A' ? d.Rated : null };
}
