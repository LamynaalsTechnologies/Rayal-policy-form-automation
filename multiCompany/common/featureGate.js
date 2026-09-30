/**
 * Master switch for the new multiCompany OD/TP automation framework.
 *
 * MULTI_COMPANY_AUTOMATION_ENABLED in .env. When it is not "true", every
 * entry point in multiCompany/ calls assertMultiCompanyEnabled() as its
 * first line and throws immediately — no browser, no DB write, no S3 call.
 *
 * Loads .env itself (like debugRetention.js does for KEEP_BROWSER_OPEN_ON_ERROR)
 * so this is correct regardless of which file happens to require it first.
 */

require("dotenv").config();

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());

const MULTI_COMPANY_AUTOMATION_ENABLED = isTruthy(
  process.env.MULTI_COMPANY_AUTOMATION_ENABLED
);

/** @throws {Error} [E110] when the feature flag is off. */
function assertMultiCompanyEnabled() {
  if (!MULTI_COMPANY_AUTOMATION_ENABLED) {
    throw new Error(
      "[E110] MULTI_COMPANY_AUTOMATION_ENABLED is off — enable it in .env to run OD/TP automation jobs."
    );
  }
}

module.exports = { MULTI_COMPANY_AUTOMATION_ENABLED, assertMultiCompanyEnabled };
