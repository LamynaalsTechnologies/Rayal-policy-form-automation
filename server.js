const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { MongoClient } = require("mongodb");
const {
  getDriver,
  openNewTab,
  ensureLoggedIn,
  closeCurrentTab,
  ensureCleanState,
  createFreshDriverFromBaseProfile,
  createChromeDriver,
} = require("./browser");
const {
  initializeMasterSession,
  getSessionStatus,
  checkSession,
  reLoginIfNeeded,
} = require("./sessionManager");
const { captureAndLogError } = require("./errorLogger");
const { runFormFlow } = require("./formFlow");
const { fillRelianceForm } = require("./relianceForm");
const { extractCaptchaText } = require("./Captcha");
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const moment = require("moment");

mongoose.connect(process.env.MONGODB_URI);

const db = mongoose.connection;

// Persistent Queue System using MongoDB
let activeRelianceJobs = 0;
const MAX_PARALLEL_JOBS = 3; // Process 3 jobs in parallel using multiple tabs in same browser
let jobQueueCollection = null; // Will be initialized after DB connection

// Job statuses
const JOB_STATUS = {
  PENDING: "pending", // Waiting in queue
  PROCESSING: "processing", // Currently being processed
  COMPLETED: "completed", // Successfully completed
  FAILED: "failed", // Failed after processing
};

const enqueueRelianceJob = async (formData, captchaId = null) => {
  try {
    // Save job to MongoDB with pending status
    const job = {
      captchaId: captchaId, // Reference to original Captcha collection document
      formData,
      status: JOB_STATUS.PENDING,
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3, // Retry up to 3 times on failure
      lastError: null,
      errorLogs: [], // Initialize empty error logs array
    };

    const result = await jobQueueCollection.insertOne(job);
    console.log(
      `[Reliance Queue] Enqueued job for ${formData.firstName} (Job ID: ${result.insertedId}, Captcha ID: ${captchaId})`
    );

    // Try to process queue
    void processRelianceQueue();

    return result.insertedId;
  } catch (error) {
    console.error("[Reliance Queue] Failed to enqueue job:", error.message);
    throw error;
  }
};

const processRelianceQueue = async () => {
  if (!jobQueueCollection) return;

  try {
    // Count how many jobs are currently processing
    const processingCount = await jobQueueCollection.countDocuments({
      status: JOB_STATUS.PROCESSING,
    });

    activeRelianceJobs = processingCount;

    // Check if we can start more jobs
    if (activeRelianceJobs >= MAX_PARALLEL_JOBS) {
      return; // Already at max capacity
    }

    // Get pending jobs from database (oldest first)
    const availableSlots = MAX_PARALLEL_JOBS - activeRelianceJobs;
    const pendingJobs = await jobQueueCollection
      .find({ status: JOB_STATUS.PENDING })
      .sort({ createdAt: 1 })
      .limit(availableSlots)
      .toArray();

    if (pendingJobs.length === 0) {
      return; // No pending jobs
    }

    console.log(
      `[Reliance Queue] Found ${pendingJobs.length} pending jobs, starting processing...`
    );

    // Start processing each job
    for (const job of pendingJobs) {
      // Mark job as processing
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.PROCESSING,
            startedAt: new Date(),
          },
        }
      );

      activeRelianceJobs++;
      console.log(
        `[Reliance Queue] Starting job for ${job.formData.firstName} (ID: ${job._id}); active=${activeRelianceJobs}`
      );

      // Run job in parallel (don't await)
      runRelianceJob(job).finally(() => {
        activeRelianceJobs--;
        // Try to process more jobs
        void processRelianceQueue();
      });
    }
  } catch (error) {
    console.error("[Reliance Queue] Error processing queue:", error.message);
  }
};

const runRelianceJob = async (job) => {
  const jobIdentifier = `${job.formData.firstName}_${job._id}`;

  try {
    console.log(
      `[Reliance Queue] Processing form for: ${job.formData.firstName} ${job.formData.lastName}`
    );

    const result = await fillRelianceForm({
      username: "rfcpolicy",
      password: "Pass@123",
      ...job.formData,
      _jobId: job._id, // Pass job ID for error logging
      _jobIdentifier: jobIdentifier,
      _attemptNumber: job.attempts + 1, // Current attempt number
      _jobQueueCollection: jobQueueCollection, // Pass collection for logging
    });

    if (result && result.success) {
      // Mark as completed in database
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.COMPLETED,
            completedAt: new Date(),
            completedAttempt: job.attempts + 1,
          },
        }
      );
      console.log(
        `[Reliance Queue] ✅ Success for ${job.formData.firstName} (ID: ${job._id})`
      );
    } else {
      // Job failed - capture detailed error with screenshot
      const newAttemptCount = job.attempts + 1;

      // Create error log with screenshot (if driver available in result)
      const errorLog = {
        timestamp: new Date(),
        attemptNumber: newAttemptCount,
        errorMessage: result?.error || "Unknown error",
        errorType: "FormFillError",
        screenshotUrl: result?.screenshotUrl || null,
        screenshotKey: result?.screenshotKey || null,
      };

      // Add error to errorLogs array
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $inc: { attempts: 1 },
          $push: { errorLogs: errorLog },
          $set: {
            lastError: errorLog.errorMessage,
            lastErrorTimestamp: errorLog.timestamp,
            lastAttemptAt: new Date(),
          },
        }
      );

      const updatedJob = await jobQueueCollection.findOne({ _id: job._id });

      if (updatedJob.attempts >= updatedJob.maxAttempts) {
        // Max attempts reached, mark as failed
        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.FAILED,
              failedAt: new Date(),
              finalError: errorLog,
            },
          }
        );
        console.error(
          `[Reliance Queue] ❌ Failed permanently for ${job.formData.firstName} after ${updatedJob.attempts} attempts`
        );
        console.error(`   Last error: ${errorLog.errorMessage}`);
        if (errorLog.screenshotUrl) {
          console.error(`   Screenshot: ${errorLog.screenshotUrl}`);
        }
      } else {
        // Retry: reset to pending
        await jobQueueCollection.updateOne(
          { _id: job._id },
          {
            $set: {
              status: JOB_STATUS.PENDING,
              nextRetryAt: new Date(Date.now() + 60000),
            },
          }
        );
        console.warn(
          `[Reliance Queue] ⚠️ Failed for ${job.formData.firstName}, will retry (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`
        );
        if (errorLog.screenshotUrl) {
          console.warn(`   Screenshot: ${errorLog.screenshotUrl}`);
        }
      }
    }
  } catch (e) {
    console.error(
      `[Reliance Queue] ❌ Error for ${job.formData.firstName}:`,
      e.message
    );

    // Increment attempt and create error log
    const newAttemptCount = job.attempts + 1;

    const errorLog = {
      timestamp: new Date(),
      attemptNumber: newAttemptCount,
      errorMessage: e.message,
      errorStack: e.stack || null,
      errorType: e.name || "Error",
    };

    // Add error to errorLogs array
    await jobQueueCollection.updateOne(
      { _id: job._id },
      {
        $inc: { attempts: 1 },
        $push: { errorLogs: errorLog },
        $set: {
          lastError: e.message,
          lastErrorTimestamp: errorLog.timestamp,
          lastAttemptAt: new Date(),
        },
      }
    );

    const updatedJob = await jobQueueCollection.findOne({ _id: job._id });

    if (updatedJob.attempts >= updatedJob.maxAttempts) {
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.FAILED,
            failedAt: new Date(),
            finalError: errorLog,
          },
        }
      );
      console.error(
        `[Reliance Queue] ❌ Failed permanently after ${updatedJob.attempts} attempts`
      );
    } else {
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.PENDING,
            nextRetryAt: new Date(Date.now() + 60000),
          },
        }
      );
      console.warn(
        `[Reliance Queue] ⚠️ Will retry (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`
      );
    }
  }
};

db.on("error", console.error.bind(console, "connection error:"));
db.once("open", async () => {
  console.log("Connected to MongoDB");

  // Initialize job queue collection
  jobQueueCollection = db.collection("RelianceJobQueue");

  // Create indexes for better performance
  await jobQueueCollection.createIndex({ status: 1, createdAt: 1 });
  await jobQueueCollection.createIndex({ createdAt: 1 });
  await jobQueueCollection.createIndex({ captchaId: 1 }); // For job-status API lookups
  await jobQueueCollection.createIndex({ "errorLogs.timestamp": 1 }); // For error history queries

  console.log("[Job Queue] Initialized persistent job queue with indexes");

  // CRASH RECOVERY: Reset any jobs stuck in "processing" state back to "pending"
  // This happens when server crashes while processing jobs
  const stuckJobs = await jobQueueCollection.updateMany(
    { status: JOB_STATUS.PROCESSING },
    {
      $set: {
        status: JOB_STATUS.PENDING,
        recoveredAt: new Date(),
      },
    }
  );

  if (stuckJobs.modifiedCount > 0) {
    console.log(
      `[Job Queue] 🔄 Recovered ${stuckJobs.modifiedCount} jobs that were stuck in processing state`
    );
  }

  // Count pending jobs and start processing
  const pendingCount = await jobQueueCollection.countDocuments({
    status: JOB_STATUS.PENDING,
  });

  if (pendingCount > 0) {
    console.log(
      `[Job Queue] Found ${pendingCount} pending jobs, will start processing...`
    );
    void processRelianceQueue();
  }

  const collection = db.collection("Captcha");

  const changeStream = collection.watch([
    {
      $match: {
        operationType: "insert",
      },
    },
  ]);
  changeStream.on("change", async (change) => {
    // console.log(change);
    let data = change?.fullDocument;

    // Get the Captcha document _id for reference
    const captchaId = data?._id;

    let formData = {
      username: "2WDHAB",
      password: "ao533f@c",
      proposerTitle: data?.proposerTitle,
      firstName: data?.firstName,
      middleName: data?.middleName,
      lastName: data?.lastName,
      dob: data?.dateOfBirth
        ? moment(data?.dateOfBirth).format("DD-MM-YYYY")
        : "",
      fatherTitle: data?.fatherTitle,
      fatherFirstName: data?.fatherFirstName,
      flatNo: data?.flatDoorNo,
      floorNo: data?.flatDoorNo,
      premisesName: data?.buildingName,
      blockNo: data?.blockNo,
      road: data?.road,
      state: data?.state == "TAMILNADU" ? "30" : "26",
      pinCode: data?.pincode,
      mobile: data?.mobileNumber,
      email: data?.email,
      aadhar: data?.aadhar,
    };

    console.log(
      `[MongoDB Watch] New customer data received: ${formData.firstName} (Captcha ID: ${captchaId})`
    );

    // Add to queue with captchaId reference
    await enqueueRelianceJob(formData, captchaId);
  });
});

// Setup Express app for API routes
const app = express();

const storage = multer.memoryStorage();
const upload = multer({
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
  storage,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Captcha extraction endpoint
app.post("/api/extract-captcha", upload.single("image"), async (req, res) => {
  try {
    const imageBuffer = req.file.buffer;
    const imageBase64 = imageBuffer.toString("base64");
    const imageUrl = `data:image/jpeg;base64,${imageBase64}`;
    const result = await extractCaptchaText(imageUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ============================================
// JOB STATUS API ENDPOINTS
// ============================================

/**
 * GET /api/job-status/:captchaId
 * Get job status and details by Captcha ID
 *
 * Returns:
 * - Job status (pending/processing/completed/failed)
 * - Attempt count
 * - Error logs with screenshots
 * - Timestamps
 */
app.get("/api/job-status/:captchaId", async (req, res) => {
  try {
    const { captchaId } = req.params;

    // Validate captchaId format
    if (!captchaId || captchaId.length !== 24) {
      return res.status(400).json({
        success: false,
        message: "Invalid captcha ID format",
      });
    }

    // Convert to MongoDB ObjectId
    const ObjectId = require("mongodb").ObjectId;
    const captchaObjectId = new ObjectId(captchaId);

    // Find job by captchaId reference
    const job = await jobQueueCollection.findOne({
      captchaId: captchaObjectId,
    });

    if (!job) {
      return res.status(404).json({
        success: false,
        message: "Job not found for this captcha ID",
        captchaId: captchaId,
      });
    }

    // Prepare response data
    const responseData = {
      // IDs
      captchaId: captchaId,
      jobId: job._id.toString(),

      // Status
      status: job.status,

      // Progress
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      currentAttempt: job.attempts,
      retriesLeft: Math.max(0, job.maxAttempts - job.attempts),

      // Error information
      hasErrors: (job.errorLogs && job.errorLogs.length > 0) || false,
      errorCount: job.errorLogs ? job.errorLogs.length : 0,
      errorLogs: job.errorLogs || [],
      lastError: job.lastError || null,
      lastErrorTimestamp: job.lastErrorTimestamp || null,
      finalError: job.finalError || null,

      // Special errors
      lastPostSubmissionError: job.lastPostSubmissionError || null,
      lastModalError: job.lastModalError || null,

      // Screenshots
      screenshotUrls: job.errorLogs
        ? job.errorLogs.map((e) => e.screenshotUrl).filter(Boolean)
        : [],

      // Timestamps
      createdAt: job.createdAt,
      startedAt: job.startedAt || null,
      completedAt: job.completedAt || null,
      failedAt: job.failedAt || null,
      lastAttemptAt: job.lastAttemptAt || null,
      nextRetryAt: job.nextRetryAt || null,

      // Form data (customer info)
      customerData: {
        firstName: job.formData?.firstName,
        lastName: job.formData?.lastName,
        mobile: job.formData?.mobile,
        email: job.formData?.email,
      },
    };

    return res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("[API] Error fetching job status:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

/**
 * GET /api/jobs
 * Get list of jobs with optional filtering
 *
 * Query parameters:
 * - status: Filter by status (pending/processing/completed/failed)
 * - limit: Number of results (default: 50, max: 100)
 * - skip: Number to skip for pagination (default: 0)
 * - sortBy: Sort field (default: createdAt)
 * - sortOrder: asc or desc (default: desc)
 *
 * Examples:
 * - GET /api/jobs?status=failed
 * - GET /api/jobs?status=completed&limit=20
 * - GET /api/jobs?limit=10&skip=10
 */
app.get("/api/jobs", async (req, res) => {
  try {
    const {
      status,
      limit = 50,
      skip = 0,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    // Build filter
    const filter = {};
    if (status) {
      // Validate status
      const validStatuses = ["pending", "processing", "completed", "failed"];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${validStatuses.join(
            ", "
          )}`,
        });
      }
      filter.status = status;
    }

    // Validate and sanitize pagination
    const limitNum = Math.min(parseInt(limit) || 50, 100); // Max 100
    const skipNum = Math.max(parseInt(skip) || 0, 0); // Min 0

    // Build sort
    const sortField = sortBy || "createdAt";
    const sortDirection = sortOrder === "asc" ? 1 : -1;
    const sort = { [sortField]: sortDirection };

    // Query jobs
    const jobs = await jobQueueCollection
      .find(filter)
      .sort(sort)
      .limit(limitNum)
      .skip(skipNum)
      .toArray();

    // Get total count for pagination
    const totalCount = await jobQueueCollection.countDocuments(filter);

    // Format response
    const formattedJobs = jobs.map((job) => ({
      jobId: job._id.toString(),
      captchaId: job.captchaId ? job.captchaId.toString() : null,
      status: job.status,
      attempts: job.attempts,
      customerName: `${job.formData?.firstName || ""} ${
        job.formData?.lastName || ""
      }`.trim(),
      mobile: job.formData?.mobile,
      hasErrors: job.errorLogs && job.errorLogs.length > 0,
      errorCount: job.errorLogs ? job.errorLogs.length : 0,
      lastError: job.lastError,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
    }));

    return res.json({
      success: true,
      data: formattedJobs,
      pagination: {
        total: totalCount,
        limit: limitNum,
        skip: skipNum,
        returned: formattedJobs.length,
        hasMore: skipNum + limitNum < totalCount,
        nextSkip: skipNum + limitNum < totalCount ? skipNum + limitNum : null,
      },
      filter: filter,
    });
  } catch (error) {
    console.error("[API] Error fetching jobs:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

/**
 * GET /api/jobs/stats
 * Get job statistics
 *
 * Returns:
 * - Total jobs by status
 * - Success rate
 * - Average attempts
 * - Recent failures
 */
app.get("/api/jobs/stats", async (req, res) => {
  try {
    const stats = await jobQueueCollection
      .aggregate([
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            avgAttempts: { $avg: "$attempts" },
          },
        },
      ])
      .toArray();

    // Format statistics
    const statusCounts = {};
    stats.forEach((stat) => {
      statusCounts[stat._id] = {
        count: stat.count,
        avgAttempts: Math.round(stat.avgAttempts * 100) / 100,
      };
    });

    // Calculate totals
    const totalJobs = stats.reduce((sum, stat) => sum + stat.count, 0);
    const completedCount = statusCounts.completed?.count || 0;
    const failedCount = statusCounts.failed?.count || 0;
    const successRate =
      totalJobs > 0 ? Math.round((completedCount / totalJobs) * 100) : 0;

    return res.json({
      success: true,
      data: {
        total: totalJobs,
        byStatus: statusCounts,
        successRate: `${successRate}%`,
        metrics: {
          completed: completedCount,
          failed: failedCount,
          pending: statusCounts.pending?.count || 0,
          processing: statusCounts.processing?.count || 0,
        },
      },
    });
  } catch (error) {
    console.error("[API] Error fetching stats:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
});

// Create HTTP server with integrated Express app
const server = http.createServer((req, res) => {
  // Try Express routes first (for /api/* endpoints)
  if (req.url.startsWith("/api/")) {
    app(req, res);
    return;
  }

  // Serve the Vite app
  let filePath = path.join(
    __dirname,
    "vite-app",
    "dist",
    req.url === "/" ? "index.html" : req.url
  );
  const extname = path.extname(filePath);
  let contentType = "text/html";

  switch (extname) {
    case ".js":
      contentType = "text/javascript";
      break;
    case ".css":
      contentType = "text/css";
      break;
    case ".json":
      contentType = "application/json";
      break;
    case ".png":
      contentType = "image/png";
      break;
    case ".jpg":
      contentType = "image/jpg";
      break;
    case ".wav":
      contentType = "audio/wav";
      break;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code == "ENOENT") {
        fs.readFile(
          path.join(__dirname, "vite-app", "dist", "index.html"),
          (err, content) => {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(content, "utf-8");
          }
        );
      } else {
        res.writeHead(500);
        res.end(
          "Sorry, check with the site admin for error: " + err.code + "..\n"
        );
        res.end();
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});

const io = new Server(server);

const url =
  "mongodb+srv://karthikeyanthavamani86:karthi123@cluster0.zqxsu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(url);
const dbName = "selenium-form-filler";

async function main() {
  await client.connect();
  console.log("Connected successfully to MongoDB");
  const db = client.db(dbName);
  const collection = db.collection("data");
  const portalLoginUrl =
    "https://smartzone.reliancegeneral.co.in/Login/IMDLogin";
  const portalHomeUrl = "https://www.uiic.in/GCWebPortal/login/HomeAction.do";

  // Job queue with unbounded parallel jobs using TABS on a single driver
  const jobQueue = [];
  let activeJobs = 0;

  const enqueueJob = (job) => {
    jobQueue.push(job);
    console.log(
      `[queue] Enqueued job amount=%s; queued=%d active=%d`,
      job.amount,
      jobQueue.length,
      activeJobs
    );
    void processQueue();
  };

  const processQueue = async () => {
    // Start all queued jobs immediately (be mindful of CPU/RAM usage)
    while (jobQueue.length > 0) {
      const job = jobQueue.shift();
      activeJobs++;
      console.log(
        `[queue] Starting job amount=%s; active=%d queued=%d`,
        job.amount,
        activeJobs,
        jobQueue.length
      );

      // Run job in parallel (don't await)
      runJob(job).finally(() => {
        activeJobs--;
        console.log(
          `[queue] Job completed amount=%s; active=%d queued=%d`,
          job.amount,
          activeJobs,
          jobQueue.length
        );
        // Process more jobs if capacity available
        void processQueue();
      });
    }
  };

  const runJob = async (job) => {
    const { amount, socketId } = job;
    const socket = io.sockets.sockets.get(socketId);
    const baseProfileDir = path.join(__dirname, "chrome-profile");
    let driver = null;
    let tempProfileDir = null;
    try {
      // Create a fresh Chrome/WebDriver per job by cloning base profile (preserves login)
      const created = await createFreshDriverFromBaseProfile(baseProfileDir);
      driver = created.driver;
      tempProfileDir = created.profileDir;

      // Navigate and ensure login inside this independent browser
      await driver.get("https://www.uiic.in/GCWebPortal/login/HomeAction.do");
      await ensureLoggedIn(driver, 15000);

      // Run the form flow with timeout guard
      const formFlowPromise = runFormFlow(driver, amount);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Form flow timeout after 2 minutes")),
          120000
        )
      );
      await Promise.race([formFlowPromise, timeoutPromise]);

      if (socket) socket.emit("autofill:success", { amount });
    } catch (e) {
      console.error("[queue] Job failed:", e);
      if (socket)
        socket.emit("autofill:error", {
          amount,
          error: String((e && e.message) || e),
        });
    } finally {
      // Cleanup this job's driver and temp profile
      try {
        if (driver) await driver.quit();
      } catch {}
      if (tempProfileDir) {
        try {
          await deleteDirectoryRecursive(tempProfileDir);
        } catch {}
      }
    }
  };

  async function deleteDirectoryRecursive(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          await deleteDirectoryRecursive(fullPath);
        } else {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
    try {
      fs.rmdirSync(dirPath);
    } catch {}
  }

  io.on("connection", async (socket) => {
    console.log("a user connected");

    socket.on("autofill", async (data) => {
      console.log(
        "received autofill request with amount: %s company: %s",
        data && data.amount,
        data && data.company
      );
      try {
        if (
          !data ||
          (typeof data.amount !== "string" && typeof data.amount !== "number")
        ) {
          socket.emit("autofill:error", { error: "Invalid amount" });
          return;
        }
        const amount = String(data.amount);
        const company = data.company || "united-india";

        // Persist request
        await collection.insertOne({ amount, company, createdAt: new Date() });
        io.emit("data", { amount, company });

        // Route based on company
        if (company === "reliance") {
          console.log(
            "[server] Handling Reliance request - dispatching to relianceForm.fillRelianceForm"
          );
          // Run the reliance flow asynchronously and notify the client
          (async () => {
            try {
              const result = await fillRelianceForm({
                amount,
                socketId: socket.id,
              });
              if (result && result.success) {
                socket.emit("autofill:success", {
                  amount,
                  company: "reliance",
                });
              } else {
                socket.emit("autofill:error", {
                  amount,
                  company: "reliance",
                  error: (result && result.error) || "Unknown error",
                });
              }
            } catch (e) {
              console.error("[server] Reliance flow failed:", e);
              socket.emit("autofill:error", {
                amount,
                company: "reliance",
                error: String((e && e.message) || e),
              });
            }
          })();
        } else {
          // United India (default) - enqueue existing job flow
          enqueueJob({ amount, socketId: socket.id });
        }
      } catch (e) {
        console.error("Failed to handle autofill enqueue:", e);
        socket.emit("autofill:error", { error: String((e && e.message) || e) });
      }
    });

    socket.on("disconnect", () => {
      console.log("user disconnected");
    });
  });

  server.listen(8800, async () => {
    console.log("Server started on http://localhost:8800");

    // ============================================
    // INITIALIZE MASTER SESSION
    // ============================================
    try {
      console.log("\n" + "=".repeat(60));
      console.log("  🚀 INITIALIZING RELIANCE AUTOMATION");
      console.log("=".repeat(60) + "\n");

      await initializeMasterSession();

      console.log("\n" + "=".repeat(60));
      console.log("  ✅ READY TO PROCESS JOBS");
      console.log("=".repeat(60));
      console.log(
        "📊 Session Status:",
        JSON.stringify(getSessionStatus(), null, 2)
      );
      console.log("=".repeat(60) + "\n");
    } catch (e) {
      console.error("\n❌ Failed to initialize master session:", e.message);
      console.error("⚠️  Jobs may require manual login\n");
    }
  });
}

main().catch(console.error);
