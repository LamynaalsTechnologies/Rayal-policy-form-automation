#!/usr/bin/env node

/**
 * Quick diagnostic script to check system state
 */

const mongoose = require("mongoose");
require("dotenv").config();

async function diagnoseSystem() {
  try {
    console.log("🔍 SYSTEM DIAGNOSTIC\n");
    
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ MongoDB connected\n");

    const db = mongoose.connection.db;
    const jobQueue = db.collection("RelianceJobQueue");

    // Count jobs by status
    const pending = await jobQueue.countDocuments({ status: "pending" });
    const processing = await jobQueue.countDocuments({ status: "processing" });
    const completed = await jobQueue.countDocuments({ status: "completed" });
    const failedLogin = await jobQueue.countDocuments({ status: "failed_login_form" });
    const failedPost = await jobQueue.countDocuments({ status: "failed_post_submission" });

    console.log("📊 JOB QUEUE STATUS:");
    console.log(`   Pending: ${pending}`);
    console.log(`   Processing: ${processing} ⚠️`);
    console.log(`   Completed: ${completed}`);
    console.log(`   Failed (Login): ${failedLogin}`);
    console.log(`   Failed (Post): ${failedPost}`);
    console.log();

    // Show processing jobs
    if (processing > 0) {
      const processingJobs = await jobQueue.find({ status: "processing" }).toArray();
      console.log("🔍 PROCESSING JOBS:");
      processingJobs.forEach((job, i) => {
        const company = job.formData?.Companyname || job.formData?.company || "reliance";
        const age = Date.now() - new Date(job.startedAt).getTime();
        console.log(`   ${i + 1}. ${job.formData.firstName} (${company}) - Running for ${Math.floor(age/1000)}s`);
      });
      console.log();
    }

    // Show next 3 pending jobs
    if (pending > 0) {
      const pendingJobs = await jobQueue.find({ status: "pending" })
        .sort({ createdAt: 1 })
        .limit(3)
        .toArray();
      
      console.log("📋 NEXT PENDING JOBS:");
      pendingJobs.forEach((job, i) => {
        const company = job.formData?.Companyname || job.formData?.company || "reliance";
        console.log(`   ${i + 1}. ${job.formData.firstName} (${company}) - ${job.attempts} attempts`);
      });
      console.log();
    }

    await mongoose.disconnect();
    console.log("✅ Diagnostic complete");
    process.exit(0);
    
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

diagnoseSystem();
