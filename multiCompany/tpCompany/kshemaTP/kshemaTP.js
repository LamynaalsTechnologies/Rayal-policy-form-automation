/**
 * KSHEMA TP. Runs ./kshemaTPForm.js — a duplicate of the full-company KSHEMA flow (fullPolicycompany/kshemaForm.js)
 * with its own login, form, error mapping and cleanup — so it does NOT go through runHandler / common/login like the
 * login-only handlers (that would open the browser and log in twice). What differs from the original is listed (and
 * tagged "[TP]") at the top of kshemaTPForm.js and kshemaTPQuoteForm.js: the Product Type for a third-party-only
 * policy, no IDV, no OD discount, no add-ons, no inline Brisk certificate.
 *
 *   1. MULTI_COMPANY_AUTOMATION_ENABLED off -> [E110] before anything runs (no browser, no database, no S3).
 *   2. KSHEMA_TP_FORM_ENABLED=false, or KSHEMA_TP_PRODUCT_TYPE not set yet -> the form runs only as far as the Product
 *      Type, lists the portal's options in the stop message and stops (stopBeforeProduct.js). Nothing is bought.
 *   3. otherwise -> the whole form, up to the Razorpay QR and the payment link (the same ending as the full-company
 *      KSHEMA flow). A finished TP releases the OD of the same policy (lib/jobSequence.js / dependsOn "tp").
 *
 * The bundled KSHEMA dispatch (server.js dispatchBundled) prepares nothing before fillKshemaForm — no nominee fallback,
 * no PA-term check — so there is no "prepare" step here either: the part runner already hands this handler the same
 * fields (username / password / loginUrl / _jobId / _jobIdentifier / _attemptNumber / _jobQueueCollection).
 */
const { assertMultiCompanyEnabled, MULTI_COMPANY_AUTOMATION_ENABLED } = require("../../common/featureGate");
const { kshemaTpProductType, isKshemaTpReady } = require("./tpConfig");
const { fillKshemaForm } = require("./kshemaTPForm");

const HOLD_NOTICE =
  "⏸️  [KSHEMA TP] a KSHEMA TP part logs in, fills the quote as far as the Product Type, lists the portal's Product " +
  "Type options and stops. Set KSHEMA_TP_PRODUCT_TYPE in the automation .env to the exact option text (and remove " +
  "KSHEMA_TP_FORM_ENABLED=false if it is there), then restart it, to run the whole form.";

const READY_NOTICE = (productType) =>
  `✅ [KSHEMA TP] the TP form is ON — a KSHEMA TP part selects the Product Type "${productType}" and runs on up to ` +
  "the Razorpay QR and payment link. (KSHEMA_TP_FORM_ENABLED=false holds it at the Product Type; " +
  "BREAKER_STOP_AT=KSHEMA TP/quote stops it before the quote is submitted.)";

// Said once when the server loads the handler, so the state of the switch is in the first lines of the log and not
// something to find out from a stopped policy.
if (MULTI_COMPANY_AUTOMATION_ENABLED) {
  console.log(isKshemaTpReady() ? READY_NOTICE(kshemaTpProductType()) : HOLD_NOTICE);
}

/**
 * @param {Object} data - job payload (username / password / loginUrl resolved by server.js or lib/partRunner.js, plus
 *   the policy's form data — the TP part's vehicle already overlaid by lib/partRunner.js).
 */
async function fillKshemaTP(data = {}) {
  assertMultiCompanyEnabled();
  if (!isKshemaTpReady()) console.log(HOLD_NOTICE);
  return fillKshemaForm(data);
}

module.exports = { fillKshemaTP };
