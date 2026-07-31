/**
 * Session Manager - Manages master session and cloned profiles for parallel jobs
 *
 * Architecture:
 * 1. Master Profile: Contains the logged-in session
 * 2. Cloned Profiles: Each job gets a clone of the master profile
 * 3. Session Check: Verifies login before processing jobs
 *
 * Enhanced Scenarios Handled:
 * - Scenario 1: Master session valid, clone session valid
 * - Scenario 2: Master session valid, clone session expired
 * - Scenario 3: Master session expired, needs recovery
 * - Scenario 4: Master browser crashed, needs recreation
 * - Scenario 5: Profile corrupted, needs fresh start
 * - Scenario 6: Multiple jobs with expired sessions (lock coordination)
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
const { ProviderCredential } = require("./models");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const {
  shouldKeepBrowserOpen,
  logRetainedBrowser,
} = require("./debugRetention");

// ============================================
// OPTIMIZATIONS
// ============================================

// The ProfilePoolManager was removed: it was constructed with the wrong
// baseProfileDir so initialize() ALWAYS threw, meaning every job silently fell
// back to plain profile cloning. It also created empty dirs under
// /dev/shm/chrome-profiles on each attempt, which nothing ever cleaned up, and
// held per-job state in module scope — a hazard now that jobs run in parallel.
// (profilePoolManager.js is left on disk but is no longer imported anywhere.)
const {
  getMinimalChromeOptions,
  getRamDiskPath,
} = require("./chromeOptimizedConfig");

// ============================================
// STATE MANAGEMENT
// ============================================

let masterDriver = null;
let isSessionActive = false;
let sessionLastChecked = null;
let optimizationsEnabled = false;
let currentLoggedInUserId = null;
let currentLoggedInClientId = null; // Track which userId is currently logged in

/**
 * Get session status
 */
function getSessionStatus() {
  return {
    isActive: isSessionActive,
    lastChecked: sessionLastChecked,
    hasMasterDriver: masterDriver !== null,
    recoveryHistory: recoveryManager ? recoveryManager.getHistory() : [],
  };
}

// ============================================
// MASTER SESSION RECOVERY MANAGER
// ============================================

/**
 * Multi-Level Master Session Recovery
 *
 * Handles session failures with progressive recovery strategies:
 * Level 1 (Soft): Re-login on existing browser (max 3 attempts)
 * Level 2 (Hard): Recreate browser instance (max 2 attempts)
 * Level 3 (Nuclear): Delete profile and fresh start (max 1 attempt)
 */
class MasterSessionRecovery {
  constructor() {
    this.recoveryAttempts = {
      soft: { count: 0, max: 6 },
      hard: { count: 0, max: 6 },
      nuclear: { count: 0, max: 1 },
    };

    this.lastRecoveryTime = null;
    this.recoveryHistory = [];

    // Recovery lock to prevent multiple simultaneous recoveries
    this.isRecovering = false;
    this.recoveryPromise = null;
  }

  /**
   * Main recovery orchestrator - tries all levels progressively
   * Includes lock to prevent multiple simultaneous recoveries
   */
  async recover() {
    // If recovery is already in progress, wait for it to complete
    if (this.isRecovering && this.recoveryPromise) {
      console.log("⏳ Recovery already in progress, waiting for completion...");
      try {
        const result = await this.recoveryPromise;
        console.log(`✅ Joined existing recovery, result: ${result}`);
        return result;
      } catch (error) {
        console.error("❌ Existing recovery failed:", error.message);
        return false;
      }
    }

    // Set recovery lock and create promise
    this.isRecovering = true;
    this.recoveryPromise = this._performRecovery();

    try {
      const result = await this.recoveryPromise;
      return result;
    } finally {
      // Release lock
      this.isRecovering = false;
      this.recoveryPromise = null;
    }
  }

  /**
   * Internal recovery method - performs actual recovery steps
   */
  async _performRecovery() {
    try {
      console.log("\n" + "=".repeat(60));
      console.log("  🔄 MASTER SESSION RECOVERY INITIATED");
      console.log("=".repeat(60) + "\n");

      // Level 1: Soft Recovery
      if (this.recoveryAttempts.soft.count < this.recoveryAttempts.soft.max) {
        console.log(
          `🔧 LEVEL 1: Soft Recovery (attempt ${this.recoveryAttempts.soft.count + 1
          }/${this.recoveryAttempts.soft.max})`
        );

        const softSuccess = await this.softRecover();

        if (softSuccess) {
          console.log("✅ LEVEL 1: Soft recovery SUCCESSFUL!\n");
          this.resetRecoveryAttempts();
          return true;
        }

        this.recoveryAttempts.soft.count++;
        console.log("❌ LEVEL 1: Soft recovery failed\n");
      }

      // Level 2: Hard Recovery
      if (this.recoveryAttempts.hard.count < this.recoveryAttempts.hard.max) {
        console.log(
          `🔨 LEVEL 2: Hard Recovery (attempt ${this.recoveryAttempts.hard.count + 1
          }/${this.recoveryAttempts.hard.max})`
        );

        const hardSuccess = await this.hardRecover();

        if (hardSuccess) {
          console.log("✅ LEVEL 2: Hard recovery SUCCESSFUL!\n");
          this.resetRecoveryAttempts();
          return true;
        }

        this.recoveryAttempts.hard.count++;
        console.log("❌ LEVEL 2: Hard recovery failed\n");
      }

      // Level 3: Nuclear Recovery
      if (
        this.recoveryAttempts.nuclear.count < this.recoveryAttempts.nuclear.max
      ) {
        console.log(
          `☢️  LEVEL 3: Nuclear Recovery (attempt ${this.recoveryAttempts.nuclear.count + 1
          }/${this.recoveryAttempts.nuclear.max})`
        );

        const nuclearSuccess = await this.nuclearRecover();

        if (nuclearSuccess) {
          console.log("✅ LEVEL 3: Nuclear recovery SUCCESSFUL!\n");
          this.resetRecoveryAttempts();
          return true;
        }

        this.recoveryAttempts.nuclear.count++;
        console.log("❌ LEVEL 3: Nuclear recovery failed\n");
      }

      // All recovery attempts exhausted
      console.error("\n" + "=".repeat(60));
      console.error("  💥 CRITICAL: ALL RECOVERY ATTEMPTS EXHAUSTED");
      console.error("=".repeat(60));
      console.error("🚨 Manual intervention required!");
      console.error(
        "📊 Recovery history:",
        JSON.stringify(this.recoveryHistory, null, 2)
      );
      console.error("=".repeat(60) + "\n");

      this.sendCriticalAlert();

      return false;
    } catch (error) {
      console.error("❌ Recovery process error:", error.message);
      return false;
    }
  }

  /**
   * Level 1: Soft Recovery - Re-login on same browser
   */
  async softRecover() {
    try {
      console.log("   → Checking if master browser is responsive...");

      if (!masterDriver) {
        console.log("   ✗ No master driver exists");
        this.recordRecovery("soft", false, "No driver");
        return false;
      }

      // Health check
      try {
        await masterDriver.getCurrentUrl();
        console.log("   ✓ Master browser is responsive");
      } catch (error) {
        console.log("   ✗ Master browser is unresponsive:", error.message);
        this.recordRecovery("soft", false, "Browser unresponsive");
        return false;
      }

      console.log("   → Navigating to dashboard...");
      await masterDriver.get(CONFIG.DASHBOARD_URL);
      await masterDriver.sleep(2000);

      console.log("   → Attempting re-login...");
      const loginSuccess = await performLogin(masterDriver);

      if (loginSuccess) {
        console.log("   ✓ Re-login successful");
        isSessionActive = true;
        sessionLastChecked = new Date();
        this.recordRecovery("soft", true, "Re-login successful");
        return true;
      }

      console.log("   ✗ Re-login failed");
      const currentUrl = await masterDriver.getCurrentUrl();
      console.log(`   📄 Current URL after failed re-login: ${currentUrl}`);
      this.recordRecovery("soft", false, `Login failed. URL: ${currentUrl}`);
      return false;
    } catch (error) {
      console.log(`   ✗ Soft recovery error: ${error.message}`);
      this.recordRecovery("soft", false, error.message);
      return false;
    }
  }

  /**
   * Level 2: Hard Recovery - Recreate master browser
   */
  async hardRecover() {
    try {
      console.log("   → Closing broken master browser...");

      if (masterDriver) {
        try {
          await masterDriver.quit();
          console.log("   ✓ Broken browser closed");
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          console.log("   ⚠️  Error closing browser (may already be dead)");
        }
      }

      masterDriver = null;
      isSessionActive = false;

      console.log("   → Creating new master browser...");
      masterDriver = await createMasterBrowser();
      console.log("   ✓ New master browser created");

      console.log("   → Navigating to dashboard...");
      await masterDriver.get(CONFIG.DASHBOARD_URL);
      await masterDriver.sleep(3000);

      console.log("   → Attempting login on new browser...");
      const loginSuccess = await performLogin(masterDriver);

      if (loginSuccess) {
        console.log("   ✓ Login successful on new browser");
        isSessionActive = true;
        sessionLastChecked = new Date();
        this.recordRecovery("hard", true, "New browser login successful");
        return true;
      }

      console.log("   ✗ Login failed on new browser");
      this.recordRecovery("hard", false, "Login failed on new browser");
      return false;
    } catch (error) {
      console.log(`   ✗ Hard recovery error: ${error.message}`);
      this.recordRecovery("hard", false, error.message);
      return false;
    }
  }

  /**
   * Level 3: Nuclear Recovery - Delete profile and fresh start
   */
  async nuclearRecover() {
    try {
      console.log(
        "   ⚠️  WARNING: This will delete and recreate the master profile!"
      );

      console.log("   → Backing up current profile...");
      const backupPath = await this.backupProfile();
      if (backupPath) {
        console.log(`   ✓ Profile backed up to: ${backupPath}`);
      }

      console.log("   → Closing master browser...");
      if (masterDriver) {
        try {
          await masterDriver.quit();
          await new Promise((resolve) => setTimeout(resolve, 3000));
        } catch (error) {
          console.log("   ⚠️  Error closing browser");
        }
      }

      masterDriver = null;
      isSessionActive = false;

      console.log("   → Deleting corrupted profile...");
      if (fs.existsSync(PATHS.MASTER_PROFILE)) {
        deleteDirectoryRecursive(PATHS.MASTER_PROFILE);
        console.log("   ✓ Profile deleted");
      }

      console.log("   → Creating fresh profile directory...");
      fs.mkdirSync(PATHS.MASTER_PROFILE, { recursive: true });
      console.log("   ✓ Fresh profile directory created");

      console.log("   → Creating new master browser with fresh profile...");
      masterDriver = await createMasterBrowser();
      console.log("   ✓ New master browser created");

      console.log("   → Navigating to dashboard...");
      await masterDriver.get(CONFIG.DASHBOARD_URL);
      await masterDriver.sleep(3000);

      console.log("   → Attempting login on fresh profile...");
      const loginSuccess = await performLogin(masterDriver);

      if (loginSuccess) {
        console.log("   ✓ Login successful on fresh profile!");
        isSessionActive = true;
        sessionLastChecked = new Date();
        this.recordRecovery("nuclear", true, "Fresh profile login successful");
        return true;
      }

      console.log("   ✗ Login failed even on fresh profile");
      console.log(
        "   ⚠️  This indicates a fundamental problem (credentials/network/portal)"
      );

      // Restore backup if available
      if (backupPath && fs.existsSync(backupPath)) {
        console.log("   → Restoring backup profile...");
        await this.restoreProfile(backupPath);
      }

      this.recordRecovery("nuclear", false, "Login failed on fresh profile");
      return false;
    } catch (error) {
      console.log(`   ✗ Nuclear recovery error: ${error.message}`);
      this.recordRecovery("nuclear", false, error.message);
      return false;
    }
  }

  /**
   * Backup master profile directory
   */
  async backupProfile() {
    try {
      const timestamp = Date.now();
      const backupPath = path.join(
        PATHS.BASE_PROFILE,
        `Demo_backup_${timestamp}`
      );

      if (fs.existsSync(PATHS.MASTER_PROFILE)) {
        copyDirectoryRecursive(PATHS.MASTER_PROFILE, backupPath);
        return backupPath;
      }

      return null;
    } catch (error) {
      console.error("   ✗ Backup failed:", error.message);
      return null;
    }
  }

  /**
   * Restore profile from backup
   */
  async restoreProfile(backupPath) {
    try {
      if (fs.existsSync(PATHS.MASTER_PROFILE)) {
        deleteDirectoryRecursive(PATHS.MASTER_PROFILE);
      }

      copyDirectoryRecursive(backupPath, PATHS.MASTER_PROFILE);
      console.log("   ✓ Profile restored from backup");
    } catch (error) {
      console.error("   ✗ Restore failed:", error.message);
    }
  }

  /**
   * Record recovery attempt in history
   */
  recordRecovery(level, success, reason) {
    this.recoveryHistory.push({
      level,
      success,
      reason,
      timestamp: new Date(),
    });

    this.lastRecoveryTime = new Date();

    // Keep only last 50 recovery attempts
    if (this.recoveryHistory.length > 50) {
      this.recoveryHistory = this.recoveryHistory.slice(-50);
    }
  }

  /**
   * Reset recovery attempt counters after successful recovery
   */
  resetRecoveryAttempts() {
    this.recoveryAttempts.soft.count = 0;
    this.recoveryAttempts.hard.count = 0;
    this.recoveryAttempts.nuclear.count = 0;
  }

  /**
   * Get recovery history
   */
  getHistory() {
    return {
      attempts: this.recoveryAttempts,
      lastRecoveryTime: this.lastRecoveryTime,
      recentHistory: this.recoveryHistory.slice(-10),
    };
  }

  /**
   * Send critical failure alert
   */
  sendCriticalAlert() {
    // TODO: Implement alerting (email, Slack, SMS, etc.)
    console.error("\n🚨 CRITICAL ALERT TRIGGERED 🚨");
    console.error("Master session recovery failed completely!");
    console.error(
      "Recent recovery attempts:",
      JSON.stringify(this.recoveryHistory.slice(-5), null, 2)
    );
    console.error("\n");
  }
}

/**
 * Copy directory recursively
 */
function copyDirectoryRecursive(source, destination) {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(destination, { recursive: true });
  }

  const files = fs.readdirSync(source);

  files.forEach((file) => {
    const sourcePath = path.join(source, file);
    const destPath = path.join(destination, file);

    if (fs.statSync(sourcePath).isDirectory()) {
      copyDirectoryRecursive(sourcePath, destPath);
    } else {
      fs.copyFileSync(sourcePath, destPath);
    }
  });
}

// Create recovery manager instance
const recoveryManager = new MasterSessionRecovery();

// ============================================
// SESSION INITIALIZATION
// ============================================

let isInitializing = false;
let initializationPromise = null;

/**
 * Initialize master session - called once on server start
 * This creates the master browser and ensures user is logged in
 */
async function initializeMasterSession(policyId = null) {
  if (isInitializing && initializationPromise) {
    console.log("⏳ Initialization already in progress, waiting for existing promise...");
    return initializationPromise;
  }

  isInitializing = true;
  initializationPromise = _performInitialization(policyId);

  try {
    return await initializationPromise;
  } finally {
    isInitializing = false;
    initializationPromise = null;
  }
}

/**
 * Internal initialization logic
 */
async function _performInitialization(policyId = null) {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("  🔐 INITIALIZING MASTER SESSION");
    console.log("=".repeat(60) + "\n");

    // Connect to MongoDB if not already connected
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log("✓ Connected to MongoDB");
    }

    // Fetch credentials from DB
    let creds = null;

    if (policyId) {
      console.log(`→ Fetching policy data for ID: ${policyId}...`);
      const policy = await mongoose.connection.db
        .collection("onlinePolicy")
        .findOne({ _id: new mongoose.Types.ObjectId(policyId) });

      if (policy && policy.clientId) {
        console.log(
          `→ Policy found with clientId: ${policy.clientId}. Fetching credentials...`
        );
        creds = await ProviderCredential.findOne({
          clientId: policy.clientId,
          provider: "reliance",
          isActive: true,
        });

        if (creds) {
          console.log(
            `✓ Found credentials for clientId: ${policy.clientId} (username: ${creds.username})`
          );
        } else {
          console.log(
            `⚠ No credentials found for clientId: ${policy.clientId}. Falling back to default credentials.`
          );
        }
      } else {
        console.log(
          "⚠ Policy not found or has no clientId. Falling back to default credentials."
        );
      }
    }

    if (!creds) {
      console.log("→ Fetching default Reliance credentials from database...");
      creds = await ProviderCredential.findOne({
        provider: "reliance",
        isActive: true,
      });
    }

    if (!creds) {
      throw new Error(
        "No active Reliance credentials found in the database. Please check the ProviderCredential collection."
      );
    }

    console.log(`✓ Using credentials for: ${creds.username}`);
    CONFIG.USERNAME = creds.username;
    CONFIG.PASSWORD = creds.password;
    if (creds.loginUrl) CONFIG.LOGIN_URL = creds.loginUrl;
    if (creds.dashboardUrl) CONFIG.DASHBOARD_URL = creds.dashboardUrl;

    // Step 1: Create master browser (this creates the base profile directory)
    masterDriver = await createMasterBrowser();
    console.log("✅ Master browser created\n");


    // Step 2: Navigate to dashboard
    console.log("🌐 Navigating to dashboard...");
    await masterDriver.get(CONFIG.DASHBOARD_URL);

    // Step 3: Check if already logged in
    // console.log("🔐 Performing login check...");
    const loggedIn = await isUserLoggedIn(masterDriver);

    if (loggedIn) {
      console.log("✅ Already logged in! Session is active.\n");
      isSessionActive = true;
      sessionLastChecked = new Date();
      currentLoggedInClientId = creds.clientId || null;
      currentLoggedInUserId = creds.userId || null; // Track which userId is logged in
    } else {
      // Step 4: Perform login if needed
      console.log("⚠️  Not logged in. Starting login process...\n");
      const loginSuccess = await performLogin(masterDriver);

      if (loginSuccess) {
        console.log("✅ Login successful! Session is now active.\n");
        isSessionActive = true;
        sessionLastChecked = new Date();
        currentLoggedInClientId = creds.clientId || null;
        currentLoggedInUserId = creds.userId || null; // Track which userId is logged in
      } else {
        console.error("❌ Login failed!\n");
        isSessionActive = false;
        throw new Error("Login failed. Cannot proceed with job processing.");
      }
    }

    // Step 6: Register session with health manager (DISABLED as per user request)
    // console.log("💓 Registering session with health monitor...");
    // sessionHealthManager.registerSession(
    //   "master_session",
    //   masterDriver,
    //   CONFIG.CREDENTIALS
    // );
    // console.log("✅ Session health monitoring active\n");

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
 * Uses multi-level recovery manager for robust session restoration
 */
async function reLoginIfNeeded() {
  try {
    // Lazy initialization if master session hasn't been started
    if (!masterDriver) {
      console.log("🚀 Initializing master session on-demand...");
      const initResult = await initializeMasterSession();
      return initResult.success;
    }

    const sessionValid = await checkSession();

    if (!sessionValid) {
      console.log("🔄 Session invalid - initiating multi-level recovery...\n");

      // Use multi-level recovery instead of simple re-login
      const recovered = await recoveryManager.recover();

      if (recovered) {
        console.log("\n✅ Master session recovered successfully!");
        console.log("=".repeat(60) + "\n");
        return true;
      } else {
        console.error("\n❌ Master session recovery FAILED!");
        console.error("⚠️  All recovery attempts exhausted");
        console.error("=".repeat(60) + "\n");
        return false;
      }
    }

    return true; // Session still valid
  } catch (error) {
    console.error("❌ Error in reLoginIfNeeded:", error.message);
    return false;
  }
}

/**
 * Switch master session to use different credentials
 * This is called when a job requires different credentials than currently logged in
 * @param {string} userId - The userId to switch to
 * @param {string} client - The clientId to switch to
 * @returns {Promise<boolean>} - True if switch successful
 */
async function switchMasterSessionCredentials(clientId) {
  try {
    console.log(`\\n${'='.repeat(60)}`);
    console.log(`  🔄 SWITCHING MASTER SESSION CREDENTIALS`);
    console.log(`${'='.repeat(60)}\\n`);

    console.log(`→ Current logged-in clientId: ${currentLoggedInClientId || 'default'}`);
    console.log(`→ Requested clientId: ${clientId || 'default'}\\n`);

    // Fetch credentials for the requested clientId
    let creds = null;

    if (clientId) {
      console.log(`→ Fetching credentials for clientId: ${clientId}...`);
      creds = await ProviderCredential.findOne({
        clientId: clientId,
        provider: "reliance",
        isActive: true,
      });

      if (creds) {
        console.log(`✓ Found credentials for clientId: ${clientId} (username: ${creds.username})`);
      } else {
        console.log(`⚠ No credentials found for clientId: ${clientId}. Using default credentials.`);
      }
    }

    if (!creds) {
      console.log("→ Fetching default Reliance credentials from database...");
      creds = await ProviderCredential.findOne({
        provider: "reliance",
        isActive: true,
      });
    }

    if (!creds) {
      throw new Error(
        "No active Reliance credentials found in the database. Please check the ProviderCredential collection."
      );
    }

    console.log(`✓ Using credentials for: ${creds.username}`);

    // Update CONFIG with new credentials
    CONFIG.USERNAME = creds.username;
    CONFIG.PASSWORD = creds.password;
    if (creds.loginUrl) CONFIG.LOGIN_URL = creds.loginUrl;
    if (creds.dashboardUrl) CONFIG.DASHBOARD_URL = creds.dashboardUrl;

    // Check if master driver exists
    if (!masterDriver) {
      console.log("⚠️  No master driver exists. Creating new master session...");
      await initializeMasterSession();
      return true;
    }

    // Navigate to dashboard
    console.log("🌐 Navigating to dashboard...");
    await masterDriver.get(CONFIG.DASHBOARD_URL);
    await masterDriver.sleep(3000);

    // Perform re-login with new credentials
    console.log("🔐 Performing re-login with new credentials...");
    const loginSuccess = await performLogin(masterDriver);

    if (loginSuccess) {
      console.log("✅ Re-login successful with new credentials!\\n");
      isSessionActive = true;
      sessionLastChecked = new Date();
      currentLoggedInClientId = creds.clientId || null;
      currentLoggedInUserId = creds.userId || null;

      console.log(`${'='.repeat(60)}`);
      console.log(`  ✅ CREDENTIALS SWITCHED SUCCESSFULLY`);
      console.log(`${'='.repeat(60)}\\n`);

      return true;
    } else {
      console.error("❌ Re-login failed with new credentials!\\n");
      isSessionActive = false;
      throw new Error("Failed to switch credentials. Re-login failed.");
    }
  } catch (error) {
    console.error("\\n❌ Failed to switch credentials:", error.message);
    isSessionActive = false;
    throw error;
  }
}

// ============================================
// JOB PROCESSING
// ============================================

/**
 * Create a cloned browser for a job
 * This clones the master profile so the job has an independent browser with active session
 * Enhanced with stale flag detection and recovery lock coordination
 * @param {string} jobId - Job identifier
 * @param {string} userId - User ID for credential lookup (optional)
 * @param {string} clientId - Client ID for credential lookup (optional)
 */
async function createJobBrowser(jobId, clientId = null) {
  try {
    console.log(`\\n📋 [Job ${jobId}] Creating cloned browser...`);

    // Step 0: Check if we need to switch credentials for this user
    // if (userId && userId !== currentLoggedInUserId) {
    //   console.log(`\\n🔄 [Job ${jobId}] Different userId detected!`);
    //   console.log(`   Current: ${currentLoggedInUserId || 'default'}`);
    //   console.log(`   Required: ${userId}`);
    //   console.log(`   → Switching master session credentials...\\n`);

    //   await switchMasterSessionCredentials(userId);

    //   console.log(`✅ [Job ${jobId}] Master session now using credentials for userId: ${userId}\\n`);
    // } else if (userId) {
    //   console.log(`✅ [Job ${jobId}] Master session already using correct credentials for userId: ${userId}`);
    // } else {
    //   console.log(`ℹ️  [Job ${jobId}] No userId provided, using current session credentials`);
    // }

    if (clientId && clientId !== currentLoggedInClientId) {
      console.log(`\\n🔄 [Job ${jobId}] Different clientId detected!`);
      console.log(`   Current: ${currentLoggedInClientId || 'default'}`);
      console.log(`   Required: ${clientId}`);
      console.log(`   → Switching master session credentials...\\n`);

      await switchMasterSessionCredentials(clientId);

      console.log(`✅ [Job ${jobId}] Master session now using credentials for clientId: ${clientId}\\n`);
    } else if (clientId) {
      console.log(`✅ [Job ${jobId}] Master session already using correct credentials for clientId: ${clientId}`);
    } else {
      console.log(`ℹ️  [Job ${jobId}] No clientId provided, using current session credentials`);
    }

    // Step 1: Ensure session is active (with proactive check to catch stale flags)
    // Check if flag is stale (last check > 2 minutes ago)
    const isStaleCheck =
      sessionLastChecked && Date.now() - sessionLastChecked.getTime() > 120000;

    if (!isSessionActive || isStaleCheck) {
      if (isStaleCheck) {
        console.log(
          `⏳ [Job ${jobId}] Session check is stale, verifying current status...`
        );
      }

      // Quick session verification before recovery
      const sessionValid = await checkSession();

      if (!sessionValid) {
        // Session is expired, need recovery
        // Check if another job is already recovering
        if (recoveryManager.isRecovering) {
          console.log(
            `⏳ [Job ${jobId}] Another job is recovering master session...`
          );
          console.log(
            `⏳ [Job ${jobId}] Waiting for recovery to complete before cloning...`
          );
        } else {
          console.log(
            `⚠️  [Job ${jobId}] Master session expired. Triggering recovery...`
          );
        }

        // This will either start recovery or wait for ongoing recovery
        const recovered = await reLoginIfNeeded();

        if (!recovered) {
          throw new Error("Master session is not active and re-login failed");
        }

        console.log(`✅ [Job ${jobId}] Master session recovered and active!`);
      } else {
        console.log(`✅ [Job ${jobId}] Master session verified as active!`);
      }
    } else {
      console.log(
        `✅ [Job ${jobId}] Master session is active (verified recently)`
      );
    }

    // Step 2: Acquire profile from pool (OPTIMIZED!)
    // (The old profile-pool branch is removed: its init always failed — wrong
    // baseProfileDir — so it never ran, yet held shared state and littered
    // /dev/shm on every boot.)
    console.log(`📂 [Job ${jobId}] Cloning master profile...`);
    const clonedProfileInfo = cloneChromeProfile(`job_${jobId}`);

    if (!clonedProfileInfo) {
      throw new Error("Failed to clone profile");
    }

    console.log(
      `✅ [Job ${jobId}] Profile cloned: ${clonedProfileInfo.fullPath}`
    );

    // Per-JOB download directory so parallel jobs can never pick up each
    // other's policy PDFs (read back in relianceForm via profileInfo).
    clonedProfileInfo.downloadDir = path.join(
      __dirname,
      "reliance_pdf",
      `job_${jobId}`
    );

    // Step 3: Create browser with cloned profile. If THIS throws, delete the
    // clone we just made — the caller's finally can't do it (jobBrowser was
    // never assigned), which is exactly how profiles used to leak.
    console.log(`🌐 [Job ${jobId}] Opening browser with cloned profile...`);
    let clonedDriver;
    try {
      clonedDriver = await createClonedBrowser(clonedProfileInfo);
    } catch (driverError) {
      try {
        if (clonedProfileInfo.userDataDir && fs.existsSync(clonedProfileInfo.userDataDir)) {
          fs.rmSync(clonedProfileInfo.userDataDir, { recursive: true, force: true });
          console.log(`🧹 [Job ${jobId}] Removed cloned profile after driver failure`);
        }
        if (fs.existsSync(clonedProfileInfo.downloadDir)) {
          fs.rmSync(clonedProfileInfo.downloadDir, { recursive: true, force: true });
        }
      } catch (rmError) {
        console.warn(`⚠️  [Job ${jobId}] Could not remove failed clone: ${rmError.message}`);
      }
      throw driverError;
    }

    console.log(`✅ [Job ${jobId}] Cloned browser created successfully\n`);

    return {
      driver: clonedDriver,
      profileInfo: clonedProfileInfo,
      jobId: jobId,
      usingPool: false,
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
async function cleanupJobBrowser(jobBrowserInfo, { hadError = false } = {}) {
  try {
    const jobId = jobBrowserInfo.jobId;

    // Testing aid: leave a FAILED job's browser open so the page can be looked
    // at. The profile is kept too — deleting it out from under a live Chrome
    // would break the very window we are trying to preserve.
    if (shouldKeepBrowserOpen(hadError)) {
      logRetainedBrowser(
        `Job ${jobId}`,
        jobBrowserInfo.profileInfo && jobBrowserInfo.profileInfo.userDataDir
      );
      return;
    }

    console.log(`\n🧹 [Job ${jobId}] Cleaning up...`);

    // Close browser. Isolated try/catch on purpose: if quit() throws (browser
    // already dead, session lost), the profile deletion below MUST still run.
    // Without this the cloned profile was orphaned on disk every time a job
    // crashed hard — each one is several MB.
    if (jobBrowserInfo.driver) {
      try {
        await jobBrowserInfo.driver.quit();
        console.log(`✅ [Job ${jobId}] Browser closed`);
      } catch (quitError) {
        console.warn(
          `⚠️  [Job ${jobId}] Error closing browser (continuing to profile cleanup):`,
          quitError.message
        );
      }
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
          `✅ [Job ${jobId}] Cloned profile deleted: ${profilePath}`
        );
      }
    }

    // Delete this job's private download directory (its PDF has already been
    // merged + uploaded to S3 by the time cleanup runs).
    if (
      jobBrowserInfo.profileInfo &&
      jobBrowserInfo.profileInfo.downloadDir &&
      fs.existsSync(jobBrowserInfo.profileInfo.downloadDir)
    ) {
      try {
        fs.rmSync(jobBrowserInfo.profileInfo.downloadDir, { recursive: true, force: true });
        console.log(`✅ [Job ${jobId}] Download dir deleted: ${jobBrowserInfo.profileInfo.downloadDir}`);
      } catch (dlErr) {
        console.warn(`⚠️  [Job ${jobId}] Could not delete download dir: ${dlErr.message}`);
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

/**
 * Get optimization statistics
 */
function getOptimizationStats() {
  // Pool + health managers are gone; kept as a stable shape for any caller.
  // (This used to throw ReferenceError: sessionHealthManager is not defined.)
  return {
    optimizationsEnabled: false,
    profilePool: null,
    sessionHealth: null,
    ramDiskEnabled: false,
  };
}

module.exports = {
  // Initialization
  initializeMasterSession,

  // Session management
  checkSession,
  reLoginIfNeeded,
  getSessionStatus,
  switchMasterSessionCredentials,

  // Job processing
  createJobBrowser,
  cleanupJobBrowser,

  // Optimization stats
  getOptimizationStats,

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

  // Export internal browser functions for direct use.
  // performLogin passes options through so job code can supply per-job
  // credentials + a unique captcha tag (required for parallel windows).
  isUserLoggedIn: async (driver) => isUserLoggedIn(driver),
  performLogin: async (driver, options) => performLogin(driver, options),
};
