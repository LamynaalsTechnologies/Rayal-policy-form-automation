// Run with: node --test test/*.test.js
//
// KSHEMA TP (multiCompany/tpCompany/kshemaTP) is a DUPLICATE of the full-company KSHEMA flow
// (fullPolicycompany/kshemaForm.js + fullPolicycompany/kshema/kshemaQuoteForm.js) with the third-party-only changes:
// the Product Type chosen by exact text, no IDV / OD discount / add-ons, no inline Brisk certificate. None of these
// tests needs a browser, the network or a database:
//   1. each copy is still its original except for the lines tagged "[TP]" (the same guard as National TP);
//   2. the TP changes are where they must be, in the right order;
//   3. the Product Type is chosen by EXACT text and read back; the stop lists the portal's options;
//   4. the handler is wired in: feature gate first, the switch / product text, the registry;
//   5. a finished KSHEMA TP releases the Reliance OD of the same policy, and a stopped one keeps it waiting.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { diffHunks, untagged } = require("./driftGuard");

const ROOT = path.join(__dirname, "..");
const TP_DIR = path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP");
const FORM_ORIGINAL = path.join(ROOT, "fullPolicycompany", "kshemaForm.js");
const FORM_COPY = path.join(TP_DIR, "kshemaTPForm.js");
const QUOTE_ORIGINAL = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js");
const QUOTE_COPY = path.join(TP_DIR, "kshemaTPQuoteForm.js");

const read = (file) => fs.readFileSync(file, "utf8");

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

/** Run fn with some env vars set (undefined = unset), restoring them after — works for async fn too. */
async function withEnv(vars, fn) {
  const before = {};
  for (const key of Object.keys(vars)) {
    before[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

/* ----------------------- 1. each copy is its original + [TP] ----------------------- */

// The copies sit three folders deeper, so their require paths differ on purpose: undo only those before diffing.
const FORM_DEPTH = (text) =>
  text
    .replace(/require\("\.\/kshemaTPQuoteForm"\)/g, 'require("./kshema/kshemaQuoteForm")')
    .replace(/require\("\.\.\/\.\.\/\.\.\/fullPolicycompany\/kshema\//g, 'require("./kshema/')
    .replace(/require\("\.\.\/\.\.\/\.\.\//g, 'require("../');
const QUOTE_DEPTH = (text) =>
  text
    .replace(/require\("\.\.\/\.\.\/\.\.\/fullPolicycompany\/kshema\//g, 'require("./')
    .replace(/require\("\.\/kshemaTPForm"\)/g, 'require("../kshemaForm")')
    .replace(/require\("\.\.\/\.\.\/\.\.\/s3Uploader"\)/g, 'require("../../s3Uploader")');

for (const [name, original, copy, normalise, copyName] of [
  ["kshemaForm.js", FORM_ORIGINAL, FORM_COPY, FORM_DEPTH, "kshemaTPForm.js"],
  ["kshemaQuoteForm.js", QUOTE_ORIGINAL, QUOTE_COPY, QUOTE_DEPTH, "kshemaTPQuoteForm.js"],
]) {
  test(`sync: ${copyName} is ${name} plus [TP]-tagged changes only`, () => {
    const a = read(original).split("\n");
    const b = normalise(read(copy)).split("\n");
    const hunks = diffHunks(a, b);

    assert.ok(hunks.length >= 3, `expected the header and the TP changes to differ, got ${hunks.length} hunk(s)`);
    const bad = untagged(hunks);
    assert.deepEqual(
      bad.map((h) => ({ removed: h.removed.slice(0, 3), added: h.added.slice(0, 3) })),
      [],
      `${copyName} and ${name} differ outside the [TP] changes — if ${name} changed, port that change into ` +
        `multiCompany/tpCompany/kshemaTP/${copyName}; if the copy was edited, tag the edit [TP]`
    );
  });

  test(`sync guard can fail for ${copyName}: an untagged edit and a lost line are flagged`, () => {
    const a = read(original).split("\n");
    const base = normalise(read(copy)).split("\n");
    assert.equal(untagged(diffHunks(a, base)).length, 0, "the real copy is clean");

    // an edit on an original line that is not tagged: pick a line well inside the file that the copy shares
    const at = base.findIndex((line, i) => i > 400 && line.trim().length > 25 && !line.includes("[TP]") && a.includes(line));
    assert.ok(at > 0, "found a shared line to damage");
    const edited = [...base];
    edited[at] = `${edited[at]} // silently changed`;
    assert.ok(untagged(diffHunks(a, edited)).length >= 1, "untagged edit is flagged");

    const lost = [...base];
    lost.splice(at, 1);
    assert.ok(untagged(diffHunks(a, lost)).length >= 1, "a line lost from the copy is flagged");
  });
}

test("sync: the copy exports what kshemaForm.js does, is its own function, and loads", async () => {
  const [original, copy] = await quiet(() => [require(FORM_ORIGINAL), require(FORM_COPY)]);
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(original).sort());
  assert.equal(typeof copy.fillKshemaForm, "function");
  assert.notEqual(copy.fillKshemaForm, original.fillKshemaForm, "must be its own copy, not the original function");
});

test("the copy loads the TP quote form, not the original one (the original is left alone)", () => {
  const form = read(FORM_COPY);
  assert.ok(!/require\("[^"]*kshema\/kshemaQuoteForm"\)/.test(form), "kshemaTPForm must not require the original quote form");
  assert.equal(form.split('require("./kshemaTPQuoteForm")').length - 1, 8, "all eight quote-form requires point at the copy");
  const quote = read(QUOTE_COPY);
  assert.ok(!/require\("\.\.\/kshemaForm"\)/.test(quote), "the quote copy must not require the original form");
});

/* ----------------------- 2. the TP changes are where they must be ----------------------- */

/** Code without comments, so a token that is only MENTIONED in a comment is not "in the flow". */
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const at = (source, needle) => {
  const i = source.indexOf(needle);
  assert.ok(i >= 0, `missing: ${needle}`);
  return i;
};

test("quote copy: Product Type is chosen between rtoLocation and idv, exact, after the first fields and before the stop", () => {
  const source = codeOf(read(QUOTE_COPY));
  const order = source.slice(at(source, "const VEHICLE_FIELD_ORDER = ["), at(source, "const VEHICLE_FIELDS ="));
  assert.ok(!order.includes('"productType"'), "the hard-coded Product Type is out of the field order");
  assert.ok(order.indexOf('"rtoLocation"') < order.indexOf('"idv"'));

  const fn = source.slice(at(source, "async function fillVehicleDetails"));
  const first = at(fn, "VEHICLE_FIELDS_BEFORE_PRODUCT, ");
  const crumb = at(fn, 'Breaker.checkpoint("KSHEMA TP/product")');
  const stop = at(fn, "if (!isKshemaTpReady()) await stopBeforeProduct(");
  const select = at(fn, "await selectTpProduct(driver, { wanted: kshemaTpProductType()");
  const rest = at(fn, "VEHICLE_FIELDS_AFTER_PRODUCT, ");
  assert.ok(first < crumb && crumb < stop && stop < select && select < rest, "order: fields, checkpoint, stop, select, rest");
});

test("quote copy: no IDV, no OD discount, no add-ons, and the TP submit accepts a proposal page", () => {
  const source = codeOf(read(QUOTE_COPY));
  // IDV is never typed and never range-checked
  const idv = source.slice(at(source, 'key: "idv"'), at(source, 'key: "idv"') + 700);
  assert.match(idv, /value: \(\) => ""/);
  assert.match(idv, /required: false/);
  assert.match(source, /const providedIdv = 0;/);
  // discount and Nil Depreciation are zeroed before the sections are filled
  assert.match(source, /fillSection\(driver, \{ \.\.\.data, discount: 0, ODDiscount: 0 \}, PREMIUM_FIELDS/);
  assert.match(source, /fillSection\(driver, \{ \.\.\.data, zeroDepreciation: false \}, ADDON_FIELDS/);
  // a quote with no add-ons page can still be seen to have gone through
  assert.match(source, /Save and Finalize"\)\] \| \/\/mat-icon\[@data-iid="dnld-download-quote"\]/);
});

test("form copy: checkpoints, no inline Brisk, own stage label and the multiCompany screenshot prefix", () => {
  const source = codeOf(read(FORM_COPY));
  const submit = at(source, "await submitQuoteForm(driver)");
  const quoteCrumb = at(source, 'Breaker.checkpoint("KSHEMA TP/quote")');
  const pay = at(source, "await proceedToPayment(driver, capture, jobId)");
  const payCrumb = at(source, 'Breaker.checkpoint("KSHEMA TP/payment")');
  assert.ok(quoteCrumb < submit, "the quote checkpoint is before the quote is submitted");
  assert.ok(payCrumb < pay, "the payment checkpoint is before the payment starts");

  assert.match(source, /const briskDecision = \{ create: false,/);
  assert.ok(!/const briskDecision = shouldCreateBriskCertificate\(data\)/.test(source), "the inline Brisk decision is gone");
  assert.match(source, /stage: "tp-form"/);
  assert.match(source, /`multiCompany\/kshema\/\$\{stage\}`/);
  assert.equal(source.split("generateScreenshotKey(").length - 1, 1, "the one call site carries the TP prefix");
});

test("the original KSHEMA flow is untouched: no [TP], no Breaker, no TP product code", () => {
  for (const file of [FORM_ORIGINAL, QUOTE_ORIGINAL]) {
    const text = read(file);
    assert.ok(!text.includes("[TP]"), `${path.basename(file)} must not carry TP changes`);
    assert.ok(!/Breaker\./.test(text), `${path.basename(file)} must not carry Breaker checkpoints`);
    assert.ok(!/tpProduct|KSHEMA_TP_/.test(text), `${path.basename(file)} must not know about the TP handler`);
  }
  assert.match(read(QUOTE_ORIGINAL), /value: \(\) => "Two Wheeler-Bundled"/, "the full-company flow still buys Bundled");
});

/* ----------------------- 3. the Product Type step ----------------------- */

const {
  pickProductOption,
  selectTpProduct,
  listProductOptions,
  TpProductError,
} = require("../multiCompany/tpCompany/kshemaTP/tpProduct");
const { stopBeforeProduct } = require("../multiCompany/tpCompany/kshemaTP/stopBeforeProduct");
const { isAutomationStop } = require("../automationStopper");

const PORTAL_PRODUCTS = ["Two Wheeler-Bundled", "Two Wheeler Liability Only", "Two Wheeler-Standalone OD"];
const TP_TEXT = "Two Wheeler Liability Only";

/**
 * A Product Type mat-select that behaves like the portal's: closed until clicked, then a list; clicking an option
 * closes it and makes it the shown value. `ignoreClick` is a portal that keeps its pre-selected product.
 */
function fakeProductDriver({ options = PORTAL_PRODUCTS, selected = "", ignoreClick = false, hasSelect = true } = {}) {
  const state = { open: false, selected, clicks: [], selectClicks: 0 };
  const optionEls = options.map((text) => ({
    _text: text,
    async getText() {
      return text;
    },
    async click() {
      state.clicks.push(text);
      if (!ignoreClick) state.selected = text;
      state.open = false;
    },
  }));
  const select = {
    async isDisplayed() {
      return true;
    },
    async click() {
      state.open = true;
      state.selectClicks += 1;
    },
    async getText() {
      return state.selected;
    },
    async findElements() {
      return state.selected ? [{ async getText() { return state.selected; } }] : [];
    },
  };
  return {
    state,
    async wait(condition) {
      return typeof condition === "function" ? condition() : select;
    },
    async executeScript(script, element) {
      if (typeof script === "string" && script.includes("textContent") && element && typeof element._text === "string") {
        // what the real in-page script returns: whitespace collapsed and trimmed
        return element._text.replace(/\s+/g, " ").trim();
      }
      return undefined;
    },
    async findElements(locator) {
      const css = locator && (locator.value || locator.using === "css selector" ? String(locator.value) : "");
      if (css.includes("product_type")) return hasSelect ? [select] : [];
      if (css === "mat-option") return state.open ? optionEls : [];
      return [];
    },
  };
}

test("tpProduct: picks the exact option, never one that merely contains the text", () => {
  assert.equal(pickProductOption(PORTAL_PRODUCTS, TP_TEXT), 1);
  assert.equal(pickProductOption(PORTAL_PRODUCTS, "  two wheeler   liability ONLY "), 1, "spaces and case are ignored");
  assert.equal(pickProductOption(PORTAL_PRODUCTS, "Two Wheeler"), -1, "a prefix of a longer option is not a match");
  assert.equal(pickProductOption(PORTAL_PRODUCTS, "Liability"), -1);
  assert.equal(pickProductOption(PORTAL_PRODUCTS, ""), -1, "no wanted text matches nothing");
  assert.equal(pickProductOption([], TP_TEXT), -1);
});

test("tpProduct: selects the TP product and reads it back", async () => {
  const driver = fakeProductDriver();
  const lines = [];
  const result = await selectTpProduct(driver, { wanted: TP_TEXT, log: (l) => lines.push(l), settleMs: 50, optionsWaitMs: 50 });
  assert.equal(result.selected, TP_TEXT);
  assert.deepEqual(driver.state.clicks, [TP_TEXT], "only the TP option was clicked, not the Bundled one");
  assert.ok(lines.some((l) => l.includes("Product Type options on the portal")));
});

test("tpProduct: an option the portal does not offer is a TpProductError that names what it offers, nothing clicked", async () => {
  const driver = fakeProductDriver({ options: ["Two Wheeler-Bundled", "Two Wheeler-Standalone OD"] });
  await assert.rejects(
    selectTpProduct(driver, { wanted: TP_TEXT, log() {}, settleMs: 50, optionsWaitMs: 50 }),
    (error) => {
      assert.ok(error instanceof TpProductError && error.isTpProductError);
      assert.equal(error.stage, "tp-product");
      assert.match(error.message, /"Two Wheeler Liability Only" is not offered/);
      assert.match(error.message, /"Two Wheeler-Bundled", "Two Wheeler-Standalone OD"/);
      assert.deepEqual(error.productOptions, ["Two Wheeler-Bundled", "Two Wheeler-Standalone OD"]);
      assert.equal((error.message.match(/:/g) || []).length, 1, "ONE colon only, or beautifyError keeps just the tail");
      return true;
    }
  );
  assert.deepEqual(driver.state.clicks, [], "nothing was chosen");
});

test("tpProduct: a portal that ignores the click is caught by the read-back", async () => {
  const driver = fakeProductDriver({ selected: "Two Wheeler-Bundled", ignoreClick: true });
  await assert.rejects(
    selectTpProduct(driver, { wanted: TP_TEXT, log() {}, settleMs: 80, optionsWaitMs: 50 }),
    /portal shows "Two Wheeler-Bundled"/
  );
});

test("tpProduct: already set is left alone, and no text configured is refused", async () => {
  const set = fakeProductDriver({ selected: TP_TEXT });
  const result = await selectTpProduct(set, { wanted: TP_TEXT, log() {}, settleMs: 50 });
  assert.equal(result.alreadySet, true);
  assert.equal(set.state.selectClicks, 0, "the panel is not opened for a no-op");
  await assert.rejects(selectTpProduct(fakeProductDriver(), { wanted: "  ", log() {} }), TpProductError);
});

test("stopBeforeProduct: lists the options in the stop message with one colon, stage tp-product, panel left open", async () => {
  await withEnv({ KSHEMA_TP_PRODUCT_TYPE: undefined, KSHEMA_TP_FORM_ENABLED: undefined }, async () => {
    const driver = fakeProductDriver();
    const stop = await quiet(async () => {
      try {
        await stopBeforeProduct(driver, "job-1");
      } catch (e) {
        return e;
      }
      return null;
    });
    assert.ok(isAutomationStop(stop), "it always ends in a stop");
    assert.equal(stop.details.stage, "tp-product");
    assert.deepEqual(stop.details.productOptions, PORTAL_PRODUCTS);
    for (const text of PORTAL_PRODUCTS) assert.ok(stop.message.includes(`"${text}"`), `names ${text}`);
    assert.match(stop.message, /KSHEMA_TP_PRODUCT_TYPE is not set/);
    assert.equal((stop.message.match(/:/g) || []).length, 1, "ONE colon only, or beautifyError keeps just the tail");
    assert.equal(driver.state.open, true, "the list stays open on the held browser");
    assert.deepEqual(driver.state.clicks, [], "nothing was chosen");
  });
});

test("stopBeforeProduct: still stops when the options cannot be read, and says the switch is the reason", async () => {
  await withEnv({ KSHEMA_TP_PRODUCT_TYPE: TP_TEXT, KSHEMA_TP_FORM_ENABLED: "false" }, async () => {
    const stop = await quiet(async () => {
      try {
        await stopBeforeProduct(fakeProductDriver({ hasSelect: false }), "job-2");
      } catch (e) {
        return e;
      }
      return null;
    });
    assert.ok(isAutomationStop(stop));
    assert.match(stop.message, /KSHEMA_TP_FORM_ENABLED is set to false/);
    assert.match(stop.message, /could not be read from the page/);
    assert.deepEqual(stop.details.productOptions, []);
  });
});

test("listProductOptions: trims, drops duplicates and blanks, keeps order", async () => {
  const driver = fakeProductDriver({ options: [" A ", "B", "A", "", "C"] });
  assert.deepEqual(await listProductOptions(driver), ["A", "B", "C"]);
});

/* ----------------------- 4. the switch, the handler, the registry ----------------------- */

const cfg = require("../multiCompany/tpCompany/kshemaTP/tpConfig");

test("tpConfig: the form switch is ON unless false/0/no/off; the product text is trimmed; ready needs both", async () => {
  await withEnv({ KSHEMA_TP_FORM_ENABLED: undefined, KSHEMA_TP_PRODUCT_TYPE: undefined }, () => {
    assert.equal(cfg.isKshemaTpFormEnabled(), true, "default on");
    assert.equal(cfg.kshemaTpProductType(), "");
    assert.equal(cfg.isKshemaTpReady(), false, "no product text yet -> not ready");
    assert.match(cfg.kshemaTpHoldReason(), /KSHEMA_TP_PRODUCT_TYPE is not set/);
  });
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    await withEnv({ KSHEMA_TP_FORM_ENABLED: off, KSHEMA_TP_PRODUCT_TYPE: TP_TEXT }, () => {
      assert.equal(cfg.isKshemaTpFormEnabled(), false, `"${off}" turns it off`);
      assert.equal(cfg.isKshemaTpReady(), false);
      assert.match(cfg.kshemaTpHoldReason(), /KSHEMA_TP_FORM_ENABLED is set to false/);
    });
  }
  await withEnv({ KSHEMA_TP_FORM_ENABLED: "true", KSHEMA_TP_PRODUCT_TYPE: "  Two Wheeler   Liability Only  " }, () => {
    assert.equal(cfg.kshemaTpProductType(), "Two Wheeler Liability Only");
    assert.equal(cfg.isKshemaTpReady(), true);
    assert.equal(cfg.kshemaTpHoldReason(), "");
  });
});

test("registry: kshema / tp is the KSHEMA TP handler, not a login-only stub; the rest of kshema is untouched", () => {
  const { registry, resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const { fillKshemaTP } = require("../multiCompany/tpCompany/kshemaTP/kshemaTP");
  assert.equal(registry.kshema.tp, fillKshemaTP);
  assert.equal(resolveMultiCompanyHandler("KSHEMA", "TP"), fillKshemaTP);
  assert.notEqual(registry.kshema.tp.name, "loginOnlyHandler");
  assert.equal(registry.kshema.od.name, "loginOnlyHandler", "KSHEMA OD is not built");
});

test("handler: the feature gate comes first — [E110] with no browser opened", async () => {
  // featureGate reads MULTI_COMPANY_AUTOMATION_ENABLED once at load; in this test process it may be on or off, so
  // assert on the SOURCE order (gate is the first statement) and on the behaviour only when the gate is closed.
  const source = codeOf(read(path.join(TP_DIR, "kshemaTP.js")));
  const body = source.slice(at(source, "async function fillKshemaTP"));
  assert.ok(at(body, "assertMultiCompanyEnabled()") < at(body, "fillKshemaForm(data)"), "gate before the form");

  const gate = require("../multiCompany/common/featureGate");
  if (!gate.MULTI_COMPANY_AUTOMATION_ENABLED) {
    const { fillKshemaTP } = require("../multiCompany/tpCompany/kshemaTP/kshemaTP");
    await assert.rejects(fillKshemaTP({ username: "u", password: "p" }), /\[E110\]/);
  }
});

/* ----------------------- 5. TP first, then OD ----------------------- */

const core = require("../lib/jobPartsCore");
const { mapRunResult } = require("../lib/partRunner");
const { part } = require("./helpers");
const { stoppedResult, AutomationStoppedError } = require("../automationStopper");

/** A two-insurer policy: Reliance OD, KSHEMA TP, the OD depending on the TP (backend shared/jobParts.js). */
const twoInsurerJob = () => ({
  status: "pending",
  rev: 0,
  parts: [
    part("od", "portal", "reliance", { dependsOn: "tp" }),
    part("tp", "portal", "kshema"),
  ],
});

const run = (job, key, result) => {
  const target = job.parts.find((p) => p.key === key);
  const outcome = mapRunResult(result, { part: target, companyName: target.company, processingTimeMs: 1 });
  const applied = core.applyPartOutcome(job, key, outcome, new Date("2026-10-13T10:00:00Z"));
  return { ...job, parts: applied.parts };
};

test("sequence: the KSHEMA TP runs first, the Reliance OD is not offered while it is pending", () => {
  const job = twoInsurerJob();
  const next = core.selectRunnablePart(job, new Date("2026-10-13T10:00:00Z"));
  assert.equal(next && next.key, "tp", "TP first");
  const od = core.normalizeParts(job.parts).find((p) => p.key === "od");
  assert.equal(od.waitingFor, "tp");
});

test("sequence: a KSHEMA TP that STOPS at the Product Type keeps the OD waiting (stopped, not automated yet)", () => {
  const stop = new AutomationStoppedError("KSHEMA TP: stopped before choosing the Product Type", { stage: "tp-product" });
  const after = run(twoInsurerJob(), "tp", stoppedResult(stop));
  const tp = after.parts.find((p) => p.key === "tp");
  assert.equal(tp.status, "failed_login_form");
  assert.equal(tp.stopped, true);
  assert.equal(tp.stage, "tp-product");
  assert.equal(core.selectRunnablePart(after, new Date("2026-10-13T10:05:00Z")), null, "the OD must not start");
  const od = core.normalizeParts(after.parts).find((p) => p.key === "od");
  assert.equal(od.waitingFor, "tp");
  assert.equal(od.blockedBy, "tp");
});

test("sequence: a non-retryable TpProductError result keeps the OD waiting too", () => {
  const after = run(twoInsurerJob(), "tp", {
    success: false,
    stage: "quote-vehicle-details",
    retryable: false,
    error: 'KSHEMA TP: the Product Type "X" is not offered on the KSHEMA portal, so nothing was chosen or submitted.',
  });
  assert.equal(after.parts.find((p) => p.key === "tp").status, "failed_login_form");
  assert.equal(core.selectRunnablePart(after, new Date("2026-10-13T10:05:00Z")), null);
});

test("sequence: a KSHEMA TP that finishes (QR + payment link) releases the Reliance OD", () => {
  const after = run(twoInsurerJob(), "tp", { success: true, stage: "completed", briskCertificateError: null });
  assert.equal(after.parts.find((p) => p.key === "tp").status, "completed");
  const next = core.selectRunnablePart(after, new Date("2026-10-13T10:05:00Z"));
  assert.equal(next && next.key, "od", "the OD starts by itself");
});

test("sequence: completed_with_errors (a document upload failed) also releases the OD", () => {
  const after = run(twoInsurerJob(), "tp", { success: true, stage: "completed", documentUploadError: "S3 hiccup" });
  assert.equal(after.parts.find((p) => p.key === "tp").status, "completed_with_errors");
  assert.equal((core.selectRunnablePart(after, new Date("2026-10-13T10:05:00Z")) || {}).key, "od");
});

test("sequence (two-job shape): the OD job waits for a KSHEMA TP job and goes when it is completed", () => {
  const { splitByTpOrder } = require("../lib/jobSequence");
  const odJob = { _id: "od1", captchaId: "p1", policyType: "od", status: "pending", formData: { Companyname: "reliance" } };
  const waiting = (status) => splitByTpOrder([odJob], [{ _id: "tp1", captchaId: "p1", policyType: "tp", status, formData: { Companyname: "kshema" } }]);
  for (const status of ["pending", "processing", "failed_login_form", "failed_post_submission"]) {
    assert.equal(waiting(status).ready.length, 0, `${status}: OD waits`);
  }
  assert.equal(waiting("completed").ready.length, 1, "completed: OD goes");
  assert.equal(waiting("completed_with_errors").ready.length, 1, "completed_with_errors: OD goes");
});
