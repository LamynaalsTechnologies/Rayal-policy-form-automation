// The Brisk PA certificate through our server's new Brisk API code (lib/briskV2Automation.js) and its switch in
// briskCertificate.js. Every server answer is a fake fetch: nothing here reaches the network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const v2 = require("../lib/briskV2Automation");

const KEY = "automation-key-for-tests-0001";
const ENV = { BRISK_V2_AUTOMATION_ENABLED: "true", BRISK_V2_BACKEND_URL: "http://localhost:4005/api/", BRISK_V2_AUTOMATION_KEY: KEY };
const POLICY = "64b000000000000000000c01";
const quiet = () => {};

const fakeFetch = (answer, seen = []) => async (url, init) => {
  seen.push({ url, init, body: JSON.parse(init.body) });
  if (answer instanceof Error) throw answer;
  const { status = 200, body } = typeof answer === "function" ? answer() : answer;
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
};
const run = (answer, { data = { _id: POLICY, _jobIdentifier: "job-7" }, env = ENV, seen } = {}) =>
  v2.createViaBackend(data, { env, fetchImpl: fakeFetch(answer, seen), log: quiet });

test("the switch is exactly 'true'; anything else keeps the old production call", () => {
  assert.equal(v2.isEnabled({ BRISK_V2_AUTOMATION_ENABLED: "true" }), true);
  assert.equal(v2.isEnabled({ BRISK_V2_AUTOMATION_ENABLED: " TRUE " }), true);
  for (const off of [undefined, "", "false", "1", "yes", "on"]) assert.equal(v2.isEnabled({ BRISK_V2_AUTOMATION_ENABLED: off }), false, String(off));
});

test("sends the policy id and the job to the server with the key in a header", async () => {
  const seen = [];
  await run({ body: { error: false, data: { apiEnv: "LIVE", certificateNo: "TW1", downloadUrl: "https://b/x.pdf" } } }, { seen });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://localhost:4005/api/briskV2/automation/certificates");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["x-brisk-automation-key"], KEY);
  assert.deepEqual(seen[0].body, { onlinePolicyId: POLICY, jobId: "job-7" });
});

test("the policy id is read from _id, an exported { $oid }, onlinePolicyId or captchaId", () => {
  assert.equal(v2.policyIdOf({ _id: POLICY }), POLICY);
  assert.equal(v2.policyIdOf({ _id: { $oid: POLICY } }), POLICY);
  assert.equal(v2.policyIdOf({ _id: { toString: () => POLICY } }), POLICY);
  assert.equal(v2.policyIdOf({ captchaId: POLICY }), POLICY);
  assert.equal(v2.policyIdOf({ _id: "nope" }), "");
});

test("LIVE certificate: the old answer shape (policyId = number, downloadUrl) so the PDF is stored as before", async () => {
  const res = await run({ body: { error: false, message: "made", data: { apiEnv: "LIVE", certificateNo: "TW261017", downloadUrl: "https://b/TW261017.pdf", recordId: "r1" } } });
  assert.equal(res.success, true);
  assert.equal(res.policyId, "TW261017");
  assert.equal(res.downloadUrl, "https://b/TW261017.pdf");
});

test("policy already has a Brisk certificate: skip even when its number is not present", async () => {
  const withNumber = await run({
    body: { error: true, code: "POLICY_HAS_CERTIFICATE", data: { certificateNo: "TW261017", downloadUrl: "https://b/TW261017.pdf" } },
  });
  assert.equal(withNumber.success, true);
  assert.equal(withNumber.alreadyExisted, true);
  assert.equal(withNumber.policyId, "TW261017");

  const withoutNumber = await run({
    body: { error: true, code: "POLICY_HAS_CERTIFICATE", data: { certificateNo: "", downloadUrl: "https://b/existing.pdf" } },
  });
  assert.equal(withoutNumber.success, true);
  assert.equal(withoutNumber.alreadyExisted, true);
  assert.equal(withoutNumber.policyId, "");
  assert.equal(withoutNumber.downloadUrl, "https://b/existing.pdf");
});

test("TEST certificate: never handed back as a real one (it would be stored on a real policy)", async () => {
  await assert.rejects(
    run({ body: { error: false, data: { apiEnv: "TEST", certificateNo: "TW9", downloadUrl: "https://b/TW9.pdf" } } }),
    /Brisk TEST certificate TW9 was made on the TEST account, so it is not stored on this policy/
  );
});

test("a refusal is thrown with the server's sentence (nothing bought); unclear answers carry no number", async () => {
  await assert.rejects(run({ body: { error: true, code: "BRISK_REFUSED", message: "Brisk did not create the certificate. Brisk said \"Invalid Model\"." } }), /Invalid Model/);
  for (const code of ["UNKNOWN_OUTCOME", "IN_PROGRESS"]) {
    const res = await run({ body: { error: true, code, message: "unclear" } });
    assert.equal(res.success, false);
    assert.equal(res.policyId, undefined);
  }
  const http500 = await run({ status: 500, body: "<html>oops</html>" });
  assert.equal(http500.success, false);
  assert.equal(http500.policyId, undefined);
});

test("server not reachable = nothing bought (throws); a lost answer = unknown (no number)", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  await assert.rejects(run(refused), /Could not reach the server/);
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const res = await run(reset);
  assert.equal(res.success, false);
  assert.equal(res.unknown, true);
  assert.equal(res.policyId, undefined);
});

test("missing settings or policy id: refused before anything is sent", async () => {
  const seen = [];
  await assert.rejects(run({ body: {} }, { env: { ...ENV, BRISK_V2_AUTOMATION_KEY: "short" }, seen }), /BRISK_V2_AUTOMATION_KEY is not set/);
  await assert.rejects(run({ body: {} }, { env: { ...ENV, BRISK_V2_BACKEND_URL: "" }, seen }), /BRISK_V2_BACKEND_URL is not set/);
  await assert.rejects(run({ body: {} }, { data: { fullName: "X" }, seen }), /no Online Policy id/);
  assert.equal(seen.length, 0);
});

test("briskCertificate.js: the switch is checked first, and off falls through to the old call untouched", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "briskCertificate.js"), "utf8");
  const body = src.slice(src.indexOf("async function createBriskCertificate(data) {"));
  const firstCode = body
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"));
  assert.equal(firstCode[0], 'const briskV2 = require("./lib/briskV2Automation");');
  assert.equal(firstCode[1], "if (briskV2.isEnabled()) return briskV2.createViaBackend(data);");
  assert.match(body, /coreapi\.rayalbrokers\.com\/api\/createBriskCertificate/, "the old production call is still there");
});

test("briskCertificate.js with the switch ON returns the server's answer (fetch stubbed, nothing leaves the machine)", async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  globalThis.fetch = fakeFetch({ body: { error: false, data: { apiEnv: "LIVE", certificateNo: "TW5", downloadUrl: "https://b/TW5.pdf" } } });
  const realLog = console.log;
  console.log = quiet;
  try {
    const { createBriskCertificate } = require("../briskCertificate");
    const res = await createBriskCertificate({ _id: POLICY, _jobIdentifier: "j" });
    assert.equal(res.policyId, "TW5");
  } finally {
    console.log = realLog;
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
