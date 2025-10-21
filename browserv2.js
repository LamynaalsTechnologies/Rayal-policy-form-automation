const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const { getCaptchaScreenShot, getCaptchaText } = require("./captchaUtils");
// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  LOGIN_URL: "https://smartzone.reliancegeneral.co.in/Login/IMDLogin",
  DASHBOARD_URL: "https://smartzone.reliancegeneral.co.in/",
  USERNAME: "rfcpolicy",
  PASSWORD: "Pass@123",
  LOGIN_TIMEOUT: 5000, // 30 seconds for manual login
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

    console.log(`→ Cloning Chrome profile: ${profileName}`);
    console.log(`   From: ${PATHS.MASTER_PROFILE}`);
    console.log(`   To: ${clonedProfileDir}`);

    // Copy the entire profile directory to Default
    if (fs.existsSync(PATHS.MASTER_PROFILE)) {
      copyDirectoryRecursive(PATHS.MASTER_PROFILE, clonedProfileDir);
      console.log(`✓ Profile cloned successfully!`);
      console.log(`   User Data Dir: ${clonedUserDataDir}`);
      console.log(`   Profile Dir: Default`);

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
      fs.copyFileSync(sourcePath, destPath);
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
    await driver.wait(
      until.elementLocated(By.id("divLogout")),
      CONFIG.CHECK_TIMEOUT
    );
    console.log("✓ User is logged in -> session is active");
    return true;
  } catch (error) {
    console.log("→ User is NOT logged in -> session expired or new profile");
    return false;
  }
}

/**
 * Performs the login process
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
async function performLogin(driver) {
  console.log("→ Navigating to login page...");
  await driver.get(CONFIG.LOGIN_URL);
  await driver.sleep(2000);

  console.log("→ Filling login credentials...");

  // Get captcha text
  const captchaText = await getCaptchaText(driver, "reliance_captcha");
  console.log("Captcha text:", captchaText);

  // Fill login form
  await driver.findElement(By.id("txtUserName")).sendKeys(CONFIG.USERNAME);
  await driver.findElement(By.id("txtPassword")).sendKeys(CONFIG.PASSWORD);
  await driver.sleep(2000);
  await driver.findElement(By.id("CaptchaInputText")).sendKeys(captchaText);
  await driver.findElement(By.id("btnLogin")).click();

  console.log(
    `→ Waiting ${CONFIG.LOGIN_TIMEOUT / 1000}s for login completion...`
  );

  await driver.sleep(CONFIG.LOGIN_TIMEOUT);

  // Verify login was successful
  const loginSuccess = await isUserLoggedIn(driver);
  if (loginSuccess) {
    console.log("✓ Login completed successfully!");
    return true;
  } else {
    console.log("✗ Login failed or timed out");
    return false;
  }
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
 * Creates Chrome options for the master profile
 * @returns {chrome.Options} Configured Chrome options
 */
function createMasterProfileOptions() {
  const options = new chrome.Options();
  options.addArguments("--headless=new");
  options.addArguments(`user-data-dir=${PATHS.BASE_PROFILE}`);
  options.addArguments("profile-directory=Demo");
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-background-timer-throttling");
  options.addArguments("--disable-backgrounding-occluded-windows");
  options.addArguments("--disable-renderer-backgrounding");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  return options;
}

/**
 * Creates Chrome options for a cloned profile
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 * @returns {chrome.Options} Configured Chrome options
 */
function createClonedProfileOptions(clonedProfileInfo) {
  const options = new chrome.Options();
  options.addArguments("--headless=new"); 
  options.addArguments(`user-data-dir=${clonedProfileInfo.userDataDir}`);
  options.addArguments(
    `profile-directory=${clonedProfileInfo.profileDirectory}`
  );
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

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
async function initializeMasterSession() {
  let driver = null;

  try {
    console.log("\n========================================");
    console.log("  MASTER SESSION INITIALIZATION");
    console.log("========================================\n");

    // Create master browser instance
    driver = await createMasterBrowser();

    // Check if already logged in
    console.log("→ Checking login status...");
    await driver.get(CONFIG.DASHBOARD_URL);

    let isLoggedIn = await isUserLoggedIn(driver);

    // If not logged in, perform login
    if (!isLoggedIn) {
      console.log("\n→ Login required. Starting login process...");
      const loginSuccess = await performLogin(driver);

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

        // Demonstrate: Open a new browser with cloned profile
        console.log("\n========================================");
        console.log("  TESTING CLONED PROFILE");
        console.log("========================================\n");

        await testClonedProfile(clonedProfileInfo);
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
