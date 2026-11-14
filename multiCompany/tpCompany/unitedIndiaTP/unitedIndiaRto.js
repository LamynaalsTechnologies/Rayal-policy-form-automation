/**
 * United India Risk Details, the RTO after the contact details (the owner, 2026-11-13):
 *   RTO   <select name="rtaDesc" id="rtaDesc" onchange="populateInvoiceZone()">
 *           <option value="PY01 PONDICHERRY@2897">PY01 PONDICHERRY</option> ... (and a bare "PY", and empty options)
 * The list is the Vehicle Registration State's RTOs (filled by the portal after that state, the customer's state).
 * The policy's RTO City/Location (`rtoCityLocation`) holds the code as the RTO master wrote it - "TN55", "TN-55", "TN 55" -
 * so the code is compared by its parts: the 2 state letters, the number (a leading 0 does not count: TN5 = TN05) and any
 * letters stuck to it (DL1C). The option's code is the start of its text ("TN55 SALEM", "TN-55 SALEM", "TN 55 SALEM").
 *   - exactly one option with that code: chosen (read back, once more if it did not take), the portal's
 *     populateInvoiceZone() and loader waited for;
 *   - none: the run stops - not retried, with its screenshot - naming the nearest RTOs United India offers for that state,
 *     or, when the list has no RTO of that state at all, what it lists instead (the list follows the customer's state);
 *   - more than one: the run stops and lists them (never a guess).
 * A policy without a usable RTO code stops before the page is touched.
 */
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { selectAndConfirm, alertTextOf, alertRefusal } = require("./unitedIndiaSteps");
const { waitForList, LIST_WAIT_MS } = require("./unitedIndiaRisk");

const STAGE = "united-india-risk";
const RTO_ID = "rtaDesc";
const LABEL = "RTO";
const NEAREST = 10;

/** "TN-55" / "tn 55" / "TN55 SALEM" / "DL1C" -> { state: "TN", num: 55, suffix: "", code: "TN55" }, else null. */
function rtoParts(text) {
  const m = /^\s*([A-Za-z]{2})[\s-]?0*(\d{1,3})([A-Za-z]{0,3})(?=$|[^A-Za-z0-9])/.exec(String(text == null ? "" : text));
  if (!m) return null;
  const state = m[1].toUpperCase();
  const num = Number(m[2]);
  const suffix = m[3].toUpperCase();
  return { state, num, suffix, code: `${state}${String(num).padStart(2, "0")}${suffix}` };
}

const sameRto = (a, b) => !!a && !!b && a.state === b.state && a.num === b.num && a.suffix === b.suffix;

/** The list's options that are real RTOs (have a code), with their parts. */
const rtoOptions = (state) =>
  ((state && state.options) || []).filter((o) => o && !o.disabled && o.value !== "").map((o) => ({ ...o, rto: rtoParts(o.text) })).filter((o) => o.rto);

const listOf = (names) => names.map((n) => `"${String(n).replace(/:/g, " -")}"`).join(", ");

const stop = (message) => new MultiCompanyError("E306", message, { company: "united india", stage: STAGE, retryable: false });

/**
 * @param {WebDriver} driver  on Risk Details, the contact details entered
 * @param {Object} data       the job data (rtoCityLocation)
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ rto: string, value: string }>}
 */
async function chooseRto(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const given = String(data.rtoCityLocation == null ? "" : data.rtoCityLocation).trim();
  const want = rtoParts(given);
  if (!want) {
    throw stop(
      given
        ? `United India - the policy's RTO City/Location "${given.replace(/:/g, " -")}" is not an RTO code like TN55, so the RTO cannot be chosen and the run stopped there. Correct the RTO on the policy, then run it again.`
        : "United India - the policy has no RTO City/Location, so the RTO cannot be chosen and the run stopped there. Enter the RTO on the policy, then run it again."
    );
  }
  log(`🏢 United India - RTO ${want.code} (the policy's RTO "${given}")`);

  // the list the portal filled after the Vehicle Registration State
  const list = await waitForList(driver, RTO_ID, o).catch((e) => {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(LABEL, text, STAGE);
    throw e;
  });
  if (!list) {
    throw new MultiCompanyError("E301", `United India - the "RTO" box is not on the Risk Details page (not visible after ${LIST_WAIT_MS / 1000} seconds), so the run stopped there. It will try again shortly.`, {
      company: "united india",
      stage: STAGE,
    });
  }
  const options = rtoOptions(list);
  if (!options.length) {
    throw new MultiCompanyError(
      "E301",
      `United India - the RTO list stayed empty (${LIST_WAIT_MS / 1000} seconds after the Vehicle Registration State was chosen), so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }

  const hits = options.filter((x) => sameRto(x.rto, want));
  if (hits.length > 1) {
    throw stop(
      `United India - the RTO list has more than one ${want.code} - ${listOf(hits.map((x) => x.text))} - so the run stopped there rather than guess. Tell the developer which one this policy needs.`
    );
  }
  if (!hits.length) {
    const sameState = options.filter((x) => x.rto.state === want.state).sort((a, b) => Math.abs(a.rto.num - want.num) - Math.abs(b.rto.num - want.num));
    const offers = sameState.length
      ? `The nearest ${want.state} RTOs United India offers are ${listOf(sameState.slice(0, NEAREST).map((x) => x.text))}.`
      : `United India's list has no ${want.state} RTO at all - it lists the RTOs of the Vehicle Registration State (the customer's state on the policy), e.g. ${listOf(
          options.slice(0, 5).map((x) => x.text)
        )}. Check the customer's state and the RTO on the policy.`;
    throw stop(`United India - the RTO ${want.code} (the policy's RTO "${given.replace(/:/g, " -")}") is not in United India's RTO list, so the run stopped there. ${offers} Correct the policy, then run it again.`);
  }

  const chosen = await selectAndConfirm(driver, { label: LABEL, selectId: RTO_ID, wanted: hits[0].value, stage: STAGE }, { ...o, log });
  await waitForLoader(driver, "united india", { stage: STAGE }).catch((e) => {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(LABEL, text, STAGE);
    throw e;
  }); // populateInvoiceZone()
  log(`✅ United India - RTO "${chosen.text}" chosen (the policy's RTO "${given}")`);
  return { rto: chosen.text, value: chosen.value };
}

module.exports = { chooseRto, rtoParts, rtoOptions, sameRto, RTO_ID };
