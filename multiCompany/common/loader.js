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
 *   united india — no loader was ever seen (the old download project only slept); common page-busy markers, and the
 *              page itself must have finished loading (document.readyState "complete", `waitReady`)
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
  // United India (UIIC GCWebPortal, a page-per-request JSP portal). ITS loader (the owner's markup, 2026-11-13): a small
  // fixed "Loading..." box, <div id="dialog" class="window" style="position: fixed; z-index: 99999; ... display: block;">
  // <img src="../resources/images/wait.gif" alt="Loading..."> ... </div> - none of the common markers below matched it, so the
  // run went on while it showed and a click was lost (the owner clicked More Covers by hand). The common markers stay. The
  // owner: wait for it at most 40 s.
  "united india": {
    label: "United India",
    busy: [
      "#dialog.window",
      "img[src*='wait.gif']",
      ".blockUI.blockOverlay",
      ".blockUI.blockMsg",
      "#loading",
      "#loader",
      ".loading",
      ".loader",
      "img[src*='loading']",
      "img[src*='loader']",
      ".spinner-border",
    ].join(", "),
    timeoutMs: 40000,
    stopOnDialog: false,
    waitReady: true,
  },
};

/** The page's own load has finished. Mid-navigation the script fails: not ready yet. */
const isDocumentReady = (driver) =>
  driver.executeScript("return document.readyState").then((state) => state === "complete", () => false);

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
    const ready = !preset.waitReady || (await isDocumentReady(driver));
    if (ready && !(await isBusy(driver, preset.busy))) return true;
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
  if (!preset) return false;
  if (preset.waitReady && !(await isDocumentReady(driver))) return true;
  return isBusy(driver, preset.busy);
}

module.exports = { waitForLoader, isLoaderVisible, LOADER_PRESETS: PRESETS };
