/**
 * KSHEMA session management — deliberately STATELESS.
 *
 * Same shape as nationalSessionManager.js: no master driver, no profile
 * cloning, no recovery tiers. Every job opens a brand-new empty Chrome profile
 * and logs in from scratch. That costs one login per job and buys immunity to
 * every class of shared-session bug (stale cookies, one job logging another
 * out, two jobs fighting over the same profile lock).
 *
 * Credentials are NOT looked up here. server.js resolves them (user's own
 * credential first, then the client's) and passes them in with the job payload,
 * so this module never has to know how that resolution works.
 */
const path = require("path");
const fs = require("fs");
const { CONFIG, PATHS, createJobBrowserDriver } = require("./kshemaBrowserConfig");
const { shouldKeepBrowserOpen, logRetainedBrowser } = require("../../debugRetention");
const { log, debug, warn, err } = require("./kshemaLog");

/**
 * Open a browser for one KSHEMA job.
 *
 * @param {string} jobId - identifier used in the profile directory name
 * @returns {Promise<{driver, profileInfo, jobId}>}
 */
async function createKshemaJobBrowser(jobId) {
  try {
    debug(`🔄 Job ${jobId}: Creating fresh browser session...`);

    // Unique per ATTEMPT, not just per job: a retry must never reuse a
    // directory that a detached, timed-out first attempt still has open —
    // Chrome locks the dir, and the old attempt's cleanup would rmSync it out
    // from under the running retry.
    const userDataDir = path.join(
      PATHS.CLONED_PROFILE_BASE,
      `kshema_job_${jobId}_${Date.now()}`
    );
    const profileDir = path.join(userDataDir, "Default");

    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
    }
    debug(`📂 Job ${jobId}: Created fresh profile: ${profileDir}`);

    const profileInfo = {
      userDataDir,
      profileDirectory: "Default",
      fullPath: profileDir,
      downloadDir: path.join(userDataDir, "downloads"),
    };

    // Create download directory
    if (!fs.existsSync(profileInfo.downloadDir)) {
      fs.mkdirSync(profileInfo.downloadDir, { recursive: true });
    }

    // If the driver fails to start, remove the directory we just made — the
    // caller's finally cannot, because jobBrowser was never assigned.
    let driver;
    try {
      driver = await createJobBrowserDriver(profileInfo);
    } catch (driverError) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
        debug(`🧹 Job ${jobId}: Removed profile after driver failure`);
      } catch (rmError) {
        warn(
          `⚠️ Job ${jobId}: Could not remove failed profile: ${rmError.message}`
        );
      }
      throw driverError;
    }

    debug(`✅ Job ${jobId}: Fresh browser created successfully`);
    return { driver, profileInfo, jobId };
  } catch (error) {
    err(
      `❌ Job ${jobId}: Failed to create job browser:`,
      error.message
    );
    throw error;
  }
}

/**
 * Close a KSHEMA job's browser and delete its profile.
 *
 * NOTE: phase 1 (open the login page, fill the credentials, stop) never calls
 * this — the whole point is that the window stays open to be looked at. It
 * exists so the later phases have it ready and so the retention behaviour
 * matches the other two companies.
 */
async function cleanupKshemaJobBrowser(jobBrowserInfo, { hadError = false } = {}) {
  try {
    if (!jobBrowserInfo) return;
    const { driver, profileInfo, jobId } = jobBrowserInfo;

    // Testing aid: leave a FAILED job's browser open so the page can be looked
    // at. The profile is kept too — deleting it out from under a live Chrome
    // would break the very window we are trying to preserve.
    if (shouldKeepBrowserOpen(hadError)) {
      logRetainedBrowser(
        `KSHEMA Job ${jobId}`,
        profileInfo && profileInfo.fullPath
          ? path.dirname(profileInfo.fullPath)
          : null
      );
      return;
    }

    if (driver) {
      try {
        await driver.quit();
        debug(`🚪 Job ${jobId}: Browser closed`);
      } catch (quitError) {
        warn(
          `⚠️ Job ${jobId}: Error closing browser: ${quitError.message}`
        );
      }
    }

    if (profileInfo && profileInfo.userDataDir) {
      try {
        fs.rmSync(profileInfo.userDataDir, { recursive: true, force: true });
        debug(`🧹 Job ${jobId}: Profile removed`);
      } catch (rmError) {
        warn(
          `⚠️ Job ${jobId}: Could not remove profile: ${rmError.message}`
        );
      }
    }
  } catch (error) {
    err(`Cleanup error:`, error.message);
  }
}

module.exports = {
  CONFIG,
  createKshemaJobBrowser,
  cleanupKshemaJobBrowser,
};
