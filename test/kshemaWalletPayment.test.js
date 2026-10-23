// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaWalletPayment.test.js
//
// KSHEMA payment, link and wallet separated (2026-10-22). KSHEMA's "Choose Payment Method" page has Razorpay (the link flow,
// untouched) and CD Balance (the wallet). A wallet policy never takes the Razorpay road: it keeps the payment page's address,
// chooses the CD Balance card and either stops calmly (chosen, money available) or fails with a clear sentence (the red
// "Account not found" line, no card, no balance, nothing available, a click that does not take). Nothing is ever paid here -
// the press of Pay with CD Balance is kshemaWalletIssue.js's (test/kshemaWalletIssue.test.js).
//
// Fakes only - no browser, no database, no network. (The in-page reading script itself was also run in real Chrome against
// KSHEMA's real markup, pasted by the owner; that is a hand check, not part of this file.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const wallet = require("../fullPolicycompany/kshema/kshemaWalletPayment");
const ks = require("../fullPolicycompany/kshema/kshemaStages");
const { isWalletPayment: relianceIsWallet } = require("../fullPolicycompany/reliance/relianceWalletHold");

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const URL_PAY = "https://motorinsurance.kshema.co/payment/choose";
const RED_LINE = "Account not found. Username and broker code combination does not exist";
const fast = { pollMs: 10, stableMs: 20, settleMs: 60, timeoutMs: 200, balanceMs: 60 };

/**
 * A fake payment page. `cards` are plain objects: { name, text, disabled, selected, says, wrapperText, takesAfter }.
 * A click on a card that is not disabled chooses it after `takesAfter` clicks (default 1; Infinity = never takes).
 * `onRead(n)` may change the cards between reads (a card that flips, a balance that shows up late).
 */
function fakePage({ cards, action = "Select a payment method", url = URL_PAY, onRead = null, readThrows = false } = {}) {
  const calls = [];
  const clicks = [];
  let reads = 0;
  const state = { cards, action };
  for (const c of state.cards) {
    c.clicked = 0;
    c.element = {
      __card: c.name,
      click: async () => {
        calls.push(`click:${c.name}`);
        clicks.push(c.name);
        c.clicked += 1;
        if (!c.disabled && c.clicked >= (c.takesAfter || 1)) {
          state.cards.forEach((o) => (o.selected = false));
          c.selected = true;
          state.action = `Pay with ${c.name}`;
        }
      },
    };
  }
  const driver = {
    calls,
    clicks,
    state,
    get reads() {
      return reads;
    },
    async getCurrentUrl() {
      calls.push("url");
      return url;
    },
    async executeScript(script) {
      if (script === wallet.PAYMENT_CARDS_SCRIPT) {
        calls.push("read");
        reads += 1;
        if (readThrows) throw new Error("javascript error: document not ready");
        if (onRead) onRead(reads, state);
        return {
          cards: state.cards.map((c) => [c.element, c.name, c.text || c.name, !!c.disabled, !!c.selected, c.says || "", c.wrapperText || c.text || c.name]),
          action: state.action,
        };
      }
      return undefined; // scrollIntoView and the like
    },
    async sleep() {},
  };
  return driver;
}

const RAZORPAY = () => ({ name: "Razorpay", text: "Razorpay Secure payment via Razorpay", wrapperText: "Razorpay Secure payment via Razorpay" });
const CD = (over = {}) => ({
  name: "CD Balance",
  text: "CD Balance Pay directly from your CD account",
  wrapperText: "CD Balance Pay directly from your CD account AVAILABLE BALANCE ₹65,329 Updated 22 Oct 2026, 03:44 pm",
  ...over,
});
const recorder = () => {
  const shots = [];
  const capture = async (name, stage) => {
    shots.push([name, stage]);
    return { screenshotUrl: "https://s3.example/wallet.png", screenshotKey: "k/wallet.png" };
  };
  return { shots, capture };
};
const choose = (driver, over = {}) => quiet(() => wallet.chooseCdBalance(driver, { jobId: "J1", ...fast, ...over }));

/* ------------------------------------ what is a wallet policy ------------------------------------ */

test("a wallet policy is anything but link - blank is the backend's default (wallet) - ONE definition for every insurer", () => {
  assert.equal(wallet.isWalletPayment, relianceIsWallet, "the same function the Reliance wallet hold uses");
  for (const m of ["wallet", "Wallet", "", undefined, null, " wallet "]) assert.equal(wallet.isWalletPayment(m), true, JSON.stringify(m));
  for (const m of ["link", "Link", " LINK "]) assert.equal(wallet.isWalletPayment(m), false, JSON.stringify(m));
});

/* ------------------------------------ the balance on the card ------------------------------------ */

test("readBalance: the CD card's own 'Available balance' line, in any of its shapes", () => {
  const r = wallet.readBalance;
  assert.deepEqual(r("CD Balance Pay directly from your CD account AVAILABLE BALANCE ₹65,329 Updated 22 Oct 2026, 03:44 pm"), { text: "₹65,329", amount: 65329 });
  assert.deepEqual(r("Available balance ₹1,65,329.50"), { text: "₹1,65,329.50", amount: 165329.5 });
  assert.deepEqual(r("Available balance: Rs. 12,000"), { text: "₹12,000", amount: 12000 });
  assert.deepEqual(r("Available balance ₹0"), { text: "₹0", amount: 0 });
  assert.deepEqual(r("Available balance -₹500"), { text: "-₹500", amount: -500 });
  assert.deepEqual(r("Available balance ₹-500"), { text: "-₹500", amount: -500 });
  for (const none of ["", "CD Balance only", "Available balance", "Available balance Unable to fetch", null, undefined]) {
    assert.deepEqual(r(none), { text: "", amount: null }, JSON.stringify(none));
  }
  assert.equal(wallet.parseBalance("Available balance ₹65,329"), "₹65,329");
});

/* ------------------------------------ the step: CD Balance chosen = the calm stop ------------------------------------ */

test("CD Balance can be chosen: the payment page address is read FIRST, the card is clicked once, nothing else is pressed", async () => {
  const { shots, capture } = recorder();
  const driver = fakePage({ cards: [RAZORPAY(), CD()] });
  const r = await choose(driver, { capture });

  assert.equal(driver.calls[0], "url", "the address is read before the cards are even looked at");
  assert.deepEqual(driver.clicks, ["CD Balance"], "only the CD Balance card - not Razorpay, never a Pay / Continue button");
  assert.equal(r.ok, true);
  assert.equal(r.wallet, true);
  assert.equal(r.chosen, true);
  assert.equal(r.problem, "");
  assert.equal(r.paymentUrl, URL_PAY);
  assert.deepEqual(r.cards, ["Razorpay", "CD Balance"]);
  assert.equal(r.balance, "₹65,329");
  assert.equal(r.balanceAmount, 65329);
  assert.equal(r.action, "Pay with CD Balance", "what the page now offers - logged, never pressed");
  assert.deepEqual(shots, [["kshema_wallet_payment", "wallet_payment"]], "a picture of the page right before Pay");
  assert.equal(r.screenshotUrl, "https://s3.example/wallet.png");
  assert.equal(r.screenshotKey, "k/wallet.png");
  assert.match(r.note, /^wallet - CD Balance chosen on the payment page, available balance ₹65,329, nothing paid$/);
});

test("already chosen: no click at all; Razorpay chosen by default: the click moves it to CD Balance", async () => {
  const already = fakePage({ cards: [RAZORPAY(), CD({ selected: true })] });
  const a = await choose(already);
  assert.deepEqual(already.clicks, []);
  assert.equal(a.ok, true);
  assert.equal(a.chosen, true);

  const byDefault = fakePage({ cards: [{ ...RAZORPAY(), selected: true }, CD()] });
  const b = await choose(byDefault);
  assert.deepEqual(byDefault.clicks, ["CD Balance"]);
  assert.equal(b.chosen, true);
  assert.equal(byDefault.state.cards[0].selected, false, "Razorpay is no longer the chosen one");
});

test("a click that does not take the first time is made once more; the balance may show up a moment after the click", async () => {
  const slow = fakePage({ cards: [RAZORPAY(), CD({ takesAfter: 2 })] });
  const r = await choose(slow);
  assert.deepEqual(slow.clicks, ["CD Balance", "CD Balance"]);
  assert.equal(r.ok, true);

  // the balance block is drawn only on the 6th read (after the choosing)
  const late = fakePage({
    cards: [RAZORPAY(), CD({ wrapperText: "CD Balance Pay directly from your CD account" })],
    onRead: (n, state) => {
      if (n >= 6) state.cards[1].wrapperText = "CD Balance Pay directly from your CD account AVAILABLE BALANCE ₹500 Updated now";
    },
  });
  const l = await choose(late, { balanceMs: 400 });
  assert.equal(l.ok, true, JSON.stringify({ problem: l.problem, reads: late.reads }));
  assert.equal(l.balanceAmount, 500);
});

/* ------------------------------------ the step: everything else is an ERROR ------------------------------------ */

test("KSHEMA's red 'Account not found' line = an ERROR - the CD option is not enabled for this account; the card is not clicked", async () => {
  const { shots, capture } = recorder();
  const driver = fakePage({
    cards: [RAZORPAY(), CD({ disabled: true, says: RED_LINE, wrapperText: `CD Balance Pay directly from your CD account ${RED_LINE}` })],
  });
  const r = await choose(driver, { capture });
  assert.deepEqual(driver.clicks, [], "a card KSHEMA switched off is left alone");
  assert.equal(r.ok, false);
  assert.equal(r.wallet, true);
  assert.equal(r.problem, "not-enabled");
  assert.equal(r.kshemaSays, RED_LINE);
  assert.equal(r.paymentUrl, URL_PAY, "the address was read before anything");
  assert.match(r.error, /^The CD Balance option is not enabled for this KSHEMA account\. KSHEMA says Account not found\. Username and broker code combination does not exist\. /);
  assert.match(r.error, /Ask KSHEMA to enable the CD account for this login, then run the policy again\. Nothing is paid$/);
  assert.deepEqual(shots, [], "a failure gets the form's own failure picture, not a second one");
});

test("the red line is an error even when the card is not marked disabled, and when it appears only AFTER the click", async () => {
  const lineOnly = fakePage({ cards: [RAZORPAY(), CD({ says: RED_LINE })] });
  const a = await choose(lineOnly);
  assert.deepEqual(lineOnly.clicks, [], "KSHEMA already says it - nothing to try");
  assert.equal(a.problem, "not-enabled");

  const afterClick = fakePage({
    cards: [RAZORPAY(), CD({ takesAfter: Infinity })],
    onRead: (n, state) => {
      if (state.cards[1].clicked > 0) state.cards[1].says = RED_LINE; // KSHEMA answers the click with its line
    },
  });
  const b = await choose(afterClick);
  assert.deepEqual(afterClick.clicks, ["CD Balance"], "one click, then the answer is read - not clicked again");
  assert.equal(b.problem, "not-enabled");
  assert.equal(b.kshemaSays, RED_LINE);
});

test("a card that is switched off without any line is the same error, worded as switched off", async () => {
  const driver = fakePage({ cards: [RAZORPAY(), CD({ disabled: true })] });
  const r = await choose(driver);
  assert.deepEqual(driver.clicks, []);
  assert.equal(r.problem, "not-enabled");
  assert.match(r.error, /^The CD Balance option is not enabled for this KSHEMA account\. The payment page shows it switched off\./);
});

test("no CD Balance card at all, or no card readable: an error that names what the page shows", async () => {
  const noCd = fakePage({ cards: [RAZORPAY()] });
  const a = await choose(noCd);
  assert.equal(a.ok, false);
  assert.equal(a.problem, "missing");
  assert.equal(a.cdFound, false);
  assert.deepEqual(noCd.clicks, []);
  assert.equal(a.error, "The KSHEMA payment page shows no CD Balance option (it shows Razorpay), so the wallet cannot be used. Nothing is paid");

  const none = fakePage({ cards: [] });
  const b = await choose(none);
  assert.equal(b.problem, "missing");
  assert.match(b.error, /\(no payment option could be read\)/);
  assert.ok(none.reads <= Math.ceil(fast.timeoutMs / fast.pollMs), "the wait for the cards is bounded");

  const broken = fakePage({ cards: [RAZORPAY(), CD()], readThrows: true });
  const c = await choose(broken);
  assert.equal(c.ok, false, "a page that cannot be read is an error result, never an exception");
  assert.equal(c.problem, "missing");
});

test("the CD card is clicked twice at most; a card that never takes is an error", async () => {
  const stubborn = fakePage({ cards: [RAZORPAY(), CD({ takesAfter: Infinity })] });
  const r = await choose(stubborn);
  assert.deepEqual(stubborn.clicks, ["CD Balance", "CD Balance"]);
  assert.equal(r.ok, false);
  assert.equal(r.clicked, true);
  assert.equal(r.problem, "not-taking");
  assert.equal(r.error, "CD Balance did not switch on when it was clicked on the KSHEMA payment page. Nothing is paid");
});

test("'available balance also check': chosen but no balance shown, or nothing available (zero / less), is an error", async () => {
  const bare = { wrapperText: "CD Balance Pay directly from your CD account" };
  const noBalance = fakePage({ cards: [RAZORPAY(), CD(bare)] });
  const a = await choose(noBalance);
  assert.equal(a.ok, false);
  assert.equal(a.chosen, true, "the card did take - it is the balance that is missing");
  assert.equal(a.problem, "no-balance");
  assert.match(a.error, /^KSHEMA shows no available balance on the CD Balance option, so the wallet cannot be used\./);

  for (const [shown, amount] of [["₹0", 0], ["₹0.00", 0], ["-₹1,250", -1250]]) {
    const driver = fakePage({ cards: [RAZORPAY(), CD({ wrapperText: `CD Balance Pay directly from your CD account AVAILABLE BALANCE ${shown} Updated now` })] });
    const r = await choose(driver);
    assert.equal(r.ok, false, shown);
    assert.equal(r.problem, "no-money", shown);
    assert.equal(r.balanceAmount, amount);
    assert.match(r.error, /^The CD Balance of this KSHEMA account has no available money, so the wallet cannot pay this policy\. Add money to the CD account, then run the policy again\. Nothing is paid$/);
  }
});

test("KSHEMA may settle a moment after the page opens: the answer is read from the cards once they stop changing", async () => {
  // first read: CD looks clickable; from the 2nd read on KSHEMA has switched it off with its line
  const flips = fakePage({
    cards: [RAZORPAY(), CD()],
    onRead: (n, state) => {
      if (n >= 2) Object.assign(state.cards[1], { disabled: true, says: RED_LINE, wrapperText: `CD Balance ${RED_LINE}` });
    },
  });
  const r = await choose(flips);
  assert.deepEqual(flips.clicks, [], "decided on the settled page, not on the first look");
  assert.equal(r.problem, "not-enabled");
});

test("a picture that cannot be taken does not fail the CD Balance step", async () => {
  const driver = fakePage({ cards: [RAZORPAY(), CD()] });
  const r = await choose(driver, { capture: async () => { throw new Error("S3 down"); } });
  assert.equal(r.ok, true);
  assert.equal(r.screenshotUrl, null);
  const none = await choose(fakePage({ cards: [RAZORPAY(), CD()] }), { capture: async () => null });
  assert.equal(none.ok, true);
});

test("every operator sentence is free of colons - KSHEMA's own words are cleaned", async () => {
  const withColon = "Error: Account not found: Username and broker code combination does not exist";
  const driver = fakePage({ cards: [RAZORPAY(), CD({ disabled: true, says: withColon })] });
  const r = await choose(driver);
  const sentences = [
    r.error,
    r.note,
    wallet.walletNote({ chosen: true, balance: "₹1" }),
    ...["not-enabled", "missing", "not-taking", "no-balance", "no-money"].map((problem) => wallet.walletErrorMessage({ problem, kshemaSays: withColon, cards: ["Razorpay"] })),
  ];
  for (const s of sentences) assert.doesNotMatch(s, /:/, s);
  assert.match(r.error, /KSHEMA says Error - Account not found - Username/);
});

/* ------------------------------------ the payment step record ------------------------------------ */

test("paymentStageOf: a wallet policy's step stays PENDING (nothing paid) as a wallet payment; a refused wallet is FAILED as a wallet payment", () => {
  const ok = ks.paymentStageOf({ ok: true, wallet: true, paymentUrl: URL_PAY, note: "wallet - CD Balance chosen on the payment page, nothing paid" });
  assert.deepEqual(ok, { status: "pending", extra: { mode: "wallet", link: URL_PAY, note: "wallet - CD Balance chosen on the payment page, nothing paid" } });
  const noUrl = ks.paymentStageOf({ ok: true, wallet: true, paymentUrl: "" });
  assert.equal(noUrl.status, "pending");
  assert.equal("link" in noUrl.extra, false);

  const failed = ks.paymentStageOf({ ok: false, wallet: true, paymentUrl: URL_PAY, error: "The CD Balance option is not enabled for this KSHEMA account. Nothing is paid" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.extra.mode, "wallet");
  assert.doesNotMatch(failed.extra.error, /:/);

  // the link flow's record is exactly as it was
  assert.deepEqual(ks.paymentStageOf({ ok: true, paymentUrl: "https://pay.example/x", qrScreenshotKey: "k" }), { status: "completed", extra: { mode: "qr", link: "https://pay.example/x" } });
});

function fakeMongo({ matched = 1 } = {}) {
  const log = { updates: [] };
  class FakeClient {
    async connect() {}
    db() {
      return { collection: () => ({ async updateOne(filter, update) { log.updates.push({ filter, update }); return { matchedCount: matched }; } }) };
    }
    async close() {}
  }
  return { FakeClient, log };
}

test("keepPaymentPage: the payment page address goes on the policy as paymentLink - one write, nothing else touched", async () => {
  const { FakeClient, log } = fakeMongo();
  const NOW = new Date("2026-10-22T10:00:00Z");
  assert.equal(await quiet(() => ks.keepPaymentPage({ _id: "p1" }, URL_PAY, { MongoClient: FakeClient, now: NOW })), true);
  assert.equal(log.updates.length, 1);
  assert.deepEqual(log.updates[0].update.$set, { paymentLink: URL_PAY, updatedAt: NOW }, "no stage is changed by this write");

  for (const [data, url] of [[{ _id: "p1" }, ""], [{ _id: "p1" }, "about:blank"], [{}, URL_PAY]]) {
    const before = log.updates.length;
    assert.equal(await quiet(() => ks.keepPaymentPage(data, url, { MongoClient: FakeClient })), false);
    assert.equal(log.updates.length, before, "no readable address or no policy id = nothing written");
  }
  const failing = fakeMongo({ matched: 0 });
  assert.equal(await quiet(() => ks.keepPaymentPage({ _id: "p1" }, URL_PAY, { MongoClient: failing.FakeClient })), false);
});

/* ------------------------------------ the REAL proceedToPayment of both copies ------------------------------------ */

const QUOTE_FORMS = [
  ["kshemaQuoteForm.js (full company)", "../fullPolicycompany/kshema/kshemaQuoteForm"],
  ["kshemaTPQuoteForm.js (multiple company TP)", "../multiCompany/tpCompany/kshemaTP/kshemaTPQuoteForm"],
];

/** A driver good enough for proceedToPayment up to and including the page after Make Payment. */
function payDriver(page) {
  const seen = { razorpayLooked: false, finds: [] };
  const makePayment = { isDisplayed: async () => true, click: async () => page.calls.push("click:Make Payment") };
  return Object.assign(page, {
    seen,
    async findElements(locator) {
      const xp = String(locator && locator.value);
      seen.finds.push(xp);
      if (/make payment/.test(xp)) return [makePayment];
      if (/Razorpay/.test(xp)) seen.razorpayLooked = true;
      return []; // no loader, no Razorpay card
    },
    async wait(condition, ms, message) {
      const found = await condition();
      if (!found) throw new Error(message || "wait timed out");
      return found;
    },
    async getTitle() {
      return "KSHEMA";
    },
  });
}

for (const [name, modulePath] of QUOTE_FORMS) {
  test(`${name}: a WALLET policy goes to the CD Balance step and never touches Razorpay`, async () => {
    const { proceedToPayment } = require(modulePath);
    const driver = payDriver(fakePage({ cards: [RAZORPAY(), CD()] }));
    const r = await quiet(() => proceedToPayment(driver, null, "J1", { paymentMethod: "wallet" }));
    assert.equal(r.ok, true);
    assert.equal(r.wallet, true);
    assert.equal(r.chosen, true);
    assert.equal(r.paymentUrl, URL_PAY);
    assert.equal(driver.seen.razorpayLooked, false, "the Razorpay option is never even looked for");
    assert.deepEqual(driver.clicks, ["CD Balance"]);
    assert.equal(driver.calls.indexOf("click:Make Payment") >= 0 && driver.calls.indexOf("click:Make Payment") < driver.calls.indexOf("url"), true, "Make Payment first, then the address");
  });

  test(`${name}: a blank payment method is a wallet policy too (the backend default)`, async () => {
    const { proceedToPayment } = require(modulePath);
    for (const method of ["", undefined]) {
      const driver = payDriver(fakePage({ cards: [RAZORPAY(), CD()] }));
      const r = await quiet(() => proceedToPayment(driver, null, "J1", method === undefined ? {} : { paymentMethod: method }));
      assert.equal(r.wallet, true, JSON.stringify(method));
    }
    const driver = payDriver(fakePage({ cards: [RAZORPAY(), CD()] }));
    const old = await quiet(() => proceedToPayment(driver, null, "J1")); // an old caller without the option
    assert.equal(old.wallet, true, "no option = the default = wallet");
  });

  test(`${name}: a LINK policy still goes the Razorpay road - the CD Balance step is never run`, async () => {
    const { proceedToPayment } = require(modulePath);
    const driver = payDriver(fakePage({ cards: [RAZORPAY(), CD()] }));
    const r = await quiet(() => proceedToPayment(driver, null, "J1", { paymentMethod: "link" }));
    assert.equal(driver.seen.razorpayLooked, true, "Razorpay is looked for, exactly as before");
    assert.equal(r.wallet, undefined);
    assert.equal(driver.calls.includes("read"), false, "the payment cards script of the wallet step never ran");
    assert.deepEqual(driver.clicks, []);
    assert.equal(r.ok, true, "the link flow's own result (its Razorpay problem is only noted, as it always was)");
    assert.match(r.qrError, /Razorpay option not found/);
  });

  test(`${name}: a wallet policy whose CD Balance is not enabled comes back as a failure with the reason`, async () => {
    const { proceedToPayment } = require(modulePath);
    const driver = payDriver(fakePage({ cards: [RAZORPAY(), CD({ disabled: true, says: RED_LINE })] }));
    const r = await quiet(() => proceedToPayment(driver, null, "J1", { paymentMethod: "wallet" }));
    assert.equal(r.ok, false);
    assert.equal(r.wallet, true);
    assert.match(r.error, /^The CD Balance option is not enabled for this KSHEMA account/);
    assert.equal(r.paymentUrl, URL_PAY, "the address still comes back, so the form can keep it");
  });
}

/* ------------------------------------ the wiring in both flows (source) ------------------------------------ */

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const FORMS = [
  ["kshemaForm.js (full company)", read("fullPolicycompany", "kshemaForm.js"), true],
  ["kshemaTPForm.js (multiple company TP)", read("multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"), false],
];

for (const [name, src, full] of FORMS) {
  const flow = src.slice(src.indexOf("async function runKshemaFlow("));
  const at = (needle, from = 0) => {
    const i = flow.indexOf(needle, from);
    assert.ok(i >= 0, `${name}: "${needle}" is in runKshemaFlow`);
    return i;
  };

  test(`${name}: the payment method reaches the payment step`, () => {
    assert.ok(flow.includes("await proceedToPayment(driver, capture, jobId, { paymentMethod: data.Paymentmethod })"));
  });

  test(`${name}: a wallet policy keeps its address, then fails with the reason or is paid and issued - before the link flow's success`, () => {
    const pay = at("await proceedToPayment(");
    const mark = at('await markStage(data, "payment", paymentStage.status', pay);
    const failure = at("if (!paymentResult.ok) {", mark);
    const keep = at("await keepPaymentPage(data, paymentResult.paymentUrl, { jobId })", failure);
    const returned = at("return {", keep);
    const link = at("paymentLink: paymentResult.paymentUrl", returned);
    const wallet = at("if (paymentResult.wallet) {", link);
    const issue = at("await payWithCdBalanceAndIssue({", wallet);
    const done = at('await markStage(data, "payment", "completed", { mode: "wallet", link: issued.policyPageUrl, policyNumber: issued.policyNumber }, { jobId });', issue);
    const linkDone = at('log("🎉 KSHEMA flow successfully completed', done);
    assert.ok(pay < mark && mark < failure && failure < keep && keep < returned && returned < link && link < wallet && wallet < issue && issue < done && done < linkDone);
    assert.ok(!/stopper\(/.test(flow.slice(wallet, linkDone)), "no calm stop any more - the wallet policy is paid and completed");
  });

  test(`${name}: ${full ? "no Brisk certificate is raised for a wallet policy (money - once the wallet steps exist)" : "still never raises the Brisk certificate inline ([TP] 6)"}`, () => {
    if (full) {
      assert.match(flow, /const briskDecision = isWalletPayment\(data\.Paymentmethod\)\s*\?\s*\{ create: false,[^}]*\}\s*:\s*shouldCreateBriskCertificate\(data\);/);
    } else {
      assert.match(flow, /const briskDecision = \{ create: false,/);
      assert.ok(!/isWalletPayment\(data\.Paymentmethod\)/.test(flow));
    }
  });
}

for (const [name, file] of [
  ["kshemaQuoteForm.js", ["fullPolicycompany", "kshema", "kshemaQuoteForm.js"]],
  ["kshemaTPQuoteForm.js", ["multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"]],
]) {
  test(`${name}: proceedToPayment branches for a wallet policy right after Make Payment, before the Razorpay option`, () => {
    const src = read(...file);
    const fn = src.slice(src.indexOf("async function proceedToPayment("));
    assert.match(fn.split("\n")[0], /^async function proceedToPayment\(driver, capture = null, jobId = "", \{ paymentMethod \} = \{\}\) \{$/);
    const clicked = fn.indexOf('log("   🚀 Clicked Make Payment");');
    const branch = fn.indexOf("if (isWalletPayment(paymentMethod)) {");
    const razorpay = fn.indexOf("// 3. Select Razorpay option");
    assert.ok(clicked > 0 && clicked < branch && branch < razorpay, "Make Payment, the wallet branch, then the Razorpay road");
    assert.match(fn.slice(branch, razorpay), /return await chooseCdBalance\(driver, \{ capture, jobId \}\);/);
  });
}

test("the wallet module: no .env switch, one click (the CD Balance card), and no way to press a Pay button or touch Razorpay", () => {
  const src = read("fullPolicycompany", "kshema", "kshemaWalletPayment.js");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/process\.env/.test(code), "no switch of its own (the owner's rule)");
  assert.equal(code.split("clickElement(").length - 1, 1, "one click site");
  assert.ok(code.includes("clickElement(driver, cd.element,"), "the click is on the CD Balance card");
  assert.ok(!/pay with|continue & pay|show qr|razorpay|make payment/i.test(code.replace(/PAYMENT_CARDS_SCRIPT[\s\S]*?`;\s*\n/, "")), "nothing here can press Pay / Continue / Show QR");
  assert.ok(!/\.submit\(|sendKeys/.test(code), "nothing is typed or submitted");
});
