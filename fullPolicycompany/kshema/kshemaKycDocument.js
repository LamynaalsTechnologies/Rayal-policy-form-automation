/**
 * The Aadhaar document the KSHEMA KYC page is given when the last-4-digits route
 * is refused ("No record found" -> "Try with different document").
 *
 * Why this is its own module: the upload used to hand the portal something it
 * could not read, while the same picture uploaded by hand was accepted. Two
 * defects, either one enough (2026-10-15):
 *
 *   1. It trusted the stored download link. The backend mints that link with
 *      AWS_SIGNED_URL_EXPIRES_SECONDS = 300 — five minutes — when the job is
 *      built; the KYC step runs many minutes later. An expired link makes S3
 *      answer 403 with a small XML body, which the old downloader (no status
 *      check, only "0 bytes" refused) saved as "<random>.jpg" and uploaded as the
 *      customer's Aadhaar. The Reliance flow had the very same bug and was fixed
 *      on 2026-10-14 (a fresh link from the S3 key, and a look at the first
 *      bytes). This is that fix, for KSHEMA.
 *   2. It deleted the temp file 1.5 s after attaching it — before pressing
 *      "Submit for Verification", which is when the page reads the file for the
 *      upload. Chrome fails an upload whose file has gone (ERR_UPLOAD_FILE_CHANGED).
 *
 * And when the portal does refuse, its own words were never shown: the wait for
 * "Details are correct - Verify" just timed out with a generic sentence.
 *
 * Shared by the full-company KSHEMA flow and the TP copy (both quote forms
 * delegate here from recoverKycWithDocumentUpload), so the two cannot drift.
 *
 * Operator sentences end up in beautifyError, which keeps only the text after the
 * LAST colon of a message — so none of the sentences below contains one.
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { By } = require("selenium-webdriver");
const { log, warn } = require("./kshemaLog");
// The Reliance fix's byte sniffing (S3 XML / HTML / empty are refused, a real
// picture or PDF is told by its first bytes). Exported and tested there.
const { inspectDocumentFile } = require("../relianceKycSubmit");

/** The project's temp_uploads (wiped at server start); not relative to the TP copy. */
const TEMP_DIR = path.join(__dirname, "..", "..", "temp_uploads");

const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_BYTES = 15 * 1024 * 1024; // an Aadhaar picture is a few hundred KB; this is a ceiling, not an expectation
const MAX_REDIRECTS = 5;
const SHOWN_WAIT_MS = 3000;
const SUBMIT_ENABLED_WAIT_MS = 15000;
const REVIEW_WAIT_MS = 40000;
const AFTER_VERIFY_WAIT_MS = 20000;
const POLL_MS = 500;

/**
 * How long the KYC page has to stay free of any refusal before the KYC counts as done (2026-10-15).
 *
 * After "Details are correct - Verify" the portal removes the review screen and shows a blank / loading state for a few
 * seconds BEFORE it draws the DigiLocker card with its verdict ("The gender on your document doesn't match your
 * profile ..."). "The review button is gone and no error yet" was taken as success, and the run went on to payment.
 * ON unless KSHEMA_KYC_SETTLE_ENABLED is false / 0 / no / off (off = one look, the old behaviour).
 */
const settleEnabled = () => !/^(false|0|no|off)$/i.test(String(process.env.KSHEMA_KYC_SETTLE_ENABLED || "").trim());
const settleWindowMs = () => {
  const asked = parseInt(process.env.KSHEMA_KYC_SETTLE_MS, 10);
  const ms = Number.isFinite(asked) && asked > 0 ? asked : 10000;
  return Math.min(Math.max(ms, 3000), 30000);
};

/** One line, no colon, safe to put in the operator's message. */
const plain = (text) =>
  String(text || "")
    .split("\n")[0]
    .replace(/\s+/g, " ")
    .replace(/:/g, " -")
    .trim();

/**
 * The operator's sentence for a refusal the KYC page showed AFTER the document was read, in the portal's own words.
 * No colon in it (beautifyError keeps only the text after the last one).
 */
function kycValidationMessage(portalText) {
  const said = plain(portalText);
  const mismatch = /match|gender|date of birth|\bdob\b|name/i.test(said);
  return (
    `KYC validation error - KSHEMA said "${said}". ` +
    (mismatch
      ? "The details on the Aadhaar document do not agree with the details on the policy. Correct the customer's " +
        "gender, name or date of birth on the policy so they match the Aadhaar, then run the policy again. "
      : "Check the customer's Aadhaar card image on the policy, then run the policy again. ") +
    "The KYC page has been left open on screen."
  );
}

/**
 * Has the KYC page stayed free of any refusal for the whole settle window? Returns the moment one appears.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {Function} o.readKycError  async (driver) -> the page's error / incomplete text or null
 * @param {Function} [o.sleep]       async (ms)
 * @param {number}   [o.settleMs]    override the window (tests)
 * @returns {Promise<{ok:true}|{ok:false, text:string}>}
 */
async function settleKycOutcome(driver, { readKycError, sleep, settleMs } = {}) {
  const pause = sleep || ((ms) => driver.sleep(ms));
  const windowMs = settleEnabled() ? (Number.isFinite(settleMs) ? settleMs : settleWindowMs()) : 0;
  const end = Date.now() + windowMs;
  for (;;) {
    let text = null;
    try {
      text = await readKycError(driver);
    } catch (e) {
      text = null; // the tab was closed by the portal, or is between pages: not a refusal
    }
    if (text) return { ok: false, text };
    if (Date.now() >= end) return { ok: true };
    await pause(POLL_MS);
  }
}

/** A problem with the DOCUMENT (nothing reached the portal). `transient` = time could fix it. */
class KshemaDocumentError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "KshemaDocumentError";
    this.transient = details.transient === true;
    this.details = details;
  }
}

/** Extension from the original file name, only when it is one the portal takes. */
const nameExtension = (fileName) => {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  return [".pdf", ".jpg", ".jpeg", ".png"].includes(ext) ? (ext === ".jpeg" ? ".jpg" : ext) : "";
};

const extensionOfContentType = (contentType) => {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("pdf")) return ".pdf";
  if (type.includes("png")) return ".png";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  return "";
};

/**
 * Download `url` into `destPath`. Follows redirects, has a total time limit and a
 * size ceiling, and does NOT judge the status: the body of an S3 error is what
 * the caller wants to look at, so it is written like any other and the status is
 * handed back.
 *
 * @returns {Promise<{status:number, contentType:string, bytes:number}>}
 */
function downloadToFile(url, destPath, { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_BYTES, redirects = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let currentReq = null;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => {
      if (currentReq) currentReq.destroy();
      done(reject, Object.assign(new Error(`storage did not answer within ${Math.round(timeoutMs / 1000)} s`), { transient: true }));
    }, timeoutMs);

    const go = (target, left) => {
      let parsed;
      try {
        parsed = new URL(target);
      } catch (e) {
        return done(reject, new Error("the download link is not a valid address"));
      }
      const lib = parsed.protocol === "http:" ? http : https;
      currentReq = lib.get(parsed, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (left <= 0) return done(reject, new Error("storage redirected too many times"));
          return go(new URL(res.headers.location, parsed).toString(), left - 1);
        }
        const out = fs.createWriteStream(destPath);
        let bytes = 0;
        let tooBig = false;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes && !tooBig) {
            tooBig = true;
            res.destroy();
            out.destroy();
            done(reject, new Error(`the file is larger than ${Math.round(maxBytes / 1048576)} MB`));
          }
        });
        res.on("error", (e) => done(reject, Object.assign(e, { transient: true })));
        out.on("error", (e) => done(reject, e));
        out.on("finish", () => {
          if (tooBig) return;
          done(resolve, { status: res.statusCode, contentType: res.headers["content-type"] || "", bytes });
        });
        res.pipe(out);
      });
      currentReq.on("error", (e) => done(reject, Object.assign(e, { transient: true })));
    };
    go(url, redirects);
  });
}

/** The sentence the operator reads when the Aadhaar could not be fetched as a document. */
function documentMessage({ inspected = {}, status = 200, fileName = "", fresh = false } = {}) {
  const name = fileName ? ` (${plain(fileName)})` : "";
  const tail =
    "Nothing was uploaded to KSHEMA. Run the policy again, and if it keeps happening check the Aadhaar file saved on the policy.";
  if (inspected.s3) {
    return (
      `The Aadhaar document${name} could not be downloaded from storage - S3 answered ` +
      `"${plain(inspected.s3.code)}${inspected.s3.message ? " - " + plain(inspected.s3.message) : ""}" instead of the file` +
      `${fresh ? " even with a fresh link" : ""}. ${tail}`
    );
  }
  if (status < 200 || status >= 300) {
    return `The Aadhaar document${name} could not be downloaded from storage - it answered HTTP ${status} instead of the file. ${tail}`;
  }
  if (inspected.kind === "empty") {
    return `The Aadhaar document${name} downloaded from storage is empty. ${tail}`;
  }
  return (
    `The Aadhaar document${name} downloaded from storage is not a picture or a PDF ` +
    `(it is ${plain(inspected.kind)} data, ${inspected.size} bytes). ${tail}`
  );
}

/**
 * Fetch the policy's Aadhaar as a real document on disk, or refuse it.
 *
 * @param {Object} args
 * @param {Object} args.aadharCard  the policy's { key, presignedUrl, location, fileName }
 * @param {string} [args.jobId]
 * @param {Object} [args.deps]      test seam: { mintLink(key), download(url, dest), inspect(file), tempDir }
 * @returns {Promise<{filePath, fileName, kind, size, extension, source, fresh, status}>}
 * @throws {KshemaDocumentError}
 */
async function fetchAadhaarDocument({ aadharCard, jobId = "", deps = {} } = {}) {
  const mintLink = deps.mintLink || ((key) => require("../../s3Uploader").getPresignedUrl(key));
  const download = deps.download || downloadToFile;
  const inspect = deps.inspect || inspectDocumentFile;
  const tempDir = deps.tempDir || TEMP_DIR;
  const card = aadharCard || {};

  // 1. The link. The stored one lives five minutes; a fresh one is minted from
  //    the S3 key right now. The stored link and `location` are only fallbacks.
  let url = "";
  let source = "";
  if (card.key) {
    try {
      url = await mintLink(card.key);
      if (url) source = "fresh";
    } catch (e) {
      warn(`   Could not mint a fresh download link for the Aadhaar (${plain(e.message)}) - trying the stored one`);
    }
  }
  if (!url && card.presignedUrl) {
    url = card.presignedUrl;
    source = "stored";
  }
  if (!url && card.location) {
    url = card.location;
    source = "location";
  }
  if (!url) {
    throw new KshemaDocumentError("No Aadhaar card image is on file for this policy. Nothing was uploaded to KSHEMA.");
  }
  log(`   🔗 Aadhaar download link: ${source === "fresh" ? "fresh (minted now)" : `the stored one (${source})`}`);

  // 2. Download to a ".part" file; it is named for what it really is afterwards.
  fs.mkdirSync(tempDir, { recursive: true });
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const partPath = path.join(tempDir, `aadhaar_${stamp}.part`);
  // Synchronous: a refused download must leave nothing behind by the time the caller hears about it.
  const discardPart = () => {
    try {
      fs.unlinkSync(partPath);
    } catch (e) {
      // never created, or already gone
    }
  };

  let got;
  try {
    got = await download(url, partPath);
  } catch (e) {
    discardPart();
    throw new KshemaDocumentError(
      `The Aadhaar document could not be downloaded from storage - ${plain(e && e.message)}. ` +
        "Nothing was uploaded to KSHEMA. Run the policy again.",
      { transient: !!(e && e.transient) }
    );
  }

  // 3. Is it a document? Look at the first bytes, not at the name.
  let inspected;
  try {
    inspected = inspect(partPath);
  } catch (e) {
    discardPart();
    throw new KshemaDocumentError(`The Aadhaar document could not be checked after downloading - ${plain(e && e.message)}.`);
  }
  log(`   🔎 Downloaded Aadhaar: HTTP ${got.status}, ${inspected.kind}, ${inspected.size} bytes`);

  const httpOk = got.status >= 200 && got.status < 300;
  if (!inspected.ok || !httpOk) {
    discardPart();
    throw new KshemaDocumentError(
      documentMessage({ inspected, status: got.status, fileName: card.fileName, fresh: source === "fresh" }),
      { s3: inspected.s3 || null, kind: inspected.kind, status: got.status }
    );
  }

  // 4. Give it the extension it really has (a PDF saved as .jpg is a mismatch the portal can refuse).
  const extension =
    inspected.extension || nameExtension(card.fileName) || extensionOfContentType(got.contentType) || ".jpg";
  const filePath = path.join(tempDir, `aadhaar_${stamp}${extension}`);
  try {
    fs.renameSync(partPath, filePath);
  } catch (e) {
    discardPart();
    throw new KshemaDocumentError(`The Aadhaar document could not be saved for upload - ${plain(e.message)}.`);
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    kind: inspected.kind,
    size: inspected.size,
    extension,
    source,
    fresh: source === "fresh",
    status: got.status,
  };
}

/**
 * Remove the temp file; best effort. Called when the portal is DONE with it.
 * Synchronous on purpose: one small file, and it is gone before the result is
 * handed back rather than "soon".
 */
function discardDocument(doc) {
  if (!doc || !doc.filePath) return;
  try {
    fs.unlinkSync(doc.filePath);
  } catch (e) {
    // already gone, or not ours to remove — nothing to do
  }
}

/* -------------------------------------------------------------------------- */
/* The KYC page                                                               */
/* -------------------------------------------------------------------------- */

const lower = (text) =>
  `translate(normalize-space(${text}), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")`;
const buttonWithText = (text) => By.xpath(`//button[contains(${lower(".")}, "${text}")]`);

/**
 * The file input to use: a live one near upload / Aadhaar wording, else the first.
 * Runs in the page (selenium serialises the source).
 */
const PICK_FILE_INPUT_IN_PAGE = `
  var inputs = Array.prototype.slice.call(document.querySelectorAll("input[type='file']"));
  var live = inputs.filter(function (i) { return !i.disabled; });
  if (!live.length) return null;
  function near(el) {
    var node = el;
    for (var depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      var text = (node.innerText || node.textContent || "").toLowerCase();
      if (/aadhaar|aadhar|upload|document|drag|drop|tap/.test(text)) return true;
    }
    return false;
  }
  for (var k = 0; k < live.length; k++) if (near(live[k])) return live[k];
  return live[0];
`;

/** What the input holds right now. Runs in the page. */
const READ_INPUT_IN_PAGE = `
  var el = arguments[0];
  var f = el.files;
  return {
    count: f ? f.length : 0,
    name: f && f[0] ? f[0].name : "",
    size: f && f[0] ? f[0].size : -1,
    accept: el.accept || "",
    multiple: !!el.multiple
  };
`;

/** Does the page mention the file by name (a preview / chip)? Runs in the page. */
const PAGE_MENTIONS_IN_PAGE = `
  var needle = String(arguments[0] || "").toLowerCase();
  var text = (document.body && (document.body.innerText || document.body.textContent) || "").toLowerCase();
  return needle ? text.indexOf(needle) >= 0 : false;
`;

/** Same text, compared loosely. */
const sameText = (a, b) =>
  String(a || "").replace(/\s+/g, " ").trim().toLowerCase() === String(b || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Upload the policy's Aadhaar on the KYC page ("Try with different document").
 *
 *   fetch + check the document (before the portal is touched)
 *   -> Try with different document -> Aadhaar card selected
 *   -> attach, read back what the input holds
 *   -> Submit for Verification
 *   -> watch for the review screen AND for the portal's own refusal
 *   -> Details are correct - Verify -> watch it move on
 *   -> (always) remove the temp file, only now
 *
 * @param {Object} driver
 * @param {Object} data       the job's formData (aadharCard)
 * @param {string} jobId
 * @param {Object} [opts]
 * @param {Function} [opts.readKycError]  async (driver) -> the page's error text or null
 * @param {Object} [opts.deps]            test seam: fetchDocument, sleep
 * @returns {Promise<{ok:boolean, retryable?:boolean, kycStatus?:string, error?:string}>}
 */
async function uploadAadhaarForKyc(driver, data, jobId, opts = {}) {
  const { clickElement } = require("./kshemaFields");
  const { readKycError = async () => null, deps = {} } = opts;
  const fetchDocument = deps.fetchDocument || fetchAadhaarDocument;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));

  let doc = null;
  try {
    // 1. The document first. A refused / unreadable document is reported here,
    //    with S3's own words, before the portal is touched at all.
    log("   📥 Fetching the policy's Aadhaar card image...");
    try {
      doc = await fetchDocument({ aadharCard: data && data.aadharCard, jobId });
    } catch (e) {
      if (e instanceof KshemaDocumentError) {
        warn(`   ✗ ${e.message}`);
        return { ok: false, retryable: e.transient === true, error: e.message };
      }
      throw e;
    }

    // 2. Try with different document
    log("   🔁 Attempting recovery: Try with different document...");
    const tryDifferentBtn = await driver.wait(
      async () => {
        const els = await driver.findElements(buttonWithText("try with different document"));
        return els.length > 0 ? els[0] : null;
      },
      8000,
      '"Try with different document" button not found'
    );
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", tryDifferentBtn);
    await clickElement(driver, tryDifferentBtn, "Try with different document");
    await sleep(1500);

    // 3. The document type reads "Aadhaar card" by default; touch it only if it does not.
    try {
      const trigger = await driver.findElements(By.css('[role="combobox"][data-slot="select-trigger"]'));
      if (trigger.length > 0) {
        const currentText = ((await trigger[0].getText()) || "").trim().toLowerCase();
        if (!currentText.includes("aadhaar")) {
          await clickElement(driver, trigger[0], "Document type selector");
          await sleep(500);
          const options = await driver.findElements(
            By.xpath(`//*[@role="option"][contains(${lower(".")}, "aadhaar")]`)
          );
          if (options.length > 0) {
            await clickElement(driver, options[0], "Aadhaar card option");
            await sleep(500);
          } else {
            warn("   ⚠️ Document type dropdown opened but no Aadhaar option was found - leaving as is.");
          }
        }
      }
    } catch (e) {
      warn(`   ⚠️ Could not confirm the document type selector: ${plain(e.message)}`);
    }

    // What the page already says BEFORE the upload (the hand-off card's own
    // "No record found") is not the portal refusing the document.
    let baseline = null;
    try {
      baseline = await readKycError(driver);
    } catch (e) { }
    const isNewError = (text) => !!text && !(baseline && sameText(text, baseline));

    // 4. Attach. The visible "Tap to upload" button is a styled proxy for the
    //    real <input type="file">; clicking it would open an OS dialog.
    const fileInput = await driver.wait(
      async () => {
        let picked = null;
        try {
          picked = await driver.executeScript(PICK_FILE_INPUT_IN_PAGE);
        } catch (e) { }
        if (picked) return picked;
        const els = await driver.findElements(By.css("input[type='file']"));
        return els.length > 0 ? els[0] : null;
      },
      8000,
      "Aadhaar upload <input type=file> not found"
    );
    await driver.executeScript(
      "arguments[0].style.display='block'; arguments[0].style.opacity='1'; arguments[0].style.visibility='visible';",
      fileInput
    );
    await fileInput.sendKeys(doc.filePath);
    log(`   ✓ Attached Aadhaar image: ${doc.fileName} (${doc.kind}, ${doc.size} bytes)`);

    // Read back what the browser took — proof in the log that the file went in.
    let held = null;
    try {
      held = await driver.executeScript(READ_INPUT_IN_PAGE, fileInput);
    } catch (e) { }
    if (held) {
      if (held.count > 0) {
        log(
          `   📎 The file input holds ${held.name} (${held.size} bytes)` +
            `${held.accept ? `, accepts "${held.accept}"` : ""}${held.size !== doc.size ? " - SIZE DIFFERS from the file" : ""}`
        );
      } else {
        log("   📎 The file input is empty again - the page took the file and cleared the box");
      }
    }

    // Give the page a moment to show the file; never a failure in itself.
    const shownDeadline = Date.now() + SHOWN_WAIT_MS;
    let shown = false;
    while (Date.now() < shownDeadline) {
      try {
        shown = !!(await driver.executeScript(PAGE_MENTIONS_IN_PAGE, doc.fileName));
      } catch (e) { }
      if (shown) break;
      await sleep(POLL_MS);
    }
    log(shown ? "   ✓ The page shows the file" : "   · The page does not echo the file name (not unusual)");

    // 5. Submit for Verification — waited for until it is live, or the page says why not.
    const submitBtn = await driver.wait(
      async () => {
        const els = await driver.findElements(buttonWithText("submit for verification"));
        return els.length > 0 ? els[0] : null;
      },
      8000,
      "Submit for Verification button (upload step) not found"
    );
    const enabledDeadline = Date.now() + SUBMIT_ENABLED_WAIT_MS;
    let live = false;
    while (true) {
      try {
        const aria = await submitBtn.getAttribute("aria-disabled");
        live = (await submitBtn.isEnabled()) && aria !== "true";
      } catch (e) {
        live = true; // cannot tell - go ahead as before
      }
      if (live) break;
      const refusal = await readKycError(driver).catch(() => null);
      if (isNewError(refusal)) {
        return {
          ok: false,
          retryable: false,
          kycStatus: refusal,
          error:
            `The KSHEMA KYC page refused the uploaded document - it said "${plain(refusal)}". ` +
            "Check the customer's Aadhaar card image on the policy.",
        };
      }
      if (Date.now() >= enabledDeadline) break;
      await sleep(POLL_MS);
    }
    if (!live) {
      return {
        ok: false,
        retryable: false,
        error:
          "The KSHEMA KYC page did not make Submit for Verification available after the Aadhaar was attached " +
          `(waited ${Math.round(SUBMIT_ENABLED_WAIT_MS / 1000)} s and it gave no message). ` +
          "Check the customer's Aadhaar card image on the policy.",
      };
    }
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", submitBtn);
    await clickElement(driver, submitBtn, "Submit for Verification (document upload)");
    log("   🚀 Clicked Submit for Verification (document upload)");

    // 6. The review screen — OR the portal saying it could not read the file.
    log("   ⏳ Waiting for the OCR review screen...");
    const reviewDeadline = Date.now() + REVIEW_WAIT_MS;
    let verifyBtn = null;
    while (Date.now() < reviewDeadline) {
      const els = await driver.findElements(buttonWithText("details are correct"));
      if (els.length > 0) {
        verifyBtn = els[0];
        break;
      }
      const refusal = await readKycError(driver).catch(() => null);
      if (isNewError(refusal)) {
        warn(`   ✗ The KYC page refused the uploaded document: ${plain(refusal)}`);
        return {
          ok: false,
          retryable: false,
          kycStatus: refusal,
          error:
            `The KSHEMA KYC page refused the uploaded document - it said "${plain(refusal)}". ` +
            "Check the customer's Aadhaar card image on the policy.",
        };
      }
      await sleep(POLL_MS);
    }
    if (!verifyBtn) {
      return {
        ok: false,
        retryable: false,
        error:
          `The KSHEMA KYC page did not show its review screen within ${Math.round(REVIEW_WAIT_MS / 1000)} s ` +
          "of the Aadhaar being uploaded and gave no message. Check the customer's Aadhaar card image on the policy.",
      };
    }
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", verifyBtn);
    await clickElement(driver, verifyBtn, "Details are correct - Verify");
    log("   ✅ Clicked Details are correct - Verify");

    // 7. Watch it move on. Still on the review screen with no error = cancel, retry later. The review screen going away
    //    is NOT success by itself: the verdict (DigiLocker card + "gender doesn't match" and the like) is drawn a few
    //    seconds later, so the page has to stay clean for a settle window first.
    const afterDeadline = Date.now() + AFTER_VERIFY_WAIT_MS;
    while (Date.now() < afterDeadline) {
      const freshError = await readKycError(driver).catch(() => null);
      if (isNewError(freshError)) {
        return {
          ok: false,
          retryable: false,
          kycStatus: freshError,
          error:
            `The KSHEMA KYC page refused the re-uploaded document - it said "${plain(freshError)}". ` +
            "Check the customer's Aadhaar card image on the policy.",
        };
      }
      const stillOnReview = await driver.findElements(buttonWithText("details are correct"));
      if (stillOnReview.length === 0) {
        const settled = await settleKycOutcome(driver, { readKycError, sleep });
        if (!settled.ok) {
          warn(`   ✗ The KYC page refused the verification: ${plain(settled.text)}`);
          return {
            ok: false,
            retryable: false,
            kycStatus: settled.text,
            error: kycValidationMessage(settled.text),
          };
        }
        return { ok: true, settled: true };
      }
      await sleep(1000);
    }

    warn("   ⏳ Verification did not resolve within 20s - cancelling and retrying later.");
    try {
      const cancelBtn = await driver.findElements(buttonWithText("cancel"));
      if (cancelBtn.length > 0) await clickElement(driver, cancelBtn[0], "Cancel (verification stuck)");
    } catch (e) {
      warn(`   Could not click Cancel: ${plain(e.message)}`);
    }
    return {
      ok: false,
      retryable: true,
      error:
        "The KSHEMA KYC verification did not resolve within 20 seconds after re-uploading the Aadhaar card. The job will be retried.",
    };
  } catch (e) {
    warn(`   ⚠️ Document-upload recovery could not proceed: ${plain(e && e.message)}`);
    return { ok: false, retryable: false, error: e && e.message ? e.message : String(e) };
  } finally {
    // Only now: the portal has read the file (or never will). Never 1.5 s after attaching it.
    discardDocument(doc);
  }
}

module.exports = {
  fetchAadhaarDocument,
  uploadAadhaarForKyc,
  settleKycOutcome,
  kycValidationMessage,
  discardDocument,
  downloadToFile,
  documentMessage,
  KshemaDocumentError,
  TEMP_DIR,
};
