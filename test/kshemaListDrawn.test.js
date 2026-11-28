"use strict";

// KSHEMA dropdowns: a list is read only once it is drawn (2026-11-27, policy OP911217797660).
// KSHEMA's list panel fades in from opacity 0 and a see-through option reads "" - since the speed rounds the list was read
// mid-fade on the server and the run stopped with "the portal offered: nothing" although the list was full.
// A fake page + fake clock. No browser, no network, no database:
// node --require ./test/support/noRealWorld.js --test test/kshemaListDrawn.test.js
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

/** Runs fn with console.log captured; returns [result, lines]. */
const captured = async (fn) => {
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return [await fn(), lines];
  } finally {
    console.log = log;
  }
};

const PA_REASONS = [
  "Already have personal accident policy With 15L Sum Insured",
  "I already have a personal accident policy for my other vehicle.",
  "No Valid and Effective DL",
];

/**
 * A mat-select on a fake page. `blankReads` = how many text reads of the open list come back all blank (the panel is
 * still fading in); `Infinity` = never drawn; a function (n) => true marks exactly which reads (1, 2, ...) are blank. `rerender` = every look at the list after the first hands out NEW option
 * elements (Angular re-rendered it). `searchable` = the panel has a search box.
 */
function fakeSelect({ texts, value = "", blankReads = 0, rerender = false, searchable = false } = {}) {
  const page = {
    value,
    open: false,
    textReads: 0,
    collects: 0,
    closes: 0,
    clicked: [],
    generation: 0,
  };
  const makeOptions = () =>
    texts.map((text) => ({
      generation: page.generation,
      text,
      async click() {
        page.clicked.push(text);
        page.value = text;
        page.open = false;
      },
    }));
  let options = makeOptions();
  const isBlank = typeof blankReads === "function" ? blankReads : (n) => n <= blankReads;
  const select = {
    async click() {
      page.open = true;
    },
  };
  const searchBox = {
    async clear() {},
    async sendKeys() {},
  };
  const driver = {
    sleeps: [],
    async sleep(ms) {
      this.sleeps.push(ms);
      now += ms;
    },
    actions() {
      return {
        sendKeys() {
          return {
            async perform() {
              page.closes += 1;
              page.open = false;
            },
          };
        },
      };
    },
    async findElements() {
      return [];
    },
    async executeScript(script, ...args) {
      if (/scrollIntoView/.test(script)) return null;
      if (/var askPanel/.test(script)) {
        // collectOptions' one-call look
        page.collects += 1;
        if (!page.open) return { panelOpened: false, options: [] };
        if (rerender && page.collects > 1) {
          page.generation += 1;
          options = makeOptions();
        }
        return { panelOpened: true, options };
      }
      if (/return els\.map/.test(script)) {
        // pageReads.readTexts
        page.textReads += 1;
        const els = args[0];
        if (isBlank(page.textReads)) return els.map(() => "");
        return els.map((el) => (el.generation === page.generation ? el.text : "")); // a replaced element reads blank
      }
      if (/var requireVisible/.test(script)) {
        // pageReads.findFirstShown
        const selectors = args[0] || [];
        if (selectors.some((s) => /Search/i.test(String(s)))) return searchable && page.open ? { element: searchBox, index: 0 } : { element: null, index: -1 };
        return { element: select, index: 0 };
      }
      if (/var root = arguments\[0\]/.test(script)) return page.value; // readMatSelectValue
      if (/var optionSelectors = arguments\[0\]/.test(script)) {
        // waitForFilteredList: the shown texts
        return options.map((o) => o.text);
      }
      throw new Error(`unexpected script: ${script.slice(0, 80)}`);
    },
  };
  return { page, driver };
}

const DRAW_LOOK = 150;

test("a list still fading in (blank twice) is waited for and the right choice is picked", async () => {
  const { page, driver } = fakeSelect({ texts: PA_REASONS, blankReads: 2 });
  const [r, lines] = await captured(() =>
    fields.selectMatOption(driver, ["mat-select"], "No Valid and Effective DL", "Reason for unselecting PA Cover", { fuzzy: true, minScore: 70 })
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.value, "No Valid and Effective DL");
  assert.deepEqual(page.clicked, ["No Valid and Effective DL"]);
  assert.equal(page.textReads, 3, "blank, blank, drawn");
  assert.equal(driver.sleeps.filter((ms) => ms === DRAW_LOOK).length, 2, "one short look per blank read");
  assert.ok(lines.some((l) => /"Reason for unselecting PA Cover" list is open but its 3 choice\(s\) are not drawn yet/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /list drawn after 0\.3s/.test(l)), lines.join("\n"));
});

test("an exact (non-fuzzy) pick waits the same way - Product Type", async () => {
  const { page, driver } = fakeSelect({ texts: ["Two Wheeler-Bundled", "Two Wheeler-Long term Liability only"], blankReads: 1 });
  const [r] = await captured(() => fields.selectMatOption(driver, ["mat-select"], "Two Wheeler-Bundled", "Product Type"));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(page.clicked, ["Two Wheeler-Bundled"]);
});

test("a list readable at once is not waited for: one read, no extra look, nothing new logged", async () => {
  const { page, driver } = fakeSelect({ texts: PA_REASONS });
  const [r, lines] = await captured(() =>
    fields.selectMatOption(driver, ["mat-select"], "No Valid and Effective DL", "Reason for unselecting PA Cover", { fuzzy: true, minScore: 70 })
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(page.textReads, 1);
  assert.equal(page.collects, 1);
  assert.ok(!driver.sleeps.includes(DRAW_LOOK), `sleeps ${driver.sleeps}`);
  assert.ok(!lines.some((l) => /not drawn yet|list drawn after/.test(l)));
});

test("a list that never gets drawn fails after the wait with a sentence that says so (not 'offered nothing')", async () => {
  const { page, driver } = fakeSelect({ texts: PA_REASONS, blankReads: Infinity });
  const started = now;
  const [r] = await captured(() =>
    fields.selectMatOption(driver, ["mat-select"], "No Valid and Effective DL", "Reason for unselecting PA Cover", { fuzzy: true, minScore: 70 })
  );
  assert.equal(r.ok, false);
  assert.equal(r.listNotDrawn, true);
  assert.equal(
    r.reason,
    'the "Reason for unselecting PA Cover" list opened with 3 choices but their names could not be read in 5 seconds (the list was still being drawn) - run the policy again'
  );
  assert.doesNotMatch(r.reason, /offered/);
  assert.doesNotMatch(r.reason, /:/, "no colon in an operator sentence");
  assert.ok(now - started >= fields.LIST_DRAW_WAIT_MS, `waited ${now - started} ms`);
  assert.ok(now - started < fields.LIST_DRAW_WAIT_MS + 2000, `waited ${now - started} ms`);
  assert.deepEqual(page.clicked, []);
  assert.ok(page.closes >= 1, "the panel is closed so the rest of the form stays clickable");
});

test("a real no-match keeps today's message with what the portal offered", async () => {
  const { driver } = fakeSelect({ texts: ["Individual", "Corporate"] });
  const [r] = await captured(() => fields.selectMatOption(driver, ["mat-select"], "Partnership", "Customer Category"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, '"Partnership" was not one of the choices for "Customer Category" (the portal offered: Individual, Corporate)');
  assert.equal(r.listNotDrawn, undefined);
});

test("a list Angular re-renders while it fades in: the NEW options are read and clicked", async () => {
  const { page, driver } = fakeSelect({ texts: PA_REASONS, blankReads: 1, rerender: true });
  const [r] = await captured(() =>
    fields.selectMatOption(driver, ["mat-select"], "No Valid and Effective DL", "Reason for unselecting PA Cover", { fuzzy: true, minScore: 70 })
  );
  assert.equal(r.ok, true, r.reason);
  assert.ok(page.generation >= 1, "the list was re-rendered");
  assert.deepEqual(page.clicked, ["No Valid and Effective DL"]);
});

test("a search-box list (RTO, Make ...) read blank after the search is waited for too", async () => {
  // read 1 (before the search) is drawn; reads 2 and 3 (right after the search) are blank; read 4 is drawn
  const { page, driver } = fakeSelect({ texts: ["TN91-NEYVELI"], blankReads: (n) => n === 2 || n === 3, searchable: true });
  const [r, lines] = await captured(() =>
    fields.selectMatOption(driver, ["mat-select"], "TN91-NEYVELI", "RTO Location", { fuzzy: true, searchable: true, searchTerm: "TN91" })
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(page.textReads, 4);
  assert.deepEqual(page.clicked, ["TN91-NEYVELI"]);
  assert.ok(lines.some((l) => /"RTO Location" list is open but/.test(l)), lines.join("\n"));
});

test("a search-box list on an exact (non-fuzzy) pick, blank right after the search, is waited for", async () => {
  const { page, driver } = fakeSelect({ texts: ["HONDA"], blankReads: (n) => n === 2, searchable: true });
  const [r] = await captured(() => fields.selectMatOption(driver, ["mat-select"], "HONDA", "Make", { searchable: true }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(page.textReads, 3);
  assert.deepEqual(page.clicked, ["HONDA"]);
});

test("the Product Type switch-away (IDV recovery) waits for its list too", async () => {
  const { page, driver } = fakeSelect({ texts: ["Two Wheeler-Bundled", "Two Wheeler-Long term Liability only"], value: "Two Wheeler-Bundled", blankReads: 2 });
  const [r] = await captured(() => fields.selectOtherMatOption(driver, ["mat-select"], { avoid: "Two Wheeler-Bundled", label: "Product Type" }));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.chose, "Two Wheeler-Long term Liability only");
  assert.deepEqual(page.clicked, ["Two Wheeler-Long term Liability only"]);
});

test("the Product Type switch-away with a list that never gets drawn says so", async () => {
  const { page, driver } = fakeSelect({ texts: ["Two Wheeler-Bundled", "Two Wheeler-Long term Liability only"], value: "Two Wheeler-Bundled", blankReads: Infinity });
  const [r] = await captured(() => fields.selectOtherMatOption(driver, ["mat-select"], { avoid: "Two Wheeler-Bundled", label: "Product Type" }));
  assert.equal(r.ok, false);
  assert.equal(r.listNotDrawn, true);
  assert.match(r.reason, /^the "Product Type" list opened with 2 choices but their names could not be read in 5 seconds/);
  assert.deepEqual(page.clicked, []);
  assert.ok(page.closes >= 1);
});

test("readDrawnOptions on its own: an empty list costs nothing, a readable one is returned as it is", async () => {
  const { driver } = fakeSelect({ texts: PA_REASONS });
  assert.deepEqual(await fields.readDrawnOptions(driver, [], "X"), { options: [], texts: [], waitedMs: 0 });
  assert.deepEqual(driver.sleeps, []);
});
