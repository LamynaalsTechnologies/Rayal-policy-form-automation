/**
 * Debug retention — keep a failed job's browser window open.
 *
 * Set KEEP_BROWSER_OPEN_ON_ERROR=true in .env and a job that ends in an error
 * leaves its Chrome window (and its profile directory) alone, so the failing
 * page can be inspected by hand. Successful jobs always clean up normally.
 *
 * This is a TESTING aid and is deliberately opt-in: every retained browser is a
 * Chrome process and a profile directory that nothing will ever reclaim, so a
 * server left running with this on will eventually exhaust memory and disk.
 */

require("dotenv").config();

const isTruthy = (value) =>
  /^(1|true|yes|on)$/i.test(String(value || "").trim());

const KEEP_BROWSER_OPEN_ON_ERROR = isTruthy(
  process.env.KEEP_BROWSER_OPEN_ON_ERROR
);
const IS_HEADLESS = isTruthy(process.env.HEADLESS);

let warnedAboutHeadless = false;

/**
 * Should this job's browser be left running?
 *
 * @param {boolean} hadError - did the job end in an error?
 * @returns {boolean}
 */
function shouldKeepBrowserOpen(hadError) {
  if (!hadError || !KEEP_BROWSER_OPEN_ON_ERROR) return false;

  // A headless browser has no window to look at, so retaining it only leaks a
  // process. Warn once and clean up as normal.
  if (IS_HEADLESS) {
    if (!warnedAboutHeadless) {
      warnedAboutHeadless = true;
      console.warn(
        "⚠️  KEEP_BROWSER_OPEN_ON_ERROR is set but HEADLESS is also on — there " +
        "is no window to inspect, so browsers will still be closed. Set " +
        "HEADLESS=false to use this."
      );
    }
    return false;
  }

  return true;
}

/**
 * Log why a browser is being kept, with the profile path so it can be removed
 * by hand afterwards.
 */
function logRetainedBrowser(label, profilePath) {
  console.log(
    `\n🔍 [${label}] KEEP_BROWSER_OPEN_ON_ERROR is on — leaving this browser ` +
    `open for inspection.`
  );
  console.log(
    `   Close the Chrome window yourself when done; the job slot is already free.`
  );
  if (profilePath) {
    console.log(`   Profile left in place: ${profilePath}`);
  }
}

module.exports = {
  KEEP_BROWSER_OPEN_ON_ERROR,
  shouldKeepBrowserOpen,
  logRetainedBrowser,
};
