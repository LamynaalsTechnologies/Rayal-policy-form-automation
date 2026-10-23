// Run with: node --require ./test/support/noRealWorld.js --test test/relianceOdSteps.test.js
//
// Reliance OD, the steps only the own-damage part does (multiCompany/common/reliance/relianceOdSteps.js):
//   1. the "TP Details" box that opens after Skip To Main Page: Yes (existing third party policy), No (not held with RGICL),
//      Proceed — each answer is a real click, and each step waits for the NEXT thing to appear (the Yes and No radios are
//      not one browser radio group, so a click "taking" can only be seen by what the page shows next);
//   2. the cover table reader (the Nil Depreciation stop it once served was removed 2026-10-23: the OD run goes on to the end;
//      the existing TP policy and the steps after it are in test/relianceOdExistingTp.test.js).
// Fake pages and a fake clock: no browser, no network, nothing really waits.
const test = require("node:test");
const assert = require("node:assert/strict");

const steps = require("../multiCompany/common/reliance/relianceOdSteps");
const { isAutomationStop, stoppedResult } = require("../automationStopper");

const silent = () => {};

/* ------------------------- a stand-in TP Details box with a fake clock ------------------------- */

/**
 * The box as the portal behaves (the owner's markup, 2026-10-23): hidden until it opens; "Yes" shows the RGICL question;
 * "No" shows Proceed; Proceed closes the box. The three controls exist in the page source the whole time.
 *
 * @param {Object} [o]
 * @param {number} [o.openAt=0]            ms (virtual) when the box opens
 * @param {Object} [o.ignore]              { yes: n, rgiclNo: n, proceed: n } — the first n clicks of that control do nothing
 * @param {Object} [o.realClickFails]      { yes: true, ... } — a real click is refused ("click intercepted"); a script click works
 * @param {Object} [o.neverReveals]        { yes: true, rgiclNo: true } — that answer never shows what comes next
 * @param {boolean} [o.proceedNeverCloses] Proceed is pressed but the box stays open
 * @param {boolean} [o.readThrowsOnce]     the first page read fails (a page that is reloading)
 */
function portal(o = {}) {
  let t = 0;
  const clicks = [];
  const s = { open: false, rgicl: false, proceed: false, closed: false, yesChecked: false, noChecked: false };
  const left = { yes: (o.ignore || {}).yes || 0, rgiclNo: (o.ignore || {}).rgiclNo || 0, proceed: (o.ignore || {}).proceed || 0 };
  let readFailed = false;

  const tick = () => {
    if (!s.open && t >= (o.openAt || 0)) s.open = true;
  };
  const effect = {
    yes() {
      s.yesChecked = true;
      if (!(o.neverReveals || {}).yes) s.rgicl = true;
    },
    rgiclNo() {
      s.noChecked = true;
      if (!(o.neverReveals || {}).rgiclNo) s.proceed = true;
    },
    proceed() {
      if (!o.proceedNeverCloses) s.closed = true;
    },
  };
  const visible = {
    yes: () => s.open && !s.closed,
    rgiclNo: () => s.open && s.rgicl && !s.closed,
    proceed: () => s.open && s.proceed && !s.closed,
  };
  const press = (name, how) => {
    clicks.push({ name, how, at: t, wasVisible: visible[name]() });
    if (left[name] > 0) {
      left[name] -= 1;
      return;
    }
    if (visible[name]()) effect[name]();
  };
  const element = (name) => ({
    name,
    async click() {
      if ((o.realClickFails || {})[name]) throw new Error("element click intercepted");
      press(name, "real");
    },
    scriptClick() {
      press(name, "script");
    },
  });
  const elements = { yes: element("yes"), rgiclNo: element("rgiclNo"), proceed: element("proceed") };
  const snapshot = () => ({
    yes: { exists: true, shown: visible.yes(), enabled: true, checked: s.yesChecked },
    rgiclNo: { exists: true, shown: visible.rgiclNo(), enabled: true, checked: s.noChecked },
    proceed: { exists: true, shown: visible.proceed(), enabled: true, checked: false },
  });

  const driver = {
    async executeScript(script, ...args) {
      tick();
      if (typeof script === "function") {
        assert.equal(script, steps.readTpDetailsInPage, "only the page reader runs as a function");
        if (o.readThrowsOnce && !readFailed) {
          readFailed = true;
          throw new Error("javascript error: document unloaded");
        }
        return args[0] ? elements[args[0]] : snapshot();
      }
      if (/scrollIntoView/.test(script)) return null;
      if (/arguments\[0\]\.click\(\)/.test(script)) {
        args[0].scriptClick();
        return null;
      }
      throw new Error(`unexpected script: ${script}`);
    },
  };
  const opts = {
    log: silent,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      tick();
    },
  };
  return { driver, opts, clicks, state: s, time: () => t };
}

const oneColon = (message) => message.split(":").length - 1 === 1;

/* ------------------------- the TP Details box ------------------------- */

test("TP Details: Yes, then No, then Proceed — each ONE real click, in that order, each only once the control is on screen", async () => {
  const p = portal();
  await steps.answerTpDetailsDialog(p.driver, p.opts);
  assert.deepEqual(
    p.clicks.map((c) => [c.name, c.how, c.wasVisible]),
    [
      ["yes", "real", true],
      ["rgiclNo", "real", true],
      ["proceed", "real", true],
    ]
  );
  assert.equal(p.state.closed, true, "the box is closed at the end");
  assert.equal(p.state.yesChecked && p.state.noChecked, true);
});

test("TP Details: the loader is waited for after Proceed, and only then does the step end", async () => {
  const p = portal();
  const order = [];
  await steps.answerTpDetailsDialog(p.driver, {
    ...p.opts,
    log: (line) => order.push(line),
    waitLoader: async () => order.push(p.state.closed ? "loader (box closed)" : "loader (box STILL OPEN)"),
  });
  assert.ok(order.includes("loader (box closed)"), "the loader wait runs after the box closed");
  assert.match(order[order.length - 1], /TP Details answered/);
  assert.ok(order.indexOf("loader (box closed)") < order.length - 1, "the final line comes after the loader wait");
});

test("TP Details: a slow portal is waited for — the box opening 9 s late is no reason to fail", async () => {
  const p = portal({ openAt: 9000 });
  await steps.answerTpDetailsDialog(p.driver, p.opts);
  assert.equal(p.clicks.length, 3);
  assert.ok(p.clicks[0].at >= 9000, "nothing was clicked before the box was there");
});

test("TP Details: the box never opens -> a clear error after 20 s and NOTHING is clicked", async () => {
  const p = portal({ openAt: 10 * 60 * 1000 });
  await assert.rejects(
    () => steps.answerTpDetailsDialog(p.driver, p.opts),
    (e) => {
      assert.match(e.message, /^Reliance OD: the TP Details box did not open within 20 seconds after Skip To Main Page/);
      assert.ok(oneColon(e.message), "one colon only: beautifyError keeps the text after the last one");
      assert.equal(isAutomationStop(e), false, "a failure, not a deliberate stop: the queue may retry it");
      return true;
    }
  );
  assert.deepEqual(p.clicks, []);
  assert.ok(p.time() >= 20000 && p.time() < 22000, `waited about 20 s, not forever (${p.time()} ms)`);
});

test("TP Details: a Yes that did nothing is answered again ONCE with a script click, and the run goes on", async () => {
  const p = portal({ ignore: { yes: 1 } });
  const lines = [];
  await steps.answerTpDetailsDialog(p.driver, { ...p.opts, log: (l) => lines.push(l) });
  assert.deepEqual(p.clicks.slice(0, 2).map((c) => [c.name, c.how]), [["yes", "real"], ["yes", "script"]]);
  assert.equal(p.clicks.filter((c) => c.name === "yes").length, 2, "never more than the second try");
  assert.equal(p.state.closed, true);
  assert.ok(lines.some((l) => /did not show after .*Yes.* within 4s, answering again with a script click/.test(l)), "the retry is logged");
});

test("TP Details: Yes never shows the RGICL question -> error naming the question, after the second try", async () => {
  const p = portal({ neverReveals: { yes: true } });
  await assert.rejects(
    () => steps.answerTpDetailsDialog(p.driver, p.opts),
    (e) => {
      assert.match(e.message, /after Yes to Existing Third Party \/ Liability Policy Available, Reliance did not show the question whether the Third Party Policy is held With RGICL within 12 seconds/);
      assert.ok(oneColon(e.message));
      return true;
    }
  );
  assert.deepEqual(p.clicks.map((c) => [c.name, c.how]), [["yes", "real"], ["yes", "script"]], "No / Proceed were never touched");
});

test("TP Details: No never shows Proceed -> error naming the Proceed button; Proceed is never pressed", async () => {
  const p = portal({ neverReveals: { rgiclNo: true } });
  await assert.rejects(
    () => steps.answerTpDetailsDialog(p.driver, p.opts),
    (e) => {
      assert.match(e.message, /after No to Third Party Policy held With RGICL, Reliance did not show the Proceed button within 12 seconds/);
      assert.ok(oneColon(e.message));
      return true;
    }
  );
  assert.equal(p.clicks.filter((c) => c.name === "proceed").length, 0);
});

test("TP Details: Proceed is pressed exactly ONCE, even when the box does not go away — that is the answer, not a reason to press again", async () => {
  const p = portal({ proceedNeverCloses: true });
  await assert.rejects(
    () => steps.answerTpDetailsDialog(p.driver, p.opts),
    (e) => {
      assert.match(e.message, /the TP Details box was still open 20 seconds after Proceed/);
      assert.ok(oneColon(e.message));
      return true;
    }
  );
  assert.equal(p.clicks.filter((c) => c.name === "proceed").length, 1);
});

test("TP Details: a real click the browser refuses falls back to a script click — one effect, not two", async () => {
  const p = portal({ realClickFails: { yes: true, rgiclNo: true, proceed: true } });
  await steps.answerTpDetailsDialog(p.driver, p.opts);
  assert.deepEqual(p.clicks.map((c) => [c.name, c.how]), [["yes", "script"], ["rgiclNo", "script"], ["proceed", "script"]]);
  assert.equal(p.state.closed, true);
});

test("TP Details: a page read that fails while the page reloads is tolerated, not an error", async () => {
  const p = portal({ readThrowsOnce: true });
  await steps.answerTpDetailsDialog(p.driver, p.opts);
  assert.equal(p.state.closed, true);
});

test("TP Details: a control that is in the page source but hidden is never clicked early", async () => {
  // the No radio exists from the start (hidden); it must not be pressed before Yes has shown it
  const p = portal();
  await steps.answerTpDetailsDialog(p.driver, p.opts);
  const firstNo = p.clicks.findIndex((c) => c.name === "rgiclNo");
  const firstYes = p.clicks.findIndex((c) => c.name === "yes");
  assert.ok(firstYes >= 0 && firstNo > firstYes);
  assert.ok(p.clicks.every((c) => c.wasVisible), "every click landed on a control that was on screen");
});

test("TP Details: the control vanishing between the read and the click is an error with a plain sentence", async () => {
  const p = portal();
  const real = p.driver.executeScript.bind(p.driver);
  p.driver.executeScript = async (script, ...args) => (typeof script === "function" && args[0] === "yes" ? null : real(script, ...args));
  await assert.rejects(
    () => steps.answerTpDetailsDialog(p.driver, p.opts),
    (e) => {
      assert.match(e.message, /^Reliance OD: the TP Details box lost its Yes answer while it was being answered/);
      assert.ok(oneColon(e.message));
      assert.equal(e.message.includes("rgiclNo"), false, "no internal names in an operator sentence");
      return true;
    }
  );
});

/* ------------------------- the page function itself ------------------------- */

/** Run readTpDetailsInPage against a stand-in document (the real one runs in the browser). */
function inStandInPage(controls, fn) {
  const element = (c) =>
    c && {
      disabled: !!c.disabled,
      checked: !!c.checked,
      getBoundingClientRect: () => (c.shown ? { width: 20, height: 20 } : { width: 0, height: 0 }),
      _style: c.style || { display: c.shown ? "block" : "none", visibility: "visible" },
    };
  const els = {
    rbIsExistingPolicyLiabilityYes: element(controls.yes),
    rbIsRGICLNo: element(controls.rgiclNo),
    btnISNotRGICLPolicy: element(controls.proceed),
  };
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { getElementById: (id) => els[id] || null };
  globalThis.window = { getComputedStyle: (el) => el._style };
  try {
    return fn(els);
  } finally {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  }
}

test("page reader: finds the three controls by the portal's own ids and tells on screen from merely present", () => {
  const snap = inStandInPage({ yes: { shown: true, checked: true }, rgiclNo: { shown: false }, proceed: null }, () => steps.readTpDetailsInPage());
  assert.deepEqual(snap.yes, { exists: true, shown: true, enabled: true, checked: true });
  assert.deepEqual(snap.rgiclNo, { exists: true, shown: false, enabled: true, checked: false });
  assert.deepEqual(snap.proceed, { exists: false, shown: false, enabled: false, checked: false });
  assert.deepEqual(steps.TP_DETAILS_IDS, {
    yes: "rbIsExistingPolicyLiabilityYes",
    rgiclNo: "rbIsRGICLNo",
    proceed: "btnISNotRGICLPolicy",
  });
});

test("page reader: display:none and visibility:hidden count as NOT on screen even when the element has a size", () => {
  const hidden = { shown: true, style: { display: "none", visibility: "visible" } };
  const invisible = { shown: true, style: { display: "block", visibility: "hidden" } };
  const snap = inStandInPage({ yes: hidden, rgiclNo: invisible, proceed: { shown: true } }, () => steps.readTpDetailsInPage());
  assert.equal(snap.yes.shown, false);
  assert.equal(snap.rgiclNo.shown, false);
  assert.equal(snap.proceed.shown, true);
});

test("page reader: asked for one control it returns that element (to click), or null when it is not there", () => {
  inStandInPage({ yes: { shown: true }, rgiclNo: null, proceed: { shown: true, disabled: true } }, (els) => {
    assert.equal(steps.readTpDetailsInPage("yes"), els.rbIsExistingPolicyLiabilityYes);
    assert.equal(steps.readTpDetailsInPage("rgiclNo"), null);
    assert.equal(steps.readTpDetailsInPage("proceed"), els.btnISNotRGICLPolicy);
    assert.equal(steps.readTpDetailsInPage().proceed.enabled, false, "a disabled Proceed is not 'enabled'");
  });
});

/* ------------------------- what the cover table shows (read by requireCoverTable) ------------------------- */

test("cover page reader: reads the Helmet (ChkBox500), Zero Depreciation (ChkBox10), its rate and the PA box (ChkBox24) by the portal's ids", () => {
  const els = (map) => ({ getElementById: (id) => map[id] || null });
  const saved = globalThis.document;
  try {
    globalThis.document = els({ ChkBox500: { checked: false }, ChkBox10: { checked: true }, txtNilDepriciationRate: { value: " 0.615 " } });
    assert.deepEqual(steps.readCoverSummaryInPage(), {
      helmet: { exists: true, checked: false },
      zeroDep: { exists: true, checked: true },
      pa: { exists: false, checked: false },
      nilDepRate: "0.615",
    });
    globalThis.document = els({ ChkBox24: { checked: true } });
    const none = steps.readCoverSummaryInPage();
    assert.deepEqual(none.helmet, { exists: false, checked: false });
    assert.deepEqual(none.pa, { exists: true, checked: true });
    assert.equal(none.nilDepRate, null, "no rate box = null, not an empty string");
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
});

test("the driver's own error text never reaches the operator's sentence (beautifyError would swallow the whole sentence)", async () => {
  // every read of the page fails with a Selenium-style message: the box "never opens" and the sentence must still be ours
  const p = portal();
  p.driver.executeScript = async () => {
    throw new Error("Wait timed out after 15000ms: javascript error: document unloaded");
  };
  await assert.rejects(
    () => steps.answerTpDetailsDialog(p.driver, p.opts),
    (e) => {
      assert.match(e.message, /^Reliance OD: the TP Details box did not open within 20 seconds/);
      assert.equal(/Wait timed out|document unloaded/.test(e.message), false);
      assert.ok(oneColon(e.message));
      const { beautifyError } = require("../lib/errorHandler");
      assert.match(beautifyError(e), /^The TP Details box did not open within 20 seconds after Skip To Main Page/, "the operator still gets our sentence (after the label)");
      return true;
    }
  );
});
