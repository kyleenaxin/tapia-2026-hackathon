import test from 'node:test';
import assert from 'node:assert/strict';
import { MOODS, CONTENT_FLAGS, effectiveNovelty, flagEvidence, hardNoReason, contentCautions } from '../src/agent/constraints.js';
import { CANON_GENRES } from '../src/data/buildIndex.js';
import { buildMovie } from '../src/data/catalog.js';

// Synthetic movies and review text for the heuristics, not real reviews.
const movie = (over = {}) => buildMovie({ id: 'm', title: 'Quiet Harbor', genres: ['Drama'], overview: 'A fisherman returns home.', themes: [], reviews: [], ...over });
const rev = (text) => ({ user: 'u', text, likes: 1 });

test('MOODS: every mood is well formed and only names canonical genres', () => {
  for (const [key, m] of Object.entries(MOODS)) {
    assert.ok(m.label, `${key} has a label`);
    assert.ok(Array.isArray(m.boost) && Array.isArray(m.dampen), `${key} has boost and dampen lists`);
    for (const g of [...m.boost, ...m.dampen]) assert.ok(CANON_GENRES.has(g), `${key}: "${g}" is a real genre`);
    assert.ok(!m.boost.some((g) => m.dampen.includes(g)), `${key} does not boost and dampen the same genre`);
  }
});

test('MOODS: "surprise me" is the one mood that raises novelty instead of steering genres', () => {
  assert.equal(MOODS.surprise.novelty, 0.8);
  assert.deepEqual(MOODS.surprise.boost, []);
  assert.equal(Object.values(MOODS).filter((m) => m.novelty != null).length, 1);
});

test('effectiveNovelty: mood beats prefs, prefs beat the default, unknown moods are ignored', () => {
  assert.equal(effectiveNovelty({ mood: 'surprise', novelty: 0.1 }), 0.8);
  assert.equal(effectiveNovelty({ mood: 'cozy', novelty: 0.6 }), 0.6, 'a mood without novelty defers to the preference');
  assert.equal(effectiveNovelty({ novelty: 0 }), 0, 'zero is a real answer, not "unset"');
  assert.equal(effectiveNovelty({}), 0.3);
  assert.equal(effectiveNovelty({ mood: 'not-a-mood' }), 0.3);
});

test('hardNoReason: nothing is filtered when there are no hard no\'s', () => {
  assert.equal(hardNoReason(movie(), {}), null);
  assert.equal(hardNoReason(movie(), { avoidGenres: [], hardNoTerms: [], avoidFlags: [] }), null);
});

test('hardNoReason: an avoided genre filters the film and names the genre', () => {
  const m = movie({ genres: ['Drama', 'Horror'] });
  assert.deepEqual(hardNoReason(m, { avoidGenres: ['Comedy', 'Horror'] }), { code: 'avoided-genre', detail: 'Horror' });
  assert.equal(hardNoReason(m, { avoidGenres: ['Comedy'] }), null);
});

test('hardNoReason: hard-no terms match title, synopsis or theme at a word start, case-insensitively', () => {
  const prefs = (term) => ({ hardNoTerms: [term] });
  assert.equal(hardNoReason(movie({ title: 'The Clown House' }), prefs('clown')).code, 'hard-no-term');
  assert.equal(hardNoReason(movie({ overview: 'A Spider crawls out.' }), prefs('spider')).detail, 'spider');
  assert.equal(hardNoReason(movie({ themes: ['Dark humor about clowns'] }), prefs('clown')).code, 'hard-no-term', 'clown matches clowns at a word start');
  assert.equal(hardNoReason(movie({ overview: 'An unclownlike man.' }), prefs('clown')), null, 'mid-word matches do not count');
});

test('hardNoReason: terms shorter than three characters are ignored and regex characters are literal', () => {
  assert.equal(hardNoReason(movie({ title: 'It' }), { hardNoTerms: ['it'] }), null, 'two-letter terms would filter far too much');
  assert.equal(hardNoReason(movie({ title: 'Anything' }), { hardNoTerms: ['  a '] }), null, 'trimmed before the length check');
  assert.doesNotThrow(() => hardNoReason(movie(), { hardNoTerms: ['(unclosed', 'a.+b', '[x'] }));
  assert.equal(hardNoReason(movie({ overview: 'Filmed in the year zero.' }), { hardNoTerms: ['.*'] }), null, 'a wildcard is not a wildcard');
  assert.equal(hardNoReason(movie({ title: 'C++ and Me' }), { hardNoTerms: ['c++'] })?.code, 'hard-no-term');
});

test('flagEvidence: reports where each hit came from and ignores unknown flags', () => {
  const m = movie({
    themes: ['Gory and grisly'],
    overview: 'A brutal winter.',
    reviews: [rev('There is so much gore here.'), rev('Gentle and warm.')],
  });
  const hits = flagEvidence(m, 'graphic-violence');
  assert.deepEqual(hits.map((h) => h.where), ['theme', 'synopsis', 'review']);
  assert.deepEqual(flagEvidence(m, 'made-up-flag'), []);
  assert.deepEqual(flagEvidence(movie(), 'graphic-violence'), []);
});

test('hardNoReason: a content flag needs two independent hits before it filters', () => {
  const prefs = { avoidFlags: ['graphic-violence'] };
  const one = movie({ reviews: [rev('So much gore.'), rev('Sweet and gentle.')] });
  assert.equal(hardNoReason(one, prefs), null, 'a single review is not enough to remove a film');
  const two = movie({ reviews: [rev('So much gore.'), rev('Bloody and brutal.')] });
  assert.deepEqual(hardNoReason(two, prefs), { code: 'content-flag', detail: CONTENT_FLAGS['graphic-violence'].label });
  const mixed = movie({ themes: ['Brutal violence'], reviews: [rev('Slasher fans will love it.')] });
  assert.equal(hardNoReason(mixed, prefs)?.code, 'content-flag', 'theme plus review counts as two hits');
});

test('hardNoReason: only flags the person asked to avoid are checked; unknown flag names do not crash', () => {
  const gory = movie({ reviews: [rev('So much gore.'), rev('Bloody and brutal.')] });
  assert.equal(hardNoReason(gory, { avoidFlags: ['sexual'] }), null);
  assert.equal(hardNoReason(gory, { avoidFlags: ['nonexistent'] }), null);
  assert.equal(hardNoReason(gory, {}), null);
});

test('hardNoReason: avoided genre wins over term and flag, in that order', () => {
  const m = movie({ genres: ['Horror'], title: 'Clown Gore', reviews: [rev('gore'), rev('gory')] });
  const prefs = { avoidGenres: ['Horror'], hardNoTerms: ['clown'], avoidFlags: ['graphic-violence'] };
  assert.equal(hardNoReason(m, prefs).code, 'avoided-genre');
  assert.equal(hardNoReason(m, { ...prefs, avoidGenres: [] }).code, 'hard-no-term');
  assert.equal(hardNoReason(m, { ...prefs, avoidGenres: [], hardNoTerms: [] }).code, 'content-flag');
});

test('contentCautions: a single hint becomes a caution that names its source; two hits are left to the filter', () => {
  const prefs = { avoidFlags: ['scary', 'sexual'] };
  const one = movie({ reviews: [rev('Full of jump scares.'), rev('Lovely score.')] });
  const cautions = contentCautions(one, prefs);
  assert.equal(cautions.length, 1);
  assert.match(cautions[0], /review/);
  assert.match(cautions[0], /jump scares or terror/i);
  assert.match(cautions[0], /worth a quick check/i);
  const two = movie({ reviews: [rev('Full of jump scares.'), rev('Truly terrifying.')] });
  assert.deepEqual(contentCautions(two, prefs), [], 'two hits is a hard filter, not a caution');
  assert.deepEqual(contentCautions(movie(), prefs), []);
  assert.deepEqual(contentCautions(one, {}), [], 'no avoided flags, no cautions');
});

test('contentCautions: one caution per flag', () => {
  const m = movie({ overview: 'A disturbing family secret.', themes: [], reviews: [rev('Contains nudity.')] });
  const out = contentCautions(m, { avoidFlags: ['disturbing', 'sexual'] });
  assert.equal(out.length, 2);
  assert.ok(out.some((c) => /synopsis/.test(c)) && out.some((c) => /review/.test(c)));
});
