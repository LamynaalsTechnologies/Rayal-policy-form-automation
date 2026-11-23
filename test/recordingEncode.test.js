"use strict";

// lib/jobRecorder.js: videos are built one at a time, with at most 2 ffmpeg threads at low priority (2026-11-23).
// No browser, no network, no database, no ffmpeg:
// node --require ./test/support/noRealWorld.js --test test/recordingEncode.test.js
// (A real ffmpeg-static encode with these settings was checked by hand on 2026-11-23.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { _oneEncodeAtATime: oneEncodeAtATime } = require("../lib/jobRecorder");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("two videos finishing together are built one after the other, in order", async () => {
  const events = [];
  const encode = (name, ms) => async () => {
    events.push(`start ${name}`);
    await wait(ms);
    events.push(`end ${name}`);
    return name;
  };
  const [a, b] = await Promise.all([oneEncodeAtATime(encode("A", 40)), oneEncodeAtATime(encode("B", 5))]);
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.deepEqual(events, ["start A", "end A", "start B", "end B"], "B waited for A although it is shorter");
});

test("a failed video does not block the next one, and its error still reaches its own caller", async () => {
  const failing = oneEncodeAtATime(async () => {
    throw new Error("ffmpeg exited with code 1");
  });
  const next = oneEncodeAtATime(async () => "built");
  await assert.rejects(failing, /ffmpeg exited/);
  assert.equal(await next, "built");
});

test("ffmpeg is asked for 2 threads and started at low priority", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", "jobRecorder.js"), "utf8");
  assert.match(source, /const FFMPEG_THREADS = 2;/);
  assert.match(source, /const FFMPEG_NICE = 10;/);
  assert.match(source, /"-threads", String\(FFMPEG_THREADS\)/);
  assert.match(source, /os\.setPriority\(proc\.pid, FFMPEG_NICE\)/);
  assert.match(source, /await oneEncodeAtATime\(\(\) => \{/, "finalizeRecording builds through the queue");
});
