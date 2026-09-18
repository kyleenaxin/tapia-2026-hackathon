import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';

export const HF_URL = 'https://huggingface.co/datasets/pkchwy/letterboxd-all-movie-data/resolve/main/full_dump.jsonl';

export const CANON_GENRES = new Set([
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary', 'Drama', 'Family', 'Fantasy', 'History',
  'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'TV Movie', 'War', 'Western',
]);

const toInt = (v) => Number.parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10) || 0;
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Turns one raw dataset row into a compact index record, or null when it lacks the evidence we need.
export function compactRecord(raw, { minReviews = 5, minPopularity = 300 } = {}) {
  const rating = Number.parseFloat(raw.rating);
  const year = toInt(raw.year);
  const slug = /\/film\/([^/]+)\/?$/.exec(raw.url ?? '')?.[1];
  if (!(rating > 0) || !year || !slug || !raw.title) return null;
  const labels = raw.genres ?? [];
  const genres = labels.filter((g) => CANON_GENRES.has(g));
  if (!genres.length) return null;
  const reviews = (raw.reviews ?? [])
    .map((r) => ({ u: clip(r.username, 40), t: clip(r.review_text, 420), l: toInt(r.likes) }))
    .filter((r) => r.t.length >= 20);
  if (reviews.length < minReviews) return null;
  const popularity = reviews.reduce((s, r) => s + r.l, 0);
  if (popularity < minPopularity) return null;
  reviews.sort((a, b) => b.l - a.l);
  return {
    s: slug,
    t: clip(raw.title, 120),
    y: year,
    d: (raw.directors ?? []).slice(0, 3),
    g: genres,
    th: labels.filter((g) => !CANON_GENRES.has(g) && g !== 'Show All…').slice(0, 4),
    c: (raw.cast ?? []).slice(0, 5),
    syn: clip(raw.synopsis, 340),
    r: rating,
    p: popularity,
    rv: reviews.slice(0, 4),
  };
}

async function* lines(input) {
  let stream;
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    stream = Readable.fromWeb(res.body);
  } else stream = fs.createReadStream(input);
  yield* readline.createInterface({ input: stream, crlfDelay: Infinity });
}

// Streams the 1 GB dump once and writes a small JSONL index of well-evidenced films.
export async function buildIndex({ input = HF_URL, out, sampleOut = null, sampleSize = 1500, onProgress = () => {}, ...filters }) {
  const records = new Map();
  let seen = 0;
  let malformed = 0;
  for await (const line of lines(input)) {
    seen++;
    if (seen % 100000 === 0) onProgress({ seen, kept: records.size });
    let raw;
    try { raw = JSON.parse(line); } catch { malformed++; continue; }
    const rec = compactRecord(raw, filters);
    if (!rec) continue;
    const key = `${rec.t.toLowerCase()}|${rec.y}`;
    const prev = records.get(key);
    if (!prev || rec.p > prev.p) records.set(key, rec);
  }
  const all = [...records.values()].sort((a, b) => b.p - a.p);
  const write = (file, list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };
  write(out, all);
  if (sampleOut) write(sampleOut, all.slice(0, sampleSize));
  return { seen, malformed, kept: all.length, sampled: sampleOut ? Math.min(sampleSize, all.length) : 0 };
}
