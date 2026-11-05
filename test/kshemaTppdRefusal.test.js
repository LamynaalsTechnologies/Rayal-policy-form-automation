// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaTppdRefusal.test.js
//
// KSHEMA refuses Limited TPPD on some RTOs with its "Note" popup — an Angular Material dialog, not a snackbar, so the
// toast reader never saw it and the run logged "✓ TPPD Restrict: Yes" and went on behind the popup (2026-11-05). Now
// the PA Cover step looks for the popup when TPPD was ticked, and a popup that names TPPD stops the run with KSHEMA's
// own sentence and a screenshot (the owner's ask). The full flow and the TP-only copy alike. No browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { readMessageDialog, waitForMessageDialog } = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaDialog.js"));
const FORMS = {
  full: require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js")),
  "TP only": require(path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js")),
};

const PORTAL = "Please unselect limited TPPD as TPPD Discount is not applicable for this RTO";

const quiet = async (fn) => {
  const saved = ["log", "warn", "error"].map((k) => [k, console[k]]);
  const lines = [];
  saved.forEach(([k]) => (console[k] = (...a) => lines.push(a.join(" "))));
  try {
    return { value: await fn(), lines };
  } finally {
    saved.forEach(([k, f]) => (console[k] = f));
  }
};

/** A page whose executeScript answers with the popup's lines (null = no popup); `after` polls before it shows. */
const fakeDriver = (lines, { after = 0, throws = false } = {}) => {
  let calls = 0;
  return {
    calls: () => calls,
    async executeScript() {
      calls += 1;
      if (throws) throw new Error("no such window");
      return calls > after ? lines : null;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
};

test("readMessageDialog: title + message, a one-line popup, nothing, a page that cannot be read", async () => {
  assert.deepEqual(await readMessageDialog(fakeDriver(["Note", PORTAL])), { title: "Note", text: PORTAL });
  assert.deepEqual(await readMessageDialog(fakeDriver(["  Something   odd  "])), { title: "", text: "Something odd" });
  assert.equal(await readMessageDialog(fakeDriver(null)), null);
  assert.equal(await readMessageDialog(fakeDriver([])), null);
  assert.equal(await readMessageDialog(fakeDriver(["Note"], { throws: true })), null);
});

test("waitForMessageDialog: waits for a slow popup; gives up after the time", async () => {
  const slow = fakeDriver(["Note", PORTAL], { after: 3 });
  assert.deepEqual(await waitForMessageDialog(slow, { timeoutMs: 1000, pollMs: 1 }), { title: "Note", text: PORTAL });
  assert.equal(slow.calls(), 4);
  assert.equal(await waitForMessageDialog(fakeDriver(null), { timeoutMs: 30, pollMs: 1 }), null);
});

const section = (over = {}) => ({ ok: true, filled: ["PA Cover", "TPPD Restrict"], failures: [], screenshots: [], error: null, ...over });
const shotTaker = () => {
  const taken = [];
  const capture = async (name, stage) => {
    taken.push([name, stage]);
    return { screenshotUrl: "https://s3.test/tppd.png", screenshotKey: "tppd.png" };
  };
  return { taken, capture };
};
const dialogSays = (text) => async () => (text ? { title: "Note", text } : null);

for (const [name, form] of Object.entries(FORMS)) {
  test(`${name}: TPPD ticked and KSHEMA's TPPD popup -> stop, KSHEMA's sentence, screenshot first`, async () => {
    const { taken, capture } = shotTaker();
    const { value: r, lines } = await quiet(() =>
      form.tppdRefusal({}, { tppdRestrict: true }, section(), capture, { waitForMessageDialog: dialogSays(PORTAL) })
    );
    assert.equal(r.ok, false);
    assert.equal(r.tppdRefused, true);
    assert.equal(r.portalMessage, PORTAL);
    assert.equal(
      r.error,
      `KSHEMA does not allow Limited TPPD for this RTO ("${PORTAL}"). Edit the policy, untick TPPD Restrict and run it again.`
    );
    assert.equal(r.error.includes(":"), false, "an operator sentence has no colon");
    assert.deepEqual(taken, [["kshema_tppd_refused", "tppd_refused"]]);
    assert.equal(r.screenshots[0].screenshotUrl, "https://s3.test/tppd.png");
    assert.ok(r.failures.some((f) => f.label === "TPPD Restrict"));
    assert.ok(lines.some((l) => l.includes(`KSHEMA says "${PORTAL}"`)));
  });

  test(`${name}: "true" as text counts as ticked; a colon in KSHEMA's words is taken out`, async () => {
    const { value: r } = await quiet(() =>
      form.tppdRefusal({}, { tppdRestrict: "true" }, section(), null, { waitForMessageDialog: dialogSays("TPPD: not for this RTO.") })
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.includes(":"), false);
    assert.match(r.error, /\("TPPD - not for this RTO"\)/);
    assert.deepEqual(r.screenshots, [], "no capture given: the caller takes its own screenshot");
  });

  test(`${name}: TPPD not ticked -> the popup is not even looked for`, async () => {
    let looked = 0;
    const s = section();
    const r = await form.tppdRefusal({}, { tppdRestrict: false }, s, null, {
      waitForMessageDialog: async () => {
        looked += 1;
        return { title: "Note", text: PORTAL };
      },
    });
    assert.equal(r, s);
    assert.equal(looked, 0);
  });

  test(`${name}: TPPD ticked, no popup -> the step goes on unchanged`, async () => {
    const s = section();
    assert.equal(await form.tppdRefusal({}, { tppdRestrict: true }, s, null, { waitForMessageDialog: dialogSays(null) }), s);
  });

  test(`${name}: a popup that is not about TPPD is only logged`, async () => {
    const s = section();
    const { value: r, lines } = await quiet(() =>
      form.tppdRefusal({}, { tppdRestrict: true }, s, null, { waitForMessageDialog: dialogSays("Premium recalculated") })
    );
    assert.equal(r, s);
    assert.ok(lines.some((l) => l.includes('KSHEMA showed a popup after TPPD Restrict: "Premium recalculated"')));
  });

  test(`${name}: a section that already failed (behind the popup) reports the TPPD refusal, not its own error`, async () => {
    const failed = section({ ok: false, failures: [{ label: "PA Cover", reason: "could not be read back" }], error: "Could not fill the PA Cover details" });
    const { value: r } = await quiet(() =>
      form.tppdRefusal({}, { tppdRestrict: true }, failed, null, { waitForMessageDialog: dialogSays(PORTAL) })
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /^KSHEMA does not allow Limited TPPD for this RTO/);
  });
}
