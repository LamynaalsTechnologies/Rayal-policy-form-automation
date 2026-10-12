# multiCompany — OD / TP automation, company routing and common login

Everything about selling **OD** and **TP** as separate jobs, possibly from **different insurers**
(e.g. Reliance OD + National TP), in one place: the data model (`settings`), the folder layout, the shared
login / error handling, how to run and test it, and what is deliberately not built yet.

Contents: [1. The `settings` object](#1-the-settings-object) ·
[2. Feature flags](#2-feature-flags) · [3. Folder layout](#3-folder-layout) ·
[4. How a job runs](#4-how-a-job-runs) · [5. Common login](#5-common-login) ·
[6. Error codes](#6-error-codes-and-retry-rules) · [7. Adding things](#7-adding-a-handler-or-a-company) ·
[8. Testing](#8-testing) · [9. Storage / disk](#9-storage-and-disk) ·
[10. Not built yet](#10-not-built-yet) · [11. Everything that changed](#11-everything-that-changed)

---

## 1. The `settings` object

One canonical description of a policy's company routing. Stored on the **OnlinePolicy** document and copied
onto every **RelianceJobQueue** job (`job.settings`, `job.formData.settings`, `job.metadata.settings`).

```js
settings: {
  isMultipleCompany: true,   // ODCompany !== TPCompany
  PACompany: "Brisk",        // "Brisk", an insurer ("Reliance" | "National" | "KSHEMA"), or "" when PA is off
  ODCompany: "Reliance",
  TPCompany: "National",
}
```

**Rules** (`RayalBrokers-backend/shared/policySettings.js`, mirrored in the frontend
`OnlinePolicy/utils/companyRules.js` — keep the two identical):

| Field | Derived from |
|---|---|
| `ODCompany` | `settings.ODCompany` → `odCompany` → `company` (canonical spelling from `WALLET_COMPANIES`) |
| `TPCompany` | `settings.TPCompany` → `tpCompany` → `company` |
| `isMultipleCompany` | OD ≠ TP, case-insensitive |
| `PACompany` | `""` if `paCover` is off; else a valid `settings.PACompany`; else legacy: `paCoverCompany === "Brisk"` → Brisk, otherwise `paCoverInsurerCompany` or the OD company |

Valid `PACompany` = **Brisk**, the OD company, and — only when `ENABLE_MULTI_PRODUCT_POLICY` is on — the TP company.
Anything else is a `400` from `POST /onlinePolicy`.

**The old flat fields are still written** (`company`, `odCompany`, `tpCompany`, `paCoverCompany` =
`"Brisk"|"Company"`, `paCoverInsurerCompany`) because every existing reader uses them — the insurer fillers, the
Brisk card, reports. They are now **derived from `settings`** (`settingsToLegacyFields`), never chosen separately,
so the two cannot disagree. The server recomputes both on every create/edit/update; a stale client cannot win.

**Where it is used**

| Layer | What it does with `settings` |
|---|---|
| Form (`BasicPolicyDetailsStep`) | OD/TP come from the Make & Model master (shown read-only). One **PA Cover Company** dropdown: Brisk, the OD company and the TP company — the TP company is shown greyed out with the reason ("needs multi-company mode") until `ENABLE_MULTI_PRODUCT_POLICY` is on. `writeRouting()` is the only writer of the routing fields. |
| Edit | `routingFromPolicy()` loads it for both edit paths. A saved policy **keeps its saved companies**; if the master has since changed, an info toast says so. |
| Wallet | See below. |
| Job queue | `enqueuePolicyJob` puts it on the job; hold-release and retry hand each OD/TP job its own company back (they used to fall back to the OD company). |
| List / View / Preview / PDF | Show `Reliance (OD) · National (TP)` and the PA company. The list's company filter/search also matches the TP insurer. |
| Old policies | No `settings` → derived on read (`resolvePolicySettings`). `scripts/backfillOnlinePolicySettings.js` (dry-run by default, `--apply` to write) fills the stored documents; it is optional. |

**Wallet** (`resolveWalletRequirements`, used by create, edit and the frontend balance check):
- *Single company, or `ENABLE_MULTI_PRODUCT_POLICY` off* → exactly as before: motor premium to the policy's
  company, PA (+18% GST) to Brisk or that company.
- *Different OD/TP insurers, flag on, `schemaVersion 2`* → OD share (`odPremium × 1.18`) to the OD company, the rest
  of the motor premium (TP) to the TP company, PA to `PACompany`. The two motor shares add back to the motor
  premium to the paisa. If the OD/TP breakup is missing it falls back to the single debit and logs a warning.
- *A "user" login also pays from its personal **Policy Wallet**:* the same total as the Company Wallet legs (motor premium + PA with GST), as
  one amount (`policyWalletCharge`); see `RayalBrokers-backend/README.md` section 4.

**Premium split per company.** The premium engine is the same for every insurer: Total A = OD, Total B = TP with
PA folded in. `premiumSplit` (frontend, `companyRules.js`) / `buildPremiumSplit` (backend, `policySettings.js`) —
one rule in both — divides it:

| Part | Net | Total (incl. 18% GST) | Sold by (split mode) |
|---|---|---|---|
| OD | Total A | `round2(net × 1.18)` | ODCompany |
| TP | Total B − PA | motor premium − OD total (absorbs the rupee rounding, so parts add up) | TPCompany |
| CPA | PA amount | `round2(net × 1.18)` | PACompany |

Split mode = multi-company flag on and OD ≠ TP; otherwise everything is the policy's own company, as before. The wallet
debits are built from the same split, so what is shown is what is charged. Shown in: the Basic step summary (one line
per part with its company, plus "Pay to"), the Premium Breakup dialog (Total A/B tagged with companies and a
**Company split** table), the Preview, the View page and the PDF. The server stores it on every save as
`premiumCalculation.split` (`mode`, `legs`, `byCompany`, `grandTotal`) so a saved policy keeps showing what it was sold
as; the client never supplies it. Policies saved before this have no split and show the single Final Premium.

**PA Cover is bought once.** When one policy fans out into an OD job and a TP job, both would carry `paCover`
(and pay for a Brisk certificate twice). `jobPaRouting` gives PA to exactly one job — Brisk → the OD job; an
insurer → the job whose company is `PACompany` (the TP job if both are); the other job gets `paCover:false`.
`server.js` also tells the fillers when the policy already holds a Brisk certificate
(`briskCertificateExists`) and `shouldCreateBriskCertificate` then skips it.

**Bug fixed on the way:** the calculator's `finalPremium` already contains PA + GST (PA is folded into Total B), but
the payload sent it as the "motor premium" and the wallet then added PA again — PA was double-charged. The payload,
the wallet check and the Preview now use `motorPremiumExcludingPa`. Wallet debits for PA-on policies drop by the
duplicated amount.

## 2. Feature flags

| Flag | Where | Default | Effect |
|---|---|---|---|
| `ENABLE_MULTI_PRODUCT_POLICY` | `RayalBrokers-backend/.env` | `false` | Off: one bundled job on the OD company, PA options = Brisk + OD, wallet as before. On: OD and TP fan out into two jobs and the wallet splits per insurer. The form reads it from `GET /onlinePolicy-config`. |
| `MULTI_COMPANY_AUTOMATION_ENABLED` | `Rayal-policy-form-automation/.env` | `false` | Off: every handler throws `[E110]` **before** opening a browser, touching the DB or S3. Also gates the S3 screenshot lifecycle rule at startup. |
| `MULTI_COMPANY_SCREENSHOT_RETENTION_DAYS` | automation `.env` | `10` | S3 expiry for failure screenshots. |
| `KEEP_BROWSER_OPEN_ON_ERROR` | automation `.env` | existing | A failed/stopped job's browser stays open for inspection (needs a display). |
| `BREAKER_ENABLED` / `BREAKER_STOP_AT` | automation `.env` | `false` / — | Master switch and the checkpoint name(s) for `Breaker.checkpoint("…")` — see §8. Off: a checkpoint line in the code does nothing. |
| `POLICY_JOB_PARTS_ENABLED` | **`RayalBrokers-backend/.env`** | `false` | Off: the backend queues jobs the old way — **one bundled job whenever OD and TP are the same insurer**, and an OD job + a TP job only when two *different* insurers sell the policy. On: **one job per policy** carrying a `parts` array (OD / TP / OD+TP / PA, each with its own status). The automation server has no switch of its own — it simply runs any job that has `parts` (see §4), so **deploy the automation server first, then turn this on**. Jobs without `parts` keep running through the original code path unchanged. |
| `BRISKMAXWINDOW` | automation `.env` | `1` | How many Brisk PA parts may run at once. Brisk is API-only (no browser), so it has its own window, separate from the insurers' `RELIANCEMAXWINDOW` etc. |

`MULTI_COMPANY_AUTOMATION_ENABLED` gates the OD/TP **portal** handlers (both the old OD-job / TP-job shape and `od` / `tp`
parts). It does not gate the bundled flows or the Brisk PA part.

## 3. Folder layout

```
multiCompany/
  registry.js                     { reliance|national|kshema: { od, tp } } — all six registered
  README.md
  common/                         everything the six handlers share
    featureGate.js                MULTI_COMPANY_AUTOMATION_ENABLED, assertMultiCompanyEnabled() → [E110]
    engine.js  matchText.js       field-table filler (fillSection) and text matching
    adapters/kendoAdapter.js      Kendo autocomplete
    reliance/vehicleIdentityFields.js   make & model fields (OD and TP share them; unused while Reliance OD is login-only)
    reliance/fullCompanyLogin.js        the Reliance login: a COPY of the full-company one (OD and TP share it)
    errors.js                     MultiCompanyError(code, message, opts) + failureResult()
    loader.js                     waitForLoader(driver, company) — one loading wait, [E302] on timeout
    elements.js                   firstVisible, clickWithFallback, typeWithReadback
    portalMessages.js             read the portal's message, classify it, write the operator sentence
    screenshot.js                 captureFailure() — one screenshot per failed attempt, never throws
    browser.js                    openJobBrowser / closeJobBrowser for any company
    runHandler.js                 the wrapper every handler runs in
    loginOnlyHandler.js           factory for handlers whose form is not built yet
    login/
      index.js                    login(driver, company, creds, ctx)  ← THE entry point
      runLogin.js                 the shared login loop (National, KSHEMA)
      nationalLogin.js kshemaLogin.js    per-insurer strategy (data + small hooks)
  odCompany/  relianceOD/ nationalOD/ kshemaOD/     one handler file each
  tpCompany/  relianceTP/ nationalTP/ kshemaTP/     one handler file each
  cli/runHandler.js               standalone runner for any handler
```

Handlers stay exactly three folders below the repo root so their `../../common/...` requires resolve.

## 4. How a job runs

There are two job shapes. The queue tells them apart by one thing: **does the job have a `parts` array?**

| | Job **without** `parts` (today's default) | Job **with** `parts` (one per policy, `POLICY_JOB_PARTS_ENABLED`) |
|---|---|---|
| Created as | one bundled job, or an `od` job + a `tp` job (`policyType`) | one job per policy (`captchaId`), `rev: 0`, full `formData` |
| Claimed | the whole job | **one part** at a time |
| Status lives in | the job (`status`, `attempts`, `errorLogs`…) | each part; the job's own `status` / `nextRetryAt` are derived from them |
| Code path | `runPolicyJob` in `server.js` — **unchanged** | `lib/partRunner.js` (`runPartJob`) |

### 4.1 Jobs without `parts`

`server.js` → job has `formData.policyType` `"od"`/`"tp"` → `assertMultiCompanyEnabled()` →
`resolveMultiCompanyHandler(company, policyType)` → `handler({...formData, username, password, loginUrl, _jobId,
_attemptNumber, ...})`. Any other job goes to the bundled flows (`dispatchBundled`: National / KSHEMA / Reliance).

Every OD/TP handler is `runHandler({ company, policyType, data, body })`:

```
gate → open browser → start recording → LOGIN (common) → body(ctx) → result → always close browser
```

`ctx = { driver, data, settings, jobId, log, capture, stop }`. The `body` is the only insurer-specific part; it
ends with `ctx.stop(message, {stage})` while the form is unfinished.

Results (what `server.js` understands):

| Outcome | Result | Job status |
|---|---|---|
| deliberate stop | `stoppedResult` (`inProgress:true`, E100) | `failed_login_form`, calm log, no retry |
| failure | `failureResult`: `success:false`, `errorCode`, `retryable`, `stage`, `error`, screenshot fields | `retryable:false` → `failed_login_form` immediately; otherwise retried with backoff |
| feature off | **throws** `[E110]` | `failed_login_form`, no retry |

`server.js` records `result.errorCode` (with the catalogue severity) instead of the blanket E300 when a handler
sets it. Bundled flows never set it, so they behave as before.

### 4.2 Jobs with `parts`

A part is `{ key, kind, company, status, carriesPa, paCoverCompany, dependsOn, mirrors, attempts, maxAttempts,
nextRetryAt, lastError, lastErrorCode, stage, result, requeue, ... }`. The status rules (which part runs next, what
the job's status is, what an outcome does to a part) are in `lib/jobPartsCore.js` — one file, byte-identical to the
backend's `shared/jobPartsCore.js`, unit-tested there.

| Part | Kind | What runs | Company |
|---|---|---|---|
| `motor` | `bundled` | the live bundled flow (`dispatchBundled`): one comprehensive policy, OD + TP, at one insurer | the OD company (= the TP company) |
| `od`, `tp` | `portal` | `resolveMultiCompanyHandler(company, key)` (§3) — **still login-only stubs**, see §10 | that leg's insurer |
| `pa` | `brisk` | `lib/briskPartRunner.js`: API only, no browser, no credentials | Brisk (own window, `BRISKMAXWINDOW`) |
| `pa` | `withPart` | nothing — PA bought by an insurer is bought together with the part that carries it (`carriesPa`); it just mirrors that part | the insurer |

**Lifecycle of one part**

```
queue pass ──► planClaims ──► claimPart ──► runPartJob ──► writePartOutcome ──► job back to "pending"
 (candidates)   (windows)     (atomic)      (one part)      (rev-checked)        while parts remain
```

1. **Pick.** A pass reads pending jobs due now (`nextRetryAt` missing, `null`, or past). For a job with parts,
   `selectRunnablePart` picks the first part that is `pending`, due, whose `dependsOn` is done and whose insurer has a
   free window — order `od`, `tp`, `motor`, `pa`. The window is that **part's** company (`RELIANCEMAXWINDOW`, …) or
   `brisk`; a running job counts against the part it is running (`job.currentPart`).
2. **Claim, atomically.** `findOneAndUpdate({_id, status:"pending", rev, parts:{$elemMatch:{key,status:"pending"}}}, …)`
   sets the job to `processing`, that part to `processing`, `currentPart`, and bumps `rev`. If the job was edited since
   it was read, or another pass got there first, the claim fails and the pass moves on. **Parts of one policy run one
   after another** (the job is `processing` while one runs), each with its own `JOB_TIMEOUT`. The heartbeat only
   stamps `lastHeartbeatAt` and never touches `rev`.
3. **Run.** Hydrate as before, then build the part's form data = the job's `formData` + the part's overrides:
   `Companyname` (the part's insurer), `policyType: "od"|"tp"` for portal parts, `paCover` / `paCoverCompany` (a portal
   part buys PA only if it `carriesPa`; a bundled part keeps the policy's own PA settings so the live flow still buys a
   Brisk certificate inline), `_partKey`, `_attemptNumber = part.attempts + 1`. Credentials are looked up for the
   **part's** company (not for a Brisk part). The run is raced against `JOB_TIMEOUT`.
4. **Write back** (`writePartOutcome`). The job is **re-read**, the outcome folded onto the fresh document
   (`applyPartOutcome`) and saved with `updateOne({_id, rev}, …, {$inc:{rev:1}})`. If `rev` moved in between (an edit
   landed while the part ran) it re-reads and re-applies, up to 5 times — so an edit that arrived mid-run is never
   overwritten: the backend flags the running part with `requeue`, and the outcome decides whether it is applied
   (failed part: runs again with the new insurer) or only recorded (bought part: `routingChanged`). A part that is
   already bought is never demoted by a late failure.
   **Checked before every part runs** (`runPartJob`, before credentials, a browser or any purchase):
   - the policy still exists — a deleted policy fails every unfinished part with `failed_validation` and buys nothing, not even
     the Brisk PA (paid from the master wallet). A database error while checking is *not* "deleted": the part retries in 30 s
     and no attempt is spent;
   - the part matches how the policy was sold (`routingConflict`) — a bundled `motor` part on a two-insurer policy, or a
     single-company policy split into `od` + `tp` portal parts, is refused with `failed_validation` (E100);
   - the `tp` portal part fills the **TP vehicle** (`tpVehicleOverrides`, `lib/tpVehicle.js`, a byte-identical copy of the
     backend's `shared/tpVehicle.js`); the `od` part and a bundled part keep the OD vehicle.
5. **Next.** The job is `pending` again (immediately due) if any part can still run, so the queue picks the next part
   at once — by the run's own `.finally`, and by the change stream, which also wakes on updates that put a job back to
   `pending` or set `nextRetryAt`. A retry backoff wakes the queue at exactly that moment. The 5-minute
   `QUEUE_POLL_INTERVAL_MS` sweep is only the safety net.

**What a run result does to a part**

| Run result | Part becomes |
|---|---|
| success | `completed` (`completed_with_errors` if the policy documents could not be stored) |
| post-submission failure (`postSubmissionFailed`, stage `post-submission`) | `failed_post_submission`, never auto-retried (money involved) |
| deliberate stop / `inProgress` / `stopper()` / `E100` — **the login-only stubs** | `failed_login_form` with `stopped: true` ("not automated yet"), not retried |
| `retryable: false` (E110, E203–E205 …) | `failed_login_form`, not retried |
| retryable failure, thrown error, E302 timeout | attempts + 1 → `pending` with backoff 60 s · 2ⁿ⁻¹, or `failed_login_form` when attempts run out |
| hydration hiccup (DB / S3 blip) | `pending` again in 30 s, attempt not counted |
| policy missing / data invalid | every unfinished part `failed_validation` |
| Brisk error before a certificate exists | `failed` — an operator retries (never automatic) |
| Brisk certificate created but the PDF step failed | `completed_with_errors`, `result.certificateNo` kept — never bought again |

Every failure keeps what the old path recorded: the error log entry (now tagged with `part`, plus `errorCode`,
`stage`, `screenshotUrl` / `screenshotKey`, severity), `lastError*`, `failureType`, `finalError`, the credential source
on the job, the audit entries. `lib/errorLogger.logErrorToJobQueue` writes `status` itself and is **not used** for
parts jobs.

**The job's own status** (first match wins — `summarizeParts`): on hold → `hold`; any part running → `processing`; any
part can run → `pending`; all done → `completed` (`completed_with_errors` if a part finished with errors); the motor
parts are done but PA is not → `completed_with_errors`; otherwise the worst motor failure. So a policy with TP bought,
OD stopped at a stub and PA waiting for OD reads **"OD not automated yet, TP completed, PA waiting for OD"** and the job
is `failed_login_form`.

**The Brisk PA part** never opens a browser: (1) a certificate already on the policy → completes without buying; (2)
`shouldCreateBriskCertificate` → `createBriskCertificate`; (3) the certificate number is saved on
`onlinePolicy.briskCertificate` **immediately**, before anything that can still fail; (4) download and store the PDF.
After a bundled `motor` run that bought the certificate inline, the PA part is set from the run result
(`briskCertificate` / `briskCertificateError` / `briskCertificateSkipped`) and `onlinePolicy.briskCertificate`:
completed, failed, or — if nothing was bought — left pending for the Brisk runner. For multi-company policies the PA
waits for the OD part (as the bundled flows buy Brisk only after the portal part succeeded).

**Recovery.** A part is never left `processing` behind a dead run: the zombie reclaim (silent heartbeat), startup
recovery and the SIGINT / SIGTERM re-queue each run **two** updates — one for jobs without `parts` (as before) and one
for jobs with `parts` that sets the `processing` part back to `pending` (`arrayFilters`, `$unset currentPart`,
`$inc rev`) and the job to `pending`. An edit that arrived during a run that never reported back (`requeue`) is
applied at that point. Startup also makes pending parts that were backing off due immediately.

**Recordings** (`RECORDING_ENABLED`): one video per **part**, `${policyId}_${part}`, so OD and TP no longer overwrite
each other; only that part's entry (tagged `part`) and S3 object are replaced.

**Status API.** `GET /api/job-status/:captchaId` also returns `parts` and `currentPart`.

## 5. Common login

`login(driver, company, { username, password, loginUrl }, { jobId, log })` → resolves when logged in and the
dashboard is ready, or throws a `MultiCompanyError`.

**Reliance (OD and TP) logs in with a copy of the full-company Reliance login**, `common/reliance/fullCompanyLogin.js`,
so both log in the very same way:

- *copied word for word:* `performLogin` and `isUserLoggedIn` (`browserv2.js`), the captcha helpers (`captchaUtils.js`),
  and from `fullPolicycompany/relianceForm.js` the login-URL fallback, the `[E203] rejected` rule, closing the promo popup
  and waiting for the Motors menu;
- *shared, not copied:* opening / closing the browser window (`common/browser.js` calls the same
  `createRelianceJobBrowser` / `cleanupJobBrowser`) and the GPT-4o captcha reader (`Captcha.js`);
- *behaviour* (same as the full-company flow): up to 5 attempts, a captcha read that is not accepted is retried inside;
  any other rejection ends as `[E203]`, not retried — the portal's own message is **not** read;
- *the only differences:* the rejection is a `MultiCompanyError("E203")`, the temporary captcha PNG is written under the
  project root, and the function returns the Motors-menu element (listed at the top of the file);
- *kept the same by a test:* `test/multiCompanyRelianceLogin.test.js` compares the copy with the originals and fails if
  either side changes. If you change the full-company login on purpose, change the copy to match — or delete that test
  if the two should part ways.

**National and KSHEMA** go through one loop (`runLogin.js`):

1. no username/password → `[E205]`; no login URL → `[E205]` (National has no built-in URL)
2. open the URL, wait for the login form (`E304` if it never renders), wait for the loader
3. `beforeFill` hook (National: INTERMEDIARY → BROKER POSP dropdowns)
4. type username/password **with read-back**, submit
5. poll for the portal's answer: success marker or a **new** message on screen
6. classify and act; `afterLogin` hook (close pop-ups, wait for the dashboard)

Per-insurer strategy — data copied from the working flows:

| | National | KSHEMA |
|---|---|---|
| default URL | none (must be saved on the credential) | motorinsurance.kshema.co/app/home |
| fields | `log_txtfield_iUsername_01` `log_pwd_iPassword_01` `log_btn_login_01` | `#login_email` `#login_password` `button[data-iid=sign-in]` (+ fallbacks) |
| logged in when | off `/signin/login` and username box gone | dashboard tiles (`.top-product` …) |
| attempts / result wait | 1 / 30 s | 1 / 20 s |
| loading | NIC overlay (+ Kendo), popups ignored | Material spinner |

**Loading detection** is one function (`waitForLoader`). National and KSHEMA throw `[E302]` if the page never settles;
before, National carried on and failed later with an unrelated "element not found".

**Invalid credentials** are recognised by the portal's own words (`classifyLoginMessage`), for National and KSHEMA, and
fail the job at once. National never detected it at all before (it was retried).

## 6. Error codes and retry rules

Codes come from the one catalogue, `lib/errorHandler.js` `ERROR_CODES`. `MultiCompanyError` puts `[Ennn]` in the
message so `classifyError` also honours it if it is ever thrown rather than returned.

| Situation | Code | Retry |
|---|---|---|
| Portal says wrong user / password | `E203` | no |
| Account locked, disabled, password expired | `E204` | no |
| Portal asks for an OTP / verification code | `E204` | no |
| Stayed on the login form, page idle, no message | `E203` ("did not accept the login") | no |
| No username/password/login URL | `E205` | no |
| Captcha still failing after all attempts | `E202` | yes |
| Login page never loaded / portal down / 5xx | `E304` | yes |
| No answer after submit and page still loading; loader stuck | `E302` | yes |
| Login form changed (box/button missing) | `E301` | yes |
| A required form field could not be filled | `E306` | yes |
| Feature flag off | `E110` | no |

In the shared loop (National, KSHEMA) anything that time could fix is left to the job-level retry, so a wrong password
is never submitted twice. Operator sentences name the fix and say whether the policy needs re-running; the portal's
own words are kept in quotes on the end.

**Reliance is different, because its login is the full-company one:** no credentials → `E205`; Reliance rejects the login
(wrong password, locked account, or a captcha it could not get right in 5 attempts) → `E203`, not retried, with the fixed
sentence "Reliance rejected the login for …"; the dashboard never appears → a timeout error, retried. The `E202` / `E204` /
`E301` rows above are not produced for Reliance.

## 7. Adding a handler or a company

- **Write a form:** replace the `makeLoginOnlyHandler` line in the handler's stub file with
  `runHandler({ company, policyType, data, body })` (the example is in `relianceOD.js`'s header), fill with `fillSection`,
  end with `ctx.stop(...)`. Throw `MultiCompanyError(code, message, { stage })` for failures.
- **New policy type / company entry:** one line in `registry.js`.
- **New insurer:** a `common/login/<company>Login.js` strategy (fields, `isLoggedIn`, optional `beforeFill` /
  `solveCaptcha` / `afterLogin`), one line each in `login/index.js`, `browser.js` and `loader.js` (loading preset),
  then handler files. An insurer whose login must stay exactly as in its full-company flow (Reliance) instead gets its own
  login file under `common/<company>/` and one line in `OWN_LOGIN` in `login/index.js`.

## 8. Testing

```bash
# from Rayal-policy-form-automation/
node multiCompany/cli/runHandler.js --company reliance --type od -u USER -p PASS
node multiCompany/cli/runHandler.js --company national --type tp -u USER -p PASS --loginUrl https://...
node multiCompany/cli/runHandler.js --company kshema   --type od -u EMAIL -p PASS
```

- Correct login → `inProgress` result, stage `logged-in`, "Logged in to <insurer> — the <insurer> OD/TP form is not built yet" (every handler is login-only except Reliance OD, which also opens Motors → Two Wheeler and stops there with stage `motors-two-wheeler`).
- **Wrong password** (deliberate) → `errorCode: "E203"`, `retryable: false` and a `screenshotKey`. For National and KSHEMA
  the portal's message is inside `error`; do this once per portal, because their rejection selectors are generic
  (validation spans, alerts, toasts) and this run confirms the portal's real wording is caught. For Reliance `error` is
  the fixed sentence "Reliance rejected the login for …" (the full-company login does not read the portal's message), and
  it takes the full 5 attempts to get there.
- Flag off → `[E110]` before a browser opens.

**Stopping a run at a chosen point (Breaker).** Put one line anywhere in a flow or handler body (no import needed):
`Breaker.checkpoint("RTO/Make/Model/Variant");`. It does nothing until `.env` has `BREAKER_ENABLED=true` and the name in
`BREAKER_STOP_AT` (comma-separated, case ignored, or `*` for the first checkpoint reached); restart after editing `.env`.
The run then ends as a calm "stopped on purpose" (`stopper()`: no retry, nothing submitted) and, with
`KEEP_BROWSER_OPEN_ON_ERROR=true` and a display, the browser stays on that page. It stops that *part*; a policy's other parts still
run next, as they do after any failed part. To run past it: switch it off, restart, Retry. The stop travels up as a thrown error, so
put the checkpoint outside small best-effort `try` blocks — the big ones in `national.js` / `relianceForm.js` already start with
`if (isAutomationStop(e)) throw e;`, and Breaker warns after 10 s if a stop was swallowed or turned into another error anyway.

The CLI sets `MULTI_COMPANY_AUTOMATION_ENABLED=true` for its own process only (it must do so before requiring
`featureGate`, which reads the flag once at load).

## 9. Storage and disk

- **Failure screenshots:** at most one per failed attempt (≤ `maxAttempts` per job), uploaded to
  `screenshots/multiCompany/<company>/<jobId>/attempt_<n>/…` on S3. An **S3 lifecycle rule** on that prefix expires
  them after `MULTI_COMPANY_SCREENSHOT_RETENTION_DAYS` (default 10) — set at server start only when the framework
  flag is on, through the generalised `ensureLifecycleRule` in `s3Uploader.js` (other rules on the bucket are
  preserved). It needs `s3:Get/PutLifecycleConfiguration`; without it the server logs the manual rule to add.
- **If S3 is unreachable** they fall back to `local-screenshots/`, which server startup wipes.
- **Recordings** of a job with parts: one per part, replaced (not appended) on every run — at most one entry and one S3
  object per part per policy, expired by the recording lifecycle rule. The Brisk PDF is deleted from the server disk
  right after it is stored.
- Browser profiles / downloads are the existing per-job folders, cleaned by the existing session managers.

## 10. Not built yet

- **Form filling** for every handler: Reliance TP, National OD/TP and KSHEMA OD/TP log in and then stop with
  "form not built yet". Reliance OD also opens Motors → Two Wheeler (`odCompany/relianceOD/motorsMenu.js`, copied from
  `relianceForm.js` STEP 2–3) and stops there; choosing the product in the dropdown is the next step. (Reliance logs in
  through the copy of the full-company login.) A multi-company policy therefore shows its
  `od` / `tp` parts as "not automated yet" (`failed_login_form`, `stopped`) for now — the job's per-part status and the
  retry rules are in place, the portal handlers are not.
- **Multi-company Brisk PA waits for the OD part** to succeed (same as the bundled flows, which buy Brisk only after the
  portal part). Until the OD handler is built, that PA stays "waiting for OD".
- **Single-company policies** (OD insurer = TP insurer) are one `motor` part and go through the **live bundled flows**,
  which buy for real. With `POLICY_JOB_PARTS_ENABLED` on they no longer fan out to login-only stubs.
- The live bundled flows (`relianceForm.js`, `national.js`, `kshemaForm.js`) still use their own login. Moving them
  onto `common/` is a later step, once common login is proven on all three portals.
- A bundled National / KSHEMA run reports a Brisk failure that happened *after* the certificate was bought (PDF
  download / store) the same way as one before it; the PA part then says the certificate "may already exist at Brisk".
  Check Brisk before re-running such a PA part.
- PDF / KYC writes from the two OD / TP portal handlers to `onlinePolicy` are not built yet, so there is nothing to
  overwrite; when they are, they must write per part.
- The standalone-OD plan option's exact portal text and TP nominee handling are unconfirmed assumptions.

## 11. Everything that changed

**Backend (`RayalBrokers-backend`)** — `shared/policySettings.js` (new); `Model/onlinePolicy.js` (`settings`,
`premiumCalculation.odPremium/tpPremium/split`); `Model/RelianceJobQueue.js` (`settings`); `Controller/onlinePolicyController.js`
(parse/validate/derive `settings`, `getOnlinePolicyConfig`); `Routes/routes.js` (`GET /onlinePolicy-config`);
`dao/onlinePolicyDao.js` (wallet resolution, job `settings` + PA routing, per-job company on hold-release/retry,
routing-aware PUT/PATCH, `settings` on reads, TP-aware list filter/search); `scripts/backfillOnlinePolicySettings.js` (new).

**Frontend (`OnlinePolicy/`)** — `utils/companyRules.js` (routing helpers, wallet mirror, `motorPremiumExcludingPa`);
`constants/initialValues.js`; `hooks/useOnlinePolicyConfig.js` (new); `hooks/useOnlinePolicyForm.js` (payload);
`components/BasicPolicyDetailsStep.js` (single PA dropdown, `writeRouting`, no silent re-routing on edit);
`components/FormNavigationButtons.js`, `CustomerDetailsStep.js`, `PreviewStep.js`; `utils/validationSchemas.js`;
`OnlinePolicy.js` (edit loaders, wallet check, list column); `ViewOnlinePolicy.js`; `utils/policyPdf.js`;
`Service/SearchPolicy.js` (`GetOnlinePolicyConfig`).

**Automation, one job per policy with parts** — `lib/jobPartsCore.js` (shared logic, identical to the backend's
copy), `lib/partRunner.js` (pick / claim / run / write-back / recovery), `lib/briskPartRunner.js` (API-only Brisk PA),
`lib/recordingEntries.js` (per-part recordings), `lib/jobRecorder.js` (per-part video), `server.js` (claim query also
matches a stored `nextRetryAt: null`; one part per claim; `dispatchBundled` shared by both paths; three recovery
sites; change stream wakes on in-place updates; `/api/job-status` returns `parts` and no longer calls `.lean()` on a
raw-driver result), `models/RelianceJobQueue.js` (`parts`, `rev`, `currentPart`, full status list), `test/`
(`npm test`).

**One job per policy, hardening** — `lib/partRunner.js` (policy-must-exist guard, `routingConflict`, TP vehicle overlay),
`lib/tpVehicle.js` (new, byte-identical to the backend's `shared/tpVehicle.js`), `server.js` `buildFormDataFromPolicy`
(carries `makeModelCombo`, `makeModelComboName`, `tpVehicle`); backend `shared/jobParts.js` (`fansOutToTwoJobs`, v1 policies are
one `motor` part) and `dao/onlinePolicyDao.js` (`enqueueLegacyJobs` splits only two *different* insurers; `queuePolicyJobs` never
falls back to the fan-out beside a running legacy job).

**Automation (`Rayal-policy-form-automation`)** — this folder; `server.js` (import paths, `errorCode`, Brisk
guard, hydration keeps per-job routing and `settings`, and the `validation.isValid` typo — every hydrated job used to
be failed — is now `valid`); `briskCertificate.js` (existing-certificate guard, never send `od`/`tp` as the Brisk
policy type); `s3Uploader.js` (`ensureLifecycleRule`, multiCompany screenshot rule); `models/RelianceJobQueue.js`
(`settings`).
