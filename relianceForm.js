const { By, until, Key } = require("selenium-webdriver");
const { createFreshDriverFromBaseProfile } = require("./browser");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("./Captcha");

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

async function fillRelianceForm(data = {}) {
  const baseProfileDir = path.join(__dirname, "chrome-profile");
  let driver = null;
  let tempProfileDir = null;

  try {
    const created = await createFreshDriverFromBaseProfile(baseProfileDir);
    driver = created.driver;
    tempProfileDir = created.profileDir;

    console.log("Navigating to Reliance form...");
    await driver.get("https://smartzone.reliancegeneral.co.in/Login/IMDLogin");

    // === STEP 0: get captcha text ===
    await getCaptchaScreenShot(driver, "reliance_captcha");
    const filePath = path.join(__dirname, "reliance_captcha.png");
    const fileData = fs.readFileSync(filePath, "base64");
    const imageUrl = `data:image/jpeg;base64,${fileData}`;
    const captchaText = await extractCaptchaText(imageUrl);
    console.log("Captcha text:", captchaText);
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
      await safeSendKeys(driver, By.id("MiddleName"), data.middleName || "M");
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
        data.fatherFirstName || "Robert"
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
      await safeSendKeys(driver, By.id("mobileno"), data.mobile || "8838166045");
      

      
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
        // Wait for the Vertical Code dropdown
        console.log("Waiting for Vertical Code dropdown...");
        const verticalCodeDropdown = await driver.wait(
          until.elementLocated(By.id("ddlobjBranchDetailAgentsHnin")),
          15000
        );
        console.log("Vertical Code dropdown found!");
        
        // Click on the dropdown to open it
        await driver.executeScript("arguments[0].click();", verticalCodeDropdown);
        await driver.sleep(2000);
        console.log("Vertical Code dropdown clicked!");
        
        // Select "GIRNAR FINSERV PRIVATE LIMITED_518898" option
        console.log("Selecting GIRNAR FINSERV PRIVATE LIMITED_518898...");
        const girnarOption = await driver.wait(
          until.elementLocated(By.xpath("//li[contains(text(), 'GIRNAR FINSERV PRIVATE LIMITED_518898')]")),
          10000
        );
        await driver.executeScript("arguments[0].click();", girnarOption);
        console.log("Selected GIRNAR FINSERV PRIVATE LIMITED_518898!");
        await driver.sleep(2000);
        
        // Wait for and click the "Validate Customer" button
        console.log("Looking for Validate Customer button...");
        const validateButton = await driver.wait(
          until.elementLocated(By.id("BtnSaveClientDetails")),
          10000
        );
        await driver.wait(until.elementIsVisible(validateButton), 5000);
        await driver.wait(until.elementIsEnabled(validateButton), 5000);
        
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", validateButton);
        await driver.sleep(500);
        
        try {
          await validateButton.click();
        } catch {
          await driver.executeScript("arguments[0].click();", validateButton);
        }
        console.log("Validate Customer button clicked!");
        
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
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", vehicleMakeInput);
        await driver.sleep(500);
        
        // Clear the field first
        await vehicleMakeInput.clear();
        await driver.sleep(500);
        
        // Click on the input to focus it
        await vehicleMakeInput.click();
        await driver.sleep(500);
        
        // Type the search text and trigger events
        await vehicleMakeInput.sendKeys("tvs scooty zest");
        await driver.sleep(1000);
        
        // Trigger additional events to ensure autocomplete works
        await driver.executeScript(`
          var input = arguments[0];
          var event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
          
          var keyupEvent = new Event('keyup', { bubbles: true });
          input.dispatchEvent(keyupEvent);
          
          var changeEvent = new Event('change', { bubbles: true });
          input.dispatchEvent(changeEvent);
        `, vehicleMakeInput);
        
        // Wait for API call to complete and dropdown to appear
        await driver.sleep(4000);
        console.log("Waiting for dropdown options to appear...");
        
        // Try multiple selectors for the dropdown items
        let firstResult = null;
        try {
          // Try Kendo autocomplete listbox items
          firstResult = await driver.wait(
            until.elementLocated(By.xpath("//ul[@id='VehicleDetailsMakeModel_listbox']//li[1]")),
            5000
          );
        } catch (e) {
          try {
            // Try general k-item class
            firstResult = await driver.wait(
              until.elementLocated(By.xpath("//li[contains(@class, 'k-item')][1]")),
              5000
            );
          } catch (e2) {
            try {
              // Try any li element in autocomplete
              firstResult = await driver.wait(
                until.elementLocated(By.xpath("//li[contains(@class, 'k-list-item')][1]")),
                5000
              );
            } catch (e3) {
              console.log("Could not find dropdown options, trying alternative approach...");
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

        // Purchase Date - fill with today's date
        console.log("Filling purchase date...");
        const today = new Date().toLocaleDateString('en-GB'); // DD/MM/YYYY format
        const purchaseDateInput = await driver.wait(
          until.elementLocated(By.id("Date_PurchaseVehicle")),
          10000
        );
        await driver.executeScript(`
          arguments[0].value = '${today}';
          var event = new Event('change', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `, purchaseDateInput);
        console.log("Filled purchase date with today's date");

        // Registration Date - fill with today's date
        console.log("Filling registration date...");
        const registrationDateInput = await driver.wait(
          until.elementLocated(By.id("Date_RegistrationVehicle")),
          10000
        );
        await driver.executeScript(`
          arguments[0].value = '${today}';
          var event = new Event('change', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `, registrationDateInput);
        console.log("Filled registration date with today's date");

        // Manufacturing Year and Month - Try a simpler approach
        console.log("Attempting manufacturing year and month selection...");
        try {
          // Try to set values directly using JavaScript
          await driver.executeScript(`
            // Try to set manufacturing year
            var yearDropdown = document.getElementById('Manufacturing_YearVehicle');
            if (yearDropdown) {
              var kendoYearWidget = $(yearDropdown).data('kendoDropDownList');
              if (kendoYearWidget) {
                // Try to select the first available year
                var dataSource = kendoYearWidget.dataSource;
                if (dataSource && dataSource.data().length > 0) {
                  var firstYear = dataSource.data()[0];
                  kendoYearWidget.value(firstYear.Value);
                  kendoYearWidget.trigger('change');
                  console.log('Set manufacturing year to:', firstYear.Text);
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
                    var firstMonth = dataSource.data()[0];
                    kendoMonthWidget.value(firstMonth.Value);
                    kendoMonthWidget.trigger('change');
                    console.log('Set manufacturing month to:', firstMonth.Text);
                  }
                }
              }
            }, 1000);
          `);
          
          await driver.sleep(3000); // Wait for the JavaScript to execute
          console.log("Attempted to set manufacturing year and month via JavaScript");
          
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
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", rtoCityInput);
        await driver.sleep(500);
        
        // Clear the field first
        await rtoCityInput.clear();
        await driver.sleep(500);
        
        // Click on the input to focus it
        await rtoCityInput.click();
        await driver.sleep(500);
        
        // Type the search text and trigger events
        await rtoCityInput.sendKeys("coimbatore");
        await driver.sleep(1000);
        
        // Trigger additional events to ensure autocomplete works
        await driver.executeScript(`
          var input = arguments[0];
          var event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
          
          var keyupEvent = new Event('keyup', { bubbles: true });
          input.dispatchEvent(keyupEvent);
          
          var changeEvent = new Event('change', { bubbles: true });
          input.dispatchEvent(changeEvent);
        `, rtoCityInput);
        
        // Wait for API call to complete and dropdown to appear
        await driver.sleep(4000);
        console.log("Waiting for RTO city dropdown options to appear...");
        
        // Try multiple selectors for the dropdown items
        let rtoCitySelected = false;
        try {
          // Try Kendo autocomplete listbox items
          const firstRtoResult = await driver.wait(
            until.elementLocated(By.xpath("//ul[@id='RTOCityLocation_listbox']//li[1]")),
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
              until.elementLocated(By.xpath("//li[contains(@class, 'k-item')][1]")),
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
                until.elementLocated(By.xpath("//li[contains(@class, 'k-list-item')][1]")),
                5000
              );
              await driver.wait(until.elementIsVisible(firstRtoResult), 3000);
              await firstRtoResult.click();
              console.log("Selected first RTO city result from list items");
              rtoCitySelected = true;
            } catch (e3) {
              console.log("Could not find RTO city dropdown options, trying alternative approach...");
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
        const engineNumberInput = await driver.wait(
          until.elementLocated(By.id("EngineNumberVehicle")),
          10000
        );
        await driver.executeScript(`
          arguments[0].value = 'FG5HS2808584';
          var event = new Event('input', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `, engineNumberInput);
        console.log("Filled engine number");

        // Chassis Number
        console.log("Filling chassis number...");
        const chassisNumberInput = await driver.wait(
          until.elementLocated(By.id("ChasisNumberVehicle")),
          10000
        );
        await driver.executeScript(`
          arguments[0].value = 'MD626DG56S2H08322';
          var event = new Event('input', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `, chassisNumberInput);
        console.log("Filled chassis number");

        // Set IDV value
        console.log("Setting IDV value...");
        await driver.executeScript(`
          document.getElementById('ActualIDVVehicle').value = '75000';
        `);
        console.log("Set IDV value to 75000");

        // Click "Get Coverage Details" button
        console.log("Clicking 'Get Coverage Details' button...");
        const getCoverageButton = await driver.wait(
          until.elementLocated(By.id("btnFetchIDV")),
          10000
        );
        await driver.wait(until.elementIsVisible(getCoverageButton), 5000);
        await driver.wait(until.elementIsEnabled(getCoverageButton), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", getCoverageButton);
        await driver.sleep(1000);
        
        // Try multiple click methods to ensure the click is registered
        try {
          // First try regular click
          await getCoverageButton.click();
          console.log("Regular click attempted on 'Get Coverage Details' button");
        } catch (e) {
          console.log("Regular click failed, trying JavaScript click...");
          await driver.executeScript("arguments[0].click();", getCoverageButton);
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
        
        console.log("Clicked 'Get Coverage Details' button with multiple methods");
        await driver.sleep(5000); // Wait longer for the API call to complete

        // Click PA to Owner Driver checkbox to open modal
        console.log("Clicking PA to Owner Driver checkbox to open modal...");
        const paOwnerDriverCheckbox = await driver.wait(
          until.elementLocated(By.id("ChkBox24")),
          10000
        );
        await driver.executeScript("arguments[0].click();", paOwnerDriverCheckbox);
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
        await driver.executeScript("arguments[0].click();", helmetCoverCheckbox);
        console.log("Unchecked Helmet Cover checkbox");
        await driver.sleep(1000);

        // Check "Is Registration Address Same" checkbox
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
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", calculatePremiumButton);
        await driver.sleep(500);
        
        try {
          await calculatePremiumButton.click();
        } catch {
          await driver.executeScript("arguments[0].click();", calculatePremiumButton);
        }
        console.log("Clicked 'Calculate Premium' button!");
        
        // Wait for premium calculation to complete
        await driver.sleep(3000);
        console.log("Premium calculation completed!");

        console.log("All vehicle details filled successfully!");
        
      } catch (err) {
        console.log("Error handling post-submission elements:", err.message);
        // Take screenshot for debugging
        try {
          const screenshot = await driver.takeScreenshot();
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(`post-submission-error-${timestamp}.png`, screenshot, 'base64');
          console.log(`Post-submission error screenshot saved as post-submission-error-${timestamp}.png`);
        } catch (e) {
          console.log("Could not take post-submission screenshot:", e.message);
        }
        // Don't throw error here, just log it as the main form submission was successful
      }

    } catch (err) {
      console.log("Error filling modal fields:", err.message);
      // Take screenshot to debug the issue
      try {
        const screenshot = await driver.takeScreenshot();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
          `error-screenshot-${timestamp}.png`,
          screenshot,
          "base64"
        );
        console.log(
          `Error screenshot saved as error-screenshot-${timestamp}.png`
        );

        // Also save page source for debugging
        const pageSource = await driver.getPageSource();
        fs.writeFileSync(`page-source-${timestamp}.html`, pageSource);
        console.log(`Page source saved as page-source-${timestamp}.html`);
      } catch (e) {
        console.log(
          "Could not take screenshot or save page source:",
          e.message
        );
      }
      throw err;
    }

    await driver.sleep(2000);

    return { success: true };
  } catch (e) {
    console.error("[relianceForm] Error:", e.message || e);
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

async function getCaptchaScreenShot(driver, filename = "image_screenshot") {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));

  const imageBase64 = await imgElement.takeScreenshot(true);

  fs.writeFileSync(`${filename}.png`, imageBase64, "base64");
  console.log(`Screenshot saved as ${filename}.png`);
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
  aadhar: "123412341234",
};

module.exports = { fillRelianceForm };
