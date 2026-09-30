/**
 * Small element helpers every login/form step needs — once, instead of a
 * private copy per insurer (safeClick / safeType / typeInto / findFirstVisible
 * each existed three times).
 */
const { By } = require("selenium-webdriver");

/**
 * First element matching any of `selectors` that is actually displayed.
 * `selectors` are CSS strings, or By locators for xpath/name/id lookups.
 * Returns null when none is visible.
 */
async function firstVisible(driver, selectors) {
  for (const selector of selectors) {
    const locator = typeof selector === "string" ? By.css(selector) : selector;
    let elements = [];
    try {
      elements = await driver.findElements(locator);
    } catch (e) {
      continue;
    }
    for (const el of elements) {
      try {
        if (await el.isDisplayed()) return el;
      } catch (e) {
        /* went stale between find and check */
      }
    }
  }
  return null;
}

/** Normal click; if the page swallows it (overlay, animation), click via JS. */
async function clickWithFallback(driver, element) {
  try {
    await element.click();
  } catch (e) {
    await driver.executeScript("arguments[0].click();", element);
  }
}

/**
 * Type into an input and CHECK it landed. Angular/Kendo inputs sometimes drop
 * keystrokes or reset on blur, so the value is read back; on a mismatch it is
 * set through the native setter with input/change events, which frameworks
 * do notice. Returns whether the field ends up holding `value`.
 */
async function typeWithReadback(driver, element, value) {
  const want = String(value ?? "");
  try {
    await element.clear();
    await element.sendKeys(want);
    if ((await element.getAttribute("value")) === want) return true;
  } catch (e) {
    /* fall through to the script path */
  }
  try {
    await driver.executeScript(
      `const el = arguments[0], v = arguments[1];
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       setter.call(el, v);
       el.dispatchEvent(new Event('input', { bubbles: true }));
       el.dispatchEvent(new Event('change', { bubbles: true }));`,
      element,
      want
    );
    return (await element.getAttribute("value")) === want;
  } catch (e) {
    return false;
  }
}

module.exports = { firstVisible, clickWithFallback, typeWithReadback };
