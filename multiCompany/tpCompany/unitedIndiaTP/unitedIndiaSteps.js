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
 * A portal popup (alert) met by a click, a choice or typing is the portal's answer: [E308] in its own words, not retried
 * (choices and typing too since 2026-11-13 - before, their popups were swallowed into "shows X instead of Y").
 */
const { MultiCompanyError } = require("../../common/errors");
const { By } = require("selenium-webdriver");
const { firstVisible, clickWithFallback } = require("../../common/elements");
const { throwIfHeld } = require("../../../lib/holdStop");
const { readSelectInPage, setSelectByScriptInPage, findOptionIndex } = require("../../../lib/realSelect");
const { LOADER_PRESETS } = require("../../common/loader");

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

/** After the screen really moved to a box, this long a pause: the run's video shows the box before it changes. */
const VIDEO_PAUSE_MS = 200;
/** A move smaller than this (pixels) is not a move worth a pause. */
const MOVED_PX = 40;

/**
 * In the page: put the box in the MIDDLE of the screen, at once (a page's smooth scrolling would still be moving while the
 * box is typed into), every scrolling parent too; when it is still not on the screen, the window itself is scrolled.
 * Returns how far the box moved and whether it is on the screen now.
 */
function centerInPage(el) {
  if (!el || !el.getBoundingClientRect) return null;
  var before = el.getBoundingClientRect().top;
  try {
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  } catch (e) {
    el.scrollIntoView(false);
  }
  var h = window.innerHeight || document.documentElement.clientHeight;
  var r = el.getBoundingClientRect();
  if (r.top < 0 || r.bottom > h) {
    window.scrollBy(0, r.top - (h / 2 - r.height / 2));
    r = el.getBoundingClientRect();
  }
  return { moved: Math.abs(r.top - before), onScreen: r.bottom > 0 && r.top < h, top: r.top, height: h };
}

/**
 * Show this box on the screen before it is filled, chosen, clicked, checked or waited for (the owner, 2026-11-13: the
 * fields lower on the page were filled off the screen, so the run's video did not show them). A portal popup is passed
 * on (the caller reports it); anything else about scrolling never stops the run.
 * @returns {Promise<{moved: number, onScreen: boolean} | null>}
 */
async function showOnScreen(driver, el, o = {}, label = "") {
  const { sleep } = defaults(o);
  let out = null;
  try {
    out = await driver.executeScript(centerInPage, el);
  } catch (e) {
    if (alertTextOf(e) !== null || (e && e.isAutomationStop)) throw e; // a popup or a Hold / Breaker stop goes on up
    return null;
  }
  if (out && out.moved >= MOVED_PX) await sleep(driver, VIDEO_PAUSE_MS);
  // the box is on the screen: a loader lying over it is waited for (a click / a choice under it is lost)
  await waitPortalReady(driver, el, { label, coverOnly: true }, o);
  return out;
}

/** The longest the run waits for the portal's loader / its requests before a step (the owner, 2026-11-13: 40 s). */
const PORTAL_BUSY_MAX_MS = 40000;

/**
 * In the page: is the portal busy around this box? (the owner, 2026-11-13: "the loader opens for some time, then clicking does
 * not work - wait for the loader")
 *   loader - the portal's own loader showing ANYWHERE (United India's small "Loading..." box div#dialog.window with
 *            wait.gif, the owner's markup - and the common markers, loader.js "united india"): its tag, id and classes
 *   cover  - a PAGE-WIDE layer drawn over the box's middle (a loader / blocking overlay, whatever its name): its tag, id and
 *            classes; a small neighbour overlapping the box does not count
 *   ajax   - jQuery's requests still running (the portal fetches its lists with jQuery)
 *   ready  - the page's own load
 */
function portalBusyInPage(el, loaderSelector) {
  var describe = function (n) {
    var cls = typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).join(".") : "";
    return (n.tagName || "").toLowerCase() + (n.id ? "#" + n.id : "") + cls;
  };
  var loader = null;
  // the page itself and every frame of it the page may read (the spinner may live in a frame): the first loader showing
  var docs = [{ doc: document, where: "" }];
  try {
    var frames = document.querySelectorAll("iframe, frame");
    for (var f = 0; f < frames.length; f++) {
      try {
        var fd = frames[f].contentDocument;
        if (fd) docs.push({ doc: fd, where: " in a frame" });
      } catch (e) {
        /* another site's frame - not ours to read */
      }
    }
  } catch (e) {
    /* no frames */
  }
  for (var d = 0; d < docs.length && !loader; d++) {
    try {
      var nodes = loaderSelector ? docs[d].doc.querySelectorAll(loaderSelector) : [];
      var view = docs[d].doc.defaultView || window;
      for (var i = 0; i < nodes.length && !loader; i++) {
        var ln = nodes[i];
        var ls = view.getComputedStyle(ln);
        if (ls.display === "none" || ls.visibility === "hidden" || parseFloat(ls.opacity || "1") < 0.05) continue;
        if (ln.offsetParent === null && ls.position !== "fixed") continue;
        var lr = ln.getBoundingClientRect();
        if (lr.width === 0 || lr.height === 0) continue;
        loader = describe(ln) + docs[d].where;
      }
    } catch (e) {
      /* this document could not be read */
    }
  }
  var cover = null;
  try {
    if (el && el.getBoundingClientRect) {
      var r = el.getBoundingClientRect();
      var x = r.left + r.width / 2;
      var y = r.top + r.height / 2;
      if (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) {
        var top = document.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top) && !top.contains(el)) {
          for (var n = top; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
            var cs = window.getComputedStyle(n);
            if (cs.position === "fixed" || cs.position === "absolute") {
              var b = n.getBoundingClientRect();
              if (b.width >= window.innerWidth * 0.5 && b.height >= window.innerHeight * 0.5) {
                cover = describe(n);
                break;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    cover = null;
  }
  var ajax = 0;
  try {
    ajax = window.jQuery && typeof window.jQuery.active === "number" ? window.jQuery.active : 0;
  } catch (e) {
    ajax = 0;
  }
  return { loader: loader, cover: cover, ajax: ajax, ready: document.readyState };
}

/**
 * Wait until the portal is ready for this box: its loader not showing, nothing page-wide over the box, and - unless
 * `coverOnly` - the page loaded and no jQuery request running. At most PORTAL_BUSY_MAX_MS, then [E302] naming what was still busy. Says in the log when it had to wait.
 * Anything that cannot be read (a test page, a script error) counts as ready - it never blocks a run by itself.
 * @param {Object} what  { label, coverOnly?, maxMs?, stage? }
 */
async function waitPortalReady(driver, el, { label = "", coverOnly = false, maxMs = PORTAL_BUSY_MAX_MS, stage = "united-india-step" } = {}, o = {}) {
  const { now, sleep, log } = defaults(o);
  const start = now();
  let said = false;
  for (;;) {
    throwIfHeld(driver);
    let st = null;
    try {
      st = await driver.executeScript(portalBusyInPage, el, LOADER_PRESETS["united india"].busy);
    } catch (e) {
      if (alertTextOf(e) !== null || (e && e.isAutomationStop)) throw e;
      st = null;
    }
    const busy = !st
      ? []
      : [
          st.loader && `its loader (${st.loader}) is showing`,
          st.cover && st.cover !== st.loader && `its loader (${st.cover}) covers the page`,
          !coverOnly && st.ajax > 0 && `${st.ajax} request${st.ajax > 1 ? "s" : ""} still running`,
          !coverOnly && st.ready && st.ready !== "complete" && "the page is still loading",
        ].filter(Boolean);
    if (!busy.length) {
      if (said) log(`   the portal is ready after ${Math.round((now() - start) / 100) / 10} s - going on${label ? ` with "${label}"` : ""}`);
      return { waitedMs: now() - start };
    }
    if (!said) {
      log(`⏳ United India - waiting for the portal${label ? ` before "${label}"` : ""}: ${busy.join(", ")}`);
      said = true;
    }
    if (now() - start >= maxMs) {
      throw new MultiCompanyError(
        "E302",
        `United India - the portal was still busy${label ? ` before "${label}"` : ""} after ${maxMs / 1000} seconds (${busy.join(", ").replace(/:/g, " -")}) - a loader issue at United India, so the run stopped there. It will try again shortly.`,
        { company: COMPANY, stage }
      );
    }
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

/** For a .catch: a portal popup -> [E308] in its words; anything else (a Hold / Breaker stop) goes on up unchanged. */
const popupOr = (label, stage) => (e) => {
  const text = alertTextOf(e);
  if (text !== null) throw alertRefusal(label, text, stage);
  throw e;
};

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
    await showOnScreen(driver, el, o).catch(popupOr(label, stage));
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

/** In the page: a <select> element's options and its choice (for a box with no id, e.g. name="makeMonthgc"). */
function readSelectElementInPage(s) {
  if (!s || !s.options) return null;
  var options = [];
  for (var i = 0; i < s.options.length; i++) {
    var o = s.options[i];
    options.push({ value: String(o.value), text: String(o.text || "").replace(/\s+/g, " ").trim(), disabled: !!o.disabled });
  }
  return { selectedIndex: s.selectedIndex, value: String(s.value), options: options };
}

/** In the page: set a <select> element's value and fire its change event (the second try). */
function setSelectElementInPage(s, value) {
  if (!s) return false;
  s.value = value;
  s.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * Choose an option of a native <select> and read it back, at most TRIES times: first like a person (click the box, click
 * the option), then by the page's own value + change event. The wanted option is matched by its exact text (or value),
 * so "Liability Only Policy" is never "Liability Only Policy Renewal".
 * The box is found by `selectId`, or - for a box without an id (name="makeMonthgc") - by `target` (selectors).
 * @param {Object} step  { label, selectId | target, wanted, stage?, findMs? }
 * @returns {Promise<{tries: number, value: string, text: string}>}
 * @throws {MultiCompanyError} [E301] not visible, [E306] not offered (not retried: the list names what it offers) or not
 *   holding the option after TRIES tries
 */
async function selectAndConfirm(driver, step, o = {}) {
  const { log } = defaults(o);
  const { label, selectId, target: boxAt, wanted, stage = "united-india-step", findMs = 10000 } = step;
  const box = await waitForShown(driver, selectId ? [By.id(selectId)] : boxAt, findMs, o);
  if (!box) throw notVisible(label, Math.round(findMs / 1000), stage);
  // on the screen first - also a box that already shows the option is seen being checked in the video
  await showOnScreen(driver, box, o).catch(popupOr(label, stage));
  const read = () => (selectId ? driver.executeScript(readSelectInPage, selectId) : driver.executeScript(readSelectElementInPage, box));
  const setByScript = (value) =>
    selectId ? driver.executeScript(setSelectByScriptInPage, selectId, value) : driver.executeScript(setSelectElementInPage, box, value);
  let state = await read();
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
  // A popup the box's onchange opens (change(), toggleHighRisk(), setthevalue() ...) is the portal's answer: [E308] in its
  // words, not retried - never swallowed into a "shows X instead of Y" (2026-11-13).
  const refuseIfAlert = (e) => {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(label, text, stage);
  };
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    throwIfHeld(driver);
    if (attempt === 1) {
      try {
        await showOnScreen(driver, box, o).catch(refuseIfAlert);
        await box.click();
        const options = await box.findElements(By.css("option"));
        if (options[target]) await options[target].click();
      } catch (e) {
        refuseIfAlert(e);
        if (e instanceof MultiCompanyError || (e && e.isAutomationStop)) throw e; // a loader issue / a stop goes on up
        /* the list could not be used - the second try sets it the page's own way */
      }
    } else {
      await showOnScreen(driver, box, o).catch(popupOr(label, stage));
      await setByScript(chosen.value).catch(refuseIfAlert);
    }
    throwIfHeld(driver);
    await driver.executeScript("if (document.activeElement === arguments[0]) { arguments[0].blur(); }", box).catch(refuseIfAlert);
    state = await read().catch((e) => {
      refuseIfAlert(e);
      return null;
    });
    const late = await takeOpenAlert(driver); // a popup still open (opened after the last command)
    if (late !== null) throw alertRefusal(label, late, stage);
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

/** In the page: leave the box like a person (focus, then away) - its onblur runs (getStateDist, validateEmail ...). */
function leaveBoxInPage(el) {
  if (document.activeElement !== el) el.focus();
  el.blur();
  return document.activeElement !== el;
}

/** Empty a box without focusing or leaving it (no onfocus / onblur / change). */
const CLEAR_QUIETLY_SCRIPT = "arguments[0].value = '';";

/** The native value setter + input / change events (the same script as common/elements.js typeWithReadback). */
const SET_INPUT_SCRIPT = `const el = arguments[0], v = arguments[1];
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setter.call(el, v);
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));`;

/**
 * Type like common/elements.js typeWithReadback (keys, then the native setter if the keys did not land) - but a portal
 * popup met on the way is handed to `refuseIfAlert` instead of being swallowed.
 */
async function typeInto(driver, el, want, refuseIfAlert, { clearQuietly = false } = {}) {
  try {
    // Selenium's clear() focuses the box, empties it and LEAVES it - its onblur runs (the Pin Code's getStateDist() with
    // an empty box). clearQuietly empties it by script instead: no focus change, no event.
    if (clearQuietly) await driver.executeScript(CLEAR_QUIETLY_SCRIPT, el);
    else await el.clear();
    await el.sendKeys(want);
    if ((await el.getAttribute("value")) === want) return;
  } catch (e) {
    refuseIfAlert(e);
    /* the keys did not land - the native setter below */
  }
  try {
    await driver.executeScript(SET_INPUT_SCRIPT, el, want);
  } catch (e) {
    refuseIfAlert(e);
  }
}

/** The same text, ignoring case and spaces at the ends. */
const sameText = (a, b) => String(a == null ? "" : a).trim().toLowerCase() === String(b == null ? "" : b).trim().toLowerCase();

/**
 * Type `value` into `target` and read it back, at most TRIES times.
 * @param {Object} step  { label, target, value, stage?, findMs?, same?(got, want), keepIfSame?, clearQuietly? }
 *   keepIfSame: a box the portal already filled with exactly this value is left as it is (read, not typed again) - e.g.
 *   the Year of Manufacture, which the page shows as the current year
 *   clearQuietly: emptied by script, not Selenium's clear() (which leaves the box and so runs its onblur) - the Pin Code
 * @returns {Promise<{tries: number}>}  tries 0 = it already held the value
 * @throws {MultiCompanyError} [E301] not visible, [E306] it does not hold the value after TRIES tries
 */
async function fillAndConfirm(driver, step, o = {}) {
  const { log } = defaults(o);
  const { label, target, value, stage = "united-india-step", findMs = 10000, same = sameText, keepIfSame = false, clearQuietly = false } = step;
  // `mask`: how a private value (an Aadhaar number) shows in the log and the errors - never the whole of it
  const mask = typeof step.mask === "function" ? step.mask : (v) => v;
  const want = String(value == null ? "" : value);
  let got = "";
  if (keepIfSame) {
    const el = await waitForShown(driver, target, findMs, o);
    if (!el) throw notVisible(label, Math.round(findMs / 1000), stage);
    await showOnScreen(driver, el, o).catch(popupOr(label, stage));
    got = await el.getAttribute("value").catch(() => "");
    if (same(got, want)) {
      log(`✓ United India - ${label} already holds "${mask(want)}" (as the portal filled it, not typed again)`);
      return { tries: 0 };
    }
  }
  // a popup the box opens while it is typed into (onkeyup nodot() ...) is the portal's answer: [E308], not retried
  const refuseIfAlert = (e) => {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(label, text, stage);
  };
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const el = await waitForShown(driver, target, findMs, o);
    if (!el) throw notVisible(label, Math.round(findMs / 1000), stage);
    await showOnScreen(driver, el, o).catch(popupOr(label, stage));
    throwIfHeld(driver);
    await typeInto(driver, el, want, refuseIfAlert, { clearQuietly });
    throwIfHeld(driver);
    got = await el.getAttribute("value").catch((e) => {
      refuseIfAlert(e);
      return "";
    });
    const late = await takeOpenAlert(driver);
    if (late !== null) throw alertRefusal(label, late, stage);
    if (same(got, want)) {
      log(`✓ United India - ${label} = "${mask(want)}"${attempt > 1 ? ` (try ${attempt})` : ""}`);
      return { tries: attempt };
    }
    if (attempt < TRIES) log(`↻ United India - ${label} reads "${mask(got)}" instead of "${mask(want)}" - typing it once more`);
  }
  throw new MultiCompanyError(
    "E306",
    `United India - ${label} holds "${mask(got)}" instead of "${mask(want)}" after ${TRIES} tries, so the run stopped there. ` +
      "It will try again shortly.",
    { company: COMPANY, stage }
  );
}

module.exports = {
  clickAndConfirm,
  fillAndConfirm,
  selectAndConfirm,
  waitForShown,
  waitUntil,
  alertTextOf,
  takeOpenAlert,
  alertRefusal,
  notVisible,
  showOnScreen,
  centerInPage,
  popupOr,
  waitPortalReady,
  portalBusyInPage,
  PORTAL_BUSY_MAX_MS,
  leaveBoxInPage,
  VIDEO_PAUSE_MS,
  CLEAR_QUIETLY_SCRIPT,
  readSelectElementInPage,
  setSelectElementInPage,
  TRIES,
};
