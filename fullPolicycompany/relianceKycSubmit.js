/**
 * Reliance full-company — the KYC "OVD upload" page: wait for the portal instead of forcing it.
 *
 * The page (an Angular app, opened by DO KYC) has two upload boxes (Identity / Address Verification), a SUBMIT button
 * (ng-click uploadFilesToAPI) and, after a good submit, a PROCEED button (ng-click redirectToURL). Reliance builds
 * SUBMIT only once it has accepted the uploaded document(s); until then it is hidden (ng-show).
 *
 * What the flow used to do (2026-10-14: "Please upload valid OVD file only."):
 *   - SUBMIT "exists but is not visible yet" -> slept 3 s -> clicked the HIDDEN button with a JavaScript click.
 *     The portal answered "Please upload valid OVD file only." — it had not accepted the document.
 *   - logged that message, then printed "SUBMIT completed successfully" unconditionally and slept a fixed 15 s.
 *   - looked for PROCEED with findElement (it is in the page source, hidden, even when the portal refused), clicked it
 *     with a JavaScript click and went on to Pending Quotes as if KYC had been done.
 * So it neither waited for the SUBMIT button to appear nor for the page that opens after SUBMIT, and treated the
 * portal's refusal as success.
 *
 * Now: wait until SUBMIT is really on screen (and enabled), press it, wait until the next page's PROCEED is really on
 * screen. If the portal shows an error and nothing moves for a good while, or nothing happens within the timeout, say
 * so and STOP — a KYC the portal did not accept is not a completed KYC, and everything after it (payment, the Brisk PA
 * certificate) would be bought for a policy that cannot be paid.
 *
 * Behind the same page there was a second, earlier fault, and it is the one that actually produced "Please upload valid
 * OVD file only." that day: the Aadhaar to upload is downloaded from S3 with the link stored on the job, a link the
 * backend mints when it builds or edits the job and that lives 5 MINUTES (X-Amz-Expires=300). The KYC step runs a few
 * minutes after that, so S3 answered 403 "AccessDenied - Request has expired" — a 387-byte XML body, which was saved
 * under a .jpg name and uploaded to Reliance as the customer's Aadhaar (it only checked the file was not empty). So:
 * the download link is minted fresh from the S3 key at the moment of use, and what was downloaded is checked to be a
 * real document (by its first bytes, not its name) before it is ever put on the portal.
 *
 * What the operator is told: the outcome is also written on the policy (`kycStatus`, the field the View page already
 * reads), so "KYC failed — upload the document manually" appears on the View page next to the saved KYC links. A
 * marker is set when the upload begins and cleared only when Reliance accepts SUBMIT, so EVERY way the step can end
 * badly (a refusal, no answer, a timeout, a crash, Ctrl-C) leaves the note — not only the failures this file detects.
 *
 * RELIANCE_KYC_SUBMIT_WAIT_ENABLED in the automation's .env: ON unless false / 0 / no / off. Off = the old behaviour
 * for all of it.
 * Read at CALL time, so a restart after editing .env is all it needs and a test can flip it.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isKycSubmitWaitEnabled() {
  return !isOff(process.env.RELIANCE_KYC_SUBMIT_WAIT_ENABLED);
}

/**
 * RELIANCE_PROCESS_LINKS_ENABLED — ON unless false / 0 / no / off. The page a proposal is listed and paid from (Reliance's
 * Pending Quotes) is saved on the policy as `proposalLink` — the "Proposal Page" card of the View page — the moment the
 * run is on it, and the page Pay opens as `paymentLink` ("Make Payment Page"): also when the KYC worked, and whatever
 * happens after (relianceKycFallback.js saveCurrentPageLink). Off = nothing is saved. Read at call time.
 */
function isProcessLinksEnabled() {
  return !isOff(process.env.RELIANCE_PROCESS_LINKS_ENABLED);
}

/**
 * RELIANCE_KYC_FALLBACK_ENABLED — ON unless false / 0 / no / off. When the KYC does not work (any way: a refusal toast,
 * an upload problem, no answer, the DO KYC link missing, no Aadhaar), the run no longer just stops or carries on to buy
 * the Brisk PA: it screenshots the error, goes to Pending Quotes, ticks THIS proposal and presses Pay, saves the proposal
 * page and the payment page as links on the policy, and ends as a failed KYC (relianceKycFallback.js). Nothing is paid,
 * no payment link is sent. Off = the behaviour from before. Read at call time.
 */
function isKycFallbackEnabled() {
  return !isOff(process.env.RELIANCE_KYC_FALLBACK_ENABLED);
}

/**
 * Thrown for a refusal by the portal that must END the policy. The nested try/catch blocks of the KYC step swallow
 * every other error as "non-fatal"; each of them lets this one through (`error.portalRejected`).
 */
class PortalRejectedError extends Error {
  constructor(message, { stage = "kyc-upload", portalText = "" } = {}) {
    super(message);
    this.name = "PortalRejectedError";
    this.portalRejected = true;
    this.stage = stage;
    this.portalText = portalText;
  }
}

/**
 * Runs IN THE PAGE (selenium serialises the source — keep it self-contained).
 * "shown" = really on screen (a size, not display:none / visibility:hidden / opacity 0). A button that merely EXISTS
 * in the page source is not there for the user — that is exactly the SUBMIT / PROCEED confusion.
 *
 * The markup is the real page's (Arya.ai KYC onboarding, an Angular app), read from a saved page source on
 * 2026-10-14. It carries SEVERAL buttons with the same ng-click (Individual and Corporate tabs, one per document
 * type), so every match is looked at and the one on screen wins — never just the first.
 *   SUBMIT   button[ng-click="uploadFilesToAPI()"]   ng-show="file1 || file2"
 *   PROCEED  button[ng-click="redirectToURL()"]      in the result form, under the Declaration
 *   errors   toast  .ui-notification.error .message   ("Please upload valid OVD file only." — gone after ~5 s;
 *                                                      a dismissed one keeps the class "killed")
 *            popup  .api-error-div  with the text in #api-error
 *            expired session  .refresh-div
 *
 * @param {"submit"|"proceed"} [want]  when given, the chosen BUTTON element is returned (to click) instead of the snapshot
 * @returns {{submit:{exists,shown,enabled}, proceed:{exists,shown,enabled}, errors:string[]}|Element|null}
 */
function readKycPageInPage(want) {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
    );
  }
  function enabled(el) {
    return !!el && !el.disabled && !el.hasAttribute("disabled");
  }
  function describe(el) {
    return { exists: !!el, shown: shown(el), enabled: enabled(el) };
  }
  function pickButton(ngClick, re) {
    var list = document.querySelectorAll("button[ng-click='" + ngClick + "'], input[type=button][ng-click='" + ngClick + "']");
    var seen = null;
    for (var i = 0; i < list.length; i++) {
      if (shown(list[i]) && enabled(list[i])) return list[i];
      if (!seen && shown(list[i])) seen = list[i];
    }
    if (seen) return seen;
    if (list.length) return list[0];
    var all = document.querySelectorAll("button, input[type=button], input[type=submit]");
    for (var j = 0; j < all.length; j++) {
      var label = (all[j].innerText || all[j].value || "").replace(/\s+/g, " ").trim();
      if (re.test(label) && shown(all[j])) return all[j];
    }
    return null;
  }
  var submit = pickButton("uploadFilesToAPI()", /^submit$/i);
  var proceed = pickButton("redirectToURL()", /^proceed\b/i);
  if (want === "submit") return submit;
  if (want === "proceed") return proceed;

  var errors = [];
  function addError(raw) {
    var text = String(raw || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 240 && errors.indexOf(text) < 0) errors.push(text);
  }
  var toasts = document.querySelectorAll(".ui-notification");
  for (var a = 0; a < toasts.length; a++) {
    var cls = " " + (toasts[a].className || "") + " ";
    if (cls.indexOf(" error ") < 0 || cls.indexOf(" killed ") >= 0 || !shown(toasts[a])) continue;
    var message = toasts[a].querySelector(".message");
    addError(message ? message.innerText : toasts[a].innerText);
  }
  var popup = document.querySelector(".api-error-div");
  if (popup && shown(popup)) {
    var apiError = document.getElementById("api-error");
    addError(apiError ? apiError.innerText : popup.innerText);
  }
  var expired = document.querySelector(".refresh-div");
  if (expired && shown(expired)) {
    var heading = expired.querySelector("h5");
    addError(heading ? heading.innerText : expired.innerText);
  }
  var generic = document.querySelectorAll("[role='alert'], .alert-danger");
  for (var g = 0; g < generic.length; g++) {
    if (shown(generic[g])) addError(generic[g].innerText);
  }
  return { submit: describe(submit), proceed: describe(proceed), errors: errors };
}

const NO_BUTTON = { exists: false, shown: false, enabled: false };
const EMPTY_PAGE = { submit: NO_BUTTON, proceed: NO_BUTTON, errors: [] };

/** One read of the page. Never throws: a page that is navigating reads as empty (nothing available yet). */
async function readKycPage(driver) {
  try {
    const p = await driver.executeScript(readKycPageInPage);
    if (!p || typeof p !== "object") return { ...EMPTY_PAGE };
    return {
      submit: { ...NO_BUTTON, ...(p.submit || {}) },
      proceed: { ...NO_BUTTON, ...(p.proceed || {}) },
      errors: Array.isArray(p.errors) ? p.errors : [],
    };
  } catch (e) {
    return { ...EMPTY_PAGE };
  }
}

/**
 * Wait until a control is on screen and enabled — or the portal has plainly refused, or time is up.
 *
 * `rejected` = an error text was seen, the control is still not available, and `errorStableMs` have passed since that
 * text FIRST appeared. The error is LATCHED: Reliance shows its refusal as a toast ("Please upload valid OVD file
 * only.") that is gone after ~5 s, so waiting for the same text to stay on screen — as this used to — lost the very
 * answer it was waiting for and ended "the portal showed no message". A newer, different text restarts the clock.
 * An error can also flash while the upload is still being processed, and a good page can carry a stale message for
 * a moment — so the control appearing always wins over a message (checked first on every read).
 *
 * @param {Object} driver
 * @param {"submit"|"proceed"} which
 * @param {Object} [opts]
 * @param {string[]} [opts.ignoreErrors]  what the page already showed before anything was uploaded
 * @param {string} [opts.seenText]        an error the upload step saw on the way (see the latch above)
 * @param {Function} [opts.onProgress]    called every `progressEveryMs` while waiting with { which, waitedMs, text } — so
 *                                        a wait of minutes does not look like a frozen server
 * @param {Function} [opts.onNewError]    called (and awaited) the moment a NEW error text is first seen — a toast is gone in
 *                                        ~5 s, so this is where the screenshot of it is taken. A throwing callback is ignored.
 * @returns {Promise<{state:"ready"|"rejected"|"timeout", text:string, waitedMs:number}>}
 */
async function waitForKycControl(
  driver,
  which,
  {
    // Reliance can be slow: on 2026-10-14 SUBMIT took 50 s to become available and the page after it did not open
    // within 2 minutes. These sit well inside the job timeout (15 min).
    timeoutMs = which === "submit" ? 120000 : 300000,
    errorStableMs = which === "submit" ? 20000 : 15000,
    pollMs = 500,
    progressEveryMs = 15000,
    onProgress = null,
    onNewError = null,
    ignoreErrors = [],
    seenText = "",
    now = Date.now,
    sleep = (ms) => driver.sleep(ms),
  } = {}
) {
  const ignore = new Set(ignoreErrors || []);
  const started = now();
  // the newest error text seen since the wait began (a toast that has gone is still the answer) — seeded with what
  // the upload step met on the way: a refusal toast shown while the documents went in is gone before this wait starts
  let latched = seenText || "";
  let latchedSince = seenText ? started : 0;
  let lastProgress = started;
  for (;;) {
    const page = await readKycPage(driver);
    const control = page[which];
    const t = now();
    if (control.shown && control.enabled) return { state: "ready", text: "", waitedMs: t - started };

    const visible = page.errors.filter((e) => !ignore.has(e)).join(" | ");
    if (visible && visible !== latched) {
      latched = visible;
      latchedSince = t;
      if (onNewError) {
        try {
          await onNewError(visible);
        } catch (e) {
          /* a screenshot callback must never end the wait */
        }
      }
    }
    if (latched && t - latchedSince >= errorStableMs) {
      return { state: "rejected", text: latched, waitedMs: t - started };
    }

    if (t - started >= timeoutMs) return { state: "timeout", text: latched, waitedMs: t - started };
    if (onProgress && t - lastProgress >= progressEveryMs) {
      lastProgress = t;
      try {
        onProgress({ which, waitedMs: t - started, text: latched });
      } catch (e) {
        /* a logging callback must never end the wait */
      }
    }
    await sleep(pollMs);
  }
}

/** The SUBMIT / PROCEED button to click — the one on screen (the page has several with the same ng-click), or null. */
async function findKycButton(driver, which) {
  try {
    return (await driver.executeScript(readKycPageInPage, which)) || null;
  } catch (e) {
    return null;
  }
}

const waitForKycSubmitReady = (driver, opts) => waitForKycControl(driver, "submit", opts);
const waitForKycProceed = (driver, opts) => waitForKycControl(driver, "proceed", opts);

/** A colon in the portal's words would let beautifyError's root-cause trimming cut the sentence in half. */
const plain = (value) =>
  String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, " - ")
    .trim();

/** "Aadhaar.pdf sent as .jpg, 245 KB" — what was actually put on the portal (the temp file, not just its name). */
function describeUploadedFile({ fileName, filePath, size } = {}) {
  const path = require("path");
  const fs = require("fs");
  let bytes = typeof size === "number" ? size : null;
  if (bytes === null && filePath) {
    try {
      bytes = fs.statSync(filePath).size;
    } catch (e) {
      bytes = null;
    }
  }
  const ext = filePath ? path.extname(filePath) : "";
  const parts = [];
  if (fileName) parts.push(plain(fileName));
  if (ext) parts.push(`sent as ${ext}`);
  const head = parts.join(" ");
  const kb = bytes === null ? "" : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return [head, kb].filter(Boolean).join(", ");
}

const UPLOAD_LABEL = { identity: "Identity Verification", address: "Address Verification" };

/** The first half of the operator sentence when a document did not go into its slot. */
function uploadWhat(slot, state, secs) {
  const label = UPLOAD_LABEL[slot] || "KYC";
  switch (state) {
    case "rejected":
      return `Reliance did not accept the document uploaded for ${label}.`;
    case "timeout":
      return `Reliance did not take the document uploaded for ${label} within ${secs} s.`;
    case "missing":
      return `The ${label} upload area is not on the Reliance KYC page.`;
    case "hidden":
      return `The ${label} upload area is not on screen on the Reliance KYC page (UPLOAD DOCUMENT may not be selected).`;
    default:
      return `The document could not be handed to the ${label} upload area of the Reliance KYC page.`;
  }
}

/** The one-line version for the View page. */
function uploadReason(slot, state, secs, text) {
  const label = UPLOAD_LABEL[slot] || "KYC";
  const said = text ? ` - it said "${plain(text)}"` : "";
  switch (state) {
    case "rejected":
      return `Reliance did not accept the ${label} document${said}`;
    case "timeout":
      return `Reliance did not take the ${label} document within ${secs} s${text ? ` - the page showed "${plain(text)}"` : ""}`;
    case "missing":
      return `The ${label} upload area is not on the KYC page`;
    case "hidden":
      return `The ${label} upload area is not on screen on the KYC page`;
    default:
      return `The document could not be handed to the ${label} upload area${text ? ` - ${plain(text)}` : ""}`;
  }
}

/**
 * The sentence the operator reads. Says what the portal did, what was sent, that nothing was paid or bought, and what
 * to do. No colons outside the portal's own words (stripped by `plain`).
 *
 * @param {Object} o
 * @param {"submit"|"proceed"} o.step     which control never came
 * @param {"rejected"|"timeout"} o.state
 * @param {string} [o.text]               the portal's message, if it showed one
 * @param {number} [o.waitedMs]
 * @param {string} [o.proposalNumber]
 * @param {string} [o.file]               describeUploadedFile()
 * @param {boolean} [o.brief]             only what the portal did and what was sent — the fallback (relianceKycFallback.js)
 *                                        adds the proposal, what was done about payment and what to do next
 */
function kycStuckMessage({ step, slot = "", state, text = "", waitedMs = 0, proposalNumber = "", file = "", brief = false } = {}) {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  let what;
  if (step === "option") {
    what = "The UPLOAD DOCUMENT option could not be selected on the Reliance KYC page, so no document was uploaded.";
  } else if (step === "upload") {
    what = uploadWhat(slot, state, secs);
  } else if (step === "submit") {
    what =
      state === "rejected"
        ? "Reliance did not accept the Aadhaar document uploaded for KYC, so its SUBMIT button never became available."
        : `Reliance did not make its SUBMIT button available within ${secs} s of the Aadhaar upload.`;
  } else {
    what =
      state === "rejected"
        ? "Reliance refused the KYC documents when SUBMIT was pressed, so the next page never opened."
        : `Reliance did not open the page after SUBMIT within ${secs} s.`;
  }
  const said = text ? `The portal said "${plain(text)}". ` : "The portal showed no message. ";
  const sent = file ? `File sent ${plain(file)}. ` : "";
  if (brief) return `${what} ${said}${sent}`.trim();
  const proposal = proposalNumber
    ? `The proposal ${plain(proposalNumber)} is saved at Reliance but its KYC is not complete, so the policy was stopped before payment — nothing was paid or bought. `
    : "The policy was stopped before payment — nothing was paid or bought. ";
  return (
    `${what} ${said}${sent}${proposal}` +
    `Check the Aadhaar file saved on the policy, then run the policy again, or finish the KYC on the portal with the saved KYC link.`
  );
}

/* -------------------------------------------------------------------------- */
/* The document that is uploaded                                              */
/* -------------------------------------------------------------------------- */

/** The Aadhaar could not be turned into a file Reliance could take. Ends the policy, like a portal refusal. */
class KycDocumentError extends PortalRejectedError {
  constructor(message, opts = {}) {
    super(message, { stage: "kyc-document", ...opts });
    this.name = "KycDocumentError";
  }
}

/** What a file really is, from its first bytes — not from its name or the Content-Type header. */
function sniffDocumentBytes(buf) {
  if (!buf || buf.length === 0) return { kind: "empty" };
  const starts = (...bytes) => bytes.every((v, i) => buf[i] === v);
  if (starts(0xff, 0xd8, 0xff)) return { kind: "jpeg" };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: "png" };
  if (starts(0x25, 0x50, 0x44, 0x46)) return { kind: "pdf" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { kind: "gif" };
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { kind: "webp" };
  }
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (/^<\?xml/i.test(head) || /^<Error[\s>]/i.test(head)) return { kind: "xml", text: head };
  if (/^<!doctype html|^<html/i.test(head)) return { kind: "html", text: head };
  if (/^[{[]/.test(head)) return { kind: "json", text: head };
  return { kind: "unknown" };
}

/** What a download that is not a document is: an error body, an HTML page, nothing. Anything else is let through. */
const NOT_A_DOCUMENT = new Set(["empty", "xml", "html", "json"]);

/** S3's own error body: <Error><Code>AccessDenied</Code><Message>Request has expired</Message>... */
function s3ErrorOf(text) {
  const code = /<Code>([^<]+)<\/Code>/.exec(text || "");
  if (!code) return null;
  const message = /<Message>([^<]+)<\/Message>/.exec(text || "");
  return { code: code[1], message: message ? message[1] : "" };
}

/** The extension a file of this kind must carry for the portal to take it for what it is. */
const EXTENSION_OF = { jpeg: ".jpg", png: ".png", pdf: ".pdf", gif: ".gif", webp: ".webp" };

/**
 * Look at a downloaded file.
 * @returns {{ok:boolean, kind:string, size:number, s3:{code,message}|null, extension:string|null}}
 */
function inspectDocumentFile(filePath) {
  const fs = require("fs");
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const sniffed = sniffDocumentBytes(buf);
    return {
      ok: !NOT_A_DOCUMENT.has(sniffed.kind),
      kind: sniffed.kind,
      size,
      s3: sniffed.text ? s3ErrorOf(sniffed.text) : null,
      extension: EXTENSION_OF[sniffed.kind] || null,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** The sentence the operator reads when the Aadhaar could not be fetched as a document. */
function kycDocumentMessage({ inspected, fileName = "", freshLink = false, brief = false } = {}) {
  const i = inspected || {};
  const tail = brief
    ? "Nothing was uploaded to Reliance."
    : "Nothing was uploaded to Reliance and the policy was stopped before payment — nothing was paid or bought. " +
      "Run the policy again, and if it keeps happening check the Aadhaar file saved on the policy.";
  const name = fileName ? ` (${plain(fileName)})` : "";
  if (i.s3) {
    return (
      `The Aadhaar document${name} could not be downloaded from storage — S3 answered ` +
      `"${plain(i.s3.code)}${i.s3.message ? " - " + plain(i.s3.message) : ""}" instead of the file` +
      `${freshLink ? " even with a fresh link" : ""}. ${tail}`
    );
  }
  if (i.kind === "empty") {
    return `The Aadhaar document${name} downloaded from storage is empty. ${tail}`;
  }
  return (
    `The Aadhaar document${name} downloaded from storage is not a picture or a PDF ` +
    `(it is ${plain(i.kind)} data, ${i.size} bytes). ${tail}`
  );
}

/* -------------------------------------------------------------------------- */
/* Telling the View page                                                      */
/* -------------------------------------------------------------------------- */

/** Set when the upload begins, cleared when SUBMIT is accepted: what is left if the run dies inside the KYC step. */
const KYC_UNFINISHED = "KYC was started but did not finish";

/** The policy carries no Aadhaar, so there was nothing to upload. */
const KYC_NO_DOCUMENT = "No Aadhaar document was found on the policy, so KYC was not attempted";

/**
 * The one-line reason shown on the View page when SUBMIT or the page after it never came. No "the portal said"
 * framing — the page quotes it; no colon outside the portal's own words.
 */
function kycReasonText({ step, slot = "", state, text = "", waitedMs = 0 } = {}) {
  const secs = Math.max(1, Math.round(waitedMs / 1000));
  const said = text ? ` - it said "${plain(text)}"` : "";
  if (step === "option") return "The UPLOAD DOCUMENT option could not be selected on the KYC page";
  if (step === "upload") return uploadReason(slot, state, secs, text);
  if (step === "submit") {
    return state === "rejected"
      ? `Reliance did not accept the uploaded Aadhaar${said}`
      : `Reliance did not make SUBMIT available within ${secs} s of the upload${text ? ` - the page showed "${plain(text)}"` : ""}`;
  }
  return state === "rejected"
    ? `Reliance refused the documents at SUBMIT${said}`
    : `Reliance did not open the next page within ${secs} s of SUBMIT (${text ? `the page showed "${plain(text)}"` : "it showed no message"})`;
}

/** The one-line reason for a KYC that ended without a portal answer to quote (a missing link, a crash, no Aadhaar ...). */
function kycGenericReasonText(message) {
  const text = plain(String(message == null ? "" : message).replace(/^\[E\d+\]\s*/, ""));
  return text ? `KYC did not complete - ${text}` : "KYC did not complete";
}

/** The reason for a download that was not a document (what kycDocumentMessage says, in one line). */
function kycDocumentReasonText(inspected = {}) {
  if (inspected.s3) {
    return `The Aadhaar could not be downloaded from storage - S3 said "${plain(inspected.s3.code)}${
      inspected.s3.message ? " - " + plain(inspected.s3.message) : ""
    }"`;
  }
  if (inspected.kind === "empty") return "The Aadhaar downloaded from storage is empty";
  return `The Aadhaar downloaded from storage is not a picture or a PDF (it is ${plain(inspected.kind)} data)`;
}

/**
 * Write (or clear, with a falsy `status`) the KYC note on the policy, with the raw Mongo driver like saveKycUrls.
 * Never throws: a bookkeeping write must not fail a run. Resolves true when a policy document matched.
 *
 * @param {string|null} status
 * @param {Object} data  the job data (carries the policy's `_id`)
 * @param {string} [jobId]
 * @param {Object} [deps]
 * @param {Function} [deps.MongoClient]  injectable for tests
 */
async function saveKycStatus(status, data, jobId = "", { MongoClient } = {}) {
  const policyId = data && (data._id || data.policyId);
  if (!policyId) {
    console.warn(`[${jobId}] ⚠️ No policy id on the job — the KYC note was not saved.`);
    return false;
  }
  let client = null;
  try {
    const Client = MongoClient || require("mongodb").MongoClient;
    client = new Client(process.env.MONGODB_URI);
    await client.connect();
    const update = status
      ? { $set: { kycStatus: String(status), updatedAt: new Date() } }
      : { $unset: { kycStatus: "" }, $set: { updatedAt: new Date() } };
    const result = await client.db().collection("onlinePolicy").updateOne({ _id: policyId }, update);
    console.log(
      `[${jobId}] 📝 onlinePolicy.kycStatus ${status ? `= "${status}"` : "cleared"} (matched ${result.matchedCount})`
    );
    return result.matchedCount > 0;
  } catch (error) {
    console.warn(`[${jobId}] ⚠️ Could not save the KYC note: ${error.message}`);
    return false;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

module.exports = {
  isKycSubmitWaitEnabled,
  isKycFallbackEnabled,
  isProcessLinksEnabled,
  kycGenericReasonText,
  plain,
  KYC_UNFINISHED,
  KYC_NO_DOCUMENT,
  kycReasonText,
  kycDocumentReasonText,
  saveKycStatus,
  KycDocumentError,
  sniffDocumentBytes,
  s3ErrorOf,
  inspectDocumentFile,
  kycDocumentMessage,
  EXTENSION_OF,
  PortalRejectedError,
  readKycPageInPage,
  readKycPage,
  findKycButton,
  waitForKycControl,
  waitForKycSubmitReady,
  waitForKycProceed,
  describeUploadedFile,
  kycStuckMessage,
};
