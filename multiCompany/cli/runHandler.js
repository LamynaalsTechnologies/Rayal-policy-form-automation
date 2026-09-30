/**
 * Standalone runner for ANY multiCompany handler — bypasses the job queue,
 * MongoDB and server.js entirely. Use it to test one insurer's login (and
 * whatever its handler does after it) against the real portal.
 *
 * Run from the Rayal-policy-form-automation directory:
 *   node multiCompany/cli/runHandler.js --company reliance --type od -u USER -p PASS
 *   node multiCompany/cli/runHandler.js --company national --type tp -u USER -p PASS --loginUrl https://...
 *   node multiCompany/cli/runHandler.js --company kshema   --type od -u EMAIL -p PASS
 *
 * A deliberately WRONG password is the way to check invalid-credential handling:
 * the result should come back errorCode "E203", retryable false, with the
 * portal's own message in it.
 */

// Dev convenience only, and must run BEFORE the require below —
// featureGate.js reads this once, at require time. Does not touch the
// shared .env file; only this process sees the feature as enabled.
process.env.MULTI_COMPANY_AUTOMATION_ENABLED = "true";

const { resolveMultiCompanyHandler, registry } = require("../registry");

const defaultFormData = {
  username: "",
  password: "",
  vehicleMake: "TVS",
  vehicleModel: "Scooty Zest",
};

const USAGE = `
multiCompany handler — standalone test runner

Usage: node multiCompany/cli/runHandler.js --company <c> --type <od|tp> [options]

Options:
  --company <reliance|national|kshema>   Which insurer (required)
  --type <od|tp>                         Which handler (required)
  -u, --username <value>                 Portal username
  -p, --password <value>                 Portal password
  --loginUrl <value>                     Login URL (National has no built-in default)
  --vehicleMake <value>                  Vehicle make (default: TVS)
  --vehicleModel <value>                 Vehicle model (default: Scooty Zest)
  -h, --help                             Show this help message
`;

function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  const formData = { ...defaultFormData };
  const options = { company: "", type: "" };

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];

    switch (key) {
      case "--company":
        options.company = String(value || "").toLowerCase();
        break;
      case "--type":
        options.type = String(value || "").toLowerCase();
        break;
      case "--username":
      case "-u":
        formData.username = value;
        break;
      case "--password":
      case "-p":
        formData.password = value;
        break;
      case "--vehicleMake":
        formData.vehicleMake = value;
        break;
      case "--vehicleModel":
        formData.vehicleModel = value;
        break;
      case "--loginUrl":
        formData.loginUrl = value;
        break;
      case "--help":
      case "-h":
        console.log(USAGE);
        process.exit(0);
        break;
    }
  }

  return { formData, options };
}

async function main() {
  const { formData, options } = parseCommandLineArgs();
  const handler = resolveMultiCompanyHandler(options.company, options.type);
  if (!handler) {
    console.error(
      `No handler for --company "${options.company}" --type "${options.type}". ` +
        `Available: ${Object.entries(registry)
          .map(([c, types]) => Object.keys(types).map((t) => `${c}/${t}`).join(", "))
          .join(", ")}`
    );
    console.log(USAGE);
    process.exit(1);
  }

  console.log(`🚀 Running ${options.company} ${options.type.toUpperCase()} with:`, {
    ...formData,
    password: formData.password ? "***" : "",
  });

  const result = await handler(formData);
  // _jobBrowser holds the live driver — not printable.
  const { _jobBrowser, ...printable } = result || {};
  console.log("📊 Result:", JSON.stringify(printable, null, 2));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("💥 Fatal error:", error);
      process.exit(1);
    });
}

module.exports = { parseCommandLineArgs };
