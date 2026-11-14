/**
 * United India, after the PA Cover on the More Covers page (the owner, 2026-11-13):
 *   Back             <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/Back.JPG" onclick="fnSubmit('back')">
 *                    -> clicked; the portal goes back to the Risk Details page (up to 20 s, else an error)
 *   (the page)       scrolled down to its very end (the owner: "full scroll down to the page last")
 *   Compute Premium  <img src=".../ComputePremium.JPG" onclick="fnSubmit('computepremium')" id="compute" name="computeimg1">
 *                    -> clicked; the portal asks "GSTIN/UIN HAS NOT BEEN INSERTED ... Do you want to proceed? If Yes, Click
 *                    On Ok. If No, Click on Cancel to update GSTIN/UIN." -> OK (the owner); then its loader runs while it
 *                    works out the premium - WATCHED (start / stop / page change in the log). Still spinning after 15 s:
 *                    the page REFRESHED (the reload and the loader stopping: 20 s), Compute Premium pressed AGAIN, 20 s;
 *                    still spinning = [E302] a loader issue (the owner's rule, 2026-11-13 - see computePremium).
 * The GSTIN question is the one popup answered OK. It is read before anything else touches the page: ChromeDriver would
 * otherwise close it with CANCEL ("update GSTIN/UIN"). Any other popup is the portal's answer: [E308] in its words, closed
 * with Cancel (nothing unexpected goes ahead). Both buttons go through ./unitedIndiaNavigate.js (one click, a second only
 * when nothing shows the first was taken, never a double submit).
 */
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { firstVisible } = require("../../common/elements");
const { throwIfHeld } = require("../../../lib/holdStop");
const { clickToNextPage, pressAndWatch, waitSettled, pageLoadLimit, readOpenAlert, SETTLE_QUIET_MS } = require("./unitedIndiaNavigate");
const { popupOr, alertRefusal, VIDEO_PAUSE_MS } = require("./unitedIndiaSteps");

const STAGE = "united-india-premium";
const BACK = {
  label: "Back",
  target: ["img[src*='Back.JPG']", "img[onclick*=\"fnSubmit('back')\"]", By.xpath("//img[contains(@src,'Back.JPG') or contains(@onclick,\"'back'\")]")],
};
const COMPUTE = {
  label: "Compute Premium",
  target: ["#compute", "img[name='computeimg1']", "img[src*='ComputePremium']", By.xpath("//img[contains(@onclick,'computepremium')]")],
};
/** Generate Quote - on the live portal it shows only after Update (./unitedIndiaQuote.js takes the Quote PDF when it shows). */
const GENERATE_QUOTE = ["img[src*='GenerateQuote']", "img[onclick*=\"fnSubmit('quote')\"]", By.xpath("//img[contains(@src,'GenerateQuote') or contains(@onclick,\"'quote'\")]")];

/** The owner's times (2026-11-13): the first press 15 s, the loader after a refresh 20 s, the second press 20 s. */
const COMPUTE_FIRST_MS = 15000;
const AFTER_REFRESH_MS = 20000;
const COMPUTE_SECOND_MS = 20000;
/** The sign that Compute Premium is done (the owner: "see for the Update button"). The proposal step clicks it. */
const UPDATE_BUTTON = ["#updt", "img[name='updtimg1']", "img[src*='Update.JPG']", By.xpath("//img[contains(@onclick,\"'update'\")]")];

/** The question the owner answers OK: no GSTIN/UIN on the policy, proceed anyway. */
const GSTIN_QUESTION = /GSTIN\s*\/\s*UIN\s+HAS\s+NOT\s+BEEN\s+INSERTED/i;

/** In the page: scroll to its very end; how far it moved. */
function scrollToEndInPage() {
  var before = window.scrollY || window.pageYOffset || 0;
  var h = Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0);
  window.scrollTo({ top: h, left: 0, behavior: "instant" });
  return Math.abs((window.scrollY || window.pageYOffset || 0) - before);
}

/** Back to the Risk Details page (20 s). */
async function goBack(driver, o = {}) {
  return clickToNextPage(driver, { label: BACK.label, target: BACK.target, stage: STAGE }, o);
}

/**
 * Reload the page as F5 does (the form is sent again - no question in an automated Chrome) and wait until it has loaded and the
 * portal's loader has stopped - all within `maxMs` from the refresh (the owner, 2026-11-13: "refresh, the loader stops, then
 * press again; still not in 20 sec = the error").
 * The reload itself is waited for under a page-load limit of `maxMs`, NOT the 2 s the clicks use: proved in a real Chrome
 * (2026-11-13), a refresh that meets its page-load limit is STOPPED by ChromeDriver - the old page stays and the portal's answer
 * is thrown away. A popup the reload opens is the portal's answer ([E308], `label` = the button it is for).
 * @returns {Promise<{ loaded: boolean, settled: boolean, loadMs: number }>}
 *   loaded: the page reloaded in time; settled: then loaded with the loader off (2 s) before `maxMs` ran out
 */
async function refreshAndSettle(driver, { label, stage = STAGE, maxMs = AFTER_REFRESH_MS }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const start = now();
  const limitBefore = await pageLoadLimit(driver, maxMs);
  let loaded = true;
  try {
    await driver.navigate().refresh();
  } catch (e) {
    loaded = false; // the reload did not finish within maxMs (ChromeDriver stopped it), or the browser refused it
  } finally {
    if (limitBefore) await pageLoadLimit(driver, limitBefore);
  }
  const said = await readOpenAlert(driver);
  if (said) {
    await said.accept().catch(() => {});
    throw alertRefusal(label, said.text, stage);
  }
  const loadMs = now() - start;
  if (!loaded) {
    log(`   the refreshed page did not load within ${maxMs / 1000} seconds`);
    return { loaded: false, settled: false, loadMs };
  }
  log(`   the page reloaded in ${Math.round(loadMs / 100) / 10} s - watching the portal's loader`);
  // the rest of the owner's 20 s - at least long enough to see the loader stay off (2 s) once
  const left = Math.max(SETTLE_QUIET_MS + 1000, maxMs - loadMs);
  const settled = await waitSettled(driver, { label: "the refresh", stage, maxMs: left }, { ...o, log });
  return { loaded: true, settled, loadMs };
}

/**
 * The [E302] when the page after a refresh did not load, or its loader did not stop, within `settleMs`.
 * `before`: why the page was refreshed, e.g. `the portal's loader was still spinning 15 seconds after "Compute Premium"`.
 */
function refreshError(before, settleMs, after, stage = STAGE) {
  const why = after.loaded ? `its loader did not stop within ${settleMs / 1000} seconds` : `it did not load within ${settleMs / 1000} seconds`;
  return new MultiCompanyError(
    "E302",
    `United India - ${before}, and after the page was refreshed ${why} - a loader issue at United India, so the run stopped there. It will try again shortly.`,
    { company: "united india", stage }
  );
}

/** Why a button's first wait ended without it being done - the words of the refresh line and of refreshError. */
const notDoneWhy = (label, ms, watched, quiet) => (watched.spinning ? `the portal's loader was still spinning ${ms / 1000} seconds after "${label}"` : `${quiet} ${ms / 1000} seconds after "${label}"`);

/**
 * Compute Premium - the owner's rule (2026-11-13, his 3rd message on it: "only click the button and wait for the loader to stop;
 * still spinning - refresh, the loader stops, click Compute Premium again; still not stopping in 20 s - the error"):
 *   1. the page's end, Compute Premium pressed (nothing else touched), the GSTIN question OK, the loader WATCHED - each start /
 *      stop / page change said in the log (./unitedIndiaNavigate.js pressAndWatch). DONE = the page loaded and the loader off
 *      for 2 s - after it was seen; when no loader was seen at all, the Update button must be on the page too. At most 15 s.
 *   2. not done: the page REFRESHED - the reload and then the loader stopping (off for 2 s) together at most 20 s
 *      (refreshAndSettle) - then Compute Premium pressed AGAIN and watched, at most 20 s.
 *   3. still not = [E302] a loader issue.
 * @returns {Promise<{ refreshed: boolean, loaderMs: number }>}
 */
async function computePremium(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const firstMs = o.computeFirstMs || COMPUTE_FIRST_MS;
  const settleMs = o.afterRefreshMs || AFTER_REFRESH_MS;
  const secondMs = o.computeSecondMs || COMPUTE_SECOND_MS;
  const onPopup = (text) => (GSTIN_QUESTION.test(String(text || "")) ? "accept" : null);
  // done: the loader was seen and has stopped; or, with no loader seen, the press did something (the GSTIN question, a new
  // page) and the Update button is on the page - a swallowed press with the button already there is NOT done
  const isDone = async ({ loader, changed, answered }) => loader || ((changed || answered > 0) && !!(await firstVisible(driver, UPDATE_BUTTON).catch(() => null)));
  const toEnd = async () => {
    const moved = await driver.executeScript(scrollToEndInPage).catch(popupOr(COMPUTE.label, STAGE));
    if (moved) await sleep(driver, VIDEO_PAUSE_MS); // the video shows the end of the page
    log("⬇️ United India - scrolled down to the end of the Risk Details page");
  };

  await toEnd();
  const first = await pressAndWatch(driver, { label: COMPUTE.label, target: COMPUTE.target, stage: STAGE, maxMs: firstMs, onPopup, isDone }, { ...o, log });
  if (first.done) {
    log(`✅ United India - "Compute Premium" done (${first.loaderSeen ? `the loader ran ${Math.round(first.loaderMs / 100) / 10} s` : "no loader was seen, the Update button is on the page"})`);
    return { refreshed: false, loaderMs: first.loaderMs };
  }
  log(
    `⟳ United India - ${firstMs / 1000} seconds after "Compute Premium" ${first.spinning ? "the portal's loader is still spinning" : "it is not done (no loader seen, no Update button)"} - refreshing the page`
  );
  throwIfHeld(driver);
  const after = await refreshAndSettle(driver, { label: COMPUTE.label, stage: STAGE, maxMs: settleMs }, { ...o, log });
  if (!after.settled) throw refreshError(notDoneWhy(COMPUTE.label, firstMs, first, "Compute Premium was not done (no loader seen, no Update button)"), settleMs, after);
  log('   after the refresh the loader has stopped - pressing "Compute Premium" again');
  await toEnd();
  const second = await pressAndWatch(driver, { label: COMPUTE.label, target: COMPUTE.target, stage: STAGE, maxMs: secondMs, onPopup, isDone }, { ...o, log });
  if (second.done) {
    log(`✅ United India - "Compute Premium" done on the second press (${second.loaderSeen ? `the loader ran ${Math.round(second.loaderMs / 100) / 10} s` : "no loader was seen, the Update button is on the page"})`);
    return { refreshed: true, loaderMs: second.loaderMs };
  }
  throw new MultiCompanyError(
    "E302",
    `United India - ${second.spinning ? "the portal's loader was still spinning" : "Compute Premium was still not done (no loader seen, no Update button)"} ${secondMs / 1000} seconds after "Compute Premium" was pressed again (after a refresh) - a loader issue at United India, so the run stopped there. It will try again shortly.`,
    { company: "united india", stage: STAGE }
  );
}

/**
 * Back, then Compute Premium.
 * @param {WebDriver} driver  on the More Covers page, the PA Cover done
 * @param {{ log?: Function, now?: Function, sleep?: Function, loaderMaxMs?: number }} [o]
 */
async function backAndComputePremium(driver, o = {}) {
  const back = await goBack(driver, o);
  const premium = await computePremium(driver, o);
  return { back, premium };
}

module.exports = {
  backAndComputePremium,
  goBack,
  computePremium,
  refreshAndSettle,
  refreshError,
  notDoneWhy,
  scrollToEndInPage,
  GSTIN_QUESTION,
  GENERATE_QUOTE,
  UPDATE_BUTTON,
  COMPUTE_FIRST_MS,
  AFTER_REFRESH_MS,
  COMPUTE_SECOND_MS,
  BACK,
  COMPUTE,
};
