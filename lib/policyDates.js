/**
 * Policy dates as the insurers' portals want them — read in INDIA time, whatever
 * timezone the server happens to run in.
 *
 * Why this exists: the date pickers on the Online Policy form make a Date at
 * LOCAL MIDNIGHT IN INDIA and send it with toISOString(), so 16 Oct 2000 is
 * stored as 2000-10-15T18:30:00.000Z. The job payload used to turn that into
 * text with `moment(value).format("DD-MM-YYYY")`, and moment formats in the
 * timezone of the machine that runs it: IST gives 16-10-2000 (right), a server
 * on UTC gives 15-10-2000 — a nominee DOB (and every other policy date) one day
 * early, on production only. The stored instant was never wrong; only the text
 * made from it was.
 *
 * `Intl` with an explicit zone has no such dependency, and it uses the same
 * IANA timezone data as the browser that made the date — so a date from the
 * 1941-45 war years (India ran on +06:30 then) comes back as the day the person
 * picked, which a fixed +05:30 would not give. The fixed offset is only the
 * fallback for a runtime without zone data.
 *
 * NO requires on purpose: the backend (RayalBrokers-backend/shared/) and the
 * automation server (Rayal-policy-form-automation/lib/) keep byte-identical
 * copies of this file, like jobPartsCore.js and tpVehicle.js — change both
 * together (`cmp` them; test/sharedCore.test.js checks it).
 */

const IST_ZONE = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330; // India has no DST: +05:30 all year
const PORTAL_DATE_FORMAT = "DD-MM-YYYY";

/** The day part of an ISO-looking string ("2000-10-16", "2000-10-16T18:30:00.000Z"). */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/;

/**
 * Is this a day that exists? `new Date("2000-02-31")` does NOT say no — it rolls over to 2 March — while moment
 * (what the payload builders used) rejected it. A rolled-over date is worse than an error, so ISO-looking text is
 * checked here before it is ever parsed.
 */
const isRealDay = (year, month, day) => {
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
  );
};

const pad = (n, width = 2) => String(n).padStart(width, "0");

/** Fill the YYYY / MM / DD tokens of `format`. The portals only ever need those three. */
const applyFormat = (format, year, month, day) =>
  String(format).replace(/YYYY|MM|DD/g, (token) =>
    token === "YYYY" ? pad(year, 4) : token === "MM" ? pad(month) : pad(day)
  );

/**
 * The calendar day of an instant in India, as [year, month 1-12, day].
 *
 * @param {Date} date a valid Date
 * @returns {number[]}
 */
const indiaCalendarDay = (date) => {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: IST_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const pick = (type) => Number(parts.find((p) => p.type === type).value);
    const day = [pick("year"), pick("month"), pick("day")];
    if (day.every((n) => Number.isFinite(n))) return day;
  } catch (e) {
    // No zone data in this runtime: fall through to the fixed offset.
  }
  const shifted = new Date(date.getTime() + IST_OFFSET_MINUTES * 60000);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
};

/**
 * A policy date (Date, ISO string, epoch ms, or an EJSON `{ $date }`) as text in
 * India time — "DD-MM-YYYY" unless another YYYY / MM / DD format is asked for.
 *
 * Matches what the payload builders did before, apart from the timezone:
 *   - nothing there (null, undefined, "", 0)  -> ""
 *   - something that is not a date             -> "Invalid date"
 *
 * @param {Date|string|number|{$date: *}|null|undefined} value
 * @param {string} [format] built from YYYY, MM and DD
 * @returns {string}
 */
const formatPolicyDate = (value, format = PORTAL_DATE_FORMAT) => {
  if (!value) return "";
  const raw = value.$date ? value.$date : value;

  if (typeof raw === "string") {
    const text = raw.trim();
    const iso = ISO_DAY.exec(text);
    if (iso) {
      const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
      if (!isRealDay(year, month, day)) return "Invalid date";
      // A bare "2000-10-16" names a calendar day — there is no instant to shift.
      if (text.length === 10) return applyFormat(format, year, month, day);
    }
  }

  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) return "Invalid date";

  const [year, month, day] = indiaCalendarDay(date);
  return applyFormat(format, year, month, day);
};

module.exports = {
  formatPolicyDate,
  indiaCalendarDay,
  IST_ZONE,
  IST_OFFSET_MINUTES,
  PORTAL_DATE_FORMAT,
};
