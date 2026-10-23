/**
 * KSHEMA payment — the WALLET side (2026-10-22).
 *
 * KSHEMA's "Choose Payment Method" page (what Make Payment opens) has two cards:
 *   - Razorpay    "Secure payment via Razorpay"           = the customer's QR / payment link. That flow is
 *                 kshemaQuoteForm.js proceedToPayment, left exactly as it was.
 *   - CD Balance  "Pay directly from your CD account"     = the broker's own deposit at KSHEMA, the WALLET.
 *
 * The CD Balance card (the portal's own markup, pasted by the owner):
 *   <button type="button" aria-disabled="false" class="... border-primary ring-2 ...">      <- aria-disabled="true" when off
 *     <p class="font-medium">CD Balance</p> <p class="text-sm ...">Pay directly from your CD account</p>
 *     <div class="h-4 w-4 rounded-full border border-primary bg-primary"></div>             <- the radio dot, filled = chosen
 *     <p>Available balance</p> <p>₹65,329</p> <p>Updated 22 Oct 2026, 03:44 pm</p>          <- only when the login has a CD account
 *   </button>
 * and for a login without one, inside the card:
 *   <div class="flex items-center gap-2 rounded-lg border border-destructive/30 ... text-destructive">
 *     <svg .../><span>Account not found. Username and broker code combination does not exist</span></div>
 *
 * A policy paid from the wallet must NOT take the Razorpay road (it would make the customer's QR and look finished while
 * nothing was paid). Its run goes: Make Payment -> keep the payment page's address -> choose the CD Balance card ->
 *   - chosen, with an available balance above zero: handed back to the form, which pays with it (kshemaWalletIssue.js:
 *     the premium check, the note, Pay with CD Balance once, the policy page, the number, the PDF). The balance KSHEMA
 *     shows is read here for that check and for the log.
 *   - KSHEMA's red "Account not found" line, or the card switched off: an ERROR - "the CD option is not enabled for this
 *     KSHEMA account" (the owner's rule). No "Available balance" on the card, or nothing available (zero or less), is an
 *     error too ("available balance also check - if not, make the error"), and so is a card that is missing or does not
 *     switch on when clicked. NOT checked here: the balance against the amount to pay (the amount's source is not decided).
 *
 *   chooseCdBalance    what proceedToPayment does for a wallet policy; { ok: true, wallet: true, chosen: true ... } to pay
 *                      with, { ok: false, wallet: true, error } to fail on. Never throws for what the page shows.
 *
 * Shared by the full-company flow and the TP copy (both proceedToPayment functions call it), so the two cannot drift.
 * Nothing here presses a Pay button: only a card is chosen, which pays nothing (the pressing is kshemaWalletIssue.js's). Operator sentences carry no colon
 * (beautifyError keeps only the text after the last one). No .env switch.
 */
const { log, warn } = require("./kshemaLog");
// "Wallet" = anything that is not "link"; blank is the backend default, which is wallet. ONE definition for every insurer.
const { isWalletPayment } = require("../reliance/relianceWalletHold");

/** The name KSHEMA gives the wallet card. */
const CD_BALANCE = "CD Balance";

const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const noColon = (s) => norm(s).replace(/\s*:\s*/g, " - ");
const noEndStop = (s) => norm(s).replace(/[.\s]+$/, "");
const isCdBalance = (card) => !!card && (/^cd\s*balance\b/i.test(card.name || "") || /^cd\s*balance\b/i.test(card.text || ""));

/**
 * Runs in the browser. Returns { cards: [[element, name, text, disabled, selected, says, wrapperText], ...], action }.
 *
 *   card         a shown <button> with a <p> (its name), like the Razorpay card — plus, when no card is called CD Balance,
 *                whatever shows that name (a card that is not a button cannot be clicked: disabled)
 *   disabled     the button's disabled attribute or aria-disabled="true"
 *   selected     the filled radio dot at the end of the card (bg-primary) — the same reading the Razorpay step trusts —
 *                or an aria-checked / aria-pressed / aria-selected
 *   says         what KSHEMA writes in red inside or beside the card (its own words, e.g. "Account not found ...")
 *   wrapperText  the card with whatever is drawn around it, for the log (it holds the "Available balance" lines)
 *   action       the text of the first button after the last card (what the page offers to press now)
 */
const PAYMENT_CARDS_SCRIPT = `
  var norm = function (s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); };
  var shown = function (el) {
    var r = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  var reddish = function (el) {
    var m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(window.getComputedStyle(el).color || '');
    return !!m && Number(m[1]) > 160 && Number(m[2]) < 130 && Number(m[3]) < 130;
  };
  var alertish = function (el) {
    return !!el.closest('[class*="destructive"], [class*="text-red"], [role="alert"]') || reddish(el);
  };
  var filled = function (card) {
    var dots = card.querySelectorAll('div.rounded-full, span.rounded-full');
    for (var i = 0; i < dots.length; i++) {
      if (/(^|\\s)bg-primary(\\s|$)/.test(String(dots[i].className || ''))) return true;
    }
    return card.getAttribute('aria-checked') === 'true' || card.getAttribute('aria-pressed') === 'true' || card.getAttribute('aria-selected') === 'true';
  };
  var wrapperOf = function (card) {
    var w = card;
    while (w.parentElement && w.parentElement.querySelectorAll('button').length === 1) w = w.parentElement;
    return w;
  };
  var says = function (w) {
    var found = [];
    var all = w.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.children.length > 0) continue;
      var t = norm(el.textContent);
      if (!t || !shown(el)) continue;
      if (alertish(el) && found.indexOf(t) === -1) found.push(t);
    }
    return found.join(' ');
  };
  var rows = [];
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button')).filter(shown);
  for (var i = 0; i < buttons.length; i++) {
    var b = buttons[i];
    var first = b.querySelector('p');
    if (!first) continue;
    var w = wrapperOf(b);
    rows.push([b, norm(first.textContent), norm(b.innerText), !!b.disabled || b.getAttribute('aria-disabled') === 'true', filled(b), says(w), norm(w.innerText)]);
  }
  var haveCd = rows.some(function (r) { return /^cd\\s*balance/i.test(r[1]) || /^cd\\s*balance/i.test(r[2]); });
  if (!haveCd) {
    var leaves = document.querySelectorAll('p, span, h1, h2, h3, h4, h5, label, div');
    for (var j = 0; j < leaves.length; j++) {
      var e = leaves[j];
      if (e.children.length > 0 || !shown(e)) continue;
      if (!/^cd\\s*balance$/i.test(norm(e.textContent))) continue;
      var host = e.closest('button');
      var card = host || e.parentElement || e;
      var box = card;
      for (var up = 0; up < 5 && box.parentElement; up++) {
        var cs = window.getComputedStyle(box);
        if (parseFloat(cs.borderTopWidth) > 0 && box.getBoundingClientRect().height > 60) break;
        box = box.parentElement;
      }
      rows.push([card, norm(e.textContent), norm(box.innerText), !host || !!host.disabled || host.getAttribute('aria-disabled') === 'true', host ? filled(host) : false, says(box), norm(box.innerText)]);
      break;
    }
  }
  var action = '';
  if (rows.length) {
    var lastEl = rows[0][0];
    rows.forEach(function (r) { if (lastEl.compareDocumentPosition(r[0]) & 4) lastEl = r[0]; });
    for (var k = 0; k < buttons.length; k++) {
      var btn = buttons[k];
      if (btn === lastEl || lastEl.contains(btn)) continue;
      if (!(lastEl.compareDocumentPosition(btn) & 4)) continue;
      var tx = norm(btn.innerText);
      if (tx) { action = tx; break; }
    }
  }
  return { cards: rows, action: action };
`;

/** The payment cards as they show now: [{ element, name, text, disabled, selected, says, wrapperText }] + the next button. */
async function readPaymentCards(driver) {
  const raw = await driver.executeScript(PAYMENT_CARDS_SCRIPT);
  const rows = raw && Array.isArray(raw.cards) ? raw.cards : [];
  return {
    cards: rows.map((r) => ({
      element: r[0],
      name: norm(r[1]),
      text: norm(r[2]),
      disabled: !!r[3],
      selected: !!r[4],
      says: norm(r[5]),
      wrapperText: norm(r[6]),
    })),
    action: norm(raw && raw.action),
  };
}

const snapshotKey = (snap) => JSON.stringify(snap.cards.map((c) => [c.name, c.disabled, c.selected, c.says]));

/**
 * Wait for the cards to show, then for them to stop changing (KSHEMA checks the CD account after the page opens, so a
 * card can flip from clickable to switched off a moment later). Counted in polls, never longer than `timeoutMs`.
 */
async function awaitPaymentCards(driver, { timeoutMs = 15000, stableMs = 1500, settleMs = 6000, pollMs = 500 } = {}) {
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const stablePolls = Math.max(1, Math.ceil(stableMs / pollMs));
  const settlePolls = Math.max(1, Math.ceil(settleMs / pollMs));
  let snap = { cards: [], action: "" };
  let lastKey = "";
  let stableFor = 0;
  let shownFor = 0;
  for (let poll = 0; poll < maxPolls; poll++) {
    try {
      snap = await readPaymentCards(driver);
    } catch (e) {
      snap = { cards: [], action: "" };
    }
    if (snap.cards.length > 0) {
      shownFor++;
      const key = snapshotKey(snap);
      stableFor = key === lastKey ? stableFor + 1 : 0;
      lastKey = key;
      if (stableFor >= stablePolls || shownFor >= settlePolls) break;
    }
    await driver.sleep(pollMs);
  }
  return snap;
}

/**
 * The CD card's own "Available balance" line ("... AVAILABLE BALANCE ₹65,329 Updated 22 Oct 2026, 03:44 pm") -> { text: "₹65,329",
 * amount: 65329 }; { text: "", amount: null } when the card shows none. A leading minus counts.
 */
function readBalance(text) {
  const m = /available balance\s*:?\s*(-)?\s*(?:₹|rs\.?|inr)?\s*(-)?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(norm(text));
  if (!m) return { text: "", amount: null };
  const number = Number(m[3].replace(/,/g, ""));
  if (!Number.isFinite(number)) return { text: "", amount: null };
  const negative = !!(m[1] || m[2]);
  return { text: `${negative ? "-" : ""}₹${m[3]}`, amount: negative ? -number : number };
}
/** The balance text only ("₹65,329", or "" when none). */
const parseBalance = (text) => readBalance(text).text;

/**
 * After the card is chosen, wait a few polls for its "Available balance" to show (KSHEMA may fetch it a moment after the
 * click). Returns the last card seen and the balance read from it.
 */
async function awaitBalance(driver, cd, { pollMs = 500, balanceMs = 5000 } = {}) {
  let card = cd;
  let snap = null;
  const polls = Math.max(1, Math.ceil(balanceMs / pollMs));
  for (let i = 0; i < polls; i++) {
    const read = readBalance(card.wrapperText || card.text);
    if (read.text) return { ...read, card, snap };
    await driver.sleep(pollMs);
    try {
      snap = await readPaymentCards(driver);
      card = snap.cards.find(isCdBalance) || card;
    } catch (e) {
      break;
    }
  }
  return { ...readBalance(card.wrapperText || card.text), card, snap };
}

/**
 * The ERROR sentence of a wallet policy that cannot use CD Balance (no colon). The owner's wording for KSHEMA's red line:
 * "this account CD option not enabled".
 */
function walletErrorMessage(r = {}) {
  const says = noEndStop(r.kshemaSays);
  if (r.problem === "not-enabled") {
    return noColon(
      "The CD Balance option is not enabled for this KSHEMA account" +
        (says ? `. KSHEMA says ${says}` : ". The payment page shows it switched off") +
        ". Ask KSHEMA to enable the CD account for this login, then run the policy again. Nothing is paid"
    );
  }
  if (r.problem === "no-balance") {
    return noColon("KSHEMA shows no available balance on the CD Balance option, so the wallet cannot be used. Check the CD account of this login at KSHEMA. Nothing is paid");
  }
  if (r.problem === "no-money") {
    return noColon("The CD Balance of this KSHEMA account has no available money, so the wallet cannot pay this policy. Add money to the CD account, then run the policy again. Nothing is paid");
  }
  if (r.problem === "missing") {
    const shows = (r.cards || []).length ? ` (it shows ${(r.cards || []).join(" and ")})` : " (no payment option could be read)";
    return noColon(`The KSHEMA payment page shows no CD Balance option${shows}, so the wallet cannot be used. Nothing is paid`);
  }
  return noColon("CD Balance did not switch on when it was clicked on the KSHEMA payment page. Nothing is paid");
}

/** One short sentence for the payment step's note when CD Balance is chosen (no colon). */
const walletNote = (r) => noColon(`wallet - CD Balance chosen on the payment page${r.balance ? `, available balance ${r.balance}` : ""}, nothing paid`);

/**
 * proceedToPayment's wallet branch: the page after Make Payment is showing. Keeps its address, finds the CD Balance
 * card and decides:
 *   - clickable (or already chosen) and it takes -> { ok: true, chosen: true }: the form pays with it (kshemaWalletIssue.js)
 *   - KSHEMA's red line / the card switched off  -> { ok: false, problem: "not-enabled", error }
 *   - no CD Balance card at all                  -> { ok: false, problem: "missing", error }
 *   - the click does not take (twice)            -> { ok: false, problem: "not-taking", error }
 *   - chosen but no "Available balance" shown    -> { ok: false, problem: "no-balance", error }
 *   - chosen but nothing available (zero / less) -> { ok: false, problem: "no-money", error }
 * A picture of the page is taken when the card is chosen - the page as it is right before Pay (a failure gets the form's own
 * failure picture).
 * Never presses a Pay button. Never throws for what the page shows.
 *
 * @returns {Promise<Object>} { ok, wallet: true, paymentUrl, cdFound, clicked, chosen, problem, error?, kshemaSays, balance,
 *   balanceAmount, cards: string[], action, note, screenshotUrl, screenshotKey }
 */
async function chooseCdBalance(driver, { capture = null, jobId = "", ...waits } = {}) {
  const { clickElement } = require("./kshemaFields");
  const result = {
    ok: true,
    wallet: true,
    paymentUrl: "",
    cdFound: false,
    clicked: false,
    chosen: false,
    problem: "",
    kshemaSays: "",
    balance: "",
    balanceAmount: null,
    cards: [],
    action: "",
    note: "",
    screenshotUrl: null,
    screenshotKey: null,
  };

  // 1. The address of this page first - it is what the policy keeps as "Make Payment Page".
  try {
    result.paymentUrl = (await driver.getCurrentUrl()) || "";
    log(`   ✓ Payment page address read (wallet policy): ${result.paymentUrl}`);
  } catch (e) {
    warn(`   Could not read the payment page address - ${noColon(e && e.message)}`);
  }

  // 2. The cards, once they have settled.
  let snap = await awaitPaymentCards(driver, waits);
  result.cards = snap.cards.map((c) => c.name);
  log(`   💳 Payment options on the page - ${result.cards.length ? result.cards.join(", ") : "none found"}`);

  let cd = snap.cards.find(isCdBalance) || null;
  result.cdFound = !!cd;
  if (!cd) {
    warn(`   No ${CD_BALANCE} option on the payment page - nothing is clicked.`);
    result.problem = "missing";
  } else {
    log(`   💳 ${CD_BALANCE} card - ${cd.wrapperText || cd.text}`);
    result.kshemaSays = cd.says;
    if (cd.says) warn(`   KSHEMA says on the ${CD_BALANCE} card - ${noColon(cd.says)}`);
    if (cd.says || cd.disabled) {
      // KSHEMA's red "Account not found" line, or the card switched off: this account has no usable CD option. Not clicked.
      result.problem = "not-enabled";
    } else {
      if (cd.selected) {
        log(`   ✓ ${CD_BALANCE} is already chosen`);
      } else {
        // Clicking only CHOOSES the card (it pays nothing - a separate Pay button does). Twice at most.
        for (let attempt = 1; attempt <= 2 && !(cd && cd.selected); attempt++) {
          try {
            result.clicked = true;
            await clickElement(driver, cd.element, `${CD_BALANCE} option`);
          } catch (e) {
            warn(`   Could not click ${CD_BALANCE} (attempt ${attempt}) - ${noColon(e && e.message)}`);
          }
          await driver.sleep(1000);
          try {
            snap = await readPaymentCards(driver);
            cd = snap.cards.find(isCdBalance) || cd;
          } catch (e) {
            warn(`   Could not read the payment page after the click - ${noColon(e && e.message)}`);
            break;
          }
          if (cd.says) break; // KSHEMA answered the click with its red line: nothing more to try
          if (!cd.selected && attempt === 1) log(`   … ${CD_BALANCE} did not take, clicking it once more`);
        }
        if (cd && cd.selected) log(`   ✓ ${CD_BALANCE} chosen`);
      }
      result.kshemaSays = (cd && cd.says) || "";
      result.chosen = !!(cd && cd.selected);
      if (!result.chosen) {
        result.problem = result.kshemaSays ? "not-enabled" : "not-taking";
      } else {
        // The card of a login with a CD account shows its available balance: no balance, or nothing available, is an error too.
        const found = await awaitBalance(driver, cd, waits);
        if (found.snap) snap = found.snap;
        result.balance = found.text;
        result.balanceAmount = found.amount;
        if (!found.text) {
          warn(`   The ${CD_BALANCE} card shows no available balance.`);
          result.problem = "no-balance";
        } else {
          log(`   💰 ${CD_BALANCE} available balance as KSHEMA shows it - ${found.text}`);
          if (!(found.amount > 0)) result.problem = "no-money";
        }
      }
    }
  }
  result.action = snap.action || "";

  if (result.problem) {
    result.ok = false;
    result.error = walletErrorMessage(result);
    result.note = noColon(result.error);
    return result;
  }

  // 3. Chosen: the button the page offers now is logged (pressed only by kshemaWalletIssue.js) and the page is photographed.
  if (result.action) log(`   ℹ️  The payment page button reads "${result.action}"`);
  if (capture) {
    try {
      const shot = await capture("kshema_wallet_payment", "wallet_payment");
      if (shot && shot.screenshotUrl) {
        result.screenshotUrl = shot.screenshotUrl;
        result.screenshotKey = shot.screenshotKey || null;
        log(`   📸 Payment page picture saved: ${shot.screenshotUrl}`);
      }
    } catch (e) {
      warn(`   Could not take the payment page picture - ${noColon(e && e.message)}`);
    }
  }
  result.note = walletNote(result);
  return result;
}

module.exports = {
  isWalletPayment,
  isCdBalance,
  readPaymentCards,
  awaitPaymentCards,
  chooseCdBalance,
  readBalance,
  parseBalance,
  walletErrorMessage,
  walletNote,
  PAYMENT_CARDS_SCRIPT,
  CD_BALANCE,
};
