// United India: Generate Quote (its PDF) and Worksheet (its page), kept on the policy (the owner, 2026-11-13). A fake portal
// and a real temporary download folder; S3 and the database are replaced. No Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaQuote.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const quote = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaQuote");
const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");
const { scrollToEndInPage } = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaCompute");

const PDF = Buffer.from("%PDF-1.4\n% a quote\n%%EOF\n", "latin1");

/**
 * The Risk Details page after Compute Premium with Generate Quote and Worksheet.
 *   quoteAs:     "download" (default) | "pdfWindow" | "nothing"
 *   worksheetAs: "pageWindow" (default) | "download" | "nothing"
 *   printFails:  this Chrome cannot print
 *   alertOn:     "quote" -> the portal answers Generate Quote with a popup
 *   quoteAfterMs (+ clock): United India answers Generate Quote this long after the click; meanwhile it acts like ChromeDriver
 *     (real Chrome, 2026-11-13): the click and every look are HELD until the answer comes or the page-load limit runs out -
 *     past the limit the answer is CANCELLED (no file, ever). quoteFirstNothing: the first click does nothing at all
 */
function portal(dir, over = {}) {
  const st = { windows: ["main"], current: "main", clicks: { quote: 0, worksheet: 0 }, closed: [], scrolledAt: null, order: [], alerts: [], timers: [], mark: null, pageLoad: 300000, pendingUntil: null, onArrive: null, cancelled: 0, cancelledAt: null, clickLimit: null };
  const clockOf = over.clock || null;
  const held = () => {
    if (st.pendingUntil === null) return;
    const left = st.pendingUntil - clockOf.now();
    if (left <= st.pageLoad) {
      clockOf.advance(Math.max(0, left));
      st.pendingUntil = null;
      st.onArrive();
      return;
    }
    clockOf.advance(st.pageLoad);
    st.pendingUntil = null;
    st.cancelled += 1; // the answer is thrown away: no file will ever come
    st.cancelledAt = clockOf.now();
    throw Object.assign(new Error("timeout: Timed out receiving message from renderer"), { name: "TimeoutError" });
  };
  const later = (polls, fn) => st.timers.push({ polls, fn });
  const tick = () => {
    for (const t of st.timers) if (--t.polls === 0) t.fn();
  };
  const fire = (kind) => {
    st.clicks[kind] += 1;
    st.order.push(kind);
    const as = kind === "quote" ? over.quoteAs || "download" : over.worksheetAs || "pageWindow";
    if (over.alertOn === kind) return st.alerts.push("Premium not computed. Please compute premium first");
    if (kind === "quote" && over.quoteAfterMs) {
      if (over.quoteFirstNothing && st.clicks.quote === 1) return; // swallowed
      st.pendingUntil = clockOf.now() + over.quoteAfterMs;
      st.onArrive = () => fs.writeFileSync(path.join(dir, `quote-${Date.now()}.pdf`), PDF); // the download, whole
      return;
    }
    if (as === "download") {
      const name = `${kind}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(dir, `${name}.crdownload`), PDF.slice(0, 5)); // half there
      later(4, () => {
        fs.renameSync(path.join(dir, `${name}.crdownload`), path.join(dir, name));
        fs.writeFileSync(path.join(dir, name), PDF);
      });
    } else if (as === "pdfWindow") {
      later(2, () => st.windows.push("pdf"));
    } else if (as === "pageWindow") {
      later(2, () => st.windows.push("page"));
    }
  };
  const button = (kind) => ({
    async isDisplayed() {
      return st.current === "main";
    },
    async click() {
      st.clickLimit = st.pageLoad;
      fire(kind);
      held(); // ChromeDriver's click waits for the page it started
    },
  });
  const driver = {
    st,
    async findElements(locator) {
      const v = String((locator && locator.value) || "");
      if (/GenerateQuote|'quote'/.test(v)) return [button("quote")];
      if (/Worksheet|'worksheet'/.test(v)) return [button("worksheet")];
      return [];
    },
    async executeScript(script, ...args) {
      held();
      if (script === scrollToEndInPage) {
        st.scrolledAt = st.order.length;
        return 800;
      }
      if (script === nav.markPageInPage) {
        st.mark = args[0];
        return true;
      }
      if (script === nav.pageStateInPage) {
        tick();
        return { marked: st.current === "main" && st.mark === args[0], leaving: false, ready: "complete", url: "https://uiic/risk" };
      }
      if (script === quote.pageKindInPage) {
        if (st.current === "pdf") return { contentType: "application/pdf", url: "https://uiic/quote.pdf", ready: "complete", textLength: 0, title: "" };
        if (st.current === "page") return { contentType: "text/html", url: "https://uiic/worksheet", ready: "complete", textLength: 1200, title: "Worksheet" };
        return { contentType: "text/html", url: "https://uiic/risk", ready: "complete", textLength: 5000, title: "Risk Details" };
      }
      if (script === quote.pageHtmlInPage) return "<html><body>Worksheet table</body></html>";
      return null;
    },
    async executeAsyncScript(script) {
      if (script === quote.fetchSelfInPage) return { ok: true, type: "application/pdf", b64: PDF.toString("base64") };
      return null;
    },
    async printPage() {
      if (over.printFails) throw new Error("unknown error: PrintToPDF is not implemented");
      return PDF.toString("base64");
    },
    async getWindowHandle() {
      return st.current;
    },
    async getAllWindowHandles() {
      return st.windows.slice();
    },
    async close() {
      st.closed.push(st.current);
      st.windows = st.windows.filter((w) => w !== st.current);
    },
    navigate: () => ({ back: async () => {} }),
    manage: () => ({
      getTimeouts: async () => ({ pageLoad: st.pageLoad }),
      setTimeouts: async (t) => {
        if (t && t.pageLoad) st.pageLoad = t.pageLoad;
      },
    }),
    switchTo() {
      return {
        window: async (h) => {
          st.current = h;
        },
        alert: async () => {
          if (!st.alerts.length) throw new Error("no such alert");
          const text = st.alerts.shift();
          return { getText: async () => text, accept: async () => {} };
        },
      };
    },
    async sleep() {},
  };
  return driver;
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms), at: () => t, advance: (ms) => (t += ms) };
};

/** A temp download folder, the fake S3 and the fake database. */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiic-quote-"));
  const uploads = [];
  const saved = [];
  const deps = {
    upload: async (file, key) => {
      uploads.push({ key, bytes: fs.readFileSync(file) });
      return `https://s3.example/${key}`;
    },
    presign: async (key) => `https://s3.example/${key}?signed`,
    savePolicyFile: async (policyId, field, doc) => saved.push({ policyId, field, doc }),
  };
  return { dir, uploads, saved, deps, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const run = (driver, w, data = { _id: "6650aa" }, extra = {}, c = clock()) => {
  const lines = [];
  return { lines, c, go: () => quote.quoteAndWorksheet(driver, data, { ...c, ...extra, log: (l) => lines.push(String(l)), downloadDir: w.dir, jobId: "tp_united india_RAVI_1", deps: w.deps }) };
};

test("the page scrolled to its end, Generate Quote's DOWNLOAD (after its partial .crdownload) and the Worksheet's PAGE printed to PDF - both kept on the policy", async () => {
  const w = world();
  try {
    const driver = portal(w.dir);
    const { lines, go } = run(driver, w);
    const out = await go();
    assert.equal(driver.st.scrolledAt, 0, "scrolled before any button");
    assert.deepEqual(driver.st.order, ["quote", "worksheet"]);
    assert.equal(driver.st.clicks.quote, 1);
    assert.equal(driver.st.clicks.worksheet, 1);
    assert.deepEqual(w.saved.map((s) => [s.policyId, s.field]), [["6650aa", "quotePdf"], ["6650aa", "worksheetPdf"]]);
    assert.match(w.uploads[0].key, /^proposals\/united-india\/quote_tp_united_india_RAVI_1_\d+\.pdf$/);
    assert.match(w.uploads[1].key, /^proposals\/united-india\/worksheet_tp_united_india_RAVI_1_\d+\.pdf$/);
    assert.ok(w.uploads.every((u) => u.bytes.slice(0, 4).toString() === "%PDF"), "real PDFs");
    assert.ok(w.uploads[0].bytes.equals(PDF), "the whole downloaded file - never the half-written .crdownload");
    assert.deepEqual(Object.keys(out), ["quotePdf", "worksheetPdf"]);
    assert.equal(out.quotePdf.fileName, "united_india_quote_tp_united_india_RAVI_1.pdf");
    assert.match(out.quotePdf.presignedUrl, /signed$/);
    assert.deepEqual(driver.st.closed, ["page"], "the worksheet window closed");
    assert.equal(driver.st.current, "main", "back on the main page");
    assert.ok(lines.some((l) => /✓ United India - "Generate Quote": downloaded/.test(l)));
    assert.ok(lines.some((l) => /✓ United India - "Worksheet": the page "Worksheet" printed to PDF/.test(l)));
    assert.ok(lines.some((l) => /✅ United India - Quote PDF and Worksheet kept on the policy/.test(l)));
  } finally {
    w.done();
  }
});

test("a quote shown as a PDF in a new window: fetched there (the same login), the window closed", async () => {
  const w = world();
  try {
    const driver = portal(w.dir, { quoteAs: "pdfWindow" });
    const { lines, go } = run(driver, w);
    await go();
    assert.ok(lines.some((l) => /"Generate Quote": a PDF shown in a window, fetched there/.test(l)));
    assert.ok(driver.st.closed.includes("pdf"));
    assert.equal(w.uploads[0].bytes.slice(0, 4).toString(), "%PDF");
  } finally {
    w.done();
  }
});

test("United India answers Generate Quote in 6 s: the click waits under the 40 s (never 2 s) - the PDF kept, never cancelled", async () => {
  const w = world();
  try {
    const c = clock();
    const driver = portal(w.dir, { quoteAfterMs: 6000, clock: c });
    const out = await run(driver, w, { _id: "6650aa" }, {}, c).go();
    assert.equal(driver.st.cancelled, 0, "a 2 s limit threw this answer away in a real Chrome");
    assert.equal(driver.st.clickLimit, 40000, "the page-load limit at the click = the file's whole 40 s");
    assert.equal(driver.st.clicks.quote, 1);
    assert.ok(out.quotePdf && w.uploads[0].bytes.equals(PDF));
    assert.equal(driver.st.pageLoad, 300000, "the run's own limit is back");
  } finally {
    w.done();
  }
});

test("Generate Quote's answer starting LATE (the first click swallowed, the second at 5 s; none comes): cancelled AT 40 s, not 45", async () => {
  const w = world();
  try {
    const c = clock();
    const driver = portal(w.dir, { quoteAfterMs: 120000, quoteFirstNothing: true, clock: c });
    await assert.rejects(run(driver, w, { _id: "6650aa" }, {}, c).go(), (e) => e.code === "E301" && /no file came within 40 seconds/.test(e.message));
    assert.equal(driver.st.clicks.quote, 2);
    assert.equal(driver.st.cancelled, 1);
    assert.ok(driver.st.cancelledAt >= 39000 && driver.st.cancelledAt <= 41000, `cancelled at ${driver.st.cancelledAt} ms`);
  } finally {
    w.done();
  }
});

test("a Chrome that cannot print: the worksheet page itself is kept (.html), and said", async () => {
  const w = world();
  try {
    const driver = portal(w.dir, { printFails: true });
    const { lines, go } = run(driver, w);
    const out = await go();
    assert.match(out.worksheetPdf.key, /\.html$/);
    assert.ok(lines.some((l) => /could not print the page to PDF .* keeping the page itself/.test(l)));
  } finally {
    w.done();
  }
});

test("no file at all: clicked once more after 5 s, then [E301] at 40 s, nothing saved", async () => {
  const w = world();
  try {
    const driver = portal(w.dir, { quoteAs: "nothing" });
    const { c, go } = run(driver, w);
    await assert.rejects(go(), (e) => e.code === "E301" && /after "Generate Quote" was clicked no file came within 40 seconds/.test(e.message));
    assert.equal(driver.st.clicks.quote, 2);
    assert.ok(c.at() >= 40000 && c.at() < 41000);
    assert.equal(w.saved.length, 0);
  } finally {
    w.done();
  }
});

test("a popup after Generate Quote: [E308] in the portal's words", async () => {
  const w = world();
  try {
    const driver = portal(w.dir, { alertOn: "quote" });
    await assert.rejects(run(driver, w).go(), (e) => e.code === "E308" && /after "Generate Quote" the portal said "Premium not computed\. Please compute premium first"/.test(e.message));
  } finally {
    w.done();
  }
});

test("a job without a policy id: uploaded, said, nothing written to a policy", async () => {
  const w = world();
  try {
    const { lines, go } = run(portal(w.dir), w, {});
    await go();
    assert.equal(w.saved.length, 0);
    assert.equal(w.uploads.length, 2);
    assert.ok(lines.some((l) => /uploaded .* but this job has no policy to save it on/.test(l)));
  } finally {
    w.done();
  }
});

test("no download folder for this browser: a plain [E301]", async () => {
  const w = world();
  try {
    await assert.rejects(
      quote.quoteAndWorksheet(portal(w.dir), {}, { ...clock(), log() {}, downloadDir: null, deps: w.deps }),
      (e) => e.code === "E301" && /has no download folder/.test(e.message)
    );
  } finally {
    w.done();
  }
});

test("the owner's buttons", () => {
  assert.equal(quote.QUOTE.target[0], "img[src*='GenerateQuote']");
  assert.equal(quote.WORKSHEET.target[0], "img[src*='Worksheet.JPG']");
  assert.equal(quote.QUOTE.field, "quotePdf");
  assert.equal(quote.WORKSHEET.field, "worksheetPdf");
  assert.equal(quote.FILE_WAIT_MS, 40000);
});

test("ifShown: no Generate Quote on the page -> nothing clicked, null, said in the log (the handler tries after Update)", async () => {
  const w = world();
  try {
    const driver = portal(w.dir);
    driver.findElements = async () => []; // no buttons at all
    const lines = [];
    const out = await quote.quoteAndWorksheet(driver, {}, { ...clock(), log: (l) => lines.push(String(l)), downloadDir: w.dir, deps: w.deps, ifShown: true, where: "after Compute Premium" });
    assert.equal(out, null);
    assert.equal(w.uploads.length, 0);
    assert.ok(lines.some((l) => /no Generate Quote button after Compute Premium - the Quote PDF and Worksheet are not taken here/.test(l)));
  } finally {
    w.done();
  }
});

test("ifShown with the button there: taken as usual", async () => {
  const w = world();
  try {
    const out = await quote.quoteAndWorksheet(portal(w.dir), { _id: "6650aa" }, { ...clock(), log() {}, downloadDir: w.dir, deps: w.deps, ifShown: true });
    assert.deepEqual(Object.keys(out), ["quotePdf", "worksheetPdf"]);
  } finally {
    w.done();
  }
});
