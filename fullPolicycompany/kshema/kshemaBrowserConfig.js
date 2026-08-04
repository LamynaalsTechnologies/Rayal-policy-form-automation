/**
 * KSHEMA browser configuration.
 *
 * Modelled on nationalBrowserConfig.js, minus the master-profile machinery:
 * KSHEMA logs in fresh on every job, so there is nothing to clone from and no
 * master profile to keep warm.
 *
 * The one thing that MUST stay unique per company is CLONED_PROFILE_BASE.
 * Chrome refuses to run two instances against the same user-data-dir, so a
 * shared directory would make Reliance, National and KSHEMA jobs collide the
 * moment two run at once. Each company gets its own tree, and each job its own
 * directory inside it.
 */
const { Builder } = require("selenium-webdriver");
const chrome = require("selenium-webdriver/chrome");
const path = require("path");
const fs = require("fs");
const { log, debug, warn } = require("./kshemaLog");

const CONFIG = {
  // The portal's entry point. A stored ProviderCredential.loginUrl wins over
  // this — this is only the fallback for a credential saved without one.
  LOGIN_URL: "https://motorinsurance.kshema.co/app/home",
  USERNAME: "",
  PASSWORD: "",
  LOGIN_TIMEOUT: 30000,
  CHECK_TIMEOUT: 5000,
};

const PATHS = {
  // process.cwd(), not __dirname: the server is always launched from the
  // project root, and server.js's cleanup/sweep lists are written relative to
  // the root too. Using __dirname here would bury profiles inside
  // fullPolicycompany/ where neither of those would ever find them.
  CLONED_PROFILE_BASE: path.join(process.cwd(), "cloned_profiles_kshema"),
};

/**
 * Should this run headless?
 *
 * Not just "did someone set HEADLESS=true". On a Linux box with no display —
 * a deployed server, a container, an SSH session — Chrome cannot start a
 * window at all, so a stray HEADLESS=false there does not give you a visible
 * browser, it gives you a job that dies on startup. Same guard Reliance uses
 * (browserv2.js shouldRunHeadless).
 */
function shouldRunHeadless() {
  if (process.env.HEADLESS === "true") return true;

  const hasDisplay =
    process.platform !== "linux" ||
    !!process.env.DISPLAY ||
    !!process.env.WAYLAND_DISPLAY;

  if (!hasDisplay) {
    if (process.env.HEADLESS === "false") {
      log("HEADLESS=false but no display found — running headless so Chrome can start.");
    }
    return true;
  }
  return false;
}

/** Chrome flags for a job's own throwaway profile. */
function createJobProfileOptions(profileInfo) {
  const options = new chrome.Options();

  if (shouldRunHeadless()) {
    // Headless needs its window size stated explicitly. Without it Chrome
    // starts at 800x600, and this form is wide enough that fields land off
    // screen — isDisplayed() then reports them fine while a click misses.
    options.addArguments("--headless=new");
    options.addArguments("--window-size=1366,768");
    options.addArguments("--disable-gpu");
    options.addArguments("--hide-scrollbars");
    // Angular animations are pure cost with nothing to watch, and they are the
    // main source of "clicked while the panel was still sliding in".
    options.addArguments("--force-prefers-reduced-motion");
  }

  options.addArguments(`--user-data-dir=${profileInfo.userDataDir}`);
  options.addArguments(`--profile-directory=${profileInfo.profileDirectory}`);
  options.addArguments("--no-first-run");
  options.addArguments("--no-default-browser-check");
  options.addArguments("--disable-dev-shm-usage");
  options.addArguments("--disable-extensions");
  options.addArguments("--window-size=1366,768");
  options.addArguments("--no-sandbox");

  // Hide automation indicators
  options.excludeSwitches(["enable-automation"]);
  options.addArguments("--disable-blink-features=AutomationControlled");

  // Configure download directory if provided
  if (profileInfo.downloadDir) {
    options.setUserPreferences({
      "download.default_directory": profileInfo.downloadDir,
      "download.prompt_for_download": false,
      "download.directory_upgrade": true,
      "safebrowsing.enabled": true,
      "plugins.always_open_pdf_externally": true,
    });
  }

  const candidateChromeBins = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);

  for (const bin of candidateChromeBins) {
    try {
      if (fs.existsSync(bin)) {
        options.setChromeBinaryPath(bin);
        break;
      }
    } catch (e) { }
  }

  return options;
}

/** Build a driver against a job's profile directory. */
async function createJobBrowserDriver(profileInfo) {
  debug("Starting browser...");
  const options = createJobProfileOptions(profileInfo);

  let serviceBuilder = null;
  const candidateDrivers = [
    process.env.CHROMEDRIVER_PATH,
    path.join(process.cwd(), "chromedriver"),
    "/usr/local/bin/chromedriver",
    "/usr/bin/chromedriver",
  ].filter(Boolean);

  for (const driverPath of candidateDrivers) {
    try {
      if (fs.existsSync(driverPath)) {
        const { ServiceBuilder } = require("selenium-webdriver/chrome");
        serviceBuilder = new ServiceBuilder(driverPath);
        debug(`Using ChromeDriver: ${driverPath}`);
        break;
      }
    } catch (e) { }
  }

  let builder = new Builder().forBrowser("chrome").setChromeOptions(options);
  if (serviceBuilder) builder = builder.setChromeService(serviceBuilder);

  const driver = await builder.build();
  debug("✓ Browser ready");
  return driver;
}

module.exports = {
  CONFIG,
  PATHS,
  createJobProfileOptions,
  createJobBrowserDriver,
};
