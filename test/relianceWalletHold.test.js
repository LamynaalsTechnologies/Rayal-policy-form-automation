// Run with: node --test test/relianceWalletHold.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const hold = require("../fullPolicycompany/reliance/relianceWalletHold");
const { stopper, isAutomationStop, stoppedResult } = require("../automationStopper");

/** Run fn with RELIANCE_WALLET_HOLD_ENABLED set (undefined = absent), then put it back. */
function withSwitch(value, fn) {
  const before = process.env.RELIANCE_WALLET_HOLD_ENABLED;
  if (value === undefined) delete process.env.RELIANCE_WALLET_HOLD_ENABLED;
  else process.env.RELIANCE_WALLET_HOLD_ENABLED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.RELIANCE_WALLET_HOLD_ENABLED;
    else process.env.RELIANCE_WALLET_HOLD_ENABLED = before;
  }
}

test("link is the only non-wallet method; blank is the backend default, which is wallet", () => {
  assert.equal(hold.isWalletPayment("link"), false);
  assert.equal(hold.isWalletPayment("Link"), false);
  assert.equal(hold.isWalletPayment(" LINK "), false);
  for (const wallet of ["wallet", "Wallet", "", "  ", undefined, null]) {
    assert.equal(hold.isWalletPayment(wallet), true, `${JSON.stringify(wallet)} is a wallet policy`);
  }
});

test("the switch is ON unless explicitly false / 0 / no / off", () => {
  withSwitch(undefined, () => assert.equal(hold.isRelianceWalletHoldEnabled(), true));
  for (const on of ["true", "1", "yes", "on", "", "anything"]) {
    withSwitch(on, () => assert.equal(hold.isRelianceWalletHoldEnabled(), true, `"${on}" keeps it on`));
  }
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    withSwitch(off, () => assert.equal(hold.isRelianceWalletHoldEnabled(), false, `"${off}" turns it off`));
  }
});

test("shouldHoldForWallet: wallet holds, link never does, switch off never does", () => {
  withSwitch(undefined, () => {
    assert.equal(hold.shouldHoldForWallet("wallet"), true);
    assert.equal(hold.shouldHoldForWallet(undefined), true);
    assert.equal(hold.shouldHoldForWallet("link"), false, "the link flow must not be touched");
  });
  withSwitch("false", () => {
    assert.equal(hold.shouldHoldForWallet("wallet"), false, "switch off = old behaviour");
    assert.equal(hold.shouldHoldForWallet(undefined), false);
    assert.equal(hold.shouldHoldForWallet("link"), false);
  });
});

test("the stop the flow throws is an automation stop, carries the stage, and is not retryable", () => {
  let caught = null;
  try {
    stopper(hold.WALLET_HOLD_MESSAGE, { stage: hold.WALLET_HOLD_STAGE, pageUrl: "https://portal/pay" });
  } catch (e) {
    caught = e;
  }
  assert.ok(isAutomationStop(caught));
  const result = stoppedResult(caught);
  assert.equal(result.stage, "reliance-wallet-hold");
  assert.equal(result.inProgress, true, "server.js records it as stopped on purpose, not as a failure");
  assert.equal(result.retryable, false);
  assert.equal(result.success, false, "nothing was paid, so it is never a completed policy");
  assert.equal(result.browserLeftOpen, true);
  assert.equal(result.stopDetails.pageUrl, "https://portal/pay");
  assert.match(result.error, /wallet/i);
});

test("relianceForm.js: the hold sits after Pay is clicked, beside the link flow, and runs before the Brisk call", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
  const at = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `missing in relianceForm.js: ${needle}`);
    return i;
  };
  const payClicked = at('console.log("✅ Clicked Pay button")');
  const linkBranch = at("data.Paymentmethod.toLowerCase() === 'link'");
  const holdBranch = at("else if (shouldHoldForWallet(data.Paymentmethod))");
  const stopCall = at("stopper(WALLET_HOLD_MESSAGE, { stage: WALLET_HOLD_STAGE");
  // after the payment block: stage 3 is recorded (relianceStages.js), then the run goes on to the Brisk call
  const brisk = at("if (paymentDone) {");
  assert.ok(payClicked < linkBranch && linkBranch < holdBranch && holdBranch < stopCall && stopCall < brisk);
  assert.equal(src.split("shouldHoldForWallet(").length - 1, 1, "one hold branch only");
});
