import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCatalog, catalogFromMovies, buildMovie, publicMovie, searchCatalog, resolveTitle, findByTitle, normTitle } from '../src/data/catalog.js';
import { SAMPLE_FILE } from './helpers.js';

// Synthetic index record in the compact shape written by src/data/buildIndex.js.
const rec = (s, t, y, p, over = {}) => ({
  s, t, y, d: ['Some Director'], g: ['Drama'], th: [], c: ['Some Actor'], syn: `Synthetic synopsis for ${t}.`, r: 4, p,
  rv: [{ u: 'a', t: 'Synthetic review text that is long enough.', l: p }], ...over,
});

function writeIndex(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-')), 'index.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const sample = loadCatalog({ sampleFile: SAMPLE_FILE });

test('loadCatalog: loads the committed sample and labels it as a sample', () => {
  assert.equal(sample.movies.length, 1500);
  assert.equal(sample.provenance.base, 'letterboxd-hf-sample');
  assert.equal(sample.provenance.sample, true);
  assert.equal(sample.provenance.file, 'letterboxd-sample.jsonl');
  assert.equal(sample.provenance.movieCount, 1500);
  assert.match(sample.provenance.notes.join(' '), /build-data/, 'tells you how to get the full index');
  assert.ok(sample.genres.includes('Science Fiction'));
  assert.deepEqual([...sample.genres], [...sample.genres].sort());
});

test('loadCatalog: the index wins over the sample when it exists, and says so', () => {
  const indexFile = writeIndex([rec('one', 'One', 2001, 500), rec('two', 'Two', 2002, 400)]);
  const c = loadCatalog({ indexFile, sampleFile: SAMPLE_FILE });
  assert.equal(c.movies.length, 2);
  assert.equal(c.provenance.base, 'letterboxd-hf-index');
  assert.equal(c.provenance.sample, false);
  assert.match(c.provenance.notes.join(' '), /Hugging Face/);
});

test('loadCatalog: a missing index falls back to the sample; no data at all is a clear error', () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-here.jsonl');
  assert.equal(loadCatalog({ indexFile: missing, sampleFile: SAMPLE_FILE }).provenance.base, 'letterboxd-hf-sample');
  assert.throws(() => loadCatalog({ indexFile: missing, sampleFile: missing }), /No movie data found/);
  assert.throws(() => loadCatalog({}), /No movie data found/);
});

test('loadCatalog: movies carry Letterboxd provenance and no invented sources', () => {
  const m = findByTitle(sample, 'Inception');
  assert.equal(m.id, m.slug);
  assert.equal(m.url, `https://letterboxd.com/film/${m.slug}/`);
  assert.deepEqual(m.sources, ['letterboxd-hf']);
  assert.equal(m.ratings.length, 1);
  assert.equal(m.ratings[0].source, 'letterboxd');
  assert.equal(m.ratings[0].kind, 'audience');
  assert.equal(m.rating.coverage, 1);
  assert.match(m.rating.note, /Only one rating source/);
  assert.equal(m.runtime, null, 'runtime is not in the dataset, so it is not made up');
  assert.ok(m.reviews.length > 0 && m.reviews.every((r) => r.text && r.user));
});

test('loadCatalog: the /5 Letterboxd rating is stored as /10 and weighted by a review-engagement proxy, not a fake vote count', () => {
  const indexFile = writeIndex([rec('big', 'Big', 2000, 90000, { r: 4.2 }), rec('tiny', 'Tiny', 2000, 5, { r: 4.2 })]);
  const c = loadCatalog({ indexFile });
  const big = c.byId.get('big').ratings[0];
  const tiny = c.byId.get('tiny').ratings[0];
  assert.equal(big.value, 8.4);
  assert.equal(big.votes, null, 'the dataset has no real vote count');
  assert.equal(big.votesProxy, 90000);
  assert.equal(tiny.votesProxy, 20, 'the proxy has a floor');
  assert.ok(c.byId.get('big').rating.consensus > c.byId.get('tiny').rating.consensus, 'the same score with more engagement is trusted more');
});

test('loadCatalog: synopsis terms shared by a few films become similarity keywords, along with people and themes', () => {
  const films = ['a', 'b', 'c'].map((k, i) => rec(k, `Film ${k}`, 2000 + i, 100, { syn: 'A lighthouse keeper guards a secret. Quantum zeppelin.', d: ['Dir X'], th: ['Moody'], c: ['P1', 'P2', 'P3', 'P4'] }));
  const rare = rec('z', 'Zed', 2010, 100, { syn: 'Wholly unrelated ostrich narrative.' });
  const filler = Array.from({ length: 40 }, (_, i) => rec(`f${i}`, `Filler ${i}`, 1990, 100, { syn: `Filler${i}` }));
  const c = loadCatalog({ indexFile: writeIndex([...films, rare, ...filler]) });
  const kw = c.byId.get('a').keywords;
  assert.ok(kw.includes('Dir X') && kw.includes('Moody') && kw.includes('P1'));
  assert.ok(!kw.includes('P4'), 'only the top three cast are used');
  assert.ok(kw.includes('lighthouse') && kw.includes('zeppelin'), 'terms shared by 3 films are kept');
  assert.ok(!c.byId.get('z').keywords.includes('ostrich'), 'a term used by one film links nothing');
  assert.ok(!kw.includes('about'), 'stop words never become keywords');
});

test('publicMovie: internal sets and keyword lists are not exposed', () => {
  const pub = publicMovie(findByTitle(sample, 'Inception'));
  assert.equal(pub.genreSet, undefined);
  assert.equal(pub.keywordSet, undefined);
  assert.equal(pub.keywords, undefined);
  assert.equal(pub.title, 'Inception');
});

test('normTitle: case, accents, punctuation and ampersands are ignored', () => {
  assert.equal(normTitle('  Amélie!  '), 'amelie');
  assert.equal(normTitle('Mad Max: Fury Road'), 'mad max fury road');
  assert.equal(normTitle('Fast & Furious'), 'fast and furious');
  assert.equal(normTitle(null), '');
});

test('searchCatalog: exact matches lead, then prefix, then contains, then popularity', () => {
  const c = catalogFromMovies([
    { id: 1, title: 'The Alien Nation', popularity: 900 },
    { id: 2, title: 'Alien', popularity: 100 },
    { id: 3, title: 'Alien Resurrection', popularity: 500 },
    { id: 4, title: 'Alien 3', popularity: 700 },
    { id: 5, title: 'Unrelated', popularity: 999 },
  ].map((m) => buildMovie({ genres: ['Drama'], ...m })));
  assert.deepEqual(searchCatalog(c, 'alien').map((m) => m.id), [2, 4, 3, 1]);
  assert.deepEqual(searchCatalog(c, 'ALIEN', 2).map((m) => m.id), [2, 4], 'limit applies after ranking');
});

test('searchCatalog: short or empty queries return nothing, and search works on the real sample', () => {
  assert.deepEqual(searchCatalog(sample, ''), []);
  assert.deepEqual(searchCatalog(sample, 'a'), []);
  assert.deepEqual(searchCatalog(sample, '!!'), []);
  assert.equal(searchCatalog(sample, 'inception')[0].title, 'Inception');
  assert.equal(searchCatalog(sample, 'zzzz-not-a-film').length, 0);
});

// resolveTitle and findByTitle on a catalog built to contain each ambiguity on purpose.
const world = catalogFromMovies([
  { id: 'dune-1984', title: 'Dune', year: 1984, popularity: 100 },
  { id: 'dune-2021', title: 'Dune', year: 2021, popularity: 150 },
  { id: 'heat', title: 'Heat', year: 1995, popularity: 900 },
  { id: 'heat-2', title: 'Heat', year: 1986, popularity: 100 },
  { id: 'inception', title: 'Inception', year: 2010, popularity: 800 },
  { id: 'amelie', title: 'Amélie', year: 2001, popularity: 300 },
  { id: 'alien', title: 'Alien', year: 1979, popularity: 400 },
  { id: 'alien-3', title: 'Alien 3', year: 1992, popularity: 200 },
  { id: 'i-am-legend', title: 'I Am Legend', year: 2007, popularity: 200 },
].map((m) => buildMovie({ genres: ['Drama'], ...m })));

test('resolveTitle: a single exact match is ok', () => {
  const r = resolveTitle(world, 'inception');
  assert.equal(r.status, 'ok');
  assert.equal(r.movie.id, 'inception');
  assert.equal(r.assumed, undefined);
  assert.equal(resolveTitle(world, 'AMELIE').movie.id, 'amelie', 'accents are ignored');
});

test('resolveTitle: a year in parentheses picks between remakes, within one year of tolerance', () => {
  assert.equal(resolveTitle(world, 'Dune (1984)').movie.id, 'dune-1984');
  assert.equal(resolveTitle(world, 'Dune (2021)').movie.id, 'dune-2021');
  assert.equal(resolveTitle(world, 'Dune (2022)').movie.id, 'dune-2021', 'a release-year off-by-one still resolves');
  assert.equal(resolveTitle(world, 'Dune (1999)').status, 'ok', 'a year matching nothing falls back to the exact-title list');
});

test('resolveTitle: same-title films of similar fame are ambiguous, and a far better-known one is assumed out loud', () => {
  const amb = resolveTitle(world, 'Dune');
  assert.equal(amb.status, 'ambiguous');
  assert.deepEqual(amb.options.map((m) => m.id), ['dune-2021', 'dune-1984'], 'most popular first');
  const assumed = resolveTitle(world, 'Heat');
  assert.equal(assumed.status, 'ok');
  assert.equal(assumed.movie.id, 'heat');
  assert.match(assumed.assumed, /Assumed Heat \(1995\)/, 'the assumption is stated, not silent');
});

test('resolveTitle: partial titles are unmatched with suggestions, never a guess', () => {
  const r = resolveTitle(world, 'Incep');
  assert.equal(r.status, 'unmatched');
  assert.deepEqual(r.suggestions.map((m) => m.id), ['inception']);
  const word = resolveTitle(world, 'legend');
  assert.equal(word.status, 'unmatched');
  assert.deepEqual(word.suggestions.map((m) => m.id), ['i-am-legend'], 'matches at a word start inside the title');
  assert.equal(resolveTitle(world, 'Alien 3 Extended Cut').status, 'unmatched', 'longer input containing a known title is only a suggestion');
  assert.deepEqual(resolveTitle(world, 'Alien 3 Extended Cut').suggestions.map((m) => m.id), ['alien', 'alien-3'], 'every known title inside the input, most popular first');
});

test('resolveTitle: garbage and blank input are handled without guessing', () => {
  assert.deepEqual(resolveTitle(world, ''), { status: 'empty' });
  assert.deepEqual(resolveTitle(world, '   '), { status: 'empty' });
  assert.deepEqual(resolveTitle(world, null), { status: 'empty' });
  assert.deepEqual(resolveTitle(world, 'x'), { status: 'unmatched', input: 'x', suggestions: [] });
  assert.deepEqual(resolveTitle(world, 'Nonexistent Film Title'), { status: 'unmatched', input: 'Nonexistent Film Title', suggestions: [] });
  assert.equal(resolveTitle(world, '(2010)').status, 'unmatched');
});

test('resolveTitle: works against the real sample', () => {
  const r = resolveTitle(sample, 'Inception (2010)');
  assert.equal(r.status, 'ok');
  assert.equal(r.movie.year, 2010);
  assert.equal(resolveTitle(sample, 'Zzzz Not A Film').status, 'unmatched');
});

test('findByTitle: exact normalized match, year tolerance, most popular wins, null when absent', () => {
  assert.equal(findByTitle(world, 'amélie').id, 'amelie');
  assert.equal(findByTitle(world, 'Dune').id, 'dune-2021', 'without a year the most popular wins');
  assert.equal(findByTitle(world, 'Dune', 1984).id, 'dune-1984');
  assert.equal(findByTitle(world, 'Dune', 1985).id, 'dune-1984', 'plus or minus one year');
  assert.equal(findByTitle(world, 'Dune', 1950).id, 'dune-2021', 'a year matching nothing falls back rather than returning null');
  assert.equal(findByTitle(world, 'Incep'), null, 'no partial matching here');
  assert.equal(findByTitle(world, 'Nope'), null);
});
