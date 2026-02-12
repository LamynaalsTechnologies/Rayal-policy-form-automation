const mongoose = require("mongoose");

const ProviderCredentialSchema = new mongoose.Schema({
   userId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  provider: {
    type: String,
    required: true,
    enum: ["reliance", "national"],
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

ProviderCredentialSchema.index({ provider: 1, clientId: 1 }, { unique: true });

ProviderCredentialSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("ProviderCredential", ProviderCredentialSchema);
