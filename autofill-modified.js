const { Builder, By, until, Key } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
 
// Enhanced helper functions with stale element handling
async function safeClick(driver, locator, timeout = 15000) {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
        try {
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await driver.wait(until.elementIsVisible(element), timeout);
            await driver.wait(until.elementIsEnabled(element), timeout);
            await element.click();
            return element;
        } catch (error) {
            attempts++;
            if (attempts === maxAttempts) {
                throw new Error(`Failed to click element after ${maxAttempts} attempts: ${error.message}`);
            }
            await driver.sleep(1000);
        }
    }
}
 
async function safeSendKeys(driver, locator, keys, timeout = 15000) {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
        try {
            const element = await driver.wait(until.elementLocated(locator), timeout);
            await driver.wait(until.elementIsVisible(element), timeout);
            await driver.wait(until.elementIsEnabled(element), timeout);
            await element.clear();
            await element.sendKeys(keys);
            return element;
        } catch (error) {
            attempts++;
            if (attempts === maxAttempts) {
                throw new Error(`Failed to send keys to element after ${maxAttempts} attempts: ${error.message}`);
            }
            await driver.sleep(1000);
        }
    }
}
 
async function safeSelectOption(driver, selectLocator, optionValue, timeout = 15000) {
    let attempts = 0;
    const maxAttempts = 3;
    
    while (attempts < maxAttempts) {
        try {
            // Use JavaScript to select the option directly
            const selectElement = await driver.wait(until.elementLocated(selectLocator), timeout);
            await driver.executeScript(`
                var select = arguments[0];
                var value = arguments[1];
                for (var i = 0; i < select.options.length; i++) {
                    if (select.options[i].value === value) {
                        select.selectedIndex = i;
                        var event = new Event('change', { bubbles: true });
                        select.dispatchEvent(event);
                        break;
                    }
                }
            `, selectElement, optionValue);
            
            // Verify the selection was successful
            const selectedValue = await selectElement.getAttribute("value");
            if (selectedValue === optionValue) {
                return selectElement;
            } else {
                throw new Error("Option selection failed");
            }
        } catch (error) {
            attempts++;
            if (attempts === maxAttempts) {
                console.log(`JavaScript selection failed, trying manual method for option ${optionValue}`);
                // Fallback to manual selection
                try {
                    const select = await driver.wait(until.elementLocated(selectLocator), timeout);
                    await select.click();
                    
                    const optionLocator = By.xpath(`.//option[@value="${optionValue}"]`);
                    const option = await select.findElement(optionLocator);
                    await option.click();
                    return option;
                } catch (fallbackError) {
                    throw new Error(`Failed to select option after fallback: ${fallbackError.message}`);
                }
            }
            await driver.sleep(1000);
        }
    }
}

async function safeSelectOptionByValue(driver, selectLocator, value, timeout = 15000) {
    const selectElement = await driver.wait(until.elementLocated(selectLocator), timeout);
    await driver.executeScript(`
        var select = arguments[0];
        var value = arguments[1];
        select.value = value;
        var event = new Event('change', { bubbles: true });
        select.dispatchEvent(event);
    `, selectElement, value);
 
    return selectElement;
}
 
(async function fillInsuranceForm() {
    let options = new chrome.Options();
    options.addArguments("--start-maximized"); // Start browser maximized
    
    const macChromePaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chrome.app/Contents/MacOS/Google Chrome'
    ];
    
    const fs = require('fs');
    let chromePath = null;
    
    for (const path of macChromePaths) {
        if (fs.existsSync(path)) {
            chromePath = path;
            break;
        }
    }
    
    if (chromePath) {
        options.setChromeBinaryPath(chromePath);
        console.log(`Using Chrome at: ${chromePath}`);
    } else {
        console.log("Chrome not found at standard locations, letting Selenium find it automatically");
    }
 
    let driver = await new Builder()
        .forBrowser("chrome")
        .setChromeOptions(options)
        .build();
 
    try {
        await driver.manage().setTimeouts({ implicit: 40000, pageLoad: 40000, script: 40000 });
        
        console.log("Opening the login page...");
        await driver.get("https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login");
 
        console.log("Waiting 20 seconds for you to manually login...");
        await driver.sleep(20000);
        
        console.log("Navigating to Policy Transaction menu...");
        await safeClick(driver, By.xpath("//a[contains(@class, 'menuColor') and contains(., 'Policy Transaction')]"), 20000);
        
        await driver.sleep(3000);
        
        console.log("Clicking on 'Make New/Renew Policy'...");
        await safeClick(driver, By.xpath("//a[contains(@href, 'MenuAction.do?method=strbtn') and contains(., 'Make New/Renew Policy')]"), 20000);
        
        console.log("Waiting for product selection page...");
        await driver.sleep(5000);
        
        try {
            await safeClick(driver, By.id("selectProduct"), 15000);
        } catch (error) {
            console.log("Product selection page not found or already passed, continuing...");
        }
        
        console.log("Waiting for form to load...");
        await driver.sleep(8000);
 
        console.log("Filling Risk Details...");
        await safeSelectOption(driver, By.id("v_make"), "3");
        await driver.sleep(3000);
        await safeSelectOption(driver, By.id("regst"), "43");
        await safeSelectOption(driver, By.id("business"), "New");
 
        console.log("Filling Vehicle Details...");
        
        // ✅ Fixed New Vehicle checkbox
        console.log("Checking New Vehicle checkbox if required...");
        try {
            const newVehicleCheckbox = await driver.findElement(By.id("newvehchk1"));
            await driver.executeScript("arguments[0].scrollIntoView(true);", newVehicleCheckbox);
            await driver.sleep(500);
 
            const isDisabled = await newVehicleCheckbox.getAttribute("disabled");
            const isChecked = await newVehicleCheckbox.isSelected();
 
            if (!isDisabled && !isChecked) {
                await newVehicleCheckbox.click();
                console.log("New Vehicle checkbox clicked successfully");
            } else {
                console.log("Checkbox is disabled or already checked");
            }
        } catch (err) {
            console.log("New Vehicle checkbox not found or not clickable:", err.message);
        }
 
        await safeSendKeys(driver, By.id("chasisNumber"), "MD626DG56S2H08322");
        await safeSendKeys(driver, By.id("engineNumber"), "FG5HS2808545");
 
        console.log("Selecting manufacturer...");
        try {
            await driver.executeScript(`
                var select = document.getElementById('selectedNumNameCode');
                if (select) {
                    for (var i = 0; i < select.options.length; i++) {
                        if (select.options[i].value === '3708@TVS') {
                            select.selectedIndex = i;
                            var event = new Event('change', { bubbles: true });
                            select.dispatchEvent(event);
                            break;
                        }
                    }
                }
            `);
            
            const selectedManufacturer = await driver.executeScript(`
                return document.getElementById('selectedNumNameCode').value;
            `);
            
            if (selectedManufacturer !== '3708@TVS') {
                throw new Error("Manufacturer selection failed");
            }
        } catch (error) {
            console.log("JavaScript manufacturer selection failed, trying alternative approach...");
            const manufacturerDropdown = await driver.findElement(By.id('selectedNumNameCode'));
            await manufacturerDropdown.click();
            await driver.sleep(1000);
            await driver.executeScript(`
                var select = document.getElementById('selectedNumNameCode');
                for (var i = 0; i < select.options.length; i++) {
                    if (select.options[i].text.includes('HONDA')) {
                        select.selectedIndex = i;
                        var event = new Event('change', { bubbles: true });
                        select.dispatchEvent(event);
                        break;
                    }
                }
            `);
        }
        
        await driver.sleep(2000);
        
        console.log("Selecting model...");
        try {
            await driver.executeScript(`
                var select = document.getElementById('makeMotorDisplay');
                if (select) {
                    for (var i = 0; i < select.options.length; i++) {
                        if (select.options[i].value.includes('ZEST@370958@scooty')) {
                            select.selectedIndex = i;
                            var event = new Event('change', { bubbles: true });
                            select.dispatchEvent(event);
                            break;
                        }
                    }
                }
            `);
        } catch (error) {
            console.log("Model selection failed, continuing...");
        }
        
        await driver.sleep(2000);
 
        // await driver.executeScript(`
        //     var dateField = document.getElementById('dtPurchaseStr');
        //     if (dateField) {
        //         dateField.value = '01/01/2020';
        //         var event = new Event('change', { bubbles: true });
        //         dateField.dispatchEvent(event);
        //         if (typeof regDtValidation === 'function') {
        //             setTimeout(regDtValidation, 100);
        //         }
        //         if (typeof checkDateValidation === 'function') {
        //             setTimeout(function() { checkDateValidation('01/01/2020'); }, 100);
        //         }
        //     }
        // `);
        
        // await driver.sleep(1000);
 
        // await safeSelectOption(driver, By.name("makeMonthgc"), "01");
        // await safeSendKeys(driver, By.id("yearOfManufacturing"), "2020");
 
        const purchaseDateInput = await driver.wait(
  until.elementLocated(By.id("dtPurchaseStr")),
  10000
);
await driver.executeScript("arguments[0].scrollIntoView(true);", purchaseDateInput);
await driver.sleep(500);
await purchaseDateInput.clear();
await purchaseDateInput.sendKeys("16/09/2025"); // 🔹 change date as needed
console.log("Date of Purchase entered");
 
// Fill Date of Procure by Present Owner
const procureDateInput = await driver.wait(
  until.elementLocated(By.id("dateOfProcurebyPresentOwner")),
  10000
);
await driver.executeScript("arguments[0].scrollIntoView(true);", procureDateInput);
await driver.sleep(500);
await procureDateInput.clear();
await procureDateInput.sendKeys("16/09/2025"); // 🔹 change date as needed
console.log("Date of Procure by Present Owner entered");
 
        console.log("Selecting body type...");
        await driver.executeScript(`
            var bodyTypeSelect = document.getElementById('bodyType');
            if (bodyTypeSelect && bodyTypeSelect.options.length > 1) {
                bodyTypeSelect.selectedIndex = 1;
                var event = new Event('change', { bubbles: true });
                bodyTypeSelect.dispatchEvent(event);
            }
        `);
        
        await driver.sleep(1000);
 
        console.log("Filling PUC and DNCR...");
        await safeSelectOption(driver, By.name("ynPuc"), "Yes");
        await safeSelectOption(driver, By.name("ynDncr"), "No");
 
        console.log("Filling Insured Details...");
        await driver.executeScript(`
            var noRadio = document.querySelector('input[name="customerIdShowHide"][value="N"]');
            if (noRadio) {
                noRadio.click();
                var event = new Event('change', { bubbles: true });
                noRadio.dispatchEvent(event);
            }
        `);
        
        await driver.sleep(1000);
 
        await safeSelectOption(driver, By.id("clientType"), "1");
        await safeSelectOption(driver, By.id("insuredname1"), "MR.");
        await safeSendKeys(driver, By.id("insuredname2"), "John Doe");
        await safeSendKeys(driver, By.id("addressOfInsured"), "123 Main Street, Chennai");
            await driver.sleep(3000);
        await safeSendKeys(driver, By.id("PIN_CODE"), "600001");
        await driver.sleep(3000);
        await safeSendKeys(driver, By.id("emailAddress"), "johndoe@example.com");
        await safeSendKeys(driver, By.id("mobile"), "9876543210");
        await driver.executeScript(`
            var dobField = document.getElementById('dateOfBirthString');
            if (dobField) {
                dobField.value = '01/01/1980';
                var event = new Event('change', { bubbles: true });
                dobField.dispatchEvent(event);
            }
        `);
        await safeSelectOption(driver, By.id("OCCUPATION_CODE"), "1");
        // await safeSendKeys(driver, By.id("pannumber"), "ABCDE1234F");
 
        console.log("Filling Vehicle Zone and IDV...");
        await driver.sleep(3000);
      async function safeSelectOptionByValue(driver, selectLocator, value, timeout = 15000) {
    const selectElement = await driver.wait(until.elementLocated(selectLocator), timeout);
    await driver.executeScript(`
        var select = arguments[0];
        var value = arguments[1];
        select.value = value;
        var event = new Event('change', { bubbles: true });
        select.dispatchEvent(event);
    `, selectElement, value);
 
    return selectElement;
}
 
// Usage
await safeSelectOptionByValue(driver, By.id("rtaDesc"), "TN99 COIMBATORE WEST@4540");
 
        
        await driver.sleep(3000);
        const amount = process.argv[2] || "70000"; // Use command-line argument or default
        await safeSendKeys(driver, By.id("invoicevalue"), amount);
        await safeSelectOption(driver, By.id("lonTermCoverType1"), "1");
 
        console.log("Clicking on More Covers & Info button...");
        await driver.executeScript(`
            var moreCoversBtn = document.querySelector('img[src*="MoreCoversNInfo.JPG"]');
            if (moreCoversBtn) {
                moreCoversBtn.click();
            } else {
                var buttons = document.querySelectorAll('img');
                for (var i = 0; i < buttons.length; i++) {
                    if (buttons[i].src.includes('MoreCovers')) {
                        buttons[i].click();
                        break;
                    }
                }
            }
        `);
 
        await driver.sleep(5000);
 
        console.log("Unchecking PA Cover checkbox...");
        try {
            const paCoverCheckbox = await driver.findElement(By.id("ynPAcover"));
            const isChecked = await paCoverCheckbox.isSelected();
            if (isChecked) {
                await paCoverCheckbox.click();
                console.log("PA Cover checkbox unchecked successfully");
            } else {
                console.log("PA Cover checkbox was already unchecked");
            }
        } catch (error) {
            console.log("PA Cover checkbox not found or not interactable:", error.message);
        }
 
        await driver.sleep(2000);
 
        console.log("Changing Owner Driver CPA Option to Yes...");
        try {
            await safeSelectOption(driver, By.name("ynOwnerDrivCpaOpt"), "No");
            console.log("Owner Driver CPA Option changed to Yes successfully");
        } catch (error) {
            console.log("Failed to change Owner Driver CPA Option:", error.message);
        }
 
        console.log("Waiting for 3 minutes before finishing...");
        await driver.sleep(1800);
 
        console.log("Clicking Back button...");
        try {
            await driver.executeScript(`
                var backButton = document.querySelector('img[src*="Back.JPG"]');
                if (backButton) {
                    backButton.click();
                } else {
                    var buttons = document.querySelectorAll('img');
                    for (var i = 0; i < buttons.length; i++) {
                        if (buttons[i].src.includes('Back')) {
                            buttons[i].click();
                            break;
                        }
                    }
                }
            `);
            console.log("Back button clicked successfully");
        } catch (error) {
            console.log("Failed to click Back button:", error.message);
        }
 
        // ✅ Fixed Compute Premium button
        console.log("Clicking Compute Premium button...");
        try {
            const computeBtn = await driver.wait(until.elementLocated(By.id("compute")), 20000);
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", computeBtn);
            await driver.sleep(500);
            try {
                await computeBtn.click();
            } catch (err) {
                console.log("Normal click failed, using JS click...");
                await driver.executeScript("arguments[0].click();", computeBtn);
            }
            console.log("Compute Premium button clicked successfully");
        } catch (error) {
            console.log("Failed to click Compute Premium button:", error.message);
        }
 
        console.log("Form filled successfully!");
 
        try {
    await driver.wait(until.alertIsPresent(), 10000); // wait until alert shows up
    let alert = await driver.switchTo().alert();
    console.log("Alert text:", await alert.getText()); // (optional) log alert text
    await alert.accept(); // click "OK"
    console.log("Alert accepted successfully");
} catch (err) {
    console.log("No alert appeared:", err.message);
}
console.log("Clicking Update image button...");
try {
    // Wait for the image button to be present
    const updateImg = await driver.wait(
        until.elementLocated(By.id("updt")),
        15000
    );
 
    // Scroll into view (optional)
    await driver.executeScript("arguments[0].scrollIntoView(true);", updateImg);
    await driver.sleep(500);
 
    // Click the image
    try {
        await updateImg.click();
    } catch (err) {
        console.log("Normal click failed, using JS click...");
        await driver.executeScript("arguments[0].click();", updateImg);
    }
 
    console.log("Update image button clicked successfully");
} catch (error) {
    console.log("Failed to click Update image button:", error.message);
}
console.log("Waiting for alert after Compute Premium...");
try {
    await driver.wait(until.alertIsPresent(), 10000);
    let alert = await driver.switchTo().alert();
    console.log("Alert text:", await alert.getText());
    await alert.accept();
    console.log("Alert accepted successfully");
} catch (err) {
    console.log("No alert appeared:", err.message);
}
await driver.sleep(2000);
console.log("Clicking Update Ckyc button...");
 
try {
    // Handle any potential alerts first
    try {
        await driver.wait(until.alertIsPresent(), 5000);
        let alert = await driver.switchTo().alert();
        console.log("Alert text before CKYC:", await alert.getText());
        await alert.accept();
        console.log("Alert accepted before CKYC");
    } catch (err) {
        console.log("No alert present before CKYC:", err.message);
    }
 
    // Save the original window handle
    const originalWindow = await driver.getWindowHandle();
 
    // Wait a bit to ensure page has updated
    await driver.sleep(2000);
 
    // Locate the CKYC button safely
    let verifyButton;
    try {
        verifyButton = await driver.wait(
            until.elementLocated(By.name("verifykyc")),
            30000
        );
        await driver.executeScript("arguments[0].scrollIntoView(true);", verifyButton);
        await driver.sleep(500);
        
        // Check if element is interactable
        const isEnabled = await verifyButton.isEnabled();
        const isDisplayed = await verifyButton.isDisplayed();
        console.log(`CKYC button - Enabled: ${isEnabled}, Displayed: ${isDisplayed}`);
        
        if (isEnabled && isDisplayed) {
            try {
                await verifyButton.click();
            } catch {
                await driver.executeScript("arguments[0].click();", verifyButton);
            }
            console.log("Update CKYC button clicked successfully");
        } else {
            throw new Error("CKYC button is not interactable");
        }
    } catch (error) {
        throw new Error("Failed to locate or click CKYC button: " + error.message);
    }
 
    // Wait for new window and handle CKYC process
    await driver.wait(async () => {
        const handles = await driver.getAllWindowHandles();
        return handles.length > 1;
    }, 20000);
 
    const windows = await driver.getAllWindowHandles();
    for (let handle of windows) {
        if (handle !== originalWindow) {
            await driver.switchTo().window(handle);
            break;
        }
    }
    console.log("Switched to CKYC window");
    
    // Check if Offline KYC button is enabled
    let offlineButton;
    try {
        offlineButton = await driver.wait(
            until.elementLocated(By.xpath("//button[@name='param' and @value='Offline']")),
            10000
        );
        
        const isOfflineEnabled = await offlineButton.isEnabled();
        console.log(`Offline KYC button enabled: ${isOfflineEnabled}`);
        
        if (isOfflineEnabled) {
            await offlineButton.click();
            console.log("Offline KYC button clicked successfully");
            
            // Fill CKYC form if needed
            // await safeSelectOption(driver, By.id("proofOfIdentity"), "Passport");
            // await safeSendKeys(driver, By.id("documentNo"), "P1234567");
            // await safeSelectOption(driver, By.id("origVerificationStat"), "Verified");
            
            // Save CKYC if needed
            // await safeClick(driver, By.xpath("//button[@name='param' and @value='Save']"));
            // console.log("CKYC form saved");
        } else {
            console.log("Offline KYC button is disabled, using Close button instead");
        }
    } catch (error) {
        console.log("Offline KYC button not found or not clickable:", error.message);
    }
    
    // Click Close button to close the CKYC window
    try {
        const closeButton = await driver.wait(
            until.elementLocated(By.xpath("//button[@name='param' and @value='Close']")),
            10000
        );
        await closeButton.click();
        console.log("Close button clicked successfully");
    } catch (error) {
        console.log("Close button not found, trying alternative close method");
        // Fallback: use JavaScript to close the window
        await driver.executeScript("window.close();");
    }
 
    // Switch back to original window
    await driver.switchTo().window(originalWindow);
    console.log("Returned to original window");
 
} catch (error) {
    console.log("Error handling CKYC window:", error.message);
    
    // Handle any remaining alerts
    try {
        await driver.wait(until.alertIsPresent(), 3000);
        let alert = await driver.switchTo().alert();
        console.log("Remaining alert text:", await alert.getText());
        await alert.accept();
        console.log("Remaining alert accepted");
    } catch (alertErr) {
        console.log("No remaining alerts:", alertErr.message);
    }
    
    // Ensure we're back to the original window
    const windows = await driver.getAllWindowHandles();
    if (windows.length > 1) {
        // Close any extra windows
        for (let i = 1; i < windows.length; i++) {
            await driver.switchTo().window(windows[i]);
            await driver.close();
        }
        // Switch back to original window
        await driver.switchTo().window(windows[0]);
    }
}
 
console.log("Clicking Collect Premium button...");
try {
    const collectBtn = await driver.wait(until.elementLocated(By.id("collct")), 15000);
    await driver.executeScript("arguments[0].scrollIntoView(true);", collectBtn);
    await driver.sleep(500);
    try {
        await collectBtn.click();
    } catch {
        // Fallback to JavaScript click if normal click fails
        await driver.executeScript("arguments[0].click();", collectBtn);
    }
    console.log("Collect Premium button clicked successfully");
} catch (err) {
    console.log("Failed to click Collect Premium button:", err.message);
}
 
// Wait a moment for the page to update after CKYC
await driver.sleep(3000);
 
console.log("Clicking Collect Premium button...");
try {
    const collectBtn = await driver.wait(until.elementLocated(By.id("collct")), 15000);
    await driver.executeScript("arguments[0].scrollIntoView(true);", collectBtn);
    await driver.sleep(500);
    try {
        await collectBtn.click();
    } catch {
        // Fallback to JavaScript click if normal click fails
        await driver.executeScript("arguments[0].click();", collectBtn);
    }
    console.log("Collect Premium button clicked successfully");
} catch (err) {
    console.log("Failed to click Collect Premium button:", err.message);
}
    } catch (err) {
        console.error("Error:", err);
        try {
            const screenshot = await driver.takeScreenshot();
            fs.writeFileSync('error_screenshot.png', screenshot, 'base64');
            console.log("Screenshot saved as error_screenshot.png");
        } catch (screenshotError) {
            console.error("Could not take screenshot:", screenshotError);
        }
    } finally {
        // await driver.quit();
    }
})();
 
 