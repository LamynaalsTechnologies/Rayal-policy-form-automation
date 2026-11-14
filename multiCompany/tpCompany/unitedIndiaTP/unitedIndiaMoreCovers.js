/**
 * United India, after the RTO (the owner, 2026-11-13): the "More Covers N Info" button, then the TPPD limit on the page it
 * opens.
 *   More Covers N Info  <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/MoreCoversNInfo.JPG"
 *                            onclick="fnSubmit('morecoversninfo')">  -> clicked; the portal SUBMITS the Risk Details and
 *                       opens the next page. The run waits up to 20 s for it (the owner); not opened = an error.
 *   TPPD Limit          <select name="tppdLimit"> (no id)  Upto 100000 / Upto 6000
 *                       -> the Online Policy's "TPPD Restrict" ticked: "Upto 6000"; not ticked: "Upto 100000" - which
 *                       the portal already shows, so normally it is left untouched. (The owner, 2026-11-13, picked the
 *                       rule Reliance and KSHEMA follow, so our premium and United India's agree.)
 *
 * The page change itself - the page mark, one click (a second only when nothing shows the first was taken), the 2 s page-load
 * limit while waiting, window.stop() at 20 s, popups - is the shared ./unitedIndiaNavigate.js clickToNextPage (Back and Compute
 * Premium use it too).
 */
const { waitForLoader } = require("../../common/loader");
const { By } = require("selenium-webdriver");
const { selectAndConfirm, popupOr } = require("./unitedIndiaSteps");
const nav = require("./unitedIndiaNavigate");

const STAGE = "united-india-more-covers";
const LABEL = "More Covers N Info";
const MORE_COVERS = [
  "img[src*='MoreCoversNInfo']",
  "img[onclick*='morecoversninfo']",
  By.xpath("//img[contains(@src,'MoreCoversNInfo') or contains(@onclick,'morecoversninfo')]"),
];
const TPPD = { label: "TPPD Limit", target: ["select[name='tppdLimit']", By.name("tppdLimit")] };

/**
 * Click More Covers N Info and wait for the page it opens (20 s) - the shared page change (./unitedIndiaNavigate.js).
 * @param {WebDriver} driver  on Risk Details, the RTO chosen
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ url: string, clicks: number }>}
 */
async function openMoreCovers(driver, o = {}) {
  const out = await nav.clickToNextPage(driver, { label: LABEL, target: MORE_COVERS, stage: STAGE }, o);
  return { url: out.url, clicks: out.clicks };
}

/** "Upto 6000" when the policy's TPPD Restrict is ticked, else "Upto 100000" (Reliance and KSHEMA read the tick the same way). */
const tppdFor = (data = {}) => (data.tppdRestrict === true || String(data.tppdRestrict).toLowerCase() === "true" ? "6000" : "100000");

/**
 * The TPPD Limit on the More Covers page.
 * @returns {Promise<{ tppdLimit: string, text: string, changed: boolean }>}
 */
async function setTppdLimit(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const wanted = tppdFor(data);
  const restricted = wanted === "6000";
  log(`🚗 United India - TPPD Restrict ${restricted ? "ticked on the policy: Upto 6000" : "not ticked: Upto 100000 (left as the portal shows it)"}`);
  const out = await selectAndConfirm(driver, { label: TPPD.label, target: TPPD.target, wanted, stage: STAGE }, { ...o, log });
  await waitForLoader(driver, "united india", { stage: STAGE }).catch(popupOr(TPPD.label, STAGE));
  log(`✅ United India - TPPD Limit "${out.text}"${out.tries === 0 ? " (as the portal showed it, not touched)" : ""}`);
  return { tppdLimit: out.value, text: out.text, changed: out.tries > 0 };
}

module.exports = {
  openMoreCovers,
  setTppdLimit,
  tppdFor,
  MORE_COVERS,
  TPPD,
  // the shared page change, as the tests have always reached it here
  clickOnce: nav.clickOnce,
  isPageLoadWait: nav.isPageLoadWait,
  markPageInPage: nav.markPageInPage,
  pageStateInPage: nav.pageStateInPage,
  portalErrorsInPage: nav.portalErrorsInPage,
  NAV_WAIT_MS: nav.NAV_WAIT_MS,
  RECLICK_AFTER_MS: nav.RECLICK_AFTER_MS,
  MIN_LIMIT_MS: nav.MIN_LIMIT_MS,
};
