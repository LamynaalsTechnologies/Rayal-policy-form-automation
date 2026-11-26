"use strict";

/**
 * "Ready, or the old pause" (2026-11-26, speed round 4).
 *
 * Why: about half of every run on the server was fixed pauses (`driver.sleep(2000)` after a click, "wait a bit for the
 * page"), most of them pure safety margin: the page was ready long before. Each such pause now ends as soon as the page
 * shows the NEXT state (the next page's box is on screen, the address changed, the loader came and went...), and never
 * later than the old pause. When the sign never shows, the run waits the old pause and carries on exactly as before.
 *
 * Rules:
 *   - the check is a NEW state, never something already true before the click (callers pick it);
 *   - a check that throws (page changing, element gone) counts as "not yet";
 *   - `quietMs`: the check must stay true that long (a loader that may come back, a value the page may still change);
 *   - polls use `driver.sleep`, so Hold, the stuck-step watch and the [timing] lines still see them;
 *   - nothing here clicks or types.
 */

const pageReads = require("./pageReads");
const holdStop = require("./holdStop");

/** A Hold or a stuck-step stop must never be read as "not ready yet". */
function isStop(e) {
  return !!e && (holdStop.isHoldStop(e) || e.name === "StepStalledError" || e.stalled === true);
}

/**
 * Is an alert() open? Asked without touching it (W3C "get alert text"), so the flow's next step meets it exactly as it
 * did after the old flat pause. Any page read here would have made Chrome close it silently ("dismiss and notify").
 */
async function alertOpen(driver) {
  let to = null;
  try {
    to = driver && typeof driver.switchTo === "function" ? driver.switchTo() : null;
  } catch (e) {
    return false;
  }
  if (!to || typeof to.alert !== "function") return false;
  try {
    await to.alert();
    return true;
  } catch (e) {
    if (isStop(e)) throw e;
    return false;
  }
}

/**
 * Wait until `check()` is truthy (and stays truthy for `quietMs`), or `capMs` has passed.
 *
 * @param {WebDriver} driver
 * @param {Function} check   async () => truthy when ready; a throw = not yet
 * @param {Object} opts
 * @param {number} opts.capMs        the old pause: never waited longer
 * @param {number} [opts.everyMs]    time between checks
 * @param {number} [opts.quietMs]    how long the check must stay true
 * @param {Function} [opts.now]      clock (tests)
 * @returns {Promise<{ready:boolean, ms:number}>}
 */
async function untilReady(driver, check, { capMs, everyMs = 150, quietMs = 0, now = Date.now } = {}) {
  const cap = Math.max(0, Number(capMs) || 0);
  const every = Math.max(20, Number(everyMs) || 150);
  const start = now();
  let trueSince = null;
  for (;;) {
    // an alert() is open: stop waiting and leave it alone - the next step meets it as it did after the old pause
    if (await alertOpen(driver)) return { ready: false, ms: now() - start, alert: true };
    let ok = false;
    try {
      ok = !!(await check());
    } catch (e) {
      if (isStop(e)) throw e;
      holdStop.throwIfHeld(driver);
      ok = false;
    }
    const t = now();
    if (ok) {
      if (trueSince === null) trueSince = t;
      if (t - trueSince >= quietMs) return { ready: true, ms: t - start };
    } else {
      trueSince = null;
    }
    const left = cap - (t - start);
    if (left <= 0) return { ready: false, ms: t - start };
    await driver.sleep(Math.min(every, left));
  }
}

/** True when one of `selectors` has a shown element (one browser call, selenium's own isDisplayed). */
async function isShown(driver, selectors) {
  const found = await pageReads.findFirstShown(driver, Array.isArray(selectors) ? selectors : [selectors]);
  return !!(found && found.element);
}

/** Until one of `selectors` is shown, or `capMs`. */
function untilShown(driver, selectors, opts) {
  return untilReady(driver, () => isShown(driver, selectors), opts);
}

/** Until the address is no longer `fromUrl` and the page has loaded, or `capMs`. */
function untilUrlLeaves(driver, fromUrl, opts) {
  return untilReady(
    driver,
    async () => {
      const url = await driver.getCurrentUrl();
      if (!url || url === fromUrl || url === "about:blank") return false;
      return (await driver.executeScript("return document.readyState")) === "complete";
    },
    opts
  );
}

module.exports = { untilReady, untilShown, untilUrlLeaves, isShown, isStop, alertOpen };
