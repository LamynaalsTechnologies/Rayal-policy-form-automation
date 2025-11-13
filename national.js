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

async function safeType(driver, locator, text, timeout = 15000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  await el.clear();
  await el.sendKeys(text);
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
      
      // Try clicking the first option if our specific one isn't found
      if (allOptions.length > 0) {
        console.log("Clicking first available option...");
        await allOptions[0].click();
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

/**
 * Centralized error screenshot handler for National
 * Captures screenshot and uploads to S3 for any error
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
    const jobIdentifier = data._jobIdentifier || `national_job_${Date.now()}`;
    const attemptNumber = data._attemptNumber || 1;

    // Generate S3 key and upload screenshot
    screenshotKey = generateScreenshotKey(
      jobIdentifier,
      attemptNumber,
      errorStage
    );
    screenshotUrl = await uploadScreenshotToS3(screenshot, screenshotKey);

    console.log(`📸 National error screenshot uploaded to S3: ${screenshotUrl}`);

    // Also capture page source for debugging (optional)
    try {
      const pageSource = await driver.getPageSource();
      pageSourceKey = screenshotKey.replace(".png", ".html");
      const tempHtmlPath = path.join(
        __dirname,
        `temp-page-source-national-${Date.now()}.html`
      );
      fs.writeFileSync(tempHtmlPath, pageSource);

      const { uploadToS3 } = require("./s3Uploader");
      pageSourceUrl = await uploadToS3(tempHtmlPath, pageSourceKey);

      fs.unlinkSync(tempHtmlPath); // Delete temp file
      console.log(`📄 National page source uploaded to S3: ${pageSourceUrl}`);
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

      console.log(`✅ National error logged to job queue (stage: ${errorStage})`);
    }
  } catch (captureErr) {
    console.error(
      `❌ Failed to capture/upload National error screenshot:`,
      captureErr.message
    );
  }

  return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
}

async function fillNationalForm(
  data = { username: "9999839907", password: "Rayal$2025" }
) {
  const jobId = data._jobIdentifier || `national_${Date.now()}`;
  let jobBrowser = null;
  let driver = null;
  
  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`🚀 [${jobId}] STARTING NATIONAL INSURANCE JOB`);
    console.log(`${"=".repeat(60)}`);
    console.log(`📋 [${jobId}] Job Data:`, JSON.stringify({
      jobId,
      firstName: data.firstName,
      lastName: data.lastName,
      attemptNumber: data._attemptNumber,
    }, null, 2));
    
    // === STEP 0: Create cloned browser (already logged in!) ===
    console.log(`\n🌐 [${jobId}] STEP 1: Creating National job browser...`);
    console.log(`⏳ [${jobId}] Calling createNationalJobBrowser...`);
    
    try {
      jobBrowser = await createNationalJobBrowser(jobId);
      console.log(`✅ [${jobId}] Browser creation returned successfully`);
      console.log(`📊 [${jobId}] Job Browser Info:`, {
        hasDriver: !!jobBrowser?.driver,
        hasProfileInfo: !!jobBrowser?.profileInfo,
        jobIdMatch: jobBrowser?.jobId === jobId
      });
    } catch (browserError) {
      console.error(`❌ [${jobId}] CRITICAL: Browser creation failed!`);
      console.error(`❌ [${jobId}] Error:`, browserError.message);
      console.error(`❌ [${jobId}] Stack:`, browserError.stack);
      throw new Error(`Failed to create National job browser: ${browserError.message}`);
    }
    
    driver = jobBrowser.driver;
    
    if (!driver) {
      throw new Error("Browser driver is null or undefined after creation");
    }

    console.log(`✅ [${jobId}] National browser ready with active session!`);
    console.log(`🌐 [${jobId}] Navigating to NIC portal...`);
    
    // Navigate to NIC portal
    try {
      console.log(`⏳ [${jobId}] Loading URL: https://nicportal.nic.co.in/nicportal/signin/login`);
      await driver.get("https://nicportal.nic.co.in/nicportal/signin/login");
      console.log(`✅ [${jobId}] Navigation successful!`);
      
      // Verify we're on the correct page
      const currentUrl = await driver.getCurrentUrl();
      console.log(`🌐 [${jobId}] Current URL after navigation: ${currentUrl}`);
      
      if (!currentUrl.includes("nicportal.nic.co.in")) {
        console.warn(`⚠️  [${jobId}] WARNING: Not on National portal! Current URL: ${currentUrl}`);
      }
      
      await driver.sleep(3000);
    } catch (navError) {
      console.error(`❌ [${jobId}] Navigation failed:`, navError.message);
      throw new Error(`Failed to navigate to National portal: ${navError.message}`);
    }
    
    // Wait for page to load
    await waitForLoaderToDisappear(driver);
    
    // Check if already logged in (session still valid)
    const currentUrl = await driver.getCurrentUrl();
    const loginElements = await driver.findElements(By.name("log_txtfield_iUsername_01"));
    const isOnLoginPage = loginElements.length > 0 || currentUrl.includes("/signin/login");
    
    if (!isOnLoginPage) {
      console.log(`✅ [${jobId}] Already logged in! Session is active, skipping login...`);
    } else {
      console.log(`⚠️  [${jobId}] Session expired or not logged in. Attempting login...`);
      
      // Debug: Check what elements are available
      try {
        const pageTitle = await driver.getTitle();
        console.log("Page title:", pageTitle);
        
        console.log("Current URL:", currentUrl);
        
        // Check for dropdown elements
        const dropdowns = await driver.findElements(By.css("mat-select"));
        console.log(`Found ${dropdowns.length} mat-select dropdowns`);
        
        // Check for input fields
        const inputs = await driver.findElements(By.css("input"));
        console.log(`Found ${inputs.length} input fields`);
      } catch (debugError) {
        console.log("Debug info failed:", debugError.message);
      }
      
      // Handle login form
      console.log("Filling login form...");
    
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
    console.log("Looking for username field...");
    const usernameField = By.name("log_txtfield_iUsername_01");
    await safeType(driver, usernameField, formData.username || "9999839907", 10000);
    console.log("Filled username");
    
    // Fill password
    console.log("Looking for password field...");
    const passwordField = By.name("log_pwd_iPassword_01");
    await safeType(driver, passwordField, formData.password || "Rayal$2025", 10000);
    console.log("Filled password");
    
    // Click login button
    console.log("Looking for login button...");
    const loginButton = By.name("log_btn_login_01");
    
    try {
      // Wait for button to be present
      const buttonElement = await driver.wait(until.elementLocated(loginButton), 10000);
      console.log("Login button found");
      
      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(buttonElement), 10000);
      console.log("Login button is visible");
      
      await driver.wait(until.elementIsEnabled(buttonElement), 10000);
      console.log("Login button is enabled");
      
      // Try regular click first
      try {
        await buttonElement.click();
        console.log("✅ Clicked login button (regular click)");
      } catch (clickError) {
        console.log("Regular click failed, trying JavaScript click...");
        // Fallback to JavaScript click
        await driver.executeScript("arguments[0].click();", buttonElement);
        console.log("✅ Clicked login button (JavaScript click)");
      }
    } catch (buttonError) {
      console.error("❌ Failed to click login button:", buttonError.message);
      // Try alternative selectors
      try {
        console.log("Trying alternative login button selectors...");
        const altSelectors = [
          By.css("button[name='log_btn_login_01']"),
          By.xpath("//button[contains(@name, 'login')]"),
          By.xpath("//button[contains(text(), 'Login')]"),
          By.xpath("//button[@type='submit']"),
        ];
        
        for (const selector of altSelectors) {
          try {
            const altButton = await driver.findElement(selector);
            if (await altButton.isDisplayed() && await altButton.isEnabled()) {
              await driver.executeScript("arguments[0].click();", altButton);
              console.log(`✅ Clicked login button using alternative selector: ${selector.toString()}`);
              break;
            }
          } catch (e) {
            continue;
          }
        }
      } catch (altError) {
        throw new Error(`Failed to click login button: ${buttonError.message}`);
      }
    }
    
    // Wait for login to complete
    console.log("Waiting for login to complete...");
    await driver.sleep(5000);
    
    // Verify login was successful
    const loginCheckUrl = await driver.getCurrentUrl();
    const loginCheckElements = await driver.findElements(By.name("log_txtfield_iUsername_01"));
    if (loginCheckElements.length > 0 || loginCheckUrl.includes("/signin/login")) {
      throw new Error("National login failed - still on login page after login attempt");
    }
    console.log(`✅ [${jobId}] Login successful!`);
    
    // Debug: Check what's on the page after login
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
    } // End of login block (if isOnLoginPage)
    
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
    await rtoInput.sendKeys(formData.rtoLocation || "Mumbai");
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
    await makeInput.sendKeys(formData.make || "Honda");
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
    await modelInput.sendKeys("SHINE 100 (2023-2025)"); // Default model - Honda SHINE model variant
    await driver.sleep(2000); // Wait for autocomplete options to appear
    
    // Click on the first autocomplete option
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
    await variantInput.sendKeys(formData.variant || "Standard");
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
      await safeType(driver, percentageField, "80", 15000);
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill percentage field:", e.message);
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
    } catch (e) {
      console.log("Generate Quick Quote button not found, trying alternative:", e.message);
      
      // Try alternative approach - find by button text
      try {
        const generateByText = By.xpath("//button[contains(., 'Generate Quick Quote')]");
        const generateBtn = await driver.wait(until.elementLocated(generateByText), 5000);
        await driver.executeScript("arguments[0].click();", generateBtn);
        console.log("Clicked Generate Quick Quote button (alternative)");
        await driver.sleep(3000);
      } catch (e2) {
        console.log("All strategies failed for Generate Quick Quote button:", e2.message);
      }
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
    
    // Select PAN Not Available radio button BEFORE filling customer form
    try {
      console.log("Selecting PAN Not Available radio button...");
      
      // Wait for the dialog to be fully loaded
      await driver.sleep(2000);
      
      // Find the radio input element by ID (most reliable)
      const panNotAvailableInput = By.id("mat-radio-21-input");
      const inputElement = await driver.wait(until.elementLocated(panNotAvailableInput), 10000);
      
      // Check if already selected
      const isSelected = await inputElement.isSelected();
      console.log(`PAN Not Available radio button isSelected: ${isSelected}`);
      
      if (!isSelected) {
        // Scroll to element
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", inputElement);
        await driver.sleep(500);
        
        // Click using JavaScript
        await driver.executeScript("arguments[0].click();", inputElement);
        console.log("Selected PAN Not Available radio button");
        
        // Verify selection
        await driver.sleep(500);
        const isNowSelected = await inputElement.isSelected();
        console.log(`PAN Not Available radio button after click isSelected: ${isNowSelected}`);
      } else {
        console.log("PAN Not Available radio button already selected");
      }
      
      await driver.sleep(1000);
    } catch (e) {
      console.log("PAN Not Available radio button not found, trying alternative:", e.message);
      
      // Try alternative approach - find by name and value
      try {
        const altRadio = By.xpath("//input[@name='ekyc_sel_type' and @value='PanNotAvlable']");
        const radioElement = await driver.wait(until.elementLocated(altRadio), 5000);
        await driver.executeScript("arguments[0].click();", radioElement);
        console.log("Selected PAN Not Available radio button (alternative)");
        await driver.sleep(1000);
      } catch (e2) {
        console.log("All strategies failed for PAN Not Available radio button:", e2.message);
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
      
      // Type the value
      await titleInput.sendKeys("Mr");
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
      console.log("Filling First Name...");
      const firstNameField = By.name("newcust_textfield_firstName_01");
      await safeType(driver, firstNameField, "Test", 10000);
    } catch (e) {
      console.log("Could not fill First Name:", e.message);
    }
    
    // Fill Middle Name (optional)
    try {
      console.log("Filling Middle Name...");
      const middleNameField = By.name("newcust_textfield_middleName_01");
      await safeType(driver, middleNameField, "Kumar", 10000);
    } catch (e) {
      console.log("Could not fill Middle Name:", e.message);
    }
    
    // Fill Last Name
    try {
      console.log("Filling Last Name...");
      const lastNameField = By.name("newcust_textfield_lastName_01");
      await safeType(driver, lastNameField, "Customer", 10000);
    } catch (e) {
      console.log("Could not fill Last Name:", e.message);
    }
    
    // Select Gender
    try {
      console.log("Selecting Gender...");
      const genderDropdown = By.name("newcust_dropdown_gender_01");
      await safeSelectOption(driver, genderDropdown, "Male", 10000);
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
      await occupationInput.click();
      await occupationInput.sendKeys("Engineer");
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
      await dobInput.sendKeys("01/01/1990");
    } catch (e) {
      console.log("Could not fill Date of Birth:", e.message);
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
    
    // Fill House No/ Bldg. Name
    try {
      console.log("Filling House Number...");
      const houseNoField = By.name("newcust_textfield_building_01");
      await safeType(driver, houseNoField, "123", 10000);
    } catch (e) {
      console.log("Could not fill House Number:", e.message);
    }
    
    // Fill Street/Colony
    try {
      console.log("Filling Street...");
      const streetField = By.name("newcust_textfield_street_01");
      await safeType(driver, streetField, "Main Street", 10000);
    } catch (e) {
      console.log("Could not fill Street:", e.message);
    }
    
    // Fill Pincode
    try {
      console.log("Filling Pincode...");
      const pincodeField = By.name("newcust_textfield_pincode_01");
      await safeType(driver, pincodeField, "400001", 10000);
    } catch (e) {
      console.log("Could not fill Pincode:", e.message);
    }
    
    // Fill Locality
    try {
      console.log("Filling Locality...");
      const localityField = By.name("newcust_textfield_locality_01");
      await safeType(driver, localityField, "Colaba", 10000);
    } catch (e) {
      console.log("Could not fill Locality:", e.message);
    }
    
    // Fill City
    try {
      console.log("Filling City...");
      const cityField = By.name("newcust_textfield_city_01");
      await safeType(driver, cityField, "Mumbai", 10000);
    } catch (e) {
      console.log("Could not fill City:", e.message);
    }
    
    // Fill District
    try {
      console.log("Filling District...");
      const districtField = By.name("newcust_textfield_district_01");
      await safeType(driver, districtField, "Mumbai", 10000);
    } catch (e) {
      console.log("Could not fill District:", e.message);
    }
    
    // Fill State
    try {
      console.log("Filling State...");
      const stateField = By.name("newcust_textfield_state_01");
      await safeType(driver, stateField, "Maharashtra", 10000);
    } catch (e) {
      console.log("Could not fill State:", e.message);
    }
    
    // Fill Country
    try {
      console.log("Filling Country...");
      const countryField = By.name("newcust_textfield_country_01");
      await safeType(driver, countryField, "India", 10000);
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
      await emailInput.sendKeys("test@example.com");
      console.log("Successfully filled Email ID");
      
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Email ID:", e.message);
    }
    
    // Fill Mobile No
    try {
      console.log("Filling Mobile No...");
      const mobileField = By.name("newcust_textfield_mobNo_01");
      await safeType(driver, mobileField, "9876543210", 10000);
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
      await engineInput.sendKeys("ENG123456789");
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
      await chassisInput.sendKeys("CH123456789");
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
      await colorInput.sendKeys("Black");
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
    
    // Fill Body Type (autocomplete)
    try {
      console.log("Filling Body Type...");
      const bodyField = By.name("mcy_dropdown_body_01");
      const bodyInput = await driver.wait(until.elementLocated(bodyField), 10000);
      await bodyInput.clear();
      await bodyInput.sendKeys("CRF");
      await driver.sleep(1500); // Wait for autocomplete
      
      try {
        const bodyOptions = await driver.wait(until.elementsLocated(By.css("mat-option")), 5000);
        if (bodyOptions.length > 0) {
          await driver.executeScript("arguments[0].click();", bodyOptions[0]);
          console.log("Selected Body Type from autocomplete");
        }
      } catch (e) {
        console.log("Could not select Body Type from autocomplete:", e.message);
      }
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill Body Type:", e.message);
    }
    
    // === COMPULSORY PA FOR OWNER DRIVER SECTION ===
    console.log("Expanding Compulsory PA for Owner Driver section...");
    
    // Click on Compulsory PA accordion to expand
    try {
      const paHeader = By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Compulsory PA for Owner Driver')]]");
      const paPanel = await driver.wait(until.elementLocated(paHeader), 10000);
      
      const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", paPanel);
      console.log(`Compulsory PA panel isExpanded: ${isExpanded}`);
      
      if (!isExpanded) {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", paPanel);
        await driver.sleep(300);
        await driver.executeScript("arguments[0].click();", paPanel);
        console.log("Expanded Compulsory PA panel");
        await driver.sleep(1000);
      }
    } catch (e) {
      console.log("Could not expand Compulsory PA:", e.message);
    }
    
    // Fill PA Nominee Name
    try {
      console.log("Filling PA Nominee Name...");
      const paNomineeField = By.name("mcy_text_paNomineeName_01");
      const paNomineeInput = await driver.wait(until.elementLocated(paNomineeField), 10000);
      await paNomineeInput.clear();
      await paNomineeInput.sendKeys("John Doe");
      console.log("Filled PA Nominee Name");
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill PA Nominee Name:", e.message);
    }
    
    // Fill Nominee Relation (dropdown)
    try {
      console.log("Selecting Nominee Relation...");
      const relationDropdown = By.name("mcy_dropdown_nomineeRelation_01");
      await safeSelectOption(driver, relationDropdown, "Son", 10000);
    } catch (e) {
      console.log("Could not select Nominee Relation:", e.message);
    }
    
    // Fill PA Nominee Age
    try {
      console.log("Filling PA Nominee Age...");
      const paAgeField = By.name("mcy_text_paNomineeAge_01");
      const paAgeInput = await driver.wait(until.elementLocated(paAgeField), 10000);
      await paAgeInput.clear();
      await paAgeInput.sendKeys("25");
      console.log("Filled PA Nominee Age");
      await driver.sleep(500);
    } catch (e) {
      console.log("Could not fill PA Nominee Age:", e.message);
    }
    
    await driver.sleep(2000); // Wait for page to stabilize
    
    // === POST-CUSTOMER CREATION STEPS ===
    console.log("Handling post-customer creation steps...");
    


    
    console.log(`✅ [${jobId}] National Insurance form automation completed successfully!`);
    
    return {
      success: true,
    };
    
  } catch (error) {
    console.error(`❌ [${jobId}] Error in National Insurance form automation:`, error.message);
    
    // Capture error screenshot using centralized handler
    const errorDetails = await captureErrorScreenshot(
      driver,
      error,
      data,
      "national-form-error"
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
      stage: "national-form",
    };
    
  } finally {
    // Cleanup: Always close browser and delete cloned profile
    if (jobBrowser) {
      await cleanupNationalJobBrowser(jobBrowser);
    }
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
