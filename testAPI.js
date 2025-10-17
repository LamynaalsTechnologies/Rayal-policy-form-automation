/**
 * API Test Script
 *
 * Tests the Job Status API endpoints
 *
 * Usage: node testAPI.js
 */

const http = require("http");

const BASE_URL = "http://localhost:8800/api";

// Helper function to make HTTP requests
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ data: JSON.parse(data), status: res.statusCode });
          } catch (e) {
            reject(new Error("Invalid JSON response"));
          }
        });
      })
      .on("error", reject);
  });
}

// Colors for console output
const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
};

function log(color, message) {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testAPI() {
  console.log("\n" + "=".repeat(60));
  console.log("  API ENDPOINT TESTS");
  console.log("=".repeat(60) + "\n");

  try {
    // Test 1: Get Job Statistics
    console.log("📊 Test 1: GET /api/jobs/stats");
    console.log("-".repeat(60));

    const statsResponse = await httpGet(`${BASE_URL}/jobs/stats`);

    if (statsResponse.data.success) {
      log("green", "✅ Stats endpoint working!");
      console.log("Total Jobs:", statsResponse.data.data.total);
      console.log("Success Rate:", statsResponse.data.data.successRate);
      console.log(
        "By Status:",
        JSON.stringify(statsResponse.data.data.byStatus, null, 2)
      );
    } else {
      log("red", "❌ Stats endpoint failed");
    }

    console.log("\n");

    // Test 2: Get All Jobs (limited to 5)
    console.log("📋 Test 2: GET /api/jobs?limit=5");
    console.log("-".repeat(60));

    const jobsResponse = await httpGet(`${BASE_URL}/jobs?limit=5`);

    if (jobsResponse.data.success) {
      log("green", "✅ Jobs list endpoint working!");
      console.log("Total Jobs:", jobsResponse.data.pagination.total);
      console.log("Returned:", jobsResponse.data.pagination.returned);
      console.log("Has More:", jobsResponse.data.pagination.hasMore);

      console.log("\nJobs:");
      jobsResponse.data.data.forEach((job, index) => {
        console.log(
          `  ${index + 1}. ${job.customerName} - Status: ${
            job.status
          } - Attempts: ${job.attempts}`
        );
      });

      // Store first job for detailed test
      if (jobsResponse.data.data.length > 0) {
        const firstJob = jobsResponse.data.data[0];

        console.log("\n");

        // Test 3: Get Job Status by Captcha ID
        if (firstJob.captchaId) {
          console.log(`🔍 Test 3: GET /api/job-status/${firstJob.captchaId}`);
          console.log("-".repeat(60));

          const statusResponse = await httpGet(
            `${BASE_URL}/job-status/${firstJob.captchaId}`
          );

          if (statusResponse.data.success) {
            log("green", "✅ Job status endpoint working!");
            const jobData = statusResponse.data.data;
            console.log(
              "Customer:",
              `${jobData.customerData.firstName} ${jobData.customerData.lastName}`
            );
            console.log("Status:", jobData.status);
            console.log(
              "Attempts:",
              `${jobData.attempts}/${jobData.maxAttempts}`
            );
            console.log("Retries Left:", jobData.retriesLeft);
            console.log("Has Errors:", jobData.hasErrors);
            console.log("Error Count:", jobData.errorCount);

            if (jobData.hasErrors) {
              console.log("\nError Logs:");
              jobData.errorLogs.forEach((error, index) => {
                console.log(`  Attempt ${error.attemptNumber}:`);
                console.log(`    Time: ${error.timestamp}`);
                console.log(`    Error: ${error.errorMessage}`);
                console.log(`    Type: ${error.errorType}`);
                if (error.screenshotUrl) {
                  console.log(`    Screenshot: ${error.screenshotUrl}`);
                }
              });

              console.log("\nAll Screenshots:");
              jobData.screenshotUrls.forEach((url, index) => {
                console.log(`  ${index + 1}. ${url}`);
              });
            }
          } else {
            log("red", "❌ Job status endpoint failed");
          }
        } else {
          log("yellow", "⚠️  No captchaId found for test 3, skipping");
        }
      }
    } else {
      log("red", "❌ Jobs list endpoint failed");
    }

    console.log("\n");

    // Test 4: Get Failed Jobs
    console.log("❌ Test 4: GET /api/jobs?status=failed&limit=3");
    console.log("-".repeat(60));

    const failedJobsResponse = await httpGet(
      `${BASE_URL}/jobs?status=failed&limit=3`
    );

    if (failedJobsResponse.data.success) {
      log("green", "✅ Failed jobs filter working!");
      console.log(
        "Failed Jobs Count:",
        failedJobsResponse.data.pagination.total
      );

      if (failedJobsResponse.data.data.length > 0) {
        console.log("\nRecent Failures:");
        failedJobsResponse.data.data.forEach((job, index) => {
          console.log(`  ${index + 1}. ${job.customerName}`);
          console.log(`     Error: ${job.lastError}`);
          console.log(`     Attempts: ${job.attempts}`);
        });
      } else {
        log("blue", "  No failed jobs found (that's good!)");
      }
    } else {
      log("red", "❌ Failed jobs filter not working");
    }

    console.log("\n");

    // Test 5: Get Completed Jobs
    console.log("✅ Test 5: GET /api/jobs?status=completed&limit=3");
    console.log("-".repeat(60));

    const completedJobsResponse = await httpGet(
      `${BASE_URL}/jobs?status=completed&limit=3`
    );

    if (completedJobsResponse.data.success) {
      log("green", "✅ Completed jobs filter working!");
      console.log(
        "Completed Jobs Count:",
        completedJobsResponse.data.pagination.total
      );

      if (completedJobsResponse.data.data.length > 0) {
        console.log("\nRecent Successes:");
        completedJobsResponse.data.data.forEach((job, index) => {
          console.log(
            `  ${index + 1}. ${job.customerName} - Completed at: ${
              job.completedAt
            }`
          );
        });
      }
    } else {
      log("red", "❌ Completed jobs filter not working");
    }

    console.log("\n" + "=".repeat(60));
    console.log("  ALL TESTS COMPLETED");
    console.log("=".repeat(60) + "\n");
  } catch (error) {
    log("red", `\n❌ Test Error: ${error.message}`);

    if (error.code === "ECONNREFUSED") {
      log(
        "yellow",
        "\n⚠️  Server not running! Start server with: node server.js"
      );
    } else if (error.response) {
      console.log("Response Status:", error.response.status);
      console.log(
        "Response Data:",
        JSON.stringify(error.response.data, null, 2)
      );
    }

    process.exit(1);
  }
}

// Run tests
console.log("\n🚀 Starting API tests...\n");
testAPI()
  .then(() => {
    log("green", "\n✅ All tests passed!\n");
    process.exit(0);
  })
  .catch((err) => {
    log("red", `\n❌ Tests failed: ${err.message}\n`);
    process.exit(1);
  });
