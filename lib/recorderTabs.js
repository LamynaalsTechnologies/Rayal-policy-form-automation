/**
 * Which tab the job recorder should be filming — and the pieces to film it
 * over plain DevTools sockets, without sending the automation's WebDriver
 * session a single command.
 *
 * Why this exists: Selenium's createCDPConnection("page") attaches to the FIRST
 * page of the browser, for good. When a portal opens a KYC link in a new tab
 * the automation switches to it, but the screencast stayed on the old tab —
 * the video showed a page nobody was touching while the KYC work happened
 * somewhere it could not see.
 *
 * What it relies on (checked against Chrome 150 + chromedriver, headed and
 * headless): a WebDriver window handle IS the DevTools target id, and when the
 * driver switches window Chrome makes that tab `visible` and every other tab
 * of the window `hidden`. So the tab the automation is working in is the one
 * whose document.visibilityState is "visible" — readable over the DevTools
 * port, which is NOT the WebDriver pipeline. (Asking the driver instead
 * — getWindowHandle — is not safe: with an alert open chromedriver answers
 * a command by dismissing it, and the KYC / CDT steps read those alerts.)
 *
 * Everything here is either pure (pickTarget, describeTab, offsetFor) or takes
 * its HTTP / WebSocket pieces as arguments, so it is testable without a browser.
 */

const http = require("http");

/**
 * Of the open pages, which one should be recorded?
 *
 *   - exactly one visible page      -> that one
 *   - several visible (separate windows) -> the one with focus, else the one
 *     already being recorded, else the newest (/json/list is newest-first)
 *   - none visible / nothing known  -> keep what is being recorded
 *
 * @param {Array<{id:string, visibility?:string, hasFocus?:boolean}>} pages newest first
 * @param {string|null} currentId the target being recorded now
 * @returns {string|null} target id, or null when there are no pages at all
 */
function pickTarget(pages, currentId) {
  const list = Array.isArray(pages) ? pages.filter((p) => p && p.id) : [];
  if (list.length === 0) return null;

  const visible = list.filter((p) => p.visibility === "visible");
  if (visible.length === 1) return visible[0].id;
  if (visible.length > 1) {
    const focused = visible.find((p) => p.hasFocus);
    if (focused) return focused.id;
    const current = visible.find((p) => p.id === currentId);
    return (current || visible[0]).id;
  }

  if (currentId && list.some((p) => p.id === currentId)) return currentId;
  return list[0].id;
}

/**
 * A short, safe label for a tab, for the "jump to" options beside the video.
 * Hostname only — never the full URL, which on a KYC page can be a presigned
 * link with a token in it.
 *
 * @returns {{label:string, host:string, kyc:boolean}}
 */
function describeTab({ title, url } = {}) {
  let host = "";
  let pathPart = "";
  try {
    const u = new URL(url);
    host = u.hostname;
    pathPart = u.pathname;
  } catch {
    /* about:blank, data:, chrome-error: ... — no host */
  }
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  const kyc = /kyc/i.test(`${cleanTitle} ${host} ${pathPart}`);
  const label = (cleanTitle || host || "New tab").slice(0, 80);
  return { label, host, kyc };
}

/**
 * Where in the finished video a moment falls. The stitcher gives every frame a
 * duration (real gaps, clamped), so wall-clock time and video time differ once
 * a stall was clamped — chapters are stored in wall time and converted here.
 *
 * @param {Array<{t:number}>} frames in capture order
 * @param {number[]} durations seconds each frame is shown (same length as frames)
 * @param {number} atWallMs a wall-clock time (Date.now() scale)
 * @returns {number} seconds from the start of the video
 */
function offsetFor(frames, durations, atWallMs) {
  let seconds = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].t >= atWallMs) break;
    seconds += durations[i] || 0;
  }
  return Math.round(seconds * 10) / 10;
}

/** GET /json/list from the DevTools port: the open pages, newest first. */
function listPages(debuggerAddress, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: String(debuggerAddress).split(":").pop(), path: "/json/list", timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(
              JSON.parse(body)
                .filter((t) => t && t.type === "page" && t.webSocketDebuggerUrl)
                .map((t) => ({ id: t.id, title: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl }))
            );
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("devtools /json/list timed out")));
    req.on("error", reject);
  });
}

/**
 * One DevTools socket to one page. Small on purpose: send() with a timeout,
 * a frame callback, close(). `WebSocketImpl` is injectable for tests.
 */
class PageSocket {
  constructor(wsUrl, { WebSocketImpl = require("ws"), onFrame, onClose } = {}) {
    this.wsUrl = wsUrl;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.ws = new WebSocketImpl(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", (e) => {
        reject(e);
        this._end();
      });
    });
    this.ready.catch(() => {}); // surfaced to whoever awaits it; never unhandled
    this.ws.on("message", (raw) => this._message(raw));
    this.ws.on("close", () => this._end());
  }

  _message(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      resolve(msg);
      return;
    }
    if (msg.method === "Page.screencastFrame" && msg.params) {
      // Ack at once or Chrome stops sending frames.
      this.fire("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
      if (this.onFrame) this.onFrame(Buffer.from(msg.params.data, "base64"));
    }
  }

  _end() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("devtools socket closed"));
    }
    this.pending.clear();
    if (this.onClose) this.onClose();
  }

  /** Send and forget. */
  fire(method, params = {}) {
    if (this.closed) return;
    try {
      this.ws.send(JSON.stringify({ id: this.nextId++, method, params }));
    } catch {
      /* the page is going away */
    }
  }

  /** Send and wait for the answer message. */
  send(method, params = {}, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("devtools socket closed"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** document.visibilityState / hasFocus of this page, or null if unreadable. */
  async visibility() {
    try {
      const res = await this.send("Runtime.evaluate", {
        expression: 'document.visibilityState + "|" + document.hasFocus()',
        returnByValue: true,
      });
      const value = res && res.result && res.result.result && res.result.result.value;
      if (typeof value !== "string") return null;
      const [visibility, focus] = value.split("|");
      return { visibility, hasFocus: focus === "true" };
    } catch {
      return null;
    }
  }

  close() {
    if (this.closed) return;
    try {
      this.ws.close();
    } catch {}
    this._end();
  }
}

module.exports = { pickTarget, describeTab, offsetFor, listPages, PageSocket };
