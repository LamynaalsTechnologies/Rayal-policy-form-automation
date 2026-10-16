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
 * `node server.js | grep "kshema "` shows its whole flow and nothing else.
 *
 * WHICH KSHEMA flow printed a line is the word in the bracket (2026-10-16):
 *
 *   [kshema Full ]   the full-company flow (OD + TP bought in one policy) — the default
 *   [kshema TP   ]   the third-party-only copy (multiCompany/tpCompany/kshemaTP)
 *
 * The helpers — this file, kshemaFields, kshemaSection, kshemaFinancier ... — are ONE set of files used by both flows, so a
 * fixed "[kshema Full ]" said "Full" on the TP-only flow's lines too, and a TP-only policy looked like it was running the
 * full flow. The word now comes from the flow that is running: everything inside withFlow("TP", ...) (kshemaTP.js wraps the
 * whole run) says "TP". AsyncLocalStorage, so two jobs in one process (KSHEMAMAXWINDOW) keep their own.
 * FLOW_LOG_PREFIX_ENABLED=false — the switch of the Reliance flow tag — puts the old fixed "Full" back.
 */
const { AsyncLocalStorage } = require("node:async_hooks");

/**
 * FLOW_LOG_PREFIX_ENABLED, read at call time: ON unless false / 0 / no / off — the same reading as lib/flowLogPrefix.js
 * (test/kshemaLog.test.js pins the two together). Not imported from there: that module loads dotenv, and this file is
 * required by nearly every KSHEMA module and test.
 */
const flowWordEnabled = () => !/^(0|false|no|off)$/i.test(String(process.env.FLOW_LOG_PREFIX_ENABLED ?? "").trim());

const flowStore = new AsyncLocalStorage();
const DEFAULT_FLOW = "Full";
/** "Full" plus one space, as the bracket always was; shorter names are padded to it so the messages line up. */
const FLOW_WIDTH = 5;

/** The flow the code running right now belongs to: "Full" unless it is inside withFlow(...). */
const currentFlow = () => (flowWordEnabled() && flowStore.getStore()) || DEFAULT_FLOW;

/** "[kshema Full ]" / "[kshema TP   ]". Read at call time. */
const prefix = () => `[kshema ${currentFlow().padEnd(FLOW_WIDTH)}]`;

/** Run `fn` with `flow` in scope: every line it — and anything it awaits — logs says that flow. Returns whatever `fn` returns. */
const withFlow = (flow, fn) => (flowWordEnabled() ? flowStore.run(String(flow), fn) : fn());

const VERBOSE = /^(1|true|yes|on)$/i.test(
  String(process.env.KSHEMA_VERBOSE || "").trim()
);

const log = (...args) => console.log(prefix(), ...args);
const warn = (...args) => console.warn(prefix(), "⚠️ ", ...args);
const err = (...args) => console.error(prefix(), "❌", ...args);

/** Detail. Silent unless KSHEMA_VERBOSE=true. */
const debug = (...args) => {
  if (VERBOSE) console.log(prefix(), ...args);
};

module.exports = { VERBOSE, log, warn, err, debug, prefix, currentFlow, withFlow };
