// Run with: node --require ./test/support/noRealWorld.js --test test/vehicleFuelType.test.js
//
// Reliance OD's form has a Fuel Type box the new-vehicle form fills by itself ("it miss the fuel type", 2026-10-23). The
// value is the one on the policy vehicle's Make & Model master row (lib/vehicleFuelType.js): read from THAT row, by the id
// the policy was sold with, before any window opens — never guessed, never defaulted. A data problem is not retried (a
// re-run cannot mend it), a database that cannot be read is. Fake Mongo client: no database, no network.
const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveVehicleFuelType, requireVehicleFuelType, FuelTypeError } = require("../lib/vehicleFuelType");

const ID = "64b0c0ffee0000000000aa01"; // a policy
const ROW = "64b0c0ffee0000000000bb01"; // a Make & Model master row

/**
 * A stand-in for the mongodb client class: `onlinePolicy` and `makeModel` collections over plain arrays.
 * `calls` records what was asked, so a test can prove a source was NOT touched.
 */
function fakeMongo({ policies = [], rows = [], failWith = null } = {}) {
  const calls = [];
  class FakeClient {
    constructor(uri) {
      calls.push(["new", uri === undefined ? "no uri" : "uri"]);
    }
    async connect() {
      calls.push(["connect"]);
      if (failWith) throw new Error(failWith);
    }
    db() {
      return {
        collection: (name) => ({
          async findOne(filter) {
            calls.push(["findOne", name, String(filter._id)]);
            const list = name === "onlinePolicy" ? policies : rows;
            return list.find((r) => String(r._id) === String(filter._id)) || null;
          },
          find(query) {
            calls.push(["find", name]);
            const match = rows.filter(
              (r) => query.make.test(r.make) && query.model.test(r.model) && (query.cc === undefined || String(r.cc) === String(query.cc))
            );
            return { toArray: async () => match };
          },
        }),
      };
    }
    async close() {
      calls.push(["close"]);
    }
  }
  return { MongoClient: FakeClient, calls };
}

const policy = (over = {}) => ({
  _id: ID,
  makeModel: ROW,
  vehicleMake: "HONDA",
  vehicleModel: "DIO",
  vehicleCC: 125,
  vehicleVariant: "125 SMART OBD2B",
  ...over,
});
const row = (over = {}) => ({ _id: ROW, make: "HONDA", model: "DIO", cc: "125", vehicleVariant: "125 SMART OBD2B", fuelType: "PETROL", ...over });
const oneColon = (message) => message.split(":").length - 1 === 1;

/** The error a call throws (the test fails when it does not throw). */
async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  assert.fail("expected an error");
}

test("the job's own fuel type wins and the database is never touched", async () => {
  const { MongoClient, calls } = fakeMongo();
  const r = await resolveVehicleFuelType({ _id: ID, fuelType: "  Diesel " }, { MongoClient });
  assert.deepEqual(r, { fuelType: "Diesel", source: "the job", vehicle: "" });
  assert.deepEqual(calls, []);
});

test("the policy's own Make and Model row, by the id it was sold with — the value as the row has it", async () => {
  const { MongoClient, calls } = fakeMongo({ policies: [policy()], rows: [row({ fuelType: "PETROL" })] });
  const r = await resolveVehicleFuelType({ _id: ID }, { MongoClient });
  assert.equal(r.fuelType, "PETROL");
  assert.equal(r.source, "the vehicle's Make and Model row");
  assert.equal(r.vehicle, "HONDA DIO 125 SMART OBD2B");
  assert.deepEqual(calls.filter((c) => c[0] === "findOne").map((c) => [c[1], c[2]]), [["onlinePolicy", ID], ["makeModel", ROW]]);
  assert.ok(calls.some((c) => c[0] === "close"), "the connection is closed");
});

test("the policy id may arrive as an ObjectId, a string or { $oid }", async () => {
  const { ObjectId } = require("mongodb");
  const { MongoClient } = fakeMongo({ policies: [policy()], rows: [row()] });
  for (const id of [ID, new ObjectId(ID), { $oid: ID }]) {
    assert.equal((await resolveVehicleFuelType({ _id: id }, { MongoClient })).fuelType, "PETROL");
  }
  assert.equal((await resolveVehicleFuelType({ policyId: ID }, { MongoClient })).fuelType, "PETROL", "policyId works as well");
});

test("a job that names no policy cannot be looked up: a data error, not retried", async () => {
  const { MongoClient, calls } = fakeMongo();
  const e = await failure(resolveVehicleFuelType({}, { MongoClient }));
  assert.ok(e instanceof FuelTypeError);
  assert.equal(e.reason, "no-policy");
  assert.equal(e.nonRetryable, true);
  assert.match(e.message, /^Reliance OD: the job does not say which policy it belongs to/);
  assert.ok(oneColon(e.message));
  assert.deepEqual(calls, []);
});

test("a policy that is not there, a row that is gone and a row without a fuel type are data errors with their own sentences", async () => {
  let e = await failure(resolveVehicleFuelType({ _id: ID }, fakeMongo({ policies: [], rows: [row()] })));
  assert.equal(e.reason, "policy-missing");
  assert.equal(e.nonRetryable, true);
  assert.match(e.message, /the policy was not found/);

  e = await failure(resolveVehicleFuelType({ _id: ID }, fakeMongo({ policies: [policy()], rows: [] })));
  assert.equal(e.reason, "row-missing");
  assert.equal(e.nonRetryable, true);
  assert.match(e.message, /the Make and Model row this policy was sold with \(HONDA DIO 125 SMART OBD2B\) is not in the master any more/);

  e = await failure(resolveVehicleFuelType({ _id: ID }, fakeMongo({ policies: [policy()], rows: [row({ fuelType: "  " })] })));
  assert.equal(e.reason, "row-has-no-fuel-type");
  assert.equal(e.nonRetryable, true);
  assert.match(e.message, /has no fuel type\. Set it in Master then Make and Model/);
  for (const message of [e.message]) assert.ok(oneColon(message));
});

test("an old policy whose makeModel is not an id: the master rows with EXACTLY its make, model, CC and variant", async () => {
  const old = policy({ makeModel: "HONDA - DIO" });
  const rows = [
    row({ _id: "64b0c0ffee0000000000bb02", fuelType: "PETROL" }),
    row({ _id: "64b0c0ffee0000000000bb03", fuelType: "PETROL" }), // the same fuel type twice is fine
    row({ _id: "64b0c0ffee0000000000bb04", model: "DIO", cc: "110", fuelType: "DIESEL" }), // another CC: not this vehicle
    row({ _id: "64b0c0ffee0000000000bb05", vehicleVariant: "OTHER", fuelType: "CNG" }), // another variant: not this vehicle
  ];
  const r = await resolveVehicleFuelType({ _id: ID }, fakeMongo({ policies: [old], rows }));
  assert.equal(r.fuelType, "PETROL");
  assert.equal(r.source, "the master rows matching the vehicle");
});

test("an old policy whose matching rows disagree is an error — never a pick", async () => {
  const old = policy({ makeModel: "" });
  const rows = [row({ _id: "64b0c0ffee0000000000bb02", fuelType: "PETROL" }), row({ _id: "64b0c0ffee0000000000bb03", fuelType: "CNG" })];
  const e = await failure(resolveVehicleFuelType({ _id: ID }, fakeMongo({ policies: [old], rows })));
  assert.equal(e.reason, "ambiguous");
  assert.equal(e.nonRetryable, true);
  assert.match(e.message, /the master has 2 rows for HONDA DIO 125 SMART OBD2B with different fuel types \(PETROL, CNG\)/);
  assert.ok(oneColon(e.message));
});

test("a database that cannot be read IS retried, and the driver's words stay out of the sentence", async () => {
  const lines = [];
  const saved = console.log;
  console.log = (l) => lines.push(String(l));
  let e;
  try {
    e = await failure(resolveVehicleFuelType({ _id: ID }, fakeMongo({ failWith: "connect ECONNREFUSED 10.0.0.9:27017" })));
  } finally {
    console.log = saved;
  }
  assert.ok(e instanceof FuelTypeError);
  assert.equal(e.reason, "read-failed");
  assert.equal(e.nonRetryable, undefined, "no nonRetryable flag: the queue tries again by itself");
  assert.match(e.message, /the database could not be read for the fuel type of the policy's vehicle/);
  assert.equal(/ECONNREFUSED/.test(e.message), false);
  assert.ok(oneColon(e.message));
  assert.ok(lines.some((l) => /ECONNREFUSED/.test(l)), "the cause is in the console");
});

test("requireVehicleFuelType: returns the value and says where it came from", async () => {
  const lines = [];
  const { MongoClient } = fakeMongo({ policies: [policy()], rows: [row()] });
  const fuel = await requireVehicleFuelType({ _id: ID }, { jobId: "Asha_1", log: (l) => lines.push(l), MongoClient });
  assert.equal(fuel, "PETROL");
  assert.match(lines.join("\n"), /\[Asha_1\] ⛽ Fuel type of the vehicle \(HONDA DIO 125 SMART OBD2B\) is "PETROL", from the vehicle's Make and Model row\./);
});

test("the form reads a FuelTypeError as 'do not retry' exactly like a Title error: nonRetryable becomes retryable:false", () => {
  // the Reliance form's catch adds `retryable: false` for an error that carries nonRetryable (relianceForm.js, TitleError)
  const src = require("node:fs").readFileSync(require.resolve("../fullPolicycompany/relianceForm.js"), "utf8");
  assert.match(src, /\.\.\.\(e && e\.nonRetryable === true \? \{ retryable: false \} : \{\}\)/);
});
