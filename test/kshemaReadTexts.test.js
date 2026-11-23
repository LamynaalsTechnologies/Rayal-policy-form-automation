"use strict";

// kshemaFields.readTextsAtOnce: a dropdown's option texts in ONE browser call, with the old one-call-per-option
// read as the fallback. No browser, no network, no database:
// node --require ./test/support/noRealWorld.js --test test/kshemaReadTexts.test.js
// (Checked in a real headless Chrome on a 301-option replica on 2026-11-23: identical texts, 1,368 ms -> 41 ms.)
const test = require("node:test");
const assert = require("node:assert/strict");

const { readTextsAtOnce } = require("../fullPolicycompany/kshema/kshemaFields");

const option = (text, { fails = false } = {}) => ({
  calls: 0,
  async getText() {
    this.calls += 1;
    if (fails) throw new Error("stale element reference");
    return text;
  },
});

test("the whole list comes back from one script call, trimmed, in the same order", async () => {
  const els = [option(" A "), option("B"), option("")];
  const scripts = [];
  const driver = {
    async executeScript(script, list) {
      scripts.push(script);
      assert.equal(list, els, "the elements themselves are handed to the page");
      return ["  HONDA  ", "TVS", null];
    },
  };
  assert.deepEqual(await readTextsAtOnce(driver, els), ["HONDA", "TVS", ""]);
  assert.equal(scripts.length, 1, "one browser call");
  assert.ok(els.every((el) => el.calls === 0), "no per-option calls");
  assert.match(scripts[0], /innerText/);
  assert.match(scripts[0], /\\u00a0/, "a non-breaking space reads as a space, like getText");
  assert.match(scripts[0], /opacity/, "an option under a see-through parent reads as not shown, like getText");
});

test("when the script fails, every option is read one by one - exactly the old way", async () => {
  const els = [option("HONDA"), option("x", { fails: true }), option(" TVS ")];
  const driver = {
    async executeScript() {
      throw new Error("stale element reference: element is not attached to the page document");
    },
  };
  assert.deepEqual(await readTextsAtOnce(driver, els), ["HONDA", "", "TVS"]);
  assert.deepEqual(els.map((el) => el.calls), [1, 1, 1]);
});

test("an answer of the wrong length is not trusted: the old way decides", async () => {
  const els = [option("HONDA"), option("TVS")];
  const driver = { executeScript: async () => ["HONDA"] };
  assert.deepEqual(await readTextsAtOnce(driver, els), ["HONDA", "TVS"]);
  assert.deepEqual(els.map((el) => el.calls), [1, 1]);
});

test("a driver without executeScript (a test double) uses the old way; an empty list costs nothing", async () => {
  const els = [option("BAJAJ")];
  assert.deepEqual(await readTextsAtOnce({}, els), ["BAJAJ"]);
  let called = false;
  assert.deepEqual(await readTextsAtOnce({ executeScript: async () => { called = true; } }, []), []);
  assert.equal(called, false);
});
