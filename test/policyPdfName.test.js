// Run with: node --require ./test/support/noRealWorld.js --test test/policyPdfName.test.js
//
// The issued policy's PDF is saved as "<policy number>.pdf" (the owner, 2026-11-06), Reliance and KSHEMA alike - the
// file stored on the policy (relianceWalletIssue.policyFileNames, also used by kshemaWalletIssue) and the merged PDF
// with the Brisk certificate (relianceForm.js mergePDFsAndUpload, and its generated OD/TP copy). Without a number (a
// link policy not paid yet) the names stay as they were.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

for (const [name, file] of [
  ["Reliance (full)", path.join(ROOT, "fullPolicycompany", "relianceForm.js")],
  ["Reliance OD / TP copy", path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js")],
]) {
  test(`${name}: the merged PDF is "<policy number>.pdf" once the policy is issued, the old name before`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /const numberStem = policyNumberFileStem\(data\.policyNumber\);/);
    assert.match(src, /const mergedFileName = numberStem \? `\$\{numberStem\}\.pdf` : `\$\{policyId\}_merged\.pdf`;/);
    assert.match(src, /const s3Key = numberStem \? `MergedPolicies\/\$\{policyId\}\/\$\{mergedFileName\}` : `MergedPolicies\/\$\{policyId\}_merged\.pdf`;/);
    assert.equal((src.match(/fileName: mergedFileName/g) || []).length, 3, "every place the merged file is named");
    assert.equal(src.includes("fileName: `${policyId}_merged.pdf`"), false);
    // the number comes from the issue (wallet) and from the recovery of an issued policy
    assert.match(src, /if \(issued\.policyNumber\) data\.policyNumber = issued\.policyNumber;/);
    assert.match(src, /if \(recovered\.policyNumber\) data\.policyNumber = recovered\.policyNumber;/);
  });
}

test("both stored-PDF callers of each insurer pass the policy number", () => {
  const rel = fs.readFileSync(path.join(ROOT, "fullPolicycompany", "reliance", "relianceWalletIssue.js"), "utf8");
  assert.equal((rel.match(/policyFileNames\(new Date\(\), Math\.random, number\)/g) || []).length, 2);
  const ksh = fs.readFileSync(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaWalletIssue.js"), "utf8");
  assert.equal((ksh.match(/fileNames\(new Date\(\), Math\.random, number\.number\)/g) || []).length, 2);
});
