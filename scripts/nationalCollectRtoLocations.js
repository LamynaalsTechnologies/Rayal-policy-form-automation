/**
 * National RTO locations collector - run it BY HAND, ONE time; it is not part of the server and no policy run uses it.
 *
 *   node scripts/nationalCollectRtoLocations.js --policy <onlinePolicy id> [--show] [--not-found] [--file <path>]
 *
 * What it does:
 *   1. takes that policy's National login (the policy's user, then the client - the same resolver a normal run uses) and walks
 *      the normal National steps: login, Calculate Premium, vehicle type, plan, class;
 *   2. at the RTO Location box it READS every option the portal lists ("Gurgaon - NCR", "Delhi - South - DL 03", "Ambala" ...) -
 *      nothing is picked - and ADDS them to the JSON file on the backend (RayalBrokers-backend/json/nationalRtoLocations.json when
 *      that folder is next to this one, else data/nationalRtoLocations.json here, to carry across by hand). Each entry is the
 *      portal's text with its city and branch (split at the first " - "). The policy form's optional "National RTO (City - Branch)"
 *      dropdown reads that file through the backend; nothing is written to the RTO City Location master or to any database;
 *   3. stops there. Nothing is quoted or saved at National, nothing is written to the policy.
 *
 * --not-found: the same read with the portal's "Not able to Find the required Model & Variant" box ticked (the normal flow ticks it
 * before the list is read); a different RTO list in that mode can only ADD entries. Entries are only added, never removed.
 * One window; no .env switch. Rules: lib/nationalRtoCollect.js.
 */
require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");
const { formatPolicyDate } = require("../lib/policyDates");
const { resolvePortalCredentials } = require("../lib/credentialResolver");
const { buildCollectorData } = require("../lib/relianceModelCollect");
const { collectNationalRto, defaultFile } = require("../lib/nationalRtoCollect");

const USAGE = `
National RTO locations collector (run once, by hand)

Usage: node scripts/nationalCollectRtoLocations.js --policy <onlinePolicy id> [--show] [--not-found] [--file <path>]

  --policy <id>   an Online Policy whose National login is used to reach the RTO Location box
  --show          show the Chrome window (default: headless)
  --not-found     read the RTO list the portal shows when its "Not able to Find the required Model & Variant" box is ticked; only
                  locations not in the file yet are added
  --file <path>   the JSON file to add to (default: the backend's json/nationalRtoLocations.json when the backend folder is next
                  to this one, else data/nationalRtoLocations.json in this folder)
`;

function parseArgs(argv) {
  let policy = "";
  let show = false;
  let notFound = false;
  let file = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--policy") policy = String(argv[++i] || "").trim();
    else if (a === "--show") show = true;
    else if (a === "--not-found") notFound = true;
    else if (a === "--file") file = String(argv[++i] || "").trim();
    else return { error: a.startsWith("--") ? `Unknown option ${a}.` : `Unexpected word "${a}" - this script takes no makes.` };
  }
  if (!policy) return { error: "Say which policy to use: --policy <onlinePolicy id>." };
  if (!/^[0-9a-fA-F]{24}$/.test(policy)) return { error: `"${policy}" is not a policy id (24 letters and digits).` };
  if (argv.includes("--file") && !file) return { error: "--file needs a path." };
  return { policy, show, notFound, file };
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
    console.error("MONGODB_URI is not set in this folder's .env, so the locations cannot be saved.");
    return 2;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
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
    if (!String(resolved.creds.loginUrl || "").trim()) {
      console.error("The National login that would be used has no login address (URL) saved, so no window could open. Add the address to that login on the User page and run again.");
      return 1;
    }
    console.log(`Using the ${resolved.source}'s National login ${resolved.creds.username}.`);

    if (!args.show) process.env.HEADLESS = "true"; // this run only; the .env is not touched

    // Nothing in the run's data points back at the policy (no _id / policyId / _jobId)
    const data = {
      ...buildCollectorData(policy, resolved.creds, { formatDate: formatPolicyDate }),
      Companyname: "national",
      // the normal flow ticks the portal's "Not able to Find ..." box when this is true, before the list is read
      ...(args.notFound ? { modelNotFound: true } : {}),
    };
    const file = args.file || defaultFile();
    let saved = null;
    // Runs inside the National flow, after the class and before the RTO box
    data.collectMakeModels = async (driver, ctx) => {
      saved = await collectNationalRto(driver, ctx, { file, log: (line) => console.log(line) });
      return saved;
    };

    const { fillNationalForm } = require("../fullPolicycompany/national");
    console.log(`Reading National's RTO location list${args.notFound ? " (the 'Not able to Find' mode)" : ""}, ${args.show ? "window shown" : "headless"} ...`);
    const result = await fillNationalForm(data);
    if (!result || result.success !== true || !result.collected) {
      const why = (result && (result.error || result.message)) || "the window ended before the RTO box";
      console.error(`\nThe run stopped before it finished: ${why}`);
      if (result && result.screenshotUrl) console.error(`Picture: ${result.screenshotUrl}`);
      return 1;
    }
    console.log(`\nDone: ${saved.found} locations read, ${saved.added} new, ${saved.alreadyThere} already there - ${saved.total} in ${saved.file}.`);
    console.log("Restart nothing: the backend reads the file on every request. If the backend runs on another machine, copy that file there.");
    return 0;
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
