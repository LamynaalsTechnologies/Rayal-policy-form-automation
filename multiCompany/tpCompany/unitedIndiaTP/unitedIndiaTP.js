/**
 * United India TP (2026-11-06). United India sells third party only (the Online Policy offers it on TP only and as the
 * TP side of a Combined Make & Model), so this is its only handler: there is no full-company or OD flow.
 *
 * What it does today, then it stops:
 *   1. runHandler (../../common/runHandler.js): the feature gate, a fresh browser (./unitedIndiaSession.js), the recording,
 *      the live Hold, the LOGIN (../../common/login/unitedIndiaLogin.js on the shared loop), a failure screenshot, clean-up.
 *   2. the sidebar's Policy Transaction > Make New/Renew Policy (./unitedIndiaMenu.js), every click checked and tried once
 *      more if it did not take (./unitedIndiaSteps.js - the owner's rule for every click and field of this flow).
 *   3. the Products page (./unitedIndiaProduct.js): Office and LOB left as the portal filled them, Select Product =
 *      "Liability Only Policy", Submit.
 *   4. Risk Details (./unitedIndiaRisk.js): Vehicle Class "Motorcycle / Scooter", Vehicle Registration State = the customer's
 *      state on the policy, New Vehicle ticked, Chassis and Engine Number from the policy, Vehicle Manufacturer = the
 *      Make & Model row's Make, the portal's Make = its Model (exact names; the owner's correction, 2026-11-06). The two
 *      lists are kept by hand on the Vehicle Model page; a run only reads and picks.
 *   5. the dates of the new vehicle (./unitedIndiaDates.js, the owner 2026-11-13): Date of Purchase = today (DD/MM/YYYY,
 *      India time; a readonly calendar box, so the date is put in and the page's own after-pick check runs), Month of
 *      Manufacture = this month, Year of Manufacture = this year.
 *   6. two Yes / No questions (./unitedIndiaQuestions.js, the owner 2026-11-13, by default): Valid PUC = "Yes", plying in
 *      Delhi - NCR = "No" (both boxes have id="repository", so they are found by name).
 *   7. the insured's details (./unitedIndiaInsured.js, the owner 2026-11-13): Client Type Individual (the portal's default,
 *      not touched; clientTypeFor() is where Corporate goes later), High Risk "No", Title from the policy, Insured Name =
 *      the Full Name, Address = the address boxes in one line with no special characters.
 *   8. the Pin Code (./unitedIndiaPinCode.js, the owner 2026-11-13): typed, the box left so the portal fills the State and
 *      District; no District after a second try = the pin code is wrong (a stop with its screenshot, not retried).
 *   9. Mobile, Email (its validateEmail on leaving) and Date of Birth DD/MM/YYYY (./unitedIndiaContact.js), then the RTO by
 *      its code - TN55 / TN-55 / TN 55 (./unitedIndiaRto.js); an RTO not in the list stops with the nearest ones named.
 *  10. "More Covers N Info" (./unitedIndiaMoreCovers.js): the portal submits Risk Details and opens its next page (20 s, else
 *      an error); there the TPPD Limit = Upto 6000 when the policy's TPPD Restrict is ticked, else Upto 100000.
 *  11. PA Cover (./unitedIndiaPaCover.js): bought with United India -> ticked, CPA Cover 1 / 5 Year, Nominee Name and Relation;
 *      otherwise (no PA, Brisk's) -> ticked and unticked, Owner-Driver CPA "No".
 *  12. Back to Risk Details (20 s), scrolled to its end, Compute Premium (./unitedIndiaCompute.js): the GSTIN/UIN question
 *      answered OK, the portal's loader waited for - at most 40 s, longer = a loader-issue error.
 *  13. Generate Quote and Worksheet (./unitedIndiaQuote.js): the quote PDF and the worksheet taken (a download, a PDF window, or
 *      a page printed to PDF), uploaded and kept on the policy (quotePdf / worksheetPdf, the View page's Files) - where the
 *      button IS: before Update, else after it (the owner's live runs never showed it right after Compute Premium).
 *  14. Update (./unitedIndiaProposal.js): the GSTIN/UIN question OK, the loader (40 s), then the PROPOSAL read off the page -
 *      its number, Reference Date, Transaction NO, Customer ID - and saved: the part's Proposal step = completed (History /
 *      Edit -> Status), onlinePolicy.unitedIndiaProposal, and proposalNumber when the policy has none yet.
 *  15. Breaker.checkpoint("stopthis-location") - the owner's own stop point (his .env: BREAKER_ENABLED=true,
 *      BREAKER_STOP_AT=stopthis-location) - and, when the Breaker lets it pass, a plain stop: the TP form is not built yet.
 * Either way the run is "stopped on purpose": the product choice and (since 2026-11-13) the Risk Details for the More Covers
 * page were sent - no proposal number is known, nothing is paid - and it is not retried. Every failure AND every stop saves a screenshot of the page on the policy's Issues (screenshotOnStop below,
 * the owner 2026-11-13; a Hold does not), and with
 * KEEP_BROWSER_OPEN_ON_ERROR=true the window stays open on the Risk Details page for the next steps to be written
 * (closing it by hand removes its profile - lib/retainedBrowser.js).
 *
 * The next step (the owner gives the portal's TP steps) goes after step 14, before the checkpoint.
 *
 * A proposal ALREADY MADE (the part's Proposal step completed with its number and Reference Date - an earlier run, or Edit ->
 * Status) is never made again (the owner, 2026-11-13): after the login, Policy Transaction > Proposal Modification, the
 * Reference Date in From and To, Fetch, OUR proposal's row, Next - the proposal page opens (./unitedIndiaProposalModification.js).
 * There (the owner, the same day: "these changes must be done on a resume"): the Policy Start Date = today (the proposal's old
 * day is refused - "N002219, PolicyInception Date should be on or later to Proposal Date"), High Risk "No" again, More Covers N Info, the TPPD
 * Limit checked and the PA Cover set again, Back, Compute Premium (the same steps and rules as a new proposal), then the KYC
 * (./unitedIndiaKyc.js, the owner the same day): Modify, Update Ckyc -> its new window, Offline KYC, Aadhaar card + its number,
 * Verified, Same as above, Save. A NEW proposal takes the same KYC after Update when the Update Ckyc button is on its page.
 * Then the checkpoint and a stop: what comes after Save is the owner's next step. A completed proposal without its Reference
 * Date stops at once ([E306], not retried): the date goes in Edit -> Status first.

 */
const { runHandler } = require("../../common/runHandler");
const { openMakeNewRenewPolicy } = require("./unitedIndiaMenu");
const { chooseProduct: chooseLiabilityOnly } = require("./unitedIndiaProduct");
const { fillRiskDetails } = require("./unitedIndiaRisk");
const { fillPurchaseAndManufacture } = require("./unitedIndiaDates");
const { answerPucAndDelhiNcr } = require("./unitedIndiaQuestions");
const { fillInsuredDetails } = require("./unitedIndiaInsured");
const { fillPinCode } = require("./unitedIndiaPinCode");
const { fillContactDetails } = require("./unitedIndiaContact");
const { chooseRto: chooseRtoByCode } = require("./unitedIndiaRto");
const { openMoreCovers, setTppdLimit } = require("./unitedIndiaMoreCovers");
const { fillPaCover } = require("./unitedIndiaPaCover");
const { backAndComputePremium } = require("./unitedIndiaCompute");
const { quoteAndWorksheet } = require("./unitedIndiaQuote");
const { updateAndSaveProposal, saveReferenceDate, saveFreshProposal, proposalNumberOf } = require("./unitedIndiaProposal");
const { openProposalModification } = require("./unitedIndiaMenu");
const { openSavedProposal } = require("./unitedIndiaProposalModification");
const { setHighRiskNo } = require("./unitedIndiaInsured");
const { setPolicyStartToday } = require("./unitedIndiaDates");
const { unitedIndiaKyc } = require("./unitedIndiaKyc");
const { MultiCompanyError } = require("../../common/errors");
const { portalDataError } = require("./unitedIndiaNavigate");

const COMPANY = "united india";
const INSURER = "United India";
/** Where the run stops when the proposal was made before (the KYC is the owner's next step). */
/** The part's saved steps: where this run starts (lib/relianceStagesCore.js planResume, read from the policy). */
const loadStagesPlan = (data, o = {}) => require("../../../fullPolicycompany/reliance/relianceStages").loadResumePlan(data, { ...o, insurer: INSURER });
const NOT_BUILT =
  "United India - Liability Only Policy submitted, Vehicle Class, Registration State, New Vehicle, Chassis, Engine Number, Vehicle Manufacturer, Make, Date of Purchase, Month and Year of Manufacture, Valid PUC (Yes), Delhi - NCR (No), Client Type, High Risk (No), Title, Insured Name, Address, Pin Code (State and District filled), Mobile, Email, Date of Birth and RTO entered, More Covers N Info opened, TPPD Limit and PA Cover set, back on Risk Details and Compute Premium done, Quote PDF and Worksheet kept, Update pressed and the proposal saved, the KYC is not built yet";
/** The KYC part of a stop: the steps up to Save (./unitedIndiaKyc.js); what follows is the owner's next step. */
const KYC_DONE = "the CKYC window opened, Offline KYC with the Aadhaar card (Verified, Same as above) entered and Save pressed; what comes after Save is not built yet";
const RESUME_BASE = "United India - the proposal was made before, so it was opened from Proposal Modification (not made again), Policy Start Date today, High Risk (No), More Covers N Info, TPPD Limit and PA Cover set again, Compute Premium and Modify done";
const RESUME_NOT_BUILT = `${RESUME_BASE}, ${KYC_DONE}`;
/** The KYC part of a stop, from what ./unitedIndiaKyc.js found: already done (Offline KYC disabled), done by Save, or Save only. */
const kycWords = (k) => {
  const step = k.stepSaved ? "KYC step = completed" : "the KYC step could NOT be saved (set it to Completed in Edit -> Status)";
  const result = k.result ? `, "${String(k.result).replace(/:/g, " -")}"` : "";
  const closed = k.closed ? `, the CKYC window closed${k.closed === "run" ? " (by the run - its Close did not)" : ""}` : "";
  if (k.alreadyDone) return `the CKYC window opened - the KYC was already done at United India (Offline KYC disabled${result}), ${step}${closed}; what comes after the KYC is not built yet`;
  if (k.kycDone) {
    const why = k.doneBy === "saved" ? `United India says "${String(k.result).replace(/:/g, " -")}"` : `Offline KYC disabled${result}`;
    return `the CKYC window opened, Offline KYC with the Aadhaar card (Verified, Same as above) entered and Save pressed - the KYC is done (${why}), ${step}${closed}; what comes after the KYC is not built yet`;
  }
  return KYC_DONE;
};
/** A new proposal whose page had the Update Ckyc button: the KYC done after Update. */
const NEW_BASE = NOT_BUILT.replace(/, the KYC is not built yet$/, "");
const NEW_WITH_KYC = `${NEW_BASE}, ${KYC_DONE}`;
/** What United India said after Save, for the stop's sentence. */
const saidAfterSave = (kyc) => (kyc && kyc.said && kyc.said.length ? ` - United India said "${kyc.said.join('" / "').replace(/:/g, " -")}"` : "");


/**
 * @param {Object} data the job payload (username / password / loginUrl resolved by lib/partRunner.js, plus the policy's
 *   form data with the TP part's vehicle)
 * @param {{ loadPlan?: Function, openModification?: Function, openSaved?: Function, saveDate?: Function, saveFresh?: Function, setStartDate?: Function, setHighRisk?: Function, kyc?: Function, openMenu?: Function, chooseProduct?: Function, fillRisk?: Function, fillDates?: Function, answerQuestions?: Function, fillInsured?: Function, fillPin?: Function, fillContact?: Function, chooseRto?: Function, openMore?: Function, fillTppd?: Function, fillPa?: Function, compute?: Function, quote?: Function, proposal?: Function }} [deps] tests replace the steps
 */
function fillUnitedIndiaTP(
  data = {},
  {
    loadPlan = loadStagesPlan,
    openModification = openProposalModification,
    openSaved = openSavedProposal,
    setStartDate = setPolicyStartToday,
    setHighRisk = setHighRiskNo,
    kyc = unitedIndiaKyc,
    saveDate = saveReferenceDate,
    saveFresh = saveFreshProposal,
    openMenu = openMakeNewRenewPolicy,
    chooseProduct = chooseLiabilityOnly,
    fillRisk = fillRiskDetails,
    fillDates = fillPurchaseAndManufacture,
    answerQuestions = answerPucAndDelhiNcr,
    fillInsured = fillInsuredDetails,
    fillPin = fillPinCode,
    fillContact = fillContactDetails,
    chooseRto = chooseRtoByCode,
    openMore = openMoreCovers,
    fillTppd = setTppdLimit,
    fillPa = fillPaCover,
    compute = backAndComputePremium,
    quote = quoteAndWorksheet,
    proposal = updateAndSaveProposal,
  } = {}
) {
  return runHandler({
    company: COMPANY,
    policyType: "tp",
    data,
    // every error AND every stop leaves a screenshot of the page (the owner, 2026-11-13); a Hold does not
    screenshotOnStop: true,
    body: async (ctx) => {
      ctx.log(`✅ [${ctx.jobId}] United India - logged in`);
      // a proposal made before is opened again, never made a second time (the owner, 2026-11-13)
      // United India's "Error In Data Entry" box the FIRST time = the steps once more (the portal sometimes shows a wrong one -
      // "(0)null", the owner's live run 2026-11-14); the SECOND time = the error. Only steps that save nothing at United India.
      const onceMore = async (what, steps) => {
        try {
          return await steps(false);
        } catch (e) {
          if (!(e && e.portalError)) throw e;
          ctx.log(
            `⚠️ United India - after "${e.portalLabel}" the portal said "Error In Data Entry - ${e.portalLines.join(" / ")}" - it sometimes shows a wrong error, so ${what} once more`
          );
          try {
            return await steps(true);
          } catch (e2) {
            if (e2 && e2.portalError) throw portalDataError(e2.portalLabel, e2.portalLines, e2.portalStage, { again: true });
            throw e2;
          }
        }
      };
      const plan = (await loadPlan(ctx.data, { jobId: ctx.jobId })) || {};
      if (plan.skipProposal && plan.proposalNumber) {
        if (!plan.referenceDate) {
          throw new MultiCompanyError(
            "E306",
            `United India - proposal ${plan.proposalNumber} is saved without its Reference Date, so it cannot be found in Proposal Modification and the run stopped there. Add the Reference Date in Edit -> Status, then run the policy again.`,
            { company: COMPANY, stage: "united-india-proposal-modification", retryable: false }
          );
        }
        ctx.log(`📌 United India - proposal ${plan.proposalNumber} of ${plan.referenceDate} was made before - opening it from Proposal Modification (not making a new one)`);
        let pmUrl = null; // Proposal Modification's address, for opening it again straight away
        // the proposal's Reference Date as United India has it NOW (the list, then the page after Modify) kept on the policy -
        // the next search starts from it (the owner, 2026-11-14)
        let knownDate = plan.referenceDate;
        const keepDate = async (date, where) => {
          const d = String(date || "").trim();
          if (!/^\d{2}\/\d{2}\/\d{4}$/.test(d) || d === knownDate) return;
          const saved = await Promise.resolve(saveDate(ctx.data, { proposalNumber: plan.proposalNumber, referenceDate: d })).catch(() => false);
          ctx.log(
            saved
              ? `📅 United India - proposal ${plan.proposalNumber}'s Reference Date is now ${d} (${where}; it was ${knownDate}) - saved on the policy`
              : `⚠️ United India - proposal ${plan.proposalNumber}'s Reference Date is now ${d} (${where}; it was ${knownDate}) - it could not be saved on the policy, correct it in Edit -> Status`
          );
          knownDate = d;
        };
        // opened and filled again up to Compute Premium (nothing is saved at United India before Modify) - once more on a first
        // "Error In Data Entry"
        await onceMore("the proposal is opened from Proposal Modification and filled", async (again) => {
          const opened = (await openModification(ctx.driver, { log: ctx.log, ...(again && pmUrl ? { directUrl: pmUrl } : {}) })) || {};
          if (opened.url) pmUrl = opened.url;
          const found = (await openSaved(ctx.driver, { proposalNumber: plan.proposalNumber, referenceDate: plan.referenceDate }, { log: ctx.log })) || {};
          await keepDate(found.row && found.row.date, "the Proposal Modification list");
          // the owner's changes on a resumed proposal, in his order: the Policy Start Date today, High Risk No, More Covers (TPPD
          // checked, PA Cover), Back, Compute
          await setStartDate(ctx.driver, { log: ctx.log });
          await setHighRisk(ctx.driver, { log: ctx.log });
          await openMore(ctx.driver, { log: ctx.log });
          await fillTppd(ctx.driver, ctx.data, { log: ctx.log });
          await fillPa(ctx.driver, ctx.data, { log: ctx.log });
          await compute(ctx.driver, { log: ctx.log });
        });
        // the KYC (the owner, 2026-11-13): Modify, Update Ckyc -> its window, Offline KYC with the Aadhaar card, Save
        // after Modify: the proposal FRESH from the page - its number and Reference Date (+ Transaction NO, Customer ID) - kept
        // on the policy (the owner, 2026-11-14); a page that shows none keeps the saved proposal
        let current = plan.proposalNumber;
        const onModified = async (shown) => {
          const number = proposalNumberOf(shown && shown.proposalNumber);
          const date = String((shown && shown.referenceDate) || "").trim();
          if (!number || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
            ctx.log(`   United India - the page after Modify shows no proposal number and Reference Date - proposal ${current} of ${knownDate} is kept`);
            return;
          }
          const fresh = { proposalNumber: number, referenceDate: date, transactionNo: shown.transactionNo, customerId: shown.customerId };
          const saved = await Promise.resolve(saveFresh(ctx.data, { was: current, fresh })).catch(() => false);
          const what = `proposal ${number} of ${date}${number !== current ? ` (a NEW number - it was ${current})` : ""}`;
          ctx.log(
            saved
              ? `📄 United India - after Modify the page shows ${what} - saved on the policy`
              : `⚠️ United India - after Modify the page shows ${what} - it could not be saved on the policy, correct it in Edit -> Status`
          );
          current = number;
          knownDate = date;
        };
        const done = (await kyc(ctx.driver, ctx.data, { modify: true }, { log: ctx.log, jobId: ctx.jobId, onModified })) || {};
        Breaker.checkpoint("stopthis-location");
        ctx.stop(`${RESUME_BASE}, ${kycWords(done)} - proposal ${current} of ${knownDate}${saidAfterSave(done)}`, { stage: "united-india-kyc" });
        return;
      }
      // the form from the start up to Compute Premium (no proposal yet - nothing saved at United India) - once more on a first
      // "Error In Data Entry"
      let newUrl = null;
      await onceMore("the form is filled from the start", async (again) => {
        const opened = (await openMenu(ctx.driver, { log: ctx.log, ...(again && newUrl ? { directUrl: newUrl } : {}) })) || {};
        if (opened.url) newUrl = opened.url;
        await chooseProduct(ctx.driver, { log: ctx.log });
        await fillRisk(ctx.driver, ctx.data, { log: ctx.log });
        await fillDates(ctx.driver, { log: ctx.log });
        await answerQuestions(ctx.driver, { log: ctx.log });
        await fillInsured(ctx.driver, ctx.data, { log: ctx.log });
        await fillPin(ctx.driver, ctx.data, { log: ctx.log });
        await fillContact(ctx.driver, ctx.data, { log: ctx.log });
        await chooseRto(ctx.driver, ctx.data, { log: ctx.log });
        await openMore(ctx.driver, { log: ctx.log });
        await fillTppd(ctx.driver, ctx.data, { log: ctx.log });
        await fillPa(ctx.driver, ctx.data, { log: ctx.log });
        await compute(ctx.driver, { log: ctx.log });
      });
      // the Quote PDF and Worksheet where their button IS (the owner's live runs: none right after Compute Premium) - before
      // Update when it shows there, else after Update; neither = said, not an error
      const files = { log: ctx.log, downloadDir: ctx.downloadDir, jobId: ctx.jobId, ifShown: true };
      let kept = await quote(ctx.driver, ctx.data, { ...files, where: "after Compute Premium" });
      const made = (await proposal(ctx.driver, ctx.data, { log: ctx.log, jobId: ctx.jobId })) || {};
      if (!kept) kept = await quote(ctx.driver, ctx.data, { ...files, where: "after Update" });
      if (!kept) ctx.log("⚠️ United India - Generate Quote was not on the page before or after Update - the Quote PDF and Worksheet were not kept");
      // the KYC straight after the proposal when the page offers it (the Update Ckyc button); none = the stop as before
      const done = await kyc(ctx.driver, ctx.data, { modify: false, ifShown: true }, { log: ctx.log, jobId: ctx.jobId });
      // The owner's stop point (BREAKER_ENABLED=true + BREAKER_STOP_AT=stopthis-location), now after the KYC's Save.
      // It throws the stop itself; runHandler turns it into "stopped on purpose".
      Breaker.checkpoint("stopthis-location");
      const which = made.proposalNumber ? ` - proposal ${made.proposalNumber}${made.referenceDate ? ` of ${made.referenceDate}` : ""}` : "";
      if (done) ctx.stop(`${NEW_BASE}, ${kycWords(done)}${which}${saidAfterSave(done)}`, { stage: "united-india-kyc" });
      ctx.stop(`${NOT_BUILT}${which} (no Update Ckyc button on the page after Update)`, { stage: "risk-details" });
    },
  });
}

module.exports = { fillUnitedIndiaTP, NOT_BUILT, RESUME_NOT_BUILT, RESUME_BASE, NEW_WITH_KYC, KYC_DONE, kycWords };
