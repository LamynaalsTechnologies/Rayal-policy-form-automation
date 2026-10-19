/**
 * KSHEMA in three steps — what kshemaForm.js (and its TP copy kshemaTPForm.js) calls (the owner, 2026-10-19).
 *
 *   1. proposal  login, the quote, add-ons, proposal PDF, nominee, the 2nd Save and Finalize -> the proposal page with
 *                the KYC button. Its address is saved (proposalLink + the step's `link`) the moment that page shows.
 *   2. kyc       the KYC on that page                                     -> skipped when an earlier run finished it
 *   3. payment   Make Payment, Razorpay, the QR                           -> only after the KYC; done = the payment page
 *                was reached (the QR still has to be paid by the customer, nothing moves money here)
 *
 * KSHEMA shows no proposal number, so a later run (Release after a Hold, a retry, "Update & run") finds the proposal by
 * its saved page: it logs in again (a fresh, empty browser profile every time) and opens that address. Whether KSHEMA
 * opens it after a new login is NOT proven live yet, so the page is checked — the KYC button or Make Payment must show,
 * or the run stops with a clear sentence and the operator sets Proposal back to Pending (a new quote).
 *
 * The step map, its rules and the database helpers are the Reliance ones (../reliance/relianceStages.js on
 * lib/relianceStagesCore.js): a part key belongs to one insurer, so onlinePolicy.relianceStages.<part> holds KSHEMA's
 * steps too and the History cards, reset, run-later and edit-clear work unchanged. No .env switch.
 *
 * Operator sentences carry no colon (beautifyError keeps only the text after the last colon). Database helpers never
 * throw: a bookkeeping write must not fail a run that did real work at KSHEMA.
 */
const { By } = require("selenium-webdriver");
const core = require("../../lib/relianceStagesCore");
const stages = require("../reliance/relianceStages");
const { log, warn } = require("./kshemaLog");

const INSURER = "KSHEMA";

/** The Make Payment button, exactly as proceedToPayment (kshemaQuoteForm.js) finds it. */
const MAKE_PAYMENT_XPATH =
  '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "make payment")] | //span[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "make payment")]/ancestor::button';

/** How long the saved proposal page gets to show the KYC button or Make Payment after it is opened. */
const SAVED_PAGE_WAIT_MS = 60000;
const POLL_MS = 1000;

const noColon = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/\s*:\s*/g, " - ").trim();

/** Where this run starts (the policy's steps for this part), with the resume line in the log. */
async function loadKshemaResume(data, { jobId = "", MongoClient } = {}) {
  const resume = await stages.loadResumePlan(data, { jobId, MongoClient, insurer: INSURER });
  if (resume.skipProposal) log(`▶ ${resumeWords(resume)}`);
  return resume;
}

/** "Resuming at the KYC with the saved proposal page ..." — what a resumed run does, in one line. */
function resumeWords(resume) {
  const at = resume.skipKyc
    ? "the payment (step 3)"
    : resume.skipPayment
    ? "the KYC (step 2) - KYC only, the payment is done"
    : "the KYC (step 2)";
  return `Resuming at ${at} with the saved proposal page from an earlier run - logging in again and opening it`;
}

/** Record a step on the policy (the Reliance helper, worded KSHEMA). Never throws. */
function markStage(data, stage, status, extra = {}, { jobId = "", MongoClient, now } = {}) {
  return stages.markStage(data, stage, status, extra, { jobId, MongoClient, now, insurer: INSURER });
}

/**
 * Step 1 finished: the proposal page (KYC button on it) is showing. Wait for it exactly as the KYC step always did
 * (awaitKycButton — the same patience and the same "why it did not come" reasons), then read its address.
 *
 * @returns {Promise<{ok:boolean, url?:string, landedOn?:"kyc", error?:string}>}
 */
async function awaitProposalPage(driver, data, { awaitKycButton = require("./kshemaAfterFinalize").awaitKycButton } = {}) {
  const waited = await awaitKycButton(driver, data);
  if (!waited || !waited.ok) return { ok: false, landedOn: null, error: (waited && waited.error) || "The KYC button did not appear" };
  let url = "";
  try {
    url = await driver.getCurrentUrl();
  } catch (e) {
    warn(`   Could not read the proposal page address - ${noColon(e && e.message)}`);
  }
  return { ok: true, url, landedOn: "kyc" };
}

/**
 * Save the proposal page now (proposalLink — it used to be saved only after the KYC) and mark step 1 completed with
 * it, in one write. Without an address nothing is marked: a later run then makes a new quote, as before. Never throws.
 */
async function keepProposalPage(data, url, { jobId = "", MongoClient, now = new Date() } = {}) {
  const link = String(url || "").trim();
  if (!/^https?:\/\//i.test(link)) {
    warn(`[${jobId}] ⚠️ The proposal page address could not be read - KSHEMA step Proposal is not marked, a later run makes a new quote.`);
    return false;
  }
  const policyId = stages.policyIdOf(data);
  if (!policyId) {
    warn(`[${jobId}] ⚠️ No policy id on the job - KSHEMA step Proposal = completed not saved.`);
    return false;
  }
  try {
    const set = core.stageSet(stages.stageKeyFor(data), "proposal", "completed", { link }, now);
    const result = await stages.withPolicies(MongoClient, (onlinePolicy) =>
      onlinePolicy.updateOne({ _id: policyId }, { $set: { ...set, proposalLink: link, updatedAt: now } })
    );
    log(`[${jobId}] 📌 KSHEMA stage Proposal = completed, proposal page saved (${stages.stageKeyFor(data)}, matched ${result.matchedCount})`);
    return result.matchedCount > 0;
  } catch (error) {
    warn(`[${jobId}] ⚠️ Could not save the KSHEMA proposal page - ${noColon(error && error.message)}`);
    return false;
  }
}

async function shownButton(driver, xpath, { mustBeEnabled = false } = {}) {
  try {
    const found = await driver.findElements(By.xpath(xpath));
    for (const el of found) {
      try {
        if (!(await el.isDisplayed())) continue;
        if (mustBeEnabled && !(await el.isEnabled())) continue;
        return true;
      } catch (e) { }
    }
  } catch (e) { }
  return false;
}

/** Which page the saved address showed — "kyc", "payment" or null (not yet / not at all). */
async function readLanding(driver, resume, { loaderVisible } = {}) {
  if (loaderVisible && (await loaderVisible())) return null;
  const { KYC_BUTTON_XPATH } = require("./kshemaAfterFinalize");
  const pay = await shownButton(driver, MAKE_PAYMENT_XPATH, { mustBeEnabled: true });
  if (pay && resume && resume.skipKyc) return "payment";
  if (await shownButton(driver, KYC_BUTTON_XPATH)) return "kyc";
  return pay ? "payment" : null;
}

/** The sentence when the saved page did not open (no colon, no address — an address has one). */
function savedPageNotOpenMessage(title = "") {
  const shown = noColon(title);
  return (
    "The saved KSHEMA proposal page did not open after the new login" +
    (shown ? ` (the portal showed "${shown}")` : "") +
    ". Set Proposal back to Pending in History to make a new quote"
  );
}

/**
 * A resumed run, after the new login: open the saved proposal page and check it really is that page.
 *
 * @param {Object} resume  loadKshemaResume's plan (proposalLink, skipKyc)
 * @returns {Promise<{ok:boolean, url?:string, landedOn?:"kyc"|"payment", step?:string|null, error?:string, pageUrl?:string}>}
 */
async function openSavedProposal(driver, resume, deps = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));
  const waitMs = deps.waitMs || SAVED_PAGE_WAIT_MS;
  const loaderVisible = deps.loaderVisible || (() => require("./kshemaAfterFinalize").isLoaderVisible(driver));
  const readStep = deps.readStep || require("./kshemaSaveVerify").readActiveStep;
  const link = String((resume && resume.proposalLink) || "").trim();

  if (!link) return { ok: false, landedOn: null, error: savedPageNotOpenMessage() };
  log("🔗 Opening the saved KSHEMA proposal page...");
  await driver.get(link);

  const started = now();
  for (;;) {
    const landedOn = await readLanding(driver, resume, { loaderVisible });
    if (landedOn) {
      const step = await readStep(driver);
      log(`   ✓ The saved proposal page opened - ${landedOn === "kyc" ? "the KYC button" : "Make Payment"} is showing${step ? ` (step "${step}")` : ""}`);
      return { ok: true, url: link, landedOn, step };
    }
    if (now() - started >= waitMs) break;
    await sleep(POLL_MS);
  }

  let title = "";
  let pageUrl = "";
  try {
    title = await driver.getTitle();
  } catch (e) { }
  try {
    pageUrl = await driver.getCurrentUrl();
  } catch (e) { }
  warn(`   ✖ The saved proposal page did not show the KYC button or Make Payment within ${Math.round(waitMs / 1000)}s (now on ${pageUrl || "an unknown page"})`);
  return { ok: false, landedOn: null, pageUrl, error: savedPageNotOpenMessage(title) };
}

/**
 * Step 3's record from proceedToPayment's result. Done = the payment page was reached (the owner's rule): an ok result
 * always carries the page address; the QR picture is noted when it is missing (the Razorpay part did not finish).
 *
 * @returns {{status:"completed"|"failed", extra:Object}}
 */
function paymentStageOf(paymentResult) {
  const r = paymentResult || {};
  if (!r.ok || !r.paymentUrl) {
    return { status: "failed", extra: { error: noColon(r.error || "The payment page was not reached") } };
  }
  return {
    status: "completed",
    extra: {
      mode: "qr",
      link: r.paymentUrl,
      ...(r.qrScreenshotKey ? {} : { note: noColon(`payment page reached, the QR picture was not taken${r.qrError ? ` (${r.qrError})` : ""}`) }),
    },
  };
}

module.exports = {
  INSURER,
  MAKE_PAYMENT_XPATH,
  SAVED_PAGE_WAIT_MS,
  loadKshemaResume,
  resumeWords,
  markStage,
  awaitProposalPage,
  keepProposalPage,
  readLanding,
  openSavedProposal,
  savedPageNotOpenMessage,
  paymentStageOf,
};
