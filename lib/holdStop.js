/**
 * "Hold" pressed while the automation RUNS a policy — stop it now, at the next safe step (the owner, 2026-10-19).
 *
 * Before: the hold was only recorded (`holdRequested`, lib/holdRequest.js) and the run went on to the end of its
 * attempt. Now the Reliance form asks at every safe step boundary — stopIfHeld(data, "before the KYC") — and when this
 * job carries a hold request the run stops right there:
 *   - the window is closed and the job's browser profile deleted (a fresh login / session on Release),
 *   - the part goes back to pending without counting an attempt (jobPartsCore outcome "held"), and the queue turns the
 *     job into "hold" (lib/holdRequest.js applyHoldRequests),
 *   - the steps already finished stay finished (relianceStages), so Release continues from the step it stopped at:
 *     the same proposal / referral number, no new proposal unless it stopped before Save.
 * Safe steps only: never after Pay is pressed (a wallet payment in flight must finish and be recorded).
 *
 * Same switch as the hold request: JOB_HOLD_REQUEST_ENABLED (automation .env). Off = no checks, the run goes on.
 * Only jobs with parts are checked. A failed read never stops a run.
 */
const { stopper, AutomationStoppedError } = require("../automationStopper");
const { isHoldRequestEnabled } = require("./holdRequest");
// 2026-10-22: a run that stops moving for 1.5 minutes is stopped with an error (lib/stallWatch.js). Armed, paused at the
// payment point and disarmed together with the live hold, so every browser flow has it without its own call.
const stallWatch = require("./stallWatch");

const HOLD_STOP_STAGE = "operator-hold";

/** The job queue collection of the running server (mongoose is connected there); null when not connected (tests). */
function defaultCollection() {
  try {
    const mongoose = require("mongoose");
    const conn = mongoose.connection;
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

/** This job's hold request, or null. Never throws. */
async function holdRequestOf(jobId, { collection = defaultCollection() } = {}) {
  if (!jobId || !collection) return null;
  try {
    const job = await collection.findOne(
      { _id: toId(jobId), parts: { $exists: true }, holdRequested: { $exists: true } },
      { projection: { holdRequested: 1 } }
    );
    return job ? job.holdRequested || {} : null;
  } catch (e) {
    return null;
  }
}

/**
 * Stop the run here when this job's hold was asked for (throws the stopper's error — every catch of the form lets an
 * automation stop through). The sentence has no colon (the operator error rule).
 */
async function stopIfHeld(data, where, { collection, env = process.env, log = console.log } = {}) {
  // Past the payment point a stuck page is never cut (a payment in flight must finish) - whatever the hold switch says.
  if (PAYMENT_POINT.test(String(where || ""))) stallWatch.pause(data);
  if (!isHoldRequestEnabled(env)) return;
  const jobId = data && data._jobId;
  const request = await holdRequestOf(jobId, collection === undefined ? {} : { collection });
  if (!request) {
    // Past the payment point no hold stops a run in the middle of a step any more (see armLiveHold).
    if (PAYMENT_POINT.test(String(where || ""))) disarmLiveHold(data);
    return;
  }
  log(`⏸️  Hold was pressed - stopping ${where}; the window is closed and Release continues from this step`);
  stopper(`Held by the operator - stopped ${where}. Release continues from this step with a fresh login.`, {
    stage: HOLD_STOP_STAGE,
    where,
    heldBy: request.by || null,
  });
}

/**
 * ── Hold stops a running step AT ONCE (the owner, 2026-10-21: "click the hold when processing, it does not stop") ──
 *
 * stopIfHeld only looks at step boundaries, so a Hold pressed in the middle of a long step (the KSHEMA quote form, a KYC
 * wait) was not seen until that step ended. armLiveHold watches the job's hold request in the background (every
 * LIVE_POLL_MS) and, the moment it is there, makes EVERY further browser command of this run fail with the hold-stop
 * error: the run unwinds within a second, wherever it is. The form's outer catch hands it back as a hold-stop (window
 * closed, profile deleted, part pending without an attempt, Release continues from the last FINISHED step).
 *
 * The refusal alone did not end a run whose helpers catch every error (2026-10-31, a live KSHEMA run: each remaining field
 * was looked for 10 s and reported missing, then tried again). So the waits end too (driver.sleep fails the same way), and
 * a helper that swallowed the refusal asks throwIfHeld(driver) before it carries on.
 *
 * Safe by construction:
 *   - it is switched off for good at the payment point ("before the payment" / "before Pay" in stopIfHeld): a wallet
 *     payment in flight, or a Brisk certificate, is never cut. After that point only the old boundary checks remain;
 *   - closing the window (quit / close) always passes through, and the form's finally disarms before its cleanup;
 *   - a stage write of "failed" made while unwinding is dropped (lib: relianceStages.markStage) — an abort is not a
 *     failure of the step, so Release does not see a false "failed";
 *   - same switch as every hold: JOB_HOLD_REQUEST_ENABLED (off = nothing is armed); a failed read never stops a run.
 */
const LIVE_POLL_MS = 2000;
const LIVE_MAX_MS = 45 * 60 * 1000; // a run never lasts this long (JOB_TIMEOUT_MS is 15 min); the watcher dies anyway
const PAYMENT_POINT = /before (the )?payment|before pay\b/i;
const PASS_THROUGH = new Set(["quit", "close"]);
const REFUSE_AFTER_MS = 20;
const live = new Map(); // String(jobId) -> { driver, hadOwn, original, patched, timer, fired }
const byDriver = new WeakMap(); // driver -> the same state, for a helper that has only the driver

const keyOf = (data) => (data && data._jobId ? String(data._jobId) : "");
// A wait used to be unable to fail: one nobody awaits must not become an unhandled rejection, which ends the whole server.
const quietly = (promise) => {
  promise.catch(() => {});
  return promise;
};

function armLiveHold(driver, data, { collection, env = process.env, intervalMs = LIVE_POLL_MS, log = console.log, stall = {} } = {}) {
  const key = keyOf(data);
  if (!key || !driver || typeof driver.execute !== "function") return false;
  // First (underneath the hold's own wrapper): the stuck-step watch is on whatever the hold switch says.
  stallWatch.arm(driver, data, stall);
  if (!isHoldRequestEnabled(env)) return false;
  disarmLiveHold(data);
  const state = { driver, hadOwn: Object.prototype.hasOwnProperty.call(driver, "execute"), original: driver.execute, fired: null };
  // Never an instant refusal: a retry loop whose catch swallows it would spin and freeze the other job in this process.
  const refuse = () => quietly(new Promise((_, reject) => setTimeout(() => reject(state.fired), REFUSE_AFTER_MS)));
  state.patched = function liveHoldExecute(command, ...rest) {
    if (state.fired) {
      const name = command && typeof command.getName === "function" ? command.getName() : "";
      if (!PASS_THROUGH.has(name)) return refuse();
    }
    return state.original.call(this, command, ...rest);
  };
  driver.execute = state.patched;
  if (typeof driver.sleep === "function") {
    state.heldNow = new Promise((_, reject) => {
      state.wakeSleepers = reject;
    });
    state.heldNow.catch(() => {}); // nobody may be sleeping when it fires
    state.hadOwnSleep = Object.prototype.hasOwnProperty.call(driver, "sleep");
    state.originalSleep = driver.sleep;
    state.patchedSleep = function liveHoldSleep(ms) {
      if (state.fired) return refuse();
      return quietly(Promise.race([state.originalSleep.call(this, ms), state.heldNow]));
    };
    driver.sleep = state.patchedSleep;
  }
  byDriver.set(driver, state);
  let busy = false;
  const startedAt = Date.now();
  state.timer = setInterval(async () => {
    if (busy || state.fired) return;
    if (Date.now() - startedAt > LIVE_MAX_MS) return stopWatching(state);
    busy = true;
    try {
      const request = await holdRequestOf(key, collection === undefined ? {} : { collection });
      // state.timer: a read still on its way when the payment point disarmed this run must never fire after it.
      if (request && !state.fired && state.timer) {
        state.fired = new AutomationStoppedError(
          "Held by the operator - stopped while a step was running. Release continues from the last finished step with a fresh login.",
          { stage: HOLD_STOP_STAGE, where: "while a step was running", heldBy: request.by || null }
        );
        if (state.wakeSleepers) state.wakeSleepers(state.fired);
        log("⏸️  Hold was pressed - stopping the running step now; the window is closed and Release continues from the last finished step");
      }
    } finally {
      busy = false;
    }
  }, intervalMs);
  if (state.timer && state.timer.unref) state.timer.unref();
  if (live.size > 200) live.delete(live.keys().next().value);
  live.set(key, state);
  return true;
}

function stopWatching(state) {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Stop watching and give the driver its own execute back. The fired stop (if any) stays readable. Never throws. */
function disarmLiveHold(data) {
  const state = live.get(keyOf(data));
  if (!state) {
    stallWatch.disarm(data);
    return;
  }
  stopWatching(state);
  try {
    if (state.driver.execute === state.patched) {
      if (state.hadOwn) state.driver.execute = state.original;
      else delete state.driver.execute;
    }
    if (state.patchedSleep && state.driver.sleep === state.patchedSleep) {
      if (state.hadOwnSleep) state.driver.sleep = state.originalSleep;
      else delete state.driver.sleep;
    }
  } catch (e) {
    /* the driver is going away anyway */
  }
  if (!state.fired) live.delete(keyOf(data));
  stallWatch.disarm(data); // after the hold's wrapper (on top) is gone, so the driver gets its own execute back
}

/** The hold-stop error when a live hold has fired for this job's run, else null. */
function liveHoldStopOf(data) {
  const state = live.get(keyOf(data));
  return (state && state.fired) || null;
}

/** Throws the hold-stop when this driver's run was held. For a helper whose catch may have swallowed the refusal. */
function throwIfHeld(driver) {
  const state = driver && typeof driver === "object" ? byDriver.get(driver) : null;
  if (state && state.fired) throw state.fired;
}

/** Was this stop (error) or this result a hold-stop? */
function isHoldStop(errorOrResult) {
  if (!errorOrResult) return false;
  if (errorOrResult.details && errorOrResult.details.stage === HOLD_STOP_STAGE) return true;
  return errorOrResult.stage === HOLD_STOP_STAGE;
}

module.exports = { HOLD_STOP_STAGE, holdRequestOf, stopIfHeld, isHoldStop, armLiveHold, disarmLiveHold, liveHoldStopOf, throwIfHeld };
