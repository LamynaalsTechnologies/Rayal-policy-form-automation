// Run with: node --require ./test/support/noRealWorld.js --test test/nationalLoginForm.test.js
//
// National's login form (the owner, 2026-11-14): "User Type" -> INTERMEDIARY, then the "Intermediary Type" list that appears ->
// BROKER POSP, then Login ID and Password. The old walk found BOTH lists with one locator (the first mat-select), so the second
// pick re-opened the User Type list, the miss was only logged and the login failed later without a reason. Now each list is found
// by its OWN label, picked from its OWN panel and read back; a miss is a named error. No browser, no network: a fake page.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { By, Key } = require("selenium-webdriver");

const form = require("../fullPolicycompany/national/nationalLoginForm");

const ROOT = path.join(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const codeOf = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

// ---- a fake National login page -------------------------------------------------------------------------------------------

const USER_OPTIONS = ["CUSTOMER", "INTERMEDIARY", "BD OFFICIALS"];
const INTER_OPTIONS = ["AGENT", "BANCASSURANCE", "BROKER", "BROKER MISP", "BROKER POSP", "BROKER SUB USER", "WEB AGGREGATOR"];

function fakePage({
  byLabel = true, // false = the label strategies find nothing (only the place among the page's lists works)
  interAppearsAfterPolls = 0, // the second list is drawn this many polls after the first choice
  interNeverAppears = false,
  userOptions = USER_OPTIONS,
  interOptions = INTER_OPTIONS,
  clicksTake = true, // false = a click on an option does not change the value
  startUser = "",
  startInter = "",
  boxAfterLists = false, // the Login ID box is drawn only once both lists are chosen
  nothingShows = false, // the portal shows no form at all
  staleClicks = 0, // the first N clicks on the User Type select hit an element the portal has already redrawn
  resetUserAfterInter = 0, // the portal clears the User Type this many times when the second list is chosen
} = {}) {
  const state = { user: startUser, inter: startInter, open: null, chosenAt: null, polls: 0, clicks: [], log: [], staleClicks, lastClickStale: false, resetsLeft: resetUserAfterInter };
  const stale = () => Object.assign(new Error("stale element reference: stale element not found in the current frame"), { name: "StaleElementReferenceError" });
  const interVisible = () => {
    if (interNeverAppears) return false;
    if (state.user !== "INTERMEDIARY") return false;
    return state.polls - state.chosenAt >= interAppearsAfterPolls;
  };
  const valueEl = (get) => ({ async getText() { return get(); } });
  const mkSelect = (key) => ({
    key,
    async isDisplayed() { return key === "user" ? true : interVisible(); },
    async click() {
      if (key === "user" && state.staleClicks > 0) { state.staleClicks -= 1; state.lastClickStale = true; throw stale(); }
      state.open = key; state.clicks.push(`open:${key}`);
    },
    async getAttribute(name) { return name === "aria-controls" && state.open === key ? `panel-${key}` : null; },
    async findElements() { return [valueEl(() => (key === "user" ? state.user : state.inter))]; },
    async sendKeys(k) { if (k === Key.ESCAPE) state.open = null; },
    async getText() { return ""; },
  });
  const selects = { user: mkSelect("user"), inter: mkSelect("inter") };
  const optionEl = (key, text) => ({
    async isDisplayed() { return state.open === key; },
    async getText() { return text; },
    async click() {
      state.clicks.push(`pick:${key}:${text}`);
      if (!clicksTake) return;
      if (key === "user") {
        state.user = text;
        state.chosenAt = state.polls;
      } else {
        state.inter = text;
        if (state.resetsLeft > 0) { state.resetsLeft -= 1; state.user = ""; }
      }
      state.open = null;
    },
  });
  const loginBox = { async isDisplayed() { return boxAfterLists ? !!state.inter : true; }, async getText() { return ""; } };
  const driver = {
    state,
    async sleep() { state.polls += 1; },
    async executeScript(script) {
      if (state.lastClickStale && String(script).includes(".click()")) { state.lastClickStale = false; throw stale(); }
    },
    async findElements(locator) {
      const v = locator.value;
      if (nothingShows) return [];
      if (v.includes("log_txtfield_iUsername_01")) return [loginBox]; // By.name compiles to a css selector
      if (v.startsWith("mat-select[aria-labelledby~=")) {
        if (!byLabel) return [];
        return [v.includes("userGroupLabel") ? selects.user : selects.inter];
      }
      if (v.includes("@id='userGroupLabel'")) return byLabel ? [selects.user] : [];
      if (v.includes("@id='intermediaryTypeLabel'")) return byLabel ? [selects.inter] : [];
      if (v === "mat-select") return interVisible() ? [selects.user, selects.inter] : [selects.user];
      if (v.includes("mat-option")) {
        if (!state.open) return [];
        const panel = v.match(/\[id='([^']+)'\]/);
        if (panel && panel[1] !== `panel-${state.open}`) return [];
        return (state.open === "user" ? userOptions : interOptions).map((t) => optionEl(state.open, t));
      }
      return [];
    },
  };
  return { driver, state };
}
const lines = () => {
  const out = [];
  return { out, log: (m) => out.push(m) };
};

// ---- the two lists ------------------------------------------------------------------------------------------------------

test("User Type -> INTERMEDIARY from the User Type list, then BROKER POSP from the Intermediary Type list, each read back", async () => {
  const { driver, state } = fakePage();
  const { out, log } = lines();
  await form.selectNationalAccountType(driver, { log });
  assert.equal(state.user, "INTERMEDIARY");
  assert.equal(state.inter, "BROKER POSP");
  assert.deepEqual(state.clicks, ["open:user", "pick:user:INTERMEDIARY", "open:inter", "pick:inter:BROKER POSP"], "the second list is opened as its own list, never the first one again");
  assert.ok(out.some((l) => /User Type set to INTERMEDIARY/.test(l)) && out.some((l) => /Intermediary Type set to BROKER POSP/.test(l)));
});

test("the second list is drawn late: it is waited for, not looked for at once", async () => {
  const { driver, state } = fakePage({ interAppearsAfterPolls: 5 });
  await form.selectNationalAccountType(driver, { log: () => {} });
  assert.equal(state.inter, "BROKER POSP");
});

test("the second list never appears: a named error (no colon), not a silent skip", async () => {
  const { driver } = fakePage({ interNeverAppears: true });
  await assert.rejects(
    form.chooseIn(driver, "userType", "INTERMEDIARY", { log: () => {} }).then(() => form.chooseIn(driver, "intermediaryType", "BROKER POSP", { waitMs: 3000 })),
    (e) => /National login - the "Intermediary Type" list did not appear after choosing the User Type, so BROKER POSP could not be chosen/.test(e.message) && !e.message.includes(":")
  );
});

test("the list does not offer the option: the error names the list and what the portal offered", async () => {
  const { driver, state } = fakePage({ interOptions: ["AGENT", "BROKER", "IMF"] });
  await assert.rejects(form.selectNationalAccountType(driver, { log: () => {} }), (e) => {
    assert.match(e.message, /BROKER POSP was not one of the choices for "Intermediary Type" \(the portal offered AGENT, BROKER, IMF\)/);
    assert.equal(e.message.includes(":"), false);
    return true;
  });
  assert.equal(state.open, null, "the list is closed again (it would cover the next box)");
});

test("a click that does not take is tried once more, then named", async () => {
  const { driver, state } = fakePage({ clicksTake: false });
  await assert.rejects(form.chooseIn(driver, "userType", "INTERMEDIARY", { log: () => {} }), /"User Type" shows nothing instead of INTERMEDIARY after choosing it/);
  assert.equal(state.clicks.filter((c) => c.startsWith("pick:")).length, 2, "one retry, no more");
});

test("a list already holding the right value is not clicked", async () => {
  const { driver, state } = fakePage({ startUser: "INTERMEDIARY", startInter: "BROKER POSP" });
  const { out, log } = lines();
  await form.selectNationalAccountType(driver, { log });
  assert.deepEqual(state.clicks, []);
  assert.ok(out.some((l) => /User Type already INTERMEDIARY/.test(l)));
});

test("labels not found: the lists are found by their place, and the log says so", async () => {
  const { driver, state } = fakePage({ byLabel: false });
  const { out, log } = lines();
  await form.selectNationalAccountType(driver, { log });
  assert.equal(state.user, "INTERMEDIARY");
  assert.equal(state.inter, "BROKER POSP");
  assert.ok(out.some((l) => /"Intermediary Type" list was found by its place \(2 of 2\), not by its label/.test(l)));
});

test("the lists are found by the portal's own labels", () => {
  const css = form.selectLocators("userType")[0];
  assert.equal(css.value, "mat-select[aria-labelledby~='userGroupLabel']");
  assert.equal(form.selectLocators("intermediaryType")[0].value, "mat-select[aria-labelledby~='intermediaryTypeLabel']");
  assert.deepEqual(form.LABEL_IDS, { userType: "userGroupLabel", intermediaryType: "intermediaryTypeLabel" });
});

// ---- Login ID and Password ----------------------------------------------------------------------------------------------

function fakeBox({ maxlength = 26, drop = 0, acceptOnTry = 1 } = {}) {
  const box = { value: "", tries: 0, typed: [] };
  box.isDisplayed = async () => true;
  box.clear = async () => { box.value = ""; };
  box.sendKeys = async (...keys) => {
    const text = keys.filter((k) => typeof k === "string").join("");
    if (/^[-]/.test(text)) { box.value = ""; return; } // select-all + backspace
    box.tries += 1;
    box.typed.push(text);
    const accepted = box.tries >= acceptOnTry ? text.slice(0, maxlength) : text.slice(0, Math.max(0, text.length - drop));
    box.value = accepted;
  };
  box.getAttribute = async (n) => (n === "value" ? box.value : n === "maxlength" ? String(maxlength) : null);
  return box;
}
const boxDriver = (box) => ({ async sleep() {}, async findElements() { return [box]; } });
const LOGIN = By.name("log_txtfield_iUsername_01");

test("a typed box is read back and accepted when it holds exactly the text", async () => {
  const box = fakeBox();
  await form.typeAndVerify(boxDriver(box), LOGIN, "agent.user_1", "Login ID");
  assert.equal(box.value, "agent.user_1");
});

test("a box that loses characters on the first try is retried once", async () => {
  const box = fakeBox({ drop: 2, acceptOnTry: 2 });
  await form.typeAndVerify(boxDriver(box), LOGIN, "agent.user_1", "Login ID");
  assert.equal(box.value, "agent.user_1");
  assert.equal(box.tries, 2);
});

test("a login longer than the portal box keeps: the error names the lengths and the limit, never the text", async () => {
  const secret = "S3cret-Value-That-Is-Far-Too-Long-For-The-Box";
  const box = fakeBox({ maxlength: 26 });
  await assert.rejects(form.typeAndVerify(boxDriver(box), By.name("log_pwd_iPassword_01"), secret, "Password"), (e) => {
    assert.match(e.message, /the Password box holds 26 characters instead of 45 \(the portal box keeps at most 26\)/);
    assert.equal(e.message.includes(secret.slice(0, 8)), false, "the typed text is never in the message");
    assert.equal(e.message.includes(":"), false);
    return true;
  });
});

test("a saved login with no password / login id is named before anything is typed", async () => {
  const box = fakeBox();
  await assert.rejects(form.typeAndVerify(boxDriver(box), LOGIN, "", "Password"), /the saved login has no Password/);
  await assert.rejects(form.typeAndVerify(boxDriver(box), LOGIN, undefined, "Login ID"), /the saved login has no Login ID/);
  assert.equal(box.tries, 0);
});

test("the box is not on the page: named", async () => {
  const driver = { async sleep() {}, async findElements() { return []; } };
  await assert.rejects(form.typeAndVerify(driver, LOGIN, "x", "Login ID", { waitMs: 600 }), /the Login ID box was not on the page/);
});

// ---- the three places that log in ---------------------------------------------------------------------------------------

test("the multi-company strategy: a miss is a retryable E306 with the helper's sentence", async () => {
  const strategy = require("../multiCompany/common/login/nationalLogin");
  const { driver } = fakePage({ interOptions: ["AGENT"] });
  await assert.rejects(strategy.beforeFill(driver, { log: () => {} }), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, true);
    assert.match(e.message, /BROKER POSP was not one of the choices for "Intermediary Type"/);
    return true;
  });
  const ok = fakePage();
  await strategy.beforeFill(ok.driver, { log: () => {} });
  assert.equal(ok.state.inter, "BROKER POSP");
});

for (const [name, file] of [
  ["full flow", ["fullPolicycompany", "national.js"]],
  ["TP flow", ["multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js"]],
  ["multi-company login", ["multiCompany", "common", "login", "nationalLogin.js"]],
]) {
  test(`${name}: uses the shared login form; the old single-locator walk is gone`, () => {
    const src = codeOf(read(...file));
    assert.match(src, /selectNationalAccountType/);
    assert.equal(/reg_dropdown_iType_02|mat-select-4|mat-select\[role='combobox'\]/.test(src), false, "no locator that finds the first list for both");
    assert.equal(/contains\(\., 'INTERMEDIARY'\)|contains\(\., 'BROKER POSP'\)/.test(src), false);
  });
}

for (const [name, file] of [["full flow", ["fullPolicycompany", "national.js"]], ["TP flow", ["multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js"]]]) {
  test(`${name}: the lists come first, then Login ID and Password are typed and read back, then the button`, () => {
    const src = codeOf(read(...file));
    const pick = src.indexOf("await selectNationalAccountType(driver, {");
    const user = src.indexOf('typeAndVerify(driver, usernameField, data.username || CONFIG.USERNAME, "Login ID")');
    const pass = src.indexOf('typeAndVerify(driver, passwordField, data.password || CONFIG.PASSWORD, "Password")');
    const button = src.indexOf("await clickLoginButton(driver, By.name(\"log_btn_login_01\")");
    assert.ok(pick > 0 && user > pick && pass > user && button > pass, `order ${pick} < ${user} < ${pass} < ${button}`);
    assert.match(src, /userType: "INTERMEDIARY",\s*intermediaryType: "BROKER POSP"/);
  });
}

test("the helper never logs or throws a typed value", () => {
  const src = codeOf(read("fullPolicycompany", "national", "nationalLoginForm.js"));
  assert.equal(/\$\{value\}|\$\{text\}|\$\{got\}/.test(src), false);
});

// ---- the page is ready as soon as its first control shows (the owner: "navigation is fast, the filling starts too late") ----

test("the form is ready when the User Type list shows, even though the Login ID box is not drawn yet", async () => {
  const { driver, state } = fakePage({ boxAfterLists: true });
  const { out, log } = lines();
  const seen = await form.waitForNationalLoginForm(driver, { log });
  assert.equal(seen, "the User Type list");
  assert.ok(state.polls <= 1, `answered at once, not after the 30 s the box wait used to cost (polls ${state.polls})`);
  assert.ok(out.some((l) => /National login form ready, the User Type list showed after/.test(l)));
});

test("no form at all: a named error after the wait, not a silent 'continuing'", async () => {
  const { driver } = fakePage({ nothingShows: true });
  await assert.rejects(form.waitForNationalLoginForm(driver, { waitMs: 1500 }), (e) => /National login - the login form did not appear within 2 seconds \(the portal may be slow or down\)/.test(e.message) && !e.message.includes(":"));
});

test("the Login ID box is waited for AFTER the lists, and typed once it shows", async () => {
  const { driver, state } = fakePage({ boxAfterLists: true });
  await form.waitForNationalLoginForm(driver, { log: () => {} });
  await form.selectNationalAccountType(driver, { log: () => {} });
  const { out, log } = lines();
  await form.waitForLoginBox(driver, { log });
  assert.equal(state.inter, "BROKER POSP");
  assert.ok(out.some((l) => /Login ID box showed after/.test(l)));
});

test("a Login ID box that never comes is a named error", async () => {
  const { driver } = fakePage({ boxAfterLists: true, startUser: "INTERMEDIARY" }); // no second choice made -> box stays hidden
  await assert.rejects(form.waitForLoginBox(driver, { waitMs: 900 }), /the Login ID box did not appear after the lists were chosen within 1 seconds/);
});

test("the chosen-list log lines carry the time they took", async () => {
  const { driver } = fakePage();
  const { out, log } = lines();
  await form.selectNationalAccountType(driver, { log });
  const picks = out.filter((l) => /set to|already/.test(l));
  assert.equal(picks.length, 2);
  assert.ok(picks.every((l) => / \(\d+\.\d s\)$/.test(l)), out.join(" | "));
});

for (const [name, file] of [["full flow", ["fullPolicycompany", "national.js"]], ["TP flow", ["multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js"]]]) {
  test(`${name}: does not wait 30 s for the Login ID box before the lists; waits for the form's first control instead`, () => {
    const src = codeOf(read(...file));
    assert.equal(/elementLocated\(By\.name\("log_txtfield_iUsername_01"\)\), 30000\)/.test(src), false);
    const ready = src.indexOf("await waitForNationalLoginForm(driver,");
    const pick = src.indexOf("await selectNationalAccountType(driver, {");
    assert.ok(ready > 0 && pick > ready, `ready ${ready} before pick ${pick}`);
  });
}

test("the multi-company login: page 'ready' = its first control; the Login ID box is waited for after the lists", () => {
  const strategy = require("../multiCompany/common/login/nationalLogin");
  assert.equal(strategy.fields.ready[0].value, "mat-select[aria-labelledby~='userGroupLabel']");
  assert.equal(strategy.fields.ready.length, 3);
  const run = codeOf(read("multiCompany", "common", "login", "runLogin.js"));
  assert.match(run, /waitForVisible\(driver, strategy\.fields\.ready \|\| strategy\.fields\.username, strategy\.pageLoadMs\)/);
  assert.match(codeOf(read("multiCompany", "common", "login", "nationalLogin.js")), /await waitForLoginBox\(driver, \{ log \}\)/);
});

// ---- the portal draws the form again while we hold an element (the owner's live run: "stale element reference") ----------

test("a redrawn User Type list (stale element) is looked up again and the pick goes on", async () => {
  const { driver, state } = fakePage({ staleClicks: 2 });
  const { out, log } = lines();
  await form.selectNationalAccountType(driver, { log });
  assert.equal(state.user, "INTERMEDIARY");
  assert.equal(state.inter, "BROKER POSP");
  assert.equal(out.filter((l) => /the page redrew the "User Type" list, looking for it again/.test(l)).length, 2);
});

test("a page that keeps redrawing is a named error, not a raw stale-element message", async () => {
  const { driver } = fakePage({ staleClicks: 99 });
  await assert.rejects(form.selectNationalAccountType(driver, { log: () => {} }), (e) => {
    assert.match(e.message, /National login - the page kept redrawing the "User Type" list, so it could not be used/);
    assert.equal(/stale element/i.test(e.message), false);
    return true;
  });
});

test("a list that lost its value when the other was chosen is chosen again; both are read back at the end", async () => {
  const { driver, state } = fakePage({ resetUserAfterInter: 1 });
  const { out, log } = lines();
  await form.selectNationalAccountType(driver, { log });
  assert.equal(state.user, "INTERMEDIARY");
  assert.equal(state.inter, "BROKER POSP");
  assert.ok(out.some((l) => /a list lost its value after the other was chosen, choosing again/.test(l)));
  assert.ok(out.some((l) => /Both lists hold INTERMEDIARY and BROKER POSP/.test(l)));
});

test("the Intermediary Type list is also found by its own name (reg_dropdown_iType_02, from the portal's HTML)", () => {
  assert.ok(form.selectLocators("intermediaryType").some((l) => l.value === "mat-select[name='reg_dropdown_iType_02']"));
  assert.equal(form.selectLocators("userType").some((l) => /reg_dropdown/.test(l.value)), false, "the User Type's own name is not known: label only");
});

test("a typed box that goes stale is looked up again and typed once more; the text is never in a message", async () => {
  const real = fakeBox();
  let handed = 0;
  const stale = () => Object.assign(new Error("stale element reference"), { name: "StaleElementReferenceError" });
  const dying = { isDisplayed: async () => true, clear: async () => { throw stale(); }, sendKeys: async () => { throw stale(); }, getAttribute: async () => { throw stale(); } };
  const driver = { async sleep() {}, async findElements() { handed += 1; return [handed === 1 ? dying : real]; } };
  const { out, log } = lines();
  await form.typeAndVerify(driver, LOGIN, "agent.user_1", "Login ID", { log });
  assert.equal(real.value, "agent.user_1");
  assert.ok(out.some((l) => /the page redrew the Login ID box, looking for it again/.test(l)));
});

// ---- the Login button ---------------------------------------------------------------------------------------------------

function fakeButton({ staleOnce = false, enabledAfter = 0, clickFails = false } = {}) {
  const b = { clicks: 0, scriptClicks: 0, polls: 0, staleLeft: staleOnce ? 1 : 0 };
  b.isDisplayed = async () => true;
  b.isEnabled = async () => { b.polls += 1; return b.polls > enabledAfter; };
  b.click = async () => {
    if (b.staleLeft > 0) { b.staleLeft -= 1; throw Object.assign(new Error("stale element reference"), { name: "StaleElementReferenceError" }); }
    if (clickFails) throw new Error("element click intercepted");
    b.clicks += 1;
  };
  return b;
}
const buttonDriver = (...buttons) => {
  let i = 0;
  return { scripts: 0, async sleep() {}, async findElements() { return [buttons[Math.min(i++, buttons.length - 1)]]; }, async executeScript(s, el) { this.scripts += 1; el.scriptClicks += 1; } };
};

test("the Login button is clicked once it is enabled", async () => {
  const b = fakeButton({ enabledAfter: 3 });
  const { out, log } = lines();
  await form.clickLoginButton(buttonDriver(b), By.name("log_btn_login_01"), { log });
  assert.equal(b.clicks, 1);
  assert.ok(out.some((l) => /Login button clicked$/.test(l)));
});

test("a redrawn Login button is looked up again", async () => {
  const dying = fakeButton({ staleOnce: true });
  const fresh = fakeButton();
  await form.clickLoginButton(buttonDriver(dying, fresh), By.name("log_btn_login_01"), {});
  assert.equal(fresh.clicks, 1);
});

test("a click the page swallows is made by script", async () => {
  const b = fakeButton({ clickFails: true });
  const d = buttonDriver(b);
  const { out, log } = lines();
  await form.clickLoginButton(d, By.name("log_btn_login_01"), { log });
  assert.equal(b.scriptClicks, 1);
  assert.ok(out.some((l) => /script click/.test(l)));
});

test("a Login button that stays disabled is named (the form did not accept the boxes); one that is missing is named", async () => {
  await assert.rejects(form.clickLoginButton(buttonDriver(fakeButton({ enabledAfter: 999 })), By.name("x"), { waitMs: 900 }), /the Login button stayed disabled, so the form did not accept the Login ID or Password/);
  const none = { async sleep() {}, async findElements() { return []; } };
  await assert.rejects(form.clickLoginButton(none, By.name("x"), { waitMs: 600 }), /the Login button was not on the page/);
});
