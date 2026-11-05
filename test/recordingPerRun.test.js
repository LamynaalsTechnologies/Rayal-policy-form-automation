// Run with: node --require ./test/support/noRealWorld.js --test test/recordingPerRun.test.js
//
// Every run keeps its own video (the owner, 2026-11-05: "first run and rerun ... it remove the old video", History ->
// Runs plays each run's video). Before: one S3 key per policy / part, so a re-run overwrote the video, and the job's
// entry for that part was pulled and its object deleted. Now: a key per run, the entry added (capped), nothing deleted;
// the entry says which run it is of and when S3 lets it go. S3's own lifecycle rule (RECORDING_RETENTION_DAYS) is left
// as it was.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { generateRecordingKey, RECORDING_RETENTION_DAYS } = require(path.join(ROOT, "s3Uploader.js"));
const { saveRecordingEntry, RECORDINGS_MAX } = require(path.join(ROOT, "lib", "recordingEntries.js"));
const { _runStampOf: runStampOf } = require(path.join(ROOT, "lib", "jobRecorder.js"));

test("a video's name has its run in it: two runs of the same part are two objects", () => {
  const first = generateRecordingKey("kshema", "690a1b2c_motor", runStampOf(new Date("2026-11-04T10:04:07.123Z"), "1a2b3c4d-9999-4aaa-8bbb-000000000001"));
  const rerun = generateRecordingKey("kshema", "690a1b2c_motor", runStampOf(new Date("2026-11-04T10:25:24Z"), "5e6f7a8b-1111-4ccc-8ddd-000000000002"));
  assert.equal(first, "recordings/kshema/690a1b2c_motor_20261104T100407_1a2b3c4d.mp4");
  assert.equal(rerun, "recordings/kshema/690a1b2c_motor_20261104T102524_5e6f7a8b.mp4");
  assert.notEqual(first, rerun);
  // still under the prefix the lifecycle rule deletes from
  assert.ok(first.startsWith("recordings/"));
  // without a run the old one-key shape is kept
  assert.equal(generateRecordingKey("Reliance", "p1"), "recordings/reliance/p1.mp4");
});

test("runStampOf: start time to the second + a short run id; a run without an id still gets a unique name", () => {
  assert.equal(runStampOf("2026-11-04T10:04:07Z", "abc-def"), "20261104T100407_abcdef");
  assert.equal(runStampOf("2026-11-04T10:04:07Z", null), "20261104T100407");
  assert.match(runStampOf("not a date", null), /^\d+$/);
});

/** A collection that records every update. */
const recordingCollection = () => {
  const updates = [];
  return { updates, updateOne: async (filter, update) => updates.push({ filter, update }) };
};

test("saving a part's video ADDS it (capped at the newest 100); nothing of the part is pulled, nothing deleted", async () => {
  const col = recordingCollection();
  const entry = { attemptNumber: 2, s3Key: "recordings/kshema/p_motor_20261104T102524_5e6f7a8b.mp4", runId: "run-2" };
  await saveRecordingEntry(col, "job-1", { entry, partKey: "motor", s3Key: entry.s3Key });

  assert.equal(RECORDINGS_MAX, 100);
  const pulls = col.updates.filter((u) => u.update.$pull);
  assert.deepEqual(pulls.map((u) => u.update.$pull), [{ recordings: { s3Key: entry.s3Key } }], "only the same video, never the part's others");
  const push = col.updates.find((u) => u.update.$push).update.$push.recordings;
  assert.deepEqual(push, { $each: [{ ...entry, part: "motor" }], $slice: -100 });
});

test("a job without parts keeps every video too (it used to be $set to just the newest)", async () => {
  const col = recordingCollection();
  await saveRecordingEntry(col, "job-2", { entry: { s3Key: "c.mp4" }, s3Key: "c.mp4" });
  assert.ok(!col.updates.some((u) => u.update.$set), "no $set of the whole list");
  assert.deepEqual(col.updates.at(-1).update.$push.recordings, { $each: [{ s3Key: "c.mp4" }], $slice: -100 });
  // a local-fallback video (no S3 key) is just added
  const local = recordingCollection();
  await saveRecordingEntry(local, "job-3", { entry: { localPath: "/x.mp4" }, partKey: "tp" });
  assert.equal(local.updates.length, 1);
});

test("the recorder writes the run and the expiry on the entry, names the video per run, and deletes nothing", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "jobRecorder.js"), "utf8");
  assert.match(src, /generateRecordingKey\(companyName \|\| "unknown", videoId, runStampOf\(rec\.startedAt, runId\)\)/);
  assert.match(src, /runId: runId \|\| null,/);
  assert.match(src, /expiresAt,/);
  assert.match(src, /RECORDING_RETENTION_DAYS \* 24 \* 60 \* 60 \* 1000/);
  assert.equal(/deleteOld|deleteRecordingFromS3/.test(src), false, "no old video is deleted by the recorder");
  assert.ok(RECORDING_RETENTION_DAYS > 0);

  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(server, /finalizeRecording: \(job, part, companyName, runId\) =>/);
  assert.match(server, /runId: \(job && job\.formData && job\.formData\._runId\) \|\| null,/);
  const runner = fs.readFileSync(path.join(ROOT, "lib", "partRunner.js"), "utf8");
  assert.match(runner, /finalizeRecording\(claimed, part, companyName, runId\)/);
});
