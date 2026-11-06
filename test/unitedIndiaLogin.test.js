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
function handlerOptions(data = {}, deps = { openMenu: async () => ({ url: "menu-faked" }), chooseProduct: async () => ({ product: "Liability Only Policy" }), fillRisk: async () => ({}) }) {
  require("../breaker"); // the global Breaker, as runHandler loads it
  const runHandlerPath = require.resolve("../multiCompany/common/runHandler");
  const handlerPath = require.resolve("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP");
  const saved = require.cache[runHandlerPath];
  delete require.cache[handlerPath];
  require.cache[runHandlerPath] = { id: runHandlerPath, filename: runHandlerPath, loaded: true, exports: { runHandler: (opts) => opts } };
  try {
    const { fillUnitedIndiaTP, NOT_BUILT } = require(handlerPath);
    return { opts: fillUnitedIndiaTP(data, deps), NOT_BUILT };
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
    ],
    "the menu, the product, then Risk Details (with the job data), on the logged-in browser - before the Breaker"
  );
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
      assert.equal(e.message, NOT_BUILT);
      const result = stoppedResult(e);
      assert.equal(result.retryable, false);
      assert.equal(result.stage, "risk-details");
      assert.match(NOT_BUILT, /New Vehicle, Chassis, Engine Number, Vehicle Manufacturer and Make entered/);
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
