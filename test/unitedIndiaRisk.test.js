// United India Risk Details (2026-11-06): Vehicle Class = "Motorcycle / Scooter", Vehicle Registration State = the customer's
// state on the policy. A fake page shaped like the owner's markup; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaRisk.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const risk = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaRisk");
const { readSelectInPage, setSelectByScriptInPage } = require("../lib/realSelect");

const VEHICLE_CLASSES = [
  ["0", "select"], ["26", "(E-Cart)-Private Carriers"], ["25", "(E-Cart)-Public Carriers"], ["24", "E-Rickshaw"],
  ["22", "Goods Carrying (3-wh and Pedal Cycles)-Private Carriers"], ["21", "Goods Carrying (3-wh and Pedal Cycles)-Public Carriers"],
  ["19", "Goods Carrying(Other than 3-wh)-Public Carriers"], ["12", "Miscellaneous And Special Type of Vehicles"],
  ["3", "Motorcycle / Scooter"], ["23", "Pass Carrying - 2-wh"], ["16", "Pass Carrying - 3-wh (7 <= Carrying <18)"],
  ["8", "Pass Carrying - 3-wh (Carrying <=6)"], ["11", "Pass Carrying - 4-wh (Carrying  > 6), 3-wh (Carrying >18)"],
  ["9", "Pass Carrying - 4-wh (Carrying <=6)"], ["18", "Private Car"],
];
// The owner's <select id="regst"> list.
const STATES = [
  ["select", "Select"], ["90", "ANDAMAN AND NICOBAR ISLANDS"], ["40", "ANDHRA PRADESH"], ["30", "ARUNACHAL PRADESH"], ["31", "ASSAM"],
  ["32", "BIHAR"], ["91", "CHANDIGARH U.T."], ["20", "CHATTISGARH"], ["92", "DADRA AND NAGAR HAVELI"], ["93", "DAMAN AND DIU"],
  ["10", "DELHI"], ["21", "GOA"], ["22", "GUJARAT"], ["11", "HARYANA"], ["12", "HIMACHAL PRADESH"], ["13", "JAMMU AND KASHMIR"],
  ["71", "JHARKHAND"], ["41", "KARNATAKA"], ["42", "KERALA"], ["101", "LADAKH"], ["94", "LAKSHADWEEP U.T."], ["23", "MADHYA PRADESH"],
  ["24", "MAHARASHTRA"], ["33", "MANIPUR"], ["34", "MEGHALAYA"], ["35", "MIZORAM"], ["36", "NAGALAND"], ["37", "ODISHA"],
  ["99", "OUTSIDE INDIA"], ["95", "PONDICHERRY U.T."], ["14", "PUNJAB"], ["15", "RAJASTHAN"], ["70", "SIKKIM"], ["43", "TAMIL NADU"],
  ["100", "TELANGANA"], ["38", "TRIPURA"], ["16", "UTTAR PRADESH"], ["17", "UTTARAKHAND"], ["39", "WEST BENGAL"],
];
const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));
// A slice of the owner's Vehicle Manufacturer list: the exact name next to its duplicates.
const MANUFACTURERS = [
  ["0", "select"], ["IBB4566@BAJAJ", "BAJAJ"], ["3725@BAJAJ AUTO LTD_NONGICOUNCIL", "BAJAJ AUTO LTD_NONGICOUNCIL"],
  ["IBB4568@HERO", "HERO"], ["IBB4560@HONDA", "HONDA"], ["7943@HONDA MOTOR CO., JAPAN_NONGICOUNCIL", "HONDA MOTOR CO., JAPAN_NONGICOUNCIL"],
  ["3724@HONDA MOTORCYCLE & SCOOTER INDIA PVT LTD_NONGICOUNCIL", "HONDA MOTORCYCLE & SCOOTER INDIA PVT LTD_NONGICOUNCIL"],
  ["3710@HONDA_NONGICOUNCIL", "HONDA_NONGICOUNCIL"], ["IBB4999@TVS", "TVS"],
];
// What retrieveURL() would load into the Make list for each manufacturer value.
const MAKES = {
  "IBB4560@HONDA": [["0", "select"], ["11", "ACTIVA 6G"], ["12", "ACTIVA 125"], ["13", "DIO"]],
  "3710@HONDA_NONGICOUNCIL": [["0", "select"], ["91", "OLD ACTIVA"]],
  "IBB4568@HERO": [["0", "select"], ["21", "SPLENDOR PLUS"]],
};

test("every state the Online Policy offers maps to United India's list (by its own spelling)", () => {
  const options = opts(STATES);
  const expect = {
    tamilnadu: "TAMIL NADU",
    pondicherry: "PONDICHERRY U.T.",
    karnataka: "KARNATAKA",
    kerala: "KERALA",
    maharashtra: "MAHARASHTRA",
    delhi: "DELHI",
    gujarat: "GUJARAT",
    rajasthan: "RAJASTHAN",
    westbengal: "WEST BENGAL",
    andhrapradesh: "ANDHRA PRADESH",
    telangana: "TELANGANA",
  };
  for (const [stored, text] of Object.entries(expect)) assert.equal(risk.stateOptionFor(options, stored).text, text, stored);
});

test("other spellings: case, spaces, Puducherry, Chhattisgarh, Orissa, Uttaranchal, New Delhi", () => {
  const options = opts(STATES);
  for (const [given, text] of [
    ["Tamil Nadu", "TAMIL NADU"], ["TAMILNADU", "TAMIL NADU"], [" tamil nadu ", "TAMIL NADU"], ["Puducherry", "PONDICHERRY U.T."],
    ["Chhattisgarh", "CHATTISGARH"], ["Orissa", "ODISHA"], ["Uttaranchal", "UTTARAKHAND"], ["New Delhi", "DELHI"],
    ["Jammu & Kashmir", "JAMMU AND KASHMIR"], ["Chandigarh", "CHANDIGARH U.T."],
  ]) {
    assert.equal(risk.stateOptionFor(options, given).text, text, given);
  }
});

test("no match is null - never the placeholder, never a guess", () => {
  const options = opts(STATES);
  for (const given of ["", null, "Select", "Atlantis", "Tamil", "Nadu"]) assert.equal(risk.stateOptionFor(options, given), null, String(given));
});

/* --------------------------------------------- the page --------------------------------------------- */

function riskPage(over = {}) {
  const boxes = {
    v_make: { options: opts(VEHICLE_CLASSES), selectedIndex: 0, shown: over.noVehicleClass !== true, changes: 0 },
    regst: { options: opts(over.states || STATES), selectedIndex: 0, shown: true, changes: 0 },
    selectedNumNameCode: {
      options: opts(over.manufacturersNeverLoad ? [["0", "select"]] : MANUFACTURERS),
      selectedIndex: 0,
      shown: over.noManufacturerBox !== true,
      changes: 0,
    },
    makeMotorDisplay: { options: opts([["0", "select"]]), selectedIndex: 0, shown: over.noMakeBox !== true, changes: 0 },
  };
  // retrieveURL(): the manufacturer's choice fills the Make list (unless the portal never answers)
  const onChange = (id) => {
    if (id !== "selectedNumNameCode" || over.makesNeverLoad) return;
    const value = boxes.selectedNumNameCode.options[boxes.selectedNumNameCode.selectedIndex].value;
    boxes.makeMotorDisplay.options = opts((over.makes && over.makes[value]) || MAKES[value] || [["0", "select"]]);
    boxes.makeMotorDisplay.selectedIndex = 0;
  };
  const state = {
    boxes,
    loaderPolls: 0,
    newVehicle: { checked: !!over.newVehicleTicked, disabled: !!over.newVehicleDisabled, clicks: 0, ignoreClicks: over.ignoreTickClicks || 0 },
    inputs: { chasisNumber: "", engineNumber: "" },
    resetStateOnTick: !!over.resetStateOnTick,
    makesLateReads: over.makesLateReads || 0,
    manufacturersLateReads: over.manufacturersLateReads || 0,
  };
  // the page upper-cases what is typed (onkeyup="toupper(...)")
  const input = (id) => ({
    name: id,
    async isDisplayed() {
      return true;
    },
    async clear() {
      state.inputs[id] = "";
    },
    async sendKeys(v) {
      state.inputs[id] = (state.inputs[id] + v).toUpperCase();
    },
    async getAttribute(a) {
      return a === "value" ? state.inputs[id] : null;
    },
  });
  const checkbox = {
    async isDisplayed() {
      return true;
    },
    async click() {
      state.newVehicle.clicks += 1;
      if (state.newVehicle.ignoreClicks > 0) {
        state.newVehicle.ignoreClicks -= 1;
        return;
      }
      state.newVehicle.checked = !state.newVehicle.checked; // a checkbox TOGGLES
      if (state.resetStateOnTick) boxes.regst.selectedIndex = 0; // getRegState() put the state back to Select
    },
  };
  const optionEl = (id, i) => ({
    async click() {
      boxes[id].selectedIndex = i;
      boxes[id].changes += 1; // the box's onchange (populateManufacturer / getRegNoRta / retrieveURL)
      onChange(id);
    },
  });
  const box = (id) => ({
    async isDisplayed() {
      return boxes[id].shown;
    },
    async click() {},
    async findElements() {
      return boxes[id].options.map((_, i) => optionEl(id, i));
    },
  });
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      if (v.includes('"v_make"') && boxes.v_make.shown) return [box("v_make")];
      if (v.includes('"regst"')) return [box("regst")];
      if (v.includes('"selectedNumNameCode"') && boxes.selectedNumNameCode.shown) return [box("selectedNumNameCode")];
      if (v.includes('"makeMotorDisplay"') && boxes.makeMotorDisplay.shown) return [box("makeMotorDisplay")];
      if (v === "#newvehchk1") return [checkbox];
      if (v === "#chasisNumber") return [input("chasisNumber")];
      if (v === "#engineNumber") return [input("engineNumber")];
      return [];
    },
    async executeScript(script, ...args) {
      if (script === readSelectInPage) {
        // populateManufacturer() answers late: the Vehicle Manufacturer list looks empty for the first reads
        if (args[0] === "selectedNumNameCode" && state.manufacturersLateReads > 0) {
          state.manufacturersLateReads -= 1;
          return { selectedIndex: 0, value: "0", options: [{ value: "0", text: "select", disabled: false }] };
        }
        // retrieveURL() answers late: the Make list looks empty for the first `makesLateReads` reads after the choice
        if (args[0] === "makeMotorDisplay" && state.makesLateReads > 0 && boxes.selectedNumNameCode.selectedIndex > 0) {
          state.makesLateReads -= 1;
          return { selectedIndex: 0, value: "0", options: [{ value: "0", text: "select", disabled: false }] };
        }
        const b = boxes[args[0]];
        return b && b.shown ? { selectedIndex: b.selectedIndex, value: b.options[b.selectedIndex].value, options: b.options } : null;
      }
      if (script === setSelectByScriptInPage) {
        const b = boxes[args[0]];
        b.selectedIndex = b.options.findIndex((o) => o.value === args[1]);
        onChange(args[0]);
        return true;
      }
      const s = String(script);
      if (s.includes("getElementById('newvehchk1')")) return { exists: true, checked: state.newVehicle.checked, disabled: state.newVehicle.disabled };
      if (s.includes("HTMLInputElement.prototype")) {
        state.inputs[args[0].name] = String(args[1]).toUpperCase();
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      if (s.includes("sr-only")) {
        state.loaderPolls += 1;
        return false;
      }
      return null;
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const go = (driver, data) => {
  const lines = [];
  return { lines, run: () => risk.fillVehicleClassAndState(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};

test("Vehicle Class = Motorcycle / Scooter (3) and Vehicle Registration State = the customer's state (Tamil Nadu = 43)", async () => {
  const driver = riskPage();
  const { lines, run } = go(driver, { customerState: "tamilnadu", state: "30" });
  const out = await run();
  assert.deepEqual(out, { vehicleClass: "Motorcycle / Scooter", state: "TAMIL NADU" });
  const { v_make, regst } = driver.state.boxes;
  assert.equal(v_make.options[v_make.selectedIndex].value, "3");
  assert.equal(regst.options[regst.selectedIndex].value, "43");
  assert.equal(v_make.changes, 1, "chosen like a person: the box's onchange ran");
  assert.ok(driver.state.loaderPolls >= 2, "the loader is waited for after each box (their onchange loads the next lists)");
  assert.ok(lines.some((l) => /✅ United India - Vehicle Class "Motorcycle \/ Scooter" and Vehicle Registration State "TAMIL NADU" \(customer's state "tamilnadu"\) chosen/.test(l)));
});

test("Pondicherry customer -> PONDICHERRY U.T. (95)", async () => {
  const driver = riskPage();
  await go(driver, { customerState: "pondicherry" }).run();
  const { regst } = driver.state.boxes;
  assert.equal(regst.options[regst.selectedIndex].value, "95");
});

test("no state on the policy: stops BEFORE touching the page, not retried, says what to fix", async () => {
  const driver = riskPage();
  await assert.rejects(go(driver, { state: "30" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the customer's State\/Union Territory is empty on the policy/);
    return true;
  });
  assert.equal(driver.state.boxes.v_make.changes, 0);
});

test("a state United India does not list: [E306], not retried, naming it", async () => {
  const driver = riskPage({ states: [["select", "Select"], ["43", "TAMIL NADU"]] });
  await assert.rejects(go(driver, { customerState: "karnataka" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the customer's state "karnataka" is not in United India's Vehicle Registration State list/);
    return true;
  });
});

test("no Vehicle Class box: the Risk Details page did not show it - [E301]", async () => {
  const driver = riskPage({ noVehicleClass: true });
  await assert.rejects(go(driver, { customerState: "tamilnadu" }).run(), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /the Risk Details page did not show its "Vehicle Class" box \(not visible after 20 seconds\)/);
    return true;
  });
});

test("the owner's markup is what it looks for", () => {
  assert.equal(risk.VEHICLE_CLASS, "Motorcycle / Scooter");
  assert.equal(risk.VEHICLE_CLASS_ID, "v_make");
  assert.equal(risk.REG_STATE_ID, "regst");
});

/* --------------------------------------------- New Vehicle, chassis, engine --------------------------------------------- */

// The owner's correction (2026-11-06): Vehicle Manufacturer = the row's MAKE, the portal's Make = the row's MODEL.
const POLICY = { customerState: "tamilnadu", chassisNumber: "md626dg56s2h08322", engineNumber: " FG5HS2808545 ", vehicleMake: "honda", vehicleModel: "Activa  6G" };

const all = (driver, data = POLICY) => {
  const lines = [];
  return { lines, run: () => risk.fillRiskDetails(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};

test("New Vehicle ticked ONCE, then the policy's Chassis and Engine Number typed and read back (upper case)", async () => {
  const driver = riskPage();
  const { lines, run } = all(driver);
  const out = await run();
  assert.equal(driver.state.newVehicle.checked, true);
  assert.equal(driver.state.newVehicle.clicks, 1);
  assert.equal(driver.state.inputs.chasisNumber, "MD626DG56S2H08322");
  assert.equal(driver.state.inputs.engineNumber, "FG5HS2808545");
  assert.deepEqual(out, {
    vehicleClass: "Motorcycle / Scooter",
    state: "TAMIL NADU",
    chassisNumber: "MD626DG56S2H08322",
    engineNumber: "FG5HS2808545",
    manufacturer: "HONDA",
    make: "ACTIVA 6G",
  });
  assert.ok(lines.some((l) => /✓ United India - "New Vehicle" clicked - it is ticked/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - Chassis Number = "MD626DG56S2H08322"/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - Engine Number = "FG5HS2808545"/.test(l)));
});

test("New Vehicle already ticked: NOT clicked (a second click would untick it)", async () => {
  const driver = riskPage({ newVehicleTicked: true });
  await all(driver).run();
  assert.equal(driver.state.newVehicle.clicks, 0);
  assert.equal(driver.state.newVehicle.checked, true);
});

test("a tick the page ignored is clicked once more", async () => {
  const driver = riskPage({ ignoreTickClicks: 1 });
  const { lines, run } = all(driver);
  await run();
  assert.equal(driver.state.newVehicle.clicks, 2);
  assert.equal(driver.state.newVehicle.checked, true);
  assert.ok(lines.some((l) => /↻ United India - "New Vehicle" was clicked but it is not ticked - clicking it once more/.test(l)));
});

test("a disabled New Vehicle box stops with a plain sentence, not retried, nothing typed", async () => {
  const driver = riskPage({ newVehicleDisabled: true });
  await assert.rejects(all(driver).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the "New Vehicle" box is disabled on the Risk Details page/);
    return true;
  });
  assert.equal(driver.state.inputs.chasisNumber, "");
});

test("the tick resets the Registration State (getRegState): the customer's state is chosen again", async () => {
  const driver = riskPage({ resetStateOnTick: true });
  const { lines, run } = all(driver);
  const out = await run();
  const { regst } = driver.state.boxes;
  assert.equal(regst.options[regst.selectedIndex].value, "43");
  assert.equal(out.state, "TAMIL NADU");
  assert.ok(lines.some((l) => /↻ United India - ticking New Vehicle changed the Vehicle Registration State to "Select" - choosing "TAMIL NADU" again/.test(l)));
});

test("no chassis or engine number on the policy: stops BEFORE the page is touched, naming what is missing", async () => {
  const driver = riskPage();
  await assert.rejects(all(driver, { ...POLICY, chassisNumber: "", engineNumber: "" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the policy has no Chassis Number, Engine Number, so the Risk Details cannot be filled/);
    return true;
  });
  assert.equal(driver.state.boxes.v_make.changes, 0, "nothing on the page was touched");
});

test("the handler's Risk Details step is the whole block (class, state, New Vehicle, chassis, engine)", () => {
  const src = require("fs").readFileSync(require.resolve("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP.js"), "utf8");
  assert.match(src, /fillRisk = fillRiskDetails[,}]/);
  assert.match(src, /await fillRisk\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await fillDates\(ctx\.driver, \{ log: ctx\.log \}\);\n\s+await answerQuestions\(ctx\.driver, \{ log: ctx\.log \}\);\n\s+await fillInsured\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await fillPin\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await fillContact\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await chooseRto\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await openMore\(ctx\.driver, \{ log: ctx\.log \}\);\n\s+await fillTppd\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await fillPa\(ctx\.driver, ctx\.data, \{ log: ctx\.log \}\);\n\s+await compute\(ctx\.driver, \{ log: ctx\.log \}\);\n[\s\S]*let kept = await quote\(ctx\.driver, ctx\.data, \{ \.\.\.files, where: "after Compute Premium" \}\);\n\s+const made = \(await proposal\(ctx\.driver, ctx\.data, \{ log: ctx\.log, jobId: ctx\.jobId \}\)\) \|\| \{\};\n\s+if \(!kept\) kept = await quote\(ctx\.driver, ctx\.data, \{ \.\.\.files, where: "after Update" \}\);/, "... the Quote and Worksheet where their button is (before Update, else after), and Update = the proposal");
  assert.match(src, /const \{ fillRiskDetails \} = require\("\.\/unitedIndiaRisk"\);/);
});

/* --------------------------------------------- Vehicle Manufacturer + Make --------------------------------------------- */

const selected = (driver, id) => {
  const b = driver.state.boxes[id];
  return b.options[b.selectedIndex];
};

test("Vehicle Manufacturer = the row's MAKE, exactly ('HONDA', never HONDA_NONGICOUNCIL); the portal's Make = the row's MODEL from the list it loads", async () => {
  const driver = riskPage();
  const { lines, run } = all(driver);
  await run();
  assert.equal(selected(driver, "selectedNumNameCode").value, "IBB4560@HONDA");
  assert.equal(selected(driver, "makeMotorDisplay").value, "11");
  assert.ok(lines.some((l) => /✅ United India - Vehicle Manufacturer "HONDA" \(our Make\) and Make "ACTIVA 6G" \(our Model\) chosen/.test(l)));
});

test("an exact manufacturer that only exists as _NONGICOUNCIL is still taken exactly", async () => {
  const driver = riskPage();
  await all(driver, { ...POLICY, vehicleMake: "HONDA_NONGICOUNCIL", vehicleModel: "OLD ACTIVA" }).run();
  assert.equal(selected(driver, "selectedNumNameCode").value, "3710@HONDA_NONGICOUNCIL");
  assert.equal(selected(driver, "makeMotorDisplay").value, "91");
});

test("no exact manufacturer: stops, not retried, naming similar names United India offers - nothing chosen", async () => {
  const driver = riskPage();
  await assert.rejects(all(driver, { ...POLICY, vehicleMake: "HONDA MOTORS" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /Vehicle Manufacturer has no "HONDA MOTORS" \(the Make of this vehicle in the Make and Model master\)/);
    assert.match(e.message, /Names like it that United India offers are "HONDA", "HONDA MOTOR CO\., JAPAN_NONGICOUNCIL"/);
    assert.match(e.message, /"HONDA_NONGICOUNCIL"/);
    assert.match(e.message, /Correct the Make of the United India Make and Model row/);
    return true;
  });
  assert.equal(selected(driver, "selectedNumNameCode").value, "0");
});

test("no exact Make in the list it loaded: stops, not retried, naming only the names LIKE it (not DIO)", async () => {
  const driver = riskPage();
  await assert.rejects(all(driver, { ...POLICY, vehicleModel: "ACTIVA" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the Make list for "HONDA" has no "ACTIVA" \(the Model of this vehicle in the Make and Model master\)/);
    assert.match(e.message, /Correct the Model of the United India Make and Model row/);
    assert.match(e.message, /Names like it that United India offers for "HONDA" are "ACTIVA 6G", "ACTIVA 125"\. /);
    assert.doesNotMatch(e.message, /DIO/);
    return true;
  });
  assert.equal(selected(driver, "makeMotorDisplay").value, "0", "a near name is never taken");
});

test("no Make like it in a SHORT list: the whole list is named (it is short enough to read)", async () => {
  const driver = riskPage();
  await assert.rejects(all(driver, { ...POLICY, vehicleModel: "SHINE" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.match(e.message, /United India offers "ACTIVA 6G", "ACTIVA 125", "DIO"\. Correct the Model/);
    return true;
  });
});

// HONDA's real Make list is long: 40 names here, 20 of them ACTIVA ones, in the portal's own order.
const LONG_HONDA = [["0", "select"]]
  .concat(Array.from({ length: 20 }, (_, i) => [`a${i}`, `ACTIVA ${100 + i} FI(2019 - 2023)@ALLOY BS VI`]))
  .concat(Array.from({ length: 19 }, (_, i) => [`s${i}`, `SHINE ${i}`]))
  .concat([["x", "ACTIVA 7G STD"]]);

test("a long Make list: at most 15 names like it, the closest first, then 'and N more'", async () => {
  const driver = riskPage({ makes: { "IBB4560@HONDA": LONG_HONDA } });
  await assert.rejects(all(driver, { ...POLICY, vehicleModel: "ACTIVA 7G" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    // ACTIVA 7G STD shares ACTIVA and 7G - it comes first although it is last on the page; then the portal's order
    assert.match(e.message, /are "ACTIVA 7G STD", "ACTIVA 100 FI\(2019 - 2023\)@ALLOY BS VI", "ACTIVA 101/);
    assert.match(e.message, / and 6 more\. Correct the Model/);
    const named = /are (.*) and 6 more/.exec(e.message)[1];
    assert.equal((named.match(/"ACTIVA /g) || []).length, 15, "15 names, not 21");
    assert.doesNotMatch(e.message, /SHINE/);
    return true;
  });
});

test("a long Make list with nothing like it: says so with the count, lists none", async () => {
  const driver = riskPage({ makes: { "IBB4560@HONDA": LONG_HONDA } });
  await assert.rejects(all(driver, { ...POLICY, vehicleModel: "DIO" }).run(), (e) => {
    assert.match(e.message, /has no "DIO" .*None of the 40 names United India offers for "HONDA" is like it\. Correct the Model/);
    return true;
  });
});

test("the closest Make names come first; a name is 'like' only by a 3+ letter word", () => {
  const state = { options: opts([["0", "select"], ["1", "CB SHINE"], ["2", "SHINE SP 125"], ["3", "CB UNICORN"], ["4", "CB SHINE SP"], ["5", "DREAM BS VI"]]) };
  // CB SHINE SP shares CB + SHINE + SP; CB SHINE and SHINE SP 125 share two (portal order between them); CB UNICORN only "CB"
  assert.deepEqual(risk.similarModelNames(state, "CB SHINE SP 125"), ["CB SHINE SP", "CB SHINE", "SHINE SP 125"]);
  assert.deepEqual(risk.similarModelNames(state, "125"), [], "a number alone is like nothing");
  assert.deepEqual(risk.similarModelNames(state, "ACTIVA BS VI"), [], "sharing only BS / VI is not like it");
});

test("the Vehicle Manufacturer list that arrives late (populateManufacturer) is waited for - never 'has no HONDA'", async () => {
  const driver = riskPage({ manufacturersLateReads: 6 });
  await all(driver).run();
  assert.equal(driver.state.manufacturersLateReads, 0);
  assert.equal(selected(driver, "selectedNumNameCode").value, "IBB4560@HONDA");
});

test("the Vehicle Manufacturer list never loads: [E301] tried again later, NOT the 'has no HONDA' stop", async () => {
  const driver = riskPage({ manufacturersNeverLoad: true });
  await assert.rejects(all(driver).run(), (e) => {
    assert.equal(e.code, "E301");
    assert.notEqual(e.retryable, false);
    assert.match(e.message, /the Vehicle Manufacturer list stayed empty after the Vehicle Class was chosen \(20 seconds\)/);
    assert.doesNotMatch(e.message, /has no/);
    return true;
  });
});

test("no Vehicle Manufacturer box at all: [E301] naming it", async () => {
  const driver = riskPage({ noManufacturerBox: true });
  await assert.rejects(all(driver).run(), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /the "Vehicle Manufacturer" box is not on the Risk Details page \(not visible after 20 seconds\)/);
    return true;
  });
});

test("a long manufacturer list of names like it is cut at 15 too", async () => {
  const many = [["0", "select"]].concat(Array.from({ length: 18 }, (_, i) => [`h${i}`, `HONDA UNIT ${i}_NONGICOUNCIL`]));
  const driver = riskPage();
  driver.state.boxes.selectedNumNameCode.options = opts(many);
  await assert.rejects(all(driver, { ...POLICY, vehicleMake: "HONDA" }).run(), (e) => {
    assert.equal(e.code, "E306");
    assert.match(e.message, /Vehicle Manufacturer has no "HONDA"/);
    assert.match(e.message, / and 3 more\. Correct the Make/);
    return true;
  });
});

test("a name with a colon never breaks the sentence (beautifyError keeps only what follows the last colon)", async () => {
  const driver = riskPage();
  await assert.rejects(all(driver, { ...POLICY, vehicleModel: "ACTIVA: 7G" }).run(), (e) => {
    assert.doesNotMatch(e.message, /:/);
    assert.match(e.message, /has no "ACTIVA - 7G"/);
    return true;
  });
});

test("the Make list never loads after the manufacturer: [E301] after 20 seconds, naming the manufacturer", async () => {
  const driver = riskPage({ makesNeverLoad: true });
  await assert.rejects(all(driver).run(), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /the Make list stayed empty after the Vehicle Manufacturer "HONDA" was chosen \(20 seconds\)/);
    return true;
  });
});

test("no Make box at all: [E301]", async () => {
  const driver = riskPage({ noMakeBox: true });
  await assert.rejects(all(driver).run(), (e) => e.code === "E301" && /the "Make" box is not on the Risk Details page/.test(e.message));
});

test("a policy without the vehicle's Model or Make stops before the page is touched", async () => {
  const driver = riskPage();
  await assert.rejects(all(driver, { ...POLICY, vehicleModel: "", vehicleMake: "" }).run(), (e) => {
    assert.match(e.message, /the policy has no vehicle Model, vehicle Make/);
    return true;
  });
  assert.equal(driver.state.boxes.v_make.changes, 0);
});

test("the Make list that arrives late (retrieveURL answering after a few seconds) is waited for, then the Make chosen", async () => {
  const driver = riskPage({ makesLateReads: 6 });
  await all(driver).run();
  assert.equal(driver.state.makesLateReads, 0);
  assert.equal(selected(driver, "makeMotorDisplay").value, "11");
});
