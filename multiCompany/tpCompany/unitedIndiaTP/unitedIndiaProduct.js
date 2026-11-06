/**
 * United India, the "Products" page that Make New/Renew Policy opens (the owner's screenshot and markup, 2026-11-06):
 *   Select Office   - already filled by the portal (e.g. "DO VELLORE(280300)")   -> left as it is, only read into the log
 *   Select LOB      - already filled ("Motor")                                   -> left as it is, only read into the log
 *   Select Product  - <select name="productCode" id="productCode">                -> "Liability Only Policy" (value 3102)
 *   Submit          - <input type="Submit" name="method" value="Submit" id="selectProduct">
 *
 * The owner's rule for every step (./unitedIndiaSteps.js): the product is chosen and read back (once more if it did not
 * take); Submit counts only when the Products page has gone and the next page finished loading (once more if not); an
 * alert() the portal answers with is reported in its own words and not retried; a box that is not on the page is its own
 * error. The option is matched by its exact text, so "Liability Only Policy Renewal" is never taken for it.
 */
const { By } = require("selenium-webdriver");
const { selectAndConfirm, clickAndConfirm } = require("./unitedIndiaSteps");
const { waitForLoader } = require("../../common/loader");
const { readPortalMessage } = require("../../common/portalMessages");

/** The owner's choice: "select the Liability Only Policy option". */
const PRODUCT = "Liability Only Policy";
const PRODUCT_SELECT_ID = "productCode";
const SUBMIT = ["input#selectProduct", "#selectProduct", By.xpath("//input[@type='Submit' or @type='submit'][@value='Submit']")];

/** The other boxes of the Products page, as the portal filled them: [{ label, text }] (read only, for the log). */
async function readPrefilled(driver) {
  return driver
    .executeScript(`
      var out = [];
      var boxes = document.querySelectorAll("select");
      for (var i = 0; i < boxes.length; i++) {
        var s = boxes[i];
        if (s.id === "productCode") continue;
        var label = "";
        if (s.id) { var l = document.querySelector("label[for='" + s.id + "']"); if (l) label = l.textContent; }
        if (!label) {
          var p = s.previousElementSibling;
          while (p && !label) { label = (p.textContent || "").trim(); p = p.previousElementSibling; }
        }
        var o = s.options[s.selectedIndex];
        out.push({ label: String(label || s.name || s.id).replace(/\\s+/g, " ").trim(), text: o ? String(o.text).replace(/\\s+/g, " ").trim() : "" });
      }
      return out;
    `)
    .catch(() => []);
}

/** The Products page has gone (Submit was taken) and the next page has finished loading. */
async function productPageGone(driver) {
  const page = await driver.executeScript(
    "return { ready: document.readyState, product: !!document.getElementById('productCode') };"
  );
  return !!page && page.ready === "complete" && page.product === false;
}

/**
 * @param {WebDriver} driver  on the Products page
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ product: string, value: string, url: string }>}
 */
async function chooseProduct(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const stage = "united-india-product";
  log(`🧾 United India - Products page: choosing "${PRODUCT}"`);

  for (const box of await readPrefilled(driver)) {
    log(box.text ? `   ${box.label} = "${box.text}" (as the portal filled it, not changed)` : `⚠️ United India - ${box.label} is empty on the Products page (left as it is)`);
  }

  const picked = await selectAndConfirm(driver, { label: "Select Product", selectId: PRODUCT_SELECT_ID, wanted: PRODUCT, stage }, { ...o, log });
  await waitForLoader(driver, "united india", { stage });

  // Submit may open the next page (Risk Details) in a NEW window: the run follows it there instead of pressing Submit again.
  const handlesOf = async () => {
    try {
      return await driver.getAllWindowHandles();
    } catch (e) {
      return null;
    }
  };
  const handlesBefore = (await handlesOf()) || [];
  let followed = false;
  const followNewWindow = async () => {
    if (followed) return true;
    const now = await handlesOf();
    const added = (now || []).filter((h) => !handlesBefore.includes(h));
    if (!added.length) return false;
    await driver.switchTo().window(added[added.length - 1]);
    followed = true;
    log("   the next page opened in a new window - the run goes on there");
    return true;
  };

  await clickAndConfirm(
    driver,
    {
      label: "Submit",
      target: SUBMIT,
      done: async () => {
        try {
          if (await followNewWindow()) return productPageGone(driver).catch(() => false);
          return await productPageGone(driver);
        } catch (e) {
          if (/unexpected alert open/i.test(String(e && e.message)) || (e && e.name === "UnexpectedAlertOpenError")) throw e;
          return false; // mid-navigation
        }
      },
      effect: "the next page opened",
      missing: "the Products page did not move on",
      stage,
      effectMs: 20000, // a form post on a slow portal
      explain: () => readPortalMessage(driver, "united india"),
    },
    { ...o, log }
  );
  await waitForLoader(driver, "united india", { stage });
  const url = await driver.getCurrentUrl().catch(() => "");
  log(`✅ United India - "${picked.text}" (${picked.value}) submitted, the next page is open (${url})`);
  return { product: picked.text, value: picked.value, url };
}

module.exports = { chooseProduct, productPageGone, readPrefilled, PRODUCT, PRODUCT_SELECT_ID, SUBMIT };
