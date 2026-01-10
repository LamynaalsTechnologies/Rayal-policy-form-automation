const { By, until, Key } = require("selenium-webdriver");
const { createFreshDriverFromBaseProfile } = require("./browser");
const {
  createJobBrowser,
  cleanupJobBrowser,
  reLoginIfNeeded,
  recoveryManager,
} = require("./sessionManager");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const http = require("http");
const AWS = require("aws-sdk");
const { extractCaptchaText } = require("./Captcha");
const { uploadScreenshotToS3, generateScreenshotKey } = require("./s3Uploader");

// Configure AWS S3 for presigned URL generation (fallback)
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_S3_ACCESSKEY_ID,
  secretAccessKey: process.env.AWS_S3_SECRET_ACCESSKEY,
  region: "ap-south-1"
});

// Helper function to generate presigned URL for S3 downloads
const getPresignedUrl = async (key) => {
  if (!key) return null;
  try {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Expires: 3600 // URL valid for 1 hour
    };
    const url = await s3.getSignedUrlPromise('getObject', params);
    console.log(`✅ Generated presigned URL for: ${key}`);
    return url;
  } catch (err) {
    console.error(`❌ Error generating presigned URL for ${key}:`, err.message);
    return null;
  }
};

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
  } catch { }
}

/**
 * Centralized error screenshot handler
 * Captures screenshot and uploads to S3 for any error
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {Error} error - The error object
 * @param {Object} data - Job data containing identifiers
 * @param {string} errorStage - Stage where error occurred (e.g., "modal-filling", "vehicle-details")
 * @returns {Promise<Object>} - Returns error details with screenshot URL
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
    const jobIdentifier = data._jobIdentifier || `job_${Date.now()}`;
    const attemptNumber = data._attemptNumber || 1;

    // Generate S3 key and upload screenshot
    screenshotKey = generateScreenshotKey(
      jobIdentifier,
      attemptNumber,
      errorStage
    );
    screenshotUrl = await uploadScreenshotToS3(screenshot, screenshotKey);

    console.log(`📸 Error screenshot uploaded to S3: ${screenshotUrl}`);

    // Also capture page source for debugging (optional)
    try {
      const pageSource = await driver.getPageSource();
      pageSourceKey = screenshotKey.replace(".png", ".html");
      const tempHtmlPath = path.join(
        __dirname,
        `temp-page-source-${Date.now()}.html`
      );
      fs.writeFileSync(tempHtmlPath, pageSource);

      const { uploadToS3 } = require("./s3Uploader");
      pageSourceUrl = await uploadToS3(tempHtmlPath, pageSourceKey);

      fs.unlinkSync(tempHtmlPath); // Delete temp file
      console.log(`📄 Page source uploaded to S3: ${pageSourceUrl}`);
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

      console.log(`✅ Error logged to job queue (stage: ${errorStage})`);
    }
  } catch (captureErr) {
    console.error(
      `❌ Failed to capture/upload error screenshot:`,
      captureErr.message
    );
  }

  return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
}

/**
 * Login on cloned browser when session is expired
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} jobId - Job identifier for logging
 * @param {Object} credentials - { username, password }
 * @returns {Promise<boolean>} - true if login successful
 */
async function loginOnClonedBrowser(driver, jobId, credentials) {
  try {
    console.log(`🔐 [${jobId}] Attempting login on cloned browser...`);

    // Capture captcha
    console.log(`📸 [${jobId}] Capturing captcha...`);
    await getCaptchaScreenShot(driver, `reliance_captcha_${jobId}`);
    const filePath = path.join(__dirname, `reliance_captcha_${jobId}.png`);

    if (!fs.existsSync(filePath)) {
      console.error(`❌ [${jobId}] Captcha screenshot not found`);
      return false;
    }

    const fileData = fs.readFileSync(filePath, "base64");
    const imageUrl = `data:image/jpeg;base64,${fileData}`;
    const captchaResult = await extractCaptchaText(imageUrl);
    const captchaText = captchaResult?.text?.replace(/\s+/g, "");

    // Clean up captcha file
    try {
      fs.unlinkSync(filePath);
    } catch (e) { }

    if (!captchaText) {
      console.error(`❌ [${jobId}] Failed to extract captcha text`);
      return false;
    }

    console.log(`🔑 [${jobId}] Captcha extracted: ${captchaText}`);

    // Fill login form
    console.log(`📝 [${jobId}] Filling login credentials...`);
    await driver.findElement(By.id("txtUserName")).clear();
    await driver
      .findElement(By.id("txtUserName"))
      .sendKeys(credentials.username);
    await driver.sleep(500);

    await driver.findElement(By.id("txtPassword")).clear();
    await driver
      .findElement(By.id("txtPassword"))
      .sendKeys(credentials.password);
    await driver.sleep(500);

    await driver.findElement(By.id("CaptchaInputText")).clear();
    await driver.findElement(By.id("CaptchaInputText")).sendKeys(captchaText);
    await driver.sleep(1000);

    // Click login button
    console.log(`🚀 [${jobId}] Clicking login button...`);
    await driver.findElement(By.id("btnLogin")).click();

    // Wait for login to complete
    console.log(`⏳ [${jobId}] Waiting for login to complete...`);
    await driver.sleep(5000);

    // Verify login successful by checking for dashboard elements
    const motorsElements = await driver.findElements(By.id("divMainMotors"));
    const logoutElements = await driver.findElements(By.id("divLogout"));

    if (motorsElements.length > 0 || logoutElements.length > 0) {
      console.log(`✅ [${jobId}] Login successful on cloned browser!`);
      return true;
    } else {
      console.error(
        `❌ [${jobId}] Login verification failed - dashboard elements not found`
      );
      return false;
    }
  } catch (error) {
    console.error(
      `❌ [${jobId}] Error during cloned browser login:`,
      error.message
    );
    return false;
  }
}

/**
 * Detect if cloned session is expired and login if needed
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} jobId - Job identifier for logging
 * @param {Object} credentials - { username, password }
 * @returns {Promise<boolean>} - true if session is valid, false if unrecoverable
 */
async function checkAndRecoverClonedSession(driver, jobId, credentials) {
  try {
    console.log(`\n🔍 [${jobId}] Verifying cloned session status...`);

    // Check 1: Are we on the login page? (txtUserName field exists)
    const loginElements = await driver.findElements(By.id("txtUserName"));

    if (loginElements.length > 0) {
      console.error(`\n⚠️  [${jobId}] CLONED SESSION EXPIRED - On login page!`);
      console.log(
        `🔐 [${jobId}] Will attempt to login on this cloned browser...\n`
      );

      // Try to login directly on this cloned browser (max 3 attempts)
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(
          `🔄 [${jobId}] Login attempt ${attempt}/3 on cloned browser...`
        );

        const loginSuccess = await loginOnClonedBrowser(
          driver,
          jobId,
          credentials
        );

        if (loginSuccess) {
          console.log(
            `✅ [${jobId}] Successfully logged in on cloned browser!`
          );
          console.log(
            `✅ [${jobId}] Session is now valid, continuing with form filling...\n`
          );
          return true; // Login succeeded, session now valid
        }

        console.warn(`⚠️  [${jobId}] Login attempt ${attempt}/3 failed`);

        if (attempt < 3) {
          console.log(`⏳ [${jobId}] Waiting 3 seconds before retry...`);
          await driver.sleep(3000);

          // Refresh page for new captcha
          await driver.get(
            "https://smartzone.reliancegeneral.co.in/Login/IMDLogin"
          );
          await driver.sleep(2000);
        }
      }

      // All login attempts on clone failed
      console.error(
        `\n❌ [${jobId}] All 3 login attempts failed on cloned browser!`
      );
      console.log(
        `🔄 [${jobId}] Triggering master session recovery as backup...`
      );

      // Check if another job is already recovering the master session
      if (recoveryManager.isRecovering) {
        console.log(`⏳ [${jobId}] Waiting for ongoing master recovery...`);
      }

      // Trigger master session recovery as backup
      const masterRecovered = await reLoginIfNeeded();

      if (masterRecovered) {
        console.log(`✅ [${jobId}] Master session recovered!`);
        console.error(
          `❌ [${jobId}] Will retry job with fresh clone from recovered master\n`
        );
      }

      // Return false to force job retry
      return false;
    }

    // Check 2: Look for dashboard elements (divMainMotors or divLogout)
    const dashboardElements = await driver.findElements(By.id("divMainMotors"));
    const logoutElements = await driver.findElements(By.id("divLogout"));

    if (dashboardElements.length > 0 || logoutElements.length > 0) {
      console.log(
        `✅ [${jobId}] Cloned session is ACTIVE - Dashboard detected\n`
      );
      return true;
    }

    // Check 3: Check current URL
    const currentUrl = await driver.getCurrentUrl();
    if (currentUrl.includes("/Login/IMDLogin") && !currentUrl.includes("?")) {
      console.error(
        `\n⚠️  [${jobId}] CLONED SESSION EXPIRED - Login URL detected!`
      );

      // Check if recovery already in progress
      if (recoveryManager.isRecovering) {
        console.log(
          `⏳ [${jobId}] Waiting for ongoing master session recovery...`
        );
      } else {
        console.log(`🔄 [${jobId}] Triggering master session recovery...`);
      }

      const masterRecovered = await reLoginIfNeeded();

      if (masterRecovered) {
        console.log(`✅ [${jobId}] Master session recovered!`);
        console.error(`❌ [${jobId}] Current cloned session is STALE\n`);
      }

      return false;
    }

    // Uncertain state - wait and recheck
    console.log(
      `⏳ [${jobId}] Uncertain state, waiting 3s for page to load...`
    );
    await driver.sleep(3000);

    const finalCheck = await driver.findElements(By.id("divMainMotors"));
    if (finalCheck.length > 0) {
      console.log(
        `✅ [${jobId}] Cloned session is ACTIVE - Dashboard found after wait\n`
      );
      return true;
    }

    console.error(
      `\n⚠️  [${jobId}] CLONED SESSION likely EXPIRED - No dashboard elements\n`
    );

    // Trigger recovery as a precaution (will wait if already in progress)
    if (!recoveryManager.isRecovering) {
      console.log(
        `🔄 [${jobId}] Triggering master session recovery as precaution...`
      );
    } else {
      console.log(`⏳ [${jobId}] Waiting for ongoing recovery...`);
    }

    await reLoginIfNeeded();

    return false;
  } catch (error) {
    console.error(
      `❌ [${jobId}] Error checking cloned session:`,
      error.message
    );

    // On error, trigger recovery as a precaution (will wait if already in progress)
    try {
      if (!recoveryManager.isRecovering) {
        console.log(`🔄 [${jobId}] Triggering recovery due to check error...`);
      } else {
        console.log(`⏳ [${jobId}] Waiting for ongoing recovery...`);
      }

      await reLoginIfNeeded();
    } catch (recoveryError) {
      console.error(
        `❌ [${jobId}] Recovery also failed:`,
        recoveryError.message
      );
    }

    return false;
  }
}

/**
 * Create Brisk Certificate by calling the API
 * @param {Object} data - Form data containing customer and vehicle information
 * @returns {Promise<Object>} - API response
 */
async function createBriskCertificate(data) {
  return new Promise((resolve, reject) => {
    // Helper function to format date from MongoDB date object or ISO string
    const formatDate = (dateValue, fallback = "01-01-2000") => {
      if (!dateValue) return fallback;
      try {
        let date;
        if (dateValue.$date) {
          date = new Date(dateValue.$date);
        } else if (typeof dateValue === 'string') {
          date = new Date(dateValue);
        } else if (dateValue instanceof Date) {
          date = dateValue;
        } else {
          return fallback;
        }

        // Check if date is valid
        if (isNaN(date.getTime())) {
          console.warn("Invalid date detected, using fallback:", fallback);
          return fallback;
        }

        // Format as MM-DD-YYYY
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        return `${month}-${day}-${year}`;
      } catch (e) {
        console.error("Error formatting date:", e.message);
        return fallback;
      }
    };

    // Prepare the payload
    const payload = {
      CustomerName: data.customerName || `${data.fullName || data.firstName || "TESTING"} ${data.surname || data.lastName || ""}`.trim(),
      MobileNo: data.mobileNumber || data.mobile || data.mobileNo || "6789054367",
      EmailID: data.email || data.emailID || "test@gmail.com",
      City: data.city || "CHENNAI",
      State: getStateName(data.state) || "TAMIL NADU",
      CustomerGender: "Male",
      NomineeName: data.nomineeName || "FERNANDO",
      NomineeGender: "Male",
      Relation: data.nomineeRelation || data.relation || "Brother",
      Make: data.vehicleMake || data.make || "DACUS",
      Model: data.vehicleModel || data.model || "GOLD PLUS",
      EngineNo: data.engineNumber || data.engineNo || "674r56732",
      ChassisNo: data.chassisNumber || data.chassisNo || "567r74w",
      RegistrationNo: data.registrationNo || data.registrationNumber || "tyu66456",
      PaymentMode: data.paymentMode || "FromWallet",
      Address_Line1: data.addressLine1 || data.address_Line1 || `${data.flatDoorNo || data.flatNo || "TEST"} ${data.buildingName || data.premisesName || "ADDR 1"}`.trim(),
      Address_Line2: data.addressLine2 || data.address_Line2 || `${data.roadStreetLane || data.road || "TEST"} ${data.areaAndLocality || data.area || "ADDR 2"}`.trim(),
      PlanName: data.planName || "TWHRN30K3S244",
      CustomerDOB: data.dob || data.customerDOB || formatDate(data.dateOfBirth, "01-01-2000"),
      loginid: data.loginid || "masterwallet@gmail.com",
      VehicleType: data.vehicleType || "TW",
      Gstno: data.gstno || data.Gstno || "",
      Flaxprice: String(data.paCoverAmount || data.flaxprice || data.Flaxprice || "244"),
      policyType: data.policyType || "cpa/rsa"
    };

    console.log("📤 Sending Brisk Certificate request with payload:", JSON.stringify(payload, null, 2));

    const postData = JSON.stringify(payload);

    // Extract userId from data (handle both string and MongoDB ObjectId format)
    const userId = data.userId?.$oid || data.userId || '65a343220a6016a8f93424e7';

    const options = {
      hostname: '192.168.1.7',
      port: 8080,
      path: '/api/createBriskCertificate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'clientid': userId,
        'userid': userId
      }
    };

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        console.log(`📥 Brisk API Response Status: ${res.statusCode}`);
        console.log(`📥 Brisk API Response: ${responseData}`);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedResponse = JSON.parse(responseData);

            // Check if API returned an error
            if (parsedResponse.error === true) {
              reject(new Error(parsedResponse.message || "API returned an error"));
              return;
            }

            // Extract the important data
            const result = {
              success: true,
              message: parsedResponse.message,
              policyId: parsedResponse.data?.policyId,
              downloadUrl: parsedResponse.data?.downloadUrl,
              fullResponse: parsedResponse
            };

            console.log(`✅ Brisk Certificate created - Policy ID: ${result.policyId}`);
            console.log(`📄 Download URL: ${result.downloadUrl}`);

            resolve(result);
          } catch (e) {
            console.error("❌ Error parsing response:", e.message);
            resolve({ success: true, raw: responseData });
          }
        } else {
          reject(new Error(`API returned status ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error("❌ Error calling Brisk API:", error.message);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Download PDF from Brisk API response URL and save to file
 * @param {string} downloadUrl - URL to download the PDF from
 * @param {string} policyId - Policy ID to use for filename
 * @returns {Promise<string>} - Path to the downloaded file
 */
async function downloadBriskPDF(downloadUrl, policyId) {
  return new Promise((resolve, reject) => {
    if (!downloadUrl) {
      reject(new Error("No download URL provided"));
      return;
    }

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, 'brisk_certificates');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Generate filename
    const filename = `${policyId || 'certificate_' + Date.now()}.pdf`;
    const filepath = path.join(downloadsDir, filename);

    console.log(`📥 Downloading PDF from: ${downloadUrl}`);
    console.log(`💾 Saving to: ${filepath}`);

    // Determine if URL is HTTPS or HTTP
    const protocol = downloadUrl.startsWith('https') ? https : http;

    const file = fs.createWriteStream(filepath);

    protocol.get(downloadUrl, (response) => {
      // Check if response is successful
      if (response.statusCode !== 200) {
        fs.unlinkSync(filepath); // Delete the file
        reject(new Error(`Failed to download PDF. Status: ${response.statusCode}`));
        return;
      }

      // Pipe the response to file
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log(`✅ PDF downloaded successfully: ${filepath}`);
        resolve(filepath);
      });

      file.on('error', (err) => {
        fs.unlinkSync(filepath); // Delete the file on error
        reject(err);
      });
    }).on('error', (err) => {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath); // Delete the file on error
      }
      reject(err);
    });
  });
}

/**
 * Merge Reliance and Brisk PDFs, upload to AWS, and update policy
 * @param {string} reliancePdfPath - Path to Reliance PDF file
 * @param {string} briskPdfPath - Path to Brisk PDF file
 * @param {Object} data - Policy data containing _id and other info
 * @returns {Promise<Object>} - Returns merged PDF info with AWS URL
 */
async function mergePDFsAndUpload(reliancePdfPath, briskPdfPath, data) {
  const FormData = require('form-data');
  const axios = require('axios');

  try {
    console.log('📄 Starting PDF merge process...');
    console.log(`📄 Reliance PDF: ${reliancePdfPath}`);
    console.log(`📄 Brisk PDF: ${briskPdfPath}`);

    // Check if both files exist
    if (!fs.existsSync(reliancePdfPath)) {
      throw new Error(`Reliance PDF not found: ${reliancePdfPath}`);
    }
    if (!fs.existsSync(briskPdfPath)) {
      throw new Error(`Brisk PDF not found: ${briskPdfPath}`);
    }

    // Read both PDFs as buffers
    const reliancePdfBuffer = fs.readFileSync(reliancePdfPath);
    const briskPdfBuffer = fs.readFileSync(briskPdfPath);

    console.log(`✅ Reliance PDF loaded: ${reliancePdfBuffer.length} bytes`);
    console.log(`✅ Brisk PDF loaded: ${briskPdfBuffer.length} bytes`);

    // Create FormData and append both PDFs
    const formData = new FormData();
    formData.append('files', reliancePdfBuffer, {
      filename: 'reliance.pdf',
      contentType: 'application/pdf'
    });
    formData.append('files', briskPdfBuffer, {
      filename: 'brisk.pdf',
      contentType: 'application/pdf'
    });

    // Call merge-pdf API
    console.log('🔄 Calling merge-pdf API...');
    const mergeResponse = await axios.post(
      'http://192.168.1.7:3010/api/merge-pdf',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'clientid': data.userId?.$oid || data.userId || '65a343220a6016a8f93424e7',
          'userid': data.userId?.$oid || data.userId || '65a343220a6016a8f93424e7'
        },
        responseType: 'arraybuffer' // Expect PDF buffer in response
      }
    );

    console.log('✅ PDFs merged successfully');

    // Save merged PDF temporarily
    const mergedPdfPath = path.join(__dirname, 'temp_merged', `merged_${Date.now()}.pdf`);
    const mergedDir = path.dirname(mergedPdfPath);
    if (!fs.existsSync(mergedDir)) {
      fs.mkdirSync(mergedDir, { recursive: true });
    }
    fs.writeFileSync(mergedPdfPath, mergeResponse.data);
    console.log(`💾 Merged PDF saved temporarily: ${mergedPdfPath}`);

    // Upload merged PDF to AWS S3
    console.log('☁️  Uploading merged PDF to AWS S3...');
    const policyId = data.policyId || data._id?.$oid || data._id || `policy_${Date.now()}`;
    const s3Key = `MergedPolicies/${policyId}_merged.pdf`;

    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: s3Key,
      Body: fs.readFileSync(mergedPdfPath),
      ContentType: 'application/pdf',
      ACL: 'private' // or 'public-read' depending on your needs
    };

    const s3UploadResult = await s3.upload(uploadParams).promise();
    console.log(`✅ Merged PDF uploaded to S3: ${s3UploadResult.Location}`);

    // Update online policy schema with merged PDF URL using MongoDB directly
    console.log('📝 Updating online policy schema (Direct MongoDB)...');

    // Debug: Log all available keys in data object
    console.log('🔍 DEBUG: Available keys in data:', Object.keys(data));
    console.log('🔍 DEBUG: data._id:', data._id);
    console.log('🔍 DEBUG: data.policyId:', data.policyId);
    console.log('🔍 DEBUG: typeof data._id:', typeof data._id);

    // Extract policy ID - handle MongoDB ObjectId properly
    let policyIdForUpdate;
    if (data._id) {
      // If _id is already a MongoDB ObjectId, use it directly
      policyIdForUpdate = data._id;
    } else if (data.policyId) {
      policyIdForUpdate = data.policyId;
    }

    console.log('🔍 DEBUG: Updating policy with ID:', policyIdForUpdate);

    if (!policyIdForUpdate) {
      console.error('❌ ERROR: No valid policy ID found in data object!');
      console.error('❌ Cannot update policy without ID. Skipping update...');
      return {
        success: true,
        mergedPdfUrl: s3UploadResult.Location,
        s3Key: s3Key,
        fileName: `${policyId}_merged.pdf`,
        warning: 'Policy not updated - no ID found'
      };
    }

    try {
      const { MongoClient } = require('mongodb');
      const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/rayal';

      console.log('🔌 Connecting to MongoDB...');
      console.log('🔗 MongoDB URL:', mongoUrl.replace(/\/\/([^:]+):([^@]+)@/, '//*****:*****@')); // Hide credentials in log

      const client = new MongoClient(mongoUrl);
      await client.connect();
      console.log('✅ Connected to MongoDB');

      const db = client.db(); // Use database from connection string
      const collection = db.collection('onlinePolicy');

      // Update the policy document
      const result = await collection.updateOne(
        { _id: policyIdForUpdate },
        {
          $set: {
            mergedPolicyPdf: {
              fileName: `${policyId}_merged.pdf`,
              key: s3Key,
              location: s3UploadResult.Location
            },
            updatedAt: new Date()
          }
        }
      );

      await client.close();
      console.log('✅ MongoDB connection closed');

      if (result.matchedCount === 0) {
        console.warn('⚠️  No policy found with the given ID');
      } else if (result.modifiedCount === 0) {
        console.warn('⚠️  Policy found but not modified (maybe already up to date)');
      } else {
        console.log('✅ Online policy updated with merged PDF');
        console.log(`📊 Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);
      }

    } catch (updateError) {
      console.error('⚠️  Failed to update policy via MongoDB:', updateError.message);
      console.error('Stack:', updateError.stack);
    }

    // Clean up temporary merged PDF
    try {
      fs.unlinkSync(mergedPdfPath);
      console.log('🗑️  Temporary merged PDF deleted');
    } catch (cleanupError) {
      console.warn('⚠️  Could not delete temporary file:', cleanupError.message);
    }

    return {
      success: true,
      mergedPdfUrl: s3UploadResult.Location,
      s3Key: s3Key,
      fileName: `${policyId}_merged.pdf`
    };

  } catch (error) {
    console.error('❌ Error in mergePDFsAndUpload:', error.message);
    throw error;
  }
}

/**
 * Helper function to convert state code to state name
 * @param {string} stateCode - State code (e.g., "30")
 * @returns {string} - State name
 */
function getStateName(stateCode) {
  const stateMap = {
    "30": "KARNATAKA",
    "33": "TAMIL NADU",
    "29": "KERALA",
    "32": "TELANGANA",
    "28": "ANDHRA PRADESH",
    "27": "MAHARASHTRA",
    "07": "DELHI",
    "19": "WEST BENGAL",
    "10": "BIHAR",
    "09": "UTTAR PRADESH",
    "24": "GUJARAT",
    "23": "MADHYA PRADESH",
    "22": "CHHATTISGARH",
    "21": "ODISHA",
    "20": "JHARKHAND",
    "18": "ASSAM",
    "06": "HARYANA",
    "03": "PUNJAB",
    "02": "HIMACHAL PRADESH",
    "01": "JAMMU AND KASHMIR",
    "35": "ANDAMAN AND NICOBAR ISLANDS",
    "31": "LAKSHADWEEP",
    "34": "PUDUCHERRY",
    "04": "CHANDIGARH",
    "26": "DADRA AND NAGAR HAVELI AND DAMAN AND DIU",
    "25": "GOA",
    "05": "UTTARAKHAND",
    "36": "LADAKH",
    "11": "SIKKIM",
    "12": "ARUNACHAL PRADESH",
    "13": "NAGALAND",
    "14": "MANIPUR",
    "15": "MIZORAM",
    "16": "TRIPURA",
    "17": "MEGHALAYA",
    "08": "RAJASTHAN"
  };
  return stateMap[stateCode] || "TAMIL NADU";
}

async function fillRelianceForm(
  // data = { username: "TNAGAR2W", password: "Pass@123" }
  data = { username: "rfcpolicy", password: "Pass@123" }
) {
  const jobId = `${data.firstName || "Job"}_${Date.now()}`;
  let jobBrowser = null;
  let driver = null;
  let postSubmissionFailed = false;
  let postSubmissionError = null;
  let postCalculationFailed = false;
  let postCalculationError = null;

  try {
    // === STEP 0: Create cloned browser (already logged in!) ===
    console.log(`\n🚀 [${jobId}] Starting job...`);
    jobBrowser = await createJobBrowser(jobId);
    driver = jobBrowser.driver;

    console.log(`✅ [${jobId}] Browser ready with active session!`);
    console.log(`🌐 [${jobId}] Navigating to form...`);

    // Navigate to the form page (already logged in from cloned profile!)
    await driver.get("https://smartzone.reliancegeneral.co.in/Login/IMDLogin");
    await driver.sleep(3000);

    // === STEP 1: Check if cloned session is expired ===
    // This detects if we cloned an expired session and attempts to login on cloned browser
    const credentials = {
      username: data.username || "rfcpolicy",
      password: data.password || "Pass@123",
    };

    const sessionValid = await checkAndRecoverClonedSession(
      driver,
      jobId,
      credentials
    );

    if (!sessionValid) {
      // Session could not be established on cloned browser
      // All login attempts failed, job will retry
      throw new Error(
        "Cloned session login failed after all attempts. Job will retry."
      );
    }

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

    // ==  vertical code dropdown ===

    try {
      const dropdownInput = await driver.findElement(
        By.id("ddlobjBranchDetailAgentsHnin")
      );

      // Wait until Kendo is initialized
      await driver.wait(async () => {
        return await driver.executeScript(`
          return !!$("#ddlobjBranchDetailAgentsHnin").data("kendoDropDownList");
        `);
      }, 10000);

      // Check current text/value
      const currentValue = await driver.executeScript(`
        var dropdown = $("#ddlobjBranchDetailAgentsHnin").data("kendoDropDownList");
        return dropdown ? dropdown.text() : null;
      `);

      console.log("Current dropdown value:", currentValue);

      if (!currentValue || currentValue.trim() === "Select") {
        await driver.executeScript(`
          var dropdown = $("#ddlobjBranchDetailAgentsHnin").data("kendoDropDownList");
          if (dropdown) {
            dropdown.select(1); // Select first valid option (index 1)
            dropdown.trigger("change");
          }
        `);
        console.log("✅ Selected first option in Kendo dropdown");
      } else {
        console.log("☑️ Dropdown already has a selected value:", currentValue);
      }
    } catch (err) {
      console.error("❌ Could not select Kendo dropdown option:", err.message);
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
      // await safeSendKeys(driver, By.id("MiddleName"), data.middleName || "M");
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
        data.fatherName || "Robert"
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
      await safeSendKeys(driver, By.id("area"), data.areaAndLocality || data.area || data.locality || "MG Road");

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
      await safeSendKeys(
        driver,
        By.id("mobileno"),
        data.mobile || "8838166045"
      );

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
        // // Wait for the Vertical Code dropdown
        // console.log("Waiting for Vertical Code dropdown...");
        // const verticalCodeDropdown = await driver.wait(
        //   until.elementLocated(By.id("ddlobjBranchDetailAgentsHnin")),
        //   15000
        // );
        // console.log("Vertical Code dropdown found!");

        const emailInput = await driver.findElement(By.id("txtEmailID"));
        await emailInput.sendKeys(data?.email);

        // // Click on the dropdown to open it
        // await driver.executeScript(
        //   "arguments[0].click();",
        //   verticalCodeDropdown
        // );
        // await driver.sleep(2000);
        // console.log("Vertical Code dropdown clicked!");

        // Select "GIRNAR FINSERV PRIVATE LIMITED_518898" option
        // console.log("Selecting GIRNAR FINSERV PRIVATE LIMITED_518898...");
        // const girnarOption = await driver.wait(
        //   until.elementLocated(
        //     By.xpath(
        //       "//li[contains(text(), 'GIRNAR FINSERV PRIVATE LIMITED_518898')]"
        //     )
        //   ),
        //   10000
        // );
        // await driver.executeScript("arguments[0].click();", girnarOption);
        // console.log("Selected GIRNAR FINSERV PRIVATE LIMITED_518898!");
        // await driver.sleep(2000);

        // Wait for and click the "Validate Customer" button
        console.log("Looking for Validate Customer button...");
        const validateButton = await driver.wait(
          until.elementLocated(By.id("BtnSaveClientDetails")),
          10000
        );
        await driver.wait(until.elementIsVisible(validateButton), 5000);
        await driver.wait(until.elementIsEnabled(validateButton), 5000);

        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          validateButton
        );
        await driver.sleep(500);

        try {
          await validateButton.click();
        } catch {
          await driver.executeScript("arguments[0].click();", validateButton);
        }
        console.log("Validate Customer button clicked!");

        try {
          const dialog = await driver.wait(
            until.elementLocated(
              By.css(
                'div.ui-dialog[aria-describedby="divCustomerAlreadyExist"]'
              )
            ),
            3000 // wait up to 3 seconds for the popup to appear
          );

          if (await dialog.isDisplayed()) {
            console.log("⚠️ 'Customer Already Exists' dialog detected.");

            // Click the "Cancel" button inside the dialog
            const cancelButton = await dialog.findElement(
              By.xpath(".//button/span[text()='Cancel']")
            );
            await cancelButton.click();
            console.log("🚫 Pop-up closed by clicking 'Cancel'.");
          }
        } catch (e) {
          console.log("No pop-up detected, continuing...");
        }

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
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          vehicleMakeInput
        );
        await driver.sleep(500);

        // Clear the field first
        await vehicleMakeInput.clear();
        await driver.sleep(500);

        // Click on the input to focus it
        await vehicleMakeInput.click();
        await driver.sleep(500);

        // Type the search text and trigger events
        const vehicleSearchText = data.vehicleModel
          ? `${data.vehicleMake} ${data.vehicleModel}`
          : "tvs scooty zest";
        await vehicleMakeInput.sendKeys(vehicleSearchText);
        await driver.sleep(1000);

        // Trigger additional events to ensure autocomplete works
        await driver.executeScript(
          `
          var input = arguments[0];
          var event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
          
          var keyupEvent = new Event('keyup', { bubbles: true });
          input.dispatchEvent(keyupEvent);
          
          var changeEvent = new Event('change', { bubbles: true });
          input.dispatchEvent(changeEvent);
        `,
          vehicleMakeInput
        );

        // Wait for API call to complete and dropdown to appear
        await driver.sleep(4000);
        console.log("Waiting for dropdown options to appear...");

        // Try multiple selectors for the dropdown items
        let firstResult = null;
        try {
          // Try Kendo autocomplete listbox items
          firstResult = await driver.wait(
            until.elementLocated(
              By.xpath("//ul[@id='VehicleDetailsMakeModel_listbox']//li[1]")
            ),
            5000
          );
        } catch (e) {
          try {
            // Try general k-item class
            firstResult = await driver.wait(
              until.elementLocated(
                By.xpath("//li[contains(@class, 'k-item')][1]")
              ),
              5000
            );
          } catch (e2) {
            try {
              // Try any li element in autocomplete
              firstResult = await driver.wait(
                until.elementLocated(
                  By.xpath("//li[contains(@class, 'k-list-item')][1]")
                ),
                5000
              );
            } catch (e3) {
              console.log(
                "Could not find dropdown options, trying alternative approach..."
              );
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

        // Purchase Date - use data from MongoDB or today's date
        console.log("Filling purchase date...");
        const purchaseDate = data.purchaseDate || new Date().toLocaleDateString("en-GB").split("/").join("-"); // Convert DD/MM/YYYY to DD-MM-YYYY
        const purchaseDateInput = await driver.wait(
          until.elementLocated(By.id("Date_PurchaseVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${purchaseDate}';
          var event = new Event('change', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          purchaseDateInput
        );
        console.log(`Filled purchase date with: ${purchaseDate}`);

        // Registration Date - use data from MongoDB or today's date
        console.log("Filling registration date...");
        const registrationDate = data.registrationDate || new Date().toLocaleDateString("en-GB").split("/").join("-"); // Convert DD/MM/YYYY to DD-MM-YYYY
        const registrationDateInput = await driver.wait(
          until.elementLocated(By.id("Date_RegistrationVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${registrationDate}';
          var event = new Event('change', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          registrationDateInput
        );
        console.log(`Filled registration date with: ${registrationDate}`);

        // Manufacturing Year and Month - Use data from MongoDB
        console.log("Attempting manufacturing year and month selection...");
        try {
          // Try to set values directly using JavaScript
          const manufacturingYear = data.manufacturingYear || 2025;
          const manufacturingMonth = data.manufacturingMonth || "10";

          await driver.executeScript(`
            // Try to set manufacturing year
            var yearDropdown = document.getElementById('Manufacturing_YearVehicle');
            if (yearDropdown) {
              var kendoYearWidget = $(yearDropdown).data('kendoDropDownList');
              if (kendoYearWidget) {
                // Try to select the year from data, otherwise first available
                var dataSource = kendoYearWidget.dataSource;
                if (dataSource && dataSource.data().length > 0) {
                  var yearValue = '${manufacturingYear}';
                  var foundYear = null;
                  
                  // Search for matching year
                  for (var i = 0; i < dataSource.data().length; i++) {
                    var yearData = dataSource.data()[i];
                    if (yearData.Text === yearValue || yearData.Value === yearValue) {
                      foundYear = yearData;
                      break;
                    }
                  }
                  
                  var selectedYear = foundYear || dataSource.data()[0];
                  kendoYearWidget.value(selectedYear.Value);
                  kendoYearWidget.trigger('change');
                  console.log('Set manufacturing year to:', selectedYear.Text);
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
                    var monthValue = '${manufacturingMonth}';
                    var foundMonth = null;
                    
                    // Search for matching month
                    for (var i = 0; i < dataSource.data().length; i++) {
                      var monthData = dataSource.data()[i];
                      if (monthData.Text === monthValue || monthData.Value === monthValue) {
                        foundMonth = monthData;
                        break;
                      }
                    }
                    
                    var selectedMonth = foundMonth || dataSource.data()[0];
                    kendoMonthWidget.value(selectedMonth.Value);
                    kendoMonthWidget.trigger('change');
                    console.log('Set manufacturing month to:', selectedMonth.Text);
                  }
                }
              }
            }, 1000);
          `);

          await driver.sleep(3000); // Wait for the JavaScript to execute
          console.log(
            `Attempted to set manufacturing year to ${manufacturingYear} and month to ${manufacturingMonth} via JavaScript`
          );
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
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          rtoCityInput
        );
        await driver.sleep(500);

        // Clear the field first
        await rtoCityInput.clear();
        await driver.sleep(500);

        // Click on the input to focus it
        await rtoCityInput.click();
        await driver.sleep(500);

        // Type the search text and trigger events
        await rtoCityInput.sendKeys(data.rtoCityLocation || "coimbatore");
        await driver.sleep(1000);

        // Trigger additional events to ensure autocomplete works
        await driver.executeScript(
          `
          var input = arguments[0];
          var event = new Event('input', { bubbles: true });
          input.dispatchEvent(event);
          
          var keyupEvent = new Event('keyup', { bubbles: true });
          input.dispatchEvent(keyupEvent);
          
          var changeEvent = new Event('change', { bubbles: true });
          input.dispatchEvent(changeEvent);
        `,
          rtoCityInput
        );

        // Wait for API call to complete and dropdown to appear
        await driver.sleep(4000);
        console.log("Waiting for RTO city dropdown options to appear...");

        // Try multiple selectors for the dropdown items
        let rtoCitySelected = false;
        try {
          // Try Kendo autocomplete listbox items
          const firstRtoResult = await driver.wait(
            until.elementLocated(
              By.xpath("//ul[@id='RTOCityLocation_listbox']//li[1]")
            ),
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
              until.elementLocated(
                By.xpath("//li[contains(@class, 'k-item')][1]")
              ),
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
                until.elementLocated(
                  By.xpath("//li[contains(@class, 'k-list-item')][1]")
                ),
                5000
              );
              await driver.wait(until.elementIsVisible(firstRtoResult), 3000);
              await firstRtoResult.click();
              console.log("Selected first RTO city result from list items");
              rtoCitySelected = true;
            } catch (e3) {
              console.log(
                "Could not find RTO city dropdown options, trying alternative approach..."
              );
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
        const engineNumber = data.engineNumber || "FG5HS2808584";
        const engineNumberInput = await driver.wait(
          until.elementLocated(By.id("EngineNumberVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${engineNumber}';
          var event = new Event('input', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          engineNumberInput
        );
        console.log(`Filled engine number with: ${engineNumber}`);

        // Chassis Number
        console.log("Filling chassis number...");
        const chassisNumber = data.chassisNumber || "MD626DG56S2H08322";
        const chassisNumberInput = await driver.wait(
          until.elementLocated(By.id("ChasisNumberVehicle")),
          10000
        );
        await driver.executeScript(
          `
          arguments[0].value = '${chassisNumber}';
          var event = new Event('input', { bubbles: true });
          arguments[0].dispatchEvent(event);
        `,
          chassisNumberInput
        );
        console.log(`Filled chassis number with: ${chassisNumber}`);

        // Set IDV value (FIRST TIME) from formData.idv
        console.log("Setting IDV value (initial) from formData...");
        const idv = Number(String(data.idv || '').replace(/[^0-9]/g, '')) || 0;
        if (idv > 0) {
          await driver.executeScript(`
            try {
              var desired = ${idv};
              // Prefer total #IDVVehicle; fallback to #ActualIDVVehicle
              var totalEl = document.getElementById('IDVVehicle') || document.getElementById('ActualIDVVehicle');
              if (totalEl) {
                totalEl.removeAttribute('readonly');
                totalEl.removeAttribute('disabled');
                try { totalEl.focus(); } catch(e) {}
                totalEl.value = '';
                totalEl.value = String(desired);
                try { totalEl.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                try { totalEl.dispatchEvent(new Event('keyup', { bubbles: true })); } catch(e) {}
                try { totalEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
                try { totalEl.blur && totalEl.blur(); } catch(e) {}
              }
              // Also set Body/Chassis if present to align with validations
              var bodyEl = document.getElementById('txtBodyIDV');
              var chassisEl = document.getElementById('txtChassisIDV');
              if (bodyEl && chassisEl) {
                var minBody = 5000, minChassis = 3000;
                var chassis = Math.max(minChassis, Math.floor(desired * 0.05));
                var body = Math.max(minBody, desired - chassis);
                // Adjust in case body + chassis exceeded desired due to mins
                if (body + chassis !== desired && desired > (minBody + minChassis)) {
                  chassis = desired - body;
                }
                bodyEl.removeAttribute('readonly');
                chassisEl.removeAttribute('readonly');
                bodyEl.value = '';
                chassisEl.value = '';
                bodyEl.value = String(body);
                chassisEl.value = String(chassis);
                try { bodyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                try { chassisEl.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
                try { bodyEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
                try { chassisEl.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
              }
            } catch(e) {}
          `);
          // Verify IDV was set correctly
          const idvCheck = await driver.executeScript(`
            var el = document.getElementById('IDVVehicle') || document.getElementById('ActualIDVVehicle');
            return el ? el.value : null;
          `);
          console.log(`IDV (initial) verification - Expected: ${idv}, Actual: ${idvCheck}`);
        } else {
          console.log('IDV not provided in formData; skipping initial set');
        }

        // Set Discount Rate (use data.discount from server; allowed: 60 or 80; default 60)
        console.log("Setting discount rate...");
        try {
          const discountParsed = Number(String(data.discount ?? '').replace(/[^0-9.-]/g, ''));
          let discountValue = Number.isFinite(discountParsed) ? discountParsed : 60;
          discountValue = discountValue === 80 ? 80 : 60; // clamp to schema enum
          const discountInput = await driver.wait(
            until.elementLocated(By.id("Detariff_Discount_Rate")),
            10000
          );
          await driver.wait(until.elementIsVisible(discountInput), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            discountInput
          );
          await driver.sleep(500);

          // Clear and set discount value
          await driver.executeScript(
            `
            var el = arguments[0];
            el.removeAttribute('readonly');
            el.removeAttribute('disabled');
            el.value = '';
            el.value = String(arguments[1]);
          `,
            discountInput,
            String(discountValue)
          );

          // Trigger input and blur events to call OnChangeofDiscountLoading()
          await driver.executeScript(`
            var el = arguments[0];
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            // Also call the onblur function directly if it exists
            if (typeof OnChangeofDiscountLoading === 'function') {
              OnChangeofDiscountLoading();
            }
          `, discountInput);

          console.log(`✅ Discount rate set to: ${discountValue}`);
          await driver.sleep(1000);
        } catch (err) {
          console.log("⚠️ Could not set discount rate:", err.message);
        }

        // Click "Get Coverage Details" button
        console.log("Clicking 'Get Coverage Details' button...");
        const getCoverageButton = await driver.wait(
          until.elementLocated(By.id("btnFetchIDV")),
          10000
        );
        await driver.wait(until.elementIsVisible(getCoverageButton), 5000);
        await driver.wait(until.elementIsEnabled(getCoverageButton), 5000);
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          getCoverageButton
        );
        await driver.sleep(1000);

        // Try multiple click methods to ensure the click is registered
        try {
          // First try regular click
          await getCoverageButton.click();
          console.log(
            "Regular click attempted on 'Get Coverage Details' button"
          );
        } catch (e) {
          console.log("Regular click failed, trying JavaScript click...");
          await driver.executeScript(
            "arguments[0].click();",
            getCoverageButton
          );
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

        console.log(
          "Clicked 'Get Coverage Details' button with multiple methods"
        );
        await driver.sleep(5000); // Wait longer for the API call to complete

        // Click PA to Owner Driver checkbox to open modal
        console.log("Clicking PA to Owner Driver checkbox to open modal...");
        const paOwnerDriverCheckbox = await driver.wait(
          until.elementLocated(By.id("ChkBox24")),
          10000
        );
        await driver.executeScript(
          "arguments[0].click();",
          paOwnerDriverCheckbox
        );
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
        await driver.executeScript(
          "arguments[0].click();",
          helmetCoverCheckbox
        );
        console.log("Unchecked Helmet Cover checkbox");
        await driver.sleep(1000);

        // Set TPPD Limit if restriction enabled (select 6000)
        try {
          if (data.tppdRestrict === true || data.tppdRestrict === "true") {
            console.log("TPPD restrict enabled. Selecting 6000 in TPPD dropdown...");

            // First, try using Kendo DropDownList API directly
            const kendoResult = await driver.executeScript(`
              try {
                var widget = $("#ddlTPPDLimit").data("kendoDropDownList");
                if (widget && widget.dataSource && widget.dataSource.data().length) {
                  var ds = widget.dataSource.data();
                  var target = null;
                  for (var i = 0; i < ds.length; i++) {
                    var item = ds[i];
                    var text = String(item.Text || item.text || "").replace(/,/g,"").trim();
                    var value = String(item.Value || item.value || "").replace(/,/g,"").trim();
                    if (text === "6000" || value === "6000" || text.indexOf("6000") !== -1) {
                      target = item;
                      break;
                    }
                  }
                  if (target) {
                    widget.value(target.Value || target.value);
                    widget.trigger("change");
                    return { ok: true, method: "kendo", text: target.Text || target.text, value: target.Value || target.value };
                  }
                  // fallback: select second option (index 1)
                  if (ds.length > 1) {
                    widget.select(1);
                    widget.trigger("change");
                    var sel = widget.dataItem(widget.select());
                    return { ok: true, method: "kendo_index", text: sel && (sel.Text || sel.text), value: sel && (sel.Value || sel.value) };
                  }
                }
                return { ok: false, method: "kendo", reason: "widget or item not found" };
              } catch (e) {
                return { ok: false, method: "kendo", error: e && e.message };
              }
            `);

            if (!kendoResult || !kendoResult.ok) {
              console.log("Kendo API select failed or not available, falling back to UI click...", kendoResult);

              const tppdDropdown = await driver.wait(
                until.elementLocated(
                  By.css("span[aria-owns='ddlTPPDLimit_listbox']")
                ),
                10000
              );
              await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                tppdDropdown
              );
              await driver.sleep(500);
              await driver.executeScript("arguments[0].click();", tppdDropdown);
              await driver.sleep(1000);

              // Try clicking the second item in the listbox first, then text fallbacks
              let optionEl = null;
              const xpaths = [
                "//ul[@id='ddlTPPDLimit_listbox']/li[2]",
                "//li[normalize-space(text())='6000']",
                "//li[normalize-space(text())='6,000']",
                "//li[contains(normalize-space(text()), '6000')]",
              ];
              for (const xp of xpaths) {
                try {
                  optionEl = await driver.wait(
                    until.elementLocated(By.xpath(xp)),
                    2000
                  );
                  break;
                } catch { }
              }

              if (optionEl) {
                await driver.executeScript("arguments[0].click();", optionEl);
                console.log("Selected TPPD limit via UI (second item or 6000 match)");
                await driver.sleep(500);
              } else {
                console.log("Could not locate 6000 option in TPPD dropdown list");
              }
            } else {
              console.log("Selected TPPD limit: 6000 via Kendo API");
            }
          } else {
            console.log("TPPD restrict not enabled. Leaving default TPPD limit.");
          }
        } catch (err) {
          console.log("Could not set TPPD limit:", err.message);
        }

        // Ensure Zero Depreciation is checked when enabled in data
        try {
          if (data.zeroDepreciation === true || data.zeroDepreciation === "true") {
            console.log("Zero Depreciation enabled. Ensuring checkbox is checked...");
            const zeroDepCheckbox = await driver.wait(
              until.elementLocated(By.id("ChkBox10")),
              10000
            );
            const isChecked = await zeroDepCheckbox.isSelected();
            if (!isChecked) {
              await driver.executeScript("arguments[0].click();", zeroDepCheckbox);
              console.log("Checked Zero Depreciation (Nil Depreciation) checkbox");
            } else {
              console.log("Zero Depreciation already checked");
            }
            await driver.sleep(500);
          } else {
            console.log("Zero Depreciation not requested. Leaving as-is.");
          }
        } catch (err) {
          console.log("Could not toggle Zero Depreciation checkbox:", err.message);
        }

        // IDV was already set before "Get Coverage Details" - skipping duplicate set
        console.log("Skipping duplicate IDV set (already set before Get Coverage Details)");

        // === FINANCIER FIELDS HANDLING ===
        // Fill financier details BEFORE "Is Registration Address Same" checkbox
        console.log("Handling financier fields...");

        if (data.hasFinancier) {
          console.log("Vehicle has financier, checking VehicleHypothicated checkbox...");

          try {
            const vehicleHypothicatedCheckbox = await driver.wait(
              until.elementLocated(By.id("VehicleHypothicated")),
              10000
            );

            // Check if already checked
            const isAlreadyChecked = await vehicleHypothicatedCheckbox.isSelected();
            if (!isAlreadyChecked) {
              await driver.executeScript("arguments[0].click();", vehicleHypothicatedCheckbox);
              console.log("Checked VehicleHypothicated checkbox");
            } else {
              console.log("VehicleHypothicated checkbox already checked");
            }

            // Trigger the VehicleHypothicate() function to show financier fields
            await driver.executeScript(`
              if (typeof VehicleHypothicate === 'function') {
                VehicleHypothicate();
              }
            `);
            console.log("Triggered VehicleHypothicate() function");
            await driver.sleep(2000);

            // Force financier sections to be visible
            await driver.executeScript(`
              var finTypeDiv = document.getElementById('DivFinancierType');
              var finNameDiv = document.getElementById('DivFinancierName');
              var finAddressDiv = document.getElementById('DivFinancierAddress');
              
              if (finTypeDiv) {
                finTypeDiv.style.display = 'block';
                finTypeDiv.style.visibility = 'visible';
              }
              if (finNameDiv) {
                finNameDiv.style.display = 'block';
                finNameDiv.style.visibility = 'visible';
              }
              if (finAddressDiv) {
                finAddressDiv.style.display = 'block';
                finAddressDiv.style.visibility = 'visible';
              }
            `);
            console.log("Forced financier sections to be visible");
            await driver.sleep(1000);

            // Select Financier Type (default to Hypothecated)
            console.log(`Selecting financier type...`);
            const finTypeResult = await driver.executeScript(`
              try {
                var map = {
                  'HYPOTHECATED': 1, 'HYPOTHECATE': 1, 'HYPOTHECATION': 1,
                  'HYPOTHECATED/HP/LEASE': 1, 'HIRE PURCHASE': 2,
                  'LEASE AGREEMENT': 3, 'MORTGAGE': 5
                };
                var raw = '${(data.financierType || '').toString().trim().toUpperCase()}';
                var input = raw.replace(/HYPOTE?I?CAL|HYPOTEICAL|HYPOTHETICAL/g, 'HYPOTHECATED');
                var val = map[input] || 1;
                var w = $("#FinancierType").data("kendoDropDownList");
                if (w) {
                  w.value(String(val));
                  w.trigger('change');
                  return { ok: true, value: val };
                }
                return { ok: false, reason: 'widget not found' };
              } catch(e) { return { ok: false, error: e && e.message }; }
            `);
            console.log("Financier type select result:", finTypeResult);
            await driver.sleep(600);

            // Fill Financier Name - Enter text and select FIRST result
            if (data.financierName) {
              console.log(`Filling financier name: ${data.financierName}`);

              // Force field to be visible and enabled
              await driver.executeScript(`
                var input = document.getElementById('AutoFinancierName');
                if (input) {
                  input.style.display = 'block';
                  input.style.visibility = 'visible';
                  input.removeAttribute('disabled');
                  input.removeAttribute('readonly');
                  var parent = input.parentElement;
                  while (parent && parent.tagName !== 'BODY') {
                    if (parent.style) {
                      parent.style.display = '';
                      parent.style.visibility = 'visible';
                    }
                    parent = parent.parentElement;
                  }
                }
              `);

              const financierNameInput = await driver.wait(
                until.elementLocated(By.id("AutoFinancierName")),
                10000
              );

              await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                financierNameInput
              );
              await driver.sleep(500);

              // Clear and type the financier name
              await driver.executeScript("arguments[0].value = '';", financierNameInput);
              await driver.sleep(300);
              await driver.executeScript("arguments[0].click();", financierNameInput);
              await driver.sleep(300);

              await financierNameInput.sendKeys(data.financierName);
              await driver.sleep(1500);

              // Trigger autocomplete events
              await driver.executeScript(`
                var input = arguments[0];
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('keyup', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              `, financierNameInput);
              console.log(`Typed financier name: ${data.financierName}`);

              // Wait for autocomplete dropdown
              await driver.sleep(3000);

              // Select FIRST result from dropdown
              let selected = false;
              try {
                const firstItem = await driver.wait(
                  until.elementLocated(By.xpath("//ul[@id='AutoFinancierName_listbox']/li[1]")),
                  5000
                );
                await driver.wait(until.elementIsVisible(firstItem), 3000);
                await driver.executeScript("arguments[0].click();", firstItem);
                console.log("✅ Selected FIRST financier name from dropdown");
                selected = true;
              } catch (e) {
                console.log("Dropdown not visible, trying keyboard selection...");
                try {
                  await financierNameInput.sendKeys(Key.ARROW_DOWN);
                  await driver.sleep(300);
                  await financierNameInput.sendKeys(Key.ENTER);
                  console.log("✅ Selected FIRST financier via keyboard");
                  selected = true;
                } catch (e2) {
                  console.log("Keyboard failed, trying Kendo API...");
                  await driver.executeScript(`
                    try {
                      var widget = $("#AutoFinancierName").data("kendoAutoComplete");
                      if (widget && widget.dataSource && widget.dataSource.data().length > 0) {
                        var firstItem = widget.dataSource.data()[0];
                        widget.value(firstItem.FinancierName || firstItem.text || firstItem);
                        widget.trigger('change');
                      }
                    } catch(e) {}
                  `);
                  selected = true;
                }
              }

              if (selected) {
                await driver.sleep(1000);
                await driver.executeScript(`
                  if (typeof ValidateFinancierName === 'function') {
                    try { ValidateFinancierName(); } catch(e) {}
                  }
                `);
                console.log("Triggered ValidateFinancierName() function");
                await driver.sleep(1000);
              }
            } else {
              console.log("No financier name provided");
            }

            // Fill Financier Address
            if (data.financierAddress) {
              console.log(`Filling financier address: ${data.financierAddress}`);

              // SAVE the financier name value BEFORE touching the address field
              const savedFinancierName = await driver.executeScript(`
                var finNameField = document.getElementById('AutoFinancierName');
                return finNameField ? finNameField.value : '';
              `);
              console.log(`💾 Saved financier name before address fill: ${savedFinancierName}`);

              await driver.sleep(1500);

              // Force address field to be visible and enabled
              await driver.executeScript(`
                var input = document.getElementById('FinancierAddressVehicle');
                if (input) {
                  input.style.display = 'block';
                  input.style.visibility = 'visible';
                  input.removeAttribute('disabled');
                  input.removeAttribute('readonly');
                  var parent = input.parentElement;
                  while (parent && parent.tagName !== 'BODY') {
                    if (parent.style) {
                      parent.style.display = '';
                      parent.style.visibility = 'visible';
                    }
                    parent = parent.parentElement;
                  }
                }
              `);

              const financierAddressInput = await driver.wait(
                until.elementLocated(By.id("FinancierAddressVehicle")),
                10000
              );

              await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                financierAddressInput
              );
              await driver.sleep(500);

              // Clear and fill using JavaScript
              await driver.executeScript(`
                var el = arguments[0];
                el.removeAttribute('readonly');
                el.removeAttribute('disabled');
                el.value = '';
              `, financierAddressInput);

              await driver.sleep(500);
              await financierAddressInput.sendKeys(data.financierAddress);
              console.log(`✅ Filled financier address: ${data.financierAddress}`);

              // RESTORE financier name immediately after typing address
              await driver.executeScript(`
                var finNameField = document.getElementById('AutoFinancierName');
                var savedName = arguments[0];
                if (finNameField && savedName && !finNameField.value) {
                  finNameField.value = savedName;
                  var widget = $(finNameField).data('kendoAutoComplete');
                  if (widget) {
                    widget.value(savedName);
                  }
                  console.log('🔄 Restored financier name after address input');
                }
              `, savedFinancierName);

              await driver.sleep(800);

              // Trigger events WITHOUT blur to prevent form refresh/hiding fields
              await driver.executeScript(`
                var el = arguments[0];
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                // DO NOT trigger blur() as it may cause form to refresh and hide other fields
              `, financierAddressInput);

              // RESTORE financier name again after triggering events
              await driver.executeScript(`
                var finNameField = document.getElementById('AutoFinancierName');
                var savedName = arguments[0];
                if (finNameField && savedName && !finNameField.value) {
                  finNameField.value = savedName;
                  var widget = $(finNameField).data('kendoAutoComplete');
                  if (widget) {
                    widget.value(savedName);
                  }
                  console.log('🔄 Restored financier name after address events');
                }
              `, savedFinancierName);

              await driver.sleep(1000);

              // Re-trigger VehicleHypothicate() to ensure all financier fields remain visible
              // BUT preserve the financier name value before calling it
              await driver.executeScript(`
                // Save the current financier name value BEFORE VehicleHypothicate
                var finNameField = document.getElementById('AutoFinancierName');
                var savedFinancierName = finNameField ? finNameField.value : '';
                
                if (typeof VehicleHypothicate === 'function') {
                  try {
                    VehicleHypothicate();
                  } catch(e) {
                    console.log('Error re-triggering VehicleHypothicate:', e);
                  }
                }
                
                // Immediately restore the financier name value AFTER VehicleHypothicate
                if (finNameField && savedFinancierName) {
                  finNameField.value = savedFinancierName;
                  // Also update the Kendo widget if present
                  var widget = $(finNameField).data('kendoAutoComplete');
                  if (widget) {
                    widget.value(savedFinancierName);
                  }
                }
              `);
              await driver.sleep(1000);

              // Re-ensure all form fields are still visible after address fill
              await driver.executeScript(`
                // Ensure financier name field and its container are visible
                var finNameInput = document.getElementById('AutoFinancierName');
                var finNameDiv = document.getElementById('DivFinancierName');
                if (finNameInput) {
                  finNameInput.style.display = 'block';
                  finNameInput.style.visibility = 'visible';
                  var parent = finNameInput.closest('div, form, fieldset, tr, td');
                  while (parent && parent.tagName !== 'BODY') {
                    if (parent.style) {
                      parent.style.display = '';
                      parent.style.visibility = 'visible';
                    }
                    parent = parent.parentElement;
                  }
                }
                if (finNameDiv) {
                  finNameDiv.style.display = 'block';
                  finNameDiv.style.visibility = 'visible';
                }
                
                // Ensure financier type field is visible
                var finTypeDiv = document.getElementById('DivFinancierType');
                if (finTypeDiv) {
                  finTypeDiv.style.display = 'block';
                  finTypeDiv.style.visibility = 'visible';
                }
                
                // Ensure vehicle details section is still visible
                var vehicleSection = document.getElementById('VehicleDetailsMakeModel');
                if (vehicleSection) {
                  var parent = vehicleSection.closest('div, form, fieldset');
                  if (parent) {
                    parent.style.display = '';
                    parent.style.visibility = 'visible';
                  }
                }
                
                // Ensure IDV fields are visible
                var idvField = document.getElementById('IDVVehicle') || document.getElementById('ActualIDVVehicle');
                if (idvField) {
                  var idvParent = idvField.closest('div, form, fieldset');
                  if (idvParent) {
                    idvParent.style.display = '';
                    idvParent.style.visibility = 'visible';
                  }
                }
                
                // Ensure discount field is visible
                var discountField = document.getElementById('Detariff_Discount_Rate');
                if (discountField) {
                  var discountParent = discountField.closest('div, form, fieldset');
                  if (discountParent) {
                    discountParent.style.display = '';
                    discountParent.style.visibility = 'visible';
                  }
                }
              `);
              await driver.sleep(500);

              // Wait for any loaders to disappear that might have been triggered
              await waitForLoaderToDisappear(driver);

              // Verify financier name field is still visible and restore if needed
              try {
                // First, get the current value to preserve it (use original as fallback)
                let currentFinNameValue = '';
                try {
                  currentFinNameValue = await driver.executeScript(`
                    var field = document.getElementById('AutoFinancierName');
                    return field ? field.value : '';
                  `);
                } catch (e) {
                  // If we can't get the value, use the original from data
                  currentFinNameValue = data.financierName || '';
                }

                // If value is empty, use original from data
                if (!currentFinNameValue && data.financierName) {
                  currentFinNameValue = data.financierName;
                }

                const financierNameField = await driver.findElement(By.id("AutoFinancierName"));
                const isFinNameVisible = await financierNameField.isDisplayed();
                if (!isFinNameVisible) {
                  console.log("⚠️ Financier name field hidden after address fill, attempting to restore...");
                  await driver.executeScript(`
                    var field = document.getElementById('AutoFinancierName');
                    var finNameDiv = document.getElementById('DivFinancierName');
                    var savedValue = arguments[0];
                    if (field) {
                      field.style.display = 'block';
                      field.style.visibility = 'visible';
                      field.removeAttribute('disabled');
                      field.removeAttribute('readonly');
                      // Restore the value if it was cleared
                      if (!field.value && savedValue) {
                        field.value = savedValue;
                        // Trigger Kendo autocomplete to update if needed
                        var widget = $(field).data('kendoAutoComplete');
                        if (widget) {
                          widget.value(savedValue);
                          widget.trigger('change');
                        }
                      }
                      var parent = field.closest('div, form, fieldset, tr, td');
                      while (parent && parent.tagName !== 'BODY') {
                        if (parent.style) {
                          parent.style.display = '';
                          parent.style.visibility = 'visible';
                        }
                        parent = parent.parentElement;
                      }
                    }
                    if (finNameDiv) {
                      finNameDiv.style.display = 'block';
                      finNameDiv.style.visibility = 'visible';
                    }
                  `, currentFinNameValue);
                  await driver.sleep(500);
                } else {
                  // Even if visible, ensure the value is preserved
                  await driver.executeScript(`
                    var field = document.getElementById('AutoFinancierName');
                    var savedValue = arguments[0];
                    if (field && !field.value && savedValue) {
                      field.value = savedValue;
                      var widget = $(field).data('kendoAutoComplete');
                      if (widget) {
                        widget.value(savedValue);
                        widget.trigger('change');
                      }
                    }
                  `, currentFinNameValue);
                }
                console.log("✅ Verified financier name field is still accessible");
              } catch (verifyErr) {
                console.log("⚠️ Could not verify financier name field:", verifyErr.message);
                // Try to restore anyway with original value
                await driver.executeScript(`
                  var field = document.getElementById('AutoFinancierName');
                  var finNameDiv = document.getElementById('DivFinancierName');
                  var savedValue = arguments[0];
                  if (field) {
                    field.style.display = 'block';
                    field.style.visibility = 'visible';
                    field.removeAttribute('disabled');
                    field.removeAttribute('readonly');
                    if (!field.value && savedValue) {
                      field.value = savedValue;
                      var widget = $(field).data('kendoAutoComplete');
                      if (widget) {
                        widget.value(savedValue);
                      }
                    }
                  }
                  if (finNameDiv) {
                    finNameDiv.style.display = 'block';
                    finNameDiv.style.visibility = 'visible';
                  }
                `, data.financierName || '');
              }

              // Verify critical fields are still present and visible
              try {
                const vehicleMakeField = await driver.findElement(By.id("VehicleDetailsMakeModel"));
                const isVehicleVisible = await vehicleMakeField.isDisplayed();
                if (!isVehicleVisible) {
                  console.log("⚠️ Vehicle field hidden after financier address, attempting to restore...");
                  await driver.executeScript(`
                    var field = document.getElementById('VehicleDetailsMakeModel');
                    if (field) {
                      field.style.display = 'block';
                      field.style.visibility = 'visible';
                      var parent = field.closest('div, form, fieldset, tr, td');
                      while (parent && parent.tagName !== 'BODY') {
                        if (parent.style) {
                          parent.style.display = '';
                          parent.style.visibility = 'visible';
                        }
                        parent = parent.parentElement;
                      }
                    }
                  `);
                }
                console.log("✅ Verified vehicle fields are still accessible");
              } catch (verifyErr) {
                console.log("⚠️ Could not verify vehicle fields:", verifyErr.message);
              }
            } else {
              console.log("No financier address provided");
            }

            console.log("✅ Financier details filled successfully");
          } catch (err) {
            console.log("❌ Error handling financier fields:", err.message);
          }
        } else {
          console.log("Vehicle has no financier, skipping financier fields");
        }

        // Now check "Is Registration Address Same" checkbox
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
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          calculatePremiumButton
        );
        await driver.sleep(500);

        try {
          await calculatePremiumButton.click();
        } catch {
          await driver.executeScript(
            "arguments[0].click();",
            calculatePremiumButton
          );
        }
        console.log("Clicked 'Calculate Premium' button!");

        // Wait for premium calculation to complete
        await driver.sleep(3000);
        console.log("Premium calculation completed!");

        // === STEP 10: Handle post-calculation elements ===
        console.log("Handling post-calculation elements...");

        try {
          // Click Save button
          console.log("Looking for Save button...");
          const saveButton = await driver.wait(
            until.elementLocated(By.id("btnSave")),
            10000
          );
          await driver.wait(until.elementIsVisible(saveButton), 5000);
          await driver.wait(until.elementIsEnabled(saveButton), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            saveButton
          );
          await driver.sleep(500);

          try {
            await saveButton.click();
          } catch {
            await driver.executeScript("arguments[0].click();", saveButton);
          }
          console.log("Clicked Save button!");
          await driver.sleep(3000);

          // === NEW FLOW: Extract Proposal Number ===
          console.log("Extracting proposal number from success message...");
          let proposalNumber = null;
          try {
            // Wait for success message span to appear
            const successMessage = await driver.wait(
              until.elementLocated(By.xpath("//span[contains(text(), 'Proposal Saved Successfully')]")),
              10000
            );
            await driver.wait(until.elementIsVisible(successMessage), 5000);

            // Get the text content which includes proposal and quote numbers
            const messageText = await successMessage.getText();
            console.log(`📋 Success message: ${messageText}`);

            // Extract proposal number using regex: "R" followed by numbers
            const proposalMatch = messageText.match(/R\d+/);
            if (proposalMatch) {
              proposalNumber = proposalMatch[0];
              console.log(`✅ Extracted Proposal Number: ${proposalNumber}`);
            } else {
              console.log("⚠️ Could not extract proposal number from message");
            }
          } catch (err) {
            console.log("Error extracting proposal number:", err.message);
          }

          if (!proposalNumber) {
            console.error("❌ Failed to extract proposal number. Cannot continue with new flow.");
            throw new Error("Proposal number extraction failed");
          }

          // === NEW FLOW: Navigate to View Policy ===
          console.log("Navigating to View Policy...");

          try {
            // Hover over Utility menu
            const utilityMenu = await driver.wait(
              until.elementLocated(By.id("divMainUtility")),
              10000
            );
            await driver.wait(until.elementIsVisible(utilityMenu), 5000);
            await driver.actions({ bridge: true })
              .move({ origin: utilityMenu })
              .perform();
            console.log("✅ Hovered on Utility menu");
            await driver.sleep(2000);

            // Click on "View Policy" link
            const viewPolicyLink = await driver.wait(
              until.elementLocated(
                By.xpath("//li//a[contains(text(), 'View Policy')]")
              ),
              10000
            );
            await driver.wait(until.elementIsVisible(viewPolicyLink), 5000);
            try {
              await viewPolicyLink.click();
            } catch {
              await driver.executeScript("arguments[0].click();", viewPolicyLink);
            }
            console.log("✅ Clicked 'View Policy' link");
            await driver.sleep(3000);
            console.log("⚠️  View Policy opens on same page (no new tab)");

          } catch (err) {
            console.log("❌ Error navigating to View Policy:", err.message);
            throw err;
          }

          // === NEW FLOW: Search for Proposal ===
          console.log("Searching for proposal...");
          try {
            // Wait a bit for page to fully load
            await driver.sleep(2000);

            // Search input: id="txtSearchText" (inside div id="idproposalno")
            console.log("Looking for search input with id='txtSearchText'...");
            let policySearchInput = null;

            try {
              // Primary: id="txtSearchText"
              policySearchInput = await driver.wait(
                until.elementLocated(By.id("txtSearchText")),
                5000
              );
              console.log("✅ Found search input by id='txtSearchText'");
            } catch (e1) {
              console.log("Could not find by id, trying name='SearchText'...");
              try {
                // Secondary: name="SearchText"
                policySearchInput = await driver.wait(
                  until.elementLocated(By.name("SearchText")),
                  5000
                );
                console.log("✅ Found search input by name='SearchText'");
              } catch (e2) {
                console.log("Could not find by name, trying div-based selector...");
                try {
                  // Tertiary: input inside div#idproposalno
                  policySearchInput = await driver.wait(
                    until.elementLocated(By.css("#idproposalno input[type='text']")),
                    5000
                  );
                  console.log("✅ Found search input by div selector");
                } catch (e3) {
                  console.log("Could not find by div selector, trying first text input...");
                  // Fallback: any input on page
                  const allInputs = await driver.findElements(By.css("input[type='text']"));
                  if (allInputs.length > 0) {
                    policySearchInput = allInputs[0];
                    console.log(`✅ Found input using index, total inputs: ${allInputs.length}`);
                  } else {
                    throw new Error("No search input found with any selector");
                  }
                }
              }
            }

            if (!policySearchInput) {
              throw new Error("Policy search input is null");
            }

            await driver.wait(until.elementIsVisible(policySearchInput), 5000);
            await driver.wait(until.elementIsEnabled(policySearchInput), 5000);
            await driver.executeScript(
              "arguments[0].scrollIntoView({block: 'center'});",
              policySearchInput
            );
            await driver.sleep(500);

            // Clear and enter proposal number
            await policySearchInput.clear();
            await driver.sleep(300);
            await policySearchInput.sendKeys(proposalNumber);
            console.log(`✅ Entered proposal number: ${proposalNumber}`);
            await driver.sleep(1000);

            // Find and click Search button
            console.log("Looking for search button...");
            let searchButton = null;

            try {
              // Try to find button near the search input
              const parentDiv = await driver.executeScript(
                "return arguments[0].closest('[id*=\"proposal\"], [class*=\"search\"], form, div');",
                policySearchInput
              );

              if (parentDiv) {
                const buttons = await driver.findElements(By.css("button"));
                if (buttons.length > 0) {
                  searchButton = buttons[0];
                  console.log(`✅ Found first button on page`);
                }
              }
            } catch (e1) {
              // Try alternate selectors
              try {
                searchButton = await driver.wait(
                  until.elementLocated(By.id("btnViewPolicySearch")),
                  3000
                );
                console.log("✅ Found search button by ID");
              } catch (e2) {
                try {
                  searchButton = await driver.wait(
                    until.elementLocated(By.css("button[type='submit']")),
                    3000
                  );
                  console.log("✅ Found search button by type=submit");
                } catch (e3) {
                  // Last resort: any button
                  const allButtons = await driver.findElements(By.css("button"));
                  if (allButtons.length > 0) {
                    searchButton = allButtons[0];
                    console.log(`✅ Found first button, total buttons: ${allButtons.length}`);
                  }
                }
              }
            }

            if (!searchButton) {
              throw new Error("Search button not found");
            }

            // Debug: Get button info
            const buttonText = await searchButton.getText();
            const buttonId = await searchButton.getAttribute("id");
            const buttonClass = await searchButton.getAttribute("class");
            const buttonType = await searchButton.getAttribute("type");
            console.log(`📊 Button details: text="${buttonText}", id="${buttonId}", class="${buttonClass}", type="${buttonType}"`);

            await driver.wait(until.elementIsVisible(searchButton), 5000);
            await driver.wait(until.elementIsEnabled(searchButton), 5000);
            await driver.executeScript(
              "arguments[0].scrollIntoView({block: 'center'});",
              searchButton
            );
            await driver.sleep(500);

            // Take screenshot BEFORE clicking
            try {
              const screenshotsDir = './screenshots';
              if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
              }
              const screenshot = await driver.takeScreenshot();
              const screenshotPath = `./screenshots/before_search_click_${Date.now()}.png`;
              fs.writeFileSync(screenshotPath, screenshot, 'base64');
              console.log(`📷 Screenshot saved BEFORE click: ${screenshotPath}`);
            } catch (screenshotErr) {
              console.log("⚠️  Screenshot error:", screenshotErr.message);
            }

            // Try multiple click methods
            let clickSuccess = false;
            console.log("Attempting to click search button...");

            // Method 0: Call the onclick function directly (GetPolicySearchDetails)
            try {
              await driver.executeScript(`
                if (typeof GetPolicySearchDetails === 'function') {
                  GetPolicySearchDetails();
                  console.log('Called GetPolicySearchDetails() function directly');
                } else {
                  console.log('GetPolicySearchDetails function not found');
                }
              `);
              console.log("✅ Method 0: Direct function call succeeded");
              clickSuccess = true;
            } catch (clickErr0) {
              console.log(`⚠️  Method 0 failed: ${clickErr0.message}`);

              // Method 1: Regular click
              try {
                await searchButton.click();
                console.log("✅ Method 1: Regular click succeeded");
                clickSuccess = true;
              } catch (clickErr1) {
                console.log(`⚠️  Method 1 failed: ${clickErr1.message}`);

                // Method 2: JavaScript click
                try {
                  await driver.executeScript("arguments[0].click();", searchButton);
                  console.log("✅ Method 2: JavaScript click succeeded");
                  clickSuccess = true;
                } catch (clickErr2) {
                  console.log(`⚠️  Method 2 failed: ${clickErr2.message}`);

                  // Method 3: Submit form
                  try {
                    await driver.executeScript(`
                      var btn = arguments[0];
                      var form = btn.closest('form');
                      if (form) {
                        form.submit();
                      } else {
                        btn.click();
                      }
                    `, searchButton);
                    console.log("✅ Method 3: Form submit succeeded");
                    clickSuccess = true;
                  } catch (clickErr3) {
                    console.log(`⚠️  Method 3 failed: ${clickErr3.message}`);

                    // Method 4: Press Enter on input field
                    try {
                      await policySearchInput.sendKeys(Key.ENTER);
                      console.log("✅ Method 4: Enter key on input succeeded");
                      clickSuccess = true;
                    } catch (clickErr4) {
                      console.log(`❌ All click methods failed!`);
                    }
                  }
                }
              }
            }

            if (clickSuccess) {
              console.log("✅ Search button click executed successfully");
            } else {
              console.log("❌ WARNING: Could not click search button with any method");
            }

            await driver.sleep(2000);

            // Wait for search results to load - look for DO KYC link or policy details
            try {
              console.log("⏳ Waiting for search results to load...");
              await driver.wait(
                until.elementLocated(
                  By.xpath("//a[contains(text(), 'DO KYC')]")
                ),
                12000
              );
              console.log("✅ Search results loaded - DO KYC link appeared");
            } catch (waitErr) {
              console.log("⚠️  DO KYC link not found immediately after search. Waiting more...");
              await driver.sleep(3000);
              // Page might need more time to load
            }

          } catch (err) {
            console.log("❌ Error searching for proposal:", err.message);
            throw err;
          }

          // === NEW FLOW: Debug Page Content Before DO KYC ===
          console.log("\n📸 === DEBUGGING PAGE BEFORE DO KYC ===");
          try {
            // Create screenshots directory if it doesn't exist
            const screenshotsDir = './screenshots';
            if (!fs.existsSync(screenshotsDir)) {
              fs.mkdirSync(screenshotsDir, { recursive: true });
            }

            // Take screenshot
            const screenshot = await driver.takeScreenshot();
            const timestamp = Date.now();
            const screenshotPath = `./screenshots/debug_before_kyc_${timestamp}.png`;
            fs.writeFileSync(screenshotPath, screenshot, 'base64');
            console.log(`📷 Screenshot saved: ${screenshotPath}`);

            // Get page source
            const pageSource = await driver.getPageSource();
            console.log(`📄 Page length: ${pageSource.length} characters`);

            // Look for all links on page
            const allLinks = await driver.findElements(By.tagName("a"));
            console.log(`🔗 Total links on page: ${allLinks.length}`);
            for (let i = 0; i < Math.min(allLinks.length, 10); i++) {
              const linkText = await allLinks[i].getText();
              const linkHref = await allLinks[i].getAttribute("href");
              console.log(`   Link ${i}: "${linkText}" -> ${linkHref}`);
            }

            // Search page source for KYC keyword
            if (pageSource.includes("KYC")) {
              console.log("✅ Page contains 'KYC' keyword");
              // Find all occurrences
              const kycMatches = pageSource.match(/KYC|kyc|Kyc/g);
              console.log(`   Found ${kycMatches.length} occurrences of KYC variations`);
            } else {
              console.log("❌ Page does NOT contain 'KYC' keyword!");
            }

            console.log("📸 === END DEBUG INFO ===\n");
          } catch (debugErr) {
            console.log("⚠️  Debug error:", debugErr.message);
          }

          // === NEW FLOW: Click DO KYC Link (Opens New Tab) ===
          console.log("Clicking DO KYC link...");
          let kycWindowHandle = null;
          try {
            // Get current window handles before clicking
            const windowsBeforeKyc = await driver.getAllWindowHandles();
            console.log(`📊 Windows BEFORE DO KYC click: ${windowsBeforeKyc.length}`);

            // Wait for and click the DO KYC link - with multiple fallbacks
            let doKycLink = null;
            try {
              // Try exact text match first
              doKycLink = await driver.wait(
                until.elementLocated(
                  By.xpath("//a[contains(text(), 'DO KYC')]")
                ),
                8000
              );
              console.log("✅ Found DO KYC link by text");
            } catch (e1) {
              try {
                // Try partial match or different case
                doKycLink = await driver.wait(
                  until.elementLocated(
                    By.xpath("//a[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'do kyc')]")
                  ),
                  8000
                );
                console.log("✅ Found DO KYC link by case-insensitive text");
              } catch (e2) {
                try {
                  // Try by link text partially
                  doKycLink = await driver.wait(
                    until.elementLocated(
                      By.xpath("//a[contains(text(), 'KYC')]")
                    ),
                    8000
                  );
                  console.log("✅ Found KYC link by partial text");
                } catch (e3) {
                  // Try all links and find one with DO KYC
                  const allLinks = await driver.findElements(By.tagName("a"));
                  for (let link of allLinks) {
                    const text = await link.getText();
                    if (text && text.includes("KYC")) {
                      doKycLink = link;
                      console.log(`✅ Found KYC link with text: "${text}"`);
                      break;
                    }
                  }
                }
              }
            }

            if (!doKycLink) {
              throw new Error("DO KYC link not found after search");
            }

            await driver.wait(until.elementIsVisible(doKycLink), 5000);

            // Get the href for logging
            const kycUrl = await doKycLink.getAttribute("href");
            console.log(`🔗 DO KYC URL: ${kycUrl}`);

            // Click the link (this will open new tab)
            try {
              await doKycLink.click();
            } catch {
              await driver.executeScript("arguments[0].click();", doKycLink);
            }
            console.log("✅ Clicked DO KYC link");

            // Wait for new tab to open
            await driver.sleep(4000);

            // Check for new window/tab
            const windowsAfterKyc = await driver.getAllWindowHandles();
            console.log(`📊 Windows AFTER DO KYC click: ${windowsAfterKyc.length}`);

            if (windowsAfterKyc.length > windowsBeforeKyc.length) {
              // Find the newly opened window
              const newWindow = windowsAfterKyc.find(handle => !windowsBeforeKyc.includes(handle));
              if (newWindow) {
                kycWindowHandle = newWindow;
                console.log(`📍 New window detected, switching to: ${kycWindowHandle}`);
                await driver.switchTo().window(kycWindowHandle);
                await driver.sleep(3000);
                const newUrl = await driver.getCurrentUrl();
                console.log(`✅ Switched to KYC window, URL: ${newUrl}`);
              }
            } else {
              console.log("⚠️ No new tab opened, staying on current page");
            }
          } catch (err) {
            console.log("❌ Error clicking DO KYC link:", err.message);
            throw err;
          }

          // === NEW FLOW: Upload Document from Database ===
          console.log("Uploading document from database...");
          try {
            // Check if we have Aadhar card document from database
            // Use presignedUrl (generated by backend) for downloading, not location
            let aadharDownloadUrl = data.aadharCard?.presignedUrl;

            // If presignedUrl is not available, generate it using the S3 key
            if (!aadharDownloadUrl && data.aadharCard?.key) {
              console.log(`📥 No presignedUrl found, generating from key: ${data.aadharCard.key}`);
              aadharDownloadUrl = await getPresignedUrl(data.aadharCard.key);
            }

            // Fallback to location URL if presigned URL generation fails
            if (!aadharDownloadUrl) {
              aadharDownloadUrl = data.aadharCard?.location;
              console.log(`⚠️ Using location URL as fallback (may not work): ${aadharDownloadUrl}`);
            }

            if (data.aadharCard && aadharDownloadUrl) {
              console.log(`📄 Found Aadhar document in database: ${data.aadharCard.fileName}`);
              console.log(`📍 Document presignedUrl: ${data.aadharCard.presignedUrl ? 'YES' : 'NO'}`);
              console.log(`📍 Document key: ${data.aadharCard.key || 'NOT SET'}`);
              console.log(`📍 Document location: ${data.aadharCard.location}`);
              console.log(`📥 Using URL: ${aadharDownloadUrl.substring(0, 100)}...`);

              // === STEP 1: Click "UPLOAD DOCUMENT" div ===
              console.log("Finding UPLOAD DOCUMENT div with ng-click='selectDoc(upload)'...");
              let uploadDocDiv = null;

              try {
                // Primary selector: ng-click directive with selectDoc('upload')
                uploadDocDiv = await driver.wait(
                  until.elementLocated(
                    By.css("div[ng-click=\"selectDoc('upload')\"]")
                  ),
                  8000
                );
                console.log("✅ Found UPLOAD DOCUMENT div by ng-click selector");
              } catch (e1) {
                try {
                  // Fallback: XPath with text content
                  uploadDocDiv = await driver.wait(
                    until.elementLocated(
                      By.xpath("//div[contains(@ng-click, 'selectDoc') and contains(., 'UPLOAD')]")
                    ),
                    8000
                  );
                  console.log("✅ Found UPLOAD DOCUMENT div by XPath");
                } catch (e2) {
                  try {
                    // Fallback: Any div with class containing 'doc-type' and containing 'UPLOAD'
                    uploadDocDiv = await driver.wait(
                      until.elementLocated(
                        By.xpath("//div[@class='doc-type' and contains(., 'UPLOAD DOCUMENT')]")
                      ),
                      8000
                    );
                    console.log("✅ Found UPLOAD DOCUMENT div by doc-type class");
                  } catch (e3) {
                    // Fallback: Find div with text containing UPLOAD DOCUMENT
                    uploadDocDiv = await driver.wait(
                      until.elementLocated(
                        By.xpath("//div[contains(text(), 'UPLOAD DOCUMENT')]")
                      ),
                      8000
                    );
                    console.log("✅ Found UPLOAD DOCUMENT div by text content");
                  }
                }
              }

              if (uploadDocDiv) {
                // Make sure div is visible and clickable
                await driver.wait(until.elementIsVisible(uploadDocDiv), 5000);
                await driver.executeScript(
                  "arguments[0].scrollIntoView({block: 'center'});",
                  uploadDocDiv
                );
                await driver.sleep(500);

                // Click the div
                try {
                  await uploadDocDiv.click();
                  console.log("✅ Clicked UPLOAD DOCUMENT div");
                } catch {
                  await driver.executeScript("arguments[0].click();", uploadDocDiv);
                  console.log("✅ Clicked UPLOAD DOCUMENT div (via JavaScript)");
                }

                await driver.sleep(2000);

                // === STEP 2: Handle Angular file upload (ngf-drop/ngf-select) ===
                console.log("Looking for upload input field...");

                try {
                  // Helper function to download file from S3 with proper Windows path
                  const downloadFileFromS3 = (url, originalFileName) => {
                    return new Promise((resolve, reject) => {
                      // Create temp directory in project folder for reliability
                      const tempDir = path.join(__dirname, 'temp_uploads');
                      if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                      }

                      console.log(`📥 Downloading from: ${url}`);
                      console.log(`📄 Original filename: ${originalFileName}`);

                      const protocol = url.startsWith('https') ? https : http;

                      protocol.get(url, (response) => {
                        // Handle redirects
                        if (response.statusCode === 301 || response.statusCode === 302) {
                          const redirectUrl = response.headers.location;
                          console.log(`↪️ Redirecting to: ${redirectUrl}`);
                          downloadFileFromS3(redirectUrl, originalFileName).then(resolve).catch(reject);
                          return;
                        }

                        // Get content-type to determine proper extension
                        const contentType = response.headers['content-type'] || '';
                        console.log(`📋 Content-Type: ${contentType}`);

                        // Map content-type to extension
                        let ext = '.jpg'; // default
                        if (contentType.includes('pdf')) {
                          ext = '.pdf';
                        } else if (contentType.includes('png')) {
                          ext = '.png';
                        } else if (contentType.includes('jpeg') || contentType.includes('jpg')) {
                          ext = '.jpg';
                        } else if (contentType.includes('gif')) {
                          ext = '.gif';
                        } else if (contentType.includes('webp')) {
                          ext = '.webp';
                        } else {
                          // Try to get extension from original filename
                          const origExt = path.extname(originalFileName || '').toLowerCase();
                          if (origExt && ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(origExt)) {
                            ext = origExt;
                          } else {
                            // Try URL path
                            try {
                              const urlPath = new URL(url).pathname;
                              const urlExt = path.extname(urlPath).toLowerCase();
                              if (urlExt && ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(urlExt)) {
                                ext = urlExt;
                              }
                            } catch (e) { }
                          }
                        }

                        const tempFileName = `upload_${Date.now()}${ext}`;
                        const tempFilePath = path.join(tempDir, tempFileName);
                        console.log(`📁 Saving as: ${tempFilePath} (extension: ${ext})`);

                        const file = fs.createWriteStream(tempFilePath);
                        response.pipe(file);

                        file.on('finish', () => {
                          file.close();
                          // Check file size
                          const stats = fs.statSync(tempFilePath);
                          console.log(`✅ File downloaded: ${tempFilePath} (${stats.size} bytes)`);

                          if (stats.size === 0) {
                            reject(new Error('Downloaded file is empty'));
                            return;
                          }

                          resolve(tempFilePath);
                        });

                        file.on('error', (err) => {
                          fs.unlink(tempFilePath, () => { });
                          reject(err);
                        });
                      }).on('error', (err) => {
                        reject(err);
                      });
                    });
                  };

                  // Download Aadhar from S3 using presignedUrl (has temporary access)
                  console.log(`📥 Downloading Aadhar from S3...`);
                  console.log(`📥 URL: ${aadharDownloadUrl.substring(0, 100)}...`);
                  const tempFilePath = await downloadFileFromS3(aadharDownloadUrl, data.aadharCard.fileName);

                  // Verify file exists and get absolute path
                  if (!fs.existsSync(tempFilePath)) {
                    throw new Error(`Downloaded file not found at: ${tempFilePath}`);
                  }
                  const absoluteFilePath = path.resolve(tempFilePath);
                  console.log(`📁 Absolute file path: ${absoluteFilePath}`);

                  // === Upload to BOTH Identity Verification (file1) AND Address Verification (file2) ===

                  // === UPLOAD TO IDENTITY VERIFICATION (file1) ===
                  console.log("📤 === UPLOADING TO IDENTITY VERIFICATION (file1) ===");

                  // Find Identity Verification upload div by looking for the label text
                  let file1Div = null;
                  try {
                    // Method 1: Find by ngf-select containing 'file1'
                    file1Div = await driver.findElement(By.css("div[ngf-select*=\"'file1'\"]"));
                    console.log("✅ Found file1 div via ngf-select attribute");
                  } catch (e) {
                    try {
                      // Method 2: Find by ngf-drop containing 'file1'
                      file1Div = await driver.findElement(By.css("div[ngf-drop*=\"'file1'\"]"));
                      console.log("✅ Found file1 div via ngf-drop attribute");
                    } catch (e2) {
                      try {
                        // Method 3: Find by XPath - look for Identity Verification label and get the upload div
                        file1Div = await driver.findElement(By.xpath(
                          "//p[contains(text(),'Identity Verification')]/ancestor::div[contains(@class,'col-lg-6')]//div[contains(@class,'inner-upload')]"
                        ));
                        console.log("✅ Found file1 div via Identity Verification label");
                      } catch (e3) {
                        // Method 4: Get first inner-upload div
                        const allDivs = await driver.findElements(By.css("div.inner-upload"));
                        if (allDivs.length >= 1) {
                          file1Div = allDivs[0];
                          console.log("✅ Found file1 div (first inner-upload)");
                        }
                      }
                    }
                  }

                  if (file1Div) {
                    // Scroll to file1 div
                    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", file1Div);
                    await driver.sleep(500);

                    // Click to trigger file input creation
                    console.log("Clicking Identity Verification upload area...");
                    await driver.executeScript("arguments[0].click();", file1Div);
                    await driver.sleep(1500);

                    // Find all file inputs on page
                    let fileInputs = await driver.findElements(By.css("input[type='file']"));
                    console.log(`Found ${fileInputs.length} file input(s) after clicking file1 div`);

                    // If no inputs found, create one via JavaScript
                    if (fileInputs.length === 0) {
                      console.log("No file inputs found, trying to create one...");
                      await driver.executeScript(`
                        var input = document.createElement('input');
                        input.type = 'file';
                        input.id = 'tempFileInput1';
                        input.style.position = 'absolute';
                        input.style.top = '0';
                        input.style.left = '0';
                        input.style.zIndex = '99999';
                        document.body.appendChild(input);
                      `);
                      await driver.sleep(500);
                      fileInputs = await driver.findElements(By.css("input[type='file']"));
                    }

                    let file1Uploaded = false;

                    // Try each file input until one works
                    for (let i = 0; i < fileInputs.length && !file1Uploaded; i++) {
                      const fileInput = fileInputs[i];
                      console.log(`Trying file input ${i}...`);

                      try {
                        // Make input visible and interactable
                        await driver.executeScript(`
                          var input = arguments[0];
                          input.style.display = 'block';
                          input.style.visibility = 'visible';
                          input.style.opacity = '1';
                          input.style.position = 'absolute';
                          input.style.top = '0';
                          input.style.left = '0';
                          input.style.height = '50px';
                          input.style.width = '200px';
                          input.style.zIndex = '99999';
                        `, fileInput);
                        await driver.sleep(300);

                        // Try sendKeys
                        await fileInput.sendKeys(absoluteFilePath);
                        console.log(`✅ IDENTITY VERIFICATION (file1) uploaded via input[${i}]: ${data.aadharCard.fileName}`);
                        file1Uploaded = true;

                        // Dispatch change event to trigger Angular
                        await driver.executeScript(`
                          var event = new Event('change', { bubbles: true });
                          arguments[0].dispatchEvent(event);
                        `, fileInput);

                      } catch (sendErr) {
                        console.log(`Input[${i}] sendKeys failed: ${sendErr.message}`);
                      }
                    }

                    if (!file1Uploaded) {
                      console.log("⚠️  Could not upload to file1 via any input, trying Angular scope method...");

                      // Try Angular scope method as last resort
                      try {
                        const fileContent = fs.readFileSync(absoluteFilePath);
                        const base64Content = fileContent.toString('base64');
                        const mimeType = absoluteFilePath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';

                        await driver.executeScript(`
                          var uploadDiv = arguments[0];
                          var byteString = atob('${base64Content}');
                          var ab = new ArrayBuffer(byteString.length);
                          var ia = new Uint8Array(ab);
                          for (var i = 0; i < byteString.length; i++) {
                            ia[i] = byteString.charCodeAt(i);
                          }
                          var blob = new Blob([ab], {type: '${mimeType}'});
                          var file = new File([blob], '${data.aadharCard.fileName}', {type: '${mimeType}', lastModified: Date.now()});
                          
                          if (window.angular) {
                            var scope = angular.element(uploadDiv).scope();
                            if (scope) {
                              if (scope.uploadFile) {
                                scope.uploadFile(file, 'file1', true, 'pan');
                                scope.$apply();
                                console.log('Called uploadFile for file1');
                              } else {
                                scope.file1 = file;
                                scope.$apply();
                                console.log('Set file1 on scope');
                              }
                            }
                          }
                        `, file1Div);
                        console.log("✅ file1 set via Angular scope method");
                        file1Uploaded = true;
                      } catch (angularErr) {
                        console.log(`⚠️  Angular scope method failed: ${angularErr.message}`);
                      }
                    }

                    // Wait for Angular to process file1
                    await driver.sleep(3000);
                    console.log("✅ File1 upload attempt complete");
                  } else {
                    console.log("⚠️  Could not find Identity Verification upload div");
                  }

                  // ========== 2 SECOND GAP BETWEEN UPLOADS ==========
                  console.log("⏳ Waiting 2 seconds before uploading to Address Verification...");
                  await driver.sleep(2000);
                  // ==================================================

                  // === UPLOAD TO ADDRESS VERIFICATION (file2) ===
                  console.log("📤 === UPLOADING TO ADDRESS VERIFICATION (file2) ===");

                  // Find Address Verification upload div
                  let file2Div = null;
                  try {
                    // Method 1: Find by ngf-select containing 'file2'
                    file2Div = await driver.findElement(By.css("div[ngf-select*=\"'file2'\"]"));
                    console.log("✅ Found file2 div via ngf-select attribute");
                  } catch (e) {
                    try {
                      // Method 2: Find by ngf-drop containing 'file2'
                      file2Div = await driver.findElement(By.css("div[ngf-drop*=\"'file2'\"]"));
                      console.log("✅ Found file2 div via ngf-drop attribute");
                    } catch (e2) {
                      try {
                        // Method 3: Find by XPath - look for Address Verification label
                        file2Div = await driver.findElement(By.xpath(
                          "//p[contains(text(),'Address Verification')]/ancestor::div[contains(@class,'col-lg-6')]//div[contains(@class,'inner-upload')]"
                        ));
                        console.log("✅ Found file2 div via Address Verification label");
                      } catch (e3) {
                        // Method 4: Get remaining inner-upload divs
                        const remainingDivs = await driver.findElements(By.css("div.inner-upload"));
                        console.log(`Found ${remainingDivs.length} inner-upload divs remaining`);
                        if (remainingDivs.length >= 1) {
                          // If only 1 div, use it. If 2+, use the second one
                          file2Div = remainingDivs.length >= 2 ? remainingDivs[1] : remainingDivs[0];
                          console.log("✅ Found file2 div from remaining inner-upload divs");
                        }
                      }
                    }
                  }

                  if (file2Div) {
                    // Scroll to file2 div
                    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", file2Div);
                    await driver.sleep(500);

                    // Click to trigger file input
                    console.log("Clicking Address Verification upload area...");
                    await driver.executeScript("arguments[0].click();", file2Div);
                    await driver.sleep(1500);

                    // Find file inputs
                    let fileInputs = await driver.findElements(By.css("input[type='file']"));
                    console.log(`Found ${fileInputs.length} file input(s) after clicking file2 div`);

                    let file2Uploaded = false;

                    // Try each file input (prefer the last one as it's likely the newest)
                    for (let i = fileInputs.length - 1; i >= 0 && !file2Uploaded; i--) {
                      const fileInput = fileInputs[i];
                      console.log(`Trying file input ${i} for file2...`);

                      try {
                        await driver.executeScript(`
                          var input = arguments[0];
                          input.style.display = 'block';
                          input.style.visibility = 'visible';
                          input.style.opacity = '1';
                          input.style.position = 'absolute';
                          input.style.top = '100px';
                          input.style.left = '0';
                          input.style.height = '50px';
                          input.style.width = '200px';
                          input.style.zIndex = '99999';
                        `, fileInput);
                        await driver.sleep(300);

                        await fileInput.sendKeys(absoluteFilePath);
                        console.log(`✅ ADDRESS VERIFICATION (file2) uploaded via input[${i}]: ${data.aadharCard.fileName}`);
                        file2Uploaded = true;

                        // Dispatch change event
                        await driver.executeScript(`
                          var event = new Event('change', { bubbles: true });
                          arguments[0].dispatchEvent(event);
                        `, fileInput);

                      } catch (sendErr) {
                        console.log(`Input[${i}] sendKeys failed for file2: ${sendErr.message}`);
                      }
                    }

                    if (!file2Uploaded) {
                      console.log("⚠️  Could not upload to file2 via any input, trying Angular scope method...");

                      try {
                        const fileContent = fs.readFileSync(absoluteFilePath);
                        const base64Content = fileContent.toString('base64');
                        const mimeType = absoluteFilePath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';

                        await driver.executeScript(`
                          var uploadDiv = arguments[0];
                          var byteString = atob('${base64Content}');
                          var ab = new ArrayBuffer(byteString.length);
                          var ia = new Uint8Array(ab);
                          for (var i = 0; i < byteString.length; i++) {
                            ia[i] = byteString.charCodeAt(i);
                          }
                          var blob = new Blob([ab], {type: '${mimeType}'});
                          var file = new File([blob], '${data.aadharCard.fileName}', {type: '${mimeType}', lastModified: Date.now()});
                          
                          if (window.angular) {
                            var scope = angular.element(uploadDiv).scope();
                            if (scope) {
                              if (scope.uploadFile) {
                                scope.uploadFile(file, 'file2');
                                scope.$apply();
                              } else {
                                scope.file2 = file;
                                scope.$apply();
                              }
                            }
                          }
                        `, file2Div);
                        console.log("✅ file2 set via Angular scope method");
                        file2Uploaded = true;
                      } catch (angularErr) {
                        console.log(`⚠️  Angular scope method failed for file2: ${angularErr.message}`);
                      }
                    }

                    await driver.sleep(3000);
                    console.log("✅ File2 upload attempt complete");
                  } else {
                    console.log("⚠️  Could not find Address Verification upload div");
                  }

                  console.log("✅ Both document uploads attempted");
                  await driver.sleep(2000);

                  // Keep temp file for debugging - don't delete
                  console.log(`📁 Temp file kept at: ${tempFilePath}`);
                  console.log(`📁 Temp folder: ${path.join(__dirname, 'temp_uploads')}`);

                  // === STEP 3: Click SUBMIT button and wait for response ===
                  console.log("Looking for SUBMIT button...");
                  try {
                    let submitButton = null;

                    // Wait a bit for files to be processed and button to appear
                    await driver.sleep(2000);

                    // Try multiple selector methods for the submit button
                    try {
                      // Method 1: Find by ng-click attribute
                      submitButton = await driver.wait(
                        until.elementLocated(By.css("button[ng-click='uploadFilesToAPI()']")),
                        5000
                      );
                      console.log("✅ Found SUBMIT button (ng-click method)");
                    } catch (e1) {
                      try {
                        // Method 2: Find by button text "SUBMIT"
                        submitButton = await driver.wait(
                          until.elementLocated(By.xpath("//button[contains(text(), 'SUBMIT')]")),
                          5000
                        );
                        console.log("✅ Found SUBMIT button (text method)");
                      } catch (e2) {
                        try {
                          // Method 3: Find by class "btn-main"
                          submitButton = await driver.wait(
                            until.elementLocated(By.css("button.btn-main")),
                            5000
                          );
                          console.log("✅ Found SUBMIT button (class method)");
                        } catch (e3) {
                          console.log("⚠️  SUBMIT button not found with any method");
                        }
                      }
                    }

                    if (submitButton) {
                      // Check if button is visible (ng-show condition)
                      const isDisplayed = await submitButton.isDisplayed().catch(() => false);
                      if (!isDisplayed) {
                        console.log("⚠️  SUBMIT button exists but is not visible yet, waiting...");
                        await driver.sleep(3000);
                      }

                      try {
                        // Scroll button into view
                        await driver.executeScript(
                          "arguments[0].scrollIntoView({block: 'center'});",
                          submitButton
                        );
                        await driver.sleep(500);

                        // Click the button
                        await submitButton.click();
                        console.log("✅ Clicked SUBMIT button");
                      } catch (clickErr) {
                        // Fallback to JavaScript click
                        await driver.executeScript("arguments[0].click();", submitButton);
                        console.log("✅ Clicked SUBMIT button (via JavaScript)");
                      }

                      // Wait for API response
                      console.log("⏳ Waiting for API response after SUBMIT...");
                      await driver.sleep(5000);

                      // Check for success message or next step
                      try {
                        // Look for success indicators
                        const successIndicators = await driver.findElements(
                          By.xpath("//*[contains(text(), 'success') or contains(text(), 'Success') or contains(text(), 'uploaded') or contains(text(), 'Uploaded')]")
                        );
                        if (successIndicators.length > 0) {
                          console.log("✅ Upload success indicator found!");
                        }

                        // Also check for any error messages
                        const errorIndicators = await driver.findElements(
                          By.xpath("//*[contains(@class, 'error') or contains(@class, 'alert-danger')]")
                        );
                        if (errorIndicators.length > 0) {
                          for (const errEl of errorIndicators) {
                            const errText = await errEl.getText().catch(() => '');
                            if (errText) {
                              console.log(`⚠️  Error message found: ${errText}`);
                            }
                          }
                        }
                      } catch (checkErr) {
                        // Ignore check errors
                      }

                      console.log("✅ SUBMIT completed successfully");

                      // Wait for API response - increased wait time
                      console.log("⏳ Waiting for API response after SUBMIT (10 seconds)...");
                      await driver.sleep(10000);

                      // === STEP 4: Wait for and Click PROCEED button ===
                      console.log("Looking for PROCEED button...");
                      let proceedButton = null;
                      let proceedAttempts = 0;
                      const maxProceedAttempts = 10;

                      while (!proceedButton && proceedAttempts < maxProceedAttempts) {
                        proceedAttempts++;
                        console.log(`PROCEED button search attempt ${proceedAttempts}/${maxProceedAttempts}...`);

                        try {
                          // Try ng-click selector
                          proceedButton = await driver.findElement(By.css("button[ng-click='redirectToURL()']"));
                          console.log("✅ Found PROCEED button (ng-click method)");
                        } catch (e1) {
                          try {
                            // Try text selector
                            proceedButton = await driver.findElement(By.xpath("//button[contains(text(), 'PROCEED')]"));
                            console.log("✅ Found PROCEED button (text method)");
                          } catch (e2) {
                            try {
                              // Try class selector
                              const btnMains = await driver.findElements(By.css("button.btn-main"));
                              for (const btn of btnMains) {
                                const text = await btn.getText().catch(() => '');
                                if (text.includes('PROCEED')) {
                                  proceedButton = btn;
                                  console.log("✅ Found PROCEED button (class + text method)");
                                  break;
                                }
                              }
                            } catch (e3) {
                              // Not found yet
                            }
                          }
                        }

                        if (!proceedButton) {
                          console.log("PROCEED button not visible yet, waiting 2 seconds...");
                          await driver.sleep(2000);
                        }
                      }

                      if (proceedButton) {
                        console.log("✅ PROCEED button found, clicking...");
                        await driver.executeScript(
                          "arguments[0].scrollIntoView({block: 'center'});",
                          proceedButton
                        );
                        await driver.sleep(500);

                        try {
                          await proceedButton.click();
                          console.log("✅ Clicked PROCEED button");
                        } catch (clickErr) {
                          await driver.executeScript("arguments[0].click();", proceedButton);
                          console.log("✅ Clicked PROCEED button (via JavaScript)");
                        }

                        // Wait for navigation after PROCEED click
                        console.log("⏳ Waiting for navigation after PROCEED click (5 seconds)...");
                        await driver.sleep(5000);

                        // === STEP 5: Handle tabs ===
                        console.log("Checking for new tabs...");
                        const allHandles = await driver.getAllWindowHandles();
                        console.log(`Found ${allHandles.length} window handle(s)`);

                        if (allHandles.length > 1) {
                          // Close current tab (new one opened by PROCEED)
                          await driver.close();
                          console.log("✅ Closed new tab");

                          // Switch to original tab (first one)
                          await driver.switchTo().window(allHandles[0]);
                          console.log("✅ Switched back to original tab");
                        }

                        await driver.sleep(2000);

                        // === STEP 6: Navigate to Pending Quotes ===
                        console.log("Navigating to Pending Quotes page...");
                        try {
                          // Method 1: Try direct URL navigation (most reliable)
                          const currentUrl = await driver.getCurrentUrl();
                          const baseUrl = currentUrl.split('/').slice(0, 3).join('/');
                          const pendingQuotesUrl = baseUrl + '/Payment/Payments?pageName=XhIEGvE4S2ipze7xJW7wmIFef%252b42e%252b6H6mk6l%252f76i0s%253d';

                          console.log(`Navigating to: ${pendingQuotesUrl}`);
                          await driver.get(pendingQuotesUrl);
                          console.log("✅ Navigated to Pending Quotes via URL");
                          await driver.sleep(3000);

                          // Fallback: If URL navigation didn't work, try menu approach
                          const pageSource = await driver.getPageSource();
                          if (!pageSource.includes('Pending') && !pageSource.includes('pending')) {
                            console.log("URL navigation may not have worked, trying menu approach...");

                            const paymentMenu = await driver.wait(
                              until.elementLocated(By.css("div#divMainPay, div.MainMenu.payment, div[data-hovertarget='#divSubPay']")),
                              10000
                            );

                            // Scroll to payment menu
                            await driver.executeScript(
                              "arguments[0].scrollIntoView({block: 'center'});",
                              paymentMenu
                            );
                            await driver.sleep(500);

                            // Try multiple hover/click methods
                            try {
                              // Method A: JavaScript mouseover event
                              await driver.executeScript(`
                                  var menu = arguments[0];
                                  var event = new MouseEvent('mouseover', {
                                    'view': window,
                                    'bubbles': true,
                                    'cancelable': true
                                  });
                                  menu.dispatchEvent(event);
                                `, paymentMenu);
                              await driver.sleep(1000);

                              // Show submenu if hidden
                              await driver.executeScript(`
                                  var subMenu = document.querySelector('#divSubPay, .SubMenu');
                                  if (subMenu) {
                                    subMenu.style.display = 'block';
                                    subMenu.style.visibility = 'visible';
                                    subMenu.style.opacity = '1';
                                  }
                                `);
                              await driver.sleep(500);
                            } catch (hoverErr) {
                              console.log(`Hover failed: ${hoverErr.message}`);
                            }

                            // Try actions API
                            try {
                              await driver.actions().move({ origin: paymentMenu }).perform();
                              console.log("✅ Hovered over Payment menu");
                              await driver.sleep(1500);
                            } catch (actionsErr) {
                              console.log(`Actions hover failed: ${actionsErr.message}`);
                            }

                            // Find and click Pending Quotes link
                            console.log("Looking for Pending Quotes link...");
                            let pendingQuotesLink = null;

                            try {
                              pendingQuotesLink = await driver.findElement(
                                By.xpath("//a[contains(text(), 'Pending Quotes')]")
                              );
                            } catch (e) {
                              pendingQuotesLink = await driver.findElement(
                                By.css("a[href*='Pending'], a[href*='pending']")
                              );
                            }

                            if (pendingQuotesLink) {
                              // Get the href and navigate directly
                              const href = await pendingQuotesLink.getAttribute('href');
                              if (href) {
                                await driver.get(href);
                                console.log("✅ Navigated to Pending Quotes via link href");
                              } else {
                                await driver.executeScript("arguments[0].click();", pendingQuotesLink);
                                console.log("✅ Clicked Pending Quotes via JavaScript");
                              }
                            }
                          }

                          console.log("✅ On Pending Quotes page");

                          await driver.sleep(5000);

                          // === STEP 8: Find and click the proposal checkbox ===
                          console.log("Looking for proposal checkbox...");

                          // Extract proposal number from data if available
                          let proposalNumber = data.proposalNumber || data.proposal_number;
                          console.log(`Searching for proposal: ${proposalNumber}`);

                          try {
                            // Try to find checkbox by proposal number in onclick attribute
                            let proposalCheckbox = null;

                            if (proposalNumber) {
                              try {
                                proposalCheckbox = await driver.wait(
                                  until.elementLocated(By.xpath(`//input[@type='checkbox' and contains(@onclick, '${proposalNumber}')]`)),
                                  10000
                                );
                                console.log(`✅ Found proposal checkbox for: ${proposalNumber}`);
                              } catch (e) {
                                console.log(`⚠️  Could not find checkbox with proposal number: ${proposalNumber}`);
                              }
                            }

                            // If not found by proposal number, try to find by ID pattern
                            if (!proposalCheckbox) {
                              const checkboxes = await driver.findElements(
                                By.xpath("//input[@type='checkbox' and starts-with(@id, 'chkR')]")
                              );
                              if (checkboxes.length > 0) {
                                proposalCheckbox = checkboxes[0]; // Get first matching checkbox
                                console.log("✅ Found first proposal checkbox");
                              }
                            }

                            if (proposalCheckbox) {
                              await driver.executeScript(
                                "arguments[0].scrollIntoView({block: 'center'});",
                                proposalCheckbox
                              );
                              await driver.sleep(500);

                              await proposalCheckbox.click();
                              console.log("✅ Clicked proposal checkbox");

                              await driver.sleep(2000);

                              // === STEP 9: Check TP Declaration checkbox ===
                              console.log("Looking for TP Declaration checkbox...");
                              try {
                                const tpDeclaration = await driver.wait(
                                  until.elementLocated(By.css("input#TPDeclaration1")),
                                  5000
                                );

                                await driver.executeScript(
                                  "arguments[0].scrollIntoView({block: 'center'});",
                                  tpDeclaration
                                );
                                await driver.sleep(500);

                                await tpDeclaration.click();
                                console.log("✅ Checked TP Declaration");

                                await driver.sleep(1500);

                                // === STEP 10: Click Pay button ===
                                console.log("Looking for Pay button...");
                                try {
                                  const payButton = await driver.wait(
                                    until.elementLocated(By.css("input#Paymentbtn")),
                                    5000
                                  );

                                  await driver.executeScript(
                                    "arguments[0].scrollIntoView({block: 'center'});",
                                    payButton
                                  );
                                  await driver.sleep(500);

                                  await payButton.click();
                                  console.log("✅ Clicked Pay button");

                                  await driver.sleep(3000);

                                  // === STEP 11: Enter amount in currency input ===
                                  // DISABLED: Not filling amount field as per requirement
                                  /*
                                  console.log("Looking for amount input field...");
                                  try {
                                    // First, try to get the amount from the table row
                                    let amountToEnter = "";

                                    // Find the selected row and get amount
                                    try {
                                      const amountCell = await driver.findElement(
                                        By.xpath("//tr[contains(@class, 'selected')]//td[contains(@class, 'amount') or contains(@data-field, 'amount')]")
                                      );
                                      amountToEnter = await amountCell.getText();
                                      console.log(`Found amount from table: ${amountToEnter}`);
                                    } catch (e) {
                                      // Try alternative: Get from data object
                                      if (data.premium || data.amount || data.totalPremium || data.flaxprice || data.Flaxprice) {
                                        amountToEnter = String(data.premium || data.amount || data.totalPremium || data.flaxprice || data.Flaxprice);
                                        console.log(`Using amount from data: ${amountToEnter}`);
                                      }
                                    }

                                    // Clean amount string (remove currency symbols, commas)
                                    amountToEnter = amountToEnter.replace(/[₹,\s]/g, '').trim();

                                    if (amountToEnter) {
                                      const amountInput = await driver.wait(
                                        until.elementLocated(By.css("input#txtTotalAmountPaidCurrency")),
                                        5000
                                      );

                                      await driver.executeScript(
                                        "arguments[0].scrollIntoView({block: 'center'});",
                                        amountInput
                                      );
                                      await driver.sleep(500);

                                      // Click on the input to focus
                                      await amountInput.click();
                                      await driver.sleep(500);

                                      // Since it's readonly, use JavaScript to set value
                                      await driver.executeScript(`
                                          var input = arguments[0];
                                          input.removeAttribute('readonly');
                                          input.value = '${amountToEnter}';
                                          input.setAttribute('readonly', 'readonly');
                                          var event = new Event('change', { bubbles: true });
                                          input.dispatchEvent(event);
                                          var inputEvent = new Event('input', { bubbles: true });
                                          input.dispatchEvent(inputEvent);
                                        `, amountInput);

                                      console.log(`✅ Entered amount: ${amountToEnter}`);

                                      // Also try to set the hidden input if exists
                                      try {
                                        await driver.executeScript(`
                                            var hiddenInput = document.getElementById('txtTotalAmountPaid');
                                            if (hiddenInput) {
                                              hiddenInput.value = '${amountToEnter}';
                                              var event = new Event('change', { bubbles: true });
                                              hiddenInput.dispatchEvent(event);
                                            }
                                          `);
                                      } catch (e) {
                                        // Ignore
                                      }

                                      await driver.sleep(2000);
                                      console.log("✅ Payment flow completed successfully!");
                                    } else {
                                      console.log("⚠️  Could not determine amount to enter");
                                    }

                                  } catch (amountErr) {
                                    console.log(`⚠️  Amount input error: ${amountErr.message}`);
                                  }
                                  */
                                  console.log("⏭️  Skipping amount field (disabled)");
                                  await driver.sleep(2000);


                                } catch (payBtnErr) {
                                  console.log(`⚠️  Pay button error: ${payBtnErr.message}`);
                                }

                              } catch (tpErr) {
                                console.log(`⚠️  TP Declaration error: ${tpErr.message}`);
                              }
                            } else {
                              console.log("❌ Could not find proposal checkbox");
                            }

                          } catch (proposalErr) {
                            console.log(`⚠️  Proposal checkbox error: ${proposalErr.message}`);
                          }

                        } catch (paymentMenuErr) {
                          console.log(`⚠️  Payment menu error: ${paymentMenuErr.message}`);
                        }

                      } else {
                        console.log("❌ PROCEED button not found after all attempts");
                      }


                      // Wait indefinitely after payment flow - don't close driver
                      // DISABLED: Allowing code to continue to Brisk API call
                      /*
                      console.log("⏳ Waiting indefinitely (driver won't close)...");
                      await new Promise(() => {
                        // Never resolve - keeps browser open
                      });
                      */
                      console.log("✅ Payment flow completed, continuing to Brisk API...");
                      await driver.sleep(2000);
                    } else {
                      console.log("❌ SUBMIT button could not be located");
                    }

                  } catch (submitErr) {
                    console.log(`⚠️  Submit button error: ${submitErr.message}`);
                  }

                } catch (uploadErr) {
                  console.log(`⚠️ Upload error: ${uploadErr.message}`);
                }
              } else {
                console.log("❌ UPLOAD DOCUMENT div not found");
              }
            } else {
              console.log("⚠️ No Aadhar card found in database");
            }
          } catch (err) {
            console.log("Error uploading document:", err.message);
          }

          console.log("✅ All new flow steps completed successfully!");


          // === OLD FLOW COMMENTED OUT ===
          /*
          // Click Make Payment button
          console.log("Looking for Make Payment button...");
          const makePaymentButton = await driver.wait(
            until.elementLocated(By.id("BtnmakeLive")),
            10000
          );
          await driver.wait(until.elementIsVisible(makePaymentButton), 5000);
          await driver.wait(until.elementIsEnabled(makePaymentButton), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            makePaymentButton
          );
          await driver.sleep(500);

          try {
            await makePaymentButton.click();
          } catch {
            await driver.executeScript(
              "arguments[0].click();",
              makePaymentButton
            );
          }
          console.log("Clicked Make Payment button!");
          await driver.sleep(3000);

          // Check the policy checkbox (using dynamic ID pattern)
          console.log("Looking for policy checkbox...");
          try {
            // Try to find checkbox with pattern chkR followed by numbers
            const policyCheckbox = await driver.wait(
              until.elementLocated(
                By.css("input[id^='chkR'][type='checkbox']")
              ),
              10000
            );
            await driver.wait(until.elementIsVisible(policyCheckbox), 5000);
            await driver.executeScript("arguments[0].click();", policyCheckbox);
            console.log("Checked policy checkbox!");
            await driver.sleep(1000);
          } catch (err) {
            console.log("Could not find policy checkbox:", err.message);
          }

          // Check TP Declaration checkbox
          console.log("Looking for TP Declaration checkbox...");
          try {
            const tpDeclarationCheckbox = await driver.wait(
              until.elementLocated(By.id("TPDeclaration")),
              10000
            );
            await driver.wait(
              until.elementIsVisible(tpDeclarationCheckbox),
              5000
            );
            // await driver.executeScript(
            //   "arguments[0].click();",
            //   tpDeclarationCheckbox
            // );

            const checkbox = await driver.findElement(By.id("TPDeclaration"));
            const isChecked = await checkbox.isSelected();

            if (!isChecked) {
              await checkbox.click();
              console.log("✅ TP Declaration checkbox checked");
            } else {
              console.log("☑️ Already checked");
            }

            console.log("Checked TP Declaration checkbox!");
            await driver.sleep(1000);
          } catch (err) {
            console.log("Could not find TP Declaration checkbox:", err.message);
          }

          // Click Pay button
          console.log("Looking for Pay button...");
          const payButton = await driver.wait(
            until.elementLocated(By.id("Paymentbtn")),
            10000
          );
          await driver.wait(until.elementIsVisible(payButton), 5000);
          await driver.wait(until.elementIsEnabled(payButton), 5000);
          await driver.executeScript(
            "arguments[0].scrollIntoView({block: 'center'});",
            payButton
          );
          await driver.sleep(500);

          try {
            await payButton.click();
          } catch {
            await driver.executeScript("arguments[0].click();", payButton);
          }
          console.log("Clicked Pay button!");
          await driver.sleep(3000);

          // Handle Payment Type dropdown
          console.log("Handling Payment Type dropdown...");
          try {
            const paymentTypeDropdown = await driver.wait(
              until.elementLocated(
                By.css("span[aria-owns='ddlPaymentType_listbox']")
              ),
              10000
            );
            await driver.executeScript(
              "arguments[0].click();",
              paymentTypeDropdown
            );
            await driver.sleep(1000);

            // Select "Send Payment Link" option
            const sendPaymentLinkOption = await driver.wait(
              until.elementLocated(
                By.xpath("//li[contains(text(), 'Send Payment Link')]")
              ),
              5000
            );
            await driver.executeScript(
              "arguments[0].click();",
              sendPaymentLinkOption
            );
            console.log("Selected 'Send Payment Link' from dropdown!");
            await driver.sleep(2000);
          } catch (err) {
            console.log("Could not handle Payment Type dropdown:", err.message);
          }

          // Click Add button
          console.log("Looking for Add button...");
          try {
            const addButton = await driver.wait(
              until.elementLocated(
                By.css("input[onclick*='AddRowToPaymentDetailsGrid']")
              ),
              10000
            );
            await driver.wait(until.elementIsVisible(addButton), 5000);
            await driver.wait(until.elementIsEnabled(addButton), 5000);
            await driver.executeScript(
              "arguments[0].scrollIntoView({block: 'center'});",
              addButton
            );
            await driver.sleep(500);

            try {
              await addButton.click();
            } catch {
              await driver.executeScript("arguments[0].click();", addButton);
            }
            console.log("Clicked Add button!");
            await driver.sleep(2000);

            // Click OK button in modal
            console.log("Looking for OK button in modal...");
            const okButton = await driver.wait(
              until.elementLocated(By.id("btnAddRowToGrid")),
              10000
            );
            await driver.wait(until.elementIsVisible(okButton), 5000);
            await driver.wait(until.elementIsEnabled(okButton), 5000);
            await driver.executeScript("arguments[0].click();", okButton);
            console.log("Clicked OK button in modal!");
            await driver.sleep(2000);
          } catch (err) {
            console.log("Could not handle Add button flow:", err.message);
          }

          // Click Yes button
          console.log("Looking for Yes button...");
          try {
            // const yesButton = await driver.wait(
            //   until.elementLocated(
            //     By.css("input[onclick*='SendMail'][value='Yes']")
            //   ),
            //   10000
            // );
            // await driver.wait(until.elementIsVisible(yesButton), 5000);
            // await driver.wait(until.elementIsEnabled(yesButton), 5000);
            // await driver.executeScript(
            //   "arguments[0].scrollIntoView({block: 'center'});",
            //   yesButton
            // );
            // await driver.sleep(500);
            // console.log("Filling email...");
            // const emailInput = await driver.findElement(By.id("txtEmailID"));
            // await emailInput.sendKeys(data?.email);
            // await driver.sleep(1000);
            const okButton = await driver.findElement(
              By.css(
                ".ui-dialog-buttonpane .ui-dialog-buttonset button:first-child"
              )
            );
            await okButton.click();
            console.log("✅ Clicked OK button");

            try {
              await yesButton.click();
            } catch {
              await driver.executeScript("arguments[0].click();", yesButton);
            }
            console.log("Clicked Yes button!");
            await driver.sleep(3000);
          } catch (err) {
            console.log("Could not find Yes button:", err.message);
          }

          // try {
          //   // Wait for the popup container to be visible
          //   const popup = await driver.wait(
          //     until.elementLocated(By.css(".k-window")),
          //     10000
          //   );

          //   // Wait until it’s displayed
          //   await driver.wait(async () => {
          //     return await popup.isDisplayed();
          //   }, 5000);

          //   // Find the "Yes" button inside the popup
          //   const yesButton = await popup.findElement(
          //     By.css('input[value="Yes"]')
          //   );

          //   // Click it
          //   await yesButton.click();

          //   console.log("✅ Clicked 'Yes' on Contact Details popup");
          // } catch (err) {
          //   console.error("❌ Failed to click 'Yes':", err.message);
          // }

          console.log("All post-calculation elements handled successfully!");
          */
        } catch (err) {
          console.log("Error handling post-calculation elements:", err.message);

          // Mark post-calculation as failed
          postCalculationFailed = true;
          postCalculationError = err.message;

          // Capture error screenshot using centralized handler
          await captureErrorScreenshot(
            driver,
            err,
            data,
            "post-calculation-error"
          );
        }

        console.log("All vehicle details filled successfully!");
      } catch (err) {
        console.log("Error handling post-submission elements:", err.message);

        // Mark post-submission as failed
        postSubmissionFailed = true;
        postSubmissionError = err.message;

        // Capture error screenshot using centralized handler
        await captureErrorScreenshot(
          driver,
          err,
          data,
          "post-submission-error"
        );

        // Don't throw error here, just set flag to mark job as failed
      }
    } catch (err) {
      console.log("Error filling modal fields:", err.message);
      // Capture error screenshot using centralized handler
      await captureErrorScreenshot(driver, err, data, "modal-error");
      throw err;
    }

    await driver.sleep(2000);

    // Return failure if post-calculation failed
    if (postCalculationFailed) {
      hadError = true;
      return {
        success: false,
        error: postCalculationError || "Post-calculation stage failed",
        postSubmissionFailed: true, // Treat as post-submission failure
        stage: "post-calculation",
      };
    }

    // Return failure if post-submission failed (even if modal submission succeeded)
    if (postSubmissionFailed) {
      hadError = true;
      return {
        success: false,
        error: postSubmissionError || "Post-submission stage failed",
        postSubmissionFailed: true,
        stage: "post-submission",
      };
    }

    // === STEP 9: Call Brisk Certificate API ===
    let briskPdfPath = null;
    let reliancePdfPath = null;
    let mergedPdfInfo = null;

    try {
      console.log("📝 Creating Brisk Certificate...");
      const briskResult = await createBriskCertificate(data);
      console.log("✅ Brisk Certificate created successfully:", briskResult);

      // Download the Brisk PDF if downloadUrl is available
      if (briskResult.downloadUrl) {
        try {
          console.log("📥 Downloading Brisk Certificate PDF...");
          briskPdfPath = await downloadBriskPDF(briskResult.downloadUrl, briskResult.policyId);
          console.log(`✅ Brisk PDF saved to: ${briskPdfPath}`);
        } catch (downloadError) {
          console.error("❌ Failed to download Brisk PDF:", downloadError.message);
          // Continue even if download fails
        }
      }

      // === STEP 10: Find Reliance PDF and Merge with Brisk PDF ===
      if (briskPdfPath) {
        try {
          console.log("🔍 Looking for Reliance PDF...");

          // Find the latest PDF in reliance_pdf folder
          const reliancePdfDir = path.join(__dirname, 'reliance_pdf');

          if (fs.existsSync(reliancePdfDir)) {
            const pdfFiles = fs.readdirSync(reliancePdfDir)
              .filter(file => file.endsWith('.pdf'))
              .map(file => ({
                name: file,
                path: path.join(reliancePdfDir, file),
                time: fs.statSync(path.join(reliancePdfDir, file)).mtime.getTime()
              }))
              .sort((a, b) => b.time - a.time); // Sort by newest first

            if (pdfFiles.length > 0) {
              reliancePdfPath = pdfFiles[0].path;
              console.log(`✅ Found Reliance PDF: ${reliancePdfPath}`);

              // Merge PDFs, upload to AWS, and update policy
              console.log("🔄 Starting PDF merge and upload process...");
              console.log("🔍 DEBUG BEFORE MERGE: data._id =", data._id);
              console.log("🔍 DEBUG BEFORE MERGE: data.policyId =", data.policyId);
              console.log("🔍 DEBUG BEFORE MERGE: Available keys =", Object.keys(data));
              mergedPdfInfo = await mergePDFsAndUpload(reliancePdfPath, briskPdfPath, data);
              console.log("✅ PDFs merged and uploaded successfully:", mergedPdfInfo);
            } else {
              console.warn("⚠️  No PDF files found in reliance_pdf folder");
            }
          } else {
            console.warn(`⚠️  Reliance PDF directory not found: ${reliancePdfDir}`);
          }
        } catch (mergeError) {
          console.error("❌ Failed to merge PDFs:", mergeError.message);
          // Continue even if merge fails - we still have individual PDFs
        }
      }

      return {
        success: true,
        briskCertificate: {
          ...briskResult,
          localPdfPath: briskPdfPath
        },
        reliancePdfPath: reliancePdfPath,
        mergedPdf: mergedPdfInfo
      };
    } catch (briskError) {
      console.error("❌ Failed to create Brisk Certificate:", briskError.message);
      // Don't fail the entire job if Brisk API fails, just log it
      return {
        success: true,
        briskCertificateError: briskError.message
      };
    }
  } catch (e) {
    console.error("[relianceForm] Error:", e.message || e);
    hadError = true;

    // Capture error screenshot using centralized handler
    const errorDetails = await captureErrorScreenshot(
      driver,
      e,
      data,
      "form-error"
    );

    return {
      success: false,
      error: String(e.message || e),
      errorStack: e.stack,
      screenshotUrl: errorDetails.screenshotUrl,
      screenshotKey: errorDetails.screenshotKey,
      pageSourceUrl: errorDetails.pageSourceUrl,
      pageSourceKey: errorDetails.pageSourceKey,
      timestamp: new Date(),
      stage: "login-form", // Indicate this is a login form error
      postSubmissionFailed: false,
    };
  }
  finally {
    // Cleanup: Always close browser and delete cloned profile
    if (jobBrowser) {
      await cleanupJobBrowser(jobBrowser);
    }
  }
}

async function getCaptchaScreenShot(driver, filename = "image_screenshot") {
  const imgElement = await driver.findElement(By.id("CaptchaImage"));

  const imageBase64 = await imgElement.takeScreenshot(true);

  fs.writeFileSync(`${filename}.png`, imageBase64, "base64");
  console.log(`Screenshot saved as ${filename}.png`);
}
//txtEmailID
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
};

module.exports = { fillRelianceForm, getCaptchaScreenShot };
