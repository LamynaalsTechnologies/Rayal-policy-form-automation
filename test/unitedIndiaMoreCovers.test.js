// United India "More Covers N Info" (the owner, 2026-11-13): clicked, the next page waited for up to 20 s (else an error);
// clicked a second time ONLY when the page shows no sign of leaving; then the TPPD Limit by the policy's TPPD Restrict
// (ticked = Upto 6000, the rule Reliance and KSHEMA follow - the owner's pick). A fake portal; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaMoreCovers.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const more = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaMoreCovers");
const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");

const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));

/**
 * The Risk Details page (doc 1) with the More Covers N Info button; a click submits it and the next page (doc 2) arrives
 * after `navPolls` page reads.
 *   ignoreClicks: clicks the page swallows (nothing starts)
 *   slowSubmit: the submit is on its way (the page is leaving) but the next page only comes after this many reads
 *   busyNoLeave: the portal's loader is up after the click, the page not (yet) leaving, and nothing arrives
 *   never: the submit starts but the next page never arrives
 *   alertOnClick / newWindow / noButton / tppdShows / noTppd
 *   clickWaits: the click submits, and ChromeDriver's click (waiting for that page, 2 s limit) comes back as a timeout
 *   clickCovered: the first real click does not land (something covers the button)
 *   hungQuiet: the submit hangs, the page never says it is leaving, and the first question meets the pending page
 *   arrivesAfterMs (+ clock): the next page comes this long after the click, and meanwhile it acts like ChromeDriver (proved in a
 *     real Chrome, 2026-11-13): every look is HELD until the page arrives or the page-load limit runs out - and when the limit
 *     runs out first the page is CANCELLED (it never comes) and the look is a TimeoutError
 */
function portal(over = {}) {
  const state = {
    doc: 1,
    mark: null,
    leaving: false,
    clicks: 0,
    navigateIn: null,
    busy: false,
    handles: ["main"],
    current: "main",
    alerts: [],
    ignore: over.ignoreClicks || 0,
    tppd: { options: opts([["100000", "Upto 100000"], ["6000", "Upto 6000"]]), selectedIndex: over.tppdShows === "6000" ? 1 : 0, changes: 0 },
    limits: [], // ChromeDriver's page-load limit, each time it is set
    pageLoad: 300000,
    stopped: false,
    pendingUntil: null,
    cancelled: false,
  };
  const clockOf = over.clock || null;
  // ChromeDriver with a page on its way: the look waits for it, up to the page-load limit; past the limit the page is cancelled
  const held = () => {
    if (state.pendingUntil === null) return;
    const left = state.pendingUntil - clockOf.now();
    if (left <= state.pageLoad) {
      clockOf.advance(Math.max(0, left));
      state.pendingUntil = null;
      state.doc = 2;
      state.mark = null;
      state.leaving = false;
      return;
    }
    clockOf.advance(state.pageLoad);
    state.pendingUntil = null;
    state.cancelled = true; // the portal's answer is thrown away: the old page stays
    throw timeout();
  };
  const timeout = () => Object.assign(new Error("timeout: Timed out receiving message from renderer: 2.000"), { name: "TimeoutError" });
  state.jsClicks = 0;
  state.pollTimeouts = over.hungQuiet ? 1 : 0;
  const img = {
    async isDisplayed() {
      return state.doc === 1 && !over.noButton;
    },
    async click() {
      if (over.clickCovered && state.clicks === 0 && state.jsClicks === 0) {
        throw Object.assign(new Error("element click intercepted: Other element would receive the click"), { name: "ElementClickInterceptedError" });
      }
      await img.submit();
      if (over.clickWaits) throw timeout();
    },
    async submit() {
      state.clicks += 1;
      if (over.hungQuiet) {
        state.navigateIn = Infinity; // on its way, but the page never says it is leaving
        return;
      }
      if (state.ignore > 0) {
        state.ignore -= 1;
        return;
      }
      if (over.alertOnClick) {
        state.alerts.push(over.alertOnClick);
        return;
      }
      if (over.newWindow) {
        state.handles.push("w2");
        return;
      }
      if (over.busyNoLeave) {
        state.busy = true;
        return;
      }
      state.leaving = true;
      if (over.arrivesAfterMs) {
        state.pendingUntil = clockOf.now() + over.arrivesAfterMs;
        return;
      }
      state.navigateIn = over.never ? Infinity : over.slowSubmit || over.navPolls || 2;
    },
  };
  const tppdBox = {
    kind: "tppd",
    async isDisplayed() {
      return state.doc === 2 && !over.noTppd;
    },
    async click() {},
    async findElements() {
      return state.tppd.options.map((_, i) => ({
        async click() {
          state.tppd.selectedIndex = i;
          state.tppd.changes += 1;
        },
      }));
    },
  };
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      if (/MoreCoversNInfo|morecoversninfo/.test(v)) return state.doc === 1 && !over.noButton ? [img] : [];
      if (/tppdLimit/.test(v)) return over.noTppd ? [] : [tppdBox];
      return [];
    },
    async executeScript(script, ...args) {
      held();
      if (script === more.markPageInPage) {
        state.mark = args[0];
        return true;
      }
      if (script === more.pageStateInPage) {
        if (state.pollTimeouts > 0) {
          state.pollTimeouts -= 1;
          throw timeout(); // the 2 s page-load limit met the page on its way
        }
        if (state.navigateIn !== null) {
          state.navigateIn -= 1;
          if (state.navigateIn <= 0) {
            state.doc = 2; // the next page: no mark
            state.mark = null;
            state.leaving = false;
            state.navigateIn = null;
            return null; // the one read that lands mid-navigation
          }
        }
        return { marked: state.mark === args[0] && state.doc === 1, leaving: state.leaving, ready: "complete", url: state.doc === 2 ? "https://uiic/portal/MoreCovers.do" : "https://uiic/portal/gc_initiateAshokLeyland.do" };
      }
      // errorOnNext: the page the submit brings is United India's "Error In Data Entry" box
      if (script === more.portalErrorsInPage) return over.errorOnNext && state.doc === 2 ? over.errorOnNext : [];
      if (script === steps.readSelectElementInPage) {
        const s = state.tppd;
        return { selectedIndex: s.selectedIndex, value: s.options[s.selectedIndex].value, options: s.options };
      }
      if (script === steps.setSelectElementInPage) {
        state.tppd.selectedIndex = state.tppd.options.findIndex((o) => o.value === args[1]);
        state.tppd.changes += 1;
        return true;
      }
      if (typeof args[0] === "string" && args[0].includes("blockUI")) return state.busy; // the portal's loader
      const s = String(script);
      if (s === "arguments[0].click();") {
        state.jsClicks += 1;
        await img.submit();
        return null;
      }
      if (s === "window.stop();") {
        state.stopped = true;
        state.navigateIn = null;
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      return null;
    },
    async getAllWindowHandles() {
      return state.handles.slice();
    },
    manage() {
      return {
        getTimeouts: async () => ({ implicit: 0, pageLoad: state.pageLoad, script: 30000 }),
        setTimeouts: async (t) => {
          state.limits.push(t.pageLoad);
          state.pageLoad = t.pageLoad;
        },
      };
    },
    switchTo() {
      return {
        window: async (h) => {
          state.current = h;
          state.doc = 2;
        },
        alert: async () => {
          if (!state.alerts.length) throw new Error("no such alert");
          const text = state.alerts.shift();
          return { getText: async () => text, accept: async () => {} };
        },
      };
    },
    async getCurrentUrl() {
      return state.doc === 2 ? "https://uiic/portal/MoreCovers.do" : "https://uiic/portal/gc_initiateAshokLeyland.do";
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms), at: () => t, advance: (ms) => (t += ms) };
};
const open = (driver, c = clock()) => {
  const lines = [];
  return { lines, c, go: () => more.openMoreCovers(driver, { ...c, log: (l) => lines.push(String(l)) }) };
};

test("clicked ONCE; the page without the Risk Details' mark, loaded, is the next page", async () => {
  const driver = portal();
  const { lines, go } = open(driver);
  const out = await go();
  assert.deepEqual(out, { url: "https://uiic/portal/MoreCovers.do", clicks: 1 });
  assert.equal(driver.state.clicks, 1);
  assert.ok(lines.some((l) => /✅ United India - the page after "More Covers N Info" is open \(https:\/\/uiic\/portal\/MoreCovers\.do\)/.test(l)));
});

test("a click the page swallowed (nothing started after 5 s): clicked ONE more time, then the page opens", async () => {
  const driver = portal({ ignoreClicks: 1 });
  const { lines, go } = open(driver);
  const out = await go();
  assert.equal(out.clicks, 2);
  assert.equal(driver.state.clicks, 2);
  assert.ok(lines.some((l) => /↻ United India - "More Covers N Info" was clicked but the page has not started to change after 5 seconds - clicking it once more/.test(l)));
});

test("a slow submit already on its way (the page is leaving): NEVER clicked again - it opens at 15 s", async () => {
  const driver = portal({ slowSubmit: 60 }); // 60 reads of 250 ms = 15 s
  const { go } = open(driver);
  const out = await go();
  assert.equal(out.clicks, 1);
  assert.equal(driver.state.clicks, 1, "a second click would submit the form twice");
});

test("the portal's loader is up (not leaving yet): not clicked again; nothing by 20 s = [E301], tried again later", async () => {
  const driver = portal({ busyNoLeave: true });
  const { c, go } = open(driver);
  await assert.rejects(go(), (e) => {
    assert.equal(e.code, "E301");
    assert.notEqual(e.retryable, false);
    assert.match(e.message, /after "More Covers N Info" was clicked the next page did not open within 20 seconds/);
    return true;
  });
  assert.equal(driver.state.clicks, 1);
  assert.ok(c.at() >= 20000 && c.at() < 21000, `waited ${c.at()} ms`);
});

test("a submit that never arrives: [E301] after 20 seconds, the button clicked once", async () => {
  const driver = portal({ never: true });
  await assert.rejects(open(driver).go(), (e) => e.code === "E301" && /within 20 seconds/.test(e.message));
  assert.equal(driver.state.clicks, 1);
});

test("the portal answers the click with a popup: [E308] in its words, not retried", async () => {
  const driver = portal({ alertOnClick: "Please select the RTO" });
  await assert.rejects(open(driver).go(), (e) => e.code === "E308" && e.retryable === false && /after "More Covers N Info" the portal said "Please select the RTO"/.test(e.message));
});

test("the next page in a NEW window: the run follows it", async () => {
  const driver = portal({ newWindow: true });
  const { lines, go } = open(driver);
  const out = await go();
  assert.equal(driver.state.current, "w2");
  assert.equal(out.url, "https://uiic/portal/MoreCovers.do");
  assert.ok(lines.some((l) => /the next page opened in a new window/.test(l)));
});

// the limits set while waiting: the whole 20 s for the click, then the time left before every look, then the run's own
const limitsOk = (limits) => limits[0] === 20000 && limits[limits.length - 1] === 300000 && limits.slice(1, -1).every((l) => l >= 500 && l <= 20000);

test("ChromeDriver's page-load limit while the next page is waited for = the TIME LEFT of the 20 s (never 2 s), then back to the run's own", async () => {
  const driver = portal();
  await open(driver).go();
  assert.ok(limitsOk(driver.state.limits), JSON.stringify(driver.state.limits));
  assert.equal(driver.state.stopped, false);
});

test("United India answers in 6 s (the owner's lag): the next page is WAITED for - never cancelled - clicked once", async () => {
  const c = clock();
  const driver = portal({ arrivesAfterMs: 6000, clock: c });
  const out = await open(driver, c).go();
  assert.equal(driver.state.cancelled, false, "a 2 s limit cancelled this page in a real Chrome - the owner's spinning loader");
  assert.equal(out.url, "https://uiic/portal/MoreCovers.do");
  assert.equal(out.clicks, 1);
  assert.equal(driver.state.clicks, 1, "one submit");
  assert.ok(c.at() >= 6000 && c.at() < 8000, `${c.at()} ms`);
});

test("United India answers in 19 s: still within the 20 s - waited for", async () => {
  const c = clock();
  const driver = portal({ arrivesAfterMs: 19000, clock: c });
  const out = await open(driver, c).go();
  assert.equal(driver.state.cancelled, false);
  assert.equal(out.clicks, 1);
});

test("an answer that misses the 20 s: cancelled AT 20 s (not before), [E301], clicked once", async () => {
  const c = clock();
  const driver = portal({ arrivesAfterMs: 30000, clock: c });
  await assert.rejects(open(driver, c).go(), (e) => e.code === "E301" && /within 20 seconds/.test(e.message));
  assert.equal(driver.state.cancelled, true);
  assert.equal(driver.state.clicks, 1);
  assert.ok(c.at() >= 20000 && c.at() < 21000, `${c.at()} ms`);
  assert.equal(driver.state.pageLoad, 300000, "the run's own limit is back");
});

test("a page that starts LATE (the first click swallowed, the second at 5 s; no answer): cancelled AT 20 s from the first click, not 25", async () => {
  const c = clock();
  const driver = portal({ ignoreClicks: 1, arrivesAfterMs: 60000, clock: c });
  await assert.rejects(open(driver, c).go(), (e) => e.code === "E301" && /within 20 seconds/.test(e.message));
  assert.equal(driver.state.cancelled, true);
  assert.equal(driver.state.clicks, 2);
  assert.ok(c.at() >= 20000 && c.at() <= 21000, `${c.at()} ms`);
});

test("a hung submit: window.stop() cancels it at 20 s (it cannot land later), the limit is put back, then [E301]", async () => {
  const driver = portal({ never: true });
  await assert.rejects(open(driver).go(), (e) => e.code === "E301");
  assert.equal(driver.state.stopped, true);
  assert.ok(limitsOk(driver.state.limits), JSON.stringify(driver.state.limits));
});

test("a popup on the click: the limit is put back too", async () => {
  const driver = portal({ alertOnClick: "Please select the RTO" });
  await assert.rejects(open(driver).go(), (e) => e.code === "E308");
  assert.equal(driver.state.limits[0], 20000);
  assert.equal(driver.state.pageLoad, 300000);
});

test("while a look is HELD by a page on its way, a line every 5 s says so (real timers; here every 40 ms)", async () => {
  const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");
  const said = [];
  const out = await nav.sayWhileHeld(new Promise((r) => setTimeout(() => r("the page"), 130)), 40, () => said.push("on its way"));
  assert.equal(out, "the page");
  assert.ok(said.length >= 2 && said.length <= 4, `${said.length} lines`);
  const quick = [];
  await nav.sayWhileHeld(Promise.resolve(1), 40, () => quick.push(1));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(quick.length, 0, "an answer at once: no line, and the timer is gone");
  assert.equal(nav.ON_ITS_WAY_LINE_MS, 5000);
});

test("ChromeDriver's click waits for the page it started and times out: that is a click that WORKED - never clicked again", async () => {
  const driver = portal({ clickWaits: true });
  const out = await open(driver).go();
  assert.equal(out.clicks, 1);
  assert.equal(driver.state.clicks, 1, "one submit");
  assert.equal(driver.state.jsClicks, 0, "no second click by script (the shared clickWithFallback did that - the form went twice)");
});

test("a click that did not land (the button covered): the page's own click() once, then the page opens", async () => {
  const driver = portal({ clickCovered: true });
  const out = await open(driver).go();
  assert.equal(driver.state.jsClicks, 1);
  assert.equal(driver.state.clicks, 1, "one submit");
  assert.equal(out.url, "https://uiic/portal/MoreCovers.do");
});

test("a page seen on its way (a question timed out on it) but never 'leaving': still NEVER clicked again, [E301] at 20 s", async () => {
  const driver = portal({ hungQuiet: true });
  await assert.rejects(open(driver).go(), (e) => e.code === "E301");
  assert.equal(driver.state.clicks, 1);
  assert.equal(driver.state.stopped, true);
});

test("the page after the submit is United India's Error In Data Entry box: [E306] in its words, not retried", async () => {
  const driver = portal({ errorOnNext: ["N002219, PolicyInception Date should be on or later to Proposal Date ."] });
  await assert.rejects(open(driver).go(), (e) => e.code === "E306" && e.retryable === false && /after "More Covers N Info" the portal says "Error In Data Entry - N002219, PolicyInception Date should be on or later to Proposal Date \."/.test(e.message));
  assert.equal(driver.state.clicks, 1);
});

test("no More Covers N Info button: [E301] naming it", async () => {
  const driver = portal({ noButton: true });
  await assert.rejects(open(driver).go(), (e) => e.code === "E301" && /"More Covers N Info" is not on the page/.test(e.message));
});

/* ------------------------------------------------ the TPPD Limit ------------------------------------------------ */

const tppd = async (driver, data) => {
  const lines = [];
  const out = await more.setTppdLimit(driver, data, { ...clock(), log: (l) => lines.push(String(l)) });
  return { out, lines };
};
const onMoreCovers = (over) => {
  const d = portal(over);
  d.state.doc = 2;
  return d;
};

test("TPPD Restrict ticked on the policy: Upto 6000", async () => {
  const driver = onMoreCovers();
  const { out, lines } = await tppd(driver, { tppdRestrict: true });
  assert.deepEqual(out, { tppdLimit: "6000", text: "Upto 6000", changed: true });
  assert.ok(lines.some((l) => /TPPD Restrict ticked on the policy: Upto 6000/.test(l)));
});

test("TPPD Restrict not ticked: Upto 100000, which the portal already shows - NOT touched", async () => {
  const driver = onMoreCovers();
  const { out, lines } = await tppd(driver, { tppdRestrict: false });
  assert.deepEqual(out, { tppdLimit: "100000", text: "Upto 100000", changed: false });
  assert.equal(driver.state.tppd.changes, 0);
  assert.ok(lines.some((l) => /TPPD Limit "Upto 100000" \(as the portal showed it, not touched\)/.test(l)));
});

test("not ticked but the portal shows 6000: set to 100000 (our premium was worked out for the full limit)", async () => {
  const driver = onMoreCovers({ tppdShows: "6000" });
  const { out } = await tppd(driver, {});
  assert.equal(out.tppdLimit, "100000");
  assert.equal(out.changed, true);
});

test("the tick as text ('true' / 'false') is read the same", () => {
  assert.equal(more.tppdFor({ tppdRestrict: "true" }), "6000");
  assert.equal(more.tppdFor({ tppdRestrict: "false" }), "100000");
  assert.equal(more.tppdFor({}), "100000");
});

test("no TPPD Limit box on the More Covers page: [E301] naming it", async () => {
  const driver = onMoreCovers({ noTppd: true });
  await assert.rejects(tppd(driver, { tppdRestrict: true }), (e) => e.code === "E301" && /"TPPD Limit" is not on the page/.test(e.message));
});

test("the owner's markup and wait", () => {
  assert.equal(more.MORE_COVERS[0], "img[src*='MoreCoversNInfo']");
  assert.equal(more.TPPD.target[0], "select[name='tppdLimit']");
  assert.equal(more.NAV_WAIT_MS, 20000);
});
