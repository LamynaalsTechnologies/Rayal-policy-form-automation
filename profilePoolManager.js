/**
 * Profile Pool Manager
 * Manages a pool of pre-cloned profiles for instant job execution
 * Implements profile recycling and smart resource management
 */

const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");

class ProfilePoolManager extends EventEmitter {
  constructor(config = {}) {
    super();

    // Configuration
    this.baseProfileDir =
      config.baseProfileDir || path.join(__dirname, "chrome-profile");
    this.poolDir = config.poolDir || path.join(__dirname, "profile-pool");
    this.ramDiskPath = config.useRamDisk
      ? "/dev/shm/chrome-profiles"
      : this.poolDir;
    this.poolSize = config.poolSize || 5; // Number of ready profiles
    this.maxProfileUses = config.maxProfileUses || 10; // Recycle after N uses
    this.maxProfileLifetime = config.maxProfileLifetime || 30 * 60 * 1000; // 30 minutes

    // Pool state
    this.readyPool = []; // Available profiles
    this.activePool = new Map(); // In-use profiles: jobId -> profile
    this.profileStats = new Map(); // Profile usage stats

    // Flags
    this.isInitialized = false;
    this.isShuttingDown = false;

    console.log("📦 ProfilePoolManager initialized");
    console.log(`   Pool directory: ${this.ramDiskPath}`);
    console.log(`   Pool size: ${this.poolSize}`);
    console.log(`   RAM disk: ${config.useRamDisk ? "✅" : "❌"}`);
  }

  /**
   * Initialize the profile pool
   */
  async initialize() {
    if (this.isInitialized) {
      console.log("⚠️  Profile pool already initialized");
      return;
    }

    try {
      console.log("\n🚀 Initializing Profile Pool...");

      // Create pool directory
      await this.ensureDirectory(this.ramDiskPath);

      // Pre-populate the pool
      console.log(`📦 Pre-populating pool with ${this.poolSize} profiles...`);
      const promises = [];
      for (let i = 0; i < this.poolSize; i++) {
        promises.push(this.createAndAddProfile());
      }
      await Promise.all(promises);

      // Start background worker
      this.startBackgroundWorker();

      this.isInitialized = true;
      console.log(
        `✅ Profile pool initialized with ${this.readyPool.length} profiles\n`
      );

      this.emit("initialized");
    } catch (error) {
      console.error("❌ Failed to initialize profile pool:", error.message);
      throw error;
    }
  }

  /**
   * Acquire a profile from the pool
   */
  async acquireProfile(jobId) {
    if (!this.isInitialized) {
      throw new Error("Profile pool not initialized");
    }

    console.log(`🔍 [${jobId}] Acquiring profile from pool...`);

    // Wait for profile if pool is empty
    let profile = this.readyPool.shift();

    if (!profile) {
      console.log(`⏳ [${jobId}] Pool empty, creating profile on-demand...`);
      profile = await this.createProfile();
    }

    // Mark as active
    profile.jobId = jobId;
    profile.acquiredAt = Date.now();
    this.activePool.set(jobId, profile);

    // Update stats
    this.updateProfileStats(profile.id, "acquired");

    console.log(`✅ [${jobId}] Profile acquired: ${profile.id}`);
    console.log(
      `   Ready: ${this.readyPool.length} | Active: ${this.activePool.size}`
    );

    this.emit("profileAcquired", { jobId, profileId: profile.id });

    return profile;
  }

  /**
   * Release a profile back to the pool
   */
  async releaseProfile(jobId, options = {}) {
    const profile = this.activePool.get(jobId);

    if (!profile) {
      console.warn(`⚠️  [${jobId}] Profile not found in active pool`);
      return;
    }

    console.log(`🔄 [${jobId}] Releasing profile: ${profile.id}`);

    // Remove from active pool
    this.activePool.delete(jobId);

    // Update stats
    this.updateProfileStats(profile.id, "released");

    const stats = this.profileStats.get(profile.id);
    const shouldRecycle = this.shouldRecycleProfile(profile, stats);

    if (shouldRecycle.shouldRecycle) {
      console.log(
        `♻️  [${jobId}] Profile ${profile.id} needs recycling: ${shouldRecycle.reason}`
      );
      await this.recycleProfile(profile);
    } else if (options.clean !== false) {
      console.log(`🧹 [${jobId}] Cleaning profile: ${profile.id}`);
      await this.cleanProfile(profile);

      // Add back to ready pool
      this.readyPool.push(profile);
      console.log(`✅ [${jobId}] Profile returned to ready pool`);
    } else {
      // Add back without cleaning (for testing)
      this.readyPool.push(profile);
    }

    console.log(
      `   Ready: ${this.readyPool.length} | Active: ${this.activePool.size}`
    );

    this.emit("profileReleased", { jobId, profileId: profile.id });
  }

  /**
   * Create a new profile
   */
  async createProfile() {
    const profileId = `profile-${Date.now()}-${Math.random()
      .toString(36)
      .substr(2, 9)}`;
    const profilePath = path.join(this.ramDiskPath, profileId);

    console.log(`🔨 Creating profile: ${profileId}`);

    try {
      // Clone from base profile
      await this.copyDirectory(this.baseProfileDir, profilePath);

      const profile = {
        id: profileId,
        path: profilePath,
        createdAt: Date.now(),
        lastUsed: null,
        uses: 0,
      };

      // Initialize stats
      this.profileStats.set(profileId, {
        uses: 0,
        acquired: 0,
        released: 0,
        cleaned: 0,
        createdAt: Date.now(),
        lastUsed: null,
      });

      console.log(`✅ Profile created: ${profileId}`);
      return profile;
    } catch (error) {
      console.error(`❌ Failed to create profile ${profileId}:`, error.message);
      throw error;
    }
  }

  /**
   * Create and add profile to ready pool
   */
  async createAndAddProfile() {
    const profile = await this.createProfile();
    this.readyPool.push(profile);
    return profile;
  }

  /**
   * Clean profile (remove session-specific data)
   */
  async cleanProfile(profile) {
    try {
      const filesToDelete = [
        "Cookies",
        "Cookies-journal",
        "Local Storage",
        "Session Storage",
        "IndexedDB",
        "Cache",
      ];

      for (const file of filesToDelete) {
        const filePath = path.join(profile.path, file);
        try {
          if (fs.existsSync(filePath)) {
            if (fs.lstatSync(filePath).isDirectory()) {
              await this.deleteDirectoryRecursive(filePath);
              fs.mkdirSync(filePath);
            } else {
              fs.unlinkSync(filePath);
            }
          }
        } catch (err) {
          // Continue cleaning other files
        }
      }

      // Re-copy essential files from master
      const essentialFiles = ["Cookies", "Local Storage"];
      for (const file of essentialFiles) {
        const sourcePath = path.join(this.baseProfileDir, file);
        const destPath = path.join(profile.path, file);

        if (fs.existsSync(sourcePath)) {
          try {
            await this.copyFile(sourcePath, destPath);
          } catch (err) {
            // Continue
          }
        }
      }

      this.updateProfileStats(profile.id, "cleaned");

      console.log(`✅ Profile cleaned: ${profile.id}`);
    } catch (error) {
      console.error(`❌ Failed to clean profile ${profile.id}:`, error.message);
    }
  }

  /**
   * Recycle profile (deep clean or recreate)
   */
  async recycleProfile(profile) {
    try {
      console.log(`♻️  Recycling profile: ${profile.id}`);

      // Delete the profile
      await this.deleteProfile(profile);

      // Create a new profile to replace it
      await this.createAndAddProfile();

      console.log(`✅ Profile recycled: ${profile.id}`);
    } catch (error) {
      console.error(
        `❌ Failed to recycle profile ${profile.id}:`,
        error.message
      );
    }
  }

  /**
   * Delete profile
   */
  async deleteProfile(profile) {
    try {
      await this.deleteDirectoryRecursive(profile.path);
      this.profileStats.delete(profile.id);
      console.log(`🗑️  Profile deleted: ${profile.id}`);
    } catch (error) {
      console.error(
        `❌ Failed to delete profile ${profile.id}:`,
        error.message
      );
    }
  }

  /**
   * Check if profile should be recycled
   */
  shouldRecycleProfile(profile, stats) {
    // Check usage count
    if (stats.uses >= this.maxProfileUses) {
      return {
        shouldRecycle: true,
        reason: `Max uses reached (${stats.uses})`,
      };
    }

    // Check age
    const age = Date.now() - profile.createdAt;
    if (age > this.maxProfileLifetime) {
      return {
        shouldRecycle: true,
        reason: `Max lifetime reached (${Math.floor(age / 60000)}min)`,
      };
    }

    return { shouldRecycle: false };
  }

  /**
   * Update profile statistics
   */
  updateProfileStats(profileId, action) {
    const stats = this.profileStats.get(profileId);
    if (!stats) return;

    switch (action) {
      case "acquired":
        stats.acquired++;
        stats.uses++;
        stats.lastUsed = Date.now();
        break;
      case "released":
        stats.released++;
        break;
      case "cleaned":
        stats.cleaned++;
        break;
    }

    this.profileStats.set(profileId, stats);
  }

  /**
   * Background worker to maintain pool size
   */
  startBackgroundWorker() {
    console.log("🔄 Starting background pool worker...");

    this.workerInterval = setInterval(async () => {
      if (this.isShuttingDown) return;

      // Check pool health
      const deficit = this.poolSize - this.readyPool.length;

      if (deficit > 0) {
        console.log(`🔄 Pool deficit: ${deficit}, replenishing...`);
        const promises = [];
        for (let i = 0; i < deficit; i++) {
          promises.push(this.createAndAddProfile());
        }
        await Promise.all(promises);
        console.log(
          `✅ Pool replenished: ${this.readyPool.length} ready profiles`
        );
      }

      // Cleanup old profiles in ready pool
      await this.cleanupOldProfiles();
    }, 10000); // Every 10 seconds
  }

  /**
   * Cleanup old profiles that are past their lifetime
   */
  async cleanupOldProfiles() {
    const now = Date.now();
    const oldProfiles = this.readyPool.filter(
      (profile) => now - profile.createdAt > this.maxProfileLifetime
    );

    if (oldProfiles.length > 0) {
      console.log(`🧹 Cleaning up ${oldProfiles.length} old profiles...`);
      for (const profile of oldProfiles) {
        // Remove from ready pool
        const index = this.readyPool.indexOf(profile);
        if (index > -1) {
          this.readyPool.splice(index, 1);
        }

        // Delete and create new
        await this.deleteProfile(profile);
        await this.createAndAddProfile();
      }
    }
  }

  /**
   * Get pool statistics
   */
  getStats() {
    const stats = {
      readyProfiles: this.readyPool.length,
      activeProfiles: this.activePool.size,
      totalProfiles: this.readyPool.length + this.activePool.size,
      poolSize: this.poolSize,
      profileStats: {},
    };

    for (const [id, pstats] of this.profileStats.entries()) {
      stats.profileStats[id] = { ...pstats };
    }

    return stats;
  }

  /**
   * Shutdown the pool
   */
  async shutdown() {
    console.log("\n🛑 Shutting down profile pool...");
    this.isShuttingDown = true;

    // Stop worker
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
    }

    // Wait for active jobs to complete (with timeout)
    const timeout = 30000; // 30 seconds
    const startTime = Date.now();

    while (this.activePool.size > 0 && Date.now() - startTime < timeout) {
      console.log(
        `⏳ Waiting for ${this.activePool.size} active profiles to complete...`
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Force cleanup remaining active profiles
    for (const [jobId, profile] of this.activePool.entries()) {
      console.log(`🧹 Force cleaning active profile: ${jobId}`);
      await this.deleteProfile(profile);
    }
    this.activePool.clear();

    // Cleanup ready pool
    console.log(`🧹 Cleaning up ${this.readyPool.length} ready profiles...`);
    for (const profile of this.readyPool) {
      await this.deleteProfile(profile);
    }
    this.readyPool = [];

    console.log("✅ Profile pool shutdown complete\n");
    this.emit("shutdown");
  }

  /**
   * Utility: Copy directory recursively
   */
  async copyDirectory(source, destination) {
    await this.ensureDirectory(destination);

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await this.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Utility: Copy file
   */
  async copyFile(source, destination) {
    return new Promise((resolve, reject) => {
      fs.copyFile(source, destination, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Utility: Ensure directory exists
   */
  async ensureDirectory(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Utility: Delete directory recursively
   */
  async deleteDirectoryRecursive(dirPath) {
    if (!fs.existsSync(dirPath)) return;

    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          await this.deleteDirectoryRecursive(fullPath);
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch (err) {
        // Continue cleanup
      }
    }

    try {
      fs.rmdirSync(dirPath);
    } catch (err) {
      // Already deleted or in use
    }
  }
}

module.exports = ProfilePoolManager;
