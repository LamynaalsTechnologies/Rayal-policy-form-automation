/**
 * ONE "wait for the page to stop loading" for every insurer.
 *
 * There were three, each with its own behaviour on timeout — Reliance and
 * National swallowed it and carried on, KSHEMA threw. A login that "carries on"
 * from a page that never finished loading then fails several steps later with
 * an unrelated "element not found". Here every insurer treats a page that
 * never settles as a real failure, [E302], with the company named.
 *
 * What counts as "loading" differs per portal, so that part is data:
 *   reliance — the Kendo mask
 *   national — the NIC bouncing-GIF / loading-text overlay (plus the Kendo
 *              mask). Spinners inside an open popup are ignored: an open dialog
 *              means the request FINISHED and the portal is waiting for input.
 *   kshema   — the Angular Material spinner
 * The visibility rules (display/visibility/opacity/size) are National's, the
 * strictest of the three — a collapsed idle progress bar must never latch the
 * wait on "busy".
 */
const { MultiCompanyError } = require("./errors");

const PRESETS = {
  reliance: {
    label: "Reliance",
    busy: ".k-loading-mask",
    timeoutMs: 20000,
    stopOnDialog: false,
  },
  national: {
    label: "National",
    busy: [
      "img[src*='NIC-Bouncing']",
      "img[src*='loading']",
      "img[src*='loader']",
      "img[alt='NIC_Page_Loading']",
      "div[class*='loading-text']",
      ".k-loading-mask",
      "span[class*='sr-only']", // counts only when its text says "loading"
    ].join(", "),
    timeoutMs: 40000,
    stopOnDialog: true,
  },
  kshema: {
    label: "KSHEMA",
    busy: 'mat-spinner[data-iid="__loading"], .mat-mdc-progress-spinner',
    timeoutMs: 20000,
    stopOnDialog: false,
  },
};

const DIALOG_SELECTOR = [
  "mat-dialog-container",
  ".mat-mdc-dialog-container",
  "[role='dialog']",
  "[role='alertdialog']",
  ".modal.show",
].join(", ");

const isBusy = (driver, selector) =>
  driver
    .executeScript(
      `
      const nodes = document.querySelectorAll(arguments[0]);
      for (const el of nodes) {
        if (el.className && String(el.className).indexOf('sr-only') !== -1) {
          const t = (el.innerText || el.textContent || '').toLowerCase();
          if (t.indexOf('loading') === -1) continue;
        }
        if (el.closest && el.closest('mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, .modal')) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity || '1') < 0.05) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        if (el.offsetParent === null && style.position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return true;
      }
      return false;`,
      selector
    )
    // Mid-navigation, or the script was blocked: idle — the caller's own
    // element wait is the real gate.
    .catch(() => false);

const isDialogOpen = (driver) =>
  driver
    .executeScript(
      `
      for (const el of document.querySelectorAll(arguments[0])) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity || '1') < 0.05) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return true;
      }
      return false;`,
      DIALOG_SELECTOR
    )
    .catch(() => false);

/**
 * Wait until the company's loader has cleared.
 * @throws {MultiCompanyError} [E302] when it is still showing after the timeout
 */
async function waitForLoader(driver, company, { timeoutMs, pollMs = 120, stage = "login" } = {}) {
  const preset = PRESETS[String(company || "").toLowerCase()];
  if (!preset) throw new Error(`waitForLoader: unknown company "${company}"`);

  const limit = timeoutMs || preset.timeoutMs;
  const deadline = Date.now() + limit;

  while (Date.now() < deadline) {
    if (preset.stopOnDialog && (await isDialogOpen(driver))) return true;
    if (!(await isBusy(driver, preset.busy))) return true;
    await driver.sleep(pollMs);
  }

  throw new MultiCompanyError(
    "E302",
    `The ${preset.label} portal is still loading after ${Math.round(limit / 1000)} seconds — it will try again shortly.`,
    { stage, company: String(company).toLowerCase() }
  );
}

/** True when the company's loader is on screen right now (no waiting). */
async function isLoaderVisible(driver, company) {
  const preset = PRESETS[String(company || "").toLowerCase()];
  return preset ? isBusy(driver, preset.busy) : false;
}

module.exports = { waitForLoader, isLoaderVisible, LOADER_PRESETS: PRESETS };
