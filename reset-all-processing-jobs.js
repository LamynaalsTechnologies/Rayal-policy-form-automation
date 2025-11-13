const mongoose = require("mongoose");
require("dotenv").config();

async function resetAllProcessingJobs() {
  try {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/your-database";
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    const db = mongoose.connection.db;
    const jobQueueCollection = db.collection("RelianceJobQueue");

    // Find ALL processing jobs (regardless of age)
    const processingJobs = await jobQueueCollection.find({
      status: "processing"
    }).toArray();

    console.log(`\n📊 Found ${processingJobs.length} processing jobs\n`);

    if (processingJobs.length > 0) {
      console.log("Jobs to reset:");
      processingJobs.forEach((job, index) => {
        const company = job.formData?.Companyname || job.formData?.company || "reliance";
        console.log(`  ${index + 1}. ${job.formData?.firstName} - Company: ${company} - Started: ${job.startedAt}`);
      });

      const result = await jobQueueCollection.updateMany(
        {
          status: "processing"
        },
        {
          $set: {
            status: "pending",
            recoveredAt: new Date(),
          },
          $unset: {
            startedAt: ""
          }
        }
      );

      console.log(`\n✅ Reset ${result.modifiedCount} processing job(s) back to pending\n`);
    } else {
      console.log("✅ No processing jobs found");
    }

    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

resetAllProcessingJobs();
