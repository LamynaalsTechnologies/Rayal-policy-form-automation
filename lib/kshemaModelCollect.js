/**
 * KSHEMA Make / Model / Variant collector (2026-11-14, the owner's request). Run ONCE by hand
 * (scripts/kshemaCollectModels.js) to fill the Vehicle Model lists for KSHEMA; it is not part of any policy run.
 *
 * The walk, strictly in this order:
 *
 *   Make dropdown (ONE list of every make)
 *     pick a make  ->  read ALL its Models  ->  save the Make and its Models
 *       for each Model in turn: pick it  ->  read ITS Variants  ->  save them
 *       (the next Model only after this one is saved)
 *     the last Model of the make is done  ->  the next make
 *
 * Nothing else on the KSHEMA form is touched: it sets "Is New Vehicle?" to Yes (the portal shows Make / Model / Variant
 * only then), picks Make / Model, and only OPENS the Variant list to read it. It never fills another field and never
 * presses Save. Saving is insert only (insurerMake / insurerModel via lib/relianceModelCollect saveModels, insurerVariant
 * here): a name already there is skipped, never changed, never repeated.
 *
 * Several windows (2026-11-14, the owner: "5 screens, and not the same make on each screen"): each window runs this same walk
 * and takes its next make from ONE shared queue (createWorkQueue), so a make is done by exactly one window.
 *
 * This file starts no browser and opens no database: the driver, the form helpers (`ctx`) and the Mongo `db` come in, so
 * the tests use fakes (test/kshemaModelCollect.test.js). The hook that hands them over is one inert line in
 * fullPolicycompany/kshemaForm.js (a queued job can never carry a function, so a normal run never reaches it).
 */

const { cleanName, saveModels } = require("./relianceModelCollect");

const COMPANY = "KSHEMA";
const SOURCE = "automation"; // the Vehicle Model page shows it as "Policy run"
/** The words typed into a panel's search box, one by one, when its list is EMPTY until something is typed. */
const SEARCH_TOKENS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

const sleep = (driver, ms) => (driver && driver.sleep ? driver.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
/** An operator-facing sentence has no colon (the app keeps only the text after the last one). */
const plain = (text) => String(text == null ? "" : text).replace(/:/g, " -").replace(/\s+/g, " ").trim();

class CollectError extends Error {
  constructor(message) {
    super(plain(message));
    this.name = "CollectError";
    this.nonRetryable = true;
  }
}

// ---- reading one dropdown ------------------------------------------------------------------------------------------

/** Moves the open panel's scrolling part to its end; true when it moved (so more options may have been drawn). */
const SCROLL_PANEL_DOWN = `
  var panels = document.querySelectorAll(".cdk-overlay-container .mat-mdc-select-panel, .cdk-overlay-container div[role='listbox']");
  var moved = false;
  for (var i = 0; i < panels.length; i++) {
    var p = panels[i];
    if (p.scrollHeight > p.clientHeight + 2 && p.scrollTop + p.clientHeight < p.scrollHeight - 2) { p.scrollTop = p.scrollHeight; moved = true; }
  }
  return moved;
`;

async function optionTexts(options) {
  const texts = [];
  for (const option of options || []) {
    try {
      texts.push(String(await option.getText()).replace(/\s+/g, " ").trim());
    } catch (e) {
      texts.push(""); // re-rendered while it was read: the next read has it
    }
  }
  return texts;
}

const unique = (texts) => {
  const seen = new Set();
  const out = [];
  for (const t of texts) {
    const key = cleanName(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
};

/** The options on screen right now, scrolled to the end until no more are drawn. */
async function readPanel(driver, F, { first = null } = {}) {
  let texts = first || (await optionTexts((await F.collectOptions(driver, 2500)).options));
  for (let round = 0; round < 30; round++) {
    const moved = await driver.executeScript(SCROLL_PANEL_DOWN);
    if (!moved) break;
    await sleep(driver, 350);
    const more = await optionTexts((await F.collectOptions(driver, 2500)).options);
    const before = unique(texts).length;
    texts = [...texts, ...more];
    if (unique(texts).length === before) break;
  }
  return unique(texts);
}

/**
 * Open a mat-select and read EVERY option it offers, then close it. Nothing is picked.
 *
 * A panel whose list is empty until something is typed (Make and Model have a search box) is read by typing each of
 * A-Z and 0-9 and joining what comes back. A panel that shows its list at once is read as it is. The read is repeated
 * until two looks in a row agree, so a list that is still being replaced (the old make's models while the new ones load)
 * is not taken.
 *
 * @returns {Promise<string[]>} the distinct option texts, as the portal writes them
 */
async function readOptions(driver, ctx, selectors, label, { searchable = false, log = () => {}, tokens = SEARCH_TOKENS, searchWaitMs = 900 } = {}) {
  const F = ctx.kshemaFields;
  const found = await F.findVisible(driver, selectors);
  if (!found || !found.element) {
    throw new CollectError(`The ${label} dropdown is not on the page, so its choices could not be read.`);
  }

  const open = async () => {
    await F.clickElement(driver, found.element, `the "${label}" dropdown`);
    return F.collectOptions(driver, 8000);
  };
  let opened = await open();
  if (!opened.panelOpened && !(opened.options || []).length) {
    await F.closeOverlay(driver);
    await sleep(driver, 600);
    opened = await open();
  }
  if (!opened.panelOpened && !(opened.options || []).length) {
    await F.closeOverlay(driver);
    throw new CollectError(`The ${label} dropdown did not open its list of choices.`);
  }

  try {
    let texts = await optionTexts(opened.options);
    if (texts.filter(Boolean).length === 0) {
      if (!searchable) {
        // a list the portal fills a moment later: look again once
        await sleep(driver, 1500);
        texts = await optionTexts((await F.collectOptions(driver, 4000)).options);
      }
    }
    if (texts.filter(Boolean).length === 0 && searchable) {
      // empty until typed: read by letters and digits
      log(`${label}: the list shows only after typing - reading it by A-Z and 0-9 ...`);
      const joined = [];
      for (const token of tokens) {
        const searched = await F.searchInPanel(driver, token);
        if (!searched) {
          throw new CollectError(`The ${label} dropdown has no search box and shows no choices, so its list could not be read.`);
        }
        // a letter nothing matches leaves the list empty: that wait is the cost of the letter, so it is kept short
        const got = await F.collectOptions(driver, searchWaitMs);
        joined.push(...(await readPanel(driver, F, { first: await optionTexts(got.options) })));
      }
      texts = joined;
    } else {
      // two looks that agree = the list holds still
      let previous = null;
      for (let look = 0; look < 5; look++) {
        const now = await readPanel(driver, F, { first: texts });
        const keys = now.map(cleanName).sort().join("\u0000");
        if (previous !== null && keys === previous) {
          texts = now;
          break;
        }
        previous = keys;
        texts = now;
        await sleep(driver, 250);
        texts = await optionTexts((await F.collectOptions(driver, 2500)).options);
      }
    }
    return unique(texts);
  } finally {
    await F.closeOverlay(driver);
    await sleep(driver, 150);
  }
}

/** Choose one option by its exact text (the dropdown is searched for it when it has a search box) and read it back. */
async function pickExact(driver, ctx, selectors, text, label, { searchable = false } = {}) {
  const result = await ctx.kshemaFields.selectMatOption(driver, selectors, text, label, { fuzzy: false, searchable, emptyRetryMs: 5000 });
  if (!result || !result.ok) {
    throw new CollectError(`The ${label} "${text}" could not be chosen - ${(result && result.reason) || "no reason given"}.`);
  }
  if (cleanName(result.value) !== cleanName(text)) {
    throw new CollectError(`The ${label} shows "${result.value}" after choosing "${text}", so the walk stopped before reading the wrong list.`);
  }
  await ctx.waitForLoader(driver, 20000);
  await sleep(driver, 400); // the form re-draws the dependent list below it; readOptions then waits for the list to hold still
  return result.value;
}

// ---- saving variants ----------------------------------------------------------------------------------------------

/**
 * Insert only. The Make and the Model must already be saved (saveModels does it first). A variant already there is
 * skipped - never updated, never repeated.
 *
 * @param {Array<{make:string, model:string, variant:string}>} rows
 * @returns {Promise<{variantsAdded:number, variantsAlreadyThere:number}>}
 */
async function saveVariants(db, rows, { company = COMPANY, now = () => new Date() } = {}) {
  const col = db.collection("insurerVariant");
  const seen = new Set();
  const docs = [];
  for (const r of rows || []) {
    const make = cleanName(r.make);
    const model = cleanName(r.model);
    const variant = cleanName(r.variant);
    if (!make || !model || !variant) continue;
    const key = `${make}\u0000${model}\u0000${variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    docs.push({
      company, make, makeKey: make, model, modelKey: model, variant, variantKey: variant,
      isEnabled: true, source: SOURCE, createdAt: now(),
    });
  }
  if (!docs.length) return { variantsAdded: 0, variantsAlreadyThere: 0 };
  let inserted;
  try {
    const result = await col.insertMany(docs, { ordered: false });
    inserted = result && typeof result.insertedCount === "number" ? result.insertedCount : docs.length;
  } catch (error) {
    const dup = error && (error.code === 11000 || (error.writeErrors && error.writeErrors.every((w) => w.code === 11000)));
    if (!dup) throw error;
    inserted = typeof error.result?.insertedCount === "number"
      ? error.result.insertedCount
      : typeof error.insertedCount === "number"
      ? error.insertedCount
      : docs.length - (error.writeErrors ? error.writeErrors.length : 1);
  }
  return { variantsAdded: inserted, variantsAlreadyThere: docs.length - inserted };
}

// ---- the walk ---------------------------------------------------------------------------------------------------

const fieldOf = (ctx, key) => (ctx.vehicleFields || []).find((f) => f.key === key);

/** Names that look like a typed make the portal does not have: they share a word with it. */
function closestNames(wanted, names, max = 10) {
  const words = cleanName(wanted).split(" ").filter((w) => w.length >= 3);
  const near = names.filter((n) => words.some((w) => cleanName(n).includes(w)));
  return near.slice(0, max);
}

/** The totals every window adds to (one object shared by all windows, so a stop still has them). */
function newTotals() {
  return {
    makesDone: 0, makesNotFound: [], makesWithoutModels: [], makesFailed: [],
    makesAdded: 0, modelsAdded: 0, modelsAlreadyThere: 0, variantsAdded: 0, variantsAlreadyThere: 0, modelsWithoutVariants: 0,
  };
}
const ensureTotals = (totals) => {
  const base = newTotals();
  for (const key of Object.keys(base)) if (totals[key] === undefined) totals[key] = base[key];
  return totals;
};

/**
 * The makes still to do, shared by every window. A window takes the next make nobody has taken (`take`), so a make is never
 * done by two windows. A make that failed goes back ONCE (`giveBack`) for any window to try again.
 */
function createWorkQueue() {
  const queue = {
    targets: null, // set once, by the first window that has read the Make list
    next: 0,
    retry: [],
    retried: new Set(),
    taken: [],
    total() {
      return queue.targets ? queue.targets.length : 0;
    },
    take() {
      if (!queue.targets) return null;
      if (queue.retry.length) return { text: queue.retry.shift(), n: null, again: true };
      if (queue.next < queue.targets.length) {
        const text = queue.targets[queue.next++];
        queue.taken.push(text);
        return { text, n: queue.next, again: false };
      }
      return null;
    },
    giveBack(text) {
      if (queue.retried.has(text)) return false;
      queue.retried.add(text);
      queue.retry.push(text);
      return true;
    },
  };
  return queue;
}

/** One make, start to end: pick it, read its models, save, then each model's variants one by one. */
async function walkOneMake(driver, ctx, { makeText, label, fields, db, log, read, totals }) {
  const { makeField, modelField, variantField } = fields;
  const makeName = cleanName(makeText);
  const started = Date.now();
  log(`${label} ${makeName}: choosing the make ...`);
  await pickExact(driver, ctx, makeField.selectors, makeText, "Make", { searchable: true });

  const modelTexts = await readOptions(driver, ctx, modelField.selectors, "Model", { searchable: true, log, ...read });
  if (!modelTexts.length) {
    totals.makesWithoutModels.push(makeName);
    log(`${makeName}: KSHEMA listed no models for this make.`);
    return false;
  }
  const savedModels = await saveModels(db, modelTexts.map((m) => ({ make: makeName, model: m })), { company: COMPANY });
  totals.makesAdded += savedModels.makesAdded;
  totals.modelsAdded += savedModels.modelsAdded;
  totals.modelsAlreadyThere += savedModels.modelsAlreadyThere;
  log(`${makeName}: ${modelTexts.length} models (${savedModels.modelsAdded} new, ${savedModels.modelsAlreadyThere} already there).`);

  for (let j = 0; j < modelTexts.length; j++) {
    const modelText = modelTexts[j];
    const modelName = cleanName(modelText);
    const modelStarted = Date.now();
    await pickExact(driver, ctx, modelField.selectors, modelText, "Model", { searchable: true });
    const variantTexts = await readOptions(driver, ctx, variantField.selectors, "Variant", { searchable: false, log, ...read });
    const seconds = ((Date.now() - modelStarted) / 1000).toFixed(1);
    if (!variantTexts.length) {
      totals.modelsWithoutVariants += 1;
      log(`  ${makeName} model ${j + 1}/${modelTexts.length} ${modelName}: no variants listed (${seconds} s).`);
      continue;
    }
    const savedVariants = await saveVariants(db, variantTexts.map((v) => ({ make: makeName, model: modelName, variant: v })));
    totals.variantsAdded += savedVariants.variantsAdded;
    totals.variantsAlreadyThere += savedVariants.variantsAlreadyThere;
    log(`  ${makeName} model ${j + 1}/${modelTexts.length} ${modelName}: ${variantTexts.length} variants (${savedVariants.variantsAdded} new, ${seconds} s).`);
  }
  log(`${makeName}: done in ${((Date.now() - started) / 60000).toFixed(1)} min.`);
  return true;
}

/**
 * The walk of ONE window. `makes` empty = every make in the dropdown. With several windows they all get the same `queue`,
 * `totals` and `db`: the first window to read the Make list fills the queue, every window takes its next make from it.
 *
 * A make that fails is noted, put back once for another try, and the window goes on to the next make; a window whose
 * last 3 makes all failed stops (the session is probably gone).
 *
 * @param {Object} driver
 * @param {Object} ctx      { kshemaFields, vehicleFields, fillOneField, waitForLoader }  (handed over by the flow's hook)
 * @param {Object} o        { makes, db, data, log, totals, queue, read }  (`read` = test knobs for readOptions: tokens, searchWaitMs)
 * @returns {Promise<Object>} the totals (shared, filled in while it runs, so a stop still has them)
 */
async function collectKshema(driver, ctx, { makes = [], db, data = {}, log = () => {}, totals = {}, queue = createWorkQueue(), read = {} } = {}) {
  ensureTotals(totals);
  const makeField = fieldOf(ctx, "make");
  const modelField = fieldOf(ctx, "model");
  const variantField = fieldOf(ctx, "variant");
  const newVehicleField = fieldOf(ctx, "isNewVehicle");
  if (!makeField || !modelField || !variantField || !newVehicleField) {
    throw new CollectError("The KSHEMA vehicle fields (Is New Vehicle, Make, Model, Variant) are not defined, so nothing was read.");
  }

  // Make, Model and Variant appear only once "Is New Vehicle?" is Yes.
  log("Setting Is New Vehicle to Yes (the portal shows Make, Model and Variant only then) ...");
  const answered = await ctx.fillOneField(driver, data, newVehicleField, "Yes", { capture: null, screenshots: [] });
  if (!answered || !answered.ok) {
    throw new CollectError(`Is New Vehicle could not be set to Yes - ${(answered && answered.reason) || "no reason given"}.`);
  }
  await ctx.waitForLoader(driver, 20000);
  await sleep(driver, 1000);

  log("Reading the Make list ...");
  const makeTexts = await readOptions(driver, ctx, makeField.selectors, "Make", { searchable: true, log, ...read });
  if (!makeTexts.length) throw new CollectError("KSHEMA's Make dropdown listed no makes.");
  log(`The Make list has ${makeTexts.length} makes.`);

  if (queue.targets === null) {
    // the first window to get here decides the work for all of them
    let targets = makeTexts;
    if (makes.length) {
      targets = [];
      for (const typed of makes) {
        const hit = makeTexts.find((t) => cleanName(t) === cleanName(typed));
        if (hit) targets.push(hit);
        else {
          totals.makesNotFound.push(cleanName(typed));
          const near = closestNames(typed, makeTexts);
          log(`${cleanName(typed)}: KSHEMA has no make with exactly this name` + (near.length ? ` - names like it: ${near.join(", ")}` : "") + ".");
        }
      }
    }
    queue.targets = targets;
    log(`${targets.length} makes to do - every window takes the next make nobody has taken.`);
  }

  const fields = { makeField, modelField, variantField };
  let failedInARow = 0;
  for (let item = queue.take(); item; item = queue.take()) {
    const label = item.again ? "[again]" : `[${item.n}/${queue.total()}]`;
    try {
      const done = await walkOneMake(driver, ctx, { makeText: item.text, label, fields, db, log, read, totals });
      if (done) totals.makesDone += 1;
      failedInARow = 0;
    } catch (error) {
      const makeName = cleanName(item.text);
      const reason = plain((error && error.message) || error);
      failedInARow += 1;
      try {
        await ctx.kshemaFields.closeOverlay(driver); // an open panel would cover the page for the next make
      } catch (e) { /* the window may be gone */ }
      if (queue.giveBack(item.text)) {
        log(`${makeName}: stopped - ${reason} It is tried once more.`);
      } else {
        totals.makesFailed.push({ make: makeName, reason });
        log(`${makeName}: stopped again - ${reason} Run the script again for this make.`);
      }
      if (failedInARow >= 3) {
        throw new CollectError(`The last 3 makes in this window all failed, so the window stopped - the last was ${makeName} (${reason})`);
      }
    }
  }
  return totals;
}

module.exports = {
  COMPANY,
  SOURCE,
  SEARCH_TOKENS,
  CollectError,
  readOptions,
  pickExact,
  saveVariants,
  closestNames,
  newTotals,
  createWorkQueue,
  collectKshema,
};
