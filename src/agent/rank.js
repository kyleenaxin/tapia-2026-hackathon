import { buildProfile, summarizeProfile } from './profile.js';
import { similarity, sharedTraits, mostSimilar } from './similarity.js';
import { crowdScore, ratingConfidence, votesOf } from './ratings.js';
import { publicMovie } from '../data/catalog.js';
import { hardNoReason, contentCautions, notAFeature } from './constraints.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// A rating from few people should pull less than one from millions: shrink toward neutral as evidence thins.
export const evidenceTrust = (votes) => clamp((Math.log10(Math.max(votes, 1)) - 1.5) / 4, 0.2, 1);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const evidenceVotes = (m) => m.rating.sources.reduce((s, r) => s + (votesOf(r) ?? 0), 0);
const realVotes = (m) => m.rating.sources.reduce((s, r) => s + (r.votes ?? 0), 0);

// As the user's history grows, personal taste outweighs what the crowd thinks.
export function weightsFor(profile) {
  const c = profile.confidence;
  return { taste: 0.15 + 0.45 * c, crowd: 0.5 - 0.3 * c, novelty: 0.1, friends: 0.12 };
}

// ---- friends the viewer is allowed to learn from ----
const VERDICT_SCORE = { liked: 1, meh: 0.5, disliked: 0 };

function agreement(viewerEntries, friendEntries) {
  const fBy = new Map(friendEntries.filter((e) => e.status === 'watched' && e.verdict).map((e) => [e.movieId, e]));
  let both = 0;
  let agree = 0;
  for (const v of viewerEntries) {
    if (v.status !== 'watched' || !v.verdict) continue;
    const f = fBy.get(v.movieId);
    if (!f) continue;
    both++;
    const a = VERDICT_SCORE[v.verdict];
    const b = VERDICT_SCORE[f.verdict];
    agree += 1 - Math.abs(a - b);
  }
  return { overlap: both, agreement: both ? agree / both : null };
}

export function buildFriendContext({ viewerId, store, catalog }) {
  const viewerEntries = store.entriesFor(viewerId);
  return store.visibleFriends(viewerId).map((f) => {
    const entries = store.entriesFor(f.id);
    const { overlap, agreement: agree } = agreement(viewerEntries, entries);
    const trust = overlap >= 2 ? 0.4 + 0.6 * agree : 0.5;
    return {
      user: f,
      byMovie: new Map(entries.map((e) => [e.movieId, e])),
      likedMovies: entries
        .filter((e) => e.status === 'watched' && e.verdict === 'liked')
        .map((e) => catalog.byId.get(e.movieId))
        .filter(Boolean),
      trust,
      overlap,
      agreement: agree,
    };
  });
}

// ---- hard filters ----
export function filterReason(movie, user, profile) {
  if (profile.seenIds.has(movie.id)) return 'already-seen';
  if (profile.rejectedIds.has(movie.id)) return 'rejected-by-you';
  if (notAFeature(movie)) return 'not-a-feature';
  const no = hardNoReason(movie, user.prefs);
  if (no) return no.code;
  if (user.prefs.maxRuntime && movie.runtime && movie.runtime > user.prefs.maxRuntime) return 'too-long';
  if (user.prefs.minYear && movie.year && movie.year < user.prefs.minYear) return 'too-old';
  return null;
}

// ---- signal components ----
function tasteComponent(movie, profile) {
  const known = movie.genres.filter((g) => profile.genreAffinity.has(g));
  const genrePart = known.length ? (mean(known.map((g) => profile.genreAffinity.get(g))) + 1) / 2 : 0.5;
  let value = genrePart;
  let nearest = null;
  let nearestSim = 0;
  if (profile.liked.length) {
    const sims = profile.liked.map((l) => ({ l, s: similarity(movie, l) })).sort((a, b) => b.s - a.s);
    nearest = sims[0].l;
    nearestSim = sims[0].s;
    const neighborPart = Math.min(1, mean(sims.slice(0, 3).map((x) => x.s)) / 0.6);
    value = 0.5 * genrePart + 0.5 * neighborPart;
  }
  if (profile.disliked.length) {
    const worst = Math.max(...profile.disliked.map((d) => similarity(movie, d)));
    value -= Math.max(0, worst - 0.4);
  }
  const topGenres = known
    .filter((g) => profile.genreAffinity.get(g) > 0.1)
    .sort((a, b) => profile.genreAffinity.get(b) - profile.genreAffinity.get(a))
    .slice(0, 2);
  return { value: clamp(value, 0, 1), nearest, nearestSim, topGenres };
}

function noveltyComponent(movie, profile) {
  const fresh = movie.genres.filter((g) => !profile.seenGenres.has(g));
  return { raw: movie.genres.length ? fresh.length / movie.genres.length : 0, genres: fresh };
}

function friendComponent(movie, friends) {
  let direct = 0;
  let neighbor = 0;
  const lines = [];
  for (const f of friends) {
    const e = f.byMovie.get(movie.id);
    if (e) {
      let s;
      let phrase;
      if (e.status === 'watchlist') { s = 0.4; phrase = 'has it on their watchlist'; }
      else if (e.verdict === 'liked') { s = 1; phrase = 'watched and liked it'; }
      else if (e.verdict === 'disliked') { s = -1; phrase = 'watched and disliked it'; }
      else if (e.verdict === 'meh') { s = 0; phrase = 'watched it and was lukewarm'; }
      else { s = 0.3; phrase = 'watched it'; }
      direct += s * f.trust;
      lines.push({ friend: f.user.name, text: `${f.user.name} ${phrase}${trustNote(f)}`, sign: Math.sign(s), strength: Math.abs(s) * f.trust });
    } else {
      let best = null;
      let bestSim = 0;
      for (const l of f.likedMovies) {
        const s = similarity(movie, l);
        if (s > bestSim) { bestSim = s; best = l; }
      }
      if (best && bestSim > 0.3) {
        const boost = f.trust * 0.6 * Math.min(1, (bestSim - 0.3) / 0.3);
        neighbor += boost;
        lines.push({ friend: f.user.name, text: `${f.user.name} liked ${best.title}, which is similar${trustNote(f)}`, sign: 1, strength: boost });
      }
    }
  }
  return { value: clamp(direct + neighbor, -1, 1), lines };
}

function trustNote(f) {
  return f.overlap >= 2 ? ` (your tastes match on ${Math.round(f.agreement * 100)}% of ${f.overlap} shared movies)` : '';
}

function feedbackComponent(movie, profile) {
  let worst = 0;
  let cause = null;
  for (const r of profile.rejected) {
    const s = similarity(movie, r.movie);
    if (s > worst) { worst = s; cause = r; }
  }
  const value = cause ? -0.25 * clamp((worst - 0.3) / 0.4, 0, 1) : 0;
  return { value, cause: value < 0 ? cause : null };
}

// ---- one movie, one person ----
export function scoreMovie(movie, ctx) {
  const { user, profile, friends = [] } = ctx;
  const w = ctx.weights ?? weightsFor(profile);
  const taste = tasteComponent(movie, profile);
  const crowd = 0.5 + (crowdScore(movie.rating.consensus) - 0.5) * evidenceTrust(evidenceVotes(movie));
  const nov = noveltyComponent(movie, profile);
  const novelty = nov.raw * profile.novelty;
  const fr = friendComponent(movie, friends);
  const fb = feedbackComponent(movie, profile);

  const mainW = w.taste + w.crowd;
  const base = (w.taste * taste.value + w.crowd * crowd) / mainW + w.novelty * novelty;
  const score = base + w.friends * fr.value + fb.value;

  const reasons = [];
  const tradeoffs = [];

  const stated = movie.genres.filter((g) => user.prefs.genres.includes(g));
  if (taste.nearest && taste.nearestSim >= 0.25) {
    const t = sharedTraits(movie, taste.nearest);
    const shared = [...t.genres, ...t.keywords.slice(0, 2)];
    reasons.push({ signal: 'taste', impact: (w.taste / mainW) * (taste.value - 0.5), text: `Similar to ${taste.nearest.title}, which you liked${shared.length ? ` (shares ${shared.join(', ')})` : ''}` });
  } else if (profile.watchedCount < 3 && stated.length) {
    reasons.push({ signal: 'taste', impact: (w.taste / mainW) * (taste.value - 0.5), text: `Matches genres you said you like: ${stated.join(', ')}` });
  } else if (taste.value >= 0.6 && taste.topGenres.length) {
    reasons.push({ signal: 'taste', impact: (w.taste / mainW) * (taste.value - 0.5), text: `Fits your taste in ${taste.topGenres.join(' / ')}` });
  } else if (taste.value <= 0.4) {
    reasons.push({ signal: 'taste', impact: (w.taste / mainW) * (taste.value - 0.5), text: 'Weak match with what you have watched and liked' });
  }

  if (profile.mood) {
    const fits = movie.genres.filter((g) => profile.mood.boost.includes(g));
    const clashes = movie.genres.filter((g) => profile.mood.dampen.includes(g));
    if (fits.length) reasons.push({ signal: 'mood', impact: 0.05 * fits.length, text: `Fits your mood (${profile.mood.short}): ${fits.join(', ')}` });
    if (clashes.length && !fits.length) tradeoffs.push(`Runs against your mood (${profile.mood.short}): ${clashes.join(', ')}`);
  }

  if (movie.rating.consensus != null) {
    const labels = movie.rating.sources.map((s) => `${s.label} ${s.value.toFixed(1)}`).join(', ');
    reasons.push({ signal: 'crowd', impact: (w.crowd / mainW) * (crowd - 0.5), text: `Crowd rating ${movie.rating.consensus.toFixed(1)}/10 (${labels}${realVotes(movie) ? `; ${realVotes(movie).toLocaleString('en-US')} ratings counted` : ''})` });
  } else {
    reasons.push({ signal: 'crowd', impact: 0, text: 'No rating data available, so the crowd signal is neutral' });
  }

  if (nov.genres.length && profile.novelty > 0) {
    reasons.push({ signal: 'novelty', impact: w.novelty * novelty, text: `Stretches into ${nov.genres.join(', ')}, which you have not watched yet` });
    tradeoffs.push(`Unfamiliar territory: ${nov.genres.join(', ')}`);
  }
  for (const l of fr.lines) {
    reasons.push({ signal: 'friends', impact: w.friends * l.sign * l.strength, text: l.text, friend: l.friend });
    if (l.sign < 0) tradeoffs.push(l.text);
  }
  if (fb.cause) {
    reasons.push({ signal: 'feedback', impact: fb.value, text: `Down-ranked: similar to ${fb.cause.movie.title}, which you disagreed with${fb.cause.reason ? ` ("${fb.cause.reason}")` : ''}` });
  }

  if (movie.rating.conflict) tradeoffs.push(movie.rating.note);
  else if (movie.rating.coverage === 0) tradeoffs.push('No rating data available');
  else if (movie.rating.coverage === 1 && evidenceVotes(movie) < 500) tradeoffs.push('Rating is based on very few votes');
  if (movie.runtime && movie.runtime >= 150) tradeoffs.push(`Long: ${movie.runtime} min`);
  if (taste.value < 0.45 && crowd >= 0.6) tradeoffs.push('Well rated by others, but a weak match with your own history');
  tradeoffs.push(...contentCautions(movie, user.prefs));
  if (profile.coldStart) tradeoffs.push('Little history so far, so this leans on crowd ratings');

  const evidence = 0.3 + 0.7 * profile.confidence;
  const confidence = clamp(0.5 * ratingConfidence(movie.rating) + 0.5 * evidence, 0.05, 0.95);

  reasons.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  return {
    movie,
    score,
    components: { taste: taste.value, crowd, novelty, friends: fr.value, feedback: fb.value },
    weights: w,
    reasons,
    tradeoffs,
    confidence: { value: Number(confidence.toFixed(2)), label: confidence >= 0.7 ? 'High' : confidence >= 0.45 ? 'Medium' : 'Low' },
  };
}

export function scoreAll({ user, profile, friends, catalog }) {
  const scored = [];
  const filtered = {};
  const ctx = { user, profile, friends, weights: weightsFor(profile) };
  for (const m of catalog.movies) {
    const why = filterReason(m, user, profile);
    if (why) { filtered[why] = (filtered[why] ?? 0) + 1; continue; }
    scored.push(scoreMovie(m, ctx));
  }
  scored.sort((a, b) => b.score - a.score || (b.movie.rating.consensus ?? 0) - (a.movie.rating.consensus ?? 0) || String(a.movie.id).localeCompare(String(b.movie.id)));
  return { scored, filtered };
}

// Greedy diversity re-rank so the list is not ten clones of the same movie.
export function diversify(scored, limit, { lambda = 0.3, poolSize = 60 } = {}) {
  const pool = scored.slice(0, poolSize);
  const picked = [];
  while (picked.length < limit && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const redundancy = picked.length ? Math.max(...picked.map((p) => similarity(c.movie, p.movie))) : 0;
      const v = c.score - lambda * redundancy;
      if (v > bestVal) { bestVal = v; bestIdx = i; }
    });
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked;
}

const tierFor = (rank) => (rank <= 3 ? 'Watch first' : rank <= 6 ? 'Up next' : 'If the mood strikes');

export function presentRecommendation(item, rank, { profile, scored, taken }) {
  const alternatives = mostSimilar(item.movie, scored.slice(0, 80).map((s) => s.movie), { limit: 2, exclude: taken })
    .map((a) => ({ movie: publicMovie(a.movie), similarity: Number(a.similarity.toFixed(2)) }));
  return {
    rank,
    tier: tierFor(rank),
    movie: publicMovie(item.movie),
    score: Number(item.score.toFixed(3)),
    confidence: item.confidence,
    components: Object.fromEntries(Object.entries(item.components).map(([k, v]) => [k, Number(v.toFixed(3))])),
    reasons: item.reasons,
    tradeoffs: item.tradeoffs,
    alternatives,
    onWatchlist: profile.watchlistIds.has(item.movie.id),
  };
}

// ---- solo mode ----
export function rankForUser({ userId, store, catalog, limit = 10, trace = null }) {
  const user = store.getUser(userId);
  const profile = buildProfile({ user, entries: store.entriesFor(userId), catalog, feedback: store.feedbackFor(userId) });
  const friends = buildFriendContext({ viewerId: userId, store, catalog });
  trace?.step('load_profile', { userId }, `${profile.watchedCount} watched, ${profile.liked.length} liked, ${friends.length} friend(s) sharing with you`);
  trace?.step('search_catalog', { source: catalog.provenance.base }, `${catalog.movies.length} candidate movies from ${catalog.provenance.base}`);

  const { scored, filtered } = scoreAll({ user, profile, friends, catalog });
  const filteredTotal = Object.values(filtered).reduce((a, b) => a + b, 0);
  trace?.step('apply_constraints', filtered, `${filteredTotal} removed (seen, avoided genres, runtime, era, rejected); ${scored.length} remain`);
  trace?.step('cross_reference_ratings', { sources: catalog.provenance.ratingSources }, `${catalog.provenance.ratingSources.join(' + ') || 'no'} rating source(s) reconciled per movie`);

  const picked = diversify(scored, limit);
  trace?.step('rank_and_diversify', { limit }, `top ${picked.length} chosen with a diversity penalty to avoid near-duplicates`);
  const taken = new Set(picked.map((p) => p.movie.id));
  const recommendations = picked.map((p, i) => presentRecommendation(p, i + 1, { profile, scored, taken }));

  const notes = [];
  if (profile.coldStart) notes.push('Very little history: recommendations lean on crowd ratings. Add movies you have seen to personalize.');
  if (friends.length) notes.push(`Friend signals used: ${friends.map((f) => f.user.name).join(', ')} (they share with followers).`);
  const result = {
    mode: 'solo',
    userId,
    profile: summarizeProfile(profile, user),
    weights: weightsFor(profile),
    filtered,
    recommendations,
    provenance: catalog.provenance,
    notes,
    trace: trace?.steps ?? [],
  };
  // Full scored list is for in-process callers (the watcher agent); keep it out of JSON responses.
  Object.defineProperty(result, 'scored', { value: scored, enumerable: false });
  return result;
}
