const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => `${Math.round(x * 100)}%`;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const state = {
  meta: null, users: [], meId: store.get('upnext.me'), me: null,
  mode: store.get('upnext.mode') || 'solo', view: 'discover',
  solo: null, group: null, feed: null, judge: null, feedback: null,
  crowd: null, search: [], searchQ: '', members: new Set(), setting: 'in-person',
  disagree: null, friendLists: {}, detail: {}, toast: null, busy: null, error: null,
};

// ---------- data loading ----------
async function loadUsers() { state.users = await api('GET', '/api/users'); }
async function loadMe() {
  state.me = state.meId ? await api('GET', `/api/users/${state.meId}`).catch(() => null) : null;
  if (!state.me) { state.meId = null; store.set('upnext.me', ''); }
}
async function loadCrowd() { state.crowd = (await api('GET', `/api/movies/crowd?userId=${state.meId}`)).movies; }
async function loadSolo() { state.busy = 'solo'; render(); state.solo = await api('GET', `/api/users/${state.meId}/recommendations?limit=8`); state.busy = null; }
async function loadFeed() { state.feed = await api('GET', `/api/users/${state.meId}/feed`); }

function toast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { if (state.toast === msg) { state.toast = null; render(); } }, 6000);
}
function invalidate() { state.solo = null; state.group = null; state.feed = null; }

// ---------- small components ----------
const meta = (m) => `${m.year ?? ''}${m.runtime ? ` · ${m.runtime} min` : ''}`;
const genreChips = (gs) => `<div class="chips">${(gs || []).map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>`;
const ratingText = (m) => (m.consensus != null ? `${m.consensus}/10` : m.rating?.consensus != null ? `${m.rating.consensus.toFixed(1)}/10` : 'no rating');

function provBanner() {
  const p = state.meta.provenance;
  const cls = p.approximate ? 'banner warn' : 'banner';
  const src = p.approximate
    ? `<strong>Sample data:</strong> ${p.movieCount} hand-entered movies with approximate ratings. Nothing here was queried from TMDB. Add the TMDB 5000 CSVs to <span class="mono">data/</span> for the real catalog.`
    : `<strong>Data:</strong> ${esc(p.base)}, ${p.movieCount.toLocaleString()} movies. Rating sources: ${esc(p.ratingSources.join(', ') || 'none')}.`;
  const live = state.meta.live;
  const liveTxt = `Live sources: OMDb ${live.omdb ? 'on' : 'off'}, TMDB reviews ${live.tmdb ? 'on' : 'off'}. Streaming availability is not checked.`;
  return `<div class="${cls}">${src} ${p.notes.filter((n) => !p.approximate || !n.startsWith('TMDB 5000 CSVs')).map(esc).join(' ')} ${liveTxt}</div>`;
}

function movieRow(m, entry, { showRemove = false } = {}) {
  const v = entry?.verdict;
  const btn = (verdict, cls, label) => `<button class="${cls}${entry?.status === 'watched' && v === verdict ? ' on' : ''}" data-act="mark" data-id="${m.id}" data-verdict="${verdict}">${label}</button>`;
  return `<div class="movie-row">
    <div class="t"><strong>${esc(m.title)}</strong> <span class="muted small">${esc(meta(m))} · ${esc(ratingText(m))}${m.votes ? ` (${m.votes.toLocaleString()} votes)` : ''}</span>${genreChips(m.genres)}</div>
    <div class="row">
      <span class="muted small">Seen it:</span>${btn('liked', 'good', 'Liked')}${btn('meh', '', 'Meh')}${btn('disliked', 'bad', 'Disliked')}
      <button class="${entry?.status === 'watchlist' ? 'on' : ''}" data-act="mark" data-id="${m.id}" data-status="watchlist">Watchlist</button>
      ${showRemove ? `<button class="ghost" data-act="unmark" data-id="${m.id}">Remove</button>` : ''}
    </div></div>`;
}

function evidence(movie) {
  const r = movie.rating;
  if (!r || !r.sources.length) return '<p class="muted small">No rating data available for this movie.</p>';
  const rows = r.sources.map((s) => `<tr><td>${esc(s.label)}${s.approximate ? ' (approx.)' : ''}</td><td>${s.value.toFixed(1)}/10</td><td>${s.votes != null ? s.votes.toLocaleString() : 'n/a'}</td><td>${esc(s.kind)}</td></tr>`).join('');
  return `<table><tr><th>Source</th><th>Rating</th><th>Votes</th><th>Type</th></tr>${rows}</table>
    <p class="small ${r.conflict ? 'tradeoff' : 'muted'}">${esc(r.note || `Combined ${r.consensus.toFixed(1)}/10 (weighted by vote count).`)}</p>
    ${movie.overview ? `<p class="small muted">${esc(movie.overview)}</p>` : ''}
    <button class="ghost" data-act="loadDetail" data-id="${movie.id}">Check reviews and other sources</button><div id="detail-${movie.id}">${detailHtml(movie.id)}</div>`;
}

function detailHtml(id) {
  const d = state.detail[id];
  if (!d) return '';
  const st = Object.entries(d.sourceStatus).map(([k, v]) => `<li><span class="tag">${esc(k)}</span>${esc(v.status)}${v.reason ? `: ${esc(v.reason)}` : ''}</li>`).join('');
  const rv = d.reviews;
  let reviews = `<p class="muted small">${esc(rv.note)}</p>`;
  if (rv.available) {
    reviews = `<p class="small">${rv.reviewCount} audience review(s)${rv.audienceAverage != null ? `, average ${rv.audienceAverage}/10` : ''}. ${rv.strengths.length ? `Praised: ${esc(rv.strengths.join(', '))}. ` : ''}${rv.weaknesses.length ? `Criticized: ${esc(rv.weaknesses.join(', '))}. ` : ''}${rv.contentConcerns.length ? `Content notes: ${esc(rv.contentConcerns.map((c) => c.concern).join(', '))}.` : ''} <span class="muted">${esc(rv.note)}</span></p>`;
  }
  return `<ul class="plain small" style="margin-top:8px">${st}</ul>${reviews}`;
}

function recCard(r, ctx) {
  const key = `${ctx}:${r.movie.id}`;
  const group = ctx === 'group';
  const badges = [
    `<span class="badge tier">${esc(r.tier)}</span>`,
    group ? `<span class="badge ${esc(r.label)}">${esc(r.label)}${r.favors ? `, leans ${esc(r.favors)}` : ''}</span>` : '',
    `<span class="badge ${esc(r.confidence.label)}">Confidence: ${esc(r.confidence.label)}</span>`,
    r.onWatchlist ? '<span class="badge">On your watchlist</span>' : '',
  ].join('');
  const bars = group ? `<div class="bars">${r.perMember.map((p) => `<div class="bar${p.seen ? ' seen' : ''}"><span>${esc(p.name)}</span><span class="track"><span class="fill" style="width:${pct(p.fit)};display:block"></span></span><span>${pct(p.fit)}</span></div>`).join('')}</div>` : '';
  const reasons = r.reasons.slice(0, group ? 6 : 5).map((x) => `<li><span class="tag ${esc(x.signal)}">${esc(x.signal)}</span>${esc(x.text)}</li>`).join('');
  const tradeoffs = r.tradeoffs.length ? `<h4>Tradeoffs</h4><ul class="plain">${r.tradeoffs.map((t) => `<li class="tradeoff">${esc(t)}</li>`).join('')}</ul>` : '';
  const alts = r.alternatives.length ? `<details><summary>Alternatives if this is not it</summary><ul class="plain small">${r.alternatives.map((a) => `<li>${esc(a.movie.title)} (${a.movie.year ?? ''}), ${pct(a.similarity)} similar by genre, keywords and rating</li>`).join('')}</ul></details>` : '';
  const actions = ctx === 'judge' ? '' : `<div class="actions">
      ${group ? '' : `<span class="lbl">I watched it:</span><button class="good" data-act="mark" data-id="${r.movie.id}" data-verdict="liked">Liked</button><button data-act="mark" data-id="${r.movie.id}" data-verdict="meh">Meh</button><button class="bad" data-act="mark" data-id="${r.movie.id}" data-verdict="disliked">Disliked</button><button data-act="mark" data-id="${r.movie.id}" data-status="watchlist">Watchlist</button>`}
      <button data-act="disagree" data-key="${esc(key)}">I disagree with this pick</button></div>${state.disagree === key ? disagreeForm(r.movie.id, ctx) : ''}`;
  return `<article class="card"><div class="rank">#${r.rank}</div><div>
    <h3>${esc(r.movie.title)} <span class="muted">${esc(meta(r.movie))}</span></h3>
    ${genreChips(r.movie.genres)}<div class="badges">${badges}</div>${bars}
    <h4>Why this pick</h4><ul class="plain">${reasons}</ul>${tradeoffs}
    <details><summary>Evidence: ratings across sources</summary>${evidence(r.movie)}</details>${alts}${actions}</div></article>`;
}

function disagreeForm(movieId, ctx) {
  return `<div class="disagree"><p class="small muted">Your disagreement is recorded with your reason. It is never overwritten by the model: the pick is removed${ctx === 'group' ? ' for the whole group' : ''} and lookalikes are down-ranked for you.</p>
    <label for="dk">What is off?</label>
    <select id="dk"><option value="not-my-taste">Not my taste</option><option value="wrong-mood">Wrong mood right now</option><option value="seen-it">I have already seen it</option><option value="other">Something else</option></select>
    <label for="dr" style="margin-top:8px">Why (optional, but it helps everyone see your reasoning)</label>
    <input type="text" id="dr" maxlength="300" placeholder="e.g. too slow, saw something similar last week">
    <div class="actions"><button class="primary" data-act="submitDisagree" data-id="${movieId}" data-ctx="${ctx}">Record disagreement</button><button class="ghost" data-act="disagree" data-key="">Cancel</button></div></div>`;
}

function trace(steps) {
  if (!steps?.length) return '';
  return `<details><summary>How the agent got here (${steps.length} steps)</summary><ol class="small">${steps.map((s) => `<li><span class="mono">${esc(s.tool)}</span> ${esc(s.summary)}</li>`).join('')}</ol></details>`;
}

const snap = (list, highlightId) => `<ol class="snap">${list.map((m) => `<li class="${m.id === highlightId ? 'hi' : ''}">${esc(m.title)}</li>`).join('')}</ol>`;

function feedItem(a) {
  const d = a.diff;
  const lines = [
    ...d.added.map((x) => `New in your top 10: <strong>${esc(x.movie.title)}</strong> at #${x.to}`),
    ...d.rose.map((x) => `Moved up: ${esc(x.movie.title)} #${x.from} to #${x.to}`),
    ...d.fell.map((x) => `Moved down: ${esc(x.movie.title)} #${x.from} to #${x.to}`),
    ...d.dropped.map((x) => `Dropped out: ${esc(x.movie.title)} (was #${x.from})`),
  ];
  return `<div class="feed-item">
    <div class="badges"><span class="badge ${esc(a.action)}">${{ watch: 'Watch it', maybe: 'Maybe', skip: 'Skip', 'already-seen': 'Already seen' }[a.action]}</span></div>
    <h3>${esc(a.headline)}</h3>
    ${a.movieScore && a.movieScore.before != null ? `<p class="small muted">Fit score for you: ${a.movieScore.before} before, ${a.movieScore.after} now. Rank ${a.movieRank.before ?? 'n/a'} to ${a.movieRank.after ?? 'n/a'} of ${a.movieRank.of}.</p>` : ''}
    ${a.trust ? `<p class="small muted">${esc(a.actorName)}'s influence on you is ${pct(a.trust.trust)}${a.trust.overlap >= 2 ? `, based on agreeing on ${pct(a.trust.agreement)} of ${a.trust.overlap} movies you both rated` : ' (default, because you share fewer than 2 rated movies)'}.</p>` : ''}
    ${a.reasoning.length ? `<ul class="plain">${a.reasoning.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${a.tradeoffs.length ? `<ul class="plain">${a.tradeoffs.map((t) => `<li class="tradeoff">${esc(t)}</li>`).join('')}</ul>` : ''}
    ${a.closestInYourHistory.length ? `<h4>Closest in your history</h4><ul class="plain small">${a.closestInYourHistory.map((c) => `<li>${esc(c.movie.title)}, ${pct(c.similarity)} similar${c.yourVerdict ? `, you ${esc(c.yourVerdict)} it` : ''}${c.shares.length ? ` (shares ${esc(c.shares.join(', '))})` : ''}</li>`).join('')}</ul>` : ''}
    <h4>What changed in your list</h4>
    <div class="cols"><div><div class="muted small">Before</div>${snap(a.snapshots.before.slice(0, 6), a.movie.id)}</div><div><div class="muted small">After</div>${snap(a.snapshots.after.slice(0, 6), a.movie.id)}</div></div>
    ${lines.length ? `<ul class="plain small" style="margin-top:8px">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p class="small muted">Your top 10 did not change.</p>'}
    ${a.alsoConsider.length ? `<h4>Watch it, and others like it</h4><ul class="plain small">${a.alsoConsider.map((c) => `<li>${esc(c.movie.title)} (${c.movie.year ?? ''}), ${esc(c.why)}${c.yourRank ? `; #${c.yourRank} for you` : ''}</li>`).join('')}</ul>` : ''}
  </div>`;
}

// ---------- views ----------
function welcomeView() {
  const users = state.users.map((u) => `<div class="person"><span><strong>${esc(u.name)}</strong> ${u.demo ? '<span class="chip">demo</span>' : ''} <span class="muted small">${u.sharing === 'friends' ? 'shares history with followers' : 'private'}</span></span><button data-act="pickUser" data-id="${u.id}">Continue as ${esc(u.name)}</button></div>`).join('');
  return `<div class="wrap">
    <div class="hero"><h1>Welcome to <span style="color:var(--accent)">Up Next</span></h1>
    <p>An agent that goes beyond genre filters. It reads your taste, cross-checks ratings from multiple sources, and tells you why each movie made the list. Then it keeps watching what your friends add.</p></div>
    <div class="modes">
      <button class="mode-card ${state.mode === 'solo' ? 'on' : ''}" data-act="setMode" data-mode="solo"><h3>Solo</h3><p>Find a movie for yourself. The agent learns your taste from what you have seen and explains every pick.</p></button>
      <button class="mode-card ${state.mode === 'together' ? 'on' : ''}" data-act="setMode" data-mode="together"><h3>Together</h3><p>Choose with friends or family, in person or online. Everyone's limits are respected and tradeoffs are made visible.</p></button>
    </div>
    <div class="panel"><h2>Who is watching?</h2>${users || '<p class="muted">No one yet. Add yourself below.</p>'}
      <div class="row" style="margin-top:12px"><div style="flex:1;min-width:200px"><label for="newname">Your name</label><input type="text" id="newname" maxlength="40" placeholder="e.g. Jamie"></div><button class="primary" data-act="createUser" style="align-self:flex-end">Get started</button></div>
      <p class="small muted" style="margin-top:12px">Just exploring? <button class="ghost" data-act="loadDemo">Load demo people (Alex, Sam, Maya, Jordan)</button> or see the <button class="ghost" data-act="pickView" data-view="judge" data-anon="1">judge walkthrough</button>.</p>
      ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}</div>
    ${provBanner()}</div>`;
}

function header() {
  const nav = [['discover', 'Recommendations'], ['taste', 'My taste'], ['friends', 'Friends'], ['judge', 'Judge view']];
  const pending = state.feed?.length ? ` (${state.feed.length})` : '';
  return `<header class="top"><div class="wrap"><span class="brand">Up <span>Next</span></span>
    <nav>${nav.map(([v, l]) => `<button class="${state.view === v ? 'on' : ''}" data-act="pickView" data-view="${v}">${l}${v === 'friends' ? pending : ''}</button>`).join('')}</nav><span class="spacer"></span>
    <div class="seg" role="group" aria-label="Mode"><button class="${state.mode === 'solo' ? 'on' : ''}" data-act="setMode" data-mode="solo">Solo</button><button class="${state.mode === 'together' ? 'on' : ''}" data-act="setMode" data-mode="together">Together</button></div>
    <label class="small" for="who" style="margin:0">Viewing as</label>
    <select id="who" data-act="switchUser">${state.users.map((u) => `<option value="${u.id}" ${u.id === state.meId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}<option value="__new">Add person...</option><option value="__out">Sign out</option></select>
  </div></header>`;
}

function soloView() {
  if (state.busy === 'solo' || !state.solo) return '<div class="spin">The agent is reading your history, checking ratings and ranking candidates...</div>';
  const s = state.solo;
  const p = s.profile;
  const tw = s.weights.taste / (s.weights.taste + s.weights.crowd);
  const removed = Object.entries(s.filtered).map(([k, v]) => `${v} ${k.replaceAll('-', ' ')}`).join(', ');
  return `<div class="panel"><div class="row between"><h2>Your watch list</h2><button data-act="refresh">Refresh</button></div>
    <p class="small muted">Based on ${p.watched} watched (${p.liked.length} liked)${p.statedGenres.length ? `, likes ${esc(p.statedGenres.join(', '))}` : ''}${p.avoidGenres.length ? `, avoids ${esc(p.avoidGenres.join(', '))}` : ''}.
    Score mix: your taste ${pct(tw)}, crowd ratings ${pct(1 - tw)}. ${removed ? `Removed: ${esc(removed)}.` : ''}</p>
    ${s.notes.map((n) => `<p class="small tradeoff">${esc(n)}</p>`).join('')}${trace(s.trace)}</div>
    ${s.recommendations.map((r) => recCard(r, 'solo')).join('') || '<p class="muted">No candidates left after your constraints. Loosen an avoid-genre or runtime limit.</p>'}`;
}

function togetherView() {
  const friends = state.me.following;
  const rows = friends.map((f) => {
    const ok = f.visible;
    return `<div class="person"><label style="margin:0;color:var(--text)"><input type="checkbox" data-act="toggleMember" data-id="${f.id}" ${state.members.has(f.id) ? 'checked' : ''} ${ok ? '' : 'disabled'}> ${esc(f.name)}</label>
      <span class="small ${ok ? 'muted' : 'tradeoff'}">${ok ? 'shares their history with you' : 'has not opted in to sharing, so they cannot be included'}</span></div>`;
  }).join('');
  let result = '';
  if (state.busy === 'group') result = '<div class="spin">Balancing everyone\'s taste and limits...</div>';
  else if (state.group) {
    const g = state.group;
    const c = g.constraints;
    const avoid = Object.entries(c.avoidedGenres).map(([genre, who]) => `${genre} (${who.join(', ')})`).join(', ');
    result = `<div class="panel"><h2>Picks for ${g.participants.map((p) => esc(p.name)).join(', ')} <span class="muted small">${g.setting === 'online' ? 'online' : 'in person'}</span></h2>
      <p class="small muted">Hard limits applied: ${avoid ? `avoid ${esc(avoid)}; ` : ''}${c.maxRuntime ? `max ${c.maxRuntime} min; ` : ''}${c.minYear ? `from ${c.minYear}; ` : ''}${!avoid && !c.maxRuntime && !c.minYear ? 'none set. ' : ''}
      Fairness: ${g.fairness.map((f) => `${esc(f.name)} averages ${pct(f.averageFit)}, least happy on ${f.timesLeastHappy} pick(s)`).join('; ')}.</p>
      ${g.notes.map((n) => `<p class="small ${/Not included/.test(n) ? 'tradeoff' : 'muted'}">${esc(n)}</p>`).join('')}${trace(g.trace)}</div>
      ${g.recommendations.map((r) => recCard(r, 'group')).join('') || '<p class="muted">Nothing survives everyone\'s limits. Loosen one and try again.</p>'}`;
  }
  return `<div class="panel"><h2>Who is watching with you?</h2>
    ${rows || '<p class="muted">Follow some friends first (Friends tab). Only people who opt in to sharing can be included.</p>'}
    <div class="row" style="margin-top:12px"><div class="seg" role="group" aria-label="Setting"><button class="${state.setting === 'in-person' ? 'on' : ''}" data-act="setSetting" data-setting="in-person">In person</button><button class="${state.setting === 'online' ? 'on' : ''}" data-act="setSetting" data-setting="online">Online</button></div>
    <button class="primary" data-act="runGroup" ${state.members.size ? '' : 'disabled'}>Find something for us</button></div>
    ${state.error ? `<p class="error">${esc(state.error)}</p>` : ''}</div>${result}`;
}

function tasteView() {
  const me = state.me;
  const prefs = me.user.prefs;
  const chips = state.meta.genres.map((g) => {
    const cls = prefs.genres.includes(g) ? 'like' : prefs.avoidGenres.includes(g) ? 'avoid' : '';
    return `<button class="chip ${cls}" data-act="cycleGenre" data-genre="${esc(g)}" aria-label="${esc(g)}: ${cls || 'neutral'}">${esc(g)}</button>`;
  }).join('');
  const opt = (v, cur, label) => `<option value="${v}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${label}</option>`;
  const entryById = new Map(me.entries.map((e) => [e.movieId, e]));
  const list = me.entries.slice().reverse().map((e) => movieRow({ ...e.movie, id: e.movieId }, e, { showRemove: true })).join('');
  const crowd = (state.crowd || []).map((m) => movieRow(m, entryById.get(m.id))).join('');
  return `<div class="panel"><h2>Tell us your taste</h2><p class="small muted">Click a genre once to like it, twice to avoid it (a hard limit), three times to clear it.</p>
    <div class="chips">${chips}</div>
    <div class="grid2" style="margin-top:14px">
      <div><label for="maxrt">Longest runtime you will sit through</label><select id="maxrt" data-act="setPref" data-key="maxRuntime">${opt('', prefs.maxRuntime, 'No limit')}${[90, 110, 130, 150].map((v) => opt(v, prefs.maxRuntime, `${v} minutes`)).join('')}</select></div>
      <div><label for="minyr">Oldest era</label><select id="minyr" data-act="setPref" data-key="minYear">${opt('', prefs.minYear, 'Any era')}${[1970, 1990, 2000, 2010].map((v) => opt(v, prefs.minYear, `${v} onward`)).join('')}</select></div>
      <div><label for="nov">Comfort zone vs. surprise me: ${pct(prefs.novelty)}</label><input type="range" id="nov" min="0" max="1" step="0.1" value="${prefs.novelty}" data-act="setNovelty"></div>
      <div><label for="share">Sharing</label><select id="share" data-act="setSharing">${opt('friends', me.user.sharing, 'People who follow me can use my history')}${opt('private', me.user.sharing, 'Private: nobody else can use my history')}</select></div>
    </div></div>
    <div class="panel"><h2>What have you seen?</h2><label for="q">Search the catalog</label><input type="text" id="q" value="${esc(state.searchQ)}" placeholder="Search by title" autocomplete="off">
      <div id="search-results">${searchHtml()}</div>
      <h4>What everyone else loves</h4><p class="small muted">Highly rated across sources. A starting point, not a personal recommendation. Mark what you have seen; the agent will weigh your reactions over the crowd's.</p>
      ${crowd || '<p class="muted">Loading...</p>'}</div>
    <div class="panel"><div class="row between"><h2>Your list (${me.entries.length})</h2><button class="primary" data-act="pickView" data-view="discover">Get recommendations</button></div>${list || '<p class="muted">Nothing yet.</p>'}</div>`;
}

function searchHtml() {
  if (!state.searchQ) return '';
  if (!state.search.length) return '<p class="muted small">No matches.</p>';
  const by = new Map(state.me.entries.map((e) => [e.movieId, e]));
  return state.search.map((m) => movieRow(m, by.get(m.id))).join('');
}

function friendsView() {
  const others = state.users.filter((u) => u.id !== state.meId);
  const following = new Set(state.me.following.map((f) => f.id));
  const people = others.map((u) => {
    const f = following.has(u.id);
    const open = state.friendLists[u.id];
    let list = '';
    if (open) list = open.hidden ? `<p class="small tradeoff">${esc(open.reason)}</p>` : `<ul class="plain small">${open.entries.map((e) => `<li>${esc(e.movie.title)} <span class="muted">${e.status === 'watchlist' ? 'on watchlist' : e.verdict ? esc(e.verdict) : 'watched'}</span></li>`).join('') || '<li class="muted">Nothing yet.</li>'}</ul>`;
    return `<div class="person"><div><strong>${esc(u.name)}</strong> <span class="muted small">${u.sharing === 'friends' ? 'shares history with followers' : 'private'}</span>${list}</div>
      <div class="row">${f ? `<button data-act="viewFriend" data-id="${u.id}">See their list</button><button data-act="unfollow" data-id="${u.id}">Unfollow</button>` : `<button class="primary" data-act="follow" data-id="${u.id}">Follow</button>`}</div></div>`;
  }).join('');
  const feed = state.feed;
  const feedHtml = !feed ? '<div class="spin">Loading...</div>' : feed.length ? feed.map((e) => feedItem(e.analysis)).join('') : `<p class="muted">Nothing yet. When someone you follow adds a movie, the agent compares it with your history and reports here. To try it, switch "Viewing as" to a friend and mark a movie as seen.</p>`;
  return `<div class="panel"><h2>People</h2><p class="small muted">Following someone only lets the agent use their list if they have chosen to share it. Private lists are never read.</p>${people || '<p class="muted">Nobody else has joined yet. Add a person from the menu, or load the demo people on the welcome screen.</p>'}</div>
    <div class="panel"><h2>What your friends added</h2>${feedHtml}</div>`;
}

function judgeView() {
  const j = state.judge;
  const fb = (state.feedback || []).filter((f) => !f.seeded);
  const recorded = `<div class="panel"><h2>Real disagreements recorded in this app</h2>${fb.length ? fb.map((f) => `<p class="small"><strong>${esc(f.movie.title)}</strong> (${esc(f.context)}, ${esc(f.kind)}): ${esc(f.reason || 'no reason given')}</p>`).join('') : '<p class="muted small">None yet for the current person. Use "I disagree with this pick" on any recommendation; it shows up here.</p>'}</div>`;
  if (state.busy === 'judge') return '<div class="spin">Running the walkthrough on a throwaway copy...</div>';
  if (!j) return `<div class="panel"><h2>Judge walkthrough</h2><p>Three things to show: a recommendation with its reasoning, what changed when a friend added a movie, and a recommendation a human disagreed with.</p>
    <p class="small muted">This runs on demo people (Alex, Sam, Maya, Jordan) in a throwaway copy, so your own data is untouched.</p><button class="primary" data-act="runJudge">Run walkthrough</button></div>${state.me ? recorded : ''}${provBanner()}`;
  const d = j.disagreement;
  const rec = j.recommendation.result;
  return `<div class="panel row between"><h2>Judge walkthrough</h2><button data-act="runJudge">Run again</button></div>${provBanner()}
    <div class="panel"><h2>1. A recommendation, with its reasoning</h2><p class="small muted">Solo mode for ${esc(j.recommendation.forName)}. Score mix: taste ${pct(rec.weights.taste / (rec.weights.taste + rec.weights.crowd))}, crowd ratings ${pct(rec.weights.crowd / (rec.weights.taste + rec.weights.crowd))}.</p>${trace(rec.trace)}</div>
    ${rec.recommendations.slice(0, 3).map((r) => recCard(r, 'judge')).join('')}
    <div class="panel"><h2>2. What changed when a friend added a movie</h2>${j.friendAdded ? `<p class="small muted">Sam (a friend Alex follows, who shares) just added a movie. Alex's agent reacts:</p>${feedItem(j.friendAdded)}` : '<p class="muted">No suitable friend pick in this catalog.</p>'}</div>
    <div class="panel"><h2>3. A recommendation a human disagreed with</h2>${d ? `<div class="banner warn"><strong>Illustrative example.</strong> ${esc(d.note)}</div>
      <p>Together mode picked <strong>${esc(d.contested.movie.title)}</strong> (${esc(d.contested.label)}) for Alex, Sam and Maya. ${esc(d.disagreedBy)} disagreed: <em>"${esc(d.feedback.reason)}"</em></p>
      <div class="cols"><div><div class="muted small">Before</div><ol class="snap">${d.before.map((r) => `<li class="${r.title === d.contested.movie.title ? 'hi' : ''}">${esc(r.title)} <span class="muted">${esc(r.label)}</span></li>`).join('')}</ol></div><div><div class="muted small">After</div><ol class="snap">${d.after.map((r) => `<li>${esc(r.title)} <span class="muted">${esc(r.label)}</span></li>`).join('')}</ol></div></div>
      <p class="small muted" style="margin-top:8px">${esc(d.howItIsRepresented)}</p>
      <p class="small muted">Jordan follows no one and is private, so Alex could not include them: ${esc(d.excluded.map((e) => `${e.name} ${e.reason}`).join('; ') || 'nobody was excluded')}.</p>` : '<p class="muted">No group pick was available.</p>'}</div>
    ${state.me ? recorded : ''}`;
}

function shell(content) {
  return `${header()}<main class="wrap">${state.toast ? `<div class="banner" role="status">${esc(state.toast)}</div>` : ''}${content}</main>`;
}

function render() {
  const app = $('#app');
  if (!state.meta) { app.innerHTML = '<div class="spin">Loading...</div>'; return; }
  const focus = document.activeElement?.id;
  if (!state.me) {
    app.innerHTML = state.view === 'judge' ? `<div class="wrap" style="padding-top:16px"><button data-act="pickView" data-view="discover">Back</button>${judgeView()}</div>` : welcomeView();
  } else {
    let content;
    if (state.view === 'taste') content = tasteView();
    else if (state.view === 'friends') content = friendsView();
    else if (state.view === 'judge') content = judgeView();
    else content = state.mode === 'solo' ? soloView() : togetherView();
    app.innerHTML = shell(content);
  }
  if (focus === 'q') { const q = $('#q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

// ---------- actions ----------
async function refreshView() {
  invalidate();
  if (state.view === 'taste') await loadCrowd();
  if (state.view === 'discover' && state.mode === 'solo') await loadSolo();
  if (state.view === 'friends') await loadFeed();
  if (state.view === 'judge') state.feedback = await api('GET', `/api/feedback?userId=${state.meId}`);
  render();
}

async function enterView(view) {
  state.view = view;
  state.error = null;
  render();
  try {
    if (view === 'taste') await loadCrowd();
    if (view === 'discover' && state.mode === 'solo' && !state.solo) await loadSolo();
    if (view === 'friends') { await loadMe(); await loadFeed(); }
    if (view === 'judge' && state.meId) state.feedback = await api('GET', `/api/feedback?userId=${state.meId}`);
  } catch (e) { state.error = e.message; state.busy = null; }
  render();
}

async function afterUserChange() {
  await loadUsers(); await loadMe(); invalidate(); state.members = new Set(); state.friendLists = {}; state.disagree = null;
  await enterView(state.me && state.me.profile.watched === 0 && !state.me.user.prefs.genres.length ? 'taste' : 'discover');
}

const actions = {
  async setMode({ mode }) {
    state.mode = mode; store.set('upnext.mode', mode);
    if (state.me) { state.view = 'discover'; await enterView('discover'); } else render();
  },
  async pickView({ view }) { await enterView(view); },
  async pickUser({ id }) { state.meId = id; store.set('upnext.me', id); await afterUserChange(); },
  async createUser() {
    const name = $('#newname').value;
    try {
      const u = await api('POST', '/api/users', { name });
      state.meId = u.id; store.set('upnext.me', u.id); await afterUserChange();
    } catch (e) { state.error = e.message; render(); }
  },
  async loadDemo() { await api('POST', '/api/demo/seed'); await loadUsers(); state.error = null; render(); },
  async switchUser(_, el) {
    if (el.value === '__new') { const name = prompt('Name of the new person?'); if (name) { try { const u = await api('POST', '/api/users', { name }); state.meId = u.id; store.set('upnext.me', u.id); await afterUserChange(); } catch (e) { toast(e.message); } } else render(); return; }
    if (el.value === '__out') { state.meId = null; state.me = null; store.set('upnext.me', ''); await loadUsers(); state.view = 'discover'; render(); return; }
    state.meId = el.value; store.set('upnext.me', el.value); await afterUserChange();
  },
  async cycleGenre({ genre }) {
    const p = state.me.user.prefs;
    let genres = p.genres.filter((g) => g !== genre); let avoid = p.avoidGenres.filter((g) => g !== genre);
    if (!p.genres.includes(genre) && !p.avoidGenres.includes(genre)) genres.push(genre);
    else if (p.genres.includes(genre)) avoid.push(genre);
    await api('PATCH', `/api/users/${state.meId}`, { prefs: { genres, avoidGenres: avoid } });
    await loadMe(); invalidate(); render();
  },
  async setPref({ key }, el) { await api('PATCH', `/api/users/${state.meId}`, { prefs: { [key]: el.value ? Number(el.value) : null } }); await loadMe(); invalidate(); render(); },
  async setNovelty(_, el) { await api('PATCH', `/api/users/${state.meId}`, { prefs: { novelty: Number(el.value) } }); await loadMe(); invalidate(); render(); },
  async setSharing(_, el) { await api('PATCH', `/api/users/${state.meId}`, { sharing: el.value }); await loadMe(); toast(el.value === 'private' ? 'Your history is now private. Friends\' agents can no longer use it.' : 'People who follow you can now use your history in their recommendations.'); },
  async mark({ id, verdict, status }) {
    const r = await api('POST', `/api/users/${state.meId}/entries`, { movieId: Number(id), status: status || 'watched', verdict: verdict || null });
    await loadMe(); invalidate();
    if (state.view === 'discover' && state.mode === 'solo') await loadSolo();
    toast(r.notified.length ? `Saved. ${r.notified.length} follower(s)' agents were notified and compared it with their history.` : 'Saved.');
  },
  async unmark({ id }) { await api('DELETE', `/api/users/${state.meId}/entries/${id}`); await loadMe(); invalidate(); render(); },
  async follow({ id }) { await api('POST', `/api/users/${state.meId}/follow`, { targetId: id }); await loadMe(); render(); },
  async unfollow({ id }) { await api('DELETE', `/api/users/${state.meId}/follow/${id}`); state.members.delete(id); delete state.friendLists[id]; await loadMe(); render(); },
  async viewFriend({ id }) {
    state.friendLists[id] = state.friendLists[id] ? undefined : await api('GET', `/api/users/${id}?as=${state.meId}`);
    render();
  },
  async refresh() { state.solo = null; await enterView('discover'); },
  toggleMember({ id }, el) { el.checked ? state.members.add(id) : state.members.delete(id); state.group = null; render(); },
  setSetting({ setting }) { state.setting = setting; state.group = null; render(); },
  async runGroup() {
    state.busy = 'group'; state.error = null; render();
    try { state.group = await api('POST', '/api/group/recommendations', { hostId: state.meId, participantIds: [...state.members], setting: state.setting, limit: 6 }); }
    catch (e) { state.error = e.message; }
    state.busy = null; render();
  },
  disagree({ key }) { state.disagree = key || null; render(); },
  async submitDisagree({ id, ctx }) {
    await api('POST', '/api/feedback', { userId: state.meId, movieId: Number(id), kind: $('#dk').value, reason: $('#dr').value, context: ctx === 'group' ? 'group' : 'solo' });
    state.disagree = null;
    if (ctx === 'group') await actions.runGroup(); else { state.solo = null; await loadSolo(); }
    toast('Recorded. Your reason is kept, the pick is removed, and lookalikes are down-ranked. The model does not override you.');
  },
  async loadDetail({ id }) { state.detail[id] = await api('GET', `/api/movies/${id}`); const el = $(`#detail-${id}`); if (el) el.innerHTML = detailHtml(id); },
  async runJudge() { state.busy = 'judge'; render(); try { state.judge = await api('POST', '/api/demo/judge'); } catch (e) { state.error = e.message; } state.busy = null; render(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.type === 'range' || el.type === 'checkbox') return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset, el).catch((err) => toast(err.message));
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !(el.tagName === 'SELECT' || el.type === 'range' || el.type === 'checkbox')) return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset, el).catch((err) => toast(err.message));
});
let searchTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  state.searchQ = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.search = state.searchQ.trim() ? await api('GET', `/api/movies/search?q=${encodeURIComponent(state.searchQ)}`) : [];
    const box = $('#search-results');
    if (box) box.innerHTML = searchHtml();
  }, 200);
});

(async function init() {
  try {
    [state.meta] = await Promise.all([api('GET', '/api/meta'), loadUsers()]);
    await loadMe();
    if (state.me) await afterUserChange(); else render();
  } catch (e) {
    $('#app').innerHTML = `<div class="wrap"><p class="error">Could not reach the server: ${esc(e.message)}</p></div>`;
  }
})();
