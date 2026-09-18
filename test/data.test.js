import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCsv, parseCsvObjects } from '../src/data/csv.js';
import { loadCatalog, searchCatalog, crowdFavorites } from '../src/data/catalog.js';
import { reconcile, crowdScore, ratingConfidence } from '../src/agent/ratings.js';
import { analyzeReviews } from '../src/agent/reviews.js';
import { createLiveSources } from '../src/data/live.js';
import { fixtureCatalog, ROOT } from './helpers.js';

test('csv parser handles quoted commas, escaped quotes, embedded JSON and newlines', () => {
  const rows = parseCsvObjects('id,genres,overview\r\n1,"[{""id"": 28, ""name"": ""Action""}]","line one\nline, two"\r\n2,[],plain\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].genres), [{ id: 28, name: 'Action' }]);
  assert.equal(rows[0].overview, 'line one\nline, two');
  assert.equal(rows[1].overview, 'plain');
  assert.deepEqual(parseCsv(''), []);
});

test('catalog: fixture is labeled approximate and never claims TMDB was queried', () => {
  const c = fixtureCatalog();
  assert.equal(c.provenance.base, 'sample-fixture');
  assert.equal(c.provenance.approximate, true);
  assert.ok(c.provenance.notes.join(' ').includes('Nothing here was queried from TMDB'));
  assert.ok(c.movies.every((m) => m.ratings.every((r) => r.approximate)));
});

test('catalog: loads TMDB 5000 CSVs, drops duplicate titles, and treats zero votes as missing ratings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-'));
  const g = (names) => `"${JSON.stringify(names.map((n, i) => ({ id: i, name: n }))).replaceAll('"', '""')}"`;
  fs.writeFileSync(
    path.join(dir, 'tmdb_5000_movies.csv'),
    [
      'id,title,release_date,runtime,original_language,genres,keywords,overview,vote_average,vote_count',
      `1,Twin,2010-01-01,100,en,${g(['Drama'])},${g(['a'])},x,7.0,50`,
      `2,Twin,2010-05-05,100,en,${g(['Drama'])},${g(['a'])},x,7.2,900`,
      `3,Unrated,2012-01-01,90,en,${g(['Comedy'])},${g([])},x,0,0`,
    ].join('\n'),
  );
  const c = loadCatalog({ dataDir: dir, fixturePath: path.join(ROOT, 'data', 'fixtures', 'movies.json') });
  assert.equal(c.provenance.base, 'tmdb-5000');
  assert.equal(c.provenance.duplicatesDropped, 1);
  assert.equal(c.byId.has(2), true, 'keeps the duplicate with more votes');
  assert.equal(c.byId.has(1), false);
  assert.equal(c.byId.get(3).rating.consensus, null);
  assert.ok(c.provenance.notes.some((n) => n.includes('The Movies Dataset')), 'says MovieLens was not found');
});

test('catalog: MovieLens overlay from The Movies Dataset adds a second rating source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-'));
  fs.mkdirSync(path.join(dir, 'the-movies-dataset'));
  fs.writeFileSync(path.join(dir, 'tmdb_5000_movies.csv'), 'id,title,release_date,runtime,original_language,genres,keywords,overview,vote_average,vote_count\n7,Solo Film,2010-01-01,100,en,[],[],x,8.0,1000\n');
  fs.writeFileSync(path.join(dir, 'the-movies-dataset', 'links_small.csv'), 'movieId,imdbId,tmdbId\n10,1,7\n');
  fs.writeFileSync(path.join(dir, 'the-movies-dataset', 'ratings_small.csv'), 'userId,movieId,rating,timestamp\n1,10,4.0,0\n2,10,3.0,0\n3,10,3.5,0\n');
  const c = loadCatalog({ dataDir: dir, fixturePath: path.join(ROOT, 'data', 'fixtures', 'movies.json') });
  const m = c.byId.get(7);
  assert.equal(m.rating.coverage, 2);
  const ml = m.rating.sources.find((s) => s.source === 'movielens');
  assert.equal(ml.value, 7);
  assert.equal(ml.votes, 3);
  assert.deepEqual(c.provenance.ratingSources.sort(), ['movielens', 'tmdb']);
});

test('search and crowd favorites use catalog data only', () => {
  const c = fixtureCatalog();
  assert.equal(searchCatalog(c, 'inception')[0].title, 'Inception');
  assert.deepEqual(searchCatalog(c, ''), []);
  const fav = crowdFavorites(c, { limit: 3 });
  assert.equal(fav.length, 3);
  assert.ok(fav[0].rating.consensus >= fav[2].rating.consensus);
});

test('ratings: conflicting sources are surfaced, not averaged away', () => {
  const r = reconcile([
    { source: 'tmdb', value: 8.5, votes: 5000, kind: 'audience' },
    { source: 'metacritic', value: 5.2, votes: null, kind: 'critic' },
  ]);
  assert.equal(r.conflict, true);
  assert.match(r.note, /disagree/);
  assert.ok(r.spread > 3);
  assert.ok(r.hasCritic && r.hasAudience);
  assert.ok(ratingConfidence(r) < ratingConfidence(reconcile([{ source: 'tmdb', value: 8, votes: 5000 }, { source: 'imdb', value: 8.1, votes: 9000 }])));
});

test('ratings: missing data is explicit and neutral', () => {
  const r = reconcile([]);
  assert.equal(r.consensus, null);
  assert.equal(r.coverage, 0);
  assert.equal(crowdScore(null), 0.5);
  assert.ok(ratingConfidence(r) <= 0.2);
});

test('ratings: few votes are shrunk toward the global mean', () => {
  const few = reconcile([{ source: 'tmdb', value: 10, votes: 3 }]);
  const many = reconcile([{ source: 'tmdb', value: 10, votes: 5000 }]);
  assert.ok(few.consensus < many.consensus);
  assert.ok(few.consensus < 7);
});

test('reviews: themes come only from real review text; empty input reports no data', () => {
  assert.equal(analyzeReviews([]).available, false);
  assert.match(analyzeReviews([]).note, /No review text/);
  // Synthetic test text, not real reviews.
  const out = analyzeReviews([
    { author: 'a', content: 'The pacing was slow and it dragged. The performances were brilliant though.', rating: 6 },
    { author: 'b', content: 'Boring pacing throughout. Stunning cinematography and amazing visuals.', rating: 8 },
    { author: 'c', content: 'Too much gore for me. The acting is superb and moving.', rating: 7 },
  ]);
  assert.equal(out.available, true);
  assert.ok(out.weaknesses.includes('pacing'));
  assert.ok(out.strengths.includes('visuals') || out.strengths.includes('performances'));
  assert.ok(out.contentConcerns.some((c) => c.concern === 'graphic violence'));
  assert.equal(out.audienceAverage, 7);
  assert.match(out.note, /only 3/);
});

test('live sources: unavailable without keys, parses OMDb, rejects TMDB id mismatches', async () => {
  const none = createLiveSources({ env: {} });
  assert.deepEqual(none.configured, { tmdb: false, omdb: false });
  assert.equal((await none.omdbRatings({ title: 'X' })).status, 'unavailable');
  assert.equal((await none.tmdbReviews({ id: 1, title: 'X' })).status, 'unavailable');

  const fetchImpl = async (url) => {
    const u = String(url);
    const json = u.includes('omdbapi')
      ? { Response: 'True', imdbRating: '8.8', imdbVotes: '2,000,000', Ratings: [{ Source: 'Rotten Tomatoes', Value: '87%' }, { Source: 'Metacritic', Value: '74/100' }] }
      : u.endsWith('/reviews?api_key=k') ? { results: [] } : { title: 'Some Other Movie' };
    return { ok: true, json: async () => json };
  };
  const live = createLiveSources({ env: { OMDB_API_KEY: 'k', TMDB_API_KEY: 'k' }, fetchImpl });
  const omdb = await live.omdbRatings({ title: 'Inception', year: 2010 });
  assert.deepEqual(omdb.ratings.map((r) => [r.source, r.value, r.kind]), [['imdb', 8.8, 'audience'], ['rottentomatoes', 8.7, 'critic'], ['metacritic', 7.4, 'critic']]);
  const rev = await live.tmdbReviews({ id: 27205, title: 'Inception' });
  assert.equal(rev.status, 'mismatch');
});
