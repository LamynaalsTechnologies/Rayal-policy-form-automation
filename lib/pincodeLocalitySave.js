/**
 * Pincode & Locality master (2026-11-14): when KSHEMA's "Pin code Locality" dropdown opens, every locality it lists is
 * saved in the master (collection pincodeLocality, one list for every agency) - on a match AND on a "none of them
 * matched" run, so the operator can pick the saved names on the Online Policy form next time.
 *
 * Rules (the owner's, same as the vehicle lists):
 *   - insert only: a name that is already there is skipped - never updated, never saved twice;
 *   - it must never fail or slow a policy run: every problem is a log line and the run goes on, the wait is capped;
 *   - no .env switch; bounded by the unique key (pincode + name) and MAX_NAMES / MAX_NAME_LENGTH per call.
 *
 * This file has NO browser and NO database connection of its own: the Mongo `db` comes in, so the tests run on fakes
 * (test/pincodeLocalitySave.test.js). The names are kept the way the backend keeps them
 * (RayalBrokers-backend/shared/insurerVehicleList.js cleanName) - the test compares the two.
 */
const { cleanName } = require("./relianceModelCollect");

const COLLECTION = "pincodeLocality";
const SOURCE = "automation";
const MAX_NAMES = 200;
const MAX_NAME_LENGTH = 150;
const SAVE_WAIT_MS = 3000;

const isDuplicateError = (error) =>
  !!error && (error.code === 11000 || (Array.isArray(error.writeErrors) && error.writeErrors.length > 0 && error.writeErrors.every((w) => w.code === 11000)));

/** "604203" from 604203 / " 604203 " / "604-203"; "" when it is not six digits. */
const pincodeOf = (value) => {
  const digits = String(value == null ? "" : value).replace(/\D/g, "");
  return /^[0-9]{6}$/.test(digits) ? digits : "";
};

/**
 * Insert only.
 * @param {Object} db  a mongodb Db (or anything with .collection(name).insertMany)
 * @param {Object} run { pincode, names, company }
 * @returns {Promise<{added:number, alreadyThere:number, skipped:string|null}>}
 */
async function saveLocalities(db, { pincode, names, company = "KSHEMA", district = "" } = {}, { now = () => new Date() } = {}) {
  const pin = pincodeOf(pincode);
  if (!pin) return { added: 0, alreadyThere: 0, skipped: "the pin code is not six digits" };
  const seenKeys = new Set();
  const docs = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const locality = cleanName(raw);
    if (!locality || locality.length > MAX_NAME_LENGTH || seenKeys.has(locality)) continue;
    seenKeys.add(locality);
    docs.push({
      pincode: pin,
      locality,
      localityKey: locality,
      isEnabled: true,
      source: SOURCE,
      sourceCompany: company,
      // the pin code collector knows the district (scripts/kshemaCollectPincodes.js); a policy run does not
      ...(district ? { district: String(district).trim() } : {}),
      createdAt: now(),
    });
    if (docs.length >= MAX_NAMES) break;
  }
  if (!docs.length) return { added: 0, alreadyThere: 0, skipped: "the portal listed no usable names" };
  try {
    const result = await db.collection(COLLECTION).insertMany(docs, { ordered: false });
    const inserted = result && typeof result.insertedCount === "number" ? result.insertedCount : docs.length;
    return { added: inserted, alreadyThere: docs.length - inserted, skipped: null };
  } catch (error) {
    if (!isDuplicateError(error)) throw error;
    // insertMany({ordered:false}) writes the rest and reports the duplicates
    const inserted =
      typeof error.result?.insertedCount === "number"
        ? error.result.insertedCount
        : typeof error.insertedCount === "number"
        ? error.insertedCount
        : docs.length - (error.writeErrors ? error.writeErrors.length : 1);
    return { added: inserted, alreadyThere: docs.length - inserted, skipped: null };
  }
}

/** The database the server already holds open; null when there is none (a hand-run script). */
const connectedDb = () => {
  try {
    const { connection } = require("mongoose");
    return connection && connection.readyState === 1 && connection.db ? connection.db : null;
  } catch (e) {
    return null;
  }
};

/**
 * What the KSHEMA locality field calls with the names the open dropdown lists. Never throws, never waits more than
 * SAVE_WAIT_MS: a failed or slow save costs the run nothing.
 * @param {Object} deps { getDb, log, warn, waitMs } test seams
 */
async function rememberLocalities(pincode, names, deps = {}) {
  const log = deps.log || (() => {});
  const warn = deps.warn || (() => {});
  const getDb = deps.getDb || connectedDb;
  const waitMs = deps.waitMs || SAVE_WAIT_MS;
  let timer;
  try {
    const db = getDb();
    if (!db) return null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    const saving = saveLocalities(db, { pincode, names }, { now: deps.now });
    // A save that is still running after the wait carries on by itself; its late failure is swallowed here
    saving.catch(() => {});
    const out = await Promise.race([saving, timeout]);
    if (out === "timeout") {
      warn(`   ⚠ Pin code Locality names were not saved yet (the database is slow) - the run goes on`);
      return null;
    }
    if (out.skipped) return out;
    log(`   📍 Pin code ${pincodeOf(pincode)}: ${out.added} new locality name(s) saved (${out.alreadyThere} already saved)`);
    return out;
  } catch (error) {
    warn(`   ⚠ Pin code Locality names could not be saved (${String((error && error.message) || error).split("\n")[0]}) - the run goes on`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { COLLECTION, SOURCE, MAX_NAMES, MAX_NAME_LENGTH, SAVE_WAIT_MS, pincodeOf, saveLocalities, rememberLocalities, connectedDb };
