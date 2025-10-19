/**
 * MIGRATION EXAMPLE
 *
 * This file shows how to migrate from MongoDB native driver
 * to Mongoose model in your server.js
 */

// ============================================
// BEFORE: Using MongoDB Native Driver
// ============================================

// OLD CODE in server.js:
const enqueueRelianceJob_OLD = async (formData, captchaId = null) => {
  try {
    const job = {
      captchaId: captchaId,
      formData,
      status: JOB_STATUS.PENDING,
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      errorLogs: [],
    };

    const result = await jobQueueCollection.insertOne(job);
    console.log(`[Reliance Queue] Enqueued job for ${formData.firstName}`);
    return result.insertedId;
  } catch (error) {
    console.error("[Reliance Queue] Failed to enqueue job:", error.message);
    throw error;
  }
};

// ============================================
// AFTER: Using Mongoose Model
// ============================================

const RelianceJobQueue = require("./models/RelianceJobQueue");

const enqueueRelianceJob_NEW = async (formData, captchaId = null) => {
  try {
    const job = new RelianceJobQueue({
      captchaId,
      formData,
      status: "pending",
      maxAttempts: 3,
    });

    await job.save();
    console.log(
      `[Reliance Queue] Enqueued job for ${formData.firstName} (Job ID: ${job._id})`
    );
    return job._id;
  } catch (error) {
    console.error("[Reliance Queue] Failed to enqueue job:", error.message);
    throw error;
  }
};

// ============================================
// BEFORE: Process Queue (Native Driver)
// ============================================

const processRelianceQueue_OLD = async () => {
  // Count processing jobs
  const processingCount = await jobQueueCollection.countDocuments({
    status: JOB_STATUS.PROCESSING,
  });

  // Get pending jobs
  const pendingJobs = await jobQueueCollection
    .find({ status: JOB_STATUS.PENDING })
    .sort({ createdAt: 1 })
    .limit(availableSlots)
    .toArray();

  // Mark as processing
  await jobQueueCollection.updateOne(
    { _id: job._id },
    {
      $set: {
        status: JOB_STATUS.PROCESSING,
        startedAt: new Date(),
      },
    }
  );
};

// ============================================
// AFTER: Process Queue (Mongoose)
// ============================================

const processRelianceQueue_NEW = async () => {
  // Count processing jobs
  const processingCount = await RelianceJobQueue.countByStatus("processing");

  // Get pending jobs
  const pendingJobs = await RelianceJobQueue.getPendingJobs(availableSlots);

  // Mark as processing
  await job.markAsProcessing();
};

// ============================================
// BEFORE: Handle Success (Native Driver)
// ============================================

const handleSuccess_OLD = async (job) => {
  await jobQueueCollection.updateOne(
    { _id: job._id },
    {
      $set: {
        status: JOB_STATUS.COMPLETED,
        completedAt: new Date(),
        completedAttempt: job.attempts + 1,
      },
    }
  );
};

// ============================================
// AFTER: Handle Success (Mongoose)
// ============================================

const handleSuccess_NEW = async (job) => {
  await job.markAsCompleted(job.attempts + 1);
};

// ============================================
// BEFORE: Handle Error (Native Driver)
// ============================================

const handleError_OLD = async (job, result) => {
  const errorLog = {
    timestamp: new Date(),
    attemptNumber: job.attempts + 1,
    errorMessage: result?.error || "Unknown error",
    errorType: "FormFillError",
    screenshotUrl: result?.screenshotUrl || null,
    screenshotKey: result?.screenshotKey || null,
  };

  await jobQueueCollection.updateOne(
    { _id: job._id },
    {
      $inc: { attempts: 1 },
      $push: { errorLogs: errorLog },
      $set: {
        lastError: errorLog.errorMessage,
        lastErrorTimestamp: errorLog.timestamp,
        lastAttemptAt: new Date(),
      },
    }
  );

  const updatedJob = await jobQueueCollection.findOne({ _id: job._id });

  if (updatedJob.attempts >= updatedJob.maxAttempts) {
    await jobQueueCollection.updateOne(
      { _id: job._id },
      {
        $set: {
          status: JOB_STATUS.FAILED,
          failedAt: new Date(),
          finalError: errorLog,
        },
      }
    );
  } else {
    await jobQueueCollection.updateOne(
      { _id: job._id },
      {
        $set: {
          status: JOB_STATUS.PENDING,
          nextRetryAt: new Date(Date.now() + 60000),
        },
      }
    );
  }
};

// ============================================
// AFTER: Handle Error (Mongoose)
// ============================================

const handleError_NEW = async (job, result) => {
  const errorLog = {
    timestamp: new Date(),
    attemptNumber: job.attempts + 1,
    errorMessage: result?.error || "Unknown error",
    errorType: "FormFillError",
    screenshotUrl: result?.screenshotUrl || null,
    screenshotKey: result?.screenshotKey || null,
  };

  await job.addError(errorLog);

  if (job.hasReachedMaxAttempts()) {
    await job.markAsFailed(errorLog);
    console.error(
      `[Reliance Queue] ❌ Failed permanently after ${job.attempts} attempts`
    );
  } else {
    await job.scheduleRetry(60000);
    console.warn(
      `[Reliance Queue] ⚠️ Will retry (attempt ${job.attempts}/${job.maxAttempts})`
    );
  }
};

// ============================================
// BEFORE: Crash Recovery (Native Driver)
// ============================================

const crashRecovery_OLD = async () => {
  const stuckJobs = await jobQueueCollection.updateMany(
    { status: JOB_STATUS.PROCESSING },
    {
      $set: {
        status: JOB_STATUS.PENDING,
        recoveredAt: new Date(),
      },
    }
  );

  console.log(`[Job Queue] 🔄 Recovered ${stuckJobs.modifiedCount} jobs`);
};

// ============================================
// AFTER: Crash Recovery (Mongoose)
// ============================================

const crashRecovery_NEW = async () => {
  const recoveredCount = await RelianceJobQueue.recoverStuckJobs();
  console.log(`[Job Queue] 🔄 Recovered ${recoveredCount} jobs`);
};

// ============================================
// COMPLETE MIGRATION EXAMPLE
// ============================================

/**
 * Full example of migrating your runRelianceJob function
 */

// BEFORE
const runRelianceJob_OLD = async (job) => {
  try {
    const result = await fillRelianceForm({ ...job.formData });

    if (result && result.success) {
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.COMPLETED,
            completedAt: new Date(),
            completedAttempt: job.attempts + 1,
          },
        }
      );
      console.log(`[Reliance Queue] ✅ Success`);
    } else {
      // Handle error with complex update logic...
    }
  } catch (e) {
    // Handle exception with complex update logic...
  }
};

// AFTER (much cleaner!)
const runRelianceJob_NEW = async (job) => {
  try {
    const result = await fillRelianceForm({ ...job.formData });

    if (result && result.success) {
      await job.markAsCompleted(job.attempts + 1);
      console.log(`[Reliance Queue] ✅ Success`);
    } else {
      const errorLog = {
        timestamp: new Date(),
        attemptNumber: job.attempts + 1,
        errorMessage: result?.error || "Unknown error",
        errorType: "FormFillError",
        screenshotUrl: result?.screenshotUrl,
        screenshotKey: result?.screenshotKey,
      };

      await job.addError(errorLog);

      if (job.hasReachedMaxAttempts()) {
        await job.markAsFailed(errorLog);
      } else {
        await job.scheduleRetry(60000);
      }
    }
  } catch (e) {
    const errorLog = {
      timestamp: new Date(),
      attemptNumber: job.attempts + 1,
      errorMessage: e.message,
      errorStack: e.stack,
      errorType: e.name || "Error",
    };

    await job.addError(errorLog);

    if (job.hasReachedMaxAttempts()) {
      await job.markAsFailed(errorLog);
    } else {
      await job.scheduleRetry(60000);
    }
  }
};

/**
 * BENEFITS:
 *
 * 1. ✅ Much cleaner and more readable code
 * 2. ✅ No complex $inc, $push, $set operations
 * 3. ✅ Type safety with Mongoose validation
 * 4. ✅ Reusable methods across your codebase
 * 5. ✅ Easier to test and maintain
 * 6. ✅ Better error handling
 * 7. ✅ Self-documenting code
 */

module.exports = {
  // Export new functions for reference
  enqueueRelianceJob_NEW,
  processRelianceQueue_NEW,
  handleSuccess_NEW,
  handleError_NEW,
  crashRecovery_NEW,
  runRelianceJob_NEW,
};
