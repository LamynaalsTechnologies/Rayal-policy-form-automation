const mongoose = require("mongoose");
require("dotenv").config();

async function resetStuckJobs() {
  try {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/your-database";
    await mongoose.connect(mongoUri);
    console.log("✅ Connected to MongoDB");

    const db = mongoose.connection.db;
    const jobQueueCollection = db.collection("RelianceJobQueue");

    // Find all processing jobs that started more than 10 minutes ago
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    
    const stuckJobs = await jobQueueCollection.find({
      status: "processing",
      $or: [
        { startedAt: { $lt: tenMinutesAgo } },
        { startedAt: { $exists: false } }
      ]
    }).toArray();

    console.log(`\n📊 Found ${stuckJobs.length} stuck processing jobs\n`);

    if (stuckJobs.length > 0) {
      const result = await jobQueueCollection.updateMany(
        {
          status: "processing",
          $or: [
            { startedAt: { $lt: tenMinutesAgo } },
            { startedAt: { $exists: false } }
          ]
        },
        {
          $set: {
            status: "pending",
            recoveredAt: new Date(),
          },
          $inc: { attempts: 0 } // Don't increment attempts, just reset
        }
      );

      console.log(`✅ Reset ${result.modifiedCount} stuck job(s) back to pending`);
    } else {
      console.log("✅ No stuck jobs found");
    }

    await mongoose.disconnect();
    console.log("\n✅ Disconnected from MongoDB");
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

resetStuckJobs();

