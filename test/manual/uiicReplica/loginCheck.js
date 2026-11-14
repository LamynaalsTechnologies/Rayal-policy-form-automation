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

// S3 is never reached: the screenshot upload is replaced BEFORE anything that uses it is loaded (screenshot.js takes it
// when it loads). Every picture is kept here instead, to check it is a real PNG of the page.
const uploads = [];
const fileUploads = [];
{
  const s3 = require(path.join(ROOT, "s3Uploader"));
  s3.uploadScreenshotToS3 = async (base64, key) => {
    uploads.push({ base64: String(base64 || ""), key });
    return `https://replica.invalid/${key}`;
  };
  s3.uploadToS3 = async (filePath, key) => {
    fileUploads.push({ key, bytes: fs.readFileSync(filePath) });
    return `https://replica.invalid/${key}`;
  };
  s3.getPresignedUrl = async (key) => `https://replica.invalid/${key}?signed`;
}
// the browser's downloads (Generate Quote) go to a temporary folder, never the home Downloads
const REPLICA_DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), "uiic-replica-dl-"));
const isPng = (b64) => Buffer.from(String(b64 || ""), "base64").slice(0, 4).toString("hex") === "89504e47";

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
    <li><a href="../motor/proposalModification.do?userCode=BRC000094001550&amp;USERTYPE=BROKER&amp;officeCode=BRC000094001550&amp;COMPANYCODE=BRC0000940&amp;proposalType=11&amp;ENTERPRISE=TRUE&amp;POLICY=Y&amp;parameter=proposalModify" class="subMenuColor"><font class="menu_link_small"> <i class="fa fa-fw fa-circle"></i>Proposal Modification</font></a></li>
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
const MAKERS = `<option value="IBB4566@BAJAJ">BAJAJ</option><option value="IBB4560@HONDA">HONDA</option>
    <option value="3724@HONDA MOTORCYCLE &amp; SCOOTER INDIA PVT LTD_NONGICOUNCIL">HONDA MOTORCYCLE &amp; SCOOTER INDIA PVT LTD_NONGICOUNCIL</option>
    <option value="3710@HONDA_NONGICOUNCIL">HONDA_NONGICOUNCIL</option><option value="IBB4568@HERO">HERO</option>`;
const MONTH_OPTIONS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  .map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}"${i === 0 ? ' selected="selected"' : ""}>${m}</option>/&gt;`)
  .join("\n            ");
// A TALL page with smooth scrolling (some portals set it): the boxes after the Make are far below the screen, so the run
// must put each in the middle at once (the owner, 2026-11-13: the video did not show the fields lower on the page).
const SPACER = `<div class="spacer" style="height:1100px"></div>`;
// the live portal's refusal box (the owner, 2026-11-13); shown on the page United India sends back
const N002219 = "N002219, PolicyInception Date should be on or later to Proposal Date .";
let pageError = "";
const errorBoxHtml = (line) => `<div class="errorMsg"><ul><div class="errormsgbox">Error In Data Entry<ul style="font-weight:normal;"><li>     ${line}</li></ul></div></ul></div>`;
const todayIndia = () => require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaDates")).todayInIndia(Date.now).date;
const dayKey = (d) => String(d || "").split("/").reverse().join("");
const nextPage = () => `<!doctype html><html><head><title>Risk Details</title><style>html { scroll-behavior: smooth; }</style></head><body><h3>Risk Details</h3>
  <div id="err">${pageError ? errorBoxHtml(pageError) : ""}</div>
  <div id="busy" class="blockUI blockOverlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.2)"></div>
  <select name="vehicleType" onchange="populateManufacturer();" id="v_make" class="my_control form-control AfterUpdateSelect">${VEHICLE_CLASSES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
  <select name="vehRgnState" onchange="getRegNoRta()" id="regst" class="AfterUpdateSelect my_control form-control">${REG_STATES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
  <input type="checkbox" name="ynNewVehicle" value="-1" onclick="valueset1();disableRegistration();getRegState();" id="newvehchk1">
  <input type="text" id="regNo1" size="4"> <input type="text" id="regNo2" size="4">
  <input type="text" name="chasisNumber" maxlength="30" size="25" value="" onkeyup="toupper(this.id,event)" id="chasisNumber" class="AfterUpdateInput my_control form-control newNameClass error">
  <input type="text" name="engineNumber" maxlength="30" size="25" value="" onkeyup="toupper(this.id,event)" id="engineNumber" class="AfterUpdateInput my_control form-control newNameClass">
  <select id="manufacturer"><option>select</option></select>
  <select name="selectedNumNameCode" onchange="retrieveURL()" id="selectedNumNameCode" class="my_control form-control AfterUpdateSelect"><option value="0" selected="selected">select</option>
    ${scenario === "makers-late" ? "" : MAKERS}</select>
  <select name="makeMotorDisplay" onchange="policyURL();FunctionChange()" id="makeMotorDisplay" class="AfterUpdateSelect my_control form-control"><option value="0" selected="selected">select</option></select>
  <select id="rta"><option>select</option></select>
  ${SPACER}
  <input type="text" name="dateOfPurchaseString" size="10" value="" onclick="setYears(1900, 2050);showCalender(this, 'dateOfPurchaseString', 'registrationDateValidation','');" readonly="readonly" id="dtPurchaseStr" class="AfterUpdateInput my_control form-control searchBox newNameClass error">
  <div id="calendar" style="display:none">calendar</div>
  <select name="makeMonthgc" style="border: 1px solid #C6C6CC;" class="AfterUpdateSelect my_control form-control">${MONTH_OPTIONS}</select>
  <input type="text" name="yearOfManufacturing" size="10" value="2026" id="yearOfManufacturing" class="AfterUpdateInput my_control form-control newNumericClass valid">
  <select name="ynPuc" id="repository" class="AfterUpdateSelect my_control form-control"><option value="S" selected="selected">Select</option><option value="Yes">Yes</option><option value="No">No</option></select>
  <select name="ynDncr" id="repository" class="AfterUpdateSelect my_control form-control"><option value="S" selected="selected">select</option><option value="Yes">Yes</option><option value="No">No</option></select>
  ${SPACER}
  <form name="VehicleForm" onsubmit="return false">
  <input type="text" name="dateOfIssueOfPolicyString" size="10" value="${/^resume/.test(scenario) ? PM_DATE : todayIndia()}" onclick="setYears(1900, 2050);showCalender(this, 'dateOfIssueOfPolicyString', 'polStartDateValidation','fuel');" readonly="readonly" id="dateOfIssueOfPolicyString" class="AfterUpdateInput searchBox my_control form-control newNameClass">
  <script>var startChecks = []; function polStartDateValidation(a) { startChecks.push(a); } function setYears() {} function showCalender() {}</script>
  <select name="clientType" onchange="change(document.VehicleForm.insuredname1.value)" id="clientType" class="AfterUpdateSelect my_control form-control"><option value="select" class="MotDea">Select</option>
             <option value="1" selected="selected" class="MotDea">Individual</option>
<option value="4" class="MotDea">Partnership Firm</option>
<option value="5" class="MotDea">Sole Proprietors</option>
<option value="2" class="MotDea">Corporate</option>
<option value="3" class="MotDea">Govt Under Taking</option></select>
  <select name="ynHighRisk" size="1" onchange="toggleHighRisk(this.value)" id="ynHighRisk" style="border: 1px solid #C6C6CC; width:50%;" class="AfterUpdateSelect my_control form-control"><option value="" selected="selected" class="MotDea"><font size="3" face="ariel">Select</font></option>
            <option value="Yes" class="MotDea"><font size="3" face="ariel">Yes</font></option>
            <option value="No" class="MotDea"><font size="3" face="ariel">No</font></option></select>
  <select name="insuredname1" size="1" onchange="setthevalue()" id="insuredname1" style="border: 1px solid #C6C6CC; width:50%;" class="AfterUpdateSelect my_control form-control">
            <option value="MR.">Mr</option><option value="MISS.">Miss</option><option value="MRS.">Mrs</option><option value="MS.">Ms</option></select>
  <input type="text" name="insuredname2" maxlength="200" size="25" value="" onkeyup="nodot(event,1)" id="insuredname2" class="CustReadOnly my_control form-control newNameClass">
  <input type="text" name="addressOfInsured" maxlength="200" size="20" value="" id="addressOfInsured" class="CustReadOnly my_control form-control newNameClass error">
  ${SPACER}
  <input type="text" name="pincodeString" maxlength="6" size="6" value="" onblur="getStateDist()" id="PIN_CODE" class="CustReadOnly my_control form-control newNumericClass " title="please provide valid pincode">
  <select name="state" disabled="disabled" id="STATE_CODE1" class="SelectStateDist my_control form-control"><option value="select" class="MotDea">Select</option>${REG_STATES.filter(([v]) => v !== "select").map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
  <select name="districtCode" disabled="disabled" id="STATE_CODE2" class="SelectStateDist my_control form-control"><option value="select" class="MotDea">Select</option></select>
  <input type="text" name="mobile" maxlength="10" size="10" value="" id="mobile" class="AfterUpdateInput my_control form-control newNumericClass">
  <input type="text" name="emailAddress" maxlength="200" size="15" value="" onblur="validateEmail(this.value)" id="emailAddress" class="AfterUpdateInput my_control form-control">
  <input type="text" name="dateOfBirthString" maxlength="30" size="10" value="" onclick="setYears(1900, 2050);showCalender(this, 'dateOfBirthString', 'normal','');" onblur="checkDateValidation(this.value)" id="dateOfBirthString" class="my_control form-control CustReadOnly searchBox newNameClass">
  <select name="rtaDesc" size="1" onchange="populateInvoiceZone()" id="rtaDesc" class="AfterUpdateSelect my_control form-control"><option value="" selected="selected">Select</option></select>
  <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/MoreCoversNInfo.JPG" width="150" height="35" onclick="fnSubmit('morecoversninfo')" style="cursor:pointer" alt="More Covers N Info">
  ${SPACER}<!-- the rest of the real form is below -->
  <div id="premiumResult"></div>
  <div id="dialog" class="window" style="width: 270px; height: 103px; text-align: center; position: fixed; z-index: 99999; top: 40%; left: 40%; display: none;">
        <img src="../resources/images/wait.gif" alt="Loading..." width="160" height="85">
        <br>
        <span style="color:#3F33FF;">Loading...</span>
    </div>
  <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/ComputePremium.JPG" width="150" height="35" onclick="fnSubmit('computepremium')" style="cursor:pointer" id="compute" name="computeimg1" alt="Compute Premium">
  <img class="afterPremium" src="/GCWebPortal/html/app1/images/Ashok_Leyland/GenerateQuote.JPG" width="100" height="27" onclick="fnSubmit('quote')" style="cursor:pointer;display:${scenario === "update-hang-once" ? "inline" : "none"}" alt="Generate Quote">
  <img class="afterPremium" src="/GCWebPortal/html/app1/images/Ashok_Leyland/Worksheet.JPG" width="100" height="27" onclick="fnSubmit('worksheet')" style="cursor:pointer;display:${scenario === "update-hang-once" ? "inline" : "none"}" alt="Worksheet">
  ${
    /^resume/.test(scenario)
      ? `<img class="afterPremium" src="/GCWebPortal/html/app1/images/Ashok_Leyland/Modify.JPG" width="120" height="27" onclick="fnSubmit('update')" style="cursor:pointer;display:none" id="updt" name="updtimg" alt="Modify">`
      : `<img class="afterPremium" src="/GCWebPortal/html/app1/images/Ashok_Leyland/Update.JPG" width="100" height="27" onclick="fnSubmit('update')" style="cursor:pointer;display:${scenario === "update-hang-once" ? "inline" : "none"}" id="updt" name="updtimg1" alt="Update">`
  }
  <div id="proposalBlock"></div>
  <input type="button" name="verifykyc" value="Update Ckyc" class="btn btn-primary subHeight" style="display:none" onclick="kycVerify('GC202611130155894641','../ckyc/CkycMandate.do?tId');">
  <script>function kycVerify(t, u) { window.open(u + '=' + t, 'ckyc', 'width=900,height=700'); }</script>
  </form>
  <script>
    var clientTypeChanges = 0, titleSets = 0;
    function change() { clientTypeChanges++; }
    function toggleHighRisk(v) { ${scenario === "insured-alert" ? "if (v === 'No') alert('Please declare the high risk status');" : ""} }
    function setthevalue() { titleSets++; }
    function nodot(e) { var el = document.getElementById('insuredname2'); el.value = el.value.replace(/[.]/g, ''); }
    // the portal's own: State and District from the pin code, after a short server call; an unknown pin code fills nothing
    var stateDistCalls = 0;
    function getStateDist() {
      stateDistCalls++;
      var pin = document.getElementById('PIN_CODE').value;
      busyThen(function () {
        setTimeout(function () {
          var known = { '604203': ['43', 'VILLUPURAM'], '600001': ['43', 'CHENNAI'] }[pin];
          if (!known) return;
          document.getElementById('STATE_CODE1').value = known[0];
          document.getElementById('STATE_CODE2').innerHTML = '<option value="select">Select</option><option value="601" selected>' + known[1] + '</option>';
        }, 1500);
      });
    }
  </script>
  <script>
    var calendarOpens = 0, dateChecks = [];
    function setYears() {}
    function showCalender() { calendarOpens++; document.getElementById('calendar').style.display = 'block'; }
    function registrationDateValidation() {
      dateChecks.push(document.getElementById('dtPurchaseStr').value);
      ${scenario === "purchase-alert" ? "alert('Date of Purchase should not be greater than Date of Registration');" : ""}
    }
  </script>
  <script>
    function busyThen(fn) { var b = document.getElementById('busy'); b.style.display = 'block'; setTimeout(function () { fn(); b.style.display = 'none'; }, 700); }
    function populateManufacturer() { busyThen(function () { document.getElementById('manufacturer').innerHTML = '<option>select</option><option>HONDA</option><option>HERO</option>'; }); ${
      // the manufacturers arrive 6 s after the Vehicle Class (a slow portal), after the run is ready for them: it must wait
      scenario === "makers-late" ? `setTimeout(function () { document.getElementById('selectedNumNameCode').insertAdjacentHTML('beforeend', ${JSON.stringify(MAKERS)}); window.makersArrivedAt = Date.now(); }, 6000);` : ""
    } }
    // the RTO list follows the Vehicle Registration State (the owner's Pondicherry list; a Tamil Nadu one)
    var RTO_LISTS = {
      '95': '<option value="" class="MotDea"></option><option value="PY@261066" class="MotDea">PY</option><option value="PY01 PONDICHERRY@2897" class="MotDea">PY01 PONDICHERRY</option><option value="PY02 KARAIKAL@2898" class="MotDea">PY02 KARAIKAL</option><option value="PY03 MAHE@2899" class="MotDea">PY03 MAHE</option><option value="PY04 YANAM@2900" class="MotDea">PY04 YANAM</option><option value="PY05 PUDUCHERRY@17294" class="MotDea">PY05 PUDUCHERRY</option>',
      '43': '<option value="" class="MotDea"></option><option value="TN@1">TN</option><option value="TN01 CHENNAI@11">TN01 CHENNAI CENTRAL</option><option value="TN55 SALEM@55">TN55 SALEM</option><option value="TN-56 PERUNDURAI@56">TN-56 PERUNDURAI</option><option value="TN57 DINDIGUL@57">TN57 DINDIGUL</option><option value="TN59 MADURAI@59">TN59 MADURAI</option>'
    };
    function getRegNoRta() { busyThen(function () {
      document.getElementById('rta').innerHTML = '<option>select</option><option>TN-31</option>';
      document.getElementById('rtaDesc').innerHTML = '<option value="" selected="selected">Select</option>' + (RTO_LISTS[document.getElementById('regst').value] || '');
    }); }
    // the portal's own: More Covers N Info submits the form to the next page (the first call swallowed in one scenario)
    var fnSubmitCalls = 0, swallow = ${scenario === "morecovers-swallow" ? 1 : 0};
    // Compute Premium: the portal's GSTIN/UIN question (a real confirm()), then its loader while it works out the premium
    var gstAnswers = [], computeCalls = 0, lostClicks = 0, updateCalls = 0;
    // "compute-hang": the loader never stops on any page; "compute-hang-once": only on the first page (a refresh loads a good one)
    var HANG = ${scenario === "compute-hang" || (scenario === "compute-hang-once" && hangPagesLeft-- > 0) ? "true" : "false"};
    var UPDATE_HANG = ${scenario === "update-hang-once" && updateHangPagesLeft-- > 0 ? "true" : "false"};
    // "compute-hang-once": the page after the refresh comes back worked out (the premium and the buttons on it)
    var WORKED_OUT = ${(scenario === "compute-hang-once" && hangPagesLeft < 0) || workedOutNow ? "true" : "false"};
    if (WORKED_OUT) window.addEventListener('DOMContentLoaded', function () {
      document.getElementById('premiumResult').textContent = 'Net Premium 1,234';
      var a = document.querySelectorAll('.afterPremium'); for (var k = 0; k < a.length; k++) a[k].style.display = 'inline';
    });
    var PROPOSAL_HTML = ${JSON.stringify(/^resume/.test(scenario) ? PROPOSAL_HTML.replace("202611131194829", "202611131375485").replace("13/11/2026", todayIndia()) : PROPOSAL_HTML)};
    var GST_TEXT = ${JSON.stringify(GST_QUESTION_TEXT)};
    function fnSubmit(a) {
      fnSubmitCalls++;
      if (window.jQuery && window.jQuery.active > 0) { lostClicks++; return; } // the portal is busy: the click is lost
      if (a === 'computepremium') {
        computeCalls++;
        ${scenario === "compute-zone" ? "alert('Please select the Zone'); return;" : ""}
        var ok = confirm(GST_TEXT);
        gstAnswers.push(ok);
        if (!ok) return;
        var b = document.getElementById('dialog'); b.style.display = 'block'; // United India's own "Loading..." box
        ${scenario === "compute-submits-slow" ? "var fs = document.VehicleForm; fs.method = 'post'; fs.action = '/GCWebPortal/motor/gc_ashokleyland1.do'; fs.submit(); return; // the live portal: the page is SENT" : ""}
        if (HANG) return; // the loader never stops (on this page)
        setTimeout(function () {
          document.getElementById('premiumResult').textContent = 'Net Premium 1,234';
          b.style.display = 'none';
          var after = document.querySelectorAll(${scenario === "compute-no-quote" ? "'#updt'" : "'.afterPremium'"});
          for (var i = 0; i < after.length; i++) after[i].style.display = 'inline'; // Generate Quote ... only now
        }, 3000);
        return;
      }
      if (a === 'worksheet') { window.open('/GCWebPortal/portal/Worksheet.do', 'worksheet'); return; } // a new page
      if (a === 'update') {
        // the GSTIN question again, the Loading box, then the proposal (the owner's markup)
        updateCalls++;
        var okU = confirm(GST_TEXT);
        gstAnswers.push(okU);
        if (!okU) return;
        var dU = document.getElementById('dialog'); dU.style.display = 'block';
        if (UPDATE_HANG) return; // this page's Update never finishes
        setTimeout(function () {
          document.getElementById('proposalBlock').innerHTML = PROPOSAL_HTML;
          dU.style.display = 'none';
          ${/^resume/.test(scenario) || scenario === "kyc-new" ? "document.querySelector(\"input[name='verifykyc']\").style.display = 'inline'; // Update Ckyc, after Update / Modify" : ""}
          ${scenario === "compute-no-quote" ? "var q = document.querySelectorAll('.afterPremium'); for (var j = 0; j < q.length; j++) q[j].style.display = 'inline'; // Generate Quote only after Update" : ""}
        }, 2000);
        return;
      }
      if (swallow > 0) { swallow--; return; }
      var f = document.VehicleForm; f.method = 'post'; f.action = '/GCWebPortal/portal/MoreCovers.do?method=' + a; f.submit();
    }
    var emailChecks = [], dobChecks = [], invoiceZoneCalls = 0;
    function validateEmail(v) { emailChecks.push(v); ${scenario === "email-alert" ? "if (v) alert('Please enter a valid email address');" : ""} }
    function checkDateValidation(v) { dobChecks.push(v); }
    // the portal's jQuery request counter (its lists come by jQuery); "zone-slow": the invoice zone takes 6 s behind a
    // page-wide "please wait" layer whose name the run does NOT know - and a More Covers click while busy is lost
    window.jQuery = window.jQuery || { active: 0 };
    function populateInvoiceZone() {
      invoiceZoneCalls++;
      ${scenario === "zone-slow" ? `
      var d = document.getElementById('dialog'); d.style.display = 'block'; window.jQuery.active++;
      setTimeout(function () { d.style.display = 'none'; }, 4000);
      setTimeout(function () { window.jQuery.active--; }, 6000);
      return;` : ""}
      ${scenario === "overlay-unknown" ? `
      var w = document.createElement('div'); w.id = 'pleaseWait';
      w.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.25);z-index:9999';
      document.body.appendChild(w); window.jQuery.active++;
      setTimeout(function () { w.remove(); window.jQuery.active--; }, 3000);
      return;` : ""}
      busyThen(function () {});
    }
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

// The page More Covers N Info opens (the owner's TPPD markup).
const moreCoversPosts = [];
let backPosts = 0;
let quotePosts = 0;
let computeSubmitPosts = 0;
// Proposal Modification (the owner's markup, 2026-11-13): the dates Fetch sent, the option Next sent, the pages asked
const pm = { gets: 0, fetches: [], nexts: [], pageGets: [] };
const PM_DATE = "13/11/2026";
// CKYC (the owner's markup, 2026-11-13): the window Update Ckyc opens, Offline KYC, the details, Save
const ckyc = { opens: 0, offline: 0, saves: [] };
const ckycPage = (body) => `<!doctype html><html><head><title>CKYC Mandate</title></head><body>
  <div id="dialog" class="window" style="display:none;position:fixed;z-index:99999"><img src="../resources/images/wait.gif" alt="Loading...">Loading...</div>
  <form name="CkycForm" method="post" action="/GCWebPortal/ckyc/CkycMandate.do">${body}</form>
  <script>document.forms.CkycForm.addEventListener("submit", function () { document.getElementById("dialog").style.display = "block"; });</script>
  </body></html>`;
// the owner's live window (2026-11-14): "CKYC Status-Online Search" - Customer Id, Result, the buttons; a done KYC = Result
// "Offline KYC Done" and Offline KYC DISABLED (class btn-default)
const ckycSavedPage = (sent = {}) =>
  ckycPage(`<h3>CKYC Status-Offline</h3><div style="color:#60f">Offline data saved successfully</div>
    <table><tr><td>Customer Id :</td><td><input type="text" name="customerId" value="23676427656" disabled></td></tr>
      <tr><td>Proof Of Identity *</td><td><select name="proofOfIdentity" id="proofOfIdentity"><option value="Aadhaar card" selected>Aadhaar card</option></select></td></tr>
      <tr><td>Document NO *</td><td><input type="text" name="documentNo" id="documentNo" value="${sent.documentNo || ""}"></td></tr>
      <tr><td>Original Verification Status *</td><td><select name="origVerificationStat" id="origVerificationStat"><option value="Verified" selected>Verified</option></select></td></tr>
      <tr><td>Same as above</td><td><input type="checkbox" name="sameAsAbove" id="sameAsAbove" checked></td></tr></table>
    <button type="submit" name="param" value="Close" class="btn btn-default" style="height:35px; width:140px"${scenario === "resume-close-stuck" ? "" : ' onclick="window.close();"'}>Close</button>
    <button type="submit" name="param" value="Save" class="btn btn-primary" style="height:35px; width:140px" disabled="">Save</button>`);
const ckycChoice = (done = false) =>
  ckycPage(`<h3>CKYC Status-Online Search</h3>
    <table><tr><td>Customer Id :</td><td><input type="text" name="customerId" value="23676065442" disabled></td></tr>
      <tr><td>Result :</td><td><textarea name="result" readonly>${done ? "Offline KYC Done" : ""}</textarea></td></tr></table>
    <button type="button" class="btn btn-primary">Search</button>
    <button type="submit" name="param" value="Close" class="btn btn-default" style="height:35px; width:140px"${scenario === "resume-close-stuck" ? "" : ' onclick="window.close();"'}>Close</button>
    <button type="submit" name="param" value="Offline" class="btn ${done ? "btn-default" : "btn-primary"}" style="height:35px; width:140px"${done ? ' disabled=""' : ""}>Offline KYC</button>
    <button type="submit" name="param" value="Online" class="btn btn-default" style="height:35px; width:140px" disabled="">Online EKYC-Customer</button>
    <button type="button" class="btn btn-default">Online EKYC-Office</button>`);
const ckycOffline = () =>
  ckycPage(`<select name="proofOfIdentity" id="proofOfIdentity" style="width:150px" class="my_control form-control"><option value="" selected="selected">Select...</option>
      <option value="Passport">Passport</option><option value="Voter Id">Voter Id</option><option value="Driving License">Driving License</option>
      <option value="NREGA Job card">NREGA Job card</option><option value="National Population Register">National Population Register</option>
      <option value="Aadhaar card">Aadhaar card</option></select>
    <input type="text" name="documentNo" value="" id="documentNo" style="width:150px" class="my_control form-control">
    <select name="origVerificationStat" id="origVerificationStat" style="width:150px" class="my_control form-control"><option value="" selected="selected">Select...</option>
      <option value="Not verified">Not verified</option><option value="Verified">Verified</option></select>
    <textarea name="corrAddress" id="corrAddress">correspondence address</textarea>
    <input type="checkbox" name="sameAsAbove" value="on" onclick="DisableFields(this)" id="sameAsAbove">
    <button type="submit" name="param" value="Save" class="btn btn-primary" style="height:35px; width:140px" disabled="">Save</button>
    <script>
      function DisableFields(c) { document.getElementById("corrAddress").disabled = c.checked; ready(); }
      function ready() {
        var ok = document.getElementById("proofOfIdentity").value && document.getElementById("documentNo").value && document.getElementById("origVerificationStat").value && document.getElementById("sameAsAbove").checked;
        // the portal enables Save a moment after the last detail (its own check) - the run must wait for it
        var save = document.querySelector("button[value='Save']");
        if (!ok) save.disabled = true;
        else setTimeout(function () { save.disabled = false; }, 1500);
      }
      ["proofOfIdentity", "documentNo", "origVerificationStat"].forEach(function (id) { var el = document.getElementById(id); el.addEventListener("change", ready); el.addEventListener("input", ready); });
    </script>`);
const PM_ROWS = ["202611131393359", "202611131375485", "202611131268657", "202611131264163", "202611131253402", "202611131194829"];
const PM_PAGE_TWO = ["202611120000001", "202611131375485"]; // "resume-paged": our proposal is on page 2 only
const pmRows = (page) => (scenario === "resume-paged" ? (page === 2 ? PM_PAGE_TWO : PM_ROWS.filter((n) => n !== "202611131375485")) : PM_ROWS);
/** A listed proposal's Reference Date: ours moved to today in "resume-date-moved" (modified on a resume - the owner's live run). */
const pmDateOf = (n) => (scenario === "resume-date-moved" && n === "202611131375485" ? todayIndia() : PM_DATE);
/** Fetch lists the proposals whose Reference Date is From..To (both days counted). */
const pmInRange = (rows, from, to) => rows.filter((n) => dayKey(pmDateOf(n)) >= dayKey(from) && dayKey(pmDateOf(n)) <= dayKey(to));
const proposalModificationPage = ({ from = "", to = "", list = null, page = 1, error = "" } = {}) => `<!doctype html><html><head><title>Proposal Modification</title></head><body>
  <div id="err">${error ? errorBoxHtml(error) : ""}</div>
  <div id="dialog" class="window" style="display:none;position:fixed;z-index:99999;top:40%;left:45%"><img src="../resources/images/wait.gif" alt="Loading...">Loading...</div>
  <form name="ProposalModifyForm" method="post" action="/GCWebPortal/motor/proposalModification.do">
    <input type="text" name="fromRefDateString" size="10" value="${from}" onclick="setYears(1900, 2050);showCalender(this, 'fromRefDateString', 'normal','');" id="fromRefDateString" class="my_control form-control searchBox">
    <input type="text" name="toRefDateString" size="10" value="${to}" onclick="setYears(1900, 2050);showCalender(this, 'toRefDateString', 'normal','');" id="toRefDateString" class="my_control form-control searchBox">
    <input type="submit" name="fetch" value="Fetch" class="btn btn-primary" style="height:35px;">
    ${
      list
        ? `<div class="container" style="height:120px;overflow:auto; padding:0px 10px;max-width: 1000px;"><table border="2" width="100%" id="data"><tbody><tr>
             <th width="10%" class="center">Select</th><th width="20%" class="center">Proposal Number</th><th width="25%" class="center">Reference Date</th>
             <th width="30%" class="center">Insured Name </th><th width="25%" class="center">Total Premium (₹)</th></tr>
             ${list.map((n, i) => `<tr><td align="center"><input type="radio" name="proposalOption" value="${i}"${i === 0 ? ' checked="checked"' : ""}></td><td align="center">${n}</td><td align="center">${pmDateOf(n)}</td><td align="center">ANMOL</td><td align="center">4545</td></tr>`).join("")}
           </tbody></table></div>
           <div>${scenario === "resume-paged" ? (page === 1 ? `1 | <a href="/GCWebPortal/motor/proposalModification.do?page=2&amp;from=${encodeURIComponent(from)}&amp;to=${encodeURIComponent(to)}">2</a> |` : `<a href="/GCWebPortal/motor/proposalModification.do?page=1&amp;from=${encodeURIComponent(from)}&amp;to=${encodeURIComponent(to)}">1</a> | 2 |`) : "1 |"}</div>`
        : ""
    }
    <input type="button" value="Back to Home" class="btn"> <input type="submit" name="next" value="Next" id="updt" class="btn btn-primary" style="height:35px;">
  </form>
  <script>
    var calendarClicks = 0; function setYears() {} function showCalender() { calendarClicks++; }
    document.forms.ProposalModifyForm.addEventListener("submit", function () { document.getElementById("dialog").style.display = "block"; });
  </script>
  </body></html>`; // "compute-submits-slow": Compute Premium sends the page, United India answers in 6 s
let workedOutNow = false; // the Risk Details page being served is the worked-out one (the premium, the buttons)
let hangPagesLeft = 1; // "compute-hang-once": the first Risk Details page hangs, the refreshed one does not
let updateHangPagesLeft = 1; // "update-hang-once": the first page's Update hangs, the refreshed page's does not
// the owner's proposal block, as the portal shows it after Update
const PROPOSAL_HTML = `<div class="row divSpacing">

        <div class="col-md-2 col-sm-offset-1"><strong>Proposal Number : </strong></div>
        <div class="col-md-2">202611131194829</div>
        <div class="col-md-2 col-sm-offset-1"><strong>Transaction NO : </strong></div>
        <div class="col-md-2">GC202611130155864493</div>
        <input type="hidden" name="motorTransactionIdgc" value="GC202611130155864493" id="transactionId">
    </div>
<div class="row divSpacing">

        <div class="col-md-2 col-sm-offset-1"><strong>Reference Date  :</strong></div>
        <div class="col-md-2">13/11/2026</div>
        <div class="col-md-2 col-sm-offset-1"><strong>Customer ID :</strong></div>
        <div class="col-md-2">23676065442</div>
    </div>`;
const QUOTE_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");
const GST_QUESTION_TEXT =
  "GSTIN/UIN HAS NOT BEEN INSERTED. The Insured will not be able to take input credit of GST/UIN on premium on policy and endorsements. You are advised to confirm with the insured about insertion of their GSTIN/UIN before proceeding. Do you want to proceed? If Yes, Click On Ok. If No, Click on Cancel to update GSTIN/UIN.";
const moreCoversPage = () => `<!doctype html><html><head><title>More Covers</title></head><body><h3>More Covers N Info</h3>
  <select name="tppdLimit" class="my_control form-control"><option value="100000">Upto 100000</option>
                    <option value="6000">Upto 6000</option></select>
  <input type="checkbox" name="ynPAcover" value="-1" onclick="checkdriv('1')" id="ynPAcover"${scenario === "resume-pa" ? " checked" : ""}>
  <div id="paRow" style="display:none">
    <select name="cpaCover" style="width:100px;" class="my_control form-control"><option value="1">1 Year</option>
        <option value="5">5 Year</option></select>
    <input type="text" name="nomineeName" maxlength="100" size="10" value="" id="nomineeName" style="width:80px;" class="my_control form-control newNameClass">
    <select name="rltnshpstat" id="rltnshpstat" style="width:80px;" class="my_control form-control"><option value="" selected="selected">Select</option>
      ${["Aunty", "Brother", "Daughter", "Employer", "Father", "Husband", "Mother", "Niece", "Nephew", "Sister", "Son", "Uncle", "Wife", "Grand-Son", "Grand-daughter", "Spouse", "Other"].map((r) => `<option value="${r}">${r}</option>`).join("")}</select>
  </div>
  <div id="cpaOptRow" style="display:none">
    <select name="ynOwnerDrivCpaOpt" onchange="checkfun2(this.value);" class="my_control form-control"><option value="No">No</option>
        <option value="Yes" selected="selected">Yes</option></select>
  </div>
  <form name="MC" method="post" action="/GCWebPortal/portal/MoreCovers.do"></form>
  <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/Back.JPG" width="170" height="30" onclick="fnSubmit('back')" style="cursor:hand" alt="Back">
  <script>
    function fnSubmit(a) { var f = document.MC; f.action = '/GCWebPortal/portal/MoreCovers.do?method=' + a; f.submit(); }
    var checkdrivCalls = 0, checkfun2Calls = [];
    function checkdriv(a) {
      checkdrivCalls++;
      var on = document.getElementById('ynPAcover').checked;
      document.getElementById('paRow').style.display = on ? 'block' : 'none';
      document.getElementById('cpaOptRow').style.display = on ? 'none' : 'block';
    }
    function checkfun2(v) { checkfun2Calls.push(v); }
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
      // "compute-hang-once": the refresh of the stuck page answers in 3 s - longer than the 2 s page-load limit the clicks use;
      // a refresh that met that limit would be STOPPED by ChromeDriver (proved 2026-11-13), so the run must wait for it
      if (scenario === "compute-hang-once" && hangPagesLeft === 0) return setTimeout(() => res.end(nextPage()), 3000);
      res.end(nextPage());
    });
    return;
  }
  if (url.pathname === "/GCWebPortal/portal/MoreCovers.do" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (url.searchParams.get("method") === "quote") {
        quotePosts += 1;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'attachment; filename="QUOTE_TN55.pdf"');
        return setTimeout(() => res.end(QUOTE_PDF), scenario === "compute-submits-slow" ? 6000 : 1200); // the owner's lag: 6 s
      }
      if (url.searchParams.get("method") === "back") {
        backPosts += 1;
        res.setHeader("Content-Type", "text/html");
        return setTimeout(() => res.end(nextPage()), 800);
      }
      const sent = new URLSearchParams(body);
      moreCoversPosts.push(sent);
      if (scenario === "morecovers-never") return; // the portal never answers: the request just hangs
      // United India refuses a Policy Start Date before today (the owner's live N002219) - the page comes back with its box
      const start = sent.get("dateOfIssueOfPolicyString");
      if (scenario === "resume-portal-error" || (start && dayKey(start) < dayKey(todayIndia()))) {
        return setTimeout(() => {
          res.setHeader("Content-Type", "text/html");
          pageError = N002219;
          const html = nextPage();
          pageError = "";
          res.end(html);
        }, 1200);
      }
      setTimeout(() => {
        res.setHeader("Content-Type", "text/html");
        res.end(moreCoversPage());
      }, scenario === "morecovers-slow" ? 6000 : 1500); // "morecovers-slow": the owner's lag
    });
    return;
  }
  // the live portal's Compute Premium answer (gc_ashokleyland1.do): the worked-out Risk Details page, 6 s late (the owner's lag)
  if (url.pathname === "/GCWebPortal/motor/gc_ashokleyland1.do" && req.method === "POST") {
    computeSubmitPosts += 1;
    req.on("data", () => {});
    req.on("end", () =>
      setTimeout(() => {
        workedOutNow = true;
        const html = nextPage();
        workedOutNow = false;
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      }, 6000)
    );
    return;
  }
  if (url.pathname === "/GCWebPortal/motor/proposalModification.do") {
    res.setHeader("Content-Type", "text/html");
    if (req.method === "GET") {
      if (url.searchParams.get("page")) {
        const page = Number(url.searchParams.get("page"));
        pm.pageGets.push(page);
        const from = url.searchParams.get("from") || "";
        return setTimeout(() => res.end(proposalModificationPage({ from, to: url.searchParams.get("to") || "", list: pmRows(page), page })), 1200);
      }
      pm.gets += 1;
      return res.end(proposalModificationPage());
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body);
      if (f.has("next")) {
        pm.nexts.push(f.get("proposalOption"));
        // "resume-error-once": the FIRST Next answers with the portal's empty error - "resume-error-twice": every Next does
        if (scenario === "resume-error-twice" || (scenario === "resume-error-once" && pm.nexts.length === 1)) {
          return setTimeout(() => res.end(proposalModificationPage({ error: "(0)null" })), 800);
        }
        return setTimeout(() => res.end(nextPage()), 1000); // the proposal's page (Risk Details)
      }
      const from = f.get("fromRefDateString") || "";
      const to = f.get("toRefDateString") || "";
      pm.fetches.push({ from, to });
      const list = /^\d{2}\/\d{2}\/\d{4}$/.test(from) && /^\d{2}\/\d{2}\/\d{4}$/.test(to) ? pmInRange(pmRows(1), from, to) : [];
      return setTimeout(() => res.end(proposalModificationPage({ from, to, list, page: 1 })), 1500);
    });
    return;
  }
  if (url.pathname === "/GCWebPortal/ckyc/CkycMandate.do") {
    res.setHeader("Content-Type", "text/html");
    if (req.method === "GET") {
      ckyc.opens += 1;
      return res.end(ckycChoice(scenario === "resume-kyc-done" || scenario === "resume-close-stuck"));
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const f = new URLSearchParams(body);
      if (f.get("param") === "Offline") {
        ckyc.offline += 1;
        return setTimeout(() => res.end(ckycOffline()), 1200);
      }
      if (f.get("param") === "Save") {
        ckyc.saves.push(Object.fromEntries(f.entries()));
        // saved: the status page again - Offline KYC Done, Offline KYC disabled - with United India's popup
        // the owner's live answer: "CKYC Status-Offline" + "Offline data saved successfully", the details kept, no Offline KYC
        // button (only "kyc-new" adds a popup, so the words-after-Save path stays checked)
        const savedPage = ckycSavedPage(ckyc.saves[ckyc.saves.length - 1]);
        return setTimeout(() => res.end(scenario === "kyc-new" ? savedPage.replace("</body>", `<script>alert("KYC details saved successfully")</script></body>`) : savedPage), 1500);
      }
      res.end(ckycChoice());
    });
    return;
  }
  if (url.pathname === "/GCWebPortal/portal/Worksheet.do") {
    res.setHeader("Content-Type", "text/html");
    return res.end(`<!doctype html><html><head><title>Worksheet</title></head><body><h2>Premium Worksheet</h2>
      <table border="1"><tr><td>Basic TP</td><td>714</td></tr><tr><td>GST</td><td>129</td></tr><tr><td>Total</td><td>843</td></tr></table></body></html>`);
  }
  if (/MoreCoversNInfo\.JPG$/.test(url.pathname)) {
    res.setHeader("Content-Type", "image/svg+xml");
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="35"><rect width="150" height="35" fill="#36c"/></svg>');
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
const { captureFailure } = require(path.join(ROOT, "multiCompany/common/screenshot"));
const { fillPurchaseAndManufacture, todayInIndia } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaDates"));
const { answerPucAndDelhiNcr } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaQuestions"));
const { fillInsuredDetails } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaInsured"));
const { fillPinCode } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaPinCode"));
const { fillContactDetails } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaContact"));
const { chooseRto } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaRto"));
const { openMoreCovers, setTppdLimit } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaMoreCovers"));
const { fillPaCover } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaPaCover"));
const { backAndComputePremium, computePremium } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaCompute"));
const { quoteAndWorksheet } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaQuote"));
const { updateAndSaveProposal } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaProposal"));
// the insured on the replica's policy: a messy Aadhaar-style address and a name with a dot
const INSURED = {
  proposerTitle: "Mrs.", gender: "female", firstName: "k. lakshmi devi", lastName: "MASTER",
  flatDoorNo: "#272/A", floorNo: "1ST FLOOR", buildingName: "EGANIVAYAL", blockName: "PUDUKOTTAI",
  roadStreetLane: "PILLAYAR KOVIL ST., 2ND CROSS", areaAndLocality: "EGANIVAYAL, PUDUKOTTAI DIST - 604203",
  pinCode: "604203",
  mobile: "+91 98765 43210", email: "Lakshmi.Devi@Example.com", dob: "15-08-1990", rtoCityLocation: "TN-55",
};
/** Where a box sits on the screen: its middle as a share of the screen's height (0.5 = the middle), and its top. */
const placeOf = (driver, css) =>
  driver.executeScript("var r = document.querySelector(arguments[0]).getBoundingClientRect(); var h = window.innerHeight; return { mid: Math.round(((r.top + r.bottom) / 2 / h) * 100) / 100, top: Math.round(r.top), h: h };", css);
const inMiddle = (p) => p && p.mid > 0.3 && p.mid < 0.7;
const INSURED_LINE = "272 A 1ST FLOOR EGANIVAYAL PUDUKOTTAI PILLAYAR KOVIL ST 2ND CROSS DIST 604203";
const jobDirs = require(path.join(ROOT, "lib/jobDirs"));
const ui = require(path.join(ROOT, "multiCompany/common/login/unitedIndiaLogin"));

const newDriver = () => {
  const o = new chrome.Options();
  o.addArguments("--headless=new", "--window-size=1366,768", "--no-sandbox", "--disable-dev-shm-usage");
  o.setUserPreferences({ "download.default_directory": REPLICA_DOWNLOADS, "download.prompt_for_download": false, "plugins.always_open_pdf_externally": true });
  return new Builder().forBrowser("chrome").setChromeOptions(o).build();
};

async function loginScenario(name, port, run) {
  if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) return; // ONLY=a,b runs just those scenarios
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
      // the dates (today, India time) and the two answers
      const today = todayInIndia();
      await fillPurchaseAndManufacture(driver, { log: ctx.log });
      // the Year the portal already showed was only CHECKED - and still shown in the middle of the screen
      const yearAt = await placeOf(driver, "#yearOfManufacturing");
      check(inMiddle(yearAt), `screen (${name}): the Year of Manufacture, only checked, is in the middle of the screen (${JSON.stringify(yearAt)})`);
      await answerPucAndDelhiNcr(driver, { log: ctx.log });
      const after = await driver.executeScript(`var q = document.querySelectorAll('select#repository'); return {
        date: document.getElementById('dtPurchaseStr').value, checks: dateChecks, opens: calendarOpens,
        month: document.getElementsByName('makeMonthgc')[0].value, year: document.getElementById('yearOfManufacturing').value,
        puc: document.getElementsByName('ynPuc')[0].value, ncr: document.getElementsByName('ynDncr')[0].value, sameId: q.length };`);
      check(after.date === today.date && /^\d{2}\/\d{2}\/\d{4}$/.test(after.date), `dates (${name}): Date of Purchase = today in India (${after.date})`);
      check(after.checks.length === 1 && after.checks[0] === today.date, `dates (${name}): the page's registrationDateValidation ran once and saw the date (${JSON.stringify(after.checks)})`);
      check(after.opens === 0, `dates (${name}): the readonly box was not clicked - the calendar never opened (${after.opens})`);
      check(after.month === today.month && after.year === today.year, `dates (${name}): Month ${after.month} and Year ${after.year} of Manufacture = this month and year`);
      check(after.sameId === 2 && after.puc === "Yes" && after.ncr === "No", `questions (${name}): both id=repository boxes answered by name - PUC ${after.puc}, Delhi - NCR ${after.ncr}`);
      check(lines.some((l) => /Year of Manufacture already holds/.test(l)) === (today.year === "2026"), `dates (${name}): the year the portal already showed was left as it was`);
      // the insured
      await fillInsuredDetails(driver, INSURED, { log: ctx.log });
      const who = await driver.executeScript(`return { client: document.getElementById('clientType').value, clientChanges: clientTypeChanges,
        risk: document.getElementById('ynHighRisk').value, title: document.getElementById('insuredname1').value, titleSets: titleSets,
        name: document.getElementById('insuredname2').value, address: document.getElementById('addressOfInsured').value };`);
      check(who.client === "1" && who.clientChanges === 0, `insured (${name}): Client Type left on Individual, not touched (${who.clientChanges} changes)`);
      check(who.risk === "No" && who.title === "MRS." && who.titleSets === 1, `insured (${name}): High Risk ${who.risk}, Title ${who.title} (its setthevalue ran once)`);
      check(who.name === "K LAKSHMI DEVI", `insured (${name}): Insured Name = the Full Name, no dot, no Surname ("${who.name}")`);
      check(who.address === INSURED_LINE && /^[A-Z0-9 ]+$/.test(who.address), `insured (${name}): Address in one line, no special characters, names not twice ("${who.address}")`);
      const addressAt = await placeOf(driver, "#addressOfInsured");
      check(inMiddle(addressAt), `screen (${name}): the Address, 1100 px further down, is in the middle of the screen (${JSON.stringify(addressAt)})`);
      // the pin code: typed, the box left, the portal fills State and District (1.5 s after its loader)
      const pin = await fillPinCode(driver, { ...INSURED, customerState }, { log: ctx.log });
      const where = await driver.executeScript("return { calls: stateDistCalls, st: document.getElementById('STATE_CODE1').value, dist: document.getElementById('STATE_CODE2').value, pin: document.getElementById('PIN_CODE').value };");
      check(where.pin === "604203" && where.calls === 1, `pin (${name}): typed and left once - the portal's getStateDist ran (${where.calls})`);
      check(pin.district === "VILLUPURAM" && where.dist === "601" && pin.state === "TAMIL NADU", `pin (${name}): State ${pin.state} and District ${pin.district} filled by the portal, waited for`);
      const districtAt = await placeOf(driver, "#STATE_CODE2");
      check(inMiddle(districtAt), `screen (${name}): the District, only waited for, is in the middle of the screen (${JSON.stringify(districtAt)})`);
      // Mobile, Email, Date of Birth, then the RTO by its code (the list follows the customer's state)
      await fillContactDetails(driver, INSURED, { log: ctx.log });
      const rtoGiven = customerState === "pondicherry" ? "PY-01" : "TN-55";
      const picked = await chooseRto(driver, { rtoCityLocation: rtoGiven }, { log: ctx.log });
      const c = await driver.executeScript(`return { mobile: document.getElementById('mobile').value, email: document.getElementById('emailAddress').value,
        dob: document.getElementById('dateOfBirthString').value, emailChecks: emailChecks, dobChecks: dobChecks, opens: calendarOpens,
        rto: document.getElementById('rtaDesc').value, zones: invoiceZoneCalls };`);
      check(c.mobile === "9876543210" && c.email === "lakshmi.devi@example.com", `contact (${name}): Mobile ${c.mobile} (+91 and spaces dropped), Email ${c.email}`);
      check(c.emailChecks.length === 1 && c.emailChecks[0] === "lakshmi.devi@example.com", `contact (${name}): the Email box was left - validateEmail ran once on the email (${JSON.stringify(c.emailChecks)})`);
      check(c.dob === "15/08/1990" && c.dobChecks.includes("15/08/1990") && c.opens === 0, `contact (${name}): Date of Birth ${c.dob}, checkDateValidation ran on it, the calendar never opened (${JSON.stringify(c.dobChecks)}, opens ${c.opens})`);
      const rtoWanted = customerState === "pondicherry" ? "PY01 PONDICHERRY@2897" : "TN55 SALEM@55";
      check(c.rto === rtoWanted && picked.value === rtoWanted && c.zones === 1, `rto (${name}): "${rtoGiven}" -> ${c.rto}, populateInvoiceZone ran once (${c.zones})`);
      const rtoAt = await placeOf(driver, "#rtaDesc");
      check(inMiddle(rtoAt), `screen (${name}): the RTO is in the middle of the screen (${JSON.stringify(rtoAt)})`);
      // More Covers N Info: the form is submitted ONCE, the next page waited for; then the TPPD Limit
      moreCoversPosts.length = 0;
      const opened = await openMoreCovers(driver, { log: ctx.log });
      const title = await driver.executeScript("return document.title;");
      check(title === "More Covers" && opened.clicks === 1 && moreCoversPosts.length === 1, `more covers (${name}): the next page opened after the submit (clicked ${opened.clicks}, posted ${moreCoversPosts.length})`);
      check(moreCoversPosts[0] && moreCoversPosts[0].get("rtaDesc") === rtoWanted && moreCoversPosts[0].get("mobile") === "9876543210", `more covers (${name}): the Risk Details went with it (RTO ${moreCoversPosts[0] && moreCoversPosts[0].get("rtaDesc")})`);
      const restrict = name === "risk";
      const t = await setTppdLimit(driver, { tppdRestrict: restrict }, { log: ctx.log });
      const shown = await driver.executeScript("return document.getElementsByName('tppdLimit')[0].value;");
      check(shown === (restrict ? "6000" : "100000") && t.changed === restrict, `tppd (${name}): TPPD Restrict ${restrict ? "ticked -> Upto 6000" : "not ticked -> Upto 100000, not touched"} (${shown})`);
      // PA Cover: bought with United India in the first scenario; none in the others (ticked, unticked, Owner-Driver CPA No)
      const buys = name === "risk";
      const paData = buys
        ? { paCover: true, settings: { PACompany: "United India" }, paCoverYears: 5, nomineeName: "deva k.", nomineeRelation: "GRAND-SON" }
        : { paCover: false, settings: { PACompany: name === "new-window" ? "Brisk" : "" } };
      await fillPaCover(driver, paData, { log: ctx.log });
      const p = await driver.executeScript(`return { on: document.getElementById('ynPAcover').checked, calls: checkdrivCalls,
        cpa: document.getElementsByName('cpaCover')[0].value, nominee: document.getElementById('nomineeName').value,
        rel: document.getElementById('rltnshpstat').value, owner: document.getElementsByName('ynOwnerDrivCpaOpt')[0].value, fun2: checkfun2Calls };`);
      if (buys) {
        check(p.on && p.calls === 1 && p.cpa === "5" && p.nominee === "DEVA K" && p.rel === "Grand-Son", `pa (${name}): PA with United India - ticked once, CPA Cover 5, nominee ${p.nominee}, relation ${p.rel}`);
        check(p.owner === "Yes" && p.fun2.length === 0, `pa (${name}): the Owner-Driver CPA question was not touched`);
      } else {
        check(!p.on && p.calls === 2 && p.owner === "No" && p.fun2.join() === "No", `pa (${name}): no PA here - ticked and unticked (checkdriv ${p.calls}), Owner-Driver CPA ${p.owner} (checkfun2 ${JSON.stringify(p.fun2)})`);
        check(p.nominee === "", `pa (${name}): no nominee typed at United India`);
      }
      // Back to Risk Details, the end of the page, Compute Premium: the GSTIN question answered OK, the loader waited for
      backPosts = 0;
      const done = await backAndComputePremium(driver, { log: ctx.log });
      const r = await driver.executeScript(`return { title: document.title, gst: gstAnswers, calls: computeCalls,
        premium: document.getElementById('premiumResult').textContent, busy: document.getElementById('dialog').style.display,
        atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 400 };`);
      check(backPosts === 1 && r.title === "Risk Details" && done.back.clicks === 1, `compute (${name}): Back posted once, Risk Details open again`);
      check(r.gst.length === 1 && r.gst[0] === true && r.calls === 1, `compute (${name}): the real GSTIN confirm() answered OK, once (${JSON.stringify(r.gst)})`);
      check(r.premium === "Net Premium 1,234" && r.busy === "none" && done.premium.loaderMs >= 2500, `compute (${name}): the loader waited for (${done.premium.loaderMs} ms), the premium shown`);
      check(
        lines.some((l) => /⏳ United India - the portal's loader is showing \(div#dialog\.window\) [\d.]+ s after "Compute Premium"/.test(l)) && lines.some((l) => /the loader stopped [\d.]+ s after "Compute Premium"/.test(l)),
        `compute (${name}): the real loader's start and stop are said in the log`
      );
      // Generate Quote (a real download) and Worksheet (a real new window, printed to PDF), kept (S3 and the policy faked)
      quotePosts = 0;
      fileUploads.length = 0;
      const savedFiles = [];
      const windowsBefore = (await driver.getAllWindowHandles()).length; // "new-window": the Products page's window is still open
      const kept = await quoteAndWorksheet(driver, { _id: "replica-policy" }, {
        log: ctx.log,
        downloadDir: REPLICA_DOWNLOADS,
        jobId: `replica_${name}`,
        deps: { savePolicyFile: async (id, field, doc) => savedFiles.push({ id, field, doc }) },
      });
      const isPdfBytes = (b) => !!b && b.slice(0, 4).toString("latin1") === "%PDF";
      const windows = (await driver.getAllWindowHandles()).length;
      const pageTitle = await driver.executeScript("return document.title;");
      check(quotePosts === 1 && fileUploads[0] && isPdfBytes(fileUploads[0].bytes) && fileUploads[0].bytes.equals(QUOTE_PDF), `quote (${name}): Generate Quote posted once, its downloaded PDF kept exactly (${fileUploads[0] && fileUploads[0].key})`);
      check(fileUploads[1] && isPdfBytes(fileUploads[1].bytes) && fileUploads[1].bytes.length > 500 && /worksheet_replica_/.test(fileUploads[1].key), `quote (${name}): the Worksheet window printed to a real PDF (${fileUploads[1] && fileUploads[1].bytes.length} bytes)`);
      check(savedFiles.map((x) => x.field).join() === "quotePdf,worksheetPdf" && savedFiles.every((x) => x.id === "replica-policy") && kept.quotePdf && kept.worksheetPdf, "quote: both saved on the policy");
      check(windows === windowsBefore && pageTitle === "Risk Details", `quote (${name}): the worksheet window closed, back on the page (${windows} of ${windowsBefore} windows, "${pageTitle}")`);
      // Update: the GSTIN question OK, the Loading box, the proposal read off the owner's markup and saved (database faked)
      const steps = [];
      const savedProposal = [];
      const made = await updateAndSaveProposal(driver, { _id: "replica-policy", _partKey: "tp" }, {
        log: ctx.log,
        jobId: `replica_${name}`,
        deps: {
          markStage: async (data, stage, status, extra, opts) => (steps.push({ stage, status, extra, insurer: opts.insurer }), true),
          saveProposal: async (data, p) => (savedProposal.push(p), true),
        },
      });
      const upd = await driver.executeScript("return { gst: gstAnswers, calls: updateCalls, loader: document.getElementById('dialog').style.display };");
      check(upd.calls === 1 && upd.gst[upd.gst.length - 1] === true && upd.loader === "none", `proposal (${name}): Update clicked once, the GSTIN question OK, the Loading box waited for`);
      check(
        lines.some((l) => /⏳ United India - the portal's loader is showing \(div#dialog\.window\) [\d.]+ s after "Update"/.test(l)) && lines.some((l) => /the loader stopped [\d.]+ s after "Update"/.test(l)),
        `proposal (${name}): the real loader's start and stop are said in the log`
      );
      check(
        made.proposalNumber === "202611131194829" && made.transactionNo === "GC202611130155864493" && made.referenceDate === "13/11/2026" && made.customerId === "23676065442",
        `proposal (${name}): read off the owner's markup - ${made.proposalNumber}, ${made.referenceDate}, ${made.transactionNo}, ${made.customerId}`
      );
      check(steps.length === 1 && steps[0].stage === "proposal" && steps[0].status === "completed" && steps[0].insurer === "United India" && savedProposal.length === 1, "proposal: the Proposal step completed and the proposal saved on the policy");
    });
  }

  // the owner's live case: the RTO's invoice zone keeps the portal busy (United India's own "Loading..." box + a request) -
  // More Covers waits, then ONE click that is taken (before, the click was lost and he clicked it by hand)
  await loginScenario("zone-slow", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    await fillVehicleClassAndState(driver, { customerState: "tamilnadu" }, { log: ctx.log });
    const t0 = Date.now();
    await chooseRto(driver, { rtoCityLocation: "TN-55" }, { log: ctx.log }); // its populateInvoiceZone: the Loading box 4 s, a request 6 s
    const rtoTook = (Date.now() - t0) / 1000;
    moreCoversPosts.length = 0;
    const opened = await openMoreCovers(driver, { log: ctx.log });
    const took = Math.round((Date.now() - t0) / 100) / 10;
    const page = await driver.executeScript("return { title: document.title };");
    check(rtoTook >= 3.5, `ready: the RTO step waited for United India's 'Loading...' box (${rtoTook.toFixed(1)} s - the loader list now knows it)`);
    check(took >= 5.5 && lines.some((l) => /waiting for the portal before "More Covers N Info": 1 request still running/.test(l)), `ready: More Covers waited for the request still running too (${took} s from the RTO)`);
    check(page.title === "More Covers" && opened.clicks === 1 && moreCoversPosts.length === 1, `ready: More Covers clicked ONCE when the portal was ready, posted once (clicks ${opened.clicks})`);
  });

  // a page-wide layer the run does not know by name lies over the button: seen by what is drawn there, waited for
  await loginScenario("overlay-unknown", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    await fillVehicleClassAndState(driver, { customerState: "tamilnadu" }, { log: ctx.log });
    await chooseRto(driver, { rtoCityLocation: "TN-55" }, { log: ctx.log });
    moreCoversPosts.length = 0;
    const opened = await openMoreCovers(driver, { log: ctx.log });
    check(opened.clicks === 1 && moreCoversPosts.length === 1, `overlay: More Covers clicked once after the unknown layer went (posted ${moreCoversPosts.length})`);
    check(lines.some((l) => /its loader \(div#pleaseWait\) covers the page/.test(l)), "overlay: the unknown page-wide layer was seen over the button and named");
  });

  // Compute Premium answered with another popup: Cancel, [E308] in its words, no GSTIN question asked
  await loginScenario("compute-zone", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let error = null;
    try {
      await computePremium(driver, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E308" && /after "Compute Premium" the portal said "Please select the Zone"/.test(error.message), `compute: another popup is reported in its words (${error && error.message})`);
    const gst = await driver.executeScript("return gstAnswers;");
    check(gst.length === 0, "compute: nothing went ahead after it");
  });

  // Compute Premium whose loader never stops (on any page): refreshed, pressed again, [E302] 'a loader issue' (6 s limits here)
  await loginScenario("compute-hang", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let error = null;
    const t0 = Date.now();
    try {
      await computePremium(driver, { log: ctx.log, computeFirstMs: 6000, afterRefreshMs: 6000, computeSecondMs: 6000 });
    } catch (e) {
      error = e;
    }
    const took = Math.round((Date.now() - t0) / 1000);
    check(error && error.code === "E302" && /the portal's loader was still spinning 6 seconds after "Compute Premium" was pressed again \(after a refresh\) - a loader issue at United India/.test(error.message) && took <= 25, `compute: a loader that never stops - refreshed, pressed again, still spinning, then [E302] after ${took} s ("${error && error.message}")`);
    const gst = await driver.executeScript("return { gst: gstAnswers, calls: computeCalls };");
    check(gst.calls === 1 && gst.gst.join() === "true", `compute: on the refreshed page Compute Premium was pressed ONCE more, the GSTIN question OK (${JSON.stringify(gst)})`);
    check(lines.filter((l) => /⏳ United India - the portal's loader is showing \(div#dialog\.window\)/.test(l)).length === 2, "compute: the loader's start said for both presses");
    check(lines.some((l) => /^ {3}5 s after "Compute Premium": loader showing \(div#dialog\.window\), page loaded$/.test(l)), "compute: the 5-second line says the loader is still showing");
  });

  // Update too (the owner): the first Update's loader never stops -> the page refreshed, Update pressed again, the proposal saved
  await loginScenario("update-hang-once", port, async (driver, { loginUrl, lines, ctx }) => {
    updateHangPagesLeft = 1;
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    const steps = [];
    const made = await updateAndSaveProposal(driver, { _id: "replica-policy", _partKey: "tp" }, {
      log: ctx.log,
      loaderMaxMs: 6000,
      afterRefreshMs: 6000,
      deps: { markStage: async (d, stage, status) => (steps.push(`${stage} ${status}`), true), saveProposal: async () => true },
    });
    const page = await driver.executeScript("return { calls: updateCalls, gst: gstAnswers };");
    check(made.proposalNumber === "202611131194829" && page.calls === 1 && page.gst.join() === "true" && steps.join() === "proposal completed", `update: a stuck first Update - refreshed, pressed once on the new page, proposal ${made.proposalNumber} saved`);
    check(lines.some((l) => /⟳ United India - 6 seconds after "Update" the portal's loader is still spinning - refreshing the page/.test(l)), "update: the refresh is said in the log");
    check(lines.some((l) => /after the refresh the loader has stopped - pressing "Update" again/.test(l)), "update: the second press is said in the log");
  });

  // the owner's live page: after Compute Premium only Update shows; Generate Quote and Worksheet come after Update - taken there
  await loginScenario("compute-no-quote", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    await computePremium(driver, { log: ctx.log });
    const files = { log: ctx.log, downloadDir: REPLICA_DOWNLOADS, jobId: "replica_noquote", ifShown: true, deps: { savePolicyFile: async () => {} } };
    fileUploads.length = 0;
    const before = await quoteAndWorksheet(driver, { _id: "replica-policy" }, { ...files, where: "after Compute Premium" });
    const made = await updateAndSaveProposal(driver, { _id: "replica-policy", _partKey: "tp" }, {
      log: ctx.log,
      deps: { markStage: async () => true, saveProposal: async () => true },
    });
    const after = before || (await quoteAndWorksheet(driver, { _id: "replica-policy" }, { ...files, where: "after Update" }));
    check(before === null && lines.some((l) => /no Generate Quote button after Compute Premium/.test(l)), "no quote yet: after Compute Premium the step steps aside (no Generate Quote there)");
    check(made.proposalNumber === "202611131194829" && after && after.quotePdf && after.worksheetPdf && fileUploads.length === 2, `no quote yet: Update made the proposal, then the Quote PDF and Worksheet were taken after it (${fileUploads.length} files)`);
  });

  // the owner's live case: the first Compute Premium's loader never stops -> the page refreshed, the worked-out page, then on
  await loginScenario("compute-hang-once", port, async (driver, { loginUrl, lines, ctx }) => {
    hangPagesLeft = 1;
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    const out = await computePremium(driver, { log: ctx.log, computeFirstMs: 6000, afterRefreshMs: 10000 });
    const page = await driver.executeScript("return { title: document.title, premium: document.getElementById('premiumResult').textContent, update: getComputedStyle(document.getElementById('updt')).display, calls: computeCalls, gst: gstAnswers };");
    check(out.refreshed === true && page.title === "Risk Details" && page.premium === "Net Premium 1,234" && page.update !== "none" && page.calls === 1 && page.gst.join() === "true", `compute: a stuck first try - refreshed, then Compute Premium pressed ONCE more on the new page, done (${JSON.stringify(page)})`);
    check(lines.some((l) => /⟳ United India - 6 seconds after "Compute Premium" the portal's loader is still spinning - refreshing the page/.test(l)), "compute: the refresh is said in the log");
    const reload = lines.map((l) => /the page reloaded in ([\d.]+) s - watching the portal's loader/.exec(l)).find(Boolean);
    check(reload && Number(reload[1]) >= 2.9, `compute: the slow reload (3 s, past the clicks' 2 s limit) was waited for, not cut off (${reload && reload[1]} s)`);
    check(lines.some((l) => /after the refresh the loader has stopped - pressing "Compute Premium" again/.test(l)), "compute: the second press is said in the log");
  });

  // the owner's lag (2026-11-13): Compute Premium SENDS the page (gc_ashokleyland1.do) and United India answers in 6 s, then the
  // Quote PDF in 6 s. Under the old 2 s page-load limit ChromeDriver threw both answers away - the old page's loader spun for good.
  await loginScenario("compute-submits-slow", port, async (driver, { loginUrl, lines, ctx }) => {
    computeSubmitPosts = 0;
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    const t0 = Date.now();
    let out = null;
    let error = null;
    try {
      out = await computePremium(driver, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    const page = await driver
      .executeScript("return { url: location.pathname, premium: document.getElementById('premiumResult').textContent, update: getComputedStyle(document.getElementById('updt')).display, loader: document.getElementById('dialog').style.display };")
      .catch(() => null);
    check(
      out && out.refreshed === false && computeSubmitPosts === 1 && page && /gc_ashokleyland1\.do$/.test(page.url) && page.premium === "Net Premium 1,234" && page.update !== "none",
      `slow compute: United India's 6 s answer was WAITED for, not thrown away - one post, the premium page, no refresh (${took} s, posts ${computeSubmitPosts}, ${JSON.stringify(page)}${error ? `, ${error.message}` : ""})`
    );
    check(lines.some((l) => /^ {3}\d+ s after "Compute Premium": the page is on its way - United India is still answering$/.test(l)), "slow compute: a line says the page is on its way");
    check(lines.some((l) => /the page changed [\d.]+ s after "Compute Premium"/.test(l)), "slow compute: the page change is said");
    if (!out) return;
    quotePosts = 0;
    fileUploads.length = 0;
    const kept = await quoteAndWorksheet(driver, { _id: "replica-policy" }, { log: ctx.log, downloadDir: REPLICA_DOWNLOADS, jobId: "replica_slow", ifShown: true, deps: { savePolicyFile: async () => {} } }).catch((e) => ({ error: e.message }));
    check(quotePosts === 1 && kept && kept.quotePdf && fileUploads[0] && fileUploads[0].bytes.equals(QUOTE_PDF), `slow quote: the Quote PDF that took 6 s was waited for and kept (posts ${quotePosts}${kept && kept.error ? `, ${kept.error}` : ""})`);
  });

  // More Covers N Info answered 6 s late: waited for, clicked once, posted once
  await loginScenario("morecovers-slow", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    moreCoversPosts.length = 0;
    let opened = null;
    let error = null;
    try {
      opened = await openMoreCovers(driver, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    const title = await driver.executeScript("return document.title").catch(() => "");
    check(opened && opened.clicks === 1 && moreCoversPosts.length === 1 && title === "More Covers", `slow more covers: the 6 s answer was waited for - clicked once, posted once ("${title}", posts ${moreCoversPosts.length}${error ? `, ${error.message}` : ""})`);
    check(lines.some((l) => /^ {3}\d+ s after "More Covers N Info": the next page is on its way - United India is still answering$/.test(l)), "slow more covers: a line says the page is on its way");
  });

  // More Covers N Info: a first click the page swallowed -> clicked once more (nothing had started), ONE submit
  await loginScenario("morecovers-swallow", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    moreCoversPosts.length = 0;
    const opened = await openMoreCovers(driver, { log: ctx.log });
    check(opened.clicks === 2 && moreCoversPosts.length === 1, `more covers: a swallowed click was clicked once more, the form posted once (clicks ${opened.clicks}, posts ${moreCoversPosts.length})`);
    check(lines.some((l) => /has not started to change after 5 seconds - clicking it once more/.test(l)), "more covers: the second click is said in the log");
  });

  // More Covers N Info: the portal never answers the submit -> [E301] after 20 s, and the button is NOT clicked again
  await loginScenario("morecovers-never", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    moreCoversPosts.length = 0;
    const t0 = Date.now();
    let error = null;
    try {
      await openMoreCovers(driver, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    const took = Math.round((Date.now() - t0) / 1000);
    check(error && error.code === "E301" && /did not open within 20 seconds/.test(error.message) && took >= 19 && took <= 30, `more covers: no next page = [E301] after ${took} s ("${error && error.message}")`);
    check(moreCoversPosts.length === 1, `more covers: the submit on its way was never sent twice (posts ${moreCoversPosts.length})`);
    // the error's screenshot is taken at once (the hung submit was stopped), and the run's own page-load limit is back
    uploads.length = 0;
    const s0 = Date.now();
    const shot = await captureFailure(driver, { company: "united india", jobId: "replica-more-covers" });
    const shotMs = Date.now() - s0;
    const after = await driver.executeScript("return document.title;");
    const limits = await driver.manage().getTimeouts();
    check(!!shot.screenshotUrl && shotMs < 5000 && isPng(uploads[0] && uploads[0].base64), `more covers: the error's screenshot taken in ${shotMs} ms`);
    check(after === "Risk Details" && limits.pageLoad === 300000, `more covers: still on Risk Details (${after}), page-load limit back to ${limits.pageLoad} ms`);
  });

  // an RTO the list does not have: stops, not retried, naming the nearest ones; nothing chosen
  await loginScenario("rto-missing", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    await fillVehicleClassAndState(driver, { customerState: "tamilnadu" }, { log: ctx.log }); // getRegNoRta fills the RTO list
    let error = null;
    try {
      await chooseRto(driver, { rtoCityLocation: "TN-58" }, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E306" && error.retryable === false && /the RTO TN58 .* is not in United India's RTO list.*The nearest TN RTOs United India offers are "TN57 DINDIGUL", "TN59 MADURAI", "TN-56 PERUNDURAI", "TN55 SALEM"/.test(error.message), `rto: an RTO not in the list stops with the nearest ones ("${error && error.message}")`);
    const now = await driver.executeScript("return { rto: document.getElementById('rtaDesc').value, zones: invoiceZoneCalls };");
    check(now.rto === "" && now.zones === 0, `rto: nothing was chosen (${JSON.stringify(now)})`);
  });

  // validateEmail answers with a real alert() when the Email box is left: reported in its words
  await loginScenario("email-alert", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let error = null;
    try {
      await fillContactDetails(driver, INSURED, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E308" && /after "Email" the portal said "Please enter a valid email address"/.test(error.message), `contact: validateEmail's popup is reported in its words (${error && error.message})`);
    const dob = await driver.executeScript("return document.getElementById('dateOfBirthString').value;");
    check(dob === "", `contact: the Date of Birth was not touched after the refused Email ("${dob}")`);
  });

  // a pin code the portal does not know: entered and left twice, then "the pin code may be wrong" (not retried)
  await loginScenario("pin-wrong", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let error = null;
    try {
      await fillPinCode(driver, { pinCode: "999999", customerState: "tamilnadu" }, { log: ctx.log, fillWaitMs: 4000 });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E306" && error.retryable === false && /the Pin Code 999999 did not fill the District .*the pin code may be wrong/.test(error.message), `pin: an unknown pin code stops, not retried ("${error && error.message}")`);
    const calls = await driver.executeScript("return stateDistCalls;");
    check(calls === 2, `pin: entered and left twice before the stop (${calls})`);
  });

  // High Risk's onchange answers with a real alert(): reported in its words, the Title not touched
  await loginScenario("insured-alert", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let error = null;
    try {
      await fillInsuredDetails(driver, INSURED, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E308" && error.retryable === false && /after "High Risk" the portal said "Please declare the high risk status"/.test(error.message), `insured: High Risk's popup is reported in its words (${error && error.message})`);
    const after = await driver.executeScript("return { titleSets: titleSets, name: document.getElementById('insuredname2').value };");
    check(after.titleSets === 0 && after.name === "", `insured: nothing after the refused High Risk was touched (${JSON.stringify(after)})`);
  });

  // the page's own date check answers with a real alert(): reported in its words, nothing chosen after it
  await loginScenario("purchase-alert", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    await fillRiskDetails(driver, { customerState: "tamilnadu", chassisNumber: "C1", engineNumber: "E1", vehicleMake: "HONDA", vehicleModel: "ACTIVA 6G" }, { log: ctx.log });
    let error = null;
    try {
      await fillPurchaseAndManufacture(driver, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(error && error.code === "E308" && error.retryable === false && /should not be greater than Date of Registration/.test(error.message), `dates: the page's alert after the date is reported in its words (${error && error.message})`);
    const month = await driver.executeScript("return document.getElementsByName('makeMonthgc')[0].value");
    check(month === "01", `dates: nothing after the refused date was touched (month ${month})`);
  });

  // a slow portal: the Vehicle Manufacturer list arrives after the loader has gone - waited for, then HONDA chosen
  await loginScenario("makers-late", port, async (driver, { loginUrl, lines, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let readyAt = 0; // when the run was ready to read the manufacturers (right after the Engine Number)
    const log = (l) => {
      if (/Engine Number E1 entered/.test(l)) readyAt = Date.now();
      ctx.log(l);
    };
    const out = await fillRiskDetails(driver, { customerState: "tamilnadu", chassisNumber: "C1", engineNumber: "E1", vehicleMake: "HONDA", vehicleModel: "ACTIVA 6G" }, { log });
    const page = await driver.executeScript("return { maker: document.getElementById('selectedNumNameCode').value, arrivedAt: window.makersArrivedAt || 0 };");
    check(readyAt > 0 && page.arrivedAt > readyAt, `manufacturer list late: it arrived ${page.arrivedAt - readyAt} ms after the run was ready to read it`);
    check(page.maker === "IBB4560@HONDA" && out.make === "ACTIVA 6G", `manufacturer list late: waited for it, HONDA (${page.maker}) and ACTIVA 6G chosen`);
  });

  // our Model is not in United India's Make list: the run stops with the names like it, nothing chosen, not retried
  await loginScenario("model-not-listed", port, async (driver, { loginUrl, ctx }) => {
    await runLogin(driver, strategy, { username: USER, password: PASS, loginUrl }, ctx);
    await openMakeNewRenewPolicy(driver, { log: ctx.log });
    await chooseProduct(driver, { log: ctx.log });
    let error = null;
    try {
      await fillRiskDetails(driver, { customerState: "tamilnadu", chassisNumber: "C1", engineNumber: "E1", vehicleMake: "HONDA", vehicleModel: "ACTIVA 7G" }, { log: ctx.log });
    } catch (e) {
      error = e;
    }
    check(
      error && error.code === "E306" && error.retryable === false &&
        /the Make list for "HONDA" has no "ACTIVA 7G"/.test(error.message) &&
        /Names like it that United India offers for "HONDA" are "ACTIVA 6G", "ACTIVA 125"\./.test(error.message) &&
        !/DIO/.test(error.message),
      `model not in the list: [E306] not retried, names like it ("${error && error.message}")`
    );
    const make = await driver.executeScript("return document.getElementById('makeMotorDisplay').value");
    check(make === "0", `model not in the list: no Make chosen (${make})`);
    // the picture of that moment, with a real portal alert() still open (Chrome refuses the first try)
    uploads.length = 0;
    await driver.executeScript("setTimeout(function () { alert('Please select the RTA'); }, 0);");
    await driver.sleep(400);
    const shot = await captureFailure(driver, { company: "united india", jobId: "replica-popup" });
    check(!!shot.screenshotUrl && uploads.length === 1 && isPng(uploads[0].base64), `a portal popup open at the picture: closed, the picture still taken (${uploads.length} PNG)`);
    check(/^multiCompany\/united_india\//.test(String(uploads[0] && uploads[0].key).replace(/^screenshots\//, "")), `the picture goes to the United India folder (${uploads[0] && uploads[0].key})`);
  });

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
    for (const [breaker, expect, withKyc] of [
      ["true", /Stopped on purpose at checkpoint "stopthis-location"/],
      ["false", /Date of Purchase, Month and Year of Manufacture, Valid PUC \(Yes\), Delhi - NCR \(No\), Client Type, High Risk \(No\), Title, Insured Name, Address, Pin Code \(State and District filled\), Mobile, Email, Date of Birth and RTO entered, More Covers N Info opened, TPPD Limit and PA Cover set, back on Risk Details and Compute Premium done, Quote PDF and Worksheet kept, Update pressed and the proposal saved, the KYC is not built yet - proposal \d+ of [\d/]+ \(no Update Ckyc button on the page after Update\)$/],
      // a NEW proposal whose page offers Update Ckyc after Update: the KYC straight after the proposal (the owner, 2026-11-13)
      ["false", /Update pressed and the proposal saved, the CKYC window opened, Offline KYC with the Aadhaar card \(Verified, Same as above\) entered and Save pressed - the KYC is done \(United India says "Offline data saved successfully"\), the KYC step could NOT be saved \(set it to Completed in Edit -> Status\), the CKYC window closed; what comes after the KYC is not built yet - proposal \d+ of [\d/]+ - United India said "KYC details saved successfully"$/, "kyc-new"],
    ]) {
      if (process.env.ONLY && !process.env.ONLY.split(",").includes(withKyc || "handler")) continue;
      scenario = withKyc || "success";
      Object.assign(ckyc, { opens: 0, offline: 0, saves: [] });
      reads = [];
      sessions.clear();
      process.env.BREAKER_ENABLED = breaker;
      process.env.BREAKER_STOP_AT = "stopthis-location";
      uploads.length = 0;
      const { fillUnitedIndiaTP } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP"));
      const result = await fillUnitedIndiaTP({
        ...INSURED,
        firstName: "Replica",
        customerState: "tamilnadu",
        chassisNumber: "MD626DG56S2H08322",
        engineNumber: "FG5HS2808545",
        vehicleMake: "HONDA",
        vehicleModel: "ACTIVA 6G",
        aadharNumber: "123456789012",
        username: USER,
        password: PASS,
        loginUrl: `http://127.0.0.1:${port}/GCWebPortal/login/LoginAction.do?p=login`,
      });
      check(result && result.inProgress === true && result.retryable === false && expect.test(result.error || ""), `handler${withKyc ? ` (${withKyc})` : ""}, Breaker ${breaker}: stopped after the login ("${result && result.error}")`);
      if (withKyc) {
        const saved = ckyc.saves[0] || {};
        check(ckyc.opens === 1 && ckyc.saves.length === 1 && saved.proofOfIdentity === "Aadhaar card" && saved.documentNo === "123456789012" && saved.origVerificationStat === "Verified" && saved.sameAsAbove === "on", `${withKyc}: after Update the CKYC window opened and Save sent the Offline KYC details`);
      } else check(ckyc.opens === 0, `handler, Breaker ${breaker}: no Update Ckyc button after Update - no KYC window`);
      check(!!(result && result.screenshotUrl) && uploads.length === 1 && isPng(uploads[0].base64), `handler, Breaker ${breaker}: the stop saved ONE screenshot of the page (${uploads.length})`);
      uploads.length = 0;
    }
    // an error (our Model not in the list) on the handler: [E306], not retried, with its screenshot
    {
      scenario = "success";
      sessions.clear();
      process.env.BREAKER_ENABLED = "true";
      uploads.length = 0;
      const { fillUnitedIndiaTP } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP"));
      const result = await fillUnitedIndiaTP({
        ...INSURED,
        firstName: "Replica",
        customerState: "tamilnadu",
        chassisNumber: "MD626DG56S2H08322",
        engineNumber: "FG5HS2808545",
        vehicleMake: "HONDA",
        vehicleModel: "ACTIVA 7G",
        username: USER,
        password: PASS,
        loginUrl: `http://127.0.0.1:${port}/GCWebPortal/login/LoginAction.do?p=login`,
      });
      check(result && result.success === false && result.errorCode === "E306" && result.retryable === false && /has no "ACTIVA 7G"/.test(result.error || ""), `handler, model not in the list: [E306] not retried ("${result && result.error}")`);
      check(!!(result && result.screenshotUrl) && uploads.length === 1 && isPng(uploads[0].base64), `handler, model not in the list: ONE screenshot saved (${uploads.length})`);
    }
    // a proposal made before (the owner, 2026-11-13): NOT made again - Proposal Modification, the Reference Date in From and To,
    // Fetch, OUR row (the portal pre-selects the FIRST), Next; then High Risk No, More Covers, TPPD, PA, Back, Compute Premium
    for (const [name, number, expectOk] of [
      ["resume", "202611131375485", true],
      ["resume-paged", "202611131375485", true],
      ["resume-not-listed", "202611139999999", false],
      ["resume-portal-error", "202611131375485", false],
      ["resume-kyc-done", "202611131375485", true],
      ["resume-close-stuck", "202611131375485", true],
      ["resume-date-moved", "202611131375485", true],
      // the owner's live run: a reopened proposal's PA Cover comes TICKED with CPA Cover / nominee hidden (checkdriv not run)
      ["resume-pa", "202611131375485", true],
      // the owner's live run: the portal's empty "(0)null" box after Next - the first time the steps once more, the second time the error
      ["resume-error-once", "202611131375485", true],
      ["resume-error-twice", "202611131375485", false],
    ]) {
      if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) continue;
      scenario = name;
      sessions.clear();
      process.env.BREAKER_ENABLED = "false";
      uploads.length = 0;
      moreCoversPosts.length = 0;
      backPosts = 0;
      Object.assign(pm, { gets: 0, fetches: [], nexts: [], pageGets: [] });
      Object.assign(ckyc, { opens: 0, offline: 0, saves: [] });
      const { fillUnitedIndiaTP, RESUME_BASE } = require(path.join(ROOT, "multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP"));
      const planned = [];
      const datesSaved = [];
      const freshSaved = [];
      // the run's own log, to check the Aadhaar number never shows in full
      const said = [];
      const realLog = console.log;
      console.log = (...a) => {
        said.push(a.join(" "));
        realLog(...a);
      };
      const result = await fillUnitedIndiaTP(
        {
          ...INSURED,
          firstName: "Replica",
          customerState: "tamilnadu",
          aadharNumber: "1234 5678 9012",
          ...(name === "resume-pa" ? { paCover: true, settings: { PACompany: "United India" }, paCoverYears: 5, nomineeName: "deva", nomineeRelation: "Son" } : {}),
          username: USER,
          password: PASS,
          loginUrl: `http://127.0.0.1:${port}/GCWebPortal/login/LoginAction.do?p=login`,
        },
        {
          loadPlan: async (data, o) => {
            planned.push(o.jobId);
            return { skipProposal: true, skipKyc: false, proposalNumber: number, referenceDate: PM_DATE, startAt: "kyc" };
          },
          saveDate: async (data, d) => (datesSaved.push(`${d.proposalNumber} ${d.referenceDate}`), true),
          saveFresh: async (data, f) => (freshSaved.push(`${f.was} -> ${f.fresh.proposalNumber} ${f.fresh.referenceDate}`), true),
        }
      ).finally(() => {
        console.log = realLog;
      });
      const fetched = pm.fetches.map((f) => `${f.from}-${f.to}`).join();
      if (expectOk) {
        // the replica job has no policy id, so the KYC step cannot be written - the stop says so (a real policy says "= completed")
        const kycSaid =
          name === "resume-kyc-done" || name === "resume-close-stuck"
            ? `the CKYC window opened - the KYC was already done at United India (Offline KYC disabled, "Offline KYC Done"), the KYC step could NOT be saved (set it to Completed in Edit -> Status), the CKYC window closed${name === "resume-close-stuck" ? " (by the run - its Close did not)" : ""}; what comes after the KYC`
            : `Save pressed - the KYC is done (United India says "Offline data saved successfully"), the KYC step could NOT be saved (set it to Completed in Edit -> Status), the CKYC window closed; what comes after the KYC`;
        check(
          result && result.inProgress === true && result.retryable === false && (result.error || "").startsWith(RESUME_BASE) && (result.error || "").includes(kycSaid) && (result.error || "").includes(`proposal 202611131375485 of ${todayIndia()}`),
          `${name}: stopped after the KYC on the resumed proposal ("${result && result.error}")`
        );
        const fetchedWant = name === "resume-error-once" ? `13/11/2026-${todayIndia()},13/11/2026-${todayIndia()}` : `13/11/2026-${todayIndia()}`;
        check(pm.gets === (name === "resume-error-once" ? 2 : 1) && fetched === fetchedWant, `${name}: Proposal Modification opened, From = the saved Reference Date, To = today, ${name === "resume-error-once" ? "a Fetch on each opening" : "ONE Fetch"} (${fetched})`);
        // the list's moved Reference Date (date only), then the proposal FRESH from the page after Modify (the owner, 2026-11-14)
        check(datesSaved.join() === (name === "resume-date-moved" ? `202611131375485 ${todayIndia()}` : ""), `${name}: a Reference Date moved in the list saved (date only) - ${datesSaved.join() || "none moved"}`);
        check(freshSaved.join() === `202611131375485 -> 202611131375485 ${todayIndia()}`, `${name}: after Modify the proposal's number and Reference Date read FRESH from the page and saved (${freshSaved.join() || "none"})`);
        if (name === "resume-pa") {
          check(
            said.some((l) => /PA Cover is ticked but CPA Cover and the nominee boxes are not shown \(a proposal opened again\) - unticking and ticking it again so they show/.test(l)) &&
              said.some((l) => /✅ United India - PA Cover ticked, CPA Cover 5 Year, Nominee DEVA, Relation Son/.test(l)),
            `${name}: PA Cover ticked already with its boxes hidden - unticked, ticked again, CPA Cover 5 Year and the nominee filled`
          );
        }
        check(pm.nexts.length >= 1 && pm.nexts.every((x) => x === "1"), `${name}: Next sent OUR row (option ${pm.nexts.join()}), never the pre-selected first one`);
        if (name === "resume-paged") check(pm.pageGets.join() === "2", `${name}: our proposal found on page 2 (pages asked ${pm.pageGets.join() || "none"})`);
        check(moreCoversPosts.length === 1 && moreCoversPosts[0].get("ynHighRisk") === "No", `${name}: High Risk "No" again, then More Covers N Info posted once (High Risk sent "${moreCoversPosts[0] && moreCoversPosts[0].get("ynHighRisk")}")`);
        check(moreCoversPosts[0] && moreCoversPosts[0].get("dateOfIssueOfPolicyString") === todayIndia(), `${name}: the Policy Start Date sent as today ${todayIndia()} (the proposal's was ${PM_DATE}; sent "${moreCoversPosts[0] && moreCoversPosts[0].get("dateOfIssueOfPolicyString")}")`);
        check(backPosts === 1, `${name}: back on Risk Details after the PA Cover (Back posted ${backPosts})`);
        check(planned.length === 1, `${name}: the saved steps read once, after the login`);
        const saved = ckyc.saves[0] || {};
        check(
          name === "resume-close-stuck"
            ? said.some((l) => /the CKYC window did not close with its "Close" button - the run closed it/.test(l)) && said.some((l) => /the CKYC window closed \(by the run\) - back on the proposal page/.test(l))
            : said.some((l) => /the CKYC window closed \(its Close button\) - back on the proposal page/.test(l)),
          `${name}: the KYC finished - the CKYC window closed${name === "resume-close-stuck" ? " by the run (its Close did nothing, pressed twice)" : " with its own Close"}, back on the proposal page`
        );
        if (name === "resume-kyc-done" || name === "resume-close-stuck") {
          check(ckyc.opens === 1 && ckyc.offline === 0 && ckyc.saves.length === 0, `${name}: Offline KYC disabled = the KYC is already done - NOT pressed, nothing entered or saved (${ckyc.opens}/${ckyc.offline}/${ckyc.saves.length})`);
          check(said.some((l) => /CKYC window: Customer Id 23676065442, Result "Offline KYC Done", Offline KYC disabled/.test(l)), `${name}: the window's status said in the log`);
          check(!!(result && result.screenshotUrl) && uploads.length === 1 && isPng(uploads[0].base64), `${name}: ONE screenshot of the page saved (${uploads.length})`);
          continue;
        }
        check(ckyc.opens === 1 && ckyc.offline === 1 && ckyc.saves.length === 1, `${name}: Modify, then Update Ckyc opened the CKYC window ONCE, Offline KYC once, Save once (${ckyc.opens}/${ckyc.offline}/${ckyc.saves.length})`);
        check(
          saved.proofOfIdentity === "Aadhaar card" && saved.documentNo === "123456789012" && saved.origVerificationStat === "Verified" && saved.sameAsAbove === "on" && saved.param === "Save",
          `${name}: Save sent Aadhaar card, the policy's Aadhaar number, Verified, Same as above (${saved.proofOfIdentity} / ${saved.documentNo ? `XXXXXXXX${String(saved.documentNo).slice(-4)}` : "-"} / ${saved.origVerificationStat} / ${saved.sameAsAbove})`
        );
        check(said.some((l) => /✅ United India - the KYC is done at United India \(it says "Offline data saved successfully", Customer Id 23676427656\)/.test(l)), `${name}: "Offline data saved successfully" after Save = the KYC done (the owner's live page)`);
        if (name === "resume-error-once") {
          check(
            said.some((l) => /⚠️ United India - after "Next" the portal said "Error In Data Entry - \(0\)null" - it sometimes shows a wrong error, so the proposal is opened from Proposal Modification and filled once more/.test(l)) &&
              said.some((l) => /opening Proposal Modification again by its address/.test(l)) && pm.nexts.length === 2 && pm.gets === 2,
            `${name}: the portal's "(0)null" box the first time - Proposal Modification opened again by its address, Next pressed again, then on (Next ${pm.nexts.length}x, page opened ${pm.gets}x)`
          );
        }
        check(!said.some((l) => /123456789012|1234 5678 9012/.test(l)) && said.some((l) => /XXXXXXXX9012/.test(l)), `${name}: the Aadhaar number shows only as XXXXXXXX9012 in the log`);
      } else if (name === "resume-error-twice") {
        check(
          result && result.success === false && result.errorCode === "E306" && result.retryable === false && (result.error || "").includes(`after "Next" the portal says "Error In Data Entry - (0)null" a second time (the run had done it all once more)`),
          `${name}: the same box the second time = [E306] not retried, saying so ("${result && result.error}")`
        );
        check(pm.nexts.length === 2 && ckyc.opens === 0, `${name}: Next pressed twice in all, nothing after it (${pm.nexts.length})`);
      } else if (name === "resume-portal-error") {
        check(
          result && result.success === false && result.errorCode === "E306" && result.retryable === false && (result.error || "").includes(`after "More Covers N Info" the portal says "Error In Data Entry - ${N002219}"`),
          `${name}: United India's Error In Data Entry box stops the run in its words, not retried ("${result && result.error}")`
        );
        check(ckyc.opens === 0, `${name}: nothing after it (no KYC window)`);
      } else {
        check(result && result.success === false && result.errorCode === "E306" && result.retryable === false && new RegExp(`proposal 202611139999999 is not in the Proposal Modification list for 13/11/2026 to ${todayIndia()} \\(6 proposals listed - 202611131393359, `).test(result.error || ""), `${name}: [E306] not retried, naming what IS listed ("${result && result.error}")`);
        check(pm.nexts.length === 0 && moreCoversPosts.length === 0 && ckyc.opens === 0, `${name}: Next NOT pressed (it would open the pre-selected first proposal), nothing else done`);
      }
      check(!!(result && result.screenshotUrl) && uploads.length === 1 && isPng(uploads[0].base64), `${name}: ONE screenshot of the page saved (${uploads.length})`);
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
  fs.rmSync(REPLICA_DOWNLOADS, { recursive: true, force: true });
  console.log(failed ? `RESULT: ${failed} FAILED` : "RESULT: ALL PASS");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
