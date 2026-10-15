/**
 * Reliance — paying a WALLET policy with the agent's CDT option.
 *
 * Until now a wallet policy stopped right after Pay was clicked ("WALLET HOLD", relianceWalletHold.js). With
 * RELIANCE_WALLET_CDT_ENABLED (default on) the run goes on, on the payment panel Pay opens:
 *
 *   1. the payment options of the login are read; if the CDT option (#rdbtnPaymentOptionCDT) is not there, not shown or
 *      disabled, that is an ERROR — "this Reliance login does not have the CDT option" — with the other options named
 *      and a screenshot (the form's failure catch takes it);
 *   2. otherwise CDT is clicked, the payable amount Reliance shows (#txbPayableamountCurrency) is read, the SAME amount
 *      is typed into the CDT amount box (#txtcdtReducedCurrency) and read back, and Add (#btnAddRowToGrid) is pressed;
 *   3. then, with RELIANCE_WALLET_SUBMIT_ENABLED off, the run WAITS: a stop (stage reliance-wallet-cdt-added) with what
 *      the page showed. Nothing is submitted — Add only puts a row into Reliance's payment-details grid. With it on
 *      (default) relianceWalletIssue.js takes over right after Add: Submit Details, the policy number, the policy PDF.
 *
 * It is a money step, so it is built to refuse rather than guess:
 *   - amounts are whole PAISE (never floats); the typed amount must read back equal to the payable amount to the paisa,
 *     and the payable amount must still be the same right before Add;
 *   - exactly one proposal is ticked and it is THIS proposal (exact token match on the number);
 *   - Add is pressed at most once, and never unless the amount box was read back equal;
 *   - the amount is Reliance's own — it is not compared with our premium (Karthi's decision: an agent's payable amount
 *     can legitimately differ from the premium on the policy).
 *
 * The page is only partly known (four elements). So every step is verified by reading the page back, and what the page
 * shows (options, dialogs, button labels) goes into the message instead of being guessed.
 *
 * Everything takes the driver, the clock and the page-side callbacks as arguments, so it is tested with fakes.
 * Used by relianceForm.js and, being shared, by the Reliance OD / TP copy.
 */
const { By, Key } = require("selenium-webdriver");
const { PortalRejectedError, plain } = require("./relianceKycSubmit");

/** The page's own ids (from the elements Karthi pasted from the payment panel). */
const IDS = {
  cdtRadio: "rdbtnPaymentOptionCDT",
  radioGroup: "objAgentPaymentOption.PaymentType",
  payableDisplay: "txbPayableamountCurrency",
  payableRaw: "txbPayableamount",
  cdtDisplay: "txtcdtReducedCurrency",
  cdtRaw: "txtcdtReduced",
  add: "btnAddRowToGrid",
  paymentTypeList: "ddlPaymentType_listbox",
};

const STAGE_ADDED = "reliance-wallet-cdt-added";

/** A premium for a two-wheeler is never anywhere near this; a bigger number is a misread, not money. */
const MAX_PAYABLE_PAISE = 1000000 * 100; // Rs 10,00,000

/** A dialog / alert whose words are a refusal (anything else it shows is reported, not treated as an error). */
const REFUSAL_WORDS =
  /insufficient|not enough|exceed|more than|invalid|not allowed|failed|error|mandatory|required|cannot|can not|unable|please (?:select|enter|choose)/i;

/* -------------------------------------------------------------------------- */
/* Money — whole paise, never floats                                          */
/* -------------------------------------------------------------------------- */

/**
 * "₹ 1,23,456.50" / "1234.5" / "1,200" -> whole paise (integer), or null when it is not a plain rupee amount
 * (text, negative, more than 2 decimals, an empty box). Indian and western grouping are both fine.
 */
function parseRupees(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).replace(/[\s ]/g, "");
  s = s.replace(/^(?:₹|rs\.?|inr)/i, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const rupees = Number(whole);
  if (!Number.isSafeInteger(rupees)) return null;
  return rupees * 100 + Number(frac.padEnd(2, "0"));
}

/** 123456.5 rupees as paise -> "1,23,456.50" (always 2 decimals, Indian grouping). */
function formatPaise(paise) {
  if (!Number.isInteger(paise) || paise < 0) return "?";
  const rupees = Math.floor(paise / 100);
  const frac = String(paise % 100).padStart(2, "0");
  const digits = String(rupees);
  let grouped = digits;
  if (digits.length > 3) {
    const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
    grouped = `${head},${digits.slice(-3)}`;
  }
  return `${grouped}.${frac}`;
}

/** The plain digits-and-a-dot text the box's keypress filter accepts: 123456 + 50 paise -> "123456.50". */
function plainAmount(paise) {
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises their source)             */
/* -------------------------------------------------------------------------- */

/** Everything the steps below need to know about the payment panel, in one read. Reads only — touches nothing. */
function readPanelInPage(ids) {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function text(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }
  function labelOf(el) {
    var t = "";
    if (el.id) {
      var l = document.querySelector("label[for='" + el.id + "']");
      if (l) t = text(l);
    }
    if (!t && el.parentElement) t = text(el.parentElement);
    return t.slice(0, 60);
  }
  var i;
  var out = { url: String(window.location.href) };

  var radios = document.getElementsByName(ids.radioGroup);
  out.options = [];
  for (i = 0; i < radios.length; i++) {
    var r = radios[i];
    out.options.push({
      id: r.id || "",
      value: String(r.value || ""),
      label: labelOf(r),
      shown: shown(r),
      enabled: !r.disabled,
      checked: !!r.checked,
    });
  }

  function field(id) {
    var el = document.getElementById(id);
    return { exists: !!el, shown: shown(el), enabled: !!el && !el.disabled, value: el ? String(el.value || "") : null };
  }
  out.payableDisplay = field(ids.payableDisplay);
  out.payableRaw = field(ids.payableRaw);
  out.cdtDisplay = field(ids.cdtDisplay);
  out.cdtRaw = field(ids.cdtRaw);
  out.add = field(ids.add);

  out.dialogs = [];
  out.dialogButtons = [];
  var wins = document.querySelectorAll(".ui-dialog, .k-window");
  for (i = 0; i < wins.length; i++) {
    if (!shown(wins[i])) continue;
    var body = wins[i].querySelector(".ui-dialog-content, .k-window-content") || wins[i];
    var t = text(body);
    if (t) out.dialogs.push(t.slice(0, 300));
    var buttons = wins[i].querySelectorAll("button, input[type='button']");
    for (var b = 0; b < buttons.length; b++) {
      if (!shown(buttons[b])) continue;
      var label = text(buttons[b]) || String(buttons[b].value || "").trim();
      if (label && out.dialogButtons.indexOf(label) < 0) out.dialogButtons.push(label.slice(0, 40));
    }
  }

  var list = document.getElementById(ids.paymentTypeList);
  out.paymentTypeOptions = [];
  if (list) {
    var items = list.querySelectorAll("li");
    for (i = 0; i < items.length; i++) {
      var o = text(items[i]);
      if (o) out.paymentTypeOptions.push(o.slice(0, 60));
    }
  }

  var trs = document.querySelectorAll("tr");
  out.rows = trs.length;
  // The text of every table row that holds no other row (an outer row of a nested table repeats its inner rows' words):
  // what lets the next step tell the row Add put into the payment details from everything else on the page.
  out.rowTexts = [];
  for (i = 0; i < trs.length && out.rowTexts.length < 400; i++) {
    var tr = trs[i];
    if (tr.querySelector && tr.querySelector("tr")) continue;
    var rowText = text(tr);
    if (rowText) out.rowTexts.push(rowText.slice(0, 200));
  }

  out.ticked = [];
  var boxes = document.querySelectorAll("input[type='checkbox']");
  var total = 0;
  for (i = 0; i < boxes.length; i++) {
    var box = boxes[i];
    var onclick = String(box.getAttribute("onclick") || "");
    var isProposal = /^chkR/i.test(box.id || "") || /R\d{6,}/.test(onclick);
    if (!isProposal) continue;
    total++;
    if (!box.checked) continue;
    var row = box.closest ? box.closest("tr") : null;
    out.ticked.push({ id: box.id || "", onclick: onclick.slice(0, 200), rowText: row ? text(row).slice(0, 300) : "" });
  }
  out.proposalBoxes = total;
  return out;
}

/** Click an element by id with a script click (the page's own onclick runs). Returns whether it was found. */
function clickByIdInPage(id) {
  var el = document.getElementById(id);
  if (!el) return false;
  try {
    el.scrollIntoView({ block: "center" });
  } catch (e) {
    /* best effort */
  }
  el.click();
  return true;
}

/**
 * The script way of putting a value into the CDT amount box, when typing did not take: both the formatted box and the
 * raw one, the events a typed value would have raised, and the page's own balance recalculation if it has one.
 */
function setAmountInPage(ids, plainValue) {
  function fire(el, name) {
    var ev = document.createEvent("Event");
    ev.initEvent(name, true, true);
    el.dispatchEvent(ev);
  }
  var shownBox = document.getElementById(ids.cdtDisplay);
  var rawBox = document.getElementById(ids.cdtRaw);
  var touched = [];
  [rawBox, shownBox].forEach(function (el) {
    if (!el) return;
    el.value = plainValue;
    fire(el, "input");
    fire(el, "keyup");
    fire(el, "change");
    touched.push(el.id);
  });
  var recalculated = false;
  try {
    if (typeof window.RemainingCDTBalance === "function") {
      window.RemainingCDTBalance();
      recalculated = true;
    }
  } catch (e) {
    /* the page's own function failed: the read-back decides */
  }
  return { touched: touched, recalculated: recalculated };
}

/* -------------------------------------------------------------------------- */
/* The errors                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A step of the wallet payment that cannot go on. Ends the run as a failure (the nested catches of relianceForm.js let
 * `portalRejected` errors through), with its message kept as written.
 */
class PaymentStepError extends PortalRejectedError {
  constructor(message, { code = "WALLET", portalText = "" } = {}) {
    super(message, { stage: `reliance-wallet-${String(code).toLowerCase().replace(/_/g, "-")}`, portalText });
    this.name = "PaymentStepError";
    this.code = code;
    this.keepMessage = true; // the failure catch must not replace it with whatever #containerMain says
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const isStop = (e) => !!e && e.isAutomationStop === true;

async function poll(read, { timeoutMs, pollMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await read();
    } catch (e) {
      if (isStop(e)) throw e;
      value = null;
    }
    if (value) return value;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/**
 * ChromeDriver's default for a JavaScript alert that is open when the next command arrives is to dismiss it and FAIL
 * that command with UnexpectedAlertOpenError, the alert's words only in the error. The page raises exactly such an alert
 * from its own onchange (RemainingCDTBalance) when the CDT balance is not enough — so the words are taken out of the error.
 */
const isUnexpectedAlert = (e) =>
  !!e && (e.name === "UnexpectedAlertOpenError" || /unexpected alert open/i.test(String(e.message || "")));

function alertTextOf(e) {
  if (!e) return "";
  try {
    if (typeof e.getAlertText === "function") {
      const text = e.getAlertText();
      if (text) return String(text).trim();
    }
  } catch (err) {
    /* fall through to the message */
  }
  if (e.alertText) return String(e.alertText).trim();
  const m = String(e.message || "").match(/Alert text\s*:\s*([\s\S]*?)\}?\s*(?:\n|$)/i);
  return m ? m[1].replace(/\}$/, "").trim() : "an alert (its words could not be read)";
}

/**
 * Run one driver action. An alert that opened is not a crash: its words are kept in `alerts`. A READ is run again once
 * (the alert has been dismissed); an ACTION is not (it already happened — pressing Add twice is the one thing to avoid).
 */
async function guarded(fn, alerts, { retry = false } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (isStop(e) || !isUnexpectedAlert(e)) throw e;
    alerts.push(alertTextOf(e));
    return retry ? fn() : undefined;
  }
}

/** A native alert left open: read it and dismiss it, or "" when there is none. */
async function takeAlertText(driver) {
  try {
    const alert = await driver.switchTo().alert();
    const text = String((await alert.getText()) || "").trim();
    try {
      await alert.accept();
    } catch (e) {
      /* already gone */
    }
    return text;
  } catch (e) {
    return "";
  }
}

/** The payable amount on the panel, in paise: the formatted box, else the raw one; null when it is not there / not a number. */
function payableOf(panel) {
  const shown = parseRupees(panel.payableDisplay && panel.payableDisplay.value);
  const raw = parseRupees(panel.payableRaw && panel.payableRaw.value);
  if (shown !== null && raw !== null && shown !== raw) return { paise: null, conflict: { shown, raw } };
  const paise = shown !== null ? shown : raw;
  return { paise, conflict: null };
}

/** What the CDT amount box holds, in paise, from the formatted box and the raw one (they must not contradict). */
function enteredOf(panel) {
  const shownText = panel.cdtDisplay ? panel.cdtDisplay.value : null;
  const rawText = panel.cdtRaw ? panel.cdtRaw.value : null;
  const shown = parseRupees(shownText);
  const raw = parseRupees(rawText);
  if (shown !== null && raw !== null && shown !== raw) return { paise: null, shownText, rawText, conflict: true };
  return { paise: shown !== null ? shown : raw, shownText, rawText, conflict: false };
}

const tokenRegex = (proposal) => {
  const wanted = String(proposal || "").replace(/[^A-Za-z0-9]/g, "");
  return wanted ? new RegExp(`(^|[^A-Za-z0-9])${wanted}($|[^A-Za-z0-9])`) : null;
};

/** Which of the ticked proposals on the page are this proposal. */
function judgeTicked(panel, proposalNumber) {
  const re = tokenRegex(proposalNumber);
  const ticked = (panel.ticked || []).map((t) => ({ ...t, ours: !!re && (re.test(t.onclick || "") || re.test(t.rowText || "")) }));
  return { ticked, onlyOurs: ticked.length === 1 && ticked[0].ours, boxes: panel.proposalBoxes || 0 };
}

const optionsText = (options) =>
  options.length
    ? options.map((o) => `"${plain(o.label || o.value || o.id || "?")}"`).join(", ")
    : "none";

/* -------------------------------------------------------------------------- */
/* The flow                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pick the CDT option, enter the payable amount, press Add. Never throws except for a Breaker / stopper stop raised by
 * `checkpoint` (those travel up). Does NOT stop or fail the run itself — the form does, from the result.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {string}   o.proposalNumber
 * @param {boolean}  [o.selectionVerified]  the proposal was checked to be the only one ticked before Pay
 * @param {Function} [o.checkpoint]         (name) — the Breaker; called right before Add
 * @param {Function} [o.log]
 * @returns {Promise<{ok:true, paise:number, amount:string, rowsBefore:number, rowsAfter:number, dialogs:string[],
 *                    dialogButtons:string[], options:Object[], via:string, url:string, message:string}
 *                  |{ok:false, code:string, message:string, portalText?:string}>}
 */
async function payWithCdt(driver, o = {}) {
  const {
    proposalNumber = "",
    selectionVerified = false,
    checkpoint = () => {},
    log = () => {},
    sleep = (ms) => driver.sleep(ms),
    now = Date.now,
    panelWaitMs = 20000,
    amountWaitMs = 10000,
    pollMs = 500,
    settleMs = 1500,
    afterAddMs = 2000,
  } = o;
  const waitOpts = { pollMs, now, sleep };
  const alerts = []; // what native alerts said, in order
  const read = () => guarded(() => driver.executeScript(readPanelInPage, IDS), alerts, { retry: true });
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
  const proposal = proposalNumber ? `proposal ${plain(proposalNumber)}` : "the proposal";
  const nothing = "Nothing was entered or paid.";
  const notAdded = "Nothing was added to the payment details or paid."; // once the amount is in the box

  try {
    // 1. the payment panel (the radios of the login's payment options)
    const panel = await poll(async () => {
      const p = await read();
      return p && p.options && p.options.length ? p : null;
    }, { ...waitOpts, timeoutMs: panelWaitMs });
    if (!panel) {
      const last = (await read().catch(() => null)) || {};
      const types = (last.paymentTypeOptions || []).length
        ? ` The Payment Type list offers ${last.paymentTypeOptions.map((t) => `"${plain(t)}"`).join(", ")}.`
        : "";
      return fail(
        "NO_PANEL",
        `Reliance's payment options did not appear after Pay, so the CDT payment for ${proposal} was not made.${types} ${nothing}`
      );
    }
    log(`payment options on the page: ${optionsText(panel.options)}`);

    // 2. is the CDT option there, shown and usable
    const cdt = panel.options.find((x) => x.id === IDS.cdtRadio) || panel.options.find((x) => /^cdt$/i.test(x.value));
    if (!cdt || !cdt.shown || !cdt.enabled) {
      const others = panel.options.filter((x) => x !== cdt);
      const why = !cdt ? "does not have" : !cdt.shown ? "does not show" : "has disabled";
      return fail(
        "NO_CDT",
        `This Reliance login ${why} the CDT payment option, so the wallet payment for ${proposal} was not made. ` +
          `The payment options the page shows are ${optionsText(others)}. ${nothing} ` +
          `Ask Reliance to enable CDT for this login, or pay this proposal another way.`
      );
    }

    // 3. the right proposal, and only that one, is ticked. After Pay the list may be showing another page (Pending Quotes is
    //    paged), so "no ticked box in view" stands on the check made before Pay; ANOTHER proposal ticked never does.
    const judged = judgeTicked(panel, proposalNumber);
    if (judged.ticked.length > 0) {
      if (!judged.onlyOurs) {
        const found = judged.ticked.map((t) => `"${plain(t.id || t.onclick || "?")}"`).join(", ");
        return fail(
          "WRONG_PROPOSAL",
          `Reliance's Pending Quotes does not have only ${proposal} ticked (ticked now ${found}), so the CDT amount was ` +
            `not entered. ${nothing}`
        );
      }
    } else if (!selectionVerified) {
      return fail(
        "WRONG_PROPOSAL",
        `Which proposal is ticked could not be confirmed on the payment page, so the CDT amount for ${proposal} was not ` +
          `entered. ${nothing}`
      );
    }

    // 4. choose CDT, and see it chosen
    if (!cdt.checked) {
      await guarded(() => driver.executeScript(clickByIdInPage, cdt.id || IDS.cdtRadio), alerts);
      await sleep(settleMs);
    }
    const afterChoose = await poll(async () => {
      const p = await read();
      const c = (p.options || []).find((x) => x.id === IDS.cdtRadio || /^cdt$/i.test(x.value));
      return c && c.checked ? p : null;
    }, { ...waitOpts, timeoutMs: 5000 });
    if (!afterChoose) {
      return fail("CDT_NOT_SELECTED", `The CDT option was clicked for ${proposal} but the page did not show it chosen. ${nothing}`);
    }
    log("CDT option chosen");

    // 5. the payable amount and the CDT amount box
    const ready = await poll(async () => {
      const p = await read();
      const pay = payableOf(p);
      if (pay.conflict) return { conflict: pay.conflict, panel: p };
      if (pay.paise === null || pay.paise <= 0) return null;
      if (!(p.cdtDisplay && p.cdtDisplay.exists && p.cdtDisplay.shown)) return null;
      return { paise: pay.paise, panel: p };
    }, { ...waitOpts, timeoutMs: amountWaitMs });
    if (!ready) {
      const last = await read();
      const pay = payableOf(last);
      if (pay.paise === null || pay.paise <= 0) {
        return fail(
          "NO_AMOUNT",
          `Reliance did not show a payable amount for ${proposal} (the box reads "${plain(last.payableDisplay && last.payableDisplay.value)}"). ${nothing}`
        );
      }
      return fail("NO_CDT_FIELD", `The CDT amount box did not appear after choosing CDT for ${proposal}. ${nothing}`);
    }
    if (ready.conflict) {
      return fail(
        "NO_AMOUNT",
        `Reliance shows two different payable amounts for ${proposal} (${formatPaise(ready.conflict.shown)} and ` +
          `${formatPaise(ready.conflict.raw)}). ${nothing}`
      );
    }
    const paise = ready.paise;
    if (paise > MAX_PAYABLE_PAISE) {
      return fail(
        "NO_AMOUNT",
        `The payable amount Reliance shows for ${proposal} is ${formatPaise(paise)}, above the safety limit of ` +
          `${formatPaise(MAX_PAYABLE_PAISE)}. ${nothing}`
      );
    }
    log(`payable amount at Reliance: ${formatPaise(paise)}`);
    const baselineDialogs = new Set(ready.panel.dialogs || []);

    // 6. type the same amount, and read it back (typing first, the script way only if that did not take)
    const wanted = plainAmount(paise);
    let via = "typed";
    let entered = null;
    try {
      const box = await driver.findElement(By.id(IDS.cdtDisplay));
      try {
        await box.clear();
      } catch (e) {
        if (isStop(e) || isUnexpectedAlert(e)) throw e;
        /* a box that cannot be cleared is typed over */
      }
      await box.sendKeys(wanted);
      await guarded(() => box.sendKeys(Key.TAB), alerts); // the blur runs the page's onchange — it may raise an alert
      await sleep(settleMs);
      entered = enteredOf(await read());
    } catch (e) {
      if (isStop(e)) throw e;
      if (isUnexpectedAlert(e)) alerts.push(alertTextOf(e));
      else log(`typing into the CDT amount box did not work (${e && e.message})`);
    }
    // a refusal raised while typing: do not go on to a second way of putting the same amount in
    const refusedWhileTyping = alerts.find((w) => REFUSAL_WORDS.test(w));
    if (!refusedWhileTyping && (!entered || entered.paise !== paise)) {
      via = "script";
      await guarded(() => driver.executeScript(setAmountInPage, IDS, wanted), alerts);
      await sleep(settleMs);
      entered = enteredOf(await read());
    }
    if (refusedWhileTyping) {
      return fail(
        "PAGE_REFUSED",
        `Reliance said "${plain(refusedWhileTyping)}" when ${formatPaise(paise)} was entered in the CDT box for ${proposal}. ${notAdded}`,
        { portalText: refusedWhileTyping }
      );
    }
    if (entered.paise !== paise) {
      const shownText = plain(entered.shownText);
      return fail(
        "AMOUNT_MISMATCH",
        `The CDT amount box reads "${shownText}" after ${formatPaise(paise)} was entered for ${proposal}, so Add was not ` +
          `pressed. ${notAdded}`
      );
    }

    // 7. nothing refused it, and the payable amount is still the one that was entered
    const alertText = await takeAlertText(driver);
    const after = await read();
    const newDialogs = (after.dialogs || []).filter((d) => !baselineDialogs.has(d));
    const seenWords = [...alerts, alertText, ...newDialogs].filter(Boolean);
    const refusal = seenWords.find((w) => REFUSAL_WORDS.test(w));
    if (refusal) {
      return fail(
        "PAGE_REFUSED",
        `Reliance said "${plain(refusal)}" when ${formatPaise(paise)} was entered in the CDT box for ${proposal}. ${notAdded}`,
        { portalText: refusal }
      );
    }
    const shownWhileTyping = seenWords.filter((w) => !REFUSAL_WORDS.test(w)); // not a refusal: told, not acted on
    const nowPayable = payableOf(after);
    if (nowPayable.paise !== paise) {
      return fail(
        "AMOUNT_CHANGED",
        `The payable amount changed from ${formatPaise(paise)} to ${nowPayable.paise === null ? "an unreadable value" : formatPaise(nowPayable.paise)} ` +
          `while the CDT amount was entered for ${proposal}, so Add was not pressed. ${notAdded}`
      );
    }
    if (!(after.add && after.add.exists && after.add.shown && after.add.enabled)) {
      return fail("ADD_MISSING", `The Add button is not available on the payment page for ${proposal}. ${notAdded}`);
    }

    // 8. last look (Breaker), then Add — once
    checkpoint("wallet-cdt-add");
    const rowsBefore = after.rows;
    let addClicked = false;
    let clickError = "";
    const alertsBeforeAdd = alerts.length;
    try {
      const addButton = await driver.findElement(By.id(IDS.add));
      await addButton.click();
      addClicked = true;
    } catch (e) {
      if (isStop(e)) throw e;
      if (isUnexpectedAlert(e)) {
        // the click happened (it is what raised the alert): never press Add again
        alerts.push(alertTextOf(e));
        addClicked = true;
      } else {
        clickError = (e && e.message) || String(e);
      }
    }
    if (!addClicked) {
      // the click was refused before it happened; the script click only if the grid is unchanged
      const check = await read().catch(() => null);
      if (check && check.rows > rowsBefore) {
        addClicked = true;
      } else {
        await driver.executeScript(clickByIdInPage, IDS.add);
        addClicked = true;
      }
    }
    log(`Add pressed${clickError ? ` (by script — ${clickError})` : ""}`);
    await sleep(afterAddMs);

    // 9. what the page did
    const alertAfter = await takeAlertText(driver);
    const done = await read();
    const doneDialogs = (done.dialogs || []).filter((d) => !baselineDialogs.has(d));
    const wordsAfter = [...alerts.slice(alertsBeforeAdd), alertAfter, ...doneDialogs].filter(Boolean);
    const refusedAfter = wordsAfter.find((w) => REFUSAL_WORDS.test(w));
    if (refusedAfter) {
      return fail(
        "ADD_REFUSED",
        `Reliance said "${plain(refusedAfter)}" when Add was pressed for the CDT payment of ${formatPaise(paise)} for ` +
          `${proposal}. Nothing was paid.`,
        { portalText: refusedAfter }
      );
    }
    const earlier = shownWhileTyping.length
      ? ` When the amount was entered Reliance showed "${shownWhileTyping.map(plain).join(" | ")}".`
      : "";
    const note = earlier + (wordsAfter.length
      ? ` Reliance then showed "${wordsAfter.map(plain).join(" | ")}"${
          done.dialogButtons && done.dialogButtons.length ? ` with the buttons ${done.dialogButtons.map((b) => `"${plain(b)}"`).join(", ")}` : ""
        }.`
      : "");
    const message =
      `The CDT payment of ${formatPaise(paise)} for ${proposal} is entered and added to the payment details` +
      ` (${via === "typed" ? "typed" : "set by script"}, read back equal${
        done.rows !== rowsBefore ? `, the page has ${done.rows - rowsBefore > 0 ? "+" : ""}${done.rows - rowsBefore} table rows` : ""
      }).${note} It is not submitted and nothing was paid — waiting for the next step. The browser is left on the payment page.`;
    return {
      ok: true,
      paise,
      amount: formatPaise(paise),
      rowsBefore,
      rowsAfter: done.rows,
      // the rows' words right before and right after Add — the row Add put into the payment details is the difference
      rowTextsBefore: after.rowTexts || [],
      rowTextsAfter: done.rowTexts || [],
      dialogs: wordsAfter,
      dialogButtons: done.dialogButtons || [],
      options: panel.options,
      via,
      url: done.url,
      message,
    };
  } catch (e) {
    if (isStop(e)) throw e;
    return fail("WALLET", `The CDT payment for ${proposal} could not be made (${plain((e && e.message) || e)}). ${nothing}`);
  }
}

/**
 * The form's way in: run the flow, then END the run — a failure (PaymentStepError, with a screenshot from the failure
 * catch) or the wait after Add (a stop, with a screenshot attached). Never returns normally.
 *
 * @param {Object} o
 * @param {Object} o.driver
 * @param {Function} o.stop        (message, details) -> throws the automation stop (automationStopper.stopper)
 * @param {Function} [o.checkpoint]
 * @param {Function} [o.shot]      async (label) -> { url, key } — the screenshot, uploaded
 */
async function payWithCdtOrStop({ driver, proposalNumber, selectionVerified, checkpoint, log, stop, shot, ...rest } = {}) {
  const result = await payWithCdt(driver, { proposalNumber, selectionVerified, checkpoint, log, ...rest });
  if (!result.ok) throw new PaymentStepError(result.message, { code: result.code, portalText: result.portalText || "" });
  let picture = { url: null, key: null };
  if (shot) {
    try {
      picture = (await shot("cdt-added")) || picture;
    } catch (e) {
      /* the picture is a courtesy */
    }
  }
  stop(result.message, {
    stage: STAGE_ADDED,
    pageUrl: result.url,
    amountPaise: result.paise,
    screenshotUrl: picture.url || null,
    screenshotKey: picture.key || null,
  });
  throw new Error("payWithCdtOrStop: the stop did not stop"); // stop() always throws; this is a belt
}

/**
 * Wallet policies only: the proposal checkbox of THIS proposal in Pending Quotes — an exact token match, polled — or
 * null. The link path keeps its own (looser) search.
 */
async function waitForProposalCheckbox(driver, proposalNumber, { findInPage, timeoutMs = 15000, pollMs = 500, now = Date.now, sleep = (ms) => driver.sleep(ms) } = {}) {
  return poll(() => driver.executeScript(findInPage, proposalNumber), { timeoutMs, pollMs, now, sleep });
}

/** After the proposal was ticked: exactly one proposal is ticked and it is this one. */
async function readSelection(driver, proposalNumber) {
  const panel = await driver.executeScript(readPanelInPage, IDS);
  return { ...judgeTicked(panel, proposalNumber), url: panel.url };
}

module.exports = {
  isStop,
  poll,
  guarded,
  takeAlertText,
  isUnexpectedAlert,
  alertTextOf,
  IDS,
  STAGE_ADDED,
  MAX_PAYABLE_PAISE,
  REFUSAL_WORDS,
  parseRupees,
  formatPaise,
  plainAmount,
  readPanelInPage,
  clickByIdInPage,
  setAmountInPage,
  PaymentStepError,
  payableOf,
  enteredOf,
  judgeTicked,
  payWithCdt,
  payWithCdtOrStop,
  waitForProposalCheckbox,
  readSelection,
};
