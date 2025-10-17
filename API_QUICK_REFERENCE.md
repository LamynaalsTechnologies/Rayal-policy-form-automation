# API Quick Reference 📖

## 3 Simple API Endpoints

### 1. Get Job Status (by Captcha ID)

```bash
GET /api/job-status/:captchaId
```

**Returns:** Complete job details with error logs and screenshots

**Example:**

```bash
curl http://localhost:8800/api/job-status/68f1d8d7047d59e47c8b40f6 | jq
```

---

### 2. List Jobs

```bash
GET /api/jobs?status=failed&limit=20&skip=0
```

**Returns:** List of jobs with pagination

**Examples:**

```bash
# All jobs
curl http://localhost:8800/api/jobs | jq

# Failed jobs only
curl http://localhost:8800/api/jobs?status=failed | jq

# Completed jobs
curl http://localhost:8800/api/jobs?status=completed | jq

# With pagination
curl http://localhost:8800/api/jobs?limit=10&skip=10 | jq
```

---

### 3. Get Statistics

```bash
GET /api/jobs/stats
```

**Returns:** Job statistics (total, success rate, by status)

**Example:**

```bash
curl http://localhost:8800/api/jobs/stats | jq
```

---

## Common Queries

### Get job status after inserting Captcha data:

```javascript
// 1. Insert to Captcha
const result = await db.Captcha.insertOne({ firstName: "John", ... });
const captchaId = result.insertedId.toString();

// 2. Check job status
const response = await fetch(`http://localhost:8800/api/job-status/${captchaId}`);
const jobData = await response.json();
console.log('Status:', jobData.data.status);
```

### View error screenshots:

```javascript
const response = await fetch(`/api/job-status/${captchaId}`);
const data = await response.json();

data.data.screenshotUrls.forEach((url) => {
  console.log("Screenshot:", url);
});
```

### Monitor failed jobs:

```bash
curl http://localhost:8800/api/jobs?status=failed | jq '.data[] | {name: .customerName, error: .lastError}'
```

---

## Test It

```bash
# Run automated tests
node testAPI.js

# Expected output:
✅ All tests passed!
```

---

## Files

- **`API_DOCUMENTATION.md`** - Full documentation
- **`API_QUICK_REFERENCE.md`** - This file
- **`testAPI.js`** - Test script
- **`server.js`** - Implementation

---

**Your API is ready!** 🚀
