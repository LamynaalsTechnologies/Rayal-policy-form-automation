/**
 * Reliance Make & Model collector - run it by hand, it is not part of the server.
 *
 *   node scripts/relianceCollectModels.js --policy <onlinePolicy id> HONDA HERO SUZUKI YAMAHA BAJAJ
 *
 * What it does:
 *   1. takes the customer of that policy and its Reliance login (the policy's user, then the client - the same
 *      resolver a normal run uses) and walks the normal Reliance steps: login, Motors -> Two Wheeler, product, Skip To
 *      Main Page, vertical code, Form 60, Validate Customer;
 *   2. at the make/model box it types each Make you gave, reads EVERY suggestion Reliance lists, drops the Make part
 *      and the bars ("HONDA | unicorn | 160" -> Model "UNICORN 160") and saves them, insert only, into the Vehicle Model
 *      lists (Reliance Makes and Models - "Policy run" in the Added By column);
 *   3. stops there. Nothing is chosen, calculated, saved or paid at Reliance, and nothing is written to the policy.
 *
 * A name that is already in the list is skipped (never changed, never repeated), so running it again is safe.
 * Reliance has no Variants. No .env switch: the makes are the words on the command line.
 * Rules and parsing: lib/relianceModelCollect.js.
 */
require("dotenv").config({ quiet: true });

const mongoose = require("mongoose");
const { ObjectId } = require("mongodb");
const { formatPolicyDate } = require("../lib/policyDates");
const { resolvePortalCredentials } = require("../lib/credentialResolver");
const { COMPANY, cleanName, buildCollectorData, collectModelsForMake, saveModels } = require("../lib/relianceModelCollect");

const USAGE = `
Reliance Make & Model collector

Usage: node scripts/relianceCollectModels.js --policy <onlinePolicy id> <MAKE> [<MAKE> ...]

  --policy <id>   an Online Policy whose customer details and Reliance login are used to reach the make/model box
  <MAKE> ...      the makes to search and save the models of, e.g.  HONDA HERO SUZUKI YAMAHA BAJAJ
                  (a make of two words in quotes:  "HERO MOTOCORP"; HERO, "HERO HONDA" and "HERO MOTOCORP" are three makes -
                  each one is searched and saved on its own, only when it is on the command)
`;

function parseArgs(argv) {
  const makes = [];
  let policy = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--policy") {
      policy = String(argv[++i] || "").trim();
    } else if (a.startsWith("--")) {
      return { error: `Unknown option ${a}.` };
    } else {
      const name = cleanName(a);
      if (name && !makes.includes(name)) makes.push(name);
    }
  }
  if (!policy) return { error: "Say which policy to use: --policy <onlinePolicy id>." };
  if (!/^[0-9a-fA-F]{24}$/.test(policy)) return { error: `"${policy}" is not a policy id (24 letters and digits).` };
  if (!makes.length) return { error: "Say which makes to collect, for example HONDA HERO SUZUKI." };
  return { policy, makes };
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
  try {
    console.log(`Reading policy ${args.policy} ...`);
    const policy = await db.collection("onlinePolicy").findOne({ _id: new ObjectId(args.policy) });
    if (!policy) {
      console.error("That policy was not found in this database. Check the id.");
      return 1;
    }

    const resolved = await resolvePortalCredentials({
      provider: "reliance",
      userId: policy.userId,
      clientId: policy.clientId,
      log: (line) => console.log(`  ${line}`),
    });
    if (!resolved) {
      console.error("No active Reliance login was found on that policy's user or client. Add it on the User page and run again.");
      return 1;
    }
    console.log(`Using the ${resolved.source}'s Reliance login ${resolved.creds.username}.`);

    const data = buildCollectorData(policy, resolved.creds, { formatDate: formatPolicyDate });
    const totals = { lines: 0, makesAdded: 0, modelsAdded: 0, modelsAlreadyThere: 0, skipped: 0 };
    const failed = [];

    // Runs inside the Reliance flow, at the make/model box
    data.collectMakeModels = async (driver) => {
      // Each make asked for is its own make, searched once: HERO, HERO HONDA and HERO MOTOCORP are three (the owner).
      const queue = [...args.makes];
      for (let n = 0; n < queue.length; n++) {
        const make = queue[n];
        console.log(`\n[${n + 1}/${queue.length}] ${make}: searching ...`);
        try {
          const found = await collectModelsForMake(driver, make, { log: (line) => console.log(`  ${line}`) });
          if (found.lines === 0) {
            failed.push(make);
            console.log(`  ${make}: Reliance listed nothing for this make. Check the spelling, then run it again for this make.`);
            continue;
          }
          const saved = await saveModels(db, found.models);
          totals.lines += found.lines;
          totals.skipped += found.skipped.length;
          totals.makesAdded += saved.makesAdded;
          totals.modelsAdded += saved.modelsAdded;
          totals.modelsAlreadyThere += saved.modelsAlreadyThere;
          // per make seen in this list: how many lines
          const perMake = {};
          for (const m of found.models) perMake[m.make] = (perMake[m.make] || 0) + 1;
          console.log(
            `  ${make}: ${found.lines} lines read, ${saved.modelsAdded} new models saved, ${saved.modelsAlreadyThere} already there` +
              (saved.makesAdded ? `, ${saved.makesAdded} new make added` : "")
          );
          console.log(`  ${make}: makes in this list: ${Object.entries(perMake).map(([k, v]) => `${k} (${v})`).join(", ") || "none"}`);
          // other makes' lines: counted by make, not saved by this search
          const others = Object.entries(found.otherMakes || {}).filter(([k]) => !queue.includes(k));
          if (others.length) {
            console.log(
              `  ${make}: lines of other makes, not saved by this search: ${others.map(([k, v]) => `${k} (${v})`).join(", ")} - ` +
                `add the make to the command to collect it`
            );
          }
          const unexplained = found.skipped.filter((why) => !/ line, not a /.test(why));
          if (unexplained.length) {
            console.log(`  ${make}: ${unexplained.length} lines not saved:`);
            for (const why of unexplained.slice(0, 10)) console.log(`    - ${why}`);
            if (unexplained.length > 10) console.log(`    ... and ${unexplained.length - 10} more`);
          }
        } catch (error) {
          failed.push(make);
          console.log(`  ${make}: stopped - ${error && error.message ? error.message : error}`);
        }
      }
      return totals;
    };

    // The normal Reliance flow, loaded only now (it is a 5,000-line module with a browser behind it)
    const { fillRelianceForm } = require("../fullPolicycompany/relianceForm");
    const result = await fillRelianceForm(data);

    if (!result || result.success !== true || !result.collected) {
      const why = (result && (result.error || result.message)) || "the run ended before the make/model box";
      console.error(`\nThe run did not reach the make/model box: ${why}`);
      if (result && result.screenshotUrl) console.error(`Picture: ${result.screenshotUrl}`);
      return 1;
    }

    console.log(
      `\nDone for ${COMPANY}: ${totals.lines} lines read, ${totals.modelsAdded} new models, ` +
        `${totals.modelsAlreadyThere} already there, ${totals.makesAdded} new makes, ${totals.skipped} lines not saved.`
    );
    if (failed.length) console.log(`Not collected (run again for these): ${failed.join(", ")}`);
    return failed.length ? 1 : 0;
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
