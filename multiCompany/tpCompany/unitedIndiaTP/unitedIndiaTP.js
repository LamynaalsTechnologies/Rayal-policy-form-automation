/**
 * United India TP (2026-11-06). United India sells third party only (the Online Policy offers it on TP only and as the
 * TP side of a Combined Make & Model), so this is its only handler: there is no full-company or OD flow.
 *
 * What it does today, then it stops:
 *   1. runHandler (../../common/runHandler.js): the feature gate, a fresh browser (./unitedIndiaSession.js), the recording,
 *      the live Hold, the LOGIN (../../common/login/unitedIndiaLogin.js on the shared loop), a failure screenshot, clean-up.
 *   2. the sidebar's Policy Transaction > Make New/Renew Policy (./unitedIndiaMenu.js), every click checked and tried once
 *      more if it did not take (./unitedIndiaSteps.js - the owner's rule for every click and field of this flow).
 *   3. the Products page (./unitedIndiaProduct.js): Office and LOB left as the portal filled them, Select Product =
 *      "Liability Only Policy", Submit.
 *   4. Risk Details (./unitedIndiaRisk.js): Vehicle Class "Motorcycle / Scooter", Vehicle Registration State = the customer's
 *      state on the policy, New Vehicle ticked, Chassis and Engine Number from the policy, Vehicle Manufacturer = the
 *      Make & Model row's Make, the portal's Make = its Model (exact names; the owner's correction, 2026-11-06). The two
 *      lists are kept by hand on the Vehicle Model page; a run only reads and picks.
 *   5. Breaker.checkpoint("stopthis-location") - the owner's own stop point (his .env: BREAKER_ENABLED=true,
 *      BREAKER_STOP_AT=stopthis-location) - and, when the Breaker lets it pass, a plain stop: the TP form is not built yet.
 * Either way the run is "stopped on purpose": only the product choice was sent (no proposal is saved, nothing is paid), it is
 * not retried, and with
 * KEEP_BROWSER_OPEN_ON_ERROR=true the window stays open on the Risk Details page for the next steps to be written
 * (closing it by hand removes its profile - lib/retainedBrowser.js).
 *
 * The next step (the owner gives the portal's TP steps) goes after step 4, before the checkpoint.

 */
const { runHandler } = require("../../common/runHandler");
const { openMakeNewRenewPolicy } = require("./unitedIndiaMenu");
const { chooseProduct: chooseLiabilityOnly } = require("./unitedIndiaProduct");
const { fillRiskDetails } = require("./unitedIndiaRisk");

const COMPANY = "united india";
const NOT_BUILT =
  "United India - Liability Only Policy submitted, Vehicle Class, Registration State, New Vehicle, Chassis, Engine Number, Vehicle Manufacturer and Make entered, the rest of the TP form is not built yet";

/**
 * @param {Object} data the job payload (username / password / loginUrl resolved by lib/partRunner.js, plus the policy's
 *   form data with the TP part's vehicle)
 * @param {{ openMenu?: Function, chooseProduct?: Function, fillRisk?: Function }} [deps] tests replace the steps
 */
function fillUnitedIndiaTP(
  data = {},
  { openMenu = openMakeNewRenewPolicy, chooseProduct = chooseLiabilityOnly, fillRisk = fillRiskDetails } = {}
) {
  return runHandler({
    company: COMPANY,
    policyType: "tp",
    data,
    body: async (ctx) => {
      ctx.log(`✅ [${ctx.jobId}] United India - logged in`);
      await openMenu(ctx.driver, { log: ctx.log });
      await chooseProduct(ctx.driver, { log: ctx.log });
      await fillRisk(ctx.driver, ctx.data, { log: ctx.log });
      // The owner's stop point (BREAKER_ENABLED=true + BREAKER_STOP_AT=stopthis-location), now after Vehicle Class and
      // Vehicle Registration State. It throws the stop itself; runHandler turns it into "stopped on purpose".
      Breaker.checkpoint("stopthis-location");
      ctx.stop(NOT_BUILT, { stage: "risk-details" });
    },
  });
}

module.exports = { fillUnitedIndiaTP, NOT_BUILT };
