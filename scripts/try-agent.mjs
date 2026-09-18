// Dev helper: run one solo agent pass against the real catalog and live sources, printing the trace and picks.
import path from 'node:path';
import { loadDefaultCatalog, ROOT } from '../src/catalogSetup.js';
import { Store } from '../src/store.js';
import { processPreferences, applyAnswers } from '../src/agent/intake.js';
import { runSoloAgent } from '../src/agent/agent.js';
import { createTrace } from '../src/agent/trace.js';
import { defaultSources } from '../src/agent/sources/index.js';

const catalog = loadDefaultCatalog();
const store = new Store();
const me = store.createUser({ name: 'Tester' });
const t0 = Date.now();
const form = {
  genres: ['Science Fiction', 'Thriller'],
  mood: 'mindbend',
  loved: 'Inception\nInterstellar\nArrival',
  disliked: 'Mamma Mia!',
  watched: 'The Dark Knight\nDune',
  maxRuntime: '150',
  hardNoGenres: ['Horror'],
  hardNoTerms: '',
  avoidFlags: ['graphic-violence'],
};
const intake = processPreferences({ store, catalog, userId: me.id, form });
console.log('QUESTIONS', JSON.stringify(intake.questions.map((q) => [q.id, q.text, q.options.length])), 'NOTES', intake.notes);
if (intake.questions.length) console.log('(answering with first option)') || applyAnswers({ store, catalog, userId: me.id, questions: intake.questions, answers: Object.fromEntries(intake.questions.map((q) => [q.id, q.options[0].value])) });

const trace = createTrace({ onChange: () => {} });
const result = await runSoloAgent({ userId: me.id, store, catalog, sources: defaultSources(ROOT), trace });
for (const s of result.trace) console.log(`${String(s.n).padStart(2)} [${s.status}] ${s.tool}: ${s.summary}`);
for (const p of result.picks) {
  console.log(`\n== ${p.label}: ${p.movie.title} (${p.movie.year}) ${p.runtime.minutes ?? '?'} min | conf ${p.confidence.label} | score ${p.score}`);
  p.reasons.slice(0, 4).forEach((r) => console.log(`  + [${r.signal}] ${r.text}`));
  console.log('  ratings:', p.ratings.sources.map((s) => `${s.label} ${s.value.toFixed(1)}`).join(', '), p.ratings.conflict ? `CONFLICT ${p.ratings.note}` : '');
  p.reviews.points.forEach((r) => console.log(`  review: ${r}`));
  if (p.reviews.quote) console.log(`  quote: "${p.reviews.quote.text}" - ${p.reviews.quote.user}`);
  p.drawbacks.forEach((d) => console.log(`  ~ ${d}`));
}
console.log('\nnotes:', result.notes, `\nchecked ${result.checked} films in ${Date.now() - t0} ms; sources`, JSON.stringify(result.sources));
