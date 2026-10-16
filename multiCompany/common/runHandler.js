/**
 * The ONE wrapper every OD/TP handler runs inside.
 *
 *   gate → open browser → record → LOGIN → handler body → result → always clean up
 *
 * A handler is then only its body — the part that is actually specific to that
 * insurer and policy type. Login, loading detection, invalid-credential
 * handling, failure screenshots and browser cleanup are identical for all six
 * handlers because they are done here, once.
 *
 * Returns the result object server.js already understands:
 *   success / stopped  → whatever the body returned, or stoppedResult(...)
 *   failure            → failureResult(...): success:false, errorCode, retryable,
 *                        stage, error, screenshot fields. `retryable:false`
 *                        (bad password, locked account ...) ends the job at once
 *                        instead of burning its retries — server.js already
 *                        honours that flag.
 * The one thing that THROWS is the feature gate ([E110]) — it runs before any
 * browser, database or S3 call exists to clean up.
 */
const { startRecording } = require("../../lib/jobRecorder");
const { stopper, isAutomationStop, stoppedResult } = require("../../automationStopper");
require("../../breaker"); // defines the global `Breaker`, usable in any handler body
const { assertMultiCompanyEnabled } = require("./featureGate");
const { openJobBrowser, closeJobBrowser } = require("./browser");
const { login } = require("./login");
const { captureFailure } = require("./screenshot");
const { failureResult } = require("./errors");

/**
 * @param {Object} opts
 * @param {"reliance"|"national"|"kshema"} opts.company
 * @param {"od"|"tp"} opts.policyType
 * @param {Object} opts.data   the job payload server.js hands every handler
 * @param {Function} opts.body async (ctx) => result | void. ctx = { driver,
 *   data, settings, jobId, log, capture, stop }. Call ctx.stop(msg, {stage})
 *   to end the run deliberately.
 */
async function runHandler({ company, policyType, data = {}, body }) {
  assertMultiCompanyEnabled();

  const jobId = `${policyType}_${company}_${data.firstName || "Job"}_${Date.now()}`;
  const log = (line) => console.log(line);
  const attempt = data._attemptNumber || 1;

  let jobBrowser = null;
  // True on a real error AND on a deliberate stop: these flows are still being
  // built, so every stop leaves the browser open (when KEEP_BROWSER_OPEN_ON_ERROR
  // is set) for the developer to see what state the page landed in.
  let hadError = false;

  try {
    jobBrowser = await openJobBrowser(company, jobId);
    const driver = jobBrowser.driver;

    // No-op unless RECORDING_ENABLED.
    startRecording(driver, data._jobId, attempt, { label: jobId });

    await login(
      driver,
      company,
      { username: data.username, password: data.password, loginUrl: data.loginUrl },
      { jobId, log }
    );

    const ctx = {
      driver,
      data,
      // { isMultipleCompany, PACompany, ODCompany, TPCompany } — see the
      // backend's shared/policySettings.js. Null on a job queued before it existed.
      settings: data.settings || null,
      jobId,
      log,
      capture: (name, stage) => captureFailure(driver, { company, jobId, attempt }, stage || name),
      stop: stopper,
    };

    const result = await body(ctx);
    const outcome = result && typeof result === "object" ? result : { success: true };
    // A handler that RETURNS a failure (or a deliberate stop) rather than throwing is not a completed job: its window
    // follows KEEP_BROWSER_OPEN_ON_ERROR like a thrown one. Only a completed job follows CLOSE_BROWSER_AFTER_COMPLETE.
    if (outcome.success === false || outcome.inProgress === true) hadError = true;
    return outcome;
  } catch (error) {
    hadError = true;
    if (isAutomationStop(error)) {
      return stoppedResult(error, { _jobBrowser: jobBrowser });
    }
    const shot = jobBrowser
      ? await captureFailure(jobBrowser.driver, { company, jobId, attempt })
      : {};
    console.error(`❌ [${jobId}] ${company} ${policyType.toUpperCase()} failed: ${error.message}`);
    return failureResult(error, shot);
  } finally {
    if (jobBrowser) await closeJobBrowser(company, jobBrowser, { hadError });
  }
}

module.exports = { runHandler };
