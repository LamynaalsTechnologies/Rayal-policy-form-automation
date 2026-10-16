/**
 * The proposer's title (salutation) on the Online Policy, as Reliance's own Title list spells it.
 *
 * Reliance's proposer form (`#proposerTitle1`) offers exactly: Mr. / Ms. / Mrs. / M/S. The operator chooses one on the
 * Online Policy form; it is saved on the policy as `proposerTitle` and the automation selects that option.
 *
 * Copy of RayalBrokers-backend/shared/proposerTitle.js (same pattern as policyDates.js); a test pins the two lists.
 */
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

/**
 * Select the policy's title on Reliance's proposer form and make sure the portal took it.
 *
 * `select` is the form's own dropdown setter (relianceForm.js safeSelectDropdown); the title is read back afterwards,
 * because setting a <select>'s value to an option that is not in the list silently leaves it blank — and the failure
 * would only surface later as an unexplained "Title is required".
 *
 * @returns {Promise<string>} the title that was selected
 * @throws when the portal does not hold the title afterwards (no colon in the message — beautifyError)
 */
async function selectProposerTitle(driver, rawTitle, { select, selectId = "proposerTitle1", log = () => {} } = {}) {
  const wanted = normalizeProposerTitle(rawTitle) || "Mr.";
  await select(driver, selectId, wanted);
  const now = await driver.executeScript(readSelectValueInPage, selectId);
  if (now !== wanted) {
    throw new Error(
      `Reliance did not take the Title "${wanted}" - its Title box reads "${now || ""}". ` +
        `The portal offers Mr., Ms., Mrs. and M/S. Nothing was submitted.`
    );
  }
  log(`✅ Title set to ${wanted}`);
  return wanted;
}

module.exports = { PROPOSER_TITLES, normalizeProposerTitle, titleFromGender, readSelectValueInPage, selectProposerTitle };
