// United India: every error AND every stop leaves a screenshot of the page (the owner, 2026-11-13). runHandler is run with
// its browser, login and screenshot replaced by fakes (no Chrome, no S3); the popup retry is run on a fake driver.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaScreenshots.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const R = (p) => require.resolve(path.join(ROOT, p));

/** runHandler with its outside world faked. Returns { runHandler, shots } - shots = every captureFailure call. */
function fakedRunHandler() {
  const shots = [];
  const fakes = {
    "multiCompany/common/featureGate": { assertMultiCompanyEnabled: () => {} },
    "multiCompany/common/browser": { openJobBrowser: async () => ({ driver: { fake: true } }), closeJobBrowser: async () => {} },
    "multiCompany/common/login": { login: async () => {} },
    "multiCompany/common/screenshot": {
      captureFailure: async (driver, ctx) => {
        shots.push(ctx);
        return { screenshotUrl: `https://s3.example/${ctx.jobId}.png`, screenshotKey: `${ctx.jobId}.png` };
      },
    },
    "lib/jobRecorder": { startRecording: () => {} },
  };
  const saved = {};
  for (const [p, exports] of Object.entries(fakes)) {
    const id = R(p);
    saved[id] = require.cache[id];
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const handlerId = R("multiCompany/common/runHandler");
  delete require.cache[handlerId];
  const { runHandler } = require(handlerId);
  const restore = () => {
    for (const [id, mod] of Object.entries(saved)) {
      if (mod) require.cache[id] = mod;
      else delete require.cache[id];
    }
    delete require.cache[handlerId];
  };
  return { runHandler, shots, restore };
}

const quiet = async (fn) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
};

const { stopper, AutomationStoppedError } = require("../automationStopper");
const { HOLD_STOP_STAGE } = require("../lib/holdStop");

test("United India: a deliberate stop (the Breaker, 'not built yet') saves a screenshot on the stop's result", async () => {
  const { runHandler, shots, restore } = fakedRunHandler();
  try {
    const result = await quiet(() =>
      runHandler({
        company: "united india",
        policyType: "tp",
        data: { firstName: "A", _attemptNumber: 2 },
        screenshotOnStop: true,
        body: async () => stopper("the rest of the TP form is not built yet", { stage: "risk-details" }),
      })
    );
    assert.equal(result.inProgress, true, "still a calm stop, not a failure");
    assert.equal(result.retryable, false);
    assert.equal(shots.length, 1, "one picture");
    assert.equal(shots[0].company, "united india");
    assert.equal(shots[0].attempt, 2);
    assert.match(result.screenshotUrl, /^https:\/\/s3\.example\/tp_united india_A_\d+\.png$/);
    assert.ok(result.screenshotKey);
  } finally {
    restore();
  }
});

test("United India: a failure still saves its screenshot (unchanged)", async () => {
  const { runHandler, shots, restore } = fakedRunHandler();
  try {
    const result = await quiet(() =>
      runHandler({
        company: "united india",
        policyType: "tp",
        data: { firstName: "A" },
        screenshotOnStop: true,
        body: async () => {
          throw new Error("boom");
        },
      })
    );
    assert.equal(result.success, false);
    assert.equal(shots.length, 1);
    assert.ok(result.screenshotUrl);
  } finally {
    restore();
  }
});

test("a Hold is the operator's own choice: no screenshot, even for United India", async () => {
  const { runHandler, shots, restore } = fakedRunHandler();
  try {
    const result = await quiet(() =>
      runHandler({
        company: "united india",
        policyType: "tp",
        data: { firstName: "A" },
        screenshotOnStop: true,
        body: async () => {
          throw new AutomationStoppedError("Held by the operator", { stage: HOLD_STOP_STAGE });
        },
      })
    );
    assert.equal(result.inProgress, true);
    assert.equal(shots.length, 0);
    assert.equal(result.screenshotUrl, undefined);
  } finally {
    restore();
  }
});

test("the other companies' stops are unchanged: no screenshot without screenshotOnStop", async () => {
  const { runHandler, shots, restore } = fakedRunHandler();
  try {
    const result = await quiet(() =>
      runHandler({ company: "reliance", policyType: "od", data: {}, body: async () => stopper("calm stop", { stage: "x" }) })
    );
    assert.equal(result.inProgress, true);
    assert.equal(shots.length, 0);
    assert.equal(result.screenshotUrl, undefined);
  } finally {
    restore();
  }
});

test("the United India handler turns the stop screenshot on", () => {
  const src = require("fs").readFileSync(R("multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP.js"), "utf8");
  assert.match(src, /screenshotOnStop: true,/);
});

/* ------------------------------------------- a popup open at the picture ------------------------------------------- */

const { takePicture, isPopupError } = require("../multiCompany/common/screenshot");

/** A driver whose first takeScreenshot meets an open alert (Chrome closes it as it says so), the second works. */
function popupDriver({ popupTimes = 1, otherError = null } = {}) {
  const calls = { shots: 0, dismissed: 0 };
  return {
    calls,
    async takeScreenshot() {
      calls.shots += 1;
      if (otherError) throw otherError;
      if (calls.shots <= popupTimes) {
        const e = new Error("unexpected alert open: {Alert text : Please select the RTA}");
        e.name = "UnexpectedAlertOpenError";
        throw e;
      }
      return "PNGBASE64";
    },
    switchTo: () => ({
      alert: () => ({
        dismiss: async () => {
          calls.dismissed += 1;
        },
      }),
    }),
  };
}

test("a portal popup open at the screenshot: closed, then the picture is taken ONCE more", async () => {
  const driver = popupDriver();
  const warn = console.warn;
  const said = [];
  console.warn = (l) => said.push(String(l));
  try {
    assert.equal(await takePicture(driver), "PNGBASE64");
  } finally {
    console.warn = warn;
  }
  assert.equal(driver.calls.shots, 2);
  assert.equal(driver.calls.dismissed, 1);
  assert.ok(said.some((l) => /a portal popup was open at the screenshot \("Please select the RTA"\)/.test(l)));
});

test("only once more: a popup that keeps coming back gives up (captureFailure then returns no picture, never throws)", async () => {
  const driver = popupDriver({ popupTimes: 5 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(takePicture(driver));
  } finally {
    console.warn = warn;
  }
  assert.equal(driver.calls.shots, 2);
});

test("any other screenshot error is not retried", async () => {
  const driver = popupDriver({ otherError: new Error("no such window") });
  await assert.rejects(takePicture(driver), /no such window/);
  assert.equal(driver.calls.shots, 1);
  assert.equal(isPopupError(new Error("no such window")), false);
  assert.equal(isPopupError(Object.assign(new Error("x"), { name: "UnexpectedAlertOpenError" })), true);
});

test("captureFailure with a popup open uploads the second picture", async () => {
  const s3Path = R("s3Uploader");
  const shotPath = R("multiCompany/common/screenshot");
  const savedS3 = require.cache[s3Path];
  const uploads = [];
  require.cache[s3Path] = {
    id: s3Path,
    filename: s3Path,
    loaded: true,
    exports: {
      generateScreenshotKey: (jobId, attempt, folder) => `${folder}/${jobId}.png`,
      uploadScreenshotToS3: async (b64, key) => {
        uploads.push(b64);
        return `https://s3.example/${key}`;
      },
    },
  };
  delete require.cache[shotPath];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { captureFailure } = require(shotPath);
    const out = await captureFailure(popupDriver(), { company: "united india", jobId: "j1" });
    assert.deepEqual(uploads, ["PNGBASE64"]);
    assert.equal(out.screenshotUrl, "https://s3.example/multiCompany/united_india/j1.png");
  } finally {
    console.warn = warn;
    if (savedS3) require.cache[s3Path] = savedS3;
    else delete require.cache[s3Path];
    delete require.cache[shotPath];
  }
});
