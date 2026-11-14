/**
 * United India Risk Details, after the Pin Code (the owner, 2026-11-13): the customer's contact details and date of birth.
 *   Mobile         <input name="mobile" id="mobile" maxlength="10" class="newNumericClass">  -> the policy's mobile number,
 *                  10 digits (a +91 / 91 / 0 in front is dropped)
 *   Email          <input name="emailAddress" id="emailAddress" maxlength="200" onblur="validateEmail(this.value)">
 *                  -> the policy's email; typed, then the box is LEFT so the portal's validateEmail() runs
 *   Date of Birth  <input name="dateOfBirthString" id="dateOfBirthString" maxlength="30"
 *                         onclick="setYears(1900, 2050);showCalender(this, 'dateOfBirthString', 'normal','');"
 *                         onblur="checkDateValidation(this.value)">
 *                  -> the policy's date of birth as DD/MM/YYYY (the Date of Purchase's format). Its click opens the
 *                  portal's calendar, so it is put in by script, never clicked; its blur event runs checkDateValidation().
 * The boxes with an onblur are emptied quietly (Selenium's clear() would leave them empty and run the check on nothing).
 * Everything the policy must give is checked BEFORE the page is touched; a popup = [E308] in the portal's words; every box
 * is on the screen while it is filled (the video), read back, and all three are read once more at the end.
 */
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { throwIfHeld } = require("../../../lib/holdStop");
const { fillAndConfirm, waitForShown, alertTextOf, takeOpenAlert, alertRefusal, notVisible, leaveBoxInPage } = require("./unitedIndiaSteps");
const { putDate } = require("./unitedIndiaDates");

const STAGE = "united-india-risk";
const MOBILE = { label: "Mobile", target: ["#mobile", "input[name='mobile']"] };
const EMAIL = { label: "Email", target: ["#emailAddress", "input[name='emailAddress']"] };
const DOB = { label: "Date of Birth", target: ["#dateOfBirthString", "input[name='dateOfBirthString']"] };

/** The policy's mobile number: 10 digits, a leading +91 / 91 / 0 dropped; "" when it is not a 10-digit number. */
function mobileOf(data = {}) {
  let digits = String(data.mobile == null ? (data.mobileNumber == null ? "" : data.mobileNumber) : data.mobile).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^\d{10}$/.test(digits) ? digits : "";
}

/** The policy's email, trimmed and lower case; "" when it does not look like one. */
function emailOf(data = {}) {
  const email = String(data.email == null ? "" : data.email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

/**
 * The policy's date of birth ("DD-MM-YYYY" on the job, or an ISO date) as United India's "DD/MM/YYYY"; "" when it is not a
 * real day in the past.
 */
function dobOf(data = {}, now = Date.now) {
  const raw = String(data.dob == null ? "" : data.dob).trim();
  let d;
  let m;
  let y;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return "";
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return ""; // 31-02 is no day
  if (day.getTime() > now()) return "";
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** A portal alert() met on the way is its answer: [E308] in its words, not retried. */
async function portalStep(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(label, text, STAGE);
    throw e;
  }
}

/** The three boxes as the page holds them now. */
function readContactInPage() {
  var v = function (id) {
    var el = document.getElementById(id);
    return el ? String(el.value) : null;
  };
  return { mobile: v("mobile"), email: v("emailAddress"), dob: v("dateOfBirthString") };
}

/**
 * @param {WebDriver} driver  on Risk Details, the Pin Code's District filled
 * @param {Object} data       the job data (mobile, email, dob)
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ mobile: string, email: string, dob: string }>}
 */
async function fillContactDetails(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const loader = (label) => portalStep(label, () => waitForLoader(driver, "united india", { stage: STAGE }));

  // the policy first: nothing on the page is touched when a value is missing or not usable
  const mobile = mobileOf(data);
  const email = emailOf(data);
  const dob = dobOf(data, o.now || Date.now);
  const missing = [
    !mobile && `no 10-digit Mobile Number${data.mobile ? ` ("${String(data.mobile).replace(/:/g, " -")}")` : ""}`,
    !email && `no usable Email${data.email ? ` ("${String(data.email).replace(/:/g, " -")}")` : ""}`,
    !dob && `no usable Date of Birth${data.dob ? ` ("${String(data.dob).replace(/:/g, " -")}")` : ""}`,
  ].filter(Boolean);
  if (missing.length) {
    throw new MultiCompanyError(
      "E306",
      `United India - the policy has ${missing.join(", and ")}, so the contact details cannot be filled and the run stopped there. Correct the policy, then run it again.`,
      { company: "united india", stage: STAGE, retryable: false }
    );
  }
  log(`📞 United India - Mobile ${mobile}, Email ${email}, Date of Birth ${dob}`);

  await portalStep(MOBILE.label, () => fillAndConfirm(driver, { label: MOBILE.label, target: MOBILE.target, value: mobile, stage: STAGE }, { ...o, log }));
  await loader(MOBILE.label);

  // Email: typed (emptied quietly), then the box is left - the portal's validateEmail() runs on it
  await portalStep(EMAIL.label, () =>
    fillAndConfirm(driver, { label: EMAIL.label, target: EMAIL.target, value: email, stage: STAGE, clearQuietly: true }, { ...o, log })
  );
  const emailBox = await waitForShown(driver, EMAIL.target, 5000, o);
  if (!emailBox) throw notVisible(EMAIL.label, 5, STAGE);
  throwIfHeld(driver);
  await portalStep(EMAIL.label, () => driver.executeScript(leaveBoxInPage, emailBox));
  const late = await takeOpenAlert(driver);
  if (late !== null) throw alertRefusal(EMAIL.label, late, STAGE);
  await loader(EMAIL.label);

  // Date of Birth: put in by script (its click opens the calendar); its blur event runs checkDateValidation()
  await putDate(driver, { label: DOB.label, target: DOB.target, date: dob, said: "the policy's date of birth" }, { ...o, log });
  await loader(DOB.label);

  // all three once more
  const now = (await portalStep(DOB.label, () => driver.executeScript(readContactInPage))) || {};
  const wrong = [
    String(now.mobile || "").trim() !== mobile && `Mobile reads "${now.mobile}" instead of "${mobile}"`,
    String(now.email || "").trim().toLowerCase() !== email && `Email reads "${now.email}" instead of "${email}"`,
    String(now.dob || "").trim() !== dob && `Date of Birth reads "${now.dob}" instead of "${dob}"`,
  ].filter(Boolean);
  if (wrong.length) {
    throw new MultiCompanyError(
      "E306",
      `United India - after the contact details were entered ${wrong.join(", and ").replace(/:/g, " -")}, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  log(`✅ United India - Mobile, Email and Date of Birth entered`);
  return { mobile, email, dob };
}

module.exports = { fillContactDetails, mobileOf, emailOf, dobOf, readContactInPage, MOBILE, EMAIL, DOB };
