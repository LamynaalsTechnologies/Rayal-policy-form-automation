/**
 * United India, the PA Cover on the More Covers page, after the TPPD Limit (the owner, 2026-11-13):
 *   PA Cover            <input type="checkbox" name="ynPAcover" id="ynPAcover" onclick="checkdriv('1')">
 *   CPA Cover           <select name="cpaCover">  1 Year / 5 Year
 *   Nominee Name        <input name="nomineeName" id="nomineeName" maxlength="100">
 *   Nominee Relation    <select name="rltnshpstat" id="rltnshpstat">  Aunty, Brother, ... Grand-Son, Grand-daughter, Spouse, Other
 *   Owner-Driver CPA    <select name="ynOwnerDrivCpaOpt" onchange="checkfun2(this.value)">  No / Yes (Yes chosen)
 *
 * PA bought WITH UNITED INDIA (PA Cover on for this part and not through Brisk - lib/partRunner.js gives `paCover` only to
 * the part that buys it; Brisk is read from settings.PACompany, like National's TP, nationalTP/tpPa.js):
 *   PA Cover ticked, then CPA Cover = the policy's PA year (1 or 5 - the Online Policy asks it, no default), the Nominee
 *   Name (letters and spaces, upper case) and the Relation (the Online Policy offers United India's own list).
 *   A proposal opened again (Proposal Modification) comes with PA Cover ALREADY ticked while CPA Cover and the nominee boxes
 *   stay hidden until the box's own checkdriv() runs (the owner's live run, 2026-11-14: "CPA Cover is not on the page"): then
 *   it is unticked and ticked again, so they show.
 * OTHERWISE (no PA, or Brisk's certificate is the cover): PA Cover is ticked and unticked again - its checkdriv() then shows
 *   the Owner-Driver CPA question - and that question is answered "No" (the owner's steps).
 *
 * Everything the policy must give is checked BEFORE the page is touched; every click / choice / box follows the owner's rule
 * (./unitedIndiaSteps.js), a popup = [E308] in the portal's words, and what was set is read once more at the end.
 */
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { readSelectInPage } = require("../../../lib/realSelect");
const { paCoverOn, paViaBrisk } = require("../nationalTP/tpPa");
const { clickAndConfirm, selectAndConfirm, fillAndConfirm, waitForShown, notVisible, popupOr, readSelectElementInPage } = require("./unitedIndiaSteps");

const STAGE = "united-india-more-covers";
const PA_BOX = { label: "PA Cover", target: ["#ynPAcover", "input[name='ynPAcover']"] };
const CPA_COVER = { label: "CPA Cover", target: ["select[name='cpaCover']", By.name("cpaCover")] };
const NOMINEE_NAME = { label: "Nominee Name", target: ["#nomineeName", "input[name='nomineeName']"] };
const RELATION = { label: "Nominee Relation", selectId: "rltnshpstat" };
const OWNER_DRIVER_CPA = { label: "Owner-Driver CPA", target: ["select[name='ynOwnerDrivCpaOpt']", By.name("ynOwnerDrivCpaOpt")], answer: "No" };
const NAME_MAX = 100;

/** The PA is bought with this United India part: PA Cover on for it and not through Brisk. */
const buysPaHere = (data = {}) => paCoverOn(data) && !paViaBrisk(data);

/** The nominee's name as United India takes it: letters and single spaces, upper case, at most 100. */
const nomineeNameOf = (data = {}) =>
  String(data.nomineeName == null ? "" : data.nomineeName)
    .replace(/[^A-Za-z]+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, NAME_MAX)
    .trim();

/** The PA Cover box: { exists, checked, disabled }. */
const paBox = (driver) =>
  driver
    .executeScript(
      "var c = document.getElementById('ynPAcover') || document.getElementsByName('ynPAcover')[0];" +
        "return c ? { exists: true, checked: !!c.checked, disabled: !!c.disabled } : { exists: false };"
    )
    .catch(() => ({ exists: false }));

const dataProblem = (what) =>
  new MultiCompanyError("E306", `United India - ${what}, so the PA Cover cannot be filled and the run stopped there. Correct the policy, then run it again.`, {
    company: "united india",
    stage: STAGE,
    retryable: false,
  });

/**
 * @param {WebDriver} driver  on the More Covers page, the TPPD Limit set
 * @param {Object} data       the job data (paCover, settings, paCoverYears, nomineeName, nomineeRelation)
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ pa: boolean, years?: string, nominee?: string, relation?: string, ownerDriverCpa?: string }>}
 */
async function fillPaCover(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const loader = (label) => waitForLoader(driver, "united india", { stage: STAGE }).catch(popupOr(label, STAGE));
  const tick = (want) =>
    clickAndConfirm(
      driver,
      {
        label: PA_BOX.label,
        target: PA_BOX.target,
        done: async () => (await paBox(driver)).checked === want,
        effect: want ? "it is ticked" : "it is unticked",
        missing: want ? "it is not ticked" : "it is still ticked",
        stage: STAGE,
        effectMs: 3000,
      },
      { ...o, log }
    );

  if (buysPaHere(data)) {
    // the policy first
    const years = Number(data.paCoverYears);
    const name = nomineeNameOf(data);
    const relation = String(data.nomineeRelation == null ? "" : data.nomineeRelation).trim();
    const missing = [
      ![1, 5].includes(years) && `the PA year on the policy is "${data.paCoverYears == null ? "" : data.paCoverYears}" (United India takes 1 or 5)`,
      !name && "the policy has no Nominee Name",
      !relation && "the policy has no Nominee Relation",
    ].filter(Boolean);
    if (missing.length) throw dataProblem(missing.join(", and "));
    log(`🛡️ United India - PA Cover with United India: ${years} Year, nominee ${name} (${relation})`);

    if (!(await waitForShown(driver, PA_BOX.target, 10000, o))) throw notVisible(PA_BOX.label, 10, STAGE);
    const box = await paBox(driver);
    if (box.disabled && !box.checked) throw dataProblem('the "PA Cover" box is disabled on the More Covers page, so it could not be ticked');
    await tick(true);
    await loader(PA_BOX.label); // checkdriv('1')
    // ticked already (a proposal opened again) but its boxes hidden: checkdriv() has not run - untick, tick again
    if (!(await waitForShown(driver, CPA_COVER.target, 3000, o))) {
      log("↻ United India - PA Cover is ticked but CPA Cover and the nominee boxes are not shown (a proposal opened again) - unticking and ticking it again so they show");
      await tick(false);
      await loader(PA_BOX.label);
      await tick(true);
      await loader(PA_BOX.label);
    }

    const cpa = await selectAndConfirm(driver, { label: CPA_COVER.label, target: CPA_COVER.target, wanted: String(years), stage: STAGE }, { ...o, log });
    await loader(CPA_COVER.label);
    await fillAndConfirm(driver, { label: NOMINEE_NAME.label, target: NOMINEE_NAME.target, value: name, stage: STAGE }, { ...o, log });
    // the relation by its name ("GRAND-SON" = "Grand-Son"); one United India does not offer stops, listing what it offers
    const rel = await selectAndConfirm(driver, { label: RELATION.label, selectId: RELATION.selectId, wanted: relation, stage: STAGE }, { ...o, log });
    await loader(RELATION.label);

    // all of it once more
    const now = await paBox(driver);
    const cpaBox = await waitForShown(driver, CPA_COVER.target, 3000, o);
    const cpaNow = cpaBox ? await driver.executeScript(readSelectElementInPage, cpaBox).catch(popupOr(CPA_COVER.label, STAGE)) : null;
    const relNow = await driver.executeScript(readSelectInPage, RELATION.selectId).catch(popupOr(RELATION.label, STAGE));
    const nameBox = await waitForShown(driver, NOMINEE_NAME.target, 3000, o);
    const nameNow = nameBox ? String((await nameBox.getAttribute("value").catch(() => "")) || "").trim().toUpperCase() : "";
    const wrong = [
      !now.checked && "PA Cover is not ticked",
      !(cpaNow && cpaNow.value === cpa.value) && `CPA Cover reads "${(cpaNow && cpaNow.value) || ""}" instead of "${cpa.value}"`,
      nameNow !== name && `Nominee Name reads "${nameNow}" instead of "${name}"`,
      !(relNow && relNow.value === rel.value) && `Nominee Relation reads "${(relNow && relNow.value) || ""}" instead of "${rel.value}"`,
    ].filter(Boolean);
    if (wrong.length) {
      throw new MultiCompanyError("E306", `United India - after the PA Cover was filled ${wrong.join(", and ").replace(/:/g, " -")}, so the run stopped there. It will try again shortly.`, {
        company: "united india",
        stage: STAGE,
      });
    }
    log(`✅ United India - PA Cover ticked, CPA Cover ${cpa.text}, Nominee ${name}, Relation ${rel.text}`);
    return { pa: true, years: cpa.value, nominee: name, relation: rel.text };
  }

  // No PA here (off, or Brisk's): ticked and unticked - checkdriv() shows the Owner-Driver CPA question - then "No"
  const why = paViaBrisk(data) ? "the PA is Brisk's certificate" : "the policy has no PA Cover";
  log(`🛡️ United India - no PA with United India (${why}): PA Cover ticked and unticked, Owner-Driver CPA = No`);
  if (!(await waitForShown(driver, PA_BOX.target, 10000, o))) throw notVisible(PA_BOX.label, 10, STAGE);
  const box = await paBox(driver);
  if (!box.checked) {
    await tick(true);
    await loader(PA_BOX.label);
  }
  await tick(false);
  await loader(PA_BOX.label);
  const question = await waitForShown(driver, OWNER_DRIVER_CPA.target, 10000, o);
  if (!question) throw notVisible(OWNER_DRIVER_CPA.label, 10, STAGE);
  const answer = await selectAndConfirm(driver, { label: OWNER_DRIVER_CPA.label, target: OWNER_DRIVER_CPA.target, wanted: OWNER_DRIVER_CPA.answer, stage: STAGE }, { ...o, log });
  await loader(OWNER_DRIVER_CPA.label); // checkfun2()

  const after = await paBox(driver);
  if (after.checked) {
    throw new MultiCompanyError("E306", "United India - PA Cover is ticked again after the Owner-Driver CPA was answered, so the run stopped there. It will try again shortly.", {
      company: "united india",
      stage: STAGE,
    });
  }
  log(`✅ United India - PA Cover not taken, Owner-Driver CPA "${answer.text}"`);
  return { pa: false, ownerDriverCpa: answer.value };
}

module.exports = { fillPaCover, buysPaHere, nomineeNameOf, PA_BOX, CPA_COVER, NOMINEE_NAME, RELATION, OWNER_DRIVER_CPA };
