/**
 * Lookup table for the multiCompany OD/TP automation.
 *
 * server.js consults this by [company][policyType] once a job carries a
 * policyType. Adding a company or policy type is one new entry here — no
 * server.js change needed.
 *
 * Layout: odCompany/<company>OD/ and tpCompany/<company>TP/, one handler each;
 * everything they share (login, loading detection, error handling, browser,
 * screenshots) lives in common/. See README.md.
 */
const { fillRelianceOD } = require("./odCompany/relianceOD/relianceOD");
const { fillNationalOD } = require("./odCompany/nationalOD/nationalOD");
const { fillKshemaOD } = require("./odCompany/kshemaOD/kshemaOD");
const { fillRelianceTP } = require("./tpCompany/relianceTP/relianceTP");
const { fillNationalTP } = require("./tpCompany/nationalTP/nationalTP");
const { fillKshemaTP } = require("./tpCompany/kshemaTP/kshemaTP");

const registry = {
  reliance: { od: fillRelianceOD, tp: fillRelianceTP },
  national: { od: fillNationalOD, tp: fillNationalTP },
  kshema: { od: fillKshemaOD, tp: fillKshemaTP },
};

/** @returns {Function|null} the handler for this company+policyType, or null if none exists yet. */
function resolveMultiCompanyHandler(company, policyType) {
  const companyKey = String(company || "").toLowerCase();
  const policyTypeKey = String(policyType || "").toLowerCase();
  return (registry[companyKey] && registry[companyKey][policyTypeKey]) || null;
}

module.exports = { registry, resolveMultiCompanyHandler };
