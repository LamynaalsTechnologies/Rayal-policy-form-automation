/**
 * Reliance OD. Built so far: login (a copy of the full-company Reliance login, common/reliance/fullCompanyLogin.js,
 * done by common/runHandler) and Motors -> Two Wheeler (motorsMenu.js, copied from the full-company flow).
 * It then stops cleanly on the Two Wheeler page: the next step is not built yet, so nothing past it is attempted.
 *
 * Each new step goes into the body below, before the ctx.stop(...), and the stop moves down with it. The make & model
 * fields (common/reliance/vehicleIdentityFields.js) and the field-table filler (common/engine.js fillSection) are ready.
 */
const { runHandler } = require("../../common/runHandler");
const { openTwoWheeler } = require("./motorsMenu");

/**
 * @param {Object} data - job payload (username / password / loginUrl resolved by server.js, plus the policy's form data).
 */
function fillRelianceOD(data = {}) {
  return runHandler({
    company: "reliance",
    policyType: "od",
    data,
    body: async (ctx) => {
      await openTwoWheeler(ctx.driver);

      ctx.stop("Reliance OD: Motors → Two Wheeler opened — the next step is not built yet", {
        stage: "motors-two-wheeler",
      });
    },
  });
}

module.exports = { fillRelianceOD };
