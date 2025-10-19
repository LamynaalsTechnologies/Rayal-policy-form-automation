# 🔄 Multi-Level Master Session Recovery System

## Overview

The enhanced session manager now includes a **3-level progressive recovery system** that automatically handles master session failures with increasing levels of intervention.

## Recovery Levels

### 🔧 Level 1: Soft Recovery (Re-login)

- **What it does**: Attempts to re-login on the existing browser
- **When used**: Session expired, cookies invalid
- **Duration**: 10-20 seconds
- **Max attempts**: 3
- **Use case**: Normal session expiration

### 🔨 Level 2: Hard Recovery (Recreate Browser)

- **What it does**: Closes broken browser, creates new instance, logs in
- **When used**: Browser crashed, unresponsive, soft recovery failed
- **Duration**: 30-60 seconds
- **Max attempts**: 2
- **Use case**: Browser crash, WebDriver connection lost

### ☢️ Level 3: Nuclear Recovery (Fresh Profile)

- **What it does**: Deletes profile, creates fresh profile, logs in
- **When used**: Profile corrupted, all other recovery failed
- **Duration**: 60-90 seconds
- **Max attempts**: 1
- **Use case**: Profile corruption, persistent login issues

## How It Works

```javascript
Session Check Fails
  ↓
reLoginIfNeeded() called
  ↓
recoveryManager.recover() initiated
  ↓
┌─────────────────────────────────────┐
│ Level 1: Soft Recovery              │
│ Try 3 times                          │
└─────────────────────────────────────┘
  ↓ (if all fail)
┌─────────────────────────────────────┐
│ Level 2: Hard Recovery              │
│ Try 2 times                          │
└─────────────────────────────────────┘
  ↓ (if all fail)
┌─────────────────────────────────────┐
│ Level 3: Nuclear Recovery           │
│ Try 1 time                           │
└─────────────────────────────────────┘
  ↓ (if fails)
🚨 CRITICAL ALERT - Manual intervention
```

## Automatic Features

### ✅ Profile Backup & Restore

- Nuclear recovery automatically backs up profile before deletion
- If fresh profile fails, backup is restored
- Backup location: `~/chrome_profile/Demo_backup_<timestamp>`

### ✅ Recovery History Tracking

- Tracks all recovery attempts with timestamps
- Records success/failure and reason
- Accessible via `getSessionStatus()`

### ✅ Automatic Counter Reset

- Counters reset after successful recovery
- Allows full recovery attempts for next failure

### ✅ Critical Failure Alerts

- Logs critical alert when all recovery exhausted
- Shows recovery history for debugging
- Ready for integration with alerting systems

## Usage

### Check Session Status

```javascript
const { getSessionStatus } = require("./sessionManager");

const status = getSessionStatus();
console.log(status);
// {
//   isActive: true,
//   lastChecked: 2024-01-15T10:30:00Z,
//   hasMasterDriver: true,
//   recoveryHistory: {
//     attempts: { soft: {count: 0, max: 3}, ... },
//     lastRecoveryTime: null,
//     recentHistory: []
//   }
// }
```

### Monitor Recovery

```javascript
const { recoveryManager } = require("./sessionManager");

// Get recovery history
const history = recoveryManager.getHistory();
console.log("Recent recoveries:", history.recentHistory);
```

### Manual Recovery Trigger

```javascript
const { reLoginIfNeeded } = require("./sessionManager");

// This will automatically use multi-level recovery
const recovered = await reLoginIfNeeded();

if (recovered) {
  console.log("Session recovered successfully");
} else {
  console.log("Recovery failed - manual intervention needed");
}
```

## Console Output Examples

### Successful Soft Recovery

```
🔄 Session invalid - initiating multi-level recovery...

============================================================
  🔄 MASTER SESSION RECOVERY INITIATED
============================================================

🔧 LEVEL 1: Soft Recovery (attempt 1/3)
   → Checking if master browser is responsive...
   ✓ Master browser is responsive
   → Navigating to dashboard...
   → Attempting re-login...
   ✓ Re-login successful
✅ LEVEL 1: Soft recovery SUCCESSFUL!

✅ Master session recovered successfully!
============================================================
```

### Hard Recovery After Soft Fails

```
🔄 Session invalid - initiating multi-level recovery...

============================================================
  🔄 MASTER SESSION RECOVERY INITIATED
============================================================

🔧 LEVEL 1: Soft Recovery (attempt 1/3)
   → Checking if master browser is responsive...
   ✗ Master browser is unresponsive: disconnected
❌ LEVEL 1: Soft recovery failed

🔨 LEVEL 2: Hard Recovery (attempt 1/2)
   → Closing broken master browser...
   ✓ Broken browser closed
   → Creating new master browser...
   ✓ New master browser created
   → Navigating to dashboard...
   → Attempting login on new browser...
   ✓ Login successful on new browser
✅ LEVEL 2: Hard recovery SUCCESSFUL!

✅ Master session recovered successfully!
============================================================
```

### Nuclear Recovery

```
☢️  LEVEL 3: Nuclear Recovery (attempt 1/1)
   ⚠️  WARNING: This will delete and recreate the master profile!
   → Backing up current profile...
   ✓ Profile backed up to: ~/chrome_profile/Demo_backup_1705567890123
   → Closing master browser...
   → Deleting corrupted profile...
   ✓ Profile deleted
   → Creating fresh profile directory...
   ✓ Fresh profile directory created
   → Creating new master browser with fresh profile...
   ✓ New master browser created
   → Navigating to dashboard...
   → Attempting login on fresh profile...
   ✓ Login successful on fresh profile!
✅ LEVEL 3: Nuclear recovery SUCCESSFUL!
```

### Critical Failure

```
============================================================
  💥 CRITICAL: ALL RECOVERY ATTEMPTS EXHAUSTED
============================================================
🚨 Manual intervention required!
📊 Recovery history: [
  {
    "level": "soft",
    "success": false,
    "reason": "Login failed",
    "timestamp": "2024-01-15T10:30:00Z"
  },
  ...
]
============================================================

🚨 CRITICAL ALERT TRIGGERED 🚨
Master session recovery failed completely!
```

## Integration with Job Processing

The recovery system is automatically integrated with job processing:

```javascript
// In createJobBrowser() - sessionManager.js
if (!isSessionActive) {
  console.log(`⚠️  Master session not active. Checking...`);

  // This now uses multi-level recovery
  const sessionValid = await reLoginIfNeeded();

  if (!sessionValid) {
    throw new Error("Master session is not active and recovery failed");
  }
}

// Job continues with recovered session ✅
```

## Configuration

Adjust recovery attempts in the MasterSessionRecovery constructor:

```javascript
this.recoveryAttempts = {
  soft: { count: 0, max: 3 }, // Adjust max attempts
  hard: { count: 0, max: 2 }, // Adjust max attempts
  nuclear: { count: 0, max: 1 }, // Adjust max attempts
};
```

## Future Enhancements

### Alert Integration (TODO)

```javascript
sendCriticalAlert() {
  // Implement email alerts
  await sendEmail({
    to: 'admin@company.com',
    subject: 'CRITICAL: Session Recovery Failed',
    body: JSON.stringify(this.recoveryHistory)
  });

  // Implement Slack alerts
  await sendSlackMessage({
    channel: '#alerts',
    text: '🚨 Master session recovery failed!'
  });

  // Implement SMS alerts
  await sendSMS({
    to: '+1234567890',
    message: 'CRITICAL: Manual intervention required'
  });
}
```

## Benefits

### ✅ Self-Healing System

- Automatically recovers from various failure modes
- No manual intervention for common issues
- Handles browser crashes gracefully

### ✅ Minimal Downtime

- Quick recovery for common issues (10-20s)
- Progressive escalation only when needed
- Backup/restore for safety

### ✅ Better Observability

- Complete recovery history
- Success/failure tracking
- Detailed logging for debugging

### ✅ Production Ready

- Handles edge cases
- Safe profile operations
- Graceful degradation

## Metrics to Monitor

Track these metrics in production:

1. **Recovery Success Rate**: `successful recoveries / total recovery attempts`
2. **Recovery Level Distribution**: Which levels are used most
3. **Time to Recovery**: Average time per recovery level
4. **Critical Failure Rate**: How often manual intervention is needed
5. **Recovery Triggers**: What causes recoveries (session expiry, crash, etc.)

## Troubleshooting

### Issue: Soft recovery always fails

**Solution**: Check network connectivity, portal availability, credentials

### Issue: Hard recovery always fails

**Solution**: Check browser installation, ChromeDriver version, system resources

### Issue: Nuclear recovery fails

**Solution**: Check disk space, file permissions, may indicate fundamental issue with credentials or portal

### Issue: Frequent recoveries

**Solution**: Investigate root cause - session timeout too short? Network issues? Portal instability?

---

## Summary

The multi-level recovery system provides **robust, automatic session management** that handles failures gracefully and minimizes downtime. It's production-ready and self-healing! 🚀
