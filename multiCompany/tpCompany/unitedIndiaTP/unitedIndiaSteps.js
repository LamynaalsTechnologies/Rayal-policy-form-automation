/**
 * The owner's rule for the United India flow (2026-11-06): EVERY click and EVERY field is checked.
 *   - a click counts only when its effect is seen (a menu opened, a page changed ...); if not, it is clicked ONE more time;
 *   - a field counts only when it reads back the value; if not, it is typed ONE more time;
 *   - an element that is not on the page (not visible) stops the run at once with a sentence that names it.
 * Before clicking, the effect is looked for first: a menu that is already open is never clicked again (a second click on a
 * collapse menu would CLOSE it).
 *
 * The waits poll; nothing sleeps a fixed time. A Hold (lib/holdStop.js) or a Breaker stop always gets through: every loop
 * asks throwIfHeld, and nothing here catches a stop.
 * Operator sentences carry no colon (beautifyError keeps only the text after the last one).
 */
const { MultiCompanyError } = require("../../common/errors");
const { By } = require("selenium-webdriver");
const { firstVisible, clickWithFallback, typeWithReadback } = require("../../common/elements");
const { throwIfHeld } = require("../../../lib/holdStop");
const { readSelectInPage, setSelectByScriptInPage, findOptionIndex } = require("../../../lib/realSelect");

const COMPANY = "united india";
const TRIES = 2;
const POLL_MS = 200;

const defaults = (o = {}) => ({
  now: o.now || Date.now,
  sleep: o.sleep || ((driver, ms) => driver.sleep(ms)),
  log: o.log || ((line) => console.log(line)),
});

/** The first visible element of `selectors` within `timeoutMs`, else null. */
async function waitForShown(driver, selectors, timeoutMs, o = {}) {
  const { now, sleep } = defaults(o);
  const deadline = now() + timeoutMs;
  for (;;) {
    throwIfHeld(driver);
    const el = await firstVisible(driver, selectors);
    throwIfHeld(driver);
    if (el) return el;
    if (now() >= deadline) return null;
    await sleep(driver, POLL_MS);
  }
}

/** Poll `done()` until true or `timeoutMs` passed. */
async function waitUntil(driver, done, timeoutMs, o = {}) {
  const { now, sleep } = defaults(o);
  const deadline = now() + timeoutMs;
  for (;;) {
    throwIfHeld(driver);
    if (await done()) return true;
    if (now() >= deadline) return false;
    await sleep(driver, POLL_MS);
  }
}

/**
 * The text of a portal alert() behind this error, or null when the error is not about an alert. chromedriver dismisses an
 * unexpected alert and reports it as "unexpected alert open: {Alert text : ...}".
 */
function alertTextOf(error) {
  const m = String((error && error.message) || "");
  if (!(error && error.name === "UnexpectedAlertOpenError") && !/unexpected alert open/i.test(m)) return null;
  const said = /Alert text\s*:\s*([^}]*)\}?/i.exec(m);
  return said ? said[1].trim() : "";
}

/** An alert() open right now: its text (it is accepted, so the page can go on), else null. */
async function takeOpenAlert(driver) {
  try {
    const alert = await driver.switchTo().alert();
    const text = String((await alert.getText()) || "").trim();
    await alert.accept().catch(() => {});
    return text;
  } catch (e) {
    return null;
  }
}

/** The portal answered a click with an alert(): that is its answer, not a click that did not take. Not retried. */
const alertRefusal = (label, text, stage) =>
  new MultiCompanyError(
    "E308",
    `United India - after "${label}" the portal said "${String(text || "").replace(/:/g, " -")}", so the run stopped there. ` +
      "Check the policy's details, then run it again.",
    { company: COMPANY, stage, retryable: false, portalMessage: text }
  );

const notVisible = (label, seconds, stage) =>
  new MultiCompanyError(
    "E301",
    `United India - "${label}" is not on the page (not visible after ${seconds} seconds), so the run stopped there. ` +
      "The portal may be slow or may have changed - it will try again shortly.",
    { company: COMPANY, stage }
  );

/**
 * Click `target` until `done()` says its effect is there, at most TRIES clicks.
 * @param {WebDriver} driver
 * @param {Object} step
 * @param {string} step.label        what it is, as the operator sees it ("Policy Transaction")
 * @param {Array}  step.target       selectors (CSS strings or By) of the element to click
 * @param {Function} step.done       async () => boolean - the click's effect is on the page
 * @param {string} step.effect       the effect in words, as a state ("its submenu is open")
 * @param {string} step.missing      the effect missing, in words ("its submenu did not open")
 * @param {string} [step.stage]
 * @param {number} [step.findMs=10000]   how long the element may take to show
 * @param {number} [step.effectMs=4000]  how long its effect may take after a click
 * @param {Function} [step.explain]      async () => text the page shows about it - added to the failure sentence
 * @returns {Promise<{clicks: number}>}
 * @throws {MultiCompanyError} [E301] not visible, or clicked TRIES times without the effect; [E308] the portal answered
 *   with an alert() (its words, not retried)
 */
async function clickAndConfirm(driver, step, o = {}) {
  const { log } = defaults(o);
  const { label, target, effect, missing, stage = "united-india-step", findMs = 10000, effectMs = 4000, explain } = step;
  // A check that runs into a portal alert() reports the alert's words instead of "not done".
  const done = async () => {
    try {
      return await step.done();
    } catch (e) {
      const text = alertTextOf(e);
      if (text !== null) throw alertRefusal(label, text, stage);
      throw e;
    }
  };
  if (await done()) {
    log(`✓ United India - "${label}" not clicked - ${effect} already`);
    return { clicks: 0 };
  }
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const el = await waitForShown(driver, target, findMs, o);
    if (!el) {
      if (await done()) return { clicks: attempt - 1 }; // it took after all, while we looked
      throw notVisible(label, Math.round(findMs / 1000), stage);
    }
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", el).catch(() => {});
    throwIfHeld(driver);
    await clickWithFallback(driver, el);
    throwIfHeld(driver);
    if (await waitUntil(driver, done, effectMs, o)) {
      log(`✓ United India - "${label}" clicked - ${effect}${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { clicks: attempt };
    }
    const alertText = await takeOpenAlert(driver);
    if (alertText !== null) throw alertRefusal(label, alertText, stage);
    if (attempt < TRIES) log(`↻ United India - "${label}" was clicked but ${missing} - clicking it once more`);
  }
  let says = "";
  if (explain) {
    const text = String((await explain().catch(() => "")) || "").trim();
    if (text) says = ` The page says "${text.replace(/:/g, " -")}".`;
  }
  throw new MultiCompanyError(
    "E301",
    `United India - "${label}" was clicked ${TRIES} times but ${missing}, so the run stopped there.${says} ` +
      "It will try again shortly.",
    { company: COMPANY, stage }
  );
}

/**
 * Choose an option of a native <select id=selectId> and read it back, at most TRIES times: first like a person (click the
 * box, click the option), then by the page's own value + change event. The wanted option is matched by its exact text (or
 * value), so "Liability Only Policy" is never "Liability Only Policy Renewal".
 * @param {Object} step  { label, selectId, wanted, stage?, findMs? }
 * @returns {Promise<{tries: number, value: string, text: string}>}
 * @throws {MultiCompanyError} [E301] not visible, [E306] not offered (not retried: the list names what it offers) or not
 *   holding the option after TRIES tries
 */
async function selectAndConfirm(driver, step, o = {}) {
  const { log } = defaults(o);
  const { label, selectId, wanted, stage = "united-india-step", findMs = 10000 } = step;
  const box = await waitForShown(driver, [By.id(selectId)], findMs, o);
  if (!box) throw notVisible(label, Math.round(findMs / 1000), stage);
  let state = await driver.executeScript(readSelectInPage, selectId);
  if (!state) throw notVisible(label, Math.round(findMs / 1000), stage);
  const target = findOptionIndex(state.options, wanted);
  if (target < 0) {
    const offered = state.options.filter((x) => x.value !== "" && !x.disabled).map((x) => x.text || x.value);
    throw new MultiCompanyError(
      "E306",
      `United India - ${label} does not offer "${wanted}", it offers ${offered.length ? offered.join(", ") : "nothing"}, so the run stopped there.`,
      { company: COMPANY, stage, retryable: false }
    );
  }
  const chosen = state.options[target];
  if (state.selectedIndex === target) {
    log(`✓ United India - ${label} already shows "${chosen.text}"`);
    return { tries: 0, value: chosen.value, text: chosen.text };
  }
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    throwIfHeld(driver);
    if (attempt === 1) {
      try {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", box).catch(() => {});
        await box.click();
        const options = await box.findElements(By.css("option"));
        if (options[target]) await options[target].click();
      } catch (e) {
        /* the list could not be used - the second try sets it the page's own way */
      }
    } else {
      await driver.executeScript(setSelectByScriptInPage, selectId, chosen.value).catch(() => {});
    }
    throwIfHeld(driver);
    await driver.executeScript("if (document.activeElement === arguments[0]) { arguments[0].blur(); }", box).catch(() => {});
    state = await driver.executeScript(readSelectInPage, selectId).catch(() => null);
    if (state && state.selectedIndex === target) {
      log(`✓ United India - ${label} = "${chosen.text}"${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { tries: attempt, value: chosen.value, text: chosen.text };
    }
    const now = state && state.options[state.selectedIndex];
    if (attempt < TRIES) log(`↻ United India - ${label} shows "${(now && now.text) || ""}" instead of "${chosen.text}" - choosing it once more`);
  }
  const now = state && state.options[state.selectedIndex];
  throw new MultiCompanyError(
    "E306",
    `United India - ${label} shows "${(now && now.text) || ""}" instead of "${chosen.text}" after ${TRIES} tries, so the run stopped there. ` +
      "It will try again shortly.",
    { company: COMPANY, stage }
  );
}

/** The same text, ignoring case and spaces at the ends. */
const sameText = (a, b) => String(a == null ? "" : a).trim().toLowerCase() === String(b == null ? "" : b).trim().toLowerCase();

/**
 * Type `value` into `target` and read it back, at most TRIES times.
 * @param {Object} step  { label, target, value, stage?, findMs?, same?(got, want) }
 * @returns {Promise<{tries: number}>}
 * @throws {MultiCompanyError} [E301] not visible, [E306] it does not hold the value after TRIES tries
 */
async function fillAndConfirm(driver, step, o = {}) {
  const { log } = defaults(o);
  const { label, target, value, stage = "united-india-step", findMs = 10000, same = sameText } = step;
  const want = String(value == null ? "" : value);
  let got = "";
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const el = await waitForShown(driver, target, findMs, o);
    if (!el) throw notVisible(label, Math.round(findMs / 1000), stage);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", el).catch(() => {});
    throwIfHeld(driver);
    await typeWithReadback(driver, el, want);
    throwIfHeld(driver);
    got = await el.getAttribute("value").catch(() => "");
    if (same(got, want)) {
      log(`✓ United India - ${label} = "${want}"${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { tries: attempt };
    }
    if (attempt < TRIES) log(`↻ United India - ${label} reads "${got}" instead of "${want}" - typing it once more`);
  }
  throw new MultiCompanyError(
    "E306",
    `United India - ${label} holds "${got}" instead of "${want}" after ${TRIES} tries, so the run stopped there. ` +
      "It will try again shortly.",
    { company: COMPANY, stage }
  );
}

module.exports = { clickAndConfirm, fillAndConfirm, selectAndConfirm, waitForShown, waitUntil, alertTextOf, takeOpenAlert, TRIES };
