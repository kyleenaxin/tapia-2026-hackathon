import { buildProfile } from './profile.js';
import { scoreMovie, weightsFor } from './rank.js';
import { similarity, mostSimilar } from './similarity.js';
import { publicMovie } from '../data/catalog.js';
import { HttpError } from '../store.js';
import { hardNoReason, notAFeature } from './constraints.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pct = (x) => `${Math.round(x * 100)}%`;
const tierFor = (rank) => (rank <= 2 ? 'Best shared pick' : rank <= 5 ? 'Strong contender' : 'Worth a look');

export function resolveParticipants({ hostId, participantIds, store }) {
  const host = store.getUser(hostId);
  const members = [host];
  const excluded = [];
  for (const id of [...new Set(participantIds)]) {
    if (id === hostId) continue;
    const u = store.getUser(id);
    if (store.canSee(hostId, id)) members.push(u);
    else excluded.push({ userId: id, name: u.name, reason: 'has not joined your screening room, so their taste is not used' });
  }
  return { members, excluded };
}

// Group mode: pick something a whole group can watch together (in person or online).
export function rankForGroup({ hostId, participantIds = [], setting = 'in-person', store, catalog, limit = 8, trace = null }) {
  const { members: users, excluded } = resolveParticipants({ hostId, participantIds, store });
  if (users.length < 2) {
    const why = excluded.map((e) => `${e.name} ${e.reason}`).join('; ');
    throw new HttpError(422, `Group mode needs at least two people in the room.${why ? ` Left out: ${why}.` : ''}`);
  }
  trace?.step('check_consent', { participants: participantIds }, `${users.length} participant(s) included${excluded.length ? `; skipped ${excluded.map((e) => e.name).join(', ')} (not in the room)` : ''}`, excluded.length ? 'warn' : 'ok');

  const members = users.map((user) => {
    const profile = buildProfile({ user, entries: store.entriesFor(user.id), catalog, feedback: store.feedbackFor(user.id) });
    return { user, profile, weights: weightsFor(profile), vetoed: new Set(store.feedbackFor(user.id).filter((f) => f.context === 'group' && f.kind !== 'seen-it' && f.kind !== 'thumbs-up').map((f) => f.movieId)) };
  });
  trace?.step('load_profiles', {}, members.map((m) => `${m.user.name}: ${m.profile.watchedCount} watched`).join('; '));

  // Hard exclusions are constraints, never averaged away.
  const avoidBy = new Map();
  for (const m of members) for (const g of m.profile.avoid) avoidBy.set(g, [...(avoidBy.get(g) ?? []), m.user.name]);
  const termsBy = {};
  for (const m of members) if ((m.user.prefs.hardNoTerms ?? []).length || (m.user.prefs.avoidFlags ?? []).length) termsBy[m.user.name] = [...(m.user.prefs.hardNoTerms ?? []), ...(m.user.prefs.avoidFlags ?? [])];
  const runtimeCaps = members.map((m) => m.user.prefs.maxRuntime).filter(Boolean);
  const maxRuntime = runtimeCaps.length ? Math.min(...runtimeCaps) : null;
  const years = members.map((m) => m.user.prefs.minYear).filter(Boolean);
  const minYear = years.length ? Math.max(...years) : null;

  const filtered = {};
  const bump = (k) => { filtered[k] = (filtered[k] ?? 0) + 1; };
  const candidates = [];
  for (const movie of catalog.movies) {
    if (members.every((m) => m.profile.seenIds.has(movie.id))) { bump('seen-by-everyone'); continue; }
    if (members.some((m) => m.vetoed.has(movie.id))) { bump('vetoed-by-a-participant'); continue; }
    if (notAFeature(movie)) { bump('not-a-feature'); continue; }
    const blocked = members.map((m) => hardNoReason(movie, m.user.prefs)).find(Boolean);
    if (blocked) { bump(blocked.code); continue; }
    if (maxRuntime && movie.runtime && movie.runtime > maxRuntime) { bump('too-long'); continue; }
    if (minYear && movie.year && movie.year < minYear) { bump('too-old'); continue; }
    candidates.push(movie);
  }
  trace?.step('apply_group_constraints', { avoid: Object.fromEntries(avoidBy), maxRuntime, minYear }, `${Object.values(filtered).reduce((a, b) => a + b, 0)} removed; ${candidates.length} remain`);

  const scored = candidates.map((movie) => {
    const per = members.map((m) => {
      const s = scoreMovie(movie, { user: m.user, profile: m.profile, friends: [], weights: m.weights });
      return { m, s, fit: clamp(s.score, 0, 1) };
    });
    const fits = per.map((p) => p.fit);
    const mean = fits.reduce((a, b) => a + b, 0) / fits.length;
    const min = Math.min(...fits);
    const max = Math.max(...fits);
    const spread = max - min;
    const seen = per.filter((p) => p.m.profile.seenIds.has(movie.id));
    const groupScore = 0.45 * mean + 0.35 * min + 0.2 * (1 - spread) - 0.2 * (seen.length / per.length);
    return { movie, per, mean, min, max, spread, seen, groupScore };
  });
  scored.sort((a, b) => b.groupScore - a.groupScore || String(a.movie.id).localeCompare(String(b.movie.id)));
  trace?.step('score_group_fit', { formula: '0.45*mean + 0.35*min + 0.2*(1-spread) - rewatch penalty' }, `${scored.length} candidates scored per participant`);

  // Greedy pick with a diversity penalty and a fairness penalty so one person is not always the least happy.
  const pool = scored.slice(0, 60);
  const picked = [];
  const leastHappy = new Map(members.map((m) => [m.user.id, 0]));
  while (picked.length < limit && pool.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    pool.forEach((c, i) => {
      const lowest = c.per.reduce((a, b) => (b.fit < a.fit ? b : a));
      const redundancy = picked.length ? Math.max(...picked.map((p) => similarity(c.movie, p.movie))) : 0;
      const v = c.groupScore - 0.25 * redundancy - 0.04 * leastHappy.get(lowest.m.user.id);
      if (v > bestVal) { bestVal = v; bestIdx = i; }
    });
    const chosen = pool.splice(bestIdx, 1)[0];
    const lowest = chosen.per.reduce((a, b) => (b.fit < a.fit ? b : a));
    leastHappy.set(lowest.m.user.id, leastHappy.get(lowest.m.user.id) + 1);
    picked.push(chosen);
  }
  trace?.step('balance_fairness', {}, `picked ${picked.length}; least-happy counts: ${members.map((m) => `${m.user.name}=${leastHappy.get(m.user.id)}`).join(', ')}`);

  const taken = new Set(picked.map((p) => p.movie.id));
  const recommendations = picked.map((c, i) => presentGroupPick(c, i + 1, { scored, taken }));

  const fairness = members.map((m) => {
    const fits = picked.map((c) => c.per.find((p) => p.m.user.id === m.user.id).fit);
    return {
      userId: m.user.id,
      name: m.user.name,
      averageFit: Number((fits.reduce((a, b) => a + b, 0) / (fits.length || 1)).toFixed(2)),
      timesLeastHappy: leastHappy.get(m.user.id),
    };
  });

  const notes = [
    'Group mode balances hard exclusions, overlap, novelty and fairness. It is not an average of star ratings.',
    setting === 'online'
      ? 'Streaming availability is not checked (no availability source configured), so confirm the picks are on a service you all can use.'
      : 'Confirm availability before you commit: no streaming data source is configured.',
  ];
  if (excluded.length) notes.push(`Not included: ${excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}.`);

  return {
    mode: 'collaborators',
    setting,
    hostId,
    participants: members.map((m) => ({ userId: m.user.id, name: m.user.name, watched: m.profile.watchedCount })),
    excluded,
    constraints: {
      avoidedGenres: Object.fromEntries(avoidBy),
      otherHardNos: termsBy,
      maxRuntime,
      minYear,
    },
    filtered,
    recommendations,
    fairness,
    provenance: catalog.provenance,
    notes,
    trace: trace?.steps ?? [],
  };
}

function presentGroupPick(c, rank, { scored, taken }) {
  const { movie, per } = c;
  const lowest = per.reduce((a, b) => (b.fit < a.fit ? b : a));
  const highest = per.reduce((a, b) => (b.fit > a.fit ? b : a));
  let label = 'Balanced';
  if (c.min >= 0.55 && c.spread <= 0.2) label = 'Consensus';
  else if (c.min < 0.45) label = 'Compromise';

  const reasons = [];
  if (label === 'Consensus') reasons.push({ signal: 'group', text: `Everyone lands within ${pct(c.spread)} of each other and nobody is below ${pct(c.min)}` });
  else if (label === 'Compromise') reasons.push({ signal: 'group', text: `Compromise: ${lowest.m.user.name} is the least enthusiastic (${pct(lowest.fit)}), while ${highest.m.user.name} is highest (${pct(highest.fit)})` });
  else reasons.push({ signal: 'group', text: `Solid fit for the group: average ${pct(c.mean)}, lowest ${pct(c.min)}` });
  for (const p of per) {
    const top = p.s.reasons.find((r) => r.signal !== 'crowd') ?? p.s.reasons[0];
    reasons.push({ signal: 'member', text: `${p.m.user.name} (${pct(p.fit)}): ${top?.text ?? 'no strong signal'}` });
  }

  const tradeoffs = [];
  if (movie.rating.conflict) tradeoffs.push(movie.rating.note);
  if (movie.rating.coverage === 0) tradeoffs.push('No rating data available');
  if (movie.runtime && movie.runtime >= 150) tradeoffs.push(`Long: ${movie.runtime} min`);
  for (const p of c.seen) {
    const e = p.m.profile.liked.some((l) => l.id === movie.id) ? 'has seen it and liked it (rewatch)' : 'has already seen it';
    tradeoffs.push(`${p.m.user.name} ${e}`);
  }
  if (label === 'Compromise') tradeoffs.push(`${lowest.m.user.name} may need convincing`);

  const conf = Math.min(...per.map((p) => p.s.confidence.value));
  const alternatives = mostSimilar(movie, scored.slice(0, 80).map((s) => s.movie), { limit: 2, exclude: taken })
    .map((a) => ({ movie: publicMovie(a.movie), similarity: Number(a.similarity.toFixed(2)) }));

  return {
    rank,
    tier: tierFor(rank),
    movie: publicMovie(movie),
    label,
    favors: c.spread > 0.2 ? highest.m.user.name : null,
    groupScore: Number(c.groupScore.toFixed(3)),
    perMember: per.map((p) => ({
      userId: p.m.user.id,
      name: p.m.user.name,
      fit: Number(p.fit.toFixed(2)),
      seen: p.m.profile.seenIds.has(movie.id),
    })),
    confidence: { value: Number(conf.toFixed(2)), label: conf >= 0.7 ? 'High' : conf >= 0.45 ? 'Medium' : 'Low' },
    reasons,
    tradeoffs,
    alternatives,
  };
}
