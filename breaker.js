/**
 * Breaker — stop the automation at a named checkpoint, switched from .env.
 *
 *   Breaker.checkpoint("RTO/Make/Model/Variant");    // <- one line, anywhere in a flow
 *
 * No import needed: loading this file (server.js does, at startup) makes `Breaker` a
 * global, like `debugger`. That is deliberate — a checkpoint is meant to stay in the
 * code while it is switched off, so a forgotten `require` must not be able to crash a
 * run. (The explicit form works too:  const { Breaker } = require("./breaker");)
 *
 * The line does NOTHING until .env says so, so it can stay in the code:
 *
 *   BREAKER_ENABLED=true                             # master switch (default off)
 *   BREAKER_STOP_AT=RTO/Make/Model/Variant           # which checkpoint(s) stop
 *
 * BREAKER_STOP_AT is a comma-separated list of checkpoint names (case and
 * surrounding spaces do not matter), or `*` to stop at the first checkpoint any
 * run reaches. Restart the automation after editing .env.
 *
 * When it stops, the run ends exactly like automationStopper's stopper(): the job is
 * recorded as "stopped on purpose" (calm log line, no retry, nothing submitted),
 * and with KEEP_BROWSER_OPEN_ON_ERROR=true and a display the browser stays on the
 * page, so you can look at it and write the next step. To run past the checkpoint,
 * switch it off (or change BREAKER_STOP_AT) in .env, restart, and Retry the policy.
 *
 * ONE RULE: the stop travels up as a thrown error, so a try/catch between the
 * checkpoint and the top of the flow that swallows errors would swallow the stop
 * too. The big ones in the National and Reliance flows already let it through
 * (`if (isAutomationStop(e)) throw e;`); put the checkpoint outside small
 * best-effort try blocks, or add that line to their catch. If a stop is swallowed
 * anyway, Breaker says so loudly after a few seconds instead of failing silently.
 */
require("dotenv").config({ quiet: true });

const { AutomationStoppedError } = require("./automationStopper");

const isTruthy = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());
const norm = (value) => String(value == null ? "" : value).trim().toLowerCase();

/** How long a thrown stop may go unreported before Breaker warns that it was swallowed. */
const SWALLOW_WARN_MS = 10000;

/**
 * @param {Object} [opts]
 * @param {Object} [opts.env]       where BREAKER_* are read from, on every call (default process.env)
 * @param {Function} [opts.log]     console.log-like
 * @param {number} [opts.graceMs]   see SWALLOW_WARN_MS
 */
function createBreaker({ env = process.env, log = console.log, graceMs = SWALLOW_WARN_MS } = {}) {
  const isEnabled = () => isTruthy(env.BREAKER_ENABLED);

  /** The checkpoint names that stop the run, lower-cased. `*` is kept as it is. */
  const stopPoints = () =>
    String(env.BREAKER_STOP_AT || "")
      .split(",")
      .map(norm)
      .filter(Boolean);

  const stops = (name) => {
    const points = stopPoints();
    return points.includes("*") || points.includes(norm(name));
  };

  /**
   * Stop here if .env asks for it; otherwise do nothing at all.
   * Never throws unless it is stopping, so a checkpoint left in the code cannot
   * break a run, whatever its name or the .env says.
   *
   * @param {string} name what this point is, e.g. "RTO/Make/Model/Variant"
   * @returns {void}
   * @throws {AutomationStoppedError} when BREAKER_ENABLED and the name is in BREAKER_STOP_AT
   */
  const hinted = new Set();

  function checkpoint(name) {
    const label = String(name == null ? "" : name).trim() || "(unnamed)";

    if (!isEnabled()) {
      // Silent, EXCEPT when .env asks for a stop at this very checkpoint while the master
      // switch is off — otherwise "it did not stop" has no clue at all. Once per checkpoint.
      if (stops(name) && !hinted.has(norm(name))) {
        hinted.add(norm(name));
        log(
          `[Breaker] checkpoint "${label}" is listed in BREAKER_STOP_AT but BREAKER_ENABLED is not true — NOT stopping. ` +
            "Set BREAKER_ENABLED=true in .env, save, and restart the automation."
        );
      }
      return;
    }

    if (!stops(name)) {
      log(`[Breaker] checkpoint "${label}" reached — continuing (BREAKER_STOP_AT=${env.BREAKER_STOP_AT || "(empty)"})`);
      return;
    }

    const message = `Stopped on purpose at checkpoint "${label}" (Breaker).`;
    log(`\n${"⏸️ ".repeat(23)}`);
    log(`⏸️  BREAKER — stopped at checkpoint "${label}"`);
    log("   .env: BREAKER_ENABLED=true, BREAKER_STOP_AT includes this checkpoint.");
    log("   Nothing was submitted. To run past it: switch it off in .env, restart, then Retry the policy.");
    log(`${"⏸️ ".repeat(23)}\n`);

    const error = new AutomationStoppedError(message, { stage: "breaker", checkpoint: label, breaker: true });

    // Whoever turns this error into a result calls error.acknowledge() (see
    // automationStopper's stoppedResult). If nobody does, a try/catch swallowed it.
    const timer = setTimeout(() => {
      log(
        `\n⚠️  [Breaker] the stop at "${label}" was thrown ${graceMs / 1000}s ago but nothing has reported it: ` +
          "a try/catch between that line and the top of the flow swallowed it (the automation may be running on past the checkpoint) " +
          "or turned it into an ordinary error.\n" +
          "   Fix: move the checkpoint out of that try block, or make the catch start with `if (isAutomationStop(e)) throw e;`\n"
      );
    }, graceMs);
    if (typeof timer.unref === "function") timer.unref();
    error.acknowledge = () => clearTimeout(timer);

    throw error;
  }

  if (isEnabled()) {
    const points = stopPoints();
    log(
      `\n⏸️  [Breaker] ENABLED — jobs will stop at: ${points.length ? points.join(", ") : "(nothing: BREAKER_STOP_AT is empty)"}` +
        "\n   Never leave BREAKER_ENABLED=true on a server that runs real policies.\n"
    );
  }

  return { checkpoint, isEnabled, stopPoints };
}

/** The one every flow uses; reads process.env on each call. */
const Breaker = createBreaker();

// Available in every file without an import (see the header). A name that is already
// taken is left alone.
if (typeof globalThis.Breaker === "undefined") globalThis.Breaker = Breaker;

module.exports = { Breaker, createBreaker, SWALLOW_WARN_MS };
