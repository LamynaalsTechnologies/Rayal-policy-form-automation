// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaSurnameSwitch.test.js
//
// KSHEMA's Last Name box follows the "Send to KSHEMA" switch on the Online Policy form's Surname (owner, 2026-11-04):
// on = the Surname is typed, off (the default, and every policy saved before the switch) = the box is left empty.
// The full flow and the TP flow alike. The real customer fields run through the real fillSection on a fake page.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const section = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSection.js"));
const FORMS = {
  full: require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js")),
  "TP only": require(path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js")),
};

const quiet = async (fn) => {
  const saved = ["log", "warn", "error"].map((k) => [k, console[k]]);
  saved.forEach(([k]) => (console[k] = () => {}));
  try {
    return await fn();
  } finally {
    saved.forEach(([k, f]) => (console[k] = f));
  }
};

/** A fake page: records what each box was given; `fail` lists the boxes that cannot be typed. */
function fakePage(fail = []) {
  const typed = {};
  const answer = (label, value) => {
    if (fail.includes(label)) return { ok: false, value: null, reason: `"${label}" was not on the page` };
    typed[label] = String(value);
    return { ok: true, value: String(value), reason: null };
  };
  const handlers = {
    typeIntoField: async (driver, selectors, value, label) => answer(label, value),
    selectMatOption: async (driver, selectors, value, label) => answer(label, Array.isArray(value) ? value[0] : value),
  };
  const readState = async (driver, field, wanted, expected) =>
    field.label in typed ? { holds: typed[field.label] === String(expected ?? wanted), actual: typed[field.label] } : null;
  return { typed, handlers, readState, driver: { async sleep() {} } };
}

const nameFields = (form) => form.CUSTOMER_FIELDS.filter((f) => f.key === "firstName" || f.key === "lastName");
const fill = (form, data, page) =>
  quiet(() =>
    section.fillSection(page.driver, data, nameFields(form), "customer details", null, {
      handlers: page.handlers,
      readState: page.readState,
      waitForLoader: async () => {},
      readToast: async () => null,
    })
  );

const policy = (over = {}) => ({ firstName: "RAVI", lastName: "KUMAR", ...over });

for (const [name, form] of Object.entries(FORMS)) {
  test(`${name}: switch on -> the Surname is typed into Last Name`, async () => {
    const page = fakePage();
    const r = await fill(form, policy({ kshemaSendSurname: true }), page);
    assert.equal(r.ok, true, r.error);
    assert.equal(page.typed["First Name"], "RAVI");
    assert.equal(page.typed["Last Name"], "KUMAR");
  });

  test(`${name}: switch off, or a policy saved before the switch -> Last Name is left empty, no failure`, async () => {
    for (const data of [policy({ kshemaSendSurname: false }), policy()]) {
      const page = fakePage();
      const r = await fill(form, data, page);
      assert.equal(r.ok, true, r.error);
      assert.equal(page.typed["First Name"], "RAVI");
      assert.equal("Last Name" in page.typed, false, "never typed");
      assert.deepEqual(r.failures, []);
    }
  });

  test(`${name}: only a real true switches it on ("true" text is not)`, async () => {
    const page = fakePage();
    await fill(form, policy({ kshemaSendSurname: "true" }), page);
    assert.equal("Last Name" in page.typed, false);
  });

  test(`${name}: switched on, a Last Name box that cannot be typed is a failure (not skipped quietly)`, async () => {
    const page = fakePage(["Last Name"]);
    const r = await fill(form, policy({ kshemaSendSurname: true }), page);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => f.label === "Last Name"), JSON.stringify(r.failures));
  });
}
