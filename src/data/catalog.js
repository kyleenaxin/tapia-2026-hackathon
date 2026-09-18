import fs from 'node:fs';
import path from 'node:path';
import { reconcile } from '../agent/ratings.js';

const norm = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
export const normTitle = norm;

const STOP = new Set(('about after again against because before being between could during first found from have into itself just more most much must never only other over same should since some still such than that their them then there these they this those through under until very want were what when where which while whose will with without would your years year life world story young man woman men women '
  + 'himself herself family friends friend find finds must turns takes becomes begins begin lives living leads leave leaves days night city town home house back away along around another everything something someone anyone begin their while after film movie').split(' '));

export function buildMovie(raw) {
  const genres = raw.genres ?? [];
  const keywords = raw.keywords ?? [];
  const ratings = (raw.ratings ?? []).filter((r) => r.value > 0);
  return {
    id: raw.id,
    slug: raw.slug ?? null,
    url: raw.url ?? null,
    title: raw.title,
    year: raw.year ?? null,
    runtime: raw.runtime ?? null,
    language: raw.language ?? null,
    overview: raw.overview ?? '',
    directors: raw.directors ?? [],
    cast: raw.cast ?? [],
    themes: raw.themes ?? [],
    reviews: raw.reviews ?? [],
    popularity: raw.popularity ?? 0,
    genres,
    keywords,
    genreSet: new Set(genres),
    keywordSet: new Set(keywords),
    ratings,
    rating: reconcile(ratings),
    sources: raw.sources ?? [],
  };
}

export function publicMovie(m) {
  const { genreSet, keywordSet, keywords, ...rest } = m;
  return rest;
}

export function withExtraRatings(movie, extra, patch = {}) {
  const bySource = new Map(movie.ratings.map((r) => [r.source, r]));
  for (const r of extra) bySource.set(r.source, r);
  const ratings = [...bySource.values()];
  return { ...movie, ...patch, ratings, rating: reconcile(ratings) };
}

const terms = (text) => [...new Set(norm(text).split(' ').filter((w) => w.length >= 5 && !STOP.has(w)))];

// Index records come from src/data/buildIndex.js. Synopsis terms shared by a few films become similarity keywords.
function fromIndex(records) {
  const tokens = records.map((r) => terms(r.syn));
  const df = new Map();
  for (const ts of tokens) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1);
  const ceiling = Math.max(30, records.length * 0.02);
  return records.map((r, i) => {
    const synTerms = tokens[i].filter((t) => df.get(t) >= 3 && df.get(t) <= ceiling).sort((a, b) => df.get(a) - df.get(b)).slice(0, 6);
    return buildMovie({
      id: r.s,
      slug: r.s,
      url: `https://letterboxd.com/film/${r.s}/`,
      title: r.t,
      year: r.y,
      overview: r.syn,
      directors: r.d,
      cast: r.c,
      themes: r.th,
      genres: r.g,
      keywords: [...r.d, ...r.c.slice(0, 3), ...r.th, ...synTerms],
      popularity: r.p,
      reviews: r.rv.map((x) => ({ user: x.u, text: x.t, likes: x.l })),
      ratings: [{ source: 'letterboxd', value: r.r * 2, votes: null, votesProxy: Math.max(20, r.p), kind: 'audience', basis: 'dataset snapshot' }],
      sources: ['letterboxd-hf'],
    });
  });
}

export function catalogFromMovies(movies, provenance = {}) {
  return {
    movies,
    byId: new Map(movies.map((m) => [m.id, m])),
    norms: movies.map((m) => norm(m.title)),
    genres: [...new Set(movies.flatMap((m) => m.genres))].sort(),
    provenance: { base: 'custom', movieCount: movies.length, ratingSources: ['letterboxd'], notes: [], approximate: false, ...provenance },
  };
}

export function loadCatalog({ indexFile, sampleFile } = {}) {
  const useIndex = indexFile && fs.existsSync(indexFile);
  const file = useIndex ? indexFile : sampleFile;
  if (!file || !fs.existsSync(file)) throw new Error('No movie data found. Expected data/letterboxd.index.jsonl or data/sample/letterboxd-sample.jsonl');
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const movies = fromIndex(records);
  return catalogFromMovies(movies, {
    base: useIndex ? 'letterboxd-hf-index' : 'letterboxd-hf-sample',
    file: path.basename(file),
    sample: !useIndex,
    notes: useIndex
      ? ['Films come from the Hugging Face Letterboxd dataset (pkchwy/letterboxd-all-movie-data), filtered to films with a rating, at least 5 reviews and meaningful review engagement.']
      : ['Using the 1,500-film sample of the Hugging Face Letterboxd dataset. Run "npm run build-data" for the full ~30,000-film index.'],
  });
}

// ---- lookup ----
export function searchCatalog(catalog, query, limit = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  const hits = [];
  catalog.norms.forEach((t, i) => {
    const idx = t.indexOf(q);
    if (idx === -1) return;
    hits.push({ m: catalog.movies[i], rank: t === q ? 0 : idx === 0 ? 1 : 2 });
  });
  hits.sort((a, b) => a.rank - b.rank || b.m.popularity - a.m.popularity);
  return hits.slice(0, limit).map((h) => h.m);
}

export function crowdFavorites(catalog, { limit = 12, exclude = new Set(), genre = null } = {}) {
  return catalog.movies
    .filter((m) => !exclude.has(m.id) && m.rating.consensus != null && (!genre || m.genres.includes(genre)))
    .sort((a, b) => b.popularity * b.rating.consensus - a.popularity * a.rating.consensus)
    .slice(0, limit);
}

export function findByTitle(catalog, title, year = null) {
  const t = norm(title);
  const hits = [];
  catalog.norms.forEach((n, i) => { if (n === t) hits.push(catalog.movies[i]); });
  const byYear = year ? hits.filter((m) => m.year && Math.abs(m.year - year) <= 1) : hits;
  return (byYear.length ? byYear : hits).sort((a, b) => b.popularity - a.popularity)[0] ?? null;
}

// Free text like "Dune (2021)" becomes a movie, an ambiguity, or a miss. The agent turns the last two into follow-up questions.
export function resolveTitle(catalog, text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { status: 'empty' };
  const m = /^(.*?)[\s]*\((\d{4})\)\s*$/.exec(raw);
  const title = (m ? m[1] : raw).trim();
  const year = m ? Number(m[2]) : null;
  const t = norm(title);
  if (t.length < 2) return { status: 'unmatched', input: raw, suggestions: [] };
  const exact = [];
  const partial = [];
  catalog.norms.forEach((n, i) => {
    if (n === t) exact.push(catalog.movies[i]);
    else if (n.startsWith(t) || n.includes(` ${t}`) || t.includes(n) && n.length >= 5) partial.push(catalog.movies[i]);
  });
  const byPop = (a, b) => b.popularity - a.popularity;
  if (exact.length) {
    const pool = year ? exact.filter((x) => x.year && Math.abs(x.year - year) <= 1) : exact;
    const list = (pool.length ? pool : exact).sort(byPop);
    if (list.length === 1 || year) return { status: 'ok', input: raw, movie: list[0] };
    if (list[0].popularity >= list[1].popularity * 3) return { status: 'ok', input: raw, movie: list[0], assumed: `Assumed ${list[0].title} (${list[0].year}), the far better-known match.` };
    return { status: 'ambiguous', input: raw, options: list.slice(0, 4) };
  }
  if (partial.length) {
    const list = partial.sort(byPop);
    return { status: 'unmatched', input: raw, suggestions: list.slice(0, 4) };
  }
  return { status: 'unmatched', input: raw, suggestions: [] };
}
