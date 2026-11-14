/**
 * United India KYC (the owner, 2026-11-13) - after Compute Premium on a proposal opened again from Proposal Modification:
 *   Modify        <img src=".../Modify.JPG" onclick="fnSubmit('update')" id="updt" name="updtimg">  -> its confirmation OK,
 *                 the loader watched to its end (20 s)
 *   (the page scrolled to its very end)
 *   Update Ckyc   <input type="button" name="verifykyc" value="Update Ckyc" onclick="kycVerify('GC...','../ckyc/CkycMandate.do?tId');">
 *                 -> a NEW browser window (CkycMandate) - the run goes on in it
 *   Offline KYC   <button type="submit" name="param" value="Offline">  -> the KYC details (in that window)
 *   Proof of Identity  select#proofOfIdentity       = "Aadhaar card"
 *   Document No        input#documentNo             = the policy's Aadhaar number (12 digits, read off the card)
 *   Verification       select#origVerificationStat  = "Verified"
 *   Same as above      input#sameAsAbove (checkbox, onclick DisableFields) ticked
 *   Save               <button type="submit" name="param" value="Save" disabled>  -> pressed once it is enabled
 * After Save, what United India answers (its popups' words, the page) is said in the log and in the stop: what comes after
 * Save is the owner's next step. The policy's data is checked FIRST, before anything is clicked. The Aadhaar number shows
 * only as XXXXXXXX1234 in the log and the errors.
 * A new proposal (after Update, not Modify) takes the same steps when the Update Ckyc button is on its page (`ifShown`).
 *
 * KYC ALREADY DONE (the owner's live run, 2026-11-14): the CKYC window opens on "CKYC Status-Online Search" - Customer Id,
 * Result "Offline KYC Done" - with Offline KYC DISABLED (<button ... value="Offline" class="btn btn-default" disabled>).
 * The owner: "if Offline KYC is disabled, the KYC is already finished - update KYC finished". So the window's status is read
 * first: disabled = nothing entered, the part's KYC step = completed (mode offline, the Result and Customer Id kept). After a
 * fresh Save the status is read again: Offline KYC disabled there too = the KYC step completed. The owner's live Save (same day)
 * answered with "CKYC Status-Offline" and "Offline data saved successfully" (no Offline KYC button there): that message counts
 * as done too.
 * KYC finished (either way) -> the window's own Close (the owner, 2026-11-14):
 *   <button type="submit" name="param" value="Close" class="btn btn-default" onclick="window.close();">Close</button>
 * pressed, the window checked gone, the run back on the proposal page. A window its Close does not close (pressed twice) is
 * closed by the run (said in the log) - the KYC is saved by then.
 */
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { throwIfHeld } = require("../../../lib/holdStop");
const { clickAndConfirm, fillAndConfirm, selectAndConfirm, waitForShown, waitUntil, notVisible, popupOr, VIDEO_PAUSE_MS } = require("./unitedIndiaSteps");
const { pressAndWatch, clickToNextPage } = require("./unitedIndiaNavigate");
const { scrollToEndInPage } = require("./unitedIndiaCompute");
const { readProposalInPage } = require("./unitedIndiaProposal");

const STAGE = "united-india-kyc";
const MODIFY = { label: "Modify", target: ["img[src*='Modify.JPG']", "img[name='updtimg']", By.xpath("//img[contains(@src,'Modify.JPG')]")] };
const UPDATE_CKYC = { label: "Update Ckyc", target: ["input[name='verifykyc']", By.xpath("//input[@type='button' and @value='Update Ckyc']")] };
const OFFLINE_KYC = { label: "Offline KYC", target: ["button[name='param'][value='Offline']", By.xpath("//button[@name='param' and normalize-space(.)='Offline KYC']")] };
const PROOF = { label: "Proof of Identity", selectId: "proofOfIdentity", answer: "Aadhaar card" };
const DOCUMENT_NO = { label: "Document No", target: ["#documentNo", "input[name='documentNo']"] };
const VERIFICATION = { label: "Verification Status", selectId: "origVerificationStat", answer: "Verified" };
const SAME_AS_ABOVE = { label: "Same as above", target: ["#sameAsAbove", "input[name='sameAsAbove']"] };
const CLOSE = { label: "Close", target: ["button[name='param'][value='Close']", By.xpath("//button[@name='param' and normalize-space(.)='Close']")] };
/** A click whose window closed under it: done, not an error. */
const WINDOW_GONE = /no such window|target window already closed|window was already closed|web view not found/i;
const SAVE = { label: "Save", target: ["button[name='param'][value='Save']", By.xpath("//button[@name='param' and normalize-space(.)='Save']")] };
/** Modify / Save: their loader at most this long; the CKYC window and the Update Ckyc button too. */
const KYC_WAIT_MS = 20000;
/** After Modify the only popup answered OK is a confirmation (the GSTIN/UIN question, "proceed / modify / sure ..."). */
const CONFIRMATION = /GSTIN|proceed|modify|update|sure|confirm|continue/i;

/** The policy's Aadhaar number, digits only. */
const aadhaarOf = (data = {}) =>
  String(data.aadharNumber || (data.formData && data.formData.aadharNumber) || data.AadharNumber || "").replace(/\s+/g, "");
/** XXXXXXXX1234 - never the whole number in a log or an error. */
const maskAadhaar = (value) => {
  const d = String(value == null ? "" : value).replace(/\s+/g, "");
  return d.length > 4 ? `${"X".repeat(d.length - 4)}${d.slice(-4)}` : d ? "XXXX" : "";
};

/** Why the KYC cannot be done with this policy's data - null when it can. */
function kycDataProblem(data = {}) {
  const n = aadhaarOf(data);
  if (!n) return "the policy has no Aadhaar number";
  if (!/^\d{12}$/.test(n)) return `the Aadhaar number on the policy (${maskAadhaar(n)}) is not 12 digits`;
  return null;
}

/**
 * In the page: the CKYC window's status - is Offline KYC there / disabled, the Result and the Customer Id shown next to their
 * labels ("Result :", "Customer Id :" - the box after the label: an input / textarea's value, else its text).
 */
function readCkycStatusInPage() {
  var text = function (el) {
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
  };
  var valueAfter = function (re) {
    var labels = document.querySelectorAll("td, th, label, div, span, strong, b, p");
    for (var i = 0; i < labels.length; i++) {
      var el = labels[i];
      var t = text(el);
      if (!t || t.length > 30 || !re.test(t)) continue;
      var box = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling);
      while (box && !text(box) && !/INPUT|TEXTAREA|SELECT/.test(box.tagName) && !box.querySelector("input, textarea, select")) box = box.nextElementSibling;
      if (!box) continue;
      var field = /INPUT|TEXTAREA|SELECT/.test(box.tagName) ? box : box.querySelector("input, textarea, select");
      var v = field ? String(field.value || field.textContent || "") : text(box);
      v = v.replace(/\s+/g, " ").trim();
      if (v) return v;
    }
    return "";
  };
  var btn = document.querySelector("button[name='param'][value='Offline']");
  var body = document.body ? (document.body.innerText || "").replace(/\s+/g, " ") : "";
  var saved = /offline data saved successfully|data saved successfully/i.exec(body);
  return {
    offline: !!btn,
    offlineDisabled: !!(btn && btn.disabled),
    result: valueAfter(/^result\s*:?$/i),
    customerId: valueAfter(/^customer\s*id\s*:?$/i),
    saved: saved ? saved[0] : "",
    title: String(document.title || ""),
  };
}

const readStatus = async (driver) => (await driver.executeScript(readCkycStatusInPage).catch(popupOr("the CKYC window", STAGE))) || {};

/** The part's KYC step = completed (never throws: the KYC is done at United India either way). @returns {Promise<boolean>} */
async function markKycDone(data, status, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const deps = o.deps || {};
  const markStage = deps.markStage || ((d, stage, st, extra, opts) => require("../../../fullPolicycompany/reliance/relianceStages").markStage(d, stage, st, extra, opts));
  const extra = { mode: "offline", ...(status.result ? { result: status.result } : {}), ...(status.customerId ? { customerId: status.customerId } : {}) };
  const saved = await Promise.resolve(markStage(data, "kyc", "completed", extra, { jobId: o.jobId || "", insurer: "United India" })).catch(() => false);
  if (saved) log("✅ United India - KYC step = completed on the policy");
  else log("⚠️ United India - the KYC is done at United India, but the KYC step could not be saved on the policy - set it to Completed by hand in Edit -> Status");
  return !!saved;
}

/**
 * The CKYC window's Close: pressed (twice at most), the window checked gone; else closed by the run. Back on `main`.
 * @returns {Promise<{ by: "button" | "run" }>}
 */
async function closeCkycWindow(driver, main, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const { pageLoadLimit } = require("./unitedIndiaNavigate");
  const here = await driver.getWindowHandle().catch(() => null);
  const stillOpen = async () => !!here && ((await driver.getAllWindowHandles().catch(() => null)) || []).includes(here);
  // Close is a submit button: its page load must not hold the run - a short limit around the presses (the window goes anyway)
  const limitBefore = await pageLoadLimit(driver, 5000);
  let by = "button";
  try {
    for (let attempt = 1; attempt <= 2 && (await stillOpen()); attempt++) {
      const btn = await waitForShown(driver, CLOSE.target, 5000, o).catch(() => null);
      if (!btn) break;
      throwIfHeld(driver);
      try {
        await btn.click();
      } catch (e) {
        const why = `${(e && e.name) || ""} ${(e && e.message) || e}`;
        if (!WINDOW_GONE.test(why) && !/timeout/i.test(why)) await driver.executeScript("arguments[0].click();", btn).catch(() => {});
      }
      if (await waitUntil(driver, async () => !(await stillOpen()), 5000, o).catch(() => false)) break;
      if (attempt < 2) log('↻ United India - the CKYC window is still open after "Close" - pressing it once more');
    }
    if (await stillOpen()) {
      by = "run";
      log('⚠️ United India - the CKYC window did not close with its "Close" button - the run closed it');
      await driver.close().catch(() => {});
    }
    if (main) await driver.switchTo().window(main);
  } finally {
    if (limitBefore) await pageLoadLimit(driver, limitBefore); // the run's own limit again
  }
  log(`🪟 United India - the CKYC window closed (${by === "button" ? "its Close button" : "by the run"}) - back on the proposal page`);
  return { by };
}

/** In the page: the KYC details as they stand. */
function readKycFormInPage() {
  var v = function (id) {
    var el = document.getElementById(id);
    return el ? String(el.value) : null;
  };
  var same = document.getElementById("sameAsAbove");
  var save = document.querySelector("button[name='param'][value='Save']");
  return { proof: v("proofOfIdentity"), documentNo: v("documentNo"), verification: v("origVerificationStat"), same: !!(same && same.checked), saveDisabled: save ? !!save.disabled : null };
}

const readForm = async (driver) => (await driver.executeScript(readKycFormInPage).catch(popupOr("the CKYC window", STAGE))) || {};

const toEnd = async (driver, label, o) => {
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const moved = await driver.executeScript(scrollToEndInPage).catch(popupOr(label, STAGE));
  if (moved) await sleep(driver, VIDEO_PAUSE_MS);
};

/** Modify: its confirmation OK, the loader watched to its end (20 s). */
async function modifyProposal(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  await toEnd(driver, MODIFY.label, o);
  const onPopup = (text) => (CONFIRMATION.test(String(text || "")) ? "accept" : null);
  const isDone = async ({ loader, changed, answered }) => loader || changed || answered > 0;
  const watched = await pressAndWatch(driver, { label: MODIFY.label, target: MODIFY.target, stage: STAGE, maxMs: o.kycWaitMs || KYC_WAIT_MS, onPopup, isDone }, { ...o, log });
  if (!watched.done) {
    throw new MultiCompanyError(
      "E302",
      `United India - ${watched.spinning ? "the portal's loader was still spinning" : "nothing happened"} ${(o.kycWaitMs || KYC_WAIT_MS) / 1000} seconds after "Modify", so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  log(`✅ United India - "Modify" done${watched.loaderSeen ? ` (the loader ran ${Math.round(watched.loaderMs / 100) / 10} s)` : ""}`);
  // what the page shows now (Modify moves the Reference Date to the day it was modified - the owner, 2026-11-14)
  return (await driver.executeScript(readProposalInPage).catch(() => null)) || {};
}

/**
 * The page's end, Update Ckyc, the NEW window it opens - the run goes on there.
 * @returns {Promise<{ url: string, main: string }|null>} null: `ifShown` and no Update Ckyc button on the page
 */
async function openCkycWindow(driver, { ifShown = false } = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  await toEnd(driver, UPDATE_CKYC.label, o);
  const findMs = ifShown ? 5000 : o.kycWaitMs || KYC_WAIT_MS;
  if (!(await waitForShown(driver, UPDATE_CKYC.target, findMs, o))) {
    if (ifShown) return null;
    throw notVisible(UPDATE_CKYC.label, Math.round(findMs / 1000), STAGE);
  }
  const main = await driver.getWindowHandle().catch(() => null);
  const before = (await driver.getAllWindowHandles().catch(() => null)) || [];
  const added = async () => ((await driver.getAllWindowHandles().catch(() => null)) || []).filter((h) => !before.includes(h));
  await clickAndConfirm(
    driver,
    {
      label: UPDATE_CKYC.label,
      target: UPDATE_CKYC.target,
      done: async () => (await added()).length > 0,
      effect: "the CKYC window opened",
      missing: "no CKYC window opened",
      stage: STAGE,
      effectMs: 10000,
    },
    { ...o, log }
  );
  const fresh = await added();
  await driver.switchTo().window(fresh[fresh.length - 1]);
  const loaded = await waitUntil(
    driver,
    async () => (await driver.executeScript("return document.readyState").catch(() => "")) === "complete",
    o.kycWaitMs || KYC_WAIT_MS,
    o
  );
  if (!loaded) {
    throw new MultiCompanyError("E302", `United India - the CKYC window did not finish loading within ${(o.kycWaitMs || KYC_WAIT_MS) / 1000} seconds, so the run stopped there. It will try again shortly.`, {
      company: "united india",
      stage: STAGE,
    });
  }
  await waitForLoader(driver, "united india", { stage: STAGE }).catch(popupOr(UPDATE_CKYC.label, STAGE));
  const url = await driver.getCurrentUrl().catch(() => "");
  log(`🪟 United India - the CKYC window is open (${url}) - the run goes on there`);
  return { url, main };
}

/** Offline KYC, then the details: Aadhaar card, its number, Verified, Same as above - each read back; Save enabled. */
async function enterOfflineKyc(driver, aadhaar, o = {}) {
  const log = o.log || ((line) => console.log(line));
  await clickToNextPage(driver, { label: OFFLINE_KYC.label, target: OFFLINE_KYC.target, stage: STAGE }, { ...o, log });
  const loader = (label) => waitForLoader(driver, "united india", { stage: STAGE }).catch(popupOr(label, STAGE));

  await selectAndConfirm(driver, { label: PROOF.label, selectId: PROOF.selectId, wanted: PROOF.answer, stage: STAGE }, { ...o, log });
  await loader(PROOF.label);
  await fillAndConfirm(driver, { label: DOCUMENT_NO.label, target: DOCUMENT_NO.target, value: aadhaar, stage: STAGE, keepIfSame: true, mask: maskAadhaar }, { ...o, log });
  await loader(DOCUMENT_NO.label);
  await selectAndConfirm(driver, { label: VERIFICATION.label, selectId: VERIFICATION.selectId, wanted: VERIFICATION.answer, stage: STAGE }, { ...o, log });
  await loader(VERIFICATION.label);
  await clickAndConfirm(
    driver,
    {
      label: SAME_AS_ABOVE.label,
      target: SAME_AS_ABOVE.target,
      done: async () => (await readForm(driver)).same === true,
      effect: "it is ticked",
      missing: "it is not ticked",
      stage: STAGE,
      effectMs: 3000,
    },
    { ...o, log }
  );
  await loader(SAME_AS_ABOVE.label);

  // all four once more (a box the next one changed is caught here), then Save must come enabled
  const now = await readForm(driver);
  const wrong = [
    now.proof !== PROOF.answer && `Proof of Identity reads "${now.proof == null ? "" : now.proof}"`,
    String(now.documentNo || "").replace(/\s+/g, "") !== aadhaar && `Document No reads "${maskAadhaar(now.documentNo)}"`,
    now.verification !== VERIFICATION.answer && `Verification Status reads "${now.verification == null ? "" : now.verification}"`,
    now.same !== true && "Same as above is not ticked",
  ].filter(Boolean);
  if (wrong.length) {
    throw new MultiCompanyError("E306", `United India - in the CKYC window ${wrong.join(", and ")} after the details were entered, so the run stopped there. It will try again shortly.`, {
      company: "united india",
      stage: STAGE,
    });
  }
  const enabled = await waitUntil(driver, async () => (await readForm(driver)).saveDisabled === false, 10000, o);
  if (!enabled) {
    throw new MultiCompanyError(
      "E306",
      "United India - Save in the CKYC window stayed disabled after Aadhaar card, the Aadhaar number, Verified and Same as above were entered, so the run stopped there. United India may want another detail - see the screenshot.",
      { company: "united india", stage: STAGE, retryable: false }
    );
  }
  log(`✓ United India - Offline KYC details entered (Aadhaar card ${maskAadhaar(aadhaar)}, Verified, Same as above) - Save is enabled`);
}

/**
 * Save, its loader watched (20 s). Every popup after it is answered OK and its words KEPT - they are United India's answer.
 * @returns {Promise<{ said: string[], page: { url, title, text } }>}
 */
async function saveKyc(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const said = [];
  const onPopup = (text) => {
    said.push(String(text || "").replace(/\s+/g, " ").trim());
    return "accept";
  };
  const isDone = async ({ loader, changed, answered }) => loader || changed || answered > 0;
  const watched = await pressAndWatch(driver, { label: SAVE.label, target: SAVE.target, stage: STAGE, maxMs: o.kycWaitMs || KYC_WAIT_MS, onPopup, isDone }, { ...o, log });
  if (!watched.done) {
    throw new MultiCompanyError(
      "E302",
      `United India - ${watched.spinning ? "the portal's loader was still spinning" : "nothing happened"} ${(o.kycWaitMs || KYC_WAIT_MS) / 1000} seconds after "Save" in the CKYC window, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  const page =
    (await driver
      .executeScript("return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 300) };")
      .catch(() => null)) || {};
  log(`💾 United India - KYC "Save" done${said.length ? ` - United India said "${said.join('" / "')}"` : ""} (${page.url || "-"})`);
  return { said, page };
}

/**
 * The KYC: the policy's data first; Modify (a proposal opened again); Update Ckyc -> its window; Offline KYC; the details; Save.
 * @param {WebDriver} driver  on the proposal's page, Compute Premium done
 * @param {Object} data       the job data (aadharNumber)
 * @param {{ modify?: boolean, ifShown?: boolean }} [how]  modify: press Modify first; ifShown: no Update Ckyc button = null
 * o.onModified(shown): told what the page shows after Modify (its proposal number and Reference Date) - never fails the KYC
 * @returns {Promise<{ window: string, said: string[], page: Object, aadhaar: string, alreadyDone?: boolean, kycDone: boolean,
 *   result: string, customerId: string, stepSaved: boolean }|null>}
 */
async function unitedIndiaKyc(driver, data = {}, { modify = false, ifShown = false } = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const problem = kycDataProblem(data);
  if (problem) {
    throw new MultiCompanyError(
      "E306",
      `United India - ${problem}, so the KYC cannot be done and the run stopped there. Add the Aadhaar number on the policy (Read Aadhaar & fill details), then run it again.`,
      { company: "united india", stage: STAGE, retryable: false }
    );
  }
  const aadhaar = aadhaarOf(data);
  log(`🪪 United India - KYC: ${modify ? "Modify, " : ""}Update Ckyc, Offline KYC with the Aadhaar card ${maskAadhaar(aadhaar)}`);
  if (modify) {
    const shown = await modifyProposal(driver, { ...o, log });
    if (typeof o.onModified === "function") await Promise.resolve(o.onModified(shown)).catch(() => {});
  }
  throwIfHeld(driver);
  const opened = await openCkycWindow(driver, { ifShown }, { ...o, log });
  if (!opened) {
    log("   United India - no Update Ckyc button on the page - the KYC is not started here");
    return null;
  }
  // the window's status FIRST: Offline KYC disabled = the KYC is already done at United India (the owner's live run)
  const status = await readStatus(driver);
  log(`   CKYC window: Customer Id ${status.customerId || "-"}, Result "${status.result || "-"}", Offline KYC ${status.offline ? (status.offlineDisabled ? "disabled" : "enabled") : "not on the page"}`);
  if (status.offlineDisabled) {
    log(`✅ United India - the KYC is already done at United India (Offline KYC is disabled${status.result ? `, "${status.result}"` : ""}) - nothing entered again`);
    const stepSaved = await markKycDone(data, status, { ...o, log });
    const closed = await closeCkycWindow(driver, opened.main, { ...o, log });
    return { window: opened.url, alreadyDone: true, kycDone: true, result: status.result || "", customerId: status.customerId || "", stepSaved, closed: closed.by, said: [], page: {}, aadhaar: maskAadhaar(aadhaar) };
  }
  await enterOfflineKyc(driver, aadhaar, { ...o, log });
  throwIfHeld(driver);
  const saved = await saveKyc(driver, { ...o, log });
  // after Save: the same rule - Offline KYC disabled now = the KYC is done
  // after Save: "Offline data saved successfully" (the owner's live run) or Offline KYC disabled = the KYC is done
  const after = await readStatus(driver).catch(() => ({}));
  const doneBy = after.saved ? "saved" : after.offlineDisabled ? "disabled" : null;
  const kycDone = !!doneBy;
  if (kycDone) log(`✅ United India - the KYC is done at United India (${doneBy === "saved" ? `it says "${after.saved}"` : "Offline KYC is disabled now"}${after.customerId ? `, Customer Id ${after.customerId}` : ""})`);
  const stepSaved = kycDone ? await markKycDone(data, { ...after, result: after.result || after.saved }, { ...o, log }) : false;
  if (!kycDone) log("   United India - after Save there is no \"saved successfully\" and Offline KYC is not shown disabled - the KYC step is left as it is (the CKYC window stays open)");
  const closed = kycDone ? await closeCkycWindow(driver, opened.main, { ...o, log }) : null;
  return { window: opened.url, ...saved, kycDone, doneBy, result: after.result || after.saved || "", customerId: after.customerId || "", stepSaved, closed: closed ? closed.by : null, aadhaar: maskAadhaar(aadhaar) };
}

module.exports = {
  unitedIndiaKyc,
  modifyProposal,
  openCkycWindow,
  enterOfflineKyc,
  saveKyc,
  kycDataProblem,
  aadhaarOf,
  maskAadhaar,
  readKycFormInPage,
  readCkycStatusInPage,
  markKycDone,
  closeCkycWindow,
  CLOSE,
  MODIFY,
  UPDATE_CKYC,
  OFFLINE_KYC,
  PROOF,
  DOCUMENT_NO,
  VERIFICATION,
  SAME_AS_ABOVE,
  SAVE,
  CONFIRMATION,
  KYC_WAIT_MS,
  STAGE,
};
