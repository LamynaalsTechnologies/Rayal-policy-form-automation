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

    // Form data submitted by the user
    formData: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },

    // Job status
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      required: true,
      index: true,
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
