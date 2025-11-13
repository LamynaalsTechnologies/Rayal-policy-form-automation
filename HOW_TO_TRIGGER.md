# How to Trigger the Policy Automation Process

## Overview
The system automatically processes jobs when new documents are inserted into the MongoDB `onlinePolicy` collection. The system routes to either **Reliance** or **National** based on the `Companyname` field.

---

## Step 1: Start the Server

```bash
node server.js
```

**What to expect:**
- Server starts on `http://localhost:8800`
- Both Reliance and National master sessions initialize
- MongoDB connection established
- Change stream watching `onlinePolicy` collection

**Look for these logs:**
```
🚀 INITIALIZING RELIANCE AUTOMATION
✅ MASTER SESSION READY

🚀 INITIALIZING NATIONAL AUTOMATION  
✅ NATIONAL MASTER SESSION READY

✅ READY TO PROCESS JOBS
```

---

## Step 2: Trigger a Job

### Method 1: Insert Document into MongoDB (Automatic)

Insert a document into the `onlinePolicy` collection in MongoDB:

**For Reliance Insurance:**
```javascript
db.onlinePolicy.insertOne({
  Companyname: "reliance",  // or omit this field (defaults to reliance)
  firstName: "John",
  lastName: "Doe",
  fullName: "John Doe",
  dateOfBirth: new Date("1990-01-01"),
  mobileNumber: "9876543210",
  email: "john@example.com",
  // ... other fields
})
```

**For National Insurance:**
```javascript
db.onlinePolicy.insertOne({
  Companyname: "national",  // ⚠️ MUST be "national" (lowercase)
  firstName: "John",
  lastName: "Doe",
  fullName: "John Doe",
  dateOfBirth: new Date("1990-01-01"),
  mobileNumber: "9876543210",
  email: "john@example.com",
  rtoLocation: "Mumbai",
  vehicleMake: "Honda",
  vehicleModel: "SHINE 100",
  variant: "Standard",
  // ... other fields
})
```

### Method 2: Use MongoDB Compass / Studio 3T

1. Connect to your MongoDB database
2. Navigate to `onlinePolicy` collection
3. Click "Insert Document"
4. Add the document with `Companyname: "national"` or `Companyname: "reliance"`
5. Save

### Method 3: Use API (if you have one)

If you have an API endpoint that inserts into `onlinePolicy`, use that.

---

## Step 3: Monitor the Process

### Check Server Logs

**For Reliance:**
```
[Reliance Queue] Enqueued job for John (Job ID: ...)
[Reliance Queue] Processing form for: John Doe
🚀 [John_...] Starting job...
✅ [John_...] Browser ready with active session!
```

**For National:**
```
[National Queue] Enqueued job for John (Job ID: ...)
[National Queue] Processing national form for: John Doe
🚀 [John_...] Starting National Insurance job...
✅ [John_...] National browser ready with active session!
```

### Check Job Status via API

```bash
# Get job status by captcha ID
curl http://localhost:8800/api/job-status/{captchaId}

# Get all jobs
curl http://localhost:8800/api/jobs

# Get job statistics
curl http://localhost:8800/api/jobs/stats
```

---

## Key Fields for Routing

### Required Field:
- **`Companyname`**: 
  - `"national"` → Routes to National Insurance
  - `"reliance"` or missing → Routes to Reliance Insurance

### Example Documents:

**Reliance Document:**
```json
{
  "Companyname": "reliance",
  "firstName": "John",
  "lastName": "Doe",
  "fullName": "John Doe",
  "dateOfBirth": "1990-01-01",
  "mobileNumber": "9876543210",
  "email": "john@example.com",
  "vehicleMake": "TVS",
  "vehicleModel": "Scooty Zest",
  "rtoCityLocation": "coimbatore",
  "idv": 50000,
  "engineNumber": "ENG123456",
  "chassisNumber": "CH123456"
}
```

**National Document:**
```json
{
  "Companyname": "national",
  "firstName": "John",
  "lastName": "Doe",
  "fullName": "John Doe",
  "dateOfBirth": "1990-01-01",
  "mobileNumber": "9876543210",
  "email": "john@example.com",
  "rtoLocation": "Mumbai",
  "vehicleMake": "Honda",
  "vehicleModel": "SHINE 100",
  "variant": "Standard"
}
```

---

## Testing Checklist

### ✅ Test Reliance Flow:
1. Insert document with `Companyname: "reliance"` or no `Companyname` field
2. Check logs show `[Reliance Queue]`
3. Verify browser opens Reliance portal
4. Check job completes successfully

### ✅ Test National Flow:
1. Insert document with `Companyname: "national"`
2. Check logs show `[National Queue]`
3. Verify browser opens National portal (nicportal.nic.co.in)
4. Check job completes successfully

### ✅ Test Both Simultaneously:
1. Insert one Reliance job
2. Insert one National job
3. Verify both process in parallel
4. Check both complete independently

---

## Troubleshooting

### Issue: Jobs not processing
- **Check:** MongoDB connection
- **Check:** Server logs for errors
- **Check:** Master sessions initialized successfully

### Issue: Wrong company selected
- **Check:** `Companyname` field is exactly `"national"` (lowercase) for National
- **Check:** Field name is `Companyname` (capital C, lowercase rest)

### Issue: National login fails
- **Check:** Credentials are correct (username: "9999839907", password: "Rayal$2025")
- **Check:** National master session initialized
- **Check:** Network connectivity to nicportal.nic.co.in

### Issue: Reliance login fails
- **Check:** Reliance master session initialized
- **Check:** Credentials are correct (username: "rfcpolicy", password: "Pass@123")

---

## Quick Test Script

Save this as `test-trigger.js`:

```javascript
const { MongoClient } = require('mongodb');

async function testTrigger() {
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db('your-database-name');
    const collection = db.collection('onlinePolicy');
    
    // Test National
    console.log('Triggering National job...');
    await collection.insertOne({
      Companyname: "national",
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      dateOfBirth: new Date("1990-01-01"),
      mobileNumber: "9876543210",
      email: "test@example.com",
      rtoLocation: "Mumbai",
      vehicleMake: "Honda",
      vehicleModel: "SHINE 100",
      variant: "Standard"
    });
    console.log('✅ National job triggered!');
    
    // Test Reliance
    console.log('Triggering Reliance job...');
    await collection.insertOne({
      Companyname: "reliance",
      firstName: "Test",
      lastName: "User",
      fullName: "Test User",
      dateOfBirth: new Date("1990-01-01"),
      mobileNumber: "9876543210",
      email: "test@example.com",
      vehicleMake: "TVS",
      vehicleModel: "Scooty Zest",
      rtoCityLocation: "coimbatore"
    });
    console.log('✅ Reliance job triggered!');
    
  } finally {
    await client.close();
  }
}

testTrigger().catch(console.error);
```

Run: `node test-trigger.js`

---

## Summary

1. **Start server:** `node server.js`
2. **Insert document** into `onlinePolicy` collection with `Companyname: "national"` or `"reliance"`
3. **Watch logs** for processing messages
4. **Check API** endpoints for job status
5. **Verify** both companies work independently

The system automatically:
- Detects new documents via MongoDB change stream
- Routes to correct company based on `Companyname`
- Processes jobs in parallel (up to 3 at a time)
- Handles errors and retries automatically

