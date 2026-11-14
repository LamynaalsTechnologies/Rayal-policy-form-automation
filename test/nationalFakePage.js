// A fake National quote page for the collector tests (not a test file itself: `npm test` runs test/*.test.js only).
// Four mat-autocomplete inputs - RTO, Make, Model, Variant - behaving like the real ones: the RTO list opens on focus, Make
// opens only after an RTO was picked, Model follows the make, Variant follows the model; options are filtered by what is typed.
const CATALOG = {
  HONDA: { ACTIVA: ["STD", "DLX", "DLX OBD2B"], DIO: ["STD", "DLX"], UNICORN: ["STD"] },
  "HONDA MOTORS": { CITY: ["BASE"] }, // a near name of HONDA: must never be taken for it
  "TVS MOTOR COMPANY LTD": { JUPITER: ["STD", "ZX", "CLASSIC"], NTORQ: ["RACE", "XT"] },
  "NO MODELS CO": {},
  "BAJAJ AUTO": { PULSAR: ["150", "180"], CT100: [] },
};
const RTO_LIST = ["Gurgaon - NCR", "Faridabad - NCR", "Noida - NCR", "Ambala", "Jagadhari", "Chennai - West"];

function fakeNationalPage({
  catalog = CATALOG,
  rtoList = RTO_LIST,
  emptyUntilTypedModels = false,
  emptyUntilTypedMakes = false,
  staleModelReads = 0,
  wrongValueAfterPick = null,
  rtoRequired = true,
  // the portal's popups (a Material dialog with a dark backdrop): shown after a pick (`afterPick: "model:ACTIVA"` or "any"),
  // or the first time a box is clicked (`onClick: "model"`); `noButton` = a popup with nothing to press
  popup = null,
} = {}) {
  const events = [];
  const state = { rto: null, make: null, model: null, open: null, staleModels: null, modelReadsSinceMake: 0, popup: null, popupClickDone: false };
  const showPopup = () => {
    state.popup = { text: (popup && popup.text) || "Vehicle details changed", noButton: !!(popup && popup.noButton) };
    events.push("popup-shown");
  };
  const values = { rto: "", make: "", model: "", variant: "" };
  const keyOf = (name) => ({ mcy_dropdown_newRtoLocation_01: "rto", mcy_dropdown_make_01: "make", mcy_dropdown_model_01: "model", mcy_dropdown_variant_01: "variant" }[name]);

  const allFor = (key) => {
    if (key === "rto") return rtoList;
    if (key === "make") return rtoRequired && !state.rto ? [] : Object.keys(catalog);
    if (key === "model") {
      if (!state.make) return [];
      if (state.staleModels && state.modelReadsSinceMake < staleModelReads) {
        state.modelReadsSinceMake += 1;
        return state.staleModels;
      }
      return Object.keys(catalog[state.make] || {});
    }
    if (key === "variant") return state.make && state.model ? (catalog[state.make] || {})[state.model] || [] : [];
    return [];
  };
  const optionsOpen = () => {
    const key = state.open;
    if (!key) return [];
    const typed = values[key].trim().toUpperCase();
    if (!typed && ((key === "model" && emptyUntilTypedModels) || (key === "make" && emptyUntilTypedMakes))) return [];
    const list = allFor(key);
    return typed ? list.filter((t) => t.toUpperCase().includes(typed)) : list;
  };

  const inputs = {};
  for (const name of ["mcy_dropdown_newRtoLocation_01", "mcy_dropdown_make_01", "mcy_dropdown_model_01", "mcy_dropdown_variant_01"]) {
    const key = keyOf(name);
    inputs[name] = {
      name,
      key,
      async click() {
        if (popup && popup.onClick === key && !state.popupClickDone) {
          state.popupClickDone = true;
          showPopup();
        }
        if (state.popup) {
          events.push(`blocked:${key}`);
          throw new Error(`element click intercepted: Element <input name="${name}"> is not clickable at point (248, 433). Other element would receive the click: <div class="cdk-overlay-backdrop cdk-overlay-dark-backdrop"></div>`);
        }
        state.open = key;
        events.push(`open:${key}`);
      },
      async sendKeys(text) { values[key] += text; state.open = key; },
    };
  }

  const driver = {
    async sleep() {},
    async wait(cond) {
      if (cond && cond.located) return inputs[cond.located];
      if (cond && cond.pass) return cond.pass;
      return null;
    },
    async executeScript(script, ...args) {
      if (script.includes("alert_btn_data_01")) {
        if (!state.popup) return { found: false };
        const shown = state.popup;
        if (shown.noButton) return { found: true, text: shown.text, clicked: false };
        state.popup = null;
        events.push("popup-closed");
        return { found: true, text: shown.text, clicked: true, button: "CLOSE" };
      }
      if (script.includes("focus(); arguments[0].click()")) {
        events.push(`js-click:${args[0].key}`);
        state.open = args[0].key;
        return null;
      }
      if (script.includes("out.push")) {
        events.push(`read:${state.open}`);
        return optionsOpen();
      }
      if (script.includes("scrollTop")) return false;
      if (script.includes("el.value = ''")) {
        values[args[0].key] = "";
        return null;
      }
      if (script.includes("Escape")) {
        state.open = null;
        return null;
      }
      if (script.includes("wanted")) {
        const wanted = String(args[0]).replace(/\s+/g, " ").trim().toUpperCase();
        const shown = optionsOpen();
        const offered = shown.map((t) => t.toUpperCase());
        const hit = shown.find((t) => t.toUpperCase() === wanted);
        if (!hit) return { clicked: false, offered };
        const key = state.open;
        events.push(`pick:${key}:${hit}`);
        values[key] = wrongValueAfterPick || hit;
        if (key === "rto") state.rto = hit;
        if (key === "make") {
          state.staleModels = state.make ? Object.keys(catalog[state.make] || {}) : null;
          state.make = hit;
          state.model = null;
          state.modelReadsSinceMake = 0;
          values.model = "";
          values.variant = "";
        }
        if (key === "model") {
          state.model = hit;
          values.variant = "";
        }
        state.open = null;
        if (popup && popup.afterPick && (popup.afterPick === "any" || popup.afterPick === `${key}:${hit}`)) showPopup();
        return { clicked: true, offered };
      }
      if (script.includes("return arguments[0].value")) return values[args[0].key];
      if (script.includes("dispatchEvent") || script.includes("scrollIntoView") || script.includes("blur")) return null;
      throw new Error("unexpected script " + script.slice(0, 50));
    },
  };

  const ctx = {
    By: { name: (n) => ({ locator: n }) },
    until: {
      elementLocated: (loc) => ({ located: loc.locator }),
      elementIsVisible: (el) => ({ pass: el }),
      elementIsEnabled: (el) => ({ pass: el }),
    },
    async waitForPortalIdle() { events.push("idle"); return true; },
    async waitForOverlayGone() { return true; },
  };
  return { driver, ctx, events, state, values };
}

// a fake database that remembers the ORDER of writes (find().toArray() for the RTO collection)
function fakeDb() {
  const store = { insurerMake: [], insurerModel: [], insurerVariant: [], insurerMakeNotFound: [], insurerModelNotFound: [], insurerVariantNotFound: [], RTOCityLocation: [] };
  const writes = [];
  const uniq = {
    insurerMake: (d) => `${d.company}|${d.makeKey}`,
    insurerModel: (d) => `${d.company}|${d.makeKey}|${d.modelKey}`,
    insurerVariant: (d) => `${d.company}|${d.makeKey}|${d.modelKey}|${d.variantKey}`,
    insurerMakeNotFound: (d) => `${d.company}|${d.makeKey}`,
    insurerModelNotFound: (d) => `${d.company}|${d.makeKey}|${d.modelKey}`,
    insurerVariantNotFound: (d) => `${d.company}|${d.makeKey}|${d.modelKey}|${d.variantKey}`,
    RTOCityLocation: (d) => d.RTOCode,
  };
  const label = (name, d) => `${name}:${d.make || d.RTOCode}${d.model ? "/" + d.model : ""}${d.variant ? "/" + d.variant : ""}`;
  return {
    store,
    writes,
    collection(name) {
      return {
        async insertOne(doc) {
          if (store[name].some((d) => uniq[name](d) === uniq[name](doc))) throw Object.assign(new Error("E11000"), { code: 11000 });
          store[name].push(doc);
          writes.push(label(name, doc));
        },
        async insertMany(docs) {
          const fresh = [];
          const errors = [];
          for (const d of docs) {
            if (store[name].some((x) => uniq[name](x) === uniq[name](d)) || fresh.some((x) => uniq[name](x) === uniq[name](d))) errors.push({ code: 11000 });
            else fresh.push(d);
          }
          store[name].push(...fresh);
          for (const d of fresh) writes.push(label(name, d));
          if (errors.length) throw Object.assign(new Error("E11000 bulk"), { code: 11000, writeErrors: errors, result: { insertedCount: fresh.length } });
          return { insertedCount: fresh.length };
        },
        find(query) {
          // the RTO save asks: $or [ {RTOCode: {$in}}, {company, portalText: {$in}} ]
          const rows = store[name].filter((d) => (query.$or || []).some((q) => {
            if (q.RTOCode) return q.RTOCode.$in.includes(d.RTOCode);
            if (q.portalText) return d.company === q.company && q.portalText.$in.includes(d.portalText);
            return false;
          }));
          return { async toArray() { return rows; } };
        },
        updateOne() { throw new Error("insert only: nothing is ever updated"); },
        deleteOne() { throw new Error("insert only: nothing is ever deleted"); },
        deleteMany() { throw new Error("insert only: nothing is ever deleted"); },
      };
    },
  };
}

module.exports = { CATALOG, RTO_LIST, fakeNationalPage, fakeDb };
