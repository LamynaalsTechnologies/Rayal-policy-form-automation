// United India (UIIC) login + the Breaker stop after it (2026-11-06). The login is the old download project's, on our
// shared login loop (multiCompany/common/login/runLogin.js). A fake browser plays the UIIC login page: every script the
// login runs in the page is answered by what it asks for (the scripts themselves are checked in real Chrome on a replica
// page, see the README). No Chrome, no OpenAI, no database.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaLogin.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const { runLogin } = require("../multiCompany/common/login/runLogin");
const ui = require("../multiCompany/common/login/unitedIndiaLogin");
const { waitForLoader, isLoaderVisible, LOADER_PRESETS } = require("../multiCompany/common/loader");
const { MESSAGE_SELECTORS, readPortalMessage } = require("../multiCompany/common/portalMessages");
const { MultiCompanyError } = require("../multiCompany/common/errors");

/* ------------------------------------------------------------------------------------------------------------------ */
/* A fake UIIC login page                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * @param {Object} o
 * @param {Function} o.onSubmit (n, typed) => "success" | { error: "text" } | "silent"; n = 1 for the first submit
 * @param {boolean} [o.formNeverLoads]
 * @param {number} [o.busyPolls] loader polls that still show "busy" after each page load
 * @param {string} [o.readyState]
 */
function fakeUiic({ onSubmit = () => "success", formNeverLoads = false, busyPolls = 0, readyState = "complete" } = {}) {
  const state = {
    page: "none",
    gets: [],
    submits: 0,
    typed: {},
    readonlyRemoved: 0,
    error: "",
    busyLeft: 0,
    captchaShots: 0,
    jsClicks: 0,
  };
  const el = (name, { displayed = () => true, text = () => "" } = {}) => ({
    name,
    async isDisplayed() {
      return displayed();
    },
    async getText() {
      return text();
    },
    async clear() {
      state.typed[name] = "";
    },
    async sendKeys(v) {
      state.typed[name] = (state.typed[name] || "") + v;
    },
    async getAttribute(attr) {
      return attr === "value" ? state.typed[name] || "" : null;
    },
    async click() {
      if (name !== "login") return;
      state.submits += 1;
      const out = onSubmit(state.submits, { ...state.typed });
      if (out === "success") {
        state.page = "dashboard";
        state.error = "";
      } else if (out && out.error) {
        state.error = out.error; // the login page again, with its error box
        state.typed = {};
      } // "silent": nothing changes
    },
    async takeScreenshot() {
      state.captchaShots += 1;
      return "PNGBASE64";
    },
  });
  const onLogin = () => state.page === "login";
  const elements = {
    "#username": el("username", { displayed: onLogin }),
    "#password": el("password", { displayed: onLogin }),
    "#userCaptcha": el("userCaptcha", { displayed: onLogin }),
    "#captchaImg": el("captchaImg", { displayed: onLogin }),
    "#login": el("login", { displayed: onLogin }),
    "#loginError": el("loginError", { displayed: () => onLogin() && !!state.error, text: () => state.error }),
  };
  const driver = {
    state,
    async get(url) {
      state.gets.push(url);
      state.page = formNeverLoads ? "blank" : "login";
      state.error = "";
      state.typed = {};
      state.busyLeft = busyPolls;
    },
    async findElements(locator) {
      const key = locator && locator.using === "css selector" ? locator.value : null;
      const hit = key && elements[key];
      if (!hit) return [];
      return (await hit.isDisplayed()) || key === "#loginError" ? [hit] : [];
    },
    async executeScript(script, ...args) {
      const s = String(script);
      if (s.includes("a[data-target='#10']")) return state.page === "dashboard"; // isLoggedIn
      if (s.includes('querySelectorAll("#loginError, .loginError")')) return onLogin() ? state.error : ""; // isCaptchaError
      if (s.includes('removeAttribute("readonly")')) {
        state.readonlyRemoved += 1;
        return null;
      }
      if (s.trim() === "return document.readyState") return readyState;
      if (s.includes("querySelectorAll(arguments[0])") && s.includes("sr-only")) {
        // the loader's busy check
        if (state.busyLeft > 0) {
          state.busyLeft -= 1;
          return true;
        }
        return false;
      }
      if (s.includes("naturalWidth > 0")) return true; // the captcha picture has loaded
      if (s.includes("arguments[0].click()")) {
        state.jsClicks += 1;
        return args[0].click();
      }
      if (s.includes("HTMLInputElement.prototype")) {
        state.typed[args[0].name] = args[1];
        return null;
      }
      return null;
    },
    async executeAsyncScript() {
      return "ENLARGED"; // the canvas enlargement
    },
    async sleep() {
      await new Promise((r) => setImmediate(r));
    },
    async getCurrentUrl() {
      return state.page === "dashboard" ? "https://www.uiic.in/GCWebPortal/home" : ui.DEFAULT_URL;
    },
  };
  return driver;
}

/** The real strategy with a fake captcha reader and short waits (the loop's deadlines are real time). */
function strategy({ reads = ["Ab12C"], waits = {} } = {}) {
  const asked = [];
  const s = ui.createUnitedIndiaStrategy({
    readCaptcha: async (imageUrl) => {
      asked.push(imageUrl);
      return reads[Math.min(asked.length - 1, reads.length - 1)];
    },
  });
  return { s: { ...s, pageLoadMs: 300, loginResultMs: 300, ...waits }, asked };
}

const CREDS = { username: "UIIC-AGENT-1", password: "secret-pw", loginUrl: "" };
const quiet = () => {
  const lines = [];
  return { lines, ctx: { jobId: "job1", log: (l) => lines.push(String(l)) } };
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* the login                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

test("the strategy: the UIIC page, its boxes, 3 attempts; registered in the login index", () => {
  assert.equal(ui.company, "united india");
  assert.equal(ui.label, "United India");
  assert.equal(ui.defaultUrl, "https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login");
  assert.equal(ui.attempts, 3);
  assert.deepEqual(ui.FIELDS.username.slice(0, 1), ["#username"]);
  assert.deepEqual(ui.FIELDS.password.slice(0, 2), ["#password", "input[name='userPaWord']"]);
  assert.deepEqual(ui.FIELDS.captcha.slice(0, 1), ["#userCaptcha"]);
  assert.deepEqual(ui.FIELDS.submit.slice(0, 1), ["#login"]);
  const { SUPPORTED_COMPANIES } = require("../multiCompany/common/login");
  assert.ok(SUPPORTED_COMPANIES.includes("united india"));
});

test("success: the page opens, readonly is removed, the captcha is read once from the enlarged picture, ONE submit", async () => {
  const driver = fakeUiic();
  const { s, asked } = strategy();
  const { lines, ctx } = quiet();
  await runLogin(driver, s, CREDS, ctx);
  assert.deepEqual(driver.state.gets, [ui.DEFAULT_URL], "no saved login URL -> the UIIC page");
  assert.equal(driver.state.submits, 1);
  assert.equal(driver.state.readonlyRemoved, 1);
  assert.equal(driver.state.captchaShots, 1, "the picture is taken in memory, once");
  assert.deepEqual(asked, ["data:image/png;base64,ENLARGED"], "the enlarged picture goes to the reader");
  assert.ok(lines.some((l) => /✅ United India: logged in as UIIC-AGENT-1/.test(l)));
  assert.ok(lines.some((l) => /🔑 United India captcha read: Ab12C/.test(l)));
  assert.equal(lines.some((l) => l.includes("secret-pw")), false, "the password is never printed");
});

test("a saved login URL wins over the UIIC default", async () => {
  const driver = fakeUiic();
  const { s } = strategy();
  await runLogin(driver, s, { ...CREDS, loginUrl: "https://uiic.example/GCWebPortal/login/LoginAction.do?p=login" }, quiet().ctx);
  assert.deepEqual(driver.state.gets, ["https://uiic.example/GCWebPortal/login/LoginAction.do?p=login"]);
});

test("the typed values reach the boxes: user, password and the captcha read", async () => {
  let seen = null;
  const driver = fakeUiic({
    onSubmit: (n, typed) => {
      seen = typed;
      return "success";
    },
  });
  await runLogin(driver, strategy().s, CREDS, quiet().ctx);
  assert.deepEqual(seen, { username: "UIIC-AGENT-1", password: "secret-pw", userCaptcha: "Ab12C" });
});

test("a captcha refusal is tried again on a FRESH page with a FRESH captcha, then logs in", async () => {
  const driver = fakeUiic({ onSubmit: (n) => (n === 1 ? { error: "Please enter valid Captcha" } : "success") });
  const { s, asked } = strategy({ reads: ["WRNG1", "Rite2"] });
  const { lines, ctx } = quiet();
  await runLogin(driver, s, CREDS, ctx);
  assert.equal(driver.state.gets.length, 2, "the page is opened again");
  assert.equal(asked.length, 2, "a new captcha is read");
  assert.equal(driver.state.submits, 2);
  assert.ok(lines.some((l) => /captcha rejected — retrying/.test(l)));
});

test("a wrong user id / password ends the login at once: [E203], not retried, submitted ONCE, the portal's words kept", async () => {
  const driver = fakeUiic({ onSubmit: () => ({ error: "Invalid User Id or Password" }) });
  await assert.rejects(runLogin(driver, strategy().s, CREDS, quiet().ctx), (e) => {
    assert.ok(e instanceof MultiCompanyError);
    assert.equal(e.code, "E203");
    assert.equal(e.retryable, false);
    assert.match(e.message, /United India portal rejected the login for "UIIC-AGENT-1"/);
    assert.match(e.message, /Invalid User Id or Password/);
    return true;
  });
  assert.equal(driver.state.submits, 1, "a wrong password is never sent twice (it could lock the account)");
  assert.equal(driver.state.gets.length, 1);
});

test("a locked account is [E204], not retried", async () => {
  const driver = fakeUiic({ onSubmit: () => ({ error: "Your account is locked. Contact the administrator" }) });
  await assert.rejects(runLogin(driver, strategy().s, CREDS, quiet().ctx), (e) => e.code === "E204" && e.retryable === false);
  assert.equal(driver.state.submits, 1);
});

test("a login page that never shows its form is [E304] after 3 tries (the portal may be down) - nothing is typed", async () => {
  const driver = fakeUiic({ formNeverLoads: true });
  await assert.rejects(runLogin(driver, strategy().s, CREDS, quiet().ctx), (e) => {
    assert.equal(e.code, "E304");
    assert.notEqual(e.retryable, false, "time can fix a portal that is down");
    assert.match(e.message, /United India login page did not load/);
    return true;
  });
  assert.equal(driver.state.gets.length, 3);
  assert.equal(driver.state.submits, 0);
});

test("a captcha read that is not 4 to 8 letters / digits is never typed: a fresh captcha each time, then [E202]", async () => {
  const driver = fakeUiic();
  const { s, asked } = strategy({ reads: ["the captcha says hello", "ab", "Xy!"] });
  const { lines, ctx } = quiet();
  await assert.rejects(runLogin(driver, s, CREDS, ctx), (e) => e.code === "E202" && e.retryable !== false);
  assert.equal(driver.state.submits, 0, "nothing was submitted with a bad read");
  assert.equal(asked.length, 3);
  assert.equal(driver.state.gets.length, 3, "a fresh page (fresh captcha) for every try");
  assert.ok(lines.some((l) => /not 4 to 8 letters or digits/.test(l)));
});

test("a good read on the second try logs in", async () => {
  const driver = fakeUiic();
  const { s } = strategy({ reads: ["??", "Q7w8E"] });
  await runLogin(driver, s, CREDS, quiet().ctx);
  assert.equal(driver.state.submits, 1);
  assert.equal(driver.state.gets.length, 2);
});

test("the captcha reader failing is a fresh try, not a crash", async () => {
  const driver = fakeUiic();
  let n = 0;
  const s = {
    ...ui.createUnitedIndiaStrategy({
      readCaptcha: async () => {
        n += 1;
        if (n === 1) throw new Error("OpenAI timeout");
        return "Good1";
      },
    }),
    pageLoadMs: 300,
    loginResultMs: 300,
  };
  const { lines, ctx } = quiet();
  await runLogin(driver, s, CREDS, ctx);
  assert.equal(driver.state.submits, 1);
  assert.ok(lines.some((l) => /the captcha reader failed \(OpenAI timeout\)/.test(l)));
});

test("no answer at all after the submit, page idle: the loop may try again, then [E203] (the portal turned it away)", async () => {
  const driver = fakeUiic({ onSubmit: () => "silent" });
  await assert.rejects(runLogin(driver, strategy().s, CREDS, quiet().ctx), (e) => e.code === "E203");
  assert.ok(driver.state.submits >= 1);
});

test("no username or password: [E205] before any page is opened", async () => {
  const driver = fakeUiic();
  await assert.rejects(runLogin(driver, strategy().s, { username: "", password: "" }, quiet().ctx), (e) => e.code === "E205");
  assert.equal(driver.state.gets.length, 0);
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* loader + messages                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

test("the loader: United India has its own preset that also waits for the page's own load (waitReady)", async () => {
  const preset = LOADER_PRESETS["united india"];
  assert.equal(preset.label, "United India");
  assert.equal(preset.waitReady, true);
  assert.match(preset.busy, /\.blockUI\.blockOverlay/);
  // a busy page clears after a few polls
  const driver = fakeUiic({ busyPolls: 3 });
  await driver.get("x");
  assert.equal(await waitForLoader(driver, "united india", { timeoutMs: 2000, pollMs: 1 }), true);
  assert.equal(driver.state.busyLeft, 0);
  // a page still loading is busy, and one that never finishes is [E302] with the company named
  const loading = fakeUiic({ readyState: "loading" });
  assert.equal(await isLoaderVisible(loading, "united india"), true);
  await assert.rejects(waitForLoader(loading, "united india", { timeoutMs: 50, pollMs: 1 }), (e) => {
    assert.equal(e.code, "E302");
    assert.match(e.message, /The United India portal is still loading/);
    return true;
  });
});

test("the loader's other companies are unchanged: no waitReady", () => {
  for (const c of ["reliance", "national", "kshema"]) assert.equal(LOADER_PRESETS[c].waitReady, undefined, c);
});

test("the portal's error box is read for United India (#loginError first)", async () => {
  assert.deepEqual(MESSAGE_SELECTORS["united india"], ["#loginError", ".loginError"]);
  const driver = fakeUiic({ onSubmit: () => ({ error: "Invalid Captcha" }) });
  await driver.get("x");
  await (await driver.findElements({ using: "css selector", value: "#login" }))[0].click();
  assert.equal(await readPortalMessage(driver, "united india"), "Invalid Captcha");
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* the handler: login, then the Breaker stop                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The handler with runHandler replaced by one that hands back its options (no browser is opened). */
function handlerOptions(data = {}, deps = { openMenu: async () => ({ url: "menu-faked" }), chooseProduct: async () => ({ product: "Liability Only Policy" }), fillRisk: async () => ({}), fillDates: async () => ({}), answerQuestions: async () => ({}), fillInsured: async () => ({}), fillPin: async () => ({}), fillContact: async () => ({}), chooseRto: async () => ({}), openMore: async () => ({}), fillTppd: async () => ({}), fillPa: async () => ({}), compute: async () => ({}), quote: async () => ({}), proposal: async () => ({}), kyc: async () => null }) {
  require("../breaker"); // the global Breaker, as runHandler loads it
  const runHandlerPath = require.resolve("../multiCompany/common/runHandler");
  const handlerPath = require.resolve("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP");
  const saved = require.cache[runHandlerPath];
  delete require.cache[handlerPath];
  require.cache[runHandlerPath] = { id: runHandlerPath, filename: runHandlerPath, loaded: true, exports: { runHandler: (opts) => opts } };
  try {
    const handler = require(handlerPath);
    return { opts: handler.fillUnitedIndiaTP(data, deps), NOT_BUILT: handler.NOT_BUILT, handler };
  } finally {
    if (saved) require.cache[runHandlerPath] = saved;
    else delete require.cache[runHandlerPath];
    delete require.cache[handlerPath];
  }
}

const withEnv = async (vars, fn) => {
  const before = {};
  for (const k of Object.keys(vars)) {
    before[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
};

const handlerCtx = () => {
  const { stopper } = require("../automationStopper");
  const lines = [];
  return { lines, ctx: { jobId: "tp_united india_A_1", driver: { fake: true }, data: { customerState: "tamilnadu" }, log: (l) => lines.push(String(l)), stop: stopper } };
};

test("the handler runs inside runHandler as United India TP (the shared login, browser, Hold, screenshot, clean-up)", () => {
  const { opts } = handlerOptions({ firstName: "A" });
  assert.equal(opts.company, "united india");
  assert.equal(opts.policyType, "tp");
  assert.equal(typeof opts.body, "function");
});

test("with BREAKER_ENABLED=true and BREAKER_STOP_AT=stopthis-location it stops after the product's Submit (a Breaker stop)", async () => {
  const menuCalls = [];
  const { opts } = handlerOptions({}, {
    openMenu: async (driver, o) => menuCalls.push({ step: "menu", driver, log: typeof o.log }),
    chooseProduct: async (driver, o) => menuCalls.push({ step: "product", driver, log: typeof o.log }),
    fillRisk: async (driver, data, o) => menuCalls.push({ step: "risk", driver, data, log: typeof o.log }),
    fillDates: async (driver, o) => menuCalls.push({ step: "dates", driver, log: typeof o.log }),
    answerQuestions: async (driver, o) => menuCalls.push({ step: "questions", driver, log: typeof o.log }),
    fillInsured: async (driver, data, o) => menuCalls.push({ step: "insured", driver, data, log: typeof o.log }),
    fillPin: async (driver, data, o) => menuCalls.push({ step: "pin", driver, data, log: typeof o.log }),
    fillContact: async (driver, data, o) => menuCalls.push({ step: "contact", driver, data, log: typeof o.log }),
    chooseRto: async (driver, data, o) => menuCalls.push({ step: "rto", driver, data, log: typeof o.log }),
    openMore: async (driver, o) => menuCalls.push({ step: "more-covers", driver, log: typeof o.log }),
    fillTppd: async (driver, data, o) => menuCalls.push({ step: "tppd", driver, data, log: typeof o.log }),
    fillPa: async (driver, data, o) => menuCalls.push({ step: "pa", driver, data, log: typeof o.log }),
    compute: async (driver, o) => menuCalls.push({ step: "compute", driver, log: typeof o.log }),
    quote: async (driver, data, o) => menuCalls.push({ step: "quote", driver, data, log: typeof o.log, downloadDir: o.downloadDir, jobId: o.jobId }),
    proposal: async (driver, data, o) => menuCalls.push({ step: "proposal", driver, data, log: typeof o.log, jobId: o.jobId }),
    kyc: async (driver, data, how, o) => menuCalls.push({ step: "kyc", driver, data, how, log: typeof o.log }),
  });
  const { lines, ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "stopthis-location" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      const { isAutomationStop } = require("../automationStopper");
      assert.ok(isAutomationStop(e), "a deliberate stop, not a failure");
      assert.equal(e.details && e.details.breaker, true);
      assert.equal(e.details.checkpoint, "stopthis-location");
      if (typeof e.acknowledge === "function") e.acknowledge();
      return true;
    });
  });
  assert.ok(lines.some((l) => /United India - logged in$/.test(l)));
  assert.deepEqual(
    menuCalls,
    [
      { step: "menu", driver: ctx.driver, log: "function" },
      { step: "product", driver: ctx.driver, log: "function" },
      { step: "risk", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "dates", driver: ctx.driver, log: "function" },
      { step: "questions", driver: ctx.driver, log: "function" },
      { step: "insured", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "pin", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "contact", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "rto", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "more-covers", driver: ctx.driver, log: "function" },
      { step: "tppd", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "pa", driver: ctx.driver, data: ctx.data, log: "function" },
      { step: "compute", driver: ctx.driver, log: "function" },
      { step: "quote", driver: ctx.driver, data: ctx.data, log: "function", downloadDir: ctx.downloadDir, jobId: ctx.jobId },
      { step: "proposal", driver: ctx.driver, data: ctx.data, log: "function", jobId: ctx.jobId },
      { step: "kyc", driver: ctx.driver, data: ctx.data, how: { modify: false, ifShown: true }, log: "function" },
    ],
    "the menu, the product, Risk Details (with the job data), the dates, PUC / Delhi - NCR, the insured, the Pin Code, the contact details, the RTO, More Covers, then the TPPD Limit (with the job data), on the logged-in browser - before the Breaker"
  );
});

test("Generate Quote not there after Compute Premium: the Quote / Worksheet tried again AFTER Update; never there = a warning, not a failure", async () => {
  const calls = [];
  const quoteFake = (answers) => async (driver, data, o) => {
    calls.push(`quote ${o.where} ifShown=${o.ifShown}`);
    return answers.shift();
  };
  const deps = (answers) => ({
    openMenu: async () => {},
    chooseProduct: async () => {},
    fillRisk: async () => {},
    fillDates: async () => {},
    answerQuestions: async () => {},
    fillInsured: async () => {},
    fillPin: async () => {},
    fillContact: async () => {},
    chooseRto: async () => {},
    openMore: async () => {},
    fillTppd: async () => {},
    fillPa: async () => {},
    compute: async () => {},
    quote: quoteFake(answers),
    proposal: async () => {
      calls.push("proposal");
      return { proposalNumber: "202611131194829" };
    },
    kyc: async () => null,
  });
  for (const [answers, want, warned] of [
    [[{ quotePdf: {} }], ["quote after Compute Premium ifShown=true", "proposal"], false],
    [[null, { quotePdf: {} }], ["quote after Compute Premium ifShown=true", "proposal", "quote after Update ifShown=true"], false],
    [[null, null], ["quote after Compute Premium ifShown=true", "proposal", "quote after Update ifShown=true"], true],
  ]) {
    calls.length = 0;
    const { opts } = handlerOptions({}, deps(answers));
    const { lines, ctx } = handlerCtx();
    await withEnv({ BREAKER_ENABLED: "false" }, async () => {
      await assert.rejects(opts.body(ctx), (e) => {
        if (typeof e.acknowledge === "function") e.acknowledge();
        return require("../automationStopper").isAutomationStop(e);
      });
    });
    assert.deepEqual(calls, want);
    assert.equal(lines.some((l) => /Generate Quote was not on the page before or after Update - the Quote PDF and Worksheet were not kept/.test(l)), warned);
  }
});

test("a menu step that fails is a failure, not a Breaker stop (the Breaker is never reached)", async () => {
  const { opts } = handlerOptions({}, { openMenu: async () => { throw new Error("[E301] menu missing"); }, chooseProduct: async () => assert.fail("not reached") });
  const { ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "stopthis-location" }, async () => {
    await assert.rejects(opts.body(ctx), /\[E301\] menu missing/);
  });
});

test("without the Breaker it still stops after the product's Submit: the rest is not built yet (no retry)", async () => {
  const { opts, NOT_BUILT } = handlerOptions();
  const { ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      const { isAutomationStop, stoppedResult } = require("../automationStopper");
      assert.ok(isAutomationStop(e));
      assert.equal(e.message, `${NOT_BUILT} (no Update Ckyc button on the page after Update)`);
      const result = stoppedResult(e);
      assert.equal(result.retryable, false);
      assert.equal(result.stage, "risk-details");
      assert.match(NOT_BUILT, /New Vehicle, Chassis, Engine Number, Vehicle Manufacturer, Make, Date of Purchase, Month and Year of Manufacture, Valid PUC \(Yes\), Delhi - NCR \(No\), Client Type, High Risk \(No\), Title, Insured Name, Address, Pin Code \(State and District filled\), Mobile, Email, Date of Birth and RTO entered, More Covers N Info opened, TPPD Limit and PA Cover set, back on Risk Details and Compute Premium done, Quote PDF and Worksheet kept, Update pressed and the proposal saved, the KYC is not built yet/);
      assert.equal(result.inProgress, true);
      return true;
    });
  });
});

test("the registry: united india / tp is this handler; there is no United India OD", () => {
  const { resolveMultiCompanyHandler } = require("../multiCompany/registry");
  const handler = resolveMultiCompanyHandler("United India", "tp");
  assert.equal(typeof handler, "function");
  assert.equal(handler.name, "fillUnitedIndiaTP");
  assert.equal(resolveMultiCompanyHandler("united india", "od"), null);
});

test("the browser: United India has its own session manager and profile folder, cleaned on start and swept", () => {
  const { SUPPORTED_COMPANIES } = require("../multiCompany/common/browser");
  assert.ok(SUPPORTED_COMPANIES.includes("united india"));
  const { PROFILE_BASE } = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSession");
  assert.equal(path.basename(PROFILE_BASE()), "cloned_profiles_united_india");
  const src = require("fs").readFileSync(require.resolve("../server.js"), "utf8");
  assert.equal(src.split("cloned_profiles_united_india").length - 1, 2, "in the startup clean-up AND the 5-minute sweep");
});

test("a United India captcha is not counted as a Reliance one", async () => {
  const src = require("fs").readFileSync(require.resolve("../multiCompany/common/login/unitedIndiaLogin.js"), "utf8");
  assert.match(src, /extractCaptchaText\(imageUrl, \{ count: false \}\)/);
});

test("a United India failure screenshot goes to multiCompany/united_india (no space in the S3 folder); the others unchanged", async () => {
  const s3Path = require.resolve("../s3Uploader");
  const shotPath = require.resolve("../multiCompany/common/screenshot");
  const savedS3 = require.cache[s3Path];
  const folders = [];
  require.cache[s3Path] = {
    id: s3Path,
    filename: s3Path,
    loaded: true,
    exports: {
      generateScreenshotKey: (jobId, attempt, folder) => {
        folders.push(folder);
        return `${folder}/${jobId}.png`;
      },
      uploadScreenshotToS3: async (b64, key) => `https://s3.example/${key}`,
    },
  };
  delete require.cache[shotPath];
  try {
    const { captureFailure } = require(shotPath);
    const driver = { takeScreenshot: async () => "PNG" };
    await captureFailure(driver, { company: "united india", jobId: "j1" });
    await captureFailure(driver, { company: "kshema", jobId: "j2" });
    assert.deepEqual(folders, ["multiCompany/united_india", "multiCompany/kshema"]);
  } finally {
    if (savedS3) require.cache[s3Path] = savedS3;
    else delete require.cache[s3Path];
    delete require.cache[shotPath];
  }
});

test("the profile folder: one per run under cloned_profiles_united_india, no spaces in its name", async () => {
  const os = require("os");
  const fs = require("fs");
  const session = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSession");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ui-session-"));
  const cwd = process.cwd();
  process.chdir(tmp);
  try {
    const jb = await session.createUnitedIndiaJobBrowser("tp_united india_ANMOL_1", { buildDriver: async () => ({}) });
    const name = path.basename(jb.profileInfo.userDataDir);
    assert.match(name, /^united_india_job_tp_united_india_ANMOL_1_\d+_[a-z0-9]+$/);
    assert.doesNotMatch(name, /\s/);
    assert.equal(path.basename(path.dirname(jb.profileInfo.userDataDir)), "cloned_profiles_united_india");
    assert.ok(fs.existsSync(jb.profileInfo.downloadDir));
    // (whether a finished window is closed follows the .env - KEEP_BROWSER_OPEN_ON_ERROR / CLOSE_BROWSER_AFTER_COMPLETE -
    // and is covered for every company by test/browserRetention.test.js and test/retainedBrowser.test.js)
    require("../lib/jobDirs").release(jb.profileInfo.userDataDir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------------------------------------------------ */
/* a proposal made before: opened from Proposal Modification, never made again (the owner, 2026-11-13)                */
/* ------------------------------------------------------------------------------------------------------------------ */

const resumeDeps = (plan, calls) => {
  const step = (name) => async (...args) => {
    calls.push(name === "openSaved" ? `${name} ${args[1].proposalNumber} ${args[1].referenceDate}` : name);
    return {};
  };
  return {
    loadPlan: async (data, o) => {
      calls.push(`loadPlan ${o.jobId}`);
      return plan;
    },
    openModification: step("openModification"),
    openSaved: step("openSaved"),
    setStartDate: step("setStartDate"),
    setHighRisk: step("setHighRisk"),
    kyc: async (driver, data, how) => {
      calls.push(`kyc modify=${how.modify} ifShown=${!!how.ifShown}`);
      return how.modify ? { said: ["KYC details saved successfully"], page: {}, aadhaar: "XXXXXXXX1234" } : null;
    },
    openMenu: step("openMenu"),
    chooseProduct: step("chooseProduct"),
    fillRisk: step("fillRisk"),
    fillDates: step("fillDates"),
    answerQuestions: step("answerQuestions"),
    fillInsured: step("fillInsured"),
    fillPin: step("fillPin"),
    fillContact: step("fillContact"),
    chooseRto: step("chooseRto"),
    openMore: step("openMore"),
    fillTppd: step("fillTppd"),
    fillPa: step("fillPa"),
    compute: step("compute"),
    quote: step("quote"),
    proposal: step("proposal"),
  };
};

test("a proposal made before: Proposal Modification -> High Risk No -> More Covers -> TPPD -> PA -> Back + Compute, then the stop; NO new proposal", async () => {
  const calls = [];
  const { opts } = handlerOptions({}, resumeDeps({ skipProposal: true, proposalNumber: "202611131375485", referenceDate: "13/11/2026", startAt: "kyc" }, calls));
  const { lines, ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      const { isAutomationStop } = require("../automationStopper");
      assert.ok(isAutomationStop(e));
      assert.equal(
        e.message,
        'United India - the proposal was made before, so it was opened from Proposal Modification (not made again), Policy Start Date today, High Risk (No), More Covers N Info, TPPD Limit and PA Cover set again, Compute Premium and Modify done, the CKYC window opened, Offline KYC with the Aadhaar card (Verified, Same as above) entered and Save pressed; what comes after Save is not built yet - proposal 202611131375485 of 13/11/2026 - United India said "KYC details saved successfully"'
      );
      if (typeof e.acknowledge === "function") e.acknowledge();
      return true;
    });
  });
  assert.deepEqual(calls, [
    "loadPlan tp_united india_A_1",
    "openModification",
    "openSaved 202611131375485 13/11/2026",
    "setStartDate",
    "setHighRisk",
    "openMore",
    "fillTppd",
    "fillPa",
    "compute",
    "kyc modify=true ifShown=false",
  ]);
  assert.ok(lines.some((l) => /📌 United India - proposal 202611131375485 of 13\/11\/2026 was made before - opening it from Proposal Modification \(not making a new one\)/.test(l)));
});

test("a proposal made before WITHOUT its Reference Date: [E306] at once, not retried, nothing clicked", async () => {
  const calls = [];
  const { opts } = handlerOptions({}, resumeDeps({ skipProposal: true, proposalNumber: "202611131375485", referenceDate: null, startAt: "kyc" }, calls));
  const { ctx } = handlerCtx();
  await assert.rejects(opts.body(ctx), (e) => {
    assert.equal(e.code, "E306");
    assert.equal(e.retryable, false);
    assert.match(e.message, /proposal 202611131375485 is saved without its Reference Date, so it cannot be found in Proposal Modification and the run stopped there\. Add the Reference Date in Edit -> Status, then run the policy again\./);
    return true;
  });
  assert.deepEqual(calls, ["loadPlan tp_united india_A_1"]);
});

test("no proposal yet (or one without a number): the full form as before - Proposal Modification is never opened", async () => {
  for (const plan of [{ skipProposal: false, proposalNumber: null, startAt: "proposal" }, null]) {
    const calls = [];
    const { opts } = handlerOptions({}, resumeDeps(plan, calls));
    const { ctx } = handlerCtx();
    await withEnv({ BREAKER_ENABLED: "false" }, async () => {
      await assert.rejects(opts.body(ctx), (e) => {
        if (typeof e.acknowledge === "function") e.acknowledge();
        return true;
      });
    });
    assert.ok(!calls.includes("openModification") && !calls.includes("openSaved"), calls.join());
    assert.deepEqual(calls.slice(0, 3), ["loadPlan tp_united india_A_1", "openMenu", "chooseProduct"]);
    assert.ok(calls.includes("proposal"));
    assert.equal(calls[calls.length - 1], "kyc modify=false ifShown=true", "a new proposal: the KYC only when its page offers it");
  }
});

test("a NEW proposal whose page offers Update Ckyc: the KYC done after Update, the stop says so (with United India's words)", async () => {
  const calls = [];
  const deps = resumeDeps(null, calls);
  deps.proposal = async () => ({ proposalNumber: "202611131394000", referenceDate: "13/11/2026" });
  deps.kyc = async (driver, data, how) => {
    calls.push(`kyc modify=${how.modify} ifShown=${!!how.ifShown}`);
    return { said: [], page: {}, aadhaar: "XXXXXXXX1234" };
  };
  const { opts, handler } = handlerOptions({}, deps);
  const { ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      assert.equal(e.message, `${handler.NEW_WITH_KYC} - proposal 202611131394000 of 13/11/2026`);
      assert.match(e.message, /Update pressed and the proposal saved, the CKYC window opened, Offline KYC with the Aadhaar card \(Verified, Same as above\) entered and Save pressed; what comes after Save is not built yet/);
      if (typeof e.acknowledge === "function") e.acknowledge();
      return true;
    });
  });
  assert.equal(calls[calls.length - 1], "kyc modify=false ifShown=true");
});

test("KYC: the policy's Aadhaar number is checked BEFORE anything is clicked; it shows only as XXXXXXXX1234", async () => {
  const k = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaKyc");
  const untouched = { executeScript: async () => assert.fail("the page was touched"), findElements: async () => assert.fail("the page was touched") };
  for (const [data, why] of [
    [{}, /the policy has no Aadhaar number, so the KYC cannot be done/],
    [{ aadharNumber: "1234 5678 901" }, /the Aadhaar number on the policy \(XXXXXXX8901\) is not 12 digits/],
  ]) {
    await assert.rejects(k.unitedIndiaKyc(untouched, data, { modify: true }, { log: () => {} }), (e) => e.code === "E306" && e.retryable === false && why.test(e.message) && /Read Aadhaar & fill details/.test(e.message));
  }
  assert.equal(k.aadhaarOf({ aadharNumber: "1234 5678 9012" }), "123456789012");
  assert.equal(k.aadhaarOf({ formData: { aadharNumber: "123456789012" } }), "123456789012");
  assert.equal(k.maskAadhaar("123456789012"), "XXXXXXXX9012");
  assert.equal(k.kycDataProblem({ aadharNumber: "123456789012" }), null);
  // the owner's answers and buttons
  assert.equal(k.PROOF.answer, "Aadhaar card");
  assert.equal(k.VERIFICATION.answer, "Verified");
  assert.ok(k.CONFIRMATION.test("GSTIN/UIN HAS NOT BEEN INSERTED ... Do you want to proceed?"));
  assert.ok(!k.CONFIRMATION.test("Please select the Zone"), "an error popup is never just pressed OK after Modify");
  assert.ok(k.MODIFY.target.every((t) => !String(t.value || t).includes("#updt")), "Modify by its picture, not by id=updt");
});

test("Proposal Modification: a saved proposal that cannot be looked up stops BEFORE the page is touched; OUR row only counts when it alone is checked", async () => {
  const pm = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaProposalModification");
  const untouched = { executeScript: async () => assert.fail("the page was touched"), findElements: async () => assert.fail("the page was touched") };
  for (const [number, date] of [["R141026119597", "13/11/2026"], ["202611131375485", "2026-11-13"], ["202611131375485", ""]]) {
    await assert.rejects(pm.openSavedProposal(untouched, { proposalNumber: number, referenceDate: date }, { log: () => {} }), (e) => e.code === "E306" && e.retryable === false && /cannot be looked up/.test(e.message));
  }
  const listing = (rows) => ({ executeScript: async (fn) => (fn === pm.readProposalListInPage ? { table: true, rows, checked: rows.filter((r) => r.checked).length } : null) });
  const row = (number, checked) => ({ option: "0", number, date: "13/11/2026", name: "ANMOL", premium: "4545", checked });
  assert.equal(await pm.ourRowChecked(listing([row("202611131393359", true), row("202611131375485", false)]), "202611131375485"), false, "the portal's pre-selected first row is NOT ours");
  assert.equal(await pm.ourRowChecked(listing([row("202611131393359", false), row("202611131375485", true)]), "202611131375485"), true);
  assert.equal(await pm.ourRowChecked(listing([row("202611131393359", true), row("202611131375485", true)]), "202611131375485"), false, "two checked = not sure");
  assert.equal(await pm.ourRowChecked(listing([]), "202611131375485"), false);
  // Next is found by its name, never by id="updt" (the Risk Details page's Update picture has that id too)
  assert.ok(pm.NEXT.target.every((t) => !String(t.value || t).includes("#updt")));
  assert.equal(pm.LIST_WAIT_MS, 20000);
});

test("KYC already done (Offline KYC disabled - the owner's live run): the part's KYC step = completed, offline, with the Result and Customer Id; a failed write is said, never a failure", async () => {
  const k = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaKyc");
  const marked = [];
  const lines = [];
  const ok = await k.markKycDone(
    { _id: "6650aa", _partKey: "tp" },
    { result: "Offline KYC Done", customerId: "23676065442", offlineDisabled: true },
    { log: (l) => lines.push(l), jobId: "j1", deps: { markStage: async (data, stage, status, extra, opts) => (marked.push({ stage, status, extra, opts }), true) } }
  );
  assert.equal(ok, true);
  assert.deepEqual(marked, [{ stage: "kyc", status: "completed", extra: { mode: "offline", result: "Offline KYC Done", customerId: "23676065442" }, opts: { jobId: "j1", insurer: "United India" } }]);
  assert.ok(lines.some((l) => /✅ United India - KYC step = completed on the policy/.test(l)));
  const failed = await k.markKycDone({}, {}, { log: (l) => lines.push(l), deps: { markStage: async () => { throw new Error("db down"); } } });
  assert.equal(failed, false);
  assert.ok(lines.some((l) => /the KYC is done at United India, but the KYC step could not be saved on the policy - set it to Completed by hand in Edit -> Status/.test(l)));
});

test("the stop says what the KYC found: already done / done by Save / Save only", async () => {
  const { handler } = handlerOptions();
  assert.equal(
    handler.kycWords({ alreadyDone: true, result: "Offline KYC Done", stepSaved: true }),
    'the CKYC window opened - the KYC was already done at United India (Offline KYC disabled, "Offline KYC Done"), KYC step = completed; what comes after the KYC is not built yet'
  );
  assert.match(handler.kycWords({ kycDone: true, result: "Offline KYC Done", stepSaved: true }), /Save pressed - the KYC is done \(Offline KYC disabled, "Offline KYC Done"\), KYC step = completed; what comes after the KYC is not built yet$/);
  assert.equal(handler.kycWords({ said: [] }), handler.KYC_DONE, "Save only: the KYC step is left as it is");
  assert.match(handler.kycWords({ alreadyDone: true, stepSaved: false }), /the KYC step could NOT be saved \(set it to Completed in Edit -> Status\)/);
  assert.match(handler.kycWords({ alreadyDone: true, stepSaved: true, closed: "button" }), /KYC step = completed, the CKYC window closed; what comes after the KYC/);
  assert.match(handler.kycWords({ kycDone: true, stepSaved: true, closed: "run" }), /KYC step = completed, the CKYC window closed \(by the run - its Close did not\); what comes after the KYC/);

  // on a resume the handler stops with it
  const calls = [];
  const deps = resumeDeps({ skipProposal: true, proposalNumber: "202611131375485", referenceDate: "13/11/2026", startAt: "kyc" }, calls);
  deps.kyc = async () => ({ alreadyDone: true, kycDone: true, result: "Offline KYC Done", stepSaved: true, said: [] });
  const { opts } = handlerOptions({}, deps);
  const { ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      assert.equal(e.message, `${handler.RESUME_BASE}, the CKYC window opened - the KYC was already done at United India (Offline KYC disabled, "Offline KYC Done"), KYC step = completed; what comes after the KYC is not built yet - proposal 202611131375485 of 13/11/2026`);
      if (typeof e.acknowledge === "function") e.acknowledge();
      return true;
    });
  });
});

test("the proposal kept FRESH: the list's moved Reference Date (date only), then after Modify the page's number + date (+ transaction, customer) - a NEW number taken too", async () => {
  const calls = [];
  const dates = [];
  const fresh = [];
  const deps = resumeDeps({ skipProposal: true, proposalNumber: "202611131393359", referenceDate: "13/11/2026", startAt: "kyc" }, calls);
  deps.openSaved = async () => ({ row: { number: "202611131393359", date: "14/11/2026" } });
  deps.saveDate = async (data, d) => (dates.push(`${d.proposalNumber} ${d.referenceDate}`), true);
  deps.saveFresh = async (data, { was, fresh: f }) => (fresh.push(`${was} -> ${f.proposalNumber} ${f.referenceDate} ${f.transactionNo || "-"} ${f.customerId || "-"}`), true);
  deps.kyc = async (driver, data, how, o) => {
    await o.onModified({}); // a page without the block: the saved proposal kept
    await o.onModified({ proposalNumber: "202611141761445", referenceDate: "14/11/2026", transactionNo: "GC202611140155999999", customerId: "23676065442" });
    return { said: [] };
  };
  const { opts } = handlerOptions({}, deps);
  const { lines, ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      assert.match(e.message, / - proposal 202611141761445 of 14\/11\/2026$/, "the stop names the fresh proposal");
      if (typeof e.acknowledge === "function") e.acknowledge();
      return true;
    });
  });
  assert.deepEqual(dates, ["202611131393359 14/11/2026"], "the list's moved date, for the same number");
  assert.deepEqual(fresh, ["202611131393359 -> 202611141761445 14/11/2026 GC202611140155999999 23676065442"]);
  assert.ok(lines.some((l) => /the page after Modify shows no proposal number and Reference Date - proposal 202611131393359 of 14\/11\/2026 is kept/.test(l)));
  assert.ok(lines.some((l) => /📄 United India - after Modify the page shows proposal 202611141761445 of 14\/11\/2026 \(a NEW number - it was 202611131393359\) - saved on the policy/.test(l)));

  // a write that fails is said, never a failure
  const deps2 = resumeDeps({ skipProposal: true, proposalNumber: "202611131393359", referenceDate: "13/11/2026", startAt: "kyc" }, []);
  deps2.saveFresh = async () => false;
  deps2.kyc = async (driver, data, how, o) => {
    await o.onModified({ proposalNumber: "202611131393359", referenceDate: "14/11/2026" });
    return { said: [] };
  };
  const second = handlerOptions({}, deps2);
  const run2 = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(second.opts.body(run2.ctx), (e) => {
      if (typeof e.acknowledge === "function") e.acknowledge();
      return require("../automationStopper").isAutomationStop(e);
    });
  });
  assert.ok(run2.lines.some((l) => /⚠️ United India - after Modify the page shows proposal 202611131393359 of 14\/11\/2026 - it could not be saved on the policy, correct it in Edit -> Status/.test(l)));
});

test("United India's Error In Data Entry box the FIRST time (its wrong '(0)null'): the save-free steps once more, the page opened again by its address; the SECOND time = [E306]", async () => {
  const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");
  const boom = () => nav.portalDataError("Next", ["(0)null"], "united-india-proposal-modification");
  const plan = { skipProposal: true, proposalNumber: "202611131375485", referenceDate: "13/11/2026", startAt: "kyc" };
  for (const [times, wantStop] of [
    [1, true],
    [2, false],
  ]) {
    const calls = [];
    const deps = resumeDeps(plan, calls);
    deps.openModification = async (driver, o) => (calls.push(`openModification ${o.directUrl || "menu"}`), { url: "https://uiic/proposalModification.do?parameter=proposalModify" });
    let failures = times;
    deps.openSaved = async () => {
      calls.push("openSaved");
      if (failures-- > 0) throw boom();
      return {};
    };
    const { opts } = handlerOptions({}, deps);
    const { lines, ctx } = handlerCtx();
    await withEnv({ BREAKER_ENABLED: "false" }, async () => {
      await assert.rejects(opts.body(ctx), (e) => {
        if (wantStop) {
          assert.ok(require("../automationStopper").isAutomationStop(e), e.message);
          if (typeof e.acknowledge === "function") e.acknowledge();
        } else {
          assert.equal(e.code, "E306");
          assert.equal(e.retryable, false);
          assert.match(e.message, /after "Next" the portal says "Error In Data Entry - \(0\)null" a second time \(the run had done it all once more\), so the run stopped there/);
        }
        return true;
      });
    });
    assert.deepEqual(calls.slice(1, 5), ["openModification menu", "openSaved", "openModification https://uiic/proposalModification.do?parameter=proposalModify", "openSaved"]);
    assert.ok(lines.some((l) => /⚠️ United India - after "Next" the portal said "Error In Data Entry - \(0\)null" - it sometimes shows a wrong error, so the proposal is opened from Proposal Modification and filled once more/.test(l)));
    if (wantStop) assert.ok(calls.includes("kyc modify=true ifShown=false"), "then on to the KYC");
    else assert.ok(!calls.some((c) => c.startsWith("kyc")), "nothing after the second box");
  }
});

test("a new proposal: the box the first time = the form once more from Make New/Renew Policy by its address; other errors are never redone", async () => {
  const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");
  const calls = [];
  const deps = resumeDeps(null, calls);
  deps.openMenu = async (driver, o) => (calls.push(`openMenu ${o.directUrl || "menu"}`), { url: "https://uiic/MenuAction.do?method=strbtn" });
  let once = 1;
  deps.compute = async () => {
    calls.push("compute");
    if (once-- > 0) throw nav.portalDataError("Compute Premium", ["N002219, PolicyInception Date should be on or later to Proposal Date ."], "united-india-premium");
  };
  const { opts } = handlerOptions({}, deps);
  const { lines, ctx } = handlerCtx();
  await withEnv({ BREAKER_ENABLED: "false" }, async () => {
    await assert.rejects(opts.body(ctx), (e) => {
      if (typeof e.acknowledge === "function") e.acknowledge();
      return require("../automationStopper").isAutomationStop(e);
    });
  });
  assert.deepEqual(calls.filter((c) => c.startsWith("openMenu") || c === "compute"), ["openMenu menu", "compute", "openMenu https://uiic/MenuAction.do?method=strbtn", "compute"]);
  assert.ok(lines.some((l) => /so the form is filled from the start once more/.test(l)));
  assert.ok(calls.includes("proposal"), "on to Update after the second try");

  // an ordinary failure ([E301]) is not redone
  const calls2 = [];
  const deps2 = resumeDeps(null, calls2);
  deps2.compute = async () => {
    calls2.push("compute");
    throw Object.assign(new Error("[E301] United India - Compute Premium is not on the page"), { code: "E301" });
  };
  const second = handlerOptions({}, deps2);
  await assert.rejects(second.opts.body(handlerCtx().ctx), /E301/);
  assert.equal(calls2.filter((c) => c === "compute").length, 1);
});

test("after Save, United India's 'Offline data saved successfully' (the owner's live page) words the stop", async () => {
  const { handler } = handlerOptions();
  assert.match(
    handler.kycWords({ kycDone: true, doneBy: "saved", result: "Offline data saved successfully", stepSaved: true, closed: "button" }),
    /Save pressed - the KYC is done \(United India says "Offline data saved successfully"\), KYC step = completed, the CKYC window closed; what comes after the KYC is not built yet$/
  );
});
