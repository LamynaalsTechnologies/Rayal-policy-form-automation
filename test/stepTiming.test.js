"use strict";

// lib/stepTiming.js - the [timing] lines. No browser, no network, no database:
// node --require ./test/support/noRealWorld.js --test test/stepTiming.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { WebElementPromise, WebElement } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");

const timing = require("../lib/stepTiming");
const { armLiveHold, disarmLiveHold } = require("../lib/holdStop");

let now = 1000;
const advance = (ms) => {
  now += ms;
};

test.beforeEach(() => {
  now = 1000;
  timing._setClock(() => now);
  timing._reset();
});
test.after(() => {
  timing._reset();
  timing._setClock(null);
});

// The [timing] lines printed during fn(); every other line still reaches the console.
async function captureLines(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    const text = args.map(String).join(" ");
    if (text.startsWith("[timing]")) lines.push(text);
    else original(...args);
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// "[timing] a=1 b=x" -> { a: "1", b: "x" }
function fieldsOf(line) {
  const out = {};
  for (const token of line.replace(/^\[timing\]\s*/, "").split(" ")) {
    const at = token.indexOf("=");
    out[token.slice(0, at)] = token.slice(at + 1);
  }
  return out;
}

/** A selenium-like driver class: every command goes through execute(); sleep and wait like selenium's. Each call
 *  moves the fake clock by a set amount, so the numbers in the lines are exact. */
function driverClass() {
  class FakeDriver {
    constructor() {
      this.commandMs = 40;
      this.failOn = null;
    }

    async execute(command) {
      const name = command.getName();
      advance(this.commandMs);
      if (this.failOn === name) throw new Error(`${name} failed`);
      return `${name}-ok`;
    }

    sleep(ms) {
      advance(ms);
      return Promise.resolve();
    }

    // like selenium: polls the condition; an element condition gives back a WebElementPromise
    wait(condition, timeout = 0, message, pollMs = 0, { extraMs = 0, element = null } = {}) {
      const result = Promise.resolve()
        .then(() => condition())
        .then((value) => {
          advance(extraMs);
          return element || value;
        });
      return element ? new WebElementPromise(this, result) : result;
    }

    click() {
      return this.execute({ getName: () => "clickElement" });
    }

    find() {
      return this.execute({ getName: () => "findElement" });
    }
  }
  assert.equal(timing.installDriverTiming(FakeDriver, { WebElementPromise }), true);
  return FakeDriver;
}

const customerData = () => ({
  _jobId: "6740a1b2c3d4e5f607182930",
  _runId: "1a2b3c4d-1111-2222-3333-444455556666",
  _partKey: "motor",
  firstName: "Ravi",
  lastName: "Kumar",
  mobileNumber: "9876543210",
  policyNumber: "OG-25-1234-5678",
  registrationNumber: "TN01AB1234",
});

test("format drops empty values and keeps one token per value", () => {
  assert.equal(timing._format({ a: 1, b: "two words", c: null, d: undefined, e: "", f: "x=y" }), "a=1 b=two_words f=x:y");
});

test("a run prints one line per step and one end line: sleeps, waits, commands and the rest, never customer data", async () => {
  const Driver = driverClass();
  const driver = new Driver();
  const data = customerData();

  const lines = await captureLines(async () => {
    timing.noteRun(data._runId, { company: "KSHEMA", part: "motor", jobId: data._jobId });
    advance(1500); // data loading before the browser opens
    timing.attach(driver, data);

    await driver.click(); // 40 ms
    await driver.find(); // 40 ms
    await driver.sleep(2000);
    await driver.wait(() => driver.find(), 10000, undefined, 0, { extraMs: 960 }); // 40 ms command inside + 960 ms
    advance(300); // our own code
    timing.stepDone(data, "proposal", "completed");

    await driver.sleep(500);
    await driver.click();
    timing.stepDone(data, "kyc", "completed");
    timing.runEnded(data._runId, "completed");
    timing.runEnded(data._runId, "again"); // a second end is ignored
  });

  assert.equal(lines.length, 3);
  const [proposal, kyc, end] = lines.map(fieldsOf);
  assert.deepEqual(proposal, {
    event: "step",
    run: "1a2b3c4d",
    company: "kshema",
    part: "motor",
    job: data._jobId,
    step: "proposal",
    status: "completed",
    wallMs: "3380",
    sleepMs: "2000",
    sleeps: "1",
    waitMs: "1000",
    waits: "1",
    cmdMs: "80",
    cmds: "2",
    otherMs: "300",
    top: "findElement:2/80/40/40,clickElement:1/40/40/40",
  });
  assert.equal(kyc.step, "kyc");
  assert.equal(kyc.wallMs, "540");
  assert.equal(kyc.sleepMs, "500");
  assert.equal(kyc.cmdMs, "40");
  assert.equal(end.event, "end");
  assert.equal(end.outcome, "completed");
  assert.equal(end.totalMs, "5420", "from the run start, including the 1.5 s before the browser opened");
  assert.equal(end.wallMs, "3920", "from the browser being linked");
  assert.equal(end.sleepMs, "2500");
  assert.equal(end.cmds, "3");
  assert.equal(end.windows, "1", "only this run's own window was open");
  for (const key of ["loopLateP50Ms", "loopLateP99Ms", "loopLateMaxMs"]) assert.match(end[key], /^\d+$/);

  const all = lines.join("\n");
  for (const secret of ["Ravi", "Kumar", "9876543210", "OG-25-1234-5678", "TN01AB1234", "1111-2222"]) {
    assert.ok(!all.includes(secret), `no customer data or full run id in the lines (${secret})`);
  }
});

test("a driver of no run passes straight through: same results, no lines, nothing added to the driver", async () => {
  const Driver = driverClass();
  const driver = new Driver();
  const lines = await captureLines(async () => {
    assert.equal(await driver.click(), "clickElement-ok");
    await driver.sleep(10);
    assert.equal(await driver.wait(() => 7), 7);
  });
  assert.deepEqual(lines, []);
  for (const method of ["execute", "sleep", "wait"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(driver, method), false, method);
  }
});

test("errors and values come back exactly as before; an element wait still gives an element promise", async () => {
  const Driver = driverClass();
  const driver = new Driver();
  const data = customerData();
  timing.noteRun(data._runId, { company: "reliance", part: "motor", jobId: data._jobId });
  timing.attach(driver, data);

  driver.failOn = "clickElement";
  await assert.rejects(() => driver.click(), (e) => e.message === "clickElement failed");
  assert.equal(await driver.find(), "findElement-ok");

  const element = new WebElement(driver, "element-1");
  const promised = driver.wait(() => true, 1000, undefined, 0, { element });
  assert.ok(promised instanceof WebElementPromise, "chaining .click() on the wait keeps working");
  assert.equal(await promised, element);
  assert.equal(await promised.getId(), "element-1");

  await assert.rejects(
    () => driver.wait(() => Promise.reject(new Error("Waiting for element timed out"))),
    /timed out/
  );
  const lines = await captureLines(async () => timing.runEnded(data._runId, "failed"));
  const end = fieldsOf(lines[0]);
  assert.equal(end.cmds, "2", "the failed click and the find");
  assert.equal(end.waits, "2", "the element wait and the failed wait");
});

test("installing twice does not wrap twice", () => {
  const Driver = driverClass();
  assert.equal(timing.installDriverTiming(Driver, { WebElementPromise }), false);
  assert.equal(timing.installDriverTiming(null), false);
});

test("armLiveHold links the window; the stall watch and the hold keep their own wrappers and give the driver back", async () => {
  const Driver = driverClass();
  const driver = new Driver();
  const data = customerData();
  timing.noteRun(data._runId, { company: "national", part: "motor", jobId: data._jobId });

  armLiveHold(driver, data, { env: { JOB_HOLD_REQUEST_ENABLED: "false" }, collection: null, log: () => {} });
  assert.equal(Object.prototype.hasOwnProperty.call(driver, "sleep"), false, "sleep is left alone (hold off)");
  await driver.click(); // goes through the stall watch's wrapper, then the timing on the class
  await driver.sleep(100);
  disarmLiveHold(data);
  assert.equal(Object.prototype.hasOwnProperty.call(driver, "execute"), false, "the class's own execute again");
  assert.equal(driver.execute, Driver.prototype.execute);

  const lines = await captureLines(async () => timing.runEnded(data._runId, "completed"));
  const end = fieldsOf(lines[0]);
  assert.equal(end.company, "national");
  assert.equal(end.cmds, "1");
  assert.equal(end.sleepMs, "100");
});

test("database connects: a slow one gets its own line and counts on its run", async () => {
  const Driver = driverClass();
  const driver = new Driver();
  const data = customerData();
  class FakeClient {
    async connect() {
      advance(this.ms);
      return this;
    }
  }
  let current = data._jobId;
  assert.equal(timing.installDbConnectTiming(FakeClient, { currentKey: () => current }), true);
  assert.equal(timing.installDbConnectTiming(FakeClient), false, "once only");

  timing.noteRun(data._runId, { company: "reliance", part: "od", jobId: data._jobId });
  timing.attach(driver, data);
  const lines = await captureLines(async () => {
    const quick = new FakeClient();
    quick.ms = 50;
    assert.equal(await quick.connect(), quick);
    const slow = new FakeClient();
    slow.ms = 1800;
    await slow.connect();
    current = null; // outside any run: still timed, no run fields
    const outside = new FakeClient();
    outside.ms = 900;
    await outside.connect();
    timing.stepDone(data, "proposal", "completed");
  });
  assert.equal(lines.length, 3);
  assert.deepEqual(fieldsOf(lines[0]), { event: "db-connect", ms: "1800", run: "1a2b3c4d", company: "reliance", part: "od", job: data._jobId });
  assert.deepEqual(fieldsOf(lines[1]), { event: "db-connect", ms: "900" });
  const step = fieldsOf(lines[2]);
  assert.equal(step.dbConnects, "2");
  assert.equal(step.dbConnectMs, "1850");
  assert.equal(step.otherMs, "2750", "connect time is part of 'other'");
});

test("browser-open says how the browser was started, never more", async () => {
  const options = new chrome.Options();
  options.addArguments("--headless=new", "--window-size=1366,768", "--disable-gpu", "--no-sandbox");
  const plain = new chrome.Options();
  const driver = {};
  const lines = await captureLines(async () => {
    const startedAt = timing.clock();
    advance(4200);
    timing.browserOpened(driver, { flow: "reliance", startedAt, options, driverPath: null });
    timing.browserOpened({}, { flow: "national", options: plain, driverPath: "/usr/local/bin/chromedriver" });
  });
  assert.deepEqual(fieldsOf(lines[0]), {
    event: "browser-open",
    flow: "reliance",
    startMs: "4200",
    headless: "yes",
    window: "1366x768",
    gpu: "off",
    driver: "selenium-manager",
  });
  assert.deepEqual(fieldsOf(lines[1]), { event: "browser-open", flow: "national", headless: "no", window: "default", gpu: "on", driver: "chromedriver" });

  // the start time rides along to the run's end line
  const data = customerData();
  timing.noteRun(data._runId, { company: "reliance", part: "motor", jobId: data._jobId });
  timing.attach(driver, data);
  const end = await captureLines(async () => timing.runEnded(data._runId, "completed"));
  assert.equal(fieldsOf(end[0]).browserStartMs, "4200");
});

test("activeRuns counts linked runs that have not ended, and can leave one out", () => {
  const Driver = driverClass();
  const a = customerData();
  const b = { ...customerData(), _runId: "9f9f9f9f-aaaa", _jobId: "6740a1b2c3d4e5f607182931" };
  timing.noteRun(a._runId, { company: "kshema", part: "motor", jobId: a._jobId });
  timing.noteRun(b._runId, { company: "kshema", part: "motor", jobId: b._jobId });
  assert.equal(timing.activeRuns(), 0, "noted, but no browser yet");
  timing.attach(new Driver(), a);
  timing.attach(new Driver(), b);
  assert.equal(timing.activeRuns(), 2);
  assert.equal(timing.activeRuns({ exceptRunId: a._runId }), 1);
  timing.runEnded(a._runId, "completed");
  assert.equal(timing.activeRuns(), 1);
});

test("a run without a browser (an API-only part) prints nothing", async () => {
  const lines = await captureLines(async () => {
    timing.noteRun("brisk-run-1", { company: "brisk", part: "pa", jobId: "j9" });
    timing.stepDone({ _runId: "brisk-run-1", _jobId: "j9" }, "proposal", "completed");
    timing.runEnded("brisk-run-1", "completed");
  });
  assert.deepEqual(lines, []);
});

test("nothing throws on odd input", async () => {
  await captureLines(async () => {
    timing.noteRun(null);
    timing.noteRun("x", null || undefined);
    timing.attach(null, null);
    timing.attach({}, {});
    timing.attach({}, { _jobId: "only-a-job" });
    timing.stepDone(null, "proposal");
    timing.stepDone({ _runId: "missing" }, "kyc");
    timing.runEnded(undefined);
    timing.runEnded("missing");
    timing.browserOpened(null);
    timing.browserOpened({}, { options: { CAPABILITY_KEY: "k", get() { throw new Error("x"); } } });
    timing.emit({ bad: { toString() { throw new Error("boom"); } } });
  });
});
