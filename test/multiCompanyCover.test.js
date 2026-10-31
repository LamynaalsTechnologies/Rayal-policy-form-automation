// Run with: node --require ./test/support/noRealWorld.js --test test/multiCompanyCover.test.js
//
// PA Cover and the nominee for a policy sold by TWO insurers (Reliance OD + a KSHEMA / National TP) — who buys it, and who is not
// touched (the owner, 2026-10-23): "the PA is done only with the TP company that is selected; if Brisk is selected do it with Brisk
// and do not touch the other." The sibling of standaloneCover.test.js, which walks the same chain for TP only.
//
// The chain under test: the parts the backend builds (RayalBrokers-backend/test/paRouting.test.js asserts the SAME shapes written
// below, with the real buildJobParts) -> lib/partRunner.buildPartFormData -> what each handler reads about PA (KSHEMA: the checkbox,
// the reason, the nominee decision; National: portalPaTerm; Brisk: shouldCreateBriskCertificate) -> the Brisk part's own checks.
// No browser, no database, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const core = require("../lib/jobPartsCore");
const { buildPartFormData, routingConflict } = require("../lib/partRunner");
const { part, NOW } = require("./helpers");
const { portalPaTerm } = require("../multiCompany/tpCompany/nationalTP/tpPa");
const { PA_COVER_FIELDS, isCompanyPaCover } = require("../multiCompany/tpCompany/kshemaTP/kshemaTPQuoteForm");
const { shouldCreateBriskCertificate } = require("../briskCertificate");
const { runBriskPart, briskNomineeProblem } = require("../lib/briskPartRunner");
const { paRoutingProblem } = require("../lib/paRouting");

const fieldValue = (key, data) => PA_COVER_FIELDS.find((f) => f.key === key).value(data);
const fieldRequired = (key, data) => {
  const f = PA_COVER_FIELDS.find((x) => x.key === key);
  return typeof f.required === "function" ? f.required(data) : f.required;
};

/** The parts the backend builds for Reliance OD + `tp`: TP first, then the OD, then a Brisk PA. */
const partsFor = ({ tp, pa }) => {
  const parts = [part("od", "portal", "Reliance", { dependsOn: "tp" }), part("tp", "portal", tp, pa === "Company" ? { carriesPa: true, paCoverCompany: "Company" } : {})];
  if (pa === "Brisk") parts.push(part("pa", "brisk", "Brisk", { dependsOn: "od", paCoverCompany: "Brisk" }));
  if (pa === "Company") parts.push(part("pa", "withPart", tp, { mirrors: "tp", paCoverCompany: "Company" }));
  return parts;
};
const shape = (parts) =>
  parts
    .map((p) => `${p.key}${p.kind === "brisk" ? "(brisk)" : p.kind === "withPart" ? "(with " + p.mirrors + ")" : ""}${p.carriesPa ? "[PA]" : ""}${p.dependsOn ? "<-" + p.dependsOn : ""}`)
    .join(" ");

/** The job of a two-insurer policy: `pa` = "off" | "Brisk" | "Company" (PA bought with the TP company). */
const twoInsurerJob = ({ tp, pa, years = 1, nominee = {} }) => {
  const parts = partsFor({ tp, pa });
  return {
    _id: "job1",
    captchaId: "policy1",
    status: "pending",
    parts,
    formData: {
      firstName: "Asha",
      lastName: "Kumar",
      Companyname: "reliance",
      coverage: "both",
      settings: { isMultipleCompany: true, ODCompany: "Reliance", TPCompany: tp, PACompany: pa === "off" ? "" : pa === "Brisk" ? "Brisk" : tp },
      paCover: pa !== "off",
      paCoverCompany: pa === "Company" ? "Company" : "Brisk", // the model's default stays "Brisk" with PA off
      paCoverYears: years,
      notPaCoverReason: "",
      nomineeName: "Meena",
      nomineeRelation: "wife",
      nomineeGender: "female",
      nomineeAge: 40,
      ...nominee,
    },
  };
};
const dataOf = (job, key) => buildPartFormData(job, job.parts.find((p) => p.key === key));

/* ------------------------------------------ the shapes (same as the backend's) ------------------------------------------ */

test("the parts of a two-insurer policy: PA through Brisk = a Brisk part that runs last; through the TP company = the TP carries it; off = none", () => {
  for (const tp of ["KSHEMA", "National"]) {
    assert.equal(shape(partsFor({ tp, pa: "Brisk" })), "od<-tp tp pa(brisk)<-od");
    assert.equal(shape(partsFor({ tp, pa: "Company" })), "od<-tp tp[PA] pa(with tp)");
    assert.equal(shape(partsFor({ tp, pa: "off" })), "od<-tp tp");
  }
});

/* ------------------------------------------------- the OD part: never PA ------------------------------------------------- */

test("the Reliance OD part never carries PA, whatever the PA company is", () => {
  for (const tp of ["KSHEMA", "National"]) {
    for (const pa of ["off", "Brisk", "Company"]) {
      const data = dataOf(twoInsurerJob({ tp, pa }), "od");
      assert.equal(data.paCover, false, `${tp} / ${pa}`);
      assert.equal(data.policyType, "od");
    }
  }
});

/* --------------------------------------------------- KSHEMA as the TP --------------------------------------------------- */

test("KSHEMA TP, PA through Brisk: the portal's PA is unticked with a reason, no nominee at KSHEMA; Brisk is its own part", () => {
  const job = twoInsurerJob({ tp: "KSHEMA", pa: "Brisk" });
  const data = dataOf(job, "tp");
  assert.equal(data.paCover, false);
  assert.equal(fieldValue("paCover", data), false, "the PA checkbox is unticked");
  assert.equal(fieldRequired("notPaCoverReason", data), true, "the reason is asked");
  assert.ok(fieldValue("notPaCoverReason", data), "and has a value");
  assert.equal(isCompanyPaCover(data), false, "no nominee entry at KSHEMA");
  assert.equal(shouldCreateBriskCertificate(data).create, false, "the TP part never creates a Brisk certificate");
});

test("KSHEMA TP, PA through KSHEMA: PA ticked, the year as picked (1 to 5), no reason, a nominee entry; no Brisk part", () => {
  for (const years of [1, 3, 5]) {
    const job = twoInsurerJob({ tp: "KSHEMA", pa: "Company", years });
    const data = dataOf(job, "tp");
    assert.equal(data.paCover, true);
    assert.equal(data.paCoverCompany, "Company");
    assert.equal(fieldValue("paCover", data), true);
    assert.equal(fieldValue("paCoverYear", data), String(years));
    assert.equal(fieldRequired("notPaCoverReason", data), false);
    assert.equal(isCompanyPaCover(data), true, "KSHEMA's nominee is entered");
    assert.equal(data.nomineeName, "Meena");
    assert.equal(shouldCreateBriskCertificate(data).create, false, "PA is with KSHEMA: Brisk is not touched");
  }
  assert.ok(!partsFor({ tp: "KSHEMA", pa: "Company" }).some((p) => p.kind === "brisk"), "no Brisk part at all");
});

test("KSHEMA TP, PA off: unticked with a reason, no year, no nominee, no Brisk part", () => {
  const data = dataOf(twoInsurerJob({ tp: "KSHEMA", pa: "off" }), "tp");
  assert.equal(data.paCover, false);
  assert.equal(fieldValue("paCover", data), false);
  assert.equal(fieldRequired("notPaCoverReason", data), true);
  assert.equal(isCompanyPaCover(data), false);
});

/* --------------------------------------------------- National as the TP --------------------------------------------------- */

test("National TP, PA through Brisk: the portal stays on 'No' (Brisk's certificate is the cover); Brisk is its own part", () => {
  for (const years of [1, 5, undefined]) {
    const data = dataOf(twoInsurerJob({ tp: "National", pa: "Brisk", years }), "tp");
    assert.equal(data.paCover, false);
    assert.equal(portalPaTerm(data), 0, `year ${years}`);
    assert.equal(shouldCreateBriskCertificate(data).create, false);
  }
});

test("National TP, PA through National: the portal gets exactly the year picked (1 or 5); anything else is unusable, never guessed", () => {
  assert.equal(portalPaTerm(dataOf(twoInsurerJob({ tp: "National", pa: "Company", years: 1 }), "tp")), 1);
  assert.equal(portalPaTerm(dataOf(twoInsurerJob({ tp: "National", pa: "Company", years: 5 }), "tp")), 5);
  assert.equal(portalPaTerm(dataOf(twoInsurerJob({ tp: "National", pa: "Company", years: 3 }), "tp")), null);
  assert.equal(shouldCreateBriskCertificate(dataOf(twoInsurerJob({ tp: "National", pa: "Company" }), "tp")).create, false, "Brisk is not touched");
});

test("National TP, PA off: 'No', whatever year is saved", () => {
  for (const years of [1, 5, 3, "", undefined]) {
    assert.equal(portalPaTerm(dataOf(twoInsurerJob({ tp: "National", pa: "off", years }), "tp")), 0);
  }
});

/* ------------------------------------------------------ the Brisk part ------------------------------------------------------ */

test("the Brisk part gets PA on and 'Brisk'; only it passes the Brisk certificate guard — OD and TP never do", () => {
  for (const tp of ["KSHEMA", "National"]) {
    const job = twoInsurerJob({ tp, pa: "Brisk" });
    const brisk = dataOf(job, "pa");
    assert.equal(brisk.paCover, true);
    assert.equal(brisk.paCoverCompany, "Brisk");
    assert.equal(shouldCreateBriskCertificate(brisk).create, true);
    assert.equal(shouldCreateBriskCertificate(dataOf(job, "od")).create, false);
    assert.equal(shouldCreateBriskCertificate(dataOf(job, "tp")).create, false);
  }
});

test("a Brisk PA comes last: TP, then OD, then Brisk, and it is not run while the OD is not finished", () => {
  const job = (tp, od) => ({ parts: partsFor({ tp: "KSHEMA", pa: "Brisk" }).map((p) => (p.key === "tp" ? { ...p, ...tp } : p.key === "od" ? { ...p, ...od } : p)) });
  assert.equal(core.selectRunnablePart(job({}, {}), NOW).key, "tp");
  assert.equal(core.selectRunnablePart(job({ status: "completed" }, {}), NOW).key, "od");
  for (const odState of [{ status: "failed_login_form", stopped: true }, { status: "processing" }, { status: "pending", nextRetryAt: new Date(NOW.getTime() + 60000) }]) {
    assert.equal(core.selectRunnablePart(job({ status: "completed" }, odState), NOW), null, `OD ${JSON.stringify(odState)}`);
  }
  for (const odStatus of ["completed", "completed_with_errors"]) {
    assert.equal(core.selectRunnablePart(job({ status: "completed" }, { status: odStatus }), NOW).key, "pa", odStatus);
  }
});

test("the TP part of a two-insurer job is not refused as a routing conflict, and a bundled part still is", () => {
  const job = twoInsurerJob({ tp: "KSHEMA", pa: "Brisk" });
  assert.equal(routingConflict(job.parts[1], job.formData, job.parts), null);
  assert.match(routingConflict(part("motor", "bundled", "Reliance"), job.formData, job.parts), /sold by two insurers/);
});

/* ---------------------------------------------- the nominee a Brisk PA needs ---------------------------------------------- */

const brisk = (nominee = {}) => ({ paCover: true, paCoverCompany: "Brisk", settings: { isMultipleCompany: true }, nomineeName: "RAMA", nomineeGender: "male", nomineeRelation: "son", ...nominee });

test("Brisk takes the nominee's name, gender and relation exactly (two insurers / TP only): each missing or unknown one is one plain sentence", () => {
  assert.equal(briskNomineeProblem(brisk()), "");
  assert.equal(briskNomineeProblem(brisk({ nomineeRelation: "Husband", nomineeGender: "FEMALE" })), "", "case does not matter");
  // as the policy stores them (its model uppercases the nominee fields) and the job carries them
  assert.equal(briskNomineeProblem(brisk({ nomineeName: "PRIYA", nomineeGender: "FEMALE", nomineeRelation: "WIFE" })), "");
  for (const [nominee, words] of [
    [{ nomineeName: " " }, /nominee's name is missing/],
    [{ nomineeGender: "" }, /nominee's gender is missing/],
    [{ nomineeGender: "other" }, /gender "other" is not one Brisk takes \(Male or Female\)/],
    [{ nomineeRelation: "" }, /nominee's relation is missing/],
    [{ nomineeRelation: "spouse" }, /relation "spouse" is not one Brisk takes \(Father, Mother, Wife, Husband, Sister, Son, Daughter, Brother\)/],
    [{ nomineeRelation: "self" }, /relation "self" is not one Brisk takes/],
  ]) {
    const said = briskNomineeProblem(brisk(nominee));
    assert.match(said, words);
    assert.match(said, /^Brisk PA: /);
    assert.match(said, /so no Brisk certificate was bought\. Fix the nominee in Edit, then run the PA again\.$/);
    assert.equal(said.split(":").length - 1, 1, "one colon: the label");
  }
});

test("TP-only counts like two insurers; a single-company policy keeps the older mapping (synonyms, 'Son' when unknown)", () => {
  assert.match(briskNomineeProblem({ coverage: "tp", paCover: true, nomineeName: "A", nomineeGender: "", nomineeRelation: "son" }), /gender is missing/);
  assert.equal(briskNomineeProblem({ coverage: "both", settings: { isMultipleCompany: false }, nomineeName: "", nomineeGender: "", nomineeRelation: "spouse" }), "");
  assert.equal(briskNomineeProblem({}), "");
});

/** The fakes of briskPartRunner.test.js: what was bought. */
const fakePolicies = (doc = {}) => ({ async findOne() { return structuredClone(doc); }, async updateOne() { return { matchedCount: 1 }; } });
const fakeBrisk = () => {
  const calls = { create: 0 };
  return {
    calls,
    shouldCreateBriskCertificate,
    async createBriskCertificate() { calls.create++; return { policyId: "CERT-1", downloadUrl: "https://brisk/pdf" }; },
    async downloadBriskPDF() { return "/tmp/no-such-brisk.pdf"; },
    async uploadBriskCertificate() { return { key: "BriskCertificates/CERT-1.pdf" }; },
  };
};
const quiet = { log() {}, warn() {} };

test("the Brisk part does NOT buy with a nominee Brisk cannot take (nothing bought, a plain failure); with a good nominee it buys once", async () => {
  const job = twoInsurerJob({ tp: "KSHEMA", pa: "Brisk", nominee: { nomineeGender: "", nomineeRelation: "wife" } });
  const bad = fakeBrisk();
  const r = await runBriskPart({ ...dataOf(job, "pa"), _jobIdentifier: "j1" }, { policies: fakePolicies(), policyId: "policy1", brisk: bad, ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.briskFailed, true);
  assert.equal(r.certificateNo, undefined, "nothing exists at Brisk");
  assert.match(r.error, /^Brisk PA: the nominee's gender is missing, so no Brisk certificate was bought\./);
  assert.equal(bad.calls.create, 0, "no money moved");

  const good = fakeBrisk();
  const ok = await runBriskPart({ ...dataOf(twoInsurerJob({ tp: "National", pa: "Brisk" }), "pa"), _jobIdentifier: "j2" }, { policies: fakePolicies(), policyId: "policy1", brisk: good, ...quiet });
  assert.equal(ok.success, true, JSON.stringify(ok));
  assert.equal(good.calls.create, 1);
});

test("the nominee's own gender reaches the Brisk step: the form data copies it and the certificate sends it (not the customer's)", () => {
  const server = fs.readFileSync(require.resolve("../server.js"), "utf8");
  assert.match(server, /nomineeGender: data\?\.nomineeGender/, "server.js buildFormDataFromPolicy copies nomineeGender");
  const certificate = fs.readFileSync(require.resolve("../briskCertificate.js"), "utf8");
  assert.match(certificate, /NomineeGender: toBriskGender\(data\.nomineeGender \|\| data\.gender\)/);
});

/* ------------------------------------------------- the run-time routing guard ------------------------------------------------- */

const policyNow = (pa, paCover = true) => ({ paCover, settings: { ODCompany: "Reliance", TPCompany: "KSHEMA", PACompany: pa } });

test("routing guard: a part runs only where the policy NOW says its PA is — otherwise it stops with one sentence, nothing bought", () => {
  const brisk = part("pa", "brisk", "Brisk", { dependsOn: "tp" });
  const tpWithPa = part("tp", "portal", "KSHEMA", { carriesPa: true });
  const tpWithout = part("tp", "portal", "KSHEMA");
  const od = part("od", "portal", "Reliance", { dependsOn: "tp" });

  // everything agrees
  assert.equal(paRoutingProblem(brisk, policyNow("Brisk")), "");
  assert.equal(paRoutingProblem(tpWithPa, policyNow("KSHEMA")), "");
  assert.equal(paRoutingProblem(tpWithout, policyNow("Brisk")), "");
  assert.equal(paRoutingProblem(od, policyNow("Brisk")), "");

  // the policy was saved again with another provider (or PA off) and the job was not re-synced
  assert.equal(
    paRoutingProblem(brisk, policyNow("KSHEMA")),
    "Brisk PA: this policy's PA Cover is bought with KSHEMA, not through Brisk, so no Brisk certificate was bought. Save the policy again so its parts match what it now says."
  );
  assert.match(paRoutingProblem(brisk, policyNow("", false)), /PA Cover is off, not through Brisk/);
  // PA Cover unticked while `settings` still names Brisk (a writer that did not rebuild it): off wins, nothing is bought
  assert.match(paRoutingProblem(brisk, policyNow("Brisk", false)), /PA Cover is off, not through Brisk/);
  assert.match(paRoutingProblem(tpWithPa, policyNow("KSHEMA", false)), /PA Cover is off, not with KSHEMA/);
  assert.equal(
    paRoutingProblem(tpWithPa, policyNow("Brisk")),
    "KSHEMA TP: this policy's PA Cover is bought with Brisk, not with KSHEMA, so this part was not run (it would have bought PA there). Save the policy again so its parts match what it now says."
  );
  assert.match(paRoutingProblem(tpWithPa, policyNow("", false)), /PA Cover is off, not with KSHEMA/);

  // a policy saved before `settings` existed has no routing to compare with
  assert.equal(paRoutingProblem(brisk, { paCover: true }), "");
  assert.equal(paRoutingProblem(brisk, null), "");
  assert.equal(paRoutingProblem(brisk, { paCover: true, settings: JSON.stringify({ PACompany: "KSHEMA" }) }) !== "", true, "settings saved as JSON text are read too");
});

test("the part runner asks the guard before anything is opened or bought", () => {
  const src = fs.readFileSync(require.resolve("../lib/partRunner.js"), "utf8");
  const guard = src.indexOf("paRoutingProblem(part, policyDoc)");
  assert.ok(guard > 0, "partRunner calls the guard");
  assert.ok(guard < src.indexOf("resolveCredentials(companyName"), "…before any portal login");
  assert.ok(guard < src.indexOf("runBriskPart(\n"), "…before the Brisk certificate is bought");
  assert.match(src, /projection: \{ briskCertificate: 1, proposalNumber: 1, paCover: 1, settings: 1, \.\.\.TP_PROJECTION \}/, "the policy's paCover and settings are read fresh");
});

/* ------------------------------ the guard inside the real part runner (fake deps, no browser) ------------------------------ */

const runner = require("../lib/partRunner");
const { jobDoc, partOf, silentLogger, fakeCollection, withPart } = require("./helpers");

const claimed = (job, key) => ({
  ...job,
  status: "processing",
  rev: (job.rev || 0) + 1,
  parts: withPart(job.parts, key, { status: "processing", startedAt: NOW }),
  currentPart: { key, company: partOf(job, key).company, kind: partOf(job, key).kind, bucket: core.capacityBucket(partOf(job, key)), attempt: 1, startedAt: NOW },
});

/** Run one part of a two-insurer job through runPartJob; `policyDoc` is what the policy says NOW. */
async function runPart({ tp = "KSHEMA", pa, key, policyDoc, jobPatch = {}, nominee }) {
  const base = twoInsurerJob({ tp, pa, nominee });
  const job = jobDoc(base.parts);
  job.formData = { ...job.formData, ...base.formData };
  // the TP is bought; the OD failed on the portal (the live run of 2026-10-23)
  job.parts = job.parts.map((p) => (p.key === "tp" ? { ...p, status: "completed", completedAt: NOW } : p.key === "od" ? { ...p, status: "failed_login_form", stopped: true } : p));
  Object.assign(job, jobPatch);
  const c = claimed(job, key);
  const col = fakeCollection(c);
  const calls = { brisk: 0, handler: 0, logins: 0 };
  const deps = {
    collection: col,
    policies: {
      async findOne(filter, opts = {}) {
        if (!opts.projection) return policyDoc;
        const keep = Object.keys(opts.projection).filter((k) => opts.projection[k]);
        return Object.fromEntries(Object.entries(policyDoc).filter(([k]) => k === "_id" || keep.includes(k)));
      },
      async updateOne() { return { matchedCount: 1 }; },
    },
    hydrateJobFormData: async (j) => j,
    resolveCredentials: async () => { calls.logins++; return { creds: { username: "u", password: "p", loginUrl: "https://portal", _id: "c1" }, source: "user", matchedBy: "user-id" }; },
    dispatchBundled: async () => ({ run: Promise.resolve({ success: true }) }),
    resolveMultiCompanyHandler: () => async () => { calls.handler++; return { success: true }; },
    assertMultiCompanyEnabled: () => {},
    runBriskPart: async () => { calls.brisk++; return { success: true, certificateNo: "CERT-1" }; },
    scheduleWakeup: () => {},
    now: () => NOW,
    logger: { ...silentLogger, warn: () => {} },
    jobTimeoutMs: 2000,
    companyLabel: (x) => x,
  };
  await runner.runPartJob(deps, c);
  return { doc: col.state.doc, calls };
}

test("runner: a Brisk part that was started buys when the policy still says Brisk; another part's failure stays its own", async () => {
  const { doc, calls } = await runPart({ pa: "Brisk", key: "pa", policyDoc: { _id: "policy1", ...policyNow("Brisk") } });
  assert.equal(calls.brisk, 1);
  assert.equal(partOf(doc, "pa").status, "completed");
  assert.equal(partOf(doc, "od").status, "failed_login_form", "the OD's failure is its own");
});

test("runner: the policy was saved with the TP company's PA after the job was built -> the Brisk part STOPS, nothing is bought", async () => {
  const { doc, calls } = await runPart({ pa: "Brisk", key: "pa", policyDoc: { _id: "policy1", ...policyNow("KSHEMA") } });
  assert.equal(calls.brisk, 0, "Brisk is not touched");
  const pa = partOf(doc, "pa");
  assert.equal(pa.status, "failed_login_form");
  assert.equal(pa.stage, "pa-routing");
  assert.equal(pa.nextRetryAt, null, "no retry loop");
  assert.equal(pa.lastError, "Brisk PA: this policy's PA Cover is bought with KSHEMA, not through Brisk, so no Brisk certificate was bought. Save the policy again so its parts match what it now says.");
});

test("runner: the TP part that carries PA stops when the policy now says Brisk — no login, nothing bought", async () => {
  const { doc, calls } = await runPart({ pa: "Company", key: "tp", policyDoc: { _id: "policy1", ...policyNow("Brisk") } });
  assert.equal(calls.logins, 0, "no portal login");
  assert.equal(calls.handler, 0, "the KSHEMA form never ran");
  const tp = partOf(doc, "tp");
  assert.equal(tp.status, "failed_login_form");
  assert.equal(tp.stage, "pa-routing");
  assert.equal(tp.lastError, "KSHEMA TP: this policy's PA Cover is bought with Brisk, not with KSHEMA, so this part was not run (it would have bought PA there). Save the policy again so its parts match what it now says.");
});

test("runner: an agreeing policy changes nothing — the TP part with PA at KSHEMA runs", async () => {
  const base = twoInsurerJob({ tp: "KSHEMA", pa: "Company" });
  const job = jobDoc(base.parts);
  job.formData = { ...job.formData, ...base.formData };
  const c = claimed(job, "tp");
  const col = fakeCollection(c);
  const calls = { logins: 0, handler: 0 };
  const policyDoc = { _id: "policy1", ...policyNow("KSHEMA") };
  await runner.runPartJob(
    {
      collection: col,
      policies: { async findOne() { return policyDoc; }, async updateOne() { return { matchedCount: 1 }; } },
      hydrateJobFormData: async (j) => j,
      resolveCredentials: async () => { calls.logins++; return { creds: { username: "u", password: "p", loginUrl: "https://portal", _id: "c1" }, source: "user", matchedBy: "user-id" }; },
      dispatchBundled: async () => ({ run: Promise.resolve({ success: true }) }),
      resolveMultiCompanyHandler: () => async (data) => { calls.handler++; calls.paCover = data.paCover; return { success: true }; },
      assertMultiCompanyEnabled: () => {},
      runBriskPart: async () => ({ success: true }),
      scheduleWakeup: () => {},
      now: () => NOW,
      logger: { ...silentLogger, warn: () => {} },
      jobTimeoutMs: 2000,
      companyLabel: (x) => x,
    },
    c
  );
  assert.equal(calls.handler, 1);
  assert.equal(calls.paCover, true, "the part that carries PA runs with PA on");
  assert.equal(partOf(col.state.doc, "tp").status, "completed");
});
