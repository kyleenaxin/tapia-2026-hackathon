/* Up Next front-end prototype. Plain JS, no build step, works from file://.
   Each view is a function returning an HTML string so the markup can be lifted into server-side templates.
   The ranking here is a tiny stand-in so the UI reacts to choices. It is not the real agent. */
(function () {
  'use strict';

  const FILMS = window.MOCK_FILMS;
  const BY_ID = Object.fromEntries(FILMS.map((f) => [f.id, f]));
  const CATALOG_LABEL = `the ${FILMS.length}-film prototype catalog`;

  // Mirrors src/agent/constraints.js so labels stay in step with the real app.
  const MOODS = {
    cozy: { label: 'Cozy and comforting', boost: ['Comedy', 'Family', 'Romance', 'Animation', 'Music'], dampen: ['Horror', 'War', 'Crime'] },
    thrilled: { label: 'On the edge of my seat', boost: ['Thriller', 'Mystery', 'Crime', 'Action'], dampen: ['Family', 'Music'] },
    laugh: { label: 'I want to laugh', boost: ['Comedy'], dampen: ['War', 'Horror', 'Drama'] },
    mindbend: { label: 'Something mind-bending', boost: ['Science Fiction', 'Mystery', 'Thriller'], dampen: ['Family'] },
    cry: { label: 'A good cry', boost: ['Drama', 'Romance', 'War', 'History'], dampen: ['Comedy', 'Action'] },
    scared: { label: 'Scare me', boost: ['Horror', 'Thriller', 'Mystery'], dampen: ['Family', 'Music', 'Romance'] },
    epic: { label: 'Something epic', boost: ['Adventure', 'Fantasy', 'History', 'War', 'Action', 'Science Fiction'], dampen: [] },
    inspired: { label: 'Inspired', boost: ['Drama', 'History', 'Music', 'Documentary'], dampen: ['Horror'] },
    surprise: { label: 'Surprise me', boost: [], dampen: [], novelty: 0.8 },
  };
  const FLAGS = {
    'graphic-violence': { label: 'Graphic violence or gore', re: /\b(gore|gory|graphic violence|brutal|bloody|slasher|torture|massacre|cannibal)/i },
    scary: { label: 'Jump scares or terror', re: /\b(jump ?scares?|terrifying|terrified|scariest|haunting|nightmare fuel)/i },
    sexual: { label: 'Sexual content or nudity', re: /\b(sex scenes?|nudity|erotic|sexual content|explicit)/i },
    disturbing: { label: 'Disturbing or traumatic themes', re: /\b(disturbing|traumatic|harrowing|unsettling|abuse|assault)/i },
  };
  const GENRES = ['Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Drama', 'Family', 'Fantasy', 'History', 'Horror', 'Music', 'Mystery', 'Romance', 'Science Fiction', 'Thriller', 'War'];
  const REASONS = [
    { id: 'not-my-taste', label: 'Not my taste', hint: 'Lowers similar films for you' },
    { id: 'wrong-mood', label: 'Wrong mood tonight', hint: 'Removes this pick, keeps your usual taste' },
    { id: 'seen-it', label: "I've already seen it", hint: 'Marks it as watched and does not count it against similar films' },
    { id: 'content', label: 'Content I would rather avoid', hint: 'Tell me what, and I will look for it next time' },
  ];
  const NOTE_PLACEHOLDER = 'What should I know? (optional)';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const norm = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const list = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------- state ----------------
  const blankPrefs = () => ({ mood: null, genres: [], avoid: [], flags: [], hardNo: [], novelty: 0.3, minYear: 1970, seen: [], unmatched: [] });
  const state = {
    view: 'welcome',
    name: '',
    mode: null,
    prefs: blankPrefs(),
    answers: {},
    rejected: [],
    feedback: [],
    shown: [],
    crew: null,
    thinkStep: 0,
    hash: '',
  };

  function crewSeed() {
    const seen = (pairs) => pairs.map(([id, verdict]) => ({ id, verdict }));
    const crew = [
      { key: 'alex', name: 'Alex', joined: true, prefs: { ...blankPrefs(), genres: ['Science Fiction', 'Thriller'], novelty: 0.3, seen: seen([['inception', 'liked'], ['interstellar', 'liked'], ['the-dark-knight', 'liked'], ['parasite-2019', 'liked'], ['mad-max-fury-road', 'liked'], ['mamma-mia', 'disliked']]) } },
      { key: 'sam', name: 'Sam', joined: true, prefs: { ...blankPrefs(), genres: ['Drama', 'Science Fiction'], novelty: 0.3, seen: seen([['interstellar', 'liked'], ['inception', 'liked'], ['whiplash-2014', 'liked'], ['the-martian', 'liked'], ['get-out-2017', 'liked']]) } },
      { key: 'maya', name: 'Maya', joined: true, prefs: { ...blankPrefs(), genres: ['Comedy', 'Animation', 'Family'], avoid: ['Horror'], novelty: 0.4, seen: seen([['toy-story', 'liked'], ['coco-2017', 'liked'], ['paddington-2', 'liked'], ['bridesmaids', 'liked'], ['spirited-away', 'liked'], ['inception', 'meh']]) } },
      { key: 'jordan', name: 'Jordan', joined: false, prefs: { ...blankPrefs(), genres: ['Action'], novelty: 0.2, seen: seen([['john-wick', 'liked'], ['superbad', 'liked']]) } },
    ];
    crew.forEach((m) => checkSeeds(m.name, m.prefs));
    return crew;
  }

  // Seeds are written by hand, so fail loudly if a slug drifts from the mock data.
  const checkSeeds = (label, prefs) => prefs.seen.forEach((s) => { if (!BY_ID[s.id]) console.warn(`Prototype seed "${label}" references unknown film id "${s.id}"`); });

  function demoPrefs() {
    const p = { ...blankPrefs(), mood: 'mindbend', genres: ['Science Fiction', 'Thriller'], avoid: ['Horror'], flags: ['graphic-violence'], seen: [{ id: 'inception', verdict: 'liked' }, { id: 'interstellar', verdict: 'liked' }, { id: 'mamma-mia', verdict: 'disliked' }] };
    checkSeeds('demo', p);
    return p;
  }

  // ---------------- stand-in ranking ----------------
  const flagHits = (f, flag) => {
    const re = FLAGS[flag].re;
    return (f.themes.some((t) => re.test(t)) ? 1 : 0) + (re.test(f.synopsis) ? 1 : 0) + f.reviews.filter((r) => re.test(r.text)).length;
  };
  const shares = (a, b) => a.genres.filter((g) => b.genres.includes(g));

  function hardNoReason(f, p) {
    const g = f.genres.find((x) => p.avoid.includes(x));
    if (g) return `avoids ${g}`;
    for (const t of p.hardNo) {
      if (t.length >= 3 && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(`${f.title} ${f.synopsis}`)) return `does not want "${t}"`;
    }
    for (const fl of p.flags) if (flagHits(f, fl) >= 2) return `wants to skip ${FLAGS[fl].label.toLowerCase()}`;
    return null;
  }

  function scoreFor(f, p, rejected) {
    const reasons = [];
    const cons = [];
    let raw = 0;
    const wanted = f.genres.filter((g) => p.genres.includes(g));
    if (wanted.length) { raw += wanted.length * 1.1; reasons.push(`Matches the genre${wanted.length > 1 ? 's' : ''} you picked: ${list(wanted)}.`); }
    const mood = MOODS[p.mood];
    if (mood) {
      const up = f.genres.filter((g) => mood.boost.includes(g));
      const down = f.genres.filter((g) => mood.dampen.includes(g));
      if (up.length) { raw += up.length * 0.8; reasons.push(`Fits "${mood.label.toLowerCase()}" (${list(up)}).`); }
      if (down.length) { raw -= down.length * 0.8; cons.push(`${list(down)} usually works against "${mood.label.toLowerCase()}".`); }
    }
    const liked = p.seen.filter((s) => s.verdict === 'liked').map((s) => BY_ID[s.id]).filter(Boolean);
    const disliked = p.seen.filter((s) => s.verdict === 'disliked').map((s) => BY_ID[s.id]).filter(Boolean);
    let bestLike = null;
    for (const l of liked) { const n = shares(f, l).length; if (n && (!bestLike || n > bestLike.n)) bestLike = { film: l, n }; }
    if (bestLike) { raw += bestLike.n * 0.55; reasons.push(`Shares ${list(shares(f, bestLike.film))} with ${bestLike.film.title}, which you liked.`); }
    const bestDis = disliked.find((d) => shares(f, d).length >= 2);
    if (bestDis) { raw -= 1.1; cons.push(`Similar in genre to ${bestDis.title}, which you did not like.`); }
    const rej = rejected.map((id) => BY_ID[id]).filter(Boolean).find((r) => shares(f, r).length >= 2);
    if (rej) { raw -= 0.9; cons.push(`Lowered because you turned down ${rej.title}.`); }
    if (!liked.length) {
      // With no history the agent falls back to crowd ratings and says so.
      reasons.push('You have not told me what you have watched, so this leans on how well Letterboxd members rated it.');
    }
    const novelty = MOODS[p.mood]?.novelty ?? p.novelty;
    if (liked.length && !bestLike) { raw += novelty * 0.9; reasons.push('Different from what you usually watch, which suits how adventurous you said you feel.'); }
    raw += (f.letterboxd / 10) * 1.6;
    if (f.letterboxd < 7.6) cons.push(`Rated lower than most picks here (Letterboxd ${f.letterboxd.toFixed(1)}/10).`);
    for (const fl of p.flags) if (flagHits(f, fl) === 1) cons.push(`One review or synopsis mentions "${FLAGS[fl].label.toLowerCase()}", which you asked to avoid. Worth a quick check.`);
    if (f.year < p.minYear) { raw -= 1; cons.push(`Older than the ${p.minYear} cut-off you set.`); }
    const fit = Math.max(4, Math.min(99, Math.round(38 + raw * 9)));
    return { raw, fit, reasons, cons, bestLike, wanted, mood: !!mood };
  }

  function confidenceFor(f, s) {
    let c = 0.4;
    if (s.wanted.length) c += 0.14;
    if (s.mood) c += 0.1;
    if (s.bestLike) c += 0.12;
    if (f.engagement > 50000) c += 0.08;
    c = Math.min(c, 0.78);
    return { value: c, label: c >= 0.85 ? 'High' : c >= 0.65 ? 'Good' : c >= 0.5 ? 'Medium' : 'Low' };
  }

  function rankSolo(p, rejected) {
    const seenIds = new Set(p.seen.map((s) => s.id));
    const turnedDown = new Set(rejected);
    const excluded = [];
    const pool = [];
    for (const f of FILMS) {
      if (seenIds.has(f.id) || turnedDown.has(f.id)) continue;
      const why = hardNoReason(f, p);
      if (why) { excluded.push({ film: f, why }); continue; }
      const s = scoreFor(f, p, rejected);
      pool.push({ film: f, ...s, confidence: confidenceFor(f, s) });
    }
    pool.sort((a, b) => b.raw - a.raw);
    return { picks: pool, excluded, considered: FILMS.length - seenIds.size };
  }

  function joinedMembers() {
    const host = { key: 'host', name: state.name || 'You', joined: true, host: true, prefs: state.prefs };
    return [host, ...state.crew.filter((m) => m.joined)];
  }

  function rankGroup(rejectedByGroup) {
    const members = joinedMembers();
    const excluded = [];
    const pool = [];
    for (const f of FILMS) {
      const seenBy = members.filter((m) => m.prefs.seen.some((s) => s.id === f.id));
      if (seenBy.length === members.length) continue;
      const blocker = members.map((m) => ({ m, why: hardNoReason(f, m.prefs) })).find((x) => x.why);
      if (blocker) { excluded.push({ film: f, why: `${blocker.m.name} ${blocker.why}` }); continue; }
      if (rejectedByGroup.some((r) => r.id === f.id)) continue;
      const per = members.map((m) => ({ member: m, ...scoreFor(f, { ...m.prefs, seen: m.prefs.seen }, rejectedByGroup.filter((r) => r.by === m.name).map((r) => r.id)), sawIt: seenBy.includes(m) }));
      const fits = per.map((x) => x.fit);
      const min = Math.min(...fits);
      const max = Math.max(...fits);
      const mean = fits.reduce((a, b) => a + b, 0) / fits.length;
      const score = mean * 0.55 + min * 0.45 - seenBy.length * 5;
      const lowest = per.find((x) => x.fit === min);
      const consensus = min >= 62 && max - min <= 26;
      pool.push({ film: f, per, score, min, max, mean, seenBy, consensus, lowest, confidence: confidenceFor(f, per[0]) });
    }
    pool.sort((a, b) => b.score - a.score);
    return { picks: pool, excluded, members };
  }

  // ---------------- small view helpers ----------------
  function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function poster(f, cls = '') {
    const h = hue(f.id);
    const h2 = (h + 40 + f.genres.length * 17) % 360;
    return `<div class="poster ${cls}" style="background:linear-gradient(160deg,hsl(${h} 46% 26%),hsl(${h2} 52% 12%))" role="img" aria-label="Placeholder poster for ${esc(f.title)}">
      <span class="p-note">No poster in the dataset</span>
      <span class="p-title">${esc(f.title)}</span><span class="p-year">${f.year} · ${esc(f.genres.slice(0, 2).join(' / '))}</span></div>`;
  }
  const chip = (action, value, label, pressed, extra = '') => `<button type="button" class="chip" data-action="${action}" data-value="${esc(value)}" data-key="${action}:${esc(value)}" aria-pressed="${pressed}" ${extra}>${esc(label)}</button>`;

  function ratingsBlock(f) {
    return `<div class="ratings" role="group" aria-label="Ratings by source">
      <div class="rating-row"><span class="src">Letterboxd<small>dataset snapshot · ${f.engagement.toLocaleString()} review likes as weight</small></span><span class="score">${f.letterboxd.toFixed(1)}<span class="muted small">/10</span></span><span class="badge good">Read from local index</span></div>
      <div class="rating-row off"><span class="src">Rotten Tomatoes<small>critics and audience</small></span><span class="score">-</span><span class="badge">Live check runs in the real app</span></div>
      <div class="rating-row off"><span class="src">IMDb and Metacritic<small>via OMDb</small></span><span class="score">-</span><span class="badge">Needs OMDB_API_KEY</span></div>
      <p class="conflict" style="border-top-color:var(--line);background:transparent;color:var(--muted)">Only one rating source was checked, so I cap my confidence and will not call this a consensus.</p>
    </div>`;
  }
  const meter = (c) => `<div class="meter"><span>Confidence <strong>${c.label}</strong></span><span class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(c.value * 100)}" aria-label="Confidence ${c.label}"><i style="width:${Math.round(c.value * 100)}%"></i></span></div>`;
  const quotes = (f) => f.reviews.map((r) => `<blockquote class="quote">${esc(r.text)}<cite>${esc(r.user)} on Letterboxd · ${r.likes.toLocaleString()} likes</cite></blockquote>`).join('');
  const lis = (items, ic) => items.map((t) => `<li><span class="ic" aria-hidden="true">${ic}</span><span>${esc(t)}</span></li>`).join('');

  // ---------------- views ----------------
  function stepsFor(view) {
    const solo = ['Ticket', 'Mode', 'Taste', 'Questions', 'Picks'];
    const group = ['Ticket', 'Mode', 'Taste', 'Room', 'Picks'];
    const names = state.mode === 'group' ? group : solo;
    const idx = { welcome: 0, mode: 1, prefs: 2, ask: 3, 'group-room': 3, thinking: 4, results: 4, 'group-results': 4, states: -1 }[view] ?? 0;
    return names.map((n, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}" ${i === idx ? 'aria-current="step"' : ''}>${n}</li>`).join('');
  }

  function vWelcome() {
    const open = state.opened ? ' open' : '';
    return `<section class="screen">
      <div class="stage${open}" id="stage">
        <div class="curtain l" aria-hidden="true"></div><div class="curtain r" aria-hidden="true"></div>
        <div class="bulbs" aria-hidden="true"></div>
        <div class="curtain-cta">
          <p class="eyebrow" style="letter-spacing:.4em;text-transform:uppercase;font-size:.75rem;color:var(--gold-soft)">Tonight's feature</p>
          <h1 data-focus tabindex="-1">UP <span style="color:var(--gold)">NEXT</span></h1>
          <p style="margin:0 auto 18px;max-width:38ch;color:#f0d6c0">Tell me what you feel like. I will show my work.</p>
          <button class="btn primary" data-action="open-curtains" data-key="open">Open the curtains</button>
        </div>
        <div class="marquee reveal">
          <form class="ticket" data-action="take-ticket" aria-label="Your ticket">
            <div class="ticket-main">
              <div class="fine">Up Next Cinema · Screening No. 1</div>
              <h2>Your ticket</h2>
              <label for="name">What should I call you?</label>
              <input id="name" type="text" name="name" autocomplete="given-name" maxlength="30" placeholder="Your first name" value="${esc(state.name)}" data-key="name">
              <div style="margin-top:16px"><button class="btn primary" type="submit">Take my seat</button></div>
            </div>
            <div class="ticket-stub" aria-hidden="true"><div><div class="admit">ADMIT ONE</div></div></div>
          </form>
        </div>
      </div>
    </section>`;
  }

  function vMode() {
    const who = esc(state.name || 'there');
    return `<section class="screen">
      <h2 data-focus tabindex="-1">Welcome, ${who}. How are we watching?</h2>
      <p class="muted">You can change your mind later. Nothing is saved until you finish.</p>
      <div class="mode">
        <button class="mode-card" data-action="pick-mode" data-value="solo" data-key="mode:solo">
          <div class="icon" aria-hidden="true">🎟️</div><h3>Solo</h3><p>A screening for one. I look at your mood, taste and history and pick something for you.</p>
        </button>
        <button class="mode-card" data-action="pick-mode" data-value="group" data-key="mode:group">
          <div class="icon" aria-hidden="true">🍿</div><h3>Group</h3><p>Friends or family. Everyone joins your room, hard no's are respected, and I say whether a pick is a consensus or a compromise.</p>
        </button>
      </div>
    </section>`;
  }

  function vPrefs() {
    const p = state.prefs;
    const group = state.mode === 'group';
    const moodBtns = Object.entries(MOODS).map(([k, m]) => `<button type="button" class="mood" data-action="mood" data-value="${k}" data-key="mood:${k}" aria-pressed="${p.mood === k}">${esc(m.label)}</button>`).join('');
    const seen = p.seen.map((s) => {
      const f = BY_ID[s.id];
      return `<div class="seen-item"><span><strong>${esc(f.title)}</strong> <span class="muted small">${f.year}</span></span>
        <span class="verdicts" role="group" aria-label="How was ${esc(f.title)}?">
          ${['liked', 'meh', 'disliked'].map((v) => `<button type="button" class="${v}" data-action="verdict" data-id="${s.id}" data-value="${v}" data-key="v:${s.id}:${v}" aria-pressed="${s.verdict === v}">${{ liked: 'Liked', meh: 'Meh', disliked: 'Disliked' }[v]}</button>`).join('')}
          <button type="button" class="btn ghost sm" data-action="unsee" data-id="${s.id}" data-key="unsee:${s.id}" aria-label="Remove ${esc(f.title)}">✕</button></span></div>`;
    }).join('');
    const stray = p.unmatched.map((t) => `<span class="badge warn">Not found: ${esc(t)}</span>`).join(' ');
    return `<section class="screen">
      <h2 data-focus tabindex="-1">${group ? 'First, your own taste' : 'What are you in the mood for?'}</h2>
      <p class="muted">${group ? 'Your friends add theirs in the room. Everything is optional, and the more you say, the less I have to ask.' : 'Everything is optional. The more you tell me, the fewer questions I ask.'}</p>
      <div class="form-grid">
        <div class="card stack" style="grid-column:1/-1">
          <div class="section-title"><h3>Tonight's mood</h3><span class="muted small">pick one</span></div>
          <div class="mood-grid">${moodBtns}</div>
        </div>
        <div class="card stack">
          <div class="section-title"><h3>Genres you like</h3></div>
          <div class="chips">${GENRES.map((g) => chip('genre', g, g, p.genres.includes(g))).join('')}</div>
        </div>
        <div class="card stack">
          <div class="section-title"><h3>Genres to never show</h3><span class="muted small">removed for good</span></div>
          <div class="chips avoid">${GENRES.map((g) => chip('avoid', g, g, p.avoid.includes(g))).join('')}</div>
        </div>
        <div class="card stack">
          <div class="section-title"><h3>Content and words to skip</h3></div>
          <div class="chips avoid">${Object.entries(FLAGS).map(([k, v]) => chip('flag', k, v.label, p.flags.includes(k))).join('')}</div>
          <p class="muted small">Content warnings are a heuristic over synopses, theme labels and reviews. I can miss things.</p>
          <label for="hardno">Anything else you never want? Words like "clown" or "spider"</label>
          <input id="hardno" type="text" placeholder="Type a word, press Enter" data-key="hardno" autocomplete="off">
          <div class="taglist">${p.hardNo.map((t) => `<button class="chip" type="button" aria-pressed="true" data-action="rm-hardno" data-value="${esc(t)}" data-key="rmhn:${esc(t)}">${esc(t)} <span class="x" aria-hidden="true">✕</span><span class="sr-only">remove</span></button>`).join('')}</div>
        </div>
        <div class="card stack">
          <div class="section-title"><h3>Movies you have seen</h3></div>
          <label for="seen-q">Add a title, then tell me how it went</label>
          <input id="seen-q" type="text" placeholder="Try Inception, Coco, Get Out…" autocomplete="off" data-key="seen-q" aria-describedby="seen-help" role="combobox" aria-expanded="false" aria-controls="seen-suggest">
          <div id="seen-suggest" class="suggest" hidden></div>
          <p id="seen-help" class="muted small">${esc(CATALOG_LABEL[0].toUpperCase() + CATALOG_LABEL.slice(1))} only. The real app searches about 30,000 films.</p>
          <div class="taglist">${stray}</div>
          <div class="seen-list">${seen || '<p class="muted small">Nothing yet. With no history I fall back to crowd ratings and tell you so.</p>'}</div>
        </div>
        <div class="card" style="grid-column:1/-1">
          <div class="section-title"><h3>How adventurous, and how old?</h3></div>
          <div class="form-grid" style="gap:24px">
            <div>
              <label for="novelty">Familiar comfort ↔ something new</label>
              <input id="novelty" type="range" min="0" max="100" value="${Math.round(p.novelty * 100)}" data-key="novelty" aria-valuetext="${Math.round(p.novelty * 100)} percent adventurous">
              <div class="range-labels"><span>Play it safe</span><span>Surprise me</span></div>
            </div>
            <div>
              <label for="year">Not older than</label>
              <select id="year" data-key="year">${[1950, 1970, 1990, 2000, 2010].map((y) => `<option value="${y}" ${p.minYear === y ? 'selected' : ''}>${y === 1950 ? 'Any era' : y}</option>`).join('')}</select>
              <p class="muted small" style="margin-top:8px">The dataset has no runtime or streaming availability, so I can't filter on those.</p>
            </div>
          </div>
        </div>
      </div>
      <div class="sticky-actions">
        <button class="btn ghost" data-action="goto" data-value="mode" data-key="back">Back</button>
        <span class="row"><button class="btn ghost" data-action="demo-prefs" data-key="demo">Fill in an example</button><button class="btn primary" data-action="prefs-done" data-key="next">${group ? 'Open my room' : 'Find my movie'}</button></span>
      </div>
    </section>`;
  }

  // Follow-up questions: only what would change the answer.
  function pendingQuestions() {
    const p = state.prefs;
    const qs = [];
    for (const t of p.unmatched) qs.push({ id: `unmatched:${t}`, kind: 'unmatched', text: t });
    if (!p.mood && !p.genres.length && !state.answers.mood) qs.push({ id: 'mood', kind: 'mood' });
    if (p.seen.length && !p.seen.some((s) => s.verdict === 'liked') && !state.answers.likes) qs.push({ id: 'likes', kind: 'likes' });
    return qs;
  }

  function vAsk() {
    const q = pendingQuestions()[0];
    if (!q) return '';
    let body = '';
    if (q.kind === 'unmatched') {
      body = `<h3>I couldn't find "${esc(q.text)}" in ${esc(CATALOG_LABEL)}.</h3><p class="muted">I won't guess. Skip it, or go back and try another spelling.</p>
        <div class="options"><button class="option" data-action="answer" data-q="${esc(q.id)}" data-value="skip" data-key="ans:skip">Skip it<small>I'll work without it.</small></button>
        <button class="option" data-action="goto" data-value="prefs" data-key="ans:retry">Go back and retype it</button></div>`;
    } else if (q.kind === 'mood') {
      body = `<h3>What kind of night is it?</h3><p class="muted">You didn't give me a mood or a genre, and that is the one thing that changes my answer most.</p>
        <div class="options">${['cozy', 'mindbend', 'laugh', 'thrilled'].map((k) => `<button class="option" data-action="answer" data-q="mood" data-value="${k}" data-key="ans:${k}">${esc(MOODS[k].label)}</button>`).join('')}
        <button class="option" data-action="answer" data-q="mood" data-value="none" data-key="ans:none">No preference<small>I'll lean on crowd ratings and say so.</small></button></div>`;
    } else {
      body = `<h3>Nothing you've seen was a hit. Is that right?</h3><p class="muted">I'll avoid what's similar to your disliked titles. If you actually enjoyed one, tell me which.</p>
        <div class="options"><button class="option" data-action="goto" data-value="prefs" data-key="ans:fix">Let me change a rating</button>
        <button class="option" data-action="answer" data-q="likes" data-value="ok" data-key="ans:ok">That's right, carry on</button></div>`;
    }
    return `<section class="screen"><h2 data-focus tabindex="-1" class="sr-only">A quick question</h2>
      <div class="agent-say"><div class="avatar" aria-hidden="true">UN</div><div class="bubble">${body}</div></div>
      <p class="muted small" style="margin-top:14px">${pendingQuestions().length > 1 ? `${pendingQuestions().length - 1} more after this one.` : 'Last question.'}</p></section>`;
  }

  const THINK = () => {
    const p = state.prefs;
    const res = state.mode === 'group' ? rankGroup(state.rejected.filter((r) => r.by)) : rankSolo(p, state.rejected.map((r) => r.id));
    const n = res.excluded.length;
    return [
      { on: 'ok', what: `Read ${state.mode === 'group' ? `${joinedMembers().length} people's` : 'your'} preferences`, why: p.mood ? MOODS[p.mood].label : 'no mood set' },
      { on: 'ok', what: `Searched ${CATALOG_LABEL}`, why: 'local index' },
      { on: n ? 'warn' : 'ok', what: `Applied hard no's: removed ${n} film${n === 1 ? '' : 's'}`, why: n ? 'never shown' : 'none apply' },
      { on: 'off', what: 'Rotten Tomatoes and Letterboxd live pages', why: 'not run in the prototype' },
      { on: 'off', what: 'IMDb and Metacritic via OMDb', why: 'no API key' },
      { on: 'ok', what: 'Scored the rest and wrote reasons', why: 'evidence attached to each pick' },
    ];
  };

  function vThinking() {
    const steps = THINK();
    const n = Math.min(state.thinkStep, steps.length);
    return `<section class="screen"><h2 data-focus tabindex="-1">Finding your picks…</h2>
      <p class="muted">Every step below is a real check I'm making, and skipped checks are shown as skipped.</p>
      <div class="card stack" style="max-width:640px"><div class="progress" aria-hidden="true"><i style="width:${(n / steps.length) * 100}%"></i></div>
        <ol class="trace">${steps.slice(0, n).map((s) => `<li><span class="dot ${s.on === 'ok' ? '' : s.on}"></span><span class="what">${esc(s.what)}</span><span class="why">${esc(s.why)}</span></li>`).join('')}</ol>
      </div><div class="spacer"></div><button class="btn ghost" data-action="skip-think" data-key="skip">Skip ahead</button></section>`;
  }

  function pickCard(r, isGroup) {
    const f = r.film;
    const per = isGroup ? r.per : null;
    const reasons = isGroup ? groupReasons(r) : r.reasons;
    const cons = isGroup ? groupCons(r) : r.cons;
    const label = isGroup
      ? (r.consensus ? '<span class="badge good">Consensus pick</span>' : `<span class="badge warn">Compromise: ${esc(r.lowest.member.name)} is lukewarm</span>`)
      : '';
    return `<article class="pick" aria-labelledby="pick-title">
      <div>${poster(f)}</div>
      <div>
        <div class="pick-flag"><span class="badge gold">Top pick</span>${label}</div>
        <h2 id="pick-title">${esc(f.title)}</h2>
        <p class="meta">${f.year} · ${esc(f.directors.join(', '))} · ${esc(f.genres.join(', '))}<br>With ${esc(f.cast.slice(0, 3).join(', '))}</p>
        <p>${esc(f.synopsis)}</p>
        ${meter(r.confidence)}
        <div class="split">
          <div><h4>Why it fits</h4><ul class="why-list">${lis(reasons, '✓')}</ul></div>
          <div><h4>Drawbacks and cautions</h4>${cons.length ? `<ul class="why-list cons">${lis(cons, '!')}</ul>` : '<p class="muted small">Nothing in my data counts against it for you.</p>'}</div>
        </div>
        ${isGroup ? groupFit(r) : ''}
        <h4>Ratings</h4>${ratingsBlock(f)}
        <details class="more"><summary>What Letterboxd members say</summary><div>${quotes(f)}<p class="muted small">Two of the most-liked reviews in the dataset. Not a summary of all reviews.</p></div></details>
        <div class="actions">
          <button class="btn primary" data-action="watch" data-id="${f.id}" data-key="watch">Watch this</button>
          <button class="btn danger" data-action="reject" data-id="${f.id}" data-key="reject">${isGroup ? 'Someone says no…' : 'Not this one…'}</button>
        </div>
      </div></article>`;
  }

  function groupReasons(r) {
    const best = r.per.slice().sort((a, b) => b.fit - a.fit)[0];
    const out = [];
    out.push(r.consensus ? `Everyone lands between ${r.min}% and ${r.max}% fit, so nobody is being asked to sacrifice.` : `Best for ${list(r.per.filter((x) => x.fit >= 60).map((x) => x.member.name)) || best.member.name}. ${r.lowest.member.name} is at ${r.min}%, so this is a trade-off, not a win for all.`);
    const byGenre = {};
    r.per.forEach((x) => x.wanted.forEach((g) => { (byGenre[g] = byGenre[g] || []).push(x.member.name); }));
    const asked = Object.entries(byGenre).map(([g, names]) => `${list(names)} asked for ${g}`);
    if (asked.length) out.push(`${asked.join('; ')}.`);
    out.push(`Nobody in the room has a hard no that this film breaks.`);
    return out;
  }
  function groupCons(r) {
    const out = [];
    if (r.seenBy.length) out.push(`${list(r.seenBy.map((m) => m.name))} ${r.seenBy.length > 1 ? 'have' : 'has'} already seen it. Rewatching is allowed, but I ranked it lower.`);
    if (!r.consensus) out.push(`${r.lowest.member.name}'s taste is the weakest match (${r.min}%).`);
    r.per.forEach((x) => x.cons.slice(0, 1).forEach((c) => out.push(`${x.member.name}: ${c}`)));
    return out.slice(0, 4);
  }
  function groupFit(r) {
    return `<h4>How it fits each person</h4><div class="fit">${r.per.map((x) => `<div class="fit-row"><span>${esc(x.member.name)}</span><span class="bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${x.fit}" aria-label="${esc(x.member.name)} fit ${x.fit} percent"><i class="${x.fit >= 70 ? 'hi' : x.fit < 55 ? 'low' : ''}" style="width:${x.fit}%"></i></span><span>${x.fit}%${x.sawIt ? '<span class="sr-only"> already seen</span>' : ''}</span></div>`).join('')}</div>`;
  }

  function backupCard(r, i, isGroup) {
    const f = r.film;
    const fit = isGroup ? `<span class="badge ${r.consensus ? 'good' : 'warn'}">${r.consensus ? 'Consensus' : 'Compromise'}</span>` : `<span class="badge">${r.confidence.label} confidence</span>`;
    const why = (isGroup ? groupReasons(r) : r.reasons)[0];
    const con = (isGroup ? groupCons(r) : r.cons)[0];
    return `<article class="card backup" aria-label="Backup ${i}: ${esc(f.title)}">
      <div class="backup-top">${poster(f)}
      <div><span class="rank">Backup ${i}</span><h3>${esc(f.title)} <span class="muted small">${f.year}</span></h3><div class="row" style="margin:6px 0">${fit}<span class="badge">Letterboxd ${f.letterboxd.toFixed(1)}</span></div></div></div>
      <p class="small"><strong>Why:</strong> ${esc(why)}</p>
      ${con ? `<p class="small muted"><strong>Trade-off:</strong> ${esc(con)}</p>` : ''}
      <div class="row"><button class="btn sm" data-action="promote" data-id="${f.id}" data-key="promote:${f.id}">Watch this instead</button><button class="btn sm ghost" data-action="reject" data-id="${f.id}" data-key="rej:${f.id}">${isGroup ? 'Someone says no…' : 'Not this one…'}</button></div>
    </article>`;
  }

  function vResults(isGroup) {
    const res = isGroup ? rankGroup(state.rejected.filter((r) => r.by)) : rankSolo(state.prefs, state.rejected.map((r) => r.id));
    // A promoted backup stays first until rejected.
    if (state.promoted) {
      const i = res.picks.findIndex((x) => x.film.id === state.promoted);
      if (i > 0) res.picks.unshift(res.picks.splice(i, 1)[0]);
    }
    const [top, ...rest] = res.picks;
    const p = state.prefs;
    const recap = [p.mood && MOODS[p.mood].label, ...p.genres, ...p.avoid.map((g) => `no ${g}`), ...p.flags.map((f) => `skip ${FLAGS[f].label.toLowerCase()}`)].filter(Boolean);
    state.shown = res.picks.slice(0, 3).map((x) => x.film.id);
    const head = isGroup
      ? `<h2 data-focus tabindex="-1">Tonight's group screening</h2><p class="muted">${list(res.members.map((m) => m.name))} · Room ${esc(state.crew.code)}</p>`
      : `<h2 data-focus tabindex="-1">Tonight's screening for ${esc(state.name || 'you')}</h2><div class="recap" aria-label="What I used">${recap.map((t) => `<span class="badge">${esc(t)}</span>`).join('') || '<span class="badge">No preferences: crowd ratings</span>'}</div>`;
    if (!top) {
      return `<section class="screen">${head}<div class="card"><h3>I ran out of picks.</h3><p>Your hard no's and feedback remove everything I have in ${esc(CATALOG_LABEL)}. Loosen one and I'll look again.</p><button class="btn primary" data-action="goto" data-value="prefs" data-key="loosen">Adjust preferences</button></div></section>`;
    }
    const excl = res.excluded.length ? `<details class="more"><summary>Removed before ranking (${res.excluded.length})</summary><div><p class="muted small">These never had a chance because of a hard no. I name who and why.</p><ul class="why-list cons">${res.excluded.map((e) => `<li><span class="ic" aria-hidden="true">✕</span><span><strong>${esc(e.film.title)}</strong>: ${esc(e.why)}</span></li>`).join('')}</ul></div></details>` : '';
    const trace = `<details class="more"><summary>How I got here</summary><div><ol class="trace">${THINK().map((s) => `<li><span class="dot ${s.on === 'ok' ? '' : s.on}"></span><span class="what">${esc(s.what)}</span><span class="why">${esc(s.why)}</span></li>`).join('')}</ol></div></details>`;
    const fb = state.feedback.length ? `<details class="more" open><summary>Your feedback (${state.feedback.length})</summary><div class="log">${state.feedback.map((f) => `<div class="log-item"><strong>${esc(f.title)}</strong>${f.by ? ` · ${esc(f.by)} said no` : ''}: ${esc(REASONS.find((r) => r.id === f.reason)?.label || f.reason)}${f.note ? `, "${esc(f.note)}"` : ''}<br><span class="muted small">${f.effect}</span></div>`).join('')}</div></details>` : '';
    return `<section class="screen"><div class="results-head"><div>${head}</div><div class="row"><button class="btn ghost sm" data-action="goto" data-value="prefs" data-key="adjust">Adjust preferences</button><button class="btn ghost sm" data-action="restart" data-key="restart">Start over</button></div></div>
      ${pickCard(top, isGroup)}
      <h3 style="margin-top:26px">Two backups if that doesn't land</h3>
      <div class="backups">${rest.slice(0, 2).map((r, i) => backupCard(r, i + 1, isGroup)).join('')}</div>
      ${fb}${excl}${trace}
    </section>`;
  }

  function vRoom() {
    const c = state.crew;
    const members = [{ name: state.name || 'You', host: true, joined: true, prefs: state.prefs }, ...c];
    const joined = members.filter((m) => m.joined);
    const summary = (p) => [p.genres.length ? `Likes ${list(p.genres)}` : 'No genres yet', p.avoid.length ? `Never: ${list(p.avoid)}` : null, `${p.seen.length} seen`].filter(Boolean).join(' · ');
    return `<section class="screen">
      <div class="results-head"><div><h2 data-focus tabindex="-1">Your screening room</h2><p class="muted">Share the code. Everyone joins from their own device and answers for themselves.</p></div>
        <div style="text-align:right"><div class="room-code" aria-label="Room code ${esc(c.code.split('').join(' '))}">${esc(c.code)}</div><div style="margin-top:6px"><button class="btn sm" data-action="copy-invite" data-key="copy">Copy invite link</button></div></div></div>
      <div class="people">${members.map((m) => `<div class="card person ${m.joined ? '' : 'pending'}">
        <div class="person-head"><div class="avatar" aria-hidden="true">${esc(initial(m.name))}</div><div><strong>${esc(m.name)}</strong> ${m.host ? '<span class="badge gold">Host</span>' : ''}<br>${m.joined ? '<span class="badge good">In the room</span>' : '<span class="badge">Invited, not joined</span>'}</div></div>
        ${m.joined ? `<p class="small muted">${esc(summary(m.prefs))}</p>` : `<p class="small muted">Not included yet. Their history is never used until they join and choose to share it.</p><button class="btn sm" data-action="join" data-value="${esc(m.key)}" data-key="join:${esc(m.key)}">Prototype: pretend ${esc(m.name)} joined</button>`}
      </div>`).join('')}</div>
      <div class="fair" style="margin-top:16px"><strong>How I choose for a group.</strong> A film any joined person hard-nos is removed for everyone, and I show who and why. Then I balance the average fit against the least-happy person, so one very happy person can't carry the pick.</div>
      <div class="sticky-actions"><button class="btn ghost" data-action="goto" data-value="prefs" data-key="back">Back</button>
        <button class="btn primary" data-action="room-go" data-key="go" ${joined.length < 2 ? 'disabled aria-disabled="true"' : ''}>Find something for ${joined.length} of us</button></div>
      ${joined.length < 2 ? '<p class="muted small">I need at least two people in the room.</p>' : ''}
    </section>`;
  }

  // Component states: things that need synthetic data so we don't invent scores for real films.
  function vStates() {
    return `<section class="screen"><h2 data-focus tabindex="-1">Component states</h2>
      <p class="muted">Synthetic examples of states the real agent can produce. "Example Film" isn't a real movie and its numbers are placeholders.</p>
      <div class="grid two">
        <div class="card stack"><h3>Sources disagree</h3>
          <div class="ratings"><div class="rating-row"><span class="src">Letterboxd<small>dataset snapshot</small></span><span class="score">8.6</span><span class="badge good">Read</span></div>
          <div class="rating-row"><span class="src">Rotten Tomatoes critics<small>live page</small></span><span class="score">5.1</span><span class="badge good">Fetched</span></div>
          <p class="conflict">Sources disagree: Letterboxd 8.6 vs Rotten Tomatoes critics 5.1. I show both instead of averaging them.</p></div>
          ${meter({ label: 'Low', value: 0.3 })}</div>
        <div class="card stack"><h3>A source could not be used</h3>
          <div class="ratings"><div class="rating-row off"><span class="src">Rotten Tomatoes<small>robots.txt disallows this path</small></span><span class="score">-</span><span class="badge warn">Blocked</span></div>
          <div class="rating-row off"><span class="src">Letterboxd live page<small>page layout not recognized</small></span><span class="score">-</span><span class="badge warn">Unparsed</span></div>
          <div class="rating-row off"><span class="src">IMDb and Metacritic<small>via OMDb</small></span><span class="score">-</span><span class="badge">Needs OMDB_API_KEY</span></div>
          <div class="rating-row off"><span class="src">Web fetching<small>ENABLE_WEB_SCRAPING=0</small></span><span class="score">-</span><span class="badge">Disabled</span></div></div></div>
        <div class="card stack"><h3>Ambiguous title</h3>
          <div class="agent-say"><div class="avatar" aria-hidden="true">UN</div><div class="bubble"><h3>Which "Example Film"?</h3><p class="muted">Two films share that name and are about equally well known.</p><div class="options"><button class="option">Example Film (1984)<small>Directed by A. Person</small></button><button class="option">Example Film (2021)<small>Directed by B. Person</small></button></div></div></div></div>
        <div class="card stack"><h3>Assumed, out loud</h3><p class="small">One of them is far better known, so I choose it and say so.</p><p><span class="badge info">Assumed Example Film (1995), the far better-known match</span></p>
          <h3>Consensus and compromise</h3><div class="row"><span class="badge good">Consensus pick</span><span class="badge warn">Compromise: Maya is lukewarm</span></div>
          <h3>No history</h3><p class="small muted">You have not told me what you have watched, so this leans on how well Letterboxd members rated it.</p></div>
        <div class="card stack"><h3>Person who has not joined</h3><div class="card person pending"><div class="person-head"><div class="avatar" aria-hidden="true">J</div><div><strong>Jordan</strong><br><span class="badge">Invited, not joined</span></div></div><p class="small muted">Not included yet. Their history is never used until they join and choose to share it.</p></div></div>
        <div class="card stack"><h3>Nothing left</h3><p>I ran out of picks. Your hard no's and feedback remove everything I have. Loosen one and I'll look again.</p></div>
      </div></section>`;
  }

  // ---------------- dialogs ----------------
  function openFeedback(filmId) {
    const f = BY_ID[filmId];
    const group = state.mode === 'group';
    const people = group ? joinedMembers() : [];
    state.dialog = { id: filmId, reason: null };
    document.getElementById('overlay').innerHTML = `<div class="scrim" data-action="close-dialog-bg"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t">
      <h3 id="dlg-t">${group ? 'Someone disagrees' : 'Not this one?'}</h3>
      <p class="muted">Tell me why and I'll record it. I won't quietly override you. <strong>${esc(f.title)}</strong> is removed either way.</p>
      ${group ? `<label for="by">Who is saying no?</label><select id="by">${people.map((m) => `<option>${esc(m.name)}</option>`).join('')}</select><div class="spacer"></div>` : ''}
      <div class="reasons" role="group" aria-label="Reason">${REASONS.map((r) => `<button type="button" class="reason" data-action="reason" data-value="${r.id}" data-key="reason:${r.id}" aria-pressed="false"><span><strong>${esc(r.label)}</strong><small>${esc(r.hint)}</small></span></button>`).join('')}</div>
      <label for="note">${NOTE_PLACEHOLDER}</label><textarea id="note" rows="2" maxlength="200"></textarea>
      <div class="row between" style="margin-top:16px"><button class="btn ghost" data-action="close-dialog" data-key="cancel">Cancel</button><button class="btn primary" data-action="submit-feedback" data-key="submit" disabled aria-disabled="true">Record and re-rank</button></div>
    </div></div>`;
    const first = document.querySelector('#overlay .reason');
    if (first) first.focus();
  }
  const closeDialog = () => { document.getElementById('overlay').innerHTML = ''; state.dialog = null; };

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ---------------- render + events ----------------
  const $app = document.getElementById('app');
  const views = {
    welcome: vWelcome, mode: vMode, prefs: vPrefs, ask: vAsk, thinking: vThinking, results: () => vResults(false),
    'group-room': vRoom, 'group-results': () => vResults(true), states: vStates,
  };
  let lastView = null;
  let thinkTimer = null;

  function render() {
    const key = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
    const scroll = window.scrollY;
    document.getElementById('steps').innerHTML = stepsFor(state.view);
    $app.innerHTML = views[state.view]();
    if (state.view !== lastView) {
      const h = $app.querySelector('[data-focus]') || $app.querySelector('h2');
      if (h) h.focus({ preventScroll: true });
      window.scrollTo(0, 0);
      lastView = state.view;
    } else {
      window.scrollTo(0, scroll);
      if (key) { const el = [...$app.querySelectorAll('[data-key]')].find((e) => e.dataset.key === key); if (el) el.focus({ preventScroll: true }); }
    }
    if (state.view === 'prefs') wirePrefs();
  }

  function go(view) {
    clearTimeout(thinkTimer);
    state.view = view;
    if (view === 'thinking') startThinking();
    render();
  }

  function startThinking() {
    const total = THINK().length;
    state.thinkStep = reduced() ? total : 0;
    const tick = () => {
      if (state.view !== 'thinking') return;
      state.thinkStep += 1;
      render();
      if (state.thinkStep >= total) thinkTimer = setTimeout(() => finishThinking(), reduced() ? 0 : 700);
      else thinkTimer = setTimeout(tick, 480);
    };
    thinkTimer = setTimeout(reduced() ? () => finishThinking() : tick, reduced() ? 0 : 350);
  }
  const finishThinking = () => { state.view = state.mode === 'group' ? 'group-results' : 'results'; state.promoted = null; render(); };

  function afterPrefs() {
    if (state.mode === 'group') {
      if (!state.crew) { state.crew = crewSeed(); state.crew.code = 'REEL-' + (10 + (hue(state.name || 'x') % 89)); }
      return go('group-room');
    }
    go(pendingQuestions().length ? 'ask' : 'thinking');
  }

  function wirePrefs() {
    const q = document.getElementById('seen-q');
    const box = document.getElementById('seen-suggest');
    const hn = document.getElementById('hardno');
    const match = (text) => {
      const n = norm(text);
      if (n.length < 2) return [];
      return FILMS.filter((f) => !state.prefs.seen.some((s) => s.id === f.id) && norm(f.title).includes(n)).sort((a, b) => (norm(a.title).startsWith(n) ? 0 : 1) - (norm(b.title).startsWith(n) ? 0 : 1)).slice(0, 5);
    };
    const addFilm = (f) => { state.prefs.seen.push({ id: f.id, verdict: 'liked' }); render(); const el = document.getElementById('seen-q'); if (el) el.focus(); };
    q.addEventListener('input', () => {
      const m = match(q.value);
      box.hidden = !m.length;
      q.setAttribute('aria-expanded', String(!!m.length));
      box.innerHTML = m.map((f) => `<button type="button" data-film="${f.id}">${esc(f.title)} <span class="muted small">${f.year}</span></button>`).join('');
    });
    box.addEventListener('click', (e) => { const b = e.target.closest('[data-film]'); if (b) addFilm(BY_ID[b.dataset.film]); });
    q.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = q.value.trim();
      if (!text) return;
      const m = match(text);
      const exact = m.find((f) => norm(f.title) === norm(text));
      if (exact || m.length === 1) addFilm(exact || m[0]);
      else if (m.length > 1) { box.hidden = false; box.querySelector('button')?.focus(); }
      else { if (!state.prefs.unmatched.includes(text)) state.prefs.unmatched.push(text); q.value = ''; render(); }
    });
    hn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const t = hn.value.trim().toLowerCase();
      if (t.length >= 3 && !state.prefs.hardNo.includes(t)) { state.prefs.hardNo.push(t); render(); document.getElementById('hardno').focus(); }
    });
    document.getElementById('novelty').addEventListener('input', (e) => { state.prefs.novelty = Number(e.target.value) / 100; e.target.setAttribute('aria-valuetext', `${e.target.value} percent adventurous`); });
    document.getElementById('year').addEventListener('change', (e) => { state.prefs.minYear = Number(e.target.value); });
  }

  const toggle = (arr, v) => { const i = arr.indexOf(v); if (i === -1) arr.push(v); else arr.splice(i, 1); };

  function reject(filmId, reason, note, by) {
    const f = BY_ID[filmId];
    const isGroup = state.mode === 'group';
    let effect;
    if (reason === 'seen-it') {
      if (isGroup) { const m = joinedMembers().find((x) => x.name === by); if (m && !m.prefs.seen.some((s) => s.id === filmId)) m.prefs.seen.push({ id: filmId, verdict: null }); }
      else if (!state.prefs.seen.some((s) => s.id === filmId)) state.prefs.seen.push({ id: filmId, verdict: null });
      effect = 'Marked as watched. It is not counted against similar films.';
    } else if (isGroup) {
      state.rejected.push({ id: filmId, by: by || 'Someone', reason });
      effect = `Removed for the whole room, and films like it are ranked lower for ${by || 'that person'}. Nobody else's taste changed.`;
    } else {
      state.rejected.push({ id: filmId, reason });
      effect = 'Removed from your list, and films with the same genres are ranked lower.';
    }
    state.feedback.unshift({ id: filmId, title: f.title, reason, note, by: isGroup ? by : null, effect });
    state.promoted = null;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    const v = t.dataset.value;
    const p = state.prefs;
    if (t.tagName === 'FORM') return;
    switch (a) {
      case 'open-curtains': state.opened = true; document.getElementById('stage').classList.add('open'); setTimeout(() => document.getElementById('name')?.focus({ preventScroll: true }), reduced() ? 0 : 1300); break;
      case 'pick-mode': state.mode = v; go('prefs'); break;
      case 'goto': go(v); break;
      case 'mood': p.mood = p.mood === v ? null : v; render(); break;
      case 'genre': toggle(p.genres, v); if (p.genres.includes(v)) p.avoid = p.avoid.filter((g) => g !== v); render(); break;
      case 'avoid': toggle(p.avoid, v); if (p.avoid.includes(v)) p.genres = p.genres.filter((g) => g !== v); render(); break;
      case 'flag': toggle(p.flags, v); render(); break;
      case 'rm-hardno': p.hardNo = p.hardNo.filter((x) => x !== v); render(); break;
      case 'verdict': p.seen.find((s) => s.id === t.dataset.id).verdict = v; render(); break;
      case 'unsee': p.seen = p.seen.filter((s) => s.id !== t.dataset.id); render(); break;
      case 'demo-prefs': state.prefs = demoPrefs(); render(); break;
      case 'prefs-done': afterPrefs(); break;
      case 'answer': {
        if (t.dataset.q === 'mood') { state.answers.mood = true; if (v !== 'none') p.mood = v; }
        else if (t.dataset.q === 'likes') state.answers.likes = true;
        else if (t.dataset.q.startsWith('unmatched:')) p.unmatched = p.unmatched.filter((x) => `unmatched:${x}` !== t.dataset.q);
        go(pendingQuestions().length ? 'ask' : 'thinking');
        break;
      }
      case 'skip-think': finishThinking(); break;
      case 'watch': toast(`Enjoy ${BY_ID[t.dataset.id].title}. I'd mark it as planned for you.`); break;
      case 'promote': state.promoted = t.dataset.id; render(); window.scrollTo(0, 0); toast(`${BY_ID[t.dataset.id].title} is now your top pick.`); break;
      case 'reject': openFeedback(t.dataset.id); break;
      case 'reason': {
        document.querySelectorAll('#overlay .reason').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
        state.dialog.reason = v;
        const s = document.querySelector('#overlay [data-action="submit-feedback"]');
        s.disabled = false; s.removeAttribute('aria-disabled');
        break;
      }
      case 'submit-feedback': {
        const by = document.getElementById('by')?.value;
        const note = document.getElementById('note').value.trim();
        const id = state.dialog.id;
        reject(id, state.dialog.reason, note, by);
        closeDialog();
        render();
        toast(`Recorded. ${BY_ID[id].title} is out, and I re-ranked with your reason.`);
        break;
      }
      case 'close-dialog': closeDialog(); break;
      case 'close-dialog-bg': if (e.target === t) closeDialog(); break;
      case 'join': state.crew.find((m) => m.key === v).joined = true; render(); break;
      case 'room-go': go('thinking'); break;
      case 'copy-invite': toast('Invite link copied (prototype: nothing was copied).'); break;
      case 'restart': state.prefs = blankPrefs(); state.rejected = []; state.feedback = []; state.answers = {}; state.crew = null; state.promoted = null; go('mode'); break;
      default: break;
    }
  });

  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-action="take-ticket"]');
    if (!f) return;
    e.preventDefault();
    state.name = document.getElementById('name').value.trim();
    go('mode');
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.dialog) closeDialog(); });

  // ---------------- boot ----------------
  // Hash shortcuts jump straight to a screen with example data, for reviewing layouts.
  function boot() {
    const h = location.hash.replace(/^#\/?/, '');
    if (!h || h === 'welcome') return go('welcome');
    if (h === 'welcome-open') { state.opened = true; return go('welcome'); }
    if (h === 'states') return go('states');
    state.name = state.name || 'Kyleena';
    state.opened = true;
    if (h === 'mode') return go('mode');
    state.prefs = h === 'prefs-empty' ? blankPrefs() : demoPrefs();
    if (h === 'group-room' || h === 'group-results') { state.mode = 'group'; state.crew = crewSeed(); state.crew.code = 'REEL-42'; state.crew[3].joined = h === 'group-results' ? false : false; }
    if (h === 'prefs' || h === 'prefs-empty') { state.mode = 'solo'; return go('prefs'); }
    if (h === 'ask') { state.mode = 'solo'; state.prefs = { ...blankPrefs(), unmatched: ['Incepton'], seen: [{ id: 'coco-2017', verdict: 'disliked' }] }; return go('ask'); }
    if (h === 'results') { state.mode = 'solo'; return go('results'); }
    if (h === 'group-room') return go('group-room');
    if (h === 'group-results') return go('group-results');
    return go('welcome');
  }
  window.addEventListener('hashchange', () => { if (location.hash !== state.hash) { state.hash = location.hash; boot(); } });
  state.hash = location.hash;
  boot();
})();
