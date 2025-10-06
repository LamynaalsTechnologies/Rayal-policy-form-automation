const { By, until } = require('selenium-webdriver');
const { createFreshDriverFromBaseProfile } = require('./browser');
const fs = require('fs');
const path = require('path');

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

    // === STEP 1: wait for manual login ===
    console.log("Waiting 20s for manual login...");
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

    // Hover on Motors menu to open submenu
    await driver.actions({ bridge: true }).move({ origin: motorsMenu }).perform();
    await driver.sleep(1000); // allow submenu to render
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

    // === STEP 4: select "Two Wheeler Package Bundled (Only New Veh.)" ===
    console.log("Selecting Sub Product...");

    // Wait for dropdown to be ready
    const productDropdown = await driver.wait(
      until.elementLocated(By.id("ddlMotorProducts")),
      15000
    );
    await driver.executeScript("arguments[0].scrollIntoView(true);", productDropdown);
    await driver.sleep(500);

    // Use Kendo JS API to select by value (2375)
    await driver.executeScript(`
      var dropdown = $("#ddlMotorProducts").data("kendoDropDownList");
      dropdown.value("2375"); // Two Wheeler Package Bundled (Only New Veh.)
      dropdown.trigger("change");
    `);
    console.log("Selected: Two Wheeler Package Bundled (Only New Veh.) via Kendo API");
await driver.sleep(2000);

console.log("Handling Skip page and checkbox...");

// === STEP 5: Click "Skip To Main Page" link if present ===
try {
  const skipLink = await driver.wait(
    until.elementLocated(By.xpath("//a[contains(text(),'Skip To Main Page')]")),
    5000
  );
  await driver.executeScript("arguments[0].click();", skipLink);
  console.log("Clicked 'Skip To Main Page'");
  await driver.sleep(2000); // wait 2 sec
} catch (err) {
  console.log("No skip link detected, continuing...");
}

// === STEP 6: Click "ISPANNotAvailable" checkbox ===
try {
  const ispCheckbox = await driver.wait(
    until.elementLocated(By.id("ISPANNotAvailable")),
    5000
  );
  await driver.executeScript("arguments[0].click();", ispCheckbox);
  console.log("Checked ISPANNotAvailable checkbox");

  // === Wait for the iframe to appear inside modal ===
  const iframeEl = await driver.wait(
    until.elementLocated(By.css("#ClientForm60DetailsWindow iframe")),
    10000
  );
  console.log("Modal iframe detected!");

  // Switch to iframe context
  await driver.switchTo().frame(iframeEl);
  console.log("Switched to modal iframe");

  // === Now fill the form inside iframe ===
  const proposerTitle1 = await driver.wait(
    until.elementLocated(By.id("proposerTitle1")),
    10000
  );
  await proposerTitle1.sendKeys(data.proposerTitle || "Mr.");

  await driver.findElement(By.id("FirstName")).sendKeys(data.firstName || "John");
  await driver.findElement(By.id("MiddleName")).sendKeys(data.middleName || "M");
  await driver.findElement(By.id("LastName")).sendKeys(data.lastName || "Doe");
  await driver.findElement(By.id("dob")).sendKeys(data.dob || "01/01/1990");
  await driver.findElement(By.id("proposerTitle2")).sendKeys(data.fatherTitle || "Mr.");
  await driver.findElement(By.name("FatherFirstName")).sendKeys(data.fatherFirstName || "Robert");
   await driver.findElement(By.id("flat")).sendKeys(data.flatNo || "101");
  await driver.findElement(By.id("floor")).sendKeys(data.floorNo || "1");
  await driver.findElement(By.id("Nameofpremises")).sendKeys(data.premisesName || "Sunshine Apartments");
  await driver.findElement(By.id("block")).sendKeys(data.blockNo || "A");
  await driver.findElement(By.id("road")).sendKeys(data.road || "MG Road");
  await driver.findElement(By.id("state")).sendKeys(data.state || "KARNATAKA");
  await driver.findElement(By.id("district")).sendKeys(data.district || "Bangalore");
  await driver.findElement(By.id("town")).sendKeys(data.town || "Bangalore");
  await driver.findElement(By.id("pincode")).sendKeys(data.pinCode || "560001");
  await driver.findElement(By.id("area")).sendKeys(data.area || "MG Road");

  await driver.findElement(By.id("mobileno")).sendKeys(data.mobile || "9876543210");
  await driver.findElement(By.id("aadhar")).sendKeys(data.aadhar || "123412341234");

  // ... fill other fields ...

  console.log("Mandatory fields inside modal iframe filled successfully!");

  // === Switch back to main content ===
  await driver.switchTo().defaultContent();

} catch (err) {
  console.log("Error filling modal fields:", err.message);
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

module.exports = { fillRelianceForm };
