/**
 * Portal-agnostic field-definition-table engine.
 *
 * Generalized from fullPolicycompany/kshema/kshemaQuoteForm.js's fillSection
 * (which stays exactly as-is, for Kshema's own Angular Material fields). This
 * version does not know or care what kind of widget it is filling — every
 * interaction is delegated to an ADAPTER (see multiCompany/adapters/), so the
 * same field-definition-table shape works for Kendo UI (Reliance, National)
 * and, later, any other portal family without a portal-specific branch here.
 *
 * Field-definition shape:
 *   {
 *     key, label,
 *     adapter: "kendo",                 // which adapters/*.js module handles this field
 *     kind: "autocomplete" | "dropdown" | "text" | "date" | "checkbox" | "radio",
 *     locate: (data) => locatorSpec,     // adapter-specific — passed straight through
 *     value: (data) => value,            // what to enter/select
 *     matchText: (data) => text,         // optional — substring a suggestion is checked against
 *     dependsOn: [],                     // keys of fields that must run first (cascading dropdowns)
 *     required: bool | (data) => bool,
 *     settleMs: number,                  // wait this long after a successful fill for the page to react
 *   }
 */

/**
 * Assert no field appears before something it depends on. Catches a
 * reordering bug at load time instead of as a confusing runtime failure deep
 * in a cascading dropdown.
 */
function assertFieldOrder(fields) {
  const seen = new Set();
  for (const field of fields) {
    for (const dep of field.dependsOn || []) {
      if (!seen.has(dep)) {
        throw new Error(
          `Field "${field.key}" depends on "${dep}", which has not run yet — check the order of the field-definition table.`
        );
      }
    }
    seen.add(field.key);
  }
}

/**
 * Fill one section (an ordered list of field definitions) against a live
 * driver, using the adapter each field names.
 *
 * @param {import('selenium-webdriver').WebDriver} driver
 * @param {Object} data - the job's shared form data
 * @param {Array} fields - a field-definition table
 * @param {string} sectionName - used in the message the operator reads
 * @param {Object} adapters - { [adapterName]: adapterModule }
 * @param {Function} [capture] - `(name, stage) => Promise<{screenshotUrl}>`, called on a failure
 * @returns {Promise<{ok, filled, failures, screenshots, landed, error}>}
 */
async function fillSection(driver, data, fields, sectionName, adapters, capture = null) {
  assertFieldOrder(fields);

  const filled = [];
  const failures = [];
  const screenshots = [];
  const landed = {};

  for (const field of fields) {
    const value = field.value(data);
    let isEmpty = Array.isArray(value) ? value.length === 0 : !value;
    if (field.kind === "checkbox" && value === false) {
      isEmpty = false; // false is a valid, meaningful value for a checkbox (uncheck)
    }

    if (isEmpty) {
      const isRequired = typeof field.required === "function" ? field.required(data) : field.required;
      if (isRequired) {
        failures.push({ label: field.label, reason: `this policy has no ${field.label.toLowerCase()} to enter` });
      }
      continue;
    }

    const adapter = adapters[field.adapter];
    let result;
    try {
      if (!adapter) {
        result = { ok: false, reason: `no adapter registered for "${field.adapter}"` };
      } else {
        const locatorSpec = field.locate(data);
        // Typing-style interaction (autocomplete/text/date) vs a discrete
        // pick (dropdown/radio/checkbox) go through different adapter methods.
        result =
          field.kind === "dropdown" || field.kind === "radio" || field.kind === "checkbox"
            ? await adapter.select(driver, locatorSpec, field, value, data)
            : await adapter.type(driver, locatorSpec, field, value, data);
      }
    } catch (error) {
      result = { ok: false, reason: error.message };
    }

    if (result.ok) {
      filled.push(field.label);
      landed[field.key] = result.value;
      if (field.settleMs) await driver.sleep(field.settleMs);
    } else {
      const isRequired = typeof field.required === "function" ? field.required(data) : field.required;
      if (isRequired) {
        if (capture) {
          const shot = await capture(`${field.key}_failed`, sectionName);
          if (shot && shot.screenshotUrl) screenshots.push(shot);
        }
        failures.push({ label: field.label, reason: result.reason });
      }
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    filled,
    failures,
    screenshots,
    landed,
    error: ok
      ? null
      : `Could not fill ${sectionName}: ` + failures.map((f) => `${f.label} — ${f.reason}`).join("; "),
  };
}

module.exports = { fillSection, assertFieldOrder };
