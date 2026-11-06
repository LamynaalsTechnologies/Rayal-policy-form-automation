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
 *   "HONDA" and "HONDA_NONGICOUNCIL" side by side, and only the exact one is taken. No exact name: the run stops and its
 *   sentence lists what United India offers (similar names for the manufacturer, the whole list for the Make), not
 *   retried - the Make & Model row has to be corrected. (The Make & Model dialog offers United India's own names from the
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

/** Up to 15 manufacturer names like `wanted` ("HONDA" -> HONDA_NONGICOUNCIL, HONDA MOTORCYCLE ...), for the stop sentence. */
function similarNames(state, wanted) {
  const key = nameKey(wanted);
  const base = (t) => nameKey(t).replace(/(_NONGICOUNCIL)+$/, "");
  const words = key.split(" ").filter((w) => w.length >= 3);
  return realOptions(state)
    .map((o) => o.text)
    .filter((t) => {
      const b = base(t);
      return b.includes(key) || key.includes(b) || words.some((w) => b.split(/[ _]/).includes(w));
    })
    .slice(0, 15);
}

const listOf = (names) => names.map((n) => `"${String(n).replace(/:/g, " -")}"`).join(", ");

/**
 * Vehicle Manufacturer = the row's MAKE, then Make = the row's MODEL (the owner's correction, 2026-11-06), both exact.
 * @returns {Promise<{ manufacturer: string, make: string }>}
 */
async function chooseManufacturerAndMake(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const stage = "united-india-risk";
  const { now, sleep } = { now: o.now || Date.now, sleep: o.sleep || ((d, ms) => d.sleep(ms)) };
  const manufacturerWanted = nameKey(data.vehicleMake);
  const makeWanted = nameKey(data.vehicleModel);

  // Vehicle Manufacturer
  // (no list at all: selectAndConfirm below says the box is not on the page)
  const manufacturers = await driver.executeScript(readSelectInPage, MANUFACTURER_ID).catch(() => null);
  const hit = manufacturers ? exactOption(manufacturers, manufacturerWanted) : null;
  if (manufacturers && !hit) {
    const like = similarNames(manufacturers, manufacturerWanted);
    throw stateProblem(
      `United India - Vehicle Manufacturer has no "${manufacturerWanted}" (the Make of this vehicle in the Make and Model master), so the run stopped there. ` +
        (like.length ? `Names like it that United India offers are ${listOf(like)}. ` : "United India offers no name like it. ") +
        "Correct the Make of the United India Make and Model row, then run the policy again."
    );
  }
  const manufacturer = await selectAndConfirm(
    driver,
    { label: "Vehicle Manufacturer", selectId: MANUFACTURER_ID, wanted: hit ? hit.text : manufacturerWanted, stage },
    { ...o, log }
  );
  await waitForLoader(driver, "united india", { stage }); // retrieveURL() loads the Make list

  // Make: its list is filled by retrieveURL() - wait for it (a slow portal gets 20 s), then the row's MAKE, exact
  const deadline = now() + 20000;
  let makes = null;
  for (;;) {
    makes = await driver.executeScript(readSelectInPage, MAKE_ID).catch(() => null);
    if (makes && realOptions(makes).length) break;
    if (now() >= deadline) break;
    await sleep(driver, 250);
  }
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
    throw stateProblem(
      `United India - the Make list for "${manufacturer.text}" has no "${makeWanted}" (the Model of this vehicle in the Make and Model master), so the run stopped there. ` +
        `United India offers ${listOf(realOptions(makes).map((x) => x.text))}. Correct the Model of the United India Make and Model row, then run the policy again.`
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
  VEHICLE_CLASS,
  VEHICLE_CLASS_ID,
  REG_STATE_ID,
  NEW_VEHICLE,
  CHASSIS,
  ENGINE,
  MANUFACTURER_ID,
  MAKE_ID,
};
