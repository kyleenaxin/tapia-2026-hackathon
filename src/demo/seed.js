import { findByTitle } from '../data/catalog.js';

// Illustrative demo people. Their histories are seeded sample data, not real users.
const PERSONAS = [
  {
    key: 'alex',
    name: 'Alex',
    sharing: 'friends',
    prefs: { genres: ['Science Fiction', 'Thriller'], avoidGenres: [], maxRuntime: null, minYear: null, novelty: 0.3 },
    watched: [['Inception', 'liked'], ['Interstellar', 'liked'], ['The Dark Knight', 'liked'], ['Parasite', 'liked'], ['Mad Max: Fury Road', 'liked'], ['Mamma Mia!', 'disliked'], ['Bridesmaids', 'meh']],
    follows: ['sam', 'maya', 'jordan'],
  },
  {
    key: 'sam',
    name: 'Sam',
    sharing: 'friends',
    prefs: { genres: ['Drama', 'Science Fiction'], avoidGenres: [], maxRuntime: null, minYear: null, novelty: 0.3 },
    watched: [['Interstellar', 'liked'], ['Inception', 'liked'], ['Whiplash', 'liked'], ['The Martian', 'liked'], ['Get Out', 'liked'], ['Toy Story', 'meh']],
    follows: ['alex'],
  },
  {
    key: 'maya',
    name: 'Maya',
    sharing: 'friends',
    prefs: { genres: ['Comedy', 'Animation', 'Family'], avoidGenres: ['Horror'], maxRuntime: 130, minYear: null, novelty: 0.4 },
    watched: [['Toy Story', 'liked'], ['Coco', 'liked'], ['Paddington 2', 'liked'], ['Bridesmaids', 'liked'], ['Spirited Away', 'liked'], ['Inception', 'meh']],
    follows: ['alex'],
  },
  {
    key: 'jordan',
    name: 'Jordan',
    sharing: 'private',
    prefs: { genres: ['Action'], avoidGenres: [], maxRuntime: null, minYear: null, novelty: 0.2 },
    watched: [['John Wick', 'liked'], ['Superbad', 'liked']],
    follows: [],
  },
];

export function seedDemo(store, catalog) {
  const existing = store.listUsers().filter((u) => u.demo);
  if (existing.length) return Object.fromEntries(existing.map((u) => [u.name.toLowerCase(), u.id]));
  const ids = {};
  for (const p of PERSONAS) ids[p.key] = store.createUser({ name: p.name, sharing: p.sharing, prefs: p.prefs, demo: true }).id;
  for (const p of PERSONAS) {
    for (const [title, verdict] of p.watched) {
      const m = findByTitle(catalog, title);
      if (m) store.addEntry({ userId: ids[p.key], movieId: m.id, status: 'watched', verdict });
    }
    for (const f of p.follows) store.follow(ids[p.key], ids[f]);
  }
  return ids;
}
