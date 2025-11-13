/**
 * National Insurance Session Manager - Manages master session and cloned profiles for parallel jobs
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
  isNationalUserLoggedIn,
  performNationalLogin,
  CONFIG,
  PATHS,
} = require("./nationalBrowserConfig");
const fs = require("fs");
const path = require("path");

// ============================================
// STATE MANAGEMENT
// ============================================

let masterDriver = null;
let isSessionActive = false;
let sessionLastChecked = null;
let optimizationsEnabled = false;

/**
 * Get session status
 */
function getNationalSessionStatus() {
  return {
    isActive: isSessionActive,
    lastChecked: sessionLastChecked,
    hasMasterDriver: masterDriver !== null,
  };
}

// ============================================
// MASTER SESSION RECOVERY MANAGER
// ============================================

/**
 * Simple Master Session Recovery for National
 */
class NationalMasterSessionRecovery {
  constructor() {
    this.isRecovering = false;
    this.recoveryHistory = [];
  }

  async recover() {
    if (this.isRecovering) {
      console.log("⏳ Recovery already in progress, waiting...");
      // Wait for ongoing recovery
      while (this.isRecovering) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return isSessionActive;
    }

    this.isRecovering = true;
    const recoveryStart = new Date();

    try {
      console.log("\n" + "=".repeat(60));
      console.log("  🔄 NATIONAL MASTER SESSION RECOVERY");
      console.log("=".repeat(60) + "\n");

      // Try to re-login on existing browser
      if (masterDriver) {
        try {
          console.log("   → Attempting re-login on existing browser...");
          await masterDriver.get(CONFIG.LOGIN_URL);
          await masterDriver.sleep(2000);

          const loginSuccess = await performNationalLogin(masterDriver);

          if (loginSuccess) {
            isSessionActive = true;
            sessionLastChecked = new Date();
            this.recoveryHistory.push({
              timestamp: recoveryStart,
              success: true,
              method: "re-login",
            });
            console.log("   ✓ Re-login successful");
            return true;
          }
        } catch (e) {
          console.log("   ✗ Re-login failed:", e.message);
        }
      }

      // If re-login failed, recreate browser
      console.log("   → Recreating browser instance...");
      if (masterDriver) {
        try {
          await masterDriver.quit();
        } catch (e) {}
      }

      masterDriver = await createMasterBrowser();
      await masterDriver.get(CONFIG.DASHBOARD_URL);
      await masterDriver.sleep(3000);

      const loginSuccess = await performNationalLogin(masterDriver);

      if (loginSuccess) {
        isSessionActive = true;
        sessionLastChecked = new Date();
        this.recoveryHistory.push({
          timestamp: recoveryStart,
          success: true,
          method: "recreate_browser",
        });
        console.log("   ✓ New browser created and logged in");
        return true;
      }

      this.recoveryHistory.push({
        timestamp: recoveryStart,
        success: false,
        method: "all_attempts_failed",
      });
      return false;
    } catch (error) {
      console.error("   ✗ Recovery failed:", error.message);
      this.recoveryHistory.push({
        timestamp: recoveryStart,
        success: false,
        error: error.message,
      });
      return false;
    } finally {
      this.isRecovering = false;
    }
  }

  getHistory() {
    return this.recoveryHistory;
  }
}

// Create recovery manager instance
const recoveryManager = new NationalMasterSessionRecovery();

// ============================================
// SESSION INITIALIZATION
// ============================================

/**
 * Initialize National master session - called once on server start
 * This creates the master browser and ensures user is logged in
 */
async function initializeNationalMasterSession() {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("  🔐 INITIALIZING NATIONAL MASTER SESSION");
    console.log("=".repeat(60) + "\n");

    // Step 1: Create master browser (this creates the base profile directory)
    console.log("📂 Creating National master browser with profile...");
    masterDriver = await createMasterBrowser();
    console.log("✅ National master browser created\n");

    // Step 2: Navigate to login page
    console.log("🌐 Navigating to National login page...");
    await masterDriver.get(CONFIG.LOGIN_URL);
    await masterDriver.sleep(3000);

    // Step 3: Check if already logged in
    console.log("🔍 Checking login status...");
    const loggedIn = await isNationalUserLoggedIn(masterDriver);

    if (loggedIn) {
      console.log("✅ Already logged in! Session is active.\n");
      isSessionActive = true;
      sessionLastChecked = new Date();
    } else {
      // Step 4: Perform login if needed
      console.log("⚠️  Not logged in. Starting login process...\n");
      const loginSuccess = await performNationalLogin(masterDriver);

      if (loginSuccess) {
        console.log("✅ Login successful! Session is now active.\n");
        isSessionActive = true;
        sessionLastChecked = new Date();
      } else {
        console.error("❌ Login failed!\n");
        isSessionActive = false;
        throw new Error("National login failed. Cannot proceed with job processing.");
      }
    }

    console.log("=".repeat(60));
    console.log("  ✅ NATIONAL MASTER SESSION READY");
    console.log("=".repeat(60) + "\n");

    return {
      success: true,
      isActive: isSessionActive,
      masterDriver: masterDriver,
    };
  } catch (error) {
    console.error("\n❌ Failed to initialize National master session:", error.message);
    isSessionActive = false;
    throw error;
  }
}

/**
 * Check if National session is still active
 * Should be called periodically or before processing jobs
 */
async function checkNationalSession() {
  try {
    if (!masterDriver) {
      console.log("⚠️  No National master driver found");
      return false;
    }

    console.log("🔍 Checking National session status...");
    const loggedIn = await isNationalUserLoggedIn(masterDriver);

    isSessionActive = loggedIn;
    sessionLastChecked = new Date();

    if (loggedIn) {
      console.log("✅ National session is active");
    } else {
      console.log("❌ National session expired or invalid");
    }

    return loggedIn;
  } catch (error) {
    console.error("❌ Error checking National session:", error.message);
    isSessionActive = false;
    return false;
  }
}

/**
 * Re-login if National session expired
 */
async function reLoginNationalIfNeeded() {
  try {
    const sessionValid = await checkNationalSession();

    if (!sessionValid) {
      console.log("🔄 National session invalid - initiating recovery...\n");

      const recovered = await recoveryManager.recover();

      if (recovered) {
        console.log("\n✅ National master session recovered successfully!");
        console.log("=".repeat(60) + "\n");
        return true;
      } else {
        console.error("\n❌ National master session recovery FAILED!");
        console.error("=".repeat(60) + "\n");
        return false;
      }
    }

    return true; // Session still valid
  } catch (error) {
    console.error("❌ Error in reLoginNationalIfNeeded:", error.message);
    return false;
  }
}

// ============================================
// JOB PROCESSING
// ============================================

/**
 * Create a cloned browser for a National job
 * This clones the master profile so the job has an independent browser with active session
 */
async function createNationalJobBrowser(jobId) {
  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📋 [National Job ${jobId}] CREATING CLONED BROWSER`);
    console.log(`${"=".repeat(60)}`);

    // Step 1: Ensure session is active
    console.log(`\n🔍 [National Job ${jobId}] STEP 1: Checking master session...`);
    const isStaleCheck =
      sessionLastChecked && Date.now() - sessionLastChecked.getTime() > 120000;

    console.log(`📊 [National Job ${jobId}] Session State:`, {
      isSessionActive,
      sessionLastChecked: sessionLastChecked ? sessionLastChecked.toISOString() : 'never',
      isStale: isStaleCheck,
      hasMasterDriver: !!masterDriver
    });

    if (!isSessionActive || isStaleCheck) {
      if (isStaleCheck) {
        console.log(
          `⏳ [National Job ${jobId}] Session check is stale, verifying current status...`
        );
      }

      console.log(`🔄 [National Job ${jobId}] Checking session validity...`);
      const sessionValid = await checkNationalSession();
      console.log(`📊 [National Job ${jobId}] Session check result: ${sessionValid}`);

      if (!sessionValid) {
        if (recoveryManager.isRecovering) {
          console.log(
            `⏳ [National Job ${jobId}] Another job is recovering National master session...`
          );
          console.log(
            `⏳ [National Job ${jobId}] Waiting for recovery to complete before cloning...`
          );
        } else {
          console.log(
            `⚠️  [National Job ${jobId}] National master session expired. Triggering recovery...`
          );
        }

        console.log(`🔄 [National Job ${jobId}] Initiating re-login...`);
        const recovered = await reLoginNationalIfNeeded();
        console.log(`📊 [National Job ${jobId}] Recovery result: ${recovered}`);

        if (!recovered) {
          throw new Error("National master session is not active and re-login failed");
        }

        console.log(`✅ [National Job ${jobId}] National master session recovered and active!`);
      } else {
        console.log(`✅ [National Job ${jobId}] National master session verified as active!`);
      }
    } else {
      console.log(
        `✅ [National Job ${jobId}] National master session is active (verified recently)`
      );
    }

    // Step 2: Clone master profile
    console.log(`\n📂 [National Job ${jobId}] STEP 2: Cloning master profile...`);
    console.log(`📊 [National Job ${jobId}] Master profile path: ${PATHS.MASTER_PROFILE}`);
    console.log(`📊 [National Job ${jobId}] Clone destination: ${PATHS.CLONED_PROFILE_BASE}`);
    
    const clonedProfileInfo = cloneChromeProfile(`national_job_${jobId}`);

    if (!clonedProfileInfo) {
      throw new Error("Failed to clone National profile - cloneChromeProfile returned null");
    }

    console.log(
      `✅ [National Job ${jobId}] National profile cloned successfully!`
    );
    console.log(`📊 [National Job ${jobId}] Clone details:`, {
      userDataDir: clonedProfileInfo.userDataDir,
      profileDirectory: clonedProfileInfo.profileDirectory,
      fullPath: clonedProfileInfo.fullPath
    });

    // Step 3: Create browser with cloned profile
    console.log(`\n🌐 [National Job ${jobId}] STEP 3: Creating browser instance...`);
    console.log(`⏳ [National Job ${jobId}] Calling createClonedBrowser...`);
    
    const clonedDriver = await createClonedBrowser(clonedProfileInfo);
    
    if (!clonedDriver) {
      throw new Error("createClonedBrowser returned null driver");
    }

    console.log(`✅ [National Job ${jobId}] Browser instance created successfully!`);
    console.log(`📊 [National Job ${jobId}] Driver session ID: ${await clonedDriver.getSession().then(s => s.getId()).catch(() => 'unknown')}`);

    const result = {
      driver: clonedDriver,
      profileInfo: clonedProfileInfo,
      jobId: jobId,
      usingPool: false,
    };

    console.log(`${"=".repeat(60)}`);
    console.log(`✅ [National Job ${jobId}] BROWSER CREATION COMPLETE`);
    console.log(`${"=".repeat(60)}\n`);

    return result;
  } catch (error) {
    console.error(`\n${"=".repeat(60)}`);
    console.error(`❌ [National Job ${jobId}] BROWSER CREATION FAILED`);
    console.error(`${"=".repeat(60)}`);
    console.error(
      `❌ [National Job ${jobId}] Error:`, error.message
    );
    console.error(`❌ [National Job ${jobId}] Stack:`, error.stack);
    console.error(`${"=".repeat(60)}\n`);
    throw error;
  }
}

/**
 * Cleanup National job browser and profile
 */
async function cleanupNationalJobBrowser(jobBrowserInfo) {
  try {
    const jobId = jobBrowserInfo.jobId;
    console.log(`\n🧹 [National Job ${jobId}] Cleaning up...`);

    // Close browser
    if (jobBrowserInfo.driver) {
      await jobBrowserInfo.driver.quit();
      console.log(`✅ [National Job ${jobId}] Browser closed`);
    }

    // Delete cloned profile
    if (
      jobBrowserInfo.profileInfo &&
      jobBrowserInfo.profileInfo.userDataDir
    ) {
      const profilePath = jobBrowserInfo.profileInfo.userDataDir;
      if (fs.existsSync(profilePath)) {
        deleteDirectoryRecursive(profilePath);
        console.log(
          `✅ [National Job ${jobId}] Cloned profile deleted: ${profilePath}`
        );
      }
    }

    console.log(`✅ [National Job ${jobId}] Cleanup complete\n`);
  } catch (error) {
    console.error(
      `⚠️  Error cleaning up National job ${jobBrowserInfo.jobId}:`,
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

  try {
    fs.rmdirSync(dirPath);
  } catch (e) {
    // Ignore errors
  }
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Initialization
  initializeNationalMasterSession,

  // Session management
  checkNationalSession,
  reLoginNationalIfNeeded,
  getNationalSessionStatus,

  // Job processing
  createNationalJobBrowser,
  cleanupNationalJobBrowser,

  // Recovery management
  get recoveryManager() {
    return recoveryManager;
  },

  // Direct access to state (read-only)
  get masterDriver() {
    return masterDriver;
  },
  get isSessionActive() {
    return isSessionActive;
  },
};

