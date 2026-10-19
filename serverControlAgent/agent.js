#!/usr/bin/env node
/**
 * Server Control agent — the ONE small program on the automation box that may start / stop / restart the automation
 * server, for the super admin's "Server Control" page (backend /api/serverControl/*). The owner, 2026-10-19.
 *
 * The box runs many other pm2 apps (CRM, Policy, batch, pdf ...). This agent can only ever touch ONE of them:
 *   - before any action it asks pm2 for its list and acts only when there is a process with
 *     id SERVER_CONTROL_PM2_ID (3) AND name SERVER_CONTROL_PM2_NAME ("server"); otherwise nothing runs;
 *   - the command is fixed: execFile(PM2_BIN, [<start|stop|restart>, "<id>"]) — no shell, no text from the request;
 *   - every request needs the secret key (x-server-control-key), compared in constant time; 5 wrong keys lock that
 *     address out for 15 minutes; optional SERVER_CONTROL_ALLOWED_IPS.
 * It also reports the process / machine status, the tail of the pm2 logs, and the automation .env with every secret
 * hidden (the page is view only).
 *
 * Settings (automation .env — see serverControlAgent/README.md):
 *   SERVER_CONTROL_KEY           required, at least 24 characters (the same value goes in the backend .env)
 *   SERVER_CONTROL_PORT          default 3001
 *   SERVER_CONTROL_PM2_ID        default 3
 *   SERVER_CONTROL_PM2_NAME      default server
 *   SERVER_CONTROL_ALLOWED_IPS   optional, comma list (the backend's address)
 *   SERVER_CONTROL_ENV_FILE      default ../.env (the automation's)
 *   PM2_BIN                      default pm2
 *
 * Run:  pm2 start serverControlAgent/agent.js --name server-control && pm2 save
 */
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const ACTIONS = ["start", "stop", "restart"];
/** Every answer carries this, so the backend knows it reached THIS agent and not some other program on the port. */
const SERVICE_ID = "rayal-server-control";
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const MAX_LOG_BYTES = 256 * 1024;
const SECRET_KEY_RE = /(KEY|SECRET|PASS|PWD|TOKEN|PRIVATE|CREDENTIAL|AUTH|DSN|URI$|_URL$)/i;

/* ----------------------------------------------------------------- settings ----------------------------------------------------------------- */

function loadConfig(env = process.env) {
  return {
    key: String(env.SERVER_CONTROL_KEY || ""),
    port: Number(env.SERVER_CONTROL_PORT || 3001),
    pm2Id: String(env.SERVER_CONTROL_PM2_ID || "3").trim(),
    pm2Name: String(env.SERVER_CONTROL_PM2_NAME || "server").trim(),
    allowedIps: String(env.SERVER_CONTROL_ALLOWED_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    envFile: env.SERVER_CONTROL_ENV_FILE || path.join(__dirname, "..", ".env"),
    pm2Bin: env.PM2_BIN || "pm2",
  };
}

/** Refuse to run without a real key: an agent that anyone can call would let anyone stop the server. */
function configProblem(config) {
  if (config.key.length < 24) return "SERVER_CONTROL_KEY is missing or shorter than 24 characters";
  if (!/^\d+$/.test(config.pm2Id)) return "SERVER_CONTROL_PM2_ID must be a number";
  if (!config.pm2Name) return "SERVER_CONTROL_PM2_NAME is empty";
  return null;
}

/* ------------------------------------------------------------------- pm2 -------------------------------------------------------------------- */

/** The real pm2: execFile (no shell), fixed arguments, a timeout. */
function defaultRunPm2(config) {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(config.pm2Bin, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, shell: false }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = String(stderr || "");
          return reject(error);
        }
        resolve(String(stdout || ""));
      });
    });
}

/** `pm2 jlist` can print warnings before the JSON. */
function parseJlist(text) {
  const s = String(text || "");
  // the JSON list starts at "[{" or "[]" — a warning line such as "[PM2] ..." does not
  const m = s.match(/\[\s*(\{|\])/);
  if (!m) throw new Error("pm2 gave no process list");
  return JSON.parse(s.slice(m.index));
}

/** The automation server's entry in pm2's list — only when BOTH the id and the name match. */
function findTarget(list, config) {
  return (list || []).find((p) => String(p.pm_id) === config.pm2Id && String(p.name) === config.pm2Name) || null;
}

function describeProcess(p, now = Date.now()) {
  const e = (p && p.pm2_env) || {};
  const online = e.status === "online";
  return {
    id: p.pm_id,
    name: p.name,
    status: e.status || "unknown",
    pid: p.pid || null,
    uptimeMs: online && e.pm_uptime ? Math.max(0, now - e.pm_uptime) : 0,
    startedAt: online && e.pm_uptime ? new Date(e.pm_uptime).toISOString() : null,
    restarts: e.restart_time || 0,
    unstableRestarts: e.unstable_restarts || 0,
    cpu: (p.monit && p.monit.cpu) || 0,
    memoryBytes: (p.monit && p.monit.memory) || 0,
    nodeVersion: e.node_version || null,
    cwd: e.pm_cwd || null,
    script: e.pm_exec_path || null,
    createdAt: e.created_at ? new Date(e.created_at).toISOString() : null,
  };
}

function machineInfo(dir, { osImpl = os, fsImpl = fs } = {}) {
  let disk = null;
  try {
    if (typeof fsImpl.statfsSync === "function") {
      const st = fsImpl.statfsSync(dir || "/");
      disk = { totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize };
    }
  } catch (e) {
    disk = null;
  }
  return {
    hostname: osImpl.hostname(),
    platform: `${osImpl.type()} ${osImpl.release()}`,
    cpus: (osImpl.cpus() || []).length,
    loadavg: osImpl.loadavg(),
    totalMemBytes: osImpl.totalmem(),
    freeMemBytes: osImpl.freemem(),
    uptimeSec: Math.round(osImpl.uptime()),
    disk,
  };
}

/* ---------------------------------------------------------------- database ---------------------------------------------------------------- */

/**
 * Which database a MongoDB URI points at, WITHOUT its user / password: { label: "host/db", id: short hash }. The backend
 * compares it with its own, because a stop that holds the running windows must look at the automation's database.
 */
function databaseOf(uri) {
  const m = String(uri || "").trim().match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const db = decodeURIComponent(m[2] || "").trim() || "(default)";
  const label = `${host}/${db}`;
  return { label, id: crypto.createHash("sha256").update(label).digest("hex").slice(0, 16) };
}

/* ------------------------------------------------------------------ logs -------------------------------------------------------------------- */

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
/** user:password@ in any URL-looking text */
const CRED_RE = /([a-z][a-z0-9+.-]*:\/\/)([^:\s/@]+):([^@\s]+)@/gi;

const maskCredentials = (text) => String(text).replace(CRED_RE, "$1$2:••••••@");

/** The last `lines` lines of a file, reading at most MAX_LOG_BYTES from its end. Missing file = []. */
function tailFile(file, lines = 200, { fsImpl = fs } = {}) {
  if (!file) return [];
  let fd = null;
  try {
    const size = fsImpl.statSync(file).size;
    const length = Math.min(size, MAX_LOG_BYTES);
    const buf = Buffer.alloc(length);
    fd = fsImpl.openSync(file, "r");
    fsImpl.readSync(fd, buf, 0, length, size - length);
    const all = buf.toString("utf8").split(/\r?\n/);
    if (length < size) all.shift(); // the first line was cut in half
    while (all.length && all[all.length - 1] === "") all.pop();
    return all.slice(-Math.max(1, Math.min(1000, lines))).map((l) => maskCredentials(l.replace(ANSI_RE, "")));
  } catch (e) {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

/* ------------------------------------------------------------------- .env ------------------------------------------------------------------- */

function isSecret(key, value) {
  if (SECRET_KEY_RE.test(key)) return true;
  const v = String(value || "");
  if (CRED_RE.test(v)) {
    CRED_RE.lastIndex = 0;
    return true;
  }
  CRED_RE.lastIndex = 0;
  return /^[A-Za-z0-9_\-+/=.]{32,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v); // a long random token
}

/** The .env as rows { key, value, secret, comment } — a secret's value is never included. */
function parseEnvForView(text) {
  const rows = [];
  let comment = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      comment = [];
      continue;
    }
    if (line.startsWith("#")) {
      comment.push(line.replace(/^#+\s?/, ""));
      continue;
    }
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!m) {
      comment = [];
      continue;
    }
    const key = m[1];
    let value = m[2];
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) value = quoted[2];
    const secret = key === "SERVER_CONTROL_KEY" || isSecret(key, value);
    rows.push({ key, value: secret ? (value ? "••••••" : "") : value, secret, comment: comment.join(" ").slice(0, 600) });
    comment = [];
  }
  return rows;
}

/* ------------------------------------------------------------------- auth ------------------------------------------------------------------- */

function sameKey(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(expected || ""));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b); // same work either way
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

const normIp = (ip) => String(ip || "").replace(/^::ffff:/, "");

/* ------------------------------------------------------------------ agent ------------------------------------------------------------------- */

/**
 * The request handler, without HTTP: handle({ method, path, query, headers, ip, body }) -> { status, json }.
 * Every dependency can be replaced in tests (runPm2 especially — tests never run the real pm2).
 */
function createAgent({ config = loadConfig(), runPm2, fsImpl = fs, osImpl = os, now = () => Date.now(), sleep, mongoUri = process.env.MONGODB_URI } = {}) {
  const pm2 = runPm2 || defaultRunPm2(config);
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fails = new Map(); // ip -> { count, until }

  const target = async () => findTarget(parseJlist(await pm2(["jlist"])), config);

  const status = async () => {
    const p = await target();
    return {
      found: !!p,
      expected: { id: Number(config.pm2Id), name: config.pm2Name },
      process: p ? describeProcess(p, now()) : null,
      machine: machineInfo(p && p.pm2_env ? p.pm2_env.pm_cwd : path.dirname(config.envFile), { osImpl, fsImpl }),
      // the database the automation works on (its .env MONGODB_URI, no password) — the backend checks it is its own
      database: databaseOf(mongoUri),
      checkedAt: new Date(now()).toISOString(),
    };
  };

  const notFound = () => ({
    status: 409,
    json: {
      error: true,
      message: `pm2 has no process ${config.pm2Id} called "${config.pm2Name}" - nothing was done`,
    },
  });

  async function handle({ method = "GET", path: route = "/", query = {}, headers = {}, ip = "", body = {} } = {}) {
    const who = normIp(ip);
    if (config.allowedIps.length && !config.allowedIps.map(normIp).includes(who)) {
      return { status: 403, json: { error: true, message: "This address may not use the server control agent" } };
    }
    const f = fails.get(who);
    if (f && f.until && f.until > now()) {
      return { status: 429, json: { error: true, message: "Too many wrong keys - try again later" } };
    }
    if (!sameKey(headers["x-server-control-key"], config.key)) {
      // (a lock that has run out starts the count again)
      const next = { count: (f && !f.until ? f.count : 0) + 1, until: 0 };
      if (next.count >= MAX_FAILS) next.until = now() + LOCK_MS;
      fails.set(who, next);
      return { status: 401, json: { error: true, message: "Wrong or missing key" } };
    }
    fails.delete(who);

    try {
      if (method === "GET" && route === "/status") return { status: 200, json: { error: false, data: await status() } };

      if (method === "POST" && route === "/action") {
        const action = String((body && body.action) || "");
        if (!ACTIONS.includes(action)) {
          return { status: 400, json: { error: true, message: "The action must be start, stop or restart" } };
        }
        const p = await target();
        if (!p) return notFound();
        await pm2([action, config.pm2Id]); // fixed command, fixed id — never anything from the request
        await wait(1500);
        return { status: 200, json: { error: false, message: `pm2 ${action} ${config.pm2Id} done`, data: await status() } };
      }

      if (method === "GET" && route === "/logs") {
        const p = await target();
        if (!p) return notFound();
        const lines = Math.max(10, Math.min(1000, Number(query.lines) || 200));
        const e = p.pm2_env || {};
        return {
          status: 200,
          json: {
            error: false,
            data: { out: tailFile(e.pm_out_log_path, lines, { fsImpl }), err: tailFile(e.pm_err_log_path, lines, { fsImpl }), lines },
          },
        };
      }

      if (method === "GET" && route === "/env") {
        let text = "";
        try {
          text = fsImpl.readFileSync(config.envFile, "utf8");
        } catch (e) {
          return { status: 404, json: { error: true, message: "The automation .env file could not be read" } };
        }
        return { status: 200, json: { error: false, data: { file: path.basename(config.envFile), rows: parseEnvForView(text) } } };
      }

      return { status: 404, json: { error: true, message: "Not found" } };
    } catch (e) {
      return { status: 500, json: { error: true, message: `The agent could not do that (${String((e && e.message) || e).slice(0, 200)})` } };
    }
  }

  return { handle, status, config };
}

/** The HTTP wrapper around handle(). */
function createServer(agent) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://agent");
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= 16 * 1024) chunks.push(c);
    });
    req.on("end", async () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch (e) {
        body = {};
      }
      const out = await agent.handle({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        ip: req.socket.remoteAddress,
        body,
      });
      res.writeHead(out.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ service: SERVICE_ID, ...out.json }));
    });
  });
}

module.exports = {
  ACTIONS,
  SERVICE_ID,
  loadConfig,
  configProblem,
  parseJlist,
  findTarget,
  describeProcess,
  machineInfo,
  tailFile,
  maskCredentials,
  isSecret,
  parseEnvForView,
  sameKey,
  databaseOf,
  createAgent,
  createServer,
  defaultRunPm2,
};

if (require.main === module) {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env"), quiet: true });
  const config = loadConfig();
  const problem = configProblem(config);
  if (problem) {
    console.error(`[server-control] Not started - ${problem}. See serverControlAgent/README.md`);
    process.exit(1);
  }
  const server = createServer(createAgent({ config }));
  server.on("error", (e) => {
    console.error(
      e && e.code === "EADDRINUSE"
        ? `[server-control] Not started - port ${config.port} is already used by another program. Set SERVER_CONTROL_PORT to a free port (and the same port in the backend's AUTOMATION_SERVER_URL)`
        : `[server-control] Not started - ${(e && e.message) || e}`
    );
    process.exit(1);
  });
  server.listen(config.port, () => {
    console.log(`[server-control] Listening on ${config.port}; controls only pm2 process ${config.pm2Id} "${config.pm2Name}"`);
  });
}
