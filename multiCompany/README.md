# multiCompany — OD / TP automation, company routing and common login

Everything about selling **OD** and **TP** as separate jobs, possibly from **different insurers**
(e.g. Reliance OD + National TP), in one place: the data model (`settings`), the folder layout, the shared
login / error handling, how to run and test it, and what is deliberately not built yet.

Contents: [1. The `settings` object](#1-the-settings-object) ·
[2. Feature flags](#2-feature-flags) · [3. Folder layout](#3-folder-layout) ·
[4. How a job runs](#4-how-a-job-runs) · [5. Common login](#5-common-login) ·
[6. Error codes](#6-error-codes-and-retry-rules) · [7. Adding things](#7-adding-a-handler-or-a-company) ·
[8. Testing](#8-testing) · [9. Storage / disk](#9-storage-and-disk) ·
[10. Not built yet](#10-not-built-yet) · [11. Everything that changed](#11-everything-that-changed) ·
[12. National TP and "TP first, then OD"](#12-national-tp-and-tp-first-then-od--why-what-was-added-what-is-left)

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
| `OD_WAITS_FOR_TP` | automation `.env` | **on** (anything but `false` / `0` / `no` / `off`) | A two-insurer policy buys its **TP first**: the OD job is not started until the TP job of the same policy is `completed` / `completed_with_errors`; while it is anything else (pending, running, on hold, failed) the OD waits, and starts by itself when TP is fixed and completes. Only the old two-job shape needs this switch (`lib/jobSequence.js`); one job with parts orders them with `dependsOn`. Off: OD and TP are independent jobs again. |
| `NATIONAL_TP_FORM_ENABLED` | automation `.env` | **on** (anything but `false` / `0` / `no` / `off`) | On: a National TP part selects the plan "5 Year Long Term Liability Only" and runs the whole duplicated National form for a third-party-only policy (§5, §10) up to the payment link that goes to the customer — no `.env` line needed. `false`: it logs in, opens the quote form, lists the "Your Plan" options and stops (stage `tp-plan`) — nothing is chosen or bought, no nominee lookup. To look at the TP quote before anything is sent use the Breaker instead (`BREAKER_STOP_AT=National TP/quote`, then `National TP/payment`). Needs `MULTI_COMPANY_AUTOMATION_ENABLED` too. |
| `BRISKMAXWINDOW` | automation `.env` | `1` | How many Brisk PA parts may run at once. Brisk is API-only (no browser), so it has its own window, separate from the insurers' `RELIANCEMAXWINDOW` etc. |
| `RELIANCE_WALLET_HOLD_ENABLED` | automation `.env` | **on** (anything but `false` / `0` / `no` / `off`) | The **bundled Reliance full-company** flow (`fullPolicycompany/relianceForm.js`, not the OD/TP handlers). On: after **Pay** is clicked, a policy whose `Paymentmethod` is wallet (or blank — the backend default) stops on the payment page: browser left open, nothing paid at Reliance, no Brisk certificate, no PDF merge; the job is recorded as stopped on purpose (`E100`, stage `reliance-wallet-hold`, no retry). `link` policies are not affected. `false`: the old behaviour — skip the link flow and carry on to the Brisk call. The wallet payment steps themselves are **not built yet**; this is where they go (`relianceForm.js`, the `shouldHoldForWallet` branch). Not related to the Breaker, which is a dev switch and must stay off on a real server. |
| `KSHEMA_TP_FORM_ENABLED` | automation `.env` | **on** (anything but `false` / `0` / `no` / `off`) | On (and `KSHEMA_TP_PRODUCT_TYPE` set): a KSHEMA TP part runs the duplicated KSHEMA form for a third-party-only policy (§13) up to the Razorpay QR and the payment link, then releases the OD of the same policy. `false`: it logs in, fills the quote as far as the Product Type, lists the portal's Product Type options in the stop message (stage `tp-product`) and stops — nothing is chosen or bought. Needs `MULTI_COMPANY_AUTOMATION_ENABLED` too. |
| `KSHEMA_TP_PRODUCT_TYPE` | automation `.env` | *(empty)* | The exact text of the liability-only option in KSHEMA's Product Type dropdown (matched exactly, spaces/case ignored, then read back). **Empty = the same stop as the switch-off one**, which is how the right text is found on the first run. |

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
              nationalTP/nationalTPForm.js   DUPLICATE of fullPolicycompany/national.js + tagged [TP] changes — see §5, §10
              nationalTP/tpPlan.js           the plan "5 Year Long Term Liability Only": exact match, read back
              nationalTP/tpConfig.js         NATIONAL_TP_FORM_ENABLED
              nationalTP/stopBeforePlan.js   the stop taken while that switch is off (lists the plan options)
              kshemaTP/kshemaTPForm.js       DUPLICATE of fullPolicycompany/kshemaForm.js + tagged [TP] changes — see §13
              kshemaTP/kshemaTPQuoteForm.js  DUPLICATE of fullPolicycompany/kshema/kshemaQuoteForm.js + tagged [TP] changes — see §13
              kshemaTP/tpProduct.js          the Product Type: exact match, read back, never retried when missing
              kshemaTP/tpConfig.js           KSHEMA_TP_FORM_ENABLED, KSHEMA_TP_PRODUCT_TYPE
              kshemaTP/stopBeforeProduct.js  the stop taken while the product text is not set (lists the options)
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

### 4.0 TP first, then OD

A policy sold by two insurers buys its **TP before its OD**. The reason is the business one: an own-damage policy sold on its own
(Reliance OD) asks for the existing third-party policy (insurer, number, dates), and an OD must not be bought when the TP half
failed — the customer would be left with OD and no TP. So the two never run at the same time, and OD only starts once the TP
insurer's job has been bought.

| Shape | How the order is kept |
|---|---|
| **Two jobs** (`POLICY_JOB_PARTS_ENABLED` off — OD and TP are two documents, `{captchaId, policyType}`) | `processRelianceQueue` filters the candidates before it plans the windows: an OD job whose TP job (same `captchaId`) is not `completed` / `completed_with_errors` is held — it stays `pending`, takes no window, and is logged once (`[Queue] ⏳ TP first, then OD -> …`). The TP job finishing triggers the next pass, which starts the OD job. No TP job (single company, TP deselected) = nothing to wait for. If the TP jobs cannot be read, the OD jobs wait that pass. `lib/jobSequence.js`, switch `OD_WAITS_FOR_TP`. |
| **One job with parts** | the backend builds `od` with `dependsOn: "tp"` (the mechanism PA already uses): `waitingFor: "tp"` until TP is bought, `blockedBy: "tp"` when it failed. A job saved before this keeps its old order until it is next saved (`mergeJobParts` refreshes `dependsOn`). |

The policy list reads both the same way: the OD part says **Waiting for TP to finish** — also when the TP failed (it is not an
error of the OD; the hint says to retry TP, and OD then starts by itself). `legacyJobsToParts` gives the two-job OD the same `dependsOn`. PA through Brisk still waits for OD, so the chain is TP → OD → PA.

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
| `od`, `tp` | `portal` | `resolveMultiCompanyHandler(company, key)` (§3) — **login-only stubs, except National TP** (the duplicated National form with the TP changes; stops before the plan only when `NATIONAL_TP_FORM_ENABLED=false`), see §10 | that leg's insurer |
| `pa` | `brisk` | `lib/briskPartRunner.js`: API only, no browser, no credentials | Brisk (own window, `BRISKMAXWINDOW`) |
| `pa` | `withPart` | nothing — PA bought by an insurer is bought together with the part that carries it (`carriesPa`); it just mirrors that part | the insurer |

**Lifecycle of one part**

```
queue pass ──► planClaims ──► claimPart ──► runPartJob ──► writePartOutcome ──► job back to "pending"
 (candidates)   (windows)     (atomic)      (one part)      (rev-checked)        while parts remain
```

1. **Pick.** A pass reads pending jobs due now (`nextRetryAt` missing, `null`, or past). For a job with parts,
   `selectRunnablePart` picks the first part that is `pending`, due, whose `dependsOn` is done and whose insurer has a
   free window — order `od`, `tp`, `motor`, `pa` (but `od` depends on `tp`, §4.0, so TP is the one that is offered first). The window is that **part's** company (`RELIANCEMAXWINDOW`, …) or
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
| deliberate stop / `inProgress` / `stopper()` / `E100` — **the login-only stubs**, National TP's stop while its switch is set to false | `failed_login_form` with `stopped: true` ("not automated yet"), not retried |
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

**National TP does not use the shared loop at all.** `tpCompany/nationalTP/nationalTPForm.js` is a duplicate of
`fullPolicycompany/national.js` — its own inline login, form, error mapping and browser cleanup. The browser / session manager,
`nationalBrowserConfig.js`, S3, the error catalogue and `Captcha.js` are the shared ones, not copies. `nationalTP.js` checks the
feature gate and the `NATIONAL_TP_FORM_ENABLED` switch (on unless set to false), prepares the payload (below) and calls it.

- *every line that differs from the original is tagged `[TP]`* (header lists them): require depth, failure screenshots under
  `screenshots/multiCompany/`, **the plan** `5 Year Long Term Liability Only` (`tpPlan.js`: option text must EQUAL it, read back,
  checked again right before the quote; the original's `safeSelectOption` matched by substring and silently kept the portal's plan),
  **no IDV, no Manufacturer's Selling Price and no discount %** (the TP part still carries the OD's `idv` and discount; the Vahan
  lookup that used to be "re-run after the discount" stays as the flow's one lookup), no inline Brisk certificate, a
  `TpPlanError` returned as a non-retryable failure (stage `tp-plan`, code `E306`), and three `Breaker.checkpoint`s
  (`National TP/plan`, `National TP/quote`, `National TP/payment`). `test/nationalTP.test.js` fails if anything else differs, so a
  portal fix made in `national.js` has to be ported into the copy — or delete that test if the two should part ways;
- *the portal's Compulsory PA for Owner Driver* (`tpPa.js` `portalPaTerm`, `[TP] 8`) is the policy's year — 1 or 5, `paCoverYears` — whatever
  the PA Cover box says; the one exception is PA Cover bought from **Brisk** (`settings.PACompany`), which keeps the portal on **No** so the
  customer is not covered and charged twice. Before, the year was used only when PA Cover = National, and a policy with PA Cover off and
  "1 Year" in the TP panel went to the portal as "No";
- *left exactly as the full flow:* the model-not-found tick, the PA radio / "No of Years" mechanics (only which term they get changed),
  nominee, financier, Vahan, the payment link. TPPD Restrict is not applied on the portal (neither is it in the full flow);
- *prepared before the browser opens* (`prepareNationalTp`, what `server.js dispatchBundled` does for bundled National only): the
  saved default nominee fills what the policy left blank and `[E101]` when there is none at all (National demands one on every quote);
  the PA term must be exactly 1 or 5 unless PA Cover is Brisk's (`[E101]`) — the original silently fell back to "1 Year". The Online
  Policy form asks that term once for every National TP policy ("No of Year *", no default): in the TP panel while PA Cover is not
  ticked, inside PA Cover Details (the field that was always there) once it is;
- *behaviour you will notice against the shared loop:* a wrong password is **retried** (the full-company flow's behaviour) instead
  of ending as a non-retried `[E203]`.

**National and KSHEMA** (the other handlers) go through one loop (`runLogin.js`):

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
- **Operator sentences go through `lib/errorHandler.js beautifyError`**, and it is blunt: it keeps only the text after the **last
  colon** of a message, and replaces any message containing `Wait timed out after` / `Waiting for element` with a generic "the portal
  took too long" line. So write ONE colon (right after the label, e.g. `National TP: ...`), list things without a colon
  (`The plans on the portal are "A", "B".`), and keep the driver's own error text out of the sentence (log it, put it in `details`).
  National TP's first stop message had a colon before its plan list and showed the operator nothing but four plan names.
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

- Correct login → `inProgress` result, stage `logged-in`, "Logged in to <insurer> — the <insurer> OD/TP form is not built yet" (every handler is login-only except Reliance OD, which also opens Motors → Two Wheeler and stops there with stage `motors-two-wheeler`, and National TP: it runs the whole TP form up to the payment link, so stop it with `Breaker` first, e.g. `BREAKER_STOP_AT=National TP/quote`, and look at the quote before anything is sent; with `NATIONAL_TP_FORM_ENABLED=false` it logs in, opens Calculate Premium, chooses Vehicle Type "New" and stops with stage `tp-plan` — its `error` lists the "Your Plan" options the portal offers).
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

- **Form filling** for every handler except National TP and KSHEMA TP (next bullets): Reliance TP, National OD and KSHEMA OD log in and
  then stop with "form not built yet". Reliance OD also opens Motors → Two Wheeler (`odCompany/relianceOD/motorsMenu.js`, copied from
  `relianceForm.js` STEP 2–3) and stops there; choosing the product in the dropdown is the next step. (Reliance logs in
  through the copy of the full-company login.) A multi-company policy therefore shows its
  `od` / `tp` parts as "not automated yet" (`failed_login_form`, `stopped`) for now — the job's per-part status and the
  retry rules are in place, the portal handlers are not.
- **National TP** is built (`tpCompany/nationalTP/`, §5) and **on by default**: it selects "5 Year Long Term Liability Only" and goes on to
  buy a third-party-only policy and send the payment link. `NATIONAL_TP_FORM_ENABLED=false` holds it at "Your Plan" (the plan list in the message).
  Not proven against the live portal yet: how the TP plan page differs (a field that appears or disappears), whether the portal
  asks the Manufacturer's Selling Price in the model-not-found mode without an IDV. Use the Breaker checkpoints for the first real run. While Reliance OD is
  still login-only a two-company policy buys only its TP half.
- **KSHEMA TP** is built (`tpCompany/kshemaTP/`, §13) but **starts held at the Product Type**: the liability-only option's text is
  not known, so until `KSHEMA_TP_PRODUCT_TYPE` is set a run lists the portal's options and stops. What the TP quote page hides
  (IDV, the add-ons page) is learnt from the Breaker runs (`KSHEMA TP/product`, `/quote`, `/payment`) — nothing here is proven on
  the live portal yet.
- **TP → OD hand-off** (the TP policy's number and dates reaching the OD form) — **not built**, see §12.2. Ordering is (§4.0); the data
  is not passed yet, and National's flow reads no number or date from the portal at all.
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

**National TP, TP-first ordering** — the full list, grouped by area, is in §12.4.

**Automation (`Rayal-policy-form-automation`)** — this folder; `server.js` (import paths, `errorCode`, Brisk
guard, hydration keeps per-job routing and `settings`, and the `validation.isValid` typo — every hydrated job used to
be failed — is now `valid`); `briskCertificate.js` (existing-certificate guard, never send `od`/`tp` as the Brisk
policy type); `s3Uploader.js` (`ensureLifecycleRule`, multiCompany screenshot rule); `models/RelianceJobQueue.js`
(`settings`).

---

## 12. National TP and "TP first, then OD" — why, what was added, what is left

### 12.1 Why TP is bought before OD

An OD-only policy at Reliance asks for the **existing third-party policy**: its insurer, **policy number**, **policy start date**
and **policy end date** (the "exist third party insurance" block of the OD form — `plan-OD-Relience.txt` in the workspace root,
steps 7 and 23–26). Those values come from the **finished TP**. So:

- the OD cannot start before the TP has been bought, and
- an OD must not be bought when the TP failed (the customer would be left with OD and no TP).

That is the whole rule: **TP first, OD waits for it** (§4.0). TP and OD never run at the same time. If the TP fails, the OD stays
"Waiting for TP to finish" and starts by itself once the TP has been fixed and bought.

### 12.2 The hand-off — what the TP has to give the OD, and what exists today  *(NOT BUILT YET)*

| OD form needs | Where it comes from | State |
|---|---|---|
| TP insurer | `settings.TPCompany` of the policy | known, nothing to build |
| TP policy start date | the TP policy's start = the purchase date of the new vehicle (`purchaseDate`) — to be confirmed against the issued policy | **not read or passed** |
| TP policy end date | start + 5 years − 1 day for "5 Year Long Term Liability Only" — to be confirmed against the issued policy | **not read or passed** |
| TP policy number | issued by National only **after the customer pays the payment link** | **not read or passed** |

What exists: the OnlinePolicy model has `policyNumber` and `proposalNumber`. Nothing in the automation writes the insurer's number
for National — `national.js` reads **nothing** from the portal (not even the proposal number; only the Reliance flow saves
`proposalNumber`). `partRunner.pickResult` would carry a `policyNumber` / `proposalNumber` in a part's `result` if a flow returned one.

**The timing catch:** "TP finished" today means the payment link was **sent** (job `completed`). The policy number does not
exist yet at that moment. The OD therefore starts as soon as the link is out — before there is a number to give it.

### 12.3 What the hand-off will need (when the Reliance OD form is built)

1. **A step that reads the TP's policy number (and dates) from National** — after payment. Needs: which screen / search on National's
   portal shows it (proposal number → policy number? the "view policy" page?). Per-part storage: `parts[tp].result`
   (`policyNumber`, `startDate`, `endDate`, `insurer`).
2. **`buildPartFormData` for the `od` part** adds `tpPolicy: { insurer, policyNumber, startDate, endDate }` from the TP part's
   result, and the Reliance OD handler types it into "exist third party insurance".
3. **The gate (§4.0) means "TP details available"** instead of "TP bought" if the number only exists after payment. Decision for
   the owner: start the OD when the link is sent (the OD form cannot be completed without the number), or when the TP policy has been
   issued (the OD can wait for hours or days for the customer to pay).

### 12.4 What was added — by area

**Automation (`Rayal-policy-form-automation`)**
- `multiCompany/tpCompany/nationalTP/` — `nationalTPForm.js`: a duplicate of `fullPolicycompany/national.js` (untouched) with the
  `[TP]` changes listed in its header: **1** require depth · **2** failure screenshots under `screenshots/multiCompany/` · **3** the plan
  "5 Year Long Term Liability Only" (exact match, read back, never retried when missing) · **4** no IDV, no Manufacturer's Selling
  Price, no discount % · **5** plan re-checked before the quote + Breaker checkpoints `National TP/plan`, `/quote`, `/payment` ·
  **6** no inline Brisk certificate · **7** a plan error is a non-retryable failure · **8** the portal's Compulsory PA is the policy's
  year (1 or 5), "No" only when PA Cover is bought from Brisk. `tpPlan.js` (plan select, reads `textContent`, waits for the list),
  `tpPa.js` (`portalPaTerm`), `tpConfig.js` (the switch), `stopBeforePlan.js` (the stop while the switch is `false`),
  `nationalTP.js` (feature gate, switch, `prepareNationalTp`: nominee fallback, `[E101]` for an unusable PA term or no nominee).
- `lib/jobSequence.js` + `server.js processRelianceQueue` — an OD job (old two-job shape) is held until the TP job of the same policy
  is `completed` / `completed_with_errors`.
- Tests: `test/nationalTP.test.js` (also the drift guard: the copy may differ from `national.js` only in `[TP]` lines),
  `test/jobSequence.test.js`.

**Backend (`RayalBrokers-backend`)**
- `shared/jobParts.js` — `buildJobParts` gives the `od` part `dependsOn: "tp"`; `legacyJobsToParts` gives the two-job OD the same, so the
  list reads "Waiting for TP to finish". `shared/policySettings.js validateSettings` — a present PA term other than 1 or 5 on a National
  TP is refused (a missing one keeps the model default 1). Tests: `test/jobParts.test.js`, `test/policySettings.nationalTpYears.test.js`.

**Frontend (`OnlinePolicy/`)**
- `BasicPolicyDetailsStep.js` — **one** "No of Year *" field for a National TP: in the TP panel while PA Cover is not ticked, inside PA
  Cover Details (the field that was always there) once it is; no default, must be picked. `validationSchemas.js` (`paCoverYears`),
  `constants/initialValues.js` (`_paYearsChosen`, UI-only), `OnlinePolicy.js` (a saved policy counts as chosen), `utils/partChanges.js`
  (a year edit flags a National TP part), `utils/policyParts.js` + `AutomationStatusCard.js` ("Waiting for TP to finish", never "Blocked").

### 12.5 Settings (automation `.env`)

| Setting | Default | Meaning |
|---|---|---|
| `MULTI_COMPANY_AUTOMATION_ENABLED` | `false` | master switch for every OD / TP handler |
| `NATIONAL_TP_FORM_ENABLED` | **on** | `false` holds a National TP at "Your Plan" (lists the plans, stops) |
| `OD_WAITS_FOR_TP` | **on** | `false` makes OD and TP independent jobs again |
| `BREAKER_ENABLED`, `BREAKER_STOP_AT` | off | stop at `National TP/quote` to look at the quote before the payment link goes out |
| `POLICY_JOB_PARTS_ENABLED` (backend) | `false` | one job per policy with parts; off = the old OD job + TP job |

### 12.6 Behaviour worth knowing

- **The payment link goes to the customer.** A National TP runs to "Send Payment Link" unless the Breaker or the switch holds it.
- **PA:** the portal's Compulsory PA = the policy's year. PA Cover with Brisk keeps it on "No" (Brisk's certificate is the cover).
  With PA Cover off and a year picked, the portal quote includes PA but the policy's premium does not — tick PA Cover → National to
  put the amount in.
- **A TP that stops never lets its OD run** (switch `false`, or a TP handler that is still login-only).
- **Operator messages** go through `beautifyError`, which keeps only the text after the last colon: one colon, no driver text (§7).

### 12.7 Open decisions

1. When does OD start — when the TP payment link is sent (today) or when the TP policy has been issued (§12.3)?
2. Where on National's portal is the TP policy number (and are the dates) read? Needs the screen or the steps.
3. A TP `completed_with_errors` (bought, a document upload or Brisk step failed) releases the OD today. Should it?
4. TPPD Restrict is not applied on the portal (neither is it in the full flow).

## 13. KSHEMA TP — the duplicate of the full-company KSHEMA flow

Same idea as National TP (§12): a third-party-only policy at KSHEMA is bought **first**, and the OD of the same policy (for example
Reliance) waits for it. The waiting needed no new code — `lib/jobSequence.js` and `dependsOn: "tp"` do not look at the company —
so a KSHEMA TP that finishes releases the OD and one that stops keeps it "Waiting for TP to finish" (`test/kshemaTP.test.js`).

### 13.1 What was added (`multiCompany/tpCompany/kshemaTP/`)

| File | What it is |
|---|---|
| `kshemaTP.js` | the handler: feature gate (`[E110]`), the notice about the product text, then `kshemaTPForm`. It does **not** go through `runHandler` (the form has its own browser and login, like `kshemaForm.js`). Nothing is prepared before the browser: the bundled KSHEMA dispatch prepares nothing either. |
| `kshemaTPForm.js` | duplicate of `fullPolicycompany/kshemaForm.js` (untouched) with `[TP]` changes: **1** require depth · **2** failure screenshots under `screenshots/multiCompany/kshema/` (10-day S3 lifecycle prefix) · **6** no inline Brisk certificate · **7** an unexpected error is stage `tp-form` · **8** Breaker checkpoints `KSHEMA TP/quote`, `KSHEMA TP/payment`. |
| `kshemaTPQuoteForm.js` | duplicate of `fullPolicycompany/kshema/kshemaQuoteForm.js` (untouched; its field tables are module constants, so it had to be copied) with `[TP]` changes: **3** the Product Type is `tpProduct.js`, at the same place in the field order, plus the stop while the text is not set · **4** no IDV (and no range check), no OD discount, no add-ons / Nil Depreciation · **5** a TP quote may have no add-ons page: the proposal page also counts as "the quote went through" · **8** checkpoint `KSHEMA TP/product`. |
| `tpProduct.js` | Product Type: exact match (never the original's "contains" fallback), read back, `TpProductError` listing the portal's options, never retried. |
| `tpConfig.js` / `stopBeforeProduct.js` | the two `.env` settings, and the stop that lists the options. |

The helpers in `fullPolicycompany/kshema/` (session manager, log, toast, fields) are shared, not copied — they have no TP/OD fork.
`test/kshemaTP.test.js` is the drift guard: each copy may differ from its original **only** on `[TP]` lines, so a portal fix made in
the original fails the test until it is ported.

### 13.2 What it does today

- **Default (no `KSHEMA_TP_PRODUCT_TYPE`):** logs in, fills the customer and vehicle fields that come before the Product Type, lists
  the portal's Product Type options in the stop message (stage `tp-product`, E100, not retried) with the dropdown left open on the
  held browser. Copy the liability-only option's text into `.env`, restart, run the policy again.
- **With the text set:** chooses it (exact, read back), fills the rest, submits the quote, proposal, nominee, KYC, and ends at the
  Razorpay QR with the payment link saved — like the full-company flow. The job is then `completed` and the OD is released.
- The **Mongo writes** (`proposalPdf`, `kycLink`, `paymentLink`) are kept so the app still shows the payment link. They write the
  *policy* document, not the part. Harmless while the Reliance OD is login-only; they **must become per-part** before the OD form is
  built, or the OD will overwrite the TP's link.

### 13.3 Not proven / open

1. The liability-only **Product Type text**, and whether the quote page hides IDV and the add-ons page — unverified, found by running with the Breaker.
2. **Used vehicles:** the full-company KSHEMA flow files new vehicles only ("Is New Vehicle" is always Yes) and the copy keeps that.
3. A KSHEMA TP's **PA**: a portal part has PA only when it `carriesPa`; the PA year handling is the full-company one, untouched.
4. Same open decisions as §12.7 (when the OD starts: link sent vs policy issued; `completed_with_errors` releasing the OD).
5. Frontend/backend: nothing changed. Possible follow-ups: `partChanges.js` `isNationalPart` nominee group for a KSHEMA TP, and whether a KSHEMA TP should force a "No of Year" pick as National's does.
