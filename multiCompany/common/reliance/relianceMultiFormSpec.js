/**
 * The recipe for ./relianceMultiForm.js: fullPolicycompany/relianceForm.js plus the [MC] changes below.
 *
 *   node multiCompany/common/reliance/relianceMultiFormSpec.js            check: is the copy exactly what this makes?
 *   node multiCompany/common/reliance/relianceMultiFormSpec.js --write    regenerate the copy (after a fix in relianceForm.js)
 *
 * Each change is { tag, from, to }: `from` (lines) must occur in the original EXACTLY once, `to` replaces it. If the
 * full-company flow changed around one of them, build() says which, and the change is re-stated here deliberately.
 * test/relianceMultiForm.test.js runs the check, so the two flows cannot drift apart unnoticed.
 */
const fs = require("fs");
const path = require("path");

const ORIGINAL = path.join(__dirname, "..", "..", "..", "fullPolicycompany", "relianceForm.js");
const COPY = path.join(__dirname, "relianceMultiForm.js");

const HEADER = ["/**", " * [MC] Reliance OD / TP — the full-company Reliance flow, DUPLICATED, for the multiCompany Reliance OD and TP handlers.", " *", " * This file is a copy of fullPolicycompany/relianceForm.js (login, navigation, product, quote form, cover details,", " * PA / helmet / TPPD, financier, address, Calculate Premium, Save, KYC, Pending Quotes, Pay, wallet hold, its own error", " * mapping and cleanup), made for ../../odCompany/relianceOD/relianceOD.js and ../../tpCompany/relianceTP/relianceTP.js.", " * fullPolicycompany/relianceForm.js itself is NOT touched and still runs every single-company Reliance policy.", " *", " * GENERATED: this file is relianceForm.js plus the [MC] changes listed in ./relianceMultiFormSpec.js, applied by that", " * file. Do not edit it by hand — edit the original (or the spec) and regenerate:", " *     node multiCompany/common/reliance/relianceMultiFormSpec.js --write", " * test/relianceMultiForm.test.js fails if this file is not exactly what the spec makes of the original, so a portal fix", " * made in relianceForm.js cannot be forgotten here.", " *", " * Every line that differs from the original is tagged \"[MC]\":", " *   [MC] 1  require paths are three folders deeper (\"../\" -> \"../../../\", \"./relianceX\" ->", " *           \"../../../fullPolicycompany/relianceX\"). The browser / session manager, S3, captcha, error catalogue, Brisk", " *           helpers and the cover / KYC modules stay SHARED with the original, they are not copied.", " *   [MC] 2  failure screenshots go under screenshots/multiCompany/reliance/ (see captureErrorScreenshot), which has the", " *           10-day S3 lifecycle rule.", " *   [MC] 3  the PRODUCT is the one of the part — RELIANCE_OD_PRODUCT / RELIANCE_TP_PRODUCT (./multiConfig.js), exact", " *           match — instead of \"Two Wheeler Package Bundled (Only New Veh.)\". Not configured: the run opens the", " *           dropdown, lists the portal's products and stops (./stopBeforeProduct.js); nothing is chosen or bought.", " *   [MC] 4  no inline Brisk certificate: PA through Brisk is its own `pa` part in a multi-company policy.", " *   [MC] 5  an unexpected error carries the stage \"od-form\" / \"tp-form\" (the original says \"login-form\"); Breaker", " *           checkpoints \"Reliance OD/product\", \"/quote\", \"/payment\" (and \"Reliance TP/...\") — no-ops unless .env", " *           switches the Breaker on.", " *   [MC] 6  the function is fillRelianceMultiForm and takes OD / TP from data.policyType (set by the part runner).", " * Left exactly as the full flow, on purpose: IDV, discount, Get Coverage Details, PA / helmet / TPPD, financier,", " * address, Calculate Premium, Save, KYC, Pending Quotes, Pay and the wallet hold — so a difference of an OD-only /", " * TP-only portal shows up as a clear stop at the first step that differs, and gets an own tagged line when the HTML of", " * that step is known. The dead helpers and the standalone block at the bottom stay too, so the two files stay diffable.", " */"];

const CHANGES = [
  { tag: "1", from: ["const { createFreshDriverFromBaseProfile } = require(\"../browser\");"], to: ["const { createFreshDriverFromBaseProfile } = require(\"../../../browser\");"] },
  { tag: "1", from: ["const { startRecording } = require(\"../lib/jobRecorder\");"], to: ["const { startRecording } = require(\"../../../lib/jobRecorder\");"] },
  { tag: "1", from: ["} = require(\"../sessionManager\");"], to: ["} = require(\"../../../sessionManager\");"] },
  { tag: "1", from: ["const ROOT_DIR = path.join(__dirname, \"..\");"], to: ["const ROOT_DIR = path.join(__dirname, \"..\", \"..\", \"..\"); // [MC] 1"] },
  { tag: "1", from: ["const { extractCaptchaText } = require(\"../Captcha\");"], to: ["const { extractCaptchaText } = require(\"../../../Captcha\");"] },
  { tag: "1", from: ["const { uploadScreenshotToS3, generateScreenshotKey } = require(\"../s3Uploader\");"], to: ["const { uploadScreenshotToS3, generateScreenshotKey } = require(\"../../../s3Uploader\");"] },
  { tag: "1", from: ["const { beautifyError: beautifyErrorShared } = require(\"../lib/errorHandler\");"], to: ["const { beautifyError: beautifyErrorShared } = require(\"../../../lib/errorHandler\");"] },
  { tag: "1", from: ["const { isAutomationStop, stoppedResult, stopper } = require(\"../automationStopper\");"], to: ["const { isAutomationStop, stoppedResult, stopper } = require(\"../../../automationStopper\");"] },
  { tag: "1", from: ["} = require(\"./relianceWalletHold\");"], to: ["} = require(\"../../../fullPolicycompany/relianceWalletHold\");"] },
  { tag: "1", from: ["} = require(\"./relianceCoverDetails\");"], to: ["} = require(\"../../../fullPolicycompany/relianceCoverDetails\");"] },
  { tag: "1", from: ["} = require(\"./relianceCoverSettle\");"], to: ["} = require(\"../../../fullPolicycompany/relianceCoverSettle\");"] },
  { tag: "1", from: ["} = require(\"./relianceKycSubmit\");"], to: ["} = require(\"../../../fullPolicycompany/relianceKycSubmit\");"] },
  { tag: "1", from: ["} = require(\"./relianceKycUpload\");"], to: ["} = require(\"../../../fullPolicycompany/relianceKycUpload\");"] },
  { tag: "1", from: ["} = require(\"./relianceKycFallback\");"], to: ["} = require(\"../../../fullPolicycompany/relianceKycFallback\");"] },
  { tag: "1", from: ["} = require(\"./relianceWalletCdt\");"], to: ["} = require(\"../../../fullPolicycompany/relianceWalletCdt\");"] },
  { tag: "1", from: ["} = require(\"./relianceWalletIssue\");"], to: ["} = require(\"../../../fullPolicycompany/relianceWalletIssue\");"] },
  { tag: "1", from: ["} = require(\"./relianceQuotesPaging\");"], to: ["} = require(\"../../../fullPolicycompany/relianceQuotesPaging\");"] },
  { tag: "5", from: ["                                      checkpoint: (name) => Breaker.checkpoint(`Reliance/${name}`),"], to: ["                                      checkpoint: (name) => Breaker.checkpoint(`${mcLabel}/${name}`), // [MC] 5"] },
  { tag: "1", from: ["const { uploadToS3 } = require(\"../s3Uploader\");"], to: ["const { uploadToS3 } = require(\"../../../s3Uploader\");"] },
  { tag: "1", from: ["const { captureAndLogError } = require(\"../errorLogger\");"], to: ["const { captureAndLogError } = require(\"../../../errorLogger\");"] },
  { tag: "1", from: ["} = require(\"../briskCertificate\");"], to: ["} = require(\"../../../briskCertificate\");"] },
  { tag: "1+3", from: ["require(\"../breaker\"); // defines the global `Breaker` for a standalone run of this file"], to: ["require(\"../../../breaker\"); // defines the global `Breaker` for a standalone run of this file", "// [MC] 3: the product of the part (OD / TP) and the stop taken while it is not configured", "const { reliancePartProduct, relianceMultiLabel, xpathLiteral } = require(\"./multiConfig\"); // [MC] 3", "const { stopBeforeProduct } = require(\"./stopBeforeProduct\"); // [MC] 3"] },
  { tag: "2", from: ["    screenshotKey = generateScreenshotKey(", "      jobIdentifier,", "      attemptNumber,", "      errorStage", "    );"], to: ["    screenshotKey = generateScreenshotKey(", "      jobIdentifier,", "      attemptNumber,", "      // [MC] 2: under screenshots/multiCompany/ so the existing 10-day S3 lifecycle rule expires it", "      `multiCompany/reliance/${errorStage}`", "    );"] },
  { tag: "6", from: ["async function fillRelianceForm(", ""], to: ["async function fillRelianceMultiForm( // [MC] 6", ""] },
  { tag: "6", from: ["  const jobId = `${data.firstName || \"Job\"}_${Date.now()}`;", "  let jobBrowser = null;"], to: ["  const jobId = `${data.firstName || \"Job\"}_${Date.now()}`;", "  // [MC] 6: which of the two this run is — the part runner sets policyType to the part's key (\"od\" / \"tp\")", "  const mcKind = String(data.policyType || \"\").toLowerCase() === \"tp\" ? \"tp\" : \"od\"; // [MC] 6", "  const mcLabel = relianceMultiLabel(mcKind); // [MC] 6", "  let jobBrowser = null;"] },
  { tag: "6", from: ["module.exports = { fillRelianceForm, getCaptchaScreenShot };"], to: ["module.exports = { fillRelianceMultiForm, getCaptchaScreenShot }; // [MC] 6"] },
  { tag: "3", from: ["    await dropdown.click();", "    await driver.sleep(1000); // Wait for dropdown animation", "", "    // 2. Find the specific option in the popup list and click it.", "    const optionText = \"Two Wheeler Package Bundled (Only New Veh.)\";"], to: ["    await dropdown.click();", "    await driver.sleep(1000); // Wait for dropdown animation", "", "    // [MC] 3: the product of THIS part (RELIANCE_OD_PRODUCT / RELIANCE_TP_PRODUCT), not the bundled one. When it is not", "    // configured the run lists what the portal offers and stops here: nothing is chosen, nothing is bought.", "    const mcProduct = reliancePartProduct(mcKind); // [MC] 3", "    if (!mcProduct) await stopBeforeProduct(driver, { kind: mcKind, jobId }); // [MC] 3", "", "    // 2. Find the specific option in the popup list and click it.", "    const optionText = mcProduct; // [MC] 3"] },
  { tag: "3", from: ["        By.xpath(`//li[normalize-space(.) = '${optionText}']`)"], to: ["        By.xpath(`//li[normalize-space(.) = ${xpathLiteral(optionText)}]`) // [MC] 3"] },
  { tag: "5", from: ["    console.log(\"Selected product by simulating user click.\");", "    await driver.sleep(2000); // Give time for the API call to be made.", ""], to: ["    console.log(\"Selected product by simulating user click.\");", "    await driver.sleep(2000); // Give time for the API call to be made.", "    // [MC] 5: look at the product before the form is filled (a no-op unless the Breaker is switched on in .env)", "    Breaker.checkpoint(`${mcLabel}/product`); // [MC] 5", ""] },
  { tag: "5", from: ["        console.log(\"Clicking 'Calculate Premium' button...\");", "        const calculatePremiumButton = await driver.wait("], to: ["        // [MC] 5: the filled form, before the premium is calculated and anything is saved (no-op unless the Breaker is on)", "        Breaker.checkpoint(`${mcLabel}/quote`); // [MC] 5", "", "        console.log(\"Clicking 'Calculate Premium' button...\");", "        const calculatePremiumButton = await driver.wait("] },
  { tag: "5", from: ["                                // === STEP 10: Click Pay button ===", "                                console.log(\"Looking for Pay button...\");"], to: ["                                // [MC] 5: last look before Pay — the proposal is saved and KYC done (no-op unless the Breaker is on)", "                                Breaker.checkpoint(`${mcLabel}/payment`); // [MC] 5", "", "                                // === STEP 10: Click Pay button ===", "                                console.log(\"Looking for Pay button...\");"] },
  { tag: "5", from: ["      stage: \"login-form\", // Indicate this is a login form error"], to: ["      stage: `${mcKind}-form`, // [MC] 5: which of the two failed (the original says \"login-form\")"] },
  { tag: "4", from: ["    const briskDecision = shouldCreateBriskCertificate(data);", "    const shouldCreateBrisk = briskDecision.create;"], to: ["    // [MC] 4: no inline Brisk certificate. In a multi-company policy PA through Brisk is its own `pa` part (API only,", "    // lib/briskPartRunner.js); buying it here as well would charge the master wallet twice.", "    const briskDecision = { create: false, reason: \"PA through Brisk is its own part of a multi-company policy\" }; // [MC] 4", "    const shouldCreateBrisk = briskDecision.create;"] },
];

/** @returns {string} the copy's text, made from the original's text. Throws when a change no longer applies. */
function build(originalText) {
  let text = String(originalText);
  for (const change of CHANGES) {
    const from = change.from.join("\n");
    const found = text.split(from).length - 1;
    if (found !== 1) {
      throw new Error(
        `[MC] ${change.tag}: the full-company relianceForm.js has this text ${found} time(s), expected exactly once — ` +
          `it changed around an [MC] change; re-state the change in relianceMultiFormSpec.js. Text: ${from.slice(0, 160)}`
      );
    }
    const to = change.to.join("\n");
    text = text.replace(from, () => to);
  }
  return `${HEADER}\n${text}`;
}

/** Where the first difference between two texts is (1-based line), for a failure message. */
function firstDifference(a, b) {
  const x = String(a).split("\n");
  const y = String(b).split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return { line: i + 1, expected: x[i], actual: y[i] };
  }
  return null;
}

module.exports = { build, firstDifference, CHANGES, HEADER, ORIGINAL, COPY };

if (require.main === module) {
  const expected = build(fs.readFileSync(ORIGINAL, "utf8"));
  if (process.argv.includes("--write")) {
    fs.writeFileSync(COPY, expected);
    console.log(`written ${path.relative(process.cwd(), COPY)} (${expected.split("\n").length} lines)`);
  } else {
    const actual = fs.existsSync(COPY) ? fs.readFileSync(COPY, "utf8") : "";
    const diff = firstDifference(expected, actual);
    if (diff) {
      console.error(`relianceMultiForm.js is not what the spec makes of relianceForm.js (first difference at line ${diff.line}).`);
      console.error("Regenerate it:  node multiCompany/common/reliance/relianceMultiFormSpec.js --write");
      process.exit(1);
    }
    console.log("relianceMultiForm.js is exactly what the spec makes of relianceForm.js");
  }
}
