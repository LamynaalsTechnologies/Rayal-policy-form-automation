"use strict";

// KSHEMA speed round 4 (2026-11-26): the KYC refusal watch ends early on KSHEMA's own "KYC Verified" page (owner's
// choice), the short pause after a lookup field ends when Angular says nothing is pending, and the page signs.
// No browser, no network, no database:
//   MONGODB_URI=mongodb://127.0.0.1:9/none node --require ./test/support/noRealWorld.js --test test/kshemaSpeedRound4.test.js
const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");

const quote = require("../fullPolicycompany/kshema/kshemaQuoteForm");
const tpQuote = require("../multiCompany/tpCompany/kshemaTP/kshemaTPQuoteForm");
const ks = require("../fullPolicycompany/kshema/kshemaSettle");

const KYC_FORM = "https://assurehub.kshema.co/kyc?identifier=CS1&lineOfBusiness=MOTOR&token=x&returnUrl=y";
const KYC_OK =
  "https://assurehub.kshema.co/kyc/ack?status=success&message=Your+identity+has+been+verified+successfully.&returnUrl=https%3A%2F%2Fmotorinsurance.kshema.co";
const PROPOSAL = "https://motorinsurance.kshema.co/app/policy?policy_id=P1";
const BACK = "https://motorinsurance.kshema.co/app/policy?policy_id=P1&kyc=done";

/**
 * A browser whose tabs change with the (mocked) clock. `script(t)` -> [{ handle, url, alert, body }] for the time since
 * the watch started. sleep moves the clock.
 */
function scriptedBrowser(script) {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  let current = null;
  const tab = () => script(at()).find((x) => x.handle === current) || null;
  const sleeps = [];
  const driver = {
    sleeps,
    async getAllWindowHandles() {
      return script(at()).map((x) => x.handle);
    },
    switchTo() {
      return {
        window: async (h) => {
          if (!script(at()).some((x) => x.handle === h)) throw new Error("no such window");
          current = h;
        },
        defaultContent: async () => {},
        frame: async () => {},
      };
    },
    async executeScript(src) {
      const t = tab();
      if (!t) throw new Error("no such window");
      if (String(src).includes("text-destructive")) return t.alert || "";
      if (String(src).includes("document.body")) return t.body || "";
      return null;
    },
    async findElements() {
      return [];
    },
    async getCurrentUrl() {
      const t = tab();
      if (!t) throw new Error("no such window");
      return t.url;
    },
    async sleep(ms) {
      sleeps.push(ms);
      mock.timers.tick(ms);
    },
  };
  return { driver, at };
}

async function watch(mod, script) {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const { driver, at } = scriptedBrowser(script);
    const verdict = await mod.waitForKycRefusal(driver, 30000);
    return { verdict, ms: at() };
  } finally {
    mock.timers.reset();
  }
}

for (const [name, mod] of [["kshemaQuoteForm", quote], ["kshemaTPQuoteForm (TP copy)", tpQuote]]) {
  test(`${name}: KYC Verified + sent back to KSHEMA -> the watch ends ~5 s after, not 30 s`, async () => {
    // the verified page counts down 10 s, then goes back to KSHEMA
    const { verdict, ms } = await watch(mod, (t) => [
      { handle: "proposal", url: PROPOSAL, body: "KYC verification Status Pending" },
      { handle: "kyc", url: t < 10000 ? KYC_OK : BACK, body: t < 10000 ? "KYC Verified Your identity has been verified successfully" : "" },
    ]);
    assert.equal(verdict, null);
    assert.ok(ms >= 10000 && ms <= 11000, `ended at ${ms} ms (old: 30000)`);
  });

  test(`${name}: KYC Verified and the tab closes itself -> ends once 5 s have passed`, async () => {
    const { verdict, ms } = await watch(mod, (t) => [
      { handle: "proposal", url: PROPOSAL, body: "" },
      ...(t < 1500 ? [{ handle: "kyc", url: KYC_OK, body: "KYC Verified" }] : []),
    ]);
    assert.equal(verdict, null);
    assert.ok(ms >= 5000 && ms <= 6000, `ended at ${ms} ms`);
  });

  test(`${name}: KYC Verified but the page never goes back -> the full 30 s as before`, async () => {
    const { verdict, ms } = await watch(mod, () => [
      { handle: "proposal", url: PROPOSAL, body: "" },
      { handle: "kyc", url: KYC_OK, body: "KYC Verified" },
    ]);
    assert.equal(verdict, null);
    assert.ok(ms >= 30000, `ended at ${ms} ms`);
  });

  test(`${name}: no "KYC Verified" page -> the full 30 s as before`, async () => {
    const { verdict, ms } = await watch(mod, () => [
      { handle: "proposal", url: PROPOSAL, body: "" },
      { handle: "kyc", url: "https://assurehub.kshema.co/kyc/ack?status=pending", body: "" },
    ]);
    assert.equal(verdict, null);
    assert.ok(ms >= 30000);
  });

  test(`${name}: a refusal is still caught at once, also one that comes after "KYC Verified"`, async () => {
    const early = await watch(mod, () => [
      { handle: "proposal", url: PROPOSAL, body: "" },
      { handle: "kyc", url: KYC_FORM, body: "No record found" },
    ]);
    assert.equal(early.verdict, "No record found");
    assert.ok(early.ms < 1000);

    const late = await watch(mod, (t) => [
      { handle: "proposal", url: PROPOSAL, body: t >= 3000 ? "The gender on your document doesn't match your profile" : "" },
      { handle: "kyc", url: t < 2000 ? KYC_OK : BACK, body: "" },
    ]);
    assert.equal(late.verdict, "KYC was not completed", "a refusal inside the 5 s after KYC Verified wins");
    assert.ok(late.ms >= 3000 && late.ms < 5000, `caught at ${late.ms} ms`);
  });

  test(`${name}: a tab whose address cannot be read counts as still on the KYC pages`, async () => {
    let calls = 0;
    const { verdict, ms } = await watch(mod, (t) => {
      calls += 1;
      return [
        { handle: "proposal", url: PROPOSAL, body: "" },
        { handle: "kyc", url: t < 1000 ? KYC_OK : t < 12000 ? "" : BACK, body: "" },
      ];
    });
    assert.equal(verdict, null);
    assert.ok(ms >= 12000 && ms <= 13000, `ended at ${ms} ms - not while the KYC tab's address was unreadable`);
    assert.ok(calls > 0);
  });
}

test("kshemaSettle: KSHEMA's KYC addresses", () => {
  assert.equal(ks.isKycSuccessUrl(KYC_OK), true);
  assert.equal(ks.isKycSuccessUrl("https://assurehub.kshema.co/kyc/ack?status=failure&message=x"), false);
  assert.equal(ks.isKycSuccessUrl("https://assurehub.kshema.co/kyc/ack?status=successful"), false);
  assert.equal(ks.isKycSuccessUrl(KYC_FORM), false);
  assert.equal(ks.isKycSuccessUrl("https://evil.example/kyc/ack?status=success"), false);
  assert.equal(ks.isOnKycProvider(KYC_FORM), true);
  assert.equal(ks.isOnKycProvider(KYC_OK), true);
  assert.equal(ks.isOnKycProvider(BACK), false);
  assert.equal(ks.isOnKycProvider("https://motorinsurance.kshema.co/api/v1/integration/kycUpdate?policy_id=CS1%7CP1"), false);
});

/* ---------------------------------- the pause after a field ---------------------------------- */

function stableDriver(answers) {
  const sleeps = [];
  let i = 0;
  return {
    sleeps,
    executeScript: async () => answers[Math.min(i++, answers.length - 1)],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    get reads() {
      return i;
    },
  };
}

test("fieldSettlePause: no signal on the page -> exactly the old sleep(300), and only one look per run", async () => {
  const d = stableDriver([null]);
  assert.deepEqual(await ks.fieldSettlePause(d, 300), { early: false });
  assert.equal(d.sleeps.reduce((a, b) => a + b, 0) <= 300 && d.sleeps.reduce((a, b) => a + b, 0) >= 299, true);
  await ks.fieldSettlePause(d, 300);
  assert.equal(d.reads, 1, "the page is not asked again once it said it has no signal");
  assert.equal(d.sleeps[d.sleeps.length - 1], 300);

  const noScript = { sleeps: [], sleep: async (ms) => noScript.sleeps.push(ms) };
  await ks.fieldSettlePause(noScript, 300);
  assert.deepEqual(noScript.sleeps, [300]);
});

test("fieldSettlePause: never early before the page has once said 'busy'; then early only when idle twice", async () => {
  const d = stableDriver([true, true, true]);
  const first = await ks.fieldSettlePause(d, 300);
  assert.equal(first.early, false, "a page that has only ever said idle could be one without Angular's zone");

  const d2 = stableDriver([false, true, true, true]);
  const busy = await ks.fieldSettlePause(d2, 300);
  assert.equal(busy.early, false, "something pending -> the old pause, then the loader wait");
  const idle = await ks.fieldSettlePause(d2, 300);
  assert.equal(idle.early, true);
  assert.ok(d2.sleeps.slice(-1)[0] <= 60, "one short look apart, not 300 ms");

  const d3 = stableDriver([false, true, false, true, true]);
  await ks.fieldSettlePause(d3, 300); // learns: busy
  const flicker = await ks.fieldSettlePause(d3, 300);
  assert.equal(flicker.early, false, "idle then busy again -> the rest of the old pause");
});
