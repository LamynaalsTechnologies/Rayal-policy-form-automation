/**
 * Choose an option of a native <select> the way a person does (2026-10-16).
 *
 * The Reliance flow used to set a dropdown with a script - `select.value = "Mrs."` plus one made-up `change` event
 * (relianceForm.js safeSelectDropdown). The box showed the new text at once, but the page never saw what it sees when a
 * person chooses: no pointer over the box, no click that opens the list, no click on the option, no focus moving on.
 * The owner: "it selects the field but not fully assigned, like artificial".
 *
 * So, behind RELIANCE_REALISTIC_SELECT_ENABLED (ON unless false / 0 / no / off; off = the old script, exactly):
 *
 *   1. wait for the box, scroll it to the middle of the window and look at it for a moment;
 *   2. move the pointer over it, pause, and CLICK it - the list opens;
 *   3. find the wanted option in the list that is now open and CLICK that option;
 *   4. pause, then read the box back (which option is selected, and what its value is);
 *   5. let the page settle (the caller's wait, or a short pause).
 *
 * The pauses are a few hundred milliseconds with a little jitter, like a hand. Only if the list cannot be used (the click
 * is refused, the option is gone) or the page does not end up on the wanted option, the old scripted setter runs, with a
 * warning in the log - so a Reliance page change never makes this worse than it was. If even that does not leave the
 * wanted option selected, the error says so (no colon in it: beautifyError keeps only the text after the last one).
 *
 * Nothing here knows about Reliance: it takes the box's id, the wanted option's value or text, and a label for messages.
 */
const { By } = require("selenium-webdriver");

const OFF = /^(false|0|no|off)$/i;

/** ON unless RELIANCE_REALISTIC_SELECT_ENABLED is false / 0 / no / off. Read at call time. */
const isRealisticSelectEnabled = () => !OFF.test(String(process.env.RELIANCE_REALISTIC_SELECT_ENABLED ?? "").trim());

/** "Mrs." / " mrs " / "MRS" -> "mrs": case, spaces and dots do not matter when the exact text is not there. */
const looseKey = (text) => String(text == null ? "" : text).toLowerCase().replace(/[\s.]+/g, "");

/** First line only, colons removed - safe inside an operator sentence. */
const oneLine = (e) => String((e && e.message) || e || "").split("\n")[0].replace(/:/g, " -").trim();

/** In the page: the box's options and which one is selected, or null when the box is not there. */
function readSelectInPage(id) {
  var s = document.getElementById(id);
  if (!s) return null;
  var options = [];
  for (var i = 0; i < s.options.length; i++) {
    var o = s.options[i];
    options.push({ value: String(o.value), text: String(o.text || "").replace(/\s+/g, " ").trim(), disabled: !!o.disabled });
  }
  return { selectedIndex: s.selectedIndex, value: String(s.value), options: options };
}

/** In the page: the OLD way - set the value and fire one change event. Only the last resort. */
function setSelectByScriptInPage(id, value) {
  var s = document.getElementById(id);
  if (!s) return false;
  s.value = value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * The index of the wanted option: the exact value, then the exact text, then the same ignoring case / spaces / dots.
 * The placeholder (empty value) and disabled options are never chosen. -1 when there is none.
 */
function findOptionIndex(options, wanted) {
  const usable = (o) => o && !o.disabled && o.value !== "";
  const want = String(wanted == null ? "" : wanted);
  if (!want.trim()) return -1;
  let at = options.findIndex((o) => usable(o) && o.value === want);
  if (at < 0) at = options.findIndex((o) => usable(o) && o.text === want);
  if (at < 0) at = options.findIndex((o) => usable(o) && (looseKey(o.value) === looseKey(want) || looseKey(o.text) === looseKey(want)));
  return at;
}

/** Wait for the box to be on screen and usable. */
async function waitForSelect(driver, selectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const found = await driver.findElements(By.id(selectId));
      if (found.length && (await found[0].isDisplayed()) && (await found[0].isEnabled())) return found[0];
    } catch (e) {
      // the page is between renders - look again
    }
    if (Date.now() >= deadline) return null;
    await driver.sleep(250);
  }
}

/**
 * Choose `wanted` in the <select id=selectId> like a person.
 *
 * @param {Object} driver
 * @param {string} selectId
 * @param {string} wanted        the option's value or visible text
 * @param {Object} [o]
 * @param {string}   [o.label]     what the box is called in messages ("Title")
 * @param {Function} [o.log]       (line) - progress lines for the operator
 * @param {Function} [o.settle]    async () - how the caller waits for the page after the choice (default: a short pause)
 * @param {Function} [o.pause]     async (ms) - test seam (default driver.sleep)
 * @param {Function} [o.random]    () -> [0,1) - test seam for the jitter
 * @param {number}   [o.timeoutMs] how long to wait for the box (default 10000)
 * @returns {Promise<{index:number, value:string, text:string, how:"already"|"list"|"script"}>}
 * @throws when the box is missing, does not offer the option, or ends up on a different one (no colon in the message)
 */
async function selectLikeUser(driver, selectId, wanted, o = {}) {
  const label = o.label || "dropdown";
  const log = o.log || (() => {});
  const pause = o.pause || ((ms) => driver.sleep(ms));
  const random = o.random || Math.random;
  const human = (min, max) => min + Math.floor(random() * (max - min + 1));

  const select = await waitForSelect(driver, selectId, o.timeoutMs || 10000);
  if (!select) throw new Error(`Reliance's ${label} box (${selectId}) did not appear on the page. Nothing was submitted.`);

  let state = await driver.executeScript(readSelectInPage, selectId);
  if (!state) throw new Error(`Reliance's ${label} box (${selectId}) disappeared before it could be filled. Nothing was submitted.`);

  const target = findOptionIndex(state.options, wanted);
  if (target < 0) {
    const offered = state.options.filter((x) => x.value !== "" && !x.disabled).map((x) => x.text || x.value);
    throw new Error(
      `Reliance's ${label} box does not offer "${wanted}" - it offers ${offered.length ? offered.join(", ") : "nothing"}. Nothing was submitted.`
    );
  }
  const chosen = state.options[target];

  if (state.selectedIndex === target) {
    log(`${label} already shows ${chosen.text || chosen.value}`);
    return { index: target, value: chosen.value, text: chosen.text, how: "already" };
  }

  // 1. in view, and a moment to look at it
  try {
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", select);
  } catch (e) {
    // a box that cannot be scrolled can still be clicked
  }
  await pause(human(250, 450));

  // 2.-3. pointer over it, click it open, click the option
  let how = "list";
  try {
    try {
      await driver.actions().move({ origin: select }).perform();
    } catch (e) {
      // the pointer move is only for looks - the click below moves it anyway
    }
    await pause(human(150, 300));
    await select.click();
    await pause(human(300, 500));
    const optionEls = await select.findElements(By.css("option"));
    if (!optionEls[target]) throw new Error("the option is not in the list that opened");
    await optionEls[target].click();
    await pause(human(300, 500));
  } catch (e) {
    log(`⚠️ ${label}: the list could not be used (${oneLine(e)})`);
    how = "script";
  }

  // 4. read it back
  state = await driver.executeScript(readSelectInPage, selectId);
  if (!state || state.selectedIndex !== target) {
    if (how === "list") log(`⚠️ ${label}: the page did not end up on ${chosen.text || chosen.value} after the click`);
    how = "script";
    log(`⚠️ ${label}: choosing it with a script instead (the old way)`);
    await driver.executeScript(setSelectByScriptInPage, selectId, chosen.value);
    await pause(human(300, 500));
    state = await driver.executeScript(readSelectInPage, selectId);
    if (!state || state.selectedIndex !== target) {
      const now = state && state.options[state.selectedIndex];
      throw new Error(
        `Reliance did not take the ${label} "${chosen.text || chosen.value}" - its ${label} box reads "${(now && (now.text || now.value)) || ""}". Nothing was submitted.`
      );
    }
  }

  // The list closes the moment a person's choice lands; a scripted option click can leave it drawn on a visible window
  // until focus moves on. Let go of the box (a person's next click or Tab does the same), only if it still has focus.
  try {
    await driver.executeScript("if (document.activeElement === arguments[0]) { arguments[0].blur(); }", select);
  } catch (e) {
    // closing the list is only for looks
  }

  // 5. the page's own reaction (dependent boxes, validation) gets its time
  if (o.settle) await o.settle();
  else await pause(human(1200, 1700));

  return { index: target, value: chosen.value, text: chosen.text, how };
}

module.exports = {
  isRealisticSelectEnabled,
  looseKey,
  readSelectInPage,
  setSelectByScriptInPage,
  findOptionIndex,
  selectLikeUser,
};
