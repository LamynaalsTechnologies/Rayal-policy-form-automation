/**
 * National (NIC portal) login strategy. Data copied from the inline login in
 * fullPolicycompany/national.js — same field names, same account-type
 * dropdown walk, same "left the login page" success signal.
 *
 * Two things differ from the legacy flow, on purpose:
 *  - there is NO built-in login URL. The legacy CONFIG.LOGIN_URL is "", so a
 *    credential saved without one used to fail deep inside driver.get(""); it
 *    is now an up-front [E205] naming the missing URL.
 *  - a rejected login is recognised and reported ([E203]) instead of only
 *    "still on login page", which the job then retried five times.
 */
const { By } = require("selenium-webdriver");
const { firstVisible, clickWithFallback } = require("../elements");
const { waitForLoader } = require("../loader");

const USERNAME_LOCATOR = By.name("log_txtfield_iUsername_01");

/** Logged in = off /signin/login AND the username box is gone. */
async function isLoggedIn(driver) {
  try {
    const url = await driver.getCurrentUrl();
    if (url.includes("/signin/login")) return false;
    return (await driver.findElements(USERNAME_LOCATOR)).length === 0;
  } catch (e) {
    return false; // mid-navigation — keep polling
  }
}

const DROPDOWN_LOCATORS = [
  By.name("reg_dropdown_iType_02"),
  By.id("mat-select-4"),
  By.css("mat-select[role='combobox']"),
];

/** Open the account-type dropdown and pick the option containing `text`. Best effort. */
async function chooseOption(driver, text, log) {
  try {
    const dropdown = await firstVisible(driver, DROPDOWN_LOCATORS);
    if (!dropdown) throw new Error("dropdown not visible");
    await clickWithFallback(driver, dropdown);
    await driver.sleep(1500);
    const option = await firstVisible(driver, [
      By.xpath(`//mat-option[contains(., '${text}')]`),
      By.xpath(`//mat-option[contains(text(), '${text}')]`),
    ]);
    if (!option) throw new Error(`option "${text}" not shown`);
    await clickWithFallback(driver, option);
    await driver.sleep(1000);
    log(`   selected ${text}`);
  } catch (e) {
    // The legacy flow swallows these too: the dropdown can be pre-selected.
    log(`   (${text}: ${e.message} — continuing)`);
  }
}

const MODAL_CLOSE_LOCATORS = [
  By.css("button.close_flash"),
  By.css("button[data-dismiss='modal']"),
  By.css(".close"),
  By.css("[aria-label='Close']"),
  By.xpath("//button[contains(@class, 'close')]"),
  By.xpath("//button[contains(text(), 'Close')]"),
];

module.exports = {
  company: "national",
  label: "National",
  defaultUrl: "", // deliberately none — see the header
  attempts: 1,
  pageLoadMs: 30000,
  loginResultMs: 30000,
  pauseMs: 0,
  fields: {
    username: [USERNAME_LOCATOR],
    password: [By.name("log_pwd_iPassword_01")],
    submit: [By.name("log_btn_login_01")],
  },
  isLoggedIn,
  beforeFill: async (driver, ctx) => {
    const log = ctx?.log || ((l) => console.log(l));
    await chooseOption(driver, "INTERMEDIARY", log);
    await chooseOption(driver, "BROKER POSP", log);
  },
  // A promo/flash modal often greets the first login.
  afterLogin: async (driver) => {
    await waitForLoader(driver, "national").catch(() => {});
    try {
      const modal = await firstVisible(driver, MODAL_CLOSE_LOCATORS);
      if (modal) {
        await clickWithFallback(driver, modal);
        await driver.sleep(500);
      }
    } catch (e) {
      /* no modal — fine */
    }
    await waitForLoader(driver, "national").catch(() => {});
  },
};
