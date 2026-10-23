// MANUAL CHECK (not part of `npm test`: a unit test never starts a browser). Needs Google Chrome.
//   node test/manual/odReplica/runFlow.js <scenario>      scenarios: od | od-lpg | od-exists | od-pa | od-nofuelbox | od-nopetrol | od-needprev | od-tpcollapsed | od-tpdatefmt | od-tpbaddate | od-tpclear | od-tpnoinsurer | od-addressticked | od-calcrefuse | od-saverefuse | od-calcbar | od-savebar | tp | tp-configured
// Runs the REAL generated copy (multiCompany/common/reliance/relianceMultiForm.js) in a real headless Chrome against a local replica
// of the Reliance pages (site/index.html + site/form60.html, served from 127.0.0.1) and prints PASS / FAIL for what the page saw.
// The OD run goes on after Nil Depreciation: existing TP policy (panel, number, insurer, two dates), "Is Registration Address Same",
// Calculate Premium and Save; the replica has no View Policy page, so the run is ended when it reaches "Navigating to View Policy"
// (the page is read first). Nothing real is touched: the login, S3, the recorder and the captcha are stubbed, the job has no policy id (no database, no hold /
// stall watcher) and MONGODB_URI points nowhere. A failure run keeps a picture inside the project; this script removes what it made.
const scenario = process.argv[2] || "od";
process.env.RELIANCE_REALISTIC_SELECT_ENABLED = "false";        // a native <select> list is not what is being tested
process.env.RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED = "false";   // the replica has no Kendo Salutation box
process.env.JOB_HOLD_REQUEST_ENABLED = "false";
process.env.MONGODB_URI = "mongodb://127.0.0.1:1/never";
process.env.BREAKER_ENABLED = "false";
if (scenario === "tp-configured") process.env.RELIANCE_TP_PRODUCT = "Two Wheeler Package Bundled (Only New Veh.)";
delete process.env.RELIANCE_OD_PRODUCT; // the DEFAULT must do the work

const path = require("path");
const ROOT = path.join(__dirname, "..", "..", ".."); // the automation project
const { Builder } = require(path.join(ROOT, "node_modules/selenium-webdriver"));
const chrome = require(path.join(ROOT, "node_modules/selenium-webdriver/chrome"));

const install = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
const refuse = (what) => async () => { throw new Error(`SCRATCH SAFETY: ${what} must not be used`); };

(async () => {
  const { start } = require("./server");
  const { server, port } = await start();
  const query = ({ "od-tpcollapsed": "?panel=collapsed", "od-tpdatefmt": "?datefmt=reformat", "od-tpbaddate": "?rejectend=1", "od-tpclear": "?datefmt=clear", "od-tpnoinsurer": "?ins=none", "od-addressticked": "?addr=ticked", "od-calcrefuse": "?calc=refuse", "od-saverefuse": "?save=refuse", "od-calcbar": "?calc=bar", "od-savebar": "?save=bar", "od-exists": "?exists=1", "od-pa": "?pa=1", "od-nofuelbox": "?fuel=none", "od-nopetrol": "?fuelopts=Diesel,CNG", "od-needprev": "?need=previous", "tp-configured": "?pa=1&fuel=none" })[scenario] || "";
  const url = `http://127.0.0.1:${port}/index.html${query}`;
  const opts = new chrome.Options().addArguments("--headless=new", "--no-sandbox", "--disable-gpu", "--window-size=1300,900");
  const driver = await new Builder().forBrowser("chrome").setChromeOptions(opts).build();
  const cleaned = [];

  install(require.resolve(path.join(ROOT, "Captcha")), { extractCaptchaText: async () => ({ text: "", success: false }) });
  install(require.resolve(path.join(ROOT, "sessionManager")), {
    createRelianceJobBrowser: async () => { await driver.get(url); return { driver }; },
    cleanupJobBrowser: async (_b, o) => cleaned.push(o),
    performLogin: async () => true, reLoginIfNeeded: async () => true, recoveryManager: {},
  });
  install(require.resolve(path.join(ROOT, "lib/jobRecorder")), { startRecording() {} });
  const realS3 = require(path.join(ROOT, "s3Uploader"));
  install(require.resolve(path.join(ROOT, "s3Uploader")), { ...realS3, uploadScreenshotToS3: refuse("S3"), uploadToS3: refuse("S3") });

  // collect the flow's console, keep a filtered view
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  let tpEvents = null, tpState = null, quitting = false;
  const READ_STATE = "var g=function(i){var e=document.getElementById(i);return e?e.value:null}, h=document.getElementById('ChkBox500'), z=document.getElementById('ChkBox10'), a=document.getElementById('IsRegistrationAddresssame'), c=document.getElementById('tpContent');" +
    "var pa=document.getElementById('ChkBox24'); return { events: window.__events, pa: pa&&pa.checked, paExists: !!pa, helmet: h&&h.checked, zero: z&&z.checked, panelOpen: c ? c.style.display !== 'none' : null, number: g('txtExistingTPPolicyNo'), insurer: (document.getElementById('insurerText')||{}).textContent, start: g('dpExistingTPPolicyRiskStartDate'), end: g('dpExistingTPPolicyRiskEndDate'), address: a ? a.checked : null, saved: (document.getElementById('saved')||{}).textContent, premium: (document.getElementById('premium')||{}).textContent };";
  const grab = (...a) => lines.push(a.map(String).join(" "));
  console.log = (...a) => {
    grab(...a);
    // read the page, then end the run
    // the TP control stops at the financier step; an OD run that reached Save stops where the replica has no page any more
    const stopLine = scenario === "tp-configured" ? /Handling financier fields/ : /^Navigating to View Policy/;
    if ((scenario === "tp-configured" || scenario.startsWith("od")) && stopLine.test(a.join(" ")) && !quitting) {
      quitting = true;
      driver.executeScript(READ_STATE)
        .then((r) => { tpEvents = r.events; tpState = r; }).catch(() => {}).then(() => driver.quit()).catch(() => {});
    }
  };
  console.error = console.warn = grab;

  const { fillRelianceMultiForm } = require(path.join(ROOT, "multiCompany/common/reliance/relianceMultiForm"));
  const data = {
    policyType: scenario.startsWith("tp") ? "tp" : "od", username: "u", password: "p", loginUrl: url,
    firstName: "Asha", lastName: "Rao", dob: "06-10-2000", proposerTitle: "Ms.", fatherTitle: "Mr.", fatherName: "Ravi",
    flatNo: "12", floorNo: "2", premisesName: "Lake View", blockNo: "B", road: "Anna Salai", area: "T Nagar",
    state: "31", pinCode: "614630", mobile: "9876543210", email: "asha@example.com",
    vehicleMake: "HONDA", vehicleModel: "DIO 125", purchaseDate: "23-10-2026", registrationDate: "23-10-2026",
    manufacturingYear: 2026, manufacturingMonth: "10", rtoCityLocation: "TN18", engineNumber: "ENG1234567", chassisNumber: "CHS12345678901",
    idv: 116444, discount: 50, zeroDepreciation: true, zeroDepreciationPercentage: "0.615", paCover: false, tppdRestrict: false,
    fuelType: scenario === "od-lpg" ? "LPG" : "PETROL",
    existingTpPolicyNumber: "nic/tp/0001", existingTpInsurer: "National", existingTpStartDate: "01-10-2026", existingTpEndDate: "30-09-2031", _jobIdentifier: "ODREPLICA_" + scenario, _attemptNumber: 1,
  };
  const fs = require("fs");
  const SHOTS = path.join(ROOT, "error_screenshots");
  const topBefore = new Set(fs.readdirSync(ROOT).filter((f) => /^temp-page-source-/.test(f)));
  const shotsBefore = new Set(fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : []);
  const t0 = Date.now();
  let result;
  try { result = await fillRelianceMultiForm(data); } finally { Object.assign(console, saved); }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  // the flow's failure path keeps a local copy of its picture and page source INSIDE the project: remove only what this run made
  let cleaned_files = 0;
  for (const f of fs.readdirSync(ROOT)) if (/^temp-page-source-/.test(f) && !topBefore.has(f)) { fs.unlinkSync(path.join(ROOT, f)); cleaned_files++; }
  if (fs.existsSync(SHOTS)) for (const f of fs.readdirSync(SHOTS)) if (!shotsBefore.has(f) && f.startsWith("error_ODREPLICA_")) { fs.unlinkSync(path.join(SHOTS, f)); cleaned_files++; }

  let events = tpEvents || [], state = tpState || {};
  if (!quitting) {
    try {
      await driver.switchTo().defaultContent();
      events = await driver.executeScript("return window.__events");
      state = await driver.executeScript("var h=document.getElementById('ChkBox500'),z=document.getElementById('ChkBox10'),p=document.getElementById('ChkBox24'); return {helmet: h&&h.checked, zero: z&&z.checked, pa: p&&p.checked, paExists: !!p}");
      state = { ...state, ...(await driver.executeScript(READ_STATE)), events: undefined };
    } catch (e) { events = ["(page not readable: " + e.message.slice(0, 60) + ")"]; }
  }
  const keyLines = lines.filter((l) => /Selected product|Clicked 'Skip|TP Details|⏸️|Validate Customer button|validation attempted|Get Coverage|Helmet|Zero Depreciation|PA to Owner|TPPD|📋|Reliance OD:|Reliance TP:|Fuel|⛽|cover table|Existing TP|Registration Address|Calculate|Proposal|Save|Error handling/i.test(l));
  console.log(`--- scenario ${scenario} (${secs}s) ---`);
  console.log(keyLines.slice(0, 70).join("\n"));
  console.log("--- result ---");
  console.log(JSON.stringify({ success: result.success, inProgress: result.inProgress, stage: result.stage, error: String(result.error || "").slice(0, 600) }));
  console.log("--- page events ---");
  console.log(JSON.stringify(events));
  console.log("--- page state at the end ---", JSON.stringify(state));

  // ---------- checks ----------
  const has = (re) => events.some((e) => re.test(e));
  const count = (re) => events.filter((e) => re.test(e)).length;
  const idx = (re) => events.findIndex((e) => re.test(e));
  const checks = [];
  const check = (name, ok) => checks.push([name, !!ok]);
    if (scenario === "od-nofuelbox") {
    check("the run FAILS at the Fuel Type step, with the exact sentence and the dropdowns that are on the page", result.success === false && /^Reliance OD: the Fuel Type box was not found on the page within 15 seconds.*The policy says "PETROL"\. In the page the dropdown boxes on the page are .*Nothing was saved or paid\.$/.test(String(result.error)));
    check("nothing after the Fuel Type step was touched (no dates, no Get Coverage)", !has(/^new vehicle ticked$/) && !has(/^FetchIDV request/) && !has(/^helmet/));
  } else if (scenario === "od-nopetrol") {
    check("the run FAILS at the Fuel Type step, quoting what Reliance offers", result.success === false && /does not offer "PETROL" and has no name for it - it offers "Diesel", "CNG"\./.test(String(result.error)));
    check("nothing was picked and nothing after was touched", !has(/^fuel picked/) && !has(/^new vehicle ticked$/) && !has(/^FetchIDV request/));
  } else if (scenario === "od-needprev") {
    check("the run FAILS after Get Coverage with Reliance's own words", result.success === false && /^Reliance OD: Get Coverage Details did not return the cover table within 10 seconds/.test(String(result.error)) && /a popup says "Please select Previous Policy Type"/.test(String(result.error)) && /these required boxes look empty - Previous Policy Type\./.test(String(result.error)));
    check("Reliance refused Get Coverage itself, and the run did not go on to Helmet / Nil Depreciation", has(/^Get Coverage refused - Please select Previous Policy Type$/) && !has(/^helmet/) && !has(/^zero dep/));
    check("the fuel type had been chosen before (so the refusal is about the other box)", has(/^fuel picked Petrol$/));
  } else if (scenario === "od-tpnoinsurer") {
    check("the run FAILS at the insurer, quoting the dropdown that is in the panel and what it offers", result.success === false && /^Reliance OD: no dropdown of the existing TP panel offers (National|KSHEMA General|National Insurance Company) ?.*so the run stopped there\. The dropdowns in the panel are ddlExistingTPInsurer offering "UNITED INDIA INSURANCE"\. Nothing was saved or paid\.$/.test(String(result.error)));
    check("the number was typed, but no date, no address, no Calculate, no Save", has(/^tp number NIC\/TP\/0001$/) && !has(/^tp start/) && !has(/^address same/) && !has(/^calculate$/) && !has(/^save$/));
  } else if (scenario === "od-tpbaddate") {
    check("the run FAILS with the page's own alert text for the end date (its colon turned into a dash)", result.success === false && /^Reliance OD: Reliance refused the existing TP end date 30-09-2031 with the message "Policy end date should be after - start date", so the run stopped there\. Nothing was saved or paid\.$/.test(String(result.error)));
    check("the start date was accepted first; nothing after the dates was touched", has(/^tp start 01-10-2026$/) && !has(/^address same/) && !has(/^calculate$/) && !has(/^save$/));
  } else if (scenario === "od-tpclear") {
    check("a picker that empties a dd-mm-yyyy date: the run FAILS with the exact sentence for the start date box", result.success === false && /^Reliance OD: the existing TP start date box \(dpExistingTPPolicyRiskStartDate\) shows "nothing" instead of 01-10-2026, so the run stopped there\. Nothing was saved or paid\.$/.test(String(result.error)));
    check("nothing after the dates was touched", !has(/^address same/) && !has(/^calculate$/) && !has(/^save$/));
  } else if (scenario === "od-calcrefuse") {
    check("Calculate Premium refused: the run FAILS with Reliance's own words", result.success === false && /^Reliance OD: Reliance did not accept Calculate Premium - Reliance said "Please select Previous Policy Type", so the run stopped there\. Nothing was saved or paid\.$/.test(String(result.error)));
    check("Save was never pressed", has(/^calculate$/) && !has(/^save$/));
  } else if (scenario === "od-calcbar") {
    check("a red message bar after Calculate Premium (no known class): the run FAILS with Reliance's own words", result.success === false && /^Reliance OD: Reliance did not accept Calculate Premium - Reliance said "As per entered Registration Number the Vehicle Class is Goods Carrier\. The same is not permitted to be booked under Product 2308\. Kindly book the same in correct Product or refer to our nearest Branch\.", so the run stopped there\. Nothing was saved or paid\.$/.test(String(result.error)));
    check("the page's footer was NOT taken for a message, and Save was never pressed", !/indusind/i.test(String(result.error)) && has(/^calculate$/) && !has(/^save$/));
  } else if (scenario === "od-savebar") {
    check("a red message bar after Save: the sentence quotes it, says to check View Policy, and keeps the page's footer out", result.success === false && /^Reliance OD: Save did not show "Proposal Saved Successfully", so no proposal number was read and the run stopped there\. On the page a message bar says "As per entered Registration Number the Vehicle Class is Goods Carrier\. The same is not permitted to be booked under Product 2308\. Kindly book the same in correct Product or refer to our nearest Branch\."\. Check in Reliance \(View Policy\) whether the proposal was saved before running the policy again\.$/.test(String(result.error)));
    check("Save was pressed once, after Calculate Premium", count(/^save$/) === 1 && idx(/^calculate$/) < idx(/^save$/));
  } else if (scenario === "od-saverefuse") {
    check("Save without the success message: the run FAILS with what the page shows, and says to check Reliance", result.success === false && /^Reliance OD: Save did not show "Proposal Saved Successfully", so no proposal number was read and the run stopped there\. On the page a popup says "Please enter Engine Number"/.test(String(result.error)) && /Check in Reliance \(View Policy\) whether the proposal was saved before running the policy again\.$/.test(String(result.error)));
  } else if (scenario.startsWith("od")) {
    check("the run went on to the proposal number (it ended where the replica has no View Policy page)", quitting && lines.some((l) => /Extracted Proposal Number: R1234567890/.test(l)));
    check("the Fuel Type box was filled right after the make / model and before the dates (the list loads late, the box starts disabled)", has(/^fuel list loaded$/) && has(/^fuel picked Petrol$/) && idx(/^fuel picked Petrol$/) > idx(/^picked VehicleDetailsMakeModel/) && idx(/^fuel picked Petrol$/) < idx(/^new vehicle ticked$/));
    check("own-damage product chosen by default", has(/^product: Two Wheeler Own damage Policy$/));
    check("TP Details answered Yes, then RGICL No, then Proceed", idx(/^TP Yes$/) < idx(/^RGICL No$/) && idx(/^RGICL No$/) < idx(/^Proceed$/) && idx(/^TP Yes$/) >= 0);
    check("Form 60 submitted and Validate Customer pressed", has(/^form60 submitted/) && has(/^validate customer$/));
    check("vehicle make/model and RTO picked, Is New Vehicle ticked", has(/^picked VehicleDetailsMakeModel/) && has(/^picked RTOCityLocation/) && has(/^new vehicle ticked$/));
    check("Get Coverage fired 4 times and Reliance answered 4 times", count(/^FetchIDV request/) === 4 && count(/^cover table drawn/) === 4);
    check("Helmet cover removed AFTER the last answer", idx(/^helmet unticked$/) > events.map((e, i) => (/^cover table drawn/.test(e) ? i : -1)).reduce((a, b) => Math.max(a, b), -1));
    check("Zero Depreciation ticked and its rate typed (0.615)", has(/^zero dep ticked$/) && has(/^nil dep rate 0\.615$/));
    check("PA never touched (no PA click, no PA question)", !has(/^PA box clicked/) && !has(/^PA question answered/));
    // the existing TP policy comes AFTER Nil Depreciation, in this order: panel (only if collapsed), number, insurer, start, end
    const opened = count(/^panel opened$/), closed = count(/^panel closed$/);
    if (scenario === "od-tpcollapsed") check("a collapsed panel was opened by ONE click on its expand icon, and left open", opened === 1 && closed === 0 && state.panelOpen === true);
    else check("an open panel was NOT clicked (a click would collapse it)", opened === 0 && closed === 0 && state.panelOpen === true);
    check("number, insurer, start, end entered in that order, after Nil Depreciation", idx(/^nil dep rate 0\.615$/) < idx(/^tp number /) && idx(/^tp number /) < idx(/^tp insurer /) && idx(/^tp insurer /) < idx(/^tp start /) && idx(/^tp start /) < idx(/^tp end /));
    check("the number is the policy's (upper case), the insurer the list's own spelling", state.number === "NIC/TP/0001" && state.insurer === "National Insurance Company Limited");
    const day = (t) => String(t).replace(/\//g, "-");
    check("start and end date on the page (same day, however the picker writes it)", day(state.start) === "01-10-2026" && day(state.end) === "30-09-2031");
    check("the other insurer was never picked", count(/^tp insurer /) === 1);
    check("Is Registration Address Same: ticked once if it was not, left alone if it was", scenario === "od-addressticked" ? !has(/^address same/) && state.address === true : count(/^address same ticked$/) === 1 && state.address === true);
    check("then Calculate Premium, then Save, in that order, and the premium appeared before Save", idx(/^tp end /) < idx(/^address same|^calculate$/) && idx(/^calculate$/) < idx(/^premium shown$/) && idx(/^premium shown$/) < idx(/^save$/) && /4321/.test(state.premium) && /Proposal Saved Successfully/.test(state.saved));
    check("end state: Helmet off, Zero Depreciation on", state.helmet === false && state.zero === true);
    if (scenario === "od-pa") check("a PA box on the page is left ticked (no PA click, no PA question)", state.paExists && state.pa === true);
    if (scenario === "od-lpg") check("the master said LPG, Reliance has none: Petrol was chosen, and the log says why", has(/^fuel picked Petrol$/) && lines.some((l) => /choosing "Petrol" for a gas fuel on its own, as the owner decided/.test(l)));
    if (scenario === "od-exists") check("the Customer Already Exists popup was cancelled before the run went on", has(/^exists dialog cancelled$/) && idx(/^exists dialog cancelled$/) < idx(/^picked VehicleDetailsMakeModel/));
    if (scenario === "od-tpdatefmt") check("a picker that shows 01-10-2026 as 01/10/2026 is accepted (same day), no fallback used", /^01\/10\/2026$/.test(state.start) && !lines.some((l) => /setting it through the date picker/.test(l)));
  } else if (scenario === "tp") {
    check("TP stops at its product list, nothing chosen", result.stage === "tp-product" && events.length === 1 && events[0] === "two wheeler");
  } else if (scenario === "tp-configured") {
    check("TP has no TP Details box and never stops at Nil Depreciation", !has(/^tp box open$/) && quitting);
    check("TP never looks for a Fuel Type box (the page has none and TP does not care)", !has(/^fuel/));
    check("TP still handles PA (the opt-out click and its question)", has(/^PA box clicked/) && has(/^PA question answered No$/));
    check("TP goes on through Helmet and Zero Depreciation to the financier step", has(/^helmet unticked$/) && has(/^zero dep ticked$/));
  }
  console.log(`--- files this run left in the project: ${cleaned_files} (removed) ---`);
  console.log("--- checks ---");
  let failed = 0;
  for (const [name, ok] of checks) { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) failed++; }
  console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
  await driver.quit().catch(() => {});
  server.close();
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error("RUNNER ERROR", e); process.exit(2); });
