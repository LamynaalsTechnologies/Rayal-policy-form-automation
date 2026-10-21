/**
 * Hold pressed in the MIDDLE of a running step (lib/holdStop.js armLiveHold): the run stops at once, not at the next
 * step boundary. Fakes only — a fake driver, a fake queue collection, no database, no browser.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { armLiveHold, disarmLiveHold, liveHoldStopOf, stopIfHeld, isHoldStop } = require("../lib/holdStop");
const { isAutomationStop } = require("../automationStopper");

const ROOT = path.join(__dirname, "..");
const silent = () => {};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A queue whose job can be given a hold request while "the run" is going on. */
const queue = () => {
  const doc = { _id: "j1", parts: [] };
  return {
    doc,
    async findOne(filter) {
      if (filter.holdRequested && !doc.holdRequested) return null;
      return doc;
    },
  };
};
/** A driver like selenium's: every call goes through execute(command). */
const fakeDriver = () => {
  const sent = [];
  const driver = {
    sent,
    async execute(command) {
      sent.push(command.getName());
      return "ok";
    },
    findElement() {
      return this.execute({ getName: () => "findElement" });
    },
    quit() {
      return this.execute({ getName: () => "quit" });
    },
  };
  return driver;
};
const opts = (collection) => ({ collection, log: silent, intervalMs: 10, env: {} });

test("no hold: the driver works as before", async () => {
  const q = queue();
  const driver = fakeDriver();
  armLiveHold(driver, { _jobId: "j1" }, opts(q));
  assert.equal(await driver.findElement(), "ok");
  await wait(40);
  assert.equal(await driver.findElement(), "ok");
  disarmLiveHold({ _jobId: "j1" });
  assert.equal(liveHoldStopOf({ _jobId: "j1" }), null);
});

test("a hold pressed while a step runs: the next browser command fails with the hold-stop; quit still works", async () => {
  const q = queue();
  const driver = fakeDriver();
  const data = { _jobId: "j1" };
  armLiveHold(driver, data, opts(q));
  await driver.findElement();
  q.doc.holdRequested = { at: new Date(), by: "u1" };
  await wait(60);
  let caught = null;
  try {
    await driver.findElement();
  } catch (e) {
    caught = e;
  }
  assert.ok(isAutomationStop(caught), "an automation stop, so every catch lets it through");
  assert.equal(isHoldStop(caught), true);
  assert.equal(caught.details.heldBy, "u1");
  assert.equal(caught.message.includes(":"), false, "the operator error rule: no colon");
  assert.equal(liveHoldStopOf(data), caught);
  const before = driver.sent.length;
  await driver.quit(); // the cleanup must be able to close the window
  assert.equal(driver.sent.length, before + 1);
  disarmLiveHold(data);
  assert.equal(await driver.findElement(), "ok", "disarmed: the driver is its own again");
});

test("passing the payment point disarms it: a hold asked later never cuts a payment", async () => {
  const q = queue();
  const driver = fakeDriver();
  const data = { _jobId: "j1" };
  armLiveHold(driver, data, opts(q));
  await stopIfHeld(data, "before the payment (the KYC is done)", { collection: q, log: silent, env: {} });
  q.doc.holdRequested = { at: new Date(), by: "u1" };
  await wait(60);
  assert.equal(await driver.findElement(), "ok");
  assert.equal(liveHoldStopOf(data), null);
  // ...while the old boundary check still stops at "before Pay"
  await assert.rejects(() => stopIfHeld(data, "before Pay (nothing is paid)", { collection: q, log: silent, env: {} }), isAutomationStop);
});

test("JOB_HOLD_REQUEST_ENABLED off: nothing is armed", async () => {
  const q = queue();
  const driver = fakeDriver();
  const original = driver.execute;
  assert.equal(armLiveHold(driver, { _jobId: "j1" }, { ...opts(q), env: { JOB_HOLD_REQUEST_ENABLED: "false" } }), false);
  assert.equal(driver.execute, original);
});

test("a failed read of the queue never stops a run", async () => {
  const driver = fakeDriver();
  armLiveHold(driver, { _jobId: "j1" }, opts({ findOne: async () => { throw new Error("db down"); } }));
  await wait(40);
  assert.equal(await driver.findElement(), "ok");
  disarmLiveHold({ _jobId: "j1" });
});

test("a stage 'failed' written while a hold unwinds the run is dropped", async () => {
  const { markStage } = require("../fullPolicycompany/reliance/relianceStages");
  const q = queue();
  const driver = fakeDriver();
  const data = { _jobId: "j1", _id: "507f1f77bcf86cd799439011" };
  armLiveHold(driver, data, opts(q));
  q.doc.holdRequested = { at: new Date(), by: "u1" };
  await wait(60);
  assert.ok(liveHoldStopOf(data));
  assert.equal(await markStage(data, "kyc", "failed", { error: "x" }), false);
  disarmLiveHold(data);
});

test("every company's form arms it, convert a swallowed error into the stop, and disarm before the cleanup", () => {
  const forms = [
    "fullPolicycompany/kshemaForm.js",
    "multiCompany/tpCompany/kshemaTP/kshemaTPForm.js",
    "fullPolicycompany/relianceForm.js",
    "multiCompany/common/reliance/relianceMultiForm.js",
    "fullPolicycompany/national.js",
    "multiCompany/tpCompany/nationalTP/nationalTPForm.js",
    "multiCompany/common/runHandler.js",
  ];
  for (const f of forms) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.match(src, /armLiveHold\(driver, data\);/, f);
    assert.match(src, /liveHoldStopOf\(data\)\) (error|e) = liveHoldStopOf\(data\);/, f);
    assert.match(src, /disarmLiveHold\(data\);/, f);
    assert.ok(src.indexOf("armLiveHold(driver, data);") > src.indexOf("startRecording(driver"), f);
  }
});
