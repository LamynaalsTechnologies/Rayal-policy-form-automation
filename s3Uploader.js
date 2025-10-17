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
};
