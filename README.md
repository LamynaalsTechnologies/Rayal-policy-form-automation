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

### KSHEMA financier-name collector (hand-run, 10 windows)

`scripts/collectKshemaFinanciers.js` (logic `lib/kshemaFinancierCollect.js`, tests `test/kshemaFinancierCollect.test.js`). Options:
`--policy <KSHEMA policy id>`, `--windows N` (1-10, default 10), `--show`, `--resume`, `--no-db`.

- **`--policy <id>` (automatic, headless):** each window logs in with that policy's KSHEMA login (same resolver as the Make/Model
  collectors), walks the normal KSHEMA steps to the nominee page, answers the financier question Yes and searches the "Financier Name"
  box. **It saves a quote at KSHEMA in every window** (the nominee page exists only after the quote is saved); it never presses Save
  and Finalize, never clicks a financier, pays nothing, and is given NO policy id, so it cannot read or write the policy. The only
  change to the working KSHEMA code is one inert hook at the top of `fillFinancier` (`kshemaFinancier.js`, shared by the full and TP
  flows, used by no other company); a queued job never carries a function, so a normal run never takes it. The flow's last result is
  `COLLECTED_MARKER`, and its one failure screenshot is the only extra side effect. `--show` shows the windows.
- **Without `--policy`:** 10 visible windows; you log in and open the nominee page (Financier = Yes) in each, press Enter once.

1. **Probe first** (window 1): the fewest letters that open the list (1, then 2, then 3), whether it matches the START of a name or
   any part, and the most rows it shows (a cap is assumed when the same biggest list appears twice). Printed and kept in the JSON.
2. **Shared search list**: every window takes its next prefix from one queue, so no search is done twice. A list as long as the cap
   (or 5 when no cap was seen) is split into longer prefixes, up to 8 letters (`KSHEMA_COLLECTOR_MAX_PREFIX_LENGTH`).
3. **Saved once, for KSHEMA, into Master > Financier** (collection `financier`, 2026-11-18): each new name is added at once as a row
   with `financierName` UPPER CASE, `companies: ["KSHEMA"]`, `clientId: "COMMON"`, `createdBy: "kshema-financier-collector"`, and an EMPTY
   `financierType` / `financierAddress` (KSHEMA's list gives only the name - nothing is invented; the Financier page asks for them
   when a row is edited). Never a second row: names are compared ignoring case and spacing; a name already there for KSHEMA, or with
   no company (= every company), is skipped; a name that exists only for other companies gets "KSHEMA" added to its companies. The
   master and the JSON file are read first. Copy and checkpoint: `../Data/kshema-financiers-export.json`.
4. **Every console line starts with `[window N]`** (also the KSHEMA flow's own lines). **A window with a problem is restarted**
   (`--policy` mode only; up to 3 restarts, 5 s apart, new browser + login; the others keep working from the shared queue). Not
   restarted: finished, Ctrl+C, nothing left, the list never opened, or the Yes answer / box not found (the same on every window).
   A search given back twice is listed as failed and left for `--resume`. The list is read in ONE call (a 143-name list was 430).
   With no cap seen a list is split only when it is as long as the longest the probe saw. Undo:
   `db.financier.deleteMany({ createdBy: "kshema-financier-collector" })`.
   **`node scripts/kshemaFinanciersToMaster.js [--apply] [--file <json>]`** copies the names the first runs saved in
   `insurerFinancier` into the master (dry run without `--apply`; `insurerFinancier` is only read). Done live 2026-11-18: 6475 rows.
5. `buildKshemaFlowData` mirrors `server.js buildFormDataFromPolicy`; a test fails if server.js gains a field the collector lacks.
6. Ctrl+C finishes the current searches and saves; `--resume` continues. Not run live yet.

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
| `[timing] event=step ...` / `event=end ...` | where a run's time went (`lib/stepTiming.js`, see "Timing lines" just below) |

### Timing lines `[timing]` (2026-11-23, branch `fast-optimise`)
Why: on the server every insurer is slower than on the laptop; these lines show where each step's time goes. Always on
(no `.env` switch), a few lines per run, they change nothing about a command. Only ids and numbers are printed (insurer,
part, job `_id`, 8 characters of the run id, step, ms, counts) - never a customer name, phone, number, login or URL.
Read them: `pm2 logs <app> --lines 5000 --nostream | grep -F '[timing]'`.

| Line | What it says |
|---|---|
| `event=browser-open` | browser start ms; `headless`, `window`, `gpu`; `driver=` chromedriver file or `selenium-manager` |
| `event=step` (proposal / kyc / payment) | `wallMs` = `sleepMs` (our fixed pauses) + `waitMs` (waiting for the page, `driver.wait`) + `cmdMs` (browser commands outside waits; `cmds` = how many) + `otherMs` (our code, database, uploads, captcha). `top=` the commands that took longest: `name:count/totalMs/p50Ms/p90Ms`. `dbConnects` / `dbConnectMs` = new database connections made in the step |
| `event=end` | the same for the whole run, `totalMs` from the run start, `browserStartMs`, `windows` (run windows open when it opened, itself included), `loopLate*Ms` (how late Node's event loop ran: 0 = never; 300 = the whole process froze 300 ms) |
| `event=db-connect` | a new database connection that took over 200 ms |
| `event=recorder` / `event=recorder-encode` | job video: capture mode, frames Chrome sent vs kept, still-page top-ups; ffmpeg ms and how many other runs were going |

How it is wired: installed once on selenium's `WebDriver` class and on `MongoClient.connect` (`server.js`, top);
`lib/holdStop.js armLiveHold` links a run's window to its run (a lookup table - the driver itself is not changed, so the
stuck-step watch and the hold keep their own wrappers exactly as before); `lib/runHistory.js` gives the run's insurer
(start), its step ends and its end. Reading it: command p50s of tens of ms are normal (laptop: find 6 ms, click 36 ms,
type 53 ms); much higher = the browser itself is slow on that machine; a big `sleepMs` = our fixed pauses; a big
`waitMs` = waiting for the portal. Tests: `test/stepTiming.test.js` (11; 10 of 10 deliberate breaks caught).
`sleepTop` / `cmdTop` (round 1) say WHERE: `file:line:count/totalMs` in our code, biggest first; `db-connect` lines
carry `site=` too.

### Speed fixes, round 1 (2026-11-23, branch `fast-optimise`)
Measured on the server first (KSHEMA motor, after the timing deploy): browser commands are fast (find 17 ms, read
21 ms p50); about half of every run is our fixed pauses; one run spent 49 s in 2,143 separate option reads.
- **KSHEMA dropdowns read in ONE browser call** (`kshemaFields.readTextsAtOnce`, used by `selectMatOption` and
  `selectOtherMatOption`, both KSHEMA flows): the same texts, same order, "" for a hidden option, a non-breaking space as
  a space - checked in real Chrome on a 301-option replica (tricky names, hidden, see-through parent): identical to the
  old way, 1,368 ms -> 41 ms. If the call cannot run, it reads one by one exactly as before.
- **Job video built one at a time, at most 2 ffmpeg threads, low priority (nice 10)** (`lib/jobRecorder.js`), so a
  video never takes the CPU from a job's browser that is still running. Checked with a real ffmpeg encode.
- Tests: `test/kshemaReadTexts.test.js` (4), `test/recordingEncode.test.js` (3), timing sites in
  `test/stepTiming.test.js`; 9 of 9 deliberate breaks caught (2 of them only by the real-Chrome check).
- Next (round 2, from the server's `sleepTop` / `cmdTop`, per insurer): the biggest fixed pauses, database connects
  (`site=`), Selenium Manager on every browser start (no chromedriver file on the server).

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
| `RELIANCEMAXWINDOW` / `NATIONALMAXWINDOW` / `KSHEMAMAXWINDOW` / `UNITEDINDIAMAXWINDOW` / `DEFAULTMAXWINDOW` | `DEFAULTMAXWINDOW` = 1 | parallel windows per insurer (`<NAME>MAXWINDOW`, the name without spaces - "united india" -> `UNITEDINDIAMAXWINDOW`; falls back to the default) | 2 / 2 / 2 / 2 (added 2026-11-11) / 1 |
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
| `RELIANCE_MULTI_FORM_ENABLED`, `RELIANCE_OD_PRODUCT`, `RELIANCE_TP_PRODUCT` | true, OD `Two Wheeler Own damage Policy` (since 2026-10-23, nothing to set), TP "" | Reliance OD/TP-only form and its product text (§15) | true |
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
- **Payment QR is now the QR alone, on its own card, with a 5-minute expiry (2026-10-22).** `fullPolicycompany/kshema/kshemaPaymentQr.js` (shared by both
  KSHEMA flows) finds the QR inside the Razorpay iframe (a candidate must carry a sign it is the QR: "scan ... qr" text, a canvas, a data: image or "qr" in its
  class/alt/id; the elephant artwork is refused), takes its own pixels (else a crop), draws a card (company name, QR, "Valid for 5 minutes", expiry clock in IST)
  in a throw-away Chrome tab and photographs that. No image library, no `.env` switch. If the QR cannot be found or the card cannot be drawn, the old whole-popup
  picture is stored instead (the operator still gets a QR). `capture(name, stage, image)` now takes a ready-made picture. Both forms save
  `paymentQrScreenshot.expiresAt` (QR made + 5 min). Tests: `test/kshemaPaymentQr.test.js` (+ `kshemaPaymentQrSaved`); deliberate breaks caught.
  **Not run on the portal yet** - the real element inside Razorpay's iframe is unverified: after the first run read the log line "Found the QR: ..." and check the card.
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
| `BRISK_V2_AUTOMATION_ENABLED` | `false` | exactly `true` = ask our server (`POST <BRISK_V2_BACKEND_URL>/briskV2/automation/certificates`). Anything else = the legacy `/createBriskCertificate` call; it now refuses to post if the Brisk wallet balance cannot be verified. |
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
If a legacy create request ends with a connection reset, its outcome is unknown; check Brisk before retrying. The V2 route
records that uncertainty and prevents an accidental second purchase.


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
- **Switch**: `JOB_HOLD_REQUEST_ENABLED` (no new switch). Only jobs with parts are checked. KSHEMA has its own 5 stop points since 2026-10-19 (next section); National has none (it keeps the old "after the attempt").
- **Not stopped inside one long wait** (for example the up-to-5-minute KYC PROCEED wait). It stops at the step after it.
- **Tests**: `test/holdStop.test.js` (the real form with a fake browser stops after the login, and the window closes with no error flag). 7 deliberate breaks were all caught.

### Hold on a run whose helpers catch every error (2026-10-31)
A live KSHEMA log showed Hold blocking the browser while the run carried on. The field helpers report every error as a plain field failure, so the refusal became "not on the page": 10 s for each remaining field, then the second pass, with the window open. It did end as a Hold, because a later uncaught command rethrew the stop. Real Chrome on a blank form, vehicle section: 170 s and 61 false lines before, 1 s and none after.

- `lib/holdStop.js`: `driver.sleep` is refused too and a sleep in progress is woken (every company). Refusals arrive after 20 ms, so a retry loop that swallows them cannot freeze the other job in this process. A wait nobody awaits cannot become an unhandled rejection. A queue read still on its way when the payment point disarms the run can no longer fire.
- `throwIfHeld(driver)`: asked by `kshema/kshemaSection.js`, `kshema/kshemaFields.js` and after every step of both KSHEMA forms. A Breaker or stopper inside a field now ends the section as well.
- **Rule for new helpers:** a catch-all in a browser flow must let a stop through (`isAutomationStop` or `throwIfHeld`).
- Not proven: a whole run on the portal; Reliance and National get the shorter waits but were not timed, and their catches can still print a few lines on the way out. A browser command already in progress finishes first.

Tests: `test/holdLive.test.js`; 19 of 19 deliberate breaks caught in a copy.

## KSHEMA in three steps, with Hold and resume from the saved page (2026-10-19)
The owner: KYC and payment split into three steps like Reliance, Hold works, a re-run continues from the finished step, and a resumed run logs in again and opens the already saved KSHEMA page. For both `fullPolicycompany/kshemaForm.js` and the TP copy `multiCompany/tpCompany/kshemaTP/kshemaTPForm.js` (byte-identical change, drift guard green).
- **The steps**:
  1. **Proposal**: login, quote, add-ons, proposal PDF, nominee, the 2nd Save and Finalize. Done when the proposal page shows the KYC button. Its address is saved **at that moment** (`proposalLink`, and the step's `link`). Before, it was saved only after the KYC.
  2. **KYC**: on that page. A failure stops there, as before.
  3. **Payment**: Make Payment, Razorpay, the QR. Done = the payment page was reached (the owner's rule). A missing QR picture is noted on the step; a run that did not reach the page marks it Failed with the reason. **This is the LINK policy. A wallet policy takes a different road after Make Payment — see "KSHEMA link and wallet" below.**
- **Where it is stored**: the same `onlinePolicy.relianceStages.<part>` as Reliance (a part key belongs to one insurer). KSHEMA has no proposal number, so `lib/relianceStagesCore.js planResume` (both copies) now also skips the proposal when step 1 is completed with its saved `link`.
- **Resume**: `fullPolicycompany/kshema/kshemaStages.js openSavedProposal`. A fresh login (an empty profile every run), then `driver.get(saved page)`. It then waits up to 60 s for the KYC button or an enabled Make Payment.
  - If neither shows, the run stops (not retried) with *"The saved KSHEMA proposal page did not open after the new login. Set Proposal back to Pending in History to make a new quote"*.
  - If the page shows Make Payment while our record says KYC pending, KSHEMA has it done: the KYC is recorded, not redone.
  - If the page shows the KYC button while our record says KYC done, the KYC is done again.
- **Hold stop points** (top level of `runKshemaFlow` only, so no helper's try/catch can swallow them):
  - after the login;
  - before the quote form;
  - before the nominee and Save and Finalize;
  - before the KYC;
  - before the payment (also before the Brisk certificate).
  - Never after the payment has started. A Hold closes the window and deletes the profile (`isHoldStop` makes `hadError` false).
- **Brisk**: a resumed run never buys a second certificate (the part runner already sets `briskCertificateExists`).
- **Shared helper**: `fullPolicycompany/reliance/relianceStages.js` gained an `insurer` word for its log lines. It also turns a 24-hex string policy id into an ObjectId (a string id matched nothing before).
- **No `.env` switch.**
- **Tests**: `test/kshemaStages.test.js` (16: a fake page for the saved-page check, the one-write save, the order of the steps in both copies, Hold only at top level) and `test/relianceStages.test.js` (+1, the link). **12 deliberate breaks in a copy were all caught.**
- **Not proven live**: whether KSHEMA opens the saved page after a new login, and which button the page shows once the KYC is done. See root README §4.2.

## Steps set by hand: Edit → Status / KYC files (2026-10-19)
The backend and the web app can now set steps by hand: a Proposal with its referral number, KYC done by hand at the portal, a payment link sent. They can also give new KYC files that redo only the KYC (backend README §12).

The automation needs no change. A run starts from the saved steps (`planResume`), and the new files reach it through the job's refreshed `formData`.

Only the shared core changed: `lib/relianceStagesCore.js` gained `whyNotSetByHand`, `manualSet` and `firstOpenStage` (byte-identical with the backend copy; tests in `test/relianceStages.test.js`).

## Server Control agent (2026-10-19)
`serverControlAgent/agent.js` is a small separate pm2 process (`server-control`, port 3001). It lets the super admin's Server Control page start / stop / restart **only pm2 process 3 `server`**, and read its status, logs and the masked `.env`. **Install it once by hand: `serverControlAgent/README.md`.**
- **Safety**: it acts only on id 3 + name `server` (checked in `pm2 jlist` before every action), with a fixed `execFile` command (no shell), a key on every request, a lockout after 5 wrong keys, and optional `SERVER_CONTROL_ALLOWED_IPS`.
- **Tests**: `test/serverControlAgent.test.js` (10, a fake pm2). 10 deliberate breaks were all caught.

### A stuck step is stopped after 1.5 minutes - every insurer (2026-10-22)

`lib/stallWatch.js`. A run that prints nothing for **1.5 minutes** is stuck: a frozen portal page, or a wait that never ends. Every flow prints a line per step, and the long legitimate waits print while they wait (the Reliance KYC waits say "still waiting" every 15 s, so they keep their own 2-minute limit).

- **How lines are counted:** each job runs inside `stallWatch.run(jobId)` (server.js, the one place every job starts), and `console.*` is wrapped once, so parallel runs never count each other's lines.
- **When a run is stuck:**
  1. A picture of the page is taken (`screenshots/stalled/...`, at most 15 s).
  2. Every further browser command fails with `[E309]` (closing the window, a picture, and URL/title reads still pass), so a wait loop unwinds at once.
  3. A command that is itself frozen is broken after 20 s by closing the tabs through Chrome's DevTools port, then quit. chromedriver's own quit waits behind the frozen command; this was seen on a real Chrome.
  4. `guard()` gives up after a further 45 s if even that did not end the run.
- **Retries:** `[E309]` is retryable, so the queue tries again later. A stuck run **after the proposal was saved** becomes `failed_post_submission` and is not re-run automatically, the same rule as the job timeout (partRunner).
- **Never after the payment point:** `stopIfHeld("before the payment" / "before Pay")` pauses the watch for the rest of the run, whatever the hold switch.
- **Where it is armed:** `armLiveHold` / `disarmLiveHold` arm and disarm it, so every browser flow has it with no change of its own. It is a fixed rule, with no `.env` switch.
- **Tests:** `test/stallWatch.test.js` (12) and `test/partRunnerTimeout.test.js` (+3). 9 deliberate breaks were caught.
- **Checked on a real headless Chrome** (scratch, 5 s limit):
  - a never-ending wait loop stopped in 6 s with a picture;
  - a page frozen by `while(true)` stopped in about 40 s;
  - no Chrome was left running.
- **Not run on a live portal yet.**

### Run history (2026-10-22)

`lib/runHistory.js` keeps one record per run on the job (`runHistory[]`, newest 100).

**When it writes**
- When a run starts: `startRun`, in `partRunner` and in the legacy wrapper in `server.js`.
- When the login is resolved: `setRunLogin`, with the username, whose login it is and how it was matched. Never the password.
- When each step ends: `markRunStep`.
  - Reliance and KSHEMA call it through `relianceStages.markStage`.
  - National calls it at Convert Quote (proposal), Create Customer (KYC) and Send Payment Link (payment).
- When the run ends: in the same write as its outcome (`writePartOutcome`).

**Who started it:** the job's `pendingTrigger` for the first run after it; any later run of the same part is an automatic retry.

**Other**
- Outcome entries now carry `kind: "part-result"`.
- The hold-on-finish entry carries `kind: "held"` and `by`.

**Tests:** `test/runHistory.test.js` (9).

### Reliance OD waits for the existing TP policy (2026-10-22)
Reliance's "Two Wheeler Own Damage" product asks for the customer's existing third-party policy: number, insurer (KSHEMA / National),
start date, end date. They are saved on the policy (`existingTpPolicyNumber`, `existingTpInsurer`, `existingTpStartDate`,
`existingTpEndDate`) and come in the job data as text (dates `DD-MM-YYYY`, India time; `server.js buildFormDataFromPolicy` and the
backend's job builder).
- **The rule (the owner's):** a Reliance `od` portal part (OD only, or the OD half of a two-insurer policy) **never starts without all
  four**. `lib/partRunner.js` reads them from the POLICY right before the run (they are often saved after the job was queued — the
  policy wins over the job's copy) and `lib/existingTpGate.js` stops the part before any login or browser: `stopped`, code E101, stage
  `waiting-tp-details`, *"Reliance OD is waiting for the TP policy details (missing …). Enter them in Edit then TP policy details, and
  the OD runs again"*. No retry loop. The backend queues the OD part again when the details are saved.
- Not gated: the TP part, the bundled full-company flow, other insurers' OD parts.
- **Two insurers, dates not entered (2026-10-23, the owner):** a TP date that is empty is WORKED OUT right before the gate is asked
  (`lib/existingTpGate.js defaultTpDates`, called by `lib/partRunner.js`): **start = today (India)**, **end = the policy's year selection
  (`paCoverYears`, read from the policy, 1 to 5, default 1) after it, the day before the anniversary** (23-10-2026 + 1 year = 22-10-2027;
  29 Feb 2028 + 1 year = 28 Feb 2029). Only an EMPTY date; a given one stays; OD only (one insurer: `settings.isMultipleCompany` false)
  is never touched and still needs all four. So for a two-insurer policy only the **policy number and the insurer** can still make the OD
  wait — the stop sentence names only them. A start date that is not a date (e.g. "Invalid date") is not replaced: the OD form's own check
  (`lib/existingTpDetails.js`) reports it. The run logs one line: `Existing TP policy dates not entered, so they are worked out - start
  30-09-2026 (today), end 29-09-2027 (1 year selected)`. The worked-out dates are NOT saved on the policy (the backend works them out
  the same way where the details are saved by hand), so a re-run on another day uses that day.
- **Filled on Reliance's form** since 2026-10-23: `multiCompany/README.md` §15.11 (`[MC] 12`).
- Tests: `test/existingTpGate.test.js` (15; the fake policy read honours the projection like MongoDB). `test/helpers.js formData()` now
  carries TP details, since every two-insurer test job runs Reliance OD. 5 of 5 deliberate breaks in a copy were caught.

## KSHEMA link and wallet are separate, and a wallet policy is PAID from CD Balance (2026-10-22 / 23)
KSHEMA's "Choose Payment Method" page (what Make Payment opens) has two cards: **Razorpay** ("Secure payment via Razorpay", the customer's QR) and **CD Balance** ("Pay directly from your CD account", the broker's own deposit = the wallet). For both `fullPolicycompany/kshemaForm.js` (KSHEMA OD+TP) and the TP copy `multiCompany/tpCompany/kshemaTP/kshemaTPForm.js` (byte-identical change, drift guard green; the full flow's Brisk line is the only difference, as before).
- **Link** (`Paymentmethod` = "link"): exactly as it was — Razorpay, Show QR, Continue & Pay, the QR card, the step completed.
- **Wallet** ("wallet", or blank = the backend default; `isWalletPayment` of `fullPolicycompany/reliance/relianceWalletHold.js`). **It really pays.**
  1. **The CD Balance card** (`fullPolicycompany/kshema/kshemaWalletPayment.js chooseCdBalance`, called from both `proceedToPayment`): the page address is read first, the cards settle, CD Balance is chosen. KSHEMA's red line ("Account not found. Username and broker code combination does not exist") or a switched-off card = **error** "The CD Balance option is not enabled for this KSHEMA account …"; no card, no "Available balance", zero or less, a click that does not take = errors too. Nothing is paid in this part.
  2. **Pay with CD Balance** (`fullPolicycompany/kshema/kshemaWalletIssue.js payWithCdBalanceAndIssue`, the owner's steps, built like Reliance's wallet issue and reusing its store / gate / PDF wait):
     - the premium in KSHEMA's top bar ("INR 6,437") against the CD balance — **lower = error, nothing pressed** (the owner's choice). The premium is kept as `insurerPayable.<part>` {insurer KSHEMA, method "CD Balance"} — the View page shows it beside our calculation as "KSHEMA TP · CD Balance amount". Not readable → logged, KSHEMA checks itself;
     - the button shown and enabled, no KSHEMA error toast;
     - **the note FIRST**: `walletPayment` (`walletPayment_od` / `_tp` for a part) `= {state "submit-pressed", insurer KSHEMA, method "CD Balance", amountPaise, paymentPage, jobId, at}`, a guarded write — not saved = not pressed;
     - **pressed ONCE**, then KSHEMA's policy page (`/app/policy?policy_id=…&err=0&msg=Paymentupdated`) is waited for **40 s at most** (a line every 10 s; a new tab is followed). An error toast (after a 5 s grace), no page, `err≠0` or the login page → the note becomes `unconfirmed`, the run ends `failed_post_submission`: *"Pay with CD Balance was pressed for ₹… and … The payment may have gone through. Check the policy at KSHEMA before running it again - it is marked so that it is not run again by itself"* (**re-runs blocked until checked** — the owner's choice);
     - the page opens → note `issued` with the page address; the **Policy Number** is read from the Summary table (the cell after "Policy Number") and saved at once on the online policy and the Policy List record (first writer wins; also kept on the part);
     - the **policy PDF**: the `dnld-download-policy` icon, a NEW PDF in the job's download folder (the proposal PDF already there is not taken), stored in the bucket's `Policy/` folder (no expiry), set as the Policy List `policyFile` and the online policy's `mergedPolicyPdf` (the View page's policy PDF); note gets `pdfStoredAt`;
     - payment step **completed** (`mode: "wallet"`, steps locked — money moved), the part **completed** with its number. Brisk PA is not made inline for a wallet policy: the Brisk part runs after (it was left pending for that).
  3. **The gate at the start of every KSHEMA run** (before any browser): `submit-pressed` / `unconfirmed` → refused (never pressed twice); `issued` with number + PDF stored → completed at once; `issued` with its page kept → **recovered**: log in, open the saved policy page, read the number (must be the note's), save it, fetch the PDF (skipped when stored) — never pays again.
  - **To clear a blocked policy** (after checking at KSHEMA whether the CD account was charged): unset the `walletPayment` (or `walletPayment_od` / `walletPayment_tp`) field on the online policy — the same as Reliance. With the policy really issued, rather set the note to `state: "issued"` with its `policyPageUrl` so a re-run finishes it.
  - History / Status refusals now name the insurer that took the money ("paid from the wallet at KSHEMA") — `lib/relianceStagesCore.js walletInsurerOf`, byte-identical in the backend.
  - **No `.env` switch** (the owner's rule).
- Facts the code is built on, all from the owner's pasted markup and screenshot: the CD card `<button aria-disabled>` / `<p class="font-medium">CD Balance</p>` / dot `bg-primary` / "Available balance ₹65,329"; the red `text-destructive` line; `<button data-slot="button">Pay with CD Balance</button>`; the policy page URL; the Summary grid `.summary-item-cell`; `mat-icon[data-iid="dnld-download-policy"]`. **Run in real Chrome through Selenium** on local replicas (localhost): the card step (9 situations) and the whole pay step (premium read, one press, the page after 3 s, the number, the new PDF downloaded and stored; an error toast → unconfirmed after one press).
- Tests: `test/kshemaWalletPayment.test.js` (33), `test/kshemaWalletIssue.test.js` (28 — note before press, one press, 40 s, toasts, err flag, new tab, number checks, PDF new-file rule, upload failure, gate, recovery, the core wording); **CD card 23 of 23 and pay step 19 of 19 deliberate breaks in a copy caught**.
- **Not proven live**: a confirmation dialog after Pay (it would time out → blocked, nothing double-paid); the top-bar premium markup; the download icon on the real page; opening the saved policy page after a fresh login (recovery).

## Reliance OD: product, TP Details box, Fuel Type, Helmet, Nil Depreciation, the existing TP policy, and the full flow to the end (2026-10-23)
The owner's first automation steps for the Reliance **own-damage** part (steps in the root `plan-OD-Relience.txt`; what is built and what is not, step by step: `multiCompany/README.md` §15.12). Detail: §15.11.
- **Product**: the OD part chooses **"Two Wheeler Own damage Policy"** (the portal's 2nd option) by itself — `multiConfig.js` `DEFAULT_PRODUCT`; a `RELIANCE_OD_PRODUCT` line in `.env` still wins. No new switch. TP is unchanged: no product text, so it lists the portal's products and stops.
- **After Skip To Main Page** the portal opens a **"TP Details"** box. The OD part answers it: *Existing Third Party / Liability Policy Available* **Yes**, *Is Third Party Policy held With RGICL* **No**, **Proceed** (`multiCompany/common/reliance/relianceOdSteps.js`, `[MC] 7`). Each answer is a real click that waits for the next thing to show; Proceed is pressed once.
- **Fuel Type** (`[MC] 10`, after a real run: "it miss the fuel type"): the OD form's Fuel Type box, which the new-vehicle form fills by itself, is filled from the **policy vehicle's own fuel type** — read from its Make & Model master row by `lib/vehicleFuelType.js` **before any window opens** (not found = a plain error, no login, no captcha, not retried). The box is **found, not assumed** (an id / name / `aria-owns` with "fuel" in it, or its "Fuel Type" label), chosen like a person (a Kendo dropdown: click it open, click the item; a native select: `lib/realSelect.js`), and read back. **Which list item:** the policy's fuel type when Reliance has it; Reliance's own name for it (ELECTRIC = Battery, PETROL+CNG = Bifuel, HYBRID = Hybrid Electric Vehicle); **LPG / CNG on their own = Petrol (the owner's decision after the first real run, whose master row said LPG; a warning is logged)**; anything else is an error quoting both. **Every way it can fail has its own sentence**; when the box is not found the sentence **lists the dropdown boxes that are on the page**, so the next run shows its real id.
- **Then the full-company steps, unchanged**: vertical code, PAN not available, Form 60, Validate Customer, the vehicle details, **Get Coverage Details**, the **Helmet cover removed**, TPPD and **Nil Depreciation** ("nil dip") — the owner: "all things are same". **Only the PA Cover block is skipped** (`[MC] 8`: the PA to Owner Driver click, its opt-out question, the PA re-check — the OD form has no PA Cover and no nominee).
- **The cover table must come back** (`[MC] 11`): after Get Coverage Details the OD page must show its Helmet / Zero Depreciation boxes (it has no PA box, the one the full flow counts as "loaded"). If not, the error is **Reliance's own words** — the cover box, an open popup (without its OK button), a field message, the required boxes that look empty, the text of an `alert()` — instead of a later "Helmet box not found".
- **The existing TP policy** (`[MC] 12`, the owner's later message the same day): right after Nil Depreciation the OD run opens the **Existing Third Party panel only if it is collapsed**, types the policy's TP **number**, chooses the **insurer** (KSHEMA General Insurance Limited / National Insurance Company Limited; its box id is unseen, so it is found by what its list offers) and enters the **start and end date**, each read back (`fillExistingTpPolicy`). The four values are the policy's (Edit then TP policy details); `lib/existingTpDetails.js` checks them **before any window opens** (bad = one plain sentence, not retried). **Two insurers: an empty start / end date is worked out first** (start = today in India, end = the policy's "No of Year" selection after it, the day before the anniversary — `lib/existingTpGate.js defaultTpDates`, section "Reliance OD waits for the existing TP policy"), so only the number and the insurer can be missing. Reading them from the TP insurer's portal is a later feature.
- **Then the full flow, to the end — no stop any more** (`[MC] 9` is retired): financier, **Is Registration Address Same** (`[MC] 14`: ticked only when it is not ticked), Calculate Premium, Save, the KYC upload, Pending Quotes and Pay (customer link or the wallet's CDT option). **The payment is real, like the full flow.** The nominee block and the last PA check are skipped for OD (`[MC] 13`). `[MC] 15` adds exact words where the full flow reads nothing: an `alert()` or a refusing popup after Calculate Premium and after Save, and what the page shows when Save gives no proposal number (with "check View Policy before running again").
- The generated copy `relianceMultiForm.js` carries all of it (`[MC]` lines, `mcKind` only); after any `relianceForm.js` change run `node multiCompany/common/reliance/relianceMultiFormSpec.js --write`.
- **Not built yet (the owner will say)**: Renewal from another company, register number / fetch vehicle details, the previous-policy fields, previous insurer details (plan in `multiCompany/README.md` §15.12). `proposalNumber`, `kycStatus` and the links are single fields on the policy, shared by an OD and a TP part (known limit).
- **Tests**: `test/relianceOdSteps.test.js` (17), `test/relianceOdFuelType.test.js` (27), `test/relianceOdExistingTp.test.js` (25), `test/existingTpDetails.test.js` (7), `test/vehicleFuelType.test.js` (10), `test/relianceMultiForm.test.js` (43). **Real Chrome checks by hand** in `test/manual/odReplica/` (README there; not part of `npm test`, they start a browser): the whole generated copy on a replica site in 17 scenarios (all pass, up to the proposal number), the Fuel Type step on 14 page shapes, the reader of Reliance's words, the TP Details box. **73 deliberate breaks of the Fuel Type work and 50 of the existing-TP / address / Calculate / Save work in a copy caught.** Not run on the live portal; the Fuel Type box's, the existing TP panel's, the insurer box's and the date pickers' real markup has never been seen.

## Brisk: one method for every company (the owner, 2026-10-31)

"All company handle the PA Brisk API with the same scenario." The insurer's work finishes first, then the job's Brisk part (`lib/briskPartRunner.js`) makes the certificate.

- **How.** `buildPartFormData` gives a bundled part `briskByPaPart` when the job has a Brisk part, and `shouldCreateBriskCertificate` then answers no. No insurer form changed. The forms' inline code only runs for a job with no parts (`POLICY_JOB_PARTS_ENABLED` off).
- **Getting the PDF.** Brisk writes the PDF when `ViewCertificate` is asked. The create only gives its address, which answers 404 until then (proved live on TW31102600201901, 2026-10-31: 404 for 2 hours, then 200 at the moment View answered, file stamped the same second). Girnar does the same (`dao/policyDao.js`, create then `viewBriskCertificate`). Our server asks it before it answers the automation, so the file is normally there at once. `downloadBriskPDF` checks 3 times only (at once, then a minute apart) and saves the file under its real name only when it is complete and starts with `%PDF-`. If it still is not there, the part ends `completed_with_errors` and the server keeps trying (backend README, "Brisk certificate PDF"); when it saves the file the part turns `completed`.
- **A re-run with only the number on the policy** (a restart or ^C while waiting for the file). It used to say completed with no PDF. Now it reads the address from the server's `briskV2Certificate` record, never through the create call so it cannot buy, does its 3 checks and stores the PDF. If the PDF still is not stored the part is `completed_with_errors`.
- **`BRISKMAXWINDOW` default is now 3** (was 1): every certificate comes through this window and may wait up to 2 minutes.
- **What changed for Reliance.** Its Policy PDF is no longer merged with the Brisk certificate on the wallet path: they are two files, as National, KSHEMA and two-insurer policies already were.
- **Tests:** `test/briskPdfWait.test.js`, end of `test/partRunner.test.js`, `test/multiCompanyCover.test.js`. Not run against real Brisk.

## United India (TP only, 2026-11-06): what the automation already does
United India is a TP-only insurer whose portal flow is **not built yet** (no `registry.js` entry).
- **A United India TP part stops at once.** `lib/partRunner.js` now looks the portal handler up BEFORE the login, so it ends with
  `[United India] [E110] No TP automation exists yet for United India.` (not retried). It no longer asks first for a portal login
  that could not be used.
- **The full-flow dispatcher no longer falls through to Reliance.** `server.js dispatchBundled` has an explicit Reliance branch.
  Any other company gets `[E110] No full (OD + TP) automation exists for <company>. ...`. Before this, an unknown company ran
  Reliance's form with that company's login.
- **Labels**: `COMPANY_LABELS` (server.js, partRunner.js) has `"united india": "United India"`. The window limit works as it is:
  `UNITEDINDIAMAXWINDOW`, default 1.
- **Logins**: `models/ProviderCredential.js` accepts `united india`, like the backend's model.
- **Existing TP insurer on Reliance OD**:
  - `lib/existingTpDetails.js INSURERS.unitedindia` (match word `unitedindia`).
  - `relianceOdSteps.js chooseInsurerOption` takes each insurer's `match`.
  - An unknown key matches nothing now; it used to fall back to National's words.
  - **Reliance's real wording for United India is not seen yet.** If it is missing, the error lists what the dropdown offers.
- **Tests**: `test/unitedIndia.test.js` (it takes `dispatchBundled` from the source and runs it with fake forms), +1 in
  `test/partRunner.test.js`. Two tests that used "United India" as an unknown insurer now use "ICICI Lombard".
  - 8 of 8 deliberate breaks caught.
  - `npm test`: 1345 tests, the only failure is the known captcha-file one.

## United India TP: the login, then the Breaker stop (2026-11-06)
The login is taken from the owner's older download project (`/home/karthi/Documents/Rayal_Brokers/Rayal-auto-pdf-downlod`:
`xldownload.js` United India XL flow, `pdfdownload/pdfdownload.js`, `captcha.js`). It runs on our shared login loop.

**How a United India TP part runs (TP only; there is no OD)**
1. `multiCompany/registry.js` `"united india": { tp }` -> `multiCompany/tpCompany/unitedIndiaTP/unitedIndiaTP.js` inside `runHandler`.
   That gives the gate, the browser, the recording, the live Hold, the login, a failure screenshot and clean-up.
2. **Browser**: `unitedIndiaTP/unitedIndiaSession.js`, a fresh empty profile per run in `cloned_profiles_united_india`
   (cleaned on start, swept). It uses KSHEMA's job driver, which has no implicit wait.
3. **Login**: `multiCompany/common/login/unitedIndiaLogin.js`.
   - **Page**: `https://www.uiic.in/GCWebPortal/login/LoginAction.do?p=login`; a saved credential URL wins.
   - **Boxes**: `#username`, `#password` (`userPaWord`), `#userCaptcha`, button `#login`, plus the old fallbacks. `readonly` is
     removed first, as the old code did.
   - **Captcha**: `#captchaImg` is taken in memory (no file), enlarged 3x by the page canvas, read by `Captcha.js`, and typed only
     if it is 4-8 letters/digits. It is **not** counted in the daily Reliance captcha counter (`extractCaptchaText(url, { count: false })`).
   - **Logged in when one of these shows**: `a[data-target='#10']` ("View Reports and Queries"), `a.menuColor` /
     `a.subMenuColor` / `#sidebar`, a "Policy Documents" link, or the login box gone from a finished page that is no longer
     `p=login`.
   - **Refused**: `#loginError` / `.loginError` (`portalMessages.js`).
   - **Results**:
     - a wrong user / password is E203: not retried, **never submitted twice**;
     - locked is E204;
     - a captcha refusal is E202: tried again on a fresh page with a fresh captcha, up to 3 attempts;
     - a page that never loads is E304;
     - a page still loading is E302.
   - **Loader**: `loader.js "united india"` (common busy markers plus `waitReady`: the page's own load must be complete). The old
     project had no loader, only fixed sleeps, so this code polls instead of sleeping.
4. **After the login**: `Breaker.checkpoint("stopthis-location")`, the owner's own stop point (his `.env`: `BREAKER_ENABLED=true`,
   `BREAKER_STOP_AT=stopthis-location`). If the Breaker lets it pass: "Logged in to United India - the United India TP form is not
   built yet". Both are a deliberate stop: no retry, nothing submitted, the window stays open with `KEEP_BROWSER_OPEN_ON_ERROR=true`.

**Not taken over from the old code**: the PDF tool printed the password in its log and kept default credentials in its source.

**Tests**
- `test/unitedIndiaLogin.test.js` (23, a fake UIIC page).
- `test/manual/uiicReplica/loginCheck.js` (real headless Chrome on a replica page, 15 checks, all pass; by hand only).
- The registry / login-index lists were updated in `multiCompanyRelianceLogin.test.js` and `relianceMultiForm.test.js`.
- 16 of 16 deliberate breaks caught in a scratch copy.
- `npm test` has only the known old failures (the captcha-file one; the download-ceiling timing flake under load).

**Not seen on the live portal yet**: which success marker shows after the login, United India's error wording, any loader, and a
"session already active" message.

### After the login: Policy Transaction > Make New/Renew Policy (the owner, 2026-11-06)
`multiCompany/tpCompany/unitedIndiaTP/unitedIndiaMenu.js` opens the two items in the owner's markup:
- the sidebar's `<a data-toggle="collapse" data-target="#3" class="menuColor">Policy Transaction</a>`;
- then `<a href="../portal/MenuAction.do?method=strbtn" class="subMenuColor">Make New/Renew Policy</a>`.
The Breaker stop (`stopthis-location`) now comes **after** that page, before the rest of the TP form.

**The owner's rule for every click and every field of this flow** (`unitedIndiaTP/unitedIndiaSteps.js`):
- **Clicks** (`clickAndConfirm`): a click counts only when its effect is seen; otherwise it is clicked **once more**.
  - The menu counts as clicked when its submenu link shows. The submenu counts when the page address has `method=strbtn` or
    `#selectProduct` is there.
  - A menu that is already open is **not** clicked again, because it is a collapse toggle and would close.
- **Fields** (`fillAndConfirm`, for the next steps): a field counts only when it reads its value back; otherwise it is typed **once
  more**.
- **Missing elements**: one that is not visible stops the run at once with its name, for example `[E301] United India -
  "Policy Transaction" is not on the page (not visible after 10 seconds) ...`. Clicked twice without effect is `[E301] ... was
  clicked 2 times but ...`; a field that never holds its value is `[E306] ...`.
- **Stops**: every wait polls, and a Hold or Breaker stop always gets through (`throwIfHeld`).

### The Products page: Liability Only Policy, then Submit (the owner, 2026-11-06)
`multiCompany/tpCompany/unitedIndiaTP/unitedIndiaProduct.js`, on the page that Make New/Renew Policy opens.
- **Office and LOB**: Select Office ("DO VELLORE(280300)") and Select LOB ("Motor") are filled by the portal. They are only read
  into the log and **never changed**; an empty one is said in the log.
- **Product**: **Select Product** (`select#productCode`) = **"Liability Only Policy"** (value 3102), matched by its exact text,
  so "Liability Only Policy Renewal" is never taken.
  - It is chosen like a person (click the box, click the option) and read back. If it does not show the choice, it is set
    **once more** the page's own way (value + change event).
  - Then `[E306] ... shows "..." instead of "Liability Only Policy" after 2 tries`.
  - A list without it: `[E306] ... does not offer "Liability Only Policy", it offers ...`, not retried.
- **Submit** (`input#selectProduct`): it counts when the Products page has gone and the next page finished loading. Otherwise it
  is pressed **once more**, then `[E301]` with what the page says.
- **Popups**: an `alert()` the portal answers with (reported by chromedriver, or still open) is read, accepted and reported in
  the portal's own words: `[E308] United India - after "Submit" the portal said "..."`, not retried.
- **Breaker**: the stop (`stopthis-location`) is now after this Submit. The plain stop says "Liability Only Policy is chosen and
  submitted, the rest of the TP form is not built yet".
- **Tests**: `test/unitedIndiaProduct.test.js` (12). The replica now has the Products page with the owner's option list, a real
  native dropdown and a real `alert()`: 32 checks, all pass. 12 of 13 deliberate breaks caught; the 13th (dropping the explicit
  no-retry flag) changes nothing, because E308 is never retried by its code.
- **Not seen live**: the page after Submit.
- **Note**: the list also has "Two Wheelers Long Term Liability" (3162); the owner chose "Liability Only Policy".

### Risk Details: Vehicle Class, Registration State, New Vehicle, Chassis, Engine (the owner, 2026-11-06)
`multiCompany/tpCompany/unitedIndiaTP/unitedIndiaRisk.js` `fillRiskDetails`, on the page that the product's Submit opens
(`gc_initiateAshokLeyland.do`).
- **Opening the page**: if Submit opens it in a **new window**, the run switches to that window and does not press Submit again.
- **Data first**: the policy's state, chassis and engine number are checked **before** anything is touched. Missing ones stop
  with one sentence, not retried.
- **Vehicle Class** `select#v_make` = **"Motorcycle / Scooter"** (3). Its `populateManufacturer()` runs, and the loader is waited
  for.
- **Vehicle Registration State** `select#regst` = **the customer's State/Union Territory on the policy**:
  - the Online Policy saves `tamilnadu`, `pondicherry`, `westbengal` ...;
  - they are matched to United India's spelling (TAMIL NADU 43, PONDICHERRY U.T. 95 ...), ignoring case, spaces, dots and the
    "U.T." ending, with aliases (Puducherry, Chhattisgarh, Orissa ...);
  - a state the list lacks stops, not retried.
  - The state is read from the **policy** at run time (`lib/partRunner.js` adds `customerState`); the job's `state` holds a
    Reliance code.
- **New Vehicle** `#newvehchk1`: ticked. It is never clicked when it is ticked already, and a disabled box stops with a sentence.
  Its onclick runs `getRegState()`, so the Registration State is read again and chosen once more if the tick changed it.
- **Chassis Number** `#chasisNumber` and **Engine Number** `#engineNumber`: the policy's values, typed and read back (the page
  upper-cases them).
- **Vehicle Manufacturer** `select#selectedNumNameCode` = the Make & Model row's **Make**, then the portal's **Make**
  `select#makeMotorDisplay` = the row's **Model** (the owner's correction, 2026-11-06: "manufacturer is a make and make is a
  model", e.g. HERO HONDA, then "CBZ(1999 - 2008)"; the first version of this step had them the other way round).
  - Both by the **exact** name (case and spaces do not count). The manufacturer list has "HONDA" (IBB4560) next to
    "HONDA_NONGICOUNCIL"; only the exact one is taken.
  - The Make list is filled by the portal's `retrieveURL()` after the manufacturer; it is waited for, up to 20 s, then `[E301]`.
    Since 2026-11-13 the **Vehicle Manufacturer list is waited for the same way** (it is filled after the Vehicle Class); before,
    a list that had not arrived yet read as "has no HONDA", which is never retried.
  - No exact manufacturer / no exact Make (2026-11-13 wording): the stop names what United India offers that is **like** it,
    **at most 15 names, then "and N more"** (HONDA alone has well over a hundred Makes). For the Make, "like" = shares a word of
    3+ letters ("BS VI" alone is like nothing), the closest first ("ACTIVA 7G" puts "ACTIVA 7G STD" before "ACTIVA 6G");
    nothing like it = the whole list when it is 15 or fewer, else "None of the N names ... is like it". Neither is retried;
    correct the United India Make & Model row. Example: `[E306] United India - the Make list for "HONDA" has no "ACTIVA 7G" (the
    Model of this vehicle in the Make and Model master), so the run stopped there. Names like it that United India offers for
    "HONDA" are "ACTIVA 6G", "ACTIVA 125". Correct the Model of the United India Make and Model row, then run the policy again.`
  - The run never adds to the Vehicle Model lists (they are kept by hand). The Make & Model dialog offers their names, so the
    row holds the portal's exact spelling.
- **Every one** follows the owner's rule: chosen or typed, read back, once more if it did not take, a missing box is its own
  error.
- **Console**: every line of a United India TP run starts with `United India TP | ` (`lib/flowLogPrefix.js` TAGGED_COMPANIES, the
  existing `FLOW_LOG_PREFIX_ENABLED`).
- **Breaker**: the stop (`stopthis-location`) is now after the Make.
- **Tests**: `test/unitedIndiaRisk.test.js` (16), the new-window case in `test/unitedIndiaProduct.test.js`, `customerState` in
  `test/partRunner.test.js`.
  - The replica has the Risk Details boxes with their onchange / onclick and loader: three scenarios (normal, new window, the
    tick resetting the state), all pass.
  - 23 of 23 deliberate breaks caught across this round.
- **Not seen live**: the real page's loader after each onchange, and what `getRegState()` really does.
- **2026-11-13, first live run**: login -> menu -> product -> Risk Details -> HONDA / "ACTIVA 125 FI(2019 - 2023)@ALLOY BS VI"
  -> the Breaker, all on the real portal (the owner's log).

### United India Risk Details after the Make: dates, PUC, Delhi - NCR (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaDates.js` then `unitedIndiaTP/unitedIndiaQuestions.js`, after the Make; the Breaker
(`stopthis-location`) is now after the Delhi - NCR answer.
- **Date of Purchase** `#dtPurchaseStr` (`name="dateOfPurchaseString"`) = **today, in India time** (`lib/policyDates.js`
  `indiaCalendarDay`; a UTC server would be a day early before 05:30 IST), **DD/MM/YYYY** (the format the old formFlow.js /
  autofill.js typed). The box is **readonly** and its click opens the portal's calendar, so it is never clicked or typed into:
  the date is put in, input / change / blur fire, and the page's own after-pick check **`registrationDateValidation`** (named
  in the box's onclick) runs when the page has it. Its popup = `[E308]` in the portal's words, not retried; a date the page
  empties is put in once more, then `[E306]`.
- **Month of Manufacture** `select[name="makeMonthgc"]` (**no id**) = this month, by its value ("11"). `selectAndConfirm` now
  takes `target` (selectors) for a box without an id.
- **Year of Manufacture** `#yearOfManufacturing` = this year; the portal already shows it, so it is left as it is
  (`fillAndConfirm` `keepIfSame`), typed only when it differs (New Year).
- All three are read once more at the end; one that changed = `[E306]`, tried again later.
- **Valid PUC** `select[name="ynPuc"]` = **Yes**, **plying in Delhi - NCR** `select[name="ynDncr"]` = **No** (the owner's
  defaults). **Both boxes have `id="repository"`**, so they are found by NAME (an id lookup would answer the PUC box twice).
  Both read once more at the end.
- Tests: `test/unitedIndiaAfterMake.test.js` (20). Replica: the real markup (readonly box + onclick calendar, a page
  `registrationDateValidation`, the month without id, the two `repository` boxes) in all three Risk scenarios, plus a real
  `alert()` from the date check (Chrome reports it, the run says `[E308]` with its words): all pass. 17 of 17 deliberate breaks
  caught in a scratch copy.
- **Not seen live**: that the portal takes DD/MM/YYYY, what its calendar does after a pick beyond `registrationDateValidation`,
  and whether the Delhi - NCR answer should follow the customer's state (today always No).

### United India Risk Details: the insured (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaInsured.js` `fillInsuredDetails`, after Delhi - NCR; the Breaker is now after the Address.
- **Client Type** `#clientType` = **Individual**, the portal's default, **not touched** when it shows it (the owner: "now it not
  touch, continue with individual"); only a portal showing something else is set to Individual. **`clientTypeFor(data)` is
  the one place where Individual / Corporate is decided later** (its `onchange` is `change(insuredname1.value)`, so Corporate
  will also change the Title list).
- **High Risk** `#ynHighRisk` = **No** (default).
- **Title** `#insuredname1` = the policy's `proposerTitle` (Mr. -> MR., Ms. -> MS., Mrs. -> MRS.); none -> from the gender
  (male Mr., female Ms., as the Online Policy does). **M/S stops** before the page is touched: a company needs Client Type
  Corporate, not built yet.
- **Insured Name** `#insuredname2` = the policy's **Full Name only** (the job's `firstName`), **not the Surname** (a live case
  had Full Name "ANMOL ARORA" + Surname "MASTER"; KSHEMA leaves the Surname out too unless its switch is on). Letters and
  spaces only (the page's `nodot()` drops dots: "K. RAMESH" -> "K RAMESH").
- **Address** `#addressOfInsured` = the address boxes in one line (Flat / Door, Floor, Building, Block, Road / Street, Area and
  Locality - KSHEMA's `kshemaAddressLine`, so a name written twice by an Aadhaar read is left out), then **every character
  that is not a letter or a number becomes a space** (commas, dots, #, /, -, & ...; the owner: "not enter the special
  characters"), single spaces, upper case, at most 200 (its maxlength), cut between words after the cleaning. Example:
  `#272/A`, `1ST FLOOR`, `RAMANA APTS.`, `PILLAYAR KOVIL ST., 2ND CROSS`, `TONDUR, VILLUPPURAM - 604203` ->
  `272 A 1ST FLOOR RAMANA APTS PILLAYAR KOVIL ST 2ND CROSS TONDUR VILLUPPURAM 604203`.
- The policy's Title, Full Name and address are checked **before** the page is touched; all five boxes are read once more at
  the end.
- **Popups on choices and typing** (`unitedIndiaSteps.js`, every United India step): a popup that a box's onchange / onkeyup
  opens is now `[E308]` in the portal's words, not retried - also one still open after the step. Before, a choice or a typed
  box swallowed it into "shows X instead of Y". `fillAndConfirm` types with its own copy of `typeWithReadback`
  (`typeInto`), because that one swallows the popup's error.
- Tests: `test/unitedIndiaInsured.test.js` (22). Replica: the owner's markup in a `VehicleForm` with `change()`,
  `toggleHighRisk()`, `setthevalue()`, `nodot()`, a messy Aadhaar-style address; plus a real `alert()` from High Risk's
  onchange (`[E308]`, the Title untouched): all pass. 17 of 17 deliberate breaks caught in a scratch copy.
- **Not seen live**: the portal's own words for these boxes' labels, and whether its Address takes digits-only words
  (the pin code stays in the line when a box has it).

### United India Risk Details: the Pin Code fills State and District (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaPinCode.js` `fillPinCode`, after the insured's Address; the Breaker is now after it.
- **Pin Code** `#PIN_CODE` (`name="pincodeString"`, maxlength 6, `onblur="getStateDist()"`) = the policy's pin code (6 digits,
  spaces dropped; missing / not 6 digits stops before the page is touched, not retried). Typed and read back, then the box is
  **left** (focus, then away) so its onblur runs the portal's `getStateDist()`.
- The portal fills **State** `#STATE_CODE1` and **District** `#STATE_CODE2` (both disabled). The run waits up to **10 s** per try for a
  real District to be chosen (the owner, after his first live run: 10 s, not 20) (the State is read after it - read before, it could still show Select).
- **Not filled**: the box is left **once more** (typed again only if the portal emptied it). Still not filled = `[E306] United
  India - the Pin Code 999999 did not fill the District (the District stayed on Select, 2 tries), so the pin code may be
  wrong and the run stopped there. Check the customer's pin code on the policy, then run it again.` - **not retried**, with
  the run's screenshot (runHandler). A District list with nothing chosen says so. A popup = `[E308]` in the portal's words.
- **The pin box is never emptied with Selenium's `clear()`**: that focuses, empties and LEAVES the box, so its onblur ran
  `getStateDist()` with an EMPTY pin code (the real-Chrome replica counted 3 runs for 2 tries); the portal may answer that
  with its own popup. `fillAndConfirm` got `clearQuietly` (empties by script, no focus change).
- A pin code in another state than the customer's state on the policy: a **warning** in the log only, the run goes on.
- Tests: `test/unitedIndiaPinCode.test.js` (13). Replica: the owner's markup and a `getStateDist()` that fills 1.5 s after its
  loader (or nothing for an unknown pin code): all pass, `getStateDist()` runs exactly once per try. 14 of 14 deliberate
  breaks caught in a scratch copy.
- **Not seen live**: what `getStateDist()` does with an unknown pin code (nothing, a popup, or an empty list) - each case has
  its own sentence.

### United India Risk Details: Mobile, Email, Date of Birth, RTO (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaContact.js` `fillContactDetails`, then `unitedIndiaTP/unitedIndiaRto.js` `chooseRto`, after the
Pin Code; the Breaker is now after the RTO.
- **Mobile** `#mobile` = the policy's mobile number, 10 digits (a +91 / 91 / 0 in front and spaces dropped).
- **Email** `#emailAddress` = the policy's email (trimmed, lower case), typed (emptied quietly), then the box is **left** so its
  `onblur="validateEmail(this.value)"` runs; its popup = `[E308]` in the portal's words.
- **Date of Birth** `#dateOfBirthString` = the policy's date of birth (the job's DD-MM-YYYY) as **DD/MM/YYYY**. Its click opens the
  portal's calendar, so it is put in by script (`unitedIndiaDates.js putDate`, the Date of Purchase's way, now shared), never
  clicked or typed; its blur event runs `checkDateValidation(this.value)`. Not a real day (31-02) or a future one stops.
- Mobile, Email and Date of Birth are checked **before** the page is touched (one sentence naming each problem, not retried);
  all three are read once more at the end.
- **RTO** `select#rtaDesc` (`onchange="populateInvoiceZone()"`) = the policy's **RTO City/Location** (`rtoCityLocation`) by its
  CODE: the RTO master writes "TN55", "TN-55", "TN 55", so a code is compared by its parts - 2 state letters, the number (TN5
  = TN05) and letters stuck to it (DL1C is not DL1). The option's code is the start of its text ("TN55 SALEM", "TN-56
  PERUNDURAI", "TN 57 DINDIGUL"); the bare "PY" option is not an RTO.
  - one option with the code: chosen by its exact value, read back, `populateInvoiceZone()` + loader waited for;
  - none: `[E306] United India - the RTO TN58 (the policy's RTO "TN-58") is not in United India's RTO list, so the run stopped
    there. The nearest TN RTOs United India offers are "TN57 DINDIGUL", "TN59 MADURAI", ... Correct the policy, then run it
    again.` - not retried, with its screenshot. When the list has no RTO of that state at all (it follows the Vehicle
    Registration State = the customer's state), it says so and shows what it lists;
  - two with the same code: stops and lists them (never a guess); no usable code on the policy: stops before the page.
- Tests: `test/unitedIndiaContactRto.test.js` (24). Replica: the owner's markup with a `getRegNoRta()` that fills the RTO list
  from the chosen state (his Pondicherry list, a Tamil Nadu one), `validateEmail` / `checkDateValidation` /
  `populateInvoiceZone` recorded: TN-55 -> TN55 SALEM, PY-01 -> PY01 PONDICHERRY, validateEmail ran once, the calendar never
  opened, TN-58 stops with the nearest, a real validateEmail popup = `[E308]`; all pass. 17 deliberate breaks caught in a
  scratch copy (an 18th, dropping the `0*`, changes nothing: `Number("05")` is 5 already).
- **Not seen live**: whether the portal's DOB check wants an 18+ age, and the real wording of its RTO options outside PY.

### United India: More Covers N Info, then the TPPD Limit (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaMoreCovers.js`, after the RTO; the Breaker is now after the TPPD Limit, on the More Covers page.
- **More Covers N Info** `<img src="...MoreCoversNInfo.JPG" onclick="fnSubmit('morecoversninfo')">`: the portal SUBMITS the
  Risk Details and opens its next page. The run waits **up to 20 s** (the owner); no page = `[E301] United India - after
  "More Covers N Info" was clicked the next page did not open within 20 seconds ...`, tried again later, with the screenshot.
  A popup = `[E308]` in its words; a page in a new window is followed.
  - The page change is seen by a **mark** put on Risk Details before the click: a loaded page without it is the next page.
  - **Never submitted twice**: the button is clicked a second time (the owner's rule) only when, 5 s after the first click,
    the page shows NO sign of the submit (not unloading, no loader, no pending page seen).
  - **ChromeDriver's page-load wait**: while a page is on its way, EVERY WebDriver command - the click too - waits for it, up
    to the page-load limit (300 s by default), so a hung submit hung the run far past 20 s (the real-Chrome replica did).
    For this wait only the limit is **2 s** (`PAGE_LOAD_POLL_MS`), then put back. A click that comes back as that timeout is a
    click that WORKED (`clickOnce`): the shared `clickWithFallback` took it for a failed click and clicked again by script -
    the replica's portal got the form TWICE. At 20 s `window.stop()` cancels the hung submit (it cannot land later; the
    error's screenshot is taken at once).
- **TPPD Limit** `select[name="tppdLimit"]` (no id): the policy's **TPPD Restrict ticked = "Upto 6000"**; not ticked = "Upto
  100000", which the portal shows already, so normally not touched (a portal showing 6000 is set back to 100000). The owner
  picked this rule on 2026-11-13 - the one Reliance and KSHEMA follow - so our premium (worked out with the same tick) and
  United India's agree. (His first wording was the other way round; asked, he chose this.)
- Tests: `test/unitedIndiaMoreCovers.test.js` (20). Replica: a real `fnSubmit()` form post to a More Covers page with the
  owner's TPPD box (1.5 s), a swallowed first click (clicked again, ONE post), and a submit the server never answers
  (`[E301]` at 22 s, ONE post, screenshot in 18 ms, page-load limit back to 300 s): all pass. 16 of 16 deliberate breaks
  caught in a scratch copy.
- **Not seen live**: the More Covers page itself (its address, its loader), and whether the morecoversninfo submit saves
  anything at the portal (a retry starts again from the login, so a second Risk Details would be sent).
- **Note for the other insurers' flows**: the Products page's Submit still uses `clickWithFallback` under the 300 s limit; a
  hung submit there is ended by the stuck-step watch (90 s), not double-clicked within it.

### United India: a wrong "Error In Data Entry" once = the steps once more; "Offline data saved successfully" = the KYC done (the owner's live runs, 2026-11-14)
1. **Once more, then the error.** Live: after Next in Proposal Modification the portal showed "Error In Data Entry - (0)null"
   and the run stopped for good. The owner: the portal sometimes shows a wrong error - try again, and only a SECOND time is
   the error. `unitedIndiaTP.js onceMore`: the steps that save nothing at United India - a resume from Proposal Modification
   to Compute Premium, a new proposal from Make New/Renew Policy to Compute Premium - are done once more on the FIRST box
   (logged with the portal's words); the page is opened again BY ITS ADDRESS (the run keeps it from the first opening -
   `unitedIndiaMenu.js openDirect`, a GET like the link: an error page may have no sidebar); the box again = `[E306]` not retried,
   "... the portal says "Error In Data Entry - (0)null" a second time (the run had done it all once more)". Other errors are not
   redone. Update, Modify and the KYC are never redone (they would make a second proposal / KYC). The error carries the portal's
   words (`portalError`, `portalLines`, `portalLabel`).
2. **"Offline data saved successfully".** Live: after Save the window showed "CKYC Status-Offline" with "Offline data saved
   successfully" and the details - no Offline KYC button there - so the run had left the KYC step as it was and the window open.
   `readCkycStatusInPage` reads that message (`saved`); after Save it - or Offline KYC disabled - = the KYC done: the KYC step
   completed (its message and Customer Id kept), then Close. The stop: "Save pressed - the KYC is done (United India says
   "Offline data saved successfully"), KYC step = completed, the CKYC window closed".
- Tests: `unitedIndiaLogin.test.js` +3 (once more on a resume / the second box = E306 / a new proposal from its address / an
  E301 never redone / the saved wording). Replica: the after-Save page copied from the owner's screenshot (no popup, except
  in `kyc-new` so the words-after-Save path stays checked), `resume-error-once` (the first Next answers "(0)null": Proposal
  Modification opened again by its address, Next again, on to the KYC), `resume-error-twice` (every Next: E306 "a second time").

### United India resume, from two live runs (the owner, 2026-11-14): search to TODAY, the proposal kept FRESH, a reopened PA Cover re-ticked
1. **The search** (`unitedIndiaProposalModification.js`): From = the saved Reference Date, **To = today** (India). A resume puts the
   Policy Start Date to today and Modify, and United India then moves the proposal's Reference Date to today - his live run
   searched 13/11 to 13/11 and stopped "proposal 202611131393359 is not in the Proposal Modification list". The "not listed"
   sentence names the span ("for 13/11/2026 to 14/11/2026").
2. **The proposal kept fresh** (`unitedIndiaTP.js`): the list row's Reference Date, when it moved, is saved (date ONLY, same
   number - `unitedIndiaProposal.js saveReferenceDate`); after **Modify** the page's proposal block is read FRESH - number,
   Reference Date, Transaction NO, Customer ID - and saved (`saveFreshProposal`: the part's Proposal step and
   `unitedIndiaProposal`, only while the step is still the old number; a NEW number keeps the old one as
   `previousProposalNumber` and takes the list's `proposalNumber` column when it held the old one). Never a step status (a
   "proposal completed" write would put a done KYC back to pending). The stop names the fresh proposal. A page with no block keeps
   the saved one (said).
3. **A reopened PA Cover** (`unitedIndiaPaCover.js`): it comes TICKED while CPA Cover and the nominee boxes stay hidden until its
   `checkdriv()` runs - his live run stopped "[E301] "CPA Cover" is not on the page". Ticked but CPA Cover not shown in 3 s =
   unticked and ticked again, then filled as usual; ticked WITH its boxes shown = not clicked.
- Live note: the reopened page (`gc_initiateAshokLeyland.do?parameter=proposalModify`) has no `polStartDateValidation` - the start
  date is put in and read back only (logged "the page has no polStartDateValidation").
- Tests: PA +2, proposal +2 (date only / fresh: the exact writes, never a status), handler (the list's date, the fresh proposal, a
  new number, a page without the block, a failed write). Replica: `resume-date-moved` (ours listed with today's date - the
  range finds it, the date saved), the list filtered by From..To, after Modify the page shows ours with today's date (saved
  fresh), `resume-pa` (PA ticked with hidden boxes - re-ticked, 5 Year, DEVA, Son).

### United India: Offline KYC disabled = the KYC is ALREADY DONE -> KYC step completed (the owner's live run, 2026-11-14)
Live: the CKYC window opened on "CKYC Status-Online Search" (Customer Id 23676065442, Result "Offline KYC Done") with
`<button type="submit" name="param" value="Offline" class="btn btn-default" disabled>` - the run clicked the disabled button
twice and failed `[E301] ... after "Offline KYC" was clicked the next page did not open within 20 seconds`. The owner: "if the
Offline KYC button is disabled, the KYC is already finished - update KYC finished".
- `unitedIndiaKyc.js`: the window's status is read FIRST (`readCkycStatusInPage`: Offline KYC there / disabled, the Result and
  Customer Id next to their labels) and logged (`CKYC window: Customer Id ..., Result "...", Offline KYC disabled`).
  **Disabled** = nothing entered, the part's **KYC step = completed** (`markKycDone` -> `relianceStages.markStage(data, "kyc",
  "completed", { mode: "offline", result, customerId }, { insurer: "United India" })`, never throws), then the stop
  "... the CKYC window opened - the KYC was already done at United India (Offline KYC disabled, "Offline KYC Done"), KYC step =
  completed; what comes after the KYC is not built yet". After a fresh **Save** the status is read again: disabled there too =
  the KYC step completed ("Save pressed - the KYC is done (...)"); not disabled = the step is left as it is.
- A write that fails is said ("the KYC step could NOT be saved (set it to Completed in Edit -> Status)"), never a failure.
- **Then the window's own Close** (the owner, same day - his live run saved the KYC but left the window open):
  `<button type="submit" name="param" value="Close" class="btn btn-default" onclick="window.close();">Close</button>` pressed
  (`closeCkycWindow`), the window checked GONE, the run back on the proposal page (the stop's screenshot is that page); a click
  that reports the window gone counts as done; a Close that does nothing is pressed once more, then the run closes the window
  itself (said in the log and the stop: "the CKYC window closed (by the run - its Close did not)"). A short page-load limit
  around the presses (Close is a submit), the run's own limit put back. Not finished after Save = the window stays open.
  Tests: `unitedIndiaKycClose.test.js` (5); replica `resume`, `resume-kyc-done`, `kyc-new` (closed by its Close),
  `resume-close-stuck` (a Close without window.close() - closed by the run). 5 of 5 deliberate breaks caught.
- A later resume (KYC completed) still opens the CKYC window, finds it done and stops there - the payment is the next step.
- Tests: `unitedIndiaLogin.test.js` +2 (the step written / a failed write; the stop sentences). Replica: the CKYC window copied
  from the owner's screenshot (Customer Id, Result, Search / Close / Offline KYC / Online EKYC buttons), `resume-kyc-done`
  (Offline KYC disabled: NOT pressed, nothing entered or saved, the status in the log), and after Save the window shows
  "Offline KYC Done" with Offline KYC disabled (`resume`, `kyc-new`: "the KYC is done").

### United India: a resumed proposal's Policy Start Date = today; the portal's "Error In Data Entry" box stops the run (the owner, 2026-11-14)
A proposal made yesterday and opened again keeps yesterday as its start: United India then shows, at the top of the page,
`<div id="err"><div class="errorMsg"><ul><div class="errormsgbox">Error In Data Entry<ul><li> N002219, PolicyInception Date
should be on or later to Proposal Date .</li></ul></div></ul></div></div>`.
- **Policy Start Date** `#dateOfIssueOfPolicyString` (readonly calendar, `showCalender(this, 'dateOfIssueOfPolicyString',
  'polStartDateValidation','fuel')`) = **today, India time**, FIRST on the resumed page (before High Risk) -
  `unitedIndiaDates.js setPolicyStartToday`: put in by script (never clicked), the calendar's own check run as
  `polStartDateValidation('fuel')` (`putDate` / `setDateInPage` now pass a check argument), read back, once more, else `[E306]`.
  Date of Purchase is not changed (not asked).
- **The "Error In Data Entry" box** (`unitedIndiaNavigate.js throwIfPortalError`, `portalErrorsInPage`: shown `.errormsgbox li`
  lines) is looked for whenever a watched press goes quiet (Compute Premium, Update, Modify, Fetch, Save, after a refresh) and
  whenever a next page has opened (More Covers, Back, Next, Offline KYC), and after the start date: shown = `[E306]` not retried,
  "after "X" the portal says "Error In Data Entry - N002219, ..."", with the screenshot - never waited out as a slow portal.
- Tests: `unitedIndiaResumeStart.test.js` (4), Compute +1 (the box after Compute = E306 at once, no refresh), More Covers +1,
  handler order (start date before High Risk). Replica: the resumed page's real start-date box (13/11) + check, the server
  answering with the owner's box for a start before today, `resume-portal-error` (the box = E306 in its words, nothing after it).

### United India: the KYC - Modify, Update Ckyc (a new window), Offline KYC with the Aadhaar card, Save (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaKyc.js unitedIndiaKyc`. The policy's data FIRST: its Aadhaar number (`aadharNumber`, 12 digits) -
none / not 12 digits = `[E306]` not retried ("Add the Aadhaar number on the policy (Read Aadhaar & fill details)"), nothing
clicked. Never a made-up number.
1. **Modify** (a resumed proposal) `<img src=".../Modify.JPG" onclick="fnSubmit('update')" id="updt" name="updtimg">` - found by
   its picture, not by `id="updt"`. Its confirmation is pressed OK only when it reads like one (`CONFIRMATION`: GSTIN / proceed /
   modify / update / sure / confirm / continue); any other popup = `[E308]` in its words. The loader watched, 20 s, else `[E302]`.
2. The page's end, **Update Ckyc** `input[name=verifykyc]` -> `kycVerify(...)` opens a **NEW window** (CkycMandate): the click
   counts only when the window exists; the run switches to it (it stays there to the end) and waits for it to load (20 s).
3. **Offline KYC** `button[name=param][value=Offline]` (the next page, 20 s).
4. **Proof of Identity** `#proofOfIdentity` = "Aadhaar card", **Document No** `#documentNo` = the Aadhaar number, **Verification**
   `#origVerificationStat` = "Verified", **Same as above** `#sameAsAbove` ticked - each read back, all four again together.
5. **Save** `button[name=param][value=Save]` is `disabled` at first: pressed only once enabled (10 s, else `[E306]` not retried
   with the screenshot - United India wants another detail). Every popup after Save is pressed OK and its WORDS kept: they go into
   the stop ("- United India said "..."") - what comes after Save is the owner's next step.
- **Where it runs**: a resumed proposal after Compute Premium (Modify first); a NEW proposal right after Update when the page
  shows Update Ckyc (`ifShown`; none = the old stop "... (no Update Ckyc button on the page after Update)"). The Breaker
  `stopthis-location` is now after Save.
- The Aadhaar number shows only as `XXXXXXXX9012` in the log and the errors (`fillAndConfirm`'s new `mask` option).
- Tests: `unitedIndiaLogin.test.js` (32: the KYC in both paths, the stop sentences, the data check before any click, the
  owner's answers). Replica (real Chrome): Modify.JPG on the resumed page, Update Ckyc after Modify / Update, a REAL new window,
  Offline KYC, a Save disabled until all four are in, a "saved" popup - `resume`, `resume-paged`, `kyc-new`: Save posted
  Aadhaar card / the number / Verified / on, United India's words in the stop, the number never in full in the log; the replica's
  Save comes enabled 1.5 s after the last detail (so the wait for it is proved). Full replica 248 pass; 13 of 13 deliberate
  breaks caught.
- **Not seen live**: the Modify confirmation's words, whether a NEW proposal shows Update Ckyc right after Update, the CKYC
  pages (only the owner's markup), what United India answers after Save.

### United India: a proposal made before is OPENED again, never made again - Proposal Modification (the owner, 2026-11-13)
"The proposal is finished - how does it resume?" When the TP part's Proposal step is completed with its number AND Reference
Date (the run saves both; Edit -> Status asks both), the next run (`unitedIndiaTP.js`, `loadResumePlan` -> `planResume`, which
now also returns `referenceDate`) does, after the login:
1. Policy Transaction > **Proposal Modification** (`unitedIndiaMenu.js openProposalModification`; the owner's link
   `../motor/proposalModification.do?...parameter=proposalModify`).
2. **From / To Reference Date** = the saved date, both the same (`fromRefDateString`, `toRefDateString` - calendar boxes, put in
   by script, never clicked: `putDate`), **Fetch** (`input[name=fetch]`, loader watched, 20 s).
3. The list `table#data` (Select | Proposal Number | Reference Date | Insured Name | Total Premium): OUR number's row (exact) ->
   its radio `proposalOption`, read back. **The portal pre-selects the FIRST row** - Next is pressed only when the checked radio
   is ours and the only one (read again right before Next): never another customer's proposal. Not listed = `[E306]` not retried,
   naming what is listed ("Check the United India proposal number and its Reference Date in Edit -> Status"). Page links after
   the list (a link whose text is the next page number) are followed up to 20 pages - **their markup is not seen live**.
4. **Next** (`input[name=next]` - it has `id="updt"` like Risk Details' Update picture, so never found by that id) -> the
   proposal's page. Then (the owner, same day: "these changes must be done on a resume"): **High Risk "No" again**
   (`unitedIndiaInsured.js setHighRiskNo`), **More Covers N Info**, the TPPD Limit checked (only changed when it differs from the
   policy), the **PA Cover** set again, **Back**, **Compute Premium** - the same steps and rules as a new proposal.
5. Breaker `stopthis-location`, else the stop "... the proposal was made before, so it was opened from Proposal Modification (not
   made again), High Risk (No), More Covers N Info, TPPD Limit and PA Cover set again, back on Risk Details and Compute Premium
   done; what comes after (Update, the KYC) is not built yet - proposal N of DD/MM/YYYY". A completed proposal WITHOUT its
   Reference Date stops at once (`[E306]`, not retried: add the date in Edit -> Status).
- Tests: `unitedIndiaLogin.test.js` +4 (the resume order, no new proposal; the missing date; a fresh plan = the full form; the
  look-up checks and "ours only when it alone is checked"), `relianceStages.test.js` +1 (planResume's referenceDate). Replica:
  `resume`, `resume-paged`, `resume-not-listed` through the REAL handler (18 checks: From/To sent, ONE Fetch, Next sent OUR row
  `option 1` never the pre-selected 0, page 2 followed, High Risk "No" posted with More Covers, Back once, the stop + ONE
  screenshot; not listed = Next never pressed). Full replica 235 pass; 11 of 11 deliberate breaks caught.
- **Not seen live**: the page Next opens (assumed the proposal's Risk Details: High Risk, More Covers N Info, Compute Premium are
  looked for there), the list's paging markup, a "no records" answer (an empty list = `[E306]`).

### United India: a slow answer is never thrown away - the page-load limit = the time left, never 2 s (the owner, 2026-11-13, 4th)
The owner: "if I click the browser's refresh and then Compute Premium by hand it works - why not the automation?" Found in a real
Chrome (`scratchpad` probes, then the replica): **the run itself cancelled United India's answer.** Compute Premium SENDS the page
(live: `gc_ashokleyland1.do`); while United India works, the old page shows its loader. ChromeDriver holds every command until
that page arrives, up to the page-load limit, and when the limit runs out it **cancels the page**. The run waited with a **2 s**
limit (chosen earlier so a hung submit could not hold it for 300 s), so any answer slower than 2 s was thrown away: the old
page kept its loader up for good (his "loader spinning"), the refresh reloaded that old page, the second press was thrown away
the same way, then `[E302]`. His own click just waits. Probe: an answer at 6 s - under 2 s: cancelled at ~3 s, loader up
forever; under 20 s: the premium page at 6 s. (The refresh itself was fine.)
- **Now** (`unitedIndiaNavigate.js limitToTimeLeft`): while a step waits, the limit is **the time left of its wait**, set again
  before every look (at least 0.5 s): More Covers / Back 20 s, Compute Premium 15 s then 20 s, Update 15 s, the Quote PDF /
  Worksheet 40 s (`unitedIndiaQuote.js`). A slow answer is waited for; only one that misses the owner's time is cancelled -
  exactly when his rule says refresh / error. A click that itself waited for its page counts in the time (`startedAt`).
- While a look is held by a page on its way, a line every 5 s (`sayWhileHeld`, real timers):
  `   5 s after "Compute Premium": the page is on its way - United India is still answering` (More Covers: "the next page is on
  its way", the quote: "its file is on its way"); then `   the page changed 6.1 s after "Compute Premium" (.../gc_ashokleyland1.do)`.
- A loader that has already stopped when the time runs out gets its 2 s to prove it stays off (an answer at 14 s of 15 is done,
  not refreshed). `PAGE_LOAD_POLL_MS` (2 s) is gone.
- Tests: the fakes now act like ChromeDriver with a page on its way (held looks, cancelled past the limit): Compute +6 (6 s and
  14 s answers waited for; no answer -> cancelled AT 15 s, refreshed, the second press answered; a click that waits; a page sent
  late is cancelled at 15 s, not later), More Covers +5, Quote +2. 289 United India tests pass. 12 of 12 new deliberate breaks
  caught (+ the 17 before). Replica (real Chrome) `compute-submits-slow` (Compute sends the page, 6 s; the Quote PDF 6 s) and
  `morecovers-slow` (6 s): pass on the new code; **on the old code they fail exactly like his live run** (`posts 2`,
  `loader: block`, `[E302] ... still spinning 20 seconds after "Compute Premium" was pressed again`). Full replica 217 pass.
  `ONLY=a,b node test/manual/uiicReplica/loginCheck.js` runs just those scenarios.

### United India: Compute Premium and Update - press ONCE, WATCH the loader, refresh, press again (the owner, 2026-11-13, 3rd rule)
"I think there is some lag - only click the button and wait for the loader to stop; still spinning, then refresh, the loader
stops, click Compute Premium again; still not stopping in 20 sec, then the error - same for Update - and watch the loader
carefully, its start and whether it is loading." Replaces the two sections below.
- **One press, nothing else touched** (`unitedIndiaNavigate.js pressAndWatch` / `watchAfter`): the page's end, the button
  pressed once, the GSTIN question OK, then a look about every quarter second, said in the log:
  ```
  🧮 United India - "Compute Premium" pressed - watching the portal's loader (up to 15 seconds)
  ✓ United India - after "Compute Premium" the portal asked "GSTIN/UIN HAS NOT BEEN INSERTED. ..." - OK pressed
  ⏳ United India - the portal's loader is showing (div#dialog.window) 0.3 s after "Compute Premium"
     5 s after "Compute Premium": loader showing (div#dialog.window), page loaded
     the loader stopped 7.4 s after "Compute Premium"
  ✅ United India - "Compute Premium" done (the loader ran 7.1 s)
  ```
  plus "the page changed N s after ..." when the portal opens a new page. `portalBusyInPage` also looks inside the page's
  frames now. **Done** = the page loaded and the loader **off for 2 s** (a loader that blinks off for a moment is not done) -
  for Compute Premium after a loader was seen, or (no loader seen) after the press did something and the Update button is on the
  page; for Update when the Proposal Number is on the page.
- **Times**: Compute Premium **15 s**, Update **15 s**. Not done: `⟳ United India - 15 seconds after "Compute Premium" the
  portal's loader is still spinning - refreshing the page`, then **the refresh** (`unitedIndiaCompute.js refreshAndSettle`):
  the reload and the loader stopping together at most **20 s** ("the page reloaded in 2.4 s - watching the portal's loader"),
  then `after the refresh the loader has stopped - pressing "Compute Premium" again` - **20 s** for Compute Premium, **15 s**
  for Update (unless the refreshed page already shows the proposal: then Update is NOT pressed again).
- **Errors** (`[E302]`, retried later, screenshot): the refreshed page did not load / its loader did not stop within 20 s
  ("... after the page was refreshed it did not load within 20 seconds" / "its loader did not stop within 20 seconds"), or the
  second press still not done ("... 20 seconds after "Compute Premium" was pressed again (after a refresh)"). When no loader
  was seen the sentence says so instead of "spinning".
- **Proved in real Chrome (2026-11-13)**: a `refresh()` that meets its page-load limit is **stopped** by ChromeDriver - the old
  page stays and the portal's answer is thrown away (a 6 s reload under the clicks' 2 s limit). So the refresh runs under a
  20 s limit; the replica's stuck-page refresh answers in 3 s and is waited for.
- Removed: `clickAndSettle`, `updateOnce`, `waitForProposal`, `waitForButton`, `waitForPremium`, `refreshPage` (nothing used them).
- Tests: `unitedIndiaCompute.test.js` (17, incl. the 20 s refresh limit, the blink, the 5 s lines), `unitedIndiaProposal.test.js`
  (13); all 275 United India tests pass. Replica (real Chrome): 211 checks pass - the loader's start and stop said for both
  buttons, a Compute that never stops (refreshed, pressed again, [E302] at 15 s with 6 s limits), a stuck first Compute (slow
  3 s reload, pressed again, done), a stuck first Update (refreshed, pressed again, proposal saved). 17 of 17 deliberate breaks
  caught. Full suite: 1649 pass, 1 old failure (the two `reliance_captcha_*.png` files in the repo root).
- **Not seen live**: whether the post-Compute page's loader is `div#dialog.window` (his last log said "no loader was seen"
  while he saw it spinning) - the new lines will show what the run sees, second by second.

### United India: Compute Premium is done only when Generate Quote shows; 20 s, then refresh once (the owner, 2026-11-13) - SUPERSEDED, see above
His live run: after Compute Premium the loader went quiet for a moment and the next page (gc_ashokleyland.do) was there, so the
run called it done - but the portal was still working and **Generate Quote was not on the page** ([E301] "Generate Quote is not
on the page"). His rule: "the loader still running - refresh the page and click the button again; still loading, then the
error"; "only 20 sec, then refresh".
- **Done** = the Generate Quote button on the page AND the portal idle (its loader, its requests, the page's load) -
  `unitedIndiaCompute.js waitForPremium`; a quiet loader alone is no proof any more.
- **One try = 20 s** from the click (`COMPUTE_WAIT_MS`; the other steps keep 40 s). Still loading / no Generate Quote / nothing
  happened: the page is **refreshed** (F5 - proved in real Chrome that an automated Chrome sends the form again without the
  "Confirm Form Resubmission" question), and Compute Premium pressed **once more** (the GSTIN question OK again). Still not:
  `[E302] United India - after "Compute Premium" its loader was still running, also after the page was refreshed and Compute
  Premium pressed again (20 seconds each) - a loader issue at United India ...`. A popup is never refreshed away ([E308]).
- Tests: `test/unitedIndiaCompute.test.js` rewritten (13). Replica: Generate Quote / Worksheet / Update hidden until the premium
  is there; a first try whose loader never stops (refreshed, pressed again, on to the premium) and one that never stops at all
  ([E302] after the refresh): all pass. 6 of 6 deliberate breaks caught.

### United India: Compute 15 s -> refresh -> Update button 20 s; Update 15 s -> refresh + press again; Quote where it shows (the owner, 2026-11-13, after a 2nd live run) - Compute / Update parts SUPERSEDED (press-and-watch section above); the Quote part stands
His live run: Compute Premium went to gc_ashokleyland1.do, no loader was seen, and **Generate Quote never showed** (nor after a
refresh and a second press) -> [E302]. His rules:
- **Compute Premium** (`unitedIndiaCompute.js computePremium`): the GSTIN question OK; DONE = the **Update button** on the page
  and the portal idle, at most **15 s** (`COMPUTE_FIRST_MS`). Not done: the page **refreshed** (the form sent again) - Compute
  Premium is **NOT pressed again** - and the Update button waited for, at most **20 s** (`AFTER_REFRESH_MS`). Still not:
  `[E302] United India - 15 seconds after "Compute Premium" the portal was still loading, and after the page was refreshed the
  Update button did not come within 20 seconds - a loader issue at United India ...`.
- **Update** (`unitedIndiaProposal.js`): **15 s** a try (`UPDATE_WAIT_MS`), then refresh + Update pressed once more (never over
  a proposal the refreshed page already shows), 15 s; still not = [E302].
- **Quote PDF / Worksheet** (`quoteAndWorksheet` `ifShown`): taken where Generate Quote IS - before Update, else after Update; a
  page without the button = "no Generate Quote button after Compute Premium / after Update" in the log, not an error; never
  there = one warning line, the run goes on (the files are just not kept).
- Tests: `unitedIndiaCompute.test.js`, `unitedIndiaProposal.test.js`, `unitedIndiaQuote.test.js` (+2), `unitedIndiaLogin.test.js`
  (+1, the order). Replica: a stuck Compute whose refreshed page is the worked-out one (no second press), a Compute that never
  works out ([E302]), a stuck Update, and a page where Generate Quote / Worksheet only show after Update (taken there): all pass.
  7 of 7 deliberate breaks caught.

### United India: Update gets the same 20 s + refresh (the owner, 2026-11-13) - SUPERSEDED (press-and-watch section above)
"Update button click then also want to reload like thing." `unitedIndiaProposal.js updateOnce` / `updateAndSaveProposal`:
- **Done** = the Proposal Number on the page AND the portal idle (`waitForProposal`), at most **20 s** from the click
  (`UPDATE_WAIT_MS`).
- Still loading / no Proposal Number / nothing happened: the page is **refreshed** (`unitedIndiaCompute.js refreshPage`, now with
  the button's name for a popup's sentence) and Update pressed **once more** (the GSTIN question OK again) - **unless the
  refreshed page already shows the proposal**: the first Update finished meanwhile, a second press would make a SECOND
  proposal, so it is taken as it is ("the refreshed page already shows proposal N - Update is NOT pressed again").
- Still nothing: `[E302] United India - after "Update" its loader was still running / no Proposal Number came on the page, also
  after the page was refreshed and Update pressed again (20 seconds each) - a loader issue at United India ...`.
- Tests: `test/unitedIndiaProposal.test.js` (10). Replica: a first Update whose loader never stops - refreshed, pressed once on
  the new page, the proposal read and saved: pass. 5 of 5 deliberate breaks caught (one is the second press over a shown proposal).

### United India: Quote PDF, Worksheet, then Update = the PROPOSAL (the owner, 2026-11-13)
After Compute Premium (`unitedIndiaTP/unitedIndiaQuote.js`, `unitedIndiaTP/unitedIndiaProposal.js`); the Breaker is now after the
proposal is saved, and without the Breaker the run stops with "... Update pressed and the proposal saved, the KYC is not built yet
- proposal 202611131194829 of 13/11/2026".
- **Generate Quote** (`fnSubmit('quote')`) and **Worksheet** (`fnSubmit('worksheet')`, a new page): the page scrolled to its end,
  the portal ready, ONE click each, at most 40 s for the file. Taken whichever way it comes: a download (the job's browser saves
  PDFs straight to its folder - `ctx.downloadDir`, new in runHandler; a finished file, never a `.crdownload`), a new window with a
  PDF (fetched there with the same login), a new window with a page (printed to PDF; kept as the page `.html` when this Chrome
  cannot print), the same window (taken, then back). The worksheet window is closed, the run is back on the main page. Uploaded to
  S3 `proposals/united-india/` and saved on the policy as **`quotePdf`** / **`worksheetPdf`** - the View page lists them in Files
  ("Quote PDF", "Worksheet"; frontend + backend model).
- **Update** (`#updt`, `fnSubmit('update')`): the GSTIN/UIN question OK (read first), the loader at most 40 s. Then the
  **proposal** read off the page by its labels (the owner's markup): Proposal Number, Transaction NO (or the hidden
  `#transactionId`), Reference Date, Customer ID. No number = `[E301]`. Saved:
  - the part's **Proposal step = completed** with them (`relianceStages.<part>.proposal`, the Reliance/KSHEMA step helper worded
    United India; KYC and Payment back to pending) - History and Edit -> Status show it (the backend now gives United India parts
    their steps: `relianceStagesDao.js STAGED_INSURERS`);
  - `unitedIndiaProposal` { proposalNumber, referenceDate, transactionNo, customerId, at };
  - `proposalNumber` (the list) ONLY when the policy has none - on Reliance OD + United India TP it stays Reliance's.
  A write that fails never fails the run; the log then says the proposal was made at United India and to complete it by hand.
- **By hand** (Edit -> Status, both rule copies `shared/relianceStagesCore.js` = `lib/relianceStagesCore.js`, the frontend's
  `utils/relianceStages.js`): a United India Proposal is completed with ITS number - digits only, like 202611131194829 (a Reliance
  "R..." referral number is refused); it is kept on `unitedIndiaProposal`, `proposalNumber` only when empty. The dialog says
  "United India proposal number".
- **Not built (the owner will say)**: going straight to the KYC on a later run with the saved proposal - today a retry after the
  proposal makes a new one.
- Tests: `test/unitedIndiaQuote.test.js` (8), `test/unitedIndiaProposal.test.js` (8); backend `test/stagesByHand.test.js` +2 (in-memory
  MongoDB); frontend `StageStatusDialog.test.js` +2, `ViewOnlinePolicy.live.test.js` +2. Replica: a real quote download, a real
  worksheet window printed to PDF, Update with the real GSTIN confirm() and the owner's proposal markup read exactly: all pass.
  Deliberate breaks: automation 10 of 10, backend 3 of 4 (the 4th cannot change anything - the shared rule refuses first),
  frontend 4 of 4.

### United India: wait for the portal's loader before every step (the owner, 2026-11-13, after a live run)
His live run: the run's **More Covers click was lost** (he clicked it by hand; the run then saw the new page). His words: "the
loader opens for some time, then the click does not work - wait for the loader". His loader's markup:
`<div id="dialog" class="window" style="... position: fixed; z-index: 99999; ... display: block;"><img src="../resources/images/wait.gif"
alt="Loading..."> ... <span>Loading...</span></div>` - a SMALL fixed box (270 x 103), which matched none of the common loader
markers, so the run never saw it.
- `multiCompany/common/loader.js` "united india": **`#dialog.window` and `img[src*='wait.gif']`** added (the common markers stay),
  limit **40 s** (was 30). Every `waitForLoader(.., "united india")` now waits for it (after each choice's onchange too: the
  RTO's invoice zone, ...).
- `unitedIndiaSteps.js waitPortalReady` (`portalBusyInPage`): before EVERY box (`showOnScreen`): the portal's loader showing
  anywhere, or a page-wide layer drawn over the box (any name - what `elementFromPoint` finds there); before a SUBMIT button
  (More Covers N Info, Back, Compute Premium) also the page loaded and no jQuery request running (`jQuery.active`). At most
  40 s, then `[E302] United India - the portal was still busy before "<step>" after 40 seconds (its loader (div#dialog.window)
  is showing, 1 request still running) - a loader issue at United India ...`. The log says when it had to wait and for what.
- A click something COVERS is no longer pushed through by a script click: what covers it is logged ("is covered by <div ...>"),
  the portal is waited for, and it is clicked again for real.
- While the page has not changed after a submit button, a line at 5, 10 and 15 s says what the run sees (submit started, page
  load seen, loader, requests running).
- Tests: `test/unitedIndiaPortalReady.test.js` (11). Replica: the owner's real loader box over the button (Compute Premium 3 s;
  the RTO's invoice zone 4 s + a request 6 s - More Covers then clicked ONCE, posted once) and an unknown page-wide layer: all
  pass. **With the old behaviour put back the replica reproduced his live case**: the first More Covers click lost, the
  Compute Premium loader "waited 0 ms", a loader that never stops gave no error. 9 of 9 deliberate breaks caught.

### United India: Back, then Compute Premium (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaCompute.js` `backAndComputePremium`, after the PA Cover; the Breaker is now after it.
- **Back** `<img src="...Back.JPG" onclick="fnSubmit('back')">` on the More Covers page: the portal goes back to Risk Details
  (20 s, else `[E301]`).
- The page is **scrolled to its very end** (the owner), then **Compute Premium** `#compute` (`fnSubmit('computepremium')`).
- **The GSTIN/UIN question** ("GSTIN/UIN HAS NOT BEEN INSERTED ... Do you want to proceed? If Yes, Click On Ok. If No, Click on
  Cancel to update GSTIN/UIN.") is a confirm(): **OK** is pressed (the owner). It is read BEFORE anything else touches the page:
  ChromeDriver closes an open popup with CANCEL as soon as another command meets it (= "update GSTIN"). Proved with a real
  confirm() in real Chrome. Any OTHER popup is the portal's answer: `[E308]` in its words, closed with Cancel (nothing
  unexpected goes ahead).
- (The loader, second-click and `clickAndSettle` bullets below are replaced by "Compute Premium and Update - press ONCE, WATCH
  the loader" above.)
- **The loader**: the premium may come on the same page behind the portal's loader. Waited for while the page loads or the
  loader is up; done when it has been gone for 1 s. **At most 40 s** (the owner): `[E302] United India - after "Compute
  Premium" the portal's loader was still running after 40 seconds (a loader issue at United India), so the run stopped there.
  It will try again shortly.` with the screenshot. The log says how long it ran ("the portal's loader ran 3.1 s").
- No sign at all 5 s after the click (no question, no loader, no page): clicked once more; still nothing = `[E301] ... was
  clicked twice but nothing happened`.
- **One page change for every submit button** (`unitedIndiaTP/unitedIndiaNavigate.js`): `clickToNextPage` (More Covers N Info,
  Back) and `clickAndSettle` (Compute Premium) share the page mark, the single click, the 2 s page-load limit while waiting (NOW the
  time left - see "a slow answer is never thrown away"),
  `window.stop()` on a timeout, and popups read first (`onPopup` says which is a step of the flow).
- Tests: `test/unitedIndiaCompute.test.js` (11; the fake closes a popup with Cancel when another command meets it, like
  ChromeDriver). Replica: Back posted once, the real GSTIN confirm() answered OK, the loader (3 s) waited for and the premium
  shown, "Please select the Zone" = `[E308]`, a loader that never stops = `[E302]` (6 s limit there): all pass. 10 of 10
  deliberate breaks caught.
- **Not seen live**: the portal's loader markup after Compute Premium (`loader.js "united india"` looks for blockUI, #loading,
  #loader, .loading, .loader, a loading image, .spinner-border) - if it is something else, the run would not see it and
  would carry on as soon as the page is quiet. The page after it (the premium) is not read yet.

### United India: the PA Cover on the More Covers page (the owner, 2026-11-13)
`unitedIndiaTP/unitedIndiaPaCover.js` `fillPaCover`, after the TPPD Limit; the Breaker is now after it.
- **PA bought with United India** (`paCover` on for this part - lib/partRunner.js gives it only to the part that buys the PA - and
  not Brisk's, read from `settings.PACompany`; the same reading as National's TP, `nationalTP/tpPa.js`):
  `#ynPAcover` ticked (never clicked when ticked already; disabled = a stop), then **CPA Cover** `select[name="cpaCover"]` = the
  policy's `paCoverYears` (1 or 5 - the Online Policy asks it, no default; the backend refuses another), **Nominee Name**
  `#nomineeName` (letters and spaces, upper case, 100 max) and **Relation** `#rltnshpstat` (the form offers United India's own 17;
  "GRAND-SON" as saved = "Grand-Son"; one not offered stops listing what it offers). All read once more at the end.
- **Otherwise** (no PA, or Brisk's certificate): `#ynPAcover` ticked and unticked again - its `checkdriv('1')` then shows the
  **Owner-Driver CPA** question - and `select[name="ynOwnerDrivCpaOpt"]` = **No** (the owner's steps). Brisk's nominee is never
  typed at United India.
- The policy's year / nominee / relation are checked before the page is touched (one sentence, not retried).
- Tests: `test/unitedIndiaPaCover.test.js` (13). Replica: the owner's markup with a `checkdriv()` that shows the PA fields when
  ticked and the Owner-Driver CPA question after an untick, `checkfun2()` recorded: PA with United India (5 Year, DEVA K,
  Grand-Son, the question untouched) and none (ticked + unticked, "No"): all pass. 12 of 12 deliberate breaks caught.
- **Not seen live**: whether the portal shows the Owner-Driver CPA question only after an untick (the owner's steps say so), and
  whether a 5-year PA changes the premium United India quotes (the Online Policy's PA amount is not changed by the year).
- Frontend / backend (same day): the form asks United India's 17 relations and the year (1 or 5, no default); the server
  refuses another year (frontend README "United India", backend README §25).

### United India: every box in the middle of the screen, for the run's video (the owner, 2026-11-13)
"The field filling goes below but the screen does not scroll, so the video does not show it." `unitedIndiaSteps.js`
`showOnScreen` (`centerInPage`) runs before every box the run **fills, chooses, clicks, checks or waits for**: the choice the
portal already shows (Client Type Individual, Title Mr), the Year it already shows, the Date of Purchase, and the District
while it is waited for after the Pin Code. (Before, only a click / a first choice / typing scrolled, and a box that was only
checked or waited for stayed off the screen.)
- **`behavior: "instant"`**: the old call followed the page's own scrolling, and with smooth scrolling (Bootstrap - the portal's
  classes are Bootstrap's - turns it on for the whole page) the boxes were typed into while the screen was still on its way:
  the real-Chrome replica measured the Year and the Address 1,100 - 2,000 px BELOW the screen. Now every box ends in the
  middle (0.50 of the screen's height, measured).
- A box still not on the screen after that: the window itself is scrolled to it.
- **0.2 s pause only when the screen really moved** (40 px or more), so the video shows the box before it changes; a box
  already in the middle costs nothing.
- Scrolling trouble never stops a run; a popup (`[E308]`) and a Hold / Breaker stop always go on up.
- Tests: `test/unitedIndiaOnScreen.test.js` (9). Replica: a TALL page (1,100 px between the groups) with
  `scroll-behavior: smooth`: the Year (only checked), the Address and the District (only waited for) are in the middle. 10 of
  10 deliberate breaks caught, plus the real-Chrome one (the old scroll with smooth scrolling -> boxes far below the screen).

### United India: a screenshot for every error and every stop (the owner, 2026-11-13)
"Every error want to take the screenshot."
- **Errors** already got one (`multiCompany/common/runHandler.js` -> `screenshot.js captureFailure`, one per attempt, S3
  `screenshots/multiCompany/united_india/`, shown under the policy's Issues).
- **Stops** now get one too: the Breaker (`stopthis-location`) and "the rest of the TP form is not built yet". `runHandler`
  option `screenshotOnStop`, **on for United India only** (`unitedIndiaTP.js`); Reliance OD and the login-only handlers are
  unchanged. A **Hold** never takes one (the operator's own choice). Console: `📸 [job] united india TP - screenshot of the page
  at the stop saved`.
- **A portal popup open at the picture**: Chrome refuses the first try (and closes the popup as it says so), so it is taken
  ONCE more; the popup's words go to the console. Before, such an error had no picture. This is `captureFailure`, so it holds
  for every runHandler company (only ever one extra try, only for that error).
- **Still no picture**, because no page exists yet: errors before the window opens (no portal login E205, the feature gate
  E110, the part runner's data checks). A job timeout (E302) has the stall watch's picture only when the page went quiet.
- Tests: `test/unitedIndiaScreenshots.test.js` (9), `test/unitedIndiaRisk.test.js` (now 33). Replica
  (`test/manual/uiicReplica/loginCheck.js`, S3 replaced by an in-memory fake): late manufacturer list, Model not in the list,
  a real `alert()` open at the picture, the handler's stop and error pictures (real PNGs): 65 of 65 pass. 15 of 15
  deliberate breaks caught in a scratch copy, plus the real-Chrome one (no retry -> no picture with a popup open).

### Reliance's Appointee Name: only for a nominee under 18 (2026-11-11)
The owner: on the Online Policy a Reliance nominee may now be under 18 (no 18+ limit on the Nominee DOB), and the Appointee
Name is required only then; for the automation, "type it only if under 18". `fullPolicycompany/reliance/relianceAppointee.js`
(`fillAppointeeIfMinor`), called from the nominee block of `relianceForm.js` (and the generated `relianceMultiForm.js`, which
got its require-path rule in `relianceMultiFormSpec.js`):
- the age is counted on today's date in India from the job's Nominee DOB (`DD-MM-YYYY`); 18 on the birthday itself;
- **18 or older: the Appointee box is not touched**, even when the policy carries a name; an unreadable date: left alone too;
- **under 18**: the policy's Appointee Name is typed (value + input / change / blur) and read back, once more if it did not
  take. No name on the policy, Reliance's box not there or not visible after 8 s, or a box that never holds the name: a
  deliberate stop with one sentence (not retried). Before: it was set by script whenever the policy had one, never checked.
- Tests: `test/relianceAppointee.test.js` (8); 7 of 7 deliberate breaks caught. Not seen live: whether Reliance shows the
  Appointee box only for an under-18 date of birth (the step waits up to 8 s for it either way).

### United India's Makes and Models: collected once, then removed (2026-11-06)
For one afternoon the automation filled the Vehicle Model lists itself: every policy run saved the Vehicle Manufacturer list
and the Make list it saw (insert only), and a temporary collect mode (`COLLECT_MAKES_AND_MODELS_ONLY` in `unitedIndiaTP.js`,
plus `scripts/unitedIndiaCollectModels.js`) chose every manufacturer one by one and saved its Make list. It filled
**727 Makes and 6,304 Models**, with no duplicates. Then the owner said "now all make finished, remove the code of model
getting", and chose to remove the per-run saving too. **All of it is gone**: `lib/insurerCatalog.js`,
`unitedIndiaCollect.js`, the script, `models/InsurerMake.js` / `InsurerModel.js`, and their tests and replica scenarios.
A United India run now only **reads and picks** the exact names. The lists are kept by hand on the Vehicle Model page
(backend README §25.1).

### A kept window is cleaned up when you close it (every company, 2026-11-06)
`lib/retainedBrowser.js`. A window left open on purpose (`KEEP_BROWSER_OPEN_ON_ERROR=true`, or `CLOSE_BROWSER_AFTER_COMPLETE=false`)
used to keep its profile (100-200 MB) until the next restart.
- **Who**: Reliance `sessionManager.js`, National `nationalSessionManager.js`, KSHEMA `kshemaSessionManager.js` and United India
  `unitedIndiaSession.js` all hand the kept browser to `watchRetainedBrowser`.
- **How it checks**: every 5 s it asks Chrome for its windows (`getAllWindowHandles`). An alert or a busy page is not "closed".
- **When it is closed**: once no window is left or the session is gone, it ends the chromedriver session and deletes **that job's
  own** folders (Reliance's download folder too).
- **Two windows**: a folder is deleted only through `lib/jobDirs.js`, so it never removes a folder another running job still
  holds. Closing one window never touches the other's data.
- **Timer**: it never keeps the process alive. A restart still wipes every profile folder.

United India's profile folder name has no spaces any more (`united_india_job_tp_united_india_<name>_...`). Git ignores every
`cloned_profiles*/` folder.

**Tests**
- `test/unitedIndiaSteps.test.js` (18).
- `test/retainedBrowser.test.js` (11).
- `test/unitedIndiaLogin.test.js` (now 25).
- `test/manual/uiicReplica/loginCheck.js`: 25 real-Chrome checks, all pass. They cover the menu with a swallowed click and an
  already-open menu, and two real kept windows closed one after the other.
- 19 of 19 deliberate breaks caught in a scratch copy.

The real-Chrome check also found that selenium-webdriver for Node has `getAllWindowHandles`, not `getWindowHandles`. Fixed before
anything shipped.

**Not seen live**: the page after Make New/Renew Policy (its address, `#selectProduct`), and the error chromedriver gives when a
person closes the window by hand. The replica closes it through WebDriver, and the watcher accepts the known wordings.

### Reliance Make & Model collector (2026-11-14)
The owner asked for the United India idea again, for **Reliance**: search each Make in Reliance's Make/Model box, read every
suggestion, save the Models. Run by hand, not part of the server, **no .env switch**:

    node scripts/relianceCollectModels.js --policy <onlinePolicy id> HONDA HERO SUZUKI YAMAHA BAJAJ

- It uses that policy's customer and the Reliance login of its user / client (the normal resolver), walks the normal flow
  (login, Motors -> Two Wheeler, product, Skip To Main Page, vertical code, Form 60, Validate Customer) and, at the
  `VehicleDetailsMakeModel` box, hands over to the collector: one hook line in `relianceForm.js` (`data.collectMakeModels`, a
  normal run has none), then `fillRelianceForm` returns and the window closes. Nothing is chosen, calculated, saved or paid at
  Reliance. The run's data carries NO `_id` / `policyId` / `_jobId`, so it cannot read or write the policy's payment note,
  stages or files.
- A suggestion is `HONDA | unicorn | 160` (the owner's example): the Make is the part before the first bar and is NOT in the
  Model; the other parts are joined with one space, no bar is saved -> Model `UNICORN 160`. The line's own Make is saved
  (searching `hero` also finds `HERO HONDA`, saved under that Make); a line of another Make or with no bar is NOT saved and is
  listed with its reason. Rules and parsing: `lib/relianceModelCollect.js` (`parseOption`).
- Insert only, straight into MongoDB (`insurerMake`, `insurerModel`, company `Reliance`, `source: "automation"` = "Policy run"):
  the Make first, then its Models; a name already there is skipped, never updated. `portalValue` keeps the line as Reliance
  printed it. Reliance has no Variants: `insurerVariant` is never touched. Run it again any time: only new names are added.
- The list is read to its end: the suggestion list is scrolled down step by step (Kendo lists draw or load more as they move)
  until two reads in a row bring nothing new. The box is emptied after each Make.
- **First live run (2026-11-14) and the fix**: Reliance fills the suggestion list a moment AFTER the typing, and the old list stays on
  screen meanwhile - SUZUKI, YAMAHA, BAJAJ each read HONDA's 680 lines again (nothing saved, every line "not a SUZUKI one"), and
  HERO read the HONDA list too. The collector now closes the old list first, then reads only when EVERY line shows the typed
  Make and the list has held still for two looks (700 ms apart); a list that never becomes the new search is reported as
  "listed nothing". Rows saved by that run (HONDA 525, HERO HONDA 151, model text like `ACTIVA 125 CC/WATT 125`) are valid and
  stay; a re-run skips them and adds only what is new - the model text is built exactly as before (owner: no duplicates on re-run).
- **Top first (owner, same day)**: a new search can open its list where the old one was left (scrolled down), and the lines above
  were never read. After the new list is there the collector scrolls it back to the TOP, lets the first lines draw, reads them,
  then walks down. A test starts the list 40 lines down and needs all 60 lines; it fails without the scroll.
- **Makes with one word (owner, same day: "hero, hero honda, hero motocorp - three are different")**: a search saves ONLY the
  lines of exactly the make that was typed (`hero` -> HERO's own lines; HERO HONDA and HERO MOTOCORP lines in that list are
  counted by make in the log, "lines of other makes, not saved by this search", not saved). Each make is asked for by name on
  the command, one search each: `... HERO "HERO HONDA" "HERO MOTOCORP"`. The same model name under two makes is two rows. (An
  earlier version of the same day saved the longer makes found inside a `hero` search and searched them again by themselves;
  the owner's rule replaced it.) The log prints per search "makes in this list: ...".
- **The Reliance run itself** (`selectKendoAutocomplete`, both `relianceForm.js` and the generated `relianceMultiForm.js`):
  a suggestion is compared with the bars and extra spaces taken out of BOTH sides (`HONDA | UNICORN | 160` matches the
  policy's `HONDA` + `UNICORN 160`), and when the whole "make model" text finds nothing, attempts 2 and 3 type the Make alone
  and pick the line by its model words (logged). Before, a line with bars never matched and the first suggestion was taken.
- Frontend: the Make & Model dialog picks Reliance's Make, then Model, from these lists like United India (no Variant); the
  amber note for a name not in the list says "Reliance may not find it" (the Reliance run does not stop on it).
- Tests: `test/relianceModelCollect.test.js` (19: parsing, insert-only save with a fake database, a 59-line virtual list read to its
  end with a fake driver, the run data, the script's arguments); 11 of 11 deliberate breaks caught in a scratch copy. Also
  checked in real headless Chrome on a local page with a 142-line virtual list (all read, other makes' lines listed, box emptied).
  Frontend: 63 + 28 tests in the touched folders.
- **Not seen live**: Reliance's real list (is it capped? is a line always `MAKE | ... | ...`?). The script prints, per Make, the
  lines read, new / already there, and every line it did not save with its reason; the first run with 2-3 makes shows it.

### KSHEMA Make / Model / Variant collector + the Pin Code toast (2026-11-14)
**1. "Could not compute the premium" after the Pin Code (owner's live run, job ANMOL).** KSHEMA's own rater says it while the CUSTOMER
DETAILS are filled (there is no vehicle yet); `kshemaSection.js` read it as the Pin Code being "rejected" and the run stopped. Now
that ONE message, in the customer details only (`BENIGN_FIELD_TOASTS`), is logged (`ℹ️ KSHEMA said ... not counted`) and ignored. Every other
toast still rejects the field, the same message in the vehicle / PA / premium sections still does, and `classifyToast` and the Save-time
checks are unchanged (a premium refusal at Save stays a refusal). Both quote forms share the code (one edit).

**2. The collector** - run ONCE by hand, not part of the server, no .env switch:

    node scripts/kshemaCollectModels.js --policy <onlinePolicy id>                          every make in KSHEMA's Make dropdown, 10 windows
    node scripts/kshemaCollectModels.js --policy <onlinePolicy id> --windows 5 HONDA "TVS MOTOR COMPANY LTD"   only these makes (exact portal names), 5 windows

- It walks the normal flow (login, Two-Wheeler, customer details of the quote form of that policy), sets "Is New Vehicle?" to Yes (the portal
  shows Make / Model / Variant only then) and then, strictly: **pick a make -> read ALL its Models -> save the Make and its Models ->
  for each Model in turn: pick it -> read ITS Variants -> save them -> the next Model -> when the last Model is done, the next make.**
  Nothing else on the form is filled, Save is never pressed, nothing is written to the policy (the run's data has no `_id/policyId/_jobId`).
- Reading a dropdown (`lib/kshemaModelCollect.js readOptions`): the list is read as it shows; a panel that is EMPTY until typed (Make /
  Model have a search box) is read by typing A-Z and 0-9 and joining the answers; the list must hold still for two looks in a row
  (a list still being replaced is not taken); every pick is exact (`selectMatOption` with `fuzzy:false`, read back) - a make the portal
  shows under another name after the pick stops the walk before it reads the wrong list.
- Insert only into `insurerMake` / `insurerModel` (shared `saveModels`) and `insurerVariant` (`saveVariants`): company KSHEMA, `source:
  "automation"` ("Policy run"), a name already there is skipped. It saves after every model, so a stop loses nothing; a make with no models and
  a model with no variants are counted and logged, not errors. Typed makes that KSHEMA does not have are reported with names like them.
- The only edits to the working KSHEMA flows: the inert hook (`typeof data.collectMakeModels === "function"`, after the customer details, before
  the vehicle) in `kshemaForm.js` AND the identical block in `kshemaTPForm.js` (its sync guard needs it; `kshemaTP.test.js` counts 9
  quote-form requires now), two additive exports in `kshemaFields.js` (`collectOptions`, `searchInPanel`), and the benign-toast line. A queued
  job carries plain data from the database, never a function, so a normal run skips the hook.
- Tests: `test/kshemaModelCollect.test.js` (14: the walk order, all makes / typed makes, empty-until-typed list, stale list, insert-only
  second run, error sentences, the script and the hook never touching a normal run) + 1 new in `kshemaSection.test.js`; 12 of 12
  deliberate breaks caught in a scratch copy; also run in real headless Chrome with the REAL KSHEMA dropdown helpers
  (`selectMatOption`, `collectOptions`, `searchInPanel`, the real Make / Model / Variant locators) against a replica Angular-Material page
  (Make list at once, Model list empty until typed, Variant list per model): 11 of 11 variants, no wrong row. Full suite: only the old
  captcha-file failure.
- **Not seen live**: KSHEMA's real lists (does the Make list show before typing? how long are the lists? the exact Model / Variant text), whether a
  filled Make / Model select is found again by the same locators (the replica has the `mat-label` the third locator needs - the real page
  was never looked at), how long the whole walk takes (every model is one pick + one read; hundreds of makes can take hours), and whether
  the session stays logged in that long. Run it for ONE make first and send the log.
- **Several windows (owner, same day: "too slow - 5 screens, then 10 screens, a make must not be done on two screens")**:
  `--windows N` (1-10, default **10**), each window opens its own Chrome, logs in (3 s apart) and walks the SAME way, but all take their next make from ONE
  shared queue (`createWorkQueue`): a make is done by exactly one window; with typed makes the windows are at most that many. Windows run
  **headless** (this run only, the .env is not touched) unless `--show`. A make that fails (portal shows another name, a list that did not open ...) does not stop
  the window: it is put back ONCE for another try, then listed under "Makes that failed (run the script again for these)"; a window
  whose last 3 makes all failed stops (the session is probably gone). Every model line and every make now prints its seconds, so the
  next log shows where the time goes. Waits were trimmed (400 ms after a pick, 250 ms between the two stable looks, 150 ms after closing a list).
  Real Chrome check: 5 headless windows on the replica, 10 makes, each picked once, 60 of 60 variants, no wrong row. **Not known**: whether KSHEMA
  lets one login be used in 10 windows at once (production already runs 2) - if windows drop out, use fewer (`--windows 4`); memory (about 0.3-0.5 GB per
  headless window; 10 windows need several GB free - this machine had about 5 GB free).
- Frontend: the Make & Model dialog picks KSHEMA's Make, Model and **Variant** from the saved lists (`InsurerVariantField`, the Variant
  follows the Make + Model; National keeps typed boxes). Note wording for KSHEMA: "KSHEMA picks the closest name, which may be another one".

### Pincode & Locality: saved by the KSHEMA run (2026-11-14, owner's request)
When KSHEMA's "Pin code Locality" dropdown opens in the customer details, **every locality it lists is saved** in the
`pincodeLocality` collection (backend README §39) - on a match AND on "none of ... was close enough" (the list is read
before any matching). Insert only: a name already saved is skipped, never updated, never duplicated. Both flows (full + TP)
share the code.
- `lib/pincodeLocalitySave.js`: `saveLocalities(db, {pincode, names, company})` (clean + de-dupe, at most 200 names of 150
  characters per call, pincode must be 6 digits, `insertMany(docs,{ordered:false})`, E11000 = "already there") and
  `rememberLocalities` (what the field calls: uses the server's open Mongo connection, none = quiet nothing, never throws,
  waits at most 3 s, one log line `📍 Pin code 604203: N new locality name(s) saved (M already saved)` or one `⚠` warning).
- `kshemaFields.js` `selectMatOption`: new optional `onOptionsRead(texts)`, awaited once after the list is read, inside a
  try / catch; absent = nothing changes. `kshemaSection.js` `fillByType` passes it for the `locality` field ONLY. The two quote
  forms (the drift-guarded pair) are NOT edited.
- Not saved when the dropdown already holds the right value (it is not opened then). A hand-run script (no open connection) saves nothing.
- Tests `test/pincodeLocalitySave.test.js` (17); 6 deliberate breaks caught in a scratch copy. Not run on the live portal: KSHEMA's real option
  texts (may carry S.O / B.O markers - saved as shown). No `.env` switch.

### National login: the two account-type lists, each found by its own label (2026-11-14, owner's request)
The portal's login page has **User Type** (`#userGroupLabel`: CUSTOMER / INTERMEDIARY / BD OFFICIALS) and, once INTERMEDIARY is chosen, a second
list **Intermediary Type** (`#intermediaryTypeLabel`: AGENT ... BROKER POSP ... WEB AGGREGATOR), then Login ID (`log_txtfield_iUsername_01`, at most 26
characters) and Password (`log_pwd_iPassword_01`). **Cause of the failure:** all three login copies found BOTH lists with one locator (`reg_dropdown_iType_02`
/ `#mat-select-4` / the first `mat-select`), so the second pick re-opened the User Type list, "BROKER POSP" was not in it, the miss was only logged, and the run
failed later at the password / "still on the login page" with no reason.
- New `fullPolicycompany/national/nationalLoginForm.js` (the one place): each list is found by `mat-select[aria-labelledby~=<its label>]` (then the label's own
  form field; only if the label is not there, by its place among the page's lists - with a warning in the log), opened, the option clicked **from that list's own
  panel** (`aria-controls`), and the shown value **read back**; one retry; the second list is waited for (15 s) because it is drawn after the first choice; an
  already-right value is not clicked. Login ID and Password are typed and read back (one retry); a mismatch names the LENGTHS and the portal's limit, never the text.
- Errors are sentences without a colon: `National login - BROKER POSP was not one of the choices for "Intermediary Type" (the portal offered AGENT, BROKER, ...)`,
  `... the "Intermediary Type" list did not appear after choosing the User Type ...`, `... the Password box holds 26 characters instead of 45 (the portal box keeps at most 26)`,
  `... the saved login has no Password`. Used by `national.js`, its TP copy `nationalTPForm.js` (identical lines; the sync test maps the helper's require path) and
  `multiCompany/common/login/nationalLogin.js` (a miss = retryable E306).
- Tests `test/nationalLoginForm.test.js` (20, a fake page); 7 deliberate breaks caught in a scratch copy (incl. the old one-locator bug: 8 tests fail).
  **Not run on the live portal** - the first live run should show `✓ User Type set to INTERMEDIARY` and `✓ Intermediary Type set to BROKER POSP` (or the warning "found by its place").
- **Filling started too late (2026-11-14, same day).** The log stopped right after "Navigation successful!" because the code first waited up to **30 s** for the Login ID box (`log_txtfield_iUsername_01`) before touching any list, and that box can be drawn only after the lists are chosen - so the 30 s was lost on every run. Now `waitForNationalLoginForm` (in `nationalLoginForm.js`) is ready as soon as the form's first control shows (the User Type list), logs `✓ National login form ready, the User Type list showed after N s`, and the Login ID box is waited for AFTER the lists (`waitForLoginBox`, 20 s, named error). Every list pick logs the seconds it took. The multi-company login got the same (`fields.ready` in `runLogin.js`, optional, other insurers unchanged). 8 more tests in `test/nationalLoginForm.test.js`, 4 breaks caught. Not run on the live portal: read the new timing lines in the first run's log.
- **"stale element reference" killed the login (owner's live run, job ANMOL, 2026-11-14).** The portal draws the form again right after its loader clears (and when a choice adds the next list), so an element found a moment earlier is replaced. Now every step of `nationalLoginForm.js` (both lists, Login ID, Password, Login button) looks its element up AGAIN and redoes the step on a stale element (`↻ National login - the page redrew the "User Type" list, looking for it again (1/3)`, up to 4 tries, then `the page kept redrawing ...`, never the raw message). After both lists are chosen they are read again (`✓ Both lists hold INTERMEDIARY and BROKER POSP`); a list that lost its value is chosen once more. The Intermediary Type list is also found by its own name `reg_dropdown_iType_02` (from the owner's HTML). The Login button is clicked only once it is enabled (named error if it stays disabled: the form did not accept the boxes). 12 more tests (80 in total in the two National test files), breaks caught in a scratch copy.

### National RTO locations + Make / Model / Variant collectors (2026-11-14)
Two hand-run scripts (run ONCE, no .env switch, nothing quoted or saved at National, nothing written to the policy):

    node scripts/nationalCollectRtoLocations.js --policy <onlinePolicy id> [--show]          National's RTO Location list -> the RTO City Location master
    node scripts/nationalCollectModels.js --policy <onlinePolicy id> [--windows N] [--show] [MAKE ...]   Makes / Models / Variants, 10 windows (1-10)

- Both walk the normal National flow (login, Calculate Premium, vehicle type, plan, class) and stop at ONE inert hook in `national.js` (and its
  identical twin in `nationalTPForm.js`, which the TP sync guard needs): `typeof data.collectMakeModels === "function"`, placed after the class and
  before the RTO box, no field names inside (the portal's input names live in `lib/nationalModelCollect.js NAMES`, so the TP token guards are
  untouched). A queued job carries plain data, never a function. Windows run headless unless `--show`; the National login needs its address
  (`loginUrl`) saved and the policy needs an RTO city (one plain sentence each before any window opens).
- National's RTO / Make / Model / Variant are mat-autocomplete TEXT inputs. `readAutocompleteOptions` reads the list that opens at once (scrolled to its end, two
  agreeing looks) or, if the box shows nothing until typed, by A-Z and 0-9; `pickAutocompleteExact` types the exact text and clicks the option whose text
  EQUALS it (never "contains", never the portal's "click the first option" fallback `selectAutocompleteOption`) and reads the box back.
- **RTO locations** (`lib/nationalRtoCollect.js`): "Chennai - West" -> city CHENNAI + region WEST (split at the FIRST " - "); no " - " -> the whole text is the
  city, region blank. Each row gets an auto-made code, NATIONAL + city + region, letters and digits only (`NATIONALGURGAONNCR`), editable on the page. Insert only
  into `RTOCityLocation` with `company "National"`, `source "automation"`, `portalText` (the option as National writes it); never a zone, never the Pincode
  Locality master; a re-run skips a row with the same code OR the same National text (so an edited code does not make a second row).
- **Make / Model / Variant** (`lib/nationalModelCollect.js`): same walk and shared queue as KSHEMA (`createWorkQueue`, `newTotals`, `saveVariants`, `CollectError` are reused from
  `lib/kshemaModelCollect.js`): the policy's RTO is picked first (Make opens only after it), then each window takes the next make nobody has taken: pick the make ->
  read ALL its Models -> for each Model in turn: pick it, **then** save it, read its Variants, save them -> next model -> next make. A failed make is put back once, then listed;
  a window whose last 3 makes failed stops. Timings on every line.
- **A bug the real-Chrome replica found (fixed in BOTH collectors)**: after a make is picked the portal can keep showing the PREVIOUS make's model list for a moment; the
  first version read that list and saved the models under the wrong make (21 wrong rows on the replica). Now a model is saved only AFTER the portal accepted picking it
  under that make, and a Model list identical to this window's previous make's is read again every 0.7 s until it changes (6 s, else that attempt fails with one plain
  sentence and is retried); a Variant list identical to the previous model's gets 2.5 s (it can legitimately be the same - "STD"). `lib/kshemaModelCollect.js` got the same
  two safeguards (its saved-models order changed: Make + Model, then that model's Variants, then the next model).
- Tests: `test/nationalModelCollect.test.js` (23), `test/nationalRtoCollect.test.js` (10), shared fake page `test/nationalFakePage.js`; `test/nationalTP.test.js` stays green with the
  identical hook; real headless Chrome on a replica (5 windows, 12 makes incl. HONDA vs HONDA MOTORS, a 1.2 s lagging model list): every make once, 62 of 62 variants, 0 wrong rows;
  the KSHEMA replica was rerun after the port (60 of 60). **Not seen live**: whether Make / Model / Variant open at once or only after typing, whether they depend on RTO or
  plan, the option text formats, how long it takes, and whether 10 windows on one National login hold (production runs 2) - run `--windows 1` for ONE make first.

### National's SECOND list: "Not able to Find the required Model & Variant" (2026-11-14)
National's quote form has a checkbox "Not able to Find the required Model & Variant" (`isNonGICSelected`); ticked, the portal offers a DIFFERENT set of make / model / variant (and a
Manufacturer's Selling Price box). The owner wants that set collected too, kept apart from the normal one (his choice: **three new separate lists, no database change**):

    node scripts/nationalCollectModels.js --policy <onlinePolicy id> --not-found [--windows N] [MAKE ...]
    node scripts/nationalCollectRtoLocations.js --policy <onlinePolicy id> --not-found

- `--not-found` only puts `modelNotFound: true` in the run data. The NORMAL flow already ticks that box (`national.js` / `nationalTPForm.js`, `data.modelNotFound`) BEFORE the collector hook, so the hook,
  the TP sync guards and the flows are not touched. The MSP step comes after the hook, so no selling price is needed. The collector then reads whatever lists the portal shows and saves them into
  `insurerMakeNotFound` / `insurerModelNotFound` / `insurerVariantNotFound` (`lib/nationalModelCollect.js` `LISTS` / `listsOf`; `saveModels` and `saveVariants` got an optional collection name whose
  DEFAULT is the old one, so KSHEMA / Reliance / the normal National run are unchanged). The same names (HONDA ...) can be in both lists. A run without `--not-found` is exactly today's.
- The RTO script with `--not-found` reads the RTO list the portal shows in that mode and only ADDS locations not already saved (same insert-only rule).
- Tests: `--not-found` parsing, a not-found run writes ONLY the three new collections (also with names that are in the normal list), a normal run never touches them, a second run adds nothing, the
  tick comes before the hook in both flow files. Real headless Chrome on a replica whose lists swap when its box is ticked (3 windows, both modes): normal and not-found rows exact, HONDA in both,
  the normal lists untouched by the second run. **Not seen live**: whether the portal really swaps the lists behind the SAME inputs after the tick (the code assumes it, like the flow itself), whether the RTO
  list differs in that mode, the option text, the speed. If the portal uses different input names in that mode the next step is a small names switch in `lib/nationalModelCollect.js` (not guessed).

### National RTO locations: a JSON file on the backend, NOT the RTO City Location master (2026-11-14, owner's correction; replaces the earlier RTO rows)
The owner saw the collected locations (`NATIONALDELHINORTH` ...) as rows in the RTO City Location table and said: "rto code not update this on the data, remove that - save it on the json file on the backend and show it on
the dropdown, optional, city and branch". So `scripts/nationalCollectRtoLocations.js` now writes **only a JSON file** (default `RayalBrokers-backend/json/nationalRtoLocations.json` when the backend folder is next to this one, else
`data/nationalRtoLocations.json` here to carry across; `--file <path>` overrides): `{ "updatedAt", "locations": [ { "text": "DELHI - SOUTH - DL 03", "city": "DELHI", "branch": "SOUTH - DL 03" } ] }`, split at the FIRST " - "
(no " - " = city only). Entries are only ADDED, a re-run keeps everything (same bytes when nothing is new), written whole to a temp file then renamed. No database write, no auto-made code, nothing in the Pincode Locality master
(`lib/nationalRtoCollect.js`; the backend's `shared/nationalRtoLocations.js mergeLocations` writes the same bytes - a test compares them). **A policy can carry `nationalRto`** (picked in the policy form's optional "National RTO (City - Branch)"
dropdown): `server.js` puts it in the job data and `national.js` / `nationalTPForm.js` (identical lines, TP guards green) type exactly that text in National's RTO box when it is set, else `RTOCity - RTORegion` as always;
the Make / Model collector's RTO pick uses it too. The rows an earlier run saved into the master are moved into the file and removed by the backend's `scripts/removeNationalRtoRows.js` (dry run by default, rollback file, `--apply --db <name>`).
Tests: `test/nationalRtoCollect.test.js` (11). **Popups (same day, live log)**: National shows a Material dialog with a dark backdrop after some picks; it blocked every next click ("element click intercepted") and stopped 4 of 10 windows. The Make / Model collector now
closes any popup (the portal's own close button by name, then Close / OK, last resort the first button - the same rules as `national.js dismissPortalDialog`), says its text in the log (the same text twice, then only counted; the totals list them),
and repeats a click that a popup intercepted; a make that still fails is retried after the popup is closed.
