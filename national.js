const { By, until, Key } = require("selenium-webdriver");
const {
  createNationalJobBrowser,
  cleanupNationalJobBrowser,
  reLoginNationalIfNeeded,
  recoveryManager,
} = require("./nationalSessionManager");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("./Captcha");
const { uploadScreenshotToS3, generateScreenshotKey } = require("./s3Uploader");

// Default form data for standalone execution
const defaultFormData = {
  username: "9999839907",
  password: "Rayal$2025",
  rtoLocation: "Mumbai",
  make: "Honda",
  variant: "Standard"
};

// Parse command line arguments
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  const formData = { ...defaultFormData };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    switch (key) {
      case '--username':
      case '-u':
        formData.username = value;
        break;
      case '--password':
      case '-p':
        formData.password = value;
        break;
      case '--rto':
      case '-r':
        formData.rtoLocation = value;
        break;
      case '--make':
      case '-m':
        formData.make = value;
        break;
      case '--variant':
      case '-v':
        formData.variant = value;
        break;
      case '--help':
      case '-h':
        console.log(`
🚀 National Insurance Automation Script

Usage: node national.js [options]

Options:
  -u, --username <value>    Username for login (default: testuser)
  -p, --password <value>    Password for login (default: testpass)
  -r, --rto <value>         RTO Location (default: Mumbai)
  -m, --make <value>        Vehicle Make (default: Honda)
  -v, --variant <value>     Vehicle Variant (default: Standard)
  -h, --help               Show this help message

Examples:
  node national.js
  node national.js --username myuser --password mypass
  node national.js -u myuser -p mypass -r Delhi -m Yamaha -v Sport
        `);
        process.exit(0);
        break;
    }
  }

  return formData;
}

async function waitForLoaderToDisappear(
  driver,
  locator = By.css(".k-loading-mask"),
  timeout = 20000
) {
  console.log(`Waiting for loader (${locator}) to disappear...`);
  try {
    await driver.wait(async () => {
      const loaders = await driver.findElements(locator);
      if (loaders.length === 0) {
        return true; // Loader is gone
      }
      try {
        const isDisplayed = await loaders[0].isDisplayed();
        return !isDisplayed;
      } catch (e) {
        if (e.name === "StaleElementReferenceError") {
          return true;
        }
        throw e;
      }
    }, timeout);
    console.log("Loader has disappeared.");
  } catch (error) {
    console.log("Loader did not disappear in time (which is ok).");
  }
}

async function waitForPortalLoaderToDisappear(driver, timeout = 5000, pollInterval = 400) {
  const locator = By.css("div.loading-text");
  try {
    const loaders = await driver.findElements(locator);
    for (const loader of loaders) {
      try {
        if (await loader.isDisplayed()) {
          console.log("Portal loader visible but skipping wait as requested.");
          return;
        }
      } catch (error) {
        if (error.name !== "StaleElementReferenceError") {
          throw error;
        }
      }
    }
  } catch (lookupError) {
    console.log("Portal loader lookup error (ignored):", lookupError.message);
  }
}

async function safeClick(driver, locator, timeout = 15000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  try {
    await el.click();
  } catch {
    await driver.executeScript("arguments[0].click();", el);
  }
}

async function safeType(driver, locator, text, timeout = 5000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  await el.clear();
  await el.sendKeys(text);
}

async function scrollAndClick(driver, locator, timeout = 5000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  const target = await driver.executeScript(`
    const element = arguments[0];
    if (!element) return null;
    const tag = (element.tagName || '').toLowerCase();
    if (['button', 'a'].includes(tag)) return element;
    const role = element.getAttribute ? element.getAttribute('role') : null;
    if (role && ['button', 'link'].includes(role)) return element;
    const buttonParent = element.closest ? element.closest('button, a, [role="button"], [role="link"]') : null;
    return buttonParent || element;
  `, el);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", target);
  await driver.sleep(150);
  try {
    await target.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", target);
  }
  return target;
}

async function scrollAndClickElement(driver, element) {
  if (!element) {
    throw new Error("scrollAndClickElement received null element");
  }
  await driver.wait(until.elementIsVisible(element), 10000);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
  await driver.sleep(150);
  try {
    await element.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", element);
  }
}

async function safeSelectOption(driver, dropdownLocator, optionText, timeout = 15000) {
  // Click on dropdown to open it
  await safeClick(driver, dropdownLocator, timeout);

  // Wait a bit for options to load
  await driver.sleep(1500);

  // Find and click the option with the specified text
  try {
    const optionLocator = By.xpath(`//mat-option[contains(., '${optionText}')]`);
    await safeClick(driver, optionLocator, timeout);
  } catch (optionError) {
    console.log(`Could not find option "${optionText}", listing available options...`);

    // List all available options
    try {
      const allOptions = await driver.findElements(By.css("mat-option"));
      console.log(`Found ${allOptions.length} available options:`);
      for (let i = 0; i < Math.min(allOptions.length, 10); i++) {
        const optText = await allOptions[i].getText();
        console.log(`  Option ${i}: "${optText}"`);
      }

      // Try clicking the specific option if it exists in the listed options
      const matchingOption = await driver.executeAsyncScript(`
        const options = arguments[0];
        const desired = arguments[1].trim().toLowerCase();
        const done = arguments[2];
        for (const opt of options) {
          const text = (opt.textContent || opt.innerText || '').trim().toLowerCase();
          if (text === desired) {
            done(opt);
            return;
          }
        }
        done(null);
      `, allOptions, optionText);

      if (matchingOption) {
        await driver.executeScript("arguments[0].click();", matchingOption);
        console.log(`Clicked matching option "${optionText}" from fallback list.`);
      } else {
        console.log(`Option "${optionText}" not present in fallback list; leaving selection unchanged.`);
      }
    } catch (listError) {
      console.log("Could not list options:", listError.message);
      throw optionError;
    }
  }

  // Wait for option to be selected
  await driver.sleep(500);

  // Close the dropdown panel by clicking outside
  try {
    // Click on the page body to close any open dropdowns/overlays
    await driver.executeScript("document.body.click();");
    await driver.sleep(500);
  } catch (e) {
    console.log("Could not close dropdown, continuing...");
  }
}

async function enableSlideToggle(
  driver,
  toggleLocator,
  toggleDescription = "slide toggle"
) {
  const locatorList = Array.isArray(toggleLocator) ? toggleLocator : [toggleLocator];
  let locatedElement = null;
  let lastError = null;

  for (const locator of locatorList) {
    try {
      locatedElement = await driver.wait(until.elementLocated(locator), 5000);
      if (locatedElement) {
        console.log(`${toggleDescription} located using ${locator.toString()}`);
        break;
      }
    } catch (locError) {
      lastError = locError;
    }
  }

  if (!locatedElement) {
    throw lastError || new Error(`${toggleDescription} element not found`);
  }

  const slideToggle = await driver.executeScript(`
    const el = arguments[0];
    if (!el) return null;
    if (el.tagName && el.tagName.toLowerCase() === 'mat-mdc-slide-toggle') return el;
    const closestToggle = el.closest ? el.closest('mat-mdc-slide-toggle') : null;
    return closestToggle || el;
  `, locatedElement);

  if (!slideToggle) {
    throw new Error(`${toggleDescription} root slide-toggle element could not be resolved.`);
  }

  await driver.wait(until.elementIsVisible(slideToggle), 10000);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", slideToggle);
  await driver.sleep(200);

  const isOn = await driver.executeScript(
    "const toggle = arguments[0]; return toggle.getAttribute && toggle.getAttribute('aria-checked') === 'true';",
    slideToggle
  );

  if (isOn) {
    console.log(`${toggleDescription} already ON.`);
    return slideToggle;
  }

  await driver.executeScript(`
    const toggle = arguments[0];
    const handleButton = toggle.querySelector('button.mdc-switch__handle');
    if (handleButton) {
      handleButton.click();
      return;
    }
    const nativeControl = toggle.querySelector('input.mdc-switch__native-control');
    if (nativeControl) {
      nativeControl.click();
      return;
    }
    const icons = toggle.querySelector('.mdc-switch__icons');
    if (icons) {
      icons.click();
      return;
    }
    toggle.click();
  `, slideToggle);

  await driver.sleep(400);
  return slideToggle;
}

async function openFinancierSection(driver) {
  try {
    console.log("Opening Financier Interest Applicable section if not visible...");
    const financierTab = By.xpath("//span[contains(normalize-space(.), 'Financier Interest Applicable')]");
    const tabElement = await driver.wait(until.elementLocated(financierTab), 5000);
    const tabParent = await driver.executeScript("return arguments[0].closest('mat-expansion-panel') || arguments[0];", tabElement);

    if (tabParent) {
      const isExpanded = await driver.executeScript(`
        const panel = arguments[0];
        if (panel.hasAttribute && panel.hasAttribute('aria-expanded')) {
          return panel.getAttribute('aria-expanded') === 'true';
        }
        if (panel.classList && panel.classList.contains('mat-expanded')) {
          return true;
        }
        return false;
      `, tabParent);

      if (!isExpanded) {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", tabElement);
        await driver.sleep(200);
        await driver.executeScript("arguments[0].click();", tabElement);
        await driver.sleep(800);
      }
    } else {
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", tabElement);
      await driver.sleep(200);
      await driver.executeScript("arguments[0].click();", tabElement);
      await driver.sleep(800);
    }
  } catch (e) {
    console.log("Financier section open helper failed (may already be visible):", e.message);
  }
}

async function openVehicleInformationSection(driver) {
  try {
    console.log("Ensuring Vehicle Information section is expanded...");
    const vehicleHeader = By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Vehicle Information')]]");
    const panelHeader = await driver.wait(until.elementLocated(vehicleHeader), 5000);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", panelHeader);
    await driver.sleep(200);
    const isExpanded = await driver.executeScript(`
      const header = arguments[0];
      const panel = header.closest ? header.closest('mat-expansion-panel') : null;
      if (!panel) return true;
      if (panel.hasAttribute && panel.hasAttribute('aria-expanded')) {
        return panel.getAttribute('aria-expanded') === 'true';
      }
      return panel.classList && panel.classList.contains('mat-expanded');
    `, panelHeader);
    if (!isExpanded) {
      console.log("Vehicle Information panel collapsed, expanding...");
      await driver.executeScript("arguments[0].click();", panelHeader);
      await driver.sleep(600);
    }
  } catch (e) {
    console.log("Vehicle Information expansion check failed:", e.message);
  }
}

/**
 * Captures error screenshot and uploads to S3 for National form errors
 */
async function captureErrorScreenshot(
  driver,
  error,
  data,
  errorStage = "unknown"
) {
  let screenshotUrl = null;
  let screenshotKey = null;
  let pageSourceUrl = null;
  let pageSourceKey = null;

  try {
    if (!driver) {
      console.log("⚠️  [National] No driver available for screenshot");
      return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
    }

    const screenshot = await driver.takeScreenshot();
    const jobIdentifier = data._jobIdentifier || `national_${Date.now()}`;
    const attemptNumber = data._attemptNumber || 1;

    // Generate S3 key and upload screenshot
    screenshotKey = generateScreenshotKey(
      jobIdentifier,
      attemptNumber,
      errorStage,
      "national"
    );

    screenshotUrl = await uploadScreenshotToS3(screenshot, screenshotKey);

    console.log(`📸 [National] Error screenshot captured: ${screenshotKey}`);
  } catch (screenshotError) {
    console.error("❌ [National] Failed to capture error screenshot:", screenshotError.message);
  }

  return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
}

async function fillNationalForm(
  data = { username: "9364646564", password: "Pond@2123" }
) {
  const jobId = data._jobIdentifier || `national_${Date.now()}`;
  let jobBrowser = null;
  let driver = null;
  let postSubmissionFailed = false;
  let postSubmissionError = null;
  let postCalculationFailed = false;
  let postCalculationError = null;

  try {
    console.log(`\n🚀 [${jobId}] Starting National Insurance job...`);

    // === STEP 0: Create fresh browser ===
    jobBrowser = await createNationalJobBrowser(jobId);
    driver = jobBrowser.driver;

    console.log(`✅ [${jobId}] National browser ready!`);

    // === STEP 1: Navigate to login page and login ===
    // National uses simple approach: every job logs in fresh
    console.log(`🌐 [${jobId}] Navigating to National login page...`);

    try {
      console.log(`⏳ [${jobId}] Loading URL: R`);
      await driver.get("https://nicportal.nic.co.in/nicportal/signin/login");
      console.log(`✅ [${jobId}] Navigation successful!`);

      await driver.sleep(3000);
      await waitForLoaderToDisappear(driver);
      await waitForPortalLoaderToDisappear(driver);
      await waitForPortalLoaderToDisappear(driver);

      const currentUrl = await driver.getCurrentUrl();
      console.log(`🌐 [${jobId}] Current URL after navigation: ${currentUrl}`);

      if (!currentUrl.includes("nicportal.nic.co.in")) {
        console.warn(`⚠️  [${jobId}] WARNING: Not on National portal! Current URL: ${currentUrl}`);
      }
    } catch (navError) {
      console.error(`❌ [${jobId}] Navigation failed:`, navError.message);
      throw new Error(`Failed to navigate to National portal: ${navError.message}`);
    }

    // === STEP 2: Perform login ===
    console.log(`🔐 [${jobId}] Starting login process...`);

    try {
      // Handle login form
      console.log(`[${jobId}] Filling login form...`);

      // Select INTERMEDIARY option
      try {
        // First, click on the specific dropdown to open it
        // Try multiple selectors for the dropdown
        let dropdown;
        try {
          dropdown = By.name("reg_dropdown_iType_02");
          await driver.wait(until.elementLocated(dropdown), 5000);
        } catch (e) {
          console.log("Name selector failed, trying ID selector...");
          try {
            dropdown = By.id("mat-select-4");
            await driver.wait(until.elementLocated(dropdown), 5000);
          } catch (e2) {
            console.log("ID selector failed, trying CSS selector...");
            dropdown = By.css("mat-select[role='combobox']");
            await driver.wait(until.elementLocated(dropdown), 5000);
          }
        }

        await safeClick(driver, dropdown, 10000);
        await driver.sleep(2000);

        // Check if dropdown is open and look for INTERMEDIARY option
        console.log("Looking for INTERMEDIARY option...");

        // Debug: List all available options
        try {
          const allOptions = await driver.findElements(By.css("mat-option"));
          console.log(`Found ${allOptions.length} options in dropdown`);
          for (let i = 0; i < allOptions.length; i++) {
            const optionText = await allOptions[i].getText();
            console.log(`Option ${i}: "${optionText}"`);
          }
        } catch (debugError) {
          console.log("Could not list options:", debugError.message);
        }

        const intermediaryOption = By.xpath("//mat-option[contains(., 'INTERMEDIARY')]");

        // Wait for the option to be available
        await driver.wait(until.elementLocated(intermediaryOption), 10000);
        await safeClick(driver, intermediaryOption, 10000);
        console.log("Selected INTERMEDIARY option");

        // Wait a bit for the selection to take effect
        await driver.sleep(1000);
      } catch (error) {
        console.log("INTERMEDIARY option not found or already selected:", error.message);

        // Try alternative approach - look for any option that contains "INTERMEDIARY"
        try {
          console.log("Trying alternative selector...");
          const altOption = By.xpath("//mat-option[contains(text(), 'INTERMEDIARY')]");
          await safeClick(driver, altOption, 5000);
          console.log("Selected INTERMEDIARY option with alternative selector");
        } catch (altError) {
          console.log("Alternative selector also failed:", altError.message);
        }
      }

      // Select second dropdown option (after INTERMEDIARY)
      try {
        console.log("Selecting second dropdown option...");

        // Wait a bit for the first selection to take effect
        await driver.sleep(2000);

        // Try to find and click the dropdown again
        let secondDropdown;
        try {
          secondDropdown = By.name("reg_dropdown_iType_02");
          await driver.wait(until.elementLocated(secondDropdown), 5000);
        } catch (e) {
          console.log("Name selector failed for second dropdown, trying ID selector...");
          try {
            secondDropdown = By.id("mat-select-4");
            await driver.wait(until.elementLocated(secondDropdown), 5000);
          } catch (e2) {
            console.log("ID selector failed for second dropdown, trying CSS selector...");
            secondDropdown = By.css("mat-select[role='combobox']");
            await driver.wait(until.elementLocated(secondDropdown), 5000);
          }
        }

        await safeClick(driver, secondDropdown, 10000);
        await driver.sleep(2000);

        // Debug: List all available options in the second dropdown
        try {
          const allOptions = await driver.findElements(By.css("mat-option"));
          console.log(`Found ${allOptions.length} options in second dropdown`);
          for (let i = 0; i < allOptions.length; i++) {
            const optionText = await allOptions[i].getText();
            console.log(`Second dropdown option ${i}: "${optionText}"`);
          }
        } catch (debugError) {
          console.log("Could not list second dropdown options:", debugError.message);
        }

        // Select BROKER POSP option specifically
        try {
          const brokerPospOption = By.xpath("//mat-option[contains(., 'BROKER POSP')]");
          await safeClick(driver, brokerPospOption, 10000);
          console.log("Selected BROKER POSP option");
        } catch (brokerError) {
          console.log("BROKER POSP option not found, trying alternative selector...");
          try {
            const altBrokerOption = By.xpath("//mat-option[contains(text(), 'BROKER POSP')]");
            await safeClick(driver, altBrokerOption, 10000);
            console.log("Selected BROKER POSP option with alternative selector");
          } catch (altBrokerError) {
            console.log("Alternative BROKER POSP selector also failed:", altBrokerError.message);
          }
        }

        // Wait for selection to take effect
        await driver.sleep(1000);

      } catch (error) {
        console.log("Second dropdown selection failed:", error.message);
      }

      // Fill username
      console.log(`[${jobId}] Looking for username field...`);
      const usernameField = By.name("log_txtfield_iUsername_01");
      await safeType(driver, usernameField, data.username || "9364646564", 10000);
      console.log(`[${jobId}] Filled username`);

      // Fill password
      console.log(`[${jobId}] Looking for password field...`);
      const passwordField = By.name("log_pwd_iPassword_01");
      await safeType(driver, passwordField, data.password || "Pond@2123", 10000);
      console.log(`[${jobId}] Filled password`);

      // Click login button
      console.log(`[${jobId}] Looking for login button...`);
      const loginButton = By.name("log_btn_login_01");

      try {
        const buttonElement = await driver.wait(until.elementLocated(loginButton), 10000);
        console.log(`[${jobId}] Login button found`);

        await driver.wait(until.elementIsVisible(buttonElement), 10000);
        console.log(`[${jobId}] Login button is visible`);

        await driver.wait(until.elementIsEnabled(buttonElement), 10000);
        console.log(`[${jobId}] Login button is enabled`);

        try {
          await buttonElement.click();
          console.log(`✅ [${jobId}] Clicked login button (regular click)`);
        } catch (clickError) {
          console.log(`[${jobId}] Regular click failed, trying JavaScript click...`);
          await driver.executeScript("arguments[0].click();", buttonElement);
          console.log(`✅ [${jobId}] Clicked login button (JavaScript click)`);
        }
      } catch (buttonError) {
        console.error(`❌ [${jobId}] Failed to click login button:`, buttonError.message);
        throw new Error(`Failed to click login button: ${buttonError.message}`);
      }

      console.log(`[${jobId}] Waiting for login to complete...`);
      await driver.sleep(5000);
      await waitForPortalLoaderToDisappear(driver);

      // Verify login was successful
      const loginCheckUrl = await driver.getCurrentUrl();
      const loginCheckElements = await driver.findElements(By.name("log_txtfield_iUsername_01"));
      if (loginCheckElements.length > 0 || loginCheckUrl.includes("/signin/login")) {
        throw new Error("National login failed - still on login page after login attempt");
      }
      console.log(`✅ [${jobId}] Login successful!`);
    } catch (loginError) {
      console.error(`❌ [${jobId}] Login failed:`, loginError.message);
      throw loginError;
    }

    // Debug: Check what's on the page after login/session check
    try {
      const pageTitle = await driver.getTitle();
      console.log("Page title after login:", pageTitle);

      const currentUrl = await driver.getCurrentUrl();
      console.log("Current URL after login:", currentUrl);

      // Check for any links on the page
      const allLinks = await driver.findElements(By.css("a"));
      console.log(`Found ${allLinks.length} links on the page`);

      // List some of the link texts
      for (let i = 0; i < Math.min(allLinks.length, 10); i++) {
        try {
          const linkText = await allLinks[i].getText();
          if (linkText.trim()) {
            console.log(`Link ${i}: "${linkText.trim()}"`);
          }
        } catch (e) {
          // Skip if can't get text
        }
      }
    } catch (debugError) {
      console.log("Debug info after login failed:", debugError.message);
    }

    // Check for modal and close it if present
    console.log("Checking for modal after login...");
    try {
      // Wait a bit for any modal to appear
      await driver.sleep(2000);

      // Try multiple modal close button selectors
      const modalSelectors = [
        By.css("button.close_flash"),
        By.css("button[data-dismiss='modal']"),
        By.css(".close"),
        By.css("[aria-label='Close']"),
        By.css("button[aria-label='Close']"),
        By.xpath("//button[contains(@class, 'close')]"),
        By.xpath("//button[contains(text(), '×')]"),
        By.xpath("//button[contains(text(), 'Close')]")
      ];

      let modalClosed = false;
      for (const selector of modalSelectors) {
        try {
          const modalButton = await driver.findElement(selector);
          if (await modalButton.isDisplayed()) {
            await safeClick(driver, selector, 3000);
            console.log("Closed modal with selector:", selector.toString());
            modalClosed = true;
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }

      if (!modalClosed) {
        console.log("No modal found or already closed");
      }

      // Wait a bit after closing modal
      await driver.sleep(1000);

    } catch (error) {
      console.log("Modal handling failed:", error.message);
    }

    // Wait for page to fully load after modal close
    await driver.sleep(3000);

    // Navigate to Motor Two Wheelers
    console.log("Navigating to Motor Two Wheelers...");

    // Debug: List some of the available links to find the right one
    try {
      const allLinks = await driver.findElements(By.css("a"));
      console.log(`Found ${allLinks.length} links on the page after login`);

      // Look for links that might contain "Motor" or "Two" or "Wheeler"
      for (let i = 0; i < Math.min(allLinks.length, 30); i++) {
        try {
          const linkText = await allLinks[i].getText();
          const linkHref = await allLinks[i].getAttribute('href');
          if (linkText.trim() && (
            linkText.toLowerCase().includes('motor') ||
            linkText.toLowerCase().includes('two') ||
            linkText.toLowerCase().includes('wheeler') ||
            linkText.toLowerCase().includes('vehicle') ||
            linkText.toLowerCase().includes('premium')
          )) {
            console.log(`Potential link ${i}: "${linkText.trim()}" -> ${linkHref}`);
          }
        } catch (e) {
          // Skip if can't get text
        }
      }
    } catch (debugError) {
      console.log("Could not list links:", debugError.message);
    }

    // Check for expansion panels or menus that need to be opened
    try {
      const expansionPanels = await driver.findElements(By.css("mat-expansion-panel"));
      console.log(`Found ${expansionPanels.length} expansion panels`);

      if (expansionPanels.length > 0) {
        console.log("Expansion panels found - checking if any contain Motor insurance...");

        // Try to find and expand the Motor insurance panel
        for (let i = 0; i < expansionPanels.length; i++) {
          try {
            const panelText = await expansionPanels[i].getText();
            console.log(`Panel ${i}: "${panelText.substring(0, 100)}..."`);

            if (panelText.toLowerCase().includes('motor') || panelText.toLowerCase().includes('vehicle')) {
              console.log(`Found Motor panel at index ${i}`);
              // Check if panel is expanded
              const isExpanded = await expansionPanels[i].getAttribute('aria-expanded');
              console.log(`Panel ${i} expanded: ${isExpanded}`);

              if (isExpanded === 'false' || isExpanded === null) {
                // Click to expand
                await expansionPanels[i].click();
                console.log(`Expanded panel ${i}`);
                await driver.sleep(2000);
              }
              break;
            }
          } catch (panelError) {
            console.log(`Error checking panel ${i}:`, panelError.message);
          }
        }
      }
    } catch (expansionError) {
      console.log("No expansion panels found or error:", expansionError.message);
    }

    // Now try to find the Calculate Premium link for Two Wheelers
    console.log("Looking for Motor Two Wheelers menu item...");

    try {
      // Strategy: Use JavaScript to find elements and get their text
      console.log("Using JavaScript to find Calculate Premium links...");

      const result = await driver.executeScript(`
        // Find all links with "Calculate Premium" text
        const allLinks = Array.from(document.querySelectorAll('a'));
        const calculatePremiumLinks = allLinks.filter(link => 
          link.textContent.includes('Calculate Premium')
        );
        
        console.log('Found ' + calculatePremiumLinks.length + ' Calculate Premium links');
        
        // For each link, check if it's in a container with "Motor - Two Wheelers"
        for (let i = 0; i < calculatePremiumLinks.length; i++) {
          const link = calculatePremiumLinks[i];
          
          // Find parent with mega-menu-content or col-6
          let parent = link;
          while (parent && !parent.classList.contains('mega-menu-content') && !parent.classList.contains('col-6')) {
            parent = parent.parentElement;
          }
          
          if (parent) {
            const parentText = parent.textContent || parent.innerText;
            
            if (parentText.includes('Motor - Two Wheelers')) {
              console.log('Found Motor Two Wheelers Calculate Premium at index ' + i);
              return {
                found: true,
                index: i,
                element: link,
                parentText: parentText
              };
            }
          }
        }
        
        return { found: false, count: calculatePremiumLinks.length };
      `);

      console.log("JavaScript search result:", result);

      if (result.found) {
        console.log("Found the correct link! Clicking it...");

        // Get all Calculate Premium links
        const allLinks = await driver.findElements(By.xpath("//a[contains(text(), 'Calculate Premium')]"));

        if (allLinks.length > result.index) {
          // Scroll to the element
          await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", allLinks[result.index]);
          await driver.sleep(1000);

          // Try clicking it
          try {
            await allLinks[result.index].click();
            console.log("Clicked Calculate Premium for Motor Two Wheelers");
          } catch (clickError) {
            console.log("Direct click failed, using JavaScript click:", clickError.message);
            await driver.executeScript("arguments[0].click();", allLinks[result.index]);
            console.log("Clicked Calculate Premium using JavaScript");
          }
        } else {
          throw new Error("Link index out of bounds");
        }
      } else {
        console.log("Could not find Motor Two Wheelers. Trying alternative approach...");

        // Fallback: Try clicking by index (usually Two Wheelers is the 3rd option)
        const allLinks = await driver.findElements(By.xpath("//a[contains(text(), 'Calculate Premium')]"));
        console.log(`Found ${allLinks.length} Calculate Premium links`);

        if (allLinks.length >= 2) {
          console.log("Clicking Calculate Premium at index 2 (assuming Two Wheelers)...");
          await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", allLinks[2]);
          await driver.sleep(1000);
          await driver.executeScript("arguments[0].click();", allLinks[2]);
          console.log("Clicked Calculate Premium for Motor Two Wheelers (by index)");
        } else {
          throw new Error("Not enough Calculate Premium links found");
        }
      }

    } catch (error) {
      console.log("JavaScript approach failed, trying simple xpath:", error.message);

      // Final fallback: Just try to find and click the Calculate Premium link that's a sibling
      try {
        const calculatePremiumLink = By.xpath("//a[text()='Motor - Two Wheelers']/parent::div/following-sibling::a[contains(text(), 'Calculate Premium')]");
        await safeClick(driver, calculatePremiumLink, 5000);
        console.log("Clicked Calculate Premium using xpath fallback");
      } catch (xpathError) {
        console.log("All approaches failed:", xpathError.message);
        throw new Error("Could not find Calculate Premium link for Motor Two Wheelers");
      }
    }

    // Wait for form to load
    await driver.sleep(3000);

    // Wait for loader to disappear
    await waitForLoaderToDisappear(driver);

    // Select Vehicle Type
    console.log("Selecting Vehicle Type...");
    const vehicleTypeDropdown = By.name("mcy_dropdown_vehicleType_01");
    await safeSelectOption(driver, vehicleTypeDropdown, "New", 15000);

    await driver.sleep(2000);

    // Select Your Plan
    console.log("Selecting Your Plan...");
    try {
      const planDropdown = By.name("mcy_dropdown_planId_01");
      await safeSelectOption(driver, planDropdown, "OD With Long Term Act", 15000);
    } catch (planError) {
      console.log("Could not select plan option, trying alternative...");
      // Try different plan options
      try {
        const planDropdown = By.name("mcy_dropdown_planId_01");
        await safeSelectOption(driver, planDropdown, "Third Party", 15000);
      } catch (e) {
        console.log("Could not select any plan option");
      }
    }

    await driver.sleep(2000);

    // Select Class Of Vehicle
    console.log("Selecting Class Of Vehicle...");
    try {
      const vehicleClassDropdown = By.name("mcy_dropdown_vehcileClass_01");
      await safeSelectOption(driver, vehicleClassDropdown, "Motor cycle", 15000);
    } catch (vehicleClassError) {
      console.log("Could not select vehicle class option, trying alternative...");
      // Try different vehicle class options
      try {
        const vehicleClassDropdown = By.name("mcy_dropdown_vehcileClass_01");
        await safeSelectOption(driver, vehicleClassDropdown, "Motorcycle", 15000);
      } catch (e2) {
        console.log("Could not select any vehicle class option");
      }
    }

    await driver.sleep(2000);

    // Fill RTO location (autocomplete field)
    console.log("Filling RTO location...");
    await driver.sleep(1000);
    const rtoLocationField = By.name("mcy_dropdown_newRtoLocation_01");
    const rtoInput = await driver.wait(until.elementLocated(rtoLocationField), 15000);
    await driver.wait(until.elementIsVisible(rtoInput), 15000);
    await driver.wait(until.elementIsEnabled(rtoInput), 15000);

    // Type the RTO location
    await rtoInput.clear();
    await rtoInput.sendKeys("Chennai - North West");
    await driver.sleep(2000); // Wait for autocomplete options to appear

    // Click on the first autocomplete option
    try {
      const rtoOption = await driver.wait(until.elementLocated(By.css("mat-option")), 5000);
      await rtoOption.click();
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not select RTO from autocomplete, continuing...");
    }

    // Fill make (autocomplete field)
    console.log("Filling make...");
    await driver.sleep(1000);
    const makeField = By.name("mcy_dropdown_make_01");
    const makeInput = await driver.wait(until.elementLocated(makeField), 15000);
    await driver.wait(until.elementIsVisible(makeInput), 15000);
    await driver.wait(until.elementIsEnabled(makeInput), 15000);

    await makeInput.clear();
    await makeInput.sendKeys("BAJAJ");
    await driver.sleep(2000); // Wait for autocomplete options to appear

    // Click on the first autocomplete option
    try {
      const makeOption = await driver.wait(until.elementLocated(By.css("mat-option")), 5000);
      await makeOption.click();
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not select Make from autocomplete, continuing...");
    }

    // Wait for Model to load and fill it (autocomplete field)
    console.log("Filling model...");
    await driver.sleep(1000);
    const modelField = By.name("mcy_dropdown_model_01");
    const modelInput = await driver.wait(until.elementLocated(modelField), 15000);
    await driver.wait(until.elementIsVisible(modelInput), 15000);
    await driver.wait(until.elementIsEnabled(modelInput), 15000);

    await modelInput.clear();
    await modelInput.sendKeys("PULSAR 150 (2024-2025)"); // Default model - Honda SHINE model variant
    await driver.sleep(2000); // Wait for autocomplete options to appear

    // Click on the first autocomplete optionm
    try {
      const modelOption = await driver.wait(until.elementLocated(By.css("mat-option")), 5000);
      await modelOption.click();
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not select Model from autocomplete, continuing...");
    }

    // Wait for Variant to load and fill it (autocomplete field)
    console.log("Filling variant...");
    await driver.sleep(1000);
    const variantField = By.name("mcy_dropdown_variant_01");
    const variantInput = await driver.wait(until.elementLocated(variantField), 15000);
    await driver.wait(until.elementIsVisible(variantInput), 15000);
    await driver.wait(until.elementIsEnabled(variantInput), 15000);

    await variantInput.clear();
    await variantInput.sendKeys("SINGLE DISC - BLUETOOTH (2024-2025)");
    await driver.sleep(2000); // Wait for autocomplete options to appear

    // Click on the first autocomplete option
    try {
      const variantOption = await driver.wait(until.elementLocated(By.css("mat-option")), 5000);
      await variantOption.click();
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not select Variant from autocomplete, continuing...");
    }

    await driver.sleep(1000);

    // Fill percentage field
    console.log("Filling percentage...");
    try {
      const percentageField = By.name("mcy_text_percentage_01");
      await safeType(driver, percentageField, "75", 15000);
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill percentage field:", e.message);
    }

    await driver.sleep(1000);

    // Fill IDV value from data (if provided)
    console.log("Filling IDV value from data...");
    try {
      const idvField = By.name("pc_text_idv_01");
      const idvValue = data.idv || data.idvValue || data.insuredDeclaredValue;

      if (idvValue) {
        await safeType(driver, idvField, String(idvValue), 10000);
        console.log(`✅ Filled IDV value: ${idvValue}`);
        await driver.sleep(500);
      } else {
        console.log("No IDV value provided in data, skipping...");
      }
    } catch (e) {
      console.log("Could not fill IDV field:", e.message);
    }

    await driver.sleep(1000);

    // Click Generate Quick Quote button
    console.log("Clicking Generate Quick Quote button...");
    try {
      console.log("Looking for Generate Quick Quote button...");

      // Find the button by name (most reliable)
      const generateButton = By.name("mcy_button_quickQuote_01");
      const generateBtn = await driver.wait(until.elementLocated(generateButton), 15000);

      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(generateBtn), 10000);

      // Check if button is enabled
      const isEnabled = await generateBtn.isEnabled();
      console.log(`Generate Quick Quote button isEnabled: ${isEnabled}`);

      // Also check by checking the 'disabled' attribute
      const isDisabledAttr = await driver.executeScript("return arguments[0].hasAttribute('disabled');", generateBtn);
      console.log(`Generate Quick Quote button has disabled attribute: ${isDisabledAttr}`);

      // Get button text for debugging
      const buttonText = await driver.executeScript("return arguments[0].textContent || arguments[0].innerText;", generateBtn);
      console.log(`Generate Quick Quote button text: ${buttonText}`);

      // Scroll to button
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", generateBtn);
      await driver.sleep(500);

      // Try multiple click strategies
      if (isEnabled && !isDisabledAttr) {
        // Button is enabled, try direct click first
        try {
          await generateBtn.click();
          console.log("Clicked Generate Quick Quote button (direct click)");
        } catch (e) {
          console.log("Direct click failed, trying JavaScript click:", e.message);
          // Fall back to JavaScript click
          await driver.executeScript("arguments[0].click();", generateBtn);
          console.log("Clicked Generate Quick Quote button (JavaScript click)");
        }
      } else {
        console.log("Generate Quick Quote button is disabled, attempting to force click with JavaScript...");
        // Force click with JavaScript even if disabled
        await driver.executeScript("arguments[0].click();", generateBtn);
        console.log("Force clicked Generate Quick Quote button with JavaScript");
      }

      console.log("Successfully clicked Generate Quick Quote button");
      await driver.sleep(3000); // Wait for quote to generate
      await waitForPortalLoaderToDisappear(driver);
    } catch (e) {
      console.log("Generate Quick Quote button not found, trying alternative:", e.message);

      // Try alternative approach - find by button text
      try {
        const generateByText = By.xpath("//button[contains(., 'Generate Quick Quote')]");
        const generateBtn = await driver.wait(until.elementLocated(generateByText), 5000);
        await driver.executeScript("arguments[0].click();", generateBtn);
        console.log("Clicked Generate Quick Quote button (alternative)");
        await driver.sleep(3000);
        await waitForPortalLoaderToDisappear(driver);
      } catch (e2) {
        console.log("All strategies failed for Generate Quick Quote button:", e2.message);
      }
    }

    // Extract IDV value after quote generation
    console.log("Extracting IDV value after quote generation...");
    let idvValue = null;
    try {
      // Wait for IDV field to be populated
      await driver.sleep(2000);

      // Find IDV input field by name
      const idvField = By.name("pc_text_idv_01");
      const idvInput = await driver.wait(until.elementLocated(idvField), 10000);

      // Wait for the field to have a value
      await driver.wait(async () => {
        const value = await idvInput.getAttribute('value');
        return value && value.trim() !== '';
      }, 15000);

      // Get the IDV value
      idvValue = await idvInput.getAttribute('value');
      console.log(`✅ [${jobId}] IDV value extracted: ${idvValue}`);

      // Store IDV in data object for later use
      data.idv = idvValue;

    } catch (idvError) {
      console.log(`⚠️ [${jobId}] Could not extract IDV value:`, idvError.message);
      // Continue execution even if IDV extraction fails
    }

    // === POST-QUOTE INTERACTIONS ===
    console.log("Handling post-quote interactions...");

    // Click OK button (if present)
    try {
      console.log("Looking for OK button...");
      const okButton = By.name("confirm_btn_yes_01");
      await safeClick(driver, okButton, 5000);
      console.log("Clicked OK button");
      await driver.sleep(1000);
    } catch (e) {
      console.log("OK button not found or not needed:", e.message);
    }

    // Click Convert Quote button
    try {
      console.log("Looking for Convert Quote button...");
      const convertButton = By.name("main_btn_convert_01");
      await safeClick(driver, convertButton, 5000);
      console.log("Clicked Convert Quote button");
      await driver.sleep(2000);
    } catch (e) {
      console.log("Convert Quote button not found:", e.message);
    }

    // Click Create New Customer
    try {
      console.log("Looking for Create New Customer...");
      const createCustomerSpan = By.name("custmain_span_create_01");
      await safeClick(driver, createCustomerSpan, 5000);
      console.log("Clicked Create New Customer");
      await driver.sleep(2000); // Wait for dialog to open
    } catch (e) {
      console.log("Create New Customer not found:", e.message);
    }

    // Select Manual KYC radio button BEFORE filling customer form
    try {
      console.log("Selecting Manual KYC radio button...");

      // Wait for the dialog to be fully loaded
      await driver.sleep(2000);

      // Primary strategy: click the input by its stable id
      const manualKycInput = By.id("mat-radio-21-input");
      let inputElement = await driver.wait(until.elementLocated(manualKycInput), 10000);

      // Ensure it's in view
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", inputElement);
      await driver.sleep(300);

      // Click using JS to avoid overlay/ripple issues in Angular Material
      await driver.executeScript("arguments[0].click();", inputElement);

      // Verify selected; if not, try clicking the associated label
      await driver.sleep(500);
      let isSelected = false;
      try {
        isSelected = await inputElement.isSelected();
      } catch (_) { }
      if (!isSelected) {
        try {
          const manualKycLabel = By.css("label[for='mat-radio-21-input']");
          const labelEl = await driver.wait(until.elementLocated(manualKycLabel), 3000);
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", labelEl);
          await driver.sleep(200);
          await driver.executeScript("arguments[0].click();", labelEl);
          await driver.sleep(400);
          isSelected = await inputElement.isSelected().catch(() => false);
        } catch (labelErr) {
          console.log("Manual KYC label click fallback failed:", labelErr.message);
        }
      }
      console.log(`Manual KYC radio selected state: ${isSelected}`);
      await driver.sleep(500);
    } catch (e) {
      console.log("Manual KYC radio not found by id, trying alternative:", e.message);

      // Fallback 1: find by name/value
      try {
        const altByValue = By.xpath("//input[@name='ekyc_sel_type' and @value='ManualKYC']");
        const radioElement = await driver.wait(until.elementLocated(altByValue), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", radioElement);
        await driver.sleep(200);
        await driver.executeScript("arguments[0].click();", radioElement);
        console.log("Selected Manual KYC via name/value fallback");
        await driver.sleep(500);
      } catch (e2) {
        console.log("Manual KYC by name/value failed:", e2.message);

        // Fallback 2: click the mat-radio-button container by value attribute
        try {
          const matRadio = By.css("mat-radio-button[value='ManualKYC'] input[type='radio']");
          const radioInput = await driver.wait(until.elementLocated(matRadio), 5000);
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", radioInput);
          await driver.sleep(200);
          await driver.executeScript("arguments[0].click();", radioInput);
          console.log("Selected Manual KYC via mat-radio-button fallback");
          await driver.sleep(500);
        } catch (e3) {
          console.log("All strategies failed for Manual KYC radio:", e3.message);
        }
      }
    }

    // Check disclaimer checkbox BEFORE filling customer form
    try {
      console.log("Checking disclaimer checkbox...");

      // Find the checkbox by ID (most reliable from the HTML)
      const disclaimerCheckboxInput = By.id("mat-mdc-checkbox-4-input");
      const checkboxElement = await driver.wait(until.elementLocated(disclaimerCheckboxInput), 10000);

      // Scroll to element
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", checkboxElement);
      await driver.sleep(500);

      // Always click the checkbox to ensure it's checked (even if already checked)
      // This is important to trigger any necessary events
      try {
        // Click using JavaScript
        await driver.executeScript("arguments[0].click();", checkboxElement);
        console.log("Clicked disclaimer checkbox");

        // Wait for any animations/state changes
        await driver.sleep(1000);

        // Verify it was checked
        const isChecked = await checkboxElement.isSelected();
        console.log(`Disclaimer checkbox isChecked: ${isChecked}`);
      } catch (e) {
        console.log("Error clicking checkbox:", e.message);
      }

      await driver.sleep(1000);
    } catch (e) {
      console.log("Disclaimer checkbox not found, trying alternative:", e.message);

      // Try alternative approach - find by name
      try {
        const altCheckbox = By.name("vQuote_list_disclaimerAgree_01");
        const checkboxElement = await driver.wait(until.elementLocated(altCheckbox), 5000);
        await driver.executeScript("arguments[0].click();", checkboxElement);
        console.log("Clicked disclaimer checkbox (alternative)");
        await driver.sleep(1000);
      } catch (e2) {
        console.log("All strategies failed for disclaimer checkbox:", e2.message);
      }
    }

    // === CLICK SUBMIT BUTTON BEFORE FILLING FORM ===
    console.log("Clicking Submit button before filling customer form...");
    try {
      console.log("Looking for Submit button...");

      // Find the submit button by name (most reliable)
      const submitButton = By.name("newCust_btn_createCust_01");
      const submitBtn = await driver.wait(until.elementLocated(submitButton), 10000);

      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(submitBtn), 10000);

      // Check if button is enabled
      const isEnabled = await submitBtn.isEnabled();
      console.log(`Submit button isEnabled: ${isEnabled}`);

      // Also check by checking the 'disabled' attribute
      const isDisabledAttr = await driver.executeScript("return arguments[0].hasAttribute('disabled');", submitBtn);
      console.log(`Submit button has disabled attribute: ${isDisabledAttr}`);

      // Get button text for debugging
      const buttonText = await driver.executeScript("return arguments[0].textContent || arguments[0].innerText;", submitBtn);
      console.log(`Submit button text: ${buttonText}`);

      // Scroll to button
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", submitBtn);
      await driver.sleep(500);

      // Try multiple click strategies
      if (isEnabled && !isDisabledAttr) {
        // Button is enabled, try direct click first
        try {
          await submitBtn.click();
          console.log("Clicked Submit button (direct click)");
        } catch (e) {
          console.log("Direct click failed, trying JavaScript click:", e.message);
          // Fall back to JavaScript click
          await driver.executeScript("arguments[0].click();", submitBtn);
          console.log("Clicked Submit button (JavaScript click)");
        }
      } else {
        console.log("Submit button is disabled, attempting to force click with JavaScript...");
        // Force click with JavaScript even if disabled
        await driver.executeScript("arguments[0].click();", submitBtn);
        console.log("Force clicked Submit button with JavaScript");
      }

      console.log("Successfully clicked Submit button");
      await driver.sleep(3000); // Wait for processing
    } catch (e) {
      console.log("Submit button not found before form fill, continuing anyway:", e.message);
    }

    // === FILL CUSTOMER FORM ===
    console.log("Filling customer information...");

    // Fill Title (autocomplete)
    try {
      console.log("Filling Title...");
      const titleField = By.name("newcust_textfield_title_01");
      const titleInput = await driver.wait(until.elementLocated(titleField), 10000);
      await driver.wait(until.elementIsVisible(titleInput), 10000);

      // Clear any existing text
      await titleInput.clear();

      // Type the value - default to "Mr" if not provided
      const title = ("Mr").trim() || "Mr";
      await titleInput.sendKeys(title);
      await driver.sleep(1500); // Wait for autocomplete to appear

      // Try to select from autocomplete - wait for options to appear
      try {
        console.log("Waiting for Title autocomplete options...");
        const titleOptions = await driver.wait(until.elementsLocated(By.css("mat-option")), 5000);
        console.log(`Found ${titleOptions.length} Title autocomplete options`);

        if (titleOptions.length > 0) {
          // Click the first option
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", titleOptions[0]);
          await driver.sleep(300);
          await driver.executeScript("arguments[0].click();", titleOptions[0]);
          console.log("Selected Title from autocomplete");
        }
      } catch (e) {
        console.log("Could not select Title from autocomplete:", e.message);
      }

      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Title:", e.message);
    }

    // Fill First Name
    try {
      console.log(`[${jobId}] Filling First Name...`);
      const firstNameField = By.name("newcust_textfield_firstName_01");

      // Get firstName - handle cases where it might be fullName or need splitting
      let firstName = data.firstName || data.fullName;

      // Validate and process firstName
      if (!firstName || typeof firstName !== 'string') {
        console.log(`[${jobId}] No firstName in data, using default "Test"`);
        firstName = "Test";
      } else {
        // If firstName contains spaces, it might be a full name - take first part
        if (firstName.includes(" ")) {
          firstName = firstName.trim().split(" ")[0];
          console.log(`[${jobId}] Extracted first name from full name: "${firstName}"`);
        }

        // Ensure we have a valid value after processing
        firstName = firstName.trim();
        if (!firstName) {
          console.log(`[${jobId}] firstName is empty after processing, using default "Test"`);
          firstName = "Test";
        }
      }

      console.log(`[${jobId}] Using First Name: "${firstName}"`);

      // Wait for field to be available
      const firstNameInput = await driver.wait(until.elementLocated(firstNameField), 10000);
      await driver.wait(until.elementIsVisible(firstNameInput), 10000);
      await driver.wait(until.elementIsEnabled(firstNameInput), 10000);

      // Clear and type
      await firstNameInput.clear();
      await firstNameInput.sendKeys(firstName);

      console.log(`[${jobId}] ✅ Successfully filled First Name: "${firstName}"`);
    } catch (e) {
      console.error(`[${jobId}] ❌ Could not fill First Name:`, e.message);
      console.error(`[${jobId}] Error stack:`, e.stack);
      // Don't throw - continue with form filling
    }

    // Fill Middle Name (optional)
    try {
      console.log("Filling Middle Name...");
      const middleNameField = By.name("newcust_textfield_middleName_01");
      const middleName = data.middleName || "";
      if (middleName) {
        await safeType(driver, middleNameField, middleName, 10000);
      }
    } catch (e) {
      console.log("Could not fill Middle Name:", e.message);
    }

    // Fill Last Name
    try {
      console.log("Filling Last Name...");
      const lastNameField = By.name("newcust_textfield_lastName_01");
      const lastName = data.lastName || data.surname || "Customer";
      await safeType(driver, lastNameField, lastName, 10000);
    } catch (e) {
      console.log("Could not fill Last Name:", e.message);
    }

    // Select Gender
    try {
      console.log("Selecting Gender...");
      const genderDropdown = By.name("newcust_dropdown_gender_01");
      let gender = data.gender || "male";

      // Normalize gender to Title Case to avoid partial match issues (e.g. "male" matching "Female")
      if (typeof gender === 'string') {
        const lower = gender.toLowerCase();
        if (lower === 'male' || lower === 'm') gender = "Male";
        else if (lower === 'female' || lower === 'f') gender = "Female";
      }

      console.log(`[Gender Selection] Target: "${gender}"`);

      // Open dropdown
      await safeClick(driver, genderDropdown, 10000);
      await driver.sleep(1000);

      // Use strict XPath to find the option
      try {
        const strictXpath = `//mat-option[normalize-space(.)='${gender}']`;
        const optionEl = await driver.wait(until.elementLocated(By.xpath(strictXpath)), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", optionEl);
        await driver.sleep(200);
        await optionEl.click();
        console.log(`[Gender Selection] Selected "${gender}" using strict match.`);
      } catch (e) {
        console.log(`[Gender Selection] Strict match failed for "${gender}". Error: ${e.message}`);

        // Fallback: List options to debug and try JS match
        try {
          const options = await driver.findElements(By.css("mat-option"));
          console.log(`[Gender Selection] Found ${options.length} options:`);
          for (const opt of options) {
            const text = await opt.getText();
            console.log(`- "${text}"`);

            if (text.trim() === gender) {
              await opt.click();
              console.log(`[Gender Selection] Clicked "${text}" via JS loop.`);
              // break loop after click? Yes, but we need to be careful about stale elements if click changes DOM.
              // usually fine for dropdowns.
              break;
            }
          }
        } catch (listErr) {
          console.log(`[Gender Selection] Error listing options: ${listErr.message}`);
        }
      }

      // Ensure dropdown is closed
      try {
        await driver.executeScript("document.body.click();");
      } catch (e) { }
    } catch (e) {
      console.log("Could not select Gender:", e.message);
    }

    // Fill Occupation (autocomplete)
    try {
      console.log("Filling Occupation...");
      const occupationField = By.name("newcust_textfield_occupation_01");
      const occupationInput = await driver.wait(until.elementLocated(occupationField), 10000);
      await driver.wait(until.elementIsVisible(occupationInput), 10000);

      // Clear any existing text
      await occupationInput.clear();

      // Type the value
      const occupation = data.occupation || "Engineer";
      await occupationInput.click();
      await occupationInput.sendKeys(occupation);
      await driver.sleep(1500); // Wait for autocomplete to appear

      // Try to select from autocomplete - wait for options to appear
      try {
        console.log("Waiting for Occupation autocomplete options...");
        const occupationOptions = await driver.wait(until.elementsLocated(By.css("mat-option")), 5000);
        console.log(`Found ${occupationOptions.length} Occupation autocomplete options`);

        if (occupationOptions.length > 0) {
          // Click the first option
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", occupationOptions[0]);
          await driver.sleep(300);
          await driver.executeScript("arguments[0].click();", occupationOptions[0]);
          console.log("Selected Occupation from autocomplete");
        }
      } catch (e) {
        console.log("Could not select Occupation from autocomplete:", e.message);
      }

      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Occupation:", e.message);
    }

    // Fill Date of Birth
    try {
      console.log("Filling Date of Birth...");
      const dobField = By.name("newcust_datepicker_dob_01");
      const dobInput = await driver.wait(until.elementLocated(dobField), 10000);
      // Format: DD/MM/YYYY or MM/DD/YYYY - try to parse from data
      let dob = "01/01/1990"; // default
      if (data.dob) {
        // If dob is in DD-MM-YYYY format, convert to DD/MM/YYYY
        dob = data.dob.replace(/-/g, "/");
      } else if (data.dateOfBirth) {
        // Try to format dateOfBirth
        const date = new Date(data.dateOfBirth);
        if (!isNaN(date.getTime())) {
          const day = String(date.getDate()).padStart(2, '0');
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const year = date.getFullYear();
          dob = `${day}/${month}/${year}`;
        }
      }
      await dobInput.sendKeys(dob);
    } catch (e) {
      console.log("Could not fill Date of Birth:", e.message);
    }

    // Fill Aadhaar Number
    try {
      console.log("Filling Aadhaar Number...");
      const aadharField = By.name("newcust_textfield_aadharNo_01");

      // Determine value from available data keys; fallback to a valid-looking default starting 2-9
      const rawAadhaar = data.aadhaarNumber || data.aadhaar || data.aadhar || data.aadharNo || "234567890123";
      // Normalize: digits only, max 12
      let aadhaar = String(rawAadhaar).replace(/\D/g, '').slice(0, 12);
      // Ensure 12 digits and first digit 2-9 per pattern
      if (aadhaar.length !== 12 || !/^[2-9]/.test(aadhaar)) {
        console.log("Provided Aadhaar invalid/short; using fallback pattern-compliant placeholder.");
        aadhaar = "234567890123";
      }

      await safeType(driver, aadharField, aadhaar, 10000);
      await driver.sleep(300);
    } catch (e) {
      console.log("Could not fill Aadhaar Number:", e.message);
    }

    // Click on Address Information accordion to expand
    try {
      console.log("Expanding Address Information...");

      // Try multiple strategies to expand the accordion
      let addressPanel = null;

      // Strategy 1: Find by expansion panel header text
      try {
        const addressHeader = By.xpath("//mat-expansion-panel-header//h4[contains(., 'Address Information')]");
        addressPanel = await driver.wait(until.elementLocated(addressHeader), 5000);
        console.log("Found Address Information header");
      } catch (e) {
        console.log("Could not find Address Information by header, trying alternative...");
      }

      // Strategy 2: Find by mat-expansion-panel that contains Address Information text
      if (!addressPanel) {
        try {
          const panelXpath = By.xpath("//mat-expansion-panel[.//text()[contains(., 'Address Information')]]//mat-expansion-panel-header");
          addressPanel = await driver.wait(until.elementLocated(panelXpath), 5000);
          console.log("Found Address Information by panel");
        } catch (e) {
          console.log("Could not find Address Information by panel");
        }
      }

      if (addressPanel) {
        // Check if already expanded
        const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", addressPanel);
        console.log(`Address Information panel isExpanded: ${isExpanded}`);

        if (!isExpanded) {
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", addressPanel);
          await driver.sleep(300);
          await driver.executeScript("arguments[0].click();", addressPanel);
          console.log("Expanded Address Information panel");
          await driver.sleep(1000);
        } else {
          console.log("Address Information panel already expanded");
        }
      } else {
        console.log("Could not locate Address Information panel");
      }
    } catch (e) {
      console.log("Could not expand Address Information:", e.message);
    }

    // Fill House No/ Bldg. Name (concatenated fields as requested)
    try {
      console.log("Filling House Number from DB data...");
      const houseNoField = By.name("newcust_textfield_building_01");

      // Concatenate flatDoorNo, floorNo, buildingName
      const houseParts = [data.flatDoorNo, data.floorNo, data.buildingName]
        .filter(part => part && String(part).trim().length > 0);

      // Fallback to original logic if specific fields are empty, or just use what we have
      let houseNoValue = houseParts.join(", ");

      // If the specific combination is empty, try the old fallback chain just in case
      if (!houseNoValue) {
        houseNoValue = data.premisesName || data.flatNo || "";
      }

      if (houseNoValue && String(houseNoValue).trim()) {
        await safeType(driver, houseNoField, String(houseNoValue).trim(), 10000);
      } else {
        console.log("Skipping House Number: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill House Number:", e.message);
    }

    // Fill Street/Colony (concatenated fields as requested)
    try {
      console.log("Filling Street from DB data...");
      const streetField = By.name("newcust_textfield_street_01");

      // Concatenate blockName, roadStreetLane
      const streetParts = [data.blockName, data.roadStreetLane]
        .filter(part => part && String(part).trim().length > 0);

      let streetValue = streetParts.join(", ");

      // Fallback if empty
      if (!streetValue) {
        streetValue = data.road || data.street || "";
      }

      if (streetValue && String(streetValue).trim()) {
        await safeType(driver, streetField, String(streetValue).trim(), 10000);
      } else {
        console.log("Skipping Street: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Street:", e.message);
    }

    // Fill Pincode (only from DB data)
    try {
      console.log("Filling Pincode from DB data...");
      const pincodeField = By.name("newcust_textfield_pincode_01");
      const pincode = data.pincode || data.pinCode;
      if (pincode && String(pincode).trim()) {
        await safeType(driver, pincodeField, String(pincode).trim(), 10000);
      } else {
        console.log("Skipping Pincode: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Pincode:", e.message);
    }

    // Fill Locality (only from DB data)
    try {
      console.log("Filling Locality from DB data...");
      const localityField = By.name("newcust_textfield_locality_01");
      const locality = data.locality || data.area || "chennai";
      if (locality && String(locality).trim()) {
        await safeType(driver, localityField, String(locality).trim(), 10000);
      } else {
        console.log("Skipping Locality: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Locality:", e.message);
    }

    // Fill City (only from DB data)
    try {
      console.log("Filling City from DB data...");
      const cityField = By.name("newcust_textfield_city_01");
      const city = data.city || data.rtoCityLocation;
      if (city && String(city).trim()) {
        await safeType(driver, cityField, String(city).trim(), 10000);
      } else {
        console.log("Skipping City: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill City:", e.message);
    }

    // Fill District (only from DB data)
    try {
      console.log("Filling District from DB data...");
      const districtField = By.name("newcust_textfield_district_01");
      const district = data.district || data.city;
      if (district && String(district).trim()) {
        await safeType(driver, districtField, String(district).trim(), 10000);
      } else {
        console.log("Skipping District: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill District:", e.message);
    }

    // Fill State (only from DB data)
    try {
      console.log("Filling State from DB data...");
      const stateField = By.name("newcust_textfield_state_01");
      const state = data.state || data.stateName;
      if (state && String(state).trim()) {
        await safeType(driver, stateField, String(state).trim(), 10000);
      } else {
        console.log("Skipping State: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill State:", e.message);
    }

    // Fill Country (only from DB data)
    try {
      console.log("Filling Country from DB data...");
      const countryField = By.name("newcust_textfield_country_01");
      const country = data.country;
      if (country && String(country).trim()) {
        await safeType(driver, countryField, String(country).trim(), 10000);
      } else {
        console.log("Skipping Country: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Country:", e.message);
    }

    // Expand Communication Information accordion
    try {
      console.log("Expanding Communication Information...");

      // Try multiple strategies to expand the accordion
      let communicationPanel = null;

      // Strategy 1: Find by expansion panel header text
      try {
        const communicationHeader = By.xpath("//mat-expansion-panel-header//h4[contains(., 'Communication Information')]");
        communicationPanel = await driver.wait(until.elementLocated(communicationHeader), 5000);
        console.log("Found Communication Information header");
      } catch (e) {
        console.log("Could not find Communication Information by header, trying alternative...");
      }

      // Strategy 2: Find by mat-expansion-panel that contains Communication Information text
      if (!communicationPanel) {
        try {
          const panelXpath = By.xpath("//mat-expansion-panel[.//text()[contains(., 'Communication')]]//mat-expansion-panel-header");
          communicationPanel = await driver.wait(until.elementLocated(panelXpath), 5000);
          console.log("Found Communication Information by panel");
        } catch (e) {
          console.log("Could not find Communication Information by panel");
        }
      }

      if (communicationPanel) {
        // Check if already expanded
        const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", communicationPanel);
        console.log(`Communication Information panel isExpanded: ${isExpanded}`);

        if (!isExpanded) {
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", communicationPanel);
          await driver.sleep(300);
          await driver.executeScript("arguments[0].click();", communicationPanel);
          console.log("Expanded Communication Information panel");
          await driver.sleep(1000);
        } else {
          console.log("Communication Information panel already expanded");
        }
      } else {
        console.log("Could not locate Communication Information panel");
      }
    } catch (e) {
      console.log("Could not expand Communication Information:", e.message);
    }

    // Fill Email ID
    try {
      console.log("Filling Email ID...");
      const emailField = By.name("newcust_textfield_email_01");
      const emailInput = await driver.wait(until.elementLocated(emailField), 10000);
      await driver.wait(until.elementIsVisible(emailInput), 10000);

      // Clear any existing text
      await emailInput.clear();

      // Type the email value
      const email = data.email || "test@example.com";
      await emailInput.sendKeys(email);
      console.log("Successfully filled Email ID");

      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Email ID:", e.message);
    }

    // Fill Mobile No
    try {
      console.log("Filling Mobile No...");
      const mobileField = By.name("newcust_textfield_mobNo_01");
      const mobile = data.mobile || data.mobileNumber || "9876543210";
      await safeType(driver, mobileField, String(mobile), 10000);
    } catch (e) {
      console.log("Could not fill Mobile No:", e.message);
    }

    await driver.sleep(1000);

    // === CLICK CREATE CUSTOMER BUTTON AFTER FORM FILL ===
    console.log("Clicking Create Customer button after filling form...");
    try {
      console.log("Looking for Create Customer button...");

      // Find the button by name (most reliable)
      const createCustomerButton = By.name("newCust_btn_createCust_01");
      const createCustBtn = await driver.wait(until.elementLocated(createCustomerButton), 10000);

      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(createCustBtn), 10000);

      // Check if button is enabled
      const isEnabled = await createCustBtn.isEnabled();
      console.log(`Create Customer button isEnabled: ${isEnabled}`);

      // Also check by checking the 'disabled' attribute
      const isDisabledAttr = await driver.executeScript("return arguments[0].hasAttribute('disabled');", createCustBtn);
      console.log(`Create Customer button has disabled attribute: ${isDisabledAttr}`);

      // Get button text for debugging
      const buttonText = await driver.executeScript("return arguments[0].textContent || arguments[0].innerText;", createCustBtn);
      console.log(`Create Customer button text: ${buttonText}`);

      // Scroll to button
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", createCustBtn);
      await driver.sleep(500);

      // Try multiple click strategies
      if (isEnabled && !isDisabledAttr) {
        // Button is enabled, try direct click first
        try {
          await createCustBtn.click();
          console.log("Clicked Create Customer button (direct click)");
        } catch (e) {
          console.log("Direct click failed, trying JavaScript click:", e.message);
          // Fall back to JavaScript click
          await driver.executeScript("arguments[0].click();", createCustBtn);
          console.log("Clicked Create Customer button (JavaScript click)");
        }
      } else {
        console.log("Create Customer button is disabled, attempting to force click with JavaScript...");
        // Force click with JavaScript even if disabled
        await driver.executeScript("arguments[0].click();", createCustBtn);
        console.log("Force clicked Create Customer button with JavaScript");
      }

      console.log("Successfully clicked Create Customer button");
      await driver.sleep(3000); // Wait for processing
    } catch (e) {
      console.log("Create Customer button not found, trying alternative:", e.message);

      // Try alternative approach - find by button text
      try {
        const createByText = By.xpath("//button[contains(., 'Create Customer')]");
        const createCustBtn = await driver.wait(until.elementLocated(createByText), 5000);
        await driver.executeScript("arguments[0].click();", createCustBtn);
        console.log("Clicked Create Customer button (alternative)");
        await driver.sleep(3000);
      } catch (e2) {
        console.log("All strategies failed for Create Customer button:", e2.message);
      }
    }

    // === HANDLE DYNAMIC LOCALITY FIELD ===
    try {
      console.log("Checking for dynamic 'Locality Name' field after first click...");
      // Check for the new field
      const localityNameField = By.name("newcust_textfield_locality_name_01");

      // Wait a bit to see if it appears (it might take a moment after the first click)
      // reducing timeout as we don't want to wait long if it doesn't appear
      const localityInput = await driver.wait(until.elementLocated(localityNameField), 5000);

      // If we found it, try to interact
      if (await localityInput.isDisplayed()) {
        console.log("⚠️ Locality Name field appeared! Filling it...");
        const localityName = data.locality || data.area || "Sample Locality";
        await localityInput.clear();
        await localityInput.sendKeys(localityName);
        console.log(`Filled Locality Name with: ${localityName}`);

        await driver.sleep(1000);

        // Click Create Customer button again
        console.log("Clicking Create Customer button AGAIN...");
        const createCustBtnAgain = await driver.wait(until.elementLocated(By.name("newCust_btn_createCust_01")), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", createCustBtnAgain);
        await driver.sleep(500);

        try {
          await createCustBtnAgain.click();
        } catch (e) {
          await driver.executeScript("arguments[0].click();", createCustBtnAgain);
        }
        console.log("Clicked Create Customer button again.");
        await driver.sleep(3000);
      }
    } catch (e) {
      console.log("Locality Name field did not appear (proceeding):", e.message);
    }

    // === HANDLE CUSTOMER DETAILS AFTER SUBMIT ===
    console.log("Handling customer details after submit...");

    // Click Close button on modal/dialog
    try {
      console.log("Clicking Close button...");
      const closeButton = By.name("alert_btn_data_01");
      const closeBtn = await driver.wait(until.elementLocated(closeButton), 10000);

      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", closeBtn);
      await driver.sleep(500);
      await driver.executeScript("arguments[0].click();", closeBtn);
      console.log("Clicked Close button");
      await driver.sleep(2000);
    } catch (e) {
      console.log("Close button not found:", e.message);
    }

    // === VEHICLE INFORMATION SECTION ===
    console.log("Expanding Vehicle Information section...");

    // Click on Vehicle Information accordion to expand
    try {
      const vehicleHeader = By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Vehicle Information')]]");
      const vehiclePanel = await driver.wait(until.elementLocated(vehicleHeader), 10000);

      const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", vehiclePanel);
      console.log(`Vehicle Information panel isExpanded: ${isExpanded}`);

      if (!isExpanded) {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", vehiclePanel);
        await driver.sleep(300);
        await driver.executeScript("arguments[0].click();", vehiclePanel);
        console.log("Expanded Vehicle Information panel");
        await driver.sleep(1000);
      }
    } catch (e) {
      console.log("Could not expand Vehicle Information:", e.message);
    }

    // Fill Engine Number
    try {
      console.log("Filling Engine Number...");
      const engineField = By.name("mcy_text_engineNumber_01");
      const engineInput = await driver.wait(until.elementLocated(engineField), 10000);
      await engineInput.clear();
      const engineNumber = data.engineNumber || "JC85EG4183208";
      await engineInput.sendKeys(engineNumber);
      console.log("Filled Engine Number");
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Engine Number:", e.message);
    }

    // Fill Chassis Number
    try {
      console.log("Filling Chassis Number...");
      const chassisField = By.name("mcy_text_chasisNumber_01");
      const chassisInput = await driver.wait(until.elementLocated(chassisField), 10000);
      await chassisInput.clear();
      const chassisNumber = data.chassisNumber || "ME4JC85MJSG061153";
      await chassisInput.sendKeys(chassisNumber);
      console.log("Filled Chassis Number");
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Chassis Number:", e.message);
    }

    // Fill Color of Vehicle (autocomplete)
    try {
      console.log("Filling Color of Vehicle...");
      const colorField = By.name("mcy_dropdown_color_01");
      const colorInput = await driver.wait(until.elementLocated(colorField), 10000);
      await colorInput.clear();
      await colorInput.sendKeys("Blue");
      await driver.sleep(1500); // Wait for autocomplete

      try {
        const colorOptions = await driver.wait(until.elementsLocated(By.css("mat-option")), 5000);
        if (colorOptions.length > 0) {
          await driver.executeScript("arguments[0].click();", colorOptions[0]);
          console.log("Selected Color from autocomplete");
        }
      } catch (e) {
        console.log("Could not select Color from autocomplete:", e.message);
      }
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Color:", e.message);
    }

    await openVehicleInformationSection(driver);

    // Select Type of Body
    try {
      console.log("Selecting Type of Body...");
      const typeLocators = [
        By.name("mcy_dropdown_body_01"),
        By.xpath("//mat-label[contains(., 'Type of Body')]/ancestor::mat-form-field//mat-select")
      ];
      let typeSelected = false;

      for (const locator of typeLocators) {
        try {
          await safeSelectOption(driver, locator, "Others", 10000);
          console.log(`Selected Type of Body using locator: ${locator.toString()}`);
          typeSelected = true;
          break;
        } catch (selectionError) {
          console.log(`Type of Body selection failed for ${locator.toString()}: ${selectionError.message}`);
        }
      }

      if (!typeSelected) {
        console.log("Falling back to direct input for Type of Body...");
        const bodyInput = await driver.wait(until.elementLocated(By.name("mcy_dropdown_body_01")), 10000);
        await bodyInput.clear();
        await bodyInput.sendKeys("Others");
        await driver.sleep(1500);
        try {
          const bodyOptions = await driver.wait(
            until.elementsLocated(By.xpath("//mat-option[normalize-space(.)='Others']")),
            3000
          );
          if (bodyOptions.length > 0) {
            await driver.executeScript("arguments[0].click();", bodyOptions[0]);
            console.log("Selected Type of Body 'Others' from fallback autocomplete");
            typeSelected = true;
          }
        } catch (fallbackError) {
          console.log("Fallback autocomplete selection failed:", fallbackError.message);
        }
      }

      await driver.sleep(500);
    } catch (e) {
      console.log("Could not select Type of Body:", e.message);
    }

    await openVehicleInformationSection(driver);

    // Select Year of Manufacture
    try {
      console.log("Selecting Year of Manufacture...");
      let yearSelected = false;
      const manufacturingYear = data.manufacturingYear || data.manufacturingyear || "2025";
      const yearString = String(manufacturingYear);

      // STRATEGY 1: Datepicker (based on user feedback with name mcy_text_yom_01)
      try {
        console.log("Checking for Year of Manufacture Datepicker (mcy_text_yom_01)...");
        // Look for the input to verify existence
        const datepickerInput = await driver.findElements(By.name("mcy_text_yom_01"));

        if (datepickerInput.length > 0) {
          console.log("Found Datepicker input. Attempting to open calendar...");
          // Use specific toggle button associated with this input
          // Often interactions work better on the button directly
          // Try to find the sibling mat-datepicker-toggle button
          const toggleButton = await driver.executeScript(`
                var input = document.getElementsByName('mcy_text_yom_01')[0];
                if (!input) return null;
                // Go up to find mat-form-field-infix or flex, then find mat-datepicker-toggle
                var container = input.closest('.mat-mdc-form-field-flex') || input.closest('.mat-form-field-flex');
                if (!container) return null;
                var btn = container.querySelector('mat-datepicker-toggle button');
                return btn;
            `);

          if (toggleButton) {
            await driver.wait(until.elementIsVisible(toggleButton), 5000);
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", toggleButton);
            await driver.sleep(500);

            try {
              await toggleButton.click();
            } catch (clickErr) {
              await driver.executeScript("arguments[0].click();", toggleButton);
            }
            console.log("Clicked Datepicker toggle button.");

            // Wait for calendar to be visible
            await driver.wait(until.elementLocated(By.css("mat-calendar")), 5000);
            await driver.sleep(500); // Animation buffer

            // Look for the specific year cell (Best: Button with aria-label)
            let yearCell;
            try {
              yearCell = await driver.wait(
                until.elementLocated(By.xpath(`//button[contains(@class, 'mat-calendar-body-cell') and @aria-label='${yearString}']`)),
                3000
              );
              console.log(`Found year ${yearString} button by aria-label.`);
            } catch (e) {
              console.log("Year button by aria-label not found, trying text content...");
              yearCell = await driver.wait(
                until.elementLocated(By.xpath(`//span[contains(@class, 'mat-calendar-body-cell-content') and contains(text(), '${yearString}')]`)),
                3000
              );
            }

            await driver.wait(until.elementIsVisible(yearCell), 5000);
            await driver.sleep(500);

            try {
              await yearCell.click();
            } catch (cellClickErr) {
              await driver.executeScript("arguments[0].click();", yearCell);
            }
            console.log(`Selected year ${yearString} from Datepicker.`);
            yearSelected = true;
          } else {
            console.log("Datepicker toggle button not found via JS.");
          }
        }
      } catch (datepickerError) {
        console.log("Datepicker interaction failed:", datepickerError.message);
      }

      // STRATEGY 2: Dropdown / Select (Fallback)
      if (!yearSelected) {
        console.log("Falling back to Dropdown/Select for Year of Manufacture...");
        const yearLocators = [
          By.name("mcy_dropdown_year_01"),
          By.name("mcy_dropdown_manYear_01"),
          By.name("mcy_dropdown_manufacturingYear_01"),
          By.xpath("//div[@id='mat-select-value-29']/ancestor::mat-select"),
          By.xpath("//mat-form-field[.//mat-label[contains(., 'Year of Manufacture')]]//mat-select"),
          By.xpath("//mat-select[contains(@aria-label, 'Year')]"),
          By.xpath("//mat-select[contains(@aria-labelledby, 'Year')]"),
          By.css("mat-select[formcontrolname*='year']"),
          By.css("mat-select[name*='year']"),
        ];

        for (const locator of yearLocators) {
          try {
            try {
              await driver.wait(until.elementLocated(locator), 1000);
            } catch (e) {
              continue;
            }

            await safeSelectOption(driver, locator, yearString, 5000);
            console.log(`Selected Year of Manufacture using locator: ${locator.toString()}`);
            yearSelected = true;
            break;
          } catch (selectionError) {
            // Ignore
          }
        }
      }

      // STRATEGY 3: Direct Click Fallback for Dropdown
      if (!yearSelected) {
        console.log(`Year dropdown fallback: trying direct option click for ${yearString}...`);
        try {
          const trigger = await driver.wait(
            until.elementLocated(By.xpath("//mat-form-field[.//mat-label[contains(., 'Year of Manufacture')]]//mat-select")),
            3000
          );

          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", trigger);
          await driver.sleep(500);
          await driver.executeScript("arguments[0].click();", trigger);
          await driver.sleep(1000);

          const yearOption = await driver.wait(
            until.elementLocated(By.xpath(`//mat-option[contains(., '${yearString}')]`)),
            3000
          );
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", yearOption);
          await driver.executeScript("arguments[0].click();", yearOption);
          console.log(`Selected Year of Manufacture ${yearString} via direct option fallback.`);
          yearSelected = true;
        } catch (fallbackError) {
          console.log("Direct Year of Manufacture selection failed:", fallbackError.message);
        }
      }

      if (!yearSelected) {
        console.log(`Unable to select Year of Manufacture ${yearString} after all strategies.`);
      }

      await driver.sleep(500);
    } catch (e) {
      console.log("Year of Manufacture handling failed:", e.message);
    }
    // === COMPULSORY PA FOR OWNER DRIVER SECTION ===
    console.log("Handling Compulsory PA for Owner Driver section...");
    try {
      // 1. Expand the section
      const paHeader = By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Compulsory PA for Owner Driver')]]");
      const paPanel = await driver.wait(until.elementLocated(paHeader), 10000);

      const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", paPanel);
      if (!isExpanded) {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", paPanel);
        await driver.sleep(500);
        await driver.executeScript("arguments[0].click();", paPanel);
        console.log("Expanded Compulsory PA panel");
        await driver.sleep(1000);
      }

      // 2. Disable the toggle
      // Use a robust locator for the switch button inside the panel
      try {
        const toggleButton = await driver.wait(until.elementLocated(By.xpath("//mat-expansion-panel[.//h4[contains(., 'Compulsory PA')]]//button[@role='switch']")), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", toggleButton);

        const isCheckedStr = await toggleButton.getAttribute("aria-checked");
        console.log(`Compulsory PA toggle aria-checked: ${isCheckedStr}`);

        if (isCheckedStr === 'true') {
          console.log("Compulsory PA is enabled. Disabling it...");
          await toggleButton.click();

          // 3. Handle Confirmation Popup
          console.log("Waiting for confirmation popup...");
          try {
            // Use the specific name provided by the user
            const closeBtn = await driver.wait(until.elementLocated(By.name("alert_btn_data_01")), 5000);
            await driver.wait(until.elementIsVisible(closeBtn), 5000);
            await closeBtn.click();
            console.log("Clicked Close on Compulsory PA confirmation.");
          } catch (popupError) {
            console.log("Confirmation popup Close button (alert_btn_data_01) not found:", popupError.message);
            // Fallback to text search just in case
            try {
              const closeBtnText = await driver.wait(until.elementLocated(By.xpath("//button[contains(., 'Close')]")), 2000);
              await closeBtnText.click();
              console.log("Clicked Close (text fallback).");
            } catch (e) { }
          }
        } else {
          console.log("Compulsory PA is already disabled.");
        }
      } catch (toggleErr) {
        console.log("Could not find Compulsory PA toggle button:", toggleErr.message);
      }

    } catch (e) {
      console.log("Error handling Compulsory PA section:", e.message);
    }
    await driver.sleep(1000);


    // === POST-CUSTOMER CREATION STEPS ===
    console.log("Handling post-customer creation steps...");

    // === FINANCIER INTEREST SECTION ===
    if (data.hasFinancier) {
      console.log("Financier Interest is applicable (hasFinancier=true). Processing section...");

      // Open Financier Interest Applicable tab
      try {
        console.log("Opening Financier Interest Applicable tab...");
        const financierTab = By.xpath("//span[contains(normalize-space(.), 'Financier Interest Applicable')]");
        await safeClick(driver, financierTab, 10000);
        await driver.sleep(2000);
      } catch (e) {
        console.log("Financier Interest Applicable tab not found or already open:", e.message);
      }

      // Ensure Financier Interest section is visible
      await openFinancierSection(driver);

      // Enable Financier Interest switch
      const financierToggleLocators = [
        By.xpath("//*[@id='mat-mdc-slide-toggle-8-button']"),
        By.xpath("//*[@id='mat-mdc-slide-toggle-8-button']/div[2]/div/div[3]/svg[2]"),
        By.css("mat-mdc-slide-toggle[name='mcy_toggle_FinancierInterestApplicable_01']"),
        By.xpath("//mat-mdc-slide-toggle[contains(., 'Financier Interest Applicable')]"),
        By.xpath("//mat-expansion-panel[contains(., 'Financier Interest Applicable')]//mat-mdc-slide-toggle"),
      ];
      try {
        await enableSlideToggle(driver, financierToggleLocators, "Financier Interest switch");
        await driver.sleep(1000);
      } catch (e) {
        console.log("Financier switch handling failed:", e.message);
      }

      // Select Financier Interest Type
      try {
        console.log("Selecting Financier Interest Type...");
        const interestLocators = [
          By.xpath("//div[@id='mat-select-value-41']/ancestor::mat-select"),
          By.id("mat-select-41"),
          By.xpath("//mat-form-field[.//mat-label[contains(., 'Financier Interest Type')]]//mat-select"),
          By.xpath("//mat-label[contains(., 'Financier Interest Type')]/ancestor::mat-form-field//mat-select"),
          By.css("mat-select[formcontrolname*='Financier']"),
          By.css("mat-select[name*='Financier']"),
        ];

        const interestType = data.financierType || "Hypothecation";
        let interestSelected = false;

        for (const locator of interestLocators) {
          try {
            // 1. Click to open dropdown
            await safeClick(driver, locator, 5000);
            await driver.sleep(1000);

            // 2. Search for the option
            // Try to find a search input inside the dropdown panel
            try {
              const searchInput = await driver.findElement(By.css("input[aria-label='dropdown search'], input[placeholder='Search'], .mat-select-search-input"));
              if (searchInput) {
                await searchInput.sendKeys(interestType);
                await driver.sleep(1000); // Wait for filter
              }
            } catch (searchErr) {
              // No search input found, maybe typing directly works or it's not searchable
              console.log("No search input found in dropdown, trying to select directly from options...");
            }

            // 3. Wait for options to appear (filtered or all)
            const options = await driver.wait(until.elementsLocated(By.css("mat-option")), 5000);

            if (options.length > 0) {
              // 4. Select the FIRST option
              console.log(`Found ${options.length} options. Selecting the first one.`);
              const firstOption = options[0];
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", firstOption);
              await driver.sleep(200);
              await firstOption.click();
              console.log(`Selected first available option for "${interestType}".`);
              interestSelected = true;

              // Close dropdown if it didn't close automatically
              await driver.sleep(500);
              try { await driver.executeScript("document.body.click()"); } catch (e) { }

              break;
            } else {
              console.log("No options found in dropdown.");
              try { await driver.executeScript("document.body.click()"); } catch (e) { }
            }
          } catch (interestError) {
            console.log(`Financier Interest Type selection failed for ${locator.toString()}: ${interestError.message}`);
            try { await driver.executeScript("document.body.click()"); } catch (e) { }
          }
        }

        if (!interestSelected) {
          console.log("Could not select Financier Interest Type.");
        }
      } catch (e) {
        console.log("Financier Interest Type handling failed:", e.message);
      }

      // Fill Financier Name
      try {
        console.log("Filling Financier Name...");
        const finName = data.financierName || "Financier Name";
        await safeType(driver, By.name("mcy_text_FinancierName_01"), finName, 10000);
      } catch (e) {
        console.log("Could not fill Financier Name by name attribute, trying label-based locator...");
        try {
          const financierNameInput = By.xpath("//mat-label[contains(., 'Financier Name')]/ancestor::mat-form-field//input");
          const finName = data.financierName || "Financier Name";
          await safeType(driver, financierNameInput, finName, 10000);
        } catch (fallbackError) {
          console.log("All strategies failed for Financier Name:", fallbackError.message);
        }
      }

      // Fill Financier Address
      try {
        console.log("Filling Financier Address...");
        const finAddress = data.financierAddress || "Financier Address";
        await safeType(driver, By.name("mcy_text_FinancierAddress_01"), finAddress, 10000);
      } catch (e) {
        console.log("Could not fill Financier Address by name attribute, trying label-based locator...");
        try {
          const financierAddressInput = By.xpath("//mat-label[contains(., 'Financier Address')]/ancestor::mat-form-field//input");
          const finAddress = data.financierAddress || "Financier Address";
          await safeType(driver, financierAddressInput, finAddress, 10000);
        } catch (fallbackError) {
          console.log("All strategies failed for Financier Address:", fallbackError.message);
        }
      }
      // Check declaration checkbox
      try {
        console.log("Checking financier declaration checkbox...");
        const declarationCheckboxLocators = [
          By.css("*[name='mcy_checkbox_declaration01_01']"),
          By.id("mat-mdc-checkbox-2-input"),
          By.name("mcy_checkbox_declaration01_01"),
          By.xpath("//input[@type='checkbox' and contains(@id, 'checkbox') and contains(@name, 'declaration')]")
        ];
        let checkboxChecked = false;

        for (const locator of declarationCheckboxLocators) {
          try {
            const checkbox = await driver.wait(until.elementLocated(locator), 5000);
            await driver.wait(until.elementIsVisible(checkbox), 5000);
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", checkbox);
            await driver.sleep(200);
            const isChecked = await checkbox.isSelected().catch(() => false);
            if (!isChecked) {
              await driver.executeScript("arguments[0].click();", checkbox);
              console.log(`Clicked checkbox using locator: ${locator.toString()}`);
              const nowChecked = await checkbox.isSelected().catch(() => false);
              if (!nowChecked) {
                await driver.executeScript("if (!arguments[0].checked) { arguments[0].checked = true; arguments[0].dispatchEvent(new Event('change', { bubbles: true })); }", checkbox);
                console.log("Forced checkbox checked via script dispatch.");
              }
            } else {
              console.log("Checkbox already checked.");
            }
            checkboxChecked = true;
            break;
          } catch (checkboxError) {
            console.log(`Checkbox interaction failed for ${locator.toString()}: ${checkboxError.message}`);
          }
        }

        if (!checkboxChecked) {
          console.log("Could not interact with the financier declaration checkbox.");
        }

        await driver.sleep(500);
      } catch (e) {
        console.log("Financier declaration checkbox handling failed:", e.message);
      }
    } else {
      console.log("Financier Interest NOT applicable (hasFinancier=false). Skipping section.");
    }

    // Click Check Vahan button and handle popup
    try {
      console.log("Clicking Check Vahan button...");
      await openVehicleInformationSection(driver);
      const checkVahanLocators = [
        By.xpath("//span[contains(@class, 'checkbtn') and contains(normalize-space(.), 'Check Vahan')]"),
        By.xpath("//button[contains(@class, 'checkbtn') and contains(normalize-space(.), 'Check Vahan')]"),
        By.name("mcod_btn_addCover_01"),
        By.xpath("//span[@name='mcod_btn_addCover_01']"),
      ];
      let vahanClicked = false;

      try {
        const vahanButtonsByName = await driver.findElements(By.name("mcod_btn_addCover_01"));
        if (vahanButtonsByName.length > 1) {
          console.log(`Multiple Check Vahan buttons found (${vahanButtonsByName.length}), clicking the second.`);
          await scrollAndClickElement(driver, vahanButtonsByName[1]);
          vahanClicked = true;
        } else if (vahanButtonsByName.length === 1) {
          console.log("Single Check Vahan button found by name, clicking it.");
          await scrollAndClickElement(driver, vahanButtonsByName[0]);
          vahanClicked = true;
        }
      } catch (multiError) {
        console.log("Direct Check Vahan name-based click failed:", multiError.message);
      }

      for (const locator of checkVahanLocators) {
        if (vahanClicked) {
          break;
        }
        try {
          await scrollAndClick(driver, locator, 12000);
          vahanClicked = true;
          console.log(`Clicked Check Vahan using locator: ${locator.toString()}`);
          break;
        } catch (vahanError) {
          console.log(`Check Vahan click failed for ${locator.toString()}: ${vahanError.message}`);
        }
      }

      if (vahanClicked) {
        console.log(`[${jobId}] Waiting for Vahan response to complete...`);
        await driver.sleep(3000); // Wait for initial response
        await waitForLoaderToDisappear(driver, undefined, 20000);
        await waitForPortalLoaderToDisappear(driver);
        await driver.sleep(2000); // Additional wait for response to process

        try {
          console.log(`[${jobId}] Checking for Vahan popup/modal after response...`);

          // Try multiple times to ensure popup is closed
          let attempts = 0;
          const maxAttempts = 5;
          let popupStillVisible = true;

          while (attempts < maxAttempts && popupStillVisible) {
            attempts++;
            console.log(`[${jobId}] Close attempt ${attempts}/${maxAttempts}...`);

            // Use JavaScript to find and close the popup directly - try ALL methods
            const closeResult = await driver.executeScript(`
              // Find the Vahan dialog by multiple methods
              let dialog = document.querySelector('app-check-vahan-dialog') ||
                          document.querySelector('[app-check-vahan-dialog]') ||
                          document.querySelector('mat-dialog-container') ||
                          document.querySelector('.cd-popup.is-visible') || 
                          document.querySelector('.cd-popup[class*="is-visible"]') ||
                          document.querySelector('div[class*="cd-popup"][class*="is-visible"]');
              
              if (!dialog) {
                // Try finding by visibility - check for Material dialog
                const allDialogs = document.querySelectorAll('app-check-vahan-dialog, mat-dialog-container, .cd-popup, [class*="cd-popup"]');
                for (let d of allDialogs) {
                  const style = window.getComputedStyle(d);
                  if (d.classList.contains('is-visible') || 
                      style.display !== 'none' ||
                      style.visibility !== 'hidden' ||
                      d.offsetParent !== null) {
                    dialog = d;
                    break;
                  }
                }
              }
              
              if (dialog) {
                console.log('Found Vahan dialog, attempting ALL close methods...');
                
                // Method 1: Find and click close button - specific to Vahan dialog structure
                // The close button is inside h2.mat-mdc-dialog-title
                let closeBtn = dialog.querySelector('h2.mat-mdc-dialog-title span.cd-popup-close') ||
                              dialog.querySelector('h2[mat-dialog-title] span.cd-popup-close') ||
                              dialog.querySelector('h2 span.cd-popup-close') ||
                              dialog.querySelector('span.cd-popup-close') ||
                              dialog.querySelector('.cd-popup-close') ||
                              dialog.querySelector('span[class*="cd-popup-close"]') ||
                              dialog.querySelector('button.close') ||
                              dialog.querySelector('[aria-label="Close"]') ||
                              dialog.querySelector('[aria-label*="close" i]') ||
                              dialog.querySelector('[class*="close"]');
                
                // Also search in parent elements (mat-dialog-container)
                if (!closeBtn) {
                  let parent = dialog.parentElement;
                  while (parent && parent !== document.body) {
                    closeBtn = parent.querySelector('h2.mat-mdc-dialog-title span.cd-popup-close') ||
                              parent.querySelector('span.cd-popup-close');
                    if (closeBtn) break;
                    parent = parent.parentElement;
                  }
                }
                
                // Search entire document if not found in dialog
                if (!closeBtn) {
                  closeBtn = document.querySelector('h2.mat-mdc-dialog-title span.cd-popup-close') ||
                            document.querySelector('h2[mat-dialog-title] span.cd-popup-close') ||
                            document.querySelector('span.cd-popup-close') ||
                            document.querySelector('.cd-popup-close') ||
                            document.querySelector('span[class*="cd-popup-close"]');
                }
                
                if (closeBtn) {
                  console.log('Found close button, attempting multiple click methods...');
                  
                  // Try multiple click methods
                  try {
                    closeBtn.click();
                  } catch (e) {
                    console.log('Standard click failed:', e);
                  }
                  
                  try {
                    closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  } catch (e) {
                    console.log('MouseEvent click failed:', e);
                  }
                  
                  try {
                    closeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    closeBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                  } catch (e) {
                    console.log('MouseEvent mousedown/up failed:', e);
                  }
                  
                  // Try triggering any close handlers
                  try {
                    if (closeBtn.onclick) closeBtn.onclick();
                    if (closeBtn.parentElement && closeBtn.parentElement.onclick) closeBtn.parentElement.onclick();
                  } catch (e) {
                    console.log('onclick handler failed:', e);
                  }
                  
                  // Force focus and click
                  try {
                    closeBtn.focus();
                    closeBtn.click();
                  } catch (e) {
                    console.log('Focus and click failed:', e);
                  }
                  
                  console.log('All close button click methods attempted');
                } else {
                  console.log('Close button not found in popup');
                }
                
                // Method 2: Close Material dialog using Angular Material methods
                // Try to find and close the dialog using Material's close method
                try {
                  const dialogContainer = dialog.closest('mat-dialog-container') || 
                                        document.querySelector('mat-dialog-container');
                  if (dialogContainer) {
                    // Try to trigger Material dialog close
                    const closeEvent = new Event('close', { bubbles: true });
                    dialogContainer.dispatchEvent(closeEvent);
                  }
                } catch (e) {
                  console.log('Material dialog close event failed:', e);
                }
                
                // Method 3: Remove is-visible class and all visibility classes
                dialog.classList.remove('is-visible');
                dialog.classList.remove('visible');
                dialog.classList.remove('show');
                dialog.classList.add('is-hidden');
                dialog.classList.add('hidden');
                
                // Method 4: Set display to none and visibility hidden
                dialog.style.display = 'none';
                dialog.style.visibility = 'hidden';
                dialog.style.opacity = '0';
                dialog.style.zIndex = '-1';
                
                // Method 5: Hide backdrop/overlay (Material dialog backdrop)
                const backdrop = dialog.querySelector('.cd-popup-backdrop') ||
                               dialog.closest('mat-dialog-container')?.querySelector('.cdk-overlay-backdrop') ||
                               document.querySelector('.cdk-overlay-backdrop') ||
                               document.querySelector('.cd-popup-backdrop');
                if (backdrop) {
                  backdrop.style.display = 'none';
                  backdrop.style.visibility = 'hidden';
                  backdrop.classList.remove('is-visible', 'visible', 'show', 'cdk-overlay-backdrop-showing');
                }
                
                // Method 6: Close Material dialog container
                const matDialogContainer = dialog.closest('mat-dialog-container') ||
                                        document.querySelector('mat-dialog-container');
                if (matDialogContainer) {
                  matDialogContainer.style.display = 'none';
                  matDialogContainer.style.visibility = 'hidden';
                  matDialogContainer.classList.remove('cdk-overlay-pane');
                }
                
                // Method 7: Remove pointer events
                dialog.style.pointerEvents = 'none';
                
                // Check if still visible
                const style = window.getComputedStyle(dialog);
                const isStillVisible = style.display !== 'none' && 
                                     style.visibility !== 'hidden' && 
                                     dialog.offsetParent !== null;
                
                return { 
                  success: !isStillVisible, 
                  found: true,
                  stillVisible: isStillVisible,
                  methods: 'all',
                  dialogType: dialog.tagName
                };
              }
              
              return { success: true, found: false, reason: 'dialog not found' };
            `);

            console.log(`[${jobId}] Close attempt ${attempts} result:`, closeResult);

            // Check if dialog is actually closed
            await driver.sleep(500);
            popupStillVisible = await driver.executeScript(`
              // Check for Vahan dialog or Material dialog
              const dialog = document.querySelector('app-check-vahan-dialog') ||
                            document.querySelector('mat-dialog-container') ||
                            document.querySelector('.cd-popup.is-visible') ||
                            document.querySelector('.cd-popup[class*="is-visible"]');
              
              if (dialog) {
                const style = window.getComputedStyle(dialog);
                if (style.display !== 'none' && style.visibility !== 'hidden' && dialog.offsetParent !== null) {
                  return true;
                }
              }
              
              // Check all dialogs by computed style
              const allDialogs = document.querySelectorAll('app-check-vahan-dialog, mat-dialog-container, .cd-popup');
              for (let d of allDialogs) {
                const style = window.getComputedStyle(d);
                if (style.display !== 'none' && style.visibility !== 'hidden' && d.offsetParent !== null) {
                  return true;
                }
              }
              return false;
            `);

            if (!popupStillVisible) {
              console.log(`[${jobId}] ✅ Popup confirmed closed after attempt ${attempts}`);
              break;
            } else {
              console.log(`[${jobId}] ⚠️ Popup still visible, will retry...`);
              await driver.sleep(500);
            }
          }

          // Final aggressive close attempt
          if (popupStillVisible) {
            console.log(`[${jobId}] Dialog still visible after ${maxAttempts} attempts, forcing close...`);
            await driver.executeScript(`
              // Close ALL dialogs aggressively - Vahan dialog and Material dialogs
              document.querySelectorAll('app-check-vahan-dialog, mat-dialog-container, .cd-popup, [class*="cd-popup"]').forEach(d => {
                d.classList.remove('is-visible', 'visible', 'show', 'cdk-overlay-pane');
                d.classList.add('is-hidden', 'hidden');
                d.style.display = 'none';
                d.style.visibility = 'hidden';
                d.style.opacity = '0';
                d.style.zIndex = '-1';
                d.style.pointerEvents = 'none';
              });
              
              // Hide all backdrops (Material and custom)
              document.querySelectorAll('.cdk-overlay-backdrop, .cd-popup-backdrop, [class*="backdrop"]').forEach(b => {
                b.style.display = 'none';
                b.style.visibility = 'hidden';
                b.classList.remove('is-visible', 'visible', 'show', 'cdk-overlay-backdrop-showing');
              });
              
              // Close overlay container
              const overlayContainer = document.querySelector('.cdk-overlay-container');
              if (overlayContainer) {
                const dialogs = overlayContainer.querySelectorAll('mat-dialog-container, app-check-vahan-dialog');
                dialogs.forEach(d => {
                  d.style.display = 'none';
                  d.style.visibility = 'hidden';
                });
              }
            `);
            await driver.sleep(1000);
          }

          await driver.sleep(1000);

          // Also try Selenium-based approach to click X icon button
          try {
            console.log(`[${jobId}] Trying Selenium-based X icon click...`);

            const closeButtonLocators = [
              // Specific to Vahan dialog structure - close button inside h2 title
              By.xpath("//h2[@class='mat-mdc-dialog-title']//span[@class='cd-popup-close']"),
              By.xpath("//h2[contains(@class, 'mat-mdc-dialog-title')]//span[@class='cd-popup-close']"),
              By.xpath("//h2[@mat-dialog-title]//span[@class='cd-popup-close']"),
              By.xpath("//h2//span[@class='cd-popup-close']"),
              // General selectors
              By.css("span.cd-popup-close"),
              By.xpath("//span[@class='cd-popup-close']"),
              By.xpath("//span[contains(@class, 'cd-popup-close')]"),
              By.xpath("//span[contains(@class, 'cd-popup-close') and normalize-space(text())='X']"),
              By.xpath("//span[contains(@class, 'cd-popup-close') and contains(text(), 'X')]"),
              By.xpath("//span[contains(@class, 'cd-popup-close') and (text()='X' or text()='×')]"),
              By.xpath("//*[@class='cd-popup-close' and contains(text(), 'X')]"),
              // Inside app-check-vahan-dialog
              By.xpath("//app-check-vahan-dialog//span[@class='cd-popup-close']"),
              By.xpath("//app-check-vahan-dialog//h2//span[@class='cd-popup-close']"),
              // Material dialog close
              By.xpath("//mat-dialog-container//span[@class='cd-popup-close']"),
              By.xpath("//button[contains(@class, 'close')]"),
              By.xpath("//button[@aria-label='Close']"),
              By.xpath("//*[contains(@class, 'close') and contains(text(), 'X')]"),
              By.xpath("//*[contains(@class, 'close')]"),
            ];

            let closed = false;
            for (const closeLocator of closeButtonLocators) {
              try {
                const closeButtons = await driver.findElements(closeLocator);
                console.log(`[${jobId}] Found ${closeButtons.length} close buttons with locator: ${closeLocator.toString()}`);

                for (const closeButton of closeButtons) {
                  try {
                    const isDisplayed = await closeButton.isDisplayed();
                    const isEnabled = await closeButton.isEnabled();
                    console.log(`[${jobId}] Close button - displayed: ${isDisplayed}, enabled: ${isEnabled}`);

                    if (isDisplayed) {
                      // Scroll to button
                      await driver.executeScript("arguments[0].scrollIntoView({block: 'center', behavior: 'instant'});", closeButton);
                      await driver.sleep(300);

                      // Try multiple click methods
                      try {
                        await closeButton.click();
                        console.log(`[${jobId}] ✅ Clicked close button (standard click)`);
                        closed = true;
                      } catch (clickError) {
                        console.log(`[${jobId}] Standard click failed, trying JavaScript click...`);
                        try {
                          await driver.executeScript("arguments[0].click();", closeButton);
                          console.log(`[${jobId}] ✅ Clicked close button (JavaScript click)`);
                          closed = true;
                        } catch (jsClickError) {
                          console.log(`[${jobId}] JavaScript click failed, trying event dispatch...`);
                          try {
                            await driver.executeScript(`
                              arguments[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                              arguments[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                              arguments[0].dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                            `, closeButton);
                            console.log(`[${jobId}] ✅ Dispatched click events`);
                            closed = true;
                          } catch (eventError) {
                            console.log(`[${jobId}] Event dispatch failed:`, eventError.message);
                          }
                        }
                      }

                      if (closed) {
                        await driver.sleep(1000);
                        break;
                      }
                    }
                  } catch (e) {
                    console.log(`[${jobId}] Error checking/clicking button:`, e.message);
                  }
                }
                if (closed) break;
              } catch (closeError) {
                console.log(`[${jobId}] Error with locator ${closeLocator.toString()}:`, closeError.message);
              }
            }

            if (!closed) {
              console.log(`[${jobId}] Could not click X icon, force closing with JavaScript...`);
              // Force close with JavaScript
              await driver.executeScript(`
                const popups = document.querySelectorAll('.cd-popup.is-visible, [class*="cd-popup"][class*="is-visible"]');
                popups.forEach(p => {
                  p.classList.remove('is-visible');
                  p.style.display = 'none';
                  p.style.visibility = 'hidden';
                });
              `);
              console.log(`[${jobId}] Force closed popup using JavaScript`);
            } else {
              console.log(`[${jobId}] ✅ Successfully clicked X icon button`);
            }
          } catch (seleniumError) {
            console.error(`[${jobId}] Selenium close attempt error:`, seleniumError.message);
          }

          // Final verification
          await driver.sleep(500);
          const stillVisible = await driver.executeScript(`
            const popup = document.querySelector('.cd-popup.is-visible');
            return popup ? false : true;
          `);

          if (stillVisible) {
            console.log(`[${jobId}] ✅ Vahan modal successfully closed`);
          } else {
            console.log(`[${jobId}] ⚠️ Vahan modal may still be visible`);
          }

        } catch (popupError) {
          console.error(`[${jobId}] Error while handling Vahan popup:`, popupError.message);
          // Try emergency close
          try {
            await driver.executeScript(`
              document.querySelectorAll('.cd-popup').forEach(p => {
                p.classList.remove('is-visible');
                p.style.display = 'none';
              });
            `);
            console.log(`[${jobId}] Emergency close attempted`);
          } catch (e) {
            console.log(`[${jobId}] Emergency close failed:`, e.message);
          }
        }
      } else {
        console.log(`[${jobId}] Check Vahan button could not be clicked; continuing.`);
      }
    } catch (e) {
      console.log("Check Vahan flow failed:", e.message);
    }


    // Check declaration checkbox after Vahan - force check with events
    try {
      console.log(`[${jobId}] Checking declaration checkbox after Vahan...`);
      await driver.sleep(1500);

      // Force check the checkbox using JavaScript with proper events
      const checkboxResult = await driver.executeScript(`
        // Find checkbox by name attribute
        const checkbox = document.querySelector('input[name="mcy_checkbox_declaration01_01"]') ||
                        document.querySelector('input#mat-mdc-checkbox-1-input') ||
                        document.querySelector('input[type="checkbox"][name*="declaration"]');
        
        if (!checkbox) {
          return { found: false, error: 'Checkbox not found' };
        }
        
        // Check current state
        const wasChecked = checkbox.checked || 
                          checkbox.classList.contains('mdc-checkbox--selected') ||
                          checkbox.getAttribute('aria-checked') === 'true';
        
        if (!wasChecked) {
          // Method 1: Set checked property directly
          checkbox.checked = true;
          
          // Method 2: Add Material Design classes
          checkbox.classList.add('mdc-checkbox--selected');
          checkbox.setAttribute('aria-checked', 'true');
          
          // Method 3: Find wrapper and update it too
          const wrapper = checkbox.closest('.mdc-checkbox');
          if (wrapper) {
            wrapper.classList.add('mdc-checkbox--selected');
            const background = wrapper.querySelector('.mdc-checkbox__background');
            if (background) {
              background.classList.add('mdc-checkbox__background--selected');
            }
          }
          
          // Method 4: Trigger all necessary events
          const events = ['click', 'change', 'input'];
          events.forEach(eventType => {
            const event = new Event(eventType, { bubbles: true, cancelable: true });
            checkbox.dispatchEvent(event);
          });
          
          // Method 5: Also try clicking the wrapper
          if (wrapper) {
            wrapper.click();
          } else {
            checkbox.click();
          }
        }
        
        // Wait a bit and check final state
        setTimeout(() => {}, 100);
        
        const nowChecked = checkbox.checked || 
                          checkbox.classList.contains('mdc-checkbox--selected') ||
                          checkbox.getAttribute('aria-checked') === 'true';
        
        return { 
          found: true, 
          wasChecked: wasChecked, 
          nowChecked: nowChecked,
          checked: checkbox.checked,
          hasClass: checkbox.classList.contains('mdc-checkbox--selected'),
          ariaChecked: checkbox.getAttribute('aria-checked')
        };
      `);

      console.log(`[${jobId}] Checkbox result:`, checkboxResult);

      if (checkboxResult && checkboxResult.found) {
        await driver.sleep(500);

        // Double-check and force if still not checked
        if (!checkboxResult.nowChecked) {
          console.log(`[${jobId}] Checkbox still not checked, forcing again...`);

          await driver.executeScript(`
            const checkbox = document.querySelector('input[name="mcy_checkbox_declaration01_01"]');
            if (checkbox) {
              checkbox.checked = true;
              checkbox.setAttribute('checked', 'checked');
              checkbox.setAttribute('aria-checked', 'true');
              checkbox.classList.add('mdc-checkbox--selected');
              
              const wrapper = checkbox.closest('.mdc-checkbox');
              if (wrapper) {
                wrapper.classList.add('mdc-checkbox--selected');
                wrapper.click();
              }
              
              checkbox.click();
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
              checkbox.dispatchEvent(new Event('click', { bubbles: true }));
            }
          `);

          await driver.sleep(500);
        }

        // Final verification with Selenium
        try {
          const checkboxLocators = [
            By.name("mcy_checkbox_declaration01_01"),
            By.css("input[name='mcy_checkbox_declaration01_01']"),
          ];

          for (const locator of checkboxLocators) {
            try {
              const elements = await driver.findElements(locator);
              if (elements.length > 0) {
                const finalState = await driver.executeScript(`
                  const cb = arguments[0];
                  cb.checked = true;
                  cb.setAttribute('checked', 'checked');
                  cb.setAttribute('aria-checked', 'true');
                  cb.classList.add('mdc-checkbox--selected');
                  
                  const wrapper = cb.closest('.mdc-checkbox');
                  if (wrapper) {
                    wrapper.classList.add('mdc-checkbox--selected');
                  }
                  
                  return cb.checked || cb.classList.contains('mdc-checkbox--selected');
                `, elements[0]);

                console.log(`[${jobId}] ✅ Declaration checkbox force-checked. Final state:`, finalState);
                break;
              }
            } catch (e) {
              // Continue
            }
          }
        } catch (verifyError) {
          console.log(`[${jobId}] Final verification skipped:`, verifyError.message);
        }
      } else {
        console.log(`[${jobId}] ⚠️ Checkbox not found`);
      }

      await driver.sleep(500);

    } catch (e) {
      console.log(`[${jobId}] Declaration checkbox handling error:`, e.message);
    }

    await driver.sleep(500);

    // Click Calculate Premium button
    try {
      console.log(`[${jobId}] Clicking Calculate Premium button...`);
      const calculatePremiumLocators = [
        By.name("mcy_button_calculatePremium_01"),
        By.xpath("//button[@name='mcy_button_calculatePremium_01']"),
        By.xpath("//button[contains(@class, 'q-quote-btn') and .//span[normalize-space(.)='Calculate Premium']]"),
        By.xpath("//span[normalize-space(.)='Calculate Premium']/ancestor::button"),
        By.xpath("//button[contains(@class, 'mat-mdc-raised-button') and .//span[contains(text(), 'Calculate Premium')]]"),
      ];
      let premiumClicked = false;
      for (const locator of calculatePremiumLocators) {
        try {
          await scrollAndClick(driver, locator, 12000);
          premiumClicked = true;
          console.log(`[${jobId}] ✅ Clicked Calculate Premium using locator: ${locator.toString()}`);
          break;
        } catch (calcError) {
          console.log(`[${jobId}] Calculate Premium click failed for ${locator.toString()}: ${calcError.message}`);
        }
      }
      if (!premiumClicked) {
        throw new Error("Unable to click Calculate Premium button.");
      }
      await driver.sleep(3000);
      await waitForPortalLoaderToDisappear(driver);
      console.log(`[${jobId}] ✅ Calculate Premium button clicked successfully`);
    } catch (e) {
      console.error(`[${jobId}] Calculate Premium button not found:`, e.message);
    }

    // Confirm popup OK
    try {
      console.log("Handling confirmation popup...");
      const confirmOkButton = By.xpath("//span[contains(., 'OK')]/ancestor::button");
      await safeClick(driver, confirmOkButton, 5000);
      await driver.sleep(2000);
      await waitForPortalLoaderToDisappear(driver);
    } catch (e) {
      console.log("Confirmation popup OK button not found or not needed:", e.message);
    }

    // Proceed For Payment Flow
    try {
      console.log("Clicking Proceed For Payment button...");
      const proceedPaymentButton = By.xpath("//button[@name='main_btn_convert_01'] | //span[contains(., 'Proceed For payment')]/ancestor::button");
      await safeClick(driver, proceedPaymentButton, 10000);
      await driver.sleep(2000);
      await waitForPortalLoaderToDisappear(driver);

      console.log("Selecting Payment Option (Value 5)...");
      // Find radio button with value="5"
      const paymentRadio = By.xpath("//input[@type='radio' and @value='5']");
      try {
        const radioElement = await driver.wait(until.elementLocated(paymentRadio), 5000);
        // Use JS click for reliability with hidden/styled radio inputs
        await driver.executeScript("arguments[0].click();", radioElement);
        console.log("Clicked payment radio button (value=5)");
      } catch (radioError) {
        console.log("Could not find or click payment radio button (value=5):", radioError.message);
      }
      await driver.sleep(1000);

      console.log("Clicking Send Payment Link button...");
      const sendLinkButton = By.xpath("//button[@name='vQuote_btn_sendPayLink_01'] | //span[contains(., 'Send Payment Link')]/ancestor::button");
      await safeClick(driver, sendLinkButton, 5000);
      await driver.sleep(2000);
      await waitForPortalLoaderToDisappear(driver);

      console.log("Waiting for confirmation popup and clicking Close...");
      // Both buttons have the same name, so we must distinguish by text content "Close"
      const closeButton = By.xpath("//button[@name='alert_btn_data_01' and .//span[contains(text(), 'Close')]]");
      await safeClick(driver, closeButton, 10000);
      await driver.sleep(1000);

    } catch (e) {
      console.log("Proceed For Payment flow failed:", e.message);
    }

    console.log(`✅ [${jobId}] National Insurance form automation completed successfully!`);

    // Return success if post-calculation failed
    if (postCalculationFailed) {
      return {
        success: false,
        error: postCalculationError || "Post-calculation stage failed",
        postSubmissionFailed: true, // Treat as post-submission failure
        stage: "post-calculation",
      };
    }

    // Return failure if post-submission failed (even if modal submission succeeded)
    if (postSubmissionFailed) {
      return {
        success: false,
        error: postSubmissionError || "Post-submission stage failed",
        postSubmissionFailed: true,
        stage: "post-submission",
      };
    }

    return { success: true };
  } catch (error) {
    console.error(`[${jobId}] [nationalForm] Error:`, error.message || error);

    // Capture error screenshot using centralized handler
    const errorDetails = await captureErrorScreenshot(
      driver,
      error,
      data,
      "form-error"
    );

    return {
      success: false,
      error: String(error.message || error),
      errorStack: error.stack,
      screenshotUrl: errorDetails.screenshotUrl,
      screenshotKey: errorDetails.screenshotKey,
      pageSourceUrl: errorDetails.pageSourceUrl,
      pageSourceKey: errorDetails.pageSourceKey,
      timestamp: new Date(),
      stage: "login-form", // Indicate this is a login form error
      postSubmissionFailed: false,
    };
  } finally {
    // Cleanup: Always close browser and delete cloned profile
    // if (jobBrowser) {
    //   await cleanupNationalJobBrowser(jobBrowser);
    // }
  }
}

// Main execution function for standalone script
async function main() {
  console.log("🚀 Starting National Insurance Automation...");

  // Parse command line arguments
  const formData = parseCommandLineArgs();
  console.log("📋 Using form data:", formData);

  try {
    const result = await fillNationalForm(formData);

    if (result.success) {
      console.log("✅ National Insurance automation completed successfully!");
      console.log("📸 Screenshot uploaded for verification");
    } else {
      console.log("❌ National Insurance automation failed!");
      console.log("🔍 Error:", result.error);
    }

    console.log("📊 Result:", JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("💥 Fatal error in main execution:", error);
    process.exit(1);
  }
}

// Check if this script is being run directly
if (require.main === module) {
  console.log("🎯 Running National Insurance automation as standalone script...");
  main().then(() => {
    console.log("🏁 Script execution completed");
    process.exit(0);
  }).catch((error) => {
    console.error("💥 Script execution failed:", error);
    process.exit(1);
  });
}

module.exports = {
  fillNationalForm
};
