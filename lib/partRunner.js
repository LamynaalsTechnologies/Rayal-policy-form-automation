/**
 * Running ONE part of a policy's automation job.
 *
 * A job with a `parts` array (created by the backend when POLICY_JOB_PARTS_ENABLED
 * is on) is one document per policy. The queue claims it once per part:
 *
 *   planClaims -> claimPart -> runPartJob -> writePartOutcome -> job back to
 *   "pending" while other parts remain, so OD, TP and PA of one policy run one
 *   after another, each with its own JOB_TIMEOUT.
 *
 * Everything here takes its collaborators as arguments (the collection, the
 * bundled dispatcher, the handler lookup, the Brisk runner, the clock ...) so it
 * is unit-testable without server.js, which starts a server when imported.
 * The status rules themselves are in jobPartsCore.js (shared with the backend).
 *
 * Jobs WITHOUT `parts` never come through here — they keep server.js's
 * original path unchanged.
 */
const core = require("./jobPartsCore");
const { colorStatus } = require("./consoleColor");
const { isHoldStop } = require("./holdStop");
const stallWatch = require("./stallWatch");
// one record per run on the job: start / end, who started it, which login, step times (lib/runHistory.js)
const runHistory = require("./runHistory");
const { ERROR_CODES, classifyError, beautifyError } = require("./errorHandler");
const { isAutomationStop, stoppedResult } = require("../automationStopper");
const { hasCertificate, saveCertificateNo } = require("./briskPartRunner");
// Byte-identical copy of the backend's shared/tpVehicle.js (a test compares them).
const { tpVehicleOverrides } = require("./tpVehicle");
const { TP_PROJECTION, freshTpDetails, missingTpDetails, defaultTpDates } = require("./existingTpGate");
const { paRoutingProblem } = require("./paRouting");

const MAX_WRITE_ATTEMPTS = 5;
const norm = (v) => String(v || "").trim().toLowerCase();
const truthy = (v) => v === true || ["true", "1", "yes"].includes(norm(v));
const revOf = (job) => (job && job.rev != null ? job.rev : null);
const COMPANY_LABELS = { kshema: "KSHEMA" };
const defaultCompanyLabel = (company) => {
  const key = norm(company);
  return COMPANY_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
};

/** A job the parts flow owns. `parts: []` counts as legacy (nothing to run). */
const hasParts = (job) => Array.isArray(job && job.parts) && job.parts.length > 0;

// Queries that split the collection in two. arrayFilters throw on a document
// without the array, so a parts update must never reach a legacy document.
const LEGACY_JOBS = { "parts.0": { $exists: false } };
const PARTS_JOBS = { "parts.0": { $exists: true } };

/**
 * Change-stream filter that wakes the queue: a new job, or an in-place update
 * that leaves a job pending / (re)schedules it. NOT the claim (status becomes
 * "processing") and NOT the heartbeat (lastHeartbeatAt only).
 */
const QUEUE_WAKE_PIPELINE = [
  {
    $match: {
      $or: [
        { operationType: { $in: ["insert", "replace"] } },
        {
          operationType: "update",
          $or: [
            { "updateDescription.updatedFields.status": "pending" },
            { "updateDescription.updatedFields.nextRetryAt": { $exists: true } },
          ],
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Choosing what to start                                                      */
/* -------------------------------------------------------------------------- */

/**
 * From the pending candidates (oldest first), decide what this pass starts,
 * respecting each insurer's window budget. A parts job contributes at most ONE
 * part (the first due one, order od, tp, motor, pa, whose window is free);
 * a legacy job is counted against its company exactly as before.
 *
 * `activeByCompany` is mutated: a started item reserves its slot for the pass.
 *
 * @returns {{toStart: Array<{job, part: Object|null, bucket: string}>, skippedByCompany: Object}}
 */
function planClaims(candidates, { now = new Date(), activeByCompany, maxParallelFor, companyOfJob }) {
  const toStart = [];
  const skippedByCompany = {};
  const hasRoom = (bucket) => (activeByCompany[bucket] || 0) < maxParallelFor(bucket);
  const skip = (bucket) => {
    skippedByCompany[bucket] = (skippedByCompany[bucket] || 0) + 1;
  };

  for (const candidate of candidates) {
    if (hasParts(candidate)) {
      const part = core.selectRunnablePart(candidate, now, hasRoom);
      if (!part) {
        // Due but blocked only by a full window -> report it as queued.
        const blocked = core.selectRunnablePart(candidate, now, () => true);
        if (blocked) skip(core.capacityBucket(blocked));
        continue;
      }
      const bucket = core.capacityBucket(part);
      activeByCompany[bucket] = (activeByCompany[bucket] || 0) + 1;
      toStart.push({ job: candidate, part, bucket });
      continue;
    }

    const company = companyOfJob(candidate);
    const active = activeByCompany[company] || 0;
    if (active >= maxParallelFor(company)) {
      skip(company);
      continue;
    }
    activeByCompany[company] = active + 1; // reserve the slot for this pass
    toStart.push({ job: candidate, part: null, bucket: company });
  }
  return { toStart, skippedByCompany };
}

/**
 * Atomically claim one part. Succeeds only if the job is still pending, has not
 * been edited since it was read (`rev`) and that part is still pending — so two
 * passes, or an edit landing in between, can never start the same part twice.
 * Does not touch anything else: the other parts stay as they are.
 *
 * @returns the claimed job document (after the update) or null
 */
async function claimPart(collection, job, part, { now = new Date() } = {}) {
  const claim = await collection.findOneAndUpdate(
    {
      _id: job._id,
      status: "pending",
      rev: revOf(job),
      parts: { $elemMatch: { key: part.key, status: "pending" } },
      // "Hold" was pressed while this job ran: it is never started again (lib/holdRequest.js)
      ...require("./holdRequest").claimFilter(),
    },
    {
      $set: {
        status: "processing",
        startedAt: now,
        lastHeartbeatAt: now,
        currentPart: {
          key: part.key,
          company: part.company,
          kind: part.kind,
          bucket: core.capacityBucket(part),
          attempt: (part.attempts || 0) + 1,
          startedAt: now,
        },
        "parts.$[p].status": "processing",
        "parts.$[p].startedAt": now,
      },
      $inc: { rev: 1 },
    },
    { arrayFilters: [{ "p.key": part.key }], returnDocument: "after" }
  );
  return claim && (claim.value !== undefined ? claim.value : claim);
}

/* -------------------------------------------------------------------------- */
/* The part's form data                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The job's shared formData plus this part's overrides.
 *
 *  - Companyname: the part's own insurer, lower-cased as everywhere else.
 *  - portal parts (od / tp): policyType = the key, which is what routes them to
 *    the multiCompany handlers. Bundled and Brisk parts must NOT carry one.
 *  - PA: a portal part buys PA only when it `carriesPa`; a bundled part keeps
 *    the policy's own PA settings but never buys a Brisk certificate inline when
 *    the job has a Brisk part; the Brisk part is always paCover + "Brisk".
 */
function buildPartFormData(job, part) {
  const base = { ...(job.formData || {}) };
  const out = {
    ...base,
    Companyname: norm(part.company || base.Companyname || base.company || "reliance") || "reliance",
    _partKey: part.key,
    _attemptNumber: (part.attempts || 0) + 1,
  };

  if (part.kind === "portal") out.policyType = part.key;
  else delete out.policyType;

  // A policy sold from a Combined Make & Model: the policy's own vehicle fields are
  // the OD vehicle, so the TP insurer's part must fill ITS vehicle (make, model,
  // variant, CC, model-not-found) instead. The same overlay the backend applies to
  // a TP job; the OD part and a bundled part keep the OD vehicle untouched.
  if (part.kind === "portal" && part.key === "tp") Object.assign(out, tpVehicleOverrides(base.tpVehicle));

  if (part.kind === "portal") {
    const carries = !!part.carriesPa && truthy(base.paCover);
    out.paCover = carries;
    if (carries) out.paCoverCompany = part.paCoverCompany || base.paCoverCompany;
  } else if (part.kind === "bundled") {
    if (part.carriesPa && part.paCoverCompany) out.paCoverCompany = part.paCoverCompany;
    // Every company the same way (the owner, 2026-10-31): the insurer's part finishes, then the Brisk part makes the
    // certificate. So the bundled flows' inline step only ever runs for a job with no Brisk part (the old shape).
    const pa = (job.parts || []).find((p) => p.key === "pa" && p.kind === "brisk");
    if (pa) out.briskByPaPart = true;
    if (pa && core.isDone(pa.status)) out.briskCertificateExists = true;
  } else if (part.kind === "brisk") {
    out.paCover = true;
    out.paCoverCompany = "Brisk";
  }
  return out;
}

/**
 * A part must run the way its policy was sold. A policy sold by TWO insurers has
 * to be bought as an OD part and a TP part at their own insurers; running it as
 * one bundled part would buy the whole policy at a single insurer. And a policy
 * sold by ONE insurer is one bundled policy, not an OD + TP pair of portal parts.
 * The backend decides this when it builds the job; this is the last check before
 * any money moves, in case a job was built under different settings (for example
 * the multi-product switch turned off after the policy was sold).
 *
 * @param {Object} part
 * @param {Object} formData  the part's form data (carries `settings`)
 * @param {Array}  parts     every part of the job
 * @returns {string|null} what is wrong, in words an operator can act on, or null
 */
function routingConflict(part, formData, parts = []) {
  const settings = formData && formData.settings;
  // A job queued before `settings` existed carries no routing to check against.
  if (!settings || typeof settings.isMultipleCompany !== "boolean") return null;

  // OD only / TP only: the bundled flows buy the WHOLE comprehensive policy (OD + TP). Whatever put a `motor` part on
  // such a job, running it would sell a product the customer did not ask for.
  const coverage = String((formData && formData.coverage) || "both").toLowerCase();
  if (part.kind === "bundled" && (coverage === "od" || coverage === "tp")) {
    return (
      `This policy sells only ${coverage === "od" ? "own damage (OD)" : "third party (TP)"}, ` +
      `but its job holds one bundled OD + TP part. Running it would buy the whole comprehensive policy. ` +
      `Save the policy again so only the ${coverage.toUpperCase()} part is queued.`
    );
  }

  if (part.kind === "bundled" && settings.isMultipleCompany) {
    return (
      `This policy is sold by two insurers (OD ${settings.ODCompany || "?"}, TP ${settings.TPCompany || "?"}), ` +
      `but its job holds one bundled OD + TP part. Running it would buy the whole policy at one insurer. ` +
      `Check that multi-product policies are switched on, then save the policy again so OD and TP are queued separately.`
    );
  }
  if (part.kind === "portal" && !settings.isMultipleCompany) {
    const keys = (parts || []).map((p) => p.key);
    if (keys.includes("od") && keys.includes("tp")) {
      return (
        `This policy is sold by one insurer (${settings.ODCompany || "?"}) but its job is split into separate OD and TP parts. ` +
        `A single-company policy is bought as one policy. Save the policy again so it is queued as one.`
      );
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Run result -> outcome                                                       */
/* -------------------------------------------------------------------------- */

// What the run itself reports; the bundled path also reads the policy afterwards.
const pickResult = (result) => {
  const out = {};
  if (result && result.proposalNumber) out.proposalNumber = result.proposalNumber;
  if (result && result.policyNumber) out.policyNumber = result.policyNumber;
  return out;
};

function mapBriskResult(result) {
  if (result && result.success) {
    return {
      type: "success",
      result: result.certificateNo ? { certificateNo: result.certificateNo } : {},
      ...(result.skipped ? { warning: `Not bought: ${result.reason}` } : {}),
    };
  }
  return {
    type: "briskFailed",
    error: (result && result.error) || "Brisk certificate failed",
    certificateNo: (result && result.certificateNo) || undefined,
    errorCode: null,
    errorType: "BriskError",
    stage: "brisk",
    errorExtra: { retryable: false },
  };
}

/**
 * What a form module / handler returned -> the outcome applyPartOutcome folds.
 * Mirrors the legacy classification in server.js so every failure reads the
 * same way to operators; screenshots travel in errorExtra.
 */
function mapRunResult(
  result,
  { part, companyName, processingTimeMs = 0, companyLabel = defaultCompanyLabel }
) {
  if (part.kind === "brisk") return mapBriskResult(result);

  if (result && result.success) {
    const completionWarnings = [];
    if (result.briskCertificateError) {
      completionWarnings.push({
        message: `Brisk certificate creation failed: ${result.briskCertificateError}`,
        part: "pa",
      });
    }
    if (result.documentUploadError) {
      completionWarnings.push({ message: result.documentUploadError, part: part.key });
    }
    return {
      type: "success",
      documentUploadError: result.documentUploadError || undefined,
      result: pickResult(result),
      completionWarnings,
      briskCertificateError: result.briskCertificateError || null,
      processingTimeMs,
    };
  }

  // "Hold" pressed while it ran (lib/holdStop.js): not a failure — the part waits, uncounted, for Release
  if (result && result.inProgress === true && isHoldStop(result)) {
    return { type: "held", error: result.error || "Held by the operator", stage: result.stage, processingTimeMs };
  }

  const isPostSubmissionFailure = !!(
    result &&
    (result.postSubmissionFailed ||
      result.stage === "post-submission" ||
      result.stage === "post-calculation")
  );
  const isTerminalFailure = !!(result && result.retryable === false);
  const isInProgress = !!(result && result.inProgress === true);

  // multiCompany handlers carry their own catalogue code (E203, E302 ...); the
  // bundled flows never set one, so for them this is the old three-way choice.
  const handlerCode =
    result && result.errorCode && !isPostSubmissionFailure && !isInProgress
      ? Object.values(ERROR_CODES).find((c) => c.code === result.errorCode)
      : null;
  const errorCode = handlerCode
    ? handlerCode.code
    : isPostSubmissionFailure
      ? "E401"
      : isInProgress
        ? "E100"
        : "E300";
  const errorType = isPostSubmissionFailure
    ? "PostSubmissionError"
    : isInProgress
      ? "AutomationIncomplete"
      : "LoginFormError";
  const severity = handlerCode
    ? handlerCode.severity
    : isPostSubmissionFailure
      ? "critical"
      : isInProgress
        ? "info"
        : "warning";

  const rawError = (result && (result.onPageError || result.error)) || "Unknown error";
  const stopped = !isPostSubmissionFailure && (isInProgress || errorCode === "E100");
  const type = isPostSubmissionFailure
    ? "postSubmission"
    : stopped
      ? "stopped"
      : isTerminalFailure
        ? "nonRetryable"
        : "retryable";

  return {
    type,
    error: beautifyError(rawError, companyLabel(companyName || part.company)),
    errorCode,
    errorType,
    stage: (result && result.stage) || (isPostSubmissionFailure ? "post-submission" : "login-form"),
    errorExtra: {
      severity,
      screenshotUrl: (result && result.screenshotUrl) || null,
      screenshotKey: (result && result.screenshotKey) || null,
      processingTimeMs,
      retryable: !isPostSubmissionFailure && !isTerminalFailure && !stopped,
    },
    processingTimeMs,
  };
}

/** Our own run timer: "[E302] Job timeout after N seconds" (see runPartJob). */
const isJobTimeout = (e) => /\[E302\]\s*Job timeout/i.test((e && e.message) || "");

/**
 * Does this part's run save a proposal at the portal and record its number on the policy? The bundled part does; so
 * do the Reliance OD / TP parts (common/reliance/relianceMultiForm.js is the same flow). The other portal parts
 * (National, KSHEMA) keep the plain retry — nothing says they record a proposal at that moment.
 */
const savesProposalPart = (part, companyName) =>
  part.kind === "bundled" || (part.kind === "portal" && norm(companyName || part.company) === "reliance");

/**
 * The proposal number the portal saved for this policy DURING this attempt, or null.
 * `before` is what the policy held when the attempt started, so an earlier attempt's number is not mistaken for
 * this one's. A lookup that fails is "unknown" -> null, and the timeout is retried as it always was.
 */
async function proposalSavedSince(policies, policyId, before) {
  if (!policyId || !policies) return null;
  try {
    const doc = await policies.findOne({ _id: policyId }, { projection: { proposalNumber: 1 } });
    const now = doc && doc.proposalNumber ? String(doc.proposalNumber) : "";
    return now && now !== (before || "") ? now : null;
  } catch (e) {
    return null;
  }
}

/** A timeout after the proposal was saved: a post-submission failure — shown to an operator, never retried by itself. */
function timeoutAfterProposalOutcome({ proposal, jobTimeoutMs, processingTimeMs = 0, companyName, companyLabel, stalled = false }) {
  const minutes = Math.max(1, Math.round((jobTimeoutMs || 0) / 60000));
  const message =
    (stalled
      ? `The portal stopped responding and the run was stopped, after the portal had saved proposal ${proposal}. `
      : `The run did not finish within ${minutes} minutes, after the portal had saved proposal ${proposal}. `) +
    `It was not started again automatically — a second run would create a second proposal while this one may ` +
    `still be working in its open browser. Check the policy on the portal, then run it again if needed.`;
  return {
    type: "postSubmission",
    error: beautifyError(message, companyLabel(companyName)),
    errorCode: "E401",
    errorType: "PostSubmissionError",
    stage: "post-submission",
    errorExtra: { severity: "critical", retryable: false, processingTimeMs },
    processingTimeMs,
  };
}

/** A thrown error (or timeout) -> outcome. `state.certificateNo` is a Brisk purchase made before it. */
function mapThrownError(
  e,
  { part, companyName, processingTimeMs = 0, state = {}, companyLabel = defaultCompanyLabel }
) {
  if (isAutomationStop(e)) {
    // stopper() was called on purpose: a calm stop, not a failure.
    const stopped = stoppedResult(e);
    return {
      type: "stopped",
      error: stopped.error,
      errorCode: "E100",
      errorType: "AutomationIncomplete",
      stage: stopped.stage,
      errorExtra: { severity: "info", retryable: false, processingTimeMs },
      processingTimeMs,
    };
  }

  const message = (e && e.message) || String(e);
  if (part.kind === "brisk") {
    // Never auto-retried: a timeout may have bought a certificate already.
    return {
      type: "briskFailed",
      error: message,
      certificateNo: state.certificateNo || undefined,
      errorCode: null,
      errorType: "BriskError",
      stage: "brisk",
      errorExtra: { retryable: false, processingTimeMs },
      processingTimeMs,
    };
  }

  const classified = classifyError(e || new Error(message));
  return {
    type: classified.retryable ? "retryable" : "nonRetryable",
    error: beautifyError(e, companyLabel(companyName || part.company)),
    errorCode: classified.code,
    errorType: classified.severity === "critical" ? "SystemError" : "LoginFormError",
    stage: "exception",
    errorExtra: {
      severity: classified.severity,
      retryable: classified.retryable,
      errorStack: (e && e.stack) || null,
      processingTimeMs,
    },
    processingTimeMs,
  };
}

/**
 * After a BUNDLED run succeeded: the Brisk part normally runs next (briskByPaPart). A
 * run that started before that rule may still have bought it inline. Read what it reports (briskCertificate /
 * briskCertificateError / briskCertificateSkipped) and what the policy now
 * holds, and decide the Brisk PA part:
 *   error reported     -> failed (operator retries)
 *   certificate exists -> completed (or completed_with_errors if no PDF stored)
 *   nothing happened   -> left pending, so the Brisk runner does it next.
 * Also fills the proposal / policy number for the motor part.
 *
 * @returns {{alsoUpdate?: Object, warning?: string, result: Object}}
 */
async function paUpdateAfterBundled({ result, job, policies, policyId, now, logger = console }) {
  const out = { result: pickResult(result) };
  let policy = null;
  try {
    policy = await policies.findOne(
      { _id: policyId },
      { projection: { briskCertificate: 1, proposalNumber: 1, policyNumber: 1 } }
    );
  } catch (e) {
    logger.warn(`[partRunner] could not read the policy after the run: ${e.message}`);
  }
  if (policy) {
    if (!out.result.proposalNumber && policy.proposalNumber) out.result.proposalNumber = policy.proposalNumber;
    if (!out.result.policyNumber && policy.policyNumber) out.result.policyNumber = policy.policyNumber;
  }

  const pa = (job.parts || []).find((p) => p.key === "pa");
  const briskPa = pa && pa.kind === "brisk" && !core.isDone(pa.status);
  const briskError = result && result.briskCertificateError;
  if (!briskPa) {
    if (briskError) out.warning = `Brisk certificate creation failed: ${briskError}`;
    return out;
  }

  const cert = policy && policy.briskCertificate;
  const stored = !!(cert && (cert.key || cert.location));
  const boughtNo =
    (result && result.briskCertificate && result.briskCertificate.policyId) ||
    (cert && cert.certificateNo) ||
    null;
  const bought = !!((result && result.briskCertificate) || stored || boughtNo);

  if (briskError) {
    // The message may come from the step after the purchase (download / store).
    const reason = String(briskError).replace(/[.\s]+$/, "");
    const maybeBought = /download|pdf|upload|stor/i.test(reason)
      ? " The certificate may already exist at Brisk — check before running this again."
      : "";
    out.alsoUpdate = {
      pa: {
        status: "failed",
        attempts: (pa.attempts || 0) + 1,
        lastError: `Brisk certificate creation failed: ${reason}.${maybeBought}`,
        stage: "brisk",
        failedAt: now,
      },
    };
  } else if (bought) {
    if (boughtNo && !(cert && (cert.key || cert.location || cert.certificateNo))) {
      // Bought but nothing recorded on the policy: record it, or a later run could buy again.
      try {
        await saveCertificateNo(policies, policyId, String(boughtNo), now);
      } catch (e) {
        logger.warn(`[partRunner] could not record the Brisk certificate number: ${e.message}`);
      }
    }
    out.alsoUpdate = {
      pa: {
        status: stored ? "completed" : "completed_with_errors",
        result: boughtNo ? { certificateNo: String(boughtNo) } : {},
        lastError: stored ? null : "Brisk certificate was created but its PDF was not stored",
        stage: null,
      },
    };
  }
  // else: leave the PA part pending — the Brisk runner buys it next.
  return out;
}

/* -------------------------------------------------------------------------- */
/* Write-back                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Extra top-level fields the legacy path kept on the job for older readers
 * (error code, failure type, screenshot, timings, the final error, warnings).
 */
function legacyJobFields(outcome, r, key) {
  const set = {};
  const after = r.parts.find((p) => p.key === key);
  if (outcome.processingTimeMs != null) set.processingTimeMs = outcome.processingTimeMs;
  if (r.errorLog) {
    set.lastErrorCode = r.errorLog.errorCode || null;
    set.failureType = r.errorLog.errorType || null;
    set.lastScreenshotUrl = r.errorLog.screenshotUrl || null;
    if (after && core.isFailed(after.status)) set.finalError = r.errorLog;
  }
  const warnings = outcome.completionWarnings || [];
  if (warnings.length) {
    set.completionWarnings = warnings.map((w) => w.message);
    set.briskCertificateError = outcome.briskCertificateError || null;
    set.documentUploadError = outcome.documentUploadError || null;
  }
  return set;
}

/**
 * Fold one run's outcome into the job and save it.
 *
 * Re-reads the job first: an edit may have landed while the part ran (the
 * backend flags a running part with `requeue`), and the outcome must be applied
 * to THAT document, not to the one this run started from. The save is
 * conditional on `rev`; if the job changed between the read and the save it is
 * read again and the outcome re-applied (max 5 times).
 *
 * `lib/errorLogger.logErrorToJobQueue` writes `status` on its own and must stay
 * unused for parts jobs — this is the only writer of a part's result.
 *
 * @returns {Promise<Object|null>} applyPartOutcome's result (+ conflicts), or null when ignored
 */
async function writePartOutcome({
  collection,
  jobId,
  key,
  outcome,
  now = new Date(),
  logger = console,
  maxWriteAttempts = MAX_WRITE_ATTEMPTS,
  runId = null,
  runStartedAt = null,
}) {
  for (let attempt = 1; attempt <= maxWriteAttempts; attempt++) {
    const job = await collection.findOne({ _id: jobId });
    if (!job) {
      logger.warn(`[partRunner] job ${jobId} no longer exists — outcome for "${key}" dropped`);
      return null;
    }
    const current = (job.parts || []).find((p) => p.key === key);
    if (!current) {
      logger.warn(`[partRunner] job ${jobId} has no "${key}" part any more — outcome dropped`);
      return null;
    }
    // A part that is already bought is never demoted by a late failure (e.g. a
    // run that was reclaimed as a zombie and finished afterwards).
    if (core.isDone(current.status) && outcome.type !== "success") {
      logger.warn(`[partRunner] "${key}" of job ${jobId} is already ${current.status} — late ${outcome.type} outcome ignored`);
      return null;
    }

    const r = core.applyPartOutcome(job, key, outcome, now, { held: job.status === "hold" });

    const errorLogs = [];
    if (r.errorLog) errorLogs.push(r.errorLog);
    for (const w of outcome.completionWarnings || []) {
      errorLogs.push({
        errorMessage: w.message,
        errorCode: "E_POST_COMPLETION_WARNING",
        failureType: "PostCompletionWarning",
        part: w.part || key,
        timestamp: now,
      });
    }

    // this run's end, in the same write as its outcome (lib/runHistory.js)
    const partAfter = (r.parts || []).find((p) => p.key === key);
    const runEnd = runHistory.runEndUpdate(runId, {
      outcome: partAfter ? partAfter.status : outcome.type,
      error: outcome.type === "success" ? null : outcome.error,
      now,
      startedAt: runStartedAt,
    });

    const update = {
      $set: { ...r.jobSet, ...legacyJobFields(outcome, r, key), ...(runEnd ? runEnd.$set : {}) },
      $unset: { currentPart: "" },
      $push: {
        statusHistory: r.historyEntry,
        ...(errorLogs.length ? { errorLogs: { $each: errorLogs } } : {}),
      },
      $inc: { rev: 1 },
    };

    const res = runEnd
      ? await collection.updateOne({ _id: jobId, rev: revOf(job) }, update, { arrayFilters: runEnd.arrayFilters })
      : await collection.updateOne({ _id: jobId, rev: revOf(job) }, update);
    if (res.matchedCount === 1) return { ...r, conflicts: attempt - 1 };
    logger.log(`[partRunner] job ${jobId} changed while "${key}" was being recorded — re-applying (${attempt}/${maxWriteAttempts})`);
  }
  throw new Error(`Could not record the outcome of "${key}" on job ${jobId}: the job kept changing`);
}

/* -------------------------------------------------------------------------- */
/* Running a claimed part                                                      */
/* -------------------------------------------------------------------------- */

const AUDIT_ACTION = {
  success: "JOB_COMPLETED",
  postSubmission: "JOB_FAILED_CRITICAL",
  stopped: "JOB_STOPPED_INCOMPLETE",
  nonRetryable: "JOB_FAILED_TERMINAL",
  briskFailed: "JOB_FAILED_TERMINAL",
  invalid: "VALIDATION_FAILED",
  hydrationRetry: "JOB_RETRY_SCHEDULED",
  held: "JOB_HELD",
};
const auditActionFor = (outcome, afterStatus) => {
  if (outcome.type === "success") return afterStatus === "completed_with_errors" ? "JOB_COMPLETED_WITH_ERRORS" : "JOB_COMPLETED";
  if (outcome.type === "retryable") return afterStatus === "pending" ? "JOB_RETRY_SCHEDULED" : "JOB_FAILED_MAX_RETRIES";
  return AUDIT_ACTION[outcome.type] || "JOB_FAILED_TERMINAL";
};

/**
 * Run the part this job was just claimed for, then record the outcome.
 * Never lets an error escape from a business failure; only a failure to WRITE
 * the outcome throws (the caller's catch retries the write, and the zombie
 * reclaim is the last resort).
 *
 * @param {Object} deps see the destructuring below; server.js builds it once
 * @param {Object} claimed the job document returned by claimPart
 */
async function runPartJob(deps, claimed) {
  const {
    collection,
    policies,
    certificates,
    hydrateJobFormData,
    resolveCredentials,
    dispatchBundled,
    resolveMultiCompanyHandler,
    assertMultiCompanyEnabled,
    runBriskPart,
    finalizeRecording = () => {},
    scheduleWakeup = () => {},
    logAudit = async () => {},
    now = () => new Date(),
    logger = console,
    jobTimeoutMs = 300000,
    companyLabel = defaultCompanyLabel,
  } = deps;

  const key = claimed.currentPart && claimed.currentPart.key;
  const part = key && (claimed.parts || []).find((p) => p.key === key);
  if (!part) {
    // Cannot happen through claimPart; leave the job runnable rather than stuck.
    logger.error(`[partRunner] job ${claimed._id} is processing without a current part — releasing it`);
    await collection.updateOne(
      { _id: claimed._id, status: "processing" },
      {
        $set: { status: "pending", nextRetryAt: now(), lastError: "Job was claimed without a part — re-queued" },
        $unset: { currentPart: "" },
        $inc: { rev: 1 },
      }
    );
    return null;
  }

  const startedMs = Date.now();
  const state = {}; // a Brisk purchase made before a timeout / crash
  // The policy's proposal number when this attempt STARTED (a bundled run saves a new one the moment the portal says
  // "Proposal Saved Successfully"). Compared again if the run times out — see proposalSavedSince.
  let proposalBefore = null;
  let companyName = norm(part.company) || "reliance";
  let queueName = `${companyLabel(companyName)} Queue`;
  let customer = "";
  const attemptNumber = (part.attempts || 0) + 1;
  const tag = () => `[${queueName}][${key}]`;
  // this run's record on the job (who started it, when; the login and step times follow) - lib/runHistory.js
  const runStartedAt = now();
  const runId = await runHistory.startRun(collection, claimed, part, { attempt: attemptNumber, now: runStartedAt });

  const execute = async () => {
    // Hydrate as the legacy path does: the job may still be a thin one.
    let job;
    try {
      job = await hydrateJobFormData(claimed);
    } catch (hydrationError) {
      logger.error(`${tag()} hydration error (will retry): ${hydrationError.message}`);
      return {
        type: "hydrationRetry",
        error: `Could not prepare job data: ${hydrationError.message}`,
        errorCode: "E501",
        errorType: "HydrationError",
        stage: "hydration",
      };
    }
    if (job.missingPolicy || job.invalid) {
      const reason = job.missingPolicy
        ? "Source online policy not found — cannot build job data"
        : `Invalid policy data: ${(job.errors || []).join(", ")}`;
      logger.error(`${tag()} terminal: ${reason}`);
      return { type: "invalid", error: reason, errorCode: "E100", errorType: "ValidationError", stage: "validation" };
    }

    // The policy may have been deleted while an earlier part was running. A job
    // that already carries its data is not re-hydrated, so nothing else would
    // notice, and the next part (and the Brisk certificate, paid from the master
    // wallet) would be bought for a policy nobody has any more. Check it here,
    // before anything is bought or any portal is opened. A database error is not
    // "deleted": retry shortly rather than run on a policy that cannot be confirmed.
    let policyDoc = null;
    if (job.captchaId) {
      try {
        policyDoc = await policies.findOne(
          { _id: job.captchaId },
          // paCover + settings: the PA routing guard below compares the part with what the policy says NOW (lib/paRouting.js)
          { projection: { briskCertificate: 1, proposalNumber: 1, paCover: 1, settings: 1, ...TP_PROJECTION } }
        );
      } catch (lookupError) {
        logger.error(`${tag()} could not check that the policy still exists (will retry): ${lookupError.message}`);
        return {
          type: "hydrationRetry",
          error: `Could not check the policy: ${lookupError.message}`,
          errorCode: "E501",
          errorType: "HydrationError",
          stage: "hydration",
        };
      }
      if (!policyDoc) {
        const reason = "Source online policy not found — it was deleted, so no further part of it will run";
        logger.error(`${tag()} terminal: ${reason}`);
        return { type: "invalid", error: reason, errorCode: "E100", errorType: "ValidationError", stage: "validation" };
      }
      proposalBefore = policyDoc.proposalNumber ? String(policyDoc.proposalNumber) : null;
    }

    const formData = buildPartFormData(job, part);
    formData._runId = runId; // the step times of this run are written against it (runHistory.markRunStep)
    formData._runStartedAt = runStartedAt;

    const conflict = routingConflict(part, formData, job.parts);
    if (conflict) {
      logger.error(`${tag()} terminal: ${conflict}`);
      return { type: "invalid", error: conflict, errorCode: "E100", errorType: "ValidationError", stage: "validation" };
    }

    // The PA is bought ONLY where the policy says (Brisk, or the TP company that was selected): a part that would buy it elsewhere
    // — a stale or mis-built job, an edit that landed in between — stops here with one sentence, nothing bought (lib/paRouting.js).
    const paProblem = paRoutingProblem(part, policyDoc);
    if (paProblem) {
      logger.error(`${tag()} ${paProblem}`);
      return { type: "nonRetryable", error: paProblem, errorCode: "E100", errorType: "ValidationError", stage: "pa-routing" };
    }

    // Reliance OD never starts without the customer's TP policy details (lib/existingTpGate.js). They are often saved
    // after the job was queued, so the policy's own values win over the job's copy.
    Object.assign(formData, freshTpDetails(policyDoc));
    // Two insurers: a TP date that is not entered is worked out (start = today, end = the year selection after it) — the
    // owner, 2026-10-23. Only the number and the insurer can still be missing then. lib/existingTpGate.js defaultTpDates
    const workedOutTp = defaultTpDates(part, formData, { years: policyDoc && policyDoc.paCoverYears != null ? policyDoc.paCoverYears : formData.paCoverYears, now: now() });
    if (workedOutTp) Object.assign(formData, workedOutTp.fields);
    const waitingForTp = missingTpDetails(part, formData);
    if (waitingForTp) {
      logger.log(`${tag()} ${waitingForTp.error}`);
      return waitingForTp;
    }
    if (workedOutTp) logger.log(`${tag()} ${workedOutTp.note}`);

    companyName = formData.Companyname;
    queueName = `${companyLabel(companyName)} Queue`;
    customer = `${formData.firstName || ""} ${formData.lastName || ""}`.trim();
    const jobIdentifier = `${formData.firstName}_${job._id}_${key}`;

    logger.log(`${tag()} processing ${part.kind} part for ${customer} (job ${job._id}, attempt ${attemptNumber}/${part.maxAttempts})`);
    await logAudit("JOB_PROCESSING_STARTED", {
      jobId: job._id,
      part: key,
      customerName: customer,
      attemptNumber,
      maxAttempts: part.maxAttempts,
    });

    // Portal parts log in; the Brisk part talks to an API and needs no login.
    let creds = null;
    if (part.kind !== "brisk") {
      const resolved = await resolveCredentials(companyName, formData, (line) => logger.log(`→ ${tag()} ${line}`));
      if (!resolved) {
        const label = companyLabel(companyName);
        // [E205] is not retryable, so the part stops here instead of burning attempts.
        throw new Error(
          `[E205] No active ${label} portal credentials found for this policy's ` +
          `user or client. Add the ${label} login on the User page (edit the ` +
          `user → Credentials) or in Profile → Account & Policy Settings, then ` +
          `re-run this policy.`
        );
      }
      creds = resolved.creds;
      await runHistory.setRunLogin(collection, job._id, runId, resolved);
      await collection.updateOne(
        { _id: job._id },
        {
          $set: {
            credentialSource: resolved.source,
            credentialUsername: creds.username,
            credentialMatchedBy: resolved.matchedBy,
          },
        }
      );
    }

    // A Brisk certificate is paid for from the master wallet; if the policy
    // already has one, never buy a second (read above, with the policy check).
    if (hasCertificate(policyDoc)) formData.briskCertificateExists = true;

    let run;
    if (part.kind === "bundled") {
      ({ run } = await dispatchBundled(formData, {
        companyName,
        creds,
        jobId: job._id,
        jobIdentifier,
        attemptNumber,
        queueName,
      }));
    } else if (part.kind === "portal") {
      assertMultiCompanyEnabled();
      const handler = resolveMultiCompanyHandler(companyName, key);
      if (!handler) {
        throw new Error(`[E110] No ${key.toUpperCase()} automation exists yet for ${companyLabel(companyName)}.`);
      }
      run = handler({
        ...formData,
        username: creds.username,
        password: creds.password,
        loginUrl: creds.loginUrl,
        _jobId: job._id,
        _jobIdentifier: jobIdentifier,
        _attemptNumber: attemptNumber,
        _partKey: key,
        _jobQueueCollection: collection,
      });
    } else if (part.kind === "brisk") {
      // `_id` links the stored certificate to the policy (uploadBriskCertificate).
      run = runBriskPart(
        { ...formData, _id: formData._id || job.captchaId, _jobId: job._id, _jobIdentifier: jobIdentifier },
        { policies, policyId: job.captchaId, state, now, certificates }
      );
    } else {
      throw new Error(`[E110] Part "${key}" has kind "${part.kind}", which the automation cannot run.`);
    }

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`[E302] Job timeout after ${jobTimeoutMs / 1000} seconds`)),
        jobTimeoutMs
      );
    });
    let result;
    try {
      // stallWatch.guard: a run stuck for 1.5 minutes that does not even unwind is ended here (lib/stallWatch.js)
      result = await Promise.race([stallWatch.guard(claimed._id, run), timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
    // a run stopped as stuck says so (not "invalid session id" from the window closed under it), with its picture
    result = stallWatch.applyToResult(claimed._id, result);

    const processingTimeMs = Date.now() - startedMs;
    const outcome = mapRunResult(result, { part, companyName, processingTimeMs, companyLabel });

    if (outcome.type === "success" && part.kind === "bundled") {
      const extra = await paUpdateAfterBundled({
        result,
        job,
        policies,
        policyId: job.captchaId,
        now: now(),
        logger,
      });
      outcome.result = { ...outcome.result, ...extra.result };
      if (extra.alsoUpdate) outcome.alsoUpdate = extra.alsoUpdate;
      if (extra.warning) outcome.warning = extra.warning;
    }
    return outcome;
  };

  let outcome;
  try {
    outcome = await execute();
  } catch (e) {
    logger.error(`${tag()} EXCEPTION: ${e && e.message}`);
    // A run stopped as stuck reports the stall (and its picture), whatever the error that ended it was.
    const stall = stallWatch.stalledOf(claimed._id);
    if (stall && !isAutomationStop(e)) e = stall;
    outcome = mapThrownError(e, {
      part,
      companyName,
      processingTimeMs: Date.now() - startedMs,
      state,
      companyLabel,
    });

    // A timeout is normally retried — from scratch. Not once the portal has SAVED the proposal: the timed-out run is
    // only abandoned, it may still be working in its open browser, and a second full run would create a second
    // proposal (and could take the first one's place at payment). That is for an operator to decide.
    // The bundled part, and the Reliance OD / TP parts — they run the same Reliance flow (see savesProposalPart).
    if (outcome.type === "retryable" && savesProposalPart(part, companyName) && (isJobTimeout(e) || stallWatch.isStallError(e))) {
      const saved = await proposalSavedSince(policies, claimed.captchaId, proposalBefore);
      if (saved) {
        outcome = timeoutAfterProposalOutcome({
          proposal: saved,
          jobTimeoutMs,
          processingTimeMs: Date.now() - startedMs,
          companyName,
          companyLabel: (c) => companyLabel(c),
          stalled: stallWatch.isStallError(e),
        });
        logger.warn(`${tag()} timed out after the proposal ${saved} was saved — not retried automatically`);
      }
    }
    // the stuck page's picture, when the run never got to take its own
    const photo = stallWatch.photoOf(claimed._id);
    if (photo && outcome.errorExtra && !outcome.errorExtra.screenshotUrl) Object.assign(outcome.errorExtra, photo);
  }

  // Stop this run's recording BEFORE the job goes back to the queue, so the
  // next part of the same policy cannot start while this one is still open.
  // Never throws, never awaited: stitching and upload happen off to the side.
  try {
    Promise.resolve(finalizeRecording(claimed, part, companyName)).catch(() => {});
  } catch (e) {
    /* recording is best-effort */
  }

  let written;
  try {
    written = await writePartOutcome({
      collection,
      jobId: claimed._id,
      key,
      outcome,
      now: now(),
      logger,
      runId,
      runStartedAt,
    });
  } catch (writeError) {
    // Keep the REAL outcome with the error: the caller's safety net writes it
    // again instead of downgrading a purchase that succeeded to "retry".
    writeError.partOutcome = outcome;
    throw writeError;
  }
  if (!written) return null;

  const after = written.parts.find((p) => p.key === key);
  // the statuses in colour (green completed, red failed, amber waiting) when the console is a terminal — lib/consoleColor.js
  const line = `${tag()} ${outcome.type} -> ${colorStatus(after.status)}${outcome.error ? `: ${outcome.error}` : ""}` +
    ` (job now ${colorStatus(written.jobSet.status)}${written.conflicts ? `, ${written.conflicts} write conflict(s) resolved` : ""})`;
  if (outcome.type === "success") logger.log(line);
  else logger.warn(line);

  await logAudit(auditActionFor(outcome, after.status), {
    jobId: claimed._id,
    part: key,
    customerName: customer,
    company: companyName,
    errorCode: outcome.errorCode || undefined,
    errorMessage: outcome.error || undefined,
    attemptNumber,
    processingTimeMs: outcome.processingTimeMs,
    severity: outcome.type === "postSubmission" ? "CRITICAL" : undefined,
  });

  // A backoff that ends while other jobs keep the queue busy still has to wake it.
  const next = written.jobSet.nextRetryAt;
  if (written.jobSet.status === "pending" && next instanceof Date && next.getTime() > now().getTime()) {
    scheduleWakeup(next.getTime());
  }
  return written;
}

/**
 * The unexpected-error safety net: whatever went wrong, record it against the
 * part so the job is not left in "processing" (retried with backoff).
 */
async function recordUnexpectedError({ collection, job, error, now = () => new Date(), logger = console, companyLabel = defaultCompanyLabel }) {
  const key = job.currentPart && job.currentPart.key;
  if (!key) return null;
  const company = (job.currentPart && job.currentPart.company) || "";
  return writePartOutcome({
    collection,
    jobId: job._id,
    key,
    // A run that FINISHED but could not be recorded (database hiccup) is
    // recorded as it finished — a bought part must not come back as a retry.
    outcome: (error && error.partOutcome) || {
      type: "retryable",
      error: `Unexpected error: ${beautifyError(error, companyLabel(company))}`,
      errorCode: "E505",
      errorType: "SystemError",
      stage: "unexpected",
      errorExtra: { severity: "critical", retryable: true, errorStack: (error && error.stack) || null },
    },
    now: now(),
    logger,
  });
}

/* -------------------------------------------------------------------------- */
/* Recovery                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Put every part that is `processing` back to `pending` on the parts jobs
 * matching `filter` (already restricted to status "processing"), and the job
 * itself to pending. Recomputes nothing else. Bumps `rev`, so a concurrent
 * backend edit that read the old parts conflicts instead of resurrecting them.
 */
async function recoverPartsJobs(
  collection,
  { filter = {}, now = new Date(), extraSet = {}, applyRequeues = true, logger = console } = {}
) {
  const res = await collection.updateMany(
    { status: "processing", ...PARTS_JOBS, ...filter },
    {
      $set: {
        status: "pending",
        recoveredAt: now,
        nextRetryAt: now,
        "parts.$[p].status": "pending",
        "parts.$[p].nextRetryAt": now,
        ...extraSet,
      },
      $unset: { currentPart: "", lastHeartbeatAt: "" },
      $inc: { rev: 1 },
    },
    { arrayFilters: [{ "p.status": "processing" }] }
  );
  if (applyRequeues && res.modifiedCount > 0) await applyPendingRequeues(collection, { now, logger });
  return res;
}

/**
 * Startup: pending parts that are still waiting out a retry backoff become due
 * now (mirrors "clear backoff on restart" for legacy jobs).
 */
async function clearPartsBackoff(collection, { now = new Date() } = {}) {
  return collection.updateMany(
    { status: "pending", parts: { $elemMatch: { status: "pending", nextRetryAt: { $gt: now } } } },
    {
      $set: { nextRetryAt: now, "parts.$[p].nextRetryAt": null },
      $inc: { rev: 1 },
    },
    { arrayFilters: [{ "p.status": "pending", "p.nextRetryAt": { $gt: now } }] }
  );
}

/**
 * An edit that arrived while a part ran leaves `requeue` on it, applied when
 * the run's outcome is written. A run that was recovered instead never writes
 * an outcome, so apply the flag here — otherwise the part would run again with
 * the OLD insurer.
 */
async function applyPendingRequeues(collection, { now = new Date(), logger = console } = {}) {
  const docs = await collection
    .find({ status: "pending", "parts.requeue": { $type: "object" } })
    .toArray();
  let applied = 0;
  for (const doc of docs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = attempt === 0 ? doc : await collection.findOne({ _id: doc._id });
      if (!job || job.status !== "pending") break;
      let touched = false;
      const parts = (job.parts || []).map((p) => {
        const rq = p.requeue;
        if (!rq || typeof rq !== "object" || p.status !== "pending") return p;
        touched = true;
        const next = { ...p, company: rq.company || p.company, attempts: 0, stopped: false, nextRetryAt: now };
        if (rq.carriesPa !== undefined) next.carriesPa = rq.carriesPa;
        if (rq.paCoverCompany !== undefined) next.paCoverCompany = rq.paCoverCompany;
        delete next.requeue;
        return next;
      });
      if (!touched) break;
      const summary = core.summarizeParts(parts, { now });
      const res = await collection.updateOne(
        { _id: job._id, rev: revOf(job) },
        { $set: { parts: summary.parts, status: summary.status, nextRetryAt: summary.nextRetryAt }, $inc: { rev: 1 } }
      );
      if (res.matchedCount === 1) {
        applied++;
        break;
      }
    }
  }
  if (applied) logger.log(`[partRunner] applied a pending edit to ${applied} recovered job(s)`);
  return applied;
}

module.exports = {
  hasParts,
  QUEUE_WAKE_PIPELINE,
  LEGACY_JOBS,
  PARTS_JOBS,
  planClaims,
  claimPart,
  buildPartFormData,
  routingConflict,
  mapRunResult,
  mapThrownError,
  isJobTimeout,
  savesProposalPart,
  proposalSavedSince,
  timeoutAfterProposalOutcome,
  paUpdateAfterBundled,
  writePartOutcome,
  runPartJob,
  recordUnexpectedError,
  recoverPartsJobs,
  clearPartsBackoff,
  applyPendingRequeues,
};
