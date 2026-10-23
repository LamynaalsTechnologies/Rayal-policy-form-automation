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
 *
 * Two insurers, dates not entered (the owner, 2026-10-23): the TP policy is bought by us, now, so its dates need not be typed.
 * START = today (India), END = the year selection of the policy ("No of Year", `paCoverYears`: 1 to 5, default 1) after
 * it, the day before the anniversary — how insurers print a policy period (start 23-10-2026, 1 year = end 22-10-2027).
 * Only a date that is EMPTY is worked out (`defaultTpDates`); one that is given stays as it is, and OD only (one
 * insurer, typed on the form) is never touched. The number and the insurer can never be guessed.
 */
const { formatPolicyDate, indiaCalendarDay } = require("./policyDates");

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

/** The four fields, in the order they are named to the operator. */
const TP_FIELDS = [
  ["existingTpPolicyNumber", "TP policy number"],
  ["existingTpInsurer", "TP insurer"],
  ["existingTpStartDate", "TP start date"],
  ["existingTpEndDate", "TP end date"],
];

/** The policy-document projection the part runner adds to its policy read (the year selection decides the end date). */
const TP_PROJECTION = { ...Object.fromEntries(TP_FIELDS.map(([f]) => [f, 1])), paCoverYears: 1 };

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

const pad = (n) => String(n).padStart(2, "0");
const dayText = ([y, m, d]) => `${pad(d)}-${pad(m)}-${y}`;

/** "DD-MM-YYYY" (also / or .) of a real calendar day -> [year, month, day], else null. */
const parseDay = (text) => {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(String(text == null ? "" : text).trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? [y, mo, d] : null;
};

/** The year selection a policy was sold with: a whole number from 1 to 5, anything else (nothing, "", 0, 7) is 1. */
const tpYearsOf = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : 1;
};

/** The last day of a policy of `years` year(s) that starts on [y, m, d]: the day before the anniversary (29 Feb rolls to 1 Mar first). */
const endDayOf = ([y, m, d], years) => {
  const t = new Date(Date.UTC(y + years, m - 1, d));
  t.setUTCDate(t.getUTCDate() - 1);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};

/**
 * The TP dates worked out for a Reliance OD part of a TWO-INSURER policy when they are not entered, or null when nothing is
 * to be worked out (not that part, one insurer, both dates given, or a start date that is not a date — that one is reported
 * as it is by the OD form's own check, not replaced).
 *
 *   start empty  -> today in India; end empty -> `years` after the start (the given one, else today).
 *
 * @param {Object} part
 * @param {Object} formData  the part's form data (dates as DD-MM-YYYY text, "" when empty; `settings.isMultipleCompany`)
 * @param {Object} [o]
 * @param {*} [o.years]      the policy's "No of Year" (paCoverYears)
 * @param {Date} [o.now]
 * @returns {{fields:Object, note:string}|null}
 */
const defaultTpDates = (part, formData = {}, { years, now = new Date() } = {}) => {
  if (!isRelianceOdPart(part, formData)) return null;
  const settings = formData.settings;
  if (!settings || settings.isMultipleCompany !== true) return null;
  const empty = (f) => !String(formData[f] == null ? "" : formData[f]).trim();
  const needStart = empty("existingTpStartDate");
  const needEnd = empty("existingTpEndDate");
  if (!needStart && !needEnd) return null;
  const startDay = needStart ? indiaCalendarDay(now) : parseDay(formData.existingTpStartDate);
  if (!startDay) return null;
  const n = tpYearsOf(years);
  const fields = {};
  const said = [];
  if (needStart) {
    fields.existingTpStartDate = dayText(startDay);
    said.push(`start ${fields.existingTpStartDate} (today)`);
  }
  if (needEnd) {
    fields.existingTpEndDate = dayText(endDayOf(startDay, n));
    said.push(`end ${fields.existingTpEndDate} (${n} year${n > 1 ? "s" : ""} selected)`);
  }
  return { fields, note: `Existing TP policy dates not entered, so they are worked out - ${said.join(", ")}` };
};

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

module.exports = { TP_FIELDS, TP_PROJECTION, freshTpDetails, isRelianceOdPart, missingTpDetails, defaultTpDates, tpYearsOf, endDayOf, parseDay };
