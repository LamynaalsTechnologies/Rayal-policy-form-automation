/**
 * United India, after the login (the owner's steps, 2026-11-06): the sidebar's "Policy Transaction" menu, then its submenu
 * "Make New/Renew Policy". The owner's markup:
 *   <a href="javascript:;" data-toggle="collapse" data-target="#3" class="menuColor"> ... Policy Transaction ... </a>
 *   <a href="../portal/MenuAction.do?method=strbtn" class="subMenuColor"> ... Make New/Renew Policy</a>
 * (the repo's old autofill.js / formFlow.js walked the same two links; the page after it shows #selectProduct there).
 *
 * Every click is CHECKED (./unitedIndiaSteps.js clickAndConfirm): the menu counts as clicked only when the submenu link is
 * on screen, the submenu only when the Make New/Renew Policy page has opened; if not, one more click; an element that is
 * not visible stops the run with its name. The menu is a collapse toggle, so it is NOT clicked when its submenu already
 * shows - a second click would close it.
 */
const { By } = require("selenium-webdriver");
const { clickAndConfirm, waitUntil } = require("./unitedIndiaSteps");
const { firstVisible } = require("../../common/elements");
const { waitForLoader } = require("../../common/loader");

const POLICY_TRANSACTION = [
  "a.menuColor[data-target='#3']",
  By.xpath("//a[contains(@class,'menuColor') and contains(normalize-space(.),'Policy Transaction')]"),
];
const MAKE_NEW_RENEW = [
  "a.subMenuColor[href*='MenuAction.do?method=strbtn']",
  By.xpath("//a[contains(@class,'subMenuColor') and contains(normalize-space(.),'Make New/Renew Policy')]"),
  By.xpath("//a[contains(@href,'MenuAction.do?method=strbtn')]"),
];

/** The submenu link is on screen (the menu is open). */
const submenuShown = async (driver) => !!(await firstVisible(driver, MAKE_NEW_RENEW));

/**
 * The Make New/Renew Policy page has opened: its address (MenuAction.do?method=strbtn) or its product selection
 * (#selectProduct, the old autofill.js), on a page that finished loading. Neither seen on the live portal from this code yet.
 */
async function makeNewPageOpen(driver) {
  try {
    const page = await driver.executeScript(
      "return { url: location.href, ready: document.readyState, product: !!document.getElementById('selectProduct') };"
    );
    if (!page || page.ready !== "complete") return false;
    return /MenuAction\.do\?method=strbtn/i.test(String(page.url)) || page.product === true;
  } catch (e) {
    return false; // mid-navigation
  }
}

/**
 * @param {WebDriver} driver  logged in
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ url: string }>} the page that opened
 */
async function openMakeNewRenewPolicy(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  log("📂 United India - opening Policy Transaction > Make New/Renew Policy");

  await clickAndConfirm(
    driver,
    {
      label: "Policy Transaction",
      target: POLICY_TRANSACTION,
      done: () => submenuShown(driver),
      effect: "its submenu (Make New/Renew Policy) is open",
      missing: "its submenu (Make New/Renew Policy) did not open",
      stage: "united-india-menu",
      effectMs: 4000,
    },
    { ...o, log }
  );

  await clickAndConfirm(
    driver,
    {
      label: "Make New/Renew Policy",
      target: MAKE_NEW_RENEW,
      done: () => makeNewPageOpen(driver),
      effect: "the Make New/Renew Policy page is open",
      missing: "the Make New/Renew Policy page did not open",
      stage: "united-india-make-new-policy",
      effectMs: 20000, // a page load on a slow portal
    },
    { ...o, log }
  );

  await waitForLoader(driver, "united india", { stage: "united-india-make-new-policy" });
  // the page settles: its address read once more after the loader (a redirect after strbtn is reported as it is)
  await waitUntil(driver, () => makeNewPageOpen(driver), 3000, o);
  const url = await driver.getCurrentUrl().catch(() => "");
  log(`✅ United India - the Make New/Renew Policy page is open (${url})`);
  return { url };
}

module.exports = { openMakeNewRenewPolicy, makeNewPageOpen, submenuShown, POLICY_TRANSACTION, MAKE_NEW_RENEW };
