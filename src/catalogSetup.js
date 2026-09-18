import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './data/catalog.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDefaultCatalog() {
  return loadCatalog({
    indexFile: path.join(ROOT, 'data', 'letterboxd.index.jsonl'),
    sampleFile: path.join(ROOT, 'data', 'sample', 'letterboxd-sample.jsonl'),
  });
}
