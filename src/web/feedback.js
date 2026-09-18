import { HttpError, FEEDBACK_KINDS } from '../store.js';
import { addMovieWithAgents } from '../agent/watcher.js';

const REASONS = {
  'not-my-taste': 'not my taste',
  'wrong-mood': 'wrong mood',
  'too-long': 'too long',
  'seen-it': 'already seen it',
  other: 'something else',
};
const VERDICT_TEXT = { liked: 'and loved it', meh: 'and thought it was okay', disliked: 'and did not like it' };

// Turns one button press on a result card into stored feedback, and returns a plain-language note about what changes.
export function applyFeedback({ store, catalog, job, user, form }) {
  const movie = catalog.byId.get(form.movie);
  if (!movie) throw new HttpError(404, 'That film is not in the dataset.');
  const group = job.mode === 'group';
  const room = group ? store.getRoom(job.roomCode) : null;
  const action = form.action;

  let subject = user;
  if (group && (action === 'up' || action === 'down')) {
    const who = store.getUser(form.who ?? user.id);
    if (!room.memberIds.includes(who.id)) throw new HttpError(400, 'That person is not in this room.');
    if (who.id !== user.id && room.hostId !== user.id) throw new HttpError(403, 'Only the host can answer for someone else.');
    subject = who;
  }
  const context = group ? 'group' : 'solo';
  const reason = FEEDBACK_KINDS.includes(form.reason) ? form.reason : 'other';
  const t = movie.title;

  if (action === 'watched') {
    if (group) {
      for (const id of room.memberIds) store.addEntry({ userId: id, movieId: movie.id, status: 'watched' });
      return { banner: `You watched ${t} together. It is off the list for everyone in the room.`, notified: 0 };
    }
    const verdict = ['liked', 'meh', 'disliked'].includes(form.verdict) ? form.verdict : null;
    const r = addMovieWithAgents({ store, catalog, actorId: user.id, movieId: movie.id, status: 'watched', verdict });
    const n = Object.keys(r.analyses ?? {}).length;
    return { banner: `You marked ${t} as watched${verdict ? ` ${VERDICT_TEXT[verdict]}` : ''}. I will not suggest it again.${n ? ` ${n} roommate${n === 1 ? '' : 's'}' agent${n === 1 ? '' : 's'} noticed.` : ''}`, notified: n };
  }
  if (action === 'want' && !group) {
    store.addEntry({ userId: user.id, movieId: movie.id, status: 'watchlist' });
    return { banner: `Saved ${t} to your shelf as a film you want to watch. It counts as a mild sign of interest.`, notified: 0 };
  }
  if (action === 'up') {
    const watched = store.entriesFor(subject.id).some((e) => e.movieId === movie.id && e.status === 'watched');
    if (watched) store.setVerdict(subject.id, movie.id, 'liked');
    else store.addFeedback({ userId: subject.id, movieId: movie.id, kind: 'thumbs-up', context });
    return { banner: `${subject.id === user.id ? 'You gave' : `${subject.name} gave`} ${t} a thumbs up. I will look for more like it.`, notified: 0 };
  }
  if (action === 'down') {
    const watched = store.entriesFor(subject.id).some((e) => e.movieId === movie.id && e.status === 'watched');
    if (watched && !group) {
      store.setVerdict(subject.id, movie.id, 'disliked');
      return { banner: `You did not like ${t}. I will steer away from lookalikes.`, notified: 0 };
    }
    store.addFeedback({ userId: subject.id, movieId: movie.id, kind: reason, reason: REASONS[reason], context });
    const who = group ? `${subject.name} said no to` : 'You gave a thumbs down to';
    if (reason === 'seen-it') return { banner: `${who} ${t} because it was already seen. It is off the list, and I did not hold it against similar films.`, notified: 0 };
    return { banner: `${who} ${t} (${REASONS[reason]}). It is out${group ? ' for the whole room' : ''}, and films like it are down-ranked${group ? ` for ${subject.name}` : ''}. I keep your reason on your shelf and do not override it.`, notified: 0 };
  }
  throw new HttpError(400, 'Unknown action.');
}
