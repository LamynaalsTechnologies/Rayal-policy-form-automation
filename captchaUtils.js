/**
 * Captcha Utilities - Screenshot and extraction
 */

const { By } = require("selenium-webdriver");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("./Captcha");

/**
 * Take screenshot of captcha image element
 */
async function getCaptchaScreenShot(driver, filename = "image_screenshot") {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));
  const imageBase64 = await imgElement.takeScreenshot(true);
  fs.writeFileSync(`${filename}.png`, imageBase64, "base64");
  console.log(`Screenshot saved as ${filename}.png`);
}

/**
 * Get captcha text from screenshot
 */
async function getCaptchaText(driver, filename = "reliance_captcha") {
  await getCaptchaScreenShot(driver, filename);
  const filePath = path.join(__dirname, `${filename}.png`);
  const fileData = fs.readFileSync(filePath, "base64");
  const imageUrl = `data:image/jpeg;base64,${fileData}`;
  const captchaResult = await extractCaptchaText(imageUrl);
  console.log("Captcha text:", captchaResult);
  return captchaResult?.text?.replace(/\s+/g, "") || "";
}

module.exports = {
  getCaptchaScreenShot,
  getCaptchaText,
};
