import fs from 'node:fs';
import path from 'node:path';

export const USER_AGENT = 'UpNextBot/0.1 (student hackathon project; polite, robots.txt-respecting, a handful of pages per request)';
const AGENT_TOKEN = 'upnextbot';

// ---- robots.txt ----
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      cur.rules.push({ allow: key === 'allow', pattern: value });
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  return groups;
}

const ruleRegex = (pattern) => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

// The most specific matching rule wins; on a tie, Allow wins. A group naming us beats the wildcard group.
export function robotsAllows(groups, pathAndQuery, token = AGENT_TOKEN) {
  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const applicable = named.length ? named : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of applicable) {
    for (const r of g.rules) {
      if (!r.pattern) continue;
      if (!ruleRegex(r.pattern).test(pathAndQuery)) continue;
      if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
    }
  }
  return best ? best.allow : true;
}

// ---- fetcher ----
export function createPoliteFetcher({
  fetchImpl = fetch,
  userAgent = USER_AGENT,
  minIntervalMs = 1100,
  timeoutMs = 10000,
  maxBytes = 3_000_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  const robotsCache = new Map();
  const queues = new Map();
  const lastHit = new Map();

  // One request at a time per host, spaced by minIntervalMs.
  const scheduled = (host, task) => {
    const prev = queues.get(host) ?? Promise.resolve();
    const run = prev.then(async () => {
      const wait = (lastHit.get(host) ?? 0) + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      try { return await task(); } finally { lastHit.set(host, now()); }
    });
    queues.set(host, run.catch(() => {}));
    return run;
  };

  const rawGet = async (url, accept = 'text/html,text/plain,*/*;q=0.5') => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: accept }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (res.url && new URL(res.url).host !== new URL(url).host) return { http: res.status, offsite: true, body: '' };
    const buf = Buffer.from(await res.arrayBuffer());
    return { http: res.status, body: buf.subarray(0, maxBytes).toString('utf8') };
  };

  async function robotsFor(origin) {
    const hit = robotsCache.get(origin);
    if (hit && now() - hit.at < 6 * 3600_000) return hit;
    const host = new URL(origin).host;
    let entry;
    try {
      const r = await scheduled(host, () => rawGet(`${origin}/robots.txt`));
      if (r.http === 404 || r.http === 410) entry = { groups: [], ok: true };
      else if (r.http >= 200 && r.http < 300) entry = { groups: parseRobots(r.body), ok: true };
      else entry = { groups: [], ok: false, reason: `robots.txt returned HTTP ${r.http}` };
    } catch (e) {
      entry = { groups: [], ok: false, reason: `robots.txt unreachable (${e.message})` };
    }
    entry.at = now();
    robotsCache.set(origin, entry);
    return entry;
  }

  return {
    userAgent,
    // `api: true` is for documented APIs called with a key. They are still rate limited, but robots.txt governs crawlers, not API calls.
    async get(url, { api = false, accept } = {}) {
      const u = new URL(url);
      if (!api) {
        const robots = await robotsFor(u.origin);
        if (!robots.ok) return { status: 'error', reason: robots.reason };
        if (!robotsAllows(robots.groups, u.pathname + u.search)) return { status: 'blocked', reason: `${u.host} robots.txt disallows ${u.pathname}` };
      }
      try {
        const r = await scheduled(u.host, () => rawGet(url, accept));
        if (r.offsite) return { status: 'error', reason: 'redirected to a different site; not followed' };
        if (r.http === 404 || r.http === 410) return { status: 'not-found', http: r.http };
        if (r.http < 200 || r.http >= 300) return { status: 'error', http: r.http, reason: `HTTP ${r.http}` };
        return { status: 'ok', http: r.http, body: r.body };
      } catch (e) {
        return { status: 'error', reason: e.name === 'TimeoutError' ? 'timed out' : e.message };
      }
    },
  };
}

// ---- parsed-result cache (parsed values are tiny; raw pages are never stored) ----
export function createResultCache({ file = null, ttlMs = 7 * 86400_000, negativeTtlMs = 86400_000, now = () => Date.now() } = {}) {
  let data = {};
  if (file && fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  }
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  return {
    get(key) {
      const e = data[key];
      if (!e) return undefined;
      if (now() - e.at > (e.negative ? negativeTtlMs : ttlMs)) return undefined;
      return e.value;
    },
    set(key, value, { negative = false } = {}) {
      data[key] = { value, at: now(), negative };
      persist();
    },
  };
}
