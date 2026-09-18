import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { parseRobots, robotsAllows, createPoliteFetcher, createResultCache } from '../src/agent/sources/politeFetch.js';
import { parseLetterboxd, parseRottenTomatoes, rtSlugs, fetchLetterboxd, fetchRottenTomatoes, fetchOmdb } from '../src/agent/sources/adapters.js';
import { createSources } from '../src/agent/sources/index.js';

const fixture = (name) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'sources', name), 'utf8');

const LETTERBOXD_ROBOTS = `
User-agent: ClaudeBot
Disallow: /

User-agent: *
Disallow: /*/genre/*
Disallow: /films/year/*
Disallow: /*/by/*
Allow: /film/
`;
const RT_ROBOTS = `User-agent: *\nDisallow: /m/*/pictures\nDisallow: /search\n\nUser-agent: AmazonAdBot\nAllow: /`;

test('robots.txt: wildcard rules, specificity, and named-agent groups', () => {
  const lb = parseRobots(LETTERBOXD_ROBOTS);
  assert.equal(robotsAllows(lb, '/film/come-and-see/'), true, 'film pages are allowed');
  assert.equal(robotsAllows(lb, '/films/year/1985/'), false);
  assert.equal(robotsAllows(lb, '/drama/genre/thriller/'), false);
  const rt = parseRobots(RT_ROBOTS);
  assert.equal(robotsAllows(rt, '/m/arrival_2016'), true);
  assert.equal(robotsAllows(rt, '/m/arrival_2016/pictures'), false);
  assert.equal(robotsAllows(rt, '/search?search=x'), false);
  // A group that names a crawler applies to that crawler, not to us.
  assert.equal(robotsAllows(lb, '/film/x/', 'claudebot'), false);
  assert.equal(robotsAllows(lb, '/film/x/', 'upnextbot'), true);
  assert.equal(robotsAllows([], '/anything'), true);
});

function mockFetch(routes, log = []) {
  return async (url, opts) => {
    log.push({ url, ua: opts.headers['User-Agent'] });
    const u = new URL(url);
    const hit = routes[u.origin + u.pathname] ?? routes[u.pathname];
    const r = typeof hit === 'function' ? hit(url) : hit;
    if (!r) return { status: 404, url, arrayBuffer: async () => Buffer.from('') };
    return { status: r.status ?? 200, url: r.url ?? url, arrayBuffer: async () => Buffer.from(r.body ?? '') };
  };
}

test('polite fetcher: identifies itself, obeys robots.txt, and never requests a blocked page', async () => {
  const log = [];
  const fetcher = createPoliteFetcher({ fetchImpl: mockFetch({ '/robots.txt': { body: RT_ROBOTS }, '/m/ok': { body: 'hello' }, '/search': { body: 'no' } }, log), minIntervalMs: 0 });
  const ok = await fetcher.get('https://example.test/m/ok');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.body, 'hello');
  assert.match(log[0].ua, /^UpNextBot\//);
  const blocked = await fetcher.get('https://example.test/search?q=x');
  assert.equal(blocked.status, 'blocked');
  assert.ok(!log.some((l) => l.url.includes('/search')), 'the disallowed URL was never requested');
  assert.equal(log.filter((l) => l.url.endsWith('/robots.txt')).length, 1, 'robots.txt fetched once per host');
});

test('polite fetcher: no robots.txt means allowed, an unreadable one means do not crawl', async () => {
  const none = createPoliteFetcher({ fetchImpl: mockFetch({ '/page': { body: 'x' } }), minIntervalMs: 0 });
  assert.equal((await none.get('https://a.test/page')).status, 'ok');
  const broken = createPoliteFetcher({ fetchImpl: mockFetch({ '/robots.txt': { status: 503 }, '/page': { body: 'x' } }), minIntervalMs: 0 });
  const r = await broken.get('https://b.test/page');
  assert.equal(r.status, 'error');
  assert.match(r.reason, /robots\.txt/);
});

test('polite fetcher: spaces requests to one host and refuses redirects to other sites', async () => {
  let clock = 0;
  const sleeps = [];
  const fetcher = createPoliteFetcher({
    fetchImpl: mockFetch({ '/a': { body: '1' }, '/b': { body: '2' }, '/away': { url: 'https://evil.test/x', body: 'x' } }),
    minIntervalMs: 1000,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  await fetcher.get('https://c.test/a');
  await fetcher.get('https://c.test/b');
  assert.ok(sleeps.length >= 1 && sleeps.every((ms) => ms > 0 && ms <= 1000), `waited between requests: ${sleeps}`);
  const off = await fetcher.get('https://c.test/away');
  assert.equal(off.status, 'error');
  assert.match(off.reason, /different site/);
  assert.equal((await fetcher.get('https://c.test/missing')).status, 'not-found');
});

test('polite fetcher: API calls skip robots.txt but are still rate limited', async () => {
  const log = [];
  const fetcher = createPoliteFetcher({ fetchImpl: mockFetch({ '/api': { body: '{}' } }, log), minIntervalMs: 0 });
  await fetcher.get('https://api.test/api?k=1', { api: true });
  assert.ok(!log.some((l) => l.url.endsWith('/robots.txt')));
});

test('Letterboxd parser reads rating, rating count and runtime from a real page excerpt', () => {
  const p = parseLetterboxd(fixture('letterboxd-come-and-see.html'));
  assert.equal(p.ratingValue, 4.61);
  assert.equal(p.ratingCount, 502245);
  assert.equal(p.runtime, 142);
  assert.equal(p.year, 1985);
});

test('Rotten Tomatoes parser reads critics and audience scores from a real page excerpt', () => {
  const p = parseRottenTomatoes(fixture('rt-arrival-2016.html'));
  assert.equal(p.title, 'Arrival (2016)');
  assert.equal(p.year, 2016);
  assert.deepEqual([p.critics.score, p.critics.count, p.critics.certified], [94, 441, true]);
  assert.deepEqual([p.audience.score, p.audience.count], [83, 50000]);
});

test('Rotten Tomatoes slugs come from the title, with a year-suffixed fallback', () => {
  assert.deepEqual(rtSlugs('Arrival', 2016), ['arrival', 'arrival_2016']);
  assert.deepEqual(rtSlugs("Ocean's Eleven", 2001), ['oceans_eleven', 'oceans_eleven_2001']);
  assert.deepEqual(rtSlugs('Amélie', 2001)[0], 'amelie');
});

const movie = (over = {}) => ({ id: 'arrival', title: 'Arrival', year: 2016, url: 'https://letterboxd.com/film/arrival/', ...over });
const fakeFetcher = (pages) => ({ userAgent: 'test', get: async (url) => (pages[url] ? { status: 'ok', http: 200, body: pages[url] } : { status: 'not-found', http: 404 }) });

test('Rotten Tomatoes adapter skips a same-named film and takes the matching year-suffixed page', async () => {
  const fetcher = fakeFetcher({
    'https://www.rottentomatoes.com/m/arrival': fixture('rt-the-arrival-wrong-film.html'),
    'https://www.rottentomatoes.com/m/arrival_2016': fixture('rt-arrival-2016.html'),
  });
  const r = await fetchRottenTomatoes(movie(), { fetcher });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.ratings.map((x) => [x.source, x.value, x.kind]), [['rottentomatoes', 9.4, 'critic'], ['rt-audience', 8.3, 'audience']]);
});

test('Rotten Tomatoes adapter rejects wrong-year and wrong-title pages instead of guessing', async () => {
  const wrongYear = fakeFetcher({ 'https://www.rottentomatoes.com/m/arrival': fixture('rt-arrival-2016.html') });
  assert.equal((await fetchRottenTomatoes(movie({ year: 1996 }), { fetcher: wrongYear })).status, 'not-found');
  const wrongTitle = fakeFetcher({ 'https://www.rottentomatoes.com/m/arrival': fixture('rt-the-arrival-wrong-film.html') });
  const r = await fetchRottenTomatoes(movie({ year: 2016 }), { fetcher: wrongTitle });
  assert.notEqual(r.status, 'ok');
});

test('Rotten Tomatoes adapter reports a robots block rather than working around it', async () => {
  const fetcher = { get: async () => ({ status: 'blocked', reason: 'www.rottentomatoes.com robots.txt disallows /m/arrival' }) };
  const r = await fetchRottenTomatoes(movie(), { fetcher });
  assert.equal(r.status, 'blocked');
  assert.match(r.reason, /robots/);
});

test('Letterboxd adapter converts to a /10 rating with the real vote count and returns runtime', async () => {
  const fetcher = fakeFetcher({ 'https://letterboxd.com/film/come-and-see/': fixture('letterboxd-come-and-see.html') });
  const r = await fetchLetterboxd(movie({ id: 'come-and-see', title: 'Come and See', year: 1985, url: 'https://letterboxd.com/film/come-and-see/' }), { fetcher });
  assert.equal(r.status, 'ok');
  assert.equal(r.runtime, 142);
  assert.deepEqual([r.ratings[0].value, r.ratings[0].votes, r.ratings[0].kind], [9.22, 502245, 'audience']);
  const wrong = await fetchLetterboxd(movie({ id: 'come-and-see', year: 2001, url: 'https://letterboxd.com/film/come-and-see/' }), { fetcher });
  assert.equal(wrong.status, 'mismatch');
});

test('OMDb adapter: unavailable without a key; parses IMDb, Metacritic, RT and runtime with one', async () => {
  assert.equal((await fetchOmdb(movie(), { fetcher: {}, env: {} })).status, 'unavailable');
  const body = JSON.stringify({ Response: 'True', imdbRating: '7.9', imdbVotes: '760,000', Runtime: '116 min', Rated: 'PG-13', Ratings: [{ Source: 'Rotten Tomatoes', Value: '94%' }, { Source: 'Metacritic', Value: '81/100' }] });
  const seen = [];
  const fetcher = { get: async (url, opts) => { seen.push(opts); return { status: 'ok', body }; } };
  const r = await fetchOmdb(movie(), { fetcher, env: { OMDB_API_KEY: 'k' } });
  assert.deepEqual(r.ratings.map((x) => [x.source, x.value]), [['imdb', 7.9], ['rottentomatoes', 9.4], ['metacritic', 8.1]]);
  assert.equal(r.runtime, 116);
  assert.equal(r.rated, 'PG-13');
  assert.deepEqual(seen[0], { api: true });
  assert.ok(!JSON.stringify(r).includes('"k"'), 'the API key is never echoed in results');
});

test('sources: parsed results are cached, failures are handled, and scraping can be switched off', async () => {
  let calls = 0;
  const fetcher = { userAgent: 'test', get: async () => { calls++; return { status: 'ok', http: 200, body: fixture('letterboxd-come-and-see.html') }; } };
  const m = movie({ id: 'come-and-see', title: 'Come and See', year: 1985, url: 'https://letterboxd.com/film/come-and-see/' });
  const sources = createSources({ env: {}, fetcher, cache: createResultCache() });
  const first = await sources.letterboxd(m);
  const second = await sources.letterboxd(m);
  assert.equal(calls, 1);
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.equal(second.runtime, 142);

  const off = createSources({ env: { ENABLE_WEB_SCRAPING: '0' }, fetcher, cache: createResultCache() });
  assert.equal(off.configured.scraping, false);
  assert.equal((await off.letterboxd(movie({ id: 'other' }))).status, 'disabled');
  assert.equal((await off.rottenTomatoes(movie({ id: 'other' }))).status, 'disabled');
  assert.equal(calls, 1, 'nothing was fetched while scraping was off');
});

test('result cache expires entries and persists to disk', () => {
  let t = 0;
  const file = path.join(ROOT, 'data', 'cache', `test-${process.pid}.json`);
  try {
    const c = createResultCache({ file, ttlMs: 1000, negativeTtlMs: 100, now: () => t });
    c.set('a', { v: 1 });
    c.set('b', { v: 2 }, { negative: true });
    t = 500;
    assert.deepEqual(c.get('a'), { v: 1 });
    assert.equal(c.get('b'), undefined, 'negative results expire sooner');
    t = 2000;
    assert.equal(c.get('a'), undefined);
    const again = createResultCache({ file, ttlMs: 1000, now: () => 500 });
    assert.deepEqual(again.get('a'), { v: 1 }, 'reloaded from disk');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
