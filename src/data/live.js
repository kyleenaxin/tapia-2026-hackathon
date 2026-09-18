// Optional live sources. Each call returns { status, ... } so callers can say exactly what was and was not queried.
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = (s) => Number(String(s ?? '').replace(/,/g, ''));

export function createLiveSources({ env = process.env, fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const tmdbKey = env.TMDB_API_KEY;
  const omdbKey = env.OMDB_API_KEY;
  const getJson = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  return {
    configured: { tmdb: !!tmdbKey, omdb: !!omdbKey },

    // IMDb, Rotten Tomatoes and Metacritic via OMDb.
    async omdbRatings(movie) {
      if (!omdbKey) return { status: 'unavailable', reason: 'OMDB_API_KEY not set', ratings: [] };
      try {
        const q = new URLSearchParams({ apikey: omdbKey, t: movie.title, ...(movie.year ? { y: String(movie.year) } : {}) });
        const d = await getJson(`https://www.omdbapi.com/?${q}`);
        if (d.Response === 'False') return { status: 'not-found', reason: d.Error ?? 'not found', ratings: [] };
        const ratings = [];
        if (num(d.imdbRating) > 0) ratings.push({ source: 'imdb', value: num(d.imdbRating), votes: num(d.imdbVotes) || null, kind: 'audience' });
        for (const r of d.Ratings ?? []) {
          if (r.Source === 'Rotten Tomatoes') ratings.push({ source: 'rottentomatoes', value: num(r.Value.replace('%', '')) / 10, votes: null, kind: 'critic' });
          if (r.Source === 'Metacritic') ratings.push({ source: 'metacritic', value: num(r.Value.split('/')[0]) / 10, votes: null, kind: 'critic' });
        }
        return { status: 'ok', ratings: ratings.filter((r) => r.value > 0) };
      } catch (e) {
        return { status: 'error', reason: e.message, ratings: [] };
      }
    },

    // Audience reviews from TMDB. Verifies the id really is this movie before trusting it.
    async tmdbReviews(movie) {
      if (!tmdbKey) return { status: 'unavailable', reason: 'TMDB_API_KEY not set', reviews: [] };
      try {
        const base = `https://api.themoviedb.org/3/movie/${movie.id}`;
        const details = await getJson(`${base}?api_key=${tmdbKey}`);
        if (norm(details.title ?? '') !== norm(movie.title)) {
          return { status: 'mismatch', reason: `TMDB id ${movie.id} is "${details.title}", not "${movie.title}"`, reviews: [] };
        }
        const d = await getJson(`${base}/reviews?api_key=${tmdbKey}`);
        const reviews = (d.results ?? []).map((r) => ({ author: r.author, content: r.content, rating: r.author_details?.rating ?? null }));
        return { status: 'ok', reviews };
      } catch (e) {
        return { status: 'error', reason: e.message, reviews: [] };
      }
    },
  };
}
