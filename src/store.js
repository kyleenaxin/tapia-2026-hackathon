import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MOODS } from './agent/constraints.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const STATUSES = ['watched', 'watchlist'];
export const VERDICTS = ['liked', 'meh', 'disliked'];
export const FEEDBACK_KINDS = ['thumbs-up', 'thumbs-down', 'not-my-taste', 'wrong-mood', 'too-long', 'seen-it', 'other'];
export const SETTINGS = ['in-person', 'online'];
// friends: people who follow you can learn from your history. private: nobody can.
export const SHARING = ['friends', 'private'];
// Broad, simulated area labels only. There is no live geolocation and nothing finer than these.
export const AREAS = ['Downtown', 'University District', 'Northside', 'Eastside', 'Westside', 'Harborfront'];
// Permanent taste calibration. "not-watched" is neutral: it is not a rating and not a watch.
export const TASTE_ACTIONS = ['love', 'like', 'dislike', 'not-watched'];
// Tonight's shared-deck reactions. They never touch the permanent taste profile.
export const ROOM_SWIPE_ACTIONS = ['love', 'like', 'dislike', 'skip', 'seen'];
export const ROOM_STATUSES = ['collecting', 'analyzing', 'needs-tiebreaker', 'complete'];
export const ROOM_MAX_MEMBERS = 8;
export const MAX_HARD_VETOES = 12;

const DEFAULT_PREFS = { genres: [], avoidGenres: [], hardNoTerms: [], avoidFlags: [], mood: null, maxRuntime: null, minYear: null, novelty: 0.3 };
const ROOM_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

const fresh = () => ({ seq: 1, users: {}, entries: [], feedback: [], follows: [], tasteSwipes: [], rooms: {}, events: [], runs: {} });

const newMember = (userId) => ({ userId, mood: null, maxRuntime: null, hardVetoes: [], ready: false, swipes: {}, joinedAt: new Date().toISOString() });

// Consent model: a person's history is visible only inside a screening room they joined, to the other members of that room.
// Joining is an explicit opt-in and leaving revokes access. (Older state files may still carry unused follow/sharing fields.)
export class Store {
  constructor({ file = null } = {}) {
    this.file = file;
    this.state = fresh();
    if (file && fs.existsSync(file)) {
      try { this.state = { ...fresh(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { this.state = fresh(); }
      this.migrate();
    }
  }

  // State files written before follows/sharing/room members existed still load.
  migrate() {
    for (const u of Object.values(this.state.users)) {
      u.sharing = SHARING.includes(u.sharing) ? u.sharing : 'friends';
      u.area ??= null;
    }
    for (const r of Object.values(this.state.rooms)) {
      r.members ??= Object.fromEntries((r.memberIds ?? []).map((id) => [id, newMember(id)]));
      r.status ??= 'collecting';
      r.deck ??= [];
      r.tiebreaker ??= null;
      r.result ??= null;
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }

  reset() { this.state = fresh(); this.save(); }
  nextId(prefix) { return `${prefix}${this.state.seq++}`; }

  // ---- people (an unguessable id doubles as the session cookie) ----
  createUser({ name = '', prefs = {}, sharing = 'friends', area = null, demo = false, simulated = false, managedBy = null } = {}) {
    if (!SHARING.includes(sharing)) throw new HttpError(400, `sharing must be one of ${SHARING.join(', ')}`);
    if (area != null && !AREAS.includes(area)) throw new HttpError(400, `area must be one of ${AREAS.join(', ')}`);
    const id = `u_${randomBytes(9).toString('base64url')}`;
    this.state.users[id] = { id, name: String(name).trim().slice(0, 40) || 'Guest', prefs: { ...DEFAULT_PREFS, ...prefs }, sharing, area, demo, simulated, managedBy, createdAt: new Date().toISOString() };
    this.save();
    return this.state.users[id];
  }

  findUser(id) { return this.state.users[id] ?? null; }

  getUser(id) {
    const u = this.state.users[id];
    if (!u) throw new HttpError(404, 'person not found');
    return u;
  }

  listUsers() { return Object.values(this.state.users); }

  updateUser(id, { name, prefs, sharing, area } = {}) {
    const u = this.getUser(id);
    if (sharing !== undefined && !SHARING.includes(sharing)) throw new HttpError(400, `sharing must be one of ${SHARING.join(', ')}`);
    if (area != null && !AREAS.includes(area)) throw new HttpError(400, `area must be one of ${AREAS.join(', ')}`);
    if (name !== undefined) u.name = String(name).trim().slice(0, 40) || u.name;
    if (sharing !== undefined) u.sharing = sharing;
    if (area !== undefined) u.area = area || null;
    if (prefs) {
      const p = { ...u.prefs };
      const list = (v) => [...new Set((v ?? []).map((x) => String(x).trim()).filter(Boolean))];
      if ('genres' in prefs) p.genres = list(prefs.genres);
      if ('avoidGenres' in prefs) p.avoidGenres = list(prefs.avoidGenres);
      if ('hardNoTerms' in prefs) p.hardNoTerms = list(prefs.hardNoTerms).slice(0, 12);
      if ('avoidFlags' in prefs) p.avoidFlags = list(prefs.avoidFlags);
      if ('mood' in prefs) p.mood = prefs.mood || null;
      if ('maxRuntime' in prefs) p.maxRuntime = prefs.maxRuntime ? Number(prefs.maxRuntime) : null;
      if ('minYear' in prefs) p.minYear = prefs.minYear ? Number(prefs.minYear) : null;
      if ('novelty' in prefs) p.novelty = Math.min(1, Math.max(0, Number(prefs.novelty) || 0));
      p.genres = p.genres.filter((g) => !p.avoidGenres.includes(g));
      u.prefs = p;
    }
    this.save();
    return u;
  }

  // ---- watch lists ----
  entriesFor(userId) { return this.state.entries.filter((e) => e.userId === userId); }

  addEntry({ userId, movieId, status = 'watched', verdict = null, reaction = null, source = null }) {
    this.getUser(userId);
    if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    if (verdict != null && !VERDICTS.includes(verdict)) throw new HttpError(400, `verdict must be one of ${VERDICTS.join(', ')}`);
    if (status !== 'watched') { verdict = null; reaction = null; }
    const existing = this.state.entries.find((e) => e.userId === userId && e.movieId === movieId);
    if (existing) {
      existing.status = status;
      existing.verdict = verdict;
      // A later manual edit replaces how the entry got here, so an old taste swipe cannot undo it.
      if (reaction) existing.reaction = reaction; else delete existing.reaction;
      if (source) existing.source = source; else delete existing.source;
      this.save();
      return { entry: existing, created: false };
    }
    const entry = { userId, movieId, status, verdict, addedAt: new Date().toISOString() };
    if (reaction) entry.reaction = reaction;
    if (source) entry.source = source;
    this.state.entries.push(entry);
    this.save();
    return { entry, created: true };
  }

  setVerdict(userId, movieId, verdict) {
    const e = this.state.entries.find((x) => x.userId === userId && x.movieId === movieId && x.status === 'watched');
    if (!e) return false;
    if (verdict != null && !VERDICTS.includes(verdict)) throw new HttpError(400, 'bad verdict');
    e.verdict = verdict;
    this.save();
    return true;
  }

  removeEntry(userId, movieId) {
    this.state.entries = this.state.entries.filter((e) => !(e.userId === userId && e.movieId === movieId));
    this.save();
  }

  // ---- feedback: thumbs and disagreements are recorded with their reasons, never overwritten ----
  addFeedback({ userId, movieId, kind, reason = '', context = 'solo', seeded = false }) {
    this.getUser(userId);
    if (!FEEDBACK_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${FEEDBACK_KINDS.join(', ')}`);
    // A later thumb on the same movie replaces the earlier one in effect: drop the opposing signal.
    if (kind === 'thumbs-up') this.state.feedback = this.state.feedback.filter((f) => !(f.userId === userId && f.movieId === movieId && f.context === context && f.kind !== 'thumbs-up' && f.kind !== 'seen-it'));
    if (kind !== 'thumbs-up' && kind !== 'seen-it') this.state.feedback = this.state.feedback.filter((f) => !(f.userId === userId && f.movieId === movieId && f.kind === 'thumbs-up'));
    const fb = { id: this.nextId('f'), userId, movieId, kind, reason: String(reason ?? '').trim().slice(0, 300), context, seeded, at: new Date().toISOString() };
    this.state.feedback.push(fb);
    this.save();
    return fb;
  }

  feedbackFor(userId) { return this.state.feedback.filter((f) => f.userId === userId); }

  // ---- screening rooms ----
  createRoom({ hostId, name = '', setting = 'in-person' }) {
    this.getUser(hostId);
    if (!SETTINGS.includes(setting)) throw new HttpError(400, 'setting must be in-person or online');
    let code;
    do { code = Array.from({ length: 4 }, () => ROOM_LETTERS[randomBytes(1)[0] % ROOM_LETTERS.length]).join(''); } while (this.state.rooms[code]);
    this.state.rooms[code] = { code, name: String(name).trim().slice(0, 50) || 'Movie night', hostId, setting, memberIds: [hostId], createdAt: new Date().toISOString() };
    this.save();
    return this.state.rooms[code];
  }

  getRoom(code) {
    const r = this.state.rooms[String(code ?? '').toUpperCase()];
    if (!r) throw new HttpError(404, 'That screening room does not exist.');
    return r;
  }

  joinRoom(code, userId) {
    const room = this.getRoom(code);
    this.getUser(userId);
    if (!room.memberIds.includes(userId)) room.memberIds.push(userId);
    this.save();
    return room;
  }

  leaveRoom(code, userId) {
    const room = this.getRoom(code);
    room.memberIds = room.memberIds.filter((id) => id !== userId);
    this.save();
  }

  roomsOf(userId) { return Object.values(this.state.rooms).filter((r) => r.memberIds.includes(userId)); }

  peersOf(userId) {
    const ids = new Set();
    for (const r of this.roomsOf(userId)) for (const id of r.memberIds) if (id !== userId) ids.add(id);
    return [...ids].map((id) => this.state.users[id]).filter(Boolean);
  }

  // Visibility follows room membership: you and anyone you share a room with, and nobody else.
  canSee(viewerId, ownerId) {
    if (viewerId === ownerId) return true;
    return this.roomsOf(viewerId).some((r) => r.memberIds.includes(ownerId));
  }

  visibleFriends(viewerId) { return this.peersOf(viewerId); }
  followersOf(actorId) { return this.peersOf(actorId).map((u) => u.id); }

  // ---- events (what the agent noticed when a roommate added a movie) ----
  addEvent(event) {
    const e = { id: this.nextId('e'), at: new Date().toISOString(), ...event };
    this.state.events.push(e);
    if (this.state.events.length > 500) this.state.events.splice(0, this.state.events.length - 500);
    this.save();
    return e;
  }

  eventsFor(viewerId) {
    return this.state.events
      .filter((e) => e.analyses?.[viewerId])
      .map((e) => ({ id: e.id, at: e.at, type: e.type, actorId: e.actorId, movieId: e.movieId, analysis: e.analyses[viewerId] }))
      .reverse();
  }
}
