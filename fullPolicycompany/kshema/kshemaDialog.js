/**
 * KSHEMA's own message popup: an Angular Material DIALOG, not the snackbar kshemaToast.js reads.
 *
 *   <div class="mat-mdc-dialog-surface mdc-dialog__surface">
 *     <gen-message>
 *       <div class="message">
 *         <div style="...font-size: 1.6em...">Note</div>
 *         <div>Please unselect limited TPPD as TPPD Discount is not applicable for this RTO</div>
 *       </div>
 *       <div class="message-footer"> ... <button><span class="mdc-button__label">OK</span></button>
 *
 * Seen 2026-11-05 right after Limited TPPD = Yes on an RTO where KSHEMA gives no TPPD discount. The toast reader never
 * saw it, so the run logged "✓ TPPD Restrict: Yes" and carried on behind a popup that blocks the page.
 *
 * Reading only: the popup is left open, so the screenshot shows what KSHEMA said.
 */

/** Runs in the page: the visible message boxes' lines (title first), or null. */
const READ_SCRIPT = `
  const boxes = Array.from(document.querySelectorAll("gen-message .message, .mat-mdc-dialog-surface .message, mat-dialog-container .message"));
  for (const box of boxes) {
    if (box.getClientRects().length === 0) continue;
    const lines = Array.from(box.children).map((c) => (c.innerText || c.textContent || "").trim()).filter(Boolean);
    if (lines.length) return lines;
  }
  return null;
`;

/**
 * The popup on screen now, or null: { title, text }. A two-line popup is "Note" + the message; a one-line popup is
 * the message alone.
 */
async function readMessageDialog(driver) {
  let lines = null;
  try {
    lines = await driver.executeScript(READ_SCRIPT);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const clean = lines.map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return { title: "", text: clean[0] };
  return { title: clean[0], text: clean.slice(1).join(" ") };
}

/** Polls for the popup: it shows once the premium is worked out again, which is slow on this portal. */
async function waitForMessageDialog(driver, { timeoutMs = 6000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialog = await readMessageDialog(driver);
    if (dialog) return dialog;
    if (Date.now() >= deadline) return null;
    await driver.sleep(pollMs);
  }
}

module.exports = { readMessageDialog, waitForMessageDialog, READ_SCRIPT };
