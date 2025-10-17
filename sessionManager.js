/**
 * Session Manager - Manages master session and cloned profiles for parallel jobs
 *
 * Architecture:
 * 1. Master Profile: Contains the logged-in session
 * 2. Cloned Profiles: Each job gets a clone of the master profile
 * 3. Session Check: Verifies login before processing jobs
 */

const {
  createMasterBrowser,
  createClonedBrowser,
  cloneChromeProfile,
  isUserLoggedIn,
  performLogin,
  CONFIG,
  PATHS,
} = require("./browserv2");
const fs = require("fs");
const path = require("path");

// ============================================
// STATE MANAGEMENT
// ============================================

let masterDriver = null;
let isSessionActive = false;
let sessionLastChecked = null;

/**
 * Get session status
 */
function getSessionStatus() {
  return {
    isActive: isSessionActive,
    lastChecked: sessionLastChecked,
    hasMasterDriver: masterDriver !== null,
  };
}

// ============================================
// SESSION INITIALIZATION
// ============================================

/**
 * Initialize master session - called once on server start
 * This creates the master browser and ensures user is logged in
 */
async function initializeMasterSession() {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("  🔐 INITIALIZING MASTER SESSION");
    console.log("=".repeat(60) + "\n");

    // Step 1: Create master browser
    console.log("📂 Creating master browser with profile...");
    masterDriver = await createMasterBrowser();
    console.log("✅ Master browser created\n");

    // Step 2: Navigate to dashboard
    console.log("🌐 Navigating to dashboard...");
    await masterDriver.get(CONFIG.DASHBOARD_URL);
    await masterDriver.sleep(3000);

    // Step 3: Check if already logged in
    console.log("🔍 Checking login status...");
    const loggedIn = await isUserLoggedIn(masterDriver);

    if (loggedIn) {
      console.log("✅ Already logged in! Session is active.\n");
      isSessionActive = true;
      sessionLastChecked = new Date();
    } else {
      // Step 4: Perform login if needed
      console.log("⚠️  Not logged in. Starting login process...\n");
      const loginSuccess = await performLogin(masterDriver);

      if (loginSuccess) {
        console.log("✅ Login successful! Session is now active.\n");
        isSessionActive = true;
        sessionLastChecked = new Date();
      } else {
        console.error("❌ Login failed!\n");
        isSessionActive = false;
        throw new Error("Login failed. Cannot proceed with job processing.");
      }
    }

    console.log("=".repeat(60));
    console.log("  ✅ MASTER SESSION READY");
    console.log("=".repeat(60) + "\n");

    return {
      success: true,
      isActive: isSessionActive,
      masterDriver: masterDriver,
    };
  } catch (error) {
    console.error("\n❌ Failed to initialize master session:", error.message);
    isSessionActive = false;
    throw error;
  }
}

/**
 * Check if session is still active
 * Should be called periodically or before processing jobs
 */
async function checkSession() {
  try {
    if (!masterDriver) {
      console.log("⚠️  No master driver found");
      return false;
    }

    console.log("🔍 Checking session status...");
    const loggedIn = await isUserLoggedIn(masterDriver);

    isSessionActive = loggedIn;
    sessionLastChecked = new Date();

    if (loggedIn) {
      console.log("✅ Session is active");
    } else {
      console.log("❌ Session expired or invalid");
    }

    return loggedIn;
  } catch (error) {
    console.error("❌ Error checking session:", error.message);
    isSessionActive = false;
    return false;
  }
}

/**
 * Re-login if session expired
 */
async function reLoginIfNeeded() {
  try {
    const sessionValid = await checkSession();

    if (!sessionValid) {
      console.log("🔄 Session expired. Re-logging in...");
      const loginSuccess = await performLogin(masterDriver);

      if (loginSuccess) {
        console.log("✅ Re-login successful!");
        isSessionActive = true;
        return true;
      } else {
        console.error("❌ Re-login failed!");
        isSessionActive = false;
        return false;
      }
    }

    return true; // Session still valid
  } catch (error) {
    console.error("❌ Error re-logging in:", error.message);
    return false;
  }
}

// ============================================
// JOB PROCESSING
// ============================================

/**
 * Create a cloned browser for a job
 * This clones the master profile so the job has an independent browser with active session
 */
async function createJobBrowser(jobId) {
  try {
    console.log(`\n📋 [Job ${jobId}] Creating cloned browser...`);

    // Step 1: Ensure session is active
    if (!isSessionActive) {
      console.log(`⚠️  [Job ${jobId}] Master session not active. Checking...`);
      const sessionValid = await reLoginIfNeeded();

      if (!sessionValid) {
        throw new Error("Master session is not active and re-login failed");
      }
    }

    // Step 2: Clone the master profile
    console.log(`📂 [Job ${jobId}] Cloning master profile...`);
    const clonedProfileInfo = cloneChromeProfile(`job_${jobId}`);

    if (!clonedProfileInfo) {
      throw new Error("Failed to clone profile");
    }

    console.log(
      `✅ [Job ${jobId}] Profile cloned: ${clonedProfileInfo.fullPath}`
    );

    // Step 3: Create browser with cloned profile
    console.log(`🌐 [Job ${jobId}] Opening browser with cloned profile...`);
    const clonedDriver = await createClonedBrowser(clonedProfileInfo);

    console.log(`✅ [Job ${jobId}] Cloned browser created successfully\n`);

    return {
      driver: clonedDriver,
      profileInfo: clonedProfileInfo,
      jobId: jobId,
    };
  } catch (error) {
    console.error(
      `❌ [Job ${jobId}] Failed to create job browser:`,
      error.message
    );
    throw error;
  }
}

/**
 * Cleanup job browser and profile
 */
async function cleanupJobBrowser(jobBrowserInfo) {
  try {
    const jobId = jobBrowserInfo.jobId;
    console.log(`\n🧹 [Job ${jobId}] Cleaning up...`);

    // Close browser
    if (jobBrowserInfo.driver) {
      await jobBrowserInfo.driver.quit();
      console.log(`✅ [Job ${jobId}] Browser closed`);
    }

    // Delete cloned profile
    if (jobBrowserInfo.profileInfo && jobBrowserInfo.profileInfo.userDataDir) {
      const profilePath = jobBrowserInfo.profileInfo.userDataDir;
      if (fs.existsSync(profilePath)) {
        deleteDirectoryRecursive(profilePath);
        console.log(`✅ [Job ${jobId}] Cloned profile deleted: ${profilePath}`);
      }
    }

    console.log(`✅ [Job ${jobId}] Cleanup complete\n`);
  } catch (error) {
    console.error(
      `⚠️  Error cleaning up job ${jobBrowserInfo.jobId}:`,
      error.message
    );
  }
}

/**
 * Delete directory recursively
 */
function deleteDirectoryRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) return;

  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      deleteDirectoryRecursive(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
  });

  fs.rmdirSync(dirPath);
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Initialization
  initializeMasterSession,

  // Session management
  checkSession,
  reLoginIfNeeded,
  getSessionStatus,

  // Job processing
  createJobBrowser,
  cleanupJobBrowser,

  // Direct access to state (read-only)
  get masterDriver() {
    return masterDriver;
  },
  get isSessionActive() {
    return isSessionActive;
  },
};
