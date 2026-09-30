/**
 * THE login loop — one implementation for Reliance, National and KSHEMA.
 *
 * Each insurer supplies a small "strategy" (login/<company>Login.js): field
 * locators, how to tell it worked, and optional hooks (pre-fill steps,
 * captcha). Everything else — waiting for the page, loading detection,
 * reading the portal's answer, deciding what it meant, whether to retry, and
 * which error code to raise — happens here, identically for all three.
 *
 * What a caller gets:
 *   resolves          → logged in, dashboard ready
 *   throws MultiCompanyError with a code and a retry decision:
 *     E205  no username/password/URL supplied ............ no retry
 *     E203  portal rejected the credentials ............... no retry
 *     E204  account locked / expired / asks for OTP ....... no retry
 *     E202  captcha kept failing ......................... retry
 *     E304  login page never loaded / portal down ......... retry
 *     E302  no answer and the page is still busy .......... retry
 *
 * Only a captcha failure is retried INSIDE this loop (Reliance has a captcha;
 * the others attempt once). Everything else that could succeed later is left to
 * the job-level retry, so a wrong password is never submitted twice.
 */
const { MultiCompanyError } = require("../errors");
const { waitForLoader, isLoaderVisible } = require("../loader");
const { firstVisible, clickWithFallback, typeWithReadback } = require("../elements");
const {
  readPortalMessage,
  classifyLoginMessage,
  looksLikeError,
  loginFailureMessage,
} = require("../portalMessages");

const POLL_MS = 300;
const sleep = (driver, ms) => driver.sleep(ms);

/** Wait until one of `selectors` is visible; null on timeout. */
async function waitForVisible(driver, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = await firstVisible(driver, selectors);
    if (el) return el;
    await sleep(driver, 250);
  }
  return null;
}

/**
 * After submitting: poll until the portal answers.
 * @returns {Promise<{type: "success"} | {type: "captcha"} |
 *   {type: "message", cls, text} | {type: "timeout", text}>}
 */
async function watchOutcome(driver, strategy, baseline) {
  const deadline = Date.now() + strategy.loginResultMs;
  let lastText = "";

  while (Date.now() < deadline) {
    if (await strategy.isLoggedIn(driver)) return { type: "success" };

    if (strategy.isCaptchaError && (await strategy.isCaptchaError(driver))) {
      return { type: "captcha" };
    }

    const text = await readPortalMessage(driver, strategy.company);
    // A message already on screen BEFORE we submitted is not the answer to it.
    if (text && text !== baseline) {
      lastText = text;
      const cls =
        classifyLoginMessage(text) ||
        (looksLikeError(text) ? { kind: "unknown", code: "E203", retryable: false } : null);
      if (cls) return { type: "message", cls, text };
    }
    await sleep(driver, POLL_MS);
  }

  // Last look — success may have landed between the final poll and now.
  if (await strategy.isLoggedIn(driver)) return { type: "success" };
  return { type: "timeout", text: lastText };
}

/**
 * @param {WebDriver} driver
 * @param {Object} strategy  see login/<company>Login.js
 * @param {{username: string, password: string, loginUrl?: string}} creds
 * @param {{jobId?: string, log?: Function}} [ctx]
 */
async function runLogin(driver, strategy, creds = {}, ctx = {}) {
  const { company, label } = strategy;
  const log = ctx.log || ((line) => console.log(line));
  const tag = ctx.jobId ? `[${ctx.jobId}] ` : "";
  const { username, password } = creds;

  if (!username || !password) {
    throw new MultiCompanyError(
      "E205",
      `No ${label} username or password reached this job — add the user's ${label} login and run the policy again.`,
      { company }
    );
  }
  const loginUrl = creds.loginUrl || strategy.defaultUrl;
  if (!loginUrl) {
    throw new MultiCompanyError(
      "E205",
      `No ${label} login URL is saved for this user — add it to the ${label} credential and run the policy again.`,
      { company }
    );
  }

  let lastError = null;

  for (let attempt = 1; attempt <= strategy.attempts; attempt++) {
    log(`${tag}🔐 ${label} login attempt ${attempt}/${strategy.attempts} as ${username}...`);

    try {
      await driver.get(loginUrl);

      // 1. The login form must actually render.
      const userField = await waitForVisible(driver, strategy.fields.username, strategy.pageLoadMs);
      if (!userField) {
        throw new MultiCompanyError(
          "E304",
          `The ${label} login page did not load (no login form after ${Math.round(strategy.pageLoadMs / 1000)} seconds) — the portal may be down. It will try again shortly.`,
          { company }
        );
      }
      await waitForLoader(driver, company);
      if (strategy.settleMs) await sleep(driver, strategy.settleMs);

      // A redirect can land us straight on the dashboard.
      if (await strategy.isLoggedIn(driver)) {
        log(`${tag}✓ ${label}: already logged in`);
        if (strategy.afterLogin) await strategy.afterLogin(driver, ctx);
        return;
      }

      // 2. Insurer-specific steps that come BEFORE the fields (National's
      //    account-type dropdowns).
      if (strategy.beforeFill) await strategy.beforeFill(driver, ctx);

      // 3. Captcha first, if this portal has one (so a bad read costs no submit).
      let captchaText = "";
      if (strategy.solveCaptcha) {
        captchaText = await strategy.solveCaptcha(driver, ctx);
        if (!captchaText) {
          log(`${tag}⚠️ ${label}: could not read the captcha — retrying`);
          lastError = new MultiCompanyError(
            "E202",
            `The ${label} captcha could not be read after ${strategy.attempts} attempts. It will try again shortly.`,
            { company }
          );
          continue;
        }
      }

      // 4. Fill.
      const uEl = await firstVisible(driver, strategy.fields.username);
      const pEl = await firstVisible(driver, strategy.fields.password);
      if (!uEl || !pEl) {
        throw new MultiCompanyError(
          "E301",
          `The ${label} login form is missing its username or password box — the portal may have changed. Contact support.`,
          { company }
        );
      }
      if (!(await typeWithReadback(driver, uEl, username)) || !(await typeWithReadback(driver, pEl, password))) {
        throw new MultiCompanyError(
          "E301",
          `The ${label} username or password could not be typed into the login form. It will try again shortly.`,
          { company }
        );
      }
      if (strategy.fields.captcha && captchaText) {
        if (strategy.pauseMs) await sleep(driver, strategy.pauseMs);
        const cEl = await firstVisible(driver, strategy.fields.captcha);
        if (cEl) await typeWithReadback(driver, cEl, captchaText);
      }

      // 5. Submit.
      if (strategy.pauseMs) await sleep(driver, strategy.pauseMs);
      const baseline = await readPortalMessage(driver, company);
      const submit = await waitForVisible(driver, strategy.fields.submit, 10000);
      if (!submit) {
        throw new MultiCompanyError(
          "E301",
          `The ${label} SIGN IN button was not found — the portal may have changed. Contact support.`,
          { company }
        );
      }
      await clickWithFallback(driver, submit);

      // 6. Wait for the portal's answer and act on what it means.
      const outcome = await watchOutcome(driver, strategy, baseline);

      if (outcome.type === "success") {
        log(`${tag}✅ ${label}: logged in as ${username}`);
        if (strategy.afterLogin) await strategy.afterLogin(driver, ctx);
        return;
      }

      if (outcome.type === "captcha") {
        log(`${tag}⚠️ ${label}: captcha rejected — retrying`);
        lastError = new MultiCompanyError(
          "E202",
          loginFailureMessage(label, "captcha", { username }),
          { company }
        );
        continue;
      }

      if (outcome.type === "message") {
        const { cls, text } = outcome;
        if (cls.kind === "captcha") {
          lastError = new MultiCompanyError("E202", loginFailureMessage(label, "captcha", { username, portalText: text }), {
            company,
            portalMessage: text,
          });
          continue;
        }
        // credentials / locked / otp / transient / unknown rejection — the
        // code's own retry rule applies, and nothing here loops on it.
        throw new MultiCompanyError(cls.code, loginFailureMessage(label, cls.kind, { username, portalText: text }), {
          company,
          retryable: cls.retryable,
          portalMessage: text,
        });
      }

      // outcome.type === "timeout": no success, no message.
      if (await isLoaderVisible(driver, company)) {
        throw new MultiCompanyError(
          "E302",
          `The ${label} portal did not answer the login within ${Math.round(strategy.loginResultMs / 1000)} seconds and is still loading — it will try again shortly.`,
          { company }
        );
      }
      // Idle, still on the login form, silent: the portal turned us away
      // without saying why. Same meaning as a rejection.
      lastError = new MultiCompanyError(
        "E203",
        loginFailureMessage(label, "unknown", { username, portalText: outcome.text }),
        { company, portalMessage: outcome.text }
      );
      if (attempt < strategy.attempts) {
        await sleep(driver, 2000);
        continue;
      }
      throw lastError;
    } catch (error) {
      // A definite answer (bad credentials, locked, no credentials ...) ends
      // the login. Only errors that time could fix are tried again.
      const definite = error instanceof MultiCompanyError && error.retryable === false;
      if (definite) throw error;
      lastError = error;
      if (attempt >= strategy.attempts) break;
      log(`${tag}❌ ${label} login attempt ${attempt} failed: ${error.message}`);
      await sleep(driver, 2000);
    }
  }

  // Attempts exhausted without a definite answer.
  if (lastError instanceof MultiCompanyError) throw lastError;
  throw new MultiCompanyError(
    "E304",
    `The ${label} login did not complete${lastError ? ` (${lastError.message})` : ""} — it will try again shortly.`,
    { company }
  );
}

module.exports = { runLogin, waitForVisible };
