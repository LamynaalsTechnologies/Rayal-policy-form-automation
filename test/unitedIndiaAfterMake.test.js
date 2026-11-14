// United India Risk Details after the Make (the owner, 2026-11-13): Date of Purchase = today (a READONLY calendar box),
// Month and Year of Manufacture = this month / year, then Valid PUC = Yes and Delhi - NCR = No (both id="repository").
// A fake page shaped like the owner's markup and a fake clock; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaAfterMake.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const dates = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaDates");
const questions = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaQuestions");
const { readSelectElementInPage, setSelectElementInPage } = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");

const MONTHS = [
  ["01", "January"], ["02", "February"], ["03", "March"], ["04", "April"], ["05", "May"], ["06", "June"], ["07", "July"],
  ["08", "August"], ["09", "September"], ["10", "October"], ["11", "November"], ["12", "December"],
];
const YES_NO = (placeholder) => [["S", placeholder], ["Yes", "Yes"], ["No", "No"]];
const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));

/**
 * @param {Object} over
 *   check: "ran" | "missing" | "throws" | "alert" | "lateAlert" | "clears"  - what registrationDateValidation does
 *   year: what the portal shows in Year of Manufacture (default "2026")
 *   hide: ["date" | "month" | "year" | "puc" | "ncr"]
 *   ignorePick: { month: 1 } - the first option click is swallowed
 *   resetMonthOnYear: typing the year puts the month back to January
 *   pucChangesNcr: answering PUC sets Delhi - NCR back to "select"
 */
function page(over = {}) {
  const state = {
    date: "",
    setCalls: 0,
    checkRuns: 0,
    calendarOpened: 0,
    dateTyped: 0,
    yearTyped: 0,
    alerts: [],
    month: { options: opts(MONTHS), selectedIndex: 0 },
    puc: { options: opts(YES_NO("Select")), selectedIndex: over.pucAnswered ? 1 : 0 },
    ncr: { options: opts(YES_NO("select")), selectedIndex: 0 },
    year: over.year === undefined ? "2026" : over.year,
    ignorePick: { ...(over.ignorePick || {}) },
  };
  const hidden = (k) => (over.hide || []).includes(k);
  const picked = (key) => {
    if (key === "puc" && over.pucChangesNcr) state.ncr.selectedIndex = 0;
  };
  const dateEl = {
    kind: "date",
    async isDisplayed() {
      return !hidden("date");
    },
    async click() {
      state.calendarOpened += 1; // the portal's calendar would open
    },
    async clear() {
      throw new Error("invalid element state: Element must be user-editable in order to clear it.");
    },
    async sendKeys() {
      state.dateTyped += 1; // readonly: nothing lands
    },
    async getAttribute(a) {
      return a === "value" ? state.date : null;
    },
  };
  const selectEl = (kind) => ({
    kind,
    async isDisplayed() {
      return !hidden(kind);
    },
    async click() {},
    async findElements() {
      return state[kind].options.map((_, i) => ({
        async click() {
          if (state.ignorePick[kind] > 0) {
            state.ignorePick[kind] -= 1;
            return;
          }
          state[kind].selectedIndex = i;
          picked(kind);
        },
      }));
    },
  });
  const yearEl = {
    kind: "year",
    async isDisplayed() {
      return !hidden("year");
    },
    async clear() {
      state.year = "";
    },
    async sendKeys(v) {
      state.year += v;
      state.yearTyped += 1;
      if (over.resetMonthOnYear) state.month.selectedIndex = 0;
    },
    async getAttribute(a) {
      return a === "value" ? state.year : null;
    },
  };
  const els = { date: dateEl, month: selectEl("month"), year: yearEl, puc: selectEl("puc"), ncr: selectEl("ncr") };
  const unexpectedAlert = (text) => Object.assign(new Error(`unexpected alert open: {Alert text : ${text}}`), { name: "UnexpectedAlertOpenError" });
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      const pick = (k) => (els[k] ? [els[k]] : []);
      if (/dtPurchaseStr|dateOfPurchaseString/.test(v)) return pick("date");
      if (/makeMonthgc/.test(v)) return pick("month");
      if (/yearOfManufacturing/.test(v)) return pick("year");
      if (/ynPuc/.test(v)) return pick("puc");
      if (/ynDncr/.test(v)) return pick("ncr");
      // the owner's markup: BOTH questions have id="repository" - an id lookup only ever finds the first (PUC)
      if (/repository/.test(v)) return pick("puc");
      return [];
    },
    async executeScript(script, ...args) {
      if (script === dates.setDateInPage) {
        state.setCalls += 1;
        state.date = args[1];
        // the page's check is run only when the code names the one the box's onclick names
        if (args[2] !== "registrationDateValidation") return { value: state.date, check: "missing" };
        let check = "missing";
        if (over.check === undefined || over.check === "ran" || over.check === "clears" || over.check === "lateAlert") {
          state.checkRuns += 1;
          check = "ran";
          if (over.check === "clears") state.date = ""; // the page's check refused the date silently
          if (over.check === "lateAlert") state.alerts.push("Date of Purchase should not be a future date");
        } else if (over.check === "throws") {
          check = "failed: registrationDateValidation is not defined fully";
        } else if (over.check === "alert") {
          throw unexpectedAlert("Date of Purchase should not be less than Date of Registration");
        }
        return { value: state.date, check };
      }
      if (script === readSelectElementInPage) {
        const s = state[args[0].kind];
        return { selectedIndex: s.selectedIndex, value: s.options[s.selectedIndex].value, options: s.options };
      }
      if (script === setSelectElementInPage) {
        const s = state[args[0].kind];
        s.selectedIndex = s.options.findIndex((o) => o.value === args[1]);
        picked(args[0].kind);
        return true;
      }
      if (script === dates.readDatesInPage) {
        return { date: state.date, month: state.month.options[state.month.selectedIndex].value, year: state.year };
      }
      const s = String(script);
      if (s.includes("HTMLInputElement.prototype")) {
        if (args[0].kind === "year") state.year = String(args[1]);
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

/** A clock that starts at `iso` and moves on when the code sleeps. */
const clockAt = (iso) => {
  let t = Date.parse(iso);
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const run = (driver, iso = "2026-11-13T06:00:00Z") => {
  const lines = [];
  return { lines, go: () => dates.fillPurchaseAndManufacture(driver, { ...clockAt(iso), log: (l) => lines.push(String(l)) }) };
};

/* ------------------------------------------------ today in India ------------------------------------------------ */

test("today is India's date: 00:30 IST on 13 Nov is still 12 Nov in UTC", () => {
  const t = dates.todayInIndia(() => Date.parse("2026-11-12T19:00:00Z"));
  assert.deepEqual(t, { date: "13/11/2026", month: "11", monthName: "November", year: "2026" });
  // 23:59 IST on 12 Nov
  assert.equal(dates.todayInIndia(() => Date.parse("2026-11-12T18:29:00Z")).date, "12/11/2026");
  // New Year in India while it is still 31 Dec in UTC
  assert.deepEqual(dates.todayInIndia(() => Date.parse("2026-12-31T19:00:00Z")), { date: "01/01/2027", month: "01", monthName: "January", year: "2027" });
});

/* ------------------------------------------------ the dates ------------------------------------------------ */

test("Date of Purchase = today (DD/MM/YYYY), put in WITHOUT typing or opening the calendar; the page's own check runs once", async () => {
  const driver = page();
  const { lines, go } = run(driver, "2026-11-12T19:00:00Z");
  const out = await go();
  assert.deepEqual(out, { dateOfPurchase: "13/11/2026", month: "11", year: "2026" });
  assert.equal(driver.state.date, "13/11/2026");
  assert.equal(driver.state.setCalls, 1);
  assert.equal(driver.state.checkRuns, 1, "registrationDateValidation, as a calendar pick runs it");
  assert.equal(driver.state.calendarOpened, 0, "the box is never clicked - its click opens the calendar");
  assert.equal(driver.state.dateTyped, 0, "a readonly box is never typed into");
  assert.ok(lines.some((l) => /✓ United India - Date of Purchase = "13\/11\/2026" \(today, India time; the page's own date check \(registrationDateValidation\) ran\)/.test(l)));
});

test("Month of Manufacture = this month by its value (11 = November) in the box that has NO id", async () => {
  const driver = page();
  const { lines, go } = run(driver);
  await go();
  const m = driver.state.month;
  assert.equal(m.options[m.selectedIndex].value, "11");
  assert.ok(lines.some((l) => /✓ United India - Month of Manufacture = "November"/.test(l)));
});

test("Year of Manufacture already this year (the portal shows 2026): left as it is, not typed", async () => {
  const driver = page();
  const { lines, go } = run(driver);
  await go();
  assert.equal(driver.state.yearTyped, 0);
  assert.ok(lines.some((l) => /Year of Manufacture already holds "2026" \(as the portal filled it, not typed again\)/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - Date of Purchase 13\/11\/2026, Month of Manufacture November and Year of Manufacture 2026 entered/.test(l)));
});

test("New Year's Day in India: 01/01/2027, January, and the year typed (the page still showed 2026)", async () => {
  const driver = page();
  await run(driver, "2026-12-31T19:00:00Z").go();
  assert.equal(driver.state.date, "01/01/2027");
  assert.equal(driver.state.month.options[driver.state.month.selectedIndex].value, "01");
  assert.equal(driver.state.year, "2027");
  assert.ok(driver.state.yearTyped >= 1);
});

test("a page without registrationDateValidation: the date is still put in, and the log says so", async () => {
  const driver = page({ check: "missing" });
  const { lines, go } = run(driver);
  await go();
  assert.equal(driver.state.date, "13/11/2026");
  assert.ok(lines.some((l) => /the page has no registrationDateValidation, only the date was put in/.test(l)));
});

test("the page's check throwing a script error does not stop the run - the log names it", async () => {
  const driver = page({ check: "throws" });
  const { lines, go } = run(driver);
  await go();
  assert.ok(lines.some((l) => /the page's own date check \(registrationDateValidation\) failed/.test(l)));
});

test("the page's check answers with a popup: [E308] in the portal's words, not retried, nothing after it touched", async () => {
  const driver = page({ check: "alert" });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E308");
    assert.equal(e.retryable, false);
    assert.match(e.message, /after "Date of Purchase" the portal said "Date of Purchase should not be less than Date of Registration"/);
    return true;
  });
  assert.equal(driver.state.setCalls, 1, "not put in a second time");
  assert.equal(driver.state.month.selectedIndex, 0, "the month was not touched");
});

test("a popup the check opens AFTER it returned is caught too: [E308]", async () => {
  const driver = page({ check: "lateAlert" });
  await assert.rejects(run(driver).go(), (e) => e.code === "E308" && /should not be a future date/.test(e.message));
});

test("a date the page empties: put in ONE more time, then [E306] naming both values", async () => {
  const driver = page({ check: "clears" });
  const { lines, go } = run(driver);
  await assert.rejects(go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.message, '[E306] United India - Date of Purchase holds "" instead of "13/11/2026" after 2 tries, so the run stopped there. It will try again shortly.');
    return true;
  });
  assert.equal(driver.state.setCalls, 2);
  assert.ok(lines.some((l) => /↻ United India - Date of Purchase reads "" instead of "13\/11\/2026" - putting it in once more/.test(l)));
});

test("no Date of Purchase box: [E301] naming it", async () => {
  const driver = page({ hide: ["date"] });
  await assert.rejects(run(driver).go(), (e) => e.code === "E301" && /"Date of Purchase" is not on the page \(not visible after 10 seconds\)/.test(e.message));
});

test("no month box: [E301] naming it, after the date", async () => {
  const driver = page({ hide: ["month"] });
  await assert.rejects(run(driver).go(), (e) => e.code === "E301" && /"Month of Manufacture" is not on the page/.test(e.message));
  assert.equal(driver.state.date, "13/11/2026");
});

test("a month pick the page ignored is chosen once more", async () => {
  const driver = page({ ignorePick: { month: 1 } });
  const { lines, go } = run(driver);
  await go();
  assert.equal(driver.state.month.options[driver.state.month.selectedIndex].value, "11");
  assert.ok(lines.some((l) => /↻ United India - Month of Manufacture shows "January" instead of "November" - choosing it once more/.test(l)));
});

test("a month the year's entry put back: caught by the last read-back, [E306] naming it", async () => {
  const driver = page({ year: "2025", resetMonthOnYear: true });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.match(e.message, /after the dates were entered the Month of Manufacture reads "01" instead of "11"/);
    return true;
  });
});

test("the owner's markup is what it looks for", () => {
  assert.deepEqual(dates.DATE_OF_PURCHASE, ["#dtPurchaseStr", "input[name='dateOfPurchaseString']"]);
  assert.equal(dates.MAKE_MONTH[0], "select[name='makeMonthgc']");
  assert.equal(dates.MAKE_YEAR[0], "#yearOfManufacturing");
  assert.equal(dates.PURCHASE_CHECK, "registrationDateValidation");
});

/* ------------------------------------------------ PUC and Delhi - NCR ------------------------------------------------ */

const ask = (driver) => {
  const lines = [];
  return { lines, go: () => questions.answerPucAndDelhiNcr(driver, { ...clockAt("2026-11-13T06:00:00Z"), log: (l) => lines.push(String(l)) }) };
};
const shows = (driver, k) => driver.state[k].options[driver.state[k].selectedIndex].value;

test("Valid PUC = Yes and Delhi - NCR = No, each box found by its NAME (both have id=repository)", async () => {
  const driver = page();
  const { lines, go } = ask(driver);
  assert.deepEqual(await go(), { puc: "Yes", delhiNcr: "No" });
  assert.equal(shows(driver, "puc"), "Yes", "an id lookup would have made the PUC box No");
  assert.equal(shows(driver, "ncr"), "No", "an id lookup would have left Delhi - NCR on select");
  assert.ok(lines.some((l) => /✓ United India - Whether Valid PUC is available for the Vehicle = "Yes"/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - Whether Vehicle is plying in Delhi - NCR Region = "No"/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - Valid PUC = "Yes", plying in Delhi - NCR = "No"/.test(l)));
});

test("a box already showing the answer is left as it is", async () => {
  const driver = page({ pucAnswered: true });
  const { lines, go } = ask(driver);
  await go();
  assert.ok(lines.some((l) => /Whether Valid PUC is available for the Vehicle already shows "Yes"/.test(l)));
});

test("the Delhi - NCR box missing: [E301] naming it, PUC answered", async () => {
  const driver = page({ hide: ["ncr"] });
  await assert.rejects(ask(driver).go(), (e) => e.code === "E301" && /"Whether Vehicle is plying in Delhi - NCR Region" is not on the page/.test(e.message));
  assert.equal(shows(driver, "puc"), "Yes");
});

test("an answer the next one undid is caught by the last read-back: [E306]", async () => {
  // a page whose PUC change resets Delhi - NCR can only be seen by reading both again - here Delhi - NCR is
  // answered after PUC, so reverse it: Delhi - NCR's pick puts PUC back
  const driver = page();
  const realExec = driver.executeScript.bind(driver);
  let ncrPicked = false;
  driver.executeScript = async (script, ...args) => {
    if (script === readSelectElementInPage && args[0].kind === "ncr" && shows(driver, "ncr") === "No" && !ncrPicked) {
      ncrPicked = true;
      driver.state.puc.selectedIndex = 0; // the page put PUC back to Select
    }
    return realExec(script, ...args);
  };
  await assert.rejects(ask(driver).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.match(e.message, /"Whether Valid PUC is available for the Vehicle" shows "Select" instead of "Yes"/);
    return true;
  });
});

test("the owner's answers and markup", () => {
  assert.deepEqual(
    questions.QUESTIONS.map((q) => [q.target[0], q.answer]),
    [["select[name='ynPuc']", "Yes"], ["select[name='ynDncr']", "No"]]
  );
});
