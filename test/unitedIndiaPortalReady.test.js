// United India: the portal must be READY before a step (the owner, 2026-11-13, after his live run: "the loader opens for some
// time, then the click does not work - wait for the loader"; the run's More Covers click was lost and he clicked it by hand).
// No loader over the box; before a submit button also no jQuery request running and the page loaded; at most 40 s. Fakes; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaPortalReady.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");
const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms), at: () => t };
};

/**
 * A page whose portal is busy for a number of looks: `cover` looks with a loader over the box, `ajax` looks with requests
 * running, `loading` looks with the page still loading. Every call is recorded in order.
 */
function page({ cover = 0, ajax = 0, loading = 0, loader = 0, coverName = "div#pleaseWait.overlay", interceptFirstClick = false, navigates = true } = {}) {
  const st = { cover, ajax, loading, loader, calls: [], clicks: 0, jsClicks: 0, mark: null, doc: 1, posted: 0, selector: null };
  const el = {
    async isDisplayed() {
      return st.doc === 1;
    },
    async click() {
      st.calls.push(`click (cover ${st.cover}, ajax ${st.ajax})`);
      if (interceptFirstClick && st.clicks === 0) {
        st.clicks += 1;
        throw Object.assign(new Error('element click intercepted: Element <img src="MoreCoversNInfo.JPG"> is not clickable at point (500, 300). Other element would receive the click: <div id="pleaseWait" class="overlay">...</div>'), {
          name: "ElementClickInterceptedError",
        });
      }
      st.clicks += 1;
      // the portal ignores a click while it is busy (the owner's lost click)
      if (st.cover > 0 || st.ajax > 0 || st.loader > 0) return;
      if (navigates) {
        st.posted += 1;
        st.doc = 2;
        st.mark = null;
      }
    },
  };
  const driver = {
    st,
    async findElements() {
      return st.doc === 1 ? [el] : [];
    },
    async executeScript(script, ...args) {
      if (script === steps.portalBusyInPage) {
        st.calls.push("look");
        st.selector = args[1];
        const out = { loader: st.loader > 0 ? "div#dialog.window" : null, cover: st.cover > 0 ? coverName : null, ajax: st.ajax > 0 ? 1 : 0, ready: st.loading > 0 ? "loading" : "complete" };
        if (st.loader > 0) st.loader -= 1;
        if (st.cover > 0) st.cover -= 1;
        if (st.ajax > 0) st.ajax -= 1;
        if (st.loading > 0) st.loading -= 1;
        return out;
      }
      if (script === nav.markPageInPage) {
        st.mark = args[0];
        return true;
      }
      if (script === nav.pageStateInPage) return { marked: st.mark === args[0] && st.doc === 1, leaving: false, ready: "complete", url: `https://uiic/${st.doc}` };
      const s = String(script);
      if (s === "arguments[0].click();") {
        st.jsClicks += 1;
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      return null;
    },
    async getAllWindowHandles() {
      return ["main"];
    },
    switchTo() {
      return {
        alert: async () => {
          throw new Error("no such alert");
        },
      };
    },
    async getCurrentUrl() {
      return `https://uiic/${st.doc}`;
    },
    async sleep() {},
  };
  return { driver, el };
}

const logs = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)) };
};

test("a loader over the box is waited for (any name - it is what is drawn over the box), then the step goes on", async () => {
  const { driver, el } = page({ cover: 8 });
  const { lines, log } = logs();
  const c = clock();
  const out = await steps.waitPortalReady(driver, el, { label: "RTO", coverOnly: true }, { ...c, log });
  assert.ok(out.waitedMs >= 1600, `${out.waitedMs}`);
  assert.ok(lines.some((l) => /⏳ United India - waiting for the portal before "RTO": its loader \(div#pleaseWait\.overlay\) covers the page/.test(l)));
  assert.ok(lines.some((l) => /the portal is ready after 1\.6 s - going on with "RTO"/.test(l)));
});

test("United India's own loader - the small 'Loading...' box div#dialog.window with wait.gif - is waited for before ANY box", async () => {
  const { driver, el } = page({ loader: 10 });
  const { lines, log } = logs();
  await steps.showOnScreen(driver, el, { ...clock(), log }, "Mobile");
  assert.equal(driver.st.loader, 0);
  assert.ok(lines.some((l) => /⏳ United India - waiting for the portal before "Mobile": its loader \(div#dialog\.window\) is showing/.test(l)));
  assert.match(String(driver.st.selector), /#dialog\.window/, "the page is asked about the loader the owner showed");
});

test("the loader list knows United India's 'Loading...' box, and waits for it at most 40 s (the owner)", () => {
  const { LOADER_PRESETS } = require("../multiCompany/common/loader");
  const ui = LOADER_PRESETS["united india"];
  assert.ok(ui.busy.split(", ").includes("#dialog.window"));
  assert.ok(ui.busy.split(", ").includes("img[src*='wait.gif']"));
  assert.equal(ui.timeoutMs, 40000);
});

test("every box: showOnScreen waits for a loader over it before the box is used", async () => {
  const { driver, el } = page({ cover: 3 });
  const { lines, log } = logs();
  await steps.showOnScreen(driver, el, { ...clock(), log }, "Mobile");
  assert.equal(driver.st.cover, 0);
  assert.ok(lines.some((l) => /waiting for the portal before "Mobile"/.test(l)));
});

test("for an ordinary box the requests are not waited for (coverOnly) - only before a submit button", async () => {
  const { driver, el } = page({ ajax: 50 });
  const out = await steps.waitPortalReady(driver, el, { label: "Mobile", coverOnly: true }, { ...clock(), log() {} });
  assert.equal(out.waitedMs, 0);
});

test("requests still running and a page still loading are waited for before a submit button", async () => {
  const { driver, el } = page({ ajax: 6, loading: 3 });
  const { lines, log } = logs();
  await steps.waitPortalReady(driver, el, { label: "More Covers N Info" }, { ...clock(), log });
  assert.ok(lines.some((l) => /waiting for the portal before "More Covers N Info": 1 request still running, the page is still loading/.test(l)));
});

test("still busy after 40 seconds: [E302] naming what was busy - a loader issue, tried again later", async () => {
  const { driver, el } = page({ cover: 100000, ajax: 100000 });
  const c = clock();
  await assert.rejects(steps.waitPortalReady(driver, el, { label: "Compute Premium" }, { ...c, log() {} }), (e) => {
    assert.equal(e.code, "E302");
    assert.notEqual(e.retryable, false);
    assert.equal(
      e.message,
      '[E302] United India - the portal was still busy before "Compute Premium" after 40 seconds (its loader (div#pleaseWait.overlay) covers the page, 1 request still running) - a loader issue at United India, so the run stopped there. It will try again shortly.'
    );
    return true;
  });
  assert.ok(c.at() >= 40000 && c.at() < 40500);
  assert.equal(steps.PORTAL_BUSY_MAX_MS, 40000);
});

test("a page that cannot be read (a script error) never blocks the run", async () => {
  const { driver, el } = page();
  driver.executeScript = async () => {
    throw new Error("javascript error: oops");
  };
  const out = await steps.waitPortalReady(driver, el, { label: "X" }, { ...clock(), log() {} });
  assert.equal(out.waitedMs, 0);
});

test("More Covers N Info is clicked only once the portal is ready: ONE click, it is taken, the page opens", async () => {
  const { driver } = page({ cover: 6, ajax: 10 });
  const { lines, log } = logs();
  const out = await nav.clickToNextPage(driver, { label: "More Covers N Info", target: ["img"], stage: "s" }, { ...clock(), log });
  assert.equal(out.clicks, 1);
  assert.equal(driver.st.posted, 1);
  assert.equal(driver.st.calls.filter((c) => c.startsWith("click")).join(), "click (cover 0, ajax 0)", "never clicked while busy");
  assert.ok(lines.some((l) => /waiting for the portal before "More Covers N Info"/.test(l)));
});

test("a click something covers: what covers it is logged, the portal waited for, clicked again FOR REAL (no script click)", async () => {
  const { driver } = page({ interceptFirstClick: true });
  const { lines, log } = logs();
  const out = await nav.clickToNextPage(driver, { label: "More Covers N Info", target: ["img"], stage: "s" }, { ...clock(), log });
  assert.equal(driver.st.jsClicks, 0, "no script click through the loader");
  assert.equal(driver.st.posted, 1);
  assert.equal(out.clicks, 1);
  assert.ok(lines.some((l) => /"More Covers N Info" is covered by <div id="pleaseWait" class="overlay"> - waiting for the portal, then clicking it again/.test(l)));
});

test("while the page has not changed, a line at 5, 10 and 15 s says what the run sees", async () => {
  const { driver } = page({ navigates: false });
  const { lines, log } = logs();
  await assert.rejects(nav.clickToNextPage(driver, { label: "Back", target: ["img"], stage: "s" }, { ...clock(), log }), (e) => e.code === "E301");
  const seen = lines.filter((l) => /still on the same page \d+ s after "Back"/.test(l));
  assert.deepEqual(
    seen.map((l) => /same page (\d+) s/.exec(l)[1]),
    ["5", "10", "15"]
  );
  assert.ok(/\(submit started: no, page load seen: no, loader: none, requests running: 0\)/.test(seen[0]), seen[0]);
});
