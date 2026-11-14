/**
 * United India, after the login (the owner's steps, 2026-11-06): the sidebar's "Policy Transaction" menu, then its submenu
 * "Make New/Renew Policy". The owner's markup:
 *   <a href="javascript:;" data-toggle="collapse" data-target="#3" class="menuColor"> ... Policy Transaction ... </a>
 *   <a href="../portal/MenuAction.do?method=strbtn" class="subMenuColor"> ... Make New/Renew Policy</a>
 * (the repo's old autofill.js / formFlow.js walked the same two links; the page after it shows #selectProduct there).
 * A policy whose proposal is already made goes to the same menu's "Proposal Modification" instead (the owner, 2026-11-13):
 *   <a href="../motor/proposalModification.do?userCode=...&parameter=proposalModify" class="subMenuColor"> ... Proposal Modification</a>
 *
 * Every click is CHECKED (./unitedIndiaSteps.js clickAndConfirm): the menu counts as clicked only when the submenu link is
 * on screen, the submenu only when the Make New/Renew Policy page has opened; if not, one more click; an element that is
 * not visible stops the run with its name. The menu is a collapse toggle, so it is NOT clicked when its submenu already
 * shows - a second click would close it.
 */
const { By } = require("selenium-webdriver");
const { clickAndConfirm, waitUntil } = require("./unitedIndiaSteps");
const { firstVisible } = require("../../common/elements");
const { MultiCompanyError } = require("../../common/errors");
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

const PROPOSAL_MODIFICATION = [
  "a.subMenuColor[href*='proposalModification.do']",
  By.xpath("//a[contains(@class,'subMenuColor') and contains(normalize-space(.),'Proposal Modification')]"),
  By.xpath("//a[contains(@href,'proposalModification.do')]"),
];

/** The submenu link is on screen (the menu is open). */
const submenuShown = async (driver, link = MAKE_NEW_RENEW) => !!(await firstVisible(driver, link));

/** The Proposal Modification page has opened: its address or its From Reference Date box, on a page that finished loading. */
async function proposalModificationOpen(driver) {
  try {
    const page = await driver.executeScript(
      "return { url: location.href, ready: document.readyState, from: !!document.getElementById('fromRefDateString') };"
    );
    if (!page || page.ready !== "complete") return false;
    return /proposalModification\.do/i.test(String(page.url)) || page.from === true;
  } catch (e) {
    return false; // mid-navigation
  }
}

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
  if (o.directUrl) return openDirect(driver, { name: "Make New/Renew Policy", url: o.directUrl, isOpen: makeNewPageOpen, stage: "united-india-make-new-policy" }, { ...o, log });
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

/**
 * Policy Transaction > Proposal Modification - where a proposal made by an earlier run is opened again (the owner, 2026-11-13).
 * @param {WebDriver} driver  logged in
 * @returns {Promise<{ url: string }>}
 */
async function openProposalModification(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  if (o.directUrl) return openDirect(driver, { name: "Proposal Modification", url: o.directUrl, isOpen: proposalModificationOpen, stage: "united-india-proposal-modification" }, { ...o, log });
  log("📂 United India - opening Policy Transaction > Proposal Modification");
  await clickAndConfirm(
    driver,
    {
      label: "Policy Transaction",
      target: POLICY_TRANSACTION,
      done: () => submenuShown(driver, PROPOSAL_MODIFICATION),
      effect: "its submenu (Proposal Modification) is open",
      missing: "its submenu (Proposal Modification) did not open",
      stage: "united-india-menu",
      effectMs: 4000,
    },
    { ...o, log }
  );
  await clickAndConfirm(
    driver,
    {
      label: "Proposal Modification",
      target: PROPOSAL_MODIFICATION,
      done: () => proposalModificationOpen(driver),
      effect: "the Proposal Modification page is open",
      missing: "the Proposal Modification page did not open",
      stage: "united-india-proposal-modification",
      effectMs: 20000, // a page load on a slow portal
    },
    { ...o, log }
  );
  await waitForLoader(driver, "united india", { stage: "united-india-proposal-modification" });
  await waitUntil(driver, () => proposalModificationOpen(driver), 3000, o);
  const url = await driver.getCurrentUrl().catch(() => "");
  log(`✅ United India - the Proposal Modification page is open (${url})`);
  return { url };
}

/**
 * Open a sidebar page again straight by its address (the run read it the first time) - a page United India answered with an
 * error box may not carry the sidebar. GET, like the link; at most 20 s for it to be open.
 */
async function openDirect(driver, { name, url, isOpen, stage }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  log(`📂 United India - opening ${name} again by its address (${url})`);
  const { pageLoadLimit } = require("./unitedIndiaNavigate");
  const before = await pageLoadLimit(driver, 20000);
  try {
    await driver.get(url);
  } catch (e) {
    /* a slow page: looked for below */
  } finally {
    if (before) await pageLoadLimit(driver, before);
  }
  if (!(await waitUntil(driver, () => isOpen(driver), 20000, o))) {
    throw new MultiCompanyError("E301", `United India - ${name} did not open again by its address within 20 seconds, so the run stopped there. It will try again shortly.`, {
      company: "united india",
      stage,
    });
  }
  await waitForLoader(driver, "united india", { stage });
  const now = await driver.getCurrentUrl().catch(() => "");
  log(`✅ United India - the ${name} page is open (${now})`);
  return { url: now };
}

module.exports = {
  openDirect,
  openMakeNewRenewPolicy,
  openProposalModification,
  makeNewPageOpen,
  proposalModificationOpen,
  submenuShown,
  POLICY_TRANSACTION,
  MAKE_NEW_RENEW,
  PROPOSAL_MODIFICATION,
};
