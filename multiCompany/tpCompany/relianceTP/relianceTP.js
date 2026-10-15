/**
 * Reliance TP. Runs ../../common/reliance/relianceMultiForm.js — a duplicate of the full-company Reliance flow
 * (fullPolicycompany/relianceForm.js) with its own browser, login, form, error mapping and cleanup — so it does NOT go
 * through runHandler / common/login like the login-only handlers. What differs from the original is listed (and tagged
 * "[MC]") at the top of that file: the product is the part's own (RELIANCE_TP_PRODUCT), no inline Brisk certificate.
 *
 *   1. MULTI_COMPANY_AUTOMATION_ENABLED off -> [E110] before anything runs (no browser, no database, no S3).
 *   2. RELIANCE_MULTI_FORM_ENABLED set to false -> what this handler did before the form existed: log in through
 *      common/login (a copy of the full-company Reliance login, common/reliance/fullCompanyLogin.js, the same one
 *      Reliance OD uses) and stop cleanly. Nothing is chosen or bought.
 *   3. otherwise (the default) -> the duplicated form. With RELIANCE_TP_PRODUCT not set it opens the Sub Product
 *      dropdown, lists the portal's products and stops (common/reliance/stopBeforeProduct.js).
 *
 * The form is loaded when a part runs, not when the server starts: it is a 5,000-line module with a browser behind it.
 */
const { assertMultiCompanyEnabled } = require("../../common/featureGate");
const { makeLoginOnlyHandler } = require("../../common/loginOnlyHandler");
const { isRelianceMultiFormEnabled } = require("../../common/reliance/multiConfig");

const loginOnly = makeLoginOnlyHandler("reliance", "tp");

/**
 * @param {Object} data - job payload (username / password / loginUrl resolved by server.js, plus the policy's form data).
 */
async function fillRelianceTP(data = {}) {
  assertMultiCompanyEnabled();
  if (!isRelianceMultiFormEnabled()) return loginOnly(data);
  const { fillRelianceMultiForm } = require("../../common/reliance/relianceMultiForm");
  return fillRelianceMultiForm({ ...data, policyType: "tp" });
}

module.exports = { fillRelianceTP };
