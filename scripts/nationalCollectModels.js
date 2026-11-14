/**
 * National Make / Model / Variant collector - run it BY HAND, ONE time; it is not part of the server and no policy run uses it.
 *
 *   node scripts/nationalCollectModels.js --policy <onlinePolicy id>                 every make in National's Make box, 10 windows
 *   node scripts/nationalCollectModels.js --policy <onlinePolicy id> --windows 5 HONDA BAJAJ   only these makes, 5 windows
 *
 * What it does:
 *   1. takes that policy's National login (the policy's user, then the client - the same resolver a normal run uses) and its
 *      RTO, and walks the normal National steps: login, Calculate Premium, vehicle type, plan, class;
 *   2. picks the policy's RTO (Make, Model and Variant open only after it), then, make by make:
 *        pick the make -> read ALL its Models -> save the Make and its Models
 *        -> for each Model in turn: pick it -> read its Variants -> save them -> the next Model
 *        -> when the last Model of the make is done, the next make;
 *   3. stops there. Nothing is quoted or saved at National and nothing is written to the policy.
 *
 * --not-found: the same walk for National's SECOND set of lists - the makes / models / variants the portal shows when its "Not able to
 * Find the required Model & Variant" box is ticked. The run data carries modelNotFound, the normal flow ticks that box before the
 * lists are read, and the rows go into three separate lists (insurerMakeNotFound / insurerModelNotFound / insurerVariantNotFound).
 *
 * SEVERAL WINDOWS (default 10, --windows N, 1-10): each window logs in on its own and takes its next make from ONE shared list, so
 * a make is never done by two windows. Windows run headless (no Chrome on screen, faster) unless --show is given.
 *
 * Saving is insert only (Vehicle Model page: National Makes, Models and Variants, "Policy run"): a name already saved is skipped,
 * never changed or repeated. It saves after every model, so a stop in the middle loses nothing. No .env switch.
 * Rules and the walk: lib/nationalModelCollect.js.
 */
require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");
const { formatPolicyDate } = require("../lib/policyDates");
const { resolvePortalCredentials } = require("../lib/credentialResolver");
const { cleanName, buildCollectorData } = require("../lib/relianceModelCollect");
const { createWorkQueue, newTotals } = require("../lib/kshemaModelCollect");
const { COMPANY, collectNational } = require("../lib/nationalModelCollect");

const DEFAULT_WINDOWS = 10;
const MAX_WINDOWS = 10;
const START_GAP_MS = 3000; // one window after the other: each opens its own Chrome and logs in

const USAGE = `
National Make / Model / Variant collector (run once, by hand)

Usage: node scripts/nationalCollectModels.js --policy <onlinePolicy id> [--windows N] [--show] [--not-found] [<MAKE> ...]

  --policy <id>   an Online Policy whose National login and RTO are used to reach the Make list
  <MAKE> ...      only these makes, written exactly as National's Make box writes them (a make of several words in quotes).
                  No make = every make in the list.
  --windows N     how many Chrome windows work at the same time (1 to ${MAX_WINDOWS}, default ${DEFAULT_WINDOWS}); each make is done by ONE window only
  --show          show the Chrome windows (default: headless, faster and lighter - ten visible windows slow the computer down)
  --not-found     collect National's SECOND set of lists instead: the makes / models / variants the portal shows when its "Not able to
                  Find the required Model & Variant" box is ticked (saved in their own lists, the normal lists are not touched)
`;

function parseArgs(argv) {
  const makes = [];
  let policy = "";
  let windows = DEFAULT_WINDOWS;
  let show = false;
  let notFound = false;
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
    } else if (a === "--not-found") {
      notFound = true;
    } else if (a.startsWith("--")) {
      return { error: `Unknown option ${a}.` };
    } else {
      const name = cleanName(a);
      if (name && !makes.includes(name)) makes.push(name);
    }
  }
  if (!policy) return { error: "Say which policy to use: --policy <onlinePolicy id>." };
  if (!/^[0-9a-fA-F]{24}$/.test(policy)) return { error: `"${policy}" is not a policy id (24 letters and digits).` };
  return { policy, makes, windows, show, notFound };
}

function printTotals(totals, prefix) {
  console.log(
    `${prefix}: ${totals.makesDone || 0} makes done, ${totals.makesAdded || 0} new makes, ` +
      `${totals.modelsAdded || 0} new models (${totals.modelsAlreadyThere || 0} already there), ` +
      `${totals.variantsAdded || 0} new variants (${totals.variantsAlreadyThere || 0} already there), ` +
      `${totals.modelsWithoutVariants || 0} models with no variants.`
  );
  if ((totals.makesWithoutModels || []).length) console.log(`Makes with no models listed: ${totals.makesWithoutModels.join(", ")}`);
  if ((totals.makesNotFound || []).length) console.log(`Makes National does not have under that name: ${totals.makesNotFound.join(", ")}`);
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
      provider: "national",
      userId: policy.userId,
      clientId: policy.clientId,
      log: (line) => console.log(`  ${line}`),
    });
    if (!resolved) {
      console.error("No active National login was found on that policy's user or client. Add it on the User page and run again.");
      return 1;
    }
    console.log(`Using the ${resolved.source}'s National login ${resolved.creds.username}.`);

    // Headless (this run only; the .env is not touched): ten Chrome windows on screen would slow everything down
    if (!args.show) process.env.HEADLESS = "true";

    // National's own login address and the policy's RTO are needed before any window opens
    if (!String(resolved.creds.loginUrl || "").trim()) {
      console.error("The National login that would be used has no login address (URL) saved, so no window could open. Add the address to that login on the User page and run again.");
      return 1;
    }
    if (!String(policy.RTOCity || "").trim() && !String(policy.nationalRto || "").trim()) {
      console.error("That policy has no RTO city, and National's Make list opens only after an RTO. Choose a policy that has an RTO City / Location and run again.");
      return 1;
    }

    // Nothing in the run's data points back at the policy (no _id / policyId / _jobId), so the run cannot read or write the
    // policy's stages, notes or files.
    const baseData = {
      ...buildCollectorData(policy, resolved.creds, { formatDate: formatPolicyDate }),
      Companyname: "national",
      RTOCity: policy.RTOCity,
      RTORegion: policy.RTORegion || "",
      nationalRto: policy.nationalRto || "",
      // the normal flow ticks the portal's "Not able to Find ..." box when this is true, before the lists are read
      ...(args.notFound ? { modelNotFound: true } : {}),
    };
    const list = args.notFound ? "notFound" : "normal";

    // ONE list of makes for every window: a window takes the next make nobody has taken
    const queue = createWorkQueue();
    const windows = args.makes.length ? Math.min(args.windows, args.makes.length) : args.windows;
    console.log(
      (args.notFound ? "'Not able to Find' lists: " : "") +
        (args.makes.length ? `Collecting ${args.makes.length} make(s): ${args.makes.join(", ")}` : "Collecting EVERY make in National's Make list.") +
        ` With ${windows} window(s), ${args.show ? "shown" : "headless"}.`
    );

    // The normal National flow, loaded only now (a big module with a browser behind it)
    const { fillNationalForm } = require("../fullPolicycompany/national");
    const runWindow = async (k) => {
      await new Promise((resolve) => setTimeout(resolve, (k - 1) * START_GAP_MS));
      const say = (line) => console.log(`[window ${k}] ${line}`);
      const data = { ...baseData };
      // Runs inside this window's National flow, after the class and before the RTO box
      data.collectMakeModels = (driver, ctx) => collectNational(driver, ctx, { makes: args.makes, db, data, totals, queue, log: say, list });
      say("starting ...");
      const result = await fillNationalForm(data);
      if (!result || result.success !== true || !result.collected) {
        const why = (result && (result.error || result.message)) || "the window ended before the make list";
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
      console.error("No window got as far as National's Make list, so nothing was collected. Look at the window messages above.");
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
