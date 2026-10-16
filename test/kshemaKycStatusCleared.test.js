// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaKycStatusCleared.test.js
//
// A KSHEMA policy refused at KYC ("Your date of birth doesn't match our records."), edited and run again, completed — but its
// old refusal stayed in `kycStatus`, so the View page kept saying "KYC not completed" about a KYC that had passed (2026-10-16).
// The forms only ever WROTE kycStatus on a refusal. A KYC that works now clears it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshemaForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"),
]) {
  test(`${path.basename(file)}: a refusal is written, a KYC that passed clears the earlier note, and the update runs for it`, () => {
    const src = fs.readFileSync(file, "utf8");
    const gate = src.indexOf("if (kycResult.kycUrl || kycResult.proposalUrl || kycResult.ok) {");
    assert.ok(gate > 0, "the policy update also runs when the KYC simply worked");
    const block = src.slice(gate, gate + 3000);
    assert.match(
      block,
      /\.\.\.\(kycResult\.kycStatus\s*\?\s*\{ kycStatus: kycResult\.kycStatus \}\s*:\s*kycResult\.ok\s*\?\s*\{ kycStatus: null \}\s*:\s*\{\}\),/
    );
    // and that update happens BEFORE the failure return, as before
    assert.ok(block.length > 0 && src.indexOf("if (!kycResult.ok) {", gate) > gate);
  });
}
