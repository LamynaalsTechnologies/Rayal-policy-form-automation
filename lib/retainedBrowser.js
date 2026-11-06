/**
 * A window left open on purpose (KEEP_BROWSER_OPEN_ON_ERROR / CLOSE_BROWSER_AFTER_COMPLETE=false) is cleaned up the moment
 * the owner closes it (2026-11-06: "I close the window, then its session and window data must be removed").
 *
 * Before, a kept window kept its profile folder (100-200 MB of Chrome data) until the next restart of the automation.
 * Now every company's clean-up (Reliance sessionManager.js, National nationalSessionManager.js, KSHEMA
 * kshemaSessionManager.js, United India unitedIndiaSession.js) hands the kept browser to watchRetainedBrowser:
 *   - every few seconds it asks the browser for its windows (getAllWindowHandles, one tiny WebDriver call);
 *   - when the browser says it has none, or the session is gone (the window was closed), it ends the chromedriver
 *     session and deletes THIS job's own folders - each only when no other running job still holds it (lib/jobDirs.js), so
 *     two windows at once can never delete each other's data;
 *   - any other answer (a slow page, an alert, a busy browser) is not "closed": it simply asks again later.
 * The timer never keeps the process alive (unref), and a restart still wipes every profile folder as before.
 */
const fs = require("fs");
const jobDirs = require("./jobDirs");

const POLL_MS = 5000;

/** The answers that mean "this browser has no window any more". */
const CLOSED_WORDS =
  /invalid session id|no such window|target window already closed|chrome not reachable|session deleted|not connected to devtools|disconnected|ECONNREFUSED|ECONNRESET|session not created|no such session/i;

const watches = new Set();

/**
 * @param {Object} o
 * @param {string} o.label             for the log ("United India Job tp_..")
 * @param {Object} o.driver            the kept job's WebDriver
 * @param {string[]} o.dirs            this job's own folders (profile, downloads) - deleted when the window is closed
 * @param {number} [o.pollMs]
 * @param {Function} [o.log]
 * @param {Function} [o.removeDir]     tests replace the deletion
 * @param {Function} [o.setIntervalFn] tests drive the polls themselves
 * @returns {{ check: Function, stop: Function, closed: boolean } | null} null when there is nothing to watch
 */
function watchRetainedBrowser({
  label,
  driver,
  dirs = [],
  pollMs = POLL_MS,
  log = (line) => console.log(line),
  removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  setIntervalFn = setInterval,
} = {}) {
  // selenium-webdriver for Node names it getAllWindowHandles (getWindowHandles is the Java / Python name)
  if (!driver || typeof driver.getAllWindowHandles !== "function") return null;
  const own = [...new Set((dirs || []).filter(Boolean))];

  let busy = false;
  let timer = null;
  const watch = {
    closed: false,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      watches.delete(watch);
    },
    /** One look at the browser. Resolves true when it found the window closed (and cleaned up). */
    async check() {
      if (watch.closed || busy) return watch.closed;
      busy = true;
      try {
        let gone = false;
        try {
          const handles = await driver.getAllWindowHandles();
          gone = !Array.isArray(handles) || handles.length === 0;
        } catch (e) {
          gone = CLOSED_WORDS.test(String((e && e.message) || e));
        }
        if (!gone) return false;

        watch.closed = true;
        watch.stop();
        try {
          await driver.quit(); // ends the chromedriver session the window left behind
        } catch (e) {
          /* already gone */
        }
        const removed = [];
        for (const dir of own) {
          if (!jobDirs.release(dir)) {
            log(`ℹ️  [${label}] the window was closed - ${dir} is kept, another running job still uses it`);
            continue;
          }
          try {
            if (fs.existsSync(dir)) {
              removeDir(dir);
              removed.push(dir);
            }
          } catch (e) {
            log(`⚠️  [${label}] the window was closed but ${dir} could not be removed: ${e.message}`);
          }
        }
        log(`🧹 [${label}] the window was closed - its session and ${removed.length ? removed.join(", ") : "profile"} removed`);
        return true;
      } finally {
        busy = false;
      }
    },
  };
  timer = setIntervalFn(() => {
    watch.check().catch(() => {});
  }, pollMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  watches.add(watch);
  log(`   Closing that window removes its session and profile (checked every ${Math.round(pollMs / 1000)} s).`);
  return watch;
}

/** For tests and a clean shutdown. */
const activeWatches = () => watches.size;
const stopAllWatches = () => {
  for (const w of [...watches]) w.stop();
};

module.exports = { watchRetainedBrowser, activeWatches, stopAllWatches, CLOSED_WORDS, POLL_MS };
