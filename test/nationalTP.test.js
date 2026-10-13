// Run with: node --test test/*.test.js
//
// National TP (multiCompany/tpCompany/nationalTP) is a DUPLICATE of the full-company National flow
// (fullPolicycompany/national.js) with the third-party-only changes: the plan "5 Year Long Term Liability Only",
// no IDV / Manufacturer's Selling Price, no inline Brisk certificate. With NATIONAL_TP_FORM_ENABLED=false it stops
// before the plan. None of these tests needs a browser, the network or a database:
//   1. the copy is still the original except for the lines tagged "[TP]" — change national.js and this fails until
//      the copy is updated (drop this test on purpose if the two should part ways);
//   2. the flow has the TP changes in the right order, and nothing of the OD flow (OD plan, IDV, selling price,
//      Brisk) is left in it;
//   3. the plan is chosen by EXACT text and read back; the switch-off stop lists the portal's options;
//   4. the handler is wired in: feature gate first, the switch, the nominee / PA-term preparation, the registry.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ORIGINAL = path.join(ROOT, "fullPolicycompany", "national.js");
const TP_DIR = path.join(ROOT, "multiCompany", "tpCompany", "nationalTP");
const COPY = path.join(TP_DIR, "nationalTPForm.js");

/** Run fn with the (very chatty) flow logging switched off. */
async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

// The GPT-4o captcha reader is imported (and unused) by national.js: stub it so loading it never touches OpenAI.
const captchaPath = require.resolve("../Captcha");
require.cache[captchaPath] = {
  id: captchaPath,
  filename: captchaPath,
  loaded: true,
  exports: { extractCaptchaText: async () => ({ text: "", success: false }) },
};

/* ----------------------- 1. the copy is the original + [TP] ----------------------- */

/**
 * Line diff of `a` (original) against `b` (copy) as a list of hunks { removed, added }. Both files are nearly
 * identical, so this walks them together and, at a mismatch, looks for the closest point where `lookahead`
 * consecutive lines agree again. Anything it cannot re-synchronise becomes one last big hunk — which has no [TP]
 * and therefore fails the guard, the safe direction.
 */
function diffHunks(a, b, { lookahead = 3, window = 400 } = {}) {
  const hunks = [];
  const same = (i, j, n) => {
    for (let k = 0; k < n; k++) {
      if (i + k >= a.length || j + k >= b.length || a[i + k] !== b[j + k]) return false;
    }
    return true;
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    let found = null;
    // closest resync first: smallest x + y wins
    for (let d = 0; d <= window && !found; d++) {
      for (let x = 0; x <= d && !found; x++) {
        const y = d - x;
        const atEndA = i + x >= a.length;
        const atEndB = j + y >= b.length;
        if ((atEndA && atEndB) || (!atEndA && !atEndB && same(i + x, j + y, lookahead))) found = { x, y };
      }
    }
    if (!found) found = { x: a.length - i, y: b.length - j };
    hunks.push({ removed: a.slice(i, i + found.x), added: b.slice(j, j + found.y) });
    i += found.x;
    j += found.y;
  }
  return hunks;
}

/** The copy's text as if it sat next to the original: only the three-folders-deeper require paths are undone. */
const normalisePaths = (text) => text.replace(/require\("\.\.\/\.\.\/\.\.\//g, 'require("../');

const untagged = (hunks) => hunks.filter((h) => !h.added.some((line) => line.includes("[TP]")));

test("sync: the copy is national.js plus [TP]-tagged changes only", () => {
  const original = fs.readFileSync(ORIGINAL, "utf8").split("\n");
  const copy = normalisePaths(fs.readFileSync(COPY, "utf8")).split("\n");
  const hunks = diffHunks(original, copy);

  assert.ok(hunks.length >= 3, `expected the header, the screenshot key and the stop to differ, got ${hunks.length} hunk(s)`);
  const bad = untagged(hunks);
  assert.deepEqual(
    bad.map((h) => ({ removed: h.removed.slice(0, 3), added: h.added.slice(0, 3) })),
    [],
    "the copy and fullPolicycompany/national.js differ outside the [TP] changes — if national.js changed, port " +
      "that change into multiCompany/tpCompany/nationalTP/nationalTPForm.js; if the copy was edited, tag the edit [TP]"
  );
});

test("sync guard can fail: an untagged edit, a lost line and an unported fix are flagged; a [TP] edit is not", () => {
  const original = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const check = (orig, copy) => untagged(diffHunks(orig, copy)).length;

  assert.equal(check(original, [...original]), 0, "identical");
  assert.equal(check(original, ["a", "b", "X", "d", "e", "f", "g", "h"]), 1, "untagged edit");
  assert.equal(check(original, ["a", "b", "X // [TP]", "d", "e", "f", "g", "h"]), 0, "tagged edit");
  assert.equal(check(original, ["// [TP] header", "a", "b", "c", "d", "e", "f", "g", "h"]), 0, "tagged insertion");
  assert.equal(check(original, ["a", "b", "c", "d", "e", "f", "g"]), 1, "line lost from the copy");

  // national.js gained a line (a portal fix) that the copy does not have yet
  const originalAfterFix = ["a", "b", "c", "FIX", "d", "e", "f", "g", "h"];
  assert.equal(check(originalAfterFix, original), 1, "a fix made in national.js and not ported");
});

test("sync: the copy exports exactly what national.js does, and loads", async () => {
  const [original, copy] = await quiet(() => [require(ORIGINAL), require(COPY)]);
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(original).sort());
  assert.equal(typeof copy.fillNationalForm, "function");
  assert.notEqual(copy.fillNationalForm, original.fillNationalForm, "must be its own copy, not the original function");
});

/* ----------------------- 2. the TP changes are where they must be ----------------------- */

/** The copy's code without comments, so a token that is only MENTIONED in a comment is not "in the flow". */
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const sourceOfCopy = () => fs.readFileSync(COPY, "utf8");

test("the plan step: switch-off stop, then the exact TP plan, at the top level, before anything is filled or bought", () => {
  const source = sourceOfCopy();
  const at = (re) => {
    const i = source.search(re);
    assert.ok(i >= 0, `missing: ${re}`);
    return i;
  };
  const checkpoint = at(/^ {4}Breaker\.checkpoint\("National TP\/plan"\);$/m);
  const stop = at(/^ {4}if \(!isNationalTpFormEnabled\(\)\) await stopBeforePlan\(driver, jobId\);$/m);
  const select = at(/^ {4}await selectTpPlan\(driver, \{$/m);
  assert.ok(checkpoint < stop && stop < select, "checkpoint, then the switch-off stop, then the plan");

  // everything that fills the quote, creates a customer, prices or buys comes AFTER the plan
  const order = [
    'By.name("mcy_dropdown_vehcileClass_01")',
    'By.name("mcy_dropdown_newRtoLocation_01")',
    "await assertTpPlanStillSelected(driver, {",
    'Breaker.checkpoint("National TP/quote")',
    'By.name("mcy_button_quickQuote_01")',
    'By.name("main_btn_convert_01")',
    'By.name("newCust_btn_createCust_01")',
    'By.name("mcy_button_calculatePremium_01")',
    'Breaker.checkpoint("National TP/payment")',
    'By.name("vQuote_btn_sendPayLink_01")',
  ];
  let last = select;
  for (const token of order) {
    const i = source.indexOf(token);
    assert.ok(i > last, `${token} is missing or out of order (expected after the previous step)`);
    last = i;
  }
});

test("nothing of the own-damage flow is left: no OD plan, no IDV, no selling price, no discount %, no inline Brisk", () => {
  const code = codeOf(sourceOfCopy());
  const gone = [
    '"OD With Long Term Act"', // the comprehensive plan
    '"Third Party"', // the old plan fallback
    "safeType(driver, idvField", // typing the IDV
    "await overridePortalDerivedIdv(", // the IDV override (first pass and re-assert)
    "await fillDiscountPercentage(", // the discount % at the quick quote and again after the IDV was restored
    "formData.discount", // the full-policy "Handle Discount/Percentage" step
    "Setting discount percentage", // ... and its log line
    '"after discount"', // the Vahan label that only made sense with a discount
    'By.name("pc_text_msp_01")', // Manufacturer's Selling Price
    "manufacturerSellingPrice", // ... and where it came from
    "Extracting IDV value after quote generation",
    "await createBriskCertificate(",
    "await downloadBriskPDF(",
    "await uploadBriskCertificate(",
  ];
  for (const token of gone) {
    assert.equal(code.includes(token), false, `${token} is still in the TP flow`);
  }
});

test("everything the user said stays the same is still there", () => {
  const code = codeOf(sourceOfCopy());
  const kept = [
    "isNonGICSelected", // the model-not-found tick
    "mcy_toggle_cpaCoverorBenefit_01", // PA radio (1 year / 5 year)
    "mcy_dropdown_noy_01", // PA "No of Years"
    "data.paCoverYears",
    "nomineeName",
    "mcy_toggle_FinancierDetails_01",
    'await runCheckVahan(driver, jobId, "third party", data);', // the one Vahan lookup of the flow (no discount to re-run it for)
    "vQuote_btn_sendPayLink_01", // the payment link
    "return { success: true, briskCertificateError: null };",
  ];
  for (const token of kept) assert.ok(code.includes(token), `${token} is no longer in the TP flow`);
});

test("a plan error is returned as a non-retryable failure, not as the original's post-submission mapping", () => {
  const source = sourceOfCopy();
  assert.match(
    source,
    /if \(error\.isTpPlanError\) \{[\s\S]{0,700}errorCode: "E306",\s*retryable: false,\s*stage: error\.stage \|\| "tp-plan"/
  );
  // and it sits BEFORE the generic validation mapping
  assert.ok(source.indexOf("if (error.isTpPlanError)") < source.indexOf("const isValidationError ="));
});

test("the copy keeps the original's stop handling, so a stop is returned as a stop", () => {
  assert.match(sourceOfCopy(), /if \(isAutomationStop\(error\)\) \{[\s\S]{0,400}return stopped;/);
});

/* ----------------------- 3. choosing the plan, and the switch-off stop ----------------------- */

const { stopBeforePlan, readPlanOptions } = require("../multiCompany/tpCompany/nationalTP/stopBeforePlan");
const { isAutomationStop, stoppedResult } = require("../automationStopper");

/** Just the Selenium calls stopBeforePlan makes; anything else (typing, submitting) is not there to be called. */
function fakeDriver({ options = [], waitFails = false, staleAt = -1 } = {}) {
  const calls = [];
  const dropdown = {
    async click() {
      calls.push("click dropdown");
    },
  };
  return {
    calls,
    async wait() {
      calls.push("wait");
      if (waitFails) throw new Error("Wait timed out after 15000ms");
      return dropdown;
    },
    async executeScript() {
      calls.push("script");
    },
    async findElements() {
      return options.map((text, index) => ({
        async getText() {
          if (index === staleAt) throw new Error("stale element reference");
          return text;
        },
      }));
    },
  };
}

async function stopOf(driver) {
  let stop = null;
  await quiet(async () => {
    try {
      await stopBeforePlan(driver, "test-job");
    } catch (e) {
      stop = e;
    }
  });
  return stop;
}

test("stopBeforePlan: lists the portal's plan options and ends the run as a stop", async () => {
  const driver = fakeDriver({ options: ["OD With Long Term Act", "  Long Term Act Only ", "Long Term Act Only", ""] });
  const stop = await stopOf(driver);

  assert.ok(stop, "it must always stop");
  assert.equal(isAutomationStop(stop), true);
  assert.equal(stop.details.stage, "tp-plan");
  assert.deepEqual(stop.details.planOptions, ["OD With Long Term Act", "Long Term Act Only"], "trimmed, no blanks, no duplicates");
  assert.match(stop.message, /"OD With Long Term Act", "Long Term Act Only"/);
  assert.match(stop.message, /NATIONAL_TP_FORM_ENABLED is set to false/);
  // read-only: it opened the dropdown and nothing else
  assert.deepEqual(driver.calls.filter((c) => c.startsWith("click")), ["click dropdown"]);
});

test("stopBeforePlan: still stops, saying why, when the dropdown cannot be read", async () => {
  const stop = await stopOf(fakeDriver({ waitFails: true }));
  assert.equal(isAutomationStop(stop), true);
  assert.deepEqual(stop.details.planOptions, []);
  assert.match(stop.message, /could not be read from the page/);
  assert.equal(stop.message.includes("Wait timed out"), false, "the driver's own text stays out of the sentence");
  assert.match(stop.details.readError, /Wait timed out/, "...and is kept in the details for whoever debugs it");
});

test("stopBeforePlan: a stale option is skipped and the list is bounded", async () => {
  const stale = await stopOf(fakeDriver({ options: ["A", "B", "C"], staleAt: 1 }));
  assert.deepEqual(stale.details.planOptions, ["A", "C"]);

  const many = Array.from({ length: 60 }, (_, i) => `Plan ${i}`);
  const listed = await quiet(() => readPlanOptions(fakeDriver({ options: many })));
  assert.equal(listed.length, 25);
});

const {
  TP_PLAN_TEXT,
  TpPlanError,
  pickPlanOption,
  selectTpPlan,
  assertTpPlanStillSelected,
} = require("../multiCompany/tpCompany/nationalTP/tpPlan");

/** The portal's options for a new two-wheeler, in the order the dropdown shows them. */
const PORTAL_PLANS = ["OD With Long Term Act", "5 Year Long Term Liability Only", "Standalone OD", "Long Term Package Policy"];

/**
 * A Your Plan dropdown that behaves like the portal's: closed until clicked, then a list of options; clicking one
 * closes it and makes it the shown value. `ignoreClick` is a portal that keeps its pre-selected plan.
 */
function fakePlanDriver({
  options = PORTAL_PLANS,
  selected = "OD With Long Term Act",
  ignoreClick = false,
  lagReads = 0,
  blankGetText = false, // Selenium's getText() is "" while the panel is still fading in; textContent is not
  lateOptions = 0, // the options list is empty for this many reads after the panel opens (a slow render)
} = {}) {
  const state = { open: false, selected, clicks: [], dropdownClicks: 0, pending: null, lag: 0, lateReads: 0 };
  // `lagReads`: Angular paints the choice a moment after the click — the old value is shown for this many reads
  const shown = () => {
    if (state.pending !== null && state.lag > 0) {
      state.lag -= 1;
      return state.selected;
    }
    if (state.pending !== null) {
      state.selected = state.pending;
      state.pending = null;
    }
    return state.selected;
  };
  const optionEls = options.map((text) => ({
    _text: text,
    async getText() {
      return blankGetText ? "" : text;
    },
    async click() {
      state.clicks.push(text);
      if (!ignoreClick) {
        if (lagReads > 0) {
          state.pending = text;
          state.lag = lagReads;
        } else {
          state.selected = text;
        }
      }
      state.open = false;
    },
  }));
  const dropdown = {
    async click() {
      state.open = true;
      state.lateReads = lateOptions;
      state.dropdownClicks += 1;
    },
    async getText() {
      return shown();
    },
    async findElements() {
      const value = shown();
      return value ? [{ async getText() { return value; } }] : [];
    },
  };
  return {
    state,
    async wait(condition) {
      return typeof condition === "function" ? condition() : dropdown;
    },
    async executeScript(script, element) {
      // the textContent read (tpPlan.js textOf); every other script (scrollIntoView, click, body.click) does nothing
      if (typeof script === "string" && script.includes("textContent") && element && typeof element._text === "string") {
        return element._text;
      }
      return undefined;
    },
    async findElements() {
      if (!state.open) return [];
      if (state.lateReads > 0) {
        state.lateReads -= 1;
        return [];
      }
      return optionEls;
    },
  };
}

const planLog = () => {
  const lines = [];
  const log = (line) => lines.push(line);
  log.lines = lines;
  return log;
};

test("tpPlan: the TP plan is the exact text from the portal", () => {
  assert.equal(TP_PLAN_TEXT, "5 Year Long Term Liability Only");
});

test("tpPlan: picks the exact option although the OD plan is listed first and others overlap", async () => {
  const driver = fakePlanDriver();
  const log = planLog();
  const result = await selectTpPlan(driver, { log });

  assert.deepEqual(driver.state.clicks, ["5 Year Long Term Liability Only"], "exactly one option clicked, the TP plan");
  assert.equal(driver.state.selected, "5 Year Long Term Liability Only");
  assert.equal(result.selected, "5 Year Long Term Liability Only");
  assert.deepEqual(result.options, PORTAL_PLANS);
  assert.ok(log.lines.some((l) => l.includes("Long Term Package Policy")), "the options are logged");
});

test("tpPlan: matching ignores case and spacing but is never a 'contains'", () => {
  assert.equal(pickPlanOption(["Long Term Act", "  5  YEAR long term   liability ONLY "]), 1);
  assert.equal(pickPlanOption(PORTAL_PLANS), 1);
  // a longer text that merely contains the plan, a shorter one that is contained in it
  assert.equal(pickPlanOption(["5 Year Long Term Liability Only Plus"]), -1);
  assert.equal(pickPlanOption(["Liability Only", "Long Term"]), -1);
  assert.equal(pickPlanOption(["OD With Long Term Act"], "Long Term Act"), -1);
  assert.equal(pickPlanOption([], "x"), -1);
  assert.equal(pickPlanOption(["a"], ""), -1);
});

test("tpPlan: a plan the portal does not offer fails loudly, listing what it does, and clicks nothing", async () => {
  const driver = fakePlanDriver({ options: ["OD With Long Term Act", "Standalone OD"] });
  await assert.rejects(
    () => selectTpPlan(driver, { log: planLog(), optionsWaitMs: 0 }),
    (error) => {
      assert.ok(error instanceof TpPlanError);
      assert.equal(error.isTpPlanError, true);
      assert.equal(error.stage, "tp-plan");
      assert.deepEqual(error.planOptions, ["OD With Long Term Act", "Standalone OD"]);
      assert.match(error.message, /"5 Year Long Term Liability Only" is not offered/);
      assert.match(error.message, /"OD With Long Term Act", "Standalone OD"/);
      assert.match(error.message, /nothing was chosen or submitted/);
      return true;
    }
  );
  assert.deepEqual(driver.state.clicks, [], "no option was clicked");
  assert.equal(driver.state.selected, "OD With Long Term Act", "the portal's own plan is untouched");
});

test("tpPlan: a portal that ignores the click (still shows the OD plan) is caught by the read-back", async () => {
  const driver = fakePlanDriver({ ignoreClick: true });
  await assert.rejects(
    () => selectTpPlan(driver, { log: planLog(), settleMs: 0 }),
    (error) => {
      assert.equal(error.isTpPlanError, true);
      assert.equal(error.selected, "OD With Long Term Act");
      assert.match(error.message, /shows "OD With Long Term Act"/);
      return true;
    }
  );
});

test("tpPlan: right before the quote the plan is checked again — it passes on the TP plan and refuses a fallback", async () => {
  const good = fakePlanDriver({ selected: "5 Year Long Term Liability Only" });
  assert.equal(await assertTpPlanStillSelected(good, { log: planLog() }), "5 Year Long Term Liability Only");

  const fellBack = fakePlanDriver({ selected: "OD With Long Term Act" });
  await assert.rejects(
    () => assertTpPlanStillSelected(fellBack, { log: planLog(), settleMs: 0 }),
    (error) => {
      assert.equal(error.isTpPlanError, true);
      assert.match(error.message, /plan changed while the form was filled/);
      assert.match(error.message, /Nothing was submitted/);
      return true;
    }
  );

  const nothing = fakePlanDriver({ selected: "" });
  await assert.rejects(() => assertTpPlanStillSelected(nothing, { log: planLog(), settleMs: 0 }), /"\(nothing\)"/);
});

test("tpPlan: options are read from textContent — a panel still fading in (getText empty) loses no plan", async () => {
  // The run that listed three of the four plans: "OD With Long Term Act", read first, came back "" from getText().
  const driver = fakePlanDriver({ blankGetText: true });
  const result = await selectTpPlan(driver, { log: planLog() });
  assert.deepEqual(result.options, PORTAL_PLANS, "all four, in the portal's order");
  assert.deepEqual(driver.state.clicks, ["5 Year Long Term Liability Only"]);
  assert.equal(result.selected, "5 Year Long Term Liability Only");
});

test("stop: the plan list is complete even while the panel is still fading in", async () => {
  const stop = await stopOf(fakePlanDriver({ blankGetText: true }));
  assert.deepEqual(stop.details.planOptions, PORTAL_PLANS);
  for (const plan of PORTAL_PLANS) assert.ok(stop.message.includes(`"${plan}"`), `${plan} is in the message`);
});

test("tpPlan: a plan list that renders a moment late is waited for — not 'not offered'", async () => {
  const slow = fakePlanDriver({ lateOptions: 2 }); // two reads see an empty panel
  const result = await selectTpPlan(slow, { log: planLog(), optionsWaitMs: 3000 });
  assert.equal(result.selected, "5 Year Long Term Liability Only");

  // and a list that never gets it is still refused, after the wait, naming what IS there
  const never = fakePlanDriver({ options: ["Standalone OD"] });
  await assert.rejects(() => selectTpPlan(never, { log: planLog(), optionsWaitMs: 300 }), /is not offered on the National portal/);
});

test("tpPlan: a slow repaint is waited out — the choice is read again until it shows, not judged on the first look", async () => {
  const slow = fakePlanDriver({ lagReads: 2 });
  const result = await selectTpPlan(slow, { log: planLog(), settleMs: 2000 });
  assert.equal(result.selected, "5 Year Long Term Liability Only");

  // ... and with no patience the same portal is (correctly) refused: the read-back is a real check
  const impatient = fakePlanDriver({ lagReads: 2 });
  await assert.rejects(() => selectTpPlan(impatient, { log: planLog(), settleMs: 0 }), /shows "OD With Long Term Act"/);
});

// lib/errorHandler.js beautifyError keeps only the text after the LAST colon of a message. The first version of the stop
// message had a second colon before the plan list, so the operator saw nothing but four plan names and no reason — and
// asked why the plan was not selected. These messages must keep their reason through the same function the queue uses.
test("the reasons survive the queue's beautifyError (it keeps only the text after the last colon)", async () => {
  const { beautifyError } = require("../lib/errorHandler");
  const shown = (message) => beautifyError(message, "national");

  const stop = await stopOf(fakeDriver({ options: PORTAL_PLANS }));
  const stopShown = shown(stop.message);
  assert.match(stopShown, /NATIONAL_TP_FORM_ENABLED is set to false/, "why it stopped");
  assert.match(stopShown, /Remove that line from the automation \.env \(or set it to true\)/, "what to do");
  assert.match(stopShown, /Nothing was chosen or submitted/);
  for (const plan of PORTAL_PLANS) assert.ok(stopShown.includes(`"${plan}"`), `${plan} is listed`);

  const unreadable = await stopOf(fakeDriver({ waitFails: true }));
  assert.match(shown(unreadable.message), /NATIONAL_TP_FORM_ENABLED is set to false/);
  assert.match(shown(unreadable.message), /could not be read/);

  const missing = fakePlanDriver({ options: ["OD With Long Term Act", "Standalone OD"] });
  const notOffered = await selectTpPlan(missing, { log: planLog(), optionsWaitMs: 0 }).catch((e) => e);
  const notOfferedShown = shown(notOffered.message);
  assert.match(notOfferedShown, /"5 Year Long Term Liability Only" is not offered on the National portal/);
  assert.match(notOfferedShown, /"OD With Long Term Act", "Standalone OD"/);

  const stuck = await selectTpPlan(fakePlanDriver({ ignoreClick: true }), { log: planLog(), settleMs: 0 }).catch((e) => e);
  assert.match(shown(stuck.message), /chose the plan "5 Year Long Term Liability Only" but the portal shows "OD With Long Term Act"/i);

  const changed = await assertTpPlanStillSelected(fakePlanDriver({ selected: "Standalone OD" }), { log: planLog(), settleMs: 0 }).catch((e) => e);
  assert.match(shown(changed.message), /the plan changed while the form was filled/i);
});

test("a TpPlanError result is non-retryable for the queue (not post-submission, not retried)", () => {
  const { mapRunResult } = require("../lib/partRunner");
  const result = {
    success: false,
    error: 'National TP: the plan "5 Year Long Term Liability Only" is not offered on the National portal, so nothing was chosen or submitted.',
    errorCode: "E306",
    retryable: false,
    stage: "tp-plan",
    planOptions: [],
  };
  const outcome = mapRunResult(result, { part: { key: "tp", kind: "portal", company: "National" }, companyName: "national" });
  assert.equal(outcome.type, "nonRetryable");
  assert.equal(outcome.errorCode, "E306");
  assert.equal(outcome.stage, "tp-plan");
  assert.equal(outcome.errorExtra.retryable, false);
});

test("a TP part that hits the stop is recorded as stopped (not retried, not a purchase)", async () => {
  const { mapRunResult } = require("../lib/partRunner");
  const stop = await stopOf(fakeDriver({ options: ["OD With Long Term Act"] }));
  // exactly what national.js's catch hands back for a stop
  const result = stoppedResult(stop);
  const outcome = mapRunResult(result, {
    part: { key: "tp", kind: "portal", company: "National" },
    companyName: "national",
  });
  assert.equal(outcome.type, "stopped");
  assert.equal(outcome.errorCode, "E100");
  assert.equal(outcome.stage, "tp-plan");
  assert.equal(outcome.errorExtra.retryable, false);
  assert.match(outcome.error, /OD With Long Term Act/);
});

/**
 * Run the REAL copy down its failure path with the browser, S3 and recorder replaced: the portal cannot be reached,
 * so the copy's own catch builds the failure result, takes the error screenshot and cleans the browser up.
 */
async function failedRun() {
  const session = require.resolve("../nationalSessionManager");
  const s3 = require.resolve("../s3Uploader");
  const recorder = require.resolve("../lib/jobRecorder");
  const realS3 = require("../s3Uploader");
  const uploaded = [];
  const cleaned = [];
  const driver = {
    async get() {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    },
    async takeScreenshot() {
      return "aGVsbG8=";
    },
    async getCurrentUrl() {
      return "about:blank";
    },
  };
  const stubs = {
    [session]: {
      createNationalJobBrowser: async () => ({ driver }),
      cleanupNationalJobBrowser: async (browser, opts) => cleaned.push(opts),
    },
    [s3]: { ...realS3, uploadScreenshotToS3: async (_b64, key) => (uploaded.push(key), `https://s3.test/${key}`) },
    [recorder]: { startRecording() {} },
  };
  const saved = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  saved.set(COPY, require.cache[COPY]);
  delete require.cache[COPY];
  try {
    const { fillNationalForm } = await quiet(() => require(COPY));
    const result = await quiet(() =>
      fillNationalForm({
        username: "u",
        password: "p",
        loginUrl: "https://portal.test/login",
        settings: { PACompany: "" }, // PA Cover off ...
        paCoverYears: 1, // ... and the year picked: this is what reaches the portal
        _jobIdentifier: "Asha_job1_tp",
        _attemptNumber: 2,
      })
    );
    return { result, uploaded, cleaned };
  } finally {
    for (const [p, entry] of saved) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
}

test("failure path of the copy: the error screenshot goes under screenshots/multiCompany/ and the browser is cleaned up", async () => {
  const { result, uploaded, cleaned } = await failedRun();

  assert.equal(result.success, false);
  assert.match(result.error, /National/i);
  assert.equal(uploaded.length, 1, "one screenshot for one failed attempt");
  // the prefix the 10-day S3 lifecycle rule covers (s3Uploader MULTI_COMPANY_SCREENSHOT_PREFIX)
  assert.match(uploaded[0], /^screenshots\/multiCompany\/national\/form-error\/Asha_job1_tp\/attempt_2\//);
  assert.equal(result.screenshotKey, uploaded[0]);
  assert.deepEqual(cleaned, [{ hadError: true }], "browser closed, told it was a failed job");
});

/* ----------------------- 4. the handler is wired in ----------------------- */

const featureGatePath = require.resolve("../multiCompany/common/featureGate");
const handlerPath = require.resolve("../multiCompany/tpCompany/nationalTP/nationalTP");
const formPath = require.resolve("../multiCompany/tpCompany/nationalTP/nationalTPForm");

/** Load nationalTP.js fresh with the feature flag on/off and the real form replaced by `fillNationalForm`. */
function loadHandler({ enabled, fillNationalForm }) {
  const keep = {
    env: process.env.MULTI_COMPANY_AUTOMATION_ENABLED,
    gate: require.cache[featureGatePath],
    handler: require.cache[handlerPath],
    form: require.cache[formPath],
  };
  process.env.MULTI_COMPANY_AUTOMATION_ENABLED = enabled ? "true" : "false";
  delete require.cache[featureGatePath];
  delete require.cache[handlerPath];
  require.cache[formPath] = { id: formPath, filename: formPath, loaded: true, exports: { fillNationalForm } };
  const savedLog = console.log;
  console.log = () => {}; // featureGate loads .env through dotenv, which prints a banner each time
  try {
    return require(handlerPath).fillNationalTP;
  } finally {
    console.log = savedLog;
    if (keep.env === undefined) delete process.env.MULTI_COMPANY_AUTOMATION_ENABLED;
    else process.env.MULTI_COMPANY_AUTOMATION_ENABLED = keep.env;
    for (const [p, entry] of [[featureGatePath, keep.gate], [handlerPath, keep.handler], [formPath, keep.form]]) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
}

test("handler: with the feature off it fails [E110] before the form is touched", async () => {
  let touched = 0;
  const fillNationalTP = loadHandler({ enabled: false, fillNationalForm: async () => (touched++, { success: true }) });
  await assert.rejects(() => fillNationalTP({ username: "u" }), /\[E110\]/);
  assert.equal(touched, 0);
});

test("handler: with the feature on it runs the duplicated form once, with the same data, and returns its result", async () => {
  const calls = [];
  const answer = { success: false, inProgress: true, stage: "tp-plan" };
  const fillNationalTP = loadHandler({
    enabled: true,
    fillNationalForm: async (data) => (calls.push(data), answer),
  });
  const data = { username: "u", password: "p", loginUrl: "https://example.test", _jobId: "job1", policyType: "tp" };
  // NATIONAL_TP_FORM_ENABLED=false: the form is handed the payload as it is
  const result = await withTpSwitch("false", () => fillNationalTP(data));
  assert.equal(result, answer);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], data, "the payload is handed over untouched");
});

test("registry: national / tp is the National TP handler; the other five are still login-only stubs", () => {
  const { registry, resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const { fillNationalTP } = require("../multiCompany/tpCompany/nationalTP/nationalTP");
  assert.equal(registry.national.tp, fillNationalTP);
  assert.equal(resolveMultiCompanyHandler("National", "TP"), fillNationalTP);
  assert.notEqual(registry.national.tp.name, "loginOnlyHandler");
  for (const [company, type] of [["national", "od"], ["reliance", "tp"], ["kshema", "od"], ["kshema", "tp"]]) {
    assert.equal(registry[company][type].name, "loginOnlyHandler", `${company} ${type} changed`);
  }
});

/* ----- the switch, and what a TP run is prepared with ----- */

const { isNationalTpFormEnabled } = require("../multiCompany/tpCompany/nationalTP/tpConfig");
const { prepareNationalTp } = require("../multiCompany/tpCompany/nationalTP/nationalTP");
const { portalPaTerm, paViaBrisk } = require("../multiCompany/tpCompany/nationalTP/tpPa");

/** Run fn with NATIONAL_TP_FORM_ENABLED set to `value` (undefined = unset), restoring it after. */
async function withTpSwitch(value, fn) {
  const saved = process.env.NATIONAL_TP_FORM_ENABLED;
  if (value === undefined) delete process.env.NATIONAL_TP_FORM_ENABLED;
  else process.env.NATIONAL_TP_FORM_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.NATIONAL_TP_FORM_ENABLED;
    else process.env.NATIONAL_TP_FORM_ENABLED = saved;
  }
}

test("switch: NATIONAL_TP_FORM_ENABLED is ON unless it is explicitly false / 0 / no / off", async () => {
  // unset, empty or anything else: on — "select the plan and continue" needs no line in .env
  for (const on of [undefined, "", "true", "TRUE", "1", "yes", "on", " true ", "enabled?"]) {
    assert.equal(await withTpSwitch(on, () => isNationalTpFormEnabled()), true, `${JSON.stringify(on)} should leave it on`);
  }
  for (const off of ["false", "FALSE", "0", "no", "off", " Off "]) {
    assert.equal(await withTpSwitch(off, () => isNationalTpFormEnabled()), false, `${JSON.stringify(off)} should switch it off`);
  }
});

const paNational = (extra = {}) => ({
  paCover: true,
  paCoverCompany: "Company",
  settings: { isMultipleCompany: true, ODCompany: "Reliance", TPCompany: "National", PACompany: "National" },
  paCoverYears: 5,
  nomineeName: "ASHA",
  nomineeRelation: "Mother",
  nomineeAge: 45,
  userId: "u1",
  clientId: "c1",
  ...extra,
});
const noLookup = async () => {
  throw new Error("the saved default must not be looked up here");
};
const quietLog = () => {};

test("prepare: PA bought with National keeps the policy's own nominee and the 1 / 5 year term", async () => {
  for (const years of [1, 5, "1", "5"]) {
    const data = paNational({ paCoverYears: years });
    const out = await prepareNationalTp(data, { resolveNominee: noLookup, log: quietLog });
    assert.equal(out.paCoverYears, years);
    assert.equal(out.nomineeName, "ASHA");
    assert.equal(out.nomineeRelation, "Mother");
    assert.equal(out.nomineeAge, 45);
  }
});

test("prepare: the term is not exactly 1 or 5 -> [E101] before any browser — PA Cover off or National alike", async () => {
  for (const settings of [
    { PACompany: "National" },
    { PACompany: "" }, // PA Cover off
  ]) {
    for (const years of [undefined, null, "", 0, 2, 3, 4, "five", NaN]) {
      await assert.rejects(
        () =>
          prepareNationalTp(paNational({ paCover: !!settings.PACompany, settings: { ODCompany: "Reliance", TPCompany: "National", ...settings }, paCoverYears: years }), {
            resolveNominee: noLookup,
            log: quietLog,
          }),
        /\[E101\] National TP: the policy has no PA term of 1 or 5 years/,
        `${JSON.stringify(settings)} paCoverYears ${JSON.stringify(years)} must be refused`
      );
    }
  }
});

test("prepare: PA Cover OFF with a year picked is fine — the year is what the portal gets (this was a 'No')", async () => {
  const data = paNational({ paCover: false, paCoverCompany: "", paCoverYears: 1, settings: { ODCompany: "Reliance", TPCompany: "National", PACompany: "" } });
  const out = await prepareNationalTp(data, { resolveNominee: noLookup, log: quietLog });
  assert.equal(out.paCoverYears, 1);
  assert.equal(portalPaTerm(out), 1);
});

test("prepare: PA from Brisk needs no year (the portal stays 'No')", async () => {
  for (const paCoverYears of [undefined, "", 0, 1, 5]) {
    const data = paNational({
      paCover: false,
      paCoverCompany: "Brisk",
      paCoverYears,
      settings: { ODCompany: "Reliance", TPCompany: "National", PACompany: "Brisk" },
    });
    const out = await prepareNationalTp(data, { resolveNominee: noLookup, log: quietLog });
    assert.equal(portalPaTerm(out), 0, `year ${JSON.stringify(paCoverYears)}: Brisk covers the PA, the portal says No`);
  }
});

test("prepare: the saved default nominee fills only what the policy left blank; the policy's own wins", async () => {
  const asked = [];
  const resolveNominee = async (args) => {
    asked.push(args);
    return { name: "SAVED NAME", relation: "Father", age: 60 };
  };
  const data = paNational({ paCover: false, nomineeName: "", nomineeRelation: "Wife", nomineeAge: undefined });
  const out = await prepareNationalTp(data, { resolveNominee, log: quietLog });

  assert.equal(out.nomineeName, "SAVED NAME", "blank -> saved default");
  assert.equal(out.nomineeRelation, "Wife", "policy's own wins");
  assert.equal(out.nomineeAge, 60, "blank -> saved default");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].userId, "u1");
  assert.equal(asked[0].clientId, "c1");
  // the input is not mutated
  assert.equal(data.nomineeName, "");
});

test("prepare: no nominee anywhere -> [E101], whatever the PA — National demands one on every quote", async () => {
  const none = async () => null;
  for (const settings of [{ PACompany: "Brisk" }, { PACompany: "National" }, { PACompany: "" }]) {
    await assert.rejects(
      () =>
        prepareNationalTp(
          paNational({ settings: { ODCompany: "Reliance", TPCompany: "National", ...settings }, nomineeName: "", nomineeRelation: "", nomineeAge: "" }),
          { resolveNominee: none, log: quietLog }
        ),
      /\[E101\] National requires nominee details on every quote and this policy has none/,
      JSON.stringify(settings)
    );
  }
});

test("portalPaTerm: the policy's year, 'No' only for Brisk's PA — the portal's Compulsory PA", () => {
  const withPa = (PACompany, paCoverYears, extra = {}) => ({ settings: { PACompany }, paCoverYears, ...extra });
  // PA Cover off or National: the year
  assert.equal(portalPaTerm(withPa("", 1)), 1);
  assert.equal(portalPaTerm(withPa("", 5)), 5);
  assert.equal(portalPaTerm(withPa("National", "1")), 1);
  assert.equal(portalPaTerm(withPa("national", 5)), 5);
  // PA Cover with Brisk: No — whatever year is saved
  assert.equal(portalPaTerm(withPa("Brisk", 1)), 0);
  assert.equal(portalPaTerm(withPa("BRISK", undefined)), 0);
  // the old trigger fields no longer decide: paCover false / "Company" does not turn the year off or on
  assert.equal(portalPaTerm(withPa("", 1, { paCover: false, paCoverCompany: "Brisk" })), 1, "paCoverCompany alone is not Brisk's PA");
  assert.equal(portalPaTerm(withPa("National", 5, { paCover: false })), 5);
  // anything else is unusable, and says so (null) instead of guessing
  for (const bad of [undefined, null, "", 0, 2, 3, 10, "five", NaN]) {
    assert.equal(portalPaTerm(withPa("", bad)), null, JSON.stringify(bad));
  }
  assert.equal(portalPaTerm(undefined), null);
  assert.equal(paViaBrisk({ settings: { PACompany: "Brisk" } }), true);
  assert.equal(paViaBrisk({ settings: { PACompany: "National" } }), false);
  assert.equal(paViaBrisk({}), false);
});

test("the form decides the portal's PA from portalPaTerm in all three places — not from 'PA Cover = National'", () => {
  const code = codeOf(sourceOfCopy());
  assert.equal((code.match(/const isCompanyPA = tpPaTerm === 1 \|\| tpPaTerm === 5;/g) || []).length, 3, "quote step, PA section, nominee section");
  assert.match(code, /const tpPaTerm = portalPaTerm\(data\);/);
  // the old triggers are gone
  assert.equal(code.includes('String(data.paCoverCompany).toLowerCase() === "company"'), false);
  assert.equal(code.includes('paCompanyVal === "company" || paCompanyVal === "national"'), false);
  // the term is decided before any browser is opened
  assert.ok(code.indexOf("const tpPaTerm = portalPaTerm(data);") < code.indexOf("await createNationalJobBrowser(jobId)"));
});

test("the form itself refuses an unusable term before it opens a browser (direct callers, the CLI)", async () => {
  const session = require.resolve("../nationalSessionManager");
  const saved = new Map();
  let opened = 0;
  saved.set(session, require.cache[session]);
  require.cache[session] = {
    id: session,
    filename: session,
    loaded: true,
    exports: { createNationalJobBrowser: async () => (opened++, { driver: {} }), cleanupNationalJobBrowser: async () => {} },
  };
  saved.set(COPY, require.cache[COPY]);
  delete require.cache[COPY];
  try {
    const { fillNationalForm } = await quiet(() => require(COPY));
    const result = await quiet(() =>
      fillNationalForm({ settings: { PACompany: "" }, paCoverYears: 3, username: "u", password: "p", _jobIdentifier: "Asha_job1_tp" })
    );
    assert.equal(opened, 0, "no browser was opened");
    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
    assert.equal(result.stage, "tp-pa");
    assert.match(result.error, /no PA term of 1 or 5 years/);
  } finally {
    for (const [p, entry] of saved) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
});

test("handler: switch set to false -> the form gets the payload untouched and nothing is looked up", async () => {
  const calls = [];
  const fillNationalTP = loadHandler({ enabled: true, fillNationalForm: async (d) => (calls.push(d), { inProgress: true }) });
  const data = paNational({ paCoverYears: undefined, nomineeName: "" }); // would be refused if it were prepared
  const result = await withTpSwitch("false", () => fillNationalTP(data));
  assert.deepEqual(result, { inProgress: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], data, "same object: not prepared, not enriched");
});

test("handler: switch set to false says so in the log, naming the setting and what to do", async () => {
  const fillNationalTP = loadHandler({ enabled: true, fillNationalForm: async () => ({ inProgress: true }) });
  const lines = [];
  const saved = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await withTpSwitch("false", () => fillNationalTP({ username: "u" }));
  } finally {
    console.log = saved;
  }
  const said = lines.join("\n");
  assert.match(said, /NATIONAL_TP_FORM_ENABLED is set to false/);
  assert.match(said, /Remove that line from the automation \.env \(or set it to true\) and restart/);
  assert.match(said, /5 Year Long Term Liability Only/);
});

test("handler: NOTHING set in .env -> it goes on (the payload is prepared, the form runs), no line needed", async () => {
  const calls = [];
  const fillNationalTP = loadHandler({ enabled: true, fillNationalForm: async (d) => (calls.push(d), { success: true }) });
  const data = paNational({ _jobId: "job9", policyType: "tp" });
  const result = await withTpSwitch(undefined, () => fillNationalTP(data));
  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], data, "prepared, not handed over as it was");
  assert.equal(calls[0].nomineeName, "ASHA");
  assert.equal(calls[0].paCoverYears, 5);
});

test("handler: switch on -> the payload is prepared, then the form runs once with the nominee resolved", async () => {
  const calls = [];
  const fillNationalTP = loadHandler({ enabled: true, fillNationalForm: async (d) => (calls.push(d), { success: true }) });
  const data = paNational({ _jobId: "job1", policyType: "tp" });
  const result = await withTpSwitch("true", () => fillNationalTP(data));
  assert.deepEqual(result, { success: true });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0], data);
  assert.equal(calls[0]._jobId, "job1");
  assert.equal(calls[0].policyType, "tp");
  assert.equal(calls[0].nomineeName, "ASHA");
  assert.equal(calls[0].paCoverYears, 5);
});

test("handler: switch on and the PA term is wrong -> [E101], the form is never started", async () => {
  let started = 0;
  const fillNationalTP = loadHandler({ enabled: true, fillNationalForm: async () => (started++, { success: true }) });
  await withTpSwitch("true", async () => {
    await assert.rejects(() => fillNationalTP(paNational({ paCoverYears: 3 })), /\[E101\].*1 or 5 years/);
  });
  assert.equal(started, 0);
});
