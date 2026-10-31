// downloadBriskPDF: three checks of the address our server got from ViewCertificate. Normally the first one finds the file.
// The fake Brisk here runs on 127.0.0.1; nothing leaves this machine.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { downloadBriskPDF } = require("../briskCertificate");

const PDF = Buffer.from("%PDF-1.4 a small certificate");
const dir = path.join(__dirname, "..", "brisk_certificates");
const fast = { checks: 3, waitMs: 5 };
let server;
let url;
let answers;
let asked;
let release;

test.before(async () => {
  server = http.createServer((req, res) => {
    asked += 1;
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === "hold") {
      res.writeHead(200);
      res.write(PDF.subarray(0, 8));
      release = () => res.end(PDF.subarray(8));
      return;
    }
    if (next === "cut") {
      res.writeHead(200);
      res.write("%PDF-half");
      setImmediate(() => res.destroy());
      return;
    }
    res.writeHead(next.status);
    res.end(next.body || "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/RSACERTIFICATES/x.pdf`;
});
test.after(() => server.close());

const files = [];
const fileFor = (name) => {
  const file = path.join(dir, `${name}.pdf`);
  files.push(file, `${file}.part`);
  return file;
};
test.afterEach(() => files.splice(0).forEach((f) => fs.rmSync(f, { force: true })));
test.beforeEach(() => {
  asked = 0;
});

const quiet = async (run) => {
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { result: await run(), lines };
  } catch (error) {
    return { error, lines };
  } finally {
    console.log = real;
  }
};

test("404 twice, then the file on the third check: it says so each time and saves the real file", async () => {
  answers = [{ status: 404 }, { status: 404 }, { status: 200, body: PDF }];
  const file = fileFor("TEST_WAIT_OK");
  const { result, lines, error } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_OK", fast));
  assert.equal(error, undefined);
  assert.equal(result, file);
  assert.equal(asked, 3);
  assert.deepEqual(fs.readFileSync(file), PDF);
  assert.equal(fs.existsSync(`${file}.part`), false);
  assert.equal(lines.filter((l) => /^⏳ Check \d of 3, not there yet\. Failed to download PDF\. Status: 404\. Next check in \d+ s\.\.\.$/.test(l)).length, 2);
});

test("the file there at the first check: one question, nothing more", async () => {
  answers = [{ status: 200, body: PDF }];
  fileFor("TEST_WAIT_NOW");
  const { lines, error } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_NOW", fast));
  assert.equal(error, undefined);
  assert.equal(asked, 1);
  assert.equal(lines.some((l) => /not there yet/.test(l)), false);
});

test("never made: exactly 3 checks and then it stops, with a clear sentence and no file", async () => {
  answers = [{ status: 404 }];
  const file = fileFor("TEST_WAIT_NEVER");
  const { error, lines } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_NEVER", { waitMs: 5 }));
  assert.equal(error.message, "Brisk had not made the PDF after 3 checks. Failed to download PDF. Status: 404. The server keeps trying and stores it on the policy.");
  assert.equal(asked, 3);
  assert.deepEqual(lines.slice(2).map((l) => l.replace(/ in \d+ s/, " in N s")), [
    "📥 Check 1 of 3...",
    "⏳ Check 1 of 3, not there yet. Failed to download PDF. Status: 404. Next check in N s...",
    "📥 Check 2 of 3...",
    "⏳ Check 2 of 3, not there yet. Failed to download PDF. Status: 404. Next check in N s...",
    "📥 Check 3 of 3...",
  ]);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test("the first check is at once: the server asked ViewCertificate before it answered, so the file is normally there", async () => {
  answers = [{ status: 200, body: PDF }];
  fileFor("TEST_WAIT_FIRST");
  const started = Date.now();
  const { error } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_FIRST", { checks: 3, waitMs: 3000 }));
  assert.equal(error, undefined);
  assert.equal(asked, 1);
  assert.ok(Date.now() - started < 1500, "no wait before it");
});

test("the checks are spaced out: a miss really waits before the next one", async () => {
  answers = [{ status: 404 }];
  fileFor("TEST_WAIT_GAP");
  const started = Date.now();
  await quiet(() => downloadBriskPDF(url, "TEST_WAIT_GAP", { checks: 3, waitMs: 100 }));
  assert.equal(asked, 3);
  assert.ok(Date.now() - started >= 190, "two waits between three checks");
});

test("a page that is not a PDF is never saved as the certificate: it keeps waiting for the real one", async () => {
  answers = [{ status: 200, body: "<html>Not found</html>" }, { status: 200, body: PDF }];
  const file = fileFor("TEST_WAIT_HTML");
  const { error } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_HTML", fast));
  assert.equal(error, undefined);
  assert.equal(asked, 2);
  assert.deepEqual(fs.readFileSync(file), PDF);
});

test("only a page that is not a PDF: no certificate file at all", async () => {
  answers = [{ status: 200, body: "<html>Not found</html>" }];
  const file = fileFor("TEST_WAIT_HTML2");
  const { error } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_HTML2", fast));
  assert.match(error.message, /did not answer with a PDF/);
  assert.equal(asked, 3);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test("a download cut half way is not kept as the certificate", async () => {
  answers = ["cut", { status: 200, body: PDF }];
  const file = fileFor("TEST_WAIT_CUT");
  const { error } = await quiet(() => downloadBriskPDF(url, "TEST_WAIT_CUT", fast));
  assert.equal(error, undefined);
  assert.deepEqual(fs.readFileSync(file), PDF);
});

test("while it downloads the certificate is not there under its real name, so a stop half way can never leave half a PDF", async () => {
  answers = ["hold"];
  const file = fileFor("TEST_WAIT_HOLD");
  const running = quiet(() => downloadBriskPDF(url, "TEST_WAIT_HOLD", fast));
  for (let i = 0; i < 200 && !fs.existsSync(`${file}.part`); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(`${file}.part`), true, "it is being written");
  assert.equal(fs.existsSync(file), false, "not under the real name yet");
  release();
  const { error } = await running;
  assert.equal(error, undefined);
  assert.deepEqual(fs.readFileSync(file), PDF);
  assert.equal(fs.existsSync(`${file}.part`), false);
});

test("Brisk's server unreachable: it is treated the same, retried and then reported", async () => {
  const dead = http.createServer();
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const port = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  fileFor("TEST_WAIT_DOWN");
  const { error, lines } = await quiet(() => downloadBriskPDF(`http://127.0.0.1:${port}/x.pdf`, "TEST_WAIT_DOWN", fast));
  assert.match(error.message, /^Brisk had not made the PDF after 3 checks/);
  assert.equal(lines.filter((l) => /not there yet/.test(l)).length, 2);
});

test("no address at all: refused at once, nothing is asked", async () => {
  await assert.rejects(downloadBriskPDF("", "TEST_WAIT_NONE", fast), /No download URL provided/);
});

test("the numbers in use: 3 checks a minute apart, and no gap reaches the stuck watch's 90 s", () => {
  const src = fs.readFileSync(require.resolve("../briskCertificate"), "utf8");
  assert.match(src, /const PDF_CHECKS = 3;/);
  assert.match(src, /const PDF_CHECK_EVERY_MS = 60 \* 1000;/);
  assert.match(src, /const PDF_READ_TIMEOUT_MS = 60 \* 1000;/);
  assert.match(fs.readFileSync(require.resolve("../lib/stallWatch"), "utf8"), /const STALL_LIMIT_MS = 90 \* 1000;/);
});

test("everyone downloads the same way: no flow has its own way of asking", () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const flows = ["fullPolicycompany/kshemaForm.js", "multiCompany/tpCompany/kshemaTP/kshemaTPForm.js", "fullPolicycompany/relianceForm.js", "multiCompany/common/reliance/relianceMultiForm.js", "fullPolicycompany/national.js"];
  for (const f of flows) assert.match(read(f), /await downloadBriskPDF\(\s*briskResult\.downloadUrl,\s*briskResult\.policyId\s*\)/, f);
  assert.match(read("lib/briskPartRunner.js"), /await brisk\.downloadBriskPDF\(url, certificateNo\)/);
});
