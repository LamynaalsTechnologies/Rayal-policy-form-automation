/**
 * National Make / Model / Variant collector (2026-11-14, the owner's request, "like the KSHEMA one, 10 windows"). Run ONCE by
 * hand (scripts/nationalCollectModels.js); it is not part of any policy run. Also the dropdown reader of the RTO location
 * collector (lib/nationalRtoCollect.js).
 *
 * National's RTO, Make, Model and Variant are mat-autocomplete TEXT INPUTS (not mat-select): the normal flow only ever types
 * into them (fullPolicycompany/national.js selectAutocompleteOption, which clicks the FIRST option when nothing matches - this
 * collector never uses it). Here:
 *   readAutocompleteOptions  focus the box and read EVERY option (the list that opens at once, scrolled to its end; a box that
 *                            shows nothing until typed is read by typing A-Z and 0-9 and joining the answers). Picks nothing.
 *   pickAutocompleteExact    type the exact text and click the option whose text EQUALS it (never "contains", never "first
 *                            option"), then read the box back.
 *
 * The walk of ONE window, strictly:   pick the RTO -> read the Make list -> take the next make nobody has taken (shared queue)
 *   -> pick the make -> read ALL its Models -> save the Make and its Models -> for each Model in turn: pick it -> read ITS
 *   Variants -> save them -> the next Model -> when the last Model is done, the next make.
 * Several windows share one queue (createWorkQueue from lib/kshemaModelCollect.js), so a make is done by exactly one window.
 * A make that fails is put back once, then reported; a window whose last 3 makes all failed stops.
 *
 * Insert only (insurerMake / insurerModel via lib/relianceModelCollect saveModels, insurerVariant via saveVariants): a name
 * already there is skipped, never changed, never repeated. Nothing else on the National form is filled and nothing is saved at
 * National. No browser starts and no database opens here: the driver, the form helpers (`ctx`) and the Mongo `db` come in, so
 * the tests use fakes (test/nationalModelCollect.test.js). The hook that hands them over is one inert block in
 * fullPolicycompany/national.js (and its identical twin in the TP copy): a queued job carries plain data, never a function.
 */

const { cleanName, saveModels } = require("./relianceModelCollect");
const { CollectError, createWorkQueue, newTotals, closestNames, saveVariants } = require("./kshemaModelCollect");

const COMPANY = "National";
/**
 * Where the lists are saved. "normal" = National's normal lists (insurerMake / insurerModel / insurerVariant). "notFound" = the
 * lists the portal shows when its "Not able to Find the required Model & Variant" box is ticked (2026-11-14): three SEPARATE
 * collections (RayalBrokers-backend Model/insurerMakeNotFound.js ...), so the same name can be in both and nothing collides.
 */
const LISTS = {
  normal: { make: "insurerMake", model: "insurerModel", variant: "insurerVariant" },
  notFound: { make: "insurerMakeNotFound", model: "insurerModelNotFound", variant: "insurerVariantNotFound" },
};
const listsOf = (list) => (list === "notFound" ? LISTS.notFound : LISTS.normal);
/** The portal's own input names (kept here, never in the flow's hook, so the National TP sync guards stay untouched). */
const NAMES = {
  rto: "mcy_dropdown_newRtoLocation_01",
  make: "mcy_dropdown_make_01",
  model: "mcy_dropdown_model_01",
  variant: "mcy_dropdown_variant_01",
};
const SEARCH_TOKENS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("");

const sleep = (driver, ms) => (driver && driver.sleep ? driver.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
const plain = (text) => String(text == null ? "" : text).replace(/:/g, " -").replace(/\s+/g, " ").trim();

// ---- in the page ------------------------------------------------------------------------------------------------------

const OPTION_SELECTOR = ".cdk-overlay-container mat-option";

const READ_OPTIONS = `
  var out = [];
  var els = document.querySelectorAll(${JSON.stringify(OPTION_SELECTOR)});
  for (var i = 0; i < els.length; i++) {
    if (els[i].offsetParent === null) continue;
    out.push((els[i].textContent || '').replace(/\\s+/g, ' ').trim());
  }
  return out;
`;

// Moves the open autocomplete panel to its end; true when it moved (so more options may have been drawn)
const SCROLL_PANEL_DOWN = `
  var panels = document.querySelectorAll(".cdk-overlay-container .mat-mdc-autocomplete-panel, .cdk-overlay-container .mat-autocomplete-panel");
  var moved = false;
  for (var i = 0; i < panels.length; i++) {
    var p = panels[i];
    if (p.scrollHeight > p.clientHeight + 2 && p.scrollTop + p.clientHeight < p.scrollHeight - 2) { p.scrollTop = p.scrollHeight; moved = true; }
  }
  return moved;
`;

const EMPTY_INPUT = `
  var el = arguments[0];
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
`;

const CLOSE_PANEL = `
  var el = arguments[0];
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  el.blur();
`;

// Click the visible option whose text EQUALS the wanted one; otherwise say what was offered. Never the first option.
const CLICK_EXACT = `
  var norm = function (t) { return String(t || '').replace(/\\s+/g, ' ').trim().toUpperCase(); };
  var wanted = norm(arguments[0]);
  var els = document.querySelectorAll(${JSON.stringify(OPTION_SELECTOR)});
  var offered = [];
  for (var i = 0; i < els.length; i++) {
    if (els[i].offsetParent === null) continue;
    var text = norm(els[i].textContent);
    offered.push(text);
    if (text === wanted) { els[i].scrollIntoView({ block: 'nearest' }); els[i].click(); return { clicked: true, offered: offered }; }
  }
  return { clicked: false, offered: offered };
`;

// The portal throws up popups (a Material dialog with a dark backdrop) after some picks. An open popup blocks every click on the
// page ("element click intercepted ... Other element would receive the click" - seen live 2026-11-14, it stopped 4 of 10 windows).
// Same dialog selector and button rules as national.js dismissPortalDialog: the portal's own close button by name, then a
// Close / OK button, last resort the first button inside the dialog. Its text is returned so the log can say what it was.
const POPUP_SELECTOR = "mat-dialog-container, .mat-mdc-dialog-container, [role='dialog'], [role='alertdialog'], .modal.show";
const DISMISS_POPUP = `
  var visible = function (el) {
    var st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    if (parseFloat(st.opacity || '1') < 0.05) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  var dialogs = Array.prototype.filter.call(document.querySelectorAll(arguments[0]), visible);
  if (!dialogs.length) return { found: false };
  var d = dialogs[dialogs.length - 1];
  var text = (d.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
  var buttons = Array.prototype.slice.call(d.querySelectorAll('button'));
  var label = function (b) { return (b.textContent || '').replace(/\\s+/g, ' ').trim().toUpperCase(); };
  var pick =
    buttons.find(function (b) { return b.getAttribute('name') === 'alert_btn_data_01' && label(b).indexOf('CLOSE') > -1; }) ||
    buttons.find(function (b) { return b.getAttribute('name') === 'alert_btn_data_01'; }) ||
    buttons.find(function (b) { return b.getAttribute('name') === 'confirm_btn_yes_01'; }) ||
    buttons.find(function (b) { return label(b).indexOf('CLOSE') > -1; }) ||
    buttons.find(function (b) { return label(b).indexOf('OK') > -1; }) ||
    buttons[0];
  if (!pick) return { found: true, text: text, clicked: false };
  pick.click();
  return { found: true, text: text, clicked: true, button: label(pick).slice(0, 30) };
`;

/**
 * Close every popup that is open (up to 4, one after the other - closing one can show the next). Says what it closed in the log
 * and counts the texts in `popups` (text -> times), so the end of the run can tell what the portal keeps showing.
 *
 * @returns {Promise<number>} how many popups were closed
 */
async function clearPopups(driver, ctx, { log = () => {}, popups = null } = {}) {
  let closed = 0;
  for (let i = 0; i < 4; i++) {
    let res;
    try {
      res = await driver.executeScript(DISMISS_POPUP, POPUP_SELECTOR);
    } catch (e) {
      return closed; // the window may be gone: the next step says so
    }
    if (!res || !res.found) return closed;
    if (!res.clicked) {
      log(`A popup is open and has no button to close it: "${plain(res.text)}"`);
      return closed;
    }
    closed += 1;
    const text = plain(res.text) || "(no text)";
    if (popups) popups[text] = (popups[text] || 0) + 1;
    if (!popups || popups[text] <= 2) log(`  popup closed (${res.button || "button"}): "${text}"`); // the same popup is said twice, then counted
    await sleep(driver, 350);
    try {
      await ctx.waitForOverlayGone(driver, 2500);
    } catch (e) { /* ignore */ }
  }
  return closed;
}

/** A click that a popup blocked is retried after the popup is closed; a last resort focuses and clicks from the page itself. */
async function clickInput(driver, ctx, input, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await input.click();
      return;
    } catch (error) {
      const message = String((error && error.message) || error);
      if (!/intercepted|not interactable|obscured/i.test(message)) throw error;
      await clearPopups(driver, ctx, opts);
      await sleep(driver, 300);
    }
  }
  await driver.executeScript("arguments[0].focus(); arguments[0].click();", input);
}

async function findInput(driver, ctx, name, label) {
  try {
    const input = await driver.wait(ctx.until.elementLocated(ctx.By.name(name)), 15000);
    await driver.wait(ctx.until.elementIsVisible(input), 15000);
    await driver.wait(ctx.until.elementIsEnabled(input), 15000);
    return input;
  } catch (e) {
    throw new CollectError(`The ${label} box is not on the page or is not enabled, so its choices could not be read.`);
  }
}

const unique = (texts) => {
  const seen = new Set();
  const out = [];
  for (const t of texts || []) {
    const key = cleanName(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
};

/** The options on screen, waiting up to `waitMs` for the first to appear. */
async function waitForOptions(driver, waitMs) {
  const deadline = Date.now() + waitMs;
  let texts = [];
  do {
    texts = await driver.executeScript(READ_OPTIONS);
    if (texts && texts.length) return texts;
    await sleep(driver, 150);
  } while (Date.now() < deadline);
  return [];
}

/** Everything the open panel holds, scrolled to its end until no new options are drawn. */
async function readWholePanel(driver, first) {
  let texts = first || (await driver.executeScript(READ_OPTIONS)) || [];
  for (let round = 0; round < 40; round++) {
    const moved = await driver.executeScript(SCROLL_PANEL_DOWN);
    if (!moved) break;
    await sleep(driver, 250);
    const before = unique(texts).length;
    texts = [...texts, ...((await driver.executeScript(READ_OPTIONS)) || [])];
    if (unique(texts).length === before) break;
  }
  return unique(texts);
}

/**
 * Focus an autocomplete box and read EVERY option it offers. Nothing is picked; the box is emptied and closed again.
 *
 * The list that opens at once (National's RTO box does) is read as it is, scrolled to its end, and must hold still for two looks
 * in a row (a list still being replaced - the old make's models while the new ones load - is not taken). A box that shows
 * nothing until something is typed is read by typing each of A-Z and 0-9 and joining what comes back.
 *
 * @returns {Promise<string[]>} the distinct option texts, as the portal writes them
 */
async function readAutocompleteOptions(driver, ctx, inputName, label, { log = () => {}, tokens = SEARCH_TOKENS, openWaitMs = 4000, searchWaitMs = 900, popups = null } = {}) {
  await clearPopups(driver, ctx, { log, popups });
  const input = await findInput(driver, ctx, inputName, label);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", input);
  await driver.executeScript(EMPTY_INPUT, input);
  await sleep(driver, 200);
  await clickInput(driver, ctx, input, { log, popups });

  try {
    let first = await waitForOptions(driver, openWaitMs);
    if (first.length) {
      let previous = null;
      let texts = first;
      for (let look = 0; look < 5; look++) {
        const now = await readWholePanel(driver, look === 0 ? first : null);
        const keys = now.map(cleanName).sort().join("\u0000");
        texts = now;
        if (previous !== null && keys === previous) break;
        previous = keys;
        await sleep(driver, 250);
      }
      return unique(texts);
    }

    // shows nothing until typed: A-Z and 0-9
    log(`${label}: the list shows only after typing - reading it by A-Z and 0-9 ...`);
    const joined = [];
    for (const token of tokens) {
      await driver.executeScript(EMPTY_INPUT, input);
      await input.sendKeys(token);
      await driver.executeScript("arguments[0].dispatchEvent(new Event('input', { bubbles: true }));", input);
      const got = await waitForOptions(driver, searchWaitMs);
      if (got.length) joined.push(...(await readWholePanel(driver, got)));
    }
    return unique(joined);
  } finally {
    try {
      await driver.executeScript(EMPTY_INPUT, input);
      await driver.executeScript(CLOSE_PANEL, input);
      await ctx.waitForOverlayGone(driver, 3000);
    } catch (e) { /* the window may be gone */ }
    await sleep(driver, 150);
  }
}

const keysOf = (texts) => (texts || []).map(cleanName).sort().join("\u0000");

/**
 * Read a list that FOLLOWS a pick (the models of the make just picked, the variants of the model just picked). The portal can
 * keep showing the PREVIOUS list for a moment, and a stale list saved under the new name is wrong data - so a list that is
 * identical to the previous one is read again, every 0.7 s, until it changes or `waitMs` is over.
 *
 * @returns {Promise<{texts:string[], stale:boolean}>}  stale = it was still the same as the previous list after the wait
 */
async function readFollowingList(driver, ctx, inputName, label, { previousKeys = null, waitMs = 6000, log = () => {}, read = {} } = {}) {
  const deadline = Date.now() + waitMs;
  let texts = await readAutocompleteOptions(driver, ctx, inputName, label, { log, ...read });
  while (previousKeys !== null && texts.length && keysOf(texts) === previousKeys && Date.now() < deadline) {
    await sleep(driver, 700);
    texts = await readAutocompleteOptions(driver, ctx, inputName, label, { log, ...read });
  }
  return { texts, stale: previousKeys !== null && texts.length > 0 && keysOf(texts) === previousKeys };
}

/**
 * Type the exact text into an autocomplete box and click the option whose text EQUALS it; then wait for the portal and read
 * the box back. A near name is refused (the portal's "closest option" fallback is exactly what a collector must not do).
 */
async function pickAutocompleteExact(driver, ctx, inputName, text, label, { log = () => {}, popups = null } = {}) {
  await clearPopups(driver, ctx, { log, popups });
  const input = await findInput(driver, ctx, inputName, label);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", input);
  await driver.executeScript(EMPTY_INPUT, input);
  await sleep(driver, 200);
  await clickInput(driver, ctx, input, { log, popups });
  await input.sendKeys(String(text));
  await driver.executeScript("arguments[0].dispatchEvent(new Event('input', { bubbles: true }));", input);

  let result = { clicked: false, offered: [] };
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    result = await driver.executeScript(CLICK_EXACT, String(text));
    if (result && result.clicked) break;
    await sleep(driver, 250);
  }
  if (!result || !result.clicked) {
    try {
      await driver.executeScript(EMPTY_INPUT, input);
      await driver.executeScript(CLOSE_PANEL, input);
    } catch (e) { /* ignore */ }
    const offered = (result && result.offered && result.offered.length ? result.offered.slice(0, 8).join(", ") : "nothing");
    throw new CollectError(`The ${label} "${text}" could not be chosen - the portal offered ${offered}.`);
  }

  await ctx.waitForOverlayGone(driver, 3000);
  await ctx.waitForPortalIdle(driver, 40000, 600);
  await clearPopups(driver, ctx, { log, popups }); // a popup the pick brought up ("Popup appeared") must not block the next click
  const value = await driver.executeScript("return arguments[0].value;", input);
  if (cleanName(value) !== cleanName(text)) {
    throw new CollectError(`The ${label} shows "${value}" after choosing "${text}", so the walk stopped before reading the wrong list.`);
  }
  return value;
}

// ---- the walk ---------------------------------------------------------------------------------------------------------

const ensureTotals = (totals) => {
  const base = newTotals();
  for (const key of Object.keys(base)) if (totals[key] === undefined) totals[key] = base[key];
  if (!totals.popups) totals.popups = {}; // popup text -> how many times the portal showed it (all windows)
  return totals;
};

/** The policy's RTO the way the National flow types it: "City - Region", or the city alone. */
function rtoTextOf(data) {
  const own = String((data && data.nationalRto) || "").trim(); // National's own location picked on the policy
  if (own) return own;
  const city = String((data && data.RTOCity) || "").trim();
  const region = String((data && data.RTORegion) || "").trim();
  if (!city) return "";
  return region ? `${city} - ${region}` : city;
}

/**
 * One make, start to end: pick it, read ALL its models, then each model in turn - pick it, read ITS variants, save, next model.
 * A model is saved only AFTER the portal accepted picking it under this make (so a stale list can never put another make's
 * models under this one); the Make row is saved with its first confirmed model.
 */
async function walkOneMake(driver, ctx, { makeText, label, db, log, read, totals, memory, list }) {
  const makeName = cleanName(makeText);
  const started = Date.now();
  log(`${label} ${makeName}: choosing the make ...`);
  await pickAutocompleteExact(driver, ctx, NAMES.make, makeText, "Make", { log, popups: totals.popups });

  const models = await readFollowingList(driver, ctx, NAMES.model, "Model", { previousKeys: memory.modelKeys, waitMs: read.staleWaitMs || 6000, log, read: { ...read, popups: totals.popups } });
  if (models.stale) {
    throw new CollectError(`The Model list for ${makeName} still shows the previous make's models after 6 s, so it was not read.`);
  }
  const modelTexts = models.texts;
  if (!modelTexts.length) {
    totals.makesWithoutModels.push(makeName);
    log(`${makeName}: National listed no models for this make.`);
    return false;
  }
  memory.modelKeys = keysOf(modelTexts);
  log(`${makeName}: ${modelTexts.length} models.`);

  let makeAdded = 0;
  for (let j = 0; j < modelTexts.length; j++) {
    const modelText = modelTexts[j];
    const modelName = cleanName(modelText);
    const modelStarted = Date.now();
    await pickAutocompleteExact(driver, ctx, NAMES.model, modelText, "Model", { log, popups: totals.popups }); // the portal confirms it belongs to this make
    const savedModel = await saveModels(db, [{ make: makeName, model: modelText }], { company: COMPANY, collections: listsOf(list) });
    makeAdded += savedModel.makesAdded;
    totals.makesAdded += savedModel.makesAdded;
    totals.modelsAdded += savedModel.modelsAdded;
    totals.modelsAlreadyThere += savedModel.modelsAlreadyThere;

    const variants = await readFollowingList(driver, ctx, NAMES.variant, "Variant", { previousKeys: memory.variantKeys, waitMs: read.variantStaleWaitMs || 2500, log, read: { ...read, popups: totals.popups } });
    const variantTexts = variants.texts;
    const seconds = ((Date.now() - modelStarted) / 1000).toFixed(1);
    if (!variantTexts.length) {
      memory.variantKeys = null;
      totals.modelsWithoutVariants += 1;
      log(`  ${makeName} model ${j + 1}/${modelTexts.length} ${modelName}: no variants listed (${seconds} s).`);
      continue;
    }
    memory.variantKeys = keysOf(variantTexts);
    const savedVariants = await saveVariants(db, variantTexts.map((v) => ({ make: makeName, model: modelName, variant: v })), { company: COMPANY, collection: listsOf(list).variant });
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
 * @param {Object} driver
 * @param {Object} ctx  { By, until, waitForPortalIdle, waitForOverlayGone }  (handed over by the flow's hook)
 * @param {Object} o    { makes, db, data, log, totals, queue, read, list }  (`read` = test knobs: tokens, openWaitMs, searchWaitMs; `list` = "normal" | "notFound")
 */
async function collectNational(driver, ctx, { makes = [], db, data = {}, log = () => {}, totals = {}, queue = createWorkQueue(), read = {}, list = "normal" } = {}) {
  ensureTotals(totals);
  const rtoText = rtoTextOf(data);
  if (!rtoText) throw new CollectError("This policy has no RTO city, so National's Make list could not be reached. Choose an RTO on the policy and run again.");

  log(`Choosing the RTO "${rtoText}" (Make, Model and Variant open only after it) ...`);
  await pickAutocompleteExact(driver, ctx, NAMES.rto, rtoText, "RTO location", { log, popups: totals.popups });

  log("Reading the Make list ...");
  const makeTexts = await readAutocompleteOptions(driver, ctx, NAMES.make, "Make", { log, ...read, popups: totals.popups });
  if (!makeTexts.length) throw new CollectError("National's Make box listed no makes.");
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
          log(`${cleanName(typed)}: National has no make with exactly this name` + (near.length ? ` - names like it: ${near.join(", ")}` : "") + ".");
        }
      }
    }
    queue.targets = targets;
    log(`${targets.length} makes to do - every window takes the next make nobody has taken.`);
  }

  let failedInARow = 0;
  const memory = { modelKeys: null, variantKeys: null }; // what this window read last (a list that has not changed since is suspect)
  for (let item = queue.take(); item; item = queue.take()) {
    const label = item.again ? "[again]" : `[${item.n}/${queue.total()}]`;
    try {
      const done = await walkOneMake(driver, ctx, { makeText: item.text, label, db, log, read, totals, memory, list });
      if (done) totals.makesDone += 1;
      failedInARow = 0;
    } catch (error) {
      const makeName = cleanName(item.text);
      const reason = plain((error && error.message) || error);
      failedInARow += 1;
      try {
        await clearPopups(driver, ctx, { log, popups: totals.popups }); // an open popup is what blocks every next click
        await driver.executeScript("var a = document.activeElement; if (a && a.blur) a.blur();");
        await ctx.waitForOverlayGone(driver, 3000);
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
  LISTS,
  listsOf,
  NAMES,
  SEARCH_TOKENS,
  readAutocompleteOptions,
  readFollowingList,
  pickAutocompleteExact,
  clearPopups,
  rtoTextOf,
  collectNational,
  // the scripts that run inside the portal's page - exported so the tests can run them on a fake page
  _scripts: { READ_OPTIONS, SCROLL_PANEL_DOWN, EMPTY_INPUT, CLOSE_PANEL, CLICK_EXACT, DISMISS_POPUP },
  POPUP_SELECTOR,
};
