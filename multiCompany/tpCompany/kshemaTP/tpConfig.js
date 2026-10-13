/**
 * KSHEMA TP — its two settings, both in the automation's .env and both read at CALL time (a restart after editing
 * .env is all it needs, and a test can flip them).
 *
 * KSHEMA_TP_FORM_ENABLED — ON unless it is explicitly false / 0 / no / off.
 *   on (the default): a KSHEMA TP part runs the duplicated KSHEMA form for a third-party-only policy.
 *   off: it logs in, fills the quote form as far as the Product Type, lists the portal's Product Type options and
 *        stops (stopBeforeProduct.js). Nothing is chosen or bought.
 *
 * KSHEMA_TP_PRODUCT_TYPE — the EXACT text of the Product Type option for a third-party-only (liability) two-wheeler
 *   policy, as the KSHEMA portal shows it. Not known when this was written, so it starts EMPTY: with it empty the run
 *   takes the same stop as the switch-off one and names the options, so the right text can be copied from the message.
 *   Matching is exact (spaces and case ignored) — never "contains": "Two Wheeler" must not land on
 *   "Two Wheeler-Bundled".
 *
 * MULTI_COMPANY_AUTOMATION_ENABLED (common/featureGate.js) still comes first: with that off nothing here runs at all.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isKshemaTpFormEnabled() {
  return !isOff(process.env.KSHEMA_TP_FORM_ENABLED);
}

/** The configured Product Type text, whitespace-collapsed; "" when none is set. */
function kshemaTpProductType() {
  return String(process.env.KSHEMA_TP_PRODUCT_TYPE == null ? "" : process.env.KSHEMA_TP_PRODUCT_TYPE)
    .replace(/\s+/g, " ")
    .trim();
}

/** Can the run go past the Product Type? (switch on AND the option's text is known) */
function isKshemaTpReady() {
  return isKshemaTpFormEnabled() && kshemaTpProductType() !== "";
}

/** Why the run is stopping at the Product Type, in words for the operator — "" when it is not. */
function kshemaTpHoldReason() {
  if (!isKshemaTpFormEnabled()) return "KSHEMA_TP_FORM_ENABLED is set to false";
  if (kshemaTpProductType() === "") return "KSHEMA_TP_PRODUCT_TYPE is not set";
  return "";
}

module.exports = { isKshemaTpFormEnabled, kshemaTpProductType, isKshemaTpReady, kshemaTpHoldReason };
