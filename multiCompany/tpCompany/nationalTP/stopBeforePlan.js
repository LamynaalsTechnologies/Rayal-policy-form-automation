/**
 * National TP — the stop that is taken while NATIONAL_TP_FORM_ENABLED is set to false (it is on by default).
 *
 * nationalTPForm.js is the full-company National flow with the TP changes (the plan "5 Year Long Term Liability
 * Only", no IDV / selling price). With the switch set to false the run still logs in, opens the quote form and
 * chooses "Vehicle Type: New", then ends here — right before "Your Plan" — and says which plans the portal offers.
 * Nothing is chosen, nothing is bought, no payment link is sent.
 *
 * Read-only on the portal: it opens the Your Plan dropdown and reads it, nothing is selected or submitted.
 * It always ends in stopper() — a stop is not a failure: no retry, no error screenshot, calm log line, and with
 * KEEP_BROWSER_OPEN_ON_ERROR the browser stays on this page.
 */
const { stopper } = require("../../../automationStopper");
const { openPlanDropdown, readOptions, PLAN_DROPDOWN } = require("./tpPlan");

// A plan list is a handful of entries; this only bounds the size of the message.
const MAX_OPTIONS = 25;

/** Open the Your Plan dropdown and return the text of its options (trimmed, in order, no duplicates). */
async function readPlanOptions(driver) {
  await openPlanDropdown(driver);
  const { texts } = await readOptions(driver);
  const options = [];
  for (const text of texts) {
    if (options.length >= MAX_OPTIONS) break;
    if (!options.includes(text)) options.push(text);
  }
  return options;
}

/**
 * Stop the run before the plan is chosen, naming the plan options on the portal.
 * Never returns: always throws the stop. Reading the options is best effort — if it fails the stop still happens,
 * with the reason in the message.
 */
async function stopBeforePlan(driver, jobId = "National TP") {
  let options = [];
  let readError = "";
  try {
    options = await readPlanOptions(driver);
    console.log(`[${jobId}] National TP: "Your Plan" options on the portal: ${JSON.stringify(options)}`);
  } catch (error) {
    readError = error && error.message ? error.message : String(error);
    console.log(`[${jobId}] National TP: could not read the "Your Plan" options: ${readError}`);
  }

  // The driver's own text stays in the console. A raw Selenium message in the operator's sentence ("Wait timed out
  // after 15000ms ...") makes lib/errorHandler.js beautifyError replace the WHOLE message with a generic
  // "the portal took too long" line, and the reason for the stop is gone.
  const listed = options.length
    ? options.map((text) => `"${text}"`).join(", ")
    : "(they could not be read from the page)";

  console.log(
    `[${jobId}] ⚠️  National TP stops here ON PURPOSE: NATIONAL_TP_FORM_ENABLED is set to false. ` +
      `Remove that line from the automation's .env (or set it to true) and restart it to select the plan and continue.`
  );

  // ONE colon only, right after "National TP". lib/errorHandler.js beautifyError keeps just the text after the LAST
  // colon of a message — a second one (before the options list, as this had) threw the whole reason away and left
  // only the plan names on screen.
  stopper(
    "National TP: stopped before choosing the plan because NATIONAL_TP_FORM_ENABLED is set to false. " +
      "Remove that line from the automation .env (or set it to true), restart the automation and re-run this policy. " +
      `Nothing was chosen or submitted. The plans on the portal are ${listed}.`,
    { stage: "tp-plan", planOptions: options, readError }
  );
}

module.exports = { stopBeforePlan, readPlanOptions, PLAN_DROPDOWN };
