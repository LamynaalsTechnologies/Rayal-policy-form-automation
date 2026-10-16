// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaSaveVerify.test.js
//
// 2026-10-16: a KSHEMA TP-only run showed the toast "System Error More than one rate found for rate" after Save and Continue
// and the automation did not see it. The portal was still on the QUOTE step; "Save and Finalize" is a permanent button on
// the Quote page, and the TP copy took "that button is visible" as "the next page opened", so submitQuoteForm said OK on its
// first poll and the run went on to answer the Add-ons page (a click on the wrong Yes/No question). None of these tests
// needs a browser, the network or a database:
//   1. the step bar reader, and the "page moved" test that now uses it (with the 2026-10-16 page as the regression);
//   2. the late refusal watch, the Add-ons page guard and the operator sentences (no colon);
//   3. the REAL submitQuoteForm of the TP copy against a fake driver that behaves like that run;
//   4. the wiring, and the full-company flow staying untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const saveVerify = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSaveVerify.js"));
const TP_QUOTE = path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js");
const FULL_QUOTE = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js");
const FULL_FORM = path.join(ROOT, "fullPolicycompany", "kshemaForm.js");

/** Run fn with the (very chatty) flow logging switched off; the lines are returned too. */
async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = console.error = console.warn = (...args) => lines.push(args.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

/** Run fn with some env vars set (undefined = unset), restoring them after. */
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

/** A clock the test moves by hand: Date.now() is replaced, and a driver's sleep() advances it. */
async function withVirtualClock(fn) {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    return await fn({ advance: (ms) => { now += ms; }, time: () => now });
  } finally {
    Date.now = realNow;
  }
}

/* ----------------------------- 1. the step bar and "moved" ----------------------------- */

/** document.querySelector for the in-page reader: the active step element (or nothing). */
async function withDocument(activeText, fn) {
  const saved = globalThis.document;
  globalThis.document = {
    querySelector: (selector) => {
      assert.equal(selector, ".stepper-item-text.stepper-active", "the selector seen on the live portal");
      return activeText === undefined ? null : { textContent: activeText };
    },
  };
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
}

test("the in-page reader returns the active step's text, trimmed (the live markup is 'Quote ' plus an empty marker div)", async () => {
  await withDocument("Quote ", () => assert.equal(saveVerify.readActiveStepInPage(), "Quote"));
  await withDocument("  Addon \n  ", () => assert.equal(saveVerify.readActiveStepInPage(), "Addon"));
  await withDocument("   ", () => assert.equal(saveVerify.readActiveStepInPage(), null));
  await withDocument(undefined, () => assert.equal(saveVerify.readActiveStepInPage(), null), "no step bar on the page");
});

test("readActiveStep: the script's answer, or null when it throws or answers with something that is not text", async () => {
  assert.equal(await saveVerify.readActiveStep({ executeScript: async () => " Summary " }), "Summary");
  assert.equal(await saveVerify.readActiveStep({ executeScript: async () => null }), null);
  assert.equal(await saveVerify.readActiveStep({ executeScript: async () => 5 }), null);
  assert.equal(await saveVerify.readActiveStep({ executeScript: async () => { throw new Error("target closed"); } }), null);
});

test("step names: Quote and Addon are told apart however the portal spells them", () => {
  assert.equal(saveVerify.isQuoteStep("Quote"), true);
  assert.equal(saveVerify.isQuoteStep(" quote "), true);
  assert.equal(saveVerify.isQuoteStep("Quotes"), false);
  assert.equal(saveVerify.isQuoteStep(null), false);
  for (const spelling of ["Addon", "Add-on", "Add-ons", "Addons", "add on"]) assert.equal(saveVerify.isAddonStep(spelling), true, spelling);
  assert.equal(saveVerify.isAddonStep("Summary"), false);
});

/** The 2026-10-16 Quote page: the step bar says Quote, and the "Save and Finalize" button is on the page. */
const quotePageDriver = (step = "Quote") => ({
  async executeScript() { return step; },
  async findElements() { return [{ isDisplayed: async () => true }]; }, // "Save and Finalize" is there, visible
});

test("REGRESSION: on the Quote step with 'Save and Finalize' visible the page has NOT moved (it used to be read as moved)", async () => {
  const driver = quotePageDriver("Quote");
  assert.equal(await saveVerify.legacyNextPageShown(driver), true, "the old test said 'moved' - this is the bug");
  assert.equal(await saveVerify.nextPageShown(driver), false, "the step bar says Quote - not moved");
});

test("nextPageShown: Addon and Summary are moved; the old test is not even asked", async () => {
  for (const step of ["Addon", "Summary", "Customer Details"]) {
    const driver = {
      async executeScript() { return step; },
      async findElements() { throw new Error("the old test must not be used when the step bar is readable"); },
    };
    assert.equal(await saveVerify.nextPageShown(driver), true, step);
  }
});

test("nextPageShown: a step bar that cannot be read falls back to the old test, with ONE warning per browser", async () => {
  const driver = { async executeScript() { throw new Error("no page"); }, async findElements() { return [{ isDisplayed: async () => true }]; } };
  const { value, lines } = await quiet(async () => [
    await saveVerify.nextPageShown(driver),
    await saveVerify.nextPageShown(driver),
    await saveVerify.nextPageShown(driver),
  ]);
  assert.deepEqual(value, [true, true, true], "no new way to fail: the old answer");
  assert.equal(lines.filter((l) => /Could not read KSHEMA's step bar/.test(l)).length, 1);
  const hidden = { async executeScript() { return null; }, async findElements() { return []; } };
  assert.equal((await quiet(() => saveVerify.nextPageShown(hidden))).value, false);
});

test("nextPageShown: with the switch off the old test decides, even if the step bar says Quote", async () => {
  await withEnv({ KSHEMA_SAVE_VERIFY_ENABLED: "false" }, async () => {
    assert.equal(await saveVerify.nextPageShown(quotePageDriver("Quote")), true);
  });
});

/* ----------------------------- 2. late refusal, Add-ons guard, sentences ----------------------------- */

const toastOf = (text, isError = true) => ({ text, isError });

test("lateRefusal: an error that arrives a second after the page changed is a refusal in KSHEMA's own words", async () => {
  await withVirtualClock(async (clock) => {
    const since = clock.time();
    const r = await saveVerify.lateRefusal({}, {
      readToast: async () => (clock.time() - since >= 1000 ? toastOf("System Error More than one rate found for rate") : null),
      readStep: async () => "Addon",
      sleep: async (ms) => clock.advance(ms),
      settleMs: 3000,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /^KSHEMA opened the next step and then showed an error - its message was "System Error More than one rate found for rate"\./);
    assert.equal(r.toast, "System Error More than one rate found for rate");
    assert.equal(r.error.includes(":"), false, "no colon (beautifyError)");
  });
});

test("lateRefusal: the quote sent back to the Quote step is a refusal even without a message", async () => {
  await withVirtualClock(async (clock) => {
    const since = clock.time();
    const r = await saveVerify.lateRefusal({}, {
      readToast: async () => null,
      readStep: async () => (clock.time() - since >= 1500 ? "Quote" : "Addon"),
      sleep: async (ms) => clock.advance(ms),
      settleMs: 3000,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /went back to the Quote step/);
    assert.equal(r.error.includes(":"), false);
  });
});

test("lateRefusal: a quiet window is null (the page may go on) and the portal's own add-ons message is not a refusal", async () => {
  await withVirtualClock(async (clock) => {
    let looks = 0;
    const { value, lines } = await quiet(() =>
      saveVerify.lateRefusal({}, {
        readToast: async () => { looks++; return toastOf("Please answer the add-ons questions"); }, // error words in it, but it is the add-ons page talking
        readStep: async () => "Addon",
        sleep: async (ms) => clock.advance(ms),
        settleMs: 3000,
      })
    );
    assert.equal(value, null);
    assert.ok(looks >= 6, `it kept looking for the whole window (${looks} looks)`);
    assert.ok(lines.some((l) => /KSHEMA is on the "Addon" step and showed no error for 3 s/.test(l)));
  });
});

test("lateRefusal: a toast reader that throws is 'nothing to see'; the switch off does not even look", async () => {
  await withVirtualClock(async (clock) => {
    const r = await quiet(() =>
      saveVerify.lateRefusal({}, { readToast: async () => { throw new Error("stale"); }, readStep: async () => "Addon", sleep: async (ms) => clock.advance(ms), settleMs: 1000 })
    );
    assert.equal(r.value, null);
    await withEnv({ KSHEMA_SAVE_VERIFY_ENABLED: "off" }, async () => {
      const never = async () => { throw new Error("must not look"); };
      assert.equal(await saveVerify.lateRefusal({}, { readToast: never, readStep: never }), null);
    });
  });
});

test("settle window: default 3000 ms, kept within 1000-15000, junk means the default", async () => {
  await withEnv({ KSHEMA_SAVE_SETTLE_MS: undefined }, async () => assert.equal(saveVerify.settleWindowMs(), 3000));
  await withEnv({ KSHEMA_SAVE_SETTLE_MS: "50" }, async () => assert.equal(saveVerify.settleWindowMs(), 1000));
  await withEnv({ KSHEMA_SAVE_SETTLE_MS: "999999" }, async () => assert.equal(saveVerify.settleWindowMs(), 15000));
  await withEnv({ KSHEMA_SAVE_SETTLE_MS: "6000" }, async () => assert.equal(saveVerify.settleWindowMs(), 6000));
  await withEnv({ KSHEMA_SAVE_SETTLE_MS: "soon" }, async () => assert.equal(saveVerify.settleWindowMs(), 3000));
});

test("addonsPageVerdict: answer the page only when the Addon step is open", async () => {
  const at = (step) => saveVerify.addonsPageVerdict({}, { readStep: async () => step });

  const onQuote = await at("Quote");
  assert.equal(onQuote.run, false);
  assert.match(onQuote.error, /^The Add-ons page is not open - KSHEMA's step bar still shows Quote/);
  assert.match(onQuote.error, /Nothing was answered\.$/);
  assert.equal(onQuote.error.includes(":"), false);

  assert.deepEqual(await at("Addon"), { run: true });
  assert.deepEqual(await at("Add-ons"), { run: true });
  assert.deepEqual(await at(null), { run: true }, "an unreadable step bar: as before");

  const onSummary = await at("Summary");
  assert.equal(onSummary.run, false);
  assert.equal(onSummary.error, undefined);
  assert.match(onSummary.skip, /KSHEMA is on the "Summary" step, not the Addon step - there is no add-ons question to answer/);

  await withEnv({ KSHEMA_SAVE_VERIFY_ENABLED: "0" }, async () => assert.deepEqual(await at("Quote"), { run: true }));
});

test("the operator sentences quote KSHEMA's words, have no colon, and the switch off keeps the old wording", async () => {
  const said = "System Error: More than one rate found for rate"; // a colon of KSHEMA's own must not survive
  const refusal = saveVerify.refusalMessage(said);
  assert.match(refusal, /^KSHEMA refused Save and Continue - its message was "System Error - More than one rate found for rate"\./);
  assert.equal(refusal.includes(":"), false);
  assert.equal(saveVerify.lateRefusalMessage(said).includes(":"), false);

  const silent = saveVerify.silentMessage("OLD SENTENCE", "");
  assert.equal(silent, "Save and Continue did not open the next page within 15 seconds. No error message appeared. There might be a silent validation error on the quote form. Please check the screenshot.");
  const withToast = saveVerify.silentMessage("OLD SENTENCE", "Please wait");
  assert.match(withToast, /KSHEMA showed "Please wait" and nothing else\./);
  assert.equal(silent.includes(":") || withToast.includes(":"), false);

  await withEnv({ KSHEMA_SAVE_VERIFY_ENABLED: "false" }, async () => {
    assert.equal(saveVerify.refusalMessage(said), `Portal rejected the submission: "${said}"`);
    assert.equal(saveVerify.silentMessage("OLD SENTENCE", "Please wait"), "OLD SENTENCE");
  });
});

/* ----------------------------- 3. the REAL submitQuoteForm against the 2026-10-16 page ----------------------------- */

/**
 * A fake KSHEMA Quote page. `step(ms)` and `toast(ms)` say what the step bar and the snackbar show `ms` after Save and
 * Continue was pressed. "Save and Finalize" is always visible, as on the real Quote page. Time is the virtual clock.
 */
function fakeQuotePage(clock, { step = () => "Quote", toast = () => null } = {}) {
  const state = { clickedAt: null, presses: 0 };
  const shown = (text) => ({ isDisplayed: async () => true, getText: async () => text, getAttribute: async () => null });
  const button = { ...shown("Save and Continue"), click: async () => { state.presses++; state.clickedAt = clock.time(); } };
  const since = () => (state.clickedAt == null ? -1 : clock.time() - state.clickedAt);
  return {
    state,
    async sleep(ms) { clock.advance(ms); },
    async executeScript(fn) {
      if (fn === saveVerify.readActiveStepInPage) return step(since());
      return null; // scrollIntoView, readInvalidFields ...
    },
    async findElements(locator) {
      const key = String(locator.value || locator);
      if (/save and continue/i.test(key)) return [button];
      if (key.includes("Save and Finalize")) return [shown("Save and Finalize")];
      if (key === "mat-snack-bar-container [matsnackbarlabel]") {
        const text = toast(since());
        return text ? [shown(text)] : [];
      }
      return []; // the loader, the add-ons question, every other toast selector
    },
  };
}

const RATE_ERROR = "System Error More than one rate found for rate";
const submit = (driver) => require(TP_QUOTE).submitQuoteForm(driver);

test("submitQuoteForm: the 2026-10-16 run - step stays Quote, KSHEMA's error toast shows up a second later - is reported, never OK", async () => {
  await withVirtualClock(async (clock) => {
    const page = fakeQuotePage(clock, { toast: (ms) => (ms >= 1200 && ms < 7000 ? RATE_ERROR : null) });
    const { value } = await quiet(() => submit(page));
    assert.equal(value.ok, false);
    assert.match(value.error, /^KSHEMA refused Save and Continue - its message was "System Error More than one rate found for rate"\./);
    assert.equal(value.toast, RATE_ERROR);
    assert.equal(page.state.presses, 1, "Save and Continue is pressed once");
  });
});

test("submitQuoteForm: with the switch off the 2026-10-16 bug is back - OK on the first poll, the error never seen (the way back works)", async () => {
  await withVirtualClock(async (clock) => {
    await withEnv({ KSHEMA_SAVE_VERIFY_ENABLED: "false" }, async () => {
      const page = fakeQuotePage(clock, { toast: (ms) => (ms >= 1200 && ms < 7000 ? RATE_ERROR : null) });
      const { value } = await quiet(() => submit(page));
      assert.deepEqual(value, { ok: true });
    });
  });
});

test("submitQuoteForm: no page change and no message for the whole wait says so, with the screenshot hint", async () => {
  await withVirtualClock(async (clock) => {
    const page = fakeQuotePage(clock);
    const { value } = await quiet(() => submit(page));
    assert.equal(value.ok, false);
    assert.match(value.error, /^Save and Continue did not open the next page within 15 seconds\. No error message appeared\./);
    assert.match(value.error, /Please check the screenshot\.$/);
  });
});

test("submitQuoteForm: the page moves to Addon and stays quiet through the settle window - OK", async () => {
  await withVirtualClock(async (clock) => {
    const page = fakeQuotePage(clock, { step: (ms) => (ms >= 800 ? "Addon" : "Quote") });
    const { value, lines } = await quiet(() => submit(page));
    assert.deepEqual(value, { ok: true });
    assert.ok(lines.some((l) => /KSHEMA is on the "Addon" step and showed no error/.test(l)), "the operator sees what was checked");
  });
});

test("submitQuoteForm: the page moves to Addon and the error comes a moment later - a refusal, not OK", async () => {
  await withVirtualClock(async (clock) => {
    const page = fakeQuotePage(clock, {
      step: (ms) => (ms >= 800 ? "Addon" : "Quote"),
      toast: (ms) => (ms >= 2400 && ms < 9000 ? RATE_ERROR : null),
    });
    const { value } = await quiet(() => submit(page));
    assert.equal(value.ok, false);
    assert.match(value.error, /^KSHEMA opened the next step and then showed an error - its message was "System Error More than one rate found for rate"\./);
  });
});

test("submitQuoteForm: a message that is not worded as an error is added to the 'did not open' sentence", async () => {
  await withVirtualClock(async (clock) => {
    const page = fakeQuotePage(clock, { toast: (ms) => (ms >= 1000 && ms < 30000 ? "Rate lookup returned two rows" : null) });
    const { value } = await quiet(() => submit(page));
    assert.equal(value.ok, false);
    assert.match(value.error, /did not open the next page within 15 seconds\. KSHEMA showed "Rate lookup returned two rows" and nothing else\./);
  });
});

/** A page that must not be touched: any look at it fails the test. */
const untouchedPage = (step) => ({
  async executeScript(fn) {
    if (fn === saveVerify.readActiveStepInPage) return step;
    throw new Error("the page must not be touched");
  },
  async findElements() { throw new Error("the page must not be touched"); },
  async sleep() { throw new Error("the page must not be touched"); },
});

test("fillAddonsDetails: on the Quote step nothing is answered - the 2026-10-16 click on 'Is New Vehicle?' cannot happen", async () => {
  const { fillAddonsDetails } = require(TP_QUOTE);
  const { value } = await quiet(() => fillAddonsDetails(untouchedPage("Quote"), { zeroDepreciation: false }));
  assert.equal(value.ok, false);
  assert.deepEqual(value.filled, []);
  assert.deepEqual(value.screenshots, []);
  assert.match(value.error, /^The Add-ons page is not open - KSHEMA's step bar still shows Quote/);
  assert.equal(value.failures[0].label, "Add-ons page");
});

test("fillAddonsDetails: on the Summary step there is no add-ons question - skipped, not failed, page untouched", async () => {
  const { fillAddonsDetails } = require(TP_QUOTE);
  const { value, lines } = await quiet(() => fillAddonsDetails(untouchedPage("Summary"), {}));
  assert.deepEqual(value, { ok: true, filled: [], failures: [], screenshots: [], error: null });
  assert.ok(lines.some((l) => /KSHEMA is on the "Summary" step, not the Addon step/.test(l)));
});

test("fillAddonsDetails: on the Addon step the page's questions are looked for, as before", async () => {
  await withVirtualClock(async (clock) => {
    const { fillAddonsDetails } = require(TP_QUOTE);
    const looked = [];
    const page = {
      async sleep(ms) { clock.advance(ms); },
      async executeScript(fn) { return fn === saveVerify.readActiveStepInPage ? "Addon" : null; },
      async findElements(locator) { looked.push(String(locator.value || locator)); return []; }, // no question on this page
    };
    const { value } = await quiet(() => fillAddonsDetails(page, {}));
    assert.equal(value.ok, true, "the question is not required for a third-party quote");
    assert.ok(looked.length > 0, "the form went looking for the add-ons question");
  });
});

test("fillPremiumDetails: a leftover discount on the policy (50) is never typed, and the step says so once", async () => {
  const { fillPremiumDetails } = require(TP_QUOTE);
  const data = { discount: 50, ODDiscount: 50 }; // what the 2026-10-16 policy still carried
  const { value, lines } = await quiet(() => fillPremiumDetails(untouchedPage("Quote"), data));
  assert.deepEqual(value, { ok: true, filled: [], failures: [], screenshots: [], error: null });
  assert.equal(lines.filter((l) => /Premium & Discount/.test(l)).length, 1);
  assert.ok(lines.some((l) => /not used for a third-party policy, skipping/.test(l)));
  assert.ok(!lines.some((l) => /Discount \/ Loading Choice|Discount Value/.test(l)), "no 'nothing to enter' lines about the discount");

  await withEnv({ KSHEMA_SAVE_VERIFY_ENABLED: "false" }, async () => {
    const old = await quiet(() => fillPremiumDetails(untouchedPage("Quote"), data));
    assert.equal(old.value.ok, true);
    assert.ok(old.lines.some((l) => /Filling Premium & Discount details/.test(l)), "the way back: the old lines");
  });
});

/* ----------------------------- 4. wiring ----------------------------- */

const read = (file) => fs.readFileSync(file, "utf8");
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const at = (source, needle) => {
  const i = source.indexOf(needle);
  assert.ok(i >= 0, `not found: ${needle}`);
  return i;
};

test("wiring: the TP submit checks the step bar inside the wait loop, then watches after the move, before it says OK", () => {
  const source = codeOf(read(TP_QUOTE));
  const fn = source.slice(at(source, "async function submitQuoteForm(driver) {"), at(source, "const ADDON_FIELDS = ["));
  const loopStart = at(fn, "while (Date.now() < deadline) {");
  const toastRead = at(fn, "const toast = await readToast(driver);");
  const moved = at(fn, "saveVerify.nextPageShown(driver)");
  const sleep = fn.indexOf("await driver.sleep(500);", moved); // the pause that ends one pass of the loop
  assert.ok(sleep > moved, "a pause follows the step bar check");
  const late = at(fn, "saveVerify.lateRefusal(driver)");
  const done = at(fn, "return { pageChanged };");
  assert.ok(loopStart < toastRead && toastRead < moved && moved < sleep, "in the loop: the toast first, then the step bar");
  assert.ok(sleep < late && late < done, "after the loop: the late watch, then the answer");
  assert.match(fn, /error: saveVerify\.refusalMessage\(toast\.text\)/);
  assert.match(fn, /fallbackError: saveVerify\.silentMessage\(SILENT, sawToast\)/);
  assert.doesNotMatch(fn, /Save and Finalize|dnld-download-quote/, "the button that is on the Quote page proves nothing");
});

test("wiring: Add-ons are answered only after the guard, and the Premium step announces itself once", () => {
  const source = codeOf(read(TP_QUOTE));
  const addons = source.slice(at(source, "async function fillAddonsDetails("), at(source, "async function downloadProposal("));
  assert.ok(at(addons, "addonsPageVerdict(driver)") < at(addons, "return fillSection("), "the guard comes before the fill");
  assert.match(addons, /if \(verdict\.error\) return \{ ok: false,/);
  assert.match(addons, /if \(verdict\.skip\)/);

  const premium = source.slice(at(source, "async function fillPremiumDetails("), at(source, "async function submitQuoteForm("));
  assert.ok(at(premium, "not used for a third-party policy") < at(premium, "return fillSection("), "skip first, fill (never reached for TP) after");
});

test("the full-company KSHEMA flow is untouched by all this (no saveVerify anywhere in it)", () => {
  for (const file of [FULL_QUOTE, FULL_FORM]) {
    const text = read(file);
    assert.doesNotMatch(text, /kshemaSaveVerify|saveVerify|\[TP\] 11/, path.basename(file));
  }
});
