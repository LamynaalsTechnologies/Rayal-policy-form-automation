// United India: Back to Risk Details, then Compute Premium - the owner's rule (2026-11-13, his 3rd message on it): press it (nothing
// else), WATCH the loader (its start / stop / the page changing said in the log); still spinning after 15 s -> the page refreshed,
// the loader waited to stop, Compute Premium pressed AGAIN and watched 20 s; still spinning = [E302]. The fake portal acts like
// ChromeDriver: ANY other command sent while a popup is open closes it with CANCEL. No Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaCompute.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const compute = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaCompute");
const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");
const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");

const GST =
  "GSTIN/UIN HAS NOT BEEN INSERTED. The Insured will not be able to take input credit of GST/UIN on premium on policy and endorsements. You are advised to confirm with the insured about insertion of their GSTIN/UIN before proceeding. Do you want to proceed? If Yes, Click On Ok. If No, Click on Cancel to update GSTIN/UIN.";

/**
 * Pages: "more" (More Covers, the Back button), "risk" (Risk Details: Compute Premium; the Update button once worked out).
 *   tries: what each Compute Premium press does - { loaderPolls (looks the loader runs; Infinity = never stops), navigates } -
 *          the last one repeats
 *   asks: the popup a press opens (default the GSTIN question; null = none)
 *   spinsAfterRefresh: the loader keeps spinning on the refreshed page too
 *   updateAlwaysThere: the Update button is on the page even before Compute Premium
 *   ignoreComputeClicks / nothingHappens
 *   refreshFails: the reload does not finish in time
 *   tries[].submitsMs (+ clock): the press SENDS the page (the live portal: gc_ashokleyland1.do) and United India answers this
 *     long after the OK; meanwhile it acts like ChromeDriver (proved in a real Chrome, 2026-11-13): every look is HELD until the
 *     page arrives or the page-load limit runs out - past the limit the page is CANCELLED, the old page keeps its loader up for
 *     good (the owner's "loader spinning"); with no popup the CLICK itself waits for that page (like ChromeDriver's click)
 *   tries[].thenSubmitsMs: the loader runs `loaderPolls` looks on the page, THEN the page is sent (a page on its way late)
 */
function portal(over = {}) {
  const st = {
    page: over.start || "more",
    mark: null,
    leaving: false,
    navTo: null,
    navIn: 0,
    busy: false,
    busyFor: 0,
    computed: false,
    alert: null,
    answered: [],
    clicks: { back: 0, compute: 0 },
    refreshes: 0,
    scrolled: 0,
    log: [],
    stopped: false,
    ignore: over.ignoreComputeClicks || 0,
    tryNo: 0,
    pageLoad: 300000,
    refreshLimit: null,
    pendingUntil: null,
    cancelled: 0,
    cancelledAt: null,
    refreshAt: null,
    clickLimit: null,
    thenSubmitsMs: 0,
  };
  const clockOf = over.clock || null;
  const held = () => {
    if (st.pendingUntil === null) return;
    const left = st.pendingUntil - clockOf.now();
    if (left <= st.pageLoad) {
      clockOf.advance(Math.max(0, left));
      st.pendingUntil = null;
      st.mark = null; // the premium page: worked out, the Update button on it, no loader
      st.busy = false;
      st.computed = true;
      return;
    }
    clockOf.advance(st.pageLoad);
    st.pendingUntil = null;
    st.cancelled += 1; // United India's answer thrown away: the old page's loader stays up
    st.cancelledAt = clockOf.now();
    st.busyFor = Infinity;
    throw Object.assign(new Error("timeout: Timed out receiving message from renderer"), { name: "TimeoutError" });
  };
  const tries = over.tries || [{}];
  const go = (page, polls) => {
    st.leaving = true;
    st.navTo = page;
    st.navIn = polls;
  };
  const meets = (what) => {
    if (!st.alert) return;
    const text = st.alert.text;
    st.answered.push("cancel");
    st.alert = null;
    st.log.push(`${what} closed the popup with Cancel`);
    throw Object.assign(new Error(`unexpected alert open: {Alert text : ${text}}`), { name: "UnexpectedAlertOpenError" });
  };
  // one look at the page = one step of time for the loader; `blinkAt`: the loader goes off for `blinkLooks` looks, then back on
  const tick = () => {
    if (st.gap > 0) {
      st.gap -= 1;
      if (st.gap === 0) st.busy = true;
      return;
    }
    if (st.busy && st.busyFor !== Infinity) {
      st.busyFor -= 1;
      if (st.busyFor < 0 && st.thenSubmitsMs) {
        st.pendingUntil = clockOf.now() + st.thenSubmitsMs; // the page is sent now, the loader stays up
        st.thenSubmitsMs = 0;
        st.busyFor = Infinity;
        return;
      }
      if (st.blinkAt != null && st.busyFor === st.blinkAt) {
        st.busy = false;
        st.gap = st.blinkLooks;
        st.blinkAt = null;
        return;
      }
      if (st.busyFor < 0) {
        st.busy = false;
        st.computed = true; // the premium is there: the Update button shows
      }
    }
  };
  const button = (kind) => ({
    async isDisplayed() {
      if (kind === "back") return st.page === "more";
      if (kind === "update") return st.page === "risk" && (st.computed || !!over.updateAlwaysThere);
      return st.page === "risk";
    },
    async click() {
      meets("click");
      st.clicks[kind] += 1;
      if (kind === "back") return go("risk", over.backPolls || 2);
      if (st.ignore > 0) {
        st.ignore -= 1;
        return;
      }
      const t = tries[Math.min(st.tryNo, tries.length - 1)];
      st.tryNo += 1;
      const afterOk = () => {
        if (t.submitsMs) {
          st.busy = true; // fnSubmit shows the loader, then sends the page
          st.busyFor = Infinity;
          st.pendingUntil = clockOf.now() + t.submitsMs;
          return;
        }
        if (t.navigates) go("risk", 2);
        st.busy = true;
        st.busyFor = t.loaderPolls === undefined ? 12 : t.loaderPolls;
        st.blinkAt = t.blinkAt === undefined ? null : t.blinkAt;
        st.thenSubmitsMs = t.thenSubmitsMs || 0;
        st.blinkLooks = t.blinkLooks || 4;
      };
      const asks = over.asks === undefined ? GST : over.asks;
      st.clickLimit = st.pageLoad;
      if (asks) st.alert = { text: asks, onOk: afterOk };
      else if (!over.nothingHappens) {
        afterOk();
        if (t.submitsMs) held(); // no popup: ChromeDriver's click waits for the page it started
      }
    },
  });
  const back = button("back");
  const comp = button("compute");
  const update = button("update");
  return {
    st,
    async findElements(locator) {
      meets("findElements");
      const v = String((locator && locator.value) || "");
      if (/updt|updtimg1|Update\.JPG|'update'/.test(v)) return [update];
      if (/Back\.JPG|'back'/.test(v)) return [back];
      if (/compute|ComputePremium/i.test(v)) return [comp];
      return [];
    },
    async executeScript(script, ...args) {
      meets("executeScript");
      held();
      if (script === nav.markPageInPage) {
        st.mark = args[0];
        st.leaving = false;
        return true;
      }
      if (script === nav.pageStateInPage) {
        tick();
        if (st.navTo) {
          st.navIn -= 1;
          if (st.navIn <= 0) {
            st.page = st.navTo;
            st.navTo = null;
            st.mark = null;
            st.leaving = false;
            return null;
          }
        }
        return { marked: st.mark === args[0], leaving: st.leaving, ready: "complete", url: `https://uiic/${st.page}` };
      }
      if (script === steps.portalBusyInPage) {
        return { loader: st.busy ? "div#dialog.window" : null, cover: null, ajax: 0, ready: "complete" };
      }
      // errorBox: United India's "Error In Data Entry" lines once its work is done (the loader stopped)
      if (script === nav.portalErrorsInPage) return over.errorBox && st.computed ? over.errorBox : [];
      if (script === compute.scrollToEndInPage) {
        st.scrolled += 1;
        return 900;
      }
      if (typeof args[0] === "string" && args[0].includes("blockUI")) return st.busy;
      const s = String(script);
      if (s === "window.stop();") {
        st.stopped = true;
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      return null;
    },
    navigate: () => ({
      refresh: async () => {
        st.refreshes += 1;
        st.refreshLimit = st.pageLoad;
        st.refreshAt = clockOf ? clockOf.now() : null;
        if (over.refreshFails) throw Object.assign(new Error("timeout: Timed out receiving message from renderer: 20.000"), { name: "TimeoutError" });
        st.mark = null;
        st.leaving = false;
        if (!over.spinsAfterRefresh) {
          st.busy = false;
          st.busyFor = 0;
        }
      },
    }),
    manage: () => ({
      getTimeouts: async () => ({ pageLoad: st.pageLoad }),
      setTimeouts: async (t) => {
        if (t && t.pageLoad) st.pageLoad = t.pageLoad;
      },
    }),
    async getAllWindowHandles() {
      meets("getAllWindowHandles");
      return ["main"];
    },
    switchTo() {
      return {
        alert: async () => {
          if (!st.alert) throw new Error("no such alert");
          const a = st.alert;
          return {
            getText: async () => a.text,
            accept: async () => {
              st.answered.push("ok");
              st.alert = null;
              if (a.onOk) a.onOk();
            },
            dismiss: async () => {
              st.answered.push("cancel");
              st.alert = null;
            },
          };
        },
        window: async () => {},
      };
    },
    async getCurrentUrl() {
      return `https://uiic/${st.page}`;
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms), at: () => t, advance: (ms) => (t += ms) };
};
const run = (driver, fn, extra = {}, c = clock()) => {
  const lines = [];
  return { lines, c, go: () => fn(driver, { ...c, ...extra, log: (l) => lines.push(String(l)) }) };
};

test("Back: clicked once, Risk Details opens", async () => {
  const driver = portal();
  const { lines, go } = run(driver, compute.goBack);
  const out = await go();
  assert.equal(out.clicks, 1);
  assert.equal(driver.st.page, "risk");
  assert.ok(lines.some((l) => /✅ United India - the page after "Back" is open \(https:\/\/uiic\/risk\)/.test(l)));
});

test("Compute Premium pressed ONCE, the GSTIN question OK, the loader WATCHED - its start and stop said in the log - done, no refresh", async () => {
  const driver = portal({ start: "risk" });
  const { lines, go } = run(driver, compute.computePremium);
  const out = await go();
  assert.equal(driver.st.scrolled, 1);
  assert.deepEqual(driver.st.answered, ["ok"], driver.st.log.join("; "));
  assert.equal(driver.st.clicks.compute, 1);
  assert.equal(driver.st.refreshes, 0);
  assert.equal(out.refreshed, false);
  assert.ok(out.loaderMs >= 2500, `${out.loaderMs}`);
  assert.ok(lines.some((l) => /🧮 United India - "Compute Premium" pressed - watching the portal's loader \(up to 15 seconds\)/.test(l)));
  assert.ok(lines.some((l) => /⏳ United India - the portal's loader is showing \(div#dialog\.window\) [\d.]+ s after "Compute Premium"/.test(l)));
  assert.ok(lines.some((l) => /the loader stopped [\d.]+ s after "Compute Premium"/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - "Compute Premium" done \(the loader ran [\d.]+ s\)/.test(l)));
});

test("still spinning after 15 s: the page REFRESHED, the loader waited to stop, Compute Premium pressed AGAIN and done", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: Infinity }, { loaderPolls: 8 }] });
  const { lines, c, go } = run(driver, compute.computePremium);
  const out = await go();
  assert.equal(out.refreshed, true);
  assert.equal(driver.st.refreshes, 1);
  assert.equal(driver.st.clicks.compute, 2, "pressed again after the refresh (the owner)");
  assert.deepEqual(driver.st.answered, ["ok", "ok"]);
  assert.equal(driver.st.scrolled, 2);
  assert.ok(lines.some((l) => /⟳ United India - 15 seconds after "Compute Premium" the portal's loader is still spinning - refreshing the page/.test(l)));
  assert.ok(lines.some((l) => /^ {3}the page reloaded in [\d.]+ s - watching the portal's loader$/.test(l)));
  assert.ok(lines.some((l) => /after the refresh the loader has stopped - pressing "Compute Premium" again/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - "Compute Premium" done on the second press/.test(l)));
  assert.equal(driver.st.refreshLimit, 20000, "a refresh that meets a short page-load limit is STOPPED by ChromeDriver (real Chrome, 2026-11-13)");
  assert.equal(driver.st.pageLoad, 300000, "the run's own page-load limit is back afterwards");
  assert.ok(c.at() >= 15000 && c.at() < 25000, `${c.at()} ms`);
  assert.equal(compute.COMPUTE_FIRST_MS, 15000);
  assert.equal(compute.COMPUTE_SECOND_MS, 20000);
  assert.equal(compute.AFTER_REFRESH_MS, 20000);
});

test("spinning on the second press too: [E302] - 20 seconds after it was pressed again (after a refresh)", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: Infinity }] });
  const { c, go } = run(driver, compute.computePremium);
  await assert.rejects(go(), (e) => {
    assert.equal(e.code, "E302");
    assert.notEqual(e.retryable, false);
    assert.equal(
      e.message,
      '[E302] United India - the portal\'s loader was still spinning 20 seconds after "Compute Premium" was pressed again (after a refresh) - a loader issue at United India, so the run stopped there. It will try again shortly.'
    );
    return true;
  });
  assert.equal(driver.st.refreshes, 1, "refreshed once, not more");
  assert.equal(driver.st.clicks.compute, 2);
  assert.ok(c.at() >= 37000 && c.at() < 40000, `${c.at()} ms (15 + the settle + 20)`);
});

test("the loader still spinning after the refresh: [E302] - it did not stop within 20 seconds; Compute Premium not pressed again", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: Infinity }], spinsAfterRefresh: true });
  await assert.rejects(run(driver, compute.computePremium).go(), (e) => {
    assert.equal(e.code, "E302");
    assert.equal(
      e.message,
      '[E302] United India - the portal\'s loader was still spinning 15 seconds after "Compute Premium", and after the page was refreshed its loader did not stop within 20 seconds - a loader issue at United India, so the run stopped there. It will try again shortly.'
    );
    return true;
  });
  assert.equal(driver.st.clicks.compute, 1);
});

test("the refreshed page does not load within 20 s: [E302] saying so; Compute Premium NOT pressed again", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: Infinity }], refreshFails: true });
  const { lines, go } = run(driver, compute.computePremium);
  await assert.rejects(go(), (e) => e.code === "E302" && /15 seconds after "Compute Premium", and after the page was refreshed it did not load within 20 seconds - a loader issue/.test(e.message));
  assert.equal(driver.st.clicks.compute, 1);
  assert.equal(driver.st.pageLoad, 300000);
  assert.ok(lines.some((l) => /the refreshed page did not load within 20 seconds/.test(l)));
});

test("not done with NO loader seen, and the refreshed page never settles: the error says what was seen, not 'spinning'", async () => {
  const driver = portal({ start: "risk", ignoreComputeClicks: 1, updateAlwaysThere: true, refreshFails: true });
  await assert.rejects(
    run(driver, compute.computePremium).go(),
    (e) => e.code === "E302" && /^\[E302\] United India - Compute Premium was not done \(no loader seen, no Update button\) 15 seconds after "Compute Premium", and after the page was refreshed it did not load/.test(e.message)
  );
});

test("a loader that BLINKS off for 1 s and comes back is not done - done only after it stays off 2 s (the owner's live run)", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: 16, blinkAt: 8, blinkLooks: 4 }] });
  const { lines, go } = run(driver, compute.computePremium);
  const out = await go();
  assert.equal(out.refreshed, false);
  assert.equal(driver.st.computed, true, "returned only once the portal had really finished");
  assert.equal(lines.filter((l) => /⏳ United India - the portal's loader is showing/.test(l)).length, 2, "both starts said");
  assert.equal(lines.filter((l) => /the loader stopped [\d.]+ s after "Compute Premium"/.test(l)).length, 2, "both stops said");
});

test("Compute Premium SENDS the page and United India answers in 6 s (the owner's lag): WAITED for - never cancelled - done, no refresh", async () => {
  const c = clock();
  const driver = portal({ start: "risk", clock: c, tries: [{ submitsMs: 6000 }] });
  const { lines, go } = run(driver, compute.computePremium, {}, c);
  const out = await go();
  assert.equal(driver.st.cancelled, 0, "a 2 s limit threw this answer away in a real Chrome - the owner's spinning loader");
  assert.equal(out.refreshed, false);
  assert.equal(driver.st.refreshes, 0);
  assert.equal(driver.st.clicks.compute, 1);
  assert.ok(lines.some((l) => /the page changed [\d.]+ s after "Compute Premium"/.test(l)));
  assert.ok(c.at() >= 6000 && c.at() < 10000, `${c.at()} ms`);
});

test("United India answers in 14 s: still within the 15 s - waited for", async () => {
  const c = clock();
  const driver = portal({ start: "risk", clock: c, tries: [{ submitsMs: 14000 }] });
  const out = await run(driver, compute.computePremium, {}, c).go();
  assert.equal(driver.st.cancelled, 0);
  assert.equal(out.refreshed, false);
});

test("no answer within the owner's 15 s: cancelled AT 15 s (not before), refreshed, pressed again - this time it answers in 5 s: done", async () => {
  const c = clock();
  const driver = portal({ start: "risk", clock: c, tries: [{ submitsMs: 60000 }, { submitsMs: 5000 }] });
  const { lines, go } = run(driver, compute.computePremium, {}, c);
  const out = await go();
  assert.equal(driver.st.cancelled, 1);
  assert.equal(out.refreshed, true);
  assert.equal(driver.st.refreshes, 1);
  assert.equal(driver.st.clicks.compute, 2);
  assert.ok(lines.some((l) => /⟳ United India - 15 seconds after "Compute Premium" the portal's loader is still spinning - refreshing the page/.test(l)));
  assert.ok(c.at() >= 20000 && c.at() < 26000, `${c.at()} ms (15 + the settle + 5)`);
});

test("no question (a policy with a GSTIN): the CLICK itself waits for United India's 6 s answer - under the owner's 15 s, never 2 s", async () => {
  const c = clock();
  const driver = portal({ start: "risk", clock: c, asks: null, tries: [{ submitsMs: 6000 }] });
  const out = await run(driver, compute.computePremium, {}, c).go();
  assert.equal(driver.st.clickLimit, 15000, "the page-load limit at the press");
  assert.equal(driver.st.cancelled, 0);
  assert.equal(out.refreshed, false);
  assert.equal(driver.st.clicks.compute, 1);
});

test("a click that waited until the owner's 15 s counts in them: the refresh comes AT 15 s, not 15 s later", async () => {
  const c = clock();
  const driver = portal({ start: "risk", clock: c, asks: null, tries: [{ submitsMs: 60000 }, { loaderPolls: 8 }] });
  const out = await run(driver, compute.computePremium, {}, c).go();
  assert.equal(driver.st.cancelled, 1);
  assert.equal(out.refreshed, true);
  assert.ok(driver.st.refreshAt >= 15000 && driver.st.refreshAt <= 15600, `refreshed at ${driver.st.refreshAt} ms`);
});

test("a page sent LATE (the loader ran 10 s, then the page went; no answer): cancelled AT the owner's 15 s - a look never runs past it", async () => {
  const c = clock();
  const driver = portal({ start: "risk", clock: c, tries: [{ loaderPolls: 40, thenSubmitsMs: 60000 }, { loaderPolls: 8 }] });
  const out = await run(driver, compute.computePremium, {}, c).go();
  assert.equal(driver.st.cancelled, 1);
  assert.ok(driver.st.cancelledAt >= 14500 && driver.st.cancelledAt <= 15600, `cancelled at ${driver.st.cancelledAt} ms`);
  assert.equal(out.refreshed, true);
});

test("United India answers with its Error In Data Entry box (the owner's live N002219): [E306] in its words at once - never a loader issue, no refresh", async () => {
  const driver = portal({ start: "risk", errorBox: ["N002219, PolicyInception Date should be on or later to Proposal Date ."] });
  const { c, go } = run(driver, compute.computePremium);
  await assert.rejects(go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /after "Compute Premium" the portal says "Error In Data Entry - N002219, PolicyInception Date should be on or later to Proposal Date \.", so the run stopped there/);
    return true;
  });
  assert.equal(driver.st.refreshes, 0);
  assert.equal(driver.st.clicks.compute, 1);
  assert.ok(c.at() < 10000, `${c.at()} ms - not waited out`);
});

test("a loader that stops at 10 s is fine - no refresh", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: 40 }] });
  const out = await run(driver, compute.computePremium).go();
  assert.equal(out.refreshed, false);
  assert.equal(driver.st.refreshes, 0);
});

test("while it waits, a line every 5 s says what the run sees", async () => {
  const driver = portal({ start: "risk", tries: [{ loaderPolls: 50 }] }); // about 12.5 s
  const { lines, go } = run(driver, compute.computePremium);
  await go();
  const seen = lines.filter((l) => /^ {3}\d+ s after "Compute Premium": loader showing \(div#dialog\.window\), page loaded$/.test(l));
  assert.deepEqual(seen.map((l) => /(\d+) s after/.exec(l)[1]), ["5", "10"]);
});

test("a new page with its own loader: the page change and the loader both said, done", async () => {
  const driver = portal({ start: "risk", tries: [{ navigates: true }] });
  const { lines, go } = run(driver, compute.computePremium);
  const out = await go();
  assert.equal(out.refreshed, false);
  assert.ok(lines.some((l) => /the page changed [\d.]+ s after "Compute Premium" \(https:\/\/uiic\/risk\)/.test(l)));
});

test("a swallowed press with the Update button already on the page is NOT done - refreshed and pressed again", async () => {
  const driver = portal({ start: "risk", ignoreComputeClicks: 1, updateAlwaysThere: true });
  const { lines, go } = run(driver, compute.computePremium);
  const out = await go();
  assert.equal(out.refreshed, true);
  assert.equal(driver.st.clicks.compute, 2);
  assert.ok(lines.some((l) => /15 seconds after "Compute Premium" it is not done \(no loader seen, no Update button\) - refreshing the page/.test(l)));
});

test("no question, no loader (a fast portal), the Update button there after the GSTIN-less press: done", async () => {
  const driver = portal({ start: "risk", asks: null, tries: [{ loaderPolls: 0, navigates: true }] });
  const out = await run(driver, compute.computePremium).go();
  assert.equal(out.refreshed, false);
});

test("any OTHER popup: closed with Cancel (nothing goes ahead), [E308] in its words - no refresh", async () => {
  const driver = portal({ start: "risk", asks: "Please select the Zone" });
  await assert.rejects(run(driver, compute.computePremium).go(), (e) => {
    assert.equal(e.code, "E308");
    assert.match(e.message, /after "Compute Premium" the portal said "Please select the Zone"/);
    return true;
  });
  assert.deepEqual(driver.st.answered, ["cancel"]);
  assert.equal(driver.st.refreshes, 0);
});

test("nothing ever happens: refreshed, pressed again, still nothing - [E302] saying it was not done", async () => {
  const driver = portal({ start: "risk", asks: null, nothingHappens: true });
  await assert.rejects(
    run(driver, compute.computePremium).go(),
    (e) => e.code === "E302" && /Compute Premium was still not done \(no loader seen, no Update button\) 20 seconds after "Compute Premium" was pressed again/.test(e.message)
  );
  assert.equal(driver.st.refreshes, 1);
  assert.equal(driver.st.clicks.compute, 2);
});

test("Back, then Compute Premium, in that order", async () => {
  const driver = portal();
  const out = await run(driver, compute.backAndComputePremium).go();
  assert.equal(driver.st.clicks.back, 1);
  assert.equal(driver.st.clicks.compute, 1);
  assert.equal(out.back.url, "https://uiic/risk");
  assert.deepEqual(driver.st.answered, ["ok"]);
});

test("the owner's markup, the question and the buttons", () => {
  assert.ok(compute.BACK.target.includes("img[src*='Back.JPG']"));
  assert.equal(compute.COMPUTE.target[0], "#compute");
  assert.equal(compute.UPDATE_BUTTON[0], "#updt");
  assert.equal(compute.GENERATE_QUOTE[0], "img[src*='GenerateQuote']");
  assert.ok(compute.GSTIN_QUESTION.test(GST));
  assert.ok(!compute.GSTIN_QUESTION.test("Please select the Zone"));
});
