/**
 * Optimized Chrome Configuration
 * Minimal resource usage and maximum performance
 */

const chrome = require("selenium-webdriver/chrome");
const path = require("path");

/**
 * Get optimized Chrome options
 */
function getOptimizedChromeOptions(profilePath, config = {}) {
  const options = new chrome.Options();

  // Use profile
  if (profilePath) {
    options.addArguments(`--user-data-dir=${profilePath}`);
  }

  // ===== PERFORMANCE FLAGS =====

  // Disable unnecessary features
  options.addArguments(
    "--disable-extensions", // Faster startup
    "--disable-plugins",
    "--disable-gpu", // No GPU needed for form filling
    "--disable-dev-shm-usage", // Overcome limited resource problems
    "--disable-setuid-sandbox",
    "--no-sandbox", // Improve performance
    "--disable-web-security", // Faster loading
    "--disable-features=VizDisplayCompositor",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-sync", // Don't sync with Google
    "--disable-translate", // Don't need translation
    "--disable-default-apps",
    "--disable-component-extensions-with-background-pages"
  );

  // Memory optimizations
  options.addArguments(
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    "--disable-accelerated-2d-canvas",
    "--disable-accelerated-video-decode",
    "--disable-webgl",
    "--disable-webgl2"
  );

  // Startup optimizations
  options.addArguments(
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-hang-monitor",
    "--disable-prompt-on-repost",
    "--disable-domain-reliability"
  );

  // Logging and metrics (disable to reduce overhead)
  options.addArguments(
    "--disable-logging",
    "--log-level=3", // Only fatal errors
    "--silent",
    "--disable-breakpad" // No crash reporting
  );

  // Network optimizations
  options.addArguments(
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-component-update"
  );

  // Disable unnecessary services
  options.addArguments(
    "--disable-features=TranslateUI",
    "--disable-features=BlinkGenPropertyTrees",
    "--disable-ipc-flooding-protection",
    "--disable-popup-blocking" // In case form has popups
  );

  // Audio/Media (not needed for form filling)
  options.addArguments(
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required"
  );

  // ===== OPTIONAL: HEADLESS MODE =====
  if (config.headless) {
    options.addArguments("--headless=new"); // Use new headless mode
    options.addArguments("--disable-blink-features=AutomationControlled"); // Avoid detection
  }

  // ===== WINDOW SIZE =====
  // Fixed size for consistent screenshots
  options.addArguments("--window-size=1366,768");

  // ===== PREFERENCES =====
  const prefs = {
    // Disable images for faster loading (optional)
    ...(config.disableImages && {
      "profile.managed_default_content_settings.images": 2,
    }),

    // Disable notifications
    "profile.default_content_setting_values.notifications": 2,

    // Disable geolocation
    "profile.default_content_setting_values.geolocation": 2,

    // Disable popup
    "profile.default_content_setting_values.popups": 0,

    // Download preferences (if needed)
    "download.default_directory": config.downloadPath || "/tmp/downloads",
    "download.prompt_for_download": false,
    "download.directory_upgrade": true,
    "safebrowsing.enabled": false,

    // Automation preferences
    credentials_enable_service: false,
    "profile.password_manager_enabled": false,
  };

  options.setUserPreferences(prefs);

  // ===== EXPERIMENTAL OPTIONS =====
  options.excludeSwitches("enable-automation"); // Avoid detection
  options.addArguments("--disable-blink-features=AutomationControlled");

  // ===== PAGE LOAD STRATEGY =====
  // Use 'eager' to not wait for all resources (images, etc.)
  if (config.eagerLoad) {
    options.setPageLoadStrategy("eager");
  }

  return options;
}

/**
 * Get minimal Chrome options (for maximum speed)
 */
function getMinimalChromeOptions(profilePath) {
  return getOptimizedChromeOptions(profilePath, {
    headless: false, // Keep visible for debugging
    disableImages: false, // Keep images for captcha
    eagerLoad: true,
  });
}

/**
 * Get ultra-fast Chrome options (for testing/benchmarking)
 */
function getUltraFastChromeOptions(profilePath) {
  return getOptimizedChromeOptions(profilePath, {
    headless: true, // Headless for speed
    disableImages: true, // No images
    eagerLoad: true,
  });
}

/**
 * RAM Disk path helper
 */
function getRamDiskPath() {
  const os = require("os");
  const platform = os.platform();

  if (platform === "linux") {
    // Use /dev/shm (shared memory) for Linux
    return "/dev/shm/chrome-profiles";
  } else if (platform === "darwin") {
    // Use /tmp for macOS (tmpfs)
    return "/tmp/chrome-profiles";
  } else if (platform === "win32") {
    // Windows: use temp directory
    return path.join(process.env.TEMP || "C:\\Temp", "chrome-profiles");
  }

  // Fallback
  return path.join(__dirname, "temp-profiles");
}

/**
 * Check if RAM disk is available
 */
function isRamDiskAvailable() {
  const fs = require("fs");
  const ramDiskPath = getRamDiskPath();

  try {
    // Try to create directory in RAM disk
    if (!fs.existsSync(ramDiskPath)) {
      fs.mkdirSync(ramDiskPath, { recursive: true });
    }

    // Test write
    const testFile = path.join(ramDiskPath, `test-${Date.now()}.txt`);
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);

    console.log(`✅ RAM disk available at: ${ramDiskPath}`);
    return true;
  } catch (error) {
    console.log(`⚠️  RAM disk not available: ${error.message}`);
    return false;
  }
}

/**
 * Get performance statistics
 */
function getChromePerformanceStats(driver) {
  return driver.executeScript(`
    return {
      memory: performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
      } : null,
      navigation: {
        loadTime: performance.timing.loadEventEnd - performance.timing.navigationStart,
        domReadyTime: performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart,
        domInteractive: performance.timing.domInteractive - performance.timing.navigationStart
      },
      resources: performance.getEntriesByType('resource').length
    };
  `);
}

module.exports = {
  getOptimizedChromeOptions,
  getMinimalChromeOptions,
  getUltraFastChromeOptions,
  getRamDiskPath,
  isRamDiskAvailable,
  getChromePerformanceStats,
};

