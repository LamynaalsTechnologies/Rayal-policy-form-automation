/**
 * KSHEMA portal automation, end to end.
 *
 * The run in order: sign in, confirm the dashboard really loaded, open
 * Two-Wheeler, then fill the quote — customer details, vehicle details, PA
 * cover, premium — submit it, add the add-ons, download the proposal PDF, fill
 * the nominee and KYC, and finish at the Razorpay QR.
 *
 * It STOPS at the QR on purpose. The QR still has to be scanned by the customer,
 * so no money moves on its own; the automation's job ends once there is
 * something to pay against, and the link is written back onto the policy.
 *
 * motorinsurance.kshema.co is an Angular Material SPA. Its markup is not in the
 * served HTML (the page source is an empty app shell), so every selector here
 * comes from the RENDERED DOM, and the `ng-tns-c*` classes Angular sprays on
 * each element are avoided — they change on every KSHEMA deploy.
 */
const { By } = require("selenium-webdriver");
const {
  CONFIG,
  createKshemaJobBrowser,
  cleanupKshemaJobBrowser,
} = require("./kshema/kshemaSessionManager");
const { log, debug, warn, err, VERBOSE } = require("./kshema/kshemaLog");
const { uploadScreenshotToS3, generateScreenshotKey } = require("../s3Uploader");
const {
  readToast,
  friendlyLoginError,
  isRetryableToast,
} = require("./kshema/kshemaToast");
const {
  fillCustomerDetails,
  fillVehicleDetails,
  downloadProposal,
} = require("./kshema/kshemaQuoteForm");
const { isAutomationStop, stoppedResult } = require("../automationStopper");
const { shouldKeepBrowserOpen } = require("../debugRetention");
// Shared with Reliance and National — the CPA/RSA certificate is Brisk's, not
// the insurer's, so the same three calls serve all three companies.
const {
  createBriskCertificate,
  downloadBriskPDF,
  uploadBriskCertificate,
  shouldCreateBriskCertificate,
} = require("../briskCertificate");

/**
 * Selectors for the login boxes, most specific first.
 *
 * The portal is Angular Material. Its real markup is:
 *
 *   <input matinput id="login_email"    class="mat-mdc-input-element ...">
 *   <input matinput id="login_password" class="mat-mdc-input-element ..." type="password">
 *
 * Two things worth knowing, both learned from the rendered DOM rather than the
 * served HTML (the page is an SPA shell until the bundle runs):
 *
 *  - The email input has **no `type` attribute at all** — no name, no
 *    formcontrolname, no placeholder either. A CSS attribute selector only
 *    matches when the attribute is PRESENT, so `input[type="text"]` and
 *    `input[type="email"]` both miss it. The id is the only reliable hook.
 *  - The field is labelled EMAIL, so the username stored against the KSHEMA
 *    credential has to be the operator's portal email address, not a code.
 *
 * The looser entries below the ids are kept as a safety net for the day the
 * portal renames something — better a wrong-but-visible field than a silent
 * "could not find the login form".
 */
const USERNAME_SELECTORS = [
  "#login_email",
  'input[id*="login_email" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[formcontrolname*="user" i]',
  'input[formcontrolname*="email" i]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[type="email"]',
  'input[placeholder*="user" i]',
  'input[placeholder*="email" i]',
  'input[type="text"]',
  // Last resort: a visible matinput that is NOT the password box. Catches the
  // real field's shape — a bare <input> carrying no type at all.
  'input[matinput]:not([type="password"])',
];

const PASSWORD_SELECTORS = [
  "#login_password",
  'input[id*="login_password" i]',
  'input[type="password"]',
  'input[formcontrolname*="pass" i]',
  'input[id*="pass" i]',
  'input[name*="pass" i]',
];

/**
 * The SIGN IN button:
 *
 *   <button data-iid="sign-in" class="login-btn signin-btn">SIGN IN</button>
 *
 * `data-iid` first — it is the portal's own test hook, so it survives styling
 * changes that would rename `signin-btn`. No id and no type attribute here
 * either, so `button[type="submit"]` would miss it.
 */
const SIGN_IN_SELECTORS = [
  'button[data-iid="sign-in"]',
  "button.signin-btn",
  "button.login-btn",
  ".signin-div button",
  'button[type="submit"]',
];

/**
 * Proof that we are actually on the dashboard.
 *
 * The portal shows product tiles once you are in:
 *
 *   <div class="top-product ...">
 *     <div title="New Quote" class="icon"><img class="prod-icon-img" src=".../wheeler.png"></div>
 *     <div class="detail"><div>Two-Wheeler</div>...
 *
 * Only the stable hooks are used. The `ng-tns-c2256434270-12` classes on every
 * element are Angular's per-component scoping ids — they change on each build,
 * so anything keyed on them breaks the next time KSHEMA deploys.
 *
 * This is checked INSTEAD of "did the login box disappear": the login form is
 * gone during the redirect too, so its absence would report success a moment
 * before the dashboard has actually loaded.
 */
const DASHBOARD_SELECTORS = [
  ".top-product",
  'div[title="New Quote"]',
  "img.prod-icon-img",
  'img[src*="wheeler"]',
  'div[title="Quote list"]',
];

/**
 * How long to wait for the portal to answer a sign-in.
 *
 * Generous on purpose — the portal is often slow, and cutting it short would
 * report a login failure for a login that was simply still in flight.
 */
const LOGIN_RESULT_WAIT_MS = 20000;

/**
 * The Two-Wheeler product tile on the dashboard:
 *
 *   <div class="top-product">
 *     <div title="New Quote" class="icon">
 *       <img class="prod-icon-img" src=".../assets/img/wheeler.png">
 *     <div class="detail"><div>Two-Wheeler</div>
 *
 * Matched on the image filename first — `wheeler.png` is what actually
 * identifies this product, and it survives a class rename. The tile carries
 * several Two-Wheeler-looking products' markup in common, so the image is the
 * only part unique to this one.
 *
 * Clicking the IMAGE is what the portal expects (that is the element the user
 * pointed at); the tile wrappers below are fallbacks in case the click handler
 * ever moves up a level.
 */
const TWO_WHEELER_SELECTORS = [
  'img.prod-icon-img[src*="wheeler"]',
  'img[src*="wheeler.png"]',
  'img[src*="wheeler"]',
  '.top-product img.prod-icon-img',
];

/** The whole tile, used when the image itself refuses the click. */
const TWO_WHEELER_TILE_SELECTORS = [
  '.top-product',
  'div[title="New Quote"]',
];

/** How long to wait for the dashboard tiles to finish rendering. */
const DASHBOARD_TILE_WAIT_MS = 20000;

/** First element matching any selector in the list that is actually visible. */
async function findFirstVisible(driver, selectors, label) {
  for (const selector of selectors) {
    let elements = [];
    try {
      elements = await driver.findElements(By.css(selector));
    } catch (e) {
      continue;
    }
    for (const el of elements) {
      try {
        if (await el.isDisplayed()) {
          debug(`   ✓ ${label} matched: ${selector}`);
          return { element: el, selector };
        }
      } catch (e) {
        // element went stale between find and check — just try the next one
      }
    }
  }
  debug(`   ✗ ${label}: no visible match across ${selectors.length} selectors`);
  return { element: null, selector: null };
}

/**
 * Wait for the KSHEMA Angular Material loader to disappear.
 *
 * It looks for the mat-spinner that appears during network requests.
 * If it stays on screen longer than the timeout, logs a warning but continues,
 * letting the caller's own element wait be the real gate.
 *
 * @param {WebDriver} driver
 * @param {number} timeoutMs Maximum time to wait (default 20000)
 */
async function waitForKshemaLoaderToDisappear(driver, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 200;
  const loaderSelector = 'mat-spinner[data-iid="__loading"], .mat-mdc-progress-spinner';

  // Wait for it to clear.
  while (Date.now() < deadline) {
    try {
      const loaders = await driver.findElements(By.css(loaderSelector));
      if (loaders.length === 0) {
        // Loader is completely gone from the DOM
        return;
      }

      let isVisible = false;
      for (const loader of loaders) {
        if (await loader.isDisplayed()) {
          isVisible = true;
          break;
        }
      }

      if (!isVisible) {
        // Loaders exist in DOM but are hidden
        return;
      }
    } catch (e) {
      // StaleElementReferenceError etc. usually means it was removed from DOM
      return;
    }
    await driver.sleep(pollInterval);
  }
  
  throw new Error(`KSHEMA loader did not disappear after ${timeoutMs}ms`);
}

/**
 * Log every input and button on the page with its identifying attributes.
 *
 * This is the point of phase 1 — the next phase gets written from this dump
 * instead of from guesswork.
 */
async function dumpPageControls(driver) {
  try {
    const inputs = await driver.findElements(By.css("input"));
    debug(`${inputs.length} input element(s) on the page:`);
    for (let i = 0; i < inputs.length; i++) {
      try {
        const [type, id, name, fcn, placeholder, visible] = await Promise.all([
          inputs[i].getAttribute("type"),
          inputs[i].getAttribute("id"),
          inputs[i].getAttribute("name"),
          inputs[i].getAttribute("formcontrolname"),
          inputs[i].getAttribute("placeholder"),
          inputs[i].isDisplayed(),
        ]);
        debug(
          `   [${i}] type=${type || "-"} id=${id || "-"} name=${name || "-"} ` +
          `formcontrolname=${fcn || "-"} placeholder=${placeholder || "-"} ` +
          `visible=${visible}`
        );
      } catch (e) {
        debug(`   [${i}] <could not read attributes: ${e.message}>`);
      }
    }

    const buttons = await driver.findElements(By.css("button"));
    debug(`${buttons.length} button(s) on the page:`);
    for (let i = 0; i < buttons.length; i++) {
      try {
        const [text, id, type, visible] = await Promise.all([
          buttons[i].getText(),
          buttons[i].getAttribute("id"),
          buttons[i].getAttribute("type"),
          buttons[i].isDisplayed(),
        ]);
        debug(
          `   [${i}] text="${(text || "").trim()}" id=${id || "-"} ` +
          `type=${type || "-"} visible=${visible}`
        );
      } catch (e) { }
    }
  } catch (e) {
    warn(`Could not enumerate the page's elements: ${e.message}`);
  }
}

/**
 * Type into an Angular Material input and CONFIRM the value landed.
 *
 * Reading the value back is not paranoia here: matinput fields sit behind a
 * form-field wrapper that can swallow keystrokes if the input never took focus,
 * and sendKeys reports success either way. Without the read-back a login would
 * fail later with "invalid credentials" and no clue that the box was empty.
 *
 * @param {boolean} secret - masks the value in the log (password)
 */
async function typeInto(driver, element, value, label, secret = false) {
  if (!element) return false;
  try {
    // Click first: Material only wires up the control once it has focus, and a
    // field below the fold cannot be clicked at all.
    await driver.executeScript(
      "arguments[0].scrollIntoView({block:'center'});",
      element
    );
    try {
      await element.click();
    } catch (e) {
      // An overlay can eat the click — typing usually still works.
    }
    await element.clear();
    await element.sendKeys(value);

    const landed = await element.getAttribute("value");
    if (landed !== value) {
      warn(
        `   ${label} did not take the value ` +
        `(expected ${value.length} chars, the box holds ${(landed || "").length})`
      );
      return false;
    }
    debug(`   → ${label} entered${secret ? "" : `: ${value}`}`);
    return true;
  } catch (e) {
    warn(`   Could not type the ${label}: ${e.message}`);
    return false;
  }
}

/**
 * Click an element, falling back to a JS click.
 *
 * Angular Material's ripple layer sits over its own controls and swallows the
 * occasional real click. The JS click bypasses the overlay and still fires the
 * Angular handler.
 */
async function clickElement(driver, element, label) {
  await driver.executeScript(
    "arguments[0].scrollIntoView({block:'center'});",
    element
  );
  try {
    await element.click();
  } catch (clickError) {
    warn(`   Normal click on ${label} was intercepted, using a JS click: ${clickError.message}`);
    await driver.executeScript("arguments[0].click();", element);
  }
}

/**
 * Open the Two-Wheeler product from the dashboard.
 *
 * Waits for the tile rather than looking once — the dashboard renders its
 * products asynchronously, so the first look after a login regularly lands
 * before they exist.
 *
 * @returns {Promise<{clicked: boolean, selector: string|null, reason: string|null}>}
 */
async function openTwoWheeler(driver) {
  debug(`🛵 Looking for the Two-Wheeler product (up to ${DASHBOARD_TILE_WAIT_MS / 1000}s)...`);

  const deadline = Date.now() + DASHBOARD_TILE_WAIT_MS;
  let found = { element: null, selector: null };
  while (Date.now() < deadline) {
    found = await findFirstVisible(driver, TWO_WHEELER_SELECTORS, "Two-Wheeler icon");
    if (found.element) break;
    await driver.sleep(500);
  }

  // The image is the intended target, but if it will not take the click the
  // surrounding tile usually carries the handler too.
  if (!found.element) {
    debug("   Two-Wheeler image not found — trying the product tile instead");
    found = await findFirstVisible(driver, TWO_WHEELER_TILE_SELECTORS, "Two-Wheeler tile");
  }

  if (!found.element) {
    return {
      clicked: false,
      selector: null,
      reason: "The Two-Wheeler product was not on the dashboard.",
    };
  }

  try {
    await clickElement(driver, found.element, "the Two-Wheeler product");
    debug(`✓ Two-Wheeler clicked via ${found.selector}`);
    await waitForKshemaLoaderToDisappear(driver, 20000);
    return { clicked: true, selector: found.selector, reason: null };
  } catch (e) {
    return {
      clicked: false,
      selector: found.selector,
      reason: `The Two-Wheeler product could not be clicked: ${e.message}`,
    };
  }
}

/** Is a dashboard product tile on screen? Proof the login actually landed. */
async function isDashboardShowing(driver) {
  for (const selector of DASHBOARD_SELECTORS) {
    try {
      const elements = await driver.findElements(By.css(selector));
      for (const el of elements) {
        try {
          if (await el.isDisplayed()) return selector;
        } catch (e) { }
      }
    } catch (e) { }
  }
  return null;
}

/**
 * Wait for the portal to say what happened to the sign-in.
 *
 * Polls for BOTH outcomes together rather than waiting on one then the other:
 *
 *  - an error snackbar  → rejected
 *  - a dashboard tile   → in
 *
 * Racing them matters in both directions. Waiting on the toast first would sit
 * out the full timeout on a SUCCESSFUL login (no error toast ever comes), and
 * waiting on the dashboard first would miss the snackbar, which Material
 * dismisses after a few seconds.
 *
 * Returns `{ outcome: "rejected"|"dashboard"|"timeout", toast, marker }`.
 */
async function waitForLoginOutcome(driver, timeoutMs, pollMs = 400) {
  const deadline = Date.now() + timeoutMs;
  let lastToast = null;

  while (Date.now() < deadline) {
    const toast = await readToast(driver);
    if (toast && toast.text) {
      lastToast = toast;
      if (toast.isError) return { outcome: "rejected", toast, marker: null };
    }

    const marker = await isDashboardShowing(driver);
    if (marker) return { outcome: "dashboard", toast: lastToast, marker };

    await driver.sleep(pollMs);
  }

  return { outcome: "timeout", toast: lastToast, marker: null };
}

/**
 * Capture the screen straight to S3 — the same way National does it
 * (see captureErrorScreenshot in national.js).
 *
 * S3 only, nothing written to disk. server.js reads `result.screenshotUrl`
 * when it writes the job's error log, and that URL is what the operator opens
 * from the policy in the app. A PNG on the automation server helps nobody: the
 * operator cannot reach that machine, and server.js wipes `screenshots/` on
 * every boot anyway.
 *
 * Never throws — a screenshot that fails to upload must not turn into a failed
 * job on top of whatever went wrong already.
 *
 * @param {string} stage - goes into the S3 key, so the reason is readable from
 *   the path alone (login_rejected / dashboard / exception ...)
 * @returns {Promise<{screenshotUrl: string|null, screenshotKey: string|null}>}
 */
async function captureScreenshot(driver, name, data = {}, stage = "error") {
  const result = { screenshotUrl: null, screenshotKey: null };
  if (!driver) return result;

  let image;
  try {
    image = await driver.takeScreenshot();
  } catch (e) {
    warn(`Could not take a screenshot: ${e.message}`);
    return result;
  }

  try {
    result.screenshotKey = generateScreenshotKey(
      data._jobIdentifier || name,
      data._attemptNumber || 1,
      stage,
      "kshema"
    );
    result.screenshotUrl = await uploadScreenshotToS3(image, result.screenshotKey);
    debug(`📸 Screenshot uploaded: ${result.screenshotKey}`);
  } catch (e) {
    warn(
      `Could not upload the screenshot to S3, so it will not show in the app: ${e.message}`
    );
  }

  return result;
}

/**
 * Turn whatever went wrong into something the operator can act on.
 *
 * These strings land in the policy's error log in the app, so they are written
 * for the person who has to fix the policy — not for whoever reads the stack
 * trace. Every branch says what happened AND what to do about it.
 */
function friendlyError(rawMessage) {
  const msg = String(rawMessage || "");

  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION/i.test(msg)) {
    return (
      "Could not reach the KSHEMA portal — the server did not respond. " +
      "Check the internet connection on the automation machine, then retry."
    );
  }
  if (/ERR_CONNECTION_TIMED_OUT|timeout|timed out/i.test(msg)) {
    return (
      "The KSHEMA portal took too long to load. It is usually the portal being " +
      "slow or down — try again in a few minutes."
    );
  }
  if (/chromedriver|chrome not reachable|session not created|DevToolsActivePort/i.test(msg)) {
    return (
      "The automation browser could not be started on the server. This is a " +
      "setup problem, not a policy problem — contact support."
    );
  }
  if (/ENOSPC|no space left/i.test(msg)) {
    return (
      "The automation server has run out of disk space, so no browser could " +
      "be opened. Contact support."
    );
  }
  return `KSHEMA automation could not open the portal login page: ${msg}`;
}

/**
 * Open the KSHEMA login page and fill in the credentials.
 *
 * @param {Object} data - job payload. Uses username / password / loginUrl,
 *   which server.js resolves from ProviderCredential (the policy's user's own
 *   login first, then the client's) and injects AFTER the formData spread.
 * @returns {Promise<Object>} `{ success, error, browserLeftOpen, ... }`
 */
async function fillKshemaForm(data = {}) {
  const jobId = `${data.firstName || "kshema"}_${Date.now()}`;
  const loginUrl = data.loginUrl || CONFIG.LOGIN_URL;
  let jobBrowser = null;
  // Set from the flow's outcome so the finally knows whether to keep the window.
  let hadError = true;

  try {
    const outcome = await runKshemaFlow(data, jobId, loginUrl, (b) => (jobBrowser = b));
    // A clean run is either a COMPLETED policy or the deliberate stopping
    // point. Both have to be listed: the flow used to end only at the stopping
    // point, and when it grew a real completion the check still asked only
    // about inProgress — so every successful policy was recorded as an error
    // and, with KEEP_BROWSER_OPEN_ON_ERROR set, left its browser open.
    hadError = !(
      outcome && (outcome.success === true || outcome.inProgress === true)
    );
    return { ...outcome, browserLeftOpen: shouldKeepBrowserOpen(hadError) };
  } finally {
    // The browser used to be left open on EVERY path. That was right while the
    // job was to look at a login page; it is a leak now that real jobs run —
    // KSHEMAMAXWINDOW=2 means two Chrome processes and two profile directories
    // per job, none of them ever reclaimed.
    //
    // Same rule as the other two companies: keep it open only for a FAILURE,
    // and only when KEEP_BROWSER_OPEN_ON_ERROR says to.
    await cleanupKshemaJobBrowser(jobBrowser, { hadError });
  }
}

async function runKshemaFlow(data, jobId, loginUrl, registerBrowser) {
  let jobBrowser = null;
  let crashShot = null;

  debug("=".repeat(60));
  debug(`🏁 Job ${jobId} — phase 1, login screen only`);
  debug(`🔗 Login URL: ${loginUrl}`);
  debug(`👤 Username:  ${data.username || "(none supplied)"}`);
  debug("=".repeat(60));

  if (!data.username || !data.password) {
    err("No portal username/password reached the automation");
    return {
      success: false,
      stage: "login-form",
      // The credential has to be added by a person; nothing changes on its own.
      retryable: false,
      error:
        "No KSHEMA portal login was found for this policy. Add the KSHEMA " +
        "username and password on the User page (edit the user → Credentials) " +
        "or in Profile → Account & Policy Settings, and this policy will " +
        "retry automatically.",
    };
  }

  try {
    jobBrowser = await createKshemaJobBrowser(jobId);
    const { driver } = jobBrowser;

    debug(`🌐 Opening ${loginUrl}`);
    await driver.get(loginUrl);

    // An Angular SPA serves an empty shell, so readyState alone proves nothing
    // — wait until the bundle has actually rendered a form control.
    try {
      await waitForKshemaLoaderToDisappear(driver, 20000);
      await driver.wait(async () => {
        const state = await driver.executeScript("return document.readyState");
        return state === "complete";
      }, 30000);
    } catch (e) {
      warn("The page never reported readyState 'complete' — carrying on anyway");
    }

    debug("⏳ Waiting for the app to render its login form...");
    let renderedInputs = false;
    try {
      await driver.wait(async () => {
        const inputs = await driver.findElements(By.css("input"));
        for (const el of inputs) {
          try {
            if (await el.isDisplayed()) return true;
          } catch (e) { }
        }
        return false;
      }, CONFIG.LOGIN_TIMEOUT);
      renderedInputs = true;
      debug("✓ App rendered");
    } catch (e) {
      warn(`No visible input appeared within ${CONFIG.LOGIN_TIMEOUT}ms`);
    }

    // Angular often paints the shell first and the form a beat later.
    await driver.sleep(2000);

    const pageUrl = await driver.getCurrentUrl();
    const pageTitle = await driver.getTitle();
    debug(`📍 Landed on: ${pageUrl}`);
    debug(`📄 Title:     ${pageTitle}`);
    if (pageUrl !== loginUrl) {
      debug("ℹ️  The portal redirected — note this URL, phase 2 will need it.");
    }

    if (VERBOSE) await dumpPageControls(driver);

    debug("🔍 Locating the credential fields...");
    const user = await findFirstVisible(driver, USERNAME_SELECTORS, "username");
    const pass = await findFirstVisible(driver, PASSWORD_SELECTORS, "password");

    let filled = 0;
    if (await typeInto(driver, user.element, data.username, "username")) filled++;
    if (await typeInto(driver, pass.element, data.password, "password", true)) filled++;

    // Deliberately NOT clicking Login and NOT calling cleanupKshemaJobBrowser.
    // The open window is the deliverable of this phase.
    debug("=".repeat(60));
    debug("🔍 BROWSER LEFT OPEN — do not close it yet.");
    debug(
      `   Fields filled: ${filled}/2` +
      (user.selector ? ` | username via ${user.selector}` : "") +
      (pass.selector ? ` | password via ${pass.selector}` : "")
    );
    debug(`   Profile: ${jobBrowser.profileInfo.userDataDir}`);
    debug("=".repeat(60));

    // ── Sign in ────────────────────────────────────────────────────────────
    // Only attempted when BOTH boxes actually hold their value. Clicking with a
    // half-filled form would burn an attempt against the portal's lockout
    // counter and produce a misleading "Authentication failed".
    let signInClicked = false;
    if (filled === 2) {
      const signIn = await findFirstVisible(driver, SIGN_IN_SELECTORS, "SIGN IN button");
      if (signIn.element) {
        try {
          await driver.executeScript(
            "arguments[0].scrollIntoView({block:'center'});",
            signIn.element
          );
          try {
            await signIn.element.click();
          } catch (clickError) {
            // Material ripple overlays intercept the odd click — go direct.
            warn(`   Normal click was intercepted, using a JS click: ${clickError.message}`);
            await driver.executeScript("arguments[0].click();", signIn.element);
          }
          signInClicked = true;
          debug("🖱️  SIGN IN clicked — waiting for the portal to answer...");
        } catch (e) {
          warn(`   Could not click SIGN IN: ${e.message}`);
        }
      }
    } else {
      warn(
        `   Not clicking SIGN IN — only ${filled}/2 boxes were filled. ` +
        "A half-filled submit would count against the portal's lockout limit."
      );
    }

    // Nothing was submitted — stop here rather than watching for an answer that
    // cannot come.
    if (!signInClicked) {
      const shot = await captureScreenshot(
        driver,
        `kshema_signin_failed_${jobId}`,
        data,
        "signin_not_pressed"
      );
      const detail = filled < 2
        ? "its username and password boxes could not both be filled in"
        : "its SIGN IN button could not be pressed";
      err(`Could not submit the login — ${detail}`);
      return {
        success: false,
        stage: "login-form",
        // A changed login screen is the same on attempt five as on attempt one.
        retryable: false,
        error:
          `Could not sign in to the KSHEMA portal — ${detail}. The portal has ` +
          "most likely changed its login screen. Contact support.",
        loggedIn: false,
        signInClicked: false,
        fieldsFilled: filled,
        usernameSelector: user.selector,
        passwordSelector: pass.selector,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle,
        screenshotUrl: shot.screenshotUrl,
        screenshotKey: shot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── Wait for the portal to answer ──────────────────────────────────────
    // Two things can arrive: an error snackbar (which Material dismisses after
    // a few seconds, so it has to be caught as it happens), or a dashboard
    // product tile. Whichever comes first decides the outcome.
    debug(`👀 Waiting up to ${LOGIN_RESULT_WAIT_MS / 1000}s for the portal to answer...`);
    const outcome = await waitForLoginOutcome(driver, LOGIN_RESULT_WAIT_MS);
    const toast = outcome.toast;

    let errorShot = null;
    if (toast) {
      debug(`💬 Portal message: "${toast.text}"`);
      debug(`   via ${toast.selector} | container class: ${toast.containerClass || "-"}`);
    }

    if (outcome.outcome === "rejected") {
      {
        // Screenshot FIRST — the snackbar is on a timer and the evidence is
        // gone within seconds.
        errorShot = await captureScreenshot(
          driver,
          `kshema_login_error_${jobId}`,
          data,
          "login_rejected"
        );
        const friendly = friendlyLoginError(toast.text);
        // "Authentication failed" is the same failure however many times it is
        // tried, and every attempt counts against the portal's lockout limit —
        // so retrying would leave the operator with a locked account on top of
        // a wrong password. Only a genuinely temporary refusal (portal busy,
        // rate limited, 5xx) is worth another go.
        const retryable = isRetryableToast(toast.text);

        err(`Login rejected: ${toast.text}`);
        err(friendly);
        if (!retryable) {
          err("Not retrying — this cannot succeed until someone fixes it.");
        }

        return {
          success: false,
          stage: "login-form",
          // Read by server.js: false means mark the job failed now, no backoff,
          // no further attempts.
          retryable,
          // What the operator sees in the policy's error log.
          error: friendly,
          onPageError: toast.text,
          loginRejected: true,
          toastText: toast.text,
          toastContainerClass: toast.containerClass,
          browserLeftOpen: true,
          fieldsFilled: filled,
          usernameSelector: user.selector,
          passwordSelector: pass.selector,
          pageUrl: await driver.getCurrentUrl(),
          pageTitle,
          // server.js copies these onto the job's error log — this is what
          // makes the screenshot openable from the policy in the app.
          screenshotUrl: errorShot.screenshotUrl,
          screenshotKey: errorShot.screenshotKey,
          _jobBrowser: jobBrowser,
        };
      }

    }

    const finalUrl = await driver.getCurrentUrl();
    const finalTitle = await driver.getTitle();
    const loggedIn = outcome.outcome === "dashboard";

    // ── Neither answer arrived inside the wait ─────────────────────────────
    // Reported as a LOGIN failure, not as "a tile was missing". The dashboard
    // tile is only how the check is made — what actually happened is that the
    // sign-in did not go through, and that is what has to reach the operator.
    if (!loggedIn) {
      const timeoutShot = await captureScreenshot(
        driver,
        `kshema_login_timeout_${jobId}`,
        data,
        "login_no_response"
      );
      const seconds = LOGIN_RESULT_WAIT_MS / 1000;

      err(`Sign-in did not complete within ${seconds}s`);
      err(`Still on: ${finalUrl}`);

      return {
        success: false,
        stage: "login-form",
        // Worth retrying: a slow portal is the usual cause and it clears on
        // its own. Unlike a wrong password, another attempt can genuinely work.
        retryable: true,
        error:
          `Could not sign in to the KSHEMA portal. The login details were ` +
          `entered and submitted, but the portal did not open the dashboard ` +
          `or report a problem within ${seconds} seconds — it is usually the ` +
          `portal being slow. This policy will be tried again automatically.` +
          (toast ? ` The portal last said: "${toast.text}".` : ""),
        loginTimedOut: true,
        signInClicked,
        loggedIn: false,
        toastText: toast ? toast.text : null,
        browserLeftOpen: true,
        fieldsFilled: filled,
        usernameSelector: user.selector,
        passwordSelector: pass.selector,
        pageUrl: finalUrl,
        pageTitle: finalTitle,
        screenshotUrl: timeoutShot.screenshotUrl,
        screenshotKey: timeoutShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    debug(`✓ Dashboard confirmed via ${outcome.marker}`);
    log("✅ LOGGED IN — the portal accepted the credentials.");
    debug(`   Now on: ${finalUrl}`);

    // ── Open the Two-Wheeler product ───────────────────────────────────────
    const twoWheeler = await openTwoWheeler(driver);

    if (!twoWheeler.clicked) {
      const shot = await captureScreenshot(
        driver,
        `kshema_two_wheeler_missing_${jobId}`,
        data,
        "two_wheeler_not_available"
      );
      err(twoWheeler.reason);

      return {
        success: false,
        stage: "dashboard",
        // The dashboard renders its products asynchronously and the portal can
        // be slow, so this is worth another go — unlike a wrong password, a
        // second attempt can genuinely find the tile there.
        retryable: true,
        error:
          "Signed in to the KSHEMA portal, but the Two-Wheeler product could " +
          "not be opened — the dashboard did not show it. This is usually the " +
          "portal being slow to load, and the policy will be tried again " +
          `automatically. (${twoWheeler.reason})`,
        loggedIn: true,
        twoWheelerOpened: false,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: finalTitle,
        screenshotUrl: shot.screenshotUrl,
        screenshotKey: shot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // Let the quote screen render before handing back — its markup is what the
    // next phase gets written from.
    await driver.sleep(4000);
    const quoteUrl = await driver.getCurrentUrl();
    const quoteTitle = await driver.getTitle();
    log("✅ Two-Wheeler opened.");
    debug(`   Now on: ${quoteUrl}`);

    // ── Customer details ───────────────────────────────────────────────────
    // The capture hook fires while a failing dropdown is STILL OPEN. For an
    // empty locality list that is the whole of the evidence — closed, the
    // screenshot shows an ordinary-looking form and says nothing about why.
    const capture = (name, stage) =>
      captureScreenshot(driver, `${name}_${jobId}`, data, stage);

    const customer = await fillCustomerDetails(driver, data, capture);

    if (!customer.ok) {
      // A dropdown failure already photographed itself with the panel open;
      // only fall back to a plain form shot when there is no such picture.
      const customerShot =
        customer.screenshots[0] ||
        (await captureScreenshot(
          driver,
          `kshema_customer_details_${jobId}`,
          data,
          "customer_details_failed"
        ));
      err(customer.error);
      return {
        success: false,
        stage: "quote-customer-details",
        // The fields that failed need either a data fix on the policy or a
        // look at a changed form — neither happens by running it again.
        retryable: false,
        error: customer.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        customerFieldFailures: customer.failures,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: customerShot.screenshotUrl,
        screenshotKey: customerShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── Vehicle details ────────────────────────────────────────────────────
    const vehicle = await fillVehicleDetails(driver, data, capture);

    if (!vehicle.ok) {
      const vehicleShot =
        (vehicle.screenshots && vehicle.screenshots[0]) ||
        (await captureScreenshot(
          driver,
          `kshema_vehicle_details_${jobId}`,
          data,
          "vehicle_details_failed"
        ));
      err(vehicle.error);
      return {
        success: false,
        stage: "quote-vehicle-details",
        retryable: false,
        error: vehicle.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        vehicleFieldFailures: vehicle.failures,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: vehicleShot.screenshotUrl,
        screenshotKey: vehicleShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── PA Cover details ───────────────────────────────────────────────────
    const { fillPaCoverDetails } = require("./kshema/kshemaQuoteForm");
    const paCover = await fillPaCoverDetails(driver, data, capture);

    if (!paCover.ok) {
      const paShot =
        paCover.screenshots[0] ||
        (await captureScreenshot(
          driver,
          `kshema_pa_cover_details_${jobId}`,
          data,
          "pa_cover_details_failed"
        ));
      err(paCover.error);
      return {
        success: false,
        stage: "quote-pa-cover-details",
        retryable: false,
        error: paCover.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        paCoverFieldFailures: paCover.failures,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: paShot.screenshotUrl,
        screenshotKey: paShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── Premium / Discount details ──────────────────────────────────────────
    const { fillPremiumDetails } = require("./kshema/kshemaQuoteForm");
    const premium = await fillPremiumDetails(driver, data, capture);

    if (!premium.ok) {
      const premShot =
        premium.screenshots[0] ||
        (await captureScreenshot(
          driver,
          `kshema_premium_details_${jobId}`,
          data,
          "premium_details_failed"
        ));
      err(premium.error);
      return {
        success: false,
        stage: "quote-premium-details",
        retryable: false,
        error: premium.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: premShot.screenshotUrl,
        screenshotKey: premShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── Submit Quote Form ──────────────────────────────────────────────────
    const { submitQuoteForm } = require("./kshema/kshemaQuoteForm");
    const submitResult = await submitQuoteForm(driver);
    
    if (!submitResult.ok) {
      const submitShot = await captureScreenshot(
        driver,
        `kshema_quote_submit_failed_${jobId}`,
        data,
        "quote_submit_failed"
      );
      err(submitResult.error);
      return {
        success: false,
        stage: "quote-submit",
        retryable: false, // If it failed validation or toast error, human intervention usually needed
        error: submitResult.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: submitShot.screenshotUrl,
        screenshotKey: submitShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── Add-Ons Details ────────────────────────────────────────────────────
    const { fillAddonsDetails } = require("./kshema/kshemaQuoteForm");
    const addonsResult = await fillAddonsDetails(driver, data, capture);

    if (!addonsResult.ok) {
      const addonsShot =
        addonsResult.screenshots[0] ||
        (await captureScreenshot(
          driver,
          `kshema_addons_details_${jobId}`,
          data,
          "addons_details_failed"
        ));
      err(addonsResult.error);
      return {
        success: false,
        stage: "quote-addons-details",
        retryable: false,
        error: addonsResult.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        addonsFieldsFilled: addonsResult.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: addonsShot.screenshotUrl,
        screenshotKey: addonsShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    debug("=".repeat(60));
    log("✅ Quote form successfully submitted and Add-ons selected!");
    
    // ── Download Proposal ────────────────────────────────────────────────────
    const downloadResult = await downloadProposal(driver, data, jobBrowser, jobId, capture);
    
    if (!downloadResult.ok) {
      err(downloadResult.error);
      const downloadShot = await capture("proposal_download_failed");
      return {
        success: false,
        stage: "proposal-download",
        retryable: false,
        error: downloadResult.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        addonsFieldsFilled: addonsResult.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: downloadShot.screenshotUrl,
        screenshotKey: downloadShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }
    
    // ── Update OnlinePolicy Record ───────────────────────────────────────────
    log("💾 Updating OnlinePolicy with the proposal PDF...");
    let client = null;
    try {
      const { MongoClient, ObjectId } = require('mongodb');
      const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/rayal';
      client = new MongoClient(mongoUrl);
      await client.connect();
      const db = client.db();
      const collection = db.collection('onlinePolicy');
      
      let policyIdForUpdate;
      if (data._id) {
        policyIdForUpdate = typeof data._id === 'string' ? new ObjectId(data._id) : data._id;
      } else if (data.policyId) {
        policyIdForUpdate = typeof data.policyId === 'string' ? new ObjectId(data.policyId) : data.policyId;
      }
      
      if (policyIdForUpdate) {
        await collection.updateOne(
          { _id: policyIdForUpdate },
          {
            $set: {
              proposalPdf: {
                fileName: `proposalpdf_${jobId}.pdf`,
                key: downloadResult.pdfKey,
                location: downloadResult.pdfUrl,
                presignedUrl: downloadResult.presignedUrl,
              },
              updatedAt: new Date()
            }
          }
        );
        log("✅ Successfully saved Proposal PDF to database!");
      } else {
        warn("⚠️ No valid policy ID found to update Proposal PDF.");
      }
    } catch (e) {
      warn(`⚠️ Failed to update DB with proposal PDF: ${e.message}`);
    } finally {
      // Closed here, not at the end of the try: anything that threw in
      // between — a bad ObjectId, a failed update — used to skip the
      // close and leak the connection for the life of the process.
      if (client) await client.close().catch(() => {});
    }

    // ── Nominee Details ──────────────────────────────────────────────────────
    const { fillNomineeDetails } = require("./kshema/kshemaQuoteForm");
    const nomineeResult = await fillNomineeDetails(driver, data, capture);

    if (!nomineeResult.ok) {
      err(nomineeResult.error);
      const nomineeShot = await captureScreenshot(
        driver,
        `kshema_nominee_details_failed_${jobId}`,
        data,
        "nominee_details_failed"
      );
      return {
        success: false,
        stage: "nominee-details",
        retryable: false,
        error: nomineeResult.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        addonsFieldsFilled: addonsResult.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: nomineeShot.screenshotUrl,
        screenshotKey: nomineeShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    // ── KYC Details ──────────────────────────────────────────────────────────
    const { fillKYCDetails } = require("./kshema/kshemaQuoteForm");
    const kycResult = await fillKYCDetails(driver, data, capture);

    // Save the links BEFORE deciding whether the KYC failed.
    //
    // They were written after the failure return, so a refused or unfinished
    // KYC — the one case where somebody has to open that page by hand — threw
    // the link away. It is captured either way, so it is stored either way.

    if (kycResult.kycUrl || kycResult.proposalUrl) {
      log("💾 Updating OnlinePolicy with the KYC and proposal links...");
      let client = null;
      try {
        const { MongoClient, ObjectId } = require('mongodb');
        const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/rayal';
        client = new MongoClient(mongoUrl);
        await client.connect();
        const db = client.db();
        const collection = db.collection('onlinePolicy');
        
        let policyIdForUpdate;
        if (data._id) {
          policyIdForUpdate = typeof data._id === 'string' ? new ObjectId(data._id) : data._id;
        } else if (data.policyId) {
          policyIdForUpdate = typeof data.policyId === 'string' ? new ObjectId(data.policyId) : data.policyId;
        }
        
        if (policyIdForUpdate) {
          await collection.updateOne(
            { _id: policyIdForUpdate },
            {
              $set: {
                // Only write what was actually captured — a blank string here
                // would overwrite a good link from an earlier run with nothing.
                ...(kycResult.kycUrl ? { kycLink: kycResult.kycUrl } : {}),
                ...(kycResult.proposalUrl
                  ? { proposalLink: kycResult.proposalUrl }
                  : {}),
                // What the portal said about the KYC, in its own words —
                // "No record found" and the like. Stored so the operator can
                // read it on the policy instead of hunting through job logs.
                ...(kycResult.kycStatus
                  ? { kycStatus: kycResult.kycStatus }
                  : {}),
                updatedAt: new Date()
              }
            }
          );
          log("✅ Saved the KYC and proposal links to the policy.");
        } else {
          warn("⚠️ No valid policy ID found to update KYC Link.");
        }
      } catch (e) {
        warn(`⚠️ Failed to update DB with KYC Link: ${e.message}`);
      } finally {
        // Closed here, not at the end of the try: anything that threw in
        // between — a bad ObjectId, a failed update — used to skip the
        // close and leak the connection for the life of the process.
        if (client) await client.close().catch(() => {});
      }
    }

    if (!kycResult.ok) {
      err(kycResult.error);
      const kycShot = await captureScreenshot(
        driver,
        `kshema_kyc_details_failed_${jobId}`,
        data,
        "kyc_details_failed"
      );
      return {
        success: false,
        stage: "kyc-details",
        retryable: false,
        error: kycResult.error,
        kycUrl: kycResult.kycUrl,
        proposalUrl: kycResult.proposalUrl,
        stayedOnKycPage: kycResult.stayedOnKycPage === true,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        addonsFieldsFilled: addonsResult.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: kycShot.screenshotUrl,
        screenshotKey: kycShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }
    // ── Payment Details ──────────────────────────────────────────────────────────
    // ── Brisk CPA/RSA certificate ──────────────────────────────────────────
    // Raised HERE, once KYC has passed, and not before.
    //
    // The certificate costs money out of the Brisk wallet, so it must only be
    // raised for a policy that is actually going to exist. Everything before
    // this point can still fall over on portal data — a refused KYC, a missing
    // field — and a certificate raised at the start of the run would have been
    // paid for and then orphaned. By this line the proposal is made, the PDF is
    // filed and KYC is accepted; the only step left is the customer paying.
    //
    // Only when PA Cover is ON and provided by BRISK. "Company" means the
    // insurer covers it inside its own portal and Brisk must not be touched.
    //
    // Non-fatal by design, exactly as in national.js: the proposal already
    // exists at the insurer, so a Brisk failure must not fail the job.
    // server.js turns briskCertificateError into completed_with_errors.
    const briskDecision = shouldCreateBriskCertificate(data);
    let briskCertificateError = null;

    if (!briskDecision.create) {
      log(`⏭️  No Brisk certificate — ${briskDecision.reason}.`);
    } else {
      try {
        log("📝 Creating the Brisk certificate (PA Cover through Brisk)...");
        const briskResult = await createBriskCertificate(data);
        log(`✅ Brisk certificate created: ${briskResult?.certificateNo || "(no number returned)"}`);

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
          log("✅ Brisk certificate stored against the policy.");
        } else {
          warn("Brisk returned no download link — there is nothing to store.");
        }
      } catch (briskError) {
        briskCertificateError = briskError.message;
        err(`Brisk certificate creation failed: ${briskError.message}`);
      }
    }

    const { proceedToPayment } = require("./kshema/kshemaQuoteForm");
    const paymentResult = await proceedToPayment(driver, capture, jobId);

    if (!paymentResult.ok) {
      err(paymentResult.error);
      const paymentShot = await captureScreenshot(
        driver,
        `kshema_payment_failed_${jobId}`,
        data,
        "payment_failed"
      );
      return {
        success: false,
        stage: "payment",
        retryable: false,
        error: paymentResult.error,
        loggedIn: true,
        twoWheelerOpened: true,
        customerFieldsFilled: customer.filled,
        vehicleFieldsFilled: vehicle.filled,
        paCoverFieldsFilled: paCover.filled,
        premiumFieldsFilled: premium.filled,
        addonsFieldsFilled: addonsResult.filled,
        browserLeftOpen: true,
        pageUrl: await driver.getCurrentUrl(),
        pageTitle: quoteTitle,
        screenshotUrl: paymentShot.screenshotUrl,
        screenshotKey: paymentShot.screenshotKey,
        _jobBrowser: jobBrowser,
      };
    }

    if (paymentResult.paymentUrl) {
      log("💾 Updating OnlinePolicy with the Payment Link...");
      let client = null;
      try {
        const { MongoClient, ObjectId } = require('mongodb');
        const mongoUrl = process.env.MONGODB_URI || 'mongodb://localhost:27017/rayal';
        client = new MongoClient(mongoUrl);
        await client.connect();
        const db = client.db();
        const collection = db.collection('onlinePolicy');
        
        let policyIdForUpdate;
        if (data._id) {
          policyIdForUpdate = typeof data._id === 'string' ? new ObjectId(data._id) : data._id;
        } else if (data.policyId) {
          policyIdForUpdate = typeof data.policyId === 'string' ? new ObjectId(data.policyId) : data.policyId;
        }
        
        if (policyIdForUpdate) {
          await collection.updateOne(
            { _id: policyIdForUpdate },
            {
              $set: {
                paymentLink: paymentResult.paymentUrl,
                updatedAt: new Date()
              }
            }
          );
          log("✅ Successfully saved Payment Link to database!");
        } else {
          warn("⚠️ No valid policy ID found to update Payment Link.");
        }
      } catch (e) {
        warn(`⚠️ Failed to update DB with Payment Link: ${e.message}`);
      } finally {
        // Closed here, not at the end of the try: anything that threw in
        // between — a bad ObjectId, a failed update — used to skip the
        // close and leak the connection for the life of the process.
        if (client) await client.close().catch(() => {});
      }
    }

    debug("=".repeat(60));
    log("🎉 KSHEMA flow successfully completed up to Payment QR Generation!");
    debug("=".repeat(60));
    
    // No browser cleanup here: createKshemaJobBrowser returns
    // { driver, profileInfo, jobId } and has no close() of its own, so the
    // guarded call that used to sit here silently did nothing while reading as
    // if it tidied up. fillKshemaForm's finally closes the window on every
    // path — that is the one place it happens.

    return {
      success: true,
      stage: "completed",
      policyId: data.policyId || data._id,
      // Read by server.js: a value here turns the job into
      // completed_with_errors rather than a plain success.
      briskCertificateError,
      loggedIn: true,
      signInClicked,
      twoWheelerOpened: true,
      twoWheelerSelector: twoWheeler.selector,
      customerFieldsFilled: customer.filled,
      vehicleFieldsFilled: vehicle.filled,
      paCoverFieldsFilled: paCover.filled,
      premiumFieldsFilled: premium.filled,
      addonsFieldsFilled: addonsResult.filled,
      fieldsFilled: filled,
      usernameSelector: user.selector,
      passwordSelector: pass.selector,
      renderedInputs,
      pageUrl: quoteUrl,
      pageTitle: quoteTitle,
      screenshotUrl: paymentResult.qrScreenshotUrl,
      screenshotKey: paymentResult.qrScreenshotKey,
      toastText: toast ? toast.text : null,
    };
  } catch (error) {
    // stopper() was called somewhere above. Hand it back as a stop rather than
    // letting the error handling below dress it up as a crash.
    if (isAutomationStop(error)) {
      log("⏸️  " + error.message);
      debug("🔍 BROWSER LEFT OPEN at the stopping point.");
      return stoppedResult(error, {
        pageUrl: jobBrowser ? await jobBrowser.driver.getCurrentUrl().catch(() => null) : null,
        _jobBrowser: jobBrowser,
      });
    }

    err(error.message);
    if (jobBrowser && jobBrowser.driver) {
      crashShot = await captureScreenshot(jobBrowser.driver, `kshema_error_${jobId}`, data, "exception");
      debug("🔍 Browser left open after the error so the page can be inspected.");
    }
    return {
      success: false,
      stage: "login-form",
      error: friendlyError(error.message),
      browserLeftOpen: !!jobBrowser,
      screenshotUrl: crashShot ? crashShot.screenshotUrl : null,
      screenshotKey: crashShot ? crashShot.screenshotKey : null,
      _jobBrowser: jobBrowser,
    };
  }
}

module.exports = { fillKshemaForm, USERNAME_SELECTORS, PASSWORD_SELECTORS, waitForKshemaLoaderToDisappear };
