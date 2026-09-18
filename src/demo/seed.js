import { findByTitle } from '../data/catalog.js';

// Illustrative demo people. Their taste is seeded sample data, not real users.
const PERSONAS = [
  {
    key: 'alex', name: 'Alex', inRoom: true,
    prefs: { genres: ['Science Fiction', 'Thriller'], mood: 'mindbend', maxRuntime: 150 },
    watched: [['Inception', 'liked'], ['Interstellar', 'liked'], ['The Dark Knight', 'liked'], ['Parasite', 'liked'], ['Mad Max: Fury Road', 'liked'], ['Mamma Mia!', 'disliked'], ['Bridesmaids', 'meh']],
  },
  {
    key: 'sam', name: 'Sam', inRoom: true,
    prefs: { genres: ['Drama', 'Science Fiction'] },
    watched: [['Interstellar', 'liked'], ['Inception', 'liked'], ['Whiplash', 'liked'], ['The Martian', 'liked'], ['Get Out', 'liked'], ['Toy Story', 'meh']],
  },
  {
    key: 'maya', name: 'Maya', inRoom: true,
    prefs: { genres: ['Comedy', 'Animation', 'Family'], avoidGenres: ['Horror'], mood: 'cozy', maxRuntime: 130 },
    watched: [['Toy Story', 'liked'], ['Coco', 'liked'], ['Paddington 2', 'liked'], ['Bridesmaids', 'liked'], ['Spirited Away', 'liked'], ['Inception', 'meh']],
  },
  {
    key: 'jordan', name: 'Jordan', inRoom: false,
    prefs: { genres: ['Action'] },
    watched: [['John Wick', 'liked'], ['Superbad', 'liked']],
  },
];

export function seedDemo(store, catalog) {
  const ids = {};
  const missing = [];
  for (const p of PERSONAS) ids[p.key] = store.createUser({ name: p.name, prefs: p.prefs, demo: true }).id;
  for (const p of PERSONAS) {
    for (const [title, verdict] of p.watched) {
      const m = findByTitle(catalog, title);
      if (m) store.addEntry({ userId: ids[p.key], movieId: m.id, status: 'watched', verdict });
      else missing.push(title);
    }
  }
  const room = store.createRoom({ hostId: ids.alex, name: 'Friday film club', setting: 'in-person' });
  for (const p of PERSONAS) if (p.inRoom && p.key !== 'alex') store.joinRoom(room.code, ids[p.key]);
  return { ids, roomCode: room.code, missing };
}
