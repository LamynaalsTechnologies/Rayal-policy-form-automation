const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  LOGIN_URL: "https://nicportal.nic.co.in/nicportal/signin/login",
  DASHBOARD_URL: "https://nicportal.nic.co.in/nicportal", // Update with actual dashboard URL
  USERNAME: "9999839907",
  PASSWORD: "Rayal$2025",
  LOGIN_TIMEOUT: 10000,
  CHECK_TIMEOUT: 5000,
};

const PATHS = {
  BASE_PROFILE: path.join(os.homedir(), "chrome_profile_national"),
  MASTER_PROFILE: path.join(os.homedir(), "chrome_profile_national", "Demo"), // Use Demo like Reliance
  CLONED_PROFILE_BASE: path.join(process.cwd(), "cloned_profiles_national"),
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
 * Checks if the user is currently logged in to National portal
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @returns {Promise<boolean>} True if logged in
 */
async function isNationalUserLoggedIn(driver) {
  try {
    // Check if we're on login page (login form elements exist)
    const loginElements = await driver.findElements(By.name("log_txtfield_iUsername_01"));
    if (loginElements.length > 0) {
      console.log("→ User is NOT logged in -> on login page");
      return false;
    }

    // Check for elements that indicate logged-in state
    // Look for any navigation elements or dashboard elements
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes("/signin/login")) {
      console.log("→ User is NOT logged in -> on login URL");
      return false;
    }

    // If we're not on login page, assume logged in
    console.log("✓ User appears to be logged in");
    return true;
  } catch (error) {
    console.log("→ Could not determine login status:", error.message);
    return false;
  }
}

/**
 * Performs the National Insurance login process
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {Object} credentials - Optional credentials { username, password }
 * @returns {Promise<boolean>} True if login successful
 */
async function performNationalLogin(driver, credentials = null) {
  const username = credentials?.username || CONFIG.USERNAME;
  const password = credentials?.password || CONFIG.PASSWORD;

  try {
    console.log("→ Navigating to National login page...");
    await driver.get(CONFIG.LOGIN_URL);
    await driver.sleep(3000);

    console.log("→ Filling login credentials...");

    // Select INTERMEDIARY option
    try {
      let dropdown;
      try {
        dropdown = By.name("reg_dropdown_iType_02");
        await driver.wait(until.elementLocated(dropdown), 5000);
      } catch (e) {
        try {
          dropdown = By.id("mat-select-4");
          await driver.wait(until.elementLocated(dropdown), 5000);
        } catch (e2) {
          dropdown = By.css("mat-select[role='combobox']");
          await driver.wait(until.elementLocated(dropdown), 5000);
        }
      }

      await driver.findElement(dropdown).click();
      await driver.sleep(2000);

      const intermediaryOption = By.xpath("//mat-option[contains(., 'INTERMEDIARY')]");
      await driver.wait(until.elementLocated(intermediaryOption), 10000);
      await driver.findElement(intermediaryOption).click();
      await driver.sleep(1000);
    } catch (error) {
      console.log("INTERMEDIARY option selection failed:", error.message);
    }

    // Select BROKER POSP option
    try {
      await driver.sleep(2000);
      let secondDropdown;
      try {
        secondDropdown = By.name("reg_dropdown_iType_02");
        await driver.wait(until.elementLocated(secondDropdown), 5000);
      } catch (e) {
        try {
          secondDropdown = By.id("mat-select-4");
          await driver.wait(until.elementLocated(secondDropdown), 5000);
        } catch (e2) {
          secondDropdown = By.css("mat-select[role='combobox']");
          await driver.wait(until.elementLocated(secondDropdown), 5000);
        }
      }

      await driver.findElement(secondDropdown).click();
      await driver.sleep(2000);

      const brokerPospOption = By.xpath("//mat-option[contains(., 'BROKER POSP')]");
      await driver.wait(until.elementLocated(brokerPospOption), 10000);
      await driver.findElement(brokerPospOption).click();
      await driver.sleep(1000);
    } catch (error) {
      console.log("BROKER POSP option selection failed:", error.message);
    }

    // Fill username
    const usernameField = By.name("log_txtfield_iUsername_01");
    await driver.wait(until.elementLocated(usernameField), 10000);
    await driver.findElement(usernameField).clear();
    await driver.findElement(usernameField).sendKeys(username);

    // Fill password
    const passwordField = By.name("log_pwd_iPassword_01");
    await driver.wait(until.elementLocated(passwordField), 10000);
    await driver.findElement(passwordField).clear();
    await driver.findElement(passwordField).sendKeys(password);

    // Click login button
    console.log("→ Clicking login button...");
    const loginButton = By.name("log_btn_login_01");
    
    try {
      const buttonElement = await driver.wait(until.elementLocated(loginButton), 10000);
      await driver.wait(until.elementIsVisible(buttonElement), 10000);
      await driver.wait(until.elementIsEnabled(buttonElement), 10000);
      
      // Try regular click first
      try {
        await buttonElement.click();
        console.log("✓ Login button clicked (regular)");
      } catch (clickError) {
        // Fallback to JavaScript click
        await driver.executeScript("arguments[0].click();", buttonElement);
        console.log("✓ Login button clicked (JavaScript)");
      }
    } catch (buttonError) {
      console.error("✗ Failed to click login button:", buttonError.message);
      throw buttonError;
    }

    console.log(`→ Waiting ${CONFIG.LOGIN_TIMEOUT / 1000}s for login completion...`);
    await driver.sleep(CONFIG.LOGIN_TIMEOUT);

    // Verify login was successful
    const loginSuccess = await isNationalUserLoggedIn(driver);
    if (loginSuccess) {
      console.log("✓ National login completed successfully!");
      return true;
    } else {
      console.log("✗ National login failed or timed out");
      return false;
    }
  } catch (error) {
    console.error("✗ Error during National login:", error.message);
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
    const cookiesPath = path.join(process.cwd(), "session_cookies_national.json");
    fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
    console.log(`✓ National session cookies saved: ${cookiesPath}`);
  } catch (error) {
    console.error("✗ Failed to save National cookies:", error.message);
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
  // Ensure base profile directory exists
  ensureDirectoryExists(PATHS.BASE_PROFILE);
  
  // Don't pre-create Demo directory - let Chrome create it on first run
  // This avoids profile corruption issues

  const options = new chrome.Options();
  // options.addArguments("--headless=new")
  options.addArguments(`--user-data-dir=${PATHS.BASE_PROFILE}`);
  options.addArguments("--profile-directory=Demo"); // Use Demo like Reliance
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-background-timer-throttling");
  options.addArguments("--disable-backgrounding-occluded-windows");
  options.addArguments("--disable-renderer-backgrounding");
  options.addArguments("--disable-dev-shm-usage"); // Overcome limited resource problems
  options.addArguments("--disable-extensions"); // Faster startup
  options.addArguments("--window-size=1366,768"); // Fixed window size

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  // Try to use system Chrome binary if found
  const candidateChromeBins = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  
  for (const bin of candidateChromeBins) {
    try {
      if (fs.existsSync(bin)) {
        options.setChromeBinaryPath(bin);
        console.log(`✓ Using Chrome binary: ${bin}`);
        break;
      }
    } catch (e) {
      // Continue to next candidate
    }
  }

  return options;
}

/**
 * Creates Chrome options for a cloned profile
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 * @returns {chrome.Options} Configured Chrome options
 */
function createClonedProfileOptions(clonedProfileInfo) {
  const options = new chrome.Options();
  // options.addArguments("--headless=new");
  options.addArguments(`--user-data-dir=${clonedProfileInfo.userDataDir}`);
  options.addArguments(
    `--profile-directory=${clonedProfileInfo.profileDirectory}`
  );
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-extensions");
  options.addArguments("--disable-gpu");
  options.addArguments("--window-size=1366,768");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  // Try to use system Chrome binary if found
  const candidateChromeBins = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", // macOS
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  
  for (const bin of candidateChromeBins) {
    try {
      if (fs.existsSync(bin)) {
        options.setChromeBinaryPath(bin);
        break;
      }
    } catch (e) {
      // Continue to next candidate
    }
  }

  return options;
}

/**
 * Creates a new browser instance with the master profile
 * @returns {Promise<WebDriver>} Selenium WebDriver instance
 */
async function createMasterBrowser() {
  console.log("→ Creating National master browser instance...");
  const options = createMasterProfileOptions();

  // Prefer a local chromedriver if present
  let serviceBuilder = null;
  const candidateDrivers = [
    process.env.CHROMEDRIVER_PATH,
    path.join(process.cwd(), "chromedriver"),
    "/usr/local/bin/chromedriver",
    "/usr/bin/chromedriver",
  ].filter(Boolean);

  for (const driverPath of candidateDrivers) {
    try {
      if (fs.existsSync(driverPath)) {
        const { ServiceBuilder } = require("selenium-webdriver/chrome");
        serviceBuilder = new ServiceBuilder(driverPath);
        console.log(`✓ Using ChromeDriver: ${driverPath}`);
        break;
      }
    } catch (e) {
      // Continue to next candidate
    }
  }

  let builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  
  if (serviceBuilder) {
    builder = builder.setChromeService(serviceBuilder);
  }

  try {
    const driver = await builder.build();
    console.log("✓ National master browser created");
    return driver;
  } catch (error) {
    console.error("❌ Failed to create National master browser:", error.message);
    console.error("💡 Troubleshooting tips:");
    console.error("   1. Check if Chrome/Chromium is installed");
    console.error("   2. Check if ChromeDriver is installed and matches Chrome version");
    console.error("   3. Try setting CHROME_PATH environment variable");
    console.error("   4. Check profile directory permissions:", PATHS.BASE_PROFILE);
    throw error;
  }
}

/**
 * Creates a new browser instance with a cloned profile
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 * @returns {Promise<WebDriver>} Selenium WebDriver instance
 */
async function createClonedBrowser(clonedProfileInfo) {
  console.log("→ Creating National cloned browser instance...");
  const options = createClonedProfileOptions(clonedProfileInfo);

  // Prefer a local chromedriver if present
  let serviceBuilder = null;
  const candidateDrivers = [
    process.env.CHROMEDRIVER_PATH,
    path.join(process.cwd(), "chromedriver"),
    "/usr/local/bin/chromedriver",
    "/usr/bin/chromedriver",
  ].filter(Boolean);

  for (const driverPath of candidateDrivers) {
    try {
      if (fs.existsSync(driverPath)) {
        const { ServiceBuilder } = require("selenium-webdriver/chrome");
        serviceBuilder = new ServiceBuilder(driverPath);
        break;
      }
    } catch (e) {
      // Continue to next candidate
    }
  }

  let builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  
  if (serviceBuilder) {
    builder = builder.setChromeService(serviceBuilder);
  }

  const driver = await builder.build();

  console.log("✓ National cloned browser created");
  return driver;
}

// Export functions for use in other modules
module.exports = {
  createMasterBrowser,
  createClonedBrowser,
  cloneChromeProfile,
  isNationalUserLoggedIn,
  performNationalLogin,
  CONFIG,
  PATHS,
  saveCookies,
};

