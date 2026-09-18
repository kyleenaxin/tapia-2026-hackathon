import { Store } from '../store.js';
import { findByTitle } from '../data/catalog.js';
import { rankForUser } from '../agent/rank.js';
import { rankForGroup } from '../agent/group.js';
import { addMovieWithAgents } from '../agent/watcher.js';
import { createTrace } from '../agent/trace.js';
import { seedDemo } from './seed.js';

const FRIEND_PICKS = ['Arrival', 'Ex Machina', 'Gravity', 'Blade Runner 2049', 'Her', 'The Prestige', 'Moon'];
const ILLUSTRATIVE_REASON = 'Not the right mood for tonight; we watched something with the same feel last weekend.';

// The three things to show judges, run on a throwaway in-memory store so real data is never touched.
export function runJudgeScenario({ catalog }) {
  const store = new Store();
  const ids = seedDemo(store, catalog);

  // 1. A recommendation with its reasoning
  const soloTrace = createTrace();
  const solo = rankForUser({ userId: ids.alex, store, catalog, limit: 5, trace: soloTrace });

  // 2. What changed when a friend added a movie
  const alexSeen = new Set(store.entriesFor(ids.alex).map((e) => e.movieId));
  const samSeen = new Set(store.entriesFor(ids.sam).map((e) => e.movieId));
  const pick = FRIEND_PICKS.map((t) => findByTitle(catalog, t)).find((m) => m && !alexSeen.has(m.id) && !samSeen.has(m.id));
  let friendAdded = null;
  if (pick) {
    const { analyses } = addMovieWithAgents({ store, catalog, actorId: ids.sam, movieId: pick.id, status: 'watched', verdict: 'liked' });
    friendAdded = analyses?.[ids.alex] ?? null;
  }

  // 3. A recommendation a human disagreed with, and how the ranking responded
  let disagreement = null;
  const groupParams = { hostId: ids.alex, participantIds: [ids.sam, ids.maya, ids.jordan], setting: 'in-person', store, catalog, limit: 5 };
  const groupBefore = rankForGroup({ ...groupParams, trace: createTrace() });
  const contested = groupBefore.recommendations[0];
  if (contested) {
    const fb = store.addFeedback({ userId: ids.maya, movieId: contested.movie.id, kind: 'wrong-mood', reason: ILLUSTRATIVE_REASON, context: 'group', seeded: true });
    const groupAfter = rankForGroup({ ...groupParams, trace: createTrace() });
    disagreement = {
      illustrative: true,
      note: 'Seeded example. Record your teammate\'s real disagreement through the app (Disagree button) to replace it.',
      contested: { movie: contested.movie, label: contested.label, perMember: contested.perMember },
      disagreedBy: 'Maya',
      feedback: fb,
      before: groupBefore.recommendations.map((r) => ({ rank: r.rank, title: r.movie.title, label: r.label })),
      after: groupAfter.recommendations.map((r) => ({ rank: r.rank, title: r.movie.title, label: r.label })),
      excluded: groupAfter.excluded,
      howItIsRepresented: 'Stored as feedback with the reason. The contested movie is vetoed for this group, and movies similar to it are down-ranked for the person who disagreed. The model never silently overrides it.',
    };
  }

  return {
    provenance: catalog.provenance,
    people: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, { id, name: store.getUser(id).name, sharing: store.getUser(id).sharing }])),
    recommendation: { forName: 'Alex', result: solo },
    friendAdded,
    disagreement,
  };
}
