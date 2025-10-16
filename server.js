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
} = require("./browser");
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
const MAX_PARALLEL_JOBS = 3; // Control how many browsers can run at once
let jobQueueCollection = null; // Will be initialized after DB connection

// Job statuses
const JOB_STATUS = {
  PENDING: "pending", // Waiting in queue
  PROCESSING: "processing", // Currently being processed
  COMPLETED: "completed", // Successfully completed
  FAILED: "failed", // Failed after processing
};

const enqueueRelianceJob = async (formData) => {
  try {
    // Save job to MongoDB with pending status
    const job = {
      formData,
      status: JOB_STATUS.PENDING,
      createdAt: new Date(),
      attempts: 0,
      maxAttempts: 3, // Retry up to 3 times on failure
      lastError: null,
    };

    const result = await jobQueueCollection.insertOne(job);
    console.log(
      `[Reliance Queue] Enqueued job for ${formData.firstName} (ID: ${result.insertedId})`
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
  try {
    console.log(
      `[Reliance Queue] Processing form for: ${job.formData.firstName} ${job.formData.lastName}`
    );

    const result = await fillRelianceForm({
      username: "2WDHAB",
      password: "ao533f@c",
      ...job.formData,
    });

    if (result && result.success) {
      // Mark as completed in database
      await jobQueueCollection.updateOne(
        { _id: job._id },
        {
          $set: {
            status: JOB_STATUS.COMPLETED,
            completedAt: new Date(),
          },
        }
      );
      console.log(
        `[Reliance Queue] ✅ Success for ${job.formData.firstName} (ID: ${job._id})`
      );
    } else {
      // Increment attempts and check if we should retry
      const updatedJob = await jobQueueCollection.findOneAndUpdate(
        { _id: job._id },
        {
          $inc: { attempts: 1 },
          $set: {
            lastError: result?.error || "Unknown error",
            lastAttemptAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      if (updatedJob.attempts >= updatedJob.maxAttempts) {
        // Max attempts reached, mark as failed
        await jobQueueCollection.updateOne(
          { _id: job._id },
          { $set: { status: JOB_STATUS.FAILED, failedAt: new Date() } }
        );
        console.error(
          `[Reliance Queue] ❌ Failed permanently for ${job.formData.firstName} after ${updatedJob.attempts} attempts`
        );
      } else {
        // Retry: reset to pending
        await jobQueueCollection.updateOne(
          { _id: job._id },
          { $set: { status: JOB_STATUS.PENDING } }
        );
        console.warn(
          `[Reliance Queue] ⚠️ Failed for ${job.formData.firstName}, will retry (attempt ${updatedJob.attempts}/${updatedJob.maxAttempts})`
        );
      }
    }
  } catch (e) {
    console.error(
      `[Reliance Queue] ❌ Error for ${job.formData.firstName}:`,
      e.message
    );

    // Handle error same as failure above
    const updatedJob = await jobQueueCollection.findOneAndUpdate(
      { _id: job._id },
      {
        $inc: { attempts: 1 },
        $set: {
          lastError: e.message,
          lastAttemptAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (updatedJob.attempts >= updatedJob.maxAttempts) {
      await jobQueueCollection.updateOne(
        { _id: job._id },
        { $set: { status: JOB_STATUS.FAILED, failedAt: new Date() } }
      );
    } else {
      await jobQueueCollection.updateOne(
        { _id: job._id },
        { $set: { status: JOB_STATUS.PENDING } }
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

  console.log("[Job Queue] Initialized persistent job queue");

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
    let formData = {
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
    console.log("[MongoDB Watch] New customer data received:", formData);

    // Instead of calling fillRelianceForm directly, add to queue
    await enqueueRelianceJob(formData);
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
    // On first start, open the portal login for manual authentication
    try {
      const driver = await getDriver();
      await driver.get(portalLoginUrl);
      console.log("Opened portal login page for manual login.");
    } catch (e) {
      console.error("Failed to open portal login on startup:", e);
    }
  });
}

main().catch(console.error);
