// Run with: node --test test/relianceKycSubmit.test.js
//
// The KYC (OVD upload) page shows SUBMIT only once Reliance has accepted the document, and PROCEED only after a good
// SUBMIT; both exist in the page source the whole time, hidden. The old flow pressed the hidden SUBMIT with a
// JavaScript click ("Please upload valid OVD file only."), printed "SUBMIT completed successfully" and pressed the
// hidden PROCEED. relianceKycSubmit.js waits for the buttons to be ON SCREEN and stops when the portal refuses.
// These tests run it against a stand-in page and a fake clock; no browser, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const kyc = require("../fullPolicycompany/relianceKycSubmit");
const { beautifyError } = require("../lib/errorHandler");

const ERR = "Please upload valid OVD file only.";

/** Run fn with RELIANCE_KYC_SUBMIT_WAIT_ENABLED set (undefined = absent), then put it back. */
function withSwitch(value, fn) {
  const before = process.env.RELIANCE_KYC_SUBMIT_WAIT_ENABLED;
  if (value === undefined) delete process.env.RELIANCE_KYC_SUBMIT_WAIT_ENABLED;
  else process.env.RELIANCE_KYC_SUBMIT_WAIT_ENABLED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.RELIANCE_KYC_SUBMIT_WAIT_ENABLED;
    else process.env.RELIANCE_KYC_SUBMIT_WAIT_ENABLED = before;
  }
}

/* ------------------------- a stand-in page with a fake clock ------------------------- */

const btn = (over = {}) => ({ exists: true, shown: false, enabled: true, ...over });
const page = (over = {}) => ({
  submit: btn(),
  proceed: btn(),
  errors: [],
  ...over,
});

/**
 * @param {Array<{at:number, set:Object}>} timeline  from `at` ms on, the page is `set` (merged over the previous state)
 */
function scripted(timeline, initial = page()) {
  let t = 0;
  let state = initial;
  const steps = [...timeline].sort((a, b) => a.at - b.at);
  const apply = () => {
    while (steps.length && steps[0].at <= t) state = { ...state, ...steps.shift().set };
  };
  return {
    driver: {
      async executeScript() {
        apply();
        return state;
      },
    },
    opts: {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
    time: () => t,
  };
}

/* ------------------------- waiting for SUBMIT ------------------------- */

test("SUBMIT already on screen -> ready at once", async () => {
  const s = scripted([], page({ submit: btn({ shown: true }) }));
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "ready");
  assert.equal(s.time(), 0);
});

test("SUBMIT exists but is hidden: it is waited for, however late it appears — never pressed early", async () => {
  // the 2026-10-14 case: the old flow gave it 3 s, then pressed the hidden button
  const s = scripted([{ at: 17500, set: { submit: btn({ shown: true }) } }]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "ready");
  assert.ok(r.waitedMs >= 17500, `waited ${r.waitedMs} ms — must not be ready before the button is on screen`);
});

test("a shown button that is disabled is not ready", async () => {
  const s = scripted([{ at: 4000, set: { submit: btn({ shown: true, enabled: true }) } }], page({ submit: btn({ shown: true, enabled: false }) }));
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "ready");
  assert.ok(r.waitedMs >= 4000);
});

test("an error that stays with no SUBMIT is a refusal — reported with the portal's words, after the stable window", async () => {
  const s = scripted([{ at: 1000, set: { errors: [ERR] } }]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "rejected");
  assert.equal(r.text, ERR);
  assert.ok(r.waitedMs >= 1000 + 20000, `needs the error to stay for 20 s (was ${r.waitedMs} ms)`);
});

test("an error that flashes while the upload is processed is not a refusal once SUBMIT appears", async () => {
  const s = scripted([
    { at: 500, set: { errors: [ERR] } },
    { at: 9000, set: { errors: [], submit: btn({ shown: true }) } },
  ]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "ready");
});

test("SUBMIT appearing wins over a message that is still on screen at that moment", async () => {
  const s = scripted([
    { at: 100, set: { errors: [ERR] } },
    { at: 15000, set: { submit: btn({ shown: true }) } }, // the stale message is still there
  ]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "ready");
});

test("a changing message restarts the stable window", async () => {
  const s = scripted([
    { at: 0, set: { errors: ["Uploading 1 of 2"] } },
    { at: 15000, set: { errors: [ERR] } },
  ]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "rejected");
  assert.equal(r.text, ERR);
  assert.ok(r.waitedMs >= 15000 + 20000, `the new text must stay for the full window (was ${r.waitedMs} ms)`);
});

test("what the page already showed before the upload (a permanent hint) is not a refusal", async () => {
  const hint = "Only image or PDF files are accepted";
  const s = scripted([{ at: 30000, set: { submit: btn({ shown: true }) } }], page({ errors: [hint] }));
  const r = await kyc.waitForKycSubmitReady(s.driver, { ...s.opts, ignoreErrors: [hint] });
  assert.equal(r.state, "ready");
  assert.ok(r.waitedMs >= 30000);

  // without being told, the same hint would be taken for a refusal after the stable window
  const s2 = scripted([{ at: 30000, set: { submit: btn({ shown: true }) } }], page({ errors: [hint] }));
  assert.equal((await kyc.waitForKycSubmitReady(s2.driver, s2.opts)).state, "rejected");
});

test("nothing happens and no message -> timeout, with no text", async () => {
  const s = scripted([]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "timeout");
  assert.equal(r.text, "");
  assert.ok(r.waitedMs >= 90000);
});

test("a page that cannot be read right now is 'nothing yet', never a throw", async () => {
  let n = 0;
  const driver = {
    async executeScript() {
      if (n++ < 3) throw new Error("page is navigating");
      return page({ submit: btn({ shown: true }) });
    },
  };
  let t = 0;
  const r = await kyc.waitForKycSubmitReady(driver, { now: () => t, sleep: async (ms) => (t += ms) });
  assert.equal(r.state, "ready");
  assert.equal(n, 4);
});

/* ------------------------- waiting for the page after SUBMIT ------------------------- */

test("PROCEED is in the page source but hidden: the page after SUBMIT has NOT opened (the old flow clicked it anyway)", async () => {
  // refused: error text stays, PROCEED exists the whole time but is never shown
  const s = scripted([{ at: 2000, set: { errors: [ERR] } }], page({ submit: btn({ shown: true }), proceed: btn({ shown: false }) }));
  const r = await kyc.waitForKycProceed(s.driver, s.opts);
  assert.equal(r.state, "rejected");
  assert.equal(r.text, ERR);
  assert.ok(r.waitedMs >= 2000 + 15000);
});

test("a slow but good SUBMIT: PROCEED comes on screen later -> ready, whatever message was showing", async () => {
  const s = scripted([
    { at: 1000, set: { errors: [ERR] } }, // stale text from before
    { at: 11000, set: { proceed: btn({ shown: true }) } },
  ]);
  const r = await kyc.waitForKycProceed(s.driver, s.opts);
  assert.equal(r.state, "ready");
  assert.ok(r.waitedMs >= 11000);
});

test("after SUBMIT nothing moves for the whole wait -> timeout", async () => {
  const s = scripted([]);
  const r = await kyc.waitForKycProceed(s.driver, s.opts);
  assert.equal(r.state, "timeout");
  assert.ok(r.waitedMs >= 120000);
});

/* ------------------------- reading the real markup (stub DOM) ------------------------- */

// The real page (Arya.ai KYC onboarding, an Angular app — read from a saved page source on 2026-10-14):
//   SUBMIT   button[ng-click="uploadFilesToAPI()"]   several of them (Individual / Corporate tabs), ng-show="file1 || file2"
//   PROCEED  button[ng-click="redirectToURL()"]      in the result form
//   errors   toast  .ui-notification.error > .message  (a dismissed one keeps the class "killed")
//            popup  .api-error-div  with the text in #api-error
//            expired session  .refresh-div > h5
function el({ text = "", shown = true, disabled = false, className = "", attrs = {}, kids = {} } = {}) {
  return {
    innerText: text,
    value: text,
    disabled,
    className,
    hasAttribute: (n) => (n === "disabled" ? disabled : n in attrs),
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    querySelector: (sel) => kids[sel] || null,
    getBoundingClientRect: () => ({ width: shown ? 120 : 0, height: shown ? 30 : 0 }),
    style: { display: shown ? "block" : "none", visibility: "visible", opacity: "1" },
  };
}
function readIn({ lists = {}, one = {}, ids = {} }, want) {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    querySelector: (sel) => one[sel] || null,
    querySelectorAll: (sel) => lists[sel] || [],
    getElementById: (id) => ids[id] || null,
  };
  globalThis.window = { getComputedStyle: (e) => e.style };
  try {
    return kyc.readKycPageInPage(want);
  } finally {
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
    if (saved.window === undefined) delete globalThis.window;
    else globalThis.window = saved.window;
  }
}
const SUBMIT_SEL = "button[ng-click='uploadFilesToAPI()'], input[type=button][ng-click='uploadFilesToAPI()']";
const PROCEED_SEL = "button[ng-click='redirectToURL()'], input[type=button][ng-click='redirectToURL()']";
const toast = (message, { className = "ui-notification error", shown = true } = {}) =>
  el({ className, shown, text: `x ${message}`, kids: { ".message": el({ text: message, shown }) } });

test("in page: SUBMIT hidden + PROCEED hidden + a toast reads as exactly that (the toast's message, not its frame)", () => {
  const read = readIn({
    lists: {
      [SUBMIT_SEL]: [el({ text: "SUBMIT", shown: false })],
      [PROCEED_SEL]: [el({ text: "PROCEED", shown: false })],
      ".ui-notification": [toast(ERR)],
    },
  });
  assert.deepEqual(read.submit, { exists: true, shown: false, enabled: true });
  assert.deepEqual(read.proceed, { exists: true, shown: false, enabled: true });
  assert.deepEqual(read.errors, [ERR]);
});

test("in page: only a toast that is an error, not dismissed and on screen is a message", () => {
  const read = readIn({
    lists: {
      ".ui-notification": [
        toast(ERR),
        toast("Document uploaded", { className: "ui-notification success" }), // not an error
        toast("An old one", { className: "ui-notification error killed" }), // dismissed, still in the DOM
        toast("Template", { shown: false }), // not on screen
        toast("   "), // empty
      ],
    },
  });
  assert.deepEqual(read.errors, [ERR]);
});

test("in page: the page has several SUBMIT buttons — the one on screen is the answer, and the one that is returned to click", () => {
  const corporate = el({ text: "SUBMIT", shown: false });
  const individual = el({ text: "SUBMIT", shown: true });
  const lists = { [SUBMIT_SEL]: [corporate, individual] };
  const read = readIn({ lists });
  assert.deepEqual(read.submit, { exists: true, shown: true, enabled: true });
  assert.equal(readIn({ lists }, "submit"), individual, "the displayed one is returned, not the first match");

  const disabledShown = el({ text: "SUBMIT", shown: true, disabled: true });
  const enabledShown = el({ text: "SUBMIT", shown: true });
  assert.equal(readIn({ lists: { [SUBMIT_SEL]: [disabledShown, enabledShown] } }, "submit"), enabledShown);
  assert.deepEqual(readIn({ lists: { [SUBMIT_SEL]: [disabledShown] } }).submit, { exists: true, shown: true, enabled: false });
});

test("in page: the API-failure popup is read from #api-error, and only while the popup is on screen", () => {
  const apiError = el({ text: "Unable to verify the document at the moment" });
  const read = readIn({ one: { ".api-error-div": el({ shown: true }) }, ids: { "api-error": apiError } });
  assert.deepEqual(read.errors, ["Unable to verify the document at the moment"]);

  const hidden = readIn({ one: { ".api-error-div": el({ shown: false }) }, ids: { "api-error": apiError } });
  assert.deepEqual(hidden.errors, []);
});

test("in page: an expired session (.refresh-div) is read from its heading", () => {
  const heading = el({ text: "Session expired. Please refresh" });
  const read = readIn({ one: { ".refresh-div": el({ shown: true, kids: { h5: heading } }) } });
  assert.deepEqual(read.errors, ["Session expired. Please refresh"]);
});

test("in page: the buttons are found by their text when the ng-click is not there; disabled is read", () => {
  const read = readIn({
    lists: {
      "button, input[type=button], input[type=submit]": [el({ text: "Cancel" }), el({ text: " Submit ", disabled: true }), el({ text: "PROCEED ➜" })],
    },
  });
  assert.deepEqual(read.submit, { exists: true, shown: true, enabled: false });
  assert.deepEqual(read.proceed, { exists: true, shown: true, enabled: true });
});

test("in page: an over-long text and an alert that is not on screen are not taken for the message", () => {
  const read = readIn({
    lists: {
      ".ui-notification": [toast("x ".repeat(200))],
      "[role='alert'], .alert-danger": [el({ text: "template alert", shown: false }), el({ text: ERR })],
    },
  });
  assert.deepEqual(read.errors, [ERR]);
});

test("in page: nothing on the page -> no buttons, no errors (never a throw)", () => {
  const read = readIn({});
  assert.deepEqual(read.submit, { exists: false, shown: false, enabled: false });
  assert.deepEqual(read.proceed, { exists: false, shown: false, enabled: false });
  assert.deepEqual(read.errors, []);
  assert.equal(readIn({}, "submit"), null);
});

/* ------------------------- a toast that has gone is still the answer ------------------------- */

test("a refusal toast is gone in ~5 s: it is still the answer when SUBMIT never comes", async () => {
  // the 2026-10-14 run: Reliance answered "Please upload valid OVD file only." and the toast vanished; the wait that
  // needed the same text on screen for 20 s ended "the portal showed no message"
  const s = scripted([
    { at: 3000, set: { errors: [ERR] } },
    { at: 8000, set: { errors: [] } }, // toast gone
  ]);
  const r = await kyc.waitForKycSubmitReady(s.driver, s.opts);
  assert.equal(r.state, "rejected");
  assert.equal(r.text, ERR, "the portal's words, though it had stopped showing them");
  assert.ok(r.waitedMs >= 3000 + 20000, `the clock runs from when the text FIRST appeared (was ${r.waitedMs} ms)`);
});

test("a toast gone, then nothing until the timeout: the timeout still carries the toast's words", async () => {
  const s = scripted([
    { at: 3000, set: { errors: [ERR] } },
    { at: 8000, set: { errors: [] } },
  ]);
  const r = await kyc.waitForKycSubmitReady(s.driver, { ...s.opts, errorStableMs: 10 * 60 * 1000 });
  assert.equal(r.state, "timeout");
  assert.equal(r.text, ERR);
});

test("a latched toast does not beat SUBMIT arriving: ready wins", async () => {
  const s = scripted([
    { at: 3000, set: { errors: [ERR] } },
    { at: 8000, set: { errors: [] } },
    { at: 15000, set: { submit: btn({ shown: true }) } },
  ]);
  assert.equal((await kyc.waitForKycSubmitReady(s.driver, s.opts)).state, "ready");
});

test("an error the upload step met on the way seeds the wait: it is the answer when the toast was gone before the wait began", async () => {
  const s = scripted([]);
  const r = await kyc.waitForKycSubmitReady(s.driver, { ...s.opts, seenText: ERR });
  assert.equal(r.state, "rejected");
  assert.equal(r.text, ERR);
  assert.ok(r.waitedMs >= 20000 && r.waitedMs < 21000, `the seeded text starts the clock at the wait's start (was ${r.waitedMs} ms)`);

  // and SUBMIT coming up still wins over it
  const s2 = scripted([{ at: 5000, set: { submit: btn({ shown: true }) } }]);
  assert.equal((await kyc.waitForKycSubmitReady(s2.driver, { ...s2.opts, seenText: ERR })).state, "ready");
});

/* ------------------------- the sentence, the error class, the switch ------------------------- */

test("kycStuckMessage: what the portal did, what was sent, that nothing was paid, what to do — in plain words", () => {
  const m = kyc.kycStuckMessage({
    step: "submit",
    state: "rejected",
    text: ERR,
    waitedMs: 41000,
    proposalNumber: "R14102611761",
    file: "Aadhaar.pdf sent as .jpg, 245 KB",
  });
  assert.match(m, /did not accept the Aadhaar document uploaded for KYC/);
  assert.ok(m.includes(`"${ERR}"`), "the portal's words, verbatim, in quotes");
  assert.match(m, /File sent Aadhaar\.pdf sent as \.jpg, 245 KB/);
  assert.match(m, /R14102611761 is saved at Reliance/);
  assert.match(m, /nothing was paid or bought/);
  assert.match(m, /run the policy again/);
  assert.ok(!m.includes(":"), "no colon: beautifyError would cut the sentence at it");
  assert.equal(beautifyError(m, "Reliance"), `[Reliance] ${m}`, "survives the real beautifyError unchopped");
});

test("kycStuckMessage: the four situations, and a colon in the portal's words is neutralised", () => {
  const base = { proposalNumber: "", file: "" };
  assert.match(kyc.kycStuckMessage({ ...base, step: "submit", state: "timeout", waitedMs: 90000 }), /did not make its SUBMIT button available within 90 s/);
  assert.match(kyc.kycStuckMessage({ ...base, step: "proceed", state: "rejected", text: ERR, waitedMs: 30000 }), /refused the KYC documents when SUBMIT was pressed/);
  assert.match(kyc.kycStuckMessage({ ...base, step: "proceed", state: "timeout", waitedMs: 120000 }), /did not open the page after SUBMIT within 120 s/);
  assert.match(kyc.kycStuckMessage({ ...base, step: "submit", state: "timeout", waitedMs: 5000 }), /The portal showed no message/);

  const colon = kyc.kycStuckMessage({ step: "submit", state: "rejected", text: "Error: file not valid", waitedMs: 1000 });
  assert.ok(!colon.includes(":"));
  assert.match(beautifyError(colon, "Reliance"), /^\[Reliance\] Reliance did not accept the Aadhaar document/);
});

test("describeUploadedFile: name, the extension it was sent as, and the size", () => {
  const tmp = path.join(require("node:os").tmpdir(), `kyc_fixture_${process.pid}.jpg`);
  fs.writeFileSync(tmp, Buffer.alloc(250 * 1024, 1));
  try {
    assert.equal(kyc.describeUploadedFile({ fileName: "Aadhaar.pdf", filePath: tmp }), "Aadhaar.pdf sent as .jpg, 250 KB");
    assert.equal(kyc.describeUploadedFile({ fileName: "a: b.pdf", size: 10 }), "a - b.pdf, 1 KB");
    assert.equal(kyc.describeUploadedFile({}), "");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("PortalRejectedError carries the flag the nested catches look for", () => {
  const e = new kyc.PortalRejectedError("no", { stage: "kyc-submit", portalText: ERR });
  assert.equal(e.portalRejected, true);
  assert.equal(e.name, "PortalRejectedError");
  assert.equal(e.stage, "kyc-submit");
  assert.equal(e.portalText, ERR);
  assert.ok(e instanceof Error);
});

test("the switch is ON unless explicitly false / 0 / no / off", () => {
  withSwitch(undefined, () => assert.equal(kyc.isKycSubmitWaitEnabled(), true));
  for (const on of ["true", "1", "yes", "on", "", "anything"]) {
    withSwitch(on, () => assert.equal(kyc.isKycSubmitWaitEnabled(), true, `"${on}" keeps it on`));
  }
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    withSwitch(off, () => assert.equal(kyc.isKycSubmitWaitEnabled(), false, `"${off}" turns it off`));
  }
});

/* ------------------------- relianceForm.js uses it in the right places ------------------------- */

const formSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
const at = (needle, from = 0) => {
  const i = formSrc.indexOf(needle, from);
  assert.ok(i >= 0, `missing in relianceForm.js: ${needle}`);
  return i;
};

test("relianceForm.js: the baseline is read before any upload, and SUBMIT is waited for before it is pressed", () => {
  const baseline = at("const kycBaseline = isKycSubmitWaitEnabled()");
  const file1 = at("await uploadKycDocument(driver, slot, absoluteFilePath, {", baseline);
  const waitSubmit = at("await waitForKycSubmitReady(driver, {", file1);
  assert.match(formSrc.slice(waitSubmit, waitSubmit + 200), /ignoreErrors: kycBaseline/, "the pre-upload baseline is passed");
  assert.match(formSrc.slice(waitSubmit, waitSubmit + 300), /seenText: kycSeenAfterUpload/, "and what the upload step saw");
  assert.match(formSrc.slice(waitSubmit, waitSubmit + 600), /onProgress/, "and a wait of minutes says it is still waiting");
  const refuse1 = at('step: "submit"', waitSubmit);
  const thrown1 = at("throw new PortalRejectedError(", waitSubmit);
  const clicked = at('console.log("✅ Clicked SUBMIT button");', thrown1);
  assert.ok(baseline < file1 && file1 < waitSubmit && waitSubmit < thrown1 && thrown1 < clicked);
  assert.ok(refuse1 > waitSubmit);
  // the old 3 s sleep + hidden-button click survives only in the switch-off branch
  const oldSleep = at('console.log("⚠️  SUBMIT button exists but is not visible yet, waiting...");', waitSubmit);
  assert.ok(oldSleep < clicked);
  assert.match(formSrc.slice(waitSubmit, oldSleep), /\}\s*else\s*\{\s*(\/\/[^\n]*\n\s*)*const isDisplayed/);
});

test("relianceForm.js: after SUBMIT the page after it is waited for; 'completed successfully' only in the switch-off branch", () => {
  const clicked = at('console.log("✅ Clicked SUBMIT button");');
  const api = at('console.log("⏳ Waiting for API response after SUBMIT...");', clicked);
  const gate = at("if (isKycSubmitWaitEnabled()) {", api);
  const waitProceed = at("await waitForKycProceed(driver, {", gate);
  assert.match(formSrc.slice(waitProceed, waitProceed + 200), /ignoreErrors: kycBaseline/);
  assert.match(formSrc.slice(waitProceed, waitProceed + 600), /onProgress/);
  const thrown = at("throw new PortalRejectedError(", waitProceed);
  const accepted = at("✅ SUBMIT accepted — the next page is open", thrown);
  const elseBranch = at("} else {", accepted);
  const oldSuccess = at('console.log("✅ SUBMIT completed successfully");', elseBranch);
  const oldTen = at("await driver.sleep(10000);", oldSuccess);
  const proceedSearch = at('console.log("Looking for PROCEED button...");', oldTen);
  assert.ok(clicked < api && api < gate && gate < waitProceed && waitProceed < thrown && thrown < accepted);
  assert.ok(accepted < elseBranch && elseBranch < oldSuccess && oldSuccess < oldTen && oldTen < proceedSearch);
  assert.equal(formSrc.split('"✅ SUBMIT completed successfully"').length - 1, 1, "printed in exactly one place");
});

test("relianceForm.js: every nested catch of the KYC step lets a portal refusal through", () => {
  for (const [v] of [["submitErr"], ["uploadErr"]]) {
    assert.ok(formSrc.includes(`if (isAutomationStop(${v}) || ${v}.portalRejected) throw ${v};`), v);
  }
  const outer = at('if (isAutomationStop(err) || err.portalRejected) throw err;');
  const warn = at('documentUploadError = `Aadhaar document upload to portal failed: ${err.message}`;', outer);
  assert.ok(outer < warn, "the non-fatal warning is only for errors that are not a portal refusal");
});

/* ------------------------- the document that is uploaded ------------------------- */

// What the run of 2026-10-14 actually uploaded to Reliance as the Aadhaar: S3's answer to an expired link.
const S3_EXPIRED =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Request has expired</Message>' +
  "<X-Amz-Expires>300</X-Amz-Expires><Expires>2026-10-14T05:29:04Z</Expires><ServerTime>2026-10-14T05:36:17Z</ServerTime>" +
  "<RequestId>ABC123</RequestId><HostId>xyz</HostId></Error>";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF"), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(100, 2)]);

function withTempFile(bytes, name, fn) {
  const file = path.join(require("node:os").tmpdir(), `kyc_doc_${process.pid}_${name}`);
  fs.writeFileSync(file, bytes);
  try {
    return fn(file);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      /* may have been renamed by the test */
    }
  }
}

test("sniffDocumentBytes: real documents by their first bytes, S3's error body and other junk as what they are", () => {
  assert.equal(kyc.sniffDocumentBytes(JPEG).kind, "jpeg");
  assert.equal(kyc.sniffDocumentBytes(PNG).kind, "png");
  assert.equal(kyc.sniffDocumentBytes(PDF).kind, "pdf");
  assert.equal(kyc.sniffDocumentBytes(Buffer.from("GIF89a....")).kind, "gif");
  assert.equal(kyc.sniffDocumentBytes(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])).kind, "webp");

  assert.equal(kyc.sniffDocumentBytes(Buffer.from(S3_EXPIRED)).kind, "xml");
  assert.equal(kyc.sniffDocumentBytes(Buffer.from("﻿  <Error><Code>NoSuchKey</Code></Error>")).kind, "xml");
  assert.equal(kyc.sniffDocumentBytes(Buffer.from("<!DOCTYPE html><html>403</html>")).kind, "html");
  assert.equal(kyc.sniffDocumentBytes(Buffer.from('{"message":"Forbidden"}')).kind, "json");
  assert.equal(kyc.sniffDocumentBytes(Buffer.alloc(0)).kind, "empty");
  assert.equal(kyc.sniffDocumentBytes(null).kind, "empty");
  assert.equal(kyc.sniffDocumentBytes(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])).kind, "unknown", "unknown binary is let through");
});

test("s3ErrorOf reads the code and message out of S3's error body", () => {
  assert.deepEqual(kyc.s3ErrorOf(S3_EXPIRED), { code: "AccessDenied", message: "Request has expired" });
  assert.deepEqual(kyc.s3ErrorOf("<Error><Code>NoSuchKey</Code></Error>"), { code: "NoSuchKey", message: "" });
  assert.equal(kyc.s3ErrorOf("just text"), null);
  assert.equal(kyc.s3ErrorOf(""), null);
});

test("inspectDocumentFile: the expired-link XML saved as a .jpg is NOT a document; a real picture or PDF is", () => {
  withTempFile(Buffer.from(S3_EXPIRED), "expired.jpg", (file) => {
    const r = kyc.inspectDocumentFile(file);
    assert.equal(r.ok, false);
    assert.equal(r.kind, "xml");
    assert.equal(r.size, Buffer.byteLength(S3_EXPIRED));
    assert.deepEqual(r.s3, { code: "AccessDenied", message: "Request has expired" });
  });
  withTempFile(JPEG, "real.jpg", (file) => {
    const r = kyc.inspectDocumentFile(file);
    assert.equal(r.ok, true);
    assert.equal(r.kind, "jpeg");
    assert.equal(r.extension, ".jpg");
    assert.equal(r.s3, null);
  });
  withTempFile(PDF, "real_but_named.jpg", (file) => {
    const r = kyc.inspectDocumentFile(file);
    assert.equal(r.ok, true);
    assert.equal(r.kind, "pdf");
    assert.equal(r.extension, ".pdf", "tells the caller the extension it must carry");
  });
  withTempFile(Buffer.alloc(0), "empty.jpg", (file) => {
    const r = kyc.inspectDocumentFile(file);
    assert.equal(r.ok, false);
    assert.equal(r.kind, "empty");
  });
});

test("kycDocumentMessage: says what S3 answered, that nothing reached Reliance or was paid, in plain words", () => {
  const s3 = kyc.kycDocumentMessage({
    inspected: { ok: false, kind: "xml", size: 387, s3: { code: "AccessDenied", message: "Request has expired" } },
    fileName: "Aadhaar.pdf",
    freshLink: true,
  });
  assert.match(s3, /could not be downloaded from storage/);
  assert.match(s3, /S3 answered "AccessDenied - Request has expired" instead of the file even with a fresh link/);
  assert.match(s3, /Nothing was uploaded to Reliance/);
  assert.match(s3, /nothing was paid or bought/);
  assert.ok(!s3.includes(":"));
  assert.equal(beautifyError(s3, "Reliance"), `[Reliance] ${s3}`);

  assert.match(kyc.kycDocumentMessage({ inspected: { kind: "empty", size: 0, s3: null } }), /is empty/);
  assert.match(kyc.kycDocumentMessage({ inspected: { kind: "html", size: 900, s3: null } }), /is not a picture or a PDF \(it is html data, 900 bytes\)/);
  assert.doesNotMatch(kyc.kycDocumentMessage({ inspected: { kind: "xml", size: 1, s3: { code: "X", message: "" } } }), /even with a fresh link/);
});

test("KycDocumentError is a refusal that ends the policy, with its own stage", () => {
  const e = new kyc.KycDocumentError("no", { portalText: "AccessDenied Request has expired" });
  assert.equal(e.portalRejected, true, "the nested catches let it through");
  assert.equal(e.stage, "kyc-document");
  assert.equal(e.name, "KycDocumentError");
  assert.ok(e instanceof kyc.PortalRejectedError);
});

test("relianceForm.js: a fresh link is minted from the key before the stored one is used, and the file is inspected before any upload", () => {
  const fresh = at("let aadharLinkIsFresh = false;");
  const mint = at("aadharDownloadUrl = await getPresignedUrl(data.aadharCard.key);", fresh);
  const stored = at("if (!aadharDownloadUrl) aadharDownloadUrl = data.aadharCard?.presignedUrl;", mint);
  assert.ok(fresh < mint && mint < stored, "fresh first, the stored link only as a fallback");
  assert.match(formSrc.slice(fresh, mint), /if \(isKycSubmitWaitEnabled\(\) && data\.aadharCard\?\.key\)/);

  const download = at("let tempFilePath = await downloadFileFromS3(aadharDownloadUrl, data.aadharCard.fileName);", stored);
  const inspect = at("const inspected = inspectDocumentFile(tempFilePath);", download);
  const refuse = at("throw new KycDocumentError(", inspect);
  const rename = at("fs.renameSync(tempFilePath, renamed);", refuse);
  const absolute = at("const absoluteFilePath = path.resolve(tempFilePath);", rename);
  const file1 = at("await uploadKycDocument(driver, slot, absoluteFilePath, {", absolute);
  assert.ok(download < inspect && inspect < refuse && refuse < rename && rename < absolute && absolute < file1);
  assert.match(formSrc.slice(inspect - 200, inspect), /if \(isKycSubmitWaitEnabled\(\)\) \{\s*$/);
});

/* ------------------------- long waits say they are still waiting ------------------------- */

test("a long wait reports progress every 15 s, with what the page says, and a failing callback does not end it", async () => {
  const seen = [];
  const s = scripted([{ at: 50000, set: { submit: btn({ shown: true }) } }], page({ errors: [ERR] }));
  const r = await kyc.waitForKycSubmitReady(s.driver, {
    ...s.opts,
    errorStableMs: 10 * 60 * 1000, // not what is under test here
    onProgress: (p) => {
      seen.push(p);
      throw new Error("a logger that throws");
    },
  });
  assert.equal(r.state, "ready");
  assert.ok(seen.length >= 3, `progress was reported ${seen.length} times over ${r.waitedMs} ms`);
  assert.equal(seen[0].which, "submit");
  assert.equal(seen[0].text, ERR);
  assert.ok(seen[0].waitedMs >= 15000 && seen[0].waitedMs < 16000);
  assert.ok(seen[1].waitedMs - seen[0].waitedMs >= 15000);
});

test("the waits are long enough for a slow Reliance: SUBMIT 2 minutes, the page after it 5 minutes", async () => {
  const a = scripted([]);
  const submit = await kyc.waitForKycSubmitReady(a.driver, a.opts);
  assert.equal(submit.state, "timeout");
  assert.ok(submit.waitedMs >= 120000 && submit.waitedMs < 125000, `SUBMIT wait ended at ${submit.waitedMs} ms`);

  const b = scripted([]);
  const proceed = await kyc.waitForKycProceed(b.driver, b.opts);
  assert.equal(proceed.state, "timeout");
  assert.ok(proceed.waitedMs >= 300000 && proceed.waitedMs < 305000, `PROCEED wait ended at ${proceed.waitedMs} ms`);
});

/* ------------------------- telling the View page ("KYC failed — upload the document manually") ------------------------- */

/** A stand-in for the mongodb driver's MongoClient that records what the code does with it. */
function fakeMongo({ connectError = null, matched = 1 } = {}) {
  const log = { constructed: 0, connected: 0, closed: 0, updates: [] };
  class FakeClient {
    constructor(uri) {
      log.constructed++;
      log.uri = uri;
    }
    async connect() {
      log.connected++;
      if (connectError) throw connectError;
    }
    db() {
      return {
        collection: (name) => ({
          async updateOne(filter, update) {
            log.updates.push({ collection: name, filter, update });
            return { matchedCount: matched };
          },
        }),
      };
    }
    async close() {
      log.closed++;
    }
  }
  return { FakeClient, log };
}

const quietly = async (fn) => {
  const saved = { log: console.log, warn: console.warn };
  console.log = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
};

test("saveKycStatus: writes the note on the policy, with the raw driver, and closes the connection", async () => {
  const { FakeClient, log } = fakeMongo();
  const ok = await quietly(() =>
    kyc.saveKycStatus('Reliance refused the documents at SUBMIT - it said "x"', { _id: "p1" }, "job1", { MongoClient: FakeClient })
  );
  assert.equal(ok, true);
  assert.equal(log.updates.length, 1);
  assert.equal(log.updates[0].collection, "onlinePolicy");
  assert.deepEqual(log.updates[0].filter, { _id: "p1" });
  assert.equal(log.updates[0].update.$set.kycStatus, 'Reliance refused the documents at SUBMIT - it said "x"');
  assert.ok(log.updates[0].update.$set.updatedAt instanceof Date);
  assert.equal(log.closed, 1);
});

test("saveKycStatus: a falsy status CLEARS the note (KYC accepted, or a new attempt starts)", async () => {
  const { FakeClient, log } = fakeMongo();
  await quietly(() => kyc.saveKycStatus(null, { policyId: "p9" }, "job1", { MongoClient: FakeClient }));
  assert.deepEqual(log.updates[0].filter, { _id: "p9" }, "the policy id may come as policyId");
  assert.deepEqual(log.updates[0].update.$unset, { kycStatus: "" });
  assert.equal("kycStatus" in (log.updates[0].update.$set || {}), false);
});

test("saveKycStatus: never throws — no policy id, an unreachable database, a policy that is gone", async () => {
  const none = fakeMongo();
  assert.equal(await quietly(() => kyc.saveKycStatus("x", {}, "job1", { MongoClient: none.FakeClient })), false);
  assert.equal(none.log.constructed, 0, "no policy id -> the database is not even contacted");

  const down = fakeMongo({ connectError: new Error("connection refused") });
  assert.equal(await quietly(() => kyc.saveKycStatus("x", { _id: "p1" }, "job1", { MongoClient: down.FakeClient })), false);
  assert.equal(down.log.closed, 1, "the client is closed even when connect failed");

  const gone = fakeMongo({ matched: 0 });
  assert.equal(await quietly(() => kyc.saveKycStatus("x", { _id: "p1" }, "job1", { MongoClient: gone.FakeClient })), false);
});

test("the reasons the View page shows: one line each, no 'the portal said' framing, no colon outside quotes", () => {
  const outsideQuotes = (s) => s.replace(/"[^"]*"/g, "");
  const cases = [
    [{ step: "submit", state: "rejected", text: ERR }, `Reliance did not accept the uploaded Aadhaar - it said "${ERR}"`],
    [{ step: "submit", state: "timeout", waitedMs: 120000 }, "Reliance did not make SUBMIT available within 120 s of the upload"],
    [{ step: "proceed", state: "rejected", text: ERR }, `Reliance refused the documents at SUBMIT - it said "${ERR}"`],
    [{ step: "proceed", state: "timeout", waitedMs: 300000 }, "Reliance did not open the next page within 300 s of SUBMIT (it showed no message)"],
  ];
  for (const [input, expected] of cases) {
    const got = kyc.kycReasonText(input);
    assert.equal(got, expected);
    assert.ok(!outsideQuotes(got).includes(":"), got);
    assert.ok(!got.includes("\n"));
  }
  assert.equal(
    kyc.kycReasonText({ step: "submit", state: "rejected", text: "Error: not valid" }),
    'Reliance did not accept the uploaded Aadhaar - it said "Error - not valid"',
    "a colon inside the portal's own words is neutralised"
  );

  assert.equal(
    kyc.kycDocumentReasonText({ kind: "xml", s3: { code: "AccessDenied", message: "Request has expired" } }),
    'The Aadhaar could not be downloaded from storage - S3 said "AccessDenied - Request has expired"'
  );
  assert.equal(kyc.kycDocumentReasonText({ kind: "empty" }), "The Aadhaar downloaded from storage is empty");
  assert.equal(
    kyc.kycDocumentReasonText({ kind: "html" }),
    "The Aadhaar downloaded from storage is not a picture or a PDF (it is html data)"
  );
  assert.equal(kyc.KYC_UNFINISHED, "KYC was started but did not finish");
  assert.match(kyc.KYC_NO_DOCUMENT, /^No Aadhaar document was found on the policy/);
});

test("relianceForm.js: the note is set when the upload begins, replaced by the reason before each stop, cleared only on accept", () => {
  const found = at("if (data.aadharCard && aadharDownloadUrl) {");
  const marker = at("if (isKycSubmitWaitEnabled()) await saveKycStatus(KYC_UNFINISHED, data, jobId);", found);
  const step1 = at('// === STEP 1: Click "UPLOAD DOCUMENT" div ===', marker);
  assert.ok(found < marker && marker < step1, "set once the document and link are ready, before anything is uploaded");

  const docReason = at("await saveKycStatus(kycDocumentReasonText(inspected), data, jobId);", step1);
  const docThrow = at("throw new KycDocumentError(", docReason);
  const submitReason = at('kycReasonText({ step: "submit"', docThrow);
  const submitThrow = at("throw new PortalRejectedError(", submitReason);
  const proceedReason = at('kycReasonText({ step: "proceed"', submitThrow);
  const proceedThrow = at("throw new PortalRejectedError(", proceedReason);
  const accepted = at("✅ SUBMIT accepted — the next page is open", proceedThrow);
  const cleared = at("await saveKycStatus(null, data, jobId);", accepted);
  assert.ok(docReason < docThrow && submitReason < submitThrow && proceedReason < proceedThrow && accepted < cleared);

  // the reason is written BEFORE the stop in each case, and the clear is the only `null` write in the step
  assert.equal(formSrc.split("saveKycStatus(null, data, jobId)").length - 1, 1);
});

test("relianceForm.js: no Aadhaar on the policy is noted; a new attempt starts with a clean note; all behind the switch", () => {
  const noDoc = at('console.log("⚠️ No Aadhar card found in database");');
  assert.match(formSrc.slice(noDoc, noDoc + 220), /if \(isKycSubmitWaitEnabled\(\)\) await saveKycStatus\(KYC_NO_DOCUMENT, data, jobId\);/);

  const unset = at('...(isKycSubmitWaitEnabled() ? { $unset: { kycStatus: "" } } : {}),');
  const kycUrlsSet = at("$set: { kycUrls, updatedAt: new Date() },");
  assert.ok(kycUrlsSet < unset, "saved together with the KYC links at the start of the step");

  // every write sits under the switch: the marker and the two stops' writes are inside `if (isKycSubmitWaitEnabled())`
  const submitReason = at('kycReasonText({ step: "submit"');
  const gate = formSrc.lastIndexOf("if (isKycSubmitWaitEnabled()) {", submitReason);
  assert.ok(gate > 0 && submitReason - gate < 2500, "the SUBMIT reason is written inside the switched branch");
});
