// Run with: node --require ./test/support/noRealWorld.js --test test/proposerTitle.test.js
//
// Reliance's proposer form has a Title <select> (Mr. / Ms. / Mrs. / M/S). It was always "Mr." because nothing supplied
// the policy's title; now the operator's choice reaches it. The title is read back after selecting, so an option the
// portal did not take is reported at once instead of surfacing later as a blank required field.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { PROPOSER_TITLES, normalizeProposerTitle, selectProposerTitle, readSelectValueInPage } = require(path.join(ROOT, "lib", "proposerTitle.js"));

test("the four titles are exactly Reliance's, and sloppy spellings are normalised", () => {
  assert.deepEqual(PROPOSER_TITLES, ["Mr.", "Ms.", "Mrs.", "M/S"]);
  assert.equal(normalizeProposerTitle("mrs"), "Mrs.");
  assert.equal(normalizeProposerTitle("M/S"), "M/S");
  assert.equal(normalizeProposerTitle("Dr."), undefined);
  assert.equal(normalizeProposerTitle(undefined), undefined);
});

test("the list is the same one the backend saves (the two copies cannot drift)", () => {
  const backend = path.join(ROOT, "..", "RayalBrokers-backend", "shared", "proposerTitle.js");
  if (!fs.existsSync(backend)) return; // the backend is not checked out next to the automation
  assert.deepEqual(require(backend).PROPOSER_TITLES, PROPOSER_TITLES);
});

/** Run fn with the real-pick switch off: these tests are about the scripted setter (the way back) and the read-back. */
async function scripted(fn) {
  const before = process.env.RELIANCE_REALISTIC_SELECT_ENABLED;
  process.env.RELIANCE_REALISTIC_SELECT_ENABLED = "false";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.RELIANCE_REALISTIC_SELECT_ENABLED;
    else process.env.RELIANCE_REALISTIC_SELECT_ENABLED = before;
  }
}

/** A driver whose Title <select> accepts only Reliance's four options (anything else leaves it blank, as a real one). */
function fakeTitleBox({ offers = PROPOSER_TITLES } = {}) {
  const state = { value: "", set: [] };
  return {
    state,
    select: async (driver, id, value) => {
      state.set.push([id, value]);
      state.value = offers.includes(value) ? value : "";
    },
    driver: {
      async executeScript(fn, id) {
        const saved = globalThis.document;
        globalThis.document = { getElementById: (x) => (x === id ? { value: state.value } : null) };
        try {
          return fn(id);
        } finally {
          if (saved === undefined) delete globalThis.document;
          else globalThis.document = saved;
        }
      },
    },
  };
}

test("switch off - each of the four titles is selected on #proposerTitle1 by the scripted setter and read back", () => scripted(async () => {
  for (const title of PROPOSER_TITLES) {
    const box = fakeTitleBox();
    const lines = [];
    const chosen = await selectProposerTitle(box.driver, title, { select: box.select, log: (l) => lines.push(l) });
    assert.equal(chosen, title);
    assert.deepEqual(box.state.set, [["proposerTitle1", title]]);
    assert.match(lines[0], new RegExp(`Title set to ${title.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  }
}));

test("switch off - a policy with no title (or an unknown one) is filed as Mr. — what was always sent", () => scripted(async () => {
  for (const raw of [undefined, "", "Dr.", null]) {
    const box = fakeTitleBox();
    assert.equal(await selectProposerTitle(box.driver, raw, { select: box.select }), "Mr.");
  }
}));

test("switch off - a title the portal does not take is an error that says so (no colon), nothing is carried on", () => scripted(async () => {
  const box = fakeTitleBox({ offers: ["Mr."] }); // the portal list changed: no "Ms." any more
  await assert.rejects(
    () => selectProposerTitle(box.driver, "Ms.", { select: box.select }),
    (e) => {
      assert.match(e.message, /Reliance did not take the Title "Ms\."/);
      assert.match(e.message, /Nothing was submitted\.$/);
      assert.equal(e.message.includes(":"), false);
      return true;
    }
  );
}));

test("the in-page reader returns the select's value, or null when the box is gone", () => {
  const saved = globalThis.document;
  try {
    globalThis.document = { getElementById: () => ({ value: "Mrs." }) };
    assert.equal(readSelectValueInPage("proposerTitle1"), "Mrs.");
    globalThis.document = { getElementById: () => null };
    assert.equal(readSelectValueInPage("proposerTitle1"), null);
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
});

for (const file of [
  path.join(ROOT, "fullPolicycompany", "relianceForm.js"),
  path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"),
]) {
  test(`${path.basename(file)}: the Title is the policy's own, through selectProposerTitle (the father's title is untouched)`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /await selectProposerTitle\(driver, data\.proposerTitle, \{\s*select: safeSelectDropdown,/);
    assert.doesNotMatch(src, /"proposerTitle1",\s*data\.proposerTitle \|\| "Mr\."/, "the fixed-Mr. call is gone");
    assert.match(src, /"proposerTitle2",\s*data\.fatherTitle \|\| "Mr\."/);
    assert.match(src, /require\("(\.\.\/lib|\.\.\/\.\.\/\.\.\/lib)\/proposerTitle"\)/);
  });
}
