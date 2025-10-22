/**
 * Session Health Manager
 * Proactively monitors and maintains master session health
 * Implements heartbeat checks and automatic session refresh
 */

const EventEmitter = require("events");
const { By } = require("selenium-webdriver");

class SessionHealthManager extends EventEmitter {
  constructor(config = {}) {
    super();

    // Configuration
    this.sessionLifetime = config.sessionLifetime || 60 * 60 * 1000; // 1 hour default
    this.heartbeatInterval = config.heartbeatInterval || 5 * 60 * 1000; // 5 minutes
    this.warningThreshold = config.warningThreshold || 0.8; // 80% of lifetime
    this.refreshThreshold = config.refreshThreshold || 0.9; // 90% of lifetime

    // Session state
    this.sessions = new Map(); // sessionId -> session data
    this.isMonitoring = false;
    this.heartbeatTimer = null;

    console.log("💓 SessionHealthManager initialized");
    console.log(`   Heartbeat interval: ${this.heartbeatInterval / 1000}s`);
    console.log(`   Session lifetime: ${this.sessionLifetime / 60000}min`);
  }

  /**
   * Register a session for monitoring
   */
  registerSession(sessionId, driver, credentials) {
    console.log(`📝 Registering session: ${sessionId}`);

    const session = {
      id: sessionId,
      driver,
      credentials,
      startTime: Date.now(),
      lastCheck: Date.now(),
      status: "active",
      health: {
        checksPerformed: 0,
        checksFailed: 0,
        lastError: null,
      },
    };

    this.sessions.set(sessionId, session);

    // Start monitoring if not already running
    if (!this.isMonitoring) {
      this.startMonitoring();
    }

    this.emit("sessionRegistered", { sessionId });
    console.log(`✅ Session registered: ${sessionId}`);
  }

  /**
   * Unregister a session
   */
  unregisterSession(sessionId) {
    console.log(`🗑️  Unregistering session: ${sessionId}`);
    this.sessions.delete(sessionId);

    // Stop monitoring if no sessions left
    if (this.sessions.size === 0 && this.isMonitoring) {
      this.stopMonitoring();
    }

    this.emit("sessionUnregistered", { sessionId });
  }

  /**
   * Start health monitoring
   */
  startMonitoring() {
    if (this.isMonitoring) {
      console.log("⚠️  Monitoring already running");
      return;
    }

    console.log("🚀 Starting session health monitoring...");
    this.isMonitoring = true;

    // Run initial check immediately
    this.performHealthChecks();

    // Schedule periodic checks
    this.heartbeatTimer = setInterval(() => {
      this.performHealthChecks();
    }, this.heartbeatInterval);

    console.log("✅ Session monitoring started");
    this.emit("monitoringStarted");
  }

  /**
   * Stop health monitoring
   */
  stopMonitoring() {
    if (!this.isMonitoring) return;

    console.log("🛑 Stopping session health monitoring...");
    this.isMonitoring = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    console.log("✅ Session monitoring stopped");
    this.emit("monitoringStopped");
  }

  /**
   * Perform health checks on all registered sessions
   */
  async performHealthChecks() {
    if (this.sessions.size === 0) return;

    console.log(
      `\n💓 Performing health checks on ${this.sessions.size} session(s)...`
    );

    const checkPromises = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      checkPromises.push(this.checkSession(sessionId, session));
    }

    await Promise.allSettled(checkPromises);

    console.log("✅ Health checks complete\n");
  }

  /**
   * Check individual session health
   */
  async checkSession(sessionId, session) {
    try {
      console.log(`🔍 Checking session: ${sessionId}`);

      session.health.checksPerformed++;
      session.lastCheck = Date.now();

      // Calculate session age
      const age = Date.now() - session.startTime;
      const agePercent = age / this.sessionLifetime;

      console.log(
        `   Age: ${Math.floor(age / 60000)}min (${(agePercent * 100).toFixed(
          1
        )}%)`
      );

      // Check if session needs refresh
      if (agePercent >= this.refreshThreshold) {
        console.log(
          `⚠️  Session ${sessionId} needs refresh (${(agePercent * 100).toFixed(
            1
          )}%)`
        );
        await this.refreshSession(sessionId, session);
        return;
      }

      // Warning threshold
      if (agePercent >= this.warningThreshold) {
        console.log(
          `⚠️  Session ${sessionId} approaching expiry (${(
            agePercent * 100
          ).toFixed(1)}%)`
        );
        this.emit("sessionWarning", { sessionId, agePercent });
      }

      // Ping session to verify it's alive
      const isAlive = await this.pingSession(session);

      if (isAlive) {
        session.status = "active";
        console.log(`✅ Session ${sessionId} is healthy`);
        this.emit("sessionHealthy", { sessionId });
      } else {
        session.status = "expired";
        session.health.checksFailed++;
        console.error(`❌ Session ${sessionId} appears expired`);

        // Try to refresh
        await this.refreshSession(sessionId, session);
      }
    } catch (error) {
      session.health.checksFailed++;
      session.health.lastError = error.message;
      console.error(`❌ Health check failed for ${sessionId}:`, error.message);
      this.emit("sessionCheckFailed", { sessionId, error: error.message });
    }
  }

  /**
   * Ping session to check if it's alive
   */
  async pingSession(session) {
    try {
      // Navigate to dashboard
      const currentUrl = await session.driver.getCurrentUrl();

      if (!currentUrl.includes("reliancegeneral.co.in")) {
        console.log("   Navigating to dashboard for ping...");
        await session.driver.get(
          "https://smartzone.reliancegeneral.co.in/Login/IMDLogin"
        );
        await session.driver.sleep(3000);
      }

      // Check for dashboard elements
      const dashboardElements = await session.driver.findElements(
        By.id("divMainMotors")
      );
      const logoutElements = await session.driver.findElements(
        By.id("divLogout")
      );

      const isAlive = dashboardElements.length > 0 || logoutElements.length > 0;

      if (isAlive) {
        console.log("   ✓ Ping successful - dashboard detected");
      } else {
        console.log("   ✗ Ping failed - no dashboard elements");
      }

      return isAlive;
    } catch (error) {
      console.log(`   ✗ Ping failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Refresh session (proactive re-login)
   */
  async refreshSession(sessionId, session) {
    console.log(`🔄 Refreshing session: ${sessionId}`);
    this.emit("sessionRefreshing", { sessionId });

    try {
      // Import the re-login function
      const { reLoginIfNeeded } = require("./sessionManager");

      console.log("   Attempting session refresh...");
      const success = await reLoginIfNeeded();

      if (success) {
        // Reset session start time
        session.startTime = Date.now();
        session.status = "active";
        session.health.lastError = null;

        console.log(`✅ Session ${sessionId} refreshed successfully`);
        this.emit("sessionRefreshed", { sessionId });

        return true;
      } else {
        session.status = "failed";
        console.error(`❌ Session ${sessionId} refresh failed`);
        this.emit("sessionRefreshFailed", { sessionId });

        return false;
      }
    } catch (error) {
      session.status = "failed";
      session.health.lastError = error.message;
      console.error(`❌ Session ${sessionId} refresh error:`, error.message);
      this.emit("sessionRefreshError", { sessionId, error: error.message });

      return false;
    }
  }

  /**
   * Get session health status
   */
  getSessionHealth(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const age = Date.now() - session.startTime;
    const agePercent = age / this.sessionLifetime;

    return {
      id: session.id,
      status: session.status,
      age: age,
      agePercent: (agePercent * 100).toFixed(1) + "%",
      lastCheck: session.lastCheck,
      health: {
        ...session.health,
        successRate:
          session.health.checksPerformed > 0
            ? (
                ((session.health.checksPerformed -
                  session.health.checksFailed) /
                  session.health.checksPerformed) *
                100
              ).toFixed(1) + "%"
            : "N/A",
      },
    };
  }

  /**
   * Get all sessions health
   */
  getAllSessionsHealth() {
    const health = {};
    for (const [sessionId] of this.sessions.entries()) {
      health[sessionId] = this.getSessionHealth(sessionId);
    }
    return health;
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    return {
      isMonitoring: this.isMonitoring,
      activeSessions: this.sessions.size,
      sessionHealth: this.getAllSessionsHealth(),
      configuration: {
        sessionLifetime: this.sessionLifetime,
        heartbeatInterval: this.heartbeatInterval,
        warningThreshold: this.warningThreshold,
        refreshThreshold: this.refreshThreshold,
      },
    };
  }

  /**
   * Shutdown monitoring
   */
  async shutdown() {
    console.log("🛑 Shutting down session health manager...");

    this.stopMonitoring();
    this.sessions.clear();

    console.log("✅ Session health manager shutdown complete");
    this.emit("shutdown");
  }
}

module.exports = SessionHealthManager;

