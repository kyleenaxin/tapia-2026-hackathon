import { buildProfile, summarizeProfile } from './profile.js';
import { buildFriendContext, scoreAll, scoreMovie, weightsFor, diversify } from './rank.js';
import { rankForGroup } from './group.js';
import { similarity } from './similarity.js';
import { reviewSummary } from './reviewSummary.js';
import { sourceLabel } from './ratings.js';
import { withExtraRatings, publicMovie } from '../data/catalog.js';
import { notAFeature } from './constraints.js';

export const DEFAULT_BUDGET = { maxChecked: 12, batchSize: 4, maxMs: 45000, pool: 30 };

const ROLES = [
  { role: 'primary', label: 'Tonight\'s pick' },
  { role: 'backup', label: 'Backup one' },
  { role: 'backup', label: 'Backup two' },
];

const pct = (x) => `${Math.round(x * 100)}%`;

// ---------- tool: check live sources for a batch of movies ----------
async function checkSources(movies, { sources, trace, enrichment }) {
  trace.begin(`Checking Letterboxd and Rotten Tomatoes for ${movies.map((m) => m.title).join(', ')}`);
  await Promise.all(movies.map(async (movie) => {
    const letterboxd = await sources.letterboxd(movie);
    const hints = { imdbId: letterboxd.imdbId };
    const [rottentomatoes, omdb] = await Promise.all([sources.rottenTomatoes(movie, hints), sources.omdb(movie, hints)]);
    const ratings = [...(omdb.ratings ?? []), ...(letterboxd.ratings ?? []), ...(rottentomatoes.ratings ?? [])];
    const runtime = letterboxd.runtime ?? omdb.runtime ?? null;
    const status = { letterboxd, rottentomatoes, omdb };
    enrichment.set(movie.id, { ratings, runtime, status });
    const part = (name, r, detail) => `${name}: ${r.status === 'ok' ? `${detail}${r.cached ? ' (cached)' : ''}` : `${r.status}${r.reason ? ` (${r.reason})` : ''}`}`;
    const lb = letterboxd.ratings?.[0];
    const rtc = rottentomatoes.ratings?.find((x) => x.source === 'rottentomatoes');
    const rta = rottentomatoes.ratings?.find((x) => x.source === 'rt-audience');
    const anyOk = [letterboxd, rottentomatoes, omdb].some((r) => r.status === 'ok');
    trace.step('check_sources', { movie: movie.title }, [
      `${movie.title} (${movie.year})`,
      part('Letterboxd', letterboxd, `${lb ? `${lb.value.toFixed(1)}/10` : 'no rating'}${lb?.votes ? ` from ${lb.votes.toLocaleString('en-US')} ratings` : ''}${letterboxd.runtime ? `, ${letterboxd.runtime} min` : ''}`),
      part('Rotten Tomatoes', rottentomatoes, `${rtc ? `${pct(rtc.value / 10)} critics` : ''}${rtc && rta ? ' / ' : ''}${rta ? `${pct(rta.value / 10)} audience` : ''}`),
      part('OMDb', omdb, `${omdb.ratings?.map((r) => `${sourceLabel(r.source)} ${r.value}`).join(', ')}`),
    ].join(' | '), anyOk ? 'ok' : 'warn');
  }));
}

const applyEnrichment = (movie, enr) => (enr ? withExtraRatings(movie, enr.ratings, enr.runtime ? { runtime: enr.runtime } : {}) : movie);
const overRuntime = (movie, max) => !!(max && movie.runtime && movie.runtime > max) || !!notAFeature(movie);

// ---------- pick assembly ----------
function sourceSummary(enr) {
  if (!enr) return {};
  return Object.fromEntries(Object.entries(enr.status).map(([k, v]) => [k, { status: v.status, reason: v.reason ?? null, cached: !!v.cached, url: v.url ?? null }]));
}

function drawbacksFor(movie, item, { maxRuntime }) {
  const out = [...item.tradeoffs];
  if (maxRuntime && !movie.runtime) out.push(`I could not confirm the runtime, and you asked for ${maxRuntime} minutes or less. Check before you press play.`);
  else if (movie.runtime && movie.runtime >= 150 && !out.some((t) => /Long:/.test(t))) out.push(`Long: ${movie.runtime} min`);
  const critic = movie.rating.sources.find((s) => s.source === 'rottentomatoes');
  const audience = movie.rating.sources.find((s) => s.source === 'rt-audience') ?? movie.rating.sources.find((s) => s.source === 'letterboxd');
  if (critic && audience && critic.value - audience.value >= 1.5) out.push('Critics like it much more than audiences do, so it may feel slow or demanding.');
  if (critic && audience && audience.value - critic.value >= 1.5) out.push('Audiences like it much more than critics do, so it may be more crowd-pleasing than polished.');
  out.push('Streaming availability is not checked. Confirm where it is playing.');
  return [...new Set(out)];
}

function buildPick(item, index, { enrichment, primary, maxRuntime, extra = {} }) {
  const movie = item.movie;
  const enr = enrichment.get(movie.id);
  const sim = primary ? similarity(movie, primary) : null;
  return {
    ...ROLES[index],
    rank: index + 1,
    movie: publicMovie(movie),
    score: Number(item.score.toFixed(3)),
    confidence: item.confidence,
    reasons: item.reasons.slice(0, 5),
    drawbacks: drawbacksFor(movie, item, { maxRuntime }),
    ratings: { sources: movie.rating.sources, consensus: movie.rating.consensus, conflict: movie.rating.conflict, note: movie.rating.note, spread: movie.rating.spread },
    reviews: reviewSummary(movie),
    runtime: { minutes: movie.runtime, known: !!movie.runtime, limit: maxRuntime ?? null },
    sourceStatus: sourceSummary(enr),
    angle: sim == null ? null : sim >= 0.35 ? 'Similar vibe to the main pick' : 'A different flavor, in case you want a change',
    ...extra,
  };
}

function sourcesOverview(enrichment) {
  const tally = {};
  for (const enr of enrichment.values()) {
    for (const [name, r] of Object.entries(enr.status)) {
      tally[name] ??= {};
      tally[name][r.status] = (tally[name][r.status] ?? 0) + 1;
    }
  }
  return tally;
}

export function compareResults(previous, next) {
  if (!previous?.picks?.length) return null;
  const ids = (r) => r.picks.map((p) => p.movie.id);
  const prevIds = ids(previous);
  const nextIds = ids(next);
  const title = (r, id) => r.picks.find((p) => p.movie.id === id)?.movie.title;
  return {
    primaryChanged: prevIds[0] !== nextIds[0],
    primaryBefore: previous.picks[0].movie.title,
    primaryAfter: next.picks[0].movie.title,
    added: nextIds.filter((id) => !prevIds.includes(id)).map((id) => title(next, id)),
    removed: prevIds.filter((id) => !nextIds.includes(id)).map((id) => title(previous, id)),
    before: previous.picks.map((p) => p.movie.title),
    after: next.picks.map((p) => p.movie.title),
  };
}

// ---------- solo agent ----------
export async function runSoloAgent({ userId, store, catalog, sources, trace, previous = null, budget = DEFAULT_BUDGET, now = () => Date.now() }) {
  const started = now();
  const user = store.getUser(userId);
  const profile = buildProfile({ user, entries: store.entriesFor(userId), catalog, feedback: store.feedbackFor(userId) });
  const friends = buildFriendContext({ viewerId: userId, store, catalog });
  const summary = summarizeProfile(profile, user);
  trace.step('read_profile', {}, `${summary.watched} watched, ${summary.liked.length} loved, ${summary.disliked.length} disliked${summary.mood ? `, mood: ${summary.mood}` : ''}${summary.avoidGenres.length ? `, hard no genres: ${summary.avoidGenres.join(', ')}` : ''}${friends.length ? `; ${friends.length} roommate(s) share taste` : ''}`);

  const { scored, filtered } = scoreAll({ user, profile, friends, catalog });
  const removed = Object.entries(filtered).map(([k, v]) => `${v} ${k.replaceAll('-', ' ')}`).join(', ');
  trace.step('search_dataset', { dataset: catalog.provenance.base }, `${catalog.movies.length.toLocaleString('en-US')} films scanned; ${removed || 'none'} removed by your constraints; ${scored.length.toLocaleString('en-US')} still in play`);
  if (!scored.length) {
    trace.step('give_up', {}, 'Nothing survives your hard no\'s. Loosen one and try again.', 'warn');
    return { mode: 'solo', userId, profile: summary, picks: [], filtered, provenance: catalog.provenance, notes: ['Nothing survives your hard no\'s. Loosen one and try again.'], sources: {}, trace: trace.steps };
  }

  const pool = diversify(scored, budget.pool, { poolSize: 120 });
  trace.step('shortlist', { size: pool.length }, `Shortlisted ${pool.length} varied candidates by taste fit; the leaders are ${pool.slice(0, 3).map((p) => p.movie.title).join(', ')}`);

  const ctx = { user, profile, friends, weights: weightsFor(profile) };
  const enrichment = new Map();
  const attempted = new Set();
  const maxRuntime = user.prefs.maxRuntime;
  let survivors = pool;
  let dropped = [];

  const evaluate = () => {
    dropped = [];
    const next = [];
    for (const item of pool) {
      const m = applyEnrichment(item.movie, enrichment.get(item.movie.id));
      if (overRuntime(m, maxRuntime)) { dropped.push(m); continue; }
      next.push(enrichment.has(item.movie.id) ? scoreMovie(m, ctx) : item);
    }
    next.sort((a, b) => b.score - a.score);
    survivors = next;
    return diversify(survivors, 3, { lambda: 0.3, poolSize: 30 });
  };

  let final = evaluate();
  while (true) {
    const wanted = [...new Set([...final, ...survivors.slice(0, 3)].map((s) => s.movie))].filter((m) => !attempted.has(m.id));
    const overBudget = attempted.size >= budget.maxChecked || now() - started > budget.maxMs;
    if (!wanted.length || overBudget) {
      if (wanted.length) trace.step('budget', {}, `Stopped checking sources after ${attempted.size} films (${now() - started} ms). ${wanted.length} finalist(s) rely on dataset numbers only.`, 'warn');
      break;
    }
    const batch = wanted.slice(0, budget.batchSize);
    batch.forEach((m) => attempted.add(m.id));
    await checkSources(batch, { sources, trace, enrichment });
    const before = final.map((f) => f.movie.id).join();
    final = evaluate();
    if (dropped.length) trace.step('apply_runtime_limit', { maxRuntime }, `${dropped.map((m) => `${m.title} (${m.runtime} min)`).join(', ')} exceed${dropped.length === 1 ? 's' : ''} your ${maxRuntime}-minute limit and were dropped`);
    if (final.map((f) => f.movie.id).join() !== before) trace.step('rerank', {}, `New evidence changed the top picks: ${final.map((f) => f.movie.title).join(', ')}`);
  }

  const conflicts = final.filter((f) => f.movie.rating.conflict).map((f) => f.movie.title);
  trace.step('cross_check_ratings', {}, conflicts.length
    ? `Sources disagree on ${conflicts.join(', ')}; flagged in the drawbacks instead of averaged away`
    : `Ratings across ${[...new Set(final.flatMap((f) => f.movie.rating.sources.map((s) => sourceLabel(s.source))))].join(', ')} agree closely enough for the top picks`);

  const top = final.map((f) => f.movie);
  const picks = final.map((item, i) => buildPick(item, i, { enrichment, primary: i ? top[0] : null, maxRuntime }));
  trace.step('write_up', {}, `Summarized reviews and drawbacks for ${picks.map((p) => p.movie.title).join(', ')}`);

  const notes = [];
  if (profile.coldStart) notes.push('I know very little about your taste yet, so this leans on crowd ratings. Tell me what you loved and I will sharpen it.');
  if (picks.length < 3) notes.push(`Only ${picks.length} film${picks.length === 1 ? '' : 's'} survived your constraints.`);
  const result = { mode: 'solo', userId, profile: summary, weights: ctx.weights, picks, filtered, provenance: catalog.provenance, notes, sources: sourcesOverview(enrichment), checked: attempted.size, ms: now() - started, trace: trace.steps };
  result.changes = compareResults(previous, result);
  return result;
}

// ---------- group agent ----------
export async function runGroupAgent({ hostId, roomCode, store, catalog, sources, trace, previous = null, budget = DEFAULT_BUDGET, now = () => Date.now() }) {
  const started = now();
  const room = store.getRoom(roomCode);
  const g = rankForGroup({ hostId, participantIds: room.memberIds, setting: room.setting, store, catalog, limit: 12, trace });
  const enrichment = new Map();
  const attempted = new Set();
  const maxRuntime = g.constraints.maxRuntime;
  // Work on the full catalog movie (public copies drop the internal similarity sets).
  const cands = g.recommendations.map((c) => ({ ...c, full: catalog.byId.get(c.movie.id) }));

  let survivors = cands;
  const evaluate = () => {
    survivors = cands.filter((c) => !overRuntime(applyEnrichment(c.full, enrichment.get(c.full.id)), maxRuntime));
    return survivors.slice(0, 3);
  };
  let final = evaluate();
  while (true) {
    const wanted = [...final, ...survivors.slice(0, 3)].map((c) => c.full).filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i && !attempted.has(m.id));
    if (!wanted.length || attempted.size >= budget.maxChecked || now() - started > budget.maxMs) break;
    const batch = wanted.slice(0, budget.batchSize);
    batch.forEach((m) => attempted.add(m.id));
    await checkSources(batch, { sources, trace, enrichment });
    const before = cands.length - survivors.length;
    final = evaluate();
    const gone = cands.length - survivors.length - before;
    if (gone > 0) trace.step('apply_runtime_limit', { maxRuntime }, `${gone} candidate(s) exceed the group's ${maxRuntime}-minute limit and were dropped`);
  }

  const primaryMovie = final[0] ? applyEnrichment(final[0].full, enrichment.get(final[0].full.id)) : null;
  const picks = final.map((c, i) => {
    const movie = applyEnrichment(c.full, enrichment.get(c.full.id));
    const item = { movie, score: c.groupScore, confidence: c.confidence, reasons: c.reasons, tradeoffs: c.tradeoffs };
    return buildPick(item, i, {
      enrichment,
      primary: i ? primaryMovie : null,
      maxRuntime,
      extra: { groupLabel: c.label, favors: c.favors, perMember: c.perMember },
    });
  });
  trace.step('write_up', {}, `Prepared ${picks.length} group pick${picks.length === 1 ? '' : 's'} with per-person fit and drawbacks`);

  const result = {
    mode: 'group',
    roomCode,
    setting: g.setting,
    participants: g.participants,
    excluded: g.excluded,
    constraints: g.constraints,
    fairness: g.fairness,
    picks,
    filtered: g.filtered,
    provenance: catalog.provenance,
    notes: g.notes,
    sources: sourcesOverview(enrichment),
    checked: attempted.size,
    ms: now() - started,
    trace: trace.steps,
  };
  result.changes = compareResults(previous, result);
  return result;
}
