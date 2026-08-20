/**
 * S3 Uploader - Upload screenshots and files to S3
 */

const AWS = require("aws-sdk");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Check if AWS credentials are configured
const hasAwsCredentials = !!(
  process.env.AWS_ACCESS_KEY_ID &&
  process.env.AWS_SECRET_ACCESS_KEY &&
  process.env.AWS_REGION &&
  process.env.S3_BUCKET_NAME
);

if (!hasAwsCredentials) {
  console.warn("\n⚠️  WARNING: AWS S3 credentials not configured!");
  console.warn("   Screenshots will be saved locally instead of S3.");
  console.warn("   To enable S3: Add AWS credentials to .env file");
  console.warn("   See ENV_SETUP_GUIDE.md for instructions\n");
}

// Configure AWS SDK (only if credentials available)
let s3 = null;
let BUCKET_NAME = null;

if (hasAwsCredentials) {
  s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
  });
  BUCKET_NAME = process.env.S3_BUCKET_NAME;
}

/**
 * Upload a file to S3
 * @param {string} filePath - Local file path
 * @param {string} s3Key - S3 object key (folder/filename.ext)
 * @returns {Promise<string>} S3 URL
 */
async function uploadToS3(filePath, s3Key) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const contentType = getContentType(filePath);

    const params = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileContent,
      ContentType: contentType,
      ACL: "private", // Change to 'public-read' if you want public URLs
    };

    console.log(`📤 Uploading to S3: ${s3Key}...`);
    const result = await s3.upload(params).promise();

    console.log(`✅ Uploaded successfully: ${result.Location}`);
    return result.Location;
  } catch (error) {
    console.error(`❌ S3 upload failed for ${s3Key}:`, error.message);
    throw error;
  }
}

/**
 * Upload screenshot from base64 string
 * @param {string} base64Data - Base64 encoded image
 * @param {string} s3Key - S3 object key
 * @returns {Promise<string>} S3 URL or local path
 */
async function uploadScreenshotToS3(base64Data, s3Key) {
  // If S3 not configured, save locally
  if (!hasAwsCredentials || !s3) {
    const localPath = path.join(__dirname, "local-screenshots", s3Key);
    const localDir = path.dirname(localPath);

    // Create directory if doesn't exist
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }

    // Save file
    fs.writeFileSync(localPath, base64Data, "base64");
    console.log(`📁 Screenshot saved locally: ${localPath}`);

    return `file://${localPath}`;
  }

  // S3 configured - upload to cloud
  try {
    const buffer = Buffer.from(base64Data, "base64");

    const params = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: buffer,
      ContentType: "image/png",
      ACL: "private",
    };

    console.log(`📤 Uploading screenshot to S3: ${s3Key}...`);
    const result = await s3.upload(params).promise();

    console.log(`✅ Screenshot uploaded: ${result.Location}`);
    return result.Location;
  } catch (error) {
    console.error(`❌ Screenshot upload failed:`, error.message);

    // Fallback to local storage
    const localPath = path.join(__dirname, "local-screenshots", s3Key);
    const localDir = path.dirname(localPath);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(localPath, base64Data, "base64");
    console.log(`📁 Fallback: Screenshot saved locally: ${localPath}`);

    return `file://${localPath}`;
  }
}

/**
 * Get content type based on file extension
 */
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".html": "text/html",
  };
  return contentTypes[ext] || "application/octet-stream";
}

/**
 * Generate S3 key for screenshot
 * @param {string} jobId - Job identifier
 * @param {number} attempt - Attempt number
 * @param {string} type - Screenshot type (e.g., 'error', 'post-submission')
 * @returns {string} S3 key
 */
function generateScreenshotKey(jobId, attempt, type = "error") {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sanitizedJobId = jobId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `screenshots/${type}/${sanitizedJobId}/attempt_${attempt}/${timestamp}.png`;
}

// ─── Job screen recordings ───────────────────────────────────────────────────
// Videos live under this prefix so ONE lifecycle rule can expire them all
// without touching screenshots or anything else in the bucket.
const RECORDING_PREFIX = "recordings/";
const RECORDING_RETENTION_DAYS =
  parseInt(process.env.RECORDING_RETENTION_DAYS, 10) || 10;
const RECORDING_LIFECYCLE_RULE_ID = "auto-delete-job-recordings";
const LOCAL_RECORDINGS_DIR = path.join(__dirname, "local-recordings");
// Ceiling for the local fallback folder (only used when S3 is unreachable).
const LOCAL_MAX_MB = parseInt(process.env.RECORDING_LOCAL_MAX_MB, 10) || 2048;

/**
 * S3 key for a policy's screen recording: recordings/<company>/<policyId>.mp4
 *
 * Deliberately ONE key per policy, with no attempt number in it. Re-running a
 * policy overwrites the same object, so the old video is physically replaced
 * rather than kept alongside the new one — only the latest run is ever stored.
 */
function generateRecordingKey(companyName, policyId) {
  const company = String(companyName || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
  const sanitizedId = String(policyId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${RECORDING_PREFIX}${company}/${sanitizedId}.mp4`;
}

/** Remove one recording object. Never throws — a missing key is a no-op. */
async function deleteRecordingFromS3(s3Key) {
  if (!hasAwsCredentials || !s3 || !s3Key) return false;
  try {
    await s3.deleteObject({ Bucket: BUCKET_NAME, Key: s3Key }).promise();
    console.log(`🗑️  Deleted old recording: ${s3Key}`);
    return true;
  } catch (error) {
    console.warn(`⚠️ Could not delete recording ${s3Key}: ${error.message}`);
    return false;
  }
}

/**
 * Upload a recording MP4. Falls back to local-recordings/ when S3 is not
 * configured or the upload fails — same graceful degradation as screenshots.
 * @returns {Promise<{storage: "s3"|"local", location: string}>}
 */
async function uploadRecordingToS3(filePath, s3Key) {
  const saveLocally = () => {
    const localPath = path.join(LOCAL_RECORDINGS_DIR, s3Key);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.copyFileSync(filePath, localPath);
    console.log(`📁 Recording saved locally: ${localPath}`);
    return { storage: "local", location: localPath };
  };

  if (!hasAwsCredentials || !s3) return saveLocally();

  try {
    console.log(`📤 Uploading recording to S3: ${s3Key}...`);
    const result = await s3
      .upload({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: fs.createReadStream(filePath),
        ContentType: "video/mp4",
        ACL: "private",
      })
      .promise();
    console.log(`✅ Recording uploaded: ${result.Location}`);
    return { storage: "s3", location: result.Location };
  } catch (error) {
    console.error(`❌ Recording upload failed:`, error.message);
    return saveLocally();
  }
}

/**
 * Make sure the bucket expires recordings on its own.
 *
 * Runs on every server start (idempotent). Reads the existing lifecycle
 * configuration and re-writes it with our rule added/updated — other rules on
 * the bucket are preserved untouched. After this, S3 itself deletes every
 * object under recordings/ once it is RECORDING_RETENTION_DAYS old; no cron,
 * no manual cleanup.
 */
async function ensureRecordingLifecycleRule() {
  if (!hasAwsCredentials || !s3) {
    console.warn("⚠️ Recording lifecycle rule skipped — S3 not configured");
    return false;
  }

  try {
    let rules = [];
    try {
      const existing = await s3
        .getBucketLifecycleConfiguration({ Bucket: BUCKET_NAME })
        .promise();
      rules = existing.Rules || [];
    } catch (err) {
      if (err.code !== "NoSuchLifecycleConfiguration") throw err;
    }

    const ours = {
      ID: RECORDING_LIFECYCLE_RULE_ID,
      Filter: { Prefix: RECORDING_PREFIX },
      Status: "Enabled",
      Expiration: { Days: RECORDING_RETENTION_DAYS },
    };

    const current = rules.find((r) => r.ID === RECORDING_LIFECYCLE_RULE_ID);
    if (current && current.Expiration?.Days === RECORDING_RETENTION_DAYS) {
      console.log(
        `🗓️  S3 lifecycle: recordings already expire after ${RECORDING_RETENTION_DAYS} days`
      );
      return true;
    }

    const nextRules = rules
      .filter((r) => r.ID !== RECORDING_LIFECYCLE_RULE_ID)
      .concat([ours]);

    await s3
      .putBucketLifecycleConfiguration({
        Bucket: BUCKET_NAME,
        LifecycleConfiguration: { Rules: nextRules },
      })
      .promise();

    console.log(
      `🗓️  S3 lifecycle rule set: recordings/ auto-deletes after ${RECORDING_RETENTION_DAYS} days`
    );
    return true;
  } catch (error) {
    console.error(
      `⚠️ Could not set the S3 lifecycle rule for recordings (${error.message}).\n` +
        `   Recordings will still upload, but WON'T auto-delete. Either grant the\n` +
        `   IAM user s3:GetLifecycleConfiguration + s3:PutLifecycleConfiguration on\n` +
        `   ${BUCKET_NAME}, or add a rule manually in the S3 console: prefix\n` +
        `   "${RECORDING_PREFIX}", expire after ${RECORDING_RETENTION_DAYS} days.`
    );
    return false;
  }
}

/**
 * Keep the local-fallback folder from growing without bound.
 *
 * Videos only land here when S3 is unreachable, and unlike S3 objects they
 * have no lifecycle rule looking after them. Two limits, both enforced here:
 *
 *   1. age  — anything older than RECORDING_RETENTION_DAYS goes, matching what
 *             S3 does to the uploaded ones.
 *   2. size — if the folder still exceeds RECORDING_LOCAL_MAX_MB, the oldest
 *             files go until it fits. Without this, a long S3 outage would
 *             quietly fill the automation server's disk.
 */
function purgeOldLocalRecordings() {
  if (!fs.existsSync(LOCAL_RECORDINGS_DIR)) return;
  const cutoff = Date.now() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const maxBytes = LOCAL_MAX_MB * 1024 * 1024;
  const survivors = [];
  let removedByAge = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(full);
          if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
        } else {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            removedByAge++;
          } else {
            survivors.push({ full, mtimeMs: stat.mtimeMs, size: stat.size });
          }
        }
      } catch (e) {
        /* a file in use or already gone is fine */
      }
    }
  };

  try {
    walk(LOCAL_RECORDINGS_DIR);

    // Size cap: drop the oldest survivors until the folder is under the limit.
    let total = survivors.reduce((sum, f) => sum + f.size, 0);
    let removedBySize = 0;
    if (total > maxBytes) {
      survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of survivors) {
        if (total <= maxBytes) break;
        try {
          fs.unlinkSync(f.full);
          total -= f.size;
          removedBySize++;
        } catch (e) {
          /* skip and carry on */
        }
      }
    }

    if (removedByAge || removedBySize) {
      const parts = [];
      if (removedByAge) parts.push(`${removedByAge} older than ${RECORDING_RETENTION_DAYS} days`);
      if (removedBySize) parts.push(`${removedBySize} to stay under ${LOCAL_MAX_MB} MB`);
      console.log(`🗑️  Purged local recordings: ${parts.join(", ")}`);
    }
  } catch (e) {
    console.warn(`⚠️ Local recordings purge failed: ${e.message}`);
  }
}

/**
 * Get presigned URL for private S3 object (expires in 7 days)
 * @param {string} s3Key - S3 object key
 * @returns {Promise<string>} Presigned URL
 */
async function getPresignedUrl(s3Key) {
  try {
    const params = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Expires: 60 * 60 * 24 * 7, // 7 days
    };

    const url = await s3.getSignedUrlPromise("getObject", params);
    return url;
  } catch (error) {
    console.error("❌ Failed to generate presigned URL:", error.message);
    throw error;
  }
}

module.exports = {
  uploadToS3,
  uploadScreenshotToS3,
  generateScreenshotKey,
  getPresignedUrl,
  BUCKET_NAME,
  uploadRecordingToS3,
  generateRecordingKey,
  deleteRecordingFromS3,
  ensureRecordingLifecycleRule,
  purgeOldLocalRecordings,
};
