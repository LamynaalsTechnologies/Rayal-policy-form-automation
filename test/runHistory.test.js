// Run with: node --require ./test/support/noRealWorld.js --test test/runHistory.test.js
//
// lib/runHistory.js (2026-10-22): one record per automation RUN on the job - when, who started it, which login (never the
// password), how long proposal / KYC / payment took, and how it ended. Fakes only: a fake job collection, no database.
const test = require("node:test");
const assert = require("node:assert/strict");

const rh = require("../lib/runHistory");
const core = require("../lib/jobPartsCore");
const runner = require("../lib/partRunner");
const { NOW, singleParts, jobDoc, partOf, silentLogger, fakeCollection } = require("./helpers");

const T = (ms) => new Date(NOW.getTime() + ms);
const EDITOR = "6600000000000000000000a1";

/* ------------------------------ who started it ------------------------------ */

test("trigger: the job's pendingTrigger for the first run after it; later runs of the same part are automatic retries", () => {
  const pendingTrigger = { kind: "edited", by: EDITOR, at: T(0) };
  assert.deepEqual(rh.triggerFor({ pendingTrigger, runHistory: [] }, "od"), { kind: "edited", by: EDITOR, at: T(0) });
  const afterOd = { pendingTrigger, runHistory: [{ part: "od", startedAt: T(1000) }] };
  assert.equal(rh.triggerFor(afterOd, "od").kind, "auto-retry", "attempt 2 of OD");
  assert.equal(rh.triggerFor(afterOd, "tp").kind, "edited", "TP started by the same edit still shows the editor");
  const olderRun = { pendingTrigger, runHistory: [{ part: "od", startedAt: T(-5000) }] };
  assert.equal(rh.triggerFor(olderRun, "od").kind, "edited", "a run from before this trigger does not count");
  assert.deepEqual(rh.triggerFor({}, "motor"), { kind: "queued", by: null, at: null }, "a job queued before triggers existed");
});

test("login: username, whose and how it was matched - never the password", () => {
  const login = rh.loginOf({
    creds: { _id: "c1", username: "15A26733B01", password: "RGICL@123", userId: "65a343220a6016a8f93424e7", loginUrl: "https://x" },
    source: "client",
    matchedBy: "client-own",
  });
  assert.deepEqual(login, { id: "c1", username: "15A26733B01", source: "client", matchedBy: "client-own", ownerId: "65a343220a6016a8f93424e7" });
  assert.ok(!JSON.stringify(login).includes("RGICL"), "no password");
  assert.equal(rh.loginOf(null), null);
});

/* ------------------------------ the record on the job ------------------------------ */

test("a run: started, login, steps timed from the previous step, ended with its outcome and total time", async () => {
  const col = fakeCollection({ _id: "j1", runHistory: [], pendingTrigger: { kind: "retried", by: EDITOR, at: T(-1) } });
  const job = await col.findOne({ _id: "j1" });
  const runId = await rh.startRun(col, job, { key: "motor", company: "reliance" }, { attempt: 2, now: T(0) });
  await rh.setRunLogin(col, "j1", runId, { creds: { _id: "c1", username: "U1", password: "secret", userId: "u" }, source: "user", matchedBy: "user-id" });
  const data = { _jobId: "j1", _runId: runId, _runStartedAt: T(0) };
  await rh.markRunStep(data, "proposal", { now: T(130000), collection: col });
  await rh.markRunStep(data, "kyc", { now: T(195000), collection: col });
  await rh.markRunStep(data, "payment", { mode: "wallet", now: T(235000), collection: col });
  const end = rh.runEndUpdate(runId, { outcome: "completed", now: T(252000), startedAt: T(0) });
  await col.updateOne({ _id: "j1" }, { $set: end.$set }, { arrayFilters: end.arrayFilters });

  const run = col.state.doc.runHistory[0];
  assert.equal(run.attempt, 2);
  assert.equal(run.part, "motor");
  assert.deepEqual(run.trigger, { kind: "retried", by: EDITOR, at: T(-1) });
  assert.equal(run.credential.username, "U1");
  assert.equal(run.steps.proposal.ms, 130000);
  assert.equal(run.steps.kyc.ms, 65000);
  assert.deepEqual({ ms: run.steps.payment.ms, mode: run.steps.payment.mode }, { ms: 40000, mode: "wallet" });
  assert.equal(run.outcome, "completed");
  assert.equal(run.durationMs, 252000);
  assert.ok(!JSON.stringify(col.state.doc.runHistory).includes("secret"));
});

test("a resumed run (proposal done earlier): its first step is timed from the run start", async () => {
  const col = fakeCollection({ _id: "j2", runHistory: [] });
  const runId = await rh.startRun(col, await col.findOne({ _id: "j2" }), { key: "od" }, { now: T(0) });
  await rh.markRunStep({ _jobId: "j2", _runId: runId }, "kyc", { now: T(50000), collection: col });
  const run = col.state.doc.runHistory[0];
  assert.equal(run.steps.proposal, undefined);
  assert.equal(run.steps.kyc.ms, 50000);
});

test("only the newest 100 runs are kept", async () => {
  const col = fakeCollection({ _id: "j3", runHistory: Array.from({ length: 100 }, (_, i) => ({ runId: `old${i}`, part: "od" })) });
  await rh.startRun(col, await col.findOne({ _id: "j3" }), { key: "od" }, { now: T(0) });
  assert.equal(col.state.doc.runHistory.length, 100);
  assert.equal(col.state.doc.runHistory[0].runId, "old1");
});

test("a write that fails never stops the run", async () => {
  const broken = { updateOne: async () => { throw new Error("db down"); } };
  const runId = await rh.startRun(broken, { _id: "j4" }, { key: "od" }, { now: T(0) });
  assert.ok(runId);
  assert.equal(await rh.markRunStep({ _jobId: "j4", _runId: runId }, "kyc", { collection: broken }), false);
  assert.equal(await rh.setRunLogin(broken, "j4", runId, { creds: { username: "u" } }), false);
  assert.equal(await rh.endRun(broken, "j4", runId, { outcome: "failed" }), false);
});

/* ------------------------------ through the parts runner ------------------------------ */

const claimedFrom = (job, key) => ({
  ...job,
  status: "processing",
  rev: (job.rev || 0) + 1,
  parts: job.parts.map((p) => (p.key === key ? { ...p, status: "processing", startedAt: NOW } : p)),
  currentPart: { key, company: partOf(job, key).company, kind: partOf(job, key).kind, bucket: core.capacityBucket(partOf(job, key)), attempt: 1, startedAt: NOW },
});

function deps(col, run) {
  return {
    collection: col,
    policies: { findOne: async () => ({ _id: "policy1" }), updateOne: async () => ({ matchedCount: 1 }) },
    hydrateJobFormData: async (job) => job,
    resolveCredentials: async () => ({ creds: { _id: "c9", username: "15A26733B01", password: "RGICL@123", userId: "client1" }, source: "client", matchedBy: "client-own" }),
    dispatchBundled: async (formData, o) => ({ run: run({ ...formData, _jobId: o.jobId }) }), // as server.js does
    resolveMultiCompanyHandler: () => (formData) => run(formData),
    assertMultiCompanyEnabled: () => {},
    runBriskPart: async () => ({ success: true }),
    finalizeRecording: () => {},
    scheduleWakeup: () => {},
    logAudit: async () => {},
    now: () => NOW,
    logger: { ...silentLogger, warn: () => {} },
    jobTimeoutMs: 60000,
    companyLabel: (c) => c,
  };
}

test("runPartJob: the run is recorded start to end - who, login, its steps, outcome - and the form gets the run id", async () => {
  const claimed = claimedFrom({ ...jobDoc(singleParts()), pendingTrigger: { kind: "created", by: EDITOR, at: new Date(NOW.getTime() - 1000) } }, "motor");
  const col = fakeCollection(claimed);
  let seen = null;
  await runner.runPartJob(
    deps(col, async (formData) => {
      seen = formData;
      await rh.markRunStep(formData, "proposal", { now: NOW, collection: col });
      return { success: true, proposalNumber: "R1" };
    }),
    claimed
  );
  const runs = col.state.doc.runHistory;
  assert.equal(runs.length, 1);
  const r = runs[0];
  assert.equal(seen._runId, r.runId);
  assert.equal(r.part, "motor");
  assert.equal(r.attempt, 1);
  assert.deepEqual({ kind: r.trigger.kind, by: r.trigger.by }, { kind: "created", by: EDITOR });
  assert.equal(r.credential.username, "15A26733B01");
  assert.equal(r.credential.source, "client");
  assert.equal(r.steps.proposal.status, "completed");
  assert.equal(r.outcome, "completed");
  assert.ok(r.endedAt);
  assert.ok(!JSON.stringify(runs).includes("RGICL@123"), "the password is never stored");
});

test("runPartJob: a failed run records its outcome and reason; the next run of the part is an automatic retry", async () => {
  const claimed = claimedFrom({ ...jobDoc(singleParts()), pendingTrigger: { kind: "edited", by: EDITOR, at: new Date(NOW.getTime() - 1000) } }, "motor");
  const col = fakeCollection(claimed);
  await runner.runPartJob(deps(col, async () => ({ success: false, error: "[E309] The step did not finish in 1.5 minutes" })), claimed);
  const first = col.state.doc.runHistory[0];
  assert.equal(first.outcome, "pending", "retry scheduled");
  assert.match(first.error, /did not finish/);
  assert.equal(first.trigger.kind, "edited");
  // the queue claims it again
  const again = claimedFrom(col.state.doc, "motor");
  const col2 = fakeCollection(again);
  await runner.runPartJob(deps(col2, async () => ({ success: true })), again);
  const second = col2.state.doc.runHistory.at(-1);
  assert.equal(second.attempt, 2);
  assert.equal(second.trigger.kind, "auto-retry");
  assert.equal(second.outcome, "completed");
});

/* ------------------------------ wiring ------------------------------ */

const fs = require("fs");
const path = require("path");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("wiring: legacy jobs open and close a run; every step of Reliance / KSHEMA / National is timed", () => {
  const server = read("server.js");
  assert.match(server, /runHistory\.startRun\(\s*jobQueueCollection,/);
  assert.match(server, /runHistory\.setRunLogin\(jobQueueCollection, job\._id, runId, resolved\)/);
  assert.match(server, /runHistory\.endRun\(jobQueueCollection, rawJob\._id, run\.runId/);
  assert.match(read("fullPolicycompany", "reliance", "relianceStages.js"), /markRunStep\(data, stage, \{ status, mode: extra && extra\.mode, now \}\)/, "Reliance and KSHEMA (kshemaStages uses it)");
  for (const f of [["fullPolicycompany", "national.js"], ["multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js"]]) {
    const src = read(...f);
    for (const step of ['"proposal"', '"kyc"', '"payment", { mode: "link" }']) assert.ok(src.includes(`runHistory.markRunStep(data, ${step}`), `${f.at(-1)} ${step}`);
  }
});
