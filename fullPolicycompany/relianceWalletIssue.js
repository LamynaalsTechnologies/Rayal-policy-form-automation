/**
 * Reliance — after the CDT row is added: Submit Details, the policy number, the policy PDF, saved on the policy.
 *
 * Until now a wallet policy stopped right after Add ("reliance-wallet-cdt-added", relianceWalletCdt.js). With
 * RELIANCE_WALLET_SUBMIT_ENABLED (default on) the run goes on:
 *
 *   0. GATE (checkSubmitGate, start of the run, before any browser) — a payment that was already submitted for this policy
 *      is never run again by itself: the policy carries a `walletPayment` note, and a run that finds it refuses.
 *   1. the CDT amount is entered and added (payWithCdt, unchanged), then the row Add put into the payment-details table is
 *      checked: new, the exact amount to the paisa, only once. A Submit Details button that is shown and enabled, and no
 *      message of Reliance's open on the page.
 *   2. the note `walletPayment.state = "submit-pressed"` is written FIRST (a guarded write: it fails when a note that
 *      blocks is already there) — if it cannot be written, Submit Details is not pressed.
 *   3. Submit Details is pressed ONCE. Never again, whatever happens next.
 *   4. the answer is waited for (the page loads): the "Payment Success" page and the policy number in its schedule link,
 *      or a refusal, or nothing certain — which is an `unconfirmed` payment that blocks like a successful one.
 *   5. the policy number is saved at once, on the online policy and on the `policy` record (before the PDF is touched).
 *   6. the policy PDF: the schedule link is clicked (on the live portal it only opens a page — a short wait); then View
 *      Policy, opened by ADDRESS (the menu link's own href, then /Policy/ViewPolicySearch — a hover on a page whose scripts
 *      failed opens nothing), the search option "Policy Number", the number, Search, the number's own row. A PDF that is not
 *      obtained either way is an ERROR.
 *   7. the PDF is uploaded to the Policy folder of the bucket (permanent — no lifecycle rule) and set as the policy's
 *      `policyFile`; the run then CONTINUES to the Brisk / merge steps and the policy is completed.
 *
 * A policy that is `issued` but whose PDF was never stored (the run ended there) is FINISHED by a re-run
 * (recoverIssuedPolicyPdf): no form, no Submit, nothing is paid — only the PDF from View Policy, then the normal completion
 * steps. Every other blocking state still refuses (RELIANCE_WALLET_RECOVER_ENABLED=false makes `issued` refuse too).
 *
 * It really pays (a CDT debit, the policy goes live), so it refuses rather than guesses and says exactly what is known:
 *   - amounts are whole PAISE; the added row must show the amount to the paisa; nothing is pressed on a doubt;
 *   - Submit Details is pressed at most once per policy, guarded by a database write made BEFORE the press;
 *   - an unknown outcome blocks re-runs exactly like a successful one ("the customer is not charged twice");
 *   - a number or file is never written onto a record that is not certainly this policy's.
 *
 * Messages carry no colon outside the portal's own quoted words (beautifyError keeps only what follows the last colon).
 *
 * Everything takes the driver, the clock, the database client, the file system and the uploader as arguments, so it is
 * tested with fakes. Used by relianceForm.js and, being shared, by the Reliance OD / TP copy.
 */
const fs = require("fs");
const path = require("path");
const { By } = require("selenium-webdriver");
require("dotenv").config({ quiet: true });
const { plain, sniffDocumentBytes } = require("./relianceKycSubmit");
const cdt = require("./relianceWalletCdt");
const { isWalletSubmitEnabled } = require("./relianceWalletHold");

const { PaymentStepError, parseRupees, formatPaise, REFUSAL_WORDS } = cdt;

/** The page's own ids (from the elements Karthi pasted, and the View Policy step the KYC flow already walks). */
const IDS = {
  submit: "btnPaymentSubmit",
  utility: "divMainUtility",
  searchText: "txtSearchText",
  searchButton: "btnViewPolicySearch",
};

/** The page the KYC step already reaches through Utilities -> View Policy (seen in the job browser's history). */
const VIEW_POLICY_PATH = "/Policy/ViewPolicySearch";

const STATES = {
  PRESSED: "submit-pressed",
  ISSUED: "issued",
  FAILED: "failed",
  UNCONFIRMED: "unconfirmed",
};

/** A note in one of these states stops the policy from being run again (a payment may have been taken). */
const BLOCKING_STATES = [STATES.PRESSED, STATES.ISSUED, STATES.UNCONFIRMED];

const TIMING = {
  rowWaitMs: 10000,
  dialogWaitMs: 4000,
  resultWaitMs: 120000,
  pollMs: 1000,
  refusalGraceMs: 5000,
  afterClickMs: 1500,
  linkWaitMs: 20000,
  pdfWaitMs: 60000,
  pdfPollMs: 500,
  pdfStableMs: 1500,
  menuWaitMs: 10000,
  searchPageWaitMs: 20000,
  searchResultWaitMs: 30000,
  settleMs: 1000,
};

const isBlockingState = (state) => BLOCKING_STATES.includes(String(state == null ? "" : state));

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

/** The policy number as the policy model stores it — spaces removed, upper-case. */
const normalisePolicyNumber = (value) => String(value == null ? "" : value).replace(/\s+/g, "").toUpperCase();

/**
 * Does this look like an issued policy number? Letters, digits, - and / only; 8-30 characters; at least 6 digits; not our
 * own placeholder (OP...) and not the proposal number.
 */
function isPlausiblePolicyNumber(value, proposalNumber = "") {
  const n = normalisePolicyNumber(value);
  if (!/^[A-Z0-9][A-Z0-9\-/]{6,28}[A-Z0-9]$/.test(n)) return false;
  if ((n.match(/\d/g) || []).length < 6) return false;
  if (/^OP\d/.test(n)) return false;
  const proposal = normalisePolicyNumber(proposalNumber);
  if (proposal && n === proposal) return false;
  return true;
}

/** `policyNo=` of a schedule link, decoded and normalised ("" when there is none). */
function policyNumberFromHref(href) {
  const m = String(href == null ? "" : href).match(/[?&]policyNo=([^&#]*)/i);
  if (!m) return "";
  let value = m[1];
  try {
    value = decodeURIComponent(value.replace(/\+/g, " "));
  } catch (e) {
    /* keep the raw text */
  }
  return normalisePolicyNumber(value);
}

/** Every plain rupee amount a text holds, as whole paise ("CDT 6,268.00 R141026125974" -> [626800, ...]). */
function amountsIn(text) {
  const found = [];
  for (const token of String(text == null ? "" : text).match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const paise = parseRupees(token);
    if (paise !== null) found.push(paise);
  }
  return found;
}

/** Rows present after but not before (as a multiset: a second identical row counts as new). */
function diffRows(before, after) {
  const count = new Map();
  for (const t of before || []) count.set(t, (count.get(t) || 0) + 1);
  const added = [];
  for (const t of after || []) {
    const c = count.get(t) || 0;
    if (c > 0) count.set(t, c - 1);
    else added.push(t);
  }
  return added;
}

/**
 * The row(s) Add put into the payment-details table: new since before Add, showing the amount to the paisa. Rows that say
 * CDT are preferred; a single new row with the exact amount that does not say CDT is accepted and flagged.
 * `duplicated` = the same row is there more than once (Add pressed twice) — a refusal.
 */
function addedCdtRows(before, after, paise) {
  const added = diffRows(before, after);
  const withAmount = added.filter((t) => amountsIn(t).includes(paise));
  const withCdt = withAmount.filter((t) => /\bCDT\b/i.test(t));
  let matching = withCdt;
  let cdtWordMissing = false;
  if (!withCdt.length && withAmount.length === 1) {
    matching = withAmount;
    cdtWordMissing = true;
  }
  const duplicated = matching.some((t, i) => matching.indexOf(t) !== i);
  return { added, matching, duplicated, cdtWordMissing };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14 Oct 2026 14.32" — no colon (beautifyError). */
function whenText(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "an unknown time";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

/**
 * The field of the online policy that holds the note. One per policy — and one per PART of a multi-company policy, so an
 * OD part's payment never blocks (or overwrites) a TP part's. The bundled "motor" part is the policy's own.
 */
function markerFieldFor(data) {
  const key = String((data && data._partKey) || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return key && key !== "motor" ? `walletPayment_${key}` : "walletPayment";
}

/** The S3 object of a policy PDF — the backend's own convention (getFileName + the "Policy" folder, uploads of the app). */
function policyFileNames(now = new Date(), random = Math.random) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let rand = "";
  for (let i = 0; i < 9; i++) rand += chars.charAt(Math.floor(random() * chars.length));
  const date = now.getDate().toString() + (now.getMonth() + 1).toString() + now.getFullYear().toString();
  const fileName = `${date}-${rand}-Policy.pdf`;
  return { fileName, key: `Policy/${fileName}` };
}

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises their source)             */
/* -------------------------------------------------------------------------- */

/**
 * The payment page, then the Payment Success page after Submit Details — one read of what matters: the Submit button, the
 * table rows, dialogs, the loading mask, the schedule link(s) and the page's own words. Reads only — touches nothing.
 */
function readIssuePageInPage(ids) {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function text(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }
  var i;
  var out = { url: String(window.location.href), title: String(document.title || "") };

  var btn = document.getElementById(ids.submit);
  out.submit = { exists: !!btn, shown: shown(btn), enabled: !!btn && !btn.disabled };

  var trs = document.querySelectorAll("tr");
  out.rowTexts = [];
  for (i = 0; i < trs.length && out.rowTexts.length < 400; i++) {
    var tr = trs[i];
    if (tr.querySelector && tr.querySelector("tr")) continue;
    var rowText = text(tr);
    if (rowText) out.rowTexts.push(rowText.slice(0, 200));
  }

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

  out.loading = false;
  var masks = document.querySelectorAll(".k-loading-mask");
  for (i = 0; i < masks.length; i++) if (shown(masks[i])) out.loading = true;

  out.links = [];
  var anchors = document.querySelectorAll("a[href]");
  for (i = 0; i < anchors.length && out.links.length < 20; i++) {
    var href = String(anchors[i].getAttribute("href") || "");
    if (!/GenerateMotorSchedule/i.test(href)) continue;
    out.links.push({ href: String(anchors[i].href || href), text: text(anchors[i]).slice(0, 80), shown: shown(anchors[i]) });
  }

  var words = String((document.body && (document.body.innerText || document.body.textContent)) || "")
    .replace(/\s+/g, " ")
    .trim();
  out.success =
    /payment\s+(?:was\s+|is\s+|has\s+been\s+)?(?:done\s+)?successful/i.test(words) || /has\s+been\s+made\s+live/i.test(words);
  out.policyNoTexts = [];
  var policyRe = /Policy\s*(?:No\.?|Number)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]{5,29})/gi;
  var m;
  while ((m = policyRe.exec(words)) && out.policyNoTexts.length < 5) out.policyNoTexts.push(m[1]);
  var tm = words.match(/Transaction\s*(?:No\.?|Number|Id)\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\/\-]{3,39})/i);
  out.transactionNo = tm ? tm[1] : "";
  out.excerpt = words.slice(0, 300);
  return out;
}

/**
 * The View Policy search page: the Kendo dropdowns (current text and the list's items), the text inputs, the Search
 * buttons and the result links. Every element worth acting on gets a data-rwi token so the next step finds exactly it.
 */
function readViewPolicyInPage(ids) {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function text(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  }
  var i;
  var j;
  var out = { url: String(window.location.href), loading: false, dropdowns: [], inputs: [], buttons: [], links: [], noRecords: false };

  var masks = document.querySelectorAll(".k-loading-mask");
  for (i = 0; i < masks.length; i++) if (shown(masks[i])) out.loading = true;

  var wraps = document.querySelectorAll(".k-dropdown-wrap");
  for (i = 0; i < wraps.length && out.dropdowns.length < 20; i++) {
    var wrap = wraps[i];
    var widget = wrap.closest ? wrap.closest(".k-dropdown") : null;
    var owner = (widget && widget.getAttribute("aria-owns")) || "";
    if (!owner) {
      var withOwns = (widget || wrap).querySelector("[aria-owns]");
      if (withOwns) owner = withOwns.getAttribute("aria-owns") || "";
    }
    var items = [];
    var list = owner ? document.getElementById(owner) : null;
    if (list) {
      var lis = list.querySelectorAll("li");
      for (j = 0; j < lis.length && j < 60; j++) {
        var item = text(lis[j]);
        if (item) items.push(item.slice(0, 60));
      }
    }
    var token = "dd-" + i;
    wrap.setAttribute("data-rwi", token);
    var current = wrap.querySelector(".k-input");
    out.dropdowns.push({ token: token, current: current ? text(current) : "", listId: owner, items: items, shown: shown(wrap) });
  }

  var boxes = document.querySelectorAll("input");
  for (i = 0; i < boxes.length && out.inputs.length < 40; i++) {
    var box = boxes[i];
    var type = String(box.getAttribute("type") || "text").toLowerCase();
    if (type !== "text" && type !== "search" && type !== "tel" && type !== "number") continue;
    if (box.closest && box.closest(".k-dropdown, .k-combobox, .k-datepicker")) continue;
    var boxToken = "in-" + i;
    box.setAttribute("data-rwi", boxToken);
    out.inputs.push({
      token: boxToken,
      id: box.id || "",
      name: String(box.getAttribute("name") || ""),
      value: String(box.value || ""),
      shown: shown(box),
      enabled: !box.disabled && !box.readOnly,
    });
  }

  var controls = document.querySelectorAll("input[type='button'], input[type='submit'], button, a");
  for (i = 0; i < controls.length && out.buttons.length < 20; i++) {
    var control = controls[i];
    var controlLabel = text(control) || String(control.value || "").trim();
    var isSearch = /^search$/i.test(controlLabel) || control.id === ids.searchButton;
    if (!isSearch) continue;
    var controlToken = "bt-" + i;
    control.setAttribute("data-rwi", controlToken);
    out.buttons.push({
      token: controlToken,
      id: control.id || "",
      label: controlLabel.slice(0, 40),
      shown: shown(control),
      enabled: !control.disabled,
    });
  }

  var anchors = document.querySelectorAll("a");
  for (i = 0; i < anchors.length && out.links.length < 60; i++) {
    var a = anchors[i];
    var href = String(a.getAttribute("href") || "");
    var inGrid = !!(a.closest && a.closest("td[role='gridcell']"));
    if (!inGrid && !/GenerateShedule|GenerateSchedule|GenerateMotorSchedule/i.test(href)) continue;
    var linkToken = "lk-" + i;
    a.setAttribute("data-rwi", linkToken);
    out.links.push({ token: linkToken, text: text(a).slice(0, 60), href: href.slice(0, 200), shown: shown(a), inGrid: inGrid });
  }

  var words = String((document.body && (document.body.innerText || document.body.textContent)) || "")
    .replace(/\s+/g, " ")
    .trim();
  out.noRecords = /no\s+(?:records?|data|results?)\s+(?:found|available|to display)|no\s+items\s+to\s+display/i.test(words);
  return out;
}

/**
 * The address of the menu's "View Policy" link, read from the page whether or not its submenu is open (a hover on a page
 * whose scripts failed opens nothing, but the link is in the page). "" when there is none.
 */
function findViewPolicyHrefInPage() {
  var anchors = document.querySelectorAll("a[href]");
  for (var i = 0; i < anchors.length; i++) {
    var label = String(anchors[i].innerText || anchors[i].textContent || "").replace(/\s+/g, " ").trim();
    if (!/^view policy$/i.test(label)) continue;
    var raw = String(anchors[i].getAttribute("href") || "").trim();
    if (!raw || raw === "#" || /^javascript:/i.test(raw)) continue;
    return String(anchors[i].href || raw);
  }
  return "";
}

/** The page's own search, run again (read-only): GetPolicySearchDetails() is what the Search button calls. */
function runPolicySearchInPage() {
  if (typeof window.GetPolicySearchDetails === "function") {
    window.GetPolicySearchDetails();
    return true;
  }
  return false;
}

/** The script way of choosing an item in a Kendo DropDownList, when clicking the list did not take. */
function selectKendoOptionInPage(listId, label) {
  var id = String(listId || "").replace(/_listbox$/, "");
  var jq = window.jQuery || window.$;
  if (!id || !jq) return { done: false, why: "no jQuery or no widget id" };
  var widget = jq("#" + id).data("kendoDropDownList");
  if (!widget) return { done: false, why: "no Kendo dropdown with the id " + id };
  var field = (widget.options && widget.options.dataTextField) || "";
  function itemText(item) {
    if (item && typeof item === "object") return String(item[field] || item.text || item.Text || "");
    return String(item == null ? "" : item);
  }
  widget.select(function (item) {
    return itemText(item).replace(/\s+/g, " ").trim().toLowerCase() === String(label).toLowerCase();
  });
  widget.trigger("change");
  return { done: true, text: String(widget.text() || "") };
}

/* -------------------------------------------------------------------------- */
/* The note and the saves — the database                                      */
/* -------------------------------------------------------------------------- */

/** Open the database for one piece of work and close it again (the way every other save of the forms does). */
async function withDb(MongoClient, work, { uri = process.env.MONGODB_URI } = {}) {
  const Client = MongoClient || require("mongodb").MongoClient;
  const client = new Client(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db();
    return await work({ onlinePolicy: db.collection("onlinePolicy"), policy: db.collection("policy") });
  } finally {
    await client.close().catch(() => {});
  }
}

/** What the operator reads when a run is refused because a payment was already submitted. */
function gateMessage(marker = {}) {
  const proposal = marker.proposalNumber ? `proposal ${plain(marker.proposalNumber)}, ` : "";
  const amount = Number.isInteger(marker.amountPaise) ? `CDT ${formatPaise(marker.amountPaise)}, ` : "";
  const when = marker.at ? `on ${whenText(marker.at)}, ` : "";
  const outcome =
    marker.state === STATES.ISSUED
      ? "and the policy was issued"
      : marker.state === STATES.UNCONFIRMED
      ? "and Reliance's answer was never confirmed"
      : "and its result was never recorded";
  const number = marker.policyNumber ? ` The policy number is ${plain(marker.policyNumber)}.` : "";
  return (
    `A CDT payment was already submitted for this policy at Reliance (${proposal}${amount}${when}state ${plain(marker.state)}) ` +
    `${outcome}.${number} This run was not started so the customer is not charged twice. Check the policy at Reliance, ` +
    `then clear the ${plain(marker.field || "walletPayment")} note on the online policy before running it again.`
  );
}

/**
 * The policy number of a policy the gate found `issued` — "" when the gate did not find that, or the note carries no
 * plausible number. Such a policy is not refused: its PDF is what is left (recoverIssuedPolicyPdf).
 */
function issuedNumberOf(gate, proposalNumber = "") {
  if (!gate || !gate.blocked || gate.state !== STATES.ISSUED || !gate.marker) return "";
  const n = normalisePolicyNumber(gate.marker.policyNumber);
  return isPlausiblePolicyNumber(n, proposalNumber) ? n : "";
}

/**
 * What the gate's answer means for this run.
 *   go      — nothing blocks, the run is the normal one
 *   recover — the policy was ISSUED: its payment is done and only the PDF is left (recoverIssuedPolicyPdf)
 *   refuse  — a payment may already have been taken (submit-pressed / unconfirmed, or issued without a usable number, or
 *             recovery switched off): the run is not started, the customer is not charged twice
 */
function decideAfterGate(gate, { recoverEnabled = true, proposalNumber = "" } = {}) {
  if (!gate || !gate.blocked) return { action: "go" };
  const number = recoverEnabled ? issuedNumberOf(gate, proposalNumber) : "";
  if (number) return { action: "recover", number, marker: gate.marker };
  return { action: "refuse", message: gate.message || "" };
}

/**
 * The start-of-run gate: is a payment already submitted for this policy? Reads only. Never throws — when the note cannot
 * be read the run goes on and the guarded write right before Submit Details decides.
 *
 * @returns {Promise<{blocked:boolean, state?:string, marker?:Object, message?:string, unknown?:boolean, error?:string}>}
 */
async function checkSubmitGate(data = {}, jobId = "", { MongoClient } = {}) {
  const policyId = data && (data._id || data.policyId);
  if (!policyId) return { blocked: false, note: "no policy id on the job" };
  const field = markerFieldFor(data);
  try {
    const marker = await withDb(MongoClient, async ({ onlinePolicy }) => {
      const doc = await onlinePolicy.findOne({ _id: policyId }, { projection: { [field]: 1 } });
      return doc && doc[field] ? doc[field] : null;
    });
    if (marker && isBlockingState(marker.state)) {
      return { blocked: true, state: marker.state, marker, message: gateMessage({ ...marker, field }) };
    }
    return { blocked: false, state: marker ? marker.state : null, marker };
  } catch (e) {
    console.warn(`[${jobId}] ⚠️ Could not read the wallet payment note (${e && e.message}) — the check right before Submit Details decides.`);
    return { blocked: false, unknown: true, error: (e && e.message) || String(e) };
  }
}

/**
 * The saves of the issue step, over the raw driver (like saveKycUrls / saveProcessLinks). Each call opens and closes its
 * own connection; each returns what happened instead of throwing, except where noted.
 */
function createIssueStore({ MongoClient, field = "walletPayment", policyId } = {}) {
  return {
    field,

    /** The guarded write BEFORE the press: only when no blocking note is there. {matched, modified} or throws. */
    async claim(marker) {
      return withDb(MongoClient, async ({ onlinePolicy }) => {
        const result = await onlinePolicy.updateOne(
          { _id: policyId, [`${field}.state`]: { $nin: BLOCKING_STATES } },
          { $set: { [field]: marker, updatedAt: new Date() } }
        );
        return { matched: result.matchedCount, modified: result.modifiedCount };
      });
    },

    /** The note as it is now: {found, marker}. */
    async readNote() {
      return withDb(MongoClient, async ({ onlinePolicy }) => {
        const doc = await onlinePolicy.findOne({ _id: policyId }, { projection: { [field]: 1 } });
        return { found: !!doc, marker: doc && doc[field] ? doc[field] : null };
      });
    },

    /** The policyFile key already on a policy record, or "" (read only; "" also when it cannot be read). */
    async policyFileKey(policyDocId) {
      if (!policyDocId) return "";
      try {
        return await withDb(MongoClient, async ({ policy }) => {
          const doc = await policy.findOne({ _id: policyDocId }, { projection: { policyFile: 1 } });
          return doc && doc.policyFile && doc.policyFile.key ? String(doc.policyFile.key) : "";
        });
      } catch (e) {
        return "";
      }
    },

    /** Move the note on (state, policy number ...). Returns whether it matched; never throws. */
    async outcome(patch) {
      try {
        return await withDb(MongoClient, async ({ onlinePolicy }) => {
          const set = { updatedAt: new Date() };
          for (const [k, v] of Object.entries(patch)) set[`${field}.${k}`] = v;
          const result = await onlinePolicy.updateOne({ _id: policyId }, { $set: set });
          return { ok: result.matchedCount === 1 };
        });
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
    },

    /**
     * The issued policy number onto the online policy and the `policy` record. First writer wins: a different number
     * already there is reported, never replaced. Returns {onlinePolicy, policy, warnings[], policyDocId}; never throws.
     */
    async saveNumber(number) {
      const warnings = [];
      const out = { onlinePolicy: "not-saved", policy: "not-saved", warnings, policyDocId: null };
      try {
        await withDb(MongoClient, async ({ onlinePolicy, policy }) => {
          const op = await onlinePolicy.findOne(
            { _id: policyId },
            { projection: { policyId: 1, clientId: 1, policyNumber: 1, mergedPolicyPdf: 1 } }
          );
          if (!op) {
            warnings.push("the online policy could not be found to save the policy number on it");
            return;
          }
          const there = normalisePolicyNumber(op.policyNumber);
          if (!there || there === number) {
            const r = await onlinePolicy.updateOne({ _id: policyId }, { $set: { policyNumber: number, updatedAt: new Date() } });
            out.onlinePolicy = r.matchedCount === 1 ? (there === number ? "already" : "saved") : "not-saved";
          } else {
            out.onlinePolicy = "other-number";
            warnings.push(`the online policy already holds the policy number ${plain(there)}, so ${plain(number)} was not saved on it`);
          }

          const placeholder = normalisePolicyNumber(op.policyId);
          const filter = {
            isOnlinePolicy: true,
            policyNumber: { $in: [placeholder, number].filter(Boolean) },
          };
          if (op.clientId !== undefined && op.clientId !== null && String(op.clientId)) filter.clientId = String(op.clientId);
          const docs = await policy.find(filter, { projection: { _id: 1, policyNumber: 1, policyFile: 1 } }).toArray();
          if (docs.length === 0) {
            out.policy = "not-found";
            warnings.push(
              `no policy record of this online policy was found in the policy collection (looked for ${plain(placeholder || "?")} or ${plain(number)})`
            );
            return;
          }
          if (docs.length > 1) {
            out.policy = "ambiguous";
            warnings.push(`${docs.length} policy records match this online policy, so none was changed`);
            return;
          }
          const doc = docs[0];
          out.policyDocId = doc._id;
          if (normalisePolicyNumber(doc.policyNumber) === number) {
            out.policy = "already";
            return;
          }
          if (normalisePolicyNumber(doc.policyNumber) !== placeholder) {
            out.policy = "other-number";
            warnings.push(`the policy record already holds the policy number ${plain(doc.policyNumber)}, so ${plain(number)} was not saved on it`);
            return;
          }
          try {
            const r = await policy.updateOne({ _id: doc._id }, { $set: { policyNumber: number, updatedAt: new Date() } });
            out.policy = r.matchedCount === 1 ? "saved" : "not-saved";
          } catch (e) {
            if (e && e.code === 11000) {
              out.policy = "duplicate";
              warnings.push(`another policy record of this client already holds the policy number ${plain(number)}, so it was not saved on this one`);
            } else {
              throw e;
            }
          }
        });
      } catch (e) {
        warnings.push(`the policy number could not be saved (${plain((e && e.message) || e)})`);
      }
      return out;
    },

    /**
     * The stored PDF onto the policy record (`policyFile`, when empty) and the online policy (`mergedPolicyPdf`, when
     * empty — the merge step replaces it when it runs). Returns {policy, onlinePolicy, warnings[]}; never throws.
     */
    async savePdf({ fileName, key, location }, policyDocId) {
      const warnings = [];
      const out = { policy: "not-saved", onlinePolicy: "not-saved", warnings };
      const file = { fileName, key, location };
      try {
        await withDb(MongoClient, async ({ onlinePolicy, policy }) => {
          if (policyDocId) {
            const doc = await policy.findOne({ _id: policyDocId }, { projection: { policyFile: 1 } });
            if (doc && doc.policyFile && doc.policyFile.key) {
              out.policy = doc.policyFile.key === key ? "already" : "kept-other";
              if (out.policy === "kept-other") warnings.push("the policy record already has a policy file, so the downloaded PDF was not set as its policyFile");
            } else {
              const r = await policy.updateOne({ _id: policyDocId }, { $set: { policyFile: file, updatedAt: new Date() } });
              out.policy = r.matchedCount === 1 ? "saved" : "not-saved";
              if (out.policy === "not-saved") warnings.push("the policy record disappeared before its policyFile could be saved");
            }
          } else {
            warnings.push("the PDF is stored but could not be set as the policyFile because the policy record was not found");
          }
          const op = await onlinePolicy.findOne({ _id: policyId }, { projection: { mergedPolicyPdf: 1 } });
          if (op && !(op.mergedPolicyPdf && op.mergedPolicyPdf.key)) {
            const r = await onlinePolicy.updateOne({ _id: policyId }, { $set: { mergedPolicyPdf: file, updatedAt: new Date() } });
            out.onlinePolicy = r.matchedCount === 1 ? "saved" : "not-saved";
          } else if (op) {
            out.onlinePolicy = "kept-other";
          }
        });
      } catch (e) {
        warnings.push(`the PDF could not be recorded on the policy (${plain((e && e.message) || e)})`);
      }
      return out;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the answer                                                         */
/* -------------------------------------------------------------------------- */

const SUCCESS_WORDS = /success|issued|made\s+live|generated|has\s+been\s+made|completed/i;

/**
 * What one read of the page after Submit Details says. Pure.
 *   success  — a schedule link carrying one plausible policy number, consistent with the page's own words
 *   conflict — numbers that contradict each other (nothing is saved on a doubt)
 *   pending  — nothing certain yet; `refusal` holds the words of a refusal seen (alert / dialog), `successWords` whether
 *              the page says the payment worked
 */
function classifyIssuePage(page, { alerts = [], proposalNumber = "" } = {}) {
  const numbers = new Set();
  for (const link of (page && page.links) || []) {
    const n = policyNumberFromHref(link.href);
    if (n) numbers.add(n);
  }
  if (numbers.size > 1) {
    return { kind: "conflict", why: `the page's schedule links name different policy numbers (${[...numbers].map(plain).join(" and ")})` };
  }
  if (numbers.size === 1) {
    const [number] = [...numbers];
    if (!isPlausiblePolicyNumber(number, proposalNumber)) {
      return { kind: "conflict", why: `the policy number in the page's link ("${plain(number)}") does not look like a policy number` };
    }
    const texts = ((page && page.policyNoTexts) || []).map(normalisePolicyNumber).filter((t) => isPlausiblePolicyNumber(t, proposalNumber));
    if (texts.length && !texts.includes(number)) {
      return { kind: "conflict", why: `the page's text names policy ${plain(texts[0])} but its link names ${plain(number)}` };
    }
    return {
      kind: "success",
      policyNumber: number,
      transactionNo: String((page && page.transactionNo) || "").trim(),
      successText: !!(page && page.success),
      confirmedByText: texts.includes(number),
      linkText: String((page.links[0] && page.links[0].text) || ""),
    };
  }
  const words = [...(alerts || []), ...(((page && page.dialogs) || []))].filter(Boolean);
  const refusal = words.find((w) => REFUSAL_WORDS.test(w) && !SUCCESS_WORDS.test(w)) || "";
  const successWords = !!(page && page.success) || words.some((w) => SUCCESS_WORDS.test(w));
  return { kind: "pending", refusal, successWords, words };
}

/** Is the page the portal's login (the session was lost)? */
const isLoginUrl = (url) => /\/(?:Login|IMDLogin)\b/i.test(String(url || ""));

/**
 * Wait for Reliance's answer to Submit Details: success (the policy number), a refusal that stays, or nothing certain.
 * Never throws except for a Breaker / stopper stop.
 */
async function awaitIssueResult(driver, { alerts = [], proposalNumber = "", timeoutMs, pollMs, graceMs, now, sleep, log, handlesBefore = null }) {
  const seen = [...alerts];
  const started = now();
  let refusal = null; // { words, since }
  let last = null;
  let onLogin = 0;
  let followed = null;
  for (;;) {
    // the answer may open in a window of its own — the one the press opened is the one to read
    if (handlesBefore) {
      try {
        const handles = await driver.getAllWindowHandles();
        const opened = handles.filter((h) => !handlesBefore.includes(h));
        const newest = opened[opened.length - 1];
        if (newest && newest !== followed) {
          await driver.switchTo().window(newest);
          followed = newest;
          log("Reliance opened its answer in a new window — reading that one");
        }
      } catch (e) {
        if (cdt.isStop(e)) throw e;
      }
    }
    let page = null;
    try {
      page = await driver.executeScript(readIssuePageInPage, IDS);
    } catch (e) {
      if (cdt.isStop(e)) throw e;
      if (cdt.isUnexpectedAlert(e)) {
        const words = cdt.alertTextOf(e);
        seen.push(words);
        log(`Reliance showed the alert "${plain(words)}"`);
      }
      // anything else: the page is changing under the read — read again
    }
    const open = await cdt.takeAlertText(driver);
    if (open) {
      seen.push(open);
      log(`Reliance showed the alert "${plain(open)}"`);
    }
    if (page) {
      last = page;
      const verdict = classifyIssuePage(page, { alerts: seen, proposalNumber });
      if (verdict.kind === "success" || verdict.kind === "conflict") return { ...verdict, page, alerts: seen };
      if (isLoginUrl(page.url)) {
        onLogin += 1;
        if (onLogin >= 2) return { kind: "lost-session", page, alerts: seen };
      } else {
        onLogin = 0;
      }
      if (verdict.refusal) {
        if (!refusal || refusal.words !== verdict.refusal) refusal = { words: verdict.refusal, since: now() };
      }
      const stillPayPage = !!(page.submit && page.submit.exists && page.submit.shown);
      if (refusal && !page.loading && !verdict.successWords && stillPayPage && now() - refusal.since >= graceMs) {
        return { kind: "failed", words: refusal.words, page, alerts: seen };
      }
    }
    if (now() - started >= timeoutMs) return { kind: "timeout", page: last, alerts: seen, refusal: refusal ? refusal.words : "" };
    await sleep(pollMs);
  }
}

/* -------------------------------------------------------------------------- */
/* The PDF                                                                    */
/* -------------------------------------------------------------------------- */

const PARTIAL_DOWNLOAD = /\.(?:crdownload|tmp|part)$|^\.com\.google\.Chrome\./i;

/** The files of a folder as {name, size, mtimeMs}; [] when it cannot be read. */
function listFiles(dir, fsImpl = fs) {
  try {
    return fsImpl
      .readdirSync(dir)
      .map((name) => {
        try {
          const st = fsImpl.statSync(path.join(dir, name));
          return st.isFile() ? { name, size: st.size, mtimeMs: st.mtimeMs } : null;
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** The first bytes and the last bytes of a file. */
function readEnds(filePath, size, fsImpl = fs) {
  const fd = fsImpl.openSync(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(1024, size));
    fsImpl.readSync(fd, head, 0, head.length, 0);
    const tailLength = Math.min(1024, size);
    const tail = Buffer.alloc(tailLength);
    fsImpl.readSync(fd, tail, 0, tailLength, Math.max(0, size - tailLength));
    return { head, tail };
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * Wait for a NEW finished PDF in the job's download folder: not there (or different) in `before`, no Chrome download
 * still in progress, its size unchanged for `stableMs`, and its first bytes really are a PDF.
 *
 * @returns {Promise<{ok:true, path:string, name:string, size:number, truncated:boolean}
 *                  |{ok:false, reason:"timeout"|"not-pdf", detail:string}>}
 */
async function waitForDownloadedPdf({ dir, before = [], timeoutMs, pollMs = 500, stableMs = 1500, now = Date.now, sleep, fsImpl = fs }) {
  const was = new Map(before.map((f) => [f.name, f]));
  const isNew = (f) => {
    const old = was.get(f.name);
    return !old || old.size !== f.size || old.mtimeMs !== f.mtimeMs;
  };
  const started = now();
  let candidate = null;
  let notPdf = "";
  for (;;) {
    const files = listFiles(dir, fsImpl);
    const partial = files.some((f) => PARTIAL_DOWNLOAD.test(f.name));
    const fresh = files
      .filter((f) => !PARTIAL_DOWNLOAD.test(f.name) && f.size > 0 && isNew(f))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (fresh.length && !partial) {
      const f = fresh[0];
      if (candidate && candidate.name === f.name && candidate.size === f.size) {
        if (now() - candidate.since >= stableMs) {
          const full = path.join(dir, f.name);
          try {
            const { head, tail } = readEnds(full, f.size, fsImpl);
            const kind = sniffDocumentBytes(head).kind;
            if (kind === "pdf") {
              return { ok: true, path: full, name: f.name, size: f.size, truncated: !/%%EOF/.test(tail.toString("latin1")) };
            }
            notPdf = `${f.name} is ${kind === "html" ? "a web page" : kind === "xml" ? "an error document" : `not a PDF (${kind})`}`;
          } catch (e) {
            notPdf = `${f.name} could not be read (${e && e.message})`;
          }
        }
      } else {
        candidate = { name: f.name, size: f.size, since: now() };
      }
    } else {
      candidate = null;
    }
    if (now() - started >= timeoutMs) {
      return notPdf ? { ok: false, reason: "not-pdf", detail: notPdf } : { ok: false, reason: "timeout", detail: "no PDF arrived in the download folder" };
    }
    await sleep(pollMs);
  }
}

/* -------------------------------------------------------------------------- */
/* Driver helpers                                                             */
/* -------------------------------------------------------------------------- */

const errorNameOf = (e) => String((e && (e.name || (e.constructor && e.constructor.name))) || "");

/** A click that was refused BEFORE it happened (so it may be tried the other way) — not a timeout, not an alert. */
const isClickRefused = (e) =>
  /ElementClickIntercepted|ElementNotInteractable|StaleElementReference|NoSuchElement|ElementNotVisible/i.test(errorNameOf(e)) ||
  /element click intercepted|element not interactable|stale element|no such element|not clickable/i.test(String((e && e.message) || ""));

/**
 * Click an element once. A real click first; a script click ONLY when the real one was refused before it happened. An
 * alert the click raised counts as clicked (its words are returned); any other error means "it may have happened" and the
 * click is NOT repeated.
 *
 * @returns {Promise<{clicked:boolean, via:string, alert:string, error:string}>}
 */
async function clickOnce(driver, element) {
  try {
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element).catch(() => {});
  } catch (e) {
    /* best effort */
  }
  try {
    await element.click();
    return { clicked: true, via: "click", alert: "", error: "" };
  } catch (e) {
    if (cdt.isStop(e)) throw e;
    if (cdt.isUnexpectedAlert(e)) return { clicked: true, via: "click", alert: cdt.alertTextOf(e), error: "" };
    if (!isClickRefused(e)) return { clicked: true, via: "click", alert: "", error: (e && e.message) || String(e) };
    try {
      await driver.executeScript("arguments[0].click();", element);
      return { clicked: true, via: "script", alert: "", error: (e && e.message) || String(e) };
    } catch (e2) {
      if (cdt.isUnexpectedAlert(e2)) return { clicked: true, via: "script", alert: cdt.alertTextOf(e2), error: "" };
      return { clicked: false, via: "none", alert: "", error: (e2 && e2.message) || String(e2) };
    }
  }
}

/** Close any window the click opened and go back to the one the run was on. */
async function closeExtraWindows(driver, home, log) {
  try {
    const handles = await driver.getAllWindowHandles();
    for (const h of handles) {
      if (h === home) continue;
      try {
        await driver.switchTo().window(h);
        await driver.close();
        log("closed an extra window the download opened");
      } catch (e) {
        /* already gone */
      }
    }
    await driver.switchTo().window(home);
  } catch (e) {
    /* the run's own window is what is left */
  }
}

/* -------------------------------------------------------------------------- */
/* The PDF, way 1 — the schedule link of the Payment Success page             */
/* -------------------------------------------------------------------------- */

async function pdfFromScheduleLink(ctx) {
  const { driver, number, downloadDir, fsImpl, log, sleep, now, timing } = ctx;
  let home = null;
  try {
    home = await driver.getWindowHandle();
  } catch (e) {
    /* single window */
  }
  const before = listFiles(downloadDir, fsImpl);
  let target = null;
  try {
    const links = await driver.findElements(By.css("a[href*='GenerateMotorSchedule' i]"));
    for (const link of links) {
      const href = await link.getAttribute("href");
      if (policyNumberFromHref(href) === number) {
        target = link;
        break;
      }
    }
  } catch (e) {
    if (cdt.isStop(e)) throw e;
  }
  if (!target) return { ok: false, reason: "link", message: "the policy number's link was not on the page any more" };

  const click = await clickOnce(driver, target);
  if (!click.clicked) return { ok: false, reason: "click", message: `the link could not be clicked (${plain(click.error)})` };
  log(`policy number link clicked${click.via === "script" ? " (by script)" : ""}${click.alert ? ` — Reliance showed "${plain(click.alert)}"` : ""}`);
  await sleep(timing.afterClickMs);
  const got = await waitForDownloadedPdf({
    dir: downloadDir,
    before,
    // a short wait: on the live portal this link opens the schedule page (no download); View Policy is the way that downloads
    timeoutMs: timing.linkWaitMs,
    pollMs: timing.pdfPollMs,
    stableMs: timing.pdfStableMs,
    now,
    sleep,
    fsImpl,
  });
  if (home) await closeExtraWindows(driver, home, log);
  if (!got.ok) {
    const where = await driver.getCurrentUrl().catch(() => "");
    const opened = /GenerateMotorSchedule/i.test(where) ? " and Reliance's schedule page opened instead" : "";
    return { ok: false, reason: got.reason, message: `clicking the policy number did not download a PDF (${plain(got.detail)})${opened}` };
  }
  return { ...got, via: "link" };
}

/* -------------------------------------------------------------------------- */
/* The PDF, way 2 — Utilities -> View Policy -> search the number              */
/* -------------------------------------------------------------------------- */

async function readViewPolicy(driver) {
  return driver.executeScript(readViewPolicyInPage, IDS);
}

/** Make "Policy Number" the search option: click the list item, then the Kendo API; read the choice back each time. */
async function chooseSearchOption(ctx, dropdown) {
  const { driver, log, sleep, timing } = ctx;
  const WANTED = "Policy Number";
  const same = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase() === WANTED.toLowerCase();
  if (same(dropdown.current)) return { ok: true, via: "already" };

  const readCurrent = async () => {
    const page = await readViewPolicy(driver);
    const d = (page.dropdowns || []).find((x) => x.token === dropdown.token);
    return d ? d.current : "";
  };

  try {
    const wrap = await driver.findElement(By.css(`[data-rwi="${dropdown.token}"]`));
    const opened = await clickOnce(driver, wrap);
    if (opened.clicked) {
      await sleep(timing.settleMs);
      const scope = dropdown.listId ? `//ul[@id='${dropdown.listId}']` : "";
      const item = await driver.findElements(By.xpath(`${scope}//li[normalize-space(.)='${WANTED}']`));
      let picked = null;
      for (const el of item) {
        if (await el.isDisplayed().catch(() => false)) {
          picked = el;
          break;
        }
      }
      if (picked) {
        await clickOnce(driver, picked);
        await sleep(timing.settleMs);
        if (same(await readCurrent())) return { ok: true, via: "list" };
      }
    }
  } catch (e) {
    if (cdt.isStop(e)) throw e;
    log(`the search option list could not be clicked (${(e && e.message) || e})`);
  }

  try {
    const done = await driver.executeScript(selectKendoOptionInPage, dropdown.listId, WANTED);
    await sleep(timing.settleMs);
    if (done && done.done && same(await readCurrent())) return { ok: true, via: "script" };
  } catch (e) {
    if (cdt.isStop(e)) throw e;
  }
  return { ok: false, shows: await readCurrent().catch(() => "") };
}

const originOf = (url) => {
  const m = String(url || "").match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] : "";
};

const offersPolicyNumber = (d) =>
  (d.items || []).some((i) => /^policy number$/i.test(String(i).trim())) || /^policy number$/i.test(String(d.current || "").trim());

/** Is this read the View Policy search page (its search box, or a search option dropdown that offers Policy Number)? */
const isViewPolicySearchPage = (p) =>
  !!p && ((p.inputs || []).some((i) => i.id === IDS.searchText) || (p.dropdowns || []).some(offersPolicyNumber));

/**
 * Open the View Policy search page and return its first read. By address first — the menu link's own href (read from the
 * page, shown or not), then the address the KYC step reaches — and only then the Utilities hover + click.
 *
 * @returns {Promise<{ok:true, via:string, page:Object}|{ok:false, message:string}>}
 */
async function openViewPolicy(ctx) {
  const { driver, log, sleep, now, timing } = ctx;
  const waitForSearchPage = (ms) =>
    cdt.poll(
      async () => {
        const p = await readViewPolicy(driver);
        return isViewPolicySearchPage(p) ? p : null;
      },
      { timeoutMs: ms, pollMs: timing.pdfPollMs, now, sleep }
    );
  const tried = [];

  // already there (a re-run that is on the page)?
  try {
    const here = await readViewPolicy(driver);
    if (isViewPolicySearchPage(here)) return { ok: true, via: "already open", page: here };
  } catch (e) {
    if (cdt.isStop(e)) throw e;
  }

  // 1. by address
  const addresses = [];
  try {
    const href = await driver.executeScript(findViewPolicyHrefInPage);
    if (href) addresses.push({ url: href, how: "the menu link's address" });
  } catch (e) {
    if (cdt.isStop(e)) throw e;
  }
  try {
    const origin = originOf(await driver.getCurrentUrl());
    if (origin) addresses.push({ url: origin + VIEW_POLICY_PATH, how: "the View Policy address" });
  } catch (e) {
    if (cdt.isStop(e)) throw e;
  }
  const seen = new Set();
  for (const a of addresses) {
    if (seen.has(a.url)) continue;
    seen.add(a.url);
    try {
      await driver.get(a.url);
    } catch (e) {
      if (cdt.isStop(e)) throw e;
      tried.push(`${a.how} could not be opened (${plain((e && e.message) || e)})`);
      continue;
    }
    const page = await waitForSearchPage(timing.searchPageWaitMs);
    if (page) return { ok: true, via: a.how, page };
    let where = "";
    try {
      where = await driver.getCurrentUrl();
    } catch (e) {
      /* the message below says what is known */
    }
    tried.push(`${a.how} did not show the search page${isLoginUrl(where) ? " (Reliance's login page came up)" : ""}`);
  }

  // 2. the menu, as the KYC step walks it
  try {
    let menu = null;
    const found = await cdt.poll(
      async () => {
        const els = await driver.findElements(By.id(IDS.utility));
        return els.length ? els[0] : null;
      },
      { timeoutMs: timing.menuWaitMs, pollMs: timing.pdfPollMs, now, sleep }
    );
    if (found) menu = found;
    if (!menu) {
      tried.push("the Utilities menu was not found on the page");
    } else {
      await driver.actions({ bridge: true }).move({ origin: menu }).perform();
      log("hovered on the Utilities menu");
      await sleep(timing.settleMs * 2);
      const item = await cdt.poll(
        async () => {
          const els = await driver.findElements(By.xpath("//li//a[contains(normalize-space(.), 'View Policy')]"));
          for (const el of els) if (await el.isDisplayed().catch(() => false)) return el;
          return null;
        },
        { timeoutMs: timing.menuWaitMs, pollMs: timing.pdfPollMs, now, sleep }
      );
      if (!item) {
        tried.push("the View Policy item was not found under Utilities");
      } else {
        const clicked = await clickOnce(driver, item);
        if (!clicked.clicked) {
          tried.push(`the View Policy item could not be clicked (${plain(clicked.error)})`);
        } else {
          const page = await waitForSearchPage(timing.searchPageWaitMs);
          if (page) return { ok: true, via: "the Utilities menu", page };
          tried.push("the View Policy item was clicked but the search page did not open");
        }
      }
    }
  } catch (e) {
    if (cdt.isStop(e)) throw e;
    tried.push(`the Utilities menu could not be used (${plain((e && e.message) || e)})`);
  }
  return { ok: false, message: `View Policy could not be opened — ${tried.join("; then ")}` };
}

async function pdfFromViewPolicy(ctx) {
  const { driver, number, downloadDir, fsImpl, log, sleep, now, timing } = ctx;
  let home = null;
  try {
    home = await driver.getWindowHandle();
  } catch (e) {
    /* single window */
  }
  const fail = (reason, message) => ({ ok: false, reason, message });

  // 1. View Policy — by ADDRESS first (the menu link's own href, then the page the KYC step already reaches), the menu hover
  //    last: on the schedule page the submenu never opened ("the View Policy item was not found under Utilities")
  const opened = await openViewPolicy(ctx);
  if (!opened.ok) return fail("menu", opened.message);
  log(`View Policy opened (${opened.via})`);

  // 2. the search page, and "Policy Number" as the search option
  const page = opened.page;

  const dropdowns = (page.dropdowns || []).filter((d) => d.shown);
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const dropdown =
    dropdowns.find((d) => (d.items || []).some((i) => norm(i) === "policy number")) ||
    dropdowns.find((d) => norm(d.current) === "policy number") ||
    (dropdowns.length === 1 ? dropdowns[0] : null);
  if (!dropdown) {
    return fail("search-option", `the search option dropdown was not found on the View Policy page (${(page.dropdowns || []).length} dropdowns, none offering "Policy Number")`);
  }
  const chosen = await chooseSearchOption(ctx, dropdown);
  if (!chosen.ok) {
    return fail("search-option", `"Policy Number" could not be chosen as the search option (the dropdown shows "${plain(chosen.shows || dropdown.current)}")`);
  }
  log(`search option "Policy Number" chosen (${chosen.via})`);

  // 3. the number in the search box, read back
  const afterChoice = await readViewPolicy(driver);
  const boxes = (afterChoice.inputs || []).filter((i) => i.shown && i.enabled);
  const box = boxes.find((i) => i.id === IDS.searchText) || boxes[0];
  if (!box) return fail("search-box", "no search box is shown on the View Policy page after choosing Policy Number");
  try {
    const el = await driver.findElement(By.css(`[data-rwi="${box.token}"]`));
    try {
      await el.clear();
    } catch (e) {
      if (cdt.isStop(e)) throw e;
    }
    await el.sendKeys(number);
    await sleep(timing.settleMs / 2);
    const typed = await driver.executeScript("return String(arguments[0].value || '');", el);
    if (normalisePolicyNumber(typed) !== number) {
      return fail("search-box", `the search box reads "${plain(typed)}" after the policy number was typed`);
    }
  } catch (e) {
    if (cdt.isStop(e)) throw e;
    return fail("search-box", `the policy number could not be typed into the search box (${plain((e && e.message) || e)})`);
  }
  log(`policy number ${number} entered in the search box`);

  // 4. Search, and the number's own link in the results
  const before = listFiles(downloadDir, fsImpl);
  try {
    const buttons = (afterChoice.buttons || []).filter((b) => b.shown && b.enabled);
    const button = buttons.find((b) => b.id === IDS.searchButton) || buttons[0];
    if (!button) return fail("search-button", "the Search button was not found on the View Policy page");
    const el = await driver.findElement(By.css(`[data-rwi="${button.token}"]`));
    const clicked = await clickOnce(driver, el);
    if (!clicked.clicked) return fail("search-button", `the Search button could not be clicked (${plain(clicked.error)})`);
    log("Search pressed");
  } catch (e) {
    if (cdt.isStop(e)) throw e;
    return fail("search-button", `Search could not be pressed (${plain((e && e.message) || e)})`);
  }
  await sleep(timing.afterClickMs);

  const findOwnRow = async () => {
    const p = await readViewPolicy(driver);
    if (p.loading) return null;
    const exact = (p.links || []).filter((l) => l.shown && normalisePolicyNumber(l.text) === number);
    return exact.length ? { exact, page: p } : null;
  };
  let results = await cdt.poll(findOwnRow, { timeoutMs: Math.min(8000, timing.searchResultWaitMs), pollMs: timing.pdfPollMs * 2, now, sleep });
  if (!results) {
    // the click may not have reached the search (a covered button): the page's own search function, once — a search only reads
    try {
      if (await driver.executeScript(runPolicySearchInPage)) log("Search run by the page's own function as well");
    } catch (e) {
      if (cdt.isStop(e)) throw e;
    }
    results = await cdt.poll(findOwnRow, { timeoutMs: timing.searchResultWaitMs, pollMs: timing.pdfPollMs * 2, now, sleep });
  }
  if (!results) {
    const last = await readViewPolicy(driver).catch(() => null);
    const shownLinks = last ? (last.links || []).filter((l) => l.shown).map((l) => `"${plain(l.text)}"`) : [];
    return fail(
      "no-result",
      `the search for policy ${plain(number)} did not list that policy number${last && last.noRecords ? " (Reliance said no records were found)" : shownLinks.length ? ` (the results show ${shownLinks.slice(0, 4).join(", ")})` : ""}`
    );
  }

  // 5. its link — the one whose text IS the policy number — and the download
  let link;
  try {
    link = await driver.findElement(By.css(`[data-rwi="${results.exact[0].token}"]`));
  } catch (e) {
    if (cdt.isStop(e)) throw e;
    return fail("result-link", "the policy number's link could not be found in the results");
  }
  const click = await clickOnce(driver, link);
  if (!click.clicked) return fail("result-link", `the policy number's link in the results could not be clicked (${plain(click.error)})`);
  log(`policy number link in the View Policy results clicked${click.via === "script" ? " (by script)" : ""}`);
  await sleep(timing.afterClickMs);
  const got = await waitForDownloadedPdf({
    dir: downloadDir,
    before,
    timeoutMs: timing.pdfWaitMs,
    pollMs: timing.pdfPollMs,
    stableMs: timing.pdfStableMs,
    now,
    sleep,
    fsImpl,
  });
  if (home) await closeExtraWindows(driver, home, log);
  if (!got.ok) return fail(got.reason, `the policy number's link in the results did not download a PDF (${plain(got.detail)})`);
  return { ...got, via: "view-policy" };
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                   */
/* -------------------------------------------------------------------------- */

const noteFor = (ctx, extra) => ({
  proposalNumber: ctx.proposalNumber || "",
  amountPaise: ctx.paise,
  amount: formatPaise(ctx.paise),
  jobId: String(ctx.data._jobId || ctx.data._jobIdentifier || ctx.jobId || ""),
  attempt: ctx.data._attemptNumber || null,
  part: ctx.data._partKey || null,
  portalUser: ctx.data.username || null,
  ...extra,
});

/**
 * After the CDT row is added: check the row, write the note, press Submit Details once, read the answer, save the policy
 * number, get the PDF, store it. Returns normally only for an issued policy whose PDF is stored; every other end is a
 * PaymentStepError (the form's failure catch adds the screenshot) or a Breaker stop.
 *
 * @param {Object} o
 * @param {Object}   o.driver
 * @param {Object}   o.data               the job data (_id, policyId, _partKey, _jobId ...)
 * @param {string}   o.jobId
 * @param {string}   o.proposalNumber
 * @param {boolean}  [o.selectionVerified]
 * @param {Function} [o.checkpoint]       (name) — the Breaker
 * @param {Function} [o.log]
 * @param {Function} [o.shot]             async (label) -> {url, key} — a screenshot, uploaded
 * @param {string}   o.downloadDir        this job's own download folder
 * @param {Function} o.uploadPolicyPdf    async (filePath, {key, fileName}) -> {key, location}
 * @param {Object}   [o.deps]             { MongoClient, fsImpl, now, sleep, timing, cdt }
 * @returns {Promise<{ok:true, policyNumber:string, transactionNo:string, pdf:Object, file:Object, warnings:string[],
 *                    warning:string, saved:Object}>}
 */
async function payWithCdtAndIssue(o = {}) {
  const {
    driver,
    data = {},
    jobId = "",
    proposalNumber = "",
    selectionVerified = false,
    checkpoint = () => {},
    log = () => {},
    shot = null,
    downloadDir = "",
    uploadPolicyPdf,
    deps = {},
  } = o;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));
  const now = deps.now || Date.now;
  const fsImpl = deps.fsImpl || fs;
  const timing = { ...TIMING, ...(deps.timing || {}) };
  const proposal = proposalNumber ? `proposal ${plain(proposalNumber)}` : "the proposal";

  // 1. the CDT row (the step that exists already), then the row it added
  const added = await cdt.payWithCdt(driver, { proposalNumber, selectionVerified, checkpoint, log, sleep, now, ...(deps.cdt || {}) });
  if (!added.ok) throw new PaymentStepError(added.message, { code: added.code, portalText: added.portalText || "" });
  const paise = added.paise;
  const amount = formatPaise(paise);
  const ctx = { driver, data, jobId, proposalNumber, paise, downloadDir, fsImpl, log, sleep, now, timing };
  log(`CDT amount ${amount} added — checking the payment details before Submit Details`);

  const readIssue = () => cdt.guarded(() => driver.executeScript(readIssuePageInPage, IDS), [], { retry: true });
  const rows = await cdt.poll(
    async () => {
      const page = await readIssue();
      const found = addedCdtRows(added.rowTextsBefore || [], page.rowTexts || [], paise);
      return found.matching.length ? { page, found } : null;
    },
    { timeoutMs: timing.rowWaitMs, pollMs: timing.pollMs / 2, now, sleep }
  );
  if (!rows) {
    const page = await readIssue().catch(() => null);
    const found = page ? addedCdtRows(added.rowTextsBefore || [], page.rowTexts || [], paise) : { added: [] };
    const seen = found.added.length ? ` The rows that appeared are ${found.added.slice(0, 3).map((t) => `"${plain(t)}"`).join(", ")}.` : " No new row appeared.";
    throw new PaymentStepError(
      `The CDT payment of ${amount} for ${proposal} was added at Reliance but the payment details table does not show a row of ${amount}, ` +
        `so Submit Details was not pressed.${seen} Nothing was submitted or paid.`,
      { code: "ROW_MISSING" }
    );
  }
  if (rows.found.duplicated) {
    throw new PaymentStepError(
      `The payment details table shows the CDT row of ${amount} more than once for ${proposal}, so Submit Details was not pressed. ` +
        `Nothing was submitted or paid.`,
      { code: "ROW_DUPLICATED" }
    );
  }
  if (rows.found.cdtWordMissing) log(`the new payment row shows ${amount} but not the word CDT ("${plain(rows.found.matching[0])}")`);
  // 2. nothing of Reliance's open (a harmless message is given a moment to close — it is read, never clicked away), then
  //    the button, on the freshest read
  const settled = await cdt.poll(
    async () => {
      const p = await readIssue();
      return p && !(p.dialogs || []).length ? p : null;
    },
    { timeoutMs: timing.dialogWaitMs, pollMs: timing.pollMs / 2, now, sleep }
  );
  if (!settled) {
    const p = (await readIssue().catch(() => null)) || rows.page;
    const open = p.dialogs || [];
    const buttons = p.dialogButtons && p.dialogButtons.length ? ` with the buttons ${p.dialogButtons.map((b) => `"${plain(b)}"`).join(", ")}` : "";
    throw new PaymentStepError(
      `Reliance shows "${open.map(plain).join(" | ")}"${buttons} on the payment page for ${proposal}, so Submit Details was not pressed. ` +
        `Nothing was submitted or paid.`,
      { code: "DIALOG_OPEN", portalText: open[0] || "" }
    );
  }
  if (!(settled.submit && settled.submit.exists && settled.submit.shown && settled.submit.enabled)) {
    const why = !settled.submit || !settled.submit.exists ? "it is not on the page" : !settled.submit.shown ? "it is not shown" : "it is disabled";
    throw new PaymentStepError(
      `The Submit Details button is not available on the payment page for ${proposal} (${why}), so nothing was submitted or paid.`,
      { code: "SUBMIT_MISSING" }
    );
  }

  // a picture of the payment page with the row, before anything is pressed (a courtesy)
  if (shot) {
    try {
      await shot("cdt-added");
    } catch (e) {
      /* the picture is a courtesy */
    }
  }

  // 3. last look (Breaker) — then the note, then the press
  checkpoint("wallet-cdt-submit");

  const field = markerFieldFor(data);
  const policyId = data._id || data.policyId;
  if (!policyId) {
    throw new PaymentStepError(
      `The policy has no id on the job, so the note that a payment is being submitted cannot be saved and Submit Details was not pressed. ` +
        `Nothing was submitted or paid.`,
      { code: "NO_POLICY_ID" }
    );
  }
  const store = deps.store || createIssueStore({ MongoClient: deps.MongoClient, field, policyId });
  const pressedNote = noteFor(ctx, { state: STATES.PRESSED, at: new Date() });
  let claim;
  try {
    claim = await store.claim(pressedNote);
  } catch (e) {
    throw new PaymentStepError(
      `The note that a payment is being submitted could not be saved on the policy (${plain((e && e.message) || e)}), so Submit Details was not pressed. ` +
        `Nothing was submitted or paid.`,
      { code: "NOTE_NOT_SAVED" }
    );
  }
  if (!(claim && claim.matched === 1)) {
    let current = null;
    try {
      current = await store.readNote();
    } catch (e) {
      /* the message below says what is known */
    }
    if (current && current.marker && isBlockingState(current.marker.state)) {
      throw new PaymentStepError(gateMessage({ ...current.marker, field }), { code: "ALREADY_SUBMITTED" });
    }
    throw new PaymentStepError(
      `The note that a payment is being submitted was not saved on the policy (${current && !current.found ? "the policy was not found" : "the write matched nothing"}), ` +
        `so Submit Details was not pressed. Nothing was submitted or paid.`,
      { code: "NOTE_NOT_SAVED" }
    );
  }
  log(`note ${field}.state = ${STATES.PRESSED} saved — pressing Submit Details`);

  // 4. Submit Details — once
  let pressedAlert = "";
  let pressError = "";
  let handlesBefore = null;
  try {
    handlesBefore = await driver.getAllWindowHandles();
  } catch (e) {
    if (cdt.isStop(e)) throw e;
  }
  try {
    const button = await driver.findElement(By.id(IDS.submit));
    const click = await clickOnce(driver, button);
    pressedAlert = click.alert;
    pressError = click.clicked ? click.error : "";
    if (!click.clicked) {
      // refused before it happened, in both ways: nothing was pressed, and the note says so
      await store.outcome({ state: STATES.FAILED, outcomeAt: new Date(), words: `Submit Details could not be clicked (${click.error})` });
      throw new PaymentStepError(
        `Submit Details could not be clicked for ${proposal} (${plain(click.error)}). Nothing was submitted or paid.`,
        { code: "SUBMIT_NOT_CLICKED" }
      );
    }
  } catch (e) {
    if (e instanceof PaymentStepError || cdt.isStop(e)) throw e;
    // the button could not even be found; nothing was pressed
    await store.outcome({ state: STATES.FAILED, outcomeAt: new Date(), words: `Submit Details was not found (${(e && e.message) || e})` });
    throw new PaymentStepError(
      `Submit Details could not be found on the payment page for ${proposal} (${plain((e && e.message) || e)}). Nothing was submitted or paid.`,
      { code: "SUBMIT_MISSING" }
    );
  }
  log(`Submit Details pressed${pressError ? ` (the click reported "${plain(pressError)}")` : ""}${pressedAlert ? ` — Reliance showed "${plain(pressedAlert)}"` : ""}`);

  // 5. the answer
  const verdict = await awaitIssueResult(driver, {
    alerts: pressedAlert ? [pressedAlert] : [],
    proposalNumber,
    timeoutMs: timing.resultWaitMs,
    pollMs: timing.pollMs,
    graceMs: timing.refusalGraceMs,
    now,
    sleep,
    log,
    handlesBefore,
  });

  const unconfirmed = async (why, words = "") => {
    const shown = [...new Set((verdict.alerts || []).map((a) => String(a || "").trim()).filter(Boolean))];
    const said = shown.length ? ` Reliance showed ${shown.map((a) => `"${plain(a)}"`).join(" and ")} while it was pressed.` : "";
    await store.outcome({
      state: STATES.UNCONFIRMED,
      outcomeAt: new Date(),
      words: String(words || shown[0] || why).slice(0, 500),
    });
    return new PaymentStepError(
      `Submit Details was pressed for the CDT payment of ${amount} for ${proposal} and Reliance's answer could not be confirmed (${plain(why)}).${said} ` +
        `The payment may have gone through. Check the policy at Reliance before running this policy again — it is marked so that it is not run again by itself.`,
      { code: "SUBMIT_UNCONFIRMED", portalText: words || shown[0] || "" }
    );
  };

  if (verdict.kind === "failed") {
    await store.outcome({ state: STATES.FAILED, outcomeAt: new Date(), words: String(verdict.words).slice(0, 500) });
    throw new PaymentStepError(
      `Reliance refused the CDT payment of ${amount} for ${proposal} when Submit Details was pressed — it said "${plain(verdict.words)}". ` +
        `The payment page is still showing and no policy number appeared, so this run is marked refused and the policy can be run again.`,
      { code: "SUBMIT_REFUSED", portalText: verdict.words }
    );
  }
  if (verdict.kind === "conflict") throw await unconfirmed(verdict.why);
  if (verdict.kind === "lost-session") throw await unconfirmed("Reliance went back to its login page");
  if (verdict.kind === "timeout") {
    const p = verdict.page;
    const said = verdict.refusal
      ? `it said "${plain(verdict.refusal)}" and then did not settle`
      : p && p.success
      ? "the page says the payment was successful but the policy number link never appeared"
      : `no Payment Success page appeared within ${Math.round(timing.resultWaitMs / 1000)} seconds`;
    throw await unconfirmed(said, verdict.refusal);
  }

  // issued
  const number = verdict.policyNumber;
  log(`✅ CDT payment of ${amount} submitted — policy ${number} issued${verdict.transactionNo ? ` (transaction ${plain(verdict.transactionNo)})` : ""}`);
  await store.outcome({
    state: STATES.ISSUED,
    outcomeAt: new Date(),
    policyNumber: number,
    transactionNo: verdict.transactionNo || null,
  });
  if (shot) {
    try {
      await shot("issued");
    } catch (e) {
      /* the picture is a courtesy */
    }
  }

  // 6. the number, at once — before the PDF is touched
  const warnings = [];
  const savedNumber = await store.saveNumber(number);
  warnings.push(...savedNumber.warnings);
  log(
    `policy number saved — online policy ${savedNumber.onlinePolicy}, policy record ${savedNumber.policy}` +
      (savedNumber.warnings.length ? ` (${savedNumber.warnings.length} warning${savedNumber.warnings.length > 1 ? "s" : ""})` : "")
  );

  // 7. the PDF — the link, then View Policy
  const pdfCtx = { ...ctx, number };
  if (!downloadDir || !(fsImpl.existsSync ? fsImpl.existsSync(downloadDir) : true)) {
    throw new PaymentStepError(
      `Policy ${plain(number)} was issued at Reliance for ${proposal} and its number is saved on the policy, but this job has no download folder to take its PDF into. ` +
        `Download it from Reliance's View Policy page and upload it on the policy by hand.`,
      { code: "PDF_MISSING" }
    );
  }
  let pdf = await pdfFromScheduleLink(pdfCtx);
  const attempts = [];
  if (!pdf.ok) {
    attempts.push(pdf.message);
    log(`the PDF did not come from the link (${pdf.message}) — trying View Policy`);
    pdf = await pdfFromViewPolicy(pdfCtx);
    if (!pdf.ok) attempts.push(pdf.message);
  }
  if (!pdf.ok) {
    throw new PaymentStepError(
      `Policy ${plain(number)} was issued at Reliance for ${proposal} and its number is saved on the policy, but its PDF could not be downloaded — ` +
        `${attempts.map(plain).join("; then ")}. Download it from Reliance's View Policy page and upload it on the policy by hand.`,
      { code: "PDF_MISSING" }
    );
  }
  log(`policy PDF downloaded by ${pdf.via === "link" ? "the policy number link" : "View Policy"} — ${pdf.name} (${pdf.size} bytes)`);
  if (pdf.truncated) log(`⚠️ ${pdf.name} has no %%EOF marker at its end — it is kept, but it may be incomplete`);

  // 8. stored for good, and set on the policy
  const names = policyFileNames(new Date());
  let stored;
  try {
    stored = await uploadPolicyPdf(pdf.path, { key: names.key, fileName: names.fileName });
  } catch (e) {
    throw new PaymentStepError(
      `Policy ${plain(number)} was issued at Reliance for ${proposal} and its PDF was downloaded, but it could not be stored (${plain((e && e.message) || e)}). ` +
        `Download it from Reliance's View Policy page and upload it on the policy by hand.`,
      { code: "PDF_NOT_STORED" }
    );
  }
  const file = { fileName: names.fileName, key: (stored && stored.key) || names.key, location: (stored && stored.location) || "" };
  const savedPdf = await store.savePdf(file, savedNumber.policyDocId);
  warnings.push(...savedPdf.warnings);
  log(`policy PDF stored as ${file.key} — policyFile ${savedPdf.policy}, online policy ${savedPdf.onlinePolicy}`);

  return {
    ok: true,
    policyNumber: number,
    transactionNo: verdict.transactionNo || "",
    pdf: { path: pdf.path, name: pdf.name, size: pdf.size, via: pdf.via },
    file,
    saved: { number: savedNumber, pdf: savedPdf },
    warnings,
    warning: warnings.length
      ? `Policy ${plain(number)} was issued and its PDF is stored, but ${warnings.map(plain).join("; and ")}.`
      : "",
  };
}

/**
 * Finish a policy that was ISSUED earlier but whose PDF was never stored (the run ended at the PDF). Never pays and never
 * presses Submit Details — the form skips everything up to here. The number is saved again (idempotent, first writer wins),
 * the PDF is fetched from View Policy by the policy number, stored for good and set on the policy; the form then runs its
 * normal completion steps (Brisk certificate, merge) and the policy completes.
 *
 * A policy that already has its PDF file is not given a second object: the PDF is still fetched (the merge step needs the
 * file), and if it cannot be fetched the run goes on with a warning.
 *
 * @param {Object} o  as payWithCdtAndIssue, plus `policyNumber` (the number the note holds)
 * @returns {Promise<{ok:true, recovered:true, policyNumber:string, pdf:Object|null, file:Object|null, warnings:string[], warning:string}>}
 */
async function recoverIssuedPolicyPdf(o = {}) {
  const { driver, data = {}, jobId = "", proposalNumber = "", policyNumber = "", log = () => {}, downloadDir = "", uploadPolicyPdf, deps = {} } = o;
  const sleep = deps.sleep || ((ms) => driver.sleep(ms));
  const now = deps.now || Date.now;
  const fsImpl = deps.fsImpl || fs;
  const timing = { ...TIMING, ...(deps.timing || {}) };
  const proposal = proposalNumber ? `proposal ${plain(proposalNumber)}` : "the proposal";
  const number = normalisePolicyNumber(policyNumber);

  if (!isPlausiblePolicyNumber(number, proposalNumber)) {
    throw new PaymentStepError(
      `The note on this policy holds "${plain(policyNumber)}" as its policy number, which does not look like one, so its PDF was not fetched. ` +
        `Nothing was paid.`,
      { code: "RECOVER_NUMBER" }
    );
  }
  const field = markerFieldFor(data);
  const policyId = data._id || data.policyId;
  if (!policyId) {
    throw new PaymentStepError(`The policy has no id on the job, so its PDF could not be saved on it. Nothing was paid.`, { code: "NO_POLICY_ID" });
  }
  const store = deps.store || createIssueStore({ MongoClient: deps.MongoClient, field, policyId });
  const warnings = [];
  log(`policy ${number} was already issued — nothing is paid again, only its PDF is fetched from View Policy`);

  // 1. the number again — it may not have been saved the first time
  const savedNumber = await store.saveNumber(number);
  warnings.push(...savedNumber.warnings);
  log(`policy number saved — online policy ${savedNumber.onlinePolicy}, policy record ${savedNumber.policy}`);
  const storedKey = await store.policyFileKey(savedNumber.policyDocId);

  // 2. the PDF — View Policy, by the policy number
  const folderThere = !!downloadDir && (fsImpl.existsSync ? fsImpl.existsSync(downloadDir) : true);
  let pdf = { ok: false, message: "this job has no download folder to take the PDF into" };
  if (folderThere) {
    pdf = await pdfFromViewPolicy({ driver, data, jobId, proposalNumber, paise: 0, number, downloadDir, fsImpl, log, sleep, now, timing });
  }
  if (!pdf.ok) {
    if (storedKey) {
      warnings.push(`its PDF could not be fetched again (${plain(pdf.message)}) but the policy already has its file`);
      return { ok: true, recovered: true, policyNumber: number, pdf: null, file: null, warnings, warning: recoveryWarning(number, warnings) };
    }
    throw new PaymentStepError(
      `Policy ${plain(number)} was issued at Reliance earlier for ${proposal} and its number is saved on the policy, but its PDF could not be downloaded — ` +
        `${plain(pdf.message)}. Nothing was paid again. Download it from Reliance's View Policy page and upload it on the policy by hand.`,
      { code: "PDF_MISSING" }
    );
  }
  log(`policy PDF downloaded by View Policy — ${pdf.name} (${pdf.size} bytes)`);
  if (pdf.truncated) log(`⚠️ ${pdf.name} has no %%EOF marker at its end — it is kept, but it may be incomplete`);

  // 3. stored for good and set on the policy — unless the policy already has its file
  if (storedKey) {
    log(`the policy already has its PDF file (${storedKey}) — not stored again`);
    return { ok: true, recovered: true, policyNumber: number, pdf: { path: pdf.path, name: pdf.name, size: pdf.size, via: pdf.via }, file: null, warnings, warning: recoveryWarning(number, warnings) };
  }
  const names = policyFileNames(new Date());
  let stored;
  try {
    stored = await uploadPolicyPdf(pdf.path, { key: names.key, fileName: names.fileName });
  } catch (e) {
    throw new PaymentStepError(
      `Policy ${plain(number)} was issued at Reliance earlier for ${proposal} and its PDF was downloaded, but it could not be stored (${plain((e && e.message) || e)}). ` +
        `Nothing was paid again. Download it from Reliance's View Policy page and upload it on the policy by hand.`,
      { code: "PDF_NOT_STORED" }
    );
  }
  const file = { fileName: names.fileName, key: (stored && stored.key) || names.key, location: (stored && stored.location) || "" };
  const savedPdf = await store.savePdf(file, savedNumber.policyDocId);
  warnings.push(...savedPdf.warnings);
  await store.outcome({ pdfFetchedAt: new Date() });
  log(`policy PDF stored as ${file.key} — policyFile ${savedPdf.policy}, online policy ${savedPdf.onlinePolicy}`);
  return {
    ok: true,
    recovered: true,
    policyNumber: number,
    pdf: { path: pdf.path, name: pdf.name, size: pdf.size, via: pdf.via },
    file,
    saved: { number: savedNumber, pdf: savedPdf },
    warnings,
    warning: recoveryWarning(number, warnings),
  };
}

/**
 * The uploader the form hands to the issue / recovery steps: a downloaded policy PDF into the bucket — private, in the
 * Policy folder the app's own policy uploads use, nothing expires there. `s3Client` is the form's own client (the one the
 * merged PDF goes through).
 *
 * @returns {(filePath:string, o:{key:string}) => Promise<{key:string, location:string}>}
 */
function createPolicyPdfUploader(s3Client, { bucket = () => process.env.AWS_BUCKET_NAME, fsImpl = fs } = {}) {
  return async function uploadPolicyPdf(filePath, { key }) {
    const result = await s3Client
      .upload({
        Bucket: bucket(),
        Key: key,
        Body: fsImpl.readFileSync(filePath),
        ContentType: "application/pdf",
        ACL: "private",
      })
      .promise();
    return { key: (result && result.Key) || key, location: (result && result.Location) || "" };
  };
}

const recoveryWarning = (number, warnings) =>
  warnings.length ? `Policy ${plain(number)} was already issued and its PDF was fetched now, but ${warnings.map(plain).join("; and ")}.` : "";

module.exports = {
  VIEW_POLICY_PATH,
  createPolicyPdfUploader,
  decideAfterGate,
  issuedNumberOf,
  recoverIssuedPolicyPdf,
  openViewPolicy,
  findViewPolicyHrefInPage,
  runPolicySearchInPage,
  isWalletSubmitEnabled,
  IDS,
  STATES,
  BLOCKING_STATES,
  TIMING,
  isBlockingState,
  normalisePolicyNumber,
  isPlausiblePolicyNumber,
  policyNumberFromHref,
  amountsIn,
  diffRows,
  addedCdtRows,
  whenText,
  markerFieldFor,
  policyFileNames,
  readIssuePageInPage,
  readViewPolicyInPage,
  selectKendoOptionInPage,
  gateMessage,
  checkSubmitGate,
  createIssueStore,
  classifyIssuePage,
  awaitIssueResult,
  listFiles,
  waitForDownloadedPdf,
  clickOnce,
  pdfFromScheduleLink,
  pdfFromViewPolicy,
  payWithCdtAndIssue,
};
