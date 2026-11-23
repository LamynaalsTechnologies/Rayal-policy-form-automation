"use strict";

// KSHEMA field pace (speed round 3): the same checks decide, only sooner when the page is already right.
// A fake clock (Date.now + driver.sleep) makes every time exact. No browser, no network, no database:
// node --require ./test/support/noRealWorld.js --test test/kshemaFieldPace.test.js
// (Checked side by side with the deployed helpers in real headless Chrome on 2026-11-23: identical results.)
const test = require("node:test");
const assert = require("node:assert/strict");

const fields = require("../fullPolicycompany/kshema/kshemaFields");

let now = 0;
const realNow = Date.now;
test.beforeEach(() => {
  now = 1000;
  Date.now = () => now;
});
test.afterEach(() => {
  Date.now = realNow;
});

const quietly = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

/** A box whose value reads come from a list (the last one repeats); a read can throw (stale). */
function box(reads) {
  const seen = [];
  return {
    seen,
    async isDisplayed() {
      return true;
    },
    async click() {},
    async clear() {},
    async sendKeys() {},
    async getAttribute(name) {
      assert.equal(name, "value");
      const next = reads.length > 1 ? reads.shift() : reads[0];
      seen.push(now);
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/** A driver with a fake clock; findVisible finds `el` in one call. */
function driverFor(el, extra = {}) {
  return {
    sleeps: [],
    async sleep(ms) {
      this.sleeps.push(ms);
      now += ms;
    },
    async executeScript(script) {
      if (/scrollIntoView/.test(script)) return null;
      if (extra.executeScript) return extra.executeScript.apply(this, arguments);
      return { element: el, index: 0 }; // findFirstShown
    },
    async findElements() {
      return [el];
    },
  };
}

test("typing: a value that is there at once and still there 100 ms later is done - 250 ms sooner than before", async () => {
  const el = box(["E123"]);
  const d = driverFor(el);
  const r = await quietly(() => fields.typeIntoField(d, ["input"], "E123", "Engine"));
  assert.equal(r.ok, true);
  assert.deepEqual(d.sleeps, [100], "one confirm pause, no 250 ms pause");
  assert.equal(el.seen.length, 2, "read, then read again");
});

test("typing: a value that changes after the first read takes the old path (250 ms, read, decide)", async () => {
  const el = box(["E123", "", "E123"]);
  const d = driverFor(el);
  const r = await quietly(() => fields.typeIntoField(d, ["input"], "E123", "Engine"));
  assert.equal(r.ok, true);
  assert.deepEqual(d.sleeps, [100, 250]);
});

test("typing: a box replaced right after typing (stale read) is typed again, as before", async () => {
  const stale = Object.assign(new Error("stale element reference: element is not attached"), { name: "StaleElementReferenceError" });
  const el = box(["E123", stale, "E123"]);
  const d = driverFor(el);
  const r = await quietly(() => fields.typeIntoField(d, ["input"], "E123", "Engine"));
  assert.equal(r.ok, true);
  assert.ok(d.sleeps.includes(600), "the retry pause between tries, as before");
});

test("typing: a value that never lands fails after three tries with the same reason as before", async () => {
  const el = box([""]);
  const d = driverFor(el);
  const r = await quietly(() => fields.typeIntoField(d, ["input"], "E123", "Engine"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not keep what was typed after three tries/);
});

test("option read-back: two readings in a row that show the choice end it early", async () => {
  const reads = ["", "HONDA", "HONDA"];
  const select = {};
  const d = driverFor(select, {
    executeScript(script) {
      if (/var root = arguments\[0\]/.test(script)) return reads.length > 1 ? reads.shift() : reads[0]; // readMatSelectValue
      return { element: select, index: 0 };
    },
  });
  const after = await fields._readBackChoice(d, ["mat-select"], select, "honda");
  assert.equal(after, "HONDA");
  assert.equal(now - 1000, 300, "3 readings 100 ms apart - not the fixed 400 ms first");
});

test("option read-back: no match is decided at 400 ms on the last reading, exactly as before", async () => {
  const select = {};
  const d = driverFor(select, {
    executeScript(script) {
      if (/var root = arguments\[0\]/.test(script)) return "Make";
      return { element: select, index: 0 };
    },
  });
  const after = await fields._readBackChoice(d, ["mat-select"], select, "honda");
  assert.equal(after, "Make");
  assert.equal(now - 1000, 400);
});

test("option read-back: a value that keeps flipping is never read past 1 s", async () => {
  let flip = false;
  const select = {};
  const d = driverFor(select, {
    executeScript(script) {
      if (/var root = arguments\[0\]/.test(script)) return (flip = !flip) ? "HONDA" : "";
      return { element: select, index: 0 };
    },
  });
  await fields._readBackChoice(d, ["mat-select"], select, "honda");
  assert.ok(now - 1000 <= 1100);
});

test("search box: stops as soon as every option on show contains the term; else the full 800 ms", async () => {
  const filtered = driverFor({}, { executeScript: () => ["HONDA", "HONDA MOTORCYCLE"] });
  assert.equal(await fields._waitForFilteredList(filtered, "honda", 800), true);
  assert.equal(now - 1000, 100);

  now = 1000;
  const unfiltered = driverFor({}, { executeScript: () => ["HERO", "HONDA", "TVS"] });
  assert.equal(await fields._waitForFilteredList(unfiltered, "honda", 800), false);
  assert.equal(now - 1000, 800, "the old full pause");

  now = 1000;
  const empty = driverFor({}, { executeScript: () => ["HONDA"] });
  assert.equal(await fields._waitForFilteredList(empty, "", 800), false, "an empty term never stops early");
  assert.equal(now - 1000, 800);

  now = 1000;
  const unreadable = driverFor({}, { executeScript: () => { throw new Error("x"); } });
  assert.equal(await fields._waitForFilteredList(unreadable, "honda", 800), false);
  assert.equal(now - 1000, 800);
});

test("collectOptions and readMatSelectValue: one call when it can, the old way when it cannot", async () => {
  const opt = { async isDisplayed() { return true; }, async getText() { return "HONDA"; } };
  const viaPage = driverFor({}, { executeScript: () => ({ panelOpened: true, options: [opt] }) });
  assert.deepEqual(await fields.collectOptions(viaPage, 1000), { options: [opt], panelOpened: true });

  const old = {
    async sleep(ms) { now += ms; },
    async executeScript() { throw new Error("x"); },
    async findElements(locator) {
      return String(locator.value).includes("mat-option") ? [opt] : [opt];
    },
  };
  const res = await fields.collectOptions(old, 1000);
  assert.equal(res.options.length, 1);
  assert.equal(res.panelOpened, true);

  const span = { async getText() { return " Liability "; } };
  const select = { async findElements() { return [span]; } };
  assert.equal(await fields.readMatSelectValue({ executeScript: async () => " Liability " }, select), "Liability");
  assert.equal(await fields.readMatSelectValue({ executeScript: async () => { throw new Error("x"); } }, select), "Liability");
  assert.equal(await fields.readMatSelectValue({}, select), "Liability");
});
