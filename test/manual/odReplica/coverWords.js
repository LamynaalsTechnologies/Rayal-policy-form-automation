// MANUAL CHECK (not part of `npm test`). Needs Google Chrome.   node test/manual/odReplica/coverWords.js
// readPortalWordsInPage (what Reliance says when Get Coverage Details does not answer: the cover box, an open popup without its
// buttons, a field message, the required boxes that look empty — also an empty Kendo box seen through its wrapper) in a real Chrome.
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", ".."); // the automation project
const { Builder } = require(path.join(ROOT, "node_modules/selenium-webdriver"));
const chrome = require(path.join(ROOT, "node_modules/selenium-webdriver/chrome"));
const steps = require(path.join(ROOT, "multiCompany/common/reliance/relianceOdSteps"));

const PAGE = `<!doctype html><html><body style="font-family:sans-serif">
 <div class="row"><label for="ddlFuelType">Fuel Type *</label>
   <span class="k-widget k-dropdown" aria-owns="ddlFuelType_listbox"><span class="k-dropdown-wrap"><span class="k-input">Select</span></span><select id="ddlFuelType" style="display:none"><option value="">Select</option></select></span></div>
 <table><tr><td>Last Name * :</td><td><input type="text" id="ln" value=""></td></tr>
        <tr><td>First Name *</td><td><input type="text" id="fn" value="Asha"></td></tr>
        <tr><td>Vertical Code*:</td><td><select id="vc"><option>GIRNAR FINSERV</option></select></td></tr>
        <tr><td>Passport Number :</td><td><input type="text" id="pp" value=""></td></tr>
        <tr><td>Hidden Required *</td><td style="display:none"><input type="text" id="hr" value=""></td></tr></table>
 <span class="field-validation-error">Last Name is required</span>
 <span class="field-validation-error" style="display:none">hidden message</span>
 <div class="ui-dialog" role="dialog"><div class="ui-dialog-titlebar"><span>Alert</span><button class="ui-dialog-titlebar-close">x</button></div>
   <div class="ui-dialog-content">Please select Fuel Type</div><div class="ui-dialog-buttonpane"><button>OK</button></div></div>
 <div class="ui-dialog" style="display:none">a closed dialog that must not be read</div>
 <div id="DivCoverDetails" class="blocks" style="display:block">Fuel Type should not be blank</div>
</body></html>`;

(async () => {
  const opts = new chrome.Options().addArguments("--headless=new", "--no-sandbox", "--disable-gpu", "--window-size=1100,800");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();
  let failed = 0;
  const check = (name, ok, extra = "") => { console.log((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "  " + extra)); if (!ok) failed++; };
  try {
    await driver.get("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
    const w = await driver.executeScript(steps.readPortalWordsInPage);
    console.log("read:", JSON.stringify(w));
    check("an empty required KENDO box is listed through its wrapper (the label points at the hidden select)", w.empty.includes("Fuel Type"), JSON.stringify(w.empty));
    check("an empty required text box in a table row is listed", w.empty.includes("Last Name"), JSON.stringify(w.empty));
    check("a filled required box, a filled dropdown and a box that is not required are NOT listed", !w.empty.some((t) => /First Name|Vertical Code|Passport/.test(t)), JSON.stringify(w.empty));
    check("a required box that is not on screen is not listed", !w.empty.includes("Hidden Required"), JSON.stringify(w.empty));
    check("the open popup's words, without its OK button, and not the closed one", w.popups.length === 1 && /^Alert\s*Please select Fuel Type$|^Alert Please select Fuel Type$/.test(w.popups[0]) && !/OK|closed/.test(w.popups.join("|")), JSON.stringify(w.popups));
    check("the visible field message is read, the hidden one is not", w.messages.length === 1 && w.messages[0] === "Last Name is required", JSON.stringify(w.messages));
    check("the cover box's own sentence is read", w.cover === "Fuel Type should not be blank", w.cover);
    const said = steps.describePortalWords(w);
    console.log("sentence part:", said);
    check("the sentence part has no colon", !said.includes(":"), said);
  } finally { await driver.quit().catch(() => {}); }
  console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error("RUNNER ERROR", e); process.exit(2); });
