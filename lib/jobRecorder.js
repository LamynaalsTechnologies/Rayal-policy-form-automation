/**
 * Job screen recorder — one video per automation job.
 *
 * Records the job's OWN browser window (never the whole desktop, which would
 * mix the parallel windows together) and turns the frames into an MP4 at the
 * end of the run. Two capture modes:
 *
 *   cdp  — Chrome DevTools Page.startScreencast on the job's browser. Frames
 *          are pushed by Chrome itself, so nothing is injected into the
 *          WebDriver command pipeline the automation is using.
 *   poll — driver.takeScreenshot() on an interval. Slower cadence, but it
 *          follows whichever tab the driver is focused on and works on every
 *          Chrome/Selenium combination.
 *
 * Default mode "auto" starts with cdp and switches itself to poll if no frame
 * arrives within the watchdog window (occluded windows and some headless
 * setups never produce screencast frames).
 *
 * The cdp capture FOLLOWS THE TAB the automation is working in (lib/
 * recorderTabs.js): when a portal opens a KYC / payment page in a new tab and
 * the flow switches to it, the video switches with it, and each switch is kept
 * as a "chapter" the View page can jump to. Off with
 * RECORDING_FOLLOW_TAB_ENABLED=false (the old first-tab-only capture).
 *
 * Master switch: RECORDING_ENABLED in .env. When it is not "true", every
 * export here is a no-op — no CDP connection, no ffmpeg, no S3, no DB writes.
 *
 * Nothing in this module is allowed to fail a job: every entry point catches
 * its own errors and logs them.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  uploadRecordingToS3,
  generateRecordingKey,
  deleteRecordingFromS3,
} = require("../s3Uploader");
const { saveRecordingEntry } = require("./recordingEntries");
const { pickTarget, describeTab, offsetFor, listPages, PageSocket } = require("./recorderTabs");

const RECORDING_ENABLED =
  String(process.env.RECORDING_ENABLED || "").toLowerCase() === "true";

const RECORDING_MODE = (process.env.RECORDING_MODE || "auto").toLowerCase(); // auto | cdp | poll
const MAX_WIDTH = parseInt(process.env.RECORDING_MAX_WIDTH, 10) || 1280;
const MAX_HEIGHT = parseInt(process.env.RECORDING_MAX_HEIGHT, 10) || 720;
const JPEG_QUALITY = parseInt(process.env.RECORDING_JPEG_QUALITY, 10) || 60;
const POLL_MS = parseInt(process.env.RECORDING_POLL_MS, 10) || 1000;
// Screencast only emits when the page actually repaints, so a form sitting
// still produces no frames at all. This tops the video up with a CDP
// screenshot whenever nothing has arrived for this long — over the CDP socket,
// so it never queues behind the automation's own WebDriver commands.
const HEARTBEAT_MS = parseInt(process.env.RECORDING_HEARTBEAT_MS, 10) || 1000;
// Hard stop so a job that times out and keeps running detached (see the
// JOB_TIMEOUT note in server.js) cannot record forever. It follows the job's
// own limit (JOB_TIMEOUT_MS, default 15 min) plus two minutes of headroom: a
// fixed 7 minutes used to cut the video off before the KYC step of any run
// that took longer than that. RECORDING_MAX_MS overrides it outright.
const JOB_TIMEOUT_MS = parseInt(process.env.JOB_TIMEOUT_MS, 10) || 15 * 60 * 1000;
const MAX_RECORDING_MS =
  parseInt(process.env.RECORDING_MAX_MS, 10) || JOB_TIMEOUT_MS + 2 * 60 * 1000;
// Follow the tab the automation switches to (KYC / payment tabs). ON unless
// false / 0 / no / off; off = the old capture that stays on the first tab.
const FOLLOW_TAB_ENABLED = !/^(false|0|no|off)$/i.test(
  String(process.env.RECORDING_FOLLOW_TAB_ENABLED || "").trim()
);
// A run that opens tabs in a loop must not grow the chapter list without limit.
const MAX_CHAPTERS = 40;
// If cdp mode produces no frame in this window, fall back to polling.
const CDP_WATCHDOG_MS = 10000;

const TMP_ROOT = path.join(__dirname, "..", "recordings_tmp");

// jobKey (String(queue job _id)) -> recorder state
const activeRecorders = new Map();


const log = (jobKey, msg) => console.log(`🎥 [Recorder ${jobKey}] ${msg}`);
const warn = (jobKey, msg) => console.warn(`🎥 [Recorder ${jobKey}] ⚠️ ${msg}`);

function isRecordingEnabled() {
  return RECORDING_ENABLED;
}

/**
 * Begin recording a job's browser. Fire-and-forget: never throws, never
 * blocks the flow that calls it.
 *
 * @param driver   the job's own WebDriver instance
 * @param jobId    queue job _id (ObjectId or string) — the registry key the
 *                 server later finalizes by. Without it there is no document
 *                 to attach the video to, so recording is skipped.
 * @param attempt  attempt number, used in the S3 key
 */
function startRecording(driver, jobId, attempt, { label } = {}) {
  if (!RECORDING_ENABLED) return;
  if (!driver || !jobId) {
    if (RECORDING_ENABLED && !jobId) {
      console.warn("🎥 [Recorder] No queue job id on this run — recording skipped");
    }
    return;
  }

  const jobKey = String(jobId);
  if (activeRecorders.has(jobKey)) return; // one recorder per job

  // Two parts of one policy job can both be "attempt 1" while the first one's
  // video is still being stitched — never share a frame folder with it.
  let dir = path.join(TMP_ROOT, jobKey.replace(/[^a-zA-Z0-9_-]/g, "_"), `attempt_${attempt || 1}`);
  if (fs.existsSync(dir)) dir = `${dir}_${Date.now()}`;

  const rec = {
    jobKey,
    jobId,
    attempt: attempt || 1,
    label: label || jobKey,
    driver,
    dir,
    frames: [], // { file, t }
    frameIndex: 0,
    mode: null,
    stopped: false,
    startedAt: new Date(),
    endedAt: null,
    cdp: null,
    cdpMessageHandler: null,
    pollTimer: null,
    watchdogTimer: null,
    maxTimer: null,
    heartbeatTimer: null,
    heartbeatBusy: false,
    follow: null, // { addr, sockets: Map(targetId -> PageSocket), currentId, busy }
    chapters: [], // { t, id, label, host, kyc } — one per tab the video moved to
    stitched: null, // { frames, durations } once stitched, for chapter offsets
    lastFrameAt: 0,
    pollErrors: 0,
    pollBusy: false,
  };
  activeRecorders.set(jobKey, rec);

  // Async setup, detached from the caller.
  (async () => {
    fs.mkdirSync(rec.dir, { recursive: true });

    rec.maxTimer = setTimeout(() => {
      warn(jobKey, `Max recording time reached (${MAX_RECORDING_MS / 1000}s) — capture stopped`);
      stopCapture(rec);
    }, MAX_RECORDING_MS);

    if (RECORDING_MODE === "poll") {
      startPolling(rec);
      return;
    }

    const cdpOk =
      (await startFollowScreencast(rec)) || (await startCdpScreencast(rec));
    if (!cdpOk) {
      if (RECORDING_MODE === "cdp") {
        warn(jobKey, "CDP screencast unavailable and RECORDING_MODE=cdp — no recording for this job");
        stopCapture(rec);
      } else {
        startPolling(rec);
      }
    }
  })().catch((e) => {
    warn(jobKey, `Could not start recording: ${e.message}`);
  });
}

/**
 * Screencast that moves to whichever tab the automation has in front. Plain
 * DevTools sockets to each open page (see lib/recorderTabs.js for why not the
 * driver): every tick lists the pages, asks each which one is visible, and
 * points the screencast at it. Returns false — leaving nothing attached — when
 * the browser's DevTools address is not available, so the caller can fall back
 * to the first-tab capture.
 */
async function startFollowScreencast(rec) {
  if (!FOLLOW_TAB_ENABLED) return false;
  try {
    const caps = await rec.driver.getCapabilities();
    const opts = caps && caps.get && caps.get("goog:chromeOptions");
    const addr = opts && opts.debuggerAddress;
    if (!addr) return false;

    rec.follow = { addr, sockets: new Map(), currentId: null, busy: false };
    rec.mode = "cdp";
    await followTick(rec);
    if (!rec.follow || !rec.follow.currentId) {
      closeFollow(rec);
      rec.mode = null;
      return false;
    }

    rec.heartbeatTimer = setInterval(() => {
      followTick(rec).catch(() => {});
    }, HEARTBEAT_MS);

    rec.watchdogTimer = setTimeout(() => {
      if (!rec.stopped && rec.mode === "cdp" && rec.frames.length === 0) {
        warn(rec.jobKey, "CDP screencast produced no frames — switching to screenshot polling");
        clearInterval(rec.heartbeatTimer);
        closeFollow(rec);
        if (RECORDING_MODE !== "cdp") startPolling(rec);
      }
    }, CDP_WATCHDOG_MS);

    log(rec.jobKey, `Recording started (cdp, following the active tab, ${MAX_WIDTH}x${MAX_HEIGHT})`);
    return true;
  } catch (e) {
    warn(rec.jobKey, `Tab-following capture could not start: ${e.message}`);
    closeFollow(rec);
    rec.mode = null;
    return false;
  }
}

async function followTick(rec) {
  const f = rec.follow;
  if (!f || rec.stopped || f.busy) return;
  f.busy = true;
  try {
    const pages = await listPages(f.addr);
    const byId = new Map(pages.map((p) => [p.id, p]));

    // A socket per open page; drop the ones whose page is gone.
    for (const [id, sock] of f.sockets) {
      if (!byId.has(id)) {
        sock.close();
        f.sockets.delete(id);
      }
    }
    await Promise.all(
      pages.map(async (p) => {
        if (f.sockets.has(p.id)) return;
        const sock = new PageSocket(p.wsUrl, {
          onFrame: (buf) => {
            if (f.currentId === p.id) saveFrame(rec, buf, ".jpg");
          },
          onClose: () => {
            if (f.sockets.get(p.id) === sock) f.sockets.delete(p.id);
          },
        });
        f.sockets.set(p.id, sock);
        try {
          await sock.ready;
        } catch {
          f.sockets.delete(p.id);
        }
      })
    );
    if (rec.stopped) return;

    const states = await Promise.all(
      pages.map(async (p) => {
        const sock = f.sockets.get(p.id);
        const v = sock ? await sock.visibility() : null;
        return { id: p.id, ...(v || {}) };
      })
    );
    const targetId = pickTarget(
      states.filter((s) => f.sockets.has(s.id)),
      f.currentId
    );
    if (!targetId) return;

    if (targetId !== f.currentId) {
      const old = f.sockets.get(f.currentId);
      if (old) old.fire("Page.stopScreencast");
      f.currentId = targetId;
      const sock = f.sockets.get(targetId);
      sock.fire("Page.startScreencast", {
        format: "jpeg",
        quality: JPEG_QUALITY,
        maxWidth: MAX_WIDTH,
        maxHeight: MAX_HEIGHT,
        everyNthFrame: 1,
      });
      rec.lastFrameAt = 0; // a repaint-driven screencast may not speak for a while
      if (rec.chapters.length < MAX_CHAPTERS) {
        rec.chapters.push({ t: Date.now(), id: targetId, ...describeTab(byId.get(targetId)) });
        log(rec.jobKey, `Now following tab: ${rec.chapters[rec.chapters.length - 1].label}`);
      }
    } else {
      // A new tab is often about:blank for a moment; name it once it loads.
      const last = rec.chapters[rec.chapters.length - 1];
      if (last && last.id === targetId) {
        const now = describeTab(byId.get(targetId));
        if (!last.host && (now.host || now.label !== "New tab")) Object.assign(last, now);
        if (now.kyc) {
          last.kyc = true;
          if (!/kyc/i.test(last.label)) last.label = now.label;
        }
      }
    }

    // Screencast only speaks when the page repaints; a still form would leave
    // holes in the video, so top it up over the same socket.
    if (Date.now() - rec.lastFrameAt >= HEARTBEAT_MS) {
      const cur = f.sockets.get(f.currentId);
      if (cur) {
        const res = await cur
          .send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY })
          .catch(() => null);
        const data = res && res.result && res.result.data;
        if (data && f.currentId === targetId) saveFrame(rec, Buffer.from(data, "base64"), ".jpg");
      }
    }
  } finally {
    f.busy = false;
  }
}

function closeFollow(rec) {
  const f = rec.follow;
  if (!f) return;
  rec.follow = null;
  for (const sock of f.sockets.values()) {
    try {
      sock.fire("Page.stopScreencast");
    } catch {}
    sock.close();
  }
  f.sockets.clear();
}

async function startCdpScreencast(rec) {
  try {
    const cdp = await rec.driver.createCDPConnection("page");
    rec.cdp = cdp;
    rec.mode = "cdp";

    rec.cdpMessageHandler = (raw) => {
      if (rec.stopped || rec.mode !== "cdp") return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.method !== "Page.screencastFrame" || !msg.params) return;
      try {
        // Ack immediately or Chrome stops sending frames.
        cdp.execute("Page.screencastFrameAck", { sessionId: msg.params.sessionId });
        saveFrame(rec, Buffer.from(msg.params.data, "base64"), ".jpg");
      } catch (e) {
        /* a single bad frame is not worth aborting the recording */
      }
    };
    cdp._wsConnection.on("message", rec.cdpMessageHandler);
    cdp._wsConnection.on("error", () => stopCapture(rec));
    cdp._wsConnection.on("close", () => stopCapture(rec));

    cdp.execute("Page.startScreencast", {
      format: "jpeg",
      quality: JPEG_QUALITY,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      everyNthFrame: 1,
    });

    // Keep the video moving while the page is visually idle (see HEARTBEAT_MS).
    rec.heartbeatTimer = setInterval(() => {
      if (rec.stopped || rec.mode !== "cdp" || rec.heartbeatBusy) return;
      if (Date.now() - rec.lastFrameAt < HEARTBEAT_MS) return;
      rec.heartbeatBusy = true;
      cdp
        .send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY })
        .then((payload) => {
          const data = payload?.result?.data;
          if (data) saveFrame(rec, Buffer.from(data, "base64"), ".jpg");
        })
        .catch(() => {
          /* the tab may be navigating or gone; the next tick tries again */
        })
        .finally(() => {
          rec.heartbeatBusy = false;
        });
    }, HEARTBEAT_MS);

    // No frames after the watchdog window (occluded window, throttled
    // renderer, headless quirk) -> switch to polling instead of recording air.
    rec.watchdogTimer = setTimeout(() => {
      if (!rec.stopped && rec.mode === "cdp" && rec.frames.length === 0) {
        warn(rec.jobKey, "CDP screencast produced no frames — switching to screenshot polling");
        detachCdp(rec);
        if (RECORDING_MODE !== "cdp") startPolling(rec);
      }
    }, CDP_WATCHDOG_MS);

    log(rec.jobKey, `Recording started (cdp, ${MAX_WIDTH}x${MAX_HEIGHT})`);
    return true;
  } catch (e) {
    warn(rec.jobKey, `CDP screencast could not be attached: ${e.message}`);
    detachCdp(rec);
    return false;
  }
}

function startPolling(rec) {
  if (rec.stopped) return;
  rec.mode = "poll";
  log(rec.jobKey, `Recording started (poll, every ${POLL_MS}ms)`);
  rec.pollTimer = setInterval(async () => {
    if (rec.stopped || rec.pollBusy) return;
    rec.pollBusy = true;
    try {
      const base64 = await rec.driver.takeScreenshot();
      saveFrame(rec, Buffer.from(base64, "base64"), ".png");
      rec.pollErrors = 0;
    } catch (e) {
      // The browser dying mid-job is the normal way this loop ends.
      rec.pollErrors++;
      if (rec.pollErrors >= 5) {
        warn(rec.jobKey, "Browser no longer answers screenshots — capture stopped");
        stopCapture(rec);
      }
    } finally {
      rec.pollBusy = false;
    }
  }, POLL_MS);
}

function saveFrame(rec, buffer, ext) {
  if (rec.stopped) return;
  const file = path.join(rec.dir, `frame_${String(rec.frameIndex++).padStart(6, "0")}${ext}`);
  rec.lastFrameAt = Date.now();
  rec.frames.push({ file, t: rec.lastFrameAt });
  fs.writeFile(file, buffer, (err) => {
    if (err) warn(rec.jobKey, `Frame write failed: ${err.message}`);
  });
}

function detachCdp(rec) {
  if (!rec.cdp) return;
  try {
    rec.cdp.execute("Page.stopScreencast", {});
  } catch {}
  try {
    if (rec.cdpMessageHandler) {
      rec.cdp._wsConnection.off("message", rec.cdpMessageHandler);
    }
  } catch {}
  rec.cdp = null;
  rec.cdpMessageHandler = null;
}

/** Stop capturing frames. Idempotent; leaves frames on disk for finalize. */
function stopCapture(rec) {
  if (rec.stopped) return;
  rec.stopped = true;
  rec.endedAt = new Date();
  clearTimeout(rec.watchdogTimer);
  clearTimeout(rec.maxTimer);
  clearInterval(rec.pollTimer);
  clearInterval(rec.heartbeatTimer);
  detachCdp(rec);
  closeFollow(rec);
}

/**
 * Stitch the captured frames into an MP4 with real per-frame timing.
 * Returns the output path, or null when there is nothing worth keeping.
 */
async function stitchToMp4(rec) {
  // Drop frames whose write may still be in flight is not needed: writes are
  // tiny and finalize runs well after the last capture; missing files are
  // filtered here anyway.
  const frames = rec.frames.filter((f) => fs.existsSync(f.file));
  if (frames.length < 2) return null;

  const listPath = path.join(rec.dir, "frames.ffconcat");
  const lines = ["ffconcat version 1.0"];
  const durations = [];
  for (let i = 0; i < frames.length; i++) {
    const next = frames[i + 1];
    // Real elapsed time between frames, clamped so a stall doesn't freeze the
    // video for minutes and a burst doesn't produce sub-frame durations.
    const duration = next ? Math.min(Math.max((next.t - frames[i].t) / 1000, 0.04), 5) : 1;
    durations.push(duration);
    lines.push(`file '${path.basename(frames[i].file)}'`);
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  // concat demuxer quirk: the last file must be repeated for its duration to count.
  lines.push(`file '${path.basename(frames[frames.length - 1].file)}'`);
  fs.writeFileSync(listPath, lines.join("\n"));
  rec.stitched = { frames, durations };

  let ffmpegBin = "ffmpeg";
  try {
    ffmpegBin = require("ffmpeg-static") || "ffmpeg";
  } catch {}

  const outPath = path.join(rec.dir, "recording.mp4");
  // Frame sizes can differ between frames (window resize, cdp->poll switch),
  // so everything is normalized onto one fixed canvas.
  const vf = `scale=${MAX_WIDTH}:${MAX_HEIGHT}:force_original_aspect_ratio=decrease,pad=${MAX_WIDTH}:${MAX_HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=black`;
  const args = [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-vf", vf,
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264",
    "-crf", "28",
    "-preset", "veryfast",
    "-movflags", "+faststart",
    outPath,
  ];

  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { cwd: rec.dir });
    let stderrTail = "";
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    const killer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timed out after 120s"));
    }, 120000);
    proc.on("error", (e) => {
      clearTimeout(killer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(killer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ...${stderrTail.slice(-400)}`));
    });
  });

  return fs.existsSync(outPath) ? outPath : null;
}

/**
 * Stop the job's recorder, build the video, upload it and attach it to the
 * job document. Called from runPolicyJob's finally — including on timeout,
 * which is exactly the run one most wants to watch.
 *
 * Never throws; the returned promise is safe to leave un-awaited so the queue
 * slot is released without waiting on ffmpeg or S3.
 *
 * Only ONE recording is kept per policy: the S3 key is derived from the policy
 * id, so this upload overwrites the previous run's video, and the metadata is
 * $set rather than $push. Re-running a policy therefore replaces its recording
 * instead of accumulating one per attempt.
 *
 * @param jobId       queue job _id used at startRecording time
 * @param companyName normalized company ("reliance" | "national" | ...)
 * @param policyId    the online policy this job belongs to (job.captchaId) —
 *                    what the video is keyed by; falls back to the job id
 * @param collection  raw RelianceJobQueue collection for the metadata write
 * @param partKey     set for a job with `parts` (one job per policy): the video is
 *                    named `${policyId}_${partKey}` and only THAT part's entry is
 *                    replaced, so OD, TP and PA keep one video each and never
 *                    overwrite one another. Absent = the original behaviour.
 */
async function finalizeRecording(
  jobId,
  { companyName, policyId, collection, partKey } = {}
) {
  if (!RECORDING_ENABLED || !jobId) return;
  const jobKey = String(jobId);
  const rec = activeRecorders.get(jobKey);
  if (!rec) return;
  activeRecorders.delete(jobKey);

  try {
    stopCapture(rec);
    log(jobKey, `Capture stopped — ${rec.frames.length} frames (${rec.mode || "no"} mode)`);

    const mp4Path = await stitchToMp4(rec);
    if (!mp4Path) {
      warn(jobKey, "Too few frames captured — no video kept for this run");
      return;
    }

    const sizeBytes = fs.statSync(mp4Path).size;
    // "Jump to" points for the View page: one per tab the video moved to, in
    // video time. Only worth storing when the run actually used more than one.
    const chapters =
      rec.chapters.length > 1 && rec.stitched
        ? rec.chapters.map((c) => ({
            label: c.label,
            host: c.host,
            kyc: !!c.kyc,
            atSec: offsetFor(rec.stitched.frames, rec.stitched.durations, c.t),
          }))
        : null;
    const videoId = partKey
      ? `${policyId || jobKey}_${partKey}`
      : policyId || jobKey;
    const s3Key = generateRecordingKey(companyName || "unknown", videoId);
    const uploaded = await uploadRecordingToS3(mp4Path, s3Key);

    if (collection) {
      await saveRecordingEntry(collection, rec.jobId, {
        entry: {
          attemptNumber: rec.attempt,
          s3Key: uploaded.storage === "s3" ? s3Key : null,
          localPath: uploaded.storage === "local" ? uploaded.location : null,
          storage: uploaded.storage,
          startedAt: rec.startedAt,
          endedAt: rec.endedAt,
          durationMs: rec.endedAt - rec.startedAt,
          sizeBytes,
          frameCount: rec.frames.length,
          captureMode: rec.mode,
          ...(chapters ? { chapters } : {}),
        },
        partKey,
        s3Key,
        deleteOld: deleteRecordingFromS3,
        warn: (m) => warn(jobKey, m),
      });
    }

    log(
      jobKey,
      `Video saved (${(sizeBytes / 1024 / 1024).toFixed(1)} MB, ${uploaded.storage}): ${
        uploaded.storage === "s3" ? s3Key : uploaded.location
      }`
    );
  } catch (e) {
    warn(jobKey, `Recording could not be finalized: ${e.message}`);
  } finally {
    // Frames and the stitched copy are only needed until the upload; the S3
    // lifecycle rule (or the local-recordings purge) owns retention from here.
    try {
      fs.rmSync(rec.dir, { recursive: true, force: true });
      // ...and the job's own folder, once its last attempt is gone. Left
      // behind, these empty directories pile up one per job until a restart.
      const jobDir = path.dirname(rec.dir);
      if (fs.existsSync(jobDir) && fs.readdirSync(jobDir).length === 0) {
        fs.rmdirSync(jobDir);
      }
    } catch {}
  }
}

/**
 * Delete frame directories no live recording owns any more.
 *
 * Frames are written to disk while a job runs (~1 per second) and normally
 * removed by finalizeRecording. If the process is killed mid-job, or a job
 * dies before the server's finally can run, those frames are stranded — and at
 * roughly 15 MB per five-minute job they would grow the disk indefinitely.
 *
 * Age-based, like the orphaned-profile sweep in server.js: nothing can be
 * recording for longer than MAX_RECORDING_MS, so anything older is provably
 * finished. Directories belonging to a recorder still in the registry are
 * skipped outright.
 */
function sweepOrphanedFrameDirs() {
  if (!fs.existsSync(TMP_ROOT)) return;

  const liveDirs = new Set(
    [...activeRecorders.values()].map((r) => path.dirname(r.dir))
  );
  const cutoff = Date.now() - (MAX_RECORDING_MS + 5 * 60 * 1000);
  let removed = 0;

  for (const entry of fs.readdirSync(TMP_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(TMP_ROOT, entry.name);
    if (liveDirs.has(dir)) continue;
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue; // may still be in use
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (e) {
      /* already gone, or being written — the next sweep retries */
    }
  }

  if (removed > 0) {
    console.log(`🎥 [Recorder] Swept ${removed} stranded frame folder(s)`);
  }
}

/**
 * Drop everything this module has on local disk. Called when the process is
 * stopping, from a signal handler and again on 'exit'.
 *
 * Deliberately SYNCHRONOUS and unconditional. Stopping the server mid-job used
 * to strand that run's frames — hundreds of JPEGs, ~16 MB per job — with no
 * video ever built from them and nothing to clean them up until the next
 * startup. Frames are worthless once the browser is gone, so they are deleted
 * outright rather than stitched: no ffmpeg, no upload, nothing that could hang
 * a shutdown or leave a half-written file behind.
 */
function shutdownRecordings() {
  if (!RECORDING_ENABLED) return;

  for (const rec of activeRecorders.values()) {
    try {
      stopCapture(rec);
    } catch (e) {
      /* stopping is best-effort; the wipe below is what matters */
    }
  }
  activeRecorders.clear();

  try {
    if (fs.existsSync(TMP_ROOT)) {
      const frames = fs.readdirSync(TMP_ROOT).length;
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
      if (frames > 0) {
        console.log(`🎥 [Recorder] Cleared ${frames} in-progress recording folder(s) on shutdown`);
      }
    }
  } catch (e) {
    console.warn(`🎥 [Recorder] Shutdown cleanup failed: ${e.message}`);
  }
}

module.exports = {
  isRecordingEnabled,
  startRecording,
  finalizeRecording,
  sweepOrphanedFrameDirs,
  shutdownRecordings,
};
