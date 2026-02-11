# Dynamic Credentials Flow - Implementation Summary

## Overview
The system now dynamically fetches and uses different login credentials based on the `userId` field in the `onlinePolicy` collection.

## Complete Flow

### 1. **Policy Creation (MongoDB Watch)**
   - Location: `server.js` lines 800-932
   - When a new policy is inserted/updated in `onlinePolicy` collection
   - The `userId` field is extracted and stored in `formData`
   - The policy's `_id` is stored as `captchaId`

### 2. **Job Enqueueing**
   - Location: `server.js` line 931
   - `enqueueRelianceJob(formData, captchaId)` is called
   - The `captchaId` (policy `_id`) is stored in the job document

### 3. **Job Processing**
   - Location: `server.js` `runPolicyJob` function (lines 325-520)
   - Job is fetched from queue with `job.captchaId`
   - Credentials are fetched using `job.captchaId`:
     ```javascript
     const policy = await db.collection("onlinePolicy").findOne({ _id: job.captchaId });
     const uId = policy.userId || policy.clientId;
     const creds = await ProviderCredential.findOne({
       clientId: uId,
       provider: companyName,
       isActive: true
     });
     ```
   - Credentials are passed to `fillRelianceForm` along with `_policyId: job.captchaId`

### 4. **Browser Creation**
   - Location: `relianceForm.js` line 1025
   - `createJobBrowser(jobId, data._policyId)` is called
   - The `policyId` is passed to the session manager

### 5. **Session Validation & Re-login**
   - Location: `sessionManager.js` `createJobBrowser` function (lines 840+)
   - Checks if master session needs re-login:
     - Session expired?
     - Current `clientId` doesn't match required `clientId`?
   - If re-login needed, calls `reLoginIfNeeded(policyId)`

### 6. **Credential Fetching for Re-login**
   - Location: `sessionManager.js` `getCredentialsForPolicy` function (lines 538-580)
   - Fetches policy from `onlinePolicy` using `policyId`
   - Extracts `userId` or `clientId` from policy
   - Finds matching `ProviderCredential` with that `clientId`
   - Returns credentials for login

### 7. **Recovery with Correct Credentials**
   - Location: `sessionManager.js` recovery methods
   - `softRecover`, `hardRecover`, `nuclearRecover` all accept `policyId`
   - Before attempting login, they call `getCredentialsForPolicy(policyId)`
   - This ensures the correct credentials are used for the recovery

## Key Variables Tracked

- **`currentMasterClientId`**: Tracks which client is currently logged into the master session
- **`policyId`**: The MongoDB `_id` of the policy document (same as `captchaId`)
- **`userId`**: The client identifier stored in the policy document
- **`clientId`**: The field in `ProviderCredential` that matches the `userId`

## Database Schema Requirements

### `onlinePolicy` Collection
```javascript
{
  _id: ObjectId,
  userId: String,  // Client identifier
  fullName: String,
  // ... other policy fields
}
```

### `providercredentials` Collection
```javascript
{
  clientId: String,  // Must match userId from policy
  provider: String,  // "reliance" or "national"
  username: String,
  password: String,
  loginUrl: String,
  dashboardUrl: String,
  isActive: Boolean
}
```

## Logging Added

All credential fetching now logs:
- ✅ What `policyId` was received
- ✅ Whether policy was found in database
- ✅ What `userId`/`clientId` was extracted
- ✅ Whether matching credentials were found
- ✅ What credentials are being used
- ✅ Whether client mismatch triggered re-login

## Testing the Flow

1. **Insert a policy** with a specific `userId`
2. **Create matching credentials** in `providercredentials` with that `clientId`
3. **Watch the logs** when the job processes:
   ```
   🔍 [getCredentialsForPolicy] Called with policyId: 65f...
   → [Credentials] Policy found: YES
   → [Credentials] Policy data: { userId: "client123", ... }
   → [Credentials] Using ID: client123 to find ProviderCredential
   → [Credentials] ProviderCredential found: YES
   → [Credentials] Using credentials: { username: "user123", ... }
   ```

## Troubleshooting

If credentials are not being used:
1. Check if `policyId` is `null` in the logs
2. Check if policy has `userId` field
3. Check if `ProviderCredential` exists with matching `clientId`
4. Check if `ProviderCredential.isActive` is `true`
5. Check if `ProviderCredential.provider` matches the company name
