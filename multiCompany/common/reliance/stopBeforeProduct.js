/**
 * Reliance OD / TP — the stop taken at the Sub Product dropdown while the product of this part is not configured
 * (RELIANCE_OD_PRODUCT / RELIANCE_TP_PRODUCT, multiConfig.js).
 *
 * relianceMultiForm.js is the full-company Reliance flow. It has logged in, hovered Motors -> Two Wheeler and opened the
 * Sub Product dropdown (span[aria-owns='ddlMotorProducts_listbox']). With no product text configured for the part it
 * ends HERE and says which products the portal offers. Nothing is chosen, nothing is submitted, nothing is bought.
 * Read-only on the portal: the options are read from the open list, nothing is clicked.
 *
 * It always ends in stopper() — a stop is not a failure: no retry, no error screenshot, calm log line, and with
 * KEEP_BROWSER_OPEN_ON_ERROR the browser stays on this page.
 */
const { stopper } = require("../../../automationStopper");
const { productSetting, relianceMultiLabel, normaliseKind } = require("./multiConfig");

// The Kendo list behind the dropdown; its items are li.k-item (the form clicks them by their text).
const PRODUCT_LIST = "#ddlMotorProducts_listbox";

// A product list is a handful of entries; this only bounds the size of a message.
const MAX_OPTIONS = 25;

/** In the page: the text of the dropdown's options (textContent — a popup that is still animating has no innerText). */
function readProductOptionsInPage(listSelector) {
  var list = document.querySelector(listSelector);
  var items = list ? list.querySelectorAll("li") : [];
  var texts = [];
  for (var i = 0; i < items.length; i++) {
    var text = String(items[i].textContent || "").replace(/\s+/g, " ").trim();
    if (text) texts.push(text);
  }
  return texts;
}

/** The options of the Sub Product dropdown (trimmed, in order, no duplicates, bounded). */
async function readProductOptions(driver) {
  const texts = await driver.executeScript(readProductOptionsInPage, PRODUCT_LIST);
  const options = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    if (options.length >= MAX_OPTIONS) break;
    if (!options.includes(text)) options.push(text);
  }
  return options;
}

/**
 * Stop the run before the product is chosen, naming the products on the portal.
 * Never returns: always throws the stop. Reading the options is best effort — if it fails the stop still happens,
 * with the reason in the log.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {"od"|"tp"} o.kind
 * @param {string} [o.jobId]
 * @param {string} [o.reason]  why the run may not go past here (default: the setting is empty)
 */
async function stopBeforeProduct(driver, { kind = "od", jobId = "", reason = "" } = {}) {
  const part = normaliseKind(kind);
  const label = relianceMultiLabel(part);
  const setting = productSetting(part);
  const why = reason || `${setting} is not set`;
  const tag = jobId ? `[${jobId}] ` : "";

  let options = [];
  let readError = "";
  try {
    options = await readProductOptions(driver);
    console.log(`${tag}${label}: products on the portal: ${JSON.stringify(options)}`);
  } catch (error) {
    readError = error && error.message ? error.message : String(error);
    console.log(`${tag}${label}: could not read the products: ${readError}`);
  }

  // The driver's own text stays in the console. A raw Selenium message in the operator's sentence ("Wait timed out
  // after 15000ms ...") makes lib/errorHandler.js beautifyError replace the WHOLE message with a generic
  // "the portal took too long" line, and the reason for the stop is gone.
  const listed = options.length
    ? options.map((text) => `"${text}"`).join(", ")
    : "(they could not be read from the page)";

  console.log(
    `${tag}⚠️  ${label} stops here ON PURPOSE: ${why}. Set ${setting} in the automation's .env to the exact ` +
      `product text and restart the automation.`
  );

  // ONE colon only, right after the label (beautifyError keeps just the text after the LAST colon).
  stopper(
    `${label}: stopped before choosing the product because ${why}. ` +
      `Set ${setting} in the automation .env to the exact product text, restart the automation and re-run this ` +
      `policy. Nothing was chosen or submitted. The products on the portal are ${listed}.`,
    { stage: `${part}-product`, productOptions: options, readError }
  );
}

module.exports = { stopBeforeProduct, readProductOptions, readProductOptionsInPage, PRODUCT_LIST };
