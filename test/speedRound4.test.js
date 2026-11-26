"use strict";

// Speed round 4 (2026-11-26): lib/sharedDb.js (the server's open connection lent to the forms' saves) and lib/settle.js
// ("ready, or the old pause"). No browser, no network, no database:
//   MONGODB_URI=mongodb://127.0.0.1:9/none node --require ./test/support/noRealWorld.js --test test/speedRound4.test.js
const test = require("node:test");
const { mock } = require("node:test");
const assert = require("node:assert/strict");

const mongoose = require("mongoose");
const { MongoClient } = require("mongodb");
const sharedDb = require("../lib/sharedDb");
const settle = require("../lib/settle");

const URI = "mongodb://127.0.0.1:9/speedround4";

/** Make mongoose look connected (or not) with a fake client, for the length of `fn`. */
async function withServerConnection(conn, fn) {
  const oldUri = process.env.MONGODB_URI;
  process.env.MONGODB_URI = URI;
  Object.defineProperty(mongoose, "connection", { get: () => conn, configurable: true });
  try {
    return await fn();
  } finally {
    delete mongoose.connection; // back to the prototype's getter
    if (oldUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = oldUri;
  }
}

function fakeServerClient() {
  const calls = { db: [], close: 0, connect: 0 };
  const collections = {};
  const client = {
    calls,
    db(name) {
      calls.db.push(name);
      return {
        collection(c) {
          collections[c] = collections[c] || { name: c, updates: [] };
          return collections[c];
        },
      };
    },
    close: async () => {
      calls.close += 1;
    },
    connect: async () => {
      calls.connect += 1;
    },
  };
  return { client, calls, collections };
}

/* ----------------------------------------- sharedDb ----------------------------------------- */

test("sharedDb: the server's open connection is lent; connect and close do nothing to it", async () => {
  const { client, calls } = fakeServerClient();
  await withServerConnection({ readyState: 1, getClient: () => client }, async () => {
    const lent = sharedDb.clientFor(MongoClient, URI, { serverSelectionTimeoutMS: 10000 });
    assert.equal(lent.lent, true);
    assert.equal(await lent.connect(), lent);
    const db = lent.db();
    assert.equal(db.collection("onlinePolicy").name, "onlinePolicy");
    await lent.close();
    assert.equal(calls.close, 0, "the server's connection is never closed by a form");
    assert.equal(calls.connect, 0);
    assert.deepEqual(calls.db, [undefined], "db() = the connection string's database, as client.db() was");
    // no class given = the real one
    assert.equal(sharedDb.clientFor(undefined, URI).lent, true);
  });
});

test("sharedDb: not connected / another address / a test's fake class => a new client exactly as before", async () => {
  const { client } = fakeServerClient();
  for (const readyState of [0, 2, 3]) {
    await withServerConnection({ readyState, getClient: () => client }, async () => {
      const c = sharedDb.clientFor(MongoClient, URI);
      assert.ok(c instanceof MongoClient, `readyState ${readyState} -> new MongoClient`);
    });
  }
  await withServerConnection({ readyState: 1, getClient: () => client }, async () => {
    const other = sharedDb.clientFor(MongoClient, "mongodb://127.0.0.1:9/another");
    assert.ok(other instanceof MongoClient, "another address is never lent the server's connection");
    class Fake {
      constructor(uri, opts) {
        this.args = [uri, opts];
      }
    }
    const fake = sharedDb.clientFor(Fake, URI, { serverSelectionTimeoutMS: 10000 });
    assert.ok(fake instanceof Fake, "a test's fake MongoClient is still used");
    assert.deepEqual(fake.args, [URI, { serverSelectionTimeoutMS: 10000 }]);
    const noOpts = sharedDb.clientFor(Fake, URI);
    assert.equal(noOpts.args.length, 2);
    assert.equal(noOpts.args[1], undefined, "no options given = none passed (same call as before)");
  });
  // no mongoose connection object at all
  await withServerConnection(undefined, async () => {
    assert.ok(sharedDb.clientFor(MongoClient, URI) instanceof MongoClient);
  });
});

test("sharedDb: relianceStages saves go through the server's connection and leave it open", async () => {
  const stages = require("../fullPolicycompany/reliance/relianceStages");
  const { client, calls, collections } = fakeServerClient();
  collections.onlinePolicy = {
    name: "onlinePolicy",
    updates: [],
    async findOne() {
      return null;
    },
    async updateOne(q, u) {
      this.updates.push([q, u]);
      return { matchedCount: 1 };
    },
  };
  await withServerConnection({ readyState: 1, getClient: () => client }, async () => {
    const plan = await stages.loadResumePlan({ _id: "0123456789abcdef01234567" }, { jobId: "t" });
    assert.ok(plan && typeof plan.key === "string");
  });
  assert.ok(calls.db.length >= 1, "the read used the server's connection");
  assert.equal(calls.close, 0);
});

/* ------------------------------------------ settle ------------------------------------------ */

/** A fake driver with a fake clock: sleep moves the clock. */
function clockDriver() {
  let t = 1000;
  const sleeps = [];
  return {
    sleeps,
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    driver: {
      async sleep(ms) {
        sleeps.push(ms);
        t += ms;
      },
    },
  };
}

test("settle.untilReady: ends at the first good check, never later than the old pause", async () => {
  const c = clockDriver();
  let n = 0;
  const r = await settle.untilReady(c.driver, async () => ++n >= 3, { capMs: 2000, everyMs: 100, now: c.now });
  assert.equal(r.ready, true);
  assert.equal(r.ms, 200);
  assert.deepEqual(c.sleeps, [100, 100]);

  const c2 = clockDriver();
  const r2 = await settle.untilReady(c2.driver, async () => false, { capMs: 2000, everyMs: 150, now: c2.now });
  assert.equal(r2.ready, false);
  assert.equal(r2.ms, 2000, "the sign never shows = exactly the old pause");
  assert.equal(c2.sleeps.reduce((a, b) => a + b, 0), 2000);
  assert.ok(c2.sleeps.every((s) => s <= 150));

  const c3 = clockDriver();
  const r3 = await settle.untilReady(c3.driver, async () => true, { capMs: 2000, now: c3.now });
  assert.deepEqual([r3.ready, r3.ms, c3.sleeps.length], [true, 0, 0], "already ready = no pause at all");
});

test("settle.untilReady: quietMs - the check must STAY true; a flicker starts the count again", async () => {
  const c = clockDriver();
  const answers = [true, false, true, true, true, true];
  let i = 0;
  const r = await settle.untilReady(c.driver, async () => answers[Math.min(i++, answers.length - 1)], {
    capMs: 5000,
    everyMs: 100,
    quietMs: 300,
    now: c.now,
  });
  assert.equal(r.ready, true);
  assert.equal(r.ms, 500, "true at 200, still true at 300/400/500 -> ready at 500 (not at 0)");

  const c2 = clockDriver();
  const r2 = await settle.untilReady(c2.driver, async () => true, { capMs: 200, everyMs: 100, quietMs: 1000, now: c2.now });
  assert.deepEqual([r2.ready, r2.ms], [false, 200], "quiet window longer than the cap = the old pause");
});

test("settle.untilReady: a throwing check is 'not yet'; a Hold or stuck-step stop is passed on at once", async () => {
  const c = clockDriver();
  let n = 0;
  const r = await settle.untilReady(
    c.driver,
    async () => {
      n += 1;
      if (n < 3) throw new Error("stale element");
      return true;
    },
    { capMs: 1000, everyMs: 100, now: c.now }
  );
  assert.deepEqual([r.ready, r.ms], [true, 200]);

  const hold = Object.assign(new Error("held"), { stage: require("../lib/holdStop").HOLD_STOP_STAGE });
  await assert.rejects(
    settle.untilReady(clockDriver().driver, async () => {
      throw hold;
    }, { capMs: 1000 }),
    (e) => e === hold
  );
  const stalled = Object.assign(new Error("[E309] stuck"), { name: "StepStalledError", stalled: true });
  await assert.rejects(
    settle.untilReady(clockDriver().driver, async () => {
      throw stalled;
    }, { capMs: 1000 }),
    (e) => e === stalled
  );
});

test("settle.untilUrlLeaves: the same address, about:blank or a page still loading are not ready", async () => {
  const c = clockDriver();
  const seen = [
    ["https://x/pending", "complete"],
    ["about:blank", "complete"],
    ["https://x/pay", "loading"],
    ["https://x/pay", "complete"],
  ];
  let i = 0;
  let cur = seen[0];
  c.driver.getCurrentUrl = async () => {
    cur = seen[Math.min(i++, seen.length - 1)];
    return cur[0];
  };
  c.driver.executeScript = async () => cur[1];
  const r = await settle.untilUrlLeaves(c.driver, "https://x/pending", { capMs: 3000, everyMs: 100, now: c.now });
  assert.deepEqual([r.ready, r.ms], [true, 300]);
});

test("settle.untilShown: one page read per check (selenium's own isDisplayed), ready when shown", async () => {
  const c = clockDriver();
  let calls = 0;
  c.driver.executeScript = async () => {
    calls += 1;
    return calls >= 2 ? { element: { id: "el" }, index: 0 } : null;
  };
  const r = await settle.untilShown(c.driver, ["#next"], { capMs: 2000, everyMs: 100, now: c.now });
  assert.equal(r.ready, true);
  assert.equal(calls, 2);
});

/* ------------------------------------ the alert rule ------------------------------------ */

test("settle.untilReady: an open alert() stops the wait at once and is never read past (the next step meets it)", async () => {
  const c = clockDriver();
  let checks = 0;
  c.driver.switchTo = () => ({ alert: async () => ({ text: "Reliance says no" }) });
  const r = await settle.untilReady(c.driver, async () => {
    checks += 1;
    return false;
  }, { capMs: 3000, now: c.now });
  assert.deepEqual([r.ready, r.alert, checks, c.sleeps.length], [false, true, 0, 0]);

  const c2 = clockDriver();
  c2.driver.switchTo = () => ({
    alert: async () => {
      const e = new Error("no such alert");
      e.name = "NoSuchAlertError";
      throw e;
    },
  });
  const r2 = await settle.untilReady(c2.driver, async () => true, { capMs: 3000, now: c2.now });
  assert.deepEqual([r2.ready, r2.alert], [true, undefined], "no alert -> the check runs as usual");
});

/* ------------------------------------ Reliance waits ------------------------------------ */

const rs = require("../fullPolicycompany/reliance/relianceSettle");

/** A fake Reliance page: `activity(t)` -> { active, loading } (or undefined = no page scripts), shown(t) -> ids on screen. */
function reliancePage({ activity, shown = () => [] } = {}) {
  // these helpers read the real clock (Date.now): the fake sleep moves Node's mocked clock (see withClock)
  const sleeps = [];
  const c = { sleeps, now: () => Date.now(), driver: { async sleep(ms) { sleeps.push(ms); mock.timers.tick(ms); } } };
  const t0 = c.now();
  const at = () => c.now() - t0;
  c.driver.executeScript = async (fn, arg) => {
    const src = String(fn);
    if (src.includes("jQuery")) return activity ? activity(at()) : undefined;
    if (Array.isArray(arg)) {
      // pageReads.findFirstShown(selectors) -> { element, index }
      const ids = shown(at());
      const i = arg.findIndex((sel) => ids.some((id) => String(sel && sel.value !== undefined ? sel.value : sel).includes(id)));
      return i >= 0 ? { element: { id: ids.find((id) => String(arg[i].value || arg[i]).includes(id)) }, index: i } : { element: null, index: -1 };
    }
    return null;
  };
  c.driver.findElements = async () => [];
  return { ...c, at };
}

test("relianceSettle.idleOrPause: ends a short quiet moment after the request answers; never longer than the old pause", async () => {
  mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  try {
  const p = reliancePage({ activity: (t) => ({ active: t < 800 ? 1 : 0, loading: false }) });
  const r = await rs.idleOrPause(p.driver, 2000, { stableMs: 400, pollMs: 100 });
  assert.equal(r.ready, true);
  assert.ok(r.ms >= 1200 && r.ms <= 1300, `${r.ms}`);

  const stuck = reliancePage({ activity: () => ({ active: 1, loading: false }) });
  const r2 = await rs.idleOrPause(stuck.driver, 2000, { pollMs: 100 });
  assert.deepEqual([r2.ready, r2.ms], [false, 2000]);

  const mask = reliancePage({ activity: (t) => ({ active: 0, loading: t < 600 }) });
  const r3 = await rs.idleOrPause(mask.driver, 2000, { stableMs: 400, pollMs: 100 });
  assert.ok(r3.ready && r3.ms >= 1000 && r3.ms <= 1100, "a Kendo loading mask counts as busy");

  const noScripts = reliancePage({});
  const r4 = await rs.idleOrPause(noScripts.driver, 2000);
  assert.deepEqual(noScripts.sleeps, [2000], "no page scripts (a test's fake) -> exactly the old sleep");
  assert.equal(r4.ready, false);
  } finally {
    mock.timers.reset();
  }
});

test("relianceSettle.dashboardPopup: the popup's close button when it shows; null only when the menu is up and the page idle 1.5 s", async () => {
  mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  try {
  const withPopup = reliancePage({ activity: () => ({ active: 0, loading: false }), shown: (t) => (t >= 600 ? ["divMainMotors", "Closebutton"] : ["divMainMotors"]) });
  const btn = await rs.dashboardPopup(withPopup.driver, 7000, { everyMs: 100 });
  assert.equal(btn && btn.id, "Closebutton");

  const none = reliancePage({ activity: () => ({ active: 0, loading: false }), shown: () => ["divMainMotors"] });
  const t0 = none.now();
  assert.equal(await rs.dashboardPopup(none.driver, 7000, { everyMs: 100 }), null);
  const took = none.now() - t0;
  assert.ok(took >= 1500 && took <= 1700, `no popup -> ~1.5 s (old 7 s), took ${took}`);

  const busy = reliancePage({ activity: (t) => ({ active: t < 4000 ? 1 : 0, loading: false }), shown: (t) => (t >= 3000 ? ["divMainMotors", "Closebutton"] : ["divMainMotors"]) });
  const late = await rs.dashboardPopup(busy.driver, 7000, { everyMs: 100 });
  assert.equal(late && late.id, "Closebutton", "a busy page is never taken for 'no popup'");

  const noMenu = reliancePage({ activity: () => ({ active: 0, loading: false }), shown: () => [] });
  const s0 = noMenu.now();
  assert.equal(await rs.dashboardPopup(noMenu.driver, 7000, { everyMs: 100 }), null);
  assert.equal(noMenu.now() - s0, 7000, "no Motors menu yet -> the old full look");
  } finally {
    mock.timers.reset();
  }
});

test("relianceSettle.untilShownOrIdle: the dialog that follows the request is seen; none = after the request + 0.8 s idle", async () => {
  mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  try {
  const sel = ['div.ui-dialog[aria-describedby="divCustomerAlreadyExist"]'];
  const yes = reliancePage({ activity: (t) => ({ active: t < 700 ? 1 : 0, loading: false }), shown: (t) => (t >= 700 ? ["divCustomerAlreadyExist"] : []) });
  const r = await rs.untilShownOrIdle(yes.driver, sel, 3000, { everyMs: 100 });
  assert.equal(r.shown, true);
  const no = reliancePage({ activity: (t) => ({ active: t < 700 ? 1 : 0, loading: false }) });
  const r2 = await rs.untilShownOrIdle(no.driver, sel, 3000, { everyMs: 100 });
  assert.equal(r2.shown, false);
  assert.ok(r2.ms >= 1500 && r2.ms <= 1700, `${r2.ms}`);
  } finally {
    mock.timers.reset();
  }
});

/* --------------------------- Reliance schedule link (no PDF on live) --------------------------- */

test("scheduleLinkLook: the schedule page loaded and no download for 2 s -> pageOnly; a download that starts is waited for", async () => {
  const wi = require("../fullPolicycompany/reliance/relianceWalletIssue");
  const mk = ({ pageAt = 0, fileAt = Infinity, url = "https://x/Motor/GenerateMotorSchedule?policyNo=1" } = {}) => {
    const c = clockDriver();
    const t0 = c.now();
    const at = () => c.now() - t0;
    c.driver.getCurrentUrl = async () => (at() >= pageAt ? url : "https://x/Payment/Success");
    c.driver.executeScript = async () => "complete";
    const fsImpl = {
      readdirSync: () => (at() >= fileAt ? ["policy.pdf.crdownload"] : []),
      statSync: () => ({ isFile: () => true, size: 10, mtimeMs: 1 }),
    };
    const ctx = { driver: c.driver, downloadDir: "/dl", fsImpl, sleep: (ms) => c.driver.sleep(ms), now: c.now, timing: wi.TIMING };
    return { ctx, at };
  };
  const page = mk({ pageAt: 400 });
  const r = await wi.scheduleLinkLook(page.ctx, { before: [], started: page.ctx.now(), budgetMs: 21500 });
  assert.equal(r.pageOnly, true);
  assert.ok(page.at() >= 2400 && page.at() <= 3000, `ended at ${page.at()} ms (old 21.5 s)`);

  const dl = mk({ pageAt: 400, fileAt: 1500 });
  const r2 = await wi.scheduleLinkLook(dl.ctx, { before: [], started: dl.ctx.now(), budgetMs: 21500 });
  assert.equal(r2.download, true, "a download that starts inside the grace is handed to the normal wait");

  const other = mk({ url: "https://x/Payment/Success" });
  const r3 = await wi.scheduleLinkLook(other.ctx, { before: [], started: other.ctx.now(), budgetMs: 21500 });
  assert.equal(r3.pageOnly, false);
  assert.ok(other.at() >= 21500, "no schedule page -> the old full look");
});
