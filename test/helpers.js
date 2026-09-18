import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMovie, loadCatalog } from '../src/data/catalog.js';
import { Store } from '../src/store.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function mv(id, title, genres, { keywords = [], runtime = 100, year = 2010, rating = [7, 1000], overview = '', themes = [], reviews = [] } = {}) {
  return {
    id,
    title,
    year,
    runtime,
    genres,
    keywords,
    overview,
    themes,
    reviews,
    ratings: rating ? [{ source: 'tmdb', value: rating[0], votes: rating[1], kind: 'audience' }] : [],
  };
}

export function makeCatalog(list) {
  const movies = list.map(buildMovie);
  return {
    movies,
    byId: new Map(movies.map((m) => [m.id, m])),
    genres: [...new Set(movies.flatMap((m) => m.genres))],
    provenance: { base: 'test', ratingSources: ['tmdb'], movieCount: movies.length, notes: [], approximate: false },
  };
}

// Always the committed 1,500-film sample, so tests never depend on the large local index.
export const SAMPLE_FILE = path.join(ROOT, 'data', 'sample', 'letterboxd-sample.jsonl');
export const fixtureCatalog = () => loadCatalog({ sampleFile: SAMPLE_FILE });

export function newStore() {
  return new Store();
}

// Visibility is by screening room: everyone in a room can see each other and nobody else.
// Returns the room so a test can call store.leaveRoom(room.code, userId).
export function roomOf(store, host, ...others) {
  const room = store.createRoom({ hostId: host.id });
  for (const u of others) store.joinRoom(room.code, u.id);
  return room;
}

export function addWatched(store, userId, ids, verdict = 'liked') {
  for (const id of ids) store.addEntry({ userId, movieId: id, status: 'watched', verdict });
}
