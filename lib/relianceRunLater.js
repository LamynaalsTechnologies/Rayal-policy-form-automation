/**
 * Reliance "Only update" — run it later, when the automation is free.
 *
 * In the History dialog an operator sets a Reliance step back to Pending with "Only update" (instead of "Update & run").
 * The backend then writes the step as pending AND a mark on the part:
 *   onlinePolicy.relianceStages.<part>.runLater = { stage, at, by }
 * This file turns that mark into a run — the owner's rule (2026-10-19): not straight away, but
 *   - when this automation server STARTS (or restarts), and
 *   - when the queue is IDLE: nothing running and nothing ready to start (the "final check" after all work is done).
 *
 * For each mark it re-queues ONLY that part of the policy's job (fresh state: pending, attempts 0 — the same reset the
 * backend's Re-submit does), adds a line to the job's history, and removes the mark. A mark is used ONCE.
 * It is left for a later sweep when the job is running or on hold; it is dropped (with a log line) when the step is
 * no longer pending (it ran meanwhile), when the part is already queued, or when money was paid from the wallet at
 * Reliance for that part (nothing of it may be redone). Old-shape jobs (no parts) are left alone.
 *
 * No .env switch (the owner's rule). Never throws: a sweep that fails only logs.
 */
const core = require("./jobPartsCore");
const stagesCore = require("./relianceStagesCore");

const RUN_LATER_KEYS = ["motor", "od", "tp"];
const MAX_HISTORY = 200;
const MIN_IDLE_GAP_MS = 60 * 1000; // an idle queue is polled often; one sweep a minute is plenty

/** The policies that carry at least one run-later mark. */
function runLaterFilter() {
  return { $or: RUN_LATER_KEYS.map((k) => ({ [`relianceStages.${k}.runLater`]: { $exists: true } })) };
}

/** The part as a fresh run of it: what the backend's Re-submit does to a part (shared/jobParts.js freshState). */
function freshPart(part, now) {
  return {
    ...part,
    status: "pending",
    stopped: false,
    attempts: 0,
    nextRetryAt: now,
    lastError: null,
    lastErrorCode: null,
    stage: null,
    failedAt: null,
    startedAt: null,
    completedAt: null,
    result: {},
    requeue: null,
  };
}

/**
 * What to do with one mark. Pure — the sweep below does the writes.
 * @returns {{action: "requeue"|"wait"|"drop", reason: string}}
 */
function decide({ policy, job, key }) {
  const mark = ((policy.relianceStages || {})[key] || {}).runLater || {};
  const stage = mark.stage;
  if (stagesCore.walletMoneyMoved(policy, key)) return { action: "drop", reason: "paid from the wallet at Reliance" };
  if (stage && stagesCore.stagesFor(policy, key)[stage].status !== "pending") {
    return { action: "drop", reason: `${stagesCore.STAGE_LABEL[stage] || stage} is no longer pending (it ran meanwhile)` };
  }
  if (!job) return { action: "drop", reason: "the policy has no automation job" };
  if (!Array.isArray(job.parts)) return { action: "wait", reason: "an old-shape job (no parts) — use Re-submit" };
  if (job.status === "processing") return { action: "wait", reason: "the automation is running this policy" };
  if (job.status === "hold") return { action: "wait", reason: "the policy is on hold" };
  const part = core.normalizeParts(job.parts).find((p) => p.key === key);
  if (!part || part.status === "cancelled") return { action: "drop", reason: `the policy has no ${key.toUpperCase()} part any more` };
  if (part.status === "processing") return { action: "wait", reason: "this part is running" };
  if (part.status === "pending") return { action: "drop", reason: "the part is already queued" };
  return { action: "requeue", reason: "" };
}

/**
 * One sweep: every run-later mark is looked at once. Never throws.
 * @param {Object} o
 * @param {Object} o.jobs       the RelianceJobQueue collection
 * @param {Object} o.policies   the onlinePolicy collection
 * @param {string} [o.when]     "start" / "idle" — for the log lines
 * @returns {Promise<{requeued: number, waiting: number, dropped: number}>}
 */
async function sweepRunLater({ jobs, policies, when = "idle", now = new Date(), logger = console } = {}) {
  const counts = { requeued: 0, waiting: 0, dropped: 0 };
  let list = [];
  try {
    list = await policies
      .find(runLaterFilter(), { projection: { relianceStages: 1, walletPayment: 1, walletPayment_od: 1, walletPayment_tp: 1, policyId: 1, fullName: 1 } })
      .toArray();
  } catch (e) {
    logger.warn(`[Run later] ⚠️ Could not read the run-later marks (${e && e.message})`);
    return counts;
  }
  for (const policy of list) {
    for (const key of RUN_LATER_KEYS) {
      const mark = ((policy.relianceStages || {})[key] || {}).runLater;
      if (!mark) continue;
      const who = `${policy.policyId || policy._id} ${key.toUpperCase()}`;
      try {
        const job = (await jobs.findOne({ captchaId: policy._id, parts: { $exists: true } })) || (await jobs.findOne({ captchaId: policy._id }));
        const verdict = decide({ policy, job, key });
        if (verdict.action === "wait") {
          counts.waiting++;
          continue;
        }
        if (verdict.action === "drop") {
          await policies.updateOne({ _id: policy._id }, { $unset: { [`relianceStages.${key}.runLater`]: "" } });
          logger.log(`[Run later] ${who}: mark dropped — ${verdict.reason}`);
          counts.dropped++;
          continue;
        }
        const before = core.normalizeParts(job.parts).find((p) => p.key === key);
        const parts = job.parts.map((p) => (p.key === key ? freshPart(p, now) : p));
        const summary = core.summarizeParts(parts, { held: false, now });
        const label = stagesCore.STAGE_LABEL[mark.stage] || "A step";
        const res = await jobs.updateOne(
          { _id: job._id, status: job.status, rev: job.rev === undefined ? { $exists: false } : job.rev },
          {
            $set: { parts, status: summary.status, nextRetryAt: summary.nextRetryAt },
            $push: {
              statusHistory: {
                $each: [
                  {
                    from: before.status,
                    to: "pending",
                    part: key,
                    note: `Reliance ${label} was set back to pending with Only update - run now (automation ${when === "start" ? "started" : "free"})`,
                    timestamp: now,
                  },
                ],
                $slice: -MAX_HISTORY,
              },
            },
            $inc: { rev: 1 },
          }
        );
        if (!res.matchedCount) {
          counts.waiting++; // the job changed under us (claimed, edited) — the next sweep looks again
          continue;
        }
        await policies.updateOne({ _id: policy._id }, { $unset: { [`relianceStages.${key}.runLater`]: "" } });
        logger.log(`[Run later] ▶ ${who}: ${label} queued (set back with Only update; automation ${when === "start" ? "started" : "free"})`);
        counts.requeued++;
      } catch (e) {
        logger.warn(`[Run later] ⚠️ ${who}: ${e && e.message}`);
      }
    }
  }
  return counts;
}

/**
 * The idle check, throttled: at most one sweep a minute however often the empty queue is polled.
 * @returns {Function} async ({ jobs, policies, logger }) => counts | null (skipped)
 */
function createIdleSweeper({ minGapMs = MIN_IDLE_GAP_MS, clock = () => Date.now() } = {}) {
  let last = 0;
  let running = false;
  return async (args) => {
    const t = clock();
    if (running || t - last < minGapMs) return null;
    running = true;
    last = t;
    try {
      return await sweepRunLater({ ...args, when: "idle" });
    } finally {
      running = false;
    }
  };
}

module.exports = { runLaterFilter, freshPart, decide, sweepRunLater, createIdleSweeper, MIN_IDLE_GAP_MS };
