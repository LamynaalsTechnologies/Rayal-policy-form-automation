#!/usr/bin/env node
/**
 * Manual real-Chrome check of the United India (UIIC) login and the handler's Breaker stop (2026-11-06).
 * NOT part of `npm test` (it starts Chrome). Run by hand:   node test/manual/uiicReplica/loginCheck.js
 *
 * A local replica of the UIIC login page (built from what the old download project's code reads - NOT from the live
 * portal): readonly boxes that unlock on focus, a captcha picture, the #loginError box, a page-per-request form POST,
 * a dashboard behind a blockUI overlay with the "View Reports and Queries" menu a[data-target='#10'] and the sidebar's
 * Policy Transaction toggle (data-target="#3", its submenu slides in after 600 ms) -> Make New/Renew Policy
 * (../portal/MenuAction.do?method=strbtn, a page with #selectProduct) - the owner's markup.
 * The captcha reader is a fake that asks the replica for the right text (OpenAI is never called). Touches no portal, no
 * S3, no database; the handler's browser profile goes to a temporary folder that is removed afterwards.
 * Prints PASS / FAIL lines and ends with RESULT: ALL PASS (exit 0) or RESULT: n FAILED.
 */
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..");

process.env.HEADLESS = "true";
process.env.MULTI_COMPANY_AUTOMATION_ENABLED = "true";
process.env.KEEP_BROWSER_OPEN_ON_ERROR = "false";
process.env.RECORDING_ENABLED = "false";

/* ------------------------------------------------ the replica ------------------------------------------------ */

const sessions = new Map(); // sid -> { captcha, posts }
let scenario = "success";
const USER = "UIIC-TEST-1";
const PASS = "pw-test-1";

const newCaptcha = () => Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "Q").padEnd(5, "Z");
const session = (req, res) => {
  const m = /sid=([a-z0-9]+)/.exec(req.headers.cookie || "");
  let sid = m && m[1];
  if (!sid || !sessions.has(sid)) {
    sid = Math.random().toString(36).slice(2);
    sessions.set(sid, { captcha: newCaptcha(), posts: 0 });
    res.setHeader("Set-Cookie", `sid=${sid}; Path=/`);
  }
  return sessions.get(sid);
};
let lastSession = null;

const loginPage = (s, error = "") => {
  s.captcha = newCaptcha();
  return `<!doctype html><html><head><title>UIIC Login</title></head><body>
  <form id="loginForm" method="post" action="/GCWebPortal/login/LoginAction.do">
    <input id="username" name="userName" type="text" readonly onfocus="this.removeAttribute('readonly')">
    <input id="password" name="userPaWord" type="password" readonly onfocus="this.removeAttribute('readonly')">
    <img id="captchaImg" src="/captcha.svg?t=${Date.now()}" width="156" height="50">
    <input id="userCaptcha" name="userCaptcha" type="text" readonly onfocus="this.removeAttribute('readonly')">
    <button id="login" type="submit">LOGIN</button>
  </form>
  ${error ? `<div id="loginError" class="loginError" style="color:red">${error}</div>` : `<div id="loginError" class="loginError"></div>`}
  </body></html>`;
};

const dashboard = (marker) => `<!doctype html><html><head><title>UIIC Home</title></head><body>
  <div class="blockUI blockOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>
  <script>setTimeout(function(){ var o=document.querySelector('.blockUI'); if(o) o.remove(); }, 1500);</script>
  ${marker ? `<a href="#" data-target="#10">View Reports and Queries</a>` : ""}
  <a href="javascript:;" data-toggle="collapse" data-target="#3" class="menuColor"><i class="fa fa-fw fa-square"></i> <font class="menu_link_big">Policy Transaction </font><i class="fa fa-fw fa-caret-down"></i></a>
  <ul id="3" style="display:none">
    <li><a href="../portal/MenuAction.do?method=strbtn" class="subMenuColor"><font class="menu_link_small"> <i class="fa fa-fw fa-circle"></i>Make New/Renew Policy</font></a></li>
  </ul>
  <script>
    var ignore = ${scenario === "menu-ignores-first" ? 1 : 0};
    document.querySelector("a[data-target='#3']").addEventListener("click", function () {
      if (ignore > 0) { ignore--; return; }            // a click the page swallowed
      var ul = document.getElementById("3");
      var open = ul.style.display !== "none";
      setTimeout(function () { ul.style.display = open ? "none" : "block"; }, 600); // the collapse animation
    });
  </script>
  <a href="/GCWebPortal/portal/HomeAction.do?x=1">Home</a> <a href="/GCWebPortal/logout">Logout</a>
  </body></html>`;

// The Products page (the owner's screenshot + markup): Office and LOB filled by the portal, the product list, Submit.
const PRODUCT_OPTIONS = [
  ["3199", "Motor Package Policy"], ["319916", "Motor Package Policy Renewal"], ["3102", "Liability Only Policy"],
  ["310216", "Liability Only Policy Renewal"], ["3162", "Two Wheelers Long Term Liability"],
  ["316216", "Two Wheelers Long Term Liability Renewal"], ["3121", "Motor Standalone OD New"],
  ["312116", "Motor Standalone OD Renew"], ["310016", "Motor Policy Renewal By Vehicle Registration Number"],
];
let submittedProduct = null;
const makeNewPage = () => `<!doctype html><html><head><title>Make New/Renew Policy</title></head><body>
  <form method="post" action="/GCWebPortal/portal/ProductAction.do" ${scenario === "new-window" ? 'target="_blank"' : ""} ${scenario === "submit-alert" ? `onsubmit="alert('Please select the Office'); return false;"` : ""}>
    <label>Select Office</label><select name="officeCode" class="form-control"><option value="280300" selected>DO VELLORE(280300)</option></select>
    <label>Select LOB</label><select name="lobCode" class="form-control"><option value="31" selected>Motor</option></select>
    <label>Select Product</label>
    <select name="productCode" id="productCode" class="form-control">${PRODUCT_OPTIONS.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
    <input type="Submit" name="method" value="Submit" id="selectProduct" class="btn btn-primary">
  </form></body></html>`;
// Risk Details (the owner's screenshot + markup): Vehicle Class and Vehicle Registration State, whose onchange loads the next
// lists behind a short loader - so a real pick must fire them.
const VEHICLE_CLASSES = [["0", "select"], ["24", "E-Rickshaw"], ["3", "Motorcycle / Scooter"], ["23", "Pass Carrying - 2-wh"], ["18", "Private Car"]];
const REG_STATES = [["select", "Select"], ["40", "ANDHRA PRADESH"], ["41", "KARNATAKA"], ["95", "PONDICHERRY U.T."], ["43", "TAMIL NADU"], ["39", "WEST BENGAL"]];
const nextPage = () => `<!doctype html><html><head><title>Risk Details</title></head><body><h3>Risk Details</h3>
  <div id="busy" class="blockUI blockOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>
  <select name="vehicleType" onchange="populateManufacturer();" id="v_make" class="my_control form-control AfterUpdateSelect">${VEHICLE_CLASSES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
  <select name="vehRgnState" onchange="getRegNoRta()" id="regst" class="AfterUpdateSelect my_control form-control">${REG_STATES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
  <input type="checkbox" name="ynNewVehicle" value="-1" onclick="valueset1();disableRegistration();getRegState();" id="newvehchk1">
  <input type="text" id="regNo1" size="4"> <input type="text" id="regNo2" size="4">
  <input type="text" name="chasisNumber" maxlength="30" size="25" value="" onkeyup="toupper(this.id,event)" id="chasisNumber" class="AfterUpdateInput my_control form-control newNameClass error">
  <input type="text" name="engineNumber" maxlength="30" size="25" value="" onkeyup="toupper(this.id,event)" id="engineNumber" class="AfterUpdateInput my_control form-control newNameClass">
  <select id="manufacturer"><option>select</option></select>
  <select name="selectedNumNameCode" onchange="retrieveURL()" id="selectedNumNameCode" class="my_control form-control AfterUpdateSelect"><option value="0" selected="selected">select</option>
    <option value="IBB4566@BAJAJ">BAJAJ</option><option value="IBB4560@HONDA">HONDA</option>
    <option value="3724@HONDA MOTORCYCLE &amp; SCOOTER INDIA PVT LTD_NONGICOUNCIL">HONDA MOTORCYCLE &amp; SCOOTER INDIA PVT LTD_NONGICOUNCIL</option>
    <option value="3710@HONDA_NONGICOUNCIL">HONDA_NONGICOUNCIL</option><option value="IBB4568@HERO">HERO</option></select>
  <select name="makeMotorDisplay" onchange="policyURL();FunctionChange()" id="makeMotorDisplay" class="AfterUpdateSelect my_control form-control"><option value="0" selected="selected">select</option></select>
  <select id="rta"><option>select</option></select>
  <script>
    function busyThen(fn) { var b = document.getElementById('busy'); b.style.display = 'block'; setTimeout(function () { fn(); b.style.display = 'none'; }, 700); }
    function populateManufacturer() { busyThen(function () { document.getElementById('manufacturer').innerHTML = '<option>select</option><option>HONDA</option><option>HERO</option>'; }); }
    function getRegNoRta() { busyThen(function () { document.getElementById('rta').innerHTML = '<option>select</option><option>TN-31</option>'; }); }
    var newVehicleTicks = 0;
    function valueset1() { newVehicleTicks++; }
    function disableRegistration() { var c = document.getElementById('newvehchk1').checked; document.getElementById('regNo1').disabled = c; document.getElementById('regNo2').disabled = c; }
    function getRegState() { ${scenario === "newveh-resets-state" ? "document.getElementById('regst').value = 'select';" : ""} }
    function toupper(id) { var e = document.getElementById(id); e.value = e.value.toUpperCase(); }
    var policyUrlCalls = 0;
    function retrieveURL() {
      var v = document.getElementById('selectedNumNameCode').value;
      busyThen(function () {
        document.getElementById('makeMotorDisplay').innerHTML = '<option value="0">select</option>' +
          (v === 'IBB4560@HONDA' ? '<option value="11">ACTIVA 6G</option><option value="12">ACTIVA 125</option><option value="13">DIO</option>' : '<option value="91">OTHER</option>');
      });
    }
    function policyURL() { policyUrlCalls++; }
    function FunctionChange() {}
  </script>
  <a href="/GCWebPortal/portal/HomeAction.do">Home</a></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/captcha.svg") {
    const s = session(req, res);
    res.setHeader("Content-Type", "image/svg+xml");
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="156" height="50"><rect width="156" height="50" fill="#eee"/><text x="20" y="34" font-size="26" font-family="monospace">${s.captcha}</text></svg>`);
  }
  if (url.pathname === "/GCWebPortal/login/LoginAction.do" && req.method === "GET") {
    const s = session(req, res);
    lastSession = s;
    res.setHeader("Content-Type", "text/html");
    return res.end(loginPage(s));
  }
  if (url.pathname === "/GCWebPortal/login/LoginAction.do" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const s = session(req, res);
      lastSession = s;
      s.posts += 1;
      const f = new URLSearchParams(body);
      res.setHeader("Content-Type", "text/html");
      if (f.get("userCaptcha") !== s.captcha) return res.end(loginPage(s, "Please enter valid Captcha"));
      if (f.get("userName") !== USER || f.get("userPaWord") !== PASS) return res.end(loginPage(s, "Invalid User Id or Password"));
      res.statusCode = 302;
      res.setHeader("Location", "/GCWebPortal/portal/HomeAction.do");
      return res.end();
    });
    return;
  }
  if (url.pathname === "/GCWebPortal/portal/HomeAction.do") {
    res.setHeader("Content-Type", "text/html");
    return res.end(dashboard(scenario !== "nomarker"));
  }
  if (url.pathname === "/GCWebPortal/portal/MenuAction.do" && url.searchParams.get("method") === "strbtn") {
    res.setHeader("Content-Type", "text/html");
    return res.end(makeNewPage());
  }
  if (url.pathname === "/GCWebPortal/portal/ProductAction.do" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      submittedProduct = new URLSearchParams(body).get("productCode");
      res.setHeader("Content-Type", "text/html");
      res.end(nextPage());
    });
    return;
  }
  res.statusCode = 404;
  res.end("not here");
});

/* ------------------------------------------------ the checks ------------------------------------------------ */

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failed += 1;
};

// The fake captcha reader: the right text unless the scenario wants the first read wrong. It also checks the picture is
// a PNG that was enlarged (the canvas step), by its width in the PNG header.
let reads = [];
const pngWidth = (dataUrl) => {
  const b = Buffer.from(String(dataUrl).split(",")[1] || "", "base64");
  return b.length > 24 ? b.readUInt32BE(16) : 0;
};
const fakeReader = async (imageUrl) => {
  reads.push(pngWidth(imageUrl));
  if (scenario === "captcha-first-wrong" && reads.length === 1) return "WRONG";
  return lastSession ? lastSession.captcha : "";
};

// Patch the reader BEFORE the strategy module is loaded (it takes extractCaptchaText when it loads).
const Captcha = require(path.join(ROOT, "Captcha.js"));
Captcha.extractCaptchaText = async (imageUrl) => ({ success: true, text: await fakeReader(imageUrl) });

const { Builder } = require(path.join(ROOT, "node_modules", "selenium-webdriver"));
const chrome = require(path.join(ROOT, "node_modules", "selenium-webdriver", "chrome"));
const { runLogin } = require(path.join(ROOT, "multiCompany/common/login/runLogin"));
const { openMakeNewRenewPolicy } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaMenu"));
const { chooseProduct } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaProduct"));
const { fillVehicleClassAndState, fillRiskDetails } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaRisk"));
const { watchRetainedBrowser } = require(path.join(ROOT, "lib/retainedBrowser"));
const jobDirs = require(path.join(ROOT, "lib/jobDirs"));
const ui = require(path.join(ROOT, "multiCompany/common/login/unitedIndiaLogin"));

const newDriver = () => {
  const o = new chrome.Options();
  o.addArguments("--headless=new", "--window-size=1366,768", "--no-sandbox", "--disable-dev-shm-usage");
  return new Builder().forBrowser("chrome").setChromeOptions(o).build();
};

async function loginScenario(name, port, run) {
  scenario = name;
  reads = [];
  sessions.clear();
  const driver = await newDriver();
  const lines = [];
  try {
    await run(driver, { loginUrl: `http://127.0.0.1:${port}/GCWebPortal/login/LoginAction.do?p=login`, lines, ctx: { jobId: name, log: (l) => lines.push(String(l)) } });
  } finally {
    await driver.quit().catch(() => {});
  }
}

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const strategy = { ...ui.createUnitedIndiaStrategy({ readCaptcha: fakeReader }) };

  await loginScenario("success", port, async (driver, { loginUrl, lines, ctx }) => {
    const t0 = Date.now();
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    check(true, `success: logged in (${Date.now() - t0} ms)`);
    check(lastSession.posts === 1, `success: one submit (got ${lastSession.posts})`);
    check(reads.length === 1 && reads[0] > 156, `success: the captcha picture was enlarged before reading (width ${reads[0]})`);
    const overlay = await driver.executeScript("return !!document.querySelector('.blockUI')");
    check(!overlay, "success: the login returned only after the dashboard's loader cleared");
    check(!lines.some((l) => l.includes(PASS)), "success: the password is not in the log");
  });

  await loginScenario("captcha-first-wrong", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    check(reads.length === 2, `captcha refused: a fresh captcha was read (${reads.length} reads)`);
    check(lines.some((l) => /captcha rejected/.test(l)), "captcha refused: the portal's captcha error was recognised");
  });

  await loginScenario("wrong-password", port, async (driver, { loginUrl, ctx }) => {
    let error = null;
    try {
      await runLogin(driver, strategy, { username: USER, password: "WRONG-PW", loginUrl }, ctx);
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E203" && error.retryable === false, `wrong password: [E203], not retried (${error && error.code})`);
    check(lastSession.posts === 1, `wrong password: submitted once (got ${lastSession.posts})`);
    check(error && /Invalid User Id or Password/.test(error.message), "wrong password: the portal's words are in the sentence");
  });

  await loginScenario("nomarker", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    check(true, "dashboard without the known menu: logged in by 'login box gone on a finished page'");
  });

  await loginScenario("menu", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    const out = await openMakeNewRenewPolicy(driver, { log: ctx.log });
    check(/MenuAction\.do\?method=strbtn/.test(out.url), `menu: the Make New/Renew Policy page opened (${out.url})`);
    check(await driver.executeScript("return !!document.getElementById('selectProduct')"), "menu: its product selection is on the page");
    check(lines.some((l) => /"Policy Transaction" clicked - its submenu/.test(l)), "menu: the Policy Transaction click was confirmed by the submenu");
  });

  await loginScenario("menu-ignores-first", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    check(lines.some((l) => /↻ United India - "Policy Transaction" was clicked but its submenu/.test(l)), "menu: a swallowed click was seen and clicked once more");
    check(lines.some((l) => /Make New\/Renew Policy page is open \(/.test(l)), "menu: then the page opened");
  });

  await loginScenario("menu-already-open", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await driver.executeScript("document.getElementById('3').style.display = 'block'");
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    check(lines.some((l) => /"Policy Transaction" not clicked - its submenu .* is open already/.test(l)), "menu: an open menu is not clicked (it would close)");
  });

  await loginScenario("product", port, async (driver, { loginUrl, lines, ctx }) => {
    submittedProduct = null;
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    const out = await chooseProduct(driver, { log: ctx.log });
    check(out.value === "3102" && submittedProduct === "3102", `product: Liability Only Policy (3102) was submitted (the portal got ${submittedProduct})`);
    check(/ProductAction\.do/.test(out.url), `product: the next page opened (${out.url})`);
    check(await driver.executeScript("return document.title === 'Risk Details'"), "product: the next page is Risk Details");
    check(lines.some((l) => l.includes('Select Office = "DO VELLORE(280300)"')) && lines.some((l) => l.includes('Select LOB = "Motor"')), "product: Office and LOB were read and left as they were");
  });

  for (const [name, customerState, regValue] of [["risk", "tamilnadu", "43"], ["new-window", "pondicherry", "95"], ["newveh-resets-state", "tamilnadu", "43"]]) {
    await loginScenario(name, port, async (driver, { loginUrl, lines, ctx }) => {
      await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
      await openMakeNewRenewPolicy(driver, { log: ctx.log });
      await chooseProduct(driver, { log: ctx.log });
      if (name === "new-window") check(lines.some((l) => /the next page opened in a new window/.test(l)), "risk: Submit opened a NEW window and the run followed it");
      await fillRiskDetails(driver, { customerState, chassisNumber: "md626dg56s2h08322", engineNumber: "fg5hs2808545", vehicleMake: "HONDA", vehicleModel: "ACTIVA 6G" }, { log: ctx.log });
      const page = await driver.executeScript(`return {
        cls: document.getElementById('v_make').value, st: document.getElementById('regst').value,
        makers: document.getElementById('manufacturer').options.length, rtas: document.getElementById('rta').options.length,
        busy: document.getElementById('busy').style.display,
        ticked: document.getElementById('newvehchk1').checked, ticks: newVehicleTicks, regDisabled: document.getElementById('regNo1').disabled,
        chassis: document.getElementById('chasisNumber').value, engine: document.getElementById('engineNumber').value,
        maker: document.getElementById('selectedNumNameCode').value, make: document.getElementById('makeMotorDisplay').value, policyUrlCalls: policyUrlCalls };`);
      check(page.maker === "IBB4560@HONDA" && page.make === "11" && page.policyUrlCalls === 1, `risk (${name}): Vehicle Manufacturer HONDA (exact, ${page.maker}) and Make ACTIVA 6G (${page.make}) from the list retrieveURL loaded`);
      check(page.ticked && page.ticks === 1 && page.regDisabled, `risk (${name}): New Vehicle ticked once, its onclick ran (registration boxes disabled)`);
      check(page.chassis === "MD626DG56S2H08322" && page.engine === "FG5HS2808545", `risk (${name}): Chassis ${page.chassis} and Engine ${page.engine} typed and upper-cased by the page`);
      if (name === "newveh-resets-state") check(lines.some((l) => /ticking New Vehicle changed the Vehicle Registration State/.test(l)), "risk: the tick reset the state (getRegState) and the customer's state was chosen again");
      check(page.cls === "3", `risk (${name}): Vehicle Class = Motorcycle / Scooter (${page.cls})`);
      check(page.st === regValue, `risk (${name}): Vehicle Registration State = the customer's ${customerState} (${page.st})`);
      check(page.makers > 1 && page.rtas > 1, `risk (${name}): both boxes' onchange ran (manufacturers ${page.makers}, RTAs ${page.rtas})`);
      check(page.busy === "none", `risk (${name}): it went on only after the portal's loader cleared`);
    });
  }

  await loginScenario("submit-alert", port, async (driver, { loginUrl, ctx }) => {
    submittedProduct = null;
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    let error = null;
    try {
      await chooseProduct(driver, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E308" && /Please select the Office/.test(error.message), `product: the portal's alert after Submit is reported in its words (${error && error.message})`);
    check(submittedProduct === null, "product: nothing reached the portal past the alert");
  });

  await loginScenario("still-login-page", port, async (driver, { loginUrl }) => {
    await driver.get(loginUrl);
    check((await ui.isLoggedIn(driver)) === false, "the login page itself never reads as logged in");
  });

  // The handler end to end: the real session manager (Chrome in a temp folder), the real login, then the Breaker.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uiic-replica-"));
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    for (const [breaker, expect] of [
      ["true", /Stopped on purpose at checkpoint "stopthis-location"/],
      ["false", /Vehicle Manufacturer and Make entered, the rest of the TP form is not built yet/],
    ]) {
      scenario = "success";
      reads = [];
      sessions.clear();
      process.env.BREAKER_ENABLED = breaker;
      process.env.BREAKER_STOP_AT = "stopthis-location";
      const { fillUnitedIndiaTP } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP"));
      const result = await fillUnitedIndiaTP({
        firstName: "Replica",
        customerState: "tamilnadu",
        chassisNumber: "MD626DG56S2H08322",
        engineNumber: "FG5HS2808545",
        vehicleMake: "HONDA",
        vehicleModel: "ACTIVA 6G",
        username: USER,
        password: PASS,
        loginUrl: `http://127.0.0.1:${port}/GCWebPortal/login/LoginAction.do?p=login`,
      });
      check(result && result.inProgress === true && result.retryable === false && expect.test(result.error || ""), `handler, Breaker ${breaker}: stopped after the login ("${result && result.error}")`);
    }
    // a kept window closed by hand: its own profile goes, an other window's stays (lib/retainedBrowser.js)
    {
      const mk = (name) => {
        const d = path.join(tmp, "kept", name);
        fs.mkdirSync(d, { recursive: true });
        return d;
      };
      const dirA = mk("A");
      const dirB = mk("B");
      const chromeOn = (dir) => {
        const o = new chrome.Options();
        o.addArguments("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", `--user-data-dir=${dir}`);
        return new Builder().forBrowser("chrome").setChromeOptions(o).build();
      };
      const a = await chromeOn(dirA);
      const b = await chromeOn(dirB);
      jobDirs.claim(dirA);
      jobDirs.claim(dirB);
      const quietLog = () => {};
      const wa = watchRetainedBrowser({ label: "Kept A", driver: a, dirs: [dirA], log: quietLog, pollMs: 60000 });
      const wb = watchRetainedBrowser({ label: "Kept B", driver: b, dirs: [dirB], log: quietLog, pollMs: 60000 });
      check((await wa.check()) === false && fs.existsSync(dirA), "kept window: while it is open nothing is removed");
      await a.close(); // the owner closes window A
      await new Promise((r) => setTimeout(r, 500));
      check((await wa.check()) === true && !fs.existsSync(dirA), "kept window: closing it removed its own profile");
      check((await wb.check()) === false && fs.existsSync(dirB), "kept window: the OTHER window and its profile are untouched");
      await b.close();
      await new Promise((r) => setTimeout(r, 500));
      check((await wb.check()) === true && !fs.existsSync(dirB), "kept window: closing the second one removed its profile too");
    }
    const left = fs.existsSync(path.join(tmp, "cloned_profiles_united_india"))
      ? fs.readdirSync(path.join(tmp, "cloned_profiles_united_india"))
      : [];
    check(left.length === 0, `handler: its profile folder was removed after the stop (${left.length} left)`);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  server.close();
  console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
