const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

// Similarity by genre, keyword and rating closeness, 0..1. Expects catalog movies
// (which carry genreSet, keywordSet and rating.consensus).
export function similarity(a, b) {
  const genre = jaccard(a.genreSet, b.genreSet);
  const keyword = jaccard(a.keywordSet, b.keywordSet);
  const ra = a.rating?.consensus;
  const rb = b.rating?.consensus;
  const closeness = ra != null && rb != null ? 1 - Math.min(1, Math.abs(ra - rb) / 4) : 0.5;
  return 0.5 * genre + 0.3 * keyword + 0.2 * closeness;
}

export function sharedTraits(a, b) {
  return {
    genres: a.genres.filter((g) => b.genreSet.has(g)),
    keywords: a.keywords.filter((k) => b.keywordSet.has(k)),
  };
}

export function mostSimilar(movie, pool, { limit = 3, exclude = new Set() } = {}) {
  const scored = [];
  for (const m of pool) {
    if (m.id === movie.id || exclude.has(m.id)) continue;
    scored.push({ movie: m, similarity: similarity(movie, m) });
  }
  scored.sort((x, y) => y.similarity - x.similarity);
  return scored.slice(0, limit);
}
