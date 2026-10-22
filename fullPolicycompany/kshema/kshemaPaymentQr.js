/**
 * The KSHEMA payment QR, cut out of the Razorpay popup and put on a small card of its own.
 *
 * Why this is its own module (2026-10-22): the step used to photograph the WHOLE popup — Razorpay's menu, price box,
 * artwork and a 12-minute timer — and store that as "Payment QR". The owner wants the QR alone, under the company's
 * name, with the time it stops being usable (5 minutes), and the app to stop showing it once that time is up.
 *
 * Steps, all inside the same Chrome (no image library in this project):
 *   1. findQrElement   - the QR inside the Razorpay iframe (the driver is already switched into it).
 *   2. readQrImage     - the QR's own pixels when the page keeps them (canvas / data: image), else a crop of the element.
 *   3. buildQrCardHtml - a self-contained page: company name, the QR, "Valid for 5 minutes", the expiry time. Pure.
 *   4. renderQrCard    - opens that page in a throw-away tab, photographs the card, closes the tab, comes back.
 *
 * Nothing here is allowed to fail the payment step: if the QR cannot be found or the card cannot be drawn, the old
 * whole-popup picture is stored instead (the operator still gets a QR) and the expiry is kept either way.
 *
 * Shared by the full-company flow and the TP copy (both proceedToPayment functions call captureQrCard), so the two
 * cannot drift. Operator sentences contain no colon (beautifyError keeps only the text after the last one).
 */
const { By, until } = require("selenium-webdriver");
const { log, warn, debug } = require("./kshemaLog");

/** How long the QR is shown as usable. The owner's rule — Razorpay's own timer runs longer (~12 minutes). */
const QR_VALID_MINUTES = 5;
const QR_VALID_MS = QR_VALID_MINUTES * 60 * 1000;
const COMPANY_NAME = "Kshema General Insurance";

/**
 * Runs in the browser, inside the Razorpay iframe. Returns [element, "how it was recognised"] or null.
 *
 * Razorpay's popup also holds a square piece of artwork (the elephant) that a "biggest square picture" rule would pick,
 * so a candidate must carry a SIGN that it is the QR — the words "scan ... qr" near it, a canvas, a data: image, or "qr"
 * in its class / alt / id. With none of those the answer is null and the caller falls back, instead of presenting the
 * artwork as a payment QR.
 */
const FIND_QR_SCRIPT = `
  var out = null, bestScore = 0;
  var nodes = document.querySelectorAll('canvas, img, svg');
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var r = n.getBoundingClientRect();
    var cs = window.getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (r.width < 90 || r.height < 90 || r.width > 700 || r.height > 700) continue;
    var ratio = r.width / r.height;
    if (ratio < 0.92 || ratio > 1.08) continue;
    var cls = (n.className && n.className.baseVal !== undefined) ? n.className.baseVal : (n.className || '');
    var src = (n.tagName === 'IMG' ? (n.getAttribute('src') || '') : '');
    var hint = [n.getAttribute('alt'), cls, n.id, n.getAttribute('data-testid'), n.getAttribute('aria-label')].join(' ');
    var near = '';
    var up = n;
    for (var k = 0; k < 4 && up && up.parentElement; k++) { up = up.parentElement; near += ' ' + (up.innerText || ''); }
    var score = 0, via = [];
    if (/scan[\\s\\S]{0,40}qr|qr[\\s\\S]{0,40}scan/i.test(near)) { score += 4; via.push('scan text'); }
    if (n.tagName === 'CANVAS') { score += 2; via.push('canvas'); }
    if (/^data:image\\//i.test(src)) { score += 2; via.push('data image'); }
    if (/qr/i.test(hint)) { score += 2; via.push('qr hint'); }
    if (score === 0) continue;
    score = score * 1000000 + r.width * r.height;
    if (score > bestScore) { bestScore = score; out = [n, n.tagName.toLowerCase() + ' (' + via.join(', ') + ')']; }
  }
  return out;
`;

/** Runs in the browser. The element's own image as a data URL, or null (cross-origin picture, svg, anything else). */
const READ_NATIVE_SCRIPT = `
  var el = arguments[0];
  try {
    if (el.tagName === 'CANVAS') return el.toDataURL('image/png');
    if (el.tagName === 'IMG' && /^data:image\\/(png|jpeg|gif)/i.test(el.getAttribute('src') || '')) return el.getAttribute('src');
  } catch (e) {}
  return null;
`;

/** @returns {Promise<{element: object, via: string}|null>} the QR element in the current frame, or null. */
async function findQrElement(driver) {
  const found = await driver.executeScript(FIND_QR_SCRIPT);
  if (!found || !found[0]) return null;
  return { element: found[0], via: String(found[1] || "") };
}

/**
 * The QR as a data URL. Prefers the page's own pixels (sharp at any size); otherwise crops the element on screen.
 * @returns {Promise<string>} "data:image/...;base64,..."
 */
async function readQrImage(driver, element) {
  try {
    const native = await driver.executeScript(READ_NATIVE_SCRIPT, element);
    if (typeof native === "string" && native.length > 200) return native;
  } catch (e) {
    debug(`   QR native image not readable: ${e.message}`);
  }
  const png = await element.takeScreenshot();
  return `data:image/png;base64,${png}`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** "4:12 PM" in India time (the servers run in UTC; see policy-dates-india-time). */
function formatExpiryClock(date) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true })
    .format(date)
    .toUpperCase();
}

/**
 * The card as one self-contained page: no remote fonts, no scripts, nothing that needs the network.
 * `#frame` is what gets photographed; `#qr` is the picture the renderer waits for.
 */
function buildQrCardHtml({ qrDataUrl, expiresAt, companyName = COMPANY_NAME, validMinutes = QR_VALID_MINUTES }) {
  const clock = formatExpiryClock(new Date(expiresAt));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Payment QR</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #eef0f8; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: #1c1b2e; }
  #frame { display: inline-block; padding: 22px; background: #eef0f8; }
  #card { width: 400px; background: #fff; border-radius: 22px; overflow: hidden; box-shadow: 0 8px 28px rgba(60, 40, 160, .18); }
  .head { padding: 22px 24px 20px; color: #fff; background: linear-gradient(135deg, #2b1b8f 0%, #4a2fd6 60%, #6a4cf0 100%); }
  .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; opacity: .78; }
  .name { margin-top: 6px; font-size: 24px; font-weight: 700; line-height: 1.2; }
  .body { padding: 24px 24px 8px; text-align: center; }
  .qrbox { display: inline-block; padding: 16px; background: #fff; border: 2px solid #e4e1fb; border-radius: 18px; }
  #qr { display: block; width: 260px; height: 260px; image-rendering: pixelated; }
  .scan { margin-top: 16px; font-size: 15px; font-weight: 600; }
  .apps { margin-top: 4px; font-size: 12.5px; color: #6b6a80; }
  .timer { margin: 20px 24px 0; padding: 12px 14px; border-radius: 14px; background: #fff4e5; border: 1px solid #ffd9a1; text-align: center; }
  .timer b { display: block; font-size: 16px; color: #b45309; }
  .timer span { display: block; margin-top: 2px; font-size: 13px; color: #7a4a10; }
  .foot { padding: 14px 24px 20px; text-align: center; font-size: 11.5px; color: #8a8999; }
</style></head>
<body>
<div id="frame"><div id="card">
  <div class="head"><div class="eyebrow">Payment QR</div><div class="name">${escapeHtml(companyName)}</div></div>
  <div class="body">
    <div class="qrbox"><img id="qr" alt="Payment QR" src="${escapeHtml(qrDataUrl)}"></div>
    <div class="scan">Scan to pay with any UPI app</div>
    <div class="apps">Google Pay &middot; PhonePe &middot; Paytm &middot; BHIM</div>
  </div>
  <div class="timer"><b>Valid for ${escapeHtml(validMinutes)} minutes</b><span>Expires at ${escapeHtml(clock)} IST</span></div>
  <div class="foot">This QR stops working after the time above.</div>
</div></div>
</body></html>`;
}

/**
 * Draw the card in a throw-away tab and photograph it. The payment page's tab is always the one the driver is on again
 * when this returns (or throws).
 * @returns {Promise<string>} base64 PNG of the card
 */
async function renderQrCard(driver, html) {
  const original = await driver.getWindowHandle();
  let opened = false;
  try {
    await driver.switchTo().newWindow("tab");
    opened = true;
    await driver.get(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const frame = await driver.wait(until.elementLocated(By.id("frame")), 8000);
    await driver.wait(
      () => driver.executeScript("var i = document.getElementById('qr'); return !!(i && i.complete && i.naturalWidth > 0);"),
      8000,
      "the QR picture did not load on the card"
    );
    return await frame.takeScreenshot();
  } finally {
    if (opened) await driver.close().catch(() => {});
    await driver.switchTo().window(original).catch(() => {});
  }
}

/**
 * Take the payment QR picture for the policy and report when it stops being valid.
 *
 * @param driver   Selenium driver, already switched into the Razorpay iframe with the QR on screen
 * @param capture  the form's capture(name, stage, image?) — uploads `image` (base64 PNG) when given, else a screenshot
 * @param jobId    for the S3 path
 * @param now      injectable clock (tests)
 * @returns {Promise<{shot: {screenshotUrl: string|null, screenshotKey: string|null}, expiresAt: string, branded: boolean}>}
 *          expiresAt is an ISO time, QR_VALID_MINUTES after the call began — set even when the old picture is the fallback.
 */
async function captureQrCard(driver, capture, jobId, { now = () => new Date() } = {}) {
  const expiresAt = new Date(now().getTime() + QR_VALID_MS);
  let image = null;
  try {
    const found = await findQrElement(driver);
    if (!found) {
      warn("   ⚠️ The QR could not be picked out of the Razorpay popup, so the whole popup is saved instead");
    } else {
      log(`   ✓ Found the QR: ${found.via}`);
      const qrDataUrl = await readQrImage(driver, found.element);
      image = await renderQrCard(driver, buildQrCardHtml({ qrDataUrl, expiresAt }));
      log("   ✓ QR cropped onto its own card");
    }
  } catch (e) {
    warn(`   ⚠️ Could not make the QR card (${e.message}), so the whole popup is saved instead`);
    image = null;
  }

  const shot = await capture("payment_qr", `kshema_payment_qr_${jobId}`, image || undefined);
  return { shot, expiresAt: expiresAt.toISOString(), branded: !!image };
}

module.exports = {
  QR_VALID_MINUTES,
  QR_VALID_MS,
  COMPANY_NAME,
  findQrElement,
  readQrImage,
  buildQrCardHtml,
  renderQrCard,
  captureQrCard,
  formatExpiryClock,
};
