/**
 * Preloaded into every test file (package.json "test": node --require ./test/support/noRealWorld.js --test ...).
 *
 * A unit test must never start a real browser or write to the production bucket. The Reliance OD / TP handlers run the
 * real Reliance flow (a 5,000-line module with its own browser) unless a test stubs it; one forgotten stub is enough to
 * open Chrome windows, log in to the real portal with a fake user and upload screenshots. So the two chokepoints are
 * closed here for the whole test process:
 *
 *   - selenium's Builder.build()      — every Chrome / driver the project starts goes through it
 *   - AWS.S3.upload, AWS.Request.send / promise — every S3 write (and any other AWS call) goes through them
 *
 * A test that really needs one of them (none does today) can set ALLOW_REAL_BROWSER_IN_TESTS=1 /
 * ALLOW_REAL_S3_IN_TESTS=1 for its own run. Tests that replace a module or an instance with a stub never get here: the
 * stub is called instead of the real thing.
 */
function refuse(what, allowVar) {
  return function refused() {
    throw new Error(
      `TEST SAFETY: ${what} was started from a unit test. Stub the module the test is calling ` +
        `(or set ${allowVar}=1 to allow it on purpose).`
    );
  };
}

if (process.env.ALLOW_REAL_BROWSER_IN_TESTS !== "1") {
  const selenium = require("selenium-webdriver");
  const original = selenium.Builder.prototype.build;
  selenium.Builder.prototype.build = function build() {
    return refuse("a real browser", "ALLOW_REAL_BROWSER_IN_TESTS")();
  };
  selenium.Builder.prototype.build.original = original;
}

if (process.env.ALLOW_REAL_S3_IN_TESTS !== "1") {
  const AWS = require("aws-sdk");
  // upload() is the managed upload s3Uploader.js uses; the Request methods are where EVERY service call (putObject,
  // getObject, lifecycle rules ...) is sent — a request that is only presigned (getSignedUrl) is never sent.
  const targets = [
    [AWS.S3.prototype, "upload", "an S3 upload"],
    [AWS.Request.prototype, "send", "an AWS request"],
    [AWS.Request.prototype, "promise", "an AWS request"],
  ];
  for (const [owner, method, what] of targets) {
    const original = owner[method];
    if (typeof original !== "function") continue;
    owner[method] = function refusedAws() {
      return refuse(what, "ALLOW_REAL_S3_IN_TESTS")();
    };
    owner[method].original = original;
  }
}
