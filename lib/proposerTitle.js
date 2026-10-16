/**
 * The proposer's title (salutation) on the Online Policy, as Reliance's own Title list spells it.
 *
 * Reliance's proposer form (`#proposerTitle1`) offers exactly: Mr. / Ms. / Mrs. / M/S. The operator chooses one on the
 * Online Policy form; it is saved on the policy as `proposerTitle` and the automation selects that option.
 *
 * Copy of RayalBrokers-backend/shared/proposerTitle.js (same pattern as policyDates.js); a test pins the two lists.
 *
 * The Form 60 box is only half of it (found 2026-10-16, from a live Reliance window and two failed runs). Its Title is
 * read when the box is SUBMITTED and copied into the MAIN page's Salutation box (`#ddlSalutation`, a Kendo list loaded
 * from Reliance per customer type), which is then locked; that box's Gender (`#ddlGender`) is a cascade of it. For an
 * Individual customer the main list is Mr., Mrs., Ms., Dr., Miss. ... and has NO "M/S" (that is the Corporate title),
 * and Reliance's Gender list for Mr. / Ms. / Mrs. holds one entry (Male / Female / Female) but for M/S all three. So
 * "M/S" shows in the Form 60 box, never reaches the main page, Salutation and Gender stay on "Select" (locked) and
 * "Validate Customer" answers "Please select Salutation. Please select Gender." - which the flow only noticed much
 * later, as an empty-message failure. Behind RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED:
 *
 *   selectProposerTitle   ALWAYS selects the policy's own Title (the owner, 2026-10-16: "whatever is selected in the data
 *                         must be selected"); a Title the main page's list lacks only gets a warning line in the log;
 *   verifyMainPageTitle   after the box is submitted: the main page holds that Title and a Gender, or the run stops there
 *                         and says it was RELIANCE that did not accept it (and why).
 */
const { isRealisticSelectEnabled, selectLikeUser, setSelectByScriptInPage, looseKey } = require("./realSelect");

/** ON unless RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED is false / 0 / no / off. Read at call time. */
const isMainPageTitleCheckEnabled = () => !/^(false|0|no|off)$/i.test(String(process.env.RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED ?? "").trim());

/**
 * A Title problem no retry can fix: the operator has to change the policy (Mr. / Ms. / Mrs.) or look at Reliance's own
 * page. `nonRetryable` is read by the Reliance form's catch, which hands `retryable: false` to the queue - without it the
 * failure came back as "retryable -> pending, due in 60s" and a new Chrome opened every minute for the same refusal.
 * (The Form 60 box's own read-back - "Reliance did not take the Title" - stays a plain Error: a flaky page may be fixed
 * by another try.)
 */
class TitleError extends Error {
  constructor(message) {
    super(message);
    this.name = "TitleError";
    this.nonRetryable = true;
  }
}

const PROPOSER_TITLES = ["Mr.", "Ms.", "Mrs.", "M/S"];

const KEY = (text) => String(text == null ? "" : text).toLowerCase().replace(/[\s.]+/g, "");
const BY_KEY = new Map(PROPOSER_TITLES.map((title) => [KEY(title), title]));

/**
 * "mr", "MR.", " Mrs ", "m/s" -> the canonical option; anything else (including "") -> undefined, so an unknown value is
 * dropped rather than failing a save or typed into the portal.
 */
function normalizeProposerTitle(value) {
  return BY_KEY.get(KEY(value));
}

/** The title a gender implies when the operator has not chosen one: male -> Mr., female -> Ms., otherwise none. */
function titleFromGender(gender) {
  const g = String(gender == null ? "" : gender).trim().toLowerCase();
  if (g === "male") return "Mr.";
  if (g === "female") return "Ms.";
  return undefined;
}

/** In the page: what the Title <select> holds now. */
function readSelectValueInPage(id) {
  var el = document.getElementById(id);
  return el ? String(el.value) : null;
}

/** "Select" / "" - the placeholder of a Reliance list, i.e. nothing chosen. */
const isUnset = (value) => String(value == null ? "" : value).trim() === "" || looseKey(value) === "select";

/** In the Form 60 box (an iframe): the titles the MAIN page's Salutation list offers, or null when it cannot be read. */
function readMainSalutationListInPage() {
  try {
    var p = window.parent;
    var jq = p && p.jQuery;
    var el = p && p.document && p.document.getElementById("ddlSalutation");
    var k = jq && el && jq(el).data("kendoDropDownList");
    if (!k) return null;
    var items = k.dataSource.data();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var v = items[i] && (items[i].Value !== undefined ? items[i].Value : items[i].value);
      if (v !== undefined && v !== null) out.push(String(v));
    }
    return out;
  } catch (e) {
    return null;
  }
}

/** In the main page: what its Salutation and Gender boxes hold now, and whether the Form 60 box is still open. */
function readMainTitleInPage() {
  var jq = window.jQuery;
  function box(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var k = jq && jq(el).data && jq(el).data("kendoDropDownList");
    if (k) return { value: String(k.value() == null ? "" : k.value()), enabled: !k.element.prop("disabled") };
    return { value: String(el.value == null ? "" : el.value), enabled: !el.disabled };
  }
  var open = false;
  try {
    var win = document.getElementById("ClientForm60DetailsWindow");
    var kw = jq && win && jq(win).data("kendoWindow");
    open = kw ? !kw.element.is(":hidden") : !!(win && (win.offsetWidth || win.offsetHeight));
  } catch (e) {
    open = false;
  }
  var offered = null;
  try {
    var sk = jq && jq(document.getElementById("ddlSalutation")).data("kendoDropDownList");
    if (sk) {
      offered = [];
      var items = sk.dataSource.data();
      for (var i = 0; i < items.length; i++) {
        var v = items[i] && (items[i].Value !== undefined ? items[i].Value : items[i].value);
        if (v !== undefined && v !== null) offered.push(String(v));
      }
    }
  } catch (e) {
    offered = null;
  }
  return { salutation: box("ddlSalutation"), gender: box("ddlGender"), modalOpen: open, offered: offered };
}

/** "Mr., Ms. or Mrs." */
const orList = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}` : items.join(""));

/**
 * When the main page's Salutation list has no `wanted`: { usable } = the titles of ours it DOES have. Null when it has it,
 * or the list cannot be read or looks unloaded (never a guess).
 */
function mainListLacks(wanted, offered) {
  if (!Array.isArray(offered)) return null;
  const real = offered.filter((v) => !isUnset(v));
  if (real.length < 3) return null; // not loaded yet, or not the list this was written for
  const keys = new Set(real.map(looseKey));
  if (keys.has(looseKey(wanted))) return null;
  return { usable: PROPOSER_TITLES.filter((t) => t !== wanted && keys.has(looseKey(t))) };
}

/**
 * The warning LOG line when the policy's Title is selected although the main page's list lacks it (the policy's Title is
 * selected anyway - it is not refused), or null.
 */
function mainPageTitleNote(wanted, offered) {
  const lacks = mainListLacks(wanted, offered);
  if (!lacks) return null;
  return (
    `⚠️ Reliance's main page lists no "${wanted}" for an Individual customer (that title is for companies) - selecting "${wanted}" ` +
    `anyway, as the policy says. Reliance may refuse it after the Form 60 box ("Please select Salutation")` +
    (lacks.usable.length ? `; ${orList(lacks.usable)} would be accepted.` : ".")
  );
}

/**
 * After the Form 60 box was submitted: does the MAIN page hold the policy's Title and a Gender? Reliance copies the Title
 * across when the box is submitted (and only if its main list has it) and the Gender follows from it; one that did not
 * arrive was only found later, at "Validate Customer", as "Please select Salutation. Please select Gender." Call this in
 * the main page (not inside the iframe). Polls: the copy and the Gender lookup are server round trips.
 *
 * Never a new way to fail: boxes that cannot be read at all mean "carry on as before".
 *
 * @param {Object} [o]
 * @param {Function} [o.log]
 * @param {number}   [o.timeoutMs]  how long the Title may take to arrive (default 15000)
 * @param {number}   [o.genderMs]   how long the Gender may take after it (default 10000)
 * @param {Function} [o.pause]      async (ms), test seam
 * @param {Function} [o.readState]  async (driver) -> readMainTitleInPage()'s answer, test seam
 * @returns {Promise<{checked:boolean, salutation?:string, gender?:string}>}
 * @throws when the Title or the Gender is not there (no colon in the message)
 */
async function verifyMainPageTitle(driver, rawTitle, { log = () => {}, timeoutMs = 15000, genderMs = 10000, pause, readState } = {}) {
  if (!isMainPageTitleCheckEnabled()) return { checked: false };
  const wanted = normalizeProposerTitle(rawTitle) || "Mr.";
  const sleep = pause || ((ms) => driver.sleep(ms));
  const read = readState || ((d) => d.executeScript(readMainTitleInPage));
  let last = null;
  const look = async () => {
    try {
      const now = await read(driver);
      if (now && now.salutation) last = now;
    } catch (e) {
      // the page is between renders - the last good look stands
    }
    return last;
  };

  let state = await look();
  if (!state) {
    log("⚠️ Could not read Reliance's main-page Title box - carrying on without checking it");
    return { checked: false };
  }

  // 1. the Title, copied from the Form 60 box when it was submitted
  for (let end = Date.now() + timeoutMs; isUnset(state.salutation.value) && Date.now() < end; ) {
    await sleep(500);
    state = await look();
  }
  const shown = state.salutation.value;
  if (isUnset(shown)) {
    const lacks = mainListLacks(wanted, state.offered);
    throw new TitleError(
      state.modalOpen
        ? `Reliance's Form 60 box is still open after Submit, so the Title "${wanted}" did not reach the main page. ` +
            "Check the box's own message in the screenshot, then run the policy again."
        : lacks
          ? `Reliance did not accept the Title "${wanted}" - it was selected in the Form 60 box as the policy says, but Reliance's ` +
            `main page has no "${wanted}" for an Individual customer (that title is for companies), so its Title stays on "Select" ` +
            `and Reliance answers "Please select Salutation". ` +
            `${lacks.usable.length ? `Change the Title on the policy to ${orList(lacks.usable)}` : "Change the Title on the policy"}, then run it again. Nothing was bought.`
          : `Reliance's main page still shows the Title "${shown || "Select"}" after the Form 60 box was submitted, so "${wanted}" was not carried over. ` +
            "The customer was not validated and nothing was bought. Check the screenshot, then run the policy again."
    );
  }
  if (looseKey(shown) !== looseKey(wanted)) {
    throw new TitleError(
      `Reliance's main page shows the Title "${shown}" but the policy has "${wanted}". ` +
        "The customer was not validated and nothing was bought. Check the screenshot, then run the policy again."
    );
  }

  // 2. the Gender that follows from it (one entry for Mr. / Ms. / Mrs., so Reliance fills it itself)
  if (!state.gender) {
    log(`✅ Reliance's main page holds the Title ${shown} (its Gender box could not be read)`);
    return { checked: true, salutation: shown };
  }
  for (let end = Date.now() + genderMs; isUnset(state.gender.value) && Date.now() < end; ) {
    await sleep(500);
    state = await look();
  }
  if (isUnset(state.gender.value)) {
    throw new TitleError(
      `Reliance's main page took the Title "${shown}" but left Gender on "${state.gender.value || "Select"}". ` +
        "The customer was not validated and nothing was bought. Check the screenshot, then run the policy again."
    );
  }
  log(`✅ Reliance's main page holds the Title ${shown} and Gender ${state.gender.value}`);
  return { checked: true, salutation: shown, gender: state.gender.value };
}

/**
 * Select the policy's title on Reliance's proposer form and make sure the portal took it.
 *
 * Chosen like a person (lib/realSelect.js, RELIANCE_REALISTIC_SELECT_ENABLED — on unless false / 0 / no / off): pointer
 * over the box, a click that opens the list, a click on the option. Off = the form's own dropdown setter `select`
 * (relianceForm.js safeSelectDropdown: set the value, fire one change event), the way it was until 2026-10-16.
 *
 * Either way the title is read back afterwards, because a <select> whose value is set to an option that is not in the
 * list silently stays blank — and the failure would only surface later as an unexplained "Title is required".
 *
 * @param {Object} [o]
 * @param {Function} [o.select]  the scripted setter (async (driver, id, value)); used only with the switch off
 * @param {string}   [o.selectId] default "proposerTitle1" (the father's title box is "proposerTitle2")
 * @param {string}   [o.label]   what the box is called in messages (default "Title")
 * @param {Function} [o.picker]  test seam for the real-pick function
 * @returns {Promise<string>} the title that was selected
 * @throws when the portal does not hold the title afterwards (no colon in the message — beautifyError)
 */
async function selectProposerTitle(driver, rawTitle, { select, selectId = "proposerTitle1", log = () => {}, label = "Title", picker } = {}) {
  const wanted = normalizeProposerTitle(rawTitle) || "Mr.";
  if (selectId === "proposerTitle1" && isMainPageTitleCheckEnabled()) {
    // The Form 60 box lists M/S, but the main page's list (read from the box's parent window) has none for an Individual.
    // The policy's Title is selected ANYWAY (the owner's rule) - the log only says what Reliance may answer.
    let offered = null;
    try {
      offered = await driver.executeScript(readMainSalutationListInPage);
    } catch (e) {
      offered = null;
    }
    const note = mainPageTitleNote(wanted, offered);
    if (note) log(note);
  }
  let how = "script";
  if (isRealisticSelectEnabled()) {
    ({ how } = await (picker || selectLikeUser)(driver, selectId, wanted, { label, log }));
  } else if (typeof select === "function") {
    await select(driver, selectId, wanted);
  } else {
    await driver.executeScript(setSelectByScriptInPage, selectId, wanted);
  }
  const now = await driver.executeScript(readSelectValueInPage, selectId);
  if (now !== wanted) {
    throw new Error(
      `Reliance did not take the ${label} "${wanted}" - its ${label} box reads "${now || ""}". ` +
        `The portal offers Mr., Ms., Mrs. and M/S. Nothing was submitted.`
    );
  }
  log(`✅ ${label} set to ${wanted}` + (how === "list" ? " (picked from the open list)" : isRealisticSelectEnabled() && how === "script" ? " (by script - the list could not be used)" : ""));
  return wanted;
}

module.exports = {
  PROPOSER_TITLES,
  normalizeProposerTitle,
  titleFromGender,
  readSelectValueInPage,
  selectProposerTitle,
  isMainPageTitleCheckEnabled,
  readMainSalutationListInPage,
  readMainTitleInPage,
  mainListLacks,
  mainPageTitleNote,
  verifyMainPageTitle,
  TitleError,
};
