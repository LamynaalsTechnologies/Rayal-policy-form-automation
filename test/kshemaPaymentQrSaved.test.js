// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaPaymentQrSaved.test.js
//
// The KSHEMA payment-QR screenshot was uploaded to S3 and RETURNED in the run's result, but a successful run stores
// nothing from its result — so the View page never had it (2026-10-15). It is now written on the policy
// (paymentQrScreenshot: { fileName, key, location }) in the same update that saves the payment link.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FORMS = [
  path.join(ROOT, "fullPolicycompany", "kshemaForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"),
];

for (const file of FORMS) {
  test(`${path.basename(file)}: the payment QR screenshot is saved on the policy with its S3 key, next to the payment link`, () => {
    const src = fs.readFileSync(file, "utf8");
    const set = src.slice(src.indexOf("paymentLink: paymentResult.paymentUrl"));
    const block = set.slice(0, 900);
    assert.match(block, /paymentQrScreenshot:\s*{/);
    assert.match(block, /key:\s*paymentResult\.qrScreenshotKey/);
    assert.match(block, /fileName:\s*`payment_qr_\$\{jobId\}\.png`/);
    assert.match(block, /paymentResult\.qrScreenshotKey\s*\?/, "only when there is a key (an upload that failed saves nothing)");
  });
}
