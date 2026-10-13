/**
 * KSHEMA TP — choosing the Product Type.
 *
 * The full-company KSHEMA form picks "Two Wheeler-Bundled" in the Product Type mat-select (data-iid="product_type")
 * through selectMatOption(), which falls back to a CONTAINS match when the exact text is missing. For a
 * third-party-only policy that fallback is dangerous: if the liability-only option is not offered, "contains" can land
 * on a longer neighbour and quietly quote the wrong product. Here the option text must EQUAL the wanted text (spaces and
 * case ignored), the choice is read back from the select, and anything else throws a TpProductError that names the
 * options the portal really offers. It is not retried (kshemaTPForm.js): running it again cannot make the option appear.
 *
 * It only uses driver.wait / findElements / executeScript and element.click / getText, so a fake driver can test it.
 */
const { By, until } = require("selenium-webdriver");

// The same hook the form's own Product Type field uses (kshemaQuoteForm.js: byIid("product_type", "mat-select")).
const PRODUCT_SELECT = By.css('mat-select[data-iid="product_type"]');
const PRODUCT_ANY = By.css('[data-iid="product_type"]');
const OPTION = By.css("mat-option");
// The chosen value inside a mat-select (Angular Material MDC, with the older class as a fallback).
const SELECTED_TEXT = By.css(".mat-mdc-select-value-text, .mat-select-value-text, .mat-mdc-select-min-line");

// A product list is a handful of entries; this only bounds the size of a message.
const MAX_OPTIONS = 25;

class TpProductError extends Error {
  constructor(message, { options = [], selected = "" } = {}) {
    super(message);
    this.name = "TpProductError";
    this.isTpProductError = true;
    this.stage = "tp-product";
    this.productOptions = options;
    this.selected = selected;
  }
}

const normalise = (text) => String(text == null ? "" : text).replace(/\s+/g, " ").trim().toLowerCase();
const describe = (texts) => (texts.length ? texts.map((t) => `"${t}"`).join(", ") : "(none could be read)");

/** Index of the option that IS the wanted text — never one that merely contains it. -1 when there is none. */
function pickProductOption(optionTexts, wanted) {
  const want = normalise(wanted);
  if (!want) return -1;
  return (optionTexts || []).findIndex((text) => normalise(text) === want);
}

/** The Product Type select: the mat-select itself, else anything carrying the data-iid. */
async function findProductSelect(driver, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const locator of [PRODUCT_SELECT, PRODUCT_ANY]) {
      const found = await driver.findElements(locator);
      for (const element of found) {
        try {
          if (await element.isDisplayed()) return element;
        } catch (staleError) {
          /* re-rendered under us — keep looking */
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new TpProductError(
        "KSHEMA TP: the Product Type dropdown was not on the quote form, so nothing was chosen or submitted.",
        {}
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/** Open the Product Type dropdown and wait for its options. Returns the select element. */
async function openProductDropdown(driver) {
  const select = await findProductSelect(driver);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", select);
  try {
    await select.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", select);
  }
  await driver.wait(until.elementLocated(OPTION), 8000);
  return select;
}

/**
 * The words of one element, from its textContent. getText() returns only what is VISIBLE and the options panel fades
 * in over a few milliseconds — read right after it opens, the first option can come back "" and drop out of the list.
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

/** Options again and again for up to `waitMs` until the wanted one is among them (a slow panel, a re-render). */
async function readOptionsUntil(driver, wanted, waitMs) {
  const deadline = Date.now() + waitMs;
  let read = await readOptions(driver);
  while (pickProductOption(read.texts, wanted) < 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    read = await readOptions(driver);
  }
  return read;
}

/** What the select currently shows as chosen ("" when nothing is). */
async function readSelectedProduct(driver) {
  const select = await findProductSelect(driver);
  try {
    const inner = await select.findElements(SELECTED_TEXT);
    if (inner.length) {
      const text = String(await inner[0].getText()).trim();
      if (text) return text;
    }
  } catch (readError) {
    /* fall through to the whole control's text */
  }
  return String(await select.getText()).trim();
}

/** What the select shows, re-read until it is the wanted text or `settleMs` has passed (Angular paints a moment late). */
async function readSelectedWithin(driver, wanted, settleMs) {
  const deadline = Date.now() + settleMs;
  let shown = await readSelectedProduct(driver);
  while (normalise(shown) !== normalise(wanted) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    shown = await readSelectedProduct(driver);
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
 * Open the dropdown and return the portal's Product Type options (trimmed, in order, no duplicates, capped).
 * The panel is LEFT OPEN: this is what the stop uses, and the open list on the held browser is the evidence.
 */
async function listProductOptions(driver) {
  await openProductDropdown(driver);
  const { texts } = await readOptions(driver);
  const options = [];
  for (const text of texts) {
    if (options.length >= MAX_OPTIONS) break;
    if (!options.includes(text)) options.push(text);
  }
  return options;
}

/**
 * Choose the TP product.
 *
 * @param {WebDriver} driver
 * @param {{wanted: string, log?: Function, settleMs?: number, optionsWaitMs?: number}} opts
 * @returns {Promise<{selected: string, options: string[], alreadySet?: boolean}>}
 * @throws {TpProductError} not offered, or the portal does not show it as chosen afterwards
 */
async function selectTpProduct(driver, { wanted, log = console.log, settleMs = 3000, optionsWaitMs = 3000 } = {}) {
  if (!normalise(wanted)) {
    throw new TpProductError("KSHEMA TP: no Product Type text is configured (KSHEMA_TP_PRODUCT_TYPE).", {});
  }

  // Already right (the form remembered it): no needless open/close of the panel.
  const current = await readSelectedProduct(driver).catch(() => "");
  if (normalise(current) === normalise(wanted)) {
    log(`✓ Product Type already set to "${current}"`);
    return { selected: current, options: [], alreadySet: true };
  }

  await openProductDropdown(driver);
  const { elements, texts } = await readOptionsUntil(driver, wanted, optionsWaitMs);
  log(`Product Type options on the portal: ${describe(texts)}`);

  const at = pickProductOption(texts, wanted);
  if (at < 0) {
    try {
      await driver.executeScript("document.body.click();");
    } catch (e) {
      /* leave the panel as it is */
    }
    // One colon only, after "KSHEMA TP" — beautifyError keeps just the text after the LAST colon of a message.
    throw new TpProductError(
      `KSHEMA TP: the Product Type "${wanted}" is not offered on the KSHEMA portal, so nothing was chosen or ` +
        `submitted. The Product Types on the portal are ${describe(texts)}.`,
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
    throw new TpProductError(
      `KSHEMA TP: chose the Product Type "${wanted}" but the portal shows "${selected || "(nothing)"}" — nothing was submitted.`,
      { options: texts, selected }
    );
  }
  log(`✅ TP Product Type selected: "${selected}"`);
  return { selected, options: texts };
}

module.exports = {
  TpProductError,
  pickProductOption,
  selectTpProduct,
  listProductOptions,
  readSelectedProduct,
  openProductDropdown,
  readOptions,
  PRODUCT_SELECT,
};
