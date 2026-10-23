/**
 * Reliance OD needs the customer's existing third-party (TP) policy — number, insurer, start and end date — on its
 * "Two Wheeler Own Damage" form (2026-10-22). The owner's rule: a Reliance OD part NEVER starts without them.
 *
 *   - OD only (one insurer, Reliance): the operator types them on the Online Policy form (required there).
 *   - Reliance OD + KSHEMA / National TP: the TP policy is bought first and its details arrive later; the operator
 *     enters them in Edit -> Status (TP proposal Completed) or Edit -> TP policy details, which re-queues the OD part.
 *
 * The details are often saved AFTER the job was queued, so the part runner reads them from the policy itself
 * (`freshTpDetails`) just before the gate is asked — before any browser or login.
 */
const { formatPolicyDate } = require("./policyDates");

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

/** The four fields, in the order they are named to the operator. */
const TP_FIELDS = [
  ["existingTpPolicyNumber", "TP policy number"],
  ["existingTpInsurer", "TP insurer"],
  ["existingTpStartDate", "TP start date"],
  ["existingTpEndDate", "TP end date"],
];

/** The policy-document projection the part runner adds to its policy read. */
const TP_PROJECTION = Object.fromEntries(TP_FIELDS.map(([f]) => [f, 1]));

/** The policy's saved values as job form data (dates in India time, the portal format). Only the fields it has. */
const freshTpDetails = (policyDoc) => {
  const out = {};
  if (!policyDoc) return out;
  for (const [field] of TP_FIELDS) {
    const v = policyDoc[field];
    if (v === undefined || v === null || v === "") continue;
    out[field] = /Date$/.test(field) ? formatPolicyDate(v) : String(v).trim();
  }
  return out;
};

/** Is this part the Reliance OD part (OD only, or the OD half of a two-insurer policy)? */
const isRelianceOdPart = (part, formData = {}) =>
  !!part && part.kind === "portal" && part.key === "od" && norm(part.company || formData.Companyname) === "reliance";

/**
 * The outcome that stops a Reliance OD part whose TP details are not all there, or null when it may run.
 * "stopped" = no automatic retry (no loop); saving the details re-queues it.
 */
const missingTpDetails = (part, formData = {}) => {
  if (!isRelianceOdPart(part, formData)) return null;
  const missing = TP_FIELDS.filter(([f]) => !String(formData[f] == null ? "" : formData[f]).trim()).map(([, label]) => label);
  if (!missing.length) return null;
  return {
    type: "stopped",
    error:
      `Reliance OD is waiting for the TP policy details (missing ${missing.join(", ")}). ` +
      "Enter them in Edit then TP policy details, and the OD runs again",
    errorCode: "E101",
    errorType: "ValidationError",
    stage: "waiting-tp-details",
  };
};

module.exports = { TP_FIELDS, TP_PROJECTION, freshTpDetails, isRelianceOdPart, missingTpDetails };
