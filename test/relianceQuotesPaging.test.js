// Run with: npm test   (or: node --require ./test/support/noRealWorld.js --test test/relianceQuotesPaging.test.js)
//
// Reliance's Pending Quotes is a Kendo grid, 10 rows to a page. The flow used to read only the page that was open, so a
// proposal on page 2 was "not listed" (2026-10-14, R141026119597: 14 items, "11 - 14 of 14 items") — and the link path
// then ticked the first checkbox of page 1, ANOTHER customer's proposal. relianceQuotesPaging.js looks at every page.
// These tests run its in-page readers and its loop against a stateful stand-in grid built from the pager markup Karthi
// pasted; the clock is fake. No browser, no network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const qp = require("../fullPolicycompany/relianceQuotesPaging");
const fallback = require("../fullPolicycompany/relianceKycFallback");

const OURS = "R141026119597";

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
/* A stateful stand-in for the Kendo grid                                     */
/* -------------------------------------------------------------------------- */

class El {
  constructor(props = {}) {
    Object.assign(this, { id: "", className: "", text: "", attrs: {}, shownNow: true, checked: false, children: [] }, props);
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  getBoundingClientRect() {
    return this.shownNow ? { width: 100, height: 20 } : { width: 0, height: 0 };
  }
  get innerText() {
    return this.text;
  }
  get textContent() {
    return this.text;
  }
  closest(sel) {
    if (sel === ".k-grid") return this.grid || null;
    if (sel === "tr") return this.row || null;
    if (sel === "a") return this.anchor || null;
    return null;
  }
  contains(el) {
    return !!el && (el === this || el.grid === this);
  }
  click() {
    if (this.onClick) this.onClick(this);
  }
}

/**
 * @param {Object} o
 * @param {number}   [o.total]        items in the list (default 14)
 * @param {number}   [o.pageSize]     rows to a page (default 10)
 * @param {number}   [o.page]         the page that is open at the start (default 1)
 * @param {string[]} [o.numbers]      proposal numbers in list order (default: 14 numbers, OURS last)
 * @param {boolean}  [o.noPager]      a list with no pager (10 rows or fewer)
 * @param {number}   [o.loadMs]       how long a page change shows the loading mask (fake ms)
 * @param {boolean}  [o.stuck]        a click on the pager does nothing at all
 * @param {number}   [o.rowsLagMs]    the pager shows the new page this long BEFORE its rows are re-rendered (the old rows are
 *                                    still on screen under the new page number)
 * @param {number}   [o.pagerLagMs]   the rows are re-rendered this long BEFORE the pager shows the new page number
 * @param {boolean}  [o.otherGrid]    a second grid (payment details) with its own pager and no proposal boxes
 */
function makeGrid(o = {}) {
  const total = o.total ?? 14;
  const pageSize = o.pageSize ?? 10;
  const numbers =
    o.numbers ||
    Array.from({ length: total }, (_, i) => (i === total - 1 ? OURS : `R1410260000${String(i).padStart(2, "0")}`));
  const g = { clock: 0, clicks: [], page: o.page ?? 1, numbers, reads: 0, pendingPage: null, rowsReadyAt: 0 };
  g.rowsPage = g.page;
  const pages = Math.max(1, Math.ceil(numbers.length / pageSize));
  g.pages = pages;

  g.grid = new El({ className: "k-grid k-widget" });
  const rowsOf = (page) => numbers.slice((page - 1) * pageSize, page * pageSize);

  const boxFor = (number, index) => {
    const row = new El({ text: `${number} Customer ${index} Two Wheeler 1,200` });
    const box = new El({
      id: `chkR${index}`,
      attrs: { onclick: `SelectProposal('${number}')`, type: "checkbox" },
      grid: g.grid,
      row,
    });
    box.number = number;
    return box;
  };
  let boxesCache = { page: null, boxes: [] };
  const currentBoxes = () => {
    if (boxesCache.page !== g.rowsPage) {
      boxesCache = { page: g.rowsPage, boxes: rowsOf(g.rowsPage).map((n, i) => boxFor(n, (g.rowsPage - 1) * pageSize + i)) };
    }
    return boxesCache.boxes;
  };

  const settle = () => {
    if (g.pendingPage && g.clock >= g.pendingPage.readyAt) {
      g.target = g.pendingPage.page;
      g.targetAt = g.pendingPage.readyAt;
      g.pendingPage = null;
    }
    if (g.target) {
      if (g.clock >= g.targetAt + (o.rowsLagMs ?? 0)) g.rowsPage = g.target;
      if (g.clock >= g.targetAt + (o.pagerLagMs ?? 0)) g.page = g.target;
      if (g.rowsPage === g.target && g.page === g.target) g.target = null;
    }
  };

  const pagerFor = () => {
    const current = g.page;
    const from = (current - 1) * pageSize + 1;
    const to = Math.min(current * pageSize, numbers.length);
    const last = current >= pages;
    const go = (page) => () => {
      g.clicks.push(`page ${page}`);
      if (o.stuck) return;
      g.pendingPage = { page, readyAt: g.clock + (o.loadMs ?? 0) };
    };
    const mkLink = (cls, icon, title, target, disabled) => {
      const a = new El({ className: `k-link${disabled ? " k-state-disabled" : ""}`, attrs: { "data-page": String(target), title } });
      a.onClick = (self) => {
        if (/k-state-disabled/.test(self.className)) return;
        go(target)();
      };
      const span = new El({ className: `k-icon ${icon}`, anchor: a });
      return { a, span };
    };
    const first = mkLink("first", "k-i-seek-w", "Go to the first page", 1, current === 1);
    const prev = mkLink("prev", "k-i-arrow-w", "Go to the previous page", Math.max(1, current - 1), current === 1);
    const next = mkLink("next", "k-i-arrow-e", "Go to the next page", Math.min(pages, current + 1), last);
    const lastL = mkLink("last", "k-i-seek-e", "Go to the last page", pages, last);
    const numberLinks = [];
    for (let n = 1; n <= pages; n++) {
      if (n === current) continue;
      const a = new El({ className: "k-link", attrs: { "data-page": String(n) } });
      a.onClick = go(n);
      numberLinks.push(a);
    }
    const selected = new El({ className: "k-state-selected", text: String(current) });
    const info = new El({ className: "k-pager-info k-label", text: `${from} - ${to} of ${numbers.length} items` });
    const pager = new El({ className: "k-pager-wrap k-grid-pager k-widget" });
    pager.querySelector = (sel) => {
      if (/k-state-selected/.test(sel)) return selected;
      if (/k-pager-info/.test(sel)) return info;
      if (sel === ".k-i-arrow-e") return next.span;
      if (sel === ".k-i-seek-w") return first.span;
      if (sel === ".k-i-arrow-w") return prev.span;
      if (sel === ".k-i-seek-e") return lastL.span;
      return null;
    };
    pager.querySelectorAll = (sel) => {
      if (/a\[data-page\]/.test(sel)) return numberLinks;
      if (sel === "a") return [first.a, prev.a, next.a, lastL.a, ...numberLinks];
      return [];
    };
    return pager;
  };

  g.otherPager = null;
  if (o.otherGrid) {
    g.otherGrid = new El({ className: "k-grid k-widget" });
    g.otherPager = new El({ className: "k-pager-wrap k-grid-pager k-widget" });
    g.otherPager.querySelector = () => null;
    g.otherPager.querySelectorAll = () => [];
  }

  const documentStub = () => {
    settle();
    g.reads += 1;
    const boxes = currentBoxes();
    const pager = o.noPager ? null : pagerFor();
    g.grid.querySelector = (sel) => (/k-pager-wrap|k-grid-pager/.test(sel) ? pager : null);
    return {
      querySelectorAll: (sel) => {
        if (sel === "input[type='checkbox']") return g.pendingPage && (o.loadMs ?? 0) > 0 && false ? [] : boxes;
        if (sel === ".k-loading-mask") {
          return g.pendingPage ? [new El({ className: "k-loading-mask" })] : [];
        }
        if (/k-pager-wrap/.test(sel)) return [g.otherPager, pager].filter(Boolean); // the details grid's pager comes first
        return [];
      },
    };
  };

  g.driver = {
    async executeScript(fn, ...args) {
      const saved = { document: globalThis.document, window: globalThis.window };
      globalThis.document = documentStub();
      globalThis.window = { getComputedStyle: (el) => ({ display: el.shownNow === false ? "none" : "block", visibility: "visible" }) };
      try {
        return fn(...args);
      } finally {
        if (saved.document === undefined) delete globalThis.document;
        else globalThis.document = saved.document;
        if (saved.window === undefined) delete globalThis.window;
        else globalThis.window = saved.window;
      }
    },
    async sleep(ms) {
      g.clock += ms;
    },
  };
  g.opts = {
    now: () => g.clock,
    sleep: async (ms) => {
      g.clock += ms;
    },
  };
  return g;
}

const find = (g, proposal = OURS, extra = {}) => quiet(() => qp.findProposalAcrossPages(g.driver, proposal, { ...g.opts, ...extra }));

/* -------------------------------------------------------------------------- */
/* The in-page readers                                                        */
/* -------------------------------------------------------------------------- */

test("readQuotesGridInPage: page 2 of 2, '11 - 14 of 14 items' — the state of the pager Karthi pasted", async () => {
  const g = makeGrid({ page: 2 });
  const state = await g.driver.executeScript(qp.readQuotesGridInPage);
  assert.equal(state.hasGrid, true);
  assert.equal(state.boxes, 4, "rows 11-14 are the ones on page 2");
  assert.deepEqual(
    { ...state.pager },
    {
      present: true,
      current: 2,
      pages: 2,
      total: 14,
      from: 11,
      to: 14,
      nextEnabled: false,
      firstEnabled: true,
      numbers: [1],
      ambiguous: false,
    }
  );
  assert.equal(state.loading, false);
});

test("readQuotesGridInPage: page 1 of 2 has its next link enabled; a list without a pager is one page", async () => {
  const first = await makeGrid({ page: 1 }).driver.executeScript(qp.readQuotesGridInPage);
  assert.equal(first.pager.current, 1);
  assert.equal(first.pager.pages, 2);
  assert.equal(first.pager.nextEnabled, true);
  assert.equal(first.pager.firstEnabled, false, "already on the first page");
  assert.equal(first.boxes, 10);

  const single = await makeGrid({ total: 6, noPager: true }).driver.executeScript(qp.readQuotesGridInPage);
  assert.equal(single.pager.present, false);
  assert.equal(single.boxes, 6);
});

test("readQuotesGridInPage: the payment-details grid's pager is not the proposals grid's", async () => {
  const g = makeGrid({ otherGrid: true });
  const state = await g.driver.executeScript(qp.readQuotesGridInPage);
  assert.equal(state.pager.present, true);
  assert.equal(state.pager.total, 14, "the pager read is the proposals grid's (inside its .k-grid)");
  assert.equal(state.pager.ambiguous, false);
});

/* -------------------------------------------------------------------------- */
/* The search                                                                 */
/* -------------------------------------------------------------------------- */

test("the proposal is on page 1: found without touching the pager", async () => {
  const g = makeGrid({ numbers: [OURS, ...Array.from({ length: 13 }, (_, i) => `R1410260000${String(i).padStart(2, "0")}`)] });
  const r = await find(g);
  assert.equal(r.found, true);
  assert.equal(r.page, 1);
  assert.deepEqual(g.clicks, []);
  assert.deepEqual(r.scanned, [{ page: 1, rows: 10 }]);
  assert.equal(r.checkbox.number, OURS);
});

test("the proposal is on page 2 (R141026119597, 14 items): the next link is clicked once and the checkbox is on screen", async () => {
  const g = makeGrid({ loadMs: 600 });
  const r = await find(g);
  assert.equal(r.found, true);
  assert.equal(r.page, 2);
  assert.equal(r.pages, 2);
  assert.equal(r.total, 14);
  assert.deepEqual(g.clicks, ["page 2"], "one click, on page 2");
  assert.deepEqual(r.scanned, [{ page: 1, rows: 10 }, { page: 2, rows: 4 }]);
  assert.equal(r.checkbox.number, OURS);
  assert.equal(g.page, 2, "the search stopped on the page the proposal is on");
});

test("the proposal is nowhere: every page was looked at, and the result says how many", async () => {
  const g = makeGrid({ numbers: Array.from({ length: 14 }, (_, i) => `R1410260000${String(i).padStart(2, "0")}`) });
  const r = await find(g);
  assert.equal(r.found, false);
  assert.equal(r.checkbox, null);
  assert.deepEqual(r.scanned, [{ page: 1, rows: 10 }, { page: 2, rows: 4 }]);
  assert.match(r.reason, /is not in the list/);
  assert.equal(qp.describeScan(r), "looked at page 1 (10 rows), page 2 (4 rows), 14 items in the list");
});

test("a list that was left open on page 2: it goes back to page 1 first, then looks forward — a proposal on page 1 is not missed", async () => {
  const numbers = Array.from({ length: 14 }, (_, i) => (i === 3 ? OURS : `R1410260000${String(i).padStart(2, "0")}`));
  const g = makeGrid({ numbers, page: 2 });
  const r = await find(g);
  assert.equal(r.found, true);
  assert.equal(r.page, 1);
  assert.deepEqual(g.clicks, ["page 1"], "the first link, once");
});

test("a longer number that merely contains ours is another proposal — never matched", async () => {
  const numbers = Array.from({ length: 14 }, (_, i) => (i === 12 ? `${OURS}1` : `R1410260000${String(i).padStart(2, "0")}`));
  const g = makeGrid({ numbers });
  const r = await find(g);
  assert.equal(r.found, false);
  assert.equal(r.scanned.length, 2, "both pages were looked at");
});

test("the pager shows the new page before its rows are re-rendered: the old rows are NOT read as the new page", async () => {
  const g = makeGrid({ loadMs: 200, rowsLagMs: 1500 });
  const r = await find(g);
  assert.equal(r.found, true, JSON.stringify(r.scanned));
  assert.equal(r.page, 2);
  assert.deepEqual(r.scanned, [{ page: 1, rows: 10 }, { page: 2, rows: 4 }], "page 2 was read with ITS rows, not page 1's");
  assert.equal(r.checkbox.number, OURS);
});

test("the rows are re-rendered before the pager shows the new number: the page is not taken for the old one", async () => {
  const g = makeGrid({ loadMs: 200, pagerLagMs: 1500 });
  const r = await find(g);
  assert.equal(r.found, true, JSON.stringify(r.scanned));
  assert.equal(r.page, 2);
  assert.deepEqual(r.scanned, [{ page: 1, rows: 10 }, { page: 2, rows: 4 }]);
  assert.deepEqual(g.clicks, ["page 2"], "the next link was clicked once, not again because the pager still said page 1");
});

test("the loading mask is waited out: the rows are read only when the new page is in", async () => {
  const g = makeGrid({ loadMs: 3000 });
  const r = await find(g);
  assert.equal(r.found, true);
  assert.ok(g.clock >= 3000, "it waited for the mask");
  assert.equal(r.checkbox.number, OURS);
});

test("a pager click that changes nothing ends the search with that reason — it does not loop or guess", async () => {
  const g = makeGrid({ stuck: true });
  const r = await find(g, OURS, { pageWaitMs: 4000 });
  assert.equal(r.found, false);
  assert.match(r.reason, /page 2 did not load/);
  assert.equal(r.scanned.length, 1);
});

test("no pager (10 rows or fewer): one page, found", async () => {
  const numbers = [OURS, "R141026000001", "R141026000002"];
  const g = makeGrid({ numbers, noPager: true });
  const r = await find(g);
  assert.equal(r.found, true);
  assert.deepEqual(g.clicks, []);
  assert.equal(r.pages, 1);
});

test("a policy with no proposal number looks at nothing", async () => {
  const g = makeGrid();
  const r = await find(g, "");
  assert.equal(r.found, false);
  assert.match(r.reason, /no proposal number/);
  assert.equal(g.reads, 0);
});

test("a list that never shows rows: 'shows no proposals', after the wait — not an endless loop", async () => {
  const g = makeGrid({ numbers: [], total: 0, noPager: true });
  const r = await find(g, OURS, { gridWaitMs: 2000 });
  assert.equal(r.found, false);
  assert.match(r.reason, /shows no proposals/);
});

test("the page cap stops a runaway pager", async () => {
  const g = makeGrid({ total: 200 });
  const r = await find(g, "R999999999999", { maxPages: 3 });
  assert.equal(r.found, false);
  assert.equal(r.scanned.length, 3);
});

test("the exact-match finder is the one the KYC fallback exports (one definition)", () => {
  assert.equal(fallback.findProposalCheckboxInPage, qp.findProposalCheckboxInPage);
});

/* -------------------------------------------------------------------------- */
/* The switch                                                                 */
/* -------------------------------------------------------------------------- */

test("the paging switch is ON unless explicitly false / 0 / no / off", () => {
  const withSwitch = (value, fn) => {
    const before = process.env.RELIANCE_QUOTES_PAGING_ENABLED;
    if (value === undefined) delete process.env.RELIANCE_QUOTES_PAGING_ENABLED;
    else process.env.RELIANCE_QUOTES_PAGING_ENABLED = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.RELIANCE_QUOTES_PAGING_ENABLED;
      else process.env.RELIANCE_QUOTES_PAGING_ENABLED = before;
    }
  };
  withSwitch(undefined, () => assert.equal(qp.isQuotesPagingEnabled(), true));
  for (const on of ["true", "1", "yes", "on", ""]) withSwitch(on, () => assert.equal(qp.isQuotesPagingEnabled(), true, on));
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) withSwitch(off, () => assert.equal(qp.isQuotesPagingEnabled(), false, off));
});

/* -------------------------------------------------------------------------- */
/* The KYC fallback pages too                                                 */
/* -------------------------------------------------------------------------- */

test("reachPaymentPage (KYC fallback): a proposal on page 2 is found, ticked, and the way to Pay goes on from there", async () => {
  const g = makeGrid();
  const ticked = [];
  const wrapped = {
    ...g.driver,
    async getAllWindowHandles() {
      return ["main"];
    },
    async getCurrentUrl() {
      return "https://smartzone.reliancegeneral.co.in/Payment/Payments?pageName=abc";
    },
    async get() {},
    async executeScript(fn, ...args) {
      if (fn === fallback.readPaymentPageInPage) return { url: "https://smartzone.reliancegeneral.co.in/Payment/Payments?pageName=abc", onPendingQuotes: true, paymentPanel: false, dialog: "" };
      if (fn === fallback.findControlInPage) {
        const id = args[0];
        if (id === "TPDeclaration1" && ticked.length) return { checked: false, id, click() { ticked.push("TPDeclaration1"); } };
        if (id === "Paymentbtn" && ticked.length > 1) return { id, click() { ticked.push("Paymentbtn"); } };
        return null;
      }
      if (typeof fn === "string") return null;
      if (fn.toString().startsWith("function (el")) return null;
      return g.driver.executeScript(fn, ...args);
    },
    switchTo() {
      return { async window() {}, async alert() { throw new Error("no alert"); } };
    },
  };
  // the found checkbox is a stand-in element: record the click, report it checked
  const realExec = wrapped.executeScript;
  wrapped.executeScript = async (fn, ...args) => {
    const out = await realExec(fn, ...args);
    if (fn === qp.findProposalCheckboxInPage && out) {
      out.click = () => ticked.push(`tick ${out.number}`);
      out.checked = true;
    }
    return out;
  };
  const r = await quiet(() =>
    fallback.reachPaymentPage(wrapped, { proposalNumber: OURS, ...g.opts, checkboxWaitMs: 5000, afterPayWaitMs: 1000 })
  );
  assert.equal(r.proposalFound, true, JSON.stringify(r));
  assert.equal(g.page, 2, "it paged to where the proposal is");
  assert.ok(r.steps.some((s) => /is on page 2 of 2/.test(s)), r.steps.join(" | "));
  assert.ok(ticked.includes(`tick ${OURS}`));
});

test("reachPaymentPage: a proposal on no page says how many pages were looked at", async () => {
  const g = makeGrid({ numbers: Array.from({ length: 14 }, (_, i) => `R1410260000${String(i).padStart(2, "0")}`) });
  const wrapped = {
    ...g.driver,
    async getAllWindowHandles() {
      return ["main"];
    },
    async getCurrentUrl() {
      return "https://smartzone.reliancegeneral.co.in/Payment/Payments?pageName=abc";
    },
    async get() {},
    async executeScript(fn, ...args) {
      if (fn === fallback.readPaymentPageInPage) return { url: "u", onPendingQuotes: true };
      return g.driver.executeScript(fn, ...args);
    },
    switchTo() {
      return { async window() {} };
    },
  };
  const r = await quiet(() => fallback.reachPaymentPage(wrapped, { proposalNumber: OURS, ...g.opts, checkboxWaitMs: 3000 }));
  assert.equal(r.reached, false);
  assert.equal(r.proposalFound, false);
  assert.match(r.reason, /is not listed in Reliance's Pending Quotes \(looked at page 1 \(10 rows\), page 2 \(4 rows\), 14 items in the list\)/);
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

test("relianceForm.js STEP 8: every page is searched for BOTH policy kinds; a proposal nowhere in the list is an error, not 'the first checkbox'", () => {
  const step = at('console.log("Looking for proposal checkbox...");');
  const paging = at("if (isQuotesPagingEnabled()) {", step);
  const search = at("await findProposalAcrossPages(driver, proposalNumber", paging);
  const notFound = at("if (!search.found) {", search);
  const code = at('{ code: "PROPOSAL_NOT_LISTED" }', notFound);
  const picked = at("proposalCheckbox = search.checkbox;", code);
  const legacyWallet = at("} else if (walletStrict) {", picked);
  const looseXpath = at("if (proposalNumber && !proposalCheckbox) {", legacyWallet);
  const firstBox = at("if (!proposalCheckbox && !walletStrict) {", looseXpath);
  const ticked = at('console.log("✅ Clicked proposal checkbox");', firstBox);
  assert.ok(step < paging && paging < search && search < notFound && notFound < code && code < picked);
  assert.ok(picked < legacyWallet && legacyWallet < looseXpath && looseXpath < firstBox && firstBox < ticked);
  // the message names the kind of payment and says nothing was ticked, paid or sent
  assert.match(formSrc.slice(notFound, code), /Nothing was ticked, paid or sent/);
  assert.match(formSrc.slice(notFound, code), /walletStrict \? "wallet payment was not started" : "payment link was not sent"/);
  // with paging ON the first-checkbox fallback can never be reached: the search either found it or threw
  assert.match(formSrc.slice(paging, legacyWallet), /throw new PaymentStepError\(/);
});

test("relianceForm.js: the search result is logged with the page it was found on", () => {
  assert.match(formSrc, /exact match, page \$\{search\.page\} of \$\{search\.pages\}/);
});
