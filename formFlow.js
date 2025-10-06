const { By, until } = require("selenium-webdriver");
const { ensureLoggedIn } = require("./browser");

async function safeClick(driver, locator, timeout = 15000) {
    const element = await driver.wait(until.elementLocated(locator), timeout);
    await driver.wait(until.elementIsVisible(element), timeout);
    await driver.wait(until.elementIsEnabled(element), timeout);
    try { await element.click(); } catch { await driver.executeScript("arguments[0].click();", element); }
    return element;
}

async function safeSendKeys(driver, locator, keys, timeout = 15000) {
    const element = await driver.wait(until.elementLocated(locator), timeout);
    await driver.wait(until.elementIsVisible(element), timeout);
    await driver.wait(until.elementIsEnabled(element), timeout);
    await element.clear();
    await element.sendKeys(keys);
    return element;
}

async function safeSelectOption(driver, selectLocator, optionValue, timeout = 15000) {
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
    return selectElement;
}

async function runFormFlow(driver, amount, tabHandle) {
    // Pin execution to the tab that created this job
    if (tabHandle) {
        try { await driver.switchTo().window(tabHandle); } catch {}
    }
    console.log(`[formFlow] Starting form flow for amount: ${amount}`);
    
    // Ensure session is valid and we're on HomeAction in this tab
    await driver.manage().setTimeouts({ implicit: 20000, pageLoad: 40000, script: 30000 });
    
    try {
        let currentUrl = await driver.getCurrentUrl();
        console.log(`[formFlow] Current URL: ${currentUrl}`);
        if (currentUrl.includes("LoginAction.do") || currentUrl.includes("/login/")) {
            console.log(`[formFlow] Detected login page, ensuring logged in...`);
            await ensureLoggedIn(driver, 15000);
        }
    } catch (e) {
        console.warn(`[formFlow] Error checking current URL:`, e.message);
    }

    console.log(`[formFlow] Looking for Policy Transaction menu...`);
    await safeClick(driver, By.xpath("//a[contains(@class, 'menuColor') and contains(., 'Policy Transaction')]"), 20000);
    console.log(`[formFlow] Clicked Policy Transaction menu`);
    
    await driver.sleep(1500);
    console.log(`[formFlow] Looking for Make New/Renew Policy link...`);
    await safeClick(driver, By.xpath("//a[contains(@href, 'MenuAction.do?method=strbtn') and contains(., 'Make New/Renew Policy')]"), 20000);
    console.log(`[formFlow] Clicked Make New/Renew Policy link`);

    await driver.sleep(3000);
    console.log(`[formFlow] Looking for selectProduct dropdown...`);
    try { 
        await safeClick(driver, By.id("selectProduct"), 8000);
        console.log(`[formFlow] Clicked selectProduct dropdown`);
    } catch (e) {
        console.warn(`[formFlow] Could not click selectProduct dropdown:`, e.message);
    }
    await driver.sleep(3000);

    await safeSelectOption(driver, By.id("v_make"), "3");
    await driver.sleep(1000);
    await safeSelectOption(driver, By.id("regst"), "43");
    await safeSelectOption(driver, By.id("business"), "New");

    try {
        const newVehicleCheckbox = await driver.findElement(By.id("newvehchk1"));
        const disabled = await newVehicleCheckbox.getAttribute("disabled");
        const checked = await newVehicleCheckbox.isSelected();
        if (!disabled && !checked) { await newVehicleCheckbox.click(); }
    } catch {}

    await safeSendKeys(driver, By.id("chasisNumber"), "MD626DG56S2H08322");
    await safeSendKeys(driver, By.id("engineNumber"), "FG5HS2808545");

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

    const purchaseDateInput = await driver.wait(until.elementLocated(By.id("dtPurchaseStr")), 10000);
    await driver.executeScript("arguments[0].scrollIntoView(true);", purchaseDateInput);
    await driver.sleep(200);
    await purchaseDateInput.clear();
    await purchaseDateInput.sendKeys("16/09/2025");

    const procureDateInput = await driver.wait(until.elementLocated(By.id("dateOfProcurebyPresentOwner")), 10000);
    await driver.executeScript("arguments[0].scrollIntoView(true);", procureDateInput);
    await driver.sleep(200);
    await procureDateInput.clear();
    await procureDateInput.sendKeys("16/09/2025");

    await driver.executeScript(`
        var bodyTypeSelect = document.getElementById('bodyType');
        if (bodyTypeSelect && bodyTypeSelect.options.length > 1) {
            bodyTypeSelect.selectedIndex = 1;
            var event = new Event('change', { bubbles: true });
            bodyTypeSelect.dispatchEvent(event);
        }
    `);

    await safeSelectOption(driver, By.name("ynPuc"), "Yes");
    await safeSelectOption(driver, By.name("ynDncr"), "No");

    await driver.executeScript(`
        var noRadio = document.querySelector('input[name="customerIdShowHide"][value="N"]');
        if (noRadio) { noRadio.click(); noRadio.dispatchEvent(new Event('change', { bubbles: true })); }
    `);

    await safeSelectOption(driver, By.id("clientType"), "1");
    await safeSelectOption(driver, By.id("insuredname1"), "MR.");
    await safeSendKeys(driver, By.id("insuredname2"), "John Doe");
    await safeSendKeys(driver, By.id("addressOfInsured"), "123 Main Street, Chennai");
    await safeSendKeys(driver, By.id("PIN_CODE"), "600001");
    await safeSendKeys(driver, By.id("emailAddress"), "johndoe@example.com");
    await safeSendKeys(driver, By.id("mobile"), "9876543210");

    await driver.executeScript(`
        var dobField = document.getElementById('dateOfBirthString');
        if (dobField) { dobField.value = '01/01/1980'; dobField.dispatchEvent(new Event('change', { bubbles: true })); }
    `);
    await safeSelectOption(driver, By.id("OCCUPATION_CODE"), "1");

    // Region and amount
    await driver.executeScript(`
        var select = document.getElementById('rtaDesc');
        if (select) { select.value = 'TN99 COIMBATORE WEST@4540'; select.dispatchEvent(new Event('change', { bubbles: true })); }
    `);

    await safeSendKeys(driver, By.id("invoicevalue"), amount || "70000");
    await safeSelectOption(driver, By.id("lonTermCoverType1"), "1");

    await driver.executeScript(`
        var moreCoversBtn = document.querySelector('img[src*="MoreCoversNInfo.JPG"]');
        if (moreCoversBtn) { moreCoversBtn.click(); }
    `);

    await driver.sleep(1500);
    try {
        const paCoverCheckbox = await driver.findElement(By.id("ynPAcover"));
        const isChecked = await paCoverCheckbox.isSelected();
        if (isChecked) await driver.executeScript("arguments[0].click();", paCoverCheckbox);
    } catch {}

    try { await safeSelectOption(driver, By.name("ynOwnerDrivCpaOpt"), "No"); } catch {}

    // Compute Premium
    try {
        const computeBtn = await driver.wait(until.elementLocated(By.id("compute")), 20000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", computeBtn);
        await driver.sleep(200);
        try { await computeBtn.click(); } catch { await driver.executeScript("arguments[0].click();", computeBtn); }
    } catch {}

    // Handle possible alerts
    try { await driver.wait(until.alertIsPresent(), 5000); const alert = await driver.switchTo().alert(); await alert.accept(); } catch {}

    // Update and Collect steps (best-effort)
    console.log(`[formFlow] Attempting final steps (Update and Collect)...`);
    try { 
        const up = await driver.wait(until.elementLocated(By.id("updt")), 8000); 
        await driver.executeScript("arguments[0].click();", up);
        console.log(`[formFlow] Clicked Update button`);
    } catch (e) {
        console.warn(`[formFlow] Could not click Update button:`, e.message);
    }
    
    try { 
        await driver.wait(until.alertIsPresent(), 3000); 
        const a = await driver.switchTo().alert(); 
        await a.accept();
        console.log(`[formFlow] Accepted alert`);
    } catch (e) {
        console.warn(`[formFlow] No alert to accept:`, e.message);
    }
    
    try { 
        const collect = await driver.wait(until.elementLocated(By.id("collct")), 8000); 
        await driver.executeScript("arguments[0].click();", collect);
        console.log(`[formFlow] Clicked Collect button`);
    } catch (e) {
        console.warn(`[formFlow] Could not click Collect button:`, e.message);
    }
    
    console.log(`[formFlow] Form flow completed for amount: ${amount}`);
}

module.exports = { runFormFlow };


