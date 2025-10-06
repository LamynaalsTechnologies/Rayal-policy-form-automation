Notes and assumptions for Reliance flow

- File: `relianceForm.js`
- Exports: async function `fillRelianceForm(data)`

Assumptions:
- The Reliance Smartzone form is reachable at: https://smartzone.reliancegeneral.co.in/Login/IMDLogin
- Field names used in the implementation (e.g. `PolicyNo`, `Amount`, `InsuredName`, `MobileNo`, `EmailId`) are guesses and may need to be updated to match the real page's input `name` or `id` attributes.
- The flow uses conservative selectors and best-effort submissions. If fields are not found, the function will continue and attempt other submit methods.
- The function creates a fresh driver by cloning `chrome-profile` (like other flows) and cleans up the temporary profile directory after completion.

Testing steps:
1. Start the server: `node server.js` (this will attempt to open the United India portal login on startup). Ensure Chrome and chromedriver are available.
2. Open the frontend (vite app) and choose "Reliance" from the company dropdown and submit an amount.
3. Observe server logs and socket events. The server will call `fillRelianceForm` and emit `autofill:success` or `autofill:error`.

If the Reliance site requires login before the form is available, consider adding an explicit login step into `relianceForm.js` or performing a manual login in the browser profile before running the flow.
