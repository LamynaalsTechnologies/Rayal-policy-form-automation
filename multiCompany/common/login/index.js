/**
 * The single login entry point for every multiCompany handler.
 *
 *   await login(driver, "national", { username, password, loginUrl }, { jobId, log });
 *
 * Reliance logs in with a COPY of the full-company Reliance login (../reliance/fullCompanyLogin.js), so the
 * Reliance OD and TP handlers log in exactly as the full-company flow does. National and KSHEMA go through the
 * shared loop (runLogin.js) with a per-insurer strategy.
 * Adding another insurer = one new <company>Login.js strategy + one line in STRATEGIES.
 */
const { runLogin } = require("./runLogin");

// Insurers that keep their own login code, called as (driver, creds, ctx).
const OWN_LOGIN = {
  reliance: () => require("../reliance/fullCompanyLogin").fullCompanyLogin,
};

// Insurers that log in through the shared loop.
const STRATEGIES = {
  national: () => require("./nationalLogin"),
  kshema: () => require("./kshemaLogin"),
};

function login(driver, company, creds, ctx) {
  const key = String(company || "").toLowerCase();
  if (OWN_LOGIN[key]) return OWN_LOGIN[key]()(driver, creds, ctx);
  const factory = STRATEGIES[key];
  if (!factory) throw new Error(`login: unknown company "${company}"`);
  return runLogin(driver, factory(), creds, ctx);
}

module.exports = { login, SUPPORTED_COMPANIES: [...Object.keys(OWN_LOGIN), ...Object.keys(STRATEGIES)] };
