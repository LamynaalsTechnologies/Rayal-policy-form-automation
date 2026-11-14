// United India Pin Code (the owner, 2026-11-13): typed, the box left (onblur getStateDist()), the portal fills State and
// District; no District after a second try = the pin code is wrong (a stop, not retried). A fake page; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaPinCode.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const pinStep = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaPinCode");
const { readSelectInPage } = require("../lib/realSelect");

const opts = (list) => list.map(([value, text]) => ({ value, text, disabled: false }));
const STATES = [["select", "Select"], ["40", "ANDHRA PRADESH"], ["41", "KARNATAKA"], ["95", "PONDICHERRY U.T."], ["43", "TAMIL NADU"]];
/** What getStateDist() fills for a pin code: [state value, districts, chosen district index]. */
const PORTAL = {
  604203: ["43", [["select", "Select"], ["601", "VILLUPURAM"]], 1],
  600001: ["43", [["select", "Select"], ["602", "CHENNAI"]], 1],
  560001: ["41", [["select", "Select"], ["701", "BANGALORE"]], 1],
  605001: ["95", [["select", "Select"], ["801", "PONDICHERRY"], ["802", "KARAIKAL"], ["803", "MAHE"]], 0], // listed, none chosen
};

/**
 * @param {Object} over
 *   fillAfterReads: the District arrives after this many reads (a slow portal)
 *   fillOnLeave: the District is filled only on this leave of the box (default 1)
 *   alertOnLeave: getStateDist() opens a popup at once
 *   lateAlert: a popup that opens after the box was left and stays open
 *   hide: ["pin" | "district"]
 */
function page(over = {}) {
  const state = {
    pin: "",
    typed: 0,
    leaves: 0,
    reads: 0,
    alerts: [],
    boxes: { STATE_CODE1: { options: opts(STATES), selectedIndex: 0 }, STATE_CODE2: { options: opts([["select", "Select"]]), selectedIndex: 0 } },
    pending: null,
    clears: 0,
  };
  const hidden = (k) => (over.hide || []).includes(k);
  const fill = () => {
    const known = PORTAL[state.pin];
    if (!known) return; // a pin code the portal does not know: nothing filled
    state.boxes.STATE_CODE1.selectedIndex = state.boxes.STATE_CODE1.options.findIndex((o) => o.value === known[0]);
    state.boxes.STATE_CODE2.options = opts(known[1]);
    state.boxes.STATE_CODE2.selectedIndex = known[2];
  };
  const pinEl = {
    async isDisplayed() {
      return !hidden("pin");
    },
    async clear() {
      state.clears += 1; // Selenium's clear() would LEAVE the box (onblur) - never used on the pin code
      state.pin = "";
    },
    async sendKeys(v) {
      state.typed += 1;
      state.pin += v;
    },
    async getAttribute(a) {
      return a === "value" ? state.pin : null;
    },
  };
  const alertError = (text) => Object.assign(new Error(`unexpected alert open: {Alert text : ${text}}`), { name: "UnexpectedAlertOpenError" });
  return {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      return /PIN_CODE|pincodeString/.test(v) ? [pinEl] : [];
    },
    async executeScript(script, ...args) {
      if (script === pinStep.leaveBoxInPage) {
        state.leaves += 1;
        if (over.alertOnLeave) throw alertError(over.alertOnLeave);
        if (over.lateAlert) state.alerts.push(over.lateAlert);
        if (state.leaves >= (over.fillOnLeave || 1)) state.pending = over.fillAfterReads || 0;
        return true;
      }
      if (script === readSelectInPage) {
        if (args[0] === "STATE_CODE2" && hidden("district")) return null;
        if (args[0] === "STATE_CODE2") {
          state.reads += 1;
          if (state.pending !== null) {
            if (state.pending <= 0) {
              fill();
              state.pending = null;
            } else state.pending -= 1;
          }
        }
        const b = state.boxes[args[0]];
        return { selectedIndex: b.selectedIndex, value: b.options[b.selectedIndex].value, options: b.options };
      }
      const s = String(script);
      if (s.includes("HTMLInputElement.prototype")) {
        state.pin = String(args[1]);
        return null;
      }
      if (s === "arguments[0].value = '';") {
        state.pin = "";
        return null;
      }
      if (s.trim() === "return document.readyState") return "complete";
      if (s.includes("sr-only")) return false;
      return null;
    },
    switchTo() {
      return {
        alert: async () => {
          if (!state.alerts.length) throw new Error("no such alert");
          const text = state.alerts.shift();
          return { getText: async () => text, accept: async () => {} };
        },
      };
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
  return { lines, go: () => pinStep.fillPinCode(driver, data, { ...clock(), log: (l) => lines.push(String(l)) }) };
};
const TN = { pinCode: "604203", customerState: "tamilnadu" };

test("the pin code is typed, the box left ONCE, and the State / District the portal fills are read", async () => {
  const driver = page();
  const { lines, go } = run(driver, TN);
  assert.deepEqual(await go(), { pinCode: "604203", state: "TAMIL NADU", district: "VILLUPURAM" });
  assert.equal(driver.state.leaves, 1, "left once - its onblur runs getStateDist()");
  assert.equal(driver.state.clears, 0, "never Selenium's clear() (it would leave the box with it empty)");
  assert.ok(lines.some((l) => /✓ United India - Pin Code = "604203"/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - Pin Code 604203 - State TAMIL NADU, District VILLUPURAM \(filled by the portal\)|✅ United India - Pin Code 604203: State TAMIL NADU, District VILLUPURAM \(filled by the portal\)/.test(l)));
  assert.ok(!lines.some((l) => /⚠️/.test(l)), "same state as the customer's: no warning");
});

test("a slow portal: the District that arrives a few seconds later is waited for", async () => {
  const driver = page({ fillAfterReads: 12 }); // 12 polls of 250 ms = 3 s
  await run(driver, TN).go();
  assert.equal(driver.state.leaves, 1);
  assert.ok(driver.state.reads >= 13);
});

test("filled only after the second time: the pin code is entered and left ONE more time", async () => {
  const driver = page({ fillOnLeave: 2 });
  const { lines, go } = run(driver, TN);
  const out = await go();
  assert.equal(out.district, "VILLUPURAM");
  assert.equal(driver.state.leaves, 2);
  assert.ok(lines.some((l) => /↻ United India - the District was not filled 10 seconds after the Pin Code 604203 - leaving the box once more/.test(l)));
  assert.equal(driver.state.typed, 1, "the box still held the pin code: left again, not typed again");
});

test("a pin code the portal does not know: two tries, then 'the pin code may be wrong' - [E306], NOT retried", async () => {
  const driver = page();
  await assert.rejects(run(driver, { pinCode: "999999", customerState: "tamilnadu" }).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.equal(
      e.message,
      "[E306] United India - the Pin Code 999999 did not fill the District (the District stayed on Select, 2 tries), so the pin code may be wrong and the run stopped there. Check the customer's pin code on the policy, then run it again."
    );
    return true;
  });
  assert.equal(driver.state.leaves, 2);
  assert.equal(driver.state.typed, 1, "the box still held it: only left again");
  assert.equal(driver.state.clears, 0);
});

test("the portal emptied the box after the first try: typed again (quietly emptied first), then left", async () => {
  const driver = page({ fillOnLeave: 2 });
  const realLeave = driver.executeScript.bind(driver);
  driver.executeScript = async (script, ...args) => {
    const out = await realLeave(script, ...args);
    if (script === pinStep.leaveBoxInPage && driver.state.leaves === 1) driver.state.pin = ""; // the portal cleared it
    return out;
  };
  const out = await run(driver, TN).go();
  assert.equal(out.district, "VILLUPURAM");
  assert.equal(driver.state.typed, 2);
  assert.equal(driver.state.clears, 0);
});

test("the portal lists districts but chooses none: said so", async () => {
  const driver = page();
  await assert.rejects(run(driver, { pinCode: "605001", customerState: "pondicherry" }).go(), (e) => {
    assert.equal(e.retryable, false);
    assert.match(e.message, /did not fill the District \(the portal listed 3 districts but chose none, 2 tries\)/);
    return true;
  });
});

test("the portal answers the pin code with a popup: [E308] in its words, not tried again", async () => {
  const driver = page({ alertOnLeave: "Invalid Pincode" });
  await assert.rejects(run(driver, TN).go(), (e) => {
    assert.equal(e.code, "E308");
    assert.equal(e.retryable, false);
    assert.match(e.message, /after "Pin Code" the portal said "Invalid Pincode"/);
    return true;
  });
  assert.equal(driver.state.leaves, 1);
});

test("a popup that opens while the District is waited for: [E308] in its words", async () => {
  const driver = page({ lateAlert: "Pincode not mapped to any district" });
  await assert.rejects(run(driver, TN).go(), (e) => e.code === "E308" && /Pincode not mapped to any district/.test(e.message));
});

test("the policy's pin code is checked before the page: missing or not 6 digits stops, spaces are dropped", async () => {
  const driver = page();
  await assert.rejects(run(driver, {}).go(), (e) => e.retryable === false && /the policy has no pin code/.test(e.message));
  await assert.rejects(run(driver, { pinCode: "6042" }).go(), (e) => e.retryable === false && /pin code "6042" on the policy is not 6 digits/.test(e.message));
  assert.equal(driver.state.typed, 0, "nothing typed");
  assert.deepEqual(pinStep.pinCodeOf({ pinCode: " 604 203 " }), { raw: "604 203", pin: "604203" });
  assert.deepEqual(pinStep.pinCodeOf({ pincode: "600001" }), { raw: "600001", pin: "600001" });
});

test("a pin code in another state than the customer's: a warning in the log, the run goes on", async () => {
  const driver = page();
  const { lines, go } = run(driver, { pinCode: "560001", customerState: "tamilnadu" });
  const out = await go();
  assert.equal(out.state, "KARNATAKA");
  assert.ok(lines.some((l) => /⚠️ United India - the Pin Code 560001 is in KARNATAKA, but the customer's state on the policy is "tamilnadu" \(TAMIL NADU\) - check the pin code/.test(l)));
});

test("no Pin Code box: [E301] naming it", async () => {
  const driver = page({ hide: ["pin"] });
  await assert.rejects(run(driver, TN).go(), (e) => e.code === "E301" && /"Pin Code" is not on the page/.test(e.message));
});

test("no District box: [E301] naming it", async () => {
  const driver = page({ hide: ["district"] });
  await assert.rejects(run(driver, TN).go(), (e) => e.code === "E301" && /the "District" box is not on the Risk Details page/.test(e.message));
});

test("the District is waited for 10 seconds per try (the owner), and a District at 9.5 s still counts", async () => {
  assert.equal(pinStep.FILL_WAIT_MS, 10000);
  const driver = page({ fillAfterReads: 38 }); // 38 polls of 250 ms = 9.5 s
  await run(driver, TN).go();
  assert.equal(driver.state.leaves, 1, "filled within the first 10 seconds - not left again");
});

test("the owner's markup is what it looks for", () => {
  assert.deepEqual(pinStep.PIN, ["#PIN_CODE", "input[name='pincodeString']"]);
  assert.equal(pinStep.STATE_ID, "STATE_CODE1");
  assert.equal(pinStep.DISTRICT_ID, "STATE_CODE2");
});
