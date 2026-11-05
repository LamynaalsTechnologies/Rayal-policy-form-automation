/**
 * KSHEMA's Nominee Relationship (the owner, 2026-11-05).
 *
 * The portal's list: Spouse, Common Law, Policyholder, Mother, Father, Son, Daughter, Other. It used to have "Child"
 * and "Parent" (the Online Policy form offered them until 2026-11-05); KSHEMA now has Son / Daughter and Mother /
 * Father instead. A policy saved with one of the old two stops at the nominee step with a plain sentence (the owner's
 * choice) - it used to log "option not found" and go on with no relation chosen. A relation the portal does not offer
 * at all stops the same way. "Other" is picked as it is: KSHEMA asks no relation name for it.
 *
 * Operator sentences carry no colon (the error is cut at its last colon before it is shown).
 */

/** The choices KSHEMA has now (lower case, the Online Policy form's values). */
const KSHEMA_RELATIONS = ["spouse", "common law", "policyholder", "mother", "father", "son", "daughter", "other"];

/** The old choices KSHEMA no longer has, and what replaced them. */
const OLD_RELATIONS = { child: "Son or Daughter", parent: "Mother or Father" };

const words = (v) =>
  String(v == null ? "" : v)
    .trim()
    .replace(/\s+/g, " ");
const title = (v) => words(v).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The sentence for an old Child / Parent, else null (checked before the dropdown is opened). */
function oldRelationProblem(relation) {
  const instead = OLD_RELATIONS[words(relation).toLowerCase()];
  if (!instead) return null;
  return `KSHEMA no longer has "${title(relation)}" as a Nominee Relationship. Edit the policy, choose ${instead}, then run it again.`;
}

/** The sentence for a relation the portal's list does not have. */
function notOfferedProblem(relation) {
  return `KSHEMA's Nominee Relationship list has no "${title(relation)}". Edit the policy, choose one of KSHEMA's relations, then run it again.`;
}

module.exports = { KSHEMA_RELATIONS, OLD_RELATIONS, oldRelationProblem, notOfferedProblem };
