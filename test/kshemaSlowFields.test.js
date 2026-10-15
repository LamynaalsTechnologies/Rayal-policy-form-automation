// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaSlowFields.test.js
//
// KSHEMA slow-portal recovery (fullPolicycompany/kshema/kshemaSlowFields.js + the `recover` hook in kshemaFields.js):
//   - the Insured Declared Value box missing after the Product Type -> switch the Product Type away and back to Bundled;
//   - the PA year dropdown (or the "reason" dropdown) missing -> untick the PA checkbox and tick it again.
//
// No browser, no network, no S3, no database: a fake portal (a driver whose elements react the way the form does) and a
// virtual clock, so the 10 s waits cost nothing. The REAL field tables, selectors and helpers run against it.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { By } = require("selenium-webdriver");

const ROOT = path.join(__dirname, "..");
const FIELDS_FILE = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaFields.js");
const SLOW_FILE = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSlowFields.js");
const QUOTE_ORIGINAL = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js");
const QUOTE_COPY = path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js");
const read = (file) => fs.readFileSync(file, "utf8");

const BUNDLED = "Two Wheeler-Bundled";
const LIABILITY = "Two Wheeler-Long term Liability only";
const PRODUCTS = [BUNDLED, LIABILITY, "Two Wheeler-Standalone OD"];
const REASON = "Already have personal accident policy With 15L Sum Insured";
// what the KSHEMA portal's premium calculation answered on 2026-10-15
const TOAST_504 =
  "Http failure response for https://motorinsurance.kshema.co/api/v1/product/calc/M000000000001?wf_id=5&type=premium_calc: 504 OK";
const PA_LABEL = "Compulsory Personal Accident cover for owner-driver";

/** Silence the (very chatty) flow logging while fn runs. */
async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** Env vars set for fn (undefined = unset), restored after. */
async function withEnv(vars, fn) {
  const before = {};
  for (const key of Object.keys(vars)) {
    before[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

/**
 * A portal that behaves like the KSHEMA quote form for the three things under test. Every wait in the helpers
 * (findVisible polls with Date.now()) runs on a virtual clock that the driver's sleep() advances.
 *
 *   idvAfterReselects   the IDV box shows after the Product Type has been put BACK to Bundled this many times
 *                       (0 = already there, Infinity = never)
 *   yearAfterCycles     the year dropdown shows once PA Cover has been unticked and ticked again this many times
 *   reasonAfterCycles   the "reason" dropdown (PA off) shows after this many extra tick + untick cycles
 *   ignoreBundled       a portal that ignores the click on Bundled (the product stays where it was)
 */
function fakePortal(opts = {}) {
  const cfg = {
    idvAfterReselects: 1,
    yearAfterCycles: 1,
    reasonAfterCycles: 1,
    ignoreBundled: false,
    paChecked: true,
    // the portal's premium calculation answering a change with an error toast
    toastsOnYear: 0, // the first N year selections are answered with the toast (Infinity = always)
    toastsOnReason: 0,
    toastText: TOAST_504,
    toastMs: 6000, // how long a toast stays on screen (virtual ms)
    withTppd: false, // a TPPD Restrict radio group, "No" already chosen
    ...opts,
  };
  const state = {
    product: BUNDLED,
    open: null, // which dropdown's panel is open: "product" | "year" | "reason" | null
    reselects: 0,
    productClicks: [],
    paChecked: cfg.paChecked,
    flips: 0, // times the PA checkbox changed state
    idvTyped: "",
    yearValue: "",
    reasonValue: "",
    now: Date.now(),
    sleeps: 0,
    yearSelections: 0,
    reasonSelections: 0,
    toastUntil: 0,
    toggleSawToast: [], // at each PA checkbox click: was a toast on screen?
  };
  const toastVisible = () => state.now < state.toastUntil;
  const showToast = () => {
    state.toastUntil = state.now + cfg.toastMs;
  };
  const realNow = Date.now;
  Date.now = () => state.now;

  const idvVisible = () => state.product === BUNDLED && state.reselects >= cfg.idvAfterReselects;
  const yearVisible = () => state.paChecked && state.flips >= 2 * cfg.yearAfterCycles;
  // the flow's own untick is flip 1; each recovery cycle (tick + untick) adds two more
  const reasonVisible = () => !state.paChecked && state.flips >= 1 + 2 * cfg.reasonAfterCycles;

  const texts = (el) => async () => el;
  const optionLists = {
    product: PRODUCTS,
    year: ["1 Year", "2 Years", "3 Years", "4 Years", "5 Years"],
    reason: [REASON, "Other"],
  };
  const valueOf = (kind) => ({ product: state.product, year: state.yearValue, reason: state.reasonValue }[kind]);

  const dropdown = (kind, visible) => ({
    _kind: kind,
    async isDisplayed() {
      return visible();
    },
    async click() {
      state.open = kind;
    },
    async getText() {
      return valueOf(kind) || "";
    },
    async getAttribute() {
      return null;
    },
    async findElements() {
      const value = valueOf(kind);
      return value ? [{ async getText() { return value; } }] : [];
    },
  });
  const productSelect = dropdown("product", () => true);
  const yearSelect = dropdown("year", yearVisible);
  const reasonSelect = dropdown("reason", reasonVisible);

  const optionEls = () =>
    (optionLists[state.open] || []).map((text) => ({
      async getText() {
        return text;
      },
      async isDisplayed() {
        return true;
      },
      async click() {
        if (state.open === "product") {
          state.productClicks.push(text);
          if (text === BUNDLED && cfg.ignoreBundled) {
            state.open = null;
            return;
          }
          if (text === BUNDLED && state.product !== BUNDLED) state.reselects += 1;
          state.product = text;
        } else if (state.open === "year") {
          state.yearValue = text;
          state.yearSelections += 1;
          if (state.yearSelections <= cfg.toastsOnYear) showToast();
        } else if (state.open === "reason") {
          state.reasonValue = text;
          state.reasonSelections += 1;
          if (state.reasonSelections <= cfg.toastsOnReason) showToast();
        }
        state.open = null;
      },
    }));

  const toastLabel = {
    async isDisplayed() {
      return toastVisible();
    },
    async getText() {
      return cfg.toastText;
    },
  };
  const toastContainer = {
    async isDisplayed() {
      return toastVisible();
    },
    async getAttribute() {
      return "mdc-snackbar itoast-success";
    },
    async getText() {
      return cfg.toastText;
    },
  };
  const radio = (value, selected) => ({
    async getAttribute(name) {
      return name === "value" ? value : null;
    },
    async isSelected() {
      return selected;
    },
  });
  const tppdGroup = {
    async getTagName() {
      return "mat-radio-group";
    },
    async findElements() {
      return [radio("No", true), radio("Yes", false)];
    },
  };

  const idvInput = {
    async isDisplayed() {
      return idvVisible();
    },
    async click() {},
    async clear() {
      state.idvTyped = "";
    },
    async sendKeys(text) {
      state.idvTyped += String(text);
    },
    async getAttribute(name) {
      return name === "value" ? state.idvTyped : null;
    },
  };

  const checkboxWrapper = {
    async isDisplayed() {
      return true;
    },
    async click() {
      state.toggleSawToast.push(toastVisible());
      state.paChecked = !state.paChecked;
      state.flips += 1;
    },
  };
  const checkboxInput = {
    async isDisplayed() {
      return true;
    },
    async isSelected() {
      return state.paChecked;
    },
    async click() {
      await checkboxWrapper.click();
    },
    async findElement() {
      return checkboxWrapper;
    },
  };

  const driver = {
    state,
    restoreClock() {
      Date.now = realNow;
    },
    async sleep(ms) {
      state.sleeps += 1;
      state.now += ms;
    },
    async executeScript(script, element) {
      const text = String(script);
      if (text.includes('closest("mat-checkbox")')) return PA_LABEL; // describeCheckbox
      if (text.includes(".click()") && element && element.click) await element.click();
      return undefined;
    },
    async findElement(locator) {
      const found = await driver.findElements(locator);
      if (!found.length) throw new Error("no such element");
      return found[0];
    },
    actions() {
      return {
        sendKeys() {
          return this;
        },
        async perform() {
          state.open = null;
        },
      };
    },
    async findElements(locator) {
      const value = String(locator && locator.value);
      const isXpath = locator && locator.using === "xpath";
      // options first (".cdk-overlay-container div[role='listbox'] mat-option" also contains the panel's words)
      if (value.includes("mat-option")) return state.open ? optionEls() : [];
      // the open panel of whichever dropdown is open
      if (value.includes("role='listbox'") || value.includes("mat-select-panel")) {
        return state.open ? [{ async isDisplayed() { return true; } }] : [];
      }
      if (value.includes('input[aria-label="Search"]') || value.includes('placeholder="Search"')) return [];
      if (value.includes('mat-select-panel input[matinput]')) return [];
      // the portal's snackbar (kshemaToast.readToast): the label inside the container, or the container itself
      if (!isXpath && value.includes("mat-snack-bar-container [matsnackbarlabel]")) {
        return toastVisible() ? [toastLabel] : [];
      }
      if (!isXpath && value === "mat-snack-bar-container") return toastVisible() ? [toastContainer] : [];
      // TPPD Restrict: a radio group with "No" already chosen
      if (isXpath && value.includes('"tppd"')) return cfg.withTppd ? [tppdGroup] : [];
      // the form's controls
      if (value.includes("product_type")) return [productSelect];
      if (value.includes("insured_declared_value")) return idvVisible() ? [idvInput] : [];
      if (isXpath && value.includes("following::mat-select[1]")) return []; // the last-resort selector finds nothing
      if (isXpath && (value.includes('"personal accident"') || value.includes('"pa cover"') || value.includes('"cpa cover"'))) {
        return [checkboxInput];
      }
      if (value === 'input[type="checkbox"]') return [checkboxInput];
      if (isXpath && value.includes('"reason"')) return reasonVisible() ? [reasonSelect] : [];
      if (isXpath && value.includes('"unselecting"')) return reasonVisible() ? [reasonSelect] : [];
      if (isXpath && value.includes('"tenure"')) return yearVisible() ? [yearSelect] : [];
      if (isXpath && value.includes('"year"')) return yearVisible() ? [yearSelect] : [];
      return []; // spinner, toast, radio groups, page dumps ...
    },
  };
  void texts;
  return driver;
}

/** Run fn with a portal, always giving the real clock back. */
async function onPortal(opts, fn) {
  const driver = fakePortal(opts);
  try {
    return await quiet(() => fn(driver));
  } finally {
    driver.restoreClock();
  }
}

const quote = () => require(QUOTE_ORIGINAL);
const fieldNamed = (list, key) => list.find((f) => f.key === key);
const { typeIntoField, pickOtherOption, findAfterRecovery } = require(FIELDS_FILE);
const slow = require(SLOW_FILE);

const IDV_SELECTORS = ['input[data-iid="insured_declared_value"]', '[data-iid="insured_declared_value"]'];

/** What fillSection does for the IDV field, on the real field definition. */
async function fillIdv(driver) {
  const idv = fieldNamed(quote().VEHICLE_FIELDS, "idv");
  return typeIntoField(driver, idv.selectors, "125000", idv.label, {
    stripSpaces: idv.stripSpaces,
    maxLength: idv.maxLength,
    recover: idv.recover || null,
  });
}

/* ----------------------- pickOtherOption ----------------------- */

test("pickOtherOption: skips the product it is moving away from and prefers the liability one", () => {
  assert.equal(pickOtherOption(PRODUCTS, BUNDLED), 1);
  assert.equal(pickOtherOption([BUNDLED, "Two Wheeler-Standalone OD", LIABILITY], BUNDLED), 2, "liability wins over order");
  assert.equal(pickOtherOption([BUNDLED, "Two Wheeler-Standalone OD"], BUNDLED), 1, "otherwise the first other one");
});

test("pickOtherOption: ignores placeholders, blanks and spelling variants of the avoided product", () => {
  assert.equal(pickOtherOption(["-- Select --", "", "Two Wheeler - Bundled", LIABILITY], BUNDLED), 3);
  assert.equal(pickOtherOption(["Select", BUNDLED], BUNDLED), -1, "nothing else to switch to");
  assert.equal(pickOtherOption([], BUNDLED), -1);
});

/* ----------------------- settings ----------------------- */

test("settings: on unless false/0/no/off; the wait defaults to 10 s and stays within 3-30 s", async () => {
  await withEnv({ KSHEMA_SLOW_FIELD_RECOVERY_ENABLED: undefined, KSHEMA_SLOW_FIELD_WAIT_MS: undefined }, () => {
    assert.equal(slow.slowFieldRecoveryEnabled(), true, "on by default");
    assert.equal(slow.slowFieldWaitMs(), 10000);
  });
  for (const off of ["false", "0", "no", "OFF", " False "]) {
    await withEnv({ KSHEMA_SLOW_FIELD_RECOVERY_ENABLED: off }, () => assert.equal(slow.slowFieldRecoveryEnabled(), false, off));
  }
  await withEnv({ KSHEMA_SLOW_FIELD_RECOVERY_ENABLED: "true" }, () => assert.equal(slow.slowFieldRecoveryEnabled(), true));
  for (const [raw, expected] of [["1000", 3000], ["99999", 30000], ["15000", 15000], ["abc", 10000], ["0", 10000], ["-5", 10000]]) {
    await withEnv({ KSHEMA_SLOW_FIELD_WAIT_MS: raw }, () => assert.equal(slow.slowFieldWaitMs(), expected, raw));
  }
});

/* ----------------------- IDV: switch the Product Type away and back ----------------------- */

test("IDV: shows first time -> typed, the Product Type is never touched", async () => {
  await onPortal({ idvAfterReselects: 0 }, async (driver) => {
    const result = await fillIdv(driver);
    assert.equal(result.ok, true);
    assert.equal(driver.state.idvTyped, "125000");
    assert.deepEqual(driver.state.productClicks, []);
  });
});

test("IDV: missing -> liability, then Bundled again, then the box shows and is typed; the product ends on Bundled", async () => {
  await onPortal({ idvAfterReselects: 1 }, async (driver) => {
    const result = await fillIdv(driver);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(driver.state.productClicks, [LIABILITY, BUNDLED], "away to the liability option, then back");
    assert.equal(driver.state.product, BUNDLED);
    assert.equal(driver.state.idvTyped, "125000");
  });
});

test("IDV: still missing after the first flip -> a second flip, then it shows", async () => {
  await onPortal({ idvAfterReselects: 2 }, async (driver) => {
    const result = await fillIdv(driver);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(driver.state.productClicks, [LIABILITY, BUNDLED, LIABILITY, BUNDLED]);
    assert.equal(driver.state.product, BUNDLED);
  });
});

test("IDV: never shows -> exactly 2 flips, ends on Bundled, and the reason says what was tried (no colon in it)", async () => {
  await onPortal({ idvAfterReselects: Infinity }, async (driver) => {
    const result = await fillIdv(driver);
    assert.equal(result.ok, false);
    assert.deepEqual(driver.state.productClicks, [LIABILITY, BUNDLED, LIABILITY, BUNDLED], "two tries, no more");
    assert.equal(driver.state.product, BUNDLED, "a failed recovery never leaves the liability product on the form");
    assert.equal(
      result.reason,
      `the "Insured Declared Value" box was not on the page even after switching the Product Type to ` +
        `"${LIABILITY}" and back to "${BUNDLED}" 2 times (waited 10 s each time)`
    );
    assert.ok(!result.reason.includes(":"), "the operator message is cut at the last colon");
  });
});

test("IDV: the portal ignores Bundled -> one try, the reason says the product was left where it is", async () => {
  await onPortal({ idvAfterReselects: 1, ignoreBundled: true }, async (driver) => {
    const result = await fillIdv(driver);
    assert.equal(result.ok, false);
    assert.deepEqual(driver.state.productClicks, [LIABILITY, BUNDLED], "no second try on a product that will not go back");
    assert.match(result.reason, /box was not on the page and the Product Type was left on "Two Wheeler-Long term Liability only"/);
    assert.match(result.reason, /could not be set back to "Two Wheeler-Bundled"/);
    assert.ok(!result.reason.includes(":"));
  });
});

test("IDV: switched off -> nothing is clicked and the reason is today's", async () => {
  await withEnv({ KSHEMA_SLOW_FIELD_RECOVERY_ENABLED: "false" }, () =>
    onPortal({ idvAfterReselects: 1 }, async (driver) => {
      const result = await fillIdv(driver);
      assert.equal(result.ok, false);
      assert.deepEqual(driver.state.productClicks, [], "no recovery code ran");
      assert.equal(result.reason, 'the "Insured Declared Value" box was not on the page');
    })
  );
});

test("IDV: the look-again wait is the configured one (3 s here), not a fixed 10 s", async () => {
  await withEnv({ KSHEMA_SLOW_FIELD_WAIT_MS: "3000" }, () =>
    onPortal({ idvAfterReselects: Infinity }, async (driver) => {
      const result = await fillIdv(driver);
      assert.match(result.reason, /\(waited 3 s each time\)/);
    })
  );
});

test("IDV: a recovery that throws is reported, not crashed on, and the product is still put back", async () => {
  await onPortal({ idvAfterReselects: 1 }, async (driver) => {
    const recover = slow.idvRecovery(
      { productSelectors: ['[data-iid="product_type"]'], productText: BUNDLED },
      {
        selectOtherMatOption: async () => {
          throw new Error("browser said: boom");
        },
      }
    );
    const found = await findAfterRecovery(driver, IDV_SELECTORS, "Insured Declared Value", recover);
    assert.equal(found.found.element, null);
    assert.match(found.explain, /could not be switched to another option/);
    assert.ok(!found.explain.includes(":"), found.explain);
    assert.equal(driver.state.product, BUNDLED);
  });
});

test("IDV: the field table is wired — the real idv definition carries the recovery, with the real Product Type", async () => {
  const idv = fieldNamed(quote().VEHICLE_FIELDS, "idv");
  assert.ok(idv.recover && typeof idv.recover.run === "function", "idv has a recovery");
  assert.equal(idv.recover.tries, 2);
  const product = fieldNamed(quote().VEHICLE_FIELDS, "productType");
  assert.equal(product.value({}), BUNDLED);
  // the order the form is filled in: the product is chosen, then the IDV
  const keys = quote().VEHICLE_FIELDS.map((f) => f.key);
  assert.ok(keys.indexOf("productType") < keys.indexOf("idv"));
});

test("IDV through the real fillSection: the recovery runs inside fillVehicleDetails and the IDV is typed", async () => {
  // Only the IDV is on this fake portal — every other vehicle field fails (nothing to enter / not on the page), which is
  // fine: fillSection carries on after a failure, so the IDV step still runs and is what is looked at.
  await onPortal({ idvAfterReselects: 1 }, async (driver) => {
    const result = await quote().fillVehicleDetails(driver, { idv: 125000 });
    assert.equal(result.ok, false, "the other fields are missing on this fake portal");
    assert.ok(result.filled.includes("Insured Declared Value"), `filled: ${result.filled.join(", ")}`);
    assert.equal(driver.state.idvTyped, "125000");
    assert.deepEqual(driver.state.productClicks, [LIABILITY, BUNDLED]);
    assert.equal(driver.state.product, BUNDLED);
    assert.ok(
      !result.failures.some((f) => f.label === "Insured Declared Value"),
      "the IDV is not among the failures"
    );
  });
});

/* ----------------------- PA: untick and tick again ----------------------- */

const PA_ON = { paCover: true, paCoverCompany: "Company", paCoverYears: "1" };
const PA_OFF = { paCover: false, paCoverCompany: "Brisk" };

test("PA year: shows first time -> picked, the checkbox is never touched", async () => {
  await onPortal({ yearAfterCycles: 0 }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, true, result.error);
    assert.equal(driver.state.flips, 0);
    assert.equal(driver.state.yearValue, "1 Year");
    assert.equal(driver.state.paChecked, true);
  });
});

test("PA year: missing -> unticked then ticked again, then the year is picked; PA ends ticked", async () => {
  await onPortal({ yearAfterCycles: 1 }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, true, result.error);
    assert.equal(driver.state.flips, 2, "one untick and one tick");
    assert.equal(driver.state.paChecked, true, "PA Cover must end ticked");
    assert.equal(driver.state.yearValue, "1 Year");
  });
});

test("PA year: never shows -> exactly 2 cycles, PA left ticked, the error says what was tried", async () => {
  await onPortal({ yearAfterCycles: Infinity }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, false);
    assert.equal(driver.state.flips, 4, "two untick + tick cycles, no more");
    assert.equal(driver.state.paChecked, true, "a failed recovery never leaves PA Cover unticked");
    assert.match(
      result.error,
      /PA Cover Year — the "PA Cover Year" dropdown was not on the page even after un-ticking "PA Cover" and putting it back 2 times \(waited 10 s each time\)/
    );
    assert.equal(result.error.split(":").length, 2, "one colon only: the formatter keeps the text after the last one");
  });
});

test("PA reason (PA off): missing -> ticked then unticked again, then the reason is picked; PA ends unticked", async () => {
  await onPortal({ paChecked: true, reasonAfterCycles: 1 }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_OFF);
    assert.equal(result.ok, true, result.error);
    assert.equal(driver.state.paChecked, false, "PA Cover must end unticked");
    assert.equal(driver.state.flips, 3, "the flow's own untick, then tick and untick");
    assert.equal(driver.state.reasonValue, REASON);
  });
});

test("PA: switched off -> the checkbox is not toggled again and the error is today's", async () => {
  await withEnv({ KSHEMA_SLOW_FIELD_RECOVERY_ENABLED: "off" }, () =>
    onPortal({ yearAfterCycles: 1 }, async (driver) => {
      const result = await quote().fillPaCoverDetails(driver, PA_ON);
      assert.equal(result.ok, false);
      assert.equal(driver.state.flips, 0);
      assert.match(result.error, /"PA Cover Year" dropdown was not on the page\.$/);
    })
  );
});

test("PA: a checkbox that cannot be put back is reported and not retried", async () => {
  await onPortal({ yearAfterCycles: Infinity }, async (driver) => {
    let calls = 0;
    const recover = slow.paToggleRecovery(
      { checkboxSelectors: ['input[type="checkbox"]'], wantChecked: true, label: "PA Cover" },
      {
        setMatCheckbox: async (_driver, _selectors, wanted) => {
          calls += 1;
          return wanted ? { ok: false, reason: "did not change state" } : { ok: true };
        },
      }
    );
    const found = await findAfterRecovery(driver, ['//mat-select[.//span[contains(., "year")]]'], "PA Cover Year", recover);
    assert.equal(calls, 2, "one untick, one failed tick — and no second try");
    assert.equal(found.found.element, null);
    assert.match(found.explain, /and "PA Cover" could not be put back to ticked \(did not change state\)/);
    assert.ok(!found.explain.includes(":"));
  });
});

test("PA: the recovery object keeps no per-job state (two jobs share one process)", async () => {
  const year = fieldNamed(quote().PA_COVER_FIELDS, "paCoverYear");
  assert.ok(year.recover && year.recover.tries === 2);
  for (const first of [true, false]) {
    await onPortal({ yearAfterCycles: first ? 1 : Infinity }, async (driver) => {
      const result = await quote().fillPaCoverDetails(driver, PA_ON);
      assert.equal(result.ok, first, "the second run is not affected by the first");
    });
  }
});

/* ----------------------- PA: the portal answers a change with a gateway error ----------------------- */
// 2026-10-15: PA Cover Year was set, the premium calculation answered "Http failure response … 504 OK", and the field
// was failed on the spot — the same toast, still on screen, then failed TPPD Restrict too ("2 failed" = one toast).

const slowSection = require(SLOW_FILE);

test("504 classifier: the portal being slow is transient, a verdict on the data is not", () => {
  const transient = [
    TOAST_504,
    "Http failure response for https://x/y: 0 Unknown Error",
    "Http failure response for https://x/y: 502 Bad Gateway",
    "Http failure response for https://x/y: 503 Service Unavailable",
    "Http failure response for https://x/y: 408 Request Timeout",
    "Request timed out",
    "Gateway Time-out",
  ];
  const real = [
    "Http failure response for https://x/y: 400 Bad Request",
    "Http failure response for https://x/y: 409 Conflict",
    "Http failure response for https://x/y: 422 Unprocessable Entity",
    "Quotation already converted to proposal",
    "IDV must be between 500 and 1000",
    "Please provide a valid value",
    "",
  ];
  for (const text of transient) assert.equal(slowSection.isTransientPortalError(text), true, text);
  for (const text of real) assert.equal(slowSection.isTransientPortalError(text), false, text);
});

test("504: the field was set, the portal said 504 -> PA Cover unticked and ticked again, the year picked again, section ok", async () => {
  await onPortal({ yearAfterCycles: 0, toastsOnYear: 1, withTppd: true }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, true, result.error);
    assert.equal(driver.state.flips, 2, "one untick and one tick");
    assert.equal(driver.state.paChecked, true, "PA Cover must end ticked");
    assert.equal(driver.state.yearSelections, 2, "the year was picked again after the toggle");
    assert.equal(driver.state.yearValue, "1 Year");
  });
});

test("504: the stale toast is waited out BEFORE the checkbox is touched (the portal is let to settle first)", async () => {
  await onPortal({ yearAfterCycles: 0, toastsOnYear: 1, withTppd: true, toastMs: 6000 }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(driver.state.toggleSawToast, [false, false], "no toast was on screen at either click");
  });
});

test("504: it keeps answering 504 -> exactly 2 tries, PA left ticked, ONE colon-free sentence saying what happened", async () => {
  await onPortal({ yearAfterCycles: 0, toastsOnYear: Infinity, withTppd: true }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, false);
    assert.equal(driver.state.flips, 4, "two untick + tick cycles, no more");
    assert.equal(driver.state.paChecked, true, "a failed recovery never leaves PA Cover unticked");
    assert.equal(driver.state.yearSelections, 3, "once, then once after each cycle");
    assert.equal(
      result.error,
      "Could not fill the PA Cover details on the KSHEMA quote form - the portal answered the change with an error " +
        '(HTTP 504 on the premium calculation) even after un-ticking "PA Cover" and putting it back 2 times ' +
        "(waited 10 s each time). The portal is slow right now, so run this policy again in a few minutes."
    );
    assert.ok(!result.error.includes(":"), "beautifyError would cut the message at a colon");
    assert.equal(result.portalError, true);
  });
});

test("504: a real rejection (not the portal being slow) is NOT toggled away — it is reported as it was", async () => {
  const rejections = [
    "Http failure response for https://motorinsurance.kshema.co/api/v1/product/calc/M1?type=premium_calc: 400 Bad Request",
    "Please provide a valid IDV",
  ];
  for (const toastText of rejections) {
    await onPortal({ yearAfterCycles: 0, toastsOnYear: 1, withTppd: true, toastText }, async (driver) => {
      const result = await quote().fillPaCoverDetails(driver, PA_ON);
      assert.equal(result.ok, false, toastText);
      assert.equal(driver.state.flips, 0, `no toggling for a verdict on the data: ${toastText}`);
      assert.ok(result.error.includes(`Portal rejected the field update: "${toastText}"`), result.error);
      assert.equal(result.portalError, undefined);
    });
  }
});

test("504: switched off -> the checkbox is not touched and the error is today's, with the portal's words", async () => {
  await withEnv({ KSHEMA_SLOW_FIELD_RECOVERY_ENABLED: "false" }, () =>
    onPortal({ yearAfterCycles: 0, toastsOnYear: 1, withTppd: true }, async (driver) => {
      const result = await quote().fillPaCoverDetails(driver, PA_ON);
      assert.equal(result.ok, false);
      assert.equal(driver.state.flips, 0);
      assert.match(result.error, /PA Cover Year — Portal rejected the field update: "Http failure response for .*504 OK"/);
    })
  );
});

test("504 with PA OFF (Brisk): the mirror — ticked then unticked again, the reason picked again, ends UNticked", async () => {
  await onPortal({ paChecked: true, reasonAfterCycles: 0, toastsOnReason: 1, withTppd: true }, async (driver) => {
    const result = await quote().fillPaCoverDetails(driver, PA_OFF);
    assert.equal(result.ok, true, result.error);
    assert.equal(driver.state.paChecked, false, "PA Cover must end unticked");
    assert.equal(driver.state.flips, 3, "the flow's own untick, then tick and untick");
    assert.equal(driver.state.reasonValue, REASON);
  });
});

test("504: the recovery works from the first result — a checkbox that cannot be put back is reported, not retried", async () => {
  let ticks = 0;
  const first = {
    ok: false,
    filled: ["PA Cover", "PA Cover Year"],
    failures: [{ label: "PA Cover Year", reason: `Portal rejected the field update: "${TOAST_504}"` }],
    screenshots: [],
    error: "x",
  };
  const result = await quiet(() =>
    slowSection.recoverSectionAfterPortalError(
      {},
      first,
      {
        fillAgain: async () => {
          throw new Error("must not run: the box was never put back");
        },
        checkboxSelectors: ['input[type="checkbox"]'],
        wantChecked: true,
        label: "PA Cover",
        sectionLabel: "PA Cover details",
      },
      {
        waitForQuiet: async () => true,
        waitForLoader: async () => true,
        sleep: async () => {},
        describeCheckbox: async () => PA_LABEL,
        setMatCheckbox: async (_d, _s, wanted) => {
          ticks += 1;
          return wanted ? { ok: false, reason: "did not change state" } : { ok: true };
        },
      }
    )
  );
  assert.equal(ticks, 2, "one untick, one failed tick, and no second try");
  assert.equal(result.ok, false);
  assert.match(result.error, /the portal answered with an error \(HTTP 504 on the premium calculation\) and then "PA Cover" could not be put back to ticked \(did not change state\)/);
  assert.ok(!result.error.includes(":"));
});

test("504: after the recovery a DIFFERENT problem is reported as it is, not dressed up as the portal being slow", async () => {
  const transientFirst = {
    ok: false,
    filled: [],
    failures: [{ label: "PA Cover Year", reason: `Portal rejected the field update: "${TOAST_504}"` }],
    screenshots: [],
    error: "first",
  };
  const different = { ok: false, filled: [], failures: [{ label: "PA Cover Year", reason: "the portal listed no years" }], screenshots: [], error: "second" };
  let refills = 0;
  const result = await quiet(() =>
    slowSection.recoverSectionAfterPortalError(
      {},
      transientFirst,
      {
        fillAgain: async () => { refills += 1; return different; },
        checkboxSelectors: ["x"],
        wantChecked: true,
      },
      {
        waitForQuiet: async () => true,
        waitForLoader: async () => true,
        sleep: async () => {},
        describeCheckbox: async () => "",
        setMatCheckbox: async () => ({ ok: true }),
      }
    )
  );
  assert.equal(refills, 1, "it looked once and did not try again for a problem a toggle cannot fix");
  assert.equal(result, different);
});

test("504: the checkbox that is toggled is named in the log, so 'the one checkbox' is visible", async () => {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.push(args.join(" "));
  console.warn = console.error = () => {};
  const driver = fakePortal({ yearAfterCycles: 0, toastsOnYear: 1, withTppd: true });
  try {
    const result = await quote().fillPaCoverDetails(driver, PA_ON);
    assert.equal(result.ok, true, result.error);
  } finally {
    driver.restoreClock();
    Object.assign(console, saved);
  }
  assert.ok(
    lines.some((line) => line.includes(`The "PA Cover" checkbox used for the recovery reads: "${PA_LABEL}"`)),
    "the label of the toggled checkbox is logged"
  );
  assert.ok(lines.some((line) => /The portal answered with an error \(HTTP 504 on the premium calculation\)/.test(line)));
});

test("504 wiring: both quote forms run the section recovery from fillPaCoverDetails, identically", () => {
  for (const file of [QUOTE_ORIGINAL, QUOTE_COPY]) {
    const text = read(file);
    assert.match(text, /recoverSectionAfterPortalError\(driver, await fill\(\), \{/, path.basename(file));
    assert.match(text, /checkboxSelectors: \(\) => PA_COVER_FIELDS\[0\]\.selectors,/);
    assert.match(text, /sectionLabel: "PA Cover details",/);
  }
});

/* ----------------------- wiring ----------------------- */

test("wiring: both quote forms pass `recover` to the select and the text helpers and carry the PA hooks", () => {
  for (const file of [QUOTE_ORIGINAL, QUOTE_COPY]) {
    const text = read(file);
    assert.equal(text.split("recover: field.recover || null,").length - 1, 2, `${path.basename(file)}: select + text`);
    assert.equal(text.split("paToggleRecovery({").length - 1, 2, `${path.basename(file)}: year + reason`);
    assert.match(text, /kshema\/kshemaSlowFields"\)|\.\/kshemaSlowFields"\)/);
  }
  assert.match(read(QUOTE_ORIGINAL), /recover: idvRecovery\(\{/, "the full-company IDV carries the Product Type recovery");
  assert.ok(!/recover: idvRecovery\(\{/.test(read(QUOTE_COPY)), "a third-party-only policy has no IDV to recover");
});

test("wiring: the helper module is shared, not copied, and has no TP / Breaker knowledge", () => {
  const text = read(SLOW_FILE);
  assert.ok(!/KSHEMA_TP_|tpProduct|Breaker\./.test(text));
  assert.ok(!fs.existsSync(path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaSlowFields.js")));
});
