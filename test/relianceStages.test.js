/**
 * Reliance in three stages (fullPolicycompany/reliance/relianceStages.js + lib/relianceStagesCore.js):
 *   1. the rules — where a run starts, the cascade, what may be set back to pending
 *   2. the database helpers — with a stand-in MongoClient (never a real database)
 *   3. the stop at the KYC — no Pending Quotes, no Pay
 *   4. the REAL relianceForm.js after login, with a fake browser: a fresh run goes to the form, a resumed run goes straight
 *      to View Policy (stage 2) or to Pending Quotes (stage 3)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require("../lib/relianceStagesCore");
const stages = require("../fullPolicycompany/reliance/relianceStages");
const { stopAtKycFailure } = stages;

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const NOW = new Date("2026-10-19T10:00:00Z");
const policyWith = (motor, extra = {}) => ({ relianceStages: { motor }, ...extra });

/* ------------------------------------------- 1. the rules ------------------------------------------- */

test("stageKeyOf: the part key, bundled when empty", () => {
  assert.equal(core.stageKeyOf("motor"), "motor");
  assert.equal(core.stageKeyOf(" OD "), "od");
  assert.equal(core.stageKeyOf("tp"), "tp");
  assert.equal(core.stageKeyOf(""), "motor");
  assert.equal(core.stageKeyOf(undefined), "motor");
  assert.equal(stages.stageKeyFor({ _partKey: "od" }), "od");
  assert.equal(stages.stageKeyFor({}), "motor");
});

test("stagesFor: always the three stages; missing / unknown status = pending", () => {
  const none = core.stagesFor({}, "motor");
  assert.deepEqual(Object.keys(none), ["proposal", "kyc", "payment"]);
  for (const s of Object.values(none)) assert.equal(s.status, "pending");
  const odd = core.stagesFor(policyWith({ kyc: { status: "DONE?" }, payment: { status: "Completed" } }), "motor");
  assert.equal(odd.kyc.status, "pending");
  assert.equal(odd.payment.status, "completed");
  // another part's stages are not this part's
  assert.equal(core.stagesFor({ relianceStages: { od: { proposal: { status: "completed" } } } }, "tp").proposal.status, "pending");
});

test("planResume: an old policy (no stages) starts from the proposal, exactly as before", () => {
  assert.deepEqual(core.planResume(core.stagesFor({}, "motor")), {
    skipProposal: false,
    skipKyc: false,
    skipPayment: false,
    proposalNumber: null,
    startAt: "proposal",
  });
  assert.equal(core.planResume(null).startAt, "proposal");
});

test("planResume: stage 1 done WITH its number -> the KYC; without a number -> the proposal again", () => {
  const atKyc = core.planResume(core.stagesFor(policyWith({ proposal: { status: "completed", proposalNumber: " R141026119597 " } }), "motor"));
  assert.deepEqual(atKyc, { skipProposal: true, skipKyc: false, skipPayment: false, proposalNumber: "R141026119597", startAt: "kyc" });
  const noNumber = core.planResume(core.stagesFor(policyWith({ proposal: { status: "completed" } }), "motor"));
  assert.equal(noNumber.startAt, "proposal");
  const failed = core.planResume(core.stagesFor(policyWith({ proposal: { status: "failed", proposalNumber: "R1" } }), "motor"));
  assert.equal(failed.startAt, "proposal");
});

test("planResume: KYC done -> the payment; a failed KYC is done again (same proposal); everything done -> the payment again", () => {
  const done = { proposal: { status: "completed", proposalNumber: "R1" }, kyc: { status: "completed" } };
  assert.equal(core.planResume(core.stagesFor(policyWith(done), "motor")).startAt, "payment");
  const paid = { ...done, payment: { status: "completed", mode: "link" } };
  assert.equal(core.planResume(core.stagesFor(policyWith(paid), "motor")).startAt, "payment", "a link is sent again on a re-run");
  const kycFailed = { proposal: { status: "completed", proposalNumber: "R1" }, kyc: { status: "failed" } };
  assert.deepEqual(core.planResume(core.stagesFor(policyWith(kycFailed), "motor")), {
    skipProposal: true,
    skipKyc: false,
    skipPayment: false,
    proposalNumber: "R1",
    startAt: "kyc",
  });
  assert.equal(core.planResume(core.stagesFor(policyWith(paid), "motor")).skipPayment, false, "all done: the link is sent again");
  // the KYC is never skipped without the proposal
  const kycOnly = { kyc: { status: "completed" } };
  assert.equal(core.planResume(core.stagesFor(policyWith(kycOnly), "motor")).skipKyc, false);
});

test("planResume: KYC set back on a PAID policy -> only the KYC runs (skipPayment); a pending payment is not skipped", () => {
  const kycOnly = { proposal: { status: "completed", proposalNumber: "R1" }, kyc: { status: "pending" }, payment: { status: "completed", mode: "link" } };
  assert.deepEqual(core.planResume(core.stagesFor(policyWith(kycOnly), "motor")), {
    skipProposal: true,
    skipKyc: false,
    skipPayment: true,
    proposalNumber: "R1",
    startAt: "kyc",
  });
  const notPaid = { ...kycOnly, payment: { status: "pending" } };
  assert.equal(core.planResume(core.stagesFor(policyWith(notPaid), "motor")).skipPayment, false, "the payment still has to be made");
  const failedPay = { ...kycOnly, payment: { status: "failed" } };
  assert.equal(core.planResume(core.stagesFor(policyWith(failedPay), "motor")).skipPayment, false);
  const newProposal = { proposal: { status: "pending" }, kyc: { status: "pending" }, payment: { status: "completed" } };
  assert.equal(core.planResume(core.stagesFor(policyWith(newProposal), "motor")).skipPayment, false, "a new proposal pays again");
});

test("stageSet: ONLY the proposal cascades (KYC and payment back to pending); KYC / payment touch only themselves", () => {
  const set = core.stageSet("motor", "proposal", "completed", { proposalNumber: "R9" }, NOW);
  assert.deepEqual(Object.keys(set).sort(), [
    "relianceStages.motor.kyc",
    "relianceStages.motor.payment",
    "relianceStages.motor.proposal",
  ]);
  assert.deepEqual(set["relianceStages.motor.proposal"], { proposalNumber: "R9", status: "completed", at: NOW });
  assert.equal(set["relianceStages.motor.kyc"].status, "pending");
  assert.equal(set["relianceStages.motor.payment"].status, "pending");

  const kycDone = core.stageSet("od", "kyc", "completed", {}, NOW);
  assert.deepEqual(Object.keys(kycDone), ["relianceStages.od.kyc"], "a finished KYC does not touch the payment");
  const kycBack = core.stageSet("od", "kyc", "pending", {}, NOW);
  assert.deepEqual(Object.keys(kycBack), ["relianceStages.od.kyc"], "KYC set back = only the KYC");
  const proposalBack = core.stageSet("od", "proposal", "pending", {}, NOW);
  assert.deepEqual(Object.keys(proposalBack).sort(), ["relianceStages.od.kyc", "relianceStages.od.payment", "relianceStages.od.proposal"]);
  assert.deepEqual(core.cascadesFrom("proposal"), ["kyc", "payment"]);
  assert.deepEqual(core.cascadesFrom("kyc"), []);

  const kycFailed = core.stageSet("motor", "kyc", "failed", { error: "x" }, NOW);
  assert.deepEqual(Object.keys(kycFailed), ["relianceStages.motor.kyc"]);
  assert.equal(kycFailed["relianceStages.motor.kyc"].error, "x");

  const paid = core.stageSet("motor", "payment", "completed", { mode: "wallet" }, NOW);
  assert.deepEqual(Object.keys(paid), ["relianceStages.motor.payment"]);
  // extra cannot overwrite status / at, undefined is dropped
  const sneaky = core.stageSet("motor", "kyc", "failed", { status: "completed", at: "yesterday", gone: undefined }, NOW);
  assert.deepEqual(sneaky["relianceStages.motor.kyc"], { status: "failed", at: NOW });
  assert.throws(() => core.stageSet("motor", "pay", "completed"), /Unknown Reliance stage/);
  assert.throws(() => core.stageSet("motor", "kyc", "done"), /Unknown Reliance stage status/);
});

test("whyNotReset: pending cannot be set back (and nothing can be set to completed); running / wallet-paid are refused", () => {
  const done = { proposal: { status: "completed", proposalNumber: "R1" }, kyc: { status: "completed" }, payment: { status: "pending" } };
  assert.equal(core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "kyc" }), null);
  assert.equal(core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "proposal" }), null);
  assert.match(core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "payment" }), /already pending/);
  assert.match(core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "kyc", processing: true }), /running this policy right now/);
  assert.match(core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "nope" }), /no Reliance stage/);
  // a failed stage may go back to pending
  assert.equal(core.whyNotReset({ policy: policyWith({ ...done, kyc: { status: "failed" } }), key: "motor", stage: "kyc" }), null);

  // money at Reliance: the wallet note (any state that may have paid) or a completed wallet payment
  for (const state of ["submit-pressed", "issued", "unconfirmed"]) {
    const p = policyWith(done, { walletPayment: { state } });
    assert.match(core.whyNotReset({ policy: p, key: "motor", stage: "kyc" }), /paid from the wallet/, state);
  }
  assert.equal(core.whyNotReset({ policy: policyWith(done, { walletPayment: { state: "failed" } }), key: "motor", stage: "kyc" }), null);
  const walletPaid = policyWith({ ...done, payment: { status: "completed", mode: "wallet" } });
  assert.match(core.whyNotReset({ policy: walletPaid, key: "motor", stage: "payment" }), /paid from the wallet/);
  // a link policy's payment can be redone (the link is sent again)
  const linkSent = policyWith({ ...done, payment: { status: "completed", mode: "link" } });
  assert.equal(core.whyNotReset({ policy: linkSent, key: "motor", stage: "payment" }), null);
  // the note is per part
  const odNote = { relianceStages: { od: done, tp: done }, walletPayment_od: { state: "issued" } };
  assert.match(core.whyNotReset({ policy: odNote, key: "od", stage: "kyc" }), /wallet/);
  assert.equal(core.whyNotReset({ policy: odNote, key: "tp", stage: "kyc" }), null);
  // operator sentences carry no colon (beautifyError would cut them)
  for (const s of [
    core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "payment" }),
    core.whyNotReset({ policy: policyWith(done), key: "motor", stage: "kyc", processing: true }),
    core.whyNotReset({ policy: walletPaid, key: "motor", stage: "payment" }),
  ]) assert.equal(s.includes(":"), false, s);
});

test("resetSet: the proposal takes KYC and payment along (old number remembered); KYC alone stays alone", () => {
  const set = core.resetSet("motor", "proposal", { by: "op1", now: NOW, previous: { proposalNumber: "R5" } });
  assert.equal(set["relianceStages.motor.proposal"].status, "pending");
  assert.equal(set["relianceStages.motor.proposal"].previousProposalNumber, "R5");
  assert.equal(set["relianceStages.motor.proposal"].by, "op1");
  assert.equal(set["relianceStages.motor.kyc"].status, "pending");
  assert.equal(set["relianceStages.motor.payment"].status, "pending");
  const kyc = core.resetSet("motor", "kyc", { now: NOW });
  assert.deepEqual(Object.keys(kyc), ["relianceStages.motor.kyc"]);
  assert.equal("by" in kyc["relianceStages.motor.kyc"], false);
});

test("relianceStagesCore has no requires (it is copied between repos as is)", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "relianceStagesCore.js"), "utf8");
  assert.equal(/\brequire\s*\(/.test(src), false);
});

/* ------------------------------------- 2. the database helpers ------------------------------------- */

function fakeMongo({ doc = null, connectError = null, matched = 1 } = {}) {
  const log = { finds: [], updates: [], closed: 0 };
  class FakeClient {
    async connect() {
      if (connectError) throw connectError;
    }
    db() {
      return {
        collection: (name) => ({
          async findOne(filter, options) {
            log.finds.push({ name, filter, options });
            return doc;
          },
          async updateOne(filter, update) {
            log.updates.push({ name, filter, update });
            return { matchedCount: matched };
          },
        }),
      };
    }
    async close() {
      log.closed++;
    }
  }
  return { FakeClient, log };
}

test("loadResumePlan: reads the policy's stages for THIS part", async () => {
  const doc = {
    relianceStages: {
      motor: { proposal: { status: "completed", proposalNumber: "R7" } },
      od: { proposal: { status: "completed", proposalNumber: "R8" }, kyc: { status: "completed" } },
    },
  };
  const { FakeClient, log } = fakeMongo({ doc });
  const motor = await stages.loadResumePlan({ _id: "p1" }, { MongoClient: FakeClient });
  assert.equal(motor.startAt, "kyc");
  assert.equal(motor.proposalNumber, "R7");
  assert.equal(motor.key, "motor");
  const od = await stages.loadResumePlan({ _id: "p1", _partKey: "od" }, { MongoClient: FakeClient });
  assert.equal(od.startAt, "payment");
  assert.equal(od.proposalNumber, "R8");
  assert.deepEqual(log.finds[0].filter, { _id: "p1" });
  assert.equal(log.finds[0].name, "onlinePolicy");
  assert.equal(log.closed, 2);
});

test("loadResumePlan: no policy id, no policy, an unreachable database -> from the proposal (never throws)", async () => {
  const none = await stages.loadResumePlan({}, {});
  assert.equal(none.startAt, "proposal");
  const gone = fakeMongo({ doc: null });
  assert.equal((await stages.loadResumePlan({ _id: "p" }, { MongoClient: gone.FakeClient })).startAt, "proposal");
  const down = fakeMongo({ connectError: new Error("ECONNREFUSED") });
  const r = await quiet(() => stages.loadResumePlan({ _id: "p" }, { MongoClient: down.FakeClient }));
  assert.equal(r.startAt, "proposal");
  assert.equal(r.skipProposal, false);
});

test("markStage: one $set with the cascade on the policy, for the part; never throws", async () => {
  const { FakeClient, log } = fakeMongo();
  const ok = await quiet(() =>
    stages.markStage({ policyId: "p2", _partKey: "tp" }, "proposal", "completed", { proposalNumber: "R3" }, { MongoClient: FakeClient, now: NOW })
  );
  assert.equal(ok, true);
  assert.equal(log.updates.length, 1);
  assert.deepEqual(log.updates[0].filter, { _id: "p2" });
  const set = log.updates[0].update.$set;
  assert.deepEqual(set["relianceStages.tp.proposal"], { proposalNumber: "R3", status: "completed", at: NOW });
  assert.equal(set["relianceStages.tp.kyc"].status, "pending");
  assert.equal(set.updatedAt, NOW);
  assert.equal(log.closed, 1);

  const down = fakeMongo({ connectError: new Error("down") });
  assert.equal(await quiet(() => stages.markStage({ _id: "p" }, "kyc", "failed", {}, { MongoClient: down.FakeClient })), false);
  assert.equal(await quiet(() => stages.markStage({}, "kyc", "failed")), false, "no policy id");
  const unmatched = fakeMongo({ matched: 0 });
  assert.equal(await quiet(() => stages.markStage({ _id: "p" }, "kyc", "completed", {}, { MongoClient: unmatched.FakeClient })), false);
  // a bad stage name is a programming error, reported but never thrown into the run
  assert.equal(await quiet(() => stages.markStage({ _id: "p" }, "pay", "completed", {}, { MongoClient: FakeClient })), false);
});

/* --------------------------------------- 3. stop at the KYC --------------------------------------- */

test("stopAtKycFailure: the portal's words + 'only the KYC is left'; screenshot kept; stage 2 failed; nothing else", async () => {
  const marks = [];
  const notes = [];
  const shots = {
    captured: 0,
    async capturePage() {
      this.captured++;
    },
    async flush() {
      return { url: "https://s3.test/kyc/toast.png", key: "kyc/toast.png" };
    },
  };
  const err = new (require("../fullPolicycompany/reliance/relianceKycSubmit").PortalRejectedError)(
    'Reliance refused the documents at SUBMIT - it said "Invalid file"'
  );
  const r = await stopAtKycFailure({
    data: { _id: "p" },
    error: err,
    proposalNumber: "R55",
    shots,
    deps: { markStage: async (...a) => marks.push(a), saveStatus: async (...a) => notes.push(a) },
  });
  assert.match(r.message, /^Reliance refused the documents at SUBMIT - it said "Invalid file" Proposal R55 stays saved at Reliance and only the KYC is left/);
  assert.match(r.message, /Pending Quotes and Pay were not opened, nothing was paid or sent/);
  assert.equal(r.message.includes(":"), false, "no colon in an operator sentence");
  assert.equal(r.screenshotUrl, "https://s3.test/kyc/toast.png");
  assert.equal(r.screenshotKey, "kyc/toast.png");
  assert.equal(shots.captured, 1);
  assert.equal(notes.length, 0, "a portal refusal already wrote its own KYC note");
  assert.equal(marks.length, 1);
  assert.deepEqual(marks[0].slice(1, 3), ["kyc", "failed"]);
  assert.equal(marks[0][3].error, r.message);
});

test("stopAtKycFailure: any other error is worded generically, writes the KYC note, works without a screenshot keeper", async () => {
  const marks = [];
  const notes = [];
  const r = await stopAtKycFailure({
    data: { _id: "p", proposalNumber: "R66" },
    error: new Error("[E302] TimeoutError: Waiting for element to be located By(css selector, #ind-ovd)"),
    deps: { markStage: async (...a) => marks.push(a), saveStatus: async (...a) => notes.push(a) },
  });
  assert.match(r.message, /^The KYC could not be completed - TimeoutError - Waiting for element/);
  assert.match(r.message, /Proposal R66 stays saved/);
  assert.equal(r.message.includes(":"), false);
  assert.equal(r.screenshotUrl, null);
  assert.equal(notes.length, 1);
  assert.match(notes[0][0], /^KYC did not complete - TimeoutError/);
  assert.equal(marks.length, 1);
});

test("operator sentences: no colon, the proposal named, a long Selenium reason cut short", () => {
  const long = `no such element: ${"x".repeat(500)}`;
  const all = [
    stages.kycNotDoneMessage("R1", long),
    stages.proceedMissingMessage("R1"),
    stages.resumeNoKycLinkMessage("R1"),
    stages.paymentNotDoneMessage("R1", { link: true, why: long }),
    stages.paymentNotDoneMessage("R1", { link: false }),
    stages.kycKeptSentence("R1"),
  ];
  for (const s of all) {
    assert.equal(s.includes(":"), false, s);
    assert.match(s, /R1/);
    assert.ok(s.length < 520, `${s.length} characters`);
  }
  assert.match(stages.paymentNotDoneMessage("R1", { link: true }), /payment link was not sent/);
  assert.match(stages.paymentNotDoneMessage("R1", { link: false }), /wallet payment was not made/);
  assert.match(stages.resumeNoKycLinkMessage("R1"), /^Proposal R1 saved by an earlier run/);
  assert.match(stages.kycNotDoneMessage(null), /for the proposal/);
  const e = new stages.RelianceStageError("x", { stage: "payment" });
  assert.equal(e.portalRejected, true, "passes the nested catches of the KYC / payment steps");
  assert.equal(e.keepMessage, true);
  assert.equal(e.relianceStage, "payment");
});

/* -------------------------------- 4. the real form, with a fake browser -------------------------------- */

const FORM = require.resolve("../fullPolicycompany/relianceForm");
const STAGES_MODULE = require.resolve("../fullPolicycompany/reliance/relianceStages");

// The GPT-4o captcha reader is imported by the Reliance form: stub it so loading it never touches OpenAI.
const captchaPath = require.resolve("../Captcha");
if (!require.cache[captchaPath]) {
  require.cache[captchaPath] = {
    id: captchaPath,
    filename: captchaPath,
    loaded: true,
    exports: { extractCaptchaText: async () => ({ text: "", success: false }) },
  };
}

const END = "FAKE-PORTAL-END";

/**
 * A browser that is logged in and shows the Motors menu, and ends ("FAKE-PORTAL-END") at the FIRST thing the run asks
 * of it after that. The log says which page the run went for first.
 */
function fakeDriver(log) {
  const element = {
    click: async () => {},
    getText: async () => "",
    getAttribute: async () => null,
    isDisplayed: async () => true,
    isEnabled: async () => true,
    isSelected: async () => false,
    sendKeys: async () => {},
    clear: async () => {},
  };
  const describe = (cond) => (cond && typeof cond.description === "function" ? cond.description() : String(cond));
  const actions = () => {
    const a = {
      move: () => a,
      click: () => a,
      pause: () => a,
      perform: async () => {
        log.push("actions");
        throw new Error(`${END} at actions`);
      },
    };
    return a;
  };
  return {
    async wait(cond) {
      const d = describe(cond);
      if (/Closebutton/.test(d)) throw new Error("no popup");
      log.push(`wait ${d}`);
      if (/divMainMotors/.test(d)) return element;
      throw new Error(`${END} at ${d}`);
    },
    async findElement(locator) {
      log.push(`find ${locator}`);
      throw new Error(`${END} at ${locator}`);
    },
    async findElements(locator) {
      log.push(`findAll ${locator}`);
      return [];
    },
    async get(url) {
      log.push(`get ${url}`);
      throw new Error(`${END} at ${url}`);
    },
    async getCurrentUrl() {
      return "https://portal.test/Home/Index";
    },
    async getTitle() {
      return "";
    },
    async sleep() {},
    async executeScript() {
      return null;
    },
    async takeScreenshot() {
      return "aGVsbG8=";
    },
    async getPageSource() {
      return "<html></html>";
    },
    async getAllWindowHandles() {
      return ["main"];
    },
    actions,
    switchTo: () => ({ window: async () => {}, defaultContent: async () => {}, frame: async () => {} }),
    async close() {},
    async quit() {},
  };
}

async function runAfterLogin(plan) {
  const realStages = require(STAGES_MODULE);
  const marks = [];
  const kycStops = [];
  const log = [];
  const driver = fakeDriver(log);
  const realS3 = require("../s3Uploader");
  const stubs = {
    [require.resolve("../sessionManager")]: {
      createRelianceJobBrowser: async () => ({ driver }),
      cleanupJobBrowser: async () => {},
      performLogin: async () => true,
      reLoginIfNeeded: async () => true,
      recoveryManager: {},
    },
    [require.resolve("../s3Uploader")]: {
      ...realS3,
      uploadScreenshotToS3: async (_b64, key) => `https://s3.test/${key}`,
      uploadToS3: async (_file, key) => `https://s3.test/${key}`,
    },
    [require.resolve("../lib/jobRecorder")]: { startRecording() {} },
    [STAGES_MODULE]: {
      ...realStages,
      loadResumePlan: async () => ({ key: "motor", ...plan }),
      markStage: async (...args) => (marks.push(args.slice(1, 4)), true),
      stopAtKycFailure: async (o) => (kycStops.push(o), { message: "stopped at the KYC (stub)", screenshotUrl: null, screenshotKey: null }),
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
  process.env.RELIANCE_WALLET_SUBMIT_ENABLED = "false"; // the wallet gate reads the database before the browser opens
  const jobIdentifier = `Stage_test_${plan.startAt}_${Date.now()}`;
  const data = {
    _id: "policy-1",
    username: "u",
    password: "p",
    loginUrl: "https://portal.test/login",
    firstName: "Stage",
    Paymentmethod: "link",
    _jobIdentifier: jobIdentifier,
    _attemptNumber: 1,
  };
  try {
    const { fillRelianceForm } = await quiet(() => require(FORM));
    const result = await quiet(() => fillRelianceForm(data));
    return { result, log, marks, kycStops, data };
  } finally {
    if (envSaved === undefined) delete process.env.RELIANCE_WALLET_SUBMIT_ENABLED;
    else process.env.RELIANCE_WALLET_SUBMIT_ENABLED = envSaved;
    for (const [p, entry] of saved) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
    // the form keeps a local copy of every error screenshot: remove what this test made
    for (const dir of [path.join(ROOT, "error_screenshots"), path.join(ROOT, "screenshots")]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.includes(jobIdentifier)) fs.unlinkSync(path.join(dir, f));
    }
  }
}

const firstAfterMotors = (log) => log[log.findIndex((l) => /divMainMotors/.test(l)) + 1] || "";

test("real form, no saved stages: after login the run goes to the form (Motors -> Two Wheeler), never to View Policy / Pending Quotes", async () => {
  const { result, log, marks, kycStops } = await runAfterLogin({ skipProposal: false, skipKyc: false, proposalNumber: null, startAt: "proposal" });
  assert.equal(result.success, false);
  assert.equal(firstAfterMotors(log), "actions", "hovering the Motors menu = STEP 3 of the proposal");
  assert.equal(log.some((l) => /divMainUtility/.test(l)), false);
  assert.equal(log.some((l) => /Payment\/Payments/.test(l)), false);
  assert.equal(kycStops.length, 0);
  assert.equal(marks.some(([stage]) => stage !== "proposal"), false, "nothing of KYC / payment is recorded");
});

test("real form, stage 1 saved: straight to Utility -> View Policy with the saved number; a failure there STOPS at the KYC", async () => {
  const { result, log, marks, kycStops, data } = await runAfterLogin({
    skipProposal: true,
    skipKyc: false,
    proposalNumber: "R141026119597",
    startAt: "kyc",
  });
  assert.match(firstAfterMotors(log), /divMainUtility/, "the first page asked for is the Utility menu (View Policy)");
  assert.equal(log.some((l) => /Payment\/Payments/.test(l)), false, "Pending Quotes is never opened after a failed KYC");
  assert.equal(data.proposalNumber, "R141026119597", "the saved number is the one searched for");
  assert.equal(kycStops.length, 1, "the stop at the KYC (no rescue to the payment page)");
  assert.equal(kycStops[0].proposalNumber, "R141026119597");
  assert.equal(result.success, false);
  assert.equal(result.postSubmissionFailed, true, "never retried by itself");
  assert.equal(result.error, "stopped at the KYC (stub)");
  assert.equal(marks.some(([stage]) => stage === "proposal"), false, "the proposal is not made again");
});

test("real form, stages 1 and 2 saved: straight to Pending Quotes; a payment that did not happen fails stage 3 with a clear sentence", async () => {
  const { result, log, marks, kycStops } = await runAfterLogin({
    skipProposal: true,
    skipKyc: true,
    proposalNumber: "R222",
    startAt: "payment",
  });
  assert.match(firstAfterMotors(log), /^get https:\/\/portal\.test\/Payment\/Payments\?pageName=/, "Pending Quotes first");
  assert.equal(log.some((l) => /divMainUtility/.test(l)), false, "no View Policy, no DO KYC");
  assert.equal(kycStops.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.postSubmissionFailed, true);
  assert.match(result.error, /For proposal R222 the payment link was not sent/);
  assert.match(result.error, /Re-submit and the run goes straight to the payment/);
  assert.equal(result.error.includes(":"), false);
  const paymentMarks = marks.filter(([stage]) => stage === "payment");
  assert.equal(paymentMarks.length, 1);
  assert.equal(paymentMarks[0][1], "failed");
  assert.equal(marks.some(([stage]) => stage !== "payment"), false, "proposal and KYC stay as they were");
});

/* ------------------------------------- 5. the wiring, in order ------------------------------------- */

test("relianceForm.js: stage 3 starts only after the KYC block, behind the KYC-finished check; stage marks sit where the work is done", () => {
  const src = fs.readFileSync(FORM, "utf8");
  const at = (needle, from = 0) => {
    const i = src.indexOf(needle, from);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const resume = at("resume = await loadResumePlan(data, { jobId });");
  const form = at("if (!resume.skipProposal) { // stage 1 - the proposal (part A");
  const saved = at("await saveProposalNumber(proposalNumber, data, jobId);", form);
  const proposalDone = at('await markStage(data, "proposal", "completed", { proposalNumber }, { jobId });', saved);
  const kycStart = at("if (!resume.skipKyc) {", proposalDone);
  const accepted = at('await markStage(data, "kyc", "completed", { proposalNumber }, { jobId }); // stage 2 done', kycStart);
  const kycEnd = at("} // end of: stage 2 (the KYC)", accepted);
  const notFinished = at("} else if (!kycAccepted) {", kycEnd);
  const kycOnlyEnd = at("if (resume.skipPayment) {", notFinished);
  assert.match(src.slice(kycOnlyEnd, kycOnlyEnd + 400), /return \{ success: true, kycOnly: true, documentUploadError \};/);
  const paymentNow = at('stageNow = "payment";', kycOnlyEnd);
  const pending = at("// === STEP 6: Navigate to Pending Quotes ===", paymentNow);
  const paymentDone = at("if (paymentDone) {", pending);
  const brisk = at("// === STEP 9: Call Brisk Certificate API ===", paymentDone);
  assert.ok(resume < form && form < saved && saved < proposalDone && proposalDone < kycStart && kycStart < accepted);
  assert.ok(accepted < kycEnd && kycEnd < notFinished && notFinished < paymentNow && paymentNow < pending);
  assert.ok(pending < paymentDone && paymentDone < brisk);
  // Pending Quotes is opened in ONE place only, the stage-3 block
  assert.equal(src.split("=== STEP 6: Navigate to Pending Quotes ===").length - 1, 1);
  // the link counts as sent only after the Yes (SendMail) click
  const yes = at('console.log("✅ Clicked Yes (Send Mail) button");');
  assert.match(src.slice(yes, yes + 160), /paymentDone = "link";/);
});
