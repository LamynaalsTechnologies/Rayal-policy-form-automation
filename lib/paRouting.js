/**
 * The run-time PA routing guard (the owner, 2026-10-23): "the PA is done only with the company that was selected — Brisk, or the TP
 * company — and the other is not touched."
 *
 * The job's parts say who buys the PA (`carriesPa` on the part that takes it with its own policy, a Brisk `pa` part otherwise).
 * They were built from the policy when it was saved; this reads the policy as it is NOW, right before a part runs, and refuses to
 * start a part that would buy PA somewhere the policy no longer says — a stale or mis-built job, or an edit that landed between the
 * build and the run. Money is at stake (a Brisk certificate cannot be edited once bought; a portal part buys PA with its policy),
 * so nothing is guessed: the part stops with one sentence, nothing bought, and saving the policy again re-syncs its parts.
 *
 * Only the two "would buy something it should not" cases are checked; a policy saved before `settings` existed has no routing to
 * compare with and is left alone. Pure: no database, no browser.
 */
const norm = (value) => String(value == null ? "" : value).trim().toLowerCase();
const truthy = (value) => value === true || ["true", "1", "yes"].includes(norm(value));

/** The policy's `settings` as an object (it is saved as an object; an older writer may have left JSON text). */
const settingsOf = (policy) => {
  const raw = policy && policy.settings;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }
  return null;
};

/**
 * What is wrong between this part and what the policy says about PA, as one sentence for the operator (one colon; nothing was
 * bought), or "" when the part may run.
 *
 * @param {Object} part    the job part about to run ({ key, kind, company, label, carriesPa })
 * @param {Object} policy  the policy as it is now ({ paCover, settings: { PACompany } }) — null / no settings = not checked
 */
function paRoutingProblem(part, policy) {
  const settings = settingsOf(policy);
  if (!part || !settings || !Object.prototype.hasOwnProperty.call(settings, "PACompany")) return "";
  const paOn = truthy(policy.paCover);
  const provider = paOn ? String(settings.PACompany || "").trim() : "";
  const state = !paOn ? "off" : provider ? `bought with ${provider}` : "not assigned to any company";
  const again = "Save the policy again so its parts match what it now says.";

  if (part.kind === "brisk") {
    if (paOn && norm(provider) === "brisk") return "";
    return `Brisk PA: this policy's PA Cover is ${state}, not through Brisk, so no Brisk certificate was bought. ${again}`;
  }
  if (part.carriesPa === true) {
    if (paOn && provider && norm(provider) === norm(part.company)) return "";
    const name = `${part.company || "Insurer"} ${part.label || String(part.key || "").toUpperCase()}`.trim();
    return `${name}: this policy's PA Cover is ${state}, not with ${part.company || "this insurer"}, so this part was not run (it would have bought PA there). ${again}`;
  }
  return "";
}

module.exports = { paRoutingProblem, settingsOf };
