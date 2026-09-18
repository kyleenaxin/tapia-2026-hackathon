import { Store } from '../store.js';
import { findByTitle } from '../data/catalog.js';
import { createTrace } from '../agent/trace.js';
import { runSoloAgent, runGroupAgent, compareResults } from '../agent/agent.js';
import { addMovieWithAgents } from '../agent/watcher.js';
import { seedDemo } from './seed.js';

const FRIEND_PICKS = ['Arrival', 'Ex Machina', 'Gravity', 'Blade Runner 2049', 'Her', 'Moon', 'The Prestige'];
export const ILLUSTRATIVE_REASON = 'Not the right mood for tonight; we watched something with the same feel last weekend.';

const subTrace = (trace, part) => createTrace({ onChange: () => {} }) && {
  steps: trace.steps,
  get current() { return trace.current; },
  begin: (l) => trace.begin(`${part}: ${l}`),
  step: (tool, input, summary, status) => trace.step(tool, input, summary, status),
};

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
  const alexSeen = new Set(store.entriesFor(ids.alex).map((e) => e.movieId));
  const samSeen = new Set(store.entriesFor(ids.sam).map((e) => e.movieId));
  const pick = FRIEND_PICKS.map((t) => findByTitle(catalog, t)).find((m) => m && !alexSeen.has(m.id) && !samSeen.has(m.id));
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
