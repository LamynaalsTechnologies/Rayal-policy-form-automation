// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaModelCollect.test.js
//
// The owner's request (2026-11-14): one hand-run script reads KSHEMA's Make dropdown, picks each make, reads ALL its models,
// then picks the models one by one and reads each model's variants; the next make only after the last model. Saved insert
// only. No browser, no network, no database here - a fake KSHEMA form and a fake database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const lib = require("../lib/kshemaModelCollect");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

// ---- a fake KSHEMA form ------------------------------------------------------------------------------------------------

const CATALOG = {
  HONDA: { ACTIVA: ["STD", "DLX", "DLX OBD2B"], DIO: ["STD", "DLX"], UNICORN: ["STD"] },
  "TVS MOTOR COMPANY LTD": { JUPITER: ["STD", "ZX", "CLASSIC"], NTORQ: ["RACE", "XT"] },
  "HERO HONDA": { SPLENDOR: ["STD"] },
  "NO MODELS CO": {},
  "BAJAJ AUTO": { PULSAR: ["150", "180"], CT100: [] },
};

function fakeForm({ catalog = CATALOG, emptyUntilTyped = false, staleModelReads = 0, newVehicleFails = false, wrongValueAfterPick = null } = {}) {
  const events = [];
  const state = { isNew: false, make: null, model: null, open: null, search: null, modelReadsSinceMake: 0 };
  const selectorsOf = { make: ["MAKE"], model: ["MODEL"], variant: ["VARIANT"], isNew: ["NEW"] };
  const keyOfSelectors = (sel) => Object.keys(selectorsOf).find((k) => selectorsOf[k] === sel);
  const optionEl = (text) => ({ text, async getText() { return text; } });

  const listFor = (key) => {
    if (key === "make") {
      const all = Object.keys(catalog);
      if (emptyUntilTyped && !state.search) return [];
      return state.search ? all.filter((m) => m.toUpperCase().includes(String(state.search).toUpperCase())) : all;
    }
    if (key === "model") {
      if (!state.make) return [];
      let models = Object.keys(catalog[state.make] || {});
      if (state.staleModels && state.modelReadsSinceMake < staleModelReads) {
        state.modelReadsSinceMake += 1;
        return state.staleModels; // the previous make's list, still drawn
      }
      if (emptyUntilTyped && !state.search) return [];
      if (state.search) models = models.filter((m) => m.toUpperCase().includes(String(state.search).toUpperCase()));
      return models;
    }
    if (key === "variant") return state.make && state.model ? (catalog[state.make] || {})[state.model] || [] : [];
    return [];
  };

  const kshemaFields = {
    async findVisible(driver, selectors) {
      return { element: { key: keyOfSelectors(selectors), isEl: true } };
    },
    async clickElement(driver, el) {
      state.open = el.key;
      state.search = null;
      events.push(`open:${el.key}`);
    },
    async collectOptions() {
      const list = state.open ? listFor(state.open) : [];
      if (state.open) events.push(`read:${state.open}`);
      return { options: list.map(optionEl), panelOpened: !!state.open };
    },
    async searchInPanel(driver, term) {
      if (!state.open) return false;
      state.search = term;
      return true;
    },
    async closeOverlay() {
      state.open = null;
      state.search = null;
    },
    async readMatSelectValue() {
      return "";
    },
    async selectMatOption(driver, selectors, text, label, opts) {
      const key = keyOfSelectors(selectors);
      assert.equal(opts.fuzzy, false, "exact pick, never a fuzzy one");
      const names = key === "make" ? Object.keys(catalog) : key === "model" ? Object.keys(catalog[state.make] || {}) : [];
      const hit = names.find((n) => n === text);
      if (!hit) return { ok: false, value: null, reason: `"${text}" was not one of the choices for "${label}"` };
      events.push(`pick:${key}:${hit}`);
      if (key === "make") {
        state.staleModels = state.make ? Object.keys(catalog[state.make] || {}) : null;
        state.make = hit;
        state.model = null;
        state.modelReadsSinceMake = 0;
      } else state.model = hit;
      state.open = null;
      return { ok: true, value: wrongValueAfterPick || hit, reason: null };
    },
  };

  const vehicleFields = [
    { key: "isNewVehicle", selectors: selectorsOf.isNew },
    { key: "make", selectors: selectorsOf.make },
    { key: "model", selectors: selectorsOf.model },
    { key: "variant", selectors: selectorsOf.variant },
  ];
  const ctx = {
    kshemaFields,
    vehicleFields,
    async fillOneField(driver, data, field, value) {
      if (newVehicleFails) return { ok: false, reason: "the Is New Vehicle question was not on the page" };
      assert.equal(field.key, "isNewVehicle");
      assert.equal(value, "Yes");
      state.isNew = true;
      events.push("isNewVehicle:Yes");
      return { ok: true };
    },
    async waitForLoader() {
      events.push("loader");
    },
  };
  const driver = {
    async sleep() {},
    async executeScript() {
      return false; // the panel is never scrolled in the fake (it renders everything)
    },
  };
  return { ctx, driver, events, state };
}

// a fake database that remembers the ORDER of writes
function fakeDb() {
  const store = { insurerMake: [], insurerModel: [], insurerVariant: [] };
  const writes = [];
  const uniq = {
    insurerMake: (d) => `${d.company}|${d.makeKey}`,
    insurerModel: (d) => `${d.company}|${d.makeKey}|${d.modelKey}`,
    insurerVariant: (d) => `${d.company}|${d.makeKey}|${d.modelKey}|${d.variantKey}`,
  };
  return {
    store,
    writes,
    collection(name) {
      return {
        async insertOne(doc) {
          if (store[name].some((d) => uniq[name](d) === uniq[name](doc))) throw Object.assign(new Error("E11000"), { code: 11000 });
          store[name].push(doc);
          writes.push(`${name}:${doc.make}${doc.model ? "/" + doc.model : ""}${doc.variant ? "/" + doc.variant : ""}`);
        },
        async insertMany(docs) {
          const fresh = [];
          const errors = [];
          for (const d of docs) {
            if (store[name].some((x) => uniq[name](x) === uniq[name](d)) || fresh.some((x) => uniq[name](x) === uniq[name](d))) errors.push({ code: 11000 });
            else fresh.push(d);
          }
          store[name].push(...fresh);
          for (const d of fresh) writes.push(`${name}:${d.make}${d.model ? "/" + d.model : ""}${d.variant ? "/" + d.variant : ""}`);
          if (errors.length) throw Object.assign(new Error("E11000 bulk"), { code: 11000, writeErrors: errors, result: { insertedCount: fresh.length } });
          return { insertedCount: fresh.length };
        },
        updateOne() { throw new Error("insert only: nothing is ever updated"); },
        deleteOne() { throw new Error("insert only: nothing is ever deleted"); },
        deleteMany() { throw new Error("insert only: nothing is ever deleted"); },
      };
    },
  };
}

const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

// ---- the walk ----------------------------------------------------------------------------------------------------------

test("the walk: a make, ALL its models, then each model's variants one by one, and only then the next make", async () => {
  const { ctx, driver, events } = fakeForm();
  const db = fakeDb();
  const { log } = quiet();
  const totals = {};
  await lib.collectKshema(driver, ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, log, totals });

  const picks = events.filter((e) => e.startsWith("pick:"));
  assert.deepEqual(picks, [
    "pick:make:HONDA",
    "pick:model:ACTIVA", "pick:model:DIO", "pick:model:UNICORN",
    "pick:make:TVS MOTOR COMPANY LTD",
    "pick:model:JUPITER", "pick:model:NTORQ",
  ]);
  // "Is New Vehicle" first, before anything is read
  assert.equal(events[0], "isNewVehicle:Yes");
  // the models of a make are READ before its first model is picked
  const iModelsRead = events.indexOf("read:model");
  assert.ok(iModelsRead > -1 && iModelsRead < events.indexOf("pick:model:ACTIVA"));
  // each model's variants are read right after that model was picked, before the next pick
  for (let i = 0; i < events.length; i++) {
    if (events[i].startsWith("pick:model:")) {
      const next = events.slice(i + 1).findIndex((e) => e.startsWith("pick:"));
      const between = events.slice(i + 1, next === -1 ? undefined : i + 1 + next);
      assert.ok(between.includes("read:variant"), `${events[i]} was followed by a read of its variants`);
    }
  }
  // saved: a Model only AFTER the portal accepted picking it under the make, its Variants right after it, then the next Model
  assert.deepEqual(db.writes, [
    "insurerMake:HONDA",
    "insurerModel:HONDA/ACTIVA",
    "insurerVariant:HONDA/ACTIVA/STD", "insurerVariant:HONDA/ACTIVA/DLX", "insurerVariant:HONDA/ACTIVA/DLX OBD2B",
    "insurerModel:HONDA/DIO",
    "insurerVariant:HONDA/DIO/STD", "insurerVariant:HONDA/DIO/DLX",
    "insurerModel:HONDA/UNICORN",
    "insurerVariant:HONDA/UNICORN/STD",
    "insurerMake:TVS MOTOR COMPANY LTD",
    "insurerModel:TVS MOTOR COMPANY LTD/JUPITER",
    "insurerVariant:TVS MOTOR COMPANY LTD/JUPITER/STD", "insurerVariant:TVS MOTOR COMPANY LTD/JUPITER/ZX", "insurerVariant:TVS MOTOR COMPANY LTD/JUPITER/CLASSIC",
    "insurerModel:TVS MOTOR COMPANY LTD/NTORQ",
    "insurerVariant:TVS MOTOR COMPANY LTD/NTORQ/RACE", "insurerVariant:TVS MOTOR COMPANY LTD/NTORQ/XT",
  ]);
  assert.equal(db.store.insurerMake.every((d) => d.company === "KSHEMA" && d.source === "automation"), true);
  assert.equal(db.store.insurerVariant.every((d) => d.company === "KSHEMA" && d.source === "automation" && d.isEnabled === true), true);
  assert.equal(totals.makesDone, 2);
  assert.equal(totals.modelsAdded, 5);
  assert.equal(totals.variantsAdded, 11);
});

test("no make typed = every make in the dropdown, one by one", async () => {
  const { ctx, driver, events } = fakeForm();
  const db = fakeDb();
  const totals = {};
  await lib.collectKshema(driver, ctx, { makes: [], db, log: () => {}, totals });
  assert.deepEqual(
    events.filter((e) => e.startsWith("pick:make:")),
    Object.keys(CATALOG).map((m) => `pick:make:${m}`)
  );
  assert.deepEqual(totals.makesWithoutModels, ["NO MODELS CO"]);
  assert.equal(totals.makesDone, Object.keys(CATALOG).length - 1);
  // a model with no variants is counted, not an error (BAJAJ AUTO / CT100)
  assert.equal(totals.modelsWithoutVariants, 1);
  assert.equal(db.store.insurerVariant.some((v) => v.model === "CT100"), false);
});

test("typed makes: exactly these; an unknown name is reported with names like it and nothing is saved for it", async () => {
  const { ctx, driver, events } = fakeForm();
  const db = fakeDb();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectKshema(driver, ctx, { makes: ["HERO", "HONDA"], db, log, totals });
  assert.deepEqual(events.filter((e) => e.startsWith("pick:make:")), ["pick:make:HONDA"], "HERO is not a make of KSHEMA's list - HERO HONDA is another make");
  assert.deepEqual(totals.makesNotFound, ["HERO"]);
  assert.ok(lines.some((l) => /HERO: KSHEMA has no make with exactly this name - names like it: HERO HONDA/.test(l)), lines.join("\n"));
  assert.equal(db.store.insurerMake.some((m) => m.make.startsWith("HERO")), false);
});

test("a Make list that is EMPTY until typed is read by A-Z and 0-9 and joined", async () => {
  const { ctx, driver } = fakeForm({ emptyUntilTyped: true });
  const found = await lib.readOptions(driver, ctx, ctx.vehicleFields.find((f) => f.key === "make").selectors, "Make", { searchable: true });
  assert.deepEqual([...found].sort(), Object.keys(CATALOG).sort());
});

test("the old make's models still on screen are not read as the new make's (the Reliance lesson)", async () => {
  const { ctx, driver } = fakeForm({ staleModelReads: 1 });
  const db = fakeDb();
  await lib.collectKshema(driver, ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, log: () => {}, totals: {} });
  const tvsModels = db.store.insurerModel.filter((m) => m.make === "TVS MOTOR COMPANY LTD").map((m) => m.model).sort();
  assert.deepEqual(tvsModels, ["JUPITER", "NTORQ"], "no HONDA model was saved under the TVS make");
  assert.equal(db.store.insurerModel.some((m) => m.make === "TVS MOTOR COMPANY LTD" && m.model === "ACTIVA"), false);
});

test("a model list that still shows the PREVIOUS make's models is read again until it changes; nothing wrong is saved (found with the National replica)", async () => {
  const { ctx, driver, events } = fakeForm({ staleModelReads: 4 });
  const db = fakeDb();
  const totals = {};
  await lib.collectKshema(driver, ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD", "BAJAJ AUTO"], db, log: () => {}, totals });
  // the re-read path did it: no make failed and none was picked twice
  assert.deepEqual(totals.makesFailed, []);
  for (const make of ["HONDA", "TVS MOTOR COMPANY LTD", "BAJAJ AUTO"]) assert.equal(events.filter((e) => e === `pick:make:${make}`).length, 1, make);
  const wrong = db.store.insurerModel.filter((m) => !(CATALOG[m.make] || {})[m.model]);
  assert.deepEqual(wrong, [], "no model was saved under a make that does not have it");
  assert.deepEqual(db.store.insurerModel.filter((m) => m.make === "BAJAJ AUTO").map((m) => m.model).sort(), ["CT100", "PULSAR"]);
});

test("a model the portal refuses to pick under the make is never saved", async () => {
  const form = fakeForm();
  const realSelect = form.ctx.kshemaFields.selectMatOption;
  form.ctx.kshemaFields.selectMatOption = async (driver, selectors, text, label, opts) =>
    label === "Model" && text === "UNICORN" ? { ok: false, value: null, reason: `"UNICORN" was not one of the choices for "Model"` } : realSelect(driver, selectors, text, label, opts);
  const db = fakeDb();
  const totals = {};
  await lib.collectKshema(form.driver, form.ctx, { makes: ["HONDA"], db, log: () => {}, totals });
  assert.equal(db.store.insurerModel.some((m) => m.model === "UNICORN"), false);
  assert.deepEqual(totals.makesFailed.map((f) => f.make), ["HONDA"]);
});

test("a second run adds nothing (insert only)", async () => {
  const db = fakeDb();
  const first = {};
  const f1 = fakeForm();
  await lib.collectKshema(f1.driver, f1.ctx, { makes: ["HONDA"], db, log: () => {}, totals: first });
  const counts = Object.fromEntries(Object.entries(db.store).map(([k, v]) => [k, v.length]));
  const second = {};
  const f2 = fakeForm();
  await lib.collectKshema(f2.driver, f2.ctx, { makes: ["HONDA"], db, log: () => {}, totals: second });
  assert.deepEqual(Object.fromEntries(Object.entries(db.store).map(([k, v]) => [k, v.length])), counts);
  assert.equal(second.modelsAdded, 0);
  assert.equal(second.modelsAlreadyThere, 3);
  assert.equal(second.variantsAdded, 0);
  assert.equal(second.variantsAlreadyThere, 6);
});

// ---- errors: one exact sentence, no colon ---------------------------------------------------------------------------

test("Is New Vehicle that cannot be set to Yes stops the walk with one plain sentence, nothing read", async () => {
  const { ctx, driver, events } = fakeForm({ newVehicleFails: true });
  await assert.rejects(
    lib.collectKshema(driver, ctx, { makes: ["HONDA"], db: fakeDb(), log: () => {}, totals: {} }),
    (e) => {
      assert.equal(e.name, "CollectError");
      assert.equal(e.nonRetryable, true);
      assert.match(e.message, /^Is New Vehicle could not be set to Yes - the Is New Vehicle question was not on the page\.$/);
      assert.equal(e.message.includes(":"), false);
      return true;
    }
  );
  assert.equal(events.some((e) => e.startsWith("read:")), false);
});

test("a make the portal shows under another name after the pick is not read: it is tried once more, then reported (no wrong list is saved)", async () => {
  const { ctx, driver, events } = fakeForm({ wrongValueAfterPick: "BAJAJ AUTO" });
  const db = fakeDb();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectKshema(driver, ctx, { makes: ["HONDA"], db, log, totals });
  assert.equal(totals.makesFailed.length, 1);
  assert.equal(totals.makesFailed[0].make, "HONDA");
  assert.match(totals.makesFailed[0].reason, /shows "BAJAJ AUTO" after choosing "HONDA"/);
  assert.equal(totals.makesFailed[0].reason.includes(":"), false);
  assert.equal(events.filter((e) => e === "pick:make:HONDA").length, 2, "tried once more, not more");
  assert.equal(events.some((e) => e.startsWith("read:model")), false, "the wrong list was never read");
  assert.equal(db.store.insurerModel.length, 0);
  assert.ok(lines.some((l) => /It is tried once more\./.test(l)) && lines.some((l) => /Run the script again for this make\./.test(l)), lines.join("\n"));
});

test("a window whose last 3 makes all failed stops with one plain sentence (the session is probably gone)", async () => {
  const { ctx, driver } = fakeForm({ wrongValueAfterPick: "BAJAJ AUTO" });
  await assert.rejects(
    lib.collectKshema(driver, ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD", "HERO HONDA"], db: fakeDb(), log: () => {}, totals: {} }),
    (e) => {
      assert.equal(e.name, "CollectError");
      assert.match(e.message, /^The last 3 makes in this window all failed, so the window stopped - the last was /);
      assert.equal(e.message.includes(":"), false);
      return true;
    }
  );
});

test("one make failing does not stop the others", async () => {
  // only HONDA's pick shows another name; TVS goes through
  const form = fakeForm();
  const realSelect = form.ctx.kshemaFields.selectMatOption;
  form.ctx.kshemaFields.selectMatOption = async (driver, selectors, text, label, opts) => {
    const r = await realSelect(driver, selectors, text, label, opts);
    return label === "Make" && text === "HONDA" ? { ...r, value: "SOMETHING ELSE" } : r;
  };
  const db = fakeDb();
  const totals = {};
  await lib.collectKshema(form.driver, form.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, log: () => {}, totals });
  assert.deepEqual(totals.makesFailed.map((f) => f.make), ["HONDA"]);
  assert.equal(totals.makesDone, 1);
  assert.deepEqual(db.store.insurerMake.map((m) => m.make), ["TVS MOTOR COMPANY LTD"]);
});

test("SEVERAL windows share one queue: every make is done by exactly one window, none twice, none missed", async () => {
  const catalog = {};
  for (let i = 1; i <= 12; i++) catalog[`MAKE ${String(i).padStart(2, "0")}`] = { [`MODEL ${i}A`]: ["V1", "V2"], [`MODEL ${i}B`]: ["V1"] };
  const forms = [1, 2, 3, 4, 5].map(() => fakeForm({ catalog }));
  const db = fakeDb();
  const totals = lib.newTotals();
  const queue = lib.createWorkQueue();
  await Promise.all(forms.map((f) => lib.collectKshema(f.driver, f.ctx, { makes: [], db, log: () => {}, totals, queue })));

  const picksPerWindow = forms.map((f) => f.events.filter((e) => e.startsWith("pick:make:")).map((e) => e.slice("pick:make:".length)));
  const all = picksPerWindow.flat();
  assert.equal(all.length, 12, "12 makes, 12 picks in all the windows together");
  assert.equal(new Set(all).size, 12, "no make was picked by two windows");
  assert.deepEqual([...new Set(all)].sort(), Object.keys(catalog).sort(), "no make was missed");
  assert.ok(picksPerWindow.filter((p) => p.length > 0).length > 1, "the work was really shared");
  assert.equal(totals.makesDone, 12);
  assert.equal(totals.modelsAdded, 24);
  assert.equal(totals.variantsAdded, 36);
  assert.equal(db.store.insurerMake.length, 12);
  assert.equal(db.store.insurerVariant.length, 36);
  assert.equal(queue.taken.length, 12);
});

test("a window that starts later does not wipe what the first windows already counted (the real windows start 3 s apart)", async () => {
  const totals = lib.newTotals();
  const queue = lib.createWorkQueue();
  const db = fakeDb();
  const first = fakeForm();
  await lib.collectKshema(first.driver, first.ctx, { makes: ["HONDA"], db, log: () => {}, totals, queue });
  const before = { done: totals.makesDone, models: totals.modelsAdded, variants: totals.variantsAdded };
  assert.deepEqual(before, { done: 1, models: 3, variants: 6 });
  const late = fakeForm();
  await lib.collectKshema(late.driver, late.ctx, { makes: ["HONDA"], db, log: () => {}, totals, queue });
  assert.deepEqual({ done: totals.makesDone, models: totals.modelsAdded, variants: totals.variantsAdded }, before, "nothing lost, nothing counted twice");
  assert.equal(late.events.some((e) => e.startsWith("pick:make:")), false, "no make was left for the late window");
});

test("windows with typed makes: the first window decides the list, the unknown name is reported once", async () => {
  const forms = [1, 2, 3].map(() => fakeForm());
  const totals = lib.newTotals();
  const queue = lib.createWorkQueue();
  await Promise.all(forms.map((f) => lib.collectKshema(f.driver, f.ctx, { makes: ["HONDA", "NOPE MOTORS", "BAJAJ AUTO"], db: fakeDb(), log: () => {}, totals, queue })));
  assert.deepEqual(totals.makesNotFound, ["NOPE MOTORS"], "reported once, not once per window");
  const all = forms.flatMap((f) => f.events.filter((e) => e.startsWith("pick:make:")));
  assert.deepEqual(all.sort(), ["pick:make:BAJAJ AUTO", "pick:make:HONDA"]);
});

test("the work queue: take, give back once, never the same make twice", () => {
  const q = lib.createWorkQueue();
  assert.equal(q.take(), null, "nothing to take before the Make list is read");
  q.targets = ["A", "B"];
  assert.deepEqual(q.take(), { text: "A", n: 1, again: false });
  assert.equal(q.giveBack("A"), true);
  assert.equal(q.giveBack("A"), false, "once only");
  assert.deepEqual(q.take(), { text: "A", n: null, again: true }, "a returned make comes before the next new one");
  assert.deepEqual(q.take(), { text: "B", n: 2, again: false });
  assert.equal(q.take(), null);
});

test("a pick the portal refuses is one sentence that names what it offered", async () => {
  const { ctx, driver } = fakeForm();
  await assert.rejects(lib.pickExact(driver, ctx, ctx.vehicleFields.find((f) => f.key === "make").selectors, "NOT THERE", "Make", { searchable: true }), (e) => {
    assert.match(e.message, /The Make "NOT THERE" could not be chosen - "NOT THERE" was not one of the choices for "Make"\./);
    assert.equal(e.message.includes(":"), false);
    return true;
  });
});

// ---- saving variants ---------------------------------------------------------------------------------------------------

test("saveVariants: stored names, keys, KSHEMA, 'Policy run'; one batch dedupes; a duplicate is 'already there'", async () => {
  const db = fakeDb();
  const now = () => new Date("2026-11-14T00:00:00Z");
  const rows = [
    { make: "honda", model: "activa", variant: "dlx  obd2b" },
    { make: "HONDA", model: "ACTIVA", variant: "DLX OBD2B" }, // the same name
    { make: "HONDA", model: "ACTIVA", variant: "" }, // nothing
    { make: "HONDA", model: "DIO", variant: "DLX OBD2B" }, // same name under another model = another row
  ];
  assert.deepEqual(await lib.saveVariants(db, rows, { now }), { variantsAdded: 2, variantsAlreadyThere: 0 });
  assert.deepEqual(db.store.insurerVariant[0], {
    company: "KSHEMA", make: "HONDA", makeKey: "HONDA", model: "ACTIVA", modelKey: "ACTIVA", variant: "DLX OBD2B", variantKey: "DLX OBD2B",
    isEnabled: true, source: "automation", createdAt: now(),
  });
  assert.deepEqual(await lib.saveVariants(db, rows, { now }), { variantsAdded: 0, variantsAlreadyThere: 2 });
  assert.equal(db.store.insurerVariant.length, 2);
  assert.deepEqual(await lib.saveVariants(db, [], {}), { variantsAdded: 0, variantsAlreadyThere: 0 });
});

test("a real database error while saving is not hidden", async () => {
  const db = { collection: () => ({ async insertMany() { throw Object.assign(new Error("not authorized"), { code: 13 }); } }) };
  await assert.rejects(lib.saveVariants(db, [{ make: "A", model: "B", variant: "C" }]), /not authorized/);
});

// ---- the script and the hook never touch a normal run ----------------------------------------------------------------

test("the script: arguments", () => {
  const { parseArgs } = require("../scripts/kshemaCollectModels");
  assert.deepEqual(parseArgs(["--policy", "0123456789abcdef01234567"]), { policy: "0123456789abcdef01234567", makes: [], windows: 10, show: false });
  assert.deepEqual(parseArgs(["--policy", "0123456789abcdef01234567", "honda", "tvs motor  company ltd", "HONDA"]), {
    policy: "0123456789abcdef01234567", makes: ["HONDA", "TVS MOTOR COMPANY LTD"], windows: 10, show: false,
  });
  assert.deepEqual(parseArgs(["--policy", "0123456789abcdef01234567", "--windows", "5", "--show", "honda"]), {
    policy: "0123456789abcdef01234567", makes: ["HONDA"], windows: 5, show: true,
  });
  for (const bad of ["0", "11", "2.5", "abc", ""]) assert.match(parseArgs(["--policy", "0123456789abcdef01234567", "--windows", bad]).error, /--windows needs a whole number from 1 to 10/);
  assert.match(parseArgs(["honda"]).error, /which policy/);
  assert.match(parseArgs(["--policy", "abc"]).error, /not a policy id/);
  assert.match(parseArgs(["--nope"]).error, /Unknown option/);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("the script and the library write nothing to the policy, delete nothing, and add no .env switch", () => {
  for (const file of [["scripts", "kshemaCollectModels.js"], ["lib", "kshemaModelCollect.js"]]) {
    const code = read(...file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|\.drop\(/.test(code), false, file.join("/"));
    assert.equal(/process\.env\.[A-Z_]*(ENABLED|SWITCH)/.test(code), false, `${file.join("/")} has no new .env switch`);
  }
  const script = read("scripts", "kshemaCollectModels.js").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const key of ["_id: ", "policyId", "_jobId"]) {
    // the run's data is built from the customer fields only
    assert.equal(/const data = \{[\s\S]*?\};/.exec(script)[0].includes(key), false, `${key} is not in the run's data`);
  }
});

test("the hook in the KSHEMA flow: after the customer details pass, before the vehicle is filled, inert without a function", () => {
  const src = read("fullPolicycompany", "kshemaForm.js");
  const customerOk = src.indexOf("if (!customer.ok) {");
  const hook = src.indexOf('typeof data.collectMakeModels === "function"');
  const vehicle = src.indexOf("vehicle = await fillVehicleDetails(driver, data, capture);");
  assert.ok(customerOk > 0 && customerOk < hook && hook < vehicle, "customer details, then the hook, then the vehicle");
  assert.equal(src.split('typeof data.collectMakeModels === "function"').length - 1, 1, "one hook only");
  // the TP copy mirrors it (its sync guard needs the same lines) and is inert the same way; the quote forms are untouched
  const tp = read("multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js");
  assert.equal(tp.split('typeof data.collectMakeModels === "function"').length - 1, 1);
  assert.ok(tp.indexOf('typeof data.collectMakeModels === "function"') < tp.indexOf("vehicle = await fillVehicleDetails(driver, data, capture);"));
  assert.equal(read("fullPolicycompany", "kshema", "kshemaQuoteForm.js").includes("collectMakeModels"), false);
  assert.equal(read("multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js").includes("collectMakeModels"), false);
});

test("saveVariants with another collection writes only there (National's 'Not able to Find' list); the default is unchanged", async () => {
  const written = [];
  const db = { collection: (name) => ({ async insertMany(docs) { written.push([name, docs.length]); return { insertedCount: docs.length }; } }) };
  const rows = [{ make: "A", model: "B", variant: "C" }];
  await lib.saveVariants(db, rows);
  await lib.saveVariants(db, rows, { company: "National", collection: "insurerVariantNotFound" });
  assert.deepEqual(written, [["insurerVariant", 1], ["insurerVariantNotFound", 1]]);
});
