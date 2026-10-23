// Run with: node --require ./test/support/noRealWorld.js --test test/existingTpGate.test.js
//
// The owner's rule (2026-10-22): Reliance OD never starts without the customer's existing TP policy details —
// number, insurer, start date, end date. The gate stops the part before any login / browser, without a retry loop,
// and reads the details from the POLICY (they are often saved after the job was queued).
const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../lib/jobPartsCore");
const runner = require("../lib/partRunner");
const gate = require("../lib/existingTpGate");
const { NOW, part, multiParts, singleParts, jobDoc, partOf, silentLogger, fakeCollection, withPart } = require("./helpers");

const TP = {
  existingTpPolicyNumber: "KSH/TP/12345",
  existingTpInsurer: "KSHEMA",
  existingTpStartDate: new Date("2026-10-01T18:30:00.000Z"), // 02 Oct 2026 in India
  existingTpEndDate: new Date("2031-10-01T18:30:00.000Z"),
};
const NO_TP = { existingTpPolicyNumber: "", existingTpInsurer: "", existingTpStartDate: "", existingTpEndDate: "" };

const claimedFrom = (job, key) => ({
  ...job,
  status: "processing",
  rev: (job.rev || 0) + 1,
  parts: withPart(job.parts, key, { status: "processing", startedAt: NOW }),
  currentPart: { key, company: partOf(job, key).company, kind: partOf(job, key).kind, bucket: core.capacityBucket(partOf(job, key)), attempt: 1, startedAt: NOW },
});

function makeDeps(collection, policyDoc) {
  const calls = { logins: 0, handlerData: null };
  const deps = {
    collection,
    policies: {
      // like MongoDB: only the projected fields come back (a field left out of the projection is never read)
      async findOne(filter, opts = {}) {
        if (!policyDoc || !opts.projection) return policyDoc;
        const keep = Object.keys(opts.projection).filter((k) => opts.projection[k]);
        return Object.fromEntries(Object.entries(policyDoc).filter(([k]) => k === "_id" || keep.includes(k)));
      },
      async updateOne() {
        return { matchedCount: 1 };
      },
    },
    hydrateJobFormData: async (job) => job,
    resolveCredentials: async () => {
      calls.logins++;
      return { creds: { username: "u", password: "p", loginUrl: "https://portal", _id: "c1" }, source: "user", matchedBy: "user-id" };
    },
    dispatchBundled: async () => ({ run: Promise.resolve({ success: true }) }),
    resolveMultiCompanyHandler: () => async (data) => {
      calls.handlerData = data;
      return { success: true };
    },
    assertMultiCompanyEnabled: () => {},
    runBriskPart: async () => ({ success: true }),
    scheduleWakeup: () => {},
    now: () => NOW,
    logger: { ...silentLogger, warn: () => {} },
    jobTimeoutMs: 2000,
    companyLabel: (c) => c,
  };
  return { deps, calls };
}

const runOd = async ({ jobData = {}, policy = { _id: "policy1" }, parts = multiParts(), key = "od" } = {}) => {
  const job = jobDoc(parts);
  job.formData = { ...job.formData, ...jobData };
  const claimed = claimedFrom(job, key);
  const col = fakeCollection(claimed);
  const { deps, calls } = makeDeps(col, policy);
  await runner.runPartJob(deps, claimed);
  return { doc: col.state.doc, calls, key };
};

test("Reliance OD with no TP details: stopped before any login, no retry, the reason names what is missing", async () => {
  const { doc, calls } = await runOd({ jobData: NO_TP });
  const od = partOf(doc, "od");
  assert.equal(calls.logins, 0, "no portal login");
  assert.equal(calls.handlerData, null, "the Reliance form never ran");
  assert.equal(od.status, "failed_login_form");
  assert.equal(od.stopped, true);
  assert.equal(od.nextRetryAt, null, "no automatic retry loop");
  assert.equal(od.stage, "waiting-tp-details");
  assert.equal(od.lastErrorCode, "E101");
  assert.match(od.lastError, /TP policy number, TP insurer, TP start date, TP end date/);
  assert.match(od.lastError, /Edit then TP policy details/);
  assert.doesNotMatch(od.lastError, /:/, "operator sentences carry no colon");
  assert.equal(partOf(doc, "tp").status, "pending", "the TP part is untouched");
});

for (const [field, label] of gate.TP_FIELDS) {
  test(`one field missing (${label}) is enough to stop Reliance OD`, async () => {
    const policy = { _id: "policy1", ...TP, [field]: "" };
    const { doc, calls } = await runOd({ jobData: NO_TP, policy });
    assert.equal(calls.logins, 0);
    assert.equal(partOf(doc, "od").stage, "waiting-tp-details");
    assert.match(partOf(doc, "od").lastError, new RegExp(`missing ${label}\\)`));
  });
}

test("details saved on the POLICY after the job was queued: the OD runs, with the policy's values in India time", async () => {
  const { doc, calls } = await runOd({ jobData: NO_TP, policy: { _id: "policy1", ...TP } });
  assert.equal(calls.logins, 1);
  assert.ok(calls.handlerData, "the Reliance OD handler ran");
  assert.equal(calls.handlerData.existingTpPolicyNumber, "KSH/TP/12345");
  assert.equal(calls.handlerData.existingTpInsurer, "KSHEMA");
  assert.equal(calls.handlerData.existingTpStartDate, "02-10-2026");
  assert.equal(calls.handlerData.existingTpEndDate, "02-10-2031");
  assert.equal(partOf(doc, "od").status, "completed");
});

test("the policy's values win over a stale copy in the job", async () => {
  const stale = { existingTpPolicyNumber: "OLD-1", existingTpInsurer: "National", existingTpStartDate: "01-01-2020", existingTpEndDate: "01-01-2025" };
  const { calls } = await runOd({ jobData: stale, policy: { _id: "policy1", ...TP } });
  assert.equal(calls.handlerData.existingTpPolicyNumber, "KSH/TP/12345");
  assert.equal(calls.handlerData.existingTpInsurer, "KSHEMA");
});

test("the TP part, a bundled Reliance policy and a non-Reliance OD part are not gated", async () => {
  const tp = await runOd({ jobData: NO_TP, key: "tp" });
  assert.equal(tp.calls.logins, 1, "TP part runs without TP details");

  const bundled = await runOd({ jobData: NO_TP, parts: singleParts(), key: "motor" });
  assert.equal(bundled.calls.logins, 1, "the full-company flow is untouched");

  const nationalOd = [part("od", "portal", "National"), part("tp", "portal", "KSHEMA")];
  const other = await runOd({ jobData: { ...NO_TP, Companyname: "national" }, parts: nationalOd });
  assert.equal(other.calls.logins, 1, "only Reliance OD waits");
});

test("missingTpDetails / freshTpDetails directly", () => {
  const od = part("od", "portal", "Reliance");
  assert.equal(gate.missingTpDetails(od, { existingTpPolicyNumber: "X", existingTpInsurer: "KSHEMA", existingTpStartDate: "01-01-2026", existingTpEndDate: "01-01-2031" }), null);
  assert.equal(gate.missingTpDetails(od, { existingTpPolicyNumber: "   " }).type, "stopped", "spaces are not a number");
  assert.equal(gate.missingTpDetails(part("od", "bundled", "Reliance"), {}), null);
  assert.deepEqual(gate.freshTpDetails(null), {});
  assert.deepEqual(gate.freshTpDetails({ existingTpPolicyNumber: " A1 ", existingTpEndDate: null }), { existingTpPolicyNumber: "A1" });
});
