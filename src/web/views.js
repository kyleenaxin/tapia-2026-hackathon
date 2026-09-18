import { html, raw, safeUrl } from './html.js';
import { layout, ticket, icon } from './layout.js';
import { MOODS, CONTENT_FLAGS } from '../agent/constraints.js';

const pct = (v10) => `${Math.round(v10 * 10)}%`;
const RUNTIMES = [['', 'Any length is fine'], ['90', 'Up to 90 minutes'], ['105', 'Up to 1 hour 45'], ['120', 'Up to 2 hours'], ['150', 'Up to 2 hours 30'], ['180', 'Up to 3 hours']];

// ---------- welcome and mode ----------
export function welcomeView() {
  return layout({
    title: 'Welcome',
    bare: true,
    bodyClass: 'welcome',
    body: html`
<div class="spotlight" aria-hidden="true"></div>
<div class="behind" aria-hidden="true">Now showing: your next favorite movie</div>
<div class="curtains" aria-hidden="true"><div class="curtain left"></div><div class="curtain right"></div></div>
<div class="stage-hall">
  <header class="marquee"><span class="brand">UP NEXT</span><span class="tag">Welcome to the platform</span></header>
  <h1 class="visually-hidden">Welcome to Up Next</h1>
  <p class="hint" style="max-width:26rem;margin:0 auto 28px">A movie picked for you, with the reasons why.</p>
  ${ticket({ href: '/mode', label: 'Get started', sub: '', attrs: 'data-open-curtains' })}
</div>`,
  });
}

export function modeView({ provenance }) {
  return layout({
    title: 'Choose your screening',
    current: '/mode',
    provenance,
    body: html`
<h1 class="center">Who's watching?</h1>
<div class="mode-grid">
  ${ticket({ href: '/solo', admit: 'Solo', label: 'Just me', sub: 'A screening for one', stub: 'Solo', attrs: '' })}
  ${ticket({ href: '/group', admit: 'Group', label: 'With friends', sub: 'In person or online', stub: 'Group', attrs: '' })}
</div>
<p class="center help">One main pick and two backups, with the reasons behind each.</p>`,
  });
}

// ---------- preferences form ----------
const chip = (type, name, value, label, checked, cls = '') => html`<label class="chip ${cls}"><input type="${type}" name="${name}" value="${value}" ${checked ? raw('checked') : ''}><span>${label}</span></label>`;

function picker({ name, label, help }) {
  return html`<div class="picker">
  <label class="field" for="p-${name}">${label}</label>
  <p class="help">${help}</p>
  <div class="chips-out"></div>
  <input type="search" id="p-${name}" hidden placeholder="Start typing a title, then pick it" autocomplete="off">
  <div class="suggest" role="listbox" hidden></div>
  <textarea name="${name}" rows="3" placeholder="One title per line, for example: Inception (2010)"></textarea>
  <p class="help nojs-help">One title per line. Add the year in brackets if several films share the name.</p>
</div>`;
}

export function prefsForm({ action, user, genres, heading, intro, submitLabel, hidden = {}, showImport = true, saved = 0 }) {
  const p = user.prefs;
  const pickGenres = genres.filter((g) => g !== 'TV Movie');
  // Each direct-child fieldset is one scene. site.js shows them one at a time;
  // without it they simply stack and the form behaves as it always did.
  return html`<form class="paper" method="post" action="${action}" enctype="multipart/form-data" data-scenes>
  ${heading ? html`<h2>${heading}</h2>` : ''}
  ${intro ? html`<p class="help">${intro}</p>` : ''}
  ${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}

  <fieldset><legend>Who's watching?</legend>
    <label class="visually-hidden" for="name">Your name</label>
    <input type="text" id="name" name="name" maxlength="40" value="${user.name === 'Guest' ? '' : user.name}" placeholder="Your name"></fieldset>

  <fieldset><legend>What kind of night?</legend>
    <div class="radio-tiles">${Object.entries(MOODS).map(([k, m]) => chip('radio', 'mood', k, m.label, p.mood === k))}${chip('radio', 'mood', '', 'Not sure', !p.mood)}</div></fieldset>

  <fieldset><legend>What do you love?</legend>
    <div class="chips">${pickGenres.map((g) => chip('checkbox', 'genres', g, g, p.genres.includes(g)))}</div></fieldset>

  <fieldset><legend>Films you loved</legend>
    ${picker({ name: 'loved', label: 'Ones you would watch again', help: 'This teaches the agent more than anything else.' })}
    <details class="more"><summary>Also tell it what to avoid</summary>
      <div style="margin-top:14px">${picker({ name: 'disliked', label: 'Films that missed', help: 'It steers away from lookalikes.' })}</div>
      <div style="margin-top:14px">${picker({ name: 'watched', label: 'Already seen', help: 'These will not be recommended.' })}</div>
      ${saved ? html`<p class="help">${saved} film${saved === 1 ? '' : 's'} already saved. Anything here is on top of that.</p>` : ''}
    </details></fieldset>

  <fieldset><legend>How long have you got?</legend>
    <label class="visually-hidden" for="rt">Maximum runtime</label>
    <select id="rt" name="maxRuntime">${RUNTIMES.map(([v, l]) => html`<option value="${v}" ${String(p.maxRuntime ?? '') === v ? raw('selected') : ''}>${l}</option>`)}</select></fieldset>

  <fieldset><legend>Anything you can't watch?</legend>
    <p class="help">Filters, not preferences. Nothing breaking one gets recommended.</p>
    <div class="chips">${pickGenres.map((g) => chip('checkbox', 'hardNoGenres', g, g, p.avoidGenres.includes(g), 'no'))}</div>
    <details class="more"><summary>Content and keywords</summary>
      <p class="help" style="margin-top:12px">Read from themes and review text, so it can miss things.</p>
      <div class="chips">${Object.entries(CONTENT_FLAGS).map(([k, f]) => chip('checkbox', 'avoidFlags', k, f.label, (p.avoidFlags ?? []).includes(k), 'no'))}</div>
      <label class="field" for="terms" style="margin-top:14px">Words that rule a film out</label>
      <input type="text" id="terms" name="hardNoTerms" value="${(p.hardNoTerms ?? []).join(', ')}" placeholder="clown, zombie, musical">
    </details></fieldset>

  ${showImport ? html`<fieldset><legend>Bring your history?</legend>
    <p class="help">Optional. Upload a Letterboxd export and skip the typing.</p>
    <input type="file" name="importCsv" accept=".csv,text/csv" aria-label="Letterboxd export file">
    <label class="field" for="kind" style="margin-top:12px">What is it?</label>
    <select id="kind" name="importKind"><option value="auto">Ratings or watched</option><option value="watchlist">Watchlist</option></select>
    <details class="more"><summary>Where to find it</summary><p class="help" style="margin-top:10px">Letterboxd → Settings → Import &amp; Export → Export your data. Use ratings.csv. Read once; only recognized films are saved.</p></details></fieldset>` : ''}

  <div class="center" data-submit style="margin-top:22px">${ticket({ tag: 'button', label: submitLabel, admit: 'Screening', sub: '', stub: 'Start' })}</div>
</form>`;
}

// ---------- follow-up questions ----------
export function askView({ job, provenance }) {
  return layout({
    title: 'A quick question',
    provenance,
    body: html`
<h1 class="center">One question first</h1>
<p class="center help">I only ask when I cannot safely guess.</p>
${job.notes.length ? html`<div class="banner">${job.notes.map((n) => html`<div>${n}</div>`)}</div>` : ''}
<form class="paper" method="post" action="/run/${job.id}/answers" data-scenes>
  ${job.questions.map((q) => html`<fieldset><legend>${q.text}</legend><p class="help">${q.why}</p>
    <div class="radio-tiles">${q.options.map((o, i) => chip('radio', q.id, o.value, o.label, false))}</div></fieldset>`)}
  <div class="center" data-submit>${ticket({ tag: 'button', label: 'Continue', admit: 'Answer', sub: '', stub: 'Go' })}</div>
</form>`,
  });
}

// ---------- live agent log ----------
export function runView({ job, provenance }) {
  const steps = job.trace?.steps ?? [];
  const headExtra = raw('<noscript><meta http-equiv="refresh" content="2"></noscript>');
  return layout({
    title: 'The agent is working',
    provenance,
    headExtra,
    body: html`
<h1 class="center">Now developing</h1>
<p class="center help">${job.mode === 'judge' ? 'The whole walkthrough, start to finish.' : 'Every step is logged below.'}</p>
${job.banner ? html`<div class="banner">${job.banner}</div>` : ''}
<div class="log" id="run" data-status="/run/${job.id}/status" data-results="${job.resultsUrl}" data-seen="${steps.length}" aria-live="polite">
  <ol id="steps">${steps.map((s) => html`<li class="${s.status === 'warn' ? 'warn' : ''}"><span class="n">${String(s.n).padStart(2, '0')}</span><span><span class="tool">${s.tool.replaceAll('_', ' ')}</span> — ${s.summary}</span></li>`)}</ol>
  <div class="now" id="now">${job.trace?.current ?? 'Getting started'}</div>
</div>
<p class="center small muted" style="margin-top:18px">First run takes a few seconds: one page at a time, politely. Repeats are cached.</p>`,
  });
}

export function errorView({ message, provenance, status = 500 }) {
  return layout({
    title: 'Something went wrong',
    provenance,
    body: html`<div class="paper"><h2>${status === 404 ? 'Nothing playing here' : 'The projector jammed'}</h2><p>${message}</p><p><a class="btn" href="/mode">Back to the lobby</a></p></div>`,
  });
}

// ---------- results ----------
function ratingsTable(pick) {
  const rows = pick.ratings.sources.map((s) => {
    const isPct = s.source === 'rottentomatoes' || s.source === 'rt-audience';
    const shown = isPct ? pct(s.value) : `${s.value.toFixed(1)}/10`;
    const votes = s.votes != null ? `${s.votes.toLocaleString('en-US')}${s.votesAtLeast ? '+' : ''}` : s.votesProxy ? 'popular film (est.)' : 'n/a';
    return html`<tr><td>${s.label}</td><td><span class="scorebar"><i style="width:${Math.round(s.value * 10)}%"></i></span>${shown}</td><td>${votes}</td><td>${s.kind === 'critic' ? 'critics' : 'audience'}</td><td class="small">${s.basis === 'dataset snapshot' ? 'dataset snapshot' : s.basis ?? ''}</td></tr>`;
  });
  return html`<table class="ratings"><thead><tr><th>Source</th><th>Score</th><th>Ratings counted</th><th>From</th><th>Freshness</th></tr></thead><tbody>${rows}</tbody></table>
  ${pick.ratings.conflict ? html`<div class="callout"><strong>Sources disagree.</strong> ${pick.ratings.note}</div>` : pick.ratings.sources.length > 1 ? html`<div class="callout good">Sources agree closely (combined ${pick.ratings.consensus.toFixed(1)}/10).</div>` : html`<p class="small muted">Only one rating source could be checked for this film.</p>`}`;
}

function sourceLinks(pick) {
  const s = pick.sourceStatus ?? {};
  const links = [];
  if (s.letterboxd?.url && s.letterboxd.status === 'ok') links.push(html`<a href="${safeUrl(s.letterboxd.url)}" rel="noopener noreferrer" target="_blank">Letterboxd page</a>`);
  if (s.rottentomatoes?.url && s.rottentomatoes.status === 'ok') links.push(html`<a href="${safeUrl(s.rottentomatoes.url)}" rel="noopener noreferrer" target="_blank">Rotten Tomatoes page</a>`);
  const trail = Object.entries(s).map(([k, v]) => html`<li>${{ letterboxd: 'Letterboxd', rottentomatoes: 'Rotten Tomatoes', omdb: 'OMDb' }[k] ?? k}: ${v.status}${v.cached ? ' (cached)' : ''}${v.reason ? ` — ${v.reason}` : ''}</li>`);
  return html`<details class="more"><summary>Where this came from</summary><ul class="clean small">${trail}</ul>${links.length ? html`<p class="small">${links.map((l, i) => html`${i ? ' · ' : ''}${l}`)}</p>` : ''}</details>`;
}

function feedbackForms({ pick, job, members, group }) {
  const action = `/results/${job.id}/feedback`;
  const who = group ? html`<label class="visually-hidden" for="who-${pick.movie.id}">Who is answering</label><select id="who-${pick.movie.id}" name="who" aria-label="Who is answering">${members.map((m) => html`<option value="${m.userId}">${m.name}</option>`)}</select>` : '';
  const id = pick.movie.id;
  return html`<div class="actions" role="group" aria-label="Your reaction to ${pick.movie.title}">
  <form method="post" action="${action}"><input type="hidden" name="movie" value="${id}"><input type="hidden" name="action" value="watched">
    <button class="btn" type="submit">${icon('eye')} ${group ? 'We watched it' : 'Watched'}</button>
    ${group ? '' : html`<select name="verdict" aria-label="How was it?"><option value="">How was it?</option><option value="liked">Loved it</option><option value="meh">It was okay</option><option value="disliked">Did not like it</option></select>`}</form>
  ${group ? '' : html`<form method="post" action="${action}"><input type="hidden" name="movie" value="${id}"><input type="hidden" name="action" value="want"><button class="btn secondary" type="submit">${icon('bookmark')} Want to watch</button></form>`}
  <form method="post" action="${action}"><input type="hidden" name="movie" value="${id}"><input type="hidden" name="action" value="up">${who}<button class="btn secondary" type="submit">${icon('up')} Thumbs up</button></form>
  <form method="post" action="${action}"><input type="hidden" name="movie" value="${id}"><input type="hidden" name="action" value="down">${who}
    <select name="reason" aria-label="Why the thumbs down?"><option value="not-my-taste">Not my taste</option><option value="wrong-mood">Wrong mood</option><option value="too-long">Too long</option><option value="seen-it">I have seen it</option><option value="other">Something else</option></select>
    <button class="btn secondary" type="submit">${icon('down')} Thumbs down</button></form>
</div>`;
}

// This dataset has no artwork, so a film gets a typographic frame rather than an
// invented poster. Hidden from assistive tech: the title and year are already in
// the heading and the meta line right next to it.
function filmFrame(movie, runtime) {
  const edge = [movie.year ?? '----', runtime ? `${runtime} MIN` : 'RUNTIME N/A'].join(' · ');
  return html`<figure class="frame" aria-hidden="true">
  <span class="frame__stock"><span class="frame__title">${movie.title}</span></span>
  <figcaption class="frame__cap">${edge}${movie.directors?.[0] ? html`<br>DIR. ${movie.directors[0]}` : ''}</figcaption>
</figure>`;
}

// Exported for the judge walkthrough, which renders picks outside resultsView.
export function pickCard({ pick, job, members, group, readOnly, backup }) {
  const m = pick.movie;
  const meta = [m.year, pick.runtime.minutes ? `${pick.runtime.minutes} min` : 'runtime unknown', m.directors?.[0] ? `dir. ${m.directors[0]}` : null].filter(Boolean).join(' · ');
  const body = html`
  <p class="meta">${meta}${m.cast?.length ? html`<br>With ${m.cast.slice(0, 3).join(', ')}` : ''}</p>
  <div class="tags">${m.genres.map((g) => html`<span class="tag">${g}</span>`)}${group ? html`<span class="tag ${pick.groupLabel === 'Consensus' ? 'good' : pick.groupLabel === 'Compromise' ? 'warn' : ''}">${pick.groupLabel}</span>` : ''}<span class="tag ${pick.confidence.label === 'High' ? 'good' : pick.confidence.label === 'Low' ? 'warn' : ''}">Confidence: ${pick.confidence.label}</span></div>
  ${pick.angle ? html`<p class="small muted">${pick.angle}.</p>` : ''}
  ${m.overview ? html`<p class="synopsis">${m.overview}</p>` : ''}
  ${group ? html`<h4>Fit for each person</h4><div class="fitbars">${pick.perMember.map((p) => html`<div class="fitbar"><span>${p.name}</span><span class="track"><i class="fill" style="width:${Math.round(p.fit * 100)}%"></i></span><span>${Math.round(p.fit * 100)}%</span></div>`)}</div>${pick.favors ? html`<p class="small muted">Leans toward ${pick.favors}'s taste.</p>` : ''}` : ''}
  <h4>Why</h4>
  <ul class="clean">${pick.reasons.map((r) => html`<li><span class="reason-tag">${r.signal}</span>${r.text}</li>`)}</ul>
  <h4>Drawbacks</h4>
  <ul class="clean drawbacks">${pick.drawbacks.map((d) => html`<li>${d}</li>`)}</ul>
  <details class="more"><summary>Ratings and reviews</summary>
    <div style="margin-top:14px">
      ${ratingsTable(pick)}
      ${pick.reviews.points.length ? html`<h4>What people say</h4><ul class="clean">${pick.reviews.points.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
      ${pick.reviews.quote ? html`<blockquote class="quote">“${pick.reviews.quote.text}”<cite>${pick.reviews.quote.user}, Letterboxd (${pick.reviews.quote.likes.toLocaleString('en-US')} likes)</cite></blockquote>` : ''}
      <p class="small muted">${pick.reviews.basis}</p>
    </div></details>
  ${sourceLinks(pick)}`;
  return html`<article class="paper pick ${backup ? 'backup' : 'primary'}" aria-label="${pick.label}: ${m.title}">
  <span class="ribbon">${pick.label}</span>
  ${filmFrame(m, pick.runtime.minutes)}
  <h2>${m.title}</h2>
  ${backup ? html`<details class="more"><summary>Details</summary>${body}</details>` : body}
  ${readOnly ? '' : feedbackForms({ pick, job, members, group })}
</article>`;
}

export function resultsView({ job, provenance, readOnly = false, titleOverride = null }) {
  const r = job.result;
  const group = r.mode === 'group';
  const members = group ? r.participants : [];
  const ch = r.changes;
  const [primary, ...backups] = r.picks;
  const header = group
    ? html`<h1 class="center">Tonight's programme for the room</h1><p class="center">Picked for ${r.participants.map((p) => p.name).join(', ')} · ${r.setting === 'online' ? 'watching online' : 'watching in person'}</p>`
    : html`<h1 class="center">Tonight's programme</h1><p class="center">One main pick and two backups, each with reasons.</p>`;
  return layout({
    title: titleOverride ?? "Tonight's programme",
    provenance,
    body: html`
${header}
${job.banner ? html`<div class="banner"><strong>Recommendations updated.</strong> ${job.banner}${ch ? html` ${ch.primaryChanged ? html`Your main pick changed from <strong>${ch.primaryBefore}</strong> to <strong>${ch.primaryAfter}</strong>.` : html`Your main pick stays <strong>${ch.primaryAfter}</strong>.`}${ch.added.length ? html` New in the lineup: ${ch.added.join(', ')}.` : ''}${ch.removed.length ? html` Out of the lineup: ${ch.removed.join(', ')}.` : ''}` : ''}</div>` : ''}
${job.notes?.length || r.notes?.length ? html`<div class="banner ${r.notes?.some((n) => /Not included|skipped/i.test(n)) ? 'warn' : ''}">${[...(job.notes ?? []), ...(r.notes ?? [])].map((n) => html`<div>${n}</div>`)}</div>` : ''}
${group && r.excluded?.length ? html`<div class="banner warn"><strong>Left out:</strong> ${r.excluded.map((e) => `${e.name} ${e.reason}`).join('; ')}.</div>` : ''}
${group ? html`<div class="paper dark"><h3>How the group was balanced</h3><p class="small">${Object.keys(r.constraints.avoidedGenres).length ? `Hard no genres: ${Object.entries(r.constraints.avoidedGenres).map(([g, who]) => `${g} (${who.join(', ')})`).join(', ')}. ` : ''}${r.constraints.maxRuntime ? `Shortest runtime limit in the room: ${r.constraints.maxRuntime} minutes. ` : ''}${r.fairness.map((f) => `${f.name} averages ${Math.round(f.averageFit * 100)}% fit`).join(', ')}.</p></div>` : ''}
${primary ? pickCard({ pick: primary, job, members, group, readOnly, backup: false }) : html`<div class="paper"><h2>No matches</h2><p>Nothing survived the constraints. Loosen a hard no or the runtime and try again.</p><p><a class="btn" href="${group ? '/mode' : '/solo'}">Adjust preferences</a></p></div>`}
${backups.length ? html`<h2 class="center" style="margin-top:34px">If that is not it</h2><div class="backups">${backups.map((b) => pickCard({ pick: b, job, members, group, readOnly, backup: true }))}</div>` : ''}
<div class="filmstrip" aria-hidden="true"></div>
<details class="paper dark"><summary style="cursor:pointer;font-family:var(--type);letter-spacing:.08em;text-transform:uppercase">How the agent got here (${r.trace.length} steps, ${Math.round((r.ms ?? 0) / 100) / 10}s)</summary>
  <div class="log" style="margin-top:12px"><ol>${r.trace.map((s) => html`<li class="${s.status === 'warn' ? 'warn' : ''}"><span class="n">${String(s.n).padStart(2, '0')}</span><span><span class="tool">${s.tool.replaceAll('_', ' ')}</span> — ${s.summary}</span></li>`)}</ol></div></details>
${readOnly ? '' : html`<p class="center">${group ? html`<a class="btn secondary" href="/room/${r.roomCode}">Back to the room</a>` : html`<a class="btn secondary" href="/solo">Change my preferences</a> <a class="btn secondary" href="/shelf">My shelf</a>`}</p>`}`,
  });
}

export function soloView({ user, genres, saved, provenance }) {
  return layout({
    title: 'Your preferences',
    current: '/mode',
    provenance,
    body: html`
<h1 class="center">Tell us your taste</h1>
${prefsForm({ action: '/solo', user, genres, heading: '', intro: '', submitLabel: 'Show me what to watch', saved })}`,
  });
}
