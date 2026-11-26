"use strict";

/**
 * KSHEMA's "ready, or the old pause" signs (2026-11-26, speed round 4). Built on ../../lib/settle.js.
 *
 * Every sign here is what KSHEMA shows on screen when the step really is done, taken from the run videos of real
 * policies (2026-11-26):
 *   - the KYC tab after "Confirm & Verify" on a passed KYC: assurehub.kshema.co/kyc/ack?status=success ("KYC Verified -
 *     Your identity has been verified successfully - Redirecting back to merchant... 10s"); after the count-down that tab
 *     goes back to KSHEMA (motorinsurance.kshema.co/api/v1/integration/kycUpdate...), which is what moves the proposal
 *     page on to Payment;
 *   - the quote screen after Two-Wheeler: the Customer Category dropdown;
 *   - the login page: the username and password boxes.
 * When a sign never shows, the old pause is waited in full - nothing else changes.
 */

const settle = require("../../lib/settle");
const { log } = require("./kshemaLog");

/* ----------------------------------------- KYC ----------------------------------------- */

/** KSHEMA's own "KYC Verified" page (status=success). */
function isKycSuccessUrl(url) {
  const u = String(url || "");
  return /assurehub\.kshema\.co\/kyc\/ack/i.test(u) && /[?&]status=success(&|$)/i.test(u);
}

/** Still on the KYC provider's pages (the form, the dialog, the verdict page) - not yet sent back to KSHEMA. */
function isOnKycProvider(url) {
  return /assurehub\.kshema\.co\/kyc/i.test(String(url || ""));
}

/** After "KYC Verified" the refusal watch goes on at least this long (owner's choice, 2026-11-26). */
const AFTER_KYC_SUCCESS_MS = 5000;

/* ------------------------------------ Angular "stable" ------------------------------------ */

// Angular's own answer to "is anything still pending?" (no request in flight, no timer waiting). null = the page does
// not offer it (then the old pause is used, unchanged).
const ANGULAR_STABLE_SCRIPT = `
  var get = window.getAllAngularTestabilities;
  if (typeof get !== 'function') return null;
  var all;
  try { all = get(); } catch (e) { return null; }
  if (!all || !all.length) return null;
  for (var i = 0; i < all.length; i++) {
    try { if (!all[i].isStable()) return false; } catch (e) { return null; }
  }
  return true;`;

const noSignal = new WeakSet(); // drivers whose page never offered the signal: one look, then the old pause only
const provenSignal = new WeakSet(); // drivers whose page has said "busy" at least once (the signal really follows the work)
let saidOnce = false;

async function angularStable(driver) {
  if (!driver || typeof driver.executeScript !== "function" || noSignal.has(driver)) return null;
  let answer = null;
  try {
    answer = await driver.executeScript(ANGULAR_STABLE_SCRIPT);
  } catch (e) {
    if (settle.isStop(e)) throw e;
    return null;
  }
  if (answer !== true && answer !== false) {
    noSignal.add(driver);
    if (!saidOnce) {
      saidOnce = true;
      log("   ℹ️  KSHEMA's page does not report when it is idle - the short pauses after a field stay as they were");
    }
    return null;
  }
  return answer;
}

/**
 * The short pause after a field that may start a lookup (old: a flat 300 ms, so KSHEMA's loader had time to show).
 * Now it ends as soon as Angular says twice in a row that nothing is pending (no request, no timer: no loader can be
 * on its way). Anything pending, or no signal on this page = the old 300 ms. The loader wait after it is unchanged.
 */
async function fieldSettlePause(driver, maxMs = 300, { everyMs = 60 } = {}) {
  if (!driver || typeof driver.executeScript !== "function" || noSignal.has(driver)) {
    await driver.sleep(maxMs); // no signal on this page: exactly the old pause
    return { early: false };
  }
  const start = Date.now();
  let stableReads = 0;
  for (;;) {
    const stable = await angularStable(driver);
    const spent = Date.now() - start;
    if (stable === false) provenSignal.add(driver);
    // Anything pending, no signal, or a page that has never once said "busy" in this run (a page without Angular's zone
    // would always say "idle"): the old pause.
    if (stable === null || stable === false || !provenSignal.has(driver)) {
      if (maxMs - spent > 0) await driver.sleep(maxMs - spent);
      return { early: false };
    }
    stableReads += 1;
    if (stableReads >= 2) return { early: true, ms: spent };
    const left = maxMs - spent;
    if (left <= 0) return { early: false };
    await driver.sleep(Math.min(everyMs, left));
  }
}

/* --------------------------------------- pages --------------------------------------- */

const lower = (expr) => `translate(${expr}, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")`;

const CUSTOMER_CATEGORY = ['mat-select[data-iid="c_category"]', '[data-iid="c_category"]'];

/** The Other Details step (after the Summary's Next): its Add Entry button (the same XPath the nominee step clicks) or its
 *  Hypothecation Details box. Neither is on the Summary step. */
const OTHER_DETAILS_SIGNS = [
  `//span[contains(${lower(".")}, "add entry")]/ancestor::button`,
  `//button[contains(${lower(".")}, "add entry")]`,
  `//*[contains(${lower("normalize-space(text())")}, "hypothecation details")]`,
];

/** The nominee row's Nominee Name box (the same XPath the nominee step types into). */
const NOMINEE_NAME_BOX = [`//input[@data-iid="beneficiary_name_tmpl" or contains(${lower("@placeholder")}, "nominee name")]`];

/** KSHEMA's loader - the selector kshemaAfterFinalize.js / waitForKshemaLoaderToDisappear use. */
const LOADER = ['mat-spinner[data-iid="__loading"], .mat-mdc-progress-spinner'];

/** The KYC dialog's Confirm & Verify button (the XPath the KYC step clicks). */
const CONFIRM_VERIFY_BUTTON = [
  `//button[contains(${lower("normalize-space(.)")}, "confirm & verify")]`,
  `//button[contains(${lower("normalize-space(.)")}, "confirm and verify")]`,
];

/** After Two-Wheeler (old: 4 s): the quote screen's first dropdown is on screen and stays there. */
function untilQuoteScreen(driver, capMs = 4000) {
  return settle.untilShown(driver, CUSTOMER_CATEGORY, { capMs, everyMs: 200, quietMs: 400 });
}

async function loadedAt(driver, test) {
  const url = String((await driver.getCurrentUrl()) || "");
  if (!test(url)) return false;
  return (await driver.executeScript("return document.readyState")) === "complete";
}

/** The new KYC tab has its own address (not the blank page it opens with) and has loaded. */
function kycPageLoaded(driver) {
  return loadedAt(driver, (url) => /^https?:\/\//i.test(url));
}

/** KSHEMA's payment page (assurehub.kshema.co/payment?transactionId=...) has loaded. */
function paymentPageLoaded(driver) {
  return loadedAt(driver, (url) => /assurehub\.kshema\.co\/payment/i.test(url));
}

module.exports = {
  ...settle,
  isKycSuccessUrl,
  isOnKycProvider,
  AFTER_KYC_SUCCESS_MS,
  angularStable,
  fieldSettlePause,
  untilQuoteScreen,
  kycPageLoaded,
  paymentPageLoaded,
  CUSTOMER_CATEGORY,
  OTHER_DETAILS_SIGNS,
  NOMINEE_NAME_BOX,
  LOADER,
  CONFIRM_VERIFY_BUTTON,
  ANGULAR_STABLE_SCRIPT,
};
