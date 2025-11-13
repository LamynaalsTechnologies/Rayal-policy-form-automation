const mongoose = require("mongoose");
const { ObjectId } = require('mongodb');
require("dotenv").config();

async function checkJobs() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB\n");

    const db = mongoose.connection.db;
    const jobQueue = db.collection("RelianceJobQueue");

    const jobIds = [
      "69159dd263c001403e17fdee",
      "69159dd2561c800acae5b957",
      "6915c9db7d58015403c484b2"
    ];

    console.log("🔍 Checking specific jobs:\n");

    for (const id of jobIds) {
      try {
        const job = await jobQueue.findOne({ _id: new ObjectId(id) });
        
        if (job) {
          console.log(`Job ${id}:`);
          console.log(`  Name: ${job.formData?.firstName}`);
          console.log(`  Status: ${job.status}`);
          console.log(`  Attempts: ${job.attempts}`);
          console.log(`  Started: ${job.startedAt}`);
          console.log();
        } else {
          console.log(`Job ${id}: NOT FOUND\n`);
        }
      } catch (err) {
        console.log(`Job ${id}: ERROR - ${err.message}\n`);
      }
    }

    // Also show current pending jobs
    const pendingJobs = await jobQueue.find({ status: "pending" })
      .sort({ createdAt: 1 })
      .limit(5)
      .toArray();

    console.log("📋 Current PENDING jobs:");
    pendingJobs.forEach((job, i) => {
      console.log(`  ${i + 1}. ${job._id} - ${job.formData?.firstName} - ${job.attempts} attempts`);
    });

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

checkJobs();
