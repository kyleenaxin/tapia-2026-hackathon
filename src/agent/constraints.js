// Moods are soft nudges toward genres. Hard no's are filters, and content flags are a heuristic
// over synopsis, Letterboxd theme labels and review text (they can miss things, and the UI says so).

export const MOODS = {
  cozy: { label: 'Cozy and comforting', boost: ['Comedy', 'Family', 'Romance', 'Animation', 'Music'], dampen: ['Horror', 'War', 'Crime'] },
  thrilled: { label: 'On the edge of my seat', boost: ['Thriller', 'Mystery', 'Crime', 'Action'], dampen: ['Family', 'Music'] },
  laugh: { label: 'I want to laugh', boost: ['Comedy'], dampen: ['War', 'Horror', 'Drama'] },
  mindbend: { label: 'Something mind-bending', boost: ['Science Fiction', 'Mystery', 'Thriller'], dampen: ['Family'] },
  cry: { label: 'A good cry', boost: ['Drama', 'Romance', 'War', 'History'], dampen: ['Comedy', 'Action'] },
  scared: { label: 'Scare me', boost: ['Horror', 'Thriller', 'Mystery'], dampen: ['Family', 'Music', 'Romance'] },
  epic: { label: 'Something epic', boost: ['Adventure', 'Fantasy', 'History', 'War', 'Action', 'Science Fiction'], dampen: [] },
  inspired: { label: 'Inspired', boost: ['Drama', 'History', 'Music', 'Documentary'], dampen: ['Horror'] },
  surprise: { label: 'Surprise me', boost: [], dampen: [], novelty: 0.8 },
};

export const CONTENT_FLAGS = {
  'graphic-violence': { label: 'Graphic violence or gore', re: /\b(gore|gory|graphic violence|brutal|bloody|slasher|torture|massacre|cannibal)/i },
  scary: { label: 'Jump scares or terror', re: /\b(jump ?scares?|terrifying|terrified|scariest|haunting|nightmare fuel)/i },
  sexual: { label: 'Sexual content or nudity', re: /\b(sex scenes?|nudity|erotic|sexual content|explicit)/i },
  disturbing: { label: 'Disturbing or traumatic themes', re: /\b(disturbing|traumatic|harrowing|unsettling|abuse|assault)/i },
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function effectiveNovelty(prefs) {
  const mood = MOODS[prefs.mood];
  return mood?.novelty ?? prefs.novelty ?? 0.3;
}

// Where a flag shows up for a movie: theme labels, synopsis, and review text.
export function flagEvidence(movie, flag) {
  const def = CONTENT_FLAGS[flag];
  if (!def) return [];
  const hits = [];
  for (const t of movie.themes ?? []) if (def.re.test(t)) hits.push({ where: 'theme', text: t });
  if (def.re.test(movie.overview ?? '')) hits.push({ where: 'synopsis', text: movie.overview });
  for (const r of movie.reviews ?? []) if (def.re.test(r.text)) hits.push({ where: 'review', text: r.text });
  return hits;
}

// Returns why a movie breaks one of these prefs' hard no's, or null. `flagged` movies have a single weak hint only.
export function hardNoReason(movie, prefs) {
  const genre = movie.genres.find((g) => (prefs.avoidGenres ?? []).includes(g));
  if (genre) return { code: 'avoided-genre', detail: genre };
  for (const term of prefs.hardNoTerms ?? []) {
    const t = term.trim();
    if (t.length < 3) continue;
    const re = new RegExp(`\\b${esc(t)}`, 'i');
    if (re.test(movie.title) || re.test(movie.overview ?? '') || movie.themes?.some((x) => re.test(x))) return { code: 'hard-no-term', detail: t };
  }
  for (const flag of prefs.avoidFlags ?? []) {
    const hits = flagEvidence(movie, flag);
    if (hits.length >= 2) return { code: 'content-flag', detail: CONTENT_FLAGS[flag]?.label ?? flag };
  }
  return null;
}

// Single-hint content notes for movies that were not filtered, so the drawbacks section can mention them.
export function contentCautions(movie, prefs) {
  const out = [];
  for (const flag of prefs.avoidFlags ?? []) {
    const hits = flagEvidence(movie, flag);
    if (hits.length === 1) out.push(`One ${hits[0].where} mentions "${CONTENT_FLAGS[flag].label.toLowerCase()}", which you asked to avoid. Worth a quick check.`);
  }
  return out;
}
