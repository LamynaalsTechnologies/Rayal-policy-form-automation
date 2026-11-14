/**
 * National (NIC portal) login strategy. Data copied from the inline login in
 * fullPolicycompany/national.js — same field names, same account-type
 * dropdown walk, same "left the login page" success signal.
 *
 * The account-type dropdown walk is now the shared fullPolicycompany/national/nationalLoginForm.js (2026-11-14).
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
const { MultiCompanyError } = require("../errors");
const { selectNationalAccountType, waitForLoginBox } = require("../../../fullPolicycompany/national/nationalLoginForm");

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
    // What shows first: the User Type list. The Login ID box can be drawn only after the lists are chosen, so the page is
    // "ready" without it (2026-11-14) - waiting for it first cost the whole page-load wait on every run.
    ready: [By.css("mat-select[aria-labelledby~='userGroupLabel']"), By.css("mat-select"), USERNAME_LOCATOR],
    username: [USERNAME_LOCATOR],
    password: [By.name("log_pwd_iPassword_01")],
    submit: [By.name("log_btn_login_01")],
  },
  isLoggedIn,
  // User Type = INTERMEDIARY, then the Intermediary Type that appears = BROKER POSP: each list found by its own label,
  // picked and read back (fullPolicycompany/national/nationalLoginForm.js, the same code the full and TP flows use).
  // A miss is a named, retryable E306 - it used to be logged and skipped, and the login failed later without a reason.
  beforeFill: async (driver, ctx) => {
    const log = ctx?.log || ((l) => console.log(l));
    try {
      await selectNationalAccountType(driver, { userType: "INTERMEDIARY", intermediaryType: "BROKER POSP", log });
      await waitForLoginBox(driver, { log }); // drawn after the lists: be sure it is there before the fields are filled
    } catch (e) {
      throw new MultiCompanyError("E306", `${e.message} - it will try again shortly.`, { company: "national", retryable: true });
    }
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
