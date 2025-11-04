const { By, until, Key } = require("selenium-webdriver");
const { createFreshDriverFromBaseProfile } = require("./browser");
const {
  createJobBrowser,
  cleanupJobBrowser,
  reLoginIfNeeded,
  recoveryManager,
} = require("./sessionManager");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("./Captcha");
const { uploadScreenshotToS3, generateScreenshotKey } = require("./s3Uploader");

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

async function safeClick(driver, locator, timeout = 15000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  try {
    await el.click();
  } catch {
    await driver.executeScript("arguments[0].click();", el);
  }
  return el;
}

async function forceSendKeys(driver, locator, text, timeout = 10000) {
  try {
    const element = await driver.wait(until.elementLocated(locator), timeout);
    // No visibility check, just scroll and set value
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center'});",
      element
    );
    await driver.sleep(500);
    await driver.executeScript(
      `
      arguments[0].value = '${text}';
      var event = new Event('input', { bubbles: true });
      arguments[0].dispatchEvent(event);
    `,
      element
    );
    console.log(`Forced sending keys to ${locator}`);
    return element;
  } catch (error) {
    console.log(`Error in forceSendKeys for ${locator}:`, error.message);
    throw error;
  }
}

async function safeSendKeys(driver, locator, text, timeout = 10000) {
  try {
    const element = await driver.wait(until.elementLocated(locator), timeout);
    await driver.wait(until.elementIsVisible(element), timeout);
    await driver.wait(until.elementIsEnabled(element), timeout);
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center'});",
      element
    );
    await driver.sleep(500);

    try {
      await element.clear();
      await element.sendKeys(text);
    } catch {
      await driver.executeScript(
        `
        arguments[0].value = '';
        arguments[0].value = '${text}';
        var event = new Event('input', { bubbles: true });
        arguments[0].dispatchEvent(event);
      `,
        element
      );
    }
    return element;
  } catch (error) {
    console.log(`Error in safeSendKeys for ${locator}:`, error.message);
    throw error;
  }
}

async function safeSelectDropdown(driver, selectId, value, timeout = 10000) {
  try {
    const selectElement = await driver.wait(
      until.elementLocated(By.id(selectId)),
      timeout
    );
    await driver.wait(until.elementIsVisible(selectElement), timeout);
    await driver.wait(until.elementIsEnabled(selectElement), timeout);
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center'});",
      selectElement
    );
    await driver.sleep(500);

    await driver.executeScript(`
      var select = document.getElementById("${selectId}");
      if (select) {
        select.value = "${value}";
        var event = new Event('change', { bubbles: true });
        select.dispatchEvent(event);
      }
    `);

    await driver.sleep(2000);
    return selectElement;
  } catch (error) {
    console.log(`Error in safeSelectDropdown for ${selectId}:`, error.message);
    throw error;
  }
}

async function waitForElementAndRetry(
  driver,
  locator,
  action,
  maxRetries = 3,
  timeout = 10000
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} for ${locator}...`);
      const element = await driver.wait(until.elementLocated(locator), timeout);
      await driver.wait(until.elementIsVisible(element), timeout);
      await driver.wait(until.elementIsEnabled(element), timeout);
      await driver.executeScript(
        "arguments[0].scrollIntoView({block: 'center'});",
        element
      );
      await driver.sleep(500);

      if (action === "click") {
        try {
          await element.click();
        } catch {
          await driver.executeScript("arguments[0].click();", element);
        }
      } else if (action === "sendKeys") {
        // This function will be handled by safeSendKeys
        return element;
      }

      return element;
    } catch (error) {
      console.log(`Attempt ${attempt} failed:`, error.message);
      if (attempt === maxRetries) {
        throw error;
      }
      await driver.sleep(2000);
    }
  }
}

async function deleteDirectoryRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) await deleteDirectoryRecursive(full);
    else fs.unlinkSync(full);
  }
  try {
    fs.rmdirSync(dirPath);
  } catch {}
}

/**
 * Centralized error screenshot handler
 * Captures screenshot and uploads to S3 for any error
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {Error} error - The error object
 * @param {Object} data - Job data containing identifiers
 * @param {string} errorStage - Stage where error occurred (e.g., "modal-filling", "vehicle-details")
 * @returns {Promise<Object>} - Returns error details with screenshot URL
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
      console.log("⚠️  No driver available for screenshot");
      return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
    }

    const screenshot = await driver.takeScreenshot();
    const jobIdentifier = data._jobIdentifier || `job_${Date.now()}`;
    const attemptNumber = data._attemptNumber || 1;

    // Generate S3 key and upload screenshot
    screenshotKey = generateScreenshotKey(
      jobIdentifier,
      attemptNumber,
      errorStage
    );
    screenshotUrl = await uploadScreenshotToS3(screenshot, screenshotKey);

    console.log(`📸 Error screenshot uploaded to S3: ${screenshotUrl}`);

    // Also capture page source for debugging (optional)
    try {
      const pageSource = await driver.getPageSource();
      pageSourceKey = screenshotKey.replace(".png", ".html");
      const tempHtmlPath = path.join(
        __dirname,
        `temp-page-source-${Date.now()}.html`
      );
      fs.writeFileSync(tempHtmlPath, pageSource);

      const { uploadToS3 } = require("./s3Uploader");
      pageSourceUrl = await uploadToS3(tempHtmlPath, pageSourceKey);

      fs.unlinkSync(tempHtmlPath); // Delete temp file
      console.log(`📄 Page source uploaded to S3: ${pageSourceUrl}`);
    } catch (sourceErr) {
      console.log("⚠️  Could not capture page source:", sourceErr.message);
    }

    // Log to MongoDB if available
    if (data._jobId && data._jobQueueCollection) {
      const errorLog = {
        timestamp: new Date(),
        attemptNumber: attemptNumber,
        errorMessage: error.message || String(error),
        errorType: error.name || "UnknownError",
        errorStack: error.stack || null,
        screenshotUrl: screenshotUrl,
        screenshotKey: screenshotKey,
        pageSourceUrl: pageSourceUrl,
        pageSourceKey: pageSourceKey,
        stage: errorStage,
      };

      await data._jobQueueCollection.updateOne(
        { _id: data._jobId },
        {
          $push: { errorLogs: errorLog },
          $set: { [`last_${errorStage}_error`]: errorLog },
        }
      );

      console.log(`✅ Error logged to job queue (stage: ${errorStage})`);
    }
  } catch (captureErr) {
    console.error(
      `❌ Failed to capture/upload error screenshot:`,
      captureErr.message
    );
  }

  return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
}

/**
 * Login on cloned browser when session is expired
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} jobId - Job identifier for logging
 * @param {Object} credentials - { username, password }
 * @returns {Promise<boolean>} - true if login successful
 */
async function loginOnClonedBrowser(driver, jobId, credentials) {
  try {
    console.log(`🔐 [${jobId}] Attempting login on cloned browser...`);

    // Capture captcha
    console.log(`📸 [${jobId}] Capturing captcha...`);
    await getCaptchaScreenShot(driver, `reliance_captcha_${jobId}`);
    const filePath = path.join(__dirname, `reliance_captcha_${jobId}.png`);

    if (!fs.existsSync(filePath)) {
      console.error(`❌ [${jobId}] Captcha screenshot not found`);
      return false;
    }

    const fileData = fs.readFileSync(filePath, "base64");
    const imageUrl = `data:image/jpeg;base64,${fileData}`;
    const captchaResult = await extractCaptchaText(imageUrl);
    const captchaText = captchaResult?.text?.replace(/\s+/g, "");

    // Clean up captcha file
    try {
      fs.unlinkSync(filePath);
    } catch (e) {}

    if (!captchaText) {
      console.error(`❌ [${jobId}] Failed to extract captcha text`);
      return false;
    }

    console.log(`🔑 [${jobId}] Captcha extracted: ${captchaText}`);

    // Fill login form
    console.log(`📝 [${jobId}] Filling login credentials...`);
    await driver.findElement(By.id("txtUserName")).clear();
    await driver
      .findElement(By.id("txtUserName"))
      .sendKeys(credentials.username);
    await driver.sleep(500);

    await driver.findElement(By.id("txtPassword")).clear();
    await driver
      .findElement(By.id("txtPassword"))
      .sendKeys(credentials.password);
    await driver.sleep(500);

    await driver.findElement(By.id("CaptchaInputText")).clear();
    await driver.findElement(By.id("CaptchaInputText")).sendKeys(captchaText);
    await driver.sleep(1000);

    // Click login button
    console.log(`🚀 [${jobId}] Clicking login button...`);
    await driver.findElement(By.id("btnLogin")).click();

    // Wait for login to complete
    console.log(`⏳ [${jobId}] Waiting for login to complete...`);
    await driver.sleep(5000);

    // Verify login successful by checking for dashboard elements
    const motorsElements = await driver.findElements(By.id("divMainMotors"));
    const logoutElements = await driver.findElements(By.id("divLogout"));

    if (motorsElements.length > 0 || logoutElements.length > 0) {
      console.log(`✅ [${jobId}] Login successful on cloned browser!`);
      return true;
    } else {
      console.error(
        `❌ [${jobId}] Login verification failed - dashboard elements not found`
      );
      return false;
    }
  } catch (error) {
    console.error(
      `❌ [${jobId}] Error during cloned browser login:`,
      error.message
    );
    return false;
  }
}

/**
 * Detect if cloned session is expired and login if needed
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} jobId - Job identifier for logging
 * @param {Object} credentials - { username, password }
 * @returns {Promise<boolean>} - true if session is valid, false if unrecoverable
 */
async function checkAndRecoverClonedSession(driver, jobId, credentials) {
  try {
    console.log(`\n🔍 [${jobId}] Verifying cloned session status...`);

    // Check 1: Are we on the login page? (txtUserName field exists)
    const loginElements = await driver.findElements(By.id("txtUserName"));

    if (loginElements.length > 0) {
      console.error(`\n⚠️  [${jobId}] CLONED SESSION EXPIRED - On login page!`);
      console.log(
        `🔐 [${jobId}] Will attempt to login on this cloned browser...\n`
      );

      // Try to login directly on this cloned browser (max 3 attempts)
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(
          `🔄 [${jobId}] Login attempt ${attempt}/3 on cloned browser...`
        );

        const loginSuccess = await loginOnClonedBrowser(
          driver,
          jobId,
          credentials
        );

        if (loginSuccess) {
          console.log(
            `✅ [${jobId}] Successfully logged in on cloned browser!`
          );
          console.log(
            `✅ [${jobId}] Session is now valid, continuing with form filling...\n`
          );
          return true; // Login succeeded, session now valid
        }

        console.warn(`⚠️  [${jobId}] Login attempt ${attempt}/3 failed`);

        if (attempt < 3) {
          console.log(`⏳ [${jobId}] Waiting 3 seconds before retry...`);
          await driver.sleep(3000);

          // Refresh page for new captcha
          await driver.get(
            "https://smartzone.reliancegeneral.co.in/Login/IMDLogin"
          );
          await driver.sleep(2000);
        }
      }

      // All login attempts on clone failed
      console.error(
        `\n❌ [${jobId}] All 3 login attempts failed on cloned browser!`
      );
      console.log(
        `🔄 [${jobId}] Triggering master session recovery as backup...`
      );

      // Check if another job is already recovering the master session
      if (recoveryManager.isRecovering) {
        console.log(`⏳ [${jobId}] Waiting for ongoing master recovery...`);
      }

      // Trigger master session recovery as backup
      const masterRecovered = await reLoginIfNeeded();

      if (masterRecovered) {
        console.log(`✅ [${jobId}] Master session recovered!`);
        console.error(
          `❌ [${jobId}] Will retry job with fresh clone from recovered master\n`
        );
      }

      // Return false to force job retry
      return false;
    }

    // Check 2: Look for dashboard elements (divMainMotors or divLogout)
    const dashboardElements = await driver.findElements(By.id("divMainMotors"));
    const logoutElements = await driver.findElements(By.id("divLogout"));

    if (dashboardElements.length > 0 || logoutElements.length > 0) {
      console.log(
        `✅ [${jobId}] Cloned session is ACTIVE - Dashboard detected\n`
      );
      return true;
    }

    // Check 3: Check current URL
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes("/Login/IMDLogin") && !currentUrl.includes("?")) {
      console.error(
        `\n⚠️  [${jobId}] CLONED SESSION EXPIRED - Login URL detected!`
      );

      // Check if recovery already in progress
      if (recoveryManager.isRecovering) {
        console.log(
          `⏳ [${jobId}] Waiting for ongoing master session recovery...`
        );
      } else {
        console.log(`🔄 [${jobId}] Triggering master session recovery...`);
      }

      const masterRecovered = await reLoginIfNeeded();

      if (masterRecovered) {
        console.log(`✅ [${jobId}] Master session recovered!`);
        console.error(`❌ [${jobId}] Current cloned session is STALE\n`);
      }

      return false;
    }

    // Uncertain state - wait and recheck
    console.log(
      `⏳ [${jobId}] Uncertain state, waiting 3s for page to load...`
    );
    await driver.sleep(3000);

    const finalCheck = await driver.findElements(By.id("divMainMotors"));
    if (finalCheck.length > 0) {
      console.log(
        `✅ [${jobId}] Cloned session is ACTIVE - Dashboard found after wait\n`
      );
      return true;
    }

    console.error(
      `\n⚠️  [${jobId}] CLONED SESSION likely EXPIRED - No dashboard elements\n`
    );

    // Trigger recovery as a precaution (will wait if already in progress)
    if (!recoveryManager.isRecovering) {
      console.log(
        `🔄 [${jobId}] Triggering master session recovery as precaution...`
      );
    } else {
      console.log(`⏳ [${jobId}] Waiting for ongoing recovery...`);
    }

    await reLoginIfNeeded();

    return false;
  } catch (error) {
    console.error(
      `❌ [${jobId}] Error checking cloned session:`,
      error.message
    );

    // On error, trigger recovery as a precaution (will wait if already in progress)
    try {
      if (!recoveryManager.isRecovering) {
        console.log(`🔄 [${jobId}] Triggering recovery due to check error...`);
      } else {
        console.log(`⏳ [${jobId}] Waiting for ongoing recovery...`);
      }

      await reLoginIfNeeded();
    } catch (recoveryError) {
      console.error(
        `❌ [${jobId}] Recovery also failed:`,
        recoveryError.message
      );
    }

    return false;
  }
}

async function fillRelianceForm(
  data = { username: "rfcpolicy", password: "Pass@123" }
) {
  const jobId = `${data.firstName || "Job"}_${Date.now()}`;
  let jobBrowser = null;
  let driver = null;
  let postSubmissionFailed = false;
  let postSubmissionError = null;
  let postCalculationFailed = false;
  let postCalculationError = null;

  try {
    // === STEP 0: Create cloned browser (already logged in!) ===
    console.log(`\n🚀 [${jobId}] Starting job...`);
    jobBrowser = await createJobBrowser(jobId);
    driver = jobBrowser.driver;

    console.log(`✅ [${jobId}] Browser ready with active session!`);
    console.log(`🌐 [${jobId}] Navigating to form...`);

    // Navigate to the form page (already logged in from cloned profile!)
    await driver.get("https://smartzone.reliancegeneral.co.in/Login/IMDLogin");
    await driver.sleep(3000);

    // === STEP 1: Check if cloned session is expired ===
    // This detects if we cloned an expired session and attempts to login on cloned browser
    const credentials = {
      username: data.username || "rfcpolicy",
      password: data.password || "Pass@123",
    };

    const sessionValid = await checkAndRecoverClonedSession(
      driver,
      jobId,
      credentials
    );

    if (!sessionValid) {
      // Session could not be established on cloned browser
      // All login attempts failed, job will retry
      throw new Error(
        "Cloned session login failed after all attempts. Job will retry."
      );
    }

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

    await driver
      .actions({ bridge: true })
      .move({ origin: motorsMenu })
      .perform();
    await driver.sleep(3000);
    console.log("Hovered on Motors menu...");

    // === STEP 3: click Two Wheeler ===
    const twoWheelerLink = await driver.wait(
      until.elementLocated(By.xpath("//li/a[contains(text(),'Two Wheeler')]")),
      15000
    );
    await driver
      .actions({ bridge: true })
      .move({ origin: twoWheelerLink })
      .perform();
    await driver.wait(until.elementIsVisible(twoWheelerLink), 10000);
    await driver.wait(until.elementIsEnabled(twoWheelerLink), 10000);
    try {
      await twoWheelerLink.click();
    } catch {
      await driver.executeScript("arguments[0].click();", twoWheelerLink);
    }
    console.log("Clicked Two Wheeler link!");
    await driver.sleep(4000);
    // === STEP 4: select "Two Wheeler Package Bundled (Only New Veh.)" ===
    console.log("Selecting Sub Product...");

    // The old way of setting value via javascript might not trigger all events.
    // We will simulate a user clicking the dropdown and selecting an option.

    // 1. Find and click the Kendo dropdown to make the options visible.
    const dropdown = await driver.wait(
      until.elementLocated(
        By.css("span[aria-owns='ddlMotorProducts_listbox']")
      ),
      15000
    );
    await driver.executeScript("arguments[0].scrollIntoView(true);", dropdown);
    await driver.sleep(500);
    await dropdown.click();
    await driver.sleep(1000); // Wait for dropdown animation

    // 2. Find the specific option in the popup list and click it.
    const optionText = "Two Wheeler Package Bundled (Only New Veh.)";
    // The options are in a popup, so we search the whole document.
    const optionElement = await driver.wait(
      until.elementLocated(
        By.xpath(`//li[normalize-space(.) = '${optionText}']`)
      ),
      10000
    );
    await driver.wait(until.elementIsVisible(optionElement), 5000);
    await optionElement.click();

    console.log("Selected product by simulating user click.");
    await driver.sleep(2000); // Give time for the API call to be made.

    console.log("Handling Skip page and checkbox...");

    // === STEP 5: Skip link ===
    try {
      const skipLink = await driver.wait(
        until.elementLocated(
          By.xpath("//a[contains(text(),'Skip To Main Page')]")
        ),
        5000
      );
      await driver.executeScript("arguments[0].click();", skipLink);
      console.log("Clicked 'Skip To Main Page'");
      await driver.sleep(2000);
    } catch (err) {
      console.log("No skip link detected, continuing...");
    }

    // ==  vertical code dropdown ===

    try {
      const dropdownInput = await driver.findElement(
        By.id("ddlobjBranchDetailAgentsHnin")
      );

      // Wait until Kendo is initialized
      await driver.wait(async () => {
        return await driver.executeScript(`
          return !!$("#ddlobjBranchDetailAgentsHnin").data("kendoDropDownList");
        `);
      }, 10000);

      // Check current text/value
      const currentValue = await driver.executeScript(`
        var dropdown = $("#ddlobjBranchDetailAgentsHnin").data("kendoDropDownList");
        return dropdown ? dropdown.text() : null;
      `);

      console.log("Current dropdown value:", currentValue);

      if (!currentValue || currentValue.trim() === "Select") {
        await driver.executeScript(`
          var dropdown = $("#ddlobjBranchDetailAgentsHnin").data("kendoDropDownList");
          if (dropdown) {
            dropdown.select(1); // Select first valid option (index 1)
            dropdown.trigger("change");
          }
        `);
        console.log("✅ Selected first option in Kendo dropdown");
      } else {
        console.log("☑️ Dropdown already has a selected value:", currentValue);
      }
    } catch (err) {
      console.error("❌ Could not select Kendo dropdown option:", err.message);
    }

    // === STEP 6: Checkbox + iframe form ===
    try {
      const ispCheckbox = await driver.wait(
        until.elementLocated(By.id("ISPANNotAvailable")),
        5000
      );
      await driver.executeScript("arguments[0].click();", ispCheckbox);
      console.log("Checked ISPANNotAvailable checkbox");

      const iframeEl = await driver.wait(
        until.elementLocated(By.css("#ClientForm60DetailsWindow iframe")),
        10000
      );
      console.log("Modal iframe detected!");

      await driver.switchTo().frame(iframeEl);
      console.log("Switched to modal iframe");

      // Wait for form to be fully loaded
      await driver.sleep(5000);

      // === Fill mandatory fields with safe methods ===
      console.log("Filling form fields...");

      // Proposer Title
      await safeSelectDropdown(
        driver,
        "proposerTitle1",
        data.proposerTitle || "Mr."
      );

      // Name fields
      await safeSendKeys(driver, By.id("FirstName"), data.firstName || "John");
      // await safeSendKeys(driver, By.id("MiddleName"), data.middleName || "M");
      await safeSendKeys(driver, By.id("LastName"), data.lastName || "Doe");

      // DOB - Special handling for date field
      console.log("Filling DOB field...");
      const dobField = await waitForElementAndRetry(
        driver,
        By.id("dob"),
        "sendKeys"
      );
      await driver.executeScript(
        `
        arguments[0].value = '';
        arguments[0].value = '${data.dob || "06-10-2007"}';
        var event = new Event('input', { bubbles: true });
        arguments[0].dispatchEvent(event);
      `,
        dobField
      );

      // Father's details
      await safeSelectDropdown(
        driver,
        "proposerTitle2",
        data.fatherTitle || "Mr."
      );
      await safeSendKeys(
        driver,
        By.name("FatherFirstName"),
        data.fatherName || "Robert"
      );

      // Address fields
      await safeSendKeys(driver, By.id("flat"), data.flatNo || "101");
      await safeSendKeys(driver, By.id("floor"), data.floorNo || "1");
      await safeSendKeys(
        driver,
        By.id("Nameofpremises"),
        data.premisesName || "Sunshine Apartments"
      );
      await safeSendKeys(driver, By.id("block"), data.blockNo || "A");
      await safeSendKeys(driver, By.id("road"), data.road || "MG Road");
      await safeSendKeys(driver, By.id("area"), data.road || "MG Road");

      // === ADDRESS DROPDOWNS - Simplified approach ===
      console.log("Filling address dropdowns...");

      // 1. Select State only (skip dependent dropdowns)
      await safeSelectDropdown(driver, "state", data.state || "30"); // KARNATAKA
      console.log("Selected State");
      await driver.sleep(2000);

      // 2. Use Pincode Search field and select first result
      console.log("Using pincode search field...");
      const pincodeInput = await safeSendKeys(
        driver,
        By.id("pincodesearch"),
        data.pinCode || "614630"
      );
      await driver.sleep(4000);

      // Select the first item from the dropdown by pressing Arrow Down and then Enter.
      console.log("Selecting first pincode result from dropdown...");
      await pincodeInput.sendKeys(Key.ARROW_DOWN);
      await driver.sleep(1000);
      await pincodeInput.sendKeys(Key.ENTER);

      await waitForLoaderToDisappear(driver);
      await driver.sleep(500);

      // Continue with other fields
      // await safeSendKeys(driver, By.id("area"), data.area || "MG Road");

      // Phone fields
      await safeSendKeys(
        driver,
        By.id("mobileno"),
        data.mobile || "8838166045"
      );

      console.log("Filled all main form mandatory fields!");
      await driver.sleep(2000);

      // === STEP 7: Submit Button ===
      console.log("Looking for submit button...");
      await waitForElementAndRetry(driver, By.id("btnSubmit"), "click");
      console.log("Clicked Submit button!");

      // Wait for submission to process
      await driver.sleep(5000);
      console.log("Form submission attempted!");

      // Back to main content
      await driver.switchTo().defaultContent();

      // === STEP 8: Handle post-submission elements ===

      console.log("Looking for post-submission elements...");

      try {
        // // Wait for the Vertical Code dropdown
        // console.log("Waiting for Vertical Code dropdown...");
        // const verticalCodeDropdown = await driver.wait(
        //   until.elementLocated(By.id("ddlobjBranchDetailAgentsHnin")),
        //   15000
        // );
        // console.log("Vertical Code dropdown found!");

        const emailInput = await driver.findElement(By.id("txtEmailID"));
        await emailInput.sendKeys(data?.email);

        // // Click on the dropdown to open it
        // await driver.executeScript(
        //   "arguments[0].click();",
        //   verticalCodeDropdown
        // );
        // await driver.sleep(2000);
        // console.log("Vertical Code dropdown clicked!");

        // Select "GIRNAR FINSERV PRIVATE LIMITED_518898" option
        // console.log("Selecting GIRNAR FINSERV PRIVATE LIMITED_518898...");
        // const girnarOption = await driver.wait(
        //   until.elementLocated(
        //     By.xpath(
        //       "//li[contains(text(), 'GIRNAR FINSERV PRIVATE LIMITED_518898')]"
        //     )
        //   ),
        //   10000
        // );
        // await driver.executeScript("arguments[0].click();", girnarOption);
        // console.log("Selected GIRNAR FINSERV PRIVATE LIMITED_518898!");
        // await driver.sleep(2000);

        // Wait for and click the "Validate Customer" button
        console.log("Looking for Validate Customer button...");
        const validateButton = await driver.wait(
          until.elementLocated(By.id("BtnSaveClientDetails")),
          10000
        );
        await driver.wait(until.elementIsVisible(validateButton), 5000);
        await driver.wait(until.elementIsEnabled(validateButton), 5000);

        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          validateButton
        );
        await driver.sleep(500);

        try {
          await validateButton.click();
        } catch {
          await driver.executeScript("arguments[0].click();", validateButton);
        }
        console.log("Validate Customer button clicked!");

        try {
          const dialog = await driver.wait(
            until.elementLocated(
              By.css(
                'div.ui-dialog[aria-describedby="divCustomerAlreadyExist"]'
              )
            ),
            3000 // wait up to 3 seconds for the popup to appear
          );

          if (await dialog.isDisplayed()) {
            console.log("⚠️ 'Customer Already Exists' dialog detected.");

            // Click the "Cancel" button inside the dialog
            const cancelButton = await dialog.findElement(
              By.xpath(".//button/span[text()='Cancel']")
            );
            await cancelButton.click();
            console.log("🚫 Pop-up closed by clicking 'Cancel'.");
          }
        } catch (e) {
          console.log("No pop-up detected, continuing...");
        }

        // Wait for validation to process
        await driver.sleep(3000);
        console.log("Customer validation attempted!");

        // === STEP 9: Fill Vehicle Details ===
        console.log("Filling vehicle details...");

        // Vehicle Make/Model autocomplete
        console.log("Filling vehicle make/model...");
        const vehicleMakeInput = await driver.wait(
          until.elementLocated(By.id("VehicleDetailsMakeModel")),
          10000
        );
        await driver.wait(until.elementIsVisible(vehicleMakeInput), 5000);
        await driver.wait(until.elementIsEnabled(vehicleMakeInput), 5000);
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          vehicleMakeInput
        );
        await driver.sleep(500);

        // Clear the field first
        await vehicleMakeInput.clear();
        await driver.sleep(500);

        // Click on the input to focus it
        await vehicleMakeInput.click();
        await driver.sleep(500);

        // Type the search text and trigger events
        const vehicleSearchText =  data.vehicleModel 
          ? `${data.vehicleMake} ${data.vehicleModel}`
          : "tvs scooty zest";
        await vehicleMakeInput.sendKeys(vehicleSearchText);
        await driver.sleep(1000);

        // Trigger additional events to ensure autocomplete works
        await driver.executeScript(
          `
          var input = arguments[0];
          var event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
          
          var keyupEvent = new Event('keyup', { bubbles: true });
          input.dispatchEvent(keyupEvent);
          
          var changeEvent = new Event('change', { bubbles: true });
          input.dispatchEvent(changeEvent);
        `,
          vehicleMakeInput
        );

        // Wait for API call to complete and dropdown to appear
        await driver.sleep(4000);
        console.log("Waiting for dropdown options to appear...");

        // Try multiple selectors for the dropdown items
        let firstResult = null;
        try {
          // Try Kendo autocomplete listbox items
          firstResult = await driver.wait(
            until.elementLocated(
              By.xpath("//ul[@id='VehicleDetailsMakeModel_listbox']//li[1]")
            ),
            5000
          );
        } catch (e) {
          try {
            // Try general k-item class
            firstResult = await driver.wait(
              until.elementLocated(
                By.xpath("//li[contains(@class, 'k-item')][1]")
              ),
              5000
            );
          } catch (e2) {
            try {
              // Try any li element in autocomplete
              firstResult = await driver.wait(
                until.elementLocated(
                  By.xpath("//li[contains(@class, 'k-list-item')][1]")
                ),
                5000
              );
            } catch (e3) {
              console.log(
                "Could not find dropdown options, trying alternative approach..."
              );
              // Try to press Enter to select if no dropdown appears
              await vehicleMakeInput.sendKeys(Key.ENTER);
              await driver.sleep(1000);
              console.log("Pressed Enter to confirm selection");
              return; // Exit this section
            }
          }
        }

        if (firstResult) {
          await driver.wait(until.elementIsVisible(firstResult), 5000);
          await firstResult.click();
          console.log("Selected first vehicle make/model result");
          await driver.sleep(1000);
        }

        // Purchase Date - use data from MongoDB or today's date
        console.log("Filling purchase date...");
        const purchaseDate = data.purchaseDate || new Date().toLocaleDateString("en-GB").split("/").join("-"); // Convert DD/MM/YYYY to DD-MM-YYYY
        const purchaseDateInput = await driver.wait(
          until.elementLocated(By.id("Date_PurchaseVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${purchaseDate}';
          var event = new Event('change', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          purchaseDateInput
        );
        console.log(`Filled purchase date with: ${purchaseDate}`);

        // Registration Date - use data from MongoDB or today's date
        console.log("Filling registration date...");
        const registrationDate = data.registrationDate || new Date().toLocaleDateString("en-GB").split("/").join("-"); // Convert DD/MM/YYYY to DD-MM-YYYY
        const registrationDateInput = await driver.wait(
          until.elementLocated(By.id("Date_RegistrationVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${registrationDate}';
          var event = new Event('change', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          registrationDateInput
        );
        console.log(`Filled registration date with: ${registrationDate}`);

        // Manufacturing Year and Month - Use data from MongoDB
        console.log("Attempting manufacturing year and month selection...");
        try {
          // Try to set values directly using JavaScript
          const manufacturingYear = data.manufacturingYear || 2025;
          const manufacturingMonth = data.manufacturingMonth || "10";
          
          await driver.executeScript(`
            // Try to set manufacturing year
            var yearDropdown = document.getElementById('Manufacturing_YearVehicle');
            if (yearDropdown) {
              var kendoYearWidget = $(yearDropdown).data('kendoDropDownList');
              if (kendoYearWidget) {
                // Try to select the year from data, otherwise first available
                var dataSource = kendoYearWidget.dataSource;
                if (dataSource && dataSource.data().length > 0) {
                  var yearValue = '${manufacturingYear}';
                  var foundYear = null;
                  
                  // Search for matching year
                  for (var i = 0; i < dataSource.data().length; i++) {
                    var yearData = dataSource.data()[i];
                    if (yearData.Text === yearValue || yearData.Value === yearValue) {
                      foundYear = yearData;
                      break;
                    }
                  }
                  
                  var selectedYear = foundYear || dataSource.data()[0];
                  kendoYearWidget.value(selectedYear.Value);
                  kendoYearWidget.trigger('change');
                  console.log('Set manufacturing year to:', selectedYear.Text);
                }
              }
            }
            
            // Wait a bit then try to set manufacturing month
            setTimeout(function() {
              var monthDropdown = document.getElementById('Manufacturing_MonthVehicle');
              if (monthDropdown) {
                var kendoMonthWidget = $(monthDropdown).data('kendoDropDownList');
                if (kendoMonthWidget) {
                  var dataSource = kendoMonthWidget.dataSource;
                  if (dataSource && dataSource.data().length > 0) {
                    var monthValue = '${manufacturingMonth}';
                    var foundMonth = null;
                    
                    // Search for matching month
                    for (var i = 0; i < dataSource.data().length; i++) {
                      var monthData = dataSource.data()[i];
                      if (monthData.Text === monthValue || monthData.Value === monthValue) {
                        foundMonth = monthData;
                        break;
                      }
                    }
                    
                    var selectedMonth = foundMonth || dataSource.data()[0];
                    kendoMonthWidget.value(selectedMonth.Value);
                    kendoMonthWidget.trigger('change');
                    console.log('Set manufacturing month to:', selectedMonth.Text);
                  }
                }
              }
            }, 1000);
          `);

          await driver.sleep(3000); // Wait for the JavaScript to execute
          console.log(
            `Attempted to set manufacturing year to ${manufacturingYear} and month to ${manufacturingMonth} via JavaScript`
          );
        } catch (err) {
          console.log("Error setting manufacturing year/month:", err.message);
        }

        // Check "Is New Vehicle" checkbox
        console.log("Checking 'Is New Vehicle' checkbox...");
        const newVehicleCheckbox = await driver.wait(
          until.elementLocated(By.id("IsNewVehicle")),
          10000
        );
        await driver.executeScript("arguments[0].click();", newVehicleCheckbox);
        console.log("Checked 'Is New Vehicle' checkbox");
        await driver.sleep(1000);

        // RTO City Location autocomplete
        console.log("Filling RTO city location...");
        const rtoCityInput = await driver.wait(
          until.elementLocated(By.id("RTOCityLocation")),
          10000
        );
        await driver.wait(until.elementIsVisible(rtoCityInput), 5000);
        await driver.wait(until.elementIsEnabled(rtoCityInput), 5000);
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          rtoCityInput
        );
        await driver.sleep(500);

        // Clear the field first
        await rtoCityInput.clear();
        await driver.sleep(500);

        // Click on the input to focus it
        await rtoCityInput.click();
        await driver.sleep(500);

        // Type the search text and trigger events
        await rtoCityInput.sendKeys(data.rtoCityLocation || "coimbatore");
        await driver.sleep(1000);

        // Trigger additional events to ensure autocomplete works
        await driver.executeScript(
          `
          var input = arguments[0];
          var event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
          
          var keyupEvent = new Event('keyup', { bubbles: true });
          input.dispatchEvent(keyupEvent);
          
          var changeEvent = new Event('change', { bubbles: true });
          input.dispatchEvent(changeEvent);
        `,
          rtoCityInput
        );

        // Wait for API call to complete and dropdown to appear
        await driver.sleep(4000);
        console.log("Waiting for RTO city dropdown options to appear...");

        // Try multiple selectors for the dropdown items
        let rtoCitySelected = false;
        try {
          // Try Kendo autocomplete listbox items
          const firstRtoResult = await driver.wait(
            until.elementLocated(
              By.xpath("//ul[@id='RTOCityLocation_listbox']//li[1]")
            ),
            5000
          );
          await driver.wait(until.elementIsVisible(firstRtoResult), 3000);
          await firstRtoResult.click();
          console.log("Selected first RTO city result from listbox");
          rtoCitySelected = true;
        } catch (e) {
          try {
            // Try general k-item class
            const firstRtoResult = await driver.wait(
              until.elementLocated(
                By.xpath("//li[contains(@class, 'k-item')][1]")
              ),
              5000
            );
            await driver.wait(until.elementIsVisible(firstRtoResult), 3000);
            await firstRtoResult.click();
            console.log("Selected first RTO city result from general items");
            rtoCitySelected = true;
          } catch (e2) {
            try {
              // Try any li element in autocomplete
              const firstRtoResult = await driver.wait(
                until.elementLocated(
                  By.xpath("//li[contains(@class, 'k-list-item')][1]")
                ),
                5000
              );
              await driver.wait(until.elementIsVisible(firstRtoResult), 3000);
              await firstRtoResult.click();
              console.log("Selected first RTO city result from list items");
              rtoCitySelected = true;
            } catch (e3) {
              console.log(
                "Could not find RTO city dropdown options, trying alternative approach..."
              );
              // Try to press Enter to select if no dropdown appears
              await rtoCityInput.sendKeys(Key.ENTER);
              await driver.sleep(1000);
              console.log("Pressed Enter to confirm RTO city selection");
              rtoCitySelected = true;
            }
          }
        }

        if (rtoCitySelected) {
          await driver.sleep(1000);
          console.log("RTO city selection completed");
        } else {
          console.log("RTO city selection failed, continuing with form...");
        }

        // Engine Number
        console.log("Filling engine number...");
        const engineNumber = data.engineNumber || "FG5HS2808584";
        const engineNumberInput = await driver.wait(
          until.elementLocated(By.id("EngineNumberVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${engineNumber}';
          var event = new Event('input', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          engineNumberInput
        );
        console.log(`Filled engine number with: ${engineNumber}`);

        // Chassis Number
        console.log("Filling chassis number...");
        const chassisNumber = data.chassisNumber || "MD626DG56S2H08322";
        const chassisNumberInput = await driver.wait(
          until.elementLocated(By.id("ChasisNumberVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${chassisNumber}';
          var event = new Event('input', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          chassisNumberInput
        );
        console.log(`Filled chassis number with: ${chassisNumber}`);

        // Set IDV value (FIRST TIME) from formData.idv
        console.log("Setting IDV value (initial) from formData...");
        const idv = Number(String(data.idv || '').replace(/[^0-9]/g, '')) || 0;
        if (idv > 0) {
        await driver.executeScript(`
            try {
              var desired = ${idv};
              // Prefer total #IDVVehicle; fallback to #ActualIDVVehicle
              var totalEl = document.getElementById('IDVVehicle') || document.getElementById('ActualIDVVehicle');
              if (totalEl) {
                totalEl.removeAttribute('readonly');
                totalEl.removeAttribute('disabled');
                try { totalEl.focus(); } catch(e) {}
                totalEl.value = '';
                totalEl.value = String(desired);
                try { totalEl.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                try { totalEl.dispatchEvent(new Event('keyup', { bubbles: true })); } catch(e) {}
                try { totalEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
                try { totalEl.blur && totalEl.blur(); } catch(e) {}
              }
              // Also set Body/Chassis if present to align with validations
              var bodyEl = document.getElementById('txtBodyIDV');
              var chassisEl = document.getElementById('txtChassisIDV');
              if (bodyEl && chassisEl) {
                var minBody = 5000, minChassis = 3000;
                var chassis = Math.max(minChassis, Math.floor(desired * 0.05));
                var body = Math.max(minBody, desired - chassis);
                // Adjust in case body + chassis exceeded desired due to mins
                if (body + chassis !== desired && desired > (minBody + minChassis)) {
                  chassis = desired - body;
                }
                bodyEl.removeAttribute('readonly');
                chassisEl.removeAttribute('readonly');
                bodyEl.value = '';
                chassisEl.value = '';
                bodyEl.value = String(body);
                chassisEl.value = String(chassis);
                try { bodyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                try { chassisEl.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                try { bodyEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
                try { chassisEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
              }
            } catch(e) {}
          `);
          // Verify IDV was set correctly
          const idvCheck = await driver.executeScript(`
            var el = document.getElementById('IDVVehicle') || document.getElementById('ActualIDVVehicle');
            return el ? el.value : null;
          `);
          console.log(`IDV (initial) verification - Expected: ${idv}, Actual: ${idvCheck}`);
        } else {
          console.log('IDV not provided in formData; skipping initial set');
        }

        // Set Discount Rate (use data.discount from server; allowed: 60 or 80; default 60)
        console.log("Setting discount rate...");
        try {
          const discountParsed = Number(String(data.discount ?? '').replace(/[^0-9.-]/g, ''));
          let discountValue = Number.isFinite(discountParsed) ? discountParsed : 60;
          discountValue = discountValue === 80 ? 80 : 60; // clamp to schema enum
          const discountInput = await driver.wait(
            until.elementLocated(By.id("Detariff_Discount_Rate")),
            10000
          );
          await driver.wait(until.elementIsVisible(discountInput), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            discountInput
          );
          await driver.sleep(500);

          // Clear and set discount value
          await driver.executeScript(
            `
            var el = arguments[0];
            el.removeAttribute('readonly');
            el.removeAttribute('disabled');
            el.value = '';
            el.value = String(arguments[1]);
          `,
            discountInput,
            String(discountValue)
          );

          // Trigger input and blur events to call OnChangeofDiscountLoading()
          await driver.executeScript(`
            var el = arguments[0];
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            // Also call the onblur function directly if it exists
            if (typeof OnChangeofDiscountLoading === 'function') {
              OnChangeofDiscountLoading();
            }
          `, discountInput);

          console.log(`✅ Discount rate set to: ${discountValue}`);
          await driver.sleep(1000);
        } catch (err) {
          console.log("⚠️ Could not set discount rate:", err.message);
        }

        // Click "Get Coverage Details" button
        console.log("Clicking 'Get Coverage Details' button...");
        const getCoverageButton = await driver.wait(
          until.elementLocated(By.id("btnFetchIDV")),
          10000
        );
        await driver.wait(until.elementIsVisible(getCoverageButton), 5000);
        await driver.wait(until.elementIsEnabled(getCoverageButton), 5000);
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          getCoverageButton
        );
        await driver.sleep(1000);

        // Try multiple click methods to ensure the click is registered
        try {
          // First try regular click
          await getCoverageButton.click();
          console.log(
            "Regular click attempted on 'Get Coverage Details' button"
          );
        } catch (e) {
          console.log("Regular click failed, trying JavaScript click...");
          await driver.executeScript(
            "arguments[0].click();",
            getCoverageButton
          );
        }
        // Also try triggering the onclick event directly
        await driver.executeScript(`
          var button = document.getElementById('btnFetchIDV');
          if (button) {
            button.click();
            // Also try calling the onclick function directly
            if (button.onclick) {
              button.onclick();
            }
            // Trigger the FetchIDV function
            if (typeof FetchIDV === 'function') {
              FetchIDV(button, 'InsertMode    ');
            }
          }
        `);

        console.log(
          "Clicked 'Get Coverage Details' button with multiple methods"
        );
        await driver.sleep(5000); // Wait longer for the API call to complete

        // Click PA to Owner Driver checkbox to open modal
        console.log("Clicking PA to Owner Driver checkbox to open modal...");
        const paOwnerDriverCheckbox = await driver.wait(
          until.elementLocated(By.id("ChkBox24")),
          10000
        );
        await driver.executeScript(
          "arguments[0].click();",
          paOwnerDriverCheckbox
        );
        console.log("Clicked PA to Owner Driver checkbox, modal should open");
        await driver.sleep(2000);

        // Wait for modal to open and click "No" checkbox
        console.log("Waiting for modal and clicking 'No' checkbox...");
        try {
          const noCheckbox = await driver.wait(
            until.elementLocated(By.id("OnNoofDL")),
            10000
          );
          await driver.wait(until.elementIsVisible(noCheckbox), 5000);
          await driver.executeScript("arguments[0].click();", noCheckbox);
          console.log("Clicked 'No' checkbox in PA to Owner Driver modal");
          await driver.sleep(1000);
        } catch (err) {
          console.log("Error clicking 'No' checkbox in modal:", err.message);
        }

        // Uncheck Helmet Cover checkbox
        console.log("Unchecking Helmet Cover checkbox...");
        const helmetCoverCheckbox = await driver.wait(
          until.elementLocated(By.id("ChkBox500")),
          10000
        );
        await driver.executeScript(
          "arguments[0].click();",
          helmetCoverCheckbox
        );
        console.log("Unchecked Helmet Cover checkbox");
        await driver.sleep(1000);

        // Set TPPD Limit if restriction enabled (select 6000)
        try {
          if (data.tppdRestrict === true || data.tppdRestrict === "true") {
            console.log("TPPD restrict enabled. Selecting 6000 in TPPD dropdown...");

            // First, try using Kendo DropDownList API directly
            const kendoResult = await driver.executeScript(`
              try {
                var widget = $("#ddlTPPDLimit").data("kendoDropDownList");
                if (widget && widget.dataSource && widget.dataSource.data().length) {
                  var ds = widget.dataSource.data();
                  var target = null;
                  for (var i = 0; i < ds.length; i++) {
                    var item = ds[i];
                    var text = String(item.Text || item.text || "").replace(/,/g,"").trim();
                    var value = String(item.Value || item.value || "").replace(/,/g,"").trim();
                    if (text === "6000" || value === "6000" || text.indexOf("6000") !== -1) {
                      target = item;
                      break;
                    }
                  }
                  if (target) {
                    widget.value(target.Value || target.value);
                    widget.trigger("change");
                    return { ok: true, method: "kendo", text: target.Text || target.text, value: target.Value || target.value };
                  }
                  // fallback: select second option (index 1)
                  if (ds.length > 1) {
                    widget.select(1);
                    widget.trigger("change");
                    var sel = widget.dataItem(widget.select());
                    return { ok: true, method: "kendo_index", text: sel && (sel.Text || sel.text), value: sel && (sel.Value || sel.value) };
                  }
                }
                return { ok: false, method: "kendo", reason: "widget or item not found" };
              } catch (e) {
                return { ok: false, method: "kendo", error: e && e.message };
              }
            `);

            if (!kendoResult || !kendoResult.ok) {
              console.log("Kendo API select failed or not available, falling back to UI click...", kendoResult);

              const tppdDropdown = await driver.wait(
                until.elementLocated(
                  By.css("span[aria-owns='ddlTPPDLimit_listbox']")
                ),
          10000
        );
        await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                tppdDropdown
              );
              await driver.sleep(500);
              await driver.executeScript("arguments[0].click();", tppdDropdown);
              await driver.sleep(1000);

              // Try clicking the second item in the listbox first, then text fallbacks
              let optionEl = null;
              const xpaths = [
                "//ul[@id='ddlTPPDLimit_listbox']/li[2]",
                "//li[normalize-space(text())='6000']",
                "//li[normalize-space(text())='6,000']",
                "//li[contains(normalize-space(text()), '6000')]",
              ];
              for (const xp of xpaths) {
                try {
                  optionEl = await driver.wait(
                    until.elementLocated(By.xpath(xp)),
                    2000
                  );
                  break;
                } catch {}
              }

              if (optionEl) {
                await driver.executeScript("arguments[0].click();", optionEl);
                console.log("Selected TPPD limit via UI (second item or 6000 match)");
                await driver.sleep(500);
              } else {
                console.log("Could not locate 6000 option in TPPD dropdown list");
              }
            } else {
              console.log("Selected TPPD limit: 6000 via Kendo API");
            }
          } else {
            console.log("TPPD restrict not enabled. Leaving default TPPD limit.");
          }
        } catch (err) {
          console.log("Could not set TPPD limit:", err.message);
        }

        // Ensure Zero Depreciation is checked when enabled in data
        try {
          if (data.zeroDepreciation === true || data.zeroDepreciation === "true") {
            console.log("Zero Depreciation enabled. Ensuring checkbox is checked...");
            const zeroDepCheckbox = await driver.wait(
              until.elementLocated(By.id("ChkBox10")),
              10000
            );
            const isChecked = await zeroDepCheckbox.isSelected();
            if (!isChecked) {
              await driver.executeScript("arguments[0].click();", zeroDepCheckbox);
              console.log("Checked Zero Depreciation (Nil Depreciation) checkbox");
            } else {
              console.log("Zero Depreciation already checked");
            }
            await driver.sleep(500);
          } else {
            console.log("Zero Depreciation not requested. Leaving as-is.");
          }
        } catch (err) {
          console.log("Could not toggle Zero Depreciation checkbox:", err.message);
        }

        // IDV was already set before "Get Coverage Details" - skipping duplicate set
        console.log("Skipping duplicate IDV set (already set before Get Coverage Details)");

        // === FINANCIER FIELDS HANDLING ===
        // Fill financier details BEFORE "Is Registration Address Same" checkbox
        console.log("Handling financier fields...");
        
        if (data.hasFinancier) {
          console.log("Vehicle has financier, checking VehicleHypothicated checkbox...");
          
          try {
            const vehicleHypothicatedCheckbox = await driver.wait(
              until.elementLocated(By.id("VehicleHypothicated")),
              10000
            );
            
            // Check if already checked
            const isAlreadyChecked = await vehicleHypothicatedCheckbox.isSelected();
            if (!isAlreadyChecked) {
              await driver.executeScript("arguments[0].click();", vehicleHypothicatedCheckbox);
              console.log("Checked VehicleHypothicated checkbox");
            } else {
              console.log("VehicleHypothicated checkbox already checked");
            }
            
            // Trigger the VehicleHypothicate() function to show financier fields
            await driver.executeScript(`
              if (typeof VehicleHypothicate === 'function') {
                VehicleHypothicate();
              }
            `);
            console.log("Triggered VehicleHypothicate() function");
            await driver.sleep(2000);

            // Force financier sections to be visible
            await driver.executeScript(`
              var finTypeDiv = document.getElementById('DivFinancierType');
              var finNameDiv = document.getElementById('DivFinancierName');
              var finAddressDiv = document.getElementById('DivFinancierAddress');
              
              if (finTypeDiv) {
                finTypeDiv.style.display = 'block';
                finTypeDiv.style.visibility = 'visible';
              }
              if (finNameDiv) {
                finNameDiv.style.display = 'block';
                finNameDiv.style.visibility = 'visible';
              }
              if (finAddressDiv) {
                finAddressDiv.style.display = 'block';
                finAddressDiv.style.visibility = 'visible';
              }
            `);
            console.log("Forced financier sections to be visible");
            await driver.sleep(1000);

            // Select Financier Type (default to Hypothecated)
            console.log(`Selecting financier type...`);
            const finTypeResult = await driver.executeScript(`
              try {
                var map = {
                  'HYPOTHECATED': 1, 'HYPOTHECATE': 1, 'HYPOTHECATION': 1,
                  'HYPOTHECATED/HP/LEASE': 1, 'HIRE PURCHASE': 2,
                  'LEASE AGREEMENT': 3, 'MORTGAGE': 5
                };
                var raw = '${(data.financierType || '').toString().trim().toUpperCase()}';
                var input = raw.replace(/HYPOTE?I?CAL|HYPOTEICAL|HYPOTHETICAL/g, 'HYPOTHECATED');
                var val = map[input] || 1;
                var w = $("#FinancierType").data("kendoDropDownList");
                if (w) {
                  w.value(String(val));
                  w.trigger('change');
                  return { ok: true, value: val };
                }
                return { ok: false, reason: 'widget not found' };
              } catch(e) { return { ok: false, error: e && e.message }; }
            `);
            console.log("Financier type select result:", finTypeResult);
            await driver.sleep(600);

            // Fill Financier Name - Enter text and select FIRST result
            if (data.financierName) {
              console.log(`Filling financier name: ${data.financierName}`);
              
              // Force field to be visible and enabled
              await driver.executeScript(`
                var input = document.getElementById('AutoFinancierName');
                if (input) {
                  input.style.display = 'block';
                  input.style.visibility = 'visible';
                  input.removeAttribute('disabled');
                  input.removeAttribute('readonly');
                  var parent = input.parentElement;
                  while (parent && parent.tagName !== 'BODY') {
                    if (parent.style) {
                      parent.style.display = '';
                      parent.style.visibility = 'visible';
                    }
                    parent = parent.parentElement;
                  }
                }
              `);
              
              const financierNameInput = await driver.wait(
                until.elementLocated(By.id("AutoFinancierName")),
                10000
              );
              
              await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                financierNameInput
              );
              await driver.sleep(500);

              // Clear and type the financier name
              await driver.executeScript("arguments[0].value = '';", financierNameInput);
              await driver.sleep(300);
              await driver.executeScript("arguments[0].click();", financierNameInput);
              await driver.sleep(300);
              
              await financierNameInput.sendKeys(data.financierName);
              await driver.sleep(1500);

              // Trigger autocomplete events
              await driver.executeScript(`
                var input = arguments[0];
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('keyup', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              `, financierNameInput);
              console.log(`Typed financier name: ${data.financierName}`);
              
              // Wait for autocomplete dropdown
              await driver.sleep(3000);

              // Select FIRST result from dropdown
              let selected = false;
              try {
                const firstItem = await driver.wait(
                  until.elementLocated(By.xpath("//ul[@id='AutoFinancierName_listbox']/li[1]")),
                  5000
                );
                await driver.wait(until.elementIsVisible(firstItem), 3000);
                await driver.executeScript("arguments[0].click();", firstItem);
                console.log("✅ Selected FIRST financier name from dropdown");
                selected = true;
              } catch(e) {
                console.log("Dropdown not visible, trying keyboard selection...");
                try { 
                  await financierNameInput.sendKeys(Key.ARROW_DOWN); 
                  await driver.sleep(300); 
                  await financierNameInput.sendKeys(Key.ENTER);
                  console.log("✅ Selected FIRST financier via keyboard");
                  selected = true;
                } catch(e2) {
                  console.log("Keyboard failed, trying Kendo API...");
                  await driver.executeScript(`
                    try {
                      var widget = $("#AutoFinancierName").data("kendoAutoComplete");
                      if (widget && widget.dataSource && widget.dataSource.data().length > 0) {
                        var firstItem = widget.dataSource.data()[0];
                        widget.value(firstItem.FinancierName || firstItem.text || firstItem);
                        widget.trigger('change');
                      }
                    } catch(e) {}
                  `);
                  selected = true;
                }
              }

              if (selected) {
                await driver.sleep(1000);
                await driver.executeScript(`
                  if (typeof ValidateFinancierName === 'function') {
                    try { ValidateFinancierName(); } catch(e) {}
                  }
                `);
                console.log("Triggered ValidateFinancierName() function");
                await driver.sleep(1000);
              }
            } else {
              console.log("No financier name provided");
            }

            // Fill Financier Address
            if (data.financierAddress) {
              console.log(`Filling financier address: ${data.financierAddress}`);
              await driver.sleep(1500);
              
              // Force address field to be visible and enabled
              await driver.executeScript(`
                var input = document.getElementById('FinancierAddressVehicle');
                if (input) {
                  input.style.display = 'block';
                  input.style.visibility = 'visible';
                  input.removeAttribute('disabled');
                  input.removeAttribute('readonly');
                  var parent = input.parentElement;
                  while (parent && parent.tagName !== 'BODY') {
                    if (parent.style) {
                      parent.style.display = '';
                      parent.style.visibility = 'visible';
                    }
                    parent = parent.parentElement;
                  }
                }
              `);
              
              const financierAddressInput = await driver.wait(
                until.elementLocated(By.id("FinancierAddressVehicle")),
                10000
              );
              
              await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                financierAddressInput
              );
              await driver.sleep(500);

              // Clear and fill using JavaScript
              await driver.executeScript(`
                var el = arguments[0];
                el.removeAttribute('readonly');
                el.removeAttribute('disabled');
                el.value = '';
              `, financierAddressInput);
              
              await driver.sleep(500);
              await financierAddressInput.sendKeys(data.financierAddress);
              console.log(`✅ Filled financier address: ${data.financierAddress}`);
              await driver.sleep(800);
              
              // Trigger events
              await driver.executeScript(`
                var el = arguments[0];
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                if (el.blur) el.blur();
              `, financierAddressInput);
              await driver.sleep(500);
            } else {
              console.log("No financier address provided");
            }
            
            console.log("✅ Financier details filled successfully");
          } catch (err) {
            console.log("❌ Error handling financier fields:", err.message);
          }
        } else {
          console.log("Vehicle has no financier, skipping financier fields");
        }

        // Now check "Is Registration Address Same" checkbox
        console.log("Checking 'Is Registration Address Same' checkbox...");
        const regAddressSameCheckbox = await driver.wait(
          until.elementLocated(By.id("IsRegistrationAddresssame")),
          10000
        );
        await driver.executeScript("arguments[0].click();", regAddressSameCheckbox);
        console.log("Checked 'Is Registration Address Same' checkbox");
        await driver.sleep(2000);

        // Click "Calculate Premium" button
        console.log("Clicking 'Calculate Premium' button...");
        const calculatePremiumButton = await driver.wait(
          until.elementLocated(By.id("btnCalculate")),
          10000
        );
        await driver.wait(until.elementIsVisible(calculatePremiumButton), 5000);
        await driver.wait(until.elementIsEnabled(calculatePremiumButton), 5000);
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          calculatePremiumButton
        );
        await driver.sleep(500);

        try {
          await calculatePremiumButton.click();
        } catch {
          await driver.executeScript(
            "arguments[0].click();",
            calculatePremiumButton
          );
        }
        console.log("Clicked 'Calculate Premium' button!");

        // Wait for premium calculation to complete
        await driver.sleep(3000);
        console.log("Premium calculation completed!");

        // === STEP 10: Handle post-calculation elements ===
        console.log("Handling post-calculation elements...");

        try {
          // Click Save button
          console.log("Looking for Save button...");
          const saveButton = await driver.wait(
            until.elementLocated(By.id("btnSave")),
            10000
          );
          await driver.wait(until.elementIsVisible(saveButton), 5000);
          await driver.wait(until.elementIsEnabled(saveButton), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            saveButton
          );
          await driver.sleep(500);

          try {
            await saveButton.click();
          } catch {
            await driver.executeScript("arguments[0].click();", saveButton);
          }
          console.log("Clicked Save button!");
          await driver.sleep(3000);

          // Click Make Payment button
          console.log("Looking for Make Payment button...");
          const makePaymentButton = await driver.wait(
            until.elementLocated(By.id("BtnmakeLive")),
            10000
          );
          await driver.wait(until.elementIsVisible(makePaymentButton), 5000);
          await driver.wait(until.elementIsEnabled(makePaymentButton), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            makePaymentButton
          );
          await driver.sleep(500);

          try {
            await makePaymentButton.click();
          } catch {
            await driver.executeScript(
              "arguments[0].click();",
              makePaymentButton
            );
          }
          console.log("Clicked Make Payment button!");
          await driver.sleep(3000);

          // Check the policy checkbox (using dynamic ID pattern)
          console.log("Looking for policy checkbox...");
          try {
            // Try to find checkbox with pattern chkR followed by numbers
            const policyCheckbox = await driver.wait(
              until.elementLocated(
                By.css("input[id^='chkR'][type='checkbox']")
              ),
              10000
            );
            await driver.wait(until.elementIsVisible(policyCheckbox), 5000);
            await driver.executeScript("arguments[0].click();", policyCheckbox);
            console.log("Checked policy checkbox!");
            await driver.sleep(1000);
          } catch (err) {
            console.log("Could not find policy checkbox:", err.message);
          }

          // Check TP Declaration checkbox
          console.log("Looking for TP Declaration checkbox...");
          try {
            const tpDeclarationCheckbox = await driver.wait(
              until.elementLocated(By.id("TPDeclaration")),
              10000
            );
            await driver.wait(
              until.elementIsVisible(tpDeclarationCheckbox),
              5000
            );
            // await driver.executeScript(
            //   "arguments[0].click();",
            //   tpDeclarationCheckbox
            // );

            const checkbox = await driver.findElement(By.id("TPDeclaration"));
            const isChecked = await checkbox.isSelected();

            if (!isChecked) {
              await checkbox.click();
              console.log("✅ TP Declaration checkbox checked");
            } else {
              console.log("☑️ Already checked");
            }

            console.log("Checked TP Declaration checkbox!");
            await driver.sleep(1000);
          } catch (err) {
            console.log("Could not find TP Declaration checkbox:", err.message);
          }

          // Click Pay button
          console.log("Looking for Pay button...");
          const payButton = await driver.wait(
            until.elementLocated(By.id("Paymentbtn")),
            10000
          );
          await driver.wait(until.elementIsVisible(payButton), 5000);
          await driver.wait(until.elementIsEnabled(payButton), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            payButton
          );
          await driver.sleep(500);

          try {
            await payButton.click();
          } catch {
            await driver.executeScript("arguments[0].click();", payButton);
          }
          console.log("Clicked Pay button!");
          await driver.sleep(3000);

          // Handle Payment Type dropdown
          console.log("Handling Payment Type dropdown...");
          try {
            const paymentTypeDropdown = await driver.wait(
              until.elementLocated(
                By.css("span[aria-owns='ddlPaymentType_listbox']")
              ),
              10000
            );
            await driver.executeScript(
              "arguments[0].click();",
              paymentTypeDropdown
            );
            await driver.sleep(1000);

            // Select "Send Payment Link" option
            const sendPaymentLinkOption = await driver.wait(
              until.elementLocated(
                By.xpath("//li[contains(text(), 'Send Payment Link')]")
              ),
              5000
            );
            await driver.executeScript(
              "arguments[0].click();",
              sendPaymentLinkOption
            );
            console.log("Selected 'Send Payment Link' from dropdown!");
            await driver.sleep(2000);
          } catch (err) {
            console.log("Could not handle Payment Type dropdown:", err.message);
          }

          // Click Add button
          console.log("Looking for Add button...");
          try {
            const addButton = await driver.wait(
              until.elementLocated(
                By.css("input[onclick*='AddRowToPaymentDetailsGrid']")
              ),
              10000
            );
            await driver.wait(until.elementIsVisible(addButton), 5000);
            await driver.wait(until.elementIsEnabled(addButton), 5000);
            await driver.executeScript(
              "arguments[0].scrollIntoView({block: 'center'});",
              addButton
            );
            await driver.sleep(500);

            try {
              await addButton.click();
            } catch {
              await driver.executeScript("arguments[0].click();", addButton);
            }
            console.log("Clicked Add button!");
            await driver.sleep(2000);

            // Click OK button in modal
            console.log("Looking for OK button in modal...");
            const okButton = await driver.wait(
              until.elementLocated(By.id("btnAddRowToGrid")),
              10000
            );
            await driver.wait(until.elementIsVisible(okButton), 5000);
            await driver.wait(until.elementIsEnabled(okButton), 5000);
            await driver.executeScript("arguments[0].click();", okButton);
            console.log("Clicked OK button in modal!");
            await driver.sleep(2000);
          } catch (err) {
            console.log("Could not handle Add button flow:", err.message);
          }

          // Click Yes button
          console.log("Looking for Yes button...");
          try {
            // const yesButton = await driver.wait(
            //   until.elementLocated(
            //     By.css("input[onclick*='SendMail'][value='Yes']")
            //   ),
            //   10000
            // );
            // await driver.wait(until.elementIsVisible(yesButton), 5000);
            // await driver.wait(until.elementIsEnabled(yesButton), 5000);
            // await driver.executeScript(
            //   "arguments[0].scrollIntoView({block: 'center'});",
            //   yesButton
            // );
            // await driver.sleep(500);
            // console.log("Filling email...");
            // const emailInput = await driver.findElement(By.id("txtEmailID"));
            // await emailInput.sendKeys(data?.email);
            // await driver.sleep(1000);
            const okButton = await driver.findElement(
              By.css(
                ".ui-dialog-buttonpane .ui-dialog-buttonset button:first-child"
              )
            );
            await okButton.click();
            console.log("✅ Clicked OK button");

            try {
              await yesButton.click();
            } catch {
              await driver.executeScript("arguments[0].click();", yesButton);
            }
            console.log("Clicked Yes button!");
            await driver.sleep(3000);
          } catch (err) {
            console.log("Could not find Yes button:", err.message);
          }

          // try {
          //   // Wait for the popup container to be visible
          //   const popup = await driver.wait(
          //     until.elementLocated(By.css(".k-window")),
          //     10000
          //   );

          //   // Wait until it’s displayed
          //   await driver.wait(async () => {
          //     return await popup.isDisplayed();
          //   }, 5000);

          //   // Find the "Yes" button inside the popup
          //   const yesButton = await popup.findElement(
          //     By.css('input[value="Yes"]')
          //   );

          //   // Click it
          //   await yesButton.click();

          //   console.log("✅ Clicked 'Yes' on Contact Details popup");
          // } catch (err) {
          //   console.error("❌ Failed to click 'Yes':", err.message);
          // }

          console.log("All post-calculation elements handled successfully!");
        } catch (err) {
          console.log("Error handling post-calculation elements:", err.message);

          // Mark post-calculation as failed
          postCalculationFailed = true;
          postCalculationError = err.message;

          // Capture error screenshot using centralized handler
          await captureErrorScreenshot(
            driver,
            err,
            data,
            "post-calculation-error"
          );
        }

        console.log("All vehicle details filled successfully!");
      } catch (err) {
        console.log("Error handling post-submission elements:", err.message);

        // Mark post-submission as failed
        postSubmissionFailed = true;
        postSubmissionError = err.message;

        // Capture error screenshot using centralized handler
        await captureErrorScreenshot(
          driver,
          err,
          data,
          "post-submission-error"
        );

        // Don't throw error here, just set flag to mark job as failed
      }
    } catch (err) {
      console.log("Error filling modal fields:", err.message);
      // Capture error screenshot using centralized handler
      await captureErrorScreenshot(driver, err, data, "modal-error");
      throw err;
    }

    await driver.sleep(2000);

    // Return failure if post-calculation failed
    if (postCalculationFailed) {
      hadError = true;
      return {
        success: false,
        error: postCalculationError || "Post-calculation stage failed",
        postSubmissionFailed: true, // Treat as post-submission failure
        stage: "post-calculation",
      };
    }

    // Return failure if post-submission failed (even if modal submission succeeded)
    if (postSubmissionFailed) {
      hadError = true;
      return {
        success: false,
        error: postSubmissionError || "Post-submission stage failed",
        postSubmissionFailed: true,
        stage: "post-submission",
      };
    }

    return { success: true };
  } catch (e) {
    console.error("[relianceForm] Error:", e.message || e);
    hadError = true;

    // Capture error screenshot using centralized handler
    const errorDetails = await captureErrorScreenshot(
      driver,
      e,
      data,
      "form-error"
    );

    return {
      success: false,
      error: String(e.message || e),
      errorStack: e.stack,
      screenshotUrl: errorDetails.screenshotUrl,
      screenshotKey: errorDetails.screenshotKey,
      pageSourceUrl: errorDetails.pageSourceUrl,
      pageSourceKey: errorDetails.pageSourceKey,
      timestamp: new Date(),
      stage: "login-form", // Indicate this is a login form error
      postSubmissionFailed: false,
    };
  }
   finally {
    // Cleanup: Always close browser and delete cloned profile
    if (jobBrowser) {
      await cleanupJobBrowser(jobBrowser);
    }
  }
}

async function getCaptchaScreenShot(driver, filename = "image_screenshot") {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));

  const imageBase64 = await imgElement.takeScreenshot(true);

  fs.writeFileSync(`${filename}.png`, imageBase64, "base64");
  console.log(`Screenshot saved as ${filename}.png`);
}
//txtEmailID
// Test data
const testData = {
  proposerTitle: "Mr.",
  firstName: "John",
  middleName: "M",
  lastName: "Doe",
  dob: "06-10-2007",
  fatherTitle: "Mr.",
  fatherFirstName: "Robert",
  flatNo: "101",
  floorNo: "1",
  premisesName: "Sunshine Apartments",
  blockNo: "A",
  road: "MG Road",
  state: "30", // KARNATAKA
  pinCode: "614630",
  area: "MG Road",
  mobile: "9876543210",
};

module.exports = { fillRelianceForm, getCaptchaScreenShot };
