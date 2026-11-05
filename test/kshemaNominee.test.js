// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaNominee.test.js
//
// KSHEMA's Nominee Relationship (the owner, 2026-11-05): the portal now has Spouse, Common Law, Policyholder, Mother,
// Father, Son, Daughter, Other. A policy saved with the old "Child" / "Parent" stops at the nominee step with a plain
// sentence (his choice) - before, the option was "not found", logged, and the run went on with no relation chosen. A
// relation the list does not have stops the same way. The full flow and the TP copy alike.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const kn = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaNominee.js"));

test("KSHEMA's list now, in its order", () => {
  assert.deepEqual(kn.KSHEMA_RELATIONS, ["spouse", "common law", "policyholder", "mother", "father", "son", "daughter", "other"]);
});

test("the old Child / Parent: a sentence that says what to choose instead (no colon); everything else passes this check", () => {
  assert.equal(
    kn.oldRelationProblem("child"),
    'KSHEMA no longer has "Child" as a Nominee Relationship. Edit the policy, choose Son or Daughter, then run it again.'
  );
  assert.equal(
    kn.oldRelationProblem("  PARENT "),
    'KSHEMA no longer has "Parent" as a Nominee Relationship. Edit the policy, choose Mother or Father, then run it again.'
  );
  for (const r of kn.KSHEMA_RELATIONS) assert.equal(kn.oldRelationProblem(r), null, r);
  assert.equal(kn.oldRelationProblem(""), null);
  assert.equal(kn.oldRelationProblem("child").includes(":"), false);
});

test("a relation KSHEMA's list does not have: its own sentence (no colon)", () => {
  const s = kn.notOfferedProblem("legal heir");
  assert.equal(s, 'KSHEMA\'s Nominee Relationship list has no "Legal Heir". Edit the policy, choose one of KSHEMA\'s relations, then run it again.');
  assert.equal(s.includes(":"), false);
});

test("both quote forms stop on an old choice BEFORE opening the dropdown, and on a missing option instead of going on", () => {
  for (const file of [
    path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
    path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
  ]) {
    const src = fs.readFileSync(file, "utf8");
    const name = path.basename(file);
    const oldAt = src.indexOf(".oldRelationProblem(nomineeRelation)");
    const openAt = src.indexOf('clickElement(driver, relSelect[0], "Nominee Relationship dropdown")');
    assert.ok(oldAt > 0 && openAt > oldAt, `${name}: the old-choice check comes before the dropdown is opened`);
    assert.match(src, /if \(oldChoice\) \{\n\s+err\(`   ✗ Nominee Relationship - \$\{oldChoice\}`\);\n\s+return \{ ok: false, error: oldChoice \};/, name);
    assert.match(src, /const notOffered = require\("[^"]*kshemaNominee"\)\.notOfferedProblem\(nomineeRelation\);\n\s+err\(`   ✗ Nominee Relationship - \$\{notOffered\}`\);\n\s+return \{ ok: false, error: notOffered \};/, name);
    assert.equal(src.includes('Nominee Relationship option "${nomineeRelation}" not found'), false, `${name}: no more "not found, carry on"`);
  }
});
