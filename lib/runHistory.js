/**
 * Run history (2026-10-22): one record per automation RUN of a policy part, kept on the job as `runHistory[]` - when it
 * started and ended, who started it, which insurer login it used, and how long the proposal / KYC / payment steps took.
 * The History dialog's "Runs" section shows it (backend getErrorMessage -> runs).
 *
 * Before, every run overwrote the last one's start time, login and step times, and nobody recorded who pressed Retry.
 *
 *   startRun     at the start of a run: $push the record (newest RUN_HISTORY_MAX kept)
 *   setRunLogin  once the login is resolved: which username, whose (the user's own / the client's) - never the password
 *   markRunStep  when a step ends (relianceStages.markStage - Reliance and KSHEMA - and the National flows)
 *   runEndUpdate the end, merged into the run's one outcome write (partRunner.writePartOutcome / server.js)
 *
 * WHO STARTED IT: the backend stamps `pendingTrigger {kind, by, at}` on the job each time it queues it (created, edited,
 * retried, released, re-submitted, a step "run now"). A run takes that trigger when no earlier run of the same part
 * started after it; otherwise the run is the queue's own automatic retry. So OD and TP started by the same edit both
 * show the editor, and attempt 2 after a failure shows "automatic retry".
 *
 * Every write here is best-effort and never throws: a run is never stopped because its history could not be written.
 */
const crypto = require("crypto");

const RUN_HISTORY_MAX = 100;
const STEPS = ["proposal", "kyc", "payment"];

/** The job queue collection of the running server (mongoose is connected there); null when not connected (tests). */
function defaultCollection() {
  try {
    const conn = require("mongoose").connection;
    return conn && conn.readyState === 1 ? conn.collection("RelianceJobQueue") : null;
  } catch (e) {
    return null;
  }
}

function toId(id) {
  if (!id || typeof id !== "string") return id;
  try {
    const { ObjectId } = require("mongodb");
    return ObjectId.isValid(id) ? new ObjectId(id) : id;
  } catch (e) {
    return id;
  }
}

const time = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Who started this run: the job's pendingTrigger, unless a run of this part already started after it (then this run is
 * the queue's own retry). Jobs queued before the trigger existed: "queued", nobody named.
 */
function triggerFor(job, partKey) {
  const pending = job && job.pendingTrigger;
  const at = pending && time(pending.at);
  if (!pending || at === null) return { kind: "queued", by: null, at: null };
  const later = (job.runHistory || []).some((r) => r && r.part === partKey && time(r.startedAt) !== null && time(r.startedAt) >= at);
  if (later) return { kind: "auto-retry", by: null, at: null };
  return { kind: String(pending.kind || "queued"), by: pending.by ? String(pending.by) : null, at: pending.at };
}

/** The record a run starts with. */
function newRun(job, part, { attempt, now = new Date(), runId = crypto.randomUUID() } = {}) {
  return {
    runId,
    part: part.key,
    company: part.company || null,
    attempt: attempt || 1,
    startedAt: now,
    endedAt: null,
    durationMs: null,
    outcome: "running",
    error: null,
    trigger: triggerFor(job, part.key),
    credential: null,
    steps: {},
  };
}

/** The login a run used, without the password. */
function loginOf(resolved) {
  if (!resolved || !resolved.creds) return null;
  const c = resolved.creds;
  return {
    id: c._id ? String(c._id) : null,
    username: c.username || null,
    source: resolved.source || null, // "user" = the policy user's own login, "client" = the client's
    matchedBy: resolved.matchedBy || null,
    ownerId: c.userId ? String(c.userId) : null,
  };
}

/* ------------------------------ the run's clock, per process ------------------------------ */

const clocks = new Map(); // runId -> { startedAt, lastAt }
const remember = (runId, startedAt) => {
  clocks.set(runId, { startedAt: time(startedAt), lastAt: time(startedAt) });
  if (clocks.size > 500) clocks.delete(clocks.keys().next().value);
};

/* ------------------------------ writes (never throw) ------------------------------ */

async function startRun(collection, job, part, { attempt, now = new Date(), runId } = {}) {
  const run = newRun(job, part, { attempt, now, runId });
  remember(run.runId, now);
  const col = collection || defaultCollection();
  if (!col || !job || !job._id) return run.runId;
  try {
    await col.updateOne({ _id: job._id }, { $push: { runHistory: { $each: [run], $slice: -RUN_HISTORY_MAX } } });
  } catch (e) {
    /* history is best-effort */
  }
  return run.runId;
}

async function setRunLogin(collection, jobId, runId, resolved) {
  const login = loginOf(resolved);
  const col = collection || defaultCollection();
  if (!col || !jobId || !runId || !login) return false;
  try {
    await col.updateOne(
      { _id: jobId },
      { $set: { "runHistory.$[run].credential": login } },
      { arrayFilters: [{ "run.runId": runId }] }
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * A step of the running run ended. `ms` = since the previous step of THIS run ended (or the run started).
 * @param {Object} data  the run's form data: _jobId, _runId (set by the runners)
 */
async function markRunStep(data, stage, { status = "completed", mode, now = new Date(), collection } = {}) {
  const runId = data && data._runId;
  const jobId = data && data._jobId;
  if (!runId || !jobId || !STEPS.includes(stage)) return false;
  const clock = clocks.get(runId) || { startedAt: time(data._runStartedAt), lastAt: time(data._runStartedAt) };
  const at = time(now);
  const ms = clock.lastAt !== null && at !== null ? Math.max(0, at - clock.lastAt) : null;
  clocks.set(runId, { ...clock, lastAt: at });
  const col = collection || defaultCollection();
  if (!col) return false;
  try {
    await col.updateOne(
      { _id: toId(String(jobId)) },
      { $set: { [`runHistory.$[run].steps.${stage}`]: { at: now, ms, status, ...(mode ? { mode } : {}) } } },
      { arrayFilters: [{ "run.runId": runId }] }
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The run's end, as a piece of the outcome write: { $set, arrayFilters }. null without a runId.
 * @param {string} outcome  the part's new status (completed / failed_post_submission / pending ...)
 */
function runEndUpdate(runId, { outcome, error = null, now = new Date(), startedAt } = {}) {
  if (!runId) return null;
  const clock = clocks.get(runId);
  const start = time(startedAt) !== null ? time(startedAt) : clock ? clock.startedAt : null;
  const end = time(now);
  clocks.delete(runId);
  return {
    $set: {
      "runHistory.$[run].endedAt": now,
      "runHistory.$[run].durationMs": start !== null && end !== null ? Math.max(0, end - start) : null,
      "runHistory.$[run].outcome": outcome || "ended",
      "runHistory.$[run].error": error ? String(error).slice(0, 500) : null,
    },
    arrayFilters: [{ "run.runId": runId }],
  };
}

/** A run's end on its own (the legacy path, where the outcome writes are spread out). Never throws. */
async function endRun(collection, jobId, runId, opts) {
  const piece = runEndUpdate(runId, opts);
  const col = collection || defaultCollection();
  if (!piece || !col || !jobId) return false;
  try {
    await col.updateOne({ _id: jobId }, { $set: piece.$set }, { arrayFilters: piece.arrayFilters });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  RUN_HISTORY_MAX,
  triggerFor,
  newRun,
  loginOf,
  startRun,
  setRunLogin,
  markRunStep,
  runEndUpdate,
  endRun,
  _clocks: clocks,
};
