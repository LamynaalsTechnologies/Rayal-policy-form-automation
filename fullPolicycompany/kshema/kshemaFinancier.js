/**
 * KSHEMA — the financier, on the nominee page.
 *
 * Below the nominee entry KSHEMA asks a Yes/No question about a financier. "Yes" reveals two boxes:
 *
 *   Financier Name       <input matinput class="mat-mdc-autocomplete-trigger" role="combobox" placeholder="+ Financier Name">
 *   Additional Details   <input matinput data-iid="hypo_branch_address" placeholder="Additional Details">
 *
 * The automation never touched any of it, so a policy with a financier was filed at KSHEMA without one. The Online Policy
 * already carries `hasFinancier`, `financierName` and `financierAddress` (server.js maps them); for KSHEMA the form asks
 * just the name and the Additional Details (stored in `financierAddress`).
 *
 * Called by BOTH nominee flows (kshemaQuoteForm.js, the TP copy kshemaTPQuoteForm.js) after the nominee Save and before
 * "Save and Finalize", so OD+TP and TP only behave the same. Not a policy with a financier: nothing is touched.
 *
 * The Financier Name is a SEARCH dropdown (a mat-autocomplete, `autoactivefirstoption`) that does not open for a single
 * character, so a name under MIN_NAME_LETTERS stops the run before the portal is touched. The name is typed, KSHEMA lists
 * the financiers that match (`mat-option data-iid="financier_name"`, e.g. " SERA COM PVT. LTD. ") and the FIRST one is
 * chosen. If KSHEMA lists nothing for what was typed the run stops with a plain sentence — it never types a name KSHEMA
 * does not know. After the details are entered the name box is read back again (it must still hold the choice and not be
 * marked invalid); a cleared one is entered once more. kshemaAfterFinalize.js reads the same box again if Save and Finalize
 * does not get the page to KYC.
 *
 * The page's Yes/No wording is not known, so the Yes/No group is found by the words "financier" / "hypothecat" near it and
 * the choice is VERIFIED: after "Yes" the "+ Financier Name" box must appear. If it does not, the run stops and lists every
 * Yes/No question the page showed, so the exact wording is one run away.
 *
 * Failure STOPS the policy with a plain sentence (the caller takes the screenshot): nothing is filed with a wrong financier.
 * No colon in any sentence — beautifyError keeps only the text after the last one.
 *
 * KSHEMA_FINANCIER_ENABLED in .env: ON unless false / 0 / no / off. Off = today's behaviour (the financier is not entered).
 */
const { By } = require("selenium-webdriver");
const kshemaFields = require("./kshemaFields");
const { log, warn, debug } = require("./kshemaLog");

const OFF_WORDS = new Set(["false", "0", "no", "off"]);
/** ON unless false / 0 / no / off. Read at call time. */
function isFinancierEnabled() {
  return !OFF_WORDS.has(String(process.env.KSHEMA_FINANCIER_ENABLED ?? "").trim().toLowerCase());
}

const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOW = "abcdefghijklmnopqrstuvwxyz";
const lower = (expr) => `translate(${expr}, "${UP}", "${LOW}")`;

/**
 * The Yes/No group: by its own data-iid if it has one, else the Yes/No group that follows a SHORT label mentioning a
 * financier / hypothecation (short, so a page-sized container that merely contains the word is never the label).
 */
const RADIO_GROUP_SELECTORS = [
  `//mat-radio-group[contains(${lower("@data-iid")}, "financ") or contains(${lower("@data-iid")}, "hypo")][.//input[@value="Yes"]]`,
  `//*[not(.//mat-radio-group)][string-length(normalize-space(.)) < 120][contains(${lower("normalize-space(.)")}, "financier") or contains(${lower("normalize-space(.)")}, "hypothecat")]/following::mat-radio-group[.//input[@value="Yes"]][1]`,
];

const NAME_SELECTORS = [
  `//input[contains(${lower("@placeholder")}, "financier name")]`,
  `//input[contains(${lower("@aria-label")}, "financier name")]`,
];
const DETAILS_SELECTORS = [
  'input[data-iid="hypo_branch_address"]',
  `//input[contains(${lower("@placeholder")}, "additional details")]`,
];

/**
 * Words ignored when the chosen option is compared with the typed name — used only to WARN that KSHEMA's first match looks
 * different from what the policy says ("HDFC BANK LTD" is "HDFC BANK LIMITED"); the first option is chosen either way.
 */
const FINANCIER_NOISE = new Set(["limited", "ltd", "pvt", "private", "co", "company", "corp", "corporation", "the", "and", "of"]);
const MIN_SCORE = 70;
/**
 * KSHEMA's Financier Name list does not open for a single character. The Online Policy form refuses a shorter name
 * (RayalBrokers-Frontend utils/companyRules.js, KSHEMA_FINANCIER_NAME_MIN_LETTERS — keep the two numbers equal); a policy saved
 * before that rule, or edited in the database, still gets here and would wait for a list that cannot open. Spaces do not count.
 */
const MIN_NAME_LETTERS = 2;
const NAME_BOX_WAIT_MS = 10000;
/** How long the list is given to appear after the name is typed (the search may go to the server). */
const OPTIONS_WAIT_MS = 12000;
/** The list must show the same first option for this long before it is trusted (it re-filters as the name is typed). */
const OPTIONS_SETTLE_MS = 600;
/** Where Material puts the autocomplete's options; the financier ones carry their own data-iid. */
const OPTION_SELECTORS = [
  '.cdk-overlay-container mat-option[data-iid="financier_name"]',
  ".cdk-overlay-container div[role='listbox'] mat-option",
  ".cdk-overlay-container mat-option",
];
/** The list's own "nothing found" row, which is an option but not a financier. */
const NO_RESULT_TEXT = /\bno\s+(results?|data|records?|matches|financiers?)\b|\bnot\s+found\b/i;

const truthy = (v) => v === true || String(v).toLowerCase() === "true";
const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/:/g, " -").trim();
const sentence = (what) => `Could not enter the financier on KSHEMA - ${what}`;

/** In the page: every visible Yes/No group with the nearest piece of text around it. Self-contained (selenium serialises it). */
function readRadioGroupsInPage() {
  function shown(el) {
    var r = el.getBoundingClientRect();
    var st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
  }
  var out = [];
  var groups = document.querySelectorAll("mat-radio-group");
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!shown(g)) continue;
    var values = [];
    var inputs = g.querySelectorAll("input[type='radio']");
    for (var k = 0; k < inputs.length; k++) values.push(String(inputs[k].value || ""));
    var node = g;
    var text = "";
    for (var up = 0; up < 5 && node; up++) {
      node = node.parentElement;
      var t = String((node && node.innerText) || "").replace(/\s+/g, " ").trim();
      if (t.length >= 3 && t.length <= 200) {
        text = t;
        break;
      }
    }
    out.push({ text: text, values: values });
  }
  return out;
}

/** "the page's Yes/No questions are - "Is New Vehicle?" (Yes/No); ..." for the error, or "" when it cannot be read. */
async function describeYesNoGroups(driver) {
  try {
    const groups = await driver.executeScript(readRadioGroupsInPage);
    if (!Array.isArray(groups) || !groups.length) return " The page showed no Yes/No question at all.";
    return (
      " The page's Yes/No questions are - " +
      groups.map((g) => `"${oneLine(g.text).slice(0, 80) || "no text"}" (${g.values.join("/")})`).join("; ") +
      "."
    );
  } catch (e) {
    return "";
  }
}

/** The financier options on offer right now: visible, not disabled, not the list's own "no results" row. [{ element, text }] */
async function readOffered(driver) {
  for (const selector of OPTION_SELECTORS) {
    let els = [];
    try {
      els = await driver.findElements(By.css(selector));
    } catch (e) {
      els = [];
    }
    if (!els.length) continue;
    const out = [];
    for (const element of els) {
      try {
        if (!(await element.isDisplayed())) continue;
        const text = String((await element.getText()) || "").replace(/\s+/g, " ").trim();
        if (!text || NO_RESULT_TEXT.test(text)) continue;
        const disabled = String((await element.getAttribute("aria-disabled").catch(() => "")) || "") === "true";
        if (disabled) continue;
        out.push({ element, text });
      } catch (e) { }
    }
    if (out.length) return out;
  }
  return [];
}

/**
 * Wait for the list to appear AND settle: the portal re-filters it as the name is typed (and may fetch it), so the first
 * option read a moment too early can be a stale one. Returns the options once the same first option has stood for
 * `settleMs`, or whatever is there when `waitMs` runs out ([] = KSHEMA listed nothing).
 */
async function waitForOptions(driver, { waitMs, settleMs, sleep, now }) {
  const deadline = now() + waitMs;
  let last = [];
  let signature = null;
  let since = 0;
  for (;;) {
    const options = await readOffered(driver);
    const sig = options.map((o) => o.text).join("|");
    if (options.length) {
      last = options;
      if (sig === signature) {
        if (now() - since >= settleMs) return options;
      } else {
        signature = sig;
        since = now();
      }
    } else {
      signature = null;
    }
    if (now() >= deadline) return last.length && signature ? last : [];
    await sleep(200);
  }
}

/** The Financier Name box as the page shows it now: { present, value, invalid, error }. Read-only. */
function readFinancierBoxInPage() {
  function shown(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== "none" && st.visibility !== "hidden";
  }
  var box = null;
  var inputs = document.querySelectorAll("input");
  for (var i = 0; i < inputs.length; i++) {
    var ph = String(inputs[i].getAttribute("placeholder") || "").toLowerCase();
    if (ph.indexOf("financier name") >= 0 && shown(inputs[i])) {
      box = inputs[i];
      break;
    }
  }
  if (!box) return { present: false, value: "", invalid: false, error: "" };
  var field = box.closest ? box.closest("mat-form-field, .mat-mdc-form-field") : null;
  var err = field ? field.querySelector("mat-error") : null;
  var errText = err && shown(err) ? String(err.innerText || err.textContent || "").replace(/\s+/g, " ").trim() : "";
  var cls = String(box.className || "") + " " + (field ? String(field.className || "") : "");
  var invalid =
    String(box.getAttribute("aria-invalid") || "") === "true" ||
    /\bng-invalid\b/.test(cls) ||
    /mat-form-field-invalid|mat-mdc-form-field-invalid/.test(cls) ||
    !!errText;
  return { present: true, value: String(box.value || "").trim(), invalid: invalid, error: errText };
}

async function readFinancierState(driver) {
  try {
    const state = await driver.executeScript(readFinancierBoxInPage);
    return state && typeof state === "object" ? state : { present: false, value: "", invalid: false, error: "" };
  } catch (e) {
    return { present: false, value: "", invalid: false, error: "" };
  }
}

/** Type the name into the search dropdown and choose the FIRST option KSHEMA lists for it. */
async function enterFinancierName(driver, wanted, { h, sleep, now }) {
  const found = await h.findVisible(driver, NAME_SELECTORS, null, NAME_BOX_WAIT_MS);
  if (!found.element) {
    return { ok: false, reason: `the Financier Name box did not appear after Yes was chosen.${await describeYesNoGroups(driver)}` };
  }
  const box = found.element;
  try {
    await h.clickElement(driver, box, 'the "Financier Name" box');
    await box.clear();
    await box.sendKeys(wanted);
  } catch (e) {
    return { ok: false, reason: `the Financier Name box could not be typed into (${oneLine(String((e && e.message) || e).split("\n")[0])})` };
  }

  const offered = await waitForOptions(driver, { waitMs: OPTIONS_WAIT_MS, settleMs: OPTIONS_SETTLE_MS, sleep, now });
  if (!offered.length) {
    const opened = String((await box.getAttribute("aria-expanded").catch(() => "")) || "") === "true";
    return {
      ok: false,
      reason:
        `KSHEMA's financier list showed no financier for "${oneLine(wanted)}" - the name was typed and the list was given ` +
        `${Math.round(OPTIONS_WAIT_MS / 1000)} seconds${opened ? "" : " (the list never opened)"} - check the financier name on the policy`,
    };
  }

  const first = offered[0];
  try {
    await h.clickElement(driver, first.element, `the "${first.text}" financier`);
  } catch (e) {
    return { ok: false, reason: `the financier "${oneLine(first.text)}" could not be chosen from KSHEMA's list` };
  }
  await sleep(400);
  const shown = String((await box.getAttribute("value").catch(() => "")) || "").trim();
  if (!shown) return { ok: false, reason: `the Financier Name box is empty after choosing "${oneLine(first.text)}"` };

  const score = h.scoreTextMatch(first.text, wanted, FINANCIER_NOISE);
  const alike = score >= MIN_SCORE;
  log(`   ✓ Financier Name: ${shown} (the first of ${offered.length} option(s) for "${wanted}")`);
  if (!alike) warn(`   ⚠️ KSHEMA's first match for "${wanted}" is "${first.text}" — chosen as asked, please check it`);
  return { ok: true, value: shown, options: offered.length, alike, firstText: first.text };
}

/**
 * Enter the policy's financier on the nominee page.
 *
 * @param {Object} driver
 * @param {Object} data  the job data: hasFinancier, financierName, financierAddress
 * @param {Object} [deps] test seam: { handlers, sleep }
 * @returns {Promise<{ok:true, skipped?:string, entered?:boolean, warnings?:string[]}|{ok:false, error:string}>}
 */
async function fillFinancier(driver, data = {}, deps = {}) {
  if (!isFinancierEnabled()) return { ok: true, skipped: "switched off" };
  if (!truthy(data.hasFinancier)) return { ok: true, skipped: "no financier on the policy" };

  const h = deps.handlers || kshemaFields;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));
  const now = deps.now || Date.now;
  const readState = deps.readState || (() => readFinancierState(driver));
  const name = String(data.financierName || "").trim();
  const details = String(data.financierAddress || "").trim();
  const warnings = [];

  if (!name) return { ok: false, error: sentence("the policy says it has a financier but no financier name was given.") };
  if (name.length < MIN_NAME_LETTERS) { // name is trimmed above, so spaces around it never count
    return {
      ok: false,
      error: sentence(
        `the financier name "${oneLine(name)}" is too short - KSHEMA's financier list opens only after ${MIN_NAME_LETTERS} letters, so correct the financier name on the policy.`
      ),
    };
  }

  log(`🏦 The policy has a financier — answering KSHEMA's financier question (${name})...`);

  // 1. Yes — verified by the name box appearing
  const yes = await h.selectMatRadio(driver, RADIO_GROUP_SELECTORS, "Yes", "Financier");
  if (!yes.ok) {
    return { ok: false, error: sentence(`${oneLine(yes.reason)}.${await describeYesNoGroups(driver)}`) };
  }

  // 2 + 3 + 4. the name, the Additional Details, then the name box read again. Entering the details can re-render the form;
  // a name that was cleared is entered once more — never more than twice.
  let named = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    named = await enterFinancierName(driver, name, { h, sleep, now });
    if (!named.ok) return { ok: false, error: sentence(`${named.reason}.`) };

    if (details) {
      const typed = await h.typeIntoField(driver, DETAILS_SELECTORS, details, "Additional Details");
      if (!typed.ok) {
        const why = `Additional Details was not entered (${oneLine(typed.reason)})`;
        if (!warnings.includes(why)) {
          warn(`   ⚠️ ${why}`);
          warnings.push(why);
        }
      }
    } else {
      debug("   – Additional Details: nothing to enter, skipping");
    }

    await sleep(500);
    const state = await readState();
    const problem = !state.present
      ? "the Financier Name box is gone"
      : !state.value
        ? "the Financier Name box is empty again"
        : state.invalid
          ? `KSHEMA marks the financier name as invalid${state.error ? ` (${oneLine(state.error)})` : ""}`
          : null;
    if (!problem) break;
    if (attempt === 2) {
      return { ok: false, error: sentence(`${problem} after the financier details were entered, even on a second try.`) };
    }
    log(`   ↺ Financier: ${problem} — entering it once more`);
  }

  if (!named.alike) warnings.push(`KSHEMA's first match for "${name}" was "${named.firstText}"`);
  return { ok: true, entered: true, name: named.value, warnings };
}

module.exports = {
  isFinancierEnabled,
  fillFinancier,
  enterFinancierName,
  waitForOptions,
  readOffered,
  readFinancierState,
  readFinancierBoxInPage,
  describeYesNoGroups,
  readRadioGroupsInPage,
  RADIO_GROUP_SELECTORS,
  NAME_SELECTORS,
  DETAILS_SELECTORS,
  OPTION_SELECTORS,
  FINANCIER_NOISE,
  MIN_SCORE,
  MIN_NAME_LETTERS,
};
