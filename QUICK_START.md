# Quick Start Guide 🚀

## What You Now Have

A **Master Session + Cloned Profiles** system that:

- ✅ Logs in ONCE at startup
- ✅ Each job gets a cloned browser (already logged in!)
- ✅ No repeated logins or captcha solving
- ✅ Parallel processing (3-10 jobs at once)
- ✅ Clean, modular, understandable code

---

## How to Use

### Step 1: Start Server

```bash
node server.js
```

**What happens:**

```
Server started on http://localhost:8800

============================================================
  🚀 INITIALIZING RELIANCE AUTOMATION
============================================================

📂 Creating master browser with profile...
✅ Master browser created

🌐 Navigating to dashboard...
🔍 Checking login status...

Option A: Already logged in
  ✅ Already logged in! Session is active.

Option B: Need to login
  ⚠️  Not logged in. Starting login process...
  🔐 Logging in...
  Captcha text: ABC123
  ✅ Login successful! Session is now active.

============================================================
  ✅ MASTER SESSION READY
============================================================

✅ READY TO PROCESS JOBS
```

**Master browser stays open!** Don't close it.

---

### Step 2: Add Job Data

Insert data into MongoDB:

```javascript
db.Captcha.insertOne({
  firstName: "John",
  lastName: "Doe",
  dateOfBirth: "1990-01-01",
  mobileNumber: "9876543210",
  // ... other fields
});
```

---

### Step 3: Watch the Magic! ✨

**Console output:**

```
[MongoDB Watch] New customer data received: { firstName: "John" }
[Reliance Queue] Enqueued job for John

🚀 [Job John_1697123456] Starting job...
📋 [Job John_1697123456] Creating cloned browser...
📂 [Job John_1697123456] Cloning master profile...
✓ Profile cloned successfully!
🌐 [Job John_1697123456] Opening browser with cloned profile...
✅ [Job John_1697123456] Cloned browser created successfully
✅ [Job John_1697123456] Browser ready with active session!
🌐 [Job John_1697123456] Navigating to form...
✅ [Job John_1697123456] Using cloned session - no login required!

... filling form ...

🧹 [Job John_1697123456] Cleaning up...
✅ [Job John_1697123456] Browser closed
✅ [Job John_1697123456] Cloned profile deleted
✅ [Job John_1697123456] Cleanup complete

[Reliance Queue] ✅ Success for John
```

**Notice:**

- ✅ No login prompt
- ✅ No captcha solving
- ✅ Direct to form filling
- ✅ Automatic cleanup

---

### Step 4: Multiple Jobs (Parallel)

Insert multiple records:

```javascript
// Insert 5 records
for (let i = 0; i < 5; i++) {
  db.Captcha.insertOne({
    firstName: `User${i}`,
    // ... other fields
  });
}
```

**What happens:**

```
[Reliance Queue] Starting 3 jobs in parallel (MAX_PARALLEL_JOBS = 3)

🚀 [Job User0_123] Starting...
🚀 [Job User1_456] Starting...
🚀 [Job User2_789] Starting...

... All 3 browsers open simultaneously ...
... All 3 already logged in ...
... All 3 filling forms ...

✅ [Job User0_123] Complete
✅ [Job User1_456] Complete
✅ [Job User2_789] Complete

🚀 [Job User3_012] Starting...
🚀 [Job User4_345] Starting...

... Process continues ...
```

**Result:** 3x-10x faster than sequential!

---

## File Structure

```
Your Project/
│
├── sessionManager.js       ← Master session management (NEW!)
├── browserv2.js           ← Browser & cloning logic (USED)
├── relianceForm.js        ← Form filling (UPDATED)
├── server.js              ← Server & queue (UPDATED)
│
├── ~/chrome_profile/
│   └── Demo/              ← MASTER PROFILE (stay logged in here!)
│       └── Cookies        ← Session stored here
│
└── cloned_profiles/
    ├── job_xxx/           ← Temp clones (auto-created & deleted)
    └── job_yyy/
```

---

## Key Points

### Master Browser

- Opens once on server start
- Stays open while server runs
- Contains logged-in session
- **Don't close it manually!**

### Cloned Browsers

- Created for each job
- Clone master profile (with session!)
- Already logged in automatically
- Deleted after job completes

### Session Management

- **Automatic:** System checks session before each job
- **Auto Re-login:** If session expires, logs in again
- **No Manual Work:** Just keep server running

---

## Configuration

### Change Parallel Job Count

**File:** `server.js` (Line 29)

```javascript
const MAX_PARALLEL_JOBS = 3; // Change to 1, 5, 10, etc.
```

**Options:**

- `1` = Sequential (slowest, most stable)
- `3` = Balanced (recommended)
- `5` = Fast (needs good PC)
- `10` = Very fast (needs powerful PC)

---

### Change Master Profile Location

**File:** `browserv2.js` (Lines 22-24)

```javascript
const PATHS = {
  BASE_PROFILE: path.join(os.homedir(), "chrome_profile"),
  MASTER_PROFILE: path.join(os.homedir(), "chrome_profile", "Demo"),
  CLONED_PROFILE_BASE: path.join(process.cwd(), "cloned_profiles"),
};
```

---

## Troubleshooting

### Problem: Jobs asking for login

**Cause:** Master session not initialized or expired

**Solution:**

```bash
# Restart server
Ctrl+C
node server.js
# Wait for master session to initialize
```

---

### Problem: "Profile already in use" error

**Cause:** Multiple instances trying to use master profile

**Solution:**

```bash
# Close all Chrome/server instances
pkill -f chrome
pkill -f node

# Restart server
node server.js
```

---

### Problem: Session expired

**What you'll see:**

```
⚠️  Session expired. Re-logging in...
🔐 Logging in...
✅ Re-login successful!
```

**Action:** None! System handles it automatically.

---

### Problem: Too many cloned profiles

**Check:**

```bash
ls -la cloned_profiles/
# Should be empty or only active jobs
```

**Clean up:**

```bash
rm -rf cloned_profiles/*
```

---

## Monitoring

### Check Session Status

```javascript
// In any file
const { getSessionStatus } = require("./sessionManager");
console.log(getSessionStatus());
```

**Output:**

```json
{
  "isActive": true,
  "lastChecked": "2024-01-15T10:30:00.000Z",
  "hasMasterDriver": true
}
```

---

### Check Master Browser

**Visual:** You should see a Chrome window with your dashboard open.

**Console:**

```javascript
const { masterDriver } = require("./sessionManager");
if (masterDriver) {
  console.log("Master browser is running");
}
```

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────┐
│  1. Start Server                                    │
│     node server.js                                  │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│  2. Initialize Master Session                       │
│     - Open master browser                           │
│     - Check if logged in                            │
│     - Login if needed (captcha once!)               │
│     - Master browser stays open                     │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│  3. MongoDB Insert                                  │
│     db.Captcha.insertOne({ firstName: "John" })     │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│  4. Job Queued & Started                            │
│     - Clone master profile                          │
│     - Open browser with clone                       │
│     - Already logged in! ✅                         │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│  5. Fill Form                                       │
│     - Navigate to form                              │
│     - Fill fields                                   │
│     - Submit                                        │
└─────────────────┬───────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────────┐
│  6. Cleanup                                         │
│     - Close cloned browser                          │
│     - Delete cloned profile                         │
│     - Job complete! ✅                              │
└─────────────────────────────────────────────────────┘
```

---

## Summary

**Your system is now:**

- ✅ **Modular:** Clear separation of concerns
- ✅ **Understandable:** Well-documented code
- ✅ **Automatic:** Handles session management
- ✅ **Fast:** 3x-10x faster than before
- ✅ **Reliable:** Robust error handling
- ✅ **Scalable:** Supports parallel processing

**Just run:**

```bash
node server.js
```

**And enjoy automatic form filling with:**

- No repeated logins
- No captcha solving (after first time)
- Parallel processing
- Automatic cleanup

**That's it!** 🎉
