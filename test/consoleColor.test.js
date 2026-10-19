const test = require("node:test");
const assert = require("node:assert/strict");
const { colorEnabled, paint, statusColor, colorStatus } = require("../lib/consoleColor");

const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

test("completed is green, failed red, waiting amber, anything else plain", () => {
  assert.equal(statusColor("completed"), "green");
  assert.equal(statusColor("failed_post_submission"), "red");
  assert.equal(statusColor("failed"), "red");
  assert.equal(statusColor("pending"), "yellow");
  assert.equal(statusColor("completed_with_errors"), "yellow");
  assert.equal(statusColor("processing"), null);
  assert.equal(colorStatus("completed", { enabled: true }), "\x1b[32mcompleted\x1b[0m");
  assert.equal(colorStatus("failed_login_form", { enabled: true }), "\x1b[31mfailed_login_form\x1b[0m");
  assert.equal(colorStatus("processing", { enabled: true }), "processing");
  assert.equal(paint("green", "x", { enabled: false }), "x");
});

test("colour only in a terminal; NO_COLOR always wins; FORCE_COLOR forces it", () => {
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
    assert.equal(colorEnabled({ isTTY: true }), true);
    assert.equal(colorEnabled({ isTTY: false }), false, "a pipe / file gets plain text");
  });
  withEnv({ NO_COLOR: "", FORCE_COLOR: "1" }, () => assert.equal(colorEnabled({ isTTY: true }), false));
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: "1" }, () => assert.equal(colorEnabled({ isTTY: false }), true));
  withEnv({ NO_COLOR: undefined, FORCE_COLOR: "0" }, () => assert.equal(colorEnabled({ isTTY: true }), false));
});

test("the queue's outcome line uses it for both statuses", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "lib", "partRunner.js"), "utf8");
  assert.match(src, /-> \$\{colorStatus\(after\.status\)\}/);
  assert.match(src, /\(job now \$\{colorStatus\(written\.jobSet\.status\)\}/);
});
