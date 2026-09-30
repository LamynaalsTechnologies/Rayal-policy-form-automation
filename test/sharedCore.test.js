const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// jobPartsCore.js lives twice (backend shared/ and here in lib/) and the copies
// must stay byte-identical. Only checkable when the backend repo sits next to
// this one, which it does in the monorepo checkout.
test("lib/jobPartsCore.js is byte-identical to the backend's shared/jobPartsCore.js", (t) => {
  const backend = path.join(__dirname, "..", "..", "RayalBrokers-backend", "shared", "jobPartsCore.js");
  if (!fs.existsSync(backend)) return t.skip("backend repo not next to this one");
  const mine = fs.readFileSync(path.join(__dirname, "..", "lib", "jobPartsCore.js"));
  assert.ok(mine.equals(fs.readFileSync(backend)), "the two copies of jobPartsCore.js differ");
});

test("jobPartsCore has no requires (it is copied between repos as is)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "jobPartsCore.js"), "utf8");
  assert.equal(/\brequire\s*\(/.test(src), false);
});
