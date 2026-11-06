// United India's Products page (the owner, 2026-11-06): Office and LOB left as the portal filled them, Select Product
// (#productCode) = "Liability Only Policy", then Submit (#selectProduct). Every choice read back and tried once more, an
// alert() answered in the portal's own words. A fake page shaped like the owner's markup; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaProduct.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const product = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaProduct");
const { readSelectInPage, setSelectByScriptInPage } = require("../lib/realSelect");

// The owner's <select id="productCode"> options, in order.
const OPTIONS = [
  ["3199", "Motor Package Policy"],
  ["319916", "Motor Package Policy Renewal"],
  ["3102", "Liability Only Policy"],
  ["310216", "Liability Only Policy Renewal"],
  ["3162", "Two Wheelers Long Term Liability"],
  ["316216", "Two Wheelers Long Term Liability Renewal"],
  ["3121", "Motor Standalone OD New"],
  ["312116", "Motor Standalone OD Renew"],
  ["310016", "Motor Policy Renewal By Vehicle Registration Number"],
];

function productsPage(over = {}) {
  const state = {
    page: "products",
    options: OPTIONS.map(([value, text]) => ({ value, text, disabled: false })),
    selectedIndex: 0,
    office: "DO VELLORE(280300)",
    lob: "Motor",
    ignoreOptionClicks: 0,
    ignoreScript: false,
    submits: 0,
    submitTakesOn: 1,
    alertOnSubmit: "",
    alert: "",
    alertStays: "", // an alert the browser keeps open (it does not show up through the next command)
    openAlert: "",
    newWindowOnSubmit: false, // Submit opens the next page in a NEW window; this one keeps the Products page
    windows: ["w1"],
    current: "w1",
    pageError: "",
    selectShown: true,
    ...over,
  };
  if (over.options) state.options = over.options;
  const isAlert = () => {
    if (!state.alert) return;
    const e = new Error(`unexpected alert open: {Alert text : ${state.alert}}`);
    e.name = "UnexpectedAlertOpenError";
    state.alert = ""; // chromedriver dismisses it and reports it
    throw e;
  };
  const optionEl = (i) => ({
    async click() {
      if (state.ignoreOptionClicks > 0) {
        state.ignoreOptionClicks -= 1;
        return;
      }
      state.selectedIndex = i;
    },
  });
  const select = {
    async isDisplayed() {
      return state.page === "products" && state.selectShown;
    },
    async click() {},
    async findElements() {
      return state.options.map((_, i) => optionEl(i));
    },
  };
  const submit = {
    async isDisplayed() {
      return state.page === "products";
    },
    async click() {
      state.submits += 1;
      if (state.alertOnSubmit) {
        state.alert = state.alertOnSubmit;
        return;
      }
      if (state.alertStays) {
        state.openAlert = state.alertStays;
        return;
      }
      if (state.newWindowOnSubmit) {
        state.windows.push("w2");
        return;
      }
      if (state.submits >= state.submitTakesOn) state.page = "next";
    },
  };
  const errorBox = {
    async isDisplayed() {
      return !!state.pageError;
    },
    async getText() {
      return state.pageError;
    },
  };
  const driver = {
    state,
    async findElements(locator) {
      const v = String((locator && locator.value) || locator || "");
      if (v.includes("productCode")) return [select];
      if (v.includes("selectProduct") || v.includes("@value='Submit'")) return [submit];
      if (v === ".alert-danger" && state.pageError) return [errorBox];
      return [];
    },
    async executeScript(script, ...args) {
      isAlert();
      if (script === readSelectInPage) {
        return state.page === "products"
          ? { selectedIndex: state.selectedIndex, value: state.options[state.selectedIndex].value, options: state.options }
          : null;
      }
      if (script === setSelectByScriptInPage) {
        if (!state.ignoreScript) state.selectedIndex = state.options.findIndex((o) => o.value === args[1]);
        return true;
      }
      const s = String(script);
      if (s.includes('querySelectorAll("select")')) {
        return [
          { label: "Select Office", text: state.office },
          { label: "Select LOB", text: state.lob },
        ];
      }
      if (s.includes("getElementById('productCode')")) return { ready: "complete", product: state.current === "w2" ? false : state.page === "products" };
      if (s.trim() === "return document.readyState") return "complete";
      if (s.includes("arguments[0].click()")) return args[0].click();
      return null; // scroll, blur, the loader's busy check
    },
    async getAllWindowHandles() {
      return [...state.windows];
    },
    switchTo() {
      return {
        async window(h) {
          state.current = h;
        },
        async alert() {
          const text = state.alert || state.openAlert;
          if (!text) throw new Error("no such alert");
          return { getText: async () => text, accept: async () => ((state.alert = ""), (state.openAlert = "")) };
        },
      };
    },
    async getCurrentUrl() {
      return state.page === "products"
        ? "https://www.uiic.in/GCWebPortal/portal/MenuAction.do?method=strbtn"
        : "https://www.uiic.in/GCWebPortal/portal/ProposalAction.do";
    },
    async sleep() {},
  };
  return driver;
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms) };
};
const run = (driver) => {
  const lines = [];
  return { lines, go: () => product.chooseProduct(driver, { ...clock(), log: (l) => lines.push(String(l)) }) };
};

test("the owner's choice: Liability Only Policy (3102) - never its Renewal - then Submit; Office and LOB only read", async () => {
  const driver = productsPage();
  const { lines, go } = run(driver);
  const out = await go();
  assert.deepEqual(out, { product: "Liability Only Policy", value: "3102", url: "https://www.uiic.in/GCWebPortal/portal/ProposalAction.do" });
  assert.equal(driver.state.submits, 1);
  assert.ok(lines.some((l) => l.includes('Select Office = "DO VELLORE(280300)" (as the portal filled it, not changed)')));
  assert.ok(lines.some((l) => l.includes('Select LOB = "Motor" (as the portal filled it, not changed)')));
  assert.ok(lines.some((l) => /✓ United India - Select Product = "Liability Only Policy"$/.test(l)));
  assert.ok(lines.some((l) => /✓ United India - "Submit" clicked - the next page opened/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - "Liability Only Policy" \(3102\) submitted, the next page is open/.test(l)));
  assert.equal(product.PRODUCT, "Liability Only Policy");
});

test("the exact option is taken even when the Renewal comes first in the list", async () => {
  const driver = productsPage({
    options: [
      { value: "310216", text: "Liability Only Policy Renewal", disabled: false },
      { value: "3199", text: "Motor Package Policy", disabled: false },
      { value: "3102", text: "Liability Only Policy", disabled: false },
    ],
    selectedIndex: 1,
  });
  const out = await run(driver).go();
  assert.equal(out.value, "3102");
});

test("an option click the page ignored: chosen once more (the page's own way), read back, then Submit", async () => {
  const driver = productsPage({ ignoreOptionClicks: 1 });
  const { lines, go } = run(driver);
  await go();
  assert.ok(lines.some((l) => /↻ United India - Select Product shows "Motor Package Policy" instead of "Liability Only Policy" - choosing it once more/.test(l)));
  assert.ok(lines.some((l) => /Select Product = "Liability Only Policy" \(try 2\)/.test(l)));
  assert.equal(driver.state.submits, 1);
});

test("a product that never takes: [E306] with both names, and Submit is NOT pressed", async () => {
  const driver = productsPage({ ignoreOptionClicks: 9, ignoreScript: true });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.match(e.message, /Select Product shows "Motor Package Policy" instead of "Liability Only Policy" after 2 tries/);
    return true;
  });
  assert.equal(driver.state.submits, 0);
});

test("a list without Liability Only Policy: [E306], not retried, naming what the list offers; Submit not pressed", async () => {
  const driver = productsPage({ options: [{ value: "3199", text: "Motor Package Policy", disabled: false }, { value: "3121", text: "Motor Standalone OD New", disabled: false }] });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /Select Product does not offer "Liability Only Policy", it offers Motor Package Policy, Motor Standalone OD New/);
    return true;
  });
  assert.equal(driver.state.submits, 0);
});

test("no Select Product box on the page: [E301] naming it", async () => {
  const driver = productsPage({ selectShown: false });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /"Select Product" is not on the page \(not visible after 10 seconds\)/);
    return true;
  });
});

test("Liability Only Policy already chosen: left as it is, then Submit", async () => {
  const driver = productsPage({ selectedIndex: 2 });
  const { lines, go } = run(driver);
  await go();
  assert.ok(lines.some((l) => /Select Product already shows "Liability Only Policy"/.test(l)));
  assert.equal(driver.state.submits, 1);
});

test("the portal answers Submit with an alert(): its words, [E308], not retried, Submit pressed ONCE", async () => {
  const driver = productsPage({ alertOnSubmit: "Please select the Office" });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E308");
    assert.equal(e.retryable, false);
    assert.match(e.message, /after "Submit" the portal said "Please select the Office"/);
    return true;
  });
  assert.equal(driver.state.submits, 1);
});

test("Submit that never moves on: pressed twice, then [E301] with what the page says", async () => {
  const driver = productsPage({ submitTakesOn: 99, pageError: "Service temporarily unavailable" });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E301");
    assert.match(e.message, /"Submit" was clicked 2 times but the Products page did not move on, so the run stopped there\. The page says "Service temporarily unavailable"\./);
    return true;
  });
  assert.equal(driver.state.submits, 2);
});

test("a Submit the page ignored once is pressed once more", async () => {
  const driver = productsPage({ submitTakesOn: 2 });
  const { lines, go } = run(driver);
  await go();
  assert.equal(driver.state.submits, 2);
  assert.ok(lines.some((l) => /↻ United India - "Submit" was clicked but the Products page did not move on - clicking it once more/.test(l)));
});

test("an empty Office is said in the log (left as it is - the owner: those two are filled by the portal)", async () => {
  const driver = productsPage({ office: "" });
  const { lines, go } = run(driver);
  await go();
  assert.ok(lines.some((l) => /⚠️ United India - Select Office is empty on the Products page \(left as it is\)/.test(l)));
});

test("an alert the browser keeps open after Submit is read, accepted and reported - not clicked again", async () => {
  const driver = productsPage({ alertStays: "Product not allowed for this office" });
  await assert.rejects(run(driver).go(), (e) => {
    assert.equal(e.code, "E308");
    assert.match(e.message, /after "Submit" the portal said "Product not allowed for this office"/);
    return true;
  });
  assert.equal(driver.state.submits, 1);
  assert.equal(driver.state.openAlert, "", "the alert was accepted, so the page can go on");
});

test("Submit that opens the next page in a NEW window: the run follows it there and does NOT press Submit again", async () => {
  const driver = productsPage({ newWindowOnSubmit: true });
  const { lines, go } = run(driver);
  await go();
  assert.equal(driver.state.submits, 1);
  assert.equal(driver.state.current, "w2");
  assert.equal(lines.filter((l) => /the next page opened in a new window/.test(l)).length, 1, "said once");
});
