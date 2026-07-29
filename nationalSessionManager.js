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

const {
  createClonedBrowser,
  CONFIG,
} = require("./nationalBrowserConfig");
const fs = require("fs");
const path = require("path");

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
 * Create a fresh browser for a National job
 * National uses a simple approach: each job gets a fresh browser and logs in
 * @param {string} jobId - Unique identifier for the job
 * @param {string} policyId - Optional policy ID to fetch specific credentials
 */
async function createNationalJobBrowser(jobId, policyId = null) {
  try {
    console.log(`\n📋 [National Job ${jobId}] Creating fresh browser...`);

    // Ensure MongoDB connection if policyId is provided
    const mongoose = require("mongoose");
    const { ProviderCredential } = require("./models");
    
    if (mongoose.connection.readyState === 0) {
      if (process.env.MONGODB_URI) {
        await mongoose.connect(process.env.MONGODB_URI);
      }
    }

    // Fetch credentials logic
    let creds = null;
    const { CONFIG } = require("./nationalBrowserConfig");

    if (policyId) {
      console.log(`→ [Job ${jobId}] Fetching policy data for ID: ${policyId}...`);
      const policy = await mongoose.connection.db
        .collection("onlinePolicy")
        .findOne({ _id: new mongoose.Types.ObjectId(policyId) });

      if (policy && policy.clientId) {
        creds = await ProviderCredential.findOne({
          clientId: policy.clientId,
          provider: "national",
          isActive: true,
        });
      }
    }

    if (!creds) {
      creds = await ProviderCredential.findOne({
        provider: "national",
        isActive: true,
      });
    }

    if (creds) {
      console.log(`✓ [Job ${jobId}] Using credentials for: ${creds.username}`);
      // Kept for backward compatibility ONLY — CONFIG is one shared object, so
      // with parallel jobs the values race. Job code must use the per-job
      // credentials/loginUrl returned below, never CONFIG.
      CONFIG.USERNAME = creds.username;
      CONFIG.PASSWORD = creds.password;
      if (creds.loginUrl) CONFIG.LOGIN_URL = creds.loginUrl;
    } else {
      console.warn(`⚠️ [Job ${jobId}] No National credentials found in DB`);
    }

    // Create a fresh profile for this job (no cloning, no master session)
    const { createClonedBrowser } = require("./nationalBrowserConfig");
    const fs = require("fs");
    const path = require("path");

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
      // Per-job values — job code MUST use these instead of the shared CONFIG
      // (see the race note above).
      loginUrl: (creds && creds.loginUrl) || CONFIG.LOGIN_URL,
      username: creds ? creds.username : CONFIG.USERNAME,
      password: creds ? creds.password : CONFIG.PASSWORD,
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
async function cleanupNationalJobBrowser(jobBrowserInfo) {
  try {
    if (!jobBrowserInfo) {
      return;
    }

    const { driver, profileInfo } = jobBrowserInfo;

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

