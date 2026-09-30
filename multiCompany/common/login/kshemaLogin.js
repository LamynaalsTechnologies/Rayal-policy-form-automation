/**
 * KSHEMA login strategy. Locators and dashboard markers are the ones the
 * working flow (fullPolicycompany/kshemaForm.js) already uses — the portal's
 * own ids first, loose fallbacks after, so a small rename degrades to a
 * slightly-less-precise match instead of "could not find the login form".
 *
 * KSHEMA already read the portal's toast and gave friendly messages; that logic
 * now lives in ../portalMessages.js and serves the other two portals as well.
 */
const { firstVisible } = require("../elements");

const DASHBOARD_SELECTORS = [
  ".top-product",
  'div[title="New Quote"]',
  "img.prod-icon-img",
  'img[src*="wheeler"]',
  'div[title="Quote list"]',
];

async function isLoggedIn(driver) {
  try {
    return !!(await firstVisible(driver, DASHBOARD_SELECTORS));
  } catch (e) {
    return false;
  }
}

module.exports = {
  company: "kshema",
  label: "KSHEMA",
  defaultUrl: "https://motorinsurance.kshema.co/app/home",
  attempts: 1,
  pageLoadMs: 30000,
  loginResultMs: 20000,
  settleMs: 2000, // Angular finishes wiring the form after it first appears
  pauseMs: 0,
  fields: {
    username: [
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
      'input[matinput]:not([type="password"])',
    ],
    password: [
      "#login_password",
      'input[id*="login_password" i]',
      'input[type="password"]',
      'input[formcontrolname*="pass" i]',
      'input[id*="pass" i]',
      'input[name*="pass" i]',
    ],
    submit: [
      'button[data-iid="sign-in"]',
      "button.signin-btn",
      "button.login-btn",
      ".signin-div button",
      'button[type="submit"]',
    ],
  },
  isLoggedIn,
  // The dashboard tiles ARE the ready signal — nothing further to wait for.
};
