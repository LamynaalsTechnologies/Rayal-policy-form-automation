// Run with: node --require ./test/support/noRealWorld.js --test test/recorderTabs.test.js
//
// The job recorder follows the tab the automation is working in (lib/recorderTabs.js + lib/jobRecorder.js).
//
// The bug (2026-10-15): a portal opened the KYC link in a new tab, the automation switched to it, and the video kept
// filming the OLD tab — Selenium's createCDPConnection("page") attaches to the first page for good. A second cause:
// the recorder stopped itself after 7 minutes while a job may run 15, so a slow run's KYC step was never filmed.
//
// No real browser: a local fake DevTools endpoint (HTTP /json/list + one WebSocket per page) stands in for Chrome.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const TABS = path.join(ROOT, "lib", "recorderTabs.js");
const RECORDER = path.join(ROOT, "lib", "jobRecorder.js");
const { pickTarget, describeTab, offsetFor } = require(TABS);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(25);
  }
  return false;
};

/* ------------------------------ pickTarget ------------------------------ */

test("pickTarget: the one visible tab wins, wherever it is in the list", () => {
  const pages = [
    { id: "kyc", visibility: "visible", hasFocus: false },
    { id: "main", visibility: "hidden", hasFocus: false },
  ];
  assert.equal(pickTarget(pages, "main"), "kyc");
  assert.equal(pickTarget([...pages].reverse(), "kyc"), "kyc");
});

test("pickTarget: two visible windows -> focus, then the one already recorded, then the newest", () => {
  const two = (a, b) => [
    { id: "new", visibility: "visible", ...a },
    { id: "old", visibility: "visible", ...b },
  ];
  assert.equal(pickTarget(two({ hasFocus: false }, { hasFocus: true }), "new"), "old");
  assert.equal(pickTarget(two({ hasFocus: false }, { hasFocus: false }), "old"), "old");
  assert.equal(pickTarget(two({ hasFocus: false }, { hasFocus: false }), null), "new");
});

test("pickTarget: nothing visible or unreadable keeps the current tab; a gone tab falls back to the newest", () => {
  const hidden = [
    { id: "a", visibility: "hidden" },
    { id: "b" }, // probe failed mid-navigation
  ];
  assert.equal(pickTarget(hidden, "b"), "b");
  assert.equal(pickTarget(hidden, "closed"), "a");
  assert.equal(pickTarget([], "a"), null);
});

/* ------------------------------ describeTab ----------------------------- */

test("describeTab: a label from the title, host only, KYC recognised, no URL leaked", () => {
  const d = describeTab({
    title: "Customer KYC  Verification",
    url: "https://kyc.example.com/upload?token=SECRET&X-Amz-Signature=abc",
  });
  assert.equal(d.label, "Customer KYC Verification");
  assert.equal(d.host, "kyc.example.com");
  assert.equal(d.kyc, true);
  assert.ok(!JSON.stringify(d).includes("SECRET"));
});

test("describeTab: a blank tab is just 'New tab', not KYC", () => {
  assert.deepEqual(describeTab({ title: "", url: "about:blank" }), { label: "New tab", host: "", kyc: false });
});

/* ------------------------------ offsetFor ------------------------------- */

test("offsetFor: video time is the sum of the frame durations before the moment, not wall time", () => {
  const frames = [{ t: 1000 }, { t: 2000 }, { t: 12000 }, { t: 13000 }];
  const durations = [1, 5, 1, 1]; // the 10 s stall was clamped to 5 s in the video
  assert.equal(offsetFor(frames, durations, 500), 0);
  assert.equal(offsetFor(frames, durations, 12000), 6);
  assert.equal(offsetFor(frames, durations, 12500), 7);
});

/* ------------------- the recorder against a fake Chrome ------------------ */

/** A DevTools endpoint with mutable pages. Records what each socket was asked. */
async function fakeChrome(pages) {
  const state = { pages, log: [], sockets: 0 };
  const server = http.createServer((req, res) => {
    if (req.url === "/json/list") {
      res.setHeader("content-type", "application/json");
      const port = server.address().port;
      res.end(
        JSON.stringify(
          state.pages.map((p) => ({
            id: p.id,
            type: "page",
            title: p.title,
            url: p.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${p.id}`,
          }))
        )
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    state.sockets++;
    const id = req.url.split("/").pop();
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      state.log.push({ id, method: m.method });
      const page = state.pages.find((p) => p.id === id);
      if (m.method === "Runtime.evaluate") {
        const value = `${page ? page.visibility : "hidden"}|${page ? !!page.hasFocus : false}`;
        ws.send(JSON.stringify({ id: m.id, result: { result: { type: "string", value } } }));
      } else if (m.method === "Page.captureScreenshot") {
        ws.send(JSON.stringify({ id: m.id, result: { data: Buffer.from(`SHOT-${id}`).toString("base64") } }));
      } else if (m.method === "Page.startScreencast") {
        ws.send(JSON.stringify({ id: m.id, result: {} }));
        ws.send(
          JSON.stringify({
            method: "Page.screencastFrame",
            params: { sessionId: 1, data: Buffer.from(`CAST-${id}`).toString("base64") },
          })
        );
      } else if (m.id) {
        ws.send(JSON.stringify({ id: m.id, result: {} }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    state,
    port: server.address().port,
    close: () => new Promise((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => server.close(r));
    }),
  };
}

const driverFor = (port) => ({
  async getCapabilities() {
    return { get: (k) => (k === "goog:chromeOptions" ? { debuggerAddress: `127.0.0.1:${port}` } : undefined) };
  },
  // The recorder must NOT ask the driver anything else while following: that is the WebDriver pipeline.
  getWindowHandle() { throw new Error("recorder touched WebDriver: getWindowHandle"); },
  getAllWindowHandles() { throw new Error("recorder touched WebDriver: getAllWindowHandles"); },
  takeScreenshot() { throw new Error("recorder touched WebDriver: takeScreenshot"); },
  createCDPConnection() { throw new Error("recorder fell back to the first-tab capture"); },
});

/** Fresh copy of jobRecorder with the given env (it reads its switches at load). */
function loadRecorder(env) {
  const keys = { RECORDING_ENABLED: "true", RECORDING_HEARTBEAT_MS: "60", ...env };
  const saved = {};
  for (const k of Object.keys(keys)) {
    saved[k] = process.env[k];
    if (keys[k] === undefined) delete process.env[k];
    else process.env[k] = keys[k];
  }
  delete require.cache[RECORDER];
  const mod = require(RECORDER);
  return {
    mod,
    restore() {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      delete require.cache[RECORDER];
    },
  };
}

const framesOf = (jobKey) => {
  const dir = path.join(ROOT, "recordings_tmp", jobKey, "attempt_1");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
};

test("the video moves to the KYC tab when the automation switches to it, and back again", async () => {
  const chrome = await fakeChrome([
    { id: "MAIN", title: "Reliance Portal", url: "https://main.example.com/quote", visibility: "visible" },
  ]);
  const { mod, restore } = loadRecorder({});
  const jobId = `test-follow-${process.pid}-${Date.now()}`;
  try {
    mod.startRecording(driverFor(chrome.port), jobId, 1);

    assert.ok(await until(() => framesOf(jobId).some((f) => f.endsWith("MAIN"))), "frames of the main tab");

    // The portal opens the KYC link in a new tab and the automation switches to it.
    chrome.state.pages = [
      { id: "KYC", title: "Reliance KYC", url: "https://kyc.example.com/x?t=1", visibility: "visible" },
      { ...chrome.state.pages[0], visibility: "hidden" },
    ];
    assert.ok(await until(() => framesOf(jobId).some((f) => f.endsWith("KYC"))), "frames of the KYC tab");

    // ...and the automation goes back to the main tab, the KYC tab staying open.
    chrome.state.pages = [
      { ...chrome.state.pages[0], visibility: "hidden" },
      { ...chrome.state.pages[1], visibility: "visible" },
    ];
    const before = framesOf(jobId).length;
    assert.ok(
      await until(() => framesOf(jobId).slice(before).some((f) => f.endsWith("MAIN"))),
      "frames of the main tab again"
    );

    // Only the tab in front is filmed: after the switch back nothing more arrives from the KYC socket.
    const stops = chrome.state.log.filter((l) => l.method === "Page.stopScreencast").map((l) => l.id);
    assert.ok(stops.includes("MAIN") && stops.includes("KYC"), `screencast stopped on the tab left: ${stops}`);
  } finally {
    await mod.finalizeRecording(jobId, {}); // stitching garbage fails; that path also removes the frame folder
    restore();
    await chrome.close();
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "recordings_tmp", jobId)), "frame folder cleaned up");
});

test("RECORDING_FOLLOW_TAB_ENABLED=false never opens a DevTools socket (the old first-tab capture)", async () => {
  const chrome = await fakeChrome([
    { id: "MAIN", title: "Portal", url: "https://main.example.com/", visibility: "visible" },
  ]);
  const { mod, restore } = loadRecorder({ RECORDING_FOLLOW_TAB_ENABLED: "false", RECORDING_MODE: "cdp" });
  const jobId = `test-off-${process.pid}-${Date.now()}`;
  let askedCreateCdp = 0;
  try {
    const driver = { ...driverFor(chrome.port) };
    driver.createCDPConnection = async () => {
      askedCreateCdp++;
      throw new Error("no cdp in this test");
    };
    mod.startRecording(driver, jobId, 1);
    assert.ok(await until(() => askedCreateCdp > 0), "fell through to the first-tab capture");
    assert.equal(chrome.state.sockets, 0, "no DevTools socket was opened");
  } finally {
    await mod.finalizeRecording(jobId, {});
    restore();
    await chrome.close();
  }
});

test("the recording's hard stop follows JOB_TIMEOUT_MS, so a long run's KYC step is still filmed", () => {
  const src = fs.readFileSync(RECORDER, "utf8");
  assert.match(src, /JOB_TIMEOUT_MS \+ 2 \* 60 \* 1000/);
  assert.doesNotMatch(src, /\|\| 7 \* 60 \* 1000/);
});
