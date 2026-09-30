/**
 * Handler for an insurer + policy type whose FORM FILLING is not built yet:
 * it does everything real (browser, login, loading/credential handling,
 * failure screenshots, cleanup) and then stops cleanly, saying so.
 *
 * That already gives a working, testable login for the company from the CLI
 * or the queue. When its form is written, replace this with a runHandler body.
 */
const { runHandler } = require("./runHandler");

const LABELS = { reliance: "Reliance", national: "National", kshema: "KSHEMA" };

function makeLoginOnlyHandler(company, policyType) {
  const label = `${LABELS[company]} ${policyType.toUpperCase()}`;
  return function loginOnlyHandler(data = {}) {
    return runHandler({
      company,
      policyType,
      data,
      body: async (ctx) => {
        ctx.stop(`Logged in to ${LABELS[company]} — the ${label} form is not built yet`, {
          stage: "logged-in",
        });
      },
    });
  };
}

module.exports = { makeLoginOnlyHandler };
