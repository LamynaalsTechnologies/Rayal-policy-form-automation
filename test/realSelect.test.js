// Run with: node --require ./test/support/noRealWorld.js --test test/realSelect.test.js
//
// Reliance's Title box used to be set by a script (select.value = ..., one made-up change event). The owner (2026-10-16):
// "it selects the field but not fully assigned, like artificial - I want to select that dropdown realistic". Now it is
// chosen like a person: pointer over the box, a click that opens the list, a click on the option, a read-back; the old
// script is the last resort and the way back (RELIANCE_REALISTIC_SELECT_ENABLED). None of these tests needs a browser,
// the network or a database: a fake <select> stands in for the page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const real = require(path.join(ROOT, "lib", "realSelect.js"));
const { selectProposerTitle, PROPOSER_TITLES } = require(path.join(ROOT, "lib", "proposerTitle.js"));

const TITLE_OPTIONS = [
  { value: "", text: "Title" },
  { value: "Mr.", text: "Mr." },
  { value: "Ms.", text: "Ms." },
  { value: "Mrs.", text: "Mrs." },
  { value: "M/S", text: "M/S" },
];

/** Run fn with an env var set (undefined = unset), restoring it after. */
async function withEnv(vars, fn) {
  const before = {};
  for (const key of Object.keys(vars)) {
    before[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

/**
 * A fake page with one native <select id="proposerTitle1">. `events` is everything done to it, in order.
 * Behaviours: optionClickThrows, optionClickIgnored, selectClickThrows, hoverThrows, scriptIgnored, listNeeded
 * (an option click only counts after the select was clicked open, like a real list).
 */
function fakePage({ options = TITLE_OPTIONS, selectedIndex = 0, disabled = [], ...behaviour } = {}) {
  const state = { selectedIndex, opened: false };
  const events = [];
  const pauses = [];
  const opts = options.map((o, i) => ({ ...o, disabled: disabled.includes(i) }));

  const optionEls = opts.map((o, i) => ({
    async click() {
      events.push(`click:option:${o.text}`);
      if (behaviour.optionClickThrows) throw new Error("element not interactable: the option is not clickable\n  (Session info: chrome=150)");
      if (behaviour.optionClickIgnored) return;
      if (behaviour.listNeeded && !state.opened) return;
      state.selectedIndex = i;
      state.opened = false;
    },
  }));
  const selectEl = {
    async isDisplayed() { return true; },
    async isEnabled() { return true; },
    async click() {
      events.push("click:select");
      if (behaviour.selectClickThrows) throw new Error("element click intercepted");
      state.opened = true;
    },
    async findElements() { return optionEls; },
  };

  /** The page as the in-page functions see it. */
  const pageSelect = {
    get options() { return opts.map((o) => ({ value: o.value, text: o.text, disabled: o.disabled })); },
    get selectedIndex() { return state.selectedIndex; },
    get value() { return state.selectedIndex >= 0 ? opts[state.selectedIndex].value : ""; },
    set value(v) {
      events.push(`script:value:${v}`);
      if (behaviour.scriptIgnored) return;
      const at = opts.findIndex((o) => o.value === v);
      if (at >= 0) state.selectedIndex = at;
    },
    dispatchEvent() { events.push("script:change"); },
  };

  const driver = {
    state,
    events,
    pauses,
    async sleep(ms) { pauses.push(ms); },
    async findElements(locator) {
      return String(locator.value).includes('"proposerTitle1"') ? [selectEl] : [];
    },
    async executeScript(fn, ...args) {
      if (typeof fn === "string") {
        if (fn.includes("scrollIntoView")) events.push("scroll");
        if (fn.includes(".blur()")) {
          if (behaviour.blurThrows) throw new Error("stale element reference");
          events.push("blur");
        }
        return undefined;
      }
      const saved = globalThis.document;
      globalThis.document = { getElementById: (id) => (id === "proposerTitle1" ? pageSelect : null) };
      try {
        return fn(...args);
      } finally {
        if (saved === undefined) delete globalThis.document;
        else globalThis.document = saved;
      }
    },
    actions() {
      return {
        move() {
          return {
            async perform() {
              if (behaviour.hoverThrows) throw new Error("move target out of bounds");
              events.push("hover");
            },
          };
        },
      };
    },
  };
  return driver;
}

const pick = (driver, wanted, extra = {}) =>
  real.selectLikeUser(driver, "proposerTitle1", wanted, { label: "Title", random: () => 0, pause: async (ms) => driver.pauses.push(ms), ...extra });

/* ----------------------------- the pick itself ----------------------------- */

test("a real pick - scroll to it, pointer over it, click it open, click the option, let go of the box - then it is read back", async () => {
  const page = fakePage({ listNeeded: true });
  const done = await pick(page, "Mrs.");
  assert.deepEqual(page.events, ["scroll", "hover", "click:select", "click:option:Mrs.", "blur"]);
  assert.equal(page.state.selectedIndex, 3);
  assert.deepEqual(done, { index: 3, value: "Mrs.", text: "Mrs.", how: "list" });
  assert.ok(!page.events.some((e) => e.startsWith("script:")), "no script was needed");
});

test("each of the four titles is picked from the list", async () => {
  for (const title of PROPOSER_TITLES) {
    const page = fakePage({ listNeeded: true });
    const done = await pick(page, title);
    assert.equal(done.how, "list", title);
    assert.equal(done.value, title);
    assert.deepEqual(page.events.slice(-2), [`click:option:${title}`, "blur"]);
  }
});

test("when the exact text is not there, case, spaces and dots do not matter", async () => {
  for (const [raw, expected] of [["mrs", "Mrs."], [" MS ", "Ms."], ["m/s", "M/S"], ["Mr", "Mr."]]) {
    const page = fakePage({ listNeeded: true });
    assert.equal((await pick(page, raw)).value, expected, raw);
  }
});

test("the exact value or text wins over a loose match (Mr. is not Mrs.)", () => {
  const options = TITLE_OPTIONS.map((o) => ({ ...o, disabled: false }));
  assert.equal(real.findOptionIndex(options, "Mr."), 1);
  assert.equal(real.findOptionIndex(options, "Mrs."), 3);
  assert.equal(real.findOptionIndex(options, "Dr."), -1);
});

test("already on the wanted option: nothing is touched", async () => {
  const page = fakePage({ selectedIndex: 2 });
  const lines = [];
  const done = await pick(page, "Ms.", { log: (l) => lines.push(l) });
  assert.equal(done.how, "already");
  assert.deepEqual(page.events, []);
  assert.deepEqual(page.pauses, []);
  assert.match(lines[0], /^Title already shows Ms\./);
});

test("an option the box does not offer is an error that lists what it offers, and nothing is clicked", async () => {
  const page = fakePage();
  await assert.rejects(
    () => pick(page, "Dr."),
    (e) => {
      assert.match(e.message, /^Reliance's Title box does not offer "Dr\." - it offers Mr\., Ms\., Mrs\., M\/S\. Nothing was submitted\.$/);
      assert.equal(e.message.includes(":"), false);
      return true;
    }
  );
  assert.deepEqual(page.events, []);
});

test("the placeholder and a disabled option are never chosen", async () => {
  for (const wanted of ["", "Title", "  "]) {
    await assert.rejects(() => pick(fakePage(), wanted), /does not offer/, JSON.stringify(wanted));
  }
  const page = fakePage({ disabled: [2] }); // "Ms." is greyed out
  await assert.rejects(() => pick(page, "Ms."), /does not offer "Ms\." - it offers Mr\., Mrs\., M\/S\./);
  assert.deepEqual(page.events, []);
});

test("a box that never appears is an error (no colon), not a hang", async () => {
  const page = fakePage();
  page.findElements = async () => [];
  await assert.rejects(
    () => pick(page, "Mr.", { timeoutMs: 5 }),
    (e) => {
      assert.match(e.message, /^Reliance's Title box \(proposerTitle1\) did not appear on the page\. Nothing was submitted\.$/);
      return true;
    }
  );
});

/* ----------------------------- when the list cannot be used ----------------------------- */

test("a refused option click falls back to the old script, with warnings, and still ends on the wanted option", async () => {
  const page = fakePage({ optionClickThrows: true });
  const lines = [];
  const done = await pick(page, "Mrs.", { log: (l) => lines.push(l) });
  assert.equal(done.how, "script");
  assert.equal(page.state.selectedIndex, 3);
  assert.deepEqual(page.events.slice(-3), ["script:value:Mrs.", "script:change", "blur"]);
  assert.ok(lines.some((l) => /the list could not be used \(element not interactable - the option is not clickable\)/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /choosing it with a script instead/.test(l)));
});

test("a click the page ignores (nothing selected) is caught by the read-back and the script takes over", async () => {
  const page = fakePage({ optionClickIgnored: true });
  const lines = [];
  const done = await pick(page, "Ms.", { log: (l) => lines.push(l) });
  assert.equal(done.how, "script");
  assert.equal(page.state.selectedIndex, 2);
  assert.ok(lines.some((l) => /the page did not end up on Ms\. after the click/.test(l)));
});

test("a refused click on the box itself falls back the same way", async () => {
  const page = fakePage({ selectClickThrows: true });
  const done = await pick(page, "M/S");
  assert.equal(done.how, "script");
  assert.equal(page.state.selectedIndex, 4);
});

test("if even the script does not take, the error says what the box reads and nothing is carried on (no colon)", async () => {
  const page = fakePage({ optionClickIgnored: true, scriptIgnored: true });
  await assert.rejects(
    () => pick(page, "Mrs."),
    (e) => {
      assert.match(e.message, /^Reliance did not take the Title "Mrs\." - its Title box reads "Title"\. Nothing was submitted\.$/);
      assert.equal(e.message.includes(":"), false);
      return true;
    }
  );
});

test("a pointer move that fails does not matter - the click still happens", async () => {
  const page = fakePage({ hoverThrows: true, listNeeded: true });
  const done = await pick(page, "Mr.");
  assert.equal(done.how, "list");
  assert.deepEqual(page.events, ["scroll", "click:select", "click:option:Mr.", "blur"]);
});

test("letting go of the box is only for looks: if it fails the pick still succeeds", async () => {
  const page = fakePage({ listNeeded: true, blurThrows: true });
  const done = await pick(page, "Ms.");
  assert.equal(done.how, "list");
  assert.equal(page.state.selectedIndex, 2);
});

/* ----------------------------- timing ----------------------------- */

test("the pauses are hand-sized: a look, a pause before the click, the list opening, the choice, then the page settling", async () => {
  const slow = fakePage({ listNeeded: true });
  await pick(slow, "Mr.", { random: () => 0 });
  assert.deepEqual(slow.pauses, [250, 150, 300, 300, 1200]);

  const fast = fakePage({ listNeeded: true });
  await pick(fast, "Mr.", { random: () => 0.9999 });
  assert.deepEqual(fast.pauses, [450, 300, 500, 500, 1700]);
});

test("the caller's own settle replaces the default pause at the end", async () => {
  const page = fakePage({ listNeeded: true });
  let settled = 0;
  await pick(page, "Mr.", { settle: async () => { settled++; } });
  assert.equal(settled, 1);
  assert.equal(page.pauses.length, 4, "no default settling pause when the caller settles");
});

/* ----------------------------- the switch, and the Title using it ----------------------------- */

test("the switch is ON unless false / 0 / no / off", async () => {
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: undefined }, async () => assert.equal(real.isRealisticSelectEnabled(), true));
  for (const off of ["false", "0", "no", "OFF", " False "]) {
    await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: off }, async () => assert.equal(real.isRealisticSelectEnabled(), false, off));
  }
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: "true" }, async () => assert.equal(real.isRealisticSelectEnabled(), true));
});

test("the proposer Title is chosen by the real pick (the scripted setter is not called), then read back", async () => {
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: undefined }, async () => {
    const page = fakePage({ listNeeded: true });
    const lines = [];
    let scriptedCalls = 0;
    const chosen = await selectProposerTitle(page, "mrs", {
      select: async () => { scriptedCalls++; },
      log: (l) => lines.push(l),
      picker: (driver, id, wanted, o) => real.selectLikeUser(driver, id, wanted, { ...o, random: () => 0, pause: async () => {} }),
    });
    assert.equal(chosen, "Mrs.");
    assert.equal(scriptedCalls, 0);
    assert.deepEqual(page.events.filter((e) => e.startsWith("click:")), ["click:select", "click:option:Mrs."]);
    assert.ok(lines.includes("✅ Title set to Mrs. (picked from the open list)"), lines.join(" | "));
  });
});

test("the father's title box uses the same pick, with its own id and label", async () => {
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: undefined }, async () => {
    const seen = [];
    await assert.rejects(
      () => selectProposerTitle(fakePage(), "Mr.", {
        selectId: "proposerTitle2",
        label: "Father's title",
        picker: async (driver, id, wanted, o) => { seen.push([id, wanted, o.label]); return { how: "list" }; },
      }),
      /Reliance did not take the Father's title "Mr\." - its Father's title box reads ""/,
    );
    assert.deepEqual(seen, [["proposerTitle2", "Mr.", "Father's title"]]);
  });
});

test("a title the page did not keep after the pick is still caught by the read-back", async () => {
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: undefined }, async () => {
    const page = fakePage(); // the box stays on "Title"
    await assert.rejects(
      () => selectProposerTitle(page, "Ms.", { picker: async () => ({ how: "list" }) }),
      (e) => {
        assert.match(e.message, /^Reliance did not take the Title "Ms\." - its Title box reads ""\. /);
        assert.match(e.message, /Nothing was submitted\.$/);
        return true;
      }
    );
  });
});

test("a fallback to the script is visible in the log line", async () => {
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: undefined }, async () => {
    const page = fakePage({ optionClickThrows: true });
    const lines = [];
    await selectProposerTitle(page, "Ms.", {
      log: (l) => lines.push(l),
      picker: (driver, id, wanted, o) => real.selectLikeUser(driver, id, wanted, { ...o, random: () => 0, pause: async () => {} }),
    });
    assert.ok(lines.includes("✅ Title set to Ms. (by script - the list could not be used)"), lines.join(" | "));
  });
});

test("switch off - the old scripted setter is used and the real pick is never started", async () => {
  await withEnv({ RELIANCE_REALISTIC_SELECT_ENABLED: "false" }, async () => {
    const page = fakePage();
    const calls = [];
    const chosen = await selectProposerTitle(page, "Ms.", {
      select: async (driver, id, value) => { calls.push([id, value]); await driver.executeScript((i, v) => { const s = document.getElementById(i); s.value = v; }, id, value); },
      picker: async () => { throw new Error("the real pick must not run with the switch off"); },
    });
    assert.equal(chosen, "Ms.");
    assert.deepEqual(calls, [["proposerTitle1", "Ms."]]);
    assert.deepEqual(page.events, ["script:value:Ms."]);
  });
});

test("wiring: the Title helper goes through lib/realSelect.js, and relianceForm.js still hands it safeSelectDropdown as the way back", () => {
  const helper = fs.readFileSync(path.join(ROOT, "lib", "proposerTitle.js"), "utf8");
  assert.match(helper, /require\("\.\/realSelect"\)/);
  assert.match(helper, /isRealisticSelectEnabled\(\)/);
  for (const file of [
    path.join(ROOT, "fullPolicycompany", "relianceForm.js"),
    path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"),
  ]) {
    assert.match(fs.readFileSync(file, "utf8"), /await selectProposerTitle\(driver, data\.proposerTitle, \{\s*select: safeSelectDropdown,/, path.basename(file));
  }
});
