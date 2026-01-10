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
const { fillRelianceForm } = require("./relianceForm");
const { fillNationalForm } = require("./national");
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
  ERROR_CODES,
  ValidationError,
  PolicyAutomationError
} = require("./lib/errorHandler");

mongoose.connect(process.env.MONGODB_URI);

const db = mongoose.connection;

// Persistent Queue System using MongoDB
let activeRelianceJobs = 0;
const MAX_PARALLEL_JOBS = 3; // Process 3 jobs in parallel using multiple tabs in same browser
let jobQueueCollection = null; // Will be initialized after DB connection
let auditLogCollection = null; // For audit logging

// Job statuses
const JOB_STATUS = {
  PENDING: "pending", // Waiting in queue
  PROCESSING: "processing", // Currently being processed
  COMPLETED: "completed", // Successfully completed
  FAILED_LOGIN_FORM: "failed_login_form", // Failed during login page form filling
  FAILED_POST_SUBMISSION: "failed_post_submission", // Failed after form submission
  FAILED_VALIDATION: "failed_validation", // Failed input validation
  FAILED_DUPLICATE: "failed_duplicate", // Duplicate submission detected
};

/**
 * 🛡️ Enhanced Job Enqueue with Validation & Duplicate Detection
 * CRITICAL: Since money is involved, we validate and check for duplicates
 */
const enqueueRelianceJob = async (formData, captchaId = null) => {
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

    // Step 3: Check for duplicate submissions (CRITICAL: Prevent double charges)
    const idempotencyKey = generateIdempotencyKey(sanitizedData);
    const existingJob = await checkDuplicateSubmission(jobQueueCollection, idempotencyKey, 60);

    if (existingJob) {
      console.warn(`[Reliance Queue] ⚠️ Duplicate submission detected for ${sanitizedData.firstName}`);
      console.warn(`   Existing Job ID: ${existingJob._id}, Status: ${existingJob.status}`);

      // Log audit entry
      await logAuditEntry('DUPLICATE_DETECTED', {
        captchaId,
        customerName: `${sanitizedData.firstName} ${sanitizedData.lastName}`,
        existingJobId: existingJob._id,
        existingJobStatus: existingJob.status
      });

      // Return existing job ID instead of creating duplicate
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
      maxAttempts: 3,
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

const processRelianceQueue = async () => {
  if (!jobQueueCollection) return;

  try {
    // Count how many jobs are currently processing
    const processingCount = await jobQueueCollection.countDocuments({
      status: JOB_STATUS.PROCESSING,
    });

    activeRelianceJobs = processingCount;

    // Check if we can start more jobs
    if (activeRelianceJobs >= MAX_PARALLEL_JOBS) {
      return; // Already at max capacity
    }

    // Get pending jobs from database (oldest first)
    const availableSlots = MAX_PARALLEL_JOBS - activeRelianceJobs;
    const pendingJobs = await jobQueueCollection
      .find({ status: JOB_STATUS.PENDING })
      .sort({ createdAt: 1 })
      .limit(availableSlots)
      .toArray();

    if (pendingJobs.length === 0) {
      return; // No pending jobs
    }

    console.log(
      `[Reliance Queue] Found ${pendingJobs.length} pending jobs, starting processing...`
    );

    // Start processing each job
    for (const job of pendingJobs) {
      // Mark job as processing
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.PROCESSING,
            startedAt: new Date(),
          },
        }
      );

      activeRelianceJobs++;
      console.log(
        `[Reliance Queue] Starting job for ${job.formData.firstName} (ID: ${job._id}); active=${activeRelianceJobs}`
      );

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
          jobQueueCollection
            .updateOne(
              { _id: job._id },
              {
                $set: {
                  status: JOB_STATUS.PENDING, // Reset to pending for retry
                  lastError: `Unexpected error: ${unexpectedError.message}`,
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
          activeRelianceJobs--;
          // Try to process more jobs
          void processRelianceQueue();
        });
    }
  } catch (error) {
    console.error("[Reliance Queue] Error processing queue:", error.message);
  }
};

const runPolicyJob = async (job) => {
  const jobIdentifier = `${job.formData.firstName}_${job._id}`;
  const JOB_TIMEOUT = 300000; // 5 minutes timeout per job
  const processingStartTime = Date.now();

  // Log processing start
  await logAuditEntry('JOB_PROCESSING_STARTED', {
    jobId: job._id,
    customerName: `${job.formData.firstName} ${job.formData.lastName}`,
    attemptNumber: job.attempts + 1,
    maxAttempts: job.maxAttempts
  });

  try {
    // Normalize company name - check both Companyname and company fields, convert to lowercase
    const companyName = (job.formData.Companyname || job.formData.company || "reliance").toLowerCase();
    const queueName = companyName === "national" ? "National Queue" : "Reliance Queue";

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[${queueName}] 🔄 Processing ${companyName} form for: ${job.formData.firstName} ${job.formData.lastName}`);
    console.log(`[${queueName}] 📋 Job ID: ${job._id} | Attempt: ${job.attempts + 1}/${job.maxAttempts}`);
    console.log(`${'═'.repeat(70)}`);
    console.log(
      `[${queueName}] Company detection: job.formData.Companyname="${job.formData.Companyname}", job.formData.company="${job.formData.company}", normalized="${companyName}"`
    );

    // Route to appropriate form filling function based on Companyname
    let fillFormPromise;
    if (companyName === "national") {
      // National Insurance form
      fillFormPromise = fillNationalForm({
        ...job.formData,
        username: "9999839907", // Always use this username for National
        password: "Rayal$2025", // Always use this password for National
        _jobId: job._id, // Pass job ID for error logging
        _jobIdentifier: jobIdentifier,
        _attemptNumber: job.attempts + 1, // Current attempt number
        _jobQueueCollection: jobQueueCollection, // Pass collection for logging
      });
    } else {
      // Reliance form (default)
      fillFormPromise = fillRelianceForm({
        username: "rfcpolicy",
        password: "Pass@123",
        ...job.formData,
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
      // 🎉 SUCCESS - Mark as completed in database
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.COMPLETED,
            completedAt: new Date(),
            completedAttempt: job.attempts + 1,
            processingTimeMs: processingTimeMs
          },
          $push: {
            statusHistory: {
              from: JOB_STATUS.PROCESSING,
              to: JOB_STATUS.COMPLETED,
              timestamp: new Date()
            }
          }
        }
      );

      console.log(`\n${'═'.repeat(70)}`);
      console.log(`[Reliance Queue] ✅ SUCCESS for ${job.formData.firstName} (ID: ${job._id})`);
      console.log(`[Reliance Queue] ⏱️  Processing time: ${(processingTimeMs / 1000).toFixed(2)}s`);
      console.log(`${'═'.repeat(70)}\n`);

      // Log audit entry for success
      await logAuditEntry('JOB_COMPLETED', {
        jobId: job._id,
        customerName: `${job.formData.firstName} ${job.formData.lastName}`,
        company: companyName,
        processingTimeMs: processingTimeMs,
        attemptNumber: job.attempts + 1
      });

    } else {
      // ❌ FAILURE - Handle based on failure type
      const newAttemptCount = job.attempts + 1;

      // Classify the error
      const isPostSubmissionFailure =
        result?.postSubmissionFailed ||
        result?.stage === "post-submission" ||
        result?.stage === "post-calculation";

      // Use structured error codes
      const errorCode = isPostSubmissionFailure ? 'E401' : 'E300';
      const failureType = isPostSubmissionFailure
        ? "PostSubmissionError"
        : "LoginFormError";
      const severity = isPostSubmissionFailure ? 'critical' : 'warning';

      // Create enhanced error log with structured codes
      const errorLog = {
        timestamp: new Date(),
        attemptNumber: newAttemptCount,
        errorCode: errorCode,
        errorMessage: result?.error || "Unknown error",
        errorType: failureType,
        severity: severity,
        stage: result?.stage || (isPostSubmissionFailure ? "post-submission" : "login-form"),
        screenshotUrl: result?.screenshotUrl || null,
        screenshotKey: result?.screenshotKey || null,
        processingTimeMs: processingTimeMs,
        retryable: !isPostSubmissionFailure
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
            lastAttemptAt: new Date(),
            failureType: failureType,
            processingTimeMs: processingTimeMs
          },
        }
      );

      const updatedJob = await jobQueueCollection.findOne({ _id: job._id });

      // 🔴 Post-submission failures: Mark as failed immediately (CRITICAL - NO RETRY - money involved)
      if (isPostSubmissionFailure) {
        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.FAILED_POST_SUBMISSION,
              failedAt: new Date(),
              finalError: errorLog,
            },
          }
        );

        console.error(`\n${'🔴'.repeat(35)}`);
        console.error(`[Reliance Queue] ❌ CRITICAL FAILURE (POST-SUBMISSION) for ${job.formData.firstName}`);
        console.error(`[Reliance Queue] ⚠️  NO RETRY - Form already submitted, may have charges`);
        console.error(`[Reliance Queue] 📋 Error Code: ${errorCode}`);
        console.error(`[Reliance Queue] 📝 Error: ${errorLog.errorMessage}`);
        if (errorLog.screenshotUrl) {
          console.error(`[Reliance Queue] 📸 Screenshot: ${errorLog.screenshotUrl}`);
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
        console.error(`[Reliance Queue] ❌ FAILED PERMANENTLY (LOGIN FORM) for ${job.formData.firstName}`);
        console.error(`[Reliance Queue] 📋 Attempts exhausted: ${updatedJob.attempts}/${updatedJob.maxAttempts}`);
        console.error(`[Reliance Queue] 📋 Error Code: ${errorCode}`);
        console.error(`[Reliance Queue] 📝 Last error: ${errorLog.errorMessage}`);
        if (errorLog.screenshotUrl) {
          console.error(`[Reliance Queue] 📸 Screenshot: ${errorLog.screenshotUrl}`);
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

        console.warn(`\n${'🟡'.repeat(35)}`);
        console.warn(`[Reliance Queue] ⚠️ FAILED (LOGIN FORM) for ${job.formData.firstName}`);
        console.warn(`[Reliance Queue] 🔄 Will retry in ${retryDelay / 1000}s (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`);
        console.warn(`[Reliance Queue] 📋 Error Code: ${errorCode}`);
        if (errorLog.screenshotUrl) {
          console.warn(`[Reliance Queue] 📸 Screenshot: ${errorLog.screenshotUrl}`);
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

    console.error(
      `[Reliance Queue] ❌ EXCEPTION for ${job.formData.firstName}:`,
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
          lastError: e.message,
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

      console.error(`[Reliance Queue] ❌ Failed permanently [${classified.code}] after ${updatedJob.attempts} attempts`);

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

      console.warn(
        `[Reliance Queue] ⚠️ Will retry [${classified.code}] in ${retryDelay / 1000}s (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`
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

  // CRASH RECOVERY: Reset any jobs stuck in "processing" state back to "pending"
  // This happens when server crashes while processing jobs
  const stuckJobs = await jobQueueCollection.updateMany(
    { status: JOB_STATUS.PROCESSING },
    {
      $set: {
        status: JOB_STATUS.PENDING,
        recoveredAt: new Date(),
      },
    }
  );

  if (stuckJobs.modifiedCount > 0) {
    console.log(
      `[Job Queue] 🔄 Recovered ${stuckJobs.modifiedCount} jobs that were stuck in processing state`
    );
  }

  // Count pending jobs and start processing
  const pendingCount = await jobQueueCollection.countDocuments({
    status: JOB_STATUS.PENDING,
  });

  if (pendingCount > 0) {
    console.log(
      `[Job Queue] Found ${pendingCount} pending jobs, will start processing...`
    );
    void processRelianceQueue();
  }

  const collection = db.collection("onlinePolicy");

  const changeStream = collection.watch([
    {
      $match: {
        $or: [
          { operationType: "insert" },
          {
            operationType: "update",
            "updateDescription.updatedFields.aadharCard": { $exists: true }
          },
          {
            operationType: "update",
            "updateDescription.updatedFields.panCard": { $exists: true }
          }
        ],
      },
    },
  ]);

  changeStream.on("change", async (change) => {
    console.log(`📡 Change detected: ${change.operationType}`);

    let data = change?.fullDocument;
    const documentId = change.documentKey?._id;

    // If this is an update operation and we don't have fullDocument, fetch it
    if (!data && documentId) {
      console.log("📥 Fetching full document from database...");
      data = await collection.findOne({ _id: documentId });
    }

    console.log("data: ******* ******* ******* ******* ******* ******* ", data);

    // Skip if this is just a document update (not initial insert)
    // We only want to process when aadharCard and panCard are present
    if (change.operationType === "update") {
      const hasAadhar = data?.aadharCard?.key;
      const hasPan = data?.panCard?.key;

      if (!hasAadhar || !hasPan) {
        console.log("⏭️  Skipping update - waiting for both documents to be uploaded");
        return;
      }

      console.log("✅ Both documents uploaded, processing policy...");
    }

    // Get the Captcha document _id for reference
    const captchaId = data?._id;

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
      idv: data?.idv,
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
      tppdRestrict: data?.tppdRestrict,
      paCover: data?.paCover,
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
      // Company name mapping - check both 'company' and 'Companyname' fields, normalize to lowercase
      Companyname: data?.Companyname || (data?.company ? data.company.toLowerCase() : "reliance")
    };

    console.log(
      "formData: ******* ******* ******* ******* ******* ******* ",
      formData
    );
    console.log(
      `[MongoDB Watch] New customer data received: ${formData.firstName} (Captcha ID: ${captchaId})`
    );
    console.log(
      `[MongoDB Watch] Company mapping: data.company="${data?.company}", data.Companyname="${data?.Companyname}", formData.Companyname="${formData.Companyname}"`
    );

    // Add to queue with captchaId reference
    await enqueueRelianceJob(formData, captchaId);
  });
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

    // Find job by captchaId reference
    const job = await jobQueueCollection.findOne({
      captchaId: captchaObjectId,
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found for this captcha ID",
        captchaId: captchaId,
      });
    }

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
      errorLogs: job.errorLogs || [],
      lastError: job.lastError || null,
      lastErrorTimestamp: job.lastErrorTimestamp || null,
      finalError: job.finalError || null,

      // Special errors
      lastPostSubmissionError: job.lastPostSubmissionError || null,
      lastModalError: job.lastModalError || null,

      // Screenshots
      screenshotUrls: job.errorLogs
        ? job.errorLogs.map((e) => e.screenshotUrl).filter(Boolean)
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

    await initializeMasterSession();
    console.log("✅ Reliance master session initialized successfully\n");

    console.log("\n" + "=".repeat(60));
    console.log("  ✅ READY TO PROCESS JOBS");
    console.log("=".repeat(60));
    console.log(
      "📊 Reliance Session Status:",
      JSON.stringify(getSessionStatus(), null, 2)
    );
    console.log("📊 National: Uses fresh login for each job (no master session)");
    console.log("=".repeat(60) + "\n");
  } catch (e) {
    console.error("\n❌ Failed to initialize master session:", e.message);
    console.error("⚠️  Jobs may require manual login\n");
  }
});
