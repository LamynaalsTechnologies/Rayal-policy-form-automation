// United India after the Pin Code (the owner, 2026-11-13): Mobile, Email (validateEmail on leaving), Date of Birth
// (DD/MM/YYYY, never clicked - its click opens the calendar), then the RTO by its code (TN55 / TN-55 / TN 55). Fake pages
// shaped like the owner's markup; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaContactRto.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const contact = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaContact");
const rto = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaRto");
const dates = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaDates");
const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");
const { readSelectInPage, setSelectByScriptInPage } = require("../lib/realSelect");

const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));
// The owner's RTO list for Pondicherry, plus Tamil Nadu ones for the other cases.
const PY_LIST = [["", "Select"], ["", ""], ["PY@261066", "PY"], ["PY01 PONDICHERRY@2897", "PY01 PONDICHERRY"], ["PY02 KARAIKAL@2898", "PY02 KARAIKAL"], ["PY03 MAHE@2899", "PY03 MAHE"], ["PY04 YANAM@2900", "PY04 YANAM"], ["PY05 PUDUCHERRY@17294", "PY05 PUDUCHERRY"]];
const TN_LIST = [["", "Select"], ["TN01 CHENNAI@1", "TN01 CHENNAI CENTRAL"], ["TN05 CHENNAI NORTH@5", "TN05 CHENNAI NORTH"], ["TN55 SALEM@55", "TN55 SALEM"], ["TN56 PERUNDURAI@56", "TN-56 PERUNDURAI"], ["TN57 DINDIGUL@57", "TN 57 DINDIGUL"], ["TN59 MADURAI@59", "TN59 MADURAI"]];

/**
 * @param {Object} over
 *   rtos: the RTO list (default TN_LIST); hide: ["mobile" | "email" | "dob" | "rto"]
 *   emailAlert / dobAlert / rtoAlert: the box's onblur / onchange answers with a popup
 *   dobDropped: how many times the page empties the date of birth
 *   dobChangesEmail: the date's check empties the email
 */
function page(over = {}) {
  const state = {
    values: { mobile: "", emailAddress: "", dateOfBirthString: "" },
    typed: { mobile: 0, emailAddress: 0, dateOfBirthString: 0 },
    clicks: { dateOfBirthString: 0 },
    clears: 0,
    leaves: 0,
    dobSets: 0,
    rto: { options: opts(over.rtos || TN_LIST), selectedIndex: 0, changes: 0 },
    alerts: [],
    dobDropped: over.dobDropped || 0,
  };
  const hidden = (k) => (over.hide || []).includes(k);
  const alertError = (text) => Object.assign(new Error(`unexpected alert open: {Alert text : ${text}}`), { name: "UnexpectedAlertOpenError" });
  const input = (id, key) => ({
    id,
    async isDisplayed() {
      return !hidden(key);
    },
    async click() {
      state.clicks[id] = (state.clicks[id] || 0) + 1; // the date of birth's click opens the calendar
    },
    async clear() {
      state.clears += 1;
      state.values[id] = "";
    },
    async sendKeys(v) {
      state.typed[id] += 1;
      state.values[id] += v;
    },
    async getAttribute(a) {
      return a === "value" ? state.values[id] : null;
    },
  });
  const els = { mobile: input("mobile", "mobile"), emailAddress: input("emailAddress", "email"), dateOfBirthString: input("dateOfBirthString", "dob") };
  const rtoBox = {
    async isDisplayed() {
      return !hidden("rto");
    },
    async click() {},
    async findElements() {
      return state.rto.options.map((_, i) => ({
        async click() {
          state.rto.selectedIndex = i;
          state.rto.changes += 1;
          if (over.rtoAlert) throw alertError(over.rtoAlert);
        },
      }));
    },
  };
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      if (/rtaDesc/.test(v)) return hidden("rto") ? [] : [rtoBox];
      if (/dateOfBirthString/.test(v)) return [els.dateOfBirthString];
      if (/emailAddress/.test(v)) return [els.emailAddress];
      if (/mobile/.test(v)) return [els.mobile];
      return [];
    },
    async executeScript(script, ...args) {
      if (script === dates.setDateInPage) {
        state.dobSets += 1;
        if (over.dobAlert) throw alertError(over.dobAlert); // its onblur checkDateValidation() answered
        state.values.dateOfBirthString = state.dobDropped > 0 ? ((state.dobDropped -= 1), "") : args[1];
        if (over.dobChangesEmail) state.values.emailAddress = "";
        return { value: state.values.dateOfBirthString, check: "missing" };
      }
      if (script === steps.leaveBoxInPage) {
        state.leaves += 1;
        if (over.emailAlert) throw alertError(over.emailAlert);
        return true;
      }
      if (script === contact.readContactInPage) {
        return { mobile: state.values.mobile, email: state.values.emailAddress, dob: state.values.dateOfBirthString };
      }
      if (script === readSelectInPage) {
        if (hidden("rto")) return null;
        const b = state.rto;
        return { selectedIndex: b.selectedIndex, value: b.options[b.selectedIndex].value, options: b.options };
      }
      if (script === setSelectByScriptInPage) {
        state.rto.selectedIndex = state.rto.options.findIndex((o) => o.value === args[1]);
        state.rto.changes += 1;
        return true;
      }
      const s = String(script);
      if (s === steps.CLEAR_QUIETLY_SCRIPT) {
        state.values[args[0].id] = "";
        return null;
      }
      if (s.includes("HTMLInputElement.prototype")) {
        state.values[args[0].id] = String(args[1]);
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      if (s.includes("sr-only")) return false;
      return null;
    },
    switchTo() {
      return {
        alert: async () => {
          if (!state.alerts.length) throw new Error("no such alert");
          const text = state.alerts.shift();
          return { getText: async () => text, accept: async () => {} };
        },
      };
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = Date.parse("2026-11-13T06:00:00Z");
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const CUSTOMER = { mobile: "9876543210", email: " Lakshmi.Devi@Example.COM ", dob: "15-08-1990" };
const fill = (driver, data = CUSTOMER) => {
  const lines = [];
  return { lines, go: () => contact.fillContactDetails(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};
const pick = (driver, data) => {
  const lines = [];
  return { lines, go: () => rto.chooseRto(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};

/* ------------------------------------------------ the policy's values ------------------------------------------------ */

test("Mobile: 10 digits; a +91 / 91 / 0 in front and spaces are dropped; anything else is no mobile", () => {
  assert.equal(contact.mobileOf({ mobile: "9876543210" }), "9876543210");
  assert.equal(contact.mobileOf({ mobile: "+91 98765 43210" }), "9876543210");
  assert.equal(contact.mobileOf({ mobile: "09876543210" }), "9876543210");
  assert.equal(contact.mobileOf({ mobileNumber: "9876543210" }), "9876543210");
  for (const bad of ["12345", "98765432101", "", null]) assert.equal(contact.mobileOf({ mobile: bad }), "", String(bad));
});

test("Email: trimmed, lower case; not an email = none", () => {
  assert.equal(contact.emailOf({ email: " Lakshmi.Devi@Example.COM " }), "lakshmi.devi@example.com");
  assert.equal(contact.emailOf({ email: "no-at-sign.com" }), "");
});

test("Date of Birth: the job's DD-MM-YYYY (or ISO) as DD/MM/YYYY; no such day or a future one = none", () => {
  const now = () => Date.parse("2026-11-13T06:00:00Z");
  assert.equal(contact.dobOf({ dob: "15-08-1990" }, now), "15/08/1990");
  assert.equal(contact.dobOf({ dob: "5-8-1990" }, now), "05/08/1990");
  assert.equal(contact.dobOf({ dob: "1990-08-15" }, now), "15/08/1990");
  assert.equal(contact.dobOf({ dob: "31-02-1990" }, now), "", "31 February is no day");
  assert.equal(contact.dobOf({ dob: "01-01-2030" }, now), "", "a birthday in the future");
  assert.equal(contact.dobOf({ dob: "Invalid date" }, now), "");
});

/* ------------------------------------------------ Mobile, Email, Date of Birth ------------------------------------------------ */

test("Mobile, Email and Date of Birth: typed / put in, the Email box left once (validateEmail), the birth date never clicked", async () => {
  const driver = page();
  const { lines, go } = fill(driver);
  assert.deepEqual(await go(), { mobile: "9876543210", email: "lakshmi.devi@example.com", dob: "15/08/1990" });
  assert.equal(driver.state.values.mobile, "9876543210");
  assert.equal(driver.state.values.emailAddress, "lakshmi.devi@example.com");
  assert.equal(driver.state.values.dateOfBirthString, "15/08/1990");
  assert.equal(driver.state.leaves, 1, "the Email box was left once - its onblur validateEmail() runs");
  assert.equal(driver.state.clicks.dateOfBirthString, 0, "never clicked - the click opens the calendar");
  assert.equal(driver.state.typed.dateOfBirthString, 0, "put in by script, not typed");
  assert.ok(driver.state.clears <= 1, "only the Mobile may be emptied with Selenium's clear() (it has no onblur)");
  assert.ok(lines.some((l) => /✓ United India - Date of Birth = "15\/08\/1990" \(the policy's date of birth\)/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - Mobile, Email and Date of Birth entered/.test(l)));
});

test("the policy's values are checked BEFORE the page: one sentence naming each problem, nothing typed, not retried", async () => {
  const driver = page();
  await assert.rejects(fill(driver, { mobile: "12345", email: "nope", dob: "31-02-1990" }).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the policy has no 10-digit Mobile Number \("12345"\), and no usable Email \("nope"\), and no usable Date of Birth \("31-02-1990"\)/);
    return true;
  });
  assert.equal(driver.state.typed.mobile, 0);
});

test("validateEmail answers with a popup: [E308] in the portal's words, the Date of Birth not touched", async () => {
  const driver = page({ emailAlert: "Please enter a valid email address" });
  await assert.rejects(fill(driver).go(), (e) => e.code === "E308" && e.retryable === false && /after "Email" the portal said "Please enter a valid email address"/.test(e.message));
  assert.equal(driver.state.dobSets, 0);
});

test("checkDateValidation answers with a popup: [E308] in its words", async () => {
  const driver = page({ dobAlert: "Age should be above 18 years" });
  await assert.rejects(fill(driver).go(), (e) => e.code === "E308" && /after "Date of Birth" the portal said "Age should be above 18 years"/.test(e.message));
});

test("a date of birth the page empties: put in ONE more time, then [E306]", async () => {
  const driver = page({ dobDropped: 5 });
  await assert.rejects(fill(driver).go(), (e) => e.code === "E306" && /Date of Birth holds "" instead of "15\/08\/1990" after 2 tries/.test(e.message));
  assert.equal(driver.state.dobSets, 2);
});

test("a box the next one emptied is caught by the last read-back: [E306]", async () => {
  const driver = page({ dobChangesEmail: true });
  await assert.rejects(fill(driver).go(), (e) => e.code === "E306" && /Email reads "" instead of "lakshmi\.devi@example\.com"/.test(e.message));
});

test("no Mobile box: [E301] naming it", async () => {
  const driver = page({ hide: ["mobile"] });
  await assert.rejects(fill(driver).go(), (e) => e.code === "E301" && /"Mobile" is not on the page/.test(e.message));
});

/* ------------------------------------------------ the RTO ------------------------------------------------ */

test("RTO codes are read by their parts: TN-55 = TN 55 = TN55 = TN055, TN5 = TN05, DL1C keeps its letter", () => {
  for (const t of ["TN-55", "tn 55", "TN55", "TN055", "TN55 SALEM", "TN-55 SALEM", "TN 55 SALEM"]) assert.equal(rto.rtoParts(t).code, "TN55", t);
  assert.equal(rto.rtoParts("TN5").code, "TN05");
  assert.equal(rto.rtoParts("DL-1C").code, "DL01C");
  for (const t of ["PY", "", "SALEM", "123"]) assert.equal(rto.rtoParts(t), null, t);
});

for (const given of ["TN-55", "TN55", "tn 55"]) {
  test(`the policy's RTO "${given}" -> "TN55 SALEM" chosen by its exact option`, async () => {
    const driver = page();
    const { lines, go } = pick(driver, { rtoCityLocation: given });
    assert.deepEqual(await go(), { rto: "TN55 SALEM", value: "TN55 SALEM@55" });
    assert.equal(driver.state.rto.options[driver.state.rto.selectedIndex].value, "TN55 SALEM@55");
    assert.ok(lines.some((l) => /✅ United India - RTO "TN55 SALEM" chosen/.test(l)));
  });
}

test("an option written 'TN-56 PERUNDURAI' or 'TN 57 DINDIGUL' is found too; TN5 finds TN05", async () => {
  let driver = page();
  assert.equal((await pick(driver, { rtoCityLocation: "TN56" }).go()).rto, "TN-56 PERUNDURAI");
  driver = page();
  assert.equal((await pick(driver, { rtoCityLocation: "TN-57" }).go()).rto, "TN 57 DINDIGUL");
  driver = page();
  assert.equal((await pick(driver, { rtoCityLocation: "TN5" }).go()).rto, "TN05 CHENNAI NORTH");
});

test("the owner's Pondicherry list: PY01 chosen, the bare 'PY' never", async () => {
  const driver = page({ rtos: PY_LIST });
  assert.equal((await pick(driver, { rtoCityLocation: "PY-01" }).go()).value, "PY01 PONDICHERRY@2897");
});

test("an RTO not in the list: stops, NOT retried, naming the nearest RTOs of that state", async () => {
  const driver = page();
  await assert.rejects(pick(driver, { rtoCityLocation: "TN-58" }).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /the RTO TN58 \(the policy's RTO "TN-58"\) is not in United India's RTO list, so the run stopped there\./);
    assert.match(e.message, /The nearest TN RTOs United India offers are "TN 57 DINDIGUL", "TN59 MADURAI", "TN-56 PERUNDURAI", "TN55 SALEM"/);
    return true;
  });
  assert.equal(driver.state.rto.changes, 0, "nothing chosen");
});

test("a list of another state (the customer's state is not the RTO's): says so and what it lists", async () => {
  const driver = page({ rtos: PY_LIST });
  await assert.rejects(pick(driver, { rtoCityLocation: "TN55" }).go(), (e) => {
    assert.equal(e.retryable, false);
    assert.match(e.message, /United India's list has no TN RTO at all - it lists the RTOs of the Vehicle Registration State \(the customer's state on the policy\), e\.g\. "PY01 PONDICHERRY"/);
    return true;
  });
});

test("letters stuck to the number count: DL1 is DL01, not DL01C (and the other way round)", async () => {
  const delhi = [["", "Select"], ["DL1C@1", "DL1C NEW DELHI CIVIL LINES"], ["DL1@2", "DL01 NEW DELHI"], ["DL2@3", "DL02 CENTRAL"]];
  let driver = page({ rtos: delhi });
  assert.equal((await pick(driver, { rtoCityLocation: "DL-1" }).go()).value, "DL1@2");
  driver = page({ rtos: delhi });
  assert.equal((await pick(driver, { rtoCityLocation: "DL1C" }).go()).value, "DL1C@1");
});

test("two options with the same code: stops and lists them - never a guess", async () => {
  const driver = page({ rtos: [...TN_LIST, ["TN55 SALEM WEST@155", "TN55 SALEM WEST"]] });
  await assert.rejects(pick(driver, { rtoCityLocation: "TN55" }).go(), (e) => e.retryable === false && /more than one TN55 - "TN55 SALEM", "TN55 SALEM WEST"/.test(e.message));
  assert.equal(driver.state.rto.changes, 0);
});

test("no RTO code on the policy: stops before the page", async () => {
  const driver = page();
  await assert.rejects(pick(driver, {}).go(), (e) => e.retryable === false && /the policy has no RTO City\/Location/.test(e.message));
  await assert.rejects(pick(driver, { rtoCityLocation: "SALEM" }).go(), (e) => /RTO City\/Location "SALEM" is not an RTO code like TN55/.test(e.message));
});

test("the RTO's onchange answers with a popup: [E308] in its words", async () => {
  const driver = page({ rtoAlert: "Invoice zone not found for the RTO" });
  await assert.rejects(pick(driver, { rtoCityLocation: "TN55" }).go(), (e) => e.code === "E308" && /after "RTO" the portal said "Invoice zone not found for the RTO"/.test(e.message));
});

test("no RTO box / an empty list: [E301], tried again later", async () => {
  await assert.rejects(pick(page({ hide: ["rto"] }), { rtoCityLocation: "TN55" }).go(), (e) => e.code === "E301" && /the "RTO" box is not on the Risk Details page/.test(e.message));
  await assert.rejects(pick(page({ rtos: [["", "Select"], ["PY@1", "PY"]] }), { rtoCityLocation: "TN55" }).go(), (e) => e.code === "E301" && e.retryable !== false && /the RTO list stayed empty/.test(e.message));
});

test("the owner's markup is what it looks for", () => {
  assert.equal(contact.MOBILE.target[0], "#mobile");
  assert.equal(contact.EMAIL.target[0], "#emailAddress");
  assert.equal(contact.DOB.target[0], "#dateOfBirthString");
  assert.equal(rto.RTO_ID, "rtaDesc");
});
