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
 * 2026-11-11 (the owner: "stop immediately, anywhere, all companies"): the live stop below no longer switches off at the
 * payment point - Pending Quotes, the Pay page, the payment link are all cut at once. ONLY the money press itself is held
 * back (holdBackForPayment: from the "payment being made" note to the insurer's saved answer, 5-40 s) and the stop fires
 * the moment that answer is saved - the owner chose "finish the payment, then stop" so no money is lost or paid twice.
 *
 * Same switch as the hold request: JOB_HOLD_REQUEST_ENABLED (automation .env). Off = no checks, the run goes on.
 * Only jobs with parts are checked. A failed read never stops a run.
 */
const { stopper, AutomationStoppedError } = require("../automationStopper");
const { isHoldRequestEnabled } = require("./holdRequest");
// 2026-10-22: a run that stops moving for 1.5 minutes is stopped with an error (lib/stallWatch.js). Armed, paused at the
// payment point and disarmed together with the live hold, so every browser flow has it without its own call.
const stallWatch = require("./stallWatch");
// [timing] lines: armLiveHold is where every flow's window becomes a run's window, so the timing links them here.
const stepTiming = require("./stepTiming");

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
  // Past the payment point a stuck page is never cut by the stuck-step watch (an automatic error, not the operator's
  // Hold) - whatever the hold switch says. The live Hold stays armed (2026-11-11); only the money press holds it back.
  if (PAYMENT_POINT.test(String(where || ""))) stallWatch.pause(data);
  if (!isHoldRequestEnabled(env)) return;
  const jobId = data && data._jobId;
  const request = await holdRequestOf(jobId, collection === undefined ? {} : { collection });
  if (!request) return;
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
 * And when even that does not end the run (2026-11-11): a browser command that is itself frozen never returns, so
 * HOLD_CLOSE_AFTER_MS after the stop the window is closed (lib/stallWatch.js closeRunWindow - Chrome's DevTools port,
 * then quit), and the queue stops waiting for the run HOLD_GIVE_UP_MS after it (stallWatch.stopRun -> guard): the part
 * is recorded as held whatever the run is stuck in. A run that unwinds by itself (nearly always) is never touched.
 *
 * Safe by construction:
 *   - the money press is never cut: holdBackForPayment(driver) (called by the Reliance CDT Submit Details and the KSHEMA
 *     Pay with CD Balance right after their "payment being made" note is saved) keeps a Hold waiting until the insurer's
 *     answer is saved on the note, then fires it at once. Release finishes such a policy from the note (number / PDF only).
 *     A Brisk certificate is an API call, never a browser command, so a Hold cannot cut it either;
 *   - closing the window (quit / close) always passes through, and the form's finally disarms before its cleanup;
 *   - a stage write of "failed" made while unwinding is dropped (lib: relianceStages.markStage) — an abort is not a
 *     failure of the step, so Release does not see a false "failed";
 *   - same switch as every hold: JOB_HOLD_REQUEST_ENABLED (off = nothing is armed); a failed read never stops a run.
 */
const LIVE_POLL_MS = 1000;
const HOLD_CLOSE_AFTER_MS = 5000; // the run has not let go of the browser this long after the stop: close the window
const HOLD_GIVE_UP_MS = 15000; // ...and the queue stops waiting for it this long after the stop
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

function armLiveHold(
  driver,
  data,
  {
    collection,
    env = process.env,
    intervalMs = LIVE_POLL_MS,
    log = console.log,
    stall = {},
    closeAfterMs = HOLD_CLOSE_AFTER_MS,
    giveUpMs = HOLD_GIVE_UP_MS,
    closeWindow = (k) => stallWatch.closeRunWindow(k),
  } = {}
) {
  const key = keyOf(data);
  if (!key || !driver || typeof driver.execute !== "function") return false;
  // Link this window to its run for the [timing] lines (a lookup table only - the driver is not changed).
  stepTiming.attach(driver, data);
  // First (underneath the hold's own wrapper): the stuck-step watch is on whatever the hold switch says.
  stallWatch.arm(driver, data, stall);
  if (!isHoldRequestEnabled(env)) return false;
  disarmLiveHold(data);
  const state = {
    driver,
    hadOwn: Object.prototype.hasOwnProperty.call(driver, "execute"),
    original: driver.execute,
    fired: null,
    paying: 0, // > 0 while a money press is in flight (holdBackForPayment)
    waiting: null, // a Hold that came during the money press - fired the moment the answer is saved
    closeTimer: null,
  };
  state.fire = (request) => {
    // state.timer: a read still on its way when this run was disarmed must never fire after it.
    if (state.fired || !state.timer) return;
    if (state.paying > 0) {
      if (!state.waiting) {
        state.waiting = request || {};
        log("⏸️  Hold was pressed while the payment is being made - it stops right after the insurer's answer is saved");
      }
      return;
    }
    state.fired = new AutomationStoppedError(
      "Held by the operator - stopped while a step was running. Release continues from the last finished step with a fresh login.",
      { stage: HOLD_STOP_STAGE, where: "while a step was running", heldBy: (request && request.by) || null }
    );
    if (state.wakeSleepers) state.wakeSleepers(state.fired);
    log("⏸️  Hold was pressed - stopping the running step now; the window is closed and Release continues from the last finished step");
    // The queue stops waiting for this run giveUpMs from now, whatever it is stuck in (lib/stallWatch.js guard).
    stallWatch.stopRun(key, state.fired, giveUpMs);
    // A browser command that is itself frozen never returns: close the window when the run has not let go by then.
    state.closeTimer = setTimeout(() => {
      state.closeTimer = null;
      if (!state.timer) return; // the run unwound and cleaned up by itself
      log("⏸️  The step did not let go of the browser - closing the window");
      Promise.resolve()
        .then(() => closeWindow(key))
        .catch(() => {});
    }, closeAfterMs);
    if (state.closeTimer && state.closeTimer.unref) state.closeTimer.unref();
  };
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
      if (request) state.fire(request);
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
  if (state.closeTimer) clearTimeout(state.closeTimer);
  state.closeTimer = null;
}

/**
 * The money press is starting (the "payment being made" note is saved): a Hold from now on waits until the insurer's
 * answer is saved too. Returns paymentRecorded() - call it right after that answer is written; a Hold that came in
 * between fires at that moment. Calling it twice is harmless. A run that is already held keeps refusing (nothing is
 * pressed then: the click itself is refused). No live hold armed (tests, switch off) = a no-op.
 */
function holdBackForPayment(driver) {
  const state = driver && typeof driver === "object" ? byDriver.get(driver) : null;
  if (!state || state.fired || !state.timer) return () => {};
  state.paying += 1;
  let done = false;
  return function paymentRecorded() {
    if (done) return;
    done = true;
    state.paying = Math.max(0, state.paying - 1);
    if (state.paying === 0 && state.waiting) {
      const request = state.waiting;
      state.waiting = null;
      state.fire(request);
    }
  };
}

/**
 * A step past the payment point that never pays (KSHEMA's recovery of an ISSUED policy): the stuck-step watch is
 * switched off as at the payment point, the Hold stays armed.
 */
function pastPaymentPoint(data) {
  stallWatch.pause(data);
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

module.exports = {
  HOLD_STOP_STAGE,
  holdRequestOf,
  stopIfHeld,
  isHoldStop,
  armLiveHold,
  disarmLiveHold,
  liveHoldStopOf,
  throwIfHeld,
  holdBackForPayment,
  pastPaymentPoint,
};
