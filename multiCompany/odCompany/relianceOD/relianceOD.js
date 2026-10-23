/**
 * Reliance OD. Runs ../../common/reliance/relianceMultiForm.js — a duplicate of the full-company Reliance flow
 * (fullPolicycompany/relianceForm.js) with its own browser, login, form, error mapping and cleanup — so it does NOT go
 * through runHandler / common/login like the login-only handlers. What differs from the original is listed (and tagged
 * "[MC]") at the top of that file: the product is the part's own (RELIANCE_OD_PRODUCT), no inline Brisk certificate.
 *
 *   1. MULTI_COMPANY_AUTOMATION_ENABLED off -> [E110] before anything runs (no browser, no database, no S3).
 *   2. RELIANCE_MULTI_FORM_ENABLED set to false -> what this handler did before the form existed: log in (a copy of the
 *      full-company Reliance login, common/reliance/fullCompanyLogin.js, done by common/runHandler), open
 *      Motors -> Two Wheeler (motorsMenu.js) and stop cleanly there. Nothing is chosen or bought.
 *   3. otherwise (the default) -> the duplicated form. It chooses "Two Wheeler Own damage Policy" (the default of
 *      RELIANCE_OD_PRODUCT, common/reliance/multiConfig.js), answers the TP Details box that opens after Skip To Main Page
 *      and runs the full-company steps (customer, vehicle — with the Fuel Type box the OD form needs, Get Coverage
 *      Details, the Helmet cover removed, Nil Depreciation — but not the PA Cover block, the OD form has none), where it
 *      STOPS on purpose — the steps after them are not built yet (common/reliance/relianceOdSteps.js,
 *      lib/vehicleFuelType.js, multiCompany/README.md §15.11 and §15.12).
 *
 * The form is loaded when a part runs, not when the server starts: it is a 5,000-line module with a browser behind it.
 */
const { assertMultiCompanyEnabled } = require("../../common/featureGate");
const { runHandler } = require("../../common/runHandler");
const { isRelianceMultiFormEnabled } = require("../../common/reliance/multiConfig");
const { openTwoWheeler } = require("./motorsMenu");

/** Today's behaviour from before the form existed: login, Motors -> Two Wheeler, stop. */
function loginAndOpenTwoWheeler(data) {
  return runHandler({
    company: "reliance",
    policyType: "od",
    data,
    body: async (ctx) => {
      await openTwoWheeler(ctx.driver);

      ctx.stop("Reliance OD: Motors → Two Wheeler opened — the form is switched off (RELIANCE_MULTI_FORM_ENABLED)", {
        stage: "motors-two-wheeler",
      });
    },
  });
}

/**
 * @param {Object} data - job payload (username / password / loginUrl resolved by server.js, plus the policy's form data).
 */
async function fillRelianceOD(data = {}) {
  assertMultiCompanyEnabled();
  if (!isRelianceMultiFormEnabled()) return loginAndOpenTwoWheeler(data);
  const { fillRelianceMultiForm } = require("../../common/reliance/relianceMultiForm");
  return fillRelianceMultiForm({ ...data, policyType: "od" });
}

module.exports = { fillRelianceOD };
