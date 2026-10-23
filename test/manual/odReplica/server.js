// A tiny static server for the replica site (the page and its Form 60 iframe are the same origin, like the portal's).
const http = require("http"), fs = require("fs"), path = require("path");
function start() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(__dirname, "site", req.url.split("?")[0].replace(/^\//, "") || "index.html");
      if (!file.startsWith(path.join(__dirname, "site")) || !fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}
module.exports = { start };
