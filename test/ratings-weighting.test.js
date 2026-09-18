import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, votesOf, ratingConfidence, GLOBAL_MEAN } from '../src/agent/ratings.js';

const shrunk = (value, votes) => (votes * value + 50 * GLOBAL_MEAN) / (votes + 50);

test('votesOf: real votes beat the engagement proxy, which beats nothing', () => {
  assert.equal(votesOf({ votes: 1200, votesProxy: 9 }), 1200);
  assert.equal(votesOf({ votes: null, votesProxy: 340 }), 340);
  assert.equal(votesOf({ votesProxy: 340 }), 340);
  assert.equal(votesOf({ votes: 0, votesProxy: 340 }), 0, 'zero is a real count and is not replaced');
  assert.equal(votesOf({ value: 7 }), null);
});

test('reconcile: a lone rating is shrunk toward the global mean by its proxy weight', () => {
  const heavy = reconcile([{ source: 'letterboxd', value: 9, votes: null, votesProxy: 20000, kind: 'audience' }]);
  const light = reconcile([{ source: 'letterboxd', value: 9, votes: null, votesProxy: 20, kind: 'audience' }]);
  assert.ok(Math.abs(heavy.consensus - shrunk(9, 20000)) < 1e-9);
  assert.ok(Math.abs(light.consensus - shrunk(9, 20)) < 1e-9);
  assert.ok(heavy.consensus > 8.9, 'heavily engaged 9.0 stays near 9');
  assert.ok(light.consensus < 7.5, 'a barely-engaged 9.0 is pulled most of the way to the mean');
});

test('reconcile: proxy weight and a real vote count of the same size give the same answer', () => {
  const proxy = reconcile([{ source: 'letterboxd', value: 8, votesProxy: 400 }]);
  const real = reconcile([{ source: 'imdb', value: 8, votes: 400 }]);
  assert.equal(proxy.consensus, real.consensus);
});

test('reconcile: when both exist the real vote count is used and the proxy is ignored', () => {
  const both = reconcile([{ source: 'imdb', value: 9, votes: 10, votesProxy: 1e6 }]);
  assert.ok(Math.abs(both.consensus - shrunk(9, 10)) < 1e-9);
});

test('reconcile: with no weight at all a rating is treated as about 100 votes, not as certain', () => {
  const r = reconcile([{ source: 'rottentomatoes', value: 9, kind: 'critic' }]);
  assert.ok(Math.abs(r.consensus - shrunk(9, 100)) < 1e-9);
});

test('reconcile: two sources are weighted by sqrt(votes), so the better-evidenced one leads but cannot drown the other out', () => {
  const r = reconcile([
    { source: 'letterboxd', value: 8, votesProxy: 10000, kind: 'audience' },
    { source: 'rottentomatoes', value: 6, votes: 100, kind: 'critic' },
  ]);
  const a = shrunk(8, 10000);
  const b = shrunk(6, 100);
  const wa = Math.sqrt(5000);
  const wb = Math.sqrt(100);
  const expected = (a * wa + b * wb) / (wa + wb);
  assert.ok(Math.abs(r.consensus - expected) < 1e-9);
  assert.ok(r.consensus > b && r.consensus < a);
  assert.equal(r.coverage, 2);
  assert.equal(r.conflict, true, 'a 2-point gap between sources is reported as a conflict');
  assert.match(r.note, /Letterboxd 8\.0 vs Rotten Tomatoes critics 6\.0/);
});

test('reconcile: weight is capped at 5000 votes so one huge source cannot dominate', () => {
  const capped = reconcile([
    { source: 'letterboxd', value: 8, votesProxy: 5000 },
    { source: 'imdb', value: 6, votes: 5000 },
  ]);
  const huge = reconcile([
    { source: 'letterboxd', value: 8, votesProxy: 5_000_000 },
    { source: 'imdb', value: 6, votes: 5000 },
  ]);
  assert.ok(Math.abs(capped.consensus - huge.consensus) < 0.01, 'past 5000 the extra weight stops mattering');
});

test('reconcile: zero, negative and non-numeric values are ignored rather than counted', () => {
  assert.equal(reconcile([{ source: 'imdb', value: 0, votes: 100 }, { source: 'imdb', value: NaN }, { source: 'x', value: -1 }]).consensus, null);
  const r = reconcile([{ source: 'letterboxd', value: 7, votesProxy: 100 }, { source: 'imdb', value: 0, votes: 9999 }]);
  assert.equal(r.coverage, 1);
  assert.equal(r.conflict, false);
});

test('ratingConfidence: engagement proxy counts as evidence for a single source, and a conflict costs confidence', () => {
  const engaged = reconcile([{ source: 'letterboxd', value: 8, votesProxy: 900 }]);
  const thin = reconcile([{ source: 'letterboxd', value: 8, votesProxy: 100 }]);
  assert.equal(ratingConfidence(engaged), 0.6);
  assert.equal(ratingConfidence(thin), 0.4);
  const agree = reconcile([{ source: 'letterboxd', value: 8, votesProxy: 900 }, { source: 'imdb', value: 7.8, votes: 900 }]);
  const clash = reconcile([{ source: 'letterboxd', value: 8, votesProxy: 900 }, { source: 'rottentomatoes', value: 4, votes: 900, kind: 'critic' }]);
  assert.equal(ratingConfidence(agree), 0.85);
  assert.ok(Math.abs(ratingConfidence(clash) - 0.7) < 1e-9);
  assert.equal(ratingConfidence(reconcile([])), 0.2);
  assert.equal(ratingConfidence(null), 0.2);
});
