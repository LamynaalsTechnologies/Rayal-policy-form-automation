/**
 * Reliance KYC upload page — choosing "UPLOAD DOCUMENT" and putting the document into Identity and Address
 * Verification, by the page's own markup.
 *
 * The page (Arya.ai KYC onboarding, an Angular app, opened by DO KYC -> OVD UPLOAD -> Continue) was read from a saved
 * page source on 2026-10-14. What it is — and what the flow used to do about it:
 *
 *   The five options are  div.doc-type[ng-click="selectDoc('pan'|'aadhaar'|'ckyc'|'upload'|'aa')"], each inside its
 *   own wrapper (#upload-radio for UPLOAD DOCUMENT); the chosen one's wrapper has the class "active-r".
 *     before: querySelector("[ng-click*='selectDoc']") — the FIRST of them, which is PAN.
 *
 *   There are 16 upload areas and 13 <input type=file> on the page (Individual and Corporate tabs, several document
 *   types), every one with its own handler in ngf-select:
 *       Identity Verification  uploadFile($file,'file1', true, 'pan')
 *       Address Verification   uploadFile($file,'file2')
 *   The handler is what makes a file an identity proof or an address proof.
 *     before: the first area containing 'file1', then the file inputs in PAGE order for file1 and last-to-first for
 *     file2 — the first input in the page is a file2 input and the last a file1/'pan' input, so the two documents
 *     went in with their handlers swapped.
 *
 * Now: the option is clicked and the wrapper checked for "active-r"; each document goes into the input whose
 * ngf-select is EXACTLY its handler (Angular's scope call on the visible area as the fallback), and the slot is
 * waited for until the page has taken it — or has said why not.
 *
 * Used by relianceForm.js and, being shared, by every Reliance flow that reaches this page.
 */
const { readKycPage } = require("./relianceKycSubmit");

/** The handlers exactly as the page writes them in `ngf-select`. */
const SLOT_HANDLERS = {
  identity: "uploadFile($file,'file1', true, 'pan')",
  address: "uploadFile($file,'file2')",
};
/** The model each handler fills. */
const SLOT_MODEL = { identity: "file1", address: "file2" };
const SLOT_LABEL = { identity: "Identity Verification", address: "Address Verification" };

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises their source)             */
/* -------------------------------------------------------------------------- */

/**
 * The UPLOAD DOCUMENT option (the .doc-type div to click): the one on screen, or null. Three ways, most exact first:
 *   1. the option's own wrapper  #upload-radio
 *   2. the handler written exactly  ng-click="selectDoc('upload')"
 *   3. its label among the options  (.doc-type / [ng-click*='selectDoc'])
 * Never "the first selectDoc" — that is PAN.
 */
function findUploadOptionInPage() {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var candidates = [];
  function add(el) {
    if (el && candidates.indexOf(el) < 0) candidates.push(el);
  }
  var wrap = document.getElementById("upload-radio");
  if (wrap) add(wrap.querySelector(".doc-type") || wrap.querySelector("[ng-click*='selectDoc']"));
  var withClick = document.querySelectorAll("[ng-click]");
  for (var i = 0; i < withClick.length; i++) {
    var handler = withClick[i].getAttribute("ng-click") || "";
    if (/^\s*selectDoc\(\s*['"]upload['"]\s*\)\s*;?\s*$/.test(handler)) add(withClick[i]);
  }
  var labelled = document.querySelectorAll(".doc-type, [ng-click*='selectDoc']");
  for (var j = 0; j < labelled.length; j++) {
    if (/upload\s*document/i.test(labelled[j].innerText || labelled[j].textContent || "")) add(labelled[j]);
  }
  for (var k = 0; k < candidates.length; k++) {
    if (shown(candidates[k])) return candidates[k];
  }
  return candidates.length ? candidates[0] : null;
}

/** @returns {{found:boolean, shown:boolean, selected:boolean}} — "selected" = the option's wrapper carries "active-r". */
function readUploadOptionInPage() {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var candidates = [];
  function add(el) {
    if (el && candidates.indexOf(el) < 0) candidates.push(el);
  }
  var wrap = document.getElementById("upload-radio");
  if (wrap) add(wrap.querySelector(".doc-type") || wrap.querySelector("[ng-click*='selectDoc']"));
  var withClick = document.querySelectorAll("[ng-click]");
  for (var i = 0; i < withClick.length; i++) {
    var handler = withClick[i].getAttribute("ng-click") || "";
    if (/^\s*selectDoc\(\s*['"]upload['"]\s*\)\s*;?\s*$/.test(handler)) add(withClick[i]);
  }
  var labelled = document.querySelectorAll(".doc-type, [ng-click*='selectDoc']");
  for (var j = 0; j < labelled.length; j++) {
    if (/upload\s*document/i.test(labelled[j].innerText || labelled[j].textContent || "")) add(labelled[j]);
  }
  var option = null;
  for (var k = 0; k < candidates.length && !option; k++) {
    if (shown(candidates[k])) option = candidates[k];
  }
  if (!option && candidates.length) option = candidates[0];
  var active = function (el) {
    return !!el && /(^|\s)active-r(\s|$)/.test(el.className || "");
  };
  var selected = false;
  if (option) selected = active(option) || active(option.parentElement) || (!!wrap && active(wrap));
  return { found: !!option, shown: shown(option), selected: selected };
}

/** How many upload areas carry exactly this handler, and how many of them are on screen. */
function dropzoneStateInPage(expr) {
  function shown(el) {
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var zones = document.querySelectorAll("[ngf-select]");
  var exists = 0;
  var onScreen = 0;
  for (var i = 0; i < zones.length; i++) {
    if (zones[i].tagName === "INPUT" || zones[i].getAttribute("ngf-select") !== expr) continue;
    exists++;
    if (shown(zones[i])) onScreen++;
  }
  return { exists: exists, shown: onScreen };
}

/** The upload area with exactly this handler that is on screen — clicked so the page prepares its file input. */
function clickDropzoneInPage(expr) {
  function shown(el) {
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var zones = document.querySelectorAll("[ngf-select]");
  for (var i = 0; i < zones.length; i++) {
    if (zones[i].tagName === "INPUT" || zones[i].getAttribute("ngf-select") !== expr || !shown(zones[i])) continue;
    zones[i].scrollIntoView({ block: "center" });
    zones[i].click(); // a script click: Chrome does not open the OS file dialog without a user gesture
    return true;
  }
  return false;
}

/** The file input that carries exactly this handler — the newest one, i.e. the one the click above made. */
function findFileInputInPage(expr) {
  var inputs = document.querySelectorAll("input[type=file]");
  var match = null;
  for (var i = 0; i < inputs.length; i++) {
    if (inputs[i].getAttribute("ngf-select") === expr) match = inputs[i];
  }
  return match;
}

/** Make a hidden file input something selenium may type a path into. */
function showInputInPage(input) {
  input.style.display = "block";
  input.style.visibility = "visible";
  input.style.opacity = "1";
  input.style.position = "fixed";
  input.style.top = "0";
  input.style.left = "0";
  input.style.height = "30px";
  input.style.width = "200px";
  input.style.zIndex = "99999";
}

/** true / false = the page's model for this slot is set / not set; null = Angular's scope is not readable. */
function slotFileInPage(expr, model) {
  try {
    if (!window.angular) return null;
    var zones = document.querySelectorAll("[ngf-select]");
    var zone = null;
    for (var i = 0; i < zones.length; i++) {
      if (zones[i].tagName === "INPUT" || zones[i].getAttribute("ngf-select") !== expr) continue;
      zone = zone || zones[i];
      var rect = zones[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        zone = zones[i];
        break;
      }
    }
    if (!zone) return null;
    var scope = window.angular.element(zone).scope();
    if (!scope) return null;
    return !!scope[model];
  } catch (e) {
    return null;
  }
}

/** The fallback: call the page's own handler on the visible area's scope, with a File built from the bytes. */
function uploadViaScopeInPage(expr, model, base64, name, mime) {
  try {
    if (!window.angular) return { ok: false, reason: "Angular is not on the page" };
    var zones = document.querySelectorAll("[ngf-select]");
    var zone = null;
    for (var i = 0; i < zones.length; i++) {
      if (zones[i].tagName === "INPUT" || zones[i].getAttribute("ngf-select") !== expr) continue;
      var rect = zones[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        zone = zones[i];
        break;
      }
    }
    if (!zone) return { ok: false, reason: "the upload area is not on screen" };
    var scope = window.angular.element(zone).scope();
    if (!scope || typeof scope.uploadFile !== "function") return { ok: false, reason: "the page has no uploadFile handler" };
    var raw = atob(base64);
    var bytes = new Uint8Array(raw.length);
    for (var b = 0; b < raw.length; b++) bytes[b] = raw.charCodeAt(b);
    var file = new File([bytes], name, { type: mime, lastModified: Date.now() });
    if (model === "file1") scope.uploadFile(file, "file1", true, "pan");
    else scope.uploadFile(file, "file2");
    try {
      scope.$apply();
    } catch (digest) {
      /* a digest is already running: the handler's change is picked up by it */
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/* -------------------------------------------------------------------------- */
/* In node                                                                    */
/* -------------------------------------------------------------------------- */

async function readUploadOption(driver) {
  try {
    const s = await driver.executeScript(readUploadOptionInPage);
    return { found: !!(s && s.found), shown: !!(s && s.shown), selected: !!(s && s.selected) };
  } catch (e) {
    return { found: false, shown: false, selected: false };
  }
}

/**
 * Click UPLOAD DOCUMENT and check the page took it (its wrapper carries "active-r").
 * @returns {Promise<{ok:boolean, attempts:number, found?:boolean, shown?:boolean}>}
 */
async function chooseUploadDocument(
  driver,
  { attempts = 2, settleMs = 5000, pollMs = 250, now = Date.now, sleep = (ms) => driver.sleep(ms) } = {}
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let option = null;
    try {
      option = await driver.executeScript(findUploadOptionInPage);
    } catch (e) {
      option = null;
    }
    if (option) {
      try {
        await option.click();
      } catch (clickError) {
        try {
          await driver.executeScript("arguments[0].click();", option);
        } catch (jsError) {
          /* the next read says whether it took */
        }
      }
      const deadline = now() + settleMs;
      for (;;) {
        const state = await readUploadOption(driver);
        if (state.selected) return { ok: true, attempts: attempt };
        if (now() >= deadline) break;
        await sleep(pollMs);
      }
    } else {
      await sleep(1000);
    }
  }
  const state = await readUploadOption(driver);
  return { ok: false, attempts, found: state.found, shown: state.shown };
}

async function readDropzone(driver, expr) {
  try {
    const z = await driver.executeScript(dropzoneStateInPage, expr);
    return { exists: Number((z && z.exists) || 0), shown: Number((z && z.shown) || 0) };
  } catch (e) {
    return { exists: 0, shown: 0 };
  }
}

async function readSlotFile(driver, expr, model) {
  try {
    const v = await driver.executeScript(slotFileInPage, expr, model);
    return v === true ? true : v === false ? false : null;
  } catch (e) {
    return null;
  }
}

/**
 * Wait until the page has taken the document in this slot — or has said why not, or time is up.
 * Taken = the page's model for the slot is set (Angular scope) or, where that cannot be read, the slot's upload
 * area has left the screen (ng-show="!file1"). A refusal toast / popup is LATCHED, like in waitForKycControl.
 *
 * `seen` is the newest error text met on the way, also when the slot was then accepted: a toast is gone in ~5 s, and
 * the SUBMIT wait that follows would otherwise know nothing of it ("the portal showed no message").
 * `seenText` seeds the latch from an earlier slot for the same reason.
 *
 * @returns {Promise<{state:"accepted"|"rejected"|"timeout", text:string, seen:string, waitedMs:number}>}
 */
async function waitForSlotAccepted(
  driver,
  slot,
  {
    timeoutMs = 120000,
    errorStableMs = 8000,
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
  const expr = SLOT_HANDLERS[slot];
  const model = SLOT_MODEL[slot];
  const ignore = new Set(ignoreErrors || []);
  const started = now();
  let latched = seenText || "";
  let latchedSince = seenText ? started : 0;
  let lastProgress = started;
  for (;;) {
    const t = now();
    const file = await readSlotFile(driver, expr, model);
    if (file === true) return { state: "accepted", text: "", seen: latched, waitedMs: t - started };
    if (file === null) {
      const zone = await readDropzone(driver, expr);
      if (zone.exists > 0 && zone.shown === 0) return { state: "accepted", text: "", seen: latched, waitedMs: t - started };
    }

    const page = await readKycPage(driver);
    const visible = page.errors.filter((e) => !ignore.has(e)).join(" | ");
    if (visible && visible !== latched) {
      latched = visible;
      latchedSince = t;
      if (onNewError) {
        try {
          await onNewError(visible); // the screenshot of a toast is taken now, it is gone in ~5 s
        } catch (e) {
          /* a screenshot callback must never end the wait */
        }
      }
    }
    if (latched && t - latchedSince >= errorStableMs) {
      return { state: "rejected", text: latched, seen: latched, waitedMs: t - started };
    }

    if (t - started >= timeoutMs) return { state: "timeout", text: latched, seen: latched, waitedMs: t - started };
    if (onProgress && t - lastProgress >= progressEveryMs) {
      lastProgress = t;
      try {
        onProgress({ slot, waitedMs: t - started, text: latched });
      } catch (e) {
        /* a logging callback must never end the wait */
      }
    }
    await sleep(pollMs);
  }
}

const MIME_OF = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/**
 * Put one document into one slot (identity / address) and wait for the page to take it.
 *
 * @param {Object} driver
 * @param {"identity"|"address"} slot
 * @param {string} filePath          the downloaded document on disk
 * @param {Object} [opts]            see waitForSlotAccepted; plus `fileName` (shown to the portal when the fallback is used)
 * @returns {Promise<{state:"accepted"|"already"|"rejected"|"timeout"|"missing"|"hidden"|"no-input", slot:string, seen:string, via?:string, text?:string, waitedMs?:number}>}
 */
async function uploadKycDocument(driver, slot, filePath, opts = {}) {
  const { sleep = (ms) => driver.sleep(ms), fileName = "", log = () => {} } = opts;
  const expr = SLOT_HANDLERS[slot];
  const model = SLOT_MODEL[slot];
  const label = SLOT_LABEL[slot];

  const before = await readDropzone(driver, expr);
  if (before.exists === 0) return { state: "missing", slot, seen: "" };
  if (before.shown === 0) {
    // not on screen: either the slot already holds a document, or that part of the page is not shown at all
    const have = await readSlotFile(driver, expr, model);
    if (have === true) return { state: "already", slot, seen: "" };
    if (have === null) {
      const page = await readKycPage(driver);
      if (page.submit.shown) return { state: "already", slot, seen: "" }; // SUBMIT is up: a document is in
    }
    return { state: "hidden", slot, seen: "" };
  }

  // wake the area's own file input (a script click opens no OS dialog)
  try {
    await driver.executeScript(clickDropzoneInPage, expr);
  } catch (e) {
    /* the input may exist already */
  }
  await sleep(600);

  let via = "input";
  let sent = false;
  try {
    const input = await driver.executeScript(findFileInputInPage, expr);
    if (input) {
      await driver.executeScript(showInputInPage, input);
      await sleep(200);
      await input.sendKeys(filePath);
      sent = true;
      log(`📤 ${label}: document sent to the input with the page's own handler ${expr}`);
    }
  } catch (e) {
    log(`⚠️ ${label}: the file input would not take the path (${e && e.message}) — using the page's handler directly`);
  }

  if (!sent) {
    via = "scope";
    const fs = require("fs");
    const path = require("path");
    let b64;
    try {
      b64 = fs.readFileSync(filePath).toString("base64");
    } catch (e) {
      return { state: "no-input", slot, via, seen: "", text: `could not read ${filePath}` };
    }
    const mime = MIME_OF[path.extname(filePath).toLowerCase()] || "image/jpeg";
    const name = fileName || path.basename(filePath);
    const result = await driver.executeScript(uploadViaScopeInPage, expr, model, b64, name, mime);
    if (!result || !result.ok) return { state: "no-input", slot, via, seen: "", text: (result && result.reason) || "" };
    log(`📤 ${label}: document handed to the page's ${expr} handler`);
  }

  const taken = await waitForSlotAccepted(driver, slot, opts);
  return { ...taken, slot, via };
}

module.exports = {
  SLOT_HANDLERS,
  SLOT_MODEL,
  SLOT_LABEL,
  findUploadOptionInPage,
  readUploadOptionInPage,
  dropzoneStateInPage,
  clickDropzoneInPage,
  findFileInputInPage,
  showInputInPage,
  slotFileInPage,
  uploadViaScopeInPage,
  readUploadOption,
  chooseUploadDocument,
  waitForSlotAccepted,
  uploadKycDocument,
};
