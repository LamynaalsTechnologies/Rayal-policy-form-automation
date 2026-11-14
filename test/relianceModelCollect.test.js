// Run with: node --require ./test/support/noRealWorld.js --test test/relianceModelCollect.test.js
//
// The owner's request (2026-11-14): search each Make in Reliance's Make/Model box, read every suggestion and save the Models.
// A suggestion looks like "HONDA | unicorn | 160": the Make is NOT part of the Model and no bar is saved ->
// Model "UNICORN 160". Insert only. No browser, no network, no database here - fakes only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const lib = require("../lib/relianceModelCollect");

// ---- the line -> Make + Model -------------------------------------------------------------------------------------

test("HONDA | unicorn | 160 is Make HONDA and Model UNICORN 160 - no bar, no make in the model", () => {
  assert.deepEqual(lib.parseOption("HONDA | unicorn | 160", "honda"), { make: "HONDA", model: "UNICORN 160" });
});

test("a model of one part, extra spaces and many bars", () => {
  assert.deepEqual(lib.parseOption("  Hero |  Splendor   Plus | i3S | BS6 ", "HERO"), { make: "HERO", model: "SPLENDOR PLUS I3S BS6" });
  assert.deepEqual(lib.parseOption("YAMAHA | FZ", "yamaha"), { make: "YAMAHA", model: "FZ" });
  assert.deepEqual(lib.parseOption("BAJAJ | | PULSAR | 150", "bajaj"), { make: "BAJAJ", model: "PULSAR 150" });
});

test("no bar may reach a saved model", () => {
  const one = lib.parseOption("SUZUKI | ACCESS | 125 | |", "suzuki");
  assert.equal(one.model.includes("|"), false);
  assert.equal(one.model, "ACCESS 125");
});

test("a line with no bar, no make or no model is not saved and says why", () => {
  assert.match(lib.parseOption("HONDA UNICORN 160", "honda").skip, /no \| in it/);
  assert.match(lib.parseOption("| UNICORN", "honda").skip, /no Make before/);
  assert.match(lib.parseOption("HONDA |", "honda").skip, /no Model after/);
  assert.match(lib.parseOption("   ", "honda").skip, /empty/);
});

test("only the searched Make's own lines are saved: HERO, HERO HONDA and HERO MOTOCORP are three makes (the owner)", () => {
  assert.match(lib.parseOption("TVS | HONDA CLONE | 100", "honda").skip, /is a TVS line, not a HONDA one/);
  assert.equal(lib.parseOption("TVS | HONDA CLONE | 100", "honda").otherMake, "TVS");
  assert.deepEqual(lib.parseOption("HERO | SPLENDOR | CC/WATT 100", "hero"), { make: "HERO", model: "SPLENDOR CC/WATT 100" });
  assert.match(lib.parseOption("HERO HONDA | CBZ | 150", "hero").skip, /is a HERO HONDA line, not a HERO one/);
  assert.match(lib.parseOption("HERO MOTOCORP | ACHIEVER | 150", "hero").skip, /is a HERO MOTOCORP line, not a HERO one/);
  assert.match(lib.parseOption("HERO | SPLENDOR | 100", "hero honda").skip, /is a HERO line, not a HERO HONDA one/);
  assert.deepEqual(lib.parseOption("HERO MOTOCORP | ACHIEVER | 150", "hero motocorp"), { make: "HERO MOTOCORP", model: "ACHIEVER 150" });
  assert.match(lib.parseOption("HEROIC | X | 1", "hero").skip, /not a HERO one/);
});

// ---- the policy's vehicle still finds its line ------------------------------------------------------------------

test("the saved model finds the Reliance line: bars and spaces do not matter", () => {
  assert.equal(lib.optionMatches("HONDA | unicorn | 160", "HONDA", "UNICORN 160"), true);
  assert.equal(lib.optionMatches("HONDA | unicorn | 160", "", "UNICORN 160"), true);
  assert.equal(lib.optionMatches("HONDA | unicorn | 160", "HONDA", "UNICORN 150"), false);
  assert.equal(lib.optionMatches("HONDA DIO 125 SMART OBD2B", "HONDA", "DIO 125"), true); // a line with no bar, as before
});

test("the page's own match (relianceForm.js) ignores the bars the same way", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
  assert.match(src, /plain = function[^;]*replace\(\/\\\\\|\/g, ' '\)/, "the suggestion text is compared without its bars");
  assert.match(src, /fallbackSearchText/, "the Make alone is typed when the whole text finds nothing");
  // the generated OD/TP copy carries the same
  const copy = fs.readFileSync(path.join(__dirname, "..", "multiCompany", "common", "reliance", "relianceMultiForm.js"), "utf8");
  assert.match(copy, /plain = function/);
});

test("the names are kept the way the backend keeps them", (t) => {
  const backend = path.join(__dirname, "..", "..", "RayalBrokers-backend", "shared", "insurerVehicleList.js");
  if (!fs.existsSync(backend)) return t.skip("backend repo not next to this one");
  const theirs = require(backend);
  for (const sample of ["  honda   unicorn ", "Hero Honda", "<b>activa</b> 6g", "R15  V3", "a & b", "x&nbsp;y"]) {
    assert.equal(lib.cleanName(sample), theirs.cleanName(sample), JSON.stringify(sample));
  }
});

// ---- saving: insert only ----------------------------------------------------------------------------------------

function fakeDb({ makes = [], models = [] } = {}) {
  const store = { insurerMake: [...makes], insurerModel: [...models] };
  const uniq = {
    insurerMake: (d) => `${d.company}|${d.makeKey}`,
    insurerModel: (d) => `${d.company}|${d.makeKey}|${d.modelKey}`,
  };
  const calls = [];
  return {
    store,
    calls,
    collection(name) {
      return {
        async insertOne(doc) {
          calls.push([name, "insertOne"]);
          if (store[name].some((d) => uniq[name](d) === uniq[name](doc))) throw Object.assign(new Error("E11000"), { code: 11000 });
          store[name].push(doc);
          return { insertedId: 1 };
        },
        async insertMany(docs, opts) {
          calls.push([name, "insertMany", opts]);
          const fresh = [];
          const errors = [];
          for (const d of docs) {
            if (store[name].some((x) => uniq[name](x) === uniq[name](d)) || fresh.some((x) => uniq[name](x) === uniq[name](d))) errors.push({ code: 11000 });
            else fresh.push(d);
          }
          store[name].push(...fresh);
          if (errors.length) throw Object.assign(new Error("E11000 bulk"), { code: 11000, writeErrors: errors, result: { insertedCount: fresh.length } });
          return { insertedCount: fresh.length };
        },
        find() {
          throw new Error("an update/read-back is not part of insert only");
        },
        updateOne() {
          throw new Error("insert only: nothing is ever updated");
        },
      };
    },
  };
}

test("saving: the Make first, then its Models, as 'Policy run' rows for Reliance", async () => {
  const db = fakeDb();
  const res = await lib.saveModels(
    db,
    [
      { make: "HONDA", model: "UNICORN 160", portalValue: "HONDA | unicorn | 160" },
      { make: "HONDA", model: "DIO 125", portalValue: "HONDA | DIO | 125" },
    ],
    { now: () => new Date("2026-11-14T00:00:00Z") }
  );
  assert.deepEqual(res, { makesAdded: 1, modelsAdded: 2, modelsAlreadyThere: 0 });
  assert.equal(db.calls[0][0], "insurerMake", "the Make row is written before its models");
  assert.deepEqual(db.store.insurerMake[0], {
    company: "Reliance", make: "HONDA", makeKey: "HONDA", portalValue: "", isEnabled: true, source: "automation", createdAt: new Date("2026-11-14T00:00:00Z"),
  });
  const m = db.store.insurerModel.find((d) => d.model === "UNICORN 160");
  assert.equal(m.company, "Reliance");
  assert.equal(m.make, "HONDA");
  assert.equal(m.modelKey, "UNICORN 160");
  assert.equal(m.portalValue, "HONDA | unicorn | 160", "what Reliance printed is kept for reference");
  assert.equal(m.source, "automation");
  assert.equal(db.calls.find((c) => c[1] === "insertMany")[2].ordered, false);
  // never a Variant: this code has no way to reach that collection
  assert.equal(Object.keys(db.store).includes("insurerVariant"), false);
});

test("saving: what is already there is skipped - never changed, never twice; the rest is still saved", async () => {
  const db = fakeDb({
    makes: [{ company: "Reliance", makeKey: "HONDA", make: "HONDA", source: "manual" }],
    models: [{ company: "Reliance", makeKey: "HONDA", modelKey: "DIO 125", model: "DIO 125", source: "manual", portalValue: "kept" }],
  });
  const res = await lib.saveModels(db, [
    { make: "honda", model: "dio  125" }, // the same name, another spelling
    { make: "HONDA", model: "UNICORN 160" },
  ]);
  assert.deepEqual(res, { makesAdded: 0, modelsAdded: 1, modelsAlreadyThere: 1 });
  assert.equal(db.store.insurerMake.length, 1);
  assert.equal(db.store.insurerModel.length, 2);
  assert.equal(db.store.insurerModel[0].portalValue, "kept", "an existing row is not touched");
  assert.equal(db.store.insurerModel[0].source, "manual");
  // running the same set again adds nothing
  const again = await lib.saveModels(db, [{ make: "HONDA", model: "UNICORN 160" }]);
  assert.deepEqual(again, { makesAdded: 0, modelsAdded: 0, modelsAlreadyThere: 1 });
});

test("saving: a model with a bar in it is never written", async () => {
  const db = fakeDb();
  const res = await lib.saveModels(db, [{ make: "HONDA", model: "UNICORN | 160" }, { make: "HONDA", model: "SHINE" }]);
  assert.equal(res.modelsAdded, 1);
  assert.equal(db.store.insurerModel.some((d) => d.model.includes("|")), false);
});

test("saving: another database error is not hidden", async () => {
  const db = fakeDb();
  db.collection = () => ({
    async insertOne() { throw Object.assign(new Error("not authorized"), { code: 13 }); },
  });
  await assert.rejects(lib.saveModels(db, [{ make: "HONDA", model: "X" }]), /not authorized/);
});

// ---- reading the list in the page (fake driver) ------------------------------------------------------------------

/** A Kendo-like list that draws 10 lines at a time (a virtual list): scrolling moves the window. */
function fakeDriver(allLines, { emptyAtFirst = 0, staleLines = null, staleReads = 0, keepOpenWhenEmpty = false, keepScroll = false, startPos = 0 } = {}) {
  let typed = "";
  let topCalls = 0;
  let pos = startPos; // first visible line
  let reads = 0;
  let readsSinceTyping = 0;
  const WINDOW = 10;
  const input = {
    async click() {},
    async sendKeys(text) { typed += text; readsSinceTyping = 0; },
  };
  // staleLines: the previous search's list, still showing for `staleReads` looks after the new typing (Reliance fills the
  // list a moment later); keepOpenWhenEmpty: the old list is still on screen even with an emptied box
  const visible = () => {
    if (staleLines && typed) {
      readsSinceTyping += 1;
      if (readsSinceTyping <= staleReads) return staleLines.slice(0, WINDOW);
    }
    if (staleLines && !typed && keepOpenWhenEmpty) return staleLines.slice(0, WINDOW);
    return typed ? allLines.slice(pos, pos + WINDOW) : [];
  };
  return {
    typed: () => typed,
    topCalls: () => topCalls,
    input,
    async wait(condition) { return input; },
    async sleep() {},
    async executeScript(script, ...args) {
      if (script.includes("scrollIntoView")) return null;
      if (script.includes("value = ''")) { typed = ""; if (!keepScroll) pos = 0; return null; }
      if (script.includes("scrollTop = 0")) { pos = 0; topCalls += 1; return { found: true, top: true }; }
      if (script.includes("dispatchEvent")) return null;
      if (script.includes("scrollTop")) {
        pos = Math.min(Math.max(0, allLines.length - WINDOW), pos + 8);
        return { found: true, atBottom: pos >= allLines.length - WINDOW };
      }
      if (script.includes("out.push")) {
        reads += 1;
        if (reads <= emptyAtFirst) return [];
        return visible();
      }
      throw new Error("unexpected script " + script.slice(0, 40));
    },
  };
}

test("collecting: a long list is read to its end by scrolling, each line once, then the box is emptied", async () => {
  const lines = [];
  for (let i = 1; i <= 57; i++) lines.push(`HONDA | MODEL${i} | ${100 + i}`);
  lines.push("TVS | HONDA CLONE | 100"); // another make's line in the same list
  lines.push("HONDA UNICORN"); // no bar
  const driver = fakeDriver(lines);
  const out = await lib.collectModelsForMake(driver, "honda", { listWaitMs: 1000 });
  assert.equal(out.lines, 59, "every line of the list was read");
  assert.equal(out.models.length, 57);
  assert.deepEqual(out.models[0], { make: "HONDA", model: "MODEL1 101", portalValue: "HONDA | MODEL1 | 101" });
  assert.equal(out.skipped.length, 2);
  assert.equal(driver.typed(), "", "the box is emptied at the end, nothing was picked");
});

test("collecting: the OLD list still on screen is never read as the new Make's (the owner's live log: SUZUKI, YAMAHA, BAJAJ all read HONDA's 680 lines)", async () => {
  const hondaList = [];
  for (let i = 1; i <= 25; i++) hondaList.push(`HONDA | MODEL${i} | CC/WATT ${100 + i}`);
  const suzukiList = [];
  for (let i = 1; i <= 25; i++) suzukiList.push(`SUZUKI | ACCESS${i} | CC/WATT ${100 + i}`);
  // the new list comes 6 looks after the typing; the old one is also still open when the box is emptied
  const driver = fakeDriver(suzukiList, { staleLines: hondaList, staleReads: 6, keepOpenWhenEmpty: true });
  const out = await lib.collectModelsForMake(driver, "suzuki", { listWaitMs: 8000 });
  assert.equal(out.lines, 25, "only SUZUKI's own lines were read");
  assert.equal(out.models.length, 25);
  assert.equal(out.models.every((m) => m.make === "SUZUKI"), true);
  assert.equal(out.skipped.length, 0, "no HONDA line was even looked at");
});

test("collecting: a list that never turns into the new search is reported as nothing, not saved from the old one", async () => {
  const stale = ["HONDA | ACTIVA | 125 | CC/WATT 125", "HONDA | DIO | CC/WATT 109"];
  const driver = fakeDriver(["BAJAJ | PULSAR | 150"], { staleLines: stale, staleReads: 1000000, keepOpenWhenEmpty: true });
  const out = await lib.collectModelsForMake(driver, "bajaj", { listWaitMs: 1500 });
  assert.equal(out.lines, 0);
  assert.deepEqual(out.models, []);
});

test("collecting: a list left scrolled DOWN by the search before is brought back to the top first, so the top lines are not lost (owner's live run)", async () => {
  const lines = [];
  for (let i = 1; i <= 60; i++) lines.push(`YAMAHA | FZ${i} | CC/WATT ${100 + i}`);
  // the new list opens where the old one was left: 40 lines down
  const driver = fakeDriver(lines, { keepScroll: true, startPos: 40 });
  const out = await lib.collectModelsForMake(driver, "yamaha", { listWaitMs: 5000 });
  assert.equal(out.lines, 60, "the lines above the starting place were read too");
  assert.equal(out.models.length, 60);
  assert.ok(out.models.some((m) => m.model === "FZ1 CC/WATT 101"), "the first line of the list is there");
  assert.ok(driver.topCalls() >= 1, "the list was scrolled to its top");
});

test("collecting: two lines that become one name are one model", async () => {
  const driver = fakeDriver(["HONDA | CB | 150", "HONDA | CB 150"]);
  const out = await lib.collectModelsForMake(driver, "HONDA", { listWaitMs: 1000 });
  assert.equal(out.lines, 2);
  assert.equal(out.models.length, 1);
});

test("collecting: a slow list (empty at first) is waited for; a list that never comes is reported as no lines", async () => {
  const slow = fakeDriver(["YAMAHA | FZ | S"], { emptyAtFirst: 2 });
  const got = await lib.collectModelsForMake(slow, "yamaha", { listWaitMs: 5000 });
  assert.equal(got.models.length, 1);

  const none = fakeDriver([]);
  const empty = await lib.collectModelsForMake(none, "zzz", { listWaitMs: 50 });
  assert.equal(empty.lines, 0);
  assert.deepEqual(empty.models, []);
});

// ---- the customer data the run walks through ---------------------------------------------------------------------

test("the run's data has the customer and the login but nothing that points back at the policy", () => {
  const policy = {
    _id: "p1", userId: "u1", clientId: "c1", fullName: "ANMOL", surname: "ARORA", dateOfBirth: "2000-01-01", state: "tamilnadu",
    pincode: "600001", mobileNumber: "9876543210", flatDoorNo: "1", relianceStages: { proposal: { status: "completed" } },
    walletPayment: { state: "issued" }, proposalNumber: "P-1",
  };
  const data = lib.buildCollectorData(policy, { username: "U", password: "P", loginUrl: "https://x" }, { formatDate: (d) => `fmt:${d}` });
  assert.equal(data.firstName, "ANMOL");
  assert.equal(data.lastName, "ARORA");
  assert.equal(data.dob, "fmt:2000-01-01");
  assert.equal(data.customerState, "tamilnadu");
  assert.equal(data.username, "U");
  for (const key of ["_id", "policyId", "_jobId", "relianceStages", "walletPayment", "proposalNumber", "proposal_number"]) {
    assert.equal(key in data, false, `${key} must not be in the run's data`);
  }
});

// ---- the script ---------------------------------------------------------------------------------------------------

test("the script: arguments", () => {
  const { parseArgs } = require("../scripts/relianceCollectModels");
  const ok = parseArgs(["--policy", "0123456789abcdef01234567", "honda", "Hero", "HONDA", "hero motocorp"]);
  assert.deepEqual(ok, { policy: "0123456789abcdef01234567", makes: ["HONDA", "HERO", "HERO MOTOCORP"] });
  assert.match(parseArgs(["honda"]).error, /which policy/);
  assert.match(parseArgs(["--policy", "abc", "honda"]).error, /not a policy id/);
  assert.match(parseArgs(["--policy", "0123456789abcdef01234567"]).error, /which makes/);
  assert.match(parseArgs(["--nope"]).error, /Unknown option/);
});

test("the script never writes to the policy and never saves a Variant", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "relianceCollectModels.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate/.test(code), false);
  assert.equal(/insurerVariant/.test(code), false);
  assert.equal(/process\.env\.[A-Z_]*ENABLED/.test(code), false, "no new .env switch");
});

test("the Reliance flow's collector hook is before the make/model fill and returns, so nothing is chosen or saved after it", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
  const hook = src.indexOf('typeof data.collectMakeModels === "function"');
  const fill = src.indexOf('console.log("Filling vehicle make/model...")');
  const validate = src.indexOf('console.log("Customer validation attempted!")');
  assert.ok(validate > 0 && validate < hook && hook < fill, "login, customer and Validate Customer come first, then the hook, then the normal fill");
});

test("searching hero lists three makes' lines; only HERO's own are saved, the others are counted by make", async () => {
  const lines = [
    "HERO | SPLENDOR | CC/WATT 100",
    "HERO | PASSION | CC/WATT 110",
    "HERO HONDA | ACHIEVER | 150 | CC/WATT 150",
    "HERO MOTOCORP | ACHIEVER | 150 | CC/WATT 150",
    "HERO MOTOCORP | I3 S | CC/WATT 97",
    "HONDA | HERO ACTIVA | CC/WATT 110", // another make whose model has the word hero in it
  ];
  const out = await lib.collectModelsForMake(fakeDriver(lines.filter((l) => l.toUpperCase().includes("HERO"))), "hero", { listWaitMs: 2000 });
  assert.deepEqual(out.models.map((m) => m.make), ["HERO", "HERO"]);
  assert.deepEqual(out.models.map((m) => m.model), ["SPLENDOR CC/WATT 100", "PASSION CC/WATT 110"]);
  assert.deepEqual(out.otherMakes, { "HERO HONDA": 1, "HERO MOTOCORP": 2, HONDA: 1 });
  // each of the three, asked by name, gets its own lines (Reliance's list shows the lines that contain what was typed)
  const listFor = (text) => lines.filter((l) => l.replace(/\|/g, " ").replace(/\s+/g, " ").toUpperCase().includes(text.toUpperCase()));
  const motocorp = await lib.collectModelsForMake(fakeDriver(listFor("hero motocorp")), "hero motocorp", { listWaitMs: 2000 });
  assert.deepEqual(motocorp.models.map((m) => m.make), ["HERO MOTOCORP", "HERO MOTOCORP"]);
  const honda = await lib.collectModelsForMake(fakeDriver(listFor("hero honda")), "hero honda", { listWaitMs: 2000 });
  assert.deepEqual(honda.models.map((m) => m.make), ["HERO HONDA"]);
});

test("saving: the same model name under HERO HONDA and HERO MOTOCORP is two rows; a re-run adds nothing", async () => {
  const db = fakeDb();
  const set = [
    { make: "HERO HONDA", model: "ACHIEVER 150 CC/WATT 150" },
    { make: "HERO MOTOCORP", model: "ACHIEVER 150 CC/WATT 150" },
  ];
  assert.deepEqual(await lib.saveModels(db, set), { makesAdded: 2, modelsAdded: 2, modelsAlreadyThere: 0 });
  assert.deepEqual(await lib.saveModels(db, set), { makesAdded: 0, modelsAdded: 0, modelsAlreadyThere: 2 });
  assert.equal(db.store.insurerModel.length, 2);
});

test("the Make-alone retry never takes 'the first suggestion' when no line matches (that would be another vehicle)", () => {
  for (const file of [["fullPolicycompany", "relianceForm.js"], ["multiCompany", "common", "reliance", "relianceMultiForm.js"]]) {
    const src = fs.readFileSync(path.join(__dirname, "..", ...file), "utf8");
    assert.match(src, /return arguments\[2\] \? null : firstVisible;/, file.join("/"));
    assert.match(src, /typedText !== searchText\n/, file.join("/"));
  }
});

test("saveModels with another pair of collections writes only there (National's 'Not able to Find' lists); the default is unchanged", async () => {
  const written = [];
  const fake = (name) => ({
    async insertOne(doc) { written.push([name, "insertOne", doc.make]); },
    async insertMany(docs) { written.push([name, "insertMany", docs.length]); return { insertedCount: docs.length }; },
  });
  const db = { collection: (name) => fake(name) };
  await lib.saveModels(db, [{ make: "HONDA", model: "DIO" }]);
  assert.deepEqual(written.map((w) => w[0]), ["insurerMake", "insurerModel"], "the default lists");
  written.length = 0;
  await lib.saveModels(db, [{ make: "HONDA", model: "DIO" }], { company: "National", collections: { make: "insurerMakeNotFound", model: "insurerModelNotFound" } });
  assert.deepEqual(written.map((w) => w[0]), ["insurerMakeNotFound", "insurerModelNotFound"]);
});
