const { By, until, Key } = require("selenium-webdriver");
const {
  createNationalJobBrowser,
  cleanupNationalJobBrowser,
} = require("../nationalSessionManager");
const { CONFIG } = require("../nationalBrowserConfig");
const fs = require("fs");
const path = require("path");
const { extractCaptchaText } = require("../Captcha");
const { uploadScreenshotToS3, generateScreenshotKey } = require("../s3Uploader");
const { beautifyError } = require("../lib/errorHandler");
// Shared with Reliance — National previously had NO Brisk handling at all, so
// a National policy with PA Cover through Brisk never got its CPA/RSA
// certificate.
const {
  createBriskCertificate,
  downloadBriskPDF,
  uploadBriskCertificate,
  shouldCreateBriskCertificate,
} = require("../briskCertificate");

// Default form data for standalone execution
const defaultFormData = {
  // username: "9999839907",
  // password: "Rayal$2025",
  username: "",
  password: "",
  rtoLocation: "Mumbai",
  make: "Honda",
  variant: "Standard"
};

// Parse command line arguments
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  const formData = { ...defaultFormData };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    switch (key) {
      case '--username':
      case '-u':
        formData.username = value;
        break;
      case '--password':
      case '-p':
        formData.password = value;
        break;
      case '--rto':
      case '-r':
        formData.rtoLocation = value;
        break;
      case '--make':
      case '-m':
        formData.make = value;
        break;
      case '--variant':
      case '-v':
        formData.variant = value;
        break;
      case '--help':
      case '-h':
        console.log(`
🚀 National Insurance Automation Script

Usage: node national.js [options]

Options:
  -u, --username <value>    Username for login (default: testuser)
  -p, --password <value>    Password for login (default: testpass)
  -r, --rto <value>         RTO Location (default: Mumbai)
  -m, --make <value>        Vehicle Make (default: Honda)
  -v, --variant <value>     Vehicle Variant (default: Standard)
  -h, --help               Show this help message

Examples:
  node national.js
  node national.js --username myuser --password mypass
  node national.js -u myuser -p mypass -r Delhi -m Yamaha -v Sport
        `);
        process.exit(0);
        break;
    }
  }

  return formData;
}

async function waitForLoaderToDisappear(
  driver,
  locator = By.css(".k-loading-mask"),
  timeout = 40000
) {
  console.log(`Waiting for loader (${locator}) to disappear...`);
  try {
    await driver.wait(async () => {
      const loaders = await driver.findElements(locator);
      if (loaders.length === 0) {
        return true; // Loader is gone
      }
      try {
        const isDisplayed = await loaders[0].isDisplayed();
        return !isDisplayed;
      } catch (e) {
        if (e.name === "StaleElementReferenceError") {
          return true;
        }
        throw e;
      }
    }, timeout);
    console.log("Loader has disappeared.");
  } catch (error) {
    console.log("Loader did not disappear in time (which is ok).");
  }
}

// The National portal's real page-level busy indicators. These mirror the
// proven loader detection used by the National PDF automation
// (waitForNationalLoader): the NIC bouncing-GIF spinner, the loading-text
// overlay, and the sr-only "loading" announcement — plus the Kendo mask.
//
// Do NOT add mat-progress-bar / mat-progress-spinner here: Angular Material
// dialogs render their own spinners, so an OPEN POPUP would be read as "the
// page is still loading" and every wait would stall while the dialog sat there
// waiting for input.
const PORTAL_BUSY_SELECTOR = [
  "img[src*='NIC-Bouncing']",
  "img[src*='loading']",
  "img[src*='loader']",
  "img[alt='NIC_Page_Loading']",
  "div[class*='loading-text']",
  ".k-loading-mask",
  "span[class*='sr-only']", // only counts when its text says "loading" — see isPortalBusy
].join(", ");

// The premium/payment flow was written against the OLD version of
// waitForPortalLoaderToDisappear, which never actually waited — it looked once
// and returned. That flow already has its own fixed settle sleeps and popup
// handling and is known-good, so its calls stay non-blocking. Making them wait
// stalled the run with a payment popup sitting open on screen.
const NON_BLOCKING_LOADER_CHECK = 0;

// Popups this portal raises that BLOCK further work until they are dismissed
// (e.g. the "Road Side Assistance … not opted currently!" Confirm box after
// Generate Quick Quote). Includes the portal's own confirm/alert buttons by
// name, because several of these dialogs are plain divs with no ARIA role.
const BLOCKING_DIALOG_SELECTOR = [
  "mat-dialog-container",
  ".mat-mdc-dialog-container",
  "[role='dialog']",
  "[role='alertdialog']",
  ".modal.show",
  "[name='confirm_btn_yes_01']",
  "[name='alert_btn_data_01']",
].join(", ");

/**
 * True when a popup is on screen waiting for the user to dismiss it.
 *
 * A visible dialog means the portal has FINISHED its request and is asking for
 * input — it is the opposite of "still loading". Treating one as busy
 * deadlocks the run: the wait blocks on a loader that only clears once the
 * dialog is dismissed, and the code that would dismiss it never runs.
 */
async function isBlockingDialogOpen(driver) {
  try {
    return await driver.executeScript(`
      const nodes = document.querySelectorAll(arguments[0]);
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity || '1') < 0.05) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return true;
      }
      return false;
    `, BLOCKING_DIALOG_SELECTOR);
  } catch (e) {
    return false;
  }
}

/**
 * Dismiss the portal's generic alert/confirmation popup, if one is open.
 *
 * The portal throws these up after various actions (ticking the non-GIC
 * checkbox, choosing "No" for PA, ...). Its close button carries no useful
 * marker of its own — the `mat-mdc-button-touch-target` span sits inside EVERY
 * Angular Material button — so the button is located by the portal's own name
 * attribute first, then by its "Close"/"OK" text, and only as a last resort by
 * taking whatever button lives inside the visible dialog container.
 *
 * Returns true when a dialog was found and closed. A missing dialog is not an
 * error: these popups are conditional, so `false` just means there was nothing
 * to dismiss.
 */
async function dismissPortalDialog(driver, jobId = "National", label = "popup", waitMs = 6000) {
  const deadline = Date.now() + waitMs;
  let seen = false;

  while (Date.now() < deadline) {
    if (await isBlockingDialogOpen(driver)) {
      seen = true;
      break;
    }
    await driver.sleep(150);
  }

  if (!seen) {
    console.log(`[${jobId}] No ${label} appeared — continuing.`);
    return false;
  }

  console.log(`[${jobId}] ${label} detected, closing it...`);

  const closeLocators = [
    By.xpath("//button[@name='alert_btn_data_01' and .//span[contains(text(), 'Close')]]"),
    By.xpath("//button[@name='alert_btn_data_01']"),
    By.name("confirm_btn_yes_01"),
    By.xpath("//button[.//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CLOSE')]]"),
    By.xpath("//button[.//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'OK')]]"),
    // Last resort: any button inside the dialog itself.
    By.css("mat-dialog-container button, .mat-mdc-dialog-container button, [role='dialog'] button"),
  ];

  for (const locator of closeLocators) {
    try {
      const found = await firstPresentLocator(driver, [locator], 1200);
      if (!found) continue;
      await driver.executeScript("arguments[0].click();", found.element);

      // Confirm it actually went away before claiming success — clicking the
      // wrong button in a dialog can leave it open.
      const gone = Date.now() + 4000;
      while (Date.now() < gone) {
        if (!(await isBlockingDialogOpen(driver))) {
          console.log(`[${jobId}] ✅ Closed the ${label}.`);
          return true;
        }
        await driver.sleep(120);
      }
    } catch (clickError) {
      // try the next locator
    }
  }

  console.log(`[${jobId}] ⚠️ Could not close the ${label} — it may block the next step.`);
  return false;
}

/**
 * True when a loader/spinner is actually visible on screen. One round-trip.
 */
async function isPortalBusy(driver) {
  try {
    return await driver.executeScript(`
      const nodes = document.querySelectorAll(arguments[0]);
      for (const el of nodes) {
        // sr-only spans are used all over the page for accessibility labels —
        // only the one that actually announces "loading" is a busy signal.
        if (el.className && String(el.className).indexOf('sr-only') !== -1) {
          const srText = (el.innerText || el.textContent || '').toLowerCase();
          if (srText.indexOf('loading') === -1) continue;
        }
        // A spinner INSIDE a dialog/overlay means "this popup is busy", not
        // "the page is loading" — and a popup that is simply open and waiting
        // for input must never be mistaken for in-flight work.
        if (el.closest && el.closest('mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, .modal')) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity || '1') < 0.05) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        // display:none on any ancestor
        if (el.offsetParent === null && style.position !== 'fixed') continue;
        // A collapsed-height progress bar (height 0, full width) is the normal
        // Angular Material "idle" state — require BOTH dimensions to be real,
        // otherwise this latches on "busy" forever and every wait burns its
        // full timeout.
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        return true;
      }
      return false;
    `, PORTAL_BUSY_SELECTOR);
  } catch (e) {
    // Page is mid-navigation or the script was blocked — treat as idle and
    // let the caller's own element wait be the real gate.
    return false;
  }
}

/**
 * Wait until every portal loader has cleared.
 *
 * The previous version never waited: it looked once, logged "skipping wait as
 * requested" and returned. Every caller therefore had to guard itself with a
 * fixed driver.sleep(), which is both slower (a flat 2-4s even when the portal
 * responded in 200ms) and less safe (a slow response was raced, not waited
 * out). This now really waits, so those fixed sleeps can go.
 *
 * Never throws — on timeout it logs and lets the caller's own element wait
 * decide, exactly like waitForLoaderToDisappear above.
 */
async function waitForPortalLoaderToDisappear(driver, timeout = 40000, pollInterval = 120) {
  // timeout 0 = explicit non-blocking probe. Used by the payment flow, which
  // was written and proven against the old no-op version of this helper and
  // carries its own settle sleeps — see NON_BLOCKING_LOADER_CHECK below.
  if (timeout <= 0) return true;

  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let sawBusy = false;
  let lastLogged = -1;

  while (Date.now() < deadline) {
    // A popup asking for input means the request already finished — stop
    // waiting and hand control back so the caller can dismiss it. Without
    // this the run deadlocks: the loader only clears once the dialog is
    // dismissed, and the code that dismisses it is stuck behind this wait.
    if (await isBlockingDialogOpen(driver)) {
      console.log("Popup is open (portal is waiting for input) — not a loader, continuing.");
      return true;
    }

    if (!(await isPortalBusy(driver))) {
      if (sawBusy) {
        console.log(`✅ Portal loader cleared after ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
      return true;
    }
    if (!sawBusy) {
      sawBusy = true;
      console.log("⏳ Portal loader visible, waiting for it to clear...");
    } else {
      // Make a long wait visible in the logs instead of looking like a hang.
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      if (remaining !== lastLogged && (remaining % 5 === 0 || remaining <= 3)) {
        console.log(`   🐢 National still loading... ${remaining}s left before giving up`);
        lastLogged = remaining;
      }
    }
    await driver.sleep(pollInterval);
  }

  console.log("⚠️ Portal loader still visible after wait (continuing anyway).");
  return false;
}

/**
 * Wait for the portal to go idle after an action that may fire a request.
 *
 * A request that was just fired has not rendered its spinner yet, so we give
 * the loader a short window to appear before concluding "nothing happened".
 * Bounded by appearGrace (a few hundred ms) instead of the multi-second blind
 * sleeps this replaces — and if work IS in flight we wait for all of it.
 */
async function waitForPortalIdle(driver, timeout = 40000, appearGrace = 400) {
  const graceDeadline = Date.now() + appearGrace;
  let busy = false;

  while (Date.now() < graceDeadline) {
    // A popup that appeared during the grace window IS the response — the
    // portal is done and waiting on us, so stop immediately.
    if (await isBlockingDialogOpen(driver)) {
      console.log("Popup appeared — portal finished, continuing to handle it.");
      return true;
    }
    if (await isPortalBusy(driver)) {
      busy = true;
      break;
    }
    await driver.sleep(60);
  }

  if (!busy) return true; // nothing ever started — already idle
  return waitForPortalLoaderToDisappear(driver, timeout);
}

/**
 * Write our own IDV into the portal's IDV field in model-not-found mode.
 *
 * Ticking "Not able to Find the required Model & Variant" makes the portal
 * DISABLE the IDV input and derive a figure of its own from the Manufacturer's
 * Selling Price. That derived number is not the one the operator agreed with
 * the customer — the form makes them type an IDV inside the range the selling
 * price implies (see BasicPolicyDetailsStep: National keeps the IDV field open
 * precisely for this), and that is the number the quote must carry.
 *
 * A disabled input ignores both real typing and synthetic events, so the field
 * is re-enabled first. The portal keeps ownership of it either way: if it
 * re-derives and overwrites us, that is logged rather than hidden.
 *
 * Never fatal — the portal-derived IDV is still a usable quote, so a failure
 * here warns and lets the run continue. Real on-page validation ("IDV can't be
 * less than X") still throws, exactly as it does on the normal IDV path.
 */
async function overridePortalDerivedIdv(driver, data, { reassert = false } = {}) {
  const jobId = data._jobId || "National";
  const idvValue = data.idv || data.idvValue || data.insuredDeclaredValue;
  const digitsOf = (value) => String(value ?? "").replace(/[^0-9.]/g, "");

  if (!idvValue || Number(idvValue) <= 0) {
    if (!reassert) {
      console.log(
        `[${jobId}] No IDV supplied — keeping the portal-derived value.`
      );
    }
    return false;
  }

  try {
    const found = await firstPresentLocator(
      driver,
      [
        By.name("pc_text_idv_01"),
        By.css("input[name='pc_text_idv_01']"),
        By.xpath(
          "//*[contains(normalize-space(.), 'IDV')]/following::input[not(@type='hidden')][1]"
        ),
      ],
      // The first pass may still be waiting on the block to re-render after
      // the selling price; by the re-assert pass the field is long since there.
      reassert ? 5000 : 20000,
      { requireVisible: false }
    );

    if (!found) {
      console.log(
        `[${jobId}] ⚠️ IDV input (pc_text_idv_01) not found — keeping the portal-derived value.`
      );
      return false;
    }

    // Let the portal finish deriving first. Writing into the field while its
    // own calculation is still in flight just gets overwritten a moment later.
    if (!reassert) {
      await driver
        .wait(async () => {
          const current = await found.element.getAttribute("value");
          return !!(current && String(current).trim());
        }, 10000)
        .catch(() => { });
    }

    const derived = await found.element.getAttribute("value");

    // On the re-assert pass, say nothing and do nothing when our value is
    // still sitting there — the common case, and it should not add noise.
    if (reassert && digitsOf(derived) === digitsOf(idvValue)) {
      return false;
    }

    console.log(
      `[${jobId}] ${reassert
        ? `IDV was reset to ${derived || "(empty)"} — re-applying`
        : `Portal-derived IDV: ${derived || "(empty)"} — overriding with`
      } ${idvValue}`
    );

    // The portal disables this input in model-not-found mode. Selenium refuses
    // to type into a disabled field and the browser drops events on it, so the
    // attribute has to go before anything else works.
    await driver.executeScript(
      "const el = arguments[0];" +
      "el.removeAttribute('disabled');" +
      "el.disabled = false;" +
      "el.removeAttribute('readonly');" +
      "el.readOnly = false;" +
      "el.scrollIntoView({block: 'center'});",
      found.element
    );

    await found.element.clear().catch(() => { });
    await found.element.sendKeys(String(idvValue)).catch(() => { });

    // Angular commits the model on input/change and recalculates on blur —
    // the same trio the selling price field needs.
    await driver.executeScript(
      "const el = arguments[0];" +
      "el.dispatchEvent(new Event('input', {bubbles:true}));" +
      "el.dispatchEvent(new Event('change', {bubbles:true}));" +
      "el.dispatchEvent(new Event('blur', {bubbles:true}));",
      found.element
    );

    await driver.sleep(1000);

    let applied = await found.element.getAttribute("value");

    // sendKeys can be swallowed when Angular re-renders the block mid-type.
    // Fall back to the native value setter, which survives that.
    if (digitsOf(applied) !== digitsOf(idvValue)) {
      await driver.executeScript(
        "const el = arguments[0];" +
        "const setter = Object.getOwnPropertyDescriptor(" +
        "  window.HTMLInputElement.prototype, 'value').set;" +
        "setter.call(el, arguments[1]);" +
        "el.dispatchEvent(new Event('input', {bubbles:true}));" +
        "el.dispatchEvent(new Event('change', {bubbles:true}));" +
        "el.dispatchEvent(new Event('blur', {bubbles:true}));",
        found.element,
        String(idvValue)
      );
      await driver.sleep(1000);
      applied = await found.element.getAttribute("value");
    }

    if (digitsOf(applied) === digitsOf(idvValue)) {
      console.log(`[${jobId}] ✅ Filled IDV value: ${idvValue}`);
    } else {
      // Not an error: the portal is entitled to re-derive. Say so plainly so
      // the number on the quote is never a surprise.
      console.log(
        `[${jobId}] ⚠️ Portal kept its own IDV (${applied}) instead of ${idvValue}.`
      );
    }

    await checkForValidationErrors(driver, data, "idv_override");
    await driver.sleep(500);

    // Reported to the caller because writing this field makes the portal
    // recompute the discount, which then has to be put back.
    return true;
  } catch (e) {
    if (e.message.includes("Validation Error")) throw e;
    console.log(
      `[${jobId}] ⚠️ Could not override the portal-derived IDV: ${e.message}`
    );
    return false;
  }
}

/**
 * Fill the discount percentage on the quick-quote form.
 *
 * MUST run after the IDV. The portal derives the discount a vehicle qualifies
 * for from its value, so it rewrites this field every time the IDV changes —
 * which is why this used to be silently thrown away when it ran first.
 *
 * Reads the value back afterwards: the portal is entitled to clamp the figure
 * to whatever the vehicle actually qualifies for ("Maximum available
 * discount(%)"), and knowing it was clamped beats assuming the number went in.
 */
// Used only when the policy carries no discount of its own — the portal will
// not accept an empty box, and 75 is the figure this step has always sent.
const DEFAULT_QUICK_QUOTE_DISCOUNT = "75";

/**
 * The discount this policy should be priced at.
 *
 * Mongo/the automation server hand the same number over under several names
 * (server.js maps ODDiscount / odDiscount / Detariff_Discount_Rate onto
 * `discount`), so all of them are checked — the full-policy stage further down
 * reads `formData.discount`, and the two must not disagree.
 *
 * 0 is a LEGITIMATE discount, so the presence test is explicitly against
 * undefined/null/"" rather than falsiness.
 */
const resolvePolicyDiscount = (data) => {
  const raw = [
    data?.discount,
    data?.ODDiscount,
    data?.odDiscount,
    data?.Detariff_Discount_Rate,
  ].find((v) => v !== undefined && v !== null && v !== "");

  const num = Number(raw);
  if (Number.isFinite(num) && num >= 0 && num <= 100) {
    return { value: String(num), fromPolicy: true };
  }
  return { value: DEFAULT_QUICK_QUOTE_DISCOUNT, fromPolicy: false };
};

async function fillDiscountPercentage(driver, data, { reason = "" } = {}) {
  const jobId = data._jobId || "National";
  const { value: target, fromPolicy } = resolvePolicyDiscount(data);
  const digitsOf = (value) => String(value ?? "").replace(/[^0-9.]/g, "");

  console.log(
    `Filling percentage: ${target}%${fromPolicy ? " (from the policy)" : " (default — the policy carries no discount)"}${reason ? ` (${reason})` : ""}`
  );

  const percentageField = By.name("mcy_text_percentage_01");

  try {
    const el = await driver.wait(
      until.elementLocated(percentageField),
      15000
    );
    await driver.wait(until.elementIsVisible(el), 15000);
    await driver.wait(until.elementIsEnabled(el), 15000);
    await driver.executeScript(
      "arguments[0].scrollIntoView({block: 'center'});",
      el
    );

    const before = await el.getAttribute("value");

    // clear() + sendKeys (what safeType does) was NOT enough here. The portal
    // pre-fills this box with the maximum discount the vehicle qualifies for
    // and only commits a new figure on blur — so the typed value went in, no
    // blur followed, and Angular painted its own number straight back over it.
    // That is why the read-back kept showing the portal's 80 instead of ours.
    await el.click().catch(() => { });
    await el.sendKeys(Key.CONTROL, "a");
    await el.sendKeys(Key.DELETE);
    await el.sendKeys(target);
    await driver.executeScript(
      "const el = arguments[0];" +
      "el.dispatchEvent(new Event('input', {bubbles:true}));" +
      "el.dispatchEvent(new Event('change', {bubbles:true}));" +
      "el.dispatchEvent(new Event('blur', {bubbles:true}));",
      el
    );

    await driver.sleep(1000);

    let applied = await driver
      .findElement(percentageField)
      .getAttribute("value");

    // Typing can be swallowed when Angular re-renders the block mid-keystroke.
    // The native value setter survives that.
    if (digitsOf(applied) !== digitsOf(target)) {
      const retryEl = await driver.findElement(percentageField);
      await driver.executeScript(
        "const el = arguments[0];" +
        "const setter = Object.getOwnPropertyDescriptor(" +
        "  window.HTMLInputElement.prototype, 'value').set;" +
        "setter.call(el, arguments[1]);" +
        "el.dispatchEvent(new Event('input', {bubbles:true}));" +
        "el.dispatchEvent(new Event('change', {bubbles:true}));" +
        "el.dispatchEvent(new Event('blur', {bubbles:true}));",
        retryEl,
        target
      );
      await driver.sleep(1000);
      applied = await driver
        .findElement(percentageField)
        .getAttribute("value");
    }

    await checkForValidationErrors(driver, data, "discount_selection");

    if (digitsOf(applied) === digitsOf(target)) {
      console.log(
        `[${jobId}] ✅ Discount percentage on the quote: ${applied}% (portal had ${before || "empty"})`
      );
    } else {
      // Not an error. The portal caps the discount at what the vehicle
      // qualifies for, so a figure above that legitimately comes back clamped —
      // say which number the quote is actually priced on.
      console.log(
        `[${jobId}] ⚠️ Portal kept discount ${applied || "(empty)"} instead of ${target} — the quote is priced on ${applied || "its own default"}.`
      );
    }

    await driver.sleep(500);
  } catch (e) {
    if (e.message.includes("Validation Error")) throw e;
    console.log("Could not fill percentage field:", e.message);
  }
}

/**
 * Probe several locators at once and return the first that is actually
 * present, without burning a full timeout per miss.
 *
 * findElements returns immediately (no implicit wait), so a chain of
 * "try locator A for 5s, then B for 5s, then C for 5s" — which costs 15s
 * whenever the page uses the last variant — becomes a single bounded poll.
 * Returns { element, locator } or null.
 *
 * requireVisible defaults to true. Pass false when the caller clicks via
 * executeScript, which works on hidden elements — otherwise a control inside a
 * collapsed panel would be reported missing and silently skipped.
 */
async function firstPresentLocator(
  driver,
  locators,
  timeout = 8000,
  { pollInterval = 120, requireVisible = true } = {}
) {
  const list = Array.isArray(locators) ? locators : [locators];
  const deadline = Date.now() + timeout;

  do {
    for (const locator of list) {
      try {
        const found = await driver.findElements(locator);
        for (const el of found) {
          try {
            if (!requireVisible || (await el.isDisplayed())) {
              return { element: el, locator };
            }
          } catch (staleError) {
            // element vanished between find and check — try the next one
          }
        }
      } catch (lookupError) {
        // bad/unsupported locator — skip it rather than abort the chain
      }
    }
    if (Date.now() >= deadline) break;
    await driver.sleep(pollInterval);
  } while (true);

  return null;
}

/**
 * Wait for an Angular Material overlay (dropdown/autocomplete panel) to close.
 * Used instead of a fixed sleep after picking an option, so the next field is
 * not clicked through a still-open backdrop.
 */
async function waitForOverlayGone(driver, timeout = 3000, pollInterval = 80) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const open = await driver.executeScript(`
        return document.querySelectorAll(
          '.cdk-overlay-pane mat-option, .mat-mdc-autocomplete-panel, .mat-mdc-select-panel'
        ).length > 0;
      `);
      if (!open) return true;
    } catch (e) {
      return true; // cannot inspect — do not block the flow
    }
    await driver.sleep(pollInterval);
  }
  return false;
}

/**
 * Type into an Angular Material autocomplete and pick the right option.
 *
 * Replaces the "sendKeys -> sleep(2000) -> click first mat-option" pattern.
 * Two wins: it returns as soon as the options render (typically 100-400ms
 * instead of a flat 2s), and because it matches on the option TEXT it can no
 * longer click a stale option left over from the previously-open panel — the
 * exact failure the old blind sleep was there to paper over.
 *
 * Falls back to the old "click whatever is showing" behaviour when nothing
 * matches, so a portal that formats its options differently still works.
 */
async function selectAutocompleteOption(
  driver,
  input,
  text,
  description = "field",
  { timeout = 10000, matchWindow = 2000, appearTimeout = 5000 } = {}
) {
  await input.clear();
  await input.sendKeys(text);

  const normalize = (value) =>
    String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = normalize(text);
  // Same selector string for both findElements and the querySelectorAll below,
  // so the element list and the label list stay index-aligned.
  const OPTION_CSS =
    ".mat-mdc-autocomplete-panel mat-option, .cdk-overlay-pane mat-option, mat-option";
  const optionSelector = By.css(OPTION_CSS);

  const startedAt = Date.now();
  const deadline = startedAt + timeout;
  let firstSeenAt = null;

  while (Date.now() < deadline) {
    let options = [];
    try {
      options = await driver.findElements(optionSelector);
    } catch (lookupError) {
      options = [];
    }

    // Nothing has rendered yet — this field has no suggestion list. Give up on
    // the same budget the old code used rather than burning the full timeout.
    // Only bails when the list is genuinely still empty, so a slow lookup that
    // lands just after appearTimeout is still used.
    if (options.length === 0 && firstSeenAt === null && Date.now() - startedAt >= appearTimeout) {
      break;
    }

    if (options.length > 0) {
      if (firstSeenAt === null) firstSeenAt = Date.now();

      // Pick the option that best matches what we typed. Read every label in
      // ONE round-trip instead of a getText() per option.
      //
      // Ranking matters: a plain "contains either way" test lets a SHORTER
      // option win — typing "Chennai - North West" would match a "Chennai"
      // entry listed first and silently select the wrong RTO zone. So:
      //   3 = exact match
      //   2 = option contains everything we typed (prefer the shortest)
      //   1 = we typed more than the option shows (prefer the longest/most specific)
      let matched = null;
      try {
        // Read the labels off the SAME element handles we are about to click,
        // not a fresh querySelectorAll. A second document query could be taken
        // after Angular re-filtered the panel, and because Material reuses DOM
        // nodes via trackBy the handles would still be valid — so a positional
        // match could silently click an option with different text.
        const labels = await driver.executeScript(
          "return arguments[0].map(function (el) { return (el.innerText || el.textContent || ''); });",
          options
        );

        let bestIndex = -1;
        let bestScore = 0;
        let bestLength = 0;

        for (let i = 0; i < labels.length && i < options.length; i++) {
          const optionText = normalize(labels[i]);
          if (!optionText || !target) continue;

          let score = 0;
          if (optionText === target) score = 3;
          else if (optionText.includes(target)) score = 2;
          else if (target.includes(optionText)) score = 1;
          if (score === 0) continue;

          const better =
            score > bestScore ||
            (score === bestScore &&
              (score === 2
                ? optionText.length < bestLength   // tightest superset
                : optionText.length > bestLength)); // most specific subset

          if (bestIndex === -1 || better) {
            bestIndex = i;
            bestScore = score;
            bestLength = optionText.length;
          }
        }

        if (bestIndex !== -1) matched = options[bestIndex];
      } catch (readError) {
        // panel re-rendered mid-scan — next poll picks up the new list
      }

      // Click the match OUTSIDE the text-reading try. If this click fails
      // (intercepted by a backdrop, not yet interactable) we must retry the
      // match on the next poll — never silently fall through to "first
      // available option", which would pick the wrong value and report success.
      if (matched) {
        try {
          await matched.click();
          console.log(`Selected ${description} option matching "${text}".`);
          await waitForOverlayGone(driver, 2000);
          return true;
        } catch (clickError) {
          try {
            await driver.executeScript("arguments[0].click();", matched);
            console.log(`Selected ${description} option matching "${text}" (JS click).`);
            await waitForOverlayGone(driver, 2000);
            return true;
          } catch (jsClickError) {
            // still blocked — retry on the next poll rather than guessing
            await driver.sleep(100);
            continue;
          }
        }
      }

      // Options are showing but none matched. Give the list a moment to
      // finish filtering before falling back to the old behaviour.
      if (Date.now() - firstSeenAt >= matchWindow) {
        try {
          await options[0].click();
          console.log(
            `No exact match for ${description} "${text}", selected first available option.`
          );
          await waitForOverlayGone(driver, 2000);
          return true;
        } catch (clickError) {
          // fall through and retry on the next poll
        }
      }
    }

    await driver.sleep(100);
  }

  console.log(`Could not select ${description} from autocomplete, continuing...`);
  return false;
}

async function safeClick(driver, locator, timeout = 15000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  try {
    await el.click();
  } catch {
    await driver.executeScript("arguments[0].click();", el);
  }
}

async function safeType(driver, locator, text, timeout = 5000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  await driver.wait(until.elementIsEnabled(el), timeout);
  await el.clear();
  await el.sendKeys(text);
}

async function scrollAndClick(driver, locator, timeout = 5000) {
  const el = await driver.wait(until.elementLocated(locator), timeout);
  await driver.wait(until.elementIsVisible(el), timeout);
  const target = await driver.executeScript(`
    const element = arguments[0];
    if (!element) return null;
    const tag = (element.tagName || '').toLowerCase();
    if (['button', 'a'].includes(tag)) return element;
    const role = element.getAttribute ? element.getAttribute('role') : null;
    if (role && ['button', 'link'].includes(role)) return element;
    const buttonParent = element.closest ? element.closest('button, a, [role="button"], [role="link"]') : null;
    return buttonParent || element;
  `, el);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", target);
  await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
  try {
    await target.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", target);
  }
  return target;
}

/**
 * Click an element handle you have ALREADY validated, resolving the clickable
 * ancestor first (same walk scrollAndClick does for a locator).
 *
 * Use this instead of re-resolving a locator when the page renders more than
 * one match: until.elementLocated returns the first match in DOM order
 * regardless of visibility, which may not be the element you checked.
 */
async function scrollAndClickResolved(driver, element) {
  if (!element) {
    throw new Error("scrollAndClickResolved received null element");
  }
  const target = (await driver.executeScript(`
    const element = arguments[0];
    if (!element) return null;
    const tag = (element.tagName || '').toLowerCase();
    if (['button', 'a'].includes(tag)) return element;
    const role = element.getAttribute ? element.getAttribute('role') : null;
    if (role && ['button', 'link'].includes(role)) return element;
    const buttonParent = element.closest ? element.closest('button, a, [role="button"], [role="link"]') : null;
    return buttonParent || element;
  `, element)) || element;

  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", target);
  await driver.sleep(60);
  try {
    await target.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", target);
  }
  return target;
}

async function scrollAndClickElement(driver, element) {
  if (!element) {
    throw new Error("scrollAndClickElement received null element");
  }
  await driver.wait(until.elementIsVisible(element), 10000);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
  await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
  try {
    await element.click();
  } catch (clickError) {
    await driver.executeScript("arguments[0].click();", element);
  }
}

async function safeSelectOption(driver, dropdownLocator, optionText, timeout = 15000) {
  // Click on dropdown to open it
  await safeClick(driver, dropdownLocator, timeout);

  // Wait for the panel to actually render its options instead of guessing at
  // a fixed delay — returns as soon as the list is up, and keeps waiting if
  // the portal is slow to populate it.
  try {
    await driver.wait(
      until.elementLocated(
        By.css(".mat-mdc-select-panel mat-option, .cdk-overlay-pane mat-option, mat-option")
      ),
      Math.min(timeout, 10000)
    );
  } catch (panelError) {
    console.log("Dropdown panel did not render options in time, continuing...");
  }

  // Find and click the option with the specified text. The panel is confirmed
  // open by now, so a missing option is a genuine miss — no need to spend the
  // full timeout before trying the fallback below.
  try {
    const optionLocator = By.xpath(`//mat-option[contains(., '${optionText}')]`);
    await safeClick(driver, optionLocator, Math.min(timeout, 5000));
  } catch (optionError) {
    console.log(`Could not find option "${optionText}", listing available options...`);

    // List all available options
    try {
      const allOptions = await driver.findElements(By.css("mat-option"));
      console.log(`Found ${allOptions.length} available options:`);
      for (let i = 0; i < Math.min(allOptions.length, 10); i++) {
        const optText = await allOptions[i].getText();
        console.log(`  Option ${i}: "${optText}"`);
      }

      // Try clicking the specific option if it exists in the listed options
      const matchingOption = await driver.executeAsyncScript(`
        const options = arguments[0];
        const desired = arguments[1].trim().toLowerCase();
        const done = arguments[2];
        for (const opt of options) {
          const text = (opt.textContent || opt.innerText || '').trim().toLowerCase();
          if (text === desired) {
            done(opt);
            return;
          }
        }
        done(null);
      `, allOptions, optionText);

      if (matchingOption) {
        await driver.executeScript("arguments[0].click();", matchingOption);
        console.log(`Clicked matching option "${optionText}" from fallback list.`);
      } else {
        console.log(`Option "${optionText}" not present in fallback list; leaving selection unchanged.`);
      }
    } catch (listError) {
      console.log("Could not list options:", listError.message);
      throw optionError;
    }
  }

  // Close the dropdown panel by clicking outside, then wait for the overlay to
  // actually detach — otherwise the next field can be clicked through a
  // still-open backdrop. Condition-based, so it costs ~0 once it is closed.
  try {
    await driver.executeScript("document.body.click();");
    await waitForOverlayGone(driver, 3000);
  } catch (e) {
    console.log("Could not close dropdown, continuing...");
  }
}

async function enableSlideToggle(
  driver,
  toggleLocator,
  toggleDescription = "slide toggle"
) {
  const locatorList = Array.isArray(toggleLocator) ? toggleLocator : [toggleLocator];
  let locatedElement = null;
  let lastError = null;

  for (const locator of locatorList) {
    try {
      locatedElement = await driver.wait(until.elementLocated(locator), 5000);
      if (locatedElement) {
        console.log(`${toggleDescription} located using ${locator.toString()}`);
        break;
      }
    } catch (locError) {
      lastError = locError;
    }
  }

  if (!locatedElement) {
    throw lastError || new Error(`${toggleDescription} element not found`);
  }

  const slideToggle = await driver.executeScript(`
    const el = arguments[0];
    if (!el) return null;
    if (el.tagName && el.tagName.toLowerCase() === 'mat-mdc-slide-toggle') return el;
    const closestToggle = el.closest ? el.closest('mat-mdc-slide-toggle') : null;
    return closestToggle || el;
  `, locatedElement);

  if (!slideToggle) {
    throw new Error(`${toggleDescription} root slide-toggle element could not be resolved.`);
  }

  await driver.wait(until.elementIsVisible(slideToggle), 10000);
  await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", slideToggle);
  await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

  const isOn = await driver.executeScript(
    "const toggle = arguments[0]; return toggle.getAttribute && toggle.getAttribute('aria-checked') === 'true';",
    slideToggle
  );

  if (isOn) {
    console.log(`${toggleDescription} already ON.`);
    return slideToggle;
  }

  await driver.executeScript(`
    const toggle = arguments[0];
    const handleButton = toggle.querySelector('button.mdc-switch__handle');
    if (handleButton) {
      handleButton.click();
      return;
    }
    const nativeControl = toggle.querySelector('input.mdc-switch__native-control');
    if (nativeControl) {
      nativeControl.click();
      return;
    }
    const icons = toggle.querySelector('.mdc-switch__icons');
    if (icons) {
      icons.click();
      return;
    }
    toggle.click();
  `, slideToggle);

  await driver.sleep(400);
  return slideToggle;
}

async function openFinancierSection(driver) {
  try {
    console.log("Opening Financier Interest Applicable section if not visible...");
    // The heading is <mat-label class="mat-label-inline">, NOT a <span>, and it
    // is a plain sibling of the toggle inside a div.col-sm-12 — there is no
    // mat-expansion-panel around it. The old span-only xpath matched nothing
    // and burned its full 5s timeout on every job.
    const financierTab = By.xpath(
      "//mat-label[contains(normalize-space(.), 'Financier Interest Applicable')]" +
      " | //span[contains(normalize-space(.), 'Financier Interest Applicable')]"
    );
    const tabElement = await driver.wait(until.elementLocated(financierTab), 5000);
    const tabParent = await driver.executeScript("return arguments[0].closest('mat-expansion-panel') || arguments[0];", tabElement);

    if (tabParent) {
      const isExpanded = await driver.executeScript(`
        const panel = arguments[0];
        if (panel.hasAttribute && panel.hasAttribute('aria-expanded')) {
          return panel.getAttribute('aria-expanded') === 'true';
        }
        if (panel.classList && panel.classList.contains('mat-expanded')) {
          return true;
        }
        return false;
      `, tabParent);

      if (!isExpanded) {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", tabElement);
        await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
        await driver.executeScript("arguments[0].click();", tabElement);
        await driver.sleep(800);
      }
    } else {
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", tabElement);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
      await driver.executeScript("arguments[0].click();", tabElement);
      await driver.sleep(800);
    }
  } catch (e) {
    console.log("Financier section open helper failed (may already be visible):", e.message);
  }
}

async function openVehicleInformationSection(driver) {
  try {
    console.log("Ensuring Vehicle Information section is expanded...");
    const vehicleHeader = By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Vehicle Information')]]");
    const panelHeader = await driver.wait(until.elementLocated(vehicleHeader), 5000);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", panelHeader);
    await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
    // On this portal aria-expanded sits on the HEADER itself
    // (<mat-expansion-panel-header ... aria-expanded="false">), not on the
    // mat-expansion-panel — so check the header first.
    const readExpanded = async () =>
      driver.executeScript(`
        const header = arguments[0];
        if (header.hasAttribute && header.hasAttribute('aria-expanded')) {
          return header.getAttribute('aria-expanded') === 'true';
        }
        const panel = header.closest ? header.closest('mat-expansion-panel') : null;
        if (!panel) return true;
        if (panel.hasAttribute && panel.hasAttribute('aria-expanded')) {
          return panel.getAttribute('aria-expanded') === 'true';
        }
        return panel.classList && panel.classList.contains('mat-expanded');
      `, panelHeader);

    if (!(await readExpanded())) {
      console.log("Vehicle Information panel collapsed, expanding...");
      await driver.executeScript("arguments[0].click();", panelHeader);
      // Wait for it to actually open instead of guessing at 600ms.
      const opened = await driver
        .wait(async () => readExpanded(), 8000)
        .catch(() => false);
      console.log(`Vehicle Information panel expanded: ${opened}`);
    }
  } catch (e) {
    console.log("Vehicle Information expansion check failed:", e.message);
  }
}

/**
 * Captures error screenshot and uploads to S3 for National form errors
 */
async function captureErrorScreenshot(
  driver,
  error,
  data,
  errorStage = "unknown"
) {
  let screenshotUrl = null;
  let screenshotKey = null;
  let pageSourceUrl = null;
  let pageSourceKey = null;

  try {
    if (!driver) {
      console.log("⚠️  [National] No driver available for screenshot");
      return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
    }

    const screenshot = await driver.takeScreenshot();
    const jobIdentifier = data._jobIdentifier || `national_${Date.now()}`;
    const attemptNumber = data._attemptNumber || 1;

    // Generate S3 key and upload screenshot
    screenshotKey = generateScreenshotKey(
      jobIdentifier,
      attemptNumber,
      errorStage,
      "national"
    );

    screenshotUrl = await uploadScreenshotToS3(screenshot, screenshotKey);

    console.log(`📸 [National] Error screenshot captured: ${screenshotKey}`);
  } catch (screenshotError) {
    console.error("❌ [National] Failed to capture error screenshot:", screenshotError.message);
  }

  return { screenshotUrl, screenshotKey, pageSourceUrl, pageSourceKey };
}

/**
 * Checks for on-page validation errors (like Discount or IDV errors)
 * and takes a screenshot/throws an error if found.
 */
async function checkForValidationErrors(driver, data, stage) {
  try {
    console.log(`[National] Checking for validation errors at stage: ${stage}...`);

    // 1. Check for generic mat-error hints (catches Discount errors like "Maximum available discount(%):0")
    // Note: User explicitly requested to skip this check (2026-02-24)
    /*
    const errorHints = await driver.findElements(By.css("mat-hint.mat-error, .mat-mdc-form-field-error, .mat-error, .text-danger"));

    for (const hint of errorHints) {
      if (await hint.isDisplayed()) {
        const errorText = (await hint.getText()).trim();
        if (errorText) {
          console.error(`❌ [National] Validation error detected at ${stage}: ${errorText}`);

          // Capture screenshot before throwing
          const { screenshotUrl } = await captureErrorScreenshot(driver, new Error(errorText), data, `${stage}_validation_error`);

          const finalError = new Error(`Validation Error: ${errorText}`);
          finalError.screenshotUrl = screenshotUrl;
          finalError.stage = stage;
          throw finalError;
        }
      }
    }
    */

    // 2. specifically check for IDV error message which might be in a different container or class
    // Based on the screenshot, it's red text below the input: "IDV can't be less than XXXXX"
    const idvErrorXpath = "//mat-hint[contains(text(), \"IDV can't be less than\")] | //div[contains(@class, 'mat-error') and contains(text(), \"IDV can't be less than\")]";
    const idvErrors = await driver.findElements(By.xpath(idvErrorXpath));

    for (const error of idvErrors) {
      if (await error.isDisplayed()) {
        const errorText = (await error.getText()).trim();
        console.error(`❌ [National] IDV validation error detected: ${errorText}`);

        const { screenshotUrl } = await captureErrorScreenshot(driver, new Error(errorText), data, `${stage}_idv_error`);

        const finalError = new Error(`IDV Validation Error: ${errorText}`);
        finalError.screenshotUrl = screenshotUrl;
        finalError.stage = stage;
        throw finalError;
      }
    }

  } catch (err) {
    if (err.message.includes("Validation Error") || err.message.includes("IDV Validation Error")) {
      throw err; // Re-throw our custom validation errors
    }
    console.log(`[National] Error while checking for validation errors (ignored): ${err.message}`);
  }
}


/**
 * Beautifies technical Selenium errors into user-friendly messages for National
 * @param {Error|string} error - The original error
 * @returns {string} - User-friendly error message
 */

// The Vahan result popup, in PRIORITY order. <app-check-vahan-dialog> is the
// real component (it wraps the "Vahan Information" title, the .no-data-msg
// blocks and the field grid), so it is preferred — a plain querySelectorAll on
// a combined selector returns document order instead, which yields the outer
// mat-dialog-container and a scope wider than the popup itself.
const VAHAN_DIALOG_SELECTORS = [
  "app-check-vahan-dialog",
  ".cd-popup",
  "mat-dialog-container",
  ".mat-mdc-dialog-container",
];
// Flat form, for the bulk force-hide fallback.
const VAHAN_DIALOG_SELECTOR = VAHAN_DIALOG_SELECTORS.join(", ");

/** The visible Vahan popup element, or null. */
async function getVisibleVahanDialog(driver) {
  try {
    return await driver.executeScript(`
      const selectors = arguments[0];
      for (const selector of selectors) {
        const nodes = document.querySelectorAll(selector);
        for (const el of nodes) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (parseFloat(style.opacity || '1') < 0.05) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          return el;
        }
      }
      return null;
    `, VAHAN_DIALOG_SELECTORS);
  } catch (e) {
    return null;
  }
}

/**
 * Wait for the Vahan popup to be FULLY rendered — visible, loader finished,
 * and its fields actually populated (Vahan Vehicle Make / Remark fill in only
 * once the RTO response has been applied). Closing it before that would
 * discard the lookup.
 */
async function waitForVahanDialogReady(driver, jobId, timeout = 40000) {
  const deadline = Date.now() + timeout;

  // a) the popup itself must be on screen
  let dialog = null;
  while (Date.now() < deadline) {
    dialog = await getVisibleVahanDialog(driver);
    if (dialog) break;
    await driver.sleep(200);
  }
  if (!dialog) return null;
  console.log(`[${jobId}] Vahan popup is open, waiting for it to finish loading...`);

  // b) the loader must be finished
  await waitForPortalLoaderToDisappear(driver, Math.max(1000, deadline - Date.now()));

  // c) its fields must be populated. Bounded — some lookups legitimately come
  //    back with blank fields, so this must not block forever.
  const filled = await driver
    .wait(async () => {
      try {
        return await driver.executeScript(`
          const dialog = arguments[0];
          if (!dialog) return false;
          const inputs = dialog.querySelectorAll('input');
          for (const input of inputs) {
            if (input.value && input.value.trim() !== '') return true;
          }
          return false;
        `, dialog);
      } catch (e) {
        return false;
      }
    }, Math.min(10000, Math.max(1000, deadline - Date.now())))
    .catch(() => false);

  console.log(`[${jobId}] Vahan popup fully loaded (fields populated: ${filled})`);
  return dialog;
}

/**
 * Read the Vahan popup's failure message, if it shows one.
 *
 * The portal reports a failed lookup INSIDE the popup rather than as an HTTP
 * error, e.g.
 *   <div class="no-data-msg">The request successfully completed !!!.
 *    Please provide valid RegNo, EngineNo and ChassisNo.</div>
 * Note the wording says "successfully completed" even though no vehicle was
 * found — so any non-empty message here means the lookup did NOT return data.
 *
 * Returns the message text, or null when the lookup was fine.
 */
async function readVahanErrorMessage(driver, dialog) {
  try {
    return await driver.executeScript(`
      const dialog = arguments[0];
      const scope = dialog || document;
      const nodes = scope.querySelectorAll('.no-data-msg, .error-msg, .alert-danger, .text-danger');
      for (const el of nodes) {
        // The dialog ships BOTH messages and hides the inactive one on an
        // ANCESTOR (<div class="card-body" hidden>). getComputedStyle(el) on
        // the child still reports display:'block' in that case — display:none
        // on a parent does not appear in the child's own computed style — so
        // test LAYOUT instead: anything inside a hidden subtree has no client
        // rects. Without this the hidden "Please wait for some time..." text
        // was reported instead of the real error.
        if (el.closest && el.closest('[hidden]')) continue;
        if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity || '1') < 0.05) continue;
        const text = (el.innerText || el.textContent || '').trim();
        if (text) return text;
      }
      return null;
    `, dialog);
  } catch (e) {
    return null;
  }
}

/**
 * Close the Vahan popup via its X button and confirm it is gone.
 */
async function closeVahanDialog(driver, jobId, attempts = 4) {
  const closeLocators = [
    // ── Current markup: an Angular Material button labelled "Close" ─────────
    // The portal replaced <span class="cd-popup-close">X</span> with
    //   <button ...>
    //     <span class="mat-mdc-button-touch-target"></span>
    //     <span class="mdc-button__label">Close</span>
    //   </button>
    // so every legacy locator below missed and the popup was only ever
    // dismissed by the ESC / force-hide fallback at the end of this function.
    //
    // Target the BUTTON, never the label span: mat-mdc-button-touch-target is
    // an invisible overlay stretched across the button that would swallow a
    // click aimed at the label underneath it.
    By.xpath(
      "//mat-dialog-container//button[.//span[contains(@class,'mdc-button__label') and normalize-space(.)='Close']]"
    ),
    By.xpath(
      "//*[contains(@class,'mat-mdc-dialog-container')]//button[.//span[contains(@class,'mdc-button__label') and normalize-space(.)='Close']]"
    ),
    // Unscoped, so a renamed dialog container does not break this again. The
    // exact label still keeps it off unrelated buttons, and firstPresentLocator
    // only returns a VISIBLE match — the Vahan popup is modal, so nothing
    // behind it qualifies.
    By.xpath(
      "//button[.//span[contains(@class,'mdc-button__label') and normalize-space(.)='Close']]"
    ),
    By.xpath("//button[normalize-space(.)='Close']"),

    // ── Legacy markup, kept so an older portal build still closes ───────────
    By.css("span.cd-popup-close"),
    By.css(".cd-popup-close"),
    By.xpath("//span[contains(@class,'cd-popup-close')]"),
    By.xpath("//*[contains(@class,'cd-popup')]//span[normalize-space(.)='X']"),
  ];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (!(await getVisibleVahanDialog(driver))) {
      console.log(`[${jobId}] ✅ Vahan popup closed.`);
      return true;
    }

    const closeMatch = await firstPresentLocator(driver, closeLocators, 3000);
    if (!closeMatch) {
      console.log(`[${jobId}] Vahan close button not found on attempt ${attempt}.`);
    } else {
      try {
        await scrollAndClickResolved(driver, closeMatch.element);
        console.log(`[${jobId}] Clicked Vahan close [attempt ${attempt}]`);
      } catch (clickErr) {
        // Native click blocked by the overlay — go straight through the DOM.
        try {
          await driver.executeScript("arguments[0].click();", closeMatch.element);
        } catch (jsErr) {
          console.log(`[${jobId}] Vahan close click failed: ${jsErr.message}`);
        }
      }
    }

    // Give it a moment to animate out, then re-check.
    const gone = await driver
      .wait(async () => !(await getVisibleVahanDialog(driver)), 4000)
      .catch(() => false);
    if (gone) {
      console.log(`[${jobId}] ✅ Vahan popup closed.`);
      return true;
    }
  }

  // Last resort: press ESC, then force-hide so a leftover backdrop cannot
  // swallow the Calculate Premium click.
  try {
    await driver.actions().sendKeys(Key.ESCAPE).perform();
  } catch (e) { /* ignore */ }

  if (!(await getVisibleVahanDialog(driver))) {
    console.log(`[${jobId}] ✅ Vahan popup closed (ESC).`);
    return true;
  }

  console.log(`[${jobId}] ⚠️ Vahan popup would not close — force-hiding it.`);
  try {
    await driver.executeScript(`
      document.querySelectorAll(arguments[0]).forEach(function (el) {
        el.style.display = 'none';
        el.classList.remove('is-visible');
      });
      document.querySelectorAll('.cd-popup-container, .cdk-overlay-backdrop, .modal-backdrop')
        .forEach(function (el) { el.style.display = 'none'; });
      document.body.classList.remove('modal-open');
      document.body.style.overflow = '';
    `, VAHAN_DIALOG_SELECTOR);
  } catch (e) {
    console.log(`[${jobId}] Force-hide failed: ${e.message}`);
  }
  return false;
}

/**
 * Full "Check Vahan" step, in the order the portal actually requires:
 *   1. expand the "Vehicle Information" card (the button lives inside it and
 *      is not visible while it is collapsed)
 *   2. click the Check Vahan button
 *      (<span name="mcod_btn_addCover_01" class="badge badge-info checkbtn">)
 *   3. wait for the loader to finish
 *   4. wait for the Vahan Information popup to be fully rendered
 *   5. close it via <span class="cd-popup-close">X</span>
 *
 * Runs more than once per job: the discount percentage invalidates the earlier
 * lookup, so it is repeated before Calculate Premium.
 */
async function runCheckVahan(driver, jobId, label = "", data = {}) {
  const stage = label ? ` (${label})` : "";
  console.log(`[${jobId}] ===== Check Vahan${stage} =====`);

  try {
    // 1. The Check Vahan button sits inside the collapsible "Vehicle
    //    Information" card — expand it first or the button is not visible.
    await openVehicleInformationSection(driver);

    // 2. Click the button.
    const vahanLocators = [
      By.css("span[name='mcod_btn_addCover_01'].checkbtn"),
      By.css("span[name='mcod_btn_addCover_01']"),
      By.xpath("//span[contains(@class,'checkbtn') and normalize-space(.)='Check Vahan']"),
      By.name("mcod_btn_addCover_01"),
    ];

    const vahanMatch = await firstPresentLocator(driver, vahanLocators, 20000);
    if (!vahanMatch) {
      console.log(`[${jobId}] ⚠️ Check Vahan button not found — skipping${stage}.`);
      return false;
    }

    await scrollAndClickResolved(driver, vahanMatch.element);
    console.log(`[${jobId}] Clicked Check Vahan using: ${vahanMatch.locator.toString()}`);

    // 3 + 4. Loader runs, then the popup renders with the RTO response.
    const dialog = await waitForVahanDialogReady(driver, jobId);
    if (!dialog) {
      console.log(`[${jobId}] No Vahan popup appeared${stage} — continuing.`);
      await waitForPortalLoaderToDisappear(driver, 40000);
      return false;
    }

    // 5. If the popup reports a failed lookup, screenshot it (while the
    //    message is still on screen) and fail the job — continuing would
    //    submit a policy with unverified vehicle details.
    const vahanError = await readVahanErrorMessage(driver, dialog);
    if (vahanError) {
      console.error(`[${jobId}] ❌ Vahan lookup failed${stage}: ${vahanError}`);
      const err = new Error(vahanError);
      err.isVahanError = true;
      const { screenshotUrl } = await captureErrorScreenshot(
        driver,
        err,
        data,
        "vahan_lookup_failed"
      );
      err.screenshotUrl = screenshotUrl;
      err.stage = "check-vahan";
      throw err;
    }
    console.log(`[${jobId}] ✅ Vahan lookup returned valid data.`);

    // 6. No error — close it so the next step is not blocked by the overlay.
    await closeVahanDialog(driver, jobId);
    await waitForOverlayGone(driver, 3000);
    return true;
  } catch (e) {
    // A failed Vahan lookup must stop the job, not be swallowed like a
    // transient click problem.
    if (e && e.isVahanError) throw e;
    console.log(`[${jobId}] Check Vahan flow failed${stage}: ${e.message}`);
    return false;
  } finally {
    console.log(`[${jobId}] ===== Check Vahan${stage} done =====`);
  }
}

async function fillNationalForm(
  data = { username: "9364646564", password: "Pond@2123" }
) {
  const formData = data;
  const jobId = data._jobIdentifier || `national_${Date.now()}`;
  let jobBrowser = null;
  // Set in the catch below so the finally knows whether this job failed —
  // KEEP_BROWSER_OPEN_ON_ERROR only retains browsers for failed jobs.
  let hadError = false;
  let driver = null;
  let postSubmissionFailed = false;
  let postSubmissionError = null;
  let postCalculationFailed = false;
  let postCalculationError = null;

  try {
    console.log(`\n🚀 [${jobId}] Starting National Insurance job...`);

    // === STEP 0: Create fresh browser ===
    jobBrowser = await createNationalJobBrowser(jobId);
    driver = jobBrowser.driver;

    console.log(`✅ [${jobId}] National browser ready!`);

    // === STEP 1: Navigate to login page and login ===
    // National uses simple approach: every job logs in fresh
    console.log(`🌐 [${jobId}] Navigating to National login page...`);

    // PER-JOB login URL, from THIS job's resolved credential. CONFIG.LOGIN_URL
    // is one shared object mutated by every job — with parallel windows, job
    // B's write between our browser creation and this navigation sent job A to
    // job B's portal URL. It survives only as the fallback for a credential
    // saved without a loginUrl.
    const loginUrl = data.loginUrl || CONFIG.LOGIN_URL;

    try {
      console.log(`⏳ [${jobId}] Loading URL: ${loginUrl}`);
      // await driver.get("https://nicportal.nic.co.in/nicportal/signin/login");
      await driver.get(loginUrl);
      console.log(`✅ [${jobId}] Navigation successful!`);

      // Wait for the login page itself to render rather than a flat 3s. The
      // duplicated portal-loader call below was harmless when that helper was
      // a no-op, but now that it really waits it would double the timeout.
      await driver
        .wait(until.elementLocated(By.name("log_txtfield_iUsername_01")), 30000)
        .catch(() => {
          console.log(`[${jobId}] Login form not detected yet, continuing...`);
        });
      await waitForLoaderToDisappear(driver);
      await waitForPortalLoaderToDisappear(driver);

      const currentUrl = await driver.getCurrentUrl();
      console.log(`🌐 [${jobId}] Current URL after navigation: ${currentUrl}`);

      if (!currentUrl.includes("nicportal.nic.co.in")) {
        console.warn(`⚠️  [${jobId}] WARNING: Not on National portal! Current URL: ${currentUrl}`);
      }
    } catch (navError) {
      console.error(`❌ [${jobId}] Navigation failed:`, navError.message);
      throw new Error(`Failed to navigate to National portal: ${navError.message}`);
    }

    // === STEP 2: Perform login ===
    console.log(`🔐 [${jobId}] Starting login process...`);

    try {
      // Handle login form
      console.log(`[${jobId}] Filling login form...`);

      // Select INTERMEDIARY option
      try {
        // First, click on the specific dropdown to open it
        // Try multiple selectors for the dropdown
        let dropdown;
        try {
          dropdown = By.name("reg_dropdown_iType_02");
          await driver.wait(until.elementLocated(dropdown), 5000);
        } catch (e) {
          console.log("Name selector failed, trying ID selector...");
          try {
            dropdown = By.id("mat-select-4");
            await driver.wait(until.elementLocated(dropdown), 5000);
          } catch (e2) {
            console.log("ID selector failed, trying CSS selector...");
            dropdown = By.css("mat-select[role='combobox']");
            await driver.wait(until.elementLocated(dropdown), 5000);
          }
        }

        await safeClick(driver, dropdown, 10000);
        await driver.sleep(2000);

        // Check if dropdown is open and look for INTERMEDIARY option
        console.log("Looking for INTERMEDIARY option...");

        // Debug: List all available options
        try {
          const allOptions = await driver.findElements(By.css("mat-option"));
          console.log(`Found ${allOptions.length} options in dropdown`);
          for (let i = 0; i < allOptions.length; i++) {
            const optionText = await allOptions[i].getText();
            console.log(`Option ${i}: "${optionText}"`);
          }
        } catch (debugError) {
          console.log("Could not list options:", debugError.message);
        }

        const intermediaryOption = By.xpath("//mat-option[contains(., 'INTERMEDIARY')]");

        // Wait for the option to be available
        await driver.wait(until.elementLocated(intermediaryOption), 10000);
        await safeClick(driver, intermediaryOption, 10000);
        console.log("Selected INTERMEDIARY option");

        // Wait a bit for the selection to take effect
        await driver.sleep(1000);
      } catch (error) {
        console.log("INTERMEDIARY option not found or already selected:", error.message);

        // Try alternative approach - look for any option that contains "INTERMEDIARY"
        try {
          console.log("Trying alternative selector...");
          const altOption = By.xpath("//mat-option[contains(text(), 'INTERMEDIARY')]");
          await safeClick(driver, altOption, 5000);
          console.log("Selected INTERMEDIARY option with alternative selector");
        } catch (altError) {
          console.log("Alternative selector also failed:", altError.message);
        }
      }

      // Select second dropdown option (after INTERMEDIARY)
      try {
        console.log("Selecting second dropdown option...");

        // Wait a bit for the first selection to take effect
        await driver.sleep(2000);

        // Try to find and click the dropdown again
        let secondDropdown;
        try {
          secondDropdown = By.name("reg_dropdown_iType_02");
          await driver.wait(until.elementLocated(secondDropdown), 5000);
        } catch (e) {
          console.log("Name selector failed for second dropdown, trying ID selector...");
          try {
            secondDropdown = By.id("mat-select-4");
            await driver.wait(until.elementLocated(secondDropdown), 5000);
          } catch (e2) {
            console.log("ID selector failed for second dropdown, trying CSS selector...");
            secondDropdown = By.css("mat-select[role='combobox']");
            await driver.wait(until.elementLocated(secondDropdown), 5000);
          }
        }

        await safeClick(driver, secondDropdown, 10000);
        await driver.sleep(2000);

        // Debug: List all available options in the second dropdown
        try {
          const allOptions = await driver.findElements(By.css("mat-option"));
          console.log(`Found ${allOptions.length} options in second dropdown`);
          for (let i = 0; i < allOptions.length; i++) {
            const optionText = await allOptions[i].getText();
            console.log(`Second dropdown option ${i}: "${optionText}"`);
          }
        } catch (debugError) {
          console.log("Could not list second dropdown options:", debugError.message);
        }

        // Select BROKER POSP option specifically
        try {
          const brokerPospOption = By.xpath("//mat-option[contains(., 'BROKER POSP')]");
          await safeClick(driver, brokerPospOption, 10000);
          console.log("Selected BROKER POSP option");
        } catch (brokerError) {
          console.log("BROKER POSP option not found, trying alternative selector...");
          try {
            const altBrokerOption = By.xpath("//mat-option[contains(text(), 'BROKER POSP')]");
            await safeClick(driver, altBrokerOption, 10000);
            console.log("Selected BROKER POSP option with alternative selector");
          } catch (altBrokerError) {
            console.log("Alternative BROKER POSP selector also failed:", altBrokerError.message);
          }
        }

        // Wait for selection to take effect
        await driver.sleep(1000);

      } catch (error) {
        console.log("Second dropdown selection failed:", error.message);
      }

      // Fill username. `data` carries THIS job's resolved credential; the
      // shared CONFIG is only a fallback for a standalone CLI run.
      console.log(`[${jobId}] Looking for username field...`);
      const usernameField = By.name("log_txtfield_iUsername_01");
      await safeType(driver, usernameField, data.username || CONFIG.USERNAME, 10000);
      console.log(`[${jobId}] Filled username`);

      // Fill password
      console.log(`[${jobId}] Looking for password field...`);
      const passwordField = By.name("log_pwd_iPassword_01");
      await safeType(driver, passwordField, data.password || CONFIG.PASSWORD, 10000);
      console.log(`[${jobId}] Filled password`);

      // Click login button
      console.log(`[${jobId}] Looking for login button...`);
      const loginButton = By.name("log_btn_login_01");

      try {
        const buttonElement = await driver.wait(until.elementLocated(loginButton), 10000);
        console.log(`[${jobId}] Login button found`);

        await driver.wait(until.elementIsVisible(buttonElement), 10000);
        console.log(`[${jobId}] Login button is visible`);

        await driver.wait(until.elementIsEnabled(buttonElement), 10000);
        console.log(`[${jobId}] Login button is enabled`);

        try {
          await buttonElement.click();
          console.log(`✅ [${jobId}] Clicked login button (regular click)`);
        } catch (clickError) {
          console.log(`[${jobId}] Regular click failed, trying JavaScript click...`);
          await driver.executeScript("arguments[0].click();", buttonElement);
          console.log(`✅ [${jobId}] Clicked login button (JavaScript click)`);
        }
      } catch (buttonError) {
        console.error(`❌ [${jobId}] Failed to click login button:`, buttonError.message);
        throw new Error(`Failed to click login button: ${buttonError.message}`);
      }

      console.log(`[${jobId}] Waiting for login to complete...`);
      // Wait for the login page to actually go away rather than guessing at a
      // fixed delay: the username field disappearing (or the URL leaving
      // /signin/login) IS the success signal the verification below checks for.
      // A slow portal is still waited out, up to the full timeout.
      try {
        await driver.wait(async () => {
          try {
            const url = await driver.getCurrentUrl();
            if (url.includes("/signin/login")) return false;
            const stillOnLogin = await driver.findElements(
              By.name("log_txtfield_iUsername_01")
            );
            return stillOnLogin.length === 0;
          } catch (pollError) {
            return false; // mid-navigation — keep polling
          }
        }, 30000);
      } catch (loginWaitError) {
        console.log(`[${jobId}] Login did not complete in time, verifying...`);
      }
      await waitForPortalLoaderToDisappear(driver);

      // Verify login was successful
      const loginCheckUrl = await driver.getCurrentUrl();
      const loginCheckElements = await driver.findElements(By.name("log_txtfield_iUsername_01"));
      if (loginCheckElements.length > 0 || loginCheckUrl.includes("/signin/login")) {
        throw new Error("National login failed - still on login page after login attempt");
      }
      console.log(`✅ [${jobId}] Login successful!`);
    } catch (loginError) {
      console.error(`❌ [${jobId}] Login failed:`, loginError.message);
      throw loginError;
    }

    // Debug: Check what's on the page after login/session check
    try {
      const pageTitle = await driver.getTitle();
      console.log("Page title after login:", pageTitle);

      const currentUrl = await driver.getCurrentUrl();
      console.log("Current URL after login:", currentUrl);

      // Debug-only listing. Pulled in ONE round-trip instead of a getText()
      // call per link — the loop version cost ~10 browser round-trips purely
      // to write log lines.
      const linkInfo = await driver.executeScript(`
        const links = Array.from(document.querySelectorAll('a'));
        return {
          total: links.length,
          texts: links.slice(0, 10)
            .map(a => (a.innerText || a.textContent || '').trim())
            .filter(Boolean)
        };
      `);
      console.log(`Found ${linkInfo.total} links on the page`);
      linkInfo.texts.forEach((text, i) => console.log(`Link ${i}: "${text}"`));
    } catch (debugError) {
      console.log("Debug info after login failed:", debugError.message);
    }

    // Check for modal and close it if present
    console.log("Checking for modal after login...");
    try {
      // Try multiple modal close button selectors
      const modalSelectors = [
        By.css("button.close_flash"),
        By.css("button[data-dismiss='modal']"),
        By.css(".close"),
        By.css("[aria-label='Close']"),
        By.css("button[aria-label='Close']"),
        By.xpath("//button[contains(@class, 'close')]"),
        By.xpath("//button[contains(text(), '×')]"),
        By.xpath("//button[contains(text(), 'Close')]")
      ];

      // Poll all selectors together for a short window: returns the instant a
      // modal shows up (instead of always paying a flat 2s wait for one), and
      // still catches a modal that renders late.
      const modal = await firstPresentLocator(driver, modalSelectors, 2500);

      if (modal) {
        // Click the exact element we validated. Re-resolving via the locator
        // would re-run elementLocated, which returns the first DOM match
        // regardless of visibility — with broad selectors like ".close" that
        // can be a hidden button, leaving the real modal open.
        await scrollAndClickElement(driver, modal.element);
        console.log("Closed modal with selector:", modal.locator.toString());
        // Wait for the modal to actually detach before moving on.
        await driver.wait(until.stalenessOf(modal.element), 3000).catch(() => { });
      } else {
        console.log("No modal found or already closed");
      }
    } catch (error) {
      console.log("Modal handling failed:", error.message);
    }

    // Wait for the page to settle after modal close — real loader check
    // instead of a blind 3s.
    await waitForPortalIdle(driver);

    // Navigate to Motor Two Wheelers
    console.log("Navigating to Motor Two Wheelers...");

    // Debug: List some of the available links to find the right one
    try {
      // Debug-only listing, gathered in ONE round-trip. The previous loop made
      // a getText() AND a getAttribute() call per link for up to 30 links —
      // ~60 browser round-trips just to produce log output.
      const navInfo = await driver.executeScript(`
        const keywords = ['motor', 'two', 'wheeler', 'vehicle', 'premium'];
        const links = Array.from(document.querySelectorAll('a'));
        return {
          total: links.length,
          matches: links.slice(0, 30).map((a, i) => ({
            index: i,
            text: (a.innerText || a.textContent || '').trim(),
            href: a.getAttribute('href')
          })).filter(l => l.text && keywords.some(k => l.text.toLowerCase().includes(k)))
        };
      `);
      console.log(`Found ${navInfo.total} links on the page after login`);
      for (const link of navInfo.matches) {
        try {
          console.log(`Potential link ${link.index}: "${link.text}" -> ${link.href}`);
        } catch (e) {
          // Skip if can't log
        }
      }
    } catch (debugError) {
      console.log("Could not list links:", debugError.message);
    }

    // Check for expansion panels or menus that need to be opened
    try {
      const expansionPanels = await driver.findElements(By.css("mat-expansion-panel"));
      console.log(`Found ${expansionPanels.length} expansion panels`);

      if (expansionPanels.length > 0) {
        console.log("Expansion panels found - checking if any contain Motor insurance...");

        // Try to find and expand the Motor insurance panel
        for (let i = 0; i < expansionPanels.length; i++) {
          try {
            const panelText = await expansionPanels[i].getText();
            console.log(`Panel ${i}: "${panelText.substring(0, 100)}..."`);

            if (panelText.toLowerCase().includes('motor') || panelText.toLowerCase().includes('vehicle')) {
              console.log(`Found Motor panel at index ${i}`);
              // Check if panel is expanded
              const isExpanded = await expansionPanels[i].getAttribute('aria-expanded');
              console.log(`Panel ${i} expanded: ${isExpanded}`);

              if (isExpanded === 'false' || isExpanded === null) {
                // Click to expand
                await expansionPanels[i].click();
                console.log(`Expanded panel ${i}`);
                await driver.sleep(2000);
              }
              break;
            }
          } catch (panelError) {
            console.log(`Error checking panel ${i}:`, panelError.message);
          }
        }
      }
    } catch (expansionError) {
      console.log("No expansion panels found or error:", expansionError.message);
    }

    // Now try to find the Calculate Premium link for Two Wheelers
    console.log("Looking for Motor Two Wheelers menu item...");

    try {
      // Strategy: Use JavaScript to find elements and get their text
      console.log("Using JavaScript to find Calculate Premium links...");

      const result = await driver.executeScript(`
        // Find all links with "Calculate Premium" text
        const allLinks = Array.from(document.querySelectorAll('a'));
        const calculatePremiumLinks = allLinks.filter(link => 
          link.textContent.includes('Calculate Premium')
        );
        
        console.log('Found ' + calculatePremiumLinks.length + ' Calculate Premium links');
        
        // For each link, check if it's in a container with "Motor - Two Wheelers"
        for (let i = 0; i < calculatePremiumLinks.length; i++) {
          const link = calculatePremiumLinks[i];
          
          // Find parent with mega-menu-content or col-6
          let parent = link;
          while (parent && !parent.classList.contains('mega-menu-content') && !parent.classList.contains('col-6')) {
            parent = parent.parentElement;
          }
          
          if (parent) {
            const parentText = parent.textContent || parent.innerText;
            
            if (parentText.includes('Motor - Two Wheelers')) {
              console.log('Found Motor Two Wheelers Calculate Premium at index ' + i);
              return {
                found: true,
                index: i,
                element: link,
                parentText: parentText
              };
            }
          }
        }
        
        return { found: false, count: calculatePremiumLinks.length };
      `);

      console.log("JavaScript search result:", result);

      if (result.found) {
        console.log("Found the correct link! Clicking it...");

        // Get all Calculate Premium links
        const allLinks = await driver.findElements(By.xpath("//a[contains(text(), 'Calculate Premium')]"));

        if (allLinks.length > result.index) {
          // Scroll to the element
          await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", allLinks[result.index]);
          await driver.sleep(1000);

          // Try clicking it
          try {
            await allLinks[result.index].click();
            console.log("Clicked Calculate Premium for Motor Two Wheelers");
          } catch (clickError) {
            console.log("Direct click failed, using JavaScript click:", clickError.message);
            await driver.executeScript("arguments[0].click();", allLinks[result.index]);
            console.log("Clicked Calculate Premium using JavaScript");
          }
        } else {
          throw new Error("Link index out of bounds");
        }
      } else {
        console.log("Could not find Motor Two Wheelers. Trying alternative approach...");

        // Fallback: Try clicking by index (usually Two Wheelers is the 3rd option)
        const allLinks = await driver.findElements(By.xpath("//a[contains(text(), 'Calculate Premium')]"));
        console.log(`Found ${allLinks.length} Calculate Premium links`);

        if (allLinks.length >= 2) {
          console.log("Clicking Calculate Premium at index 2 (assuming Two Wheelers)...");
          await driver.executeScript("arguments[0].scrollIntoView({behavior: 'smooth', block: 'center'});", allLinks[2]);
          await driver.sleep(1000);
          await driver.executeScript("arguments[0].click();", allLinks[2]);
          console.log("Clicked Calculate Premium for Motor Two Wheelers (by index)");
        } else {
          throw new Error("Not enough Calculate Premium links found");
        }
      }

    } catch (error) {
      console.log("JavaScript approach failed, trying simple xpath:", error.message);

      // Final fallback: Just try to find and click the Calculate Premium link that's a sibling
      try {
        const calculatePremiumLink = By.xpath("//a[text()='Motor - Two Wheelers']/parent::div/following-sibling::a[contains(text(), 'Calculate Premium')]");
        await safeClick(driver, calculatePremiumLink, 5000);
        console.log("Clicked Calculate Premium using xpath fallback");
      } catch (xpathError) {
        console.log("All approaches failed:", xpathError.message);
        throw new Error("Could not find Calculate Premium link for Motor Two Wheelers");
      }
    }

    // Wait for form to load
    await waitForPortalIdle(driver);
    await waitForLoaderToDisappear(driver);

    // Select Vehicle Type
    console.log("Selecting Vehicle Type...");
    const vehicleTypeDropdown = By.name("mcy_dropdown_vehicleType_01");
    await safeSelectOption(driver, vehicleTypeDropdown, "New", 15000);

    // These dropdowns cascade — selecting one can trigger a reload of the
    // next. Wait on the loader instead of a flat 2s: if a request is in
    // flight we wait for all of it, and if not we move on immediately.
    await waitForPortalIdle(driver, 40000, 900);

    // Select Your Plan
    console.log("Selecting Your Plan...");
    try {
      const planDropdown = By.name("mcy_dropdown_planId_01");
      await safeSelectOption(driver, planDropdown, "OD With Long Term Act", 15000);
    } catch (planError) {
      console.log("Could not select plan option, trying alternative...");
      // Try different plan options
      try {
        const planDropdown = By.name("mcy_dropdown_planId_01");
        await safeSelectOption(driver, planDropdown, "Third Party", 15000);
      } catch (e) {
        console.log("Could not select any plan option");
      }
    }

    await waitForPortalIdle(driver, 40000, 900);

    // Select Class Of Vehicle
    console.log("Selecting Class Of Vehicle...");
    try {
      const vehicleClassDropdown = By.name("mcy_dropdown_vehcileClass_01");
      await safeSelectOption(driver, vehicleClassDropdown, "Motor cycle", 15000);
    } catch (vehicleClassError) {
      console.log("Could not select vehicle class option, trying alternative...");
      // Try different vehicle class options
      try {
        const vehicleClassDropdown = By.name("mcy_dropdown_vehcileClass_01");
        await safeSelectOption(driver, vehicleClassDropdown, "Motorcycle", 15000);
      } catch (e2) {
        console.log("Could not select any vehicle class option");
      }
    }

    await waitForPortalIdle(driver, 40000, 900);

    // ── "Not able to Find the required Model & Variant" ──────────────────────
    // Set on the Make & Model master and carried through the job payload. When
    // on, the portal's own non-GIC flow is used: tick the checkbox here, BEFORE
    // the RTO/make/model/variant fields, because ticking it disables the IDV
    // input and swaps in a Manufacturer's Selling Price field that the portal
    // derives the IDV from. RTO/make/model/variant are then filled exactly as
    // usual; only the IDV step below changes.
    const isModelNotFound =
      data.modelNotFound === true || data.modelNotFound === "true";

    console.log(
      `[${data._jobId || "National"}] Model not found flag: ${isModelNotFound} (raw: ${JSON.stringify(data?.modelNotFound)})`
    );

    if (isModelNotFound) {
      console.log(
        `[${data._jobId || "National"}] Model not found on the portal — enabling the non-GIC flow...`
      );
      try {
        // MUST target the native <input>, never By.name("isNonGICSelected"):
        // the <mat-checkbox> HOST carries the same name attribute and comes
        // first in document order, so By.name returns the wrapper. Reading
        // `.checked` on that returns undefined, which made every verify fail.
        // An `input` tag selector is unambiguous — mat-checkbox is not an input.
        const found = await firstPresentLocator(
          driver,
          [
            By.css("input.mdc-checkbox__native-control[name='isNonGICSelected']"),
            By.css("input[type='checkbox'][name='isNonGICSelected']"),
            By.css("input[name='isNonGICSelected']"),
          ],
          15000,
          // The native input inside a mat-checkbox is visually hidden, so
          // isDisplayed() is false even when the control is on screen.
          { requireVisible: false }
        );

        if (!found) {
          throw new Error(
            "Could not locate the 'Not able to Find the required Model & Variant' checkbox"
          );
        }

        const alreadyChecked = await driver.executeScript(
          "return !!arguments[0].checked;",
          found.element
        );

        if (alreadyChecked) {
          // Nothing was clicked, so no popup is raised — skip the dismissal
          // wait entirely rather than burning its timeout for nothing.
          console.log(
            `[${data._jobId || "National"}] Non-GIC checkbox already ticked.`
          );
        } else {
          // Click via JS: the native input is hidden behind the mat-checkbox
          // ripple, so a real click lands on the overlay instead.
          await driver.executeScript("arguments[0].click();", found.element);
          await driver.sleep(600);

          // The tick raises a confirmation popup. Dismiss it BEFORE re-reading
          // the checkbox: while it is open every click lands on its backdrop,
          // so the retry below could not work either.
          await dismissPortalDialog(
            driver,
            data._jobId || "National",
            "non-GIC confirmation popup"
          );

          let nowChecked = await driver.executeScript(
            "return !!arguments[0].checked;",
            found.element
          );

          if (!nowChecked) {
            // Fall back to the <label for="..."> that MDC renders — clicking it
            // is what a real user does. Deliberately NOT the <mat-checkbox>
            // host: if the first click did land, clicking the host would toggle
            // the box straight back off.
            const label = await driver
              .executeScript(
                "const el = arguments[0];" +
                "return el.id ? document.querySelector(`label[for='${el.id}']`) : null;",
                found.element
              )
              .catch(() => null);

            if (label) {
              await driver.executeScript("arguments[0].click();", label);
              await driver.sleep(600);
              await dismissPortalDialog(
                driver,
                data._jobId || "National",
                "non-GIC confirmation popup"
              );
              nowChecked = await driver.executeScript(
                "return !!arguments[0].checked;",
                found.element
              );
            }
          }

          if (!nowChecked) {
            throw new Error(
              "The non-GIC checkbox did not stay ticked after clicking it"
            );
          }
          console.log(
            `[${data._jobId || "National"}] ✅ Ticked the non-GIC checkbox.`
          );
        }

        // Ticking it re-renders the vehicle block (IDV out, selling price in).
        await waitForPortalIdle(driver, 40000, 900);
      } catch (nonGicError) {
        // Do not continue silently: without the checkbox the IDV field stays
        // enabled and required, and the run would fail later with a confusing
        // validation error instead of this one.
        console.log(
          `[${data._jobId || "National"}] ❌ Non-GIC checkbox step failed: ${nonGicError.message}`
        );
        await captureErrorScreenshot(driver, nonGicError, data, "non_gic_checkbox");
        throw nonGicError;
      }
    }

    // Fill RTO location (autocomplete field)
    console.log("Filling RTO location...");
    const rtoLocationField = By.name("mcy_dropdown_newRtoLocation_01");
    const rtoInput = await driver.wait(until.elementLocated(rtoLocationField), 15000);
    await driver.wait(until.elementIsVisible(rtoInput), 15000);
    await driver.wait(until.elementIsEnabled(rtoInput), 15000);

    // Type the RTO location (selectAutocompleteOption clears the field first)
    let rtoText = data.RTOCity || "Chennai";
    console.log("RTO Text: ", rtoText);
    if (data.RTORegion) {
      console.log("RTO Region found, using it");
      rtoText = `${data.RTOCity} - ${data.RTORegion}`;
    } else if (!data.RTOCity) {
      console.log("RTO City not found, using fallback");
      rtoText = "Chennai - North West";
    }
    await selectAutocompleteOption(driver, rtoInput, rtoText, "RTO location");

    // Fill make (autocomplete field)
    console.log("Filling make...");
    const makeField = By.name("mcy_dropdown_make_01");
    const makeInput = await driver.wait(until.elementLocated(makeField), 15000);
    await driver.wait(until.elementIsVisible(makeInput), 15000);
    await driver.wait(until.elementIsEnabled(makeInput), 15000);

    await selectAutocompleteOption(
      driver,
      makeInput,
      data.vehicleMake || "BAJAJ",
      "make"
    );

    // Wait for Model to load and fill it (autocomplete field)
    console.log("Filling model...");
    const modelField = By.name("mcy_dropdown_model_01");
    const modelInput = await driver.wait(until.elementLocated(modelField), 15000);
    await driver.wait(until.elementIsVisible(modelInput), 15000);
    await driver.wait(until.elementIsEnabled(modelInput), 15000);

    await selectAutocompleteOption(
      driver,
      modelInput,
      data.vehicleModel || "PULSAR 150 (2024-2025)", // Default model - Honda SHINE model variant
      "model"
    );

    // Wait for Variant to load and fill it (autocomplete field)
    console.log("Filling variant...");
    const variantField = By.name("mcy_dropdown_variant_01");
    const variantInput = await driver.wait(until.elementLocated(variantField), 15000);
    await driver.wait(until.elementIsVisible(variantInput), 15000);
    await driver.wait(until.elementIsEnabled(variantInput), 15000);

    await selectAutocompleteOption(
      driver,
      variantInput,
      data.vehicleVariant || "standard",
      "variant"
    );

    // The discount percentage USED to be filled here, before the IDV. The
    // portal recalculates the discount off the vehicle value, so typing an IDV
    // afterwards wiped whatever had just been entered. It now goes in after the
    // IDV block below, once the value the discount applies to is settled.

    await driver.sleep(1000);

    if (isModelNotFound) {
      // The non-GIC checkbox disabled the IDV input — the portal computes the
      // IDV itself from the Manufacturer's Selling Price. Fill the selling
      // price first, then re-enable the IDV field and write our own figure over
      // the derived one (see overridePortalDerivedIdv).
      console.log(
        `[${data._jobId || "National"}] Filling Manufacturer's Selling Price (IDV is portal-derived)...`
      );
      try {
        const sellingPrice =
          data.manufacturerSellingPrice || data.manufacturerSellingprice;

        if (!sellingPrice) {
          throw new Error(
            "modelNotFound is set but no manufacturerSellingPrice was supplied"
          );
        }

        // `pc_text_msp_01` is the portal's own name for this input. It only
        // exists once the non-GIC checkbox is ticked, hence the generous
        // timeout — the block re-renders after the tick. The label-based
        // fallback is there in case the portal renames the field.
        const found = await firstPresentLocator(
          driver,
          [
            By.name("pc_text_msp_01"),
            By.css("input[name='pc_text_msp_01']"),
            By.xpath(
              "//*[contains(normalize-space(.), \"Manufacturer's Selling Price\")]/following::input[not(@type='hidden')][1]"
            ),
          ],
          20000
        );

        if (!found) {
          throw new Error(
            "Could not locate the Manufacturer's Selling Price input (pc_text_msp_01)"
          );
        }

        await driver.wait(until.elementIsEnabled(found.element), 10000);
        await driver.executeScript(
          "arguments[0].scrollIntoView({block: 'center'});",
          found.element
        );
        await found.element.clear().catch(() => { });
        await found.element.sendKeys(String(sellingPrice));
        // Angular only commits the model on blur for this field; without it the
        // premium is calculated against an empty MSP.
        await driver.executeScript(
          "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));" +
          "arguments[0].dispatchEvent(new Event('blur', {bubbles:true}));",
          found.element
        );

        console.log(
          `[${data._jobId || "National"}] ✅ Filled Manufacturer's Selling Price: ${sellingPrice}`
        );
        await driver.sleep(1000); // Wait for potential error validation
        await checkForValidationErrors(driver, data, "selling_price_filling");
        await driver.sleep(500);

        // The selling price only seeds the portal's own IDV. The operator
        // typed an IDV of their own on our form (National keeps that field
        // open in model-not-found mode) — put it on the quote.
        await overridePortalDerivedIdv(driver, data);
      } catch (e) {
        if (e.message.includes("Validation Error")) throw e;
        console.log(
          `[${data._jobId || "National"}] ❌ Could not fill Manufacturer's Selling Price: ${e.message}`
        );
        await captureErrorScreenshot(driver, e, data, "selling_price_filling");
        // This is the ONLY source of the IDV in this mode — carrying on would
        // submit a quote with no vehicle value at all.
        throw e;
      }
    } else {
      // Fill IDV value from data (if provided)
      console.log("Filling IDV value from data...");
      try {
        const idvField = By.name("pc_text_idv_01");
        const idvValue = data.idv || data.idvValue || data.insuredDeclaredValue;

        if (idvValue) {
          await safeType(driver, idvField, String(idvValue), 10000);
          console.log(`✅ Filled IDV value: ${idvValue}`);
          await driver.sleep(1000); // Wait for potential error validation
          await checkForValidationErrors(driver, data, "idv_filling");
          await driver.sleep(500);
        } else {
          console.log("No IDV value provided in data, skipping...");
        }
      } catch (e) {
        if (e.message.includes("Validation Error")) throw e;
        console.log("Could not fill IDV field:", e.message);
      }
    }

    // Discount goes in only now, with the IDV settled — see
    // fillDiscountPercentage for why the order matters.
    await fillDiscountPercentage(driver, data);

    await driver.sleep(1000);

    // Compulsory PA for Owner Driver (Initial Setup - Quick Quote Stage)
    try {
      const isCompanyPA = (data.paCover === true || data.paCover === "true") && (String(data.paCoverCompany).toLowerCase() === "company");
      console.log(`[${data._jobId || 'National'}] Handling Compulsory PA (Initial Setup). isCompanyPA: ${isCompanyPA}`);

      let targetValue = "0"; // Default: No
      if (isCompanyPA) {
        // value="1" for 1 Year, value="3" for 5 Years
        targetValue = (data.paCoverYears === 5 || data.paCoverYears === "5") ? "3" : "1";
      }

      const paRadio = await driver.wait(until.elementLocated(By.xpath(`//mat-radio-group[@name='mcy_toggle_cpaCoverorBenefit_01']//mat-radio-button[@value='${targetValue}']`)), 5000).catch(() =>
        driver.wait(until.elementLocated(By.css(`mat-radio-button[value='${targetValue}']`)), 3000));

      if (paRadio) {
        const isAlreadyChecked = await driver.executeScript("return arguments[0].classList.contains('mat-mdc-radio-checked') || arguments[0].classList.contains('mat-radio-checked');", paRadio);
        if (!isAlreadyChecked) {
          try {
            const innerRadio = await paRadio.findElement(By.css("input.mdc-radio__native-control, input[type='radio']"));
            await driver.executeScript("arguments[0].click();", innerRadio);
          } catch (ce) {
            await driver.executeScript("arguments[0].click();", paRadio);
          }
          console.log(`[${data._jobId || 'National'}] ✅ Selected PA Radio (Initial): ${targetValue === "0" ? "No" : (targetValue === "1" ? "1 Year" : "5 Year")}`);
          await driver.sleep(1000);

          // Handle dialog if "No" was selected
          if (targetValue === "0") {
            try {
              console.log(`[${data._jobId || 'National'}] Checking for PA confirmation dialog...`);
              const closeBtnLocator = By.name("alert_btn_data_01");
              const closeBtn = await driver.wait(until.elementLocated(closeBtnLocator), 5000).catch(() => null);
              if (closeBtn && await closeBtn.isDisplayed()) {
                await driver.executeScript("arguments[0].click();", closeBtn);
                console.log(`[${data._jobId || 'National'}] ✅ Closed PA confirmation dialog.`);
                await driver.sleep(1000);
              }
            } catch (dialogErr) {
              console.log(`[${data._jobId || 'National'}] Note: PA dialog not found or already closed: ${dialogErr.message}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`[${data._jobId || 'National'}] Error handling Compulsory PA during initial setup: ${e.message}`);
    }

    await driver.sleep(1000);

    // Last chance to get our IDV onto the quote. Everything between the
    // selling-price step and here — the PA radio above especially — re-renders
    // the vehicle block, and the portal re-derives the IDV from the selling
    // price when it does. This puts our figure back if that happened, and is
    // silent when it did not.
    if (isModelNotFound) {
      const idvRewritten = await overridePortalDerivedIdv(driver, data, {
        reassert: true,
      });
      // Writing the IDV makes the portal recompute the discount off the new
      // value, so the figure entered above is gone again. Only re-enter it when
      // the IDV actually had to be rewritten — the usual case is a no-op.
      if (idvRewritten) {
        await fillDiscountPercentage(driver, data, {
          reason: "re-applying after IDV was restored",
        });
      }
    }

    // Click Generate Quick Quote button
    console.log("Clicking Generate Quick Quote button...");
    try {
      console.log("Looking for Generate Quick Quote button...");

      // Find the button by name (most reliable)
      const generateButton = By.name("mcy_button_quickQuote_01");
      const generateBtn = await driver.wait(until.elementLocated(generateButton), 15000);

      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(generateBtn), 10000);

      // Check if button is enabled
      const isEnabled = await generateBtn.isEnabled();
      console.log(`Generate Quick Quote button isEnabled: ${isEnabled}`);

      // Also check by checking the 'disabled' attribute
      const isDisabledAttr = await driver.executeScript("return arguments[0].hasAttribute('disabled');", generateBtn);
      console.log(`Generate Quick Quote button has disabled attribute: ${isDisabledAttr}`);

      // Get button text for debugging
      const buttonText = await driver.executeScript("return arguments[0].textContent || arguments[0].innerText;", generateBtn);
      console.log(`Generate Quick Quote button text: ${buttonText}`);

      // Scroll to button
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", generateBtn);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

      // Try multiple click strategies
      if (isEnabled && !isDisabledAttr) {
        // Button is enabled, try direct click first
        try {
          await generateBtn.click();
          console.log("Clicked Generate Quick Quote button (direct click)");
        } catch (e) {
          console.log("Direct click failed, trying JavaScript click:", e.message);
          // Fall back to JavaScript click
          await driver.executeScript("arguments[0].click();", generateBtn);
          console.log("Clicked Generate Quick Quote button (JavaScript click)");
        }
      } else {
        console.log("Generate Quick Quote button is disabled, attempting to force click with JavaScript...");
        // Force click with JavaScript even if disabled
        await driver.executeScript("arguments[0].click();", generateBtn);
        console.log("Force clicked Generate Quick Quote button with JavaScript");
      }

      console.log("Successfully clicked Generate Quick Quote button");
      // Wait for the quote request to actually finish (loader appears then
      // clears) instead of a flat 4s. Slow quotes are still waited out in full.
      await waitForPortalIdle(driver);

      // Post-click verification: If button still exists and is displayed, check for errors
      try {
        const stillExists = await driver.findElements(By.name("mcy_button_quickQuote_01"));
        if (stillExists.length > 0 && await stillExists[0].isDisplayed()) {
          console.log("[National] Generate Quick Quote button still visible after click, checking for validation errors...");
          await checkForValidationErrors(driver, data, "post_quote_generation_click_failure");
        }
      } catch (checkError) {
        console.log("[National] Post-click button check failed (might have transitioned):", checkError.message);
      }

      // Final generic validation check
      await checkForValidationErrors(driver, data, "post_quote_generation");
    } catch (e) {
      console.log("Generate Quick Quote button not found, trying alternative:", e.message);

      // Try alternative approach - find by button text
      try {
        const generateByText = By.xpath("//button[contains(., 'Generate Quick Quote')]");
        const generateBtn = await driver.wait(until.elementLocated(generateByText), 5000);
        await driver.executeScript("arguments[0].click();", generateBtn);
        console.log("Clicked Generate Quick Quote button (alternative)");
        await waitForPortalIdle(driver);
      } catch (e2) {
        console.log("All strategies failed for Generate Quick Quote button:", e2.message);
      }
    }

    // Extract IDV value after quote generation
    console.log("Extracting IDV value after quote generation...");
    let idvValue = null;
    try {
      // No fixed wait needed here — the "field has a value" poll a few lines
      // below is exactly the "wait for IDV to be populated" condition.
      // Find IDV input field by name
      const idvField = By.name("pc_text_idv_01");
      const idvInput = await driver.wait(until.elementLocated(idvField), 10000);

      // Wait for the field to have a value
      await driver.wait(async () => {
        const value = await idvInput.getAttribute('value');
        return value && value.trim() !== '';
      }, 15000);

      // Read whatever the portal ended up holding, in BOTH modes. In
      // model-not-found mode overridePortalDerivedIdv already wrote our own
      // figure here, but the portal may still have re-derived it from the
      // selling price — this read is what settles which number the quote
      // actually carries. Disabled inputs still expose `value`.
      idvValue = await idvInput.getAttribute('value');
      const overrodeIdv =
        isModelNotFound &&
        data.idv &&
        String(data.idv).replace(/[^0-9.]/g, "") ===
          String(idvValue).replace(/[^0-9.]/g, "");
      console.log(
        `✅ [${jobId}] IDV value extracted: ${idvValue}${isModelNotFound
          ? overrodeIdv
            ? " (our value, accepted by the portal)"
            : " (derived by the portal from the selling price)"
          : ""
        }`
      );

      // Store IDV in data object for later use
      data.idv = idvValue;

    } catch (idvError) {
      console.log(`⚠️ [${jobId}] Could not extract IDV value:`, idvError.message);
      // Continue execution even if IDV extraction fails
    }

    // === POST-QUOTE INTERACTIONS ===
    console.log("Handling post-quote interactions...");

    // Click OK button (if present).
    // The confirm dialog is optional, so instead of always paying a 5s timeout
    // when it does not appear, race it against the Convert Quote button that
    // comes next: whichever shows up first ends the wait. The dialog still
    // wins if both are present, so it can never be clicked through.
    const okButton = By.name("confirm_btn_yes_01");
    const convertButton = By.name("main_btn_convert_01");
    try {
      console.log("Looking for OK button...");
      // Give the confirm dialog its own window first. Racing it against the
      // Convert Quote button would usually lose — that button is already on
      // the quote screen, so the race would end before the dialog finished
      // animating in, and the later Convert click would fire underneath the
      // still-open backdrop.
      let okMatch = await firstPresentLocator(driver, [okButton], 3000);

      // No dialog yet: if Convert Quote is already available there is nothing
      // to confirm, otherwise keep waiting for the dialog a little longer.
      if (!okMatch) {
        const convertReady = await firstPresentLocator(driver, [convertButton], 0);
        if (!convertReady) {
          okMatch = await firstPresentLocator(driver, [okButton], 3000);
        }
      }

      if (okMatch) {
        await scrollAndClickElement(driver, okMatch.element);
        console.log("✅ Clicked OK button");
        // Wait for the dialog to detach rather than guessing at 1s.
        await driver.wait(until.stalenessOf(okMatch.element), 3000).catch(() => { });
        await waitForOverlayGone(driver, 2000);

        // NOW wait for the loader. While the popup was up the loader wait
        // deliberately bails (the portal is waiting on us, not working), so
        // this is the first point where the quote render can actually be
        // waited out — skipping it left Convert Quote still disabled.
        await waitForPortalIdle(driver, 40000, 800);
      } else {
        console.log("OK button not present at this stage, continuing...");
      }
    } catch (e) {
      console.log("OK button not found or not needed at this stage:", e.message);
    }

    // Click Convert Quote button
    try {
      console.log("Looking for Convert Quote button...");
      await driver.wait(until.elementLocated(convertButton), 15000);

      // The quote finishes rendering a moment AFTER the confirm popup is
      // dismissed, so the button is briefly present-but-disabled. The old
      // single snapshot check threw "visible but not clickable" on a perfectly
      // healthy run — poll until it really becomes clickable instead.
      // Re-located each pass so a re-render cannot leave us holding a stale
      // handle.
      const clickableConvertBtn = await driver
        .wait(async () => {
          const found = await driver.findElements(convertButton);
          for (const el of found) {
            try {
              if ((await el.isDisplayed()) && (await el.isEnabled())) return el;
            } catch (staleErr) {
              // re-render mid-check — next poll picks up the fresh element
            }
          }
          return null;
        }, 20000)
        .catch(() => null);

      if (clickableConvertBtn) {
        await scrollAndClickResolved(driver, clickableConvertBtn);
        console.log("✅ Clicked Convert Quote button");
        await waitForPortalIdle(driver);
      } else {
        throw new Error("Convert Quote button never became clickable (still disabled after waiting)");
      }
    } catch (e) {
      console.error(`❌ [National] Convert Quote button error: ${e.message}`);
      const { screenshotUrl } = await captureErrorScreenshot(driver, e, data, "convert_quote_failure");

      let friendlyMessage = "Convert Quote button not found. This usually means the quote was not generated correctly or there was a system delay.";
      if (e.name === "TimeoutError") {
        friendlyMessage = "The Convert Quote screen did not load in time. Please check the website status or the input data.";
      }

      const err = new Error(friendlyMessage);
      err.screenshotUrl = screenshotUrl;
      err.stage = "post-quote-generation";
      throw err;
    }

    // Click Create New Customer
    try {
      console.log("Looking for Create New Customer...");
      const createCustomerSpan = By.name("custmain_span_create_01");
      await safeClick(driver, createCustomerSpan, 5000);
      console.log("Clicked Create New Customer");
      // The KYC radio wait immediately below is the real "dialog is open"
      // signal, so no fixed wait is needed here.
    } catch (e) {
      console.log("Create New Customer not found:", e.message);
    }

    // Select Manual KYC radio button BEFORE filling customer form
    try {
      console.log("Selecting Manual KYC radio button...");

      // "mat-radio-21-input" is an AUTO-GENERATED Angular Material id — the
      // number comes from a global component counter, so it shifts whenever
      // the portal is rebuilt or an extra dialog is instantiated earlier in
      // the session. Waiting on it alone meant a silent 10s stall before the
      // stable locators below were ever tried. Race all three instead: this
      // IS the "dialog is open" wait, and whichever locator the current build
      // renders wins immediately.
      // STABLE locators first. The portal renders this radio with a drifting
      // auto-generated id (the sibling checkbox shows up as
      // mat-mdc-checkbox-40-input, not -4-), so the id is a last resort only.
      const kycLocators = [
        By.xpath("//input[@name='ekyc_sel_type' and @value='ManualKYC']"),
        By.css("mat-radio-button[value='ManualKYC'] input[type='radio']"),
        By.xpath("//mat-radio-button[contains(normalize-space(.), 'Manual KYC')]//input[@type='radio']"),
        By.id("mat-radio-21-input"),
      ];

      // requireVisible:false — the click below goes through executeScript, and
      // the radio can still be mid-animation inside the freshly-opened dialog.
      const kycMatch = await firstPresentLocator(driver, kycLocators, 15000, {
        requireVisible: false,
      });
      if (!kycMatch) {
        throw new Error("Manual KYC radio not found with any locator");
      }
      const inputElement = kycMatch.element;
      console.log(`Found Manual KYC radio using: ${kycMatch.locator.toString()}`);

      // Ensure it's in view
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", inputElement);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

      // Click using JS to avoid overlay/ripple issues in Angular Material
      await driver.executeScript("arguments[0].click();", inputElement);

      // Verify selected; if not, try clicking the associated label
      let isSelected = await driver
        .wait(async () => inputElement.isSelected().catch(() => false), 1500)
        .catch(() => false);

      if (!isSelected) {
        try {
          // Derive the label from the element's ACTUAL id rather than assuming
          // the generated one, for the same reason as above.
          const inputId = await inputElement.getAttribute("id");
          if (inputId) {
            const labelEl = await driver.wait(
              until.elementLocated(By.css(`label[for='${inputId}']`)),
              3000
            );
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", labelEl);
            await driver.sleep(60);
            await driver.executeScript("arguments[0].click();", labelEl);
            isSelected = await driver
              .wait(async () => inputElement.isSelected().catch(() => false), 1500)
              .catch(() => false);
          }
        } catch (labelErr) {
          console.log("Manual KYC label click fallback failed:", labelErr.message);
        }
      }
      console.log(`Manual KYC radio selected state: ${isSelected}`);
    } catch (e) {
      console.log("Manual KYC radio not found by id, trying alternative:", e.message);

      // Fallback 1: find by name/value
      try {
        const altByValue = By.xpath("//input[@name='ekyc_sel_type' and @value='ManualKYC']");
        const radioElement = await driver.wait(until.elementLocated(altByValue), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", radioElement);
        await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
        await driver.executeScript("arguments[0].click();", radioElement);
        console.log("Selected Manual KYC via name/value fallback");
        await driver.sleep(500);
      } catch (e2) {
        console.log("Manual KYC by name/value failed:", e2.message);

        // Fallback 2: click the mat-radio-button container by value attribute
        try {
          const matRadio = By.css("mat-radio-button[value='ManualKYC'] input[type='radio']");
          const radioInput = await driver.wait(until.elementLocated(matRadio), 5000);
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", radioInput);
          await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
          await driver.executeScript("arguments[0].click();", radioInput);
          console.log("Selected Manual KYC via mat-radio-button fallback");
          await driver.sleep(500);
        } catch (e3) {
          console.log("All strategies failed for Manual KYC radio:", e3.message);
        }
      }
    }

    // Tick the "KYC Verification is completed manually..." checkbox that the
    // Manual KYC radio reveals, BEFORE submitting the Create Customer dialog.
    try {
      console.log("Checking KYC verification (disclaimer) checkbox...");

      // name="vQuote_list_disclaimerAgree_01" is the STABLE attribute and is
      // listed first. The mat-mdc-checkbox-N-input id is an auto-generated
      // Material counter — on the live portal it renders as
      // mat-mdc-checkbox-40-input, not the -4- this code used to hardcode,
      // so it is only kept as a last-resort fallback.
      const disclaimerLocators = [
        By.name("vQuote_list_disclaimerAgree_01"),
        By.css("input[type='checkbox'][name='vQuote_list_disclaimerAgree_01']"),
        By.css("mat-checkbox[name='vQuote_list_disclaimerAgree_01'] input[type='checkbox']"),
        By.css("input[type='checkbox'][id^='mat-mdc-checkbox-']"),
      ];

      const disclaimerMatch = await firstPresentLocator(driver, disclaimerLocators, 10000, {
        requireVisible: false,
      });
      if (!disclaimerMatch) {
        throw new Error("Disclaimer checkbox not found with any locator");
      }
      const checkboxElement = disclaimerMatch.element;
      console.log(`Found KYC verification checkbox using: ${disclaimerMatch.locator.toString()}`);

      // Scroll to element
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", checkboxElement);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

      // Read the real checked state off the input itself.
      const readChecked = async () =>
        driver
          .executeScript("return arguments[0].checked === true;", checkboxElement)
          .catch(() => false);

      // Selecting Manual KYC can tick this box automatically. The old code
      // clicked unconditionally "to trigger events", which UNCHECKS an
      // already-ticked box and leaves KYC unconfirmed on submit. Only click
      // when it is actually unchecked.
      let isChecked = await readChecked();

      if (isChecked) {
        console.log("KYC verification checkbox already ticked — leaving it as is.");
      } else {
        await driver.executeScript("arguments[0].click();", checkboxElement);
        console.log("Clicked KYC verification checkbox");
        isChecked = await driver.wait(async () => readChecked(), 2000).catch(() => false);

        // Some Material builds only respond to the label/ripple, not the
        // hidden native input.
        if (!isChecked) {
          try {
            const inputId = await checkboxElement.getAttribute("id");
            const labelLocators = [];
            if (inputId) labelLocators.push(By.css(`label[for='${inputId}']`));
            labelLocators.push(
              By.xpath("//mat-checkbox[.//input[@name='vQuote_list_disclaimerAgree_01']]//label")
            );
            const labelMatch = await firstPresentLocator(driver, labelLocators, 2000, {
              requireVisible: false,
            });
            if (labelMatch) {
              await driver.executeScript("arguments[0].click();", labelMatch.element);
              isChecked = await driver.wait(async () => readChecked(), 2000).catch(() => false);
              console.log("Clicked KYC verification checkbox via its label");
            }
          } catch (labelErr) {
            console.log("KYC checkbox label fallback failed:", labelErr.message);
          }
        }
      }

      // Last resort: force the checked state and notify Angular, so the box
      // always ends up TICKED. Every path above is "make it checked" — none
      // of them can ever leave it unchecked.
      if (!isChecked) {
        try {
          await driver.executeScript(`
            const el = arguments[0];
            if (!el.checked) {
              el.checked = true;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          `, checkboxElement);
          isChecked = await driver.wait(async () => readChecked(), 1500).catch(() => false);
          if (isChecked) console.log("Forced KYC verification checkbox to checked.");
        } catch (forceErr) {
          console.log("Could not force KYC checkbox state:", forceErr.message);
        }
      }

      if (!isChecked) {
        console.log("⚠️ KYC verification checkbox could NOT be ticked — Submit will likely be rejected.");
      }
      console.log(`KYC verification checkbox isChecked: ${isChecked}`);
    } catch (e) {
      console.log("Disclaimer checkbox not found, trying alternative:", e.message);

      // Try alternative approach - find by name
      try {
        const altCheckbox = By.name("vQuote_list_disclaimerAgree_01");
        const checkboxElement = await driver.wait(until.elementLocated(altCheckbox), 5000);
        await driver.executeScript("arguments[0].click();", checkboxElement);
        console.log("Clicked disclaimer checkbox (alternative)");
        await driver.sleep(1000);
      } catch (e2) {
        console.log("All strategies failed for disclaimer checkbox:", e2.message);
      }
    }

    // === CLICK SUBMIT BUTTON BEFORE FILLING FORM ===
    console.log("Clicking Submit button before filling customer form...");
    try {
      console.log("Looking for Submit button...");

      // Find the submit button by name (most reliable)
      const submitButton = By.name("newCust_btn_createCust_01");
      const submitBtn = await driver.wait(until.elementLocated(submitButton), 10000);

      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(submitBtn), 10000);

      // Check if button is enabled
      const isEnabled = await submitBtn.isEnabled();
      console.log(`Submit button isEnabled: ${isEnabled}`);

      // Also check by checking the 'disabled' attribute
      const isDisabledAttr = await driver.executeScript("return arguments[0].hasAttribute('disabled');", submitBtn);
      console.log(`Submit button has disabled attribute: ${isDisabledAttr}`);

      // Get button text for debugging
      const buttonText = await driver.executeScript("return arguments[0].textContent || arguments[0].innerText;", submitBtn);
      console.log(`Submit button text: ${buttonText}`);

      // Scroll to button
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", submitBtn);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

      // Try multiple click strategies
      if (isEnabled && !isDisabledAttr) {
        // Button is enabled, try direct click first
        try {
          await submitBtn.click();
          console.log("Clicked Submit button (direct click)");
        } catch (e) {
          console.log("Direct click failed, trying JavaScript click:", e.message);
          // Fall back to JavaScript click
          await driver.executeScript("arguments[0].click();", submitBtn);
          console.log("Clicked Submit button (JavaScript click)");
        }
      } else {
        console.log("Submit button is disabled, attempting to force click with JavaScript...");
        // Force click with JavaScript even if disabled
        await driver.executeScript("arguments[0].click();", submitBtn);
        console.log("Force clicked Submit button with JavaScript");
      }

      console.log("Successfully clicked Submit button");
      // Wait for the submit round-trip to actually finish rather than a flat 3s.
      await waitForPortalIdle(driver, 40000, 600);
    } catch (e) {
      console.log("Submit button not found before form fill, continuing anyway:", e.message);
    }

    // === FILL CUSTOMER FORM ===
    console.log("Filling customer information...");

    // Fill Title (autocomplete)
    try {
      console.log("Filling Title...");
      const titleField = By.name("newcust_textfield_title_01");
      const titleInput = await driver.wait(until.elementLocated(titleField), 10000);
      await driver.wait(until.elementIsVisible(titleInput), 10000);

      // Type the value - default to "Mr" if not provided
      const title = ("Mr").trim() || "Mr";
      await selectAutocompleteOption(driver, titleInput, title, "Title");
    } catch (e) {
      console.log("Could not fill Title:", e.message);
    }

    // Fill First Name
    try {
      console.log(`[${jobId}] Filling First Name...`);
      const firstNameField = By.name("newcust_textfield_firstName_01");

      // Get firstName - handle cases where it might be fullName or need splitting
      let firstName = data.firstName || data.fullName;

      // Validate and process firstName
      if (!firstName || typeof firstName !== 'string') {
        console.log(`[${jobId}] No firstName in data, using default "Test"`);
        firstName = "Test";
      } else {
        // If firstName contains spaces, it might be a full name - take first part
        if (firstName.includes(" ")) {
          firstName = firstName.trim().split(" ")[0];
          console.log(`[${jobId}] Extracted first name from full name: "${firstName}"`);
        }

        // Ensure we have a valid value after processing
        firstName = firstName.trim();
        if (!firstName) {
          console.log(`[${jobId}] firstName is empty after processing, using default "Test"`);
          firstName = "Test";
        }
      }

      console.log(`[${jobId}] Using First Name: "${firstName}"`);

      // Wait for field to be available
      const firstNameInput = await driver.wait(until.elementLocated(firstNameField), 10000);
      await driver.wait(until.elementIsVisible(firstNameInput), 10000);
      await driver.wait(until.elementIsEnabled(firstNameInput), 10000);

      // Clear and type
      await firstNameInput.clear();
      await firstNameInput.sendKeys(firstName);

      console.log(`[${jobId}] ✅ Successfully filled First Name: "${firstName}"`);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (First Name):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill First Name. ${e.message}`);
    }

    // Fill Middle Name (optional)
    try {
      console.log("Filling Middle Name...");
      const middleNameField = By.name("newcust_textfield_middleName_01");
      const middleName = data.middleName || "";
      if (middleName) {
        await safeType(driver, middleNameField, middleName, 10000);
      }
    } catch (e) {
      console.log("Could not fill Middle Name:", e.message);
    }

    // Fill Last Name
    try {
      console.log("Filling Last Name...");
      const lastNameField = By.name("newcust_textfield_lastName_01");
      const lastName = data.lastName || data.surname || "Customer";
      await safeType(driver, lastNameField, lastName, 10000);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Last Name):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Last Name. ${e.message}`);
    }

    // Select Gender
    try {
      console.log("Selecting Gender...");
      const genderDropdown = By.name("newcust_dropdown_gender_01");
      let gender = data.gender || "male";

      // Normalize gender to Title Case to avoid partial match issues (e.g. "male" matching "Female")
      if (typeof gender === 'string') {
        const lower = gender.toLowerCase();
        if (lower === 'male' || lower === 'm') gender = "Male";
        else if (lower === 'female' || lower === 'f') gender = "Female";
      }

      console.log(`[Gender Selection] Target: "${gender}"`);

      // Open dropdown
      await safeClick(driver, genderDropdown, 10000);
      await driver.sleep(1000);

      // Use strict XPath to find the option
      try {
        const strictXpath = `//mat-option[normalize-space(.)='${gender}']`;
        const optionEl = await driver.wait(until.elementLocated(By.xpath(strictXpath)), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", optionEl);
        await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
        await optionEl.click();
        console.log(`[Gender Selection] Selected "${gender}" using strict match.`);
      } catch (e) {
        console.log(`[Gender Selection] Strict match failed for "${gender}". Error: ${e.message}`);

        // Fallback: List options to debug and try JS match
        try {
          const options = await driver.findElements(By.css("mat-option"));
          console.log(`[Gender Selection] Found ${options.length} options:`);
          for (const opt of options) {
            const text = await opt.getText();
            console.log(`- "${text}"`);

            if (text.trim() === gender) {
              await opt.click();
              console.log(`[Gender Selection] Clicked "${text}" via JS loop.`);
              // break loop after click? Yes, but we need to be careful about stale elements if click changes DOM.
              // usually fine for dropdowns.
              break;
            }
          }
        } catch (listErr) {
          console.log(`[Gender Selection] Error listing options: ${listErr.message}`);
        }
      }

      // Ensure dropdown is closed
      try {
        await driver.executeScript("document.body.click();");
      } catch (e) { }
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Gender):`, e.message);
      throw new Error(`Mandatory Field Error: Could not select Gender. ${e.message}`);
    }

    // Fill Occupation (autocomplete)
    try {
      console.log("Filling Occupation...");
      const occupationField = By.name("newcust_textfield_occupation_01");
      const occupationInput = await driver.wait(until.elementLocated(occupationField), 10000);
      await driver.wait(until.elementIsVisible(occupationInput), 10000);

      // Type the value
      const occupation = data.occupation || "Engineer";
      await occupationInput.click();
      await selectAutocompleteOption(driver, occupationInput, occupation, "Occupation");
    } catch (e) {
      console.log("Could not fill Occupation:", e.message);
    }

    // Fill Date of Birth
    try {
      console.log("Filling Date of Birth...");
      const dobField = By.name("newcust_datepicker_dob_01");
      const dobInput = await driver.wait(until.elementLocated(dobField), 10000);
      // Format: DD/MM/YYYY or MM/DD/YYYY - try to parse from data
      let dob = "01/01/1990"; // default
      if (data.dob) {
        // If dob is in DD-MM-YYYY format, convert to DD/MM/YYYY
        dob = data.dob.replace(/-/g, "/");
      } else if (data.dateOfBirth) {
        // Try to format dateOfBirth
        const date = new Date(data.dateOfBirth);
        if (!isNaN(date.getTime())) {
          const day = String(date.getDate()).padStart(2, '0');
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const year = date.getFullYear();
          dob = `${day}/${month}/${year}`;
        }
      }
      await dobInput.sendKeys(dob);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Date of Birth):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Date of Birth. ${e.message}`);
    }

    // Fill Aadhaar Number
    try {
      console.log("Filling Aadhaar Number...");
      const aadharField = By.name("newcust_textfield_aadharNo_01");

      // Determine value from available data keys; fallback to a valid-looking default starting 2-9
      const rawAadhaar = data.aadhaarNumber || data.aadhaar || data.aadhar || data.aadharNo || "234567890123";
      // Normalize: digits only, max 12
      let aadhaar = String(rawAadhaar).replace(/\D/g, '').slice(0, 12);
      // Ensure 12 digits and first digit 2-9 per pattern
      if (aadhaar.length !== 12 || !/^[2-9]/.test(aadhaar)) {
        console.log("Provided Aadhaar invalid/short; using fallback pattern-compliant placeholder.");
        aadhaar = "234567890123";
      }

      await safeType(driver, aadharField, aadhaar, 10000);
      await driver.sleep(300);
    } catch (e) {
      console.log("Could not fill Aadhaar Number:", e.message);
    }

    // Click on Address Information accordion to expand
    try {
      console.log("Expanding Address Information...");

      // Try multiple strategies to expand the accordion
      let addressPanel = null;

      // Strategy 1: Find by expansion panel header text
      try {
        const addressHeader = By.xpath("//mat-expansion-panel-header//h4[contains(., 'Address Information')]");
        addressPanel = await driver.wait(until.elementLocated(addressHeader), 5000);
        console.log("Found Address Information header");
      } catch (e) {
        console.log("Could not find Address Information by header, trying alternative...");
      }

      // Strategy 2: Find by mat-expansion-panel that contains Address Information text
      if (!addressPanel) {
        try {
          const panelXpath = By.xpath("//mat-expansion-panel[.//text()[contains(., 'Address Information')]]//mat-expansion-panel-header");
          addressPanel = await driver.wait(until.elementLocated(panelXpath), 5000);
          console.log("Found Address Information by panel");
        } catch (e) {
          console.log("Could not find Address Information by panel");
        }
      }

      if (addressPanel) {
        // Check if already expanded
        const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", addressPanel);
        console.log(`Address Information panel isExpanded: ${isExpanded}`);

        if (!isExpanded) {
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", addressPanel);
          await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
          await driver.executeScript("arguments[0].click();", addressPanel);
          console.log("Expanded Address Information panel");
          await driver.sleep(1000);
        } else {
          console.log("Address Information panel already expanded");
        }
      } else {
        console.log("Could not locate Address Information panel");
      }
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Section Error (Address Information):`, e.message);
      throw new Error(`Mandatory Section Error: Could not expand Address Information. ${e.message}`);
    }

    // Fill House No/ Bldg. Name (concatenated fields as requested)
    try {
      console.log("Filling House Number from DB data...");
      const houseNoField = By.name("newcust_textfield_building_01");

      // Concatenate flatDoorNo, floorNo, buildingName
      const houseParts = [data.flatDoorNo, data.floorNo, data.buildingName]
        .filter(part => part && String(part).trim().length > 0);

      // Fallback to original logic if specific fields are empty, or just use what we have
      let houseNoValue = houseParts.join(", ");

      // If the specific combination is empty, try the old fallback chain just in case
      if (!houseNoValue) {
        houseNoValue = data.premisesName || data.flatNo || "";
      }

      if (houseNoValue && String(houseNoValue).trim()) {
        await safeType(driver, houseNoField, String(houseNoValue).trim(), 10000);
      } else {
        console.log("Skipping House Number: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill House Number:", e.message);
    }

    // Fill Street/Colony (concatenated fields as requested)
    try {
      console.log("Filling Street from DB data...");
      const streetField = By.name("newcust_textfield_street_01");

      // Concatenate blockName, roadStreetLane
      const streetParts = [data.blockName, data.roadStreetLane]
        .filter(part => part && String(part).trim().length > 0);

      let streetValue = streetParts.join(", ");

      // Fallback if empty
      if (!streetValue) {
        streetValue = data.road || data.street || "";
      }

      if (streetValue && String(streetValue).trim()) {
        await safeType(driver, streetField, String(streetValue).trim(), 10000);
      } else {
        console.log("Skipping Street: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Street:", e.message);
    }

    // Fill Pincode (only from DB data)
    try {
      console.log("Filling Pincode from DB data...");
      const pincodeField = By.name("newcust_textfield_pincode_01");
      const pincode = data.pincode || data.pinCode;
      if (pincode && String(pincode).trim()) {
        await safeType(driver, pincodeField, String(pincode).trim(), 10000);
      } else {
        console.log("Skipping Pincode: no DB value provided.");
      }
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Pincode):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Pincode. ${e.message}`);
    }

    // Fill Locality (only from DB data)
    try {
      console.log("Filling Locality from DB data...");
      const localityField = By.name("newcust_textfield_locality_01");
      const locality = data.locality || data.area || "chennai";
      if (locality && String(locality).trim()) {
        await safeType(driver, localityField, String(locality).trim(), 10000);
      } else {
        console.log("Skipping Locality: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Locality:", e.message);
    }

    // Fill City (only from DB data)
    try {
      console.log("Filling City from DB data...");
      const cityField = By.name("newcust_textfield_city_01");
      const city = data.city || data.rtoCityLocation;
      if (city && String(city).trim()) {
        await safeType(driver, cityField, String(city).trim(), 10000);
      } else {
        console.log("Skipping City: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill City:", e.message);
    }

    // Fill District (only from DB data)
    try {
      console.log("Filling District from DB data...");
      const districtField = By.name("newcust_textfield_district_01");
      const district = data.district || data.city;
      if (district && String(district).trim()) {
        await safeType(driver, districtField, String(district).trim(), 10000);
      } else {
        console.log("Skipping District: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill District:", e.message);
    }

    // Fill State (only from DB data)
    try {
      console.log("Filling State from DB data...");
      const stateField = By.name("newcust_textfield_state_01");
      const state = data.state || data.stateName;
      if (state && String(state).trim()) {
        await safeType(driver, stateField, String(state).trim(), 10000);
      } else {
        console.log("Skipping State: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill State:", e.message);
    }

    // Fill Country (only from DB data)
    try {
      console.log("Filling Country from DB data...");
      const countryField = By.name("newcust_textfield_country_01");
      const country = data.country;
      if (country && String(country).trim()) {
        await safeType(driver, countryField, String(country).trim(), 10000);
      } else {
        console.log("Skipping Country: no DB value provided.");
      }
    } catch (e) {
      console.log("Could not fill Country:", e.message);
    }

    // Expand Communication Information accordion
    try {
      console.log("Expanding Communication Information...");

      // Try multiple strategies to expand the accordion
      let communicationPanel = null;

      // Strategy 1: Find by expansion panel header text
      try {
        const communicationHeader = By.xpath("//mat-expansion-panel-header//h4[contains(., 'Communication Information')]");
        communicationPanel = await driver.wait(until.elementLocated(communicationHeader), 5000);
        console.log("Found Communication Information header");
      } catch (e) {
        console.log("Could not find Communication Information by header, trying alternative...");
      }

      // Strategy 2: Find by mat-expansion-panel that contains Communication Information text
      if (!communicationPanel) {
        try {
          const panelXpath = By.xpath("//mat-expansion-panel[.//text()[contains(., 'Communication')]]//mat-expansion-panel-header");
          communicationPanel = await driver.wait(until.elementLocated(panelXpath), 5000);
          console.log("Found Communication Information by panel");
        } catch (e) {
          console.log("Could not find Communication Information by panel");
        }
      }

      if (communicationPanel) {
        // Check if already expanded
        const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", communicationPanel);
        console.log(`Communication Information panel isExpanded: ${isExpanded}`);

        if (!isExpanded) {
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", communicationPanel);
          await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
          await driver.executeScript("arguments[0].click();", communicationPanel);
          console.log("Expanded Communication Information panel");
          await driver.sleep(1000);
        } else {
          console.log("Communication Information panel already expanded");
        }
      } else {
        console.log("Could not locate Communication Information panel");
      }
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Section Error (Communication Information):`, e.message);
      throw new Error(`Mandatory Section Error: Could not expand Communication Information. ${e.message}`);
    }

    // Fill Email ID
    try {
      console.log("Filling Email ID...");
      const emailField = By.name("newcust_textfield_email_01");
      const emailInput = await driver.wait(until.elementLocated(emailField), 10000);
      await driver.wait(until.elementIsVisible(emailInput), 10000);

      // Clear any existing text
      await emailInput.clear();

      // Type the email value
      const email = data.email || "test@example.com";
      await emailInput.sendKeys(email);
      console.log("Successfully filled Email ID");

      await driver.sleep(500);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Email ID):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Email ID. ${e.message}`);
    }

    // Fill Mobile No
    try {
      console.log("Filling Mobile No...");
      const mobileField = By.name("newcust_textfield_mobNo_01");
      const mobile = data.mobile || data.mobileNumber || "9876543210";
      await safeType(driver, mobileField, String(mobile), 10000);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Mobile No):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Mobile No. ${e.message}`);
    }

    await driver.sleep(1000);

    // === CLICK CREATE CUSTOMER BUTTON AFTER FORM FILL ===
    console.log("Clicking Create Customer button after filling form...");
    try {
      console.log("Looking for Create Customer button...");

      // Find the button by name (most reliable)
      const createCustomerButton = By.name("newCust_btn_createCust_01");
      const createCustBtn = await driver.wait(until.elementLocated(createCustomerButton), 10000);

      // Wait for button to be visible and enabled
      await driver.wait(until.elementIsVisible(createCustBtn), 10000);

      // Check if button is enabled
      const isEnabled = await createCustBtn.isEnabled();
      console.log(`Create Customer button isEnabled: ${isEnabled}`);

      // Also check by checking the 'disabled' attribute
      const isDisabledAttr = await driver.executeScript("return arguments[0].hasAttribute('disabled');", createCustBtn);
      console.log(`Create Customer button has disabled attribute: ${isDisabledAttr}`);

      // Get button text for debugging
      const buttonText = await driver.executeScript("return arguments[0].textContent || arguments[0].innerText;", createCustBtn);
      console.log(`Create Customer button text: ${buttonText}`);

      // Scroll to button
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", createCustBtn);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

      // Try multiple click strategies
      if (isEnabled && !isDisabledAttr) {
        // Button is enabled, try direct click first
        try {
          await createCustBtn.click();
          console.log("Clicked Create Customer button (direct click)");
        } catch (e) {
          console.log("Direct click failed, trying JavaScript click:", e.message);
          // Fall back to JavaScript click
          await driver.executeScript("arguments[0].click();", createCustBtn);
          console.log("Clicked Create Customer button (JavaScript click)");
        }
      } else {
        console.log("Create Customer button is disabled, attempting to force click with JavaScript...");
        // Force click with JavaScript even if disabled
        await driver.executeScript("arguments[0].click();", createCustBtn);
        console.log("Force clicked Create Customer button with JavaScript");
      }

      console.log("Successfully clicked Create Customer button");
      // Customer creation is a server round-trip — wait for it, not a flat 3s.
      await waitForPortalIdle(driver, 40000, 600);

      // The portal answers this click with EITHER the dynamic "Locality Name"
      // field OR an alert popup. waitForPortalIdle returns as soon as a popup
      // shows (the portal is then waiting on us), so on its own it can hand
      // back control BEFORE the locality field has rendered — which silently
      // skipped filling it. Wait for whichever response actually arrives.
      const createCustomerResponse = await firstPresentLocator(
        driver,
        [
          By.name("newcust_textfield_locality_name_01"),
          By.name("alert_btn_data_01"),
        ],
        20000
      );
      if (createCustomerResponse) {
        console.log(
          `Create Customer responded with: ${createCustomerResponse.locator.toString()}`
        );
      } else {
        console.log("No locality field or alert popup detected after Create Customer.");
      }
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Button Error (Create Customer):`, e.message);
      throw new Error(`Mandatory Button Error: Could not click Create Customer. ${e.message}`);
    }

    // === HANDLE DYNAMIC LOCALITY FIELD ===
    try {
      console.log("Checking for dynamic 'Locality Name' field after first click...");
      // Check for the new field
      const localityNameField = By.name("newcust_textfield_locality_name_01");

      // The race above already waited for the portal's response, so this only
      // needs to confirm which one we got.
      const localityInput = await driver.wait(until.elementLocated(localityNameField), 5000);

      // If we found it, try to interact
      if (await localityInput.isDisplayed()) {
        console.log("⚠️ Locality Name field appeared! Filling it...");
        const localityName = data.locality || data.area || "Sample Locality";
        await localityInput.clear();
        await localityInput.sendKeys(localityName);
        console.log(`Filled Locality Name with: ${localityName}`);

        await driver.sleep(1000);

        // Click Create Customer button again
        console.log("Clicking Create Customer button AGAIN...");
        const createCustBtnAgain = await driver.wait(until.elementLocated(By.name("newCust_btn_createCust_01")), 5000);
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", createCustBtnAgain);
        await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

        try {
          await createCustBtnAgain.click();
        } catch (e) {
          await driver.executeScript("arguments[0].click();", createCustBtnAgain);
        }
        console.log("Clicked Create Customer button again.");
        await waitForPortalIdle(driver, 40000, 600);
      }
    } catch (e) {
      console.log("Locality Name field did not appear (proceeding):", e.message);
    }

    // === HANDLE CUSTOMER DETAILS AFTER SUBMIT ===
    console.log("Handling customer details after submit...");

    // Click Close button on modal/dialog
    try {
      console.log("Clicking Close button...");
      const closeButton = By.name("alert_btn_data_01");
      const closeBtn = await driver.wait(until.elementLocated(closeButton), 10000);

      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", closeBtn);
      await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
      await driver.executeScript("arguments[0].click();", closeBtn);
      console.log("Clicked Close button");
      await driver.sleep(2000);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Button Error (Close Details):`, e.message);
      throw new Error(`Mandatory Button Error: Could not click Close button after customer creation. ${e.message}`);
    }

    // === VEHICLE INFORMATION SECTION ===
    console.log("Expanding Vehicle Information section...");

    // Click on Vehicle Information accordion to expand
    try {
      const vehicleHeader = By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Vehicle Information')]]");
      const vehiclePanel = await driver.wait(until.elementLocated(vehicleHeader), 10000);

      const isExpanded = await driver.executeScript("return arguments[0].getAttribute('aria-expanded') === 'true';", vehiclePanel);
      console.log(`Vehicle Information panel isExpanded: ${isExpanded}`);

      if (!isExpanded) {
        await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", vehiclePanel);
        await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
        await driver.executeScript("arguments[0].click();", vehiclePanel);
        console.log("Expanded Vehicle Information panel");
        await driver.sleep(1000);
      }
    } catch (e) {
      console.log("Could not expand Vehicle Information:", e.message);
    }

    // Fill Engine Number
    try {
      console.log("Filling Engine Number...");
      const engineField = By.name("mcy_text_engineNumber_01");
      const engineInput = await driver.wait(until.elementLocated(engineField), 10000);
      await engineInput.clear();
      const engineNumber = data.engineNumber || "JC85EG4183208";
      await engineInput.sendKeys(engineNumber);
      console.log("Filled Engine Number");
      await driver.sleep(500);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Engine Number):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Engine Number. ${e.message}`);
    }

    // Fill Chassis Number
    try {
      console.log("Filling Chassis Number...");
      const chassisField = By.name("mcy_text_chasisNumber_01");
      const chassisInput = await driver.wait(until.elementLocated(chassisField), 10000);
      await chassisInput.clear();
      const chassisNumber = data.chassisNumber || "ME4JC85MJSG061153";
      await chassisInput.sendKeys(chassisNumber);
      console.log("Filled Chassis Number");
      await driver.sleep(500);
    } catch (e) {
      console.error(`[${jobId}] ❌ Mandatory Field Error (Chassis Number):`, e.message);
      throw new Error(`Mandatory Field Error: Could not fill Chassis Number. ${e.message}`);
    }

    // Fill Color of Vehicle (autocomplete)
    try {
      console.log("Filling Color of Vehicle...");
      const colorField = By.name("mcy_dropdown_color_01");
      const colorInput = await driver.wait(until.elementLocated(colorField), 10000);
      await selectAutocompleteOption(driver, colorInput, "Blue", "Color of Vehicle");
    } catch (e) {
      console.log("Could not fill Color:", e.message);
    }

    await openVehicleInformationSection(driver);

    // Select Type of Body
    try {
      console.log("Selecting Type of Body...");
      const typeLocators = [
        By.name("mcy_dropdown_body_01"),
        By.xpath("//mat-label[contains(., 'Type of Body')]/ancestor::mat-form-field//mat-select")
      ];
      let typeSelected = false;

      for (const locator of typeLocators) {
        try {
          await safeSelectOption(driver, locator, "Others", 10000);
          console.log(`Selected Type of Body using locator: ${locator.toString()}`);
          typeSelected = true;
          break;
        } catch (selectionError) {
          console.log(`Type of Body selection failed for ${locator.toString()}: ${selectionError.message}`);
        }
      }

      if (!typeSelected) {
        console.log("Falling back to direct input for Type of Body...");
        const bodyInput = await driver.wait(until.elementLocated(By.name("mcy_dropdown_body_01")), 10000);
        await bodyInput.clear();
        await bodyInput.sendKeys("Others");
        await driver.sleep(1500);
        try {
          const bodyOptions = await driver.wait(
            until.elementsLocated(By.xpath("//mat-option[normalize-space(.)='Others']")),
            3000
          );
          if (bodyOptions.length > 0) {
            await driver.executeScript("arguments[0].click();", bodyOptions[0]);
            console.log("Selected Type of Body 'Others' from fallback autocomplete");
            typeSelected = true;
          }
        } catch (fallbackError) {
          console.log("Fallback autocomplete selection failed:", fallbackError.message);
        }
      }

      await driver.sleep(500);
    } catch (e) {
      console.log("Could not select Type of Body:", e.message);
    }

    await openVehicleInformationSection(driver);

    // Select Year of Manufacture
    try {
      console.log("Selecting Year of Manufacture...");
      let yearSelected = false;
      const manufacturingYear = data.manufacturingYear || data.manufacturingyear || "2025";
      const yearString = String(manufacturingYear);

      // STRATEGY 1: Datepicker (based on user feedback with name mcy_text_yom_01)
      try {
        console.log("Checking for Year of Manufacture Datepicker (mcy_text_yom_01)...");
        // Look for the input to verify existence
        const datepickerInput = await driver.findElements(By.name("mcy_text_yom_01"));

        if (datepickerInput.length > 0) {
          console.log("Found Datepicker input. Attempting to open calendar...");
          // Use specific toggle button associated with this input
          // Often interactions work better on the button directly
          // Try to find the sibling mat-datepicker-toggle button
          const toggleButton = await driver.executeScript(`
                var input = document.getElementsByName('mcy_text_yom_01')[0];
                if (!input) return null;
                // Go up to find mat-form-field-infix or flex, then find mat-datepicker-toggle
                var container = input.closest('.mat-mdc-form-field-flex') || input.closest('.mat-form-field-flex');
                if (!container) return null;
                var btn = container.querySelector('mat-datepicker-toggle button');
                return btn;
            `);

          if (toggleButton) {
            await driver.wait(until.elementIsVisible(toggleButton), 5000);
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", toggleButton);
            await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

            try {
              await toggleButton.click();
            } catch (clickErr) {
              await driver.executeScript("arguments[0].click();", toggleButton);
            }
            console.log("Clicked Datepicker toggle button.");

            // Wait for calendar to be visible
            await driver.wait(until.elementLocated(By.css("mat-calendar")), 5000);
            await driver.sleep(500); // Animation buffer

            // Look for the specific year cell (Best: Button with aria-label)
            let yearCell;
            try {
              yearCell = await driver.wait(
                until.elementLocated(By.xpath(`//button[contains(@class, 'mat-calendar-body-cell') and @aria-label='${yearString}']`)),
                3000
              );
              console.log(`Found year ${yearString} button by aria-label.`);
            } catch (e) {
              console.log("Year button by aria-label not found, trying text content...");
              yearCell = await driver.wait(
                until.elementLocated(By.xpath(`//span[contains(@class, 'mat-calendar-body-cell-content') and contains(text(), '${yearString}')]`)),
                3000
              );
            }

            await driver.wait(until.elementIsVisible(yearCell), 5000);
            await driver.sleep(500);

            try {
              await yearCell.click();
            } catch (cellClickErr) {
              await driver.executeScript("arguments[0].click();", yearCell);
            }
            console.log(`Selected year ${yearString} from Datepicker.`);
            yearSelected = true;
          } else {
            console.log("Datepicker toggle button not found via JS.");
          }
        }
      } catch (datepickerError) {
        console.log("Datepicker interaction failed:", datepickerError.message);
      }

      // STRATEGY 2: Dropdown / Select (Fallback)
      if (!yearSelected) {
        console.log("Falling back to Dropdown/Select for Year of Manufacture...");
        const yearLocators = [
          By.name("mcy_dropdown_year_01"),
          By.name("mcy_dropdown_manYear_01"),
          By.name("mcy_dropdown_manufacturingYear_01"),
          By.xpath("//div[@id='mat-select-value-29']/ancestor::mat-select"),
          By.xpath("//mat-form-field[.//mat-label[contains(., 'Year of Manufacture')]]//mat-select"),
          By.xpath("//mat-select[contains(@aria-label, 'Year')]"),
          By.xpath("//mat-select[contains(@aria-labelledby, 'Year')]"),
          By.css("mat-select[formcontrolname*='year']"),
          By.css("mat-select[name*='year']"),
        ];

        for (const locator of yearLocators) {
          try {
            try {
              await driver.wait(until.elementLocated(locator), 1000);
            } catch (e) {
              continue;
            }

            await safeSelectOption(driver, locator, yearString, 5000);
            console.log(`Selected Year of Manufacture using locator: ${locator.toString()}`);
            yearSelected = true;
            break;
          } catch (selectionError) {
            // Ignore
          }
        }
      }

      // STRATEGY 3: Direct Click Fallback for Dropdown
      if (!yearSelected) {
        console.log(`Year dropdown fallback: trying direct option click for ${yearString}...`);
        try {
          const trigger = await driver.wait(
            until.elementLocated(By.xpath("//mat-form-field[.//mat-label[contains(., 'Year of Manufacture')]]//mat-select")),
            3000
          );

          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", trigger);
          await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
          await driver.executeScript("arguments[0].click();", trigger);
          await driver.sleep(1000);

          const yearOption = await driver.wait(
            until.elementLocated(By.xpath(`//mat-option[contains(., '${yearString}')]`)),
            3000
          );
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", yearOption);
          await driver.executeScript("arguments[0].click();", yearOption);
          console.log(`Selected Year of Manufacture ${yearString} via direct option fallback.`);
          yearSelected = true;
        } catch (fallbackError) {
          console.log("Direct Year of Manufacture selection failed:", fallbackError.message);
        }
      }

      if (!yearSelected) {
        console.log(`Unable to select Year of Manufacture ${yearString} after all strategies.`);
      }

      await driver.sleep(500);
    } catch (e) {
      console.log("Year of Manufacture handling failed:", e.message);
    }
    // === COMPULSORY PA FOR OWNER DRIVER SECTION ===
    console.log(`[${jobId}] Handling Compulsory PA for Owner Driver section...`);
    try {
      // 1. Expand the section with a more robust locator
      const paHeaderLocators = [
        By.xpath("//mat-expansion-panel-header[.//h4[contains(., 'Compulsory PA')]]"),
        By.xpath("//mat-expansion-panel-header[.//mat-panel-title[contains(., 'Compulsory PA')]]"),
        By.xpath("//mat-expansion-panel-header[.//span[contains(., 'Compulsory PA')]]"),
        By.xpath("//h4[contains(., 'Compulsory PA')]/ancestor::mat-expansion-panel-header")
      ];

      // Probe all four locators together instead of waiting 5s on each in turn
      // (which cost up to 20s whenever the page used the last variant). The
      // combined poll still waits the full window for a slow render.
      // Presence-only: the header is expanded via executeScript below, and the
      // old code matched on presence too.
      const paHeaderMatch = await firstPresentLocator(driver, paHeaderLocators, 6000, {
        requireVisible: false,
      });
      const paPanelHeader = paHeaderMatch ? paHeaderMatch.element : null;
      if (paHeaderMatch) {
        console.log(
          `[${jobId}] Found Compulsory PA header using: ${paHeaderMatch.locator.toString()}`
        );
      }

      if (paPanelHeader) {
        const isExpanded = await driver.executeScript(`
      const header = arguments[0];
      const panel = header.closest('mat-expansion-panel');
      return panel ? (panel.getAttribute('aria-expanded') === 'true' || panel.classList.contains('mat-expanded')) : false;
    `, paPanelHeader);

        if (!isExpanded) {
          await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", paPanelHeader);
          await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
          await driver.executeScript("arguments[0].click();", paPanelHeader);
          console.log(`[${jobId}] Expanded Compulsory PA panel`);
          await driver.sleep(1000);
        } else {
          console.log(`[${jobId}] Compulsory PA panel already expanded`);
        }
      } else {
        console.log(`[${jobId}] ⚠️ Could not find Compulsory PA expansion panel header.`);
      }

      // 2. Handle the selection based on data
      try {
        const paCoverVal = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
        const paCompanyVal = String(data.paCoverCompany || "").toLowerCase();
        const isCompanyPA = paCoverVal && (paCompanyVal === "company" || paCompanyVal === "national");

        console.log(`[${jobId}] PA Logic Check: paCover=${data.paCover}, company=${data.paCoverCompany} -> isCompanyPA=${isCompanyPA}`);

        if (isCompanyPA) {

          // A. Handle Radio Group (Tenure)
          try {
            console.log(`[${jobId}] Input data.paCoverYears: ${data.paCoverYears} (type: ${typeof data.paCoverYears})`);
            let targetValue = (data.paCoverYears == 5 || data.paCoverYears == "5" || data.paCoverYears == 3 || data.paCoverYears == "3") ? "3" : "1";
            console.log(`[${jobId}] Setting Compulsory PA radio to value: ${targetValue} (Expected for ${data.paCoverYears} Year)`);

            const radioLocators = [
              By.xpath(`//mat-radio-group[@name='mcy_toggle_cpaCoverorBenefit_01']//mat-radio-button[@value='${targetValue}']`),
              By.css(`mat-radio-button[value='${targetValue}']`),
              By.xpath(`//mat-radio-button[@value='${targetValue}']`)
            ];

            // Probe all three together rather than 5s each in sequence.
            // requireVisible:false because the click below goes through
            // executeScript, which works on hidden elements — the old code
            // matched on presence only, and requiring visibility here would
            // silently skip PA selection whenever the panel stayed collapsed.
            const radioMatch = await firstPresentLocator(driver, radioLocators, 6000, {
              requireVisible: false,
            });
            const radioSelect = radioMatch ? radioMatch.element : null;
            if (radioMatch) {
              console.log(
                `[${jobId}] Found PA Radio button using: ${radioMatch.locator.toString()}`
              );
            }

            if (radioSelect) {
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", radioSelect);
              await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

              const isChecked = await driver.executeScript(
                "return arguments[0].classList.contains('mat-mdc-radio-checked') || arguments[0].classList.contains('mat-radio-checked');",
                radioSelect
              );

              if (!isChecked) {
                try {
                  const innerRadio = await radioSelect.findElement(By.css("input.mdc-radio__native-control, input[type='radio']"));
                  await driver.executeScript("arguments[0].click();", innerRadio);
                } catch (clickInnerErr) {
                  await driver.executeScript("arguments[0].click();", radioSelect);
                }
                console.log(`[${jobId}] ✅ Selected PA Radio value: ${targetValue}`);
                await driver.sleep(1000);
              } else {
                console.log(`[${jobId}] PA Radio value ${targetValue} already selected.`);
              }
            } else {
              console.log(`[${jobId}] ⚠️ Could not find PA Radio button with value ${targetValue}`);
            }
          } catch (e) {
            console.log(`[${jobId}] Radio group selection failed: ${e.message}`);
          }

          // B. Handle "No of Years" mat-select Dropdown
          try {
            const targetYearText = (data.paCoverYears == 5 || data.paCoverYears == "5") ? "5 Year" : "1 Year";
            console.log(`[${jobId}] Selecting No of Years dropdown: ${targetYearText}`);

            const yearSelect = await driver.findElement(By.css("mat-select[name='mcy_dropdown_noy_01']"));
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", yearSelect);
            await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

            const currentYearText = await yearSelect.getText();
            if (!currentYearText.includes(targetYearText)) {
              await driver.executeScript("arguments[0].click();", yearSelect);
              await driver.sleep(1200); // wait for CDK overlay to fully render

              const yearOption = await driver.wait(
                until.elementLocated(By.xpath(`//mat-option[normalize-space(.)='${targetYearText}']`)),
                5000
              );
              await driver.executeScript("arguments[0].click();", yearOption);
              await driver.sleep(800);
              console.log(`[${jobId}] ✅ Selected No of Years: ${targetYearText}`);
            } else {
              console.log(`[${jobId}] No of Years already set to: ${targetYearText}`);
            }
          } catch (e) {
            console.log(`[${jobId}] Failed to select No of Years dropdown: ${e.message}`);
          }

          // C. Fill Nominee Name
          // C. Fill Nominee Name
          if (data.nomineeName) {
            try {
              const nameInput = await driver.findElement(By.css("input[name='mcy_text_cpaNomineeName_01']"));
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", nameInput);
              await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

              await driver.executeScript(`
      const input = arguments[0];
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, arguments[1]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
    `, nameInput, data.nomineeName.toUpperCase());
              await driver.sleep(500);
              console.log(`[${jobId}] ✅ Filled Nominee Name: ${data.nomineeName}`);
            } catch (e) {
              console.log(`[${jobId}] Failed to fill Nominee Name: ${e.message}`);
            }
          }

          // D. Fill Nominee Age
          if (data.nomineeAge) {
            try {
              const ageInput = await driver.findElement(By.css("input[name='mcy_dropdown_cpaNomineeAge_01']"));
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", ageInput);
              await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

              // Use nativeInputValueSetter to properly trigger Angular change detection
              await driver.executeScript(`
            const input = arguments[0];
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, arguments[1]);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
          `, ageInput, data.nomineeAge.toString());
              await driver.sleep(500);
              console.log(`[${jobId}] ✅ Filled Nominee Age: ${data.nomineeAge}`);
            } catch (e) {
              console.log(`[${jobId}] Failed to fill Nominee Age: ${e.message}`);
            }
          }

          // E. Select Relationship with Nominee.
          //
          // This is an AUTOCOMPLETE, not a mat-select: the control is
          // <input name="mcy_dropdown_nomineeRelation_01" role="combobox"
          // class="mat-mdc-autocomplete-trigger">. The old code looked for
          // mat-select[name=...], found nothing, and silently left the field
          // empty — which then failed the PA validation below with
          // "Relationship with Nominee" every single run.
          //
          // selectAutocompleteOption is the same helper the RTO / make / model
          // fields use, so this now behaves like every other autocomplete on
          // the page (types, waits for the panel, picks the matching option).
          if (data.nomineeRelation) {
            try {
              const relInput = await driver.wait(
                until.elementLocated(
                  By.css("input[name='mcy_dropdown_nomineeRelation_01']")
                ),
                15000
              );
              await driver.wait(until.elementIsVisible(relInput), 10000);
              await driver.executeScript(
                "arguments[0].scrollIntoView({block: 'center'});",
                relInput
              );

              const relationTarget = String(data.nomineeRelation).trim();
              await selectAutocompleteOption(
                driver,
                relInput,
                relationTarget,
                "Nominee Relation"
              );

              // Confirm the portal accepted it — an autocomplete keeps whatever
              // was typed even when nothing was picked, so a filled-looking box
              // can still be ng-invalid.
              const relOk = await driver.executeScript(
                "const el = document.querySelector(\"input[name='mcy_dropdown_nomineeRelation_01']\");" +
                "return el ? { value: el.value, invalid: el.classList.contains('ng-invalid') } : null;"
              );
              if (relOk && !relOk.invalid) {
                console.log(`[${jobId}] ✅ Selected Nominee Relation: ${relOk.value}`);
              } else {
                console.log(
                  `[${jobId}] ⚠️ Nominee Relation still rejected after selecting "${relationTarget}" (value: "${relOk?.value || ""}")`
                );
              }
            } catch (e) {
              console.log(`[${jobId}] Failed to select Nominee Relation: ${e.message}`);
            }
          }

          // F. Fill Appointee Name (if visible)
          if (data.appointeeName) {
            try {
              const appointeeInput = await driver.findElement(
                By.xpath("//mat-label[contains(., 'Appointee Name')]/ancestor::mat-form-field//input")
              );
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", appointeeInput);
              await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough

              await driver.executeScript(`
            const input = arguments[0];
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, arguments[1]);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true }));
          `, appointeeInput, data.appointeeName.toUpperCase());
              await driver.sleep(500);
              console.log(`[${jobId}] ✅ Filled Appointee Name: ${data.appointeeName}`);
            } catch (e) {
              console.log(`[${jobId}] Appointee Name not found or not required: ${e.message}`);
            }
          }

          // === VALIDATION STEP ===
          await driver.sleep(1000);
          console.log(`[${jobId}] 🔍 Validating PA mandatory fields...`);

          const validationResults = await driver.executeScript(`
        const results = {
          name: { filled: false, valid: false },
          age: { filled: false, valid: false },
          relation: { filled: false, valid: false },
          noOfYears: { filled: false, valid: false }
        };

        // in the validation executeScript block — replace paNomineeName with cpaNomineeName
        const nameInput = document.querySelector('input[name="mcy_text_cpaNomineeName_01"]');
        if (nameInput) {
          results.name.filled = !!nameInput.value;
          results.name.valid = !nameInput.classList.contains('ng-invalid');
        }

        const ageInput = document.querySelector('input[name="mcy_dropdown_cpaNomineeAge_01"]');
        if (ageInput) {
          results.age.filled = !!ageInput.value;
          results.age.valid = !ageInput.classList.contains('ng-invalid');
        }

        // Autocomplete INPUT, not a mat-select — querying mat-select returned
        // null, so relation was reported missing even when it was filled.
        const relInput = document.querySelector('input[name="mcy_dropdown_nomineeRelation_01"]');
        if (relInput) {
          results.relation.filled = !!String(relInput.value || '').trim();
          results.relation.valid = !relInput.classList.contains('ng-invalid');
        }

        const yearSelect = document.querySelector('mat-select[name="mcy_dropdown_noy_01"]');
        if (yearSelect) {
          const yearText = yearSelect.querySelector('.mat-mdc-select-value-text')?.innerText || '';
          results.noOfYears.filled = !!yearText.trim();
          results.noOfYears.valid = !yearSelect.classList.contains('ng-invalid');
        }

        return results;
      `);

          console.log(`[${jobId}] PA Validation Results: ${JSON.stringify(validationResults)}`);

          const isNameValid = validationResults.name.filled && validationResults.name.valid;
          const isAgeValid = validationResults.age.filled && validationResults.age.valid;
          const isRelationValid = validationResults.relation.filled && validationResults.relation.valid;
          const isYearValid = validationResults.noOfYears.filled && validationResults.noOfYears.valid;

          if (!isNameValid || !isAgeValid || !isRelationValid || !isYearValid) {
            const missing = [];
            if (!isNameValid) missing.push("Nominee Name");
            if (!isAgeValid) missing.push("Nominee Age");
            if (!isRelationValid) missing.push("Relationship with Nominee");
            if (!isYearValid) missing.push("No of Years");

            const errorMsg = "PA Validation Error: The following mandatory fields are missing or invalid: " + missing.join(", ");
            console.error(`[${jobId}] ❌ ${errorMsg}`);

            const screenshot = await driver.takeScreenshot();
            const screenshotUrl = await uploadScreenshotToS3(screenshot, generateScreenshotKey(jobId, 0, "pa-validation-error"));

            const validationError = new Error(errorMsg);
            validationError.screenshotUrl = screenshotUrl;
            validationError.stage = "pa-validation";
            throw validationError;
          }

          console.log(`[${jobId}] ✅ PA mandatory fields validated successfully.`);

        } else {
          // PA not required — select "No" radio
          console.log(`[${jobId}] PA not wanted or not with company. Wanted PA: ${data.paCover}, Company: ${data.paCoverCompany}`);

          try {
            let noRadio = null;
            try {
              noRadio = await driver.wait(
                until.elementLocated(By.xpath(`//mat-radio-group[@name='mcy_toggle_cpaCoverorBenefit_01']//mat-radio-button[@value='0']`)),
                5000
              );
            } catch (e) {
              noRadio = await driver.wait(
                until.elementLocated(By.css("mat-radio-button[value='0']")),
                3000
              );
            }

            if (noRadio) {
              const isNoChecked = await driver.executeScript(
                "return arguments[0].classList.contains('mat-mdc-radio-checked') || arguments[0].classList.contains('mat-radio-checked');",
                noRadio
              );

              if (!isNoChecked) {
                try {
                  const innerRadio = await noRadio.findElement(By.css("input.mdc-radio__native-control, input[type='radio']"));
                  await driver.executeScript("arguments[0].click();", innerRadio);
                } catch (ce) {
                  await driver.executeScript("arguments[0].click();", noRadio);
                }
                console.log(`[${jobId}] ✅ Selected PA Radio: No`);
                await driver.sleep(1000);
              } else {
                console.log(`[${jobId}] PA Radio 'No' already selected.`);
              }

              // Dismiss confirmation dialog if shown
              try {
                const closeBtn = await driver.wait(until.elementLocated(By.name("alert_btn_data_01")), 3000);
                await closeBtn.click();
                console.log(`[${jobId}] Dismissed PA disable confirmation.`);
              } catch (e) {
                try {
                  const closeBtnAlt = await driver.findElement(By.xpath("//button[contains(., 'Close')]"));
                  await closeBtnAlt.click();
                } catch (e2) { }
              }
            }
          } catch (e) {
            console.log(`[${jobId}] Could not find 'No' radio button for PA cover: ${e.message}`);
          }
        }

      } catch (innerErr) {
        console.log(`[${jobId}] Error in Compulsory PA sub-steps: ${innerErr.message}`);
      }

    } catch (e) {
      console.log(`[${jobId}] Error handling Compulsory PA section: ${e.message}`);
    }
    await driver.sleep(1000);


    // === FINANCIER INTEREST SECTION ===
    if (data.hasFinancier) {
      console.log("Financier Interest is applicable (hasFinancier=true). Processing section...");

      // Open Financier Interest Applicable tab
      try {
        console.log("Opening Financier Interest Applicable tab...");
        const financierTab = By.xpath("//span[contains(normalize-space(.), 'Financier Interest Applicable')]");
        await safeClick(driver, financierTab, 10000);
        await driver.sleep(2000);
      } catch (e) {
        console.log("Financier Interest Applicable tab not found or already open:", e.message);
      }

      // Ensure Financier Interest section is visible
      await openFinancierSection(driver);

      // Enable the Financier Interest switch.
      //
      // Every previous locator was wrong: `mat-mdc-slide-toggle` is a CSS CLASS
      // (the tag is <mat-slide-toggle>), the name attribute lives on the INNER
      // <button role="switch"> and is mcy_toggle_FinancierDetails_01 — not
      // ...FinancierInterestApplicable_01 — and there is no mat-expansion-panel
      // to descend from. The mat-mdc-slide-toggle-8-button id is generated per
      // render (it was -17 on this run), so it can never be hardcoded.
      try {
        const toggle = await firstPresentLocator(
          driver,
          [
            By.css("button[name='mcy_toggle_FinancierDetails_01']"),
            By.css("mat-slide-toggle button[role='switch']"),
            By.xpath(
              "//mat-label[contains(., 'Financier Interest Applicable')]/following::button[@role='switch'][1]"
            ),
          ],
          15000
        );

        if (!toggle) {
          throw new Error("Financier Interest toggle not found");
        }

        // aria-checked is the truth for an MDC switch. Only click when it is
        // OFF — clicking an already-on switch turns the section back off.
        const alreadyOn = await driver.executeScript(
          "return arguments[0].getAttribute('aria-checked') === 'true';",
          toggle.element
        );

        if (alreadyOn) {
          console.log("Financier Interest switch already on.");
        } else {
          await driver.executeScript(
            "arguments[0].scrollIntoView({block:'center'});",
            toggle.element
          );
          await driver.executeScript("arguments[0].click();", toggle.element);
          await driver.sleep(800);
          const nowOn = await driver.executeScript(
            "return arguments[0].getAttribute('aria-checked') === 'true';",
            toggle.element
          );
          console.log(`Financier Interest switch turned on: ${nowOn}`);
        }
        await waitForPortalIdle(driver, 20000, 600);
      } catch (e) {
        console.log("Financier switch handling failed:", e.message);
      }

      // Select Financier Interest Type
      try {
        console.log("Selecting Financier Interest Type...");
        // The portal calls this "Agreement Type": the control is
        // <mat-select name="mcy_dropdown_AgreementType_01">. The old locators
        // looked for name*='Financier' (no match) and a hardcoded mat-select-41
        // id that changes every render (-38 on this run).
        //
        // These fields carry mdc-notched-outline--no-label, i.e. they render
        // with NO <mat-label> at all — so every label-based xpath below is a
        // dead end and only the name attribute can find them.
        const interestLocators = [
          By.css("mat-select[name='mcy_dropdown_AgreementType_01']"),
          By.css("mat-select[name*='AgreementType']"),
          By.css("mat-select[name*='Financier']"),
        ];

        const interestType = data.financierType || "Hypothecation";
        let interestSelected = false;

        // Narrow the chain to the locators that are actually on the page
        // (one instant findElements poll) instead of paying a 5s click timeout
        // per miss. The retry across candidates is kept: the first two entries
        // are auto-generated Material ids (mat-select-41) that drift between
        // builds and can resolve to an unrelated mat-select, so if one turns
        // out to be the wrong dropdown we must still try the next.
        const firstInterestMatch = await firstPresentLocator(driver, interestLocators, 8000);
        const presentInterestLocators = [];
        if (firstInterestMatch) {
          for (const locator of interestLocators) {
            try {
              const found = await driver.findElements(locator);
              if (found.length > 0) presentInterestLocators.push(locator);
            } catch (e) { /* skip unusable locator */ }
          }
        }

        if (presentInterestLocators.length === 0) {
          console.log("Financier Interest Type dropdown not found.");
        }

        for (const interestLocator of presentInterestLocators) {
          if (interestSelected) break;
          const interestMatch = { locator: interestLocator };
          try {
            // 1. Click to open dropdown
            await safeClick(driver, interestMatch.locator, 5000);

            // 2. Wait for the panel to render, then search within it if the
            //    dropdown offers a search box.
            await driver.wait(
              until.elementLocated(By.css(".mat-mdc-select-panel, .cdk-overlay-pane mat-option, mat-option")),
              5000
            ).catch(() => { });

            let searched = false;
            try {
              const searchInputs = await driver.findElements(
                By.css("input[aria-label='dropdown search'], input[placeholder='Search'], .mat-select-search-input")
              );
              if (searchInputs.length > 0) {
                await searchInputs[0].sendKeys(interestType);
                searched = true;
              }
            } catch (searchErr) {
              console.log("No search input found in dropdown, trying to select directly from options...");
            }

            // 3. Wait for the options to reflect what we typed. The old code
            //    waited only for "some mat-option exists", which passes on the
            //    UNFILTERED list — so it could click the wrong financier type.
            const normalize = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
            const wanted = normalize(interestType);
            let options = [];

            await driver.wait(async () => {
              options = await driver.findElements(By.css(".cdk-overlay-pane mat-option, mat-option"));
              if (options.length === 0) return false;
              if (!searched || !wanted) return true;
              try {
                return normalize(await options[0].getText()).includes(wanted);
              } catch (staleErr) {
                return false; // list is re-rendering — keep polling
              }
            }, searched ? 5000 : 3000).catch(() => { });

            if (options.length > 0) {
              // 4. Prefer an option that matches the requested type, else fall
              //    back to the first one (previous behaviour).
              let chosen = options[0];
              for (const option of options) {
                try {
                  if (wanted && normalize(await option.getText()).includes(wanted)) {
                    chosen = option;
                    break;
                  }
                } catch (staleErr) { /* try the next option */ }
              }

              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", chosen);
              await driver.sleep(60);
              await chosen.click();
              console.log(`Selected option for "${interestType}".`);
              interestSelected = true;

              // Close dropdown if it didn't close automatically
              try { await driver.executeScript("document.body.click()"); } catch (e) { }
              await waitForOverlayGone(driver, 2000);
            } else {
              console.log("No options found in dropdown.");
              try { await driver.executeScript("document.body.click()"); } catch (e) { }
            }
          } catch (interestError) {
            console.log(
              `Financier Interest Type selection failed for ${interestLocator.toString()}: ${interestError.message}`
            );
            try { await driver.executeScript("document.body.click()"); } catch (e) { }
          }
        }

        if (!interestSelected) {
          console.log("Could not select Financier Interest Type.");
        }
      } catch (e) {
        console.log("Financier Interest Type handling failed:", e.message);
      }

      /**
       * Fill one of the financier text inputs.
       *
       * The old label fallback — //mat-label[...]/ancestor::mat-form-field//input
       * — could never match: the caption sits OUTSIDE the mat-form-field, so
       * it is not an ancestor of the input, and the field itself renders with
       * mdc-notched-outline--no-label (no mat-label inside it at all).
       *
       * The working fallback walks forward from whatever element holds the
       * caption text to the next input, which is independent of the tag used.
       * Whichever locator wins is logged with the element's real name
       * attribute, so the portal's own naming can be pinned down from a run.
       */
      const fillFinancierText = async (caption, exactName, value, label) => {
        console.log(`Filling ${label}...`);
        const found = await firstPresentLocator(
          driver,
          [
            By.css(`input[name='${exactName}']`),
            By.css(`input[name*='${caption.replace(/\s+/g, "")}']`),
            By.xpath(
              `//*[normalize-space(text())='${caption}']/following::input[not(@type='hidden')][1]`
            ),
            By.xpath(
              `//*[contains(normalize-space(text()), '${caption}')]/following::input[not(@type='hidden')][1]`
            ),
          ],
          15000
        );

        if (!found) {
          console.log(`All strategies failed for ${label} — field not on the page.`);
          return false;
        }

        const realName = await driver
          .executeScript(
            "return arguments[0].getAttribute('name') || arguments[0].id || '(unnamed)';",
            found.element
          )
          .catch(() => "(unknown)");
        console.log(`${label} resolved; name/id = ${realName}`);

        await driver.executeScript(
          "arguments[0].scrollIntoView({block:'center'});",
          found.element
        );

        // Respect the field's OWN constraints rather than hardcoding them:
        // Financier Name carries maxlength="40" and a pattern whose character
        // class permits letters and punctuation but NO DIGITS. Sending a value
        // that breaks either leaves the input ng-invalid, and the failure only
        // surfaces much later as an unexplained quote validation error.
        const limits = await driver.executeScript(
          "const el = arguments[0];" +
          "return { maxLength: el.getAttribute('maxlength'), pattern: el.getAttribute('pattern') };",
          found.element
        );

        let toSend = String(value);
        if (limits?.pattern) {
          // Derive the allowed characters from the pattern's own character
          // class instead of guessing, so a portal-side change follows through.
          // Consume escaped pairs OR non-] characters — this class contains
          // escaped brackets (\[ \]), which a naive [^\]]* extractor cuts short.
          const cls = /\[((?:\\.|[^\]\\])*)\]/.exec(limits.pattern);
          if (cls) {
            try {
              const allowed = new RegExp(`[${cls[1]}]`);
              const stripped = toSend.split("").filter((c) => allowed.test(c)).join("");
              if (stripped !== toSend) {
                console.log(
                  `${label}: removed characters the portal rejects — "${toSend}" -> "${stripped}"`
                );
                toSend = stripped;
              }
            } catch (patternError) {
              // Unparseable class — send the value unchanged rather than
              // mangling it on a bad guess.
            }
          }
        }
        const maxLength = Number(limits?.maxLength);
        if (Number.isFinite(maxLength) && maxLength > 0 && toSend.length > maxLength) {
          console.log(`${label}: trimmed to the field's ${maxLength}-character limit.`);
          toSend = toSend.slice(0, maxLength);
        }

        await found.element.clear().catch(() => { });
        await found.element.sendKeys(toSend);
        // Angular commits this model on blur.
        await driver.executeScript(
          "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));" +
          "arguments[0].dispatchEvent(new Event('blur', {bubbles:true}));",
          found.element
        );

        // The portal marks a rejected value ng-invalid. Say so now — otherwise
        // the run continues and fails later with no obvious cause.
        const invalid = await driver.executeScript(
          "return arguments[0].classList.contains('ng-invalid');",
          found.element
        );
        if (invalid) {
          console.log(`⚠️ ${label}: the portal still rejects "${toSend}".`);
        }
        return true;
      };

      // Financier Name is REQUIRED on the portal — a miss here fails the quote
      // later with an unhelpful validation error, so say so plainly now.
      const nameFilled = await fillFinancierText(
        "Financier Name",
        "mcy_text_FinancierName_01",
        data.financierName || "Financier Name",
        "Financier Name"
      );
      if (!nameFilled) {
        console.log("⚠️ Financier Name is required by the portal but could not be filled.");
      }

      await fillFinancierText(
        "Financier Address",
        "mcy_text_FinancierAddress_01",
        data.financierAddress || "Financier Address",
        "Financier Address"
      );
      // Check declaration checkbox
      try {
        console.log("Checking financier declaration checkbox...");
        const declarationCheckboxLocators = [
          By.css("*[name='mcy_checkbox_declaration01_01']"),
          By.id("mat-mdc-checkbox-2-input"),
          By.name("mcy_checkbox_declaration01_01"),
          By.xpath("//input[@type='checkbox' and contains(@id, 'checkbox') and contains(@name, 'declaration')]")
        ];
        let checkboxChecked = false;

        for (const locator of declarationCheckboxLocators) {
          try {
            const checkbox = await driver.wait(until.elementLocated(locator), 5000);
            await driver.wait(until.elementIsVisible(checkbox), 5000);
            await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", checkbox);
            await driver.sleep(60); // scrollIntoView is synchronous — one repaint frame is enough
            const isChecked = await checkbox.isSelected().catch(() => false);
            if (!isChecked) {
              await driver.executeScript("arguments[0].click();", checkbox);
              console.log(`Clicked checkbox using locator: ${locator.toString()}`);
              const nowChecked = await checkbox.isSelected().catch(() => false);
              if (!nowChecked) {
                await driver.executeScript("if (!arguments[0].checked) { arguments[0].checked = true; arguments[0].dispatchEvent(new Event('change', { bubbles: true })); }", checkbox);
                console.log("Forced checkbox checked via script dispatch.");
              }
            } else {
              console.log("Checkbox already checked.");
            }
            checkboxChecked = true;
            break;
          } catch (checkboxError) {
            console.log(`Checkbox interaction failed for ${locator.toString()}: ${checkboxError.message}`);
          }
        }

        if (!checkboxChecked) {
          console.log("Could not interact with the financier declaration checkbox.");
        }

        await driver.sleep(500);
      } catch (e) {
        console.log("Financier declaration checkbox handling failed:", e.message);
      }
    } else {
      console.log("Financier Interest NOT applicable (hasFinancier=false). Skipping section.");
    }

    // Check Vahan (initial pass, before premium calculation)
    // await runCheckVahan(driver, jobId, "initial", data);


    // Check declaration checkbox after Vahan - force check with events
    try {
      console.log(`[${jobId}] Checking declaration checkbox after Vahan...`);
      await driver.sleep(1500);

      // Force check the checkbox using JavaScript with proper events
      const checkboxResult = await driver.executeScript(`
        // Find checkbox by name attribute
        const checkbox = document.querySelector('input[name="mcy_checkbox_declaration01_01"]') ||
                        document.querySelector('input#mat-mdc-checkbox-1-input') ||
                        document.querySelector('input[type="checkbox"][name*="declaration"]');
        
        if (!checkbox) {
          return { found: false, error: 'Checkbox not found' };
        }
        
        // Check current state
        const wasChecked = checkbox.checked || 
                          checkbox.classList.contains('mdc-checkbox--selected') ||
                          checkbox.getAttribute('aria-checked') === 'true';
        
        if (!wasChecked) {
          // Method 1: Set checked property directly
          checkbox.checked = true;
          
          // Method 2: Add Material Design classes
          checkbox.classList.add('mdc-checkbox--selected');
          checkbox.setAttribute('aria-checked', 'true');
          
          // Method 3: Find wrapper and update it too
          const wrapper = checkbox.closest('.mdc-checkbox');
          if (wrapper) {
            wrapper.classList.add('mdc-checkbox--selected');
            const background = wrapper.querySelector('.mdc-checkbox__background');
            if (background) {
              background.classList.add('mdc-checkbox__background--selected');
            }
          }
          
          // Method 4: Trigger all necessary events
          const events = ['click', 'change', 'input'];
          events.forEach(eventType => {
            const event = new Event(eventType, { bubbles: true, cancelable: true });
            checkbox.dispatchEvent(event);
          });
          
          // Method 5: Also try clicking the wrapper
          if (wrapper) {
            wrapper.click();
          } else {
            checkbox.click();
          }
        }
        
        // Wait a bit and check final state
        setTimeout(() => {}, 100);
        
        const nowChecked = checkbox.checked || 
                          checkbox.classList.contains('mdc-checkbox--selected') ||
                          checkbox.getAttribute('aria-checked') === 'true';
        
        return { 
          found: true, 
          wasChecked: wasChecked, 
          nowChecked: nowChecked,
          checked: checkbox.checked,
          hasClass: checkbox.classList.contains('mdc-checkbox--selected'),
          ariaChecked: checkbox.getAttribute('aria-checked')
        };
      `);

      console.log(`[${jobId}] Checkbox result:`, checkboxResult);

      if (checkboxResult && checkboxResult.found) {
        await driver.sleep(500);

        // Double-check and force if still not checked
        if (!checkboxResult.nowChecked) {
          console.log(`[${jobId}] Checkbox still not checked, forcing again...`);

          await driver.executeScript(`
            const checkbox = document.querySelector('input[name="mcy_checkbox_declaration01_01"]');
            if (checkbox) {
              checkbox.checked = true;
              checkbox.setAttribute('checked', 'checked');
              checkbox.setAttribute('aria-checked', 'true');
              checkbox.classList.add('mdc-checkbox--selected');
              
              const wrapper = checkbox.closest('.mdc-checkbox');
              if (wrapper) {
                wrapper.classList.add('mdc-checkbox--selected');
                wrapper.click();
              }
              
              checkbox.click();
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
              checkbox.dispatchEvent(new Event('click', { bubbles: true }));
            }
          `);

          await driver.sleep(500);
        }

        // Final verification with Selenium
        try {
          const checkboxLocators = [
            By.name("mcy_checkbox_declaration01_01"),
            By.css("input[name='mcy_checkbox_declaration01_01']"),
          ];

          for (const locator of checkboxLocators) {
            try {
              const elements = await driver.findElements(locator);
              if (elements.length > 0) {
                const finalState = await driver.executeScript(`
                  const cb = arguments[0];
                  cb.checked = true;
                  cb.setAttribute('checked', 'checked');
                  cb.setAttribute('aria-checked', 'true');
                  cb.classList.add('mdc-checkbox--selected');
                  
                  const wrapper = cb.closest('.mdc-checkbox');
                  if (wrapper) {
                    wrapper.classList.add('mdc-checkbox--selected');
                  }
                  
                  return cb.checked || cb.classList.contains('mdc-checkbox--selected');
                `, elements[0]);

                console.log(`[${jobId}] ✅ Declaration checkbox force-checked. Final state:`, finalState);
                break;
              }
            } catch (e) {
              // Continue
            }
          }
        } catch (verifyError) {
          console.log(`[${jobId}] Final verification skipped:`, verifyError.message);
        }
      } else {
        console.log(`[${jobId}] ⚠️ Checkbox not found`);
      }

      await driver.sleep(500);

    } catch (e) {
      console.log(`[${jobId}] Declaration checkbox handling error:`, e.message);
    }

    await driver.sleep(500);

    await driver.sleep(500);


    // Handle Discount/Percentage if provided
    if (formData.discount) {
      try {
        console.log(`[${jobId}] Setting discount percentage to: ${formData.discount}`);
        // Wait for the percentage input to be visible and enabled
        const percentageInput = await driver.wait(
          until.elementLocated(By.name("mcy_text_percentage_01")),
          5000
        );

        await driver.wait(until.elementIsVisible(percentageInput), 5000);

        // Clear existing value and type new one
        await percentageInput.clear();
        await percentageInput.sendKeys(Key.CONTROL + "a");
        await percentageInput.sendKeys(Key.DELETE);
        await percentageInput.sendKeys(formData.discount.toString());

        // Trigger change event just in case
        await driver.executeScript("arguments[0].dispatchEvent(new Event('change', { bubbles: true }));", percentageInput);

        console.log(`[${jobId}] ✅ Discount percentage set to ${formData.discount}`);
        await driver.sleep(500);
      } catch (e) {
        console.log(`[${jobId}] ⚠️ Failed to set discount percentage: ${e.message}`);
        // Don't fail the whole job for this, but log it
      }
    }

    // Re-run Check Vahan AFTER the discount percentage is set. Changing the
    // discount invalidates the earlier Vahan result, so the portal needs a
    // fresh lookup before Calculate Premium will use the updated values.
    // runCheckVahan clicks the button, waits out the loader, and closes the
    // result popup before we continue.
    await runCheckVahan(driver, jobId, "after discount", data);

    // Make sure the Vahan popup is really gone before submitting — a leftover
    // backdrop would swallow the Calculate Premium click.
    await waitForOverlayGone(driver, 3000);
    await waitForPortalIdle(driver, 40000, 600);

    // Click Calculate Premium button
    console.log(`[${jobId}] Clicking Calculate Premium button...`);
    const calculatePremiumLocators = [
      By.name("mcy_button_calculatePremium_01"),
      By.xpath("//button[@name='mcy_button_calculatePremium_01']"),
      By.xpath("//button[contains(@class, 'q-quote-btn') and .//span[normalize-space(.)='Calculate Premium']]"),
      By.xpath("//span[normalize-space(.)='Calculate Premium']/ancestor::button"),
      By.xpath("//button[contains(@class, 'mat-mdc-raised-button') and .//span[contains(text(), 'Calculate Premium')]]"),
    ];
    let premiumClicked = false;
    for (const locator of calculatePremiumLocators) {
      try {
        await scrollAndClick(driver, locator, 12000);
        premiumClicked = true;
        console.log(`[${jobId}] ✅ Clicked Calculate Premium using locator: ${locator.toString()}`);
        break;
      } catch (calcError) {
        console.log(`[${jobId}] Calculate Premium click failed for ${locator.toString()}: ${calcError.message}`);
      }
    }

    if (!premiumClicked) {
      throw new Error("Critical Error: Unable to click Calculate Premium button. Automation cannot proceed.");
    }
    await driver.sleep(3000);
    await waitForPortalLoaderToDisappear(driver, NON_BLOCKING_LOADER_CHECK);
    console.log(`[${jobId}] ✅ Calculate Premium button clicked successfully`);

    // Confirm popup OK
    try {
      console.log("Handling confirmation popup...");
      const confirmOkButton = By.xpath("//span[contains(., 'OK')]/ancestor::button");
      await safeClick(driver, confirmOkButton, 5000);
      await driver.sleep(1000);
      await waitForPortalLoaderToDisappear(driver, NON_BLOCKING_LOADER_CHECK);
    } catch (e) {
      console.log("Confirmation popup OK button not found or not needed:", e.message);
    }

    // Proceed For Payment Flow
    if (formData.Paymentmethod === "link") {
      try {
        console.log(`[${jobId}] Payment method is 'link'. Initiating Proceed For Payment flow...`);

        // Step 1: Click Proceed For Payment button
        console.log(`[${jobId}] Clicking Proceed For Payment button...`);
        const proceedPaymentLocators = [
          By.name("main_btn_convert_01"),
          By.xpath("//button[@name='main_btn_convert_01']"),
          By.xpath("//button[.//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'PROCEED FOR PAYMENT')]]"),
          By.xpath("//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'PROCEED FOR PAYMENT')]/ancestor::button"),
          By.xpath("//button[contains(@class, 'mat-mdc-raised-button') and .//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'PROCEED')]]"),
        ];

        let proceedClicked = false;
        for (const locator of proceedPaymentLocators) {
          try {
            await scrollAndClick(driver, locator, 10000);
            proceedClicked = true;
            console.log(`[${jobId}] ✅ Clicked Proceed For Payment using: ${locator.toString()}`);
            break;
          } catch (e) {
            console.log(`[${jobId}] Proceed For Payment locator failed: ${locator.toString()}: ${e.message}`);
          }
        }

        if (!proceedClicked) {
          throw new Error("Critical Error: Proceed For Payment button not found after all locators.");
        }

        await driver.sleep(2000);
        await waitForPortalLoaderToDisappear(driver, NON_BLOCKING_LOADER_CHECK);

        // Step 2: Select Payment Option (Value 5)
        console.log(`[${jobId}] Selecting Payment Option (Value 5)...`);
        try {
          const paymentRadioLocators = [
            By.xpath("//input[@type='radio' and @value='5']"),
            By.css("input[type='radio'][value='5']"),
            By.xpath("//mat-radio-button[@value='5']//input"),
          ];

          let radioClicked = false;
          for (const locator of paymentRadioLocators) {
            try {
              const radioElement = await driver.wait(until.elementLocated(locator), 5000);
              await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", radioElement);
              await driver.sleep(300);
              await driver.executeScript("arguments[0].click();", radioElement);
              radioClicked = true;
              console.log(`[${jobId}] ✅ Clicked payment radio (value=5) using: ${locator.toString()}`);
              break;
            } catch (e) {
              console.log(`[${jobId}] Payment radio locator failed: ${locator.toString()}: ${e.message}`);
            }
          }

          if (!radioClicked) {
            console.log(`[${jobId}] ⚠️ Could not find payment radio (value=5) — continuing anyway`);
          }
        } catch (e) {
          console.log(`[${jobId}] Payment radio selection error: ${e.message}`);
        }
        await driver.sleep(1000);

        // Step 3: Click Send Payment Link button
        console.log(`[${jobId}] Clicking Send Payment Link button...`);
        const sendLinkLocators = [
          By.name("vQuote_btn_sendPayLink_01"),
          By.xpath("//button[@name='vQuote_btn_sendPayLink_01']"),
          By.xpath("//button[.//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SEND PAYMENT LINK')]]"),
          By.xpath("//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'SEND PAYMENT LINK')]/ancestor::button"),
        ];

        let sendLinkClicked = false;
        for (const locator of sendLinkLocators) {
          try {
            await scrollAndClick(driver, locator, 10000);
            sendLinkClicked = true;
            console.log(`[${jobId}] ✅ Clicked Send Payment Link using: ${locator.toString()}`);
            break;
          } catch (e) {
            console.log(`[${jobId}] Send Payment Link locator failed: ${locator.toString()}: ${e.message}`);
          }
        }

        if (!sendLinkClicked) {
          throw new Error("Critical Error: Send Payment Link button not found after all locators.");
        }

        await driver.sleep(2000);
        await waitForPortalLoaderToDisappear(driver, NON_BLOCKING_LOADER_CHECK);

        // Step 4: Close confirmation popup
        console.log(`[${jobId}] Waiting for confirmation popup and clicking Close...`);
        const closeLocators = [
          By.xpath("//button[@name='alert_btn_data_01' and .//span[contains(text(), 'Close')]]"),
          By.xpath("//button[@name='alert_btn_data_01']"),
          By.xpath("//button[.//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CLOSE')]]"),
          By.xpath("//span[contains(translate(., 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'CLOSE')]/ancestor::button"),
        ];

        let closedPopup = false;
        for (const locator of closeLocators) {
          try {
            await scrollAndClick(driver, locator, 8000);
            closedPopup = true;
            console.log(`[${jobId}] ✅ Closed confirmation popup using: ${locator.toString()}`);
            break;
          } catch (e) {
            console.log(`[${jobId}] Close popup locator failed: ${locator.toString()}: ${e.message}`);
          }
        }

        if (!closedPopup) {
          console.log(`[${jobId}] ⚠️ Could not close confirmation popup — may not have appeared`);
        }

        await driver.sleep(1000);

      } catch (e) {
        throw new Error(`Critical Error: Proceed For Payment flow failed: ${e.message}`);
      }

    } else {
      console.log(`[${jobId}] Payment method is '${formData.Paymentmethod || 'undefined'}', not 'link'. Skipping Payment flow.`);
    }

    console.log(`✅ [${jobId}] National Insurance form automation completed successfully!`);

    // Return success if post-calculation failed
    if (postCalculationFailed) {
      // Returns rather than throwing, so the catch never runs — mark the
      // failure here or KEEP_BROWSER_OPEN_ON_ERROR would miss it.
      hadError = true;
      return {
        success: false,
        error: postCalculationError || "Post-calculation stage failed",
        postSubmissionFailed: true, // Treat as post-submission failure
        stage: "post-calculation",
      };
    }

    // Return failure if post-submission failed (even if modal submission succeeded)
    if (postSubmissionFailed) {
      hadError = true;
      return {
        success: false,
        error: postSubmissionError || "Post-submission stage failed",
        postSubmissionFailed: true,
        stage: "post-submission",
      };
    }

    // ── Brisk CPA/RSA certificate ────────────────────────────────────────
    // Only when PA Cover is on AND provided by Brisk; "Company" means the
    // insurer handles it in its own portal.
    //
    // Non-fatal by design: the policy has already been submitted, so a Brisk
    // failure must not fail the job. It is reported as a warning instead —
    // server.js turns briskCertificateError into completed_with_errors.
    const briskDecision = shouldCreateBriskCertificate(data);
    let briskCertificateError = null;

    if (!briskDecision.create) {
      console.log(
        `[${jobId}] ⏭️  Skipping Brisk Certificate creation — ${briskDecision.reason}.`
      );
    } else {
      try {
        console.log(`[${jobId}] 📝 Creating Brisk Certificate (PA Cover through Brisk)...`);
        const briskResult = await createBriskCertificate(data);
        console.log(`[${jobId}] ✅ Brisk Certificate created:`, briskResult?.certificateNo || "");

        if (briskResult?.downloadUrl) {
          const briskPdfPath = await downloadBriskPDF(
            briskResult.downloadUrl,
            briskResult.policyId
          );
          await uploadBriskCertificate(
            briskPdfPath,
            briskResult.certificateNo,
            data,
            jobId
          );
        } else {
          console.log(`[${jobId}] ⚠️ Brisk returned no downloadUrl — nothing to store.`);
        }
      } catch (briskError) {
        briskCertificateError = briskError.message;
        console.error(
          `[${jobId}] ❌ Brisk Certificate creation failed: ${briskError.message}`
        );
      }
    }

    return { success: true, briskCertificateError };
  } catch (error) {
    hadError = true;
    console.error(`[${jobId}] [nationalForm] Error:`, error.message || error);

    const isValidationError =
      error.message.includes("Validation Error") ||
      error.message.includes("IDV Validation Error") ||
      error.message.includes("Convert Quote button") ||
      error.message.includes("not found") ||
      error.stage === "post-quote-generation" ||
      error.stage === "post_quote_generation_click_failure" ||
      // A failed Vahan lookup means the RegNo / EngineNo / ChassisNo in the
      // data are wrong — retrying with the same values can never succeed.
      error.isVahanError === true ||
      error.stage === "check-vahan";

    const errorStage = error.stage || "login-form";

    // Only capture a new screenshot if the error doesn't already have one attached
    let errorDetails = { screenshotUrl: error.screenshotUrl };
    if (!errorDetails.screenshotUrl) {
      console.log(`[National] Capturing late-stage error screenshot for: ${error.message}`);
      errorDetails = await captureErrorScreenshot(
        driver,
        error,
        data,
        errorStage === "login-form" ? "form-error" : errorStage
      );
    } else {
      console.log(`[National] Using previously captured screenshot: ${errorDetails.screenshotUrl}`);
    }

    return {
      success: false,
      error: beautifyError(error, "national"),
      errorStack: error.stack,
      screenshotUrl: errorDetails.screenshotUrl,
      screenshotKey: errorDetails.screenshotKey,
      pageSourceUrl: errorDetails.pageSourceUrl,
      pageSourceKey: errorDetails.pageSourceKey,
      timestamp: new Date(),
      stage: isValidationError ? "post-calculation" : errorStage, // Map validation/critical errors to post-calculation to avoid retries
      postSubmissionFailed: isValidationError, // Stop retries for these critical errors
    };
  } finally {
    // Cleanup: Always close browser and delete cloned profile
    if (jobBrowser) {
      console.log(`[${jobId}] Cleaning up browser and session data...`);
      await cleanupNationalJobBrowser(jobBrowser, { hadError });
    }
  }
}

// Main execution function for standalone script
async function main() {
  console.log("🚀 Starting National Insurance Automation...");

  // Parse command line arguments
  const formData = parseCommandLineArgs();
  console.log("📋 Using form data:", formData);

  try {
    const result = await fillNationalForm(formData);

    if (result.success) {
      console.log("✅ National Insurance automation completed successfully!");
      console.log("📸 Screenshot uploaded for verification");
    } else {
      console.log("❌ National Insurance automation failed!");
      console.log("🔍 Error:", result.error);
    }

    console.log("📊 Result:", JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("💥 Fatal error in main execution:", error);
    process.exit(1);
  }
}

// Check if this script is being run directly
if (require.main === module) {
  console.log("🎯 Running National Insurance automation as standalone script...");
  main().then(() => {
    console.log("🏁 Script execution completed");
    process.exit(0);
  }).catch((error) => {
    console.error("💥 Script execution failed:", error);
    process.exit(1);
  });
}

module.exports = {
  fillNationalForm
};
