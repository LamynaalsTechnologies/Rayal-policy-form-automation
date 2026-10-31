/**
 * The Brisk PA part: buy the Brisk CPA/RSA certificate on its own, through the
 * Brisk API only. No browser, no portal login, no credentials.
 *
 * Money is spent here, so the order matters:
 *
 *   1. a certificate already on the policy  -> finish WITHOUT buying (only its number there: fetch and store its PDF first);
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

/** Brisk's own list of nominee relations (the exact set its page offers; briskCertificate.js maps onto it). */
const BRISK_RELATIONS = ["Father", "Mother", "Wife", "Husband", "Sister", "Son", "Daughter", "Brother"];
const BRISK_GENDERS = ["Male", "Female"];

const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

/**
 * Does THIS policy's nominee have to be exactly what Brisk takes? Yes for a policy sold by two insurers or TP only (the owner,
 * 2026-10-23: the form asks Brisk's own nominee fields there). A single-company policy's Brisk PA keeps the older mapping
 * (briskCertificate.js: synonyms, "Son" when unknown) — those nominees come from another insurer's list and used to go through.
 */
const needsExactNominee = (data) => !!(data && ((data.settings && data.settings.isMultipleCompany === true) || String(data.coverage || "").toLowerCase() === "tp"));

/**
 * What is wrong with the nominee for a Brisk certificate, as one sentence for the operator (one colon, nothing was bought), or "".
 * Brisk takes the nominee's name, gender and relation. Without this the certificate step invented "FERNANDO", the customer's gender
 * and "Son" — a certificate cannot be edited once it is bought.
 */
function briskNomineeProblem(data) {
  if (!needsExactNominee(data)) return "";
  const fix = "so no Brisk certificate was bought. Fix the nominee in Edit, then run the PA again.";
  if (!clean(data.nomineeName)) return `Brisk PA: the nominee's name is missing, ${fix}`;
  const gender = clean(data.nomineeGender);
  if (!gender) return `Brisk PA: the nominee's gender is missing, ${fix}`;
  if (!BRISK_GENDERS.some((g) => g.toLowerCase() === gender.toLowerCase())) {
    return `Brisk PA: the nominee's gender "${gender.replace(/:/g, " -")}" is not one Brisk takes (${BRISK_GENDERS.join(" or ")}), ${fix}`;
  }
  const relation = clean(data.nomineeRelation);
  if (!relation) return `Brisk PA: the nominee's relation is missing, ${fix}`;
  if (!BRISK_RELATIONS.some((r) => r.toLowerCase() === relation.toLowerCase())) {
    return `Brisk PA: the nominee's relation "${relation.replace(/:/g, " -")}" is not one Brisk takes (${BRISK_RELATIONS.join(", ")}), ${fix}`;
  }
  return "";
}

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
    certificates = null,
  } = deps;
  const jobId = data._jobIdentifier || "";

  const failed = (error, certificateNo) => ({
    success: false,
    briskFailed: true,
    error,
    ...(certificateNo ? { certificateNo } : {}),
  });

  /** The PDF of a certificate that exists: never buys. */
  const storePdf = async (url, certificateNo) => {
    let pdfPath = null;
    try {
      pdfPath = await brisk.downloadBriskPDF(url, certificateNo);
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
  };

  const existing = await policies.findOne(
    { _id: policyId },
    { projection: { briskCertificate: 1 } }
  );
  if (hasCertificate(existing)) {
    const onPolicy = existing.briskCertificate;
    log(`[${jobId}] Brisk certificate already on the policy — nothing to buy.`);
    if (onPolicy.key || onPolicy.location) {
      return { success: true, alreadyExisted: true, certificateNo: onPolicy.certificateNo || null };
    }
    // Only its number: a run stopped before the PDF was stored (a restart while waiting for Brisk's file). "Completed" would
    // leave the policy with no PDF. The address comes from our own record, so this cannot reach the create API.
    const record = certificates
      ? await certificates.findOne({ certificateNo: onPolicy.certificateNo, status: "CREATED" }, { projection: { briskUrl: 1 } })
      : null;
    if (!record || !record.briskUrl) {
      return failed(
        `Brisk certificate ${onPolicy.certificateNo} is on the policy but its PDF is not stored, and its address was not found.`,
        onPolicy.certificateNo
      );
    }
    log(`[${jobId}] Its PDF is not stored yet — checking for it.`);
    const pdf = await storePdf(record.briskUrl, onPolicy.certificateNo);
    return pdf.success ? { ...pdf, alreadyExisted: true } : pdf;
  }

  const decision = brisk.shouldCreateBriskCertificate(data);
  if (!decision.create) {
    log(`[${jobId}] Brisk certificate not needed — ${decision.reason}.`);
    return { success: true, skipped: true, reason: decision.reason, certificateNo: null };
  }

  // nothing is bought until the nominee is what Brisk takes (two insurers / TP only)
  const nomineeProblem = briskNomineeProblem(data);
  if (nomineeProblem) {
    log(`[${jobId}] ${nomineeProblem}`);
    return failed(nomineeProblem);
  }

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
    if (created && created.alreadyExisted) {
      log(`[${jobId}] Brisk V2 confirmed a certificate already exists, but returned no certificate number. Skipping another purchase.`);
      return { success: true, alreadyExisted: true, certificateNo: null };
    }
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

  if (created.alreadyExisted) {
    log(`[${jobId}] Brisk certificate ${certificateNo} is already recorded; skipping creation and PDF download.`);
    return { success: true, alreadyExisted: true, certificateNo };
  }

  if (!created.downloadUrl) {
    return failed(
      `Brisk certificate ${certificateNo} was created but Brisk returned no download link, so the PDF is not stored.`,
      certificateNo
    );
  }
  return storePdf(created.downloadUrl, certificateNo);
}

module.exports = { runBriskPart, saveCertificateNo, hasCertificate, briskNomineeProblem, BRISK_RELATIONS, BRISK_GENDERS };
