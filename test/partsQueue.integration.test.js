// Drives claim -> run (stub handlers) -> write-back against REAL documents in an
// in-memory MongoDB replica set (never the .env database).
//
// Needs mongodb-memory-server (not a dependency of this repo). Point MMS_PATH at
// an install, e.g.
//   MMS_PATH=/path/to/node_modules/mongodb-memory-server node --test test/*.test.js
// Without it these tests are skipped. MONGOMS_VERSION picks the mongod build
// (default 7.0.14).
const test = require("node:test");
const assert = require("node:assert/strict");
const { MongoClient } = require("mongodb");

const runner = require("../lib/partRunner");
const core = require("../lib/jobPartsCore");
const { runBriskPart } = require("../lib/briskPartRunner");
const { saveRecordingEntry } = require("../lib/recordingEntries");
const { NOW, part, formData, multiParts, jobDoc, withPart, partOf, silentLogger } = require("./helpers");

const MMS_PATH =
  process.env.MMS_PATH ||
  "/tmp/claude-1000/-home-karthi-Documents-Rayal-policy-automation/5d2597d5-44b0-430a-b5bb-fa4f71566f34/scratchpad/mms/node_modules/mongodb-memory-server";
let MongoMemoryReplSet = null;
try {
  ({ MongoMemoryReplSet } = require(MMS_PATH));
} catch (e) {
  /* skipped below */
}

let replSet = null;
let client = null;
let db = null;
let ready = false;
let counter = 0;

test.before(async () => {
  if (!MongoMemoryReplSet) return;
  try {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      binary: { version: process.env.MONGOMS_VERSION || "7.0.14" },
    });
    client = await MongoClient.connect(replSet.getUri());
    db = client.db("partsqueue");
    ready = true;
  } catch (e) {
    console.warn(`# in-memory MongoDB could not start: ${e.message}`);
  }
});
test.after(async () => {
  if (client) await client.close();
  if (replSet) await replSet.stop();
});

const it = (name, fn) =>
  test(name, async (t) => {
    if (!ready) return t.skip(MongoMemoryReplSet ? "in-memory MongoDB unavailable" : "mongodb-memory-server not installed");
    await fn(t);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fresh queue + policy collection with stub handlers and a controllable clock. */
function newEnv(name) {
  const col = db.collection(`q_${name}_${++counter}`);
  const policies = db.collection(`p_${name}_${counter}`);
  const clock = { now: new Date(NOW) };
  const calls = { handler: [], bundled: [], brisk: 0, creds: [] };
  const behaviour = { handler: {}, bundled: null, brisk: {} };

  const fakeBrisk = {
    shouldCreateBriskCertificate: (d) => ({ create: d.paCover === true && d.paCoverCompany === "Brisk", reason: "n/a" }),
    async createBriskCertificate() {
      calls.brisk++;
      if (behaviour.brisk.createError) throw new Error(behaviour.brisk.createError);
      return { success: true, policyId: "CERT-1", downloadUrl: "https://brisk/x.pdf" };
    },
    async downloadBriskPDF() {
      return "/tmp/none-brisk.pdf";
    },
    async uploadBriskCertificate() {
      return { key: "BriskCertificates/CERT-1.pdf" };
    },
  };

  const deps = {
    collection: col,
    policies,
    hydrateJobFormData: async (job) => job,
    resolveCredentials: async (company) => {
      calls.creds.push(company);
      return { creds: { username: "u", password: "p", loginUrl: "https://x", _id: "c" }, source: "user", matchedBy: "user-id" };
    },
    dispatchBundled: async (fd, ctx) => {
      calls.bundled.push(ctx.companyName);
      return { run: Promise.resolve(behaviour.bundled || { success: true }) };
    },
    resolveMultiCompanyHandler: (company, key) => (data) => {
      calls.handler.push(`${key}@${company}#${data._attemptNumber}`);
      const b = behaviour.handler[key];
      return Promise.resolve(typeof b === "function" ? b(data) : b || { success: true });
    },
    assertMultiCompanyEnabled: () => {},
    runBriskPart: (data, d) => runBriskPart(data, { ...d, brisk: fakeBrisk, log() {}, warn() {} }),
    finalizeRecording: () => {},
    scheduleWakeup: () => {},
    logAudit: async () => {},
    now: () => new Date(clock.now),
    logger: silentLogger,
    jobTimeoutMs: 2000,
    companyLabel: (c) => c,
  };

  // Same shape as server.js: parts jobs count against the part they run, others per company.
  const companyOfJob = (job) => {
    const running = job?.currentPart?.bucket || job?.currentPart?.company;
    if (running) return String(running).toLowerCase();
    return String(job?.formData?.Companyname || "reliance").toLowerCase();
  };

  /** One queue pass, using the same building blocks as processRelianceQueue. */
  async function pass(limits = {}) {
    const now = new Date(clock.now);
    const processing = await col.find({ status: "processing" }).toArray();
    const active = {};
    for (const j of processing) active[companyOfJob(j)] = (active[companyOfJob(j)] || 0) + 1;
    const candidates = await col
      .find({ status: "pending", $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] })
      .sort({ createdAt: 1 })
      .toArray();
    const { toStart } = runner.planClaims(candidates, {
      now,
      activeByCompany: active,
      maxParallelFor: (b) => (b in limits ? limits[b] : 1),
      companyOfJob,
    });
    const started = [];
    const runs = [];
    for (const { job, part: p } of toStart) {
      const claimed = await runner.claimPart(col, job, p, { now });
      if (!claimed) continue;
      started.push(`${claimed._id}:${p.key}`);
      runs.push(runner.runPartJob(deps, claimed));
    }
    await Promise.all(runs);
    return started;
  }

  return { col, policies, clock, calls, behaviour, deps, pass };
}

const insertJob = async (env, parts, extra = {}) => {
  const doc = jobDoc(parts, { _id: `job-${++counter}`, captchaId: `policy-${counter}`, ...extra });
  await env.col.insertOne(doc);
  await env.policies.insertOne({ _id: doc.captchaId });
  return doc;
};

/* -------------------------------- claiming -------------------------------- */

it("claim is atomic: of two racing claims on the same part exactly one wins; TP cannot start while OD runs", async () => {
  const env = newEnv("claim");
  const job = await insertJob(env, multiParts());
  const od = partOf(job, "od");
  const tp = partOf(job, "tp");

  const results = await Promise.all([runner.claimPart(env.col, job, od), runner.claimPart(env.col, job, od)]);
  assert.equal(results.filter(Boolean).length, 1);

  const doc = await env.col.findOne({ _id: job._id });
  assert.equal(doc.status, "processing");
  assert.equal(doc.rev, 1);
  assert.equal(doc.currentPart.key, "od");
  assert.equal(doc.currentPart.bucket, "reliance");
  assert.equal(partOf(doc, "od").status, "processing");
  assert.equal(partOf(doc, "tp").status, "pending", "only the claimed part changes");
  assert.equal(partOf(doc, "pa").status, "pending");

  // the SAME snapshot cannot also claim TP: the job is processing (one part at a time)
  assert.equal(await runner.claimPart(env.col, job, tp), null);
});

it("claim fails when the job was edited since it was read (stale rev) or the part is no longer pending", async () => {
  const env = newEnv("stale");
  const job = await insertJob(env, multiParts());
  await env.col.updateOne({ _id: job._id }, { $inc: { rev: 1 } }); // an edit lands
  assert.equal(await runner.claimPart(env.col, job, partOf(job, "od")), null);

  const fresh = await env.col.findOne({ _id: job._id });
  await env.col.updateOne({ _id: job._id }, { $set: { "parts.0.status": "completed" }, $inc: { rev: 0 } });
  assert.equal(await runner.claimPart(env.col, fresh, partOf(fresh, "od")), null, "a part that is not pending is never claimed");
});

it("a stored nextRetryAt of null (or no rev at all) is still picked up and claimed", async () => {
  const env = newEnv("null");
  const doc = jobDoc([part("od", "portal", "Reliance")], { _id: "nullish", nextRetryAt: null });
  delete doc.rev;
  await env.col.insertOne(doc);
  await env.policies.insertOne({ _id: doc.captchaId });
  const started = await env.pass();
  assert.deepEqual(started, ["nullish:od"]);
  const after = await env.col.findOne({ _id: "nullish" });
  assert.equal(partOf(after, "od").status, "completed");
  assert.equal(after.rev, 2);
});

/* ------------------------------ the whole loop ----------------------------- */

it("multi-company + Brisk PA: OD, TP, then PA — one part per claim, in order, job completed", async () => {
  const env = newEnv("loop");
  const job = await insertJob(env, multiParts());

  // The heartbeat (server.js startJobHeartbeat) runs while a part is running; it must not touch rev.
  let revs = null;
  env.behaviour.handler.od = async () => {
    const before = (await env.col.findOne({ _id: job._id })).rev;
    await env.col.updateOne({ _id: job._id, status: "processing" }, { $set: { lastHeartbeatAt: new Date() } });
    revs = [before, (await env.col.findOne({ _id: job._id })).rev];
    return { success: true };
  };
  const p1 = await env.pass();
  assert.deepEqual(revs, [1, 1], "a heartbeat does not change rev");
  assert.deepEqual(p1, [`${job._id}:od`]);
  const p2 = await env.pass();
  assert.deepEqual(p2, [`${job._id}:tp`]);
  let mid = await env.col.findOne({ _id: job._id });
  assert.equal(mid.status, "pending");
  assert.equal(partOf(mid, "pa").waitingFor, undefined, "PA is free once OD is done");
  const p3 = await env.pass();
  assert.deepEqual(p3, [`${job._id}:pa`]);
  assert.deepEqual(await env.pass(), []);

  assert.deepEqual(env.calls.handler, ["od@reliance#1", "tp@national#1"]);
  assert.equal(env.calls.brisk, 1);
  const doc = await env.col.findOne({ _id: job._id });
  assert.equal(doc.status, "completed");
  assert.equal(doc.rev, 6); // 3 claims + 3 write-backs
  assert.equal(doc.currentPart, undefined);
  assert.equal(doc.statusHistory.length, 3);
  assert.deepEqual(doc.parts.map((p) => p.status), ["completed", "completed", "completed"]);
  assert.equal(partOf(doc, "pa").result.certificateNo, "CERT-1");
  const policy = await env.policies.findOne({ _id: doc.captchaId });
  assert.equal(policy.briskCertificate.certificateNo, "CERT-1", "the certificate is recorded on the policy");
});

it("per-insurer windows: two policies at Reliance never run their OD parts at once", async () => {
  const env = newEnv("window");
  const a = await insertJob(env, [part("od", "portal", "Reliance")], { createdAt: new Date(NOW.getTime() - 2000) });
  const b = await insertJob(env, [part("od", "portal", "Reliance")], { createdAt: new Date(NOW.getTime() - 1000) });
  // make A's run block so B is considered while A is processing
  let release;
  env.behaviour.handler.od = () => new Promise((r) => (release = () => r({ success: true })));
  const first = env.pass();
  await sleep(150);
  const second = await env.pass(); // while A is still running
  assert.deepEqual(second, [], "Reliance window (1) is taken");
  release();
  assert.deepEqual(await first, [`${a._id}:od`]);
  env.behaviour.handler.od = { success: true };
  assert.deepEqual(await env.pass(), [`${b._id}:od`]);
});

it("TP completes, OD fails for good -> job failed, PA blocked, TP never re-bought; Retry re-runs OD only", async () => {
  const env = newEnv("odfail");
  const job = await insertJob(env, withPart(multiParts(), "tp", { status: "completed", completedAt: NOW }));
  env.behaviour.handler.od = { success: false, errorCode: "E203", retryable: false, error: "Wrong password", screenshotKey: "s.png" };

  assert.deepEqual(await env.pass(), [`${job._id}:od`]);
  let doc = await env.col.findOne({ _id: job._id });
  assert.equal(doc.status, "failed_login_form");
  assert.equal(partOf(doc, "tp").status, "completed");
  assert.equal(partOf(doc, "pa").blockedBy, "od");
  assert.equal(core.summarizeParts(doc.parts, { now: NOW }).label, "OD failed, TP completed, PA waiting for OD");
  assert.equal(doc.errorLogs[0].part, "od");
  assert.equal(doc.errorLogs[0].screenshotKey, "s.png");
  assert.deepEqual(await env.pass(), [], "a failed job is not picked up again on its own");

  // the backend's Retry: reset the unfinished part, back to pending, bump rev
  env.behaviour.handler.od = { success: true };
  const reset = core.normalizeParts(doc.parts).map((p) => (p.key === "od" ? { ...p, status: "pending", attempts: 0, stopped: false, nextRetryAt: NOW } : p));
  await env.col.updateOne({ _id: job._id, rev: doc.rev }, { $set: { parts: reset, status: "pending", nextRetryAt: NOW }, $inc: { rev: 1 } });
  assert.deepEqual(await env.pass(), [`${job._id}:od`]);
  assert.deepEqual(await env.pass(), [`${job._id}:pa`]);
  assert.deepEqual(env.calls.handler, ["od@reliance#1", "od@reliance#1"], "TP was never run");
  assert.equal((await env.col.findOne({ _id: job._id })).status, "completed");
});

it("a retryable failure backs off per part while the job's other parts carry on; the retry uses the next attempt number", async () => {
  const env = newEnv("backoff");
  const job = await insertJob(env, multiParts());
  env.behaviour.handler.od = { success: false, error: "element not found" };

  assert.deepEqual(await env.pass(), [`${job._id}:od`]);
  let doc = await env.col.findOne({ _id: job._id });
  assert.equal(doc.status, "pending");
  assert.equal(partOf(doc, "od").attempts, 1);
  assert.equal(partOf(doc, "od").nextRetryAt.getTime(), NOW.getTime() + 60000);

  // TP is independent and due now
  assert.deepEqual(await env.pass(), [`${job._id}:tp`]);
  // nothing else is due until the backoff ends
  assert.deepEqual(await env.pass(), []);
  doc = await env.col.findOne({ _id: job._id });
  assert.equal(doc.status, "pending");
  assert.equal(doc.nextRetryAt.getTime(), NOW.getTime() + 60000, "the job wakes when OD is due");

  env.clock.now = new Date(NOW.getTime() + 61000);
  env.behaviour.handler.od = { success: true };
  assert.deepEqual(await env.pass(), [`${job._id}:od`]);
  assert.equal(env.calls.handler.at(-1), "od@reliance#2");
});

it("an edit that lands between the write-back's read and its save conflicts on rev and is folded in", async () => {
  const env = newEnv("conflict");
  const job = await insertJob(env, multiParts());
  const real = env.col;
  let injected = 0;
  env.deps.collection = {
    findOne: (...a) => real.findOne(...a),
    updateOne: async (filter, update) => {
      if (update.$push && update.$push.statusHistory && !injected++) {
        // the backend's in-place edit, exactly between our read and our save
        await real.updateOne(
          { _id: job._id },
          { $inc: { rev: 1 }, $set: { "parts.0.requeue": { company: "KSHEMA", carriesPa: false, paCoverCompany: null, at: NOW } } }
        );
      }
      return real.updateOne(filter, update);
    },
  };
  env.behaviour.handler.od = { success: false, error: "element not found" };
  await env.pass();
  const doc = await env.col.findOne({ _id: job._id });
  assert.equal(injected, 2, "first save conflicted, second went through");
  assert.equal(partOf(doc, "od").company, "KSHEMA");
  assert.equal(partOf(doc, "od").status, "pending");
  assert.equal(partOf(doc, "od").attempts, 0);
  assert.equal(doc.rev, 3); // claim, the edit, our save
});

it("an edit that lands while a part runs is folded in at write-back", async () => {
  const env = newEnv("edit");
  const job = await insertJob(env, multiParts());
  env.behaviour.handler.od = async () => {
    // the backend edits the job in place: rev + requeue flag on the running part
    await env.col.updateOne(
      { _id: job._id },
      { $inc: { rev: 1 }, $set: { "parts.0.requeue": { company: "National", carriesPa: false, paCoverCompany: null, at: NOW } } }
    );
    return { success: false, error: "element not found" };
  };
  await env.pass();
  const doc = await env.col.findOne({ _id: job._id });
  assert.equal(partOf(doc, "od").company, "National");
  assert.equal(partOf(doc, "od").attempts, 0);
  assert.equal(partOf(doc, "od").requeue, undefined);
  assert.equal(doc.status, "pending");
});

it("single company: bundled motor part, then the Brisk PA left pending by the bundled run is bought by the Brisk runner", async () => {
  const env = newEnv("bundled");
  const job = await insertJob(env, [
    part("motor", "bundled", "Reliance"),
    part("pa", "brisk", "Brisk", { dependsOn: "motor", paCoverCompany: "Brisk" }),
  ]);
  env.behaviour.bundled = { success: true, briskCertificateSkipped: true };
  assert.deepEqual(await env.pass(), [`${job._id}:motor`]);
  assert.deepEqual(await env.pass(), [`${job._id}:pa`]);
  assert.deepEqual(env.calls.bundled, ["reliance"]);
  assert.equal(env.calls.brisk, 1);
  assert.equal((await env.col.findOne({ _id: job._id })).status, "completed");

  // and a second Brisk run on the same policy buys nothing (certificate is on the policy)
  const again = await runBriskPart(formData(), { policies: env.policies, policyId: job.captchaId, brisk: { shouldCreateBriskCertificate: () => ({ create: true }), createBriskCertificate: async () => { throw new Error("must not buy"); } }, log() {}, warn() {} });
  assert.equal(again.alreadyExisted, true);
});

/* -------------------------------- recovery -------------------------------- */

it("recovery resets ONLY processing parts (and applies a pending edit); legacy jobs are untouched", async () => {
  const env = newEnv("recover");
  const running = withPart(withPart(multiParts(), "od", { status: "processing", requeue: { company: "National", carriesPa: false, paCoverCompany: null, at: NOW } }), "tp", { nextRetryAt: new Date(NOW.getTime() + 600000) });
  const r1 = await insertJob(env, running, { status: "processing", rev: 4, lastHeartbeatAt: NOW, currentPart: { key: "od", bucket: "reliance" } });
  const legacy = { _id: "legacy1", status: "processing", captchaId: "lp", formData: formData(), startedAt: NOW, lastHeartbeatAt: NOW };
  await env.col.insertOne(legacy);

  const res = await runner.recoverPartsJobs(env.col, { now: new Date(NOW.getTime() + 1000) });
  assert.equal(res.modifiedCount, 1);

  const doc = await env.col.findOne({ _id: r1._id });
  assert.equal(doc.status, "pending");
  assert.equal(doc.currentPart, undefined);
  assert.equal(doc.lastHeartbeatAt, undefined);
  assert.ok(doc.rev > 4);
  assert.equal(partOf(doc, "od").status, "pending");
  assert.equal(partOf(doc, "od").company, "National", "the edit that arrived during the lost run is applied");
  assert.equal(partOf(doc, "od").requeue, undefined);
  assert.equal(partOf(doc, "tp").status, "pending");
  assert.equal(partOf(doc, "tp").nextRetryAt.getTime(), NOW.getTime() + 600000, "other parts are not touched");
  assert.equal((await env.col.findOne({ _id: "legacy1" })).status, "processing", "legacy documents are not reached by the parts update");

  // ...and the legacy update (server.js) reaches legacy documents only, exactly as before
  const parts2 = await insertJob(env, withPart(multiParts(), "od", { status: "processing" }), { status: "processing" });
  const legacyRes = await env.col.updateMany(
    { status: "processing", ...runner.LEGACY_JOBS },
    { $set: { status: "pending", recoveredAt: NOW }, $unset: { lastHeartbeatAt: "" } }
  );
  assert.equal(legacyRes.modifiedCount, 1);
  assert.equal((await env.col.findOne({ _id: "legacy1" })).status, "pending");
  assert.equal((await env.col.findOne({ _id: parts2._id })).status, "processing");
});

it("zombie filter: only a silent job is reclaimed, a beating one keeps its part", async () => {
  const env = newEnv("zombie");
  const silent = await insertJob(env, withPart(multiParts(), "od", { status: "processing" }), { status: "processing", lastHeartbeatAt: new Date(NOW.getTime() - 300000) });
  const alive = await insertJob(env, withPart(multiParts(), "od", { status: "processing" }), { status: "processing", lastHeartbeatAt: new Date(NOW.getTime() - 5000) });
  const cutoff = new Date(NOW.getTime() - 120000);
  await runner.recoverPartsJobs(env.col, { filter: { $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { lastHeartbeatAt: { $exists: false }, startedAt: { $lt: cutoff } }] }, now: NOW });
  assert.equal(partOf(await env.col.findOne({ _id: silent._id }), "od").status, "pending");
  assert.equal(partOf(await env.col.findOne({ _id: alive._id }), "od").status, "processing");
});

it("startup: pending parts waiting out a backoff become due now; nothing else changes", async () => {
  const env = newEnv("backoffclear");
  const parts = withPart(withPart(multiParts(), "od", { nextRetryAt: new Date(NOW.getTime() + 300000), attempts: 2 }), "tp", { status: "completed" });
  const job = await insertJob(env, parts, { nextRetryAt: new Date(NOW.getTime() + 300000) });
  const res = await runner.clearPartsBackoff(env.col, { now: NOW });
  assert.equal(res.modifiedCount, 1);
  const doc = await env.col.findOne({ _id: job._id });
  assert.equal(partOf(doc, "od").nextRetryAt, null);
  assert.equal(partOf(doc, "od").attempts, 2);
  assert.equal(partOf(doc, "tp").status, "completed");
  assert.equal(doc.nextRetryAt.getTime(), NOW.getTime());
  assert.deepEqual(await env.pass(), [`${job._id}:od`]);
});

/* ------------------------------- change stream ----------------------------- */

it("queue wake-up: fires for insert and for an update that re-pends / reschedules a job, not for claims or heartbeats", async () => {
  const env = newEnv("stream");
  const events = [];
  const stream = env.col.watch(runner.QUEUE_WAKE_PIPELINE);
  stream.on("change", (c) => events.push(c.operationType));
  await sleep(500);

  const job = await insertJob(env, multiParts());
  await sleep(500);
  assert.deepEqual(events, ["insert"]);

  const claimed = await runner.claimPart(env.col, job, partOf(job, "od"));
  await env.col.updateOne({ _id: job._id, status: "processing" }, { $set: { lastHeartbeatAt: new Date() } });
  await sleep(500);
  assert.deepEqual(events, ["insert"], "claim and heartbeat do not wake the queue");

  await runner.writePartOutcome({ collection: env.col, jobId: job._id, key: "od", outcome: { type: "success" }, now: NOW, logger: silentLogger });
  await sleep(500);
  assert.deepEqual(events, ["insert", "update"], "the job going back to pending wakes it");

  await env.col.updateOne({ _id: job._id }, { $set: { lastError: "x" } });
  await sleep(400);
  assert.equal(events.length, 2, "unrelated updates do not");
  await stream.close();
  assert.ok(claimed);
});

/* -------------------------------- recordings ------------------------------- */

it("recordings: a part replaces only its own entry and deletes only its own old video; legacy keeps one", async () => {
  const env = newEnv("rec");
  const job = await insertJob(env, multiParts(), {
    recordings: [
      { part: "od", s3Key: "recordings/reliance/p_od-old.mp4" },
      { part: "tp", s3Key: "recordings/national/p_tp.mp4" },
    ],
  });
  const deleted = [];
  const opts = (s3Key) => ({ entry: { attemptNumber: 2, s3Key }, partKey: "od", s3Key, deleteOld: async (k) => deleted.push(k), warn() {} });

  await saveRecordingEntry(env.col, job._id, opts("recordings/reliance/p_od-new.mp4"));
  await saveRecordingEntry(env.col, job._id, opts("recordings/reliance/p_od-new.mp4")); // same key again: no growth
  const doc = await env.col.findOne({ _id: job._id });
  assert.deepEqual(deleted, ["recordings/reliance/p_od-old.mp4"], "only this part's older video is deleted");
  assert.equal(doc.recordings.length, 2);
  assert.equal(doc.recordings.find((r) => r.part === "tp").s3Key, "recordings/national/p_tp.mp4");
  assert.equal(doc.recordings.find((r) => r.part === "od").s3Key, "recordings/reliance/p_od-new.mp4");

  const legacy = await insertJob(env, [part("od", "portal", "Reliance")], { recordings: [{ s3Key: "a.mp4" }, { s3Key: "b.mp4" }] });
  const gone = [];
  await saveRecordingEntry(env.col, legacy._id, { entry: { s3Key: "c.mp4" }, s3Key: "c.mp4", deleteOld: async (k) => gone.push(k), warn() {} });
  assert.deepEqual(gone, ["a.mp4", "b.mp4"]);
  assert.deepEqual((await env.col.findOne({ _id: legacy._id })).recordings, [{ s3Key: "c.mp4" }]);
});
