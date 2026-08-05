const mongoose = require("mongoose");

const ProviderCredentialSchema = new mongoose.Schema({
  // The record this login belongs to — a `user` _id or a `client` _id. This is
  // what the queue matches on (see server.js), because clientId below is
  // shared by every user under the same client.
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  // The owning client: a user's parent client, or a client's own _id.
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  provider: {
    type: String,
    required: true,
    // Must match the insurer names the app stores (lowercased by
    // syncProviderCredentials). Keep in step with PROVIDER_COMPANIES in the
    // frontend's Shared/CommonConstant.js.
    enum: ["reliance", "national", "kshema"],
  },
  username: {
    type: String,
    required: true,
  },
  password: {
    type: String,
    required: true,
  },
  loginUrl: {
    type: String,
  },
  dashboardUrl: {
    type: String,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  lastUsedAt: {
    type: Date,
  },
},{timestamps:true});

// Keep in step with RayalBrokers-backend/Model/ProviderCredential.js, which
// owns the migration note for dropping the old provider_1_clientId_1 index.
ProviderCredentialSchema.index({ provider: 1, userId: 1 }, { unique: true });
ProviderCredentialSchema.index({ provider: 1, clientId: 1 });

ProviderCredentialSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("ProviderCredential", ProviderCredentialSchema);
