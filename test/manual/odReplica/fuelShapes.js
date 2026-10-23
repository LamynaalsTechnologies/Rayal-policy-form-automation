// MANUAL CHECK (not part of `npm test`). Needs Google Chrome.   node test/manual/odReplica/fuelShapes.js
// The REAL selectFuelType (multiCompany/common/reliance/relianceOdSteps.js) against replicas of the plausible shapes of Reliance's
// Fuel Type box: a Kendo dropdown over a hidden select / input, a plain select, a locked box, found by its label only, a box and a list
// that load late, a disabled box, a click that opens nothing, a hidden decoy — and the failure shapes with their exact sentences.
// The in-page readers can only be checked in a browser; this is where they are.
process.env.RELIANCE_REALISTIC_SELECT_ENABLED = process.env.RELIANCE_REALISTIC_SELECT_ENABLED || "true";
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", ".."); // the automation project
const { Builder } = require(path.join(ROOT, "node_modules/selenium-webdriver"));
const chrome = require(path.join(ROOT, "node_modules/selenium-webdriver/chrome"));
const steps = require(path.join(ROOT, "multiCompany/common/reliance/relianceOdSteps"));

// the list as Reliance's two-wheeler Own Damage page really shows it (the owner's log, 2026-10-23): the placeholder is its first item
const REAL = ["Petrol", "Diesel", "Bifuel", "Battery", "Hybrid Electric Vehicle"];
const OPTS = ["Select Type", ...REAL];

/** The page. kind: kendo-select | kendo-input | native | readonly | none; plus delays / flags. */
function html(o = {}) {
  const kind = o.kind || "kendo-select";
  const id = o.id || "ddlFuelType";
  const opts = o.options || OPTS;
  const label = o.noLabel ? "" : `<label for="${id}">Fuel Type *</label>`;
  const lis = opts.map((t) => `<li class="k-item" role="option">${t}</li>`).join("");
  const sel = `<option value="">Select Type</option>` + opts.filter((t) => !/^select/i.test(t)).map((t) => `<option value="${t}">${t}</option>`).join("");
  let box = "";
  if (kind === "kendo-select" || kind === "kendo-input") {
    const hidden = kind === "kendo-select" ? `<select id="${id}" style="display:none">${sel}</select>` : `<input id="${id}" style="display:none" value="">`;
    box = `<span class="k-widget k-dropdown k-header" role="listbox" aria-haspopup="true" aria-owns="${id}_listbox" aria-disabled="false" tabindex="0" id="wrap">
      <span class="k-dropdown-wrap k-state-default"><span class="k-input">${o.initial || "Select Type"}</span><span class="k-select"><span class="k-icon k-i-arrow-s">select</span></span></span>${hidden}</span>
      <div class="k-animation-container" id="pop" style="display:none;position:absolute"><div class="k-popup"><ul id="${id}_listbox" class="k-list">${o.lateList ? "" : lis}</ul></div></div>`;
  } else if (kind === "native") {
    box = `<select id="${id}" ${o.disabled ? "disabled" : ""}>${sel}</select>`;
  } else if (kind === "readonly") {
    box = `<input id="${id}" readonly value="${o.initial || "Petrol"}">`;
  }
  return `<!doctype html><html><body style="font-family:sans-serif;padding:20px">
  <div>Make/Model <input id="VehicleDetailsMakeModel" value="HONDA DIO"></div>
  <div>Manufacturing year <span class="k-widget k-dropdown" aria-owns="Manufacturing_YearVehicle_listbox"><span class="k-dropdown-wrap"><span class="k-input">2026</span></span><select id="Manufacturing_YearVehicle" style="display:none"><option>2026</option></select></span></div>
  <div id="holder" style="${o.lateBox ? "display:none" : ""}">${kind === "none" ? "" : label + box}</div>
  ${o.decoy ? `<select id="FuelTypeHidden" style="display:none"><option>Petrol</option></select><input type="hidden" id="hdnFuelCode" value="P">` : ""}
  <script>
  window.__events = [];
  var wrap = document.getElementById('wrap'), pop = document.getElementById('pop');
  var ul = document.getElementById('${id}_listbox'), sel = document.getElementById('${id}');
  var kin = wrap && wrap.querySelector('.k-input');
  var disabledUntil = ${o.disabledUntil || 0};
  if (wrap) {
    if (disabledUntil) { wrap.setAttribute('aria-disabled','true'); wrap.className += ' k-state-disabled'; setTimeout(function(){ wrap.setAttribute('aria-disabled','false'); wrap.className = wrap.className.replace(' k-state-disabled',''); }, disabledUntil); }
    wrap.addEventListener('click', function(){ if (wrap.getAttribute('aria-disabled')==='true') return;
      var ignore = ${o.ignoreOpen || 0}; window.__opens = (window.__opens||0)+1; if (window.__opens <= ignore) return;
      pop.style.display = pop.style.display === 'none' ? 'block' : 'none'; window.__events.push('fuel list ' + (pop.style.display==='block' ? 'opened' : 'closed')); });
    ul.addEventListener('click', function(e){ var li = e.target.closest('li'); if (!li) return;
      kin.textContent = li.textContent; if (sel) { sel.value = li.textContent; sel.dispatchEvent(new Event('change', {bubbles:true})); }
      pop.style.display = 'none'; window.__events.push('fuel picked ' + li.textContent); });
  }
  ${kind === "native" ? `document.getElementById('${id}').addEventListener('change', function(e){ window.__events.push('fuel picked ' + e.target.value); });` : ""}
  ${o.lateBox ? `setTimeout(function(){ document.getElementById('holder').style.display=''; }, ${o.lateBox});` : ""}
  ${o.lateList ? `setTimeout(function(){ ul.innerHTML = ${JSON.stringify(lis)}; }, ${o.lateList});` : ""}
  </script></body></html>`;
}

const SCENARIOS = [
  { name: "kendo dropdown over a hidden select", page: {}, fuel: "PETROL", expect: { how: "list", text: "Petrol", event: /^fuel picked Petrol$/ } },
  { name: "kendo dropdown over a hidden input", page: { kind: "kendo-input", id: "FuelTypeVehicle" }, fuel: "DIESEL", expect: { how: "list", text: "Diesel", event: /^fuel picked Diesel$/ } },
  { name: "a plain visible select (lib/realSelect, like a person)", page: { kind: "native", id: "Fuel_Type" }, fuel: "BIFUEL", expect: { how: "list", text: "Bifuel", event: /^fuel picked Bifuel$/ } },
  { name: "a locked box already showing the fuel type", page: { kind: "readonly", id: "FuelTypeText" }, fuel: "PETROL", expect: { how: "already", text: "Petrol" } },
  { name: "already chosen in a kendo dropdown (no click)", page: { initial: "Petrol" }, fuel: "PETROL", expect: { how: "already", text: "Petrol", noEvents: true } },
  { name: "found by its LABEL only (no 'fuel' in any id); ELECTRIC is Reliance's Battery", page: { id: "ddlFT9" }, fuel: "ELECTRIC", expect: { how: "list", text: "Battery", event: /^fuel picked Battery$/, found: /by its label/ } },
  { name: "the master says LPG -> Petrol (the owner: select the petrol), with the warning", page: {}, fuel: "LPG", expect: { how: "list", text: "Petrol", event: /^fuel picked Petrol$/, found: /choosing "Petrol" for a gas fuel on its own/ } },
  { name: "PETROL+CNG is Reliance's Bifuel", page: {}, fuel: "PETROL+CNG", expect: { how: "list", text: "Bifuel", event: /^fuel picked Bifuel$/ } },
  { name: "the box appears 3 s late and its list loads 4 s late", page: { lateBox: 3000, lateList: 4000 }, fuel: "PETROL", expect: { how: "list", text: "Petrol" } },
  { name: "the box is disabled for 3 s", page: { disabledUntil: 3000 }, fuel: "DIESEL", expect: { how: "list", text: "Diesel" } },
  { name: "the first click on the box opens nothing", page: { ignoreOpen: 1 }, fuel: "PETROL", expect: { how: "list", text: "Petrol" } },
  { name: "a hidden decoy with 'fuel' in its id is not the box", page: { decoy: true }, fuel: "PETROL", expect: { how: "list", text: "Petrol" } },
  { name: "ERROR no Fuel Type box on the page", page: { kind: "none" }, fuel: "PETROL", waits: { find: 3000 }, error: /^Reliance OD: the Fuel Type box was not found on the page within 3 seconds.*The policy says "PETROL"\. In the page the dropdown boxes on the page are Manufacturing_YearVehicle showing 2026\./ },
  { name: "ERROR a fuel type Reliance has no name for (the master's typo DESAL)", page: { options: ["Select Type", "Petrol", "Diesel"] }, fuel: "DESAL", error: /does not offer "DESAL" and has no name for it - it offers "Petrol", "Diesel"\./ },
  { name: "ERROR an electric scooter and a list without Battery: never Petrol", page: { options: ["Select Type", "Petrol", "Diesel"] }, fuel: "ELECTRIC", error: /does not offer "ELECTRIC" and has no name for it - it offers "Petrol", "Diesel"\./ },
  { name: "ERROR a locked box showing another fuel type", page: { kind: "readonly", initial: "Diesel", id: "FuelTypeText" }, fuel: "PETROL", error: /^Reliance OD: Reliance fixed the Fuel Type as "Diesel" for this vehicle and does not let it be changed, but the policy's vehicle says "PETROL"\./ },
  { name: "ERROR the list never loads", page: { lateList: 60000 }, fuel: "PETROL", waits: { find: 3000 }, error: /^Reliance OD: the Fuel Type list \(id ddlFuelType\) stayed empty for 3 seconds/ },
];

(async () => {
  const opts = new chrome.Options().addArguments("--headless=new", "--no-sandbox", "--disable-gpu", "--window-size=1100,800");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();
  let failed = 0;
  try {
    for (const sc of SCENARIOS) {
      await driver.get("data:text/html;charset=utf-8," + encodeURIComponent(html(sc.page)));
      const lines = [];
      let result = null, error = null;
      const t0 = Date.now();
      try {
        result = await steps.selectFuelType(driver, { fuelType: sc.fuel, log: (l) => lines.push(l), waitLoader: async () => {}, waits: sc.waits });
      } catch (e) { error = e; }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const events = await driver.executeScript("return window.__events || []");
      let ok = true, why = "";
      if (sc.error) {
        ok = !!error && sc.error.test(error.message) && (error.message.split(":").length - 1) === 1;
        why = error ? error.message.slice(0, 400) : "no error thrown";
      } else {
        ok = !error && result && result.how === sc.expect.how;
        why = error ? error.message : `${JSON.stringify(result)} events=${JSON.stringify(events)}`;
        if (ok && sc.expect.event) ok = events.some((e) => sc.expect.event.test(e));
        if (ok && sc.expect.noEvents) ok = events.length === 0;
        if (ok && sc.expect.found) ok = lines.some((l) => sc.expect.found.test(l));
        if (ok && sc.expect.text) {
          const shown = await driver.executeScript(`var w=document.querySelector('.k-input'); var sel=document.getElementById(${JSON.stringify(sc.page.id || "ddlFuelType")}); var wr=document.getElementById('wrap'); if (wr) return wr.querySelector('.k-input').textContent; if (sel && sel.tagName==='SELECT') return sel.options[sel.selectedIndex].text; return sel ? sel.value : null;`);
          ok = shown === sc.expect.text; why += ` shown=${shown}`;
        }
      }
      if (!ok) failed++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${sc.name} (${secs}s)${ok && !sc.error ? "" : "\n        " + why}`);
    }
  } finally { await driver.quit().catch(() => {}); }
  console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error("RUNNER ERROR", e); process.exit(2); });
