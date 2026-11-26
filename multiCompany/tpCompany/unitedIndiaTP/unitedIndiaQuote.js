/**
 * United India, after Compute Premium (the owner, 2026-11-13): the Quote PDF and the Worksheet, kept on the policy.
 *   (the page)       scrolled down to its very end
 *   Generate Quote   <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/GenerateQuote.JPG" onclick="fnSubmit('quote')">
 *                    -> the quote PDF
 *   Worksheet        <img src="/GCWebPortal/html/app1/images/Ashok_Leyland/Worksheet.JPG" onclick="fnSubmit('worksheet')">
 *                    -> "a new page opens" - kept as a PDF
 * Each file is uploaded to S3 (proposals/united-india/, like KSHEMA's proposal PDF) and saved on the policy - `quotePdf`,
 * `worksheetPdf` ({ fileName, key, location, presignedUrl }), shown on the policy's View page under Files.
 *
 * How a file is taken - whichever the portal does (not seen live yet):
 *   - a DOWNLOAD: the job's browser saves PDFs straight to its own folder (kshemaBrowserConfig: no prompt, PDFs never opened
 *     in a viewer); a new complete file there (not .crdownload, its size steady) is the file;
 *   - a NEW WINDOW with a PDF: fetched inside that window (the same login), then the window is closed;
 *   - a NEW WINDOW with a web page (the worksheet): printed to PDF (WebDriver's print); when this Chrome cannot print, the
 *     page itself is kept (.html). The window is closed and the run goes back to the main page;
 *   - the SAME window moving to the file: taken the same way, then back.
 * Before each click the portal must be ready (its loader, its requests - ./unitedIndiaSteps.js waitPortalReady), the button
 * is clicked ONCE (./unitedIndiaNavigate.js clickOnce; a second click only when nothing at all happened in 5 s), a popup is
 * read first ([E308] in its words), and at most 40 s are waited for the file (the owner's loader rule), else [E301].
 */
const fs = require("fs");
const path = require("path");
const { By } = require("selenium-webdriver");
const { MultiCompanyError } = require("../../common/errors");
const { throwIfHeld } = require("../../../lib/holdStop");
const { waitForShown, showOnScreen, notVisible, popupOr, waitPortalReady, alertRefusal, VIDEO_PAUSE_MS } = require("./unitedIndiaSteps");
const nav = require("./unitedIndiaNavigate");
const { scrollToEndInPage, GENERATE_QUOTE } = require("./unitedIndiaCompute");
const { firstVisible } = require("../../common/elements");

const STAGE = "united-india-quote";
const QUOTE = {
  label: "Generate Quote",
  target: GENERATE_QUOTE, // the same button Compute Premium waits for (./unitedIndiaCompute.js)
  field: "quotePdf",
  kind: "quote",
};
const WORKSHEET = {
  label: "Worksheet",
  target: ["img[src*='Worksheet.JPG']", "img[onclick*=\"fnSubmit('worksheet')\"]", By.xpath("//img[contains(@src,'Worksheet') or contains(@onclick,\"'worksheet'\")]")],
  field: "worksheetPdf",
  kind: "worksheet",
};
/** The longest a file may take (the owner's loader rule, 40 s). */
const FILE_WAIT_MS = 40000;
const POLL_MS = 250;
/** A new window is given this long to turn into a download (a PDF opened in a tab is saved, not shown) before it is read. */
const WINDOW_SETTLE_MS = 3000;

/** The finished files in the download folder (no partial .crdownload / .tmp), with their sizes. */
function filesIn(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => !/\.(crdownload|tmp|part)$/i.test(n) && !n.startsWith("."))
      .map((n) => {
        try {
          return { name: n, size: fs.statSync(path.join(dir, n)).size };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** In a page: what it is - a PDF, or a web page with content. */
function pageKindInPage() {
  var body = document.body ? (document.body.innerText || "").trim() : "";
  return { contentType: String(document.contentType || ""), url: String(location.href), ready: document.readyState, textLength: body.length, title: String(document.title || "") };
}

/** In a page: its own address fetched with its login, as base64 (a PDF shown in a window). */
function fetchSelfInPage(done) {
  fetch(location.href, { credentials: "include" })
    .then(function (r) {
      return r.arrayBuffer().then(function (b) {
        var bytes = new Uint8Array(b);
        var s = "";
        for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        done({ ok: r.ok, type: r.headers.get("content-type") || "", b64: btoa(s) });
      });
    })
    .catch(function (e) {
      done({ ok: false, error: String(e) });
    });
}

/** In a page: the whole page as HTML, with its address as the base (its images and styles still load when opened). */
function pageHtmlInPage() {
  var html = document.documentElement ? document.documentElement.outerHTML : "";
  return '<base href="' + String(location.href).replace(/"/g, "&quot;") + '">' + html;
}

const isPdf = (buf) => !!buf && buf.length > 4 && buf.slice(0, 4).toString("latin1") === "%PDF";

/**
 * Read the page the driver is on into a file in `dir`: a PDF as it is, a web page printed to PDF (or kept as .html when this
 * Chrome cannot print).
 * @returns {Promise<{ path: string, how: string } | null>} null = nothing to read (blank, still loading)
 */
async function takePage(driver, dir, kind, log) {
  const page = await driver.executeScript(pageKindInPage).catch(() => null);
  if (!page || page.ready !== "complete" || /^about:blank/.test(page.url)) return null;
  const stamp = Date.now();
  if (/pdf/i.test(page.contentType)) {
    const got = await driver.executeAsyncScript(fetchSelfInPage).catch(() => null);
    const buf = got && got.b64 ? Buffer.from(got.b64, "base64") : null;
    if (!isPdf(buf)) return null;
    const file = path.join(dir, `${kind}_${stamp}.pdf`);
    fs.writeFileSync(file, buf);
    return { path: file, how: "a PDF shown in a window, fetched there" };
  }
  if (page.textLength === 0) return null;
  try {
    const b64 = await driver.printPage({ background: true });
    const buf = Buffer.from(String(b64 || ""), "base64");
    if (isPdf(buf)) {
      const file = path.join(dir, `${kind}_${stamp}.pdf`);
      fs.writeFileSync(file, buf);
      return { path: file, how: `the page "${page.title}" printed to PDF` };
    }
  } catch (e) {
    log(`   this Chrome could not print the page to PDF (${String((e && e.message) || e).split("\n")[0]}) - keeping the page itself`);
  }
  const html = await driver.executeScript(pageHtmlInPage).catch(() => "");
  if (!html) return null;
  const file = path.join(dir, `${kind}_${stamp}.html`);
  fs.writeFileSync(file, html, "utf8");
  return { path: file, how: `the page "${page.title}" kept as a web page` };
}

/**
 * Click the button and take the file it gives (download, new window, same window) - at most 40 s.
 * @returns {Promise<{ path: string, how: string, clicks: number }>}
 */
async function fileFromButton(driver, { label, target, kind, downloadDir }, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const now = o.now || Date.now;
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  const waitMs = o.fileWaitMs || FILE_WAIT_MS;
  const refuse = popupOr(label, STAGE);
  if (!downloadDir) throw new MultiCompanyError("E301", `United India - the browser has no download folder, so "${label}" cannot be kept. It will try again shortly.`, { company: "united india", stage: STAGE });
  fs.mkdirSync(downloadDir, { recursive: true });

  const img = await waitForShown(driver, target, 10000, o);
  if (!img) throw notVisible(label, 10, STAGE);
  await showOnScreen(driver, img, o, label).catch(refuse);
  await waitPortalReady(driver, img, { label, stage: STAGE }, o);
  const before = new Set(filesIn(downloadDir).map((f) => f.name));
  const main = await driver.getWindowHandle().catch(() => null);
  const handlesBefore = (await driver.getAllWindowHandles().catch(() => null)) || [];
  const token = `uiic-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  await driver.executeScript(nav.markPageInPage, token).catch(refuse);
  log(`📥 United India - "${label}": waiting for its file (up to ${waitMs / 1000} seconds)`);

  const limitBefore = await nav.pageLoadLimit(driver, waitMs); // the file's page is waited for, not cancelled (see unitedIndiaNavigate.js)
  const sizes = {};
  let clicks = 1;
  let windowSince = null;
  let other = null; // the new window
  let got = null;
  try {
    const start = now();
    const onItsWay = () => log(`   ${Math.round((now() - start) / 1000)} s after "${label}": its file is on its way - United India is still answering`);
    const everyMs = o.onItsWayLineMs || nav.ON_ITS_WAY_LINE_MS;
    let { pending } = await nav.sayWhileHeld(nav.clickOnce(driver, img, { label, stage: STAGE, log, o }), everyMs, onItsWay).catch(refuse);
    while (!got) {
      throwIfHeld(driver);
      await nav.limitToTimeLeft(driver, waitMs - (now() - start)); // a slow answer is waited for until the time is up
      // a popup FIRST (any other command would close it with Cancel)
      const popup = await nav.sayWhileHeld(nav.readOpenAlert(driver), everyMs, onItsWay);
      if (popup) {
        await popup.accept().catch(() => {});
        throw alertRefusal(label, popup.text, STAGE);
      }
      // a download: a new finished file whose size held steady since the last look
      for (const f of filesIn(downloadDir)) {
        if (before.has(f.name) || f.size === 0) continue;
        if (sizes[f.name] === f.size) {
          got = { path: path.join(downloadDir, f.name), how: "downloaded" };
          break;
        }
        sizes[f.name] = f.size;
      }
      if (got) break;
      // a new window
      if (!other) {
        const handles = await driver.getAllWindowHandles().catch(() => null);
        const added = (handles || []).filter((h) => !handlesBefore.includes(h));
        if (added.length) {
          other = added[added.length - 1];
          windowSince = now();
          pending = true;
          log("   a new window opened - looking at what it shows");
        }
      }
      if (other && now() - windowSince >= WINDOW_SETTLE_MS) {
        const open = await driver.getAllWindowHandles().catch(() => []);
        if (open.includes(other)) {
          await driver.switchTo().window(other);
          got = await takePage(driver, downloadDir, kind, log).catch(() => null);
          if (got) {
            await driver.close().catch(() => {});
            if (main) await driver.switchTo().window(main).catch(() => {});
            break;
          }
          if (main) await driver.switchTo().window(main).catch(() => {});
        }
      }
      // the same window moved to the file
      const page = await nav.sayWhileHeld(
        driver.executeScript(nav.pageStateInPage, token).catch((e) => {
          if (nav.isPageLoadWait(e)) pending = true;
          return null;
        }),
        everyMs,
        onItsWay
      );
      if (page && !page.marked && page.ready === "complete") {
        got = await takePage(driver, downloadDir, kind, log).catch(() => null);
        if (got) {
          await driver.navigate().back().catch(() => {});
          log("   the file had opened in this window - went back to the page");
          break;
        }
      }
      if (page && page.leaving) pending = true;

      const waited = now() - start;
      if (waited >= waitMs) {
        await driver.executeScript("window.stop();").catch(() => {});
        throw new MultiCompanyError(
          "E301",
          `United India - after "${label}" was clicked no file came within ${waitMs / 1000} seconds (no download, no new window), so the run stopped there. It will try again shortly.`,
          { company: "united india", stage: STAGE }
        );
      }
      // nothing at all after 5 s (no download starting, no window, no page change): once more
      if (clicks === 1 && !pending && !other && !Object.keys(sizes).length && waited >= nav.RECLICK_AFTER_MS && page && page.marked) {
        const again = await waitForShown(driver, target, 1000, o);
        if (again) {
          log(`↻ United India - "${label}" was clicked but nothing came after ${nav.RECLICK_AFTER_MS / 1000} seconds - clicking it once more`);
          await waitPortalReady(driver, again, { label, stage: STAGE }, o);
          ({ pending } = await nav.clickOnce(driver, again, { label, stage: STAGE, log, o }).catch(refuse));
          clicks = 2;
        }
      }
      await sleep(driver, POLL_MS);
    }
  } finally {
    if (limitBefore) await nav.pageLoadLimit(driver, limitBefore);
  }
  const size = fs.statSync(got.path).size;
  log(`✓ United India - "${label}": ${got.how} (${Math.round(size / 1024)} KB)`);
  return { ...got, clicks, size };
}

/** Upload the file and save it on the policy; `deps` replace S3 and the database in tests. */
async function keepOnPolicy(file, { field, kind, data, jobId }, { upload, presign, savePolicyFile, log }) {
  const ext = path.extname(file.path) || ".pdf";
  const fileName = `united_india_${kind}_${String(jobId || "job").replace(/[^A-Za-z0-9_-]+/g, "_")}${ext}`;
  const key = `proposals/united-india/${kind}_${String(jobId || "job").replace(/[^A-Za-z0-9_-]+/g, "_")}_${Date.now()}${ext}`;
  const location = await upload(file.path, key);
  const presignedUrl = await presign(key).catch(() => null);
  const doc = { fileName, key, location, presignedUrl };
  const policyId = data && (data._id || data.policyId || data.captchaId);
  if (policyId) {
    await savePolicyFile(policyId, field, doc);
    log(`☁️  United India - ${kind === "quote" ? "Quote PDF" : "Worksheet"} kept on the policy (${key})`);
  } else {
    log(`⚠️ United India - ${kind === "quote" ? "Quote PDF" : "Worksheet"} uploaded (${key}) but this job has no policy to save it on`);
  }
  return doc;
}

/** The policy's file field, written straight to the onlinePolicy collection (KSHEMA's proposal PDF is saved the same way). */
async function defaultSavePolicyFile(policyId, field, doc) {
  const { MongoClient, ObjectId } = require("mongodb");
  const client = require("../../../lib/sharedDb").clientFor(MongoClient, process.env.MONGODB_URI || "mongodb://localhost:27017/rayal"); // the server's open connection when there is one (speed round 4)
  try {
    await client.connect();
    const id = typeof policyId === "string" ? new ObjectId(policyId) : policyId;
    await client.db().collection("onlinePolicy").updateOne({ _id: id }, { $set: { [field]: doc, updatedAt: new Date() } });
  } finally {
    await client.close().catch(() => {});
  }
}

/** How long the Generate Quote button is looked for when the step is only taken if it shows (`ifShown`). */
const LOOK_MS = 3000;

/**
 * The page's end, Generate Quote (its PDF), then Worksheet (its page) - both kept on the policy.
 * `ifShown`: the owner's live runs never showed Generate Quote right after Compute Premium, so the handler takes this step
 * where the button IS (before Update, else after it): with `ifShown` a page without the button returns null (said in the log)
 * instead of stopping the run.
 * @param {WebDriver} driver   on Risk Details after Compute Premium (or the page after Update)
 * @param {Object} data        the job data (_id: the policy)
 * @param {{ log?, now?, sleep?, downloadDir, jobId?, ifShown?, where?, deps?: { upload, presign, savePolicyFile } }} [o]
 * @returns {Promise<{ quotePdf, worksheetPdf } | null>}
 */
async function quoteAndWorksheet(driver, data = {}, o = {}) {
  const log = o.log || ((line) => console.log(line));
  const sleep = o.sleep || ((d, ms) => d.sleep(ms));
  if (o.ifShown) {
    const now = o.now || Date.now;
    const until = now() + LOOK_MS;
    let shown = null;
    for (;;) {
      shown = await firstVisible(driver, QUOTE.target).catch(() => null);
      if (shown || now() >= until) break;
      await sleep(driver, 250);
    }
    if (!shown) {
      log(`   United India - no Generate Quote button ${o.where || "on this page"} - the Quote PDF and Worksheet are not taken here`);
      return null;
    }
  }
  const s3 = o.deps || {};
  const deps = {
    upload: s3.upload || ((file, key) => require("../../../s3Uploader").uploadToS3(file, key)),
    presign: s3.presign || ((key) => require("../../../s3Uploader").getPresignedUrl(key)),
    savePolicyFile: s3.savePolicyFile || defaultSavePolicyFile,
    log,
  };
  const moved = await driver.executeScript(scrollToEndInPage).catch(popupOr(QUOTE.label, STAGE));
  if (moved) await sleep(driver, VIDEO_PAUSE_MS);
  log("⬇️ United India - scrolled down to the end of the page for Generate Quote and Worksheet");

  const kept = {};
  for (const step of [QUOTE, WORKSHEET]) {
    const file = await fileFromButton(driver, { label: step.label, target: step.target, kind: step.kind, downloadDir: o.downloadDir }, { ...o, log });
    kept[step.field] = await keepOnPolicy(file, { field: step.field, kind: step.kind, data, jobId: o.jobId }, deps);
  }
  log("✅ United India - Quote PDF and Worksheet kept on the policy");
  return kept;
}

module.exports = { LOOK_MS, quoteAndWorksheet, fileFromButton, keepOnPolicy, takePage, filesIn, pageKindInPage, fetchSelfInPage, pageHtmlInPage, QUOTE, WORKSHEET, FILE_WAIT_MS };
