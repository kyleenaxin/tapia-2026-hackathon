// Ratings are evidence, not truth: every source is normalized to /10, shrunk toward the
// global mean by vote count, and conflicts between sources are surfaced instead of averaged away.

export const GLOBAL_MEAN = 6.3;
export const CONFLICT_SPREAD = 1.5;

const SOURCE_LABELS = {
  letterboxd: 'Letterboxd',
  imdb: 'IMDb',
  rottentomatoes: 'Rotten Tomatoes critics',
  'rt-audience': 'Rotten Tomatoes audience',
  metacritic: 'Metacritic',
  tmdb: 'TMDB',
};

// Vote weight for a rating: real count when known, else an estimate from review engagement, else a modest default.
export const votesOf = (r) => r.votes ?? r.votesProxy ?? null;

export function sourceLabel(source) {
  return SOURCE_LABELS[source] ?? source;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function reconcile(ratings = []) {
  const usable = ratings.filter((r) => Number.isFinite(r.value) && r.value > 0);
  if (usable.length === 0) {
    return { consensus: null, spread: 0, conflict: false, coverage: 0, sources: [], note: 'No rating data available.' };
  }
  let weightSum = 0;
  let total = 0;
  for (const r of usable) {
    const votes = votesOf(r) ?? 100;
    const shrunk = (votes * r.value + 50 * GLOBAL_MEAN) / (votes + 50);
    const weight = Math.sqrt(Math.min(votes, 5000));
    total += shrunk * weight;
    weightSum += weight;
  }
  const values = usable.map((r) => r.value);
  const spread = Math.max(...values) - Math.min(...values);
  const conflict = usable.length >= 2 && spread >= CONFLICT_SPREAD;
  const critic = usable.filter((r) => r.kind === 'critic');
  const audience = usable.filter((r) => r.kind !== 'critic');
  let note = '';
  if (conflict) {
    const hi = usable.reduce((a, b) => (b.value > a.value ? b : a));
    const lo = usable.reduce((a, b) => (b.value < a.value ? b : a));
    note = `Sources disagree: ${sourceLabel(hi.source)} ${hi.value.toFixed(1)} vs ${sourceLabel(lo.source)} ${lo.value.toFixed(1)}.`;
  } else if (usable.length === 1) {
    note = `Only one rating source (${sourceLabel(usable[0].source)}).`;
  }
  return {
    consensus: total / weightSum,
    spread,
    conflict,
    coverage: usable.length,
    sources: usable.map((r) => ({ ...r, label: sourceLabel(r.source) })),
    hasCritic: critic.length > 0,
    hasAudience: audience.length > 0,
    note,
  };
}

// Maps a /10 consensus to 0..1. Below 5 is "avoid", 9+ is "everyone loves it".
export function crowdScore(consensus) {
  if (consensus == null) return 0.5;
  return clamp((consensus - 5) / 4, 0, 1);
}

// How much we trust the rating evidence itself, 0..1.
export function ratingConfidence(rating) {
  if (!rating || rating.coverage === 0) return 0.2;
  const maxVotes = Math.max(...rating.sources.map((s) => votesOf(s) ?? 0));
  let c = rating.coverage >= 2 ? 0.85 : maxVotes >= 500 ? 0.6 : 0.4;
  if (rating.conflict) c -= 0.15;
  return clamp(c, 0.1, 0.95);
}
