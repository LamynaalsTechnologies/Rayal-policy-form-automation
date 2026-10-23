/**
 * KSHEMA wallet — Pay with CD Balance, the policy number and the policy PDF (2026-10-22).
 *
 * After the CD Balance card is chosen (kshemaWalletPayment.js, with an available balance above zero), the owner's steps:
 *   press "Pay with CD Balance" -> KSHEMA takes the amount from the CD account and in 15-30 s opens its policy page
 *   (/app/policy?policy_id=P000000432856&err=0&msg=Paymentupdated&key=...) -> wait at most 40 s (an error toast or no page =
 *   error) -> copy the Policy Number of the Summary table -> download the policy PDF (mat-icon dnld-download-policy) ->
 *   the policy is completed with its number and PDF.
 *
 * It REALLY PAYS, so it is built like Reliance's wallet issue (../reliance/relianceWalletIssue.js) and reuses its parts:
 *   0. GATE (checkKshemaWalletGate + decideKshemaGate, start of the run, before any browser): a payment already pressed for
 *      this policy (note walletPayment[_part] in state submit-pressed / unconfirmed) is never pressed again - the run is
 *      refused. An ISSUED one is finished instead (recoverKshemaIssue: the saved policy page, the number, the PDF) or, when
 *      its number and PDF are both stored, simply completed. Nothing is paid again either way.
 *   1. the premium KSHEMA asks (its top bar, "INR 6,437") against the CD balance - lower = error, nothing pressed (the
 *      owner's choice). The premium is kept as insurerPayable.<part> so the View page shows it beside our own figure.
 *   2. the button shown and enabled, no KSHEMA error toast.
 *   3. the note FIRST (a guarded write that fails when a blocking note exists). Not saved = not pressed.
 *   4. Pay with CD Balance pressed ONCE (clickOnce - a script click only when the real one was refused before it happened).
 *   5. its policy page waited for, 40 s at most. An error toast, no page, err != 0 or the login page: the note becomes
 *      `unconfirmed` and the policy is not run again by itself (the owner's choice) - the money may have been taken.
 *   6. the number read from the Summary table and saved at once (online policy + Policy List record, first writer wins).
 *   7. the PDF downloaded (a NEW file in the job's folder - the proposal PDF downloaded earlier is not taken for it), stored
 *      in the bucket's Policy folder (no expiry) and set as the policy's file (policyFile + mergedPolicyPdf, the View page's
 *      policy PDF).
 *
 * Every function takes the driver, the clock, the store, the toast reader, the file system and the uploader as arguments
 * (deps), so all of it is tested with fakes. Operator sentences carry no colon (beautifyError keeps only what follows the
 * last one). No .env switch.
 */
const fs = require("fs");
const { By } = require("selenium-webdriver");
const { log, warn } = require("./kshemaLog");
const issue = require("../reliance/relianceWalletIssue");
const { parseRupees, formatPaise, isStop } = require("../reliance/relianceWalletCdt");

const { STATES } = issue;
const INSURER = "KSHEMA";
const METHOD = "CD Balance";

const TIMING = {
  buttonWaitMs: 10000,
  policyPageWaitMs: 40000, // the owner: "maximum 40 sec waiting to navigate then error"
  toastGraceMs: 5000, // an error toast: a few seconds for the policy page to open anyway before it counts
  numberWaitMs: 20000,
  pollMs: 1000,
  logEveryMs: 10000,
  iconWaitMs: 15000,
  pdfWaitMs: 60000,
  pdfPollMs: 500,
  pdfStableMs: 1500,
};

const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const noColon = (s) => norm(s).replace(/\s*:\s*/g, " - ");
const noEndStop = (s) => norm(s).replace(/[.\s]+$/, "");
const rupees = (paise) => `₹${formatPaise(paise)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "22 Oct 2026 15.44" - no colon. */
function whenText(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

/* -------------------------------------------------------------------------- */
/* In the page                                                                */
/* -------------------------------------------------------------------------- */

/** Every shown "Pay with CD Balance" button: [[element, text, enabled], ...]. */
const PAY_BUTTON_SCRIPT = `
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  var shown = function (el) {
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  var found = [];
  var all = document.querySelectorAll('button');
  for (var i = 0; i < all.length; i++) {
    var b = all[i];
    if (!shown(b) || !/^pay with cd balance$/i.test(norm(b.innerText))) continue;
    found.push([b, norm(b.innerText), !b.disabled && b.getAttribute('aria-disabled') !== 'true']);
  }
  return found;
`;

/**
 * The premium in KSHEMA's top bar ("INR 6,437"): the distinct texts of shown elements whose OWN text is "INR <amount>",
 * in the top 150 px of the page (scrolled to the top first). Elsewhere on a page an INR figure may be something else.
 */
const PREMIUM_SCRIPT = `
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  try { window.scrollTo(0, 0); } catch (e) {}
  var out = [];
  var all = document.querySelectorAll('body *');
  for (var i = 0; i < all.length; i++) {
    var el = all[i];
    var own = '';
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
    own = norm(own);
    if (!/^INR\\s*\\d[\\d,]*(?:\\.\\d{1,2})?$/i.test(own)) continue;
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (r.top < 0 || r.top > 150) continue;
    if (out.indexOf(own) === -1) out.push(own);
  }
  return out;
`;

/**
 * The Policy Number of the policy page's Summary table: the .summary-item-cell after the one that says "Policy Number"
 * (the owner's pasted markup), or - anywhere else - the element after a "Policy Number" label. {label, value}.
 */
const POLICY_NUMBER_SCRIPT = `
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  var cells = document.querySelectorAll('.summary-item-cell');
  for (var i = 0; i < cells.length; i++) {
    if (norm(cells[i].textContent).toLowerCase() !== 'policy number') continue;
    var next = cells[i].nextElementSibling;
    while (next && !(next.classList && next.classList.contains('summary-item-cell'))) next = next.nextElementSibling;
    if (next) return { label: true, value: norm(next.textContent) };
  }
  var all = document.querySelectorAll('div, span, td, th, p, label');
  for (var j = 0; j < all.length; j++) {
    var el = all[j];
    if (el.children.length > 0 || norm(el.textContent).toLowerCase() !== 'policy number') continue;
    var cell = el.closest('.summary-item-cell, td, th') || el;
    var sib = cell.nextElementSibling;
    if (sib) return { label: true, value: norm(sib.textContent) };
  }
  return { label: false, value: '' };
`;

const POLICY_ICON_CSS = 'mat-icon[data-iid="dnld-download-policy"]';

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * KSHEMA's policy page from an address, or null. /app/policy?policy_id=P000000432856&err=0&msg=Paymentupdated&key=...
 * -> { url, policyId, err, msg }.
 */
function readPolicyPageUrl(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch (e) {
    return null;
  }
  if (!/^\/app\/policy\/?$/i.test(u.pathname)) return null;
  return { url: String(url), policyId: u.searchParams.get("policy_id") || "", err: u.searchParams.get("err"), msg: u.searchParams.get("msg") || "" };
}

/** A policy page that says all is well: err=0 (or no err at all). */
const isGoodPolicyPage = (page) => !!page && (page.err === null || String(page.err).trim() === "0");

/** "INR 6,437" texts of the top bar -> paise, when there is exactly ONE amount; null otherwise. */
function premiumOf(texts) {
  const amounts = [...new Set((texts || []).map((t) => parseRupees(norm(t))).filter((p) => Number.isInteger(p) && p > 0))];
  return amounts.length === 1 ? amounts[0] : null;
}

/**
 * The failure result a form returns for a wallet issue that did not finish. A payment that may have happened (or did) is a
 * post-submission failure: never retried by itself (the gate refuses a re-run anyway).
 */
function failureResultOf(r = {}) {
  return r.paid
    ? { stage: "post-submission", postSubmissionFailed: true, retryable: false, error: r.error, walletState: r.state || null }
    : { stage: "payment", retryable: false, error: r.error, walletState: r.state || null };
}

/* -------------------------------------------------------------------------- */
/* Messages (no colon)                                                        */
/* -------------------------------------------------------------------------- */

/** What the operator reads when a run is refused because a CD Balance payment was already pressed for the policy. */
function kshemaGateMessage(marker = {}, field = "walletPayment") {
  const amount = Number.isInteger(marker.amountPaise) && marker.amountPaise > 0 ? `${rupees(marker.amountPaise)}, ` : "";
  const when = marker.at && whenText(marker.at) ? `on ${whenText(marker.at)}, ` : "";
  const outcome =
    marker.state === STATES.UNCONFIRMED
      ? "and KSHEMA's answer was never confirmed"
      : marker.state === STATES.ISSUED
      ? "and the policy was issued but its page was not kept"
      : "and its result was never recorded";
  const number = marker.policyNumber ? ` The policy number is ${noColon(marker.policyNumber)}.` : "";
  return noColon(
    `A CD Balance payment was already made for this policy at KSHEMA (${amount}${when}state ${marker.state}) ${outcome}.${number} ` +
      `This run was not started so the CD account is not charged twice. Check the policy at KSHEMA, then clear the ${field} ` +
      "note on the online policy before running it again"
  );
}

function unconfirmedMessage(why, amountPaise) {
  return noColon(
    `Pay with CD Balance was pressed${Number.isInteger(amountPaise) ? ` for ${rupees(amountPaise)}` : ""} and ${why}. ` +
      "The payment may have gone through. Check the policy at KSHEMA before running it again - it is marked so that it is not run again by itself"
  );
}

/* -------------------------------------------------------------------------- */
/* Page helpers                                                               */
/* -------------------------------------------------------------------------- */

/** The premium KSHEMA shows in its top bar, or { paise: null } when it cannot be read for certain. Never throws. */
async function readKshemaPremium(driver) {
  try {
    const texts = (await driver.executeScript(PREMIUM_SCRIPT)) || [];
    return { texts, paise: premiumOf(texts) };
  } catch (e) {
    if (isStop(e)) throw e;
    return { texts: [], paise: null, error: (e && e.message) || String(e) };
  }
}

async function findPayButton(driver, { timeoutMs, pollMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  let last = [];
  for (;;) {
    try {
      last = (await driver.executeScript(PAY_BUTTON_SCRIPT)) || [];
    } catch (e) {
      if (isStop(e)) throw e;
      last = [];
    }
    const enabled = last.filter((b) => b && b[2]);
    if (last.length === 1 && enabled.length === 1) return { ok: true, element: last[0][0] };
    if (last.length > 1) return { ok: false, why: "more than one" };
    if (now() >= deadline) return { ok: false, why: last.length ? "switched off" : "missing" };
    await sleep(pollMs);
  }
}

async function windowHandles(driver) {
  try {
    return await driver.getAllWindowHandles();
  } catch (e) {
    if (isStop(e)) throw e;
    return null;
  }
}

/**
 * Wait for KSHEMA's policy page after the press (this window, or a tab it opened). Returns one of
 *   { kind: "issued", page }            the policy page, err=0
 *   { kind: "page-error", page }        the policy page with an error flag
 *   { kind: "toast", words }            an error toast, and no policy page within the grace that followed
 *   { kind: "lost-session", url }       KSHEMA's login page
 *   { kind: "timeout", url, words }     nothing within the wait
 */
async function awaitPolicyPage(driver, { handlesBefore = null, home = null, readToast, timing, now, sleep }) {
  const started = now();
  let lastLog = started;
  let toastAt = null;
  let toastWords = "";
  const seenHandles = new Set(handlesBefore || []);
  for (;;) {
    let url = "";
    try {
      url = (await driver.getCurrentUrl()) || "";
    } catch (e) {
      if (isStop(e)) throw e;
    }
    let page = readPolicyPageUrl(url);
    if (!page && handlesBefore) {
      const handles = (await windowHandles(driver)) || [];
      for (const h of handles) {
        if (seenHandles.has(h)) continue;
        seenHandles.add(h);
        try {
          await driver.switchTo().window(h);
          const tabUrl = (await driver.getCurrentUrl()) || "";
          const tabPage = readPolicyPageUrl(tabUrl);
          if (tabPage) {
            log(`   ↗️  KSHEMA opened its policy page in a new tab - following it`);
            page = tabPage;
            break;
          }
          if (home) await driver.switchTo().window(home); // not the policy page: back to the run's own window
        } catch (e) {
          if (isStop(e)) throw e;
        }
      }
    }
    if (page) return { kind: isGoodPolicyPage(page) ? "issued" : "page-error", page, waitedMs: now() - started };
    if (/\/(login|signin|sign-in)\b/i.test(url)) return { kind: "lost-session", url };

    let toast = null;
    try {
      toast = await readToast(driver);
    } catch (e) {
      if (isStop(e)) throw e;
    }
    if (toast && toast.isError && toast.text && toastAt === null) {
      toastAt = now();
      toastWords = toast.text;
      warn(`   KSHEMA showed "${noColon(toast.text)}" after Pay with CD Balance`);
    }
    if (toastAt !== null && now() - toastAt >= timing.toastGraceMs) return { kind: "toast", words: toastWords, url };
    if (now() - started >= timing.policyPageWaitMs) return { kind: "timeout", url, words: toastWords };
    if (now() - lastLog >= timing.logEveryMs) {
      lastLog = now();
      log(`   … waiting for KSHEMA's policy page (${Math.round((now() - started) / 1000)}s of ${Math.round(timing.policyPageWaitMs / 1000)}s)`);
    }
    await sleep(timing.pollMs);
  }
}

/** The Policy Number of the policy page, read until it is a plausible number. {ok, number, raw}. */
async function readPolicyNumber(driver, { timing, now, sleep }) {
  const deadline = now() + timing.numberWaitMs;
  let raw = "";
  for (;;) {
    try {
      const got = (await driver.executeScript(POLICY_NUMBER_SCRIPT)) || {};
      raw = norm(got.value);
      const number = issue.normalisePolicyNumber(raw);
      if (raw && issue.isPlausiblePolicyNumber(number)) return { ok: true, number, raw };
    } catch (e) {
      if (isStop(e)) throw e;
    }
    if (now() >= deadline) return { ok: false, number: "", raw };
    await sleep(timing.pollMs);
  }
}

/** Back to the run's own window, closing any other one (a PDF viewer tab the download icon may open). */
async function closeOtherWindows(driver, home) {
  if (!home) return;
  try {
    for (const h of (await driver.getAllWindowHandles()) || []) {
      if (h === home) continue;
      try {
        await driver.switchTo().window(h);
        await driver.close();
      } catch (e) {
        /* already gone */
      }
    }
    await driver.switchTo().window(home);
  } catch (e) {
    if (isStop(e)) throw e;
  }
}

/**
 * The policy PDF: the download icon of the policy page, then a NEW finished PDF in the job's download folder (Reliance's
 * waitForDownloadedPdf - the folder's files before the click are not taken). {ok, path, name, size, truncated} | {ok:false, message}.
 */
async function downloadKshemaPolicyPdf(driver, { downloadDir, timing, now, sleep, fsImpl = fs }) {
  if (!downloadDir || !(fsImpl.existsSync ? fsImpl.existsSync(downloadDir) : true)) {
    return { ok: false, message: "this job has no download folder to take the PDF into" };
  }
  const deadline = now() + timing.iconWaitMs;
  let icon = null;
  for (;;) {
    try {
      for (const el of (await driver.findElements(By.css(POLICY_ICON_CSS))) || []) {
        if (await el.isDisplayed()) {
          icon = el;
          break;
        }
      }
    } catch (e) {
      if (isStop(e)) throw e;
    }
    if (icon || now() >= deadline) break;
    await sleep(timing.pollMs);
  }
  if (!icon) return { ok: false, message: "the policy download icon is not on the policy page" };

  const before = issue.listFiles(downloadDir, fsImpl);
  let home = null;
  try {
    home = await driver.getWindowHandle();
  } catch (e) {
    if (isStop(e)) throw e;
  }
  const click = await issue.clickOnce(driver, icon);
  if (!click.clicked) return { ok: false, message: `the policy download icon could not be clicked (${noColon(click.error)})` };
  log("   📥 Policy PDF download asked for - waiting for the file");
  const got = await issue.waitForDownloadedPdf({
    dir: downloadDir,
    before,
    timeoutMs: timing.pdfWaitMs,
    pollMs: timing.pdfPollMs,
    stableMs: timing.pdfStableMs,
    now,
    sleep,
    fsImpl,
  });
  await closeOtherWindows(driver, home);
  if (!got.ok) return { ok: false, message: got.reason === "not-pdf" ? noColon(got.detail) : `no PDF arrived in ${Math.round(timing.pdfWaitMs / 1000)} seconds` };
  return { ok: true, path: got.path, name: got.name, size: got.size, truncated: got.truncated };
}

/** The default uploader: the bucket's Policy folder (no expiry), private - the same place Reliance's policy PDFs go. */
async function defaultUploadPolicyPdf(filePath, { key }) {
  const { uploadToS3 } = require("../../s3Uploader");
  const location = await uploadToS3(filePath, key);
  return { key, location: location || "" };
}

/**
 * The PDF of an issued policy stored and set on the policy. {ok, file, saved} | {ok:false, message}. Never throws.
 */
async function storePolicyPdf(pdf, { store, policyDocId, uploadPolicyPdf, names }) {
  let stored;
  try {
    stored = await uploadPolicyPdf(pdf.path, { key: names.key, fileName: names.fileName });
  } catch (e) {
    if (isStop(e)) throw e;
    return { ok: false, message: `it could not be stored (${noColon((e && e.message) || e)})` };
  }
  const file = { fileName: names.fileName, key: (stored && stored.key) || names.key, location: (stored && stored.location) || "" };
  const saved = await store.savePdf(file, policyDocId);
  return { ok: true, file, saved };
}

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/** The note of this policy (part) as the start-of-run gate reads it - Reliance's checkSubmitGate. Never throws. */
function checkKshemaWalletGate(data = {}, jobId = "", { MongoClient } = {}) {
  return issue.checkSubmitGate(data, jobId, { MongoClient });
}

/**
 * What the gate's answer means for this run.
 *   go      no note that blocks - the normal run
 *   done    ISSUED with its number and PDF stored - nothing is left, the run completes at once
 *   recover ISSUED with its policy page kept - the number / PDF are fetched from that page; nothing is paid again
 *   refuse  pressed / unconfirmed (or issued without a page) - the run is not started, the CD account is not charged twice
 */
function decideKshemaGate(gate, data = {}) {
  if (!gate || !gate.blocked) return { action: "go" };
  const field = issue.markerFieldFor(data || {});
  const marker = gate.marker || {};
  if (gate.state === STATES.ISSUED) {
    const number = issue.normalisePolicyNumber(marker.policyNumber);
    if (number && issue.isPlausiblePolicyNumber(number) && marker.pdfStoredAt) return { action: "done", number, marker };
    if (readPolicyPageUrl(marker.policyPageUrl)) return { action: "recover", marker };
  }
  return { action: "refuse", message: kshemaGateMessage(marker, field) };
}

/* -------------------------------------------------------------------------- */
/* Pay with CD Balance, the number, the PDF                                   */
/* -------------------------------------------------------------------------- */

/**
 * After the CD Balance card is chosen: the amount check, the note, ONE press, the policy page, the number, the PDF.
 *
 * @param {Object} o
 * @param {Object}   o.driver
 * @param {Object}   o.data           the job data (_id / policyId, _partKey, _jobId ...)
 * @param {string}   o.jobId
 * @param {Object}   o.choice         chooseCdBalance's result (balance, paymentUrl)
 * @param {string}   o.downloadDir    this job's own download folder
 * @param {Function} [o.capture]      (name, stage) -> {screenshotUrl, screenshotKey} - a picture, uploaded
 * @param {Object}   [o.deps]         { store, MongoClient, readToast, uploadPolicyPdf, now, sleep, fsImpl, timing, policyFileNames }
 * @returns {Promise<{ok:true, policyNumber, policyPageUrl, kshemaPolicyId, premiumPaise, file, saved, warning}
 *                  |{ok:false, code, error, paid:boolean, state, policyNumber?, policyPageUrl?}>}
 */
async function payWithCdBalanceAndIssue(o = {}) {
  const { driver, data = {}, jobId = "", choice = {}, downloadDir = "", deps = {} } = o;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));
  const fsImpl = deps.fsImpl || fs;
  const timing = { ...TIMING, ...(deps.timing || {}) };
  const readToast = deps.readToast || require("./kshemaToast").readToast;
  const uploadPolicyPdf = deps.uploadPolicyPdf || defaultUploadPolicyPdf;
  const fileNames = deps.policyFileNames || issue.policyFileNames;
  const fail = (code, error, extra = {}) => ({ ok: false, code, error: noColon(error), paid: false, state: null, ...extra });

  const policyId = data._id || data.policyId;
  if (!policyId) {
    return fail("NO_POLICY_ID", "The policy has no id on the job, so the note that a CD Balance payment is being made cannot be saved and Pay with CD Balance was not pressed. Nothing was paid");
  }
  const field = issue.markerFieldFor(data);
  const store = deps.store || issue.createIssueStore({ MongoClient: deps.MongoClient, field, policyId });

  // 1. the premium KSHEMA asks against the CD balance (the owner: lower = error, nothing pressed)
  const premium = await readKshemaPremium(driver);
  const balancePaise = parseRupees(choice.balance);
  if (premium.paise !== null) {
    log(`   💰 Premium KSHEMA asks - ${rupees(premium.paise)}${balancePaise !== null ? ` · CD balance ${rupees(balancePaise)}` : ""}`);
    if (balancePaise !== null && balancePaise < premium.paise) {
      return fail(
        "LOW_BALANCE",
        `The CD Balance at KSHEMA (${rupees(balancePaise)}) is lower than the premium KSHEMA asks (${rupees(premium.paise)}), so Pay with CD Balance was not pressed. ` +
          "Add money to the CD account, then run the policy again. Nothing was paid"
      );
    }
  } else {
    warn(`   The premium in KSHEMA's top bar could not be read${premium.texts && premium.texts.length ? ` (it shows ${premium.texts.join(" and ")})` : ""} - KSHEMA checks the balance itself`);
  }

  // 2. the button, and no message of KSHEMA's open
  const button = await findPayButton(driver, { timeoutMs: timing.buttonWaitMs, pollMs: timing.pollMs, now, sleep });
  if (!button.ok) {
    return fail(
      "PAY_BUTTON",
      button.why === "more than one"
        ? "The KSHEMA payment page shows more than one Pay with CD Balance button, so nothing was pressed. Nothing was paid"
        : `The Pay with CD Balance button is ${button.why === "switched off" ? "switched off" : "not"} on the KSHEMA payment page, so nothing was pressed. Nothing was paid`
    );
  }
  let toastBefore = null;
  try {
    toastBefore = await readToast(driver);
  } catch (e) {
    if (isStop(e)) throw e;
  }
  if (toastBefore && toastBefore.isError && toastBefore.text) {
    return fail("TOAST_BEFORE", `KSHEMA shows "${noEndStop(toastBefore.text)}" on the payment page, so Pay with CD Balance was not pressed. Nothing was paid`);
  }

  // 3. the note FIRST - a guarded write; not saved = not pressed
  const note = {
    state: STATES.PRESSED,
    insurer: INSURER,
    method: METHOD,
    amountPaise: premium.paise,
    amount: premium.paise !== null ? formatPaise(premium.paise) : null,
    balance: choice.balance || null,
    paymentPage: choice.paymentUrl || null,
    jobId: String(data._jobId || data._jobIdentifier || jobId || ""),
    attempt: data._attemptNumber || null,
    part: data._partKey || null,
    portalUser: data.username || null,
    at: new Date(),
  };
  let claim;
  try {
    claim = await store.claim(note);
  } catch (e) {
    if (isStop(e)) throw e;
    return fail("NOTE_NOT_SAVED", `The note that a CD Balance payment is being made could not be saved on the policy (${noColon((e && e.message) || e)}), so Pay with CD Balance was not pressed. Nothing was paid`);
  }
  if (!(claim && claim.matched === 1)) {
    let current = null;
    try {
      current = await store.readNote();
    } catch (e) {
      if (isStop(e)) throw e;
    }
    if (current && current.marker && issue.isBlockingState(current.marker.state)) {
      return fail("ALREADY_PAID", kshemaGateMessage(current.marker, field), { paid: true, state: current.marker.state });
    }
    return fail("NOTE_NOT_SAVED", `The note that a CD Balance payment is being made was not saved on the policy (${current && !current.found ? "the policy was not found" : "the write matched nothing"}), so Pay with CD Balance was not pressed. Nothing was paid`);
  }
  log(`   📝 Note ${field}.state = ${STATES.PRESSED} saved - pressing Pay with CD Balance`);
  if (premium.paise !== null && typeof store.savePayable === "function") {
    // what KSHEMA asked, beside our own figure on the View page - bookkeeping only, never holds the press back
    const saved = await store.savePayable({
      insurer: INSURER,
      method: METHOD,
      amountPaise: premium.paise,
      amount: formatPaise(premium.paise),
      proposalNumber: "",
      jobId: note.jobId,
      at: new Date(),
    });
    if (!saved || !saved.ok) warn(`   The premium ${rupees(premium.paise)} could not be kept on the policy for the View page`);
  }

  // 4. Pay with CD Balance - ONCE
  const handlesBefore = await windowHandles(driver);
  let home = null;
  try {
    home = await driver.getWindowHandle();
  } catch (e) {
    if (isStop(e)) throw e;
  }
  const click = await issue.clickOnce(driver, button.element);
  if (!click.clicked) {
    await store.outcome({ state: STATES.FAILED, outcomeAt: new Date(), words: `Pay with CD Balance could not be clicked (${click.error})` });
    return fail("PAY_NOT_CLICKED", `Pay with CD Balance could not be clicked (${noColon(click.error)}). Nothing was paid`);
  }
  log(`   💳 Pay with CD Balance pressed${click.alert ? ` - KSHEMA showed "${noColon(click.alert)}"` : ""} - waiting for KSHEMA's policy page`);

  // 5. the policy page - 40 s at most
  const verdict = await awaitPolicyPage(driver, { handlesBefore, home, readToast, timing, now, sleep });
  if (verdict.kind !== "issued") {
    const why =
      verdict.kind === "toast"
        ? `KSHEMA showed "${noEndStop(verdict.words)}" and its policy page did not open`
        : verdict.kind === "page-error"
        ? `KSHEMA opened its policy page with an error (${noEndStop(verdict.page.msg) || `err ${verdict.page.err}`})`
        : verdict.kind === "lost-session"
        ? "KSHEMA went back to its login page"
        : `KSHEMA did not open its policy page within ${Math.round(timing.policyPageWaitMs / 1000)} seconds` +
          (verdict.words ? ` (it showed "${noEndStop(verdict.words)}")` : "");
    await store.outcome({ state: STATES.UNCONFIRMED, outcomeAt: new Date(), words: String(verdict.words || why).slice(0, 500), lastUrl: verdict.url || (verdict.page && verdict.page.url) || null });
    return fail("PAY_UNCONFIRMED", unconfirmedMessage(why, premium.paise), { paid: true, state: STATES.UNCONFIRMED });
  }
  const page = verdict.page;
  log(`   ✅ KSHEMA's policy page opened after ${Math.round(verdict.waitedMs / 1000)}s - ${page.msg || "no message"} (policy id ${page.policyId || "?"})`);
  await store.outcome({ state: STATES.ISSUED, outcomeAt: new Date(), policyPageUrl: page.url, kshemaPolicyId: page.policyId || null });

  // 6. the number, at once
  const number = await readPolicyNumber(driver, { timing, now, sleep });
  if (!number.ok) {
    return fail(
      "NUMBER_MISSING",
      "Pay with CD Balance went through and KSHEMA opened its policy page, but the policy number could not be read from it" +
        (number.raw ? ` (it shows "${noEndStop(number.raw)}")` : "") +
        ". Nothing is paid again - run the policy again to read the number and the PDF from the saved policy page",
      { paid: true, state: STATES.ISSUED, policyPageUrl: page.url }
    );
  }
  log(`   🔖 Policy number ${number.number}`);
  await store.outcome({ policyNumber: number.number });
  const savedNumber = await store.saveNumber(number.number);
  const warnings = [...(savedNumber.warnings || [])];
  log(`   💾 Policy number saved - online policy ${savedNumber.onlinePolicy}, policy record ${savedNumber.policy}`);

  // 7. the PDF
  const pdf = await downloadKshemaPolicyPdf(driver, { downloadDir, timing, now, sleep, fsImpl });
  const pdfFailed = (why) =>
    fail(
      "PDF_MISSING",
      `Policy ${number.number} was issued at KSHEMA from CD Balance and its number is saved, but its PDF ${why}. ` +
        "Nothing is paid again - run the policy again to fetch the PDF, or download it from KSHEMA and upload it on the policy by hand",
      { paid: true, state: STATES.ISSUED, policyNumber: number.number, policyPageUrl: page.url }
    );
  if (!pdf.ok) return pdfFailed(`could not be downloaded (${pdf.message})`);
  log(`   📄 Policy PDF downloaded - ${pdf.name} (${pdf.size} bytes)${pdf.truncated ? " - it has no end marker, it may be incomplete" : ""}`);
  const stored = await storePolicyPdf(pdf, { store, policyDocId: savedNumber.policyDocId, uploadPolicyPdf, names: fileNames(new Date()) });
  if (!stored.ok) return pdfFailed(`was downloaded but ${stored.message}`);
  warnings.push(...((stored.saved && stored.saved.warnings) || []));
  await store.outcome({ pdfStoredAt: new Date(), pdfKey: stored.file.key });
  log(`   ☁️  Policy PDF stored as ${stored.file.key} - policyFile ${stored.saved.policy}, online policy ${stored.saved.onlinePolicy}`);

  return {
    ok: true,
    policyNumber: number.number,
    policyPageUrl: page.url,
    kshemaPolicyId: page.policyId || "",
    premiumPaise: premium.paise,
    file: stored.file,
    saved: { number: savedNumber, pdf: stored.saved },
    warnings,
    warning: warnings.length ? noColon(`Policy ${number.number} was issued and its PDF is stored, but ${warnings.join("; and ")}`) : "",
  };
}

/**
 * Finish a policy whose CD Balance payment was ISSUED earlier but whose number or PDF was not stored (the run ended there).
 * Never presses Pay - the form skips everything up to here. Opens the saved policy page after the login, reads the number
 * (it must be the note's, when the note has one), saves it again (first writer wins) and the PDF (skipped when the policy
 * already has its file).
 *
 * @returns {Promise<{ok:true, recovered:true, policyNumber, policyPageUrl, file, warning}|{ok:false, code, error, paid:true}>}
 */
async function recoverKshemaIssue(o = {}) {
  const { driver, data = {}, jobId = "", marker = {}, downloadDir = "", deps = {} } = o;
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));
  const fsImpl = deps.fsImpl || fs;
  const timing = { ...TIMING, ...(deps.timing || {}) };
  const uploadPolicyPdf = deps.uploadPolicyPdf || defaultUploadPolicyPdf;
  const fileNames = deps.policyFileNames || issue.policyFileNames;
  const fail = (code, error, extra = {}) => ({ ok: false, code, error: noColon(error), paid: true, state: STATES.ISSUED, ...extra });

  const policyId = data._id || data.policyId;
  const page = readPolicyPageUrl(marker.policyPageUrl);
  if (!policyId || !page) {
    return fail("RECOVER_NO_PAGE", "The CD Balance payment of this policy was issued at KSHEMA but its policy page was not kept, so it cannot be finished by itself. Nothing was paid again. Download the policy from KSHEMA and upload it on the policy by hand");
  }
  const field = issue.markerFieldFor(data);
  const store = deps.store || issue.createIssueStore({ MongoClient: deps.MongoClient, field, policyId });
  log(`   ♻️  The CD Balance payment was issued earlier - nothing is paid again; opening the saved policy page`);
  try {
    await driver.get(page.url);
  } catch (e) {
    if (isStop(e)) throw e;
  }
  const number = await readPolicyNumber(driver, { timing: { ...timing, numberWaitMs: Math.max(timing.numberWaitMs, 30000) }, now, sleep });
  if (!number.ok) {
    return fail("RECOVER_NUMBER", "The saved KSHEMA policy page did not show the policy number after the new login. Nothing was paid again. Download the policy from KSHEMA and upload it on the policy by hand");
  }
  const noted = issue.normalisePolicyNumber(marker.policyNumber);
  if (noted && noted !== number.number) {
    return fail("RECOVER_CONFLICT", `The saved KSHEMA policy page shows the policy number ${number.number} but the note holds ${noted}, so nothing was saved. Check the policy at KSHEMA. Nothing was paid again`);
  }
  if (!noted) await store.outcome({ policyNumber: number.number });
  const savedNumber = await store.saveNumber(number.number);
  const warnings = [...(savedNumber.warnings || [])];
  log(`   💾 Policy number ${number.number} saved - online policy ${savedNumber.onlinePolicy}, policy record ${savedNumber.policy}`);

  const storedKey = await store.policyFileKey(savedNumber.policyDocId);
  if (storedKey) {
    log(`   📄 The policy already has its PDF (${storedKey}) - not fetched again`);
    await store.outcome({ pdfStoredAt: new Date(), pdfKey: storedKey });
    return { ok: true, recovered: true, policyNumber: number.number, policyPageUrl: page.url, file: null, warnings, warning: warnings.length ? noColon(warnings.join("; and ")) : "" };
  }
  const pdf = await downloadKshemaPolicyPdf(driver, { downloadDir, timing, now, sleep, fsImpl });
  if (!pdf.ok) {
    return fail("PDF_MISSING", `Policy ${number.number} was issued at KSHEMA earlier and its number is saved, but its PDF could not be downloaded (${pdf.message}). Nothing was paid again. Download it from KSHEMA and upload it on the policy by hand`, { policyNumber: number.number });
  }
  const stored = await storePolicyPdf(pdf, { store, policyDocId: savedNumber.policyDocId, uploadPolicyPdf, names: fileNames(new Date()) });
  if (!stored.ok) {
    return fail("PDF_NOT_STORED", `Policy ${number.number} was issued at KSHEMA earlier and its PDF was downloaded, but ${stored.message}. Nothing was paid again`, { policyNumber: number.number });
  }
  warnings.push(...((stored.saved && stored.saved.warnings) || []));
  await store.outcome({ pdfStoredAt: new Date(), pdfKey: stored.file.key });
  log(`   ☁️  Policy PDF stored as ${stored.file.key}`);
  return {
    ok: true,
    recovered: true,
    policyNumber: number.number,
    policyPageUrl: page.url,
    file: stored.file,
    warnings,
    warning: warnings.length ? noColon(`Policy ${number.number} was finished from its saved page, but ${warnings.join("; and ")}`) : "",
  };
}

module.exports = {
  TIMING,
  INSURER,
  METHOD,
  PAY_BUTTON_SCRIPT,
  PREMIUM_SCRIPT,
  POLICY_NUMBER_SCRIPT,
  POLICY_ICON_CSS,
  readPolicyPageUrl,
  isGoodPolicyPage,
  premiumOf,
  failureResultOf,
  kshemaGateMessage,
  unconfirmedMessage,
  readKshemaPremium,
  findPayButton,
  awaitPolicyPage,
  readPolicyNumber,
  downloadKshemaPolicyPdf,
  storePolicyPdf,
  checkKshemaWalletGate,
  decideKshemaGate,
  payWithCdBalanceAndIssue,
  recoverKshemaIssue,
};
