// Run with: node --test test/relianceMultiForm.test.js
//
// Reliance OD / TP run common/reliance/relianceMultiForm.js: the full-company Reliance flow
// (fullPolicycompany/relianceForm.js), DUPLICATED, plus lines tagged "[MC]". The copy is GENERATED from the original by
// ./relianceMultiFormSpec.js, and these tests keep the two honest — the copy must be exactly what the spec makes of the
// original, so a portal fix made in relianceForm.js (the Get Coverage / PA / KYC fixes of 2026-10-14, say) cannot be
// forgotten in the copy — and check the [MC] changes and the handlers.
// No browser, no network: the failure path runs the real copy against a fake driver.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ORIGINAL = path.join(ROOT, "fullPolicycompany", "relianceForm.js");
const MC_DIR = path.join(ROOT, "multiCompany", "common", "reliance");
const COPY = path.join(MC_DIR, "relianceMultiForm.js");

/** Run fn with the (very chatty) flow logging switched off. */
async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

// The GPT-4o captcha reader is imported by the Reliance form: stub it so loading it never touches OpenAI.
const captchaPath = require.resolve("../Captcha");
require.cache[captchaPath] = {
  id: captchaPath,
  filename: captchaPath,
  loaded: true,
  exports: { extractCaptchaText: async () => ({ text: "", success: false }) },
};

// SAFETY, for the whole file: the copy is the real Reliance flow — if a test ever reached it unstubbed it would open
// a real Chrome window, try to log in and upload a screenshot to the production bucket. So the browser, S3 and the
// recorder are replaced up front by things that REFUSE; a test that wants to look at the failure path installs its own
// recording stubs (failedRun) and puts these back.
const installStub = (modulePath, exports) => {
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
};
const refuse = (what) => async () => {
  throw new Error(`TEST SAFETY: ${what} must not be used by relianceMultiForm.test.js`);
};
const realS3Exports = require("../s3Uploader");
installStub(require.resolve("../sessionManager"), {
  createRelianceJobBrowser: refuse("a real browser"),
  cleanupJobBrowser: refuse("a real browser"),
  performLogin: refuse("a real login"),
  reLoginIfNeeded: refuse("a real login"),
  recoveryManager: {},
});
installStub(require.resolve("../s3Uploader"), {
  ...realS3Exports,
  uploadScreenshotToS3: refuse("S3"),
  uploadToS3: refuse("S3"),
});
installStub(require.resolve("../lib/jobRecorder"), { startRecording() {} });

const { diffHunks, untagged } = require("./driftGuard");
const spec = require("../multiCompany/common/reliance/relianceMultiFormSpec");

/* ----------------------- 1. the copy is the original + [MC] ----------------------- */

/** The copy's text as if it sat next to the original: only the three-folders-deeper require paths are undone. */
const normalisePaths = (text) =>
  text
    .replace(/require\("\.\.\/\.\.\/\.\.\/fullPolicycompany\//g, 'require("./')
    .replace(/require\("\.\.\/\.\.\/\.\.\//g, 'require("../');

const originalLines = () => fs.readFileSync(ORIGINAL, "utf8").split("\n");
const copyLines = () => normalisePaths(fs.readFileSync(COPY, "utf8")).split("\n");
const brief = (hunks) => hunks.map((h) => ({ removed: h.removed.slice(0, 3), added: h.added.slice(0, 3) }));

test("sync: the copy is EXACTLY what the spec makes of relianceForm.js — a fix made there fails this until the copy is regenerated", () => {
  const expected = spec.build(fs.readFileSync(ORIGINAL, "utf8"));
  const actual = fs.readFileSync(COPY, "utf8");
  const diff = spec.firstDifference(expected, actual);
  assert.equal(
    diff,
    null,
    diff &&
      `the copy differs from what the spec makes of relianceForm.js at line ${diff.line}: expected ` +
        `${JSON.stringify(diff.expected)} but the copy has ${JSON.stringify(diff.actual)}. If relianceForm.js changed, ` +
        `regenerate the copy:  node multiCompany/common/reliance/relianceMultiFormSpec.js --write   (a hand edit of the ` +
        `copy belongs in the spec instead)`
  );
});

test("the exact check can fail: a fix right next to an [MC] change, a hand edit of the copy, a change that no longer applies", () => {
  const original = fs.readFileSync(ORIGINAL, "utf8");
  const built = spec.build(original);
  assert.equal(spec.firstDifference(built, built), null);

  // a fix in relianceForm.js INSIDE the text an [MC] change is anchored on: build() refuses, saying which change
  const anchor = "await driver.sleep(1000); // Wait for dropdown animation";
  assert.equal(original.split(anchor).length - 1, 1, "anchor present once in the original");
  const fixedAtAnchor = original.replace(anchor, "await driver.sleep(1500); // Wait for dropdown animation");
  assert.throws(() => spec.build(fixedAtAnchor), /\[MC\] 3: the full-company relianceForm\.js has this text 0 time\(s\)/);

  // a fix anywhere else: the copy is no longer what the spec makes of the original
  const elsewhere = `console.log("Clicked 'Skip To Main Page'");`;
  assert.equal(original.split(elsewhere).length - 1, 1, "line present once in the original");
  const fixedElsewhere = original.replace(elsewhere, `console.log("Clicked 'Skip To Main Page' (fixed)");`);
  assert.ok(spec.firstDifference(spec.build(fixedElsewhere), fs.readFileSync(COPY, "utf8")), "the unported fix is seen");

  // a hand edit of the copy on the line right before an [MC] block
  const copy = fs.readFileSync(COPY, "utf8");
  const handEdited = copy.replace(
    "await driver.sleep(2000); // Give time for the API call to be made.\n    // [MC] 5",
    "await driver.sleep(3000); // Give time for the API call to be made.\n    // [MC] 5"
  );
  assert.notEqual(handEdited, copy, "anchor present in the copy");
  assert.ok(spec.firstDifference(built, handEdited), "the hand edit is seen");
});

test("every difference is tagged [MC] (the per-hunk view of the same check, for a readable failure)", () => {
  const hunks = diffHunks(originalLines(), copyLines());

  assert.ok(hunks.length >= 8, `expected the header, the screenshot key, the product ... to differ, got ${hunks.length} hunk(s)`);
  assert.deepEqual(
    brief(untagged(hunks, "[MC]")),
    [],
    "the copy and fullPolicycompany/relianceForm.js differ outside the [MC] changes — if relianceForm.js changed, port " +
      "that change into multiCompany/common/reliance/relianceMultiForm.js; if the copy was edited, tag the edit [MC]"
  );
});

test("sync guard can fail: an untagged edit, a lost line and an unported fix are flagged; an [MC] edit is not", () => {
  const original = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const check = (orig, copy) => untagged(diffHunks(orig, copy), "[MC]").length;

  assert.equal(check(original, [...original]), 0, "identical");
  assert.equal(check(original, ["a", "b", "X", "d", "e", "f", "g", "h"]), 1, "untagged edit");
  assert.equal(check(original, ["a", "b", "X // [MC]", "d", "e", "f", "g", "h"]), 0, "tagged edit");
  assert.equal(check(original, ["// [MC] header", "a", "b", "c", "d", "e", "f", "g", "h"]), 0, "tagged insertion");
  assert.equal(check(original, ["a", "b", "X // [TP]", "d", "e", "f", "g", "h"]), 1, "another copy's tag is not this one's");
  assert.equal(check(original, ["a", "b", "c", "d", "e", "f", "g"]), 1, "line lost from the copy");

  // relianceForm.js gained a line (a portal fix) that the copy does not have yet
  const originalAfterFix = ["a", "b", "c", "FIX", "d", "e", "f", "g", "h"];
  assert.equal(check(originalAfterFix, original), 1, "a fix made in relianceForm.js and not ported");
});

test("sync guard on the REAL files: a fix landing in relianceForm.js, or an untagged edit of the copy, is caught", () => {
  const original = originalLines();
  const copy = copyLines();
  const at = original.findIndex((l) => l.includes("await ensureOwnerDriverPaOff(driver)"));
  assert.ok(at > 0, "anchor line found in the original");

  const fixed = [...original.slice(0, at), "          await portalFixThatIsNotPortedYet(driver);", ...original.slice(at)];
  assert.equal(untagged(diffHunks(fixed, copy), "[MC]").length, 1, "an unported fix");

  const edited = [...copy];
  const line = edited.findIndex((l) => l.includes("await ensureOwnerDriverPaOff(driver)"));
  assert.ok(line > 0);
  edited[line] = edited[line].replace("ensureOwnerDriverPaOff(driver)", "ensureOwnerDriverPaOff(driver, 1)");
  assert.equal(untagged(diffHunks(original, edited), "[MC]").length, 1, "an edit of the copy without a tag");

  edited[line] += " // [MC] 9";
  assert.equal(untagged(diffHunks(original, edited), "[MC]").length, 0, "the same edit, tagged");
});

test("sync: the copy loads, exports its own function, and keeps getCaptchaScreenShot", async () => {
  const [original, copy] = await quiet(() => [require(ORIGINAL), require(COPY)]);
  assert.equal(typeof copy.fillRelianceMultiForm, "function");
  assert.equal(typeof copy.getCaptchaScreenShot, "function");
  assert.equal(copy.fillRelianceForm, undefined, "the original's name is not exported by the copy");
  assert.notEqual(copy.fillRelianceMultiForm, original.fillRelianceForm, "must be its own copy, not the original function");
  assert.deepEqual(Object.keys(copy).sort(), ["fillRelianceMultiForm", "getCaptchaScreenShot"]);
});

test("the header names every [MC] number that the code uses, and the code uses every number the header names", () => {
  const text = fs.readFileSync(COPY, "utf8");
  const headerEnd = text.indexOf("*/");
  const header = text.slice(0, headerEnd);
  const body = text.slice(headerEnd);
  const named = new Set([...header.matchAll(/\[MC\] (\d+)/g)].map((m) => m[1]));
  const used = new Set([...body.matchAll(/\[MC\] (\d+)/g)].map((m) => m[1]));
  assert.deepEqual([...named].sort(), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15].map(String).sort());
  assert.deepEqual([...used].sort(), [...named].sort());
});

/* ----------------------- 2. the [MC] changes are where they must be ----------------------- */

/**
 * The copy's code without comments, so a token that is only MENTIONED in a comment is not "in the flow".
 * Only block comments that START a line are removed: the file has strings such as '//*****' and "//*[contains(...)]"
 * (an XPath) whose "/*" is not a comment and would swallow code up to the next "*" + "/".
 */
const codeOf = (text) => text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
const sourceOfCopy = () => fs.readFileSync(COPY, "utf8");

test("the product: the part's own, exact, with the stop before anything is clicked — never the bundled product", () => {
  const code = codeOf(sourceOfCopy());
  assert.equal(code.includes("Two Wheeler Package Bundled"), false, "the bundled product is not in the copy's code");

  const open = code.indexOf("await dropdown.click();");
  const product = code.indexOf("const mcProduct = reliancePartProduct(mcKind);", open);
  const stop = code.indexOf("if (!mcProduct) await stopBeforeProduct(driver, { kind: mcKind, jobId });", product);
  const choose = code.indexOf("const optionText = mcProduct;", stop);
  const xpath = code.indexOf("normalize-space(.) = ${xpathLiteral(optionText)}", choose);
  const click = code.indexOf("await optionElement.click();", xpath);
  assert.ok(open > 0 && open < product && product < stop && stop < choose && choose < xpath && xpath < click, "order");
  // the stop is at the top level of the flow, not inside a swallowing try block
  const between = code.slice(code.indexOf("async function fillRelianceMultiForm"), stop);
  const opens = (between.match(/\btry\s*\{/g) || []).length;
  const closes = (between.match(/\}\s*catch\b/g) || []).length;
  assert.equal(opens - closes, 1, "only the flow's own main try is open where the product stop is");
});

test("no inline Brisk certificate: the decision is fixed to 'no' and says why", () => {
  const code = codeOf(sourceOfCopy());
  assert.match(code, /const briskDecision = \{ create: false, reason: "PA through Brisk is its own part of a multi-company policy" \};/);
  assert.equal(code.includes("shouldCreateBriskCertificate(data)"), false);
  // the original's decision line is the one that was replaced
  assert.ok(codeOf(fs.readFileSync(ORIGINAL, "utf8")).includes("shouldCreateBriskCertificate(data)"));
});

test("Breaker checkpoints: product, quote and payment, labelled with Reliance OD / Reliance TP, in flow order", () => {
  const code = codeOf(sourceOfCopy());
  const product = code.indexOf("Breaker.checkpoint(`${mcLabel}/product`);");
  const quote = code.indexOf("Breaker.checkpoint(`${mcLabel}/quote`);", product);
  const calculate = code.indexOf("Clicking 'Calculate Premium' button...", quote);
  const payment = code.indexOf("Breaker.checkpoint(`${mcLabel}/payment`);", calculate);
  const pay = code.indexOf('console.log("Looking for Pay button...");', payment);
  assert.ok(product > 0 && product < quote && quote < calculate && calculate < payment && payment < pay);
  assert.match(code, /const mcLabel = relianceMultiLabel\(mcKind\);/);
});

test("which of the two this run is comes from data.policyType, defaulting to OD", () => {
  const code = codeOf(sourceOfCopy());
  assert.match(code, /const mcKind = String\(data\.policyType \|\| ""\)\.toLowerCase\(\) === "tp" \? "tp" : "od";/);
  assert.match(code, /stage: `\$\{mcKind\}-form`/);
  assert.equal(code.includes('stage: "login-form"'), false, "the original's stage name is gone");
});

test("what the user said stays the same is still in the copy: IDV, discount, cover details, PA, KYC, Pay, wallet hold", () => {
  const code = codeOf(sourceOfCopy());
  for (const needle of [
    "waitForCoverDetails(driver",
    "ensureOwnerDriverPaOff(driver)",
    "uploadKycDocument(driver, slot, absoluteFilePath",
    "chooseUploadDocument(driver)",
    "waitForKycSubmitReady(driver, {",
    "waitForKycProceed(driver, {",
    "shouldHoldForWallet(data.Paymentmethod)",
    "saveProposalNumber(proposalNumber, data, jobId)",
    'input#Paymentbtn',
  ]) {
    assert.ok(code.includes(needle), `missing from the copy: ${needle}`);
  }
});

test("the OD default is the portal's own option: the 2nd of the six it lists (the owner's log of 2026-10-23), exact text", () => {
  const portal = [
    "Two Wheeler Package (Old Veh.)",
    "Two Wheeler Own damage Policy",
    "Two Wheeler Liability (Old Veh.)",
    "Two Wheeler Package Bundled (Only New Veh.)",
    "Two Wheeler Package for 5 years (Only New Veh.)",
    "Two Wheeler Liability 5 years (Only New Veh.)",
  ];
  assert.equal(require("../multiCompany/common/reliance/multiConfig").DEFAULT_PRODUCT.od, portal[1]);
  assert.equal(portal.filter((p) => p === portal[1]).length, 1, "it matches one option only (exact, never 'contains')");
});

/** try / catch balance of a stretch of code: 0 = what is opened in it is closed in it (the same nesting level at both ends). */
const tryBalance = (stretch) => (stretch.match(/\btry\s*\{/g) || []).length - (stretch.match(/\}\s*catch\b/g) || []).length;

test("[MC] 7: the TP Details box is answered right after Skip To Main Page, for OD only, OUTSIDE the skip-link try", () => {
  const code = codeOf(sourceOfCopy());
  const skipped = code.indexOf("Clicked 'Skip To Main Page'");
  const noSkip = code.indexOf('console.log("No skip link detected, continuing...");', skipped);
  const call = code.indexOf("await answerTpDetailsDialog(driver,", noSkip);
  const vertical = code.indexOf('By.id("ddlobjBranchDetailAgentsHnin")', call);
  assert.ok(skipped > 0 && skipped < noSkip && noSkip < call && call < vertical, "order: skip, (skip catch), the box, the vertical code");
  // the guard is the line right before the call: the TP part never gets here
  assert.match(code.slice(noSkip, call), /^[^]*if \(mcKind === "od"\) \{ \/\/ \[MC\] 7\s*$/);
  // and between the skip link's "No skip link detected" line and the box there is exactly ONE closing brace — the end of that
  // catch. The call sits AFTER it: inside the catch it would run only when no skip link was found.
  assert.equal(
    (code.slice(noSkip, call).match(/\}/g) || []).length,
    1,
    "the box is answered after the skip-link try / catch has ended, not inside its catch"
  );
  // the skip-link try { } catch { } is CLOSED before the call: a box that does not open must not become "continuing..."
  const skipTry = code.lastIndexOf("try {", skipped);
  assert.equal(tryBalance(code.slice(skipTry, call)), 0, "the try that holds the skip link is closed before the box is answered");
  // the call hands over the form's own loader wait, and nothing else of the form
  assert.match(code.slice(call, call + 220), /waitLoader: \(\) => waitForLoaderToDisappear\(driver\)/);
  // the original has none of it
  const original = codeOf(fs.readFileSync(ORIGINAL, "utf8"));
  assert.equal(original.includes("answerTpDetailsDialog"), false);
  assert.equal(original.includes("stopAfterValidateCustomer"), false);
});

test("[MC] 8: the PA Cover block is skipped for OD — the PA click, its opt-out question and the PA re-check — and isCompanyPA stays outside it", () => {
  const code = codeOf(sourceOfCopy());
  const coverWait = code.indexOf("const coverOutcome = await waitForCoverDetails(driver);");
  const declared = code.indexOf("const isCompanyPA = ", coverWait);
  const open = code.indexOf('if (mcKind !== "od") { // [MC] 8', declared);
  const first = code.indexOf('console.log("Checking PA to Owner Driver checkbox state...");', open);
  const close = code.indexOf("} // [MC] 8: end of the PA block that Reliance OD skips", first);
  const helmet = code.indexOf('console.log("Unchecking Helmet Cover checkbox...");', close);
  assert.ok(coverWait > 0 && coverWait < declared && declared < open && open < first && first < close && close < helmet, "order: cover answer, isCompanyPA, the skip opens, the PA block, the skip closes, the Helmet step");

  // what OD must not do is INSIDE the skipped block ...
  const inside = code.slice(open, close);
  for (const needle of ["paOwnerDriverCheckbox", "OnNoofDL", "OnYesofDL", "ensureOwnerDriverPaOff(driver)", "ownerDriverPaStillOnMessage"]) {
    assert.ok(inside.includes(needle), `${needle} is inside the block OD skips`);
  }
  // ... what the block declares is used nowhere else (block-scoped), and what it must NOT hide stays outside it
  for (const name of ["paOwnerDriverCheckbox", "modalOpened"]) {
    assert.equal(code.slice(close).includes(name), false, `${name} is only used inside the skipped block`);
  }
  assert.ok(code.slice(close).includes("isCompanyPA"), "isCompanyPA is still used after the block (nominee block, last PA check) — it must be declared outside");
  // the Helmet step is the full flow's own, after the block
  assert.equal(code.slice(open, helmet).includes("ChkBox500"), false, "the Helmet step is not inside the skipped block");
  // the block is the ONLY PA code skipped: the braces balance (the copy loads) and the guard is for OD only
  assert.match(code.slice(declared, open + 40), /if \(mcKind !== "od"\) \{ \/\/ \[MC\] 8/);
});

test("[MC] 10: the fuel type is looked up BEFORE any window opens, and the Fuel Type box is filled right after the make / model — awaited, OD only", () => {
  const code = codeOf(sourceOfCopy());
  const lookup = code.indexOf('const mcFuelType = mcKind === "od" ? await requireVehicleFuelType(data,');
  const browser = code.indexOf("jobBrowser = await createRelianceJobBrowser(jobId);");
  assert.ok(lookup > 0 && lookup < browser, "the lookup is before the browser is opened (a data problem costs no login and no captcha)");
  assert.ok(code.slice(lookup, browser).includes("mcKind"), "the lookup is the OD branch's");

  const hold = code.indexOf('await stopIfHeld(data, "before the vehicle details");');
  const makeModel = code.indexOf('"VehicleDetailsMakeModel",', hold);
  const fuel = code.indexOf("await selectFuelType(driver, { fuelType: mcFuelType,", makeModel);
  const purchase = code.indexOf('console.log("Filling purchase date...");', fuel);
  assert.ok(hold > 0 && hold < makeModel && makeModel < fuel && fuel < purchase, "order: make / model, then the Fuel Type box, then the dates");
  assert.match(code.slice(makeModel, fuel), /\)\;\s*if \(mcKind === "od"\) $/, "the Fuel Type call is the OD branch right after the make / model call");
  assert.equal(tryBalance(code.slice(hold, fuel)), 0, "the Fuel Type step is in the same block as the hold point, not inside a try that swallows its error");
  assert.match(code.slice(fuel, fuel + 220), /waitLoader: \(\) => waitForLoaderToDisappear\(driver\)/);

  // the value reaches the box: declared once, in the main try (before the browser), used in the nested block
  assert.equal(code.split("const mcFuelType").length - 1, 1);
  assert.ok(code.indexOf("mcFuelType", lookup + 20) > lookup, "and used after it");
});

test("[MC] 11: after Get Coverage Details the cover table is required, before the PA block — awaited, OD only, after the full flow's own refusal check", () => {
  const code = codeOf(sourceOfCopy());
  const hold = code.indexOf('await stopIfHeld(data, "before the vehicle details");');
  const coverClick = code.indexOf("Clicked 'Get Coverage Details' button with multiple methods", hold);
  const refusal = code.indexOf("const coverOutcome = await waitForCoverDetails(driver);", coverClick);
  const refused = code.indexOf("coverDetailsFailureMessage(coverOutcome.text", refusal);
  const need = code.indexOf("await requireCoverTable(driver,", refused);
  const skipPa = code.indexOf('if (mcKind !== "od") { // [MC] 8', need);
  const order = [hold, coverClick, refusal, refused, need, skipPa];
  assert.ok(order.every((n) => n > 0), `every landmark found ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "order: Get Coverage, Reliance's refusal check, the cover table check, the PA skip");
  assert.match(code.slice(refused, need + 40), /if \(mcKind === "od"\) await requireCoverTable\(/);
  assert.equal(tryBalance(code.slice(hold, need)), 0, "not inside a try that swallows its error");
});

test("[MC] 12: the existing TP policy is checked BEFORE any window opens and entered after Nil Depreciation, before the financier — awaited, OD only, and nothing stops there", () => {
  const code = codeOf(sourceOfCopy());
  const check = code.indexOf('const mcTp = mcKind === "od" ? requireExistingTpDetails(data,');
  const browser = code.indexOf("jobBrowser = await createRelianceJobBrowser(jobId);");
  assert.ok(check > 0 && check < browser, "the data check is before the browser is opened (a data problem costs no login and no captcha)");

  const hold = code.indexOf('await stopIfHeld(data, "before the vehicle details");');
  const nilDip = code.indexOf('console.log("Zero Depreciation not requested. Leaving as-is.");', hold);
  const fill = code.indexOf("await fillExistingTpPolicy(driver, { tp: mcTp,", nilDip);
  const financier = code.indexOf('console.log("Handling financier fields...");', fill);
  assert.ok(hold > 0 && hold < nilDip && nilDip < fill && fill < financier, "order: Nil Depreciation, the existing TP policy, the financier");
  assert.match(code.slice(nilDip, fill + 40), /if \(mcKind === "od"\) await fillExistingTpPolicy\(/);
  assert.equal(tryBalance(code.slice(hold, fill)), 0, "not inside a try whose catch would swallow its error");
  assert.match(code.slice(fill, fill + 260), /waitLoader: \(\) => waitForLoaderToDisappear\(driver\)/);
  assert.equal(code.split("const mcTp").length - 1, 1, "declared once");
});

test("[MC] 13: the nominee block and the last PA opt-out check are skipped for OD — and only for OD", () => {
  const code = codeOf(sourceOfCopy());
  const nominee = code.indexOf('if (isCompanyPA && mcKind !== "od") {');
  const paCheck = code.indexOf('if (!isCompanyPA && mcKind !== "od" && isCoverSettleEnabled()) {');
  const calculate = code.indexOf("Clicking 'Calculate Premium' button...", paCheck);
  assert.ok(nominee > 0 && nominee < paCheck && paCheck < calculate, "order: nominee guard, the last PA check guard, Calculate Premium");
  // the guards ADD a condition: the original's own condition is still there (TP behaves as before)
  assert.match(code.slice(nominee - 30, nominee + 60), /isCompanyPA && mcKind/);
  assert.equal(code.slice(nominee, paCheck).includes("ensureOwnerDriverPaOff"), false);
  assert.ok(code.slice(paCheck, calculate).includes("ensureOwnerDriverPaOff(driver)"), "the opt-out call itself is untouched");
});

test("[MC] 14: Is Registration Address Same — OD ticks it only when it is not ticked, TP keeps the original blind click", () => {
  const code = codeOf(sourceOfCopy());
  const od = code.indexOf('if (mcKind === "od") { // [MC] 14');
  const call = code.indexOf("await ensureAddressSame(driver,", od);
  const other = code.indexOf("} else { // [MC] 14", call);
  const click = code.indexOf('await driver.executeScript("arguments[0].click();", regAddressSameCheckbox);', other);
  const close = code.indexOf("} // [MC] 14", click);
  const calculate = code.indexOf("Clicking 'Calculate Premium' button...", close);
  assert.ok(od > 0 && od < call && call < other && other < click && click < close && close < calculate, "order: OD branch, TP branch with the original click, end, Calculate Premium");
});

test("[MC] 15: the exact words after Calculate Premium and after Save — the alert is read RIGHT after the click, before the loader wait that would swallow it", () => {
  const code = codeOf(sourceOfCopy());
  const click = code.indexOf("console.log(\"Clicked 'Calculate Premium' button!\");");
  const alertWatch = code.indexOf('await afterCalculatePremiumClick(driver);', click);
  const loader = code.indexOf("await waitForLoaderToDisappear(driver);", alertWatch);
  const done = code.indexOf('console.log("Premium calculation completed!");', loader);
  const refusal = code.indexOf("await afterCalculatePremium(driver,", done);
  const save = code.indexOf('console.log("Clicked Save button!");', refusal);
  const saveAlert = code.indexOf("await afterSaveClick(driver);", save);
  const sleep3 = code.indexOf("await driver.sleep(3000);", saveAlert);
  const failure = code.indexOf('await explainSaveFailure(driver) : new Error("Proposal number extraction failed")', sleep3);
  const order = [click, alertWatch, loader, done, refusal, save, saveAlert, sleep3, failure];
  assert.ok(order.every((n) => n > 0), `every landmark found ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "order: click, alert watch, the flow's loader wait, done, refusal check, Save click, alert watch, the flow's 3 s, the failure sentence");
  assert.equal(code.includes('throw new Error("Proposal number extraction failed");'), false, "TP's bare error is kept only inside the ternary");
  assert.match(code, /new Error\("Proposal number extraction failed"\)\)/);
});

test("[MC] 7 and [MC] 10 to 15 call only what the copy has: the OD steps are required and every name they use is declared", () => {
  const code = codeOf(sourceOfCopy());
  // a dropped require would be a ReferenceError the moment an OD run reaches the box — no other test would see it
  assert.match(code, /const \{ answerTpDetailsDialog, selectFuelType, requireCoverTable, fillExistingTpPolicy, ensureAddressSame, afterCalculatePremiumClick, afterCalculatePremium, afterSaveClick, explainSaveFailure \} = require\("\.\/relianceOdSteps"\);/);
  assert.match(code, /const \{ requireExistingTpDetails \} = require\("\.\.\/\.\.\/\.\.\/lib\/existingTpDetails"\);/);
  assert.match(code, /const \{ requireVehicleFuelType \} = require\("\.\.\/\.\.\/\.\.\/lib\/vehicleFuelType"\);/);
  const odSteps = require("../multiCompany/common/reliance/relianceOdSteps");
  assert.equal(typeof odSteps.answerTpDetailsDialog, "function");
  for (const name of ["fillExistingTpPolicy", "ensureAddressSame", "afterCalculatePremiumClick", "afterCalculatePremium", "afterSaveClick", "explainSaveFailure"]) assert.equal(typeof odSteps[name], "function", name);
  assert.equal(typeof require("../lib/existingTpDetails").requireExistingTpDetails, "function");
  assert.equal(code.includes("stopAfterNilDepreciation"), false, "the stop the OD run had after Nil Depreciation is gone — the run goes on to the end");
  assert.equal(typeof odSteps.selectFuelType, "function");
  assert.equal(typeof odSteps.requireCoverTable, "function");
  assert.equal(typeof require("../lib/vehicleFuelType").requireVehicleFuelType, "function");
  assert.ok(fs.existsSync(path.join(MC_DIR, "relianceOdSteps.js")), "the file the copy requires sits next to it");
  const declared = (name) =>
    new RegExp(`(function\\s+${name}\\b|\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name}\\b))`).test(code);
  for (const name of ["answerTpDetailsDialog", "selectFuelType", "requireCoverTable", "fillExistingTpPolicy", "ensureAddressSame", "afterCalculatePremiumClick", "afterCalculatePremium", "afterSaveClick", "explainSaveFailure", "requireVehicleFuelType", "requireExistingTpDetails", "mcFuelType", "mcTp", "waitForLoaderToDisappear", "mcKind", "jobId", "driver", "isCoverSettleEnabled"]) {
    assert.ok(declared(name), `${name} is declared in the copy`);
  }
  assert.equal(declared("aNameThatIsNotThere"), false, "the check can fail");
});

test("[MC] 7 to 15 are the ONLY OD-only branches: everything the TP part runs is the full flow", () => {
  const code = codeOf(sourceOfCopy());
  const branches = [...code.matchAll(/mcKind (?:===|!==) "od"/g)].map((m) => m[0]);
  const is = 'mcKind === "od"';
  const not = 'mcKind !== "od"';
  assert.deepEqual(
    branches,
    [is, is, is, is, is, not, is, is, not, not, is, is, is, is],
    "fourteen places, in flow order: the fuel type lookup, the existing TP check, the TP Details box, the Fuel Type box, the cover table check, " +
      "the PA skip, the existing TP block, address same, the nominee guard, the last PA check guard, Calculate Premium (alert, refusal), Save (alert, failure sentence)"
  );
  const uses = [...code.matchAll(/\bmcKind\b/g)].length;
  assert.ok(uses >= 16, `mcKind is the one switch (${uses} uses)`);
});

/* ----------------------- 3. failure path of the REAL copy ----------------------- */

/**
 * Run the real copy down its failure path with the browser, S3 and recorder replaced: the portal rejects the login, so
 * the copy's own catch builds the failure result, takes the error screenshot and cleans the browser up.
 */
async function failedRun(policyType, extraData = {}) {
  const session = require.resolve("../sessionManager");
  const s3 = require.resolve("../s3Uploader");
  const recorder = require.resolve("../lib/jobRecorder");
  const realS3 = require("../s3Uploader");
  const uploaded = [];
  const cleaned = [];
  const opened = [];
  const driver = {
    async executeScript() {
      return null;
    },
    async takeScreenshot() {
      return "aGVsbG8=";
    },
    async getPageSource() {
      return "<html></html>";
    },
    async getCurrentUrl() {
      return "about:blank";
    },
  };
  const stubs = {
    [session]: {
      createRelianceJobBrowser: async () => (opened.push(1), { driver }),
      cleanupJobBrowser: async (browser, opts) => cleaned.push(opts),
      performLogin: async () => false,
      reLoginIfNeeded: async () => true,
      recoveryManager: {},
    },
    [s3]: {
      ...realS3,
      uploadScreenshotToS3: async (_b64, key) => (uploaded.push(key), `https://s3.test/${key}`),
      uploadToS3: async (_file, key) => `https://s3.test/${key}`,
    },
    [recorder]: { startRecording() {} },
  };
  const saved = new Map();
  for (const [p, exports] of Object.entries(stubs)) {
    saved.set(p, require.cache[p]);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  }
  saved.set(COPY, require.cache[COPY]);
  delete require.cache[COPY];
  const jobIdentifier = `Asha_mcTest_${policyType}`;
  try {
    const { fillRelianceMultiForm } = await quiet(() => require(COPY));
    const result = await quiet(() =>
      fillRelianceMultiForm({
        username: "u",
        password: "p",
        loginUrl: "https://portal.test/login",
        firstName: "Asha",
        policyType,
        // the job carries the vehicle's fuel type, so the OD part does not look it up in the database (lib/vehicleFuelType.js)
        fuelType: "PETROL",
        // and the customer's existing TP policy, which the OD part checks before any window opens (lib/existingTpDetails.js)
        existingTpPolicyNumber: "NIC/TP/0001",
        existingTpInsurer: "National",
        existingTpStartDate: "01-10-2026",
        existingTpEndDate: "30-09-2031",
        _jobIdentifier: jobIdentifier,
        _attemptNumber: 2,
        ...extraData,
      })
    );
    return { result, uploaded, cleaned, opened };
  } finally {
    for (const [p, entry] of saved) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
    // the copy keeps a local copy of every error screenshot at the project root: remove what this test made
    const dir = path.join(ROOT, "error_screenshots");
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) if (f.startsWith(`error_${jobIdentifier}_`)) fs.unlinkSync(path.join(dir, f));
    }
  }
}

test("failure path of the copy (OD): stage od-form, the screenshot under screenshots/multiCompany/reliance/, browser cleaned up", async () => {
  const { result, uploaded, cleaned } = await failedRun("od");

  assert.equal(result.success, false);
  assert.match(result.error, /rejected the login/i);
  assert.equal(result.stage, "od-form");
  assert.equal(uploaded.length, 1, "one screenshot for one failed attempt");
  // the prefix the 10-day S3 lifecycle rule covers (s3Uploader MULTI_COMPANY_SCREENSHOT_PREFIX)
  assert.match(uploaded[0], /^screenshots\/multiCompany\/reliance\/form-error\/Asha_mcTest_od\/attempt_2\//);
  assert.equal(result.screenshotKey, uploaded[0]);
  assert.deepEqual(cleaned, [{ hadError: true }], "browser closed, told it was a failed job");
});

test("failure path of the copy (TP): stage tp-form", async () => {
  const { result, uploaded } = await failedRun("tp");
  assert.equal(result.success, false);
  assert.equal(result.stage, "tp-form");
  assert.match(uploaded[0], /^screenshots\/multiCompany\/reliance\/form-error\/Asha_mcTest_tp\/attempt_2\//);
});

test("failure path of the copy (OD): a vehicle whose fuel type cannot be found stops BEFORE any window opens — no login, no captcha, no retry", async () => {
  // no fuel type on the job and no policy to read it from (what an anomaly looks like: a deleted master row has the same effect)
  const { result, uploaded, cleaned, opened } = await failedRun("od", { fuelType: "" });
  assert.equal(result.success, false);
  assert.match(result.error, /^\[Reliance\] The job does not say which policy it belongs to, so the fuel type of its vehicle could not be looked up\./);
  assert.equal(result.retryable, false, "a re-run cannot mend a data problem");
  assert.equal(result.stage, "od-form");
  assert.equal(opened.length, 0, "no browser was opened");
  assert.deepEqual(cleaned, [], "so there is nothing to clean up");
  assert.equal(uploaded.length, 0, "and no failure picture (there was no page)");
});

test("failure path of the copy (OD): bad existing TP details stop BEFORE any window opens — each with its own sentence, not retried", async () => {
  for (const [over, pattern] of [
    [{ existingTpInsurer: "United India" }, /the existing TP insurer "United India" is not KSHEMA or National/i],
    [{ existingTpStartDate: "Invalid date" }, /start date "Invalid date" is not a date/i],
    [{ existingTpEndDate: "01-10-2026" }, /end date 01-10-2026 is not after its start date 01-10-2026/i],
    [{ existingTpPolicyNumber: "A" }, /number "A" is not a policy number/i],
  ]) {
    const { result, uploaded, cleaned, opened } = await failedRun("od", over);
    assert.equal(result.success, false);
    assert.match(result.error, pattern);
    assert.match(result.error, /Enter it in Edit then TP policy details, then run the policy again\.$/);
    assert.equal(result.retryable, false, "a re-run cannot mend a data problem");
    assert.equal(opened.length, 0, "no browser was opened");
    assert.deepEqual(cleaned, []);
    assert.equal(uploaded.length, 0);
  }
});

test("the TP part never checks the existing TP policy: it reaches the login, whatever the job carries", async () => {
  const { result, opened } = await failedRun("tp", { existingTpInsurer: "", existingTpStartDate: "" });
  assert.match(result.error, /rejected the login/i);
  assert.equal(opened.length, 1);
});

test("the TP part never looks up a fuel type: it reaches the login, whatever the job carries", async () => {
  const { result, opened } = await failedRun("tp", { fuelType: "" });
  assert.match(result.error, /rejected the login/i);
  assert.equal(opened.length, 1);
});

test("a failed login is retryable for the queue as the original's is — the new stage names change nothing about that", () => {
  const { mapRunResult } = require("../lib/partRunner");
  const outcome = mapRunResult(
    { success: false, error: "[E203] Reliance rejected the login", stage: "od-form", postSubmissionFailed: false },
    { part: { key: "od", kind: "portal", company: "Reliance" }, companyName: "reliance", companyLabel: () => "Reliance" }
  );
  assert.equal(outcome.stage, "od-form");
  assert.equal(outcome.type, "retryable");
  assert.equal(outcome.errorExtra.retryable, true);
});

/* ----------------------- 4. settings and the product stop ----------------------- */

const cfg = require("../multiCompany/common/reliance/multiConfig");

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) {
    before[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

test("switch: RELIANCE_MULTI_FORM_ENABLED is ON unless it is explicitly false / 0 / no / off", () => {
  withEnv({ RELIANCE_MULTI_FORM_ENABLED: undefined }, () => assert.equal(cfg.isRelianceMultiFormEnabled(), true));
  for (const on of ["true", "1", "yes", "on", "", "anything"]) {
    withEnv({ RELIANCE_MULTI_FORM_ENABLED: on }, () => assert.equal(cfg.isRelianceMultiFormEnabled(), true, `"${on}"`));
  }
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    withEnv({ RELIANCE_MULTI_FORM_ENABLED: off }, () => assert.equal(cfg.isRelianceMultiFormEnabled(), false, `"${off}"`));
  }
});

test("product: one setting per part, whitespace collapsed; OD defaults to the own-damage product, TP is empty until set", () => {
  withEnv({ RELIANCE_OD_PRODUCT: undefined, RELIANCE_TP_PRODUCT: undefined }, () => {
    assert.equal(cfg.reliancePartProduct("od"), "Two Wheeler Own damage Policy", "OD needs nothing in .env");
    assert.equal(cfg.reliancePartProduct("tp"), "", "TP is not decided yet: the run lists the products and stops");
  });
  withEnv({ RELIANCE_OD_PRODUCT: "   ", RELIANCE_TP_PRODUCT: "  " }, () => {
    assert.equal(cfg.reliancePartProduct("od"), "Two Wheeler Own damage Policy", "an empty .env line is the default");
    assert.equal(cfg.reliancePartProduct("tp"), "");
  });
  withEnv({ RELIANCE_OD_PRODUCT: "  Two Wheeler   Package ", RELIANCE_TP_PRODUCT: "Two Wheeler Liability Only" }, () => {
    assert.equal(cfg.reliancePartProduct("od"), "Two Wheeler Package");
    assert.equal(cfg.reliancePartProduct("tp"), "Two Wheeler Liability Only");
    assert.equal(cfg.reliancePartProduct("TP"), "Two Wheeler Liability Only");
    assert.equal(cfg.reliancePartProduct("anything else"), "Two Wheeler Package", "unknown means OD, like the form");
  });
  assert.equal(cfg.relianceMultiLabel("od"), "Reliance OD");
  assert.equal(cfg.relianceMultiLabel("tp"), "Reliance TP");
});

test("xpathLiteral: text from .env cannot break out of the expression", () => {
  assert.equal(cfg.xpathLiteral("Two Wheeler Package"), "'Two Wheeler Package'");
  assert.equal(cfg.xpathLiteral("Owner's Package"), `"Owner's Package"`);
  assert.equal(cfg.xpathLiteral(`It's a "pack"`), `concat('It', "'", 's a "pack"')`);
  assert.equal(cfg.xpathLiteral(""), "''");
});

const { stopBeforeProduct, readProductOptions } = require("../multiCompany/common/reliance/stopBeforeProduct");
const { isAutomationStop, stoppedResult } = require("../automationStopper");

/** A driver whose product list is `texts` (the page function runs against a stand-in list). */
const driverWithProducts = (texts, { fail = false } = {}) => ({
  async executeScript(fn, selector) {
    if (fail) throw new Error("javascript error: document unloaded");
    const items = texts.map((t) => ({ textContent: t }));
    const savedDocument = globalThis.document;
    globalThis.document = {
      querySelector: (sel) => (sel === selector && sel === "#ddlMotorProducts_listbox" ? { querySelectorAll: () => items } : null),
    };
    try {
      return fn(selector);
    } finally {
      if (savedDocument === undefined) delete globalThis.document;
      else globalThis.document = savedDocument;
    }
  },
});

test("stopBeforeProduct: lists the portal's products and ends the run as a stop — nothing chosen", async () => {
  const driver = driverWithProducts(["Select", "Two Wheeler Package", "Two Wheeler Liability Only", "Two Wheeler Package"]);
  let stop = null;
  await quiet(async () => {
    try {
      await stopBeforeProduct(driver, { kind: "od", jobId: "Asha_job" });
    } catch (e) {
      stop = e;
    }
  });
  assert.ok(stop && isAutomationStop(stop), "ends in a stop, not a failure");
  const stopped = stoppedResult(stop);
  assert.equal(stopped.stage, "od-product");
  assert.match(stop.message, /^Reliance OD: stopped before choosing the product because RELIANCE_OD_PRODUCT is not set\./);
  assert.match(stop.message, /The products on the portal are "Select", "Two Wheeler Package", "Two Wheeler Liability Only"\./);
  assert.match(stop.message, /Nothing was chosen or submitted\./);
  assert.deepEqual(stopped.stopDetails.productOptions, ["Select", "Two Wheeler Package", "Two Wheeler Liability Only"]);
  assert.equal(stop.message.split(":").length - 1, 1, "one colon only: beautifyError keeps the text after the last one");
});

test("stopBeforeProduct: the TP part names its own setting; unreadable options still stop, saying so", async () => {
  let stop = null;
  await quiet(async () => {
    try {
      await stopBeforeProduct(driverWithProducts([], { fail: true }), { kind: "tp" });
    } catch (e) {
      stop = e;
    }
  });
  assert.ok(isAutomationStop(stop));
  assert.match(stop.message, /^Reliance TP: stopped before choosing the product because RELIANCE_TP_PRODUCT is not set\./);
  assert.match(stop.message, /\(they could not be read from the page\)/);
  assert.ok(!stop.message.includes("document unloaded"), "the driver's own text stays in the console");
  assert.equal(stoppedResult(stop).stage, "tp-product");
});

test("readProductOptions: trimmed, in order, no duplicates, bounded", async () => {
  const many = Array.from({ length: 40 }, (_, i) => `Product ${i}`);
  const options = await readProductOptions(driverWithProducts(["  A  ", "", "B", "A", ...many]));
  assert.equal(options[0], "A");
  assert.equal(options[1], "B");
  assert.equal(options.length, 25);
});

test("a stop at the product is recorded as stopped by the queue — not retried, not a purchase", () => {
  const { mapThrownError } = require("../lib/partRunner");
  const { AutomationStoppedError } = require("../automationStopper");
  const e = new AutomationStoppedError("Reliance OD: stopped before choosing the product because RELIANCE_OD_PRODUCT is not set.", {
    stage: "od-product",
  });
  const outcome = mapThrownError(e, { part: { key: "od", kind: "portal", company: "Reliance" }, companyName: "reliance" });
  assert.equal(outcome.type, "stopped");
  assert.equal(outcome.errorExtra.retryable, false);
  assert.equal(outcome.stage, "od-product");
});

/* ----------------------- 5. the handlers are wired in ----------------------- */

const featureGatePath = require.resolve("../multiCompany/common/featureGate");
const configPath = require.resolve("../multiCompany/common/reliance/multiConfig");
const runHandlerPath = require.resolve("../multiCompany/common/runHandler");
const loginOnlyPath = require.resolve("../multiCompany/common/loginOnlyHandler");
const formPath = require.resolve("../multiCompany/common/reliance/relianceMultiForm");
const odPath = require.resolve("../multiCompany/odCompany/relianceOD/relianceOD");
const tpPath = require.resolve("../multiCompany/tpCompany/relianceTP/relianceTP");

/**
 * Load the two Reliance handlers fresh with the feature flag on/off, the real form replaced by `fillRelianceMultiForm`
 * and runHandler / loginOnlyHandler replaced by recorders — and keep all of that in place while `fn` runs: the form is
 * required when a part RUNS, so putting the module cache back first would let the REAL form (a real browser) run.
 */
async function withHandlers({ enabled, fillRelianceMultiForm, runHandlerCalls = [], loginOnlyCalls = [] }, fn) {
  const paths = [featureGatePath, configPath, runHandlerPath, loginOnlyPath, formPath, odPath, tpPath];
  const keep = { env: process.env.MULTI_COMPANY_AUTOMATION_ENABLED, cache: new Map(paths.map((p) => [p, require.cache[p]])) };
  process.env.MULTI_COMPANY_AUTOMATION_ENABLED = enabled ? "true" : "false";
  for (const p of paths) delete require.cache[p];
  installStub(formPath, { fillRelianceMultiForm });
  installStub(runHandlerPath, {
    runHandler: async (args) => {
      runHandlerCalls.push(args);
      return { success: true, via: "runHandler" };
    },
  });
  installStub(loginOnlyPath, {
    makeLoginOnlyHandler: (company, policyType) => async (data) => {
      loginOnlyCalls.push({ company, policyType, data });
      return { success: true, via: "loginOnly" };
    },
  });
  const savedLog = console.log;
  console.log = () => {}; // featureGate loads .env through dotenv, which prints a banner each time
  try {
    const handlers = { fillRelianceOD: require(odPath).fillRelianceOD, fillRelianceTP: require(tpPath).fillRelianceTP };
    console.log = savedLog;
    return await fn(handlers);
  } finally {
    console.log = savedLog;
    if (keep.env === undefined) delete process.env.MULTI_COMPANY_AUTOMATION_ENABLED;
    else process.env.MULTI_COMPANY_AUTOMATION_ENABLED = keep.env;
    for (const [p, entry] of keep.cache) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  }
}

test("handlers: with the feature off both fail [E110] before the form is touched", async () => {
  let touched = 0;
  await withHandlers(
    { enabled: false, fillRelianceMultiForm: async () => (touched++, { success: true }) },
    async ({ fillRelianceOD, fillRelianceTP }) => {
      await assert.rejects(() => fillRelianceOD({ username: "u" }), /\[E110\]/);
      await assert.rejects(() => fillRelianceTP({ username: "u" }), /\[E110\]/);
    }
  );
  assert.equal(touched, 0);
});

test("handlers: with the feature on each runs the duplicated form once, as its own part, and returns its result", async () => {
  const calls = [];
  const answer = { success: false, inProgress: true, stage: "od-product" };
  await withHandlers(
    { enabled: true, fillRelianceMultiForm: async (data) => (calls.push(data), answer) },
    async ({ fillRelianceOD, fillRelianceTP }) => {
      const data = { username: "u", password: "p", loginUrl: "https://example.test", _jobId: "job1" };
      const od = await withEnv({ RELIANCE_MULTI_FORM_ENABLED: undefined }, () => fillRelianceOD(data));
      const tp = await withEnv({ RELIANCE_MULTI_FORM_ENABLED: undefined }, () => fillRelianceTP(data));
      assert.equal(od, answer);
      assert.equal(tp, answer);
    }
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].policyType, "od");
  assert.equal(calls[1].policyType, "tp");
  assert.equal(calls[0].username, "u");
  assert.equal(calls[1]._jobId, "job1", "the payload is handed over with its own fields");
});

test("handlers: RELIANCE_MULTI_FORM_ENABLED=false -> the old behaviour, the form is never started", async () => {
  let formCalls = 0;
  const runHandlerCalls = [];
  const loginOnlyCalls = [];
  let od;
  let tp;
  await withHandlers(
    { enabled: true, fillRelianceMultiForm: async () => (formCalls++, { success: true }), runHandlerCalls, loginOnlyCalls },
    async ({ fillRelianceOD, fillRelianceTP }) => {
      const data = { username: "u", password: "p" };
      od = await withEnv({ RELIANCE_MULTI_FORM_ENABLED: "false" }, () => fillRelianceOD(data));
      tp = await withEnv({ RELIANCE_MULTI_FORM_ENABLED: "false" }, () => fillRelianceTP(data));
    }
  );
  assert.equal(formCalls, 0);
  assert.equal(od.via, "runHandler");
  assert.equal(runHandlerCalls.length, 1);
  assert.equal(runHandlerCalls[0].company, "reliance");
  assert.equal(runHandlerCalls[0].policyType, "od");
  assert.equal(typeof runHandlerCalls[0].body, "function", "login, then Motors -> Two Wheeler, then the stop");
  assert.equal(tp.via, "loginOnly");
  assert.deepEqual(loginOnlyCalls.map((c) => [c.company, c.policyType]), [["reliance", "tp"]]);
});

test("the safety stubs are in place: a real browser or S3 would be refused, not used", async () => {
  const session = require("../sessionManager");
  await assert.rejects(() => session.createRelianceJobBrowser("x"), /TEST SAFETY/);
  await assert.rejects(() => require("../s3Uploader").uploadScreenshotToS3("b64", "key"), /TEST SAFETY/);
});

test("registry: reliance / od and reliance / tp are these handlers; the other four are untouched", () => {
  const { registry, resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const { fillRelianceOD } = require("../multiCompany/odCompany/relianceOD/relianceOD");
  const { fillRelianceTP } = require("../multiCompany/tpCompany/relianceTP/relianceTP");
  assert.equal(registry.reliance.od, fillRelianceOD);
  assert.equal(registry.reliance.tp, fillRelianceTP);
  assert.equal(resolveMultiCompanyHandler("Reliance", "OD"), fillRelianceOD);
  assert.deepEqual(Object.keys(registry).sort(), ["kshema", "national", "reliance"]);
  for (const company of ["national", "kshema"]) assert.deepEqual(Object.keys(registry[company]).sort(), ["od", "tp"]);
});

test("the handlers do not load the 5,000-line form until a part runs", () => {
  const odSource = fs.readFileSync(odPath, "utf8");
  const tpSource = fs.readFileSync(tpPath, "utf8");
  for (const [name, source] of [["relianceOD.js", odSource], ["relianceTP.js", tpSource]]) {
    const code = codeOf(source);
    assert.ok(code.includes('require("../../common/reliance/relianceMultiForm")'), `${name} requires the form`);
    const top = code.slice(0, code.indexOf("async function fillReliance"));
    assert.equal(top.includes("relianceMultiForm"), false, `${name} must not require it at load`);
  }
});
