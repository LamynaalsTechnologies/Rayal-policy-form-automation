/**
 * KSHEMA Pin code -> Locality collector - run it BY HAND; it is not part of the server and no policy run uses it.
 *
 *   node scripts/kshemaCollectPincodes.js --policy <KSHEMA policy id> Mayiladuthurai Ariyalur   these districts' pin codes
 *   node scripts/kshemaCollectPincodes.js --policy <id> 609001 609003                            only these pin codes
 *   node scripts/kshemaCollectPincodes.js --policy <id>                                          every district in the file
 *
 * The pin codes come from Data/tamil_nadu_district_pincodes.json (made by scripts/collectTnPincodes.js; --file <path> for
 * another one). District names are matched ignoring case and spaces.
 *
 * What it does (like scripts/kshemaCollectModels.js):
 *   1. takes the customer of that policy and its KSHEMA login (the policy's user, then the client - the resolver a normal run
 *      uses) and walks the normal KSHEMA steps: login, Two-Wheeler, the customer details of the quote form;
 *   2. then, pin code by pin code: types it into "Pin Code", reads every name the "Pin code Locality" dropdown lists, and saves
 *      them on the Pincode & Locality page (insert only: a name already there is skipped, never changed, never repeated);
 *   3. stops there. Nothing else is filled, nothing is saved at KSHEMA, nothing is written to the policy.
 *
 * A pin code that already has localities saved is skipped (--again reads it anyway). Several windows (--windows N, 1-10,
 * default 10) share ONE list, so a pin code is done by one window only; a window that stops restarts with a fresh Chrome
 * (up to 3 times) while pin codes are left. Each saved row carries the pin code's district. Headless unless --show.
 * No .env switch.
 * Rules of the walk: lib/kshemaPincodeCollect.js.
 */
require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");
const { formatPolicyDate } = require("../lib/policyDates");
const { resolvePortalCredentials } = require("../lib/credentialResolver");
const { buildCollectorData } = require("../lib/relianceModelCollect");
const { COLLECTION } = require("../lib/pincodeLocalitySave");
const { collectPincodeLocalities, createPinQueue, newPinTotals } = require("../lib/kshemaPincodeCollect");

const DEFAULT_FILE = path.join(__dirname, "..", "Data", "tamil_nadu_district_pincodes.json");
const DEFAULT_WINDOWS = 10; // owner 2026-11-23: "10 windows at the same time, fast"
const MAX_WINDOWS = 10;
const START_GAP_MS = 3000; // one window after the other: each opens its own Chrome and logs in
const RESTARTS = 3; // a window that stops (login, portal, crash) starts again with a fresh Chrome while pin codes are left

const USAGE = `
KSHEMA Pin code -> Locality collector (by hand)

Usage: node scripts/kshemaCollectPincodes.js --policy <onlinePolicy id> [--windows N] [--show] [--again] [--file <json>] [<district> | <pin code> ...]

  --policy <id>   a KSHEMA Online Policy whose customer details and KSHEMA login are used to reach the Pin Code box
  <district>      the pin codes of these districts from the file (a name of several words in quotes)
  <pin code>      these six-digit pin codes
                  nothing given = every district in the file
  --again         also read pin codes that already have localities saved
  --windows N     Chrome windows working at the same time (1 to ${MAX_WINDOWS}, default ${DEFAULT_WINDOWS}); a window that stops restarts up to ${RESTARTS} times
  --show          show the Chrome windows (default headless)
  --file <json>   the district / pin code list (default Data/tamil_nadu_district_pincodes.json)
`;

function parseArgs(argv) {
  const districts = [];
  const pins = [];
  let policy = "";
  let windows = DEFAULT_WINDOWS;
  let show = false;
  let again = false;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--policy") policy = String(argv[++i] || "").trim();
    else if (a === "--windows") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOWS) return { error: `--windows needs a whole number from 1 to ${MAX_WINDOWS}.` };
      windows = n;
    } else if (a === "--show") show = true;
    else if (a === "--again") again = true;
    else if (a === "--file") file = path.resolve(String(argv[++i] || ""));
    else if (a.startsWith("--")) return { error: `Unknown option ${a}.` };
    else if (/^\d+$/.test(a.trim())) {
      if (!/^[0-9]{6}$/.test(a.trim())) return { error: `"${a}" is not a pin code (six digits).` };
      if (!pins.includes(a.trim())) pins.push(a.trim());
    } else if (a.trim() && !districts.includes(a.trim())) districts.push(a.trim());
  }
  if (!policy) return { error: "Say which policy to use: --policy <onlinePolicy id>." };
  if (!/^[0-9a-fA-F]{24}$/.test(policy)) return { error: `"${policy}" is not a policy id (24 letters and digits).` };
  return { policy, districts, pins, windows, show, again, file };
}

const keyOf = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The pin codes to read, in order, each once; the district of each (a pin listed under two districts: "A / B"); and the
 * district names asked for that the file does not have.
 */
function pinsToRead(list, { districts = [], pins = [] }) {
  const out = [];
  const seen = new Set();
  const unknown = [];
  const districtOf = {};
  list.forEach((d) =>
    (d.pincodes || []).forEach((p) => {
      const names = districtOf[p] ? districtOf[p].split(" / ") : [];
      if (!names.includes(d.district)) districtOf[p] = [...names, d.district].join(" / ");
    })
  );
  const add = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  if (!districts.length && !pins.length) list.forEach((d) => (d.pincodes || []).forEach(add));
  for (const name of districts) {
    const row = list.find((d) => keyOf(d.district) === keyOf(name));
    if (!row) unknown.push(name);
    else (row.pincodes || []).forEach(add);
  }
  pins.forEach(add);
  return { pins: out, unknown, districtOf };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    return 2;
  }
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI is not set in this folder's .env, so the localities cannot be saved.");
    return 2;
  }

  const file = args.file || DEFAULT_FILE;
  let list = [];
  // the file is read for pin codes given by hand too: it gives them their district
  if (args.districts.length || !args.pins.length || fs.existsSync(file)) {
    if (!fs.existsSync(file)) {
      console.error(`${file} is not there. Make it first: node scripts/collectTnPincodes.js`);
      return 2;
    }
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const wanted = pinsToRead(list, args);
  if (wanted.unknown.length) {
    console.error(`Not in ${path.basename(file)}: ${wanted.unknown.join(", ")}. Districts there: ${list.map((d) => d.district).join(", ")}`);
    return 2;
  }
  if (!wanted.pins.length) {
    console.error("No pin codes to read.");
    return 2;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const totals = newPinTotals();
  try {
    let pins = wanted.pins;
    if (!args.again) {
      const saved = new Set(await db.collection(COLLECTION).distinct("pincode", { pincode: { $in: pins } }));
      const skipped = pins.filter((p) => saved.has(p));
      pins = pins.filter((p) => !saved.has(p));
      if (skipped.length) console.log(`${skipped.length} pin code(s) already have localities saved - skipped (--again reads them): ${skipped.join(" ")}`);
      if (!pins.length) {
        console.log("Every pin code asked for already has localities saved. Nothing to do.");
        return 0;
      }
    }

    console.log(`Reading policy ${args.policy} ...`);
    const policy = await db.collection("onlinePolicy").findOne({ _id: new ObjectId(args.policy) });
    if (!policy) {
      console.error("That policy was not found in this database. Check the id.");
      return 1;
    }
    const resolved = await resolvePortalCredentials({
      provider: "kshema",
      userId: policy.userId,
      clientId: policy.clientId,
      log: (line) => console.log(`  ${line}`),
    });
    if (!resolved) {
      console.error("No active KSHEMA login was found on that policy's user or client. Add it on the User page and run again.");
      return 1;
    }
    console.log(`Using the ${resolved.source}'s KSHEMA login ${resolved.creds.username}.`);
    if (!args.show) process.env.HEADLESS = "true"; // this run only; the .env is not touched

    // The customer fields the quote form's first section needs; nothing in it points back at the policy
    // (no _id / policyId / _jobId), so the run cannot read or write the policy's stages, notes or files.
    const baseData = {
      ...buildCollectorData(policy, resolved.creds, { formatDate: formatPolicyDate }),
      Companyname: "kshema",
      pincode: policy.pincode,
      mobileNumber: policy.mobileNumber,
      kshemaSendSurname: false,
    };

    const queue = createPinQueue(pins, wanted.districtOf);
    const windows = Math.min(args.windows, pins.length);
    console.log(`Reading ${pins.length} pin code(s) with ${windows} window(s), ${args.show ? "shown" : "headless"}.`);

    const { fillKshemaForm } = require("../fullPolicycompany/kshemaForm");
    const { CUSTOMER_FIELDS } = require("../fullPolicycompany/kshema/kshemaQuoteForm");
    let reached = 0;
    // one window: start it, and while pin codes are left start it again (fresh Chrome, fresh login) after a stop
    const runWindow = async (k) => {
      await new Promise((resolve) => setTimeout(resolve, (k - 1) * START_GAP_MS));
      const say = (line) => console.log(`[window ${k}] ${line}`);
      for (let attempt = 0; attempt <= RESTARTS; attempt++) {
        if (!queue.left()) return true;
        if (attempt) {
          say(`restarting (${attempt} of ${RESTARTS}) - ${queue.left()} pin code(s) left ...`);
          await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
        }
        let ok = false;
        try {
          ok = await runOnce(k, say);
        } catch (error) {
          say(`crashed: ${String((error && error.message) || error).split("\n")[0]}`);
        }
        if (ok) return true;
      }
      say(`gave up after ${RESTARTS} restarts.`);
      return false;
    };
    const runOnce = async (k, say) => {
      const data = { ...baseData };
      // The model collector's hook (fullPolicycompany/kshemaForm.js): runs right after the customer details
      data.collectMakeModels = (driver, ctx) => {
        reached++;
        say(`customer details done - reading pin codes (${queue.left()} left) ...`);
        return collectPincodeLocalities(driver, ctx, { fields: CUSTOMER_FIELDS, db, data, queue, totals, log: say });
      };
      say("starting ...");
      const result = await fillKshemaForm(data);
      if (!result || result.success !== true || !result.collected) {
        const why = (result && (result.error || result.message)) || "the window ended before the Pin Code box";
        say(`stopped before it finished: ${why}`);
        if (result && result.screenshotUrl) say(`picture: ${result.screenshotUrl}`);
        return false;
      }
      say("finished - no pin code left for this window.");
      return true;
    };

    const outcomes = await Promise.allSettled(Array.from({ length: windows }, (_, i) => runWindow(i + 1)));
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") console.error(`[window ${i + 1}] crashed: ${o.reason && o.reason.message ? o.reason.message : o.reason}`);
    });

    console.log("");
    if (!reached) {
      console.error("No window got as far as the Pin Code box, so nothing was read. Look at the window messages above.");
      return 1;
    }
    const notDone = [...queue.retry, ...queue.targets.slice(queue.next)];
    console.log(
      `${totals.pinsDone} of ${pins.length} pin codes read and saved: ${totals.namesAdded} new locality names ` +
        `(${totals.namesAlreadyThere} already saved).`
    );
    if (totals.empty.length) console.log(`KSHEMA lists no locality for: ${totals.empty.join(" ")}`);
    if (totals.stale.length) console.log(`List did not change from the previous pin code (NOT saved, run again): ${totals.stale.join(" ")}`);
    if (totals.failed.length) console.log(`Failed (run again): ${totals.failed.map((f) => `${f.pin} (${f.why})`).join("; ")}`);
    if (notDone.length) console.log(`Never read (every window stopped; run again): ${notDone.join(" ")}`);
    return totals.stale.length || totals.failed.length || notDone.length ? 1 : 0;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error && error.message ? error.message : error);
      process.exit(1);
    }
  );
}

module.exports = { parseArgs, pinsToRead };
