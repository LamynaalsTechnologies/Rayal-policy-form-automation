/**
 * "Hold" pressed while the automation is RUNNING a policy (owner's ask, 2026-10-17).
 *
 * A running job cannot be stopped half way (the insurer's form is open), so the backend records the operator's wish on
 * the job as `holdRequested: { at, by }`. When that attempt ends, whichever path puts the job back to "pending" (a
 * retryable failure's backoff, a timeout's zombie recovery, an unexpected error, a re-queue), it must NOT start again:
 *   - claimFilter(): every claim / scan of the queue skips a job that carries a hold request;
 *   - applyHoldRequests(): each queue pass turns such a pending job into a real "hold" (the queue never claims "hold"),
 *     with a timeline entry saying so. Release (backend) clears the request.
 * A job that ended for good (completed / failed / stopped) keeps nothing to stop: its request is simply dropped.
 *
 * JOB_HOLD_REQUEST_ENABLED in the automation's .env: ON unless false / 0 / no / off. Off = the request is ignored and the
 * job runs its next attempt as before.
 */
const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isHoldRequestEnabled(env = process.env) {
  return !isOff(env.JOB_HOLD_REQUEST_ENABLED);
}

/** Added to every "find a job to start" query. */
function claimFilter(env = process.env) {
  return isHoldRequestEnabled(env) ? { holdRequested: { $exists: false } } : {};
}

const ENDED = ["pending", "processing", "hold"]; // anything else has ended: nothing left to hold

/**
 * Pending jobs with a hold request -> "hold"; ended jobs -> request dropped.
 * @returns {Promise<number>} how many jobs were put on hold now
 */
async function applyHoldRequests(collection, { now = new Date(), env = process.env, logger = console } = {}) {
  if (!isHoldRequestEnabled(env)) return 0;
  const waiting = await collection
    .find({ status: "pending", holdRequested: { $exists: true } })
    .project({ _id: 1, holdRequested: 1, parts: 1, formData: 1 })
    .toArray();
  let held = 0;
  for (const job of waiting) {
    const isParts = Array.isArray(job.parts) && job.parts.length > 0;
    const res = await collection.updateOne(
      { _id: job._id, status: "pending", holdRequested: { $exists: true } },
      {
        $set: { status: "hold", heldAt: now, heldBy: (job.holdRequested && job.holdRequested.by) || null },
        $unset: { holdRequested: "" },
        $push: {
          statusHistory: {
            from: "pending",
            to: "hold",
            note: "held by operator — asked while it was running, applied when that attempt ended",
            timestamp: now,
          },
        },
        ...(isParts ? { $inc: { rev: 1 } } : {}),
      }
    );
    if (res.modifiedCount) {
      held += 1;
      logger.log(
        `[Hold] ⏸️ ${(job.formData && job.formData.firstName) || job._id}: put on hold after its attempt ended (asked while running) — it will not start again until released`
      );
    }
  }
  await collection.updateMany({ status: { $nin: ENDED }, holdRequested: { $exists: true } }, { $unset: { holdRequested: "" } });
  return held;
}

module.exports = { isHoldRequestEnabled, claimFilter, applyHoldRequests };
