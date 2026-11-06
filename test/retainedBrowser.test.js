// A window kept open on purpose is cleaned up when the owner closes it (lib/retainedBrowser.js, 2026-11-06): its session
// ends and ITS folders are deleted, never another running job's. Fake drivers, the polls driven by hand; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/retainedBrowser.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { watchRetainedBrowser, activeWatches, stopAllWatches } = require("../lib/retainedBrowser");
const jobDirs = require("../lib/jobDirs");

const tmpDir = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `kept-${name}-`));
  fs.writeFileSync(path.join(d, "Cookies"), "session data");
  return d;
};

/** A fake kept browser: open until close() is called; then it answers like chromedriver does for a closed window. */
const keptBrowser = ({ closedError = "invalid session id" } = {}) => {
  const b = { open: true, quits: 0, polls: 0 };
  b.driver = {
    async getAllWindowHandles() {
      b.polls += 1;
      if (b.open) return ["CDwindow-1"];
      if (closedError === "empty") return [];
      throw new Error(closedError);
    },
    async quit() {
      b.quits += 1;
    },
  };
  b.close = () => (b.open = false);
  return b;
};

const noTimer = () => ({ unref() {} });

test.afterEach(() => stopAllWatches());

test("an open window is left alone: its folder stays, the session stays", async () => {
  const dir = tmpDir("open");
  jobDirs.claim(dir);
  const b = keptBrowser();
  const w = watchRetainedBrowser({ label: "Job A", driver: b.driver, dirs: [dir], setIntervalFn: noTimer, log() {} });
  assert.equal(await w.check(), false);
  assert.equal(await w.check(), false);
  assert.ok(fs.existsSync(dir));
  assert.equal(b.quits, 0);
  jobDirs.release(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const closedError of ["invalid session id", "no such window: target window already closed", "chrome not reachable", "empty"]) {
  test(`closing the window ("${closedError}") ends the session and deletes the job's own folders`, async () => {
    const profile = tmpDir("profile");
    const downloads = tmpDir("downloads");
    jobDirs.claim(profile);
    jobDirs.claim(downloads);
    const b = keptBrowser({ closedError });
    const lines = [];
    const w = watchRetainedBrowser({ label: "United India Job X", driver: b.driver, dirs: [profile, downloads], setIntervalFn: noTimer, log: (l) => lines.push(l) });
    assert.equal(await w.check(), false);
    b.close();
    assert.equal(await w.check(), true);
    assert.equal(fs.existsSync(profile), false);
    assert.equal(fs.existsSync(downloads), false);
    assert.equal(b.quits, 1, "the chromedriver session left behind is ended");
    assert.equal(jobDirs.holdersOf(profile), 0);
    assert.ok(lines.some((l) => /🧹 \[United India Job X\] the window was closed - its session and .* removed/.test(l)));
    assert.equal(await w.check(), true, "nothing more happens after that");
    assert.equal(b.quits, 1);
  });
}

test("TWO windows: closing one deletes only its folder; the other window's folder and session are untouched", async () => {
  const dirA = tmpDir("A");
  const dirB = tmpDir("B");
  jobDirs.claim(dirA);
  jobDirs.claim(dirB);
  const a = keptBrowser();
  const b = keptBrowser();
  const wa = watchRetainedBrowser({ label: "Job A", driver: a.driver, dirs: [dirA], setIntervalFn: noTimer, log() {} });
  const wb = watchRetainedBrowser({ label: "Job B", driver: b.driver, dirs: [dirB], setIntervalFn: noTimer, log() {} });
  a.close();
  assert.equal(await wa.check(), true);
  assert.equal(await wb.check(), false);
  assert.equal(fs.existsSync(dirA), false);
  assert.ok(fs.existsSync(dirB), "the other window's data is kept");
  assert.equal(b.quits, 0);
  b.close();
  assert.equal(await wb.check(), true);
  assert.equal(fs.existsSync(dirB), false);
});

test("a folder another running job still holds is NOT deleted when this window closes", async () => {
  const shared = tmpDir("shared");
  jobDirs.claim(shared); // this kept job
  jobDirs.claim(shared); // another job, still running, on the same folder
  const k = keptBrowser();
  const lines = [];
  const w = watchRetainedBrowser({ label: "Job K", driver: k.driver, dirs: [shared], setIntervalFn: noTimer, log: (l) => lines.push(l) });
  k.close();
  assert.equal(await w.check(), true);
  assert.ok(fs.existsSync(shared), "kept for the other job");
  assert.equal(jobDirs.holdersOf(shared), 1);
  assert.ok(lines.some((l) => /is kept, another running job still uses it/.test(l)));
  jobDirs.release(shared);
  fs.rmSync(shared, { recursive: true, force: true });
});

test("a busy or odd answer (an alert, a timeout) is not 'closed': nothing is deleted, it asks again later", async () => {
  const dir = tmpDir("busy");
  jobDirs.claim(dir);
  let answer = "unexpected alert open: {Alert text : Saved}";
  const driver = {
    async getAllWindowHandles() {
      throw new Error(answer);
    },
    async quit() {},
  };
  const w = watchRetainedBrowser({ label: "Job Busy", driver, dirs: [dir], setIntervalFn: noTimer, log() {} });
  assert.equal(await w.check(), false);
  answer = "timeout: Timed out receiving message from renderer";
  assert.equal(await w.check(), false);
  assert.ok(fs.existsSync(dir));
  answer = "invalid session id";
  assert.equal(await w.check(), true);
  assert.equal(fs.existsSync(dir), false);
});

test("the poll timer never keeps the process alive, and checks never overlap", async () => {
  let unrefed = false;
  let tick = null;
  const setIntervalFn = (fn, ms) => {
    tick = fn;
    assert.equal(ms, 5000);
    return { unref: () => (unrefed = true) };
  };
  let inFlight = 0;
  let maxInFlight = 0;
  const driver = {
    async getAllWindowHandles() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ["w"];
    },
    async quit() {},
  };
  const w = watchRetainedBrowser({ label: "Job T", driver, dirs: [], setIntervalFn, log() {} });
  assert.equal(unrefed, true);
  tick();
  tick();
  await w.check();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(maxInFlight, 1);
  assert.equal(activeWatches(), 1);
  w.stop();
  assert.equal(activeWatches(), 0);
});

test("nothing to watch without a real driver (a fake in other tests, a browser that never started)", () => {
  assert.equal(watchRetainedBrowser({ label: "x", driver: null, dirs: [] }), null);
  assert.equal(watchRetainedBrowser({ label: "x", driver: {}, dirs: [] }), null);
  // the Java / Python name is not what selenium-webdriver for Node has (a real driver was checked in the replica script)
  assert.equal(watchRetainedBrowser({ label: "x", driver: { getWindowHandles: async () => [] }, dirs: [] }), null);
});

test("every company's keep-open path hands its kept browser to the watcher", () => {
  for (const [file, dirs] of [
    ["sessionManager.js", /userDataDir.*downloadDir/],
    ["nationalSessionManager.js", /path\.dirname\(profileInfo\.fullPath\)/],
    ["fullPolicycompany/kshema/kshemaSessionManager.js", /profileInfo\.userDataDir/],
    ["multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSession.js", /profileInfo\.userDataDir/],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const keep = src.slice(src.indexOf("shouldKeepBrowserOpen(hadError)"));
    const call = keep.slice(0, keep.indexOf("return;"));
    assert.match(call, /watchRetainedBrowser\(/, `${file} watches its kept window`);
    assert.match(call, dirs, `${file} hands over its own folders`);
  }
});
