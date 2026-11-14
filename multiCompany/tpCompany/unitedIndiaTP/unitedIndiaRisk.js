/**
 * United India, the "Risk Details" page that the product's Submit opens (gc_initiateAshokLeyland.do; the owner's screenshot
 * and markup, 2026-11-06). The first two boxes:
 *   Vehicle Class                <select name="vehicleType" id="v_make" onchange="populateManufacturer();checkFastag();">
 *                                -> "Motorcycle / Scooter" (value 3) - every policy here is a two-wheeler
 *   Vehicle Registration State*  <select name="vehRgnState" id="regst" onchange="getRegNoRta()">
 *                                -> the state of the customer's details on the Online Policy (the owner: "use that")
 *   New Vehicle                  <input type="checkbox" name="ynNewVehicle" id="newvehchk1"
 *                                       onclick="valueset1();disableRegistration();getRegState();">  -> ticked
 *   Chassis Number*              <input id="chasisNumber" onkeyup="toupper(...)">  -> the policy's chassis number
 *   Engine Number*               <input id="engineNumber" onkeyup="toupper(...)">  -> the policy's engine number
 * (The repo's old formFlow.js / autofill.js did the same: v_make 3, regst 43 = TAMIL NADU, newvehchk1, chasisNumber,
 * engineNumber.) The New Vehicle tick runs the portal's getRegState(), so the Registration State is read again after it
 * and chosen once more if the tick changed it.
 *   Vehicle Manufacturer*        <select id="selectedNumNameCode" onchange="retrieveURL()">  -> our Make & Model row's MAKE
 *   Make*                        <select id="makeMotorDisplay" onchange="policyURL();FunctionChange()"> (filled by
 *                                retrieveURL after the manufacturer)  -> our row's MODEL
 *   (the owner's correction, 2026-11-06: "manufacturer is a make and make is a model" - e.g. HERO HONDA, then
 *   "CBZ(1999 - 2008)"). Both by the EXACT name (case and spaces do not count) - never a guess: the manufacturer list has
 *   "HONDA" and "HONDA_NONGICOUNCIL" side by side, and only the exact one is taken. Each list is filled by the portal itself
 *   (the manufacturers after the Vehicle Class, the Makes after the manufacturer), so it is waited for first (20 s): a list
 *   that has not arrived is "stayed empty" [E301, tried again], never "has no HONDA". No exact name in a loaded list: the
 *   run stops and its sentence names what United India offers that is LIKE it (at most 15 names, then "and N more"; the
 *   whole Make list only when it is that short), not retried - the Make & Model row has to be corrected (2026-11-13: the
 *   owner's live run, HONDA / "ACTIVA 125 FI(2019 - 2023)@ALLOY BS VI"; HONDA has well over a hundred Makes). The run's
 *   screenshot shows the page at the stop (runHandler). (The Make & Model dialog offers United India's own names from the
 *   Vehicle Model lists, which are kept by hand - the run never adds to them.)
 * Select Office, Motor (Liability Only), Business Source and Business Channel are filled by the portal and not touched.
 *
 * Every choice follows the owner's rule (./unitedIndiaSteps.js selectAndConfirm): chosen, read back, once more if it did not
 * take, a box that is not on the page is its own error. Each box's own onchange loads the next lists (manufacturers, RTAs),
 * so the portal's loader is waited for after each.
 */
const { selectAndConfirm, waitForShown, clickAndConfirm, fillAndConfirm } = require("./unitedIndiaSteps");
const { waitForLoader } = require("../../common/loader");
const { readSelectInPage } = require("../../../lib/realSelect");
const { MultiCompanyError } = require("../../common/errors");
const { throwIfHeld } = require("../../../lib/holdStop");
const { By } = require("selenium-webdriver");

const VEHICLE_CLASS = "Motorcycle / Scooter";
const VEHICLE_CLASS_ID = "v_make";
const REG_STATE_ID = "regst";
const NEW_VEHICLE = ["#newvehchk1", "input[name='ynNewVehicle']"];
const CHASSIS = ["#chasisNumber", "input[name='chasisNumber']"];
const ENGINE = ["#engineNumber", "input[name='engineNumber']"];
const MANUFACTURER_ID = "selectedNumNameCode";
const MAKE_ID = "makeMotorDisplay";

/** A name as it is compared: spaces collapsed (a non-breaking one too), upper case. */
const nameKey = (text) => String(text == null ? "" : text).replace(/\s+/g, " ").trim().toUpperCase();
/** The real choices of a list (no placeholder "select" / 0, nothing disabled). */
const realOptions = (state) =>
  ((state && state.options) || []).filter((o) => o && !o.disabled && o.value !== "" && o.value !== "0" && nameKey(o.text) !== "SELECT");

/** The option whose text is exactly `wanted` (case and spaces do not count), or null. */
function exactOption(state, wanted) {
  const key = nameKey(wanted);
  return realOptions(state).find((o) => nameKey(o.text) === key) || null;
}

/** At most this many names in a stop sentence (HONDA alone has well over a hundred Makes at United India). */
const LIST_MAX = 15;
/** How long a list filled by the portal's own onchange may take to arrive (a slow portal). */
const LIST_WAIT_MS = 20000;

/** Manufacturer names like `wanted` ("HONDA" -> HONDA_NONGICOUNCIL, HONDA MOTORCYCLE ...), for the stop sentence. */
function similarNames(state, wanted) {
  const key = nameKey(wanted);
  const base = (t) => nameKey(t).replace(/(_NONGICOUNCIL)+$/, "");
  const words = key.split(" ").filter((w) => w.length >= 3);
  return realOptions(state)
    .map((o) => o.text)
    .filter((t) => {
      const b = base(t);
      return b.includes(key) || key.includes(b) || words.some((w) => b.split(/[ _]/).includes(w));
    });
}

/** The parts of a Make name with a letter in them, 2+ characters ("ACTIVA 7G STD" -> ACTIVA, 7G, STD; not "125"). */
const modelTokens = (text) => nameKey(text).split(/[^A-Z0-9]+/).filter((w) => w.length >= 2 && /[A-Z]/.test(w));
/** The words that make a name "like" another: 3+ characters ("CB SHINE" -> SHINE; "BS VI" alone is like nothing). */
const modelWords = (text) => modelTokens(text).filter((w) => w.length >= 3);

/**
 * The portal's Make names (our Model) like `wanted`: those sharing a 3+ letter word with it, the ones sharing the most
 * parts first (so "ACTIVA 7G" puts "ACTIVA 7G STD" before "ACTIVA 6G"), then in the portal's own order.
 */
function similarModelNames(state, wanted) {
  const words = modelWords(wanted);
  if (!words.length) return [];
  const tokens = modelTokens(wanted);
  return realOptions(state)
    .map((o, i) => {
      const own = modelTokens(o.text);
      return { text: o.text, i, like: words.some((w) => own.includes(w)), shared: tokens.filter((w) => own.includes(w)).length };
    })
    .filter((x) => x.like)
    .sort((a, b) => b.shared - a.shared || a.i - b.i)
    .map((x) => x.text);
}

/** A name inside an operator sentence: no colon (beautifyError keeps only what follows the last one). */
const say = (name) => String(name == null ? "" : name).replace(/:/g, " -");
/** "A", "B", "C" - at most LIST_MAX, then "and N more". */
const listOf = (names) => {
  const shown = names.slice(0, LIST_MAX).map((n) => `"${say(n)}"`).join(", ");
  return names.length > LIST_MAX ? `${shown} and ${names.length - LIST_MAX} more` : shown;
};

/**
 * A list the portal fills by itself (the Vehicle Manufacturer after the Vehicle Class, the Make after the manufacturer):
 * read until it has a real choice, at most LIST_WAIT_MS. Returns the last read - null when the box was never on the page,
 * a list with no real choice when it stayed empty.
 */
async function waitForList(driver, selectId, o = {}) {
  const { now, sleep } = { now: o.now || Date.now, sleep: o.sleep || ((d, ms) => d.sleep(ms)) };
  const deadline = now() + LIST_WAIT_MS;
  for (;;) {
    throwIfHeld(driver);
    const state = await driver.executeScript(readSelectInPage, selectId).catch(() => null);
    if (state && realOptions(state).length) return state;
    if (now() >= deadline) return state;
    await sleep(driver, 250);
  }
}

/**
 * Vehicle Manufacturer = the row's MAKE, then Make = the row's MODEL (the owner's correction, 2026-11-06), both exact.
 * @returns {Promise<{ manufacturer: string, make: string }>}
 */
async function chooseManufacturerAndMake(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const stage = "united-india-risk";
  const manufacturerWanted = nameKey(data.vehicleMake);
  const makeWanted = nameKey(data.vehicleModel);

  // Vehicle Manufacturer: its list is filled after the Vehicle Class (populateManufacturer) - waited for, so a list that
  // has not arrived yet is never reported as "has no HONDA" (that stop is not retried).
  const manufacturers = await waitForList(driver, MANUFACTURER_ID, o);
  if (!manufacturers) {
    throw new MultiCompanyError(
      "E301",
      `United India - the "Vehicle Manufacturer" box is not on the Risk Details page (not visible after ${LIST_WAIT_MS / 1000} seconds), so the run stopped there. It will try again shortly.`,
      { company: "united india", stage }
    );
  }
  if (!realOptions(manufacturers).length) {
    throw new MultiCompanyError(
      "E301",
      `United India - the Vehicle Manufacturer list stayed empty after the Vehicle Class was chosen (${LIST_WAIT_MS / 1000} seconds), so the run stopped there. It will try again shortly.`,
      { company: "united india", stage }
    );
  }
  const hit = exactOption(manufacturers, manufacturerWanted);
  if (!hit) {
    const like = similarNames(manufacturers, manufacturerWanted);
    throw stateProblem(
      `United India - Vehicle Manufacturer has no "${say(manufacturerWanted)}" (the Make of this vehicle in the Make and Model master), so the run stopped there. ` +
        (like.length ? `Names like it that United India offers are ${listOf(like)}. ` : "United India offers no name like it. ") +
        "Correct the Make of the United India Make and Model row, then run the policy again."
    );
  }
  const manufacturer = await selectAndConfirm(
    driver,
    { label: "Vehicle Manufacturer", selectId: MANUFACTURER_ID, wanted: hit.text, stage },
    { ...o, log }
  );
  await waitForLoader(driver, "united india", { stage }); // retrieveURL() loads the Make list

  // Make: its list is filled by retrieveURL() - wait for it (a slow portal gets 20 s), then the row's MODEL, exact
  const makes = await waitForList(driver, MAKE_ID, o);
  if (!makes) {
    throw new MultiCompanyError("E301", 'United India - the "Make" box is not on the Risk Details page, so the run stopped there. It will try again shortly.', {
      company: "united india",
      stage,
    });
  }
  if (!realOptions(makes).length) {
    throw new MultiCompanyError(
      "E301",
      `United India - the Make list stayed empty after the Vehicle Manufacturer "${manufacturer.text}" was chosen (20 seconds), so the run stopped there. It will try again shortly.`,
      { company: "united india", stage }
    );
  }
  const makeHit = exactOption(makes, makeWanted);
  if (!makeHit) {
    // Only names like it (HONDA has well over a hundred), and the whole list only when it is short.
    const all = realOptions(makes).map((x) => x.text);
    const like = similarModelNames(makes, makeWanted);
    const offers = like.length
      ? `Names like it that United India offers for "${say(manufacturer.text)}" are ${listOf(like)}. `
      : all.length <= LIST_MAX
        ? `United India offers ${listOf(all)}. `
        : `None of the ${all.length} names United India offers for "${say(manufacturer.text)}" is like it. `;
    throw stateProblem(
      `United India - the Make list for "${say(manufacturer.text)}" has no "${say(makeWanted)}" (the Model of this vehicle in the Make and Model master), so the run stopped there. ` +
        offers +
        "Correct the Model of the United India Make and Model row, then run the policy again."
    );
  }
  const make = await selectAndConfirm(driver, { label: "Make", selectId: MAKE_ID, wanted: makeHit.text, stage }, { ...o, log });
  await waitForLoader(driver, "united india", { stage }); // policyURL(); FunctionChange()
  log(`✅ United India - Vehicle Manufacturer "${manufacturer.text}" (our Make) and Make "${make.text}" (our Model) chosen`);
  return { manufacturer: manufacturer.text, make: make.text };
}

/** "Tamil Nadu" / "tamilnadu" / "PONDICHERRY U.T." -> "tamilnadu" / "pondicherry": letters only, the "U.T." ending dropped. */
const stateKey = (text) =>
  String(text == null ? "" : text)
    .toLowerCase()
    .replace(/\bu\.?\s*t\.?\s*$/, "")
    .replace(/&/g, "and")
    .replace(/[^a-z]/g, "");

/** Other spellings of the same state -> United India's spelling (its list says PONDICHERRY, CHATTISGARH, ODISHA ...). */
const ALIASES = {
  puducherry: "pondicherry",
  chhattisgarh: "chattisgarh",
  orissa: "odisha",
  uttaranchal: "uttarakhand",
  jammukashmir: "jammuandkashmir",
  andamannicobar: "andamanandnicobarislands",
  andamanandnicobar: "andamanandnicobarislands",
  newdelhi: "delhi",
  nctofdelhi: "delhi",
};

/**
 * The option of United India's state list for the customer's state, or null.
 * @param {Array<{value,text}>} options  the <select id="regst"> options
 * @param {string} customerState         the Online Policy's state ("tamilnadu", "Tamil Nadu" ...)
 */
function stateOptionFor(options, customerState) {
  const want = stateKey(customerState);
  if (!want) return null;
  const key = ALIASES[want] || want;
  const usable = (options || []).filter((o) => o && o.value !== "" && String(o.value).toLowerCase() !== "select" && !o.disabled);
  return usable.find((o) => stateKey(o.text) === key) || null;
}

/** The plain sentence for a state the policy lacks or United India does not list (not retried: a person must fix it). */
const stateProblem = (message) => new MultiCompanyError("E306", message, { company: "united india", stage: "united-india-risk", retryable: false });

/** The New Vehicle box: { exists, checked, disabled }. */
const newVehicleBox = (driver) =>
  driver
    .executeScript(
      "var c = document.getElementById('newvehchk1') || document.getElementsByName('ynNewVehicle')[0];" +
        "return c ? { exists: true, checked: !!c.checked, disabled: !!c.disabled } : { exists: false };"
    )
    .catch(() => ({ exists: false }));

/** The policy's value for a box, trimmed and upper-cased (the page upper-cases what is typed), or "". */
const idOf = (value) => String(value == null ? "" : value).trim().toUpperCase();

/**
 * The whole first block of Risk Details: Vehicle Class, Vehicle Registration State, New Vehicle, Chassis and Engine Number.
 * Every value the policy must give (state, chassis, engine) is checked BEFORE the page is touched.
 * @returns {Promise<{ vehicleClass, state, chassisNumber, engineNumber }>}
 */
async function fillRiskDetails(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const stage = "united-india-risk";
  const chassisNumber = idOf(data.chassisNumber);
  const engineNumber = idOf(data.engineNumber);
  const missing = [
    !String(data.customerState || "").trim() && "State/Union Territory",
    !chassisNumber && "Chassis Number",
    !engineNumber && "Engine Number",
    !nameKey(data.vehicleModel) && "vehicle Model",
    !nameKey(data.vehicleMake) && "vehicle Make",
  ].filter(Boolean);
  if (missing.length > 1 || (missing.length === 1 && missing[0] !== "State/Union Territory")) {
    throw stateProblem(
      `United India - the policy has no ${missing.join(", ")}, so the Risk Details cannot be filled and the run stopped there. ` +
        "Enter it on the policy, then run it again."
    );
  }

  const first = await fillVehicleClassAndState(driver, data, { ...o, log });

  // New Vehicle: ticked (never clicked when it is ticked already - a second click would untick it)
  const before = await newVehicleBox(driver);
  if (before.exists && before.disabled && !before.checked) {
    throw stateProblem(
      'United India - the "New Vehicle" box is disabled on the Risk Details page, so it could not be ticked and the run stopped there. ' +
        "Check the Business Type on the page."
    );
  }
  await clickAndConfirm(
    driver,
    {
      label: "New Vehicle",
      target: NEW_VEHICLE,
      done: async () => (await newVehicleBox(driver)).checked === true,
      effect: "it is ticked",
      missing: "it is not ticked",
      stage,
      effectMs: 3000,
    },
    { ...o, log }
  );
  await waitForLoader(driver, "united india", { stage }); // getRegState() may ask the server

  // The tick runs getRegState(): the customer's state must still be the one chosen
  const regst = await driver.executeScript(readSelectInPage, REG_STATE_ID).catch(() => null);
  const nowState = regst && regst.options[regst.selectedIndex];
  let state = first.state;
  if (regst && (!nowState || nowState.text !== first.state)) {
    log(`↻ United India - ticking New Vehicle changed the Vehicle Registration State to "${(nowState && nowState.text) || ""}" - choosing "${first.state}" again`);
    const again = await selectAndConfirm(driver, { label: "Vehicle Registration State", selectId: REG_STATE_ID, wanted: first.state, stage }, { ...o, log });
    await waitForLoader(driver, "united india", { stage });
    state = again.text;
  }

  await fillAndConfirm(driver, { label: "Chassis Number", target: CHASSIS, value: chassisNumber, stage }, { ...o, log });
  await fillAndConfirm(driver, { label: "Engine Number", target: ENGINE, value: engineNumber, stage }, { ...o, log });
  log(`✅ United India - New Vehicle ticked, Chassis Number ${chassisNumber} and Engine Number ${engineNumber} entered`);
  const vehicle = await chooseManufacturerAndMake(driver, data, { ...o, log });
  return { vehicleClass: first.vehicleClass, state, chassisNumber, engineNumber, ...vehicle };
}

/**
 * @param {WebDriver} driver  on the Risk Details page
 * @param {Object} data       the job data (customerState from the policy, see lib/partRunner.js)
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ vehicleClass: string, state: string }>}
 */
async function fillVehicleClassAndState(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const stage = "united-india-risk";

  // The customer's state is decided BEFORE anything on the page is touched: a policy without one stops here.
  const customerState = String(data.customerState || "").trim();
  if (!customerState) {
    throw stateProblem(
      "United India - the customer's State/Union Territory is empty on the policy, so the Vehicle Registration State cannot be chosen and the run stopped there. Enter the state in the policy's customer details, then run it again."
    );
  }

  log("📝 United India - Risk Details page");
  // the page itself: its Vehicle Class box must be there (a slow page gets the time a page load takes)
  if (!(await waitForShown(driver, [By.id(VEHICLE_CLASS_ID)], 20000, o))) {
    throw new MultiCompanyError(
      "E301",
      'United India - the Risk Details page did not show its "Vehicle Class" box (not visible after 20 seconds), so the run stopped there. It will try again shortly.',
      { company: "united india", stage }
    );
  }

  const vehicleClass = await selectAndConfirm(driver, { label: "Vehicle Class", selectId: VEHICLE_CLASS_ID, wanted: VEHICLE_CLASS, stage }, { ...o, log });
  await waitForLoader(driver, "united india", { stage }); // populateManufacturer() loads the manufacturers

  const box = await driver.executeScript(readSelectInPage, REG_STATE_ID).catch(() => null);
  const option = box ? stateOptionFor(box.options, customerState) : null;
  if (box && !option) {
    throw stateProblem(
      `United India - the customer's state "${customerState}" is not in United India's Vehicle Registration State list, so the run stopped there. ` +
        "Check the state in the policy's customer details, then run it again."
    );
  }
  // (no box at all: selectAndConfirm says it is not on the page)
  const state = await selectAndConfirm(
    driver,
    { label: "Vehicle Registration State", selectId: REG_STATE_ID, wanted: option ? option.value : customerState, stage },
    { ...o, log }
  );
  await waitForLoader(driver, "united india", { stage }); // getRegNoRta() loads the RTAs
  log(`✅ United India - Vehicle Class "${vehicleClass.text}" and Vehicle Registration State "${state.text}" (customer's state "${customerState}") chosen`);
  return { vehicleClass: vehicleClass.text, state: state.text };
}

module.exports = {
  fillRiskDetails,
  fillVehicleClassAndState,
  chooseManufacturerAndMake,
  stateOptionFor,
  stateKey,
  exactOption,
  similarNames,
  similarModelNames,
  waitForList,
  LIST_MAX,
  LIST_WAIT_MS,
  VEHICLE_CLASS,
  VEHICLE_CLASS_ID,
  REG_STATE_ID,
  NEW_VEHICLE,
  CHASSIS,
  ENGINE,
  MANUFACTURER_ID,
  MAKE_ID,
};
