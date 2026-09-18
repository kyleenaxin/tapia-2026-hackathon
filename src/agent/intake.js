import { parseCsvObjects } from '../data/csv.js';
import { findByTitle, resolveTitle } from '../data/catalog.js';
import { MOODS, CONTENT_FLAGS } from './constraints.js';

const MAX_QUESTIONS = 2;
const MAX_IMPORT_ROWS = 6000;

export const titleLines = (text) => String(text ?? '').split(/[\n;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 40);
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// ---- Letterboxd export (ratings.csv, diary.csv, watched.csv or watchlist.csv) ----
export function parseLetterboxdCsv(text) {
  const rows = parseCsvObjects(text).slice(0, MAX_IMPORT_ROWS);
  const hasRating = rows.some((r) => r.Rating);
  return { rows: rows.filter((r) => r.Name), hasRating };
}

const verdictFromStars = (s) => {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n >= 4 ? 'liked' : n <= 2 ? 'disliked' : 'meh';
};

export function importLetterboxd({ store, catalog, userId, csv, kind = 'auto' }) {
  const { rows, hasRating } = parseLetterboxdCsv(csv);
  if (!rows.length) return { rows: 0, matched: 0, unmatched: 0, note: 'The file had no rows I could read. Letterboxd exports (ratings.csv, watched.csv, watchlist.csv) have Name and Year columns.' };
  let matched = 0;
  for (const r of rows) {
    const m = findByTitle(catalog, r.Name, Number(r.Year) || null);
    if (!m) continue;
    matched++;
    if (kind === 'watchlist') store.addEntry({ userId, movieId: m.id, status: 'watchlist' });
    else store.addEntry({ userId, movieId: m.id, status: 'watched', verdict: hasRating ? verdictFromStars(r.Rating) : null });
  }
  return {
    rows: rows.length,
    matched,
    unmatched: rows.length - matched,
    note: `Matched ${matched} of ${rows.length} films. The rest are not in the dataset, which only covers well-reviewed films with enough reviews.`,
  };
}

// ---- preferences form ----
export function processPreferences({ store, catalog, userId, form }) {
  const genres = asList(form.genres);
  const avoidGenres = asList(form.hardNoGenres);
  store.updateUser(userId, {
    prefs: {
      genres,
      avoidGenres,
      hardNoTerms: String(form.hardNoTerms ?? '').split(/[,\n]+/),
      avoidFlags: asList(form.avoidFlags).filter((f) => CONTENT_FLAGS[f]),
      mood: MOODS[form.mood] ? form.mood : null,
      maxRuntime: form.maxRuntime ? Number(form.maxRuntime) : null,
    },
  });

  const notes = [];
  const pending = [];
  const assigned = new Map(); // movieId -> verdict; loved beats disliked beats plain "watched"
  const rank = { liked: 3, disliked: 2, null: 1 };
  const assign = (movie, verdict) => {
    if (!assigned.has(movie.id) || rank[verdict] > rank[assigned.get(movie.id)]) assigned.set(movie.id, verdict);
  };

  for (const [list, verdict] of [['loved', 'liked'], ['disliked', 'disliked'], ['watched', null]]) {
    for (const line of titleLines(form[list])) {
      const r = resolveTitle(catalog, line);
      if (r.status === 'ok') {
        assign(r.movie, verdict);
        if (r.assumed) notes.push(r.assumed);
      } else if (r.status === 'ambiguous') pending.push({ type: 'ambiguous', list, verdict, input: line, options: r.options });
      else if (r.status === 'unmatched' && r.suggestions.length) pending.push({ type: 'suggest', list, verdict, input: line, options: r.suggestions });
      else if (r.status === 'unmatched') notes.push(`I could not find "${line}" in the dataset, so I left it out.`);
    }
  }
  const existing = new Map(store.entriesFor(userId).map((e) => [e.movieId, e]));
  for (const [movieId, verdict] of assigned) {
    if (verdict === null && existing.has(movieId)) continue; // never downgrade an opinion the person already gave
    store.addEntry({ userId, movieId, status: 'watched', verdict });
  }

  let importSummary = null;
  if (String(form.importCsv ?? '').trim()) {
    importSummary = importLetterboxd({ store, catalog, userId, csv: form.importCsv, kind: form.importKind ?? 'auto' });
    notes.push(importSummary.note);
  }

  const questions = buildQuestions({ store, catalog, userId, pending });
  return { questions: questions.asked, notes: [...notes, ...questions.skippedNotes], importSummary };
}

const movieLabel = (m) => `${m.title} (${m.year})${m.directors?.[0] ? `, dir. ${m.directors[0]}` : ''}`;

// The agent asks only what it cannot safely assume, at most two questions, most important first.
export function buildQuestions({ store, catalog, userId, pending = [] }) {
  const user = store.getUser(userId);
  const prefs = user.prefs;
  const entries = store.entriesFor(userId);
  const lovedMovies = entries.filter((e) => e.verdict === 'liked').map((e) => catalog.byId.get(e.movieId)).filter(Boolean);
  const all = [];

  pending.forEach((p, i) => {
    all.push({
      id: `t${i}`,
      type: 'title',
      list: p.list,
      verdict: p.verdict,
      input: p.input,
      text: p.type === 'ambiguous' ? `Which "${p.input}" did you mean?` : `I could not find "${p.input}" exactly. Did you mean one of these?`,
      why: p.type === 'ambiguous' ? 'More than one film has that title and I would rather not guess.' : 'A wrong match would skew your taste profile.',
      options: [...p.options.map((m) => ({ value: m.id, label: movieLabel(m) })), { value: 'skip', label: 'None of these, skip it' }],
    });
  });

  for (const g of prefs.avoidGenres) {
    const clash = lovedMovies.find((m) => m.genres.includes(g));
    if (clash) {
      all.push({
        id: `c-${g}`,
        type: 'conflict',
        genre: g,
        text: `You loved ${clash.title}, but you also listed ${g} as a hard no. Which should win?`,
        why: 'These two signals contradict each other.',
        options: [{ value: 'keep', label: `Keep ${g} as a hard no` }, { value: 'allow', label: `Allow ${g}, I made an exception` }],
      });
      break;
    }
  }

  if (!prefs.mood) {
    all.push({
      id: 'mood',
      type: 'mood',
      text: 'What are you in the mood for tonight?',
      why: 'Mood changes the answer more than genre does.',
      options: Object.entries(MOODS).map(([value, m]) => ({ value, label: m.label })),
    });
  }

  if (!prefs.genres.length && lovedMovies.length < 2) {
    all.push({
      id: 'novelty',
      type: 'novelty',
      text: 'With so little to go on, should I play it safe or try something new?',
      why: 'I do not know your taste yet.',
      options: [{ value: 'familiar', label: 'Play it safe: crowd favorites' }, { value: 'new', label: 'Surprise me' }],
    });
  }

  const asked = all.slice(0, MAX_QUESTIONS);
  const skippedNotes = all.slice(MAX_QUESTIONS).map((q) => `I skipped asking: "${q.text}"`);
  return { asked, skippedNotes };
}

export function applyAnswers({ store, catalog, userId, questions, answers }) {
  const notes = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    if (q.type === 'title' && a !== 'skip') {
      const m = catalog.byId.get(a);
      if (m) store.addEntry({ userId, movieId: m.id, status: 'watched', verdict: q.verdict });
    } else if (q.type === 'conflict' && a === 'allow') {
      const p = store.getUser(userId).prefs;
      store.updateUser(userId, { prefs: { avoidGenres: p.avoidGenres.filter((g) => g !== q.genre) } });
      notes.push(`Removed ${q.genre} from your hard no's.`);
    } else if (q.type === 'mood' && MOODS[a]) {
      store.updateUser(userId, { prefs: { mood: a } });
    } else if (q.type === 'novelty') {
      store.updateUser(userId, { prefs: { novelty: a === 'new' ? 0.7 : 0.1 } });
    }
  }
  return notes;
}
