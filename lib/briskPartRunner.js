/**
 * The Brisk PA part: buy the Brisk CPA/RSA certificate on its own, through the
 * Brisk API only. No browser, no portal login, no credentials.
 *
 * Money is spent here, so the order matters:
 *
 *   1. a certificate already on the policy  -> finish WITHOUT buying;
 *   2. buy it (createBriskCertificate);
 *   3. record the certificate number on the policy AT ONCE, before anything
 *      that can still fail — from that moment every later run (retry, edit,
 *      the bundled flows' inline purchase) sees "already bought";
 *   4. download the PDF and store it.
 *
 * Returns (never throws for a business failure):
 *   { success: true,  certificateNo, alreadyExisted? | skipped?, reason? }
 *   { success: false, briskFailed: true, error, certificateNo? }
 * `certificateNo` on a failure means the certificate EXISTS and only a later
 * step failed — the caller then treats the part as done-with-errors, never as
 * something to buy again.
 */
const fs = require("fs");

const hasCertificate = (policy) => {
  const c = policy && policy.briskCertificate;
  return !!(c && (c.key || c.location || c.certificateNo));
};

/**
 * Write the certificate number onto the policy. `briskCertificate` may be
 * missing or null (a dotted $set fails on null), so the null case replaces it.
 */
async function saveCertificateNo(policies, policyId, certificateNo, now = new Date()) {
  const first = await policies.updateOne(
    { _id: policyId, briskCertificate: null },
    { $set: { briskCertificate: { certificateNo }, updatedAt: now } }
  );
  if (first.matchedCount) return;
  await policies.updateOne(
    { _id: policyId },
    { $set: { "briskCertificate.certificateNo": certificateNo, updatedAt: now } }
  );
}

/**
 * @param {Object} data      the part's form data (paCover / paCoverCompany "Brisk" ...)
 * @param {Object} deps
 * @param {Object} deps.policies   onlinePolicy collection
 * @param {*}      deps.policyId   the policy's _id (the job's captchaId)
 * @param {Object} [deps.brisk]    ../briskCertificate (injected in tests)
 * @param {Object} [deps.state]    receives `certificateNo` the moment it exists, so
 *                                 a timeout that abandons this run can still report it
 */
async function runBriskPart(data, deps) {
  const {
    policies,
    policyId,
    brisk = require("../briskCertificate"),
    log = console.log,
    warn = console.warn,
    state = {},
    now = () => new Date(),
  } = deps;
  const jobId = data._jobIdentifier || "";

  const existing = await policies.findOne(
    { _id: policyId },
    { projection: { briskCertificate: 1 } }
  );
  if (hasCertificate(existing)) {
    log(`[${jobId}] Brisk certificate already on the policy — nothing to buy.`);
    return {
      success: true,
      alreadyExisted: true,
      certificateNo: (existing.briskCertificate && existing.briskCertificate.certificateNo) || null,
    };
  }

  const decision = brisk.shouldCreateBriskCertificate(data);
  if (!decision.create) {
    log(`[${jobId}] Brisk certificate not needed — ${decision.reason}.`);
    return { success: true, skipped: true, reason: decision.reason, certificateNo: null };
  }

  const failed = (error, certificateNo) => ({
    success: false,
    briskFailed: true,
    error,
    ...(certificateNo ? { certificateNo } : {}),
  });

  let created;
  try {
    created = await brisk.createBriskCertificate(data);
  } catch (e) {
    // Nothing was bought (the wallet check and the API both failed before a
    // certificate exists), so a later manual re-run is safe.
    return failed(e.message || String(e));
  }

  const certificateNo = created && created.policyId ? String(created.policyId) : null;
  if (!certificateNo) {
    return failed(
      "Brisk accepted the request but returned no certificate number — check Brisk before running this again, a certificate may have been created."
    );
  }
  state.certificateNo = certificateNo;

  try {
    await saveCertificateNo(policies, policyId, certificateNo, now());
  } catch (e) {
    // uploadBriskCertificate below records it too; and if that also fails the
    // part still ends up done-with-errors carrying the number.
    warn(`[${jobId}] could not record the Brisk certificate number on the policy: ${e.message}`);
  }

  let pdfPath = null;
  try {
    if (!created.downloadUrl) {
      return failed(
        `Brisk certificate ${certificateNo} was created but Brisk returned no download link, so the PDF is not stored.`,
        certificateNo
      );
    }
    pdfPath = await brisk.downloadBriskPDF(created.downloadUrl, certificateNo);
    const stored = await brisk.uploadBriskCertificate(pdfPath, certificateNo, data, jobId);
    if (!stored) {
      return failed(
        `Brisk certificate ${certificateNo} was created but its PDF could not be stored.`,
        certificateNo
      );
    }
    return { success: true, certificateNo, fileInfo: stored };
  } catch (e) {
    return failed(
      `Brisk certificate ${certificateNo} was created but its PDF could not be stored: ${e.message}`,
      certificateNo
    );
  } finally {
    // The PDF is in S3 (or the attempt failed); never leave it on the server disk.
    if (pdfPath) fs.promises.unlink(pdfPath).catch(() => {});
  }
}

module.exports = { runBriskPart, saveCertificateNo, hasCertificate };
