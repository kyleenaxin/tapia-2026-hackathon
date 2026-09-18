import test from 'node:test';
import assert from 'node:assert/strict';
import { processPreferences, buildQuestions, applyAnswers, parseLetterboxdCsv, importLetterboxd, titleLines } from '../src/agent/intake.js';
import { mv, newStore } from './helpers.js';
import { catalogOf } from './fakeSources.js';

const withPop = (id, title, genres, year, popularity, extra = {}) => ({ ...mv(id, title, genres, { year, rating: [7.5, 20000], ...extra }), popularity, directors: [`Dir ${id}`] });

function world() {
  const catalog = catalogOf([
    withPop(1, 'Inception', ['Science Fiction', 'Thriller'], 2010, 90000),
    withPop(2, 'Heat', ['Crime', 'Thriller'], 1995, 50000),
    withPop(3, 'Heat', ['Crime'], 1986, 40000),
    withPop(4, 'Dune', ['Science Fiction'], 2021, 200000),
    withPop(5, 'Dune', ['Science Fiction'], 1984, 30000),
    withPop(6, 'Get Out', ['Horror', 'Thriller'], 2017, 80000),
    withPop(7, 'Paddington 2', ['Comedy', 'Family'], 2017, 60000),
    withPop(8, 'The Prestige', ['Mystery', 'Drama'], 2006, 70000),
  ]);
  const store = newStore();
  const user = store.createUser({ name: 'Tess' });
  return { catalog, store, user };
}
const run = (w, form) => processPreferences({ store: w.store, catalog: w.catalog, userId: w.user.id, form: { mood: 'cozy', maxRuntime: '', ...form } });
const entry = (w, id) => w.store.entriesFor(w.user.id).find((e) => e.movieId === id);

test('title lines split on newlines and semicolons and are capped', () => {
  assert.deepEqual(titleLines('Inception (2010)\n\nHeat; Get Out'), ['Inception (2010)', 'Heat', 'Get Out']);
  assert.equal(titleLines(Array.from({ length: 100 }, (_, i) => `t${i}`).join('\n')).length, 40);
  assert.deepEqual(titleLines(undefined), []);
});

test('preferences are saved: genres, mood, runtime, hard no genres, terms and content flags', () => {
  const w = world();
  run(w, { genres: ['Comedy', 'Family'], mood: 'cozy', maxRuntime: '120', hardNoGenres: ['Horror'], hardNoTerms: 'clown, zombie', avoidFlags: ['graphic-violence', 'made-up-flag'] });
  const p = w.store.getUser(w.user.id).prefs;
  assert.deepEqual(p.genres, ['Comedy', 'Family']);
  assert.equal(p.mood, 'cozy');
  assert.equal(p.maxRuntime, 120);
  assert.deepEqual(p.avoidGenres, ['Horror']);
  assert.deepEqual(p.hardNoTerms, ['clown', 'zombie']);
  assert.deepEqual(p.avoidFlags, ['graphic-violence'], 'unknown flags are dropped');
});

test('loved, disliked and watched lines become history with the right verdicts', () => {
  const w = world();
  const r = run(w, { genres: ['Comedy'], loved: 'Inception (2010)', disliked: 'Get Out', watched: 'Paddington 2' });
  assert.deepEqual(r.questions, []);
  assert.equal(entry(w, 1).verdict, 'liked');
  assert.equal(entry(w, 6).verdict, 'disliked');
  assert.equal(entry(w, 7).status, 'watched');
  assert.equal(entry(w, 7).verdict, null);
});

test('the same film in several lists resolves to the strongest opinion, and "watched" never downgrades one', () => {
  const w = world();
  run(w, { loved: 'Inception', disliked: 'Inception', watched: 'Inception' });
  assert.equal(entry(w, 1).verdict, 'liked');
  run(w, { watched: 'Inception' });
  assert.equal(entry(w, 1).verdict, 'liked', 'a later plain "watched" leaves the earlier verdict alone');
  assert.equal(w.store.entriesFor(w.user.id).filter((e) => e.movieId === 1).length, 1, 'no duplicates');
});

test('a clearly better-known match is assumed and noted; a real tie becomes a question', () => {
  const w = world();
  const r = run(w, { loved: 'Dune\nHeat' });
  assert.equal(entry(w, 4).verdict, 'liked', 'Dune 2021 is far better known');
  assert.ok(r.notes.some((n) => /Assumed Dune \(2021\)/.test(n)));
  assert.equal(entry(w, 2), undefined, 'Heat was not guessed');
  const heat = r.questions.find((q) => /Heat/.test(q.text));
  assert.ok(heat);
  assert.equal(heat.type, 'title');
  assert.deepEqual(heat.options.slice(0, 2).map((o) => o.value), [2, 3]);
  assert.equal(heat.options.at(-1).value, 'skip');
});

test('answering a title question adds that film; skipping adds nothing', () => {
  const w = world();
  const r = run(w, { loved: 'Heat' });
  applyAnswers({ store: w.store, catalog: w.catalog, userId: w.user.id, questions: r.questions, answers: { [r.questions[0].id]: 3 } });
  assert.equal(entry(w, 3).verdict, 'liked');
  const w2 = world();
  const r2 = run(w2, { loved: 'Heat' });
  applyAnswers({ store: w2.store, catalog: w2.catalog, userId: w2.user.id, questions: r2.questions, answers: { [r2.questions[0].id]: 'skip' } });
  assert.equal(w2.store.entriesFor(w2.user.id).length, 0);
});

test('a near-miss title asks "did you mean", and a hopeless one is only noted', () => {
  const w = world();
  const r = run(w, { genres: ['Comedy'], loved: 'Paddington\nZzzz Nothing Here' });
  assert.equal(r.questions.length, 1);
  assert.match(r.questions[0].text, /Did you mean/);
  assert.equal(r.questions[0].options[0].value, 7);
  assert.ok(r.notes.some((n) => /could not find "Zzzz Nothing Here"/.test(n)));
});

test('a loved film in a hard-no genre asks which should win, and "allow" lifts the hard no', () => {
  const w = world();
  const r = run(w, { loved: 'Get Out', hardNoGenres: ['Horror'] });
  const q = r.questions.find((x) => x.type === 'conflict');
  assert.ok(q);
  assert.match(q.text, /loved Get Out.*Horror/);
  applyAnswers({ store: w.store, catalog: w.catalog, userId: w.user.id, questions: r.questions, answers: { [q.id]: 'allow' } });
  assert.deepEqual(w.store.getUser(w.user.id).prefs.avoidGenres, []);
});

test('with no mood chosen the agent asks for one, and the answer sets it', () => {
  const w = world();
  const r = run(w, { mood: '', genres: ['Comedy'], loved: 'Inception\nPaddington 2' });
  const q = r.questions.find((x) => x.type === 'mood');
  assert.ok(q);
  applyAnswers({ store: w.store, catalog: w.catalog, userId: w.user.id, questions: r.questions, answers: { mood: 'thrilled' } });
  assert.equal(w.store.getUser(w.user.id).prefs.mood, 'thrilled');
});

test('a person with almost no signal is asked whether to play safe or try something new', () => {
  const w = world();
  const r = run(w, { mood: 'cozy' });
  const q = r.questions.find((x) => x.type === 'novelty');
  assert.ok(q);
  applyAnswers({ store: w.store, catalog: w.catalog, userId: w.user.id, questions: r.questions, answers: { novelty: 'new' } });
  assert.equal(w.store.getUser(w.user.id).prefs.novelty, 0.7);
});

test('never more than two questions; the rest are listed as skipped, and nothing is asked when nothing is unclear', () => {
  const w = world();
  const r = run(w, { mood: '', loved: 'Heat\nPaddington\nGet Out', hardNoGenres: ['Horror'] });
  assert.equal(r.questions.length, 2);
  assert.ok(r.notes.some((n) => /^I skipped asking/.test(n)));

  const clear = world();
  const ok = run(clear, { mood: 'cozy', genres: ['Comedy'], loved: 'Inception\nPaddington 2', maxRuntime: '120' });
  assert.deepEqual(ok.questions, []);
});

test('buildQuestions can be called directly for a stored user', () => {
  const w = world();
  const { asked } = buildQuestions({ store: w.store, catalog: w.catalog, userId: w.user.id, pending: [] });
  assert.ok(asked.length <= 2);
  assert.ok(asked.some((q) => q.type === 'mood'));
});

const RATINGS_CSV = 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Inception,2010,https://boxd.it/a,5\n2024-01-02,Get Out,2017,https://boxd.it/b,1.5\n2024-01-03,Paddington 2,2017,https://boxd.it/c,3\n2024-01-04,Unknown Indie,2001,https://boxd.it/d,4\n2024-01-05,The Prestige,2006,https://boxd.it/e,\n';

test('Letterboxd ratings.csv import maps stars to verdicts and reports what did not match', () => {
  const w = world();
  const r = importLetterboxd({ store: w.store, catalog: w.catalog, userId: w.user.id, csv: RATINGS_CSV });
  assert.deepEqual([r.rows, r.matched, r.unmatched], [5, 4, 1]);
  assert.equal(entry(w, 1).verdict, 'liked', '5 stars');
  assert.equal(entry(w, 6).verdict, 'disliked', '1.5 stars');
  assert.equal(entry(w, 7).verdict, 'meh', '3 stars');
  assert.equal(entry(w, 8).status, 'watched');
  assert.equal(entry(w, 8).verdict, null, 'unrated is watched with no opinion');
  assert.match(r.note, /Matched 4 of 5/);
});

test('Letterboxd import: year must agree, watchlist kind saves interest, junk and empty files are handled', () => {
  const w = world();
  const wrongYear = importLetterboxd({ store: w.store, catalog: w.catalog, userId: w.user.id, csv: 'Date,Name,Year,Letterboxd URI\n2024-01-01,Inception,1999,x\n' });
  assert.equal(wrongYear.matched, 0);
  const wl = importLetterboxd({ store: w.store, catalog: w.catalog, userId: w.user.id, csv: 'Date,Name,Year,Letterboxd URI\n2024-01-01,Inception,2010,x\n', kind: 'watchlist' });
  assert.equal(wl.matched, 1);
  assert.equal(entry(w, 1).status, 'watchlist');
  assert.equal(importLetterboxd({ store: w.store, catalog: w.catalog, userId: w.user.id, csv: '' }).rows, 0);
  assert.equal(importLetterboxd({ store: w.store, catalog: w.catalog, userId: w.user.id, csv: 'not,a,letterboxd\nfile,at,all\n' }).matched, 0);
  assert.deepEqual(parseLetterboxdCsv('Name,Year\n,\nX,2000\n').rows.map((r) => r.Name), ['X']);
});

test('the import runs as part of the preferences form and its summary is reported', () => {
  const w = world();
  const r = run(w, { importCsv: RATINGS_CSV, importKind: 'auto', genres: ['Comedy'], loved: 'Paddington 2' });
  assert.equal(r.importSummary.matched, 4);
  assert.ok(r.notes.some((n) => /Matched 4 of 5/.test(n)));
});
