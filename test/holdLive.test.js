/**
 * Hold pressed in the MIDDLE of a running step (lib/holdStop.js armLiveHold): the run stops at once, not at the next
 * step boundary. Fakes only — a fake driver, a fake queue collection, no database, no browser.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { armLiveHold, disarmLiveHold, liveHoldStopOf, stopIfHeld, isHoldStop, throwIfHeld } = require("../lib/holdStop");
const { isAutomationStop, AutomationStoppedError } = require("../automationStopper");
const section = require("../fullPolicycompany/kshema/kshemaSection");
const kshemaFields = require("../fullPolicycompany/kshema/kshemaFields");

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

test("JOB_HOLD_REQUEST_ENABLED off: no hold is armed (only the stuck-step watch, lib/stallWatch.js), and disarm gives execute back", async () => {
  const q = queue();
  const driver = fakeDriver();
  const original = driver.execute;
  assert.equal(armLiveHold(driver, { _jobId: "j1" }, { ...opts(q), env: { JOB_HOLD_REQUEST_ENABLED: "false" } }), false);
  assert.equal(await driver.findElement(), "ok", "commands still go through");
  disarmLiveHold({ _jobId: "j1" });
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

/* ── Hold on a run whose helpers catch every error (2026-10-31, a live KSHEMA run went on through every remaining field) ── */

/** A driver like selenium's, on a page with none of the fields. sleep is really a timer; a long one never holds the test up. */
class EmptyPageDriver {
  async execute(command) {
    (this.sent = this.sent || []).push(command.getName());
    return [];
  }
  findElements() {
    return this.execute({ getName: () => "findElements" });
  }
  findElement() {
    return this.execute({ getName: () => "findElement" });
  }
  takeScreenshot() {
    return this.execute({ getName: () => "screenshot" });
  }
  executeScript() {
    return this.execute({ getName: () => "executeScript" });
  }
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (ms > 1000) timer.unref();
    });
  }
}
const box = (label) => ({ key: label, label, type: "text", selectors: [`input[data-iid="${label}"]`], value: () => "X", required: true });
const noWaits = { waitForLoader: async () => {}, readToast: async () => null };
const data = { _jobId: "j1" };
const hold = async (q) => {
  q.doc.holdRequested = { by: "op" };
  await wait(30);
};
/** Fails instead of waiting out a run that keeps going. */
const within = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms).unref())]);
const printing = () => {
  const lines = [];
  const saved = ["log", "warn", "error"].map((k) => [k, console[k]]);
  saved.forEach(([k]) => (console[k] = (...a) => lines.push(a.join(" "))));
  return { lines, restore: () => saved.forEach(([k, f]) => (console[k] = f)) };
};

test("KSHEMA, the live case: Hold while a field is being looked for ends the section at once, nothing else is tried or reported missing", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const out = printing();
  try {
    // the real field helpers, with their real 10 s wait for each missing field
    const running = section.fillSection(driver, data, [box("Variant"), box("Engine Number"), box("Chassis Number")], "vehicle details", null, noWaits).then(() => null, (e) => e);
    await wait(100);
    const pressed = Date.now();
    await hold(q);
    assert.ok(isHoldStop(await within(running, 3000)));
    assert.ok(Date.now() - pressed < 1000, "stopped within a second");
    assert.deepEqual(out.lines, [], "no field is reported missing or failed");
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("KSHEMA: a helper that swallows the Hold and answers 'not on the page': no failure, no second try, the next field untouched", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const calls = [];
  const typeIntoField = async (d, selectors, value, label) => {
    calls.push(label);
    await hold(q);
    return { ok: false, value: null, reason: `the "${label}" box was not on the page` };
  };
  const out = printing();
  try {
    await assert.rejects(section.fillSection(driver, data, [box("Variant"), box("Engine Number")], "vehicle details", null, { ...noWaits, handlers: { typeIntoField } }), (e) => isHoldStop(e));
    assert.deepEqual(calls, ["Variant"]);
    assert.deepEqual(out.lines, []);
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("KSHEMA: a Hold during the read-back of filled fields is not an all-fine section", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const typeIntoField = async () => ({ ok: true, value: "X", reason: null });
  const readState = async () => {
    await hold(q);
    throw new Error("the browser refused");
  };
  const out = printing();
  try {
    await assert.rejects(section.fillSection(driver, data, [box("Variant")], "vehicle details", null, { ...noWaits, handlers: { typeIntoField }, readState }), (e) => isHoldStop(e));
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("KSHEMA: before Save and after a silent Save, a Hold ends the step instead of reporting the fields", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const typeIntoField = async () => ({ ok: true, value: "X", reason: null });
  const holding = async () => ({ holds: true, actual: "X" });
  const out = printing();
  try {
    await section.fillSection(driver, data, [box("Variant")], "vehicle details", null, { ...noWaits, handlers: { typeIntoField }, readState: holding });
    await hold(q);
    await assert.rejects(section.recheckBeforeSave(driver, { handlers: { typeIntoField }, readState: holding }), (e) => isHoldStop(e));
    await assert.rejects(section.afterSilentSave(driver, { fallbackError: "Save did nothing", readInvalid: async () => [] }), (e) => isHoldStop(e));
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("KSHEMA: a Hold during the very last read-back before Save is seen, not reported as all fine", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const typeIntoField = async () => ({ ok: true, value: "X", reason: null });
  const out = printing();
  try {
    await section.fillSection(driver, data, [box("Variant")], "vehicle details", null, { ...noWaits, handlers: { typeIntoField }, readState: async () => ({ holds: true, actual: "X" }) });
    const readState = async () => {
      await hold(q);
      throw new Error("the browser refused");
    };
    await assert.rejects(section.recheckBeforeSave(driver, { handlers: { typeIntoField }, readState }), (e) => isHoldStop(e));
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("KSHEMA field helpers: a held run prints no 'intercepted' or 'not found' line, and a recovery does not swallow the stop", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const element = {
    click: async () => {
      await hold(q);
      throw new Error("the browser refused the click");
    },
  };
  const out = printing();
  try {
    await assert.rejects(kshemaFields.clickElement(driver, element, "the Model choice"), (e) => isHoldStop(e));
    await assert.rejects(kshemaFields.dumpAvailableControls(driver, "Variant"), (e) => isHoldStop(e));
    const run = async () => {
      throw liveHoldStopOf(data);
    };
    await assert.rejects(kshemaFields.findAfterRecovery(driver, ["input"], "Variant", { tries: 2, run }), (e) => isHoldStop(e));
    assert.deepEqual(out.lines, []);
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("a read still on its way when the payment point disarms the run cannot fire afterwards", async () => {
  let answer;
  const collection = { findOne: () => new Promise((resolve) => (answer = resolve)) };
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, { collection, log: silent, intervalMs: 5, env: {} });
  await wait(20);
  disarmLiveHold(data);
  answer({ _id: "j1", holdRequested: { by: "op" } });
  await wait(20);
  throwIfHeld(driver);
  assert.equal(liveHoldStopOf(data), null);
  await driver.sleep(5);
});

test("KSHEMA: a Breaker / stopper inside a field ends the section too, it is not that field's failure", async () => {
  const typeIntoField = async () => {
    throw new AutomationStoppedError("Stopped here on purpose");
  };
  const out = printing();
  try {
    await assert.rejects(section.fillSection(new EmptyPageDriver(), {}, [box("Variant")], "vehicle details", null, { ...noWaits, handlers: { typeIntoField } }), (e) => isAutomationStop(e));
  } finally {
    out.restore();
  }
});

test("no hold: a field that fails stays that field's failure, and the section goes on as before", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  const calls = [];
  const typeIntoField = async (d, selectors, value, label) => {
    calls.push(label);
    if (label === "Variant") throw new Error("stale element");
    return { ok: true, value: "X", reason: null };
  };
  const out = printing();
  try {
    const result = await section.fillSection(driver, data, [box("Variant"), box("Engine Number")], "vehicle details", null, { ...noWaits, handlers: { typeIntoField }, readState: async () => null });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures.map((f) => f.label), ["Variant"]);
    assert.deepEqual(calls, ["Variant", "Engine Number", "Variant"]);
  } finally {
    out.restore();
    disarmLiveHold(data);
  }
});

test("every company's waits: a long driver.sleep is cut by the Hold, later ones are refused, and disarm gives the driver its own sleep back", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  await driver.sleep(5);
  const longWait = driver.sleep(30000);
  const pressed = Date.now();
  await hold(q);
  await assert.rejects(within(longWait, 1000), (e) => isHoldStop(e));
  assert.ok(Date.now() - pressed < 500);
  await assert.rejects(driver.sleep(5), (e) => isHoldStop(e));
  assert.throws(() => throwIfHeld(driver), (e) => isHoldStop(e));
  disarmLiveHold(data);
  assert.equal(Object.prototype.hasOwnProperty.call(driver, "sleep"), false, "the class's own sleep again");
  await driver.sleep(5);
});

test("a wait nobody awaits, cut by a Hold, does not take the server down", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  driver.sleep(30000);
  await hold(q);
  driver.sleep(5);
  await wait(40);
  disarmLiveHold(data);
});

test("a retry loop whose catch swallows the refusal does not freeze the other job in this process", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  await hold(q);
  let ticks = 0;
  const other = setInterval(() => (ticks += 1), 5);
  const until = Date.now() + 150;
  while (Date.now() < until) {
    try {
      await driver.findElement();
    } catch (e) {}
  }
  const onCommands = ticks;
  const untilSleeps = Date.now() + 150;
  while (Date.now() < untilSleeps) {
    try {
      await driver.sleep(1);
    } catch (e) {}
  }
  clearInterval(other);
  disarmLiveHold(data);
  assert.ok(onCommands >= 5, `the other job got ${onCommands} turns during the commands`);
  assert.ok(ticks - onCommands >= 5, `the other job got ${ticks - onCommands} turns during the waits`);
});

test("past the payment point nothing changes: sleep works, throwIfHeld stays quiet, a later Hold cuts nothing", async () => {
  const q = queue();
  const driver = new EmptyPageDriver();
  armLiveHold(driver, data, opts(q));
  await stopIfHeld(data, "before the payment (the KYC is done)", { collection: q, env: {}, log: silent });
  await hold(q);
  await wait(30);
  await driver.sleep(5);
  throwIfHeld(driver);
  await driver.findElement();
  assert.equal(Object.prototype.hasOwnProperty.call(driver, "sleep"), false);
});

test("JOB_HOLD_REQUEST_ENABLED off: sleep is left alone and throwIfHeld is quiet", async () => {
  const driver = new EmptyPageDriver();
  const { armLiveHold: arm } = require("../lib/holdStop");
  arm(driver, data, { collection: queue(), log: silent, intervalMs: 10, env: { JOB_HOLD_REQUEST_ENABLED: "false" } });
  assert.equal(Object.prototype.hasOwnProperty.call(driver, "sleep"), false);
  throwIfHeld(driver);
  disarmLiveHold(data);
  throwIfHeld(null);
});

test("both KSHEMA forms: every step before the payment asks throwIfHeld before its failure report, and a held screenshot says nothing", () => {
  const steps = [
    "proposalPage = await openSavedProposal\\(driver, resume\\);\\n[^\\n]*getTitle[^\\n]*",
    "customer = await fillCustomerDetails\\(driver, data, capture\\);",
    "vehicle = await fillVehicleDetails\\(driver, data, capture\\);",
    "paCover = await fillPaCoverDetails\\(driver, data, capture\\);",
    "premium = await fillPremiumDetails\\(driver, data, capture\\);",
    "const submitResult = await submitQuoteForm\\(driver\\);",
    "addonsResult = await fillAddonsDetails\\(driver, data, capture\\);",
    "const downloadResult = await downloadProposal\\([^\\n]*\\);",
    "const nomineeResult = await fillNomineeDetails\\(driver, data, capture\\);",
    "proposalPage = await awaitProposalPage\\(driver, data\\);",
    "kycResult = proposalPage\\.ok \\? await fillKYCDetails[^\\n]*",
  ];
  for (const f of ["fullPolicycompany/kshemaForm.js", "multiCompany/tpCompany/kshemaTP/kshemaTPForm.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const step of steps) assert.match(src, new RegExp(`${step}\\n\\s*throwIfHeld\\(driver\\);`), `${f}: ${step}`);
    assert.match(src, /if \(!isAutomationStop\(e\)\) warn\(`Could not take a screenshot/, f);
  }
});
