/**
 * Standalone KSHEMA login tester.
 *
 *   node testKshemaLogin.js                     # any active kshema credential
 *   node testKshemaLogin.js <userId>            # that user's credential
 *   node testKshemaLogin.js <userId> <clientId> # user first, then client
 *
 * Resolves credentials with the SAME order the queue uses (the policy's user's
 * own portal login first, the client's second) so what you test here is what a
 * real job will do. Then opens the portal, fills the credentials in and leaves
 * the window open — the process stays alive on purpose, Ctrl+C to finish.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { ProviderCredential } = require("./models");
const { fillKshemaForm } = require("./fullPolicycompany/kshemaForm");

const PROVIDER = "kshema";

async function main() {
  const [userId, clientId] = process.argv.slice(2);

  if (!process.env.MONGODB_URI) {
    console.error("❌ MONGODB_URI is not set in .env");
    process.exit(1);
  }

  console.log("→ Connecting to MongoDB...");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("✓ Connected\n");

  let creds = null;
  let source = null;

  if (userId) {
    creds = await ProviderCredential.findOne({
      provider: PROVIDER,
      clientId: userId,
      isActive: true,
    });
    if (creds) source = `user ${userId}`;
  }

  if (!creds && clientId) {
    creds = await ProviderCredential.findOne({
      provider: PROVIDER,
      clientId: clientId,
      isActive: true,
    });
    if (creds) source = `client ${clientId}`;
  }

  // Only when no ids were given at all — a convenience for a quick smoke test,
  // NOT something the real queue does (it never borrows another client's login).
  if (!creds && !userId && !clientId) {
    creds = await ProviderCredential.findOne({
      provider: PROVIDER,
      isActive: true,
    });
    if (creds) source = `first active kshema credential (no ids given)`;
  }

  if (!creds) {
    console.error(
      `\n❌ No active KSHEMA credential found` +
      (userId ? ` for user ${userId}` : "") +
      (clientId ? ` or client ${clientId}` : "") +
      `.\n\n   Add the KSHEMA login in the app first:\n` +
      `     • User page → edit the user → Credentials → add KSHEMA, or\n` +
      `     • Profile → Account & Policy Settings → add KSHEMA\n` +
      `   Saving there syncs it into the ProviderCredential collection.\n`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`✓ Using credential from ${source}`);
  console.log(`  username: ${creds.username}`);
  console.log(`  loginUrl: ${creds.loginUrl || "(none stored — using the built-in default)"}\n`);

  const result = await fillKshemaForm({
    firstName: "TEST",
    username: creds.username,
    password: creds.password,
    loginUrl: creds.loginUrl,
  });

  console.log("\n──────── RESULT ────────");
  // _jobBrowser holds a live WebDriver; printing it would dump the whole
  // session object over the console.
  const { _jobBrowser, ...printable } = result;
  console.log(JSON.stringify(printable, null, 2));

  if (result.browserLeftOpen) {
    console.log(
      "\n🔍 The browser is still open. Look at the login page, click Login by " +
      "hand, and note what comes next (captcha? OTP? straight to a dashboard?)."
    );
    console.log("   Press Ctrl+C here when you are done.\n");
    // Hold the process open — quitting node would take the window with it.
    setInterval(() => { }, 1 << 30);
  } else {
    await mongoose.disconnect();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("\n❌ Test failed:", err);
  try {
    await mongoose.disconnect();
  } catch (e) { }
  process.exit(1);
});
