// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaSection.test.js
//
// KSHEMA (OD+TP and TP only) "sometimes misses a field and reports an error" (2026-10-16). kshemaSection.js fills a section
// carefully: the old first pass, then one more try for a failed field, then a read-back of every filled field (refilled
// when the portal cleared it); before Save every filled field is read back; when Save does nothing the portal's invalid
// fields are named, refilled when they are ours, and Save is pressed once more. Behind KSHEMA_FIELD_RECHECK_ENABLED.
// No browser: the field helpers and the page reads are injected.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const section = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSection.js"));
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
  const before = process.env.KSHEMA_FIELD_RECHECK_ENABLED;
  if (value === undefined) delete process.env.KSHEMA_FIELD_RECHECK_ENABLED;
  else process.env.KSHEMA_FIELD_RECHECK_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.KSHEMA_FIELD_RECHECK_ENABLED;
    else process.env.KSHEMA_FIELD_RECHECK_ENABLED = before;
  }
};

/**
 * A fake form. `plan[label]` is the list of answers the helper gives on each call (last one repeats):
 *   "ok" | "fail" | "throw"
 * `page[label]` is what the field holds now (set by an "ok" fill; `clear(label)` empties it).
 */
function fakeForm(plan = {}) {
  const page = {};
  const calls = {};
  const answer = (label, value) => {
    calls[label] = (calls[label] || 0) + 1;
    const list = plan[label] || ["ok"];
    const step = list[Math.min(calls[label] - 1, list.length - 1)];
    if (step === "throw") throw new Error("stale element reference: element is not attached\n  at line 1");
    if (step === "fail") return { ok: false, value: null, reason: `"${label}" was not on the page` };
    page[label] = String(value);
    return { ok: true, value: String(value), reason: null };
  };
  const handlers = {
    typeIntoField: async (driver, selectors, value, label) => answer(label, value),
    selectMatOption: async (driver, selectors, value, label) => answer(label, Array.isArray(value) ? value[0] : value),
    selectMatRadio: async (driver, selectors, value, label) => answer(label, value),
    setMatCheckbox: async (driver, selectors, value, label) => answer(label, value),
    setSlider: async (driver, selectors, value, label) => answer(label, value),
    typeIntoDateField: async (driver, selectors, value, label) => answer(label, value),
  };
  const readState = async (driver, field, wanted, expected) => {
    if (!(field.label in page)) return null;
    const actual = page[field.label];
    return { holds: actual === String(expected ?? wanted), actual };
  };
  const driver = { sleeps: 0, async sleep() { this.sleeps += 1; } };
  return { page, calls, handlers, readState, driver, clear: (label) => (page[label] = "") };
}

const text = (label, value, extra = {}) => ({
  key: label.toLowerCase().replace(/\s+/g, "_"),
  label,
  type: "text",
  selectors: [`input[data-iid="${label.toLowerCase().replace(/\s+/g, "_")}"]`],
  value: () => value,
  required: true,
  ...extra,
});

const run = (form, fields, deps = {}) =>
  quiet(() =>
    section.fillSection(form.driver, {}, fields, "customer details", null, {
      handlers: form.handlers,
      readState: form.readState,
      waitForLoader: async () => {},
      readToast: async () => null,
      ...deps,
    })
  );

/* ------------------------------ pass 2: one more try ------------------------------ */

test("a field that fails once is filled on the second try, after the form settles", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm({ "First Name": ["fail", "ok"] });
    const r = await run(form, [text("First Name", "ANMOL"), text("Mobile Number", "9876543210")]);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.failures, []);
    assert.ok(r.filled.includes("First Name"));
    assert.equal(form.calls["First Name"], 2);
  });
});

test("an exception inside a helper is a field failure with a plain reason, not the end of the section", async () => {
  await withSwitch("false", async () => {
    const form = fakeForm({ "First Name": ["throw"] });
    const r = await run(form, [text("First Name", "ANMOL"), text("Mobile Number", "9876543210")]);
    assert.equal(r.ok, false);
    assert.ok(r.filled.includes("Mobile Number"), "the section carried on to the next field");
    assert.match(r.failures[0].reason, /^"First Name" could not be filled \(stale element reference - element is not attached\)$/);
    assert.equal(r.error.includes("\n"), false);
  });
  await withSwitch(undefined, async () => {
    const form = fakeForm({ "First Name": ["throw", "ok"] });
    const r = await run(form, [text("First Name", "ANMOL")]);
    assert.equal(r.ok, true, "and with the switch on the second try rescues it");
  });
});

test("missing data and a portal rejection are NOT retried (a retry cannot change them)", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    const r = await run(form, [text("First Name", "")]);
    assert.equal(r.ok, false);
    assert.match(r.failures[0].reason, /this policy has no first name to enter/);
    assert.equal(form.calls["First Name"], undefined, "never typed");

    const toastForm = fakeForm();
    let toasts = 0;
    const rejected = await run(toastForm, [text("Pin Code", "614616", { settleMs: 2000 })], {
      readToast: async () => (++toasts ? { text: "Quotation already converted to proposal", isError: true } : null),
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.failures[0].reason, /Portal rejected the field update/);
    assert.equal(toastForm.calls["Pin Code"], 1, "typed once, not again");
  });
});

test("a field with its own slow-portal recovery is not retried again (its recovery already ran)", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm({ "PA Year": ["fail", "ok"] });
    const r = await run(form, [{ ...text("PA Year", "1 Year"), type: "select", recover: { tries: 2, run: async () => ({}) } }]);
    assert.equal(r.ok, false);
    assert.equal(form.calls["PA Year"], 1);
  });
});

/* ------------------------------ pass 3: read back ------------------------------ */

test("a field the portal cleared after it was filled is filled again", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    // filling the second field re-renders the form and clears the first
    const handlers = { ...form.handlers };
    const typed = handlers.typeIntoField;
    handlers.typeIntoField = async (driver, selectors, value, label, opts) => {
      const result = await typed(driver, selectors, value, label, opts);
      if (label === "Mobile Number" && form.calls["Mobile Number"] === 1) form.clear("First Name");
      return result;
    };
    const r = await run({ ...form, handlers }, [text("First Name", "ANMOL"), text("Mobile Number", "9876543210")]);
    assert.equal(r.ok, true, r.error);
    assert.equal(form.calls["First Name"], 2, "typed again after it was cleared");
    assert.equal(form.page["First Name"], "ANMOL");
  });
});

test("a field the portal clears every time is reported in plain words", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    const readState = async (driver, field) => (field.label === "First Name" ? { holds: false, actual: "" } : null);
    const r = await run(form, [text("First Name", "ANMOL")], { readState });
    assert.equal(r.ok, false);
    assert.match(r.failures[0].reason, /filled twice and the portal cleared it both times/);
    assert.equal(r.filled.includes("First Name"), false);
  });
});

test("a field that cannot be read right now (not on screen) is left alone, never refilled on a guess", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    const r = await run(form, [text("First Name", "ANMOL")], { readState: async () => null });
    assert.equal(r.ok, true);
    assert.equal(form.calls["First Name"], 1);
  });
});

test("switch off: exactly the old single pass — one call per field, no retry, no read-back", async () => {
  await withSwitch("false", async () => {
    const form = fakeForm({ "First Name": ["fail", "ok"] });
    let reads = 0;
    const r = await run(form, [text("First Name", "ANMOL"), text("Mobile Number", "9876543210")], {
      readState: async () => {
        reads++;
        return { holds: false, actual: "" };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(form.calls["First Name"], 1);
    assert.equal(form.calls["Mobile Number"], 1);
    assert.equal(reads, 0);
    assert.equal(
      r.error,
      'Could not fill the customer details on the KSHEMA quote form: First Name — "First Name" was not on the page.'
    );
  });
});

/* ------------------------------ before Save, and a Save that does nothing ------------------------------ */

test("before Save: every field filled so far is read back and a cleared one refilled — per job (per driver)", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    await run(form, [text("First Name", "ANMOL"), text("Mobile Number", "9876543210")]);
    form.clear("Mobile Number"); // a later section re-rendered the customer block

    const other = fakeForm(); // another job, another browser: nothing of the first job's
    const none = await quiet(() => section.recheckBeforeSave(other.driver, { handlers: other.handlers, readState: other.readState }));
    assert.deepEqual(none, { lost: [], refilled: [] });

    const r = await quiet(() => section.recheckBeforeSave(form.driver, { handlers: form.handlers, readState: form.readState }));
    assert.deepEqual(r.refilled, ["Mobile Number"]);
    assert.deepEqual(r.lost, []);
    assert.equal(form.page["Mobile Number"], "9876543210");
  });
});

test("Save did nothing: our invalid field is refilled and Save is pressed ONCE more", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    await run(form, [text("Engine Number", "ENG123")]);
    let saves = 0;
    const r = await quiet(() =>
      section.afterSilentSave(form.driver, {
        fallbackError: "old message",
        handlers: form.handlers,
        readInvalid: async () => [{ iid: "engine_number", label: "Engine Number", placeholder: "", message: "Required" }],
        retrySave: async () => {
          saves++;
          return { pageChanged: true };
        },
      })
    );
    assert.deepEqual(r, { ok: true, refilled: ["Engine Number"] });
    assert.equal(saves, 1);
  });
});

test("Save did nothing and still does nothing: the portal's own invalid fields are named — Save is not pressed a third time", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    await run(form, [text("Engine Number", "ENG123")]);
    let saves = 0;
    const r = await quiet(() =>
      section.afterSilentSave(form.driver, {
        fallbackError: "old message",
        handlers: form.handlers,
        readInvalid: async () => [
          { iid: "engine_number", label: "Engine Number", placeholder: "", message: "Required" },
          { iid: "", label: "", placeholder: "", message: "Chassis number is invalid" },
        ],
        retrySave: async () => {
          saves++;
          return { pageChanged: false };
        },
      })
    );
    assert.equal(saves, 1);
    assert.equal(r.ok, false);
    assert.match(r.error, /^Save and Continue did nothing — the KSHEMA quote form shows these fields as not filled or invalid - Engine Number \(Required\); Chassis number is invalid\./);
    assert.match(r.error, /filled again once \(Engine Number\)/);
  });
});

test("Save did nothing on fields that are not ours: no Save again, the fields are named; nothing invalid -> the old message", async () => {
  await withSwitch(undefined, async () => {
    const form = fakeForm();
    let saves = 0;
    const named = await quiet(() =>
      section.afterSilentSave(form.driver, {
        fallbackError: "old message",
        readInvalid: async () => [{ iid: "nominee_x", label: "Something Else", placeholder: "", message: "" }],
        retrySave: async () => (saves++, { pageChanged: true }),
      })
    );
    assert.equal(saves, 0);
    assert.match(named.error, /Something Else/);

    const nothing = await quiet(() =>
      section.afterSilentSave(form.driver, { fallbackError: "old message", readInvalid: async () => [] })
    );
    assert.deepEqual(nothing, { ok: false, error: "old message" });
  });
  await withSwitch("off", async () => {
    const r = await section.afterSilentSave({}, { fallbackError: "old message", readInvalid: async () => [{ label: "X" }] });
    assert.deepEqual(r, { ok: false, error: "old message" }, "switch off: the old message, nothing read");
  });
});

/* ------------------------------ readFieldState / readInvalidFields ------------------------------ */

const el = (props) => ({
  async isDisplayed() { return props.shown !== false; },
  async getAttribute(name) { return props.attrs ? props.attrs[name] ?? null : null; },
  async getTagName() { return props.tag || "input"; },
  async isSelected() { return !!props.selected; },
  async getText() { return props.text || ""; },
  async findElements() { return props.children || []; },
});
const driverWith = (map) => ({
  async findElements(locator) {
    const key = String(locator.value || locator);
    for (const [needle, list] of Object.entries(map)) if (key.includes(needle)) return list;
    return [];
  },
});

test("readFieldState: text compares what was typed, ignoring case and spaces; empty = not holding", async () => {
  const field = { type: "text", label: "Mobile", selectors: ['input[data-iid="c_mobile_number"]'] };
  const holding = driverWith({ c_mobile_number: [el({ attrs: { value: "98765 43210" } })] });
  assert.deepEqual(await kshemaFields.readFieldState(holding, field, "9876543210", "9876543210"), { holds: true, actual: "98765 43210" });
  const cleared = driverWith({ c_mobile_number: [el({ attrs: { value: "" } })] });
  assert.equal((await kshemaFields.readFieldState(cleared, field, "9876543210", "9876543210")).holds, false);
  const gone = driverWith({});
  assert.equal(await kshemaFields.readFieldState(gone, field, "x", "x"), null, "not on screen: unknown, not 'cleared'");
});

test("readFieldState: radio / checkbox / slider read their state", async () => {
  const radios = [el({ attrs: { value: "Yes" }, selected: false }), el({ attrs: { value: "No" }, selected: true })];
  const radioDriver = driverWith({ is_modified: [el({ tag: "mat-radio-group", children: radios })] });
  const radio = { type: "radio", label: "Modified", selectors: ['//*[@data-iid="is_modified"]'] };
  assert.equal((await kshemaFields.readFieldState(radioDriver, radio, "No")).holds, true);
  assert.equal((await kshemaFields.readFieldState(radioDriver, radio, "Yes")).holds, false);

  const box = { type: "checkbox", label: "PA", selectors: ["#pa"] };
  assert.equal((await kshemaFields.readFieldState(driverWith({ "#pa": [el({ selected: true })] }), box, true)).holds, true);
  assert.equal((await kshemaFields.readFieldState(driverWith({ "#pa": [el({ selected: false })] }), box, true)).holds, false);

  const slider = { type: "slider", label: "Nil Dep", selectors: [".nil"] };
  assert.equal((await kshemaFields.readFieldState(driverWith({ ".nil": [el({ attrs: { class: "x slider-on" } })] }), slider, true)).holds, true);
  assert.equal((await kshemaFields.readFieldState(driverWith({ ".nil": [el({ attrs: { class: "x slider-off" } })] }), slider, true)).holds, false);
});

test("readInvalidFields: runs one in-page read and returns its list (never throws on a non-array)", async () => {
  const list = [{ iid: "c_first_name", label: "First Name", placeholder: "", message: "Required" }];
  assert.deepEqual(await kshemaFields.readInvalidFields({ executeScript: async () => list }), list);
  assert.deepEqual(await kshemaFields.readInvalidFields({ executeScript: async () => null }), []);
});

/* ------------------------------ wiring ------------------------------ */

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
]) {
  test(`${path.basename(file)}: sections go through the shared careful fill; Save re-checks first and diagnoses a silent Save`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /kshemaSection"\)\.fillSection\(driver, data, fields, sectionName, capture, \{/);
    const submit = src.slice(src.indexOf("async function submitQuoteForm(driver) {"));
    const recheck = submit.indexOf("await section.recheckBeforeSave(driver);");
    const press = submit.indexOf("const first = await pressSave(button.element);");
    const silent = submit.indexOf("return await section.afterSilentSave(driver, {");
    assert.ok(recheck > 0 && press > recheck && silent > press, "re-check, then Save, then the diagnosis");
    // the add-ons page is recognised by ITS question, never by any Yes/No group (the quote form has those too)
    assert.ok(!submit.includes(`asLocator('//mat-radio-group[.//input[@value="Yes" or @value="No"]]')`));
    assert.match(submit, /want add-on/);
  });
}

test("asLocator is exported (both Save and Continue checks call it; missing, they threw inside a try and never ran)", () => {
  assert.equal(typeof kshemaFields.asLocator, "function");
  assert.equal(kshemaFields.asLocator("//div").using, "xpath");
  assert.equal(kshemaFields.asLocator("input.x").using, "css selector");
});
