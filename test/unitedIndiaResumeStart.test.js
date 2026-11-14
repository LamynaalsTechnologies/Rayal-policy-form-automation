// United India, a proposal opened again (the owner, 2026-11-13): the Policy Start Date put to TODAY before High Risk - the
// proposal's old day is refused ("N002219, PolicyInception Date should be on or later to Proposal Date") - with the
// calendar's own check polStartDateValidation('fuel'); United India's "Error In Data Entry" box stops the run in its words.
// A fake page; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaResumeStart.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const dates = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaDates");
const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");

const N002219 = "N002219, PolicyInception Date should be on or later to Proposal Date .";

/**
 *   refuses: the page's check puts the old day back (silently)
 *   errors:  the "Error In Data Entry" lines the page shows after the date
 */
function page(over = {}) {
  const st = { value: "13/11/2026", sets: [], errorsAsked: 0 };
  const box = {
    async isDisplayed() {
      return true;
    },
    async getAttribute(name) {
      return name === "value" ? st.value : null;
    },
  };
  return {
    st,
    async findElements(locator) {
      return /dateOfIssueOfPolicyString/.test(String((locator && locator.value) || "")) ? [box] : [];
    },
    async executeScript(script, ...args) {
      if (script === dates.setDateInPage) {
        st.sets.push({ value: args[1], check: args[2], arg: args[3] });
        st.value = over.refuses ? "13/11/2026" : args[1];
        return { value: st.value, check: args[2] === "polStartDateValidation" ? "ran" : "missing" };
      }
      if (script === nav.portalErrorsInPage) {
        st.errorsAsked += 1;
        return over.errors || [];
      }
      if (typeof script === "string" && script.includes("dateOfIssueOfPolicyString")) return "13/11/2026";
      if (typeof args[0] === "string" && args[0].includes("blockUI")) return false;
      if (String(script).trim() === "return document.readyState") return "complete";
      return null;
    },
    switchTo() {
      return {
        alert: async () => {
          throw new Error("no such alert");
        },
      };
    },
    async sleep() {},
  };
}

const at = (iso) => {
  let t = Date.parse(iso);
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const run = (driver, iso = "2026-11-13T19:00:00Z") => {
  const lines = [];
  return { lines, go: () => dates.setPolicyStartToday(driver, { ...at(iso), log: (l) => lines.push(String(l)) }) };
};

test("the Policy Start Date (13/11) is put to TODAY in India (14/11 at 00:30 IST), with the calendar's own check polStartDateValidation('fuel')", async () => {
  const driver = page();
  const { lines, go } = run(driver);
  const out = await go();
  assert.deepEqual(out, { policyStart: "14/11/2026" });
  assert.deepEqual(driver.st.sets, [{ value: "14/11/2026", check: "polStartDateValidation", arg: "fuel" }]);
  assert.equal(driver.st.value, "14/11/2026");
  assert.ok(lines.some((l) => /📅 United India - Policy Start Date "13\/11\/2026" -> 14\/11\/2026 \(today, India time - the proposal's old day is refused\)/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - Policy Start Date = "14\/11\/2026" \(today, India time; the page's own date check \(polStartDateValidation\) ran\)/.test(l)));
  assert.ok(driver.st.errorsAsked >= 1, "the Error In Data Entry box looked for after it");
});

test("the page puts the old day back: tried once more, then [E306] saying what it holds", async () => {
  const driver = page({ refuses: true });
  await assert.rejects(run(driver).go(), (e) => e.code === "E306" && /Policy Start Date holds "13\/11\/2026" instead of "14\/11\/2026" after 2 tries/.test(e.message));
  assert.equal(driver.st.sets.length, 2);
});

test("United India's Error In Data Entry box after the date: [E306] in its words, not retried", async () => {
  const driver = page({ errors: [N002219] });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.equal(
      e.message,
      `[E306] United India - after "Policy Start Date" the portal says "Error In Data Entry - ${N002219}", so the run stopped there. Correct the policy (or tell support what the portal wants), then run it again.`
    );
    return true;
  });
});

test("the owner's box and its check", () => {
  assert.equal(dates.POLICY_START[0], "#dateOfIssueOfPolicyString");
  assert.deepEqual(dates.POLICY_START_CHECK, { name: "polStartDateValidation", arg: "fuel" });
});
