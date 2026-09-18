import { MOODS, effectiveNovelty } from './constraints.js';

const VERDICT_WEIGHT = { liked: 1, meh: 0, disliked: -1 };
const UNSET_WEIGHT = 0.15; // watched, but no opinion recorded
const WATCHLIST_WEIGHT = 0.4; // wants to watch: mild interest
const THUMBS_UP_WEIGHT = 0.7; // thumbs up on a recommendation the user has not watched
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Turns stated preferences, watch history, mood and recorded feedback into a taste profile.
export function buildProfile({ user, entries, catalog, feedback = [] }) {
  const prefs = user.prefs;
  const seenIds = new Set();
  const watchlistIds = new Set();
  const liked = [];
  const disliked = [];
  const thumbsUpIds = new Set();
  const genreSum = new Map();
  const genreCount = new Map();
  const bump = (m, w) => {
    for (const g of m.genres) {
      genreSum.set(g, (genreSum.get(g) ?? 0) + w);
      genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
    }
  };

  for (const e of entries) {
    const m = catalog.byId.get(e.movieId);
    if (!m) continue;
    if (e.status === 'watchlist') { watchlistIds.add(m.id); bump(m, WATCHLIST_WEIGHT); continue; }
    seenIds.add(m.id);
    if (e.verdict === 'liked') liked.push(m);
    if (e.verdict === 'disliked') disliked.push(m);
    bump(m, e.verdict ? VERDICT_WEIGHT[e.verdict] : UNSET_WEIGHT);
  }

  const rejected = [];
  for (const f of feedback) {
    const m = catalog.byId.get(f.movieId);
    if (!m) continue;
    if (f.kind === 'seen-it') seenIds.add(m.id);
    else if (f.kind === 'thumbs-up') {
      if (!thumbsUpIds.has(m.id) && !seenIds.has(m.id)) { thumbsUpIds.add(m.id); liked.push(m); bump(m, THUMBS_UP_WEIGHT); }
    } else rejected.push({ movie: m, reason: f.reason, kind: f.kind });
  }
  for (const r of rejected) bump(r.movie, -0.5);

  const genreAffinity = new Map();
  for (const [g, sum] of genreSum) genreAffinity.set(g, sum / (genreCount.get(g) + 2));
  for (const g of prefs.genres ?? []) genreAffinity.set(g, clamp((genreAffinity.get(g) ?? 0) + 0.4, -1, 1));
  const mood = MOODS[prefs.mood] ?? null;
  if (mood) {
    for (const g of mood.boost) genreAffinity.set(g, clamp((genreAffinity.get(g) ?? 0) + 0.35, -1, 1));
    for (const g of mood.dampen) genreAffinity.set(g, clamp((genreAffinity.get(g) ?? 0) - 0.25, -1, 1));
  }

  const watchedCount = entries.filter((e) => e.status === 'watched' && catalog.byId.has(e.movieId)).length;
  const signal = watchedCount + thumbsUpIds.size + rejected.length;
  const confidence = clamp(signal / 10 + ((prefs.genres ?? []).length ? 0.25 : 0) + (mood ? 0.1 : 0), 0, 1);

  return {
    userId: user.id,
    seenIds,
    watchlistIds,
    liked,
    disliked,
    rejected,
    rejectedIds: new Set(rejected.map((r) => r.movie.id)),
    genreAffinity,
    seenGenres: new Set([...genreCount.keys()]),
    avoid: new Set(prefs.avoidGenres ?? []),
    mood: mood ? { key: prefs.mood, ...mood } : null,
    novelty: effectiveNovelty(prefs),
    watchedCount,
    confidence,
    coldStart: watchedCount + thumbsUpIds.size < 3,
  };
}

export function summarizeProfile(profile, user) {
  const top = [...profile.genreAffinity.entries()].sort((a, b) => b[1] - a[1]);
  const p = user.prefs;
  return {
    watched: profile.watchedCount,
    liked: profile.liked.map((m) => m.title),
    disliked: profile.disliked.map((m) => m.title),
    topGenres: top.filter(([, v]) => v > 0.1).slice(0, 4).map(([g]) => g),
    avoidGenres: [...profile.avoid],
    hardNoTerms: p.hardNoTerms ?? [],
    avoidFlags: p.avoidFlags ?? [],
    statedGenres: p.genres ?? [],
    mood: profile.mood?.label ?? null,
    maxRuntime: p.maxRuntime,
    minYear: p.minYear,
    novelty: Number(profile.novelty.toFixed(2)),
    confidence: Number(profile.confidence.toFixed(2)),
    coldStart: profile.coldStart,
  };
}
