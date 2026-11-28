"use strict";

// The nominee Brisk gets (owner, 2026-11-28) on the automation's own Brisk call (briskCertificate.js, used when
// BRISK_V2_AUTOMATION_ENABLED is off): the SAME rule as the server and the Online Policy form (lib/briskNominee.js).
// Before: an empty relation went as "Son", every Spouse as "Wife", the customer's gender as the nominee's, an empty name as
// "FERNANDO". No browser, no network (Brisk's lists and wallet are stubbed; the create request itself is blocked):
// node --require ./test/support/noRealWorld.js --test test/briskNominee.test.js
process.env.BRISK_V2_AUTOMATION_ENABLED = "false";
const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { matchBriskNominee, briskNomineeOf } = require("../lib/briskNominee");
const { createBriskCertificate } = require("../briskCertificate");

const m = (nomineeName, nomineeRelation, customerGender) => matchBriskNominee({ nomineeName, nomineeRelation, customerGender });

test("the rule: the same cases as the server's and the form's tests", () => {
  assert.deepEqual(m("swesh", "SPOUSE", "female"), { name: "SWESH", gender: "male", relation: "husband", matched: true, why: "" });
  assert.deepEqual(m("Lakshmi", "spouse", "male"), { name: "LAKSHMI", gender: "female", relation: "wife", matched: true, why: "" });
  assert.match(m("X", "Spouse", "").why, /^the nominee's or the customer's gender is needed to tell Husband from Wife$/);
  // the nominee's own gender first (Reliance asks it), then the customer's
  assert.equal(matchBriskNominee({ nomineeName: "deva", nomineeRelation: "Spouse", nomineeGender: "male", customerGender: "" }).relation, "husband");
  assert.equal(matchBriskNominee({ nomineeName: "deva", nomineeRelation: "Spouse", nomineeGender: "female", customerGender: "female" }).relation, "wife");
  assert.equal(m("A", "Dad", "female").relation, "father");
  assert.equal(m("A", "Common Law", "female").why, 'Brisk has no relation like "Common Law"');
  assert.equal(m("A", "", "male").why, "the policy has no nominee relation");
  assert.equal(m("", "son", "male").why, "the policy has no nominee name");
  const picked = briskNomineeOf({ nomineeName: "swesh", nomineeRelation: "spouse", gender: "female", briskNomineeName: "Ravi", briskNomineeGender: "MALE", briskNomineeRelation: "Brother" });
  assert.deepEqual(picked, { name: "RAVI", gender: "male", relation: "brother", matched: true, why: "", saved: true });
});

/** Runs createBriskCertificate with Brisk's lists and wallet stubbed; returns { error, payload, gets }. */
async function runCreate(data) {
  const gets = [];
  const logged = [];
  const originalGet = axios.get;
  const originalLog = console.log;
  axios.get = async (url) => {
    gets.push(String(url));
    if (/MakeList/i.test(url)) return { data: { data: ["HONDA"] } };
    if (/ModelList/i.test(url)) return { data: { data: ["DIO"] } };
    if (/Wallet/i.test(url)) return { data: { data: { balance: 50000 } } };
    return { data: { data: [] } };
  };
  console.log = (...a) => logged.push(a.join(" "));
  let error = null;
  try {
    await createBriskCertificate(data);
  } catch (e) {
    error = e;
  } finally {
    axios.get = originalGet;
    console.log = originalLog;
  }
  const line = logged.find((l) => l.includes("Sending Brisk Certificate request with payload"));
  const payload = line ? JSON.parse(line.slice(line.indexOf("{"))) : null;
  return { error, payload, gets };
}

const MERY = {
  fullName: "MERY",
  surname: "S",
  gender: "female",
  nomineeName: "SWESH",
  nomineeRelation: "SPOUSE",
  nomineeGender: "",
  vehicleMake: "HONDA",
  vehicleModel: "DIO",
  paCoverAmount: 1100,
  _jobIdentifier: "job-1",
};

test("MERY's case: a woman's Spouse goes as Husband / Male (it went as Wife / Female), her own gender stays Female", async () => {
  const { payload } = await runCreate(MERY);
  assert.ok(payload, "the request was built");
  assert.equal(payload.NomineeName, "SWESH");
  assert.equal(payload.Relation, "Husband");
  assert.equal(payload.NomineeGender, "Male");
  assert.equal(payload.CustomerGender, "Female");
});

test("the Brisk Nominee saved with the policy is sent exactly", async () => {
  const { payload } = await runCreate({ ...MERY, briskNomineeName: "RAVI", briskNomineeGender: "male", briskNomineeRelation: "father", briskNomineeSource: "HAND" });
  assert.deepEqual([payload.NomineeName, payload.Relation, payload.NomineeGender], ["RAVI", "Father", "Male"]);
});

test("a nominee that cannot be worked out stops before any Brisk call - no 'Son', no 'FERNANDO'", async () => {
  for (const data of [{ ...MERY, nomineeRelation: "Common Law" }, { ...MERY, nomineeRelation: "" }, { ...MERY, nomineeName: "" }]) {
    const { error, payload, gets } = await runCreate(data);
    assert.ok(error, "refused");
    assert.match(error.message, /^The Brisk nominee could not be worked out \(.+\)\. Edit the policy and choose the Brisk Nominee$/);
    assert.equal(payload, null, "no request built");
    assert.deepEqual(gets, [], "Brisk was not asked anything (not even the wallet)");
  }
});
