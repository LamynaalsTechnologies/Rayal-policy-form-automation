/**
 * United India Risk Details, after the Vehicle Manufacturer and Make (the owner, 2026-11-13): the purchase and manufacture
 * dates of a NEW vehicle - all three from TODAY, in India time (a server on UTC would be a day early before 05:30 IST).
 *   Date of Purchase    <input name="dateOfPurchaseString" id="dtPurchaseStr" readonly
 *                              onclick="setYears(1900, 2050);showCalender(this, 'dateOfPurchaseString', 'registrationDateValidation','');">
 *                       -> today, "DD/MM/YYYY" (the format the old formFlow.js / autofill.js typed: "16/09/2025")
 *   Month (manufacture) <select name="makeMonthgc"> (NO id), options 01 January ... 12 December  -> this month ("11")
 *   Year (manufacture)  <input name="yearOfManufacturing" id="yearOfManufacturing" value="2026">  -> this year
 *
 * The Date of Purchase box is READONLY and its click opens the portal's own calendar, so it is never typed into or clicked:
 * the date is put in the box, its input / change events fire, and then the page's own check after a calendar pick
 * (`registrationDateValidation`, named in the box's onclick) is run when the page has it - what a person's pick does. A
 * popup (alert) it answers with is reported in the portal's words and not retried. NOT SEEN LIVE: whether the calendar
 * does more than that after a pick, and that the portal wants DD/MM/YYYY.
 *
 * Every box follows the owner's rule (./unitedIndiaSteps.js): entered, read back, once more if it did not take, a box that
 * is not on the page is its own error. The month is matched by its value ("11"), the year is left as it is when the
 * portal already shows this year. At the end all three are read once more: a box that changed when the next one was
 * entered (like New Vehicle resetting the state) stops the run with a sentence, tried again later.
 */
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { throwIfHeld } = require("../../../lib/holdStop");
const { indiaCalendarDay } = require("../../../lib/policyDates");
const {
  waitForShown,
  selectAndConfirm,
  fillAndConfirm,
  alertTextOf,
  takeOpenAlert,
  alertRefusal,
  notVisible,
  showOnScreen,
  TRIES,
} = require("./unitedIndiaSteps");

const STAGE = "united-india-risk";
const DATE_OF_PURCHASE = ["#dtPurchaseStr", "input[name='dateOfPurchaseString']"];
const MAKE_MONTH = ["select[name='makeMonthgc']", By.name("makeMonthgc")];
const MAKE_YEAR = ["#yearOfManufacturing", "input[name='yearOfManufacturing']"];
/** The page's own check after a calendar pick, as the Date of Purchase box's onclick names it. */
const PURCHASE_CHECK = "registrationDateValidation";
/**
 * The Policy Start Date on a proposal opened again (the owner, 2026-11-13):
 *   <input type="text" name="dateOfIssueOfPolicyString" value="13/11/2026" readonly id="dateOfIssueOfPolicyString"
 *          onclick="setYears(1900, 2050);showCalender(this, 'dateOfIssueOfPolicyString', 'polStartDateValidation','fuel');">
 * It keeps the day the proposal was made; United India refuses an older one ("N002219, PolicyInception Date should be on or
 * later to Proposal Date"), so it is put to TODAY, and the calendar's after-pick check runs with its own 'fuel'.
 */
const POLICY_START = ["#dateOfIssueOfPolicyString", "input[name='dateOfIssueOfPolicyString']"];
const POLICY_START_CHECK = { name: "polStartDateValidation", arg: "fuel" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n) => String(n).padStart(2, "0");

/** Today in India: { date: "13/11/2026", month: "11", monthName: "November", year: "2026" }. */
function todayInIndia(now = Date.now) {
  const [year, month, day] = indiaCalendarDay(new Date(now()));
  return { date: `${pad(day)}/${pad(month)}/${year}`, month: pad(month), monthName: MONTHS[month - 1], year: String(year) };
}

/**
 * In the page: put the date in the (readonly) box, fire its events, then run the page's own after-pick check when it has
 * one. Returns what the box holds and whether the check ran.
 */
function setDateInPage(el, value, checkName, checkArg) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  var check = "missing";
  var fn = checkName ? window[checkName] : null;
  if (typeof fn === "function") {
    try {
      // the calendar's after-pick check, with the box's own 4th showCalender argument when it has one ('fuel' on the start date)
      if (checkArg === undefined || checkArg === null) fn();
      else fn(checkArg);
      check = "ran";
    } catch (e) {
      check = "failed: " + String((e && e.message) || e);
    }
  }
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return { value: String(el.value), check: check };
}

/** The three boxes as the page holds them now (null = not on the page). */
function readDatesInPage() {
  var d = document.getElementById("dtPurchaseStr") || document.getElementsByName("dateOfPurchaseString")[0];
  var m = document.getElementsByName("makeMonthgc")[0];
  var y = document.getElementById("yearOfManufacturing") || document.getElementsByName("yearOfManufacturing")[0];
  return { date: d ? String(d.value) : null, month: m ? String(m.value) : null, year: y ? String(y.value) : null };
}

/** Run a page step; a portal alert() it meets is the portal's answer: [E308] in its words, not retried. */
async function portalStep(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(label, text, STAGE);
    throw e;
  }
}

/**
 * A date box with the portal's calendar (readonly or not): the date is put in by script - never clicked (the click opens
 * the calendar) nor typed - its input / change / blur events fire (an onblur check runs), then the page's own after-pick
 * check `checkName` when it has one. Read back, once more if it did not take; a popup = [E308] in the portal's words.
 * @param {Object} box  { label, target, date, checkName?, said? (what the date is, for the log), stage? }
 * @returns {Promise<{ tries: number, check: string }>}
 */
async function putDate(driver, { label, target, date, checkName = null, checkArg = null, said: what = "", stage = STAGE }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const findMs = 10000;
  let got = "";
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const el = await waitForShown(driver, target, findMs, o);
    if (!el) throw notVisible(label, Math.round(findMs / 1000), stage);
    await portalStep(label, () => showOnScreen(driver, el, o));
    throwIfHeld(driver);
    const out = await portalStep(label, () => driver.executeScript(setDateInPage, el, date, checkName, checkArg));
    throwIfHeld(driver);
    const late = await takeOpenAlert(driver); // a popup the check opened after it returned
    if (late !== null) throw alertRefusal(label, late, STAGE);
    await portalStep(label, () => waitForLoader(driver, "united india", { stage: STAGE }));
    got = await portalStep(label, () => el.getAttribute("value"));
    const check = (out && out.check) || "missing";
    if (String(got || "").trim() === date) {
      const said = !checkName
        ? ""
        : check === "ran"
          ? `the page's own date check (${checkName}) ran`
          : check === "missing"
            ? `the page has no ${checkName}, only the date was put in`
            : `the page's own date check (${checkName}) ${check}`;
      const notes = [what, said].filter(Boolean).join("; ");
      log(`✓ United India - ${label} = "${date}"${notes ? ` (${notes})` : ""}${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { tries: attempt, check };
    }
    if (attempt < TRIES) log(`↻ United India - ${label} reads "${got}" instead of "${date}" - putting it in once more`);
  }
  throw new MultiCompanyError(
    "E306",
    `United India - ${label} holds "${String(got || "").replace(/:/g, " -")}" instead of "${date}" after ${TRIES} tries, so the run stopped there. ` +
      "It will try again shortly.",
    { company: "united india", stage }
  );
}

/** Date of Purchase = `date` (today), with the page's after-pick check registrationDateValidation. */
const setPurchaseDate = (driver, date, o = {}) =>
  putDate(driver, { label: "Date of Purchase", target: DATE_OF_PURCHASE, date, checkName: PURCHASE_CHECK, said: "today, India time" }, o);

/**
 * Date of Purchase, Month and Year of Manufacture = today (India time).
 * @param {WebDriver} driver  on Risk Details, the Vehicle Manufacturer and Make chosen
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ dateOfPurchase: string, month: string, year: string }>}
 */
async function fillPurchaseAndManufacture(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const today = todayInIndia(o.now || Date.now);
  log(`📅 United India - Date of Purchase ${today.date}, Month and Year of Manufacture ${today.monthName} ${today.year} (today, India time)`);

  await setPurchaseDate(driver, today.date, { ...o, log });

  const month = await portalStep("Month of Manufacture", () =>
    selectAndConfirm(driver, { label: "Month of Manufacture", target: MAKE_MONTH, wanted: today.month, stage: STAGE }, { ...o, log })
  );
  await portalStep("Month of Manufacture", () => waitForLoader(driver, "united india", { stage: STAGE }));

  await portalStep("Year of Manufacture", () =>
    fillAndConfirm(driver, { label: "Year of Manufacture", target: MAKE_YEAR, value: today.year, stage: STAGE, keepIfSame: true }, { ...o, log })
  );
  await portalStep("Year of Manufacture", () => waitForLoader(driver, "united india", { stage: STAGE }));

  // all three once more: a box the next one changed is caught here, not on the portal's Compute
  const now = (await portalStep("Year of Manufacture", () => driver.executeScript(readDatesInPage))) || {};
  const changed = [
    now.date !== today.date && `the Date of Purchase reads "${now.date == null ? "" : now.date}" instead of "${today.date}"`,
    now.month !== today.month && `the Month of Manufacture reads "${now.month == null ? "" : now.month}" instead of "${today.month}"`,
    String(now.year == null ? "" : now.year).trim() !== today.year && `the Year of Manufacture reads "${now.year == null ? "" : now.year}" instead of "${today.year}"`,
  ].filter(Boolean);
  if (changed.length) {
    throw new MultiCompanyError(
      "E306",
      `United India - after the dates were entered ${changed.join(", and ").replace(/:/g, " -")}, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  log(`✅ United India - Date of Purchase ${today.date}, Month of Manufacture ${month.text} and Year of Manufacture ${today.year} entered`);
  return { dateOfPurchase: today.date, month: today.month, year: today.year };
}

/**
 * Policy Start Date = today (India time) - a proposal opened again from Proposal Modification, BEFORE High Risk (the owner,
 * 2026-11-13). Read back; United India's "Error In Data Entry" box after it stops the run in its words.
 * @returns {Promise<{ policyStart: string }>}
 */
async function setPolicyStartToday(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const today = todayInIndia(o.now || Date.now);
  const before = await portalStep("Policy Start Date", () =>
    driver.executeScript("var e = document.getElementById('dateOfIssueOfPolicyString'); return e ? String(e.value) : null;")
  );
  log(`📅 United India - Policy Start Date ${before ? `"${before}" -> ` : ""}${today.date} (today, India time - the proposal's old day is refused)`);
  await putDate(
    driver,
    { label: "Policy Start Date", target: POLICY_START, date: today.date, checkName: POLICY_START_CHECK.name, checkArg: POLICY_START_CHECK.arg, said: "today, India time" },
    { ...o, log }
  );
  await require("./unitedIndiaNavigate").throwIfPortalError(driver, "Policy Start Date", STAGE);
  return { policyStart: today.date };
}

module.exports = {
  setPolicyStartToday,
  POLICY_START,
  POLICY_START_CHECK,
  fillPurchaseAndManufacture,
  setPurchaseDate,
  putDate,
  todayInIndia,
  setDateInPage,
  readDatesInPage,
  DATE_OF_PURCHASE,
  MAKE_MONTH,
  MAKE_YEAR,
  PURCHASE_CHECK,
};
