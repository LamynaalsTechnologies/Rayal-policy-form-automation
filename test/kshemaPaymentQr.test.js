// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaPaymentQr.test.js
//
// fullPolicycompany/kshema/kshemaPaymentQr.js — the KSHEMA payment QR on a card of its own (2026-10-22): the QR cut out
// of the Razorpay popup, under the company's name, with its 5-minute expiry. Anything that goes wrong falls back to the
// old whole-popup picture, and the expiry is kept either way.
//
// No real browser, no S3: the driver is a fake that records what it was asked and which window/frame it ended on.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const MODULE = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaPaymentQr.js");
const mod = require(MODULE);
const { buildQrCardHtml, captureQrCard, renderQrCard, findQrElement, readQrImage, formatExpiryClock, QR_VALID_MS } = mod;

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const QR_URL = "data:image/png;base64," + "A".repeat(400);
const NOW = new Date("2026-10-22T10:30:00Z"); // 4:00 PM in India

/**
 * A driver that stands in for Selenium: `qr` is what the page's finder script returns ([element, how] or null),
 * `native` what reading the element's own pixels gives, `failRender` makes the card tab break.
 */
function fakeDriver({ qr = "found", native = null, failRender = false } = {}) {
  const calls = [];
  const state = { window: "main", frame: "razorpay" };
  const element = { takeScreenshot: async () => { calls.push("element.takeScreenshot"); return "QRPNG"; } };
  const cardEl = { takeScreenshot: async () => { calls.push("card.takeScreenshot"); return "CARDPNG"; } };
  const driver = {
    calls,
    state,
    executeScript: async (script) => {
      if (/querySelectorAll/.test(script)) return qr === "found" ? [element, "img (scan text, data image)"] : null;
      if (/toDataURL/.test(script)) return native;
      return true; // the "has the picture loaded" check
    },
    getWindowHandle: async () => state.window,
    switchTo: () => ({
      newWindow: async () => { calls.push("newWindow"); state.window = "card"; state.frame = null; },
      window: async (h) => { calls.push(`window:${h}`); state.window = h; state.frame = null; },
    }),
    get: async (url) => { calls.push("get"); driver.lastUrl = url; if (failRender) throw new Error("tab broke"); },
    wait: async (cond) => (typeof cond === "function" ? cond() : cardEl),
    close: async () => { calls.push("close"); },
  };
  return driver;
}

const recorder = () => {
  const seen = [];
  const capture = async (name, stage, image) => { seen.push({ name, stage, image }); return { screenshotUrl: "https://s3/x.png", screenshotKey: "screenshots/x.png" }; };
  return { seen, capture };
};

/* ----------------------------- the card (pure) ----------------------------- */

test("buildQrCardHtml: company name, the QR, 'Valid for 5 minutes' and the expiry clock in India time", () => {
  const html = buildQrCardHtml({ qrDataUrl: QR_URL, expiresAt: new Date(NOW.getTime() + QR_VALID_MS) });
  assert.match(html, /Kshema General Insurance/);
  assert.match(html, /Valid for 5 minutes/);
  assert.match(html, /Expires at 4:05 PM IST/);
  assert.ok(html.includes(QR_URL), "the QR is embedded in the page");
  assert.match(html, /id="frame"/);
  assert.match(html, /id="qr"/);
  assert.ok(!/<script/i.test(html) && !/https?:\/\//.test(html), "nothing to load from the network, nothing to run");
});

test("buildQrCardHtml: the name is escaped (never markup)", () => {
  const html = buildQrCardHtml({ qrDataUrl: QR_URL, expiresAt: NOW, companyName: '<b onload="x">K&Co</b>' });
  assert.ok(!html.includes('<b onload'));
  assert.match(html, /&lt;b onload=&quot;x&quot;&gt;K&amp;Co&lt;\/b&gt;/);
});

test("formatExpiryClock: India time, whatever the server's zone", () => {
  assert.equal(formatExpiryClock(new Date("2026-10-22T18:29:00Z")), "11:59 PM");
  assert.equal(formatExpiryClock(new Date("2026-10-22T18:30:00Z")), "12:00 AM");
});

/* --------------------------- finding / reading --------------------------- */

test("findQrElement: null when the page has nothing that looks like the QR", async () => {
  assert.equal(await findQrElement(fakeDriver({ qr: "none" })), null);
});

test("findQrElement: needs a SIGN of a QR - the finder script refuses a bare square picture", () => {
  const src = fs.readFileSync(MODULE, "utf8");
  assert.match(src, /if \(score === 0\) continue;/, "artwork with no QR sign must be skipped");
  assert.match(src, /scan\[/i, "the 'scan ... qr' words are one of the signs");
});

test("readQrImage: the page's own pixels when it has them, else a crop of the element", async () => {
  const d = fakeDriver({ native: "data:image/png;base64," + "B".repeat(300) });
  assert.match(await readQrImage(d, {}), /B{300}$/);
  const el = { takeScreenshot: async () => "CROP" };
  assert.equal(await readQrImage(fakeDriver({ native: null }), el), "data:image/png;base64,CROP");
});

/* ------------------------------- rendering ------------------------------- */

test("renderQrCard: draws in a throw-away tab, closes it, and the payment tab is the current one again", async () => {
  const d = fakeDriver();
  const png = await renderQrCard(d, "<html></html>");
  assert.equal(png, "CARDPNG");
  assert.equal(d.state.window, "main");
  assert.deepEqual(d.calls.filter((c) => /newWindow|close|window:/.test(c)), ["newWindow", "close", "window:main"]);
  assert.match(d.lastUrl, /^data:text\/html/);
});

test("renderQrCard: if the card tab breaks the tab is still closed and the payment tab restored", async () => {
  const d = fakeDriver({ failRender: true });
  await assert.rejects(() => renderQrCard(d, "<html></html>"), /tab broke/);
  assert.equal(d.state.window, "main");
  assert.ok(d.calls.includes("close"));
});

/* -------------------------------- captureQrCard -------------------------------- */

test("captureQrCard: the card (not the popup) is what gets stored, and the expiry is 5 minutes after", async () => {
  const d = fakeDriver();
  const { seen, capture } = recorder();
  const out = await quiet(() => captureQrCard(d, capture, "JOB1", { now: () => NOW }));
  assert.equal(out.branded, true);
  assert.equal(out.expiresAt, "2026-10-22T10:35:00.000Z");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "payment_qr");
  assert.equal(seen[0].stage, "kshema_payment_qr_JOB1");
  assert.equal(seen[0].image, "CARDPNG");
  assert.equal(out.shot.screenshotKey, "screenshots/x.png");
});

test("captureQrCard: QR not found -> the old whole-popup picture is stored (no image handed over), expiry kept", async () => {
  const d = fakeDriver({ qr: "none" });
  const { seen, capture } = recorder();
  const out = await quiet(() => captureQrCard(d, capture, "JOB2", { now: () => NOW }));
  assert.equal(out.branded, false);
  assert.equal(seen[0].image, undefined);
  assert.equal(out.expiresAt, "2026-10-22T10:35:00.000Z");
  assert.equal(out.shot.screenshotKey, "screenshots/x.png");
});

test("captureQrCard: the card cannot be drawn -> same fallback, and the payment tab is back", async () => {
  const d = fakeDriver({ failRender: true });
  const { seen, capture } = recorder();
  const out = await quiet(() => captureQrCard(d, capture, "JOB3", { now: () => NOW }));
  assert.equal(out.branded, false);
  assert.equal(seen[0].image, undefined);
  assert.equal(d.state.window, "main");
});

/* ----------------------------- wiring in both flows ----------------------------- */

const FLOWS = [
  path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
];
for (const file of FLOWS) {
  test(`${path.basename(file)}: the payment step stores the QR card and returns its expiry`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /kshemaPaymentQr"\)\.captureQrCard\(driver, capture, jobId\)/);
    assert.match(src, /qrExpiresAt = qr\.expiresAt/);
    assert.match(src, /return \{ ok: true, paymentUrl, qrScreenshotUrl, qrScreenshotKey, qrExpiresAt, qrError \}/);
    assert.ok(!/capture\("payment_qr"/.test(src), "the whole-popup capture is only the helper's fallback now");
  });
}

for (const file of [path.join(ROOT, "fullPolicycompany", "kshemaForm.js"), path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js")]) {
  test(`${path.basename(file)}: capture hands a ready-made picture to captureScreenshot, which uploads it instead of a page shot`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /const capture = \(name, stage, image\) =>\s*captureScreenshot\(driver, `\$\{name\}_\$\{jobId\}`, data, stage, image\)/);
    assert.match(src, /readyImage \|\| \(await driver\.takeScreenshot\(\)\)/);
  });
}
