# Mongoose Models

This directory contains Mongoose schema models for the Rayal Policy Form Automation system.

## RelianceJobQueue Model

A comprehensive Mongoose model for managing the Reliance insurance form processing job queue.

### Features

- ✅ Complete schema with all fields from your current implementation
- ✅ Sub-schema for error logging
- ✅ Pre-configured indexes for optimal performance
- ✅ Instance methods for common operations
- ✅ Static methods for querying
- ✅ Virtual properties for computed values

### Installation

```javascript
// Import the model
const RelianceJobQueue = require("./models/RelianceJobQueue");
// OR
const { RelianceJobQueue } = require("./models");
```

### Usage Examples

#### 1. Create a New Job

```javascript
const job = new RelianceJobQueue({
  captchaId: captchaObjectId,
  formData: {
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    // ... other form fields
  },
  status: "pending",
  maxAttempts: 3,
});

await job.save();
```

#### 2. Mark Job as Processing

```javascript
const job = await RelianceJobQueue.findById(jobId);
await job.markAsProcessing();
```

#### 3. Mark Job as Completed

```javascript
await job.markAsCompleted(attemptNumber);
```

#### 4. Add Error and Retry Logic

```javascript
const errorLog = {
  timestamp: new Date(),
  attemptNumber: job.attempts + 1,
  errorMessage: "Connection timeout",
  errorType: "NetworkError",
  screenshotUrl: "https://s3.../screenshot.png",
  screenshotKey: "errors/123/screenshot.png",
};

await job.addError(errorLog);

if (job.hasReachedMaxAttempts()) {
  await job.markAsFailed(errorLog);
} else {
  await job.scheduleRetry(60000); // Retry after 60 seconds
}
```

#### 5. Get Pending Jobs

```javascript
const pendingJobs = await RelianceJobQueue.getPendingJobs(10);
```

#### 6. Find Job by Captcha ID

```javascript
const job = await RelianceJobQueue.findByCaptchaId(captchaId);
```

#### 7. Count Jobs by Status

```javascript
const processingCount = await RelianceJobQueue.countByStatus("processing");
const pendingCount = await RelianceJobQueue.countByStatus("pending");
```

#### 8. Crash Recovery

```javascript
// On server startup
const recoveredCount = await RelianceJobQueue.recoverStuckJobs();
console.log(`Recovered ${recoveredCount} stuck jobs`);
```

#### 9. Get Failed Jobs

```javascript
const failedJobs = await RelianceJobQueue.getFailedJobs(50);
```

#### 10. Cleanup Old Completed Jobs

```javascript
// Delete jobs completed more than 30 days ago
const deleteResult = await RelianceJobQueue.cleanupOldJobs(30);
console.log(`Deleted ${deleteResult.deletedCount} old jobs`);
```

### Schema Structure

#### Main Fields

| Field         | Type     | Description                                      |
| ------------- | -------- | ------------------------------------------------ |
| `captchaId`   | ObjectId | Reference to Captcha collection                  |
| `formData`    | Mixed    | Form data submitted by user                      |
| `status`      | String   | Job status (pending/processing/completed/failed) |
| `createdAt`   | Date     | Job creation timestamp                           |
| `startedAt`   | Date     | When processing started                          |
| `completedAt` | Date     | When job completed                               |
| `failedAt`    | Date     | When job failed                                  |
| `attempts`    | Number   | Number of attempts made                          |
| `maxAttempts` | Number   | Maximum retry attempts (default: 3)              |
| `errorLogs`   | Array    | Array of error log objects                       |
| `lastError`   | String   | Last error message                               |
| `nextRetryAt` | Date     | Scheduled retry time                             |

#### ErrorLog Sub-Schema

| Field           | Type   | Description                  |
| --------------- | ------ | ---------------------------- |
| `timestamp`     | Date   | When error occurred          |
| `attemptNumber` | Number | Which attempt failed         |
| `errorMessage`  | String | Error message                |
| `errorType`     | String | Type of error                |
| `errorStack`    | String | Stack trace (optional)       |
| `screenshotUrl` | String | S3 screenshot URL (optional) |
| `screenshotKey` | String | S3 screenshot key (optional) |

### Instance Methods

- `markAsProcessing()` - Mark job as currently processing
- `markAsCompleted(attemptNumber)` - Mark job as completed
- `markAsFailed(errorLog)` - Mark job as permanently failed
- `addError(errorLog)` - Add error and increment attempts
- `hasReachedMaxAttempts()` - Check if max attempts reached
- `scheduleRetry(delayMs)` - Schedule job for retry
- `markAsRecovered()` - Mark as recovered from crash

### Static Methods

- `getPendingJobs(limit)` - Get pending jobs (oldest first)
- `findByCaptchaId(captchaId)` - Find job by captcha ID
- `countByStatus(status)` - Count jobs with given status
- `recoverStuckJobs()` - Recover jobs stuck in processing
- `getFailedJobs(limit)` - Get failed jobs with details
- `getJobsReadyForRetry()` - Get jobs ready for retry
- `cleanupOldJobs(daysOld)` - Delete old completed jobs

### Virtual Properties

- `successRate` - Success rate percentage
- `processingTime` - Time spent processing (ms)
- `isReadyForRetry` - Boolean indicating if ready for retry

### Indexes

The model includes the following indexes for optimal performance:

```javascript
{ status: 1, createdAt: 1 }
{ createdAt: 1 }
{ captchaId: 1 }
{ "errorLogs.timestamp": 1 }
```

### Migration from Current Code

To migrate from your current MongoDB native driver implementation:

**Before (server.js):**

```javascript
// Using native MongoDB driver
const jobQueueCollection = db.collection("RelianceJobQueue");
await jobQueueCollection.insertOne(job);
await jobQueueCollection.updateOne(
  { _id: job._id },
  { $set: { status: "completed" } }
);
```

**After (with Mongoose model):**

```javascript
// Using Mongoose model
const RelianceJobQueue = require("./models/RelianceJobQueue");
const job = new RelianceJobQueue(jobData);
await job.save();
await job.markAsCompleted();
```

### Benefits of Using This Model

1. **Type Safety** - Schema validation ensures data integrity
2. **Cleaner Code** - Instance methods replace complex update queries
3. **Better Maintainability** - Centralized schema definition
4. **Built-in Validation** - Mongoose validates data automatically
5. **Query Helpers** - Static methods for common queries
6. **Virtual Properties** - Computed fields without storage
7. **Middleware Support** - Can add pre/post hooks if needed
8. **Auto-indexing** - Indexes are created automatically

## Adding More Models

To add more models to this directory:

1. Create a new file (e.g., `Captcha.js`)
2. Define your schema and model
3. Export it in `index.js`
4. Document it in this README

Example structure:

```javascript
// models/Captcha.js
const mongoose = require("mongoose");

const CaptchaSchema = new mongoose.Schema({
  // your fields here
});

module.exports = mongoose.model("Captcha", CaptchaSchema);
```

```javascript
// models/index.js
const RelianceJobQueue = require("./RelianceJobQueue");
const Captcha = require("./Captcha");

module.exports = {
  RelianceJobQueue,
  Captcha,
};
```
