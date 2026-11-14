/**
 * National RTO locations (2026-11-14, the owner's request): National's RTO Location box lists texts like "Gurgaon - NCR",
 * "Delhi - South - DL 03", "Ambala". They are saved ONCE into a JSON file on the BACKEND (json/nationalRtoLocations.json) - NOT into
 * the RTO City Location master (the owner: "rto code not update this on the data, remove that - save it on the json file on the
 * backend and show it on the dropdown, optional, city and branch"). The policy form's optional "National RTO (City - Branch)"
 * dropdown reads the file through the backend (GET /national-rto-locations); a chosen one is saved on the policy as `nationalRto`
 * and National's automation types exactly that text.
 *
 *   { "updatedAt": "...", "locations": [ { "text": "DELHI - SOUTH - DL 03", "city": "DELHI", "branch": "SOUTH - DL 03" }, ... ] }
 *
 * `text` = what National's portal writes (upper case); city / branch = its two halves, split at the FIRST " - " (no " - " = the
 * whole text is the city, branch ""). Entries are only ADDED: a re-run keeps every entry already there. The writing rules are the
 * same as the backend's (RayalBrokers-backend/shared/nationalRtoLocations.js mergeLocations - keep the two alike; a test compares them).
 * This file starts no browser and opens no database.
 */

const fs = require("fs");
const path = require("path");

const MAX_TEXT = 160;
const squash = (v) => String(v == null ? "" : v).replace(/[\s ]+/g, " ").trim();

/** The backend's file when the backend folder is next to this one, else a copy in this folder (to carry across by hand). */
function defaultFile() {
  const backend = path.join(__dirname, "..", "..", "RayalBrokers-backend", "json");
  if (fs.existsSync(backend)) return path.join(backend, "nationalRtoLocations.json");
  return path.join(__dirname, "..", "data", "nationalRtoLocations.json");
}

/** One option text -> { text, city, branch }, or { skip } with the reason. */
function parseRtoText(text) {
  const t = squash(text).toUpperCase();
  if (!t) return { skip: "an empty line" };
  if (t.length > MAX_TEXT || /[<>]/.test(t)) return { skip: `"${t.slice(0, 40)}" is not a usable location text` };
  if (/^-\s/.test(t)) return { skip: `"${t}" has no city before the dash` };
  const at = t.indexOf(" - ");
  const city = at === -1 ? t : t.slice(0, at).trim();
  const branch = at === -1 ? "" : t.slice(at + 3).trim();
  if (!city) return { skip: `"${t}" has no city before the dash` };
  return { text: t, city, branch };
}

function readFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const seen = new Set();
    const locations = [];
    for (const item of Array.isArray(raw && raw.locations) ? raw.locations : []) {
      const parsed = parseRtoText(typeof item === "string" ? item : item && typeof item === "object" ? item.text : null);
      if (parsed.skip || seen.has(parsed.text)) continue;
      seen.add(parsed.text);
      locations.push({ text: parsed.text, city: parsed.city, branch: parsed.branch });
    }
    return { locations };
  } catch (e) {
    return { locations: [] };
  }
}

/**
 * Add the texts to the file; what is there stays. Written whole to a temporary file and renamed over the real one.
 * @returns {{added:number, alreadyThere:number, total:number, skipped:string[], file:string}}
 */
function saveLocationsFile(file, texts, { now = () => new Date() } = {}) {
  const have = readFile(file);
  const known = new Set(have.locations.map((l) => l.text));
  const fresh = [];
  const skipped = [];
  const seenNow = new Set();
  for (const t of texts || []) {
    const parsed = parseRtoText(t);
    if (parsed.skip) {
      skipped.push(parsed.skip);
      continue;
    }
    seenNow.add(parsed.text);
    if (known.has(parsed.text)) continue;
    known.add(parsed.text);
    fresh.push({ text: parsed.text, city: parsed.city, branch: parsed.branch });
  }
  if (fresh.length || !fs.existsSync(file)) {
    const all = [...have.locations, ...fresh].sort((a, b) => a.text.localeCompare(b.text));
    const body = {
      updatedAt: now().toISOString(),
      source: "National portal RTO Location list, collected by Rayal-policy-form-automation scripts/nationalCollectRtoLocations.js",
      locations: all,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
    fs.renameSync(tmp, file);
  }
  return { added: fresh.length, alreadyThere: seenNow.size - fresh.length, total: have.locations.length + fresh.length, skipped, file };
}

/**
 * The collector body the flow's hook calls: read National's RTO list (nothing is picked) and add it to the file.
 * @param {Object} o { file, log, read }
 */
async function collectNationalRto(driver, ctx, { file = defaultFile(), log = () => {}, read = {} } = {}) {
  const { readAutocompleteOptions, NAMES } = require("./nationalModelCollect");
  const { CollectError } = require("./kshemaModelCollect");
  log("Reading National's RTO location list ...");
  const texts = await readAutocompleteOptions(driver, ctx, NAMES.rto, "RTO location", { log, ...read });
  if (!texts.length) throw new CollectError("National's RTO location box listed no locations.");
  log(`The RTO list has ${texts.length} locations.`);
  const saved = saveLocationsFile(file, texts);
  log(`${saved.added} new locations added to ${saved.file}, ${saved.alreadyThere} already there (${saved.total} in all)${saved.skipped.length ? `, ${saved.skipped.length} lines not saved` : ""}.`);
  const noBranch = texts.map((t) => parseRtoText(t)).filter((p) => p.text && !p.branch).map((p) => p.text);
  if (noBranch.length) log(`Locations with no branch (the whole text is the city): ${noBranch.slice(0, 15).join(", ")}${noBranch.length > 15 ? ` ... and ${noBranch.length - 15} more` : ""}`);
  for (const why of saved.skipped.slice(0, 10)) log(`  not saved: ${why}`);
  return { found: texts.length, added: saved.added, alreadyThere: saved.alreadyThere, total: saved.total, file: saved.file };
}

module.exports = { defaultFile, parseRtoText, saveLocationsFile, collectNationalRto };
