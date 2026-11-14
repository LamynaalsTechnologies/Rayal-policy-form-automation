/**
 * United India: a button that SUBMITS the page and opens the next one - More Covers N Info, Back, Compute Premium (the owner,
 * 2026-11-13: "wait for the page navigation up to 20 sec, if not navigated then error"). One way for all of them:
 *
 *   - the page is MARKED before the click; the change is done when a page without the mark has finished loading (or the portal
 *     opened it in a new window - the run follows it);
 *   - the button is clicked a second time (the owner's rule) ONLY when, 5 s after the first click, the page shows no sign of
 *     leaving (not unloading, no loader, no pending page seen) - never while a submit is on its way;
 *   - while a submit is on its way, ChromeDriver makes EVERY command wait for the new page, up to its page-load limit (300 s by
 *     default), and when the limit runs out it CANCELS the page (proved in a real Chrome, 2026-11-13: United India's answer
 *     that came 6 s after Compute Premium was thrown away by a 2 s limit - the old page kept its loader up for good, the owner's
 *     "loader spinning"; his own click just waited and worked). So while the run waits, the limit is THE TIME LEFT of the
 *     step's wait (20 s for a next page, 15 / 20 s for Compute Premium and Update - the owner's times), set again before every
 *     look: a slow answer is waited for, and only one that misses the owner's time is cancelled. While a look is held by a
 *     page on its way, a line every 5 s says so. The click itself may wait for the page it starts, so a timed-out click is a
 *     click that WORKED (clickOnce) - never clicked again. The old limit is put back either way.
 *   - a portal POPUP is read FIRST on every look, before anything else touches the page: ChromeDriver closes an open popup
 *     with CANCEL as soon as another command meets it. `onPopup(text)` says which popups are a step of the flow ("accept":
 *     OK is pressed and the wait goes on - the GSTIN/UIN question after Compute Premium); any other popup is the portal's
 *     answer: [E308] in its words (closed with Cancel when onPopup was given, so nothing unexpected goes ahead).
 *
 * United India's own refusal (the owner, 2026-11-13): a red box at the top of the page
 *   <div id="err"><div class="errorMsg"><ul><div class="errormsgbox">Error In Data Entry<ul><li> N002219, PolicyInception Date
 *   should be on or later to Proposal Date .</li></ul></div></ul></div></div>
 * is looked for whenever a watched press goes quiet and whenever a next page has opened: shown = [E306] in its words, not
 * retried, with the screenshot - never mistaken for a slow portal ("if any lag, see this thing").
 *
 * BEFORE every click (and a second one) the portal must be READY (the owner, 2026-11-13, after his live run: "the loader opens
 * for some time, then the click does not work - wait for the loader"; his More Covers click was lost and he clicked it by
 * hand): the page loaded, no jQuery request running, no loader lying over the button - at most 40 s (waitPortalReady). A
 * click that something covers is not pushed through by script any more: what covers it is logged (the loader's markup) and
 * the click waits for it. While the page has not changed, a line at 5, 10 and 15 s says what the run sees.
 *
 * pressAndWatch (Compute Premium, Update - the owner, 2026-11-13: "only click the button and wait for the loader to stop ...
 * watch it carefully"): the button may not open a new page at all - the portal shows its LOADER while it works. ONE press, then
 * every look says what it sees in the log: the loader appearing (its name) and stopping, with the seconds since the press; the
 * page changing; a line every 5 s. Done = the page loaded and the loader off for 2 s, and the step's own sign (isDone). The
 * caller decides what a press that is not done in time means (refresh, press again, the error).
 */
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader, isLoaderVisible } = require("../../common/loader");
const { throwIfHeld } = require("../../../lib/holdStop");
const { waitForShown, showOnScreen, alertTextOf, alertRefusal, notVisible, popupOr, waitPortalReady, portalBusyInPage } = require("./unitedIndiaSteps");
const { LOADER_PRESETS } = require("../../common/loader");

/** The owner: wait for the next page up to 20 seconds. */
const NAV_WAIT_MS = 20000;
/** A click with no sign of the page leaving this long after it is clicked once more. */
const RECLICK_AFTER_MS = 5000;
const POLL_MS = 250;
/** The shortest page-load limit set while waiting (the time left can be smaller at the very end of a wait). */
const MIN_LIMIT_MS = 500;
/** While a look is held by a page on its way, a line this often (the owner: "watch it carefully"). */
const ON_ITS_WAY_LINE_MS = 5000;

/** ChromeDriver gave up waiting for a page load (the page the click / submit started missed the limit - and was cancelled). */
const isPageLoadWait = (e) =>
  !!e && (e.name === "TimeoutError" || /timed out receiving message from renderer|timeout: timed out/i.test(String(e.message || "")));

/**
 * Click the button ONCE. A click that DID submit may come back as a page-load timeout (its page missed the limit): "clicked,
 * the page was on its way", never a reason to click again. A click that something COVERS (the portal's loader) waits for the portal and is
 * clicked again for real - what covered it is logged; only a click that still does not land is done by the page's own click().
 * @param {Object} [ctx] { label, stage, log, o }
 * @returns {Promise<{ pending: boolean }>} pending: a page load was seen starting
 */
async function clickOnce(driver, el, { label = "", stage = "united-india-step", log = () => {}, o = {} } = {}) {
  try {
    await el.click();
    return { pending: false };
  } catch (e) {
    if (isPageLoadWait(e)) return { pending: true };
    if (alertTextOf(e) !== null) throw e;
    if (/element click intercepted/i.test(String((e && e.message) || ""))) {
      const by = (/Other element would receive the click:\s*(<[^>]*>)/i.exec(String(e.message)) || [])[1] || "another element";
      log(`⏳ United India - "${label}" is covered by ${by} - waiting for the portal, then clicking it again`);
      await waitPortalReady(driver, el, { label, stage }, o);
      try {
        await el.click();
        return { pending: false };
      } catch (e2) {
        if (isPageLoadWait(e2)) return { pending: true };
        if (alertTextOf(e2) !== null) throw e2;
      }
    }
  }
  try {
    await driver.executeScript("arguments[0].click();", el);
    return { pending: false };
  } catch (e) {
    if (isPageLoadWait(e)) return { pending: true };
    throw e;
  }
}

/**
 * The page-load limit for the next look = the time left of the wait (at least MIN_LIMIT_MS): a page on its way is waited for,
 * never cancelled before the owner's time is up (see the top of this file). A driver without timeouts (a test fake): ignored.
 */
async function limitToTimeLeft(driver, msLeft) {
  try {
    await driver.manage().setTimeouts({ pageLoad: Math.max(MIN_LIMIT_MS, Math.round(msLeft)) });
  } catch (e) {
    /* nothing to set */
  }
}

/**
 * Wait for `promise` - a look ChromeDriver may hold while a page is on its way - and say every `everyMs` that it is still on
 * its way. Real timers on purpose (they only fire while a real look is held).
 */
async function sayWhileHeld(promise, everyMs, say) {
  const timer = setInterval(say, everyMs);
  try {
    return await promise;
  } finally {
    clearInterval(timer);
  }
}

/** Set ChromeDriver's page-load limit; returns the one it had (null when the driver has none to set - a test fake). */
async function pageLoadLimit(driver, ms) {
  try {
    const manage = driver.manage();
    const before = await manage.getTimeouts();
    await manage.setTimeouts({ pageLoad: ms });
    return (before && before.pageLoad) || null;
  } catch (e) {
    return null;
  }
}

/** A popup open right now, NOT answered yet: { text, accept(), dismiss() }, else null. */
async function readOpenAlert(driver) {
  try {
    const alert = await driver.switchTo().alert();
    const text = String((await alert.getText()) || "").trim();
    return { text, accept: () => alert.accept(), dismiss: () => (alert.dismiss ? alert.dismiss() : alert.accept()) };
  } catch (e) {
    return null;
  }
}

/** In the page: mark it, and note when it starts to leave (a form submit unloads it). */
function markPageInPage(token) {
  window.__uiicPage = token;
  window.__uiicLeaving = false;
  var leaving = function () {
    window.__uiicLeaving = true;
  };
  window.addEventListener("beforeunload", leaving);
  window.addEventListener("pagehide", leaving);
  return true;
}

/** In the page: is it still the marked one, is it leaving, has it finished loading. */
function pageStateInPage(token) {
  return { marked: window.__uiicPage === token, leaving: !!window.__uiicLeaving, ready: document.readyState, url: String(location.href) };
}

/** A short form of a popup's text for the log. */
const shortText = (text) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 90 ? `${t.slice(0, 87)}...` : t;
};

/**
 * Click the button and watch for the next page (the page-load limit = the time left meanwhile).
 * @returns {Promise<{ clicks: number, popups: string[] }>} popups: the ones answered OK on the way
 */
async function clickAndWait(driver, { img, target, label, stage, token, handlesBefore, onPopup, waitMs, log, now, sleep }, o) {
  const refuse = popupOr(label, stage);
  const popups = [];
  const ctx = { label, stage, log, o };
  // a popup the click itself met (ChromeDriver already closed it): the portal's answer
  const start = now();
  const onItsWay = () => log(`   ${Math.round((now() - start) / 1000)} s after "${label}": the next page is on its way - United India is still answering`);
  // the click itself may wait for the page it starts (no popup on the way) - said every 5 s too
  let { pending } = await sayWhileHeld(clickOnce(driver, img, ctx), o.onItsWayLineMs || ON_ITS_WAY_LINE_MS, onItsWay).catch(refuse);
  let clicks = 1;
  let reported = 0;
  for (;;) {
    throwIfHeld(driver);
    await limitToTimeLeft(driver, waitMs - (now() - start)); // a page on its way is waited for, not cancelled
    // a popup FIRST - any other command would close it with Cancel
    const popup = await sayWhileHeld(readOpenAlert(driver), o.onItsWayLineMs || ON_ITS_WAY_LINE_MS, onItsWay);
    if (popup) {
      const answer = onPopup ? await onPopup(popup.text) : null;
      if (answer === "accept") {
        await popup.accept();
        popups.push(popup.text);
        log(`✓ United India - after "${label}" the portal asked "${shortText(popup.text)}" - OK pressed`);
        continue;
      }
      await (onPopup ? popup.dismiss() : popup.accept()).catch(() => {});
      throw alertRefusal(label, popup.text, stage);
    }
    // a new window: the run goes on there
    const handles = await driver.getAllWindowHandles().catch(() => null);
    const added = (handles || []).filter((h) => !handlesBefore.includes(h));
    if (added.length) {
      await driver.switchTo().window(added[added.length - 1]);
      log("   the next page opened in a new window - the run goes on there");
      return { clicks, popups };
    }
    const page = await sayWhileHeld(
      driver.executeScript(pageStateInPage, token).catch((e) => {
        if (alertTextOf(e) !== null) refuse(e);
        if (isPageLoadWait(e)) pending = true; // the page on its way missed the time left (cancelled by ChromeDriver)
        return null; // mid-navigation: not decided yet
      }),
      o.onItsWayLineMs || ON_ITS_WAY_LINE_MS,
      onItsWay
    );
    if (page && !page.marked && page.ready === "complete") return { clicks, popups }; // a new page, loaded

    const waited = now() - start;
    // what the run sees while the page has not changed (5, 10, 15 s) - the next live log says why
    if (page && page.marked && Math.floor(waited / 5000) > reported && waited < waitMs) {
      reported = Math.floor(waited / 5000);
      const st = await driver.executeScript(portalBusyInPage, null).catch(() => null);
      const loader = await isLoaderVisible(driver, "united india").catch(() => false);
      log(
        `⏳ United India - still on the same page ${reported * 5} s after "${label}" (submit started: ${page.leaving ? "yes" : "no"}, page load seen: ${pending ? "yes" : "no"}, loader: ${loader ? "up" : "none"}, requests running: ${(st && st.ajax) || 0})`
      );
    }
    if (waited >= waitMs) {
      await driver.executeScript("window.stop();").catch(() => {}); // the hung submit is cancelled - it cannot land later
      throw new MultiCompanyError(
        "E301",
        `United India - after "${label}" was clicked the next page did not open within ${waitMs / 1000} seconds, so the run stopped there. It will try again shortly.`,
        { company: "united india", stage }
      );
    }
    // the owner's rule (one more click) - only when nothing shows the first click was taken
    if (clicks === 1 && !pending && waited >= RECLICK_AFTER_MS && page && page.marked && !page.leaving) {
      const busy = await isLoaderVisible(driver, "united india").catch(() => true);
      const again = !busy && (await waitForShown(driver, target, 1000, o));
      if (again) {
        log(`↻ United India - "${label}" was clicked but the page has not started to change after ${RECLICK_AFTER_MS / 1000} seconds - clicking it once more`);
        await showOnScreen(driver, again, o, label).catch(refuse);
        await waitPortalReady(driver, again, { label, stage }, o);
        throwIfHeld(driver);
        ({ pending } = await clickOnce(driver, again, ctx).catch(refuse));
        clicks = 2;
      }
    }
    await sleep(driver, POLL_MS);
  }
}

/** The loader must stay off this long (on a loaded page) before a step counts as done (the owner: "watch it carefully"). */
const SETTLE_QUIET_MS = 2000;

/** What the portal shows right now: { pending, loaded, loader (its name or null), url } - a pending page counts as loading. */
async function lookAtPortal(driver, token) {
  const page = await driver.executeScript(pageStateInPage, token).catch(() => null);
  if (!page) return { pending: true, loaded: false, loader: null, marked: null, url: "" };
  const st = await driver.executeScript(portalBusyInPage, null, LOADER_PRESETS["united india"].busy).catch(() => null);
  return {
    pending: false,
    loaded: page.ready === "complete",
    loader: (st && st.loader) || null,
    marked: page.marked,
    leaving: page.leaving,
    url: page.url,
  };
}

const secs = (ms) => `${Math.round(ms / 100) / 10} s`;

/** In the page: the lines of United India's "Error In Data Entry" box (.errormsgbox li) - shown ones only, each once. */
function portalErrorsInPage() {
  var out = [];
  var boxes = document.querySelectorAll(".errormsgbox, #err .errorMsg");
  for (var i = 0; i < boxes.length; i++) {
    var box = boxes[i];
    if (!box.getClientRects().length) continue; // hidden
    var items = box.querySelectorAll("li");
    for (var j = 0; j < items.length; j++) {
      var t = (items[j].textContent || "").replace(/\s+/g, " ").trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
  }
  return out;
}

/**
 * United India refused the details on its page: [E306] in its words, not retried (the screenshot shows the box). It carries
 * what the portal said (portalError, portalLines, portalLabel, portalStage): the handler does the steps once more the first
 * time - the portal sometimes shows a wrong error ("(0)null", the owner's live run, 2026-11-14) - and `again` words the
 * second one.
 */
const portalDataError = (label, lines, stage, { again = false } = {}) =>
  Object.assign(
    new MultiCompanyError(
      "E306",
      `United India - after "${label}" the portal says "Error In Data Entry - ${lines.join(" / ").replace(/:/g, " -")}"${again ? " a second time (the run had done it all once more)" : ""}, so the run stopped there. Correct the policy (or tell support what the portal wants), then run it again.`,
      { company: "united india", stage, retryable: false }
    ),
    { portalError: true, portalLines: lines, portalLabel: label, portalStage: stage }
  );

/** Stop when the page shows United India's "Error In Data Entry" box. */
async function throwIfPortalError(driver, label, stage) {
  const lines = await driver.executeScript(portalErrorsInPage).catch(() => null);
  if (Array.isArray(lines) && lines.length) throw portalDataError(label, lines, stage);
}

/**
 * Watch the portal after a button press, saying what it sees: the loader appearing / stopping, the page changing, a line every
 * 5 s. DONE when the page is loaded, no loader shows and it has stayed so for 2 s, and `isDone(seen)` agrees (seen = { loader,
 * changed, answered } - a loader was seen, the page changed, a popup was answered OK). A popup is read first ([E308] unless `onPopup` says "accept").
 * @returns {Promise<{ done: boolean, loaderSeen: boolean, loaderMs: number, changed: boolean, spinning: boolean }>}
 */
async function watchAfter(driver, { label, stage, token, handlesBefore, maxMs, onPopup = null, isDone = async () => true, startedAt = null }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const start = startedAt === null ? now() : startedAt; // from the press: a click that waited for its page counts too
  let loaderOn = false;
  let loaderSeen = false;
  let loaderFrom = 0;
  let loaderMs = 0;
  let changed = false;
  let quietFrom = null;
  let reported = 0;
  let last = null;
  let answered = 0;
  const everyMs = o.onItsWayLineMs || ON_ITS_WAY_LINE_MS;
  const onItsWay = () => log(`   ${Math.round((now() - start) / 1000)} s after "${label}": the page is on its way - United India is still answering`);
  for (;;) {
    throwIfHeld(driver);
    await limitToTimeLeft(driver, maxMs - (now() - start)); // a page on its way is waited for until the owner's time is up
    const popup = await sayWhileHeld(readOpenAlert(driver), everyMs, onItsWay);
    if (popup) {
      const answer = onPopup ? await onPopup(popup.text) : null;
      if (answer === "accept") {
        await popup.accept();
        answered += 1;
        log(`✓ United India - after "${label}" the portal asked "${shortText(popup.text)}" - OK pressed`);
        quietFrom = null;
        continue;
      }
      await (onPopup ? popup.dismiss() : popup.accept()).catch(() => {});
      throw alertRefusal(label, popup.text, stage);
    }
    if (handlesBefore && !changed) {
      const handles = await driver.getAllWindowHandles().catch(() => null);
      const added = (handles || []).filter((h) => !handlesBefore.includes(h));
      if (added.length) {
        await driver.switchTo().window(added[added.length - 1]);
        log(`   the page opened in a new window ${secs(now() - start)} after "${label}" - the run goes on there`);
        changed = true;
      }
    }
    last = await sayWhileHeld(lookAtPortal(driver, token), everyMs, onItsWay);
    const t = now() - start;
    if (!changed && last.marked === false) {
      changed = true;
      log(`   the page changed ${secs(t)} after "${label}" (${last.url})`);
    }
    const busy = last.pending || !last.loaded || !!last.loader;
    if (last.loader && !loaderOn) {
      loaderOn = true;
      loaderSeen = true;
      loaderFrom = now();
      log(`⏳ United India - the portal's loader is showing (${last.loader}) ${secs(t)} after "${label}"`);
    } else if (!last.loader && loaderOn) {
      loaderOn = false;
      loaderMs += now() - loaderFrom;
      log(`   the loader stopped ${secs(t)} after "${label}"`);
    }
    if (busy) quietFrom = null;
    else if (quietFrom === null) quietFrom = now();
    if (!busy && now() - quietFrom >= SETTLE_QUIET_MS) {
      await throwIfPortalError(driver, label, stage); // United India's own refusal is never taken for a slow portal
      if (await isDone({ loader: loaderSeen, changed, answered })) return { done: true, loaderSeen, loaderMs, changed, spinning: false };
    }
    // the time is up while the portal is still busy = still spinning; a loader that has ALREADY stopped gets its 2 s to prove it
    // stays off (an answer at 14 s of 15 is done, not refreshed)
    if (t >= maxMs && (busy || t >= maxMs + SETTLE_QUIET_MS)) {
      if (loaderOn) loaderMs += now() - loaderFrom;
      return { done: false, loaderSeen, loaderMs, changed, spinning: busy };
    }
    if (Math.floor(t / 5000) > reported) {
      reported = Math.floor(t / 5000);
      log(
        `   ${reported * 5} s after "${label}": loader ${last.loader ? `showing (${last.loader})` : "not showing"}, page ${last.pending ? "on its way" : last.loaded ? "loaded" : "loading"}`
      );
    }
    await sleep(driver, POLL_MS);
  }
}

/**
 * Press `target` once (the portal ready first, the page marked) and watch until done or `maxMs` (see watchAfter).
 * @returns {Promise<{ done, loaderSeen, loaderMs, changed, spinning }>}
 */
async function pressAndWatch(driver, { label, target, stage, maxMs, onPopup = null, isDone }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const refuse = popupOr(label, stage);
  const img = await waitForShown(driver, target, 10000, o);
  if (!img) throw notVisible(label, 10, stage);
  await showOnScreen(driver, img, o, label).catch(refuse);
  await waitPortalReady(driver, img, { label, stage }, o);
  const token = `uiic-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  await driver.executeScript(markPageInPage, token).catch(refuse);
  const handlesBefore = (await driver.getAllWindowHandles().catch(() => null)) || [];
  throwIfHeld(driver);
  const limitBefore = await pageLoadLimit(driver, maxMs); // the page the press starts is waited for, not cancelled
  try {
    log(`🧮 United India - "${label}" pressed - watching the portal's loader (up to ${maxMs / 1000} seconds)`);
    const startedAt = now();
    const onItsWay = () => log(`   ${Math.round((now() - startedAt) / 1000)} s after "${label}": the page is on its way - United India is still answering`);
    await sayWhileHeld(clickOnce(driver, img, { label, stage, log, o }), o.onItsWayLineMs || ON_ITS_WAY_LINE_MS, onItsWay).catch(refuse);
    return await watchAfter(driver, { label, stage, token, handlesBefore, maxMs, onPopup, isDone, startedAt }, { ...o, log });
  } finally {
    if (limitBefore) await pageLoadLimit(driver, limitBefore);
  }
}

/**
 * After a refresh: wait until the page is loaded and the loader has stopped (stayed off 2 s), at most `maxMs`, saying what it
 * sees. @returns {Promise<boolean>}
 */
async function waitSettled(driver, { label, stage, maxMs }, o = {}) {
  const now = o.now || Date.now;
  const token = `uiic-${now()}-settle`; // nothing carries this mark - the page is never "the same page"
  const limitBefore = await pageLoadLimit(driver, maxMs);
  try {
    const out = await watchAfter(driver, { label, stage, token, handlesBefore: null, maxMs }, o);
    return out.done;
  } finally {
    if (limitBefore) await pageLoadLimit(driver, limitBefore);
  }
}

/**
 * Click a button that submits the page, and wait for the next page.
 * @param {WebDriver} driver
 * @param {Object} step  { label, target (selectors), stage, waitMs? (20 s), onPopup?(text) -> "accept" | anything else }
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ url: string, clicks: number, popups: string[] }>}
 */
async function clickToNextPage(driver, { label, target, stage, waitMs = NAV_WAIT_MS, onPopup = null }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const refuse = popupOr(label, stage);

  const img = await waitForShown(driver, target, 10000, o);
  if (!img) throw notVisible(label, 10, stage);
  const token = `uiic-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  await driver.executeScript(markPageInPage, token).catch(refuse);
  const handlesBefore = (await driver.getAllWindowHandles().catch(() => null)) || [];
  log(`📑 United India - "${label}": opening the next page (up to ${waitMs / 1000} seconds)`);

  await showOnScreen(driver, img, o, label).catch(refuse);
  await waitPortalReady(driver, img, { label, stage }, o); // the portal ready BEFORE the click (the owner's lost click)
  throwIfHeld(driver);
  const limitBefore = await pageLoadLimit(driver, waitMs); // the page the click starts is waited for, not cancelled
  let out;
  try {
    out = await clickAndWait(driver, { img, target, label, stage, token, handlesBefore, onPopup, waitMs, log, now, sleep }, o);
  } finally {
    if (limitBefore) await pageLoadLimit(driver, limitBefore); // back to the run's own page-load limit
  }

  await waitForLoader(driver, "united india", { stage }).catch(refuse);
  await throwIfPortalError(driver, label, stage); // the next page may be United India's refusal
  const url = await driver.getCurrentUrl().catch(() => "");
  log(`✅ United India - the page after "${label}" is open (${url})${out.clicks > 1 ? " (try 2)" : ""}`);
  return { url, clicks: out.clicks, popups: out.popups };
}

module.exports = {
  clickToNextPage,
  pressAndWatch,
  watchAfter,
  waitSettled,
  lookAtPortal,
  SETTLE_QUIET_MS,
  portalErrorsInPage,
  portalDataError,
  throwIfPortalError,
  clickOnce,
  isPageLoadWait,
  pageLoadLimit,
  readOpenAlert,
  markPageInPage,
  pageStateInPage,
  NAV_WAIT_MS,
  RECLICK_AFTER_MS,
  MIN_LIMIT_MS,
  ON_ITS_WAY_LINE_MS,
  limitToTimeLeft,
  sayWhileHeld,
};
