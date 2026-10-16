/**
 * Did "Save and Continue" really move the KSHEMA quote on? Used by the TP-only flow (kshemaTPQuoteForm.js, [TP] 11).
 *
 * Why (2026-10-16): a TP-only run showed KSHEMA's toast "System Error More than one rate found for rate" after Save and
 * Continue and the automation did not see it. It went on to the Add-ons step although that page never opened, and the
 * toast was finally read after an unrelated click and blamed on "Do you want add-ons?".
 *
 * Proved from the still-open window of that run: the portal was on the QUOTE step (its step bar marks the active step
 * `.stepper-item-text.stepper-active`: Quote / Addon / Summary / Customer Details / Other Details), and "Save and
 * Finalize" is a permanent button on the Quote page, next to Save and Continue. The TP copy took "the Save and Finalize
 * button or the quote-download icon is visible" as "the next page opened" ([TP] 5, an unverified guess), which is true
 * on the first poll - before KSHEMA has even answered the click.
 *
 * So, behind KSHEMA_SAVE_VERIFY_ENABLED (ON unless false / 0 / no / off; off = exactly the old test and wording):
 *
 *   nextPageShown   the page moved only when the active step is no longer "Quote". A step bar that cannot be read
 *                   falls back to the old test with a warning (no new way to fail).
 *   lateRefusal     after "moved", watch a settle window (KSHEMA_SAVE_SETTLE_MS, default 3000) for an error toast or
 *                   for the step falling back to "Quote" - a refusal that arrives a moment after the page changed.
 *   addonsPageVerdict  nothing on the Add-ons page is answered unless the Addon step is really open.
 *
 * Every sentence for the operator is plain and has no colon (beautifyError keeps only the text after the last one).
 */
const { log, warn } = require("./kshemaLog");

const POLL_MS = 500;

/** ON unless KSHEMA_SAVE_VERIFY_ENABLED is false / 0 / no / off. Read at call time. */
const isSaveVerifyEnabled = () => !/^(false|0|no|off)$/i.test(String(process.env.KSHEMA_SAVE_VERIFY_ENABLED ?? "").trim());

/** The settle window: KSHEMA_SAVE_SETTLE_MS, default 3000, kept within 1000-15000. */
const settleWindowMs = () => {
  const asked = parseInt(process.env.KSHEMA_SAVE_SETTLE_MS, 10);
  const ms = Number.isFinite(asked) && asked > 0 ? asked : 3000;
  return Math.min(Math.max(ms, 1000), 15000);
};

/** One line, no colon, safe to put in the operator's message. */
const plain = (text) =>
  String(text == null ? "" : text)
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .replace(/:/g, " -")
    .trim();

const isQuoteStep = (step) => /^quote$/i.test(String(step == null ? "" : step).trim());
const isAddonStep = (step) => /^add[\s-]?ons?$/i.test(String(step == null ? "" : step).trim());

/** In the page: the text of the step bar's active step ("Quote", "Addon", "Summary" ...), or null. */
function readActiveStepInPage() {
  var el = document.querySelector(".stepper-item-text.stepper-active");
  if (!el) return null;
  var text = String(el.textContent || "").replace(/\s+/g, " ").trim();
  return text || null;
}

/** The active step of KSHEMA's step bar, or null when it cannot be read (no bar, a page between steps, a script error). */
async function readActiveStep(driver) {
  try {
    const step = await driver.executeScript(readActiveStepInPage);
    return typeof step === "string" && step.trim() ? step.trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * The test the TP copy used before ([TP] 5): the proposal page's "Save and Finalize" button or the quote-download icon.
 * Both are ON the Quote page too, so this says "moved" whether or not it did. Kept only as the way back (switch off) and
 * as the fallback when the step bar cannot be read.
 */
async function legacyNextPageShown(driver) {
  try {
    const { asLocator } = require("./kshemaFields");
    const found = await driver.findElements(
      asLocator('//button[contains(., "Save and Finalize")] | //mat-icon[@data-iid="dnld-download-quote"]')
    );
    return found.length > 0 && (await found[0].isDisplayed());
  } catch (e) {
    return false;
  }
}

const warned = new WeakSet();
function warnOnce(driver, text) {
  if (driver && typeof driver === "object") {
    if (warned.has(driver)) return;
    warned.add(driver);
  }
  warn(text);
}

/**
 * Has the page moved past the Quote step? One look; the caller polls.
 *
 * @param {Object} driver
 * @param {Object} [deps]  test seams: readStep(driver), legacy(driver)
 * @returns {Promise<boolean>}
 */
async function nextPageShown(driver, deps = {}) {
  const legacy = deps.legacy || legacyNextPageShown;
  if (!isSaveVerifyEnabled()) return legacy(driver);
  const step = await (deps.readStep || readActiveStep)(driver);
  if (step === null) {
    warnOnce(driver, "   ⚠️ Could not read KSHEMA's step bar - using the old next-page test (the Save and Finalize button)");
    return legacy(driver);
  }
  return !isQuoteStep(step);
}

/** The sentence when KSHEMA answered Save and Continue with an error message. */
function refusalMessage(portalText) {
  const said = plain(portalText);
  if (!isSaveVerifyEnabled()) return `Portal rejected the submission: "${portalText}"`;
  return (
    `KSHEMA refused Save and Continue - its message was "${said}". The run stopped there and nothing after the quote ` +
    "was filled. Compare the policy with the same quote made by hand on the portal, then run the policy again."
  );
}

/** The sentence when the refusal came a moment after the page had already changed. */
function lateRefusalMessage(portalText) {
  return (
    `KSHEMA opened the next step and then showed an error - its message was "${plain(portalText)}". The run stopped ` +
    "there. Compare the policy with the same quote made by hand on the portal, then run the policy again."
  );
}

/**
 * The sentence when Save and Continue did not open the next page and no error message was classified as one. `fallback`
 * is the form's old sentence (what the switch-off path keeps); the portal's own words are added when KSHEMA showed a
 * message that was not recognised as an error.
 */
function silentMessage(fallback, toastText, seconds = 15) {
  if (!isSaveVerifyEnabled()) return fallback;
  const said = plain(toastText);
  return (
    `Save and Continue did not open the next page within ${seconds} seconds. ` +
    (said ? `KSHEMA showed "${said}" and nothing else. ` : "No error message appeared. ") +
    "There might be a silent validation error on the quote form. Please check the screenshot."
  );
}

/**
 * After the page moved: keep watching for a moment. KSHEMA can answer Save and Continue with the next step and then raise
 * its server error (or send the quote back to the Quote step) a second later.
 *
 * @param {Object} driver
 * @param {Object} [o]
 * @param {Function} [o.readToast]  async (driver) -> { text, isError } | null
 * @param {Function} [o.readStep]   async (driver) -> the active step | null
 * @param {Function} [o.sleep]      async (ms)
 * @param {number}   [o.settleMs]   override the window (tests)
 * @returns {Promise<null | {ok:false, error:string, toast?:string}>} null = quiet
 */
async function lateRefusal(driver, { readToast, readStep, sleep, settleMs } = {}) {
  if (!isSaveVerifyEnabled()) return null;
  const toastOf = readToast || require("./kshemaToast").readToast;
  const stepOf = readStep || readActiveStep;
  const pause = sleep || ((ms) => driver.sleep(ms));
  const windowMs = Number.isFinite(settleMs) ? settleMs : settleWindowMs();
  const end = Date.now() + windowMs;
  let lastStep = null;

  for (;;) {
    let toast = null;
    try {
      toast = await toastOf(driver);
    } catch (e) {
      toast = null;
    }
    // "asking about add-ons" is the portal's own, expected message on the next page (as in the wait loop)
    if (toast && toast.isError && !/add-ons/i.test(String(toast.text || ""))) {
      return { ok: false, error: lateRefusalMessage(toast.text), toast: toast.text };
    }

    const step = await stepOf(driver);
    if (step) lastStep = step;
    if (step && isQuoteStep(step)) {
      return {
        ok: false,
        error:
          "KSHEMA opened the next step and then went back to the Quote step. The run stopped there. " +
          "Check the screenshot, then run the policy again.",
      };
    }

    if (Date.now() >= end) break;
    await pause(POLL_MS);
  }

  log(
    lastStep
      ? `   ✓ KSHEMA is on the "${plain(lastStep)}" step and showed no error for ${Math.round(windowMs / 100) / 10} s`
      : `   ✓ KSHEMA showed no error for ${Math.round(windowMs / 100) / 10} s after Save and Continue`
  );
  return null;
}

/**
 * Before anything is answered on the Add-ons page: is that page really open?
 *
 * @returns {Promise<{run:true} | {run:false, error:string} | {run:false, skip:string}>}
 *   run   answer the page's questions as before
 *   error the quote is still on the Quote step - answering would click Yes/No groups of the QUOTE form
 *   skip  another step (Summary ...) is open: there is no add-ons question to answer
 */
async function addonsPageVerdict(driver, { readStep } = {}) {
  if (!isSaveVerifyEnabled()) return { run: true };
  const step = await (readStep || readActiveStep)(driver);
  if (step === null || isAddonStep(step)) return { run: true };
  if (isQuoteStep(step)) {
    return {
      run: false,
      error:
        "The Add-ons page is not open - KSHEMA's step bar still shows Quote, so Save and Continue did not move the " +
        "quote on. Nothing was answered.",
    };
  }
  return { run: false, skip: `KSHEMA is on the "${plain(step)}" step, not the Addon step - there is no add-ons question to answer` };
}

/** KSHEMA's own, expected message when the Add-ons page opens. */
const isAddonsToast = (text) => /add-ons/i.test(String(text || ""));

/**
 * [TP] 12: the loader wait after Save and Continue, reading KSHEMA's message while the spinner is still up. The old wait
 * looked only at the spinner (up to 30 s), so a message shown during it could be gone before anyone read it.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {Function} o.waitLoader  async (driver, ms) - resolves when the spinner is gone, throws after ms
 * @param {Function} o.readToast   async (driver) -> { text, isError } | null
 * @param {number}   [o.timeoutMs] default 30000
 * @returns {Promise<{ toast: {text:string,isError:boolean} | null, loaderGone: boolean }>}  the last message seen
 */
async function waitLoaderWatchingToast(driver, { waitLoader, readToast, timeoutMs = 30000 }) {
  const end = Date.now() + timeoutMs;
  let seen = null;
  for (;;) {
    try {
      const toast = await readToast(driver);
      if (toast && toast.text && !isAddonsToast(toast.text)) {
        seen = toast;
        if (toast.isError) return { toast: seen, loaderGone: false };
      }
    } catch (e) { }
    try {
      await waitLoader(driver, 1000);
      return { toast: seen, loaderGone: true };
    } catch (e) { }
    if (Date.now() >= end) return { toast: seen, loaderGone: false };
  }
}

/**
 * [TP] 12: Save and Continue did not open the next step and KSHEMA showed a message. That message is the answer. Stop
 * here. Do not fill fields again or press Save again, and do not go on to the next steps (on 2026-10-16 the run went on
 * and the quote form was left empty). Null when the switch is off or there was no message.
 */
function refusalWhenStuck(toastText) {
  if (!isSaveVerifyEnabled()) return null;
  const said = plain(toastText);
  if (!said || isAddonsToast(said)) return null;
  return { ok: false, error: refusalMessage(toastText), toast: toastText };
}

module.exports = {
  isSaveVerifyEnabled,
  isAddonsToast,
  waitLoaderWatchingToast,
  refusalWhenStuck,
  settleWindowMs,
  readActiveStepInPage,
  readActiveStep,
  legacyNextPageShown,
  isQuoteStep,
  isAddonStep,
  nextPageShown,
  refusalMessage,
  lateRefusalMessage,
  silentMessage,
  lateRefusal,
  addonsPageVerdict,
};
