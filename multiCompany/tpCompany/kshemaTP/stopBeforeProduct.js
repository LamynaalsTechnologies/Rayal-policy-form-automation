/**
 * KSHEMA TP — the stop taken at the Product Type when the run may not go past it: KSHEMA_TP_FORM_ENABLED is false, or
 * KSHEMA_TP_PRODUCT_TYPE is not set yet (tpConfig.js).
 *
 * kshemaTPQuoteForm.js is the full-company KSHEMA quote form with the TP changes. It fills the customer details and
 * the vehicle fields that come BEFORE the Product Type (the portal reveals the Product Type only after those), then
 * ends here and says which Product Types the portal offers. Nothing is chosen, nothing is submitted, no payment is
 * started. Read-only on the portal: it opens the dropdown and reads it. The open list stays on the held browser.
 *
 * It always ends in stopper() — a stop is not a failure: no retry, no error screenshot, calm log line, and with
 * KEEP_BROWSER_OPEN_ON_ERROR the browser stays on this page.
 */
const { stopper } = require("../../../automationStopper");
const { listProductOptions } = require("./tpProduct");
const { kshemaTpHoldReason } = require("./tpConfig");

/**
 * Stop the run before the Product Type is chosen, naming the options on the portal.
 * Never returns: always throws the stop. Reading the options is best effort — if it fails the stop still happens,
 * with the reason in the log.
 */
async function stopBeforeProduct(driver, jobId = "KSHEMA TP") {
  const reason = kshemaTpHoldReason() || "the Product Type has not been chosen";
  let options = [];
  let readError = "";
  try {
    options = await listProductOptions(driver);
    console.log(`[${jobId}] KSHEMA TP: Product Type options on the portal: ${JSON.stringify(options)}`);
  } catch (error) {
    readError = error && error.message ? error.message : String(error);
    console.log(`[${jobId}] KSHEMA TP: could not read the Product Type options: ${readError}`);
  }

  // The driver's own text stays in the console. A raw Selenium message in the operator's sentence ("Wait timed out
  // after 15000ms ...") makes lib/errorHandler.js beautifyError replace the WHOLE message with a generic
  // "the portal took too long" line, and the reason for the stop is gone.
  const listed = options.length
    ? options.map((text) => `"${text}"`).join(", ")
    : "(they could not be read from the page)";

  console.log(
    `[${jobId}] ⚠️  KSHEMA TP stops here ON PURPOSE: ${reason}. Set KSHEMA_TP_PRODUCT_TYPE in the automation's .env ` +
      `to the exact Product Type text, remove KSHEMA_TP_FORM_ENABLED=false if it is there, and restart the automation.`
  );

  // ONE colon only, right after "KSHEMA TP" (beautifyError keeps just the text after the LAST colon).
  stopper(
    `KSHEMA TP: stopped before choosing the Product Type because ${reason}. ` +
      "Set KSHEMA_TP_PRODUCT_TYPE in the automation .env to the exact option text, restart the automation and " +
      `re-run this policy. Nothing was chosen or submitted. The Product Types on the portal are ${listed}.`,
    { stage: "tp-product", productOptions: options, readError }
  );
}

module.exports = { stopBeforeProduct };
