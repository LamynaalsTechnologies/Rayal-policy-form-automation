// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaAddress.test.js
//
// KSHEMA's one Address line (owner, 2026-11-05): no commas (a space instead), a word already written is not written
// again, at most 100 characters cut between words. The live line that started it:
//   "# 272, FLOOR, RAMANA, JALANDHAR, ARANTHANGI TK,PUDUKOTTAI DISC,EGANIVAYAL POST, BASTI PEER DAD,ARANT"
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { kshemaAddressLine, kshemaPrintedPlaces } = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaAddress.js"));

const address = (boxes) =>
  kshemaAddressLine({
    flatDoorNo: boxes[0],
    floorNo: boxes[1],
    buildingName: boxes[2],
    blockName: boxes[3],
    roadStreetLane: boxes[4],
    areaAndLocality: boxes[5],
  });

test("the owner's line: no commas, the repeated ARANTHANGI TK and PUDUKOTTAI DIST written once, no half word at the end", () => {
  const r = address([
    "# 272",
    "FLOOR",
    "RAMANA",
    "JALANDHAR",
    "ARANTHANGI TK,PUDUKOTTAI DISC,EGANIVAYAL POST",
    "BASTI PEER DAD,ARANTHANGI TK,PUDUKOTTAI DIST",
  ]);
  assert.equal(r.line, "# 272 FLOOR RAMANA JALANDHAR ARANTHANGI TK PUDUKOTTAI DISC EGANIVAYAL POST BASTI PEER DAD");
  assert.deepEqual(r.left, ["ARANTHANGI TK", "PUDUKOTTAI DIST"]);
  assert.equal(r.line.includes(","), false);
});

test("an Aadhaar read: the district put into Block and kept in Area is written once", () => {
  const r = address(["2/120", "", "NEAR BUS STAND", "ARIYALUR", "PILLAIYAR KOVIL STREET", "KEEZHAPALUR, ARIYALUR"]);
  assert.equal(r.line, "2/120 NEAR BUS STAND ARIYALUR PILLAIYAR KOVIL STREET KEEZHAPALUR");
  assert.deepEqual(r.left, ["ARIYALUR"]);
});

test("a name repeated inside a longer piece: only the name goes, the rest of the piece stays", () => {
  const r = address(["12", "", "", "PUDUKOTTAI", "PUDUKOTTAI MAIN ROAD", ""]);
  assert.equal(r.line, "12 PUDUKOTTAI MAIN ROAD");
  assert.deepEqual(r.left, ["PUDUKOTTAI"]);
});

test("numbers and small address words may repeat: 2ND STREET and 3RD STREET both stay; a whole repeated piece does not", () => {
  const r = address(["5", "1", "", "", "2ND STREET, MAIN ROAD", "3RD STREET, MAIN ROAD, NO 5"]);
  assert.equal(r.line, "5 1 2ND STREET MAIN ROAD 3RD STREET NO 5");
  assert.deepEqual(r.left, ["MAIN ROAD"]);
});

test("case, dots and spacing do not hide a repeat; commas with no space and empty pieces are fine", () => {
  const r = address(["", "", "Pudukottai.", "", "  ARANTHANGI ,, pudukottai  dist ,", "ARANTHANGI"]);
  assert.equal(r.line, "Pudukottai. ARANTHANGI");
  assert.deepEqual(r.left, ["pudukottai dist", "ARANTHANGI"]);
});

test("at most 100 characters, cut between words", () => {
  const r = address(["", "", "", "", "ALPHAVILLE BETATOWN GAMMAPURAM DELTAPATTI EPSILONUR ZETAKOTTAI ETAMANGALAM THETANAGAR IOTAPALAYAM KAPPAKUDI", ""]);
  assert.ok(r.line.length <= 100, `${r.line.length}`);
  assert.equal(r.line, "ALPHAVILLE BETATOWN GAMMAPURAM DELTAPATTI EPSILONUR ZETAKOTTAI ETAMANGALAM THETANAGAR IOTAPALAYAM");
  const one = address(["", "", "", "", "X".repeat(130), ""]);
  assert.equal(one.line.length, 100, "one word longer than the box is cut where it must be");
});

test("nothing to write: an empty line (the step logs 'no recognised parts')", () => {
  assert.deepEqual(address([null, undefined, "", " ", ",", ""]), { line: "", left: [], cut: false, keptPrinted: false });
  assert.deepEqual(kshemaAddressLine({}), { line: "", left: [], cut: false, keptPrinted: false });
  // the older field names still count
  assert.equal(kshemaAddressLine({ blockNameNo: "B4", locality: "ANNA NAGAR" }).line, "B4 ANNA NAGAR");
});

test("both KSHEMA quote forms (full and TP only) type this line, not the old comma join", () => {
  for (const file of [
    path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
    path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
  ]) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /kshemaAddress\.kshemaAddressLine\(data, \{ printedByKshema: printed\.words \}\)/, path.basename(file));
    assert.match(src, /kshemaAddress\.kshemaPrintedPlaces\(driver, data, \{\n\s+state: stateFromPolicy\(data\),\n\s+locality: require\("[^"]*kshemaSection"\)\.filledValueOf\(driver, "locality"\),/, path.basename(file));
    assert.equal(src.includes('addressParts.join(", ")'), false, path.basename(file));
    assert.match(src, /await field\.sendKeys\(fullAddress\);/, path.basename(file));
  }
});

/* ---- what KSHEMA prints after our line itself (the owner's PDF, 2026-11-05) ---- */

test("the owner's PDF: the same name KSHEMA prints (VILLUPURAM) is left out of our line; one extra P is another name", () => {
  // the PDF: "130 PILLAYAR KOVIL STREET TONDUR VILLUPPURAM MELOLAKKUR, VILLUPURAM, TAMIL NADU, 604203,"
  const printedByKshema = ["MELOLAKKUR", "VILLUPURAM", "TAMIL NADU", "604203"];
  const same = kshemaAddressLine({ flatDoorNo: "130", roadStreetLane: "PILLAYAR KOVIL STREET", areaAndLocality: "TONDUR, VILLUPURAM" }, { printedByKshema });
  assert.equal(same.line, "130 PILLAYAR KOVIL STREET TONDUR");
  assert.deepEqual(same.left, ["VILLUPURAM"]);
  // the owner: "same ah irunthale pothum, oru P extra vantha koda athu new name than"
  const extraP = kshemaAddressLine({ flatDoorNo: "130", roadStreetLane: "PILLAYAR KOVIL STREET", areaAndLocality: "TONDUR, VILLUPPURAM" }, { printedByKshema });
  assert.equal(extraP.line, "130 PILLAYAR KOVIL STREET TONDUR VILLUPPURAM");
  assert.deepEqual(extraP.left, []);
});

test("inside our own line too only the same spelling is a repeat (PUDUKKOTTAI and PUDUKOTTAI both stay)", () => {
  const r = address(["", "", "", "PUDUKKOTTAI", "MAIN ROAD", "ARANTHANGI, PUDUKOTTAI DIST"]);
  assert.equal(r.line, "PUDUKKOTTAI MAIN ROAD ARANTHANGI PUDUKOTTAI DIST");
  assert.deepEqual(r.left, []);
});

test("KSHEMA's locality, state and pin code are left out; a different town stays; numbers that are not the pin stay", () => {
  const r = kshemaAddressLine(
    { flatDoorNo: "12/3", roadStreetLane: "GANDHI ROAD", areaAndLocality: "MELOLAKKUR, TINDIVANAM, TAMIL NADU 604203", blockName: "604001" },
    { printedByKshema: ["MELOLAKKUR", "TAMIL NADU", "604203"] }
  );
  assert.equal(r.line, "12/3 604001 GANDHI ROAD TINDIVANAM");
  assert.deepEqual(r.left, ["MELOLAKKUR", "TAMIL", "NADU", "604203"]);
  // nothing printed by KSHEMA known: the line is as before
  assert.equal(kshemaAddressLine({ areaAndLocality: "TONDUR, VILLUPPURAM" }).line, "TONDUR VILLUPPURAM");
});

test("kshemaPrintedPlaces: the state, the pin and the customer's city / district boxes; the picked locality is only reported", async () => {
  const driver = {
    executeScript: async (script) => {
      assert.match(script, /data-iid/);
      return [{ iid: "c_district", value: "VILLUPURAM" }];
    },
  };
  const r = await kshemaPrintedPlaces(driver, { pinCode: "604 203" }, { state: "TAMIL NADU", locality: "MELOLAKKUR" });
  // not proven KSHEMA prints the locality: leaving it out could lose the village from the PDF, so it stays in our line
  assert.deepEqual(r.words, ["TAMIL NADU", "604203", "VILLUPURAM"]);
  assert.equal(r.found.locality, "MELOLAKKUR");
  // a page that cannot be read still gives what is known
  const broken = await kshemaPrintedPlaces({ executeScript: async () => { throw new Error("gone"); } }, { pincode: "604203" }, { state: "TAMIL NADU" });
  assert.deepEqual(broken.words, ["TAMIL NADU", "604203"]);
});

test("the page read (run on a fake page): the customer's city / district / state only - never the RTO / vehicle / financier / nominee ones, the address box, or hidden ones", async () => {
  let script = "";
  await kshemaPrintedPlaces({ executeScript: async (s) => ((script = s), []) }, {}, {});
  const el = (iid, value, shown = true) => ({ getAttribute: () => iid, getClientRects: () => (shown ? [1] : []), value, innerText: value });
  const page = [
    el("c_city", "VILLUPURAM"),
    el("c_state", "TAMIL NADU"),
    el("rto_city", "TINDIVANAM"),
    el("vehicle_registration_state", "PUDUCHERRY"),
    el("financier_city", "CHENNAI"),
    el("nominee_state", "KERALA"),
    el("c_address_one", "130 PILLAYAR KOVIL STREET"),
    el("c_district", "HIDDEN", false),
    el("c_pincode", "604203"),
  ];
  const found = new Function("document", script)({ querySelectorAll: () => page });
  assert.deepEqual(found, [{ iid: "c_city", value: "VILLUPURAM" }, { iid: "c_state", value: "TAMIL NADU" }]);
});

test("never an empty address box: when only KSHEMA's own names (or a door number) would be left, our words are kept", () => {
  const all = kshemaAddressLine({ areaAndLocality: "VILLUPURAM, TAMIL NADU, 604203" }, { printedByKshema: ["VILLUPURAM", "TAMIL NADU", "604203"] });
  assert.equal(all.line, "VILLUPURAM TAMIL NADU 604203");
  assert.equal(all.keptPrinted, true);
  const door = kshemaAddressLine({ flatDoorNo: "130", areaAndLocality: "VILLUPURAM, TAMIL NADU" }, { printedByKshema: ["VILLUPURAM", "TAMIL NADU"] });
  assert.equal(door.line, "130 VILLUPURAM TAMIL NADU");
  assert.equal(door.keptPrinted, true);
  // a real address left: KSHEMA's names still go
  const real = kshemaAddressLine({ flatDoorNo: "130", roadStreetLane: "GANDHI ROAD", areaAndLocality: "VILLUPURAM" }, { printedByKshema: ["VILLUPURAM"] });
  assert.equal(real.line, "130 GANDHI ROAD");
  assert.equal(real.keptPrinted, false);
});

test("a line cut at 100 characters says so (for the log)", () => {
  const long = kshemaAddressLine({ roadStreetLane: "SRI VENKATESWARA NAGAR EXTENSION SECOND CROSS STREET OPPOSITE GOVERNMENT HIGHER SECONDARY SCHOOL", areaAndLocality: "KALLAKURICHI ROAD, ULUNDURPET" });
  assert.equal(long.cut, true);
  assert.ok(long.line.length <= 100);
  assert.equal(kshemaAddressLine({ areaAndLocality: "TONDUR" }).cut, false);
});

test("filledValueOf: the option a dropdown ended on, as kshemaSection remembers it", () => {
  const section = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSection.js"));
  const driver = {};
  section._filledByDriver.set(driver, new Map([["locality", { expected: "MELOLAKKUR" }]]));
  assert.equal(section.filledValueOf(driver, "locality"), "MELOLAKKUR");
  assert.equal(section.filledValueOf(driver, "pinCode"), "");
  assert.equal(section.filledValueOf({}, "locality"), "");
});
