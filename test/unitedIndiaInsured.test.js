// United India Risk Details, the insured (the owner, 2026-11-13): Client Type Individual (not touched), High Risk No,
// Title from the policy, Insured Name = Full Name, Address = one line with no special characters. A fake page shaped like
// the owner's markup; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaInsured.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const insured = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaInsured");
const { readSelectInPage, setSelectByScriptInPage } = require("../lib/realSelect");

const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));
const CLIENT_TYPES = [["select", "Select"], ["1", "Individual"], ["4", "Partnership Firm"], ["5", "Sole Proprietors"], ["2", "Corporate"], ["3", "Govt Under Taking"]];
const HIGH_RISK = [["", "Select"], ["Yes", "Yes"], ["No", "No"]];
const TITLES = [["MR.", "Mr"], ["MISS.", "Miss"], ["MRS.", "Mrs"], ["MS.", "Ms"]];

const POLICY = {
  proposerTitle: "Mrs.",
  gender: "female",
  firstName: "LAKSHMI DEVI",
  lastName: "K",
  flatDoorNo: "#272/A",
  floorNo: "1ST FLOOR",
  buildingName: "RAMANA APTS.",
  roadStreetLane: "PILLAYAR KOVIL ST., 2ND CROSS",
  areaAndLocality: "TONDUR, VILLUPPURAM - 604203",
};
const LINE = "272 A 1ST FLOOR RAMANA APTS PILLAYAR KOVIL ST 2ND CROSS TONDUR VILLUPPURAM 604203";

/* ------------------------------------------------ the policy's values ------------------------------------------------ */

test("Address: the boxes in one line, every comma / dot / # / slash / dash a space, single spaces, upper case", () => {
  assert.deepEqual(insured.insuredAddress(POLICY), { line: LINE, left: [], cut: false });
  const odd = insured.insuredAddress({ flatDoorNo: "NO.5", buildingName: "sri_lakshmi (H/O) @ home", roadStreetLane: "M.G. ROAD; NEAR BUS-STAND", areaAndLocality: "T.NAGAR & CO" });
  assert.equal(odd.line, "NO 5 SRI LAKSHMI H O HOME M G ROAD NEAR BUS STAND T NAGAR CO");
  assert.match(odd.line, /^[A-Z0-9]+( [A-Z0-9]+)*$/, "letters, numbers and single spaces only");
});

test("Address: a name written twice (an Aadhaar read fills several boxes) is left out, and said", () => {
  const a = insured.insuredAddress({ flatDoorNo: "12", buildingName: "EGANIVAYAL", blockName: "PUDUKOTTAI", areaAndLocality: "EGANIVAYAL, PUDUKOTTAI DIST" });
  assert.equal(a.line, "12 EGANIVAYAL PUDUKOTTAI");
  assert.deepEqual(a.left, ["EGANIVAYAL", "PUDUKOTTAI DIST"]);
});

test("Address: at most 200 characters, cut between words AFTER the cleaning", () => {
  const long = insured.insuredAddress({ flatDoorNo: "1", buildingName: Array.from({ length: 40 }, (_, i) => `PLACE${String.fromCharCode(65 + (i % 26))}${i}`).join(", ") });
  assert.ok(long.line.length <= 200, `${long.line.length}`);
  assert.equal(long.cut, true);
  assert.match(long.line, /[A-Z0-9]$/, "never a half word or a trailing space");
  // 202 characters as typed, 121 once the special characters are gone: not cut (the cut is measured after the cleaning)
  const fits = insured.insuredAddress({ flatDoorNo: "1", buildingName: "AB.;:".repeat(40) });
  assert.equal(fits.cut, false);
  assert.equal(fits.line.length, 121);
});

test("Insured Name = the Full Name only (not the Surname), letters and spaces only", () => {
  assert.deepEqual(insured.insuredName({ firstName: "ANMOL ARORA", lastName: "MASTER" }), { name: "ANMOL ARORA", cleaned: false });
  assert.deepEqual(insured.insuredName({ firstName: "k. ramesh" }), { name: "K RAMESH", cleaned: true });
  assert.deepEqual(insured.insuredName({ firstName: "  " }), { name: "", cleaned: false });
});

test("Title: the policy's Mr. / Ms. / Mrs. -> United India's MR. / MS. / MRS.; none -> from the gender; M/S stops", () => {
  assert.deepEqual(insured.titleFor({ proposerTitle: "Mr." }), { ours: "Mr.", value: "MR." });
  assert.deepEqual(insured.titleFor({ proposerTitle: "ms" }), { ours: "Ms.", value: "MS." });
  assert.deepEqual(insured.titleFor({ proposerTitle: "MRS" }), { ours: "Mrs.", value: "MRS." });
  assert.deepEqual(insured.titleFor({ proposerTitle: "", gender: "female" }), { ours: "Ms.", value: "MS." });
  assert.deepEqual(insured.titleFor({ gender: "male" }), { ours: "Mr.", value: "MR." });
  assert.match(insured.titleFor({ proposerTitle: "M/S" }).error, /"M\/S" \(a company\) - United India needs Client Type Corporate/);
  assert.match(insured.titleFor({}).error, /no Title/);
});

test("Client Type: Individual today - clientTypeFor is the one place Corporate will be decided", () => {
  assert.equal(insured.clientTypeFor(POLICY), "Individual");
  assert.equal(insured.clientTypeFor({ proposerTitle: "M/S" }), "Individual");
});

/* ------------------------------------------------ the page ------------------------------------------------ */

/**
 * @param {Object} over
 *   clientType: the index the portal shows (default 1 = Individual)
 *   hide: box ids not on the page
 *   alertOn: { <select id>: text } - choosing in that box opens a popup (chromedriver reports it on the next command)
 *   nameAlert: typing the name opens a popup
 *   dropAddress: how many address entries the page drops
 *   titleResetsHighRisk: the Title's setthevalue() puts High Risk back to Select
 *   lateAlertOn: { <select id or input id>: text } - a popup that opens and STAYS open (no command has met it yet)
 */
function page(over = {}) {
  const boxes = {
    clientType: { options: opts(CLIENT_TYPES), selectedIndex: over.clientType === undefined ? 1 : over.clientType, changes: 0 },
    ynHighRisk: { options: opts(HIGH_RISK), selectedIndex: 0, changes: 0 },
    insuredname1: { options: opts(TITLES), selectedIndex: 0, changes: 0 },
  };
  const state = { boxes, inputs: { insuredname2: "", addressOfInsured: "" }, typed: { insuredname2: 0, addressOfInsured: 0 }, dropAddress: over.dropAddress || 0, alerts: [] };
  const late = (id) => {
    if (over.lateAlertOn && over.lateAlertOn[id]) state.alerts.push(over.lateAlertOn[id]);
  };
  const hidden = (id) => (over.hide || []).includes(id);
  const alertError = (text) => Object.assign(new Error(`unexpected alert open: {Alert text : ${text}}`), { name: "UnexpectedAlertOpenError" });
  const changed = (id) => {
    boxes[id].changes += 1;
    if (id === "insuredname1" && over.titleResetsHighRisk) boxes.ynHighRisk.selectedIndex = 0;
  };
  const setInput = (id, v) => {
    if (id === "addressOfInsured" && state.dropAddress > 0) {
      state.dropAddress -= 1;
      return;
    }
    state.inputs[id] = v;
  };
  const select = (id) => ({
    async isDisplayed() {
      return !hidden(id);
    },
    async click() {},
    async findElements() {
      return boxes[id].options.map((_, i) => ({
        async click() {
          boxes[id].selectedIndex = i;
          changed(id);
          late(id);
          if (over.alertOn && over.alertOn[id]) throw alertError(over.alertOn[id]);
        },
      }));
    },
  });
  const input = (id) => ({
    id,
    async isDisplayed() {
      return !hidden(id);
    },
    async clear() {
      state.inputs[id] = "";
    },
    async sendKeys(v) {
      state.typed[id] += 1;
      if (id === "insuredname2" && over.nameAlert) throw alertError(over.nameAlert);
      setInput(id, state.inputs[id] + v);
      late(id);
    },
    async getAttribute(a) {
      return a === "value" ? state.inputs[id] : null;
    },
  });
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      for (const id of ["clientType", "ynHighRisk", "insuredname1"]) if (v.includes(`"${id}"`)) return hidden(id) ? [] : [select(id)];
      for (const id of ["insuredname2", "addressOfInsured"]) if (v.includes(id)) return [input(id)];
      return [];
    },
    async executeScript(script, ...args) {
      if (script === readSelectInPage) {
        const b = boxes[args[0]];
        return b && !hidden(args[0]) ? { selectedIndex: b.selectedIndex, value: b.options[b.selectedIndex].value, options: b.options } : null;
      }
      if (script === setSelectByScriptInPage) {
        const b = boxes[args[0]];
        b.selectedIndex = b.options.findIndex((o) => o.value === args[1]);
        changed(args[0]);
        return true;
      }
      if (script === insured.readInsuredInPage) {
        const v = (id) => boxes[id].options[boxes[id].selectedIndex].value;
        return { clientType: v("clientType"), highRisk: v("ynHighRisk"), title: v("insuredname1"), name: state.inputs.insuredname2, address: state.inputs.addressOfInsured };
      }
      const s = String(script);
      if (s.includes("HTMLInputElement.prototype")) {
        setInput(args[0].id, String(args[1]));
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      if (s.includes("sr-only")) return false;
      return null;
    },
    switchTo() {
      return {
        alert: async () => {
          if (!state.alerts.length) throw new Error("no such alert");
          const text = state.alerts.shift();
          return { getText: async () => text, accept: async () => {} };
        },
      };
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const run = (driver, data = POLICY) => {
  const lines = [];
  return { lines, go: () => insured.fillInsuredDetails(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};
const shows = (driver, id) => driver.state.boxes[id].options[driver.state.boxes[id].selectedIndex].value;

test("the whole block: Client Type left as Individual, High Risk No, Title MRS., Full Name, the cleaned Address", async () => {
  const driver = page();
  const { lines, go } = run(driver);
  const out = await go();
  assert.deepEqual(out, { clientType: "Individual", highRisk: "No", title: "MRS.", name: "LAKSHMI DEVI", address: LINE });
  assert.equal(driver.state.boxes.clientType.changes, 0, "Client Type NOT touched (the owner)");
  assert.equal(shows(driver, "ynHighRisk"), "No");
  assert.equal(shows(driver, "insuredname1"), "MRS.");
  assert.equal(driver.state.inputs.insuredname2, "LAKSHMI DEVI", "no Surname added");
  assert.equal(driver.state.inputs.addressOfInsured, LINE);
  assert.ok(lines.some((l) => /✓ United India - Client Type already shows "Individual"/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - High Risk = "No"/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - Title = "Mrs"/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - Client Type Individual, High Risk No, Title Mrs, Insured Name and Address entered/.test(l)));
});

test("a Title the portal already shows (Mr, its first option) is not touched", async () => {
  const driver = page();
  await run(driver, { ...POLICY, proposerTitle: "Mr." }).go();
  assert.equal(driver.state.boxes.insuredname1.changes, 0);
});

test("a portal showing another Client Type: Individual is chosen", async () => {
  const driver = page({ clientType: 4 });
  const { lines, go } = run(driver);
  await go();
  assert.equal(shows(driver, "clientType"), "1");
  assert.ok(lines.some((l) => /✓ United India - Client Type = "Individual"/.test(l)));
});

test("M/S on the policy: stops BEFORE the page is touched, not retried, saying Corporate is not built yet", async () => {
  const driver = page();
  await assert.rejects(run(driver, { ...POLICY, proposerTitle: "M/S" }).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /Title is "M\/S" \(a company\) - United India needs Client Type Corporate for it, which is not built yet/);
    return true;
  });
  assert.equal(driver.state.boxes.ynHighRisk.changes, 0);
  assert.equal(driver.state.inputs.insuredname2, "");
});

test("no Full Name and no address: one sentence naming both, nothing touched", async () => {
  const driver = page();
  await assert.rejects(run(driver, { proposerTitle: "Mr.", firstName: "", flatDoorNo: "", buildingName: "" }).go(), (e) => {
    assert.equal(e.retryable, false);
    assert.match(e.message, /the policy has no Full Name, and the policy has no address/);
    return true;
  });
  assert.equal(driver.state.boxes.ynHighRisk.changes, 0);
});

test("High Risk's onchange answers with a popup: [E308] in the portal's words, not retried, the Title not touched", async () => {
  const driver = page({ alertOn: { ynHighRisk: "Please upload the high risk declaration" } });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E308");
    assert.equal(e.retryable, false);
    assert.match(e.message, /after "High Risk" the portal said "Please upload the high risk declaration"/);
    return true;
  });
  assert.equal(driver.state.boxes.ynHighRisk.changes, 1, "chosen once, not a second time");
  assert.equal(driver.state.boxes.insuredname1.changes, 0);
});

test("typing the name answers with a popup: [E308] in its words (never swallowed into 'holds X instead of Y')", async () => {
  const driver = page({ nameAlert: "Dot is not allowed" });
  await assert.rejects(run(driver).go(), (e) => e.code === "E308" && /after "Insured Name" the portal said "Dot is not allowed"/.test(e.message));
  assert.equal(driver.state.typed.insuredname2, 1);
  assert.equal(driver.state.inputs.addressOfInsured, "");
});

test("a popup that opened after the choice and is still open is found and reported: [E308]", async () => {
  const driver = page({ lateAlertOn: { insuredname1: "Gender does not match the Title" } });
  await assert.rejects(run(driver).go(), (e) => e.code === "E308" && /after "Title" the portal said "Gender does not match the Title"/.test(e.message));
  assert.equal(driver.state.inputs.insuredname2, "", "the name was not typed after it");
});

test("a popup still open after typing is found and reported: [E308]", async () => {
  const driver = page({ lateAlertOn: { addressOfInsured: "Address should not contain special characters" } });
  await assert.rejects(run(driver).go(), (e) => e.code === "E308" && /after "Address" the portal said "Address should not contain special characters"/.test(e.message));
});

test("an address the page dropped is typed ONE more time", async () => {
  const driver = page({ dropAddress: 2 }); // the keys and the setter of the first try
  const { lines, go } = run(driver);
  await go();
  assert.equal(driver.state.inputs.addressOfInsured, LINE);
  assert.ok(lines.some((l) => /↻ United India - Address reads "" instead of "272 A/.test(l)));
});

test("the Title's setthevalue() putting High Risk back is caught by the last read-back: [E306] naming it", async () => {
  const driver = page({ titleResetsHighRisk: true });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.match(e.message, /after the insured's details were entered High Risk reads "" instead of "No"/);
    return true;
  });
});

test("no Address box: [E301] naming it", async () => {
  const driver = page({ hide: ["addressOfInsured"] });
  await assert.rejects(run(driver).go(), (e) => e.code === "E301" && /"Address" is not on the page/.test(e.message));
});

test("the address and name log lines say what was cleaned or left out", async () => {
  const driver = page();
  const { lines, go } = run(driver, { ...POLICY, firstName: "k. ramesh", buildingName: "EGANIVAYAL", areaAndLocality: "EGANIVAYAL" });
  await go();
  assert.ok(lines.some((l) => /Insured Name "k\. ramesh" typed as "K RAMESH"/.test(l)));
  assert.ok(lines.some((l) => /Address: left out as written already - "EGANIVAYAL"/.test(l)));
});

test("the owner's markup is what it looks for", () => {
  assert.equal(insured.CLIENT_TYPE.selectId, "clientType");
  assert.equal(insured.HIGH_RISK.selectId, "ynHighRisk");
  assert.equal(insured.HIGH_RISK.answer, "No");
  assert.equal(insured.TITLE.selectId, "insuredname1");
  assert.equal(insured.NAME.target[0], "#insuredname2");
  assert.equal(insured.ADDRESS.target[0], "#addressOfInsured");
  assert.equal(insured.MAX_LENGTH, 200);
});
