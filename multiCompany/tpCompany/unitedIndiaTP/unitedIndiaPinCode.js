/**
 * United India Risk Details, the Pin Code after the insured's Address (the owner, 2026-11-13):
 *   Pin Code   <input name="pincodeString" id="PIN_CODE" maxlength="6" onblur="getStateDist()">  -> the policy's pin code
 *   State      <select name="state" id="STATE_CODE1" disabled>          filled by the portal from the pin code
 *   District   <select name="districtCode" id="STATE_CODE2" disabled>   filled by the portal (only "Select" before)
 * The pin code is typed and read back, then the box loses focus (its onblur runs getStateDist()), and the run waits for
 * the portal to fill the District. Not filled: the box is left once more (typed again first only if the portal emptied
 * it) - the owner's rule; still not filled = the pin code is wrong for United India -> a stop that is not retried, with the run's screenshot (runHandler),
 * "check the customer's pin code". A popup the portal answers with = [E308] in its words.
 *
 * The State the portal fills is compared with the customer's state on the policy: a different one is only WARNED about in
 * the log (the run goes on - the owner has not said to stop on it).
 */
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { readSelectInPage } = require("../../../lib/realSelect");
const { throwIfHeld } = require("../../../lib/holdStop");
const { By } = require("selenium-webdriver");
const { firstVisible } = require("../../common/elements");
const { fillAndConfirm, waitForShown, alertTextOf, takeOpenAlert, alertRefusal, notVisible, showOnScreen, leaveBoxInPage, TRIES } = require("./unitedIndiaSteps");
// The box is never emptied with Selenium's clear(): that leaves the box, and its onblur would run getStateDist() with an
// EMPTY pin code (the real-Chrome replica counted 3 runs for 2 tries) - the portal may answer that with its own popup.
const { stateOptionFor } = require("./unitedIndiaRisk");

const STAGE = "united-india-risk";
const PIN = ["#PIN_CODE", "input[name='pincodeString']"];
const STATE_ID = "STATE_CODE1";
const DISTRICT_ID = "STATE_CODE2";
/** How long the portal may take to fill the District after the pin code box is left (the owner, 2026-11-13: 10 s, not 20). */
const FILL_WAIT_MS = 10000;
const POLL_MS = 250;

/** The policy's pin code: 6 digits (spaces dropped), or "" when it has none that is usable. */
function pinCodeOf(data = {}) {
  const raw = String(data.pinCode == null || data.pinCode === "" ? (data.pincode == null ? "" : data.pincode) : data.pinCode);
  const digits = raw.replace(/\s+/g, "");
  return { raw: raw.trim(), pin: /^\d{6}$/.test(digits) ? digits : "" };
}


/** The chosen real option of a list read by readSelectInPage, or null ("select" / "" / nothing). */
const chosenReal = (state) => {
  const o = state && state.options && state.options[state.selectedIndex];
  return o && o.value !== "" && String(o.value).toLowerCase() !== "select" && !o.disabled ? o : null;
};

const realCount = (state) => ((state && state.options) || []).filter((o) => o.value !== "" && String(o.value).toLowerCase() !== "select").length;

/**
 * @param {WebDriver} driver  on Risk Details, the insured's Address entered
 * @param {Object} data       the job data (pinCode, customerState)
 * @param {{ log?: Function, now?: Function, sleep?: Function, fillWaitMs?: number }} [o]  fillWaitMs: the wait for the
 *   District per try (default FILL_WAIT_MS; the real-Chrome replica shortens it)
 * @returns {Promise<{ pinCode: string, state: string, district: string }>}
 */
async function fillPinCode(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const waitMs = o.fillWaitMs || FILL_WAIT_MS;
  const label = "Pin Code";
  const refuseIfAlert = (e) => {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(label, text, STAGE);
  };

  const { raw, pin } = pinCodeOf(data);
  if (!pin) {
    throw new MultiCompanyError(
      "E306",
      raw
        ? `United India - the customer's pin code "${raw.replace(/:/g, " -")}" on the policy is not 6 digits, so the run stopped there. Correct the pin code on the policy, then run it again.`
        : "United India - the policy has no pin code, so the run stopped there. Enter the customer's pin code on the policy, then run it again.",
      { company: "united india", stage: STAGE, retryable: false }
    );
  }
  log(`📮 United India - Pin Code ${pin}: the portal fills the State and District from it`);

  let state = null;
  let district = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    // the second try only leaves the box again, unless the portal emptied it (then it is typed again)
    let box = attempt > 1 ? await waitForShown(driver, PIN, 5000, o) : null;
    const holds = box ? String((await box.getAttribute("value").catch(refuseIfAlert)) || "").trim() === pin : false;
    if (!holds) await fillAndConfirm(driver, { label, target: PIN, value: pin, stage: STAGE, clearQuietly: true }, { ...o, log });
    box = await waitForShown(driver, PIN, 5000, o);
    if (!box) throw notVisible(label, 5, STAGE);
    throwIfHeld(driver);
    await driver.executeScript(leaveBoxInPage, box).catch(refuseIfAlert); // onblur -> getStateDist()
    await waitForLoader(driver, "united india", { stage: STAGE }).catch((e) => {
      refuseIfAlert(e);
      throw e;
    });

    // the District, filled by the portal - on the screen while it is waited for (the video shows it fill), polled
    const districtBox = await firstVisible(driver, [By.id(DISTRICT_ID)]).catch(() => null);
    if (districtBox)
      await showOnScreen(driver, districtBox, o).catch((e) => {
        refuseIfAlert(e);
        throw e; // a Hold / Breaker stop goes on up
      });
    const deadline = now() + waitMs;
    for (;;) {
      throwIfHeld(driver);
      const said = await takeOpenAlert(driver);
      if (said !== null) throw alertRefusal(label, said, STAGE);
      district = await driver.executeScript(readSelectInPage, DISTRICT_ID).catch((e) => {
        refuseIfAlert(e);
        return null;
      });
      if (chosenReal(district) || now() >= deadline) break;
      await sleep(driver, POLL_MS);
    }
    // the State is read AFTER the District is there (read before it, it could still show Select)
    state = await driver.executeScript(readSelectInPage, STATE_ID).catch((e) => {
      refuseIfAlert(e);
      return null;
    });
    if (chosenReal(district)) break;
    if (attempt < TRIES) log(`↻ United India - the District was not filled ${waitMs / 1000} seconds after the Pin Code ${pin} - leaving the box once more`);
  }

  if (!district) {
    throw new MultiCompanyError(
      "E301",
      'United India - the "District" box is not on the Risk Details page, so the run stopped there. It will try again shortly.',
      { company: "united india", stage: STAGE }
    );
  }
  const districtChosen = chosenReal(district);
  if (!districtChosen) {
    const listed = realCount(district);
    throw new MultiCompanyError(
      "E306",
      `United India - the Pin Code ${pin} did not fill the District (${
        listed ? `the portal listed ${listed} districts but chose none` : "the District stayed on Select"
      }, ${TRIES} tries), so the pin code may be wrong and the run stopped there. ` +
        "Check the customer's pin code on the policy, then run it again.",
      { company: "united india", stage: STAGE, retryable: false }
    );
  }

  const stateChosen = chosenReal(state);
  const customerState = String(data.customerState || "").trim();
  const ours = customerState && state ? stateOptionFor(state.options, customerState) : null;
  if (stateChosen && ours && ours.value !== stateChosen.value) {
    log(
      `⚠️ United India - the Pin Code ${pin} is in ${stateChosen.text}, but the customer's state on the policy is "${customerState}" (${ours.text}) - check the pin code`
    );
  }
  log(`✅ United India - Pin Code ${pin}: State ${(stateChosen && stateChosen.text) || "(not filled)"}, District ${districtChosen.text} (filled by the portal)`);
  return { pinCode: pin, state: (stateChosen && stateChosen.text) || "", district: districtChosen.text };
}

module.exports = { fillPinCode, pinCodeOf, leaveBoxInPage, chosenReal, PIN, STATE_ID, DISTRICT_ID, FILL_WAIT_MS };
