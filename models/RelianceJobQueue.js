const mongoose = require("mongoose");

// Sub-schema for error logs
const ErrorLogSchema = new mongoose.Schema(
  {
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
    },
    attemptNumber: {
      type: Number,
      required: true,
    },
    errorMessage: {
      type: String,
      required: true,
    },
    errorType: {
      type: String,
      default: "Error",
    },
    errorStack: {
      type: String,
      default: null,
    },
    screenshotUrl: {
      type: String,
      default: null,
    },
    screenshotKey: {
      type: String,
      default: null,
    },
    // Which part of a job with parts this entry belongs to ("od" | "tp" | "motor" | "pa").
    part: {
      type: String,
      default: undefined,
    },
  },
  { _id: false }
); // _id: false to not create _id for subdocuments

// Main Job Queue Schema
const RelianceJobQueueSchema = new mongoose.Schema(
  {
    // Reference to the original Captcha collection document
    captchaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Captcha",
      default: null,
      index: true,
    },

    // "od" | "tp" — set only by the new multiCompany fan-out
    // (RayalBrokers-backend's dao/onlinePolicyDao.js enqueueProductJobs).
    // null/absent on every job the legacy single-job path creates — this is
    // what keeps server.js's existing bundled companyName if/else dispatch
    // untouched for those jobs. One policy (one captchaId) can now own more
    // than one job — an OD job and a TP job — distinguished by this field;
    // see the compound index below.
    policyType: {
      type: String,
      default: null,
    },

    // Form data submitted by the user
    formData: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    // ── Company routing ────────────────────────────────────────────────────
    // Copy of the policy's `settings` (shared/policySettings.js) taken when the
    // job was queued: { isMultipleCompany, PACompany, ODCompany, TPCompany }.
    // Also mirrored in formData.settings, which is what the automation reads.
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Job status. The automation writes all of these through the raw driver
    // (no Mongoose validation), so the list is kept accurate for a future
    // .save(): it is the union of server.js JOB_STATUS and "hold", which is the
    // operator's parking state — the automation only claims "pending".
    status: {
      type: String,
      enum: [
        "pending",
        "hold",
        "processing",
        "completed",
        "completed_with_errors",
        "failed",
        "failed_login_form",
        "failed_post_submission",
        "failed_validation",
        "failed_duplicate",
      ],
      default: "pending",
      required: true,
      index: true,
    },

    // ── One job per policy, a separate status per part ─────────────────────
    // Created by the backend when POLICY_JOB_PARTS_ENABLED is on; absent on
    // every older job, which keeps running through the original code path.
    // Each part: { key: "motor"|"od"|"tp"|"pa", kind: "bundled"|"portal"|
    // "brisk"|"withPart", company, status, carriesPa, paCoverCompany, dependsOn,
    // mirrors, attempts, maxAttempts, nextRetryAt, lastError, lastErrorCode,
    // stage, startedAt, completedAt, failedAt, result, requeue, ... } — the
    // rules are in lib/jobPartsCore.js. The job's own `status` / `nextRetryAt`
    // are derived from them (summarizeParts), so readers that only know the
    // queue states keep working.
    // `default: undefined`: a Mongoose array would otherwise default to [] and
    // make an ordinary job look like a parts job.
    parts: {
      type: [mongoose.Schema.Types.Mixed],
      default: undefined,
    },
    // Optimistic-lock counter for a job with parts: every write that changes
    // parts (claim, outcome, edit, recovery) is conditional on it and bumps it.
    // The heartbeat deliberately does not.
    rev: {
      type: Number,
      default: undefined,
    },
    // The part being run right now: { key, company, kind, bucket, attempt,
    // startedAt }. Set when the part is claimed, unset when its outcome is saved.
    currentPart: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },

    // Timestamps
    createdAt: {
      type: Date,
      default: Date.now,
      required: true,
      index: true,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    failedAt: {
      type: Date,
      default: null,
    },
    lastAttemptAt: {
      type: Date,
      default: null,
    },
    nextRetryAt: {
      type: Date,
      default: null,
    },
    recoveredAt: {
      type: Date,
      default: null,
    },

    // Attempt tracking
    attempts: {
      type: Number,
      default: 0,
      required: true,
    },
    maxAttempts: {
      type: Number,
      default: 3,
      required: true,
    },
    completedAttempt: {
      type: Number,
      default: null,
    },

    // Error tracking
    lastError: {
      type: String,
      default: null,
    },
    lastErrorTimestamp: {
      type: Date,
      default: null,
      index: true,
    },
    errorLogs: {
      type: [ErrorLogSchema],
      default: [],
    },
    finalError: {
      type: ErrorLogSchema,
      default: null,
    },
    // Screen recordings of the automation runs (one per attempt), written by
    // lib/jobRecorder.js via the raw driver. s3Key is null for recordings
    // that fell back to local storage.
    // Entry: { attemptNumber, s3Key, localPath, storage: "s3"|"local",
    //          startedAt, endedAt, durationMs, sizeBytes, frameCount,
    //          captureMode }
    recordings: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
  },
  {
    timestamps: false, // We manage timestamps manually
    collection: "RelianceJobQueue",
  }
);

// Indexes for performance (matching your server.js indexes)
RelianceJobQueueSchema.index({ status: 1, createdAt: 1 });
RelianceJobQueueSchema.index({ createdAt: 1 });
RelianceJobQueueSchema.index({ captchaId: 1 });
// A policy can now own more than one job (OD + TP); this is the key that
// keeps them from colliding — see the policyType field comment above.
RelianceJobQueueSchema.index({ captchaId: 1, policyType: 1 });
// One job per policy for jobs with parts. Declared here for parity with the
// backend model; this server talks to the collection through the raw driver
// and never syncs Mongoose indexes, so it is the backend that builds it.
RelianceJobQueueSchema.index(
  { captchaId: 1 },
  {
    name: "captchaId_parts_unique",
    unique: true,
    partialFilterExpression: { "parts.0": { $exists: true } },
  }
);
RelianceJobQueueSchema.index({ "errorLogs.timestamp": 1 });

// Instance methods

/**
 * Mark job as processing
 */
RelianceJobQueueSchema.methods.markAsProcessing = function () {
  this.status = "processing";
  this.startedAt = new Date();
  return this.save();
};

/**
 * Mark job as completed
 */
RelianceJobQueueSchema.methods.markAsCompleted = function (attemptNumber) {
  this.status = "completed";
  this.completedAt = new Date();
  this.completedAttempt = attemptNumber || this.attempts + 1;
  return this.save();
};

/**
 * Mark job as failed
 */
RelianceJobQueueSchema.methods.markAsFailed = function (errorLog) {
  this.status = "failed";
  this.failedAt = new Date();
  this.finalError = errorLog;
  return this.save();
};

/**
 * Add error and increment attempts
 */
RelianceJobQueueSchema.methods.addError = function (errorLog) {
  this.attempts += 1;
  this.errorLogs.push(errorLog);
  this.lastError = errorLog.errorMessage;
  this.lastErrorTimestamp = errorLog.timestamp;
  this.lastAttemptAt = new Date();
  return this.save();
};

/**
 * Check if job has reached max attempts
 */
RelianceJobQueueSchema.methods.hasReachedMaxAttempts = function () {
  return this.attempts >= this.maxAttempts;
};

/**
 * Schedule retry
 */
RelianceJobQueueSchema.methods.scheduleRetry = function (delayMs = 60000) {
  this.status = "pending";
  this.nextRetryAt = new Date(Date.now() + delayMs);
  return this.save();
};

/**
 * Mark as recovered from crash
 */
RelianceJobQueueSchema.methods.markAsRecovered = function () {
  this.status = "pending";
  this.recoveredAt = new Date();
  return this.save();
};

// Static methods

/**
 * Get all pending jobs (oldest first)
 */
RelianceJobQueueSchema.statics.getPendingJobs = function (limit = 10) {
  return this.find({ status: "pending" }).sort({ createdAt: 1 }).limit(limit);
};

/**
 * Get job by captcha ID
 */
RelianceJobQueueSchema.statics.findByCaptchaId = function (captchaId) {
  return this.findOne({ captchaId });
};

/**
 * Count jobs by status
 */
RelianceJobQueueSchema.statics.countByStatus = function (status) {
  return this.countDocuments({ status });
};

/**
 * Recover stuck jobs (crash recovery)
 */
RelianceJobQueueSchema.statics.recoverStuckJobs = async function () {
  const result = await this.updateMany(
    { status: "processing" },
    {
      $set: {
        status: "pending",
        recoveredAt: new Date(),
      },
    }
  );
  return result.modifiedCount;
};

/**
 * Get failed jobs with details
 */
RelianceJobQueueSchema.statics.getFailedJobs = function (limit = 50) {
  return this.find({ status: "failed" }).sort({ failedAt: -1 }).limit(limit);
};

/**
 * Get jobs that need retry
 */
RelianceJobQueueSchema.statics.getJobsReadyForRetry = function () {
  return this.find({
    status: "pending",
    nextRetryAt: { $lte: new Date() },
  }).sort({ nextRetryAt: 1 });
};

/**
 * Clean up old completed jobs
 */
RelianceJobQueueSchema.statics.cleanupOldJobs = function (daysOld = 30) {
  const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  return this.deleteMany({
    status: "completed",
    completedAt: { $lt: cutoffDate },
  });
};

// Virtual properties

/**
 * Get success rate for this job
 */
RelianceJobQueueSchema.virtual("successRate").get(function () {
  if (this.attempts === 0) return 0;
  return this.status === "completed" ? 100 : 0;
});

/**
 * Get time spent processing
 */
RelianceJobQueueSchema.virtual("processingTime").get(function () {
  if (!this.startedAt) return null;
  const endTime = this.completedAt || this.failedAt || new Date();
  return endTime - this.startedAt;
});

/**
 * Check if job is ready for retry
 */
RelianceJobQueueSchema.virtual("isReadyForRetry").get(function () {
  return (
    this.status === "pending" &&
    this.nextRetryAt &&
    this.nextRetryAt <= new Date()
  );
});

// Export the model
const RelianceJobQueue = mongoose.model(
  "RelianceJobQueue",
  RelianceJobQueueSchema
);

module.exports = RelianceJobQueue;
