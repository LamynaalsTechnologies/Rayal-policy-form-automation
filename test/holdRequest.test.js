// "Hold" pressed while the automation runs a policy (lib/holdRequest.js): the running attempt ends however it ends,
// and the job is put on hold instead of starting again. A fake collection stands in for Mongo: no database, no browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const hr = require("../lib/holdRequest");

/** A tiny in-memory collection that understands exactly the filters lib/holdRequest.js uses. */
const fakeCollection = (docs) => {
  const matches = (doc, f) =>
    Object.entries(f).every(([k, v]) => {
      if (v && typeof v === "object" && "$exists" in v) return v.$exists ? doc[k] !== undefined : doc[k] === undefined;
      if (v && typeof v === "object" && "$nin" in v) return !v.$nin.includes(doc[k]);
      return doc[k] === v;
    });
  const apply = (doc, u) => {
    Object.assign(doc, u.$set || {});
    for (const k of Object.keys(u.$unset || {})) delete doc[k];
    for (const [k, v] of Object.entries(u.$push || {})) doc[k] = [...(doc[k] || []), v];
    for (const [k, v] of Object.entries(u.$inc || {})) doc[k] = (doc[k] || 0) + v;
  };
  return {
    docs,
    find: (f) => ({ project: () => ({ toArray: async () => docs.filter((d) => matches(d, f)).map((d) => ({ ...d })) }) }),
    updateOne: async (f, u) => {
      const doc = docs.find((d) => matches(d, f));
      if (doc) apply(doc, u);
      return { modifiedCount: doc ? 1 : 0 };
    },
    updateMany: async (f, u) => {
      const hits = docs.filter((d) => matches(d, f));
      hits.forEach((d) => apply(d, u));
      return { modifiedCount: hits.length };
    },
  };
};
const quiet = { log: () => {} };
const ON = { JOB_HOLD_REQUEST_ENABLED: "" }; // on unless false

test("the switch is on unless false / 0 / no / off", () => {
  for (const on of [undefined, "", "true", "1", "yes"]) assert.equal(hr.isHoldRequestEnabled({ JOB_HOLD_REQUEST_ENABLED: on }), true, String(on));
  for (const off of ["false", "0", "no", "off", " FALSE "]) assert.equal(hr.isHoldRequestEnabled({ JOB_HOLD_REQUEST_ENABLED: off }), false, off);
});

test("claims skip a job whose hold was asked for (switch on); off = no extra condition", () => {
  assert.deepEqual(hr.claimFilter(ON), { holdRequested: { $exists: false } });
  assert.deepEqual(hr.claimFilter({ JOB_HOLD_REQUEST_ENABLED: "false" }), {});
});

test("the attempt ended and went back to pending: the job is put on hold, the request cleared, the timeline says why", async () => {
  const now = new Date("2026-10-17T12:08:00Z");
  const col = fakeCollection([
    { _id: 1, status: "pending", nextRetryAt: new Date("2026-10-17T12:08:35Z"), holdRequested: { at: now, by: "u1" }, formData: { firstName: "ANMOL" } },
    { _id: 2, status: "pending", parts: [{ key: "motor" }], rev: 4, holdRequested: { at: now, by: "u2" } },
    { _id: 3, status: "pending" }, // no request: untouched
  ]);
  const held = await hr.applyHoldRequests(col, { now, env: ON, logger: quiet });
  assert.equal(held, 2);
  const [a, b, c] = col.docs;
  assert.equal(a.status, "hold");
  assert.equal(a.heldBy, "u1");
  assert.equal(a.holdRequested, undefined);
  assert.match(a.statusHistory[0].note, /asked while it was running, applied when that attempt ended/);
  assert.equal(b.status, "hold");
  assert.equal(b.rev, 5, "a parts job's rev moves, so a writer that read it before re-reads");
  assert.equal(c.status, "pending");
});

test("still running: nothing yet; ended for good: the request is dropped; switch off: nothing at all", async () => {
  const col = fakeCollection([
    { _id: 1, status: "processing", holdRequested: { by: "u" } },
    { _id: 2, status: "completed", holdRequested: { by: "u" } },
    { _id: 3, status: "failed", holdRequested: { by: "u" } },
  ]);
  assert.equal(await hr.applyHoldRequests(col, { env: ON, logger: quiet }), 0);
  assert.equal(col.docs[0].status, "processing");
  assert.ok(col.docs[0].holdRequested, "kept until the attempt ends");
  assert.equal(col.docs[1].holdRequested, undefined);
  assert.equal(col.docs[2].holdRequested, undefined);

  const off = fakeCollection([{ _id: 1, status: "pending", holdRequested: { by: "u" } }]);
  assert.equal(await hr.applyHoldRequests(off, { env: { JOB_HOLD_REQUEST_ENABLED: "false" }, logger: quiet }), 0);
  assert.equal(off.docs[0].status, "pending");
});

test("wiring: the queue pass applies requests, and every claim / scan carries the filter", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(server, /await holdRequest\.applyHoldRequests\(jobQueueCollection\)/);
  assert.match(server, /status: JOB_STATUS\.PENDING,\s*\.\.\.holdRequest\.claimFilter\(\),/);
  assert.match(server, /\{ _id: candidate\._id, status: JOB_STATUS\.PENDING, \.\.\.holdRequest\.claimFilter\(\) \}/);
  const runner = fs.readFileSync(path.join(__dirname, "..", "lib", "partRunner.js"), "utf8");
  assert.match(runner, /\.\.\.require\("\.\/holdRequest"\)\.claimFilter\(\),/);
});

test("partRunner.claimPart refuses a job with a hold request (its filter carries the condition)", async () => {
  const { claimPart } = require("../lib/partRunner");
  let filter = null;
  const col = { findOneAndUpdate: async (f) => ((filter = f), null) };
  const claimed = await claimPart(col, { _id: 9, rev: 1 }, { key: "motor", company: "Reliance", kind: "portal" });
  assert.equal(claimed, null);
  assert.deepEqual(filter.holdRequested, { $exists: false });
});
