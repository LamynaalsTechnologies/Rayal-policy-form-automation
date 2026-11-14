// Run with: node --require ./test/support/noRealWorld.js --test test/pincodeLocalitySave.test.js
//
// The owner's request (2026-11-14): when KSHEMA's "Pin code Locality" dropdown opens, every locality it lists is saved in the
// Pincode & Locality master - insert only (no duplicate, no overwrite) - and a failed or slow save never touches the run.
// No browser, no network, no database here: a fake database and a fake page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const lib = require("../lib/pincodeLocalitySave");
const section = require("../fullPolicycompany/kshema/kshemaSection");
const FORMS = {
  full: require("../fullPolicycompany/kshema/kshemaQuoteForm"),
  "TP only": require("../multiCompany/tpCompany/kshemaTP/kshemaTPQuoteForm"),
};
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ---- a fake database with the unique index (pincode + localityKey) -------------------------------------------------------

function fakeDb({ failWith = null, slowMs = 0 } = {}) {
  const store = [];
  const calls = [];
  return {
    store,
    calls,
    collection(name) {
      assert.equal(name, "pincodeLocality");
      return {
        async insertMany(docs, opts) {
          calls.push({ method: "insertMany", docs, opts });
          if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
          if (failWith) throw failWith;
          const writeErrors = [];
          let insertedCount = 0;
          docs.forEach((d, index) => {
            if (store.some((s) => s.pincode === d.pincode && s.localityKey === d.localityKey)) writeErrors.push({ index, code: 11000 });
            else {
              store.push(d);
              insertedCount += 1;
            }
          });
          if (writeErrors.length) {
            const error = new Error("E11000 duplicate key");
            error.code = 11000;
            error.writeErrors = writeErrors;
            error.result = { insertedCount };
            throw error;
          }
          return { insertedCount };
        },
        async updateOne() {
          throw new Error("an update must never be called");
        },
        async updateMany() {
          throw new Error("an update must never be called");
        },
        async replaceOne() {
          throw new Error("a replace must never be called");
        },
        async deleteMany() {
          throw new Error("a delete must never be called");
        },
      };
    },
  };
}

const NAMES = ["MELOLAKKUR", "VILLUPURAM", "TONDUR"];

// ---- the save ---------------------------------------------------------------------------------------------------------

test("every locality of the pin code is saved with the master's fields", async () => {
  const db = fakeDb();
  const out = await lib.saveLocalities(db, { pincode: "604203", names: NAMES }, { now: () => new Date("2026-11-14T00:00:00Z") });
  assert.deepEqual(out, { added: 3, alreadyThere: 0, skipped: null });
  assert.deepEqual(db.store[0], {
    pincode: "604203",
    locality: "MELOLAKKUR",
    localityKey: "MELOLAKKUR",
    isEnabled: true,
    source: "automation",
    sourceCompany: "KSHEMA",
    createdAt: new Date("2026-11-14T00:00:00Z"),
  });
  assert.equal(db.calls[0].opts.ordered, false);
});

test("insert only: a second run adds nothing, and the first rows are not touched", async () => {
  const db = fakeDb();
  await lib.saveLocalities(db, { pincode: "604203", names: NAMES }, { now: () => new Date("2026-01-01") });
  const before = JSON.stringify(db.store);
  const out = await lib.saveLocalities(db, { pincode: "604203", names: [...NAMES, "NEW PLACE"] }, { now: () => new Date("2027-01-01") });
  assert.deepEqual(out, { added: 1, alreadyThere: 3, skipped: null }, "only the new name is added, the rest is 'already there'");
  assert.equal(JSON.stringify(db.store.slice(0, 3)), before, "no old row changed");
  assert.equal(db.store.length, 4);
});

test("the same name under another pin code is a different row", async () => {
  const db = fakeDb();
  await lib.saveLocalities(db, { pincode: "604203", names: ["TONDUR"] });
  const out = await lib.saveLocalities(db, { pincode: "605001", names: ["TONDUR"] });
  assert.equal(out.added, 1);
});

test("names are cleaned, de-duplicated in the batch, blanks and over-long names dropped, at most MAX_NAMES", async () => {
  const db = fakeDb();
  const many = Array.from({ length: 300 }, (_, i) => `Place ${i}`);
  const out = await lib.saveLocalities(db, { pincode: " 604203 ", names: ["  melolakkur ", "MELOLAKKUR", "", null, "X".repeat(151), ...many] });
  assert.equal(out.added, lib.MAX_NAMES);
  assert.equal(db.store[0].locality, "MELOLAKKUR");
  assert.equal(db.store.filter((d) => d.locality === "MELOLAKKUR").length, 1);
  assert.equal(db.store.some((d) => d.locality.length > lib.MAX_NAME_LENGTH), false);
});

test("a pin code that is not six digits, or no names: nothing is written", async () => {
  const db = fakeDb();
  for (const pincode of ["", "6042", "6042031", "ABCDEF", undefined]) {
    const out = await lib.saveLocalities(db, { pincode, names: NAMES });
    assert.equal(out.added, 0);
    assert.match(out.skipped, /six digits/);
  }
  assert.match((await lib.saveLocalities(db, { pincode: "604203", names: ["", null] })).skipped, /no usable names/);
  assert.equal(db.calls.length, 0);
});

test("an error that is not a duplicate is raised by saveLocalities (rememberLocalities is what swallows it)", async () => {
  await assert.rejects(lib.saveLocalities(fakeDb({ failWith: new Error("not authorized") }), { pincode: "604203", names: NAMES }), /not authorized/);
});

test("the names are kept the way the backend keeps them", () => {
  const theirs = require("../../RayalBrokers-backend/shared/insurerVehicleList");
  const { cleanName } = require("../lib/relianceModelCollect");
  for (const sample of ["melolakkur", "  VILLUPURAM   (S.O) ", "A&amp;B  NAGAR", "tondur&nbsp;x", "<b>X</b> y"]) {
    assert.equal(cleanName(sample), theirs.cleanName(sample), JSON.stringify(sample));
  }
});

// ---- rememberLocalities: never fails, never waits long -----------------------------------------------------------------

const logs = () => {
  const lines = { log: [], warn: [] };
  return { lines, deps: { log: (m) => lines.log.push(m), warn: (m) => lines.warn.push(m) } };
};

test("rememberLocalities saves and logs one line", async () => {
  const db = fakeDb();
  const { lines, deps } = logs();
  const out = await lib.rememberLocalities("604203", NAMES, { ...deps, getDb: () => db });
  assert.equal(out.added, 3);
  assert.equal(lines.log.length, 1);
  assert.match(lines.log[0], /604203.*3 new locality name\(s\) saved \(0 already saved\)/);
});

test("rememberLocalities: no database (a hand-run script) = quietly nothing", async () => {
  const { lines, deps } = logs();
  assert.equal(await lib.rememberLocalities("604203", NAMES, { ...deps, getDb: () => null }), null);
  assert.deepEqual(lines, { log: [], warn: [] });
});

test("rememberLocalities: a database error is one warning and no throw", async () => {
  const { lines, deps } = logs();
  const out = await lib.rememberLocalities("604203", NAMES, { ...deps, getDb: () => fakeDb({ failWith: new Error("connection lost\nmore") }) });
  assert.equal(out, null);
  assert.equal(lines.warn.length, 1);
  assert.match(lines.warn[0], /could not be saved \(connection lost\)/);
});

test("rememberLocalities: a getDb that throws is one warning and no throw", async () => {
  const { lines, deps } = logs();
  assert.equal(await lib.rememberLocalities("604203", NAMES, { ...deps, getDb: () => { throw new Error("boom"); } }), null);
  assert.equal(lines.warn.length, 1);
});

test("rememberLocalities: a slow database is waited for only waitMs", async () => {
  const { lines, deps } = logs();
  const started = Date.now();
  const out = await lib.rememberLocalities("604203", NAMES, { ...deps, getDb: () => fakeDb({ slowMs: 400 }), waitMs: 30 });
  assert.equal(out, null);
  assert.ok(Date.now() - started < 300, "returned long before the slow write finished");
  assert.match(lines.warn[0], /not saved yet/);
});

// ---- the field's wiring ------------------------------------------------------------------------------------------------

for (const [name, form] of Object.entries(FORMS)) {
  test(`${name}: only the Pin code Locality dropdown hands its list on`, async () => {
    const seen = {};
    const handlers = {
      typeIntoField: async () => ({ ok: true, value: "x", reason: null }),
      selectMatOption: async (driver, selectors, value, label, opts) => {
        seen[label] = opts.onOptionsRead;
        return { ok: true, value: "x", reason: null };
      },
    };
    const fields = form.CUSTOMER_FIELDS.filter((f) => f.type === "select");
    assert.ok(fields.some((f) => f.key === "locality"), "the locality field is a select");
    const quiet = ["log", "warn", "error"].map((k) => [k, console[k]]);
    quiet.forEach(([k]) => (console[k] = () => {}));
    try {
      await section.fillSection({ async sleep() {} }, { pinCode: "604203", areaAndLocality: "MELOLAKKUR", firstName: "RAVI", mobileNumber: "9876543210" }, fields, "customer details", null, {
        handlers,
        readState: async () => null,
        waitForLoader: async () => {},
        readToast: async () => null,
      });
    } finally {
      quiet.forEach(([k, f]) => (console[k] = f));
    }
    assert.equal(typeof seen["Pin code Locality"], "function");
    for (const [label, hook] of Object.entries(seen)) if (label !== "Pin code Locality") assert.equal(hook, null, `${label} has no hook`);
    // with no database connected (a test, a hand-run script) the hook is quietly nothing
    assert.equal(await seen["Pin code Locality"](["A", "B"]), null);
  });
}

// ---- the hook sits where it must: after the list is read, before any matching; and it cannot end the pick ------------------

test("selectMatOption hands the list on after reading it and before matching, inside a try / catch", () => {
  const src = codeOf(read("fullPolicycompany", "kshema", "kshemaFields.js"));
  const fn = src.slice(src.indexOf("async function selectMatOption"));
  const read1 = fn.indexOf("let seen = await readOptionTexts(options);");
  const hook = fn.indexOf("await onOptionsRead(seen.filter(Boolean));");
  const match = fn.indexOf("if (fuzzy) {");
  assert.ok(read1 > 0 && hook > read1 && match > hook, `order read ${read1} < hook ${hook} < match ${match}`);
  const around = fn.slice(hook - 120, hook + 260);
  assert.match(around, /try \{\s*await onOptionsRead[\s\S]*?\} catch \(e\) \{\s*if \(isAutomationStop\(e\)\) throw e;/);
});

test("the two quote forms are not touched by this feature (the drift-guarded pair)", () => {
  for (const file of [["fullPolicycompany", "kshema", "kshemaQuoteForm.js"], ["multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"]]) {
    const src = read(...file);
    assert.equal(/pincodeLocality|rememberLocalities|onOptionsRead/.test(src), false, file.join("/"));
  }
});

test("the save has no update, replace or delete call", () => {
  const src = codeOf(read("lib", "pincodeLocalitySave.js"));
  assert.equal(/updateOne|updateMany|replaceOne|findOneAndUpdate|bulkWrite|deleteOne|deleteMany|\$set|upsert/.test(src), false);
  assert.match(src, /insertMany\(docs, \{ ordered: false \}\)/);
});
