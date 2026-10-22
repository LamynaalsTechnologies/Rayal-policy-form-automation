/**
 * A run that stops moving is stopped with an error after STALL_LIMIT_MS (the owner, 2026-10-22: "the Reliance site has an
 * issue, the automation freezes on a field - wait 1.5 minutes for the step, then make an error, for all companies").
 *
 * WHAT "moving" MEANS: the run prints a line. Every flow prints one per step ("Filling engine number...", "Clicking 'Get
 * Coverage Details' button..."), and the long legitimate waits print while they wait (the Reliance KYC waits say
 * "still waiting" every 15 s and keep their own 2-minute limit that way). A run that prints nothing for 1.5 minutes is
 * stuck - a frozen page, or a wait that never ends.
 *   Lines are counted per run: the job runs inside run(key, fn) (an AsyncLocalStorage, like lib/flowLogPrefix.js) and
 *   console.* is wrapped once (install) to note "this run printed something". Two parallel runs never count each other's.
 *
 * WHAT HAPPENS when it is stuck (fire):
 *   1. a picture of the stuck page is taken and uploaded (screenshots/stalled/...), at most PHOTO_WAIT_MS;
 *   2. every further browser command of this run fails with the E309 error, so a wait loop unwinds at once and the
 *      form's own error path reports it (closing the window and taking a picture still pass through);
 *   3. a browser command that is itself frozen never returns - after QUIT_AFTER_MS the frozen tabs are closed through
 *      Chrome's own DevTools port (it answers even while the page's script is stuck; chromedriver does not - its quit
 *      waits behind the frozen command, seen on a real Chrome 2026-10-22), then quit: the command fails, the run unwinds;
 *   4. if even that does not end the run, guard() gives up after GIVE_UP_MS and reports the error itself.
 * The error is retryable ([E309]): the queue tries again later like any temporary portal failure. A run that already
 * saved its proposal is NOT re-run automatically (partRunner treats it like its own timeout).
 *
 * NEVER after the payment point: stopIfHeld(data, "before the payment" / "before Pay") switches the watch off for the
 * rest of the run (lib/holdStop.js), exactly as for Hold - a payment in flight must finish and be recorded.
 *
 * Armed / disarmed through lib/holdStop.js (armLiveHold / disarmLiveHold), which every browser flow already calls right
 * after its window opens and before its cleanup - so every insurer has it without touching each form. A fixed rule, not
 * an .env switch (the owner's working agreement).
 */
const { AsyncLocalStorage } = require("node:async_hooks");
const util = require("node:util");

const STALL_LIMIT_MS = 90 * 1000;
const CHECK_EVERY_MS = 5000;
const PHOTO_WAIT_MS = 15000;
const QUIT_AFTER_MS = 20000;
const GIVE_UP_MS = 45000;
const STALL_CODE = "E309";
// Still allowed once stuck: closing the window, a picture, where the page is (the error path reads them).
const PASS_THROUGH = new Set(["quit", "close", "screenshot", "takeElementScreenshot", "getCurrentUrl", "getTitle"]);

const store = new AsyncLocalStorage();
const runs = new Map(); // key -> state
let installed = false;

const noColon = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").replace(/\s*:\s*/g, " - ").trim();
const keyOf = (dataOrKey) => {
  if (dataOrKey && typeof dataOrKey === "object" && !Buffer.isBuffer(dataOrKey)) return dataOrKey._jobId ? String(dataOrKey._jobId) : "";
  return dataOrKey ? String(dataOrKey) : "";
};

function freshState(key) {
  return {
    key,
    lastProgressAt: Date.now(),
    lastLine: "",
    driver: null,
    original: null,
    hadOwn: false,
    patched: null,
    timer: null,
    watching: false,
    fired: null,
    photo: null,
    listeners: new Set(),
  };
}

/** The line, short and without the flow tag or colons, for the error sentence. */
function shortLine(args) {
  let text;
  try {
    text = util.format(...args);
  } catch (e) {
    text = String(args[0]);
  }
  text = text.replace(/\u001b\[[0-9;]*m/g, "").replace(/^[A-Za-z]+ [A-Z+]+\s*\|\s*/, "").trim();
  return noColon(text).slice(0, 140);
}

/** Note that the run in scope printed something. */
function touch(args) {
  const key = store.getStore();
  if (!key) return;
  const state = runs.get(key);
  if (!state) return;
  state.lastProgressAt = Date.now();
  const line = shortLine(args);
  if (line) state.lastLine = line;
}

/** Wrap console.* once so every line printed inside run() counts as progress. Safe to call twice. */
function install(target = console) {
  if (installed) return;
  installed = true;
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const previous = target[method];
    if (typeof previous !== "function") continue;
    target[method] = function stallWatchConsole(...args) {
      try {
        touch(args);
      } catch (e) {
        /* counting must never break printing */
      }
      return previous.apply(this, args);
    };
  }
}

/** Run one job attempt with its lines counted under `key` (the job id). A fresh count each attempt. */
function run(key, fn) {
  const k = keyOf(key);
  if (!k) return fn();
  runs.set(k, freshState(k));
  if (runs.size > 500) runs.delete(runs.keys().next().value);
  return store.run(k, fn);
}

/** Print without counting it as progress (the watch's own lines). */
const quietLog = (method, ...args) => store.exit(() => console[method](...args));

function stallError(state, limitMs) {
  const after = state.lastLine ? ` after "${state.lastLine}"` : "";
  const err = new Error(
    `[${STALL_CODE}] The step did not finish in ${Math.round(limitMs / 6000) / 10} minutes${after} - the portal stopped responding, so this run was stopped. It will be tried again`
  );
  err.name = "StepStalledError";
  err.stalled = true;
  return err;
}

/**
 * Start watching the run's browser (from armLiveHold). `opts` are test seams: limitMs, checkEveryMs, now, setInterval,
 * clearInterval, setTimeout, upload(base64, data) -> {screenshotUrl, screenshotKey}, log.
 */
function arm(driver, data, opts = {}) {
  const key = keyOf(data);
  if (!key || !driver || typeof driver.execute !== "function") return false;
  let state = runs.get(key);
  if (!state) {
    // armed outside run() (a test, or a caller that did not wrap): still watch, counting nothing but its own clock
    state = freshState(key);
    runs.set(key, state);
  }
  if (state.watching) return true;
  const now = opts.now || Date.now;
  const limitMs = opts.limitMs || STALL_LIMIT_MS;
  const timers = {
    every: opts.setInterval || setInterval,
    stop: opts.clearInterval || clearInterval,
    later: opts.setTimeout || setTimeout,
  };

  state.driver = driver;
  state.stopTimer = timers.stop;
  state.closePages = opts.closePages || closeAllPages;
  state.debuggerAddress = null;
  // where Chrome's DevTools port is (read now, while the browser answers - it is kept from the session's start)
  Promise.resolve()
    .then(() => (typeof driver.getCapabilities === "function" ? driver.getCapabilities() : null))
    .then((caps) => {
      const o = caps && typeof caps.get === "function" ? caps.get("goog:chromeOptions") : null;
      state.debuggerAddress = (o && o.debuggerAddress) || null;
    })
    .catch(() => {});
  state.lastProgressAt = now();
  state.hadOwn = Object.prototype.hasOwnProperty.call(driver, "execute");
  state.original = driver.execute;
  state.patched = function stallWatchExecute(command, ...rest) {
    if (state.fired) {
      const name = command && typeof command.getName === "function" ? command.getName() : "";
      if (!PASS_THROUGH.has(name)) return Promise.reject(state.fired);
    }
    return state.original.call(this, command, ...rest);
  };
  driver.execute = state.patched;
  state.watching = true;

  state.timer = timers.every(() => {
    if (!state.watching || state.fired) return;
    if (now() - state.lastProgressAt < limitMs) return;
    fire(state, data, { limitMs, timers, upload: opts.upload, log: opts.log });
  }, opts.checkEveryMs || CHECK_EVERY_MS);
  if (state.timer && state.timer.unref) state.timer.unref();
  return true;
}

async function fire(state, data, { limitMs, timers, upload, log }) {
  state.fired = stallError(state, limitMs);
  const say = log || ((line) => quietLog("warn", line));
  say(`⏱️  Nothing happened for ${Math.round(limitMs / 1000)} s${state.lastLine ? ` after "${state.lastLine}"` : ""} - stopping this run with an error`);
  for (const fn of state.listeners) {
    try {
      fn(state.fired);
    } catch (e) {
      /* a listener never stops the stop */
    }
  }

  // 1. the picture (a frozen page may not even answer this - bounded)
  try {
    const shot = await Promise.race([
      Promise.resolve(state.driver.takeScreenshot()),
      new Promise((resolve) => timers.later(() => resolve(null), PHOTO_WAIT_MS)),
    ]);
    if (shot) state.photo = await (upload || defaultUpload)(shot, data);
  } catch (e) {
    /* no picture - the error still stands */
  }

  // 3. a frozen command: close the window so it fails and the run unwinds
  timers.later(() => {
    if (!state.watching) return; // the run already unwound and cleaned up
    say("⏱️  The page is frozen - closing the window so the run can stop");
    Promise.resolve()
      .then(() => state.closePages(state.debuggerAddress))
      .catch(() => {})
      .then(() => state.driver.quit())
      .catch(() => {});
  }, QUIT_AFTER_MS);
}

/** Close every page of the browser through its DevTools port (works while a page's script is stuck). Never throws. */
async function closeAllPages(debuggerAddress) {
  if (!debuggerAddress) return 0;
  const http = require("http");
  const { listPages } = require("./recorderTabs");
  const port = String(debuggerAddress).split(":").pop();
  let pages = [];
  try {
    pages = await listPages(debuggerAddress, { timeoutMs: 3000 });
  } catch (e) {
    return 0;
  }
  let closed = 0;
  for (const page of pages) {
    await new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: `/json/close/${page.id}`, timeout: 3000 }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("timeout", () => req.destroy());
      req.on("error", resolve);
      req.on("close", resolve);
    });
    closed++;
  }
  return closed;
}

async function defaultUpload(base64, data) {
  const { uploadScreenshotToS3, generateScreenshotKey } = require("../s3Uploader");
  const screenshotKey = generateScreenshotKey(
    String((data && (data._jobIdentifier || data._jobId)) || "job"),
    (data && data._attemptNumber) || 1,
    "stalled"
  );
  const screenshotUrl = await uploadScreenshotToS3(base64, screenshotKey);
  return { screenshotUrl, screenshotKey };
}

/** The payment point: never stop this run from here on (the patch stays, but nothing fires). */
function pause(data) {
  const state = runs.get(keyOf(data));
  if (!state || !state.timer) return;
  (state.stopTimer || clearInterval)(state.timer);
  state.timer = null;
}

/** The run is cleaning up: stop watching and give the driver its own execute back when ours is on top. */
function disarm(data) {
  const state = runs.get(keyOf(data));
  if (!state) return;
  if (state.timer) (state.stopTimer || clearInterval)(state.timer);
  state.timer = null;
  state.watching = false;
  try {
    if (state.driver && state.driver.execute === state.patched) {
      if (state.hadOwn) state.driver.execute = state.original;
      else delete state.driver.execute;
    }
  } catch (e) {
    /* the driver is going away anyway */
  }
}

/** The stall error of this run (job id or data), or null. */
function stalledOf(keyOrData) {
  const state = runs.get(keyOf(keyOrData));
  return (state && state.fired) || null;
}

/**
 * The run's promise, or - once it is stuck and has still not ended GIVE_UP_MS later - the stall error (a frozen
 * chromedriver can keep even quit from returning). Put it in the same Promise.race as the job timeout.
 */
function guard(key, runPromise, { giveUpMs = GIVE_UP_MS, setTimeout: later = setTimeout } = {}) {
  const k = keyOf(key);
  const state = k && runs.get(k);
  if (!state) return runPromise;
  return new Promise((resolve, reject) => {
    let timer = null;
    const listener = (error) => {
      timer = later(() => reject(error), giveUpMs);
      if (timer && timer.unref) timer.unref();
    };
    state.listeners.add(listener);
    if (state.fired) listener(state.fired);
    Promise.resolve(runPromise).then(
      (value) => {
        state.listeners.delete(listener);
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        state.listeners.delete(listener);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * A failed result of a run that was stopped as stuck says so - whatever the form made of the closed window ("invalid
 * session id" ...) - and carries the stuck page's picture when the form had none. Anything else is returned untouched.
 */
function applyToResult(key, result) {
  const state = runs.get(keyOf(key));
  if (!state || !state.fired || !result || result.success) return result;
  const photo = state.photo || {};
  return {
    ...result,
    error: state.fired.message,
    errorCode: STALL_CODE,
    screenshotUrl: result.screenshotUrl || photo.screenshotUrl || null,
    screenshotKey: result.screenshotKey || photo.screenshotKey || null,
  };
}

/** A thrown error of a stuck run (the guard's, or the form's own) carries the picture too. */
function photoOf(key) {
  const state = runs.get(keyOf(key));
  return (state && state.photo) || null;
}

const isStallError = (e) => !!(e && (e.stalled || new RegExp(`\\[${STALL_CODE}\\]`).test(String(e.message || e))));

module.exports = {
  STALL_LIMIT_MS,
  STALL_CODE,
  install,
  run,
  arm,
  pause,
  disarm,
  guard,
  applyToResult,
  stalledOf,
  photoOf,
  isStallError,
  // tests
  _runs: runs,
  _touch: touch,
  _store: store,
};
