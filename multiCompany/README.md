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
| `KSHEMA_SLOW_FIELD_RECOVERY_ENABLED` | automation `.env` | **on** (anything but `false` / `0` / `no` / `off`) | The **full-company KSHEMA flow and the TP copy** (§16). On: (1) when the Insured Declared Value box (after the Product Type) or the PA year / reason dropdown (after the PA Cover checkbox) is still missing after its normal 10 s wait, the Product Type is switched to the liability option and back to Bundled, or PA Cover is unticked and ticked again, and the field is looked for again; (2) when the portal answers a PA Cover change with a gateway / server error ("Http failure response … 504") PA Cover is unticked and ticked again and the section is filled again (§16.4). Two tries at most each. `false`: both are reported straight away, as before. |
| `KSHEMA_SLOW_FIELD_WAIT_MS` | automation `.env` | `10000` | How long to look again after each try (kept within 3000–30000). |

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
    reliance/relianceMultiForm.js       DUPLICATE of fullPolicycompany/relianceForm.js + tagged [MC] changes — Reliance OD AND TP, see §15
    reliance/relianceMultiFormSpec.js   the [MC] changes as data; regenerates / checks the duplicate (--write)
    reliance/multiConfig.js             RELIANCE_MULTI_FORM_ENABLED, RELIANCE_OD_PRODUCT, RELIANCE_TP_PRODUCT
    reliance/stopBeforeProduct.js       the stop taken while the part's product text is not set (lists the options)
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
- *the portal's Compulsory PA for Owner Driver* (`tpPa.js` `portalPaTerm`, `[TP] 8`) is **No** when PA Cover is off, and **No** when it is
  bought from **Brisk** (`settings.PACompany`; Brisk's certificate is the cover, so the customer is not covered and charged twice); it is
  the policy's year — 1 or 5, `paCoverYears` — **only when PA Cover is ticked and bought from National**. (Changed 2026-10-14: a saved
  year used to go to the portal even with PA Cover off, so the quote carried PA the policy's premium did not.) "PA Cover on" is the
  part's own `paCover`, which `lib/partRunner.js buildPartFormData` sets only for the part that `carriesPa`;
- *left exactly as the full flow:* the model-not-found tick, the PA radio / "No of Years" mechanics (only which term they get changed),
  nominee, financier, Vahan, the payment link. TPPD Restrict is not applied on the portal (neither is it in the full flow);
- *prepared before the browser opens* (`prepareNationalTp`, what `server.js dispatchBundled` does for bundled National only): the
  saved default nominee fills what the policy left blank and `[E101]` when there is none at all (National demands one on every quote);
  the PA term must be exactly 1 or 5 when PA Cover is bought from National (`[E101]`) — the original silently fell back to "1 Year". The
  Online Policy form asks that term ("No of Year *", no default) **only when PA Cover is ticked and National is the PA company**, in PA
  Cover Details (the field that was always there); with PA Cover off or from Brisk nothing is asked;
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

- **Form filling** for National OD and KSHEMA OD: they log in and then stop with "form not built yet". National TP, KSHEMA TP and
  **Reliance OD / TP** have a form (next bullets, §15). A multi-company policy with a National or KSHEMA OD shows that part as
  "not automated yet" (`failed_login_form`, `stopped`) — the job's per-part status and the retry rules are in place, that portal
  handler is not.
- **Reliance OD / TP** are built (`common/reliance/relianceMultiForm.js`, §15) but **start held at the Sub Product dropdown**: the
  OD-only / TP-only product text is not known, so until `RELIANCE_OD_PRODUCT` / `RELIANCE_TP_PRODUCT` is set a run lists the
  portal's products and stops. Everything after the product is the full-company Reliance flow, unchanged — what an OD-only /
  TP-only portal does differently (IDV, a previous-policy step, a renewal) is found one stop at a time.
- **National TP** is built (`tpCompany/nationalTP/`, §5) and **on by default**: it selects "5 Year Long Term Liability Only" and goes on to
  buy a third-party-only policy and send the payment link. `NATIONAL_TP_FORM_ENABLED=false` holds it at "Your Plan" (the plan list in the message).
  Not proven against the live portal yet: how the TP plan page differs (a field that appears or disappears), whether the portal
  asks the Manufacturer's Selling Price in the model-not-found mode without an IDV. Use the Breaker checkpoints for the first real run. While Reliance OD is
  held at its product (§15) a two-company policy buys only its TP half.
- **KSHEMA TP** is built (`tpCompany/kshemaTP/`, §13) but **starts held at the Product Type**: the liability-only option's text is
  not known, so until `KSHEMA_TP_PRODUCT_TYPE` is set a run lists the portal's options and stops. What the TP quote page hides
  (IDV, the add-ons page) is learnt from the Breaker runs (`KSHEMA TP/product`, `/quote`, `/payment`) — nothing here is proven on
  the live portal yet.
- **TP → OD hand-off** (the TP policy's number and dates reaching the OD form) — **not built**, see §12.2. Ordering is (§4.0); the data
  is not passed yet, and National's flow reads no number or date from the portal at all.
- **Multi-company Brisk PA waits for the OD part** to succeed (same as the bundled flows, which buy Brisk only after the
  portal part). Until the OD handler can finish (Reliance OD is held at its product, §15; National OD and KSHEMA OD are login-only), that PA stays "waiting for OD".
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
  **6** no inline Brisk certificate · **7** a plan error is a non-retryable failure · **8** the portal's Compulsory PA is "No" when PA Cover is
  off or bought from Brisk, and the policy's year (1 or 5) only when it is bought from National. `tpPlan.js` (plan select, reads `textContent`, waits for the list),
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
- `BasicPolicyDetailsStep.js` — **one** "No of Year *" field for a National TP, inside PA Cover Details (the field that was always
  there) and only when PA Cover is ticked and National is the PA company; no default, must be picked. (It used to be asked in the TP
  panel on every National TP policy; removed 2026-10-14 — PA off is "No" on the portal.) `validationSchemas.js` (`paCoverYears`),
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
- **PA:** the portal's Compulsory PA is "No" with PA Cover off or from Brisk (Brisk's certificate is the cover), and the policy's year
  (1 or 5) only with PA Cover bought from National — so the portal quote and the policy's premium agree.
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
| `kshemaTPQuoteForm.js` | duplicate of `fullPolicycompany/kshema/kshemaQuoteForm.js` (untouched; its field tables are module constants, so it had to be copied) with `[TP]` changes: **3** the Product Type is `tpProduct.js`, at the same place in the field order, plus the stop while the text is not set · **4** no IDV (and no range check), no OD discount, no add-ons / Nil Depreciation · **5** a TP quote may have no add-ons page: the proposal page also counts as "the quote went through" (its test is replaced by 11) · **8** checkpoint `KSHEMA TP/product` · **11** Save and Continue is checked by KSHEMA's step bar, see §13.5. |
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
6. **PARTLY OPEN (2026-10-16): "System Error More than one rate found for rate" after Save and Continue of a KSHEMA TP-only policy.** The detection is fixed (§13.5, not run live yet); *why* KSHEMA's rater answers that for this quote is still unknown. Evidence, candidates and next steps: root README "OPEN ITEMS", item 1 (`../../README.md`).

### 13.4 Telling the two KSHEMA flows apart in the log (2026-10-16)

The KSHEMA helpers (`kshemaLog`, `kshemaFields`, `kshemaSection` ...) are shared by both flows, and the log bracket was a fixed
`[kshema Full ]` — so a **TP-only** policy printed "Full" on every line and looked like it was running the full-company flow
(a policy edited from OD + TP to TP only, job part `tp`, was reported as "working like full"; it was running this handler all along).

- `kshemaTP.js` now runs the whole form under `kshemaLog.withFlow("TP", ...)`: its lines say **`[kshema TP   ]`**, and the first one is
  `▶ KSHEMA third-party-only flow (Product Type "…")`. The full-company flow still prints **`[kshema Full ]`**, byte for byte.
  `AsyncLocalStorage`, so two jobs in one process keep their own word.
- Other proof of which flow runs: the queue line — `[KSHEMA Queue][tp] processing portal part …` (a `portal` part with key `tp` is what
  resolves to `fillKshemaTP`; the bundled full-company part says `bundled part` and key `motor`) — and, at the Product Type step,
  `✅ TP Product Type selected: "…"`, which only this flow prints.
- `FLOW_LOG_PREFIX_ENABLED=false` (the Reliance flow tag's switch) puts the old fixed `Full` back. Tests: `test/kshemaLog.test.js`.

### 13.5 Save and Continue is checked (2026-10-16)

**What went wrong.** A TP-only run showed KSHEMA's toast "System Error More than one rate found for rate" after Save and Continue; the automation did not see it, carried on to the Add-ons page although it
never opened, and the toast was finally read after an unrelated click and blamed on "Do you want add-ons?". Looking at the run's still-open window: the portal was on the **Quote** step (its step bar marks the
active step `.stepper-item-text.stepper-active`), and "Save and Finalize" is a permanent button on the Quote page. `[TP] 5` took that button (or the quote-download icon) as "the next page opened", which is true
on the first poll, so `submitQuoteForm` returned OK before KSHEMA had answered. `POST /api/v1/quote` had returned 200 and the page made no request after it.

**What it does now** (`fullPolicycompany/kshema/kshemaSaveVerify.js`, used only by `kshemaTPQuoteForm.js` as `[TP] 11`; the full-company quote form never calls it):

| Where | Rule |
|---|---|
| `submitQuoteForm` wait loop (15 s) | the toast is read first, then the step bar: moved = the active step is no longer "Quote". An error toast ends it with `KSHEMA refused Save and Continue - its message was "...". The run stopped there and nothing after the quote was filled. ...` (no colon in the sentence) |
| after the move | `lateRefusal` keeps watching for the settle window (`KSHEMA_SAVE_SETTLE_MS`, default 3000, kept within 1000-15000): an error toast (`KSHEMA opened the next step and then showed an error - its message was "..."`) or the step falling back to "Quote" fails the quote; a quiet window logs `KSHEMA is on the "Addon" step and showed no error for 3 s` |
| no move, no error for 15 s | `Save and Continue did not open the next page within 15 seconds. No error message appeared. ...` (the portal's own words are added when it showed a message that is not worded as an error); the existing silent-save diagnosis (invalid fields, one refill and one more Save) still runs first |
| `fillAddonsDetails` | answered only when the step is "Addon"; "Quote" fails with `The Add-ons page is not open - KSHEMA's step bar still shows Quote ... Nothing was answered.`; any other step (Summary) skips with a log line |
| `fillPremiumDetails` | a third-party policy never types a discount (it is zeroed; the saved policy may still carry an old one), so the step logs `Premium & Discount: not used for a third-party policy, skipping` once instead of two "nothing to enter" lines |

A step bar that cannot be read (the portal changed) falls back to the old test with one warning, so there is no new way to fail. **Switch `KSHEMA_SAVE_VERIFY_ENABLED`** (on unless false / 0 / no / off): off = the old test, the old
wording and the old Premium lines, exactly (`test/kshemaSaveVerify.test.js` proves the old bug comes back with it off).

**Not known.** Which step a long-term TP-only quote lands on after a good Save ("Addon" or "Summary") and everything after it. Why KSHEMA's rater finds more than one rate — root README "OPEN ITEMS" item 1.
Tests: `test/kshemaSaveVerify.test.js` (27: the step reader, the 2026-10-16 regression, the late watch, the guards, the sentences, the real `submitQuoteForm` against a fake page that behaves like that run, the wiring);
`test/kshemaTP.test.js` (drift guard) updated for `[TP] 11`.

## 14. OD only / TP only from one insurer, and PA Company / Brisk on a TP-only policy

A policy can now be sold as **only OD** or **only TP** by ONE insurer (backend `POLICY_COVER_CHOICE_ENABLED`, backend README §8).
For the automation that is simply a job with one portal part — `od` or `tp` — and no dependency:

| What | How it runs |
|---|---|
| The job | one `tp` (or `od`) portal part at the policy's insurer; `routingConflict` already allowed a lone portal part. A job whose `formData.coverage` is `od`/`tp` **refuses a bundled `motor` part** (it would buy the whole comprehensive policy) — new in `lib/partRunner.js`. |
| Handlers | National TP, KSHEMA TP and Reliance OD / TP run for real (Reliance's starts held at the product, §15). National OD and KSHEMA OD are login-only stubs: that part stops "not automated yet" (`failed_login_form`, stopped, not retried). |
| PA — Company | the part `carriesPa` and PA is bought with it: National gets the year (1/5), KSHEMA ticks PA, picks the year and adds the nominee. |
| PA — Brisk | the part does not carry PA; Brisk is its own `pa` part with `dependsOn` = that part (waits for it, never runs if it failed). National's portal stays "No"; KSHEMA's PA is off with the reason. |
| PA — off | National: the year as picked; KSHEMA: unchecked + reason, no nominee. |

`test/standaloneCover.test.js` walks the whole chain for National and KSHEMA × {off, Company, Brisk}: backend part shape →
`buildPartFormData` → the handler's own PA rules. **One change in the KSHEMA TP copy** (`[TP] 9`): the nominee entry now uses the
same `isCompanyPaCover` rule as the PA checkbox (the original tested "PA on and not Brisk" there, a whitelist for the checkbox, so
an insurer name only one of them knew left PA unchecked but still added a nominee). The full-company original is untouched.

**Not changed, flagged.** KSHEMA's `paCoverYears` is fuzzy-matched against the portal's text without a 1–5 check and defaults to
"1" when missing (the form's default is 1 too). National's `settings.PACompany` is what turns Brisk's PA into "No": a job with
no `settings` would send the year (every current job carries it).

## 15. Reliance OD and TP — the duplicate of the full-company Reliance flow

Same idea as National TP (§12) and KSHEMA TP (§13), with one difference: Reliance OD and Reliance TP share **one** duplicate,
`common/reliance/relianceMultiForm.js`, because they are the same portal flow with a different product. The handlers
(`odCompany/relianceOD/relianceOD.js`, `tpCompany/relianceTP/relianceTP.js`) check the feature gate (`[E110]`) and call
`fillRelianceMultiForm({ ...data, policyType: "od" | "tp" })`. The form has its own browser, login, error mapping and cleanup,
exactly like `relianceForm.js`, so it does **not** go through `runHandler`. It is loaded when a part runs, not at server start.

### 15.1 What differs from `fullPolicycompany/relianceForm.js` (untouched) — each line tagged `[MC]`

| Tag | Change |
|---|---|
| `[MC] 1` | require paths three folders deeper; the browser / session manager, S3, captcha, error catalogue, Brisk helpers and the cover / KYC modules (`relianceCoverDetails`, `relianceCoverSettle`, `relianceKycSubmit`, `relianceKycUpload`) are **shared**, not copied — so the 2026-10-14 fixes (cover refusal, PA re-tick, KYC upload / SUBMIT / toast) are in both flows by construction |
| `[MC] 2` | failure screenshots under `screenshots/multiCompany/reliance/` (10-day S3 lifecycle prefix) |
| `[MC] 3` | the **product** is `RELIANCE_OD_PRODUCT` / `RELIANCE_TP_PRODUCT` (exact match, `multiConfig.js`) instead of "Two Wheeler Package Bundled (Only New Veh.)". Not set → the run opens the dropdown, **lists the portal's products and stops** (`stopBeforeProduct.js`, stage `od-product` / `tp-product`, E100, not retried) |
| `[MC] 4` | no inline Brisk certificate — PA through Brisk is its own `pa` part |
| `[MC] 5` | an unexpected error is stage `od-form` / `tp-form`; Breaker checkpoints `Reliance OD/product`, `/quote` (before Calculate Premium), `/payment` (before Pay) — and `Reliance TP/…` |
| `[MC] 6` | the function is `fillRelianceMultiForm`; OD / TP comes from `data.policyType` (set by `buildPartFormData`) |

Deliberately **not** changed: IDV, discount, Get Coverage Details, PA / helmet / TPPD, financier, address, Calculate Premium, Save,
KYC, Pending Quotes, Pay, the wallet hold. A difference of an OD-only / TP-only portal therefore shows up as a clear stop (or a
portal message) at the first step that differs, and gets its own tagged line when the HTML of that step is known.

**The copy is generated.** `common/reliance/relianceMultiForm.js` is `relianceForm.js` plus the `[MC]` changes listed in
`common/reliance/relianceMultiFormSpec.js`, applied by that file — do not edit the copy by hand. After a fix in `relianceForm.js`:

```
node multiCompany/common/reliance/relianceMultiFormSpec.js --write   # regenerate the copy
node multiCompany/common/reliance/relianceMultiFormSpec.js           # check only
```

`test/relianceMultiForm.test.js` is the drift guard: it fails unless the copy is **exactly** what the spec makes of the original
(not just "differs only on `[MC]` lines" — an edit right next to a tagged block would hide there), and it fails with a clear message
when the original changed inside the text one of the `[MC]` changes is anchored on (re-state that change in the spec). It also
runs the real copy down its failure path, the handlers' gating and the product stop. The test file stubs the browser, S3 and the
recorder for the whole file (see its SAFETY block), and `npm test` preloads `test/support/noRealWorld.js`, which makes any real
browser start or S3 call from a unit test throw — the copy is the real flow.

### 15.2 Settings (automation `.env`)

| Setting | Default | Meaning |
|---|---|---|
| `RELIANCE_MULTI_FORM_ENABLED` | on | off → the parts behave as before the form existed (OD: login, Motors → Two Wheeler, stop; TP: login, stop) |
| `RELIANCE_OD_PRODUCT` / `RELIANCE_TP_PRODUCT` | empty | the exact option text; empty → list the products and stop |

`MULTI_COMPANY_AUTOMATION_ENABLED` still comes first. First real run: set the product text from the stop message, then
`BREAKER_ENABLED=true` + `BREAKER_STOP_AT=Reliance OD/quote` to look at the filled form before anything is saved.

### 15.3 Retry rule

A Reliance OD / TP part saves a proposal at Reliance like the bundled part does, so the "never run again after the proposal is
saved" rule of `lib/partRunner.js` covers it (`savesProposalPart`): a job timeout after `proposalNumber` changed becomes
`failed_post_submission` (E401), not an automatic re-run. National and KSHEMA portal parts keep the plain retry.

### 15.4 Not proven / open

1. The OD-only / TP-only **product text**, and every step that differs for those products — unknown until run with the Breaker.
2. `kycStatus`, `kycUrls` and `proposalNumber` are single fields on the policy: with OD at Reliance and TP at another insurer both
   write them. Per-part notes are a later step (same caveat as §13.2).
3. The real KYC page after a **good** SUBMIT is known from its markup, not from a successful run.

### 15.5 When the KYC does not work (shared with the full-company flow)

`fullPolicycompany/relianceKycFallback.js` (switch `RELIANCE_KYC_FALLBACK_ENABLED`, default on) — used by `relianceForm.js` and, being
shared, by this copy. Any way the KYC step can fail (a refusal toast, an upload problem, no answer / timeout, the DO KYC link
missing, no Aadhaar on the policy):

1. the screenshot of the error is taken the moment the toast is first seen (~5 s lifetime), kept in memory, uploaded only if the KYC
   failed (S3 `screenshots/kyc/`, `KYC_SCREENSHOT_RETENTION_DAYS`, default 30) and becomes the failure's `screenshotUrl`;
2. the KYC tab is closed and the run goes to Pending Quotes → ticks **this** proposal (exact number, never "the first one") → the
   TP declaration → Pay, and **stops there**: nothing is paid, no payment link is sent, no wallet step, no Brisk PA certificate;
3. `proposalLink` (the View Policy page DO KYC was clicked on) and `paymentLink` (the page after Pay) are saved on the policy — the
   "Proposal Page" / "Make Payment Page" cards of the View page. A link on another website (a KSHEMA TP's customer link) is never
   replaced; a new attempt clears the old Reliance-hosted ones when its KYC step starts;
4. the job ends `failed_post_submission` (stage `post-calculation`, never auto-retried) with one sentence: what Reliance said, what
   was done, what to do next.

Not proven: whether Reliance lets a KYC-pending proposal reach its payment page (then its own words are in the sentence and only the
proposal page is saved), and whether the saved payment URL can be reopened later in a fresh session.

### 15.6 The Proposal Page / Make Payment Page links on every run (also when the KYC worked)

`RELIANCE_PROCESS_LINKS_ENABLED` (default on). The Reliance flow — and this copy — saves on the policy, the moment the run is on
them (so a later failure cannot lose them):

- `proposalLink` ("Proposal Page" on the View page) = the address of **Pending Quotes**, where the proposal is listed and paid from;
- `paymentLink` ("Make Payment Page") = the page Pay opens, only when it is a different page from Pending Quotes (a wallet policy
  stops on it — the link is saved before the stop).

Rules: a link on another website (a KSHEMA TP's customer link) is never replaced; a login page is never saved; a new attempt clears
the old Reliance-hosted ones when its KYC step starts. On a failed KYC the fallback (§15.5) saves the same pair.
Not proven: the Pending Quotes address is the same for every policy of an agent login (it carries a fixed page token), so the card
opens the list and the operator picks the proposal named on the card; whether the Pay page address can be reopened later.

### 15.7 Wallet payment with the CDT option (shared with the full-company flow)

`fullPolicycompany/relianceWalletCdt.js` (switch `RELIANCE_WALLET_CDT_ENABLED`, default on) — a wallet policy no longer only holds on
the payment page after Pay. In order, on the panel Pay opens:

1. the login's payment options are read; **no CDT option** (`#rdbtnPaymentOptionCDT`: missing, hidden or disabled) is an **error**
   — "this Reliance login does not have the CDT option", the other options named, a screenshot — job `failed_post_submission`,
   never auto-retried;
2. exactly one proposal ticked and it is this one (a wallet policy finds its checkbox by the exact number only — no "first
   checkbox", no longer number that merely contains it);
3. CDT clicked, the **payable amount** (`#txbPayableamountCurrency`) read, the **same amount** typed into `#txtcdtReducedCurrency`
   (real keystrokes + Tab, script fallback) and read back **equal to the paisa**; a refusal dialog / alert (for example an
   insufficient CDT balance) is an error with Reliance's words, nothing added;
4. **Add** (`#btnAddRowToGrid`) pressed once — only after the read-back;
5. then the run **waits**: stop `reliance-wallet-cdt-added` with the amount, what the page showed (dialog text and button labels)
   and a screenshot. Nothing is submitted or paid.

Amounts are whole paise (`parseRupees` / `formatPaise`); the amount is Reliance's own and is not compared with the premium on the
policy (an agent's payable amount may differ). First look: `BREAKER_STOP_AT=Reliance/wallet-cdt-add` (or `Reliance OD/…` in the
copy). Not proven: how Reliance's currency widget takes the typed value, what Add validates, what comes after Add.

**2026-10-15 — the balance popup.** Reliance's "Your CDT Account Does not have sufficient balance to make payment" popup is a plain `div` (`closePopUp()`, the red `critical.png`, the sentence in a span), not a `.ui-dialog` / `.k-window`, and "does not have sufficient" matched no error word, so the step walked past it. The popup is now read after typing and after Add (popups already on the page before typing are ignored), "not sufficient / not enough / sufficient balance" count as refusals, the step waits up to 4 s after Add when the grid did not grow and nothing was said, typing scrolls to and focuses the box and retries once before the script fallback, and a balance refusal says "The CDT balance of this Reliance login is lower than the payable amount - top it up, then run the policy again." (screenshot while the popup is open). Not proven: a popup inside an iframe would be missed. See also the repo guide, section 5.

### 15.8 Pending Quotes has pages (shared with the full-company flow)

`fullPolicycompany/relianceQuotesPaging.js` (switch `RELIANCE_QUOTES_PAGING_ENABLED`, default on). Pending Quotes is a Kendo grid,
10 rows to a page, so with more than 10 pending proposals the one being paid can be on page 2. Every lookup used to read only the page
that was open (2026-10-14: R141026119597 on page 2 of "11 - 14 of 14 items" → "not listed"); the link path then ticked the **first
checkbox** — another customer's proposal.

`findProposalAcrossPages()`: wait for the proposals grid (the `.k-grid` holding the proposal checkboxes — the payment-details grid's own
pager is never read), go to page 1, look at each page for the **exact** number (a whole token), click the pager's next link and wait for
the page, the mask and the rows, stop on the page it is on. Used by STEP 8 for wallet **and** link policies, and by the KYC fallback.

- A proposal that is nowhere in the list is an **error for both** ("looked at page 1 (10 rows), page 2 (4 rows), 14 items in the list"):
  nothing ticked, paid or sent. The first-checkbox fallback only exists with the switch off.
- After Pay the grid may show another page, so the CDT step accepts "no ticked box in view" when the selection was verified before Pay;
  another proposal ticked in view is still refused.
- Not proven: the real grid's DOM is known from the pager markup only; a page that does not change after the click ends the search with
  that reason.

### 15.9 Submit Details, the policy number and the policy PDF (shared with the full-company flow)

`fullPolicycompany/relianceWalletIssue.js` (switch `RELIANCE_WALLET_SUBMIT_ENABLED`, default on; off = the wait after Add of §15.7).
After the CDT row is added the run issues the policy. It really pays, so every step refuses rather than guesses:

1. **Gate** (start of the run, before any browser or proposal): `onlinePolicy.walletPayment.state` of `submit-pressed`, `issued` or
   `unconfirmed` refuses the run — job `failed_post_submission`, never retried — "a CDT payment was already submitted … not started so
   the customer is not charged twice". `failed` (a refusal that stayed on the payment page) and no note run as normal. One note per
   policy, and one per part of a multi-company policy (`walletPayment_od`, `walletPayment_tp`).
2. **Before the press**: the new row of the payment-details table shows the amount to the paisa (the word CDT preferred; a single new row
   with the exact amount and no CDT word is accepted and logged); the same row twice is refused; `#btnPaymentSubmit` shown and enabled;
   no message of Reliance's open (a harmless one is given 4 s to close; it is read, never clicked away). Breaker checkpoint
   `…/wallet-cdt-submit`.
3. **The note, then the press**: `walletPayment = {state: "submit-pressed", proposalNumber, amountPaise, jobId, at …}` is written with a
   **guarded** update (matches only when no blocking note is there — two runs of one policy cannot both pass); if it cannot be written
   Submit Details is not pressed. Submit Details is pressed **once**: a real click; a script click only when the real one was refused
   before it happened; a click that errored any other way (renderer timeout) is treated as pressed and never repeated.
4. **The answer** (up to 120 s): the schedule link `a[href*="GenerateMotorSchedule"]` with one plausible `policyNo=` (cross-checked with
   "Your Policy No …"; a contradiction is *unconfirmed*, nothing saved) → `issued`; a refusal (alert / dialog) that is still there 5 s
   later on the payment page, with no success words → `failed`; no answer / the login page / "successful" without a number →
   `unconfirmed`, and an unconfirmed payment blocks re-runs exactly like an issued one.
5. **The number**, at once: `onlinePolicy.policyNumber` and the `policy` record — found by `isOnlinePolicy` + the client + the OP…
   placeholder id (exactly one; none or several is reported, never guessed). First writer wins: a different number already there is
   reported. A unique-index refusal is reported and the PDF is still fetched.
6. **The PDF**: the number's link, a 20 s look (**live finding, 2026-10-14: on the real portal this link takes the tab to the
   portal's own `/Motor/GenerateMotorSchedule?policyNo=…` HTML page — Chrome recorded no download**); then **View Policy by address**:
   the menu link's own `href` read from the page (the submenu need not open — on that page its scripts had failed and the hover
   opened nothing, "the View Policy item was not found under Utilities"), then `/Policy/ViewPolicySearch` (the page the KYC step
   reaches), the Utilities hover + click only last. Then the search option exactly "Policy Number" (read back; the Kendo API if the
   list click does not take) → the number typed (read back) → Search (once more through the page's own `GetPolicySearchDetails()` if
   the click did nothing) → the row whose link text **is** the number (never "the first") → a new, finished (no `.crdownload`, size
   stable) file whose first bytes are `%PDF` in the job's own download folder. Neither way = an **error**; the number stays saved and
   the note stays `issued`.
7. **Stored**: `Policy/<d><m><yyyy>-<9 random>-Policy.pdf` (the backend's own naming) in `AWS_BUCKET_NAME`, set as `policy.policyFile`
   (when empty) and `onlinePolicy.mergedPolicyPdf` (when empty — the merge step replaces it). Then the run **continues** to the Brisk /
   merge steps and the policy completes. A problem saving on the policy collection (no record, two records, duplicate number, a file
   already there) is a **completion warning** ("completed with errors"), not a failure — the policy is issued and the PDF is stored.

**An issued policy is finished, not refused** (`RELIANCE_WALLET_RECOVER_ENABLED`, default on): a re-run whose note says `issued` with a
plausible number logs in and skips the form body completely (no proposal, no KYC, no Pay, no Submit Details) — `recoverIssuedPolicyPdf`:
the number is saved again (first writer wins), the PDF comes from View Policy by the number, is stored (not a second time if the policy
already has its file) and set on the policy; then the normal Brisk / merge steps run and the policy **completes**. No PDF and none
stored = the same error as above, "Nothing was paid again", `failed_post_submission`, never retried by itself. `submit-pressed` and
`unconfirmed` are still refused (a payment may or may not exist).

To clear a blocked (`submit-pressed` / `unconfirmed`) policy after checking Reliance: unset `walletPayment` (or `walletPayment_od` / `_tp`)
on its `onlinePolicy` document.

Not proven (first live run): whether Submit Details asks for a confirmation, how long it takes, the Payment Success page's exact
markup beyond the schedule link, the View Policy search option dropdown's DOM beyond `.k-input` / `.k-i-arrow-s` and the
`#txtSearchText` / `#btnViewPolicySearch` the KYC step already uses. Anything unexpected stops with Reliance's words and a screenshot.
Found on the way, not touched: `briskCertificate.js` filters `policy` documents by `onlinePolicyId` / `policyId`, fields that do not
exist on `policy` records, so its policyFile update never matches.


## 16. KSHEMA slow portal — the IDV box and the PA year dropdown

Two fields on the KSHEMA quote form only exist once an earlier answer has been processed, and the portal is sometimes slow to
render them (or never does): the **Insured Declared Value** box after the Product Type, and the **year** dropdown after the PA
Cover checkbox (ticked by default). Before this the run waited 10 s, reported `the "…" box was not on the page`, and the job ended
`failed_login_form` / `quote-pa-cover-details`, not retried (2026-10-15, job 6ad050380df69f7829bff368).

### 16.1 What it does

A field can carry `recover` (`fullPolicycompany/kshema/kshemaQuoteForm.js`; built by `fullPolicycompany/kshema/kshemaSlowFields.js`).
When the field is still not found after its normal wait, `kshemaFields.js findAfterRecovery` runs the recovery, then looks for the
field again for `KSHEMA_SLOW_FIELD_WAIT_MS` (10 s), up to **2 tries**. A field that shows up first time never reaches this code.

| Field | Recovery | Ends in |
|---|---|---|
| Insured Declared Value | the Product Type is switched to another option (the liability one: "Two Wheeler-Long term Liability only", chosen from the live list by `pickOtherOption`, nothing hard-coded), wait for the spinner + 1.5 s, then "Two Wheeler-Bundled" again (the field's own select, read back), spinner + 1.5 s | **Bundled** — the re-select always runs once a switch was attempted; a failure says the product was left on X |
| PA Cover Year (PA on) | PA Cover is unticked, spinner + 1 s, ticked again (read back), spinner + 1.5 s | **ticked** |
| Reason for unselecting PA Cover (PA off) | PA Cover is ticked, then unticked again | **unticked** |

If it still fails, the message names what was tried — `… box was not on the page even after switching the Product Type to "…" and
back to "Two Wheeler-Bundled" 2 times (waited 10 s each time)` — and the stage is non-retryable as before. There is no colon inside
the added text (`beautifyError` keeps only the text after the last colon).

### 16.2 Where the code is

- `fullPolicycompany/kshema/kshemaSlowFields.js` — new, **shared** (the TP copy requires it from there, it is not duplicated):
  the two switches, `idvRecovery`, `paToggleRecovery`, its own spinner wait (`kshemaForm.js` is replaced by `kshemaTPForm.js` in the TP
  flow, so it cannot be required from here). A recovery object holds no per-job state — two jobs run in one process.
- `fullPolicycompany/kshema/kshemaFields.js` — `findAfterRecovery`, `opts.recover` in `typeIntoField` and `selectMatOption`,
  `selectOtherMatOption`, `pickOtherOption`.
- `kshemaQuoteForm.js` **and** `kshemaTPQuoteForm.js` — the same `fillSection` hook and PA hooks, line for line (the drift guard in
  `test/kshemaTP.test.js` requires it). The copy's IDV is the `[TP] 4` empty one, so it has no IDV hook.
- Tests: `test/kshemaSlowFields.test.js` (a fake portal + a virtual clock; the real field tables and helpers run against it).

### 16.3 Not proven / open

1. Whether KSHEMA keeps Make / Model / Variant / RTO when the Product Type is switched away and back. The manual workaround it
   automates suggests it does; if it does not, the run fails at Save with the portal's own message and a re-fill step is needed.
2. The "switch away" option is whatever the live list offers (liability preferred). If the portal pops a confirmation when the product
   changes, the recovery stops with a `could not be switched` / `was left on` note — nothing is clicked blindly.
3. Vehicle / PA failures are still non-retryable. If the field never shows after two tries a re-run is the operator's call.
4. The `paCoverYear` last-resort selector (`first mat-select after any checkbox`) is unchanged.

## 17. Policy dates are India time (nominee DOB 16 → 15, fixed 2026-10-15)

A date picked on the Online Policy form (customer DOB, purchase / registration date, nominee DOB) is stored as local midnight in
India — 16 Oct 2000 is `2000-10-15T18:30:00.000Z`. The job payload used to turn it into text with
`moment(value).format("DD-MM-YYYY")`, which formats in the **timezone of the machine running it**: an IST laptop gave `16-10-2000`,
a server on UTC gave `15-10-2000`. KSHEMA typed `Nominee DOB set to "15/10/2000"` for a DOB picked as 16/10/2000; the same shift hit
`dob`, `purchaseDate` and `registrationDate` (and the DOB on a Brisk PA certificate, which re-parses `dob`) on that host.

- **Fix:** `formatPolicyDate(value, format = "DD-MM-YYYY")` in `lib/policyDates.js` (a byte-identical copy lives in the backend as
  `shared/policyDates.js`, checked by `test/sharedCore.test.js`; no requires). It reads the instant on the **India calendar** with
  `Intl` and zone `Asia/Kolkata` — the same IANA data the browser used, so wartime (+06:30) DOBs round-trip too — and falls back to
  a fixed +05:30 only when the runtime has no zone data. A bare `"YYYY-MM-DD"` is a calendar day and is kept; a day that does not
  exist (`2000-02-31`) is `"Invalid date"`, never a rolled-over neighbour; nothing there is `""`.
- **Used in:** the backend's `buildFullJobFormData` (`dao/onlinePolicyDao.js`, the source of most jobs' data) and this server's
  `buildFormDataFromPolicy` (`server.js`, thin / hydrated jobs) — **deploy both**.
- **Already queued / failed jobs** keep the old text until rebuilt; Retry or a re-save rebuilds the payload from the policy.
- No `.env` switch: it is a formatting correction (no I/O, no storage). Setting `TZ=Asia/Kolkata` on the hosts is not needed.
- **Not changed:** the `split("T")[0]` fallback for an unformatted ISO string in `kshemaQuoteForm.js` (customer and nominee DOB) —
  the data path never gives it one; the `new Date().toLocaleDateString()` "today" fallbacks in the Reliance flows (only used when a
  date is missing).

### 16.4 The portal answers a PA Cover change with an error (the "504")

2026-10-15, `PA Cover Year` was chosen and the premium calculation answered
`Http failure response for …/api/v1/product/calc/…?type=premium_calc: 504 OK`. `fillSection` reads any error toast right after the
spinner and failed the field on the spot ("Portal rejected the field update"); the same toast, still on screen, then failed TPPD
Restrict too — "2 failed" was one toast read twice. The field itself had been set: the portal was slow, the data was fine.

`fillPaCoverDetails` (both quote forms) now wraps its `fillSection` with `recoverSectionAfterPortalError` (`kshemaSlowFields.js`):

1. only when **every** failure is such a toast and the status is transient — 5xx, 0 ("Unknown Error"), 408, 425, 429, or
   timeout / gateway wording (`isTransientPortalError`). A 400 / 409 / 422 or "Please provide…" is a verdict on the data and is left alone;
2. up to **2 tries**: wait until the toast and the spinner are gone (≤ `KSHEMA_SLOW_FIELD_WAIT_MS`, 10 s) → untick PA Cover → settle →
   tick it again (tick then untick when PA is off) → settle → wait quiet → fill the PA fields again (re-picks the year, re-reads toasts);
3. the checkbox that is toggled is the paCover field's own (`PA_COVER_FIELDS[0].selectors`); its label is logged
   (`The "PA Cover" checkbox used for the recovery reads: "…"`) so it is visible which one it is;
4. out of tries: one colon-free sentence — `… the portal answered the change with an error (HTTP 504 on the premium calculation) even
   after un-ticking "PA Cover" and putting it back 2 times (waited 10 s each time). The portal is slow right now, so run this policy
   again in a few minutes.` The job's retry rule is unchanged (a PA failure is not auto-retried).

Same two switches as §16.1; no new ones. Not covered: a 504 in the **vehicle** or **premium** section still fails fast (there is no
known "re-trigger" there). **Found on the way, not touched:** `kshemaFields.js` does not export `asLocator`, but `submitQuoteForm`
destructures and calls it, so its "did the page change" radio-group check (and the TP copy's `[TP] 5` "Save and Finalize" check) have
always thrown a swallowed `TypeError` and never matched. Exporting it would make the radio-group check fire at once on the quote page
(its Yes/No radios are already there), so it needs a considered fix, not a one-word one.

## 18. KSHEMA KYC: the Aadhaar upload the portal could not read (fixed 2026-10-15)

> Also on the KSHEMA KYC page (2026-10-15): the **verdict settle** window (`settleKycOutcome`, `KSHEMA_KYC_SETTLE_ENABLED`) that catches "The gender on your document doesn't match your profile ...", and the stale KYC note being cleared — repo guide, section 6 (`../README.md`).

When the last-4-digits route is refused ("No record found") the flow uses "Try with different document" and uploads the policy's own
Aadhaar. Done by hand the same picture was accepted; the automation's upload was not read. Two defects in the old
`downloadAadharCardImage` / `recoverKycWithDocumentUpload`, either one enough:

1. **It could upload an S3 error page.** The link stored on the job is minted by the backend with `AWS_SIGNED_URL_EXPIRES_SECONDS = 300`
   (5 minutes); KYC runs minutes later; an expired link makes S3 answer 403 with a small XML body. The downloader never looked at the
   status, only refused "0 bytes", saved the body as `kshema_kyc_….jpg` and uploaded it. (The Reliance flow had this bug and was fixed
   on 2026-10-14 — a fresh link and a look at the first bytes; the KSHEMA copy of the downloader was the old one.)
2. **It deleted the file before the portal read it.** `fs.unlink` ran 1.5 s after `sendKeys`, before "Submit for Verification" — which is
   when a browser upload reads the file (Chrome: `ERR_UPLOAD_FILE_CHANGED`).

Also: the extension came from `Content-Type` with `.jpg` as the default, the download had no timeout, `els[0]` of `input[type=file]`
was taken blind, and a refusal was never shown — the wait for "Details are correct - Verify" just timed out with a generic sentence.

`fullPolicycompany/kshema/kshemaKycDocument.js` (shared; both quote forms delegate to it from `recoverKycWithDocumentUpload`, which
is now exported):

- `fetchAadhaarDocument` — **a fresh link minted from the S3 key now** (`getPresignedUrl`, 7 days); the stored link / `location` only
  as fallbacks; redirects followed; 30 s limit; 15 MB ceiling; the first bytes are inspected with the Reliance fix's
  `inspectDocumentFile` — an S3 XML / HTML / JSON / empty body is refused *before the portal is touched*, with S3's own words
  (`S3 answered "AccessDenied - Request has expired" instead of the file even with a fresh link`); a picture / PDF gets the
  extension it really has;
- `uploadAadhaarForKyc` — document first, then "Try with different document", Aadhaar card selected, attach, **read back
  `input.files`** (logged), wait until Submit is live, press it, then watch for the review screen **and** the page's error text
  (stale "No record found" on the hand-off card is filtered out by a baseline read) — a refusal returns at once with the portal's words
  (`The KSHEMA KYC page refused the uploaded document - it said "…"`); **the temp file is removed in a `finally`, after the outcome**.
- Storage: one small file per recovery, removed in `finally`; `temp_uploads` is also wiped at server start. No new switch (a defect
  fix on a recovery path). Retry rules unchanged: a refused document is not auto-retried, a stuck verification still is, and a
  storage timeout (transient) may be.
- Side fix: the TP copy used to compute `temp_uploads` relative to itself (`multiCompany/temp_uploads`); the shared module uses the
  project's `temp_uploads`.
- Tests: `test/kshemaKycDocument.test.js` (a loopback storage + a fake KYC page on a virtual clock; includes "the file still exists
  when Submit is pressed").
- Not proven live: the KYC page's markup is known from screenshots and earlier runs only; the input / echo checks are best-effort and
  only log when they cannot tell. If a run still fails, the failure now carries the portal's own words and the `kyc_details_failed`
  screenshot.

## 19. KSHEMA: every field filled carefully, a missed one recovered (2026-10-16)

"Sometimes a field is missed and the run fails." Every helper in `fullPolicycompany/kshema/kshemaFields.js` already waited, retried and read its
value back; what turned a passing hiccup into a failed policy was at the section and Save level. Shared by the full-company flow (OD+TP) and the
TP-only copy — both quote forms' `fillSection` now hand their fields to `fullPolicycompany/kshema/kshemaSection.js`.

- **Pass 1** is the old loop, unchanged — except that an exception inside a helper is now that field's failure ("could not be filled (…)"),
  not the end of the section.
- **Pass 2**: each failed field is tried once more after the loader has cleared. Not retried: missing data ("this policy has no …"), a portal
  rejection toast, a field with its own slow-field recovery (§16, it already ran).
- **Pass 3**: every filled field is read back (`readFieldState`: text / date value, the select's shown text, a radio / checkbox / slider state); one
  the portal cleared is filled again and read again, else reported ("filled twice and the portal cleared it both times"). A field not on screen is
  left alone (never refilled on a guess).
- **Save and Continue**: every field filled so far on THIS job's form (kept per driver, so parallel jobs never mix) is read back first. When Save does
  nothing, `readInvalidFields` reads the portal's own verdict (`ng-invalid` controls, visible `mat-error`): fields we filled are filled again and Save is
  pressed **once** more (a form with invalid fields was not submitted); otherwise the error names them instead of "there might be a silent validation
  error".
- **Bug fixed on the way:** `asLocator` was not exported from `kshemaFields.js`, so both forms' "has the next page appeared?" checks threw inside a
  `try` and never ran — a good Save was recognised only by the "add-ons" toast, and the TP-only flow (no add-ons page) could not see its next page at
  all ("The page did not change after 15 seconds"). It is exported now; the add-ons page is recognised by its own question ("want add-on"), never by
  any Yes/No group (the quote form has those too: "Is New Vehicle?").
- Switch: `KSHEMA_FIELD_RECHECK_ENABLED` (on unless false / 0 / no / off; off = the old single pass and the old Save, exactly). Tests:
  `test/kshemaSection.test.js`. **Not proven on the live portal**: the invalid-field markup (`ng-invalid` / `mat-error` are Angular Material's
  standard ones) and the add-ons question wording.

## 20. KSHEMA: the financier on the nominee page (2026-10-16)

KSHEMA's nominee page asks, below the nominee entry, a Yes/No financier question; "Yes" reveals **Financier Name** (an autocomplete, placeholder
`+ Financier Name`) and **Additional Details** (`data-iid="hypo_branch_address"`). The automation never entered them, so a policy with a financier
was filed without one. The policy already carried `hasFinancier`, `financierName`, `financierAddress` (server.js maps them); for a KSHEMA-only
policy the Online Policy form now asks just the name and the Additional Details (stored in `financierAddress`).

- **Where:** `fullPolicycompany/kshema/kshemaFinancier.js`, called by BOTH nominee flows (`kshemaQuoteForm.js`, the TP copy) after the nominee Save
  and before "Save and Finalize". A policy with no financier: nothing is touched.
- **Yes** is chosen on the Yes/No group found by the words "financier" / "hypothecat" next to a short label, and VERIFIED: the "+ Financier Name"
  box must appear. If the group is not found or the box never shows, the run stops and the message lists every Yes/No question the page showed
  (KSHEMA's wording was not known when this was written).
- **Name:** the Financier Name is a SEARCH dropdown (a `mat-autocomplete`, `autoactivefirstoption`; its rows are
  `mat-option[data-iid="financier_name"]` in the overlay, e.g. ` SERA COM PVT. LTD. `). The name is typed, the list is waited for (up to 12 s — it may be
  fetched — and until the same first row has stood for 0.6 s, because it re-filters while the name is typed) and the **FIRST** row is clicked; its text
  must land in the box. "No results found" and disabled rows are not options. **No data** = the run stops with *KSHEMA's financier list showed no
  financier for "…"* (+ the `nominee_details_failed` screenshot); nothing is typed free-hand. When the first row does not look like the typed name
  (Ltd = Limited, Pvt, Co ignored; score under 70) it is still chosen — as asked — and a warning says "please check it".
- **Minimum 2 letters (spaces do not count):** KSHEMA's list does not open for a single character. The Online Policy form refuses a shorter name for any
  policy with a KSHEMA leg (`companyRules.js` `KSHEMA_FINANCIER_NAME_MIN_LETTERS`, a Yup test on `financierName`; a name of only spaces is "required"
  now for every insurer), and the automation re-checks it (`MIN_NAME_LETTERS`, keep the two equal) for a policy saved before the rule: a one-letter name
  stops the run *before* the portal is touched — *the financier name "A" is too short - KSHEMA's financier list opens only after 2 letters …* — instead
  of waiting 12 s for a list that cannot open.
- **Read-back:** after the Additional Details the name box is read again (present, not empty, not `ng-invalid` / `aria-invalid` / a visible
  `mat-error`); a box a re-render wiped is entered once more, never more than twice.
- **Additional Details:** `typeIntoField` (3 tries, read-back); optional, so a miss is a warning.
- A failure ends the nominee step with a plain sentence and the existing `nominee_details_failed` screenshot. No colon in any sentence.
- Switch: `KSHEMA_FINANCIER_ENABLED` (on unless false / 0 / no / off; off = not entered). Tests: `test/kshemaFinancier.test.js`.
  **Not proven on the live portal:** the Yes/No wording of the question. The dropdown rows are from the portal's own markup.

## 21. KSHEMA: after Save and Finalize — the loader, the financier box, and why the KYC button did not come (2026-10-16)

A run stopped with `KYC button did not appear after 15 seconds` (stage `kyc-details`). Pressing **Save and Finalize** makes KSHEMA show its loader while
it saves; the KYC page is drawn when the loader ends, and a slow portal needs longer than 15 s. When the portal refuses to move on (the Financier Name
box empty or marked invalid, another required field missing) the run could not tell — it waited, gave up, and named nothing.

- **Where:** `fullPolicycompany/kshema/kshemaAfterFinalize.js`, used by BOTH flows (`kshemaQuoteForm.js`, the TP copy — lines tagged `[TP] 10`):
  - `checkFinalizeEnabled` — before the click. A Save and Finalize that is STILL disabled (same test as the form's own wait) cannot be pressed; if the
    form shows why (financier box, other invalid fields) the run stops there: *Save and Finalize stayed disabled - …*. With nothing to blame it is pressed
    as before (no new way to fail).
  - `waitAfterFinalize` — right after the click (and the existing 2 s): waits for the loader (`mat-spinner[data-iid="__loading"], .mat-mdc-progress-spinner`,
    the one `waitForKshemaLoaderToDisappear` watches) to open, run and stay gone for 0.8 s (two requests in a row leave a gap); progress lines every 10 s;
    error snackbars that flash by are remembered. Then it reads the **Financier Name box again**: marked invalid on a second look = KSHEMA's refusal →
    *KSHEMA did not accept Save and Finalize - the Financier Name box is marked invalid (…) and it holds "…"*. A page that left the form has no box (fine); an
    empty box that is not marked invalid is left to the timeout diagnosis (a form may reset itself on its way out). A loader that never closes is waited for
    the whole budget and is not a verdict by itself.
  - `awaitKycButton` — the KYC step's wait: the button is taken once the loader is gone (a button with a loader that stays is pressed anyway after 15 s —
    a spinner that stays must not stall the run). Patience is counted **from the click** (default 60 s, `KSHEMA_AFTER_FINALIZE_WAIT_SECONDS`, kept within
    15-300), never less than 10 s for this step, and a loader still open stretches it by at most 10 s.
- **When the button never comes** the page is read and the error lists, most telling first (joined by "; "): the snackbar KSHEMA showed · the Financier Name
  box (empty / invalid + its message) · the other fields it marks invalid (financier not repeated, first six + a count) · a loader that never ended.
  Nothing found = *the page showed no message, no invalid field and no loader, so the portal simply did not move on (the page is "…")*. The failure
  screenshot (`kyc_details_failed`) is taken with the page as it stands.
- Nothing here presses a button or fills a field again — it waits, reads and reports. (A second Save and Finalize could meet *Quotation already converted
  to proposal*.) No colon in any sentence.
- Switch: `KSHEMA_AFTER_FINALIZE_ENABLED` (on unless false / 0 / no / off; off = the old fixed 15 s wait and its message, word for word). Tests:
  `test/kshemaAfterFinalize.test.js` (a scripted page + fake clock), wiring in both forms, `test/kshemaTP.test.js` (sync).
  **Not proven on the live portal:** that the loader selector matches this particular loader, and the wording of KSHEMA's field errors.

