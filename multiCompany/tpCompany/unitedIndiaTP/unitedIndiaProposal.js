/**
 * United India, after the Quote PDF and the Worksheet (the owner, 2026-11-13): Update -> the PROPOSAL.
 *   Update   <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/Update.JPG" onclick="fnSubmit('update')" id="updt"
 *                 name="updtimg1">  -> pressed once (nothing else touched); the portal asks the GSTIN/UIN question again -> OK;
 *            its loader WATCHED (start / stop / page change in the log). DONE = the loader off for 2 s and the Proposal Number
 *            on the page, at most 15 s. Not done: the page REFRESHED (the reload and the loader stopping: 20 s) and Update
 *            pressed AGAIN, 15 s (the owner, 2026-11-13: "Update too, like Compute Premium") - unless the refreshed page
 *            already shows the proposal (the first Update finished meanwhile: a second press would make a second proposal);
 *            still nothing = [E302] a loader issue.
 *   Then the page shows the proposal:
 *     <strong>Proposal Number : </strong> 202611131194829      <strong>Transaction NO : </strong> GC202611130155864493
 *     <strong>Reference Date  :</strong> 13/11/2026              <strong>Customer ID :</strong> 23676065442
 *     (<input type="hidden" id="transactionId" name="motorTransactionIdgc" value="GC2026...">)
 *   read by their labels (a label's value is the box right after it).
 *
 * Saved (the owner: "the proposal number and the reference date - the proposal is complete, it goes straight on to the KYC"):
 *   - the part's PROPOSAL STEP = completed with the number, date, transaction and customer id (onlinePolicy.relianceStages.<part>
 *     .proposal, the steps the History cards and Edit -> Status show; KYC and Payment go back to pending) - the Reliance /
 *     KSHEMA step helper, worded United India;
 *   - onlinePolicy.unitedIndiaProposal { proposalNumber, referenceDate, transactionNo, customerId, at };
 *   - onlinePolicy.proposalNumber (the list's column) ONLY when it is still empty - on Reliance OD + United India TP the
 *     Reliance part keeps its own number there.
 * A bookkeeping write that fails is said in the log and never fails the run (the proposal exists at United India by then).
 */
const { MultiCompanyError } = require("../../common/errors");
const { pressAndWatch } = require("./unitedIndiaNavigate");
const { GSTIN_QUESTION, scrollToEndInPage, refreshAndSettle, refreshError, notDoneWhy, UPDATE_BUTTON, AFTER_REFRESH_MS } = require("./unitedIndiaCompute");
const { popupOr, VIDEO_PAUSE_MS } = require("./unitedIndiaSteps");
const { throwIfHeld } = require("../../../lib/holdStop");

const STAGE = "united-india-proposal";
const UPDATE = {
  label: "Update",
  target: UPDATE_BUTTON, // the button Compute Premium waits for (./unitedIndiaCompute.js)
};
const INSURER = "United India";
/** How long ONE Update try may take until the proposal shows; then the page is refreshed and Update pressed again (the owner, 2026-11-13: 15 s). */
const UPDATE_WAIT_MS = 15000;

/** In the page: the values next to the proposal labels ("Proposal Number :" -> the box after it), and the hidden id. */
function readProposalInPage() {
  var want = { proposalNumber: /^proposal\s*number/i, transactionNo: /^transaction\s*no/i, referenceDate: /^reference\s*date/i, customerId: /^customer\s*id/i };
  var out = { proposalNumber: "", transactionNo: "", referenceDate: "", customerId: "" };
  var labels = document.querySelectorAll("strong, b, label, td, th, div");
  for (var i = 0; i < labels.length; i++) {
    var el = labels[i];
    var text = (el.textContent || "").replace(/\s+/g, " ").trim().replace(/\s*:\s*$/, "");
    if (!text || text.length > 40) continue;
    for (var k in want) {
      if (out[k] || !want[k].test(text)) continue;
      // the value: the next box after the label's own box (the owner's markup: <div><strong>Label :</strong></div><div>value</div>)
      var box = el.tagName === "STRONG" || el.tagName === "B" ? el.parentElement : el;
      var next = box && box.nextElementSibling;
      while (next && !(next.textContent || "").trim() && next.tagName === "INPUT") next = next.nextElementSibling;
      var value = next ? (next.textContent || "").replace(/\s+/g, " ").trim() : "";
      if (value && !want[k].test(value)) out[k] = value;
    }
  }
  var hidden = document.getElementById("transactionId");
  if (!out.transactionNo && hidden && hidden.value) out.transactionNo = String(hidden.value).trim();
  return out;
}

/** The proposal number as United India writes it: digits only (spaces dropped), else "". */
const proposalNumberOf = (text) => {
  const n = String(text == null ? "" : text).replace(/\s+/g, "");
  return /^\d{8,25}$/.test(n) ? n : "";
};

/**
 * Update, then the proposal on the page - read and saved.
 * @param {WebDriver} driver  on the page after the Quote / Worksheet
 * @param {Object} data       the job data (_id, _partKey)
 * @param {{ log?, now?, sleep?, jobId?, loaderMaxMs?, deps?: { markStage, saveProposal } }} [o]
 * @returns {Promise<{ proposalNumber, referenceDate, transactionNo, customerId }>}
 */
async function updateAndSaveProposal(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const deps = o.deps || {};
  const markStage = deps.markStage || ((d, stage, status, extra, opts) => require("../../../fullPolicycompany/reliance/relianceStages").markStage(d, stage, status, extra, opts));
  const saveProposal = deps.saveProposal || defaultSaveProposal;

  // the owner's rule (2026-11-13): press Update, WATCH the loader (start / stop in the log) - done = the loader off for 2 s and the
  // Proposal Number on the page, at most 15 s; not done -> the page refreshed (the reload + the loader stopping: 20 s) and - unless
  // the refreshed page already shows the proposal (the first Update finished meanwhile: a second press = a second proposal) -
  // Update pressed AGAIN and watched, 15 s; still not = [E302]
  const firstMs = o.loaderMaxMs || UPDATE_WAIT_MS;
  const settleMs = o.afterRefreshMs || AFTER_REFRESH_MS;
  const onPopup = (text) => (GSTIN_QUESTION.test(String(text || "")) ? "accept" : null);
  const readNow = async () => (await driver.executeScript(readProposalInPage).catch(() => null)) || {};
  const isDone = async () => !!proposalNumberOf((await readNow()).proposalNumber);
  const toEnd = async () => {
    const moved = await driver.executeScript(scrollToEndInPage).catch(popupOr(UPDATE.label, STAGE));
    if (moved) await sleep(driver, VIDEO_PAUSE_MS);
  };
  await toEnd();
  let watched = await pressAndWatch(driver, { label: UPDATE.label, target: UPDATE.target, stage: STAGE, maxMs: firstMs, onPopup, isDone }, { ...o, log });
  let read;
  if (watched.done) {
    read = await readNow();
  } else {
    const why = notDoneWhy(UPDATE.label, firstMs, watched, "no Proposal Number came on the page");
    log(`⟳ United India - ${firstMs / 1000} seconds after "Update" ${watched.spinning ? "the portal's loader is still spinning" : "no Proposal Number came on the page"} - refreshing the page`);
    throwIfHeld(driver);
    const after = await refreshAndSettle(driver, { label: UPDATE.label, stage: STAGE, maxMs: settleMs }, { ...o, log });
    if (!after.settled) throw refreshError(why, settleMs, after, STAGE);
    const already = await readNow();
    if (proposalNumberOf(already.proposalNumber)) {
      log(`   the refreshed page already shows proposal ${proposalNumberOf(already.proposalNumber)} - Update is NOT pressed again`);
      read = already;
    } else {
      log('   after the refresh the loader has stopped - pressing "Update" again');
      await toEnd();
      watched = await pressAndWatch(driver, { label: UPDATE.label, target: UPDATE.target, stage: STAGE, maxMs: firstMs, onPopup, isDone }, { ...o, log });
      if (!watched.done) {
        throw new MultiCompanyError(
          "E302",
          `United India - ${watched.spinning ? "the portal's loader was still spinning" : "no Proposal Number came on the page"} ${firstMs / 1000} seconds after "Update" was pressed again (after a refresh) - a loader issue at United India, so the run stopped there. It will try again shortly.`,
          { company: "united india", stage: STAGE }
        );
      }
      read = await readNow();
    }
  }
  const proposalNumber = proposalNumberOf(read.proposalNumber);
  const proposal = {
    proposalNumber,
    referenceDate: String(read.referenceDate || "").trim(),
    transactionNo: String(read.transactionNo || "").trim(),
    customerId: String(read.customerId || "").trim(),
  };
  log(
    `📄 United India - proposal ${proposal.proposalNumber} made (Reference Date ${proposal.referenceDate || "-"}, Transaction ${proposal.transactionNo || "-"}, Customer ID ${proposal.customerId || "-"})`
  );

  // the step first (the History cards / Edit -> Status), then the policy's own fields - neither may fail the run
  const stepSaved = await markStage(data, "proposal", "completed", { ...proposal }, { jobId: o.jobId || "", insurer: INSURER }).catch(() => false);
  const fieldsSaved = await saveProposal(data, proposal).catch((e) => {
    log(`⚠️ United India - proposal ${proposalNumber} could not be saved on the policy (${String((e && e.message) || e).split("\n")[0]})`);
    return false;
  });
  if (stepSaved && fieldsSaved) {
    log(`✅ United India - proposal ${proposalNumber} saved on the policy, Proposal step = completed`);
  } else {
    const missed = [!stepSaved && "the Proposal step", !fieldsSaved && "the proposal number and date on the policy"].filter(Boolean).join(" and ");
    log(`⚠️ United India - proposal ${proposalNumber} was made at United India, but ${missed} could not be saved - complete the Proposal by hand in Edit -> Status with this number`);
  }
  return proposal;
}

/** onlinePolicy.unitedIndiaProposal always; onlinePolicy.proposalNumber only when it is empty. `MongoClient` for tests. */
async function defaultSaveProposal(data, proposal, { MongoClient = null, now = () => new Date() } = {}) {
  const stages = require("../../../fullPolicycompany/reliance/relianceStages");
  const policyId = stages.policyIdOf(data);
  if (!policyId) return false;
  const at = now();
  return stages.withPolicies(MongoClient, async (onlinePolicy) => {
    await onlinePolicy.updateOne({ _id: policyId }, { $set: { unitedIndiaProposal: { ...proposal, at }, updatedAt: at } });
    await onlinePolicy.updateOne(
      { _id: policyId, $or: [{ proposalNumber: { $exists: false } }, { proposalNumber: null }, { proposalNumber: "" }] },
      { $set: { proposalNumber: proposal.proposalNumber } }
    );
    return true;
  });
}

/**
 * A proposal's NEW Reference Date (the owner, 2026-11-14: Modify on a resume moves it to the day it was modified) kept on the
 * policy - ONLY the date, never the steps (a "proposal completed" write would put a done KYC back to pending): the part's
 * Proposal step and onlinePolicy.unitedIndiaProposal, each only while it is still THIS proposal number. Never throws.
 * @returns {Promise<boolean>} a write matched
 */
async function saveReferenceDate(data, { proposalNumber, referenceDate }, { MongoClient = null, now = () => new Date() } = {}) {
  try {
    const stages = require("../../../fullPolicycompany/reliance/relianceStages");
    const core = require("../../../lib/relianceStagesCore");
    const policyId = stages.policyIdOf(data);
    const number = String(proposalNumber || "").trim();
    const date = String(referenceDate || "").trim();
    if (!policyId || !/^\d{8,25}$/.test(number) || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return false;
    const step = `relianceStages.${core.stageKeyOf(data && data._partKey)}.proposal`;
    const at = now();
    return await stages.withPolicies(MongoClient, async (onlinePolicy) => {
      const a = await onlinePolicy.updateOne({ _id: policyId, [`${step}.proposalNumber`]: number }, { $set: { [`${step}.referenceDate`]: date, updatedAt: at } });
      const b = await onlinePolicy.updateOne({ _id: policyId, "unitedIndiaProposal.proposalNumber": number }, { $set: { "unitedIndiaProposal.referenceDate": date } });
      return !!((a && a.matchedCount) || (b && b.matchedCount));
    });
  } catch (e) {
    return false;
  }
}

/**
 * The proposal as the page shows it AFTER Modify, kept fresh on the policy (the owner, 2026-11-14: "get the fresh proposal number
 * and date from there"): its number, Reference Date, Transaction NO and Customer ID on the part's Proposal step and on
 * onlinePolicy.unitedIndiaProposal; a NEW number keeps the old one as previousProposalNumber and takes the list's Proposal
 * Number column when that held the old one. Only these fields - never a step's status (a "proposal completed" write would put
 * a done KYC back to pending). Never throws.
 * @param {{ was: string, fresh: { proposalNumber, referenceDate, transactionNo?, customerId? } }} p
 * @returns {Promise<boolean>} the step was this proposal's and got written
 */
async function saveFreshProposal(data, { was, fresh = {} }, { MongoClient = null, now = () => new Date() } = {}) {
  try {
    const stages = require("../../../fullPolicycompany/reliance/relianceStages");
    const core = require("../../../lib/relianceStagesCore");
    const policyId = stages.policyIdOf(data);
    const number = proposalNumberOf(fresh.proposalNumber);
    const old = proposalNumberOf(was);
    const date = String(fresh.referenceDate || "").trim();
    if (!policyId || !number || !old || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) return false;
    const fields = {
      proposalNumber: number,
      referenceDate: date,
      ...(String(fresh.transactionNo || "").trim() ? { transactionNo: String(fresh.transactionNo).trim() } : {}),
      ...(String(fresh.customerId || "").trim() ? { customerId: String(fresh.customerId).trim() } : {}),
    };
    const step = `relianceStages.${core.stageKeyOf(data && data._partKey)}.proposal`;
    const stepSet = Object.fromEntries(Object.entries(fields).map(([k, v]) => [`${step}.${k}`, v]));
    if (old !== number) stepSet[`${step}.previousProposalNumber`] = old;
    const at = now();
    return await stages.withPolicies(MongoClient, async (onlinePolicy) => {
      const a = await onlinePolicy.updateOne({ _id: policyId, [`${step}.proposalNumber`]: old }, { $set: { ...stepSet, updatedAt: at } });
      if (!(a && a.matchedCount)) return false; // the step is no longer this proposal's - nothing written
      await onlinePolicy.updateOne({ _id: policyId }, { $set: { unitedIndiaProposal: { ...fields, at, afterModify: true } } });
      if (old !== number) await onlinePolicy.updateOne({ _id: policyId, proposalNumber: old }, { $set: { proposalNumber: number } });
      return true;
    });
  } catch (e) {
    return false;
  }
}

module.exports = { updateAndSaveProposal, saveReferenceDate, saveFreshProposal, readProposalInPage, proposalNumberOf, defaultSaveProposal, UPDATE, INSURER, UPDATE_WAIT_MS };
