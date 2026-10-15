/**
 * Recovery for the KSHEMA fields the portal is slow to show.
 *
 * Two fields on the quote form only exist once an earlier answer has been
 * processed, and the portal sometimes never renders them:
 *
 *   - the Insured Declared Value box, after the Product Type is set;
 *   - the PA Cover year dropdown, after the (ticked by default) PA checkbox.
 *
 * Waiting longer does not always bring them. What a person does is switch the
 * earlier answer away and back, and that is what is automated here:
 *
 *   IDV   — choose another Product Type (the liability one), choose Bundled
 *           again, wait, look again;
 *   PA    — untick the PA checkbox, tick it again, look again.
 *
 * A recovery is a plain object handed to a field as `recover`
 * (kshemaFields.js findAfterRecovery drives it). It keeps NO state: two jobs
 * run in one process, so anything per run is in the arguments and the returned
 * outcome.
 *
 * Settings (automation .env):
 *   KSHEMA_SLOW_FIELD_RECOVERY_ENABLED  on unless false / 0 / no / off. Off =
 *                                       `tries` is 0 and none of this runs.
 *   KSHEMA_SLOW_FIELD_WAIT_MS           how long to look again after each try
 *                                       (default 10000, kept within 3000-30000).
 *
 * Notes written here end up in the operator's message, which the error
 * formatter cuts at the LAST colon — so there is no colon in any of them.
 */
const { By } = require("selenium-webdriver");
const kshemaFields = require("./kshemaFields");
const { log, warn } = require("./kshemaLog");

/** Tries per missing field. Fixed: this is a bounded recovery, not a retry loop. */
const TRIES = 2;
const DEFAULT_WAIT_MS = 10000;
const MIN_WAIT_MS = 3000;
const MAX_WAIT_MS = 30000;

/** How long to give the portal after a change before touching the form again. */
const PRODUCT_SETTLE_MS = 1500;
const CHECKBOX_FIRST_SETTLE_MS = 1000;
const CHECKBOX_SETTLE_MS = 1500;
const LOADER_WAIT_MS = 20000;

const OFF_WORDS = new Set(["false", "0", "no", "off"]);

/** On unless set to false / 0 / no / off. Read at call time so a restart is not needed in tests. */
function slowFieldRecoveryEnabled() {
  return !OFF_WORDS.has(String(process.env.KSHEMA_SLOW_FIELD_RECOVERY_ENABLED ?? "").trim().toLowerCase());
}

/** The look-again wait, in ms, kept inside a sane range. */
function slowFieldWaitMs() {
  const raw = Number(process.env.KSHEMA_SLOW_FIELD_WAIT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(raw)));
}

/** One line of a reason, safe to put in the operator's message (no colon, no driver noise). */
const plain = (text) => String(text || "").split("\n")[0].replace(/\s+/g, " ").replace(/:/g, " -").trim();

const seconds = (ms) => `${Math.round(ms / 1000)} s`;

/** The KSHEMA spinner, same selector as kshemaForm.js — which the TP flow replaces with kshemaTPForm.js. */
const LOADER_SELECTOR = 'mat-spinner[data-iid="__loading"], .mat-mdc-progress-spinner';

/**
 * Wait for the portal's spinner to go. Never throws: a spinner that will not
 * go is not this function's failure, the search for the field afterwards is
 * the real gate.
 */
async function waitForSpinnerGone(driver, timeoutMs = LOADER_WAIT_MS) {
  // Let the spinner appear first, or "no spinner yet" reads as "done".
  await driver.sleep(300);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await spinnerShown(driver))) return true;
    await driver.sleep(200);
  }
  return false;
}

/** Is the portal's spinner on screen right now? A stale / removed one counts as gone. */
async function spinnerShown(driver) {
  try {
    const loaders = await driver.findElements(By.css(LOADER_SELECTOR));
    for (const loader of loaders) {
      if (await loader.isDisplayed()) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Wait until the portal is quiet: no spinner AND no error toast on screen.
 *
 * A snackbar stays up for several seconds, and the next field's toast check
 * would read the SAME message again — that is how one 504 became two failures.
 * Never throws; false = it was still busy when the time ran out.
 */
async function waitForQuiet(driver, timeoutMs = DEFAULT_WAIT_MS) {
  const { readToast } = require("./kshemaToast");
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let busy = await spinnerShown(driver);
    if (!busy) {
      try {
        const toast = await readToast(driver);
        busy = !!(toast && toast.isError);
      } catch (e) { }
    }
    if (!busy) return true;
    if (Date.now() >= deadline) return false;
    await driver.sleep(300);
  }
}

/** The real primitives; tests hand in fakes. */
function realDeps(overrides = {}) {
  return {
    selectOtherMatOption: kshemaFields.selectOtherMatOption,
    selectMatOption: kshemaFields.selectMatOption,
    setMatCheckbox: kshemaFields.setMatCheckbox,
    waitForLoader: waitForSpinnerGone,
    waitForQuiet,
    describeCheckbox,
    sleep: (driver, ms) => driver.sleep(ms),
    ...overrides,
  };
}

/** A selector list, or a function returning one (the table it points into is built after this call). */
const resolveList = (value) => (typeof value === "function" ? value() : value);
const resolveText = (value) => (typeof value === "function" ? value() : value);

/**
 * Recovery for the Insured Declared Value box: switch the Product Type to
 * another option and back to Bundled.
 *
 * The product is ALWAYS put back — once the switch was attempted the Bundled
 * select runs whatever happened (it is a no-op when the dropdown still shows
 * Bundled), so a failed recovery never leaves the form on the liability product.
 *
 * @param {Object} cfg
 * @param {string[]|Function} cfg.productSelectors - the Product Type mat-select
 * @param {string|Function} cfg.productText - the product the policy is filed with ("Two Wheeler-Bundled")
 * @param {string} [cfg.label]
 * @param {Object} [deps] - test seam
 */
function idvRecovery(cfg, deps = {}) {
  const label = cfg.label || "Product Type";

  return {
    get tries() {
      return slowFieldRecoveryEnabled() ? TRIES : 0;
    },
    get waitMs() {
      return slowFieldWaitMs();
    },

    async run({ driver, n, tries, fieldLabel }) {
      const d = realDeps(deps);
      const selectors = resolveList(cfg.productSelectors);
      const product = resolveText(cfg.productText);

      log(
        `   ⏳ "${fieldLabel}" is not showing yet — the portal is slow. Switching ${label} to ` +
          `another option and back to "${product}" (try ${n}/${tries})`
      );

      let away;
      try {
        away = await d.selectOtherMatOption(driver, selectors, { avoid: product, label });
      } catch (e) {
        away = { ok: false, reason: plain(e && e.message) };
      }
      const switchedTo = away && away.ok ? away.value || away.chose || "" : "";
      if (switchedTo) {
        await d.waitForLoader(driver);
        await d.sleep(driver, PRODUCT_SETTLE_MS);
      }

      // Back to the product — also after a failed switch (then it is a no-op).
      let back;
      try {
        back = await d.selectMatOption(driver, selectors, product, label, { fuzzy: true });
      } catch (e) {
        back = { ok: false, value: null, reason: plain(e && e.message) };
      }
      if (!back.ok) {
        warn(`   ✗ ${label} could not be put back to "${product}": ${back.reason}`);
        return {
          recovered: false,
          switchedTo,
          note:
            `the ${label} was left on "${back.value || switchedTo || "another option"}" and could not be ` +
            `set back to "${product}" (${plain(back.reason)})`,
        };
      }

      if (!switchedTo) {
        // Nothing moved, so there is nothing new to wait for.
        warn(`   ✗ ${label} could not be switched to another option: ${away && away.reason}`);
        return {
          recovered: false,
          switchedTo: "",
          note: `the ${label} could not be switched to another option (${plain(away && away.reason)})`,
        };
      }

      await d.waitForLoader(driver);
      await d.sleep(driver, PRODUCT_SETTLE_MS);
      return { recovered: true, switchedTo, note: "" };
    },

    explain({ tried, waitMs, outcomes }) {
      const last = outcomes[outcomes.length - 1] || {};
      const product = resolveText(cfg.productText);
      if (last.recovered === false && last.note) {
        return `and ${last.note}`;
      }
      const to = (outcomes.find((o) => o.switchedTo) || {}).switchedTo;
      return (
        `even after switching the ${label} to "${to || "another option"}" and back to "${product}" ` +
        `${tried} time${tried === 1 ? "" : "s"} (waited ${seconds(waitMs)} each time)`
      );
    },
  };
}

/**
 * Recovery for a field that follows the PA Cover checkbox (the year dropdown;
 * the "reason for unselecting" dropdown): untick it and tick it again.
 *
 * `wantChecked` is the state the policy needs the box to END in. The toggle goes
 * the other way first and then back, so the box is never left in the wrong
 * state: a failed put-back is reported as such.
 *
 * @param {Object} cfg
 * @param {string[]|Function} cfg.checkboxSelectors - how the flow found the PA checkbox
 * @param {boolean} cfg.wantChecked
 * @param {string} [cfg.label]
 * @param {Object} [deps] - test seam
 */
function paToggleRecovery(cfg, deps = {}) {
  const label = cfg.label || "PA Cover";
  const wantChecked = cfg.wantChecked === true;
  const word = (checked) => (checked ? "ticked" : "unticked");

  return {
    get tries() {
      return slowFieldRecoveryEnabled() ? TRIES : 0;
    },
    get waitMs() {
      return slowFieldWaitMs();
    },

    async run({ driver, n, tries, fieldLabel }) {
      const d = realDeps(deps);
      const selectors = resolveList(cfg.checkboxSelectors);

      log(
        `   ⏳ "${fieldLabel}" is not showing yet — the portal is slow. ` +
          `${wantChecked ? "Un-ticking" : "Ticking"} "${label}" and putting it back (try ${n}/${tries})`
      );

      let away;
      try {
        away = await d.setMatCheckbox(driver, selectors, !wantChecked, label);
      } catch (e) {
        away = { ok: false, reason: plain(e && e.message) };
      }
      await d.waitForLoader(driver);
      await d.sleep(driver, CHECKBOX_FIRST_SETTLE_MS);

      let back;
      try {
        back = await d.setMatCheckbox(driver, selectors, wantChecked, label);
      } catch (e) {
        back = { ok: false, reason: plain(e && e.message) };
      }
      await d.waitForLoader(driver);
      await d.sleep(driver, CHECKBOX_SETTLE_MS);

      if (!back.ok) {
        warn(`   ✗ "${label}" could not be put back to ${word(wantChecked)}: ${back.reason}`);
        return {
          recovered: false,
          toggled: !!(away && away.ok),
          note: `"${label}" could not be put back to ${word(wantChecked)} (${plain(back.reason)})`,
        };
      }
      return { recovered: true, toggled: !!(away && away.ok), note: "" };
    },

    explain({ tried, waitMs, outcomes }) {
      const last = outcomes[outcomes.length - 1] || {};
      if (last.recovered === false && last.note) {
        return `and ${last.note}`;
      }
      return (
        `even after ${wantChecked ? "un-ticking" : "ticking"} "${label}" and putting it back ` +
        `${tried} time${tried === 1 ? "" : "s"} (waited ${seconds(waitMs)} each time)`
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* A portal error toast after a field change                                  */
/* -------------------------------------------------------------------------- */

/**
 * Angular's own wording: "Http failure response for https://…/calc/…?type=premium_calc: 504 OK".
 * Only this exact shape carries a status — a number elsewhere in a message
 * ("between 500 and 1000") is not one.
 */
function httpStatusOf(text) {
  const match = /http failure response for\s+\S+:\s*(\d{1,3})\b/i.exec(String(text || ""));
  return match ? Number(match[1]) : null;
}

const TRANSIENT_WORDS =
  /\b(?:time[- ]?out|timed out|gateway|service unavailable|temporarily unavailable|unknown error|network error|failed to fetch|connection (?:was )?(?:reset|refused|closed)|socket hang up)\b/i;

/**
 * Is this toast the portal being slow or unreachable, rather than a verdict on
 * our data? 5xx, 0 ("Unknown Error"), 408, 425, 429 and timeout / gateway words
 * are. A 400 / 409 / 422 or "Quotation already converted to proposal" is not —
 * toggling a checkbox would not change what the portal thinks of the data.
 */
function isTransientPortalError(text) {
  const status = httpStatusOf(text);
  if (status !== null) {
    return status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
  }
  return TRANSIENT_WORDS.test(String(text || ""));
}

/** fillSection words a toast failure as: Portal rejected the field update: "<toast text>" */
const TOAST_REASON = /^Portal rejected the field update: "([\s\S]*)"$/;
const toastTextOf = (failure) => {
  const match = TOAST_REASON.exec(String((failure && failure.reason) || ""));
  return match ? match[1] : null;
};

/** Every failure is a portal toast, and every toast is the portal being slow. A mixed bag is not. */
function failuresAreTransient(failures) {
  return (
    Array.isArray(failures) &&
    failures.length > 0 &&
    failures.every((failure) => {
      const text = toastTextOf(failure);
      return text !== null && isTransientPortalError(text);
    })
  );
}

/** "HTTP 504 on the premium calculation" — what to tell the operator the portal said. */
function describePortalError(failures) {
  const text = toastTextOf((failures || [])[0]) || "";
  const status = httpStatusOf(text);
  const where = /premium_calc|\/calc\//i.test(text) ? " on the premium calculation" : "";
  if (status === 0) return `no answer${where}`;
  if (status !== null) return `HTTP ${status}${where}`;
  return `a timeout or gateway error${where}`;
}

/** The label of the checkbox about to be toggled, for the log ("which one is it?"). Never throws. */
async function describeCheckbox(driver, selectors) {
  for (const selector of selectors || []) {
    try {
      const text = String(selector).trim();
      const locator = text.startsWith("//") || text.startsWith("(") ? By.xpath(text) : By.css(text);
      const found = await driver.findElements(locator);
      if (!found.length) continue;
      const label = await driver.executeScript(
        'var c = arguments[0].closest("mat-checkbox") || arguments[0].closest("label") || arguments[0].parentElement;' +
          'return c ? (c.innerText || c.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80) : "";',
        found[0]
      );
      return String(label || "");
    } catch (e) { }
  }
  return "";
}

/**
 * The portal answered a change with a gateway / server error ("Http failure
 * response … 504"). That is it being slow — the field itself was set — so give
 * up only after doing what a person does: wait for it to settle, untick and tick
 * the PA Cover checkbox again (that re-fires the premium calculation), wait, and
 * look again.
 *
 *   1. only when EVERY failure is such a toast (a real rejection is left alone);
 *   2. up to TRIES times: wait until the toast and spinner are gone (<= the
 *      configured wait) -> untick -> settle -> tick -> settle -> wait quiet ->
 *      run the section again (re-picks the year, re-reads the toasts);
 *   3. the checkbox always ends as the policy needs it;
 *   4. out of tries: ONE colon-free sentence saying what the portal answered
 *      and what was tried.
 *
 * @param {Object} driver
 * @param {Object} first  the section's first result ({ok, filled, failures, error, screenshots})
 * @param {Object} cfg
 * @param {Function} cfg.fillAgain       async () => the section's result, run again
 * @param {string[]|Function} cfg.checkboxSelectors
 * @param {boolean} cfg.wantChecked      the state the box must END in
 * @param {string} [cfg.label]           "PA Cover"
 * @param {string} [cfg.sectionLabel]    "PA Cover details"
 * @param {Object} [deps]                test seam
 */
async function recoverSectionAfterPortalError(driver, first, cfg, deps = {}) {
  if (!first || first.ok) return first;
  if (!slowFieldRecoveryEnabled()) return first;
  if (!failuresAreTransient(first.failures)) return first;

  const d = realDeps(deps);
  const selectors = resolveList(cfg.checkboxSelectors);
  const label = cfg.label || "PA Cover";
  const wantChecked = cfg.wantChecked === true;
  const waitMs = slowFieldWaitMs();
  const said = describePortalError(first.failures);
  const word = (checked) => (checked ? "ticked" : "unticked");

  let boxLabel = "";
  try {
    boxLabel = await d.describeCheckbox(driver, selectors);
  } catch (e) { }
  if (boxLabel) log(`   ☑️  The "${label}" checkbox used for the recovery reads: "${boxLabel}"`);

  let last = first;
  let tried = 0;
  let stuck = "";

  for (let n = 1; n <= TRIES; n++) {
    tried = n;
    log(
      `   ⏳ The portal answered with an error (${said}) - it is slow. ` +
        `${wantChecked ? "Un-ticking" : "Ticking"} "${label}" and putting it back, ` +
        `then waiting up to ${seconds(waitMs)} (try ${n}/${TRIES})`
    );

    // let the toast go and the portal finish before touching anything
    await d.waitForQuiet(driver, waitMs);

    let away;
    try {
      away = await d.setMatCheckbox(driver, selectors, !wantChecked, label);
    } catch (e) {
      away = { ok: false, reason: plain(e && e.message) };
    }
    await d.waitForLoader(driver);
    await d.sleep(driver, CHECKBOX_FIRST_SETTLE_MS);

    let back;
    try {
      back = await d.setMatCheckbox(driver, selectors, wantChecked, label);
    } catch (e) {
      back = { ok: false, reason: plain(e && e.message) };
    }
    await d.waitForLoader(driver);
    await d.sleep(driver, CHECKBOX_SETTLE_MS);

    if (!back.ok) {
      warn(`   ✗ "${label}" could not be put back to ${word(wantChecked)}: ${back.reason}`);
      stuck = `"${label}" could not be put back to ${word(wantChecked)} (${plain(back.reason)})`;
      break;
    }
    void away;

    // the calculation the toggle fired: wait it out, then judge the section again
    await d.waitForQuiet(driver, waitMs);
    last = await cfg.fillAgain();
    if (last.ok) {
      log(`   ✓ ${cfg.sectionLabel || "The section"} went through after the recovery (try ${n}/${TRIES})`);
      return last;
    }
    // a different problem now (a real rejection, a missing option): report that as it is
    if (!failuresAreTransient(last.failures)) return last;
  }

  const lead = cfg.sectionLabel ? `Could not fill the ${cfg.sectionLabel} on the KSHEMA quote form - ` : "";
  const sentence = stuck
    ? `${lead}the portal answered with an error (${said}) and then ${stuck}. Run this policy again in a few minutes.`
    : `${lead}the portal answered the change with an error (${said}) even after ` +
      `${wantChecked ? "un-ticking" : "ticking"} "${label}" and putting it back ${tried} time${tried === 1 ? "" : "s"} ` +
      `(waited ${seconds(waitMs)} each time). The portal is slow right now, so run this policy again in a few minutes.`;
  return { ...last, ok: false, error: sentence, portalError: true };
}

module.exports = {
  idvRecovery,
  paToggleRecovery,
  recoverSectionAfterPortalError,
  isTransientPortalError,
  failuresAreTransient,
  describePortalError,
  slowFieldRecoveryEnabled,
  slowFieldWaitMs,
  waitForSpinnerGone,
  waitForQuiet,
  TRIES,
};
