/**
 * Automation job "parts": the pure logic that lets ONE job per policy carry a
 * separate status for each thing being bought (OD, TP, OD+TP, PA).
 *
 * THIS FILE EXISTS TWICE and the two copies must stay byte-identical:
 *   RayalBrokers-backend/shared/jobPartsCore.js
 *   Rayal-policy-form-automation/lib/jobPartsCore.js
 * (the repos share no code — same arrangement as companyRules.js /
 * policySettings.js). It has no requires, so it can be copied as is.
 *
 * A part: { key: "motor"|"od"|"tp"|"pa", label, kind: "bundled"|"portal"|"brisk"|"withPart",
 *           company, status, stopped, dependsOn, mirrors, attempts, maxAttempts,
 *           nextRetryAt, lastError, lastErrorCode, stage, startedAt, completedAt,
 *           failedAt, result, requeue, routingChanged }
 *
 * The JOB keeps its own `status`, derived here by summarizeParts, so every
 * reader that only knows the queue states (pending, processing, completed ...)
 * keeps working.
 */

const PART_ORDER = ["od", "tp", "motor", "pa"];
const MOTOR_KEYS = ["motor", "od", "tp"];
const SHORT_LABEL = { od: "OD", tp: "TP", motor: "OD + TP", pa: "PA" };

const DONE = ["completed", "completed_with_errors"];
const FAILED = [
  "failed",
  "failed_login_form",
  "failed_post_submission",
  "failed_validation",
];
// Worst first: what the job reports when its motor parts have failed.
const FAILURE_RANK = [
  "failed_post_submission",
  "failed_validation",
  "failed_login_form",
  "failed",
];

const BACKOFF_BASE_MS = 60 * 1000;
const HYDRATION_RETRY_MS = 30 * 1000;
const RUNNING_STATUS = "processing";

const isDone = (status) => DONE.includes(status);
const isFailed = (status) => FAILED.includes(status);
const isMotorKey = (key) => MOTOR_KEYS.includes(key);
const norm = (v) => String(v || "").trim().toLowerCase();
const toTime = (v) => {
  if (!v) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};
const orderOf = (key) => {
  const i = PART_ORDER.indexOf(key);
  return i === -1 ? PART_ORDER.length : i;
};
const sortParts = (parts) =>
  [...(parts || [])].sort((a, b) => orderOf(a.key) - orderOf(b.key));

/** Which insurer window a part uses: the insurer's, or "brisk" for the API-only PA. */
const capacityBucket = (part) => (part.kind === "brisk" ? "brisk" : norm(part.company));

/**
 * Fill in what is derived, without changing what is stored:
 *  - a `withPart` part (PA bought together with another part) mirrors it;
 *  - a part with a `dependsOn` gets `waitingFor` while that part is not done,
 *    and `blockedBy` when that part has failed or was cancelled.
 */
const normalizeParts = (parts) => {
  const list = (parts || []).map((p) => ({ ...p }));
  const byKey = new Map(list.map((p) => [p.key, p]));

  for (const p of list) {
    if (p.kind === "withPart" && p.mirrors && byKey.has(p.mirrors)) {
      const src = byKey.get(p.mirrors);
      p.status = src.status;
      p.stopped = !!src.stopped;
      p.lastError = src.lastError || null;
      p.lastErrorCode = src.lastErrorCode || null;
      p.stage = src.stage || null;
      p.attempts = src.attempts || 0;
      p.maxAttempts = src.maxAttempts || p.maxAttempts;
      p.nextRetryAt = src.nextRetryAt || null;
      p.startedAt = src.startedAt || null;
      p.completedAt = src.completedAt || null;
      p.failedAt = src.failedAt || null;
    }
  }

  for (const p of list) {
    delete p.waitingFor;
    delete p.blockedBy;
    if (!p.dependsOn || p.status !== "pending") continue;
    const dep = byKey.get(p.dependsOn);
    if (!dep || isDone(dep.status)) continue;
    p.waitingFor = dep.key;
    if (isFailed(dep.status) || dep.status === "cancelled") p.blockedBy = dep.key;
  }
  return list;
};

/** Can this part be started by the automation right now (ignoring the clock)? */
const isRunnable = (p) =>
  p.status === "pending" && p.kind !== "withPart" && !p.waitingFor;

const activeParts = (parts) => parts.filter((p) => p.status !== "cancelled");

const describeWord = (p) => {
  if (p.status === "pending") return p.waitingFor ? `waiting for ${SHORT_LABEL[p.waitingFor] || p.waitingFor}` : "pending";
  if (p.status === "processing") return "in progress";
  if (p.status === "completed") return "completed";
  if (p.status === "completed_with_errors") return "completed with errors";
  if (p.stopped) return "not automated yet";
  if (isFailed(p.status)) return "failed";
  return String(p.status || "pending");
};

/** "OD and TP completed, PA waiting for OD" */
const describeParts = (parts) => {
  const groups = [];
  for (const p of sortParts(activeParts(parts))) {
    const word = describeWord(p);
    const g = groups.find((x) => x.word === word);
    if (g) g.names.push(SHORT_LABEL[p.key] || p.key);
    else groups.push({ word, names: [SHORT_LABEL[p.key] || p.key] });
  }
  return groups.map((g) => `${g.names.join(" and ")} ${g.word}`).join(", ");
};

/**
 * The job's own queue state, next retry time and a readable line, from its parts.
 * First matching rule wins.
 */
const summarizeParts = (parts, { held = false, now = new Date() } = {}) => {
  const list = normalizeParts(parts);
  const active = activeParts(list);
  const label = describeParts(list);
  const result = (status, nextRetryAt = null) => ({
    status,
    nextRetryAt,
    label,
    parts: list,
  });

  if (!active.length) return result("failed_validation");
  if (held) return result("hold");
  if (active.some((p) => p.status === RUNNING_STATUS)) return result("processing");

  const runnable = active.filter(isRunnable);
  if (runnable.length) {
    const times = runnable.map((p) => toTime(p.nextRetryAt) ?? now.getTime());
    return result("pending", new Date(Math.min(...times)));
  }

  if (active.every((p) => isDone(p.status))) {
    return result(active.some((p) => p.status === "completed_with_errors") ? "completed_with_errors" : "completed");
  }

  const motor = active.filter((p) => isMotorKey(p.key));
  if (motor.length && motor.every((p) => isDone(p.status))) {
    return result("completed_with_errors");
  }

  const failed = motor.filter((p) => isFailed(p.status)).map((p) => p.status);
  const worst = FAILURE_RANK.find((s) => failed.includes(s)) || "failed";
  return result(worst);
};

/**
 * Pick the part a free automation worker should run next: due, runnable, and
 * whose insurer has a free window. Order: od, tp, motor, pa.
 */
const selectRunnablePart = (job, now = new Date(), hasCapacity = () => true) => {
  const list = sortParts(normalizeParts(job && job.parts));
  const t = now.getTime();
  return (
    list.find((p) => {
      if (!isRunnable(p)) return false;
      const due = toTime(p.nextRetryAt);
      if (due !== null && due > t) return false;
      return hasCapacity(capacityBucket(p));
    }) || null
  );
};

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * Fold one automation run into the job.
 *
 * outcome.type:
 *   success            { documentUploadError?, warning?, result?, alsoUpdate? }
 *   postSubmission     the portal took the submission, a later step failed — never auto-retried
 *   stopped            deliberate stop ("form not built yet") — not retried
 *   nonRetryable       wrong password, feature off ... — not retried
 *   retryable          exception / timeout / temporary portal failure
 *   hydrationRetry     policy data not ready yet — retry soon, attempt not counted
 *   invalid            the policy is missing or its data unusable — fails every unfinished part
 *   briskFailed        { certificateNo? }: the certificate exists but a later step failed
 * outcome.error / errorCode / stage / errorExtra describe a failure.
 * outcome.alsoUpdate = { pa: { status, result, lastError } } sets other parts (a
 * bundled run buys its Brisk PA inside the same run).
 *
 * Returns { parts, jobSet, errorLog, historyEntry, summary } — jobSet is the
 * top-level fields to $set on the job (status, nextRetryAt and the mirrors of
 * the part just run that older readers still look at).
 */
const applyPartOutcome = (job, key, outcome, now = new Date(), { held = false } = {}) => {
  const parts = clone(job.parts || []);
  const part = parts.find((p) => p.key === key);
  if (!part) throw new Error(`applyPartOutcome: job has no "${key}" part`);

  const prevStatus = part.status;
  const nowIso = now;
  let errorLog = null;
  let note = "";

  const startedFor = () => part.startedAt || now;
  const recordError = () => {
    errorLog = {
      timestamp: now,
      attemptNumber: part.attempts,
      errorMessage: outcome.error || "Unknown error",
      errorType: outcome.errorType || "Error",
      stage: outcome.stage || part.stage || null,
      errorCode: outcome.errorCode || null,
      part: key,
      ...(outcome.errorExtra || {}),
    };
    part.lastError = errorLog.errorMessage;
    part.lastErrorCode = errorLog.errorCode;
    part.stage = errorLog.stage;
    part.failedAt = now;
  };
  const fail = (status, stopped = false) => {
    part.status = status;
    part.stopped = stopped;
    part.nextRetryAt = null;
    note = outcome.error || "";
  };
  const retryLater = (delayMs) => {
    part.status = "pending";
    part.nextRetryAt = new Date(now.getTime() + delayMs);
    note = outcome.error || "";
  };

  switch (outcome.type) {
    case "success": {
      part.status = outcome.documentUploadError ? "completed_with_errors" : "completed";
      part.stopped = false;
      part.completedAt = now;
      part.startedAt = startedFor();
      part.nextRetryAt = null;
      part.lastError = null;
      part.lastErrorCode = null;
      part.result = { ...(part.result || {}), ...(outcome.result || {}) };
      const warning = outcome.warning || outcome.documentUploadError;
      if (warning) part.result.warning = warning;
      note = warning ? "Completed with warnings" : "Completed";
      break;
    }
    case "postSubmission":
      part.attempts = (part.attempts || 0) + 1;
      recordError();
      fail("failed_post_submission");
      break;
    case "stopped":
      part.attempts = (part.attempts || 0) + 1;
      recordError();
      fail("failed_login_form", true);
      break;
    case "nonRetryable":
      part.attempts = (part.attempts || 0) + 1;
      recordError();
      fail("failed_login_form");
      break;
    case "retryable": {
      part.attempts = (part.attempts || 0) + 1;
      recordError();
      const max = part.maxAttempts || 5;
      if (part.attempts >= max) fail("failed_login_form");
      else retryLater(BACKOFF_BASE_MS * Math.pow(2, part.attempts - 1));
      break;
    }
    case "hydrationRetry":
      recordError();
      retryLater(HYDRATION_RETRY_MS);
      break;
    case "invalid":
      for (const p of parts) {
        if (p.status === "cancelled" || isDone(p.status)) continue;
        p.status = "failed_validation";
        p.nextRetryAt = null;
        p.lastError = outcome.error || "Policy data is not valid";
        p.failedAt = now;
      }
      part.attempts = (part.attempts || 0) + 1;
      recordError();
      note = outcome.error || "";
      break;
    case "briskFailed":
      part.attempts = (part.attempts || 0) + 1;
      recordError();
      if (outcome.certificateNo) {
        part.status = "completed_with_errors";
        part.result = { ...(part.result || {}), certificateNo: outcome.certificateNo };
        part.completedAt = now;
      } else {
        fail("failed");
      }
      break;
    default:
      throw new Error(`applyPartOutcome: unknown outcome "${outcome.type}"`);
  }

  // An edit that arrived while this part was running asked for it to run again
  // with different details.
  if (part.requeue) {
    const rq = part.requeue;
    if (isDone(part.status)) {
      if (rq.company && norm(rq.company) !== norm(part.company)) {
        part.routingChanged = { from: part.company, to: rq.company, at: rq.at || now };
      }
    } else if (part.status !== "failed_post_submission") {
      part.company = rq.company || part.company;
      if (rq.carriesPa !== undefined) part.carriesPa = rq.carriesPa;
      if (rq.paCoverCompany !== undefined) part.paCoverCompany = rq.paCoverCompany;
      part.status = "pending";
      part.attempts = 0;
      part.stopped = false;
      part.nextRetryAt = now;
    }
    delete part.requeue;
  }

  if (outcome.alsoUpdate) {
    for (const [otherKey, patch] of Object.entries(outcome.alsoUpdate)) {
      const other = parts.find((p) => p.key === otherKey);
      if (!other || isDone(other.status)) continue;
      Object.assign(other, patch, {
        result: { ...(other.result || {}), ...(patch.result || {}) },
      });
      if (isDone(other.status)) other.completedAt = now;
    }
  }

  delete part.currentRun;
  const next = normalizeParts(parts);
  const summary = summarizeParts(next, { held, now });

  const jobSet = {
    status: summary.status,
    nextRetryAt: summary.nextRetryAt,
    parts: next,
    lastAttemptAt: nowIso,
    attempts: part.attempts || 0,
    maxAttempts: part.maxAttempts || job.maxAttempts || 5,
  };
  if (errorLog) {
    jobSet.lastError = errorLog.errorMessage;
    jobSet.lastErrorTimestamp = now;
  }
  if (isDone(part.status)) {
    jobSet.completedAttempt = (part.attempts || 0) + 1;
    if (summary.status === "completed" || summary.status === "completed_with_errors") jobSet.completedAt = now;
  }
  if (isFailed(summary.status)) jobSet.failedAt = now;

  const historyEntry = {
    from: prevStatus,
    to: part.status,
    part: key,
    note: note || undefined,
    timestamp: now,
  };

  return { parts: next, jobSet, errorLog, historyEntry, summary };
};

module.exports = {
  PART_ORDER,
  MOTOR_KEYS,
  SHORT_LABEL,
  isDone,
  isFailed,
  isMotorKey,
  capacityBucket,
  sortParts,
  normalizeParts,
  describeParts,
  summarizeParts,
  selectRunnablePart,
  applyPartOutcome,
};
