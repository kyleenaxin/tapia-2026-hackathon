// Auto-escaping HTML templates: every interpolated value is escaped unless it is already Safe markup.
export class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

export const raw = (s) => new Safe(String(s));

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const render = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false || v === true) return '';
  return esc(v);
};

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Safe(out);
}

// Only plain http(s) links are ever emitted, so scraped or user-supplied text cannot inject a javascript: URL.
export const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : '#');
