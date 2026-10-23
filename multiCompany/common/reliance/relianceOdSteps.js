/**
 * Reliance OD — the steps only the OWN-DAMAGE part does. Everything else of the OD run is the full-company Reliance flow
 * (relianceMultiForm.js, generated from fullPolicycompany/relianceForm.js); the generated copy calls these functions at
 * the places tagged "[MC] 7" and "[MC] 10" to "[MC] 15" in relianceMultiFormSpec.js, for `mcKind === "od"` only. The TP part
 * never calls them. Since 2026-10-23 the OD run goes on to the END of the full flow (Calculate Premium, Save, the KYC / OVD
 * upload, Pending Quotes, Pay) — the owner: "all things are same" — so every step here that the full flow does not have, or
 * does blindly, is followed by an EXACT sentence when it fails.
 *
 * 1. answerTpDetailsDialog — "TP Details" (the owner, from the portal)
 *    Choosing the product "Two Wheeler Own damage Policy" and pressing "Skip To Main Page" opens a box titled "TP Details":
 *      Existing Third Party / Liability Policy Available :  ( ) Yes  ( ) No        <input id="rbIsExistingPolicyLiabilityYes">
 *      -> after Yes, a second question:
 *      Is Third Party Policy held With RGICL :              ( ) Yes  ( ) No        <input id="rbIsRGICLNo">
 *      -> after No, a "Proceed" button                                             <input id="btnISNotRGICLPolicy">
 *    The customer's TP policy is NOT held with Reliance (it is KSHEMA's or National's), so the answers are always
 *    Yes, No, Proceed. The page's own onclick handlers do the work, so each answer is a real click. The Yes and No radios
 *    have different `name`s, so the browser does not group them: each step waits for the NEXT thing to appear instead of
 *    trusting that the click "took".
 *
 * 2. selectFuelType — the OD form has a Fuel Type box that the new-vehicle form fills by itself, so the full flow never
 *    touched it and the OD run left it empty ("it miss the fuel type"). The value is the policy vehicle's own
 *    (lib/vehicleFuelType.js, looked up before any window opens), mapped to Reliance's own list (chooseFuelOption: LPG / CNG
 *    = Petrol, the owner's decision). The box is FOUND, not assumed (id / aria-owns with "fuel", or its "Fuel Type" label),
 *    chosen like a person, read back; when it cannot be found the sentence lists the dropdown boxes that ARE on the page.
 *
 * 2b. fillExistingTpPolicy — the customer's existing third party policy (the owner, 2026-10-23): the Kendo PanelBar panel is
 *    opened ONLY if it is collapsed (open by default; its icons are span.k-panelbar-expand / .k-panelbar-collapse), then
 *    #txtExistingTPPolicyNo, the insurer's dropdown (KSHEMA General Insurance Limited / National Insurance Company
 *    Limited — its id was never seen, so it is the dropdown of the panel whose list has the insurer), and the two Kendo
 *    DatePickers #dpExistingTPPolicyRiskStartDate / ...EndDate (onchange ValidateTpPolicyStartDate / ...Endate). The
 *    values are the policy's (lib/existingTpDetails.js checks them before any window opens; reading them from the TP
 *    insurer's portal is a later step). Everything is typed / chosen like a person and READ BACK; a date the picker does
 *    not take is set through Kendo's own function, then the form's old script way, with a warning each time; an alert()
 *    or a refusing popup is the exact sentence.
 *    ensureAddressSame — "Is Registration Address Same" is ticked ONLY if it is not ticked (the full flow clicks blindly).
 *    afterCalculatePremiumClick / afterCalculatePremium / afterSaveClick / explainSaveFailure — the full flow reads nothing
 *    after Calculate Premium and Save; here an alert(), a refusing popup or a field message is the exact sentence, and a
 *    Save without "Proposal Saved Successfully" says what the page shows.
 *
 * 3. requireCoverTable — after Get Coverage Details the OD form must show its cover table (the Helmet / Zero Depreciation
 *    boxes; the OD page has no PA box, which the full flow treats as "loaded"). When it does not, the run says WHY in
 *    Reliance's own words (the cover box, an open popup, a field message, the required boxes that are still empty).
 *
 * All take the driver (and the clock, the log, the loader wait) as arguments, so they are tested with fake pages and a fake
 * clock. Operator sentences carry ONE colon, right after the label (lib/errorHandler.js beautifyError keeps only the text
 * after the last colon), never the driver's own text, and end with "Nothing was saved or paid." or what to check.
 */
const { parseDay } = require("../../../lib/existingTpDetails");

/** The three controls of the TP Details box, by the ids the portal gives them. */
const TP_DETAILS_IDS = {
  yes: "rbIsExistingPolicyLiabilityYes",
  rgiclNo: "rbIsRGICLNo",
  proceed: "btnISNotRGICLPolicy",
};

/** How long each part of the box is waited for (ms). A slow portal needs seconds, not a fixed sleep. */
const TP_DETAILS_WAITS = {
  open: 20000, // the box after Skip To Main Page
  next: 12000, // the next question / the Proceed button after an answer
  closed: 20000, // the box going away after Proceed
  retryAfter: 4000, // an answer that has had no effect for this long is given once more
};

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises its source)               */
/* -------------------------------------------------------------------------- */

/**
 * The state of the TP Details box's controls, in one read — or one control to click.
 * "shown" = really on screen (a size, not display:none / visibility:hidden): the controls exist in the page source before
 * the box opens, hidden, and a hidden one is not there for the user. Reads only; touches nothing.
 *
 * @param {"yes"|"rgiclNo"|"proceed"} [want]  when given, that ELEMENT is returned (to click) instead of the snapshot
 * @returns {{yes, rgiclNo, proceed}|Element|null}  each of the three: { exists, shown, enabled, checked }
 */
function readTpDetailsInPage(want) {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function describe(el) {
    return { exists: !!el, shown: shown(el), enabled: !!el && !el.disabled, checked: !!(el && el.checked) };
  }
  var yes = document.getElementById("rbIsExistingPolicyLiabilityYes");
  var rgiclNo = document.getElementById("rbIsRGICLNo");
  var proceed = document.getElementById("btnISNotRGICLPolicy");
  if (want === "yes") return yes;
  if (want === "rgiclNo") return rgiclNo;
  if (want === "proceed") return proceed;
  return { yes: describe(yes), rgiclNo: describe(rgiclNo), proceed: describe(proceed) };
}

/* -------------------------------------------------------------------------- */
/* 1. The TP Details box                                                      */
/* -------------------------------------------------------------------------- */

const seconds = (ms) => Math.round(ms / 1000);

/** What the operator calls each control. */
const CONTROL_NAMES = { yes: "Yes answer", rgiclNo: "No answer", proceed: "Proceed button" };

/**
 * Answer the TP Details box: Yes (an existing third party policy), No (it is not held with RGICL), Proceed.
 * Resolves when the box has closed and Reliance's loader is gone; throws a plain Error (retryable by the queue, like any
 * step that waits for the portal) naming what did not appear.
 *
 * @param {Object} driver
 * @param {Object} [o]
 * @param {Function} [o.log]          (line) => void, default console.log
 * @param {Function} [o.waitLoader]   async () => void — the form's own wait for Reliance's loading mask
 * @param {Function} [o.now]          () => ms  (default Date.now) — a test passes a fake clock
 * @param {Function} [o.sleep]        async (ms) => void (default driver.sleep)
 * @param {Object}   [o.waits]        overrides of TP_DETAILS_WAITS (tests)
 */
async function answerTpDetailsDialog(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => driver.sleep(ms));
  const waits = { ...TP_DETAILS_WAITS, ...(o.waits || {}) };
  const POLL_MS = 500;

  const read = () => driver.executeScript(readTpDetailsInPage);

  /** Poll the box until `ready(snapshot)`; true when it was, false when `timeoutMs` passed. */
  async function until(ready, timeoutMs) {
    const deadline = now() + timeoutMs;
    for (;;) {
      let snapshot = null;
      try {
        snapshot = await read();
      } catch (e) {
        snapshot = null; // a page that is reloading answers nothing for a moment
      }
      if (snapshot && ready(snapshot)) return true;
      if (now() >= deadline) return false;
      await sleep(POLL_MS);
    }
  }

  /** One real click on a control (scrolled into view); a script click only when the real one is refused. */
  async function press(want, { script = false } = {}) {
    const element = await driver.executeScript(readTpDetailsInPage, want);
    if (!element) {
      throw new Error(
        `Reliance OD: the TP Details box lost its ${CONTROL_NAMES[want] || "control"} while it was being answered, so the run stopped there. Run the policy again.`
      );
    }
    try {
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
    } catch (e) {
      // scrolling is only a courtesy
    }
    if (script) return driver.executeScript("arguments[0].click();", element);
    try {
      await element.click();
    } catch (e) {
      await driver.executeScript("arguments[0].click();", element);
    }
  }

  /** Answer with a click, wait for the next thing; once more with a script click when nothing happened. */
  async function answer(want, label, next, nextLabel, failure) {
    await press(want);
    log(`✔ TP Details - ${label}`);
    if (await until(next, waits.retryAfter)) return;
    log(`⚠️ TP Details - ${nextLabel} did not show after "${label}" within ${seconds(waits.retryAfter)}s, answering again with a script click`);
    await press(want, { script: true });
    if (await until(next, waits.next)) return;
    throw new Error(failure);
  }

  log("Waiting for the TP Details box (Reliance opens it after Skip To Main Page)...");
  if (!(await until((s) => s.yes.shown, waits.open))) {
    throw new Error(
      `Reliance OD: the TP Details box did not open within ${seconds(waits.open)} seconds after Skip To Main Page, so the run stopped before answering it. ` +
        "Run the policy again, and if it happens again check that Reliance still shows the TP Details box for the product Two Wheeler Own damage Policy."
    );
  }
  log("✅ TP Details box is open");

  await answer(
    "yes",
    "Existing Third Party / Liability Policy Available = Yes",
    (s) => s.rgiclNo.shown,
    "the question about RGICL",
    `Reliance OD: after Yes to Existing Third Party / Liability Policy Available, Reliance did not show the question whether the Third Party Policy is held With RGICL within ${seconds(waits.next)} seconds, so the run stopped there. Run the policy again.`
  );

  await answer(
    "rgiclNo",
    "Third Party Policy held With RGICL = No",
    (s) => s.proceed.shown && s.proceed.enabled,
    "the Proceed button",
    `Reliance OD: after No to Third Party Policy held With RGICL, Reliance did not show the Proceed button within ${seconds(waits.next)} seconds, so the run stopped there. Run the policy again.`
  );

  // Proceed is pressed ONCE. If the box does not go away, that is the answer — never a second press.
  await press("proceed");
  log("✔ TP Details - Proceed pressed");
  const closed = await until((s) => !s.yes.shown && !s.rgiclNo.shown && !s.proceed.shown, waits.closed);
  if (!closed) {
    throw new Error(
      `Reliance OD: the TP Details box was still open ${seconds(waits.closed)} seconds after Proceed, so the run stopped there. ` +
        "Check the box on the portal, and run the policy again."
    );
  }
  if (typeof o.waitLoader === "function") await o.waitLoader();
  await sleep(1500);
  log("✅ TP Details answered (existing third party policy = Yes, held with RGICL = No) - the main page is open");
}

/* -------------------------------------------------------------------------- */
/* 2. The Fuel Type box                                                       */
/* -------------------------------------------------------------------------- */

/** How long each part of the Fuel Type step is waited for (ms). */
const FUEL_WAITS = {
  find: 15000, // the box on screen, enabled, with its list loaded (Reliance fills it after the make / model)
  listOpen: 4000, // the list after the box is clicked
  taken: 3000, // the box showing the chosen text after the item is clicked
  settle: 1200, // a breath after the choice, once Reliance's loader is gone
};

/** "Petrol" / " PETROL " / "petrol." -> "petrol": case, spaces and punctuation do not matter. Nothing fuzzier. */
const fuelKey = (text) => String(text == null ? "" : text).toLowerCase().replace(/[^a-z0-9]+/g, "");
const sameFuel = (a, b) => fuelKey(a) !== "" && fuelKey(a) === fuelKey(b);

/** The placeholder every Reliance dropdown shows before a choice. */
const isPlaceholder = (text) => /^(|-+|(-+\s*)?(please\s+)?(select|choose)\b.*)$/i.test(String(text == null ? "" : text).replace(/\s+/g, " ").trim());

/**
 * Which of Reliance's list items stands for the policy vehicle's fuel type (the owner, 2026-10-23, after a real run: the master
 * row said LPG, Reliance's two-wheeler list is Petrol / Diesel / Bifuel / Battery / Hybrid Electric Vehicle, and he said
 * "select the petrol"):
 *   1. exact          the same text (case, spaces and punctuation ignored): PETROL = Petrol, DIESEL = Diesel
 *   2. Reliance's own name for the same fuel: ELECTRIC / EV / BATTERY = Battery, HYBRID = Hybrid Electric Vehicle,
 *                     PETROL + CNG / PETROL + LPG = Bifuel. If Reliance's list lacks that name there is NO fallback — an
 *                     electric scooter must never become "Petrol".
 *   3. a gas fuel on its own (LPG, CNG)  = Petrol, the owner's decision — with a warning in the log.
 *   anything else    no choice: the caller stops with an exact sentence quoting both.
 * Placeholders ("Select Type") and disabled items are never chosen. The master's own spellings seen in the real database:
 * PETROL, DIESEL, LPG, CNG, PETROL+CNG, PETRO/LPG, ELECTRIC, BATTERY, EV (and typos such as DESAL, HYPER FULE, which stop).
 *
 * @returns {{option:Object, via:"exact"|"equivalent"|"gas-as-petrol"}|null}
 */
function chooseFuelOption(want, options) {
  const usable = (Array.isArray(options) ? options : []).filter((x) => x && !x.disabled && !isPlaceholder(x.text));
  const named = (name) => usable.find((x) => sameFuel(x.text, name));
  const exact = usable.find((x) => sameFuel(x.text, want));
  if (exact) return { option: exact, via: "exact" };
  const key = fuelKey(want);
  const gas = /(lpg|cng)/.test(key);
  const petrol = /petro/.test(key);
  let equivalent = null; // the name Reliance would use, when the policy's word is another spelling of it
  if (/^(electric|electrical|ev|battery|batteryoperated|electricvehicle)$/.test(key)) equivalent = "Battery";
  else if (/^(hybrid|hybridelectric|hybridelectricvehicle|hev)$/.test(key)) equivalent = "Hybrid Electric Vehicle";
  else if (gas && petrol) equivalent = "Bifuel";
  if (equivalent) {
    const found = named(equivalent);
    return found ? { option: found, via: "equivalent" } : null;
  }
  if (gas) {
    const found = named("Petrol");
    return found ? { option: found, via: "gas-as-petrol" } : null;
  }
  return null;
}

/**
 * Every Fuel Type candidate on the page, in one read — found by id / name / aria-owns with "fuel" in it, or by the "Fuel
 * Type" label — plus every dropdown box on the page (for the "not found" sentence). Reads only. Runs IN THE PAGE
 * (self-contained, ES5 style: selenium serialises the source).
 *
 * A Kendo dropdown is a wrapper span (class k-dropdown / k-combobox, aria-owns="<id>_listbox") around the original
 * <select>, which Kendo hides; what the user sees is the wrapper, so "shown" is the wrapper's. Its items are the li of
 * ul#<id>_listbox (they exist in the page before the list is opened; only an open list has them on screen).
 *
 * @returns {{controls: Array<{id, name, tag, kind, listId, shown, disabled, readOnly, text, options, label, how}>,
 *            dropdowns: Array<{id, shown, text}>}}
 */
function readFuelTypeInPage() {
  function norm(t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  }
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function ownText(el) {
    var s = "";
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.nodeValue;
    return norm(s);
  }
  function wrapperOf(el, id) {
    var w = el && el.closest ? el.closest(".k-widget") : null;
    if (w && /k-(dropdown|combobox)/.test(String(w.className))) return w;
    if (id) {
      var owned = document.querySelector('[aria-owns="' + id + '_listbox"]');
      if (owned) return owned;
    }
    return null;
  }
  function textOf(el, wrapper) {
    if (wrapper) {
      var inp = wrapper.querySelector(".k-input");
      if (inp) return norm(inp.tagName === "INPUT" ? inp.value : inp.textContent);
      return norm(wrapper.textContent);
    }
    if (!el) return "";
    if (el.tagName === "SELECT") {
      var o = el.options[el.selectedIndex];
      return o ? norm(o.text) : "";
    }
    return norm(el.value);
  }
  function optionsOf(el, id, wrapper) {
    var out = [];
    var i;
    var ul = id ? document.getElementById(id + "_listbox") : null;
    if (wrapper && ul) {
      var lis = ul.querySelectorAll("li");
      for (i = 0; i < lis.length; i++) {
        var t = norm(lis[i].textContent);
        if (t) out.push({ text: t, disabled: /k-state-disabled/.test(String(lis[i].className)) });
      }
      return out;
    }
    if (el && el.tagName === "SELECT") {
      for (i = 0; i < el.options.length; i++) out.push({ text: norm(el.options[i].text), disabled: !!el.options[i].disabled });
    }
    return out;
  }
  function labelOf(el, id) {
    var l = id ? document.querySelector('label[for="' + id + '"]') : null;
    if (!l && el && el.closest) l = el.closest("label");
    return l ? norm(l.textContent) : "";
  }

  var controls = [];
  var seen = [];
  function describe(el, how) {
    if (!el || seen.indexOf(el) >= 0) return;
    var id = el.id || "";
    var wrapper = wrapperOf(el, id);
    // a candidate that IS the Kendo wrapper (reached by its aria-owns) takes the id of the control it wraps
    if (!wrapper && el.getAttribute && el.getAttribute("aria-owns")) wrapper = el;
    if (wrapper && !id) id = String(wrapper.getAttribute("aria-owns") || "").replace(/_listbox$/, "");
    if (wrapper && seen.indexOf(wrapper) >= 0) return;
    var control = id ? document.getElementById(id) || el : el;
    seen.push(el);
    if (wrapper) seen.push(wrapper);
    if (control) seen.push(control);
    var visibleEl = wrapper || control;
    var disabled = wrapper
      ? wrapper.getAttribute("aria-disabled") === "true" || /k-state-disabled/.test(String(wrapper.className))
      : !!(control && control.disabled);
    controls.push({
      id: id,
      name: (control && control.name) || "",
      tag: String((control && control.tagName) || "").toLowerCase(),
      kind: wrapper ? "kendo" : control && control.tagName === "SELECT" ? "select" : "text",
      listId: wrapper ? String(wrapper.getAttribute("aria-owns") || (id ? id + "_listbox" : "")) : "",
      shown: shown(visibleEl),
      disabled: disabled,
      readOnly: !!(control && !wrapper && control.readOnly),
      text: textOf(control, wrapper),
      options: optionsOf(control, id, wrapper),
      label: labelOf(control, id),
      how: how,
    });
  }

  var i;
  var FUEL = /fuel/i;
  // 1. a select / text box whose id or name says fuel
  var fields = document.querySelectorAll("select, input");
  for (i = 0; i < fields.length; i++) {
    var type = String(fields[i].type || "").toLowerCase();
    if (type === "hidden" || type === "checkbox" || type === "radio" || type === "button" || type === "submit") continue;
    if (FUEL.test(fields[i].id || "") || FUEL.test(fields[i].name || "")) describe(fields[i], "id");
  }
  // 2. a Kendo wrapper whose aria-owns says fuel
  var owners = document.querySelectorAll("[aria-owns]");
  for (i = 0; i < owners.length; i++) {
    if (FUEL.test(String(owners[i].getAttribute("aria-owns")))) describe(owners[i], "aria-owns");
  }
  // 3. the "Fuel Type" label: its for= box, else the first box after it in the same row
  var holders = document.querySelectorAll("label, span, td, th, div, p, b, strong");
  for (i = 0; i < holders.length; i++) {
    var own = ownText(holders[i]);
    if (!own || own.length > 40 || !/^fuel\s*type\b/i.test(own) || !shown(holders[i])) continue;
    var target = holders[i].htmlFor ? document.getElementById(holders[i].htmlFor) : null;
    if (!target) {
      var scope = holders[i].parentElement;
      for (var up = 0; up < 3 && scope && !target; up++, scope = scope.parentElement) {
        var near = scope.querySelectorAll("select, input[type=text], input:not([type]), span[aria-owns]");
        for (var j = 0; j < near.length; j++) {
          if (holders[i].compareDocumentPosition(near[j]) & 4) {
            target = near[j];
            break;
          }
        }
      }
    }
    if (target) describe(target, "label");
  }

  // every dropdown box on the page, for the "not found" sentence
  var dropdowns = [];
  var wraps = document.querySelectorAll("[aria-owns]");
  for (i = 0; i < wraps.length && dropdowns.length < 40; i++) {
    var own2 = String(wraps[i].getAttribute("aria-owns") || "").replace(/_listbox$/, "");
    if (own2) dropdowns.push({ id: own2, shown: shown(wraps[i]), text: textOf(null, wraps[i]) });
  }
  var sels = document.querySelectorAll("select[id]");
  for (i = 0; i < sels.length && dropdowns.length < 40; i++) {
    var sid = sels[i].id;
    var dup = false;
    for (var k = 0; k < dropdowns.length; k++) if (dropdowns[k].id === sid) dup = true;
    if (!dup) dropdowns.push({ id: sid, shown: shown(sels[i]), text: textOf(sels[i], null) });
  }
  return { controls: controls, dropdowns: dropdowns };
}

/** In the page: what to click to open the box's list (a Kendo box's arrow / frame; a native select itself). */
function findKendoOpenerInPage(id, kind) {
  var el = id ? document.getElementById(id) : null;
  if (kind === "kendo") {
    var w = (el && el.closest && el.closest(".k-widget")) || document.querySelector('[aria-owns="' + id + '_listbox"]');
    if (!w) return null;
    return w.querySelector(".k-select") || w.querySelector(".k-dropdown-wrap") || w;
  }
  return el;
}

/** In the page: the open list's item with this text — only an item that is on screen (a closed list has none). */
function findKendoListItemInPage(listId, wanted) {
  function key(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  var ul = document.getElementById(listId);
  if (!ul) return null;
  var lis = ul.querySelectorAll("li");
  for (var i = 0; i < lis.length; i++) {
    var r = lis[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && key(lis[i].textContent) === key(wanted)) return lis[i];
  }
  return null;
}

/** In the page: Kendo's own API — only the last resort, when the open list could not be used (a warning is logged). */
function setKendoByApiInPage(id, wanted) {
  function key(t) {
    return String(t == null ? "" : t).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  var $ = window.jQuery || window.$;
  var el = document.getElementById(id);
  if (!$ || !el) return false;
  var widget = $(el).data("kendoDropDownList") || $(el).data("kendoComboBox");
  if (!widget || !widget.dataSource) return false;
  var items = widget.dataSource.view ? widget.dataSource.view() : [];
  var field = widget.options && (widget.options.dataTextField || "");
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var text = field && item && typeof item === "object" ? item[field] : item;
    if (key(text) === key(wanted)) {
      widget.select(i);
      widget.trigger("change");
      return true;
    }
  }
  return false;
}

// the Fuel Type step's names for the same three functions (the page functions are generic: a box id, a list id, a text)
const findFuelOpenerInPage = findKendoOpenerInPage;
const findFuelListItemInPage = findKendoListItemInPage;
const setFuelByKendoApiInPage = setKendoByApiInPage;

/**
 * Which of the candidates is THE Fuel Type box. Only boxes the user can see count; with several, the one whose label says
 * "Fuel Type"; still several is ambiguous (never a guess).
 *
 * @returns {{state:"found"|"ambiguous"|"hidden-only"|"none", control?:Object, candidates:Object[]}}
 */
function pickFuelControl(snapshot) {
  const controls = (snapshot && Array.isArray(snapshot.controls) ? snapshot.controls : []).filter(Boolean);
  const visible = controls.filter((c) => c.shown);
  if (visible.length === 1) return { state: "found", control: visible[0], candidates: controls };
  if (visible.length > 1) {
    const labelled = visible.filter((c) => /^\s*fuel\s*type\b/i.test(c.label || ""));
    if (labelled.length === 1) return { state: "found", control: labelled[0], candidates: controls };
    // the same box reached twice (by id and by label) is one box
    const ids = [...new Set(visible.map((c) => c.id || c.name))];
    if (ids.length === 1) return { state: "found", control: visible[0], candidates: controls };
    return { state: "ambiguous", candidates: visible };
  }
  return { state: controls.length ? "hidden-only" : "none", candidates: controls };
}

const nameOf = (c) => c.id || c.name || "(no id)";
const quoted = (list) => list.map((t) => `"${t}"`).join(", ");
const plainList = (texts) => texts.map((t) => String(t).replace(/:/g, " -")).join(", ");

/** The dropdown boxes of the page in plain words, for the "not found" sentence. */
function describeDropdowns(snapshot) {
  const list = snapshot && Array.isArray(snapshot.dropdowns) ? snapshot.dropdowns : [];
  if (!list.length) return "no dropdown box could be read from the page";
  const shown = list.filter((d) => d.shown);
  const use = shown.length ? shown : list;
  return `the dropdown boxes on the page are ${plainList(use.slice(0, 25).map((d) => `${d.id || "(no id)"}${d.text ? ` showing ${d.text}` : ""}`))}`;
}

/** One real click on an element (scrolled into view first); a script click only when the real one is refused. */
async function clickLikeUser(driver, element) {
  try {
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
  } catch (e) {
    // scrolling is only a courtesy
  }
  try {
    await element.click();
  } catch (e) {
    await driver.executeScript("arguments[0].click();", element);
  }
}

/**
 * Choose `optionText` in a dropdown box like a person, and say HOW it went. Shared by the Fuel Type and the existing-TP
 * insurer steps. A native select goes through lib/realSelect.js; a Kendo dropdown is clicked open and its item clicked (twice
 * at most), then Kendo's own function is the last resort, with a warning. The caller reads the box back afterwards.
 *
 * @param {Object} driver
 * @param {Object} c
 * @param {Object} c.control      { id, kind: "kendo"|"select", listId }
 * @param {string} c.optionText   the list item's own text
 * @param {string} c.label        "Fuel Type" / "Existing TP insurer" — for the log
 * @param {Function} c.readText   async () => the box's text now (or null)
 * @param {Function} [c.log] [c.now] [c.sleep] [c.pickNative]
 * @param {Object} c.waits        { listOpen, taken }
 * @returns {Promise<"list"|"script"|"">}  "" = nothing took
 */
async function pickFromDropdown(driver, c) {
  const { control, optionText, label, readText, waits } = c;
  const log = c.log || ((line) => console.log(line));
  const now = c.now || Date.now;
  const sleep = c.sleep || ((ms) => driver.sleep(ms));
  /** Wait for the box to show the chosen text. */
  const takes = async (timeoutMs) => {
    const end = now() + timeoutMs;
    for (;;) {
      if (sameFuel(await readText(), optionText)) return true;
      if (now() >= end) return false;
      await sleep(250);
    }
  };
  if (control.kind === "select") {
    const pickNative = c.pickNative || ((d, id, text, opts) => require("../../../lib/realSelect").selectLikeUser(d, id, text, opts));
    const done = await pickNative(driver, control.id, optionText, { label, log });
    return done && done.how === "list" ? "list" : "script";
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const opener = await driver.executeScript(findKendoOpenerInPage, control.id, control.kind);
    if (!opener) break;
    await clickLikeUser(driver, opener);
    let item = null;
    const listEnd = now() + waits.listOpen;
    while (!item && now() < listEnd) {
      item = await driver.executeScript(findKendoListItemInPage, control.listId, optionText);
      if (!item) await sleep(250);
    }
    if (!item) {
      log(`⚠️ ${label} - the list did not open (try ${attempt}/2)`);
      continue;
    }
    await clickLikeUser(driver, item);
    if (await takes(waits.taken)) return "list";
    log(`⚠️ ${label} - the box does not show "${optionText}" after the item was clicked (try ${attempt}/2)`);
  }
  log(`⚠️ ${label} - the list could not be used, choosing "${optionText}" with Kendo's own function instead`);
  let used = false;
  try {
    used = await driver.executeScript(setKendoByApiInPage, control.id, optionText);
  } catch (e) {
    used = false;
  }
  return used && (await takes(waits.taken)) ? "script" : "";
}

/**
 * Choose the policy's fuel type in Reliance's Fuel Type box, like a person, and read it back.
 * Resolves with { id, kind, how } (how = "already" / "list" / "script"); throws a plain Error with the exact reason.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {string} o.fuelType         the policy vehicle's fuel type (lib/vehicleFuelType.js) — required
 * @param {Function} [o.log]
 * @param {Function} [o.waitLoader]   async () => void — the form's own wait for Reliance's loading mask
 * @param {Function} [o.now] [o.sleep]   a fake clock for the tests
 * @param {Object}   [o.waits]        overrides of FUEL_WAITS
 * @param {Function} [o.pickNative]   async (driver, id, text, {label, log}) — a native <select> (default lib/realSelect.js)
 */
async function selectFuelType(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => driver.sleep(ms));
  const waits = { ...FUEL_WAITS, ...(o.waits || {}) };
  const want = String(o.fuelType == null ? "" : o.fuelType).replace(/\s+/g, " ").trim();
  const POLL_MS = 400;
  const NOTHING = "Nothing was saved or paid.";

  if (!want) {
    throw new Error(`Reliance OD: the policy's vehicle has no fuel type, so the Fuel Type box could not be filled and the run stopped there. ${NOTHING}`);
  }

  const read = () => driver.executeScript(readFuelTypeInPage);
  const waitLoader = async () => {
    if (typeof o.waitLoader === "function") await o.waitLoader();
  };

  log(`⛽ Fuel Type - looking for the box (the policy says "${want}")...`);
  await waitLoader();

  // 1. the box: on screen, enabled and with its list loaded — or already showing the right fuel type
  let snapshot = null;
  let picked = null;
  const deadline = now() + waits.find;
  for (;;) {
    try {
      snapshot = await read();
    } catch (e) {
      snapshot = null; // a page that is reloading answers nothing for a moment
    }
    picked = snapshot ? pickFuelControl(snapshot) : { state: "none", candidates: [] };
    if (picked.state === "found") {
      const c = picked.control;
      if (sameFuel(c.text, want)) break; // right already, whatever else is going on
      if (!c.disabled && (c.kind === "text" || c.options.some((x) => !isPlaceholder(x.text)))) break;
    }
    if (now() >= deadline) break;
    await sleep(POLL_MS);
  }

  const seconds = Math.round(waits.find / 1000);
  if (picked.state === "none") {
    throw new Error(
      `Reliance OD: the Fuel Type box was not found on the page within ${seconds} seconds, so the run stopped there. ` +
        `The policy says "${want}". ${snapshot ? `In the page ${describeDropdowns(snapshot)}.` : "The page could not be read."} ${NOTHING}`
    );
  }
  if (picked.state === "hidden-only") {
    throw new Error(
      `Reliance OD: a Fuel Type box exists (${plainList(picked.candidates.map(nameOf))}) but it was not on screen within ${seconds} seconds, so the run stopped there. ${NOTHING}`
    );
  }
  if (picked.state === "ambiguous") {
    throw new Error(
      `Reliance OD: more than one Fuel Type box is on the page (${plainList(picked.candidates.map(nameOf))}), so it is not known which to fill and the run stopped there. ${NOTHING}`
    );
  }

  const control = picked.control;
  const where = `id ${nameOf(control)}`;
  log(
    `⛽ Fuel Type - found the box (${where}, ${control.kind === "kendo" ? "a Kendo dropdown" : control.kind === "select" ? "a select" : "a text box"}, found by its ${control.how}), ` +
      `showing "${control.text || "nothing"}", ${control.disabled || control.readOnly ? "locked" : "usable"}, its list ${control.options.length ? quoted(control.options.slice(0, 20).map((x) => x.text)) : "is empty"}`
  );
  if (sameFuel(control.text, want)) {
    log(`✅ Fuel Type is already "${control.text}" (${where})`);
    return { id: control.id, kind: control.kind, how: "already" };
  }
  if (control.disabled || control.readOnly) {
    throw new Error(
      `Reliance OD: Reliance fixed the Fuel Type as "${control.text || "nothing"}" for this vehicle and does not let it be changed, but the policy's vehicle says "${want}". ` +
        `Check the vehicle in Master then Make and Model, then run the policy again. ${NOTHING}`
    );
  }
  const options = control.options.filter((x) => !isPlaceholder(x.text));
  if (control.kind !== "text" && options.length === 0) {
    throw new Error(`Reliance OD: the Fuel Type list (${where}) stayed empty for ${seconds} seconds, so "${want}" could not be chosen and the run stopped there. ${NOTHING}`);
  }
  if (control.kind === "text") {
    throw new Error(
      `Reliance OD: the Fuel Type box (${where}) is a plain text box showing "${control.text}", not a list, so "${want}" was not typed into it and the run stopped there. ${NOTHING}`
    );
  }
  const choice = chooseFuelOption(want, options);
  if (!choice) {
    throw new Error(
      `Reliance OD: Reliance's Fuel Type list (${where}) does not offer "${want}" and has no name for it - it offers ${quoted(options.map((x) => x.text))}. ` +
        `Check the fuel type of the vehicle in Master then Make and Model, then run the policy again. ${NOTHING}`
    );
  }
  const option = choice.option;
  if (choice.via === "gas-as-petrol") {
    log(`⚠️ Fuel Type - Reliance's list has no "${want}" (it offers ${quoted(options.map((x) => x.text))}); choosing "${option.text}" for a gas fuel on its own, as the owner decided`);
  } else if (choice.via === "equivalent") {
    log(`⛽ Fuel Type - Reliance calls "${want}" "${option.text}"`);
  }
  log(`⛽ Fuel Type - choosing "${option.text}"`);

  /** The box's text now. */
  const shownNow = async () => {
    try {
      const again = pickFuelControl(await read());
      const same = again.state === "found" ? again.control : (again.candidates || []).find((x) => nameOf(x) === nameOf(control));
      return same ? same.text : null;
    } catch (e) {
      return null;
    }
  };
  const how = await pickFromDropdown(driver, { control, optionText: option.text, label: "Fuel Type", readText: shownNow, log, now, sleep, waits, pickNative: o.pickNative });

  await waitLoader();
  await sleep(waits.settle);
  const finalText = await shownNow();
  if (!how || !sameFuel(finalText, option.text)) {
    throw new Error(
      `Reliance OD: the Fuel Type box (${where}) shows "${finalText == null ? "nothing readable" : finalText}" instead of "${option.text}", so the run stopped there. ${NOTHING}`
    );
  }
  log(`✅ Fuel Type set to "${finalText}"${how === "list" ? " (picked from the open list)" : " (by script - the list could not be used)"}`);
  return { id: control.id, kind: control.kind, how, chosen: finalText, via: choice.via };
}

/* -------------------------------------------------------------------------- */
/* 2b. The existing third party policy panel                                  */
/* -------------------------------------------------------------------------- */

/** How long each part of the existing-TP step is waited for (ms). */
const TP_WAITS = {
  panel: 8000, // the panel open after its icon is clicked / the number box on screen
  find: 10000, // the insurer's list with the insurer in it
  listOpen: 4000,
  taken: 3000,
  typed: 1500, // a typed value to show in its box
  settle: 1000,
};

const TP_IDS = { number: "txtExistingTPPolicyNo", start: "dpExistingTPPolicyRiskStartDate", end: "dpExistingTPPolicyRiskEndDate", addressSame: "IsRegistrationAddresssame" };

/**
 * The existing-TP panel in one read: its three boxes by the ids the owner pasted (2026-10-23), the panel they sit in (a Kendo
 * PanelBar item — its header and whether its expand / collapse icon is on screen) and every panel header on the page. Reads
 * only. Runs IN THE PAGE (self-contained).
 */
function readExistingTpInPage() {
  function norm(t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  }
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function box(id) {
    var el = document.getElementById(id);
    return { exists: !!el, shown: shown(el), disabled: !!(el && (el.disabled || el.readOnly)), value: el ? norm(el.value) : "" };
  }
  var number = document.getElementById("txtExistingTPPolicyNo");
  var item = number && number.closest ? number.closest("li.k-item, li.k-panelbar-item") : null;
  var panel = null;
  if (item) {
    var link = item.querySelector(".k-link");
    panel = {
      header: link ? norm(link.textContent) : "",
      expandShown: shown(item.querySelector(".k-link .k-panelbar-expand")),
      collapseShown: shown(item.querySelector(".k-link .k-panelbar-collapse")),
    };
  }
  var headers = [];
  var links = document.querySelectorAll(".k-panelbar .k-link");
  for (var i = 0; i < links.length && headers.length < 12; i++) {
    var t = norm(links[i].textContent);
    if (t && headers.indexOf(t) < 0) headers.push(t);
  }
  return { number: box("txtExistingTPPolicyNo"), start: box("dpExistingTPPolicyRiskStartDate"), end: box("dpExistingTPPolicyRiskEndDate"), panel: panel, headers: headers };
}

/** In the page: the icon (else the header) to click to expand the panel that holds the policy number box. */
function findExistingTpExpanderInPage() {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var number = document.getElementById("txtExistingTPPolicyNo");
  var item = number && number.closest ? number.closest("li.k-item, li.k-panelbar-item") : null;
  if (item) {
    var icon = item.querySelector(".k-link .k-panelbar-expand");
    if (shown(icon)) return icon;
    var link = item.querySelector(".k-link");
    return shown(link) ? link : null;
  }
  // the box is not in the page: the expand icon of a panel whose header talks about a third party policy
  var icons = document.querySelectorAll(".k-panelbar .k-link .k-panelbar-expand");
  for (var i = 0; i < icons.length; i++) {
    var header = icons[i].closest ? icons[i].closest(".k-link") : null;
    if (shown(icons[i]) && header && /third\s*party|existing\s*tp|tp\s*polic/i.test(String(header.textContent || ""))) return icons[i];
  }
  return null;
}

/** In the page: an element by its id (to click / type into), or null. */
function findElementByIdInPage(id) {
  return document.getElementById(id);
}

/**
 * The dropdown boxes INSIDE the existing-TP panel (the insurer's id was never seen, so it is found by what is in its list):
 * each Kendo dropdown (a wrapper whose aria-owns ends in _listbox — a DatePicker's aria-owns is a different thing) and each
 * native select that is not already inside one. Reads only. Runs IN THE PAGE.
 *
 * @returns {Array<{id, kind, listId, shown, disabled, text, options:[{text,disabled}]}>}
 */
function readInsurerBoxesInPage() {
  function norm(t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  }
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var number = document.getElementById("txtExistingTPPolicyNo");
  var item = number && number.closest ? number.closest("li.k-item, li.k-panelbar-item") : null;
  var scope = item || document;
  var out = [];
  var i;
  function textOfWrapper(wrapper) {
    var inp = wrapper.querySelector(".k-input");
    return inp ? norm(inp.tagName === "INPUT" ? inp.value : inp.textContent) : norm(wrapper.textContent);
  }
  var wraps = scope.querySelectorAll("[aria-owns]");
  for (i = 0; i < wraps.length; i++) {
    var owns = String(wraps[i].getAttribute("aria-owns") || "");
    if (!/_listbox$/.test(owns)) continue;
    var id = owns.replace(/_listbox$/, "");
    var ul = document.getElementById(owns);
    var options = [];
    if (ul) {
      var lis = ul.querySelectorAll("li");
      for (var j = 0; j < lis.length; j++) {
        var t = norm(lis[j].textContent);
        if (t) options.push({ text: t, disabled: /k-state-disabled/.test(String(lis[j].className)) });
      }
    }
    out.push({
      id: id,
      kind: "kendo",
      listId: owns,
      shown: shown(wraps[i]),
      disabled: wraps[i].getAttribute("aria-disabled") === "true" || /k-state-disabled/.test(String(wraps[i].className)),
      text: textOfWrapper(wraps[i]),
      options: options,
    });
  }
  var sels = scope.querySelectorAll("select");
  for (i = 0; i < sels.length; i++) {
    if (sels[i].closest && sels[i].closest(".k-widget")) continue; // a Kendo box: already listed through its wrapper
    var opts = [];
    for (var k = 0; k < sels[i].options.length; k++) opts.push({ text: norm(sels[i].options[k].text), disabled: !!sels[i].options[k].disabled });
    var so = sels[i].options[sels[i].selectedIndex];
    out.push({ id: sels[i].id || "", kind: "select", listId: "", shown: shown(sels[i]), disabled: !!sels[i].disabled, text: so ? norm(so.text) : "", options: opts });
  }
  return out;
}

/** In the page: set a Kendo DatePicker through its own API, then fire the DOM change the page's own validator listens to. */
function setDateByKendoApiInPage(id, year, month, day) {
  var $ = window.jQuery || window.$;
  var el = document.getElementById(id);
  if (!$ || !el) return false;
  var widget = $(el).data("kendoDatePicker");
  if (!widget) return false;
  widget.value(new Date(year, month - 1, day));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** In the page: the OLD way (value + input + change) — the pattern the form's other date boxes use. Only the last resort. */
function setValueByScriptInPage(id, text) {
  var el = document.getElementById(id);
  if (!el) return false;
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** In the page: the "Is Registration Address Same" box. */
function readAddressSameInPage() {
  var el = document.getElementById("IsRegistrationAddresssame");
  if (!el) return { exists: false, shown: false, checked: false, disabled: false };
  var rect = el.getBoundingClientRect();
  var style = window.getComputedStyle(el);
  return {
    exists: true,
    shown: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
    checked: !!el.checked,
    disabled: !!el.disabled,
  };
}

/**
 * The list item of the insurer's list for this insurer — "KSHEMA General Insurance Limited" / "National Insurance Company
 * Limited" (the owner's names) — matched by its text (kshema, nationalinsurance), and only when it is the ONE such item.
 * @returns {{option:Object|null, why?:"none"|"many", hits?:Object[]}}
 */
function chooseInsurerOption(insurerKey, options) {
  const usable = (Array.isArray(options) ? options : []).filter((x) => x && !x.disabled && !isPlaceholder(x.text));
  const word = insurerKey === "kshema" ? "kshema" : "nationalinsurance";
  const hits = usable.filter((x) => fuelKey(x.text).includes(word));
  if (hits.length === 1) return { option: hits[0] };
  return { option: null, why: hits.length ? "many" : "none", hits };
}

/** The same calendar day? A box may show 01/10/2026 or 01-10-2026 for 01-10-2026; Kendo decides how it writes it. */
function sameDayText(boxText, expectedText) {
  const a = parseDay(boxText);
  const b = parseDay(expectedText);
  return !!a && !!b && a.day === b.day;
}

/** The text of an alert() that is open right now (accepted, so the page can go on), or "" when none is. */
async function takeAlertText(driver) {
  try {
    const alert = await driver.switchTo().alert();
    const text = String((await alert.getText()) || "").replace(/\s+/g, " ").trim();
    try {
      await alert.accept();
    } catch (e) {
      // it is gone already
    }
    return text || "(an empty message)";
  } catch (e) {
    return "";
  }
}

/** Look for an alert() for `ms` — the page raises one a moment after a click, and the next driver command would swallow it. */
async function watchForAlert(driver, { ms = 2500, now = Date.now, sleep = (t) => driver.sleep(t) } = {}) {
  const end = now() + ms;
  for (;;) {
    const text = await takeAlertText(driver);
    if (text) return text;
    if (now() >= end) return "";
    await sleep(300);
  }
}

/** A portal sentence made safe for an operator sentence (one colon rule). */
const portalText = (t) => String(t == null ? "" : t).replace(/\s*:\s*/g, " - ").replace(/\s+/g, " ").trim();

/**
 * Enter the customer's existing third party policy on the OD form: open the panel (only when it is collapsed), the policy
 * number, the insurer and the start / end dates — then read all four back. Every failure has its own sentence.
 *
 * @param {Object} driver
 * @param {Object} o
 * @param {{policyNumber:string, insurer:{key:string,label:string,pageName:string}, startDate:string, endDate:string}} o.tp
 *        the validated details (lib/existingTpDetails.js)
 * @param {Function} [o.log] [o.waitLoader] [o.now] [o.sleep] [o.waits] [o.pickNative]
 */
async function fillExistingTpPolicy(driver, o = {}) {
  const tp = o.tp;
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => driver.sleep(ms));
  const waits = { ...TP_WAITS, ...(o.waits || {}) };
  const NOTHING = "Nothing was saved or paid.";
  const POLL_MS = 400;
  const waitLoader = async () => {
    if (typeof o.waitLoader === "function") await o.waitLoader();
  };
  const read = () => driver.executeScript(readExistingTpInPage);
  /** Poll the panel until `ready(state)`; the last state either way. */
  const until = async (ready, timeoutMs) => {
    const end = now() + timeoutMs;
    let state = null;
    for (;;) {
      try {
        state = await read();
      } catch (e) {
        state = state || null; // a page that is reloading answers nothing for a moment
      }
      if (state && ready(state)) return { ok: true, state };
      if (now() >= end) return { ok: false, state };
      await sleep(POLL_MS);
    }
  };
  const headersOf = (state) => (state && state.headers && state.headers.length ? `The panels on the page are ${plainList(state.headers)}.` : "No panel could be read from the page.");

  log(`Existing TP - the customer's existing third party policy ${tp.policyNumber} at ${tp.insurer.pageName}, ${tp.startDate} to ${tp.endDate}...`);

  // 1. the panel: open by default; only a collapsed one is opened
  let seen = await until((s) => s.number.exists, waits.panel);
  if (!seen.ok) {
    throw new Error(
      `Reliance OD: the existing TP policy number box (${TP_IDS.number}) was not found on the page within ${seconds(waits.panel)} seconds, so the run stopped there. ${headersOf(seen.state)} ${NOTHING}`
    );
  }
  if (seen.state.number.shown) {
    log("✅ Existing TP - the panel is already open, not clicked");
  } else {
    log(`Existing TP - the panel${seen.state.panel && seen.state.panel.header ? ` "${seen.state.panel.header}"` : ""} is collapsed, opening it...`);
    for (let attempt = 1; attempt <= 2 && !(seen.state && seen.state.number.shown); attempt++) {
      const expander = await driver.executeScript(findExistingTpExpanderInPage);
      if (!expander) break;
      if (attempt === 1) await clickLikeUser(driver, expander);
      else await driver.executeScript("arguments[0].click();", expander);
      seen = await until((s) => s.number.shown, waits.panel);
    }
    if (!(seen.state && seen.state.number.shown)) {
      throw new Error(
        `Reliance OD: the existing third party panel did not open - its policy number box (${TP_IDS.number}) is still not on screen after the expand icon was clicked, so the run stopped there. ${headersOf(seen.state)} ${NOTHING}`
      );
    }
    log("✅ Existing TP - the panel is open");
  }

  /** Real typing into a box (click, clear, type, TAB — the page's onblur / onchange run), read back; the script way only as the last resort. */
  const typeInto = async (id, text, label, same) => {
    const field = () => driver.executeScript(findElementByIdInPage, id);
    let element = await field();
    if (!element) throw new Error(`Reliance OD: the existing TP ${label} box (${id}) was not found on the page, so the run stopped there. ${NOTHING}`);
    const Key = require("selenium-webdriver").Key;
    const shownValue = async () => {
      const s = await read();
      return id === TP_IDS.number ? s.number.value : id === TP_IDS.start ? s.start.value : s.end.value;
    };
    try {
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
      await element.click();
      await element.clear();
      await element.sendKeys(text);
      await element.sendKeys(Key.TAB);
    } catch (e) {
      const said = alertTextOf(e);
      if (said) {
        throw new Error(`Reliance OD: Reliance refused the existing TP ${label} ${text} with the message "${portalText(said)}", so the run stopped there. ${NOTHING}`);
      }
      log(`⚠️ Existing TP - typing the ${label} failed, trying the page's own way (${portalText((e && e.message) || e).slice(0, 80)})`);
    }
    let alertText = await watchForAlert(driver, { ms: 700, now, sleep });
    if (alertText) throw new Error(`Reliance OD: Reliance refused the existing TP ${label} ${text} with the message "${portalText(alertText)}", so the run stopped there. ${NOTHING}`);
    const end = now() + waits.typed;
    let value = await shownValue();
    while (!same(value, text) && now() < end) {
      await sleep(250);
      value = await shownValue();
    }
    return { value, same: same(value, text) };
  };

  // 2. the policy number
  let r = await typeInto(TP_IDS.number, tp.policyNumber, "policy number", (a, b) => String(a).replace(/\s+/g, "").toUpperCase() === String(b).replace(/\s+/g, "").toUpperCase());
  if (!r.same) {
    throw new Error(`Reliance OD: the existing TP policy number box (${TP_IDS.number}) shows "${portalText(r.value) || "nothing"}" instead of "${tp.policyNumber}" after it was typed, so the run stopped there. ${NOTHING}`);
  }
  log(`✔ Existing TP - policy number ${tp.policyNumber}`);

  // 3. the insurer: the dropdown of the panel whose list has this insurer
  let boxes = [];
  let hit = null;
  const insurerDeadline = now() + waits.find;
  for (;;) {
    try {
      boxes = await driver.executeScript(readInsurerBoxesInPage);
    } catch (e) {
      boxes = boxes || [];
    }
    const withInsurer = (Array.isArray(boxes) ? boxes : []).filter((b) => b.shown && chooseInsurerOption(tp.insurer.key, b.options).option);
    if (withInsurer.length === 1) {
      hit = withInsurer[0];
      if (!hit.disabled) break;
    } else if (withInsurer.length > 1) {
      throw new Error(
        `Reliance OD: more than one dropdown of the existing TP panel offers ${tp.insurer.pageName} (${plainList(withInsurer.map((b) => b.id || "(no id)"))}), so it is not known which to fill and the run stopped there. ${NOTHING}`
      );
    }
    if (now() >= insurerDeadline) break;
    await sleep(POLL_MS);
  }
  const listOf = (b) => quoted(b.options.filter((x) => !isPlaceholder(x.text)).map((x) => x.text));
  if (!hit) {
    const visible = (Array.isArray(boxes) ? boxes : []).filter((b) => b.shown);
    throw new Error(
      `Reliance OD: no dropdown of the existing TP panel offers ${tp.insurer.pageName}, so the run stopped there. ` +
        `${visible.length ? `The dropdowns in the panel are ${plainList(visible.map((b) => `${b.id || "(no id)"} offering ${listOf(b) || "nothing"}`))}.` : "The panel shows no dropdown."} ${NOTHING}`
    );
  }
  if (hit.disabled) {
    throw new Error(`Reliance OD: the insurer dropdown (id ${hit.id || "(no id)"}) of the existing TP panel is disabled, so ${tp.insurer.pageName} could not be chosen and the run stopped there. ${NOTHING}`);
  }
  const option = chooseInsurerOption(tp.insurer.key, hit.options).option;
  log(`⛽ Existing TP - the insurer box is ${hit.kind === "kendo" ? "a Kendo dropdown" : "a select"} (id ${hit.id || "(no id)"}), now "${hit.text || "nothing"}", its list ${listOf(hit)}; choosing "${option.text}"`);
  const insurerText = async () => {
    try {
      const again = await driver.executeScript(readInsurerBoxesInPage);
      const mine = (Array.isArray(again) ? again : []).find((b) => b.id === hit.id && b.kind === hit.kind);
      return mine ? mine.text : null;
    } catch (e) {
      return null;
    }
  };
  if (!sameFuel(hit.text, option.text)) {
    const how = await pickFromDropdown(driver, { control: hit, optionText: option.text, label: "Existing TP insurer", readText: insurerText, log, now, sleep, waits, pickNative: o.pickNative });
    await waitLoader();
    await sleep(waits.settle);
    const finalText = await insurerText();
    if (!how || !sameFuel(finalText, option.text)) {
      throw new Error(`Reliance OD: the existing TP insurer box (id ${hit.id || "(no id)"}) shows "${finalText == null ? "nothing readable" : portalText(finalText)}" instead of "${option.text}", so the run stopped there. ${NOTHING}`);
    }
  }
  log(`✔ Existing TP - insurer ${option.text}`);

  // 4. the dates: typed like a person; Kendo's own API, then the page's old script way, only when typing does not take
  const enterDate = async (id, text, label) => {
    const day = parseDay(text);
    const same = (a, b) => sameDayText(a, b);
    let result = await typeInto(id, text, label, same);
    if (result.same) return "typed";
    log(`⚠️ Existing TP - the ${label} box shows "${portalText(result.value) || "nothing"}" after typing ${text}, setting it through the date picker's own function`);
    let used = false;
    try {
      used = await driver.executeScript(setDateByKendoApiInPage, id, Number(text.slice(6)), Number(text.slice(3, 5)), Number(text.slice(0, 2)));
    } catch (e) {
      const said = alertTextOf(e);
      if (said) throw new Error(`Reliance OD: Reliance refused the existing TP ${label} ${text} with the message "${portalText(said)}", so the run stopped there. ${NOTHING}`);
    }
    let alertText = await watchForAlert(driver, { ms: 700, now, sleep });
    if (alertText) throw new Error(`Reliance OD: Reliance refused the existing TP ${label} ${text} with the message "${portalText(alertText)}", so the run stopped there. ${NOTHING}`);
    let state = (await read())[id === TP_IDS.start ? "start" : "end"];
    if (used && same(state.value, text)) return "kendo";
    log(`⚠️ Existing TP - the ${label} box still shows "${portalText(state.value) || "nothing"}", setting it the way the form's other date boxes are set`);
    try {
      await driver.executeScript(setValueByScriptInPage, id, text);
    } catch (e) {
      const said = alertTextOf(e);
      if (said) throw new Error(`Reliance OD: Reliance refused the existing TP ${label} ${text} with the message "${portalText(said)}", so the run stopped there. ${NOTHING}`);
    }
    alertText = await watchForAlert(driver, { ms: 700, now, sleep });
    if (alertText) throw new Error(`Reliance OD: Reliance refused the existing TP ${label} ${text} with the message "${portalText(alertText)}", so the run stopped there. ${NOTHING}`);
    state = (await read())[id === TP_IDS.start ? "start" : "end"];
    if (same(state.value, text)) return "script";
    throw new Error(`Reliance OD: the existing TP ${label} box (${id}) shows "${portalText(state.value) || "nothing"}" instead of ${text}, so the run stopped there. ${NOTHING}`);
  };
  const startHow = await enterDate(TP_IDS.start, tp.startDate, "start date");
  log(`✔ Existing TP - start date ${tp.startDate}${startHow === "typed" ? "" : ` (${startHow === "kendo" ? "through the date picker's own function" : "by script"})`}`);
  const endHow = await enterDate(TP_IDS.end, tp.endDate, "end date");
  log(`✔ Existing TP - end date ${tp.endDate}${endHow === "typed" ? "" : ` (${endHow === "kendo" ? "through the date picker's own function" : "by script"})`}`);

  // 5. let the page's validators finish, then read all four back and ask what Reliance said
  await waitLoader();
  await sleep(waits.settle);
  const lateAlert = await watchForAlert(driver, { ms: 700, now, sleep });
  if (lateAlert) throw new Error(`Reliance OD: Reliance showed the message "${portalText(lateAlert)}" after the existing TP policy was entered, so the run stopped there. ${NOTHING}`);
  const finalState = await read();
  const problems = [];
  if (String(finalState.number.value).replace(/\s+/g, "").toUpperCase() !== tp.policyNumber.replace(/\s+/g, "")) problems.push(`the policy number box shows "${portalText(finalState.number.value) || "nothing"}"`);
  if (!sameDayText(finalState.start.value, tp.startDate)) problems.push(`the start date box shows "${portalText(finalState.start.value) || "nothing"}"`);
  if (!sameDayText(finalState.end.value, tp.endDate)) problems.push(`the end date box shows "${portalText(finalState.end.value) || "nothing"}"`);
  if ((await insurerText()) !== null && !sameFuel(await insurerText(), option.text)) problems.push(`the insurer box shows "${portalText(await insurerText()) || "nothing"}"`);
  let words = null;
  try {
    words = await driver.executeScript(readPortalWordsInPage);
  } catch (e) {
    words = null;
  }
  const refusal = words ? refusalWords(words) : "";
  if (problems.length || refusal) {
    throw new Error(
      `Reliance OD: after the existing TP policy was entered ${problems.length ? `${problems.join(" and ")}${refusal ? ` - ${refusal}` : ""}` : refusal}, so the run stopped there. ${NOTHING}`
    );
  }
  log(`✅ Existing TP policy ${tp.policyNumber} at ${option.text}, ${tp.startDate} to ${tp.endDate} entered`);
  return { insurer: option.text, startHow, endHow };
}

/** What in Reliance's words reads as a refusal — strict on purpose: a friendly popup must not stop a good run. */
const REFUSAL = /\b(please\s+(select|enter|provide|fill|choose|check)|is\s+required|are\s+required|required\s+field|mandatory|invalid|not\s+allowed|not\s+permitted|not\s+eligible|not\s+found|cannot|can\s?not|unable|failed|error\s*code|should\s+(not|be)|must\s+be|kindly)\b/i;

/** The refusal part of what the page said (popups, field messages and message bars), as an operator sentence part, or "". */
function refusalWords(words) {
  const w = words || {};
  const said = [...(w.popups || []), ...(w.messages || []), ...(w.banners || []), ...(w.main ? [w.main] : [])].filter((t) => REFUSAL.test(t));
  return said.length ? `Reliance said ${quoted(said.map(portalText))}` : "";
}

/**
 * The message bars (see readPortalWordsInPage) that were already on the page when Calculate Premium was checked: a footer or
 * a tip that is always there is not the reason Save failed. Kept per browser, forgotten with it.
 */
const barsBefore = new WeakMap();

/**
 * "Is Registration Address Same" — ticked ONLY if it is not ticked (the owner, 2026-10-23). The full flow clicks it blindly
 * (a toggle), which would UN-tick a box the OD page ticks by default. Read, click once if needed, read back.
 */
async function ensureAddressSame(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => driver.sleep(ms));
  const findMs = (o.waits && o.waits.find) || 10000;
  const NOTHING = "Nothing was saved or paid.";
  const end = now() + findMs;
  let state = null;
  for (;;) {
    try {
      state = await driver.executeScript(readAddressSameInPage);
    } catch (e) {
      state = null;
    }
    if (state && state.exists) break;
    if (now() >= end) {
      throw new Error(`Reliance OD: the "Is Registration Address Same" box (${TP_IDS.addressSame}) was not found within ${seconds(findMs)} seconds, so the run stopped there. ${NOTHING}`);
    }
    await sleep(400);
  }
  if (state.checked) {
    log("✅ 'Is Registration Address Same' is already ticked, not clicked");
    return { how: "already" };
  }
  if (state.disabled) {
    throw new Error(`Reliance OD: the "Is Registration Address Same" box is not ticked and Reliance does not let it be ticked, so the run stopped there. ${NOTHING}`);
  }
  let how = "";
  for (let attempt = 1; attempt <= 2 && !how; attempt++) {
    const element = await driver.executeScript(findElementByIdInPage, TP_IDS.addressSame);
    if (!element) break;
    if (attempt === 1) await clickLikeUser(driver, element);
    else await driver.executeScript("arguments[0].click();", element);
    await sleep(o.settleMs == null ? 2000 : o.settleMs);
    const now2 = await driver.executeScript(readAddressSameInPage);
    if (now2 && now2.checked) how = attempt === 1 ? "clicked" : "script";
    else log(`⚠️ 'Is Registration Address Same' is still not ticked after the click (try ${attempt}/2)`);
  }
  if (!how) throw new Error(`Reliance OD: the "Is Registration Address Same" box stayed unticked after it was clicked, so the run stopped there. ${NOTHING}`);
  log("✅ 'Is Registration Address Same' ticked");
  return { how };
}

/**
 * Right after the Calculate Premium click: an alert() the page raises is the answer (the next command would swallow it).
 * Throws the exact sentence; returns quietly when there is none.
 */
async function afterCalculatePremiumClick(driver, o = {}) {
  const text = await watchForAlert(driver, { ms: o.ms == null ? 2500 : o.ms, now: o.now, sleep: o.sleep });
  if (text) {
    throw new Error(`Reliance OD: Reliance showed the message "${portalText(text)}" when Calculate Premium was pressed, so the run stopped there. Nothing was saved or paid.`);
  }
}

/** After the premium is calculated: a refusal Reliance put on the page (a popup / field message that reads as one) is the answer. */
async function afterCalculatePremium(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  let words = null;
  try {
    words = await driver.executeScript(readPortalWordsInPage);
  } catch (e) {
    const said = alertTextOf(e);
    if (said) throw keepSentence(new Error(`Reliance OD: Reliance showed the message "${portalText(said)}" after Calculate Premium, so the run stopped there. Nothing was saved or paid.`));
  }
  const refusal = words ? refusalWords(words) : "";
  if (refusal) {
    throw keepSentence(new Error(`Reliance OD: Reliance did not accept Calculate Premium - ${refusal}${words.empty && words.empty.length ? `; these required boxes look empty - ${plainList(words.empty)}` : ""}, so the run stopped there. Nothing was saved or paid.`));
  }
  if (words && Array.isArray(words.banners)) barsBefore.set(driver, words.banners.slice());
  log("✅ Calculate Premium - Reliance showed no refusal");
}

/** Right after the Save click: an alert() is the answer. */
async function afterSaveClick(driver, o = {}) {
  const text = await watchForAlert(driver, { ms: o.ms == null ? 2500 : o.ms, now: o.now, sleep: o.sleep });
  if (text) {
    throw new Error(
      `Reliance OD: Reliance showed the message "${portalText(text)}" when Save was pressed, so no proposal number was read and the run stopped there. Check in Reliance (View Policy) whether the proposal was saved before running the policy again.`
    );
  }
}

/**
 * The error for a Save that did not show "Proposal Saved Successfully": what the page says, in Reliance's own words. Returns the
 * Error (the form throws it) so the original's bare "Proposal number extraction failed" is replaced for the OD part only.
 */
async function explainSaveFailure(driver) {
  let words = null;
  let alertText = "";
  try {
    words = await driver.executeScript(readPortalWordsInPage);
  } catch (e) {
    alertText = alertTextOf(e);
  }
  // only what Save brought: a bar that was already there when Calculate Premium was checked (a footer, a tip) is not the reason
  if (words && Array.isArray(words.banners)) {
    const before = barsBefore.get(driver) || [];
    words = { ...words, banners: words.banners.filter((t) => !before.includes(t)) };
  }
  return keepSentence(
    new Error(
      `Reliance OD: Save did not show "Proposal Saved Successfully", so no proposal number was read and the run stopped there. ` +
        `${alertText ? `Reliance showed the message "${portalText(alertText)}". ` : ""}On the page ${describePortalWords(words, { cover: false })}. ` +
        `Check in Reliance (View Policy) whether the proposal was saved before running the policy again.`
    )
  );
}

/** The form's failure catch must not replace an exact sentence with whatever #containerMain says (the same flag the wallet and KYC sentences carry). */
function keepSentence(error) {
  error.keepMessage = true;
  return error;
}

/* -------------------------------------------------------------------------- */
/* 3. The cover table must be there                                           */
/* -------------------------------------------------------------------------- */

/**
 * What Reliance is saying on the page right now, in one read — the words, whatever they are: the cover box, an open popup,
 * a field's message, and the required boxes (a label ending in "*") that look empty. Reads only. Runs IN THE PAGE.
 */
function readPortalWordsInPage() {
  function norm(t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  }
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  function ownText(el) {
    var s = "";
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) s += n.nodeValue;
    return norm(s);
  }
  var out = { cover: "", popups: [], messages: [], banners: [], main: "", empty: [] };
  var i;
  function push(list, text, max) {
    text = norm(text);
    if (text && text.length <= max && list.indexOf(text) < 0 && list.length < 6) list.push(text);
  }
  var box = document.getElementById("DivCoverDetails");
  if (box) out.cover = norm(box.innerText || box.textContent).slice(0, 300);

  // a popup's own words — without its buttons (OK, Close ...), which are not part of what Reliance said
  function wordsOf(el) {
    var copy = el.cloneNode(true);
    var drop = copy.querySelectorAll("button, input[type=button], input[type=submit], .ui-dialog-buttonpane, .ui-dialog-titlebar-close, .k-window-actions, .k-dialog-buttongroup, script, style");
    for (var d = 0; d < drop.length; d++) if (drop[d].parentNode) drop[d].parentNode.removeChild(drop[d]);
    return norm(copy.textContent);
  }
  var popupSelectors = ".ui-dialog, .k-window, .modal, .swal2-popup, .sweet-alert, .bootbox, [role=dialog], [role=alertdialog], .alert, .k-notification, .toast, .ui-notification";
  var popups = document.querySelectorAll(popupSelectors);
  for (i = 0; i < popups.length; i++) if (shown(popups[i])) push(out.popups, wordsOf(popups[i]), 400);

  var messageSelectors = ".field-validation-error, .k-invalid-msg, .validation-summary-errors, .text-danger, .errorMsg, .error-message, .help-block";
  var messages = document.querySelectorAll(messageSelectors);
  for (i = 0; i < messages.length; i++) if (shown(messages[i])) push(out.messages, messages[i].innerText || messages[i].textContent, 200);

  // the page's own error area (the failure catch of the form reads the same box): only while it is on screen
  var area = document.getElementById("containerMain");
  if (area && shown(area)) out.main = norm(area.innerText || area.textContent).slice(0, 300);

  // message bars: Reliance shows some refusals in a strip nobody gave a known class (2026-10-23, the first live OD run: a bar
  // across the bottom of the page - "As per entered Registration Number the Vehicle Class is Goods Carrier ... not permitted ...").
  // A visible element whose class / id says message, alert, error ..., or one pinned (position fixed) to the top or the bottom of
  // the window, with a sentence in it and no input boxes; the INNERMOST one only, each text once.
  var barHint = /(^|[\s_-])(toast\w*|notif\w*|alert\w*|msg\w*|message\w*|error\w*|err|warn\w*|danger|flash|snack\w*|banner|info\w*)([\s_-]|$)/i;
  var skipBar = /^(SCRIPT|STYLE|NOSCRIPT|SELECT|OPTION|OPTGROUP|INPUT|TEXTAREA|BUTTON|IFRAME|SVG|PATH|IMG|HTML|BODY|HEAD)$/;
  // a bar has an icon and a close sign around its sentence: when ONE child carries (nearly) all the text, that child is the message
  function sentenceOf(node, text) {
    for (var depth = 0; depth < 6; depth++) {
      var carrier = null;
      var carried = "";
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
        var t = norm(c.innerText || c.textContent);
        if (t.length >= text.length * 0.8 && t.length > carried.length) {
          carrier = c;
          carried = t;
        }
      }
      if (!carrier || carried === text) break;
      node = carrier;
      text = carried;
    }
    return text;
  }
  var everything = document.body ? document.body.getElementsByTagName("*") : [];
  var bars = [];
  for (i = 0; i < everything.length && bars.length < 60; i++) {
    var el = everything[i];
    if (skipBar.test(el.tagName)) continue;
    var r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.height > 160) continue;
    var st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    var said = norm(el.innerText || el.textContent);
    if (said.length < 12 || said.length > 400) continue;
    if (el.closest && (el.closest("#DivCoverDetails") || el.closest("#containerMain"))) continue; // read on their own
    if (el.querySelector("input, select, textarea")) continue;
    var cls = typeof el.className === "string" ? el.className : el.className && el.className.baseVal ? el.className.baseVal : "";
    var hinted = barHint.test(cls + " " + (el.id || ""));
    var pinned = (st.position === "fixed" || st.position === "sticky") && (r.bottom >= window.innerHeight - 160 || r.top <= 120);
    if (hinted || pinned) bars.push({ el: el, text: sentenceOf(el, said) });
  }
  for (i = 0; i < bars.length; i++) {
    var innermost = true;
    for (var b = 0; b < bars.length; b++) {
      if (b !== i && bars[i].el.contains(bars[b].el)) {
        innermost = false;
        break;
      }
    }
    var again = false;
    for (var k = 0; k < out.popups.length + out.messages.length; k++) {
      var known = k < out.popups.length ? out.popups[k] : out.messages[k - out.popups.length];
      if (known.indexOf(bars[i].text) >= 0 || bars[i].text.indexOf(known) >= 0) again = true;
    }
    if (innermost && !again) push(out.banners, bars[i].text, 400);
  }

  // required boxes that look empty: a short text ending in "*", and the first box after it in the same row
  var labels = document.querySelectorAll("label, span, td, th, div, p, b, strong");
  for (i = 0; i < labels.length && out.empty.length < 12; i++) {
    var own = ownText(labels[i]);
    if (!own || own.length > 60 || !/\*\s*:?\s*$/.test(own) || !shown(labels[i])) continue;
    var target = labels[i].htmlFor ? document.getElementById(labels[i].htmlFor) : null;
    if (!target) {
      var scope = labels[i].parentElement;
      for (var up = 0; up < 2 && scope && !target; up++, scope = scope.parentElement) {
        var near = scope.querySelectorAll("select, input[type=text], input:not([type]), textarea, span[aria-owns]");
        for (var j = 0; j < near.length; j++) {
          if (labels[i].compareDocumentPosition(near[j]) & 4) {
            target = near[j];
            break;
          }
        }
      }
    }
    if (!target) continue;
    // a Kendo box: what the user sees (and what counts) is its wrapper, not the select Kendo hid inside it
    var wrapper = target.closest ? target.closest(".k-widget") : null;
    if (!wrapper && target.getAttribute && target.getAttribute("aria-owns")) wrapper = target;
    var value;
    if (wrapper) {
      var inp = wrapper.querySelector(".k-input");
      value = norm(inp ? (inp.tagName === "INPUT" ? inp.value : inp.textContent) : "");
    } else if (target.tagName === "SELECT") {
      var o = target.options[target.selectedIndex];
      value = o ? norm(o.text) : "";
    } else {
      value = norm(target.value);
    }
    if (shown(wrapper || target) && /^(|select|--\s*select\s*--|-+)$/i.test(value)) push(out.empty, own.replace(/\s*\*\s*:?\s*$/, ""), 60);
  }
  return out;
}

/** The text of an alert() that is open: every command then fails with "... {Alert text : <the text>}" — the words we are after. */
function alertTextOf(error) {
  const m = /Alert text\s*:\s*([^}]*)/i.exec(String((error && error.message) || ""));
  return m ? m[1].trim() : "";
}

/** The sentence part for what the page said (no colons). */
function describePortalWords(words, { cover = true } = {}) {
  const parts = [];
  const w = words || {};
  const clean = (t) => String(t).replace(/\s*:\s*/g, " - ");
  if (cover && w.cover) parts.push(`the cover box says "${clean(w.cover)}"`);
  if (Array.isArray(w.popups) && w.popups.length) parts.push(`a popup says ${quoted(w.popups.map(clean))}`);
  if (Array.isArray(w.banners) && w.banners.length) parts.push(`a message bar says ${quoted(w.banners.map(clean))}`);
  if (w.main) parts.push(`the page's error area says "${clean(w.main)}"`);
  if (Array.isArray(w.messages) && w.messages.length) parts.push(`the page shows ${quoted(w.messages.map(clean))}`);
  if (Array.isArray(w.empty) && w.empty.length) parts.push(`these required boxes look empty - ${plainList(w.empty)}`);
  return parts.length ? parts.join("; ") : "the page showed no message, no popup and no empty required box";
}

/**
 * After Get Coverage Details the OD form must show its cover table. Waits for it (the Helmet / Zero Depreciation boxes; the
 * OD page has no PA box, the one the full flow counts as "loaded"), and when it does not come says why, in Reliance's own
 * words. Resolves with the summary of what is on the page; throws a plain Error.
 *
 * @param {Object} driver
 * @param {Object} [o]  { log, now, sleep, waits: { cover } }
 */
async function requireCoverTable(driver, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((ms) => driver.sleep(ms));
  const coverMs = (o.waits && o.waits.cover) || 10000;
  const end = now() + coverMs;
  let alertText = "";
  for (;;) {
    let summary = null;
    try {
      summary = await driver.executeScript(readCoverSummaryInPage);
    } catch (e) {
      alertText = alertTextOf(e) || alertText; // an alert() that is open makes every command fail with its text
    }
    if (summary && (summary.helmet.exists || summary.zeroDep.exists)) {
      log("✅ Reliance returned the cover table");
      return summary;
    }
    if (now() >= end) break;
    await sleep(500);
  }
  let words = null;
  try {
    words = await driver.executeScript(readPortalWordsInPage);
  } catch (e) {
    alertText = alertTextOf(e) || alertText;
  }
  const said = describePortalWords(words);
  throw new Error(
    `Reliance OD: Get Coverage Details did not return the cover table within ${Math.round(coverMs / 1000)} seconds, so the run stopped there. ` +
      `${alertText ? `Reliance showed the message "${alertText.replace(/:/g, " -")}". ` : ""}On the page ${said}. Nothing was saved or paid.`
  );
}

/* -------------------------------------------------------------------------- */
/* 5. What the cover table shows (read by requireCoverTable)                  */
/* -------------------------------------------------------------------------- */

/**
 * What the cover table shows now, in one read: the Helmet cover box (ChkBox500), Zero / Nil Depreciation (ChkBox10) and its
 * rate box (txtNilDepriciationRate), and the PA to Owner Driver box (ChkBox24 — the OD form is not expected to have one).
 * Reads only. Runs IN THE PAGE (self-contained).
 */
function readCoverSummaryInPage() {
  function box(id) {
    var el = document.getElementById(id);
    return { exists: !!el, checked: !!(el && el.checked) };
  }
  var rate = document.getElementById("txtNilDepriciationRate");
  return {
    helmet: box("ChkBox500"),
    zeroDep: box("ChkBox10"),
    pa: box("ChkBox24"),
    nilDepRate: rate ? String(rate.value == null ? "" : rate.value).trim() : null,
  };
}

module.exports = {
  answerTpDetailsDialog,
  selectFuelType,
  requireCoverTable,
  fillExistingTpPolicy,
  ensureAddressSame,
  afterCalculatePremiumClick,
  afterCalculatePremium,
  afterSaveClick,
  explainSaveFailure,
  pickFuelControl,
  chooseFuelOption,
  chooseInsurerOption,
  describeDropdowns,
  describePortalWords,
  refusalWords,
  alertTextOf,
  sameFuel,
  sameDayText,
  takeAlertText,
  watchForAlert,
  readFuelTypeInPage,
  findFuelOpenerInPage,
  findFuelListItemInPage,
  setFuelByKendoApiInPage,
  findKendoOpenerInPage,
  findKendoListItemInPage,
  setKendoByApiInPage,
  pickFromDropdown,
  clickLikeUser,
  readExistingTpInPage,
  findExistingTpExpanderInPage,
  findElementByIdInPage,
  readInsurerBoxesInPage,
  setDateByKendoApiInPage,
  setValueByScriptInPage,
  readAddressSameInPage,
  readPortalWordsInPage,
  readCoverSummaryInPage,
  readTpDetailsInPage,
  FUEL_WAITS,
  TP_WAITS,
  TP_IDS,
  TP_DETAILS_IDS,
  TP_DETAILS_WAITS,
};
