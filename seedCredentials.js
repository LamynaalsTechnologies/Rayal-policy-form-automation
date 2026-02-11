require("dotenv").config();
const mongoose = require("mongoose");
const { ProviderCredential } = require("./models");

async function seedCredentials() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected to MongoDB for seeding...");

    const relianceCreds = {
      provider: "reliance",
      username: "rfcpolicy",
      password: "Pass@123",
      loginUrl: "https://smartzone.reliancegeneral.co.in/Login/IMDLogin",
      dashboardUrl: "https://smartzone.reliancegeneral.co.in/",
    };

    const nationalCreds = {
      provider: "national",
      username: "9999839907",
      password: "Rayal$2025",
    };

    await ProviderCredential.findOneAndUpdate(
      { provider: "reliance" },
      relianceCreds,
      { upsert: true, new: true }
    );

    await ProviderCredential.findOneAndUpdate(
      { provider: "national" },
      nationalCreds,
      { upsert: true, new: true }
    );

    console.log("✅ Credentials seeded successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Seeding failed:", error);
    process.exit(1);
  }
}

seedCredentials();
