/**
 * Kendo UI widget adapter — Reliance & National's portal components.
 *
 * type() is fullPolicycompany/relianceForm.js's proven selectKendoAutocomplete()
 * (types the text, polls until a matching suggestion is visible, clicks it,
 * verifies the input took a value, retries the whole cycle), relocated here
 * and driven by a field-definition table instead of being called inline.
 *
 * Only `type()` (autocomplete fields) is implemented so far — this is what
 * the make-and-model deliverable needs. A Kendo `select()` for the
 * plan/product dropdown (a non-autocomplete Kendo widget) belongs here too,
 * added when that step of the flow is built.
 */

const { By, until, Key } = require("selenium-webdriver");

/**
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {{inputId: string}} locatorSpec
 * @param {Object} field - the field definition (used for its label only)
 * @param {string} value - the text to type
 * @param {Object} data - the job's shared form data (used to resolve matchText)
 * @returns {Promise<{ok: boolean, value?: string, reason?: string}>}
 */
async function type(driver, locatorSpec, field, value, data) {
  const { inputId } = locatorSpec;
  const label = field.label;
  const searchText = String(value);
  const matchText = field.matchText ? String(field.matchText(data) ?? searchText) : searchText;
  const attempts = 3;
  const suggestionTimeoutMs = 10000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`${label} attempt ${attempt}/${attempts}: typing "${searchText}"...`);
    const input = await driver.wait(until.elementLocated(By.id(inputId)), 10000);
    await driver.wait(until.elementIsVisible(input), 5000);
    await driver.wait(until.elementIsEnabled(input), 5000);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", input);

    // Clear and re-type with events so the autocomplete re-triggers
    await driver.executeScript(
      "arguments[0].value = ''; arguments[0].dispatchEvent(new Event('input', { bubbles: true }));",
      input
    );
    await driver.sleep(200);
    await input.click();
    await input.sendKeys(searchText);
    await driver.executeScript(
      `
      var el = arguments[0];
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('keyup', { bubbles: true }));
      `,
      input
    );

    // Poll for a VISIBLE suggestion, preferring one that matches the text
    let item = null;
    const deadline = Date.now() + suggestionTimeoutMs;
    while (Date.now() < deadline && !item) {
      item = await driver.executeScript(
        `
        var match = String(arguments[0]).toUpperCase();
        var listSelector = '#' + arguments[1] + '_listbox li, .k-animation-container li, ul.k-list li, .k-list-container li';
        var els = document.querySelectorAll(listSelector);
        var firstVisible = null;
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          if (el.offsetParent === null) continue;
          if (!firstVisible) firstVisible = el;
          var t = (el.textContent || '').toUpperCase();
          if (t.indexOf(match) !== -1) return el;
        }
        return firstVisible;
        `,
        matchText,
        inputId
      );
      if (!item) await driver.sleep(400);
    }

    if (!item) {
      console.log(`⚠️ No suggestions appeared for "${searchText}" (${label}, attempt ${attempt})`);
      continue;
    }

    try {
      await driver.executeScript("arguments[0].click();", item);
    } catch (clickErr) {
      await input.sendKeys(Key.ARROW_DOWN);
      await driver.sleep(300);
      await input.sendKeys(Key.ENTER);
    }
    await driver.sleep(500);

    // Verify the input actually holds a selection now
    const valueNow = await driver.executeScript(
      "var el = document.getElementById(arguments[0]); return el ? el.value : '';",
      inputId
    );
    if (valueNow && valueNow.trim() !== "") {
      console.log(`✅ ${label} selected: "${valueNow}" (attempt ${attempt})`);
      return { ok: true, value: valueNow };
    }
    console.log(`⚠️ ${label} input empty after selection (attempt ${attempt}), retrying...`);
  }

  return {
    ok: false,
    reason: `no suggestion could be selected for "${searchText}" after ${attempts} attempts`,
  };
}

module.exports = { type };
