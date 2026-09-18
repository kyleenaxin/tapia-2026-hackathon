import { randomBytes } from 'node:crypto';
import { createTrace } from './trace.js';
import { runSoloAgent, runGroupAgent, DEFAULT_BUDGET } from './agent.js';
import { applyAnswers } from './intake.js';
import { HttpError } from '../store.js';

// A job is one agent run. It may first wait for the person to answer follow-up questions.
export function createJobs({ store, catalog, sources, budget = DEFAULT_BUDGET, now = () => Date.now() }) {
  const jobs = new Map();
  const latest = new Map(); // "solo:userId" or "group:ROOM" -> last finished job id

  const keyOf = (j) => (j.mode === 'group' ? `group:${j.roomCode}` : `solo:${j.userId}`);

  function create({ userId, actorId = userId, mode = 'solo', roomCode = null, questions = [], notes = [], banner = null, previousFrom = null, runner = null }) {
    const job = {
      id: randomBytes(9).toString('base64url'),
      userId, actorId, mode, roomCode, questions, notes, banner, runner,
      status: questions.length ? 'asking' : 'created',
      trace: null, result: null, error: null,
      createdAt: now(),
      previous: previousFrom ? jobs.get(latest.get(previousFrom))?.result ?? null : null,
    };
    jobs.set(job.id, job);
    if (jobs.size > 300) jobs.delete(jobs.keys().next().value);
    if (!questions.length) start(job);
    return job;
  }

  function start(job) {
    job.status = 'running';
    job.trace = createTrace();
    if (job.mode === 'intake') { job.status = 'done'; return Promise.resolve(); }
    const run = job.runner ? () => job.runner(job)
      : job.mode === 'group'
      ? () => runGroupAgent({ hostId: job.userId, roomCode: job.roomCode, store, catalog, sources, trace: job.trace, previous: job.previous, budget, now })
      : () => runSoloAgent({ userId: job.userId, store, catalog, sources, trace: job.trace, previous: job.previous, budget, now });
    job.promise = run().then((result) => {
      job.result = result;
      job.status = 'done';
      latest.set(keyOf(job), job.id);
    }).catch((e) => {
      job.status = 'error';
      job.error = e instanceof HttpError ? e.message : 'The agent hit an unexpected problem. Try again.';
      if (!(e instanceof HttpError)) console.error(e);
    });
    return job.promise;
  }

  function answer(job, answers) {
    if (job.status !== 'asking') return;
    job.notes.push(...applyAnswers({ store, catalog, userId: job.userId, questions: job.questions, answers }));
    job.answers = answers;
    start(job);
  }

  const get = (id) => jobs.get(id) ?? null;
  const latestFor = (mode, key) => jobs.get(latest.get(`${mode}:${key}`)) ?? null;

  return { create, answer, get, latestFor, jobs };
}

export function jobView(job) {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    current: job.trace?.current ?? null,
    steps: job.trace?.steps ?? [],
    error: job.error,
  };
}
