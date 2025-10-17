# Environment Variables Setup Guide 🔧

## Current Error

You're seeing:

```
❌ Screenshot upload failed: Missing credentials in config
```

This is because AWS S3 credentials are not configured yet.

---

## Solution Options

### **Option 1: Setup AWS S3 (Recommended)** ✅

#### Step 1: Create .env file

Create a file named `.env` in your project root:

```bash
# MongoDB Configuration
MONGODB_URI=mongodb+srv://karthikeyanthavamani86:karthi123@cluster0.zqxsu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0

# OpenAI Configuration (for captcha extraction)
OPENAI_API_KEY=your-openai-key-here

# AWS S3 Configuration
AWS_ACCESS_KEY_ID=AKIA...your-key...
AWS_SECRET_ACCESS_KEY=your-secret-key-here
AWS_REGION=us-east-1
S3_BUCKET_NAME=reliance-form-screenshots
```

#### Step 2: Get AWS Credentials

**Quick way:**

1. Go to: https://console.aws.amazon.com/iam/
2. Click "Users" → "Create user"
3. Username: `reliance-automation`
4. Click "Next"
5. Attach policy: `AmazonS3FullAccess`
6. Click "Create user"
7. Click "Security credentials" tab
8. Click "Create access key"
9. Choose "Application running outside AWS"
10. Copy Access Key ID and Secret Access Key
11. Add to `.env` file

#### Step 3: Create S3 Bucket

```bash
aws s3 mb s3://reliance-form-screenshots --region us-east-1
```

Or via AWS Console:

1. Go to: https://s3.console.aws.amazon.com
2. Click "Create bucket"
3. Bucket name: `reliance-form-screenshots`
4. Region: `us-east-1`
5. Keep defaults
6. Click "Create bucket"

#### Step 4: Restart Server

```bash
# Stop server (Ctrl+C)
# Start again
node server.js
```

✅ S3 uploads will now work!

---

### **Option 2: Disable S3 Temporarily** ⚠️

If you don't want to setup S3 right now, I can make screenshots save locally instead.

---

## Which Option Do You Want?

**Option 1:** Setup AWS S3 (10 minutes, cloud storage) ⭐ **Recommended**

**Option 2:** Disable S3, use local storage (1 minute, temporary)

Let me know and I'll help you implement it!

---

## Why Option 1 is Better

| Feature         | Local Storage   | S3 Storage   |
| --------------- | --------------- | ------------ |
| **Access**      | Only on server  | Anywhere     |
| **Retention**   | Manual cleanup  | Automatic    |
| **Sharing**     | Difficult       | Easy (URL)   |
| **Backup**      | None            | Automatic    |
| **Scalability** | Limited by disk | Unlimited    |
| **Cost**        | Free            | ~$0.01/month |

---

## Current Status

Your system is working but:

- ✅ Form filling works
- ✅ Error detection works
- ✅ Screenshot capture works
- ✅ MongoDB logging works
- ❌ S3 upload fails (missing credentials)

**Quick fix:** Just add AWS credentials to `.env` file!
