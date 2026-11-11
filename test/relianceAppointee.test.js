// Reliance's Appointee Name (the owner, 2026-11-11): the Online Policy lets a Reliance nominee be under 18, and the
// automation types the Appointee Name ONLY then - read back, once more if it did not take; 18 or older: the box is not
// touched. A fake page; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/relianceAppointee.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { fillAppointeeIfMinor, nomineeAgeOf } = require("../fullPolicycompany/reliance/relianceAppointee");

const NOW = new Date("2026-11-11T06:30:00Z"); // 12:00 in India

function page({ exists = true, shown = true, showAfterReads = 0, ignoreTypes = 0, keepsNothing = false } = {}) {
  const state = { value: "", types: 0, reads: 0, ignoreTypes };
  return {
    state,
    async executeScript(script, ...args) {
      const s = String(script);
      if (s.includes("getComputedStyle")) {
        state.reads += 1;
        if (!exists) return { exists: false };
        return { exists: true, shown: shown && state.reads > showAfterReads, value: state.value };
      }
      if (s.includes('new Event("input"')) {
        state.types += 1;
        if (state.ignoreTypes > 0) {
          state.ignoreTypes -= 1;
          return true;
        }
        if (!keepsNothing) state.value = String(args[0]).toUpperCase(); // the portal upper-cases
        return true;
      }
      return null;
    },
    async sleep() {},
  };
}

/** A stop that ends the run the way the form's stopper does (it throws). */
const stopper = () => {
  const said = [];
  return {
    said,
    stop: (message, details) => {
      said.push({ message, details });
      const e = new Error(message);
      e.isStop = true;
      throw e;
    },
  };
};
const go = (driver, data, extra = {}) => {
  const lines = [];
  const s = stopper();
  let t = NOW.getTime();
  const run = fillAppointeeIfMinor(driver, data, { log: (l) => lines.push(String(l)), stop: s.stop, now: () => t, sleep: async (ms) => (t += ms), ...extra });
  return { lines, said: s.said, run };
};

test("the age on today's date in India: 18 on the birthday itself, 17 the day before; a future or unreadable date is unknown", () => {
  assert.equal(nomineeAgeOf("11-11-2008", NOW), 18);
  assert.equal(nomineeAgeOf("12-11-2008", NOW), 17);
  assert.equal(nomineeAgeOf("11/11/2008", NOW), 18);
  assert.equal(nomineeAgeOf("15-06-2021", NOW), 5);
  // 00:30 on 11 Nov in India is still 10 Nov in UTC: India's date counts
  assert.equal(nomineeAgeOf("11-11-2008", new Date("2026-11-10T19:00:00Z")), 18);
  assert.equal(nomineeAgeOf("01-01-2030", NOW), null);
  assert.equal(nomineeAgeOf("", NOW), null);
  assert.equal(nomineeAgeOf("31-02-2010", NOW), null);
});

test("nominee 18 or older: the Appointee box is NOT touched, even with a name on the policy", async () => {
  for (const dob of ["12-04-1980", "11-11-2008"]) {
    const driver = page();
    const { lines, run } = go(driver, { nomineeDob: dob, appointeeName: "RAVI" });
    assert.deepEqual(await run, { typed: false, age: nomineeAgeOf(dob, NOW), reason: "adult" });
    assert.equal(driver.state.types, 0);
    assert.equal(driver.state.reads, 0, "not even looked at");
    assert.ok(lines.some((l) => /Appointee Name not typed - the nominee is \d+, an appointee is needed only under 18/.test(l)));
  }
});

test("an unreadable date of birth: the box is left alone, said in the log", async () => {
  const driver = page();
  const { lines, run } = go(driver, { nomineeDob: "", appointeeName: "RAVI" });
  assert.equal((await run).reason, "dob-unreadable");
  assert.equal(driver.state.types, 0);
  assert.ok(lines.some((l) => /could not be read/.test(l)));
});

test("nominee under 18: the Appointee Name is typed and read back", async () => {
  const driver = page();
  const { lines, run } = go(driver, { nomineeDob: "15-06-2021", appointeeName: " ravi  kumar " });
  assert.deepEqual(await run, { typed: true, age: 5, reason: "minor" });
  assert.equal(driver.state.value, "RAVI KUMAR");
  assert.equal(driver.state.types, 1);
  assert.ok(lines.some((l) => l === '✓ Reliance - Appointee Name = "ravi kumar" (the nominee is 5)'));
});

test("a typing the page ignored is done once more; a box that never holds the name stops the run naming both", async () => {
  const once = page({ ignoreTypes: 1 });
  const first = go(once, { nomineeDob: "15-06-2021", appointeeName: "RAVI" });
  assert.equal((await first.run).typed, true);
  assert.equal(once.state.types, 2);
  assert.ok(first.lines.some((l) => /↻ Reliance - the Appointee Name box shows "" instead of "RAVI" - typing it once more/.test(l)));

  const never = page({ keepsNothing: true });
  const second = go(never, { nomineeDob: "15-06-2021", appointeeName: "RAVI" });
  await assert.rejects(second.run, (e) => e.isStop && /the Appointee Name box shows "" instead of "RAVI" after 2 tries, so the run stopped there/.test(e.message));
  assert.equal(never.state.types, 2);
  assert.equal(second.said[0].details.stage, "reliance-appointee");
});

test("nominee under 18 but no Appointee Name on the policy: stops BEFORE anything is typed, saying what to enter", async () => {
  const driver = page();
  const { run } = go(driver, { nomineeDob: "15-06-2021", appointeeName: "" });
  await assert.rejects(run, (e) => e.isStop && /the nominee is 5 years old \(under 18\) but the policy has no Appointee Name/.test(e.message) && !/:/.test(e.message));
  assert.equal(driver.state.types, 0);
});

test("the box: waited for while Reliance brings it up (a few seconds); not there or not visible after 8 s stops the run", async () => {
  const late = page({ showAfterReads: 5 });
  const { run } = go(late, { nomineeDob: "15-06-2021", appointeeName: "RAVI" });
  assert.equal((await run).typed, true);

  const missing = go(page({ exists: false }), { nomineeDob: "15-06-2021", appointeeName: "RAVI" });
  await assert.rejects(missing.run, (e) => /Reliance's Appointee Name box is not on the page \(after 8 seconds\)/.test(e.message));
  const hidden = go(page({ shown: false }), { nomineeDob: "15-06-2021", appointeeName: "RAVI" });
  await assert.rejects(hidden.run, (e) => /Reliance's Appointee Name box is not visible \(after 8 seconds\)/.test(e.message));
});

test("the Reliance form uses it (and its OD / TP copy, regenerated): the old blind script-set is gone", () => {
  for (const file of ["fullPolicycompany/relianceForm.js", "multiCompany/common/reliance/relianceMultiForm.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(src, /await fillAppointeeIfMinor\(driver, data, \{ stop: \(message, details\) => stopper\(message, details\) \}\);/, file);
    assert.equal(src.includes('driver.findElement(By.id("Appointee_Name"))'), false, file);
  }
});
