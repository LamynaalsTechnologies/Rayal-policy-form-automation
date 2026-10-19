/**
 * Reliance and KSHEMA in three stages — the pure rules (no database, no browser). The names say "reliance" because
 * Reliance came first; a part key belongs to one insurer, so relianceStages.<part> holds KSHEMA parts too.
 *
 * THIS FILE EXISTS TWICE and the two copies must stay byte-identical:
 *   RayalBrokers-backend/shared/relianceStagesCore.js
 *   Rayal-policy-form-automation/lib/relianceStagesCore.js
 * (the same arrangement as jobPartsCore.js). It has no requires, so it can be copied as is.
 *
 * A Reliance run is three stages, each remembered on the policy so a later run does not do it again:
 *   1. proposal  login, fill the form, Save, the proposal ("referral") number R123... saved
 *   2. kyc       View Policy, search that number, DO KYC, the KYC accepted
 *   3. payment   Pending Quotes, Pay, then the payment link sent or the wallet (CDT) payment issued
 *
 * Stored on the onlinePolicy document, per job part ("motor" = the bundled OD + TP part, "od" / "tp" = portal parts):
 *   relianceStages.motor = {
 *     proposal: { status, at, proposalNumber },        KSHEMA: { status, at, link } (its proposal page address)
 *     kyc:      { status, at, error },
 *     payment:  { status, at, mode: "link" | "wallet", error },
 *   }
 * status is "pending" | "completed" | "failed"; a stage that is missing is pending. A policy with no relianceStages at
 * all (every policy from before 2026-10-19) is all pending, so it runs from the start exactly as before.
 *
 * Cascade — ONLY from the proposal (the owner, 2026-10-19): a new proposal (done afresh, or set back to pending) means a
 * new referral number, so KYC and payment go back to pending with it. KYC or payment set back to pending is just that
 * one step: on a policy whose payment is done, a redone KYC does not pay again (planResume skipPayment).
 * A stage is set to completed by the automation finishing it, or by an operator through Edit -> Status (2026-10-19,
 * whyNotSetByHand / manualSet: a proposal needs its referral number or page, a wallet payment never).
 */

const STAGES = ["proposal", "kyc", "payment"];
const STAGE_LABEL = { proposal: "Proposal", kyc: "KYC", payment: "Payment" };
const STAGE_STATUSES = ["pending", "completed", "failed"];

/** Wallet payment notes (relianceWalletIssue.js) that mean money was, or may have been, paid at Reliance. */
const WALLET_MONEY_STATES = ["submit-pressed", "issued", "unconfirmed"];

/** "motor" / "od" / "tp" from a job part key; anything empty is the bundled "motor" part. */
function stageKeyOf(partKey) {
  const key = String(partKey == null ? "" : partKey)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return key || "motor";
}

/** The wallet payment note field of a part — walletPayment for the bundled part, walletPayment_od / _tp otherwise. */
function walletNoteField(key) {
  const k = stageKeyOf(key);
  return k === "motor" ? "walletPayment" : `walletPayment_${k}`;
}

function normStatus(status) {
  const s = String(status == null ? "" : status).trim().toLowerCase();
  return STAGE_STATUSES.includes(s) ? s : "pending";
}

/** One part's three stages, always all three, each with a known status. */
function stagesFor(policy, key) {
  const all = (policy && policy.relianceStages) || {};
  const own = all[stageKeyOf(key)] || {};
  const out = {};
  for (const stage of STAGES) {
    const raw = own[stage] && typeof own[stage] === "object" ? own[stage] : {};
    out[stage] = { ...raw, status: normStatus(raw.status) };
  }
  return out;
}

function laterStages(stage) {
  const i = STAGES.indexOf(stage);
  return i < 0 ? [] : STAGES.slice(i + 1);
}

/** The stages that go back to pending WITH this one: only a proposal takes the others along. */
function cascadesFrom(stage) {
  return stage === "proposal" ? laterStages(stage) : [];
}

function plainNumber(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Where a run starts, and where it ends. The proposal is skipped only when stage 1 is completed AND it carries its
 * number (Reliance) or its saved proposal page link (KSHEMA, which shows no number); the KYC is skipped only when the
 * proposal is skipped too and stage 2 is completed.
 * skipPayment: ONLY the KYC is redone — the proposal is kept, the KYC is not completed and the payment IS completed
 * (KYC set back to pending on a finished policy): the run ends after the KYC, nothing is paid or sent again.
 * With everything completed the payment still runs (a re-run of a payment-link policy sends the link again).
 *
 * @param {Object} stages  stagesFor(policy, key)
 * @returns {{skipProposal:boolean, skipKyc:boolean, skipPayment:boolean, proposalNumber:string|null, proposalLink:string|null, startAt:"proposal"|"kyc"|"payment"}}
 */
function planResume(stages) {
  const s = stages || {};
  const proposal = s.proposal || {};
  const kyc = s.kyc || {};
  const number = plainNumber(proposal.proposalNumber);
  const link = plainNumber(proposal.link);
  const skipProposal = normStatus(proposal.status) === "completed" && (number !== "" || link !== "");
  const skipKyc = skipProposal && normStatus(kyc.status) === "completed";
  const skipPayment = skipProposal && !skipKyc && normStatus((s.payment || {}).status) === "completed";
  return {
    skipProposal,
    skipKyc,
    skipPayment,
    proposalNumber: skipProposal && number !== "" ? number : null,
    proposalLink: skipProposal && link !== "" ? link : null,
    startAt: skipKyc ? "payment" : skipProposal ? "kyc" : "proposal",
  };
}

/**
 * The Mongo $set for one stage, with the cascade: a proposal completed afresh or set back to pending puts KYC and
 * payment back to pending; every other write touches only its own stage.
 *
 * @param {string} key     part key
 * @param {string} stage   "proposal" | "kyc" | "payment"
 * @param {string} status  "pending" | "completed" | "failed"
 * @param {Object} [extra] fields kept on the stage (proposalNumber, mode, error, by, note ...)
 * @param {Date}   [now]
 */
function stageSet(key, stage, status, extra = {}, now = new Date()) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown Reliance stage "${stage}"`);
  if (!STAGE_STATUSES.includes(status)) throw new Error(`Unknown Reliance stage status "${status}"`);
  const base = `relianceStages.${stageKeyOf(key)}`;
  const clean = {};
  for (const [name, value] of Object.entries(extra || {})) {
    if (value !== undefined && name !== "status" && name !== "at") clean[name] = value;
  }
  const set = { [`${base}.${stage}`]: { ...clean, status, at: now } };
  if (status !== "failed") {
    for (const later of cascadesFrom(stage)) {
      set[`${base}.${later}`] = { status: "pending", at: now, note: `after ${stageWords(stage, status)}` };
    }
  }
  return set;
}

/** Was money paid (or possibly paid) at Reliance for this part? Then nothing of it may be redone. */
function walletMoneyMoved(policy, key) {
  const note = policy && policy[walletNoteField(key)];
  if (note && WALLET_MONEY_STATES.includes(String(note.state || "").trim())) return true;
  const payment = stagesFor(policy, key).payment;
  return payment.status === "completed" && String(payment.mode || "").toLowerCase() === "wallet";
}

/**
 * Why a stage may NOT be set back to pending — null when it may. Sentences carry no colon (the operator error rule).
 *
 * @param {Object} o
 * @param {Object} o.policy         the onlinePolicy document (relianceStages, walletPayment*)
 * @param {string} o.key            part key
 * @param {string} o.stage
 * @param {boolean} [o.processing]  the job runs right now
 */
function whyNotReset({ policy, key, stage, processing = false } = {}) {
  if (!STAGES.includes(stage)) return `There is no Reliance stage called "${stage}"`;
  if (processing) return "The automation is running this policy right now. Wait for the run to finish, then try again";
  const current = stagesFor(policy, key)[stage];
  if (current.status === "pending") return `${STAGE_LABEL[stage]} is already pending, so there is nothing to set back`;
  if (walletMoneyMoved(policy, key)) {
    return "This policy was paid from the wallet at Reliance, so its stages cannot be redone";
  }
  return null;
}

/** The $set that puts a stage back to pending, by an operator (a proposal takes KYC and payment along). */
function resetSet(key, stage, { by = "", now = new Date(), previous = null } = {}) {
  const extra = { by: by || undefined, note: "set back to pending by hand" };
  if (stage === "proposal" && previous && previous.proposalNumber) extra.previousProposalNumber = previous.proposalNumber;
  return stageSet(key, stage, "pending", extra, now);
}

/* ---------------------------------- set by hand (Edit -> Status, 2026-10-19) ---------------------------------- */

/** A Reliance referral number as the portal shows it: R and digits (R141026119597). */
const REFERRAL_NUMBER = /^R\d{6,}$/i;
const isKshemaCompany = (company) => /kshema/i.test(String(company == null ? "" : company));
const isPageLink = (link) => /^https?:\/\/\S+$/i.test(plainNumber(link));

/**
 * Why ONE step may NOT be set by hand to `to` - null when it may. The owner's rules (2026-10-19)
 *   Proposal -> completed  only with a referral number (Reliance) or the saved proposal page link (KSHEMA)
 *   KYC      -> completed  any time, but the proposal must be completed (already, or in the same save - proposalDone)
 *   Payment  -> completed  any time for a payment link / the KSHEMA QR, never a wallet payment (money moves)
 *   anything -> pending    the History rule (whyNotReset)
 * Never while the automation runs the policy, never on a part paid from the wallet. Sentences carry no colon.
 *
 * @param {Object} o
 * @param {string} [o.proposalNumber]  typed in the dialog (else the saved one counts)
 * @param {string} [o.link]            typed in the dialog (KSHEMA, else the saved one counts)
 * @param {boolean} [o.proposalDone]   the proposal is completed after this save (for the KYC rule)
 */
function whyNotSetByHand({
  policy,
  key,
  stage,
  to,
  proposalNumber = "",
  link = "",
  processing = false,
  company = "",
  paymentMethod = "",
  proposalDone,
} = {}) {
  if (!STAGES.includes(stage)) return `There is no step called "${stage}"`;
  const target = String(to == null ? "" : to).trim().toLowerCase();
  if (target === "pending") return whyNotReset({ policy, key, stage, processing });
  if (target !== "completed") return `${STAGE_LABEL[stage]} can only be set to Pending or Completed by hand`;
  if (processing) return "The automation is running this policy right now. Wait for the run to finish, then try again";
  if (walletMoneyMoved(policy, key)) return "This policy was paid from the wallet at Reliance, so its steps cannot be changed";

  const all = stagesFor(policy, key);
  const current = all[stage];
  if (stage === "proposal") {
    if (isKshemaCompany(company)) {
      const page = plainNumber(link) || plainNumber(current.link) || plainNumber(policy && policy.proposalLink);
      if (!isPageLink(page)) return "Proposal can be Completed only with the KSHEMA proposal page link. Paste the page address";
      if (current.status === "completed" && page === plainNumber(current.link)) return "Proposal is already completed with this page";
      return null;
    }
    const number = plainNumber(proposalNumber) || plainNumber(current.proposalNumber) || plainNumber(policy && policy.proposalNumber);
    if (!number) return "Proposal can be Completed only with its referral number. Type the referral number";
    if (!REFERRAL_NUMBER.test(number)) return `"${number}" is not a referral number. It starts with R and has digits only, like R141026119597`;
    if (current.status === "completed" && number.toUpperCase() === plainNumber(current.proposalNumber).toUpperCase()) {
      return "Proposal is already completed with this referral number";
    }
    return null;
  }
  if (current.status === "completed") return `${STAGE_LABEL[stage]} is already completed`;
  if (stage === "kyc") {
    const done = proposalDone === undefined ? all.proposal.status === "completed" : !!proposalDone;
    if (!done) return "KYC can be Completed only after the Proposal is completed. Complete the Proposal with its referral number first";
    return null;
  }
  // payment
  if (!isKshemaCompany(company) && String(paymentMethod || "").trim().toLowerCase() === "wallet") {
    return "A wallet payment cannot be marked by hand. Money moves at Reliance, so only the automation records it";
  }
  return null;
}

/**
 * The Mongo $set for one step set by hand. Completed keeps the later steps as they are - except a Proposal completed
 * with a NEW referral number / page (a different proposal), which takes KYC and Payment back to pending like a new
 * proposal does. Pending works like the History "set back" (a Proposal takes the others along).
 *
 * @param {Object} [o]  by, reason, proposalNumber, link, mode (payment "link" | "qr"), previous (the step before)
 */
function manualSet(key, stage, status, { by = "", reason = "", proposalNumber = "", link = "", mode = "", previous = null } = {}, now = new Date()) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown step "${stage}"`);
  const prev = previous || {};
  const who = { by: plainNumber(by) || undefined, reason: plainNumber(reason) || undefined, manual: true };
  if (status === "pending") {
    const extra = { ...who, note: "set back to pending by hand" };
    if (stage === "proposal" && prev.proposalNumber) extra.previousProposalNumber = prev.proposalNumber;
    return stageSet(key, stage, "pending", extra, now);
  }
  if (status !== "completed") throw new Error(`A step can be set by hand only to pending or completed, not "${status}"`);

  const base = `relianceStages.${stageKeyOf(key)}`;
  const extra = { ...who, note: "marked completed by hand" };
  let newProposal = false;
  if (stage === "proposal") {
    const number = (plainNumber(proposalNumber) || plainNumber(prev.proposalNumber)).toUpperCase();
    const page = plainNumber(link) || plainNumber(prev.link);
    if (number) extra.proposalNumber = number;
    if (page) extra.link = page;
    const before = (plainNumber(prev.proposalNumber) || plainNumber(prev.link)).toUpperCase();
    const after = (number || page).toUpperCase();
    newProposal = !!before && !!after && before !== after;
    if (newProposal && prev.proposalNumber) extra.previousProposalNumber = prev.proposalNumber;
  }
  if (stage === "payment" && plainNumber(mode)) extra.mode = plainNumber(mode).toLowerCase();
  const clean = {};
  for (const [name, value] of Object.entries(extra)) if (value !== undefined) clean[name] = value;
  const set = { [`${base}.${stage}`]: { ...clean, status: "completed", at: now } };
  if (newProposal) {
    for (const later of laterStages(stage)) {
      set[`${base}.${later}`] = { status: "pending", at: now, note: "after a new referral number set by hand" };
    }
  }
  return set;
}

/** The first step not completed after the given statuses ("proposal" | "kyc" | "payment"), or null when all are. */
function firstOpenStage(statuses) {
  const s = statuses || {};
  return STAGES.find((stage) => normStatus(s[stage]) !== "completed") || null;
}

/** "Proposal completed" style words for history lines. */
function stageWords(stage, status) {
  return `${STAGE_LABEL[stage] || stage} ${normStatus(status)}`;
}

module.exports = {
  STAGES,
  STAGE_LABEL,
  STAGE_STATUSES,
  WALLET_MONEY_STATES,
  stageKeyOf,
  walletNoteField,
  stagesFor,
  laterStages,
  cascadesFrom,
  planResume,
  stageSet,
  walletMoneyMoved,
  whyNotReset,
  resetSet,
  stageWords,
  REFERRAL_NUMBER,
  whyNotSetByHand,
  manualSet,
  firstOpenStage,
};
