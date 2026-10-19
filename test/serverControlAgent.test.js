/**
 * The Server Control agent (serverControlAgent/agent.js). It may only ever touch pm2 process 3 "server" — these tests
 * prove it, with a FAKE pm2 (never the real one) and no network except one local test server.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const agentLib = require("../serverControlAgent/agent");

const KEY = "k".repeat(30);
const config = (over = {}) => ({ ...agentLib.loadConfig({ SERVER_CONTROL_KEY: KEY, SERVER_CONTROL_ENV_FILE: "/nope/.env" }), ...over });

const proc = (over = {}) => ({
  pm_id: 3,
  name: "server",
  pid: 4242,
  monit: { cpu: 3, memory: 150 * 1024 * 1024 },
  pm2_env: { status: "online", pm_uptime: Date.now() - 60000, restart_time: 917, pm_cwd: "/srv/automation", pm_out_log_path: "", pm_err_log_path: "", node_version: "20.11.0" },
  ...over,
});
const OTHERS = [
  { pm_id: 4, name: "Policy", pm2_env: { status: "stopped" } },
  { pm_id: 10, name: "CRM", pm2_env: { status: "online" } },
];

/** A pm2 stand-in that records every call. */
function fakePm2(list = [...OTHERS, proc()]) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "jlist") return `[PM2] some warning\n${JSON.stringify(list)}`;
    return "";
  };
  return { run, calls };
}
const agentWith = (pm2, over = {}) => agentLib.createAgent({ config: config(over), runPm2: pm2.run, sleep: async () => {} });
const req = (over = {}) => ({ method: "GET", path: "/status", headers: { "x-server-control-key": KEY }, ip: "10.0.0.5", ...over });

test("refuses to start without a real key", () => {
  assert.match(agentLib.configProblem(agentLib.loadConfig({})), /SERVER_CONTROL_KEY/);
  assert.match(agentLib.configProblem(agentLib.loadConfig({ SERVER_CONTROL_KEY: "short" })), /24 characters/);
  assert.equal(agentLib.configProblem(agentLib.loadConfig({ SERVER_CONTROL_KEY: KEY })), null);
  assert.match(agentLib.configProblem(agentLib.loadConfig({ SERVER_CONTROL_KEY: KEY, SERVER_CONTROL_PM2_ID: "3; rm -rf /" })), /must be a number/);
});

test("every request needs the key; 5 wrong keys lock that address out; the key is never echoed", async () => {
  const pm2 = fakePm2();
  const agent = agentWith(pm2);
  const none = await agent.handle(req({ headers: {} }));
  assert.equal(none.status, 401);
  assert.equal(pm2.calls.length, 0, "nothing ran");
  for (let i = 0; i < 4; i++) assert.equal((await agent.handle(req({ headers: { "x-server-control-key": "wrong" } }))).status, 401);
  const locked = await agent.handle(req({ headers: { "x-server-control-key": KEY } }));
  assert.equal(locked.status, 429, "locked even with the right key now");
  assert.equal(JSON.stringify(locked).includes(KEY), false);
  // another address is not locked
  assert.equal((await agent.handle(req({ ip: "10.0.0.9" }))).status, 200);
});

test("allowed addresses: anyone else is refused before the key is even looked at", async () => {
  const pm2 = fakePm2();
  const agent = agentWith(pm2, { allowedIps: ["10.0.0.5"] });
  assert.equal((await agent.handle(req({ ip: "::ffff:10.0.0.5" }))).status, 200);
  assert.equal((await agent.handle(req({ ip: "10.0.0.6" }))).status, 403);
});

test("status: process 3 'server' only (other apps are ignored), machine figures", async () => {
  const agent = agentWith(fakePm2());
  const r = await agent.handle(req());
  assert.equal(r.status, 200);
  const d = r.json.data;
  assert.equal(d.found, true);
  assert.equal(d.process.id, 3);
  assert.equal(d.process.name, "server");
  assert.equal(d.process.status, "online");
  assert.equal(d.process.restarts, 917);
  assert.equal(d.process.memoryBytes, 150 * 1024 * 1024);
  assert.ok(d.process.uptimeMs >= 59000);
  assert.ok(d.machine.cpus >= 1);
  assert.ok(d.machine.totalMemBytes > 0);
});

test("ACTIONS: only start / stop / restart, only on id 3 — the exact pm2 arguments, nothing from the request", async () => {
  for (const action of ["start", "stop", "restart"]) {
    const pm2 = fakePm2();
    const r = await agentWith(pm2).handle(req({ method: "POST", path: "/action", body: { action, id: 4, name: "CRM", extra: "; reboot" } }));
    assert.equal(r.status, 200, action);
    const run = pm2.calls.filter((c) => c[0] !== "jlist");
    assert.deepEqual(run, [[action, "3"]], `pm2 ${action} 3 and nothing else`);
  }
  const pm2 = fakePm2();
  for (const action of ["delete", "kill", "start 4", "restart all", ""]) {
    const r = await agentWith(pm2).handle(req({ method: "POST", path: "/action", body: { action } }));
    assert.equal(r.status, 400, action);
  }
  assert.equal(pm2.calls.length, 0, "a refused action runs nothing, not even the list");
});

test("SAFETY: no process 3 called 'server' -> nothing is started, stopped or restarted", async () => {
  const cases = [
    [...OTHERS], // missing
    [...OTHERS, proc({ name: "Policy" })], // id 3 but another name
    [...OTHERS, proc({ pm_id: 5 })], // the name but another id
  ];
  for (const list of cases) {
    const pm2 = fakePm2(list);
    const r = await agentWith(pm2).handle(req({ method: "POST", path: "/action", body: { action: "stop" } }));
    assert.equal(r.status, 409);
    assert.match(r.json.message, /no process 3 called "server" - nothing was done/);
    assert.deepEqual(pm2.calls, [["jlist"]], "only the list was read");
  }
});

test("logs: the tail of pm2's out / err files, colour codes removed, URL passwords masked", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scagent-"));
  try {
    const out = path.join(dir, "out.log");
    const err = path.join(dir, "err.log");
    const lines = [];
    for (let i = 1; i <= 300; i++) lines.push(`\x1b[32mline ${i}\x1b[0m`);
    lines.push("connecting to mongodb+srv://admin:Sup3rS3cret@cluster0.example.net/db");
    fs.writeFileSync(out, lines.join("\n") + "\n");
    fs.writeFileSync(err, "boom\n");
    const p = proc();
    p.pm2_env.pm_out_log_path = out;
    p.pm2_env.pm_err_log_path = err;
    const r = await agentWith(fakePm2([p])).handle(req({ path: "/logs", query: { lines: "50" } }));
    assert.equal(r.status, 200);
    assert.equal(r.json.data.out.length, 50);
    assert.equal(r.json.data.out[0], "line 252");
    assert.equal(r.json.data.out[49], "connecting to mongodb+srv://admin:••••••@cluster0.example.net/db");
    assert.equal(JSON.stringify(r.json).includes("Sup3rS3cret"), false);
    assert.deepEqual(r.json.data.err, ["boom"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test(".env view: every secret hidden (keys, passwords, tokens, DB / service URLs, credentials, long tokens); comments kept", () => {
  const text = [
    "# Mongo connection",
    "MONGODB_URI=mongodb://user:pw@host/db",
    "",
    "# Keep a failed window open for a look",
    "KEEP_BROWSER_OPEN_ON_ERROR=true",
    "OPENAI_API_KEY=sk-abc",
    "AWS_SECRET_ACCESS_KEY=xyz",
    "SERVER_CONTROL_KEY=abcdefghijklmnopqrstuvwxyz123",
    "BRISK_PASSWORD='p@ss'",
    "SOME_TOKEN=t",
    "BRISK_V2_BACKEND_URL=http://10.0.0.1:4005",
    "WEIRD=https://u:p@x.y/z",
    "RANDOM_BLOB=AbCdEf0123456789AbCdEf0123456789xyz",
    "MAX_PARALLEL_JOBS=3",
    'QUOTED="hello world"',
  ].join("\n");
  const rows = agentLib.parseEnvForView(text);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  for (const k of ["MONGODB_URI", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SERVER_CONTROL_KEY", "BRISK_PASSWORD", "SOME_TOKEN", "BRISK_V2_BACKEND_URL", "WEIRD", "RANDOM_BLOB"]) {
    assert.equal(byKey[k].secret, true, k);
    assert.equal(byKey[k].value, "••••••", k);
  }
  assert.deepEqual(byKey.KEEP_BROWSER_OPEN_ON_ERROR, { key: "KEEP_BROWSER_OPEN_ON_ERROR", value: "true", secret: false, comment: "Keep a failed window open for a look" });
  assert.equal(byKey.MAX_PARALLEL_JOBS.value, "3");
  assert.equal(byKey.QUOTED.value, "hello world");
  assert.equal(byKey.MONGODB_URI.comment, "Mongo connection");
  for (const secret of ["user:pw", "sk-abc", "xyz", "abcdefghijklmnopqrstuvwxyz123", "p@ss", "10.0.0.1", "AbCdEf0123456789"]) {
    assert.equal(JSON.stringify(rows).includes(secret), false, secret);
  }
});

test("the real pm2 runner: execFile with the fixed arguments and NO shell (a fake pm2 script records them)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scagent-bin-"));
  try {
    const record = path.join(dir, "args.json");
    const bin = path.join(dir, "pm2");
    fs.writeFileSync(
      bin,
      `#!/usr/bin/env node\nconst fs=require("fs");const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(a)+"\\n");` +
        `if(a[0]==="jlist")process.stdout.write(${JSON.stringify(JSON.stringify([...OTHERS, proc()]))});`
    );
    fs.chmodSync(bin, 0o755);
    const cfg = config({ pm2Bin: bin });
    const agent = agentLib.createAgent({ config: cfg, sleep: async () => {} });
    const r = await agent.handle(req({ method: "POST", path: "/action", body: { action: "restart" } }));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const calls = fs.readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(calls.filter((c) => c[0] !== "jlist"), [["restart", "3"]]);
    const src = fs.readFileSync(path.join(__dirname, "..", "serverControlAgent", "agent.js"), "utf8");
    assert.match(src, /execFile\(config\.pm2Bin, args, \{[^}]*shell: false/);
    assert.equal(/\bexec\(|spawn\([^)]*shell:\s*true/.test(src), false, "no shell anywhere");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("over HTTP (a local test server): JSON in, JSON out, the key header checked", async () => {
  const pm2 = fakePm2();
  const server = agentLib.createServer(agentWith(pm2));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await fetch(`${base}/status`);
    assert.equal(bad.status, 401);
    const ok = await fetch(`${base}/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-server-control-key": KEY },
      body: JSON.stringify({ action: "stop" }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(pm2.calls.filter((c) => c[0] !== "jlist"), [["stop", "3"]]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
