/**
 * National Session Manager - per-job browsers for National Insurance
 *
 * There is no master session and no profile cloning: every job gets a FRESH,
 * empty Chrome profile and logs in on its own. That is what makes National
 * jobs safe to run in parallel — no shared driver, profile or login state.
 *
 * Each profile directory is unique per attempt and is deleted in
 * cleanupNationalJobBrowser (which the caller runs in a `finally`).
 */

// CONFIG is no longer imported here — this module stopped resolving
// credentials, so it has nothing left to read from the shared config object.
const { createClonedBrowser } = require("./nationalBrowserConfig");
const fs = require("fs");
const path = require("path");
const {
  shouldKeepBrowserOpen,
  logRetainedBrowser,
} = require("./debugRetention");

// ============================================
// STATE MANAGEMENT
// ============================================

// The National master-session / recovery subsystem was removed: nothing ever
// called it (National logs in fresh per job), yet it held a single shared
// masterDriver + recovery counters in module scope — unsafe now that National
// jobs run in parallel.

// ============================================
// JOB PROCESSING
// ============================================

/**
 * Create a fresh browser for a National job.
 * National uses a simple approach: each job gets a fresh browser and logs in.
 *
 * This no longer resolves credentials. It used to run its own lookup that ended
 * in `findOne({provider:"national", isActive:true})` — the first active National
 * row in the entire database — and, because the caller never passed a policy id,
 * that fallback was the ONLY branch that ever ran. A client with its own portal
 * URL could therefore be sent to somebody else's.
 *
 * The queue resolves the login once (lib/credentialResolver.js) and passes it to
 * fillNationalForm, which is the single source for username/password/loginUrl.
 *
 * @param {string} jobId - Unique identifier for the job
 */
async function createNationalJobBrowser(jobId) {
  try {
    console.log(`\n📋 [National Job ${jobId}] Creating fresh browser...`);

    // Create a fresh profile for this job (no cloning, no master session).
    // createClonedBrowser / fs / path all come from the module-level requires.

    // Unique per ATTEMPT, not just per job: a retry of the same jobId must
    // never reuse a directory that a detached, timed-out first attempt still
    // has open (Chrome locks the dir; the old attempt's cleanup would also
    // rmSync it out from under the running retry).
    const clonedUserDataDir = path.join(
      process.cwd(),
      "cloned_profiles_national",
      `national_job_${jobId}_${Date.now()}`
    );
    const clonedProfileDir = path.join(clonedUserDataDir, "Default");

    // Ensure directory exists
    if (!fs.existsSync(clonedProfileDir)) {
      fs.mkdirSync(clonedProfileDir, { recursive: true });
    }

    console.log(`📂 [National Job ${jobId}] Created fresh profile: ${clonedProfileDir}`);

    // Create browser with fresh profile. If THIS throws, remove the dir we
    // just created — the caller's finally can't (jobBrowser never assigned).
    console.log(`🌐 [National Job ${jobId}] Opening browser with fresh profile...`);
    let clonedDriver;
    try {
      clonedDriver = await createClonedBrowser({
        userDataDir: clonedUserDataDir,
        profileDirectory: "Default",
        fullPath: clonedProfileDir,
      });
    } catch (driverError) {
      try {
        fs.rmSync(clonedUserDataDir, { recursive: true, force: true });
        console.log(`🧹 [National Job ${jobId}] Removed profile after driver failure`);
      } catch (rmError) {
        console.warn(`⚠️ [National Job ${jobId}] Could not remove failed profile: ${rmError.message}`);
      }
      throw driverError;
    }

    console.log(`✅ [National Job ${jobId}] Fresh browser created successfully\n`);

    return {
      driver: clonedDriver,
      profileInfo: {
        userDataDir: clonedUserDataDir,
        profileDirectory: "Default",
        fullPath: clonedProfileDir,
      },
      jobId: jobId,
      // No credentials here any more — they arrive with the job payload. See
      // the note on this function.
    };
  } catch (error) {
    console.error(
      `❌ [National Job ${jobId}] Failed to create job browser:`,
      error.message
    );
    throw error;
  }
}

/**
 * Cleanup National job browser and profile
 */
async function cleanupNationalJobBrowser(jobBrowserInfo, { hadError = false } = {}) {
  try {
    if (!jobBrowserInfo) {
      return;
    }

    const { driver, profileInfo } = jobBrowserInfo;

    // Testing aid: leave a FAILED job's browser open so the page can be looked
    // at. The profile is kept too — deleting it out from under a live Chrome
    // would break the very window we are trying to preserve.
    if (shouldKeepBrowserOpen(hadError)) {
      logRetainedBrowser(
        `National Job ${jobBrowserInfo.jobId}`,
        profileInfo && profileInfo.fullPath
          ? path.dirname(profileInfo.fullPath)
          : null
      );
      return;
    }

    // Close browser
    if (driver) {
      try {
        await driver.quit();
        console.log(`✅ [National Job ${jobBrowserInfo.jobId}] Browser closed`);
      } catch (quitError) {
        console.warn(
          `⚠️  [National Job ${jobBrowserInfo.jobId}] Error closing browser:`,
          quitError.message
        );
      }
    }

    // Cleanup cloned profile
    if (profileInfo && profileInfo.fullPath) {
      try {
        // Remove the entire cloned profile directory
        const clonedBasePath = path.dirname(profileInfo.fullPath);
        if (fs.existsSync(clonedBasePath)) {
          fs.rmSync(clonedBasePath, { recursive: true, force: true });
          console.log(
            `✅ [National Job ${jobBrowserInfo.jobId}] Cloned profile cleaned up: ${clonedBasePath}`
          );
        }
      } catch (cleanupError) {
        console.warn(
          `⚠️  [National Job ${jobBrowserInfo.jobId}] Error cleaning up profile:`,
          cleanupError.message
        );
      }
    }
  } catch (error) {
    console.error(
      `❌ [National Job ${jobBrowserInfo?.jobId || "unknown"}] Cleanup error:`,
      error.message
    );
  }
}

// Export functions
module.exports = {
  createNationalJobBrowser,
  cleanupNationalJobBrowser,
};

