# S3 Error Logging System 📸

## Overview

Your system now automatically captures, uploads, and stores detailed error logs with screenshots in S3 and MongoDB.

---

## What It Does ✨

### **1. Captures Error Screenshots**

When an error occurs, the system:

- Takes screenshot of current browser state
- Captures page source (HTML)
- Records error details
- Uploads everything to S3
- Stores S3 URLs in MongoDB

### **2. Detailed Error Tracking**

Each error log includes:

- ✅ **Timestamp** - When error occurred
- ✅ **Attempt Number** - Which retry attempt (1/3, 2/3, etc.)
- ✅ **Screenshot S3 URL** - Link to error screenshot
- ✅ **Screenshot S3 Key** - S3 object path
- ✅ **Error Message** - What went wrong
- ✅ **Error Stack** - Full stack trace
- ✅ **Error Type** - Category (FormError, ModalError, PostSubmissionError)
- ✅ **Stage** - Where in process (modal-filling, post-submission, etc.)
- ✅ **Page Source URL** - Link to HTML snapshot (for debugging)

---

## Architecture 🏗️

```
Job Fails
    ↓
Capture Screenshot
    ↓
Upload to S3 →  screenshots/
                  ├── form-error/
                  │   └── John_abc123/
                  │       ├── attempt_1/
                  │       │   └── 2024-01-15-10-30-45.png
                  │       └── attempt_2/
                  │           └── 2024-01-15-10-35-20.png
                  ├── post-submission-error/
                  └── modal-error/
    ↓
Get S3 URL: https://s3.amazonaws.com/bucket/screenshots/...
    ↓
Save to MongoDB →  RelianceJobQueue
                    {
                      _id: ObjectId(...),
                      formData: {...},
                      attempts: 2,
                      errorLogs: [
                        {
                          timestamp: "2024-01-15T10:30:45Z",
                          attemptNumber: 1,
                          errorMessage: "Element not found",
                          screenshotUrl: "https://s3.../attempt_1.png",
                          errorType: "FormFillError"
                        },
                        {
                          timestamp: "2024-01-15T10:35:20Z",
                          attemptNumber: 2,
                          errorMessage: "Timeout",
                          screenshotUrl: "https://s3.../attempt_2.png",
                          errorType: "FormFillError"
                        }
                      ]
                    }
```

---

## Setup 🔧

### **Step 1: Install AWS SDK**

```bash
npm install aws-sdk
```

### **Step 2: Configure Environment Variables**

Create/update `.env` file:

```bash
# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your-access-key-here
AWS_SECRET_ACCESS_KEY=your-secret-key-here
AWS_REGION=us-east-1
S3_BUCKET_NAME=reliance-form-screenshots
```

### **Step 3: Create S3 Bucket**

```bash
# Using AWS CLI
aws s3 mb s3://reliance-form-screenshots --region us-east-1

# Or create via AWS Console:
# 1. Go to S3 in AWS Console
# 2. Click "Create Bucket"
# 3. Name: reliance-form-screenshots
# 4. Region: us-east-1
# 5. Keep default settings
# 6. Create bucket
```

### **Step 4: Set Bucket Permissions** (Optional)

If you want public URLs:

```javascript
// In s3Uploader.js line 27, change:
ACL: 'public-read',  // Instead of 'private'
```

For presigned URLs (recommended):

```javascript
// Keep as 'private' and use getPresignedUrl()
```

---

## Files Created 📁

### **1. `s3Uploader.js`**

Handles all S3 upload operations:

- `uploadToS3()` - Upload any file
- `uploadScreenshotToS3()` - Upload base64 screenshot
- `generateScreenshotKey()` - Generate S3 path
- `getPresignedUrl()` - Get temporary access URL

### **2. `errorLogger.js`**

Manages detailed error logging:

- `createErrorLog()` - Create error log entry
- `logErrorToJobQueue()` - Save to MongoDB
- `captureAndLogError()` - All-in-one: screenshot + upload + log

### **3. `S3_ERROR_LOGGING_GUIDE.md`**

This documentation file

---

## MongoDB Schema 📊

### **Job Document Structure:**

```javascript
{
  _id: ObjectId("507f1f77bcf86cd799439011"),
  formData: {
    firstName: "John",
    lastName: "Doe",
    // ... other form fields
  },
  status: "failed", // or "pending", "processing", "completed"

  attempts: 3,
  maxAttempts: 3,

  // Error tracking
  errorLogs: [
    {
      timestamp: ISODate("2024-01-15T10:30:45.123Z"),
      attemptNumber: 1,
      errorMessage: "Element not found: #btnSubmit",
      errorType: "FormFillError",
      errorStack: "Error: Element not found...\n  at...",
      screenshotUrl: "https://s3.amazonaws.com/.../attempt_1.png",
      screenshotKey: "screenshots/form-error/John_abc/attempt_1/2024-01-15.png",
      pageSourceUrl: "https://s3.amazonaws.com/.../attempt_1.html",
      stage: "form-filling"
    },
    {
      timestamp: ISODate("2024-01-15T10:35:20.456Z"),
      attemptNumber: 2,
      errorMessage: "Timeout waiting for element",
      errorType: "PostSubmissionError",
      errorStack: "Error: Timeout...",
      screenshotUrl: "https://s3.amazonaws.com/.../attempt_2.png",
      screenshotKey: "screenshots/post-submission-error/John_abc/attempt_2/2024-01-15.png",
      stage: "post-submission"
    },
    {
      timestamp: ISODate("2024-01-15T10:40:15.789Z"),
      attemptNumber: 3,
      errorMessage: "Modal not found",
      errorType: "ModalError",
      screenshotUrl: "https://s3.amazonaws.com/.../attempt_3.png",
      screenshotKey: "screenshots/modal-error/John_abc/attempt_3/2024-01-15.png",
      pageSourceUrl: "https://s3.amazonaws.com/.../attempt_3.html",
      stage: "modal-filling"
    }
  ],

  // Latest error info (for quick access)
  lastError: "Modal not found",
  lastErrorTimestamp: ISODate("2024-01-15T10:40:15.789Z"),
  lastAttemptAt: ISODate("2024-01-15T10:40:15.789Z"),

  // Final error (when all attempts exhausted)
  finalError: {
    timestamp: ISODate("2024-01-15T10:40:15.789Z"),
    attemptNumber: 3,
    errorMessage: "Modal not found",
    screenshotUrl: "https://s3.amazonaws.com/.../attempt_3.png",
    // ... other details
  },

  // Special error types
  lastPostSubmissionError: { /* ... */ },  // Last post-submission error
  lastModalError: { /* ... */ },           // Last modal error

  // Timestamps
  createdAt: ISODate("2024-01-15T10:30:00.000Z"),
  startedAt: ISODate("2024-01-15T10:30:05.000Z"),
  failedAt: ISODate("2024-01-15T10:40:15.789Z"),
  completedAttempt: null,
  nextRetryAt: ISODate("2024-01-15T10:41:15.789Z"),
}
```

---

## S3 Folder Structure 🗂️

```
s3://reliance-form-screenshots/
│
└── screenshots/
    ├── form-error/
    │   ├── John_507f1f77bcf86cd799439011/
    │   │   ├── attempt_1/
    │   │   │   ├── 2024-01-15T10-30-45-123Z.png
    │   │   │   └── 2024-01-15T10-30-45-123Z.html
    │   │   ├── attempt_2/
    │   │   │   └── 2024-01-15T10-35-20-456Z.png
    │   │   └── attempt_3/
    │   │       └── 2024-01-15T10-40-15-789Z.png
    │   │
    │   └── Jane_507f191e810c19729de860ea/
    │       └── attempt_1/
    │           └── 2024-01-15T10-32-10-234Z.png
    │
    ├── post-submission-error/
    │   └── Bob_507f1f77bcf86cd799439012/
    │       └── attempt_1/
    │           └── 2024-01-15T11-15-30-567Z.png
    │
    └── modal-error/
        └── Alice_507f191e810c19729de860eb/
            ├── attempt_1/
            │   ├── 2024-01-15T12-20-00-890Z.png
            │   └── 2024-01-15T12-20-00-890Z.html
            └── attempt_2/
                └── 2024-01-15T12-25-00-123Z.png
```

**Organization:**

- By error type (form-error, post-submission-error, modal-error)
- By job identifier (FirstName_JobID)
- By attempt number (attempt_1, attempt_2, attempt_3)
- By timestamp (ISO format)

---

## Error Types 🏷️

### **1. FormFillError**

- **When:** General form filling fails
- **Location:** Main catch block
- **Files:** Screenshot only
- **Example:** Element not found, timeout, etc.

### **2. PostSubmissionError**

- **When:** Error after form submission (vehicle details, etc.)
- **Location:** Post-submission section
- **Files:** Screenshot only
- **Example:** Dropdown not found, validation failed

### **3. ModalError**

- **When:** Error filling modal/iframe fields
- **Location:** Modal filling section
- **Files:** Screenshot + Page source (HTML)
- **Example:** Iframe not found, field not accessible

---

## How to Use 🎯

### **No Setup Required!**

Just start your server:

```bash
node server.js
```

**System automatically:**

1. Detects errors
2. Takes screenshots
3. Uploads to S3
4. Stores URLs in MongoDB
5. Continues processing

---

## Querying Error Logs 🔍

### **MongoDB Queries:**

**Get all failed jobs with screenshots:**

```javascript
db.RelianceJobQueue.find({
  status: "failed",
  "errorLogs.screenshotUrl": { $exists: true },
});
```

**Get jobs that failed on specific attempt:**

```javascript
db.RelianceJobQueue.find({
  "errorLogs.attemptNumber": 2, // Failed on 2nd attempt
});
```

**Get all post-submission errors:**

```javascript
db.RelianceJobQueue.find({
  "errorLogs.errorType": "PostSubmissionError",
});
```

**Get jobs with modal errors:**

```javascript
db.RelianceJobQueue.find({
  lastModalError: { $exists: true },
});
```

**Get error logs with page source:**

```javascript
db.RelianceJobQueue.find({
  "errorLogs.pageSourceUrl": { $exists: true },
});
```

**Get recent failures (last hour):**

```javascript
db.RelianceJobQueue.find({
  status: "failed",
  failedAt: { $gte: new Date(Date.now() - 3600000) },
});
```

**Get specific job's error history:**

```javascript
db.RelianceJobQueue.findOne(
  { _id: ObjectId("507f1f77bcf86cd799439011") },
  { errorLogs: 1, finalError: 1 }
);
```

---

## Console Output 📝

### **When Error Occurs:**

```
[Reliance Queue] Processing form for: John Doe
🚀 [Job John_507f1f77bcf86cd799439011] Starting job...
... form filling ...

❌ Error filling modal fields: Element not found

📸 Modal error screenshot uploaded to S3: https://s3.amazonaws.com/reliance-form-screenshots/screenshots/modal-error/John_507f1f77bcf86cd799439011/attempt_1/2024-01-15T10-30-45-123Z.png

📄 Page source uploaded to S3: https://s3.amazonaws.com/reliance-form-screenshots/screenshots/modal-error/John_507f1f77bcf86cd799439011/attempt_1/2024-01-15T10-30-45-123Z.html

✅ Modal error logged to job queue

📸 Error screenshot uploaded to S3: https://s3.amazonaws.com/.../form-error/...png

[Reliance Queue] ⚠️ Failed for John, will retry (attempt 1/3)
   Screenshot: https://s3.amazonaws.com/.../attempt_1.png
```

---

## Viewing Screenshots 🖼️

### **Option 1: Use S3 URLs Directly (if public)**

```bash
# If ACL is set to 'public-read'
# Just open the URL in browser:
https://s3.amazonaws.com/bucket-name/screenshots/...png
```

### **Option 2: Generate Presigned URL (if private)**

```javascript
const { getPresignedUrl } = require("./s3Uploader");

// Get URL that expires in 7 days
const url = await getPresignedUrl(screenshotKey);
console.log("Temporary URL:", url);
// Open this URL in browser to view screenshot
```

### **Option 3: Download from S3**

```bash
# Using AWS CLI
aws s3 cp s3://reliance-form-screenshots/screenshots/form-error/John_abc/attempt_1/2024-01-15.png ./local-screenshot.png

# Or via code
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const params = {
  Bucket: 'reliance-form-screenshots',
  Key: 'screenshots/form-error/...'
};
const data = await s3.getObject(params).promise();
fs.writeFileSync('screenshot.png', data.Body);
```

---

## Cost Estimate 💰

### **AWS S3 Pricing (us-east-1):**

**Storage:**

- $0.023 per GB/month
- Average screenshot: ~200KB
- 1000 screenshots ≈ 200MB ≈ $0.005/month

**Uploads:**

- $0.005 per 1000 PUT requests
- 1000 errors = 1000 uploads ≈ $0.005

**Downloads:**

- $0.09 per GB
- Viewing 1000 screenshots ≈ 200MB ≈ $0.018

**Total for 1000 errors/month:**

- Storage: $0.005
- Uploads: $0.005
- Downloads: $0.018
- **Total: ~$0.03/month** (very cheap!)

---

## Error Log Examples 📋

### **Example 1: Form Fill Error**

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "attemptNumber": 1,
  "errorMessage": "Timeout waiting for element: #btnSubmit",
  "errorType": "FormFillError",
  "errorStack": "Error: Timeout...\n  at fillRelianceForm...",
  "screenshotUrl": "https://s3.amazonaws.com/reliance-form-screenshots/screenshots/form-error/John_507f1f77bcf86cd799439011/attempt_1/2024-01-15T10-30-45-123Z.png",
  "screenshotKey": "screenshots/form-error/John_507f1f77bcf86cd799439011/attempt_1/2024-01-15T10-30-45-123Z.png"
}
```

### **Example 2: Post-Submission Error (with screenshot)**

```json
{
  "timestamp": "2024-01-15T11:15:30.567Z",
  "attemptNumber": 2,
  "errorMessage": "Vehicle dropdown not found",
  "errorType": "PostSubmissionError",
  "errorStack": "Error: Vehicle dropdown...",
  "screenshotUrl": "https://s3.amazonaws.com/.../post-submission-error/.../attempt_2/...png",
  "screenshotKey": "screenshots/post-submission-error/.../attempt_2/...png",
  "stage": "post-submission"
}
```

### **Example 3: Modal Error (with page source)**

```json
{
  "timestamp": "2024-01-15T12:20:00.890Z",
  "attemptNumber": 1,
  "errorMessage": "Iframe element not accessible",
  "errorType": "ModalError",
  "errorStack": "Error: Iframe element...",
  "screenshotUrl": "https://s3.amazonaws.com/.../modal-error/.../attempt_1/...png",
  "screenshotKey": "screenshots/modal-error/.../attempt_1/...png",
  "pageSourceUrl": "https://s3.amazonaws.com/.../modal-error/.../attempt_1/...html",
  "pageSourceKey": "screenshots/modal-error/.../attempt_1/...html",
  "stage": "modal-filling"
}
```

---

## Viewing Error Logs 👀

### **MongoDB Compass / Atlas UI:**

1. Open RelianceJobQueue collection
2. Find failed job
3. Expand `errorLogs` array
4. Click screenshot URL
5. View screenshot in browser

### **Programmatically:**

```javascript
const mongoose = require("mongoose");

// Connect to MongoDB
await mongoose.connect(process.env.MONGODB_URI);

// Get failed jobs
const failedJobs = await db
  .collection("RelianceJobQueue")
  .find({
    status: "failed",
  })
  .toArray();

// Print error details
failedJobs.forEach((job) => {
  console.log(`\nJob: ${job.formData.firstName} ${job.formData.lastName}`);
  console.log(`Failed at: ${job.failedAt}`);
  console.log(`Total attempts: ${job.attempts}`);
  console.log(`\nError History:`);

  job.errorLogs.forEach((error, index) => {
    console.log(`\n  Attempt ${error.attemptNumber}:`);
    console.log(`    Time: ${error.timestamp}`);
    console.log(`    Error: ${error.errorMessage}`);
    console.log(`    Type: ${error.errorType}`);
    console.log(`    Screenshot: ${error.screenshotUrl}`);
    if (error.pageSourceUrl) {
      console.log(`    Page Source: ${error.pageSourceUrl}`);
    }
  });
});
```

---

## Benefits 🎁

| Feature                  | Before         | After                     |
| ------------------------ | -------------- | ------------------------- |
| **Screenshot Storage**   | Local disk     | ✅ S3 (cloud)             |
| **Screenshot Retention** | Manual cleanup | ✅ Permanent              |
| **Error Details**        | Basic message  | ✅ Full log               |
| **Attempt Tracking**     | None           | ✅ Per-attempt logs       |
| **Page Source**          | Lost           | ✅ Saved to S3            |
| **Accessibility**        | Local only     | ✅ Anywhere via URL       |
| **History**              | Overwritten    | ✅ Complete history       |
| **Debugging**            | Difficult      | ✅ Easy (view screenshot) |

---

## Troubleshooting 🔧

### **Problem: S3 upload fails**

**Error:**

```
❌ S3 upload failed: Missing credentials in config
```

**Solution:**

```bash
# Check .env file has AWS credentials
cat .env | grep AWS

# Should show:
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
S3_BUCKET_NAME=reliance-form-screenshots
```

---

### **Problem: Bucket doesn't exist**

**Error:**

```
❌ S3 upload failed: The specified bucket does not exist
```

**Solution:**

```bash
# Create bucket
aws s3 mb s3://reliance-form-screenshots --region us-east-1

# Or update bucket name in .env
S3_BUCKET_NAME=your-existing-bucket-name
```

---

### **Problem: Access denied**

**Error:**

```
❌ S3 upload failed: Access Denied
```

**Solution:**

1. Check AWS credentials are correct
2. Ensure IAM user has S3 permissions:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
         "Resource": "arn:aws:s3:::reliance-form-screenshots/*"
       }
     ]
   }
   ```

---

### **Problem: Screenshots not in MongoDB**

**Check:**

```javascript
db.RelianceJobQueue.findOne({}, { errorLogs: 1 });
// Should show errorLogs array
```

**Causes:**

- Error occurred before MongoDB update
- MongoDB connection issue
- Missing \_jobId or \_jobQueueCollection in data

**Solution:**

- Check console logs for MongoDB errors
- Verify job queue collection is initialized
- Restart server

---

## Configuration Options ⚙️

### **Change S3 Bucket:**

```javascript
// s3Uploader.js or .env
S3_BUCKET_NAME = my - custom - bucket - name;
```

### **Change S3 Region:**

```javascript
// .env
AWS_REGION = ap - south - 1; // Mumbai region
```

### **Enable Public URLs:**

```javascript
// s3Uploader.js - Line 27
ACL: 'public-read',  // Anyone can view with URL
```

### **Change Screenshot Retention:**

Add S3 lifecycle policy to auto-delete old screenshots:

```bash
# Delete screenshots older than 30 days
aws s3api put-bucket-lifecycle-configuration \
  --bucket reliance-form-screenshots \
  --lifecycle-configuration file://lifecycle.json
```

**lifecycle.json:**

```json
{
  "Rules": [
    {
      "Id": "DeleteOldScreenshots",
      "Status": "Enabled",
      "Prefix": "screenshots/",
      "Expiration": {
        "Days": 30
      }
    }
  ]
}
```

---

## Testing 🧪

### **Test S3 Upload:**

```bash
node -e "
const { uploadScreenshotToS3 } = require('./s3Uploader');
const fs = require('fs');

// Create test image
const testImage = Buffer.from('test').toString('base64');

uploadScreenshotToS3(testImage, 'test/screenshot.png')
  .then(url => console.log('✅ Upload successful:', url))
  .catch(err => console.error('❌ Upload failed:', err.message));
"
```

### **Test Error Logging:**

```bash
# Insert a test job that will fail
db.Captcha.insertOne({
  firstName: "TestError",
  lastName: "User",
  pincode: "INVALID",  // This will cause error
  // ... other fields
});

# Watch console and MongoDB for error logs
```

---

## Summary 🎯

**Your system now:**

1. ✅ Automatically captures screenshots on errors
2. ✅ Uploads to S3 with organized folder structure
3. ✅ Stores S3 URLs in MongoDB
4. ✅ Tracks error details for each attempt
5. ✅ Maintains complete error history
6. ✅ Includes timestamps and error types
7. ✅ Handles multiple error stages
8. ✅ Works with parallel job processing

**Error log includes:**

- Timestamp (when error occurred)
- Attempt number (which retry)
- Screenshot URL (S3 link)
- Error message & stack
- Error type & stage
- Page source (for complex errors)

**Just configure AWS credentials and it works automatically!** 🚀

---

## Environment Variables Required

Add to your `.env` file:

```bash
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=us-east-1
S3_BUCKET_NAME=reliance-form-screenshots
```

**That's it! Start your server and enjoy automatic error logging with S3 screenshots!** 🎉
