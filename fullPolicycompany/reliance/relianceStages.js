/**
 * Reliance in three stages — what the form (relianceForm.js and its generated OD / TP copy) calls.
 *
 *   1. proposal  login, fill, Save, the proposal ("referral") number saved      -> skipped when an earlier run finished it
 *   2. kyc       View Policy, search the number, DO KYC, KYC accepted           -> skipped when an earlier run finished it
 *   3. payment   Pending Quotes, Pay, link sent / wallet (CDT) payment issued   -> only after the KYC is finished
 *
 * The rules (order, cascade, where a run starts) are in ../lib/relianceStagesCore.js, shared with the backend; this file
 * only reads / writes the policy with the raw Mongo driver (like saveProposalNumber and saveKycStatus) and words the
 * operator sentences (no colon in them — beautifyError keeps only the text after the last colon).
 *
 * No .env switch (the owner, 2026-10-19). A policy without relianceStages (every older one) is not skipped anywhere, so
 * it runs from the start as before.
 *
 * Every database helper here NEVER throws: a bookkeeping write must not fail a run that did real work at Reliance.
 */
const core = require("../../lib/relianceStagesCore");
const { liveHoldStopOf } = require("../../lib/holdStop");
const { PortalRejectedError, plain, saveKycStatus, kycGenericReasonText } = require("./relianceKycSubmit");

/** The part these stages belong to — the part runner sets data._partKey ("motor" / "od" / "tp"); none = "motor". */
function stageKeyFor(data) {
  return core.stageKeyOf(data && data._partKey);
}

/** The policy id as stored (an ObjectId); a 24-hex string from the job data is turned into one, or nothing matches. */
function policyIdOf(data) {
  const id = (data && (data._id || data.policyId)) || null;
  if (typeof id === "string" && /^[0-9a-f]{24}$/i.test(id)) {
    try {
      const { ObjectId } = require("mongodb");
      return new ObjectId(id);
    } catch (e) {
      return id;
    }
  }
  return id;
}

async function withPolicies(MongoClient, work) {
  const Client = MongoClient || require("mongodb").MongoClient;
  const client = new Client(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    return await work(client.db().collection("onlinePolicy"));
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Where this run starts. Reads the policy's relianceStages (the job data does not carry them).
 * A read that fails starts from the proposal — the behaviour from before the stages existed.
 *
 * @returns {Promise<{skipProposal:boolean, skipKyc:boolean, proposalNumber:string|null, startAt:string, key:string}>}
 */
async function loadResumePlan(data, { jobId = "", MongoClient, insurer = "Reliance" } = {}) {
  const key = stageKeyFor(data);
  const fromStart = { ...core.planResume(null), key };
  const policyId = policyIdOf(data);
  if (!policyId) return fromStart;
  try {
    const policy = await withPolicies(MongoClient, (onlinePolicy) =>
      onlinePolicy.findOne({ _id: policyId }, { projection: { relianceStages: 1 } })
    );
    return { ...core.planResume(core.stagesFor(policy, key)), key };
  } catch (error) {
    console.warn(`[${jobId}] ⚠️ Could not read the ${insurer} stages (${error && error.message}) — starting from the proposal.`);
    return fromStart;
  }
}

/**
 * Record a stage on the policy (with the cascade of relianceStagesCore.stageSet). Never throws; true when a policy matched.
 *
 * @param {Object} data    the job data (policy id, _partKey)
 * @param {string} stage   "proposal" | "kyc" | "payment"
 * @param {string} status  "pending" | "completed" | "failed"
 * @param {Object} [extra] proposalNumber, mode, error ...
 */
async function markStage(data, stage, status, extra = {}, { jobId = "", MongoClient, now = new Date(), insurer = "Reliance" } = {}) {
  // A step cut short by Hold (lib/holdStop.js armLiveHold) did not fail: its "failed" is not written, Release redoes it.
  if (status === "failed" && liveHoldStopOf(data)) return false;
  const policyId = policyIdOf(data);
  if (!policyId) {
    console.warn(`[${jobId}] ⚠️ No policy id on the job — ${insurer} stage ${stage} = ${status} not saved.`);
    return false;
  }
  try {
    const key = stageKeyFor(data);
    const set = core.stageSet(key, stage, status, extra, now);
    const result = await withPolicies(MongoClient, (onlinePolicy) =>
      onlinePolicy.updateOne({ _id: policyId }, { $set: { ...set, updatedAt: now } })
    );
    console.log(`[${jobId}] 📌 ${insurer} stage ${core.STAGE_LABEL[stage]} = ${status} (${key}, matched ${result.matchedCount})`);
    return result.matchedCount > 0;
  } catch (error) {
    console.warn(`[${jobId}] ⚠️ Could not save ${insurer} stage ${stage} = ${status}: ${error && error.message}`);
    return false;
  }
}

/** A stop that belongs to a stage — its message is the operator's sentence as written (passes the nested catches). */
class RelianceStageError extends PortalRejectedError {
  constructor(message, { stage = "kyc" } = {}) {
    super(message, { stage: `stage-${stage}` });
    this.name = "RelianceStageError";
    this.keepMessage = true;
    this.relianceStage = stage;
  }
}

const proposalWords = (n) => (n ? `proposal ${plain(n)}` : "the proposal");

/** A reason in brackets, colon-free and short (Selenium messages can run for lines). */
const reasonOf = (why) => {
  const text = plain(why);
  return text ? ` (${text.length > 200 ? `${text.slice(0, 197)}...` : text})` : "";
};

/** Stage 3 asked for while stage 2 is not finished. */
function kycNotDoneMessage(proposalNumber, why = "") {
  const reason = reasonOf(why);
  return (
    `KYC is not finished for ${proposalWords(proposalNumber)}${reason}, so the payment was not started. ` +
    "Finish the KYC first - Re-submit runs the KYC again with the same proposal."
  );
}

/** KYC accepted, but Reliance's PROCEED never showed — the KYC is kept as done, the payment did not start. */
function proceedMissingMessage(proposalNumber) {
  return (
    `The KYC of ${proposalWords(proposalNumber)} was accepted but Reliance's PROCEED button did not appear, so the ` +
    "payment was not started. The KYC is saved as done - Re-submit and the run goes straight to the payment."
  );
}

/** A resumed run (stage 1 done earlier) whose proposal shows no DO KYC link in View Policy. */
function resumeNoKycLinkMessage(proposalNumber) {
  return (
    `${proposalWords(proposalNumber).replace(/^p/, "P")} saved by an earlier run has no DO KYC link in Reliance's View ` +
    "Policy. Check it on the portal, or set stage 1 Proposal back to Pending in History to make a new proposal."
  );
}

/** Stage 3 ran and the payment did not happen (no link sent / nothing issued). */
function paymentNotDoneMessage(proposalNumber, { link = false, why = "" } = {}) {
  const what = link ? "the payment link was not sent" : "the wallet payment was not made";
  const reason = reasonOf(why);
  return (
    `For ${proposalWords(proposalNumber)} ${what}${reason}. The proposal and its KYC are kept - Re-submit and the ` +
    "run goes straight to the payment."
  );
}

/** What a failed KYC says after the reason itself. */
function kycKeptSentence(proposalNumber) {
  return (
    `${proposalWords(proposalNumber).replace(/^p/, "P")} stays saved at Reliance and only the KYC is left - Pending ` +
    "Quotes and Pay were not opened, nothing was paid or sent. Re-submit runs the KYC again with the same proposal " +
    "(editing the policy makes a new proposal)."
  );
}

/**
 * Stage 2 failed: stop right here on the KYC page (the owner's rule, 2026-10-19) — the screenshot of the error, the KYC
 * note for the View page, stage 2 = failed. No Pending Quotes, no Pay, no links (relianceKycFallback's rescue is not
 * used any more). Never throws.
 *
 * @returns {Promise<{message:string, screenshotUrl:string|null, screenshotKey:string|null}>}
 */
async function stopAtKycFailure({
  data = {},
  jobId = "",
  error,
  proposalNumber = "",
  shots = null,
  log = console.log,
  deps = {},
} = {}) {
  const saveStatus = deps.saveStatus || saveKycStatus;
  const mark = deps.markStage || markStage;
  const number = String(proposalNumber || (data && (data.proposalNumber || data.proposal_number)) || "").trim();

  let failure;
  if (error && error.portalRejected) failure = String(error.message || "").trim();
  else {
    const text = plain(String((error && (error.reason || error.message)) || "").replace(/^\[E\d+\]\s*/, ""));
    failure = text ? `The KYC could not be completed - ${text}.` : "The KYC could not be completed.";
  }

  let shot = { url: null, key: null };
  if (shots) {
    try {
      await shots.capturePage();
      shot = (await shots.flush()) || shot;
    } catch (e) {
      log(`⚠️ KYC screenshot step failed (${e && e.message})`);
    }
  }

  if (!(error && error.portalRejected)) {
    // a portal refusal already wrote its own, more exact, note
    try {
      await saveStatus(kycGenericReasonText(error && (error.reason || error.message)), data, jobId);
    } catch (e) {
      log(`[${jobId}] ⚠️ Could not save the KYC note (${e && e.message})`);
    }
  }

  const message = `${failure} ${kycKeptSentence(number)}`.replace(/\s+/g, " ").trim();
  await mark(data, "kyc", "failed", { error: message }, { jobId });
  return { message, screenshotUrl: shot.url || null, screenshotKey: shot.key || null };
}

module.exports = {
  stageKeyFor,
  policyIdOf,
  withPolicies,
  loadResumePlan,
  markStage,
  RelianceStageError,
  kycNotDoneMessage,
  proceedMissingMessage,
  resumeNoKycLinkMessage,
  paymentNotDoneMessage,
  kycKeptSentence,
  stopAtKycFailure,
};
