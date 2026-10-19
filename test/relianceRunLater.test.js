/**
 * "Only update" -> run later (lib/relianceRunLater.js): a Reliance step set back to pending with "Only update" is
 * queued when the automation starts or when its queue is idle. Fake collections only — no database, no browser.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { decide, sweepRunLater, createIdleSweeper, freshPart, runLaterFilter } = require("../lib/relianceRunLater");

const NOW = new Date("2026-10-19T12:00:00Z");
const silent = { log() {}, warn() {} };

/** Dotted paths, as Mongo reads them. */
const getPath = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const unsetPath = (obj, dotted) => {
  const keys = dotted.split(".");
  const last = keys.pop();
  const owner = keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (owner) delete owner[last];
};

function collections({ policies = [], jobs = [] } = {}) {
  const P = policies.map((p) => structuredClone(p));
  const J = jobs.map((j) => structuredClone(j));
  const writes = { jobs: [], policies: [] };
  const policiesCol = {
    find(filter) {
      const keys = filter.$or.map((c) => Object.keys(c)[0]);
      return { toArray: async () => structuredClone(P.filter((p) => keys.some((k) => getPath(p, k) !== undefined))) };
    },
    async updateOne(filter, update) {
      const d = P.find((p) => p._id === filter._id);
      if (!d) return { matchedCount: 0 };
      for (const k of Object.keys(update.$unset || {})) unsetPath(d, k);
      writes.policies.push(update);
      return { matchedCount: 1 };
    },
  };
  const jobsCol = {
    async findOne(filter) {
      const j = J.find((x) => x.captchaId === filter.captchaId && (!filter.parts || Array.isArray(x.parts)));
      return j ? structuredClone(j) : null;
    },
    async updateOne(filter, update) {
      const d = J.find((x) => x._id === filter._id);
      const revOk = filter.rev && filter.rev.$exists === false ? d && d.rev === undefined : d && d.rev === filter.rev;
      if (!d || d.status !== filter.status || !revOk) return { matchedCount: 0 };
      Object.assign(d, structuredClone(update.$set));
      for (const [k, v] of Object.entries(update.$push || {})) (d[k] = d[k] || []).push(...structuredClone(v.$each));
      for (const [k, v] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + v;
      writes.jobs.push(update);
      return { matchedCount: 1 };
    },
  };
  return { policies: policiesCol, jobs: jobsCol, P, J, writes };
}

const motorPart = (over = {}) => ({
  key: "motor",
  label: "OD + TP",
  kind: "bundled",
  company: "reliance",
  status: "completed",
  attempts: 2,
  maxAttempts: 5,
  completedAt: new Date("2026-10-19T09:00:00Z"),
  result: { proposalNumber: "R1" },
  lastError: "old",
  ...over,
});
const policyDoc = (over = {}, stagesOver = {}) => ({
  _id: "pol1",
  policyId: "OP1",
  relianceStages: {
    motor: {
      proposal: { status: "completed", proposalNumber: "R1" },
      kyc: { status: "pending" },
      payment: { status: "pending" },
      runLater: { stage: "kyc", at: NOW, by: "u1" },
      ...stagesOver,
    },
  },
  ...over,
});
const jobDoc = (over = {}, partOver = {}) => ({ _id: "job1", captchaId: "pol1", status: "completed", rev: 4, parts: [motorPart(partOver)], statusHistory: [], ...over });

test("a step set back with Only update is queued: that part fresh, the job pending, one history line, the mark used once", async () => {
  const c = collections({ policies: [policyDoc()], jobs: [jobDoc()] });
  const counts = await sweepRunLater({ jobs: c.jobs, policies: c.policies, when: "idle", now: NOW, logger: silent });
  assert.deepEqual(counts, { requeued: 1, waiting: 0, dropped: 0 });
  const job = c.J[0];
  const part = job.parts[0];
  assert.equal(part.status, "pending");
  assert.equal(part.attempts, 0);
  assert.equal(part.lastError, null);
  assert.deepEqual(part.result, {});
  assert.equal(job.status, "pending", "the job is pending again, so the queue picks it up");
  assert.equal(job.rev, 5, "written under the automation's own lock");
  assert.equal(job.statusHistory.length, 1);
  assert.equal(job.statusHistory[0].part, "motor");
  assert.match(job.statusHistory[0].note, /Reliance KYC was set back to pending with Only update - run now \(automation free\)/);
  assert.equal(c.P[0].relianceStages.motor.runLater, undefined, "the mark is removed");
  // a second sweep has nothing to do
  assert.deepEqual(await sweepRunLater({ jobs: c.jobs, policies: c.policies, now: NOW, logger: silent }), { requeued: 0, waiting: 0, dropped: 0 });
});

test("waits (mark kept) while the job runs, is on hold, or this part is running", async () => {
  for (const job of [jobDoc({ status: "processing" }), jobDoc({ status: "hold" }), jobDoc({ status: "pending" }, { status: "processing" })]) {
    const c = collections({ policies: [policyDoc()], jobs: [job] });
    const counts = await sweepRunLater({ jobs: c.jobs, policies: c.policies, now: NOW, logger: silent });
    assert.deepEqual(counts, { requeued: 0, waiting: 1, dropped: 0 }, job.status);
    assert.ok(c.P[0].relianceStages.motor.runLater, "kept for a later sweep");
    assert.equal(c.writes.jobs.length, 0, "the job is not touched");
  }
});

test("drops the mark when the step ran meanwhile, the part is already queued, or the wallet paid at Reliance", async () => {
  const cases = [
    [policyDoc({}, { kyc: { status: "completed" } }), jobDoc(), /no longer pending/],
    [policyDoc(), jobDoc({ status: "pending" }, { status: "pending" }), /already queued/],
    [policyDoc({ walletPayment: { state: "issued" } }), jobDoc(), /wallet/],
  ];
  for (const [policy, job, why] of cases) {
    const c = collections({ policies: [policy], jobs: [job] });
    const lines = [];
    const counts = await sweepRunLater({ jobs: c.jobs, policies: c.policies, now: NOW, logger: { log: (l) => lines.push(l), warn() {} } });
    assert.equal(counts.dropped, 1);
    assert.equal(c.P[0].relianceStages.motor.runLater, undefined);
    assert.equal(c.writes.jobs.length, 0, "nothing is queued");
    assert.match(lines.join("\n"), why);
  }
});

test("an old-shape job (no parts) waits; the job changing under the sweep (rev) keeps the mark", async () => {
  const legacy = collections({ policies: [policyDoc()], jobs: [{ _id: "j", captchaId: "pol1", status: "failed_post_submission" }] });
  assert.equal((await sweepRunLater({ jobs: legacy.jobs, policies: legacy.policies, now: NOW, logger: silent })).waiting, 1);

  const c = collections({ policies: [policyDoc()], jobs: [jobDoc()] });
  const realUpdate = c.jobs.updateOne;
  c.jobs.updateOne = async (filter, update) => {
    c.J[0].rev = 99; // claimed / edited right before the write
    return realUpdate(filter, update);
  };
  const counts = await sweepRunLater({ jobs: c.jobs, policies: c.policies, now: NOW, logger: silent });
  assert.deepEqual(counts, { requeued: 0, waiting: 1, dropped: 0 });
  assert.ok(c.P[0].relianceStages.motor.runLater, "kept — the next sweep looks again");
});

test("only marked parts are touched; the other part of a two-insurer policy is left as it is", async () => {
  const policy = { _id: "pol2", relianceStages: { od: { kyc: { status: "pending" }, runLater: { stage: "kyc" } } } };
  const job = {
    _id: "job2",
    captchaId: "pol2",
    status: "failed_post_submission",
    rev: 1,
    parts: [
      { key: "tp", kind: "portal", company: "national", status: "completed", attempts: 1, maxAttempts: 5 },
      { key: "od", kind: "portal", company: "reliance", status: "failed_post_submission", attempts: 1, maxAttempts: 5, dependsOn: "tp" },
    ],
  };
  const c = collections({ policies: [policy], jobs: [job] });
  assert.equal((await sweepRunLater({ jobs: c.jobs, policies: c.policies, now: NOW, logger: silent })).requeued, 1);
  assert.equal(c.J[0].parts.find((p) => p.key === "tp").status, "completed");
  assert.equal(c.J[0].parts.find((p) => p.key === "od").status, "pending");
});

test("the idle check runs at most once a minute, and never twice at the same time", async () => {
  let t = 0;
  const sweep = createIdleSweeper({ clock: () => t });
  const c = collections({ policies: [], jobs: [] });
  t = 100000;
  assert.notEqual(await sweep({ jobs: c.jobs, policies: c.policies, logger: silent }), null);
  t += 30000;
  assert.equal(await sweep({ jobs: c.jobs, policies: c.policies, logger: silent }), null, "30 s later: skipped");
  t += 31000;
  assert.notEqual(await sweep({ jobs: c.jobs, policies: c.policies, logger: silent }), null, "a minute later: runs");
});

test("never throws: an unreadable database gives empty counts", async () => {
  const counts = await sweepRunLater({
    jobs: {},
    policies: { find: () => ({ toArray: async () => { throw new Error("down"); } }) },
    logger: silent,
  });
  assert.deepEqual(counts, { requeued: 0, waiting: 0, dropped: 0 });
  assert.equal(freshPart({ key: "x", status: "failed" }, NOW).nextRetryAt, NOW);
  assert.equal(runLaterFilter().$or.length, 3);
  assert.equal(decide({ policy: policyDoc(), job: null, key: "motor" }).action, "drop");
});

test("server.js: swept on start (before the pending jobs are counted) and when the queue is idle", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = src.indexOf('await sweepRunLater({ jobs: jobQueueCollection, policies: db.collection("onlinePolicy"), when: "start"');
  const count = src.indexOf("const pendingCount = await jobQueueCollection.countDocuments({");
  assert.ok(start > 0 && count > start, "on start, before the pending count");
  const idle = src.indexOf('const swept = await idleRunLater({ jobs: jobQueueCollection, policies: db.collection("onlinePolicy")');
  const noJobs = src.indexOf("if (pendingJobs.length === 0) {");
  const ret = src.indexOf("return; // No pending jobs ready");
  assert.ok(noJobs > 0 && idle > noJobs && ret > idle, "inside the no-job branch");
  assert.match(src.slice(idle - 200, idle), /if \(processingJobs\.length === 0\) \{/, "only when nothing runs");
  assert.match(src.slice(idle, idle + 200), /if \(swept && swept\.requeued\) queuePassRequested = true;/);
});
