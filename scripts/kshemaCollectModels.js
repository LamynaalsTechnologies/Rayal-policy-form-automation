/**
 * KSHEMA Make / Model / Variant collector - run it BY HAND, ONE time; it is not part of the server and no policy run uses it.
 *
 *   node scripts/kshemaCollectModels.js --policy <onlinePolicy id>                 every make in KSHEMA's Make dropdown
 *   node scripts/kshemaCollectModels.js --policy <onlinePolicy id> HONDA "TVS MOTOR COMPANY LTD"   only these makes
 *
 * What it does:
 *   1. takes the customer of that policy and its KSHEMA login (the policy's user, then the client - the same resolver a
 *      normal run uses) and walks the normal KSHEMA steps: login, Two-Wheeler, the customer details of the quote form;
 *   2. sets "Is New Vehicle?" to Yes (the portal shows Make / Model / Variant only then), then, make by make:
 *        pick the make -> read ALL its Models -> save the Make and its Models
 *        -> for each Model in turn: pick it -> read its Variants -> save them -> the next Model
 *        -> when the last Model of the make is done, the next make;
 *   3. stops there. Nothing else on the form is filled, nothing is saved at KSHEMA, nothing is written to the policy.
 *
 * SEVERAL WINDOWS (default 10, --windows N, 1-10): each window logs in on its own and takes its next make from ONE shared list, so
 * a make is never done by two windows. Windows run headless (no Chrome on screen, faster) unless --show is given.
 *
 * Saving is insert only (Vehicle Model page: KSHEMA Makes, Models and Variants, "Policy run"): a name already saved is
 * skipped, never changed or repeated. It saves after every model, so a stop in the middle loses nothing.
 * No .env switch. Rules and the walk: lib/kshemaModelCollect.js.
 */
require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");
const { formatPolicyDate } = require("../lib/policyDates");
const { resolvePortalCredentials } = require("../lib/credentialResolver");
const { cleanName, buildCollectorData } = require("../lib/relianceModelCollect");
const { COMPANY, collectKshema, createWorkQueue, newTotals } = require("../lib/kshemaModelCollect");

const DEFAULT_WINDOWS = 10;
const MAX_WINDOWS = 10;
const START_GAP_MS = 3000; // one window after the other: each opens its own Chrome and logs in

const USAGE = `
KSHEMA Make / Model / Variant collector (run once, by hand)

Usage: node scripts/kshemaCollectModels.js --policy <onlinePolicy id> [--windows N] [--show] [<MAKE> ...]

  --policy <id>   an Online Policy whose customer details and KSHEMA login are used to reach the vehicle section
  <MAKE> ...      only these makes, written exactly as KSHEMA's Make dropdown writes them (a make of several words in quotes).
                  No make = every make in the dropdown.
  --windows N     how many Chrome windows work at the same time (1 to ${MAX_WINDOWS}, default ${DEFAULT_WINDOWS}); each make is done by ONE window only
  --show          show the Chrome windows (default: headless, faster and lighter - ten visible windows slow the computer down)
`;

function parseArgs(argv) {
  const makes = [];
  let policy = "";
  let windows = DEFAULT_WINDOWS;
  let show = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--policy") {
      policy = String(argv[++i] || "").trim();
    } else if (a === "--windows") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOWS) return { error: `--windows needs a whole number from 1 to ${MAX_WINDOWS}.` };
      windows = n;
    } else if (a === "--show") {
      show = true;
    } else if (a.startsWith("--")) {
      return { error: `Unknown option ${a}.` };
    } else {
      const name = cleanName(a);
      if (name && !makes.includes(name)) makes.push(name);
    }
  }
  if (!policy) return { error: "Say which policy to use: --policy <onlinePolicy id>." };
  if (!/^[0-9a-fA-F]{24}$/.test(policy)) return { error: `"${policy}" is not a policy id (24 letters and digits).` };
  return { policy, makes, windows, show };
}

function printTotals(totals, prefix) {
  console.log(
    `${prefix}: ${totals.makesDone || 0} makes done, ${totals.makesAdded || 0} new makes, ` +
      `${totals.modelsAdded || 0} new models (${totals.modelsAlreadyThere || 0} already there), ` +
      `${totals.variantsAdded || 0} new variants (${totals.variantsAlreadyThere || 0} already there), ` +
      `${totals.modelsWithoutVariants || 0} models with no variants.`
  );
  if ((totals.makesWithoutModels || []).length) console.log(`Makes with no models listed: ${totals.makesWithoutModels.join(", ")}`);
  if ((totals.makesNotFound || []).length) console.log(`Makes KSHEMA does not have under that name: ${totals.makesNotFound.join(", ")}`);
  if ((totals.makesFailed || []).length) console.log(`Makes that failed (run the script again for these): ${totals.makesFailed.map((f) => f.make).join(", ")}`);
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
    console.error("MONGODB_URI is not set in this folder's .env, so the lists cannot be saved.");
    return 2;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const totals = newTotals();
  try {
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

    // Headless (this run only; the .env is not touched): ten Chrome windows on screen would slow everything down
    if (!args.show) process.env.HEADLESS = "true";

    // The customer fields the quote form's first section needs; nothing in it points back at the policy
    // (no _id / policyId / _jobId), so the run cannot read or write the policy's stages, notes or files.
    const baseData = {
      ...buildCollectorData(policy, resolved.creds, { formatDate: formatPolicyDate }),
      Companyname: "kshema",
      pincode: policy.pincode,
      mobileNumber: policy.mobileNumber,
      kshemaSendSurname: false,
    };

    // ONE list of makes for every window: a window takes the next make nobody has taken
    const queue = createWorkQueue();
    const windows = args.makes.length ? Math.min(args.windows, args.makes.length) : args.windows;
    console.log(
      (args.makes.length ? `Collecting ${args.makes.length} make(s): ${args.makes.join(", ")}` : "Collecting EVERY make in KSHEMA's Make dropdown.") +
        ` With ${windows} window(s), ${args.show ? "shown" : "headless"}.`
    );

    // The normal KSHEMA flow, loaded only now (a big module with a browser behind it)
    const { fillKshemaForm } = require("../fullPolicycompany/kshemaForm");
    const runWindow = async (k) => {
      await new Promise((resolve) => setTimeout(resolve, (k - 1) * START_GAP_MS));
      const say = (line) => console.log(`[window ${k}] ${line}`);
      const data = { ...baseData };
      // Runs inside this window's KSHEMA flow, right after the customer details
      data.collectMakeModels = (driver, ctx) => collectKshema(driver, ctx, { makes: args.makes, db, data, totals, queue, log: say });
      say("starting ...");
      const result = await fillKshemaForm(data);
      if (!result || result.success !== true || !result.collected) {
        const why = (result && (result.error || result.message)) || "the window ended before the vehicle lists";
        say(`stopped before it finished: ${why}`);
        if (result && result.screenshotUrl) say(`picture: ${result.screenshotUrl}`);
        return false;
      }
      say("finished - no make left for this window.");
      return true;
    };

    const outcomes = await Promise.allSettled(Array.from({ length: windows }, (_, i) => runWindow(i + 1)));
    outcomes.forEach((o, i) => {
      if (o.status === "rejected") console.error(`[window ${i + 1}] crashed: ${o.reason && o.reason.message ? o.reason.message : o.reason}`);
    });
    const finished = outcomes.filter((o) => o.status === "fulfilled" && o.value === true).length;

    console.log("");
    if (!queue.targets) {
      console.error("No window got as far as KSHEMA's Make list, so nothing was collected. Look at the window messages above.");
      return 1;
    }
    const left = queue.targets.length - queue.taken.length;
    printTotals(totals, `${finished} of ${windows} windows finished. ${left > 0 ? `${left} make(s) were never taken (every window stopped). ` : ""}${COMPANY} so far`);
    return left > 0 || finished < windows || totals.makesNotFound.length || totals.makesWithoutModels.length || totals.makesFailed.length ? 1 : 0;
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

module.exports = { parseArgs };
