/**
 * Reliance full-company — let "Get Coverage Details" FINISH before the flow touches the cover table, and make sure
 * PA to Owner Driver ends up the way the policy asked.
 *
 * What went wrong (2026-10-14, a policy with no PA cover: "Please Provide Nominee Name in PA to Owner Driver Nominee
 * Details" on Calculate Premium, PA still ticked although the flow had clicked its opt-out):
 *   - relianceForm.js fires Get Coverage Details four ways (click, button.click(), onclick(), FetchIDV()), so Reliance
 *     received FOUR /Motor/FetchIDV requests. They answered 1.3 s, 1.8 s, 2.9 s and 6.5 s later, in scrambled order.
 *   - Every answer runs FetchIDV's success handler: it empties #DivCoverDetails, writes the new cover table and — for
 *     an Individual client — FORCES "PA to Owner Driver" back on ("If Client type Individual, then select the Cover PA
 *     Cover to Owner Cover auto").
 *   - The flow waited for the loader, slept 1.5 s and then did its PA opt-out, Helmet, TPPD and Zero Depreciation
 *     clicks. The slow answer landed AFTER them: new table, PA ticked again, the other clicks undone.
 * A faster portal hides it, which is why it "worked before".
 *
 * Two parts, both off together with RELIANCE_COVER_SETTLE_ENABLED in the automation's .env (ON unless false / 0 / no /
 * off; read at CALL time):
 *   waitForPortalIdle        wait until no request is in flight (jQuery.active === 0, no loading mask), for a short
 *                            stable window — replaces the blind 1.5 s sleep, so a quick portal costs the same.
 *   ensureOwnerDriverPaOff   when the policy has no PA cover with Reliance: read the PA checkbox, and if it is ticked
 *                            do the portal's own opt-out again (tick -> "valid Driving License?" -> NO) until it is off.
 *
 * What it will NOT do: tick PA when it is wanted (the old flow's path is unchanged), or change any amount.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isCoverSettleEnabled() {
  return !isOff(process.env.RELIANCE_COVER_SETTLE_ENABLED);
}

/**
 * Runs IN THE PAGE (selenium serialises the source — keep it self-contained).
 * `active` is jQuery.active, the number of AJAX requests in flight: the page's own FetchIDV, the validation calls it
 * chains in front of it, the add-on scripts it loads after each answer. null when the page has no jQuery.
 */
function readPortalActivityInPage() {
  var active = window.jQuery && typeof window.jQuery.active === "number" ? window.jQuery.active : null;
  var loading = false;
  var masks = document.querySelectorAll(".k-loading-mask");
  for (var i = 0; i < masks.length; i++) {
    var rect = masks[i].getBoundingClientRect();
    var style = window.getComputedStyle(masks[i]);
    if (rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden") {
      loading = true;
      break;
    }
  }
  return { active: active, loading: loading };
}

/** One read of the portal's activity. A page that cannot be read right now counts as busy. */
async function readPortalActivity(driver) {
  try {
    const a = await driver.executeScript(readPortalActivityInPage);
    if (!a || typeof a !== "object") return { active: null, loading: false, unreadable: true };
    return { active: a.active == null ? null : Number(a.active), loading: !!a.loading, unreadable: false };
  } catch (e) {
    return { active: null, loading: false, unreadable: true };
  }
}

/** Idle = nothing in flight and no loading mask. A page without jQuery is judged by the mask alone. */
const isIdle = (a) => !a.unreadable && !a.loading && (a.active === null || a.active === 0);

/**
 * Wait until the portal has been idle for `stableMs` in a row. Chained requests leave gaps of a few hundred
 * milliseconds (validation call -> FetchIDV -> add-on scripts), so one idle moment is not enough.
 * Never throws; on `timeout` the caller carries on as the old flow did.
 *
 * @returns {Promise<{state:"idle"|"timeout", waitedMs:number, active:number|null}>}
 */
async function waitForPortalIdle(
  driver,
  { timeoutMs = 45000, stableMs = 1500, pollMs = 250, now = Date.now, sleep = (ms) => driver.sleep(ms) } = {}
) {
  const started = now();
  let idleSince = null;
  for (;;) {
    const a = await readPortalActivity(driver);
    const t = now();
    if (isIdle(a)) {
      if (idleSince === null) idleSince = t;
      if (t - idleSince >= stableMs) return { state: "idle", waitedMs: t - started, active: a.active };
    } else {
      idleSince = null;
    }
    if (t - started >= timeoutMs) return { state: "timeout", waitedMs: t - started, active: a.active };
    await sleep(pollMs);
  }
}

/** Runs IN THE PAGE: is PA to Owner Driver on the page, and is it ticked? */
function readOwnerDriverPaInPage() {
  var pa = document.getElementById("ChkBox24");
  return { exists: !!pa, checked: !!(pa && pa.checked) };
}

/** Runs IN THE PAGE: step 1 of the portal's opt-out — click the ticked PA box, which opens "valid Driving License?". */
function clickOwnerDriverPaInPage() {
  var pa = document.getElementById("ChkBox24");
  if (pa) pa.click();
  return { exists: !!pa };
}

/** Runs IN THE PAGE: step 2 — answer NO. The portal's OnNo() unticks PA, hides its nominee block, closes the dialog. */
function answerNoToLicenseInPage() {
  var no = document.getElementById("OnNoofDL");
  if (no) no.click();
  return { found: !!no };
}

async function readOwnerDriverPa(driver) {
  try {
    const s = await driver.executeScript(readOwnerDriverPaInPage);
    return { exists: !!(s && s.exists), checked: !!(s && s.checked) };
  } catch (e) {
    return { exists: false, checked: false, unreadable: true };
  }
}

/**
 * The policy does NOT want Reliance's PA to Owner Driver: make sure it is off, whatever re-rendered the cover table.
 *
 * @param {Object} driver
 * @param {Object} [opts]
 * @param {number} [opts.attempts=3]   opt-outs to try before giving up
 * @param {Function} [opts.log]        console.log-like
 * @param {number} [opts.modalWaitMs=5000]
 * @returns {Promise<{ok:boolean, checked:boolean, redone:number, attempts:number}>}
 *   ok = PA is off (or there is no PA box on the page). redone = how many opt-outs had to be repeated.
 */
async function ensureOwnerDriverPaOff(
  driver,
  { attempts = 3, log = console.log, modalWaitMs = 5000, now = Date.now, sleep = (ms) => driver.sleep(ms) } = {}
) {
  let redone = 0;
  // Read the FINAL state: a late answer still in flight would otherwise be read as "off" and then tick PA again.
  await waitForPortalIdle(driver, { timeoutMs: 20000, stableMs: 400, now, sleep });
  let state = await readOwnerDriverPa(driver);
  if (!state.exists || !state.checked) return { ok: true, checked: false, redone, attempts: 0 };

  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(
      `⚠️ PA to Owner Driver is ticked although this policy has no PA cover with Reliance ` +
        `(the portal re-ticks it when the cover table is reloaded) — switching it off again (${attempt}/${attempts})...`
    );
    redone++;

    // 1) the portal's own opt-out: click the ticked box -> it opens "Does the Owner have a valid Driving License?"
    await driver.executeScript(clickOwnerDriverPaInPage);
    // 2) wait for the question, answer NO
    const deadline = now() + modalWaitMs;
    let answered = false;
    for (;;) {
      await sleep(400);
      let r = { found: false };
      try {
        r = await driver.executeScript(answerNoToLicenseInPage);
      } catch (e) {
        /* the page was busy re-drawing — look again until the deadline */
      }
      if (r && r.found) {
        answered = true;
        break;
      }
      if (now() >= deadline) break;
    }
    if (!answered) log("⚠️ The 'valid Driving License?' question did not appear.");
    await sleep(800);

    // 3) let whatever that triggered finish, then look again
    await waitForPortalIdle(driver, { timeoutMs: 15000, stableMs: 1000, now, sleep });
    state = await readOwnerDriverPa(driver);
    if (!state.exists || !state.checked) {
      log("✅ PA to Owner Driver is off.");
      return { ok: true, checked: false, redone, attempts: attempt };
    }
  }

  return { ok: false, checked: true, redone, attempts };
}

/** The sentence the operator reads when PA could not be switched off. No colons (see beautifyError's root-cause trim). */
function ownerDriverPaStillOnMessage({ attempts = 3 } = {}) {
  return (
    `PA to Owner Driver is still ticked on the Reliance page although this policy has no PA cover with Reliance ` +
    `(switched off ${attempts} times, Reliance ticked it again each time). The policy was stopped before premium ` +
    `calculation, because it would have been bought with PA cover and asked for a nominee. ` +
    `Run the policy again, and if it keeps happening switch PA to Owner Driver off on the portal by hand.`
  );
}

module.exports = {
  isCoverSettleEnabled,
  readPortalActivityInPage,
  readPortalActivity,
  waitForPortalIdle,
  readOwnerDriverPaInPage,
  clickOwnerDriverPaInPage,
  answerNoToLicenseInPage,
  readOwnerDriverPa,
  ensureOwnerDriverPaOff,
  ownerDriverPaStillOnMessage,
};
