/**
 * National (NIC portal) login form: the two account-type lists and the Login ID / Password boxes (2026-11-14).
 *
 * What the portal shows (the owner's HTML): "User Type" = a mat-select labelled by #userGroupLabel (CUSTOMER / INTERMEDIARY /
 * BD OFFICIALS); once INTERMEDIARY is chosen a SECOND list appears, "Intermediary Type", labelled by #intermediaryTypeLabel
 * (AGENT ... BROKER POSP ... WEB AGGREGATOR). Then the Login ID box (name log_txtfield_iUsername_01, at most 26 characters)
 * and the Password box (name log_pwd_iPassword_01).
 *
 * What was wrong: the old walk found BOTH lists with the same locator (the first mat-select on the page), so the second pick
 * re-opened the User Type list, "BROKER POSP" was not in it, the miss was only logged, and the run went on to fail at the
 * password / "still on the login page". Now: each list is found by ITS OWN label, opened, the option is clicked from THAT
 * list's panel, and the value shown is read back; a miss is a named error (the owner's rule: every click and every field
 * is checked, one retry, never silently skipped). The Login ID is read back too; the Password only by its length (never
 * logged).
 *
 * One file for the three places that log in: fullPolicycompany/national.js, its TP copy nationalTPForm.js and
 * multiCompany/common/login/nationalLogin.js. No browser start here: the driver comes in, so the tests run on a fake page
 * (test/nationalLoginForm.test.js). Error sentences have no colon (the operator sees the text after the last colon).
 */
const { By, Key } = require("selenium-webdriver");

const POLL_MS = 300;
const USERNAME_LOCATOR = By.name("log_txtfield_iUsername_01");
const NAMES = { userType: "User Type", intermediaryType: "Intermediary Type" };
const LABEL_IDS = { userType: "userGroupLabel", intermediaryType: "intermediaryTypeLabel" };
const POSITION = { userType: 0, intermediaryType: 1 };
// The Intermediary Type select's own name (the owner's HTML, 2026-11-14); the User Type's is not known, so it has none here
const SELECT_NAMES = { intermediaryType: "reg_dropdown_iType_02" };

const norm = (text) => String(text == null ? "" : text).replace(/\s+/g, " ").trim().toUpperCase();
const firstLine = (e) => String((e && e.message) || e).split("\n")[0].replace(/:/g, " -");
const isStale = (e) => !!e && (e.name === "StaleElementReferenceError" || /stale element/i.test(String((e && e.message) || e)));

/**
 * Run `step`. A stale element means the portal DREW THE FORM AGAIN while we held it (it does this once its loader clears,
 * and when a choice adds the next list) - not a failure: look the element up again and redo the step, up to `tries` times
 * (the owner's live run, 2026-11-14: "stale element reference" killed the login before the first list was picked).
 */
async function freshly(driver, step, { tries = 4, log = () => {}, what = "the login form" } = {}) {
  for (let n = 1; ; n += 1) {
    try {
      return await step(n);
    } catch (e) {
      if (!isStale(e)) throw e;
      if (n >= tries) throw new Error(`National login - the page kept redrawing ${what}, so it could not be used`);
      log(`   ↻ National login - the page redrew ${what}, looking for it again (${n}/${tries - 1})`);
      await driver.sleep(500);
    }
  }
}

/** Locators of one list, most exact first: the select labelled by its label id. */
const selectLocators = (key) => [
  By.css(`mat-select[aria-labelledby~='${LABEL_IDS[key]}']`),
  By.xpath(`//*[@id='${LABEL_IDS[key]}']/ancestor::mat-form-field[1]//mat-select`),
  By.xpath(`//*[@id='${LABEL_IDS[key]}']/following::mat-select[1]`),
  ...(SELECT_NAMES[key] ? [By.css(`mat-select[name='${SELECT_NAMES[key]}']`)] : []),
];

async function visibleOf(elements) {
  const shown = [];
  for (const el of elements) {
    try {
      if (await el.isDisplayed()) shown.push(el);
    } catch (e) {
      /* stale between find and check */
    }
  }
  return shown;
}

/** Ask `probe` every POLL_MS until it answers something truthy or `waitMs` has passed. */
async function pollFor(driver, probe, waitMs) {
  for (let waited = 0; ; waited += POLL_MS) {
    let found = null;
    try {
      found = await probe();
    } catch (e) {
      found = null;
    }
    if (found) return found;
    if (waited >= waitMs) return null;
    await driver.sleep(POLL_MS);
  }
}

/** The list's select element: by its label, else (only if the label is not there) by its place among the page's lists. */
async function findSelect(driver, key, waitMs) {
  return pollFor(
    driver,
    async () => {
      for (const locator of selectLocators(key)) {
        const shown = await visibleOf(await driver.findElements(locator));
        if (shown.length) return { element: shown[0], how: "its label" };
      }
      const all = await visibleOf(await driver.findElements(By.css("mat-select")));
      const place = POSITION[key];
      // The second list counts only when two lists are on the page: one list is always the User Type
      if (all.length > place && (key === "userType" || all.length >= 2)) return { element: all[place], how: `its place (${place + 1} of ${all.length})` };
      return null;
    },
    waitMs
  );
}

/** The text the select shows now ("" when nothing is chosen). */
async function shownValue(select) {
  try {
    const parts = await select.findElements(By.css(".mat-mdc-select-value, .mat-select-value"));
    for (const part of parts) {
      const text = norm(await part.getText());
      if (text) return text;
    }
  } catch (e) {
    /* nothing readable */
  }
  return "";
}

/** The options of the panel this select opened: [{ element, text }]. */
async function openOptions(driver, select) {
  let panelId = "";
  try {
    panelId = (await select.getAttribute("aria-controls")) || (await select.getAttribute("aria-owns")) || "";
  } catch (e) {
    panelId = "";
  }
  const locators = [];
  if (panelId) locators.push(By.css(`[id='${panelId}'] mat-option`));
  locators.push(By.css(".cdk-overlay-container mat-option"));
  for (const locator of locators) {
    const shown = await visibleOf(await driver.findElements(locator));
    if (shown.length) {
      const out = [];
      for (const element of shown) out.push({ element, text: norm(await element.getText()) });
      return out;
    }
  }
  return [];
}

async function clickIt(driver, element) {
  try {
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
  } catch (e) {
    /* a click scrolls too */
  }
  try {
    await element.click();
  } catch (e) {
    await driver.executeScript("arguments[0].click();", element);
  }
}

/** Close a list that stayed open (it would cover the next box). */
async function closeList(driver, select) {
  try {
    await select.sendKeys(Key.ESCAPE);
  } catch (e) {
    /* closed already */
  }
  await driver.sleep(200);
}

/**
 * Choose `wanted` in the list `key`. Reads the value back. One retry for a click that did not take; a redrawn form is looked
 * up again (freshly). Throws a sentence naming the list and what the portal showed or offered.
 */
async function chooseIn(driver, key, wanted, { log = () => {}, waitMs = 15000 } = {}) {
  const name = NAMES[key];
  const startedAt = Date.now();
  const took = () => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
  const want = norm(wanted);
  const seen = { offered: [], shown: "", opened: false };

  const result = await freshly(
    driver,
    async () => {
      const found = await findSelect(driver, key, waitMs);
      if (!found) return "missing";
      const { element: select, how } = found;
      if (how !== "its label") log(`   ⚠ National login - the "${name}" list was found by ${how}, not by its label`);
      seen.shown = await shownValue(select);
      if (seen.shown === want) return "already";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await clickIt(driver, select);
        const options = await pollFor(driver, async () => {
          const list = await openOptions(driver, select);
          return list.length ? list : null;
        }, 8000);
        seen.offered = options || [];
        seen.opened = seen.opened || seen.offered.length > 0;
        const hit = seen.offered.find((o) => o.text === want) || null;
        if (!hit) {
          await closeList(driver, select);
          continue; // opened the wrong thing or opened late - once more
        }
        await clickIt(driver, hit.element);
        // The panel goes, the value shows
        const settled = await pollFor(driver, async () => ((await shownValue(select)) === want ? true : null), 5000);
        seen.shown = await shownValue(select);
        await closeList(driver, select);
        if (settled) return "set";
      }
      return "failed";
    },
    { log, what: `the "${name}" list` }
  );

  if (result === "already") {
    log(`   ✓ ${name} already ${want} (${took()})`);
    return want;
  }
  if (result === "set") {
    log(`   ✓ ${name} set to ${want} (${took()})`);
    return want;
  }
  if (result === "missing") {
    throw new Error(
      key === "intermediaryType"
        ? `National login - the "${name}" list did not appear after choosing the User Type, so ${want} could not be chosen`
        : `National login - the "${name}" list was not on the page, so ${want} could not be chosen`
    );
  }
  throw new Error(
    seen.offered.length && !seen.offered.some((o) => o.text === want)
      ? `National login - ${want} was not one of the choices for "${name}" (the portal offered ${seen.offered.map((o) => o.text).join(", ")})`
      : seen.offered.length
      ? `National login - "${name}" shows ${seen.shown || "nothing"} instead of ${want} after choosing it`
      : `National login - the "${name}" list did not open, so ${want} could not be chosen`
  );
}

/**
 * The login page is ready to be filled when its FIRST control shows: the User Type list (or, on a portal that labels it
 * differently, any list, or the Login ID box). The old code waited up to 30 s for the Login ID box before touching anything;
 * that box can be drawn only after the lists are chosen, so every run lost the whole 30 s first (the owner, 2026-11-14:
 * "navigation is fast but the filling starts too late"). Throws a named error when nothing shows.
 */
async function waitForNationalLoginForm(driver, { waitMs = 30000, log = () => {} } = {}) {
  const startedAt = Date.now();
  const seen = await pollFor(
    driver,
    async () => {
      if ((await visibleOf(await driver.findElements(selectLocators("userType")[0]))).length) return "the User Type list";
      if ((await visibleOf(await driver.findElements(By.css("mat-select")))).length) return "a list";
      if ((await visibleOf(await driver.findElements(USERNAME_LOCATOR))).length) return "the Login ID box";
      return null;
    },
    waitMs
  );
  if (!seen) throw new Error(`National login - the login form did not appear within ${Math.round(waitMs / 1000)} seconds (the portal may be slow or down)`);
  log(`   ✓ National login form ready, ${seen} showed after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  return seen;
}

/** Wait (after the lists are chosen) until the Login ID box is drawn; named error when it never is. */
async function waitForLoginBox(driver, { waitMs = 20000, log = () => {} } = {}) {
  const startedAt = Date.now();
  const box = await pollFor(
    driver,
    async () => {
      const shown = await visibleOf(await driver.findElements(USERNAME_LOCATOR));
      return shown.length ? shown[0] : null;
    },
    waitMs
  );
  if (!box) throw new Error(`National login - the Login ID box did not appear after the lists were chosen within ${Math.round(waitMs / 1000)} seconds`);
  log(`   ✓ Login ID box showed after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
  return box;
}

/** What both lists show now (looked up fresh): { user, inter } as upper-case text, "" when a list is not there. */
async function bothLists(driver, log) {
  return freshly(
    driver,
    async () => {
      const a = await findSelect(driver, "userType", 3000);
      const b = await findSelect(driver, "intermediaryType", 3000);
      return { user: a ? await shownValue(a.element) : "", inter: b ? await shownValue(b.element) : "" };
    },
    { log, what: "the lists" }
  );
}

/**
 * User Type -> INTERMEDIARY, then the Intermediary Type that appears -> BROKER POSP; then BOTH lists are read again (the portal
 * can redraw the first when the second is added). A list that lost its value is chosen once more; still wrong = a named error.
 * @param {Object} opts { userType, intermediaryType, log }
 */
async function selectNationalAccountType(driver, { userType = "INTERMEDIARY", intermediaryType = "BROKER POSP", log = (m) => console.log(m) } = {}) {
  const wantUser = norm(userType);
  const wantInter = norm(intermediaryType);
  const choose = async () => {
    await chooseIn(driver, "userType", userType, { log });
    // The second list is drawn after the first choice: wait for it, do not look at once
    await chooseIn(driver, "intermediaryType", intermediaryType, { log });
  };
  await choose();
  let now = await bothLists(driver, log);
  if (now.user !== wantUser || now.inter !== wantInter) {
    log(`   ↻ National login - a list lost its value after the other was chosen, choosing again`);
    await choose();
    now = await bothLists(driver, log);
  }
  if (now.user !== wantUser || now.inter !== wantInter) {
    throw new Error(`National login - the lists show ${now.user || "nothing"} and ${now.inter || "nothing"} instead of ${wantUser} and ${wantInter}`);
  }
  log(`   ✓ Both lists hold ${wantUser} and ${wantInter}`);
}

/**
 * Type `text` into the box and read it back (one retry; a redrawn form is looked up again). Nothing typed is ever written to a
 * log or an error (the Password is only compared by length, and a mismatch names the lengths only).
 */
async function typeAndVerify(driver, locator, text, label, { waitMs = 20000, log = () => {} } = {}) {
  const value = String(text == null ? "" : text);
  if (!value) throw new Error(`National login - the saved login has no ${label}`);
  const outcome = { got: "", limit: "" };
  const result = await freshly(
    driver,
    async () => {
      const box = await pollFor(
        driver,
        async () => {
          const shown = await visibleOf(await driver.findElements(locator));
          return shown.length ? shown[0] : null;
        },
        waitMs
      );
      if (!box) return "missing";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await box.clear();
        } catch (e) {
          if (isStale(e)) throw e; // looked up again by freshly; any other trouble: the next keys replace it
        }
        await box.sendKeys(value);
        outcome.got = String((await box.getAttribute("value")) || "");
        if (outcome.got === value) return "ok";
        try {
          await box.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE);
        } catch (e) {
          if (isStale(e)) throw e;
        }
      }
      try {
        outcome.limit = (await box.getAttribute("maxlength")) || "";
      } catch (e) {
        if (isStale(e)) throw e;
      }
      return "short";
    },
    { log, what: `the ${label} box` }
  );
  if (result === "ok") {
    log(`   ✓ ${label} typed and read back`);
    return;
  }
  if (result === "missing") throw new Error(`National login - the ${label} box was not on the page`);
  throw new Error(
    `National login - the ${label} box holds ${outcome.got.length} characters instead of ${value.length}` + (outcome.limit ? ` (the portal box keeps at most ${outcome.limit})` : "")
  );
}

/**
 * Click the Login button once it is on the page AND enabled (the form enables it only when both boxes are accepted). A redrawn
 * form is looked up again; a click the page swallows is made by script. Named errors, never a raw stale-element message.
 */
async function clickLoginButton(driver, locator = By.name("log_btn_login_01"), { waitMs = 10000, log = () => {} } = {}) {
  const how = await freshly(
    driver,
    async () => {
      const button = await pollFor(
        driver,
        async () => {
          const shown = await visibleOf(await driver.findElements(locator));
          return shown.length ? shown[0] : null;
        },
        waitMs
      );
      if (!button) return "missing";
      const enabled = await pollFor(driver, async () => ((await button.isEnabled()) ? true : null), waitMs);
      if (!enabled) return "disabled";
      try {
        await button.click();
        return "regular";
      } catch (e) {
        if (isStale(e)) throw e;
        await driver.executeScript("arguments[0].click();", button);
        return "script";
      }
    },
    { log, what: "the Login button" }
  );
  if (how === "missing") throw new Error("National login - the Login button was not on the page");
  if (how === "disabled") throw new Error("National login - the Login button stayed disabled, so the form did not accept the Login ID or Password");
  log(`   ✅ Login button clicked${how === "script" ? " (script click)" : ""}`);
}

module.exports = { clickLoginButton, freshly, isStale, selectNationalAccountType, waitForNationalLoginForm, waitForLoginBox, chooseIn, typeAndVerify, selectLocators, norm, firstLine, NAMES, LABEL_IDS };
