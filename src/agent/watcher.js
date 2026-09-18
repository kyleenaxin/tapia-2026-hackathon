import { buildProfile } from './profile.js';
import { buildFriendContext, filterReason, rankForUser } from './rank.js';
import { mostSimilar, similarity, sharedTraits } from './similarity.js';
import { HttpError } from '../store.js';

const card = (m) => ({ id: m.id, title: m.title, year: m.year, genres: m.genres, consensus: m.rating.consensus == null ? null : Number(m.rating.consensus.toFixed(1)) });

function describeAction(entry) {
  if (entry.status === 'watchlist') return 'added it to their watchlist';
  if (entry.verdict === 'liked') return 'watched and liked it';
  if (entry.verdict === 'disliked') return 'watched and disliked it';
  if (entry.verdict === 'meh') return 'watched it and was lukewarm';
  return 'watched it';
}

function diffLists(before, after) {
  const pos = (list) => new Map(list.map((r) => [r.movie.id, r.rank]));
  const b = pos(before);
  const a = pos(after);
  const rose = [];
  const fell = [];
  const added = [];
  const dropped = [];
  for (const r of after) {
    if (!b.has(r.movie.id)) added.push({ movie: card(r.movie), to: r.rank });
    else if (b.get(r.movie.id) > r.rank) rose.push({ movie: card(r.movie), from: b.get(r.movie.id), to: r.rank });
    else if (b.get(r.movie.id) < r.rank) fell.push({ movie: card(r.movie), from: b.get(r.movie.id), to: r.rank });
  }
  for (const r of before) if (!a.has(r.movie.id)) dropped.push({ movie: card(r.movie), from: r.rank });
  return { added, dropped, rose, fell };
}

const scoreOf = (scored, movieId) => {
  const s = scored.find((x) => x.movie.id === movieId);
  return s ? Number(s.score.toFixed(3)) : null;
};

const rankIn = (scored, movieId) => {
  const i = scored.findIndex((s) => s.movie.id === movieId);
  return i === -1 ? null : i + 1;
};

// Compares one newly added movie with a follower's history and decides whether they should watch it.
export function analyzeAddition({ viewerId, actor, movie, entry, before, after, store, catalog }) {
  const user = store.getUser(viewerId);
  const profile = buildProfile({ user, entries: store.entriesFor(viewerId), catalog, feedback: store.feedbackFor(viewerId) });
  const friendCtx = buildFriendContext({ viewerId, store, catalog }).find((f) => f.user.id === actor.id);

  const historyMatches = [...profile.seenIds]
    .map((id) => catalog.byId.get(id))
    .filter(Boolean)
    .map((m) => ({ m, s: similarity(movie, m) }))
    .sort((x, y) => y.s - x.s)
    .slice(0, 3)
    .map(({ m, s }) => {
      const e = store.entriesFor(viewerId).find((x) => x.movieId === m.id);
      const t = sharedTraits(movie, m);
      return { movie: card(m), similarity: Number(s.toFixed(2)), yourVerdict: e?.verdict ?? null, shares: [...t.genres, ...t.keywords.slice(0, 2)] };
    });

  const reject = filterReason(movie, user, profile);
  const rawRankBefore = rankIn(before.scored, movie.id);
  const rawRankAfter = rankIn(after.scored, movie.id);
  const total = after.scored.length;

  let action;
  let headline;
  let reasoning = [];
  let tradeoffs = [];
  const did = describeAction(entry);

  if (reject === 'already-seen') {
    const mine = store.entriesFor(viewerId).find((e) => e.movieId === movie.id);
    action = 'already-seen';
    headline = `You already watched ${movie.title}${mine?.verdict ? ` and ${mine.verdict === 'liked' ? 'liked' : mine.verdict === 'disliked' ? 'disliked' : 'were lukewarm on'} it` : ''}; ${actor.name} ${did}.`;
    if (mine?.verdict && entry.verdict) {
      reasoning.push(mine.verdict === entry.verdict ? `You and ${actor.name} agree on this one.` : `You and ${actor.name} disagree on this one, which is worth a conversation.`);
    }
  } else if (reject) {
    action = 'skip';
    const why = { 'avoided-genre': 'it is in a genre you asked to avoid', 'too-long': 'it is longer than your runtime limit', 'too-old': 'it is older than your era preference', 'rejected-by-you': 'you already rejected it', 'hard-no-term': "it matches one of your hard no's", 'content-flag': 'it has content you asked to avoid' }[reject];
    headline = `Skip ${movie.title}: ${actor.name} ${did}, but ${why}.`;
  } else {
    const item = after.scored.find((s) => s.movie.id === movie.id);
    // "Watch" means it would make your top 10; "maybe" means top 50. Both are capped relative to a small pool.
    const strong = rawRankAfter <= Math.min(10, Math.ceil(total / 3));
    const maybe = rawRankAfter <= Math.min(50, Math.ceil((total * 2) / 3));
    action = strong ? 'watch' : maybe ? 'maybe' : 'skip';
    const verdictWord = { watch: 'Watch it', maybe: 'Maybe', skip: 'Probably skip' }[action];
    headline = `${verdictWord}: ${actor.name} ${did}, and ${movie.title} ranks #${rawRankAfter} of ${total} for you${rawRankBefore ? ` (was #${rawRankBefore} before)` : ''}.`;
    reasoning = item.reasons.slice(0, 4).map((r) => r.text);
    tradeoffs = item.tradeoffs;
  }

  const seen = new Set([movie.id]);
  const pool = after.scored.slice(0, 80).map((s) => s.movie);
  const alsoConsider = action === 'skip' && reject
    ? []
    : mostSimilar(movie, pool, { limit: 3, exclude: seen }).map(({ movie: m, similarity: s }) => {
        const t = sharedTraits(movie, m);
        return {
          movie: card(m),
          similarity: Number(s.toFixed(2)),
          yourRank: rankIn(after.scored, m.id),
          why: `${t.genres.length ? `shares ${t.genres.join(', ')}` : 'similar tone'}${m.rating.consensus != null ? `; rated ${m.rating.consensus.toFixed(1)}/10` : ''}`,
        };
      });

  return {
    viewerId,
    actorId: actor.id,
    actorName: actor.name,
    movie: card(movie),
    actorAction: did,
    action,
    headline,
    reasoning,
    tradeoffs,
    trust: friendCtx ? { trust: Number(friendCtx.trust.toFixed(2)), overlap: friendCtx.overlap, agreement: friendCtx.agreement == null ? null : Number(friendCtx.agreement.toFixed(2)) } : null,
    closestInYourHistory: historyMatches,
    alsoConsider,
    movieRank: { before: rawRankBefore, after: rawRankAfter, of: total },
    movieScore: { before: scoreOf(before.scored, movie.id), after: scoreOf(after.scored, movie.id) },
    diff: diffLists(before.recommendations, after.recommendations),
    snapshots: {
      before: before.recommendations.map((r) => ({ rank: r.rank, ...card(r.movie) })),
      after: after.recommendations.map((r) => ({ rank: r.rank, ...card(r.movie) })),
    },
  };
}

// Adds a movie to someone's list and lets the agent react for every follower who is allowed to see it.
export function addMovieWithAgents({ store, catalog, actorId, movieId, status = 'watched', verdict = null }) {
  const movie = catalog.byId.get(movieId);
  if (!movie) throw new HttpError(404, `movie ${movieId} not found in catalog`);
  const actor = store.getUser(actorId);
  const normalizedVerdict = status === 'watched' ? verdict : null;
  const prev = store.entriesFor(actorId).find((e) => e.movieId === movieId);
  const changed = !prev || prev.status !== status || (prev.verdict ?? null) !== (normalizedVerdict ?? null);

  const followers = store.followersOf(actorId).filter((id) => store.canSee(id, actorId));
  const before = new Map(followers.map((id) => [id, rankForUser({ userId: id, store, catalog, limit: 10 })]));

  const { entry, created } = store.addEntry({ userId: actorId, movieId, status, verdict });
  if (!changed) return { entry, created, event: null };

  const analyses = {};
  for (const id of followers) {
    const after = rankForUser({ userId: id, store, catalog, limit: 10 });
    analyses[id] = analyzeAddition({ viewerId: id, actor, movie, entry, before: before.get(id), after, store, catalog });
  }
  const event = followers.length ? store.addEvent({ type: 'movie_added', actorId, movieId, status, verdict: normalizedVerdict, analyses }) : null;
  return { entry, created, event, analyses };
}
