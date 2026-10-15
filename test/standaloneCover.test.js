// OD only / TP only from ONE insurer: the job holds just that part, and PA (Company or Brisk) reaches the National and
// KSHEMA TP handlers the way the TP company select does. No browser, no database.
// Run with: node --test test/standaloneCover.test.js
//
// The chain under test:  backend parts (carriesPa / pa part)  ->  lib/partRunner.buildPartFormData  ->  what the
// handler's own PA rules read (National: portalPaTerm; KSHEMA: PA_COVER_FIELDS and the nominee decision).
const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../lib/jobPartsCore");
const { buildPartFormData, routingConflict, mapRunResult } = require("../lib/partRunner");
const { part, NOW } = require("./helpers");
const { portalPaTerm } = require("../multiCompany/tpCompany/nationalTP/tpPa");
const { PA_COVER_FIELDS, isCompanyPaCover } = require("../multiCompany/tpCompany/kshemaTP/kshemaTPQuoteForm");

const fieldValue = (key, data) => PA_COVER_FIELDS.find((f) => f.key === key).value(data);
const fieldRequired = (key, data) => {
  const f = PA_COVER_FIELDS.find((x) => x.key === key);
  return typeof f.required === "function" ? f.required(data) : f.required;
};

/** The job a TP-only single-company policy gets from the backend (shared/jobParts.js buildJobParts). */
const tpOnlyJob = ({ company, pa, years }) => {
  const settings = { isMultipleCompany: false, ODCompany: company, TPCompany: company, PACompany: pa === "off" ? "" : pa === "Brisk" ? "Brisk" : company };
  const parts = [part("tp", "portal", company, pa === "Company" ? { carriesPa: true, paCoverCompany: "Company" } : {})];
  if (pa === "Brisk") parts.push(part("pa", "brisk", "Brisk", { dependsOn: "tp", paCoverCompany: "Brisk" }));
  if (pa === "Company") parts.push(part("pa", "withPart", company, { mirrors: "tp", paCoverCompany: "Company" }));
  return {
    _id: "job1",
    captchaId: "policy1",
    status: "pending",
    parts,
    formData: {
      firstName: "Asha",
      lastName: "Kumar",
      Companyname: company.toLowerCase(),
      coverage: "tp",
      settings,
      paCover: pa !== "off",
      paCoverCompany: pa === "Brisk" ? "Brisk" : pa === "Company" ? "Company" : "Brisk", // the model's default stays "Brisk" with PA off
      paCoverYears: years,
      notPaCoverReason: "",
      nomineeName: "Meena",
      nomineeRelation: "Spouse",
      nomineeAge: 40,
    },
  };
};

const dataFor = (job) => buildPartFormData(job, job.parts.find((p) => p.key === "tp"));

/* ------------------------------ National TP-only ------------------------------ */

test("National TP-only, PA off: the portal's Compulsory PA is 'No' — no year is asked, none is sent", () => {
  for (const years of [1, 5, 3, "", undefined]) {
    const data = dataFor(tpOnlyJob({ company: "National", pa: "off", years }));
    assert.equal(data.paCover, false);
    assert.equal(data.policyType, "tp");
    assert.equal(portalPaTerm(data), 0, `saved year ${JSON.stringify(years)} is not used`);
  }
});

test("National TP-only, PA Company: the TP part carries PA and the portal gets the year", () => {
  const job = tpOnlyJob({ company: "National", pa: "Company", years: 5 });
  const data = dataFor(job);
  assert.equal(data.paCover, true);
  assert.equal(data.paCoverCompany, "Company");
  assert.equal(portalPaTerm(data), 5);
  // PA through the company is bought WITH the part: nothing extra for the runner to do
  assert.equal(core.selectRunnablePart(job, NOW).key, "tp");
  assert.equal(core.normalizeParts(job.parts).find((p) => p.key === "pa").kind, "withPart");
});

test("National TP-only, PA Brisk: the portal stays on 'No' (Brisk's certificate is the cover) and Brisk is its own part", () => {
  const job = tpOnlyJob({ company: "National", pa: "Brisk", years: 5 });
  const data = dataFor(job);
  assert.equal(data.paCover, false, "the TP part does not carry PA");
  assert.equal(portalPaTerm(data), 0, "'No' — never both the portal's PA and Brisk's");

  // the Brisk part waits for the TP, not for a part that does not exist
  assert.equal(core.selectRunnablePart(job, NOW).key, "tp");
  const bought = core.applyPartOutcome(job, "tp", { type: "success" }, NOW);
  assert.equal(core.selectRunnablePart({ ...job, parts: bought.parts }, NOW).key, "pa");
  const stopped = core.applyPartOutcome(job, "tp", { type: "nonRetryable", error: "x", errorCode: "E205" }, NOW);
  assert.equal(core.selectRunnablePart({ ...job, parts: stopped.parts }, NOW), null, "TP failed: no Brisk certificate is bought");
});

test("National TP-only, PA bought from National, with a year that is not 1 or 5 is unusable (null), never guessed", () => {
  for (const years of [2, 3, 4, "", undefined]) {
    assert.equal(portalPaTerm(dataFor(tpOnlyJob({ company: "National", pa: "Company", years }))), null, JSON.stringify(years));
  }
});

/* ------------------------------ KSHEMA TP-only ------------------------------ */

test("KSHEMA TP-only, PA off: checkbox off, a reason given, no year, no nominee", () => {
  const data = dataFor(tpOnlyJob({ company: "KSHEMA", pa: "off", years: 1 }));
  assert.equal(fieldValue("paCover", data), false);
  assert.match(fieldValue("notPaCoverReason", data), /Already have personal accident policy/);
  assert.equal(fieldRequired("notPaCoverReason", data), true);
  assert.equal(fieldValue("paCoverYear", data), null);
  assert.equal(isCompanyPaCover(data), false, "no nominee entry");
});

test("KSHEMA TP-only, PA Company: checkbox on, the year as picked, no reason, a nominee entry", () => {
  for (const years of [1, 2, 3, 4, 5]) {
    const data = dataFor(tpOnlyJob({ company: "KSHEMA", pa: "Company", years }));
    assert.equal(data.paCover, true);
    assert.equal(fieldValue("paCover", data), true);
    assert.equal(fieldValue("notPaCoverReason", data), null);
    assert.equal(fieldRequired("notPaCoverReason", data), false);
    assert.equal(fieldValue("paCoverYear", data), String(years));
    assert.equal(fieldRequired("paCoverYear", data), true);
    assert.equal(isCompanyPaCover(data), true, "nominee entry, in step with the checkbox");
  }
});

test("KSHEMA TP-only, PA Brisk: the portal's PA is off with a reason, no nominee, Brisk is its own part", () => {
  const job = tpOnlyJob({ company: "KSHEMA", pa: "Brisk", years: 3 });
  const data = dataFor(job);
  assert.equal(data.paCover, false);
  assert.equal(fieldValue("paCover", data), false);
  assert.ok(fieldValue("notPaCoverReason", data));
  assert.equal(fieldValue("paCoverYear", data), null);
  assert.equal(isCompanyPaCover(data), false);
  assert.equal(core.normalizeParts(job.parts).find((p) => p.key === "pa").dependsOn, "tp");
});

test("KSHEMA: the checkbox and the nominee can never disagree, whatever paCoverCompany says", () => {
  // the shapes the system produces, plus an insurer name that older rows could carry
  const shapes = [
    { paCover: true, paCoverCompany: "Company" },
    { paCover: true, paCoverCompany: "" },
    { paCover: true, paCoverCompany: "KSHEMA" },
    { paCover: true, paCoverCompany: "Brisk" },
    { paCover: true, paCoverCompany: "National" },
    { paCover: false, paCoverCompany: "Company" },
    { paCover: false, paCoverCompany: "Brisk" },
    { paCover: "true", paCoverCompany: "Company" },
  ];
  for (const data of shapes) {
    assert.equal(isCompanyPaCover(data), fieldValue("paCover", data), JSON.stringify(data));
  }
});

/* ------------------------------ the job itself ------------------------------ */

test("a lone portal part on a single-company policy is not refused; a bundled one on a TP-only / OD-only policy is", () => {
  const tpJob = tpOnlyJob({ company: "National", pa: "off", years: 5 });
  const tpPart = tpJob.parts[0];
  assert.equal(routingConflict(tpPart, tpJob.formData, tpJob.parts), null);

  const motor = part("motor", "bundled", "National");
  for (const coverage of ["tp", "od"]) {
    const message = routingConflict(motor, { ...tpJob.formData, coverage }, [motor]);
    assert.match(message, /sells only/);
    assert.match(message, /whole comprehensive policy/);
  }
  // an ordinary single-company OD + TP policy is untouched
  assert.equal(routingConflict(motor, { ...tpJob.formData, coverage: "both" }, [motor]), null);
  assert.equal(routingConflict(motor, { ...tpJob.formData, coverage: undefined }, [motor]), null);
});

test("a TP-only job finishes when its one part is bought (no OD to wait for), and a Brisk PA follows", () => {
  const job = tpOnlyJob({ company: "KSHEMA", pa: "off", years: 1 });
  const done = core.applyPartOutcome(job, "tp", mapRunResult({ success: true, stage: "completed" }, { part: job.parts[0], companyName: "kshema" }), NOW);
  assert.equal(done.parts.find((p) => p.key === "tp").status, "completed");
  assert.equal(done.jobSet.status, "completed");

  const withBrisk = tpOnlyJob({ company: "KSHEMA", pa: "Brisk", years: 1 });
  const afterTp = core.applyPartOutcome(withBrisk, "tp", { type: "success" }, NOW);
  assert.notEqual(afterTp.jobSet.status, "completed", "the Brisk PA is still to buy");
  assert.equal(core.selectRunnablePart({ ...withBrisk, parts: afterTp.parts }, NOW).key, "pa");
});
