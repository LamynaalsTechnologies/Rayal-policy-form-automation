/**
 * Reliance OD / TP — the settings of the duplicated Reliance form (relianceMultiForm.js), all in the automation's .env
 * and all read at CALL time (a restart after editing .env is all it needs, and a test can flip them).
 *
 * RELIANCE_MULTI_FORM_ENABLED — ON unless it is explicitly false / 0 / no / off.
 *   on (the default): a Reliance OD or TP part runs the duplicated Reliance form (relianceMultiForm.js).
 *   off: the handlers behave as they did before the form existed — Reliance OD logs in, opens Motors -> Two Wheeler
 *        and stops; Reliance TP logs in and stops.
 *
 * RELIANCE_OD_PRODUCT / RELIANCE_TP_PRODUCT — the EXACT text of the product option in the Sub Product dropdown
 *   (span[aria-owns='ddlMotorProducts_listbox']) for an own-damage-only / third-party-only policy, as the Reliance
 *   portal shows it. Not known when this was written, so both start EMPTY: with the one for this part empty the run
 *   opens the dropdown, lists the portal's products and stops (stopBeforeProduct.js) — nothing is chosen or bought —
 *   so the right text can be copied from the message. The full-company flow's own product
 *   ("Two Wheeler Package Bundled (Only New Veh.)") is never used for a part.
 *   Matching is exact (spaces collapsed) — never "contains".
 *
 * MULTI_COMPANY_AUTOMATION_ENABLED (common/featureGate.js) still comes first: with that off nothing here runs at all.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());
const collapse = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

const normaliseKind = (kind) => (String(kind || "").trim().toLowerCase() === "tp" ? "tp" : "od");

function isRelianceMultiFormEnabled() {
  return !isOff(process.env.RELIANCE_MULTI_FORM_ENABLED);
}

/** The env name that holds this part's product text. */
const productSetting = (kind) => (normaliseKind(kind) === "tp" ? "RELIANCE_TP_PRODUCT" : "RELIANCE_OD_PRODUCT");

/** The configured product text for "od" / "tp", whitespace-collapsed; "" when none is set. */
function reliancePartProduct(kind) {
  return collapse(process.env[productSetting(kind)]);
}

/** "Reliance OD" / "Reliance TP" — the label used in the log, the stop and the Breaker checkpoints. */
const relianceMultiLabel = (kind) => (normaliseKind(kind) === "tp" ? "Reliance TP" : "Reliance OD");

/**
 * A literal for an XPath expression: single quotes unless the text has one, then double quotes, then concat().
 * The product text comes from .env, so it must not be able to break out of the expression.
 */
function xpathLiteral(text) {
  const value = String(text == null ? "" : text);
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(`, "'", `)})`;
}

module.exports = {
  isRelianceMultiFormEnabled,
  reliancePartProduct,
  productSetting,
  relianceMultiLabel,
  xpathLiteral,
  normaliseKind,
};
