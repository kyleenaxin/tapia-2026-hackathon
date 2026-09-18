import { html, raw } from './html.js';
import { layout, ticket } from './layout.js';
import { prefsForm } from './views.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const ACTION_LABEL = { watch: 'Watch it', maybe: 'Maybe', skip: 'Skip', 'already-seen': 'Already seen' };

// What the agent noticed when someone in the room added a movie.
export function activityItem(a) {
  const d = a.diff;
  const changes = [
    ...d.added.map((x) => html`New in your top 10: <strong>${x.movie.title}</strong> at #${x.to}`),
    ...d.rose.map((x) => html`Moved up: ${x.movie.title}, #${x.from} to #${x.to}`),
    ...d.fell.map((x) => html`Moved down: ${x.movie.title}, #${x.from} to #${x.to}`),
    ...d.dropped.map((x) => html`Dropped out: ${x.movie.title} (was #${x.from})`),
  ];
  const list = (arr) => html`<ol class="snap">${arr.slice(0, 6).map((m) => html`<li ${m.id === a.movie.id ? raw('style="font-weight:700;color:var(--velvet)"') : ''}>${m.title}</li>`)}</ol>`;
  return html`<div class="paper" style="margin:14px 0">
  <div class="tags"><span class="tag ${a.action === 'watch' ? 'good' : a.action === 'skip' ? 'warn' : ''}">${ACTION_LABEL[a.action]}</span></div>
  <h3>${a.headline}</h3>
  ${a.movieScore?.before != null ? html`<p class="small muted">Fit score for you: ${a.movieScore.before} before, ${a.movieScore.after} now. Rank ${a.movieRank.before ?? 'n/a'} to ${a.movieRank.after ?? 'n/a'} of ${a.movieRank.of.toLocaleString('en-US')}.</p>` : ''}
  ${a.trust ? html`<p class="small muted">${a.actorName}'s influence on you is ${pct(a.trust.trust)}${a.trust.overlap >= 2 ? `, because you agreed on ${pct(a.trust.agreement)} of ${a.trust.overlap} films you both rated` : ' (a default, since you have fewer than 2 rated films in common)'}.</p>` : ''}
  ${a.reasoning.length ? html`<ul class="clean">${a.reasoning.map((r) => html`<li>${r}</li>`)}</ul>` : ''}
  ${a.tradeoffs.length ? html`<ul class="clean drawbacks">${a.tradeoffs.map((t) => html`<li>${t}</li>`)}</ul>` : ''}
  ${a.closestInYourHistory.length ? html`<h4>Closest in your history</h4><ul class="clean small">${a.closestInYourHistory.map((c) => html`<li>${c.movie.title}, ${pct(c.similarity)} similar${c.yourVerdict ? `, you ${c.yourVerdict} it` : ''}${c.shares.length ? ` (shares ${c.shares.join(', ')})` : ''}</li>`)}</ul>` : ''}
  <h4>What changed in your list</h4>
  <div class="two-col"><div><div class="small muted">Before</div>${list(a.snapshots.before)}</div><div><div class="small muted">After</div>${list(a.snapshots.after)}</div></div>
  ${changes.length ? html`<ul class="clean small" style="margin-top:8px">${changes.map((c) => html`<li>${c}</li>`)}</ul>` : html`<p class="small muted">Your top 10 did not change.</p>`}
  ${a.alsoConsider.length ? html`<h4>Watch it, and others like it</h4><ul class="clean small">${a.alsoConsider.map((c) => html`<li>${c.movie.title} (${c.movie.year}), ${c.why}${c.yourRank ? `; #${c.yourRank} for you` : ''}</li>`)}</ul>` : ''}
</div>`;
}

// ---------- group ----------
export function groupNewView({ user, provenance }) {
  return layout({
    title: 'Start a screening room',
    provenance,
    body: html`
<h1 class="center">Open a screening room</h1>
<p class="center">Everyone in the room shares their taste with the room, and only the room.</p>
<form class="paper" method="post" action="/group">
  <fieldset><label class="field" for="rname">Name this movie night</label><input type="text" id="rname" name="roomName" maxlength="50" placeholder="Friday film club"></fieldset>
  <fieldset><label class="field" for="name">Your name</label><input type="text" id="name" name="name" maxlength="40" required value="${user.name === 'Guest' ? '' : user.name}" placeholder="Your name"></fieldset>
  <fieldset><legend>Where are you watching?</legend>
    <div class="radio-tiles"><label class="chip"><input type="radio" name="setting" value="in-person" checked><span>In person, same room</span></label><label class="chip"><input type="radio" name="setting" value="online"><span>Online, apart</span></label></div>
    <p class="help">In person, you can add people on this device. Online, share the invite link and everyone answers on their own screen.</p></fieldset>
  <div class="center">${ticket({ tag: 'button', label: 'Open the room', admit: 'Group mode', sub: 'You get a code to share', stub: 'Group' })}</div>
</form>`,
  });
}

export function roomJoinView({ room, hostName, user, provenance }) {
  return layout({
    title: `Join ${room.name}`,
    provenance,
    body: html`
<h1 class="center">You're invited</h1>
<p class="center">${hostName} opened <strong>${room.name}</strong> (room ${room.code}).</p>
<form class="paper" method="post" action="/room/${room.code}/join">
  <fieldset><label class="field" for="name">Your name</label><input type="text" id="name" name="name" maxlength="40" required value="${user.name === 'Guest' ? '' : user.name}"></fieldset>
  <div class="callout good"><strong>What joining means.</strong> The agent uses your answers and watch history to pick for the room, and other members can see your name and how well each pick fits you. Nothing is shared outside this room, and you can leave any time.</div>
  <div class="center">${ticket({ tag: 'button', label: 'Join the room', admit: 'Group mode', sub: 'Then tell us your taste', stub: 'Join' })}</div>
</form>`,
  });
}

export function roomView({ room, viewer, members, events, inviteUrl, provenance, flash }) {
  const isHost = room.hostId === viewer.id;
  const ready = members.filter((m) => m.ready);
  const canFind = isHost && ready.length >= 2;
  return layout({
    title: room.name,
    provenance,
    body: html`
<h1 class="center">${room.name}</h1>
<div class="paper center"><div class="small muted">Room code</div><div class="roomcode">${room.code}</div>
  <p class="small muted">${room.setting === 'online' ? 'Watching online' : 'Watching in person'} · hosted by ${members.find((m) => m.id === room.hostId)?.name ?? 'the host'}</p>
  <p><button class="btn secondary small" type="button" data-copy="${inviteUrl}">Copy invite link</button></p>
  <p class="small muted">${inviteUrl}</p></div>
${flash ? html`<div class="banner">${flash}</div>` : ''}
<div class="paper"><h2>Who's in</h2>
  ${members.map((m) => html`<div class="person"><div><strong>${m.name}</strong> ${m.id === room.hostId ? html`<span class="tag">Host</span>` : ''} ${m.managedBy ? html`<span class="tag">On this device</span>` : ''}
    <div class="small muted">${m.ready ? `${m.watched} film${m.watched === 1 ? '' : 's'} seen${m.genres.length ? `; likes ${m.genres.join(', ')}` : ''}${m.avoid.length ? `; hard no: ${m.avoid.join(', ')}` : ''}` : 'Has not shared their taste yet'}</div></div>
    <div class="actions" style="margin:0">${m.id === viewer.id || m.managedBy === viewer.id ? html`<a class="btn secondary small" href="/room/${room.code}/taste${m.id === viewer.id ? '' : `?as=${m.id}`}">${m.ready ? 'Edit taste' : 'Add taste'}</a>` : ''}</div></div>`)}
  ${isHost && room.setting === 'in-person' ? html`<form method="post" action="/room/${room.code}/add-person" class="actions"><label class="visually-hidden" for="pn">Name</label><input type="text" id="pn" name="name" maxlength="40" required placeholder="Add someone on this device" style="max-width:280px"><button class="btn small" type="submit">Add</button></form>` : ''}
  ${!isHost ? html`<form method="post" action="/room/${room.code}/leave" class="actions"><button class="btn secondary small" type="submit">Leave this room</button></form>` : ''}
</div>
<div class="center" style="margin:30px 0">
  ${canFind
    ? html`<form method="post" action="/room/${room.code}/find">${ticket({ tag: 'button', label: 'Find our movie', admit: 'Group screening', sub: `${ready.length} people ready`, stub: 'Go' })}</form>`
    : html`<div class="paper dark"><p>${isHost ? 'Waiting for at least two people to share their taste.' : 'Waiting for the host to start the search.'}</p></div>`}
</div>
${events.length ? html`<div class="paper dark"><h2>What roommates added</h2><p class="small muted">When someone in the room marks a movie, the agent compares it with your history.</p></div>${events.slice(0, 5).map((e) => activityItem(e.analysis))}` : ''}`,
  });
}

export function roomTasteView({ room, target, isSelf, genres, saved, provenance }) {
  return layout({
    title: `Taste for ${room.name}`,
    provenance,
    body: html`
<h1 class="center">${isSelf ? 'Your taste for movie night' : `${target.name}'s taste`}</h1>
<p class="center">Answered for room ${room.code}. Everything here is visible to the room.</p>
${prefsForm({ action: `/room/${room.code}/taste`, user: target, genres, heading: isSelf ? 'Tell us what you like' : `Asking for ${target.name}`, intro: 'Same questions as solo mode. The agent balances everyone.', submitLabel: 'Save my taste', hidden: isSelf ? {} : { as: target.id }, saved })}`,
  });
}

// ---------- shelf ----------
const VERDICT_LABEL = { liked: 'Loved it', meh: 'It was okay', disliked: 'Did not like it' };

export function shelfView({ user, watched, wants, thumbsUp, passed, events, provenance }) {
  const row = (m, extra) => html`<div class="person"><div><strong>${m.title}</strong> <span class="muted small">${m.year} · ${m.genres.slice(0, 3).join(', ')}</span></div><div class="actions" style="margin:0">${extra}</div></div>`;
  const remove = (id) => html`<form method="post" action="/shelf/remove"><input type="hidden" name="movie" value="${id}"><button class="btn secondary small" type="submit">Remove</button></form>`;
  return layout({
    title: 'My shelf',
    current: '/shelf',
    provenance,
    body: html`
<h1 class="center">${user.name === 'Guest' ? 'My shelf' : `${user.name}'s shelf`}</h1>
<p class="center">Everything the agent knows about your taste. Change anything and the next recommendation changes with it.</p>
<div class="paper"><h2>Add a film you watched</h2>
  <form method="post" action="/shelf/add" enctype="multipart/form-data">
    <div class="picker"><label class="field" for="p-title">Title</label><div class="chips-out"></div><input type="search" id="p-title" hidden placeholder="Start typing a title" autocomplete="off"><div class="suggest" role="listbox" hidden></div><textarea name="title" rows="2" placeholder="Title (year)"></textarea><p class="help nojs-help">Title, with the year in brackets if needed.</p></div>
    <div class="actions"><label class="visually-hidden" for="sv">How was it?</label><select id="sv" name="verdict"><option value="">How was it?</option><option value="liked">Loved it</option><option value="meh">It was okay</option><option value="disliked">Did not like it</option></select>
      <select name="status" aria-label="List"><option value="watched">I watched it</option><option value="watchlist">I want to watch it</option></select><button class="btn" type="submit">Add to shelf</button></div>
  </form></div>
<div class="paper"><h2>Watched (${watched.length})</h2>${watched.length ? watched.map(({ movie, entry }) => row(movie, html`<span class="tag ${entry.verdict === 'liked' ? 'good' : entry.verdict === 'disliked' ? 'warn' : ''}">${VERDICT_LABEL[entry.verdict] ?? 'No opinion yet'}</span>
  <form method="post" action="/shelf/verdict"><input type="hidden" name="movie" value="${movie.id}"><select name="verdict" aria-label="Change verdict for ${movie.title}"><option value="">No opinion</option><option value="liked" ${entry.verdict === 'liked' ? raw('selected') : ''}>Loved it</option><option value="meh" ${entry.verdict === 'meh' ? raw('selected') : ''}>It was okay</option><option value="disliked" ${entry.verdict === 'disliked' ? raw('selected') : ''}>Did not like it</option></select> <button class="btn secondary small" type="submit">Save</button></form>${remove(movie.id)}`)) : html`<p class="muted">Nothing yet. Add films above, or tell the agent in Solo mode.</p>`}</div>
<div class="paper"><h2>Want to watch (${wants.length})</h2>${wants.length ? wants.map(({ movie }) => row(movie, remove(movie.id))) : html`<p class="muted">Use "Want to watch" on any recommendation.</p>`}</div>
<div class="paper"><h2>Thumbs up (${thumbsUp.length})</h2>${thumbsUp.length ? thumbsUp.map(({ movie, fb }) => row(movie, html`<form method="post" action="/shelf/unfeedback"><input type="hidden" name="id" value="${fb.id}"><button class="btn secondary small" type="submit">Undo</button></form>`)) : html`<p class="muted">Films you liked the look of.</p>`}</div>
<div class="paper"><h2>Passed on (${passed.length})</h2>${passed.length ? passed.map(({ movie, fb }) => row(movie, html`<span class="small muted">${fb.kind.replaceAll('-', ' ')}${fb.reason ? `: ${fb.reason}` : ''}</span><form method="post" action="/shelf/unfeedback"><input type="hidden" name="id" value="${fb.id}"><button class="btn secondary small" type="submit">Undo</button></form>`)) : html`<p class="muted">Thumbs-downs are recorded here with your reason. They are never overwritten by the model.</p>`}</div>
${events.length ? html`<div class="paper dark"><h2>What roommates added</h2></div>${events.slice(0, 5).map((e) => activityItem(e.analysis))}` : ''}
<p class="center"><a class="btn" href="/solo">Get a recommendation</a></p>`,
  });
}

// ---------- about ----------
export function aboutView({ provenance, sources }) {
  return layout({
    title: 'How it works',
    current: '/about',
    provenance,
    body: html`
<h1 class="center">How Up Next works</h1>
<div class="paper"><h2>An agent, not a filter</h2>
  <p>When you ask for a movie, a small agent works through a loop: read your profile, scan the dataset, shortlist varied candidates, check live sources for the finalists, drop anything that breaks a limit (like runtime), re-rank on the new evidence, and write up why. Every tool call is shown in the log while it runs, and it is saved with the results.</p>
  <p>It stops early when the top three picks are backed by evidence, and it says so when a source could not be reached.</p></div>
<div class="paper"><h2>Where the data comes from</h2>
  <ul class="clean">
    <li><strong>Film catalog and reviews:</strong> the <a href="https://huggingface.co/datasets/pkchwy/letterboxd-all-movie-data" rel="noopener noreferrer" target="_blank">Letterboxd film dataset on Hugging Face</a> (${provenance.movieCount.toLocaleString('en-US')} films loaded here${provenance.base === 'letterboxd-hf-sample' ? ', the small sample' : ', filtered to films with a rating, at least five reviews and real engagement'}). It has ratings, genres, cast, synopses and the most-liked reviews.</li>
    <li><strong>Letterboxd film pages:</strong> live rating, number of ratings and runtime. ${sources.scraping ? 'On.' : 'Off.'}</li>
    <li><strong>Rotten Tomatoes:</strong> critics and audience scores. The agent finds the right page through Wikidata (IMDb id to Rotten Tomatoes id) and only accepts a page whose title and year match. ${sources.scraping ? 'On.' : 'Off.'}</li>
    <li><strong>OMDb:</strong> IMDb and Metacritic scores when an API key is configured. ${sources.omdb ? 'On.' : 'Off (no key).'}</li>
  </ul></div>
<div class="paper"><h2>How it treats websites</h2>
  <p>Scraping is done politely: the agent identifies itself as <code>${sources.userAgent ?? 'UpNextBot'}</code>, reads each site's <code>robots.txt</code> and never fetches a page it disallows, waits at least a second between requests to the same site, checks only a handful of pages per recommendation, and caches what it parsed for a week. It does not try to get around blocking. If a site refuses, the agent shows that and carries on with the other sources.</p>
  <p class="small muted">Sites have their own terms of service. Check them before running this publicly, and prefer official APIs where they exist.</p></div>
<div class="paper"><h2>What it does not know</h2>
  <ul class="clean drawbacks">
    <li>Streaming availability. It cannot tell you where a film is playing.</li>
    <li>What reviewers said in depth. The dataset holds only each film's most-liked reviews, which lean toward jokes, so review summaries are tentative and lean on critic and audience scores.</li>
    <li>Content warnings. Hard no's on content use themes and review text, so they can miss things.</li>
    <li>Films outside the dataset. It covers well-reviewed films, not everything ever released.</li>
  </ul></div>
<div class="paper"><h2>Privacy</h2>
  <p>Your answers live under a private cookie in this browser. In Group mode, only people in your screening room see each other's taste, and each person chooses to join. A thumbs-down or a veto is recorded with its reason, and it is never overwritten by the model.</p></div>`,
  });
}
