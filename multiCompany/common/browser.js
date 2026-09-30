/**
 * Open / close a job's browser for any insurer through ONE interface.
 *
 * The three insurers each have their own session manager (profile folder,
 * download folder, Chrome flags). Those stay exactly as they are — this only
 * gives the multiCompany handlers a single call instead of three, so a handler
 * never needs to know which manager to import. Managers are required lazily so
 * loading one company does not load the other two.
 */

const MANAGERS = {
  reliance: () => {
    const m = require("../../sessionManager");
    return { open: m.createRelianceJobBrowser, close: m.cleanupJobBrowser };
  },
  national: () => {
    const m = require("../../nationalSessionManager");
    return { open: m.createNationalJobBrowser, close: m.cleanupNationalJobBrowser };
  },
  kshema: () => {
    const m = require("../../fullPolicycompany/kshema/kshemaSessionManager");
    return { open: m.createKshemaJobBrowser, close: m.cleanupKshemaJobBrowser };
  },
};

const managerFor = (company) => {
  const factory = MANAGERS[String(company || "").toLowerCase()];
  if (!factory) throw new Error(`openJobBrowser: unknown company "${company}"`);
  return factory();
};

/** @returns {Promise<{driver, profileInfo, jobId}>} */
const openJobBrowser = (company, jobId) => managerFor(company).open(jobId);

/**
 * Close the job's browser. With KEEP_BROWSER_OPEN_ON_ERROR set (and a display),
 * a FAILED job's browser is deliberately left open for inspection — that
 * decision lives in debugRetention.shouldKeepBrowserOpen, unchanged.
 */
const closeJobBrowser = (company, jobBrowser, { hadError = false } = {}) =>
  jobBrowser ? managerFor(company).close(jobBrowser, { hadError }) : Promise.resolve();

module.exports = { openJobBrowser, closeJobBrowser, SUPPORTED_COMPANIES: Object.keys(MANAGERS) };
