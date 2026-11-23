/**
 * Reads the KSHEMA portal's toast/snackbar messages.
 *
 * The portal reports everything — bad credentials, validation problems,
 * server errors — through an Angular Material snackbar rather than inline on
 * the form:
 *
 *   <div class="cdk-global-overlay-wrapper">
 *     <div class="cdk-overlay-pane">
 *       <mat-snack-bar-container class="mdc-snackbar ... itoast-success">
 *         <simple-snack-bar>
 *           <div matsnackbarlabel class="mat-mdc-snack-bar-label">
 *             Authentication failed
 *
 * Two things make this trickier than it looks:
 *
 *  1. The container's class is NOT a reliable success/failure signal. The
 *     observed failure toast above carries `itoast-success` — the portal reuses
 *     one class for both outcomes. So the TEXT is classified, never the class.
 *  2. Material snackbars auto-dismiss after a few seconds. The watcher polls
 *     fast (250ms) rather than waiting on a single `until` condition, because a
 *     slow poll will simply miss the message and report "no error" on a login
 *     that plainly failed.
 *
 * Split out of kshemaForm.js because every later step (quote, proposal,
 * payment) reports its errors through the same snackbar.
 */
const { By } = require("selenium-webdriver");
// one browser call per page read instead of one per element (speed round 2)
const pageReads = require("../../lib/pageReads");

/** Where the message text lives, most specific first. */
const TOAST_TEXT_SELECTORS = [
  "mat-snack-bar-container [matsnackbarlabel]",
  "mat-snack-bar-container .mat-mdc-snack-bar-label",
  "simple-snack-bar .mdc-snackbar__label",
  "simple-snack-bar",
  "#mat-mdc-snack-bar-container-live",
  "mat-snack-bar-container",
  // Non-Material fallbacks, in case part of the portal uses a different toast.
  ".toast-message",
  ".ngx-toastr",
];

/** Any container at all — used to notice a toast even if the text is empty. */
const TOAST_CONTAINER_SELECTORS = [
  "mat-snack-bar-container",
  ".cdk-overlay-pane mat-snack-bar-container",
  ".mat-mdc-snack-bar-container",
];

/**
 * Words that mean "this did not work".
 *
 * Matched against the toast text because the class cannot be trusted (see the
 * header). Deliberately broad — a success message wrongly flagged as an error
 * costs a screenshot; a failure missed costs a policy that looks fine and is
 * not.
 */
const ERROR_WORDS = [
  "fail", "failed", "invalid", "incorrect", "wrong", "error",
  "unauthor", "denied", "not found", "expired", "locked", "blocked",
  "unable", "unavailable", "could not", "cannot", "required",
  "try again", "unsuccessful", "rejected", "timed out", "too many",
  // Not failures in the portal's own words, but the automation cannot answer
  // any of them, so they have to stop the job rather than slip through.
  "captcha", "otp", "verification code",
  // Validation errors
  "limits", "please provide",
  // 2026-10-16: "The Liability product type is not available for the selected RTO state." after Save and Continue
  // was read as harmless ("unavailable" is in the list, "not available" was not) and the run went on. [TP] 12
  "not available", "not allowed", "not eligible", "not permitted", "not supported", "not valid",
  // 2026-10-22: "Policy not assigned to you/team" when a resumed run opens the saved proposal page of a proposal that is
  // not this KSHEMA user's. It was read as harmless, so the run waited a minute for buttons that never came.
  "not assigned"
];

/** Words that clearly mean it worked — checked first so "logged in successfully" is not caught by "success"-adjacent noise. */
const SUCCESS_WORDS = ["success", "welcome", "logged in", "completed"];

function classifyToast(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return { isError: false, isSuccess: false };
  const isError = ERROR_WORDS.some((w) => t.includes(w));
  // An explicit failure word wins: "login failed successfully" is not a thing,
  // but "Authentication failed" inside an itoast-SUCCESS container is.
  const isSuccess = !isError && SUCCESS_WORDS.some((w) => t.includes(w));
  return { isError, isSuccess };
}

// The whole readToast below, worked out inside the page in ONE browser call (speed round 2: with no toast on screen the
// one-by-one way costs 11 calls, and it runs after every settling field). Same order, same rules: a text selector's
// first SHOWN element with text wins, with the class of the FIRST mat-snack-bar-container (shown or not, as
// findElement gave it); else the first shown container; else nothing.
const READ_TOAST_SCRIPT = `${pageReads.IS_SHOWN}${pageReads.FIND_ALL}
  var textSelectors = arguments[0] || [];
  var containerSelectors = arguments[1] || [];
  for (var i = 0; i < textSelectors.length; i++) {
    var els;
    try {
      els = Array.prototype.slice.call(document.querySelectorAll(textSelectors[i]));
    } catch (e) {
      continue;
    }
    for (var j = 0; j < els.length; j++) {
      try {
        if (!isShown(els[j])) continue;
        var text = textOf(els[j]).trim();
        if (!text) continue;
        var containerClass = "";
        try {
          var first = document.querySelector("mat-snack-bar-container");
          containerClass = first ? first.getAttribute("class") || "" : "";
        } catch (e) {}
        return { kind: "text", index: i, text: text, containerClass: containerClass };
      } catch (e) {}
    }
  }
  for (var k = 0; k < containerSelectors.length; k++) {
    try {
      var boxes = document.querySelectorAll(containerSelectors[k]);
      for (var m = 0; m < boxes.length; m++) {
        if (isShown(boxes[m])) return { kind: "container", index: k, containerClass: boxes[m].getAttribute("class") || "" };
      }
    } catch (e) {}
  }
  return { kind: "none" };
`;

/** readToast in one browser call; throws when that call cannot run (the caller then reads one by one). */
async function readToastAtOnce(driver) {
  const res = await driver.executeScript(READ_TOAST_SCRIPT, TOAST_TEXT_SELECTORS, TOAST_CONTAINER_SELECTORS);
  if (!res || typeof res !== "object") throw new Error("the page did not answer");
  if (res.kind === "none") return null;
  if (res.kind === "text" && TOAST_TEXT_SELECTORS[res.index] && res.text) {
    const text = String(res.text).trim();
    return { text, selector: TOAST_TEXT_SELECTORS[res.index], containerClass: String(res.containerClass || ""), ...classifyToast(text) };
  }
  if (res.kind === "container" && TOAST_CONTAINER_SELECTORS[res.index]) {
    return {
      text: "",
      selector: TOAST_CONTAINER_SELECTORS[res.index],
      containerClass: String(res.containerClass || ""),
      isError: false,
      isSuccess: false,
    };
  }
  throw new Error("the page gave an answer that does not fit");
}

/** Read whatever toast is on screen right now, or null. */
async function readToast(driver) {
  if (driver && typeof driver.executeScript === "function") {
    try {
      return await readToastAtOnce(driver);
    } catch (e) {
      /* one call per selector / element below, exactly as before */
    }
  }
  for (const selector of TOAST_TEXT_SELECTORS) {
    let elements = [];
    try {
      elements = await driver.findElements(By.css(selector));
    } catch (e) {
      continue;
    }
    for (const el of elements) {
      try {
        if (!(await el.isDisplayed())) continue;
        const text = (await el.getText()).trim();
        if (!text) continue;
        let containerClass = "";
        try {
          const container = await driver.findElement(By.css("mat-snack-bar-container"));
          containerClass = (await container.getAttribute("class")) || "";
        } catch (e) { }
        return { text, selector, containerClass, ...classifyToast(text) };
      } catch (e) {
        // toast dismissed itself between find and read — keep looking
      }
    }
  }

  // A container with no readable text still means something appeared.
  for (const selector of TOAST_CONTAINER_SELECTORS) {
    try {
      const elements = await driver.findElements(By.css(selector));
      for (const el of elements) {
        if (await el.isDisplayed()) {
          return {
            text: "",
            selector,
            containerClass: (await el.getAttribute("class")) || "",
            isError: false,
            isSuccess: false,
          };
        }
      }
    } catch (e) { }
  }

  return null;
}

/**
 * Is this failure worth another attempt?
 *
 * Only when TIME alone could fix it. A wrong password is the same wrong
 * password five minutes later, and every retry burns one of the portal's
 * lockout attempts — so a pointless retry does not just waste a run, it can
 * lock the account the operator is about to fix.
 */
function isRetryableToast(toastText) {
  const t = String(toastText || "").toLowerCase();
  // The portal being busy or briefly refusing traffic clears on its own.
  if (/too many|rate limit|try again later|server|internal|503|502|500|maintenance|timeout|timed out|temporarily/.test(t)) {
    return true;
  }
  // Everything else needs a human: fix the credential, unlock the account,
  // reset the password. Retrying changes nothing.
  return false;
}

/**
 * Turn a portal toast into a message the operator can act on.
 *
 * These land in the policy's error log in the app, so they name the fix, not
 * the symptom — and they say plainly whether the policy needs re-running,
 * because a non-retryable failure will NOT come back on its own. The portal's
 * own wording is kept on the end; support will ask for it verbatim.
 */
function friendlyLoginError(toastText) {
  const t = String(toastText || "").trim();
  const lower = t.toLowerCase();
  const quoted = t ? ` (the portal said: "${t}")` : "";

  if (/authentication failed|invalid.*(credential|user|password)|incorrect.*(password|user)|wrong.*(password|user)/.test(lower)) {
    return (
      "The KSHEMA portal rejected the login — the username or password saved " +
      "for this policy is wrong. Correct the KSHEMA login on the User page " +
      "(edit the user → Credentials) or in Profile → Account & Policy " +
      `Settings, then run this policy again${quoted}.`
    );
  }
  if (/locked|blocked|suspend|disabled|deactivat/.test(lower)) {
    return (
      "The KSHEMA portal account is locked or disabled. Contact KSHEMA to " +
      `re-enable it, then run this policy again${quoted}.`
    );
  }
  if (/expired|reset your password|change.*password/.test(lower)) {
    return (
      "The KSHEMA portal password has expired. Log in to the portal by hand, " +
      "set a new password, update it on the User page (edit the user → " +
      `Credentials), then run this policy again${quoted}.`
    );
  }
  if (/captcha|otp|verification code/.test(lower)) {
    return (
      "The KSHEMA portal asked for an extra verification step (captcha or OTP) " +
      `that the automation cannot complete on its own${quoted}. Contact support.`
    );
  }
  if (/too many|rate limit|attempts/.test(lower)) {
    return (
      "The KSHEMA portal refused the login after too many attempts. It will " +
      `try again shortly on its own${quoted}.`
    );
  }
  if (/server|internal|503|502|500|maintenance|down/.test(lower)) {
    return (
      "The KSHEMA portal reported a problem on its own side. This is not a " +
      `problem with the policy — it will try again shortly${quoted}.`
    );
  }
  return t
    ? `The KSHEMA portal refused the login${quoted}. Check the KSHEMA login ` +
      "saved for this user or client, then run this policy again."
    : "The KSHEMA portal refused the login without saying why. Check the " +
      "KSHEMA login saved for this user or client, then run this policy again.";
}

module.exports = {
  TOAST_TEXT_SELECTORS,
  TOAST_CONTAINER_SELECTORS,
  readToast,
  classifyToast,
  isRetryableToast,
  friendlyLoginError,
};
