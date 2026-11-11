/**
 * Reliance's State box (`#state`, the Form 60 / customer window) gets the CUSTOMER'S state (2026-11-11).
 *
 * Before: the box was set to `data.state || "30"`. `data.state` is made by server.js buildFormDataFromPolicy (and the
 * backend's buildFullJobFormData) as `state == "TAMILNADU" ? "30" : state == "KARNATAKA" ? "26" : "30"` - but the Online
 * Policy saves "tamilnadu", "karnataka", ... in small letters, so nothing ever matched and EVERY policy was sent as "30"
 * = TAMIL NADU. (Its "26" is not even Karnataka on the portal: it is PUDUCHERRY U T.)
 * `data.state` is left as it is: Brisk (briskCertificate.js getStateName) and KSHEMA's fallback still read that code.
 *
 * Now the state is the policy's own State/Union Territory - `formData.customerState`, which lib/partRunner.js reads from
 * the policy right before every run (server.js buildFormDataFromPolicy sets it too, for the old one-job path) - matched
 * by NAME to the option Reliance's box offers on the page (the option numbers are never trusted). A name written as the
 * Online Policy has it ("tamilnadu"), as Aadhaar prints it ("Tamil Nadu") or as Reliance does ("TAMIL NADU") all match.
 *
 * No state on the policy, or one Reliance does not list, stops the run at the State box with one sentence and no retry
 * (`nonRetryable`, read by the form's catch): choosing some other state would put a wrong address on the policy.
 * The choice is read back; a box that does not hold it is an error (a flaky page - retried like any other).
 */
const { isRealisticSelectEnabled, selectLikeUser, readSelectInPage, setSelectByScriptInPage } = require("../../lib/realSelect");

/** Reliance's State list as the portal served it on 2026-11-11 (value -> text). Only for messages and the early check. */
const RELIANCE_STATE_OPTIONS = [
  { value: "1", text: "ANDAMAN AND NICOBAR ISLANDS" },
  { value: "2", text: "ANDHRA PRADESH" },
  { value: "3", text: "ARUNACHAL PRADESH" },
  { value: "4", text: "ASSAM" },
  { value: "5", text: "BIHAR" },
  { value: "6", text: "CHANDIGARH U.T." },
  { value: "7", text: "CHHATTISGARH" },
  { value: "8", text: "DADRA AND NAGAR HAVELI" },
  { value: "9", text: "DAMAN AND DIU" },
  { value: "10", text: "DELHI" },
  { value: "11", text: "GOA" },
  { value: "12", text: "GUJARAT" },
  { value: "13", text: "HARYANA" },
  { value: "14", text: "HIMACHAL PRADESH" },
  { value: "15", text: "JAMMU AND KASHMIR" },
  { value: "16", text: "JHARKHAND" },
  { value: "17", text: "KARNATAKA" },
  { value: "18", text: "KERALA" },
  { value: "41", text: "LADHAKH U.T." },
  { value: "19", text: "LAKSHADWEEP U.T." },
  { value: "20", text: "MADHYA PRADESH" },
  { value: "21", text: "MAHARASHTRA" },
  { value: "22", text: "MANIPUR" },
  { value: "36", text: "MEGHALAYA" },
  { value: "23", text: "MIZORAM" },
  { value: "24", text: "NAGALAND" },
  { value: "25", text: "ODISHA" },
  { value: "26", text: "PUDUCHERRY U T" },
  { value: "27", text: "PUNJAB" },
  { value: "28", text: "RAJASTHAN" },
  { value: "29", text: "SIKKIM" },
  { value: "30", text: "TAMIL NADU" },
  { value: "40", text: "TELANGANA" },
  { value: "31", text: "TRIPURA" },
  { value: "32", text: "UTTAR PRADESH" },
  { value: "33", text: "UTTARAKHAND" },
  { value: "34", text: "WEST BENGAL" },
];

/** Other spellings of the same state -> the spelling Reliance uses (both as stateKey). */
const ALIASES = {
  pondicherry: "puducherry",
  ladakh: "ladhakh",
  orissa: "odisha",
  uttaranchal: "uttarakhand",
  chattisgarh: "chhattisgarh",
  telengana: "telangana",
  newdelhi: "delhi",
  nctofdelhi: "delhi",
  andamanandnicobar: "andamanandnicobarislands",
};

/**
 * "Tamil Nadu" / "tamilnadu" / "TAMIL NADU" -> "tamilnadu"; "PUDUCHERRY U T" / "Pondicherry (U.T.)" -> "puducherry";
 * "Jammu & Kashmir" -> "jammuandkashmir". Letters only, "&" read as "and", a "U.T." / "Union Territory" ending dropped.
 */
function stateKey(text) {
  const words = String(text == null ? "" : text)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .replace(/\s+(u\s*t|union\s+territory)$/, "");
  const key = words.replace(/\s+/g, "");
  return ALIASES[key] || key;
}

/**
 * The customer's state as the policy has it: `customerState` (the policy's own value, lib/partRunner.js), else a
 * `state` that is a NAME. A number in `state` is the old "30" every policy got - it says nothing, so it is not used.
 */
function customerStateOf(data = {}) {
  const own = String(data.customerState == null ? "" : data.customerState).trim();
  if (own) return own;
  const old = String(data.state == null ? "" : data.state).trim();
  return old && !/^\d+$/.test(old) ? old : "";
}

/** The option of `options` ({value, text}) that is the state `wanted` names, or null. */
function stateOptionFor(options, wanted) {
  const want = stateKey(wanted);
  if (!want) return null;
  return (options || []).find((o) => o && String(o.value) !== "" && !o.disabled && stateKey(o.text) === want) || null;
}

/** A State problem no retry can fix - the operator has to correct the policy's State/Union Territory. */
class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = "StateError";
    this.nonRetryable = true;
  }
}

/**
 * What the run will choose, worked out from the data alone (no page). Never throws.
 * @returns {{raw:string, option:{value:string,text:string}|null, problem:string|null}}
 */
function planRelianceState(data = {}) {
  const raw = customerStateOf(data);
  if (!raw) {
    return {
      raw,
      option: null,
      problem: "The policy has no State/Union Territory, so Reliance's State box cannot be chosen. Fill it on the Online Policy and run again. Nothing was submitted.",
    };
  }
  const option = stateOptionFor(RELIANCE_STATE_OPTIONS, raw);
  if (!option) {
    return {
      raw,
      option: null,
      problem: `The policy's State/Union Territory "${raw}" is not in Reliance's State list. Correct it on the Online Policy and run again. Nothing was submitted.`,
    };
  }
  return { raw, option, problem: null };
}

/** One line for the log before the window opens: what will be chosen, or what will stop the run at the State box. */
function relianceStatePlanLine(plan) {
  if (plan.problem) return `⚠️ State - ${plan.problem}`;
  return `State to choose at Reliance: ${plan.option.text} (the policy's State/Union Territory "${plan.raw}")`;
}

/** Wait for the box to be there with its options; null when it never is. */
async function readStateBox(driver, selectId, { timeoutMs = 10000, pause } = {}) {
  const wait = pause || ((ms) => driver.sleep(ms));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let box = null;
    try {
      box = await driver.executeScript(readSelectInPage, selectId);
    } catch (e) {
      box = null; // the window is between renders - look again
    }
    if (box && box.options.some((o) => o.value !== "")) return box;
    if (Date.now() >= deadline) return box;
    await wait(500);
  }
}

const selectedText = (box) => {
  const o = box && box.selectedIndex >= 0 ? box.options[box.selectedIndex] : null;
  return o && o.value !== "" ? o.text || o.value : "";
};

/**
 * Choose the customer's state in Reliance's State box and read it back.
 *
 * @param {Object} driver
 * @param {Object} data              the job data (customerState, see customerStateOf)
 * @param {Object} [o]
 * @param {Function} [o.select]      the old scripted setter (async (driver, id, value)), used when the real pick is switched off
 * @param {Function} [o.log]
 * @param {Function} [o.picker]      test seam for selectLikeUser
 * @param {Function} [o.pause]       test seam for the waits
 * @param {string}   [o.selectId]    default "state"
 * @returns {Promise<{value:string, text:string, raw:string, how:string}>}
 * @throws StateError (no retry) when the policy has no state or Reliance does not offer it; Error when the box does not take it
 */
async function selectRelianceState(driver, data, { select, log = () => {}, picker, pause, selectId = "state", timeoutMs } = {}) {
  const plan = planRelianceState(data);
  if (plan.problem) throw new StateError(plan.problem);

  const box = await readStateBox(driver, selectId, { timeoutMs, pause });
  if (!box) throw new Error(`Reliance's State box (${selectId}) did not appear on the page. Nothing was submitted.`);
  // The option as the PAGE has it - matched by name, so a renumbered list still gets the right state.
  const live = stateOptionFor(box.options, plan.raw);
  if (!live) {
    const offered = box.options.filter((x) => x.value !== "" && !x.disabled).map((x) => x.text || x.value);
    throw new StateError(
      `Reliance's State box does not offer the policy's State/Union Territory "${plan.raw}" - it offers ${offered.length ? offered.join(", ") : "nothing"}. Nothing was submitted.`
    );
  }

  let how = "script";
  if (isRealisticSelectEnabled()) {
    ({ how } = await (picker || selectLikeUser)(driver, selectId, live.value, { label: "State", log }));
  } else if (typeof select === "function") {
    await select(driver, selectId, live.value);
  } else {
    await driver.executeScript(setSelectByScriptInPage, selectId, live.value);
  }

  const after = await driver.executeScript(readSelectInPage, selectId);
  const now = after && after.selectedIndex >= 0 ? after.options[after.selectedIndex] : null;
  if (!now || String(now.value) !== String(live.value)) {
    throw new Error(
      `Reliance did not take the State "${live.text}" - its State box reads "${selectedText(after)}". Nothing was submitted.`
    );
  }
  log(`Selected State ${live.text} (the policy's State/Union Territory "${plan.raw}")` + (how === "list" ? " - picked from the open list" : ""));
  return { value: String(live.value), text: live.text, raw: plan.raw, how };
}

/**
 * After the pincode is chosen: does the State box still hold the customer's state? Only READS and logs - what Reliance
 * does to the State box when a pincode of another state is picked is not known yet, so nothing is changed. Never throws.
 * @returns {Promise<"same"|"changed"|"unknown">}
 */
async function checkStateAfterPincode(driver, chosen, { log = () => {}, selectId = "state", pinCode = "" } = {}) {
  if (!chosen) return "unknown";
  let box = null;
  try {
    box = await driver.executeScript(readSelectInPage, selectId);
  } catch (e) {
    box = null;
  }
  if (!box) {
    log("⚠️ State box could not be read after the pincode");
    return "unknown";
  }
  const now = selectedText(box);
  if (stateKey(now) === stateKey(chosen.text)) {
    log(`✅ State still ${chosen.text} after the pincode`);
    return "same";
  }
  log(
    `⚠️ After pincode ${pinCode || "(none)"} Reliance's State box reads "${now}", not ${chosen.text} (the policy's State/Union Territory "${chosen.raw}") - check that the pincode belongs to that state`
  );
  return "changed";
}

module.exports = {
  RELIANCE_STATE_OPTIONS,
  stateKey,
  customerStateOf,
  stateOptionFor,
  planRelianceState,
  relianceStatePlanLine,
  selectRelianceState,
  checkStateAfterPincode,
  StateError,
};
