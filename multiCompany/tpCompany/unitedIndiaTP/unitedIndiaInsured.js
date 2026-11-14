/**
 * United India Risk Details, the insured's details after Delhi - NCR (the owner, 2026-11-13):
 *   Client Type   <select id="clientType" onchange="change(document.VehicleForm.insuredname1.value)">  1 = Individual
 *                 (the portal's default), 4 Partnership Firm, 5 Sole Proprietors, 2 Corporate, 3 Govt Under Taking
 *                 -> "Individual", NOT touched when it shows it already (the owner: "now it not touch, continue with
 *                 individual"). `clientTypeFor(data)` is THE place where Individual / Corporate is decided later.
 *   High Risk     <select id="ynHighRisk" onchange="toggleHighRisk(this.value)">  "" Select / Yes / No  -> "No" (default)
 *   Title         <select id="insuredname1" onchange="setthevalue()">  MR. Mr / MISS. Miss / MRS. Mrs / MS. Ms
 *                 -> the policy's Title (Mr. / Ms. / Mrs.); none on the policy -> from the gender (male Mr., female
 *                 Ms.), as the Online Policy does. M/S (a company) stops: Client Type Corporate is not built yet.
 *   Insured Name  <input id="insuredname2" maxlength="200" onkeyup="nodot(event,1)">  -> the policy's Full Name (not
 *                 the Surname - see insuredName), letters and spaces only (the page's nodot() drops dots).
 *   Address       <input id="addressOfInsured" maxlength="200">  -> the policy's address boxes in one line (Flat / Door,
 *                 Floor, Building, Block, Road / Street, Area and Locality). The owner: commas, dots and every other
 *                 special character are not allowed - each becomes a space; only letters, numbers and single spaces
 *                 stay. A name written twice is left out (the KSHEMA line's rule: an Aadhaar read puts the village /
 *                 district into several boxes). At most 200 characters, cut between words.
 *
 * Everything the policy must give (name, address, a title United India has) is checked BEFORE the page is touched.
 * Every box follows the owner's rule (./unitedIndiaSteps.js): entered, read back, once more if it did not take, a box that
 * is not on the page is its own error; a portal popup = [E308] in its words. All five are read once more at the end.
 */
const { MultiCompanyError } = require("../../common/errors");
const { waitForLoader } = require("../../common/loader");
const { normalizeProposerTitle, titleFromGender } = require("../../../lib/proposerTitle");
const { kshemaAddressLine } = require("../../../fullPolicycompany/kshema/kshemaAddress");
const { selectAndConfirm, fillAndConfirm, alertTextOf, alertRefusal } = require("./unitedIndiaSteps");

const STAGE = "united-india-risk";
const MAX_LENGTH = 200; // both boxes' maxlength
const CLIENT_TYPE = { label: "Client Type", selectId: "clientType" };
const HIGH_RISK = { label: "High Risk", selectId: "ynHighRisk", answer: "No" };
const TITLE = { label: "Title", selectId: "insuredname1" };
const NAME = { label: "Insured Name", target: ["#insuredname2", "input[name='insuredname2']"] };
const ADDRESS = { label: "Address", target: ["#addressOfInsured", "input[name='addressOfInsured']"] };
/** Our title -> United India's option value. M/S is not here: a company is Client Type Corporate (not built yet). */
const TITLE_VALUE = { "Mr.": "MR.", "Ms.": "MS.", "Mrs.": "MRS." };

/**
 * The Client Type of this policy. Today every policy is a person: "Individual" (the portal's own default).
 * THE place for later: a company (the policy's Title M/S, or a field the owner adds) -> "Corporate" here, with its own
 * boxes after it.
 */
function clientTypeFor(/* data */) {
  return "Individual";
}

/** Letters and digits only, single spaces: every other character becomes a space. */
const plain = (text) => String(text == null ? "" : text).replace(/[^A-Za-z0-9]+/g, " ").trim();

/** Cut to `max` characters between words (a single longer word is cut where it must be). */
const cutBetweenWords = (line, max) => {
  if (line.length <= max) return line;
  const room = line.slice(0, max + 1);
  const at = room.lastIndexOf(" ");
  return (at > 0 ? room.slice(0, at) : line.slice(0, max)).trim();
};

/**
 * The Insured Name: the policy's Full Name (the job's firstName), upper case, letters and spaces only. The Surname is
 * NOT added: Full Name holds the whole name (a live case had Full Name "ANMOL ARORA", Surname "MASTER"), and KSHEMA too
 * leaves the Surname out unless its switch is on.
 * @returns {{ name: string, cleaned: boolean }}
 */
function insuredName(data = {}) {
  const raw = String(data.firstName == null ? "" : data.firstName).trim();
  const name = cutBetweenWords(raw.replace(/[^A-Za-z]+/g, " ").trim().replace(/\s+/g, " ").toUpperCase(), MAX_LENGTH);
  return { name, cleaned: name !== raw.toUpperCase().replace(/\s+/g, " ") };
}

/**
 * The one Address line: the policy's address boxes joined, a name written twice left out (kshemaAddressLine), every
 * special character a space, at most 200 characters between words.
 * @returns {{ line: string, left: string[], cut: boolean }}
 */
function insuredAddress(data = {}) {
  const joined = kshemaAddressLine(data, { maxLength: 10000 }); // no cut yet: cleaning shortens it first
  const clean = plain(joined.line).replace(/\s+/g, " ").toUpperCase();
  const line = cutBetweenWords(clean, MAX_LENGTH);
  return { line, left: joined.left || [], cut: line.length < clean.length };
}

/** The policy's title as United India's option value, or a stop sentence. */
function titleFor(data = {}) {
  const ours = normalizeProposerTitle(data.proposerTitle) || titleFromGender(data.gender);
  if (!ours) return { error: "the policy has no Title (and no gender to take it from)" };
  if (ours === "M/S") {
    return {
      error:
        'the policy\'s Title is "M/S" (a company) - United India needs Client Type Corporate for it, which is not built yet',
    };
  }
  return { ours, value: TITLE_VALUE[ours] };
}

const dataProblem = (what) =>
  new MultiCompanyError("E306", `United India - ${what}, so the insured's details cannot be filled and the run stopped there. Correct the policy, then run it again.`, {
    company: "united india",
    stage: STAGE,
    retryable: false,
  });

/** A portal alert() met on the way is its answer: [E308] in its words, not retried. */
async function portalStep(label, fn) {
  try {
    return await fn();
  } catch (e) {
    const text = alertTextOf(e);
    if (text !== null) throw alertRefusal(label, text, STAGE);
    throw e;
  }
}

/** The five boxes as the page holds them now. */
function readInsuredInPage() {
  var v = function (id) {
    var el = document.getElementById(id);
    return el ? String(el.value) : null;
  };
  return { clientType: v("clientType"), highRisk: v("ynHighRisk"), title: v("insuredname1"), name: v("insuredname2"), address: v("addressOfInsured") };
}

/**
 * @param {WebDriver} driver  on Risk Details, PUC / Delhi - NCR answered
 * @param {Object} data       the job data (proposerTitle, gender, firstName, the address boxes)
 * @param {{ log?: Function, now?: Function, sleep?: Function }} [o]
 * @returns {Promise<{ clientType, highRisk, title, name, address }>}
 */
async function fillInsuredDetails(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const loader = (label) => portalStep(label, () => waitForLoader(driver, "united india", { stage: STAGE }));

  // the policy first: nothing on the page is touched when a value is missing
  const title = titleFor(data);
  const { name, cleaned } = insuredName(data);
  const address = insuredAddress(data);
  const missing = [
    title.error,
    !name && "the policy has no Full Name",
    !address.line && "the policy has no address (Flat / Door, Building, Road, Area ...)",
  ].filter(Boolean);
  if (missing.length) throw dataProblem(missing.join(", and "));
  log(`👤 United India - insured's details: ${clientTypeFor(data)}, ${title.ours} ${name}`);
  if (cleaned) log(`   Insured Name "${data.firstName}" typed as "${name}" (letters and spaces only - the page drops dots)`);
  if (address.left.length) log(`   Address: left out as written already - ${address.left.map((x) => `"${x}"`).join(", ")}`);
  if (address.cut) log(`⚠️ United India - the address is longer than ${MAX_LENGTH} characters, cut between words`);

  // Client Type: Individual - not touched when the portal shows it already (its default)
  const clientType = await portalStep(CLIENT_TYPE.label, () =>
    selectAndConfirm(driver, { label: CLIENT_TYPE.label, selectId: CLIENT_TYPE.selectId, wanted: clientTypeFor(data), stage: STAGE }, { ...o, log })
  );
  await loader(CLIENT_TYPE.label);

  const highRisk = await portalStep(HIGH_RISK.label, () =>
    selectAndConfirm(driver, { label: HIGH_RISK.label, selectId: HIGH_RISK.selectId, wanted: HIGH_RISK.answer, stage: STAGE }, { ...o, log })
  );
  await loader(HIGH_RISK.label);

  const titleOut = await portalStep(TITLE.label, () =>
    selectAndConfirm(driver, { label: TITLE.label, selectId: TITLE.selectId, wanted: title.value, stage: STAGE }, { ...o, log })
  );
  await loader(TITLE.label);

  await portalStep(NAME.label, () => fillAndConfirm(driver, { label: NAME.label, target: NAME.target, value: name, stage: STAGE }, { ...o, log }));
  await loader(NAME.label);
  await portalStep(ADDRESS.label, () => fillAndConfirm(driver, { label: ADDRESS.label, target: ADDRESS.target, value: address.line, stage: STAGE }, { ...o, log }));
  await loader(ADDRESS.label);

  // all five once more: a box the next one changed (the Title's setthevalue(), ...) is caught here
  const now = (await portalStep(ADDRESS.label, () => driver.executeScript(readInsuredInPage))) || {};
  const same = (a, b) => String(a == null ? "" : a).trim().toUpperCase() === String(b == null ? "" : b).trim().toUpperCase();
  const wrong = [
    !same(now.clientType, clientType.value) && `Client Type reads "${now.clientType}" instead of "${clientType.value}"`,
    !same(now.highRisk, highRisk.value) && `High Risk reads "${now.highRisk}" instead of "${highRisk.value}"`,
    !same(now.title, titleOut.value) && `Title reads "${now.title}" instead of "${titleOut.value}"`,
    !same(now.name, name) && `Insured Name reads "${now.name}" instead of "${name}"`,
    !same(now.address, address.line) && `Address reads "${now.address}" instead of "${address.line}"`,
  ].filter(Boolean);
  if (wrong.length) {
    throw new MultiCompanyError(
      "E306",
      `United India - after the insured's details were entered ${wrong.join(", and ").replace(/:/g, " -")}, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  log(`✅ United India - Client Type ${clientType.text}, High Risk ${highRisk.text}, Title ${titleOut.text}, Insured Name and Address entered`);
  return { clientType: clientType.text, highRisk: highRisk.value, title: titleOut.value, name, address: address.line };
}

/**
 * High Risk = "No" once more - a proposal opened again from Proposal Modification (the owner, 2026-11-13: "give High Risk No
 * again"), then read back.
 * @returns {Promise<{ highRisk: string }>}
 */
async function setHighRiskNo(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const out = await portalStep(HIGH_RISK.label, () =>
    selectAndConfirm(driver, { label: HIGH_RISK.label, selectId: HIGH_RISK.selectId, wanted: HIGH_RISK.answer, stage: STAGE }, { ...o, log })
  );
  await portalStep(HIGH_RISK.label, () => waitForLoader(driver, "united india", { stage: STAGE }));
  const now = (await portalStep(HIGH_RISK.label, () => driver.executeScript(readInsuredInPage))) || {};
  if (String(now.highRisk == null ? "" : now.highRisk) !== String(out.value)) {
    throw new MultiCompanyError(
      "E306",
      `United India - High Risk reads "${now.highRisk == null ? "" : now.highRisk}" instead of "${out.value}" after it was chosen, so the run stopped there. It will try again shortly.`,
      { company: "united india", stage: STAGE }
    );
  }
  return { highRisk: out.value };
}

module.exports = {
  fillInsuredDetails,
  setHighRiskNo,
  clientTypeFor,
  insuredName,
  insuredAddress,
  titleFor,
  readInsuredInPage,
  CLIENT_TYPE,
  HIGH_RISK,
  TITLE,
  NAME,
  ADDRESS,
  TITLE_VALUE,
  MAX_LENGTH,
};
