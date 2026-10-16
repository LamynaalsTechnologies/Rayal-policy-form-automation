// Run with: npm test   (or: node --require ./test/support/noRealWorld.js --test test/relianceWalletCdt.test.js)
//
// A Reliance WALLET policy no longer just holds on the payment page: relianceWalletCdt.js checks the login has the CDT
// option, chooses it, enters the payable amount and presses Add, then waits. It is a money step, so these tests are about
// what it REFUSES as much as what it does: amounts are whole paise and must read back equal, only this proposal may be
// ticked, Add is pressed once and never before the read-back, and a login without CDT is an error with the other options
// named. The page is a stateful stand-in built from the four elements Karthi pasted; the clock is fake.
// No browser, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Key } = require("selenium-webdriver");

const wallet = require("../fullPolicycompany/relianceWalletCdt");
const hold = require("../fullPolicycompany/relianceWalletHold");
const { findProposalCheckboxInPage } = require("../fullPolicycompany/relianceKycFallback");
const { beautifyError } = require("../lib/errorHandler");
const { AutomationStoppedError, isAutomationStop } = require("../automationStopper");

const OURS = "R14102699710";

/** Run fn with the (chatty) logging switched off. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/* -------------------------------------------------------------------------- */
/* Money — whole paise                                                        */
/* -------------------------------------------------------------------------- */

test("parseRupees: plain amounts in whole paise, any grouping, nothing else", () => {
  const cases = [
    ["1200", 120000],
    ["1,200", 120000],
    ["1,200.00", 120000],
    ["1,234.5", 123450],
    ["1234.50", 123450],
    ["₹ 1,23,456.50", 12345650],
    ["Rs. 1,23,456", 12345600],
    ["INR 99", 9900],
    ["  12 345.67  ", 1234567],
    ["0.05", 5],
    ["0", 0],
  ];
  for (const [text, paise] of cases) assert.equal(wallet.parseRupees(text), paise, JSON.stringify(text));
  for (const text of ["", " ", null, undefined, "abc", "12.345", "1.2.3", "-5", "1200.", ".5", "12e3", "1,2,3x", "NaN", "₹"]) {
    assert.equal(wallet.parseRupees(text), null, JSON.stringify(text));
  }
});

test("formatPaise / plainAmount: always 2 decimals, Indian grouping for the log, digits-and-a-dot for the box", () => {
  assert.equal(wallet.formatPaise(12345650), "1,23,456.50");
  assert.equal(wallet.formatPaise(120000), "1,200.00");
  assert.equal(wallet.formatPaise(5), "0.05");
  assert.equal(wallet.formatPaise(99900), "999.00");
  assert.equal(wallet.formatPaise(100000000), "10,00,000.00");
  assert.equal(wallet.formatPaise(-1), "?");
  assert.equal(wallet.formatPaise(1.5), "?");
  assert.equal(wallet.plainAmount(12345650), "123456.50");
  assert.equal(wallet.plainAmount(5), "0.05");
  assert.equal(wallet.plainAmount(120000), "1200.00");
});

test("the amounts reconcile to the paisa: parse(format(p)) = parse(plain(p)) = p over 2,000 random amounts, and any wrong digit differs", () => {
  let seed = 20261014;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const p = next() % 99999999; // up to ~10 lakh rupees, 2 decimals
    const shown = wallet.formatPaise(p);
    assert.equal(wallet.parseRupees(shown), p, `format ${p} -> ${shown}`);
    assert.equal(wallet.parseRupees(wallet.plainAmount(p)), p, `plain ${p}`);
    // a single wrong paisa, or a digit moved, is NOT the same amount
    assert.notEqual(wallet.parseRupees(wallet.formatPaise(p + 1)), p);
  }
  assert.notEqual(wallet.parseRupees("1,234.50"), wallet.parseRupees("1,234.05"));
  assert.notEqual(wallet.parseRupees("1,234.50"), wallet.parseRupees("1,243.50"));
});

/* -------------------------------------------------------------------------- */
/* A stateful stand-in for the payment panel                                  */
/* -------------------------------------------------------------------------- */

class El {
  constructor(panel, props) {
    Object.assign(this, { panel, id: "", name: "", type: "", value: "", checked: false, disabled: false, shownNow: true, attrs: {} }, props);
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  getBoundingClientRect() {
    return this.shownNow ? { width: 100, height: 20 } : { width: 0, height: 0 };
  }
  get innerText() {
    return this.text || "";
  }
  get textContent() {
    return this.text || "";
  }
  get parentElement() {
    return this.parent || null;
  }
  closest(sel) {
    return sel === "tr" ? this.row || null : null;
  }
  scrollIntoView() {}
  dispatchEvent() {}
  click() {
    this.panel.onClick(this);
  }
}

/** What ChromeDriver throws for the command that arrives while a JavaScript alert is open (the alert is dismissed). */
function alertError(text) {
  const e = new Error(`unexpected alert open: {Alert text : ${text}}\n  (Session info: chrome=150.0.0.0)`);
  e.name = "UnexpectedAlertOpenError";
  return e;
}

/**
 * @param {Object} o
 * @param {Object[]} [o.options]        the payment options (default CDT + Cheque)
 * @param {string}   [o.payable]        what the readonly payable box holds (default "1,234.50")
 * @param {number}   [o.payableAfterMs] the payable box is empty until this fake time
 * @param {boolean}  [o.typingBroken]   sendKeys is refused (element not interactable) — the script fallback must do it
 * @param {boolean}  [o.typingIgnored]  keystrokes go nowhere AND script events are ignored — the read-back must catch it
 * @param {string}   [o.reformatTo]     after typing, the box shows this instead (a page that rewrites the value)
 * @param {string}   [o.dialogAfterType]  a dialog that appears once the amount is typed
 * @param {string}   [o.dialogAfterAdd]
 * @param {string}   [o.popupAfterType]   Reliance's own error popup (a plain div with closePopUp(), not a .ui-dialog) once typed
 * @param {string}   [o.popupAfterAdd]    the same popup, shown `popupDelayMs` of fake time after Add — and Add adds no row
 * @param {number}   [o.popupDelayMs]
 * @param {string[]} [o.ticked]         proposals ticked in Pending Quotes (default only ours)
 * @param {boolean}  [o.noTable]        Pending Quotes' checkboxes are gone from the page
 * @param {boolean}  [o.addHidden]
 * @param {string}   [o.payableChangesTo]  the payable box changes to this once the amount is typed
 * @param {string}   [o.alertOnBlur]    the page raises a native alert from its onchange when the box loses focus: ChromeDriver
 *                                      dismisses it and fails the NEXT command with UnexpectedAlertOpenError
 * @param {string}   [o.alertOnAdd]     the same, raised by the Add click (which still adds the row)
 */
function makePanel(o = {}) {
  const panel = {
    clock: 0,
    clicks: [],
    typed: [],
    keys: [],
    scriptSets: 0,
    addClicks: 0,
    rows: 3,
    dialogs: [],
    popups: [],
    addAt: null,
    log: [],
    alertText: "",
    alertAccepted: 0,
  };
  const make = (props) => new El(panel, props);

  const defaults = [
    { id: "rdbtnPaymentOptionCDT", value: "CDT", label: "CDT" },
    { id: "rdbtnPaymentOptionCheque", value: "Cheque", label: "Cheque / DD" },
  ];
  panel.radios = (o.options || defaults).map((opt) =>
    make({
      id: opt.id,
      name: "objAgentPaymentOption.PaymentType",
      type: "radio",
      value: opt.value,
      shownNow: opt.shown !== false,
      disabled: opt.disabled === true,
      parent: make({ text: opt.label }),
    })
  );

  panel.payableDisplay = make({ id: "txbPayableamountCurrency", value: o.payableAfterMs ? "" : o.payable ?? "1,234.50" });
  panel.payableRaw = make({ id: "txbPayableamount", value: "" });
  panel.cdtDisplay = make({ id: "txtcdtReducedCurrency", value: "", shownNow: false });
  panel.cdtRaw = make({ id: "txtcdtReduced", value: "", shownNow: false });
  panel.add = make({ id: "btnAddRowToGrid", type: "button", value: "Add", shownNow: !o.addHidden });

  // Pending Quotes' proposal boxes
  const rows = ["R14102600001", OURS, "R141026997101"].map((number, i) => {
    const row = make({ text: `${number} Customer ${i} 1,200` });
    return make({
      id: `chkR${i}`,
      type: "checkbox",
      attrs: { onclick: `SelectProposal('${number}')` },
      checked: (o.ticked || [OURS]).includes(number),
      row,
    });
  });
  panel.boxes = o.noTable ? [] : rows;

  const byId = () => ({
    [panel.payableDisplay.id]: panel.payableDisplay,
    [panel.payableRaw.id]: panel.payableRaw,
    [panel.cdtDisplay.id]: panel.cdtDisplay,
    [panel.cdtRaw.id]: panel.cdtRaw,
    [panel.add.id]: panel.add,
    ...Object.fromEntries(panel.radios.map((r) => [r.id, r])),
  });

  panel.onClick = (el) => {
    panel.clicks.push(el.id || "element");
    if (el.type === "radio") {
      for (const r of panel.radios) r.checked = r === el;
      if (el.value === "CDT") {
        panel.cdtDisplay.shownNow = true;
        panel.cdtRaw.shownNow = true;
        if (!panel.payableDisplay.value && !o.payableAfterMs) panel.payableDisplay.value = o.payable ?? "1,234.50";
      }
    } else if (el === panel.add) {
      panel.addClicks++;
      panel.addAt = panel.clock;
      if (!o.popupAfterAdd) panel.rows += 1;
      if (panel.rowTexts) panel.rowTexts.push(`CDT ${panel.cdtDisplay.value} Delete`);
      if (o.dialogAfterAdd) panel.dialogs.push(o.dialogAfterAdd);
    }
  };

  const afterTyping = () => {
    if (o.reformatTo !== undefined) panel.cdtDisplay.value = o.reformatTo;
    if (o.dialogAfterType) panel.dialogs.push(o.dialogAfterType);
    if (o.popupAfterType) panel.popups.push(o.popupAfterType);
    if (o.payableChangesTo !== undefined) panel.payableDisplay.value = o.payableChangesTo;
  };

  const documentStub = () => {
    if (o.payableAfterMs && panel.clock >= o.payableAfterMs && !panel.payableDisplay.value && panel.radios.some((r) => r.checked)) {
      panel.payableDisplay.value = o.payable ?? "1,234.50";
    }
    if (o.popupAfterAdd && panel.addAt !== null && panel.clock - panel.addAt >= (o.popupDelayMs || 0) && !panel.popups.includes(o.popupAfterAdd)) {
      panel.popups.push(o.popupAfterAdd);
    }
    return {
      getElementsByName: (name) => (name === "objAgentPaymentOption.PaymentType" ? panel.radios : []),
      getElementById: (id) => byId()[id] || null,
      querySelector: (sel) => {
        const m = String(sel).match(/label\[for='([^']+)'\]/);
        return m ? null : null;
      },
      querySelectorAll: (sel) => {
        if (sel === ".ui-dialog, .k-window") {
          return panel.dialogs.map((text) => {
            const w = make({ text });
            const btn = make({ text: "Ok", type: "button" });
            w.querySelector = () => null;
            w.querySelectorAll = () => [btn];
            return w;
          });
        }
        if (/closePopUp/.test(String(sel))) {
          // each popup: the close icon div (no words of its own) inside the div that holds the sentence
          return panel.popups.map((text) => make({ parent: make({ text }) }));
        }
        if (sel === "tr") {
          // rows that carry words (the new payment-details row is what the next step reconciles); bare rows otherwise
          if (panel.rowTexts) return panel.rowTexts.map((text) => make({ text }));
          return new Array(panel.rows).fill({});
        }
        if (sel === "input[type='checkbox']") return panel.boxes;
        return [];
      },
      createEvent: () => ({ initEvent() {} }),
    };
  };

  panel.driver = {
    async executeScript(fn, ...args) {
      const saved = { document: globalThis.document, window: globalThis.window };
      globalThis.document = documentStub();
      globalThis.window = {
        location: { href: "https://smartzone.reliancegeneral.co.in/Payment/Payments?pageName=abc" },
        getComputedStyle: (el) => ({ display: el.shownNow === false ? "none" : "block", visibility: "visible" }),
        RemainingCDTBalance: () => panel.log.push("RemainingCDTBalance()"),
      };
      try {
        if (fn === wallet.setAmountInPage && o.typingIgnored) return { touched: [], recalculated: false };
        const result = fn(...args);
        if (fn === wallet.setAmountInPage) {
          panel.scriptSets++;
          // the script wrote .value on the elements it was given (the stub elements are the real ones)
          panel.cdtDisplay.value = args[1];
          panel.cdtRaw.value = args[1];
          afterTyping();
        }
        return result;
      } finally {
        if (saved.document === undefined) delete globalThis.document;
        else globalThis.document = saved.document;
        if (saved.window === undefined) delete globalThis.window;
        else globalThis.window = saved.window;
      }
    },
    async findElement(locator) {
      const id = String(locator && locator.value).match(/id="([^"]+)"/)?.[1];
      const el = byId()[id];
      if (!el) throw new Error(`no such element: ${id}`);
      return {
        async clear() {
          el.value = "";
        },
        async sendKeys(text) {
          if (o.typingBroken) throw new Error("element not interactable");
          if (text === Key.TAB) {
            panel.keys.push("TAB");
            if (el === panel.cdtDisplay && !o.typingIgnored) {
              const n = wallet.parseRupees(el.value);
              if (n !== null) {
                panel.cdtRaw.value = wallet.plainAmount(n);
                el.value = wallet.formatPaise(n); // the widget formats on blur
              }
              afterTyping();
            }
            if (o.alertOnBlur) throw alertError(o.alertOnBlur);
            return;
          }
          panel.typed.push(text);
          if (o.typingIgnored) return;
          // the box's keypress filter: digits and a dot only
          el.value += String(text).replace(/[^0-9.]/g, "");
        },
        async click() {
          el.click();
          if (el === panel.add && o.alertOnAdd) throw alertError(o.alertOnAdd);
        },
      };
    },
    switchTo() {
      return {
        async alert() {
          if (!panel.alertText) throw new Error("no such alert");
          return {
            async getText() {
              return panel.alertText;
            },
            async accept() {
              panel.alertAccepted++;
              panel.alertText = "";
            },
          };
        },
      };
    },
    async sleep(ms) {
      panel.clock += ms;
    },
  };
  panel.opts = {
    now: () => panel.clock,
    sleep: async (ms) => {
      panel.clock += ms;
    },
    proposalNumber: OURS,
    selectionVerified: true,
  };
  return panel;
}

const run = (panel, extra = {}) => quiet(() => wallet.payWithCdt(panel.driver, { ...panel.opts, ...extra }));
const ALLOWED_CLICKS = new Set(["rdbtnPaymentOptionCDT", "btnAddRowToGrid"]);

/* -------------------------------------------------------------------------- */
/* The happy path                                                             */
/* -------------------------------------------------------------------------- */

test("CDT present: chosen, the payable amount typed with real keys, read back equal, Add pressed once", async () => {
  const p = makePanel();
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.paise, 123450);
  assert.equal(r.amount, "1,234.50");
  assert.equal(r.via, "typed");
  assert.deepEqual(p.typed, ["1234.50"], "the plain digits-and-a-dot text, once");
  assert.deepEqual(p.keys, ["TAB"], "blurred so the page's onchange runs");
  assert.equal(p.addClicks, 1, "Add exactly once");
  assert.deepEqual(p.clicks, ["rdbtnPaymentOptionCDT", "btnAddRowToGrid"], "the only things clicked: CDT and Add");
  assert.equal(p.radios.find((x) => x.value === "CDT").checked, true);
  assert.equal(p.radios.find((x) => x.value === "Cheque").checked, false, "no other payment option was touched");
  assert.match(r.message, /The CDT payment of 1,234\.50 for proposal R14102699710 is entered and added to the payment details/);
  assert.match(r.message, /It is not submitted and nothing was paid — waiting for the next step/);
  assert.equal(r.rowsAfter, r.rowsBefore + 1);
});

test("the rows' words right before and right after Add are returned — the row Add put into the payment details is the difference", async () => {
  const p = makePanel();
  p.rowTexts = ["Proposal No Customer Amount", "R14102699710 A CUSTOMER 1,234.50"];
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.rowTextsBefore, ["Proposal No Customer Amount", "R14102699710 A CUSTOMER 1,234.50"], "read right before Add");
  assert.deepEqual(r.rowTextsAfter, [...r.rowTextsBefore, "CDT 1,234.50 Delete"], "read after Add, with the new row");
});

test("a payable amount that appears a while after CDT is chosen is waited for, not guessed", async () => {
  const p = makePanel({ payableAfterMs: 4000, payable: "₹ 2,50,000.00" });
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.paise, 25000000);
  assert.deepEqual(p.typed, ["250000.00"]);
  assert.ok(p.clock >= 4000);
});

test("when real typing is refused, the script sets both boxes — and the read-back still decides", async () => {
  const p = makePanel({ typingBroken: true });
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, "script");
  assert.equal(p.scriptSets, 1);
  assert.ok(p.log.includes("RemainingCDTBalance()"), "the page's own balance recalculation was called");
  assert.equal(p.addClicks, 1);
});

test("the Breaker checkpoint is called right before Add, after the amount was read back", async () => {
  const p = makePanel();
  const calls = [];
  const r = await run(p, {
    checkpoint: (name) => {
      calls.push({ name, typed: [...p.typed], addClicks: p.addClicks, cdt: p.cdtDisplay.value });
    },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [{ name: "wallet-cdt-add", typed: ["1234.50"], addClicks: 0, cdt: "1,234.50" }]);
});

test("a stop raised by the checkpoint travels up untouched and Add is never pressed", async () => {
  const p = makePanel();
  const stop = new AutomationStoppedError("stopped at the checkpoint", { stage: "x" });
  await assert.rejects(
    () =>
      run(p, {
        checkpoint: () => {
          throw stop;
        },
      }),
    (e) => e === stop
  );
  assert.equal(p.addClicks, 0);
});

/* -------------------------------------------------------------------------- */
/* What it refuses                                                            */
/* -------------------------------------------------------------------------- */

test("no CDT option: an error that says so, names the other options, and clicks NOTHING", async () => {
  const p = makePanel({ options: [{ id: "rdbtnPaymentOptionCheque", value: "Cheque", label: "Cheque / DD" }, { id: "rdbtnOnline", value: "Online", label: "Online" }] });
  const r = await run(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_CDT");
  assert.match(r.message, /^This Reliance login does not have the CDT payment option, so the wallet payment for proposal R14102699710 was not made\./);
  assert.match(r.message, /The payment options the page shows are "Cheque \/ DD", "Online"\./);
  assert.match(r.message, /Nothing was entered or paid\./);
  assert.deepEqual(p.clicks, []);
  assert.deepEqual(p.typed, []);
  assert.equal(beautifyError(r.message, "Reliance"), `[Reliance] ${r.message}`, "no colon: survives beautifyError unchopped");
});

test("CDT in the page but hidden / disabled: the same error, with the right reason", async () => {
  const hidden = makePanel({ options: [{ id: "rdbtnPaymentOptionCDT", value: "CDT", label: "CDT", shown: false }] });
  const r1 = await run(hidden);
  assert.equal(r1.code, "NO_CDT");
  assert.match(r1.message, /does not show the CDT payment option/);
  assert.deepEqual(hidden.clicks, []);

  const disabled = makePanel({ options: [{ id: "rdbtnPaymentOptionCDT", value: "CDT", label: "CDT", disabled: true }] });
  const r2 = await run(disabled);
  assert.equal(r2.code, "NO_CDT");
  assert.match(r2.message, /has disabled the CDT payment option/);
});

test("the payment options never appear: an error, not a guess", async () => {
  const p = makePanel({ options: [] });
  const r = await run(p, { panelWaitMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_PANEL");
  assert.match(r.message, /Reliance's payment options did not appear after Pay/);
  assert.deepEqual(p.clicks, []);
});

test("another proposal ticked (or more than one): refused before anything is chosen or typed", async () => {
  for (const ticked of [["R14102600001"], [OURS, "R14102600001"]]) {
    const p = makePanel({ ticked });
    const r = await run(p);
    assert.equal(r.ok, false, JSON.stringify(ticked));
    assert.equal(r.code, "WRONG_PROPOSAL");
    assert.match(r.message, /does not have only proposal R14102699710 ticked/);
    assert.deepEqual(p.clicks, [], "not even CDT was clicked");
    assert.deepEqual(p.typed, []);
  }
});

test("nothing ticked in view: refused when the selection was never verified, accepted when it was checked before Pay (the list may show another page)", async () => {
  const unverified = makePanel({ ticked: [] });
  const r1 = await run(unverified, { selectionVerified: false });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "WRONG_PROPOSAL");
  assert.match(r1.message, /could not be confirmed/);
  assert.deepEqual(unverified.clicks, []);

  // Pending Quotes is paged: after Pay the grid can be showing page 1 while the proposal was ticked on page 2
  const verified = makePanel({ ticked: [] });
  const r2 = await run(verified, { selectionVerified: true });
  assert.equal(r2.ok, true, JSON.stringify(r2));

  // ...but ANOTHER proposal ticked in view is never accepted, verified or not
  const other = makePanel({ ticked: ["R14102600001"] });
  const r3 = await run(other, { selectionVerified: true });
  assert.equal(r3.code, "WRONG_PROPOSAL");
});

test("a proposal whose number only CONTAINS ours is not ours", async () => {
  const p = makePanel({ ticked: ["R141026997101"] }); // R14102699710 + 1 (a longer number that merely contains ours)
  const r = await run(p);
  assert.equal(r.code, "WRONG_PROPOSAL");
  assert.deepEqual(p.clicks, []);
});

test("the table gone from the page: allowed only when the selection was verified before Pay", async () => {
  const unverified = makePanel({ noTable: true });
  const r1 = await run(unverified, { selectionVerified: false });
  assert.equal(r1.code, "WRONG_PROPOSAL");
  assert.match(r1.message, /could not be confirmed/);
  assert.deepEqual(unverified.clicks, []);

  const verified = makePanel({ noTable: true });
  const r2 = await run(verified, { selectionVerified: true });
  assert.equal(r2.ok, true);
});

test("an empty / zero / unreadable payable amount: nothing is typed", async () => {
  for (const payable of ["", "0.00", "n/a", "12.345"]) {
    const p = makePanel({ payable: payable || "", payableAfterMs: payable ? 0 : 1e9 });
    const r = await run(p, { amountWaitMs: 2000 });
    assert.equal(r.ok, false, JSON.stringify(payable));
    assert.equal(r.code, "NO_AMOUNT", JSON.stringify(payable));
    assert.deepEqual(p.typed, [], "nothing typed");
    assert.equal(p.addClicks, 0);
  }
});

test("an absurd payable amount is a misread, not money: refused", async () => {
  const p = makePanel({ payable: "12,00,00,000.00" });
  const r = await run(p);
  assert.equal(r.code, "NO_AMOUNT");
  assert.match(r.message, /above the safety limit of 10,00,000\.00/);
  assert.deepEqual(p.typed, []);
});

test("the box shows a different amount after typing: the script is tried, and if that fails Add is NOT pressed", async () => {
  const p = makePanel({ reformatTo: "1,234.05" });
  const r = await run(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, "AMOUNT_MISMATCH");
  assert.match(r.message, /The CDT amount box reads "1,234\.05" after 1,234\.50 was entered/);
  assert.match(r.message, /Add was not pressed\. Nothing was added to the payment details or paid\./);
  assert.equal(p.addClicks, 0);
  assert.equal(p.scriptSets, 1, "the script fallback was tried before giving up");
});

test("keystrokes and script both ignored by the page: the empty box is caught by the read-back", async () => {
  const p = makePanel({ typingIgnored: true });
  const r = await run(p);
  assert.equal(r.code, "AMOUNT_MISMATCH");
  assert.equal(p.addClicks, 0);
});

test("the payable amount changes while the amount is entered: Add is not pressed", async () => {
  const p = makePanel({ payableChangesTo: "1,300.00" });
  const r = await run(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, "AMOUNT_CHANGED");
  assert.match(r.message, /changed from 1,234\.50 to 1,300\.00/);
  assert.equal(p.addClicks, 0);
});

test("a refusal shown after typing (dialog or native alert): its words, nothing added", async () => {
  const dialog = makePanel({ dialogAfterType: "CDT balance is insufficient for this payment" });
  const r1 = await run(dialog);
  assert.equal(r1.code, "PAGE_REFUSED");
  assert.match(r1.message, /Reliance said "CDT balance is insufficient for this payment" when 1,234\.50 was entered/);
  assert.equal(dialog.addClicks, 0);

  const alertPanel = makePanel();
  alertPanel.alertText = "Amount exceeds the CDT balance";
  const r2 = await run(alertPanel);
  assert.equal(r2.code, "PAGE_REFUSED");
  assert.equal(alertPanel.alertAccepted, 1, "the alert was read and dismissed");
  assert.equal(alertPanel.addClicks, 0);
});

test("an alert raised by the page's own onchange when the amount is entered: its words are read out of ChromeDriver's error, nothing is added", async () => {
  const p = makePanel({ alertOnBlur: "CDT balance is insufficient for this payment" });
  const r = await run(p);
  assert.equal(r.ok, false);
  assert.equal(r.code, "PAGE_REFUSED");
  assert.match(r.message, /Reliance said "CDT balance is insufficient for this payment" when 1,234\.50 was entered/);
  assert.equal(p.addClicks, 0);
  assert.equal(p.scriptSets, 0, "no second way of putting the same amount in after a refusal");

  // an alert that is NOT a refusal does not stop the step; it is just carried in the message
  const calm = makePanel({ alertOnBlur: "Amount noted" });
  const r2 = await run(calm);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.match(r2.message, /When the amount was entered Reliance showed "Amount noted"\./);
  assert.equal(calm.addClicks, 1);
});

test("an alert raised by the Add click: Add is NOT pressed again, and a refusal in it is an error", async () => {
  const refused = makePanel({ alertOnAdd: "Payment amount cannot be more than the CDT balance" });
  const r1 = await run(refused);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "ADD_REFUSED");
  assert.equal(refused.addClicks, 1, "the click that raised the alert is the only one");

  const info = makePanel({ alertOnAdd: "Payment details added successfully" });
  const r2 = await run(info);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(info.addClicks, 1);
  assert.match(r2.message, /Reliance then showed "Payment details added successfully"/);
});

test("alertTextOf / isUnexpectedAlert read ChromeDriver's error, whatever shape it has", () => {
  assert.equal(wallet.isUnexpectedAlert(alertError("x")), true);
  assert.equal(wallet.isUnexpectedAlert(new Error("unexpected alert open: {Alert text : y}")), true);
  assert.equal(wallet.isUnexpectedAlert(new Error("no such element")), false);
  assert.equal(wallet.alertTextOf(alertError("CDT balance is insufficient")), "CDT balance is insufficient");
  const withMethod = Object.assign(new Error("unexpected alert open"), { name: "UnexpectedAlertOpenError", getAlertText: () => "From the method" });
  assert.equal(wallet.alertTextOf(withMethod), "From the method");
  assert.match(wallet.alertTextOf(Object.assign(new Error("unexpected alert open"), { name: "UnexpectedAlertOpenError" })), /could not be read/);
});

test("Add missing or hidden: an error, nothing pressed", async () => {
  const p = makePanel({ addHidden: true });
  const r = await run(p);
  assert.equal(r.code, "ADD_MISSING");
  assert.equal(p.addClicks, 0);
});

test("after Add: a refusal is an error with its words; an informational dialog is reported, not treated as an error", async () => {
  const refused = makePanel({ dialogAfterAdd: "Payment amount cannot be more than the CDT balance" });
  const r1 = await run(refused);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, "ADD_REFUSED");
  assert.match(r1.message, /Nothing was paid\.$/);
  assert.equal(refused.addClicks, 1, "Add was pressed once");

  const info = makePanel({ dialogAfterAdd: "Payment details added. Click Ok to continue" });
  const r2 = await run(info);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.match(r2.message, /Reliance then showed "Payment details added\. Click Ok to continue" with the buttons "Ok"/);
  assert.equal(info.addClicks, 1);
});

test("Add is pressed at most once even when the click has to be done by script", async () => {
  const p = makePanel();
  const realFind = p.driver.findElement.bind(p.driver);
  p.driver.findElement = async (locator) => {
    const el = await realFind(locator);
    if (String(locator.value).includes("btnAddRowToGrid")) {
      return {
        ...el,
        async click() {
          throw new Error("element click intercepted");
        },
      };
    }
    return el;
  };
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(p.addClicks, 1, "the script click ran once because the first click never happened");
});

test("the only clicks ever made are CDT and Add — over every happy variant", async () => {
  for (const o of [{}, { typingBroken: true }, { payableAfterMs: 3000 }, { dialogAfterAdd: "Added" }]) {
    const p = makePanel(o);
    await run(p);
    for (const id of p.clicks) assert.ok(ALLOWED_CLICKS.has(id), `unexpected click on ${id}`);
  }
});

test("an unexpected crash comes back as an error result — it never throws, and never leaves Add half-done", async () => {
  const p = makePanel();
  p.driver.executeScript = async () => {
    throw new Error("chrome not reachable");
  };
  const r = await run(p, { panelWaitMs: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.message, /Reliance's payment options did not appear|could not be made/);
});

/* -------------------------------------------------------------------------- */
/* The form's way in: the run ends in an error or a stop                      */
/* -------------------------------------------------------------------------- */

test("payWithCdtOrStop: a failure becomes a PaymentStepError that the nested catches let through, with its own words", async () => {
  const p = makePanel({ options: [{ id: "rdbtnPaymentOptionCheque", value: "Cheque", label: "Cheque / DD" }] });
  await assert.rejects(
    () => quiet(() => wallet.payWithCdtOrStop({ driver: p.driver, ...p.opts, stop: () => { throw new Error("must not stop"); } })),
    (e) => {
      assert.ok(e instanceof wallet.PaymentStepError);
      assert.equal(e.portalRejected, true, "the nested catches rethrow portalRejected errors");
      assert.equal(e.keepMessage, true, "the failure catch keeps this sentence");
      assert.equal(e.code, "NO_CDT");
      assert.equal(e.stage, "reliance-wallet-no-cdt");
      assert.equal(isAutomationStop(e), false, "an error, not a calm stop");
      return true;
    }
  );
});

test("payWithCdtOrStop: success ends in a stop carrying the stage, the amount and the screenshot", async () => {
  const p = makePanel();
  const stops = [];
  await assert.rejects(
    () =>
      quiet(() =>
        wallet.payWithCdtOrStop({
          driver: p.driver,
          ...p.opts,
          shot: async (label) => ({ url: `https://bucket.test/${label}.png`, key: `screenshots/wallet/${label}.png` }),
          stop: (message, details) => {
            stops.push({ message, details });
            throw new AutomationStoppedError(message, details);
          },
        })
      ),
    (e) => isAutomationStop(e) && e.details.stage === "reliance-wallet-cdt-added"
  );
  assert.equal(stops.length, 1);
  assert.equal(stops[0].details.amountPaise, 123450);
  assert.equal(stops[0].details.screenshotUrl, "https://bucket.test/cdt-added.png");
  assert.equal(stops[0].details.screenshotKey, "screenshots/wallet/cdt-added.png");
  assert.match(stops[0].message, /waiting for the next step/);
  assert.equal(p.addClicks, 1);
});

test("payWithCdtOrStop: a screenshot that fails is not a reason to fail the payment step", async () => {
  const p = makePanel();
  let stopped = false;
  await assert.rejects(
    () =>
      quiet(() =>
        wallet.payWithCdtOrStop({
          driver: p.driver,
          ...p.opts,
          shot: async () => {
            throw new Error("S3 down");
          },
          stop: (message, details) => {
            stopped = true;
            throw new AutomationStoppedError(message, details);
          },
        })
      ),
    isAutomationStop
  );
  assert.equal(stopped, true);
});

/* -------------------------------------------------------------------------- */
/* Choosing the proposal for a wallet policy                                  */
/* -------------------------------------------------------------------------- */

test("waitForProposalCheckbox: the exact proposal, polled; a neighbour's number never matches; nothing listed -> null", async () => {
  let t = 0;
  const opts = { findInPage: findProposalCheckboxInPage, now: () => t, sleep: async (ms) => (t += ms), timeoutMs: 3000 };
  const boxes = (numbers) => ({
    executeScript: async (fn, proposal) => {
      const saved = { document: globalThis.document };
      globalThis.document = {
        querySelectorAll: () => numbers.map((n) => ({ getAttribute: () => `SelectProposal('${n}')`, closest: () => null })),
      };
      try {
        return fn(proposal);
      } finally {
        if (saved.document === undefined) delete globalThis.document;
        else globalThis.document = saved.document;
      }
    },
  });
  const found = await wallet.waitForProposalCheckbox(boxes(["R14102600001", OURS]), OURS, opts);
  assert.ok(found, "found");
  assert.match(found.getAttribute("onclick"), /R14102699710/);

  t = 0;
  assert.equal(await wallet.waitForProposalCheckbox(boxes(["R141026997101", "XR14102699710"]), OURS, opts), null);
  assert.ok(t >= 3000, "it waited the whole time before giving up");
});

test("readSelection: only ours ticked is ok; two, or someone else's, is not", async () => {
  const driverWith = (ticked) => makePanel({ ticked }).driver;
  assert.equal((await wallet.readSelection(driverWith([OURS]), OURS)).onlyOurs, true);
  assert.equal((await wallet.readSelection(driverWith([OURS, "R14102600001"]), OURS)).onlyOurs, false);
  assert.equal((await wallet.readSelection(driverWith(["R14102600001"]), OURS)).onlyOurs, false);
  assert.equal((await wallet.readSelection(driverWith([]), OURS)).onlyOurs, false);
});

/* -------------------------------------------------------------------------- */
/* The switch                                                                 */
/* -------------------------------------------------------------------------- */

test("the CDT switch is ON unless explicitly false / 0 / no / off", () => {
  const withSwitch = (value, fn) => {
    const before = process.env.RELIANCE_WALLET_CDT_ENABLED;
    if (value === undefined) delete process.env.RELIANCE_WALLET_CDT_ENABLED;
    else process.env.RELIANCE_WALLET_CDT_ENABLED = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.RELIANCE_WALLET_CDT_ENABLED;
      else process.env.RELIANCE_WALLET_CDT_ENABLED = before;
    }
  };
  withSwitch(undefined, () => assert.equal(hold.isWalletCdtEnabled(), true));
  for (const on of ["true", "1", "yes", "on", ""]) withSwitch(on, () => assert.equal(hold.isWalletCdtEnabled(), true, on));
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) withSwitch(off, () => assert.equal(hold.isWalletCdtEnabled(), false, off));
});

/* -------------------------------------------------------------------------- */
/* relianceForm.js uses it in the right places                                */
/* -------------------------------------------------------------------------- */

const formSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
const at = (needle, from = 0) => {
  const i = formSrc.indexOf(needle, from);
  assert.ok(i >= 0, `missing in relianceForm.js: ${needle}`);
  return i;
};

test("relianceForm.js: the CDT branch sits after Pay and the link flow, BEFORE the plain hold, behind the switch", () => {
  const pay = at('console.log("✅ Clicked Pay button");');
  const link = at("if (data.Paymentmethod && data.Paymentmethod.toLowerCase() === 'link') {", pay);
  const cdt = at("} else if (isWalletCdtEnabled() && isWalletPayment(data.Paymentmethod)) {", link);
  // the arguments are built once; the switch RELIANCE_WALLET_SUBMIT_ENABLED chooses between "issue the policy" (Submit
  // Details, the number, the PDF — relianceWalletIssue.js) and the wait after Add exactly as before
  const call = at("const walletArgs = {", cdt);
  const submitSwitch = at("if (isWalletSubmitEnabled()) {", call);
  const issue = at("await payWithCdtAndIssue({", submitSwitch);
  const waitAfterAdd = at("await payWithCdtOrStop(walletArgs);", issue);
  const holdBranch = at("} else if (shouldHoldForWallet(data.Paymentmethod)) {", waitAfterAdd);
  const stopHold = at("stopper(WALLET_HOLD_MESSAGE", holdBranch);
  assert.ok(
    pay < link && link < cdt && cdt < call && call < submitSwitch && submitSwitch < issue && issue < waitAfterAdd && waitAfterAdd < holdBranch && holdBranch < stopHold
  );
  const body = formSrc.slice(call, submitSwitch);
  assert.match(body, /selectionVerified: walletSelectionVerified/);
  assert.match(body, /Breaker\.checkpoint\(`Reliance\/\$\{name\}`\)/);
  assert.match(body, /stop: \(message, details\) => stopper\(message, details\)/);
  assert.match(body, /`wallet\/\$\{label\}`/, "the screenshot goes under the wallet prefix");
});

test("relianceForm.js: a wallet policy finds its proposal by the exact number only — the first-checkbox fallback stays for the link path", () => {
  const strict = at("const walletStrict = isWalletCdtEnabled() && isWalletPayment(data.Paymentmethod);");
  const exact = at("await waitForProposalCheckbox(driver, proposalNumber, { findInPage: findProposalCheckboxInPage })", strict);
  const missing = at('code: "PROPOSAL_NOT_LISTED"', exact);
  const loose = at("if (proposalNumber && !proposalCheckbox) {", missing);
  const fallback = at("if (!proposalCheckbox && !walletStrict) {", loose);
  const click = at('console.log("✅ Clicked proposal checkbox");', fallback);
  const verified = at("walletSelectionVerified = true;", click);
  const wrong = at('code: "WRONG_PROPOSAL"', click);
  assert.ok(strict < exact && exact < missing && missing < loose && loose < fallback && fallback < click && click < wrong && wrong < verified);
  // the selection is checked before Pay is ever clicked
  assert.ok(verified < at('console.log("Looking for Pay button...");', click));
});

test("relianceForm.js: the four nested catches around Pay let a payment-step failure through, and the failure catch keeps its sentence", () => {
  for (const v of ["payBtnErr", "tpErr", "proposalErr", "paymentMenuErr"]) {
    assert.ok(formSrc.includes(`if (isAutomationStop(${v}) || ${v}.portalRejected) throw ${v};`), v);
  }
  assert.ok(formSrc.includes("if (errorInfo.onPageError && !err.keepMessage) {"));
  assert.ok(formSrc.includes("if (e.details && e.details.screenshotUrl) {"), "a stop that took a picture hands it to the error log");
});

/* -------------------------------------------------------------------------- */
/* Reliance's own error popup ("Your CDT Account Does not have sufficient balance ...")                       */
/* -------------------------------------------------------------------------- */

const NO_BALANCE = "Your CDT Account Does not have sufficient balance to make payment";

test("the CDT-balance sentence counts as a refusal (it has no 'insufficient' in it)", () => {
  assert.equal(wallet.REFUSAL_WORDS.test(NO_BALANCE), true);
  assert.equal(wallet.REFUSAL_WORDS.test("Your CDT Account does not have enough balance"), true);
  assert.equal(wallet.REFUSAL_WORDS.test("Payment details added. Click Ok to continue"), false);
});

test("Add pressed and Reliance's popup says the CDT balance is too low: an error with its words, the balance advice, nothing paid", async () => {
  const p = makePanel({ popupAfterAdd: NO_BALANCE, popupDelayMs: 0 });
  const r = await run(p);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "ADD_REFUSED");
  assert.equal(r.portalText, NO_BALANCE);
  assert.match(r.message, /Reliance said "Your CDT Account Does not have sufficient balance to make payment" when Add was pressed/);
  assert.match(r.message, /top it up, then run the policy again/);
  assert.match(r.message, /Nothing was paid\.$/);
  assert.equal(p.addClicks, 1, "Add pressed once");
});

test("the popup that comes a few seconds after the Add click is still caught", async () => {
  const p = makePanel({ popupAfterAdd: NO_BALANCE, popupDelayMs: 3000 });
  const r = await run(p);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "ADD_REFUSED");
  assert.equal(r.portalText, NO_BALANCE);
  assert.equal(p.addClicks, 1);
});

test("the popup shown when the amount is typed stops the step before Add is pressed", async () => {
  const p = makePanel({ popupAfterType: NO_BALANCE });
  const r = await run(p);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "PAGE_REFUSED");
  assert.match(r.message, /when 1,234\.50 was entered in the CDT box/);
  assert.match(r.message, /top it up/);
  assert.equal(p.addClicks, 0);
});

test("a popup that was already on the page before typing is not blamed on this payment", async () => {
  const p = makePanel();
  p.popups.push(NO_BALANCE); // left over from earlier on the page
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(p.addClicks, 1);
});

test("typing refused as 'not interactable' is tried once more after the box was scrolled to, then the script way", async () => {
  const p = makePanel({ typingBroken: true });
  const r = await run(p);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.via, "script");
});

test("the failure becomes a PaymentStepError that carries the page's words (the form's catch then takes the screenshot)", async () => {
  const p = makePanel({ popupAfterAdd: NO_BALANCE, popupDelayMs: 0 });
  const err = await quiet(() =>
    wallet.payWithCdtOrStop({ driver: p.driver, ...p.opts, stop: () => { throw new Error("must not stop"); } })
  ).then(() => null, (e) => e);
  assert.ok(err instanceof wallet.PaymentStepError);
  assert.equal(err.portalRejected, true);
  assert.equal(err.keepMessage, true);
  assert.match(err.message, /does not have sufficient balance/i);
});
