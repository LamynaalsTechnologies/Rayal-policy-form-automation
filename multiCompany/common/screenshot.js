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

/** The error a command gets while a portal alert() / confirm() is open. */
const isPopupError = (e) =>
  !!e && (e.name === "UnexpectedAlertOpenError" || /unexpected alert open/i.test(String(e.message || "")));

/**
 * The page's picture. A portal popup that is still open refuses the first try (Chrome closes it as it says so - its
 * default), so it is tried ONCE more; the popup is closed (Cancel, the same as Chrome's own) if it is still there.
 * (2026-11-13, the owner: every error gets its screenshot - a popup at the failure used to leave it without one.)
 */
async function takePicture(driver) {
  try {
    return await driver.takeScreenshot();
  } catch (e) {
    if (!isPopupError(e)) throw e;
    const said = /Alert text\s*:\s*([^}]*)\}?/i.exec(String(e.message || ""));
    console.warn(`[multiCompany] a portal popup was open at the screenshot${said && said[1].trim() ? ` ("${said[1].trim()}")` : ""} - it was closed and the picture taken again`);
    try {
      await driver.switchTo().alert().dismiss();
    } catch (gone) {
      /* already closed by Chrome */
    }
    return driver.takeScreenshot();
  }
}

/**
 * @param {WebDriver} driver
 * @param {{company: string, jobId: string, attempt?: number}} ctx
 * @returns {Promise<{screenshotUrl?: string, screenshotKey?: string}>}
 */
async function captureFailure(driver, ctx = {}) {
  try {
    if (!driver) return {};
    const base64 = await takePicture(driver);
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

module.exports = { captureFailure, takePicture, isPopupError };
