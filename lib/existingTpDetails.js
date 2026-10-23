/**
 * The customer's EXISTING third party policy, checked for the Reliance OD form (2026-10-23).
 *
 * Reliance's own-damage page has an "existing third party insurance" panel: policy number, insurer (KSHEMA General Insurance
 * Limited or National Insurance Company Limited), start date and end date. The four values are saved on the policy by the
 * Online Policy form / Edit then TP policy details, and `lib/existingTpGate.js` stops an OD part that has none. The gate only
 * asks "is it filled" — it passes "Invalid date", a third insurer or a one-letter number. THIS file is the exact check, made
 * BEFORE any window opens (relianceMultiForm.js [MC] 12): a data problem is reported at once, in a plain sentence, instead of
 * after a login, a captcha and a filled form, and it is not retried (a re-run cannot mend it, a person has to).
 *
 * Auto-reading these values from the TP insurer's portal is NOT built (the owner: a later step); today they are what the
 * operator saved.
 *
 * Operator sentences carry ONE colon, right after the label (lib/errorHandler.js beautifyError keeps only the text after the
 * last one), never the driver's text, and end with what to do. Everything here is pure: no database, no browser.
 */
const LABEL = "Reliance OD";
const FIX = "Enter it in Edit then TP policy details, then run the policy again.";

const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

/** The same shape the backend accepts (shared/existingTpPolicy.js): letters, digits and / - . space, 3 to 40 characters. */
const POLICY_NUMBER = /^[A-Z0-9][A-Z0-9/\-. ]{1,38}[A-Z0-9]$/;

/** The two insurers the owner chose: how the policy spells them, and the key the page's list is matched with. */
const INSURERS = {
  kshema: { key: "kshema", label: "KSHEMA", pageName: "KSHEMA General Insurance Limited" },
  national: { key: "national", label: "National", pageName: "National Insurance Company Limited" },
};

/** An error a person has to fix: `nonRetryable` becomes `retryable: false` in the Reliance form's catch (like TitleError). */
class ExistingTpError extends Error {
  constructor(message, { reason = "" } = {}) {
    super(message);
    this.name = "ExistingTpError";
    this.reason = reason;
    this.nonRetryable = true;
  }
}

/** "KSHEMA" / "National" / "kshema general insurance limited" -> the insurer, else null. Case, spaces and punctuation ignored. */
function insurerOf(value) {
  const key = clean(value).toLowerCase().replace(/[^a-z]+/g, "");
  if (!key) return null;
  if (key === "kshema" || key.startsWith("kshemageneral")) return INSURERS.kshema;
  if (key === "national" || key.startsWith("nationalinsurance")) return INSURERS.national;
  return null;
}

/** "DD-MM-YYYY" (also / or . between) of a REAL calendar day -> { text, day } (day = a number that orders days), else null. */
function parseDay(value) {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(clean(value));
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  const stamp = Date.UTC(y, mo - 1, d);
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return { text: `${pad(d)}-${pad(mo)}-${y}`, day: Math.round(stamp / 86400000) };
}

/**
 * The existing-TP details of this job, validated.
 *
 * @param {Object} data  the job data (existingTpPolicyNumber / Insurer / StartDate / EndDate, dates as DD-MM-YYYY text)
 * @returns {{policyNumber:string, insurer:{key:string,label:string,pageName:string}, startDate:string, endDate:string}}
 * @throws {ExistingTpError}
 */
function validateExistingTpDetails(data = {}) {
  const policyNumber = clean(data.existingTpPolicyNumber).toUpperCase();
  if (!POLICY_NUMBER.test(policyNumber)) {
    throw new ExistingTpError(
      `${LABEL}: the customer's existing TP policy number ${policyNumber ? `"${policyNumber}" is not a policy number (3 to 40 letters, digits and / - .)` : "is missing"}, so the run stopped before opening the portal. ${FIX}`,
      { reason: "number" }
    );
  }
  const insurer = insurerOf(data.existingTpInsurer);
  if (!insurer) {
    const given = clean(data.existingTpInsurer);
    throw new ExistingTpError(
      `${LABEL}: the existing TP insurer ${given ? `"${given.replace(/:/g, " -")}" is not KSHEMA or National` : "is missing"}, so the run stopped before opening the portal. ${FIX}`,
      { reason: "insurer" }
    );
  }
  const start = parseDay(data.existingTpStartDate);
  const end = parseDay(data.existingTpEndDate);
  const bad = (name, raw) => `${LABEL}: the existing TP policy ${name} date ${clean(raw) ? `"${clean(raw).replace(/:/g, " -")}" is not a date (DD-MM-YYYY)` : "is missing"}, so the run stopped before opening the portal. ${FIX}`;
  if (!start) throw new ExistingTpError(bad("start", data.existingTpStartDate), { reason: "start" });
  if (!end) throw new ExistingTpError(bad("end", data.existingTpEndDate), { reason: "end" });
  if (end.day <= start.day) {
    throw new ExistingTpError(
      `${LABEL}: the existing TP policy end date ${end.text} is not after its start date ${start.text}, so the run stopped before opening the portal. ${FIX}`,
      { reason: "order" }
    );
  }
  return { policyNumber, insurer, startDate: start.text, endDate: end.text };
}

/** The form's call (relianceMultiForm.js [MC] 12): the validated details, with the progress in the log. */
function requireExistingTpDetails(data, { jobId = "", log = (line) => console.log(line) } = {}) {
  const tag = jobId ? `[${jobId}] ` : "";
  const tp = validateExistingTpDetails(data);
  log(`${tag}📋 Existing TP policy ${tp.policyNumber} at ${tp.insurer.pageName}, ${tp.startDate} to ${tp.endDate}.`);
  return tp;
}

module.exports = { requireExistingTpDetails, validateExistingTpDetails, ExistingTpError, insurerOf, parseDay, INSURERS, POLICY_NUMBER };
