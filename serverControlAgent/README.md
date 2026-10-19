# Server Control agent — install once on the automation server

This small program lets the super admin's **Server Control** page (web app → User → Server Control) start, stop and
restart the automation server, see its status and logs, and see the automation `.env` with every secret hidden.

**It can only ever touch pm2 process `3` named `server`.** Before any action it reads `pm2 jlist`; if there is no
process with BOTH that id and that name, it does nothing. The command it runs is fixed (`pm2 start|stop|restart 3`),
with no shell. CRM, Policy, batch, pdf and every other app on the box are never touched.

## 1. Make a key (on the server)
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
Copy the 48-character result.

## 2. Add the settings to the automation `.env` (`Rayal-policy-form-automation/.env`)
```
# Server Control agent (serverControlAgent/agent.js) — the same key goes in the backend .env
SERVER_CONTROL_KEY=<the key from step 1>
SERVER_CONTROL_PORT=3001
SERVER_CONTROL_PM2_ID=3
SERVER_CONTROL_PM2_NAME=server
# optional: only the backend server may call it (its public IP)
# SERVER_CONTROL_ALLOWED_IPS=1.2.3.4
```
The agent refuses to start without a key of at least 24 characters.

## 3. Start it with pm2 (from the automation folder) — this ADDS one new process, it changes no other
```bash
cd /path/to/Rayal-policy-form-automation
pm2 start serverControlAgent/agent.js --name server-control
pm2 save
```
Do **not** run `pm2 restart all` / `pm2 delete all` — the other apps must keep running.
The log line `[server-control] Listening on 3001; controls only pm2 process 3 "server"` means it is up.

## 4. Open port 3001 only for the backend
If a firewall is on (ufw), allow the backend's address only:
```bash
ufw allow from <backend server IP> to any port 3001 proto tcp
```

## 5. Check it (on the server)
```bash
curl -s -H "x-server-control-key: <the key>" http://127.0.0.1:3001/status
```
It answers with `"found":true` and the automation's status. `"found":false` means pm2 has no process 3 called `server` —
then nothing can be started or stopped until the settings match.

## 6. The backend `.env`
```
AUTOMATION_SERVER_URL=http://103.174.103.168:3001
SERVER_CONTROL_KEY=<the same key>
```
Restart the backend; the super admin's menu shows **Server Control**.

## What it answers (all need the `x-server-control-key` header)
| Call | What |
|---|---|
| `GET /status` | pm2 process 3: status, pid, uptime, restarts, CPU, memory, node version, folder; the machine: host, CPUs, load, memory, disk |
| `POST /action {"action":"start"\|"stop"\|"restart"}` | runs `pm2 <action> 3` (refused unless process 3 is `server`) |
| `GET /logs?lines=200` | the last lines of the automation's pm2 output and error logs (colours removed, URL passwords hidden) |
| `GET /env` | the automation `.env`, every secret (keys, passwords, tokens, database / service URLs, long tokens) shown as `••••••` |

Five wrong keys from one address lock that address out for 15 minutes.
Tests: `test/serverControlAgent.test.js` (a fake pm2 — the real one is never called).

## When the page shows something wrong
| The page says | What to do |
|---|---|
| "Something else answers at the address in AUTOMATION_SERVER_URL - it is not the Server Control agent" | Another program owns that port. On the server: `ss -ltnp \| grep :3001` shows which one. Pick a free port (e.g. `3091`): `SERVER_CONTROL_PORT=3091` in the automation `.env`, `AUTOMATION_SERVER_URL=http://103.174.103.168:3091` in the backend `.env`, then `pm2 restart server-control` and restart the backend |
| "The control agent is not running … (connection refused)" | `pm2 list` — is `server-control` online? `pm2 logs server-control --lines 20` says why it stopped (no key / port in use) |
| "did not answer in time" | the port is blocked by a firewall — allow it from the backend's address |
| "Wrong or missing key" | the two `SERVER_CONTROL_KEY` values differ |

The agent's own log line when the port is taken: `Not started - port 3001 is already used by another program`.
Every answer of the agent carries `"service":"rayal-server-control"`; the backend ignores anything that does not.
| "Stop and Restart are off - this backend uses a different database than the automation server" | The backend you opened the page from uses another `MONGODB_URI` than the automation (for example a local backend on a test database). Use the page from the backend that runs on the automation's database. Start still works. |

