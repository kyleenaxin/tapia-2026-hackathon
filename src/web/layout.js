import { html, raw, esc } from './html.js';

const ICONS = {
  eye: '<path d="M12 5C6.5 5 2.7 9 1.3 12c1.4 3 5.2 7 10.7 7s9.3-4 10.7-7C21.3 9 17.5 5 12 5zm0 11.2a4.2 4.2 0 1 1 0-8.4 4.2 4.2 0 0 1 0 8.4zm0-6.4a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1z"/>',
  up: '<path d="M2 10h4v11H2zM8 21h9.4a2 2 0 0 0 1.9-1.4l2.2-7.4A2 2 0 0 0 19.600 10H14l1-4.400c.2-1-.1-2-.8-2.600L13 2 8 9z"/>',
  down: '<path d="M22 14h-4V3h4zM16 3H6.600a2 2 0 0 0-1.900 1.400L2.500 11.800A2 2 0 0 0 4.400 14H10l-1 4.400c-.2 1 .1 2 .8 2.600l1.200 1z"/>',
};

export const icon = (name) => raw(`<svg class="ic" aria-hidden="true" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`);

const sprite = raw(`<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('')}</defs></svg>`);

const NAV = [
  ['/mode', 'Now showing'],
  ['/shelf', 'My shelf'],
  ['/about', 'How it works'],
  ['/judge', 'Judge walkthrough'],
];

// A ticket-shaped link or button.
export function ticket({ href, label, admit = 'Admit one', sub = '', stub = 'Up Next Cinema', attrs = '', tag = 'a', name = '', value = '' }) {
  const inner = html`<span class="main"><span class="admit">${admit}</span><span class="go">${label}</span>${sub ? html`<span class="sub">${sub}</span>` : ''}</span><span class="stub" aria-hidden="true">${stub}</span>`;
  if (tag === 'button') return html`<span class="ticket-wrap"><button class="ticket" type="submit" ${name ? raw(`name="${esc(name)}" value="${esc(value)}"`) : ''}>${inner}</button></span>`;
  return html`<span class="ticket-wrap"><a class="ticket" href="${href}" ${raw(attrs)}>${inner}</a></span>`;
}

export function layout({ title, body, current = '', bodyClass = '', provenance = null, bare = false, headExtra = '' }) {
  const foot = provenance
    ? html`<footer class="site">Film data: ${provenance.base === 'letterboxd-hf-index' ? 'Hugging Face Letterboxd dataset (' + provenance.movieCount.toLocaleString('en-US') + ' films)' : 'sample of the Hugging Face Letterboxd dataset (' + provenance.movieCount.toLocaleString('en-US') + ' films)'}. Live checks: Letterboxd, Rotten Tomatoes${provenance.omdb ? ', OMDb' : ''}. Streaming availability is not checked. <a href="/about">How this works</a>.</footer>`
    : html`<footer class="site"><a href="/about">How this works</a></footer>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Up Next</title>
<meta name="description" content="Up Next is an agent that picks a movie for you, or for your whole group, and explains why.">
<link rel="stylesheet" href="/site.css">
<script src="/site.js" defer></script>
${headExtra}
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
${sprite}
<div class="drape left" aria-hidden="true"></div><div class="drape right" aria-hidden="true"></div>
${bare ? '' : html`<div class="valance" aria-hidden="true"></div>`}
<div class="wrap${bare ? ' bare' : ''}">
${bare ? '' : html`<header class="marquee"><a class="brand" href="/">UP NEXT</a><span class="tag">Movies picked with reasons</span></header>
<nav class="main" aria-label="Main">${NAV.map(([href, label]) => html`<a href="${href}" ${current === href ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>`}
<main id="main">
${body}
</main>
</div>
${foot}
</body>
</html>`;
}
