"use strict";

/**
 * Reliance's "ready, or the old pause" (2026-11-26, speed round 4). Built on ../../lib/settle.js and the portal-idle
 * read the cover step already trusts (relianceCoverSettle.js readPortalActivityInPage: jQuery's requests in flight +
 * Kendo's loading mask).
 *
 * Reliance is a jQuery / Kendo site: a click or a change that asks the server starts its $.ajax at once (inside the
 * click), so "no request in flight and no loading mask, for a short quiet moment" means the page has answered. Every
 * pause here still ends at the OLD length when the page never gets there, and:
 *   - an alert() Reliance opens is never touched here (the flow's next step meets it exactly as before);
 *   - a driver that cannot run page scripts (a test's fake) gets exactly the old flat pause.
 */

const { By } = require("selenium-webdriver");
const settle = require("../../lib/settle");
const pageReads = require("../../lib/pageReads");
const { readPortalActivityInPage } = require("./relianceCoverSettle");

/**
 * One read of the portal: { supported, idle }. supported=false: this driver cannot run page scripts (the old pause is
 * used). A read that fails on a real page counts as busy.
 */
async function portalActivity(driver) {
  if (!driver || typeof driver.executeScript !== "function") return { supported: false, idle: false };
  let a;
  try {
    a = await driver.executeScript(readPortalActivityInPage);
  } catch (e) {
    if (settle.isStop(e)) throw e;
    return { supported: true, idle: false };
  }
  if (!a || typeof a !== "object") return { supported: false, idle: false };
  const active = a.active == null ? null : Number(a.active);
  return { supported: true, idle: !a.loading && (active === null || active === 0) };
}

/** One read: no request in flight and no loading mask (unreadable / unsupported = not idle). */
async function portalIdleNow(driver) {
  const a = await portalActivity(driver);
  return a.supported && a.idle;
}

/**
 * Until the portal has been idle for `stableMs` (no request in flight, no loading mask), at most `capMs` (the old pause).
 * @returns {Promise<{ready:boolean, ms:number}>}
 */
async function idleOrPause(driver, capMs, { stableMs = 400, pollMs = 150 } = {}) {
  const first = await portalActivity(driver);
  if (!first.supported) {
    await driver.sleep(capMs); // no page scripts here: exactly the old pause
    return { ready: false, ms: capMs };
  }
  return settle.untilReady(driver, () => portalIdleNow(driver), { capMs, everyMs: pollMs, quietMs: Math.min(stableMs, capMs) });
}

/** The tab's address before a click that should take it elsewhere ("" when it cannot be read). */
async function urlNow(driver) {
  try {
    return String((await driver.getCurrentUrl()) || "");
  } catch (e) {
    if (settle.isStop(e)) throw e;
    return "";
  }
}

/** Until the tab has left `fromUrl` and its new page has loaded (and stayed so for `quietMs`), at most `capMs`. */
async function untilLeft(driver, fromUrl, capMs, { quietMs = 300, everyMs = 200 } = {}) {
  if (!fromUrl) {
    await driver.sleep(capMs); // nothing to compare with: the old pause
    return { ready: false, ms: capMs };
  }
  return settle.untilUrlLeaves(driver, fromUrl, { capMs, quietMs, everyMs });
}

/** Until the address contains `part` and the page has loaded, at most `capMs`. */
function untilAt(driver, part, capMs, { quietMs = 200, everyMs = 200 } = {}) {
  const want = String(part).toLowerCase();
  return settle.untilReady(
    driver,
    async () => {
      const url = String((await driver.getCurrentUrl()) || "").toLowerCase();
      if (!url.includes(want)) return false;
      return (await driver.executeScript("return document.readyState")) === "complete";
    },
    { capMs, quietMs, everyMs }
  );
}

/** The first shown element of `id` (one page read; the old findElements + isDisplayed when that cannot run), or null. */
async function shownById(driver, id) {
  try {
    const found = await pageReads.findFirstShown(driver, [`#${id}`]);
    return (found && found.element) || null;
  } catch (e) {
    if (settle.isStop(e)) throw e;
  }
  try {
    for (const el of (await driver.findElements(By.id(id))) || []) {
      try {
        if (await el.isDisplayed()) return el;
      } catch (e) {
        if (settle.isStop(e)) throw e;
      }
    }
  } catch (e) {
    if (settle.isStop(e)) throw e;
  }
  return null;
}

/**
 * Until one of `selectors` is on screen (-> { shown: true }), or the portal has answered and stayed idle `idleMs` with
 * none of them (-> { shown: false }), at most `capMs` (the old look).
 */
async function untilShownOrIdle(driver, selectors, capMs, { idleMs = 800, everyMs = 150, now = Date.now } = {}) {
  const start = now();
  let idleSince = null;
  for (;;) {
    if (await settle.alertOpen(driver)) return { shown: false, ms: now() - start, alert: true };
    let shown = false;
    try {
      shown = await settle.isShown(driver, selectors);
    } catch (e) {
      if (settle.isStop(e)) throw e;
    }
    if (shown) return { shown: true, ms: now() - start };
    const idle = await portalIdleNow(driver);
    const t = now();
    if (idle) {
      if (idleSince === null) idleSince = t;
      if (t - idleSince >= idleMs) return { shown: false, ms: t - start };
    } else {
      idleSince = null;
    }
    if (t - start >= capMs) return { shown: false, ms: t - start };
    await driver.sleep(Math.min(everyMs, Math.max(1, capMs - (t - start))));
  }
}

/**
 * After the login: the dashboard's popup close button (#Closebutton) once it is on screen, or null when the Motors menu
 * is on screen and the page has been idle `idleMs` without a popup; at most `capMs` (the old 2 s + 5 s).
 */
async function dashboardPopup(driver, capMs, { idleMs = 1500, everyMs = 200, now = Date.now } = {}) {
  if (!(await portalActivity(driver)).supported) {
    // no page scripts here (a test's fake): exactly the old look - 2 s, then up to 5 s for the button
    try {
      const { until } = require("selenium-webdriver");
      await driver.sleep(2000);
      const closeBtn = await driver.wait(until.elementLocated(By.id("Closebutton")), 5000);
      await driver.wait(until.elementIsVisible(closeBtn), 5000);
      return closeBtn;
    } catch (e) {
      if (settle.isStop(e)) throw e;
      return null;
    }
  }
  const start = now();
  let quietSince = null;
  for (;;) {
    if (await settle.alertOpen(driver)) return null;
    const close = await shownById(driver, "Closebutton");
    if (close) return close;
    const quiet = (await shownById(driver, "divMainMotors")) !== null && (await portalIdleNow(driver));
    const t = now();
    if (quiet) {
      if (quietSince === null) quietSince = t;
      if (t - quietSince >= idleMs) return null;
    } else {
      quietSince = null;
    }
    if (t - start >= capMs) return null;
    await driver.sleep(Math.min(everyMs, Math.max(1, capMs - (t - start))));
  }
}

/** The KYC page's two upload areas (Identity / Address Verification) are both on the page. */
async function dropzonesReady(driver) {
  const upload = require("./relianceKycUpload");
  for (const expr of Object.values(upload.SLOT_HANDLERS)) {
    const z = await driver.executeScript(upload.dropzoneStateInPage, expr);
    if (!z || !Number(z.exists)) return false;
  }
  return true;
}

module.exports = {
  ...settle,
  idleOrPause,
  portalActivity,
  portalIdleNow,
  urlNow,
  untilLeft,
  untilAt,
  shownById,
  untilShownOrIdle,
  dashboardPopup,
  dropzonesReady,
};
