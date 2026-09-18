// The judge walkthrough: three things worth showing, run on a throwaway store so
// real data is never touched. The scenario returns its own shape rather than a
// single agent result, so this page renders it directly instead of reusing
// resultsView.
import { html, raw } from './html.js';
import { layout, ticket } from './layout.js';
import { runView, errorView } from './views.js';
import { runJudgeScenario } from '../demo/scenario.js';

export function startJudge({ jobs, catalog, sources }) {
  return jobs.create({
    userId: 'judge',
    mode: 'judge',
    runner: () => runJudgeScenario({ catalog, sources }),
  });
}

const changeList = (changes) => {
  if (!changes) return '';
  const lines = [
    changes.primaryChanged
      ? `Main pick changed from ${changes.primaryBefore} to ${changes.primaryAfter}.`
      : `Main pick stayed ${changes.primaryAfter}.`,
    changes.added?.length ? `New in the lineup: ${changes.added.join(', ')}.` : '',
    changes.removed?.length ? `Out of the lineup: ${changes.removed.join(', ')}.` : '',
  ].filter(Boolean);
  return html`<ul class="clean">${lines.map((l) => html`<li>${l}</li>`)}</ul>`;
};

function intro({ provenance }) {
  return layout({
    title: 'Judge walkthrough',
    current: '/judge',
    provenance,
    body: html`
<h1 class="center">Judge walkthrough</h1>
<p class="center">Three things, end to end, on a throwaway store. Nothing here touches saved data.</p>
<ol class="clean" style="max-width:56ch;margin:0 auto 26px">
  <li>A recommendation, with the reasoning behind it.</li>
  <li>What changed when someone in the room added a film.</li>
  <li>A pick a person disagreed with, and what the agent did about it.</li>
</ol>
<p class="center"><form method="post" action="/judge">${ticket({ tag: 'button', label: 'Run the walkthrough', admit: 'Admit one', sub: 'Takes a few seconds', stub: 'Judge' })}</form></p>`,
  });
}

function walkthrough({ job, provenance }) {
  const r = job.result;
  const solo = r.solo?.picks?.[0] ?? null;

  return layout({
    title: 'Judge walkthrough',
    current: '/judge',
    provenance,
    body: html`
<h1 class="center">Judge walkthrough</h1>
<p class="center small muted">Run on a throwaway store. ${r.missing?.length ? `Not in this catalog: ${r.missing.join(', ')}.` : ''}</p>

<div class="paper">
  <span class="ribbon">Part one</span>
  <h2>A recommendation, with its reasoning</h2>
  ${solo
    ? html`<p class="meta">${solo.movie.title}${solo.movie.year ? ` (${solo.movie.year})` : ''} for ${r.people?.alex?.name ?? 'Alex'}</p>
        <ul class="clean">${(solo.reasons ?? []).map((x) => html`<li>${typeof x === 'string' ? x : x.text}</li>`)}</ul>
        ${(solo.drawbacks ?? []).length ? html`<h4>Drawbacks</h4><ul class="clean drawbacks">${solo.drawbacks.map((d) => html`<li>${typeof d === 'string' ? d : d.text}</li>`)}</ul>` : ''}`
    : html`<p>Nothing survived the constraints for this person.</p>`}
</div>

<div class="paper">
  <span class="ribbon">Part two</span>
  <h2>Someone in the room adds a film</h2>
  ${r.friend
    ? html`<p class="meta">${r.friend.addedBy} added ${r.friend.movie} and liked it.</p>
        ${r.friend.analysis ? html`<p>${r.friend.analysis.headline}</p>` : html`<p class="muted">Nobody was watching, so there was nothing to compare.</p>`}
        <h4>What changed</h4>${changeList(r.friend.changes)}`
    : html`<p class="muted">No suitable unseen film was available in this catalog to demonstrate the change.</p>`}
</div>

<div class="paper">
  <span class="ribbon">Part three</span>
  <h2>A person disagrees with a pick</h2>
  ${r.disagreement
    ? html`<p class="meta">${r.disagreement.by} said no to ${r.disagreement.contested.title}.</p>
        <blockquote class="quote">${r.disagreement.feedback?.reason}<cite>${r.disagreement.by}, recorded with the pick</cite></blockquote>
        <div class="callout">${r.disagreement.note}</div>
        <p>${r.disagreement.representation}</p>
        <h4>What changed</h4>${changeList(r.disagreement.changes)}`
    : html`<p class="muted">No contested group pick was produced for this catalog.</p>`}
</div>

<div class="filmstrip" aria-hidden="true"></div>
<details class="paper dark"><summary style="cursor:pointer;font-family:var(--type);letter-spacing:.08em;text-transform:uppercase">How the agent got here (${r.solo?.trace?.length ?? 0} steps in part one)</summary>
  <div class="log" style="margin-top:12px"><ol>${(r.solo?.trace ?? []).map((s) => html`<li class="${s.status === 'warn' ? 'warn' : ''}"><span class="n">${String(s.n).padStart(2, '0')}</span><span><span class="tool">${s.tool.replaceAll('_', ' ')}</span> — ${s.summary}</span></li>`)}</ol></div></details>

<p class="center"><form method="post" action="/judge"><button class="btn secondary" type="submit">Run it again</button></form></p>`,
  });
}

export function judgeView({ jobs, provenance, jobId }) {
  const job = jobId ? jobs.get(jobId) : null;
  if (!job) return intro({ provenance });
  if (job.status === 'error') return errorView({ message: job.error, provenance });
  if (job.status !== 'done' || !job.result) return runView({ job, provenance });
  return walkthrough({ job, provenance });
}
