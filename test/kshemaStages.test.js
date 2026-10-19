/**
 * KSHEMA in three steps (fullPolicycompany/kshema/kshemaStages.js + the wiring in kshemaForm.js and its TP copy):
 * the saved proposal page is opened after a new login and checked, step 1 is marked the moment the proposal page
 * shows, a Hold stops only between top-level steps, and the payment step is done when the payment page is reached.
 * Fakes only — no browser, no database, no network.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ks = require("../fullPolicycompany/kshema/kshemaStages");
const stages = require("../fullPolicycompany/reliance/relianceStages");

const LINK = "https://motorinsurance.kshema.co/proposal/summary/ABC123";
const NOW = new Date("2026-10-19T10:00:00Z");

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * A page that shows its buttons from a given poll on. buttons: { kyc: fromPoll, pay: fromPoll, payDisabled: bool }.
 */
function fakePage({ kyc = null, pay = null, payDisabled = false, title = "KSHEMA", url = LINK } = {}) {
  let polls = 0;
  const visited = [];
  const el = (enabled = true) => ({ isDisplayed: async () => true, isEnabled: async () => enabled });
  const driver = {
    visited,
    async get(u) {
      visited.push(u);
    },
    async findElements(locator) {
      const xp = String(locator && locator.value);
      if (/make payment/.test(xp)) {
        return pay !== null && polls >= pay ? [el(!payDisabled)] : [];
      }
      polls++; // one KYC look per poll (the pay look comes first)
      return kyc !== null && polls > kyc ? [el()] : [];
    },
    async getTitle() {
      return title;
    },
    async getCurrentUrl() {
      return url;
    },
    sleep: async () => {},
  };
  return driver;
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
};

/* --------------------------------- opening the saved page --------------------------------- */

test("openSavedProposal: opens the saved address after the login and waits for the KYC button", async () => {
  const driver = fakePage({ kyc: 3 });
  const c = clock();
  const r = await quiet(() =>
    ks.openSavedProposal(driver, { proposalLink: ` ${LINK} ` }, { ...c, loaderVisible: async () => false, readStep: async () => "Summary" })
  );
  assert.deepEqual(driver.visited, [LINK]);
  assert.equal(r.ok, true);
  assert.equal(r.landedOn, "kyc");
  assert.equal(r.step, "Summary");
});

test("openSavedProposal: KYC done (resume at the payment) -> Make Payment wins; KYC not done -> the KYC button wins", async () => {
  const deps = { loaderVisible: async () => false, readStep: async () => null };
  const atPay = await quiet(() =>
    ks.openSavedProposal(fakePage({ kyc: 0, pay: 0 }), { proposalLink: LINK, skipKyc: true }, { ...clock(), ...deps })
  );
  assert.equal(atPay.landedOn, "payment");
  const atKyc = await quiet(() => ks.openSavedProposal(fakePage({ kyc: 0, pay: 0 }), { proposalLink: LINK }, { ...clock(), ...deps }));
  assert.equal(atKyc.landedOn, "kyc");
  const onlyPay = await quiet(() => ks.openSavedProposal(fakePage({ pay: 0 }), { proposalLink: LINK }, { ...clock(), ...deps }));
  assert.equal(onlyPay.landedOn, "payment", "KSHEMA shows Make Payment only -> its KYC is done");
});

test("openSavedProposal: a page without the buttons (or a disabled Make Payment) -> the clear stop, no colon", async () => {
  const c = clock();
  const r = await quiet(() =>
    ks.openSavedProposal(fakePage({ pay: 0, payDisabled: true, title: "Login: KSHEMA" }), { proposalLink: LINK }, {
      ...c,
      waitMs: 5000,
      loaderVisible: async () => false,
      readStep: async () => null,
    })
  );
  assert.equal(r.ok, false);
  assert.equal(r.landedOn, null);
  assert.ok(c.now() >= 5000, "it waited the whole time");
  assert.match(r.error, /^The saved KSHEMA proposal page did not open after the new login/);
  assert.match(r.error, /Set Proposal back to Pending in History to make a new quote$/);
  assert.match(r.error, /Login - KSHEMA/, "the page title is in it, its colon turned into a dash");
  assert.doesNotMatch(r.error, /:/);
});

test("openSavedProposal: an open loader is waited out; no saved address -> nothing opened", async () => {
  let loaderPolls = 3;
  const driver = fakePage({ kyc: 0 });
  const r = await quiet(() =>
    ks.openSavedProposal(driver, { proposalLink: LINK }, { ...clock(), loaderVisible: async () => loaderPolls-- > 0, readStep: async () => null })
  );
  assert.equal(r.ok, true);
  assert.ok(loaderPolls < 0, "the loader was looked at until it was gone");

  const none = fakePage({ kyc: 0 });
  const r2 = await quiet(() => ks.openSavedProposal(none, { proposalLink: "  " }, clock()));
  assert.equal(r2.ok, false);
  assert.deepEqual(none.visited, []);
  assert.doesNotMatch(r2.error, /:/);
});

/* --------------------------------- step 1: the proposal page --------------------------------- */

test("awaitProposalPage: the KYC button came -> the page address; it did not -> the KYC step's own reason", async () => {
  const driver = fakePage();
  const ok = await ks.awaitProposalPage(driver, {}, { awaitKycButton: async () => ({ ok: true, button: {} }) });
  assert.deepEqual(ok, { ok: true, url: LINK, landedOn: "kyc" });
  const no = await ks.awaitProposalPage(driver, {}, { awaitKycButton: async () => ({ ok: false, error: "The KYC button did not appear within 90 seconds" }) });
  assert.equal(no.ok, false);
  assert.equal(no.error, "The KYC button did not appear within 90 seconds");
});

function fakeMongo({ doc = null, matched = 1 } = {}) {
  const log = { updates: [], finds: [] };
  class FakeClient {
    async connect() {}
    db() {
      return {
        collection: () => ({
          async findOne(filter, options) {
            log.finds.push({ filter, options });
            return doc;
          },
          async updateOne(filter, update) {
            log.updates.push({ filter, update });
            return { matchedCount: matched };
          },
        }),
      };
    }
    async close() {}
  }
  return { FakeClient, log };
}

test("keepProposalPage: ONE write - proposalLink + Proposal completed with its link (KYC / payment back to pending)", async () => {
  const { FakeClient, log } = fakeMongo();
  const ok = await quiet(() => ks.keepProposalPage({ _id: "p1", _partKey: "tp" }, LINK, { MongoClient: FakeClient, now: NOW }));
  assert.equal(ok, true);
  assert.equal(log.updates.length, 1);
  const set = log.updates[0].update.$set;
  assert.equal(set.proposalLink, LINK);
  assert.deepEqual(set["relianceStages.tp.proposal"], { link: LINK, status: "completed", at: NOW });
  assert.equal(set["relianceStages.tp.kyc"].status, "pending");
  assert.equal(set["relianceStages.tp.payment"].status, "pending");
});

test("keepProposalPage: no readable address or no policy id -> nothing written, nothing marked", async () => {
  const { FakeClient, log } = fakeMongo();
  assert.equal(await quiet(() => ks.keepProposalPage({ _id: "p1" }, "", { MongoClient: FakeClient })), false);
  assert.equal(await quiet(() => ks.keepProposalPage({ _id: "p1" }, "about:blank", { MongoClient: FakeClient })), false);
  assert.equal(await quiet(() => ks.keepProposalPage({}, LINK, { MongoClient: FakeClient })), false);
  assert.equal(log.updates.length, 0);
});

test("loadKshemaResume: a finished step 1 with its saved page -> the KYC, with the address to open", async () => {
  const doc = { relianceStages: { motor: { proposal: { status: "completed", link: LINK } } } };
  const { FakeClient } = fakeMongo({ doc });
  const plan = await quiet(() => ks.loadKshemaResume({ _id: "p1" }, { MongoClient: FakeClient }));
  assert.equal(plan.startAt, "kyc");
  assert.equal(plan.proposalLink, LINK);
  assert.equal(plan.key, "motor");
  assert.match(ks.resumeWords(plan), /^Resuming at the KYC \(step 2\) with the saved proposal page/);
});

test("the policy id: a 24-hex string from the job data is matched as an ObjectId", () => {
  const { ObjectId } = require("mongodb");
  const id = stages.policyIdOf({ _id: "65f0c0ffee0123456789abcd" });
  assert.ok(id instanceof ObjectId);
  assert.equal(String(id), "65f0c0ffee0123456789abcd");
  assert.equal(stages.policyIdOf({ _id: "p1" }), "p1");
});

/* --------------------------------- step 3: the payment --------------------------------- */

test("paymentStageOf: the payment page reached = completed (QR noted when missing); else failed with the reason", () => {
  assert.deepEqual(ks.paymentStageOf({ ok: true, paymentUrl: "https://pay.example/x", qrScreenshotKey: "k" }), {
    status: "completed",
    extra: { mode: "qr", link: "https://pay.example/x" },
  });
  const noQr = ks.paymentStageOf({ ok: true, paymentUrl: "https://pay.example/x", qrError: "Show QR button not found" });
  assert.equal(noQr.status, "completed");
  assert.match(noQr.extra.note, /QR picture was not taken \(Show QR button not found\)/);
  const failed = ks.paymentStageOf({ ok: false, error: "Could not proceed to payment: Make Payment button not found" });
  assert.equal(failed.status, "failed");
  assert.doesNotMatch(failed.extra.error, /:/);
  assert.equal(ks.paymentStageOf(null).status, "failed");
  assert.equal(ks.paymentStageOf({ ok: true, paymentUrl: "" }).status, "failed", "no payment page address = not reached");
});

/* --------------------------------- the wiring in both copies --------------------------------- */

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshemaForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"),
]) {
  const name = path.basename(file);
  const src = fs.readFileSync(file, "utf8");
  const flow = src.slice(src.indexOf("async function runKshemaFlow("));
  const at = (needle) => {
    const i = flow.indexOf(needle);
    assert.ok(i >= 0, `${name}: "${needle}" is in runKshemaFlow`);
    return i;
  };

  test(`${name}: the three steps in order - login, plan, step 1 (or the saved page), KYC, payment`, () => {
    const order = [
      'await stopIfHeld(data, "after the login")',
      "await loadKshemaResume(data, { jobId })",
      "if (resume.skipProposal) {",
      "await openSavedProposal(driver, resume)",
      "} else { // step 1 - the proposal",
      'await stopIfHeld(data, "before the quote form',
      "await fillCustomerDetails(",
      'await stopIfHeld(data, "before the nominee and Save and Finalize',
      "await fillNomineeDetails(",
      "proposalPage = await awaitProposalPage(driver, data)",
      "await keepProposalPage(data, proposalPage.url, { jobId })",
      "} // end of step 1",
      'await stopIfHeld(data, "before the KYC")',
      "await fillKYCDetails(",
      'await markStage(data, proposalPage.ok ? "kyc" : "proposal", "failed"',
      'await markStage(data, "kyc", "completed", {}, { jobId })',
      "} // end of step 2",
      "if (resume.skipPayment) {",
      'await stopIfHeld(data, "before the payment',
      "const briskDecision =",
      "await proceedToPayment(",
      'await markStage(data, "payment", paymentStage.status',
    ];
    let last = -1;
    for (const needle of order) {
      const i = at(needle);
      assert.ok(i > last, `${name}: "${needle}" comes after the step before it`);
      last = i;
    }
  });

  test(`${name}: Hold only at top-level points, never once the payment has started`, () => {
    const lines = flow.split("\n").filter((l) => l.includes("await stopIfHeld("));
    assert.equal(lines.length, 5);
    for (const l of lines) assert.match(l, /^ {4}await stopIfHeld\(/, `top level of the run (not inside a helper's try) - ${l.trim()}`);
    assert.ok(flow.lastIndexOf("await stopIfHeld(") < at("await proceedToPayment("), "no stop after the payment started");
  });

  test(`${name}: a Hold closes the window like a finished run (fresh login on Release)`, () => {
    const fill = src.slice(src.indexOf("async function fillKshemaForm("), src.indexOf("async function runKshemaFlow("));
    assert.match(fill, /hadError = !\(outcome && outcome\.success === true\);\s*(?:\/\/[^\n]*\n\s*)*if \(isHoldStop\(outcome\)\) hadError = false;/);
  });
}
