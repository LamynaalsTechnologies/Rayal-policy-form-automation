// Run with: node --require ./test/support/noRealWorld.js --test test/nationalModelCollect.test.js
//
// The owner's request (2026-11-14): like the KSHEMA one, for National, 10 windows. National's RTO / Make / Model / Variant are
// mat-autocomplete inputs. The collector reads each list, picks EXACTLY (never the portal's "closest" fallback), walks make ->
// all models -> each model's variants -> next make, and several windows share one queue. Fakes only - no browser, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const lib = require("../lib/nationalModelCollect");
const kshema = require("../lib/kshemaModelCollect");
const { CATALOG, fakeNationalPage, fakeDb } = require("./nationalFakePage");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const DATA = { RTOCity: "Chennai", RTORegion: "West" };
const FAST = { openWaitMs: 50, searchWaitMs: 20 };
const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l) };
};

// ---- the policy's RTO text -------------------------------------------------------------------------------------------

test("the policy's RTO is typed the way the National flow types it: City - Region, or the city alone", () => {
  assert.equal(lib.rtoTextOf({ RTOCity: "Chennai", RTORegion: "West" }), "Chennai - West");
  assert.equal(lib.rtoTextOf({ RTOCity: " Ambala ", RTORegion: "" }), "Ambala");
  assert.equal(lib.rtoTextOf({ RTOCity: "Ambala" }), "Ambala");
  assert.equal(lib.rtoTextOf({ RTORegion: "West" }), "");
  assert.equal(lib.rtoTextOf({}), "");
});

// ---- reading and picking ----------------------------------------------------------------------------------------------

test("a list that opens at once is read whole and nothing is picked; the box is emptied and closed", async () => {
  const page = fakeNationalPage();
  const texts = await lib.readAutocompleteOptions(page.driver, page.ctx, lib.NAMES.rto, "RTO location", FAST);
  assert.deepEqual(texts, ["Gurgaon - NCR", "Faridabad - NCR", "Noida - NCR", "Ambala", "Jagadhari", "Chennai - West"]);
  assert.equal(page.events.some((e) => e.startsWith("pick:")), false);
  assert.equal(page.values.rto, "");
  assert.equal(page.state.open, null);
});

test("a box that shows nothing until typed is read by A-Z and 0-9 and joined", async () => {
  const page = fakeNationalPage({ emptyUntilTypedMakes: true });
  await lib.pickAutocompleteExact(page.driver, page.ctx, lib.NAMES.rto, "Chennai - West", "RTO location");
  const texts = await lib.readAutocompleteOptions(page.driver, page.ctx, lib.NAMES.make, "Make", FAST);
  assert.deepEqual([...texts].sort(), Object.keys(CATALOG).sort());
});

test("exact pick: the option whose text EQUALS the text is clicked and the box is read back", async () => {
  const page = fakeNationalPage();
  const value = await lib.pickAutocompleteExact(page.driver, page.ctx, lib.NAMES.rto, "chennai - west", "RTO location");
  assert.equal(value, "Chennai - West");
  assert.ok(page.events.includes("idle"), "waited for the portal after the pick");
});

test("a near name is refused: 'HONDA' never picks 'HONDA MOTORS', and the first option is never clicked", async () => {
  const onlyNear = { "HONDA MOTORS": { CITY: ["BASE"] }, "HONDA CARS": { X: ["Y"] } };
  const page = fakeNationalPage({ catalog: onlyNear });
  await lib.pickAutocompleteExact(page.driver, page.ctx, lib.NAMES.rto, "Chennai - West", "RTO location");
  await assert.rejects(lib.pickAutocompleteExact(page.driver, page.ctx, lib.NAMES.make, "HONDA", "Make"), (e) => {
    assert.equal(e.name, "CollectError");
    assert.match(e.message, /^The Make "HONDA" could not be chosen - the portal offered HONDA MOTORS, HONDA CARS\.$/);
    assert.equal(e.message.includes(":"), false);
    return true;
  });
  assert.equal(page.events.some((e) => e.startsWith("pick:make")), false, "nothing was clicked");
});

test("a pick that reads back as another name stops before the wrong list is read", async () => {
  const page = fakeNationalPage({ wrongValueAfterPick: "SOMETHING ELSE" });
  await assert.rejects(lib.pickAutocompleteExact(page.driver, page.ctx, lib.NAMES.rto, "Ambala", "RTO location"), /shows "SOMETHING ELSE" after choosing "Ambala"/);
});

// ---- the walk ------------------------------------------------------------------------------------------------------------

test("the walk: the RTO, then a make, ALL its models, each model's variants one by one, only then the next make", async () => {
  const page = fakeNationalPage();
  const db = fakeDb();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, data: DATA, log: () => {}, totals, read: FAST });

  assert.deepEqual(page.events.filter((e) => e.startsWith("pick:")), [
    "pick:rto:Chennai - West",
    "pick:make:HONDA",
    "pick:model:ACTIVA", "pick:model:DIO", "pick:model:UNICORN",
    "pick:make:TVS MOTOR COMPANY LTD",
    "pick:model:JUPITER", "pick:model:NTORQ",
  ]);
  // models are READ before the first model is picked; each model's variants are read right after its pick
  assert.ok(page.events.indexOf("read:model") < page.events.indexOf("pick:model:ACTIVA"));
  // a model is saved only AFTER the portal accepted picking it, and its variants follow it, then the next model
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
  for (const name of ["insurerMake", "insurerModel", "insurerVariant"]) {
    assert.equal(db.store[name].every((d) => d.company === "National" && d.source === "automation"), true, name);
  }
  assert.equal(totals.makesDone, 2);
  assert.equal(totals.modelsAdded, 5);
  assert.equal(totals.variantsAdded, 11);
});

test("no make typed = every make; a make with no models and a model with no variants are counted, not failed", async () => {
  const page = fakeNationalPage();
  const db = fakeDb();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: [], db, data: DATA, log: () => {}, totals, read: FAST });
  assert.deepEqual(page.events.filter((e) => e.startsWith("pick:make:")), Object.keys(CATALOG).map((m) => `pick:make:${m}`));
  assert.deepEqual(totals.makesWithoutModels, ["NO MODELS CO"]);
  assert.equal(totals.modelsWithoutVariants, 1);
  assert.deepEqual(totals.makesFailed, []);
  // the HONDA make got HONDA's models only, never HONDA MOTORS's
  assert.deepEqual(db.store.insurerModel.filter((m) => m.make === "HONDA").map((m) => m.model).sort(), ["ACTIVA", "DIO", "UNICORN"]);
});

test("typed makes: exactly these; an unknown name is reported once with names like it", async () => {
  const page = fakeNationalPage();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA MOTOR", "BAJAJ AUTO"], db: fakeDb(), data: DATA, log, totals, read: FAST });
  assert.deepEqual(page.events.filter((e) => e.startsWith("pick:make:")), ["pick:make:BAJAJ AUTO"]);
  assert.deepEqual(totals.makesNotFound, ["HONDA MOTOR"]);
  assert.ok(lines.some((l) => /HONDA MOTOR: National has no make with exactly this name - names like it: HONDA, HONDA MOTORS, TVS MOTOR COMPANY LTD\./.test(l)), lines.join("\n"));
});

test("a policy with no RTO city stops before anything is picked, with one plain sentence", async () => {
  const page = fakeNationalPage();
  await assert.rejects(lib.collectNational(page.driver, page.ctx, { makes: ["HONDA"], db: fakeDb(), data: {}, log: () => {}, totals: {} }), (e) => {
    assert.match(e.message, /^This policy has no RTO city, so National's Make list could not be reached\. Choose an RTO on the policy and run again\.$/);
    assert.equal(e.message.includes(":"), false);
    return true;
  });
  assert.equal(page.events.some((e) => e.startsWith("pick:")), false);
});

test("the old make's models still on screen are never read as the new make's", async () => {
  const page = fakeNationalPage({ staleModelReads: 1 });
  const db = fakeDb();
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, data: DATA, log: () => {}, totals: {}, read: FAST });
  assert.deepEqual(db.store.insurerModel.filter((m) => m.make === "TVS MOTOR COMPANY LTD").map((m) => m.model).sort(), ["JUPITER", "NTORQ"]);
});

test("a model list that still shows the PREVIOUS make's models is read again until it changes (the live-replica bug: 21 wrong rows)", async () => {
  const page = fakeNationalPage({ staleModelReads: 4 }); // the old list stays for 4 looks after the make is picked
  const db = fakeDb();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD", "BAJAJ AUTO"], db, data: DATA, log, totals, read: FAST });
  // the re-read path did it - no make failed or was retried
  assert.deepEqual(totals.makesFailed, []);
  assert.equal(lines.some((l) => /tried once more/.test(l)), false, lines.join("\n"));
  for (const make of ["HONDA", "TVS MOTOR COMPANY LTD", "BAJAJ AUTO"]) assert.equal(page.events.filter((e) => e === `pick:make:${make}`).length, 1, make);
  const wrong = db.store.insurerModel.filter((m) => !(CATALOG[m.make] || {})[m.model]);
  assert.deepEqual(wrong, [], "no model was saved under a make that does not have it");
  assert.deepEqual(db.store.insurerModel.filter((m) => m.make === "BAJAJ AUTO").map((m) => m.model).sort(), ["CT100", "PULSAR"]);
});

test("a model list that does not change from the previous make's fails that attempt with one plain sentence; the retry reads it fresh; nothing wrong is saved", async () => {
  const page = fakeNationalPage({ staleModelReads: 1000000 });
  const db = fakeDb();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, {
    makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, data: DATA, log, totals, read: { ...FAST, staleWaitMs: 30 },
  });
  // HONDA is this window's first make (nothing to compare with). TVS first shows HONDA's models for ever -> that attempt fails ...
  const sentence = "The Model list for TVS MOTOR COMPANY LTD still shows the previous make's models after 6 s, so it was not read.";
  assert.ok(lines.some((l) => l.includes(sentence.replace(/:/g, " -")) && /It is tried once more\./.test(l)), lines.join("\n"));
  assert.equal(sentence.includes(":"), false);
  // ... and the retry (the fake's list has settled by then) is read right. Never a HONDA model under TVS.
  assert.equal(db.store.insurerModel.some((m) => m.make === "TVS MOTOR COMPANY LTD" && m.model === "ACTIVA"), false);
  assert.deepEqual(db.store.insurerModel.filter((m) => m.make === "TVS MOTOR COMPANY LTD").map((m) => m.model).sort(), ["JUPITER", "NTORQ"]);
});

test("a model the portal does not accept under the make is never saved", async () => {
  const page = fakeNationalPage();
  const realExec = page.driver.executeScript;
  // the portal refuses to pick UNICORN (not clickable) - the make fails there
  page.driver.executeScript = async (script, ...args) => {
    if (script.includes("wanted") && String(args[0]).toUpperCase() === "UNICORN") return { clicked: false, offered: ["ACTIVA", "DIO"] };
    return realExec.call(page.driver, script, ...args);
  };
  const db = fakeDb();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals, read: FAST });
  assert.equal(db.store.insurerModel.some((m) => m.model === "UNICORN"), false);
  assert.deepEqual(totals.makesFailed.map((f) => f.make), ["HONDA"]);
});

test("a second run adds nothing (insert only)", async () => {
  const db = fakeDb();
  const first = fakeNationalPage();
  await lib.collectNational(first.driver, first.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals: {}, read: FAST });
  const counts = Object.fromEntries(Object.entries(db.store).map(([k, v]) => [k, v.length]));
  const second = fakeNationalPage();
  const totals = {};
  await lib.collectNational(second.driver, second.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals, read: FAST });
  assert.deepEqual(Object.fromEntries(Object.entries(db.store).map(([k, v]) => [k, v.length])), counts);
  assert.equal(totals.modelsAdded + totals.variantsAdded, 0);
});

// ---- failures and windows -----------------------------------------------------------------------------------------------

test("an RTO pick that reads back as another name stops the window before any list is read", async () => {
  const page = fakeNationalPage({ wrongValueAfterPick: "BAJAJ AUTO" }); // every pick reads back as another name
  await assert.rejects(
    lib.collectNational(page.driver, page.ctx, { makes: ["HONDA"], db: fakeDb(), data: DATA, log: () => {}, totals: {} }),
    /shows "BAJAJ AUTO" after choosing "Chennai - West"/
  );
  assert.equal(page.events.some((e) => e.startsWith("read:")), false, "no list was read");
});

test("one make failing does not stop the others; a failed make goes back once, then is listed", async () => {
  const page = fakeNationalPage();
  const realExec = page.driver.executeScript;
  // HONDA's pick reads back as another name, everything else is normal
  page.driver.executeScript = async (script, ...args) => {
    const r = await realExec.call(page.driver, script, ...args);
    if (script.includes("return arguments[0].value") && args[0].key === "make" && /^HONDA$/.test(r)) return "SOMETHING ELSE";
    return r;
  };
  const db = fakeDb();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, data: DATA, log, totals, read: FAST });
  assert.deepEqual(totals.makesFailed.map((f) => f.make), ["HONDA"]);
  assert.match(totals.makesFailed[0].reason, /shows "SOMETHING ELSE" after choosing "HONDA"/);
  assert.equal(page.events.filter((e) => e === "pick:make:HONDA").length, 2, "tried once more, not more");
  assert.equal(totals.makesDone, 1);
  assert.deepEqual(db.store.insurerMake.map((m) => m.make), ["TVS MOTOR COMPANY LTD"]);
  assert.ok(lines.some((l) => /It is tried once more\./.test(l)) && lines.some((l) => /Run the script again for this make\./.test(l)));
});

test("a window whose last 3 makes all failed stops with one plain sentence", async () => {
  const page = fakeNationalPage();
  const realExec = page.driver.executeScript;
  page.driver.executeScript = async (script, ...args) => {
    const r = await realExec.call(page.driver, script, ...args);
    return script.includes("return arguments[0].value") && args[0].key === "make" ? "SOMETHING ELSE" : r;
  };
  await assert.rejects(
    lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD", "BAJAJ AUTO"], db: fakeDb(), data: DATA, log: () => {}, totals: {}, read: FAST }),
    (e) => {
      assert.match(e.message, /^The last 3 makes in this window all failed, so the window stopped - the last was /);
      assert.equal(e.message.includes(":"), false);
      return true;
    }
  );
});

test("SEVERAL windows share one queue: every make is done by exactly one window, none twice, none missed", async () => {
  const catalog = {};
  for (let i = 1; i <= 12; i++) catalog[`MAKE ${String(i).padStart(2, "0")}`] = { [`MODEL ${i}A`]: ["V1", "V2"], [`MODEL ${i}B`]: ["V1"] };
  const pages = [1, 2, 3, 4, 5].map(() => fakeNationalPage({ catalog }));
  const db = fakeDb();
  const totals = kshema.newTotals();
  const queue = kshema.createWorkQueue();
  await Promise.all(pages.map((p) => lib.collectNational(p.driver, p.ctx, { makes: [], db, data: DATA, log: () => {}, totals, queue, read: FAST })));
  const picks = pages.map((p) => p.events.filter((e) => e.startsWith("pick:make:")).map((e) => e.slice("pick:make:".length)));
  const all = picks.flat();
  assert.equal(all.length, 12);
  assert.equal(new Set(all).size, 12, "no make was picked by two windows");
  assert.deepEqual([...new Set(all)].sort(), Object.keys(catalog).sort(), "no make was missed");
  assert.ok(picks.filter((p) => p.length).length > 1, "the work was really shared");
  assert.equal(totals.makesDone, 12);
  assert.equal(db.store.insurerVariant.length, 36);
});

test("a window that starts later does not wipe what the first windows counted", async () => {
  const totals = kshema.newTotals();
  const queue = kshema.createWorkQueue();
  const db = fakeDb();
  const a = fakeNationalPage();
  await lib.collectNational(a.driver, a.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals, queue, read: FAST });
  const before = { done: totals.makesDone, models: totals.modelsAdded, variants: totals.variantsAdded };
  const b = fakeNationalPage();
  await lib.collectNational(b.driver, b.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals, queue, read: FAST });
  assert.deepEqual({ done: totals.makesDone, models: totals.modelsAdded, variants: totals.variantsAdded }, before);
});

// ---- the scripts and the hook never touch a normal run -----------------------------------------------------------------

test("script arguments (models)", () => {
  const { parseArgs } = require("../scripts/nationalCollectModels");
  const id = "0123456789abcdef01234567";
  assert.deepEqual(parseArgs(["--policy", id]), { policy: id, makes: [], windows: 10, show: false, notFound: false });
  assert.deepEqual(parseArgs(["--policy", id, "--windows", "5", "--show", "honda", "bajaj  auto"]), { policy: id, makes: ["HONDA", "BAJAJ AUTO"], windows: 5, show: true, notFound: false });
  assert.deepEqual(parseArgs(["--policy", id, "--not-found", "honda"]), { policy: id, makes: ["HONDA"], windows: 10, show: false, notFound: true });
  for (const bad of ["0", "11", "x"]) assert.match(parseArgs(["--policy", id, "--windows", bad]).error, /--windows needs a whole number from 1 to 10/);
  assert.match(parseArgs(["honda"]).error, /which policy/);
  assert.match(parseArgs(["--policy", "abc"]).error, /not a policy id/);
});

test("the scripts and the libraries write nothing to the policy, delete nothing, and add no .env switch", () => {
  for (const file of [["scripts", "nationalCollectModels.js"], ["scripts", "nationalCollectRtoLocations.js"], ["lib", "nationalModelCollect.js"], ["lib", "nationalRtoCollect.js"]]) {
    const code = read(...file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|\.drop\(/.test(code), false, file.join("/"));
    assert.equal(/process\.env\.[A-Z_]*(ENABLED|SWITCH)/.test(code), false, `${file.join("/")} has no new .env switch`);
  }
  for (const file of ["nationalCollectModels.js", "nationalCollectRtoLocations.js"]) {
    const script = read("scripts", file).replace(/\/\*[\s\S]*?\*\//g, "");
    const dataBlock = /const (?:baseData|data) = \{[\s\S]*?\};/.exec(script)[0];
    for (const key of ["_id: ", "policyId", "_jobId"]) assert.equal(dataBlock.includes(key), false, `${file}: ${key} is not in the run's data`);
  }
});

test("the hook: after the class, BEFORE the RTO box, once, inert without a function, no field names inside, identical in the TP copy", () => {
  const block = (src) => {
    const a = src.indexOf("    // The National Make / Model / Variant and RTO location collectors");
    const b = src.indexOf("    // Fill RTO location (autocomplete field)");
    assert.ok(a > 0 && b > a, "hook found before the RTO fill");
    return src.slice(a, b);
  };
  const full = read("fullPolicycompany", "national.js");
  const tp = read("multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js");
  for (const src of [full, tp]) {
    assert.equal(src.split('typeof data.collectMakeModels === "function"').length - 1, 1, "one hook only");
    assert.ok(src.indexOf('By.name("mcy_dropdown_vehcileClass_01")') < src.indexOf('typeof data.collectMakeModels === "function"'), "after the class");
    const code = block(src);
    assert.equal(/mcy_dropdown_|manufacturerSellingPrice|Long Term/.test(code), false, "no field names or plan names in the hook");
  }
  assert.equal(block(full), block(tp), "the two blocks are the same text");
});

// ---- the scripts that run INSIDE the portal's page, run here on a tiny fake page ----------------------------------------

const runScript = (script, doc, ...args) => new Function("document", "args", `return (function () { ${script} }).apply(null, args);`)(doc, args);
const fakeOption = (text, { hidden = false } = {}) => {
  const el = { textContent: text, offsetParent: hidden ? null : {}, clicked: false, scrollIntoView() {}, click() { this.clicked = true; } };
  return el;
};
const fakeDoc = (options) => ({ querySelectorAll: () => options });

test("in the page: the exact-click script clicks the option that EQUALS the text, ignores case and spaces, never a near name, never the first option", () => {
  const { CLICK_EXACT } = lib._scripts;
  const near = [fakeOption("HONDA MOTORS"), fakeOption("HONDA CARS")];
  assert.deepEqual(runScript(CLICK_EXACT, fakeDoc(near), "HONDA"), { clicked: false, offered: ["HONDA MOTORS", "HONDA CARS"] });
  assert.equal(near.some((o) => o.clicked), false, "a near name is never clicked and neither is the first option");

  const mixed = [fakeOption("HONDA MOTORS"), fakeOption("  honda   "), fakeOption("HONDA")];
  assert.equal(runScript(CLICK_EXACT, fakeDoc(mixed), "Honda").clicked, true);
  assert.deepEqual(mixed.map((o) => o.clicked), [false, true, false], "the first option that equals the text, not the first option");

  const hidden = [fakeOption("DIO", { hidden: true }), fakeOption("ACTIVA")];
  assert.equal(runScript(CLICK_EXACT, fakeDoc(hidden), "DIO").clicked, false, "an option that is not shown is not clicked");
  assert.deepEqual(hidden.map((o) => o.clicked), [false, false]);
});

test("in the page: the read script returns the shown options only, trimmed and in order", () => {
  const { READ_OPTIONS } = lib._scripts;
  const opts = [fakeOption(" Gurgaon \n - NCR "), fakeOption("Hidden", { hidden: true }), fakeOption("Ambala")];
  assert.deepEqual(runScript(READ_OPTIONS, fakeDoc(opts)), ["Gurgaon - NCR", "Ambala"]);
});

// ---- National's SECOND set of lists ("Not able to Find the required Model & Variant") --------------------------------------

test("a normal run writes only the normal lists; a --not-found run writes ONLY the three not-found lists, with names that are also in the normal list", async () => {
  const db = fakeDb();
  const a = fakeNationalPage();
  await lib.collectNational(a.driver, a.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals: {}, read: FAST });
  assert.equal(db.store.insurerMake.length, 1);
  for (const name of ["insurerMakeNotFound", "insurerModelNotFound", "insurerVariantNotFound"]) assert.equal(db.store[name].length, 0, `the normal run left ${name} alone`);

  const before = Object.fromEntries(["insurerMake", "insurerModel", "insurerVariant"].map((n) => [n, db.store[n].length]));
  const b = fakeNationalPage();
  const totals = {};
  await lib.collectNational(b.driver, b.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals, read: FAST, list: "notFound" });
  // the SAME names (HONDA / ACTIVA / STD ...) are now in both lists: nothing collided, nothing was skipped as "already there"
  assert.deepEqual(db.store.insurerMakeNotFound.map((m) => m.make), ["HONDA"]);
  assert.deepEqual(db.store.insurerModelNotFound.map((m) => m.model).sort(), ["ACTIVA", "DIO", "UNICORN"]);
  assert.equal(db.store.insurerVariantNotFound.length, 6);
  assert.equal(totals.modelsAdded, 3);
  assert.equal(totals.variantsAdded, 6);
  assert.equal(totals.modelsAlreadyThere + totals.variantsAlreadyThere, 0);
  for (const [name, count] of Object.entries(before)) assert.equal(db.store[name].length, count, `the not-found run left ${name} alone`);
  for (const name of ["insurerMakeNotFound", "insurerModelNotFound", "insurerVariantNotFound"]) {
    assert.equal(db.store[name].every((d) => d.company === "National" && d.source === "automation"), true, name);
  }
});

test("a second --not-found run adds nothing (insert only)", async () => {
  const db = fakeDb();
  for (let i = 0; i < 2; i++) {
    const page = fakeNationalPage();
    await lib.collectNational(page.driver, page.ctx, { makes: ["BAJAJ AUTO"], db, data: DATA, log: () => {}, totals: {}, read: FAST, list: "notFound" });
  }
  assert.equal(db.store.insurerModelNotFound.length, 2);
  assert.equal(db.store.insurerVariantNotFound.length, 2);
});

test("the list names: normal by default, the three separate collections for notFound", () => {
  assert.deepEqual(lib.listsOf(undefined), { make: "insurerMake", model: "insurerModel", variant: "insurerVariant" });
  assert.deepEqual(lib.listsOf("normal"), lib.LISTS.normal);
  assert.deepEqual(lib.listsOf("notFound"), { make: "insurerMakeNotFound", model: "insurerModelNotFound", variant: "insurerVariantNotFound" });
  assert.deepEqual(lib.listsOf("anything else"), lib.LISTS.normal, "only the word notFound selects the other lists");
});

test("--not-found puts modelNotFound in the run data of both scripts, and the normal flow ticks the portal's box BEFORE the hook", () => {
  for (const file of ["nationalCollectModels.js", "nationalCollectRtoLocations.js"]) {
    const src = read("scripts", file).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.match(src, /\.\.\.\(args\.notFound \? \{ modelNotFound: true \} : \{\}\)/, file);
  }
  assert.match(read("scripts", "nationalCollectModels.js"), /list,\s*\}\);|, list \}\)/, "the list reaches the collector");
  for (const src of [read("fullPolicycompany", "national.js"), read("multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js")]) {
    assert.ok(src.indexOf("isNonGICSelected") > 0 && src.indexOf("isNonGICSelected") < src.indexOf('typeof data.collectMakeModels === "function"'), "the tick comes first");
    assert.match(src, /isModelNotFound\s*=\s*data\.modelNotFound === true \|\| data\.modelNotFound === "true"/, "modelNotFound true is what ticks it");
  }
});

// ---- popups: what stopped 4 of 10 windows live (2026-11-14) -----------------------------------------------------------------

test("a popup that a pick brings up is closed, said in the log with its text, counted, and the walk goes on", async () => {
  const page = fakeNationalPage({ popup: { afterPick: "model:ACTIVA", text: "Selected model needs the Manufacturer's Selling Price" } });
  const db = fakeDb();
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD"], db, data: DATA, log, totals, read: FAST });
  assert.deepEqual(totals.makesFailed, []);
  assert.equal(totals.makesDone, 2);
  assert.ok(page.events.includes("popup-shown") && page.events.includes("popup-closed"));
  assert.deepEqual(totals.popups, { "Selected model needs the Manufacturer's Selling Price": 1 });
  assert.ok(lines.some((l) => /popup closed \(CLOSE\): "Selected model needs the Manufacturer's Selling Price"/.test(l)), lines.join("\n"));
  // everything was still collected
  assert.equal(db.store.insurerVariant.filter((v) => v.make === "HONDA").length, 6);
  assert.equal(page.events.some((e) => e.startsWith("blocked:")), false, "the popup was closed before the next click, so nothing was blocked");
});

test("a popup that appears AS a box is clicked blocks that click; it is closed and the click is repeated", async () => {
  const page = fakeNationalPage({ popup: { onClick: "model", text: "Please wait" } });
  const db = fakeDb();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA"], db, data: DATA, log: () => {}, totals, read: FAST });
  assert.deepEqual(totals.makesFailed, []);
  assert.equal(page.events.filter((e) => e === "blocked:model").length, 1, "the click was blocked once");
  assert.ok(page.events.includes("popup-closed"));
  assert.deepEqual(db.store.insurerModel.map((m) => m.model).sort(), ["ACTIVA", "DIO", "UNICORN"]);
  assert.equal(db.store.insurerVariant.length, 6);
});

test("the same popup after every pick: the window keeps working, the text is logged twice then only counted", async () => {
  const page = fakeNationalPage({ popup: { afterPick: "any", text: "Vehicle details changed" } });
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["BAJAJ AUTO"], db: fakeDb(), data: DATA, log, totals, read: FAST });
  assert.deepEqual(totals.makesFailed, []);
  assert.ok(totals.popups["Vehicle details changed"] >= 3, JSON.stringify(totals.popups));
  assert.equal(lines.filter((l) => /popup closed/.test(l)).length, 2, "said twice, then only counted");
});

test("a popup with no button to press is reported in words, and the click falls back to the page's own click instead of failing the make", async () => {
  const page = fakeNationalPage({ popup: { onClick: "model", text: "Maintenance notice", noButton: true } });
  const { lines, log } = quiet();
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["BAJAJ AUTO"], db: fakeDb(), data: DATA, log, totals, read: FAST });
  assert.ok(lines.some((l) => /A popup is open and has no button to close it: "Maintenance notice"/.test(l)), lines.join("\n"));
  assert.ok(page.events.some((e) => e.startsWith("js-click:")), "the last-resort click ran from the page");
});

test("the make that was blocked by a popup is retried after the popup is closed (the live failure: 3 makes in a row, then the window stopped)", async () => {
  const page = fakeNationalPage();
  const realExec = page.driver.executeScript;
  let armed = true;
  // the portal's popup appears while a variant is being read - the next make's click used to be intercepted for ever
  page.driver.executeScript = async (script, ...args) => {
    if (armed && script.includes("out.push") && page.state.open === "variant") {
      armed = false;
      page.state.popup = { text: "Late popup", noButton: false };
    }
    return realExec.call(page.driver, script, ...args);
  };
  const totals = {};
  await lib.collectNational(page.driver, page.ctx, { makes: ["HONDA", "TVS MOTOR COMPANY LTD", "BAJAJ AUTO"], db: fakeDb(), data: DATA, log: () => {}, totals, read: FAST });
  assert.deepEqual(totals.makesFailed, [], "no make failed");
  assert.equal(totals.makesDone, 3);
  assert.ok(totals.popups["Late popup"] >= 1);
});

test("in the page: the popup script closes the portal's own close button first, then Close / OK, and says what the popup said", () => {
  const { DISMISS_POPUP } = lib._scripts;
  const button = (text, name = "") => ({ textContent: text, clicked: false, getAttribute: (k) => (k === "name" ? name : null), click() { this.clicked = true; } });
  const dialog = (text, buttons, extra = {}) => ({
    textContent: text, getAttribute: () => null, querySelectorAll: () => buttons, getBoundingClientRect: () => ({ width: 300, height: 200 }), ...extra,
  });
  const runPopup = (dialogs) =>
    new Function("document", "window", "args", `return (function () { ${DISMISS_POPUP} }).apply(null, args);`)(
      { querySelectorAll: () => dialogs },
      { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      [lib.POPUP_SELECTOR]
    );

  assert.deepEqual(runPopup([]), { found: false });
  const a = [button("No"), button("Close", "alert_btn_data_01"), button("OK")];
  assert.deepEqual(runPopup([dialog("  Roadside   Assistance not opted ", a)]), { found: true, text: "Roadside Assistance not opted", clicked: true, button: "CLOSE" });
  assert.deepEqual(a.map((b) => b.clicked), [false, true, false]);

  const b = [button("Cancel"), button("Yes", "confirm_btn_yes_01")];
  runPopup([dialog("Sure?", b)]);
  assert.deepEqual(b.map((x) => x.clicked), [false, true], "the portal's own confirm button by name");

  const c = [button("Back"), button("Ok, got it"), button("More")];
  runPopup([dialog("Info", c)]);
  assert.deepEqual(c.map((x) => x.clicked), [false, true, false], "an OK button");

  const d = [button("Continue"), button("Other")];
  runPopup([dialog("Info", d)]);
  assert.deepEqual(d.map((x) => x.clicked), [true, false], "last resort: the first button");

  assert.deepEqual(runPopup([dialog("No buttons", [])]), { found: true, text: "No buttons", clicked: false });
  // the topmost (last) dialog is the one closed
  const e1 = [button("Close", "alert_btn_data_01")];
  const e2 = [button("Close", "alert_btn_data_01")];
  runPopup([dialog("under", e1), dialog("on top", e2)]);
  assert.deepEqual([e1[0].clicked, e2[0].clicked], [false, true]);
});
