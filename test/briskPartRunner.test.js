const test = require("node:test");
const assert = require("node:assert/strict");
const { runBriskPart } = require("../lib/briskPartRunner");

/** onlinePolicy collection with just the calls the runner makes. */
function fakePolicies(doc = {}) {
  const state = { doc: structuredClone(doc), updates: [] };
  return {
    state,
    async findOne() {
      return structuredClone(state.doc);
    },
    async updateOne(filter, update) {
      state.updates.push({ filter, update });
      const set = update.$set || {};
      if ("briskCertificate" in filter && filter.briskCertificate === null) {
        if (state.doc.briskCertificate == null) {
          state.doc.briskCertificate = structuredClone(set.briskCertificate);
          return { matchedCount: 1 };
        }
        return { matchedCount: 0 };
      }
      if (set["briskCertificate.certificateNo"] !== undefined) {
        state.doc.briskCertificate = { ...(state.doc.briskCertificate || {}), certificateNo: set["briskCertificate.certificateNo"] };
      }
      return { matchedCount: 1 };
    },
  };
}

/** Stand-in for ../briskCertificate that records what was bought. */
function fakeBrisk(over = {}) {
  const calls = { create: 0, download: 0, upload: 0, order: [] };
  return {
    calls,
    shouldCreateBriskCertificate: over.should || ((data) => ({ create: data.paCover === true && data.paCoverCompany === "Brisk", reason: "not needed" })),
    async createBriskCertificate() {
      calls.create++;
      calls.order.push("create");
      if (over.createError) throw new Error(over.createError);
      return over.created || { success: true, policyId: "CERT-1", downloadUrl: "https://brisk/pdf" };
    },
    async downloadBriskPDF() {
      calls.download++;
      calls.order.push("download");
      if (over.downloadError) throw new Error(over.downloadError);
      return "/tmp/does-not-exist-brisk.pdf";
    },
    async uploadBriskCertificate() {
      calls.upload++;
      calls.order.push("upload");
      return over.uploaded === undefined ? { key: "BriskCertificates/CERT-1.pdf" } : over.uploaded;
    },
  };
}

const data = (extra = {}) => ({ paCover: true, paCoverCompany: "Brisk", _jobIdentifier: "j1", ...extra });
const quiet = { log() {}, warn() {} };

test("a certificate already on the policy -> completes WITHOUT buying or asking for the PDF", async () => {
  const policies = fakePolicies({ briskCertificate: { key: "k", certificateNo: "OLD-1" } });
  const brisk = fakeBrisk();
  const r = await runBriskPart(data(), { policies, policyId: "p1", brisk, certificates: fakeCertificates({ briskUrl: "https://brisk/x.pdf" }), ...quiet });
  assert.equal(brisk.calls.download, 0);
  assert.equal(r.success, true);
  assert.equal(r.alreadyExisted, true);
  assert.equal(r.certificateNo, "OLD-1");
  assert.equal(brisk.calls.create, 0);
});

/* A number on the policy and no PDF: the run before it stopped while waiting for Brisk's file (a restart, ^C). */
const fakeCertificates = (record) => {
  const asked = [];
  return { asked, async findOne(filter) { asked.push(filter); return record; } };
};
const numberOnly = () => fakePolicies({ briskCertificate: { certificateNo: "HALF-1" } });

test("number only: it never buys, it fetches the PDF from the saved address and stores it", async () => {
  const brisk = fakeBrisk();
  const certificates = fakeCertificates({ briskUrl: "https://brisk/HALF-1.pdf" });
  const r = await runBriskPart(data(), { policies: numberOnly(), policyId: "p1", brisk, certificates, ...quiet });
  assert.equal(brisk.calls.create, 0, "nothing is bought");
  assert.deepEqual(brisk.calls.order, ["download", "upload"]);
  assert.equal(r.success, true);
  assert.equal(r.alreadyExisted, true);
  assert.equal(r.certificateNo, "HALF-1");
  assert.deepEqual(certificates.asked, [{ certificateNo: "HALF-1", status: "CREATED" }]);
});

test("number only, the PDF still not there: never 'completed', the number is reported, nothing is bought", async () => {
  const brisk = fakeBrisk({ downloadError: "Brisk had not made the PDF after 3 checks" });
  const r = await runBriskPart(data(), { policies: numberOnly(), policyId: "p1", brisk, certificates: fakeCertificates({ briskUrl: "https://brisk/x.pdf" }), ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.briskFailed, true);
  assert.equal(r.certificateNo, "HALF-1");
  assert.match(r.error, /Brisk had not made the PDF after 3 checks/);
  assert.equal(brisk.calls.create, 0);
});

test("number only, the store fails: reported with the number, nothing bought", async () => {
  const brisk = fakeBrisk({ uploaded: null });
  const r = await runBriskPart(data(), { policies: numberOnly(), policyId: "p1", brisk, certificates: fakeCertificates({ briskUrl: "https://brisk/x.pdf" }), ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.certificateNo, "HALF-1");
  assert.equal(brisk.calls.create, 0);
});

test("number only, no record of its address (an older certificate, or a cancelled one): nothing bought, nothing downloaded, and it says so", async () => {
  for (const certificates of [null, fakeCertificates(null), fakeCertificates({})]) {
    const brisk = fakeBrisk();
    const r = await runBriskPart(data(), { policies: numberOnly(), policyId: "p1", brisk, certificates, ...quiet });
    assert.equal(r.success, false);
    assert.equal(r.certificateNo, "HALF-1");
    assert.match(r.error, /is on the policy but its PDF is not stored/);
    assert.equal(brisk.calls.create, 0);
    assert.equal(brisk.calls.download, 0);
  }
});

test("V2 confirms an existing certificate without a number: complete without another download", async () => {
  const brisk = fakeBrisk({ created: { success: true, alreadyExisted: true, policyId: "", downloadUrl: "https://brisk/existing.pdf" } });
  const policies = fakePolicies({});
  const r = await runBriskPart(data(), { policies, policyId: "p1", brisk, ...quiet });
  assert.equal(r.success, true);
  assert.equal(r.alreadyExisted, true);
  assert.equal(r.certificateNo, null);
  assert.equal(brisk.calls.create, 1, "the backend was checked once");
  assert.equal(brisk.calls.download, 0);
  assert.equal(brisk.calls.upload, 0);
  assert.equal(policies.state.updates.length, 0, "no unverified number is written");
});

test("not a Brisk PA (or PA off) -> nothing bought, part completes with the reason", async () => {
  const policies = fakePolicies({});
  const brisk = fakeBrisk();
  const r = await runBriskPart(data({ paCoverCompany: "Company" }), { policies, policyId: "p1", brisk, ...quiet });
  assert.equal(r.success, true);
  assert.equal(r.skipped, true);
  assert.equal(brisk.calls.create, 0);
});

test("buys, records the certificate number IMMEDIATELY (before the download), downloads and stores", async () => {
  const policies = fakePolicies({});
  const brisk = fakeBrisk();
  const order = [];
  const origUpdate = policies.updateOne.bind(policies);
  policies.updateOne = async (f, u) => {
    order.push("saveNumber");
    return origUpdate(f, u);
  };
  const origDownload = brisk.downloadBriskPDF;
  brisk.downloadBriskPDF = async (...a) => {
    order.push("download");
    return origDownload(...a);
  };
  const state = {};
  const r = await runBriskPart(data(), { policies, policyId: "p1", brisk, state, ...quiet });
  assert.deepEqual(r, { success: true, certificateNo: "CERT-1", fileInfo: { key: "BriskCertificates/CERT-1.pdf" } });
  assert.deepEqual(order, ["saveNumber", "download"]);
  assert.equal(policies.state.doc.briskCertificate.certificateNo, "CERT-1");
  assert.equal(state.certificateNo, "CERT-1");
  assert.deepEqual(brisk.calls.order, ["create", "download", "upload"]);
});

test("briskCertificate stored as null on the policy is replaced, not $set into", async () => {
  const policies = fakePolicies({ briskCertificate: null });
  await runBriskPart(data(), { policies, policyId: "p1", brisk: fakeBrisk({ uploaded: null }), ...quiet });
  assert.equal(policies.state.doc.briskCertificate.certificateNo, "CERT-1");
});

test("creation fails (wallet, API) -> briskFailed WITHOUT a certificate number", async () => {
  const brisk = fakeBrisk({ createError: "Brisk wallet balance too low" });
  const r = await runBriskPart(data(), { policies: fakePolicies({}), policyId: "p1", brisk, ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.briskFailed, true);
  assert.equal(r.certificateNo, undefined);
  assert.match(r.error, /wallet balance too low/);
  assert.equal(brisk.calls.download, 0);
});

test("certificate created but the download fails -> briskFailed WITH the number, and the number is on the policy", async () => {
  const policies = fakePolicies({});
  const r = await runBriskPart(data(), { policies, policyId: "p1", brisk: fakeBrisk({ downloadError: "Failed to download PDF. Status: 500" }), ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.certificateNo, "CERT-1");
  assert.match(r.error, /CERT-1 was created/);
  assert.equal(policies.state.doc.briskCertificate.certificateNo, "CERT-1");
});

test("certificate created but the upload fails (returns null) -> briskFailed WITH the number", async () => {
  const r = await runBriskPart(data(), { policies: fakePolicies({}), policyId: "p1", brisk: fakeBrisk({ uploaded: null }), ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.certificateNo, "CERT-1");
  assert.match(r.error, /could not be stored/);
});

test("no download link -> briskFailed with the number", async () => {
  const brisk = fakeBrisk({ created: { success: true, policyId: "CERT-2" } });
  const r = await runBriskPart(data(), { policies: fakePolicies({}), policyId: "p1", brisk, ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.certificateNo, "CERT-2");
  assert.equal(brisk.calls.download, 0);
});

test("Brisk answers 2xx without a certificate number -> failed, and the operator is told to check Brisk first", async () => {
  const brisk = fakeBrisk({ created: { success: true, raw: "<html>" } });
  const r = await runBriskPart(data(), { policies: fakePolicies({}), policyId: "p1", brisk, ...quiet });
  assert.equal(r.success, false);
  assert.equal(r.certificateNo, undefined);
  assert.match(r.error, /check Brisk before running this again/);
});

test("the number could not be saved (DB error) -> the run still finishes and reports the certificate", async () => {
  const policies = fakePolicies({});
  policies.updateOne = async () => {
    throw new Error("db down");
  };
  const r = await runBriskPart(data(), { policies, policyId: "p1", brisk: fakeBrisk(), ...quiet });
  assert.equal(r.success, true);
  assert.equal(r.certificateNo, "CERT-1");
});
