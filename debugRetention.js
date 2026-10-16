/**
 * Debug retention — when a job's browser window is kept open instead of closed.
 *
 *   KEEP_BROWSER_OPEN_ON_ERROR=true     a job that ends in an error (or at a deliberate stop) leaves its Chrome window
 *                                       and its profile directory alone, so the page can be inspected by hand.
 *   CLOSE_BROWSER_AFTER_COMPLETE        what happens to a job that COMPLETED. true (the default): its window is closed
 *                                       and its own profile directory is deleted, freeing the disk. false: the window
 *                                       is left open like a failed job's (a headed machine only).
 *
 * Both only ever concern THIS job's browser and THIS job's profile directory — never another job's, never a shared
 * master profile.
 *
 * Keeping a browser is a TESTING aid and deliberately opt-in: every retained browser is a Chrome process and a profile
 * directory that nothing will ever reclaim, so a server left running with it on will eventually exhaust memory and disk.
 */

require("dotenv").config();

const isTruthy = (value) =>
  /^(1|true|yes|on)$/i.test(String(value || "").trim());

const KEEP_BROWSER_OPEN_ON_ERROR = isTruthy(
  process.env.KEEP_BROWSER_OPEN_ON_ERROR
);

// ON unless false / 0 / no / off — a completed job's browser is closed and its profile deleted, as it always was.
const CLOSE_BROWSER_AFTER_COMPLETE = !/^(0|false|no|off)$/i.test(
  String(process.env.CLOSE_BROWSER_AFTER_COMPLETE || "").trim()
);
/**
 * Headless includes the case nobody set the flag for.
 *
 * On Linux with no display — a deployed server, a container, an SSH session —
 * Chrome runs headless whether or not HEADLESS says so; every company's browser
 * config forces it, because otherwise Chrome cannot start at all. Reading only
 * the env var missed that, so on a real server KEEP_BROWSER_OPEN_ON_ERROR held
 * on to browsers that had no window to show anyone: a leaked Chrome process and
 * a leaked profile directory per failed job.
 */
const HAS_DISPLAY =
  process.platform !== "linux" ||
  !!process.env.DISPLAY ||
  !!process.env.WAYLAND_DISPLAY;
const IS_HEADLESS = isTruthy(process.env.HEADLESS) || !HAS_DISPLAY;

let warnedAboutHeadless = false;

/**
 * Should this job's browser be left running?
 *
 * @param {boolean} hadError - did the job end in an error (or at a deliberate stop)?
 * @returns {boolean}
 */
function shouldKeepBrowserOpen(hadError) {
  // The setting that applies: an error / stop follows KEEP_BROWSER_OPEN_ON_ERROR, a completed job follows
  // CLOSE_BROWSER_AFTER_COMPLETE (keep only when that is explicitly turned off).
  const wantsKeep = hadError ? KEEP_BROWSER_OPEN_ON_ERROR : !CLOSE_BROWSER_AFTER_COMPLETE;
  if (!wantsKeep) return false;

  // A headless browser has no window to look at, so retaining it only leaks a
  // process. Warn once and clean up as normal.
  if (IS_HEADLESS) {
    if (!warnedAboutHeadless) {
      warnedAboutHeadless = true;
      console.warn(
        "⚠️  A browser was asked to stay open (KEEP_BROWSER_OPEN_ON_ERROR / CLOSE_BROWSER_AFTER_COMPLETE=false) " +
        "but this is running headless (no display), so there is no window to inspect and browsers will " +
        "still be closed."
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
    `\n🔍 [${label}] leaving this browser open ` +
    `(KEEP_BROWSER_OPEN_ON_ERROR for a failed job, CLOSE_BROWSER_AFTER_COMPLETE=false for a completed one).`
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
  CLOSE_BROWSER_AFTER_COMPLETE,
  shouldKeepBrowserOpen,
  logRetainedBrowser,
};
