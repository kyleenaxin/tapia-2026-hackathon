import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactRecord, buildIndex, CANON_GENRES } from '../src/data/buildIndex.js';

// Synthetic rows in the shape of the Hugging Face dump, not real Letterboxd reviews.
const review = (i, likes = 100, text = `A synthetic review number ${i} with enough words to count`) => ({ username: `user${i}`, review_text: text, likes: String(likes) });

const raw = (over = {}) => ({
  title: 'Test Film',
  year: '2010',
  url: 'https://letterboxd.com/film/test-film/',
  rating: '4.1',
  genres: ['Drama', 'Slow burn'],
  directors: ['A Director'],
  cast: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
  synopsis: 'A synthetic synopsis.',
  reviews: [1, 2, 3, 4, 5].map((i) => review(i)),
  ...over,
});

test('compactRecord: a well-evidenced film becomes a compact record', () => {
  const rec = compactRecord(raw());
  assert.equal(rec.s, 'test-film');
  assert.equal(rec.t, 'Test Film');
  assert.equal(rec.y, 2010);
  assert.equal(rec.r, 4.1);
  assert.equal(rec.p, 500, 'popularity is the summed review likes');
  assert.deepEqual(rec.d, ['A Director']);
  assert.equal(rec.c.length, 5, 'cast is capped at five');
  assert.ok(rec.rv.length <= 4);
});

test('compactRecord: films without a rating are dropped', () => {
  assert.equal(compactRecord(raw({ rating: '' })), null);
  assert.equal(compactRecord(raw({ rating: '0' })), null);
  assert.equal(compactRecord(raw({ rating: undefined })), null);
  assert.equal(compactRecord(raw({ rating: 'n/a' })), null);
});

test('compactRecord: fewer than five usable reviews is dropped, and very short reviews do not count', () => {
  assert.equal(compactRecord(raw({ reviews: [1, 2, 3, 4].map((i) => review(i)) })), null);
  const padded = [1, 2, 3, 4].map((i) => review(i)).concat(review(5, 100, 'too short'));
  assert.equal(compactRecord(raw({ reviews: padded })), null, 'a 9-character review is not evidence');
  assert.ok(compactRecord(raw({ reviews: [1, 2, 3].map((i) => review(i)) }), { minReviews: 3 }), 'the threshold is configurable');
  assert.equal(compactRecord(raw({ reviews: undefined })), null);
});

test('compactRecord: low review engagement is dropped, and the threshold is configurable', () => {
  const quiet = raw({ reviews: [1, 2, 3, 4, 5].map((i) => review(i, 10)) });
  assert.equal(compactRecord(quiet), null, '50 total likes is under the default 300');
  assert.ok(compactRecord(quiet, { minPopularity: 50 }));
  const edge = raw({ reviews: [1, 2, 3, 4, 5].map((i) => review(i, 60)) });
  assert.equal(compactRecord(edge).p, 300, 'exactly the threshold is kept');
});

test('compactRecord: like counts with separators parse, and reviews are ordered by likes', () => {
  const rec = compactRecord(raw({ reviews: [review(1, '1,200'), review(2, '5'), review(3, '9,000'), review(4, '300'), review(5, '40'), review(6, '700')] }));
  assert.deepEqual(rec.rv.map((r) => r.l), [9000, 1200, 700, 300], 'top four by likes');
  assert.equal(rec.p, 1200 + 5 + 9000 + 300 + 40 + 700);
});

test('compactRecord: theme labels are split from canonical genres', () => {
  const rec = compactRecord(raw({ genres: ['Drama', 'Cerebral and thought-provoking', 'Science Fiction', 'Show All…'] }));
  assert.deepEqual(rec.g, ['Drama', 'Science Fiction']);
  assert.deepEqual(rec.th, ['Cerebral and thought-provoking'], 'the "Show All…" UI label is discarded');
  assert.ok(rec.g.every((g) => CANON_GENRES.has(g)));
});

test('compactRecord: themes are capped, and a film with no canonical genre is dropped', () => {
  const many = compactRecord(raw({ genres: ['Drama', 't1', 't2', 't3', 't4', 't5', 't6'] }));
  assert.equal(many.th.length, 4);
  assert.equal(compactRecord(raw({ genres: ['Slow burn', 'Show All…'] })), null);
  assert.equal(compactRecord(raw({ genres: undefined })), null);
});

test('compactRecord: rows missing a title, year or film slug are dropped', () => {
  assert.equal(compactRecord(raw({ title: '' })), null);
  assert.equal(compactRecord(raw({ year: '' })), null);
  assert.equal(compactRecord(raw({ year: undefined })), null);
  assert.equal(compactRecord(raw({ url: 'https://letterboxd.com/' })), null);
  assert.equal(compactRecord(raw({ url: undefined })), null);
  assert.equal(compactRecord(raw({ url: 'https://letterboxd.com/film/no-trailing-slash' })).s, 'no-trailing-slash');
});

test('compactRecord: long text is clipped and whitespace collapsed', () => {
  const rec = compactRecord(raw({ synopsis: `${'word '.repeat(200)}`, reviews: [1, 2, 3, 4, 5].map((i) => review(i, 100, `line one\n\n   line two ${'x'.repeat(600)}`)) }));
  assert.ok(rec.syn.length <= 340);
  assert.ok(rec.syn.endsWith('…'));
  assert.ok(rec.rv.every((r) => r.t.length <= 420 && !/\s{2}|\n/.test(r.t)));
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'index-'));
}

test('buildIndex: streams a local dump, dedupes by title and year, counts bad rows, writes index and sample', async () => {
  const dir = tmpDir();
  const input = path.join(dir, 'dump.jsonl');
  const strong = raw({ title: 'Twin', url: 'https://letterboxd.com/film/twin/', reviews: [1, 2, 3, 4, 5].map((i) => review(i, 500)) });
  const weaker = raw({ title: 'Twin', url: 'https://letterboxd.com/film/twin-2/', reviews: [1, 2, 3, 4, 5].map((i) => review(i, 100)) });
  const other = raw({ title: 'Other', url: 'https://letterboxd.com/film/other/', reviews: [1, 2, 3, 4, 5].map((i) => review(i, 200)) });
  const unrated = raw({ title: 'Unrated', url: 'https://letterboxd.com/film/unrated/', rating: '' });
  fs.writeFileSync(input, [weaker, strong, other, unrated].map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n');

  const out = path.join(dir, 'nested', 'index.jsonl');
  const sampleOut = path.join(dir, 'sample', 'sample.jsonl');
  const result = await buildIndex({ input, out, sampleOut, sampleSize: 1 });

  assert.deepEqual(result, { seen: 5, malformed: 1, kept: 2, sampled: 1 });
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.s), ['twin', 'other'], 'the more engaged duplicate wins, most popular first');
  const sample = fs.readFileSync(sampleOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(sample.map((r) => r.s), ['twin'], 'the sample is the most popular slice');
});

test('buildIndex: no sample file is written unless asked for', async () => {
  const dir = tmpDir();
  const input = path.join(dir, 'dump.jsonl');
  fs.writeFileSync(input, JSON.stringify(raw()) + '\n');
  const result = await buildIndex({ input, out: path.join(dir, 'index.jsonl') });
  assert.equal(result.kept, 1);
  assert.equal(result.sampled, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['dump.jsonl', 'index.jsonl']);
});
