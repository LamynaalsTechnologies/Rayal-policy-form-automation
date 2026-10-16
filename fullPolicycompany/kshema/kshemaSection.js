/**
 * Fill one section of the KSHEMA quote form — carefully. Shared by the full-company flow (kshemaQuoteForm.js, OD+TP)
 * and the TP-only copy (kshemaTPQuoteForm.js), so the two cannot drift: each passes its own loader wait.
 *
 * Why (2026-10-16): a run "sometimes misses a field and reports an error". Every field helper in kshemaFields.js already
 * waits, retries and reads its value back, but three things still turned a passing hiccup into a failed policy:
 *
 *   1. A field that fails ONCE — the form was mid-rebuild, a list still loading, a stray Selenium exception — failed the
 *      section: there was no second chance once the form had settled. An exception even escaped with a raw message.
 *   2. A field filled and verified could be CLEARED by a later answer (Angular replaces inputs on a re-render). Nothing
 *      looked again, so the portal refused the quote or "Save and Continue" silently did nothing.
 *   3. When Save did nothing, the error said only "there might be a silent validation error" — never which field.
 *
 * So, behind KSHEMA_FIELD_RECHECK_ENABLED (ON unless false / 0 / no / off; off = exactly the old single pass):
 *
 *   pass 1  today's loop, unchanged (order, settle wait, toast check, screenshots) — an exception is a field failure
 *   pass 2  each FAILED field is tried once more after the loader has cleared (not: missing data, a portal rejection)
 *   pass 3  each FILLED field is read back; one the portal cleared is filled again and read again
 *   Save    before it, every field filled so far is read back the same way; when Save does nothing, the portal's own
 *           invalid fields are named, refilled when they are ours, and Save is pressed ONCE more
 *
 * Per-job state is kept per DRIVER (a WeakMap): two jobs run in one process, each with its own browser.
 */
const kshemaFields = require("./kshemaFields");
const { log, warn, debug } = require("./kshemaLog");

const OFF_WORDS = new Set(["false", "0", "no", "off"]);

/** ON unless false / 0 / no / off. Read at call time. */
function isFieldRecheckEnabled() {
  return !OFF_WORDS.has(String(process.env.KSHEMA_FIELD_RECHECK_ENABLED ?? "").trim().toLowerCase());
}

/** driver -> Map(field key -> { field, data, expected, sectionName }): what has been filled on this job's form. */
const filledByDriver = new WeakMap();

const remember = (driver, field, data, expected, sectionName) => {
  if (!driver || typeof driver !== "object") return;
  if (!filledByDriver.has(driver)) filledByDriver.set(driver, new Map());
  filledByDriver.get(driver).set(field.key || field.label, { field, data, expected, sectionName });
};

const firstLine = (e) => String((e && e.message) || e || "").split("\n")[0].replace(/:/g, " -");

const isEmptyValue = (field, value) => {
  if (field.type === "checkbox" && value === false) return false; // unticking is a value
  return Array.isArray(value) ? value.length === 0 : !value;
};

/**
 * The per-type dispatch, exactly as fillSection did it — plus a catch, so an unexpected exception is this field's
 * failure ("could not be filled - <first line>") instead of the end of the section.
 */
async function fillOneField(driver, data, field, value, { capture, screenshots, handlers }) {
  const h = handlers || kshemaFields;
  try {
    if (field.type === "radio") return await h.selectMatRadio(driver, field.selectors, value, field.label);
    if (field.type === "checkbox") return await h.setMatCheckbox(driver, field.selectors, value, field.label);
    if (field.type === "slider") return await h.setSlider(driver, field.selectors, value, field.label);
    if (field.type === "date") return await h.typeIntoDateField(driver, field.selectors, value, field.label);
    if (field.type === "select") {
      return await h.selectMatOption(driver, field.selectors, value, field.label, {
        fuzzy: field.fuzzy,
        searchable: field.searchable,
        searchTerm: field.searchValue ? field.searchValue(data) : null,
        noise: field.noise,
        emptyReason: field.emptyReason,
        recover: field.recover || null,
        beforeClose: capture
          ? async (why) => {
              const shot = await capture(`kshema_${field.key}_${why}`, `${field.key}_${why.replace(/-/g, "_")}`);
              if (shot && shot.screenshotUrl) screenshots.push(shot);
            }
          : null,
      });
    }
    return await h.typeIntoField(driver, field.selectors, value, field.label, {
      stripSpaces: field.stripSpaces,
      maxLength: field.maxLength,
      recover: field.recover || null,
    });
  } catch (e) {
    return { ok: false, value: null, reason: `"${field.label}" could not be filled (${firstLine(e)})`, threw: true };
  }
}

/**
 * Fill a section. Same result shape as before: `{ ok, filled, failures, screenshots, error }`.
 *
 * @param {Object} deps
 * @param {Function} deps.waitForLoader  (driver, ms) — the form's own loader wait
 * @param {Function} [deps.readToast]    (driver) -> { text, isError } | null
 * @param {Object}   [deps.handlers]     test seam: the kshemaFields helpers
 * @param {Function} [deps.readState]    test seam: kshemaFields.readFieldState
 */
async function fillSection(driver, data, fields, sectionName, capture = null, deps = {}) {
  const waitForLoader = deps.waitForLoader || (async () => {});
  const readToast = deps.readToast || require("./kshemaToast").readToast;
  const readState = deps.readState || kshemaFields.readFieldState;
  const careful = isFieldRecheckEnabled();

  const filled = [];
  const failures = [];
  const screenshots = [];
  const done = []; // { field, value, expected }
  const retryable = []; // { field, value }

  const ctx = { capture, screenshots, handlers: deps.handlers };

  /** One field, start to end: fill, then the settle wait and the portal's verdict, exactly as before. */
  const attempt = async (field, value) => {
    const result = await fillOneField(driver, data, field, value, ctx);
    if (result.ok && field.settleMs) {
      // Some fields kick off an async lookup that re-renders the ones below them. Wait it out rather than typing into
      // a form that is mid-rebuild.
      await driver.sleep(300);
      await waitForLoader(driver, 20000);
      // Check if an error toast appeared after the reload (e.g. "Quotation already converted to proposal")
      const toast = await readToast(driver);
      if (toast && toast.isError) {
        return { ...result, ok: false, rejected: true, reason: `Portal rejected the field update: "${toast.text}"` };
      }
    }
    return result;
  };

  // ── pass 1: today's loop ──────────────────────────────────────────────────
  for (const field of fields) {
    const value = field.value(data);
    if (isEmptyValue(field, value)) {
      const isRequired = typeof field.required === "function" ? field.required(data) : field.required;
      if (isRequired) {
        failures.push({ label: field.label, reason: `this policy has no ${field.label.toLowerCase()} to enter` });
      } else {
        log(`   – ${field.label}: nothing to enter, skipping`);
      }
      continue;
    }

    const result = await attempt(field, value);
    if (result.ok) {
      filled.push(field.label);
      done.push({ field, value, expected: result.value });
    } else if (result.rejected) {
      warn(`   ✗ ${field.label}: ${result.reason}`);
      failures.push({ label: field.label, reason: result.reason });
      // a filled field whose update the portal refused still counts as filled, as it always did
      filled.push(field.label);
    } else if (field.required) {
      warn(`   ✗ ${field.label}: ${result.reason}`);
      failures.push({ label: field.label, reason: result.reason });
      // A field with its own slow-portal recovery (kshemaSlowFields.js) has just been through it — a bounded number of
      // switch-away-and-back cycles. Running that again here would double it, so such a field is not retried.
      const ownRecovery = field.recover && Number(field.recover.tries) > 0;
      if (!ownRecovery) retryable.push({ field, value });
    } else {
      warn(`   – ${field.label}: ${result.reason} (not required, carrying on)`);
    }
  }

  if (careful) {
    // ── pass 2: one more try for each failed field, once the form has settled ──
    if (retryable.length) {
      try {
        await waitForLoader(driver, 20000);
      } catch (e) { }
      for (const { field, value } of retryable) {
        log(`   ↻ ${field.label}: trying once more now that the form has settled`);
        const result = await attempt(field, value);
        if (result.ok) {
          const at = failures.findIndex((f) => f.label === field.label);
          if (at !== -1) failures.splice(at, 1);
          filled.push(field.label);
          done.push({ field, value, expected: result.value });
          log(`   ✓ ${field.label}: filled on the second try`);
        } else {
          debug(`   · ${field.label}: still failing (${result.reason})`);
        }
      }
    }

    // ── pass 3: is every filled field still holding its value? ──
    for (const entry of done) {
      const lost = await recheckOne(driver, data, entry, { attempt, readState });
      if (lost) {
        failures.push({ label: entry.field.label, reason: lost });
        const at = filled.indexOf(entry.field.label);
        if (at !== -1) filled.splice(at, 1);
      }
    }
  }

  for (const entry of done) {
    if (!failures.some((f) => f.label === entry.field.label)) {
      remember(driver, entry.field, data, entry.expected, sectionName);
    }
  }

  const ok = failures.length === 0;
  log(`${ok ? "✓" : "⚠️ "} ${sectionName}: ${filled.length} field(s) filled` + (failures.length ? `, ${failures.length} failed` : ""));

  return {
    ok,
    filled,
    failures,
    screenshots,
    error: ok
      ? null
      : `Could not fill the ${sectionName} on the KSHEMA quote form: ` +
        failures.map((f) => `${f.label} — ${f.reason}`).join("; ") +
        ".",
  };
}

/**
 * Read one filled field back; refill it once when the portal cleared it. Returns null when it holds (or cannot be read
 * — an unreadable field is never "fixed" by guessing), else the failure sentence.
 */
async function recheckOne(driver, data, entry, { attempt, readState }) {
  const { field, value, expected } = entry;
  let state;
  try {
    state = await readState(driver, field, value, expected);
  } catch (e) {
    return null;
  }
  if (!state || state.holds !== false) return null;

  log(`   ↺ ${field.label}: it had been cleared ("${state.actual || ""}"), filling it again`);
  const again = await attempt(field, value);
  if (!again.ok) {
    return `it was filled, then cleared by the portal, and could not be filled again (${again.reason})`;
  }
  let after;
  try {
    after = await readState(driver, field, value, again.value);
  } catch (e) {
    after = null;
  }
  if (after && after.holds === false) {
    return `it was filled twice and the portal cleared it both times (it now shows "${after.actual || "nothing"}")`;
  }
  entry.expected = again.value;
  log(`   ✓ ${field.label}: filled again`);
  return null;
}

/**
 * Before Save and Continue: every field filled so far on this job's form, read back once more — an answer in a later
 * section can re-render an earlier one. A cleared field is filled again. Returns the labels still lost.
 */
async function recheckBeforeSave(driver, deps = {}) {
  if (!isFieldRecheckEnabled()) return { lost: [], refilled: [] };
  const entries = filledByDriver.get(driver);
  if (!entries || !entries.size) return { lost: [], refilled: [] };
  const readState = deps.readState || kshemaFields.readFieldState;
  const ctx = { capture: null, screenshots: [], handlers: deps.handlers };
  const attempt = async (field, value) => fillOneField(driver, null, field, value, ctx);

  const lost = [];
  const refilled = [];
  for (const entry of entries.values()) {
    const value = entry.field.value(entry.data);
    let state = null;
    try {
      state = await readState(driver, entry.field, value, entry.expected);
    } catch (e) { }
    if (!state || state.holds !== false) continue;
    const problem = await recheckOne(driver, entry.data, { field: entry.field, value, expected: entry.expected }, { attempt, readState });
    if (problem) lost.push(`${entry.field.label} — ${problem}`);
    else refilled.push(entry.field.label);
  }
  if (refilled.length) log(`   ↺ Refilled before saving: ${refilled.join(", ")}`);
  return { lost, refilled };
}

/** The registered field an invalid control on the page belongs to (matched on its data-iid), or null. */
function registeredFieldFor(driver, invalid) {
  const entries = filledByDriver.get(driver);
  if (!entries || !invalid || !invalid.iid) return null;
  for (const entry of entries.values()) {
    if ((entry.field.selectors || []).some((s) => String(s).includes(`data-iid="${invalid.iid}"`))) return entry;
  }
  return null;
}

/** "Engine Number (Required)"; a bare portal message on its own; never an empty name. Colons removed (beautifyError). */
const describeInvalid = (inv) => {
  const clean = (t) => String(t || "").replace(/:/g, " -").trim();
  const name = clean(inv.label || inv.placeholder || inv.iid);
  const message = clean(inv.message);
  if (name && message) return `${name} (${message})`;
  return name || message || "a field";
};

/**
 * Save and Continue did NOT move the page. Read the portal's own invalid fields; when they are fields this job filled,
 * fill them again and press Save once more (a form with invalid fields was not submitted, so this is not a second
 * submission). Otherwise say which fields the portal is unhappy with.
 *
 * @param {Object} o
 * @param {Function} o.retrySave  async () -> { pageChanged, result? } — the form's own click-and-wait
 * @param {string}   o.fallbackError  the old message (used when nothing more specific is known, and with the switch off)
 * @returns {Promise<{ok:boolean, error?:string, toast?:string, refilled?:string[]}>}
 */
async function afterSilentSave(driver, { retrySave, fallbackError, readInvalid, handlers, readState } = {}) {
  if (!isFieldRecheckEnabled()) return { ok: false, error: fallbackError };

  let invalid = [];
  try {
    invalid = await (readInvalid || kshemaFields.readInvalidFields)(driver);
  } catch (e) {
    invalid = [];
  }
  if (!invalid.length) return { ok: false, error: fallbackError };

  const ctx = { capture: null, screenshots: [], handlers };
  const refilled = [];
  for (const inv of invalid) {
    const entry = registeredFieldFor(driver, inv);
    if (!entry) continue;
    const value = entry.field.value(entry.data);
    const result = await fillOneField(driver, entry.data, entry.field, value, ctx);
    if (result.ok) refilled.push(entry.field.label);
  }

  if (refilled.length && typeof retrySave === "function") {
    log(`   ↻ Save did nothing — refilled ${refilled.join(", ")} and pressing Save and Continue once more`);
    const again = await retrySave();
    if (again && again.result) return { ...again.result, refilled };
    if (again && again.pageChanged) return { ok: true, refilled };
    let still = [];
    try {
      still = await (readInvalid || kshemaFields.readInvalidFields)(driver);
    } catch (e) { }
    if (still.length) invalid = still;
  }

  return {
    ok: false,
    refilled,
    error:
      `Save and Continue did nothing — the KSHEMA quote form shows these fields as not filled or invalid - ` +
      `${invalid.map(describeInvalid).join("; ")}.` +
      (refilled.length ? ` They were filled again once (${refilled.join(", ")}) and the portal still refused.` : "") +
      " Please check the screenshot.",
  };
}

module.exports = {
  isFieldRecheckEnabled,
  fillSection,
  fillOneField,
  recheckBeforeSave,
  afterSilentSave,
  registeredFieldFor,
  // for tests
  _filledByDriver: filledByDriver,
};
