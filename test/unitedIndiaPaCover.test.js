// United India PA Cover on the More Covers page (the owner, 2026-11-13). PA bought with United India: ticked, CPA Cover 1 / 5
// Year, Nominee Name and Relation. Otherwise (no PA, or Brisk's): ticked and unticked - the portal's checkdriv() then shows the
// Owner-Driver CPA question - answered "No". A fake page; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaPaCover.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const pa = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaPaCover");
const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");
const { readSelectInPage, setSelectByScriptInPage } = require("../lib/realSelect");

const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));
const RELATIONS = ["Aunty", "Brother", "Daughter", "Employer", "Father", "Husband", "Mother", "Niece", "Nephew", "Sister", "Son", "Uncle", "Wife", "Grand-Son", "Grand-daughter", "Spouse", "Other"];

/**
 * The More Covers page's PA block. checkdriv(): ticked shows CPA Cover / Nominee / Relation; after a click that unticks it,
 * the Owner-Driver CPA question shows.
 *   checked: the box starts ticked; disabled; noBox; questionNeverShows
 *   relationResetsYear: choosing the relation puts CPA Cover back to 1 Year (a page script that resets it)
 *   hiddenUntilClicked: the box starts ticked but its PA fields stay hidden until checkdriv() runs (a click) - a proposal opened
 *     again (the owner's live run, 2026-11-14)
 */
function page(over = {}) {
  const state = {
    checked: !!over.checked,
    clicks: 0,
    questionShown: false,
    nominee: "",
    boxes: {
      cpaCover: { options: opts([["1", "1 Year"], ["5", "5 Year"]]), selectedIndex: 0 },
      rltnshpstat: { options: opts([["", "Select"], ...RELATIONS.map((r) => [r, r])]), selectedIndex: 0 },
      ynOwnerDrivCpaOpt: { options: opts([["No", "No"], ["Yes", "Yes"]]), selectedIndex: 1 },
    },
  };
  const shown = (kind) =>
    kind === "box"
      ? !over.noBox
      : kind === "ynOwnerDrivCpaOpt"
        ? state.questionShown && !over.questionNeverShows
        : state.checked && !(over.hiddenUntilClicked && state.clicks === 0); // the PA fields show while PA Cover is ticked
  const checkbox = {
    async isDisplayed() {
      return shown("box");
    },
    async click() {
      state.clicks += 1;
      state.checked = !state.checked; // checkdriv('1')
      if (!state.checked) state.questionShown = true;
    },
  };
  const select = (kind) => ({
    kind,
    async isDisplayed() {
      return shown(kind);
    },
    async click() {},
    async findElements() {
      return state.boxes[kind].options.map((_, i) => ({
        async click() {
          state.boxes[kind].selectedIndex = i;
          if (kind === "rltnshpstat" && over.relationResetsYear) state.boxes.cpaCover.selectedIndex = 0;
        },
      }));
    },
  });
  const nameBox = {
    kind: "name",
    async isDisplayed() {
      return state.checked;
    },
    async clear() {
      state.nominee = "";
    },
    async sendKeys(v) {
      state.nominee += v;
    },
    async getAttribute(a) {
      return a === "value" ? state.nominee : null;
    },
  };
  const read = (kind) => {
    const b = state.boxes[kind];
    return { selectedIndex: b.selectedIndex, value: b.options[b.selectedIndex].value, options: b.options };
  };
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      if (/ynPAcover/.test(v)) return over.noBox ? [] : [checkbox];
      if (/cpaCover/.test(v)) return [select("cpaCover")];
      if (/rltnshpstat/.test(v)) return [select("rltnshpstat")];
      if (/ynOwnerDrivCpaOpt/.test(v)) return [select("ynOwnerDrivCpaOpt")];
      if (/nomineeName/.test(v)) return [nameBox];
      return [];
    },
    async executeScript(script, ...args) {
      if (script === readSelectInPage) return shown(args[0]) ? read(args[0]) : null;
      if (script === setSelectByScriptInPage) {
        const b = state.boxes[args[0]];
        b.selectedIndex = b.options.findIndex((o) => o.value === args[1]);
        return true;
      }
      if (script === steps.readSelectElementInPage) return read(args[0].kind);
      if (script === steps.setSelectElementInPage) {
        const b = state.boxes[args[0].kind];
        b.selectedIndex = b.options.findIndex((o) => o.value === args[1]);
        return true;
      }
      const s = String(script);
      if (s.includes("getElementById('ynPAcover')")) return over.noBox ? { exists: false } : { exists: true, checked: state.checked, disabled: !!over.disabled };
      if (s.includes("HTMLInputElement.prototype")) {
        state.nominee = String(args[1]);
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      return null;
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const run = (driver, data) => {
  const lines = [];
  return { lines, go: () => pa.fillPaCover(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};
const shows = (driver, kind) => driver.state.boxes[kind].options[driver.state.boxes[kind].selectedIndex].value;
const UI_PA = { paCover: true, settings: { PACompany: "United India" }, paCoverYears: 5, nomineeName: "deva k.", nomineeRelation: "SON" };

test("who buys the PA: United India only when PA Cover is on for this part and it is not Brisk's", () => {
  assert.equal(pa.buysPaHere(UI_PA), true);
  assert.equal(pa.buysPaHere({ ...UI_PA, settings: { PACompany: "Brisk" } }), false);
  assert.equal(pa.buysPaHere({ ...UI_PA, paCover: false }), false);
  assert.equal(pa.buysPaHere({ paCover: "true" }), true, "an old job without settings: the part's own PA flag");
});

test("PA with United India: ticked ONCE, CPA Cover 5 Year, Nominee Name (letters, upper case), Relation Son", async () => {
  const driver = page();
  const { lines, go } = run(driver, UI_PA);
  assert.deepEqual(await go(), { pa: true, years: "5", nominee: "DEVA K", relation: "Son" });
  assert.equal(driver.state.clicks, 1);
  assert.equal(driver.state.checked, true);
  assert.equal(shows(driver, "cpaCover"), "5");
  assert.equal(driver.state.nominee, "DEVA K");
  assert.equal(shows(driver, "rltnshpstat"), "Son");
  assert.equal(shows(driver, "ynOwnerDrivCpaOpt"), "Yes", "the Owner-Driver CPA question is not touched");
  assert.ok(lines.some((l) => /✅ United India - PA Cover ticked, CPA Cover 5 Year, Nominee DEVA K, Relation Son/.test(l)));
});

test("1 Year, and a relation saved upper case with a hyphen ('GRAND-SON') is United India's 'Grand-Son'", async () => {
  const driver = page();
  await run(driver, { ...UI_PA, paCoverYears: "1", nomineeRelation: "GRAND-SON" }).go();
  assert.equal(shows(driver, "cpaCover"), "1");
  assert.equal(shows(driver, "rltnshpstat"), "Grand-Son");
});

test("PA Cover already ticked: NOT clicked (a click would untick it)", async () => {
  const driver = page({ checked: true });
  await run(driver, UI_PA).go();
  assert.equal(driver.state.clicks, 0);
});

test("a relation United India does not offer: stops, NOT retried, listing what it offers", async () => {
  const driver = page();
  await assert.rejects(run(driver, { ...UI_PA, nomineeRelation: "LEGAL HEIR" }).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /Nominee Relation does not offer "LEGAL HEIR", it offers Aunty, Brother, .*Grand-Son, Grand-daughter, Spouse, Other/);
    return true;
  });
});

test("the policy is checked BEFORE the page: a year that is not 1 or 5, no nominee name, no relation - nothing clicked", async () => {
  const driver = page();
  await assert.rejects(run(driver, { ...UI_PA, paCoverYears: 3, nomineeName: " . ", nomineeRelation: "" }).go(), (e) => {
    assert.equal(e.retryable, false);
    assert.match(e.message, /the PA year on the policy is "3" \(United India takes 1 or 5\), and the policy has no Nominee Name, and the policy has no Nominee Relation/);
    return true;
  });
  assert.equal(driver.state.clicks, 0);
});

test("a later box that puts CPA Cover back is caught by the last read-back: [E306]", async () => {
  const driver = page({ relationResetsYear: true });
  await assert.rejects(run(driver, UI_PA).go(), (e) => e.code === "E306" && /after the PA Cover was filled CPA Cover reads "1" instead of "5"/.test(e.message));
});

test("no PA on the policy: ticked and unticked (the Owner-Driver CPA question shows), then 'No'", async () => {
  const driver = page();
  const { lines, go } = run(driver, { paCover: false, settings: { PACompany: "" } });
  assert.deepEqual(await go(), { pa: false, ownerDriverCpa: "No" });
  assert.equal(driver.state.clicks, 2);
  assert.equal(driver.state.checked, false);
  assert.equal(shows(driver, "ynOwnerDrivCpaOpt"), "No");
  assert.ok(lines.some((l) => /no PA with United India \(the policy has no PA Cover\)/.test(l)));
});

test("Brisk's PA: the same - United India's PA Cover is NOT bought, Owner-Driver CPA 'No'", async () => {
  const driver = page();
  const { lines, go } = run(driver, { paCover: false, settings: { PACompany: "Brisk" }, nomineeName: "X", nomineeRelation: "Son" });
  const out = await go();
  assert.equal(out.pa, false);
  assert.equal(driver.state.checked, false);
  assert.equal(driver.state.nominee, "", "Brisk's nominee is not typed at United India");
  assert.ok(lines.some((l) => /the PA is Brisk's certificate/.test(l)));
});

test("no PA, the box ticked to start with: unticked once, then 'No'", async () => {
  const driver = page({ checked: true });
  await run(driver, { paCover: false }).go();
  assert.equal(driver.state.clicks, 1);
  assert.equal(shows(driver, "ynOwnerDrivCpaOpt"), "No");
});

test("the Owner-Driver CPA question never shows: [E301] naming it", async () => {
  const driver = page({ questionNeverShows: true });
  await assert.rejects(run(driver, { paCover: false }).go(), (e) => e.code === "E301" && /"Owner-Driver CPA" is not on the page \(not visible after 10 seconds\)/.test(e.message));
});

test("no PA Cover box: [E301] naming it; a disabled one with PA bought here stops", async () => {
  await assert.rejects(run(page({ noBox: true }), UI_PA).go(), (e) => e.code === "E301" && /"PA Cover" is not on the page/.test(e.message));
  await assert.rejects(run(page({ disabled: true }), UI_PA).go(), (e) => e.retryable === false && /"PA Cover" box is disabled/.test(e.message));
});

test("the owner's markup", () => {
  assert.equal(pa.PA_BOX.target[0], "#ynPAcover");
  assert.equal(pa.CPA_COVER.target[0], "select[name='cpaCover']");
  assert.equal(pa.NOMINEE_NAME.target[0], "#nomineeName");
  assert.equal(pa.RELATION.selectId, "rltnshpstat");
  assert.equal(pa.OWNER_DRIVER_CPA.target[0], "select[name='ynOwnerDrivCpaOpt']");
  assert.equal(pa.OWNER_DRIVER_CPA.answer, "No");
});

test("a proposal opened again: PA Cover ticked ALREADY but CPA Cover / nominee hidden (the owner's live run) - unticked and ticked again, then filled", async () => {
  const driver = page({ checked: true, hiddenUntilClicked: true });
  const lines = [];
  const out = await pa.fillPaCover(driver, { ...UI_PA }, { ...clock(), log: (l) => lines.push(String(l)) });
  assert.equal(out.pa, true);
  assert.equal(driver.state.clicks, 2, "unticked, ticked again");
  assert.equal(driver.state.checked, true);
  assert.equal(driver.state.nominee, pa.nomineeNameOf(UI_PA));
  assert.ok(lines.some((l) => /↻ United India - PA Cover is ticked but CPA Cover and the nominee boxes are not shown \(a proposal opened again\) - unticking and ticking it again so they show/.test(l)));
});

test("ticked already WITH its boxes shown: not clicked at all (no needless untick)", async () => {
  const driver = page({ checked: true });
  const out = await pa.fillPaCover(driver, { ...UI_PA }, { ...clock(), log: () => {} });
  assert.equal(out.pa, true);
  assert.equal(driver.state.clicks, 0);
});
