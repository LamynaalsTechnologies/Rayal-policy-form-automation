# Job Status API Documentation 📚

## Overview

Clean, RESTful API endpoints to track job status and retrieve detailed error logs with screenshots from the RelianceJobQueue.

---

## Base URL

```
http://localhost:8800/api
```

---

## Endpoints

### 1. **Get Job Status by Captcha ID** 🔍

Get complete job details using the original Captcha collection document ID.

**Endpoint:**

```
GET /api/job-status/:captchaId
```

**Parameters:**

- `captchaId` (path parameter) - MongoDB ObjectId from Captcha collection (24 characters)

**Example Request:**

```bash
curl http://localhost:8800/api/job-status/507f1f77bcf86cd799439011
```

**Success Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "captchaId": "507f1f77bcf86cd799439011",
    "jobId": "507f191e810c19729de860ea",
    "status": "failed",

    "attempts": 3,
    "maxAttempts": 3,
    "currentAttempt": 3,
    "retriesLeft": 0,

    "hasErrors": true,
    "errorCount": 3,
    "errorLogs": [
      {
        "timestamp": "2024-01-15T10:30:45.123Z",
        "attemptNumber": 1,
        "errorMessage": "Element not found: #btnSubmit",
        "errorType": "FormFillError",
        "errorStack": "Error: Element not found...",
        "screenshotUrl": "https://s3.amazonaws.com/bucket/screenshots/form-error/John_abc/attempt_1/2024-01-15.png",
        "screenshotKey": "screenshots/form-error/John_abc/attempt_1/2024-01-15.png"
      },
      {
        "timestamp": "2024-01-15T10:35:20.456Z",
        "attemptNumber": 2,
        "errorMessage": "Timeout waiting for element",
        "errorType": "PostSubmissionError",
        "screenshotUrl": "https://s3.amazonaws.com/.../attempt_2.png",
        "screenshotKey": "screenshots/post-submission-error/.../attempt_2.png",
        "stage": "post-submission"
      },
      {
        "timestamp": "2024-01-15T10:40:15.789Z",
        "attemptNumber": 3,
        "errorMessage": "Modal not found",
        "errorType": "ModalError",
        "screenshotUrl": "https://s3.amazonaws.com/.../attempt_3.png",
        "screenshotKey": "screenshots/modal-error/.../attempt_3.png",
        "pageSourceUrl": "https://s3.amazonaws.com/.../attempt_3.html",
        "stage": "modal-filling"
      }
    ],

    "lastError": "Modal not found",
    "lastErrorTimestamp": "2024-01-15T10:40:15.789Z",
    "finalError": {
      /* Final error object */
    },

    "lastPostSubmissionError": {
      /* If any */
    },
    "lastModalError": {
      /* If any */
    },

    "screenshotUrls": [
      "https://s3.amazonaws.com/.../attempt_1.png",
      "https://s3.amazonaws.com/.../attempt_2.png",
      "https://s3.amazonaws.com/.../attempt_3.png"
    ],

    "createdAt": "2024-01-15T10:30:00.000Z",
    "startedAt": "2024-01-15T10:30:05.000Z",
    "completedAt": null,
    "failedAt": "2024-01-15T10:40:15.789Z",
    "lastAttemptAt": "2024-01-15T10:40:15.789Z",
    "nextRetryAt": null,

    "customerData": {
      "firstName": "John",
      "lastName": "Doe",
      "mobile": "9876543210",
      "email": "john@example.com"
    }
  }
}
```

**Error Responses:**

**400 Bad Request** (Invalid ID format):

```json
{
  "success": false,
  "message": "Invalid captcha ID format"
}
```

**404 Not Found** (Job not found):

```json
{
  "success": false,
  "message": "Job not found for this captcha ID",
  "captchaId": "507f1f77bcf86cd799439011"
}
```

**500 Internal Server Error**:

```json
{
  "success": false,
  "message": "Internal server error",
  "error": "Error details..."
}
```

---

### 2. **Get Jobs List** 📋

Get list of jobs with optional filtering and pagination.

**Endpoint:**

```
GET /api/jobs
```

**Query Parameters:**

- `status` (optional) - Filter by status: `pending`, `processing`, `completed`, `failed`
- `limit` (optional) - Number of results (default: 50, max: 100)
- `skip` (optional) - Number to skip for pagination (default: 0)
- `sortBy` (optional) - Sort field (default: `createdAt`)
- `sortOrder` (optional) - `asc` or `desc` (default: `desc`)

**Example Requests:**

Get all failed jobs:

```bash
curl http://localhost:8800/api/jobs?status=failed
```

Get completed jobs with pagination:

```bash
curl http://localhost:8800/api/jobs?status=completed&limit=20&skip=0
```

Get pending jobs sorted by creation date:

```bash
curl http://localhost:8800/api/jobs?status=pending&sortBy=createdAt&sortOrder=desc
```

Get next page:

```bash
curl http://localhost:8800/api/jobs?limit=10&skip=10
```

**Success Response (200 OK):**

```json
{
  "success": true,
  "data": [
    {
      "jobId": "507f191e810c19729de860ea",
      "captchaId": "507f1f77bcf86cd799439011",
      "status": "failed",
      "attempts": 3,
      "customerName": "John Doe",
      "mobile": "9876543210",
      "hasErrors": true,
      "errorCount": 3,
      "lastError": "Modal not found",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "completedAt": null,
      "failedAt": "2024-01-15T10:40:15.789Z"
    },
    {
      "jobId": "507f191e810c19729de860eb",
      "captchaId": "507f1f77bcf86cd799439012",
      "status": "completed",
      "attempts": 1,
      "customerName": "Jane Smith",
      "mobile": "9876543211",
      "hasErrors": false,
      "errorCount": 0,
      "lastError": null,
      "createdAt": "2024-01-15T10:31:00.000Z",
      "completedAt": "2024-01-15T10:31:30.000Z",
      "failedAt": null
    }
  ],
  "pagination": {
    "total": 125,
    "limit": 50,
    "skip": 0,
    "returned": 50,
    "hasMore": true,
    "nextSkip": 50
  },
  "filter": {
    "status": "failed"
  }
}
```

**Error Responses:**

**400 Bad Request** (Invalid status):

```json
{
  "success": false,
  "message": "Invalid status. Must be one of: pending, processing, completed, failed"
}
```

---

### 3. **Get Job Statistics** 📊

Get aggregate statistics about all jobs.

**Endpoint:**

```
GET /api/jobs/stats
```

**Example Request:**

```bash
curl http://localhost:8800/api/jobs/stats
```

**Success Response (200 OK):**

```json
{
  "success": true,
  "data": {
    "total": 125,
    "byStatus": {
      "completed": {
        "count": 95,
        "avgAttempts": 1.05
      },
      "failed": {
        "count": 20,
        "avgAttempts": 3
      },
      "pending": {
        "count": 8,
        "avgAttempts": 0
      },
      "processing": {
        "count": 2,
        "avgAttempts": 1
      }
    },
    "successRate": "76%",
    "metrics": {
      "completed": 95,
      "failed": 20,
      "pending": 8,
      "processing": 2
    }
  }
}
```

---

## Usage Examples

### JavaScript/Node.js

```javascript
const axios = require("axios");

// Get job status by Captcha ID
const captchaId = "507f1f77bcf86cd799439011";
const response = await axios.get(
  `http://localhost:8800/api/job-status/${captchaId}`
);

if (response.data.success) {
  const job = response.data.data;
  console.log("Status:", job.status);
  console.log("Attempts:", job.attempts);
  console.log("Errors:", job.errorCount);

  // View screenshots
  job.screenshotUrls.forEach((url, index) => {
    console.log(`Screenshot ${index + 1}:`, url);
  });
}
```

### Python

```python
import requests

# Get job status
captcha_id = '507f1f77bcf86cd799439011'
response = requests.get(f'http://localhost:8800/api/job-status/{captcha_id}')

if response.json()['success']:
    job = response.json()['data']
    print(f"Status: {job['status']}")
    print(f"Attempts: {job['attempts']}")
    print(f"Errors: {job['errorCount']}")

    # View screenshots
    for url in job['screenshotUrls']:
        print(f"Screenshot: {url}")
```

### cURL

```bash
# Get job status
curl http://localhost:8800/api/job-status/507f1f77bcf86cd799439011 | jq

# Get failed jobs
curl http://localhost:8800/api/jobs?status=failed | jq

# Get stats
curl http://localhost:8800/api/jobs/stats | jq
```

### Browser/Fetch

```javascript
// Get job status
const captchaId = "507f1f77bcf86cd799439011";
const response = await fetch(
  `http://localhost:8800/api/job-status/${captchaId}`
);
const data = await response.json();

if (data.success) {
  console.log("Job Status:", data.data.status);
  console.log("Error Logs:", data.data.errorLogs);

  // Display screenshots
  data.data.screenshotUrls.forEach((url) => {
    const img = document.createElement("img");
    img.src = url;
    document.body.appendChild(img);
  });
}
```

---

## Response Fields Explained

### Job Status Response Fields:

| Field            | Type    | Description                                               |
| ---------------- | ------- | --------------------------------------------------------- |
| `captchaId`      | String  | Original Captcha collection document ID                   |
| `jobId`          | String  | RelianceJobQueue document ID                              |
| `status`         | String  | Current status: pending/processing/completed/failed       |
| `attempts`       | Number  | How many times job was attempted                          |
| `maxAttempts`    | Number  | Maximum retry attempts (usually 3)                        |
| `retriesLeft`    | Number  | Remaining retry attempts                                  |
| `hasErrors`      | Boolean | Whether job has any errors                                |
| `errorCount`     | Number  | Total number of errors                                    |
| `errorLogs`      | Array   | Complete error history (see below)                        |
| `screenshotUrls` | Array   | All screenshot URLs from all attempts                     |
| `lastError`      | String  | Most recent error message                                 |
| `finalError`     | Object  | Final error when all attempts exhausted                   |
| `createdAt`      | Date    | When job was created                                      |
| `startedAt`      | Date    | When processing started                                   |
| `completedAt`    | Date    | When job completed successfully                           |
| `failedAt`       | Date    | When job failed permanently                               |
| `nextRetryAt`    | Date    | When next retry is scheduled                              |
| `customerData`   | Object  | Customer information (firstName, lastName, mobile, email) |

### Error Log Object Fields:

| Field           | Type   | Description                                                     |
| --------------- | ------ | --------------------------------------------------------------- |
| `timestamp`     | Date   | When error occurred                                             |
| `attemptNumber` | Number | Which attempt (1, 2, 3, etc.)                                   |
| `errorMessage`  | String | Error description                                               |
| `errorType`     | String | Error category (FormFillError, ModalError, PostSubmissionError) |
| `errorStack`    | String | Full stack trace                                                |
| `screenshotUrl` | String | S3 URL to error screenshot                                      |
| `screenshotKey` | String | S3 object key                                                   |
| `pageSourceUrl` | String | S3 URL to HTML snapshot (if captured)                           |
| `stage`         | String | Processing stage (modal-filling, post-submission, etc.)         |

---

## Common Use Cases

### Use Case 1: Track Form Submission Progress

```javascript
// After inserting data to Captcha collection
const captchaResult = await db.Captcha.insertOne({
  firstName: "John",
  // ... other fields
});

const captchaId = captchaResult.insertedId.toString();

// Poll for status every 5 seconds
const interval = setInterval(async () => {
  const response = await fetch(
    `http://localhost:8800/api/job-status/${captchaId}`
  );
  const data = await response.json();

  if (data.success) {
    const job = data.data;
    console.log(
      `Status: ${job.status}, Attempts: ${job.attempts}/${job.maxAttempts}`
    );

    if (job.status === "completed") {
      console.log("✅ Job completed successfully!");
      clearInterval(interval);
    } else if (job.status === "failed") {
      console.log("❌ Job failed after all attempts");
      console.log("Errors:", job.errorLogs);
      clearInterval(interval);
    }
  }
}, 5000);
```

### Use Case 2: Display Error Screenshots to User

```javascript
const captchaId = "507f1f77bcf86cd799439011";
const response = await fetch(
  `http://localhost:8800/api/job-status/${captchaId}`
);
const data = await response.json();

if (data.success && data.data.hasErrors) {
  // Show error details to user
  data.data.errorLogs.forEach((error) => {
    console.log(`Attempt ${error.attemptNumber}: ${error.errorMessage}`);

    if (error.screenshotUrl) {
      // Display screenshot
      const img = document.createElement("img");
      img.src = error.screenshotUrl;
      img.alt = `Error screenshot - Attempt ${error.attemptNumber}`;
      document.getElementById("error-screenshots").appendChild(img);
    }
  });
}
```

### Use Case 3: Monitor Failed Jobs

```javascript
// Get all failed jobs from last hour
const response = await fetch(
  "http://localhost:8800/api/jobs?status=failed&limit=100"
);
const data = await response.json();

if (data.success) {
  console.log(`Found ${data.pagination.total} failed jobs`);

  data.data.forEach((job) => {
    console.log(`${job.customerName}: ${job.lastError}`);
  });

  // Get next page if more exist
  if (data.pagination.hasMore) {
    const nextPage = await fetch(
      `http://localhost:8800/api/jobs?status=failed&limit=100&skip=${data.pagination.nextSkip}`
    );
  }
}
```

### Use Case 4: Dashboard Statistics

```javascript
const response = await fetch("http://localhost:8800/api/jobs/stats");
const data = await response.json();

if (data.success) {
  const stats = data.data;

  console.log(`Total Jobs: ${stats.total}`);
  console.log(`Success Rate: ${stats.successRate}`);
  console.log(`Completed: ${stats.metrics.completed}`);
  console.log(`Failed: ${stats.metrics.failed}`);
  console.log(`Pending: ${stats.metrics.pending}`);
  console.log(`Processing: ${stats.metrics.processing}`);
}
```

---

## Integration with Frontend

### React Example

```javascript
import { useState, useEffect } from "react";

function JobStatusTracker({ captchaId }) {
  const [jobStatus, setJobStatus] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await fetch(
          `http://localhost:8800/api/job-status/${captchaId}`
        );
        const data = await response.json();

        if (data.success) {
          setJobStatus(data.data);
        }
      } catch (error) {
        console.error("Error fetching job status:", error);
      } finally {
        setLoading(false);
      }
    };

    // Poll every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    fetchStatus(); // Initial fetch

    return () => clearInterval(interval);
  }, [captchaId]);

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h3>Job Status: {jobStatus?.status}</h3>
      <p>
        Attempts: {jobStatus?.attempts}/{jobStatus?.maxAttempts}
      </p>

      {jobStatus?.hasErrors && (
        <div>
          <h4>Errors:</h4>
          {jobStatus.errorLogs.map((error, index) => (
            <div key={index}>
              <p>
                Attempt {error.attemptNumber}: {error.errorMessage}
              </p>
              {error.screenshotUrl && (
                <img src={error.screenshotUrl} alt="Error screenshot" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

---

## Testing

### Test Endpoint 1: Job Status

```bash
# Replace with actual captcha ID from your database
curl http://localhost:8800/api/job-status/507f1f77bcf86cd799439011 | jq
```

### Test Endpoint 2: Get Jobs

```bash
# Get all jobs
curl http://localhost:8800/api/jobs | jq

# Get failed jobs only
curl http://localhost:8800/api/jobs?status=failed | jq

# Get first 10 jobs
curl http://localhost:8800/api/jobs?limit=10 | jq
```

### Test Endpoint 3: Stats

```bash
curl http://localhost:8800/api/jobs/stats | jq
```

---

## Database Schema

### RelianceJobQueue Document Structure:

```javascript
{
  _id: ObjectId("507f191e810c19729de860ea"),

  // NEW: Reference to Captcha collection
  captchaId: ObjectId("507f1f77bcf86cd799439011"),

  formData: {
    firstName: "John",
    lastName: "Doe",
    mobile: "9876543210",
    // ... other fields
  },

  status: "failed",
  attempts: 3,
  maxAttempts: 3,

  // Error tracking
  errorLogs: [
    {
      timestamp: ISODate("..."),
      attemptNumber: 1,
      errorMessage: "...",
      errorType: "FormFillError",
      screenshotUrl: "https://s3...",
      screenshotKey: "screenshots/..."
    },
    // ... more error logs
  ],

  lastError: "...",
  lastErrorTimestamp: ISODate("..."),
  finalError: { /* ... */ },

  // Timestamps
  createdAt: ISODate("..."),
  startedAt: ISODate("..."),
  completedAt: ISODate("..."),
  failedAt: ISODate("..."),
  nextRetryAt: ISODate("..."),
}
```

### Indexes Created:

```javascript
// For status filtering
{ status: 1, createdAt: 1 }

// For date sorting
{ createdAt: 1 }

// For captchaId lookups (NEW!)
{ captchaId: 1 }

// For error history queries (NEW!)
{ 'errorLogs.timestamp': 1 }
```

---

## Error Handling

All endpoints include proper error handling:

1. **Input Validation** - Validates parameters before processing
2. **Database Errors** - Catches and returns meaningful messages
3. **Not Found** - Returns 404 with helpful message
4. **Server Errors** - Returns 500 with error details (in development)

---

## Security Considerations

**Current Implementation:**

- No authentication (suitable for internal use)
- CORS not configured (same-origin only)
- No rate limiting

**For Production:**

Add authentication:

```javascript
const authenticateRequest = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

app.get("/api/job-status/:captchaId", authenticateRequest, async (req, res) => {
  // ... endpoint logic
});
```

Add CORS:

```javascript
const cors = require("cors");
app.use(
  cors({
    origin: "https://your-frontend.com",
  })
);
```

Add rate limiting:

```javascript
const rateLimit = require("express-rate-limit");
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});
app.use("/api/", limiter);
```

---

## Monitoring

### Log API Requests

All endpoints log to console:

```
[API] Error fetching job status: ...
[API] Error fetching jobs: ...
[API] Error fetching stats: ...
```

### Track API Usage

Add middleware to track API calls:

```javascript
app.use("/api/", (req, res, next) => {
  console.log(`[API] ${req.method} ${req.path} - ${new Date().toISOString()}`);
  next();
});
```

---

## Summary

**You now have 3 clean API endpoints:**

1. ✅ `GET /api/job-status/:captchaId` - Get job details by Captcha ID
2. ✅ `GET /api/jobs` - List jobs with filtering & pagination
3. ✅ `GET /api/jobs/stats` - Get job statistics

**Features:**

- Clean, RESTful design
- Comprehensive error handling
- Input validation
- Pagination support
- Detailed documentation
- Ready for frontend integration

**Start using:**

```bash
node server.js

# Then test:
curl http://localhost:8800/api/jobs/stats | jq
```

**Enjoy your modular, well-structured API!** 🚀
