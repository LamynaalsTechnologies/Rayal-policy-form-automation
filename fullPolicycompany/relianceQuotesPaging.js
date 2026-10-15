/**
 * Reliance — finding a proposal in the Pending Quotes list when the list has more than one page.
 *
 * Pending Quotes is a Kendo grid, 10 rows to a page (pager: "11 - 14 of 14 items", numbers 1 2, first / previous / next /
 * last links, the last two `k-state-disabled` on the last page). Every lookup in the flow used to read only the page that
 * was open — page 1 — so a proposal on page 2 was "not listed". Worse, the link path then fell back to "the first
 * checkbox" and ticked ANOTHER customer's proposal. 2026-10-14: wallet run for R141026119597 — "not listed", it was on
 * page 2.
 *
 * findProposalAcrossPages():
 *   1. waits for the grid — the `.k-grid` that holds the proposal checkboxes, so the payment-details grid (its own pager)
 *      is never mistaken for it — to have rows and no loading mask;
 *   2. goes to page 1 first if another page is open, then looks at each page in turn: exact match on the proposal number
 *      (a whole token — a longer number that merely contains it is another proposal), else the pager's NEXT link;
 *   3. after each click waits until the pager shows the page asked for, the mask is gone and the rows are there;
 *   4. returns on the page the proposal is on — it never moves again, the caller ticks it right there (Kendo does not keep
 *      a tick across pages).
 * No pager (10 rows or fewer) is one page. A page that does not change after the click ends the search with that reason
 * instead of guessing.
 *
 * RELIANCE_QUOTES_PAGING_ENABLED (default on; false = the old "page that is open" search).
 *
 * Everything takes the driver and the clock as arguments, so it is tested with fakes. Used by relianceForm.js (wallet and
 * link policies), by the KYC fallback (relianceKycFallback.js) and, being shared, by the Reliance OD / TP copy.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isQuotesPagingEnabled() {
  return !isOff(process.env.RELIANCE_QUOTES_PAGING_ENABLED);
}

/** More pages than this is not a Pending Quotes list; the search stops there (10 rows x 40 = 400 proposals). */
const MAX_PAGES = 40;

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises their source)             */
/* -------------------------------------------------------------------------- */

/**
 * The checkbox of THIS proposal on the page that is open: its `onclick` names the proposal number, or its table row shows
 * it. An exact match on the number as a whole token — never "the first checkbox".
 */
function findProposalCheckboxInPage(proposal) {
  var wanted = String(proposal || "").replace(/[^A-Za-z0-9]/g, "");
  if (!wanted) return null;
  var re = new RegExp("(^|[^A-Za-z0-9])" + wanted + "($|[^A-Za-z0-9])");
  var boxes = document.querySelectorAll("input[type='checkbox']");
  var i;
  for (i = 0; i < boxes.length; i++) {
    if (re.test(boxes[i].getAttribute("onclick") || "")) return boxes[i];
  }
  for (i = 0; i < boxes.length; i++) {
    var row = boxes[i].closest ? boxes[i].closest("tr") : null;
    if (row && re.test(row.innerText || row.textContent || "")) return boxes[i];
  }
  return null;
}

/**
 * The state of the proposals grid and its pager, in one read. Reads only — touches nothing.
 *
 * @returns {{hasGrid:boolean, boxes:number, signature:string, loading:boolean,
 *            pager:{present:boolean, current:number, pages:number, total:number, from:number, to:number,
 *                   nextEnabled:boolean, firstEnabled:boolean, numbers:number[], ambiguous:boolean}}}
 */
function readQuotesGridInPage() {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function text(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }
  function asNumber(value) {
    var n = parseInt(String(value || "").replace(/[^0-9]/g, ""), 10);
    return isNaN(n) ? 0 : n;
  }
  var i;
  // the proposal checkboxes: id chkR… or an onclick that names an R… number
  var all = document.querySelectorAll("input[type='checkbox']");
  var proposalBoxes = [];
  for (i = 0; i < all.length; i++) {
    var onclick = String(all[i].getAttribute("onclick") || "");
    if (/^chkR/i.test(all[i].id || "") || /R\d{6,}/.test(onclick)) proposalBoxes.push(all[i]);
  }
  // the grid they live in; the pager inside it, else the only pager on the page
  var grid = proposalBoxes.length && proposalBoxes[0].closest ? proposalBoxes[0].closest(".k-grid") : null;
  var pager = grid ? grid.querySelector(".k-pager-wrap, .k-grid-pager") : null;
  var ambiguous = false;
  if (!pager) {
    var pagers = document.querySelectorAll(".k-pager-wrap, .k-grid-pager");
    if (pagers.length === 1) pager = pagers[0];
    else if (pagers.length > 1) ambiguous = true;
  }
  var inGrid = [];
  for (i = 0; i < proposalBoxes.length; i++) {
    if (!grid || (grid.contains && grid.contains(proposalBoxes[i]))) inGrid.push(proposalBoxes[i]);
  }
  // what identifies the rows on screen: id, onclick and the row's own text — so another page never looks like this one
  var ids = [];
  for (i = 0; i < inGrid.length; i++) {
    var rowEl = inGrid[i].closest ? inGrid[i].closest("tr") : null;
    ids.push(
      (inGrid[i].id || "") + ":" + String(inGrid[i].getAttribute("onclick") || "").slice(0, 60) + ":" + (rowEl ? text(rowEl).slice(0, 80) : "")
    );
  }

  var loading = false;
  var masks = document.querySelectorAll(".k-loading-mask");
  for (i = 0; i < masks.length; i++) if (shown(masks[i])) loading = true;

  var out = {
    hasGrid: inGrid.length > 0,
    boxes: inGrid.length,
    signature: ids.join("|"),
    loading: loading,
    pager: { present: false, current: 1, pages: 1, total: 0, from: 0, to: 0, nextEnabled: false, firstEnabled: false, numbers: [], ambiguous: ambiguous },
  };
  if (!pager) return out;

  var p = out.pager;
  p.present = true;
  var selected = pager.querySelector(".k-pager-numbers .k-state-selected, .k-pager-numbers .k-current-page");
  p.current = selected ? asNumber(text(selected)) || 1 : 1;
  var links = pager.querySelectorAll(".k-pager-numbers a[data-page]");
  var max = p.current;
  for (i = 0; i < links.length; i++) {
    var n = asNumber(links[i].getAttribute("data-page"));
    if (n) {
      p.numbers.push(n);
      if (n > max) max = n;
    }
  }
  // "11 - 14 of 14 items" -> from 11, to 14, total 14
  var info = pager.querySelector(".k-pager-info");
  var m = text(info).match(/(\d+)\s*[-–]\s*(\d+)\s*of\s*(\d+)/i);
  if (m) {
    p.from = parseInt(m[1], 10);
    p.to = parseInt(m[2], 10);
    p.total = parseInt(m[3], 10);
    var size = p.current > 1 ? Math.round((p.from - 1) / (p.current - 1)) : p.to;
    if (size > 0 && p.total > 0) max = Math.max(max, Math.ceil(p.total / size));
  }
  p.pages = max;
  function enabledLink(iconClass, titlePart) {
    var icon = pager.querySelector("." + iconClass);
    var a = icon ? (icon.closest ? icon.closest("a") : icon.parentNode) : null;
    if (!a) {
      var anchors = pager.querySelectorAll("a");
      for (var k = 0; k < anchors.length; k++) {
        if (String(anchors[k].getAttribute("title") || "").toLowerCase().indexOf(titlePart) >= 0) {
          a = anchors[k];
          break;
        }
      }
    }
    return !!a && !/(^|\s)k-state-disabled(\s|$)/.test(a.className || "");
  }
  p.nextEnabled = enabledLink("k-i-arrow-e", "next page");
  p.firstEnabled = enabledLink("k-i-seek-w", "first page");
  return out;
}

/**
 * Click one of the pager's links with a script click (the page's own handlers run).
 *
 * @param {{action:"next"|"first"|"page", page?:number}} spec
 * @returns {{clicked:boolean, via?:string, reason?:string}}
 */
function goToQuotesPageInPage(spec) {
  var i;
  var all = document.querySelectorAll("input[type='checkbox']");
  var firstBox = null;
  for (i = 0; i < all.length && !firstBox; i++) {
    var onclick = String(all[i].getAttribute("onclick") || "");
    if (/^chkR/i.test(all[i].id || "") || /R\d{6,}/.test(onclick)) firstBox = all[i];
  }
  var grid = firstBox && firstBox.closest ? firstBox.closest(".k-grid") : null;
  var pager = grid ? grid.querySelector(".k-pager-wrap, .k-grid-pager") : null;
  if (!pager) {
    var pagers = document.querySelectorAll(".k-pager-wrap, .k-grid-pager");
    if (pagers.length === 1) pager = pagers[0];
  }
  if (!pager) return { clicked: false, reason: "no pager found for the proposals grid" };

  function linkWithIcon(iconClass, titlePart) {
    var icon = pager.querySelector("." + iconClass);
    var a = icon ? (icon.closest ? icon.closest("a") : icon.parentNode) : null;
    if (a) return a;
    var anchors = pager.querySelectorAll("a");
    for (var k = 0; k < anchors.length; k++) {
      if (String(anchors[k].getAttribute("title") || "").toLowerCase().indexOf(titlePart) >= 0) return anchors[k];
    }
    return null;
  }
  var link = null;
  var via = "";
  if (spec.action === "next") {
    link = linkWithIcon("k-i-arrow-e", "next page");
    via = "next";
  } else if (spec.action === "first") {
    link = linkWithIcon("k-i-seek-w", "first page");
    via = "first";
  }
  if (!link && spec.page) {
    var numbers = pager.querySelectorAll(".k-pager-numbers a[data-page]");
    for (i = 0; i < numbers.length; i++) {
      if (parseInt(numbers[i].getAttribute("data-page"), 10) === spec.page) {
        link = numbers[i];
        via = "number";
        break;
      }
    }
  }
  if (!link) return { clicked: false, reason: "the pager has no link for it" };
  if (/(^|\s)k-state-disabled(\s|$)/.test(link.className || "")) return { clicked: false, reason: "the pager link is disabled" };
  link.click();
  return { clicked: true, via: via };
}

/* -------------------------------------------------------------------------- */
/* In node                                                                    */
/* -------------------------------------------------------------------------- */

async function poll(read, { timeoutMs, pollMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await read();
    } catch (e) {
      if (e && e.isAutomationStop) throw e;
      value = null;
    }
    if (value) return value;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** "looked at page 1 (10 rows), page 2 (4 rows) — 14 items" — what a not-found result is told in. */
function describeScan(result) {
  const r = result || {};
  const scanned = r.scanned || [];
  if (!scanned.length) return r.reason || "nothing could be looked at";
  const pages = scanned.map((s) => `page ${s.page} (${s.rows} row${s.rows === 1 ? "" : "s"})`).join(", ");
  const total = r.total ? `, ${r.total} item${r.total === 1 ? "" : "s"} in the list` : "";
  return `looked at ${pages}${total}`;
}

/**
 * Find the checkbox of THIS proposal in Pending Quotes, on whichever page it is, and leave that page open.
 *
 * @param {Object} driver
 * @param {string} proposalNumber
 * @param {Object} [o]
 * @param {Function} [o.log]
 * @returns {Promise<{found:boolean, checkbox:Object|null, page:number|null, pages:number|null, total:number|null,
 *                    scanned:Array<{page:number, rows:number}>, reason:string}>}
 */
async function findProposalAcrossPages(driver, proposalNumber, o = {}) {
  const {
    log = () => {},
    sleep = (ms) => driver.sleep(ms),
    now = Date.now,
    gridWaitMs = 20000,
    pageWaitMs = 15000,
    maxPages = MAX_PAGES,
    pollMs = 400,
    settleMs = 250,
  } = o;
  const proposal = String(proposalNumber || "").trim();
  const result = { found: false, checkbox: null, page: null, pages: null, total: null, scanned: [], reason: "" };
  if (!proposal) {
    result.reason = "the policy has no proposal number to look for";
    return result;
  }
  const waitOpts = { pollMs, now, sleep };
  const read = () => driver.executeScript(readQuotesGridInPage);

  // 1. the grid has rows and is not loading
  let state = await poll(async () => {
    const s = await read();
    return s && s.boxes > 0 && !s.loading ? s : null;
  }, { ...waitOpts, timeoutMs: gridWaitMs });
  if (!state) {
    const last = await read().catch(() => null);
    result.reason = last && last.loading ? "the Pending Quotes list was still loading" : "the Pending Quotes list shows no proposals";
    return result;
  }

  // one page change: click, then wait until the pager shows the page asked for, with rows, no mask, and a CHANGED list — a
  // pager that already shows the new number over the old rows (the grid re-renders after it) is not the new page yet
  async function changePage(spec, target, before) {
    let clicked = await driver.executeScript(goToQuotesPageInPage, spec);
    if (!(clicked && clicked.clicked) && spec.action === "next") {
      clicked = await driver.executeScript(goToQuotesPageInPage, { action: "page", page: target });
    }
    if (!(clicked && clicked.clicked)) {
      return { ok: false, reason: `could not go to page ${target} (${(clicked && clicked.reason) || "no pager link"})` };
    }
    log(`Pending Quotes — page ${target} (${clicked.via})`);
    const next = await poll(async () => {
      const s = await read();
      if (!s || s.loading || s.boxes === 0) return null;
      if (s.pager.present && s.pager.current !== target) return null;
      return s.signature !== before.signature ? s : null;
    }, { ...waitOpts, timeoutMs: pageWaitMs });
    if (!next) return { ok: false, reason: `page ${target} did not load` };
    await sleep(settleMs);
    return { ok: true, state: next };
  }

  // 2. start at page 1
  if (state.pager.present && state.pager.current > 1) {
    const moved = await changePage({ action: "first" }, 1, state);
    if (moved.ok) state = moved.state;
    else log(`could not go back to page 1 (${moved.reason}) — looking from page ${state.pager.current}`);
  }

  // 3. each page in turn
  for (let i = 0; i < maxPages; i++) {
    const page = state.pager.present ? state.pager.current : 1;
    result.scanned.push({ page, rows: state.boxes });
    result.pages = state.pager.present ? state.pager.pages : 1;
    result.total = state.pager.total || null;
    const box = await driver.executeScript(findProposalCheckboxInPage, proposal);
    if (box) {
      result.found = true;
      result.checkbox = box;
      result.page = page;
      return result;
    }
    if (!state.pager.present || !state.pager.nextEnabled || page >= state.pager.pages) break;
    const moved = await changePage({ action: "next" }, page + 1, state);
    if (!moved.ok) {
      result.reason = moved.reason;
      return result;
    }
    state = moved.state;
  }
  result.reason = `proposal ${proposal} is not in the list`;
  return result;
}

module.exports = {
  isQuotesPagingEnabled,
  MAX_PAGES,
  findProposalCheckboxInPage,
  readQuotesGridInPage,
  goToQuotesPageInPage,
  findProposalAcrossPages,
  describeScan,
};
