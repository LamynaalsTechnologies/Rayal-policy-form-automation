# Rayal-policy-form-automation

Node (CommonJS) + `selenium-webdriver` job runner. It polls the `RelianceJobQueue` collection (MongoDB), claims one policy **part** at a
time, opens Chrome, logs in to the insurer's portal (**Reliance**, **National**, **KSHEMA**), fills the proposal, does the KYC and ends at the
payment (Reliance wallet / CDT) or at the customer's payment link / QR (KSHEMA, link policies).

- **Whole-project handoff (read this first in a new chat):** [`../README.md`](../README.md) — the three repos, working agreements, what was
  built, **open items**, the switch table.
- **Per-insurer handler detail** (settings object, job parts, National TP, KSHEMA TP, Reliance OD/TP, KSHEMA financier, ...):
  [`multiCompany/README.md`](multiCompany/README.md) — long; the section numbers (§) below point into it.
- Companion repos: `../RayalBrokers-backend` (creates the jobs, wallets, PDFs; its README §2 / §8 describe the job shape) and
  `../RayalBrokers-Frontend` (the Online Policy form and the status pages).

```bash
npm install
node server.js                 # the runner (nodemon in dev: it restarts on every edit of a watched file)
npm test                       # node --require ./test/support/noRealWorld.js --test test/*.test.js
node --require ./test/support/noRealWorld.js --test test/kshemaFinancier.test.js   # one file
```

**Always run tests with the `noRealWorld.js` preload.** It stops a test from opening a real Chrome, uploading to S3 or touching the real
database (8 real Chrome windows and S3 uploads once happened when a default changed). After changing a default behaviour, grep `test/` for tests
that rely on the old one. Restart the runner after editing `.env` (every switch is read at call time, but `.env` is read at start).

---

## 1. Where things are

| Path | What it is |
|---|---|
| `server.js` | Boot, the queue loop and DB watcher, the old (legacy) job path, the startup wipe of the temp Chrome profile folders. Installs the console flow tag first of all (`lib/flowLogPrefix.js`). |
| `lib/partRunner.js` | **One part of one job**: claim, build the part's form data (`buildPartFormData`), pick the handler, timeout, write the outcome. Prints the `[<Company> Queue][<part>] processing ...` line. |
| `lib/jobPartsCore.js` | Pure part logic. **Byte-identical copy** of `RayalBrokers-backend/shared/jobPartsCore.js` — change both (`cmp` them; `test/sharedCore.test.js`). |
| `lib/jobSequence.js` | "TP first, then OD". |
| `lib/flowLogPrefix.js`, `lib/jobDirs.js`, `lib/jobRecorder.js`, `lib/recorderTabs.js`, `lib/proposerTitle.js`, `lib/policyDates.js`, `lib/tpVehicle.js`, `lib/credentialResolver.js` | Cross-cutting helpers (sections 3-5). `policyDates`, `proposerTitle`, `tpVehicle` are copies kept in step with the other repos (pinned by tests). |
| `fullPolicycompany/` | The **full-company** flows (OD + TP bought in one policy): `relianceForm.js` (+ `relianceKyc*.js`, `relianceWallet*.js`, `relianceCover*.js`, `relianceQuotesPaging.js`), `national.js`, `kshemaForm.js` and `kshema/` (quote form, fields, section, financier, after-Finalize, KYC document, log, toast, slow-field recovery, window note, session manager). |
| `multiCompany/` | OD-only / TP-only handlers, looked up by `registry.js` (`registry[company]["od" or "tp"]`): `tpCompany/{kshemaTP,nationalTP,relianceTP}`, `odCompany/{relianceOD,nationalOD,kshemaOD}` (National / KSHEMA OD are login-only stubs), `common/` (login, engine, `runHandler.js`, the Reliance OD/TP **generated** copy). |
| `debugRetention.js` | The one rule for closing / keeping the browser (section 3). |
| `breaker.js` | `Breaker.checkpoint("name")` — stops a job at a named place for inspection (`BREAKER_ENABLED`, `BREAKER_STOP_AT`). The owner uses it while debugging. |
| `test/` | 35 test files, no browser, no network, no database (fake pages, fake clocks). |
| `cloned_profiles*`, `recordings_tmp`, `screenshots`, `reliance_pdf`, ... | Runtime folders (temp Chrome profiles, recordings, local screenshots). Not source. |

### How a job runs (short)
1. The backend writes ONE job per policy with `parts` (`motor` = bundled full-company flow, `od` / `tp` = portal parts, `pa` = Brisk or "with part").
2. `partRunner` claims a part. A **bundled** part runs the full-company flow; a **portal** part goes to `multiCompany/registry.js`
   (`policyType` = the part key). So a **TP-only KSHEMA policy** is `tp/portal/KSHEMA` -> `fillKshemaTP` (`multiCompany/tpCompany/kshemaTP/`), never the
   full-company flow. Detail: `multiCompany/README.md` §4, §13, §14.
3. The flow ends in a result; `mapRunResult` classifies it (retryable / non-retryable / post-submission / stopped) and `writePartOutcome` stores it.

### Reading the log
| You see | It means |
|---|---|
| `[KSHEMA Queue][tp] processing portal part ...` | the part runner started part `tp` of a job; `portal` = a multiCompany handler, `bundled` = the full-company flow |
| `[kshema Full ]` / `[kshema TP   ]` | KSHEMA lines of the **full-company** flow / of the **TP-only** flow (the word is set by `kshemaLog.withFlow`; since 2026-10-16 — before that every line said "Full") |
| `Reliance TP+OD \|`, `Reliance TP    \|`, `Reliance OD    \|` | the Reliance flow tag (`lib/flowLogPrefix.js`, `FLOW_LOG_PREFIX_ENABLED`) |
| `[Breaker] checkpoint "X" reached` | `BREAKER_ENABLED`; the job stops there only when `BREAKER_STOP_AT` equals X |
| `⏳` / `↻` / `↺` / `🔎` / `▶` | loader being waited for / a field's second try / a field the portal had cleared, filled again / looking at the page to see why / flow banner |

---

## 2. The switches (`.env`)

Convention: **ON unless `false` / `0` / `no` / `off`**, read at call time, documented in `.env` and here. Values in the owner's `.env` on 2026-10-16
are in the last column (they are *his* settings, not the code defaults).

| Switch | Default | What it does (where documented) | Owner's `.env` |
|---|---|---|---|
| `MULTI_COMPANY_AUTOMATION_ENABLED` | off | master gate of the OD/TP handlers (`[E110]` when off) (`multiCompany/README.md` §2) | true |
| `KEEP_BROWSER_OPEN_ON_ERROR` | **off** (only `1/true/yes/on` turn it on) | a failed / stopped job leaves its window open (section 3) | true |
| `CLOSE_BROWSER_AFTER_COMPLETE` | true | a completed job closes its window and deletes its own profile (section 3) | **false** |
| `HEADLESS` | off (only `true`) | headless Chrome (always closed at the end). Linux without a display is forced headless whatever this says | false |
| `JOB_TIMEOUT_MS` | 900000 | one run's timeout (E302); once Reliance saved the proposal a timeout is never auto-re-run | — |
| `RELIANCEMAXWINDOW` / `NATIONALMAXWINDOW` / `KSHEMAMAXWINDOW` / `DEFAULTMAXWINDOW` | `DEFAULTMAXWINDOW` = 1 | parallel windows per insurer (`<NAME>MAXWINDOW`, falls back to the default) | 2 / 2 / 2 / 1 |
| `QUEUE_POLL_INTERVAL_MS` | 300000 (5 min) | queue poll period (the DB watcher also wakes it) | 300000 |
| `FLOW_LOG_PREFIX_ENABLED` | true | the Reliance `Reliance TP \|` tag **and** the word in the KSHEMA bracket | true |
| `BREAKER_ENABLED`, `BREAKER_STOP_AT` | off | debug checkpoints (`breaker.js`): a job stops "on purpose" (nothing submitted, no retry) at a named `Breaker.checkpoint("...")` | **true**, `stopthis-location` — the owner's own debug setup. **Checked 2026-10-19: `relianceForm.js` / `relianceMultiForm.js` no longer contain a `stopthis-location` checkpoint** (the owner removed it; KSHEMA's went on 2026-10-16), so these two lines stop nothing today. Never leave the Breaker on in production. |
| `RECORDING_ENABLED`, `RECORDING_FOLLOW_TAB_ENABLED`, `RECORDING_MAX_MS`, `RECORDING_RETENTION_DAYS` | off, true, job timeout + 2 min, — | job video (section 4) | false, true, —, 10 |
| `KSHEMA_TP_FORM_ENABLED`, `KSHEMA_TP_PRODUCT_TYPE` | true, "" | KSHEMA TP-only form and its exact Product Type text (`multiCompany/README.md` §13) | true, `Two Wheeler-Long term Liability only` |
| `KSHEMA_FIELD_RECHECK_ENABLED` | true | second try / read-back of every field (§19) | true |
| `KSHEMA_FINANCIER_ENABLED` | true | enter the financier on the nominee page (§20) | true |
| `KSHEMA_AFTER_FINALIZE_ENABLED`, `KSHEMA_AFTER_FINALIZE_WAIT_SECONDS` | true, 60 (15-300) | loader wait + diagnosed KYC-button timeout (§21) | true, — |
| `KSHEMA_SAVE_VERIFY_ENABLED`, `KSHEMA_SAVE_SETTLE_MS` | true, 3000 (1000-15000) | TP-only: Save and Continue judged by KSHEMA's step bar, errors reported at once and for a settle window, Add-ons guarded (section 6; `multiCompany/README.md` §13.5) | true, — |
| `KSHEMA_KYC_SETTLE_ENABLED`, `KSHEMA_KYC_SETTLE_MS` | true, 10000 | wait for the portal's KYC verdict (section 6; §18) | true, — |
| `KSHEMA_SLOW_FIELD_RECOVERY_ENABLED`, `KSHEMA_SLOW_FIELD_WAIT_MS` | true, 10000 | IDV box / PA year recovery (§16) | — |
| `KSHEMA_VERBOSE` | false | KSHEMA `debug` log lines | false |
| `RELIANCE_WALLET_CDT_ENABLED`, `_SUBMIT_ENABLED`, `_HOLD_ENABLED`, `_RECOVER_ENABLED` | true | wallet payment steps (§15.7, §15.9) | true |
| `RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED` | true | the Title must reach Reliance's MAIN page: a Title its list lacks (M/S) is refused before picking; Salutation + Gender checked after the Form 60 Submit (section 5) | true |
| `RELIANCE_REALISTIC_SELECT_ENABLED` | true | pick the Title like a person: pointer, click opens the list, click the option (`lib/realSelect.js`, section 5) | true |
| `RELIANCE_KYC_NAME_CHECK_ENABLED` | true | compare the KYC name with the policy's (section 5) | true |
| `RELIANCE_KYC_FALLBACK_ENABLED`, `RELIANCE_KYC_SUBMIT_WAIT_ENABLED` | true | KYC failure -> payment page links; waits at SUBMIT / PROCEED (§15.5) | true |
| `RELIANCE_COVER_DETAILS_CHECK_ENABLED`, `RELIANCE_COVER_SETTLE_ENABLED` | true | cover refusal detection; PA re-ticked by a late FetchIDV | true |
| `RELIANCE_PROCESS_LINKS_ENABLED`, `RELIANCE_QUOTES_PAGING_ENABLED` | true | proposal / payment links; Pending Quotes pages (§15.6, §15.8) | true |
| `RELIANCE_MULTI_FORM_ENABLED`, `RELIANCE_OD_PRODUCT`, `RELIANCE_TP_PRODUCT` | true, "", "" | Reliance OD/TP-only form and its product text (§15) | true |
| `NATIONAL_TP_FORM_ENABLED` | **true** (it started default-off; the owner asked for it to just continue) | National TP form; `false` holds the run at "Your Plan" and lists the options (§12) | — |
| `KYC_SCREENSHOT_RETENTION_DAYS`, `WALLET_SCREENSHOT_RETENTION_DAYS` | — | S3 lifecycle of those screenshots (§9) | — |

Credentials (`MONGODB_URI`, S3 keys, `OPENAI_API_KEY`, Brisk) are in `.env` too; never print or commit them.

---

## 3. Browser close and cleanup (`debugRetention.js`, `lib/jobDirs.js`) — 2026-10-15

**Why it was built.** A finished KSHEMA job left its window open and its profile folder behind, forever: both KSHEMA forms received a callback to
register their browser with and never called it, so the central cleanup got `null` and returned at once. Fixing that also needed a rule for every company
and protection for two jobs running at once.

**The rule** (central, every company: Reliance full + OD/TP, National full + TP, KSHEMA full + TP; headless always closes):

| The job ended | Decided by | Result |
|---|---|---|
| Completed | `CLOSE_BROWSER_AFTER_COMPLETE` | true: window closed, its own profile folder deleted. false: left open |
| Failed, or stopped on purpose | `KEEP_BROWSER_OPEN_ON_ERROR` | true: left open for inspection. false: closed and deleted |

- A job deletes **only its own** profile folder (`kshema_job_<id>_<time>_<random>`, `national_job_...`, `reliance_job_...`, plus Reliance's download folder) and quits
  **only its own** driver. There is no "kill all Chrome" anywhere. Two policies at once are safe: `lib/jobDirs.js` makes a job *claim* its folders when it opens its
  browser, and a folder is deleted only when no other running job still holds it (in memory, per server process). Profile names carry a random suffix.
- `multiCompany/common/runHandler.js`: a handler that **returns** a failure / stop follows `KEEP_BROWSER_OPEN_ON_ERROR` like a thrown error (it used to count as completed).
- The 5-minute profile sweep in `server.js` skips any folder a job still holds (a window kept open on purpose keeps its folder until the next restart, which wipes
  all profile folders because every window dies with the process).
- KSHEMA failure messages that said "The KYC page has been left open on screen" are reworded when the window really is closed, to point at the KYC link saved on the
  policy (`fullPolicycompany/kshema/kshemaWindowNote.js`; the portal's own words are kept).
- Tests: `test/browserRetention.test.js` (27: the matrix, two jobs at once for all three companies, two jobs forced onto one folder).
- **Open decision:** KSHEMA "completed" is the Razorpay QR page that the customer still has to pay. Closing that window on completion (the default) has not been
  confirmed with a real payment (does KSHEMA still issue the policy?). The owner currently has `CLOSE_BROWSER_AFTER_COMPLETE=false`, so KSHEMA windows stay open.

## 4. Job video (`lib/jobRecorder.js`, `lib/recorderTabs.js`) — 2026-10-15

The recording used to attach to the **first tab** only and stop at 7 minutes, so the KYC tab (a new tab) was missing and a 15-minute job was cut short.
Now (`RECORDING_FOLLOW_TAB_ENABLED`, default on) the recorder follows whichever tab Chrome reports as visible, for every company that opens a new tab. It reads the
tab list over the browser's DevTools port and sends the automation's own session **no commands** (the KYC and CDT steps read `alert()` popups; a command sent mid-alert would
dismiss them). The limit is the job timeout + 2 minutes (`RECORDING_MAX_MS` overrides). Every tab switch is saved with the video as a **chapter** — the host name only, never the URL
(KYC links carry tokens). The backend recordings API returns `chapters`; the frontend `JobRecordingDialog` shows a video icon and, when more than one tab was used, jump buttons such as
"KYC · 4:12". Tests: `test/recorderTabs.test.js` (9, against a fake DevTools endpoint). `RECORDING_ENABLED` is **false** in the owner's `.env`: nothing records until it is turned on.
Not tested with a real KYC run. One continuous video was chosen over a separate KYC file; the owner may still want a separate one.

## 5. Reliance additions (2026-10-15 / 16)

- **CDT balance popup** (`fullPolicycompany/reliance/relianceWalletCdt.js`, `RELIANCE_WALLET_CDT_ENABLED`; `multiCompany/README.md` §15.7). The step never saw Reliance's "Your CDT Account Does not have
  sufficient balance to make payment" popup: it is a plain `div` (`closePopUp()`, the red `critical.png`, the sentence in a span), not a `.ui-dialog` / `.k-window`, and the words
  "does not have sufficient" did not match the error words. Now the popup is read after typing the amount and after **Add** (popups already on the page before typing are
  ignored), "not sufficient / not enough / sufficient balance" count as errors, the step waits up to 4 more seconds after Add when the grid did not grow and nothing was said, Add is still
  pressed once only, typing scrolls to and focuses the box first and retries once before the script fallback. The failure quotes the page's words and, for a balance error, adds "The CDT balance of
  this Reliance login is lower than the payable amount - top it up, then run the policy again."; the screenshot is taken while the popup is open. Shared by the Reliance OD/TP copy.
  Tests: `test/relianceWalletCdt.test.js`. **Unverified:** the popup is found by a page-wide search for its markers — inside an iframe it would be missed; why typing was "not interactable".
- **KYC name check** (`fullPolicycompany/reliance/relianceKycName.js`, `RELIANCE_KYC_NAME_CHECK_ENABLED`). After SUBMIT is accepted and the result page opens, the disabled `#result_name` box (fallbacks by
  name / `ng-model`) is read and compared with the policy's **Full Name + Surname**: the same words in any order, case and punctuation ignored, **no fuzzy matching** ("Anmol Arora" = "Arora Anmol" =
  "ANMOL, ARORA."; an extra word, another person, or a missing surname is a mismatch). Mismatch: the box gets a red outline and "KYC NAME MISMATCH - policy: ...", the job fails with
  `KYC name mismatch - Reliance's KYC shows "..." but the policy has Full Name "..." and Surname "...". Correct the name on the policy, or use the customer's own Aadhaar, then run the policy again.
  PROCEED was not pressed and nothing was paid.`, then the existing KYC fallback (`multiCompany/README.md` §15.5) screenshots the page, goes to Pending Quotes, presses Pay and saves the
  proposal / payment page links (nothing paid or sent); the sentence is saved as the policy's KYC status (View page). A **missing or empty box** logs "KYC name not checked" and carries on as before.
  Applies to the full flow and the generated OD/TP copy. Tests: `test/relianceKycName.test.js` (15). Only one real markup snippet (`#result_name`) was available — never run on the live page.
- **The Title must reach the MAIN page** (`lib/proposerTitle.js` `mainPageRefusal`, `verifyMainPageTitle`; `RELIANCE_TITLE_MAIN_PAGE_CHECK_ENABLED`, on unless false / 0 / no / off). Why the Title was "selected on the
  front but not solid" (2026-10-16; read from a live Reliance window and two failed runs' screenshots): the Form 60 box has no handler of its own; Reliance reads `#proposerTitle1` when the box is **submitted** and
  `fillClientDetails` copies it into the main page's Kendo `#ddlSalutation` (then locks it), whose list comes from `Api/Master/GetProposerSalutation` **per customer type** — for an Individual: Mr., Mrs., Ms., Dr.,
  Miss., Prof., ... and **no "M/S"** (the Corporate title). `#ddlGender` is a cascade of it (`Api/Master/GetGender?ProposerName=...`: Mr. -> Male, Ms. / Mrs. / Miss. -> Female, one entry each; Dr. / M/S / Select -> all
  three, so nothing is auto-picked). So "M/S" stayed in the Form 60 box only; Salutation and Gender stayed "Select" (locked) and "Validate Customer" showed "Please select Salutation. Please select Gender.", which the flow
  logged as "Customer validation attempted!" and only failed on much later with an empty message. Now: **(1)** the policy's own Title is ALWAYS selected (the owner: "whatever is selected in the data must be selected"); before
  the box is picked `selectProposerTitle` reads the main page's list through `window.parent` and, for a Title it lacks, only logs a warning (`⚠️ Reliance's main page lists no "M/S" for an
  Individual customer ... selecting "M/S" anyway, as the policy says ...`). (For a few hours on 2026-10-16 this was a refusal; the owner wanted the data's Title selected instead.) **(2)** right after the Form 60 Submit and before the email /
  Validate Customer, `verifyMainPageTitle` waits (15 s, then 10 s for the Gender) for the main page to hold that Title and a Gender and stops with Reliance's own state otherwise (`still shows the Title "Select"`, `Form 60
  box is still open after Submit`, `shows the Title "Mr." but the policy has "Mrs."`, `took the Title "Ms." but left Gender on "Select"`). A page that cannot be read is never an error; the switch off = neither check.
  When the main page has no such Title the stop says so: `Reliance did not accept the Title "M/S" - it was selected in the Form 60 box as the policy says, but Reliance's main page has no "M/S" for an
  Individual customer ...`. The call sits in `relianceForm.js` (and, regenerated, the OD/TP copy). **M/S cannot work** until a Corporate customer path exists; the Online Policy form no longer offers it.
  **No retry for these (found on the first real M/S run):** the form's catch RETURNS a failure and `partRunner` reads only `retryable: false` from it, so the refusal first came back as
  `retryable -> pending ... due in 60s` and would have opened a new Chrome every minute. `TitleError` (`nonRetryable = true`) is now thrown for the refusal and all three main-page failures, and the
  catch adds `...(e && e.nonRetryable === true ? { retryable: false } : {})`, so the part ends `failed_login_form` with the sentence as its error and no retry timer; the operator changes the Title and
  re-runs. The Form 60 box's own read-back error ("Reliance did not take the Title") stays retryable. Tests: `test/relianceTitleMainPage.test.js` (31, including the whole chain through `mapRunResult` and
  `applyPartOutcome`). **Not run on the live portal beyond that first refusal.**
- **Dropdowns picked like a person** (`lib/realSelect.js` `selectLikeUser`; `RELIANCE_REALISTIC_SELECT_ENABLED`, on unless false / 0 / no / off). The Title box was set by `safeSelectDropdown`: `select.value = ...`
  plus one made-up `change` event (the owner: "it selects the field but not fully assigned, like artificial"). Now: scroll to the box, pointer over it, a click opens the list, a click on the option,
  a read-back of the selected option, then the box is let go of (blur) and the page settles; pauses are 150-500 ms with jitter (1.2-1.7 s to settle). In a real Chrome (headless, local page, box inside an iframe)
  the old way produced one `change` event made up by a script and no focus; the new way produces mouseover / mousemove / mousedown / focus / mouseup / click on the box, then the option click, and the box ends
  un-focused. If the list cannot be used (the click is refused, the option is not there, the page ends on another option) the old script runs with a warning in the log ("choosing it with a script instead"),
  so it is never worse than before; if even that leaves a different option, or the box does not offer the title, the run stops before anything is submitted (`Reliance did not take the Title ...` /
  `Reliance's Title box does not offer "Dr." - it offers Mr., Ms., Mrs., M/S. Nothing was submitted.`). Used by `selectProposerTitle` in both the full flow and the generated OD/TP copy (no change to `relianceForm.js`).
  **Still the old script:** the father's Title (`proposerTitle2`) and the State box (`safeSelectDropdown` in `relianceForm.js`; a change there needs the OD/TP copy regenerated). **Not checked:** the native list being
  drawn and closed on a visible window, and the live Reliance modal. Tests: `test/realSelect.test.js` (23, a fake `<select>`), `test/proposerTitle.test.js`.
- **Proposer Title** (`lib/proposerTitle.js`): the Online Policy form's Title (Mr. / Ms. / Mrs. / M/S, saved as `proposerTitle`) is selected in `#proposerTitle1` and read back; if the
  portal did not take it the run stops with `Reliance did not take the Title "Ms." - its Title box reads "". ... Nothing was submitted.` Sent title = the chosen one, else what the gender
  implies, else `Mr.` (what was always sent). The father's title is still Mr. **National** still types a fixed "Mr" in its own Title box and **KSHEMA** has no title step (possible follow-ups).
- **Generated copy:** after ANY change to `fullPolicycompany/relianceForm.js` run `node multiCompany/common/reliance/relianceMultiFormSpec.js --write` (the drift test `test/relianceMultiForm.test.js`
  fails until you do). Reliance copies are regenerated, never hand-edited.

## 6. KSHEMA additions (2026-10-15 / 16)

Detail for the first four is in `multiCompany/README.md`: §13 (TP-only flow; §13.4 the log word), §16 (slow portal), §18 (KYC Aadhaar upload), §19 (every field carefully), §20 (financier), §21 (after Save and Finalize).

- **KYC verdict settle** (`fullPolicycompany/kshema/kshemaKycDocument.js` `settleKycOutcome`; `KSHEMA_KYC_SETTLE_ENABLED`, `KSHEMA_KYC_SETTLE_MS`). After "Details are correct - Verify" KSHEMA
  clears the review screen and shows a blank state for a few seconds before it draws the DigiLocker card with the error (for example "The gender on your document doesn't match your profile ...");
  the run used to take "review button gone, no error yet" as success and went on to payment. Now the KYC page must stay free of any refusal for the settle window (default 10 s): an error or the card
  fails it at once ("doesn't match", "does not match", "verify you through digilocker" are recognised too). The error is
  `KYC validation error - KSHEMA said "..." Correct the customer's gender, name or date of birth on the policy so they match the Aadhaar, then run the policy again.`, the `kyc_details_failed`
  screenshot is taken with the error on screen, and the portal's sentence is saved as the policy's `kycStatus` (the View page shows "KYC not completed - the portal said ..."). Used right after Verify and in the
  last check before leaving the KYC tab, in both quote forms. No success marker is known: it relies on "no refusal for 10 s". Tests: `test/kshemaKycDocument.test.js`.
- **Save and Continue is checked (KSHEMA TP-only)** (`fullPolicycompany/kshema/kshemaSaveVerify.js`, `[TP] 11` in `kshemaTPQuoteForm.js`; `KSHEMA_SAVE_VERIFY_ENABLED`, `KSHEMA_SAVE_SETTLE_MS`).
  The TP copy used to take the "Save and Finalize" button as proof that the next page had opened; that button is on the Quote page too, so a refused Save looked like success and the run went on
  to the Add-ons page (clicking "Is New Vehicle?" by mistake) while KSHEMA's toast "System Error More than one rate found for rate" was blamed on the add-ons radio. Now the page counts as moved only when
  the step bar (`.stepper-item-text.stepper-active`) has left "Quote"; an error message stops the run at once with `KSHEMA refused Save and Continue - its message was "...".`; after the move the
  run keeps watching for a settle window (default 3 s) for an error or the step falling back to "Quote"; the Add-ons page is answered only when the Addon step is open; the Premium & Discount step is
  skipped for TP. A step bar that cannot be read falls back to the old test with a warning. Never run on the live portal. Tests: `test/kshemaSaveVerify.test.js`. The full-company flow is untouched.
- **Stale KYC note cleared.** A refusal is written to the policy's `kycStatus`; a KYC that **passes** now writes `kycStatus: null` (both KSHEMA forms), and the View page hides the note on a
  `completed` policy (`KycFailedNotice.js`), so policies that already carry a stale note read clean without a database fix.
- **Payment QR screenshot saved.** The Razorpay QR screenshot reached S3 but nothing recorded it. Both KSHEMA forms now save it (`{ fileName, key, location }`) as `paymentQrScreenshot` next to the payment link; the backend model
  has the field and the single-policy API makes a fresh presigned link; the View page has a "Payment QR" card (view + download PNG). **Policies that ran before this have no key**, so no card for them
  (their images are still in S3 under `screenshots/kshema_payment_qr_...`; a one-time attach script was offered, not written).
- **Policy dates are India time** (`lib/policyDates.js`): DOB, nominee DOB and registration date were one day early on a UTC server; `formatPolicyDate` exists in both repos — deploy both.

## 7. Tests, mutation checks and drift guards

- **Drift guards** (each copy may differ from its original only on tagged lines): `test/kshemaTP.test.js` (`kshemaTPForm.js` / `kshemaTPQuoteForm.js` vs the full-company originals; lines tagged `[TP]`; require
  paths are normalised; **whitespace matters** — the edit tool trims whitespace-only lines, so use a script when a blank line must match exactly), `test/relianceMultiForm.test.js` (`[MC]`, generated),
  `test/nationalTP.test.js`, `test/sharedCore.test.js` (`lib/jobPartsCore.js`, `lib/tpVehicle.js` vs the backend), the `proposerTitle` / `policyDates` pins.
- **Mutation checks** (the owner expects "prove the tests can fail"): `rsync` the project into a scratch folder (exclude `node_modules`, `cloned_profiles*`, `recordings_tmp`, `screenshots`, `*.png`; symlink `node_modules`),
  apply ONE deliberate break at a time with a script that **asserts the pattern occurs exactly once** (a no-op `sed` "survives" silently — it happened twice), run the test files, require a failure, restore the file.
  **Never mutate the real files**: the owner's nodemon watches them and would restart (and kill) a running job.
- **Fake clocks** for waits (see `test/kshemaAfterFinalize.test.js`, `test/kshemaFinancier.test.js`): inject `now` / `sleep`; never let a test really wait.
- **Known failing / flaky (not caused by recent work):** `the captcha file is named per job and is gone afterwards` (`test/multiCompanyRelianceLogin.test.js`) fails while a stray
  `reliance_captcha_VASANTHI_*.png` from a real run sits in this folder — it is the owner's file, delete it to make the test pass; `download: a file over the size ceiling is refused and not kept`
  (`test/kshemaKycDocument.test.js`) is a timing flake under load (passes alone). On 2026-10-16: 798 tests, 782 pass, 1 fail, 15 skipped.
- **Shell tips:** parallel tool calls that `cd` race each other (use absolute paths); `Breaker.checkpoint("stopthis-location")` lines are the owner's debug marks — leave them unless asked (none is in `relianceForm.js` any more, checked 2026-10-19).

## 8. Open items for this repo

See the numbered list in [`../README.md`](../README.md) (section "Open items"). The first one is a KSHEMA TP-only add-ons error ("More than one rate found for rate"), with the log and the next steps.

## Brisk PA certificate through our server's new Brisk API (2026-10-17)

`lib/briskV2Automation.js`, called first thing in `createBriskCertificate` (`briskCertificate.js`), so the parts runner and the
inline Reliance / National / KSHEMA flows all use it.

| `.env` key | Default | Meaning |
|---|---|---|
| `BRISK_V2_AUTOMATION_ENABLED` | `false` | exactly `true` = ask our server (`POST <BRISK_V2_BACKEND_URL>/briskV2/automation/certificates`). Anything else = the old production `/createBriskCertificate` call, unchanged. |
| `BRISK_V2_BACKEND_URL` | `http://localhost:4005/api` | the server's API base |
| `BRISK_V2_AUTOMATION_KEY` | (random, set) | the same value as the server's `BRISK_V2_AUTOMATION_KEY` |
| `BRISK_V2_AUTOMATION_TIMEOUT_MS` | `150000` | how long to wait for the server |

The server matches the policy to Brisk's lists, never charges (PA was paid with the policy), answers the same certificate when
asked again, and saves every Brisk request and answer (Online Policy View page, "Brisk Certificate (new API)"). Answers: LIVE
made = `{ policyId: <number>, downloadUrl }` (stored as before); **TEST made = an error** (a TEST certificate is never stored on
a real policy); a refusal = an error with the server's sentence; not known = no number ("check Brisk before running this again";
a re-run is safe, the server answers what it made). **Careful:** the server's `BRISK_V2_BASEURL` decides the Brisk account —
while it is the TEST account, turning this on means real policies get TEST certificates that are not stored (their PA step
fails and says so). Tests: `test/briskV2Automation.test.js` (10, fake fetch only).


## Reliance KYC name — the owner's four combinations (2026-10-17)

`fullPolicycompany/reliance/relianceKycName.js`, switch `RELIANCE_KYC_NAME_COMBINATIONS_ENABLED` (ON unless false / 0 / no / off).
The name Reliance read from the Aadhaar (CKYC result box) must be one of: **Full Name** · **Full Name + Surname** ·
**Full Name + Father Name** · **Full Name + Surname + Father Name** (words in any order; case, spacing, punctuation ignored;
Father Name = the policy's `fatherName`). Anything else → "KYC name mismatch …" and the run **stops on the KYC page**:
PROCEED is not pressed, Pending Quotes / Pay are **not** opened, no links are saved (the KYC fallback is skipped for this
error only — `skipsKycFallback`); the screenshot is of the KYC page with the name box marked red. Off = the old rule (Full
Name + Surname only) and the fallback as before. Applies to the full-company flow and its generated [MC] copy. Tests in
`test/relianceKycName.test.js`; 6 deliberate breaks caught.

## Hold pressed while a policy is running (2026-10-17)

`lib/holdRequest.js`, switch `JOB_HOLD_REQUEST_ENABLED` (ON unless false / 0 / no / off). The backend records Hold on a
running job as `holdRequested: { at, by }` (it cannot stop an attempt half way). Every queue scan and claim (server.js
legacy jobs, `partRunner.claimPart`) skips a job with a request, and each queue pass turns such a job — once its attempt
has put it back to "pending" (retry backoff, timeout recovery, unexpected error) — into a real **hold**, with a timeline
entry. A job that ended for good just has the request dropped. Release (backend) withdraws it. Tests:
`test/holdRequest.test.js` (6).

## Reliance in three stages: proposal, KYC, payment (2026-10-19)

The owner's request: a Reliance run is three stages, each remembered, so a re-run does only what is left.

| Stage | What it is | Done when | Skipped next time when |
|---|---|---|---|
| 1 Proposal | login, fill, Save, the proposal ("referral") number `R…` | `saveProposalNumber` ran | stage 1 is completed **and** has its number |
| 2 KYC | Utility, View Policy, search the saved number, DO KYC, KYC | Reliance accepted the document (`kycAccepted`) | stages 1 and 2 are completed |
| 3 Payment | Pending Quotes, Pay, then link (Yes / SendMail clicked) or wallet CDT issued | the link was sent / the policy was issued | never (a re-run of a link policy sends the link again) |

- **Where it is stored**: `onlinePolicy.relianceStages.<part>` (`motor` = bundled part, `od` / `tp` = portal parts):
  `{ proposal: { status, at, proposalNumber }, kyc: { status, at, error }, payment: { status, at, mode, error } }`.
  `status` is `pending` / `completed` / `failed`. A new proposal, or a stage set back to pending, puts every later stage back to pending (the cascade).
- **The rules**: `lib/relianceStagesCore.js`, byte-identical with the backend's `shared/relianceStagesCore.js` (checked by `test/sharedCore.test.js`).
- **The automation side**: `fullPolicycompany/reliance/relianceStages.js` (`loadResumePlan`, `markStage`, `stopAtKycFailure`, the operator sentences). Its database writes never throw.
- **The form** (`relianceForm.js`): the stage-1 blocks are guarded by `if (!resume.skipProposal)` and the KYC block by `if (!resume.skipKyc)`. They are not re-indented (the same style as `if (!issuedRecovery)`).
  - The payment block (Pending Quotes → Pay → link / CDT) was **moved out of the KYC block** to run after it as stage 3. It runs only when the KYC was accepted in this run, or by an earlier run.
  - KYC accepted but PROCEED never appeared: stage 2 stays completed, stage 3 is not started, and the error says to Re-submit.
- **A failed KYC stops at the KYC** (the owner's decision 2026-10-19). That means screenshot, KYC note, stage 2 = failed, and **no** Pending Quotes / Pay / links: `rescueAfterKycFailure` is no longer used by the form. The policy ends `failed_post_submission` (no automatic retry). **Re-submit runs only the KYC again, with the same proposal.**
- **Stage 3 not done** (link Yes button missing, proposal not in Pending Quotes, Pay step error ...): an error that names the reason. Before, a few of these were only logged and the policy "completed" without a link.
  - The one exception is wallet hold + CDT both switched off, which still carries on as before.
- **A resumed run** whose saved proposal has no DO KYC link says: *"Proposal R… saved by an earlier run has no DO KYC link in Reliance's View Policy. Check it on the portal, or set stage 1 Proposal back to Pending in History to make a new proposal."*
- **An edit of the policy clears the stages** (backend), so the next run makes a new proposal, unless the part was paid from the wallet at Reliance.
- **Operators** see the stages in the Online Policy **History** dialog. A Completed / Failed stage can be set back to Pending there ("Only update" or "Update and run now"). A Pending stage cannot be clicked.
- **No `.env` switch** (the owner: no new switches). A policy without `relianceStages` (every older one) is never skipped anywhere.
- **Folder**: the Reliance helper files moved into `fullPolicycompany/reliance/` (the owner: "like the kshema folder"); `relianceForm.js` stays in `fullPolicycompany/`.
- **Tests**: `test/relianceStages.test.js` (19, including the real `relianceForm.js` after login with a fake browser: a fresh run goes to the form, a resumed run straight to View Policy or Pending Quotes). The older structure tests were updated to the new layout. **12 deliberate breaks in a copy were all caught.**
- **Not proven on the live portal**:
  - opening Utility › View Policy straight after login (it was only ever reached after Save);
  - the DO KYC link of an older proposal;
  - Pending Quotes with no KYC tab open;
  - how long Reliance keeps a saved proposal searchable.

## Coloured status in the queue line (2026-10-19)
`[Reliance Queue][motor] success -> completed (job now completed)`: both statuses are coloured.
- **Colours**: green = completed; red = failed (any `failed_*`); amber = pending / completed_with_errors / hold.
- **Where**: `lib/consoleColor.js`, used in `lib/partRunner.js`.
- **When**: no `.env` switch. Colour only when the console is a terminal (nodemon / node in a shell); a pipe or file gets plain text. `NO_COLOR` turns it off and `FORCE_COLOR=1` forces it.
- **Tests**: `test/consoleColor.test.js`.

## "Only update" runs later: on start and when the queue is idle (2026-10-19)
In the History dialog, **Update & run** queues the part now. **Only update** sets the step back to Pending and leaves a mark on the policy (`relianceStages.<part>.runLater = { stage, at, by }`, written by the backend).
- **This server turns the mark into a run** (`lib/relianceRunLater.js`):
  - **on start / restart**, after the stuck-job recovery;
  - **when the queue is idle** (nothing processing, nothing ready to start), at most once a minute.
- **Requeue**: only that part of the policy's job is queued again, with the same fresh state Re-submit gives it, under the job's `rev` lock. The job gets a history line, and the mark is removed, so each mark is used **once**.
- **Kept for a later sweep**: while the job runs, is on hold, or that part runs. Old-shape jobs (no parts) also keep it; use Re-submit for those.
- **Dropped with a log line**: when the step is no longer pending (it ran meanwhile), when the part is already queued, or when the part was paid from the wallet at Reliance.
- **Log**: `[Run later] ▶ OP… MOTOR: KYC queued (set back with Only update; automation free)`.
- No `.env` switch.
- Tests: `test/relianceRunLater.test.js`. **8 deliberate breaks were all caught.**

## Only the proposal cascades; a KYC redo does not pay again (2026-10-19)
The owner's rule (`lib/relianceStagesCore.js`, shared with the backend):
- **Proposal** set back to Pending → KYC and Payment go back to Pending too: a new referral number means a new KYC and a new payment.
- **KYC** set back to Pending → only the KYC. On a policy whose payment is done, the run redoes **only the KYC** and ends there (`planResume.skipPayment`). It logs `▶ … Only the KYC of proposal R… was redone - its payment was done by an earlier run`, returns `{ success: true, kycOnly: true }`, and nothing is paid, sent, certified or merged again.
- **Payment** set back to Pending → only the payment.
- With every step completed the payment still runs: a re-submitted payment-link policy sends the link again.
- A finished KYC no longer puts the payment back to Pending.

## Hold on a RUNNING policy: stop now, close the window, continue later (2026-10-19)
Hold pressed while the automation runs a Reliance policy used to apply only after the attempt ended. Now:
- **The form stops at its next safe step.** `relianceForm.js` (and the generated OD/TP copy) calls `await stopIfHeld(data, "<where>")` at 8 points: after the login, before Form 60, before the vehicle details, before Save, before the KYC, before DO KYC, before the payment, and before Pay.
- **Never after Pay is pressed**: a wallet payment in flight finishes and is recorded first.
- **What `lib/holdStop.js` does**: it reads this job's `holdRequested` and stops the run on purpose with the stage `operator-hold`.
- **The window is closed and the job's browser profile deleted** (`hadError = !isHoldStop(e)`, even with `KEEP_BROWSER_OPEN_ON_ERROR`), so Release starts with a fresh login and a fresh session.
- **The part goes back to pending without counting an attempt and without an error entry** (new `jobPartsCore` outcome `held`, the same in the backend copy). `lib/holdRequest.js` then turns the job into **hold**.
- **Release continues from the step it stopped at**, because finished steps stay finished (relianceStages): same proposal / referral number, unless it stopped before Save.
- **Switch**: `JOB_HOLD_REQUEST_ENABLED` (no new switch). Only jobs with parts are checked. National / KSHEMA have no stop points (they keep the old "after the attempt").
- **Not stopped inside one long wait** (for example the up-to-5-minute KYC PROCEED wait). It stops at the step after it.
- **Tests**: `test/holdStop.test.js` (the real form with a fake browser stops after the login, and the window closes with no error flag). 7 deliberate breaks were all caught.
