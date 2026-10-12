/**
 * Reliance login for the multiCompany OD / TP handlers — a COPY of the full-company
 * Reliance login, so both log in the very same way. Nothing in it is new logic.
 *
 * COPIED WORD FOR WORD (a test compares them with the originals, see
 * test/multiCompanyRelianceLogin.test.js):
 *   isUserLoggedIn, performLogin      <- browserv2.js
 *   getCaptchaScreenShot, getCaptchaText  <- captchaUtils.js
 *   waitForDashboard                  <- fullPolicycompany/relianceForm.js, "STEP 1.1" and "STEP 2"
 *                                        (close the promo popup, wait for the Motors menu)
 *   fullCompanyLogin                  <- relianceForm.js "STEP 0": the portal URL fallback, performLogin
 *                                        with a per-job captcha tag, and "[E203] Reliance rejected the login"
 *
 * THE ONLY DIFFERENCES (nothing about how the login behaves):
 *   - the rejected-login error is a MultiCompanyError("E203") instead of `new Error("[E203] ...")`, the type
 *     every multiCompany handler returns as its failure (same code, same words, still not retried);
 *   - getCaptchaScreenShot writes its temporary PNG under ROOT_DIR (the project root, where captchaUtils.js
 *     puts it) instead of __dirname, which here would be a source folder;
 *   - CONFIG holds just the four values performLogin reads from browserv2.js's CONFIG;
 *   - waitForDashboard returns the Motors-menu element, which the form code that follows needs.
 *
 * NOT COPIED, because multiCompany already shares them with the full-company flow:
 *   - opening and closing the browser window: common/browser.js calls the same createRelianceJobBrowser /
 *     cleanupJobBrowser from sessionManager.js;
 *   - extractCaptchaText (Captcha.js), the GPT-4o captcha reader every Reliance flow uses.
 * The legacy cloned-session recovery in relianceForm.js (loginOnClonedBrowser, checkAndRecoverClonedSession)
 * is switched off in the full flow ("no health check"), so it is not here either.
 *
 * If the login in the full-company flow changes, the sync test fails until this copy is updated to match.
 * Used by common/login/index.js for company "reliance", so the Reliance OD and Reliance TP handlers
 * (through common/runHandler.js) both log in through this file.
 */
const { By, until } = require("selenium-webdriver");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("../../../Captcha");
const { MultiCompanyError } = require("../errors");

// The values performLogin reads from browserv2.js's CONFIG. LOGIN_URL / USERNAME / PASSWORD are only a fallback
// there (filled from the database by the master-session code); the Reliance flow always passes both, so they
// stay empty here exactly as they do in a fresh-window job.
const CONFIG = {
  LOGIN_URL: "",
  USERNAME: "",
  PASSWORD: "",
  LOGIN_TIMEOUT: 5000,
};

// captchaUtils.js writes its temporary captcha PNG into the project root; so does this copy.
const ROOT_DIR = path.join(__dirname, "..", "..", "..");

// relianceForm.js: the hardcoded address is only the fallback for a credential saved without a login URL.
const DEFAULT_LOGIN_URL = "https://smartzone.reliancegeneral.co.in/Login/IMDLogin";

// ---------------------------------------------------------------------------
// captchaUtils.js — verbatim (ROOT_DIR instead of __dirname, see above)
// ---------------------------------------------------------------------------

/**
 * Take screenshot of captcha image element.
 * Uses ONE absolute path (__dirname) — the old version wrote cwd-relative but
 * read back from __dirname, which only worked when the two happened to match.
 */
async function getCaptchaScreenShot(driver, filename = "image_screenshot") {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));
  const imageBase64 = await imgElement.takeScreenshot(true);
  const filePath = path.join(ROOT_DIR, `${filename}.png`);
  fs.writeFileSync(filePath, imageBase64, "base64");
  console.log(`Screenshot saved as ${filePath}`);
  return filePath;
}

/**
 * Get captcha text from screenshot.
 *
 * IMPORTANT for parallel jobs: pass a UNIQUE filename per job (the callers use
 * reliance_captcha_<jobId>). With the old shared "reliance_captcha" name, two
 * jobs logging in at once overwrote each other's screenshot and each solved
 * the OTHER job's captcha. The file is deleted after use so nothing
 * accumulates in the repo root.
 */
async function getCaptchaText(driver, filename = "reliance_captcha") {
  const filePath = await getCaptchaScreenShot(driver, filename);
  try {
    const fileData = fs.readFileSync(filePath, "base64");
    const imageUrl = `data:image/jpeg;base64,${fileData}`;
    const captchaResult = await extractCaptchaText(imageUrl);
    console.log("Captcha text:", captchaResult);
    return captchaResult?.text?.replace(/\s+/g, "") || "";
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (e) { /* already gone — fine */ }
  }
}

// ---------------------------------------------------------------------------
// browserv2.js — verbatim
// ---------------------------------------------------------------------------

/**
 * Checks if the user is currently logged in
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @returns {Promise<boolean>} True if logged in
 */
async function isUserLoggedIn(driver) {
  try {
    // Check 1: URL Pattern (Reliability)
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes("?un=") || currentUrl.includes("FromImdLogin=fromlogin")) {
      console.log("✓ User is logged in -> URL contains success token");
      return true;
    }

    // Check 2: Element Check (Fallback)
    const logoutElements = await driver.findElements(By.id("divLogout"));
    if (logoutElements.length > 0 && (await logoutElements[0].isDisplayed())) {
      console.log("✓ User is logged in -> Logout element detected");
      return true;
    }

    console.log("→ User is NOT logged in");
    return false;
  } catch (error) {
    console.log("→ Error checking login status:", error.message);
    return false;
  }
}

/**
 * Performs the login process
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
/**
 * Log in on the given driver.
 *
 * options (all optional — omitted values fall back to the shared CONFIG, which
 * is what the single master-session path uses):
 *   username / password : per-JOB credentials. Parallel jobs MUST pass these —
 *                         CONFIG is one shared mutable object, and job B
 *                         overwriting it mid-flight logged job A in under the
 *                         wrong client.
 *   loginUrl            : per-JOB portal URL, for the same reason. Credentials
 *                         carry their own loginUrl, and CONFIG.LOGIN_URL is
 *                         rewritten by whichever job last touched it.
 *   captchaTag          : unique tag (jobId) for the captcha screenshot file so
 *                         parallel logins don't solve each other's captcha.
 */
async function performLogin(driver, options = {}) {
  const MAX_RETRIES = 5;

  // Resolved ONCE, before the retry loop: a parallel job rewriting CONFIG
  // between two attempts must not move this login to a different portal.
  const loginUrl = options.loginUrl || CONFIG.LOGIN_URL;
  const username = options.username || CONFIG.USERNAME;
  const password = options.password || CONFIG.PASSWORD;

  // No "rfcpolicy"/"Pass@123" default any more. Falling back to a hardcoded
  // account meant a job whose credentials failed to arrive silently filed the
  // policy under somebody else's IMD code instead of failing.
  if (!username || !password) {
    throw new Error(
      "[E205] performLogin called without Reliance credentials — the caller must supply username and password."
    );
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`🔄 Login attempt ${attempt}/${MAX_RETRIES}...`);

    try {
      console.log(`→ Navigating to login page: ${loginUrl}`);
      await driver.get(loginUrl);

      // Wait for login form to load (much better than fixed sleep)
      try {
        await driver.wait(until.elementLocated(By.id("txtUserName")), 10000);
      } catch (e) {
        console.log("→ Login page took too long to load or field not found");
      }

      // Check if we're already logged in (sometimes redirect happens)
      if (await isUserLoggedIn(driver)) {
        console.log("✓ Already logged in via redirect!");
        return true;
      }

      console.log(`→ Filling login credentials for ${username}...`);

      // Get captcha text — unique file per job so parallel logins can't
      // overwrite each other's screenshot.
      const captchaFile = options.captchaTag
        ? `reliance_captcha_${options.captchaTag}`
        : "reliance_captcha";
      console.log("📸 Capturing captcha...");
      const captchaText = await getCaptchaText(driver, captchaFile);
      if (!captchaText) {
        console.log("⚠️ Failed to extract captcha text, retrying...");
        continue;
      }
      console.log("Captcha text:", captchaText);

      // Fill login form
      await driver.findElement(By.id("txtUserName")).clear();
      await driver.findElement(By.id("txtUserName")).sendKeys(username);

      await driver.findElement(By.id("txtPassword")).clear();
      await driver.findElement(By.id("txtPassword")).sendKeys(password);

      await driver.sleep(500);
      await driver.findElement(By.id("CaptchaInputText")).clear();
      await driver.findElement(By.id("CaptchaInputText")).sendKeys(captchaText);

      await driver.sleep(500);
      await driver.findElement(By.id("btnLogin")).click();

      console.log(
        `→ Waiting for login completion (max ${CONFIG.LOGIN_TIMEOUT / 1000}s)...`
      );

      // Intelligent wait for success indicators OR "Captcha invalid" error
      try {
        await driver.wait(async () => {
          const url = await driver.getCurrentUrl();
          
          // Pattern 1: Success URL
          if (url.includes("?un=") || url.includes("FromImdLogin=fromlogin")) {
            return true;
          }
          
          // Pattern 2: Dashboard Elements
          const dashboardElements = await driver.findElements(By.id("divMainMotors"));
          if (dashboardElements.length > 0) return true;
          
          const logoutElements = await driver.findElements(By.id("divLogout"));
          if (logoutElements.length > 0) return true;

          // Pattern 3: Captcha Error (Stop waiting and fail attempt)
          const captchaErrors = await driver.findElements(By.xpath("//span[contains(text(), 'Captcha is not valid')]"));
          if (captchaErrors.length > 0 && await captchaErrors[0].isDisplayed()) {
            throw new Error("CAPTCHA_INVALID");
          }

          return false;
        }, CONFIG.LOGIN_TIMEOUT);
      } catch (waitError) {
        if (waitError.message === "CAPTCHA_INVALID") {
          console.log("⚠️ Captcha validation failed! Retrying...");
          continue;
        }
        console.log(`→ Wait finished: ${waitError.message}`);
      }

      // Final verification
      if (await isUserLoggedIn(driver)) {
        console.log("✓ Login completed successfully!");
        return true;
      } else {
        console.log("✗ Login verification failed for this attempt");
        if (attempt === MAX_RETRIES) return false;
        await driver.get(CONFIG.LOGIN_URL); // Go back to login for next attempt
        await driver.sleep(2000);
      }
    } catch (err) {
      console.error(`❌ Error during login attempt ${attempt}:`, err.message);
      if (attempt === MAX_RETRIES) return false;
      await driver.sleep(2000);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// fullPolicycompany/relianceForm.js — "STEP 1.1" and "STEP 2" after the login, verbatim
// ---------------------------------------------------------------------------

/**
 * Close the promo popup if there is one, then wait for the Motors menu: the dashboard is ready.
 * @returns {Promise<WebElement>} the Motors menu (`#divMainMotors`)
 */
async function waitForDashboard(driver) {
  // === STEP 1.1: Close popup modal if present ===
  try {
    await driver.sleep(2000);
    console.log("Checking for modal close button...");
    const closeBtn = await driver.wait(
      until.elementLocated(By.id("Closebutton")),
      5000
    );
    await driver.wait(until.elementIsVisible(closeBtn), 5000);
    await driver.executeScript("arguments[0].click();", closeBtn);
    console.log("Modal closed!");
    await driver.sleep(2000);
  } catch (err) {
    console.log("No modal detected, continuing...");
  }

  await driver.sleep(2000);

  // === STEP 2: wait for Motors menu ===
  const motorsMenu = await driver.wait(
    until.elementLocated(By.id("divMainMotors")),
    30000
  );
  console.log("Motors menu detected!");
  return motorsMenu;
}

// ---------------------------------------------------------------------------
// fullPolicycompany/relianceForm.js — "STEP 0" login, in the same order
// ---------------------------------------------------------------------------

/**
 * Log in exactly as the full-company Reliance flow does, and resolve when the dashboard is ready.
 *
 * @param {WebDriver} driver a fresh Reliance window (common/browser.js openJobBrowser)
 * @param {{username: string, password: string, loginUrl?: string}} creds
 * @param {{jobId?: string}} [ctx] jobId makes the captcha file unique, so parallel logins never solve each other's
 * @returns {Promise<WebElement>} the Motors menu
 * @throws {MultiCompanyError} E203 when Reliance rejects the login (not retried: repeating a rejected login only
 *   burns the portal's lockout budget); a plain [E205] error when no username / password arrived
 */
async function fullCompanyLogin(driver, { username, password, loginUrl } = {}, { jobId } = {}) {
  // THIS job's portal URL — the hardcoded address is only the fallback for a
  // credential saved without one.
  const relianceLoginUrl = loginUrl || DEFAULT_LOGIN_URL;

  console.log(`🌐 [${jobId}] Logging in as ${username}...`);

  // The window is brand new, so it is never already logged in — go straight
  // to the login. Per-job credentials + per-job captcha file: with parallel
  // windows a shared captcha path means jobs solve each other's captcha.
  const loginSuccess = await performLogin(driver, {
    username,
    password,
    loginUrl: relianceLoginUrl,
    captchaTag: jobId,
  });
  if (!loginSuccess) {
    // retryable:false — repeating a rejected login only burns the portal's
    // lockout budget. The operator fixes the credential and re-runs.
    throw new MultiCompanyError(
      "E203",
      `Reliance rejected the login for "${username}". Check that user's Reliance username and password.`,
      { stage: "login", company: "reliance" }
    );
  }
  console.log(`✅ [${jobId}] Logged in as ${username}`);

  return waitForDashboard(driver);
}

module.exports = {
  fullCompanyLogin,
  waitForDashboard,
  performLogin,
  isUserLoggedIn,
  getCaptchaText,
  getCaptchaScreenShot,
  CONFIG,
  DEFAULT_LOGIN_URL,
};
