import { HttpError } from '../store.js';

const MAX_BODY = 3_000_000; // room for a Letterboxd export

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'That upload is too large (3 MB limit).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Repeated keys (checkboxes) become arrays.
function addField(fields, name, value) {
  if (name in fields) fields[name] = [].concat(fields[name], value);
  else fields[name] = value;
}

export function parseUrlEncoded(text) {
  const fields = {};
  for (const [k, v] of new URLSearchParams(text)) addField(fields, k, v);
  return fields;
}

// Minimal multipart/form-data parser: text fields and file contents (as UTF-8 text) keyed by field name.
export function parseMultipart(buf, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.slice(1).find(Boolean);
  if (!boundary) throw new HttpError(400, 'Malformed form upload.');
  const fields = {};
  const delimiter = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delimiter, start);
    if (next === -1) break;
    const part = buf.slice(start + 2, next - 2); // strip the CRLF after the boundary and before the next
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headers = part.slice(0, split).toString('utf8');
      const name = /name="([^"]*)"/i.exec(headers)?.[1];
      if (name) addField(fields, name, part.slice(split + 4).toString('utf8'));
    }
    pos = next;
  }
  return fields;
}

export async function parseForm(req) {
  const type = req.headers['content-type'] ?? '';
  const body = await readBody(req);
  if (type.startsWith('multipart/form-data')) return parseMultipart(body, type);
  if (type.startsWith('application/x-www-form-urlencoded')) return parseUrlEncoded(body.toString('utf8'));
  if (!body.length) return {};
  throw new HttpError(415, 'Unsupported form encoding.');
}

// Cross-site POSTs are refused. Combined with SameSite=Lax cookies this covers the CSRF cases that matter here.
export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Bad origin.'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Cross-site form posts are not allowed.');
}

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
