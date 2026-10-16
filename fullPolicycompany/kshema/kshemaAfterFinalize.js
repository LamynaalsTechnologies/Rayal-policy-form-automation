/**
 * KSHEMA — after "Save and Finalize": wait for the loader, look at the page, and when the KYC button does not come say WHY.
 *
 * Why (2026-10-16): a run stopped at the KYC step with only "KYC button did not appear after 15 seconds". Pressing
 * "Save and Finalize" makes the portal show its loader while it saves; the next page — the one with the KYC button — is drawn
 * when the loader ends, and a slow portal needs longer than 15 seconds. And when the portal does NOT move on (the Financier
 * Name box empty or marked invalid, another required field missing) the run could not tell: it waited, gave up, and the
 * message named nothing.
 *
 * Behind KSHEMA_AFTER_FINALIZE_ENABLED (ON unless false / 0 / no / off; off = exactly the old 15-second wait and message):
 *
 *   checkFinalizeEnabled  before the click: a "Save and Finalize" that is STILL disabled cannot be pressed. When the form shows
 *                         why (the Financier Name box, other required fields) the run stops there with that, instead of
 *                         clicking a dead button and waiting for a page that cannot come. No reason found = pressed as before.
 *   waitAfterFinalize     right after the click: wait for the loader to end (progress lines in the log), remembering any error
 *                         message that flashed by while it spun, then READ THE FINANCIER NAME BOX AGAIN — a box the portal
 *                         marks invalid means it refused to move on. A page that left the form has no box, which is fine.
 *   awaitKycButton        the KYC step's wait: the button is taken once the loader is gone, patience is counted from the click
 *                         (KSHEMA_AFTER_FINALIZE_WAIT_SECONDS, default 60) and on timeout the page is read again — the
 *                         portal's own message, the Financier Name box, the other invalid fields, a loader that never ended —
 *                         and the error names what was found.
 *
 * Shared by the full-company flow (kshemaQuoteForm.js) and the TP copy (kshemaTPQuoteForm.js). Nothing here presses a button
 * or fills a field again: it only waits, reads, and reports. No colon in any operator sentence — beautifyError keeps only
 * the text after the last one.
 */
const { By } = require("selenium-webdriver");
const { log, warn, debug } = require("./kshemaLog");
const { readToast } = require("./kshemaToast");
const { readInvalidFields } = require("./kshemaFields");
const { readFinancierState, isFinancierEnabled } = require("./kshemaFinancier");

const OFF_WORDS = new Set(["false", "0", "no", "off"]);

/** ON unless false / 0 / no / off. Read at call time. */
function isAfterFinalizeEnabled() {
  return !OFF_WORDS.has(String(process.env.KSHEMA_AFTER_FINALIZE_ENABLED ?? "").trim().toLowerCase());
}

const DEFAULT_WAIT_SECONDS = 60;
const MIN_WAIT_SECONDS = 15;
const MAX_WAIT_SECONDS = 300;

/** How long, in total, the run waits for the KYC button after pressing Save and Finalize (loader included). */
function afterFinalizeWaitMs() {
  const raw = Number(String(process.env.KSHEMA_AFTER_FINALIZE_WAIT_SECONDS ?? "").trim());
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, seconds)) * 1000;
}

/** The old fixed wait, used as it was when the switch is off. */
const OLD_KYC_WAIT_MS = 15000;
const OLD_KYC_WAIT_MESSAGE = "KYC button did not appear after 15 seconds";

/** The KYC button, exactly as the KYC step always found it. */
const KYC_BUTTON_XPATH =
  '//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "kyc")] | //i-kyc//button';

/** The portal's loader — the same selector waitForKshemaLoaderToDisappear (kshemaForm.js) uses everywhere else. */
const LOADER_SELECTOR = 'mat-spinner[data-iid="__loading"], .mat-mdc-progress-spinner';

const POLL_MS = 500;
/** After the click the loader opens within moments; if none shows in this long there is nothing to wait for. */
const LOADER_LOOK_MS = 1500;
/** A loader that has been gone this long is really gone (two requests in a row leave a gap of a moment between them). */
const LOADER_QUIET_MS = 800;
/** The KYC button gets at least this long to appear once the KYC step starts, and this long after the loader's last sighting. */
const GRACE_MS = 10000;
const PROGRESS_EVERY_MS = 10000;
/** The KYC button is already on the page but a loader is still open: wait this long for it, then press the button anyway. */
const BUTTON_WITH_LOADER_MS = 15000;
/** A box seen invalid right after the click is read once more after this long before it is called a refusal. */
const RECHECK_AFTER_MS = 1500;

const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/\s*:\s*/g, " - ").trim();
const seconds = (ms) => Math.max(0, Math.round(ms / 1000));
const truthy = (v) => v === true || String(v).toLowerCase() === "true";

/** driver -> { finalizedAt, errorToasts }: what this job's page did since the click (two jobs run in one process). */
const stateByDriver = new WeakMap();
function stateOf(driver) {
  if (!driver || typeof driver !== "object") return {};
  if (!stateByDriver.has(driver)) stateByDriver.set(driver, {});
  return stateByDriver.get(driver);
}

async function isLoaderVisible(driver) {
  try {
    const loaders = await driver.findElements(By.css(LOADER_SELECTOR));
    for (const loader of loaders) {
      try {
        if (await loader.isDisplayed()) return true;
      } catch (e) { }
    }
  } catch (e) { }
  return false;
}

/** Everything the module reads or waits on, so a test can drive it with a scripted page and a fake clock. */
function resolveDeps(driver, deps = {}) {
  return {
    now: deps.now || Date.now,
    sleep: deps.sleep || ((ms) => driver.sleep(ms)),
    findButtons: deps.findButtons || (() => driver.findElements(By.xpath(KYC_BUTTON_XPATH))),
    loaderVisible: deps.loaderVisible || (() => isLoaderVisible(driver)),
    readToast: deps.readToast || (() => readToast(driver)),
    readFinancier: deps.readFinancier || (() => readFinancierState(driver)),
    readInvalid: deps.readInvalid || (() => readInvalidFields(driver)),
    pageTitle: deps.pageTitle || (() => driver.getTitle()),
  };
}

/** Does this policy have a financier KSHEMA was given (so its box is worth reading)? */
const financierApplies = (data) => isFinancierEnabled() && truthy(data && data.hasFinancier);

/** Remember an error message the portal flashed (a snackbar goes away by itself after a few seconds). */
async function noteToast(d, st) {
  let toast = null;
  try {
    toast = await d.readToast();
  } catch (e) {
    toast = null;
  }
  if (toast && toast.isError && toast.text) {
    st.errorToasts = st.errorToasts || [];
    if (!st.errorToasts.includes(toast.text)) {
      st.errorToasts.push(toast.text);
      warn(`   ⚠️ KSHEMA showed a message - "${toast.text}"`);
    }
  }
}

/** The Financier Name box as a short sentence when it is in error, else null. { present:false } is not an error here. */
function financierProblem(state, { emptyCounts }) {
  if (!state || !state.present) return null;
  const holds = state.value ? `it holds "${oneLine(state.value)}"` : "it is empty";
  if (state.invalid) {
    return `the Financier Name box is marked invalid${state.error ? ` (${oneLine(state.error)})` : ""} and ${holds}`;
  }
  if (emptyCounts && !state.value) return "the Financier Name box is empty";
  return null;
}

/**
 * Right after the click on "Save and Finalize": wait for the loader to end, then read the Financier Name box once more.
 *
 * @param {Object} driver
 * @param {Object} [data]  the job data (hasFinancier)
 * @param {Object} [deps]  test seam: { now, sleep, loaderVisible, readToast, readFinancier }
 * @returns {Promise<{ok:true, skipped?:string, loaderSeen?:boolean, stillSpinning?:boolean, waitedMs?:number}|{ok:false, error:string}>}
 */
async function waitAfterFinalize(driver, data = {}, deps = {}) {
  if (!isAfterFinalizeEnabled()) return { ok: true, skipped: "switched off" };
  const d = resolveDeps(driver, deps);
  const st = stateOf(driver);
  const started = d.now();
  st.finalizedAt = started;
  st.errorToasts = [];
  const budget = afterFinalizeWaitMs();

  let openedAt = null;
  let goneSince = null;
  let nextNote = 0;
  let spinning = false;
  for (;;) {
    spinning = await d.loaderVisible();
    await noteToast(d, st);
    const t = d.now();
    if (spinning) {
      goneSince = null;
      if (openedAt === null) {
        openedAt = t;
        nextNote = t + PROGRESS_EVERY_MS;
        log("   ⏳ KSHEMA's loader is open - the portal is saving, waiting for it to finish...");
      } else if (t >= nextNote) {
        nextNote = t + PROGRESS_EVERY_MS;
        log(`   ⏳ The loader is still open after ${seconds(t - openedAt)}s...`);
      }
    } else if (openedAt !== null) {
      if (goneSince === null) goneSince = t;
      if (t - goneSince >= LOADER_QUIET_MS) {
        log(`   ✓ The loader finished after ${seconds(goneSince - openedAt)}s`);
        break;
      }
    } else if (t - started >= LOADER_LOOK_MS) {
      debug("   – no loader opened after Save and Finalize, nothing to wait for");
      break;
    }
    if (t - started >= budget) {
      warn(`   ⚠️ The loader is still open after ${seconds(budget)}s - carrying on, the KYC step will look at the page`);
      break;
    }
    await d.sleep(POLL_MS);
  }
  await noteToast(d, st);
  const result = { ok: true, loaderSeen: openedAt !== null, stillSpinning: spinning, waitedMs: d.now() - started };
  if (spinning || !financierApplies(data)) return result;

  // The portal answered (or never started). A financier box it still shows and marks invalid is its refusal to move on; a
  // page that has left the form shows no box at all. Read it twice before calling it — the state can be mid-change.
  let state = await d.readFinancier();
  let problem = financierProblem(state, { emptyCounts: false });
  if (problem) {
    await d.sleep(RECHECK_AFTER_MS);
    state = await d.readFinancier();
    problem = financierProblem(state, { emptyCounts: false });
  }
  if (problem) {
    warn(`   ⚠️ After Save and Finalize ${problem}`);
    return { ok: false, error: `KSHEMA did not accept Save and Finalize - ${problem}. Check the financier name on the policy.` };
  }
  return result;
}

/** Is the button disabled the way the form's own wait before the click reads it? */
async function isButtonDisabled(button) {
  try {
    const disabled = await button.getAttribute("disabled");
    const cls = await button.getAttribute("class");
    return disabled === "true" || disabled === "disabled" || !!(cls && cls.includes("mat-mdc-button-disabled"));
  } catch (e) {
    return false;
  }
}

const fieldName = (f) => oneLine(f.label || f.placeholder || f.iid || f.message).replace(/^[*+\s]+/, "").replace(/[\s*]+$/, "");

/**
 * Read the page for the reason it did not move on. Most telling first:
 *   toast      a message KSHEMA showed (seen while waiting)
 *   financier  the Financier Name box empty or marked invalid
 *   fields     the other fields the portal marks as not filled
 *   loader     the loader that never ended
 * @returns {Promise<Array<{kind:string, text:string}>>}
 */
async function explainStall(driver, data, { errorToasts = [], spinning = false } = {}, d = resolveDeps(driver)) {
  const reasons = [];
  if (errorToasts.length) reasons.push({ kind: "toast", text: `KSHEMA said "${oneLine(errorToasts[errorToasts.length - 1])}"` });

  if (financierApplies(data)) {
    try {
      const problem = financierProblem(await d.readFinancier(), { emptyCounts: true });
      if (problem) reasons.push({ kind: "financier", text: problem });
    } catch (e) {
      debug(`   – could not read the Financier Name box (${oneLine(e.message)})`);
    }
  }

  try {
    const invalid = (await d.readInvalid()) || [];
    const names = [];
    for (const f of invalid) {
      if (/financier/i.test(`${f.iid} ${f.label} ${f.placeholder}`)) continue; // reported above
      const name = fieldName(f);
      if (name && !names.includes(name)) names.push(name);
    }
    if (names.length) {
      const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? ` and ${names.length - 6} more` : "");
      reasons.push({ kind: "fields", text: `KSHEMA marks these fields as not filled or invalid - ${shown}` });
    }
  } catch (e) {
    debug(`   – could not read the invalid fields (${oneLine(e.message)})`);
  }

  if (spinning) {
    reasons.push({ kind: "loader", text: "KSHEMA's loader was still spinning (the portal is slow or stuck)" });
  }
  return reasons;
}

/**
 * Before the click: a "Save and Finalize" that is still disabled can't be pressed. Stop only when the form shows WHY — with
 * nothing to blame the button is pressed as it always was.
 *
 * @returns {Promise<{ok:true, skipped?:string, stillDisabled?:boolean}|{ok:false, error:string}>}
 */
async function checkFinalizeEnabled(driver, button, data = {}, deps = {}) {
  if (!isAfterFinalizeEnabled()) return { ok: true, skipped: "switched off" };
  if (!(await isButtonDisabled(button))) return { ok: true };

  const d = resolveDeps(driver, deps);
  warn("   ⚠️ Save and Finalize is still disabled - looking at the form to see why...");
  const reasons = (await explainStall(driver, data, {}, d)).filter((r) => r.kind !== "loader");
  if (!reasons.length) {
    warn("   ⚠️ The form shows no reason, pressing it as before");
    return { ok: true, stillDisabled: true };
  }
  for (const r of reasons) warn(`   • ${r.text}`);
  return { ok: false, error: `Save and Finalize stayed disabled - ${reasons.map((r) => r.text).join("; ")}.` };
}

/**
 * The KYC step's wait for its button.
 *
 * @param {Object} driver
 * @param {Object} [data]  the job data (hasFinancier)
 * @param {Object} [deps]  test seam: { now, sleep, findButtons, loaderVisible, readToast, readFinancier, readInvalid, pageTitle }
 * @returns {Promise<{ok:true, button:Object, waitedMs?:number}|{ok:false, error:string}>}
 */
async function awaitKycButton(driver, data = {}, deps = {}) {
  if (!isAfterFinalizeEnabled()) {
    try {
      const button = await driver.wait(
        async () => {
          const elements = await driver.findElements(By.xpath(KYC_BUTTON_XPATH));
          return elements.length > 0 ? elements[0] : null;
        },
        OLD_KYC_WAIT_MS,
        OLD_KYC_WAIT_MESSAGE
      );
      return { ok: true, button };
    } catch (e) {
      return { ok: false, error: `Could not find or click the KYC button, or capture link: ${e.message}` };
    }
  }

  const d = resolveDeps(driver, deps);
  const st = stateOf(driver);
  const entered = d.now();
  const budget = afterFinalizeWaitMs();
  // patience is counted from the click; the KYC step always gets a minimum look of its own
  const base = Math.max((st.finalizedAt === undefined ? entered : st.finalizedAt) + budget, entered + GRACE_MS);
  const hardStop = base + GRACE_MS;
  let deadline = base;
  let openedAt = null;
  let buttonSeenAt = null;
  let nextNote = 0;
  let spinning = false;

  for (;;) {
    const buttons = await d.findButtons();
    spinning = await d.loaderVisible();
    await noteToast(d, st);
    const t = d.now();

    if (spinning) {
      if (openedAt === null) {
        openedAt = t;
        nextNote = t + PROGRESS_EVERY_MS;
        log("   ⏳ KSHEMA's loader is open - waiting for it to finish before the KYC button...");
      } else if (t >= nextNote) {
        nextNote = t + PROGRESS_EVERY_MS;
        log(`   ⏳ The loader is still open after ${seconds(t - openedAt)}s...`);
      }
      // a loader that is still open keeps the wait going a little longer, but never past the hard stop
      deadline = Math.min(Math.max(deadline, t + GRACE_MS), hardStop);
    }

    if (buttons.length > 0) {
      if (buttonSeenAt === null) buttonSeenAt = t;
      if (!spinning) {
        if (t - entered >= 1000) log(`   ✓ The KYC button appeared after ${seconds(t - entered)}s`);
        return { ok: true, button: buttons[0], waitedMs: t - entered };
      }
      // the new page is drawn, so a loader still open now is a follow-up request or a spinner that stays — not worth waiting for long
      if (t - buttonSeenAt >= BUTTON_WITH_LOADER_MS) {
        warn(`   ⚠️ The KYC button is there but a loader is still open after ${seconds(t - buttonSeenAt)}s - pressing it anyway`);
        return { ok: true, button: buttons[0], waitedMs: t - entered };
      }
    }
    if (t >= deadline) {
      if (buttons.length > 0) {
        warn("   ⚠️ The KYC button is there but a loader is still open - pressing it anyway");
        return { ok: true, button: buttons[0], waitedMs: t - entered };
      }
      break;
    }
    await d.sleep(POLL_MS);
  }

  const waitedMs = d.now() - (st.finalizedAt === undefined ? entered : st.finalizedAt);
  warn("🔎 The KYC button did not appear - looking at the page to see why...");
  const reasons = await explainStall(driver, data, { errorToasts: st.errorToasts || [], spinning }, d);
  for (const r of reasons) warn(`   • ${r.text}`);

  let title = "";
  if (!reasons.length) {
    try {
      title = oneLine(await d.pageTitle());
    } catch (e) { }
  }
  const because = reasons.length
    ? reasons.map((r) => r.text).join("; ")
    : `the page showed no message, no invalid field and no loader, so the portal simply did not move on${title ? ` (the page is "${title}")` : ""}`;
  return {
    ok: false,
    error: `The KYC button did not appear within ${seconds(waitedMs)} seconds after Save and Finalize - ${because}.`,
  };
}

module.exports = {
  isAfterFinalizeEnabled,
  afterFinalizeWaitMs,
  waitAfterFinalize,
  checkFinalizeEnabled,
  awaitKycButton,
  explainStall,
  isLoaderVisible,
  KYC_BUTTON_XPATH,
  LOADER_SELECTOR,
  OLD_KYC_WAIT_MESSAGE,
  DEFAULT_WAIT_SECONDS,
  MIN_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
};
