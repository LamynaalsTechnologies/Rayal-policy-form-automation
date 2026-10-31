// Run with: node --test test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../lib/jobPartsCore");
const runner = require("../lib/partRunner");
const {
  NOW,
  later,
  part,
  formData,
  multiParts,
  singleParts,
  SINGLE_SETTINGS,
  jobDoc,
  withPart,
  partOf,
  silentLogger,
  fakeCollection,
} = require("./helpers");

const maxFor = (limits) => (bucket) => (bucket in limits ? limits[bucket] : 1);
const legacyCompany = (job) => String(job.formData?.Companyname || "reliance").toLowerCase();

/* ------------------------------ planClaims ------------------------------ */

test("planClaims: one part per job, od before tp, each insurer's own window", () => {
  const active = {};
  const { toStart } = runner.planClaims([jobDoc(multiParts())], {
    now: NOW,
    activeByCompany: active,
    maxParallelFor: maxFor({}),
    companyOfJob: legacyCompany,
  });
  assert.equal(toStart.length, 1);
  assert.equal(toStart[0].part.key, "od");
  assert.equal(active.reliance, 1);
  assert.equal(active.national, undefined);
});

test("planClaims: a full Reliance window moves the job on to its TP part; a full window everywhere queues it", () => {
  const job = jobDoc(multiParts());
  let r = runner.planClaims([job], {
    now: NOW,
    activeByCompany: { reliance: 1 },
    maxParallelFor: maxFor({ reliance: 1, national: 1 }),
    companyOfJob: legacyCompany,
  });
  assert.equal(r.toStart[0].part.key, "tp");
  assert.equal(r.toStart[0].bucket, "national");

  r = runner.planClaims([job], {
    now: NOW,
    activeByCompany: { reliance: 1, national: 1 },
    maxParallelFor: maxFor({ reliance: 1, national: 1 }),
    companyOfJob: legacyCompany,
  });
  assert.equal(r.toStart.length, 0);
  assert.deepEqual(r.skippedByCompany, { reliance: 1 });
});

test("planClaims: capacity is reserved across the candidates of one pass", () => {
  const a = jobDoc(multiParts(), { _id: "a" });
  const b = jobDoc([part("od", "portal", "Reliance")], { _id: "b" });
  const r = runner.planClaims([a, b], {
    now: NOW,
    activeByCompany: {},
    maxParallelFor: maxFor({ reliance: 1, national: 1 }),
    companyOfJob: legacyCompany,
  });
  // a takes Reliance (its OD); b's only part needs Reliance too and must wait.
  assert.deepEqual(r.toStart.map((x) => `${x.job._id}:${x.part.key}`), ["a:od"]);
  assert.deepEqual(r.skippedByCompany, { reliance: 1 });
});

test("planClaims: not-due and blocked parts are not offered; Brisk has its own bucket", () => {
  const notDue = jobDoc(withPart(multiParts(), "od", { nextRetryAt: later(60000) }));
  let r = runner.planClaims([notDue], { now: NOW, activeByCompany: {}, maxParallelFor: maxFor({}), companyOfJob: legacyCompany });
  assert.equal(r.toStart[0].part.key, "tp"); // od waits for its backoff, tp is free

  const odRunning = jobDoc(withPart(withPart(multiParts(), "od", { status: "processing" }), "tp", { status: "completed" }));
  r = runner.planClaims([odRunning], { now: NOW, activeByCompany: {}, maxParallelFor: maxFor({}), companyOfJob: legacyCompany });
  assert.equal(r.toStart.length, 0); // PA still waits for OD

  const odDone = jobDoc(withPart(withPart(multiParts(), "od", { status: "completed" }), "tp", { status: "completed" }));
  r = runner.planClaims([odDone], { now: NOW, activeByCompany: { reliance: 1, national: 1 }, maxParallelFor: maxFor({}), companyOfJob: legacyCompany });
  assert.equal(r.toStart[0].part.key, "pa");
  assert.equal(r.toStart[0].bucket, "brisk"); // not blocked by the busy insurers
  r = runner.planClaims([odDone], { now: NOW, activeByCompany: { brisk: 1 }, maxParallelFor: maxFor({}), companyOfJob: legacyCompany });
  assert.equal(r.toStart.length, 0);
});

test("planClaims: a legacy job (no parts) is counted per company exactly as before", () => {
  const legacy = { _id: "L", status: "pending", formData: { Companyname: "National" } };
  const emptyParts = { _id: "E", status: "pending", parts: [], formData: { Companyname: "national" } };
  const r = runner.planClaims([legacy, emptyParts], {
    now: NOW,
    activeByCompany: {},
    maxParallelFor: maxFor({ national: 1 }),
    companyOfJob: legacyCompany,
  });
  assert.deepEqual(r.toStart.map((x) => [x.job._id, x.part]), [["L", null]]);
  assert.deepEqual(r.skippedByCompany, { national: 1 });
});

/* --------------------------- buildPartFormData --------------------------- */

test("buildPartFormData: portal parts get policyType, their own insurer and only carry PA when told to", () => {
  const job = jobDoc(multiParts());
  const tp = runner.buildPartFormData(job, partOf(job, "tp"));
  assert.equal(tp.policyType, "tp");
  assert.equal(tp.Companyname, "national");
  assert.equal(tp.paCover, false);
  assert.equal(tp._partKey, "tp");
  assert.equal(tp._attemptNumber, 1);
  assert.equal(job.formData.policyType, undefined, "the job's formData is not mutated");
  assert.equal(job.formData.paCover, true);

  const carrier = withPart(multiParts(), "tp", { carriesPa: true, paCoverCompany: "Company", attempts: 2 });
  const withPa = runner.buildPartFormData(jobDoc(carrier), carrier[1]);
  assert.equal(withPa.paCover, true);
  assert.equal(withPa.paCoverCompany, "Company");
  assert.equal(withPa._attemptNumber, 3);
});

test("buildPartFormData: a bundled part keeps the policy's PA (inline Brisk) and never has a policyType; Brisk part is paCover + Brisk", () => {
  const job = jobDoc(singleParts(), { formData: formData({ policyType: "od" }) });
  const motor = runner.buildPartFormData(job, partOf(job, "motor"));
  assert.equal(motor.policyType, undefined);
  assert.equal(motor.paCover, true);
  assert.equal(motor.paCoverCompany, "Brisk");
  assert.equal(motor.Companyname, "reliance");

  const pa = runner.buildPartFormData(job, partOf(job, "pa"));
  assert.equal(pa.paCover, true);
  assert.equal(pa.paCoverCompany, "Brisk");
  assert.equal(pa.policyType, undefined);

  // once the Brisk PA is bought, a re-run of the motor part must not buy it inline again
  const done = jobDoc(withPart(singleParts(), "pa", { status: "completed" }));
  assert.equal(runner.buildPartFormData(done, partOf(done, "motor")).briskCertificateExists, true);
});

test("buildPartFormData: company is lower-cased the way the rest of the automation does it", () => {
  const job = jobDoc([part("od", "portal", "KSHEMA")]);
  assert.equal(runner.buildPartFormData(job, job.parts[0]).Companyname, "kshema");
});

/* ------------------------- TP vehicle (Combined Make & Model) ------------------------- */

const TP_VEHICLE = {
  vehicleMake: "Honda",
  vehicleModel: "Activa 6G",
  vehicleCC: 110,
  vehicleVariant: "STD",
  modelNotFound: false,
  manufacturerSellingPrice: 0,
};
const comboForm = (extra = {}) =>
  formData({
    vehicleMake: "TVS",
    vehicleModel: "Jupiter",
    vehicleCC: 109,
    vehicleVariant: "ZX",
    modelNotFound: true,
    manufacturerSellingPrice: 80000,
    idv: 70000,
    tpVehicle: TP_VEHICLE,
    ...extra,
  });

test("buildPartFormData: the TP part fills the TP insurer's vehicle; the OD part keeps the OD vehicle; the IDV stays the OD side's", () => {
  const job = jobDoc(multiParts(), { formData: comboForm() });
  const tp = runner.buildPartFormData(job, partOf(job, "tp"));
  assert.equal(tp.vehicleMake, "Honda");
  assert.equal(tp.vehicleModel, "Activa 6G");
  assert.equal(tp.vehicleCC, 110);
  assert.equal(tp.vehicleVariant, "STD");
  assert.equal(tp.modelNotFound, false);
  assert.equal(tp.manufacturerSellingPrice, undefined, "the OD selling price must not leak into the TP vehicle");
  assert.equal(tp.idv, 70000);

  const od = runner.buildPartFormData(job, partOf(job, "od"));
  assert.equal(od.vehicleMake, "TVS");
  assert.equal(od.vehicleModel, "Jupiter");
  assert.equal(od.vehicleVariant, "ZX");
  assert.equal(od.modelNotFound, true);
  assert.equal(od.manufacturerSellingPrice, 80000);

  assert.equal(job.formData.vehicleMake, "TVS", "the job's formData is not mutated");
});

test("buildPartFormData: a bundled single-company part never takes the TP vehicle; a policy without one keeps its vehicle", () => {
  const single = jobDoc(singleParts(), { formData: comboForm({ settings: SINGLE_SETTINGS }) });
  assert.equal(runner.buildPartFormData(single, partOf(single, "motor")).vehicleMake, "TVS");

  const none = jobDoc(multiParts(), { formData: comboForm({ tpVehicle: null }) });
  const tp = runner.buildPartFormData(none, partOf(none, "tp"));
  assert.equal(tp.vehicleMake, "TVS");
  assert.equal(tp.manufacturerSellingPrice, 80000);
});

/* ------------------------------ routingConflict ------------------------------ */

test("routingConflict: a bundled part on a two-insurer policy is refused (it would buy everything at one insurer)", () => {
  const job = jobDoc(singleParts(), { formData: formData() }); // two-company settings
  const msg = runner.routingConflict(partOf(job, "motor"), job.formData, job.parts);
  assert.match(msg, /two insurers \(OD Reliance, TP National\)/);
  assert.match(msg, /one insurer/);
});

test("routingConflict: a single-company policy split into od + tp portal parts is refused", () => {
  const job = jobDoc(multiParts(), { formData: formData({ settings: SINGLE_SETTINGS }) });
  const msg = runner.routingConflict(partOf(job, "od"), job.formData, job.parts);
  assert.match(msg, /one insurer \(Reliance\)/);
  assert.match(msg, /separate OD and TP parts/);
});

test("routingConflict: the right shape for the policy is never refused", () => {
  const multi = jobDoc(multiParts());
  for (const key of ["od", "tp", "pa"]) assert.equal(runner.routingConflict(partOf(multi, key), multi.formData, multi.parts), null);

  const single = jobDoc(singleParts());
  for (const key of ["motor", "pa"]) assert.equal(runner.routingConflict(partOf(single, key), single.formData, single.parts), null);

  // A standalone cover of a single-company policy: only an od part exists.
  const standalone = [part("od", "portal", "Reliance")];
  assert.equal(runner.routingConflict(standalone[0], formData({ settings: SINGLE_SETTINGS }), standalone), null);
});

test("routingConflict: a job without routing settings (queued before they existed) is not second-guessed", () => {
  const parts = singleParts();
  assert.equal(runner.routingConflict(parts[0], formData({ settings: null }), parts), null);
  assert.equal(runner.routingConflict(parts[0], formData({ settings: {} }), parts), null);
  assert.equal(runner.routingConflict(parts[0], null, parts), null);
});

/* ------------------------- outcome mapping table ------------------------- */

const label = (c) => c;
const map = (result, p = part("od", "portal", "Reliance")) =>
  runner.mapRunResult(result, { part: p, companyName: "reliance", processingTimeMs: 7, companyLabel: label });

test("mapRunResult: success, with warnings", () => {
  assert.equal(map({ success: true }).type, "success");
  const w = map({ success: true, documentUploadError: "S3 down", briskCertificateError: "wallet" });
  assert.equal(w.type, "success");
  assert.equal(w.documentUploadError, "S3 down");
  assert.deepEqual(w.completionWarnings.map((x) => x.part), ["pa", "od"]);
  assert.equal(map({ success: true, proposalNumber: "P1", policyNumber: "N1" }).result.proposalNumber, "P1");
});

test("mapRunResult: every failure class", () => {
  const cases = [
    ["post-submission flag", { success: false, postSubmissionFailed: true, error: "pdf" }, "postSubmission", "E401", "PostSubmissionError"],
    ["post-submission stage", { success: false, stage: "post-calculation", error: "x" }, "postSubmission", "E401", "PostSubmissionError"],
    ["deliberate stop", { success: false, inProgress: true, retryable: false, stage: "logged-in", error: "form is not built yet" }, "stopped", "E100", "AutomationIncomplete"],
    ["non-retryable handler code", { success: false, errorCode: "E203", retryable: false, error: "bad password" }, "nonRetryable", "E203", "LoginFormError"],
    ["E110", { success: false, errorCode: "E110", retryable: false, error: "off" }, "nonRetryable", "E110", "LoginFormError"],
    ["retryable handler code", { success: false, errorCode: "E302", retryable: true, error: "slow" }, "retryable", "E302", "LoginFormError"],
    ["bundled failure, no code", { success: false, error: "element not found" }, "retryable", "E300", "LoginFormError"],
    ["nothing useful returned", undefined, "retryable", "E300", "LoginFormError"],
  ];
  for (const [name, result, type, code, errorType] of cases) {
    const o = map(result);
    assert.equal(o.type, type, name);
    assert.equal(o.errorCode, code, name);
    assert.equal(o.errorType, errorType, name);
    assert.ok(o.error, name);
  }
});

test("mapRunResult: screenshots, severity and timing ride along for the error log", () => {
  const o = map({ success: false, error: "boom", screenshotUrl: "https://s3/x.png", screenshotKey: "k/x.png", stage: "vehicle" });
  assert.equal(o.errorExtra.screenshotUrl, "https://s3/x.png");
  assert.equal(o.errorExtra.screenshotKey, "k/x.png");
  assert.equal(o.errorExtra.processingTimeMs, 7);
  assert.equal(o.errorExtra.severity, "warning");
  assert.equal(o.errorExtra.retryable, true);
  assert.equal(o.stage, "vehicle");
});

test("mapRunResult: Brisk part results", () => {
  const brisk = part("pa", "brisk", "Brisk");
  assert.deepEqual(map({ success: true, certificateNo: "C1" }, brisk).result, { certificateNo: "C1" });
  assert.match(map({ success: true, skipped: true, reason: "PA not selected", certificateNo: null }, brisk).warning, /PA not selected/);
  const failed = map({ success: false, briskFailed: true, error: "wallet", certificateNo: "C2" }, brisk);
  assert.equal(failed.type, "briskFailed");
  assert.equal(failed.certificateNo, "C2");
});

test("mapThrownError: stop, non-retryable, timeout, Brisk", () => {
  const { stopper, isAutomationStop } = require("../automationStopper");
  let stop;
  try {
    stopper("Stopped here", { stage: "vehicle" });
  } catch (e) {
    stop = e;
  }
  assert.ok(isAutomationStop(stop));
  const od = part("od", "portal", "Reliance");
  const opts = { part: od, companyName: "reliance", companyLabel: label };
  assert.equal(runner.mapThrownError(stop, opts).type, "stopped");
  assert.equal(runner.mapThrownError(stop, opts).errorCode, "E100");
  assert.equal(runner.mapThrownError(new Error("[E110] off"), opts).type, "nonRetryable");
  assert.equal(runner.mapThrownError(new Error("[E205] no creds"), opts).type, "nonRetryable");
  const timeout = runner.mapThrownError(new Error("[E302] Job timeout after 300 seconds"), opts);
  assert.equal(timeout.type, "retryable");
  assert.equal(timeout.errorCode, "E302");
  assert.equal(runner.mapThrownError("plain string", opts).type, "retryable");

  const brisk = part("pa", "brisk", "Brisk");
  const b = runner.mapThrownError(new Error("[E302] Job timeout"), { part: brisk, state: { certificateNo: "C7" } });
  assert.equal(b.type, "briskFailed");
  assert.equal(b.certificateNo, "C7");
});

/* --------------------------- writePartOutcome ---------------------------- */

const processing = (parts, key) => withPart(parts, key, { status: "processing", startedAt: NOW });
const claimedFrom = (job, key) => ({
  ...job,
  status: "processing",
  rev: (job.rev || 0) + 1,
  parts: processing(job.parts, key),
  currentPart: { key, company: partOf(job, key).company, kind: partOf(job, key).kind, bucket: core.capacityBucket(partOf(job, key)), attempt: 1, startedAt: NOW },
});

test("write-back: TP completes while OD is still to run -> job pending, PA waiting, currentPart gone", async () => {
  const col = fakeCollection(claimedFrom(jobDoc(multiParts()), "tp"));
  const r = await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "tp", now: NOW, logger: silentLogger,
    outcome: { type: "success", result: { proposalNumber: "T1" } },
  });
  const doc = col.state.doc;
  assert.equal(r.conflicts, 0);
  assert.equal(doc.status, "pending");
  assert.ok(doc.nextRetryAt instanceof Date);
  assert.equal(doc.currentPart, undefined);
  assert.equal(doc.rev, 2);
  assert.equal(partOf(doc, "tp").status, "completed");
  assert.equal(partOf(doc, "tp").result.proposalNumber, "T1");
  assert.equal(partOf(doc, "od").status, "pending");
  assert.equal(partOf(doc, "pa").waitingFor, "od");
  assert.equal(doc.statusHistory.at(-1).part, "tp");
});

test("write-back: TP completed, then OD fails for good -> job failed, TP kept, PA blocked, error log tagged with the part", async () => {
  const claimed = claimedFrom(jobDoc(withPart(multiParts(), "tp", { status: "completed", completedAt: NOW })), "od");
  const col = fakeCollection(claimed);
  await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "od", now: NOW, logger: silentLogger,
    outcome: {
      type: "nonRetryable", error: "Wrong password", errorCode: "E203", errorType: "LoginFormError", stage: "login",
      processingTimeMs: 1200, errorExtra: { severity: "error", screenshotUrl: "https://s3/s.png", screenshotKey: "s.png", retryable: false },
    },
  });
  const doc = col.state.doc;
  assert.equal(doc.status, "failed_login_form");
  assert.equal(doc.nextRetryAt, null);
  assert.equal(partOf(doc, "tp").status, "completed");
  assert.equal(partOf(doc, "od").status, "failed_login_form");
  assert.equal(partOf(doc, "pa").blockedBy, "od");
  assert.equal(doc.errorLogs.length, 1);
  assert.equal(doc.errorLogs[0].part, "od");
  assert.equal(doc.errorLogs[0].errorCode, "E203");
  assert.equal(doc.errorLogs[0].screenshotKey, "s.png");
  assert.equal(doc.lastError, "Wrong password");
  assert.equal(doc.lastErrorCode, "E203");
  assert.equal(doc.failureType, "LoginFormError");
  assert.equal(doc.lastScreenshotUrl, "https://s3/s.png");
  assert.equal(doc.finalError.errorCode, "E203");
  assert.equal(doc.processingTimeMs, 1200);
});

test("write-back: a stop is shown per part as 'not automated yet' and never retried", async () => {
  const col = fakeCollection(claimedFrom(jobDoc(multiParts()), "od"));
  await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "od", now: NOW, logger: silentLogger,
    outcome: { type: "stopped", error: "form is not built yet", errorCode: "E100", stage: "logged-in" },
  });
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "failed_login_form");
  assert.equal(od.stopped, true);
  assert.equal(od.nextRetryAt, null);
  // TP is still runnable, so the job stays pending
  assert.equal(col.state.doc.status, "pending");
});

test("write-back: warnings become error-log entries and job fields for older readers", async () => {
  const col = fakeCollection(claimedFrom(jobDoc(singleParts()), "motor"));
  await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "motor", now: NOW, logger: silentLogger,
    outcome: {
      type: "success",
      completionWarnings: [{ message: "Brisk certificate creation failed: wallet", part: "pa" }],
      briskCertificateError: "wallet",
      alsoUpdate: { pa: { status: "failed", lastError: "Brisk certificate creation failed: wallet" } },
    },
  });
  const doc = col.state.doc;
  assert.equal(doc.status, "completed_with_errors");
  assert.equal(doc.briskCertificateError, "wallet");
  assert.deepEqual(doc.completionWarnings, ["Brisk certificate creation failed: wallet"]);
  assert.equal(doc.errorLogs[0].errorCode, "E_POST_COMPLETION_WARNING");
  assert.equal(doc.errorLogs[0].part, "pa");
});

test("write-back: an edit that lands mid-run conflicts on rev; the outcome is re-applied to the fresh document", async () => {
  const col = fakeCollection(claimedFrom(jobDoc(multiParts()), "od"));
  // the backend edits the job while OD runs: new insurer for OD, flagged requeue
  col.state.beforeUpdate = (doc) => {
    doc.rev += 1;
    partOf(doc, "od").requeue = { company: "National", carriesPa: false, paCoverCompany: null, at: NOW };
  };
  const r = await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "od", now: NOW, logger: silentLogger,
    outcome: { type: "retryable", error: "portal slow", errorCode: "E302", stage: "login" },
  });
  assert.equal(r.conflicts, 1);
  const od = partOf(col.state.doc, "od");
  assert.equal(od.company, "National", "the edit's insurer wins");
  assert.equal(od.status, "pending");
  assert.equal(od.attempts, 0, "the edit gives it a fresh start");
  assert.equal(od.requeue, undefined);
  assert.equal(col.state.doc.rev, 3);
});

test("write-back: a requeue on a part that then SUCCEEDS is recorded, not applied (it was bought)", async () => {
  const col = fakeCollection(claimedFrom(jobDoc(multiParts()), "od"));
  col.state.beforeUpdate = (doc) => {
    doc.rev += 1;
    partOf(doc, "od").requeue = { company: "National", at: NOW };
  };
  await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "od", now: NOW, logger: silentLogger,
    outcome: { type: "success" },
  });
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "completed");
  assert.equal(od.company, "Reliance");
  assert.equal(od.routingChanged.to, "National");
});

test("write-back: gives up (throws) after 5 conflicts instead of overwriting", async () => {
  const col = fakeCollection(claimedFrom(jobDoc(multiParts()), "od"));
  let n = 0;
  const realUpdate = col.updateOne;
  col.updateOne = async (f, u) => {
    n++;
    col.state.doc.rev += 1; // always changes underneath
    return realUpdate(f, u);
  };
  await assert.rejects(
    runner.writePartOutcome({
      collection: col, jobId: "job1", key: "od", now: NOW, logger: silentLogger,
      outcome: { type: "retryable", error: "x" },
    }),
    /kept changing/
  );
  assert.equal(n, 5);
  assert.equal(partOf(col.state.doc, "od").status, "processing", "nothing was written");
});

test("write-back: a late failure never demotes a part that is already bought; a vanished job is ignored", async () => {
  const bought = claimedFrom(jobDoc(withPart(multiParts(), "od", { status: "completed" })), "tp");
  const col = fakeCollection({ ...bought, parts: withPart(bought.parts, "tp", { status: "completed" }) });
  const r = await runner.writePartOutcome({
    collection: col, jobId: "job1", key: "tp", now: NOW, logger: silentLogger,
    outcome: { type: "retryable", error: "late" },
  });
  assert.equal(r, null);
  assert.equal(partOf(col.state.doc, "tp").status, "completed");

  const gone = fakeCollection(jobDoc(multiParts()));
  assert.equal(await runner.writePartOutcome({ collection: gone, jobId: "nope", key: "od", now: NOW, logger: silentLogger, outcome: { type: "success" } }), null);
});

test("write-back: a job that was put on hold stays on hold", async () => {
  const col = fakeCollection({ ...claimedFrom(jobDoc(multiParts()), "od"), status: "hold" });
  await runner.writePartOutcome({ collection: col, jobId: "job1", key: "od", now: NOW, logger: silentLogger, outcome: { type: "success" } });
  assert.equal(col.state.doc.status, "hold");
});

/* ------------------------------ runPartJob ------------------------------- */

function makeDeps(collection, over = {}) {
  const calls = { handler: [], bundled: [], brisk: [], creds: [], finalize: [], wake: [], audit: [] };
  const policies = {
    async findOne() {
      if (over.policyError) throw over.policyError;
      // The policy exists unless a test says it was deleted (`policyDoc: null`).
      return over.policyDoc === undefined ? { _id: "policy1" } : over.policyDoc;
    },
    async updateOne() {
      return { matchedCount: 1 };
    },
  };
  const deps = {
    collection,
    policies,
    hydrateJobFormData: over.hydrate || (async (job) => job),
    resolveCredentials: async (company) => {
      calls.creds.push(company);
      if (over.noCreds) return null;
      return { creds: { username: "portal-user", password: "pw", loginUrl: "https://portal", _id: "cred1" }, source: "user", matchedBy: "user-id" };
    },
    dispatchBundled: async (fd, ctx) => {
      calls.bundled.push({ fd, ctx });
      return { run: over.bundledRun ? over.bundledRun() : Promise.resolve(over.bundledResult || { success: true }) };
    },
    resolveMultiCompanyHandler: (company, key) => {
      if (over.noHandler) return null;
      return (data) => {
        calls.handler.push({ company, key, data });
        return over.handlerRun ? over.handlerRun(data) : Promise.resolve(over.handlerResult || { success: true });
      };
    },
    assertMultiCompanyEnabled: over.assertEnabled || (() => {}),
    runBriskPart: async (data, d) => {
      calls.brisk.push({ data, d });
      if (over.briskRun) return over.briskRun(data, d);
      return over.briskResult || { success: true, certificateNo: "C1" };
    },
    finalizeRecording: (job, p, company) => calls.finalize.push({ key: p.key, company }),
    scheduleWakeup: (t) => calls.wake.push(t),
    logAudit: async (action, details) => calls.audit.push([action, details]),
    now: () => NOW,
    logger: silentLogger,
    jobTimeoutMs: 1000,
    companyLabel: label,
  };
  return { deps, calls };
}

test("runPartJob (portal): TP gets its own formData + credentials, completes, credential source is recorded", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "tp");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { handlerResult: { success: true, proposalNumber: "TP-1" } });
  await runner.runPartJob(deps, claimed);

  assert.deepEqual(calls.creds, ["national"]);
  const h = calls.handler[0];
  assert.equal(h.company, "national");
  assert.equal(h.key, "tp");
  assert.equal(h.data.policyType, "tp");
  assert.equal(h.data.Companyname, "national");
  assert.equal(h.data.paCover, false);
  assert.equal(h.data._partKey, "tp");
  assert.equal(h.data._attemptNumber, 1);
  assert.equal(h.data.username, "portal-user");
  assert.equal(h.data.loginUrl, "https://portal");

  const doc = col.state.doc;
  assert.equal(partOf(doc, "tp").status, "completed");
  assert.equal(partOf(doc, "tp").result.proposalNumber, "TP-1");
  assert.equal(doc.status, "pending"); // OD still to run
  assert.equal(doc.credentialSource, "user");
  assert.equal(doc.credentialUsername, "portal-user");
  assert.deepEqual(calls.finalize, [{ key: "tp", company: "national" }]);
  assert.equal(calls.audit.at(-1)[0], "JOB_COMPLETED");
  assert.equal(calls.audit.at(-1)[1].part, "tp");
});

test("runPartJob: TP completes, then OD is a login-only stub (E100 stop) -> per-part status, job failed, PA waits", async () => {
  // TP first
  let claimed = claimedFrom(jobDoc(multiParts()), "tp");
  const col = fakeCollection(claimed);
  let { deps } = makeDeps(col);
  await runner.runPartJob(deps, claimed);

  // now OD, which stops ("form not built yet")
  claimed = { ...col.state.doc };
  const claim = claimedFrom(claimed, "od");
  col.state.doc = structuredClone(claim);
  ({ deps } = makeDeps(col, {
    handlerResult: { success: false, inProgress: true, retryable: false, stage: "logged-in", error: "Logged in to Reliance — the Reliance OD form is not built yet" },
  }));
  await runner.runPartJob(deps, claim);

  const doc = col.state.doc;
  assert.equal(partOf(doc, "tp").status, "completed");
  assert.equal(partOf(doc, "od").status, "failed_login_form");
  assert.equal(partOf(doc, "od").stopped, true);
  assert.equal(partOf(doc, "od").lastErrorCode, "E100");
  assert.equal(partOf(doc, "pa").status, "pending");
  assert.equal(partOf(doc, "pa").blockedBy, "od");
  assert.equal(doc.status, "failed_login_form");
  assert.equal(core.summarizeParts(doc.parts, { now: NOW }).label, "OD not automated yet, TP completed, PA waiting for OD");
});

test("runPartJob: a timeout is a retryable E302 with backoff, and wakes the queue for the retry", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { handlerRun: () => new Promise(() => {}) });
  deps.jobTimeoutMs = 25;
  await runner.runPartJob(deps, claimed);
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "pending");
  assert.equal(od.attempts, 1);
  assert.equal(od.lastErrorCode, "E302");
  assert.equal(od.nextRetryAt.getTime(), later(60000).getTime());
  // TP is still due right now, so the job stays pending/immediately eligible
  assert.equal(col.state.doc.status, "pending");
  assert.equal(col.state.doc.nextRetryAt.getTime(), NOW.getTime());
  assert.equal(calls.wake.length, 0, "an immediately-due job needs no timer");
});

test("runPartJob: when the only remaining part is backing off, a wake-up is scheduled for it", async () => {
  const parts = withPart(multiParts(), "tp", { status: "completed" });
  const claimed = claimedFrom(jobDoc(parts), "od");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { handlerResult: { success: false, error: "element not found" } });
  await runner.runPartJob(deps, claimed);
  assert.equal(col.state.doc.status, "pending");
  assert.equal(col.state.doc.nextRetryAt.getTime(), later(60000).getTime());
  assert.deepEqual(calls.wake, [later(60000).getTime()]);
  assert.equal(calls.audit.at(-1)[0], "JOB_RETRY_SCHEDULED");
});

test("runPartJob: no portal credentials -> [E205], not retried; no handler -> [E110]", async () => {
  let claimed = claimedFrom(jobDoc(multiParts()), "od");
  let col = fakeCollection(claimed);
  let { deps, calls } = makeDeps(col, { noCreds: true });
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "od").status, "failed_login_form");
  assert.match(partOf(col.state.doc, "od").lastError, /E205|credentials/);
  assert.equal(calls.handler.length, 0);

  claimed = claimedFrom(jobDoc(multiParts()), "od");
  col = fakeCollection(claimed);
  ({ deps, calls } = makeDeps(col, { noHandler: true }));
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "od").status, "failed_login_form");
  assert.match(partOf(col.state.doc, "od").lastError, /No OD automation exists yet/);
});

test("runPartJob: MULTI_COMPANY_AUTOMATION_ENABLED off -> [E110] before anything opens", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, {
    assertEnabled: () => {
      throw new Error("[E110] MULTI_COMPANY_AUTOMATION_ENABLED is off");
    },
  });
  await runner.runPartJob(deps, claimed);
  assert.equal(calls.handler.length, 0);
  assert.equal(partOf(col.state.doc, "od").status, "failed_login_form");
  assert.equal(partOf(col.state.doc, "od").lastErrorCode, "E110");
});

test("runPartJob: hydration hiccup retries soon without spending an attempt; a missing policy fails what is unfinished", async () => {
  let claimed = claimedFrom(jobDoc(withPart(multiParts(), "tp", { status: "completed" })), "od");
  let col = fakeCollection(claimed);
  let { deps } = makeDeps(col, { hydrate: async () => { throw new Error("mongo blip"); } });
  await runner.runPartJob(deps, claimed);
  let od = partOf(col.state.doc, "od");
  assert.equal(od.status, "pending");
  assert.equal(od.attempts, 0);
  assert.equal(od.nextRetryAt.getTime(), later(30000).getTime());

  claimed = claimedFrom(jobDoc(withPart(multiParts(), "tp", { status: "completed" })), "od");
  col = fakeCollection(claimed);
  ({ deps } = makeDeps(col, { hydrate: async () => ({ missingPolicy: true }) }));
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "tp").status, "completed");
  assert.equal(partOf(col.state.doc, "od").status, "failed_validation");
  assert.equal(partOf(col.state.doc, "pa").status, "failed_validation");
  assert.equal(col.state.doc.status, "failed_validation");
});

test("runPartJob: a policy deleted while an earlier part ran -> nothing is bought, no login, unfinished parts fail validation", async () => {
  const done = withPart(multiParts(), "tp", { status: "completed" });
  const claimed = claimedFrom(jobDoc(done), "od");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { policyDoc: null });
  await runner.runPartJob(deps, claimed);

  assert.equal(calls.creds.length, 0, "no credentials looked up");
  assert.equal(calls.handler.length, 0, "no portal opened");
  assert.equal(calls.brisk.length, 0, "no Brisk certificate bought");
  assert.equal(calls.bundled.length, 0);
  const doc = col.state.doc;
  assert.equal(partOf(doc, "tp").status, "completed", "what was already bought stays recorded");
  assert.equal(partOf(doc, "od").status, "failed_validation");
  assert.equal(partOf(doc, "pa").status, "failed_validation");
  assert.match(partOf(doc, "od").lastError, /deleted/);
  assert.equal(doc.status, "failed_validation");
});

test("runPartJob: the Brisk PA is NOT bought for a policy that no longer exists (paid from the master wallet)", async () => {
  const done = withPart(withPart(multiParts(), "od", { status: "completed" }), "tp", { status: "completed" });
  const claimed = claimedFrom(jobDoc(done), "pa");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { policyDoc: null });
  await runner.runPartJob(deps, claimed);

  assert.equal(calls.brisk.length, 0);
  assert.equal(partOf(col.state.doc, "pa").status, "failed_validation");
});

test("runPartJob: a database error while checking the policy retries soon and spends no attempt (it is not 'deleted')", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { policyError: new Error("mongo blip") });
  await runner.runPartJob(deps, claimed);

  assert.equal(calls.handler.length, 0);
  assert.equal(calls.creds.length, 0);
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "pending");
  assert.equal(od.attempts, 0);
  assert.equal(od.nextRetryAt.getTime(), later(30000).getTime());
});

test("runPartJob: a bundled part on a two-insurer policy is refused before any credentials or browser", async () => {
  const claimed = claimedFrom(jobDoc(singleParts(), { formData: formData() }), "motor"); // two-company settings
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col);
  await runner.runPartJob(deps, claimed);

  assert.equal(calls.bundled.length, 0, "the whole policy must not be bought at one insurer");
  assert.equal(calls.creds.length, 0);
  assert.equal(partOf(col.state.doc, "motor").status, "failed_validation");
  assert.match(partOf(col.state.doc, "motor").lastError, /two insurers/);
});

test("runPartJob: a single-company policy split into OD and TP portal parts is refused before any login", async () => {
  const claimed = claimedFrom(jobDoc(multiParts(), { formData: formData({ settings: SINGLE_SETTINGS }) }), "od");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col);
  await runner.runPartJob(deps, claimed);

  assert.equal(calls.handler.length, 0);
  assert.equal(calls.creds.length, 0);
  assert.equal(partOf(col.state.doc, "od").status, "failed_validation");
  assert.equal(partOf(col.state.doc, "tp").status, "failed_validation");
});

test("runPartJob: a Breaker checkpoint inside a handler stops the part calmly (no retry); switched off, the same handler completes", async () => {
  const { createBreaker } = require("../breaker");
  const env = { BREAKER_ENABLED: "true", BREAKER_STOP_AT: "OD vehicle" };
  const breaker = createBreaker({ env, log: () => {}, graceMs: 60000 });
  const handler = async () => {
    breaker.checkpoint("OD vehicle");
    return { success: true };
  };
  const runOd = async () => {
    const claimed = claimedFrom(jobDoc(multiParts()), "od");
    const col = fakeCollection(claimed);
    const { deps, calls } = makeDeps(col, { handlerRun: handler });
    await runner.runPartJob(deps, claimed);
    return { od: partOf(col.state.doc, "od"), doc: col.state.doc, calls };
  };

  const stopped = await runOd();
  assert.equal(stopped.calls.handler.length, 1, "the run got as far as the handler");
  assert.equal(stopped.od.status, "failed_login_form");
  assert.equal(stopped.od.stopped, true);
  assert.equal(stopped.od.lastErrorCode, "E100");
  assert.equal(stopped.od.nextRetryAt, null, "never retried on its own");
  assert.match(stopped.od.lastError, /checkpoint "OD vehicle"/);
  assert.equal(stopped.doc.status, "pending", "the TP part is still to run: a stop on OD does not stop the policy's other parts");

  env.BREAKER_ENABLED = "false"; // the operator switched it off and pressed Retry
  const ran = await runOd();
  assert.equal(ran.od.status, "completed");
});

test("runPartJob: the TP part reaches its portal handler with the TP vehicle", async () => {
  const claimed = claimedFrom(jobDoc(multiParts(), { formData: comboForm() }), "tp");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { handlerResult: { success: true } });
  await runner.runPartJob(deps, claimed);

  assert.equal(calls.handler.length, 1);
  assert.equal(calls.handler[0].data.vehicleMake, "Honda");
  assert.equal(calls.handler[0].data.vehicleModel, "Activa 6G");
});

test("runPartJob (bundled): success with the Brisk PA bought inline -> motor completed, PA completed with the certificate", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, {
    bundledResult: { success: true, briskCertificate: { policyId: "C-9", downloadUrl: "u" } },
    policyDoc: { briskCertificate: { key: "BriskCertificates/C-9.pdf", certificateNo: "C-9" }, proposalNumber: "PR-5" },
  });
  await runner.runPartJob(deps, claimed);

  const ctx = calls.bundled[0];
  assert.equal(ctx.ctx.attemptNumber, 1);
  assert.equal(ctx.ctx.companyName, "reliance");
  assert.equal(ctx.fd.paCover, true, "the bundled flow keeps the policy's own PA settings");
  assert.equal(ctx.fd.paCoverCompany, "Brisk");
  assert.equal(ctx.fd.policyType, undefined);

  const doc = col.state.doc;
  assert.equal(partOf(doc, "motor").status, "completed");
  assert.equal(partOf(doc, "motor").result.proposalNumber, "PR-5");
  assert.equal(partOf(doc, "pa").status, "completed");
  assert.equal(partOf(doc, "pa").result.certificateNo, "C-9");
  assert.equal(doc.status, "completed");
  assert.equal(calls.brisk.length, 0, "nothing left for the Brisk runner");
});

test("runPartJob (bundled): the inline Brisk step failed -> PA failed with the error, job completed_with_errors", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { bundledResult: { success: true, briskCertificateError: "Brisk wallet balance too low" } });
  await runner.runPartJob(deps, claimed);
  const doc = col.state.doc;
  assert.equal(partOf(doc, "motor").status, "completed");
  assert.equal(partOf(doc, "pa").status, "failed");
  assert.match(partOf(doc, "pa").lastError, /wallet balance too low/);
  assert.equal(doc.status, "completed_with_errors");
  assert.equal(doc.errorLogs.some((l) => l.part === "pa"), true);
});

test("runPartJob (bundled): an error after the purchase warns that the certificate may exist", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { bundledResult: { success: true, briskCertificateError: "Failed to download PDF. Status: 500" } });
  await runner.runPartJob(deps, claimed);
  assert.match(partOf(col.state.doc, "pa").lastError, /may already exist at Brisk/);
});

test("runPartJob (bundled): nothing about Brisk happened and no certificate exists -> PA left pending for the Brisk runner", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { bundledResult: { success: true, briskCertificateSkipped: true }, policyDoc: {} });
  await runner.runPartJob(deps, claimed);
  const doc = col.state.doc;
  assert.equal(partOf(doc, "motor").status, "completed");
  assert.equal(partOf(doc, "pa").status, "pending");
  assert.equal(doc.status, "pending");
  assert.ok(doc.nextRetryAt instanceof Date);
});

test("runPartJob (bundled): documents that could not be uploaded -> completed_with_errors, still bought", async () => {
  const claimed = claimedFrom(jobDoc([part("motor", "bundled", "Reliance")]), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { bundledResult: { success: true, documentUploadError: "S3 unreachable" } });
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "motor").status, "completed_with_errors");
  assert.equal(partOf(col.state.doc, "motor").result.warning, "S3 unreachable");
  assert.equal(col.state.doc.status, "completed_with_errors");
});

test("runPartJob (bundled): a Brisk PA that is already bought is not bought again by the inline step", async () => {
  const parts = withPart(singleParts(), "pa", { status: "completed" });
  const claimed = claimedFrom(jobDoc(parts), "motor");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { policyDoc: { briskCertificate: { certificateNo: "OLD" } } });
  await runner.runPartJob(deps, claimed);
  assert.equal(calls.bundled[0].fd.briskCertificateExists, true);
});

test("runPartJob (brisk): API only — no credentials, no browser; the job completes", async () => {
  const parts = withPart(multiParts(), "od", { status: "completed" }).map((p) => (p.key === "tp" ? { ...p, status: "completed" } : p));
  const claimed = claimedFrom(jobDoc(parts), "pa");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { briskResult: { success: true, certificateNo: "C-77" } });
  await runner.runPartJob(deps, claimed);
  assert.equal(calls.creds.length, 0);
  assert.equal(calls.handler.length, 0);
  assert.equal(calls.brisk.length, 1);
  assert.equal(calls.brisk[0].data.paCoverCompany, "Brisk");
  assert.equal(calls.brisk[0].d.policyId, "policy1");
  assert.equal(partOf(col.state.doc, "pa").status, "completed");
  assert.equal(partOf(col.state.doc, "pa").result.certificateNo, "C-77");
  assert.equal(col.state.doc.status, "completed");
});

test("runPartJob (brisk): failure before a certificate -> failed; after -> completed_with_errors with the number; never retried", async () => {
  const base = withPart(withPart(multiParts(), "od", { status: "completed" }), "tp", { status: "completed" });

  let claimed = claimedFrom(jobDoc(base), "pa");
  let col = fakeCollection(claimed);
  let { deps } = makeDeps(col, { briskResult: { success: false, briskFailed: true, error: "wallet too low" } });
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "pa").status, "failed");
  assert.equal(col.state.doc.status, "completed_with_errors");

  claimed = claimedFrom(jobDoc(base), "pa");
  col = fakeCollection(claimed);
  ({ deps } = makeDeps(col, { briskResult: { success: false, briskFailed: true, error: "pdf", certificateNo: "C-3" } }));
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "pa").status, "completed_with_errors");
  assert.equal(partOf(col.state.doc, "pa").result.certificateNo, "C-3");
});

test("runPartJob (brisk): a timeout after the certificate was created still reports its number", async () => {
  const base = withPart(withPart(multiParts(), "od", { status: "completed" }), "tp", { status: "completed" });
  const claimed = claimedFrom(jobDoc(base), "pa");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, {
    briskRun: (data, d) => {
      d.state.certificateNo = "C-55";
      return new Promise(() => {});
    },
  });
  deps.jobTimeoutMs = 25;
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "pa").status, "completed_with_errors");
  assert.equal(partOf(col.state.doc, "pa").result.certificateNo, "C-55");
});

test("runPartJob: an edit that arrived during the run (requeue) is honoured when the run fails", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, {
    handlerRun: async () => {
      // the edit lands while the handler is "running"
      col.state.doc.rev += 1;
      partOf(col.state.doc, "od").requeue = { company: "KSHEMA", carriesPa: false, paCoverCompany: null, at: NOW };
      return { success: false, error: "element not found" };
    },
  });
  await runner.runPartJob(deps, claimed);
  const od = partOf(col.state.doc, "od");
  assert.equal(od.company, "KSHEMA");
  assert.equal(od.status, "pending");
  assert.equal(od.attempts, 0);
});

test("recordUnexpectedError: the safety net puts the part back with a backoff instead of leaving it processing", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  await runner.recordUnexpectedError({ collection: col, job: claimed, error: new Error("kaboom"), now: () => NOW, logger: silentLogger, companyLabel: label });
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "pending");
  assert.equal(od.attempts, 1);
  assert.match(od.lastError, /Unexpected error/);
  assert.equal(col.state.doc.currentPart, undefined);
});

test("a run that finished but could not be recorded is recorded AS FINISHED by the safety net (a bought part is not turned into a retry)", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { handlerResult: { success: true } });
  // the database misbehaves once, then recovers
  const realFind = col.findOne;
  let failures = 0;
  col.findOne = async (f) => {
    if (failures < 1) {
      failures++;
      throw new Error("mongo down");
    }
    return realFind(f);
  };
  let thrown;
  try {
    await runner.runPartJob(deps, claimed);
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, "the failed write surfaces to the caller");
  assert.equal(thrown.partOutcome.type, "success");
  assert.equal(partOf(col.state.doc, "od").status, "processing", "nothing was written yet");

  await runner.recordUnexpectedError({ collection: col, job: claimed, error: thrown, now: () => NOW, logger: silentLogger, companyLabel: label });
  assert.equal(partOf(col.state.doc, "od").status, "completed");
});

test("runPartJob: a job that is processing without a current part is released, not left stuck", async () => {
  const claimed = { ...claimedFrom(jobDoc(multiParts()), "od"), currentPart: undefined };
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col);
  assert.equal(await runner.runPartJob(deps, claimed), null);
  assert.equal(col.state.doc.status, "pending");
});

/* ---------- one Brisk method for every company (the owner, 2026-10-31): the insurer's work finishes, then Brisk is called ---------- */

const { shouldCreateBriskCertificate } = require("../briskCertificate");
const BRISK_WANTED = { paCover: true, paCoverCompany: "Brisk" };

test("buildPartFormData: a bundled part leaves Brisk to the job's Brisk part; the Brisk part itself is not told to", () => {
  const job = jobDoc(singleParts(), { formData: formData(BRISK_WANTED) });
  const motor = runner.buildPartFormData(job, partOf(job, "motor"));
  assert.equal(motor.briskByPaPart, true);
  assert.equal(shouldCreateBriskCertificate(motor).create, false);
  assert.match(shouldCreateBriskCertificate(motor).reason, /the Brisk part makes it/);

  const pa = runner.buildPartFormData(job, partOf(job, "pa"));
  assert.equal(pa.briskByPaPart, undefined);
  assert.equal(shouldCreateBriskCertificate(pa).create, true, "the Brisk part does buy it");
});

test("buildPartFormData: a job with no Brisk part (the old shape, or the insurer's PA) is not told to leave it", () => {
  const noPa = jobDoc([part("motor", "bundled", "Reliance")], { formData: formData(BRISK_WANTED) });
  assert.equal(runner.buildPartFormData(noPa, partOf(noPa, "motor")).briskByPaPart, undefined);
  const insurerPa = jobDoc([part("motor", "bundled", "Reliance", { carriesPa: true, paCoverCompany: "Company" }), part("pa", "withPart", "Reliance", { mirrors: "motor" })], { formData: formData({ paCover: true, paCoverCompany: "Company" }) });
  assert.equal(runner.buildPartFormData(insurerPa, partOf(insurerPa, "motor")).briskByPaPart, undefined);
});

for (const company of ["Reliance", "National", "KSHEMA"]) {
  test(`${company}, OD + TP at one company: the insurer's part runs without buying, then the Brisk part buys, once`, async () => {
    const parts = [part("motor", "bundled", company), part("pa", "brisk", "Brisk", { dependsOn: "motor", paCoverCompany: "Brisk" })];
    const settings = { isMultipleCompany: false, ODCompany: company, TPCompany: company, PACompany: "Brisk" };
    const job = jobDoc(parts, { formData: formData({ ...BRISK_WANTED, Companyname: company.toLowerCase(), settings }) });
    assert.equal(core.selectRunnablePart(job, NOW).key, "motor", "the insurer first");
    const claimed = claimedFrom(job, "motor");
    const col = fakeCollection(claimed);
    // the bundled flows ask this one function before they buy
    let boughtInline = 0;
    const { deps, calls } = makeDeps(col, {
      bundledRun: async () => {
        const fd = calls.bundled[0].fd;
        if (shouldCreateBriskCertificate(fd).create) boughtInline += 1;
        return { success: true, briskCertificateSkipped: true };
      },
      policyDoc: { _id: "policy1" },
    });
    await runner.runPartJob(deps, claimed);
    assert.equal(boughtInline, 0, "nothing bought inside the insurer's part");
    assert.equal(calls.brisk.length, 0);
    let doc = col.state.doc;
    assert.equal(partOf(doc, "motor").status, "completed");
    assert.equal(partOf(doc, "pa").status, "pending");
    assert.equal(doc.status, "pending", "the job goes on");
    assert.equal(core.selectRunnablePart(doc, NOW).key, "pa", "then Brisk");

    const claimedPa = claimedFrom(doc, "pa");
    const paCol = fakeCollection(claimedPa);
    const second = makeDeps(paCol, { policyDoc: { _id: "policy1", paCover: true, settings } });
    await runner.runPartJob(second.deps, claimedPa);
    assert.equal(second.calls.brisk.length, 1);
    doc = paCol.state.doc;
    assert.equal(partOf(doc, "pa").status, "completed");
    assert.equal(doc.status, "completed");
    assert.equal(core.selectRunnablePart(doc, NOW), null, "nothing left");
  });
}

test("every insurer form asks the one decision before it buys, so none can buy inline on a job with a Brisk part", () => {
  const fs = require("fs");
  const path = require("path");
  const forms = ["fullPolicycompany/relianceForm.js", "fullPolicycompany/national.js", "fullPolicycompany/kshemaForm.js"];
  for (const f of forms) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    const decided = src.search(/shouldCreateBriskCertificate\(data\)/);
    const bought = src.search(/await createBriskCertificate\(data\)/);
    assert.ok(decided > 0 && bought > decided, f);
  }
  // the part forms of a two-insurer policy are told no in their own copy of the line ([MC] 4, [TP] 6)
  for (const f of ["multiCompany/common/reliance/relianceMultiForm.js", "multiCompany/tpCompany/kshemaTP/kshemaTPForm.js"]) {
    assert.match(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), /const briskDecision = \{ create: false,/, f);
  }
  const portalOnly = fs.readFileSync(path.join(__dirname, "..", "multiCompany/tpCompany/nationalTP/nationalTPForm.js"), "utf8");
  assert.doesNotMatch(portalOnly, /await createBriskCertificate\(/, "National TP never buys Brisk in its form");
});

test("the Brisk window: three at a time unless .env says otherwise, because each one may wait up to 2 minutes for its PDF", () => {
  const src = require("fs").readFileSync(require.resolve("../server.js"), "utf8");
  assert.match(src, /const DEFAULT_BRISK_MAX_PARALLEL_JOBS = 3;/);
});

test("runPartJob (brisk): the run is given the certificate records; number only and PDF not stored reads completed with errors, not completed", async () => {
  const parts = [part("motor", "bundled", "Reliance", { status: "completed" }), part("pa", "brisk", "Brisk", { dependsOn: "motor", paCoverCompany: "Brisk" })];
  const claimed = claimedFrom(jobDoc(parts), "pa");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, {
    briskResult: { success: false, briskFailed: true, certificateNo: "HALF-1", error: "Brisk certificate HALF-1 was created but its PDF could not be stored: Brisk had not made the PDF after 3 checks" },
    policyDoc: { _id: "policy1", paCover: true, settings: { isMultipleCompany: false, ODCompany: "Reliance", TPCompany: "Reliance", PACompany: "Brisk" } },
  });
  deps.certificates = { marker: true };
  await runner.runPartJob(deps, claimed);
  assert.equal(calls.brisk[0].d.certificates, deps.certificates);
  const doc = col.state.doc;
  assert.equal(partOf(doc, "pa").status, "completed_with_errors");
  assert.equal(doc.status, "completed_with_errors");
  assert.equal(partOf(doc, "pa").result.certificateNo, "HALF-1");
});

