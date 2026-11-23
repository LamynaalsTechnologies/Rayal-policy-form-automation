// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaPincodeCollect.test.js
//
// The owner's request (2026-11-23): run KSHEMA like the Make/Model collector, type each pin code, read the Pin code Locality
// dropdown, save it in the Pincode & Locality master - insert only. Wrong data is worse than none: a list is saved only when
// it surely belongs to the pin just typed. No browser, no network, no database: a fake portal and a fake database.
const test = require("node:test");
const assert = require("node:assert/strict");

const { collectPincodeLocalities, createPinQueue, newPinTotals, windowIsGone } = require("../lib/kshemaPincodeCollect");
const { parseArgs, pinsToRead } = require("../scripts/kshemaCollectPincodes");
const { parseStatePage, parseDistrictPage, tidyPins } = require("../scripts/collectTnPincodes");

const FIELDS = [
  { key: "pinCode", label: "Pin Code", type: "text", selectors: ["pin"] },
  { key: "locality", label: "Pin code Locality", type: "select", selectors: ["locality"] },
];

function fakeDb() {
  const store = [];
  return {
    store,
    collection() {
      return {
        async insertMany(docs) {
          const writeErrors = [];
          let insertedCount = 0;
          docs.forEach((d, index) => {
            if (store.some((s) => s.pincode === d.pincode && s.localityKey === d.localityKey)) writeErrors.push({ index, code: 11000 });
            else {
              store.push(d);
              insertedCount++;
            }
          });
          if (writeErrors.length) throw Object.assign(new Error("E11000"), { code: 11000, writeErrors, result: { insertedCount } });
          return { insertedCount };
        },
      };
    },
  };
}

/**
 * A fake KSHEMA page. `lists[pin]` = what the Locality dropdown lists for that pin; `lagReads` = how many reads after a new pin
 * still show the OLD list (a slow portal); `resetTo` = the Pin Code box changes to this after a read (the portal reset it).
 */
function fakePortal({ startPin = "600001", lists = {}, lagReads = {}, resetTo = {}, typeFails = {}, gone = null } = {}) {
  const page = { pin: startPin, shown: lists[startPin] || [], lag: 0, typed: [] };
  const driver = { sleep: async () => {} };
  const ctx = {
    waitForLoader: async () => {},
    async fillOneField(_d, _data, field, value) {
      assert.equal(field.key, "pinCode");
      if (gone === value) throw new Error("invalid session id\nmore");
      if (typeFails[value]) return { ok: false, reason: typeFails[value] };
      page.typed.push(value);
      page.pin = value;
      page.lag = lagReads[value] || 0;
      return { ok: true, value };
    },
    kshemaFields: {
      async findVisible() {
        return { element: { getAttribute: async () => page.pin } };
      },
    },
  };
  const readList = async (_d, _ctx, selectors, _label, { previousKeys, waitMs }) => {
    assert.deepEqual(selectors, ["locality"]);
    const read = () => {
      if (page.lag > 0) {
        page.lag--;
        return page.shown;
      }
      page.shown = lists[page.pin] || [];
      if (resetTo[page.pin]) page.pin = resetTo[page.pin];
      return page.shown;
    };
    let texts = read();
    const keys = (t) => t.map((x) => x.toUpperCase()).sort().join("|");
    // like readFollowingList: a list equal to the previous one is read again while the wait lasts (3 reads here)
    for (let i = 0; previousKeys !== null && texts.length && keys(texts) === previousKeys.replace(/\u0000/g, "|") && i < (waitMs ? 3 : 0); i++) texts = read();
    return { texts, stale: previousKeys !== null && texts.length > 0 && keys(texts) === previousKeys.replace(/\u0000/g, "|") };
  };
  return { page, driver, ctx, readList };
}

const run = async (portal, pins, extra = {}) => {
  const db = fakeDb();
  const totals = newPinTotals();
  const lines = [];
  const queue = createPinQueue(pins);
  const out = await collectPincodeLocalities(portal.driver, portal.ctx, {
    fields: FIELDS,
    db,
    data: { pinCode: portal.page.pin },
    queue,
    totals,
    log: (l) => lines.push(l),
    readList: portal.readList,
    settleMs: 0,
    ...extra,
  });
  return { db, totals, lines, out, queue };
};

test("each pin's list is saved under that pin, insert only (a second run adds nothing)", async () => {
  const lists = {
    600001: ["PARRYS S.O"],
    609001: ["MAYILADUTHURAI S.O", "KORANAD B.O"],
    621701: ["ARIYALUR S.O", "KAIRLABAD B.O", "VALAJANAGARAM B.O"],
  };
  const portal = fakePortal({ lists });
  const { db, totals, lines } = await run(portal, ["609001", "621701"]);
  assert.deepEqual(portal.page.typed, ["609001", "621701"]);
  assert.deepEqual(
    db.store.map((d) => [d.pincode, d.locality]),
    [
      ["609001", "MAYILADUTHURAI S.O"],
      ["609001", "KORANAD B.O"],
      ["621701", "ARIYALUR S.O"],
      ["621701", "KAIRLABAD B.O"],
      ["621701", "VALAJANAGARAM B.O"],
    ]
  );
  assert.equal(totals.namesAdded, 5);
  assert.deepEqual(totals.withLocalities, ["609001", "621701"]);
  assert.match(lines.join("\n"), /621701: 3 localities - 3 new, 0 already saved/);

  // the same pins again: nothing new, nothing changed
  const again = fakePortal({ lists });
  const second = await run(again, ["609001", "621701"]);
  const db2 = fakeDb();
  db2.store.push(...db.store);
  const third = await collectPincodeLocalities(again.driver, again.ctx, {
    fields: FIELDS,
    db: db2,
    data: { pinCode: again.page.pin },
    queue: createPinQueue(["609001"]),
    totals: newPinTotals(),
    readList: again.readList,
    settleMs: 0,
  });
  assert.ok(third.done);
  assert.equal(db2.store.length, 5);
  assert.equal(second.totals.namesAdded, 5); // (its own empty db)
});

test("a pin KSHEMA does not know (empty list) is reported, nothing saved", async () => {
  const portal = fakePortal({ lists: { 600001: ["PARRYS S.O"], 609002: [] } });
  const { db, totals } = await run(portal, ["609002"]);
  assert.equal(db.store.length, 0);
  assert.deepEqual(totals.empty, ["609002"]);
});

test("a slow portal still showing the previous pin's list: read again until it changes, then saved under the right pin", async () => {
  const lists = { 600001: ["PARRYS S.O"], 609001: ["MAYILADUTHURAI S.O"] };
  const portal = fakePortal({ lists, lagReads: { 609001: 2 } });
  const { db, totals } = await run(portal, ["609001"]);
  assert.deepEqual(db.store.map((d) => [d.pincode, d.locality]), [["609001", "MAYILADUTHURAI S.O"]]);
  assert.deepEqual(totals.stale, []);
});

test("a list that never changes from the previous pin's is NEVER saved under the new pin (tried once more, then reported)", async () => {
  const lists = { 600001: ["PARRYS S.O"], 609001: ["MAYILADUTHURAI S.O"] };
  const portal = fakePortal({ lists, lagReads: { 609001: 99 } });
  const { db, totals, lines } = await run(portal, ["609001"]);
  assert.equal(db.store.length, 0, "the previous pin's names must not be saved under 609001");
  assert.deepEqual(totals.stale, ["609001"]);
  assert.deepEqual(portal.page.typed, ["609001", "609001"]); // given back once
  assert.match(lines.join("\n"), /NOT saved/);
});

test("the Pin Code box no longer holding the pin after the read = nothing saved, reported after one more try", async () => {
  const lists = { 600001: ["PARRYS S.O"], 609001: ["MAYILADUTHURAI S.O"] };
  const portal = fakePortal({ lists, resetTo: { 609001: "600001" } });
  const { db, totals } = await run(portal, ["609001"]);
  assert.equal(db.store.length, 0);
  assert.equal(totals.failed.length, 1);
  assert.match(totals.failed[0].why, /Pin Code box shows "600001"/);
});

test("a pin the box refuses is tried once more, then reported; the next pins go on", async () => {
  const lists = { 600001: ["PARRYS S.O"], 609001: ["MAYILADUTHURAI S.O"] };
  const portal = fakePortal({ lists, typeFails: { 123456: "did not keep what was typed" } });
  const { db, totals } = await run(portal, ["123456", "609001"]);
  assert.deepEqual(totals.failed.map((f) => f.pin), ["123456"]);
  assert.deepEqual(db.store.map((d) => d.pincode), ["609001"]);
});

test("the browser window gone: the pin is given back for another window, and the window stops", async () => {
  const portal = fakePortal({ lists: { 600001: ["PARRYS S.O"] }, gone: "609001" });
  const queue = createPinQueue(["609001", "621701"]);
  await assert.rejects(
    collectPincodeLocalities(portal.driver, portal.ctx, {
      fields: FIELDS,
      db: fakeDb(),
      data: { pinCode: "600001" },
      queue,
      totals: newPinTotals(),
      readList: portal.readList,
      settleMs: 0,
    }),
    /invalid session id/
  );
  assert.deepEqual(queue.take(), { pin: "609001", again: true });
  assert.ok(windowIsGone(new Error("no such window: target window already closed")));
  assert.ok(!windowIsGone(new Error("the dropdown did not open")));
});

test("typing the pin already on screen is not 'stale' (its list is expected to be the same)", async () => {
  const portal = fakePortal({ startPin: "609001", lists: { 609001: ["MAYILADUTHURAI S.O"] } });
  const { db, totals } = await run(portal, ["609001"]);
  assert.deepEqual(db.store.map((d) => d.pincode), ["609001"]);
  assert.deepEqual(totals.stale, []);
});

test("the shared queue: no pin twice across windows, bad entries dropped", () => {
  const q = createPinQueue(["609001", " 609-003 ", "12345", "abc", "609001"]);
  assert.deepEqual(q.targets, ["609001", "609003", "609001"]);
  const a = q.take();
  const b = q.take();
  assert.notEqual(a.pin, b.pin);
});

// ---- the script's command line --------------------------------------------------------------------------------------------

test("command line: districts and pin codes, windows, again", () => {
  const id = "6af7fc4feaf23e0a5c3e431e";
  assert.deepEqual(parseArgs(["--policy", id, "Mayiladuthurai", "Ariyalur"]), {
    policy: id, districts: ["Mayiladuthurai", "Ariyalur"], pins: [], windows: 10, show: false, again: false, file: null,
  });
  assert.deepEqual(parseArgs(["--policy", id, "609001", "--windows", "1", "--again", "--show"]).pins, ["609001"]);
  assert.match(parseArgs(["Ariyalur"]).error, /--policy/);
  assert.match(parseArgs(["--policy", id, "--windows", "11"]).error, /1 to 10/);
  assert.equal(parseArgs(["--policy", id, "--windows", "10"]).windows, 10);
  assert.match(parseArgs(["--policy", id, "12345"]).error, /six digits/);
});

// ---- the pincodeapi.in reader ---------------------------------------------------------------------------------------------

test("state page: every district with its own link and stated count, other links ignored", () => {
  const html = `
    <a class="link-card" href="/state/tamil-nadu/district/ariyalur/"><span>Ariyalur</span><small>31 PIN codes · 222 offices</small></a>
    <a class="link-card" href="/state/tamil-nadu/district/the-nilgiris/"><span>The Nilgiris</span><small>47 PIN codes · 181 offices</small></a>
    <a class="link-card" href="/state/kerala/district/idukki/"><span>Idukki</span></a>
    <a class="link-card" href="/state/tamil-nadu/district/ariyalur/"><span>Ariyalur</span></a>
    <a href="/about/">About</a>`;
  assert.deepEqual(parseStatePage(html), [
    { district: "Ariyalur", url: "https://pincodeapi.in/state/tamil-nadu/district/ariyalur/", statedCount: 31 },
    { district: "The Nilgiris", url: "https://pincodeapi.in/state/tamil-nadu/district/the-nilgiris/", statedCount: 47 },
  ]);
});

test("district page: only the 'PIN codes in' list, the stated unique count, a next page", () => {
  const html = `<p>Mayiladuthurai district has 3 unique PIN codes and 9 post-office records.</p>
    <a class="chip" href="/600001/">600001</a>
    <section><h2>PIN codes in Mayiladuthurai</h2><div class="chip-row">
      <a class="chip" href="/609003/">609003</a><a class="chip" href="/609001/">609001</a><a class="chip" href="/609001/">609001</a>
    </div></section><section><a class="chip" href="/612999/">612999</a></section>
    <a rel="next" href="?page=2">Next</a>`;
  const page = parseDistrictPage(html, "https://pincodeapi.in/state/tamil-nadu/district/mayiladuthurai/");
  assert.deepEqual(page.pincodes, ["609003", "609001", "609001"]);
  assert.equal(page.statedCount, 3);
  assert.equal(page.nextUrl, "https://pincodeapi.in/state/tamil-nadu/district/mayiladuthurai/?page=2");
  assert.deepEqual(tidyPins(page.pincodes), ["609001", "609003"]);
});

test("each saved row carries its district; a pin in two districts names both; districts by name ignoring case", async () => {
  const list = [
    { district: "Mayiladuthurai", pincodes: ["609001", "612203"] },
    { district: "Thanjavur", pincodes: ["612203", "613001"] },
  ];
  const w = pinsToRead(list, { districts: ["mayiladuthurai"], pins: ["613001"] });
  assert.deepEqual(w.pins, ["609001", "612203", "613001"]);
  assert.equal(w.districtOf["612203"], "Mayiladuthurai / Thanjavur");
  assert.deepEqual(pinsToRead(list, {}).pins, ["609001", "612203", "613001"]); // nothing asked = every district
  assert.deepEqual(pinsToRead(list, { districts: ["Chennai"] }).unknown, ["Chennai"]);

  const portal = fakePortal({ lists: { 600001: ["PARRYS S.O"], 609001: ["MAYILADUTHURAI S.O"] } });
  const db = fakeDb();
  const lines = [];
  await collectPincodeLocalities(portal.driver, portal.ctx, {
    fields: FIELDS, db, data: { pinCode: "600001" }, queue: createPinQueue(["609001"], w.districtOf),
    totals: newPinTotals(), log: (l) => lines.push(l), readList: portal.readList, settleMs: 0,
  });
  assert.equal(db.store[0].district, "Mayiladuthurai");
  assert.match(lines[0], /^609001 \(Mayiladuthurai\): 1 localities/);
});

test("a window that dies on a pin already given back once still puts it back (the pin is not lost)", async () => {
  const portal = fakePortal({ lists: { 600001: ["PARRYS S.O"] }, gone: "609001" });
  const queue = createPinQueue(["609001"]);
  queue.giveBack("609001"); // its one retry already used
  queue.take();
  await assert.rejects(
    collectPincodeLocalities(portal.driver, portal.ctx, {
      fields: FIELDS, db: fakeDb(), data: { pinCode: "600001" }, queue, totals: newPinTotals(), readList: portal.readList, settleMs: 0,
    })
  );
  assert.ok(queue.left() >= 1);
  assert.equal(queue.take().pin, "609001");
});
