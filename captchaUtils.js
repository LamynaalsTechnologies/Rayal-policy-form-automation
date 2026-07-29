/**
 * Captcha Utilities - Screenshot and extraction
 */

const { By } = require("selenium-webdriver");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("./Captcha");

/**
 * Take screenshot of captcha image element.
 * Uses ONE absolute path (__dirname) — the old version wrote cwd-relative but
 * read back from __dirname, which only worked when the two happened to match.
 */
async function getCaptchaScreenShot(driver, filename = "image_screenshot") {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));
  const imageBase64 = await imgElement.takeScreenshot(true);
  const filePath = path.join(__dirname, `${filename}.png`);
  fs.writeFileSync(filePath, imageBase64, "base64");
  console.log(`Screenshot saved as ${filePath}`);
  return filePath;
}

/**
 * Get captcha text from screenshot.
 *
 * IMPORTANT for parallel jobs: pass a UNIQUE filename per job (the callers use
 * reliance_captcha_<jobId>). With the old shared "reliance_captcha" name, two
 * jobs logging in at once overwrote each other's screenshot and each solved
 * the OTHER job's captcha. The file is deleted after use so nothing
 * accumulates in the repo root.
 */
async function getCaptchaText(driver, filename = "reliance_captcha") {
  const filePath = await getCaptchaScreenShot(driver, filename);
  try {
    const fileData = fs.readFileSync(filePath, "base64");
    const imageUrl = `data:image/jpeg;base64,${fileData}`;
    const captchaResult = await extractCaptchaText(imageUrl);
    console.log("Captcha text:", captchaResult);
    return captchaResult?.text?.replace(/\s+/g, "") || "";
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (e) { /* already gone — fine */ }
  }
}

module.exports = {
  getCaptchaScreenShot,
  getCaptchaText,
};
