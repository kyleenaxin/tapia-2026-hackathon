import { html } from './html.js';
import { layout, ticket } from './layout.js';
import { pickCard, runView, errorView } from './views.js';
import { activityItem } from './roomViews.js';
import { runJudgeScenario } from '../demo/scenario.js';

export function startJudge({ jobs, catalog, sources }) {
  return jobs.create({ userId: 'judge', mode: 'judge', runner: (job) => runJudgeScenario({ catalog, sources, trace: job.trace }) });
}

const picksBlock = (result, group, job) => {
  const [primary, ...backups] = result.picks;
  if (!primary) return html`<p class="muted">No picks survived the constraints.</p>`;
  const members = group ? result.participants : [];
  return html`${pickCard({ pick: primary, job, members, group, readOnly: true, backup: false })}
  ${backups.length ? html`<div class="backups">${backups.map((b) => pickCard({ pick: b, job, members, group, readOnly: true, backup: true }))}</div>` : ''}`;
};

const lineup = (r) => html`<ol class="snap">${r.picks.map((p) => html`<li>${p.movie.title} <span class="muted small">(${p.label}${p.groupLabel ? `, ${p.groupLabel}` : ''})</span></li>`)}</ol>`;

export function judgeView({ jobs, provenance, jobId }) {
  const job = jobId ? jobs.get(jobId) : null;
  if (job && job.mode !== 'judge') return errorView({ message: 'That is not a walkthrough.', provenance, status: 404 });
  if (job && job.status === 'error') return errorView({ message: job.error, provenance });
  if (job && job.status !== 'done') return runView({ job, provenance });

  if (!job) {
    return layout({
      title: 'Judge walkthrough',
      current: '/judge',
      provenance,
      body: html`
<h1 class="center">Judge walkthrough</h1>
<div class="paper"><p>Three things, run live by the agent:</p>
<ul class="clean"><li>A recommendation with its reasoning, from ratings across sources.</li><li>What changed when a friend added a movie, before and after.</li><li>A recommendation a human disagreed with, and how the agent handled it.</li></ul>
<p class="small muted">The people (Alex, Sam, Maya and Jordan) are seeded sample data, not real users. It runs on a throwaway copy, so nothing you entered is touched. The first run visits Letterboxd and Rotten Tomatoes for a dozen films or so and takes about a minute. After that it is cached.</p>
<form method="post" action="/judge" class="center">${ticket({ tag: 'button', label: 'Run the walkthrough', admit: 'Judges', sub: 'Live, with a visible log', stub: 'Demo' })}</form></div>`,
    });
  }

  const r = job.result;
  const f = r.friend;
  const d = r.disagreement;
  const solo = r.solo;
  return layout({
    title: 'Judge walkthrough',
    current: '/judge',
    provenance,
    body: html`
<h1 class="center">Judge walkthrough</h1>
<div class="banner warn"><strong>Seeded demo people.</strong> Alex, Sam and Maya are in a screening room. Jordan is not, so the agent never touches Jordan's history. ${r.missing.length ? `Not in the dataset, so skipped: ${r.missing.join(', ')}.` : ''}</div>

<h2 class="center" style="margin-top:34px">1. A recommendation, with its reasoning</h2>
<p class="center">Solo mode for Alex, who loved ${solo.profile.liked.slice(0, 4).join(', ')}, ${solo.profile.mood ? `is in a “${solo.profile.mood}” mood` : 'has no mood set'} and has a 150 minute limit.</p>
${picksBlock(solo, false, job)}

<div class="filmstrip" aria-hidden="true"></div>
<h2 class="center">2. What changed when a friend added a movie</h2>
${f ? html`<p class="center">Sam, who shares a room with Alex, just watched and loved <strong>${f.movie}</strong>. Alex's agent noticed and re-ran.</p>
${f.analysis ? activityItem(f.analysis) : ''}
<div class="paper"><h3>Alex's programme, before and after</h3>
  <div class="two-col"><div><h4>Before</h4>${lineup(f.before)}</div><div><h4>After</h4>${lineup(f.after)}</div></div>
  <p>${f.changes.primaryChanged ? html`The main pick changed from <strong>${f.changes.primaryBefore}</strong> to <strong>${f.changes.primaryAfter}</strong>.` : html`The main pick stayed <strong>${f.changes.primaryAfter}</strong>.`}${f.changes.added.length ? ` New in the lineup: ${f.changes.added.join(', ')}.` : ''}${f.changes.removed.length ? ` Out: ${f.changes.removed.join(', ')}.` : ''}</p></div>` : html`<p class="center muted">No suitable friend pick was available in this catalog.</p>`}

<div class="filmstrip" aria-hidden="true"></div>
<h2 class="center">3. A recommendation a human disagreed with</h2>
${d ? html`<div class="banner warn"><strong>Illustrative example.</strong> ${d.note}</div>
<div class="paper"><p>In group mode the agent picked <strong>${d.contested.title}</strong> (${d.contested.label}) for Alex, Sam and Maya. ${d.by} disagreed: <em>“${d.feedback.reason}”</em></p>
  <div class="two-col"><div><h4>Before the veto</h4>${lineup(d.before)}</div><div><h4>After the veto</h4>${lineup(d.after)}</div></div>
  <p style="margin-top:12px">${d.representation}</p></div>
<h3 class="center">The group's new main pick</h3>
${picksBlock(d.after, true, job)}` : html`<p class="center muted">No group pick was available.</p>`}

<div class="filmstrip" aria-hidden="true"></div>
<details class="paper dark"><summary style="cursor:pointer;font-family:var(--type);letter-spacing:.08em;text-transform:uppercase">Full agent log (${job.trace.steps.length} steps)</summary>
  <div class="log" style="margin-top:12px"><ol>${job.trace.steps.map((s) => html`<li class="${s.status === 'warn' ? 'warn' : ''}"><span class="n">${String(s.n).padStart(2, '0')}</span><span><span class="tool">${s.tool.replaceAll('_', ' ')}</span> — ${s.summary}</span></li>`)}</ol></div></details>
<p class="center"><form method="post" action="/judge" style="display:inline"><button class="btn secondary" type="submit">Run again</button></form></p>`,
  });
}
