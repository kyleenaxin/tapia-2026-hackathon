// One-off: downloads the Latin subsets of three OFL-licensed fonts into public/fonts so the site is self-hosted.
// Limelight (marquee display), Courier Prime (ticket typewriter), Lora (readable serif body text).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'fonts');
fs.mkdirSync(out, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const families = [
  ['Limelight', 'Limelight'],
  ['Courier+Prime:wght@400;700', 'Courier Prime'],
  ['Lora:wght@400;600', 'Lora'],
];

const css = [];
for (const [query, name] of families) {
  const res = await fetch(`https://fonts.googleapis.com/css2?family=${query}&display=swap`, { headers: { 'User-Agent': UA } });
  const text = await res.text();
  for (const block of text.split('@font-face').slice(1)) {
    if (!block.includes('U+0000-00FF')) continue; // Latin subset only
    const weight = /font-weight:\s*([^;]+);/.exec(block)[1].trim();
    const url = /url\(([^)]+)\)/.exec(block)[1];
    const file = `${name.toLowerCase().replace(/ /g, '-')}-${weight.replace(/ /g, '-')}.woff2`;
    fs.writeFileSync(path.join(out, file), Buffer.from(await (await fetch(url)).arrayBuffer()));
    css.push(`@font-face { font-family: '${name}'; font-weight: ${weight}; font-style: normal; font-display: swap; src: url('/fonts/${file}') format('woff2'); }`);
    console.log('saved', file);
  }
}
fs.writeFileSync(path.join(out, 'fonts.css'), `${css.join('\n')}\n`);
fs.writeFileSync(path.join(out, 'README.txt'), 'Limelight, Courier Prime and Lora are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org). Latin subsets downloaded from Google Fonts.\n');
