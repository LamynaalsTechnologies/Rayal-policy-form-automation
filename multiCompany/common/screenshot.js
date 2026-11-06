/**
 * Failure screenshot for multiCompany handlers — one helper, never throws.
 *
 * A screenshot is evidence, not part of the job: taking one must never turn a
 * clean failure into a crash, so every problem here is logged and swallowed.
 *
 * Disk/storage discipline: at most ONE screenshot per failed attempt (a job has
 * maxAttempts, so a bounded handful). They go to S3 under
 * screenshots/multiCompany/, which an S3 lifecycle rule expires on its own after
 * MULTI_COMPANY_SCREENSHOT_RETENTION_DAYS (see s3Uploader.js
 * ensureMultiCompanyScreenshotLifecycleRule, applied at server start). If S3 is
 * unreachable they fall back to local-screenshots/, which server startup wipes.
 */
const { uploadScreenshotToS3, generateScreenshotKey } = require("../../s3Uploader");

/**
 * @param {WebDriver} driver
 * @param {{company: string, jobId: string, attempt?: number}} ctx
 * @returns {Promise<{screenshotUrl?: string, screenshotKey?: string}>}
 */
async function captureFailure(driver, ctx = {}) {
  try {
    if (!driver) return {};
    const base64 = await driver.takeScreenshot();
    const key = generateScreenshotKey(
      String(ctx.jobId || "job"),
      ctx.attempt || 1,
      // "united india" -> multiCompany/united_india (a space in an S3 folder name is legal but awkward in every link)
      `multiCompany/${String(ctx.company || "unknown").trim().replace(/\s+/g, "_")}`
    );
    const url = await uploadScreenshotToS3(base64, key);
    return { screenshotUrl: url, screenshotKey: key };
  } catch (e) {
    console.warn(`[multiCompany] could not capture failure screenshot: ${e.message}`);
    return {};
  }
}

module.exports = { captureFailure };
