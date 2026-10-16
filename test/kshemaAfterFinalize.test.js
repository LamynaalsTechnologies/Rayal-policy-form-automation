// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaAfterFinalize.test.js
//
// After "Save and Finalize" KSHEMA shows a loader while it saves and draws the KYC page when the loader ends. A run stopped
// with "KYC button did not appear after 15 seconds" (2026-10-16): the wait was shorter than the portal, the loader was not
// waited for, and when the portal refused to move on (the Financier Name box in error) the message named nothing.
// kshemaAfterFinalize.js waits for the loader, reads the Financier Name box again and says WHY the button did not come.
// No browser and no real waiting: a scripted page (what is on screen at each moment) and a fake clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const after = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaAfterFinalize.js"));

const quiet = async (fn) => {
  const saved = ["log", "warn", "error"].map((k) => [k, console[k]]);
  saved.forEach(([k]) => (console[k] = () => {}));
  try {
    return await fn();
  } finally {
    saved.forEach(([k, f]) => (console[k] = f));
  }
};
const withEnv = async (vars, fn) => {
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
};
const noColon = (text) => assert.equal(String(text).includes(":"), false, `no colon (beautifyError keeps only the text after the last one) in: ${text}`);

const BUTTON = { id: "kyc-button" };
const NO_BOX = { present: false, value: "", invalid: false, error: "" };

/**
 * What the portal shows over time. Times are ms on the fake clock; a range is [from, to).
 *   loader      ranges where the loader is open
 *   buttonAt    the KYC button is on the page from this time (null = never)
 *   toasts      [{ from, to, text, isError }] snackbars
 *   financier   the Financier Name box: an object, or (t) => object
 *   invalid     the portal's invalid fields: an array, or (t) => array
 */
function site({ loader = [], buttonAt = null, toasts = [], financier = NO_BOX, invalid = [], title = "KSHEMA Portal" } = {}) {
  const clock = { t: 0 };
  const calls = { buttons: 0, loader: 0, toast: 0, financier: 0, invalid: 0 };
  const within = (ranges, t) => ranges.some(([a, b]) => t >= a && t < b);
  const driver = {}; // the per-driver state is keyed on it, so one per test
  const deps = {
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    findButtons: async () => { calls.buttons += 1; return buttonAt !== null && clock.t >= buttonAt ? [BUTTON] : []; },
    loaderVisible: async () => { calls.loader += 1; return within(loader, clock.t); },
    readToast: async () => {
      calls.toast += 1;
      const hit = toasts.find((x) => clock.t >= x.from && clock.t < x.to);
      return hit ? { text: hit.text, isError: hit.isError !== false } : null;
    },
    readFinancier: async () => { calls.financier += 1; return typeof financier === "function" ? financier(clock.t) : financier; },
    readInvalid: async () => { calls.invalid += 1; return typeof invalid === "function" ? invalid(clock.t) : invalid; },
    pageTitle: async () => title,
  };
  return { driver, deps, clock, calls };
}
const WITH_FINANCIER = { hasFinancier: true, financierName: "SERA COM" };
const waitAfter = (s, data = {}) => quiet(() => after.waitAfterFinalize(s.driver, data, s.deps));
const awaitButton = (s, data = {}) => quiet(() => after.awaitKycButton(s.driver, data, s.deps));

/* ------------------------------ the switches ------------------------------ */

test("KSHEMA_AFTER_FINALIZE_ENABLED: ON unless false / 0 / no / off", async () => {
  await withEnv({ KSHEMA_AFTER_FINALIZE_ENABLED: undefined }, async () => assert.equal(after.isAfterFinalizeEnabled(), true));
  await withEnv({ KSHEMA_AFTER_FINALIZE_ENABLED: "true" }, async () => assert.equal(after.isAfterFinalizeEnabled(), true));
  for (const off of ["false", "0", "no", "OFF", " Off "]) {
    await withEnv({ KSHEMA_AFTER_FINALIZE_ENABLED: off }, async () => assert.equal(after.isAfterFinalizeEnabled(), false, off));
  }
});

test("KSHEMA_AFTER_FINALIZE_WAIT_SECONDS: 60 by default, clamped to 15..300, junk means the default", async () => {
  const ms = (v) => withEnv({ KSHEMA_AFTER_FINALIZE_WAIT_SECONDS: v }, async () => after.afterFinalizeWaitMs());
  assert.equal(await ms(undefined), 60000);
  assert.equal(await ms("90"), 90000);
  assert.equal(await ms("5"), 15000, "never shorter than the old wait");
  assert.equal(await ms("9999"), 300000);
  for (const junk of ["", "abc", "-5", "0", "NaN"]) assert.equal(await ms(junk), 60000, junk);
});

test("switch off: waitAfterFinalize and checkFinalizeEnabled touch nothing", async () => {
  await withEnv({ KSHEMA_AFTER_FINALIZE_ENABLED: "false" }, async () => {
    const s = site({ loader: [[0, 99999]], financier: { present: true, value: "", invalid: true, error: "" } });
    assert.deepEqual(await waitAfter(s, WITH_FINANCIER), { ok: true, skipped: "switched off" });
    const button = { getAttribute: async () => { throw new Error("must not be read"); } };
    assert.deepEqual(await quiet(() => after.checkFinalizeEnabled(s.driver, button, WITH_FINANCIER, s.deps)), { ok: true, skipped: "switched off" });
    assert.deepEqual(s.calls, { buttons: 0, loader: 0, toast: 0, financier: 0, invalid: 0 });
    assert.equal(s.clock.t, 0, "no waiting either");
  });
});

test("switch off: the KYC button is waited for exactly as before - 15 seconds, the old message", async () => {
  await withEnv({ KSHEMA_AFTER_FINALIZE_ENABLED: "false" }, async () => {
    const seen = [];
    const found = {
      wait: async (fn, ms, message) => { seen.push([ms, message]); return BUTTON; },
    };
    const ok = await quiet(() => after.awaitKycButton(found, {}));
    assert.deepEqual(ok, { ok: true, button: BUTTON });
    assert.deepEqual(seen, [[15000, "KYC button did not appear after 15 seconds"]]);

    const timeout = {
      wait: async (fn, ms, message) => { throw new Error(`${message}\nWait timed out after 15023ms`); },
    };
    const failed = await quiet(() => after.awaitKycButton(timeout, {}));
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "Could not find or click the KYC button, or capture link: KYC button did not appear after 15 seconds\nWait timed out after 15023ms", "the old catch's message, word for word");

    // the condition handed to driver.wait is the old one: the first matching element, or null
    let condition;
    await quiet(() => after.awaitKycButton({ wait: async (fn) => { condition = fn; return BUTTON; }, findElements: async () => [] }, {}));
    assert.equal(await condition(), null);
    const d2 = { findElements: async (locator) => { assert.equal(locator.value, after.KYC_BUTTON_XPATH); return [BUTTON, { id: "second" }]; } };
    await quiet(() => after.awaitKycButton({ wait: async (fn) => { condition = fn; return BUTTON; }, ...d2 }, {}));
    assert.equal(await condition(), BUTTON);
  });
});

/* ------------------------------ right after the click: the loader ------------------------------ */

test("waitAfterFinalize: no loader ever opens - looks for a moment, then goes on (nothing to wait for)", async () => {
  const s = site();
  const r = await waitAfter(s);
  assert.equal(r.ok, true);
  assert.equal(r.loaderSeen, false);
  assert.equal(r.stillSpinning, false);
  assert.ok(s.clock.t >= 1500 && s.clock.t <= 2500, `looked ${s.clock.t}ms`);
});

test("waitAfterFinalize: waits for the loader to end - and a moment past it", async () => {
  const s = site({ loader: [[0, 7000]] });
  const r = await waitAfter(s);
  assert.equal(r.ok, true);
  assert.equal(r.loaderSeen, true);
  assert.equal(r.stillSpinning, false);
  assert.ok(s.clock.t >= 7800, `waited until ${s.clock.t}ms - past the end of the loader and its quiet moment`);
  assert.ok(s.clock.t <= 9000, `and no longer than needed (${s.clock.t}ms)`);
});

test("waitAfterFinalize: a loader that closes and opens again straight away (two requests in a row) is not 'finished' at the gap", async () => {
  const s = site({ loader: [[0, 3000], [3400, 6000]] });
  const r = await waitAfter(s);
  assert.equal(r.ok, true);
  assert.ok(s.clock.t >= 6800, `went past the second loader (${s.clock.t}ms)`);
});

test("waitAfterFinalize: a loader that never closes is waited for as long as the budget, then the run goes on (the KYC step will look)", async () => {
  const s = site({ loader: [[0, 1e9]], financier: { present: true, value: "", invalid: true, error: "" } });
  const r = await waitAfter(s, WITH_FINANCIER);
  assert.equal(r.ok, true, "a stuck loader is not a verdict by itself");
  assert.equal(r.stillSpinning, true);
  assert.ok(s.clock.t >= 60000 && s.clock.t <= 61000, `gave it the 60 s budget (${s.clock.t}ms)`);
  assert.equal(s.calls.financier, 0, "the box is not judged while the page is still busy");
});

test("waitAfterFinalize: the budget follows KSHEMA_AFTER_FINALIZE_WAIT_SECONDS", async () => {
  await withEnv({ KSHEMA_AFTER_FINALIZE_WAIT_SECONDS: "20" }, async () => {
    const s = site({ loader: [[0, 1e9]] });
    await waitAfter(s);
    assert.ok(s.clock.t >= 20000 && s.clock.t <= 21000, `${s.clock.t}ms`);
  });
});

/* ------------------------------ right after the click: the Financier Name box, again ------------------------------ */

test("the Financier Name box marked invalid after Save and Finalize is KSHEMA's refusal - reported with the portal's wording", async () => {
  const s = site({ financier: { present: true, value: "SERA", invalid: true, error: "Select a financier from the list" } });
  const r = await waitAfter(s, WITH_FINANCIER);
  assert.equal(r.ok, false);
  assert.equal(
    r.error,
    'KSHEMA did not accept Save and Finalize - the Financier Name box is marked invalid (Select a financier from the list) and it holds "SERA". Check the financier name on the policy.'
  );
  noColon(r.error);
  assert.equal(s.calls.financier, 2, "read twice before it is called a refusal");
});

test("a box that was invalid for a moment and is fine on the second look is not a refusal", async () => {
  const s = site({ financier: (t) => ({ present: true, value: "SERA", invalid: t < 3000, error: "" }) });
  const r = await waitAfter(s, WITH_FINANCIER);
  assert.equal(r.ok, true);
  assert.equal(s.calls.financier, 2);
});

test("a page that has left the form has no Financier Name box - that is success, not an error", async () => {
  const s = site({ loader: [[0, 4000]], financier: NO_BOX });
  const r = await waitAfter(s, WITH_FINANCIER);
  assert.equal(r.ok, true);
});

test("an empty box that is not marked invalid is left to the timeout diagnosis (a form may reset itself on its way out)", async () => {
  const s = site({ financier: { present: true, value: "", invalid: false, error: "" } });
  const r = await waitAfter(s, WITH_FINANCIER);
  assert.equal(r.ok, true);
  assert.equal(s.calls.financier, 1, "one look is enough when nothing is marked invalid - no second look, no verdict");
});

test("the box is read only for a policy that has a financier, and only while KSHEMA_FINANCIER_ENABLED", async () => {
  const none = site({ financier: { present: true, value: "", invalid: true, error: "" } });
  assert.equal((await waitAfter(none, { hasFinancier: false })).ok, true);
  assert.equal((await waitAfter(site(), {})).ok, true);
  assert.equal(none.calls.financier, 0);

  await withEnv({ KSHEMA_FINANCIER_ENABLED: "off" }, async () => {
    const off = site({ financier: { present: true, value: "", invalid: true, error: "" } });
    assert.equal((await waitAfter(off, WITH_FINANCIER)).ok, true);
    assert.equal(off.calls.financier, 0);
  });
});

/* ------------------------------ the KYC step: waiting for its button ------------------------------ */

test("the KYC button that comes after a slow loader (25 s - the old 15 s wait gave up) is found", async () => {
  const s = site({ loader: [[0, 24000]], buttonAt: 25000 });
  await waitAfter(s);                      // click at 0 - waits for the loader (to 24.8 s)
  const r = await awaitButton(s);
  assert.equal(r.ok, true);
  assert.equal(r.button, BUTTON);
  assert.ok(s.clock.t >= 25000, `found at ${s.clock.t}ms`);
});

test("a button that is already there while the loader is open: the loader is waited for first", async () => {
  const s = site({ loader: [[0, 9000]], buttonAt: 0 });
  const r = await awaitButton(s);
  assert.equal(r.ok, true);
  assert.ok(s.clock.t >= 9000, `pressed only after the loader closed (${s.clock.t}ms)`);
});

test("a button with a loader that never closes is pressed anyway after a while (a spinner that stays must not stall the run)", async () => {
  const s = site({ loader: [[0, 1e9]], buttonAt: 0 });
  const r = await awaitButton(s);
  assert.equal(r.ok, true);
  assert.ok(s.clock.t >= 15000 && s.clock.t <= 16000, `${s.clock.t}ms`);
});

test("patience is counted from the Save and Finalize click, not from each step", async () => {
  const s = site({ loader: [[0, 40000]] });
  await waitAfter(s);                      // spent ~41 s on the loader
  const r = await awaitButton(s);
  assert.equal(r.ok, false);
  assert.ok(s.clock.t <= 61000, `gave up ${s.clock.t}ms after the click, not 41 s + another 60 s`);
  assert.match(r.error, /^The KYC button did not appear within 6\d seconds after Save and Finalize - /);
});

test("the KYC step always gets a look of its own, even when the click was long ago", async () => {
  const s = site();
  await waitAfter(s);                      // click at 0
  s.clock.t = 100000;                      // a long time passes before the KYC step starts
  const r = await awaitButton(s);
  assert.equal(r.ok, false);
  assert.ok(s.clock.t >= 110000 && s.clock.t <= 111000, `looked for 10 s (${s.clock.t - 100000}ms)`);
});

/* ------------------------------ the KYC button never comes: the diagnosis ------------------------------ */

test("nothing found at all: says so, with the page title, after the full 60 s", async () => {
  const s = site({ title: "KSHEMA Portal" });
  const r = await awaitButton(s);
  assert.equal(r.ok, false);
  assert.equal(
    r.error,
    'The KYC button did not appear within 60 seconds after Save and Finalize - the page showed no message, no invalid field and no loader, so the portal simply did not move on (the page is "KSHEMA Portal").'
  );
  noColon(r.error);
  assert.ok(s.clock.t >= 60000 && s.clock.t <= 61000);
});

test("the Financier Name box empty: named", async () => {
  const s = site({ financier: { present: true, value: "", invalid: false, error: "" } });
  const r = await awaitButton(s, WITH_FINANCIER);
  assert.equal(r.ok, false);
  assert.equal(r.error, "The KYC button did not appear within 60 seconds after Save and Finalize - the Financier Name box is empty.");
});

test("the Financier Name box marked invalid: named, with the portal's message and what the box holds", async () => {
  const s = site({ financier: { present: true, value: "SERA", invalid: true, error: "Financier: not in the list" } });
  const r = await awaitButton(s, WITH_FINANCIER);
  assert.match(r.error, /the Financier Name box is marked invalid \(Financier - not in the list\) and it holds "SERA"\.$/);
  noColon(r.error);
});

test("a filled, valid Financier Name box is not blamed", async () => {
  const s = site({ financier: { present: true, value: "SERA COM PVT. LTD.", invalid: false, error: "" } });
  const r = await awaitButton(s, WITH_FINANCIER);
  assert.match(r.error, /the page showed no message, no invalid field and no loader/);
  assert.equal(r.error.includes("Financier"), false);
});

test("the policy has no financier: the box is not even read", async () => {
  const s = site({ financier: { present: true, value: "", invalid: true, error: "" } });
  const r = await awaitButton(s, { hasFinancier: false });
  assert.match(r.error, /no invalid field/);
  assert.equal(s.calls.financier, 0);
});

test("other fields the portal marks invalid are listed (the financier is not repeated, names are cleaned)", async () => {
  const s = site({
    invalid: [
      { iid: "n_name", label: "Nominee Name", placeholder: "", message: "" },
      { iid: "", label: "", placeholder: "* Relationship", message: "" },
      { iid: "", label: "", placeholder: "+ Financier Name", message: "" },
      { iid: "n_name", label: "Nominee Name", placeholder: "", message: "" },
      { iid: "", label: "", placeholder: "", message: "Enter a valid mobile number" },
    ],
  });
  const r = await awaitButton(s, WITH_FINANCIER);
  assert.equal(
    r.error,
    "The KYC button did not appear within 60 seconds after Save and Finalize - KSHEMA marks these fields as not filled or invalid - Nominee Name, Relationship, Enter a valid mobile number."
  );
});

test("more than six invalid fields: the first six and a count", async () => {
  const s = site({ invalid: Array.from({ length: 9 }, (_, i) => ({ iid: `f${i}`, label: `Field ${i}`, placeholder: "", message: "" })) });
  const r = await awaitButton(s);
  assert.match(r.error, /Field 0, Field 1, Field 2, Field 3, Field 4, Field 5 and 3 more\.$/);
});

test("an error message the portal flashed while the page was loading is reported (a snackbar is gone after a few seconds)", async () => {
  const s = site({
    loader: [[0, 6000]],
    toasts: [{ from: 2000, to: 5000, text: "Could not save: nominee age is below 18" }],
  });
  await waitAfter(s);
  const r = await awaitButton(s);
  assert.equal(r.ok, false);
  assert.match(r.error, /- KSHEMA said "Could not save - nominee age is below 18"\.$/);
  noColon(r.error);
});

test("a message that is not an error is ignored", async () => {
  const s = site({ toasts: [{ from: 0, to: 99999, text: "Quotation saved successfully", isError: false }] });
  const r = await awaitButton(s);
  assert.match(r.error, /no message, no invalid field/);
});

test("a loader that never ended is named, and the wait is bounded (budget plus a short grace)", async () => {
  const s = site({ loader: [[0, 1e9]] });
  const r = await awaitButton(s);
  assert.equal(r.ok, false);
  assert.match(r.error, /^The KYC button did not appear within 70 seconds after Save and Finalize - KSHEMA's loader was still spinning \(the portal is slow or stuck\)\.$/);
  assert.ok(s.clock.t <= 71000, `${s.clock.t}ms`);
});

test("everything found is reported, most telling first: the message, the financier, the other fields, the loader", async () => {
  const s = site({
    loader: [[0, 1e9]],
    toasts: [{ from: 0, to: 99999, text: "Please provide nominee details" }],
    financier: { present: true, value: "", invalid: false, error: "" },
    invalid: [{ iid: "x", label: "Nominee Name", placeholder: "", message: "" }],
  });
  const r = await awaitButton(s, WITH_FINANCIER);
  const prefix = "The KYC button did not appear within 70 seconds after Save and Finalize - ";
  assert.ok(r.error.startsWith(prefix), r.error);
  const parts = r.error.slice(prefix.length).replace(/\.$/, "").split("; ");
  assert.deepEqual(parts, [
    'KSHEMA said "Please provide nominee details"',
    "the Financier Name box is empty",
    "KSHEMA marks these fields as not filled or invalid - Nominee Name",
    "KSHEMA's loader was still spinning (the portal is slow or stuck)",
  ]);
  noColon(r.error);
});

test("a page that cannot be read while diagnosing still ends in a sentence (best effort)", async () => {
  const s = site();
  s.deps.readInvalid = async () => { throw new Error("target closed"); };
  s.deps.readFinancier = async () => { throw new Error("target closed"); };
  s.deps.pageTitle = async () => { throw new Error("target closed"); };
  const r = await awaitButton(s, WITH_FINANCIER);
  assert.equal(r.ok, false);
  assert.match(r.error, /the portal simply did not move on\.$/);
});

test("a browser that dies while waiting is not swallowed (the caller reports it)", async () => {
  const s = site();
  s.deps.findButtons = async () => { throw new Error("no such window: target window already closed"); };
  await assert.rejects(() => awaitButton(s), /no such window/);
});

/* ------------------------------ before the click: a button that is still disabled ------------------------------ */

const button = (attrs) => ({ getAttribute: async (name) => (name in attrs ? attrs[name] : null) });
const check = (s, b, data = {}) => quiet(() => after.checkFinalizeEnabled(s.driver, b, data, s.deps));

test("checkFinalizeEnabled: an enabled button passes without reading the form", async () => {
  const s = site();
  assert.deepEqual(await check(s, button({ disabled: null, class: "mat-mdc-button" })), { ok: true });
  assert.deepEqual(s.calls, { buttons: 0, loader: 0, toast: 0, financier: 0, invalid: 0 });
});

test("checkFinalizeEnabled: disabled in any of the ways the form's own wait recognises", async () => {
  for (const attrs of [{ disabled: "true" }, { disabled: "disabled" }, { disabled: null, class: "mdc-button mat-mdc-button-disabled" }]) {
    const s = site({ financier: { present: true, value: "", invalid: false, error: "" } });
    const r = await check(s, button(attrs), WITH_FINANCIER);
    assert.equal(r.ok, false, JSON.stringify(attrs));
  }
});

test("a disabled Save and Finalize with the Financier Name box empty stops before the click, naming it", async () => {
  const s = site({ financier: { present: true, value: "", invalid: false, error: "" } });
  const r = await check(s, button({ disabled: "true" }), WITH_FINANCIER);
  assert.deepEqual(r, { ok: false, error: "Save and Finalize stayed disabled - the Financier Name box is empty." });
});

test("a disabled Save and Finalize with other invalid fields lists them", async () => {
  const s = site({ invalid: [{ iid: "", label: "Nominee DOB", placeholder: "", message: "" }] });
  const r = await check(s, button({ disabled: "true" }));
  assert.deepEqual(r, { ok: false, error: "Save and Finalize stayed disabled - KSHEMA marks these fields as not filled or invalid - Nominee DOB." });
  noColon(r.error);
});

test("a disabled Save and Finalize with nothing to blame is pressed as before (no new way to fail)", async () => {
  const s = site();
  const r = await check(s, button({ disabled: "true" }), WITH_FINANCIER);
  assert.deepEqual(r, { ok: true, stillDisabled: true });
});

test("a button that cannot be read is treated as enabled", async () => {
  const s = site();
  const r = await check(s, { getAttribute: async () => { throw new Error("stale element"); } });
  assert.deepEqual(r, { ok: true });
});

/* ------------------------------ pinned to the portal's markup, and wired into both flows ------------------------------ */

test("the KYC button locator and the loader selector are the ones the flow always used", () => {
  assert.equal(
    after.KYC_BUTTON_XPATH,
    '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "kyc")] | //i-kyc//button'
  );
  assert.equal(after.OLD_KYC_WAIT_MESSAGE, "KYC button did not appear after 15 seconds");
  // the loader is the same element waitForKshemaLoaderToDisappear watches everywhere else in the flow
  for (const form of [
    path.join(ROOT, "fullPolicycompany", "kshemaForm.js"),
    path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"),
  ]) {
    assert.ok(fs.readFileSync(form, "utf8").includes(`const loaderSelector = '${after.LOADER_SELECTOR}';`), `${path.basename(form)} watches ${after.LOADER_SELECTOR}`);
  }
});

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
]) {
  const name = path.basename(file);
  const src = fs.readFileSync(file, "utf8");
  const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const REQUIRE = /require\("(\.\/kshemaAfterFinalize|\.\.\/\.\.\/\.\.\/fullPolicycompany\/kshema\/kshemaAfterFinalize)"\)/;

  test(`${name}: Save and Finalize - disabled check before the click, loader wait after it, then the portal's toast`, () => {
    const body = slice("async function fillNomineeDetails", "\n}\n");
    const check = body.indexOf("afterFinalize.checkFinalizeEnabled(driver, finalizeBtn, data)");
    const failBlocked = body.indexOf("if (!blocked.ok) return { ok: false, error: blocked.error };");
    const click = body.indexOf('await clickElement(driver, finalizeBtn, "Save and Finalize button");');
    const wait = body.indexOf("afterFinalize.waitAfterFinalize(driver, data)");
    const failSaved = body.indexOf("if (!saved.ok) return { ok: false, error: saved.error };");
    const toast = body.indexOf("const toast = await getToast(driver);");
    assert.ok(check > 0 && failBlocked > check && click > failBlocked && wait > click && failSaved > wait && toast > failSaved, `order: ${[check, failBlocked, click, wait, failSaved, toast]}`);
    assert.match(body, REQUIRE);
  });

  test(`${name}: the KYC step waits through awaitKycButton - the 15-second wait lives only in the switch-off path`, () => {
    const body = slice("async function fillKYCDetails", "const originalWindow");
    assert.match(body, REQUIRE);
    assert.ok(body.includes(".awaitKycButton(driver, data);"));
    assert.ok(body.includes("if (!waited.ok) return { ok: false, error: waited.error };"));
    assert.ok(body.includes("const kycBtn = waited.button;"));
    assert.equal(body.includes("KYC button did not appear after 15 seconds"), false, "no inline wait left in the form");
    assert.equal(body.includes("driver.wait("), false);
  });
}
