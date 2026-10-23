// Run with: node --require ./test/support/noRealWorld.js --test test/relianceOdFuelType.test.js
//
// Reliance OD: the Fuel Type box (multiCompany/common/reliance/relianceOdSteps.js selectFuelType) and the check that the
// cover table came back after Get Coverage Details (requireCoverTable). The owner, 2026-10-23: "it miss the fuel type ...
// I want exact same, not missing anything, and error handling all thing exact".
// The box's real markup is not known, so it is FOUND (id / aria-owns / label) and every way it can fail has its own
// sentence. Fake pages and a fake clock: no browser, no network, nothing really waits. The in-page readers themselves were
// run in a real Chrome on replicas of the plausible page shapes (scratch runs, see the README) — a unit test never starts one.
const test = require("node:test");
const assert = require("node:assert/strict");

const steps = require("../multiCompany/common/reliance/relianceOdSteps");

const silent = () => {};
const oneColon = (message) => message.split(":").length - 1 === 1;

/* ------------------------- a stand-in Fuel Type box with a fake clock ------------------------- */

/**
 * @param {Object} [o]
 * @param {"kendo"|"select"|"text"} [o.kind="kendo"]
 * @param {string}   [o.id="ddlFuelType"]
 * @param {string}   [o.text="Select"]            what the box shows at first
 * @param {string[]} [o.options]                  its items
 * @param {number}   [o.appearsAt=0]              ms (virtual) when the box is on screen
 * @param {number}   [o.optionsAt=0]              ms when its list is loaded
 * @param {number}   [o.enabledAt=0]              ms when it can be used
 * @param {boolean}  [o.disabled=false]           never usable
 * @param {boolean}  [o.readOnly=false]           a locked text box (the page's own value, not to be changed)
 * @param {number}   [o.ignoreOpen=0]             the first n clicks on the box do nothing
 * @param {number}   [o.ignoreItem=0]             the first n clicks on an item do nothing
 * @param {boolean}  [o.apiWorks=true]            Kendo's own function can set it
 * @param {boolean}  [o.noBox=false]              there is no Fuel Type box at all
 * @param {string}   [o.label="Fuel Type *"]
 * @param {"id"|"aria-owns"|"label"} [o.how="id"]   how the page reader found the box
 * @param {Object[]} [o.extra]                    more candidates (another box)
 * @param {Object[]} [o.dropdowns]                the dropdown boxes of the page
 * @param {boolean}  [o.readThrowsOnce=false]     the first page read fails (a page that is reloading)
 */
function fuelPage(o = {}) {
  let t = 0;
  const kind = o.kind || "kendo";
  const id = o.id || "ddlFuelType";
  const options = o.options || ["Petrol", "Diesel", "CNG"];
  const model = { text: o.text === undefined ? "Select" : o.text, open: false };
  const left = { open: o.ignoreOpen || 0, item: o.ignoreItem || 0 };
  const events = [];
  let readFailed = false;

  const control = () => ({
    id,
    name: id,
    tag: kind === "select" ? "select" : kind === "text" ? "input" : "select",
    kind,
    listId: kind === "kendo" ? `${id}_listbox` : "",
    shown: t >= (o.appearsAt || 0),
    disabled: !!o.disabled || t < (o.enabledAt || 0),
    readOnly: !!o.readOnly,
    text: model.text,
    options: t >= (o.optionsAt || 0) && kind !== "text" ? options.map((text) => ({ text, disabled: false })) : [],
    label: o.label === undefined ? "Fuel Type *" : o.label,
    how: o.how || "id",
  });
  const snapshot = () => ({
    controls: o.noBox ? [...(o.extra || [])] : [control(), ...(o.extra || [])],
    dropdowns: o.dropdowns || [{ id: "Manufacturing_YearVehicle", shown: true, text: "2026" }, { id: "Manufacturing_MonthVehicle", shown: true, text: "October" }],
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
  const opener = element("opener", () => {
    if (left.open > 0) left.open -= 1;
    else model.open = true;
  });
  const item = (text) =>
    element("item", () => {
      if (left.item > 0) {
        left.item -= 1;
        model.open = false;
      } else {
        model.text = text;
        model.open = false;
      }
    });

  const driver = {
    async executeScript(script, ...args) {
      if (typeof script === "function") {
        if (script === steps.readFuelTypeInPage) {
          if (o.readThrowsOnce && !readFailed) {
            readFailed = true;
            throw new Error("javascript error: document unloaded");
          }
          return snapshot();
        }
        if (script === steps.findFuelOpenerInPage) {
          events.push(["find-opener", args[0], args[1]]);
          return opener;
        }
        if (script === steps.findFuelListItemInPage) {
          const wanted = options.find((x) => steps.sameFuel(x, args[1]));
          return model.open && wanted ? item(wanted) : null;
        }
        if (script === steps.setFuelByKendoApiInPage) {
          events.push(["api", args[0], args[1], t]);
          if (o.apiWorks === false) return false;
          const wanted = options.find((x) => steps.sameFuel(x, args[1]));
          if (!wanted) return false;
          model.text = wanted;
          return true;
        }
        throw new Error(`unexpected page function ${script.name}`);
      }
      if (/scrollIntoView/.test(script)) return null;
      if (/arguments\[0\]\.click\(\)/.test(script)) {
        args[0].scriptClick();
        return null;
      }
      throw new Error(`unexpected script: ${script}`);
    },
  };
  const opts = {
    log: silent,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { driver, opts, model, events, time: () => t, controlNow: control };
}

async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
}

/* ------------------------- choosing the fuel type ------------------------- */

test("Fuel Type (a Kendo dropdown): the box is clicked open and the item is clicked — one real click each, in that order, then read back", async () => {
  const p = fuelPage();
  const lines = [];
  const r = await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL", log: (l) => lines.push(l) });
  assert.deepEqual(r, { id: "ddlFuelType", kind: "kendo", how: "list", chosen: "Petrol", via: "exact" });
  assert.equal(p.model.text, "Petrol", "the box ends on the list's own spelling of the policy's fuel type");
  assert.deepEqual(p.events.filter((e) => e[0] === "opener" || e[0] === "item").map((e) => [e[0], e[1]]), [["opener", "real"], ["item", "real"]]);
  assert.ok(lines.some((l) => /Fuel Type set to "Petrol" \(picked from the open list\)/.test(l)));
  assert.ok(lines.some((l) => /the policy says "PETROL"/.test(l)), "what the policy says is in the log");
});

test("Fuel Type: a box that already shows the right fuel type is left alone — no click at all", async () => {
  const p = fuelPage({ text: "Petrol" });
  const r = await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" });
  assert.equal(r.how, "already");
  assert.equal(p.events.filter((e) => e[0] === "opener" || e[0] === "item").length, 0);
});

test("Fuel Type: a disabled box that already holds the right value is fine; a different value is an error that says so", async () => {
  let p = fuelPage({ text: "Petrol", disabled: true });
  assert.equal((await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" })).how, "already");

  p = fuelPage({ text: "Diesel", disabled: true });
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: Reliance fixed the Fuel Type as "Diesel" for this vehicle and does not let it be changed, but the policy's vehicle says "PETROL"\./);
  assert.match(e.message, /Check the vehicle in Master then Make and Model/);
  assert.match(e.message, /Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
  assert.equal(p.events.filter((x) => x[0] === "opener").length, 0, "nothing was clicked");
});

test("Fuel Type: a LOCKED text box (read-only) with another value says Reliance fixed it; with the right value it is fine", async () => {
  let p = fuelPage({ kind: "text", text: "Diesel", readOnly: true });
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: Reliance fixed the Fuel Type as "Diesel" for this vehicle and does not let it be changed, but the policy's vehicle says "PETROL"\./);
  assert.ok(oneColon(e.message));

  p = fuelPage({ kind: "text", text: "Petrol", readOnly: true });
  assert.equal((await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" })).how, "already");
});

test("Fuel Type: a slow portal is waited for — the box 6 s late, its list 5 s late, enabled 4 s late", async () => {
  for (const late of [{ appearsAt: 6000 }, { optionsAt: 5000 }, { enabledAt: 4000 }]) {
    const p = fuelPage(late);
    await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "Petrol" });
    assert.equal(p.model.text, "Petrol", JSON.stringify(late));
    const firstClick = p.events.find((e) => e[0] === "opener");
    assert.ok(firstClick[2] >= Math.max(...Object.values(late)), `nothing was clicked before the box was ready (${JSON.stringify(late)})`);
  }
});

test("Fuel Type: the loader is waited for before looking and again after choosing", async () => {
  const p = fuelPage();
  const order = [];
  await steps.selectFuelType(p.driver, {
    ...p.opts,
    fuelType: "PETROL",
    log: (l) => /Fuel Type set to/.test(l) && order.push("done"),
    waitLoader: async () => order.push(p.model.text === "Select" ? "loader before" : "loader after"),
  });
  assert.deepEqual(order, ["loader before", "loader after", "done"]);
});

test("Fuel Type: a click on the box that opened nothing is repeated; an item click that took nothing is repeated; two tries at most each", async () => {
  let p = fuelPage({ ignoreOpen: 1 });
  await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" });
  assert.equal(p.events.filter((e) => e[0] === "opener").length, 2);
  assert.equal(p.model.text, "Petrol");

  p = fuelPage({ ignoreItem: 1 });
  const lines = [];
  await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL", log: (l) => lines.push(l) });
  assert.equal(p.events.filter((e) => e[0] === "item").length, 2);
  assert.ok(lines.some((l) => /does not show "Petrol" after the item was clicked \(try 1\/2\)/.test(l)), "the miss is logged");
  assert.equal(p.events.some((e) => e[0] === "api"), false, "Kendo's own function was not needed");
});

test("Fuel Type: when the list cannot be used at all, Kendo's own function is the last resort — with a warning, and it is read back", async () => {
  const p = fuelPage({ ignoreOpen: 2 });
  const lines = [];
  const r = await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL", log: (l) => lines.push(l) });
  assert.equal(r.how, "script");
  assert.equal(p.model.text, "Petrol");
  assert.ok(lines.some((l) => /the list could not be used, choosing "Petrol" with Kendo's own function instead/.test(l)));
  assert.ok(lines.some((l) => /by script - the list could not be used/.test(l)));
});

test("Fuel Type: nothing works -> an error that says what the box shows, never a silent carry-on", async () => {
  const p = fuelPage({ ignoreOpen: 2, apiWorks: false });
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: the Fuel Type box \(id ddlFuelType\) shows "Select" instead of "Petrol", so the run stopped there\. Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
});

test("Fuel Type: the box is not there -> an error after 15 s that lists the dropdown boxes that ARE on the page", async () => {
  const p = fuelPage({ noBox: true, dropdowns: [{ id: "ddlobjBranchDetailAgentsHnin", shown: true, text: "GIRNAR FINSERV" }, { id: "Manufacturing_YearVehicle", shown: true, text: "2026" }, { id: "hiddenOne", shown: false, text: "" }] });
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: the Fuel Type box was not found on the page within 15 seconds, so the run stopped there\./);
  assert.match(e.message, /The policy says "PETROL"\./);
  assert.match(e.message, /In the page the dropdown boxes on the page are ddlobjBranchDetailAgentsHnin showing GIRNAR FINSERV, Manufacturing_YearVehicle showing 2026\./);
  assert.equal(/hiddenOne/.test(e.message), false, "boxes that are not on screen are not listed when others are");
  assert.match(e.message, /Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
  assert.ok(p.time() >= 15000 && p.time() < 17000, `waited about 15 s (${p.time()} ms)`);
  assert.equal(p.events.filter((x) => x[0] === "opener").length, 0);
});

test("Fuel Type: a box that exists but never gets on screen, and two boxes at once, are their own errors", async () => {
  let p = fuelPage({ appearsAt: 10 * 60 * 1000 });
  let e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: a Fuel Type box exists \(ddlFuelType\) but it was not on screen within 15 seconds/);
  assert.ok(oneColon(e.message));

  const other = { id: "FuelTypeOther", name: "FuelTypeOther", tag: "select", kind: "select", listId: "", shown: true, disabled: false, readOnly: false, text: "Select", options: [{ text: "Petrol", disabled: false }], label: "", how: "id" };
  p = fuelPage({ extra: [other], label: "" });
  e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: more than one Fuel Type box is on the page \(ddlFuelType, FuelTypeOther\), so it is not known which to fill/);
  assert.ok(oneColon(e.message));
  assert.equal(p.events.filter((x) => x[0] === "opener").length, 0, "no guess is clicked");

  // the one whose label says Fuel Type is THE box
  p = fuelPage({ extra: [{ ...other, label: "Remarks" }] });
  await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" });
  assert.equal(p.model.text, "Petrol");
});

test("Fuel Type: a fuel type Reliance has no name for -> an error that quotes both, and nothing is clicked", async () => {
  const p = fuelPage({ options: ["Petrol", "Diesel", "Electric"] });
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "HYDROGEN" }));
  assert.match(e.message, /^Reliance OD: Reliance's Fuel Type list \(id ddlFuelType\) does not offer "HYDROGEN" and has no name for it - it offers "Petrol", "Diesel", "Electric"\./);
  assert.match(e.message, /Check the fuel type of the vehicle in Master then Make and Model/);
  assert.match(e.message, /Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
  assert.equal(p.events.filter((x) => x[0] === "opener").length, 0);
  // a typo in the master (DESAL for DIESEL) is not guessed at either
  const q = fuelPage({});
  assert.match((await failure(steps.selectFuelType(q.driver, { ...q.opts, fuelType: "DESAL" }))).message, /does not offer "DESAL"/);
});

/** The list as Reliance's two-wheeler Own Damage page really shows it (the owner's log, 2026-10-23) — its first item is the placeholder. */
const LIVE_LIST = ["Select Type", "Petrol", "Diesel", "Bifuel", "Battery", "Hybrid Electric Vehicle"];

test("Fuel Type on Reliance's REAL list: the master says LPG -> Petrol, with a warning that says why (the owner: 'select the petrol')", async () => {
  const p = fuelPage({ options: LIVE_LIST, text: "Select Type" });
  const lines = [];
  const r = await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "LPG", log: (l) => lines.push(l) });
  assert.equal(p.model.text, "Petrol");
  assert.equal(r.via, "gas-as-petrol");
  assert.equal(r.chosen, "Petrol");
  assert.ok(lines.some((l) => /⚠️ Fuel Type - Reliance's list has no "LPG" \(it offers "Petrol", "Diesel", "Bifuel", "Battery", "Hybrid Electric Vehicle"\)/.test(l) && /choosing "Petrol" for a gas fuel on its own, as the owner decided/.test(l)));
  assert.ok(lines.some((l) => /found the box \(id ddlFuelType, a select, found by its id\), showing "Select Type", usable, its list "Select Type", "Petrol"/.test(l) || /found the box \(id ddlFuelType, a Kendo dropdown, found by its id\), showing "Select Type", usable, its list "Select Type", "Petrol"/.test(l)), "the log names the box it found — the real id has never been seen");
});

test("Fuel Type on Reliance's real list: each fuel type of the master goes where it should", async () => {
  const cases = [
    ["PETROL", "Petrol", "exact"],
    ["DIESEL", "Diesel", "exact"],
    ["BIFUEL", "Bifuel", "exact"],
    ["BATTERY", "Battery", "exact"],
    ["ELECTRIC", "Battery", "equivalent"],
    ["EV", "Battery", "equivalent"],
    ["HYBRID", "Hybrid Electric Vehicle", "equivalent"],
    ["PETROL+CNG", "Bifuel", "equivalent"],
    ["PETRO/LPG", "Bifuel", "equivalent"],
    ["CNG", "Petrol", "gas-as-petrol"],
    ["LPG", "Petrol", "gas-as-petrol"],
  ];
  for (const [master, reliance, via] of cases) {
    const p = fuelPage({ options: LIVE_LIST, text: "Select Type" });
    const r = await steps.selectFuelType(p.driver, { ...p.opts, fuelType: master });
    assert.equal(p.model.text, reliance, master);
    assert.equal(r.via, via, master);
  }
});

test("Fuel Type: an electric scooter NEVER becomes Petrol — no 'Battery' in the list is an error, not a fallback", async () => {
  const p = fuelPage({ options: ["Select Type", "Petrol", "Diesel"], text: "Select Type" });
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "ELECTRIC" }));
  assert.match(e.message, /does not offer "ELECTRIC" and has no name for it/);
  assert.equal(p.events.filter((x) => x[0] === "opener").length, 0);
});

test("Fuel Type: 'Select Type' is a placeholder — never an offer, never chosen, and a list that only has it is not loaded yet", async () => {
  // only the placeholder for 5 s, then the real items: the step waits instead of choosing from nothing
  const late = fuelPage({ options: LIVE_LIST, text: "Select Type", optionsAt: 5000 });
  await steps.selectFuelType(late.driver, { ...late.opts, fuelType: "PETROL" });
  assert.equal(late.model.text, "Petrol");

  // a list that never gets past the placeholder is an empty list (the sentence does not call it an offer)
  const never = fuelPage({ options: ["Select Type"], text: "Select Type" });
  const e = await failure(steps.selectFuelType(never.driver, { ...never.opts, fuelType: "PETROL" }));
  assert.match(e.message, /the Fuel Type list \(id ddlFuelType\) stayed empty/);

  for (const placeholder of ["Select Type", "Select", "--Select--", "Please select", "Choose fuel", ""]) assert.equal(steps.chooseFuelOption("PETROL", [{ text: placeholder }]), null, placeholder);
  assert.equal(steps.chooseFuelOption("PETROL", [{ text: "Selected Petrol" }]), null, "an item that merely starts with the letters 'select' is not 'Petrol'");
});

test("Fuel Type: the placeholder is never an option; a list that stays empty is an error; a plain text box is an error", async () => {
  let p = fuelPage({ options: ["Select", "Petrol"] });
  await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" });
  assert.equal(p.model.text, "Petrol");

  p = fuelPage({ options: ["Select", "--Select--"] });
  let e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /^Reliance OD: the Fuel Type list \(id ddlFuelType\) stayed empty for 15 seconds/);
  assert.ok(oneColon(e.message));

  p = fuelPage({ kind: "text", text: "Petrol/CNG" });
  e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" }));
  assert.match(e.message, /is a plain text box showing "Petrol\/CNG", not a list/);
  assert.ok(oneColon(e.message));
});

test("Fuel Type (a native select): lib/realSelect picks it, once, with the list's own spelling; the result is read back", async () => {
  const p = fuelPage({ kind: "select", id: "FuelTypeSel" });
  const calls = [];
  const r = await steps.selectFuelType(p.driver, {
    ...p.opts,
    fuelType: "DIESEL",
    pickNative: async (driver, id, text, opts) => {
      calls.push([id, text, opts.label]);
      p.model.text = text;
      return { how: "list" };
    },
  });
  assert.deepEqual(calls, [["FuelTypeSel", "Diesel", "Fuel Type"]]);
  assert.deepEqual(r, { id: "FuelTypeSel", kind: "select", how: "list", chosen: "Diesel", via: "exact" });

  // a native select that did not take the choice is an error, not a success
  const q = fuelPage({ kind: "select" });
  const e = await failure(steps.selectFuelType(q.driver, { ...q.opts, fuelType: "DIESEL", pickNative: async () => ({ how: "script" }) }));
  assert.match(e.message, /shows "Select" instead of "Diesel"/);
});

test("Fuel Type: no fuel type on the policy is an error before the page is touched; a page read that fails once is tolerated", async () => {
  let p = fuelPage();
  let touched = 0;
  const real = p.driver.executeScript.bind(p.driver);
  p.driver.executeScript = async (...a) => (touched++, real(...a));
  const e = await failure(steps.selectFuelType(p.driver, { ...p.opts, fuelType: "  " }));
  assert.match(e.message, /^Reliance OD: the policy's vehicle has no fuel type, so the Fuel Type box could not be filled/);
  assert.ok(oneColon(e.message));
  assert.equal(touched, 0);

  p = fuelPage({ readThrowsOnce: true });
  await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL" });
  assert.equal(p.model.text, "Petrol");
});

test("Fuel Type: the box found by its label (no 'fuel' in any id) is used the same way, and the log says how it was found", async () => {
  const p = fuelPage({ id: "ddlFT9", label: "Fuel Type *", how: "label" });
  const lines = [];
  await steps.selectFuelType(p.driver, { ...p.opts, fuelType: "PETROL", log: (l) => lines.push(l) });
  assert.match(lines.join("\n"), /found the box \(id ddlFT9, a [A-Za-z ]+, found by its label\)/);
  assert.equal(p.model.text, "Petrol");
});

/* ------------------------- pure helpers ------------------------- */

test("sameFuel: case, spaces and punctuation do not matter — nothing fuzzier", () => {
  assert.equal(steps.sameFuel("PETROL", "Petrol"), true);
  assert.equal(steps.sameFuel(" petrol. ", "PETROL"), true);
  assert.equal(steps.sameFuel("CNG", "Petrol"), false);
  assert.equal(steps.sameFuel("Petrol", "Petrol/CNG"), false, "a longer text is another fuel type");
  assert.equal(steps.sameFuel("", ""), false, "nothing is not a fuel type");
});

test("pickFuelControl: one visible box, the labelled one of several, the same box reached twice, ambiguous, hidden-only, none", () => {
  const box = (over) => ({ id: "a", name: "a", shown: true, label: "", ...over });
  assert.equal(steps.pickFuelControl({ controls: [box({}), box({ id: "h", shown: false })] }).control.id, "a");
  assert.equal(steps.pickFuelControl({ controls: [box({ id: "x" }), box({ id: "y", label: "Fuel Type *" })] }).control.id, "y");
  assert.equal(steps.pickFuelControl({ controls: [box({ id: "z" }), box({ id: "z", label: "Fuel Type" })] }).state, "found", "by id and by label is one box");
  assert.equal(steps.pickFuelControl({ controls: [box({ id: "x" }), box({ id: "y" })] }).state, "ambiguous");
  assert.equal(steps.pickFuelControl({ controls: [box({ shown: false })] }).state, "hidden-only");
  assert.equal(steps.pickFuelControl({ controls: [] }).state, "none");
  assert.equal(steps.pickFuelControl(null).state, "none");
});

test("describeDropdowns: the visible boxes, with what they show; no colons", () => {
  const text = steps.describeDropdowns({ dropdowns: [{ id: "A", shown: true, text: "x: y" }, { id: "B", shown: false, text: "" }] });
  assert.equal(text, "the dropdown boxes on the page are A showing x - y");
  assert.equal(steps.describeDropdowns({ dropdowns: [] }), "no dropdown box could be read from the page");
});

/* ------------------------- the cover table after Get Coverage Details ------------------------- */

/** A page whose cover table appears at `tableAt` ms; what it says meanwhile is `words`. */
function coverPage({ tableAt = 0, words = null, alertText = "", readsFail = false } = {}) {
  let t = 0;
  const driver = {
    async executeScript(fn) {
      if (fn === steps.readCoverSummaryInPage) {
        if (readsFail && alertText) throw new Error(`unexpected alert open: {Alert text : ${alertText}}`);
        const there = t >= tableAt;
        return { helmet: { exists: there, checked: there }, zeroDep: { exists: false, checked: false }, pa: { exists: false, checked: false }, nilDepRate: null };
      }
      if (fn === steps.readPortalWordsInPage) {
        if (readsFail && alertText) throw new Error(`unexpected alert open: {Alert text : ${alertText}}`);
        return words || { cover: "", popups: [], messages: [], empty: [] };
      }
      throw new Error("unexpected page function");
    },
  };
  return { driver, opts: { log: silent, now: () => t, sleep: async (ms) => { t += ms; } }, time: () => t };
}

test("alertTextOf: the text of an open alert() out of the error every command then fails with", () => {
  assert.equal(steps.alertTextOf(new Error("unexpected alert open: {Alert text : Please select Fuel Type}\n  (Session info: chrome=150)")), "Please select Fuel Type");
  assert.equal(steps.alertTextOf(new Error("unexpected alert open: {Alert text:No data found}")), "No data found");
  assert.equal(steps.alertTextOf(new Error("some other failure")), "");
  assert.equal(steps.alertTextOf(null), "");
});

test("cover table: there at once, or 4 s late -> carried on; the OD page needs no PA box", async () => {
  for (const tableAt of [0, 4000]) {
    const p = coverPage({ tableAt });
    const summary = await steps.requireCoverTable(p.driver, p.opts);
    assert.equal(summary.helmet.exists, true);
  }
});

test("cover table: it never comes -> an error after 10 s in Reliance's own words — cover box, popup, messages and the empty required boxes", async () => {
  const p = coverPage({
    tableAt: 10 * 60 * 1000,
    words: { cover: "", popups: ["Please select Fuel Type"], messages: ["Fuel Type is required"], empty: ["Fuel Type", "Last Name"] },
  });
  const e = await failure(steps.requireCoverTable(p.driver, p.opts));
  assert.match(e.message, /^Reliance OD: Get Coverage Details did not return the cover table within 10 seconds, so the run stopped there\./);
  assert.match(e.message, /On the page a popup says "Please select Fuel Type"; the page shows "Fuel Type is required"; these required boxes look empty - Fuel Type, Last Name\./);
  assert.match(e.message, /Nothing was saved or paid\.$/);
  assert.ok(oneColon(e.message));
  assert.ok(p.time() >= 10000 && p.time() < 11500);
});

test("cover table: a message in the cover box, a native alert() and 'nothing at all' are each said as they are", async () => {
  const sentence = coverPage({ tableAt: 1e9, words: { cover: "Fuel Type should not be blank: please select", popups: [], messages: [], empty: [] } });
  let e = await failure(steps.requireCoverTable(sentence.driver, sentence.opts));
  assert.match(e.message, /the cover box says "Fuel Type should not be blank - please select"/);
  assert.ok(oneColon(e.message), "the portal's own colon is turned into a dash");

  const alerted = coverPage({ tableAt: 1e9, readsFail: true, alertText: "Please select Fuel Type" });
  e = await failure(steps.requireCoverTable(alerted.driver, alerted.opts));
  assert.match(e.message, /Reliance showed the message "Please select Fuel Type"\./);
  assert.ok(oneColon(e.message));

  const quiet = coverPage({ tableAt: 1e9 });
  e = await failure(steps.requireCoverTable(quiet.driver, quiet.opts));
  assert.match(e.message, /On the page the page showed no message, no popup and no empty required box\./);
});
