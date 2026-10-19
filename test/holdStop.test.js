/**
 * "Hold" pressed while a Reliance policy RUNS (lib/holdStop.js): the run stops at the next safe step, the window is
 * closed (its profile deleted), the part goes back to pending without counting an attempt (outcome "held"), and the
 * queue holds the job. Fakes only — no database, no browser.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { stopIfHeld, isHoldStop, holdRequestOf, HOLD_STOP_STAGE } = require("../lib/holdStop");
const core = require("../lib/jobPartsCore");
const { isAutomationStop, stoppedResult } = require("../automationStopper");

const ROOT = path.join(__dirname, "..");
const silent = () => {};
const jobsWith = (doc) => ({
  async findOne(filter) {
    if (!doc) return null;
    if (filter.holdRequested && !doc.holdRequested) return null;
    if (filter.parts && !Array.isArray(doc.parts)) return null;
    return doc;
  },
});

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

test("stopIfHeld: a hold request on THIS job stops the run (an automation stop, stage operator-hold, no colon)", async () => {
  const collection = jobsWith({ _id: "j1", parts: [], holdRequested: { at: new Date(), by: "u1" } });
  let caught = null;
  try {
    await stopIfHeld({ _jobId: "j1" }, "before the KYC", { collection, log: silent, env: {} });
  } catch (e) {
    caught = e;
  }
  assert.ok(isAutomationStop(caught), "every catch of the form lets it through");
  assert.equal(caught.details.stage, HOLD_STOP_STAGE);
  assert.equal(caught.details.where, "before the KYC");
  assert.equal(caught.details.heldBy, "u1");
  assert.match(caught.message, /^Held by the operator - stopped before the KYC\. Release continues from this step with a fresh login\.$/);
  assert.equal(caught.message.includes(":"), false);
  assert.equal(isHoldStop(caught), true);
  const result = stoppedResult(caught);
  assert.equal(isHoldStop(result), true, "and the result it becomes");
});

test("stopIfHeld: no request, no job id, an old-shape job, a failed read, or the switch off = the run goes on", async () => {
  await stopIfHeld({ _jobId: "j1" }, "x", { collection: jobsWith({ _id: "j1", parts: [] }), log: silent, env: {} });
  await stopIfHeld({}, "x", { collection: jobsWith({ holdRequested: {}, parts: [] }), log: silent, env: {} });
  await stopIfHeld({ _jobId: "j1" }, "x", { collection: jobsWith({ _id: "j1", holdRequested: {} }), log: silent, env: {} });
  await stopIfHeld({ _jobId: "j1" }, "x", { collection: { findOne: async () => { throw new Error("down"); } }, log: silent, env: {} });
  await stopIfHeld({ _jobId: "j1" }, "x", {
    collection: jobsWith({ _id: "j1", parts: [], holdRequested: {} }),
    log: silent,
    env: { JOB_HOLD_REQUEST_ENABLED: "false" },
  });
  assert.equal(await holdRequestOf("j1", { collection: null }), null, "no database connection (tests) = no hold");
});

test("core outcome 'held': back to pending, no attempt counted, no error logged, a history note", () => {
  const job = { status: "processing", parts: [{ key: "motor", kind: "bundled", company: "reliance", status: "processing", attempts: 2, maxAttempts: 5, lastError: "old" }] };
  const r = core.applyPartOutcome(job, "motor", { type: "held", error: "Held by the operator - stopped before the KYC.", stage: HOLD_STOP_STAGE }, new Date());
  const part = r.parts.find((p) => p.key === "motor");
  assert.equal(part.status, "pending");
  assert.equal(part.attempts, 2, "a hold is not a failed attempt");
  assert.equal(part.stopped, false);
  assert.equal(part.nextRetryAt, null);
  assert.equal(r.errorLog, null, "nothing in the Errors list");
  assert.match(r.historyEntry.note, /Held by the operator/);
  assert.equal(r.historyEntry.to, "pending");
});

test("partRunner maps a hold-stop to 'held' (not a 'stopped' failure); any other stop is still 'stopped'", () => {
  const { mapRunResult } = require("../lib/partRunner");
  const part = { key: "motor", kind: "bundled", company: "reliance" };
  const held = mapRunResult({ success: false, inProgress: true, stage: HOLD_STOP_STAGE, error: "Held by the operator - stopped after the login." }, { part });
  assert.equal(held.type, "held");
  const other = mapRunResult({ success: false, inProgress: true, stage: "reliance-wallet-hold", error: "x" }, { part });
  assert.equal(other.type, "stopped");
});

test("relianceForm.js: 8 safe stop points, none after Pay is pressed; a hold-stop closes the window", () => {
  const src = fs.readFileSync(path.join(ROOT, "fullPolicycompany", "relianceForm.js"), "utf8");
  assert.equal(src.split("await stopIfHeld(data").length - 1, 8);
  const lastStop = src.lastIndexOf("await stopIfHeld(data");
  const payClicked = src.indexOf('console.log("✅ Clicked Pay button");');
  assert.ok(payClicked > 0 && lastStop < payClicked, "the last stop point is before Pay — money in flight is never cut");
  assert.match(src.slice(lastStop, lastStop + 80), /before Pay \(nothing is paid\)/);
  assert.match(src, /hadError = !isHoldStop\(e\);/);
  const copy = fs.readFileSync(path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"), "utf8");
  assert.equal(copy.split("await stopIfHeld(data").length - 1, 8, "the OD / TP copy stops the same way");
});

/* ------------------------- the real form, Hold pressed: stops after the login ------------------------- */

test("real form: Hold pressed -> stops right after the login, window closed WITHOUT keeping it (profile deleted), hold result", async () => {
  const FORM = require.resolve("../fullPolicycompany/relianceForm");
  const captchaPath = require.resolve("../Captcha");
  if (!require.cache[captchaPath]) {
    require.cache[captchaPath] = { id: captchaPath, filename: captchaPath, loaded: true, exports: { extractCaptchaText: async () => ({ text: "", success: false }) } };
  }
  const element = { click: async () => {}, getText: async () => "", getAttribute: async () => null };
  const asked = [];
  const driver = {
    async wait(cond) {
      const d = cond && typeof cond.description === "function" ? cond.description() : String(cond);
      asked.push(d);
      if (/Closebutton/.test(d)) throw new Error("no popup");
      if (/divMainMotors/.test(d)) return element;
      throw new Error(`the run went on past the hold: ${d}`);
    },
    async findElements() { return []; },
    async getCurrentUrl() { return "https://portal.test/Home"; },
    async sleep() {},
    async executeScript() { return null; },
    async takeScreenshot() { return "aGVsbG8="; },
    async getPageSource() { return "<html></html>"; },
    actions() { throw new Error("the run went on past the hold: actions"); },
  };
  const cleaned = [];
  const realS3 = require("../s3Uploader");
  const holdStop = require("../lib/holdStop");
  const fakeJobs = jobsWith({ _id: "job-1", parts: [], holdRequested: { at: new Date(), by: "op" } });
  const stubs = {
    [require.resolve("../sessionManager")]: {
      createRelianceJobBrowser: async () => ({ driver }),
      cleanupJobBrowser: async (_b, opts) => cleaned.push(opts),
      performLogin: async () => true,
      reLoginIfNeeded: async () => true,
      recoveryManager: {},
    },
    [require.resolve("../s3Uploader")]: { ...realS3, uploadScreenshotToS3: async (_b, k) => `https://s3.test/${k}`, uploadToS3: async (_f, k) => `https://s3.test/${k}` },
    [require.resolve("../lib/jobRecorder")]: { startRecording() {} },
    [require.resolve("../lib/holdStop")]: { ...holdStop, stopIfHeld: (data, where, o = {}) => holdStop.stopIfHeld(data, where, { ...o, collection: fakeJobs, env: {} }) },
    [require.resolve("../fullPolicycompany/reliance/relianceStages")]: {
      ...require("../fullPolicycompany/reliance/relianceStages"),
      loadResumePlan: async () => ({ key: "motor", skipProposal: false, skipKyc: false, skipPayment: false, proposalNumber: null, startAt: "proposal" }),
      markStage: async () => true,
    },
  };
  const saved = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  saved.set(FORM, require.cache[FORM]);
  delete require.cache[FORM];
  const envSaved = process.env.RELIANCE_WALLET_SUBMIT_ENABLED;
  process.env.RELIANCE_WALLET_SUBMIT_ENABLED = "false";
  try {
    const { fillRelianceForm } = await quiet(() => require(FORM));
    const result = await quiet(() =>
      fillRelianceForm({ _id: "pol-1", _jobId: "job-1", username: "u", password: "p", loginUrl: "https://portal.test/login", firstName: "Hold", _jobIdentifier: "Hold_test", _attemptNumber: 1 })
    );
    assert.equal(result.inProgress, true);
    assert.equal(isHoldStop(result), true);
    assert.match(result.error, /stopped after the login/);
    assert.deepEqual(cleaned, [{ hadError: false }], "the window is closed and the profile deleted, even when failed windows are kept");
    assert.equal(asked.filter((d) => !/Closebutton|divMainMotors/.test(d)).length, 0, "nothing after the stop point ran");
  } finally {
    if (envSaved === undefined) delete process.env.RELIANCE_WALLET_SUBMIT_ENABLED;
    else process.env.RELIANCE_WALLET_SUBMIT_ENABLED = envSaved;
    for (const [p, entry] of saved) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
});
