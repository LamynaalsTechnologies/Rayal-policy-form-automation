/**
 * Stop an automation exactly where you put the call.
 *
 *   const { stopper } = require("../automationStopper");   // from fullPolicycompany/
 *   const { stopper } = require("./automationStopper");    // from the project root
 *
 *   await fillCustomerDetails(driver, data);
 *   stopper("Stopped after the customer details");         // <- nothing below runs
 *   await fillVehicleDetails(driver, data);
 *
 * Works for every company. Drop the call anywhere — top of the flow, deep
 * inside a helper, inside a loop — and the run ends there.
 *
 * WHY IT THROWS rather than returning a flag:
 *
 * A `return` only leaves the function it is written in. Called from inside
 * fillCustomerDetails, a returning stopper would end that helper and the flow
 * would carry straight on to the next step — the opposite of what you asked
 * for. Throwing unwinds the whole stack, so the call means the same thing
 * wherever it is written.
 *
 * The throw is NOT a failure. server.js recognises this error specifically and
 * reports the job as "stopped, automation not finished yet" — a calm log line,
 * no red banner, no retry, no CRITICAL audit entry. The job still is not marked
 * completed, because nothing was submitted to the insurer and showing the
 * operator a finished policy that does not exist would be far worse.
 */

/** Marker error thrown by stopper(). */
class AutomationStoppedError extends Error {
  constructor(message, details = {}) {
    super(message || "Automation stopped here on purpose");
    this.name = "AutomationStoppedError";
    // Checked instead of `instanceof`: a company module could end up loading a
    // second copy of this file through a different relative path, and two
    // copies of the class would fail instanceof while being the same thing.
    this.isAutomationStop = true;
    this.details = details;
    this.stoppedAt = new Date().toISOString();
  }
}

/**
 * Stop the automation here.
 *
 * @param {string} [message] - what this stopping point is, in words the
 *   operator will understand. It goes straight into the policy's error log.
 * @param {Object} [details] - anything worth carrying back (stage, page url…)
 * @throws {AutomationStoppedError} always
 */
function stopper(message, details = {}) {
  throw new AutomationStoppedError(message, details);
}

/** Was this thrown by stopper()? */
function isAutomationStop(error) {
  return !!error && error.isAutomationStop === true;
}

/**
 * The result object a form module should hand back for a stop.
 *
 * Use it in a company module's catch so the stop is not swallowed alongside
 * real errors:
 *
 *   } catch (error) {
 *     if (isAutomationStop(error)) {
 *       return stoppedResult(error, { pageUrl, _jobBrowser: jobBrowser });
 *     }
 *     ...normal error handling...
 *   }
 *
 * @param {Error} error - the AutomationStoppedError that was caught
 * @param {Object} [extra] - merged in; use it for pageUrl, screenshots, the
 *   browser handle, whatever the caller wants back
 */
function stoppedResult(error, extra = {}) {
  return {
    // Not a success: nothing was filed at the insurer.
    success: false,
    // Read by server.js — this is what turns the red failure banner into a
    // calm "stopped here" line.
    inProgress: true,
    // Running it again would stop at exactly the same place.
    retryable: false,
    stage: error?.details?.stage || "stopped",
    error:
      (error && error.message) ||
      "The automation stopped at a deliberate stopping point. Nothing is " +
      "wrong with this policy — the rest of the flow has not been built yet.",
    stoppedAt: error?.stoppedAt,
    stopDetails: error?.details || {},
    browserLeftOpen: true,
    ...extra,
  };
}

module.exports = {
  stopper,
  isAutomationStop,
  stoppedResult,
  AutomationStoppedError,
};
