// MANUAL CHECK (not part of `npm test`). Needs Google Chrome.   node test/manual/odReplica/tpDetailsBox.js [openDelayMs] [cover]
// The REAL answerTpDetailsDialog against tpDetails.html, a replica of the "TP Details" box built from the markup the owner pasted
// (ids, name="Yes" / name="No", the onclick handler names). Passing "cover" as the 2nd argument puts a transparent overlay over the
// box so the browser refuses the native click and the script-click fallback is used.
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", ".."); // the automation project
const { Builder, By } = require(path.join(ROOT, "node_modules/selenium-webdriver"));
const chrome = require(path.join(ROOT, "node_modules/selenium-webdriver/chrome"));
const steps = require(path.join(ROOT, "multiCompany/common/reliance/relianceOdSteps"));

(async () => {
  const delay = process.argv[2] || "1200";
  const opts = new chrome.Options().addArguments("--headless=new", "--no-sandbox", "--disable-gpu", "--window-size=1200,800");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();
  const lines = [];
  try {
    await driver.get("file://" + path.join(__dirname, "tpDetails.html") + "?delay=" + delay + (process.argv[3] ? "&cover=1" : ""));
    await (await driver.findElement(By.id("skip"))).click();      // Skip To Main Page
    const t0 = Date.now();
    await steps.answerTpDetailsDialog(driver, { log: (l) => { lines.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${l}`); }, waitLoader: async () => {} });
    const events = await driver.executeScript("return window.__events");
    const proceedCount = await driver.executeScript("return window.__proceedCount");
    const boxShown = await driver.executeScript("return getComputedStyle(document.getElementById('divTPDetails')).display");
    console.log(lines.join("\n"));
    console.log("page events :", JSON.stringify(events));
    console.log("Proceed presses on the page:", proceedCount, "| box display after:", boxShown);
    const ok = JSON.stringify(events) === JSON.stringify(["skip clicked", "box open", "Yes", "RGICL No", "Proceed", "box closed"]) && proceedCount === 1 && boxShown === "none";
    console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    console.log(lines.join("\n")); console.log("RESULT: ERROR -", e.message); process.exitCode = 2;
  } finally { await driver.quit(); }
})();
