// United India after the login (2026-11-06): every click and field is checked and tried once more (unitedIndiaSteps.js),
// and the sidebar's Policy Transaction > Make New/Renew Policy (unitedIndiaMenu.js). A fake page, a fake clock; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaSteps.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { clickAndConfirm, fillAndConfirm, TRIES } = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");
const menu = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaMenu");
const { AutomationStoppedError } = require("../automationStopper");

/** A fake clock: sleep moves time on, nothing really waits. */
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms), advance: (ms) => (t += ms) };
};

/** A fake page made of named elements; a selector (css text or By) maps to one of them. */
function fakePage(defs) {
  const state = { clicks: {}, values: {}, url: "https://www.uiic.in/GCWebPortal/login/LoginAction.do", product: false, ready: "complete" };
  const elements = {};
  for (const [name, d] of Object.entries(defs.elements)) {
    elements[name] = {
      name,
      async isDisplayed() {
        return d.shown ? d.shown(state) : true;
      },
      async click() {
        state.clicks[name] = (state.clicks[name] || 0) + 1;
        if (d.onClick) d.onClick(state, state.clicks[name]);
      },
      async clear() {
        state.values[name] = "";
      },
      async sendKeys(v) {
        state.values[name] = d.typeFilter ? d.typeFilter(state, v) : (state.values[name] || "") + v;
      },
      async getAttribute(a) {
        return a === "value" ? state.values[name] || "" : null;
      },
    };
  }
  const nameOf = (locator) => {
    const text = typeof locator === "string" ? locator : locator && locator.value;
    return defs.match(String(text || ""));
  };
  const driver = {
    state,
    async findElements(locator) {
      const n = nameOf(locator);
      return n && elements[n] ? [elements[n]] : [];
    },
    async executeScript(script, ...args) {
      const s = String(script);
      if (s.includes("scrollIntoView")) return null;
      if (s.includes("getElementById('selectProduct')")) return { url: state.url, ready: state.ready, product: state.product };
      if (s.trim() === "return document.readyState") return state.ready;
      if (s.includes("sr-only")) return false; // the loader is not busy
      if (s.includes("arguments[0].click()")) return args[0].click();
      if (s.includes("HTMLInputElement.prototype")) {
        state.values[args[0].name] = defs.elements[args[0].name].typeFilter ? defs.elements[args[0].name].typeFilter(state, args[1]) : args[1];
        return null;
      }
      return null;
    },
    async getCurrentUrl() {
      return state.url;
    },
    async sleep() {},
  };
  return driver;
}

const logs = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(String(l)) };
};

/* --------------------------------------------- clickAndConfirm --------------------------------------------- */

function button({ takesOn = 1, shown = () => true } = {}) {
  return fakePage({
    elements: { btn: { shown, onClick: (s, n) => (s.done = n >= takesOn) } },
    match: (t) => (t === "#btn" ? "btn" : null),
  });
}
const step = (driver, extra = {}) => ({
  label: "The Button",
  target: ["#btn"],
  done: async () => driver.state.done === true,
  effect: "the panel is open",
  missing: "the panel did not open",
  findMs: 2000,
  effectMs: 1000,
  ...extra,
});

test("a click that takes is clicked once", async () => {
  const driver = button();
  const c = clock();
  const { lines, log } = logs();
  assert.deepEqual(await clickAndConfirm(driver, step(driver), { ...c, log }), { clicks: 1 });
  assert.equal(driver.state.clicks.btn, 1);
  assert.ok(lines.some((l) => /✓ United India - "The Button" clicked - the panel is open$/.test(l)));
});

test("a click that did not take is clicked ONE more time (the owner's rule), and says so", async () => {
  const driver = button({ takesOn: 2 });
  const { lines, log } = logs();
  assert.deepEqual(await clickAndConfirm(driver, step(driver), { ...clock(), log }), { clicks: 2 });
  assert.ok(lines.some((l) => /↻ United India - "The Button" was clicked but the panel did not open - clicking it once more/.test(l)));
  assert.ok(lines.some((l) => /\(try 2\)/.test(l)));
});

test(`never taking: clicked ${TRIES} times, then a plain [E301] sentence naming it (no colon)`, async () => {
  const driver = button({ takesOn: 99 });
  await assert.rejects(clickAndConfirm(driver, step(driver), { ...clock(), log() {} }), (e) => {
    assert.equal(e.code, "E301");
    assert.equal(e.message, '[E301] United India - "The Button" was clicked 2 times but the panel did not open, so the run stopped there. It will try again shortly.');
    assert.doesNotMatch(e.message, /:/);
    return true;
  });
  assert.equal(driver.state.clicks.btn, TRIES);
});

test("an element that is not visible stops the run at once with its name - nothing is clicked", async () => {
  const driver = button({ shown: () => false });
  await assert.rejects(clickAndConfirm(driver, step(driver, { findMs: 3000 }), { ...clock(), log() {} }), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /^\[E301\] United India - "The Button" is not on the page \(not visible after 3 seconds\), so the run stopped there\./);
    return true;
  });
  assert.equal(driver.state.clicks.btn, undefined);
});

test("already done: NOT clicked (a collapse menu clicked again would close)", async () => {
  const driver = button();
  driver.state.done = true;
  const { lines, log } = logs();
  assert.deepEqual(await clickAndConfirm(driver, step(driver), { ...clock(), log }), { clicks: 0 });
  assert.equal(driver.state.clicks.btn, undefined);
  assert.ok(lines.some((l) => /"The Button" not clicked - the panel is open already/.test(l)));
});

test("a stop (Hold / Breaker) is never swallowed by the checks", async () => {
  const driver = button();
  const stop = new AutomationStoppedError("held", { stage: "operator-hold" });
  await assert.rejects(
    clickAndConfirm(driver, step(driver, { done: async () => { throw stop; } }), { ...clock(), log() {} }),
    (e) => e === stop
  );
});

/* --------------------------------------------- fillAndConfirm --------------------------------------------- */

function field({ typeFilter } = {}) {
  return fakePage({ elements: { box: { typeFilter } }, match: (t) => (t === "#box" ? "box" : null) });
}

test("a field that reads back its value is typed once", async () => {
  const driver = field();
  const { lines, log } = logs();
  assert.deepEqual(await fillAndConfirm(driver, { label: "Chassis Number", target: ["#box"], value: "MD626DG56S2H08322" }, { ...clock(), log }), { tries: 1 });
  assert.equal(driver.state.values.box, "MD626DG56S2H08322");
  assert.ok(lines.some((l) => /✓ United India - Chassis Number = "MD626DG56S2H08322"/.test(l)));
});

test("a field the page dropped once is typed ONE more time", async () => {
  let n = 0;
  const driver = field({ typeFilter: (s, v) => (++n <= 2 ? "" : v) }); // the first try (keys + script) is dropped
  const { lines, log } = logs();
  assert.deepEqual(await fillAndConfirm(driver, { label: "Engine Number", target: ["#box"], value: "FG5HS2808545" }, { ...clock(), log }), { tries: 2 });
  assert.ok(lines.some((l) => /↻ United India - Engine Number reads "" instead of "FG5HS2808545" - typing it once more/.test(l)));
});

test("a field that never holds the value stops with [E306] naming it and both values", async () => {
  const driver = field({ typeFilter: () => "X" });
  await assert.rejects(fillAndConfirm(driver, { label: "Mobile", target: ["#box"], value: "9876543210" }, { ...clock(), log() {} }), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.message, '[E306] United India - Mobile holds "X" instead of "9876543210" after 2 tries, so the run stopped there. It will try again shortly.');
    return true;
  });
});

test("a field that is not visible stops at once with [E301] naming it", async () => {
  const driver = fakePage({ elements: { box: { shown: () => false } }, match: (t) => (t === "#box" ? "box" : null) });
  await assert.rejects(fillAndConfirm(driver, { label: "PIN Code", target: ["#box"], value: "600001", findMs: 2000 }, { ...clock(), log() {} }), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /"PIN Code" is not on the page \(not visible after 2 seconds\)/);
    return true;
  });
});

/* --------------------------------------------- the menu --------------------------------------------- */

/**
 * The dashboard: the Policy Transaction toggle opens the submenu (after `menuTakesOn` clicks); Make New/Renew Policy opens
 * its page (after `pageTakesOn` clicks).
 */
function dashboard({ menuOpen = false, menuTakesOn = 1, pageTakesOn = 1, noMenu = false, noSubmenu = false, productOnly = false } = {}) {
  return fakePage({
    elements: {
      menu: {
        shown: () => !noMenu,
        onClick: (s, n) => {
          if (n >= menuTakesOn) s.menuOpen = !s.menuOpen; // a collapse TOGGLE
        },
      },
      makeNew: {
        shown: (s) => !noSubmenu && s.menuOpen === true,
        onClick: (s, n) => {
          if (n >= pageTakesOn) {
            if (productOnly) s.product = true;
            else s.url = "https://www.uiic.in/GCWebPortal/portal/MenuAction.do?method=strbtn";
            s.menuOpen = false;
          }
        },
      },
    },
    match: (t) => {
      if (t.includes("menuColor") && (t.includes("#3") || t.includes("Policy Transaction"))) return "menu";
      if (t.includes("strbtn") || t.includes("Make New/Renew Policy")) return "makeNew";
      return null;
    },
  });
}
const withState = (driver, extra) => Object.assign(driver.state, extra) && driver;

test("the menu: Policy Transaction opens the submenu, Make New/Renew Policy opens its page - one click each", async () => {
  const driver = dashboard();
  const { lines, log } = logs();
  const out = await menu.openMakeNewRenewPolicy(driver, { ...clock(), log });
  assert.equal(driver.state.clicks.menu, 1);
  assert.equal(driver.state.clicks.makeNew, 1);
  assert.match(out.url, /MenuAction\.do\?method=strbtn/);
  assert.ok(lines.some((l) => /✓ United India - "Policy Transaction" clicked - its submenu \(Make New\/Renew Policy\) is open/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - "Make New\/Renew Policy" clicked - the Make New\/Renew Policy page is open/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - the Make New\/Renew Policy page is open \(https:\/\/www\.uiic\.in\/GCWebPortal\/portal\/MenuAction\.do\?method=strbtn\)/.test(l)));
});

test("the menu already open is NOT clicked (it would close); the submenu is clicked", async () => {
  const driver = withState(dashboard(), { menuOpen: true });
  await menu.openMakeNewRenewPolicy(driver, { ...clock(), log() {} });
  assert.equal(driver.state.clicks.menu, undefined);
  assert.equal(driver.state.clicks.makeNew, 1);
});

test("a menu click the page ignored is clicked once more; a second submenu click opens the page", async () => {
  const driver = dashboard({ menuTakesOn: 2, pageTakesOn: 2 });
  await menu.openMakeNewRenewPolicy(driver, { ...clock(), log() {} });
  assert.equal(driver.state.clicks.menu, 2);
  assert.equal(driver.state.clicks.makeNew, 2);
});

test("the page counts as open by its product selection too (#selectProduct), whatever its address", async () => {
  const driver = dashboard({ productOnly: true });
  await menu.openMakeNewRenewPolicy(driver, { ...clock(), log() {} });
  assert.equal(driver.state.product, true);
});

test("no Policy Transaction menu: [E301] naming it, nothing clicked", async () => {
  const driver = dashboard({ noMenu: true });
  await assert.rejects(menu.openMakeNewRenewPolicy(driver, { ...clock(), log() {} }), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /"Policy Transaction" is not on the page \(not visible after 10 seconds\)/);
    return true;
  });
});

test("the submenu never shows: Policy Transaction clicked twice, then [E301] - the submenu did not open", async () => {
  const driver = dashboard({ noSubmenu: true });
  await assert.rejects(menu.openMakeNewRenewPolicy(driver, { ...clock(), log() {} }), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /"Policy Transaction" was clicked 2 times but its submenu \(Make New\/Renew Policy\) did not open/);
    return true;
  });
});

test("the Make New/Renew Policy page never opens: clicked twice, then [E301]", async () => {
  const driver = dashboard({ pageTakesOn: 99 });
  // after a click that does not take, the submenu stays open in this fake, so the second click can happen
  await assert.rejects(menu.openMakeNewRenewPolicy(driver, { ...clock(), log() {} }), (e) => {
    assert.match(e.message, /"Make New\/Renew Policy" was clicked 2 times but the Make New\/Renew Policy page did not open/);
    return true;
  });
  assert.equal(driver.state.clicks.makeNew, 2);
});

test("the owner's markup is what the locators look for", () => {
  assert.equal(menu.POLICY_TRANSACTION[0], "a.menuColor[data-target='#3']");
  assert.equal(menu.MAKE_NEW_RENEW[0], "a.subMenuColor[href*='MenuAction.do?method=strbtn']");
});
