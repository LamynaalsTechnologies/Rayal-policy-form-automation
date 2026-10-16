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
 */
require("dotenv").config({ quiet: true });

const { PortalRejectedError, plain } = require("./relianceKycSubmit");

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isKycNameCheckEnabled() {
  return !isOff(process.env.RELIANCE_KYC_NAME_CHECK_ENABLED);
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

/**
 * @returns {{ok:boolean, comparable:boolean, expected:string[], portal:string[], missing:string[], extra:string[]}}
 *   `comparable` is false when the policy has no name at all (nothing to compare against).
 */
function compareKycName({ fullName = "", surname = "", portalName = "" } = {}) {
  const expected = [...nameTokens(fullName), ...nameTokens(surname)];
  const portal = nameTokens(portalName);
  const missing = without(expected, portal);
  const extra = without(portal, expected);
  return {
    ok: expected.length > 0 && portal.length > 0 && missing.length === 0 && extra.length === 0,
    comparable: expected.length > 0,
    expected,
    portal,
    missing,
    extra,
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
function kycNameMismatchMessage({ portalName, fullName, surname } = {}) {
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
  }
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
  const out = { state: "unreadable", portalName: "", fullName, surname };

  if (!nameTokens(`${fullName} ${surname}`).length) {
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
  const compare = compareKycName({ fullName, surname, portalName: read.value });
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
  nameTokens,
  compareKycName,
  readKycNameInPage,
  markKycNameMismatchInPage,
  kycNameMismatchMessage,
  KycNameMismatchError,
  checkKycName,
};
