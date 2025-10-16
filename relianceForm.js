const { By, until, Key } = require('selenium-webdriver');
const { createFreshDriverFromBaseProfile } = require('./browser');
const fs = require('fs');
const path = require('path');

async function waitForLoaderToDisappear(driver, locator = By.css('.k-loading-mask'), timeout = 20000) {
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
        if (e.name === 'StaleElementReferenceError') {
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
    await driver.executeScript('arguments[0].click();', el);
  }
  return el;
}

async function forceSendKeys(driver, locator, text, timeout = 10000) {
  try {
    const element = await driver.wait(until.elementLocated(locator), timeout);
    // No visibility check, just scroll and set value
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
    await driver.sleep(500);
    await driver.executeScript(`
      arguments[0].value = '${text}';
      var event = new Event('input', { bubbles: true });
      arguments[0].dispatchEvent(event);
    `, element);
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
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
    await driver.sleep(500);
    
    try {
      await element.clear();
      await element.sendKeys(text);
    } catch {
      await driver.executeScript(`
        arguments[0].value = '';
        arguments[0].value = '${text}';
        var event = new Event('input', { bubbles: true });
        arguments[0].dispatchEvent(event);
      `, element);
    }
    return element;
  } catch (error) {
    console.log(`Error in safeSendKeys for ${locator}:`, error.message);
    throw error;
  }
}

async function safeSelectDropdown(driver, selectId, value, timeout = 10000) {
  try {
    const selectElement = await driver.wait(until.elementLocated(By.id(selectId)), timeout);
    await driver.wait(until.elementIsVisible(selectElement), timeout);
    await driver.wait(until.elementIsEnabled(selectElement), timeout);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", selectElement);
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


async function waitForElementAndRetry(driver, locator, action, maxRetries = 3, timeout = 10000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} for ${locator}...`);
      const element = await driver.wait(until.elementLocated(locator), timeout);
      await driver.wait(until.elementIsVisible(element), timeout);
      await driver.wait(until.elementIsEnabled(element), timeout);
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
      await driver.sleep(500);
      
      if (action === 'click') {
        try {
          await element.click();
        } catch {
          await driver.executeScript("arguments[0].click();", element);
        }
      } else if (action === 'sendKeys') {
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

async function fillRelianceForm(data = {}) {
  const baseProfileDir = path.join(__dirname, 'chrome-profile');
  let driver = null;
  let tempProfileDir = null;

  try {
    const created = await createFreshDriverFromBaseProfile(baseProfileDir);
    driver = created.driver;
    tempProfileDir = created.profileDir;

    console.log("Navigating to Reliance form...");
    await driver.get('https://smartzone.reliancegeneral.co.in/Login/IMDLogin');

    await getCaptchaScreenShot(driver);

    // === STEP 1: wait for manual login ===
    console.log("Waiting 30s for manual login...");
    await driver.sleep(30000);

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

    await driver.actions({ bridge: true }).move({ origin: motorsMenu }).perform();
    await driver.sleep(3000);
    console.log("Hovered on Motors menu...");

    // === STEP 3: click Two Wheeler ===
    const twoWheelerLink = await driver.wait(
      until.elementLocated(By.xpath("//li/a[contains(text(),'Two Wheeler')]")),
      15000
    );
    await driver.actions({ bridge: true }).move({ origin: twoWheelerLink }).perform();
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
      until.elementLocated(By.css("span[aria-owns='ddlMotorProducts_listbox']")),
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
      until.elementLocated(By.xpath(`//li[normalize-space(.) = '${optionText}']`)),
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
        until.elementLocated(By.xpath("//a[contains(text(),'Skip To Main Page')]")),
        5000
      );
      await driver.executeScript("arguments[0].click();", skipLink);
      console.log("Clicked 'Skip To Main Page'");
      await driver.sleep(2000);
    } catch (err) {
      console.log("No skip link detected, continuing...");
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
      await safeSelectDropdown(driver, "proposerTitle1", data.proposerTitle || "Mr.");
      
      // Name fields
      await safeSendKeys(driver, By.id("FirstName"), data.firstName || "John");
      await safeSendKeys(driver, By.id("MiddleName"), data.middleName || "M");
      await safeSendKeys(driver, By.id("LastName"), data.lastName || "Doe");

      // DOB - Special handling for date field
      console.log("Filling DOB field...");
      const dobField = await waitForElementAndRetry(driver, By.id("dob"), 'sendKeys');
      await driver.executeScript(`
        arguments[0].value = '';
        arguments[0].value = '${data.dob || "06-10-2007"}';
        var event = new Event('input', { bubbles: true });
        arguments[0].dispatchEvent(event);
      `, dobField);

      // Father's details
      await safeSelectDropdown(driver, "proposerTitle2", data.fatherTitle || "Mr.");
      await safeSendKeys(driver, By.name("FatherFirstName"), data.fatherFirstName || "Robert");

      // Address fields
      await safeSendKeys(driver, By.id("flat"), data.flatNo || "101");
      await safeSendKeys(driver, By.id("floor"), data.floorNo || "1");
      await safeSendKeys(driver, By.id("Nameofpremises"), data.premisesName || "Sunshine Apartments");
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
      const pincodeInput = await safeSendKeys(driver, By.id("pincodesearch"), data.pinCode || "614630");
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
      await safeSendKeys(driver, By.id("mobileno"), data.mobile || "9876543210");
      

      
      console.log("Filled all main form mandatory fields!");
      await driver.sleep(2000);

      // === STEP 7: Submit Button ===
      console.log("Looking for submit button...");
      await waitForElementAndRetry(driver, By.id("btnSubmit"), 'click');
      console.log("Clicked Submit button!");

      // Wait for submission to process
      await driver.sleep(5000);
      console.log("Form submission attempted!");

      // Back to main content
      await driver.switchTo().defaultContent();

    } catch (err) {
      console.log("Error filling modal fields:", err.message);
      // Take screenshot to debug the issue
      try {
        const screenshot = await driver.takeScreenshot();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(`error-screenshot-${timestamp}.png`, screenshot, 'base64');
        console.log(`Error screenshot saved as error-screenshot-${timestamp}.png`);
        
        // Also save page source for debugging
        const pageSource = await driver.getPageSource();
        fs.writeFileSync(`page-source-${timestamp}.html`, pageSource);
        console.log(`Page source saved as page-source-${timestamp}.html`);
      } catch (e) {
        console.log("Could not take screenshot or save page source:", e.message);
      }
      throw err;
    }

    await driver.sleep(2000);

    return { success: true };
  } catch (e) {
    console.error('[relianceForm] Error:', e.message || e);
    return { success: false, error: String(e.message || e) };
  } finally {
    try {
      // if (driver) await driver.quit();
    } catch {}
    if (tempProfileDir) {
      try {
        await deleteDirectoryRecursive(tempProfileDir);
      } catch {}
    }
  }
}

async function getCaptchaScreenShot(driver) {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));

  const imageBase64 = await imgElement.takeScreenshot(true);

  fs.writeFileSync("image_screenshot.png", imageBase64, "base64");
  console.log("Screenshot saved as image_screenshot.png");

}

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
  aadhar: "123412341234"
};

module.exports = { fillRelianceForm };