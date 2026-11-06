/**
 * United India browser sessions (2026-11-06) - deliberately STATELESS, like KSHEMA's (kshemaSessionManager.js): every run
 * opens a brand-new empty Chrome profile and logs in from scratch, so no stale cookie or other job's session can leak in.
 *
 * The Chrome itself is KSHEMA's job driver (kshemaBrowserConfig.createJobBrowserDriver): a plain throwaway profile, the
 * same flags, headless when there is no display, and NO implicit wait - a box that is not there answers at once instead of
 * blocking (the old download project lost 20 s per missing element to an implicit wait).
 *
 * Its own folder, cloned_profiles_united_india: Chrome refuses two instances on one user-data-dir, so each company keeps
 * its own tree (server.js cleans it on start and sweeps orphans in it every 5 minutes). Credentials are not looked up
 * here: the part runner resolves them and the handler hands them to the login.
 */
const path = require("path");
const fs = require("fs");
const { createJobBrowserDriver } = require("../../../fullPolicycompany/kshema/kshemaBrowserConfig");
const { shouldKeepBrowserOpen, logRetainedBrowser } = require("../../../debugRetention");
const jobDirs = require("../../../lib/jobDirs");
const { watchRetainedBrowser } = require("../../../lib/retainedBrowser");

const TAG = "[United India]";
// process.cwd(): the server runs from the project root, and server.js's clean-up lists are relative to the root.
const PROFILE_BASE = () => path.join(process.cwd(), "cloned_profiles_united_india");

/**
 * @param {string} jobId used in the profile folder's name
 * @param {{ buildDriver?: Function }} [deps] tests replace the Chrome
 * @returns {Promise<{driver, profileInfo, jobId}>}
 */
async function createUnitedIndiaJobBrowser(jobId, { buildDriver = createJobBrowserDriver } = {}) {
  // Unique per ATTEMPT: a retry never reuses a folder a timed-out earlier attempt may still hold.
  // No spaces or odd characters in the folder name ("tp_united india_..." made a folder name with a space).
  const safeId = String(jobId || "job").replace(/[^A-Za-z0-9_-]+/g, "_");
  const userDataDir = path.join(PROFILE_BASE(), `united_india_job_${safeId}_${Date.now()}_${jobDirs.uniqueSuffix()}`);
  const profileDir = path.join(userDataDir, "Default");
  const downloadDir = path.join(userDataDir, "downloads");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });
  const profileInfo = { userDataDir, profileDirectory: "Default", fullPath: profileDir, downloadDir };

  let driver;
  try {
    driver = await buildDriver(profileInfo);
  } catch (error) {
    // The caller's clean-up cannot remove it (it never got the browser), so it is removed here.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (rmError) {
      console.warn(`${TAG} ⚠️ Job ${jobId}: could not remove the profile of a browser that did not start: ${rmError.message}`);
    }
    console.error(`${TAG} ❌ Job ${jobId}: the browser did not start: ${error.message}`);
    throw error;
  }
  jobDirs.claim(userDataDir); // this job holds its folder: nobody else's clean-up may delete it (lib/jobDirs.js)
  return { driver, profileInfo, jobId };
}

/**
 * Close the job's browser and delete its profile. A failed or stopped run (a Breaker stop too) keeps its window open
 * when KEEP_BROWSER_OPEN_ON_ERROR=true (debugRetention.js) - with its profile, which a live Chrome still needs.
 */
async function cleanupUnitedIndiaJobBrowser(jobBrowser, { hadError = false } = {}) {
  if (!jobBrowser) return;
  const { driver, profileInfo, jobId } = jobBrowser;
  try {
    if (shouldKeepBrowserOpen(hadError)) {
      logRetainedBrowser(`United India Job ${jobId}`, profileInfo && profileInfo.userDataDir);
      // Closing the window by hand removes this job's own profile (lib/retainedBrowser.js).
      watchRetainedBrowser({ label: `United India Job ${jobId}`, driver, dirs: [profileInfo && profileInfo.userDataDir] });
      return;
    }
    if (driver) {
      try {
        await driver.quit();
      } catch (quitError) {
        console.warn(`${TAG} ⚠️ Job ${jobId}: error closing the browser: ${quitError.message}`);
      }
    }
    if (profileInfo && profileInfo.userDataDir && jobDirs.release(profileInfo.userDataDir)) {
      try {
        fs.rmSync(profileInfo.userDataDir, { recursive: true, force: true });
      } catch (rmError) {
        console.warn(`${TAG} ⚠️ Job ${jobId}: could not remove the profile: ${rmError.message}`);
      }
    }
  } catch (error) {
    console.error(`${TAG} clean-up error: ${error.message}`);
  }
}

module.exports = { createUnitedIndiaJobBrowser, cleanupUnitedIndiaJobBrowser, PROFILE_BASE };
