/**
 * United India (UIIC GCWebPortal) login strategy, for the shared login loop (./runLogin.js).
 *
 * Taken from the owner's older download project (Rayal_Brokers/Rayal-auto-pdf-downlod: xldownload.js, the United India
 * XL flow, and pdfdownload/pdfdownload.js, its PDF tool), which has logged in to this portal every day:
 *   - the page:     https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login (a saved credential URL wins)
 *   - the boxes:    #username, #password (name userPaWord), captcha #userCaptcha, captcha picture #captchaImg,
 *                   button #login (the fallbacks below are the old ones). The boxes can be readonly until focused, so the
 *                   old code removed readonly first - so does beforeFill.
 *   - logged in:    the "View Reports and Queries" menu a[data-target='#10'], a.menuColor / a.subMenuColor, #sidebar, a
 *                   "Policy Documents" link - or the login box gone from a finished page that is no longer the login page.
 *   - refused:      the #loginError / .loginError box (./portalMessages.js reads it); a captcha refusal mentions captcha.
 *   - captcha:      the picture is enlarged 3x by the page's own canvas (the old note: tiny captchas were misread, the same
 *                   ones enlarged were read right), then read by Captcha.js; only 4 to 8 letters / digits are typed.
 *   - loader:       none was ever seen; the old code slept. Here the page must finish loading (../loader.js "united india",
 *                   waitReady) and every wait polls instead of sleeping, with no implicit wait (a missing box answers at once).
 * What the loop adds (the same for every insurer): a wrong password is never submitted twice ([E203]), a captcha refusal is
 * tried again on a fresh page with a fresh captcha ([E202]), a page that never loads is [E304], one still loading [E302].
 *
 * NOT taken over: the old PDF tool printed the password in its log and kept default credentials in its source.
 * NOT seen on the live portal from THIS code yet: which success marker the page after login shows, the error wording,
 * any loader, and a "session already active" message.
 */
const { By } = require("selenium-webdriver");
const { extractCaptchaText } = require("../../../Captcha");
const { waitForLoader } = require("../loader");
const { firstVisible } = require("../elements");

const COMPANY = "united india";
const LABEL = "United India";
const DEFAULT_URL = "https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login";

/** What a captcha on this portal looks like (the old project's own check). */
const CAPTCHA_FORMAT = /^[A-Za-z0-9]{4,8}$/;

const FIELDS = {
  username: ["#username", "input[name='userName']", "input[name='username']"],
  password: ["#password", "input[name='userPaWord']", "input[type='password']"],
  captcha: ["#userCaptcha", "input[name='userCaptcha']", "input[id*='captcha' i]", "input[name*='captcha' i]"],
  submit: [
    "#login",
    "#btnLogin",
    "button.login100-form-btn",
    "button[type='submit']",
    "input[type='submit']",
    "input[type='image'][src*='login' i]",
    By.xpath("//button[contains(translate(normalize-space(.),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'LOGIN')]"),
    By.xpath("//input[@type='button' and contains(translate(@value,'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'LOGIN')]"),
  ],
};

const CAPTCHA_IMAGE = ["#captchaImg", "img[src*='captcha' i]", "img[id*='captcha' i]"];

/**
 * Logged in? ONE script call per poll (the old PDF tool's lesson: separate element lookups cost a round trip each).
 * The "login box gone" rule counts only on a page that has finished loading, is no longer the login address, and shows
 * no login error - a half-loaded page between the submit and the answer must never read as logged in.
 * @returns {Promise<boolean>}
 */
async function isLoggedIn(driver) {
  try {
    const answer = await driver.executeScript(`
      var shown = function (el) { return !!el && el.offsetParent !== null; };
      var marker = document.querySelector("a[data-target='#10'], a.menuColor, a.subMenuColor, #sidebar");
      if (shown(marker)) return true;
      var links = document.getElementsByTagName("a");
      for (var i = 0; i < links.length; i++) {
        if ((links[i].textContent || "").indexOf("Policy Documents") !== -1 && shown(links[i])) return true;
      }
      if (document.readyState !== "complete") return false;
      if (/[?&]p=login\\b/i.test(location.href)) return false;
      var user = document.getElementById("username");
      var pass = document.getElementById("password");
      var error = document.querySelector("#loginError, .loginError");
      if (shown(user) || shown(pass)) return false;
      if (error && shown(error) && (error.textContent || "").trim()) return false;
      return !!document.body && links.length > 0;
    `);
    return answer === true;
  } catch (e) {
    return false; // mid-navigation - keep polling
  }
}

/** The portal's error box says the captcha was wrong. */
async function isCaptchaError(driver) {
  try {
    const text = await driver.executeScript(`
      var els = document.querySelectorAll("#loginError, .loginError");
      for (var i = 0; i < els.length; i++) {
        if (els[i].offsetParent !== null) return (els[i].textContent || "").trim();
      }
      return "";
    `);
    return /captcha/i.test(String(text || ""));
  } catch (e) {
    return false;
  }
}

/** The boxes can be readonly until they are focused (an anti-autofill trick); the old code removed it before typing. */
async function beforeFill(driver) {
  await driver
    .executeScript(
      `
      var ids = ["username", "password", "userCaptcha"];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (el) el.removeAttribute("readonly");
      }
      var named = document.getElementsByName("userPaWord");
      for (var j = 0; j < named.length; j++) named[j].removeAttribute("readonly");
    `
    )
    .catch(() => {});
}

/**
 * Enlarge the captcha picture with the page's own canvas (no image library), at most 512 px so it stays one OpenAI tile.
 * Copied from the old project's captcha.js upscaleCaptchaImage. Any failure returns the picture unchanged.
 */
async function upscale(driver, base64Png, factor = 3) {
  try {
    const result = await driver.executeAsyncScript(
      `
      var src = arguments[0], factor = arguments[1], done = arguments[arguments.length - 1];
      var img = new Image();
      img.onload = function () {
        try {
          var f = Math.min(factor, Math.floor(512 / Math.max(img.naturalWidth, img.naturalHeight)));
          if (!(f >= 2)) return done(null);
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(img.naturalWidth * f);
          canvas.height = Math.round(img.naturalHeight * f);
          var ctx = canvas.getContext("2d");
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          done(canvas.toDataURL("image/png").split(",")[1]);
        } catch (e) { done(null); }
      };
      img.onerror = function () { done(null); };
      img.src = "data:image/png;base64," + src;
    `,
      base64Png,
      factor
    );
    return typeof result === "string" && result ? result : base64Png;
  } catch (e) {
    return base64Png;
  }
}

/** The default reader: Captcha.js, NOT counted as a Reliance captcha (its daily counter has no United India field). */
async function readWithOpenAi(imageUrl) {
  const result = await extractCaptchaText(imageUrl, { count: false });
  return result && result.success ? result.text : "";
}

/**
 * The strategy, with the captcha reader replaceable (tests and the replica check use a fake one).
 * @param {{ readCaptcha?: (imageUrl: string) => Promise<string>, now?: () => number }} [opts]
 */
function createUnitedIndiaStrategy({ readCaptcha = readWithOpenAi, now = Date.now } = {}) {
  /**
   * Read the captcha. "" = could not be read (the loop then opens a fresh page with a new captcha).
   * The picture is taken from the element in memory - no file is written.
   */
  async function solveCaptcha(driver, ctx = {}) {
    const log = ctx.log || ((line) => console.log(line));
    const deadline = now() + 10000;
    let img = null;
    while (!img && now() < deadline) {
      img = await firstVisible(driver, CAPTCHA_IMAGE);
      if (!img) await driver.sleep(250);
    }
    if (!img) {
      log("⚠️ United India: the captcha picture is not on the login page");
      return "";
    }
    // the picture must have finished loading, or the screenshot is blank
    const loadedBy = now() + 3000;
    for (;;) {
      const loaded = await driver
        .executeScript("var i = arguments[0]; return !!(i && i.complete && i.naturalWidth > 0);", img)
        .catch(() => false);
      if (loaded || now() >= loadedBy) break;
      await driver.sleep(150);
    }
    let picture;
    try {
      picture = await img.takeScreenshot(true);
    } catch (e) {
      log(`⚠️ United India: the captcha picture could not be taken (${e.message})`);
      return "";
    }
    const enlarged = await upscale(driver, picture);
    let text = "";
    try {
      text = String((await readCaptcha(`data:image/png;base64,${enlarged}`)) || "").replace(/[^A-Za-z0-9]/g, "");
    } catch (e) {
      log(`⚠️ United India: the captcha reader failed (${e.message})`);
      return "";
    }
    if (!CAPTCHA_FORMAT.test(text)) {
      log(`⚠️ United India: the captcha was read as "${text}", not 4 to 8 letters or digits - a fresh captcha is tried`);
      return "";
    }
    log(`🔑 United India captcha read: ${text}`);
    return text;
  }

  return {
    company: COMPANY,
    label: LABEL,
    defaultUrl: DEFAULT_URL,
    // Only a captcha refusal (or an attempt that ended without a definite answer) goes round again; a wrong password
    // ends the login at once (runLogin), so it is never sent twice.
    attempts: 3,
    pageLoadMs: 30000,
    loginResultMs: 20000,
    pauseMs: 0,
    fields: FIELDS,
    isLoggedIn,
    isCaptchaError,
    beforeFill,
    solveCaptcha,
    // The page after the login has finished loading before the flow goes on (or stops for the Breaker).
    afterLogin: async (driver) => {
      await waitForLoader(driver, COMPANY).catch(() => {});
    },
  };
}

module.exports = {
  ...createUnitedIndiaStrategy(),
  createUnitedIndiaStrategy,
  DEFAULT_URL,
  CAPTCHA_FORMAT,
  FIELDS,
  upscale,
};
