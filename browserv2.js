const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { getCaptchaScreenShot, getCaptchaText } = require("./captchaUtils");
require("dotenv").config();
const mongoose = require("mongoose");
const { ProviderCredential } = require("./models");
// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  // LOGIN_URL: "https://smartzone.reliancegeneral.co.in/Login/IMDLogin",
  LOGIN_URL: "", // Will be populated from DB
  DASHBOARD_URL: "https://smartzone.reliancegeneral.co.in/",
  // USERNAME: "rfcpolicy",
  // PASSWORD: "Pass@123",
  USERNAME: "", // Will be populated from DB
  PASSWORD: "", // Will be populated from DB
  LOGIN_TIMEOUT: 5000,
  CHECK_TIMEOUT: 5000,
};

const PATHS = {
  BASE_PROFILE: path.join(os.homedir(), "chrome_profile"),
  MASTER_PROFILE: path.join(os.homedir(), "chrome_profile", "Demo"),
  CLONED_PROFILE_BASE: path.join(process.cwd(), "cloned_profiles"),
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Ensures a directory exists, creates it if not
 */
function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`✓ Created directory: ${dirPath}`);
  }
}

/**
 * Clones the master Chrome profile to a new profile
 * @param {string} profileName - Name for the cloned profile
 * @returns {Object} Object with userDataDir and profileDirectory paths
 */
function cloneChromeProfile(profileName) {
  try {
    const timestamp = Date.now();
    const clonedBasePath = path.join(
      PATHS.CLONED_PROFILE_BASE,
      `${profileName}_${timestamp}`
    );

    // Create proper Chrome profile structure: user_data_dir/Default/
    const clonedUserDataDir = clonedBasePath;
    const clonedProfileDir = path.join(clonedUserDataDir, "Default");

    ensureDirectoryExists(PATHS.CLONED_PROFILE_BASE);

    // console.log(`→ Cloning Chrome profile: ${profileName}`);
    // console.log(`   From: ${PATHS.MASTER_PROFILE}`);
    // console.log(`   To: ${clonedProfileDir}`);

    // Copy the entire profile directory to Default
    if (fs.existsSync(PATHS.MASTER_PROFILE)) {
      copyDirectoryRecursive(PATHS.MASTER_PROFILE, clonedProfileDir);
      // console.log(`✓ Profile cloned successfully!`);
      // console.log(`   User Data Dir: ${clonedUserDataDir}`);
      // console.log(`   Profile Dir: Default`);

      return {
        userDataDir: clonedUserDataDir,
        profileDirectory: "Default",
        fullPath: clonedProfileDir,
      };
    } else {
      console.warn(`⚠ Master profile not found at: ${PATHS.MASTER_PROFILE}`);
      return null;
    }
  } catch (error) {
    console.error("✗ Failed to clone profile:", error.message);
    return null;
  }
}

/**
 * Recursively copies a directory
 */
function copyDirectoryRecursive(source, destination) {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const files = fs.readdirSync(source);

  files.forEach((file) => {
    const sourcePath = path.join(source, file);
    const destPath = path.join(destination, file);

    if (fs.statSync(sourcePath).isDirectory()) {
      copyDirectoryRecursive(sourcePath, destPath);
    } else {
      try {
        fs.copyFileSync(sourcePath, destPath);
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM') {
          // Silence locked file warnings as they are expected when master is running
          // console.warn(`   ⚠️ Skipped locked file: ${file}`);
        } else {
          throw err;
        }
      }
    }
  });
}

// ============================================
// BROWSER SESSION FUNCTIONS
// ============================================

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

/**
 * Saves session cookies to a file
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
async function saveCookies(driver) {
  try {
    const cookies = await driver.manage().getCookies();
    const cookiesPath = path.join(process.cwd(), "session_cookies.json");
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
    console.log(`✓ Session cookies saved: ${cookiesPath}`);
  } catch (error) {
    console.error("✗ Failed to save cookies:", error.message);
  }
}

// ============================================
// BROWSER CREATION FUNCTIONS
// ============================================

/**
 * Point Chrome at a real binary. On a server the browser is often installed
 * somewhere Selenium's default lookup does not find (or only chromium is
 * present), which also surfaces as "Chrome instance exited". Mirrors the
 * detection nationalBrowserConfig.js already does.
 */
function applyChromeBinaryPath(options) {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) {
        options.setChromeBinaryPath(bin);
        return bin;
      }
    } catch (e) { /* try the next candidate */ }
  }
  return null;
}

/**
 * Should Chrome run headless?
 *
 * A server has no X display, so a non-headless Chrome exits immediately with
 * "session not created: Chrome instance exited". HEADLESS=false is useful
 * locally (to watch the run) but must not be honoured where there is no
 * display to draw on — otherwise every job fails on the server while working
 * on the developer's machine.
 */
function shouldRunHeadless() {
  if (process.env.HEADLESS === "true") return true;

  const hasDisplay =
    process.platform !== "linux" || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;

  if (!hasDisplay) {
    if (process.env.HEADLESS === "false") {
      console.log(
        "[Browser] HEADLESS=false but no display detected — forcing headless so Chrome can start."
      );
    }
    return true;
  }
  return false;
}

/**
 * Creates Chrome options for the master profile
 * @returns {chrome.Options} Configured Chrome options
 */
function createMasterProfileOptions() {
  const options = new chrome.Options();
  // Always run master in headless mode to avoid confusing the user with multiple windows
  // unless explicitly requested otherwise via environment variable
  if (process.env.MASTER_HEADLESS !== "false" || shouldRunHeadless()) {
    options.addArguments("--headless=new");
  }

  options.addArguments(`user-data-dir=${PATHS.BASE_PROFILE}`);
  options.addArguments("profile-directory=Demo");
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-background-timer-throttling");
  options.addArguments("--disable-backgrounding-occluded-windows");
  options.addArguments("--disable-renderer-backgrounding");

  // Server-safety flags. Without these Chrome exits immediately on a Linux
  // server ("session not created: Chrome instance exited"):
  //   --no-sandbox            : the sandbox cannot start as root (pm2/docker)
  //   --disable-dev-shm-usage : /dev/shm is typically only 64MB on a server,
  //                             which Chrome exhausts on startup
  // The National config (nationalBrowserConfig.js) already sets both, which is
  // why National worked on this server while Reliance did not.
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-gpu");
  options.addArguments("--disable-extensions");
  options.addArguments("--window-size=1366,768");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  applyChromeBinaryPath(options);

  return options;
}

/**
 * Creates Chrome options for a cloned profile
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 * @returns {chrome.Options} Configured Chrome options
 */
function createClonedProfileOptions(clonedProfileInfo) {
  const options = new chrome.Options();
  if (shouldRunHeadless()) {
    options.addArguments("--headless=new");
  }
  options.addArguments(`user-data-dir=${clonedProfileInfo.userDataDir}`);
  options.addArguments(
    `profile-directory=${clonedProfileInfo.profileDirectory}`
  );
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");

  // Per-JOB download directory. Without it every window downloaded into the
  // same place and the PDF pick-up ("newest file in reliance_pdf/") could grab
  // ANOTHER customer's policy PDF when two jobs ran in parallel — a severe
  // data mix-up. sessionManager passes downloadDir per job.
  if (clonedProfileInfo.downloadDir) {
    try {
      fs.mkdirSync(clonedProfileInfo.downloadDir, { recursive: true });
    } catch (e) { /* Chrome will surface a real problem on download */ }
    options.setUserPreferences({
      "download.default_directory": clonedProfileInfo.downloadDir,
      "download.prompt_for_download": false,
      "download.directory_upgrade": true,
      "plugins.always_open_pdf_externally": true,
    });
  }

  // Server-safety flags. Without these Chrome exits immediately on a Linux
  // server ("session not created: Chrome instance exited"):
  //   --no-sandbox            : the sandbox cannot start as root (pm2/docker)
  //   --disable-dev-shm-usage : /dev/shm is typically only 64MB on a server,
  //                             which Chrome exhausts on startup
  // The National config (nationalBrowserConfig.js) already sets both, which is
  // why National worked on this server while Reliance did not.
  options.addArguments("--no-sandbox");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-gpu");
  options.addArguments("--disable-extensions");
  options.addArguments("--window-size=1366,768");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  applyChromeBinaryPath(options);

  return options;
}

/**
 * Creates a new browser instance with the master profile
 * @returns {Promise<WebDriver>} Selenium WebDriver instance
 */
async function createMasterBrowser() {
  console.log("→ Creating master browser instance...");
  const options = createMasterProfileOptions();

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  console.log("✓ Master browser created");
  return driver;
}

/**
 * Creates a new browser instance with a cloned profile
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 * @returns {Promise<WebDriver>} Selenium WebDriver instance
 */
async function createClonedBrowser(clonedProfileInfo) {
  console.log("→ Creating cloned browser instance...");
  const options = createClonedProfileOptions(clonedProfileInfo);

  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();

  console.log("✓ Cloned browser created");
  return driver;
}

// ============================================
// MAIN ORCHESTRATION
// ============================================

/**
 * Main function - handles login and profile cloning
 */
async function initializeMasterSession(policyId = null) {
  let driver = null;

  try {
    console.log("\n========================================");
    console.log("  MASTER SESSION INITIALIZATION");
    console.log("========================================\n");

    // Connect to MongoDB if not already connected
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("✓ Connected to MongoDB");
    }

    // Fetch credentials from DB
    let creds = null;

    if (policyId) {
      console.log(`→ Fetching policy data for ID: ${policyId}...`);
      const policy = await mongoose.connection.db
        .collection("onlinePolicy")
        .findOne({ _id: new mongoose.Types.ObjectId(policyId) });

      if (policy && policy.clientId) {
        console.log(
          `→ Policy found with clientId: ${policy.clientId}. Fetching credentials...`
        );
        // Matched on `userId` (the record's own id), like the queue's resolver.
        // The clientId FIELD is the owning client and is shared by every user
        // under it, so it cannot identify a single login.
        creds = await ProviderCredential.findOne({
          userId: policy.clientId,
          provider: "reliance",
          isActive: true,
        });

        if (creds) {
          console.log(
            `✓ Found credentials for clientId: ${policy.clientId} (username: ${creds.username})`
          );
        }
      }
    }

    // NO "first active Reliance row in the database" fallback — it used to pick
    // an arbitrary client's portal login. See lib/credentialResolver.js, which
    // is what actually resolves each job's credentials.
    if (!creds) {
      throw new Error(
        "[E205] No active Reliance credentials found for this client. Please check the ProviderCredential collection."
      );
    }

    console.log(`✓ Using credentials for: ${creds.username}`);
    CONFIG.USERNAME = creds.username;
    CONFIG.PASSWORD = creds.password;
    if (creds.loginUrl) CONFIG.LOGIN_URL = creds.loginUrl;
    if (creds.dashboardUrl) CONFIG.DASHBOARD_URL = creds.dashboardUrl;

    // Create master browser instance
    driver = await createMasterBrowser();

    // Check if already logged in
    console.log("→ Checking login status...");
    await driver.get(CONFIG.DASHBOARD_URL);

    let isLoggedIn = await isUserLoggedIn(driver);

    // If not logged in, perform login
    if (!isLoggedIn) {
      console.log("\n→ Login required. Starting login process...");
      // Explicit, rather than leaning on the CONFIG values written above —
      // CONFIG is shared and another job can rewrite it in between.
      const loginSuccess = await performLogin(driver, creds);

      if (loginSuccess) {
        // Save cookies after successful login
        await saveCookies(driver);
        isLoggedIn = true;
      } else {
        throw new Error("Login failed. Cannot proceed.");
      }
    }

    // If logged in, clone the profile
    if (isLoggedIn) {
      console.log("\n========================================");
      console.log("  CLONING PROFILE");
      console.log("========================================\n");

      const clonedProfileInfo = cloneChromeProfile("session");

      if (clonedProfileInfo) {
        console.log("\n✓ Master session is ready!");
        console.log("✓ Profile has been cloned for new browser instances");
        console.log(
          `\n→ Cloned profile location: ${clonedProfileInfo.fullPath}`
        );

/* 
        // Demonstrate: Open a new browser with cloned profile
        console.log("\n========================================");
        console.log("  TESTING CLONED PROFILE");
        console.log("========================================\n");

        await testClonedProfile(clonedProfileInfo);
        */
      }
    }

    console.log("\n✓ All operations completed!");
    console.log("→ Master browser will stay open. Press Ctrl+C to quit.\n");
  } catch (error) {
    console.error("\n✗ Error:", error.message);
    console.error(error.stack);
  }

  // Keep browser open - uncomment to close automatically
  // finally {
  //   if (driver) {
  //     await driver.quit();
  //   }
  // }
}

/**
 * Tests the cloned profile by opening a new browser instance
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 */
async function testClonedProfile(clonedProfileInfo) {
  let clonedDriver = null;

  try {
    console.log("→ Opening new browser with cloned profile...");
    clonedDriver = await createClonedBrowser(clonedProfileInfo);

    console.log("→ Navigating to dashboard...");
    await clonedDriver.get(CONFIG.DASHBOARD_URL);

    // Check if cloned profile maintains login
    const isLoggedIn = await isUserLoggedIn(clonedDriver);

    if (isLoggedIn) {
      console.log("✓ SUCCESS! Cloned profile is logged in automatically!");
      console.log("→ New browser instance entered directly without login!");
    } else {
      console.log("⚠ Cloned profile requires login (session may have expired)");
    }

    console.log("\n→ Cloned browser will stay open for testing...");
  } catch (error) {
    console.error("✗ Error testing cloned profile:", error.message);
    if (clonedDriver) {
      await clonedDriver.quit();
    }
  }
}

// Export functions for use in other modules
module.exports = {
  createMasterBrowser,
  createClonedBrowser,
  cloneChromeProfile,
  isUserLoggedIn,
  performLogin,
  CONFIG,
  PATHS,
  initializeMasterSession,
};
