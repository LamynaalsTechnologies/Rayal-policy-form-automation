/**
 * Reading what the portal SAYS after a login attempt, and deciding what it
 * means — for every insurer, in one place.
 *
 * Generalised from fullPolicycompany/kshema/kshemaToast.js, the only place
 * that ever actually read the portal's words. Reliance looked only for its
 * captcha error and National looked only at whether the page changed, so a
 * wrong password was invisible to both: it was retried (and, on Reliance,
 * could even be reported as a captcha failure).
 *
 * The meaning of a message is decided by classifyLoginMessage; the retry flag
 * follows from the meaning, so it is decided once, here — not per insurer.
 */
const { By } = require("selenium-webdriver");

/** Snack-bars / toasts / alerts / validation text, most specific first. */
const MESSAGE_SELECTORS = {
  // Angular Material portals (KSHEMA, National) and generic toast libraries.
  common: [
    "mat-snack-bar-container [matsnackbarlabel]",
    "mat-snack-bar-container .mat-mdc-snack-bar-label",
    "simple-snack-bar .mdc-snackbar__label",
    "simple-snack-bar",
    "mat-snack-bar-container",
    ".toast-message",
    ".ngx-toastr",
    ".alert-danger",
    "[role='alert']",
    "mat-error",
    ".mat-mdc-form-field-error",
  ],
  // Reliance SmartZone is ASP.NET MVC: field/summary validation spans.
  reliance: [
    "span.field-validation-error",
    ".validation-summary-errors",
    "#lblMessage",
    "#lblError",
    "#spnMessage",
    ".text-danger",
  ],
  national: [],
  kshema: [],
};

/**
 * Text of the first visible, non-empty message on screen, or "".
 * @param {string} company
 */
async function readPortalMessage(driver, company) {
  const selectors = [...(MESSAGE_SELECTORS[company] || []), ...MESSAGE_SELECTORS.common];
  for (const selector of selectors) {
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
        if (text) return text;
      } catch (e) {
        /* dismissed between find and read — keep looking */
      }
    }
  }
  return "";
}

/**
 * What does this message mean for the login?
 *
 * Order matters: a message can hit two patterns ("Invalid password — too many
 * attempts"), and the account being wrong is the one that needs a human.
 *
 * Retryable means "time alone could fix it". A wrong password is the same wrong
 * password five minutes later, and every retry burns one of the portal's
 * lockout attempts — a pointless retry can lock the very account the operator
 * is about to fix.
 *
 * @returns {{kind: string, code: string, retryable: boolean}|null}
 *   null when the text is not one we recognise — the caller decides.
 */
function classifyLoginMessage(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;

  if (
    /authentication failed|invalid.{0,30}(credential|user ?(id|name)?|password|login)|incorrect.{0,30}(password|user)|wrong.{0,30}(password|user)|user.{0,20}(does not|doesn't|not) (exist|found|registered)|password.{0,20}(is )?(wrong|incorrect|invalid)/.test(
      t
    )
  ) {
    return { kind: "credentials", code: "E203", retryable: false };
  }
  if (/locked|blocked|suspend|disabled|deactivat|expired|reset your password|change.{0,20}password/.test(t)) {
    return { kind: "locked", code: "E204", retryable: false };
  }
  if (/\botp\b|verification code/.test(t)) {
    return { kind: "otp", code: "E204", retryable: false };
  }
  if (/captcha/.test(t)) {
    return { kind: "captcha", code: "E202", retryable: true };
  }
  if (/too many|rate limit|try again later|server|internal|503|502|500|maintenance|timeout|timed out|temporarily|unavailable/.test(t)) {
    return { kind: "transient", code: "E304", retryable: true };
  }
  return null;
}

/**
 * Does this text read like a rejection at all? Used for a message that matches
 * none of the specific patterns above: on a login page, right after submitting,
 * a NEW message saying "failed / invalid / denied ..." is the portal turning us
 * away, and waiting out the full timeout for it would only delay the answer.
 */
function looksLikeError(text) {
  return /fail|invalid|incorrect|wrong|error|denied|unauthor|not found|rejected|unsuccessful|unable|cannot|could not/i.test(
    String(text || "")
  );
}

/**
 * The operator-facing sentence for a login failure. Names the fix, not the
 * symptom, and says plainly whether the policy needs re-running — a
 * non-retryable failure will NOT come back on its own. The portal's own words
 * are kept on the end; support will ask for them verbatim.
 */
function loginFailureMessage(companyLabel, kind, { username = "", portalText = "" } = {}) {
  const said = portalText ? ` (the portal said: "${portalText}")` : "";
  const who = username ? ` for "${username}"` : "";
  switch (kind) {
    case "credentials":
      return (
        `The ${companyLabel} portal rejected the login${who} — the username or password ` +
        `saved for this user is wrong. Correct the ${companyLabel} login in the user's ` +
        `Credentials, then run this policy again${said}.`
      );
    case "locked":
      return (
        `The ${companyLabel} portal account${who} is locked, disabled or its password has ` +
        `expired. Fix it on the portal, update the saved login if the password changed, ` +
        `then run this policy again${said}.`
      );
    case "otp":
      return (
        `The ${companyLabel} portal asked for an extra verification step (OTP) that the ` +
        `automation cannot complete on its own${said}. Contact support.`
      );
    case "captcha":
      return `The ${companyLabel} portal kept rejecting the captcha. It will try again shortly${said}.`;
    case "transient":
      return (
        `The ${companyLabel} portal reported a problem on its own side. This is not a ` +
        `problem with the policy — it will try again shortly${said}.`
      );
    default:
      return (
        `The ${companyLabel} portal did not accept the login${who}${said}. Check the ` +
        `${companyLabel} username and password saved for this user, then run this policy again.`
      );
  }
}

module.exports = {
  MESSAGE_SELECTORS,
  readPortalMessage,
  classifyLoginMessage,
  looksLikeError,
  loginFailureMessage,
};
