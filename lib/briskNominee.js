"use strict";

/**
 * The nominee Brisk gets (owner, 2026-11-28: "the nominee details all go wrong to Brisk"). The SAME rule as the server
 * (RayalBrokers-backend shared/briskV2Rules.js matchBriskNominee) and the Online Policy form's Brisk Nominee box
 * (RayalBrokers-Frontend utils/briskNominee.js): the Brisk Nominee saved with the policy when complete; otherwise the policy's
 * own nominee - the same name, Brisk's relation (a Spouse is Husband / Wife by the nominee's own gender when the form asked
 * it, else by the customer's: the Husband of a woman, the Wife of a man), the gender that relation means. Nothing is guessed: before this, an empty relation went as "Son", every Spouse as "Wife", the customer's
 * gender as the nominee's and an empty name as "FERNANDO".
 * Used by the automation's own Brisk call (briskCertificate.js, BRISK_V2_AUTOMATION_ENABLED off).
 */

const BRISK_NOMINEE_RELATIONS = ["father", "mother", "wife", "husband", "sister", "son", "daughter", "brother"];
const MALE = new Set(["father", "husband", "son", "brother"]);
const RELATION_WORDS = { dad: "father", papa: "father", mom: "mother", mum: "mother" };
const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();

/** @returns {{name: string, gender: string, relation: string, matched: boolean, why: string}} */
const SPOUSE_NEEDS_GENDER = "the nominee's or the customer's gender is needed to tell Husband from Wife";
function matchBriskNominee({ nomineeName, nomineeRelation, nomineeGender, customerGender } = {}) {
  const name = clean(nomineeName).toUpperCase();
  const raw = clean(nomineeRelation);
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  let relation = BRISK_NOMINEE_RELATIONS.includes(key) ? key : RELATION_WORDS[key] || "";
  let why = "";
  if (!relation && key === "spouse") {
    const ng = clean(nomineeGender).toLowerCase();
    const g = clean(customerGender).toLowerCase();
    relation = ng.startsWith("m") ? "husband" : ng.startsWith("f") ? "wife" : g.startsWith("f") ? "husband" : g.startsWith("m") ? "wife" : "";
    if (!relation) why = SPOUSE_NEEDS_GENDER;
  } else if (!relation) {
    why = raw ? `Brisk has no relation like "${raw}"` : "the policy has no nominee relation";
  }
  if (!name && !why) why = "the policy has no nominee name";
  const gender = relation ? (MALE.has(relation) ? "male" : "female") : "";
  return { name, gender, relation, matched: !!(name && relation), why };
}

/** The nominee Brisk gets for a job's data: its saved Brisk Nominee when complete, else worked out from its nominee. */
function briskNomineeOf(data = {}) {
  const saved = {
    name: clean(data.briskNomineeName).toUpperCase(),
    gender: clean(data.briskNomineeGender).toLowerCase(),
    relation: clean(data.briskNomineeRelation).toLowerCase(),
  };
  if (saved.name && BRISK_NOMINEE_RELATIONS.includes(saved.relation) && (saved.gender === "male" || saved.gender === "female")) {
    return { ...saved, matched: true, why: "", saved: true };
  }
  return {
    ...matchBriskNominee({
      nomineeName: data.nomineeName,
      nomineeRelation: data.nomineeRelation || data.relation,
      nomineeGender: data.nomineeGender,
      customerGender: data.gender || data.customerGender,
    }),
    saved: false,
  };
}

/** The operator sentence when it cannot be worked out (no colon - beautifyError keeps only the text after the last one). */
const nomineeProblem = (n) => `The Brisk nominee could not be worked out (${n.why}). Edit the policy and choose the Brisk Nominee`;

module.exports = { BRISK_NOMINEE_RELATIONS, matchBriskNominee, briskNomineeOf, nomineeProblem };
