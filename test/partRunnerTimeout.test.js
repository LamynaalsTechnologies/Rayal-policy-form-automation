// Run with: node --test test/partRunnerTimeout.test.js
//
// A run that outlives the job timeout is only ABANDONED (the automation keeps running detached, its browser open) and
// the part was always queued for a full re-run. After the portal has saved the proposal that re-run creates a second
// proposal while the first run may still be working — so a timeout after that point is a post-submission failure for an
// operator, not an automatic retry. Before the proposal exists nothing has been created: retried as always.
const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../lib/jobPartsCore");
const runner = require("../lib/partRunner");
const { NOW, singleParts, multiParts, jobDoc, partOf, silentLogger, fakeCollection, withPart } = require("./helpers");
const { beautifyError } = require("../lib/errorHandler");

const processing = (parts, key) => withPart(parts, key, { status: "processing", startedAt: NOW });
const claimedFrom = (job, key) => ({
  ...job,
  status: "processing",
  rev: (job.rev || 0) + 1,
  parts: processing(job.parts, key),
  currentPart: {
    key,
    company: partOf(job, key).company,
    kind: partOf(job, key).kind,
    bucket: core.capacityBucket(partOf(job, key)),
    attempt: 1,
    startedAt: NOW,
  },
});

/**
 * @param {Object} over
 * @param {Array}  [over.policy]   what successive policy reads return ({ proposalNumber } ...); the last one repeats
 * @param {Error}  [over.afterError]  the SECOND read throws
 */
function makeDeps(collection, over = {}) {
  const calls = { wake: [], audit: [], policyReads: 0 };
  const reads = over.policy || [{ _id: "policy1" }];
  const policies = {
    async findOne() {
      const i = calls.policyReads++;
      if (i >= 1 && over.afterError) throw over.afterError;
      return reads[Math.min(i, reads.length - 1)];
    },
    async updateOne() {
      return { matchedCount: 1 };
    },
  };
  const never = () => new Promise(() => {});
  const deps = {
    collection,
    policies,
    hydrateJobFormData: async (job) => job,
    resolveCredentials: async () => ({
      creds: { username: "u", password: "p", loginUrl: "https://portal", _id: "c1" },
      source: "user",
      matchedBy: "user-id",
    }),
    dispatchBundled: async () => ({ run: over.run ? over.run() : never() }),
    resolveMultiCompanyHandler: () => () => (over.run ? over.run() : never()),
    assertMultiCompanyEnabled: () => {},
    runBriskPart: async () => ({ success: true }),
    finalizeRecording: () => {},
    scheduleWakeup: (t) => calls.wake.push(t),
    logAudit: async (action, details) => calls.audit.push([action, details]),
    now: () => NOW,
    logger: { ...silentLogger, warn: () => {} },
    jobTimeoutMs: 25,
    companyLabel: (c) => c,
  };
  return { deps, calls };
}

const SAVED = { _id: "policy1", proposalNumber: "R14102628432" };

test("bundled run times out AFTER the proposal was saved -> failed_post_submission, not queued again", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, { policy: [{ _id: "policy1" }, SAVED] });
  await runner.runPartJob(deps, claimed);

  const motor = partOf(col.state.doc, "motor");
  assert.equal(motor.status, "failed_post_submission");
  assert.equal(motor.lastErrorCode, "E401");
  assert.equal(motor.nextRetryAt == null, true, "no automatic retry is scheduled");
  assert.match(motor.lastError, /R14102628432/);
  assert.match(motor.lastError, /not started again automatically/);
  assert.match(motor.lastError, /second proposal/);
  assert.equal(col.state.doc.status, "failed_post_submission");
  assert.equal(calls.wake.length, 0, "nothing for the queue to wake up for");
  assert.equal(calls.audit.at(-1)[1].severity, "CRITICAL");
});

test("the same timeout BEFORE any proposal exists is retried with backoff, as it always was", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { policy: [{ _id: "policy1" }, { _id: "policy1" }] });
  await runner.runPartJob(deps, claimed);

  const motor = partOf(col.state.doc, "motor");
  assert.equal(motor.status, "pending");
  assert.equal(motor.lastErrorCode, "E302");
  assert.ok(motor.nextRetryAt, "a retry is scheduled");
});

test("a proposal number left by an EARLIER attempt is not taken for this attempt's", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  // the policy already held R-OLD when this attempt started, and still does when it times out
  const { deps } = makeDeps(col, { policy: [{ _id: "policy1", proposalNumber: "R-OLD" }] });
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "motor").status, "pending");
  assert.equal(partOf(col.state.doc, "motor").lastErrorCode, "E302");
});

test("a newer proposal number than the one the attempt started with IS this attempt's", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, {
    policy: [{ _id: "policy1", proposalNumber: "R-OLD" }, { _id: "policy1", proposalNumber: "R-NEW" }],
  });
  await runner.runPartJob(deps, claimed);
  const motor = partOf(col.state.doc, "motor");
  assert.equal(motor.status, "failed_post_submission");
  assert.match(motor.lastError, /R-NEW/);
});

test("when the policy cannot be read after the timeout, it is 'unknown' and retried like any timeout", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { policy: [{ _id: "policy1" }], afterError: new Error("connection reset") });
  await runner.runPartJob(deps, claimed);
  assert.equal(partOf(col.state.doc, "motor").status, "pending");
});

test("a Reliance portal part (OD) that times out AFTER its proposal was saved is not run again either", async () => {
  // common/reliance/relianceMultiForm.js is the Reliance flow: it saves the proposal, so a re-run would make a second one
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { policy: [{ _id: "policy1" }, SAVED] });
  await runner.runPartJob(deps, claimed);
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "failed_post_submission");
  assert.equal(od.lastErrorCode, "E401");
  assert.match(od.lastError, /R14102628432/);
  assert.match(od.lastError, /not started again automatically/);
  assert.equal(od.nextRetryAt == null, true);
});

test("a Reliance portal part (OD) that times out BEFORE any proposal exists is retried as always", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "od");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { policy: [{ _id: "policy1" }, { _id: "policy1" }] });
  await runner.runPartJob(deps, claimed);
  const od = partOf(col.state.doc, "od");
  assert.equal(od.status, "pending");
  assert.equal(od.lastErrorCode, "E302");
});

test("another insurer's portal part (TP at National) keeps the plain retry — the rule is for Reliance and bundled parts", async () => {
  const claimed = claimedFrom(jobDoc(multiParts()), "tp");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, { policy: [{ _id: "policy1" }, SAVED] });
  await runner.runPartJob(deps, claimed);
  const tp = partOf(col.state.doc, "tp");
  assert.equal(tp.status, "pending");
  assert.equal(tp.lastErrorCode, "E302");
});

test("savesProposalPart: bundled parts and Reliance portal parts only", () => {
  assert.equal(runner.savesProposalPart({ kind: "bundled", company: "National" }, "national"), true);
  assert.equal(runner.savesProposalPart({ kind: "portal", company: "Reliance", key: "od" }, "reliance"), true);
  assert.equal(runner.savesProposalPart({ kind: "portal", company: "Reliance", key: "tp" }, "Reliance"), true);
  assert.equal(runner.savesProposalPart({ kind: "portal", company: "National", key: "tp" }, "national"), false);
  assert.equal(runner.savesProposalPart({ kind: "portal", company: "KSHEMA", key: "od" }, "kshema"), false);
  assert.equal(runner.savesProposalPart({ kind: "brisk", company: "Brisk", key: "pa" }, "brisk"), false);
});

test("only a TIMEOUT: another failure after the proposal was saved is left to the rules it already had", async () => {
  const claimed = claimedFrom(jobDoc(singleParts()), "motor");
  const col = fakeCollection(claimed);
  const { deps } = makeDeps(col, {
    policy: [{ _id: "policy1" }, SAVED],
    run: () => Promise.reject(new Error("no such element: Unable to locate element")),
  });
  deps.jobTimeoutMs = 5000;
  await runner.runPartJob(deps, claimed);
  const motor = partOf(col.state.doc, "motor");
  assert.notEqual(motor.lastErrorCode, "E401", "not rewritten as a timeout-after-proposal");
  assert.equal(motor.status, "pending");
});

test("isJobTimeout recognises only the run timer's own error", () => {
  assert.equal(runner.isJobTimeout(new Error("[E302] Job timeout after 900 seconds")), true);
  assert.equal(runner.isJobTimeout(new Error("[E302] Job timeout after 300 seconds")), true);
  assert.equal(runner.isJobTimeout(new Error("Wait timed out after 10000ms")), false);
  assert.equal(runner.isJobTimeout(new Error("[E302] something else timed out")), false);
  assert.equal(runner.isJobTimeout(null), false);
});

test("proposalSavedSince compares with what the attempt started with", async () => {
  const policies = (doc) => ({ findOne: async () => doc });
  assert.equal(await runner.proposalSavedSince(policies({ proposalNumber: "R2" }), "p", "R1"), "R2");
  assert.equal(await runner.proposalSavedSince(policies({ proposalNumber: "R1" }), "p", "R1"), null);
  assert.equal(await runner.proposalSavedSince(policies({ proposalNumber: "R1" }), "p", null), "R1");
  assert.equal(await runner.proposalSavedSince(policies({}), "p", null), null);
  assert.equal(await runner.proposalSavedSince(policies(null), "p", "R1"), null);
  assert.equal(await runner.proposalSavedSince(policies({ proposalNumber: "R1" }), "", null), null);
  assert.equal(
    await runner.proposalSavedSince({ findOne: async () => { throw new Error("down"); } }, "p", null),
    null
  );
});

test("the timeout-after-proposal sentence is plain words that survive beautifyError", () => {
  const o = runner.timeoutAfterProposalOutcome({
    proposal: "R14102628432",
    jobTimeoutMs: 900000,
    processingTimeMs: 901000,
    companyName: "reliance",
    companyLabel: (c) => "Reliance",
  });
  assert.equal(o.type, "postSubmission");
  assert.equal(o.errorCode, "E401");
  assert.equal(o.errorExtra.retryable, false);
  assert.match(o.error, /^\[Reliance\] The run did not finish within 15 minutes, after the portal had saved proposal R14102628432\./);
  assert.ok(!o.error.slice("[Reliance] ".length).includes(":"));
  assert.equal(beautifyError(o.error.replace(/^\[Reliance\] /, ""), "Reliance"), o.error);
});
