/**
 * National TP — choosing the plan.
 *
 * The full-company National flow picks "OD With Long Term Act" in the "Select Your Plan" dropdown
 * (mcy_dropdown_planId_01). A third-party-only policy is bought with "5 Year Long Term Liability Only"; the portal's
 * options for a new two-wheeler are:
 *
 *   OD With Long Term Act · 5 Year Long Term Liability Only · Standalone OD · Long Term Package Policy
 *
 * Why this is not the original's safeSelectOption(driver, dropdown, "<text>"):
 *   - that matched by CONTAINS, so a short text can land on a longer option ("Long Term" is in three of the four);
 *   - when the option was missing it logged "leaving selection unchanged" and went on — with the TP form that would
 *     quietly buy whatever plan the portal had pre-selected.
 * Here the option text must EQUAL the wanted plan (spaces and case ignored), the choice is read back from the
 * dropdown, and anything else throws a TpPlanError that names the options the portal really offers. TpPlanError is
 * not retried (nationalTPForm.js's catch): running it again cannot make the plan appear.
 *
 * No browser is needed to test it: it only uses driver.wait / findElements / executeScript and element.click / getText.
 */
const { By, until } = require("selenium-webdriver");

const TP_PLAN_TEXT = "5 Year Long Term Liability Only";

const PLAN_DROPDOWN = By.name("mcy_dropdown_planId_01");
const OPTION = By.css("mat-option");
// The chosen value inside a mat-select (Angular Material MDC, with the older class as a fallback).
const SELECTED_TEXT = By.css(".mat-mdc-select-value-text, .mat-select-value-text, .mat-mdc-select-min-line");

class TpPlanError extends Error {
  constructor(message, { options = [], selected = "" } = {}) {
    super(message);
    this.name = "TpPlanError";
    this.isTpPlanError = true;
    this.stage = "tp-plan";
    this.planOptions = options;
    this.selected = selected;
  }
}

const normalise = (text) => String(text == null ? "" : text).replace(/\s+/g, " ").trim().toLowerCase();

const describe = (texts) => (texts.length ? texts.map((t) => `"${t}"`).join(", ") : "(none could be read)");

/**
 * Index of the option that IS the wanted plan — never one that merely contains it. -1 when there is none.
 * @param {string[]} optionTexts
 * @param {string} [wanted]
 */
function pickPlanOption(optionTexts, wanted = TP_PLAN_TEXT) {
  const want = normalise(wanted);
  if (!want) return -1;
  return (optionTexts || []).findIndex((text) => normalise(text) === want);
}

/** Open the Your Plan dropdown and wait for its options. */
async function openPlanDropdown(driver) {
  const dropdown = await driver.wait(until.elementLocated(PLAN_DROPDOWN), 15000);
  await driver.wait(until.elementIsVisible(dropdown), 15000);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", dropdown);
  try {
    await dropdown.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", dropdown);
  }
  await driver.wait(until.elementLocated(OPTION), 8000);
}

/**
 * The words of one element, from its textContent. Selenium's getText() returns only what is VISIBLE, and the options
 * panel fades in over a few milliseconds: read right after it opens, the first option comes back "" and drops out of
 * the list (a run listed three of the four plans). textContent does not care.
 */
async function textOf(driver, element) {
  try {
    const text = await driver.executeScript(
      "return String(arguments[0].textContent || '').replace(/\\s+/g, ' ').trim();",
      element
    );
    if (typeof text === "string" && text) return text;
  } catch (scriptError) {
    /* a stale element, or a driver without script support: fall back to getText */
  }
  return String(await element.getText()).replace(/\s+/g, " ").trim();
}

/** The open panel's options: { elements, texts } kept aligned (an option that went stale is skipped). */
async function readOptions(driver) {
  const elements = [];
  const texts = [];
  for (const element of await driver.findElements(OPTION)) {
    try {
      const text = await textOf(driver, element);
      if (text) {
        elements.push(element);
        texts.push(text);
      }
    } catch (staleError) {
      /* the list re-rendered under us — skip that entry */
    }
  }
  return { elements, texts };
}

/** Options again and again for up to `waitMs` until the wanted plan is among them (a slow panel, a re-render). */
async function readOptionsUntil(driver, wanted, waitMs) {
  const deadline = Date.now() + waitMs;
  let read = await readOptions(driver);
  while (pickPlanOption(read.texts, wanted) < 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    read = await readOptions(driver);
  }
  return read;
}

/** What the dropdown currently shows as chosen ("" when nothing is). */
async function readSelectedPlan(driver) {
  const dropdown = await driver.wait(until.elementLocated(PLAN_DROPDOWN), 15000);
  try {
    const inner = await dropdown.findElements(SELECTED_TEXT);
    if (inner.length) {
      const text = String(await inner[0].getText()).trim();
      if (text) return text;
    }
  } catch (readError) {
    /* fall through to the whole control's text */
  }
  return String(await dropdown.getText()).trim();
}

/**
 * What the dropdown shows, re-read until it is the wanted plan or `settleMs` has passed — Angular paints a choice a
 * moment after the click, and a one-shot read would call a slow repaint "the plan did not stick".
 */
async function readSelectedWithin(driver, wanted, settleMs) {
  const deadline = Date.now() + settleMs;
  let shown = await readSelectedPlan(driver);
  while (normalise(shown) !== normalise(wanted) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    shown = await readSelectedPlan(driver);
  }
  return shown;
}

/** Wait (briefly) for the options panel to close after a pick. Never throws. */
async function waitForPanelClosed(driver) {
  try {
    await driver.wait(async () => (await driver.findElements(OPTION)).length === 0, 3000);
  } catch (e) {
    /* a panel that lingers is not an error: the read-back below is what decides */
  }
}

/**
 * Choose the TP plan.
 *
 * @param {WebDriver} driver
 * @param {{wanted?: string, log?: Function, settleMs?: number, optionsWaitMs?: number}} [opts] settleMs: how long the
 *   read-back may wait for the portal to show the choice; optionsWaitMs: how long to keep re-reading the options while
 *   the wanted one is not among them yet
 * @returns {Promise<{selected: string, options: string[]}>}
 * @throws {TpPlanError} the option is not offered, or the portal does not show it as chosen afterwards
 */
async function selectTpPlan(driver, { wanted = TP_PLAN_TEXT, log = console.log, settleMs = 3000, optionsWaitMs = 3000 } = {}) {
  await openPlanDropdown(driver);
  const { elements, texts } = await readOptionsUntil(driver, wanted, optionsWaitMs);
  log(`"Your Plan" options on the portal: ${describe(texts)}`);

  const at = pickPlanOption(texts, wanted);
  if (at < 0) {
    try {
      await driver.executeScript("document.body.click();");
    } catch (e) {
      /* leave the panel as it is */
    }
    // One colon only, after "National TP" — beautifyError keeps just the text after the LAST colon (see stopBeforePlan.js).
    throw new TpPlanError(
      `National TP: the plan "${wanted}" is not offered on the National portal, so nothing was chosen or submitted. ` +
        `The plans on the portal are ${describe(texts)}.`,
      { options: texts }
    );
  }

  try {
    await driver.executeScript("arguments[0].scrollIntoView({block: 'nearest'});", elements[at]);
    await elements[at].click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", elements[at]);
  }
  await waitForPanelClosed(driver);

  const selected = await readSelectedWithin(driver, wanted, settleMs);
  if (normalise(selected) !== normalise(wanted)) {
    throw new TpPlanError(
      `National TP: chose the plan "${wanted}" but the portal shows "${selected || "(nothing)"}" — nothing was submitted.`,
      { options: texts, selected }
    );
  }
  log(`✅ TP plan selected: "${selected}"`);
  return { selected, options: texts };
}

/**
 * Called right before the quote is generated. Anything between choosing the plan and here (Class of Vehicle, RTO, make,
 * model, the non-GIC tick, the PA radio) re-renders the vehicle block; if the portal fell back to another plan, the
 * quote would be for the wrong product. Read it again and refuse.
 *
 * @throws {TpPlanError}
 */
async function assertTpPlanStillSelected(driver, { wanted = TP_PLAN_TEXT, log = console.log, settleMs = 1500 } = {}) {
  const selected = await readSelectedWithin(driver, wanted, settleMs);
  if (normalise(selected) !== normalise(wanted)) {
    throw new TpPlanError(
      `National TP: the plan changed while the form was filled — expected "${wanted}" but the portal shows ` +
        `"${selected || "(nothing)"}". Nothing was submitted.`,
      { selected }
    );
  }
  log(`TP plan still selected: "${selected}"`);
  return selected;
}

module.exports = {
  TP_PLAN_TEXT,
  TpPlanError,
  pickPlanOption,
  selectTpPlan,
  assertTpPlanStillSelected,
  readSelectedPlan,
  openPlanDropdown,
  readOptions,
  PLAN_DROPDOWN,
};
