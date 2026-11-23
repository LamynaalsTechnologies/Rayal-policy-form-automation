"use strict";

/**
 * Reading the page in ONE browser call instead of one call per element (2026-11-23, speed round 2).
 *
 * Why: the server's CPU core is ~2.8x slower than the laptop, and every browser call costs a round trip plus work in
 * the page. KSHEMA runs made hundreds of tiny calls per field (find, then "is it visible?" for each element, then
 * "what is its text?" for each element). Each helper here asks the page once.
 *
 * Same answers as before:
 *   - "visible" is decided by selenium's OWN isDisplayed atom (node_modules/selenium-webdriver/lib/atoms/is-displayed.js,
 *     the exact script WebElement.isDisplayed() runs), so a hidden element is skipped exactly as before;
 *   - selectors are tried in the same order, elements in document order (as findElements returns them);
 *   - a selector starting with "//" or "(" is XPath, anything else CSS (kshemaFields.asLocator's rule);
 *   - text is the element's rendered text (innerText) with a non-breaking space read as a space, like getText.
 * Every helper THROWS when its call cannot run (a fake driver in a test, a page that is changing) so the caller falls
 * back to its old one-call-per-element way. Nothing is clicked or typed here.
 */

const isDisplayedAtom = require("selenium-webdriver/lib/atoms/is-displayed.js");

// `isShown(el)` inside the page = WebElement.isDisplayed() outside it.
const IS_SHOWN = `var isShown = (${isDisplayedAtom.toString()});`;

// Find every match of one selector, in document order. A selector is a string (XPath when it starts with "//" or "(",
// CSS otherwise) or { type: "css" | "xpath", value } (a selenium By, converted in Node by toPageSelector).
const FIND_ALL = `
  function findAll(selector, root) {
    var ctx = root || document;
    if (selector && typeof selector === "object") {
      if (selector.type === "xpath") return findAll({ forceXpath: String(selector.value || "") }, root);
      if (selector.type === "css") return Array.prototype.slice.call(ctx.querySelectorAll(String(selector.value || "")));
      if (typeof selector.forceXpath === "string") {
        var snapX = document.evaluate(selector.forceXpath, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        var outX = [];
        for (var x = 0; x < snapX.snapshotLength; x++) outX.push(snapX.snapshotItem(x));
        return outX;
      }
      throw new Error("unknown selector");
    }
    var s = String(selector || "").trim();
    if (s.indexOf("//") === 0 || s.indexOf("(") === 0) {
      var snap = document.evaluate(s, ctx, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      var out = [];
      for (var i = 0; i < snap.snapshotLength; i++) out.push(snap.snapshotItem(i));
      return out;
    }
    return Array.prototype.slice.call(ctx.querySelectorAll(s));
  }
  function textOf(el) {
    return String(el.innerText || "").replace(/\\u00a0/g, " ");
  }
`;

const READ_TEXTS_SCRIPT = `${IS_SHOWN}${FIND_ALL}
  var els = arguments[0] || [];
  return els.map(function (el) {
    try {
      return el && el.isConnected && isShown(el) ? textOf(el) : "";
    } catch (e) {
      return "";
    }
  });
`;

const FIRST_SHOWN_SCRIPT = `${IS_SHOWN}${FIND_ALL}
  var selectors = arguments[0] || [];
  var root = arguments[1] || null;
  var requireVisible = arguments[2] !== false;
  for (var i = 0; i < selectors.length; i++) {
    var els;
    try {
      els = findAll(selectors[i], root);
    } catch (e) {
      continue; // a selector the page cannot run is skipped, as findElements' error was
    }
    for (var j = 0; j < els.length; j++) {
      try {
        if (!requireVisible || isShown(els[j])) return { element: els[j], index: i };
      } catch (e) {}
    }
  }
  return { element: null, index: -1 };
`;

/**
 * The visible text of each element: same order and count, trimmed, "" for one that is not shown.
 * Throws when the call cannot run or the answer does not line up with `els`.
 */
async function readTexts(driver, els) {
  if (!els || !els.length) return [];
  const texts = await driver.executeScript(READ_TEXTS_SCRIPT, els);
  if (!Array.isArray(texts) || texts.length !== els.length) throw new Error("the page did not answer for every element");
  return texts.map((t) => String(t == null ? "" : t).trim());
}

/**
 * A selector as the page script takes it. Strings stay strings (the "//" / "(" rule above). A selenium By becomes
 * { type, value } when it is CSS or XPath - By.id / By.name / By.className are CSS inside selenium already. Anything
 * else (link text, a function) cannot be asked in one call: this throws, and the caller uses its old way.
 */
function toPageSelector(selector) {
  if (typeof selector === "string") return selector;
  if (selector && typeof selector === "object" && typeof selector.value === "string") {
    if (selector.using === "css selector") return { type: "css", value: selector.value };
    if (selector.using === "xpath") return { type: "xpath", value: selector.value };
  }
  throw new Error("a selector the page cannot run in one call");
}

/**
 * The first visible element of the first selector (in order) that has one: { element, selector } or
 * { element: null, selector: null }. `selector` is the caller's own entry (string or By). `root` limits the search to
 * inside that element, like root.findElements. `requireVisible: false` takes the first element found, shown or not.
 * Throws when the call cannot run.
 */
async function findFirstShown(driver, selectors, root = null, { requireVisible = true } = {}) {
  const original = Array.from(selectors || []);
  const list = original.map(toPageSelector);
  const res = await driver.executeScript(FIRST_SHOWN_SCRIPT, list, root || null, requireVisible !== false);
  if (!res || typeof res !== "object" || typeof res.index !== "number") throw new Error("the page did not answer");
  if (!res.element || res.index < 0) return { element: null, selector: null };
  return { element: res.element, selector: original[res.index] };
}

const FIRST_TEXT_SCRIPT = `${IS_SHOWN}${FIND_ALL}
  var selectors = arguments[0] || [];
  for (var i = 0; i < selectors.length; i++) {
    var els;
    try {
      els = findAll(selectors[i], null);
    } catch (e) {
      continue;
    }
    for (var j = 0; j < els.length; j++) {
      try {
        if (!isShown(els[j])) continue;
        var text = textOf(els[j]).trim();
        if (text) return { text: text, index: i };
      } catch (e) {}
    }
  }
  return { text: "", index: -1 };
`;

/**
 * The text of the first visible element with text, trying the selectors in order: { text, selector } or
 * { text: "", selector: null }. Throws when the call cannot run.
 */
async function firstShownText(driver, selectors) {
  const original = Array.from(selectors || []);
  const list = original.map(toPageSelector);
  const res = await driver.executeScript(FIRST_TEXT_SCRIPT, list);
  if (!res || typeof res !== "object" || typeof res.index !== "number") throw new Error("the page did not answer");
  if (res.index < 0 || !res.text) return { text: "", selector: null };
  return { text: String(res.text).trim(), selector: original[res.index] };
}

module.exports = { readTexts, findFirstShown, firstShownText, toPageSelector, IS_SHOWN, FIND_ALL };
