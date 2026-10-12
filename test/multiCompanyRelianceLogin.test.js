// Run with: node --test test/*.test.js
//
// The multiCompany Reliance login is a COPY of the full-company one
// (multiCompany/common/reliance/fullCompanyLogin.js). Two kinds of test:
//   1. the copy is still the same code as the original — change the full-company login and this fails
//      until the copy is updated;
//   2. the copy behaves like the full-company login against a fake Reliance portal page (no browser,
//      no network, no OpenAI).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { By } = require("selenium-webdriver");

const ROOT = path.join(__dirname, "..");

// The GPT-4o captcha reader is shared by every Reliance flow: stub it, never call OpenAI.
let captchaReply = { text: "AB12", success: true };
// The temp captcha PNG exists only while the reader runs (written before it, deleted after): note its name here.
const seenCaptchaFiles = [];
const captchaPath = require.resolve("../Captcha");
require.cache[captchaPath] = {
  id: captchaPath,
  filename: captchaPath,
  loaded: true,
  exports: {
    extractCaptchaText: async () => {
      for (const f of fs.readdirSync(ROOT)) if (/^reliance_captcha_.*\.png$/.test(f)) seenCaptchaFiles.push(f);
      return captchaReply;
    },
  },
};

const copy = require("../multiCompany/common/reliance/fullCompanyLogin");
const { login, SUPPORTED_COMPANIES } = require("../multiCompany/common/login");
const { isMultiCompanyError } = require("../multiCompany/common/errors");

/** Run fn with the (very chatty) login logging switched off. */
async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/* ------------------------- 1. the copy is the original ------------------------- */

test("sync: performLogin and isUserLoggedIn are word-for-word the browserv2.js ones", async () => {
  const original = await quiet(() => require("../browserv2"));
  assert.equal(copy.performLogin.toString(), original.performLogin.toString(), "performLogin differs from browserv2.js");
  assert.equal(copy.isUserLoggedIn.toString(), original.isUserLoggedIn.toString(), "isUserLoggedIn differs from browserv2.js");
  assert.equal(copy.CONFIG.LOGIN_TIMEOUT, original.CONFIG.LOGIN_TIMEOUT, "CONFIG.LOGIN_TIMEOUT differs from browserv2.js");
});

test("sync: the captcha helpers are word-for-word the captchaUtils.js ones (temp file under ROOT_DIR instead of __dirname)", () => {
  const original = require("../captchaUtils");
  assert.equal(copy.getCaptchaText.toString(), original.getCaptchaText.toString(), "getCaptchaText differs from captchaUtils.js");
  assert.equal(
    copy.getCaptchaScreenShot.toString().replace("ROOT_DIR", "__dirname"),
    original.getCaptchaScreenShot.toString(),
    "getCaptchaScreenShot differs from captchaUtils.js"
  );
});

test("sync: the popup + Motors-menu wait and the login URL fallback are still what relianceForm.js does", () => {
  const trimmed = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const full = trimmed(fs.readFileSync(path.join(ROOT, "fullPolicycompany", "relianceForm.js"), "utf8"));
  const mine = trimmed(fs.readFileSync(path.join(ROOT, "multiCompany", "common", "reliance", "fullCompanyLogin.js"), "utf8"));

  const from = mine.indexOf("// === STEP 1.1: Close popup modal if present ===");
  const to = mine.indexOf('console.log("Motors menu detected!");');
  assert.ok(from >= 0 && to > from, "the copied block is missing from fullCompanyLogin.js");
  const block = mine.slice(from, to + 1);

  const at = full.indexOf(block[0]);
  assert.ok(at >= 0, "relianceForm.js no longer has the popup / Motors-menu block — update fullCompanyLogin.js");
  assert.deepEqual(full.slice(at, at + block.length), block, "the popup / Motors-menu block in relianceForm.js changed — update fullCompanyLogin.js");

  assert.ok(
    full.includes(`data.loginUrl || "${copy.DEFAULT_LOGIN_URL}";`),
    "relianceForm.js no longer falls back to the same login URL — update DEFAULT_LOGIN_URL"
  );
});

/* ------------------- 2. the copy behaves like the full-company login ------------------- */

/**
 * Just enough of Reliance's SmartZone login + dashboard for the copied code: the login form, a captcha image,
 * the post-login URL token, an optional promo popup and the Motors menu. Mirrors the Selenium calls the
 * login makes; anything else it is asked for throws, so a changed login is noticed.
 */
function fakeReliance({ username = "agent1", password = "pw1", captcha = "AB12", popup = true, submenuNeverOpens = false } = {}) {
  const state = {
    url: "about:blank",
    page: "none",
    typed: {},
    gets: [],
    clicks: [],
    popupClosed: false,
    screenshots: 0,
  };
  const idOf = (locator) => ((locator && locator.value) || "").match(/id="([^"]+)"/)?.[1];

  const element = (id) => ({
    id,
    async clear() {
      state.typed[id] = "";
    },
    async sendKeys(text) {
      state.typed[id] = (state.typed[id] || "") + text;
    },
    async isDisplayed() {
      return true;
    },
    async takeScreenshot() {
      state.screenshots += 1;
      return "aGVsbG8=";
    },
    async click() {
      state.clicks.push(id);
      if (id !== "btnLogin") return;
      const t = state.typed;
      if (t.txtUserName === username && t.txtPassword === password && t.CaptchaInputText === captcha) {
        state.page = "dashboard";
        state.url = "https://smartzone.reliancegeneral.co.in/Home/Index?un=agent1";
      }
    },
  });

  const twoWheelerLink = () => ({
    id: "TwoWheelerLink",
    async getRect() {
      return { width: 120, height: 20 };
    },
    async isDisplayed() {
      return true;
    },
    async click() {
      state.clicks.push("TwoWheelerLink");
      state.page = "twoWheeler";
    },
  });

  const present = (id) => {
    if (state.page === "login") return ["txtUserName", "txtPassword", "CaptchaInputText", "btnLogin", "CaptchaImage"].includes(id);
    if (state.page === "dashboard") {
      return ["divMainMotors", "divLogout"].includes(id) || (id === "Closebutton" && popup && !state.popupClosed);
    }
    return false;
  };

  const driver = {
    state,
    async get(url) {
      if (!url) throw new Error("invalid argument: 'url' must be a non-empty string");
      state.gets.push(url);
      state.url = url;
      state.page = "login";
      state.typed = {};
    },
    async getCurrentUrl() {
      return state.url;
    },
    async sleep() {},
    async findElements(locator) {
      const id = idOf(locator);
      if (id) return present(id) ? [element(id)] : [];
      if (/Two Wheeler/.test((locator && locator.value) || "")) {
        return state.submenuOpen ? [twoWheelerLink()] : [];
      }
      return []; // the xpath "Captcha is not valid" message never shows
    },
    // Like Selenium's WebElementPromise: the element's methods can be called straight on the result
    // (`driver.findElement(x).clear()`), and awaiting it gives the element.
    findElement(locator) {
      const id = idOf(locator);
      if (id && present(id)) return element(id);
      const error = new Error(`no such element: ${locator && locator.value}`);
      error.name = "NoSuchElementError";
      const rejected = Promise.reject(error);
      rejected.catch(() => {});
      const fail = () => Promise.reject(error);
      return Object.assign(rejected, { clear: fail, sendKeys: fail, click: fail, takeScreenshot: fail, isDisplayed: fail });
    },
    async wait(condition, timeout) {
      const fn = typeof condition === "function" ? condition : condition && condition.fn;
      if (typeof fn !== "function") throw new Error("fake driver: unsupported wait condition");
      for (let i = 0; i < 3; i++) {
        const value = await fn(driver);
        if (value) return value;
      }
      const error = new Error(`Waiting timed out after ${timeout}ms`);
      error.name = "TimeoutError";
      throw error;
    },
    // Hovering the Motors menu opens its submenu; the Two Wheeler link is then there, visible, and clickable.
    actions() {
      let target = null;
      const chain = {
        move({ origin }) {
          target = origin;
          return chain;
        },
        async perform() {
          if (target && target.id === "divMainMotors" && !submenuNeverOpens) state.submenuOpen = true;
        },
      };
      return chain;
    },
    async executeScript(script, el) {
      if (/click\(\)/.test(script) && el && el.id === "Closebutton") state.popupClosed = true;
    },
  };
  return driver;
}

const CREDS = { username: "agent1", password: "pw1" };

test("logs in like the full-company flow and returns the Motors menu; the promo popup is closed on the way", async () => {
  const driver = fakeReliance();
  const motors = await quiet(() => copy.fullCompanyLogin(driver, CREDS, { jobId: "job-A" }));
  assert.equal(motors.id, "divMainMotors");
  assert.equal(driver.state.popupClosed, true);
  assert.deepEqual(driver.state.gets, [copy.DEFAULT_LOGIN_URL], "went to the default Reliance login page, once");
  assert.ok(driver.state.clicks.includes("btnLogin"));
});

test("no popup is fine: it carries on to the Motors menu", async () => {
  const driver = fakeReliance({ popup: false });
  const motors = await quiet(() => copy.fullCompanyLogin(driver, CREDS, { jobId: "job-B" }));
  assert.equal(motors.id, "divMainMotors");
  assert.equal(driver.state.popupClosed, false);
});

test("a credential's own login URL wins over the default", async () => {
  const driver = fakeReliance();
  await quiet(() => copy.fullCompanyLogin(driver, { ...CREDS, loginUrl: "https://reliance.example/other-login" }, { jobId: "job-C" }));
  assert.deepEqual(driver.state.gets, ["https://reliance.example/other-login"]);
});

test("a wrongly read captcha is retried: the login only succeeds on the attempt the captcha is right", async () => {
  const driver = fakeReliance({ captcha: "ZZ99" });
  const reads = ["AB12", "AB12", "ZZ99"];
  captchaReply = { get text() { return reads.shift() || "ZZ99"; }, success: true };
  try {
    const motors = await quiet(() => copy.fullCompanyLogin(driver, CREDS, { jobId: "job-D" }));
    assert.equal(motors.id, "divMainMotors");
    assert.equal(driver.state.screenshots, 3, "three captcha reads");
  } finally {
    captchaReply = { text: "AB12", success: true };
  }
});

test("a rejected login is E203, not retryable, after the same five attempts as the full-company flow", async () => {
  const driver = fakeReliance({ password: "the-real-one" });
  let failure;
  await quiet(async () => {
    try {
      await copy.fullCompanyLogin(driver, { username: "agent1", password: "wrong" }, { jobId: "job-E" });
    } catch (e) {
      failure = e;
    }
  });
  assert.ok(failure, "it threw");
  assert.ok(isMultiCompanyError(failure));
  assert.equal(failure.code, "E203");
  assert.equal(failure.retryable, false, "repeating a rejected login only burns the portal's lockout budget");
  assert.match(failure.friendly, /Reliance rejected the login for "agent1"/);
  assert.equal(driver.state.gets.filter((u) => u === copy.DEFAULT_LOGIN_URL).length, 5, "five attempts");
});

test("no username or password: the [E205] error comes before the browser is touched", async () => {
  const driver = fakeReliance();
  await assert.rejects(() => quiet(() => copy.fullCompanyLogin(driver, { username: "", password: "" }, { jobId: "job-F" })), /\[E205\]/);
  assert.deepEqual(driver.state.gets, [], "nothing was opened");
});

test("the captcha file is named per job and is gone afterwards", async () => {
  const driver = fakeReliance();
  seenCaptchaFiles.length = 0;
  await quiet(() => copy.fullCompanyLogin(driver, CREDS, { jobId: "job-G" }));
  assert.ok(seenCaptchaFiles.length > 0, "the captcha was written to a file for the reader");
  assert.ok(seenCaptchaFiles.every((f) => f === "reliance_captcha_job-G.png"), seenCaptchaFiles.join(", "));
  assert.equal(fs.existsSync(path.join(ROOT, "reliance_captcha_job-G.png")), false, "the temp PNG was deleted");
});

/* ---------------------------- the entry point routes to it ---------------------------- */

test("login(driver, 'reliance') is the copied full-company login", async () => {
  const driver = fakeReliance();
  const motors = await quiet(() => login(driver, "Reliance", CREDS, { jobId: "job-H" }));
  assert.equal(motors.id, "divMainMotors", "went through fullCompanyLogin, which returns the Motors menu");
});

test("National and KSHEMA still go through the shared login loop; unknown companies are refused", async () => {
  assert.deepEqual(SUPPORTED_COMPANIES, ["reliance", "national", "kshema"]);
  // The shared loop refuses to start without credentials, before it touches the browser.
  for (const company of ["national", "kshema"]) {
    await assert.rejects(
      () => login(fakeReliance(), company, { username: "", password: "" }, { jobId: "x", log() {} }),
      (e) => isMultiCompanyError(e) && e.code === "E205",
      company
    );
  }
  assert.throws(() => login({}, "nope", {}, {}), /unknown company "nope"/);
});

/* ------------- a whole Reliance handler run: window -> copied login -> handler body -> close ------------- */

/**
 * runHandler with the real browser, the recorder and the failure screenshot stubbed out. runHandler is loaded
 * once and keeps the functions it was loaded with, so the stubs hand out whatever the current test set.
 */
const harness = { driver: null, closed: null, installed: false };
function loadRunHandler(driver, closed) {
  harness.driver = driver;
  harness.closed = closed;
  if (!harness.installed) {
    const stub = (rel, exports) => {
      const p = require.resolve(rel);
      require.cache[p] = { id: p, filename: p, loaded: true, exports };
    };
    process.env.MULTI_COMPANY_AUTOMATION_ENABLED = "true"; // featureGate reads it once, at require time
    stub("../multiCompany/common/browser", {
      openJobBrowser: async (company, jobId) => ({ driver: harness.driver, profileInfo: {}, jobId }),
      closeJobBrowser: async (company, jobBrowser, opts) => harness.closed.push({ company, ...opts }),
    });
    stub("../lib/jobRecorder", { startRecording() {} });
    stub("../multiCompany/common/screenshot", { captureFailure: async () => ({}) });
    harness.installed = true;
  }
  return require("../multiCompany/common/runHandler").runHandler;
}

test("a Reliance handler run logs in through the copy, then reaches its own code, then closes the window", async () => {
  const driver = fakeReliance();
  const closed = [];
  const runHandler = loadRunHandler(driver, closed);
  let bodyRanAfterLogin = null;
  const result = await quiet(() =>
    runHandler({
      company: "reliance",
      policyType: "od",
      data: { ...CREDS, firstName: "Asha", _jobId: "j1" },
      body: async (ctx) => {
        bodyRanAfterLogin = driver.state.page === "dashboard" && driver.state.popupClosed;
        ctx.stop("the OD form starts here", { stage: "after-login" });
      },
    })
  );
  assert.equal(bodyRanAfterLogin, true, "the handler body starts on the logged-in dashboard, popup closed");
  assert.equal(result.inProgress, true);
  assert.equal(result.stage, "after-login");
  assert.deepEqual(closed, [{ company: "reliance", hadError: true }], "the window is closed (kept open by KEEP_BROWSER_OPEN_ON_ERROR on a stop)");
});

test("a Reliance handler run with a wrong password comes back E203, not retryable, and never reaches its body", async () => {
  const driver = fakeReliance({ password: "the-real-one" });
  const closed = [];
  const runHandler = loadRunHandler(driver, closed);
  let bodyRan = false;
  const result = await quiet(() =>
    runHandler({
      company: "reliance",
      policyType: "tp",
      data: { username: "agent1", password: "wrong", firstName: "Asha", _jobId: "j2" },
      body: async () => {
        bodyRan = true;
      },
    })
  );
  assert.equal(bodyRan, false);
  assert.equal(result.success, false);
  assert.equal(result.errorCode, "E203");
  assert.equal(result.retryable, false);
  assert.equal(result.stage, "login");
  assert.match(result.error, /Reliance rejected the login for "agent1"/);
  assert.deepEqual(closed, [{ company: "reliance", hadError: true }]);
});

test("Reliance TP is login only: it stops on the logged-in dashboard and tries no form step", async () => {
  for (const type of ["tp"]) {
    const driver = fakeReliance();
    const closed = [];
    loadRunHandler(driver, closed); // installs the stubs before the handler modules load
    const { resolveMultiCompanyHandler } = require("../multiCompany/registry");

    const looked = [];
    const realFind = driver.findElements;
    driver.findElements = async (locator) => {
      looked.push(String(locator && locator.value));
      return realFind(locator);
    };

    const handler = resolveMultiCompanyHandler("reliance", type);
    const result = await quiet(() =>
      handler({ ...CREDS, firstName: "Asha", _jobId: `j-${type}`, vehicleMake: "TVS", vehicleModel: "Jupiter" })
    );

    const label = `Reliance ${type.toUpperCase()}`;
    assert.equal(result.inProgress, true, label);
    assert.equal(result.stage, "logged-in", label);
    assert.equal(result.error, `Logged in to Reliance — the ${label} form is not built yet`);
    assert.equal(result.retryable, false, "a stop is never retried");
    assert.equal(driver.state.page, "dashboard", "it stopped on the logged-in dashboard");
    assert.equal(looked.some((v) => /VehicleDetailsMakeModel/.test(v)), false, `${label} must not go looking for the make & model field`);
    assert.deepEqual(closed, [{ company: "reliance", hadError: true }], "window handed back (kept open by KEEP_BROWSER_OPEN_ON_ERROR on a stop)");
  }
});

test("Reliance OD: login, then Motors -> Two Wheeler, then it stops there and goes no further", async () => {
  const driver = fakeReliance();
  const closed = [];
  loadRunHandler(driver, closed);
  const { resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const looked = [];
  const realFind = driver.findElements;
  driver.findElements = async (locator) => {
    looked.push(String(locator && locator.value));
    return realFind(locator);
  };

  const result = await quiet(() => resolveMultiCompanyHandler("reliance", "od")({ ...CREDS, firstName: "Asha", _jobId: "j-od" }));

  assert.equal(result.inProgress, true);
  assert.equal(result.stage, "motors-two-wheeler");
  assert.match(result.error, /Motors → Two Wheeler opened — the next step is not built yet/);
  assert.equal(driver.state.page, "twoWheeler", "it is on the Two Wheeler page");
  assert.ok(driver.state.clicks.includes("TwoWheelerLink"));
  assert.equal(looked.some((v) => /ddlMotorProducts|VehicleDetailsMakeModel/.test(v)), false, "the product dropdown is the NEXT step, not this one");
  assert.deepEqual(closed, [{ company: "reliance", hadError: true }]);
});

test("Reliance OD: a Motors submenu that never opens fails after 4 attempts as a retryable E302", async () => {
  const driver = fakeReliance({ submenuNeverOpens: true });
  loadRunHandler(driver, []);
  const { resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const result = await quiet(() => resolveMultiCompanyHandler("reliance", "od")({ ...CREDS, firstName: "Asha", _jobId: "j-od2" }));

  assert.equal(result.success, false);
  assert.equal(result.errorCode, "E302");
  assert.equal(result.retryable, true);
  assert.equal(result.stage, "motors-two-wheeler");
  assert.match(result.error, /never became clickable after 4 attempts/);
});

test("Reliance TP is still login only (no Motors menu step)", async () => {
  const driver = fakeReliance();
  loadRunHandler(driver, []);
  const { resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const result = await quiet(() => resolveMultiCompanyHandler("reliance", "tp")({ ...CREDS, firstName: "Asha", _jobId: "j-tp" }));
  assert.equal(result.stage, "logged-in");
  assert.equal(driver.state.page, "dashboard");
});

test("By.id locators in the fake still look like Selenium's (guards the fake itself)", () => {
  assert.match(By.id("txtUserName").value, /id="txtUserName"/);
});
