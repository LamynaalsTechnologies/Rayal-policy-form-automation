/**
 * United India: a proposal an earlier run made, opened again (the owner, 2026-11-13: "the proposal is finished - resume with
 * it"). After the login, Policy Transaction > Proposal Modification (./unitedIndiaMenu.js), then on that page:
 *   <input name="fromRefDateString" id="fromRefDateString" onclick="...showCalender(...)">  = the saved Reference Date
 *   <input name="toRefDateString" id="toRefDateString" onclick="...">                       = TODAY (the owner, 2026-11-14: a
 *                 resume puts the Policy Start Date to today and Modify, which moves the proposal's Reference Date to today -
 *                 a search for the saved day alone no longer finds it, as his live run showed)
 *   <input type="submit" name="fetch" value="Fetch">                                       -> the list, after the loader
 *   <table id="data">  Select (radio name="proposalOption") | Proposal Number | Reference Date | Insured Name | Total Premium
 *   OUR proposal number's row (exact) -> its radio; Next <input type="submit" name="next" value="Next" id="updt">
 *   -> the proposal page opens. (What comes there - the KYC - is the owner's next step.)
 *
 * The portal checks the list's FIRST radio itself: Next is pressed only when the checked radio is read back in OUR row -
 * never with another customer's proposal (the Reliance Pending Quotes lesson, 2026-10-14). Our number not in the list =
 * [E306], not retried: the number or the date on the policy is wrong (Edit -> Status). The date boxes are calendar boxes:
 * the date is put in by script, never clicked (./unitedIndiaDates.js putDate). Page links under the list ("1 | 2 | ...")
 * are followed when our number is not on the first page (their markup is NOT seen live yet - a link whose text is the
 * next page number).
 */
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { firstVisible } = require("../../common/elements");
const { throwIfHeld } = require("../../../lib/holdStop");
const { putDate, todayInIndia } = require("./unitedIndiaDates");
const { clickAndConfirm } = require("./unitedIndiaSteps");
const { pressAndWatch, clickToNextPage } = require("./unitedIndiaNavigate");

const STAGE = "united-india-proposal-modification";
const FROM_DATE = ["#fromRefDateString", "input[name='fromRefDateString']"];
const TO_DATE = ["#toRefDateString", "input[name='toRefDateString']"];
const FETCH = { label: "Fetch", target: ["input[type='submit'][name='fetch']", "input[name='fetch']", By.xpath("//input[@type='submit' and @value='Fetch']")] };
// Next carries id="updt" like the Risk Details page's Update picture - it is found by its name, never by that id
const NEXT = { label: "Next", target: ["input[type='submit'][name='next']", By.xpath("//input[@type='submit' and @name='next' and @value='Next']")] };
/** How long Fetch / a page link may take to show the list. */
const LIST_WAIT_MS = 20000;
/** The most list pages looked through. */
const MAX_PAGES = 20;

/**
 * In the page: the proposals in table#data - { table, rows: [{ option, number, date, name, premium, checked }], checked }.
 * Columns found by their headings (Proposal Number, Reference Date, Insured Name, Total Premium), else the owner's order.
 */
function readProposalListInPage() {
  var t = document.getElementById("data");
  var out = { table: !!t, rows: [], checked: 0 };
  if (!t) return out;
  var text = function (el) {
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
  };
  var col = { number: 1, date: 2, name: 3, premium: 4 };
  var heads = t.querySelectorAll("th");
  for (var h = 0; h < heads.length; h++) {
    var w = text(heads[h]).toLowerCase();
    if (/proposal\s*number/.test(w)) col.number = h;
    else if (/reference\s*date/.test(w)) col.date = h;
    else if (/insured\s*name/.test(w)) col.name = h;
    else if (/premium/.test(w)) col.premium = h;
  }
  var trs = t.querySelectorAll("tr");
  for (var i = 0; i < trs.length; i++) {
    var radio = trs[i].querySelector("input[type='radio'][name='proposalOption']");
    if (!radio) continue;
    var td = trs[i].querySelectorAll("td");
    var row = { option: String(radio.value), number: text(td[col.number]).replace(/\s+/g, ""), date: text(td[col.date]), name: text(td[col.name]), premium: text(td[col.premium]), checked: !!radio.checked };
    if (row.checked) out.checked += 1;
    out.rows.push(row);
  }
  return out;
}

const readList = async (driver) => (await driver.executeScript(readProposalListInPage).catch(() => null)) || { table: false, rows: [], checked: 0 };

/** The radio of the row whose Proposal Number cell is exactly `number` (digits only - checked by the caller). */
const radioOf = (number) => [By.xpath(`//table[@id='data']//tr[td[normalize-space(.)='${number}']]//input[@type='radio' and @name='proposalOption']`)];
/** The link to list page `n` after the list ("1 | 2 | ..." - not seen live yet). */
const pageLinkOf = (n) => [By.xpath(`//table[@id='data']/following::a[normalize-space(.)='${n}']`)];

/** OUR row is the one checked, and only it. */
const ourRowChecked = async (driver, number) => {
  const list = await readList(driver);
  const row = list.rows.find((r) => r.number === number);
  return !!row && row.checked && list.checked === 1;
};

const notListed = (number, date, seen, pages, to = date) => {
  const span = to && to !== date ? `${date} to ${to}` : date;
  const listed = seen.length;
  const names = seen.slice(0, 10).join(", ") + (listed > 10 ? ` and ${listed - 10} more` : "");
  return new MultiCompanyError(
    "E306",
    listed
      ? `United India - proposal ${number} is not in the Proposal Modification list for ${span} (${listed} proposal${listed === 1 ? "" : "s"} listed${pages > 1 ? ` on ${pages} pages` : ""} - ${names}), so the run stopped there. Check the United India proposal number and its Reference Date in Edit -> Status, then run the policy again.`
      : `United India - the Proposal Modification list for ${span} is empty, so proposal ${number} was not found and the run stopped there. Check its Reference Date in Edit -> Status, then run the policy again.`,
    { company: "united india", stage: STAGE, retryable: false }
  );
};

/**
 * Press a button that brings the list (Fetch, a page link) and wait for it: the loader watched, at most 20 s.
 * @returns {Promise<Object>} the list read afterwards
 */
async function bringList(driver, { label, target, before = null }, o = {}) {
  const firstOf = (l) => (l && l.rows[0] ? l.rows[0].number : "");
  const isDone = async (seen) => {
    if (seen.loader || seen.changed) return true;
    const now = await readList(driver);
    return now.rows.length > 0 && firstOf(now) !== firstOf(before);
  };
  const watched = await pressAndWatch(driver, { label, target, stage: STAGE, maxMs: o.listWaitMs || LIST_WAIT_MS, isDone }, o);
  if (!watched.done) {
    throw new MultiCompanyError(
      "E302",
      `United India - the Proposal Modification list did not come within ${(o.listWaitMs || LIST_WAIT_MS) / 1000} seconds of "${label}"${watched.spinning ? " (the portal's loader was still spinning)" : ""}, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  return readList(driver);
}

/**
 * Open the saved proposal: the Reference Date in both boxes, Fetch, OUR row's radio, Next.
 * @param {WebDriver} driver  on the Proposal Modification page
 * @param {{ proposalNumber: string, referenceDate: string }} saved  from the policy's Proposal step
 * @param {{ log?, now?, sleep?, listWaitMs? }} [o]
 * @returns {Promise<{ url: string, row: Object, page: number, showsNumber: boolean }>}
 */
async function openSavedProposal(driver, { proposalNumber, referenceDate }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const number = String(proposalNumber || "").replace(/\s+/g, "");
  const date = String(referenceDate || "").trim();
  if (!/^\d{8,25}$/.test(number) || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    throw new MultiCompanyError(
      "E306",
      `United India - the saved proposal "${number}" of "${date}" cannot be looked up (a proposal number has digits only, a date is DD/MM/YYYY), so the run stopped there. Correct it in Edit -> Status, then run the policy again.`,
      { company: "united india", stage: STAGE, retryable: false }
    );
  }
  // To = today: a resumed proposal's Reference Date moves to the day it was modified (never before the saved day)
  const today = todayInIndia(o.now || Date.now).date;
  const dayKey = (d) => d.split("/").reverse().join("");
  const to = dayKey(today) >= dayKey(date) ? today : date;
  log(`🔎 United India - looking up proposal ${number} in Proposal Modification - Reference Date from ${date} to ${to}${to === today ? " (today)" : ""}`);
  await putDate(driver, { label: "From Reference Date", target: FROM_DATE, date, said: "the proposal's saved Reference Date", stage: STAGE }, { ...o, log });
  await putDate(driver, { label: "To Reference Date", target: TO_DATE, date: to, said: to === today ? "today" : "the same date", stage: STAGE }, { ...o, log });

  let list = await bringList(driver, { label: FETCH.label, target: FETCH.target }, { ...o, log });
  log(`   ${list.rows.length} proposal${list.rows.length === 1 ? "" : "s"} listed from ${date} to ${to}`);
  const seen = list.rows.map((r) => r.number);
  let page = 1;
  let row = list.rows.find((r) => r.number === number);
  while (!row && list.rows.length && page < MAX_PAGES) {
    const link = await firstVisible(driver, pageLinkOf(page + 1)).catch(() => null);
    if (!link) break;
    throwIfHeld(driver);
    log(`   proposal ${number} is not on page ${page} - opening page ${page + 1}`);
    list = await bringList(driver, { label: `page ${page + 1}`, target: pageLinkOf(page + 1), before: list }, { ...o, log });
    page += 1;
    seen.push(...list.rows.map((r) => r.number));
    row = list.rows.find((r) => r.number === number);
  }
  if (!row) throw notListed(number, date, [...new Set(seen)], page, to);
  if (row.date && row.date !== date) log(`   United India - proposal ${number} is listed with Reference Date ${row.date} (the policy had ${date})`);
  log(`✓ United India - proposal ${number} found (Insured Name ${row.name || "-"}, Total Premium ${row.premium || "-"})`);

  await clickAndConfirm(
    driver,
    {
      label: `proposal ${number}`,
      target: radioOf(number),
      done: () => ourRowChecked(driver, number),
      effect: "its row is selected",
      missing: "its row is not selected",
      stage: STAGE,
      effectMs: 3000,
    },
    { ...o, log }
  );
  // the portal pre-selects the first row: OUR row is read back once more right before Next
  if (!(await ourRowChecked(driver, number))) {
    throw new MultiCompanyError(
      "E301",
      `United India - proposal ${number} could not be kept selected in the Proposal Modification list, so Next was NOT pressed (it would open another proposal). It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  throwIfHeld(driver);
  const opened = await clickToNextPage(driver, { label: NEXT.label, target: NEXT.target, stage: STAGE }, { ...o, log });
  const showsNumber = !!(await driver.executeScript("return (document.body ? document.body.innerText : '').replace(/\\s+/g, '').indexOf(arguments[0]) >= 0;", number).catch(() => false));
  log(`✅ United India - proposal ${number} opened from Proposal Modification (${opened.url})${showsNumber ? "" : " - the page does not show the proposal number"}`);
  return { url: opened.url, row, page, showsNumber };
}

module.exports = {
  openSavedProposal,
  readProposalListInPage,
  bringList,
  ourRowChecked,
  radioOf,
  pageLinkOf,
  FROM_DATE,
  TO_DATE,
  FETCH,
  NEXT,
  LIST_WAIT_MS,
  MAX_PAGES,
  STAGE,
};
