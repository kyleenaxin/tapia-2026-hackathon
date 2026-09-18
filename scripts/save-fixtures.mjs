// One-off helper: trims real fetched pages down to the parts the parsers read, for use as test fixtures.
// Usage: node scripts/save-fixtures.mjs <letterboxd.html> <rt-arrival_2016.html> <rt-arrival-wrong.html>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [lbFile, rtFile, rtWrongFile] = process.argv.slice(2);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'sources');
fs.mkdirSync(out, { recursive: true });

const lb = fs.readFileSync(lbFile, 'utf8');
const title = /<title>[^<]*<\/title>/.exec(lb)[0];
const ld = /<script type="application\/ld\+json">[\s\S]*?<\/script>/.exec(lb)[0];
const runtime = /.{0,60}\d+&nbsp;mins.{0,40}/.exec(lb)[0];
fs.writeFileSync(path.join(out, 'letterboxd-come-and-see.html'), `<html><head>${title}${ld}</head><body><p class="text-link text-footer">${runtime}</p></body></html>`);

const grab = (html, key) => new RegExp(`"${key}":\\{[^}]*\\}`).exec(html)?.[0] ?? '';
for (const [file, name] of [[rtFile, 'rt-arrival-2016.html'], [rtWrongFile, 'rt-the-arrival-wrong-film.html']]) {
  const html = fs.readFileSync(file, 'utf8');
  const t = /<title>[^<]*<\/title>/.exec(html)[0];
  const year = /"releaseYear":"\d{4}"/.exec(html)?.[0] ?? '';
  fs.writeFileSync(path.join(out, name), `<html><head>${t}</head><body><script id="media-scorecard-json">{${grab(html, 'criticsScore')},${grab(html, 'audienceScore')},${year}}</script></body></html>`);
}
console.log('saved to', out);
