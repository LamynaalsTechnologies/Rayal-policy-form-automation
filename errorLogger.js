/**
 * Error Logger - Detailed error tracking for job queue
 *
 * Logs errors with:
 * - Timestamp
 * - Attempt number
 * - Screenshot S3 URL
 * - Error details
 * - Stack trace
 */

const fs = require("fs");
const path = require("path");
const { uploadScreenshotToS3, generateScreenshotKey } = require("./s3Uploader");

/**
 * Create detailed error log entry
 * @param {Error} error - Error object
 * @param {number} attemptNumber - Current attempt number
 * @param {string} screenshotBase64 - Base64 screenshot (optional)
 * @param {string} jobId - Job identifier
 * @returns {Promise<Object>} Error log object
 */
async function createErrorLog(
  error,
  attemptNumber,
  screenshotBase64 = null,
  jobId = null
) {
  const errorLog = {
    timestamp: new Date(),
    attemptNumber: attemptNumber,
    errorMessage: error.message || String(error),
    errorStack: error.stack || null,
    errorType: error.name || "Error",
    screenshotUrl: null,
    screenshotKey: null,
  };

  // Upload screenshot to S3 if provided
  if (screenshotBase64 && jobId) {
    try {
      const s3Key = generateScreenshotKey(jobId, attemptNumber, "error");
      const s3Url = await uploadScreenshotToS3(screenshotBase64, s3Key);

      errorLog.screenshotUrl = s3Url;
      errorLog.screenshotKey = s3Key;

      console.log(`✅ Error screenshot uploaded to S3: ${s3Url}`);
    } catch (uploadErr) {
      console.error(
        `⚠️  Failed to upload screenshot to S3:`,
        uploadErr.message
      );
      // Continue even if S3 upload fails
      errorLog.screenshotUploadError = uploadErr.message;
    }
  }

  return errorLog;
}

/**
 * Create detailed post-submission error log
 * @param {Error} error - Error object
 * @param {number} attemptNumber - Current attempt number
 * @param {string} screenshotBase64 - Base64 screenshot
 * @param {string} jobId - Job identifier
 * @param {Object} additionalInfo - Additional context
 * @returns {Promise<Object>} Error log object
 */
async function createPostSubmissionErrorLog(
  error,
  attemptNumber,
  screenshotBase64,
  jobId,
  additionalInfo = {}
) {
  const errorLog = await createErrorLog(
    error,
    attemptNumber,
    screenshotBase64,
    jobId
  );

  // Add post-submission specific info
  errorLog.errorType = "PostSubmissionError";
  errorLog.stage = "post-submission";
  errorLog.additionalInfo = additionalInfo;

  return errorLog;
}

/**
 * Update MongoDB job with error log
 * @param {Object} jobQueueCollection - MongoDB collection
 * @param {ObjectId} jobId - Job _id
 * @param {Object} errorLog - Error log object
 * @param {number} currentAttempts - Current attempt count
 * @param {number} maxAttempts - Maximum attempts
 */
async function logErrorToJobQueue(
  jobQueueCollection,
  jobId,
  errorLog,
  currentAttempts,
  maxAttempts
) {
  try {
    // Add error to errorLogs array in the job document
    const update = {
      $push: {
        errorLogs: errorLog,
      },
      $set: {
        lastError: errorLog.errorMessage,
        lastErrorTimestamp: errorLog.timestamp,
        lastAttemptAt: new Date(),
        attempts: currentAttempts,
      },
    };

    // If this was the final attempt, mark as failed
    if (currentAttempts >= maxAttempts) {
      update.$set.status = "failed";
      update.$set.failedAt = new Date();
      update.$set.finalError = errorLog;
    } else {
      // Reset to pending for retry
      update.$set.status = "pending";
      update.$set.nextRetryAt = new Date(Date.now() + 60000); // Retry in 1 minute
    }

    await jobQueueCollection.updateOne({ _id: jobId }, update);

    console.log(
      `✅ Error logged to job queue (Attempt ${currentAttempts}/${maxAttempts})`
    );
  } catch (err) {
    console.error(`❌ Failed to log error to job queue:`, err.message);
  }
}

/**
 * Take screenshot and upload to S3, then log error
 * @param {WebDriver} driver - Selenium driver
 * @param {Object} jobQueueCollection - MongoDB collection
 * @param {ObjectId} jobId - Job _id
 * @param {string} jobIdentifier - Job identifier string
 * @param {Error} error - Error object
 * @param {number} attemptNumber - Current attempt
 * @param {number} maxAttempts - Max attempts
 * @param {string} errorType - Error type (e.g., 'error', 'post-submission')
 */
async function captureAndLogError(
  driver,
  jobQueueCollection,
  jobId,
  jobIdentifier,
  error,
  attemptNumber,
  maxAttempts,
  errorType = "error"
) {
  try {
    console.log(`📸 [${jobIdentifier}] Capturing error screenshot...`);

    // Take screenshot
    const screenshot = await driver.takeScreenshot();

    // Create error log (uploads screenshot to S3)
    const errorLog = await createErrorLog(
      error,
      attemptNumber,
      screenshot,
      jobIdentifier
    );

    // Also capture page source for debugging
    try {
      const pageSource = await driver.getPageSource();
      const pageSourceKey = generateScreenshotKey(
        jobIdentifier,
        attemptNumber,
        `${errorType}-source`
      ).replace(".png", ".html");

      // Upload page source to S3
      const { uploadToS3 } = require("./s3Uploader");
      const tempHtmlPath = path.join(
        __dirname,
        `temp-${jobIdentifier}-${attemptNumber}.html`
      );
      fs.writeFileSync(tempHtmlPath, pageSource);
      const pageSourceUrl = await uploadToS3(tempHtmlPath, pageSourceKey);
      fs.unlinkSync(tempHtmlPath); // Delete temp file

      errorLog.pageSourceUrl = pageSourceUrl;
      errorLog.pageSourceKey = pageSourceKey;

      console.log(`✅ Page source uploaded: ${pageSourceUrl}`);
    } catch (sourceErr) {
      console.log(`⚠️  Could not capture page source:`, sourceErr.message);
      errorLog.pageSourceError = sourceErr.message;
    }

    // Log to MongoDB
    await logErrorToJobQueue(
      jobQueueCollection,
      jobId,
      errorLog,
      attemptNumber,
      maxAttempts
    );

    return errorLog;
  } catch (captureErr) {
    console.error(`❌ Failed to capture and log error:`, captureErr.message);

    // Still try to log basic error to MongoDB even if screenshot fails
    try {
      const basicErrorLog = {
        timestamp: new Date(),
        attemptNumber: attemptNumber,
        errorMessage: error.message || String(error),
        errorStack: error.stack || null,
        screenshotCaptureError: captureErr.message,
      };

      await logErrorToJobQueue(
        jobQueueCollection,
        jobId,
        basicErrorLog,
        attemptNumber,
        maxAttempts
      );
    } catch (finalErr) {
      console.error(`❌ Even basic error logging failed:`, finalErr.message);
    }
  }
}

module.exports = {
  createErrorLog,
  createPostSubmissionErrorLog,
  logErrorToJobQueue,
  captureAndLogError,
};
