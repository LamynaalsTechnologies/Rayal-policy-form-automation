// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaKycDocument.test.js
//
// fullPolicycompany/kshema/kshemaKycDocument.js — the Aadhaar the KSHEMA KYC page is given after the last-4-digits
// route is refused. The bug (2026-10-15): the portal could not read the automation's upload while the same picture
// uploaded by hand was accepted. Two defects, both pinned here:
//   1. the stored download link lives 5 minutes; an expired one makes S3 answer 403 + an XML body, which was saved as
//      "<random>.jpg" and uploaded as the Aadhaar (only "0 bytes" was refused);
//   2. the temp file was deleted 1.5 s after attaching it — BEFORE "Submit for Verification" is pressed, which is when
//      the page reads it for the upload.
//
// No real browser, no S3, no database. The download goes to a loopback HTTP server on 127.0.0.1; the KYC page is a
// fake driver on a virtual clock (sleeps cost nothing).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const ROOT = path.join(__dirname, "..");
const MODULE = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaKycDocument.js");
const QUOTE_ORIGINAL = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js");
const QUOTE_COPY = path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js");
const read = (file) => fs.readFileSync(file, "utf8");

const doc = require(MODULE);
const { fetchAadhaarDocument, uploadAadhaarForKyc, downloadToFile, KshemaDocumentError } = doc;

/** Silence the (very chatty) flow logging while fn runs. */
async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/* ----------------------- bytes ----------------------- */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900, 3)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(700, 5)]);
const S3_EXPIRED = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message>' +
    "<X-Amz-Expires>300</X-Amz-Expires><Expires>2026-10-15T04:00:00Z</Expires></Error>"
);

/** A loopback "storage": what each path answers. */
function startStorage() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (status, body, type) => {
      const headers = type ? { "Content-Type": type } : {};
      res.writeHead(status, headers);
      res.end(body);
    };
    switch (req.url.split("?")[0]) {
      case "/jpeg": return send(200, JPEG, "application/octet-stream");
      case "/png-labelled-jpeg": return send(200, PNG, "image/jpeg");
      case "/pdf-no-type": return send(200, PDF, null);
      case "/expired": return send(403, S3_EXPIRED, "application/xml");
      case "/missing": return send(404, "", null);
      case "/empty": return send(200, "", "image/jpeg");
      case "/html": return send(200, "<!doctype html><html><body>Sign in</body></html>", "text/html");
      case "/redirect-302": res.writeHead(302, { Location: "/jpeg" }); return res.end();
      case "/redirect-307": res.writeHead(307, { Location: "/jpeg" }); return res.end();
      case "/big": return send(200, Buffer.alloc(5000, 1), "image/jpeg");
      case "/hang": return undefined; // never answers
      default: return send(404, "nope", "text/plain");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, hits, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }) });
    });
  });
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "kshema-kyc-test-"));
const leftIn = (dir) => fs.readdirSync(dir);

/** fetchAadhaarDocument against the loopback storage. */
function fetchFrom(storage, dir, card, over = {}) {
  return fetchAadhaarDocument({
    aadharCard: card,
    jobId: "job1",
    deps: {
      tempDir: dir,
      mintLink: over.mintLink,
      download: over.download,
    },
  });
}

/* ----------------------- the download ----------------------- */

test("download: the picture's own bytes decide the extension, not the Content-Type or the stored name", async () => {
  const storage = await startStorage();
  try {
    for (const [route, expectedKind, expectedExt] of [
      ["/jpeg", "jpeg", ".jpg"],
      ["/png-labelled-jpeg", "png", ".png"],
      ["/pdf-no-type", "pdf", ".pdf"],
    ]) {
      const dir = tempDir();
      const got = await quiet(() =>
        fetchFrom(storage, dir, { key: "k", fileName: "scan.pdf" }, { mintLink: async () => storage.base + route })
      );
      assert.equal(got.kind, expectedKind, route);
      assert.equal(path.extname(got.filePath), expectedExt, `${route}: ${got.filePath}`);
      assert.ok(fs.existsSync(got.filePath), "the file is on disk, ready to be attached");
      assert.deepEqual(leftIn(dir), [path.basename(got.filePath)], "no .part file is left behind");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await storage.close();
  }
});

test("download: an expired link (S3 403 + XML) is refused with S3's own words — it is never 'uploaded'", async () => {
  const storage = await startStorage();
  const dir = tempDir();
  try {
    await assert.rejects(
      quiet(() => fetchFrom(storage, dir, { key: "k", fileName: "a.jpg" }, { mintLink: async () => storage.base + "/expired" })),
      (error) => {
        assert.ok(error instanceof KshemaDocumentError);
        assert.match(error.message, /S3 answered "AccessDenied - Request has expired" instead of the file even with a fresh link/);
        assert.match(error.message, /Nothing was uploaded to KSHEMA/);
        assert.equal(error.transient, false);
        assert.ok(!error.message.includes(":"), `the operator message is cut at the last colon: ${error.message}`);
        return true;
      }
    );
    assert.deepEqual(leftIn(dir), [], "the error body was not kept as a file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
});

test("download: the same expired answer from the STORED link does not claim a fresh link", async () => {
  const storage = await startStorage();
  const dir = tempDir();
  try {
    await assert.rejects(
      quiet(() => fetchFrom(storage, dir, { presignedUrl: storage.base + "/expired" })),
      (error) => {
        assert.match(error.message, /S3 answered "AccessDenied - Request has expired" instead of the file\./);
        assert.ok(!/fresh link/.test(error.message));
        return true;
      }
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
});

test("download: empty, HTML and a bare 404 are refused, each with its own sentence, nothing left on disk", async () => {
  const storage = await startStorage();
  try {
    const cases = [
      ["/empty", /is empty\./],
      ["/html", /is not a picture or a PDF \(it is html data, \d+ bytes\)/],
      ["/missing", /answered HTTP 404 instead of the file/],
    ];
    for (const [route, pattern] of cases) {
      const dir = tempDir();
      await assert.rejects(
        quiet(() => fetchFrom(storage, dir, { key: "k" }, { mintLink: async () => storage.base + route })),
        (error) => {
          assert.match(error.message, pattern, route);
          assert.ok(!error.message.includes(":"), error.message);
          return true;
        }
      );
      assert.deepEqual(leftIn(dir), [], route);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await storage.close();
  }
});

test("download: redirects are followed (302 and 307)", async () => {
  const storage = await startStorage();
  try {
    for (const route of ["/redirect-302", "/redirect-307"]) {
      const dir = tempDir();
      const got = await quiet(() => fetchFrom(storage, dir, { key: "k" }, { mintLink: async () => storage.base + route }));
      assert.equal(got.kind, "jpeg", route);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    await storage.close();
  }
});

test("download: a storage that never answers is a transient error after the time limit, not a hang", async () => {
  const storage = await startStorage();
  const dir = tempDir();
  try {
    await assert.rejects(
      quiet(() =>
        fetchFrom(storage, dir, { key: "k" }, {
          mintLink: async () => storage.base + "/hang",
          download: (url, dest) => downloadToFile(url, dest, { timeoutMs: 300 }),
        })
      ),
      (error) => {
        assert.match(error.message, /storage did not answer within 0 s|could not be downloaded from storage/);
        assert.equal(error.transient, true, "time could fix it, so the job may retry");
        return true;
      }
    );
    assert.deepEqual(leftIn(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
});

test("download: a file over the size ceiling is refused and not kept", async () => {
  const storage = await startStorage();
  const dir = tempDir();
  try {
    await assert.rejects(
      quiet(() =>
        fetchFrom(storage, dir, { key: "k" }, {
          mintLink: async () => storage.base + "/big",
          download: (url, dest) => downloadToFile(url, dest, { maxBytes: 1000 }),
        })
      ),
      /larger than/
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(leftIn(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
});

test("link: a FRESH link minted from the key is used; the stored 5-minute link is only a fallback", async () => {
  const storage = await startStorage();
  const dir = tempDir();
  try {
    const mints = [];
    const got = await quiet(() =>
      fetchFrom(
        storage,
        dir,
        { key: "aadhaar/key.jpg", presignedUrl: storage.base + "/expired", fileName: "a.jpg" },
        { mintLink: async (key) => { mints.push(key); return storage.base + "/jpeg"; } }
      )
    );
    assert.deepEqual(mints, ["aadhaar/key.jpg"]);
    assert.equal(got.fresh, true);
    assert.equal(got.source, "fresh");
    assert.ok(!storage.hits.includes("/expired"), "the stored (expired) link was never fetched");

    // minting fails -> the stored link is used
    const dir2 = tempDir();
    const fallback = await quiet(() =>
      fetchFrom(
        storage,
        dir2,
        { key: "k", presignedUrl: storage.base + "/jpeg" },
        { mintLink: async () => { throw new Error("no credentials"); } }
      )
    );
    assert.equal(fallback.source, "stored");
    assert.equal(fallback.fresh, false);
    fs.rmSync(dir2, { recursive: true, force: true });

    // nothing at all
    await assert.rejects(quiet(() => fetchFrom(storage, dir, {})), /No Aadhaar card image is on file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
});

/* ----------------------- the KYC page ----------------------- */

/**
 * A KSHEMA KYC page, as far as the upload recovery sees it:
 *   card (the "No record found" hand-off) --Try with different document--> upload panel
 *   upload panel --attach--> --Submit for Verification--> OCR --> review screen | the portal's refusal
 *   review screen --Details are correct - Verify--> done
 * Time is virtual: driver.sleep() advances the clock the module reads through Date.now().
 */
function fakeKycPage({
  ocr = "ok",
  refusalText = "Unable to read the document",
  echoFileName = false,
  submitLiveAfterMs = 0,
  // what the page does AFTER "Details are correct - Verify": "clean" (done), "gender-mismatch" (blank for 3 s, then the
  // DigiLocker card with the verdict), "tab-closed" (the portal closes the tab: reading it throws)
  afterVerify = "clean",
} = {}) {
  const state = {
    phase: "card", // card | upload | ocr | review | done
    clicks: [],
    attached: "",
    fileExistedAtSubmit: null,
    fileSizeAtSubmit: null,
    offset: 0,
    ocrDoneAt: 0,
    verifiedAt: 0,
    attachedAt: 0,
    sleeps: 0,
  };
  const realNow = Date.now;
  const now = () => realNow() + state.offset;
  Date.now = now;

  const reviewReady = () => state.phase === "ocr" && now() >= state.ocrDoneAt && ocr === "ok";
  const refused = () => state.phase === "ocr" && now() >= state.ocrDoneAt && ocr === "refuse";
  if (false) void reviewReady;

  const button = (label, shown, onClick, enabled = () => true) => ({
    label,
    async isDisplayed() { return shown(); },
    async isEnabled() { return enabled(); },
    async getAttribute(name) { return name === "aria-disabled" ? String(!enabled()) : null; },
    async getText() { return label; },
    async click() { state.clicks.push(label); onClick(); },
  });

  const tryBtn = button("Try with different document", () => state.phase === "card", () => { state.phase = "upload"; });
  const submitBtn = button(
    "Submit for Verification",
    () => state.phase === "upload",
    () => {
      state.fileExistedAtSubmit = fs.existsSync(state.attached);
      state.fileSizeAtSubmit = state.fileExistedAtSubmit ? fs.statSync(state.attached).size : -1;
      state.phase = "ocr";
      state.ocrDoneAt = now() + 3000;
    },
    () => !!state.attached && now() >= state.attachedAt + submitLiveAfterMs
  );
  const verifyBtn = button("Details are correct - Verify", () => state.phase === "ocr", () => {
    state.phase = "done";
    state.verifiedAt = now();
  });
  const combo = { async getText() { return "Aadhaar card"; }, async click() {}, async isDisplayed() { return true; } };
  const fileInput = {
    async isDisplayed() { return false; },
    async sendKeys(p) {
      state.attached = p;
      state.attachedAt = now();
      state.clicks.push("attach");
    },
  };

  const driver = {
    state,
    restoreClock() { Date.now = realNow; },
    async sleep(ms) { state.sleeps += 1; state.offset += ms; },
    async wait(condition, timeoutMs, message) {
      const deadline = now() + timeoutMs;
      while (true) {
        const value = await condition();
        if (value) return value;
        if (now() >= deadline) throw new Error(message || "wait timed out");
        state.offset += 250;
      }
    },
    async findElements(locator) {
      const value = String(locator && locator.value);
      if (value.includes("try with different document")) return state.phase === "card" ? [tryBtn] : [];
      if (value.includes("select-trigger")) return state.phase === "upload" ? [combo] : [];
      if (value.includes("@role=\"option\"")) return [];
      if (value.includes("input[type='file']")) return state.phase === "upload" ? [fileInput] : [];
      if (value.includes("submit for verification")) return state.phase === "upload" ? [submitBtn] : [];
      if (value.includes("details are correct")) return reviewReady() ? [verifyBtn] : [];
      return [];
    },
    async executeScript(script, ...args) {
      const text = String(script);
      if (text.includes("near(live[k])")) return state.phase === "upload" ? fileInput : null; // PICK_FILE_INPUT_IN_PAGE
      if (text.includes("f[0].name")) {
        return state.attached
          ? { count: 1, name: path.basename(state.attached), size: fs.existsSync(state.attached) ? fs.statSync(state.attached).size : -1, accept: "image/*,.pdf", multiple: false }
          : { count: 0, name: "", size: -1, accept: "image/*,.pdf", multiple: false };
      }
      if (text.includes("indexOf(needle)")) return echoFileName && !!state.attached;
      if (text.includes(".click()") && args[0] && args[0].click) await args[0].click();
      return undefined;
    },
  };

  // what the page's own error reader says: the hand-off card's text all along, the refusal once OCR has refused
  const readKycError = async () => {
    if (state.phase === "done") {
      if (afterVerify === "tab-closed") throw new Error("no such window: target window already closed");
      if (afterVerify === "gender-mismatch" && now() >= state.verifiedAt + 3000) return GENDER_TEXT;
      return null;
    }
    if (refused()) return refusalText;
    return state.phase === "card" || state.phase === "upload" || state.phase === "ocr" ? "No record found" : null;
  };
  return { driver, state, readKycError };
}

const GENDER_TEXT = "The gender on your document doesn't match your profile. We'll verify you through DigiLocker instead.";

/** Run one upload on the fake page, the storage serving `route`. */
async function runUpload(opts = {}) {
  const storage = await startStorage();
  const dir = tempDir();
  const page = fakeKycPage(opts.page || {});
  try {
    const result = await quiet(() =>
      uploadAadhaarForKyc(
        page.driver,
        { aadharCard: { key: "k", presignedUrl: storage.base + "/expired", fileName: "aadhaar.jpg" } },
        "job1",
        {
          readKycError: page.readKycError,
          deps: {
            fetchDocument: (args) =>
              fetchAadhaarDocument({
                ...args,
                deps: { tempDir: dir, mintLink: async () => storage.base + (opts.route || "/jpeg") },
              }),
          },
        }
      )
    );
    return { result, state: page.state, dir, storage, leftover: leftIn(dir) };
  } finally {
    page.driver.restoreClock();
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
}

test("upload: the file is STILL THERE when Submit for Verification is pressed, and gone only after (the 1.5 s unlink bug)", async () => {
  const run = await runUpload();
  assert.equal(run.result.ok, true, run.result.error);
  assert.equal(run.state.fileExistedAtSubmit, true, "the page reads the file at Submit — it must exist then");
  assert.equal(run.state.fileSizeAtSubmit, JPEG.length, "and be the whole picture, not an error body");
  assert.deepEqual(run.leftover, [], "removed once the portal is done with it");
  assert.deepEqual(run.state.clicks, ["Try with different document", "attach", "Submit for Verification", "Details are correct - Verify"]);
  assert.ok(path.basename(run.state.attached).startsWith("aadhaar_") && run.state.attached.endsWith(".jpg"));
});

test("upload: an expired link is refused BEFORE the portal is touched (nothing clicked, nothing attached)", async () => {
  const storage = await startStorage();
  const dir = tempDir();
  const page = fakeKycPage();
  try {
    const result = await quiet(() =>
      uploadAadhaarForKyc(page.driver, { aadharCard: { key: "k" } }, "job1", {
        readKycError: page.readKycError,
        deps: {
          fetchDocument: (args) =>
            fetchAadhaarDocument({ ...args, deps: { tempDir: dir, mintLink: async () => storage.base + "/expired" } }),
        },
      })
    );
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, /S3 answered "AccessDenied - Request has expired"/);
    assert.deepEqual(page.state.clicks, [], "the portal was never touched");
    assert.deepEqual(leftIn(dir), []);
  } finally {
    page.driver.restoreClock();
    fs.rmSync(dir, { recursive: true, force: true });
    await storage.close();
  }
});

test("upload: when the portal refuses the document its OWN words come back at once (not a 40 s generic timeout)", async () => {
  const before = Date.now();
  const run = await runUpload({ page: { ocr: "refuse", refusalText: "Unable to read the document. Please upload a clear image." } });
  assert.equal(run.result.ok, false);
  assert.equal(run.result.retryable, false);
  assert.equal(run.result.kycStatus, "Unable to read the document. Please upload a clear image.");
  assert.match(run.result.error, /The KSHEMA KYC page refused the uploaded document - it said "Unable to read the document\. Please upload a clear image\."/);
  assert.ok(Date.now() - before < 20000, "well inside the 40 s wait");
  assert.deepEqual(run.leftover, [], "the temp file is removed on a refusal too");
  assert.equal(run.state.fileExistedAtSubmit, true);
});

test("upload: the hand-off card's own 'No record found' (already on the page) is not mistaken for a refusal", async () => {
  // readKycError says "No record found" for the whole run until OCR finishes; the upload must wait it out and succeed
  const run = await runUpload({ page: { ocr: "ok" } });
  assert.equal(run.result.ok, true, run.result.error);
});

test("upload: Submit that stays disabled is waited for, then used once the page makes it live", async () => {
  const run = await runUpload({ page: { submitLiveAfterMs: 4000 } });
  assert.equal(run.result.ok, true, run.result.error);
  assert.ok(run.state.sleeps > 1, "it waited rather than pressing a dead button");
  assert.equal(run.state.fileExistedAtSubmit, true);
});

test("upload: a Submit that never becomes live is reported (not pressed blind), and the file is cleaned up", async () => {
  const run = await runUpload({ page: { submitLiveAfterMs: 10 * 60 * 1000 } });
  assert.equal(run.result.ok, false);
  assert.match(run.result.error, /did not make Submit for Verification available after the Aadhaar was attached/);
  assert.ok(!run.state.clicks.includes("Submit for Verification"));
  assert.deepEqual(run.leftover, []);
});

test("upload: a PDF stored under a .jpg name is attached with a .pdf name", async () => {
  const run = await runUpload({ route: "/pdf-no-type" });
  assert.equal(run.result.ok, true, run.result.error);
  assert.ok(run.state.attached.endsWith(".pdf"), run.state.attached);
});

/* ----------------------- wiring ----------------------- */

test("wiring: both quote forms delegate to the shared module, identically, and the old downloader is gone", () => {
  for (const file of [QUOTE_ORIGINAL, QUOTE_COPY]) {
    const text = read(file);
    assert.ok(!/downloadAadharCardImage/.test(text), `${path.basename(file)}: the old downloader is gone`);
    assert.ok(!/fs\.unlink\(absoluteFilePath/.test(text), `${path.basename(file)}: no unlink right after attaching`);
    assert.match(text, /\.uploadAadhaarForKyc\(driver, data, jobId, \{ readKycError \}\)/);
    assert.match(text, /^  recoverKycWithDocumentUpload,$/m, "exported for tests");
  }
});

test("wiring: the shared module removes the temp file in a finally, after the portal outcome — never right after attaching", () => {
  const text = read(MODULE);
  const attach = text.indexOf("await fileInput.sendKeys(doc.filePath)");
  const finallyAt = text.indexOf("} finally {", attach);
  const discard = text.indexOf("discardDocument(doc);", finallyAt);
  assert.ok(attach > 0 && finallyAt > attach && discard > finallyAt, "discard is in the finally after the attach");
  assert.equal(text.slice(attach, finallyAt).includes("discardDocument("), false, "nothing discards the file between attach and the outcome");
  assert.equal(/fs\.unlink\(/.test(text.slice(attach, finallyAt)), false);
});

/* ---- the verdict that comes AFTER Verify (the "gender doesn't match" run, 2026-10-15) ---- */

test("verify: the review screen going away is not success — the gender-mismatch verdict drawn 3 s later is caught and reported in the portal's words", async () => {
  const { result, state } = await runUpload({ page: { afterVerify: "gender-mismatch" } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.retryable, false);
  assert.equal(result.kycStatus, GENDER_TEXT);
  assert.match(result.error, /^KYC validation error - KSHEMA said "The gender on your document doesn't match your profile\./);
  assert.match(result.error, /Correct the customer's gender, name or date of birth on the policy/);
  assert.match(result.error, /left open on screen\.$/);
  assert.ok(state.clicks.includes("Details are correct - Verify"), "it did get as far as Verify");
});

test("verify: a KYC that really finished stays clean for the whole settle window and is accepted", async () => {
  const { result, state } = await runUpload({ page: { afterVerify: "clean" } });
  assert.deepEqual(result, { ok: true, settled: true });
  assert.ok(state.offset >= 10000, `it waited out the settle window (${state.offset} ms of fake time)`);
});

test("verify: the portal closing the KYC tab is not a refusal", async () => {
  const { result } = await runUpload({ page: { afterVerify: "tab-closed" } });
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("verify: KSHEMA_KYC_SETTLE_ENABLED=false is the old behaviour (one look, then ok) — the way back", async () => {
  const before = process.env.KSHEMA_KYC_SETTLE_ENABLED;
  process.env.KSHEMA_KYC_SETTLE_ENABLED = "false";
  try {
    const { result } = await runUpload({ page: { afterVerify: "gender-mismatch" } });
    assert.equal(result.ok, true, "the verdict arrives after the single look");
  } finally {
    if (before === undefined) delete process.env.KSHEMA_KYC_SETTLE_ENABLED;
    else process.env.KSHEMA_KYC_SETTLE_ENABLED = before;
  }
});

test("verify: KSHEMA_KYC_SETTLE_MS is kept within 3 and 30 seconds", async () => {
  const before = process.env.KSHEMA_KYC_SETTLE_MS;
  try {
    process.env.KSHEMA_KYC_SETTLE_MS = "100"; // asks for 0.1 s: raised to 3 s, so the 3 s verdict is still seen
    const { result } = await runUpload({ page: { afterVerify: "gender-mismatch" } });
    assert.equal(result.ok, false);
  } finally {
    if (before === undefined) delete process.env.KSHEMA_KYC_SETTLE_MS;
    else process.env.KSHEMA_KYC_SETTLE_MS = before;
  }
});

test("verify: an Aadhaar-detail mismatch gets the 'correct it on the policy' advice; anything else the image advice", () => {
  const { kycValidationMessage } = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaKycDocument.js"));
  assert.match(kycValidationMessage("Name does not match"), /Correct the customer's gender, name or date of birth/);
  const other = kycValidationMessage("Verification failed");
  assert.match(other, /Check the customer's Aadhaar card image/);
  assert.ok(!/:/.test(kycValidationMessage("Error: bad : colon")), "no colon survives into the sentence");
});

test("wiring: both quote forms settle before leaving the KYC tab, and know the portal's mismatch wording", () => {
  for (const file of [
    path.join(ROOT, "fullPolicycompany", "kshema", "kshemaQuoteForm.js"),
    path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPQuoteForm.js"),
  ]) {
    const src = read(file);
    assert.ok(src.includes("settleKycOutcome(driver, { readKycError })"), `${path.basename(file)}: late look settles`);
    assert.ok(src.includes("kycValidationMessage(lateError)"), `${path.basename(file)}: validation sentence`);
    for (const marker of ["doesn't match", "does not match", "verify you through digilocker"]) {
      assert.ok(src.includes(`"${marker}"`), `${path.basename(file)}: marker ${marker}`);
    }
  }
});
