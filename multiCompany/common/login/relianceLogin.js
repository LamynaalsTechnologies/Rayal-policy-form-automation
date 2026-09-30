/**
 * Reliance SmartZone login strategy. Data copied from the working flow in
 * browserv2.js performLogin — same locators, same success signals, same
 * timings — so behaviour matches; what changes is that the portal's ANSWER is
 * now read (runLogin.js) instead of collapsing every failure into "false".
 */
const { By } = require("selenium-webdriver");
const { getCaptchaText } = require("../../../captchaUtils");
const { firstVisible } = require("../elements");
const { waitForLoader } = require("../loader");
const { MultiCompanyError } = require("../errors");

const DEFAULT_LOGIN_URL = "https://smartzone.reliancegeneral.co.in/Login/IMDLogin";

/** Logged in when the URL carries the post-login token, or the dashboard/logout markers exist. */
async function isLoggedIn(driver) {
  try {
    const url = await driver.getCurrentUrl();
    if (url.includes("?un=") || url.includes("FromImdLogin=fromlogin")) return true;
    if ((await driver.findElements(By.id("divMainMotors"))).length > 0) return true;
    const logout = await driver.findElements(By.id("divLogout"));
    return logout.length > 0 && (await logout[0].isDisplayed());
  } catch (e) {
    return false;
  }
}

/** The portal's own "wrong captcha" text — the one message Reliance login ever read. */
async function isCaptchaError(driver) {
  try {
    const errors = await driver.findElements(
      By.xpath("//span[contains(text(), 'Captcha is not valid')]")
    );
    return errors.length > 0 && (await errors[0].isDisplayed());
  } catch (e) {
    return false;
  }
}

module.exports = {
  company: "reliance",
  label: "Reliance",
  defaultUrl: DEFAULT_LOGIN_URL,
  attempts: 5, // captcha OCR is imperfect; a bad read costs no portal submit
  pageLoadMs: 10000,
  loginResultMs: 5000,
  pauseMs: 500, // the portal drops input typed straight after the previous field
  fields: {
    username: [By.id("txtUserName")],
    password: [By.id("txtPassword")],
    captcha: [By.id("CaptchaInputText")],
    submit: [By.id("btnLogin")],
  },
  isLoggedIn,
  isCaptchaError,
  // One unique file per job so parallel logins never solve each other's captcha.
  solveCaptcha: async (driver, ctx) => {
    try {
      return await getCaptchaText(driver, `reliance_captcha_${ctx.jobId || "job"}`);
    } catch (e) {
      return ""; // unreadable/missing image — same as "no text": try again
    }
  },
  // Optional promo modal, then the Motors menu marks the dashboard as ready.
  afterLogin: async (driver) => {
    try {
      await driver.sleep(2000);
      const close = await firstVisible(driver, [By.id("Closebutton")]);
      if (close) {
        await driver.executeScript("arguments[0].click();", close);
        await driver.sleep(1000);
      }
    } catch (e) {
      /* no modal — fine */
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if ((await driver.findElements(By.id("divMainMotors"))).length > 0) return;
      await driver.sleep(300);
    }
    await waitForLoader(driver, "reliance").catch(() => {});
    throw new MultiCompanyError(
      "E304",
      "Reliance accepted the login but the dashboard (Motors menu) did not appear — it will try again shortly.",
      { company: "reliance" }
    );
  },
};
