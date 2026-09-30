/**
 * The single login entry point for every multiCompany handler.
 *
 *   await login(driver, "national", { username, password, loginUrl }, { jobId, log });
 *
 * Adding a fourth insurer = one new <company>Login.js strategy + one line here.
 */
const { runLogin } = require("./runLogin");

const STRATEGIES = {
  reliance: () => require("./relianceLogin"),
  national: () => require("./nationalLogin"),
  kshema: () => require("./kshemaLogin"),
};

function login(driver, company, creds, ctx) {
  const factory = STRATEGIES[String(company || "").toLowerCase()];
  if (!factory) throw new Error(`login: unknown company "${company}"`);
  return runLogin(driver, factory(), creds, ctx);
}

module.exports = { login, SUPPORTED_COMPANIES: Object.keys(STRATEGIES) };
