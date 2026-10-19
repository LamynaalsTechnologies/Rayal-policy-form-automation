// Run with: node --test test/relianceCoverSettle.test.js
//
// Reliance answers "Get Coverage Details" several times (the flow fires it four ways), in any order, and EVERY answer
// redraws the cover table and re-ticks PA to Owner Driver. relianceCoverSettle.js waits for the last answer and
// checks PA is really off. These tests run it against a stand-in portal that behaves the way the real page's own
// scripts do (ShowHideDivs re-ticks the box and opens the "valid Driving License?" question, OnNo() unticks it, a
// late FetchIDV answer ticks it again), with a fake clock. No browser, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const settle = require("../fullPolicycompany/reliance/relianceCoverSettle");
const { beautifyError } = require("../lib/errorHandler");

/** Run fn with RELIANCE_COVER_SETTLE_ENABLED set (undefined = absent), then put it back. */
function withSwitch(value, fn) {
  const before = process.env.RELIANCE_COVER_SETTLE_ENABLED;
  if (value === undefined) delete process.env.RELIANCE_COVER_SETTLE_ENABLED;
  else process.env.RELIANCE_COVER_SETTLE_ENABLED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.RELIANCE_COVER_SETTLE_ENABLED;
    else process.env.RELIANCE_COVER_SETTLE_ENABLED = before;
  }
}

/* ------------------------- a stand-in portal with a fake clock ------------------------- */

/**
 * @param {Object} o
 * @param {boolean} [o.paExists=true]
 * @param {boolean} [o.paChecked=true]     PA to Owner Driver ticked (the portal's default for an Individual client)
 * @param {Array}   [o.events=[]]          [{ at, run(page) }] — things that happen at a point in time (a late answer)
 * @param {boolean} [o.modalWorks=true]    clicking the PA box opens the "valid Driving License?" question
 */
function portal({ paExists = true, paChecked = true, events = [], modalWorks = true } = {}) {
  const page = {
    t: 0,
    paExists,
    paChecked,
    modalOpen: false,
    inflight: 0,
    mask: false,
    jquery: true,
    unreadable: false,
    clicks: { pa: 0, no: 0 },
    clickTimes: [],
    reads: 0,
  };
  const pending = [...events].sort((a, b) => a.at - b.at);
  const tick = () => {
    while (pending.length && pending[0].at <= page.t) pending.shift().run(page);
  };

  const driver = {
    async executeScript(fn) {
      tick();
      if (page.unreadable) throw new Error("page is navigating");
      if (fn === settle.readPortalActivityInPage) {
        page.reads++;
        return { active: page.jquery ? page.inflight : null, loading: page.mask };
      }
      if (fn === settle.readOwnerDriverPaInPage) return { exists: page.paExists, checked: page.paChecked };
      if (fn === settle.clickOwnerDriverPaInPage) {
        page.clicks.pa++;
        page.clickTimes.push(page.t);
        if (!page.paExists) return { exists: false };
        // the portal's ShowHideDivs: the box was ticked -> the click unticks it -> the handler re-ticks it and
        // opens the "Does the Owner have a valid Driving License?" question
        if (modalWorks) {
          page.paChecked = true;
          page.modalOpen = true;
        } else {
          page.paChecked = !page.paChecked;
        }
        return { exists: true };
      }
      if (fn === settle.answerNoToLicenseInPage) {
        if (!page.modalOpen) return { found: false };
        page.clicks.no++;
        page.paChecked = false; // the portal's OnNo()
        page.modalOpen = false;
        return { found: true };
      }
      throw new Error("unexpected script");
    },
    async sleep(ms) {
      page.t += ms;
      tick();
    },
  };
  const clock = { now: () => page.t, sleep: (ms) => driver.sleep(ms) };
  return { page, driver, clock };
}

const quiet = () => {};

/* ------------------------- waiting for the portal to go quiet ------------------------- */

test("idle: nothing in flight -> done after the stable window, not before", async () => {
  const { page, driver, clock } = portal();
  const r = await settle.waitForPortalIdle(driver, clock);
  assert.equal(r.state, "idle");
  assert.equal(page.t, 1500, "the stable window replaces the old blind 1.5 s sleep");
});

test("idle: requests in flight are waited for, however late the last answer lands", async () => {
  // four FetchIDV answers at 1.3, 1.8, 2.9 and 6.5 s: the slow one is the one that used to land after the clicks
  const { page, driver, clock } = portal({
    events: [
      { at: 0, run: (p) => (p.inflight = 4) },
      { at: 1300, run: (p) => p.inflight-- },
      { at: 1800, run: (p) => p.inflight-- },
      { at: 2900, run: (p) => p.inflight-- },
      { at: 6500, run: (p) => p.inflight-- },
    ],
  });
  const r = await settle.waitForPortalIdle(driver, clock);
  assert.equal(r.state, "idle");
  assert.ok(page.t >= 6500 + 1500, `must wait past the last answer plus the stable window (was ${page.t})`);
  assert.equal(page.inflight, 0);
});

test("idle: a gap between chained requests is not 'done' — the stable window bridges it", async () => {
  // validation call ends at 1000, the FetchIDV it gates starts 250 ms later (what the real page does)
  const { page, driver, clock } = portal({
    events: [
      { at: 0, run: (p) => (p.inflight = 1) },
      { at: 1000, run: (p) => (p.inflight = 0) },
      { at: 1250, run: (p) => (p.inflight = 1) },
      { at: 4000, run: (p) => (p.inflight = 0) },
    ],
  });
  const r = await settle.waitForPortalIdle(driver, clock);
  assert.equal(r.state, "idle");
  assert.ok(page.t >= 4000 + 1500, `the 250 ms gap must not end the wait (finished at ${page.t})`);
});

test("idle: a visible loading mask counts as busy; a page without jQuery is judged by the mask alone", async () => {
  const a = portal({
    events: [
      { at: 0, run: (p) => (p.mask = true) },
      { at: 2000, run: (p) => (p.mask = false) },
    ],
  });
  assert.equal((await settle.waitForPortalIdle(a.driver, a.clock)).state, "idle");
  assert.ok(a.page.t >= 2000 + 1500);

  const b = portal();
  b.page.jquery = false; // active reads null
  assert.equal((await settle.waitForPortalIdle(b.driver, b.clock)).state, "idle");
  assert.equal(b.page.t, 1500);
});

test("idle: a portal that never settles -> timeout (the caller carries on), never a throw", async () => {
  const stuck = portal({ events: [{ at: 0, run: (p) => (p.inflight = 1) }] });
  const r = await settle.waitForPortalIdle(stuck.driver, { ...stuck.clock, timeoutMs: 5000 });
  assert.equal(r.state, "timeout");
  assert.ok(r.waitedMs >= 5000);

  const unreadable = portal();
  unreadable.page.unreadable = true;
  const u = await settle.waitForPortalIdle(unreadable.driver, { ...unreadable.clock, timeoutMs: 3000 });
  assert.equal(u.state, "timeout", "a page that cannot be read is never taken as quiet");
});

/* ------------------------- making sure PA to Owner Driver is off ------------------------- */

test("PA already off: nothing is clicked", async () => {
  const { page, driver, clock } = portal({ paChecked: false });
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, log: quiet });
  assert.deepEqual({ ok: r.ok, redone: r.redone }, { ok: true, redone: 0 });
  assert.deepEqual(page.clicks, { pa: 0, no: 0 });
});

test("no PA box on the page: nothing to do", async () => {
  const { page, driver, clock } = portal({ paExists: false });
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, log: quiet });
  assert.equal(r.ok, true);
  assert.deepEqual(page.clicks, { pa: 0, no: 0 });
});

test("PA ticked: the portal's own opt-out is done (click the box, answer NO) and PA ends off", async () => {
  const { page, driver, clock } = portal();
  const logs = [];
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, log: (l) => logs.push(l) });
  assert.deepEqual({ ok: r.ok, redone: r.redone, attempts: r.attempts }, { ok: true, redone: 1, attempts: 1 });
  assert.deepEqual(page.clicks, { pa: 1, no: 1 });
  assert.equal(page.paChecked, false);
  assert.ok(logs.some((l) => /switching it off again/.test(l)));
});

test("a late answer from Reliance re-ticks PA right after the opt-out: it is done again", async () => {
  // the opt-out at ~t=1.0-2.5 s; a slow FetchIDV answer lands at t=3.5 s and ticks PA again (the 2026-10-14 failure)
  const { page, driver, clock } = portal({
    events: [
      { at: 0, run: (p) => (p.inflight = 1) },
      { at: 3500, run: (p) => ((p.inflight = 0), (p.paChecked = true), (p.modalOpen = false)) },
    ],
  });
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(page.paChecked, false, "PA is off at the end, whatever landed in between");
  assert.ok(page.t >= 3500, "it waited for the in-flight answer before reading the final state");
  assert.ok(
    page.clickTimes[0] >= 3500,
    `the first opt-out must wait for the in-flight answer (clicked at ${page.clickTimes[0]} ms) — an opt-out done ` +
      `before it lands is undone by it`
  );
  assert.equal(page.clicks.pa, 1, "one opt-out is enough once the answer has landed");
});

test("Reliance keeps re-ticking it -> gives up after the attempts, and says so", async () => {
  // PA is re-ticked after every opt-out (an answer lands after each one)
  const events = [];
  for (let t = 1000; t < 60000; t += 900) events.push({ at: t, run: (p) => ((p.paChecked = true), (p.modalOpen = false)) });
  const { page, driver, clock } = portal({ events });
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, attempts: 3, log: quiet });
  assert.equal(r.ok, false);
  assert.equal(r.checked, true);
  assert.equal(r.redone, 3);
  assert.equal(page.clicks.pa, 3);
});

test("the 'valid Driving License?' question never opens -> not 'off', after the attempts", async () => {
  const { page, driver, clock } = portal({ modalWorks: false });
  // with modalWorks=false the click just toggles PA: ticked -> unticked, so the FIRST attempt already succeeds
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, log: quiet });
  assert.equal(r.ok, true);

  // a page where the click does nothing at all
  const dead = portal();
  dead.driver.executeScript = async (fn) => {
    if (fn === settle.readPortalActivityInPage) return { active: 0, loading: false };
    if (fn === settle.readOwnerDriverPaInPage) return { exists: true, checked: true };
    if (fn === settle.clickOwnerDriverPaInPage) return { exists: true };
    if (fn === settle.answerNoToLicenseInPage) return { found: false };
    throw new Error("unexpected");
  };
  const logs = [];
  const r2 = await settle.ensureOwnerDriverPaOff(dead.driver, { ...dead.clock, attempts: 2, log: (l) => logs.push(l) });
  assert.equal(r2.ok, false);
  assert.equal(logs.filter((l) => /question did not appear/.test(l)).length, 2);
});

test("a page that errors while it re-draws does not break the opt-out", async () => {
  const { driver, clock, page } = portal();
  let n = 0;
  const real = driver.executeScript.bind(driver);
  driver.executeScript = async (fn) => {
    // the first two attempts to answer the question hit a page that is mid-redraw
    if (fn === settle.answerNoToLicenseInPage && n++ < 2) throw new Error("stale element");
    return real(fn);
  };
  const r = await settle.ensureOwnerDriverPaOff(driver, { ...clock, log: quiet });
  assert.equal(r.ok, true);
  assert.equal(page.paChecked, false);
});

/* ------------------------- the sentence, and the switch ------------------------- */

test("the 'PA still on' message is plain words, with no colon, and survives beautifyError unchopped", () => {
  const message = settle.ownerDriverPaStillOnMessage({ attempts: 3 });
  assert.match(message, /PA to Owner Driver is still ticked/);
  assert.match(message, /switched off 3 times/);
  assert.match(message, /Run the policy again/);
  assert.ok(!message.includes(":"));
  assert.equal(beautifyError(message, "Reliance"), `[Reliance] ${message}`);
});

test("the switch is ON unless explicitly false / 0 / no / off", () => {
  withSwitch(undefined, () => assert.equal(settle.isCoverSettleEnabled(), true));
  for (const on of ["true", "1", "yes", "on", "", "anything"]) {
    withSwitch(on, () => assert.equal(settle.isCoverSettleEnabled(), true, `"${on}" keeps it on`));
  }
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    withSwitch(off, () => assert.equal(settle.isCoverSettleEnabled(), false, `"${off}" turns it off`));
  }
});

/* ------------------------- the in-page functions, against a stub DOM ------------------------- */

function inPage(byId, fn, { masks = [], jquery } = {}) {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (sel === ".k-loading-mask" ? masks : []),
  };
  globalThis.window = {
    jQuery: jquery,
    getComputedStyle: (el) => el.style || { display: "block", visibility: "visible" },
  };
  try {
    return fn();
  } finally {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  }
}
const mask = (shown) => ({
  getBoundingClientRect: () => ({ width: shown ? 100 : 0, height: shown ? 50 : 0 }),
  style: { display: shown ? "block" : "none", visibility: "visible" },
});

test("in page: reads jQuery.active and a visible loading mask", () => {
  assert.deepEqual(inPage({}, settle.readPortalActivityInPage, { jquery: { active: 3 } }), { active: 3, loading: false });
  assert.deepEqual(inPage({}, settle.readPortalActivityInPage, { jquery: { active: 0 }, masks: [mask(false)] }), {
    active: 0,
    loading: false,
  });
  assert.deepEqual(inPage({}, settle.readPortalActivityInPage, { jquery: { active: 0 }, masks: [mask(false), mask(true)] }), {
    active: 0,
    loading: true,
  });
  assert.deepEqual(inPage({}, settle.readPortalActivityInPage, {}), { active: null, loading: false }, "no jQuery");
});

test("in page: the PA box is read, clicked, and the NO answer is clicked", () => {
  const pa = { checked: true, clicked: 0, click() { this.clicked++; } };
  const no = { clicked: 0, click() { this.clicked++; } };
  assert.deepEqual(inPage({ ChkBox24: pa }, settle.readOwnerDriverPaInPage), { exists: true, checked: true });
  assert.deepEqual(inPage({}, settle.readOwnerDriverPaInPage), { exists: false, checked: false });
  assert.deepEqual(inPage({ ChkBox24: pa }, settle.clickOwnerDriverPaInPage), { exists: true });
  assert.equal(pa.clicked, 1);
  assert.deepEqual(inPage({}, settle.clickOwnerDriverPaInPage), { exists: false });
  assert.deepEqual(inPage({ OnNoofDL: no }, settle.answerNoToLicenseInPage), { found: true });
  assert.equal(no.clicked, 1);
  assert.deepEqual(inPage({}, settle.answerNoToLicenseInPage), { found: false });
});

/* ------------------------- relianceForm.js uses it in the right places ------------------------- */

const formSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
const at = (needle, from = 0) => {
  const i = formSrc.indexOf(needle, from);
  assert.ok(i >= 0, `missing in relianceForm.js: ${needle}`);
  return i;
};

test("relianceForm.js: the idle wait comes after the four Get Coverage Details clicks and replaces the blind sleep", () => {
  const clicked = at("Clicked 'Get Coverage Details' button with multiple methods");
  const loader = at("await waitForLoaderToDisappear(driver);", clicked);
  const gate = at("if (isCoverSettleEnabled()) {", loader);
  const idle = at("await waitForPortalIdle(driver);", gate);
  const old = at("await driver.sleep(1500);", idle); // the switch-off branch keeps the old sleep
  const refusal = at("if (isCoverDetailsCheckEnabled()) {", old);
  const paLookup = at('until.elementLocated(By.id("ChkBox24"))', refusal);
  assert.ok(clicked < loader && loader < gate && gate < idle && idle < old && old < refusal && refusal < paLookup);
  // the old sleep sits in the else branch, not on the normal path
  assert.match(formSrc.slice(idle, old), /\}\s*else\s*\{\s*$/);
});

test("relianceForm.js: PA is verified after the opt-out and again right before Calculate Premium, never when PA is wanted", () => {
  const optOutNo = at("Clicked 'No' checkbox in PA to Owner Driver modal");
  const first = at("const paOff = await ensureOwnerDriverPaOff(driver);", optOutNo);
  const helmet = at('console.log("Unchecking Helmet Cover checkbox...");', first);
  assert.ok(optOutNo < first && first < helmet, "right after the opt-out, before the Helmet / TPPD / Zero Dep clicks");

  const second = at("const paOff = await ensureOwnerDriverPaOff(driver);", helmet);
  const calculate = at("Clicking 'Calculate Premium' button...", second);
  assert.ok(second < calculate, "and once more just before the premium is calculated");

  // both are behind `!isCompanyPA` (PA wanted -> the old path, untouched) and the switch, and both stop the policy
  for (const call of [first, second]) {
    const before = formSrc.slice(Math.max(0, call - 120), call);
    assert.match(before, /if \(!isCompanyPA && isCoverSettleEnabled\(\)\) \{\s*$/);
    const after = formSrc.slice(call, call + 220);
    assert.match(after, /if \(!paOff\.ok\) throw new Error\(ownerDriverPaStillOnMessage\(paOff\)\);/);
  }
  assert.equal(formSrc.split("ensureOwnerDriverPaOff(driver)").length - 1, 2, "exactly the two calls");
});
