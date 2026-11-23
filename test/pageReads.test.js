"use strict";

// lib/pageReads.js and the one-call reads built on it (speed round 2). Every one must ask the page ONCE, give the same
// answer the old one-by-one loop gave, and fall back to that old loop when the call cannot run or answers oddly.
// No browser, no network, no database:  node --require ./test/support/noRealWorld.js --test test/pageReads.test.js
// (Checked in real headless Chrome on replica pages on 2026-11-23: every read identical to the old way.)
const test = require("node:test");
const assert = require("node:assert/strict");
const { By } = require("selenium-webdriver");

const pageReads = require("../lib/pageReads");
const { firstVisible } = require("../multiCompany/common/elements");
const { readPortalMessage } = require("../multiCompany/common/portalMessages");
const toast = require("../fullPolicycompany/kshema/kshemaToast");
const fin = require("../fullPolicycompany/kshema/kshemaFinancier");
const fields = require("../fullPolicycompany/kshema/kshemaFields");

/** A fake element: shown or not, with a text and attributes. */
const el = (name, { shown = true, text = name, attrs = {} } = {}) => ({
  name,
  isDisplayed: async () => shown,
  getText: async () => text,
  getAttribute: async (a) => (a in attrs ? attrs[a] : null),
});

/**
 * A fake driver. `page` maps a selector value to its elements (the old loop's findElements). `script` is what
 * executeScript answers (a function of the call), or undefined for a driver without executeScript.
 */
function fakeDriver(page, script) {
  const calls = { findElements: 0, executeScript: 0 };
  const driver = {
    calls,
    async findElements(locator) {
      calls.findElements += 1;
      const key = locator && locator.value !== undefined ? locator.value : String(locator);
      if (!(key in page)) return [];
      if (page[key] === "BAD") throw new Error("invalid selector");
      return page[key];
    },
    async findElement(locator) {
      const found = await driver.findElements(locator);
      if (!found.length) throw new Error("no such element");
      return found[0];
    },
  };
  if (script !== undefined) {
    driver.executeScript = async (...args) => {
      calls.executeScript += 1;
      return typeof script === "function" ? script(...args) : script;
    };
  }
  return driver;
}

test("toPageSelector: strings as they are, CSS / XPath / id / name Bys converted, others refused", () => {
  assert.equal(pageReads.toPageSelector("//input"), "//input");
  assert.deepEqual(pageReads.toPageSelector(By.css("a.b")), { type: "css", value: "a.b" });
  assert.deepEqual(pageReads.toPageSelector(By.xpath("//a")), { type: "xpath", value: "//a" });
  assert.deepEqual(pageReads.toPageSelector(By.id("x")), { type: "css", value: '*[id="x"]' });
  assert.deepEqual(pageReads.toPageSelector(By.name("q")), { type: "css", value: '*[name="q"]' });
  assert.throws(() => pageReads.toPageSelector(By.linkText("Go")), /cannot run in one call/);
});

test("findFirstShown: one call, the caller's own selector object back, odd answers refused", async () => {
  const wanted = By.xpath("//button");
  const target = el("button");
  const d = fakeDriver({}, (script, list, root, requireVisible) => {
    assert.match(script, /isShown/, "selenium's isDisplayed atom is in the script");
    assert.deepEqual(list, [{ type: "css", value: "#a" }, { type: "xpath", value: "//button" }]);
    assert.equal(root, null);
    assert.equal(requireVisible, true);
    return { element: target, index: 1 };
  });
  const res = await pageReads.findFirstShown(d, [By.css("#a"), wanted]);
  assert.equal(res.element, target);
  assert.equal(res.selector, wanted, "the same By object the caller passed");
  assert.equal(d.calls.executeScript, 1);

  const none = await pageReads.findFirstShown(fakeDriver({}, { element: null, index: -1 }), ["#a"]);
  assert.deepEqual(none, { element: null, selector: null });
  await assert.rejects(pageReads.findFirstShown(fakeDriver({}, null), ["#a"]));
  await assert.rejects(pageReads.findFirstShown(fakeDriver({}, { element: target }), ["#a"]), "no index");
  // requireVisible false reaches the page
  const d2 = fakeDriver({}, (s, l, r, rv) => ({ element: rv === false ? target : null, index: rv === false ? 0 : -1 }));
  assert.equal((await pageReads.findFirstShown(d2, ["#a"], null, { requireVisible: false })).element, target);
});

test("readTexts: same count or it throws; firstShownText maps back to the selector", async () => {
  await assert.rejects(pageReads.readTexts(fakeDriver({}, ["a"]), [el("a"), el("b")]));
  assert.deepEqual(await pageReads.readTexts(fakeDriver({}, [" a ", null]), [el("a"), el("b")]), ["a", ""]);
  const sel = By.css(".msg");
  assert.deepEqual(await pageReads.firstShownText(fakeDriver({}, { text: " Hi ", index: 0 }), [sel]), { text: "Hi", selector: sel });
  assert.deepEqual(await pageReads.firstShownText(fakeDriver({}, { text: "", index: -1 }), [sel]), { text: "", selector: null });
});

test("firstVisible (United, multiCompany): one call when it can, the old loop otherwise", async () => {
  const page = { "#a": [el("a1", { shown: false }), el("a2")] };
  const viaPage = fakeDriver(page, { element: page["#a"][1], index: 0 });
  assert.equal(await firstVisible(viaPage, ["#a"]), page["#a"][1]);
  assert.equal(viaPage.calls.findElements, 0, "nothing asked one by one");

  for (const d of [fakeDriver(page), fakeDriver(page, () => { throw new Error("stale"); }), fakeDriver(page, "odd")]) {
    assert.equal(await firstVisible(d, ["#missing", "#a"]), page["#a"][1], "old loop: skips the hidden one");
    assert.ok(d.calls.findElements >= 2);
  }
});

test("readPortalMessage: one call when it can, the old loop otherwise", async () => {
  const page = { "#loginError": [el("e", { text: "  Invalid user id " })] };
  assert.equal(await readPortalMessage(fakeDriver(page, { text: "Invalid user id", index: 0 }), "united india"), "Invalid user id");
  assert.equal(await readPortalMessage(fakeDriver(page, () => { throw new Error("x"); }), "united india"), "Invalid user id");
  assert.equal(await readPortalMessage(fakeDriver({}), "national"), "");
});

test("readToast: the one-call answer is turned into the same object; odd answers fall back to the old loop", async () => {
  const first = toast.TOAST_TEXT_SELECTORS[0];
  const t = await toast.readToast(fakeDriver({}, { kind: "text", index: 0, text: " Login failed ", containerClass: "c" }));
  assert.deepEqual(t, { text: "Login failed", selector: first, containerClass: "c", isError: true, isSuccess: false });
  assert.equal(await toast.readToast(fakeDriver({}, { kind: "none" })), null);
  assert.deepEqual(await toast.readToast(fakeDriver({}, { kind: "container", index: 1, containerClass: "x" })), {
    text: "",
    selector: toast.TOAST_CONTAINER_SELECTORS[1],
    containerClass: "x",
    isError: false,
    isSuccess: false,
  });
  // odd answers: the old loop reads the page one by one
  const page = { [first]: [el("t", { text: "Saved successfully" })], "mat-snack-bar-container": [el("box", { attrs: { class: "ok" } })] };
  for (const odd of [undefined, null, { kind: "text", index: 99, text: "x" }, () => { throw new Error("x"); }]) {
    const res = await toast.readToast(fakeDriver(page, odd));
    assert.equal(res.text, "Saved successfully");
    assert.equal(res.containerClass, "ok");
  }
});

test("financier readOffered: same filters on the one-call answer; odd answers fall back", async () => {
  const [s0, s1, s2] = fin.OPTION_SELECTORS;
  const e1 = el("sbi"), e2 = el("hdfc");
  const answer = [
    { count: 2, rows: [{ element: el("x"), text: "No results found" }, { element: el("y"), text: "   " }] },
    { count: 3, rows: [{ element: el("d"), text: "DISABLED", ariaDisabled: "true" }, { element: e1, text: " STATE  BANK " }, { element: e2, text: "HDFC" }] },
    { count: 0, rows: [] },
  ];
  assert.deepEqual(await fin.readOffered(fakeDriver({}, answer)), [{ element: e1, text: "STATE BANK" }, { element: e2, text: "HDFC" }]);
  // wrong shape -> the old loop
  const page = { [s0]: [], [s1]: [el("v", { text: "AXIS BANK" })], [s2]: [] };
  assert.deepEqual((await fin.readOffered(fakeDriver(page, [answer[0]]))).map((o) => o.text), ["AXIS BANK"]);
});

test("National firstPresentLocator (both flows): one call per look with requireVisible passed on, the old loop otherwise", async () => {
  const flows = {
    full: require("../fullPolicycompany/national")._firstPresentLocator,
    tp: require("../multiCompany/tpCompany/nationalTP/nationalTPForm")._firstPresentLocator,
  };
  const hiddenGo = el("go", { shown: false });
  const shownGo = el("go2");
  const locator = By.xpath("//button");
  const page = { "//button": [hiddenGo, shownGo] };
  for (const [name, firstPresentLocator] of Object.entries(flows)) {
    // one call: what the page picks, with the caller's own locator object
    const seen = [];
    const d = fakeDriver(page, (script, list, root, requireVisible) => {
      seen.push(requireVisible);
      return { element: requireVisible === false ? hiddenGo : shownGo, index: 0 };
    });
    assert.deepEqual(await firstPresentLocator(d, [locator], 500), { element: shownGo, locator }, name);
    assert.deepEqual(await firstPresentLocator(d, [locator], 500, { requireVisible: false }), { element: hiddenGo, locator }, name);
    assert.deepEqual(seen, [true, false], `${name}: requireVisible reaches the page`);
    assert.equal(d.calls.findElements, 0, `${name}: nothing asked one by one`);
    // the call cannot run: the old loop, which also skips the hidden one
    const old = fakeDriver(page, () => { throw new Error("stale"); });
    assert.deepEqual(await firstPresentLocator(old, [locator], 500), { element: shownGo, locator }, name);
    // nothing there: null after the timeout, polling between looks
    const empty = fakeDriver({}, { element: null, index: -1 });
    empty.sleep = async () => {};
    assert.equal(await firstPresentLocator(empty, [locator], 30, { pollInterval: 5 }), null, name);
    assert.ok(empty.calls.executeScript >= 2, `${name}: it looked again until the timeout`);
  }
});

test("kshemaFields.findVisibleOnce: one call when it can, the old loop otherwise", async () => {
  const page = { "[data-iid='make']": [el("hidden", { shown: false }), el("make")] };
  const target = page["[data-iid='make']"][1];
  assert.deepEqual(await fields.findVisibleOnce(fakeDriver(page, { element: target, index: 0 }), ["[data-iid='make']"]), {
    element: target,
    selector: "[data-iid='make']",
  });
  const old = await fields.findVisibleOnce(fakeDriver(page, () => { throw new Error("x"); }), ["[data-iid='make']"]);
  assert.equal(old.element, target);
});
