import { loadDefaultCatalog } from '../catalogSetup.js';
import { runJudgeScenario } from './scenario.js';

const catalog = loadDefaultCatalog();
const out = runJudgeScenario({ catalog });
const line = (s = '') => console.log(s);

line(`Data: ${out.provenance.base} (${out.provenance.movieCount} movies; rating sources: ${out.provenance.ratingSources.join(', ') || 'none'})`);
for (const n of out.provenance.notes) line(`  note: ${n}`);

line('\n=== 1. Recommendation with reasoning (solo, for Alex) ===');
for (const r of out.recommendation.result.recommendations.slice(0, 3)) {
  line(`#${r.rank} ${r.movie.title} (${r.movie.year}) [${r.tier}] confidence ${r.confidence.label}`);
  for (const x of r.reasons.slice(0, 3)) line(`   + ${x.text}`);
  for (const t of r.tradeoffs) line(`   ~ ${t}`);
}

line('\n=== 2. What changed when a friend added a movie ===');
const f = out.friendAdded;
if (!f) line('(no eligible friend pick found in this catalog)');
else {
  line(f.headline);
  for (const r of f.reasoning) line(`   + ${r}`);
  line('   Before: ' + f.snapshots.before.slice(0, 5).map((m) => `${m.rank}.${m.title}`).join(' | '));
  line('   After:  ' + f.snapshots.after.slice(0, 5).map((m) => `${m.rank}.${m.title}`).join(' | '));
  for (const a of f.diff.added) line(`   new in top 10: ${a.movie.title} (#${a.to})`);
  for (const a of f.alsoConsider) line(`   also consider: ${a.movie.title} (${a.why})`);
}

line('\n=== 3. A recommendation a human disagreed with ===');
const d = out.disagreement;
if (!d) line('(no group pick available)');
else {
  line(`${d.disagreedBy} disagreed with "${d.contested.movie.title}" (${d.contested.label}): ${d.feedback.reason}`);
  line('   Before: ' + d.before.map((m) => `${m.rank}.${m.title}[${m.label}]`).join(' | '));
  line('   After:  ' + d.after.map((m) => `${m.rank}.${m.title}[${m.label}]`).join(' | '));
  line(`   ${d.note}`);
}
