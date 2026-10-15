// Run with: node --test test/relianceCoverDetails.test.js
//
// "Get Coverage Details" on the Reliance portal answers inside #DivCoverDetails: the cover table, or — when Reliance
// refuses — only a sentence. These tests cover reading that div (against a stand-in DOM holding the exact markup the
// portal produced), telling a refusal from a table that is still loading, the operator's sentence, and where the
// flow uses it. No browser, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cover = require("../fullPolicycompany/relianceCoverDetails");
const { beautifyError } = require("../lib/errorHandler");

/** The sentence Reliance wrote into the div on 2026-10-14 (the markup the user pasted). */
const PORTAL_TEXT =
  "No Discount available for mentioned Details.Please Contact Corporate Motor Underwriter " +
  "ErrorCode - BZ|004|14102609663573|BZ|002|14102609409445";

/** Run fn with RELIANCE_COVER_DETAILS_CHECK_ENABLED set (undefined = absent), then put it back. */
function withSwitch(value, fn) {
  const before = process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED;
  if (value === undefined) delete process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED;
  else process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED;
    else process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED = before;
  }
}
const withSwitchAsync = async (value, fn) => {
  const before = process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED;
  if (value === undefined) delete process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED;
  else process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED;
    else process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED = before;
  }
};

/* ------------------------- a stand-in page for the in-page reader ------------------------- */

const element = ({ text = "", controls = 0, display = "block", visibility = "visible", height = 20, width = 640 } = {}) => ({
  innerText: text,
  textContent: text,
  offsetHeight: height,
  offsetWidth: width,
  style: { display, visibility },
  querySelectorAll: () => new Array(controls).fill({}),
});

/** Run the in-page function against `byId` (id -> element), the way the browser would. */
function readIn(byId) {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { getElementById: (id) => byId[id] || null };
  globalThis.window = { getComputedStyle: (el) => el.style };
  try {
    return cover.readCoverDetailsInPage();
  } finally {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  }
}

/** What readCoverDetails returns for a page, for the predicate and wait tests. */
const info = (extra = {}) => ({ exists: true, shown: true, hasPaCheckbox: false, controls: 0, text: "", ...extra });

test("the exact div Reliance produced reads as a sentence with no controls", () => {
  const read = readIn({ DivCoverDetails: element({ text: PORTAL_TEXT }) });
  assert.deepEqual(read, {
    exists: true,
    shown: true,
    hasPaCheckbox: false,
    controls: 0,
    text: PORTAL_TEXT,
  });
  assert.equal(cover.isCoverDetailsRejection(read), true);
  assert.equal(cover.isCoverDetailsRejection(read, { strict: false }), true);
});

test("whitespace in the portal's sentence is collapsed", () => {
  const read = readIn({ DivCoverDetails: element({ text: "  No Discount\n\t available   for details  " }) });
  assert.equal(read.text, "No Discount available for details");
});

test("the cover table is not a refusal — it has controls, and ChkBox24 is there", () => {
  const table = element({ text: "PA to Owner Driver ... Zero Depreciation ... Helmet Cover ... ErrorCode", controls: 7 });
  const read = readIn({ DivCoverDetails: table, ChkBox24: element() });
  assert.equal(read.hasPaCheckbox, true);
  assert.equal(read.controls, 7);
  assert.equal(cover.isCoverDetailsRejection(read), false);
  assert.equal(cover.isCoverDetailsRejection(read, { strict: false }), false);
});

test("a ChkBox24 anywhere on the page means the table loaded, even if the div reads like a sentence", () => {
  const read = readIn({ DivCoverDetails: element({ text: PORTAL_TEXT }), ChkBox24: element() });
  assert.equal(read.hasPaCheckbox, true);
  assert.equal(cover.isCoverDetailsRejection(read), false);
});

test("a hidden div, a collapsed div or no div at all is never a refusal", () => {
  for (const [name, el] of [
    ["display none", element({ text: PORTAL_TEXT, display: "none" })],
    ["visibility hidden", element({ text: PORTAL_TEXT, visibility: "hidden" })],
    ["zero size (a hidden parent)", element({ text: PORTAL_TEXT, height: 0, width: 0 })],
  ]) {
    const read = readIn({ DivCoverDetails: el });
    assert.equal(read.exists, true, name);
    assert.equal(read.shown, false, name);
    assert.equal(cover.isCoverDetailsRejection(read), false, name);
    assert.equal(cover.isCoverDetailsRejection(read, { strict: false }), false, name);
  }
  const none = readIn({});
  assert.equal(none.exists, false);
  assert.equal(cover.isCoverDetailsRejection(none), false);
  assert.equal(cover.isCoverDetailsRejection(null), false);
});

/* ------------------------- telling a refusal from everything else ------------------------- */

test("isCoverDetailsRejection: strict wants an error-looking sentence, lenient takes any short one", () => {
  const strict = (text) => cover.isCoverDetailsRejection(info({ text }));
  const lenient = (text) => cover.isCoverDetailsRejection(info({ text }), { strict: false });

  for (const refusal of [
    PORTAL_TEXT,
    "Vehicle not available for this RTO. ErrorCode - BZ|007|123",
    "Please Contact Corporate Motor Underwriter",
    "Discount not allowed for the selected plan",
    "Invalid IDV",
  ]) {
    assert.equal(strict(refusal), true, refusal);
    assert.equal(lenient(refusal), true, refusal);
  }

  // text that is not obviously an error: never fails a policy that may still load, but explains one that failed
  for (const quiet of ["Please wait", "Cover details", "Loading..."]) {
    assert.equal(strict(quiet), false, quiet);
    assert.equal(lenient(quiet), true, quiet);
  }

  // never a refusal, however it reads
  for (const never of [
    info({ text: "" }),
    info({ text: "   " }),
    info({ text: PORTAL_TEXT, controls: 1 }),
    info({ text: PORTAL_TEXT, hasPaCheckbox: true }),
    info({ text: PORTAL_TEXT, shown: false }),
    info({ text: PORTAL_TEXT, exists: false }),
    info({ text: "ErrorCode ".repeat(80) }), // a page, not a sentence
  ]) {
    assert.equal(cover.isCoverDetailsRejection(never), false);
    assert.equal(cover.isCoverDetailsRejection(never, { strict: false }), false);
  }
  assert.ok("ErrorCode ".repeat(80).length > cover.MAX_MESSAGE_LENGTH);
});

/* ------------------------- waiting for the table or the refusal ------------------------- */

/** A driver whose page shows `frames` one read at a time (the last frame repeats), and a clock that only sleep moves. */
function scripted(frames) {
  let t = 0;
  let reads = 0;
  return {
    driver: {
      executeScript: async () => frames[Math.min(reads++, frames.length - 1)],
    },
    opts: {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
    reads: () => reads,
    time: () => t,
  };
}

test("wait: the table is already there -> loaded on the first read", async () => {
  const s = scripted([info({ hasPaCheckbox: true, controls: 9 })]);
  assert.deepEqual(await cover.waitForCoverDetails(s.driver, s.opts), { state: "loaded" });
  assert.equal(s.reads(), 1);
});

test("wait: a refusal that stays put is reported once it has been stable for a second", async () => {
  const s = scripted([info({ text: PORTAL_TEXT })]);
  const outcome = await cover.waitForCoverDetails(s.driver, s.opts);
  assert.deepEqual(outcome, { state: "rejected", text: PORTAL_TEXT });
  assert.equal(s.time(), 1000, "reads at 0, 500 and 1000 ms — not the 10 s the ChkBox24 wait used to burn");
  assert.equal(s.reads(), 3);
});

test("wait: a message that is replaced by the cover table is NOT a refusal", async () => {
  const s = scripted([info({ text: PORTAL_TEXT }), info({ text: PORTAL_TEXT }), info({ hasPaCheckbox: true, controls: 9 })]);
  assert.deepEqual(await cover.waitForCoverDetails(s.driver, s.opts), { state: "loaded" });
});

test("wait: a message that keeps changing never counts as stable until it stops", async () => {
  const a = "Calculating ... ErrorCode 1";
  const b = "Calculating ... ErrorCode 2";
  const s = scripted([info({ text: a }), info({ text: b }), info({ text: a }), info({ text: b }), info({ text: b }), info({ text: b }), info({ text: b })]);
  const outcome = await cover.waitForCoverDetails(s.driver, s.opts);
  assert.deepEqual(outcome, { state: "rejected", text: b });
  // b first seen on read 4 (t=1500) and must hold for 1000 ms: reported at t=2500
  assert.equal(s.time(), 2500);
});

test("wait: nothing ever shows -> timeout (the caller carries on to its own ChkBox24 wait)", async () => {
  const s = scripted([info({ exists: true, shown: false })]);
  const outcome = await cover.waitForCoverDetails(s.driver, s.opts);
  assert.deepEqual(outcome, { state: "timeout", text: "" });
  assert.equal(s.time(), 6000);
});

test("wait: a sentence that does not read like an error is handed back on timeout, not failed fast", async () => {
  const s = scripted([info({ text: "Please wait" })]);
  const outcome = await cover.waitForCoverDetails(s.driver, s.opts);
  assert.deepEqual(outcome, { state: "timeout", text: "Please wait" });
});

test("wait: a div with controls and an error-looking line is a page, so it times out rather than fails", async () => {
  const s = scripted([info({ text: PORTAL_TEXT, controls: 4 })]);
  assert.equal((await cover.waitForCoverDetails(s.driver, s.opts)).state, "timeout");
});

test("reading never throws: a driver that errors, or a page that answers null, reads as empty", async () => {
  const boom = { executeScript: async () => { throw new Error("no such window"); } };
  assert.deepEqual(await cover.readCoverDetails(boom), { exists: false, shown: false, hasPaCheckbox: false, controls: 0, text: "" });
  const nothing = { executeScript: async () => null };
  assert.equal((await cover.readCoverDetails(nothing)).exists, false);
  // and the wait survives it
  const s = scripted([null]);
  s.driver.executeScript = async () => { throw new Error("session gone"); };
  assert.equal((await cover.waitForCoverDetails(s.driver, s.opts)).state, "timeout");
});

/* ------------------------- the sentence the operator reads ------------------------- */

test("the discount message: Reliance's words verbatim, what was sent, what to fix, and that it must be run again", () => {
  const message = cover.coverDetailsFailureMessage(PORTAL_TEXT, {
    discount: "50",
    vehicle: "HONDA ACTIVA 6G",
    rto: "TN-55BQ",
  });
  assert.ok(message.includes(`"${PORTAL_TEXT}"`), "the portal's text, verbatim, in quotes");
  assert.match(message, /OD discount sent 50%/);
  assert.match(message, /vehicle HONDA ACTIVA 6G/);
  assert.match(message, /RTO TN-55BQ/);
  assert.match(message, /Make & Model master/);
  assert.match(message, /Corporate Motor Underwriter/);
  assert.match(message, /run the policy again/);
  assert.ok(!message.includes(":"), "no colon: beautifyError would cut the sentence at it");
});

test("the discount message survives the real beautifyError unchopped", () => {
  const message = cover.coverDetailsFailureMessage(PORTAL_TEXT, { discount: 50, vehicle: "HONDA ACTIVA", rto: "TN-55BQ" });
  assert.equal(beautifyError(message, "Reliance"), `[Reliance] ${message}`);
  // and as the string the job result carries
  assert.equal(beautifyError(new Error(message), "Reliance"), `[Reliance] ${message}`);
});

test("a colon in the portal's own words does not let beautifyError chop the sentence", () => {
  const message = cover.coverDetailsFailureMessage("Error: No Discount available. ErrorCode: BZ|004", { discount: "50" });
  assert.ok(!message.includes(":"));
  const shown = beautifyError(message, "Reliance");
  assert.match(shown, /^\[Reliance\] No discount is available for the details entered/);
  assert.match(shown, /run the policy again\.$/);
});

test("a refusal that is not about the discount gets the generic sentence, still with the portal's words", () => {
  const text = "Vehicle not available for the selected RTO ErrorCode - BZ|011|777";
  const message = cover.coverDetailsFailureMessage(text, { discount: "60" });
  assert.ok(message.includes(`"${text}"`));
  assert.match(message, /^The portal did not return the cover details \(OD discount sent 60%\)\./);
  assert.doesNotMatch(message, /no discount is available/i);
  assert.match(message, /run the policy again/);
});

test("what was sent is left out when the policy does not carry it", () => {
  const bare = cover.coverDetailsFailureMessage(PORTAL_TEXT, {});
  assert.doesNotMatch(bare, /OD discount sent|vehicle |RTO /);
  assert.match(bare, /cover details\. The portal said/);
  const garbage = cover.coverDetailsFailureMessage(PORTAL_TEXT, { discount: "abc", vehicle: "", rto: null });
  assert.doesNotMatch(garbage, /OD discount sent/);
  assert.match(cover.coverDetailsFailureMessage(PORTAL_TEXT, { discount: "12.5 %" }), /OD discount sent 12\.5%/);
});

test("sentDetails reads what the flow typed from the job data", () => {
  assert.deepEqual(
    cover.sentDetails({ discount: "50", vehicleMake: "HONDA", vehicleModel: "ACTIVA 6G", rtoCityLocation: "TN-55BQ" }),
    { discount: "50", vehicle: "HONDA ACTIVA 6G", rto: "TN-55BQ" }
  );
  assert.deepEqual(cover.sentDetails({}), { discount: undefined, vehicle: "", rto: undefined });
  assert.deepEqual(cover.sentDetails(), { discount: undefined, vehicle: "", rto: undefined });
});

/* ------------------------- the switch, and the screenshot handler's lookup ------------------------- */

test("the switch is ON unless explicitly false / 0 / no / off", () => {
  withSwitch(undefined, () => assert.equal(cover.isCoverDetailsCheckEnabled(), true));
  for (const on of ["true", "1", "yes", "on", "", "anything"]) {
    withSwitch(on, () => assert.equal(cover.isCoverDetailsCheckEnabled(), true, `"${on}" keeps it on`));
  }
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    withSwitch(off, () => assert.equal(cover.isCoverDetailsCheckEnabled(), false, `"${off}" turns it off`));
  }
});

test("readCoverDetailsRejection: the sentence and the operator's message, or null", async () => {
  const driverShowing = (frame) => ({ executeScript: async () => frame });
  const data = { discount: "50", vehicleMake: "HONDA", vehicleModel: "ACTIVA", rtoCityLocation: "TN-55BQ" };

  await withSwitchAsync(undefined, async () => {
    const found = await cover.readCoverDetailsRejection(driverShowing(info({ text: PORTAL_TEXT })), data);
    assert.equal(found.text, PORTAL_TEXT);
    assert.equal(found.message, cover.coverDetailsFailureMessage(PORTAL_TEXT, cover.sentDetails(data)));

    // after a failure even a quiet sentence is the likely cause (lenient)
    const quiet = await cover.readCoverDetailsRejection(driverShowing(info({ text: "Please wait" })), data);
    assert.equal(quiet.text, "Please wait");

    // but never the cover table, nor an empty / missing div
    assert.equal(await cover.readCoverDetailsRejection(driverShowing(info({ hasPaCheckbox: true, controls: 5, text: "x" })), data), null);
    assert.equal(await cover.readCoverDetailsRejection(driverShowing(info({ exists: false })), data), null);
    assert.equal(await cover.readCoverDetailsRejection(driverShowing(info({ text: "" })), data), null);
  });

  await withSwitchAsync("false", async () => {
    let touched = false;
    const spy = { executeScript: async () => { touched = true; return info({ text: PORTAL_TEXT }); } };
    assert.equal(await cover.readCoverDetailsRejection(spy, data), null);
    assert.equal(touched, false, "switch off: the page is not even read");
  });
});

/* ------------------------- relianceForm.js uses it in the right places ------------------------- */

const formSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
const at = (needle, from = 0) => {
  const i = formSrc.indexOf(needle, from);
  assert.ok(i >= 0, `missing in relianceForm.js: ${needle}`);
  return i;
};

test("relianceForm.js: the refusal check sits after Get Coverage Details has answered and before ChkBox24 is waited for", () => {
  const clicked = at("Clicked 'Get Coverage Details' button with multiple methods");
  const loader = at("await waitForLoaderToDisappear(driver);", clicked);
  const check = at("if (isCoverDetailsCheckEnabled()) {", loader);
  const wait = at("await waitForCoverDetails(driver);", check);
  const refusal = at('coverOutcome.state === "rejected"', wait);
  const thrown = at("throw new Error(coverDetailsFailureMessage(coverOutcome.text, sentDetails(data)));", refusal);
  const paLookup = at('until.elementLocated(By.id("ChkBox24"))', thrown);

  assert.ok(clicked < loader && loader < check && check < wait && wait < refusal && refusal < thrown && thrown < paLookup);
  // there is exactly one ChkBox24 lookup in the flow, and the check is before it
  assert.equal(formSrc.split('By.id("ChkBox24")').length - 1, 1);
});

test("relianceForm.js: the error-screenshot handler looks in #DivCoverDetails only when #containerMain gave nothing", () => {
  const containerMain = at("document.getElementById('containerMain')");
  const guard = at("if (!onPageError) {", containerMain);
  const lookup = at("await readCoverDetailsRejection(driver, data);", guard);
  const take = at("await driver.takeScreenshot();", lookup);
  assert.ok(containerMain < guard && guard < lookup && lookup < take);
  assert.match(formSrc.slice(lookup, take), /onPageError = coverRefusal\.message;/);
});

test("relianceForm.js: the refusal still ends as a post-submission failure — nothing about retry or status moved", () => {
  // the throw happens inside the Step-8 try, whose catch records postSubmissionFailed and keeps the on-page error
  const step8 = at("// === STEP 8: Handle post-submission elements ===");
  const thrown = at("throw new Error(coverDetailsFailureMessage(", step8);
  const catchStep8 = at('console.log("Error handling post-submission elements:", err.message);', thrown);
  const flag = at("postSubmissionFailed = true;", catchStep8);
  const adopt = at("postSubmissionError = errorInfo.onPageError;", flag);
  assert.ok(step8 < thrown && thrown < catchStep8 && catchStep8 < flag && flag < adopt);
});

/* ------------------------- a success banner is not the reason a run failed ------------------------- */

test("isPortalSuccessMessage: Reliance's good news is not an error, a complaint that says 'successfully' still is", () => {
  const ok = [
    "Proposal Saved Successfully. The Proposal number is:R14102611761 & Quote Number is:1201226Q23750221043",
    "Customer created successfully",
    "Success",
  ];
  for (const t of ok) assert.equal(cover.isPortalSuccessMessage(t), true, t);

  const complaints = [
    "Please Provide Nominee Name in PA to Owner Driver Nominee Details",
    PORTAL_TEXT,
    "Policy saved successfully but payment failed",
    "Proposal could not be saved successfully",
    "Invalid IDV",
    "",
    "   ",
    null,
    undefined,
  ];
  for (const t of complaints) assert.equal(cover.isPortalSuccessMessage(t), false, String(t));
});

test("relianceForm.js: a success banner in #containerMain is dropped before it can replace the real error", () => {
  const read = at("document.getElementById('containerMain')");
  const guard = at("if (onPageError && isPortalSuccessMessage(onPageError)) {", read);
  const dropped = at("onPageError = null;", guard);
  const extracted = at('console.log("🚩 Extracted on-page error message:", onPageError);', dropped);
  const coverLookup = at("await readCoverDetailsRejection(driver, data);", extracted);
  assert.ok(read < guard && guard < dropped && dropped < extracted && extracted < coverLookup);
});
