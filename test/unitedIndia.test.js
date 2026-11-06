// United India (2026-11-06): a TP-only insurer whose portal automation is not built yet. What the automation must already
// do for it: never run another insurer's form for it, accept its portal login, and accept it as the customer's existing TP
// insurer on Reliance OD (Reliance's list item matched by "unitedindia"). No browser, no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const tp = require("../lib/existingTpDetails");
const steps = require("../multiCompany/common/reliance/relianceOdSteps");
const ProviderCredential = require("../models/ProviderCredential");

/* ------------------------- the full-flow dispatcher (server.js) ------------------------- */

// server.js starts the queue when it is required, so its dispatcher is taken from the source and run with fake forms.
const SRC = fs.readFileSync(require.resolve("../server.js"), "utf8");
const slice = (from, to) => {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `server.js still has ${from}`);
  return SRC.slice(a, b + to.length);
};
const LABELS = slice("const COMPANY_LABELS = {", "key.slice(1);\n};");
const DISPATCH = slice("const dispatchBundled = async (", "return { run };\n};");

function makeDispatcher() {
  const calls = [];
  const form = (name) => (data) => {
    calls.push({ name, username: data.username });
    return Promise.resolve({ success: true });
  };
  const build = new Function(
    "fillRelianceForm",
    "fillNationalForm",
    "fillKshemaForm",
    "resolveNationalNominee",
    "jobQueueCollection",
    `${LABELS}\n${DISPATCH}\nreturn { dispatchBundled, companyLabel };`
  );
  const made = build(form("reliance"), form("national"), form("kshema"), async () => ({ name: "N", relation: "Father", age: 40 }), {});
  return { ...made, calls };
}
const ctx = (companyName) => ({ companyName, creds: { username: "u", password: "p", loginUrl: "x" }, jobId: "j", jobIdentifier: "ji", attemptNumber: 1, queueName: "Q" });

test("dispatchBundled: Reliance / National / KSHEMA run their own full form, as before", async () => {
  const d = makeDispatcher();
  for (const c of ["reliance", "kshema"]) {
    const { run } = await d.dispatchBundled({}, ctx(c));
    await run;
  }
  const { run } = await d.dispatchBundled({ nomineeName: "N", nomineeRelation: "Father", nomineeAge: 40 }, ctx("national"));
  await run;
  assert.deepEqual(d.calls.map((c) => c.name), ["reliance", "kshema", "national"]);
});

test("dispatchBundled: United India (or any company without a full flow) stops with [E110] - Reliance's form is NOT run", async () => {
  const d = makeDispatcher();
  for (const c of ["united india", "icici"]) {
    await assert.rejects(d.dispatchBundled({}, ctx(c)), (e) => /^\[E110\] No full \(OD \+ TP\) automation exists for /.test(e.message));
  }
  await assert.rejects(d.dispatchBundled({}, ctx("united india")), /exists for United India\. Sell it as TP only, or as the TP side of a Combined Make and Model\./);
  assert.deepEqual(d.calls, [], "no form was opened");
});

test("the log / message label is United India (not 'United india')", () => {
  const d = makeDispatcher();
  assert.equal(d.companyLabel("united india"), "United India");
  assert.equal(d.companyLabel("kshema"), "KSHEMA");
  assert.equal(d.companyLabel("national"), "National");
});

/* ------------------------- existing TP insurer on Reliance OD ------------------------- */

const good = (over = {}) => ({
  existingTpPolicyNumber: "uii/tp/0001",
  existingTpInsurer: "United India",
  existingTpStartDate: "01-10-2026",
  existingTpEndDate: "30-09-2027",
  ...over,
});

test("existing TP: United India is accepted, by its short or full name", () => {
  for (const name of ["United India", "united india", "UNITED INDIA INSURANCE COMPANY LIMITED"]) {
    const r = tp.validateExistingTpDetails(good({ existingTpInsurer: name }));
    assert.equal(r.insurer.key, "unitedindia", name);
    assert.equal(r.insurer.label, "United India");
    assert.equal(r.insurer.match, "unitedindia");
  }
});

test("chooseInsurerOption: Reliance's United India item is chosen by its text; an unknown key is NOT National any more", () => {
  const o = (text) => ({ text, disabled: false });
  const list = ["Select Insurer", "KSHEMA GENERAL INSURANCE LIMITED", "NATIONAL INSURANCE COMPANY LIMITED", "UNITED INDIA INSURANCE CO. LTD."].map(o);
  assert.equal(steps.chooseInsurerOption("unitedindia", list).option.text, "UNITED INDIA INSURANCE CO. LTD.");
  assert.equal(steps.chooseInsurerOption("national", list).option.text, "NATIONAL INSURANCE COMPANY LIMITED");
  assert.equal(steps.chooseInsurerOption("kshema", list).option.text, "KSHEMA GENERAL INSURANCE LIMITED");
  // a list without United India: none (the run's error then lists what the list offers)
  assert.equal(steps.chooseInsurerOption("unitedindia", list.slice(0, 3)).why, "none");
  // an unknown key used to fall back to National's words
  assert.equal(steps.chooseInsurerOption("icici", list).option, null);
});

/* ------------------------- portal login ------------------------- */

test("a United India portal login is a valid credential (provider 'united india'); an unknown provider is not", () => {
  const base = { userId: "5f0000000000000000000001", clientId: "5f0000000000000000000002", username: "u", password: "p" };
  assert.equal(new ProviderCredential({ ...base, provider: "united india" }).validateSync(), undefined);
  const bad = new ProviderCredential({ ...base, provider: "icici" }).validateSync();
  assert.ok(bad && bad.errors.provider);
});
