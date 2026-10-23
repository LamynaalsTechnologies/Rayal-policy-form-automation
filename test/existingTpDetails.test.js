// Run with: node --require ./test/support/noRealWorld.js --test test/existingTpDetails.test.js
//
// The customer's existing TP policy for the Reliance OD form (lib/existingTpDetails.js): checked exactly, BEFORE any window
// opens. lib/existingTpGate.js only asks "is it filled" (it passes "Invalid date" or a third insurer); this is the exact check.
// A data problem is a plain sentence and is not retried. Pure: no database, no browser.
const test = require("node:test");
const assert = require("node:assert/strict");

const tp = require("../lib/existingTpDetails");

const good = (over = {}) => ({
  existingTpPolicyNumber: "NIC/TP/0001",
  existingTpInsurer: "National",
  existingTpStartDate: "01-10-2026",
  existingTpEndDate: "30-09-2031",
  ...over,
});
const oneColon = (message) => message.split(":").length - 1 === 1;
const failure = (data) => {
  try {
    tp.validateExistingTpDetails(data);
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
};

test("good details: the number upper-cased, the insurer as the page names it, the dates as DD-MM-YYYY", () => {
  const r = tp.validateExistingTpDetails(good({ existingTpPolicyNumber: " nic/tp/0001 ", existingTpStartDate: "1-10-2026" }));
  assert.equal(r.policyNumber, "NIC/TP/0001");
  assert.deepEqual(r.insurer, { key: "national", label: "National", pageName: "National Insurance Company Limited" });
  assert.equal(r.startDate, "01-10-2026", "a one-digit day gets its zero");
  assert.equal(r.endDate, "30-09-2031");
});

test("the insurer: KSHEMA and National in any case or full name; anything else is not guessed", () => {
  for (const [given, key] of [["KSHEMA", "kshema"], ["kshema", "kshema"], ["Kshema General Insurance Limited", "kshema"], ["National", "national"], ["NATIONAL INSURANCE COMPANY LIMITED", "national"], ["national insurance", "national"]]) {
    assert.equal(tp.validateExistingTpDetails(good({ existingTpInsurer: given })).insurer.key, key, given);
  }
  for (const given of ["", "Reliance", "United India", "nationwide", "KSHEM"]) assert.equal(tp.insurerOf(given), null, given);
});

test("every kind of bad data is its own plain error: not retried, one colon, no driver words, says what to do", () => {
  const cases = [
    [good({ existingTpPolicyNumber: "" }), "number", /the customer's existing TP policy number is missing/],
    [good({ existingTpPolicyNumber: "A" }), "number", /number "A" is not a policy number \(3 to 40 letters, digits and \/ - \.\)/],
    [good({ existingTpPolicyNumber: "NIC#TP" }), "number", /is not a policy number/],
    [good({ existingTpInsurer: "" }), "insurer", /the existing TP insurer is missing/],
    [good({ existingTpInsurer: "United India" }), "insurer", /the existing TP insurer "United India" is not KSHEMA or National/],
    [good({ existingTpStartDate: "Invalid date" }), "start", /the existing TP policy start date "Invalid date" is not a date \(DD-MM-YYYY\)/],
    [good({ existingTpStartDate: "" }), "start", /start date is missing/],
    [good({ existingTpEndDate: "31-02-2031" }), "end", /end date "31-02-2031" is not a date/],
    [good({ existingTpEndDate: "2031-09-30" }), "end", /is not a date/],
    [good({ existingTpEndDate: "01-10-2026" }), "order", /end date 01-10-2026 is not after its start date 01-10-2026/],
    [good({ existingTpEndDate: "30-09-2026" }), "order", /is not after its start date/],
  ];
  for (const [data, reason, pattern] of cases) {
    const e = failure(data);
    assert.ok(e instanceof tp.ExistingTpError);
    assert.equal(e.reason, reason);
    assert.equal(e.nonRetryable, true, "a re-run cannot mend it");
    assert.match(e.message, pattern);
    assert.match(e.message, /^Reliance OD: /);
    assert.match(e.message, /so the run stopped before opening the portal\. Enter it in Edit then TP policy details, then run the policy again\.$/);
    assert.ok(oneColon(e.message), e.message);
  }
});

test("a colon inside the operator's own text does not break the one-colon rule", () => {
  const e = failure(good({ existingTpInsurer: "Bad: Insurer" }));
  assert.ok(oneColon(e.message));
  assert.match(e.message, /"Bad - Insurer"/);
});

test("dates must be real days: 29 February only in a leap year, and 31 April never", () => {
  assert.ok(tp.parseDay("29-02-2028"));
  assert.equal(tp.parseDay("29-02-2027"), null);
  assert.equal(tp.parseDay("31-04-2026"), null);
  assert.equal(tp.parseDay("1/10/2026").text, "01-10-2026");
});

test("requireExistingTpDetails: logs what it will type and returns the details", () => {
  const lines = [];
  const r = tp.requireExistingTpDetails(good(), { jobId: "Asha_1", log: (l) => lines.push(l) });
  assert.equal(r.insurer.key, "national");
  assert.match(lines.join("\n"), /\[Asha_1\] 📋 Existing TP policy NIC\/TP\/0001 at National Insurance Company Limited, 01-10-2026 to 30-09-2031\./);
});

test("the form turns the error into retryable:false exactly like a Title / fuel type error", () => {
  const src = require("node:fs").readFileSync(require.resolve("../fullPolicycompany/relianceForm.js"), "utf8");
  assert.match(src, /\.\.\.\(e && e\.nonRetryable === true \? \{ retryable: false \} : \{\}\)/);
});
