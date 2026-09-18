import test from 'node:test';
import assert from 'node:assert/strict';
import { runSoloAgent, runGroupAgent, compareResults } from '../src/agent/agent.js';
import { createTrace } from '../src/agent/trace.js';
import { createJobs, jobView } from '../src/agent/jobs.js';
import { reviewSummary } from '../src/agent/reviewSummary.js';
import { runJudgeScenario } from '../src/demo/scenario.js';
import { HttpError } from '../src/store.js';
import { buildMovie } from '../src/data/catalog.js';
import { newStore, addWatched, fixtureCatalog } from './helpers.js';
import { fakeSources, catalogOf } from './fakeSources.js';

const film = (id, title, genres, o = {}) => ({
  id, slug: id, url: `https://letterboxd.com/film/${id}/`, title, year: o.year ?? 2010, genres,
  keywords: o.keywords ?? ['space', `dir-${id}`], popularity: o.pop ?? 60000, overview: `${title} overview`,
  directors: [`Dir ${id}`], cast: [], reviews: o.reviews ?? [],
  ratings: [{ source: 'letterboxd', value: o.rating ?? 8, votes: null, votesProxy: o.pop ?? 60000, kind: 'audience', basis: 'dataset snapshot' }],
});

function world({ extra = [] } = {}) {
  const list = [
    ...Array.from({ length: 10 }, (_, i) => film(`scifi-${i + 1}`, `Sci ${i + 1}`, ['Science Fiction'], { rating: 9 - i * 0.1 })),
    ...Array.from({ length: 5 }, (_, i) => film(`comedy-${i + 1}`, `Comedy ${i + 1}`, ['Comedy'], { rating: 8 - i * 0.1, keywords: ['friends', `dir-c${i}`] })),
    ...Array.from({ length: 3 }, (_, i) => film(`horror-${i + 1}`, `Horror ${i + 1}`, ['Horror'], { rating: 8.5, keywords: ['ghost', `dir-h${i}`] })),
    ...Array.from({ length: 3 }, (_, i) => film(`drama-${i + 1}`, `Drama ${i + 1}`, ['Drama'], { rating: 8.2, keywords: ['family', `dir-d${i}`] })),
    ...extra,
  ];
  const catalog = catalogOf(list);
  const store = newStore();
  const user = store.createUser({ name: 'Ada', prefs: { genres: ['Science Fiction'], mood: 'mindbend' } });
  addWatched(store, user.id, ['scifi-9', 'scifi-10']);
  return { catalog, store, user };
}
const run = (w, sources = fakeSources(), opts = {}) => runSoloAgent({ userId: w.user.id, store: w.store, catalog: w.catalog, sources, trace: createTrace(), ...opts });
const tools = (r) => r.trace.map((s) => s.tool);

test('solo agent returns a primary pick and two backups, each with reasons, ratings, reviews and drawbacks', async () => {
  const w = world();
  const r = await run(w);
  assert.equal(r.picks.length, 3);
  assert.deepEqual(r.picks.map((p) => p.role), ['primary', 'backup', 'backup']);
  assert.deepEqual(r.picks.map((p) => p.label), ["Tonight's pick", 'Backup one', 'Backup two']);
  for (const p of r.picks) {
    assert.ok(p.reasons.length > 0, 'why it was recommended');
    assert.ok(p.ratings.sources.length >= 3, `ratings from multiple sources: ${p.ratings.sources.map((s) => s.source)}`);
    assert.ok(p.reviews.points.length > 0 && p.reviews.basis, 'review summary with its basis');
    assert.ok(p.drawbacks.some((d) => /availability/i.test(d)), 'drawbacks always admit availability is unchecked');
    assert.ok(['High', 'Medium', 'Low'].includes(p.confidence.label));
    assert.equal(p.runtime.known, true);
  }
  assert.equal(new Set(r.picks.map((p) => p.movie.id)).size, 3);
  assert.match(r.picks[1].angle, /vibe|flavor/);
  assert.equal(r.picks[0].angle, null);
});

test('the agent visibly works: profile, search, shortlist, source checks, cross-check, write-up', async () => {
  const r = await run(world());
  const t = tools(r);
  for (const step of ['read_profile', 'search_dataset', 'shortlist', 'check_sources', 'cross_check_ratings', 'write_up']) assert.ok(t.includes(step), step);
  assert.ok(t.indexOf('read_profile') < t.indexOf('search_dataset') && t.indexOf('search_dataset') < t.indexOf('check_sources'));
  assert.ok(r.trace.every((s) => typeof s.summary === 'string' && s.ms >= 0));
  const checked = r.trace.filter((s) => s.tool === 'check_sources');
  assert.ok(checked.length >= 3 && checked.every((s) => /Letterboxd/.test(s.summary) && /Rotten Tomatoes/.test(s.summary)));
});

test('it checks only what it needs: finalists, not the whole shortlist', async () => {
  const src = fakeSources();
  const r = await run(world(), src);
  assert.ok(r.checked >= 3 && r.checked <= 8, `checked ${r.checked}`);
  assert.equal(src.calls.letterboxd.length, r.checked);
});

test('a runtime limit is enforced on live data: long films are dropped and the drop is logged', async () => {
  const w = world();
  w.store.updateUser(w.user.id, { prefs: { maxRuntime: 100 } });
  const long = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`scifi-${i + 1}`, 170]));
  const r = await run(w, fakeSources({ runtimes: long, defaultRuntime: 95 }));
  assert.equal(r.picks.length, 3);
  assert.ok(r.picks.every((p) => p.runtime.minutes <= 100), r.picks.map((p) => `${p.movie.title} ${p.runtime.minutes}`).join(', '));
  const drop = r.trace.find((s) => s.tool === 'apply_runtime_limit');
  assert.ok(drop && /100-minute limit/.test(drop.summary));
});

test('when the runtime cannot be confirmed the drawbacks say so instead of pretending', async () => {
  const w = world();
  w.store.updateUser(w.user.id, { prefs: { maxRuntime: 120 } });
  const src = fakeSources();
  src.letterboxd = async (m) => ({ source: 'letterboxd', status: 'error', reason: 'simulated outage', url: m.url });
  const r = await run(w, src);
  assert.ok(r.picks.every((p) => p.runtime.known === false));
  assert.ok(r.picks.every((p) => p.drawbacks.some((d) => /could not confirm the runtime/i.test(d))));
});

test('featurettes and shorts are never recommended', async () => {
  const w = world({ extra: [film('making-of', 'Sci Epic: Behind the Scenes', ['Science Fiction'], { rating: 9.9 }), film('tiny-short', 'Tiny Sci Short', ['Science Fiction'], { rating: 9.8 })] });
  const r = await run(w, fakeSources({ runtimes: { 'tiny-short': 12 } }));
  assert.ok(r.filtered['not-a-feature'] >= 1, 'title-based filter');
  const titles = r.picks.map((p) => p.movie.title);
  assert.ok(!titles.includes('Sci Epic: Behind the Scenes'));
  assert.ok(!titles.includes('Tiny Sci Short'), 'a 12 minute runtime from a live source disqualifies it');
});

test('if every source is down the agent still answers from the dataset and says exactly what failed', async () => {
  const r = await run(world(), fakeSources({ fail: true }));
  assert.equal(r.picks.length, 3);
  for (const p of r.picks) {
    assert.deepEqual(p.ratings.sources.map((s) => s.source), ['letterboxd'], 'only the dataset snapshot');
    assert.equal(p.ratings.sources[0].basis, 'dataset snapshot');
    assert.equal(p.sourceStatus.letterboxd.status, 'error');
    assert.equal(p.sourceStatus.rottentomatoes.reason, 'simulated outage');
  }
  assert.ok(r.trace.some((s) => s.tool === 'check_sources' && s.status === 'warn'));
  assert.equal(r.sources.letterboxd.error, r.checked);
});

test('with scraping switched off nothing is fetched and the statuses say disabled', async () => {
  const src = fakeSources({ scraping: false });
  const r = await run(world(), src);
  assert.equal(r.picks[0].sourceStatus.letterboxd.status, 'disabled');
  assert.equal(r.picks[0].sourceStatus.rottentomatoes.status, 'disabled');
  assert.equal(r.picks[0].ratings.sources.length, 1);
});

test('a check budget is respected and the shortfall is reported', async () => {
  const src = fakeSources();
  const r = await run(world(), src, { budget: { maxChecked: 2, batchSize: 2, maxMs: 45000, pool: 30 } });
  assert.equal(src.calls.letterboxd.length, 2);
  assert.equal(r.picks.length, 3, 'still answers');
  assert.ok(r.trace.some((s) => s.tool === 'budget' && s.status === 'warn'));
});

test('a time budget stops checking too', async () => {
  let t = 0;
  const src = fakeSources();
  const slow = { ...src, letterboxd: async (m) => { t += 60000; return src.letterboxd(m); } };
  const r = await run(world(), slow, { now: () => t, budget: { maxChecked: 12, batchSize: 1, maxMs: 45000, pool: 30 } });
  assert.ok(r.trace.some((s) => s.tool === 'budget'));
});

test('sources that disagree are flagged, not averaged away', async () => {
  const w = world();
  const first = await run(w);
  const id = first.picks[0].movie.id;
  const r = await run(w, fakeSources({ rt: { [id]: 2.0 } }));
  const pick = r.picks.find((p) => p.movie.id === id);
  if (pick) {
    assert.equal(pick.ratings.conflict, true);
    assert.ok(pick.drawbacks.some((d) => /disagree|critics|audiences/i.test(d)));
    assert.match(pick.ratings.note, /disagree/);
  }
  assert.ok(r.picks.every((p) => (p.ratings.conflict ? p.drawbacks.length > 1 : true)));
});

test('a thumbs down is stored, removes the pick, and the next run reports what changed', async () => {
  const w = world();
  const before = await run(w);
  const gone = before.picks[0].movie;
  w.store.addFeedback({ userId: w.user.id, movieId: gone.id, kind: 'not-my-taste', reason: 'Too slow', context: 'solo' });
  const after = await run(w, fakeSources(), { previous: before });
  assert.ok(!after.picks.some((p) => p.movie.id === gone.id));
  assert.equal(after.changes.primaryChanged, true);
  assert.equal(after.changes.primaryBefore, gone.title);
  assert.ok(after.changes.removed.includes(gone.title));
  assert.equal(w.store.feedbackFor(w.user.id)[0].reason, 'Too slow', 'the human reason is kept');
});

test('a thumbs up is a positive signal toward its lookalikes', async () => {
  const w = world();
  const before = await run(w);
  w.store.addFeedback({ userId: w.user.id, movieId: 'comedy-1', kind: 'thumbs-up', context: 'solo' });
  const after = await run(w);
  const comedyScore = (r) => r.picks.find((p) => p.movie.id === 'comedy-2')?.score ?? 0;
  assert.ok(comedyScore(after) >= comedyScore(before));
  assert.ok(after.profile.liked.includes('Comedy 1') || after.profile.topGenres.includes('Comedy'));
});

test('hard no genres and hard no words remove candidates entirely', async () => {
  const w = world();
  w.store.updateUser(w.user.id, { prefs: { genres: [], avoidGenres: ['Horror'], hardNoTerms: ['overview'] } });
  const r = await run(w);
  assert.equal(r.picks.length, 0, 'every film mentions "overview" in the synopsis, so nothing survives');
  assert.match(r.notes[0], /Nothing survives/);
  assert.ok(r.trace.some((s) => s.tool === 'give_up'));
  w.store.updateUser(w.user.id, { prefs: { hardNoTerms: [] } });
  const ok = await run(w);
  assert.ok(ok.picks.every((p) => !p.movie.genres.includes('Horror')));
});

test('compareResults is empty without a previous run', () => {
  assert.equal(compareResults(null, { picks: [] }), null);
  assert.equal(compareResults({ picks: [] }, { picks: [] }), null);
});

// ---------- group ----------
function groupWorld() {
  const w = world();
  const store = w.store;
  const ana = w.user;
  const ben = store.createUser({ name: 'Ben', prefs: { genres: ['Comedy'], avoidGenres: ['Horror'] } });
  const room = store.createRoom({ hostId: ana.id, name: 'Test night' });
  store.joinRoom(room.code, ben.id);
  addWatched(store, ben.id, ['comedy-4', 'comedy-5']);
  return { ...w, ben, room };
}
const runGroup = (g, sources = fakeSources(), extra = {}) => runGroupAgent({ hostId: g.user.id, roomCode: g.room.code, store: g.store, catalog: g.catalog, sources, trace: createTrace(), ...extra });

test('group agent balances the room, respects a member\'s hard no, and shows per-person fit', async () => {
  const g = groupWorld();
  const r = await runGroup(g);
  assert.equal(r.mode, 'group');
  assert.equal(r.picks.length, 3);
  assert.deepEqual(r.participants.map((p) => p.name).sort(), ['Ada', 'Ben']);
  assert.ok(r.picks.every((p) => !p.movie.genres.includes('Horror')), 'Ben avoids Horror, so nobody gets it');
  assert.deepEqual(r.constraints.avoidedGenres, { Horror: ['Ben'] });
  for (const p of r.picks) {
    assert.equal(p.perMember.length, 2);
    assert.ok(['Consensus', 'Compromise', 'Balanced'].includes(p.groupLabel));
    assert.ok(p.ratings.sources.length >= 3);
    assert.ok(p.reviews.points.length > 0);
  }
  assert.ok(r.fairness.length === 2);
});

test('a group veto removes the pick for the whole room and is reported as a change', async () => {
  const g = groupWorld();
  const before = await runGroup(g);
  const top = before.picks[0].movie;
  g.store.addFeedback({ userId: g.ben.id, movieId: top.id, kind: 'wrong-mood', reason: 'Not tonight', context: 'group' });
  const after = await runGroup(g, fakeSources(), { previous: before });
  assert.ok(!after.picks.some((p) => p.movie.id === top.id));
  assert.equal(after.changes.primaryChanged, true);
});

test('a group thumbs-up is not a veto', async () => {
  const g = groupWorld();
  const before = await runGroup(g);
  const top = before.picks[0].movie;
  g.store.addFeedback({ userId: g.ben.id, movieId: top.id, kind: 'thumbs-up', context: 'group' });
  const after = await runGroup(g);
  assert.ok(after.picks.some((p) => p.movie.id === top.id), 'still on the list');
});

test('people outside the room are never used; a group needs two people', async () => {
  const g = groupWorld();
  g.store.leaveRoom(g.room.code, g.ben.id);
  await assert.rejects(runGroup(g), (e) => e instanceof HttpError && e.status === 422);
});

test('group runtime limits use the strictest member, checked against live runtimes', async () => {
  const g = groupWorld();
  g.store.updateUser(g.ben.id, { prefs: { maxRuntime: 100 } });
  const r = await runGroup(g, fakeSources({ defaultRuntime: 150, runtimes: { 'comedy-1': 90, 'comedy-2': 95, 'comedy-3': 99, 'scifi-1': 90, 'scifi-2': 90, 'scifi-3': 90 } }));
  assert.equal(r.constraints.maxRuntime, 100);
  assert.ok(r.picks.every((p) => p.runtime.minutes <= 100));
});

// ---------- review summaries ----------
const reviewed = (reviews, ratings = []) => buildMovie({ id: 'x', title: 'X', genres: ['Drama'], reviews, ratings: [{ source: 'letterboxd', value: 8, votes: 1000, kind: 'audience' }, ...ratings] });

test('review summary quotes only clean, substantive reviews and admits its limits', () => {
  const s = reviewSummary(reviewed([
    { user: 'joker', text: 'lol this is so funny haha what a ride wow so many jokes here in this one review thing', likes: 9000 },
    { user: 'rude', text: 'This movie is fucking brilliant and the performances are stunning from start to finish honestly.', likes: 8000 },
    { user: 'real', text: 'The pacing is tight and the performances are moving, with a script that respects the audience throughout.', likes: 500 },
    { user: 'short', text: 'great', likes: 100 },
  ]));
  assert.equal(s.quote.user, 'real');
  assert.match(s.basis, /4 most-liked Letterboxd reviews/);
  assert.match(s.basis, /jokes/);
});

test('review summary prefers no quote to a bad quote, and strips the spoiler banner', () => {
  const none = reviewSummary(reviewed([{ user: 'a', text: 'This review may contain spoilers. Just vibes and memes, nothing to say about it at all really okay bye', likes: 1 }]));
  assert.equal(none.quote, null);
  const empty = reviewSummary(reviewed([]));
  assert.match(empty.basis, /No review text/);
  const clean = reviewSummary(reviewed([{ user: 'z', text: 'This review may contain spoilers. The cinematography is stunning and the story never drags for a second, which is rare for a film this long.', likes: 5 }]));
  assert.doesNotMatch(clean.quote.text, /spoilers/);
});

test('review summary compares critics and audiences using real counts', () => {
  const agree = reviewSummary(reviewed([], [{ source: 'rottentomatoes', value: 9.2, votes: 200, kind: 'critic', detail: { liked: 184, count: 200, certified: true } }, { source: 'rt-audience', value: 9.0, votes: 5000, kind: 'audience' }]));
  assert.ok(agree.points.some((p) => /184 of 200 Rotten Tomatoes reviews were positive \(92%\), Certified Fresh/.test(p)));
  assert.ok(agree.points.some((p) => /broadly agree/.test(p)));
  const split = reviewSummary(reviewed([], [{ source: 'rottentomatoes', value: 9.5, votes: 200, kind: 'critic' }, { source: 'rt-audience', value: 6.0, votes: 5000, kind: 'audience' }]));
  assert.ok(split.points.some((p) => /Critics like it more than audiences/.test(p)));
});

// ---------- jobs ----------
test('jobs: a follow-up question pauses the run, answering resumes it, and the log is live', async () => {
  const w = world();
  const jobs = createJobs({ store: w.store, catalog: w.catalog, sources: fakeSources() });
  const questions = [{ id: 'mood', type: 'mood', text: 'Mood?', why: 'because', options: [{ value: 'cozy', label: 'Cozy' }] }];
  const job = jobs.create({ userId: w.user.id, mode: 'solo', questions, notes: [] });
  assert.equal(job.status, 'asking');
  assert.equal(job.trace, null);
  jobs.answer(job, { mood: 'cozy' });
  assert.equal(job.status, 'running');
  assert.equal(w.store.getUser(w.user.id).prefs.mood, 'cozy', 'the answer is applied');
  await job.promise;
  assert.equal(job.status, 'done');
  assert.equal(job.result.picks.length, 3);
  const v = jobView(job);
  assert.equal(v.status, 'done');
  assert.equal(v.resultsUrl, `/results/${job.id}`);
  assert.ok(v.steps.length >= 6);
  jobs.answer(job, { mood: 'thrilled' });
  assert.equal(w.store.getUser(w.user.id).prefs.mood, 'cozy', 'answering twice is ignored');
});

test('jobs: a rerun knows the previous result so the change can be explained', async () => {
  const w = world();
  const jobs = createJobs({ store: w.store, catalog: w.catalog, sources: fakeSources() });
  const first = jobs.create({ userId: w.user.id, mode: 'solo' });
  await first.promise;
  w.store.addFeedback({ userId: w.user.id, movieId: first.result.picks[0].movie.id, kind: 'not-my-taste', context: 'solo' });
  const second = jobs.create({ userId: w.user.id, mode: 'solo', previousFrom: `solo:${w.user.id}`, banner: 'You gave a thumbs down.' });
  await second.promise;
  assert.equal(second.result.changes.primaryChanged, true);
  assert.equal(jobs.latestFor('solo', w.user.id).id, second.id);
});

test('jobs: failures become friendly messages, and unexpected ones do not leak internals', async () => {
  const w = world();
  const jobs = createJobs({ store: w.store, catalog: w.catalog, sources: fakeSources() });
  const friendly = jobs.create({ userId: w.user.id, mode: 'judge', runner: async () => { throw new HttpError(422, 'Group mode needs at least two people in the room.'); } });
  await friendly.promise;
  assert.equal(friendly.status, 'error');
  assert.match(friendly.error, /at least two people/);
  const original = console.error;
  console.error = () => {};
  try {
    const odd = jobs.create({ userId: w.user.id, mode: 'judge', runner: async () => { throw new Error('secret path C:\\internal\\thing'); } });
    await odd.promise;
    assert.equal(odd.status, 'error');
    assert.doesNotMatch(odd.error, /secret|internal/);
  } finally { console.error = original; }
});

test('jobs: intake jobs finish immediately after the answers are applied, and judge jobs do not touch "latest"', async () => {
  const w = world();
  const jobs = createJobs({ store: w.store, catalog: w.catalog, sources: fakeSources() });
  const intake = jobs.create({ userId: w.user.id, mode: 'intake', roomCode: 'ABCD', questions: [{ id: 'novelty', type: 'novelty', text: 'q', why: 'w', options: [{ value: 'new', label: 'New' }] }] });
  jobs.answer(intake, { novelty: 'new' });
  assert.equal(intake.status, 'done');
  assert.equal(w.store.getUser(w.user.id).prefs.novelty, 0.7);
  const judge = jobs.create({ userId: 'judge', mode: 'judge', runner: async () => ({ ok: true }) });
  await judge.promise;
  assert.equal(judge.resultsUrl, `/judge?job=${judge.id}`);
  assert.equal(jobs.latestFor('solo', 'judge'), null);
});

// ---------- the judge walkthrough ----------
test('judge scenario: a recommendation, a friend-added change, and a disagreement, all from the real agent path', async () => {
  const catalog = fixtureCatalog();
  const out = await runJudgeScenario({ catalog, sources: fakeSources() });
  assert.equal(out.solo.picks.length, 3);
  assert.ok(out.solo.picks[0].reasons.length > 0);
  assert.ok(out.friend, 'a friend pick was found');
  assert.ok(out.friend.analysis, "Alex's agent reacted to Sam's addition");
  assert.equal(out.friend.analysis.actorName, 'Sam');
  assert.ok(out.friend.analysis.movieRank.after < out.friend.analysis.movieRank.before, 'the added film rose in Alex\'s ranking');
  assert.ok(!out.solo.picks.some((p) => p.movie.title === out.friend.movie), 'not a film Alex was already being told to watch');
  assert.equal(out.disagreement.illustrative, true, 'the seeded disagreement is labeled as an example');
  assert.ok(!out.disagreement.after.picks.some((p) => p.movie.title === out.disagreement.contested.title), 'the vetoed film is gone');
  assert.equal(out.disagreement.changes.primaryChanged, true);
  assert.equal(out.disagreement.feedback.reason.length > 0, true);
  assert.ok(!Object.values(out.people).some((p) => p.name === 'Jordan' && out.disagreement.after.participants.some((x) => x.name === 'Jordan')), 'Jordan is not in the room, so never used');
});
