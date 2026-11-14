/**
 * United India Risk Details, after the dates (the owner, 2026-11-13): two Yes / No questions, answered by default.
 *   Whether Valid PUC is available for the Vehicle ?*          <select name="ynPuc" id="repository">   -> "Yes"
 *   Whether Vehicle is plying in Delhi - NCR Region ?*         <select name="ynDncr" id="repository">  -> "No"
 * (options: S = Select / Yes / No). BOTH boxes have the SAME id "repository", so a box is found by its NAME only - a
 * lookup by id would answer the PUC box twice and leave Delhi - NCR on "select".
 *
 * Every answer follows the owner's rule (./unitedIndiaSteps.js selectAndConfirm): chosen, read back, once more if it did
 * not take, a box that is not on the page is its own error; a box already showing the answer is left as it is. The
 * portal's loader is waited for after each (its onchange may load something), a popup is reported in the portal's words,
 * and both are read once more at the end.
 */
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { selectAndConfirm, alertTextOf, alertRefusal, readSelectElementInPage, waitForShown } = require("./unitedIndiaSteps");

const STAGE = "united-india-risk";
/** The owner's defaults, in the order the page shows them. */
const QUESTIONS = [
  {
    label: "Whether Valid PUC is available for the Vehicle",
    short: "PUC",
    target: ["select[name='ynPuc']", By.name("ynPuc")],
    answer: "Yes",
  },
  {
    label: "Whether Vehicle is plying in Delhi - NCR Region",
    short: "Delhi - NCR",
    target: ["select[name='ynDncr']", By.name("ynDncr")],
    answer: "No",
  },
];

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

/**
 * @param {WebDriver} driver  on Risk Details, the dates entered
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ puc: string, delhiNcr: string }>}
 */
async function answerPucAndDelhiNcr(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const chosen = [];
  for (const q of QUESTIONS) {
    const out = await portalStep(q.label, () =>
      selectAndConfirm(driver, { label: q.label, target: q.target, wanted: q.answer, stage: STAGE }, { ...o, log })
    );
    await portalStep(q.label, () => waitForLoader(driver, "united india", { stage: STAGE }));
    chosen.push(out.value);
  }

  // both once more: the second answer's onchange must not have changed the first
  const wrong = [];
  for (const q of QUESTIONS) {
    const box = await waitForShown(driver, q.target, 3000, o);
    const now = box ? await portalStep(q.label, () => driver.executeScript(readSelectElementInPage, box)) : null;
    const shows = now && now.options[now.selectedIndex];
    if (!shows || shows.value !== q.answer) wrong.push(`"${q.label}" shows "${(shows && shows.text) || ""}" instead of "${q.answer}"`);
  }
  if (wrong.length) {
    throw new MultiCompanyError(
      "E306",
      `United India - after both answers were chosen ${wrong.join(", and ").replace(/:/g, " -")}, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  log(`✅ United India - Valid PUC = "${chosen[0]}", plying in Delhi - NCR = "${chosen[1]}"`);
  return { puc: chosen[0], delhiNcr: chosen[1] };
}

module.exports = { answerPucAndDelhiNcr, QUESTIONS };
