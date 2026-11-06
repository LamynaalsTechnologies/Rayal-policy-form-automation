# Manual real-Chrome check for the United India (UIIC) login

Not part of `npm test` (it starts Chrome). Run by hand after changing `multiCompany/common/login/unitedIndiaLogin.js`, the
`"united india"` entries of `loader.js` / `portalMessages.js`, or `multiCompany/tpCompany/unitedIndiaTP/`:

    node test/manual/uiicReplica/loginCheck.js

It starts a local replica of the UIIC login page and runs the real login strategy on the shared loop in headless Chrome:
- success;
- a refused captcha, then success;
- a wrong password (E203, one submit);
- a dashboard without the known menu;
- the login page itself never counting as logged in;
- the sidebar Policy Transaction > Make New/Renew Policy (the owner's markup), with a swallowed first click and with the menu
  already open;
- the Products page: Liability Only Policy (3102) chosen in a real native dropdown and submitted, Office / LOB untouched, and a
  real `alert()` after Submit reported in its words;
- Risk Details: Vehicle Class, the customer's Registration State, New Vehicle, Chassis and Engine Number (their onchange /
  onclick fire, the loader is waited for), also when Submit opens a new window and when the tick resets the state;
- the handler end to end with the Breaker on (stops at `stopthis-location`) and off (stops after the Engine Number);
- two real kept windows: closing one removes only its own profile (`lib/retainedBrowser.js`).

The replica has read-only boxes that unlock on focus, a captcha picture, the `#loginError` box, and a dashboard behind a blockUI
overlay.

The captcha reader is a fake that asks the replica for the text: OpenAI is never called. Nothing real is touched (no portal, S3 or
database); the handler's profile goes to a temporary folder that is removed afterwards.

It prints `PASS` / `FAIL` lines and ends with `RESULT: ALL PASS` (exit 0). The replica is built from what the owner's older download
project reads, **not** from the live portal, so a pass means "the code does what it says on this page shape".
