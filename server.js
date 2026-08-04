// Load environment variables FIRST before any other configuration
require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const AWS = require("aws-sdk");

// Configure AWS S3
console.log(`🔧 AWS Config - Bucket: ${process.env.AWS_BUCKET_NAME}, AccessKey: ${process.env.AWS_S3_ACCESSKEY_ID ? 'SET' : 'MISSING'}`);
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_S3_ACCESSKEY_ID,
  secretAccessKey: process.env.AWS_S3_SECRET_ACCESSKEY,
  region: "ap-south-1"
});

// Helper function to generate presigned URL for S3 downloads
const getPresignedUrl = async (key) => {
  if (!key) return null;
  try {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Expires: 3600 // URL valid for 1 hour
    };
    const url = await s3.getSignedUrlPromise('getObject', params);
    console.log(`✅ Generated presigned URL for: ${key}`);
    return url;
  } catch (err) {
    console.error(`❌ Error generating presigned URL for ${key}:`, err.message);
    return null;
  }
};

/**
 * 🧹 Startup Cleanup Routine
 * Deletes temporary directories and orphaned page source files
 */
const cleanupOldData = async () => {
  console.log("\n🧹 Starting server startup cleanup...");
  const pathsToClean = [
    'cloned_profiles',
    'error_screenshots',
    'local-screenshots',
    'screenshots',
    'brisk_certificates',
    'brisk-certificates',
    'reliance_pdf',
    'reliance_captcha',
    'temp_uploads',
    'cloned_profiles_national',
    'cloned_profiles_kshema',
    // Litter left by the (now removed) profile pool's failed init — 25+ empty
    // dirs were found here. Absolute path, cleaned like the rest.
    '/dev/shm/chrome-profiles'
  ];

  for (const dirName of pathsToClean) {
    // Absolute entries (e.g. /dev/shm/chrome-profiles) are used as-is;
    // path.join would otherwise glue them under __dirname.
    const dirPath = path.isAbsolute(dirName) ? dirName : path.join(__dirname, dirName);
    try {
      if (fs.existsSync(dirPath)) {
        // Use recursive delete for directories
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`  🗑️  Cleared directory: ${dirName}`);
      }
      // Recreate the directory so it's ready for use
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
      console.error(`  ⚠️  Failed to clean ${dirName}:`, err.message);
    }
  }

  // Clean up specific temp files in the root
  try {
    const files = fs.readdirSync(__dirname);
    const tempFilePatterns = [
      f => f.startsWith('temp-page-source-') && f.endsWith('.html'),
      f => f.startsWith('national_login_page_') && f.endsWith('.png'),
      f => f === 'reliance_captcha.png'
    ];

    let deletedCount = 0;
    for (const file of files) {
      if (tempFilePatterns.some(pattern => pattern(file))) {
        fs.unlinkSync(path.join(__dirname, file));
        deletedCount++;
      }
    }
    if (deletedCount > 0) {
      console.log(`  🗑️  Cleared ${deletedCount} orphaned temporary files from root`);
    }
  } catch (err) {
    console.error("  ⚠️  Failed to clean temporary files:", err.message);
  }
  console.log("✨ Cleanup completed!\n");
};

// Run cleanup immediately on script load
cleanupOldData().catch(err => console.error("Cleanup error:", err));

// Periodic orphan-profile sweep. Defined further down (needs JOB_TIMEOUT);
// scheduled here so it actually RUNS — it was previously defined but never
// called, so crashed jobs' profiles accumulated until a restart. Age-based
// (3× JOB_TIMEOUT), so it can never touch a live job.
setInterval(() => {
  try {
    sweepOrphanedProfiles();
  } catch (err) {
    console.error("[Profile Sweep] Error:", err.message);
  }
}, 5 * 60 * 1000);
const {
  getDriver,
  openNewTab,
  closeCurrentTab,
  ensureCleanState,
  createChromeDriver,
} = require("./browser");
const {
  initializeMasterSession,
  getSessionStatus,
  checkSession,
  reLoginIfNeeded,
} = require("./sessionManager");
const { captureAndLogError } = require("./errorLogger");
// Company automation steps live in fullPolicycompany/. Their session and
// browser managers stay at the root alongside the shared infrastructure.
const { fillRelianceForm } = require("./fullPolicycompany/relianceForm");
const { fillNationalForm } = require("./fullPolicycompany/national");
const { fillKshemaForm } = require("./fullPolicycompany/kshemaForm");
const { isAutomationStop, stoppedResult } = require("./automationStopper");
const { extractCaptchaText } = require("./Captcha");
// National uses fresh login for each job, no master session needed
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const moment = require("moment");

// 🛡️ Import Enhanced Error Handler (CRITICAL: Money involved)
const {
  validateFormData,
  sanitizeFormData,
  generateIdempotencyKey,
  checkDuplicateSubmission,
  createErrorLogEntry,
  beautifyError,
  ERROR_CODES,
  ValidationError,
  PolicyAutomationError
} = require("./lib/errorHandler");

// ⏳ Utility for data stabilization delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { ProviderCredential } = require("./models");

mongoose.connect(process.env.MONGODB_URI);

const db = mongoose.connection;

// Persistent Queue System using MongoDB
let activeRelianceJobs = 0;

// ---------------------------------------------------------------------------
// Per-company parallelism (generic — no company names hard-coded)
//
// Every company gets its OWN browser-window budget, read from .env as:
//   <COMPANY>_MAX_PARALLEL_JOBS
// e.g.
//   RELIANCE_MAX_PARALLEL_JOBS=2
//   NATIONAL_MAX_PARALLEL_JOBS=2
//   ICICI_MAX_PARALLEL_JOBS=3        <-- a new company needs ONLY this line
// Anything not configured falls back to DEFAULT_MAX_PARALLEL_JOBS.
//
// Previously a single hard-coded MAX_PARALLEL_JOBS=1 was shared by ALL
// companies, so a National job blocked a Reliance job (and vice versa) and only
// one browser window could ever be open.
// ---------------------------------------------------------------------------
const parsePositiveInt = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const DEFAULT_MAX_PARALLEL_JOBS = parsePositiveInt(
  process.env.DEFAULTMAXWINDOW ??
  process.env.DEFAULT_MAX_WINDOW ??
  process.env.DEFAULT_MAX_PARALLEL_JOBS,
  1
);

/**
 * Env keys checked for a company's window limit, most preferred first:
 *   RELIANCEMAXWINDOW  ->  RELIANCE_MAX_WINDOW  ->  RELIANCE_MAX_PARALLEL_JOBS
 */
const maxParallelEnvKeys = (company) => {
  const name = String(company).toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const snake = String(company).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return [
    `${name}MAXWINDOW`,
    `${snake}_MAX_WINDOW`,
    `${snake}_MAX_PARALLEL_JOBS`,
  ];
};

/** Window budget for a company. Unknown companies use the default. */
const maxParallelFor = (company) => {
  for (const key of maxParallelEnvKeys(company)) {
    if (process.env[key] !== undefined) {
      return parsePositiveInt(process.env[key], DEFAULT_MAX_PARALLEL_JOBS);
    }
  }
  return DEFAULT_MAX_PARALLEL_JOBS;
};

/** Normalized company name for a queued job. Any value is supported. */
const companyOfJob = (job) => {
  const raw = job?.formData?.Companyname || job?.formData?.company || "reliance";
  return String(raw).trim().toLowerCase() || "reliance";
};

/** Pretty label for logs and operator-facing messages: "national" -> "National" */
const COMPANY_LABELS = { kshema: "KSHEMA" }; // brands that are not just Capitalised
const companyLabel = (company) => {
  const key = String(company).trim().toLowerCase();
  return COMPANY_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);
};

// Companies explicitly configured in .env — for the startup banner only. The
// queue itself discovers companies from the jobs it sees, so a new company
// works without touching this file.
const CONFIGURED_COMPANIES = [
  ...new Set(
    Object.keys(process.env)
      .map((k) => {
        const m =
          k.match(/^([A-Z0-9]+)MAXWINDOW$/) ||
          k.match(/^([A-Z0-9_]+)_MAX_WINDOW$/) ||
          k.match(/^([A-Z0-9_]+)_MAX_PARALLEL_JOBS$/);
        return m ? m[1].replace(/_/g, "").toLowerCase() : null;
      })
      .filter((c) => c && c !== "default")
  ),
];

// Generous upper bound used only by the "any spare capacity?" poll check.
const MAX_PARALLEL_JOBS =
  CONFIGURED_COMPANIES.reduce((sum, c) => sum + maxParallelFor(c), 0) ||
  DEFAULT_MAX_PARALLEL_JOBS;

console.log(
  `[Queue] Parallel window limits -> ${CONFIGURED_COMPANIES.length
    ? CONFIGURED_COMPANIES.map((c) => `${companyLabel(c)}: ${maxParallelFor(c)}`).join(", ")
    : "(none configured)"
  } | default for any other company: ${DEFAULT_MAX_PARALLEL_JOBS}`
);
const JOB_TIMEOUT = 300000; // 5 minutes max per job run

// How often to sweep for pending jobs. Override with QUEUE_POLL_INTERVAL_MS in
// .env (value in milliseconds).
const QUEUE_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.QUEUE_POLL_INTERVAL_MS,
  5 * 60 * 1000 // 5 minutes
);

// ---------------------------------------------------------------------------
// Orphaned browser-profile sweeper
//
// Every job clones a Chrome profile into cloned_profiles/ (Reliance) or
// cloned_profiles_national/ (National) and deletes it on cleanup. If a job
// crashes hard — or the process is killed mid-run — that clone is left behind,
// several MB each, and they accumulate until the next server restart.
//
// The sweep is age-based rather than name-based: profile directory names differ
// per company/version, but NO job can outlive JOB_TIMEOUT, so anything older
// than the cutoff is provably not in use. That keeps it safe with any number of
// companies running in parallel.
// ---------------------------------------------------------------------------
const PROFILE_DIRS = [
  "cloned_profiles",
  "cloned_profiles_national",
  // Swept like the others now that the KSHEMA flow closes its own browser.
  // It was held back while that flow deliberately left windows open — the
  // age-based sweep would have deleted the profile out from under one.
  "cloned_profiles_kshema",
];
// 1 hour. Deliberately far beyond JOB_TIMEOUT (5 min): when a job times out,
// the Promise.race only rejects the outer promise — the automation keeps
// running detached with its browser open. A tighter cutoff could delete a
// profile directory out from under a live Chrome.
const ORPHAN_PROFILE_MAX_AGE_MS = 60 * 60 * 1000;

const sweepOrphanedProfiles = () => {
  let removed = 0;
  let freedBytes = 0;

  for (const dirName of PROFILE_DIRS) {
    const baseDir = path.join(__dirname, dirName);
    let entries = [];
    try {
      if (!fs.existsSync(baseDir)) continue;
      entries = fs.readdirSync(baseDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[Profile Sweep] Could not read ${dirName}: ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profilePath = path.join(baseDir, entry.name);
      try {
        const stats = fs.statSync(profilePath);
        const ageMs = Date.now() - stats.mtimeMs;
        if (ageMs < ORPHAN_PROFILE_MAX_AGE_MS) continue; // may still be in use

        let size = 0;
        try {
          size = parseInt(
            require("child_process")
              .execFileSync("du", ["-sb", profilePath], { encoding: "utf8" })
              .split("\t")[0],
            10
          ) || 0;
        } catch (e) { /* size is informational only */ }

        fs.rmSync(profilePath, { recursive: true, force: true });
        removed++;
        freedBytes += size;
        console.log(
          `[Profile Sweep] 🗑️  Removed orphaned profile ${dirName}/${entry.name} (idle ${Math.round(ageMs / 60000)}m)`
        );
      } catch (err) {
        console.warn(
          `[Profile Sweep] Could not remove ${dirName}/${entry.name}: ${err.message}`
        );
      }
    }
  }

  if (removed > 0) {
    console.log(
      `[Profile Sweep] ✅ Removed ${removed} orphaned profile(s), freed ~${(freedBytes / 1048576).toFixed(1)} MB`
    );
  }
  return removed;
};
const ZOMBIE_GRACE_MS = 90000; // Extra grace before a stuck "processing" job is reclaimed
let jobQueueCollection = null; // Will be initialized after DB connection
let auditLogCollection = null; // For audit logging

// Job statuses
const JOB_STATUS = {
  PENDING: "pending", // Waiting in queue
  PROCESSING: "processing", // Currently being processed
  COMPLETED: "completed", // Successfully completed
  COMPLETED_WITH_ERRORS: "completed_with_errors", // Form submitted but post steps failed (Brisk cert / doc upload)
  FAILED_LOGIN_FORM: "failed_login_form", // Failed during login page form filling
  FAILED_POST_SUBMISSION: "failed_post_submission", // Failed after form submission
  FAILED_VALIDATION: "failed_validation", // Failed input validation
  FAILED_DUPLICATE: "failed_duplicate", // Duplicate submission detected
};

// ---------------------------------------------------------------------------
// Graceful shutdown: on Ctrl-C / SIGTERM, put this process's PROCESSING jobs
// back to PENDING so the next start picks them up immediately instead of
// waiting for the zombie-reclaim window. Browser processes die with us; their
// profiles are reclaimed by startup cleanup + the orphan sweep.
// ---------------------------------------------------------------------------
let shuttingDown = false;
const gracefulShutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received — releasing in-flight jobs...`);
  try {
    if (jobQueueCollection) {
      const res = await jobQueueCollection.updateMany(
        { status: JOB_STATUS.PROCESSING },
        {
          $set: {
            status: JOB_STATUS.PENDING,
            lastError: `Server stopped (${signal}) while job was running — re-queued`,
            lastErrorTimestamp: new Date(),
          },
        }
      );
      console.log(`[Shutdown] Re-queued ${res.modifiedCount} processing job(s).`);
    }
  } catch (err) {
    console.error("[Shutdown] Failed to re-queue jobs:", err.message);
  }
  process.exit(0);
};
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));

/**
 * 🛡️ Enhanced Job Enqueue with Validation & Duplicate Detection
 * CRITICAL: Since money is involved, we validate and check for duplicates
 */
/**
 * Build the automation formData payload from an onlinePolicy document.
 *
 * Extracted from the old change-stream handler so the queue consumer can
 * hydrate a job at CLAIM time. Doing it then (instead of at enqueue time)
 * also means the S3 presigned URLs are generated when the job actually runs,
 * so they can no longer expire while the job waits in the queue.
 */
const buildFormDataFromPolicy = async (data) => {
    // Generate presigned URLs for document downloads
    let aadharPresignedUrl = null;
    let panPresignedUrl = null;

    if (data?.aadharCard?.key) {
      aadharPresignedUrl = await getPresignedUrl(data.aadharCard.key);
      console.log(`📄 Aadhar presigned URL generated: ${aadharPresignedUrl ? 'YES' : 'NO'}`);
    }

    if (data?.panCard?.key) {
      panPresignedUrl = await getPresignedUrl(data.panCard.key);
      console.log(`📄 PAN presigned URL generated: ${panPresignedUrl ? 'YES' : 'NO'}`);
    }

    let formData = {
      // MongoDB document identifiers (CRITICAL for updates)
      _id: data?._id,
      policyId: data?.policyId,
      userId: data?.userId,
      clientId: data?.clientId,

      username: "rfcpolicy",
      password: "Pass@123",
      // Proposer details
      proposerTitle: data?.proposerTitle || "Mr.",
      firstName: data?.fullName || data?.firstName,
      middleName: data?.middleName || "",
      lastName: data?.surname || data?.lastName,
      dob: data?.dateOfBirth?.$date
        ? moment(data.dateOfBirth.$date).format("DD-MM-YYYY")
        : data?.dateOfBirth
          ? moment(data.dateOfBirth).format("DD-MM-YYYY")
          : "",
      gender: data?.gender,
      // Father details
      fatherTitle: data?.fatherTitle || "Mr.",
      fatherName: data?.fatherName,
      // Address details
      flatNo: data?.flatDoorNo,
      flatDoorNo: data?.flatDoorNo, // Added to match onlinePolicy schema
      floorNo: data?.floorNo,
      premisesName: data?.buildingName,
      buildingName: data?.buildingName, // Added to match onlinePolicy schema
      blockNo: data?.blockName || data?.blockNo,
      blockName: data?.blockName, // Added to match onlinePolicy schema
      road: data?.roadStreetLane || data?.road,
      roadStreetLane: data?.roadStreetLane, // Added to match onlinePolicy schema
      areaAndLocality: data?.areaAndLocality || data?.area || data?.locality || "",
      state: data?.state == "TAMILNADU" ? "30" : data?.state == "KARNATAKA" ? "26" : "30",
      pinCode: data?.pincode,
      // Contact details
      mobile: data?.mobileNumber,
      email: data?.email,
      aadhar: data?.aadhar,
      // Document uploads (from S3) - with presigned URLs for download
      aadharCard: data?.aadharCard ? {
        ...data.aadharCard,
        presignedUrl: aadharPresignedUrl
      } : null,
      panCard: data?.panCard ? {
        ...data.panCard,
        presignedUrl: panPresignedUrl
      } : null,
      // Vehicle details
      vehicleMake: data?.vehicleMake,
      vehicleModel: data?.vehicleModel,
      vehicleCC: data?.vehicleCC,
      rtoCityLocation: data?.rtoCityLocation,
      vehicleVariant: data?.vehicleVariant,
      RTORegion: data?.RTORegion,
      RTOCity: data?.RTOCity,
      idv: data?.idv,
      // Model-not-found support (mirrors the backend's buildFullJobFormData).
      modelNotFound: !!data?.modelNotFound,
      manufacturerSellingPrice: data?.manufacturerSellingPrice,
      idvRangeFrom: data?.idvRangeFrom,
      idvRangeTo: data?.idvRangeTo,
      manufacturingYear: data?.manufacturingYear,
      manufacturingMonth: data?.manufacturingMonth,
      engineNumber: data?.engineNumber,
      chassisNumber: data?.chassisNumber,
      purchaseDate: data?.purchaseDate?.$date
        ? moment(data.purchaseDate.$date).format("DD-MM-YYYY")
        : data?.purchaseDate
          ? moment(data.purchaseDate).format("DD-MM-YYYY")
          : "",
      registrationDate: data?.registrationDate?.$date
        ? moment(data.registrationDate.$date).format("DD-MM-YYYY")
        : data?.registrationDate
          ? moment(data.registrationDate).format("DD-MM-YYYY")
          : "",
      // Coverage options
      zeroDepreciation: data?.zeroDepreciation,
      zeroDepreciationPercentage: data?.zeroDepreciationPercentage,
      tppdRestrict: data?.tppdRestrict,
      paCover: data?.paCover,
      paCoverCompany: data?.paCoverCompany,
      paCoverAmount: data?.paCoverAmount,
      nomineeName: data?.nomineeName,
      nomineeRelation: data?.nomineeRelation,
      nomineeAge: data?.nomineeAge,
      paCoverYears: data?.paCoverYears,
      otherRelationName: data?.otherRelationName,
      appointeeName: data?.appointeeName,
      nomineeDob: data?.nomineeDob?.$date
        ? moment(data.nomineeDob.$date).format("DD-MM-YYYY")
        : data?.nomineeDob
          ? moment(data.nomineeDob).format("DD-MM-YYYY")
          : "",
      // Financier details
      hasFinancier: data?.hasFinancier,
      financierType: data?.financierType,
      financierName: data?.financierName,
      financierAddress: data?.financierAddress,
      // Registration address
      isRegistrationAddressSame: data?.isRegistrationAddressSame,
      // Discount mapping (normalize multiple possible fields from Mongo)
      discount: data?.ODDiscount ?? data?.odDiscount ?? data?.Detariff_Discount_Rate ?? data?.discount,
      ODDiscount: data?.ODDiscount ?? data?.odDiscount ?? data?.Detariff_Discount_Rate ?? data?.discount,
      // Payment Method
      Paymentmethod: data?.Paymentmethod,
      // Company name mapping - check both 'company' and 'Companyname' fields, normalize to lowercase
      Companyname: data?.Companyname || (data?.company ? data.company.toLowerCase() : "reliance")
    };
  return formData;
};

const enqueueRelianceJob = async (formData, captchaId = null, operationType = null) => {
  const startTime = Date.now();

  try {
    // Step 1: Sanitize form data
    const sanitizedData = sanitizeFormData(formData);

    // Step 2: Validate form data
    const company = sanitizedData.Companyname || 'reliance';
    const validation = validateFormData(sanitizedData, company);

    if (!validation.valid) {
      console.error(`[Reliance Queue] ❌ Validation failed for ${sanitizedData.firstName}:`);
      validation.errors.forEach(e => console.error(`   - ${e.field}: ${e.message}`));

      // Create failed job record for tracking
      const failedJob = {
        captchaId: captchaId,
        formData: sanitizedData,
        status: JOB_STATUS.FAILED_VALIDATION,
        createdAt: new Date(),
        failedAt: new Date(),
        attempts: 0,
        maxAttempts: 0,
        validationErrors: validation.errors.map(e => e.toJSON ? e.toJSON() : e),
        errorSummary: validation.errorSummary
      };

      await jobQueueCollection.insertOne(failedJob);

      // Log audit entry
      await logAuditEntry('VALIDATION_FAILED', {
        captchaId,
        customerName: `${sanitizedData.firstName} ${sanitizedData.lastName}`,
        errors: validation.errorSummary
      });

      throw new ValidationError('formData', null, 'E100_INVALID_INPUT', {
        message: `Validation failed: ${validation.errorSummary}`
      });
    }

    // Step 3a: Check if a job ALREADY exists for this same policy document.
    // Insert + later Aadhaar/PAN uploads fire separate change events for the same
    // document — that is the same work item, NOT a duplicate submission.
    let sameDocJob = null;
    if (captchaId) {
      sameDocJob = await jobQueueCollection.findOne({
        captchaId: captchaId,
        status: {
          $in: [
            JOB_STATUS.PENDING,
            JOB_STATUS.PROCESSING,
            JOB_STATUS.COMPLETED,
            JOB_STATUS.COMPLETED_WITH_ERRORS
          ]
        }
      });
    }

    // A re-INSERT after the old job completed means the document was deleted and
    // re-created — that's new work, not a re-notification of the finished job
    if (
      sameDocJob &&
      (sameDocJob.status === JOB_STATUS.COMPLETED ||
        sameDocJob.status === JOB_STATUS.COMPLETED_WITH_ERRORS) &&
      operationType === "insert"
    ) {
      console.log(`[Reliance Queue] 🔁 Document re-created after completed job ${sameDocJob._id} — starting a fresh job`);
      sameDocJob = null;
    }

    if (sameDocJob) {
      const runningForSec = sameDocJob.startedAt
        ? Math.round((Date.now() - new Date(sameDocJob.startedAt).getTime()) / 1000)
        : null;
      console.log(`[Reliance Queue] ℹ️ Job already exists for this policy document (Job ID: ${sameDocJob._id}, Status: ${sameDocJob.status}${runningForSec !== null ? `, running for ${runningForSec}s` : ""})`);

      // If the existing job is missing Aadhaar/PAN but the new data has it, update the job in-place
      const needsAadharUpdate = sanitizedData.aadharCard?.key && !sameDocJob.formData.aadharCard?.key;
      const needsPanUpdate = sanitizedData.panCard?.key && !sameDocJob.formData.panCard?.key;
      const needsNomineeAgeUpdate = sanitizedData.nomineeAge && !sameDocJob.formData.nomineeAge;
      const needsPaCoverYearsUpdate = sanitizedData.paCoverYears && !sameDocJob.formData.paCoverYears;

      if (needsAadharUpdate || needsPanUpdate || needsNomineeAgeUpdate || needsPaCoverYearsUpdate) {
        console.log(`[Reliance Queue] 🔄 Updating existing job ${sameDocJob._id} with missing fields...`);
        const updateFields = {};
        if (needsAadharUpdate) updateFields["formData.aadharCard"] = sanitizedData.aadharCard;
        if (needsPanUpdate) updateFields["formData.panCard"] = sanitizedData.panCard;
        if (needsNomineeAgeUpdate) updateFields["formData.nomineeAge"] = sanitizedData.nomineeAge;
        if (needsPaCoverYearsUpdate) updateFields["formData.paCoverYears"] = sanitizedData.paCoverYears;

        await jobQueueCollection.updateOne(
          { _id: sameDocJob._id },
          { $set: updateFields }
        );
        console.log(`[Reliance Queue] ✅ In-place update successful for job ${sameDocJob._id}`);
      }

      // Log audit entry
      await logAuditEntry('JOB_MERGED_SAME_DOCUMENT', {
        captchaId,
        customerName: `${sanitizedData.firstName} ${sanitizedData.lastName}`,
        existingJobId: sameDocJob._id,
        existingJobStatus: sameDocJob.status,
        upgraded: needsAadharUpdate || needsPanUpdate
      });

      // Return existing job ID
      return sameDocJob._id;
    }

    // Step 3b: Check for duplicate submissions from a DIFFERENT document
    // (CRITICAL: Prevent double charges — same customer data submitted twice)
    const idempotencyKey = generateIdempotencyKey(sanitizedData);
    const existingJob = await checkDuplicateSubmission(jobQueueCollection, idempotencyKey, 60, captchaId);

    if (existingJob) {
      console.warn(`[Reliance Queue] ⚠️ Duplicate submission detected for ${sanitizedData.firstName}`);
      console.warn(`   Existing Job ID: ${existingJob._id}, Status: ${existingJob.status}, from document: ${existingJob.captchaId}`);

      // Log audit entry
      await logAuditEntry('DUPLICATE_DETECTED', {
        captchaId,
        customerName: `${sanitizedData.firstName} ${sanitizedData.lastName}`,
        existingJobId: existingJob._id,
        existingJobStatus: existingJob.status
      });

      // Return existing job ID
      return existingJob._id;
    }

    // Step 4: Create job with enhanced tracking
    const job = {
      captchaId: captchaId,
      formData: sanitizedData,
      idempotencyKey: idempotencyKey,
      status: JOB_STATUS.PENDING,
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 5,
      lastError: null,
      errorLogs: [],
      statusHistory: [{
        from: null,
        to: JOB_STATUS.PENDING,
        timestamp: new Date()
      }],
      metadata: {
        company: company,
        enqueuedAt: new Date(),
        processingTimeMs: null,
        retryCount: 0
      }
    };

    const result = await jobQueueCollection.insertOne(job);

    const enqueueDuration = Date.now() - startTime;
    console.log(
      `[Reliance Queue] ✅ Enqueued job for ${sanitizedData.firstName} (Job ID: ${result.insertedId}, Captcha ID: ${captchaId}) [${enqueueDuration}ms]`
    );

    // Log audit entry
    await logAuditEntry('JOB_ENQUEUED', {
      jobId: result.insertedId,
      captchaId,
      customerName: `${sanitizedData.firstName} ${sanitizedData.lastName}`,
      company: company,
      mobile: sanitizedData.mobile
    });

    // Try to process queue
    void processRelianceQueue();

    return result.insertedId;
  } catch (error) {
    console.error("[Reliance Queue] ❌ Failed to enqueue job:", error.message);

    // Log audit entry for failure
    await logAuditEntry('ENQUEUE_FAILED', {
      captchaId,
      error: error.message,
      errorCode: error.code || 'UNKNOWN'
    });

    throw error;
  }
};

/**
 * Helper function to log audit entries
 */
async function logAuditEntry(action, details) {
  try {
    if (!auditLogCollection) {
      auditLogCollection = db.collection('AuditLog');
    }

    await auditLogCollection.insertOne({
      action,
      details,
      timestamp: new Date(),
      service: 'policy-form-automation'
    });
  } catch (err) {
    console.error('[Audit] Failed to log entry:', err.message);
  }
}

// Only ONE scheduling pass may run at a time.
//
// This function is re-entrant — called from the 15s poll, from the queue change
// stream, and from each job's .finally. Two overlapping passes would each read
// the same "0 active" snapshot and each reserve a full company budget, opening
// twice the configured windows (e.g. 4 Chrome instances for MAXWINDOW=2, which
// can OOM the box mid-submission). If a pass is requested while one is running
// we simply re-run once afterwards, so no trigger is lost.
// ---------------------------------------------------------------------------
// Job heartbeat
//
// A job that is genuinely running must NEVER be disturbed. Reclaiming stuck
// jobs purely on elapsed time cannot tell "still working" from "handler died":
// a National run legitimately takes 200s+, and with slow-portal waits it can
// pass the reclaim threshold — at which point the job was flipped back to
// pending and started a SECOND time while the first browser was still filling
// the form (a duplicate submission).
//
// So a running job stamps lastHeartbeatAt every HEARTBEAT_INTERVAL_MS, and the
// reclaimer only takes jobs that have gone quiet. However long a job runs, it
// is left alone as long as it is alive.
// ---------------------------------------------------------------------------
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_STALE_MS = 120000; // no beat for 2 min => the handler is gone

const startJobHeartbeat = (jobId) => {
  const beat = () => {
    jobQueueCollection
      .updateOne(
        { _id: jobId, status: JOB_STATUS.PROCESSING },
        { $set: { lastHeartbeatAt: new Date() } }
      )
      .catch((e) => console.warn(`[Queue] heartbeat failed for ${jobId}:`, e.message));
  };
  beat(); // stamp immediately so a job is never briefly "stale"
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
};

// Wake the queue at an exact moment (a job's nextRetryAt) rather than waiting
// for the next poll tick. Only ever one timer outstanding, always for the
// earliest pending job.
let queueWakeupTimer = null;
let queueWakeupAt = null;
const scheduleQueueWakeup = (dueAt) => {
  const delay = Math.max(0, dueAt - Date.now()) + 50; // tiny cushion for clock skew
  // A timer for an earlier (or the same) moment already exists — keep it.
  if (queueWakeupTimer && queueWakeupAt !== null && queueWakeupAt <= dueAt) return;
  if (queueWakeupTimer) clearTimeout(queueWakeupTimer);
  queueWakeupAt = dueAt;
  queueWakeupTimer = setTimeout(() => {
    queueWakeupTimer = null;
    queueWakeupAt = null;
    void processRelianceQueue();
  }, delay);
  if (typeof queueWakeupTimer.unref === "function") queueWakeupTimer.unref();
};

let queuePassRunning = false;
let queuePassRequested = false;
// Last reported states, so unchanged output stays silent between passes.
let lastLoggedQueueState = null;
let lastLoggedCapacityState = null;
let lastLoggedBackoffAt = null;

const processRelianceQueue = async () => {
  if (!jobQueueCollection) {
    console.log("[Reliance Queue] ⚠️ jobQueueCollection not initialized yet. Skipping.");
    return;
  }

  if (queuePassRunning) {
    queuePassRequested = true;
    return;
  }
  queuePassRunning = true;

  try {
    // Watchdog: reclaim zombie jobs stuck in "processing" past timeout + grace.
    // The Promise.race timeout normally handles this; this covers handler crashes.
    // Reclaim ONLY jobs that have stopped beating. A long-but-alive job keeps
    // its slot no matter how long it takes — see startJobHeartbeat above.
    // `startedAt` is the fallback for jobs claimed before heartbeats existed.
    const silentSince = new Date(Date.now() - HEARTBEAT_STALE_MS);
    const legacyCutoff = new Date(Date.now() - (JOB_TIMEOUT + ZOMBIE_GRACE_MS));
    const zombies = await jobQueueCollection.updateMany(
      {
        status: JOB_STATUS.PROCESSING,
        $or: [
          { lastHeartbeatAt: { $lt: silentSince } },
          { lastHeartbeatAt: { $exists: false }, startedAt: { $lt: legacyCutoff } },
        ],
      },
      {
        $set: { status: JOB_STATUS.PENDING, recoveredAt: new Date() },
        $unset: { nextRetryAt: "", lastHeartbeatAt: "" },
      }
    );
    if (zombies.modifiedCount > 0) {
      console.warn(
        `[Reliance Queue] 🧟 Reclaimed ${zombies.modifiedCount} zombie job(s) stuck in processing > ${(JOB_TIMEOUT + ZOMBIE_GRACE_MS) / 1000}s`
      );
    }

    // Count jobs currently processing, PER COMPANY, so Reliance and National
    // consume their own budgets instead of competing for one global slot.
    const processingJobs = await jobQueueCollection
      .find({ status: JOB_STATUS.PROCESSING })
      .toArray();

    // Companies are discovered from the jobs themselves, so adding a new one
    // never requires changing this code.
    const activeByCompany = {};
    for (const processingJob of processingJobs) {
      const company = companyOfJob(processingJob);
      activeByCompany[company] = (activeByCompany[company] || 0) + 1;
    }

    activeRelianceJobs = processingJobs.length;
    const activeSummary = Object.keys(activeByCompany).length
      ? Object.entries(activeByCompany)
        .map(([c, n]) => `${companyLabel(c)}: ${n}/${maxParallelFor(c)}`)
        .join(", ")
      : "none";

    // Quiet by default. This runs on every poll tick, every queue event and
    // after every finished job, so logging unconditionally filled the console
    // with identical "Active -> none" lines. Only speak up when the picture
    // actually CHANGES, and never when the system is simply idle.
    if (activeSummary !== lastLoggedQueueState && processingJobs.length > 0) {
      console.log(`[Queue] 📊 Active -> ${activeSummary}`);
    }
    lastLoggedQueueState = activeSummary;

    // Pull a batch of ready jobs (oldest first) and pick from it per company.
    // Fetching a batch rather than exactly N lets a job for one company start
    // even when the oldest pending jobs all belong to a company that is full.
    const candidateJobs = await jobQueueCollection
      .find({
        status: JOB_STATUS.PENDING,
        $or: [
          { nextRetryAt: { $exists: false } }, // New jobs
          { nextRetryAt: { $lte: new Date() } }, // Ready for retry
        ],
      })
      .sort({ createdAt: 1 })
      .limit(100)
      .toArray();

    const pendingJobs = [];
    const skippedByCompany = {};
    for (const candidate of candidateJobs) {
      const company = companyOfJob(candidate);
      const active = activeByCompany[company] || 0;
      if (active >= maxParallelFor(company)) {
        skippedByCompany[company] = (skippedByCompany[company] || 0) + 1;
        continue;
      }
      activeByCompany[company] = active + 1; // reserve the slot for this pass
      pendingJobs.push(candidate);
    }

    if (Object.keys(skippedByCompany).length) {
      // Also change-gated: while a company is saturated this would otherwise
      // repeat the identical line on every pass.
      const capacityMsg = Object.entries(skippedByCompany)
        .map(([c, n]) => `${companyLabel(c)}: ${n} queued`)
        .join(", ");
      if (capacityMsg !== lastLoggedCapacityState) {
        console.log(`[Queue] ⏸️  At capacity, waiting -> ${capacityMsg}`);
        lastLoggedCapacityState = capacityMsg;
      }
    } else {
      lastLoggedCapacityState = null;
    }

    if (pendingJobs.length === 0) {
      // Not silent: if jobs exist but are waiting on retry backoff, say when the next is due
      const nextDue = await jobQueueCollection
        .find({ status: JOB_STATUS.PENDING, nextRetryAt: { $gt: new Date() } })
        .sort({ nextRetryAt: 1 })
        .limit(1)
        .toArray();

      if (nextDue.length > 0) {
        const dueAt = nextDue[0].nextRetryAt.getTime();

        // Report a given wait ONCE rather than counting down out loud on
        // every poll tick.
        if (dueAt !== lastLoggedBackoffAt) {
          const waitSec = Math.ceil((dueAt - Date.now()) / 1000);
          console.log(`[Queue] ⏳ Job waiting — due in ${waitSec}s`);
          lastLoggedBackoffAt = dueAt;
        }

        // Wake up exactly when that job becomes due, instead of leaving it to
        // the 15s poll. Without this a job that finished its stabilization
        // window one second after a queue pass sat idle for the rest of the
        // poll interval, even though a browser slot was free.
        scheduleQueueWakeup(dueAt);
      }
      return; // No pending jobs ready
    }

    console.log(
      `[Reliance Queue] Found ${pendingJobs.length} pending jobs, starting processing...`
    );

    // Start processing each job
    for (const job of pendingJobs) {
      // Claim the job ATOMICALLY: only transition it if it is still PENDING.
      // With parallel workers (and the re-entrant call in .finally below) two
      // passes can otherwise select and start the same job twice — which would
      // submit the same policy twice.
      const claim = await jobQueueCollection.findOneAndUpdate(
        { _id: job._id, status: JOB_STATUS.PENDING },
        {
          $set: {
            status: JOB_STATUS.PROCESSING,
            startedAt: new Date(),
            lastHeartbeatAt: new Date(),
          },
        }
      );

      const claimed = claim && (claim.value !== undefined ? claim.value : claim);
      if (!claimed) {
        console.log(
          `[Queue] Job ${job._id} was already claimed by another pass, skipping.`
        );
        continue;
      }

      activeRelianceJobs++;
      console.log(
        `[${companyOfJob(job) === "national" ? "National" : "Reliance"} Queue] Starting job for ${job.formData.firstName} (ID: ${job._id}); active=${activeRelianceJobs}`
      );

      // Keep proving this job is alive for as long as it runs.
      const heartbeat = startJobHeartbeat(job._id);

      // Run job in parallel (don't await)
      runPolicyJob(job)
        .catch((unexpectedError) => {
          // Safety net: Catch any unhandled errors
          console.error(
            `[Reliance Queue] 💥 UNEXPECTED ERROR for ${job.formData.firstName}:`,
            unexpectedError.message
          );
          console.error("Stack trace:", unexpectedError.stack);

          // Ensure job is not left in "processing" state
          // companyName is a runPolicyJob local — referencing it here threw
          // ReferenceError inside the error handler itself, so the job was
          // never reset and sat in "processing" until the zombie reclaim.
          const beautifiedMsg = beautifyError(unexpectedError, companyLabel(companyOfJob(job)));
          jobQueueCollection
            .updateOne(
              { _id: job._id },
              {
                $set: {
                  status: JOB_STATUS.PENDING, // Reset to pending for retry
                  lastError: `Unexpected error: ${beautifiedMsg}`,
                  lastErrorTimestamp: new Date(),
                },
                $inc: { attempts: 1 },
              }
            )
            .catch((err) =>
              console.error("Failed to update job after unexpected error:", err)
            );
        })
        .finally(() => {
          clearInterval(heartbeat);
          activeRelianceJobs--;
          // Try to process more jobs
          void processRelianceQueue();
        });
    }
  } catch (error) {
    const beautifiedMsg = beautifyError(error, 'queue');
    console.error("[Reliance Queue] Error processing queue:", beautifiedMsg);
  } finally {
    queuePassRunning = false;
    // A trigger arrived while we were scheduling — honour it now.
    if (queuePassRequested) {
      queuePassRequested = false;
      setImmediate(() => void processRelianceQueue());
    }
  }
};

/**
 * Fill in a backend-enqueued job's full formData from its source policy.
 *
 * The backend enqueues a THIN job ({needsHydration:true}) so it doesn't have to
 * duplicate this ~100-field mapping. We build the real payload here, at claim
 * time, and persist it back onto the job.
 *
 * Returns the job (hydrated in place), or null if the source policy is gone.
 */
const hydrateJobFormData = async (job) => {
  const needsHydration = job.needsHydration === true || !job.formData?.mobile;
  if (!needsHydration) return job;

  if (!job.captchaId) {
    console.warn(`[Queue] Job ${job._id} needs hydration but has no captchaId — using existing formData`);
    return job;
  }

  console.log(`[Queue] 💧 Hydrating job ${job._id} from policy ${job.captchaId}...`);
  const policy = await db.collection("onlinePolicy").findOne({ _id: job.captchaId });

  // Only a genuinely MISSING policy is terminal. Anything that throws (a
  // transient Mongo blip) propagates to the caller and is retried, rather than
  // permanently failing a valid job.
  if (!policy) {
    console.error(`[Queue] ❌ Source policy ${job.captchaId} not found for job ${job._id}`);
    return { missingPolicy: true };
  }

  const rawFormData = await buildFormDataFromPolicy(policy);

  // Re-apply the validation/normalisation that used to run in
  // enqueueRelianceJob. That path is unreachable now that the backend enqueues
  // directly, and without this an invalid pincode/mobile would drive a real
  // portal submission instead of being rejected up front.
  const formData = sanitizeFormData(rawFormData);
  const validation = validateFormData(formData, companyOfJob({ formData }));
  if (!validation.isValid) {
    console.error(
      `[Queue] ❌ Job ${job._id} failed validation: ${validation.errors.join(", ")}`
    );
    return { invalid: true, errors: validation.errors };
  }

  await jobQueueCollection.updateOne(
    { _id: job._id },
    {
      $set: {
        formData,
        needsHydration: false,
        hydratedAt: new Date(),
        // Restores the cross-document duplicate guard (checkDuplicateSubmission)
        idempotencyKey: generateIdempotencyKey(formData),
      },
    }
  );

  console.log(`[Queue] ✅ Hydrated job ${job._id} (${formData.firstName}, company: ${formData.Companyname})`);
  return { ...job, formData, needsHydration: false };
};

const runPolicyJob = async (rawJob) => {
  // Backend-created jobs carry only a thin payload — fill it in before any
  // of the code below reads job.formData.
  let job;
  try {
    job = await hydrateJobFormData(rawJob);
  } catch (hydrationError) {
    // TRANSIENT failure (Mongo hiccup, S3 presign error) — put the job back so
    // it retries. Marking it failed here would kill a perfectly valid job.
    console.error(`[Queue] ⚠️ Hydration error for job ${rawJob._id} (will retry):`, hydrationError.message);
    await jobQueueCollection.updateOne(
      { _id: rawJob._id },
      {
        $set: {
          status: JOB_STATUS.PENDING,
          lastError: `Could not prepare job data: ${hydrationError.message}`,
          lastErrorTimestamp: new Date(),
          nextRetryAt: new Date(Date.now() + 30000),
        },
        $inc: { attempts: 1 },
      }
    );
    return;
  }

  // TERMINAL problems — retrying cannot help.
  if (job.missingPolicy || job.invalid) {
    const reason = job.missingPolicy
      ? "Source online policy not found — cannot build job data"
      : `Invalid policy data: ${(job.errors || []).join(", ")}`;
    await jobQueueCollection.updateOne(
      { _id: rawJob._id },
      {
        $set: {
          status: JOB_STATUS.FAILED_VALIDATION,
          lastError: reason,
          lastErrorTimestamp: new Date(),
          failedAt: new Date(),
        },
      }
    );
    console.error(`[Queue] ❌ Job ${rawJob._id} terminal: ${reason}`);
    return;
  }

  const jobIdentifier = `${job.formData.firstName}_${job._id}`;
  const processingStartTime = Date.now();
  const companyName = (job.formData.Companyname || job.formData.company || "reliance").toLowerCase();
  const queueName = `${companyLabel(companyName)} Queue`;

  // Log processing start
  await logAuditEntry('JOB_PROCESSING_STARTED', {
    jobId: job._id,
    customerName: `${job.formData.firstName} ${job.formData.lastName}`,
    attemptNumber: job.attempts + 1,
    maxAttempts: job.maxAttempts
  });

  try {
    // Normalize company name - derived at function start

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[${queueName}] 🔄 Processing ${companyName} form for: ${job.formData.firstName} ${job.formData.lastName}`);
    console.log(`[${queueName}] 📋 Job ID: ${job._id} | Attempt: ${job.attempts + 1}/${job.maxAttempts}`);
    console.log(`${'═'.repeat(70)}`);
    console.log(
      `[${queueName}] Company detection: job.formData.Companyname="${job.formData.Companyname}", job.formData.company="${job.formData.company}", normalized="${companyName}"`
    );

    // Fetch credentials from DB
    console.log(`→ [${queueName}] Fetching ${companyName} credentials from database...`);

    // Resolve the portal login: THE POLICY'S OWN USER FIRST, then the client
    // they belong to. Applies to every insurer.
    //
    // Both levels live in the same ProviderCredential collection — the backend's
    // syncProviderCredentials writes each record's own _id into `clientId`,
    // whether that record is a user or a client (RayalBrokers-backend/dao/
    // clientDao.js). So the two lookups differ only in which id they carry.
    //
    // There is deliberately NO "any active credential" fallback any more. It
    // used to silently pick the first active row for the insurer, which meant a
    // policy could be filed through a DIFFERENT client's portal login — issued
    // under the wrong IMD code, with nothing in the logs to say so. Failing
    // loudly is the correct outcome: the message below tells the operator
    // exactly what to add and where, and the job retries on its own once they
    // have added it.
    const credentialSources = [
      { id: job.formData.userId, label: "user" },
      { id: job.formData.clientId, label: "client" },
    ];

    let creds = null;
    let credsSource = null;
    for (const { id, label } of credentialSources) {
      if (!id) continue;
      console.log(`→ [${queueName}] Looking for ${companyName} credentials on ${label} ${id}`);
      creds = await ProviderCredential.findOne({
        provider: companyName,
        clientId: id,
        isActive: true,
      });
      if (creds) {
        credsSource = label;
        console.log(`✓ [${queueName}] Using the ${label}'s ${companyName} login: ${creds.username}`);
        break;
      }
      console.log(`   ✗ [${queueName}] none on this ${label}`);
    }

    if (!creds) {
      const label = companyLabel(companyName);
      console.error(`❌ [${queueName}] No active ${companyName} credentials on the user or the client`);
      // Phrased for the operator who sees it in the policy's error log, not for
      // a developer — it has to say what to do next.
      throw new Error(
        `[E303] No active ${label} portal credentials found for this policy's ` +
        `user or client. Add the ${label} login on the User page (edit the ` +
        `user → Credentials) or in Profile → Account & Policy Settings, and ` +
        `this policy will retry automatically.`
      );
    }

    // Recorded on the job so a support question ("which login did this policy
    // actually go through?") is answerable from the job document alone.
    await jobQueueCollection.updateOne(
      { _id: job._id },
      { $set: { credentialSource: credsSource, credentialUsername: creds.username } }
    );

    // Route to appropriate form filling function based on Companyname
    let fillFormPromise;
    if (companyName === "national") {
      // National Insurance form
      fillFormPromise = fillNationalForm({
        ...job.formData,
        // username: "9999839907", // Always use this username for National
        // password: "Rayal$2025",
        username: creds.username,
        password: creds.password,
        _jobId: job._id, // Pass job ID for error logging
        _jobIdentifier: jobIdentifier,
        _attemptNumber: job.attempts + 1, // Current attempt number
        _jobQueueCollection: jobQueueCollection, // Pass collection for logging
      });
    } else if (companyName === "kshema") {
      // KSHEMA. Phase 1: opens the portal login page, fills the credentials in
      // and stops there without submitting — so it reports failure on purpose
      // (see fullPolicycompany/kshemaForm.js). loginUrl is passed through
      // because KSHEMA credentials store their own portal URL.
      fillFormPromise = fillKshemaForm({
        ...job.formData,
        username: creds.username,
        password: creds.password,
        loginUrl: creds.loginUrl,
        _jobId: job._id,
        _jobIdentifier: jobIdentifier,
        _attemptNumber: job.attempts + 1,
        _jobQueueCollection: jobQueueCollection,
      });
    } else {
      // Reliance form (default)
      fillFormPromise = fillRelianceForm({
        // NOTE: credentials come AFTER the spread on purpose. formData carries
        // hardcoded defaults ("rfcpolicy"/"Pass@123"), so spreading it last
        // silently overwrote this client's real credentials — every job then
        // logged into the portal as the default user and policies were issued
        // under the wrong IMD code. (The National branch above already had the
        // correct order.)
        ...job.formData,
        username: creds.username,
        password: creds.password,
        _jobId: job._id, // Pass job ID for error logging
        _jobIdentifier: jobIdentifier,
        _attemptNumber: job.attempts + 1, // Current attempt number
        _jobQueueCollection: jobQueueCollection, // Pass collection for logging
      });
    }

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`[E302] Job timeout after ${JOB_TIMEOUT / 1000} seconds`)),
        JOB_TIMEOUT
      )
    );

    // Race between job completion and timeout
    const result = await Promise.race([fillFormPromise, timeoutPromise]);

    const processingTimeMs = Date.now() - processingStartTime;

    if (result && result.success) {
      // Collect non-fatal warnings (form WAS submitted, but post steps failed)
      const completionWarnings = [];
      if (result.briskCertificateError) {
        completionWarnings.push(`Brisk certificate creation failed: ${result.briskCertificateError}`);
      }
      if (result.documentUploadError) {
        completionWarnings.push(result.documentUploadError);
      }

      const finalStatus = completionWarnings.length
        ? JOB_STATUS.COMPLETED_WITH_ERRORS
        : JOB_STATUS.COMPLETED;

      // 🎉 SUCCESS - Mark as completed (with errors, if any) in database
      const updateDoc = {
        $set: {
          status: finalStatus,
          completedAt: new Date(),
          completedAttempt: job.attempts + 1,
          processingTimeMs: processingTimeMs,
          ...(completionWarnings.length && {
            completionWarnings: completionWarnings,
            briskCertificateError: result.briskCertificateError || null,
            documentUploadError: result.documentUploadError || null,
          })
        },
        $push: {
          statusHistory: {
            from: JOB_STATUS.PROCESSING,
            to: finalStatus,
            timestamp: new Date()
          },
          ...(completionWarnings.length && {
            errorLogs: {
              $each: completionWarnings.map((w) => ({
                errorMessage: w,
                errorCode: "E_POST_COMPLETION_WARNING",
                failureType: "PostCompletionWarning",
                timestamp: new Date()
              }))
            }
          })
        }
      };

      await jobQueueCollection.updateOne({ _id: job._id }, updateDoc);

      console.log(`\n${'═'.repeat(70)}`);
      if (completionWarnings.length) {
        console.log(`${queueName} ⚠️ COMPLETED WITH ERRORS for ${job.formData.firstName} (ID: ${job._id})`);
        completionWarnings.forEach((w) => console.log(`${queueName}    ⚠️ ${w}`));
      } else {
        console.log(`${queueName} ✅ SUCCESS for ${job.formData.firstName} (ID: ${job._id})`);
      }
      console.log(`${queueName} ⏱️  Processing time: ${(processingTimeMs / 1000).toFixed(2)}s`);
      console.log(`${'═'.repeat(70)}\n`);

      // Log audit entry for success
      await logAuditEntry(completionWarnings.length ? 'JOB_COMPLETED_WITH_ERRORS' : 'JOB_COMPLETED', {
        jobId: job._id,
        customerName: `${job.formData.firstName} ${job.formData.lastName}`,
        company: companyName,
        processingTimeMs: processingTimeMs,
        attemptNumber: job.attempts + 1,
        ...(completionWarnings.length && { warnings: completionWarnings })
      });

    } else {
      // ❌ FAILURE - Handle based on failure type
      const newAttemptCount = job.attempts + 1;

      // Classify the error
      const isPostSubmissionFailure =
        result?.postSubmissionFailed ||
        result?.stage === "post-submission" ||
        result?.stage === "post-calculation";

      // A failure the form module says retrying cannot fix — a portal that
      // REJECTED the login being the case that matters. Repeating the same
      // wrong password four more times cannot succeed, and every attempt
      // counts against the portal's lockout limit, so a retry actively makes
      // things worse: the operator fixes the credential and finds the account
      // locked as well. Any company can set `retryable: false` on its result.
      const isTerminalFailure = result?.retryable === false;

      // The automation reached the end of what has been built for this insurer
      // rather than hitting a problem. Still not a completed policy — nothing
      // was submitted — but the red failure banner and the CRITICAL audit
      // entry are both wrong for it.
      const isInProgress = result?.inProgress === true;

      // Use structured error codes
      const errorCode = isPostSubmissionFailure
        ? 'E401'
        : isInProgress ? 'E100' : 'E300';
      const failureType = isPostSubmissionFailure
        ? "PostSubmissionError"
        : isInProgress ? "AutomationIncomplete" : "LoginFormError";
      const severity = isPostSubmissionFailure
        ? 'critical'
        : isInProgress ? 'info' : 'warning';

      // Use proper extracted message if available, otherwise fallback to Selenium error
      const rawError = result?.onPageError || result?.error || "Unknown error";
      const finalErrorMessage = beautifyError(rawError, companyLabel(companyName));

      // Create enhanced error log with structured codes
      const errorLog = {
        timestamp: new Date(),
        attemptNumber: newAttemptCount,
        errorCode: errorCode,
        errorMessage: finalErrorMessage,
        errorType: failureType,
        severity: severity,
        stage: result?.stage || (isPostSubmissionFailure ? "post-submission" : "login-form"),
        screenshotUrl: result?.screenshotUrl || null,
        screenshotKey: result?.screenshotKey || null,
        processingTimeMs: processingTimeMs,
        retryable: !isPostSubmissionFailure && !isTerminalFailure
      };

      // Add error to errorLogs array
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $inc: { attempts: 1 },
          $push: {
            errorLogs: errorLog,
            statusHistory: {
              from: JOB_STATUS.PROCESSING,
              to: isPostSubmissionFailure ? JOB_STATUS.FAILED_POST_SUBMISSION : JOB_STATUS.PROCESSING,
              timestamp: new Date(),
              reason: errorLog.errorMessage
            }
          },
          $set: {
            lastError: errorLog.errorMessage,
            lastErrorCode: errorCode,
            lastErrorTimestamp: errorLog.timestamp,
            lastScreenshotUrl: errorLog.screenshotUrl,
            lastAttemptAt: new Date(),
            failureType: failureType,
            processingTimeMs: processingTimeMs
          },
        }
      );

      const updatedJob = await jobQueueCollection.findOne({ _id: job._id });

      // 🔴 Terminal login failures (e.g. the portal rejected the credentials):
      // mark failed straight away. No backoff, no further attempts.
      if (isTerminalFailure && !isPostSubmissionFailure) {
        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.FAILED_LOGIN_FORM,
              failedAt: new Date(),
              lastError: errorLog.errorMessage,
              lastScreenshotUrl: errorLog.screenshotUrl,
              finalError: errorLog,
            },
          }
        );

        if (isInProgress) {
          console.log(`\n${'⏸️ '.repeat(23)}`);
          console.log(`${queueName} ⏸️  STOPPED — automation not finished yet for ${job.formData.firstName}`);
          console.log(`${queueName} 📋 ${errorLog.errorMessage}`);
          console.log(`${'⏸️ '.repeat(23)}\n`);
        } else {
          console.error(`\n${'🔴'.repeat(35)}`);
          console.error(`${queueName} ❌ FAILED — NOT RETRYING for ${job.formData.firstName}`);
          console.error(`${queueName} 📋 ${errorLog.errorMessage}`);
          console.error(`${queueName} 📋 Retrying cannot fix this — the policy must be re-run once it is sorted.`);
          if (errorLog.screenshotUrl) {
            console.error(`${queueName} 📸 Screenshot: ${errorLog.screenshotUrl}`);
          }
          console.error(`${'🔴'.repeat(35)}\n`);
        }

        await logAuditEntry(isInProgress ? 'JOB_STOPPED_INCOMPLETE' : 'JOB_FAILED_TERMINAL', {
          jobId: job._id,
          customerName: `${job.formData.firstName} ${job.formData.lastName}`,
          company: companyName,
          errorCode: errorCode,
          errorMessage: errorLog.errorMessage,
          severity: isInProgress ? 'info' : 'CRITICAL',
          requiresManualReview: !isInProgress,
          processingTimeMs: processingTimeMs,
        });
      }
      // 🔴 Post-submission failures: Mark as failed immediately (CRITICAL - NO RETRY - money involved)
      else if (isPostSubmissionFailure) {
        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.FAILED_POST_SUBMISSION,
              failedAt: new Date(),
              lastError: errorLog.errorMessage,
              lastScreenshotUrl: errorLog.screenshotUrl,
              finalError: errorLog,
            },
          }
        );

        console.error(`\n${'🔴'.repeat(35)}`);
        console.error(`${queueName} ❌ CRITICAL FAILURE (POST-SUBMISSION) for ${job.formData.firstName}`);
        console.error(`${queueName} ⚠️  NO RETRY - Form already submitted, may have charges`);
        console.error(`${queueName} 📋 Error Code: ${errorCode}`);
        console.error(`${queueName} 📝 Error: ${errorLog.errorMessage}`);
        if (errorLog.screenshotUrl) {
          console.error(`${queueName} 📸 Screenshot: ${errorLog.screenshotUrl}`);
        }
        console.error(`${'🔴'.repeat(35)}\n`);

        // Log critical audit entry
        await logAuditEntry('JOB_FAILED_CRITICAL', {
          jobId: job._id,
          customerName: `${job.formData.firstName} ${job.formData.lastName}`,
          errorCode: errorCode,
          errorMessage: errorLog.errorMessage,
          severity: 'CRITICAL',
          requiresManualReview: true,
          processingTimeMs: processingTimeMs
        });
      }
      // 🟠 Login form failures: Retry logic
      else if (updatedJob.attempts >= updatedJob.maxAttempts) {
        // Max attempts reached for login form failures
        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.FAILED_LOGIN_FORM,
              failedAt: new Date(),
              finalError: errorLog,
            },
          }
        );

        console.error(`\n${'🟠'.repeat(35)}`);
        console.error(`${queueName} ❌ FAILED PERMANENTLY (LOGIN FORM) for ${job.formData.firstName}`);
        console.error(`${queueName} 📋 Attempts exhausted: ${updatedJob.attempts}/${updatedJob.maxAttempts}`);
        console.error(`${queueName} 📋 Error Code: ${errorCode}`);
        console.error(`${queueName} 📝 Last error: ${errorLog.errorMessage}`);
        if (errorLog.screenshotUrl) {
          console.error(`${queueName} 📸 Screenshot: ${errorLog.screenshotUrl}`);
        }
        console.error(`${'🟠'.repeat(35)}\n`);

        // Log audit entry
        await logAuditEntry('JOB_FAILED_MAX_RETRIES', {
          jobId: job._id,
          customerName: `${job.formData.firstName} ${job.formData.lastName}`,
          errorCode: errorCode,
          errorMessage: errorLog.errorMessage,
          attempts: updatedJob.attempts,
          maxAttempts: updatedJob.maxAttempts,
          processingTimeMs: processingTimeMs
        });
      } else {
        // Retry login form failures: reset to pending
        const retryDelay = 60000 * Math.pow(2, updatedJob.attempts - 1); // Exponential backoff
        const nextRetryAt = new Date(Date.now() + retryDelay);

        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.PENDING,
              nextRetryAt: nextRetryAt,
            },
            $inc: { 'metadata.retryCount': 1 }
          }
        );

        // Wake the queue exactly when the retry is due (30s poll is only a backstop)
        setTimeout(() => void processRelianceQueue(), retryDelay + 1000);

        console.warn(`\n${'🟡'.repeat(35)}`);
        console.warn(`${queueName} ⚠️ FAILED (LOGIN FORM) for ${job.formData.firstName}`);
        console.warn(`${queueName} 🔄 Will retry in ${retryDelay / 1000}s (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`);
        console.warn(`${queueName} 📋 Error Code: ${errorCode}`);
        if (errorLog.screenshotUrl) {
          console.warn(`${queueName} 📸 Screenshot: ${errorLog.screenshotUrl}`);
        }
        console.warn(`${'🟡'.repeat(35)}\n`);

        // Log audit entry
        await logAuditEntry('JOB_RETRY_SCHEDULED', {
          jobId: job._id,
          customerName: `${job.formData.firstName} ${job.formData.lastName}`,
          errorCode: errorCode,
          attempt: updatedJob.attempts,
          maxAttempts: updatedJob.maxAttempts,
          nextRetryAt: nextRetryAt
        });
      }
    }
  } catch (e) {
    const processingTimeMs = Date.now() - processingStartTime;

    // stopper() was called somewhere in the flow. Not a failure — the run
    // reached a deliberate stopping point — so it is recorded the same calm way
    // a module returning { inProgress: true } is, and no red banner is printed.
    if (isAutomationStop(e)) {
      const stopped = stoppedResult(e);
      console.log(`\n${'⏸️ '.repeat(23)}`);
      console.log(`${queueName} ⏸️  STOPPED at a deliberate stopping point for ${job.formData.firstName}`);
      console.log(`${queueName} 📋 ${stopped.error}`);
      console.log(`${'⏸️ '.repeat(23)}\n`);

      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $inc: { attempts: 1 },
          $set: {
            status: JOB_STATUS.FAILED_LOGIN_FORM,
            failedAt: new Date(),
            lastError: stopped.error,
            lastErrorCode: "E100",
            lastErrorTimestamp: new Date(),
            failureType: "AutomationIncomplete",
            processingTimeMs,
          },
          $push: {
            statusHistory: {
              from: JOB_STATUS.PROCESSING,
              to: JOB_STATUS.FAILED_LOGIN_FORM,
              timestamp: new Date(),
              reason: stopped.error,
            },
          },
        }
      );

      await logAuditEntry('JOB_STOPPED_INCOMPLETE', {
        jobId: job._id,
        customerName: `${job.formData.firstName} ${job.formData.lastName}`,
        company: companyName,
        errorCode: "E100",
        errorMessage: stopped.error,
        severity: 'info',
        requiresManualReview: false,
        processingTimeMs,
      });
      return;
    }

    console.error(
      `${queueName} ❌ EXCEPTION for ${job.formData.firstName}:`,
      e.message
    );

    // Classify the error using our error handler
    const { classifyError } = require("./lib/errorHandler");
    const classified = classifyError(e);

    // Increment attempt and create enhanced error log
    const newAttemptCount = job.attempts + 1;

    const errorLog = {
      timestamp: new Date(),
      attemptNumber: newAttemptCount,
      errorCode: classified.code,
      errorMessage: e.message,
      errorStack: e.stack || null,
      errorType: classified.severity === 'critical' ? 'SystemError' : 'LoginFormError',
      severity: classified.severity,
      stage: "exception",
      retryable: classified.retryable,
      processingTimeMs: processingTimeMs
    };

    // Add error to errorLogs array
    await jobQueueCollection.updateOne(
      { _id: job._id },
      {
        $inc: { attempts: 1 },
        $push: { errorLogs: errorLog },
        $set: {
          lastError: beautifyError(e, companyLabel(companyName)),
          lastErrorCode: classified.code,
          lastErrorTimestamp: errorLog.timestamp,
          lastAttemptAt: new Date(),
          failureType: errorLog.errorType,
          processingTimeMs: processingTimeMs
        },
      }
    );

    const updatedJob = await jobQueueCollection.findOne({ _id: job._id });

    if (updatedJob.attempts >= updatedJob.maxAttempts || !classified.retryable) {
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.FAILED_LOGIN_FORM,
            failedAt: new Date(),
            finalError: errorLog,
          },
        }
      );

      console.error(`${queueName} ❌ Failed permanently [${classified.code}] after ${updatedJob.attempts} attempts`);

      // Log audit entry
      await logAuditEntry('JOB_FAILED_EXCEPTION', {
        jobId: job._id,
        customerName: `${job.formData.firstName} ${job.formData.lastName}`,
        errorCode: classified.code,
        errorMessage: e.message,
        attempts: updatedJob.attempts,
        retryable: classified.retryable,
        processingTimeMs: processingTimeMs
      });
    } else {
      const retryDelay = 60000 * Math.pow(2, updatedJob.attempts - 1);
      const nextRetryAt = new Date(Date.now() + retryDelay);

      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.PENDING,
            nextRetryAt: nextRetryAt,
          },
        }
      );

      // Wake the queue exactly when the retry is due (30s poll is only a backstop)
      setTimeout(() => void processRelianceQueue(), retryDelay + 1000);

      console.warn(
        `${queueName} ⚠️ Will retry [${classified.code}] in ${retryDelay / 1000}s (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`
      );

      // Log audit entry
      await logAuditEntry('JOB_RETRY_AFTER_EXCEPTION', {
        jobId: job._id,
        customerName: `${job.formData.firstName} ${job.formData.lastName}`,
        errorCode: classified.code,
        attempt: updatedJob.attempts,
        nextRetryAt: nextRetryAt
      });
    }
  }
};

db.on("error", console.error.bind(console, "connection error:"));
db.once("open", async () => {
  console.log("Connected to MongoDB");

  // Initialize job queue collection
  jobQueueCollection = db.collection("RelianceJobQueue");

  // Create indexes for better performance
  await jobQueueCollection.createIndex({ status: 1, createdAt: 1 });
  await jobQueueCollection.createIndex({ createdAt: 1 });
  await jobQueueCollection.createIndex({ captchaId: 1 }); // For job-status API lookups
  await jobQueueCollection.createIndex({ "errorLogs.timestamp": 1 }); // For error history queries

  console.log("[Job Queue] Initialized persistent job queue with indexes");

  // STARTUP RECOVERY: every "processing" job becomes "pending" again.
  // On a fresh start no browser from a previous run can still be alive, so
  // anything left in processing is by definition abandoned — reset it
  // unconditionally rather than waiting for the heartbeat window. (While the
  // server is RUNNING the opposite rule applies: a live job is never touched.)
  const stuckJobs = await jobQueueCollection.updateMany(
    { status: JOB_STATUS.PROCESSING },
    {
      $set: {
        status: JOB_STATUS.PENDING,
        recoveredAt: new Date(),
      },
      // Drop the previous run's heartbeat so it can't look "alive"
      $unset: { lastHeartbeatAt: "" },
    }
  );

  if (stuckJobs.modifiedCount > 0) {
    console.log(
      `[Job Queue] 🔄 Recovered ${stuckJobs.modifiedCount} jobs that were stuck in processing state`
    );
  }

  // Clear stale retry backoff on restart — otherwise "will start processing" waits
  // silently until an old nextRetryAt (1-16 min backoff) expires + next 30s poll tick
  const clearedBackoff = await jobQueueCollection.updateMany(
    { status: JOB_STATUS.PENDING, nextRetryAt: { $exists: true } },
    { $unset: { nextRetryAt: "" } }
  );

  if (clearedBackoff.modifiedCount > 0) {
    console.log(
      `[Job Queue] ⏩ Cleared retry backoff on ${clearedBackoff.modifiedCount} pending job(s) — running them now`
    );
  }

  // Count pending jobs and start processing
  const pendingCount = await jobQueueCollection.countDocuments({
    status: JOB_STATUS.PENDING,
  });

  if (pendingCount > 0) {
    console.log(
      `[Job Queue] Found ${pendingCount} pending/recovered jobs, will start processing...`
    );
    void processRelianceQueue();
  } else {
    console.log("[Job Queue] No pending jobs found on startup.");
  }

  // PERIODIC SWEEP: every QUEUE_POLL_INTERVAL_MS, look for pending jobs and
  // start them.
  //
  // This is a safety net, not the main trigger — pending work normally starts
  // instantly via the queue change stream (on insert), the re-check after each
  // finished job, and the exact-time wakeup for a job still inside its settle
  // window. The sweep covers the cases those miss: a dropped change stream, a
  // job reclaimed from a dead handler, or a row written straight into Mongo.
  console.log(
    `[Queue] Periodic pending-job sweep every ${QUEUE_POLL_INTERVAL_MS / 1000}s`
  );
  setInterval(() => {
    // Only poll if we have space for more jobs
    if (activeRelianceJobs < MAX_PARALLEL_JOBS) {
      void processRelianceQueue();
    }
  }, QUEUE_POLL_INTERVAL_MS);

  // ─────────────────────────────────────────────────────────────────────────
  // Queue-first: the RelianceJobQueue is now the single source of truth.
  //
  // We no longer watch the onlinePolicy collection. A change stream only
  // fires while THIS process is running, so any policy created while the
  // automation server was down never produced a job and silently never ran.
  // The backend now writes the queue entry itself (see
  // RayalBrokers-backend/dao/onlinePolicyDao.js -> enqueuePolicyJob), on both
  // policy create and policy update.
  //
  // Here we just react to new queue entries as fast as possible; the periodic
  // poll above is the safety net if this stream drops.
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const jobChangeStream = jobQueueCollection.watch(
      [{ $match: { operationType: { $in: ["insert", "replace"] } } }],
      { fullDocument: "updateLookup" }
    );

    jobChangeStream.on("change", (change) => {
      const newJobId = change.documentKey?._id;
      console.log(`[Job Queue] 📥 New job detected (${newJobId}) — processing...`);
      void processRelianceQueue();
    });

    jobChangeStream.on("error", (err) => {
      console.error("[Job Queue] Change stream error (poll will keep things moving):", err.message);
    });

    console.log("[Job Queue] 👀 Watching RelianceJobQueue for new jobs");
  } catch (watchError) {
    console.error("[Job Queue] Could not start queue watcher — relying on the periodic poll:", watchError.message);
  }
});

// Setup Express app for API routes
const app = express();

const storage = multer.memoryStorage();
const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  storage,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Captcha extraction endpoint
app.post("/api/extract-captcha", upload.single("image"), async (req, res) => {
  try {
    const imageBuffer = req.file.buffer;
    const imageBase64 = imageBuffer.toString("base64");
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    const result = await extractCaptchaText(imageUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ============================================
// JOB STATUS API ENDPOINTS
// ============================================

/**
 * GET /api/job-status/:captchaId
 * Get job status and details by Captcha ID
 *
 * Returns:
 * - Job status (pending/processing/completed/failed_login_form/failed_post_submission)
 * - Failure type (LoginFormError/PostSubmissionError)
 * - Attempt count
 * - Error logs with screenshots
 * - Timestamps
 */
app.get("/api/job-status/:captchaId", async (req, res) => {
  try {
    const { captchaId } = req.params;

    // Validate captchaId format
    if (!captchaId || captchaId.length !== 24) {
      return res.status(400).json({
        success: false,
        message: "Invalid captcha ID format",
      });
    }

    // Convert to MongoDB ObjectId
    const ObjectId = require("mongodb").ObjectId;
    const captchaObjectId = new ObjectId(captchaId);

    // Find job by captchaId reference (use lean for plain object)
    const job = await jobQueueCollection.findOne({
      captchaId: captchaObjectId,
    }).lean();

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found for this captcha ID",
        captchaId: captchaId,
      });
    }

    // Generate presigned URLs for each error log entry that has a screenshotKey
    const errorLogs = job.errorLogs || [];
    const enrichedErrorLogs = await Promise.all(errorLogs.map(async (log) => {
      const logCopy = { ...(log.toObject ? log.toObject() : log) };
      let s3Key = logCopy.screenshotKey;

      // Fallback: extract key from screenshotUrl if screenshotKey is missing
      if (!s3Key && logCopy.screenshotUrl && logCopy.screenshotUrl.includes('.amazonaws.com/')) {
        try {
          const urlParts = logCopy.screenshotUrl.split('.amazonaws.com/');
          if (urlParts.length > 1) {
            s3Key = urlParts[1];
            console.log(`🔍 Extracted S3 key from URL: ${s3Key}`);
          }
        } catch (e) {
          console.warn("⚠️ Failed to extract S3 key from URL:", e.message);
        }
      }

      if (s3Key) {
        try {
          const presignedUrl = await getPresignedUrl(s3Key);
          if (presignedUrl) {
            logCopy.screenshotUrl = presignedUrl;
          }
        } catch (err) {
          console.warn(`⚠️ Failed to generate presigned URL for log ${log.attemptNumber}:`, err.message);
        }
      }
      return logCopy;
    }));

    // Prepare response data
    const responseData = {
      // IDs
      captchaId: captchaId,
      jobId: job._id.toString(),

      // Status
      status: job.status,
      failureType: job.failureType || null, // "LoginFormError" or "PostSubmissionError"

      // Progress
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      currentAttempt: job.attempts,
      retriesLeft: Math.max(0, job.maxAttempts - job.attempts),

      // Error information
      hasErrors: (job.errorLogs && job.errorLogs.length > 0) || false,
      errorCount: job.errorLogs ? job.errorLogs.length : 0,
      errorLogs: enrichedErrorLogs,
      lastError: job.lastError || null,
      lastErrorTimestamp: job.lastErrorTimestamp || null,
      finalError: job.finalError || null,

      // Special errors
      lastPostSubmissionError: job.lastPostSubmissionError || null,
      lastModalError: job.lastModalError || null,

      // Screenshots
      screenshotUrls: enrichedErrorLogs
        ? enrichedErrorLogs.map((e) => e.screenshotUrl).filter(Boolean)
        : [],

      // Timestamps
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      failedAt: job.failedAt || null,
      lastAttemptAt: job.lastAttemptAt || null,
      nextRetryAt: job.nextRetryAt || null,

      // Form data (customer info)
      customerData: {
        firstName: job.formData?.firstName,
        lastName: job.formData?.lastName,
        mobile: job.formData?.mobile,
        email: job.formData?.email,
      },
    };

    return res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[API] Error fetching job status:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

/**
 * GET /api/jobs
 * Get list of jobs with optional filtering
 *
 * Query parameters:
 * - status: Filter by status (pending/processing/completed/failed_login_form/failed_post_submission)
 * - limit: Number of results (default: 50, max: 100)
 * - skip: Number to skip for pagination (default: 0)
 * - sortBy: Sort field (default: createdAt)
 * - sortOrder: asc or desc (default: desc)
 *
 * Examples:
 * - GET /api/jobs?status=failed_login_form
 * - GET /api/jobs?status=failed_post_submission
 * - GET /api/jobs?status=completed&limit=20
 * - GET /api/jobs?limit=10&skip=10
 */
app.get("/api/jobs", async (req, res) => {
  try {
    const {
      status,
      limit = 50,
      skip = 0,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build filter
    const filter = {};
    if (status) {
      // Validate status
      const validStatuses = [
        "pending",
        "processing",
        "completed",
        "failed_login_form",
        "failed_post_submission",
      ];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${validStatuses.join(
            ", "
          )}`,
        });
      }
      filter.status = status;
    }

    // Validate and sanitize pagination
    const limitNum = Math.min(parseInt(limit) || 50, 100); // Max 100
    const skipNum = Math.max(parseInt(skip) || 0, 0); // Min 0

    // Build sort
    const sortField = sortBy || "createdAt";
    const sortDirection = sortOrder === "asc" ? 1 : -1;
    const sort = { [sortField]: sortDirection };

    // Query jobs
    const jobs = await jobQueueCollection
      .find(filter)
      .sort(sort)
      .limit(limitNum)
      .skip(skipNum)
      .toArray();

    // Get total count for pagination
    const totalCount = await jobQueueCollection.countDocuments(filter);

    // Format response
    const formattedJobs = jobs.map((job) => ({
      jobId: job._id.toString(),
      captchaId: job.captchaId ? job.captchaId.toString() : null,
      status: job.status,
      failureType: job.failureType || null, // "LoginFormError" or "PostSubmissionError"
      attempts: job.attempts,
      customerName: `${job.formData?.firstName || ""} ${job.formData?.lastName || ""
        }`.trim(),
      mobile: job.formData?.mobile,
      hasErrors: job.errorLogs && job.errorLogs.length > 0,
      errorCount: job.errorLogs ? job.errorLogs.length : 0,
      lastError: job.lastError,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
    }));

    return res.json({
      success: true,
      data: formattedJobs,
      pagination: {
        total: totalCount,
        limit: limitNum,
        skip: skipNum,
        returned: formattedJobs.length,
        hasMore: skipNum + limitNum < totalCount,
        nextSkip: skipNum + limitNum < totalCount ? skipNum + limitNum : null,
      },
      filter: filter,
    });
  } catch (error) {
    console.error("[API] Error fetching jobs:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

/**
 * GET /api/jobs/stats
 * Get job statistics
 *
 * Returns:
 * - Total jobs by status
 * - Success rate
 * - Average attempts
 * - Recent failures
 */
app.get("/api/jobs/stats", async (req, res) => {
  try {
    const stats = await jobQueueCollection
      .aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            avgAttempts: { $avg: "$attempts" },
          },
        },
      ])
      .toArray();

    // Format statistics
    const statusCounts = {};
    stats.forEach((stat) => {
      statusCounts[stat._id] = {
        count: stat.count,
        avgAttempts: Math.round(stat.avgAttempts * 100) / 100,
      };
    });

    // Calculate totals
    const totalJobs = stats.reduce((sum, stat) => sum + stat.count, 0);
    const completedCount = statusCounts.completed?.count || 0;
    const failedCount = statusCounts.failed?.count || 0;
    const successRate =
      totalJobs > 0 ? Math.round((completedCount / totalJobs) * 100) : 0;

    return res.json({
      success: true,
      data: {
        total: totalJobs,
        byStatus: statusCounts,
        successRate: `${successRate}%`,
        metrics: {
          completed: completedCount,
          failed: failedCount,
          pending: statusCounts.pending?.count || 0,
          processing: statusCounts.processing?.count || 0,
        },
      },
    });
  } catch (error) {
    console.error("[API] Error fetching stats:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Create HTTP server with integrated Express app
const server = http.createServer((req, res) => {
  // Try Express routes first (for /api/* endpoints)
  if (req.url.startsWith("/api/")) {
    app(req, res);
    return;
  }

  // Serve the Vite app
  let filePath = path.join(
    __dirname,
    "vite-app",
    "dist",
    req.url === "/" ? "index.html" : req.url
  );
  const extname = path.extname(filePath);
  let contentType = "text/html";

  switch (extname) {
    case ".js":
      contentType = "text/javascript";
      break;
    case ".css":
      contentType = "text/css";
      break;
    case ".json":
      contentType = "application/json";
      break;
    case ".png":
      contentType = "image/png";
      break;
    case ".jpg":
      contentType = "image/jpg";
      break;
    case ".wav":
      contentType = "audio/wav";
      break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code == "ENOENT") {
        fs.readFile(
          path.join(__dirname, "vite-app", "dist", "index.html"),
          (err, content) => {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(content, "utf-8");
          }
        );
      } else {
        res.writeHead(500);
        res.end(
          "Sorry, check with the site admin for error: " + err.code + "..\n"
        );
        res.end();
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});

const io = new Server(server);

// Start server
server.listen(8800, async () => {
  console.log("Server started on http://localhost:8800");

  // ============================================
  // INITIALIZE MASTER SESSION
  // ============================================
  try {
    console.log("\n" + "=".repeat(60));
    console.log("  🚀 INITIALIZING RELIANCE AUTOMATION");
    console.log("=".repeat(60) + "\n");

    // await initializeMasterSession();
    // console.log("✅ Reliance master session initialized successfully\n");

    console.log("\n" + "=".repeat(60));
    console.log("  ✅ READY TO PROCESS JOBS");
    console.log("=".repeat(60));
    // console.log(
    //   "📊 Reliance Session Status:",
    //   JSON.stringify(getSessionStatus(), null, 2)
    // );
    console.log("📊 National: Uses fresh login for each job (no master session)");
    console.log("=".repeat(60) + "\n");
  } catch (e) {
    console.error("\n❌ Failed to initialize master session:", e.message);
    console.error("⚠️  Jobs may require manual login\n");
  }
});
