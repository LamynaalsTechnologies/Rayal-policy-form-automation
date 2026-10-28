// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaLocalityCandidates.test.js
//
// KSHEMA's "Pin code Locality" is ONE post office, picked from what the policy's address holds. Since 2026-10-28 the
// frontend's Aadhaar read puts the village / district into the EMPTY Block and Premises boxes instead of Area, so the
// pick tries those two after every Area candidate. Same in the full flow and the TP-only copy. No browser: only the
// field's candidate list is read.
const test = require("node:test");
const assert = require("node:assert/strict");

const FLOWS = {
  full: require("../fullPolicycompany/kshema/kshemaQuoteForm"),
  "TP only": require("../multiCompany/tpCompany/kshemaTP/kshemaTPQuoteForm"),
};

for (const [flow, form] of Object.entries(FLOWS)) {
  const locality = form.CUSTOMER_FIELDS.find((f) => f.key === "locality");
  const candidates = (data) => locality.value(data);

  test(`${flow}: an old policy's Area gives exactly the candidates it did before`, () => {
    assert.deepEqual(candidates({ areaAndLocality: "ANDUR, PONBEITHY, KARAIKAL" }), [
      "KARAIKAL",
      "PONBEITHY",
      "ANDUR",
      "ANDUR, PONBEITHY, KARAIKAL",
    ]);
    assert.deepEqual(candidates({ areaAndLocality: "ANNA NAGAR" }), ["ANNA NAGAR"]);
    assert.deepEqual(candidates({}), []);
  });

  test(`${flow}: Block, then Name of Premises, come AFTER every Area candidate`, () => {
    assert.deepEqual(
      candidates({ areaAndLocality: "KEEZHAPALUR", blockName: "ARIYALUR", buildingName: "NEAR BUS STAND" }),
      ["KEEZHAPALUR", "ARIYALUR", "NEAR BUS STAND"]
    );
    // The automation's own names for the same boxes (server.js maps both).
    assert.deepEqual(candidates({ areaAndLocality: "KEEZHAPALUR", blockNo: "ARIYALUR", premisesName: "PERIYAR NAGAR" }), [
      "KEEZHAPALUR",
      "ARIYALUR",
      "PERIYAR NAGAR",
    ]);
  });

  test(`${flow}: a Block / Premises with fewer than 3 letters is never tried, and nothing is tried twice`, () => {
    assert.deepEqual(candidates({ areaAndLocality: "ANNA NAGAR", blockName: "A", buildingName: "B-2" }), ["ANNA NAGAR"]);
    assert.deepEqual(candidates({ areaAndLocality: "ANNA NAGAR", blockName: "12/4", buildingName: "anna nagar" }), [
      "ANNA NAGAR",
    ]);
  });
}
