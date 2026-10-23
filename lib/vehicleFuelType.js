/**
 * The fuel type of the policy's vehicle, for the Reliance OD form (2026-10-23).
 *
 * Reliance's own-damage form has a Fuel Type box that the new-vehicle (bundled) form fills by itself, so the full-company
 * flow never touched it and the OD run left it empty ("it miss the fuel type"). The value is the one the operator chose
 * with the vehicle: the Make & Model master row has a `fuelType` (required on every row). The job data does not carry it,
 * and the Online Policy keeps only the row's id (`makeModel`), so it is read here, at run time, from that exact row —
 * never guessed here (the form's step maps it to Reliance's own list, relianceOdSteps.js chooseFuelOption; LPG / CNG become Petrol).
 *
 * Looked up BEFORE any window opens (relianceMultiForm.js [MC] 10): a data problem is reported at once, with a plain
 * sentence, instead of after a login, a captcha and a filled form. A problem with the DATA is not retried (a re-run cannot
 * mend it, the operator fixes the master); a database that could not be read is (a plain error: the queue retries).
 *
 * Order of sources:
 *   1. data.fuelType — when the job itself carries it (nothing writes it today; the way a later backend change can).
 *   2. the policy's Make & Model master row, by the id the policy was sold with (`onlinePolicy.makeModel`).
 *   3. a policy whose `makeModel` is not an id (an old document): the master rows with EXACTLY its make, model, CC and
 *      variant — used only when they all agree on one fuel type; two different fuel types is an error, not a pick.
 *
 * Everything takes the Mongo client and the logger as arguments, so it is tested with fakes. Operator sentences carry ONE
 * colon, right after the label (lib/errorHandler.js beautifyError keeps only the text after the last one).
 */
const LABEL = "Reliance OD";

const clean = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();

/** An ObjectId from an ObjectId, a 24-hex string or { $oid }; anything else is returned as it came. */
function toId(value) {
  const raw = value && typeof value === "object" && value.$oid ? value.$oid : value;
  if (typeof raw === "string" && /^[0-9a-f]{24}$/i.test(raw)) {
    try {
      const { ObjectId } = require("mongodb");
      return new ObjectId(raw);
    } catch (e) {
      return raw;
    }
  }
  return raw;
}

/** The policy id a job carries (its own _id, else policyId). */
const policyIdOf = (data) => toId(data && (data._id || data.policyId));

/**
 * Why a fuel type could not be had. `retryable` = a re-run may work by itself (a database that could not be read);
 * otherwise a person has to change something first.
 */
class FuelTypeError extends Error {
  constructor(message, { retryable = false, reason = "" } = {}) {
    super(message);
    this.name = "FuelTypeError";
    this.reason = reason;
    // lib/partRunner.js reads `retryable: false` from the failure the form returns; the Reliance form's catch adds it for
    // an error that carries nonRetryable (the same way TitleError does).
    if (!retryable) this.nonRetryable = true;
  }
}

async function withDb(MongoClient, work) {
  const Client = MongoClient || require("mongodb").MongoClient;
  const client = new Client(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    return await work(client.db());
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * The fuel type of this job's policy vehicle.
 *
 * @param {Object} data           the job data (policy id in _id / policyId; fuelType when the job carries it)
 * @param {Object} [o]
 * @param {Function} [o.MongoClient]  a Mongo client class (tests pass a fake)
 * @returns {Promise<{fuelType:string, source:string, vehicle:string}>}   throws FuelTypeError
 */
async function resolveVehicleFuelType(data, { MongoClient } = {}) {
  const fromJob = clean(data && data.fuelType);
  if (fromJob) return { fuelType: fromJob, source: "the job", vehicle: "" };

  const policyId = policyIdOf(data);
  if (!policyId) {
    throw new FuelTypeError(
      `${LABEL}: the job does not say which policy it belongs to, so the fuel type of its vehicle could not be looked up. Run the policy again from the Online Policy list.`,
      { reason: "no-policy" }
    );
  }

  let found;
  try {
    found = await withDb(MongoClient, async (db) => {
      const policy = await db
        .collection("onlinePolicy")
        .findOne({ _id: policyId }, { projection: { makeModel: 1, vehicleMake: 1, vehicleModel: 1, vehicleCC: 1, vehicleVariant: 1 } });
      if (!policy) return { policy: null };
      const rowId = toId(clean(policy.makeModel));
      const isId = rowId && typeof rowId === "object";
      if (isId) {
        const row = await db.collection("makeModel").findOne({ _id: rowId }, { projection: { fuelType: 1, make: 1, model: 1, cc: 1, vehicleVariant: 1 } });
        return { policy, rows: row ? [row] : [], by: "id" };
      }
      // an old policy: the master rows that match the vehicle EXACTLY (no fuzzy match)
      const query = { make: new RegExp(`^${escapeRegExp(clean(policy.vehicleMake))}$`, "i"), model: new RegExp(`^${escapeRegExp(clean(policy.vehicleModel))}$`, "i") };
      if (clean(policy.vehicleCC)) query.cc = String(clean(policy.vehicleCC));
      const rows = await db.collection("makeModel").find(query, { projection: { fuelType: 1, make: 1, model: 1, cc: 1, vehicleVariant: 1 } }).toArray();
      const variant = clean(policy.vehicleVariant).toLowerCase();
      return { policy, rows: rows.filter((r) => clean(r.vehicleVariant).toLowerCase() === variant), by: "vehicle" };
    });
  } catch (e) {
    // the cause stays in the console; the sentence never carries the driver's own words
    console.log(`[vehicleFuelType] could not read the database: ${(e && e.message) || e}`);
    throw new FuelTypeError(
      `${LABEL}: the database could not be read for the fuel type of the policy's vehicle, so the run stopped before opening the portal. It is tried again by itself.`,
      { retryable: true, reason: "read-failed" }
    );
  }

  if (!found.policy) {
    throw new FuelTypeError(`${LABEL}: the policy was not found, so the fuel type of its vehicle could not be looked up.`, { reason: "policy-missing" });
  }
  const vehicle = [found.policy.vehicleMake, found.policy.vehicleModel, found.policy.vehicleVariant].map(clean).filter(Boolean).join(" ");
  if (!found.rows.length) {
    throw new FuelTypeError(
      `${LABEL}: the Make and Model row this policy was sold with (${vehicle || "no vehicle name"}) is not in the master any more, so its fuel type is not known. Check the vehicle in Master then Make and Model, then run the policy again.`,
      { reason: "row-missing" }
    );
  }
  const types = [...new Set(found.rows.map((r) => clean(r.fuelType)).filter(Boolean))];
  if (types.length === 0) {
    throw new FuelTypeError(
      `${LABEL}: the Make and Model row of ${vehicle || "this vehicle"} has no fuel type. Set it in Master then Make and Model, then run the policy again.`,
      { reason: "row-has-no-fuel-type" }
    );
  }
  if (types.length > 1) {
    throw new FuelTypeError(
      `${LABEL}: the master has ${found.rows.length} rows for ${vehicle || "this vehicle"} with different fuel types (${types.join(", ")}), so it is not known which one this policy was sold with. Edit the policy and pick the vehicle again.`,
      { reason: "ambiguous" }
    );
  }
  return { fuelType: types[0], source: found.by === "id" ? "the vehicle's Make and Model row" : "the master rows matching the vehicle", vehicle };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The form's call (relianceMultiForm.js [MC] 10): the fuel type, or a FuelTypeError, with the progress in the log.
 */
async function requireVehicleFuelType(data, { jobId = "", log = (line) => console.log(line), MongoClient } = {}) {
  const tag = jobId ? `[${jobId}] ` : "";
  const resolved = await resolveVehicleFuelType(data, { MongoClient });
  log(`${tag}⛽ Fuel type of the vehicle${resolved.vehicle ? ` (${resolved.vehicle})` : ""} is "${resolved.fuelType}", from ${resolved.source}.`);
  return resolved.fuelType;
}

module.exports = { resolveVehicleFuelType, requireVehicleFuelType, FuelTypeError, policyIdOf, toId };
