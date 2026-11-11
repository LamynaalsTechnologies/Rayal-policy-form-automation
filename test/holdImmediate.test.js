// Run with: node --require ./test/support/noRealWorld.js --test test/holdImmediate.test.js
//
// "Hold" stops a running policy AT ONCE, wherever it is, for every company (the owner, 2026-11-11): past the payment
// point too; only the money press itself (note -> insurer's answer saved) holds it back, and then it fires at once.
// A run that does not let go has its window closed, and the queue stops waiting for it. Fakes only - no DB, no browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { armLiveHold, disarmLiveHold, liveHoldStopOf, isHoldStop, holdBackForPayment, stopIfHeld } = require("../lib/holdStop");
const stallWatch = require("../lib/stallWatch");
const { isAutomationStop } = require("../automationStopper");

const ROOT = path.join(__dirname, "..");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const silent = () => {};

const queue = (id) => {
  const doc = { _id: id, parts: [] };
  return {
    doc,
    async findOne(filter) {
      if (filter.holdRequested && !doc.holdRequested) return null;
      return doc;
    },
  };
};
const fakeDriver = () => ({
  async execute(command) {
    return command.getName();
  },
  findElement() {
    return this.execute({ getName: () => "findElement" });
  },
  click() {
    return this.execute({ getName: () => "elementClick" });
  },
  quit() {
    return this.execute({ getName: () => "quit" });
  },
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },
});
const opts = (q, extra = {}) => ({ collection: q, log: silent, intervalMs: 10, env: {}, closeAfterMs: 1e6, ...extra });
const isHeldStop = (e) => isAutomationStop(e) && isHoldStop(e);

test("the money press: a Hold pressed during it waits - the press and the answer go through - then fires at once", async () => {
  const q = queue("m1");
  const data = { _jobId: "m1" };
  const driver = fakeDriver();
  const lines = [];
  armLiveHold(driver, data, opts(q, { log: (l) => lines.push(l) }));
  const paymentRecorded = holdBackForPayment(driver);
  q.doc.holdRequested = { by: "op" };
  await wait(60);
  assert.equal(await driver.click(), "elementClick", "the press is never refused");
  await driver.sleep(5); // the wait for the insurer's answer is not cut either
  assert.equal(liveHoldStopOf(data), null);
  assert.match(lines.join("\n"), /while the payment is being made - it stops right after the insurer's answer is saved/);
  paymentRecorded(); // the answer is on the note
  await assert.rejects(() => driver.findElement(), isHeldStop, "the very next command is the stop");
  paymentRecorded(); // twice is harmless
  disarmLiveHold(data);
});

test("a Hold that fired BEFORE the money press: nothing is held back, the press itself is refused (nothing is paid)", async () => {
  const q = queue("m2");
  const data = { _jobId: "m2" };
  const driver = fakeDriver();
  armLiveHold(driver, data, opts(q));
  q.doc.holdRequested = { by: "op" };
  await wait(60);
  const paymentRecorded = holdBackForPayment(driver);
  await assert.rejects(() => driver.click(), isHeldStop);
  paymentRecorded();
  disarmLiveHold(data);
});

test("no live hold armed (switch off, a test driver): holding back is a no-op", () => {
  const release = holdBackForPayment(fakeDriver());
  assert.equal(typeof release, "function");
  release();
  holdBackForPayment(null)();
});

test("past the payment point the Hold is still armed; the stuck-step watch is the one that is paused", async () => {
  const q = queue("m3");
  const data = { _jobId: "m3" };
  const driver = fakeDriver();
  armLiveHold(driver, data, opts(q));
  await stopIfHeld(data, "before Pay (nothing is paid)", { collection: q, env: {}, log: silent });
  q.doc.holdRequested = { by: "op" };
  await wait(60);
  await assert.rejects(() => driver.findElement(), isHeldStop);
  disarmLiveHold(data);
});

test("a run that does not let go of the browser: its window is closed; a run that unwinds in time is never touched", async () => {
  const closed = [];
  const q = queue("m4");
  const data = { _jobId: "m4" };
  armLiveHold(fakeDriver(), data, opts(q, { closeAfterMs: 40, closeWindow: async (k) => closed.push(k) }));
  q.doc.holdRequested = { by: "op" };
  await wait(150);
  assert.deepEqual(closed, ["m4"]);
  disarmLiveHold(data);

  const closed2 = [];
  const q2 = queue("m5");
  const data2 = { _jobId: "m5" };
  armLiveHold(fakeDriver(), data2, opts(q2, { closeAfterMs: 80, closeWindow: async (k) => closed2.push(k) }));
  q2.doc.holdRequested = { by: "op" };
  await wait(40); // fired
  disarmLiveHold(data2); // the run unwound by itself and cleaned up
  await wait(120);
  assert.deepEqual(closed2, [], "a run that let go is not closed under its own cleanup");
});

test("the queue stops waiting for a held run that never ends: guard() rejects with the hold-stop (recorded as held)", async () => {
  const q = queue("m6");
  const data = { _jobId: "m6" };
  const started = Date.now();
  const outcome = await stallWatch.run("m6", async () => {
    armLiveHold(fakeDriver(), data, opts(q, { giveUpMs: 50 }));
    const never = new Promise(() => {}); // stuck somewhere no browser command reaches
    setTimeout(() => (q.doc.holdRequested = { by: "op" }), 20);
    // every timer of the hold is unref'd (it never keeps the server alive): this ref'd one keeps the test alive and
    // ends it with "still waiting" when nothing gives up
    return Promise.race([
      stallWatch.guard("m6", never).then(
        () => "resolved",
        (e) => e
      ),
      wait(1000).then(() => "still waiting after 1 s"),
    ]);
  });
  assert.ok(isHeldStop(outcome), String((outcome && outcome.message) || outcome));
  assert.ok(Date.now() - started < 1000, "within the give-up time, not the 15-minute job timeout");
  disarmLiveHold(data);
  stallWatch.disarm(data);
});

test("a run that ends by itself is not affected by the give-up timer", async () => {
  const q = queue("m7");
  const data = { _jobId: "m7" };
  const out = await stallWatch.run("m7", async () => {
    armLiveHold(fakeDriver(), data, opts(q, { giveUpMs: 50 }));
    return stallWatch.guard("m7", Promise.resolve({ success: true }));
  });
  assert.deepEqual(out, { success: true });
  disarmLiveHold(data);
  stallWatch.disarm(data);
});

test("every company, full and multiple: the live Hold is armed right after the window opens and only switched off at cleanup", () => {
  const flows = [
    "fullPolicycompany/relianceForm.js",
    "fullPolicycompany/kshemaForm.js",
    "fullPolicycompany/national.js",
    "multiCompany/common/reliance/relianceMultiForm.js", // Reliance OD / TP
    "multiCompany/tpCompany/kshemaTP/kshemaTPForm.js",
    "multiCompany/tpCompany/nationalTP/nationalTPForm.js",
    "multiCompany/common/runHandler.js", // United India and every runHandler insurer
  ];
  for (const rel of flows) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes("armLiveHold(driver, data"), `${rel} arms the live Hold`);
    const disarms = src.split("\n").filter((l) => l.includes("disarmLiveHold(data)") && !l.trim().startsWith("//") && !l.includes("require("));
    for (const line of disarms) {
      assert.ok(
        /before the cleanup|^\s*disarmLiveHold\(data\);\s*$/.test(line),
        `${rel}: the Hold is only switched off at cleanup, found "${line.trim()}"`
      );
    }
  }
  // the two KSHEMA recovery branches (an ISSUED policy, never pays) pause only the stuck-step watch
  for (const rel of ["fullPolicycompany/kshemaForm.js", "multiCompany/tpCompany/kshemaTP/kshemaTPForm.js"]) {
    assert.ok(fs.readFileSync(path.join(ROOT, rel), "utf8").includes("pastPaymentPoint(data); // past the payment"), rel);
  }
});

test("the money press is held back in both payments that move money (Reliance CDT Submit Details, KSHEMA CD Balance)", () => {
  for (const rel of ["fullPolicycompany/reliance/relianceWalletIssue.js", "fullPolicycompany/kshema/kshemaWalletIssue.js"]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes('const { holdBackForPayment } = require("../../lib/holdStop");'), rel);
    assert.ok(src.includes("(deps.holdBackForPayment || holdBackForPayment)(driver)"), rel);
  }
});

test("the queue's guard works with the job's ObjectId (partRunner passes claimed._id) - it was silently off before", async () => {
  const { ObjectId } = require("mongodb");
  const id = new ObjectId();
  await stallWatch.run(String(id), async () => {
    const never = new Promise(() => {});
    assert.notEqual(stallWatch.guard(id, never), never, "guarded");
  });
});
