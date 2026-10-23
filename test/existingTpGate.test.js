// Run with: node --require ./test/support/noRealWorld.js --test test/existingTpGate.test.js
//
// The owner's rule (2026-10-22): Reliance OD never starts without the customer's existing TP policy details —
// number, insurer, start date, end date. The gate stops the part before any login / browser, without a retry loop,
// and reads the details from the POLICY (they are often saved after the job was queued).
// 2026-10-23: a TWO-INSURER policy needs no typed dates — a date that is empty is worked out (start = today in India, end = the
// year selection after it, the day before the anniversary); OD only (one insurer) still needs all four.
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
  const calls = { logins: 0, handlerData: null, logs: [] };
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
    logger: { ...silentLogger, warn: () => {}, log: (line) => calls.logs.push(String(line)) },
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
  assert.match(od.lastError, /missing TP policy number, TP insurer\)/, "two insurers: only what cannot be worked out is missing");
  assert.doesNotMatch(od.lastError, /TP start date|TP end date/);
  assert.match(od.lastError, /Edit then TP policy details/);
  assert.doesNotMatch(od.lastError, /:/, "operator sentences carry no colon");
  assert.equal(partOf(doc, "tp").status, "pending", "the TP part is untouched");
});

for (const [field, label] of gate.TP_FIELDS.filter(([f]) => !/Date$/.test(f))) {
  test(`one field missing (${label}) is enough to stop Reliance OD`, async () => {
    const policy = { _id: "policy1", ...TP, [field]: "" };
    const { doc, calls } = await runOd({ jobData: NO_TP, policy });
    assert.equal(calls.logins, 0);
    assert.equal(partOf(doc, "od").stage, "waiting-tp-details");
    assert.match(partOf(doc, "od").lastError, new RegExp(`missing ${label}\\)`));
  });
}

// OD only: the dates are typed on the form and stay required — nothing is worked out
for (const [field, label] of gate.TP_FIELDS.filter(([f]) => /Date$/.test(f))) {
  test(`OD only (one insurer): a missing ${label} still stops Reliance OD, nothing is worked out`, async () => {
    const policy = { _id: "policy1", ...TP, [field]: "" };
    const odOnly = [part("od", "portal", "Reliance")];
    const { doc, calls } = await runOd({
      jobData: { ...NO_TP, settings: { isMultipleCompany: false, ODCompany: "Reliance", TPCompany: "" }, coverage: "od" },
      policy,
      parts: odOnly,
    });
    assert.equal(calls.logins, 0);
    assert.equal(partOf(doc, "od").stage, "waiting-tp-details");
    assert.match(partOf(doc, "od").lastError, new RegExp(`missing ${label}\\)`));
  });
}

test("two insurers, both dates empty: the OD runs with start = today (India) and end = 1 year after it, the day before the anniversary", async () => {
  const policy = { _id: "policy1", ...TP, existingTpStartDate: "", existingTpEndDate: "" };
  const { doc, calls } = await runOd({ jobData: NO_TP, policy });
  assert.equal(calls.logins, 1);
  assert.equal(calls.handlerData.existingTpPolicyNumber, "KSH/TP/12345");
  assert.equal(calls.handlerData.existingTpStartDate, "30-09-2026", "NOW is 30 Sep 2026 15:30 in India");
  assert.equal(calls.handlerData.existingTpEndDate, "29-09-2027");
  assert.equal(partOf(doc, "od").status, "completed");
  const said = calls.logs.filter((l) => /dates not entered/.test(l));
  assert.equal(said.length, 1, "the run says what it worked out, once");
  assert.match(said[0], /Existing TP policy dates not entered, so they are worked out - start 30-09-2026 \(today\), end 29-09-2027 \(1 year selected\)/);
});

test("dates that are entered are not reported as worked out", async () => {
  const { calls } = await runOd({ jobData: NO_TP, policy: { _id: "policy1", ...TP } });
  assert.equal(calls.logs.filter((l) => /dates not entered/.test(l)).length, 0);
  const only = await runOd({ jobData: NO_TP, policy: { _id: "policy1", ...TP, existingTpEndDate: "", paCoverYears: 5 } });
  const line = only.calls.logs.filter((l) => /dates not entered/.test(l));
  assert.equal(line.length, 1);
  assert.match(line[0], /worked out - end 01-10-2031 \(5 years selected\)$/);
  assert.doesNotMatch(line[0], /start/);
});

test("the year selection (paCoverYears of the policy) sets the end: 5 years = the day before the 5th anniversary; none or a bad one = 1 year", async () => {
  const base = { _id: "policy1", ...TP, existingTpStartDate: "", existingTpEndDate: "" };
  for (const [years, end] of [[5, "29-09-2031"], [3, "29-09-2029"], [undefined, "29-09-2027"], [0, "29-09-2027"], [9, "29-09-2027"], ["2", "29-09-2028"]]) {
    const { calls } = await runOd({ jobData: NO_TP, policy: { ...base, paCoverYears: years } });
    assert.equal(calls.handlerData.existingTpEndDate, end, `years ${years}`);
  }
});

test("only the date that is EMPTY is worked out: a given start keeps its value and the end follows it; a given end keeps its value", async () => {
  let r = await runOd({ jobData: NO_TP, policy: { _id: "policy1", ...TP, existingTpEndDate: "", paCoverYears: 5 } });
  assert.equal(r.calls.handlerData.existingTpStartDate, "02-10-2026", "the policy's own start date");
  assert.equal(r.calls.handlerData.existingTpEndDate, "01-10-2031", "5 years from THAT start");

  r = await runOd({ jobData: NO_TP, policy: { _id: "policy1", ...TP, existingTpStartDate: "" } });
  assert.equal(r.calls.handlerData.existingTpStartDate, "30-09-2026");
  assert.equal(r.calls.handlerData.existingTpEndDate, "02-10-2031", "the policy's own end date is not touched");
});

test("with the number missing the OD still waits — and names only the number (the dates are not the problem)", async () => {
  const { doc, calls } = await runOd({ jobData: NO_TP, policy: { _id: "policy1", ...TP, existingTpPolicyNumber: "", existingTpStartDate: "", existingTpEndDate: "" } });
  assert.equal(calls.logins, 0);
  assert.match(partOf(doc, "od").lastError, /missing TP policy number\)/);
});

test("defaultTpDates directly: leap day, the India day boundary, a start that is not a date, other parts", () => {
  const od = part("od", "portal", "Reliance");
  const two = (extra = {}) => ({ settings: { isMultipleCompany: true }, existingTpStartDate: "", existingTpEndDate: "", ...extra });
  // 29 Feb 2028 + 1 year -> the policy ends 28 Feb 2029; + 4 years (a leap year again) -> 28 Feb 2032
  assert.deepEqual(gate.defaultTpDates(od, two({ existingTpStartDate: "29-02-2028" }), { years: 1 }).fields, { existingTpEndDate: "28-02-2029" });
  assert.deepEqual(gate.defaultTpDates(od, two({ existingTpStartDate: "29-02-2028" }), { years: 4 }).fields, { existingTpEndDate: "28-02-2032" });
  assert.deepEqual(gate.defaultTpDates(od, two({ existingTpStartDate: "01-01-2027" }), { years: 1 }).fields, { existingTpEndDate: "31-12-2027" });
  // 20:00 UTC on 30 Sep is already 1 Oct in India
  assert.deepEqual(gate.defaultTpDates(od, two(), { years: 1, now: new Date("2026-09-30T20:00:00Z") }).fields, { existingTpStartDate: "01-10-2026", existingTpEndDate: "30-09-2027" });
  // a start that is not a date is the OD form's own error to report, not replaced
  assert.equal(gate.defaultTpDates(od, two({ existingTpStartDate: "Invalid date" }), { years: 1 }), null);
  assert.equal(gate.defaultTpDates(od, two({ existingTpStartDate: "31-02-2027" }), { years: 1 }), null);
  // both given, one insurer, the TP part, a bundled part, no routing: nothing is worked out
  assert.equal(gate.defaultTpDates(od, two({ existingTpStartDate: "01-01-2027", existingTpEndDate: "31-12-2027" }), {}), null);
  assert.equal(gate.defaultTpDates(od, { ...two(), settings: { isMultipleCompany: false } }, {}), null);
  assert.equal(gate.defaultTpDates(od, { existingTpStartDate: "", existingTpEndDate: "" }, {}), null);
  assert.equal(gate.defaultTpDates(part("tp", "portal", "KSHEMA"), two(), {}), null);
  assert.equal(gate.defaultTpDates(part("od", "portal", "National"), { ...two(), Companyname: "national" }, {}), null);
  assert.equal(gate.defaultTpDates(part("motor", "bundled", "Reliance"), two(), {}), null);
  // the years: 1 to 5 only
  assert.deepEqual([undefined, null, "", 0, 6, 1.5, "x", 1, "5", 3].map(gate.tpYearsOf), [1, 1, 1, 1, 1, 1, 1, 1, 5, 3]);
});

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
