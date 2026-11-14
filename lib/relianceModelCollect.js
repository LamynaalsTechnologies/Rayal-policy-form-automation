/**
 * Reliance Make & Model collector (2026-11-14, the owner's request): search a Make in Reliance's Make/Model box, read
 * every suggestion, and save the Models in the insurer lists (insurerMake / insurerModel, company "Reliance").
 *
 * What one Reliance suggestion looks like (the owner's words): "HONDA | unicorn | 160" - the Make first, then the model
 * words, parts divided by a bar. The Make is NOT part of the Model, and no bar may be saved:
 *
 *     "HONDA | unicorn | 160"   ->   Make HONDA, Model "UNICORN 160"
 *
 * Rules (the owner's, same as United India's lists):
 *   - insert only: a name that is already there is skipped, never changed, never saved twice;
 *   - Reliance has no Variants - nothing here writes insurerVariant;
 *   - the Make row is made first (a Model needs its Make);
 *   - nothing is clicked or bought: the box is typed in, the list is read, the box is emptied.
 *
 * This file has NO browser start and NO database connection of its own: the driver and the Mongo `db` come in, so the
 * tests run on fakes (test/relianceModelCollect.test.js). The script that uses it: scripts/relianceCollectModels.js.
 * Names are kept the way the backend keeps them (RayalBrokers-backend/shared/insurerVehicleList.js cleanName: tags out,
 * spaces collapsed, upper case) - the test compares the two.
 */

const COMPANY = "Reliance";
const INPUT_ID = "VehicleDetailsMakeModel";
const SOURCE = "automation"; // the Vehicle Model page shows it as "Policy run"

/** The name as it is stored: no tags, spaces (a non-breaking one too) collapsed, upper case. */
const cleanName = (name) =>
  String(name == null ? "" : name)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[\s ]+/g, " ")
    .trim()
    .toUpperCase();

/** The text of a suggestion with the bars gone, for comparing "HONDA | UNICORN | 160" with "HONDA UNICORN 160". */
const withoutBars = (text) => cleanName(String(text == null ? "" : text).replace(/\|/g, " "));

/**
 * One suggestion line -> its Make and its Model.
 *
 * @param {string} text         the line as Reliance shows it ("HONDA | unicorn | 160")
 * @param {string} searchedMake what was typed in the box ("honda")
 * @returns {{make:string, model:string}|{skip:string}}  `skip` = the reason, in words, when the line is not saved
 */
function parseOption(text, searchedMake) {
  const raw = String(text == null ? "" : text).replace(/[\s ]+/g, " ").trim();
  if (!raw) return { skip: "an empty line" };
  if (!raw.includes("|")) return { skip: `"${raw}" has no | in it` };

  const parts = raw.split("|").map(cleanName);
  const make = parts[0];
  const model = parts
    .slice(1)
    .filter(Boolean)
    .join(" ");
  if (!make) return { skip: `"${raw}" has no Make before the |` };
  if (!model) return { skip: `"${raw}" has no Model after the |` };

  // The line must belong to EXACTLY the Make that was searched (the owner: "hero, hero honda, hero motocorp - three are
  // different"): a search for HERO saves only HERO's lines; HERO HONDA and HERO MOTOCORP are makes of their own, saved when
  // they are asked for by name. The other makes' lines the list also shows are only counted.
  const wanted = cleanName(searchedMake);
  if (wanted && make !== wanted) {
    return { skip: `"${raw}" is a ${make} line, not a ${wanted} one`, otherMake: make };
  }
  return { make, model };
}

/** Is this suggestion the one for a policy's vehicle? Bars and extra spaces do not matter (the policy has none). */
function optionMatches(optionText, make, model) {
  const line = withoutBars(optionText);
  const wanted = withoutBars(`${make || ""} ${model || ""}`);
  return Boolean(wanted) && line.includes(wanted);
}

// ---- reading the list in the page -----------------------------------------------------------------------------

const READ_VISIBLE_LINES = `
  var listSelector = '#' + arguments[0] + '_listbox li, .k-animation-container li, ul.k-list li, .k-list-container li';
  var out = [];
  var els = document.querySelectorAll(listSelector);
  for (var i = 0; i < els.length; i++) {
    if (els[i].offsetParent === null) continue;
    out.push((els[i].textContent || '').replace(/\\s+/g, ' ').trim());
  }
  return out;
`;

// Moves the scrolling part of the list down by most of its height; says whether it is at the bottom afterwards.
const SCROLL_LIST_DOWN = `
  var listSelector = '#' + arguments[0] + '_listbox li, .k-animation-container li, ul.k-list li, .k-list-container li';
  var els = document.querySelectorAll(listSelector);
  var first = null;
  for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) { first = els[i]; break; } }
  if (!first) return { found: false, atBottom: true };
  var box = first.parentElement;
  while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 2)) box = box.parentElement;
  if (!box || box === document.body) return { found: true, atBottom: true };
  var before = box.scrollTop;
  box.scrollTop = before + Math.max(40, Math.floor(box.clientHeight * 0.8));
  return { found: true, atBottom: box.scrollTop + box.clientHeight >= box.scrollHeight - 2 || box.scrollTop === before };
`;

// Moves the list's scrolling part back to its first line (the previous search may have left it at the bottom).
const SCROLL_LIST_TO_TOP = `
  var listSelector = '#' + arguments[0] + '_listbox li, .k-animation-container li, ul.k-list li, .k-list-container li';
  var els = document.querySelectorAll(listSelector);
  var first = null;
  for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) { first = els[i]; break; } }
  if (!first) return { found: false, top: true };
  var box = first.parentElement;
  while (box && box !== document.body && !(box.scrollHeight > box.clientHeight + 2)) box = box.parentElement;
  if (!box || box === document.body) return { found: true, top: true };
  box.scrollTop = 0;
  return { found: true, top: box.scrollTop === 0 };
`;

const sleep = (driver, ms) => (driver && driver.sleep ? driver.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

/**
 * Type the Make in the box, read EVERY suggestion (scrolling the list - Kendo lists load or draw more as they move),
 * then empty the box again. Nothing is picked.
 *
 * @returns {Promise<string[]>} each distinct line once, in the order seen
 */
async function readSuggestionLines(driver, make, { log = () => {}, inputId = INPUT_ID, listWaitMs = 15000, maxRounds = 400 } = {}) {
  const { By, until } = require("selenium-webdriver");
  const input = await driver.wait(until.elementLocated(By.id(inputId)), 10000);
  await driver.wait(until.elementIsVisible(input), 5000);
  await driver.wait(until.elementIsEnabled(input), 5000);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", input);

  // Empty it with events so the list re-triggers, then type like a person (the same steps as selectKendoAutocomplete).
  const empty = "arguments[0].value = ''; arguments[0].dispatchEvent(new Event('input', { bubbles: true }));";
  await driver.executeScript(empty, input);
  await sleep(driver, 300);
  // The OLD search's list may still be on screen: give it a moment to close, so it cannot be read as the new one.
  for (let i = 0; i < 8; i++) {
    const old = await driver.executeScript(READ_VISIBLE_LINES, inputId);
    if (!old || old.length === 0) break;
    await sleep(driver, 300);
  }
  await input.click();
  await input.sendKeys(make);
  await driver.executeScript(
    "var el = arguments[0]; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('keyup', { bubbles: true }));",
    input
  );

  // Reliance fills the list a moment after the typing (the owner, 2026-11-14: "wait for the data to change on the
  // dropdown, then only the data appears"). A list is the NEW search's only when every line shows the typed Make; a list
  // of lines without it is still the old one (or still loading) and is not read. Then it must hold still for two looks.
  const wanted = withoutBars(make);
  const belongs = (line) => withoutBars(line).includes(wanted);
  const seen = new Set();
  const order = [];
  const take = (lines) => {
    let added = 0;
    for (const line of lines || []) {
      if (!line || seen.has(line) || !belongs(line)) continue;
      seen.add(line);
      order.push(line);
      added += 1;
    }
    return added;
  };
  const isNew = (lines) => Array.isArray(lines) && lines.length > 0 && lines.every(belongs);
  const deadline = Date.now() + listWaitMs;
  let waited = 0;
  while (Date.now() < deadline && order.length === 0) {
    const first = await driver.executeScript(READ_VISIBLE_LINES, inputId);
    if (isNew(first)) {
      await sleep(driver, 700);
      const again = await driver.executeScript(READ_VISIBLE_LINES, inputId);
      if (isNew(again) && again.length === first.length) {
        take(again);
        break;
      }
    } else {
      waited += 1;
      if (waited % 10 === 0) log(`${make}: waiting for the list to show ${make} ...`);
      await sleep(driver, 400);
    }
  }
  if (order.length === 0) {
    await driver.executeScript(empty, input).catch(() => {});
    return order;
  }

  // Start from the TOP: the list of the search before may have been left scrolled down, and this one opens at that
  // place (the owner, 2026-11-14: "search and come to the top, then start the download"). Back to the top, wait for the
  // lines there to draw, read them, then walk down.
  for (let i = 0; i < 4; i++) {
    const at = await driver.executeScript(SCROLL_LIST_TO_TOP, inputId);
    await sleep(driver, 500);
    take(await driver.executeScript(READ_VISIBLE_LINES, inputId));
    if (!at || at.top !== false) break;
  }

  // Walk the list down until it stops giving new lines (twice in a row at the bottom)
  let quiet = 0;
  for (let round = 1; round <= maxRounds && quiet < 2; round++) {
    const moved = await driver.executeScript(SCROLL_LIST_DOWN, inputId);
    await sleep(driver, 350);
    const added = take(await driver.executeScript(READ_VISIBLE_LINES, inputId));
    if (added === 0 && moved && moved.atBottom) quiet += 1;
    else quiet = 0;
    if (round % 20 === 0) log(`${make}: ${order.length} lines read so far...`);
  }

  await driver.executeScript(empty, input).catch(() => {});
  return order;
}

/**
 * Search one Make and turn its suggestions into Models.
 *
 * @returns {Promise<{make:string, lines:number, models:Array<{make:string, model:string, portalValue:string}>, skipped:string[], otherMakes:Object<string,number>}>}
 */
async function collectModelsForMake(driver, searchedMake, opts = {}) {
  const lines = await readSuggestionLines(driver, searchedMake, opts);
  const models = [];
  const skipped = [];
  const otherMakes = {}; // make -> how many of its lines this search showed (they are NOT saved by this search)
  const have = new Set();
  for (const line of lines) {
    const one = parseOption(line, searchedMake);
    if (one.skip) {
      skipped.push(one.skip);
      if (one.otherMake) otherMakes[one.otherMake] = (otherMakes[one.otherMake] || 0) + 1;
      continue;
    }
    const key = `${one.make}\u0000${one.model}`;
    if (have.has(key)) continue; // two lines that become one name
    have.add(key);
    models.push({ make: one.make, model: one.model, portalValue: line });
  }
  return { make: cleanName(searchedMake), lines: lines.length, models, skipped, otherMakes };
}

// ---- saving ----------------------------------------------------------------------------------------------------

/**
 * Insert only. A Make or Model that is already in the list is skipped - never updated, never duplicated.
 *
 * @param {Object} db       a mongodb Db (or anything with .collection(name).{find,insertMany})
 * @param {Array<{make:string, model:string, portalValue?:string}>} models
 * @returns {Promise<{makesAdded:number, modelsAdded:number, modelsAlreadyThere:number}>}
 */
async function saveModels(db, models, { company = COMPANY, now = () => new Date(), collections = {} } = {}) {
  // `collections` = another pair of lists (National's "Not able to Find" lists, 2026-11-14); the default is today's lists
  const makes = db.collection(collections.make || "insurerMake");
  const modelsCol = db.collection(collections.model || "insurerModel");
  let makesAdded = 0;
  let modelsAdded = 0;
  let modelsAlreadyThere = 0;

  const makeNames = [...new Set(models.map((m) => cleanName(m.make)).filter(Boolean))];
  for (const make of makeNames) {
    // The Make first - a duplicate (a unique index on company + makeKey) is the answer "already there", not an error.
    try {
      await makes.insertOne({
        company,
        make,
        makeKey: make,
        portalValue: "",
        isEnabled: true,
        source: SOURCE,
        createdAt: now(),
      });
      makesAdded += 1;
    } catch (error) {
      if (!(error && error.code === 11000)) throw error;
    }

    const docs = models
      .filter((m) => cleanName(m.make) === make)
      .map((m) => {
        const model = cleanName(m.model);
        return {
          company,
          make,
          makeKey: make,
          model,
          modelKey: model,
          portalValue: String(m.portalValue || "").trim(),
          isEnabled: true,
          source: SOURCE,
          createdAt: now(),
        };
      })
      .filter((d) => d.model && !d.model.includes("|"));
    if (!docs.length) continue;
    try {
      const result = await modelsCol.insertMany(docs, { ordered: false });
      const inserted = result && typeof result.insertedCount === "number" ? result.insertedCount : docs.length;
      modelsAdded += inserted;
      modelsAlreadyThere += docs.length - inserted;
    } catch (error) {
      if (!(error && (error.code === 11000 || (error.writeErrors && error.writeErrors.every((w) => w.code === 11000))))) throw error;
      // insertMany({ordered:false}) writes the rest and reports the duplicates
      const inserted = typeof error.result?.insertedCount === "number"
        ? error.result.insertedCount
        : typeof error.insertedCount === "number"
        ? error.insertedCount
        : docs.length - (error.writeErrors ? error.writeErrors.length : 1);
      modelsAdded += inserted;
      modelsAlreadyThere += docs.length - inserted;
    }
  }
  return { makesAdded, modelsAdded, modelsAlreadyThere };
}

// ---- the customer the run walks through -------------------------------------------------------------------------

/**
 * The job data the Reliance flow needs to get from the login to the make/model box: the policy's customer and address
 * (the same fields server.js buildFormDataFromPolicy gives the full flow), the portal login, and NOTHING that points
 * back at the policy - no _id / policyId / _jobId - so the run cannot read or write the policy's payment note, stages
 * or files, and has no job to hold. Only userId / clientId stay (the log line "Job clientId").
 */
function buildCollectorData(policy, creds, { formatDate = (d) => d } = {}) {
  const p = policy || {};
  return {
    userId: p.userId,
    clientId: p.clientId,
    username: creds.username,
    password: creds.password,
    loginUrl: creds.loginUrl,
    Companyname: "reliance",
    policyType: "",
    proposerTitle: p.proposerTitle || "Mr.",
    firstName: p.fullName || p.firstName,
    middleName: p.middleName || "",
    lastName: p.surname || p.lastName,
    dob: formatDate(p.dateOfBirth),
    gender: p.gender,
    fatherTitle: p.fatherTitle || "Mr.",
    fatherName: p.fatherName,
    flatNo: p.flatDoorNo,
    flatDoorNo: p.flatDoorNo,
    floorNo: p.floorNo,
    premisesName: p.buildingName,
    buildingName: p.buildingName,
    blockNo: p.blockName || p.blockNo,
    blockName: p.blockName,
    road: p.roadStreetLane || p.road,
    roadStreetLane: p.roadStreetLane,
    areaAndLocality: p.areaAndLocality || p.area || p.locality || "",
    state: p.state == "TAMILNADU" ? "30" : p.state == "KARNATAKA" ? "26" : "30",
    customerState: p.state ? String(p.state).trim() : "",
    pinCode: p.pincode,
    mobile: p.mobileNumber,
    email: p.email,
    aadhar: p.aadhar,
  };
}

module.exports = {
  COMPANY,
  buildCollectorData,
  INPUT_ID,
  SOURCE,
  cleanName,
  withoutBars,
  parseOption,
  optionMatches,
  readSuggestionLines,
  collectModelsForMake,
  saveModels,
};
