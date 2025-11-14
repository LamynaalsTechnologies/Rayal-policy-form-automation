const { Builder, By, Key, until } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");

/**
 * Wait for loader to disappear
 */
async function waitForLoaderToDisappear(driver, timeout = 30000) {
  try {
    // Wait for any loading indicators to disappear
    await driver.sleep(2000);
    
    // Try to find and wait for loader to disappear
    const loaderSelectors = [
      By.css(".loader"),
      By.css("[class*='loading']"),
      By.css("[class*='spinner']"),
      By.id("loader"),
    ];
    
    for (const selector of loaderSelectors) {
      try {
        const loader = await driver.findElement(selector);
        await driver.wait(until.stalenessOf(loader), timeout);
        break;
      } catch (e) {
        // Loader not found with this selector, try next
      }
    }
  } catch (error) {
    // If loader doesn't exist or times out, continue
    console.log("Loader check completed or timeout");
  }
}

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  LOGIN_URL: "https://nicportal.nic.co.in/nicportal/signin/login",
  DASHBOARD_URL: "https://nicportal.nic.co.in/nicportal/home/hcontent",
  USERNAME: "9999839907",
  PASSWORD: "Rayal$2025",
  LOGIN_TIMEOUT: 10000,
  CHECK_TIMEOUT: 5000,
};

const PATHS = {
  BASE_PROFILE: path.join(os.homedir(), "chrome_profile_national"),
  MASTER_PROFILE: path.join(os.homedir(), "chrome_profile_national", "Demo"),
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

    console.log(`→ Cloning National Chrome profile: ${profileName}`);
    console.log(`   From: ${PATHS.MASTER_PROFILE}`);
    console.log(`   To: ${clonedProfileDir}`);

    // Copy the entire profile directory to Default
    if (fs.existsSync(PATHS.MASTER_PROFILE)) {
      copyDirectoryRecursive(PATHS.MASTER_PROFILE, clonedProfileDir);
      console.log(`✓ National profile cloned successfully!`);
      console.log(`   User Data Dir: ${clonedUserDataDir}`);
      console.log(`   Profile Dir: Default`);

      return {
        userDataDir: clonedUserDataDir,
        profileDirectory: "Default",
        fullPath: clonedProfileDir,
      };
    } else {
      console.warn(`⚠ National master profile not found at: ${PATHS.MASTER_PROFILE}`);
      return null;
    }
  } catch (error) {
    console.error("✗ Failed to clone National profile:", error.message);
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
    // Check if we're on login page (not logged in) or dashboard (logged in)
    const currentUrl = await driver.getCurrentUrl();
    const loginElements = await driver.findElements(By.name("log_txtfield_iUsername_01"));
    
    // If we're on login page or login elements exist, we're not logged in
    if (loginElements.length > 0 || currentUrl.includes("/signin/login")) {
      console.log("→ User is NOT logged in -> on login page");
      return false;
    }
    
    // Check if we're on the post-login URL (home/hcontent)
    if (currentUrl.includes("/home/hcontent") || currentUrl.includes("/nicportal/home")) {
      console.log("✓ User is logged in -> on dashboard/home page");
      return true;
    }
    
    // If we're not on login page and not on home page, try navigating to home to verify
    if (!currentUrl.includes("/home")) {
      console.log("→ Current URL doesn't match expected post-login URL, checking...");
      // Try navigating to home page - if logged in, it will work
      try {
        await driver.get(CONFIG.DASHBOARD_URL);
        await driver.sleep(2000);
        const newUrl = await driver.getCurrentUrl();
        if (newUrl.includes("/home/hcontent") || newUrl.includes("/nicportal/home")) {
          console.log("✓ User is logged in -> successfully navigated to home page");
          return true;
        } else if (newUrl.includes("/signin/login")) {
          console.log("→ Redirected to login page, not logged in");
          return false;
        }
      } catch (e) {
        // Navigation failed, likely not logged in
        console.log("→ Navigation to home failed, likely not logged in");
        return false;
      }
    }
    
    // If we're not on login page, assume logged in
    console.log("✓ User appears to be logged in");
    return true;
  } catch (error) {
    console.log("→ User is NOT logged in -> session expired or new profile");
    return false;
  }
}

/**
 * Performs the National login process
 * @param {WebDriver} driver - Selenium WebDriver instance
 */
async function performNationalLogin(driver) {
  console.log("→ Navigating to National login page...");
  await driver.get(CONFIG.LOGIN_URL);
  await driver.sleep(3000);

  console.log("→ Filling login credentials...");

  try {
    // Wait for page to load
    await waitForLoaderToDisappear(driver);
    
    // Select INTERMEDIARY from dropdown (Material Design)
    let dropdown;
    try {
      dropdown = By.name("reg_dropdown_iType_02");
      await driver.wait(until.elementLocated(dropdown), 10000);
    } catch (e) {
      console.log("Name selector failed, trying ID selector...");
      try {
        dropdown = By.id("mat-select-4");
        await driver.wait(until.elementLocated(dropdown), 10000);
      } catch (e2) {
        console.log("ID selector failed, trying CSS selector...");
        dropdown = By.css("mat-select[role='combobox']");
        await driver.wait(until.elementLocated(dropdown), 10000);
      }
    }
    
    const dropdownElement = await driver.findElement(dropdown);
    await dropdownElement.click();
    await driver.sleep(2000);
    
    // Find and click INTERMEDIARY option
    const intermediaryOption = await driver.wait(
      until.elementLocated(By.xpath("//mat-option[contains(., 'INTERMEDIARY')]")),
      10000
    );
    await intermediaryOption.click();
    console.log("✓ Selected INTERMEDIARY option");
    await driver.sleep(1000);

    // Select BROKER POSP from second dropdown
    // Note: The second dropdown might appear after selecting INTERMEDIARY
    await driver.sleep(2000); // Wait for second dropdown to appear
    
    // Try to find the second dropdown - it might be the same selector or a different one
    // Look for all mat-select elements and use the second one, or try to find by different attributes
    let secondDropdown;
    try {
      // Try to find all mat-select elements and use the second one
      const allSelects = await driver.findElements(By.css("mat-select[role='combobox']"));
      if (allSelects.length > 1) {
        console.log(`Found ${allSelects.length} mat-select elements, using the second one`);
        await allSelects[1].click();
      } else if (allSelects.length === 1) {
        // Only one dropdown found, might need to click it again
        console.log("Only one mat-select found, clicking again for second selection");
        await allSelects[0].click();
      } else {
        // Try alternative selectors
        secondDropdown = By.name("reg_dropdown_iType_02");
        const secondDropdownElement = await driver.wait(until.elementLocated(secondDropdown), 10000);
        await secondDropdownElement.click();
      }
    } catch (e) {
      console.log("Second dropdown selection approach failed, trying alternative...");
      // Fallback: try clicking the first dropdown again
      try {
        const firstDropdownAgain = await driver.findElement(dropdown);
        await firstDropdownAgain.click();
        await driver.sleep(1000);
      } catch (e2) {
        console.log("Alternative approach also failed, continuing...");
      }
    }
    
    await driver.sleep(2000);
    
    // Find and click BROKER POSP option
    try {
      const brokerOption = await driver.wait(
        until.elementLocated(By.xpath("//mat-option[contains(., 'BROKER POSP')]")),
        10000
      );
      await brokerOption.click();
      console.log("✓ Selected BROKER POSP option");
    } catch (brokerError) {
      console.log("BROKER POSP option not found, trying alternative selector...");
      try {
        const altBrokerOption = By.xpath("//mat-option[contains(text(), 'BROKER POSP')]");
        await driver.wait(until.elementLocated(altBrokerOption), 5000);
        const altOption = await driver.findElement(altBrokerOption);
        await altOption.click();
        console.log("✓ Selected BROKER POSP option with alternative selector");
      } catch (altError) {
        console.log("⚠️  Could not select BROKER POSP, continuing with login...");
      }
    }
    await driver.sleep(1000);

    // Fill username
    const usernameField = await driver.wait(
      until.elementLocated(By.name("log_txtfield_iUsername_01")),
      10000
    );
    await usernameField.clear();
    await usernameField.sendKeys(CONFIG.USERNAME);

    // Fill password
    const passwordField = await driver.wait(
      until.elementLocated(By.name("log_pwd_iPassword_01")),
      10000
    );
    await passwordField.clear();
    await passwordField.sendKeys(CONFIG.PASSWORD);

    await driver.sleep(1000);

    // Click login button
    const loginButton = await driver.wait(
      until.elementLocated(By.name("log_btn_login_01")),
      10000
    );
    await driver.wait(until.elementIsVisible(loginButton), 10000);
    await driver.wait(until.elementIsEnabled(loginButton), 10000);
    
    try {
      await loginButton.click();
      console.log("✓ Login button clicked (regular click)");
    } catch (clickError) {
      console.log("Regular click failed, trying JavaScript click...");
      await driver.executeScript("arguments[0].click();", loginButton);
      console.log("✓ Login button clicked (JavaScript click)");
    }

    console.log(
      `→ Waiting ${CONFIG.LOGIN_TIMEOUT / 1000}s for login completion...`
    );

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
    console.error("✗ National login error:", error.message);
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
  ensureDirectoryExists(PATHS.BASE_PROFILE);
  // Don't pre-create Demo directory - let Chrome create it

  const options = new chrome.Options();
  options.addArguments(`--user-data-dir=${PATHS.BASE_PROFILE}`);
  options.addArguments("--profile-directory=Demo");
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-background-timer-throttling");
  options.addArguments("--disable-backgrounding-occluded-windows");
  options.addArguments("--disable-renderer-backgrounding");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-extensions");
  options.addArguments("--window-size=1366,768");
  options.addArguments("--no-sandbox");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  // Chrome binary detection
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
    } catch (e) {}
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
  options.addArguments(`--user-data-dir=${clonedProfileInfo.userDataDir}`);
  options.addArguments(
    `--profile-directory=${clonedProfileInfo.profileDirectory}`
  );
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-extensions");
  options.addArguments("--window-size=1366,768");
  options.addArguments("--no-sandbox");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  // Chrome binary detection
  const candidateChromeBins = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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
    } catch (e) {}
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

  // ChromeDriver service builder detection
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
    } catch (e) {}
  }

  let builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  
  if (serviceBuilder) {
    builder = builder.setChromeService(serviceBuilder);
  }

  const driver = await builder.build();

  console.log("✓ National master browser created");
  return driver;
}

/**
 * Creates a new browser instance with a cloned profile
 * @param {Object} clonedProfileInfo - Object with userDataDir and profileDirectory
 * @returns {Promise<WebDriver>} Selenium WebDriver instance
 */
async function createClonedBrowser(clonedProfileInfo) {
  console.log("→ Creating National cloned browser instance...");
  const options = createClonedProfileOptions(clonedProfileInfo);

  // ChromeDriver service builder detection
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
    } catch (e) {}
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

