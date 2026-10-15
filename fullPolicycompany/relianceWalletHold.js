/**
 * Reliance full-company — hold on the payment page when the policy is paid from the wallet.
 *
 * RELIANCE_WALLET_HOLD_ENABLED in the automation's .env: ON unless it is explicitly false / 0 / no / off.
 *   on (the default): after Pay is clicked, a wallet policy stops right there (automationStopper's stopper()) —
 *        the browser stays on the payment page, nothing is paid at Reliance, no Brisk certificate is created,
 *        no PDF is merged. The job is recorded as "stopped on purpose" (E100, no retry).
 *   off: the old behaviour — log "skipping the link flow" and carry on to the Brisk call.
 *
 * "Wallet" means anything that is not "link": the backend defaults Paymentmethod to "wallet", so an empty value is
 * a wallet policy too. The "link" flow is not touched by this file at all.
 *
 * Read at CALL time, not at load, so a restart after editing .env is the only thing it needs and a test can flip it.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

/** Stage recorded on the stop (stoppedResult().stage) — what an operator sees in the job's error log. */
const WALLET_HOLD_STAGE = "reliance-wallet-hold";

/** The sentence the operator reads in the policy's error log. */
const WALLET_HOLD_MESSAGE =
  "Held on the Reliance payment page: the payment method is wallet. Nothing has been paid at Reliance — " +
  "waiting for the wallet payment steps to be built.";

function isRelianceWalletHoldEnabled() {
  return !isOff(process.env.RELIANCE_WALLET_HOLD_ENABLED);
}

/** "link" is the only non-wallet method; blank/undefined is the backend default, which is "wallet". */
function isWalletPayment(paymentMethod) {
  return String(paymentMethod == null ? "" : paymentMethod).trim().toLowerCase() !== "link";
}

/**
 * RELIANCE_WALLET_CDT_ENABLED — ON unless explicitly false / 0 / no / off. A wallet policy no longer just holds on the
 * payment page: it checks the login has the CDT option, chooses it, enters the payable amount and presses Add, then waits
 * (relianceWalletCdt.js). Off = the hold above, exactly as before. Read at call time.
 */
function isWalletCdtEnabled() {
  return !isOff(process.env.RELIANCE_WALLET_CDT_ENABLED);
}

/**
 * RELIANCE_WALLET_SUBMIT_ENABLED — ON unless explicitly false / 0 / no / off. After the CDT row is added the run goes on:
 * Submit Details, the policy number, the policy PDF — saved on the policy — and the policy is completed
 * (relianceWalletIssue.js). Off = the wait after Add exactly as before (the run stops, nothing is submitted). Only
 * meaningful together with isWalletCdtEnabled(). Read at call time.
 */
function isWalletSubmitEnabled() {
  return !isOff(process.env.RELIANCE_WALLET_SUBMIT_ENABLED);
}

/**
 * RELIANCE_WALLET_RECOVER_ENABLED — ON unless explicitly false / 0 / no / off. A re-run of a policy whose note says
 * `issued` (Submit Details was pressed, Reliance issued the policy) no longer refuses: it logs in, fetches the PDF from
 * View Policy by the policy number, stores it and completes — nothing is paid again (relianceWalletIssue.js). Off = that
 * policy is refused like every other blocking note. Read at call time.
 */
function isWalletRecoverEnabled() {
  return !isOff(process.env.RELIANCE_WALLET_RECOVER_ENABLED);
}

/** Should this policy stop on the payment page? (switch on AND paid from the wallet) */
function shouldHoldForWallet(paymentMethod) {
  return isRelianceWalletHoldEnabled() && isWalletPayment(paymentMethod);
}

module.exports = {
  isWalletCdtEnabled,
  isWalletSubmitEnabled,
  isWalletRecoverEnabled,
  isRelianceWalletHoldEnabled,
  isWalletPayment,
  shouldHoldForWallet,
  WALLET_HOLD_STAGE,
  WALLET_HOLD_MESSAGE,
};
