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
const { kshemaAddressLine } = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaAddress.js"));

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
  assert.deepEqual(address([null, undefined, "", " ", ",", ""]), { line: "", left: [] });
  assert.deepEqual(kshemaAddressLine({}), { line: "", left: [] });
  // the older field names still count
  assert.equal(kshemaAddressLine({ blockNameNo: "B4", locality: "ANNA NAGAR" }).line, "B4 ANNA NAGAR");
});

test("both KSHEMA quote forms (full and TP only) type this line, not the old comma join", () => {
  for (const file of [
    path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
    path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
  ]) {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /kshemaAddress"\)\.kshemaAddressLine\(data\)/, path.basename(file));
    assert.equal(src.includes('addressParts.join(", ")'), false, path.basename(file));
    assert.match(src, /await field\.sendKeys\(fullAddress\);/, path.basename(file));
  }
});
