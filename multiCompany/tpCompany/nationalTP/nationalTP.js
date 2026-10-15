/**
 * National TP. Runs ./nationalTPForm.js — a duplicate of the full-company National flow (fullPolicycompany/national.js)
 * with its own login, form, error mapping and cleanup — so it does NOT go through runHandler / common/login like the
 * other handlers. What differs from the original is listed (and tagged "[TP]") at the top of that file: the plan is
 * "5 Year Long Term Liability Only", no IDV, no Manufacturer's Selling Price and no discount %, no inline Brisk
 * certificate.
 *
 *   1. MULTI_COMPANY_AUTOMATION_ENABLED off -> [E110] before anything runs (no browser, no database, no S3).
 *   2. NATIONAL_TP_FORM_ENABLED set to false -> the form runs only as far as "Your Plan", lists the portal's plan
 *      options and stops (stopBeforePlan.js). Nothing is bought; this module does no database lookup either.
 *   3. otherwise (the default) -> prepareNationalTp() below, then the whole form, up to the payment link.
 */
const { assertMultiCompanyEnabled, MULTI_COMPANY_AUTOMATION_ENABLED } = require("../../common/featureGate");
const { isNationalTpFormEnabled } = require("./tpConfig");
const { fillNationalForm } = require("./nationalTPForm");
const { portalPaTerm } = require("./tpPa");

const SWITCH_OFF_NOTICE =
  "⏸️  [National TP] NATIONAL_TP_FORM_ENABLED is set to false — a National TP part logs in, lists the \"Your Plan\" " +
  "options and stops before choosing the plan. Remove that line from the automation .env (or set it to true) and " +
  "restart it to select \"5 Year Long Term Liability Only\" and continue.";

const SWITCH_ON_NOTICE =
  "✅ [National TP] the TP form is ON — a National TP part selects \"5 Year Long Term Liability Only\" and runs on " +
  "up to the payment link that goes to the customer. (NATIONAL_TP_FORM_ENABLED=false in the automation .env holds it " +
  "at \"Your Plan\"; BREAKER_STOP_AT=National TP/quote stops it at the quote.)";

// Said once when the server loads the handler, so the state of the switch is in the first lines of the log and not
// something to find out from a stopped policy.
if (MULTI_COMPANY_AUTOMATION_ENABLED) {
  console.log(isNationalTpFormEnabled() ? SWITCH_ON_NOTICE : SWITCH_OFF_NOTICE);
}

/** The saved default nominee (Account & Policy Settings -> National). Loaded lazily: it needs the database. */
const defaultResolveNominee = (args) => require("../../../lib/nomineeResolver").resolveNationalNominee(args);

/**
 * What National needs before a browser is worth opening — the part of server.js dispatchBundled that only the bundled
 * path runs (the parts path hands a portal handler its data as it is):
 *
 *  - The PA term (tpPa.js): "No" when PA Cover is off or bought from Brisk; the policy's year, 1 or 5, only when PA
 *    Cover is bought from National. A year that is neither is refused here — national.js would silently fall back to
 *    "1 Year", which sells the wrong term.
 *  - A nominee: National demands one on EVERY quote. The policy's own nominee wins; the operator's saved default fills
 *    only what the policy left blank. With none at all, refuse now rather than after the login, the Vahan check and
 *    half the form.
 *
 * @returns {Promise<Object>} `data` with the resolved nominee fields
 * @throws {Error} "[E101] ..." — not retryable
 */
async function prepareNationalTp(data, { resolveNominee = defaultResolveNominee, log = console.log } = {}) {
  if (portalPaTerm(data) === null) {
    throw new Error(
      `[E101] National TP: the policy has no PA term of 1 or 5 years ` +
        `(No of Year is "${data.paCoverYears === undefined ? "" : data.paCoverYears}"). Open the policy, pick the year ` +
        `in PA Cover Details (it is asked when PA Cover is bought from National), save it, then re-run this policy.`
    );
  }

  // The saved default only ever fills what the policy left blank, so a policy that carries a whole nominee needs no lookup.
  const ownNominee = !!(data.nomineeName && data.nomineeRelation && data.nomineeAge);
  const fallback = ownNominee
    ? null
    : await resolveNominee({
        userId: data.userId,
        clientId: data.clientId,
        log: (line) => log(`→ [National TP] ${line}`),
      });

  const nomineeName = data.nomineeName || (fallback && fallback.name);
  const nomineeRelation = data.nomineeRelation || (fallback && fallback.relation);
  const nomineeAge = data.nomineeAge || (fallback && fallback.age);

  if (!(nomineeName && nomineeRelation && nomineeAge)) {
    throw new Error(
      `[E101] National requires nominee details on every quote and this policy has none. Add a nominee to the ` +
        `policy, or save a default one in Account & Policy Settings → National → Nominee Details, then re-run this policy.`
    );
  }

  return { ...data, nomineeName, nomineeRelation, nomineeAge };
}

/**
 * @param {Object} data - job payload (username / password / loginUrl resolved by server.js, plus the policy's form
 *   data — the TP part's vehicle already overlaid by lib/partRunner.js).
 */
async function fillNationalTP(data = {}) {
  assertMultiCompanyEnabled();
  if (!isNationalTpFormEnabled()) {
    console.log(SWITCH_OFF_NOTICE);
    return fillNationalForm(data);
  }
  return fillNationalForm(await prepareNationalTp(data));
}

module.exports = { fillNationalTP, prepareNationalTp };
