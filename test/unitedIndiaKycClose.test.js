// United India: the KYC finished -> the CKYC window's own Close (the owner, 2026-11-14), the window checked gone, the run back
// on the proposal page; a Close that does nothing (pressed twice) -> the run closes the window itself. A fake browser; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaKycClose.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const kyc = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaKyc");

/**
 *   closes:   what a Close press does - "yes" (the window goes), "gone-error" (it goes and the click reports the window gone),
 *             "no" (nothing)
 *   noButton: the window has no Close
 */
function browser(over = {}) {
  const st = { handles: ["main", "ckyc"], current: "ckyc", presses: 0, closedByRun: 0, limits: [], pageLoad: 300000 };
  const btn = {
    async isDisplayed() {
      return st.current === "ckyc" && st.handles.includes("ckyc");
    },
    async click() {
      st.presses += 1;
      const how = over.closes || "yes";
      if (how === "no") return;
      st.handles = st.handles.filter((h) => h !== "ckyc");
      if (how === "gone-error") throw Object.assign(new Error("no such window: target window already closed"), { name: "NoSuchWindowError" });
    },
  };
  return {
    st,
    async findElements(locator) {
      if (over.noButton || st.current !== "ckyc") return [];
      return /Close/.test(String((locator && locator.value) || "")) ? [btn] : [];
    },
    async executeScript() {
      return null;
    },
    async getWindowHandle() {
      return st.current;
    },
    async getAllWindowHandles() {
      return st.handles.slice();
    },
    async close() {
      st.closedByRun += 1;
      st.handles = st.handles.filter((h) => h !== st.current);
    },
    manage: () => ({
      getTimeouts: async () => ({ pageLoad: st.pageLoad }),
      setTimeouts: async (t) => {
        st.limits.push(t.pageLoad);
        st.pageLoad = t.pageLoad;
      },
    }),
    switchTo() {
      return {
        window: async (h) => {
          st.current = h;
        },
        alert: async () => {
          throw new Error("no such alert");
        },
      };
    },
    async sleep() {},
  };
}

const run = (driver) => {
  const lines = [];
  let t = 0;
  const o = { now: () => t, sleep: async (_d, ms) => (t += ms), log: (l) => lines.push(String(l)) };
  return { lines, go: () => kyc.closeCkycWindow(driver, "main", o) };
};

test("the KYC finished: Close pressed ONCE, the window gone, the run back on the proposal page, the run's page-load limit back", async () => {
  const driver = browser();
  const { lines, go } = run(driver);
  assert.deepEqual(await go(), { by: "button" });
  assert.equal(driver.st.presses, 1);
  assert.equal(driver.st.closedByRun, 0);
  assert.deepEqual(driver.st.handles, ["main"]);
  assert.equal(driver.st.current, "main");
  assert.deepEqual(driver.st.limits, [5000, 300000]);
  assert.ok(lines.some((l) => /🪟 United India - the CKYC window closed \(its Close button\) - back on the proposal page/.test(l)));
});

test("the click reports the window gone (it closed under the click): that is the Close working, not an error", async () => {
  const driver = browser({ closes: "gone-error" });
  assert.deepEqual(await run(driver).go(), { by: "button" });
  assert.equal(driver.st.presses, 1);
  assert.equal(driver.st.current, "main");
});

test("a Close that does nothing: pressed ONCE more, then the run closes the window itself (said), back on the proposal page", async () => {
  const driver = browser({ closes: "no" });
  const { lines, go } = run(driver);
  assert.deepEqual(await go(), { by: "run" });
  assert.equal(driver.st.presses, 2);
  assert.equal(driver.st.closedByRun, 1);
  assert.deepEqual(driver.st.handles, ["main"]);
  assert.equal(driver.st.current, "main");
  assert.ok(lines.some((l) => /↻ United India - the CKYC window is still open after "Close" - pressing it once more/.test(l)));
  assert.ok(lines.some((l) => /⚠️ United India - the CKYC window did not close with its "Close" button - the run closed it/.test(l)));
});

test("no Close button in the window: the run closes it, back on the proposal page", async () => {
  const driver = browser({ noButton: true });
  assert.deepEqual(await run(driver).go(), { by: "run" });
  assert.equal(driver.st.presses, 0);
  assert.equal(driver.st.current, "main");
});

test("the owner's Close button", () => {
  assert.equal(kyc.CLOSE.target[0], "button[name='param'][value='Close']");
});
