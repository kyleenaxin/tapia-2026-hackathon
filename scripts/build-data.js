// Usage: npm run build-data [-- --input path/to/full_dump.jsonl] [--sample]
// Streams the Hugging Face Letterboxd dump (or a local copy) into data/letterboxd.index.jsonl.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, HF_URL } from '../src/data/buildIndex.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const input = arg('--input', HF_URL);
console.log(`Reading ${input}${/^https?:/.test(input) ? ' (about 1.1 GB streamed, nothing is saved but the index)' : ''}`);
const result = await buildIndex({
  input,
  out: path.join(root, 'data', 'letterboxd.index.jsonl'),
  sampleOut: args.includes('--sample') ? path.join(root, 'data', 'sample', 'letterboxd-sample.jsonl') : null,
  minReviews: Number(arg('--min-reviews', 5)),
  minPopularity: Number(arg('--min-popularity', 300)),
  onProgress: ({ seen, kept }) => console.log(`  ${seen.toLocaleString()} rows read, ${kept.toLocaleString()} kept`),
});
console.log(result);
