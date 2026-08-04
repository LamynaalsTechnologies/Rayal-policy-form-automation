/**
 * One console prefix for everything KSHEMA — and one volume knob.
 *
 * Two channels:
 *
 *   log/warn/err  always print. Reserved for what someone watching a running
 *                 server needs: the field that was just set, the field that
 *                 failed, the stage the job reached.
 *   debug         prints only with KSHEMA_VERBOSE=true. Everything else — which
 *                 selector matched, the browser's profile path, page dumps.
 *
 * The split exists because the detail drowned the signal. A single job printed
 * the login page's every input and button, each selector it tried, and a banner
 * around every stage; the handful of lines that said what had actually been
 * filled in were lost in it, and with two windows running in parallel the
 * output was unreadable.
 *
 * Reliance and National grew their own ad-hoc prefixes line by line, so their
 * output cannot be filtered at all — some lines say "[National Job x]", some
 * say "→", some say nothing. Everything KSHEMA goes through here, so
 * `node server.js | grep "kshema Full"` shows its whole flow and nothing else.
 */
const LOG_PREFIX = "[kshema Full ]";

const VERBOSE = /^(1|true|yes|on)$/i.test(
  String(process.env.KSHEMA_VERBOSE || "").trim()
);

const log = (...args) => console.log(LOG_PREFIX, ...args);
const warn = (...args) => console.warn(LOG_PREFIX, "⚠️ ", ...args);
const err = (...args) => console.error(LOG_PREFIX, "❌", ...args);

/** Detail. Silent unless KSHEMA_VERBOSE=true. */
const debug = (...args) => {
  if (VERBOSE) console.log(LOG_PREFIX, ...args);
};

module.exports = { LOG_PREFIX, VERBOSE, log, warn, err, debug };
