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
const { stopper } = require("../automationStopper");
const { isHoldRequestEnabled } = require("./holdRequest");

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

/** Was this stop (error) or this result a hold-stop? */
function isHoldStop(errorOrResult) {
  if (!errorOrResult) return false;
  if (errorOrResult.details && errorOrResult.details.stage === HOLD_STOP_STAGE) return true;
  return errorOrResult.stage === HOLD_STOP_STAGE;
}

module.exports = { HOLD_STOP_STAGE, holdRequestOf, stopIfHeld, isHoldStop };
