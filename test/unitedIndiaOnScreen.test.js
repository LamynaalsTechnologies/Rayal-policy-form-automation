// United India: every box the run fills, chooses, clicks, checks or waits for is put in the MIDDLE of the screen first,
// so the run's video shows it (the owner, 2026-11-13: the fields lower on the page were filled off the screen). Fake pages;
// the real centring is checked in Chrome by test/manual/uiicReplica/loginCheck.js (a tall page with smooth scrolling).
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaOnScreen.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");
const { readSelectInPage } = require("../lib/realSelect");
const { AutomationStoppedError } = require("../automationStopper");

/**
 * A page of one element. executeScript(centerInPage) answers `moved` pixels (or throws `centerThrows`); every call and
 * every sleep is recorded in order.
 */
function page({ moved = 300, centerThrows = null, select = null, value = "", done = () => false } = {}) {
  const calls = [];
  const el = {
    async isDisplayed() {
      return true;
    },
    async click() {
      calls.push("click");
    },
    async clear() {
      calls.push("clear");
    },
    async sendKeys(v) {
      calls.push("type");
      value += v;
    },
    async getAttribute(a) {
      return a === "value" ? value : null;
    },
    async findElements() {
      return (select ? select.options : []).map((_, i) => ({
        async click() {
          select.selectedIndex = i;
        },
      }));
    },
  };
  const driver = {
    calls,
    el,
    async findElements() {
      return [el];
    },
    async executeScript(script, ...args) {
      if (script === steps.centerInPage) {
        calls.push("center");
        if (centerThrows) throw centerThrows;
        return { moved, onScreen: true };
      }
      if (script === readSelectInPage) return { selectedIndex: select.selectedIndex, value: select.options[select.selectedIndex].value, options: select.options };
      return null;
    },
    async sleep() {},
  };
  const sleeps = [];
  const o = {
    now: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
    sleep: async (_d, ms) => {
      sleeps.push(ms);
      calls.push(`sleep ${ms}`);
    },
    log: () => {},
  };
  return { driver, o, sleeps, done };
}

const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));

test("a box the screen really moved to gets a 0.2 s pause (the video shows it before it changes); a near one does not", async () => {
  const far = page({ moved: 300 });
  assert.deepEqual(await steps.showOnScreen(far.driver, far.driver.el, far.o), { moved: 300, onScreen: true });
  assert.deepEqual(far.sleeps, [steps.VIDEO_PAUSE_MS]);
  assert.equal(steps.VIDEO_PAUSE_MS, 200);
  const near = page({ moved: 10 });
  await steps.showOnScreen(near.driver, near.driver.el, near.o);
  assert.deepEqual(near.sleeps, [], "already in the middle: no pause");
});

test("a scrolling problem never stops the run; a popup and a Hold / Breaker stop always go on up", async () => {
  const odd = page({ centerThrows: new Error("javascript error: el.getBoundingClientRect is not a function") });
  assert.equal(await steps.showOnScreen(odd.driver, odd.driver.el, odd.o), null);
  const popup = page({ centerThrows: Object.assign(new Error("unexpected alert open: {Alert text : Session expired}"), { name: "UnexpectedAlertOpenError" }) });
  await assert.rejects(steps.showOnScreen(popup.driver, popup.driver.el, popup.o), /Session expired/);
  const held = page({ centerThrows: new AutomationStoppedError("Held by the operator", { stage: "operator-hold" }) });
  await assert.rejects(steps.showOnScreen(held.driver, held.driver.el, held.o), (e) => e.isAutomationStop === true);
});

test("a choice the portal already shows (Client Type Individual) is still shown on the screen while it is checked", async () => {
  const select = { options: opts([["select", "Select"], ["1", "Individual"]]), selectedIndex: 1 };
  const p = page({ select });
  const out = await steps.selectAndConfirm(p.driver, { label: "Client Type", selectId: "clientType", wanted: "Individual" }, p.o);
  assert.equal(out.tries, 0);
  assert.deepEqual(p.driver.calls.slice(0, 1), ["center"]);
});

test("a choice: the box is in the middle BEFORE it is opened", async () => {
  const select = { options: opts([["", "Select"], ["Yes", "Yes"], ["No", "No"]]), selectedIndex: 0 };
  const p = page({ select });
  await steps.selectAndConfirm(p.driver, { label: "High Risk", selectId: "ynHighRisk", wanted: "No" }, p.o);
  const firstClick = p.driver.calls.indexOf("click");
  assert.ok(firstClick > 0 && p.driver.calls.slice(0, firstClick).includes("center"), p.driver.calls.join(" "));
});

test("a box the portal already filled (Year of Manufacture 2026) is shown on the screen while it is read", async () => {
  const p = page({ value: "2026" });
  const out = await steps.fillAndConfirm(p.driver, { label: "Year of Manufacture", target: ["#y"], value: "2026", keepIfSame: true }, p.o);
  assert.equal(out.tries, 0);
  assert.deepEqual(p.driver.calls, ["center", `sleep ${steps.VIDEO_PAUSE_MS}`], "shown, not typed");
});

test("typing: the box is in the middle BEFORE the first key", async () => {
  const p = page();
  await steps.fillAndConfirm(p.driver, { label: "Address", target: ["#a"], value: "272 A" }, p.o);
  assert.deepEqual(p.driver.calls.slice(0, 3), ["center", `sleep ${steps.VIDEO_PAUSE_MS}`, "clear"]);
});

test("a click: the button is in the middle BEFORE it is clicked", async () => {
  const p = page();
  let clicked = false;
  p.driver.el.click = async () => {
    p.driver.calls.push("click");
    clicked = true;
  };
  await steps.clickAndConfirm(
    p.driver,
    { label: "New Vehicle", target: ["#n"], done: async () => clicked, effect: "it is ticked", missing: "it is not ticked", effectMs: 50 },
    p.o
  );
  assert.deepEqual(p.driver.calls.slice(0, 3), ["center", `sleep ${steps.VIDEO_PAUSE_MS}`, "click"]);
});

test("a choice whose box cannot be centred (odd page) is still made", async () => {
  const select = { options: opts([["", "Select"], ["No", "No"]]), selectedIndex: 0 };
  const p = page({ select, centerThrows: new Error("javascript error") });
  const out = await steps.selectAndConfirm(p.driver, { label: "High Risk", selectId: "ynHighRisk", wanted: "No" }, p.o);
  assert.equal(out.value, "No");
});

test("every United India step file centres through showOnScreen - no bare scrollIntoView left", () => {
  const fs = require("fs");
  const dir = require("path").join(__dirname, "..", "multiCompany", "tpCompany", "unitedIndiaTP");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = fs.readFileSync(require("path").join(dir, f), "utf8");
    const bare = (src.match(/scrollIntoView\(\{block: 'center'\}\)/g) || []).length;
    assert.equal(bare, 0, `${f} still scrolls on its own`);
  }
  const pin = fs.readFileSync(require("path").join(dir, "unitedIndiaPinCode.js"), "utf8");
  assert.match(pin, /showOnScreen\(driver, districtBox, o\)/, "the District is on the screen while it is waited for");
});
