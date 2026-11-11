/**
 * Reliance's Appointee Name (the owner, 2026-11-11). The Online Policy now lets a Reliance nominee be UNDER 18, and then
 * (only then) asks the Appointee Name. The owner, for the automation: type it only when the nominee is under 18.
 *   - nominee 18 or older: the Appointee box is NOT touched, even when the policy carries a name (it is optional there);
 *   - nominee under 18: the policy's Appointee Name is typed and READ BACK, once more if it did not take (the owner's rule
 *     for every field); a box that is not on the page, or never holds the name, stops the run with one sentence; a policy
 *     with no Appointee Name for an under-18 nominee stops before anything is typed;
 *   - a date of birth that cannot be read: the box is left alone (the age is unknown), said in the log.
 * Before: the name was set by script whenever the policy had one, never read back, and a failure only logged.
 *
 * The age is counted on today's date in India, from the policy's Nominee DOB as the job carries it ("DD-MM-YYYY",
 * lib/policyDates.js; "DD/MM/YYYY" also read). A stop is a deliberate one (`stop`, the form's stopper): not retried.
 */
const moment = require("moment");

const APPOINTEE_ID = "Appointee_Name";
const ADULT_AGE = 18;
const TRIES = 2;
const SHOW_WAIT_MS = 8000;
const POLL_MS = 250;

/** Whole years on today's date in India, or null when the date cannot be read (or is in the future). */
function nomineeAgeOf(dob, now = new Date()) {
  const d = moment(String(dob == null ? "" : dob).trim(), ["DD-MM-YYYY", "DD/MM/YYYY", "YYYY-MM-DD"], true);
  if (!d.isValid()) return null;
  const today = moment(now).utcOffset(330);
  const born = moment.utc([d.year(), d.month(), d.date()]);
  const todayDay = moment.utc([today.year(), today.month(), today.date()]);
  if (born.isAfter(todayDay)) return null;
  return todayDay.diff(born, "years");
}

const sameName = (a, b) => String(a == null ? "" : a).replace(/\s+/g, " ").trim().toUpperCase() === String(b == null ? "" : b).replace(/\s+/g, " ").trim().toUpperCase();

/** In the page: the box's state - { exists, shown, value }. */
const readBox = (driver) =>
  driver
    .executeScript(
      `var e = document.getElementById("${APPOINTEE_ID}");
       if (!e) return { exists: false };
       var s = window.getComputedStyle(e);
       var shown = !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length) && s.visibility !== "hidden" && s.display !== "none";
       return { exists: true, shown: shown, value: String(e.value || "") };`
    )
    .catch(() => ({ exists: false }));

/** In the page: type the name the way the portal reads a typed value (value + input / change / blur). */
const typeInto = (driver, value) =>
  driver.executeScript(
    `var e = document.getElementById("${APPOINTEE_ID}");
     if (!e) return false;
     e.focus();
     e.value = arguments[0];
     e.dispatchEvent(new Event("input", { bubbles: true }));
     e.dispatchEvent(new Event("change", { bubbles: true }));
     e.dispatchEvent(new Event("blur", { bubbles: true }));
     return true;`,
    value
  );

/**
 * @param {WebDriver} driver  on Reliance's quote page, nominee block filled up to here
 * @param {{ nomineeDob?: string, appointeeName?: string }} data  the job data
 * @param {{ log?: Function, stop: Function, now?: Function, sleep?: Function }} o  `stop(message, details)` ends the run
 * @returns {Promise<{ typed: boolean, age: number|null, reason: string }>}
 */
async function fillAppointeeIfMinor(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => driver.sleep(ms));
  const stage = "reliance-appointee";
  const age = nomineeAgeOf(data.nomineeDob, new Date(now()));

  if (age === null) {
    log(`Appointee Name not typed - the nominee's date of birth "${data.nomineeDob || ""}" could not be read`);
    return { typed: false, age, reason: "dob-unreadable" };
  }
  if (age >= ADULT_AGE) {
    log(`Appointee Name not typed - the nominee is ${age}, an appointee is needed only under ${ADULT_AGE}`);
    return { typed: false, age, reason: "adult" };
  }

  const name = String(data.appointeeName || "").replace(/\s+/g, " ").trim();
  if (!name) {
    o.stop(
      `Reliance - the nominee is ${age} years old (under ${ADULT_AGE}) but the policy has no Appointee Name, so the run stopped before it. Enter the Appointee Name on the policy, then run it again.`,
      { stage }
    );
  }

  // The box: Reliance may show it only once the under-18 date of birth is in - wait for it a moment
  const deadline = now() + SHOW_WAIT_MS;
  let box = await readBox(driver);
  while (!(box.exists && box.shown) && now() < deadline) {
    await sleep(POLL_MS);
    box = await readBox(driver);
  }
  if (!box.exists || !box.shown) {
    o.stop(
      `Reliance - the nominee is ${age} years old (under ${ADULT_AGE}) but Reliance's Appointee Name box is ${box.exists ? "not visible" : "not on the page"} (after ${SHOW_WAIT_MS / 1000} seconds), so the run stopped there.`,
      { stage }
    );
  }

  for (let attempt = 1; attempt <= TRIES; attempt++) {
    if (sameName(box.value, name)) {
      log(`✓ Reliance - Appointee Name = "${name}" (the nominee is ${age})${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { typed: true, age, reason: "minor" };
    }
    await typeInto(driver, name);
    box = await readBox(driver);
    if (sameName(box.value, name)) {
      log(`✓ Reliance - Appointee Name = "${name}" (the nominee is ${age})${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { typed: true, age, reason: "minor" };
    }
    if (attempt < TRIES) log(`↻ Reliance - the Appointee Name box shows "${box.value || ""}" instead of "${name}" - typing it once more`);
  }
  o.stop(`Reliance - the Appointee Name box shows "${box.value || ""}" instead of "${name}" after ${TRIES} tries, so the run stopped there.`, { stage });
  return { typed: false, age, reason: "not-held" }; // (stop throws; kept for a stop that only records)
}

module.exports = { fillAppointeeIfMinor, nomineeAgeOf, APPOINTEE_ID, ADULT_AGE };
