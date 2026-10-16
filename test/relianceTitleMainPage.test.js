// Run with: node --require ./test/support/noRealWorld.js --test test/relianceTitleMainPage.test.js
//
// 2026-10-16: the Reliance Title looked chosen (the Form 60 box held "M/S") but was "not solid": Reliance reads that box when
// it is SUBMITTED and copies the Title into the MAIN page's Salutation list - which, for an Individual customer, has no "M/S".
// Salutation and Gender stayed on "Select" (locked) and "Validate Customer" answered "Please select Salutation. Please select
// Gender." - noticed only later as an empty-message failure. Proved from a live window and two failed runs' screenshots.
// Now (the owner: "whatever is selected in the data must be selected"): the policy's Title is ALWAYS selected in the box - a
// Title the main page lacks only gets a warning line in the log - and after the box is submitted the main page must hold the
// Title and a Gender, else the run stops saying it was RELIANCE that did not accept it. None of these tests needs a browser,
// the network or a database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const title = require(path.join(ROOT, "lib", "proposerTitle.js"));
const core = require(path.join(ROOT, "lib", "jobPartsCore.js"));
const { mapRunResult } = require(path.join(ROOT, "lib", "partRunner.js"));
const { part, NOW } = require("./helpers");

/** The list Reliance's main page really offered for an Individual customer (read from the live window). */
const LIVE_LIST = [
  "Select", "Mr.", "Mrs.", "Ms.", "Dr.", "Miss.", "Prof.", "Brig.", "Capt.", "Cdr.", "Col.", "Fly Offr.", "Gp. Capt.",
  "Justice.", "Lt. Cdr.", "Lt. Col.", "Lt. Gen.", "Maj.", "Maj. Gen.", "Sub Mej.", "Subedar.", "Adv.", "CA.",
];

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

async function withVirtualClock(fn) {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    return await fn({ advance: (ms) => { now += ms; } });
  } finally {
    Date.now = realNow;
  }
}

/** Run fn with globalThis.window / document replaced (the in-page functions read them), restoring after. */
function withPage({ win, doc }, fn) {
  const savedWin = globalThis.window;
  const savedDoc = globalThis.document;
  if (win !== undefined) globalThis.window = win;
  if (doc !== undefined) globalThis.document = doc;
  try {
    return fn();
  } finally {
    if (savedWin === undefined) delete globalThis.window;
    else globalThis.window = savedWin;
    if (savedDoc === undefined) delete globalThis.document;
    else globalThis.document = savedDoc;
  }
}

/* ----------------------------- the in-page readers ----------------------------- */

/** A jQuery stand-in whose .data("kendoDropDownList") / .data("kendoWindow") answer from `widgets`. */
const fakeJq = (widgets) => (el) => ({ data: (name) => (widgets[el && el.id] ? widgets[el.id][name] : undefined) });
const kendoList = (values, extra = {}) => ({ dataSource: { data: () => values.map((v) => ({ Value: v })) }, ...extra });

test("the main page's Salutation list is read from the Form 60 box's PARENT window (the way Reliance's own script does)", () => {
  const parentDoc = { getElementById: (id) => (id === "ddlSalutation" ? { id } : null) };
  const win = { parent: { jQuery: fakeJq({ ddlSalutation: { kendoDropDownList: kendoList(LIVE_LIST) } }), document: parentDoc } };
  assert.deepEqual(withPage({ win }, () => title.readMainSalutationListInPage()), LIVE_LIST);
  // lower-case fields are read too
  const win2 = { parent: { jQuery: fakeJq({ ddlSalutation: { kendoDropDownList: { dataSource: { data: () => [{ value: "Mr." }, { value: "Ms." }] } } } }), document: parentDoc } };
  assert.deepEqual(withPage({ win: win2 }, () => title.readMainSalutationListInPage()), ["Mr.", "Ms."]);
});

test("the list reader answers null - never throws - when it cannot read it", () => {
  assert.equal(withPage({ win: {} }, () => title.readMainSalutationListInPage()), null, "no parent");
  assert.equal(withPage({ win: { parent: { jQuery: fakeJq({}), document: { getElementById: () => ({ id: "ddlSalutation" }) } } } }, () => title.readMainSalutationListInPage()), null, "no Kendo widget");
  assert.equal(withPage({ win: { parent: { get jQuery() { throw new Error("cross-origin"); } } } }, () => title.readMainSalutationListInPage()), null, "blocked");
  assert.equal(title.readMainSalutationListInPage(), null, "no window at all");
});

test("the main-page reader returns Salutation, Gender and whether the Form 60 box is still open", () => {
  const box = (value, disabled) => ({ kendoDropDownList: { value: () => value, element: { prop: () => disabled } } });
  const make = (open) => ({
    jQuery: fakeJq({
      ddlSalutation: { ...box("Mrs.", true), kendoDropDownList: { ...box("Mrs.", true).kendoDropDownList, ...kendoList(["Select", "Mr.", "Mrs."]) } },
      ddlGender: box("Female", false),
      ClientForm60DetailsWindow: { kendoWindow: { element: { is: () => !open } } },
    }),
  });
  const doc = { getElementById: (id) => ({ id }) };
  assert.deepEqual(withPage({ win: make(false), doc }, () => title.readMainTitleInPage()), {
    salutation: { value: "Mrs.", enabled: false },
    gender: { value: "Female", enabled: true },
    modalOpen: false,
    offered: ["Select", "Mr.", "Mrs."],
  });
  assert.equal(withPage({ win: make(true), doc }, () => title.readMainTitleInPage()).modalOpen, true);
});

test("the main-page reader falls back to the plain <select> value, and reports a missing box as null", () => {
  const doc = { getElementById: (id) => (id === "ddlSalutation" ? { id, value: "Mr.", disabled: false } : null) };
  const out = withPage({ win: { jQuery: fakeJq({}) }, doc }, () => title.readMainTitleInPage());
  assert.deepEqual(out.salutation, { value: "Mr.", enabled: true });
  assert.equal(out.gender, null);
  assert.equal(out.offered, null, "no Kendo list - nothing claimed");
});

/* ----------------------------- a Title the main page does not list ----------------------------- */

test("mainListLacks: the live list has no M/S - and says which of our titles it does have", () => {
  assert.deepEqual(title.mainListLacks("M/S", LIVE_LIST), { usable: ["Mr.", "Ms.", "Mrs."] });
  for (const t of ["Mr.", "Ms.", "Mrs."]) assert.equal(title.mainListLacks(t, LIVE_LIST), null, t);
  assert.deepEqual(title.mainListLacks("Ms.", ["Select", "Mr.", "Dr.", "Prof."]), { usable: ["Mr."] });
});

test("mainListLacks: an unreadable, empty or unloaded list is never taken as 'lacks' (no guessing)", () => {
  for (const list of [null, undefined, "Mr.", [], ["Select"], ["Select", "Mr.", "Mrs."]]) {
    assert.equal(title.mainListLacks("M/S", list), null, JSON.stringify(list));
  }
});

test("mainPageTitleNote: the log line says the Title is selected ANYWAY, and what Reliance may answer", () => {
  const line = title.mainPageTitleNote("M/S", LIVE_LIST);
  assert.match(line, /^⚠️ Reliance's main page lists no "M\/S" for an Individual customer \(that title is for companies\) - selecting "M\/S" anyway, as the policy says\./);
  assert.match(line, /Reliance may refuse it after the Form 60 box \("Please select Salutation"\); Mr\., Ms\. or Mrs\. would be accepted\.$/);
  assert.equal(title.mainPageTitleNote("Mrs.", LIVE_LIST), null);
  assert.equal(title.mainPageTitleNote("M/S", null), null);
});

/** A modal iframe whose box is not touched unless the test says so; executeScript answers the list read. */
function modalPage({ list = LIVE_LIST, selected = "" } = {}) {
  const events = [];
  let value = selected;
  const driver = {
    events,
    async sleep() {},
    async findElements() { return []; },
    async executeScript(fn, ...args) {
      if (fn === title.readMainSalutationListInPage) { events.push("read:main-list"); if (list === "throws") throw new Error("target closed"); return list; }
      if (fn === title.readSelectValueInPage) return value;
      events.push("touched");
      return undefined;
    },
  };
  return { driver, events, set: (v) => { value = v; } };
}

test("selectProposerTitle: M/S - the policy's Title - is SELECTED, never refused; the log only warns", async () => {
  const page = modalPage();
  const lines = [];
  const picked = [];
  const chosen = await title.selectProposerTitle(page.driver, "M/S", {
    log: (l) => lines.push(l),
    picker: async (driver, id, wanted) => { picked.push([id, wanted]); page.set(wanted); return { how: "list" }; },
  });
  assert.equal(chosen, "M/S");
  assert.deepEqual(picked, [["proposerTitle1", "M/S"]], "exactly the policy's Title was picked");
  assert.ok(lines.some((l) => /selecting "M\/S" anyway, as the policy says/.test(l)), lines.join(" | "));
  assert.ok(lines.includes("✅ Title set to M/S (picked from the open list)"));
});

test("selectProposerTitle: Mr., Ms. and Mrs. go on to be picked (the main list has them)", async () => {
  for (const t of ["Mr.", "Ms.", "Mrs."]) {
    const page = modalPage();
    const lines = [];
    const chosen = await title.selectProposerTitle(page.driver, t, { log: (l) => lines.push(l), picker: async () => { page.set(t); return { how: "list" }; } });
    assert.equal(chosen, t);
    assert.ok(!lines.some((l) => /anyway/.test(l)), "no warning for a title the main page has");
  }
});

test("selectProposerTitle: a main list that cannot be read, or the switch off, changes nothing (M/S is still picked as before)", async () => {
  for (const [label, run] of [
    ["unreadable list", () => modalPage({ list: null })],
    ["list read throws", () => modalPage({ list: "throws" })],
    ["empty list", () => modalPage({ list: [] })],
  ]) {
    const page = run();
    const chosen = await title.selectProposerTitle(page.driver, "M/S", { picker: async () => { page.set("M/S"); return { how: "list" }; } });
    assert.equal(chosen, "M/S", label);
  }
  await withEnv({ RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED: "false" }, async () => {
    const page = modalPage();
    const chosen = await title.selectProposerTitle(page.driver, "M/S", { picker: async () => { page.set("M/S"); return { how: "list" }; } });
    assert.equal(chosen, "M/S");
    assert.ok(!page.events.includes("read:main-list"), "with the switch off the list is not even read");
  });
});

test("selectProposerTitle: only the proposer's own box is checked - the father's title is not (it never reaches the Salutation list)", async () => {
  const page = modalPage();
  const chosen = await title.selectProposerTitle(page.driver, "M/S", {
    selectId: "proposerTitle2",
    label: "Father's title",
    picker: async () => { page.set("M/S"); return { how: "list" }; },
  });
  assert.equal(chosen, "M/S");
  assert.ok(!page.events.includes("read:main-list"));
});

/* ----------------------------- the main page after the box was submitted ----------------------------- */

const state = (sal, gender, extra = {}) => ({
  salutation: sal === null ? null : { value: sal, enabled: false },
  gender: gender === null ? null : { value: gender, enabled: true },
  modalOpen: false,
  offered: null,
  ...extra,
});

/**
 * Feed verifyMainPageTitle a script of looks (the last one repeats) on a virtual clock and let it finish - inside the
 * clock, so its 15 s / 10 s waits cost nothing. Returns { promise, lines }: `promise` is already settled.
 */
async function verify(looks, rawTitle = "Mrs.", extra = {}) {
  const lines = [];
  const settled = await withVirtualClock(async (clock) => {
    let i = 0;
    return title
      .verifyMainPageTitle({}, rawTitle, {
        log: (l) => lines.push(l),
        pause: async (ms) => clock.advance(ms),
        readState: async () => { const s = looks[Math.min(i, looks.length - 1)]; i++; if (s instanceof Error) throw s; return s; },
        ...extra,
      })
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  });
  const promise = settled.ok ? Promise.resolve(settled.value) : Promise.reject(settled.error);
  promise.catch(() => {}); // settled already; the test awaits it
  return { promise, lines };
}

test("verifyMainPageTitle: the main page already holds the Title and the Gender - fine, and the log says so", async () => {
  const { promise, lines } = await verify([state("Mrs.", "Female")]);
  assert.deepEqual(await promise, { checked: true, salutation: "Mrs.", gender: "Female" });
  assert.deepEqual(lines, ["✅ Reliance's main page holds the Title Mrs. and Gender Female"]);
});

test("verifyMainPageTitle: the Title and then the Gender arrive a few seconds later (server round trips) - waited for", async () => {
  const { promise } = await verify([state("Select", "Select"), state("Select", "Select"), state("Mr.", "Select"), state("Mr.", "Select"), state("Mr.", "Male")], "Mr.");
  assert.deepEqual(await promise, { checked: true, salutation: "Mr.", gender: "Male" });
});

test("verifyMainPageTitle: the 2026-10-16 case - Salutation stays on Select - stops with Reliance's state, no colon", async () => {
  const { promise } = await verify([state("Select", "Select")], "M/S");
  await assert.rejects(promise, (e) => {
    assert.match(e.message, /^Reliance's main page still shows the Title "Select" after the Form 60 box was submitted, so "M\/S" was not carried over\. /);
    assert.match(e.message, /nothing was bought\. Check the screenshot, then run the policy again\.$/);
    assert.equal(e.message.includes(":"), false);
    return true;
  });
});

test("verifyMainPageTitle: when the main list has no such title the message says it was RELIANCE that did not accept it", async () => {
  const { promise } = await verify([state("Select", "Select", { offered: LIVE_LIST })], "M/S");
  await assert.rejects(promise, (e) => {
    assert.match(e.message, /^Reliance did not accept the Title "M\/S" - it was selected in the Form 60 box as the policy says, but Reliance's main page has no "M\/S" for an Individual customer \(that title is for companies\)/);
    assert.match(e.message, /Reliance answers "Please select Salutation"\. Change the Title on the policy to Mr\., Ms\. or Mrs\., then run it again\. Nothing was bought\.$/);
    assert.equal(e.message.includes(":"), false);
    assert.ok(e instanceof title.TitleError && e.nonRetryable === true, "not retried");
    return true;
  });
});

test("verifyMainPageTitle: the Form 60 box still open after Submit is named as the reason", async () => {
  const { promise } = await verify([state("Select", "Select", { modalOpen: true })], "Ms.");
  await assert.rejects(promise, (e) => {
    assert.match(e.message, /^Reliance's Form 60 box is still open after Submit, so the Title "Ms\." did not reach the main page\. Check the box's own message in the screenshot/);
    return true;
  });
});

test("verifyMainPageTitle: a different Title on the main page than the policy's is an error", async () => {
  const { promise } = await verify([state("Mr.", "Male")], "Mrs.");
  await assert.rejects(promise, (e) => {
    assert.match(e.message, /^Reliance's main page shows the Title "Mr\." but the policy has "Mrs\."\. /);
    return true;
  });
});

test("verifyMainPageTitle: the Title took but the Gender never did - an error that says so", async () => {
  const { promise } = await verify([state("Ms.", "Select")], "Ms.");
  await assert.rejects(promise, (e) => {
    assert.match(e.message, /^Reliance's main page took the Title "Ms\." but left Gender on "Select"\. /);
    assert.equal(e.message.includes(":"), false);
    return true;
  });
});

test("verifyMainPageTitle: boxes that cannot be read mean 'carry on as before' (with a warning), never a new failure", async () => {
  for (const looks of [[null], [state(null, null)], [new Error("stale element")]]) {
    const { promise, lines } = await verify(looks);
    assert.deepEqual(await promise, { checked: false });
    assert.ok(lines.some((l) => /Could not read Reliance's main-page Title box - carrying on/.test(l)));
  }
});

test("verifyMainPageTitle: a Gender box that cannot be read is logged, not an error", async () => {
  const { promise, lines } = await verify([state("Mrs.", null)]);
  assert.deepEqual(await promise, { checked: true, salutation: "Mrs." });
  assert.ok(lines.some((l) => /holds the Title Mrs\. \(its Gender box could not be read\)/.test(l)));
});

test("verifyMainPageTitle: no title on the policy means Mr., what was always sent", async () => {
  const { promise } = await verify([state("Mr.", "Male")], null);
  assert.equal((await promise).salutation, "Mr.");
});

test("verifyMainPageTitle: it waits no longer than its limits", async () => {
  await withVirtualClock(async (clock) => {
    let looks = 0;
    await assert.rejects(
      title.verifyMainPageTitle({}, "Mrs.", { timeoutMs: 3000, pause: async (ms) => clock.advance(ms), readState: async () => { looks++; return state("Select", "Select"); } }),
      /still shows the Title/
    );
    assert.ok(looks >= 6 && looks <= 8, `about 3 s of looking at 0.5 s (${looks} looks)`);
  });
});

test("verifyMainPageTitle: the switch off does not even look", async () => {
  await withEnv({ RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED: "off" }, async () => {
    let looks = 0;
    const lines = [];
    const out = await title.verifyMainPageTitle({}, "M/S", {
      log: (l) => lines.push(l),
      readState: async () => { looks++; return state("Select", "Select"); },
    });
    assert.deepEqual(out, { checked: false });
    assert.equal(looks, 0, "not one look at the page");
    assert.deepEqual(lines, [], "and nothing logged");
  });
});

test("the switch is ON unless false / 0 / no / off", async () => {
  await withEnv({ RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED: undefined }, async () => assert.equal(title.isMainPageTitleCheckEnabled(), true));
  for (const off of ["false", "0", "No", "OFF"]) {
    await withEnv({ RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED: off }, async () => assert.equal(title.isMainPageTitleCheckEnabled(), false, off));
  }
});

/* ----------------------------- wiring ----------------------------- */

for (const file of [
  path.join(ROOT, "fullPolicycompany", "relianceForm.js"),
  path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"),
]) {
  test(`${path.basename(file)}: the main page is checked right after the Form 60 box is submitted and before Validate Customer`, () => {
    const src = fs.readFileSync(file, "utf8");
    const submit = src.indexOf('await waitForElementAndRetry(driver, By.id("btnSubmit"), "click");');
    const back = src.indexOf("await driver.switchTo().defaultContent();", submit);
    const check = src.indexOf("await verifyMainPageTitle(driver, data.proposerTitle,", back);
    const email = src.indexOf('driver.findElement(By.id("txtEmailID"))', back);
    const validate = src.indexOf('until.elementLocated(By.id("BtnSaveClientDetails"))', back);
    assert.ok(submit > 0 && back > submit && check > back, "submit, back to the main page, then the check");
    assert.ok(check < email && email < validate, "the check comes before the email and before Validate Customer");
    assert.match(src, /const \{ selectProposerTitle, verifyMainPageTitle \} = require\("(\.\.\/lib|\.\.\/\.\.\/\.\.\/lib)\/proposerTitle"\);/);
  });
}

/* ----------------------------- no retry for what a retry cannot fix ----------------------------- */

// 2026-10-16: the refusal fired, the queue logged "retryable -> pending ... due in 60s" and a new Chrome would have opened
// every minute for the same answer. The Reliance form's catch RETURNS a failure (it does not throw), and partRunner reads only
// `retryable: false` from it - a plain Error never carried that.

test("every main-page check failure is a TitleError that says no retry can fix it", async () => {
  for (const [label, looks, wanted] of [
    ["Reliance has no such title", [state("Select", "Select", { offered: LIVE_LIST })], "M/S"],
    ["Title still Select", [state("Select", "Select")], "M/S"],
    ["Form 60 box still open", [state("Select", "Select", { modalOpen: true })], "Ms."],
    ["another Title", [state("Mr.", "Male")], "Mrs."],
    ["Gender not filled", [state("Ms.", "Select")], "Ms."],
  ]) {
    const { promise } = await verify(looks, wanted);
    const e = await promise.catch((err) => err);
    assert.ok(e instanceof title.TitleError, label);
    assert.ok(e instanceof Error, label);
    assert.equal(e.name, "TitleError", label);
    assert.equal(e.nonRetryable, true, label);
  }
});

test("the Form 60 box's own read-back error is NOT flagged - a flaky page may be fixed by another try (as before)", async () => {
  const page = modalPage({ list: LIVE_LIST });
  const e = await title.selectProposerTitle(page.driver, "Mrs.", { picker: async () => ({ how: "list" }) }).catch((err) => err); // the box stays empty
  assert.match(e.message, /^Reliance did not take the Title "Mrs\."/);
  assert.ok(!(e instanceof title.TitleError));
  assert.equal(e.nonRetryable, undefined);
});

/** What the Reliance form's catch returns for a thrown error (the same two lines as in fullPolicycompany/relianceForm.js). */
const failureResultFor = (e) => ({
  success: false,
  error: e.message,
  stage: "login-form",
  postSubmissionFailed: false,
  ...(e && e.nonRetryable === true ? { retryable: false } : {}),
});

test("the whole chain: Reliance not accepting the Title ends the part as failed with no retry timer; without the flag it went back to pending", async () => {
  const { promise } = await verify([state("Select", "Select", { offered: LIVE_LIST })], "M/S");
  const refused = await promise.catch((e) => e);
  const job = { _id: "j1", status: "pending", parts: [part("motor", "bundled", "Reliance")] };
  const run = (result) => {
    const outcome = mapRunResult(result, { part: job.parts[0], companyName: "Reliance" });
    const after = core.applyPartOutcome(job, "motor", outcome, NOW);
    return { outcome, motor: after.parts.find((p) => p.key === "motor") };
  };

  const flagged = run(failureResultFor(refused));
  assert.equal(flagged.outcome.type, "nonRetryable");
  assert.equal(flagged.motor.status, "failed_login_form", "failed - nothing is queued again");
  assert.equal(flagged.motor.nextRetryAt, null, "no retry timer");
  assert.match(flagged.motor.lastError, /Reliance did not accept the Title "M\/S"/);
  assert.equal(flagged.motor.lastError.includes(":"), false, "no colon, so beautifyError keeps the whole sentence");

  // what happened on 2026-10-16: a plain Error carries no flag
  const plain = run(failureResultFor(new Error(refused.message)));
  assert.equal(plain.outcome.type, "retryable");
  assert.equal(plain.motor.status, "pending", "back in the queue");
  assert.ok(plain.motor.nextRetryAt, "with a retry timer - a new window every minute until the attempts run out");
});

for (const file of [
  path.join(ROOT, "fullPolicycompany", "relianceForm.js"),
  path.join(ROOT, "multiCompany", "common", "reliance", "relianceMultiForm.js"),
]) {
  test(`${path.basename(file)}: the form's catch hands retryable:false on for an error that says nonRetryable`, () => {
    const src = fs.readFileSync(file, "utf8");
    const catchAt = src.indexOf('console.error("[relianceForm] Error:", e.message || e);');
    assert.ok(catchAt > 0, "the form's outer catch");
    const flag = src.indexOf("...(e && e.nonRetryable === true ? { retryable: false } : {}),", catchAt);
    const closing = src.indexOf("  } finally {", catchAt);
    assert.ok(flag > catchAt && flag < closing, "inside the failure result that catch returns");
    assert.ok(src.indexOf("postSubmissionFailed: false,", catchAt) < flag, "next to the other flags of that result");
  });
}
