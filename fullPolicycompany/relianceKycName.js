/**
 * Reliance KYC — is the name Reliance read from the Aadhaar the policy's own name?
 *
 * After SUBMIT is accepted Reliance opens its CKYC result form. In it a disabled box holds the name it read from the
 * document:
 *
 *   <input id="result_name" name="ckyc_result_name" ng-model="ckyc_result.registered_name" value="Anmol Arora" disabled>
 *
 * Until now nothing compared it with the policy: a KYC in another person's name — or any other spelling — was accepted
 * and the run went on to PROCEED. This compares it with the policy's Full Name + Surname and, on any other name, ends
 * the policy as a KYC failure (relianceForm.js throws KycNameMismatchError BEFORE PROCEED, so the existing KYC fallback
 * takes the screenshot of this very page and saves the links).
 *
 * The rule: the words of Full Name + Surname must be exactly the words of the portal's name, in ANY order (Reliance
 * sometimes puts the surname first). Case, spacing and punctuation do not matter. Another name, a middle name or an
 * initial that is not on the policy is a mismatch — there is no fuzzy matching on purpose.
 *
 * A box that cannot be read (missing, empty after the wait) is NOT a mismatch: the check reports "unreadable" and the
 * flow carries on exactly as before, so a changed Reliance page can never stop good policies.
 *
 * RELIANCE_KYC_NAME_CHECK_ENABLED in the automation's .env: ON unless false / 0 / no / off. Read at call time.
 *
 * RELIANCE_KYC_NAME_COMBINATIONS_ENABLED (the owner's rule, 2026-10-17; ON unless false / 0 / no / off): the portal's
 * name may be any of these four, words in any order —
 *     Full Name  |  Full Name + Surname  |  Full Name + Father Name  |  Full Name + Surname + Father Name
 * (Father Name = the policy's fatherName, the father's first name typed into Reliance's FatherFirstName box). Anything
 * else is a mismatch, and the run STOPS on that page: no Pending Quotes, no Pay, no links (the KYC fallback is skipped
 * for it — skipsKycFallback). Off = the rule above (Full Name + Surname only) and a mismatch goes to the KYC fallback.
 */
require("dotenv").config({ quiet: true });

const { PortalRejectedError, plain } = require("./relianceKycSubmit");

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isKycNameCheckEnabled() {
  return !isOff(process.env.RELIANCE_KYC_NAME_CHECK_ENABLED);
}

function isKycNameCombinationsEnabled() {
  return !isOff(process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED);
}

/* -------------------------------------------------------------------------- */
/* The comparison (pure)                                                      */
/* -------------------------------------------------------------------------- */

/** "Dr. ANMOL  Arora," -> ["dr", "anmol", "arora"]: lower case, no accents, no punctuation, no empties. */
function nameTokens(text) {
  return String(text == null ? "" : text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Multiset difference: the words of `from` that `other` does not have (a repeated word counts each time). */
function without(from, other) {
  const rest = [...other];
  const left = [];
  for (const token of from) {
    const at = rest.indexOf(token);
    if (at >= 0) rest.splice(at, 1);
    else left.push(token);
  }
  return left;
}

const sameWords = (a, b) => a.length > 0 && b.length > 0 && without(a, b).length === 0 && without(b, a).length === 0;

/**
 * The names the portal may show for this policy: Full Name + Surname only (`combinations` false), or the owner's four
 * (Full Name; + Surname; + Father Name; + both). Each is a list of words; an empty part adds nothing, so duplicates
 * collapse.
 */
function allowedNames({ fullName = "", surname = "", fatherName = "", combinations = false } = {}) {
  const first = nameTokens(fullName);
  const sur = nameTokens(surname);
  const father = nameTokens(fatherName);
  if (!first.length) return [];
  const list = combinations
    ? [first, [...first, ...sur], [...first, ...father], [...first, ...sur, ...father]]
    : [[...first, ...sur]];
  const seen = new Set();
  return list.filter((words) => {
    const key = [...words].sort().join(" ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * @returns {{ok:boolean, comparable:boolean, expected:string[], portal:string[], missing:string[], extra:string[],
 *            matched?:string[], allowed:string[][]}}
 *   `comparable` is false when the policy has no Full Name (nothing to compare against). `missing` / `extra` are measured
 *   against Full Name + Surname, as before. `matched` = the allowed name the portal's equals.
 */
function compareKycName({ fullName = "", surname = "", fatherName = "", portalName = "", combinations = false } = {}) {
  const expected = [...nameTokens(fullName), ...nameTokens(surname)];
  const portal = nameTokens(portalName);
  const allowed = combinations
    ? allowedNames({ fullName, surname, fatherName, combinations: true })
    : expected.length
    ? [expected]
    : [];
  const matched = allowed.find((words) => sameWords(words, portal));
  return {
    ok: !!matched,
    comparable: combinations ? nameTokens(fullName).length > 0 : expected.length > 0,
    expected,
    portal,
    missing: without(expected, portal),
    extra: without(portal, expected),
    matched,
    allowed,
  };
}

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises their source)             */
/* -------------------------------------------------------------------------- */

/** The name Reliance read, from the CKYC result form's disabled box. Brings the box into view. Reads only. */
function readKycNameInPage() {
  var el =
    document.getElementById("result_name") ||
    document.querySelector("input[name='ckyc_result_name']") ||
    document.querySelector("input[ng-model='ckyc_result.registered_name']");
  if (!el) return { found: false, value: "" };
  try {
    el.scrollIntoView({ block: "center" });
  } catch (e) {
    /* best effort */
  }
  var value = String(el.value || el.getAttribute("value") || "").replace(/\s+/g, " ").trim();
  return { found: true, value: value };
}

/** Marks the box red with a short note, so the screenshot of this page shows WHERE the problem is. Page only. */
function markKycNameMismatchInPage(label) {
  var el =
    document.getElementById("result_name") ||
    document.querySelector("input[name='ckyc_result_name']") ||
    document.querySelector("input[ng-model='ckyc_result.registered_name']");
  if (!el) return false;
  try {
    el.style.outline = "4px solid #d32f2f";
    el.style.backgroundColor = "#ffebee";
    var note = document.createElement("div");
    note.textContent = String(label || "KYC NAME MISMATCH");
    note.style.cssText = "color:#d32f2f;font-weight:700;font-size:15px;margin-top:6px;";
    if (el.parentNode) el.parentNode.insertBefore(note, el.nextSibling);
    return true;
  } catch (e) {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* The check                                                                  */
/* -------------------------------------------------------------------------- */

/** The sentence the operator reads. No colon in it (beautifyError keeps only the text after the last one). */
function kycNameMismatchMessage({ portalName, fullName, surname, fatherName, combinations = false } = {}) {
  if (combinations) {
    return (
      `KYC name mismatch - Reliance's KYC shows "${plain(portalName)}" but the policy has ` +
      `Full Name "${plain(fullName)}"${plain(surname) ? `, Surname "${plain(surname)}"` : ""}` +
      `${plain(fatherName) ? `, Father Name "${plain(fatherName)}"` : ""}. ` +
      "Allowed is Full Name alone, Full Name + Surname, Full Name + Father Name, or all three. " +
      "Correct the name on the policy, or use the customer's own Aadhaar, then run the policy again. " +
      "Stopped on the KYC page, PROCEED was not pressed and nothing was paid."
    );
  }
  return (
    `KYC name mismatch - Reliance's KYC shows "${plain(portalName)}" but the policy has ` +
    `Full Name "${plain(fullName)}"${plain(surname) ? ` and Surname "${plain(surname)}"` : ""}. ` +
    "Correct the name on the policy, or use the customer's own Aadhaar, then run the policy again. " +
    "PROCEED was not pressed and nothing was paid."
  );
}

/** Thrown by the form BEFORE PROCEED: a refusal that ends the policy (and is handed to the KYC fallback). */
class KycNameMismatchError extends PortalRejectedError {
  constructor(message, { portalName = "" } = {}) {
    super(message, { stage: "kyc-name", portalText: portalName });
    this.name = "KycNameMismatchError";
    this.keepMessage = true; // the failure catch must not replace it with whatever the page says
  }
}

/** The owner's rule: a KYC name mismatch stops on the KYC page — no Pending Quotes, no Pay, no links (no fallback). */
function skipsKycFallback(err) {
  return !!err && (err instanceof KycNameMismatchError || err.name === "KycNameMismatchError") && isKycNameCombinationsEnabled();
}

/**
 * Read the name box and compare it with the policy.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {Object} o.data   the job data: firstName = Full Name, lastName = Surname
 * @returns {Promise<{state:"match"|"mismatch"|"unreadable", portalName:string, fullName:string, surname:string,
 *                    compare?:Object, reason?:string}>}
 */
async function checkKycName(driver, o = {}) {
  const {
    data = {},
    log = () => {},
    sleep = (ms) => driver.sleep(ms),
    now = Date.now,
    waitMs = 10000,
    pollMs = 500,
  } = o;
  const fullName = String(data.firstName || data.fullName || "").trim();
  const surname = String(data.lastName || data.surname || "").trim();
  const fatherName = String(data.fatherName || data.fatherFirstName || "").trim();
  const combinations = isKycNameCombinationsEnabled();
  const out = { state: "unreadable", portalName: "", fullName, surname, fatherName, combinations };

  if (!nameTokens(combinations ? fullName : `${fullName} ${surname}`).length) {
    out.reason = "the policy has no name to compare with";
    return out;
  }

  // Angular fills the box a moment after the page opens.
  const deadline = now() + waitMs;
  let read = { found: false, value: "" };
  for (;;) {
    try {
      read = (await driver.executeScript(readKycNameInPage)) || read;
    } catch (e) {
      read = { found: false, value: "" };
    }
    if (read.found && read.value) break;
    if (now() >= deadline) break;
    await sleep(pollMs);
  }
  if (!read.found || !read.value) {
    out.reason = read.found ? "the name box is empty" : "the name box is not on the page";
    return out;
  }

  out.portalName = read.value;
  const compare = compareKycName({ fullName, surname, fatherName, portalName: read.value, combinations });
  out.compare = compare;
  if (compare.ok) {
    out.state = "match";
    log(`✅ KYC name matches the policy ("${read.value}")`);
    return out;
  }

  out.state = "mismatch";
  try {
    await driver.executeScript(
      markKycNameMismatchInPage,
      `KYC NAME MISMATCH - policy: ${[fullName, surname].filter(Boolean).join(" ")}`
    );
  } catch (e) {
    /* the picture is a courtesy */
  }
  return out;
}

module.exports = {
  isKycNameCheckEnabled,
  isKycNameCombinationsEnabled,
  allowedNames,
  skipsKycFallback,
  nameTokens,
  compareKycName,
  readKycNameInPage,
  markKycNameMismatchInPage,
  kycNameMismatchMessage,
  KycNameMismatchError,
  checkKycName,
};
