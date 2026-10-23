// Run with: node --require ./test/support/noRealWorld.js --test test/relianceOdExistingTp.test.js
//
// Reliance OD: the customer's existing third party policy on the main form (multiCompany/common/reliance/relianceOdSteps.js
// fillExistingTpPolicy), "Is Registration Address Same" (ensureAddressSame) and the exact words after Calculate Premium / Save.
// The owner, 2026-10-23: open the Kendo panel only if it is collapsed, type the policy number, choose KSHEMA or National,
// enter the start and end date, then go on with the full flow — "error handling and all things exact".
// Fake pages and a fake clock: no browser, no network, nothing really waits. The in-page readers were run in a real Chrome on
// a replica (test/manual/odReplica) — a unit test never starts one.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Key } = require("selenium-webdriver");

const steps = require("../multiCompany/common/reliance/relianceOdSteps");

const silent = () => {};
const oneColon = (message) => message.split(":").length - 1 === 1;
const TP = {
  policyNumber: "NIC/TP/0001",
  insurer: { key: "national", label: "National", pageName: "National Insurance Company Limited" },
  startDate: "01-10-2026",
  endDate: "30-09-2031",
};
const KSHEMA = { ...TP, insurer: { key: "kshema", label: "KSHEMA", pageName: "KSHEMA General Insurance Limited" } };
const LIST = ["Select Insurer", "KSHEMA GENERAL INSURANCE LIMITED", "NATIONAL INSURANCE COMPANY LIMITED"];

async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
}

/* ------------------------- a stand-in existing-TP panel with a fake clock ------------------------- */

/**
 * @param {Object} [o]
 * @param {boolean} [o.collapsed]       the panel starts collapsed
 * @param {number}  [o.ignoreExpand=0]  the first n clicks on the expand icon do nothing
 * @param {boolean} [o.noExpander]      there is no expand icon to find
 * @param {boolean} [o.noNumberBox]     the number box is not in the page at all
 * @param {"clear"|"reformat"} [o.dates]  what the date picker does with typed text: empties it, or shows it as dd/mm/yyyy
 * @param {boolean} [o.kendoApi=true]   the picker's own function works
 * @param {string}  [o.alertOnDate]     "start" | "end": TAB on that box raises an alert() with this text (o.alertText)
 * @param {string}  [o.alertText]
 * @param {Object[]} [o.extraBoxes]     more dropdowns in the panel
 * @param {string[]} [o.options]        the insurer list
 * @param {boolean} [o.insurerDisabled]
 * @param {number}  [o.ignoreOpen=0]    the first n clicks on the insurer box open nothing
 * @param {Object}  [o.words]           what the page says (popups / messages / empty) at the end
 * @param {string}  [o.insurerPicksWrong]  clicking an insurer item selects this other text
 * @param {boolean} [o.scriptTakes=true]  the page's old script way (value + change) changes nothing when false
 * @param {string}  [o.numberStays]     the number box shows this whatever is typed (a page that rewrites it)
 */
function tpPage(o = {}) {
  let t = 0;
  const events = [];
  const model = { open: !o.collapsed, number: "", start: "", end: "", insurer: "Select Insurer", insurerOpen: false };
  const left = { expand: o.ignoreExpand || 0, open: o.ignoreOpen || 0 };
  const options = o.options || LIST;
  const reformat = (text) => text.replace(/-/g, "/");

  const commit = (key, text) => {
    if (key === "number") {
      model.number = o.numberStays !== undefined ? o.numberStays : text;
      return;
    }
    if (o.alertOnDate === key) throw new Error(`unexpected alert open: {Alert text : ${o.alertText}}`);
    model[key] = o.dates === "clear" ? "" : o.dates === "reformat" ? reformat(text) : text;
  };
  const field = (key) => ({
    key,
    buffer: "",
    async click() {
      events.push([key, "click", t]);
    },
    async clear() {
      this.buffer = "";
    },
    async sendKeys(...parts) {
      for (const p of parts) {
        if (p === Key.TAB) commit(key, this.buffer);
        else {
          this.buffer += p;
          events.push([key, "typed", p]);
        }
      }
    },
  });
  const element = (name, onClick) => ({
    name,
    async click() {
      events.push([name, "real", t]);
      onClick();
    },
    scriptClick() {
      events.push([name, "script", t]);
      onClick();
    },
  });
  const expander = element("expander", () => {
    if (left.expand > 0) left.expand -= 1;
    else model.open = true;
  });
  const opener = element("opener", () => {
    if (left.open > 0) left.open -= 1;
    else model.insurerOpen = true;
  });
  const item = (text) =>
    element("item", () => {
      model.insurer = o.insurerPicksWrong || text;
      model.insurerOpen = false;
    });
  const fields = { txtExistingTPPolicyNo: field("number"), dpExistingTPPolicyRiskStartDate: field("start"), dpExistingTPPolicyRiskEndDate: field("end") };
  const box = (key) => ({ exists: !(o.noNumberBox && key === "number"), shown: model.open, disabled: false, value: model[key] });
  const boxes = () => [
    { id: "ddlExistingTPInsurer", kind: "kendo", listId: "ddlExistingTPInsurer_listbox", shown: model.open, disabled: !!o.insurerDisabled, text: model.insurer, options: options.map((text) => ({ text, disabled: false })) },
    ...(o.extraBoxes || []),
  ];

  const driver = {
    async executeScript(script, ...args) {
      if (typeof script === "function") {
        if (script === steps.readExistingTpInPage) {
          return {
            number: box("number"),
            start: box("start"),
            end: box("end"),
            panel: o.noNumberBox ? null : { header: "Existing Third Party Details", expandShown: !model.open, collapseShown: model.open },
            headers: ["Customer Details", "Existing Third Party Details", "Hypothecation"],
          };
        }
        if (script === steps.findExistingTpExpanderInPage) return o.noExpander ? null : expander;
        if (script === steps.findElementByIdInPage) return fields[args[0]] || null;
        if (script === steps.readInsurerBoxesInPage) return boxes();
        if (script === steps.findKendoOpenerInPage) return opener;
        if (script === steps.findKendoListItemInPage) {
          const wanted = options.find((x) => steps.sameFuel(x, args[1]));
          return model.insurerOpen && wanted ? item(wanted) : null;
        }
        if (script === steps.setKendoByApiInPage) return false;
        if (script === steps.setDateByKendoApiInPage) {
          if (o.kendoApi === false) return false;
          const [id, y, m, d] = args;
          const key = id === "dpExistingTPPolicyRiskStartDate" ? "start" : "end";
          model[key] = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
          events.push([key, "kendo-api", t]);
          return true;
        }
        if (script === steps.setValueByScriptInPage) {
          const key = args[0] === "dpExistingTPPolicyRiskStartDate" ? "start" : "end";
          if (o.scriptTakes !== false) model[key] = args[1];
          events.push([key, "script-value", t]);
          return true;
        }
        if (script === steps.readPortalWordsInPage) return o.words || { cover: "", popups: [], messages: [], empty: [] };
        throw new Error(`unexpected page function ${script.name}`);
      }
      if (/scrollIntoView/.test(script)) return null;
      if (/arguments\[0\]\.click\(\)/.test(script)) {
        args[0].scriptClick();
        return null;
      }
      throw new Error(`unexpected script: ${script}`);
    },
    switchTo() {
      return {
        alert: async () => {
          throw new Error("no such alert");
        },
      };
    },
  };
  const opts = {
    log: silent,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { driver, opts, model, events, time: () => t };
}

/* ------------------------- the existing TP policy ------------------------- */

test("panel already open: it is NOT clicked; number, insurer, start and end date are entered and read back", async () => {
  const p = tpPage();
  const lines = [];
  const r = await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, log: (l) => lines.push(l) });
  assert.equal(p.events.some((e) => e[0] === "expander"), false, "an open panel is not clicked (clicking would collapse it)");
  assert.ok(lines.some((l) => /the panel is already open, not clicked/.test(l)));
  assert.equal(p.model.number, "NIC/TP/0001");
  assert.equal(p.model.insurer, "NATIONAL INSURANCE COMPANY LIMITED", "the list's own spelling of the owner's 'national insurance company limited'");
  assert.equal(p.model.start, "01-10-2026");
  assert.equal(p.model.end, "30-09-2031");
  assert.deepEqual([r.startHow, r.endHow], ["typed", "typed"]);
  assert.ok(lines.some((l) => /Existing TP policy NIC\/TP\/0001 at NATIONAL INSURANCE COMPANY LIMITED, 01-10-2026 to 30-09-2031 entered/.test(l)));
});

test("KSHEMA is chosen as 'KSHEMA GENERAL INSURANCE LIMITED' — the other insurer's item is never touched", async () => {
  const p = tpPage();
  await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: KSHEMA });
  assert.equal(p.model.insurer, "KSHEMA GENERAL INSURANCE LIMITED");
});

test("panel collapsed: the expand icon is clicked ONCE, then the fields are entered", async () => {
  const p = tpPage({ collapsed: true });
  const lines = [];
  await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, log: (l) => lines.push(l) });
  assert.deepEqual(p.events.filter((e) => e[0] === "expander").map((e) => e[1]), ["real"]);
  assert.ok(lines.some((l) => /the panel "Existing Third Party Details" is collapsed, opening it/.test(l)));
  assert.equal(p.model.number, "NIC/TP/0001");
  const firstType = p.events.findIndex((e) => e[1] === "typed");
  const click = p.events.findIndex((e) => e[0] === "expander");
  assert.ok(click >= 0 && click < firstType, "nothing was typed before the panel was open");
});

test("a click on the expand icon that opened nothing is repeated ONCE with a script click; a panel that never opens is an error that lists the panels", async () => {
  let p = tpPage({ collapsed: true, ignoreExpand: 1 });
  await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP });
  assert.deepEqual(p.events.filter((e) => e[0] === "expander").map((e) => e[1]), ["real", "script"]);

  p = tpPage({ collapsed: true, ignoreExpand: 9 });
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: the existing third party panel did not open - its policy number box \(txtExistingTPPolicyNo\) is still not on screen after the expand icon was clicked/);
  assert.match(e.message, /The panels on the page are Customer Details, Existing Third Party Details, Hypothecation\./);
  assert.match(e.message, /Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
  assert.equal(p.events.some((x) => x[1] === "typed"), false, "nothing typed into a closed panel");
});

test("no expand icon to be found, and no number box in the page at all, are their own errors", async () => {
  let p = tpPage({ collapsed: true, noExpander: true });
  let e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /did not open/);

  p = tpPage({ noNumberBox: true });
  e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: the existing TP policy number box \(txtExistingTPPolicyNo\) was not found on the page within 8 seconds/);
  assert.match(e.message, /The panels on the page are /);
  assert.ok(oneColon(e.message));
});

test("the policy number must read back; a page that rewrites it is an error that says what the box shows", async () => {
  const p = tpPage({ numberStays: "WRONG-1" });
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: the existing TP policy number box \(txtExistingTPPolicyNo\) shows "WRONG-1" instead of "NIC\/TP\/0001" after it was typed/);
  assert.ok(oneColon(e.message));
});

test("the insurer: no dropdown offers it, two do, the box is disabled, or it shows another item afterwards — each its own sentence", async () => {
  let p = tpPage({ options: ["Select Insurer", "UNITED INDIA INSURANCE"] });
  let e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, waits: { find: 2000 } }));
  assert.match(e.message, /^Reliance OD: no dropdown of the existing TP panel offers National Insurance Company Limited, so the run stopped there\. The dropdowns in the panel are ddlExistingTPInsurer offering "UNITED INDIA INSURANCE"\./);
  assert.ok(oneColon(e.message));

  const second = { id: "ddlOther", kind: "select", listId: "", shown: true, disabled: false, text: "Select", options: [{ text: "NATIONAL INSURANCE COMPANY LIMITED", disabled: false }] };
  p = tpPage({ extraBoxes: [second] });
  e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /more than one dropdown of the existing TP panel offers National Insurance Company Limited \(ddlExistingTPInsurer, ddlOther\)/);
  assert.equal(p.events.some((x) => x[0] === "opener"), false, "no guess is clicked");

  p = tpPage({ insurerDisabled: true });
  e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, waits: { find: 1500 } }));
  assert.match(e.message, /the insurer dropdown \(id ddlExistingTPInsurer\) of the existing TP panel is disabled/);
});

test("an insurer box that shows another item after the click is the error with both texts (the first sentence, not the final summary)", async () => {
  const p = tpPage({ insurerPicksWrong: "UNITED INDIA INSURANCE" });
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: the existing TP insurer box \(id ddlExistingTPInsurer\) shows "UNITED INDIA INSURANCE" instead of "NATIONAL INSURANCE COMPANY LIMITED", so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
});

test("the insurer list that has BOTH insurers: only the one for this policy is chosen, and 'already chosen' is not clicked again", async () => {
  const p = tpPage();
  p.model.insurer = "NATIONAL INSURANCE COMPANY LIMITED";
  await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP });
  assert.equal(p.events.some((x) => x[0] === "opener"), false);
});

test("dates: a picker that SHOWS the date as dd/mm/yyyy is accepted (same day); one that empties it gets Kendo's own function, then the script way", async () => {
  let p = tpPage({ dates: "reformat" });
  let r = await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP });
  assert.deepEqual([r.startHow, r.endHow], ["typed", "typed"]);
  assert.equal(p.model.start, "01/10/2026");

  p = tpPage({ dates: "clear" });
  const lines = [];
  r = await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, log: (l) => lines.push(l) });
  assert.deepEqual([r.startHow, r.endHow], ["kendo", "kendo"]);
  assert.ok(lines.some((l) => /the start date box shows "nothing" after typing 01-10-2026, setting it through the date picker's own function/.test(l)));
  assert.ok(lines.some((l) => /start date 01-10-2026 \(through the date picker's own function\)/.test(l)));

  p = tpPage({ dates: "clear", kendoApi: false });
  r = await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, log: (l) => lines.push(l) });
  assert.deepEqual([r.startHow, r.endHow], ["script", "script"]);
  assert.ok(lines.some((l) => /setting it the way the form's other date boxes are set/.test(l)));
});

test("a date that no way takes (typed, Kendo's function, the script way) is the error, with what the box shows", async () => {
  const p = tpPage({ dates: "clear", kendoApi: false, scriptTakes: false });
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: the existing TP start date box \(dpExistingTPPolicyRiskStartDate\) shows "nothing" instead of 01-10-2026, so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
});

test("an alert() the page raises for a date (the page's own validator) is the exact sentence — from the typing, or right after it", async () => {
  let p = tpPage({ alertOnDate: "end", alertText: "End date must be one year after: start date" });
  let e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: Reliance refused the existing TP end date 30-09-2031 with the message "End date must be one year after - start date", so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message), "the portal's own colon became a dash");

  // an alert that is open when the page is asked (switchTo().alert()) is read and accepted
  p = tpPage();
  let taken = false;
  p.driver.switchTo = () => ({
    alert: async () => {
      if (p.events.some((x) => x[1] === "typed" && x[0] === "start") && !taken) {
        taken = true;
        return { getText: async () => "Start date cannot be in the future", accept: async () => {} };
      }
      throw new Error("no such alert");
    },
  });
  e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /Reliance refused the existing TP start date 01-10-2026 with the message "Start date cannot be in the future"/);
});

test("an alert() that comes only AFTER both dates were entered (late validators) is the error too", async () => {
  const p = tpPage();
  let endLoggedAt = null;
  let given = false;
  p.driver.switchTo = () => ({
    alert: async () => {
      if (endLoggedAt !== null && p.time() >= endLoggedAt + 1000 && !given) {
        given = true;
        return { getText: async () => "Policy period must be one year", accept: async () => {} };
      }
      throw new Error("no such alert");
    },
  });
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, log: (l) => /✔ Existing TP - end date/.test(l) && (endLoggedAt = p.time()) }));
  assert.match(e.message, /^Reliance OD: Reliance showed the message "Policy period must be one year" after the existing TP policy was entered, so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
});

test("a refusing popup at the end (Reliance's own words) is the error; a friendly one is not", async () => {
  let p = tpPage({ words: { cover: "", popups: ["Please enter a valid Existing TP policy number"], messages: [], empty: [] } });
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP }));
  assert.match(e.message, /^Reliance OD: after the existing TP policy was entered Reliance said "Please enter a valid Existing TP policy number", so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));

  p = tpPage({ words: { cover: "", popups: ["Details saved"], messages: ["Existing TP policy noted"], empty: [] } });
  await steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP });
});

test("a date the page clears afterwards (a validator that empties it) is caught by the final read-back", async () => {
  const p = tpPage();
  const real = p.driver.executeScript.bind(p.driver);
  let datesDone = false;
  p.driver.executeScript = async (fn, ...a) => {
    const out = await real(fn, ...a);
    if (datesDone && fn === steps.readExistingTpInPage) return { ...out, end: { ...out.end, value: "" } };
    return out;
  };
  const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, log: (l) => /✔ Existing TP - end date/.test(l) && (datesDone = true) }));
  assert.match(e.message, /^Reliance OD: after the existing TP policy was entered the end date box shows "nothing", so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
});

test("the loader is waited for after the dates, before the final read-back", async () => {
  const p = tpPage();
  const order = [];
  await steps.fillExistingTpPolicy(p.driver, {
    ...p.opts,
    tp: TP,
    log: (l) => /entered$/.test(l) && order.push("done"),
    waitLoader: async () => order.push(p.model.end ? "loader after the dates" : "loader earlier"),
  });
  assert.deepEqual(order.slice(-2), ["loader after the dates", "done"], "the last wait comes after both dates and before the final summary");
});

test("every operator sentence of the existing TP step has one colon and no driver text", async () => {
  const cases = [
    tpPage({ collapsed: true, ignoreExpand: 9 }),
    tpPage({ noNumberBox: true }),
    tpPage({ numberStays: "X" }),
    tpPage({ options: ["Select Insurer"] }),
  ];
  for (const p of cases) {
    const e = await failure(steps.fillExistingTpPolicy(p.driver, { ...p.opts, tp: TP, waits: { find: 1500 } }));
    assert.ok(oneColon(e.message), e.message);
    assert.ok(/Nothing was saved or paid\.$/.test(e.message));
    assert.equal(/unexpected|selenium|Wait timed out/i.test(e.message), false);
  }
});

/* ------------------------- pure helpers ------------------------- */

test("chooseInsurerOption: the ONE item for this insurer by its text; none or two is not a choice", () => {
  const o = (text) => ({ text, disabled: false });
  assert.equal(steps.chooseInsurerOption("kshema", LIST.map(o)).option.text, "KSHEMA GENERAL INSURANCE LIMITED");
  assert.equal(steps.chooseInsurerOption("national", LIST.map(o)).option.text, "NATIONAL INSURANCE COMPANY LIMITED");
  assert.equal(steps.chooseInsurerOption("national", [o("Select"), o("KSHEMA GENERAL INSURANCE LIMITED")]).why, "none");
  assert.equal(steps.chooseInsurerOption("kshema", [o("KSHEMA GENERAL INSURANCE LIMITED"), o("Kshema General Insurance Limited (old)")]).why, "many");
  assert.equal(steps.chooseInsurerOption("kshema", [{ text: "KSHEMA GENERAL INSURANCE LIMITED", disabled: true }]).option, null, "a disabled item is never chosen");
  assert.equal(steps.chooseInsurerOption("national", []).why, "none");
});

test("sameDayText: the same calendar day however the picker writes it; another day, or no date, is not", () => {
  assert.equal(steps.sameDayText("01/10/2026", "01-10-2026"), true);
  assert.equal(steps.sameDayText("1-10-2026", "01-10-2026"), true);
  assert.equal(steps.sameDayText("02/10/2026", "01-10-2026"), false);
  assert.equal(steps.sameDayText("", "01-10-2026"), false);
  assert.equal(steps.sameDayText("10/01/2026", "01-10-2026"), false, "day and month are not swapped");
});

test("refusalWords: only an error-ish popup or field message counts — a friendly one does not stop a good run", () => {
  const w = (popups, messages = []) => ({ popups, messages });
  assert.match(steps.refusalWords(w(["Please select Fuel Type"])), /^Reliance said "Please select Fuel Type"$/);
  assert.match(steps.refusalWords(w([], ["Last Name is required"])), /Last Name is required/);
  assert.match(steps.refusalWords(w(["Invalid IDV"])), /Invalid IDV/);
  assert.equal(steps.refusalWords(w(["Premium calculated successfully"], ["Saved"])), "");
  assert.equal(steps.refusalWords(w(["Please note the premium is indicative"])), "", "'please note' is not 'please select / enter'");
  assert.equal(steps.refusalWords(null), "");
});

/* ------------------------- Is Registration Address Same ------------------------- */

function addressPage(o = {}) {
  let t = 0;
  const events = [];
  const model = { checked: !!o.ticked, exists: !o.missing };
  let ignore = o.ignoreClicks || 0;
  const el = {
    async click() {
      events.push(["real", t]);
      if (ignore > 0) ignore -= 1;
      else if (!o.neverTicks) model.checked = !model.checked;
    },
    scriptClick() {
      events.push(["script", t]);
      if (!o.neverTicks) model.checked = !model.checked;
    },
  };
  const driver = {
    async executeScript(script, ...args) {
      if (typeof script === "function") {
        if (script === steps.readAddressSameInPage) return { exists: model.exists, shown: true, checked: model.checked, disabled: !!o.disabled };
        if (script === steps.findElementByIdInPage) return el;
        throw new Error("unexpected page function");
      }
      if (/scrollIntoView/.test(script)) return null;
      if (/arguments\[0\]\.click\(\)/.test(script)) {
        args[0].scriptClick();
        return null;
      }
      throw new Error("unexpected script");
    },
  };
  return { driver, opts: { log: silent, now: () => t, sleep: async (ms) => { t += ms; } }, model, events, time: () => t };
}

test("address same: unticked -> ONE real click, read back; already ticked -> NOT clicked (a blind click would UN-tick it)", async () => {
  let p = addressPage();
  assert.equal((await steps.ensureAddressSame(p.driver, p.opts)).how, "clicked");
  assert.equal(p.model.checked, true);
  assert.deepEqual(p.events.map((e) => e[0]), ["real"]);

  p = addressPage({ ticked: true });
  assert.equal((await steps.ensureAddressSame(p.driver, p.opts)).how, "already");
  assert.deepEqual(p.events, []);
  assert.equal(p.model.checked, true, "left ticked");
});

test("address same: a click that did nothing is repeated once with a script click; one that never ticks, a disabled box and a missing box are errors", async () => {
  let p = addressPage({ ignoreClicks: 1 });
  assert.equal((await steps.ensureAddressSame(p.driver, p.opts)).how, "script");
  assert.deepEqual(p.events.map((e) => e[0]), ["real", "script"]);

  p = addressPage({ neverTicks: true });
  let e = await failure(steps.ensureAddressSame(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: the "Is Registration Address Same" box stayed unticked after it was clicked, so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));

  p = addressPage({ disabled: true });
  e = await failure(steps.ensureAddressSame(p.driver, p.opts));
  assert.match(e.message, /is not ticked and Reliance does not let it be ticked/);

  p = addressPage({ missing: true });
  e = await failure(steps.ensureAddressSame(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: the "Is Registration Address Same" box \(IsRegistrationAddresssame\) was not found within 10 seconds/);
  assert.ok(oneColon(e.message));
  assert.ok(p.time() >= 10000 && p.time() < 11000);
});

/* ------------------------- the exact words after Calculate Premium and Save ------------------------- */

/** A driver that can raise an alert() once and answers the page readers with `words`. */
function afterPage({ alertText = "", alertAt = 0, words = null, readsFail = "" } = {}) {
  let t = 0;
  let given = false;
  let current = words;
  const driver = {
    async executeScript(fn) {
      if (fn === steps.readPortalWordsInPage) {
        if (readsFail) throw new Error(`unexpected alert open: {Alert text : ${readsFail}}`);
        return current || { cover: "", popups: [], messages: [], empty: [] };
      }
      throw new Error("unexpected page function");
    },
    switchTo() {
      return {
        alert: async () => {
          if (alertText && t >= alertAt && !given) {
            given = true;
            return { getText: async () => alertText, accept: async () => {} };
          }
          throw new Error("no such alert");
        },
      };
    },
  };
  return { driver, setWords: (w) => (current = w), opts: { log: silent, now: () => t, sleep: async (ms) => { t += ms; } } };
}

test("Calculate Premium: an alert() is the exact sentence; nothing is quiet; the portal's colon becomes a dash", async () => {
  let p = afterPage({ alertText: "Please enter Chassis Number: it is mandatory", alertAt: 600 });
  let e = await failure(steps.afterCalculatePremiumClick(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: Reliance showed the message "Please enter Chassis Number - it is mandatory" when Calculate Premium was pressed, so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));

  p = afterPage();
  await steps.afterCalculatePremiumClick(p.driver, p.opts); // no alert in 2.5 s: carries on

  p = afterPage({ words: { cover: "", popups: ["Please select Previous Policy Type"], messages: [], empty: ["Previous Policy Type"] } });
  e = await failure(steps.afterCalculatePremium(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: Reliance did not accept Calculate Premium - Reliance said "Please select Previous Policy Type"; these required boxes look empty - Previous Policy Type, so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));

  p = afterPage({ words: { cover: "", popups: ["Premium calculated"], messages: [], empty: [] } });
  await steps.afterCalculatePremium(p.driver, p.opts); // a friendly popup is not a refusal
});

test("Calculate Premium: an alert that makes the page reader fail is read from the error", async () => {
  const p = afterPage({ readsFail: "Please select Fuel Type" });
  const e = await failure(steps.afterCalculatePremium(p.driver, p.opts));
  assert.match(e.message, /showed the message "Please select Fuel Type" after Calculate Premium/);
});

test("Save: an alert() is the exact sentence; a Save without the success message says what the page shows and to check Reliance first", async () => {
  let p = afterPage({ alertText: "Policy start date is before today", alertAt: 0 });
  let e = await failure(steps.afterSaveClick(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: Reliance showed the message "Policy start date is before today" when Save was pressed, so no proposal number was read and the run stopped there\. Check in Reliance \(View Policy\) whether the proposal was saved before running the policy again\.$/);
  assert.ok(oneColon(e.message));

  p = afterPage({ words: { cover: "", popups: ["Please enter Engine Number"], messages: ["Engine Number is required"], empty: ["Engine Number"] } });
  e = await steps.explainSaveFailure(p.driver);
  assert.ok(e instanceof Error);
  assert.match(e.message, /^Reliance OD: Save did not show "Proposal Saved Successfully", so no proposal number was read and the run stopped there\. On the page a popup says "Please enter Engine Number"; the page shows "Engine Number is required"; these required boxes look empty - Engine Number\. Check in Reliance \(View Policy\) whether the proposal was saved before running the policy again\.$/);
  assert.ok(oneColon(e.message));

  p = afterPage({ readsFail: "Policy cannot be saved" });
  e = await steps.explainSaveFailure(p.driver);
  assert.match(e.message, /Reliance showed the message "Policy cannot be saved"\./);
});

/* ------------------------- the red bar across the bottom of the page (the first live OD run, 2026-10-23) ------------------------- */

const BAR = "As per entered Registration Number the Vehicle Class is Goods Carrier. The same is not permitted to be booked under Product 2308. Kindly book the same in correct Product or refer to our nearest Branch.";
const FOOTER = "indusindinsurance.com | 022 4890 3009 (Paid) | 74004 22200 (WhatsApp)";
const noWords = { cover: "", popups: [], messages: [], banners: [], main: "", empty: [] };

test("a message bar that reads as a refusal ('not permitted', 'kindly') is a refusal; the page's footer is not", () => {
  assert.match(steps.refusalWords({ banners: [BAR] }), /^Reliance said "As per entered Registration Number the Vehicle Class is Goods Carrier\. The same is not permitted/);
  assert.equal(steps.refusalWords({ banners: [FOOTER] }), "");
  assert.equal(steps.refusalWords({ banners: ["Premium calculated successfully"] }), "");
  assert.match(steps.refusalWords({ main: "Kindly refer to our nearest Branch" }), /Kindly refer/, "the page's own error area counts when it reads as one");
  assert.equal(steps.refusalWords({ main: "Welcome back" }), "");
  assert.match(steps.refusalWords({ popups: ["This policy is not eligible for Product 2308"] }), /not eligible/);
  // each new word on its own (the owner's sentence has two of them, which would hide a missing one)
  assert.match(steps.refusalWords({ banners: ["Booking under this product is not permitted"] }), /not permitted/);
  assert.match(steps.refusalWords({ banners: ["Vehicle details not found"] }), /not found/);
  assert.equal(steps.refusalWords({ banners: ["Proposal is being processed"] }), "", "an ordinary sentence is not a refusal");
});

test("Calculate Premium: a refusing message bar stops the run with Reliance's words; the footer does not", async () => {
  let p = afterPage({ words: { ...noWords, banners: [BAR] } });
  const e = await failure(steps.afterCalculatePremium(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: Reliance did not accept Calculate Premium - Reliance said "As per entered Registration Number the Vehicle Class is Goods Carrier\. .*Branch\.", so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
  assert.equal(e.keepMessage, true, "the failure catch must not replace this sentence with whatever #containerMain says");

  p = afterPage({ words: { ...noWords, banners: [FOOTER] } });
  await steps.afterCalculatePremium(p.driver, p.opts);
});

test("Save failed: the sentence quotes the bar Save brought — not the bars that were already there when Calculate Premium was checked", async () => {
  const p = afterPage({ words: { ...noWords, banners: [FOOTER] } });
  await steps.afterCalculatePremium(p.driver, p.opts); // the footer is remembered as "always there"
  p.setWords({ ...noWords, cover: "Zero Depreciation Nil Dep Rate Helmet Cover", banners: [FOOTER, BAR] });
  const e = await steps.explainSaveFailure(p.driver);
  assert.equal(
    e.message,
    `Reliance OD: Save did not show "Proposal Saved Successfully", so no proposal number was read and the run stopped there. On the page a message bar says "${BAR}". Check in Reliance (View Policy) whether the proposal was saved before running the policy again.`
  );
  assert.equal(e.keepMessage, true);
  assert.ok(oneColon(e.message));
  assert.doesNotMatch(e.message, /indusind|cover box/i, "neither the footer nor the cover table is part of why Save failed");
});

test("Save failed with nothing to quote: the sentence says the page showed nothing and still sends the operator to View Policy", async () => {
  const p = afterPage({ words: noWords });
  const e = await steps.explainSaveFailure(p.driver);
  assert.match(e.message, /On the page the page showed no message, no popup and no empty required box\. Check in Reliance \(View Policy\)/);
});

test("Save failed in a run that never read the bars before (a resumed run): every bar is quoted, nothing is dropped", async () => {
  const p = afterPage({ words: { ...noWords, banners: [FOOTER, BAR] } });
  const e = await steps.explainSaveFailure(p.driver);
  assert.match(e.message, /a message bar says "indusindinsurance\.com[^"]*", "As per entered Registration Number/);
});

test("the page's error area (#containerMain) and message bars are in the words the cover-table check and the Save failure quote", () => {
  const said = steps.describePortalWords({ ...noWords, cover: "x", popups: ["P1"], banners: ["B1: b"], main: "M1", messages: ["F1"], empty: ["Engine Number"] });
  assert.equal(said, 'the cover box says "x"; a popup says "P1"; a message bar says "B1 - b"; the page\'s error area says "M1"; the page shows "F1"; these required boxes look empty - Engine Number');
  assert.equal(steps.describePortalWords({ ...noWords, cover: "x", banners: ["B1"] }, { cover: false }), 'a message bar says "B1"');
});
