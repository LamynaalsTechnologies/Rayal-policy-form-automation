// Run with: node --require ./test/support/noRealWorld.js --test test/relianceKycName.test.js
//
// Reliance's CKYC result page shows the name it read from the Aadhaar in a disabled box (#result_name). It must be the
// policy's Full Name + Surname — the same words in any order — or the policy ends as "KYC name mismatch" BEFORE PROCEED.
// No browser: a stub document stands in for the page, a fake driver runs the in-page functions against it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const kyc = require(path.join(ROOT, "fullPolicycompany", "reliance", "relianceKycName.js"));
const fallback = require(path.join(ROOT, "fullPolicycompany", "reliance", "relianceKycFallback.js"));
const { PortalRejectedError } = require(path.join(ROOT, "fullPolicycompany", "reliance", "relianceKycSubmit.js"));

const cmp = (fullName, surname, portalName) => kyc.compareKycName({ fullName, surname, portalName });

/* ------------------------------ the rule ------------------------------ */

test("the name is the policy's own: case, spacing and punctuation do not matter", () => {
  assert.equal(cmp("ANMOL", "ARORA", "Anmol Arora").ok, true);
  assert.equal(cmp("ANMOL", "ARORA", "  anmol   ARORA ").ok, true);
  assert.equal(cmp("ANMOL", "ARORA", "Anmol, Arora.").ok, true);
  assert.equal(cmp("Rama R.", "Nathan", "RAMA R NATHAN").ok, true);
});

test("the surname may come first or last — any order of the same words", () => {
  assert.equal(cmp("ANMOL", "ARORA", "Arora Anmol").ok, true);
  assert.equal(cmp("ANMOL KUMAR", "ARORA", "Kumar Anmol Arora").ok, true);
});

test("another name, an extra or a missing word is a mismatch, and says which", () => {
  const extra = cmp("ANMOL", "ARORA", "Anmol Kumar Arora");
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.extra, ["kumar"]);
  assert.deepEqual(extra.missing, []);

  const other = cmp("ANMOL", "ARORA", "Rahul Sharma");
  assert.equal(other.ok, false);
  assert.deepEqual(other.missing.sort(), ["anmol", "arora"]);
  assert.deepEqual(other.extra.sort(), ["rahul", "sharma"]);

  assert.equal(cmp("ANMOL", "ARORA", "Anmol").ok, false, "surname missing at Reliance");
  assert.equal(cmp("ANMOL", "ARORA", "Anmol Arora Arora").ok, false, "a repeated word counts");
});

test("a policy without a surname is compared on the Full Name alone; one with no name at all is not comparable", () => {
  assert.equal(cmp("ANMOL ARORA", "", "Anmol Arora").ok, true);
  const none = cmp("", "", "Anmol Arora");
  assert.equal(none.comparable, false);
  assert.equal(none.ok, false);
  assert.equal(cmp("ANMOL", "ARORA", "").ok, false, "an empty portal name never matches");
});

test("accents are folded and words are not matched loosely", () => {
  assert.equal(cmp("JOSÉ", "MUÑOZ", "Jose Munoz").ok, true);
  assert.equal(cmp("ANMOL", "ARORA", "Anmoll Arora").ok, false, "no fuzzy matching");
});

/* --------------------------- the switch --------------------------- */

test("RELIANCE_KYC_NAME_CHECK_ENABLED is ON unless false / 0 / no / off", () => {
  const before = process.env.RELIANCE_KYC_NAME_CHECK_ENABLED;
  try {
    delete process.env.RELIANCE_KYC_NAME_CHECK_ENABLED;
    assert.equal(kyc.isKycNameCheckEnabled(), true);
    for (const off of ["false", "0", "no", "OFF"]) {
      process.env.RELIANCE_KYC_NAME_CHECK_ENABLED = off;
      assert.equal(kyc.isKycNameCheckEnabled(), false, off);
    }
    process.env.RELIANCE_KYC_NAME_CHECK_ENABLED = "true";
    assert.equal(kyc.isKycNameCheckEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.RELIANCE_KYC_NAME_CHECK_ENABLED;
    else process.env.RELIANCE_KYC_NAME_CHECK_ENABLED = before;
  }
});

/* ---------------------- the page and the check ---------------------- */

/** A stub CKYC result page. `box` = { id, name, ngModel, value, attrValue } or null for a page without the box. */
function resultPage({ box, appearsAfterMs = 0 } = {}) {
  const state = { clock: 0, marked: null, scrolled: 0, inserted: [] };
  const el = box && {
    id: box.id || "",
    value: box.value || "",
    style: {},
    parentNode: { insertBefore: (node) => state.inserted.push(node) },
    nextSibling: null,
    getAttribute(name) {
      return name === "value" ? box.attrValue || null : null;
    },
    scrollIntoView() {
      state.scrolled += 1;
    },
  };
  const visible = () => el && state.clock >= appearsAfterMs;
  const documentStub = {
    getElementById: (id) => (visible() && el.id === id ? el : null),
    querySelector: (sel) => {
      if (!visible()) return null;
      if (box.name && sel === "input[name='ckyc_result_name']") return el;
      if (box.ngModel && sel === "input[ng-model='ckyc_result.registered_name']") return el;
      return null;
    },
    createElement: () => ({ style: {}, set textContent(v) { this._t = v; }, get textContent() { return this._t; } }),
  };
  const driver = {
    state,
    async executeScript(fn, ...args) {
      const saved = globalThis.document;
      globalThis.document = documentStub;
      try {
        const result = fn(...args);
        if (fn === kyc.markKycNameMismatchInPage && result) state.marked = args[0];
        return result;
      } finally {
        if (saved === undefined) delete globalThis.document;
        else globalThis.document = saved;
      }
    },
    async sleep(ms) {
      state.clock += ms;
    },
  };
  return driver;
}
const run = (driver, data, extra = {}) =>
  kyc.checkKycName(driver, { data, now: () => driver.state.clock, sleep: (ms) => driver.sleep(ms), ...extra });
const POLICY = { firstName: "ANMOL", lastName: "ARORA" };

test("the name box is found by id, by name or by ng-model; its value comes from .value or the attribute", async () => {
  for (const box of [
    { id: "result_name", value: "Anmol Arora" },
    { name: true, value: "Anmol Arora" },
    { ngModel: true, value: "Anmol Arora" },
    { id: "result_name", value: "", attrValue: "Anmol Arora" },
  ]) {
    const r = await run(resultPage({ box }), POLICY);
    assert.equal(r.state, "match", JSON.stringify(box));
    assert.equal(r.portalName, "Anmol Arora");
  }
});

test("the box is scrolled into view, and filled a moment after the page opens (waited for)", async () => {
  const page = resultPage({ box: { id: "result_name", value: "Arora Anmol" }, appearsAfterMs: 3000 });
  const r = await run(page, POLICY);
  assert.equal(r.state, "match");
  assert.ok(page.state.scrolled >= 1, "scrolled to the box");
});

test("another name: mismatch, the box is marked red for the screenshot, nothing is pressed", async () => {
  const page = resultPage({ box: { id: "result_name", value: "Rahul Sharma" } });
  const r = await run(page, POLICY);
  assert.equal(r.state, "mismatch");
  assert.equal(r.portalName, "Rahul Sharma");
  assert.match(page.state.marked, /KYC NAME MISMATCH - policy: ANMOL ARORA/);
  assert.ok(page.state.inserted.length === 1, "a note was put beside the box");
});

test("a box that is missing or never fills is 'unreadable', not a mismatch", async () => {
  const none = await run(resultPage({ box: null }), POLICY, { waitMs: 2000 });
  assert.equal(none.state, "unreadable");
  assert.match(none.reason, /not on the page/);

  const empty = await run(resultPage({ box: { id: "result_name", value: "" } }), POLICY, { waitMs: 2000 });
  assert.equal(empty.state, "unreadable");
  assert.match(empty.reason, /empty/);
});

test("a policy with no name is not checked (unreadable), never failed", async () => {
  const r = await run(resultPage({ box: { id: "result_name", value: "Anmol Arora" } }), { firstName: "", lastName: "" });
  assert.equal(r.state, "unreadable");
});

/* -------------------- the error and the KYC fallback -------------------- */

test("the mismatch sentence quotes both names, has no colon and says PROCEED was not pressed", () => {
  const message = kyc.kycNameMismatchMessage({ portalName: "Anmol Kumar Arora", fullName: "ANMOL", surname: "ARORA" });
  assert.match(message, /^KYC name mismatch - Reliance's KYC shows "Anmol Kumar Arora" but the policy has Full Name "ANMOL" and Surname "ARORA"\./);
  assert.match(message, /PROCEED was not pressed and nothing was paid\.$/);
  assert.equal(message.includes(":"), false);
  assert.equal(kyc.kycNameMismatchMessage({ portalName: "X: Y", fullName: "A", surname: "" }).includes(":"), false);
});

test("KycNameMismatchError is a portal refusal the nested catches let through, and the KYC fallback uses its words", async () => {
  const message = kyc.kycNameMismatchMessage({ portalName: "Rahul Sharma", fullName: "ANMOL", surname: "ARORA" });
  const error = new kyc.KycNameMismatchError(message, { portalName: "Rahul Sharma" });
  assert.ok(error instanceof PortalRejectedError);
  assert.equal(error.portalRejected, true);
  assert.equal(error.stage, "kyc-name");

  const calls = { shots: 0, reach: 0, links: null, status: 0 };
  const result = await fallback.rescueAfterKycFailure({
    driver: {},
    data: { proposalNumber: "R14102600001" },
    jobId: "job-1",
    error,
    proposalNumber: "R14102600001",
    shots: {
      capturePage: async () => { calls.shots += 1; },
      flush: async () => ({ url: "https://s3/page.png", key: "screenshots/kyc/page.png" }),
    },
    log: () => {},
    deps: {
      reach: async () => {
        calls.reach += 1;
        return { reached: true, paymentUrl: "https://reliance/pay", pendingQuotesUrl: "https://reliance/pq", steps: [] };
      },
      saveLinks: async (links) => {
        calls.links = links;
        return { saved: links };
      },
      saveStatus: async () => { calls.status += 1; },
    },
  });
  assert.equal(calls.shots, 1, "the result page was screenshotted");
  assert.equal(calls.reach, 1, "then the payment page was reached");
  assert.equal(calls.status, 0, "its own note (written by the form) is not overwritten");
  assert.ok(result.message.startsWith("KYC name mismatch - Reliance's KYC shows \"Rahul Sharma\""), result.message);
  assert.equal(result.screenshotUrl, "https://s3/page.png");
});

/* ------------------------------ wiring ------------------------------ */

for (const file of [
  path.join(ROOT, "fullPolicycompany", "relianceForm.js"),
  path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"),
]) {
  test(`${path.basename(file)}: the name is checked after SUBMIT is accepted, before the KYC counts as accepted and before PROCEED`, () => {
    const src = fs.readFileSync(file, "utf8");
    const opened = src.indexOf("SUBMIT accepted — the next page is open");
    const gate = src.indexOf("if (isKycNameCheckEnabled()) {");
    const throwAt = src.indexOf("throw new KycNameMismatchError(");
    const accepted = src.indexOf("kycAccepted = true; // the KYC is done");
    const proceed = src.indexOf("=== STEP 4: Wait for and Click PROCEED button ===");
    assert.ok(opened > 0 && gate > opened, "after the next page opened");
    assert.ok(throwAt > gate && accepted > throwAt, "the throw comes before kycAccepted");
    assert.ok(proceed > accepted, "and PROCEED is later still");
    assert.match(src, /await saveKycStatus\(nameMessage, data, jobId\);/);
    assert.match(src, /require\("(\.|\.\.\/\.\.\/\.\.\/fullPolicycompany)\/reliance\/relianceKycName"\)/);
  });
}

/* ------------------------- the owner's four combinations (RELIANCE_KYC_NAME_COMBINATIONS_ENABLED) ------------------------- */

const combo = (portalName, extra = {}) =>
  kyc.compareKycName({ fullName: "ANMOL ARORA", surname: "MASTER", fatherName: "RAJESH", portalName, combinations: true, ...extra }).ok;

test("combinations: Full Name alone, + Surname, + Father Name, or all three — any word order", () => {
  assert.equal(combo("Anmol Arora"), true, "Full Name alone (the 2026-10-17 log: KYC 'Anmol Arora', Surname MASTER)");
  assert.equal(combo("Anmol Arora Master"), true, "Full Name + Surname");
  assert.equal(combo("Master Anmol Arora"), true, "surname first");
  assert.equal(combo("Anmol Arora Rajesh"), true, "Full Name + Father Name");
  assert.equal(combo("Anmol Arora Rajesh Master"), true, "all three");
  assert.equal(combo("ANMOL ARORA MASTER RAJESH"), true, "all three, other order");
});

test("combinations: anything else is a mismatch", () => {
  assert.equal(combo("Anmol"), false, "part of the Full Name only");
  assert.equal(combo("Arora Master"), false, "without the Full Name");
  assert.equal(combo("Master Rajesh"), false, "Surname + Father Name only");
  assert.equal(combo("Anmol Arora Kumar"), false, "an extra word");
  assert.equal(combo("Rahul Sharma"), false, "another person");
  assert.equal(combo(""), false, "nothing read");
  assert.equal(combo("Anmol Arora Rajesh", { fatherName: "" }), false, "no Father Name on the policy");
  assert.equal(combo("Anmol Arora", { fullName: "" }), false, "no Full Name on the policy");
});

test("combinations off: the old rule (Full Name + Surname only)", () => {
  assert.equal(combo("Anmol Arora", { combinations: false }), false);
  assert.equal(combo("Anmol Arora Master", { combinations: false }), true);
  assert.equal(combo("Anmol Arora Rajesh", { combinations: false }), false);
});

test("RELIANCE_KYC_NAME_COMBINATIONS_ENABLED is ON unless false / 0 / no / off", () => {
  const saved = process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
  try {
    for (const on of [undefined, "", "true", "1", "yes"]) {
      if (on === undefined) delete process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
      else process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED = on;
      assert.equal(kyc.isKycNameCombinationsEnabled(), true, String(on));
    }
    for (const off of ["false", "0", "no", "off", " FALSE "]) {
      process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED = off;
      assert.equal(kyc.isKycNameCombinationsEnabled(), false, off);
    }
  } finally {
    if (saved === undefined) delete process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
    else process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED = saved;
  }
});

test("on the page: the log's case now passes, Father Name is read from the policy, another name still stops", async () => {
  const saved = process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
  delete process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
  try {
    const data = { firstName: "ANMOL ARORA", lastName: "MASTER", fatherName: "RAJESH" };
    assert.equal((await run(resultPage({ box: { id: "result_name", value: "Anmol Arora" } }), data)).state, "match");
    assert.equal((await run(resultPage({ box: { id: "result_name", value: "Anmol Arora Rajesh" } }), data)).state, "match");
    const other = await run(resultPage({ box: { id: "result_name", value: "Anmol Kumar" } }), data);
    assert.equal(other.state, "mismatch");
    const message = kyc.kycNameMismatchMessage(other);
    assert.match(message, /Father Name "RAJESH"/);
    assert.match(message, /Allowed is Full Name alone, Full Name \+ Surname, Full Name \+ Father Name, or all three/);
    assert.match(message, /Stopped on the KYC page, PROCEED was not pressed and nothing was paid\.$/);
    assert.equal(message.includes(":"), false, "no colon (beautifyError keeps only the text after the last one)");
  } finally {
    if (saved === undefined) delete process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
    else process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED = saved;
  }
});

test("a name mismatch skips the KYC fallback (stop on the KYC page); other KYC errors and the switch off do not", () => {
  const saved = process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
  try {
    delete process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
    const mismatch = new kyc.KycNameMismatchError("KYC name mismatch - x", { portalName: "x" });
    assert.equal(mismatch.keepMessage, true, "the page's text never replaces the sentence");
    assert.equal(kyc.skipsKycFallback(mismatch), true);
    assert.equal(kyc.skipsKycFallback(new PortalRejectedError("upload refused")), false);
    assert.equal(kyc.skipsKycFallback(new Error("timeout")), false);
    assert.equal(kyc.skipsKycFallback(null), false);
    process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED = "false";
    assert.equal(kyc.skipsKycFallback(mismatch), false, "switch off = the fallback as before");
  } finally {
    if (saved === undefined) delete process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED;
    else process.env.RELIANCE_KYC_NAME_COMBINATIONS_ENABLED = saved;
  }
});

for (const file of [
  path.join(ROOT, "fullPolicycompany", "relianceForm.js"),
  path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"),
]) {
  test(`${path.basename(file)}: the post-calculation catch does not run the KYC fallback for a name mismatch`, () => {
    const src = fs.readFileSync(file, "utf8");
    const at = src.indexOf('console.log("Error handling post-calculation elements:", err.message);');
    assert.ok(at > 0);
    const block = src.slice(at, at + 1200);
    // since 2026-10-19 EVERY failed KYC stops at the KYC (relianceStages.js) — the rescue to the payment page is gone
    assert.equal(src.includes("rescueAfterKycFailure"), false);
    assert.match(block, /if \(stageNow === "kyc" && !kycAccepted\) \{/);
    assert.match(block, /Stopped on the KYC page \(KYC name mismatch\)/);
    assert.match(block, /await stopAtKycFailure\(\{/);
  });
}
