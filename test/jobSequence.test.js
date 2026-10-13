// Run with: node --test test/*.test.js
//
// A policy sold by two insurers in the old two-job shape has an OD job and a TP job. The TP job is bought first; the OD
// job waits for it (lib/jobSequence.js). No database: the collection is a stand-in with the one call the gate makes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  holdOdJobsUntilTpDone,
  splitByTpOrder,
  isOdWaitsForTpEnabled,
  isLegacyOdJob,
  policyTypeOf,
} = require("../lib/jobSequence");

const silent = { log() {}, warn() {}, error() {} };

let seq = 0;
const job = (over = {}) => ({
  _id: `job${++seq}`,
  captchaId: "policyA",
  policyType: null,
  status: "pending",
  formData: { firstName: "Asha", Companyname: "reliance" },
  ...over,
});
const od = (over = {}) => job({ policyType: "od", formData: { firstName: "Asha", Companyname: "reliance" }, ...over });
const tp = (over = {}) => job({ policyType: "tp", formData: { firstName: "Asha", Companyname: "national" }, ...over });

/** A collection with only `find(...).toArray()`; remembers the query it was asked. */
const fakeCollection = (docs, { fail = false } = {}) => {
  const calls = [];
  return {
    calls,
    find(query, options) {
      calls.push({ query, options });
      return {
        async toArray() {
          if (fail) throw new Error("connection reset");
          const ids = (query.captchaId && query.captchaId.$in) || [];
          return docs.filter((d) => ids.includes(d.captchaId) && d.policyType === query.policyType);
        },
      };
    },
  };
};

const idsOf = (list) => list.map((j) => j._id);

/* ------------------------------ the decision ------------------------------ */

test("an OD job waits for its TP job in every state except bought", () => {
  const waitingStates = ["pending", "processing", "hold", "failed_login_form", "failed_post_submission", "failed_validation", "failed_duplicate"];
  for (const status of waitingStates) {
    const o = od();
    const { ready, waiting } = splitByTpOrder([o], [tp({ status })]);
    assert.deepEqual(idsOf(ready), [], `${status}: OD must not start`);
    assert.equal(waiting.length, 1, `${status}: OD waits`);
    assert.equal(waiting[0].job, o);
    assert.equal(waiting[0].tp.status, status);
  }
});

test("an OD job starts once its TP job is bought — completed or completed_with_errors", () => {
  for (const status of ["completed", "completed_with_errors"]) {
    const o = od();
    const { ready, waiting } = splitByTpOrder([o], [tp({ status })]);
    assert.deepEqual(idsOf(ready), [o._id], status);
    assert.equal(waiting.length, 0);
  }
});

test("no TP job (single company, or TP deselected) or a cancelled one: nothing to wait for", () => {
  const o = od();
  assert.deepEqual(idsOf(splitByTpOrder([o], []).ready), [o._id]);
  assert.deepEqual(idsOf(splitByTpOrder([o], [tp({ status: "cancelled" })]).ready), [o._id]);
  assert.deepEqual(idsOf(splitByTpOrder([o], undefined).ready), [o._id]);
});

test("only the OD job of THAT policy waits for THAT policy's TP job", () => {
  const odA = od({ captchaId: "policyA" });
  const odB = od({ captchaId: "policyB" });
  const odC = od({ captchaId: "policyC" });
  const tpA = tp({ captchaId: "policyA", status: "processing" });
  const tpB = tp({ captchaId: "policyB", status: "completed" });
  // policyC has no TP job at all
  const { ready, waiting } = splitByTpOrder([odA, odB, odC], [tpA, tpB]);
  assert.deepEqual(idsOf(ready), [odB._id, odC._id]);
  assert.deepEqual(waiting.map((w) => w.job._id), [odA._id]);
});

test("the TP job itself, a bundled job and a job with parts are never held", () => {
  const tpJob = tp({ status: "pending" });
  const bundled = job({ policyType: null, status: "pending" });
  const partsJob = job({
    policyType: null,
    parts: [{ key: "od", kind: "portal", status: "pending" }, { key: "tp", kind: "portal", status: "pending" }],
  });
  // even an OD-typed document that carries parts is the new shape: dependsOn orders it, not this gate
  const odWithParts = od({ parts: [{ key: "od", kind: "portal", status: "pending" }] });
  const input = [tpJob, bundled, partsJob, odWithParts];
  const { ready, waiting } = splitByTpOrder(input, [tp({ status: "failed_login_form" })]);
  assert.deepEqual(idsOf(ready), idsOf(input));
  assert.equal(waiting.length, 0);
});

test("order is kept, and the policyType is read from wherever the backend or the automation put it", () => {
  const a = job({ policyType: null, formData: { policyType: "od", Companyname: "reliance" } });
  const b = job({ policyType: null, metadata: { policyType: "OD" } });
  const c = tp();
  const d = job();
  assert.equal(policyTypeOf(a), "od");
  assert.equal(policyTypeOf(b), "od");
  assert.equal(isLegacyOdJob(a), true);
  assert.equal(isLegacyOdJob(c), false);
  assert.equal(isLegacyOdJob({ ...a, captchaId: undefined }), false, "no policy id: cannot be matched, so not held");

  const { ready, waiting } = splitByTpOrder([d, a, c, b], [tp({ status: "pending" })]);
  assert.deepEqual(idsOf(ready), [d._id, c._id]);
  assert.deepEqual(waiting.map((w) => w.job._id), [a._id, b._id]);
});

/* ------------------------------ the queue's gate ------------------------------ */

test("gate: one query for all OD candidates, asking for the TP jobs of exactly those policies", async () => {
  const odA = od({ captchaId: "policyA" });
  const odB = od({ captchaId: "policyB" });
  const odA2 = od({ captchaId: "policyA" }); // a second OD document of the same policy: one id in the query
  const other = job();
  const collection = fakeCollection([tp({ captchaId: "policyA", status: "processing" })]);

  const { ready, waiting } = await holdOdJobsUntilTpDone(collection, [odA, other, odB, odA2], { enabled: true, logger: silent });

  assert.equal(collection.calls.length, 1);
  assert.deepEqual(collection.calls[0].query, { captchaId: { $in: ["policyA", "policyB"] }, policyType: "tp" });
  assert.deepEqual(idsOf(ready), [other._id, odB._id]);
  assert.deepEqual(waiting.map((w) => w.job._id), [odA._id, odA2._id]);
});

test("gate: no OD candidate -> no query at all", async () => {
  const collection = fakeCollection([]);
  const candidates = [tp(), job()];
  const { ready, waiting } = await holdOdJobsUntilTpDone(collection, candidates, { enabled: true, logger: silent });
  assert.equal(collection.calls.length, 0);
  assert.deepEqual(ready, candidates);
  assert.deepEqual(waiting, []);
});

test("gate: the TP job completing releases the OD job on the next pass", async () => {
  const o = od();
  const docs = [tp({ status: "processing" })];
  const collection = fakeCollection(docs);

  let r = await holdOdJobsUntilTpDone(collection, [o], { enabled: true, logger: silent });
  assert.deepEqual(r.ready, []);
  assert.equal(r.waiting.length, 1);

  docs[0].status = "completed";
  r = await holdOdJobsUntilTpDone(collection, [o], { enabled: true, logger: silent });
  assert.deepEqual(idsOf(r.ready), [o._id]);
  assert.equal(r.waiting.length, 0);
});

test("gate: if the TP jobs cannot be read the OD jobs wait (never bought blind); other jobs go on", async () => {
  const o = od();
  const other = job();
  const warnings = [];
  const collection = fakeCollection([], { fail: true });
  const { ready, waiting } = await holdOdJobsUntilTpDone(collection, [o, other], {
    enabled: true,
    logger: { ...silent, warn: (m) => warnings.push(m) },
  });
  assert.deepEqual(idsOf(ready), [other._id]);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].job, o);
  assert.equal(waiting[0].tp, null);
  assert.match(warnings.join("\n"), /could not look up the TP jobs/);
});

test("switch: OD_WAITS_FOR_TP is on unless it is explicitly false / 0 / no / off", async () => {
  for (const v of [undefined, "", "true", "1", "yes", "on", "anything"]) {
    assert.equal(isOdWaitsForTpEnabled({ OD_WAITS_FOR_TP: v }), true, JSON.stringify(v));
  }
  for (const v of ["false", "FALSE", "0", "no", "off", " Off "]) {
    assert.equal(isOdWaitsForTpEnabled({ OD_WAITS_FOR_TP: v }), false, JSON.stringify(v));
  }

  // off: the old behaviour, and no query
  const collection = fakeCollection([tp({ status: "failed_login_form" })]);
  const o = od();
  const r = await holdOdJobsUntilTpDone(collection, [o], { enabled: false, logger: silent });
  assert.deepEqual(idsOf(r.ready), [o._id]);
  assert.equal(collection.calls.length, 0);
});

/* ------------------------------ wired into the queue ------------------------------ */

test("server.js applies the gate to the candidates BEFORE the windows are planned", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const fetched = source.indexOf(".find({\n        status: JOB_STATUS.PENDING,");
  const gate = source.indexOf("jobSequence.holdOdJobsUntilTpDone(");
  const planned = source.indexOf("partRunner.planClaims(");
  assert.ok(fetched > 0, "candidate query not found");
  assert.ok(gate > fetched, "the gate must come after the candidates are fetched");
  assert.ok(planned > gate, "the gate must come before planClaims, or a held OD job would still take a window");

  // planClaims is handed the gate's output, not the raw candidates
  const planCall = source.slice(planned, planned + 200);
  assert.match(planCall, /orderedCandidates/);
  assert.equal(/planClaims\(\s*candidateJobs/.test(source), false, "planClaims must not get the raw candidate list");
});
