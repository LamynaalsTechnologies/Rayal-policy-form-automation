// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaFinancier.test.js
//
// KSHEMA's nominee page asks, below the nominee, whether the vehicle has a financier: "Yes" reveals a Financier Name
// SEARCH dropdown (a mat-autocomplete) and an Additional Details box. The automation never entered them (2026-10-16).
// fillFinancier answers the question, types the name, chooses the FIRST option KSHEMA lists for it and types the details;
// when KSHEMA lists nothing, or the box is in error afterwards, the policy stops with a plain sentence.
// No browser and no waiting: a fake page, injected helpers and a fake clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const financier = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaFinancier.js"));
const kshemaFields = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaFields.js"));

const quiet = async (fn) => {
  const saved = ["log", "warn", "error"].map((k) => [k, console[k]]);
  saved.forEach(([k]) => (console[k] = () => {}));
  try {
    return await fn();
  } finally {
    saved.forEach(([k, f]) => (console[k] = f));
  }
};
const withSwitch = async (value, fn) => {
  const before = process.env.KSHEMA_FINANCIER_ENABLED;
  if (value === undefined) delete process.env.KSHEMA_FINANCIER_ENABLED;
  else process.env.KSHEMA_FINANCIER_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.KSHEMA_FINANCIER_ENABLED;
    else process.env.KSHEMA_FINANCIER_ENABLED = before;
  }
};

/**
 * A fake nominee page after "Yes".
 *   list         what the autocomplete offers: an array of strings / { text, disabled }, or (clock) => array — so a list can
 *                fill in late or change while the name is still being searched
 *   boxAppears   whether the Financier Name box shows at all
 *   cleared      the first N read-backs of the box find it empty (a re-render wiped it)
 *   invalid      the read-back finds the box marked invalid (with `invalidMessage`)
 *   gone         the read-back finds no box
 */
function fakePage({ list = [], boxAppears = true, yes = { ok: true }, detailsOk = true, cleared = 0, invalid = false, invalidMessage = "", gone = false, clickFails = false, typeFails = false, emptyAfterChoose = false, opened = true } = {}) {
  const clock = { t: 0 };
  const state = { calls: [], value: "", clicked: null, details: null, reads: 0, typed: [] };
  const offered = () => {
    const raw = typeof list === "function" ? list(clock) : list;
    return raw.map((o) => {
      const item = typeof o === "string" ? { text: o } : o;
      return {
        text: item.text,
        async isDisplayed() { return item.shown !== false; },
        async getText() { return `  ${item.text}  `; }, // the portal pads the text
        async getAttribute(name) { return name === "aria-disabled" && item.disabled ? "true" : null; },
      };
    });
  };
  const box = {
    async clear() { state.value = ""; },
    async sendKeys(x) {
      if (typeFails) throw new Error("element not interactable\nstacktrace");
      state.typed.push(String(x));
      state.value = String(x);
    },
    async getAttribute(name) {
      if (name === "value") return state.value;
      if (name === "aria-expanded") return opened ? "true" : "false";
      return null;
    },
  };
  const handlers = {
    ...kshemaFields,
    async selectMatRadio(driver, selectors, wanted, label) {
      state.calls.push(["radio", wanted, label]);
      return yes.ok ? { ok: true, value: wanted, reason: null } : { ok: false, value: null, reason: yes.reason || `the "${label}" choice was not on the page` };
    },
    async findVisible() {
      state.calls.push(["find", "name box"]);
      return boxAppears ? { element: box, selector: "x" } : { element: null, selector: null };
    },
    async clickElement(driver, element, label) {
      state.calls.push(["click", label]);
      if (clickFails && element.text !== undefined) throw new Error("element click intercepted");
      if (element.text !== undefined) {
        state.clicked = element.text;
        state.value = emptyAfterChoose ? "" : element.text; // choosing an option fills the box with its text
      }
    },
    async typeIntoField(driver, selectors, value, label) {
      state.calls.push(["type", label, value]);
      if (!detailsOk) return { ok: false, value: null, reason: `the "${label}" box was not on the page` };
      state.details = value;
      return { ok: true, value, reason: null };
    },
  };
  const driver = {
    async sleep() {},
    async findElements(locator) {
      return String(locator && locator.value).includes("mat-option") ? offered() : [];
    },
    async executeScript() {
      return [{ text: "Is New Vehicle?", values: ["Yes", "No"] }];
    },
  };
  // the box as the read-back sees it
  const readState = async () => {
    state.reads += 1;
    if (gone) return { present: false, value: "", invalid: false, error: "" };
    if (state.reads <= cleared) return { present: true, value: "", invalid: false, error: "" };
    return { present: true, value: state.value, invalid, error: invalid ? invalidMessage : "" };
  };
  const deps = { handlers, readState, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  return { driver, deps, state, clock };
}
const run = (page, data) => quiet(() => financier.fillFinancier(page.driver, data, page.deps));
const WITH = { hasFinancier: true, financierName: "SERA COM", financierAddress: "CHENNAI MAIN BRANCH" };

/* ------------------------------ when it does nothing ------------------------------ */

test("a policy without a financier leaves the portal exactly as it is", async () => {
  for (const data of [{}, { hasFinancier: false }, { hasFinancier: "false", financierName: "X" }]) {
    const page = fakePage();
    const r = await run(page, data);
    assert.deepEqual(r, { ok: true, skipped: "no financier on the policy" });
    assert.deepEqual(page.state.calls, [], "no portal call at all");
  }
});

test("KSHEMA_FINANCIER_ENABLED=false: not entered, no portal call (the old behaviour)", async () => {
  await withSwitch("false", async () => {
    const page = fakePage({ list: ["SERA COM PVT. LTD."] });
    assert.deepEqual(await run(page, WITH), { ok: true, skipped: "switched off" });
    assert.deepEqual(page.state.calls, []);
  });
  await withSwitch(undefined, async () => assert.equal(financier.isFinancierEnabled(), true));
  for (const off of ["0", "no", "OFF"]) await withSwitch(off, async () => assert.equal(financier.isFinancierEnabled(), false, off));
});

test("a financier with no name stops with a plain sentence, before the portal is touched", async () => {
  const page = fakePage();
  const r = await run(page, { hasFinancier: true, financierName: "  " });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Could not enter the financier on KSHEMA - the policy says it has a financier but no financier name was given\.$/);
  assert.deepEqual(page.state.calls, []);
});

test("a one-letter name stops before the portal is touched - KSHEMA's list does not open for a single character", async () => {
  assert.equal(financier.MIN_NAME_LETTERS, 2);
  for (const short of ["A", " a ", "  H  "]) {
    const page = fakePage({ list: ["HDFC BANK LTD"] });
    const r = await run(page, { hasFinancier: true, financierName: short, financierAddress: "CHENNAI" });
    assert.equal(r.ok, false, short);
    assert.equal(
      r.error,
      `Could not enter the financier on KSHEMA - the financier name "${short.trim()}" is too short - KSHEMA's financier list opens only after 2 letters, so correct the financier name on the policy.`
    );
    assert.equal(r.error.includes(":"), false, "no colon (beautifyError)");
    assert.deepEqual(page.state.calls, [], "no portal call - no waiting for a list that cannot open");
    assert.equal(page.clock.t, 0, "and no waiting at all");
  }
});

test("two letters are enough (spaces do not count), and go through the search as usual", async () => {
  for (const name of ["HD", " hd ", "H D"]) {
    const page = fakePage({ list: ["HDFC BANK LTD"] });
    const r = await run(page, { hasFinancier: true, financierName: name });
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    assert.deepEqual(page.state.typed, [name.trim()], "what was typed is the name, trimmed");
  }
});

/* ------------------------------ the happy path: search, then the FIRST option ------------------------------ */

test("Yes, the name typed into the search, the FIRST option chosen, then the Additional Details", async () => {
  await withSwitch(undefined, async () => {
    const page = fakePage({ list: ["SERA COM PVT. LTD.", "SERA COMMERCIAL FINANCE"] });
    const r = await run(page, WITH);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(page.state.typed, ["SERA COM"], "the policy's name is what is searched for");
    assert.equal(page.state.clicked, "SERA COM PVT. LTD.", "the first option was clicked (not the later one)");
    assert.equal(r.name, "SERA COM PVT. LTD.");
    assert.equal(page.state.details, "CHENNAI MAIN BRANCH");
    const order = page.state.calls.map((c) => c[0]);
    assert.ok(order.indexOf("radio") < order.indexOf("click") && order.indexOf("click") < order.indexOf("type"), `order: ${order}`);
    assert.deepEqual(page.state.calls[0], ["radio", "Yes", "Financier"]);
    assert.deepEqual(r.warnings, [], "the first option looks like what was typed - nothing to warn about");
  });
});

test("the FIRST option is chosen even when a later one is the closer match - and the difference is a warning, not a failure", async () => {
  const page = fakePage({ list: ["AXIS BANK", "HDFC BANK LTD"] });
  const r = await run(page, { hasFinancier: true, financierName: "HDFC BANK LIMITED" });
  assert.equal(r.ok, true, r.error);
  assert.equal(page.state.clicked, "AXIS BANK");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /KSHEMA's first match for "HDFC BANK LIMITED" was "AXIS BANK"/);
});

test("Ltd and Limited are the same word when the first option is compared with the typed name (no warning)", async () => {
  const page = fakePage({ list: ["HDFC BANK LTD"] });
  const r = await run(page, { hasFinancier: true, financierName: "HDFC BANK LIMITED" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test("no Additional Details on the policy: only the name is entered", async () => {
  const page = fakePage({ list: ["SERA COM PVT. LTD."] });
  const r = await run(page, { hasFinancier: true, financierName: "SERA COM" });
  assert.equal(r.ok, true);
  assert.equal(page.state.calls.some((c) => c[0] === "type"), false);
});

/* ------------------------------ the list: waiting for it, and what counts as an option ------------------------------ */

test("a list that fills in late is waited for (the search may go to the server)", async () => {
  const page = fakePage({ list: (clock) => (clock.t < 3000 ? [] : ["SERA COM PVT. LTD."]) });
  const r = await run(page, WITH);
  assert.equal(r.ok, true, r.error);
  assert.equal(page.state.clicked, "SERA COM PVT. LTD.");
});

test("a list that is still re-filtering is not trusted until the same first option has stood for a moment", async () => {
  // the first thing the autocomplete shows is the unfiltered head of the list; the match arrives half a second later
  const page = fakePage({ list: (clock) => (clock.t < 500 ? ["ABC FINANCE"] : ["SERA COM PVT. LTD.", "ABC FINANCE"]) });
  const r = await run(page, WITH);
  assert.equal(r.ok, true, r.error);
  assert.equal(page.state.clicked, "SERA COM PVT. LTD.", "not the stale first row");
});

test("KSHEMA's own 'No results found' row and disabled rows are not financiers", async () => {
  const none = fakePage({ list: ["No results found"] });
  const r = await run(none, WITH);
  assert.equal(r.ok, false);
  assert.match(r.error, /showed no financier/);
  assert.equal(none.state.clicked, null);

  for (const row of ["No data", "No records found", "Not found", "No matches", "No financier found"]) {
    const page = fakePage({ list: [row] });
    assert.equal((await run(page, WITH)).ok, false, row);
  }

  const mixed = fakePage({ list: [{ text: "HIDDEN ONE", shown: false }, { text: "DISABLED ONE", disabled: true }, "SERA COM PVT. LTD."] });
  const ok = await run(mixed, WITH);
  assert.equal(ok.ok, true, ok.error);
  assert.equal(mixed.state.clicked, "SERA COM PVT. LTD.", "the first row that can be chosen");
});

test("no data for what was typed: stops with a plain sentence, nothing is chosen, nothing else is typed", async () => {
  const page = fakePage({ list: [] });
  const r = await run(page, WITH);
  assert.equal(r.ok, false);
  assert.match(r.error, /^Could not enter the financier on KSHEMA - KSHEMA's financier list showed no financier for "SERA COM"/);
  assert.match(r.error, /given 12 seconds/);
  assert.match(r.error, /check the financier name on the policy\.$/);
  assert.equal(r.error.includes(":"), false, "no colon (beautifyError keeps only the text after the last one)");
  assert.equal(page.state.clicked, null);
  assert.equal(page.state.calls.some((c) => c[0] === "type"), false, "Additional Details was not typed on a financier that was not chosen");
  assert.ok(page.clock.t >= 12000, "the list was given its full time before the verdict");
});

test("a list that never opened says so", async () => {
  const page = fakePage({ list: [], opened: false });
  const r = await run(page, WITH);
  assert.match(r.error, /\(the list never opened\)/);
});

test("an option that cannot be clicked, a box that stays empty, a box that cannot be typed into: each stops with its own sentence", async () => {
  const click = await run(fakePage({ list: ["SERA COM PVT. LTD."], clickFails: true }), WITH);
  assert.match(click.error, /the financier "SERA COM PVT\. LTD\." could not be chosen from KSHEMA's list/);

  const empty = await run(fakePage({ list: ["SERA COM PVT. LTD."], emptyAfterChoose: true }), WITH);
  assert.match(empty.error, /the Financier Name box is empty after choosing "SERA COM PVT\. LTD\."/);

  const typing = await run(fakePage({ list: ["SERA COM PVT. LTD."], typeFails: true }), WITH);
  assert.match(typing.error, /the Financier Name box could not be typed into \(element not interactable\)/);
  for (const r of [click, empty, typing]) assert.equal(r.error.includes(":"), false);
});

/* ------------------------------ the box is read again after the details ------------------------------ */

test("the name box is read back after the Additional Details; a box a re-render wiped is entered once more", async () => {
  const page = fakePage({ list: ["SERA COM PVT. LTD."], cleared: 1 });
  const r = await run(page, WITH);
  assert.equal(r.ok, true, r.error);
  assert.equal(page.state.typed.length, 2, "the name was typed a second time");
  assert.equal(page.state.reads, 2);
  assert.equal(page.state.clicked, "SERA COM PVT. LTD.");
});

test("a box that is wiped again, or marked invalid, or gone, stops the policy and says which", async () => {
  const twice = await run(fakePage({ list: ["SERA COM PVT. LTD."], cleared: 2 }), WITH);
  assert.equal(twice.ok, false);
  assert.match(twice.error, /the Financier Name box is empty again after the financier details were entered, even on a second try\./);

  const bad = await run(fakePage({ list: ["SERA COM PVT. LTD."], invalid: true, invalidMessage: "Select a financier from the list" }), WITH);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /KSHEMA marks the financier name as invalid \(Select a financier from the list\)/);

  const gone = await run(fakePage({ list: ["SERA COM PVT. LTD."], gone: true }), WITH);
  assert.match(gone.error, /the Financier Name box is gone/);
  for (const r of [twice, bad, gone]) assert.equal(r.error.includes(":"), false, r.error);
});

/* ------------------------------ stopping, with the evidence ------------------------------ */

test("Yes cannot be chosen: stops, and lists every Yes/No question the page showed (the wording is one run away)", async () => {
  const page = fakePage({ yes: { ok: false, reason: 'the "Financier" choice was not on the page' } });
  const r = await run(page, WITH);
  assert.equal(r.ok, false);
  assert.match(r.error, /^Could not enter the financier on KSHEMA - the "Financier" choice was not on the page\./);
  assert.match(r.error, /The page's Yes\/No questions are - "Is New Vehicle\?" \(Yes\/No\)\./);
  assert.equal(r.error.includes(":"), false, "no colon (beautifyError)");
  assert.equal(page.state.calls.some((c) => c[0] === "type"), false, "nothing was typed");
});

test("Yes was chosen but the Financier Name box never appears: stops (a wrong group would be caught here)", async () => {
  const page = fakePage({ boxAppears: false });
  const r = await run(page, WITH);
  assert.equal(r.ok, false);
  assert.match(r.error, /the Financier Name box did not appear after Yes was chosen\./);
  assert.match(r.error, /Yes\/No questions are/);
});

test("Additional Details that cannot be entered is a warning (optional field), the financier itself stands", async () => {
  const page = fakePage({ list: ["SERA COM PVT. LTD."], detailsOk: false });
  const r = await run(page, WITH);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /Additional Details was not entered/);
});

/* ------------------------------ locators and the in-page reads ------------------------------ */

test("the locators are anchored on what the portal gave: the name placeholder, data-iid financier_name, data-iid hypo_branch_address", () => {
  assert.ok(financier.NAME_SELECTORS[0].includes("financier name"));
  assert.ok(financier.DETAILS_SELECTORS.includes('input[data-iid="hypo_branch_address"]'));
  assert.equal(financier.OPTION_SELECTORS[0], '.cdk-overlay-container mat-option[data-iid="financier_name"]', "the option's own hook comes first");
  // the Yes/No group: a SHORT label (never a page-sized container that merely contains the word), then the next Yes/No group
  assert.ok(financier.RADIO_GROUP_SELECTORS.some((s) => s.includes("string-length(normalize-space(.)) < 120") && s.includes("hypothecat")));
});

test("readOffered tries the financier options first, then any overlay option, and keeps only rows that can be chosen", async () => {
  const seen = [];
  const row = (text, extra = {}) => ({
    async isDisplayed() { return extra.shown !== false; },
    async getText() { return text; },
    async getAttribute() { return extra.disabled ? "true" : null; },
  });
  const driver = {
    async findElements(locator) {
      seen.push(locator.value);
      if (locator.value === financier.OPTION_SELECTORS[0]) return [];
      if (locator.value === financier.OPTION_SELECTORS[1]) return [row("No results found"), row("A"), row("B", { disabled: true }), row("C")];
      return [row("never reached")];
    },
  };
  const out = await financier.readOffered(driver);
  assert.deepEqual(out.map((o) => o.text), ["A", "C"]);
  assert.deepEqual(seen, [financier.OPTION_SELECTORS[0], financier.OPTION_SELECTORS[1]], "stops at the first selector that finds a choosable row");
});

/** A fake document for the two in-page reads (selenium serialises them; here they run in this process). */
function withDom({ inputs = [], shown = () => true, fields = new Map() }, fn) {
  const saved = { document: globalThis.document, window: globalThis.window };
  try {
    globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    globalThis.document = { querySelectorAll: (sel) => (sel === "input" ? inputs : []) };
    return fn();
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
}
const domInput = ({ placeholder, value = "", cls = "", ariaInvalid = null, field = null, size = 10 }) => ({
  className: cls,
  value,
  getAttribute: (n) => (n === "placeholder" ? placeholder : n === "aria-invalid" ? ariaInvalid : null),
  getBoundingClientRect: () => ({ width: size, height: size }),
  closest: () => field,
});
const domField = ({ cls = "", error = null }) => ({
  className: cls,
  querySelector: (sel) => (sel === "mat-error" ? error : null),
});
const domError = (text, size = 10) => ({ innerText: text, textContent: text, getBoundingClientRect: () => ({ width: size, height: size }) });

test("readFinancierBoxInPage: present / value / invalid (aria, ng-invalid on the box or the field, a visible mat-error)", () => {
  const read = (inputs) => withDom({ inputs }, () => financier.readFinancierBoxInPage());

  assert.deepEqual(read([domInput({ placeholder: "Additional Details" })]), { present: false, value: "", invalid: false, error: "" });
  assert.deepEqual(read([domInput({ placeholder: "+ Financier Name", size: 0 })]), { present: false, value: "", invalid: false, error: "" }, "a hidden box is not on the page");

  const fine = read([domInput({ placeholder: "+ Financier Name", value: "  SERA COM PVT. LTD. ", cls: "mat-mdc-input-element ng-valid", field: domField({ cls: "mat-mdc-form-field" }) })]);
  assert.deepEqual(fine, { present: true, value: "SERA COM PVT. LTD.", invalid: false, error: "" });

  assert.equal(read([domInput({ placeholder: "+ Financier Name", ariaInvalid: "true" })]).invalid, true, "aria-invalid");
  assert.equal(read([domInput({ placeholder: "+ Financier Name", cls: "ng-touched ng-invalid" })]).invalid, true, "ng-invalid on the box");
  assert.equal(read([domInput({ placeholder: "+ Financier Name", field: domField({ cls: "mat-mdc-form-field mat-form-field-invalid" }) })]).invalid, true, "invalid field wrapper");

  const withError = read([domInput({ placeholder: "+ Financier Name", field: domField({ error: domError("  Financier  is required ") }) })]);
  assert.equal(withError.invalid, true);
  assert.equal(withError.error, "Financier is required");
  const hiddenError = read([domInput({ placeholder: "+ Financier Name", field: domField({ error: domError("x", 0) }) })]);
  assert.equal(hiddenError.invalid, false, "a mat-error that is not shown is not an error");
});

test("readFinancierState: a failing script is 'no box', never a throw", async () => {
  assert.deepEqual(await financier.readFinancierState({ executeScript: async () => { throw new Error("gone"); } }), { present: false, value: "", invalid: false, error: "" });
  assert.deepEqual(await financier.readFinancierState({ executeScript: async () => null }), { present: false, value: "", invalid: false, error: "" });
  assert.deepEqual(await financier.readFinancierState({ executeScript: async () => ({ present: true, value: "A", invalid: false, error: "" }) }), { present: true, value: "A", invalid: false, error: "" });
});

test("readRadioGroupsInPage lists visible Yes/No groups with their nearby text", () => {
  const saved = { document: globalThis.document, window: globalThis.window };
  const input = (value) => ({ value });
  const group = (text, values, shown = true) => ({
    getBoundingClientRect: () => (shown ? { width: 10, height: 10 } : { width: 0, height: 0 }),
    querySelectorAll: () => values.map(input),
    parentElement: { innerText: text, parentElement: null },
  });
  try {
    globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    globalThis.document = { querySelectorAll: () => [group("Is Financier?  Yes No", ["Yes", "No"]), group("hidden one", ["Yes", "No"], false)] };
    assert.deepEqual(financier.readRadioGroupsInPage(), [{ text: "Is Financier? Yes No", values: ["Yes", "No"] }]);
  } finally {
    globalThis.document = saved.document;
    globalThis.window = saved.window;
  }
});

/* ------------------------------ wiring ------------------------------ */

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
]) {
  test(`${path.basename(file)}: the financier is entered after the nominee Save and before Save and Finalize; a failure stops the nominee step`, () => {
    const src = fs.readFileSync(file, "utf8");
    const nominee = src.indexOf("async function fillNomineeDetails");
    const body = src.slice(nominee, src.indexOf("\n}\n", nominee));
    const skip = body.indexOf("skipping nominee entry");
    const call = body.indexOf(".fillFinancier(driver, data);");
    const failure = body.indexOf("if (!financier.ok) return { ok: false, error: financier.error };");
    const finalize = body.indexOf("// 7. Click Save and Finalize button");
    assert.ok(skip > 0 && call > skip && failure > call && finalize > failure, "after the nominee block, before Save and Finalize");
    assert.match(body, /require\("(\.\/kshemaFinancier|\.\.\/\.\.\/\.\.\/fullPolicycompany\/kshema\/kshemaFinancier)"\)\.fillFinancier/);
  });
}
