/**
 * Reliance OD-only automation. Currently stops right after make & model; each
 * future increment moves the stop() call one step later as the Reliance OD
 * portal sequence (plan selection, IDV, KYC, payment...) is supplied.
 *
 * Login, loading detection, invalid-credential handling, screenshots and
 * cleanup all come from common/runHandler — this file is only the part that is
 * specific to Reliance OD.
 *
 * The standalone-OD plan option's exact portal text is not yet confirmed —
 * see the plan's "Open assumptions" section. Only login + vehicle identity
 * are real; everything past that is intentionally unbuilt.
 */
const { runHandler } = require("../../common/runHandler");
const { fillSection } = require("../../common/engine");
const { MultiCompanyError } = require("../../common/errors");
const kendoAdapter = require("../../common/adapters/kendoAdapter");
const { MAKE_MODEL_FIELDS } = require("../../common/reliance/vehicleIdentityFields");

const ADAPTERS = { kendo: kendoAdapter };

/**
 * @param {Object} data - job payload (username / password / loginUrl resolved
 *   by server.js, plus the policy's form data).
 */
function fillRelianceOD(data = {}) {
  return runHandler({
    company: "reliance",
    policyType: "od",
    data,
    body: async (ctx) => {
      // TODO(user): navigate Motors -> Two Wheeler -> the standalone OD plan
      // option before vehicle details can be reached for real. Filling
      // make/model directly here is a placeholder until that navigation step
      // is supplied.
      const result = await fillSection(
        ctx.driver,
        ctx.data,
        MAKE_MODEL_FIELDS,
        "vehicle identity",
        ADAPTERS,
        ctx.capture
      );

      // The fill result used to be ignored — a failed make/model still ended
      // in a calm "stopped after make & model". A failure is a failure.
      if (!result.ok) {
        throw new MultiCompanyError("E306", result.error, { stage: "vehicle_identity", company: "reliance" });
      }

      ctx.stop("Stopped after make & model — Reliance OD skeleton, nothing past this exists yet", {
        stage: "vehicle_identity",
        result,
      });
    },
  });
}

module.exports = { fillRelianceOD };
