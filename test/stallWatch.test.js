// Run with: node --require ./test/support/noRealWorld.js --test test/stallWatch.test.js
//
// lib/stallWatch.js (2026-10-22): a run that prints nothing for 1.5 minutes is stuck - a frozen portal page, or a wait
// that never ends - and is stopped with a retryable [E309] error and a picture of the stuck page. Never after the payment
// point. Fakes only: a fake driver, a virtual clock, no browser, no S3.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const sw = require("../lib/stallWatch");
const { armLiveHold, disarmLiveHold, stopIfHeld } = require("../lib/holdStop");
const { classifyError, beautifyError } = require("../lib/errorHandler");

const ROOT = path.join(__dirname, "..");
const flush = () => new Promise((r) => setImmediate(r));

/** A driver like selenium's: every call goes through execute(command). `freeze` = the next command never answers. */
function fakeDriver() {
  const sent = [];
  const driver = {
    sent,
    freeze: false,
    quitCalled: false,
    async execute(command) {
      const name = command.getName();
      sent.push(name);
      if (name === "quit") {
        driver.quitCalled = true;
        if (driver.release) driver.release(new Error("invalid session id"));
        return null;
      }
      if (name === "screenshot") return "PNGDATA";
      if (driver.freeze) return new Promise((_, reject) => { driver.release = reject; });
      return "ok";
    },
    cmd(name) { return this.execute({ getName: () => name }); },
    findElement() { return this.cmd("findElement"); },
    takeScreenshot() { return this.cmd("screenshot"); },
    quit() { return this.cmd("quit"); },
  };
  return driver;
}

/** A virtual clock: intervals and timeouts run when advance() says so. */
function clock() {
  let t = 1000000;
  const jobs = [];
  const add = (fn, ms, every) => { const j = { fn, at: t + ms, ms, every, done: false }; jobs.push(j); return j; };
  return {
    now: () => t,
    setInterval: (fn, ms) => add(fn, ms, true),
    clearInterval: (j) => { if (j) j.done = true; },
    setTimeout: (fn, ms) => add(fn, ms, false),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = jobs.filter((j) => !j.done && j.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        if (due.every) due.at += due.ms; else due.done = true;
        await due.fn();
        await flush();
      }
      t = end;
    },
  };
}

function setup(key = "job1") {
  const c = clock();
  const uploads = [];
  const lines = [];
  const opts = {
    now: c.now,
    setInterval: c.setInterval,
    clearInterval: c.clearInterval,
    setTimeout: c.setTimeout,
    upload: async (b64) => { uploads.push(b64); return { screenshotUrl: "https://s3/stalled.png", screenshotKey: "screenshots/stalled/x.png" }; },
    log: (l) => lines.push(l),
  };
  const data = { _jobId: key, _jobIdentifier: "ANMOL_1", _attemptNumber: 1 };
  const driver = fakeDriver();
  return { c, uploads, lines, opts, data, driver };
}

/** As if the run printed a line (what install()'s console wrapper does inside run()). */
const printed = (key, c, text) => sw._store.run(key, () => {
  const state = sw._runs.get(key);
  sw._touch([text]);
  if (state) state.lastProgressAt = c.now();
});

/* ------------------------------ counting lines per run ------------------------------ */

test("install + run: a line printed inside a run counts for that run only; outside a run for none", async () => {
  const fakeConsole = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  // a private copy of the module, so the real console is not wrapped twice
  delete require.cache[require.resolve("../lib/stallWatch")];
  const fresh = require("../lib/stallWatch");
  delete require.cache[require.resolve("../lib/stallWatch")];
  require("../lib/stallWatch"); // put the shared one back for the other tests
  fresh.install(fakeConsole);
  await fresh.run("A", async () => {
    fresh._runs.get("A").lastProgressAt = 0;
    fakeConsole.log("Reliance TP+OD | Filling engine number...");
  });
  await fresh.run("B", async () => { fresh._runs.get("B").lastProgressAt = 0; });
  fakeConsole.log("queue poller line");
  assert.ok(fresh._runs.get("A").lastProgressAt > 0);
  assert.equal(fresh._runs.get("A").lastLine, "Filling engine number...", "the flow tag is taken off");
  assert.equal(fresh._runs.get("B").lastProgressAt, 0, "the other run did not print");
});

/* ------------------------------ the watch ------------------------------ */

test("a run that keeps printing is never stopped", async () => {
  const { c, opts, data, driver } = setup("busy");
  sw.run("busy", () => {});
  sw.arm(driver, data, opts);
  for (let i = 0; i < 10; i++) {
    printed("busy", c, `step ${i}`);
    await c.advance(60000);
  }
  assert.equal(sw.stalledOf("busy"), null);
  assert.equal(await driver.findElement(), "ok");
  sw.disarm(data);
});

test("nothing printed for 1.5 minutes: stopped - E309, the last step named, no colon, a picture, commands fail", async () => {
  const { c, opts, data, driver, uploads } = setup("stuck");
  sw.run("stuck", () => {});
  sw.arm(driver, data, opts);
  printed("stuck", c, "Reliance TP+OD | Regular click attempted on 'Get Coverage Details' button");
  await c.advance(85000);
  assert.equal(sw.stalledOf("stuck"), null, "not before 1.5 minutes");
  await c.advance(10000);
  const err = sw.stalledOf("stuck");
  assert.ok(err);
  assert.match(err.message, /^\[E309\] The step did not finish in 1\.5 minutes after "Regular click attempted on 'Get Coverage Details' button"/);
  assert.doesNotMatch(err.message, /:/, "beautifyError keeps only what follows the last colon");
  assert.deepEqual(uploads, ["PNGDATA"]);
  await assert.rejects(() => driver.findElement(), /\[E309\]/);
  assert.equal(await driver.cmd("getCurrentUrl"), "ok", "where the page is can still be read");
  assert.equal(await driver.takeScreenshot(), "PNGDATA", "the form can still take its own picture");
  sw.disarm(data);
});

test("a frozen command: the window is closed 20 s later so the command fails and the run can end", async () => {
  const { c, opts, data, driver } = setup("frozen");
  sw.run("frozen", () => {});
  sw.arm(driver, data, opts);
  driver.freeze = true;
  const hanging = driver.cmd("executeScript").then(() => "answered", (e) => `failed - ${e.message}`);
  await c.advance(95000);
  assert.ok(sw.stalledOf("frozen"));
  assert.equal(driver.quitCalled, false);
  await c.advance(20000);
  assert.equal(driver.quitCalled, true);
  assert.equal(await hanging, "failed - invalid session id");
  sw.disarm(data);
});

test("a frozen page: its tabs are closed through Chrome's DevTools port FIRST (chromedriver's quit waits behind the frozen command)", async () => {
  const { c, opts, data, driver } = setup("devtools");
  const order = [];
  driver.getCapabilities = async () => ({ get: (k) => (k === "goog:chromeOptions" ? { debuggerAddress: "localhost:9333" } : null) });
  const realQuit = driver.quit.bind(driver);
  driver.quit = () => { order.push("quit"); return realQuit(); };
  sw.run("devtools", () => {});
  sw.arm(driver, data, { ...opts, closePages: async (addr) => { order.push(`close pages at ${addr}`); } });
  await flush();
  await c.advance(95000 + 20000);
  assert.deepEqual(order, ["close pages at localhost:9333", "quit"]);
  sw.disarm(data);
});

test("a run that unwound by itself is not quit again by the watch", async () => {
  const { c, opts, data, driver } = setup("unwound");
  sw.run("unwound", () => {});
  sw.arm(driver, data, opts);
  await c.advance(95000);
  sw.disarm(data); // the form's cleanup
  await c.advance(30000);
  assert.equal(driver.quitCalled, false);
});

test("never after the payment point: stopIfHeld('before Pay') switches the watch off, whatever the hold switch", async () => {
  const { c, opts, data, driver } = setup("paying");
  sw.run("paying", () => {});
  armLiveHold(driver, data, { env: { JOB_HOLD_REQUEST_ENABLED: "false" }, log: () => {}, stall: opts });
  await stopIfHeld(data, "before Pay (nothing is paid)", { env: { JOB_HOLD_REQUEST_ENABLED: "false" } });
  await c.advance(10 * 60000);
  assert.equal(sw.stalledOf("paying"), null);
  assert.equal(await driver.findElement(), "ok");
  disarmLiveHold(data);
});

test("armed through armLiveHold for every flow; disarmLiveHold gives the driver its own execute back", async () => {
  const { opts, data, driver } = setup("viaHold");
  const original = driver.execute;
  sw.run("viaHold", () => {});
  armLiveHold(driver, data, { env: {}, log: () => {}, intervalMs: 1e9, collection: { findOne: async () => null }, stall: opts });
  assert.notEqual(driver.execute, original);
  disarmLiveHold(data);
  assert.equal(driver.execute, original);
});

/* ------------------------------ what the queue gets ------------------------------ */

test("guard: the run's own answer normally; a stuck run that never ends -> the stall error after the give-up time", async () => {
  sw.run("g1", () => {});
  assert.deepEqual(await sw.guard("g1", Promise.resolve({ success: true })), { success: true });

  const { c, opts, data, driver } = setup("g2");
  sw.run("g2", () => {});
  sw.arm(driver, data, opts);
  const never = new Promise(() => {});
  const guarded = sw.guard("g2", never, { setTimeout: c.setTimeout, giveUpMs: 45000 });
  let settled = null;
  guarded.then(() => (settled = "resolved"), (e) => (settled = e.message));
  await c.advance(95000);
  assert.equal(settled, null);
  await c.advance(45000);
  assert.match(settled, /^\[E309\]/);
  sw.disarm(data);
});

test("applyToResult: a failed result of a stuck run says it was stuck and carries the picture; a success is untouched", async () => {
  const { c, opts, data, driver } = setup("r1");
  sw.run("r1", () => {});
  sw.arm(driver, data, opts);
  await c.advance(95000);
  const r = sw.applyToResult("r1", { success: false, error: "invalid session id", stage: "login-form" });
  assert.match(r.error, /^\[E309\]/);
  assert.equal(r.screenshotUrl, "https://s3/stalled.png");
  assert.equal(r.stage, "login-form", "the rest of the result stays (post-submission stays post-submission)");
  assert.deepEqual(sw.applyToResult("r1", { success: true }), { success: true });
  assert.deepEqual(sw.applyToResult("other", { success: false, error: "x" }), { success: false, error: "x" });
  sw.disarm(data);
});

test("the error is retryable (E309) and survives beautifyError whole", () => {
  const e = new Error('[E309] The step did not finish in 1.5 minutes after "Filling engine number..." - the portal stopped responding, so this run was stopped. It will be tried again');
  const c = classifyError(e);
  assert.equal(c.code, "E309");
  assert.equal(c.retryable, true);
  assert.match(beautifyError(e, "Reliance"), /did not finish in 1\.5 minutes after "Filling engine number\.\.\."/);
});

/* ------------------------------ wiring ------------------------------ */

test("wiring: every job runs inside stallWatch.run; both runners race the guard and apply the stall to the result", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /stallWatch\.install\(\)/);
  assert.match(server, /stallWatch\.run\(String\(job\._id\), \(\) => \(part \? partRunner\.runPartJob\(partRunnerDeps, job\) : runPolicyJob\(job\)\)\)/);
  assert.match(server, /stallWatch\.guard\(job\._id, fillFormPromise\)/);
  const runner = fs.readFileSync(path.join(ROOT, "lib", "partRunner.js"), "utf8");
  assert.match(runner, /Promise\.race\(\[stallWatch\.guard\(claimed\._id, run\), timeoutPromise\]\)/);
  assert.match(runner, /result = stallWatch\.applyToResult\(claimed\._id, result\)/);
  assert.match(runner, /isJobTimeout\(e\) \|\| stallWatch\.isStallError\(e\)/, "a stuck run after the proposal was saved is not re-run automatically");
});
