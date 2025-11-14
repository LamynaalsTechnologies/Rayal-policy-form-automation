/**
 * National Session Manager - Manages master session and cloned profiles for National Insurance
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

/**
 * Get National session status
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
 * Multi-Level National Master Session Recovery
 */
class NationalMasterSessionRecovery {
  constructor() {
    this.recoveryAttempts = {
      soft: { count: 0, max: 3 },
      hard: { count: 0, max: 2 },
      nuclear: { count: 0, max: 1 },
    };

    this.lastRecoveryTime = null;
    this.recoveryHistory = [];
    this.isRecovering = false;
  }

  async attemptRecovery(level, recoveryFn) {
    const attempt = this.recoveryAttempts[level];
    
    if (attempt.count >= attempt.max) {
      console.log(`⚠️  [National Recovery] ${level} recovery max attempts (${attempt.max}) reached`);
      return false;
    }

    this.isRecovering = true;
    attempt.count++;
    this.lastRecoveryTime = new Date();

    console.log(`🔄 [National Recovery] Attempting ${level} recovery (${attempt.count}/${attempt.max})...`);

    try {
      const result = await recoveryFn();
      
      if (result) {
        console.log(`✅ [National Recovery] ${level} recovery successful!`);
        this.recoveryHistory.push({
          level,
          success: true,
          timestamp: this.lastRecoveryTime,
        });
        // Reset counters on success
        this.recoveryAttempts.soft.count = 0;
        this.recoveryAttempts.hard.count = 0;
        this.recoveryAttempts.nuclear.count = 0;
        this.isRecovering = false;
        return true;
      } else {
        throw new Error(`${level} recovery function returned false`);
      }
    } catch (error) {
      console.error(`❌ [National Recovery] ${level} recovery failed:`, error.message);
      this.recoveryHistory.push({
        level,
        success: false,
        error: error.message,
        timestamp: this.lastRecoveryTime,
      });
      this.isRecovering = false;
      return false;
    }
  }

  getHistory() {
    return {
      attempts: this.recoveryAttempts,
      lastRecoveryTime: this.lastRecoveryTime,
      recentHistory: this.recoveryHistory.slice(-10), // Last 10 attempts
    };
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

    // Step 2: Navigate to dashboard first to check if already logged in
    console.log("🌐 Navigating to National dashboard to check session...");
    await masterDriver.get(CONFIG.DASHBOARD_URL);
    await masterDriver.sleep(3000);

    // Step 3: Check if already logged in
    console.log("🔍 Checking login status...");
    const currentUrl = await masterDriver.getCurrentUrl();
    const loginElements = await masterDriver.findElements(
      require("selenium-webdriver").By.name("log_txtfield_iUsername_01")
    );
    const isOnLoginPage = loginElements.length > 0 || currentUrl.includes("/signin/login");
    const isOnHomePage = currentUrl.includes("/home/hcontent") || currentUrl.includes("/nicportal/home");
    
    if (!isOnLoginPage && isOnHomePage) {
      console.log("✅ Already logged in! Session is active, on home page.\n");
      isSessionActive = true;
      sessionLastChecked = new Date();
    } else {
      // Step 4: Navigate to login page and perform login
      console.log("⚠️  Not logged in. Navigating to login page...");
      await masterDriver.get(CONFIG.LOGIN_URL);
      await masterDriver.sleep(3000);
      
      console.log("⚠️  Starting login process...\n");
      const loginSuccess = await performNationalLogin(masterDriver);

      if (loginSuccess) {
        console.log("✅ Login successful! Session is now active.\n");
        
        // Verify we're on the home page after login
        await masterDriver.sleep(2000);
        const finalUrl = await masterDriver.getCurrentUrl();
        console.log(`🔍 Final URL after login: ${finalUrl}`);
        
        if (!finalUrl.includes("/home/hcontent") && !finalUrl.includes("/nicportal/home")) {
          console.log("⚠️  Not on expected home page, navigating to home...");
          await masterDriver.get(CONFIG.DASHBOARD_URL);
          await masterDriver.sleep(3000);
        }
        
        // Save cookies to ensure they're persisted
        const { saveCookies } = require("./nationalBrowserConfig");
        await saveCookies(masterDriver);
        
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
      console.log("⚠️  [National Session] No master driver available");
      return false;
    }

    const currentUrl = await masterDriver.getCurrentUrl();
    const loginElements = await masterDriver.findElements(
      require("selenium-webdriver").By.name("log_txtfield_iUsername_01")
    );

    const isOnLoginPage = loginElements.length > 0 || currentUrl.includes("/signin/login");
    const isActive = !isOnLoginPage;

    if (isActive) {
      isSessionActive = true;
      sessionLastChecked = new Date();
      console.log("✅ [National Session] Session is active");
    } else {
      isSessionActive = false;
      console.log("⚠️  [National Session] Session expired");
    }

    return isActive;
  } catch (error) {
    console.error("❌ [National Session] Error checking session:", error.message);
    isSessionActive = false;
    return false;
  }
}

/**
 * Re-login to National if session expired
 */
async function reLoginNationalIfNeeded() {
  try {
    if (!masterDriver) {
      console.error("❌ [National Recovery] No master driver available");
      return false;
    }

    // Try soft recovery first (re-login on existing browser)
    const softRecovery = await recoveryManager.attemptRecovery("soft", async () => {
      console.log("🔄 [National Recovery] Attempting soft recovery (re-login)...");
      await masterDriver.get(CONFIG.LOGIN_URL);
      await masterDriver.sleep(3000);
      return await performNationalLogin(masterDriver);
    });

    if (softRecovery) {
      isSessionActive = true;
      sessionLastChecked = new Date();
      return true;
    }

    // Try hard recovery (recreate browser)
    const hardRecovery = await recoveryManager.attemptRecovery("hard", async () => {
      console.log("🔄 [National Recovery] Attempting hard recovery (recreate browser)...");
      try {
        if (masterDriver) {
          await masterDriver.quit();
        }
      } catch (e) {
        // Ignore quit errors
      }

      masterDriver = await createMasterBrowser();
      await masterDriver.get(CONFIG.LOGIN_URL);
      await masterDriver.sleep(3000);
      return await performNationalLogin(masterDriver);
    });

    if (hardRecovery) {
      isSessionActive = true;
      sessionLastChecked = new Date();
      return true;
    }

    // Try nuclear recovery (delete profile and fresh start)
    const nuclearRecovery = await recoveryManager.attemptRecovery("nuclear", async () => {
      console.log("🔄 [National Recovery] Attempting nuclear recovery (fresh profile)...");
      try {
        if (masterDriver) {
          await masterDriver.quit();
        }
      } catch (e) {
        // Ignore quit errors
      }

      // Delete master profile
      if (fs.existsSync(PATHS.MASTER_PROFILE)) {
        fs.rmSync(PATHS.MASTER_PROFILE, { recursive: true, force: true });
        console.log("🗑️  [National Recovery] Deleted corrupted profile");
      }

      masterDriver = await createMasterBrowser();
      await masterDriver.get(CONFIG.LOGIN_URL);
      await masterDriver.sleep(3000);
      return await performNationalLogin(masterDriver);
    });

    if (nuclearRecovery) {
      isSessionActive = true;
      sessionLastChecked = new Date();
      return true;
    }

    console.error("❌ [National Recovery] All recovery attempts failed");
    return false;
  } catch (error) {
    console.error("❌ [National Recovery] Recovery error:", error.message);
    return false;
  }
}

// ============================================
// JOB PROCESSING
// ============================================

/**
 * Create a fresh browser for a National job
 * National uses a simple approach: each job gets a fresh browser and logs in
 */
async function createNationalJobBrowser(jobId) {
  try {
    console.log(`\n📋 [National Job ${jobId}] Creating fresh browser...`);

    // Create a fresh profile for this job (no cloning, no master session)
    const { createClonedProfileOptions, createClonedBrowser } = require("./nationalBrowserConfig");
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const { PATHS } = require("./nationalBrowserConfig");
    
    // Create a unique profile directory for this job
    const clonedUserDataDir = path.join(process.cwd(), "cloned_profiles_national", `national_job_${jobId}`);
    const clonedProfileDir = path.join(clonedUserDataDir, "Default");
    
    // Ensure directory exists
    if (!fs.existsSync(clonedProfileDir)) {
      fs.mkdirSync(clonedProfileDir, { recursive: true });
    }
    
    console.log(`📂 [National Job ${jobId}] Created fresh profile: ${clonedProfileDir}`);

    // Create browser with fresh profile
    console.log(`🌐 [National Job ${jobId}] Opening browser with fresh profile...`);
    const clonedDriver = await createClonedBrowser({
      userDataDir: clonedUserDataDir,
      profileDirectory: "Default",
      fullPath: clonedProfileDir,
    });

    console.log(`✅ [National Job ${jobId}] Fresh browser created successfully\n`);

    return {
      driver: clonedDriver,
      profileInfo: {
        userDataDir: clonedUserDataDir,
        profileDirectory: "Default",
        fullPath: clonedProfileDir,
      },
      jobId: jobId,
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
  initializeNationalMasterSession,
  checkNationalSession,
  reLoginNationalIfNeeded,
  createNationalJobBrowser,
  cleanupNationalJobBrowser,
  getNationalSessionStatus,
  recoveryManager,
};

