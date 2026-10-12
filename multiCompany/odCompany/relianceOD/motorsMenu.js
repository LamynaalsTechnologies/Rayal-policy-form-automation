/**
 * Reliance OD, step 1 after the login: open Motors -> Two Wheeler.
 *
 * COPIED WORD FOR WORD from fullPolicycompany/relianceForm.js ("STEP 2" and "STEP 3": find the Motors menu, hover
 * it, wait for the Two Wheeler link to be really visible, click it, up to 4 attempts). The only difference: when it
 * never becomes clickable the error is a MultiCompanyError("E302", retryable) instead of a plain Error, same words.
 * Nothing after the click is here: choosing the product in the dropdown is the next step, not built yet.
 * This copy is the Reliance OD handler's own; change it freely, it is not tied to the full-company flow by a test.
 */
const { By, until } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");

/** Runs on the logged-in dashboard; leaves the browser on the Two Wheeler page. */
async function openTwoWheeler(driver) {
  // === STEP 2: wait for Motors menu ===
  const motorsMenu = await driver.wait(
    until.elementLocated(By.id("divMainMotors")),
    30000
  );
  console.log("Motors menu detected!");

  // === STEP 3: hover Motors and click Two Wheeler ===
  // Retried with a real visibility wait — on a slow portal the submenu can
  // take longer than any fixed sleep, and clicking a collapsed menu item
  // throws "element not interactable: has no size and location"
  let twoWheelerClicked = false;
  for (let menuAttempt = 1; menuAttempt <= 4 && !twoWheelerClicked; menuAttempt++) {
    try {
      console.log(`Hovering on Motors menu (attempt ${menuAttempt}/4)...`);
      await driver
        .actions({ bridge: true })
        .move({ origin: motorsMenu })
        .perform();

      const twoWheelerLink = await driver.wait(
        until.elementLocated(By.xpath("//li/a[contains(text(),'Two Wheeler')]")),
        10000
      );

      // Wait until the submenu is actually expanded (link visible WITH size)
      await driver.wait(
        async () => {
          try {
            const rect = await twoWheelerLink.getRect();
            return (
              (await twoWheelerLink.isDisplayed()) &&
              rect.width > 0 &&
              rect.height > 0
            );
          } catch (e) {
            return false;
          }
        },
        8000,
        "Two Wheeler submenu did not become visible"
      );

      try {
        await driver
          .actions({ bridge: true })
          .move({ origin: twoWheelerLink })
          .perform();
        await twoWheelerLink.click();
      } catch (clickErr) {
        await driver.executeScript("arguments[0].click();", twoWheelerLink);
      }
      twoWheelerClicked = true;
      console.log(`Clicked Two Wheeler link! (attempt ${menuAttempt})`);
    } catch (menuErr) {
      console.log(
        `⚠️ Motors submenu not ready (attempt ${menuAttempt}/4): ${menuErr.message}`
      );
      await driver.sleep(2500);
    }
  }

  if (!twoWheelerClicked) {
    throw new MultiCompanyError(
      "E302",
      "Motors → Two Wheeler menu never became clickable after 4 attempts (portal slow/unresponsive)",
      { stage: "motors-two-wheeler", company: "reliance" }
    );
  }
  // The next step waits for the product dropdown itself (15s) — no long sleep needed
  await driver.sleep(1000);
}

module.exports = { openTwoWheeler };
