/**
 * The ORDER of a two-insurer policy's own jobs: the TP insurer's job is bought first, and the OD job waits for it.
 *
 * Why. An own-damage policy sold on its own (Reliance OD, say) asks for the existing third-party policy — its insurer,
 * number and dates — and it must not be bought at all when the third-party half failed: the customer would be left
 * with an OD policy and no TP. So "OD and TP at the same time" is wrong in both directions; TP first, and OD only once
 * the TP insurer's job has been bought.
 *
 * Where. Only the old two-job shape (POLICY_JOB_PARTS_ENABLED off) needs this at claim time: its OD and TP are two
 * documents of one policy, keyed {captchaId, policyType}, that the queue would otherwise start together, each in its
 * own insurer's window. A job WITH `parts` is one document that already runs one part at a time and orders them with
 * `dependsOn` (the backend's buildJobParts puts `od` after `tp`), so it never comes through here.
 *
 * "Bought" is `completed` or `completed_with_errors` (the payment link went out; the error is a document upload or a
 * Brisk certificate). Anything else — pending, running, on hold, any failure — keeps the OD job waiting; when the TP job
 * is fixed and completes, the pass that its own run triggers starts the OD job. A policy with no TP job (single
 * company, or TP deselected) is not held.
 *
 * Switch: OD_WAITS_FOR_TP in .env, ON unless it is explicitly false / 0 / no / off — a way back to "independent jobs"
 * without a deploy.
 */

const DONE = new Set(["completed", "completed_with_errors"]);
// Nothing to wait for: the TP job was cancelled. (A deselected TP job is deleted, not cancelled — both mean "no TP".)
const NOTHING_TO_WAIT_FOR = new Set(["cancelled"]);

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

/** "od" | "tp" | "" — where the backend and the automation each keep it. */
const policyTypeOf = (job) =>
  norm(job && (job.policyType || (job.formData && job.formData.policyType) || (job.metadata && job.metadata.policyType)));

/** A job without `parts` — the shape this ordering exists for. */
const isLegacyJob = (job) => !(job && Array.isArray(job.parts) && job.parts.length > 0);

/** An OD job of the two-job shape: the only kind that is ever held back. */
const isLegacyOdJob = (job) => isLegacyJob(job) && policyTypeOf(job) === "od" && !!job.captchaId;

const isOdWaitsForTpEnabled = (env = process.env) => !/^(0|false|no|off)$/i.test(norm(env.OD_WAITS_FOR_TP));

/** Is a TP job (by status) still ahead of its OD job? */
const tpIsAhead = (tp) => !!tp && !DONE.has(tp.status) && !NOTHING_TO_WAIT_FOR.has(tp.status);

/**
 * Split the queue's candidates into those that may start and the OD jobs that must wait for their TP job.
 * Order is kept. Pure: `tpJobs` is whatever TP documents the caller found for these policies.
 *
 * @param {Object[]} candidates pending jobs, due now
 * @param {Object[]} tpJobs     TP jobs ({captchaId, status, ...}) of the candidates' policies
 * @returns {{ready: Object[], waiting: Array<{job: Object, tp: Object|null}>}}
 */
function splitByTpOrder(candidates, tpJobs) {
  const tpByPolicy = new Map();
  for (const tp of tpJobs || []) tpByPolicy.set(String(tp.captchaId), tp);

  const ready = [];
  const waiting = [];
  for (const job of candidates || []) {
    if (isLegacyOdJob(job)) {
      const tp = tpByPolicy.get(String(job.captchaId));
      if (tpIsAhead(tp)) {
        waiting.push({ job, tp });
        continue;
      }
    }
    ready.push(job);
  }
  return { ready, waiting };
}

/**
 * The queue's gate. One query per pass, and none at all when no OD job is a candidate (or the switch is off).
 *
 * A failed lookup holds every OD candidate for this pass (`tp: null`): while the TP job's state is unknown, buying the OD
 * is the one wrong answer. The next pass asks again.
 *
 * @param {Collection} collection the job queue collection
 * @param {Object[]} candidates
 * @param {{enabled?: boolean, logger?: Object}} [opts]
 * @returns {Promise<{ready: Object[], waiting: Array<{job: Object, tp: Object|null}>}>}
 */
async function holdOdJobsUntilTpDone(collection, candidates, { enabled = isOdWaitsForTpEnabled(), logger = console } = {}) {
  const list = candidates || [];
  if (!enabled) return { ready: list, waiting: [] };

  const policyIds = [...new Set(list.filter(isLegacyOdJob).map((job) => job.captchaId))];
  if (!policyIds.length) return { ready: list, waiting: [] };

  let tpJobs;
  try {
    tpJobs = await collection
      .find(
        { captchaId: { $in: policyIds }, policyType: "tp" },
        // just what the log line needs (companyOfJob reads formData.Companyname) — not whole formData documents
        { projection: { captchaId: 1, status: 1, policyType: 1, "formData.Companyname": 1, "formData.company": 1 } }
      )
      .toArray();
  } catch (error) {
    logger.warn(`[Queue] could not look up the TP jobs of ${policyIds.length} policy(ies) — OD jobs wait this pass: ${error.message}`);
    const waiting = list.filter(isLegacyOdJob).map((job) => ({ job, tp: null }));
    return { ready: list.filter((job) => !isLegacyOdJob(job)), waiting };
  }
  return splitByTpOrder(list, tpJobs);
}

module.exports = {
  holdOdJobsUntilTpDone,
  splitByTpOrder,
  isOdWaitsForTpEnabled,
  isLegacyOdJob,
  policyTypeOf,
  DONE_STATUSES: [...DONE],
};
