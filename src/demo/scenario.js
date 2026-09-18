import { Store } from '../store.js';
import { findByTitle } from '../data/catalog.js';
import { createTrace } from '../agent/trace.js';
import { runSoloAgent, runGroupAgent, compareResults } from '../agent/agent.js';
import { addMovieWithAgents } from '../agent/watcher.js';
import { seedDemo } from './seed.js';
import { rankForUser } from '../agent/rank.js';
import { similarity } from '../agent/similarity.js';

const FRIEND_PICKS = ['Arrival', 'Ex Machina', 'Gravity', 'Blade Runner 2049', 'Her', 'Moon', 'The Prestige'];
export const ILLUSTRATIVE_REASON = 'Not the right mood for tonight; we watched something with the same feel last weekend.';

const subTrace = (trace, part) => createTrace({ onChange: () => {} }) && {
  steps: trace.steps,
  get current() { return trace.current; },
  begin: (l) => trace.begin(`${part}: ${l}`),
  step: (tool, input, summary, status) => trace.step(tool, input, summary, status),
};

// Sam could plausibly have watched many films. Try the likely ones and take the one that moves Alex's top 10 the most,
// so the before/after is visible. This is a staged demo: the choice is made by simulation, then the real agent path runs.
function chooseFriendPick({ store, catalog, ids, exclude = new Set() }) {
  const seen = new Set([...store.entriesFor(ids.alex), ...store.entriesFor(ids.sam), ...[...exclude].map((movieId) => ({ movieId }))].map((e) => e.movieId));
  const samLiked = store.entriesFor(ids.sam).filter((e) => e.verdict === 'liked').map((e) => catalog.byId.get(e.movieId)).filter(Boolean);
  const named = FRIEND_PICKS.map((t) => findByTitle(catalog, t)).filter((m) => m && !seen.has(m.id));
  const similar = catalog.movies
    .filter((m) => !seen.has(m.id) && m.popularity >= 20000 && !m.genres.includes('Horror') && !m.genres.includes('Documentary'))
    .map((m) => ({ m, s: samLiked.reduce((a, l) => a + similarity(m, l), 0) / Math.max(1, samLiked.length) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 14)
    .map((x) => x.m);
  const candidates = [...new Map([...named, ...similar].map((m) => [m.id, m])).values()];
  let best = null;
  for (const m of candidates) {
    store.addEntry({ userId: ids.sam, movieId: m.id, status: 'watched', verdict: 'liked' });
    const idx = rankForUser({ userId: ids.alex, store, catalog, limit: 10 }).recommendations.findIndex((r) => r.movie.id === m.id);
    store.removeEntry(ids.sam, m.id);
    if (idx !== -1 && (!best || idx < best.idx)) best = { m, idx };
  }
  return best?.m ?? candidates[0] ?? null;
}

// The three things to show judges, on a throwaway store so real data is never touched.
export async function runJudgeScenario({ catalog, sources, trace = createTrace() }) {
  const store = new Store();
  const { ids, roomCode, missing } = seedDemo(store, catalog);
  const people = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, { id, name: store.getUser(id).name }]));

  // 1. A recommendation with its reasoning
  trace.step('judge_part', {}, 'Part 1 of 3: a recommendation with its reasoning (solo mode, for Alex)');
  const solo = await runSoloAgent({ userId: ids.alex, store, catalog, sources, trace: subTrace(trace, 'Part 1') });

  // 2. What changed when a friend added a movie
  trace.step('judge_part', {}, 'Part 2 of 3: Sam, who is in Alex\'s screening room, adds a movie he loved');
  const pick = chooseFriendPick({ store, catalog, ids, exclude: new Set(solo.picks.map((p) => p.movie.id)) });
  let friend = null;
  if (pick) {
    const added = addMovieWithAgents({ store, catalog, actorId: ids.sam, movieId: pick.id, status: 'watched', verdict: 'liked' });
    const analysis = added.analyses?.[ids.alex] ?? null;
    trace.step('watcher_agent', {}, analysis ? `Alex's agent reacted: ${analysis.headline}` : 'No one was watching, so nothing to compare');
    const after = await runSoloAgent({ userId: ids.alex, store, catalog, sources, trace: subTrace(trace, 'Part 2'), previous: solo });
    friend = { movie: pick.title, addedBy: 'Sam', analysis, before: solo, after, changes: compareResults(solo, after) };
  }

  // 3. A recommendation a human disagreed with
  trace.step('judge_part', {}, 'Part 3 of 3: group mode for the room, and a member says no');
  const groupBefore = await runGroupAgent({ hostId: ids.alex, roomCode, store, catalog, sources, trace: subTrace(trace, 'Part 3') });
  let disagreement = null;
  const contested = groupBefore.picks[0];
  if (contested) {
    const fb = store.addFeedback({ userId: ids.maya, movieId: contested.movie.id, kind: 'wrong-mood', reason: ILLUSTRATIVE_REASON, context: 'group', seeded: true });
    const groupAfter = await runGroupAgent({ hostId: ids.alex, roomCode, store, catalog, sources, trace: subTrace(trace, 'Part 3 (after)'), previous: groupBefore });
    disagreement = {
      illustrative: true,
      note: 'This is a seeded example. Use Thumbs down on any real group result and it is recorded here the same way, with its reason.',
      contested: { title: contested.movie.title, label: contested.groupLabel, perMember: contested.perMember },
      by: 'Maya',
      feedback: fb,
      before: groupBefore,
      after: groupAfter,
      changes: compareResults(groupBefore, groupAfter),
      representation: 'The film is removed for the whole room, films like it are down-ranked for Maya, and her reason is kept on record. The agent does not argue or override.',
    };
  }

  trace.step('judge_done', {}, 'Walkthrough finished');
  return { people, missing, roomCode, solo, friend, disagreement, provenance: catalog.provenance };
}
