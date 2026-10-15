// Run with: npm test   (or: node --require ./test/support/noRealWorld.js --test test/relianceWalletIssue.test.js)
//
// After the CDT row is added, relianceWalletIssue.js presses Submit Details, reads the policy number, downloads the policy
// PDF and saves both on the policy. It really pays, so these tests are about what it REFUSES and the ORDER things happen
// in as much as about the happy path:
//   - a note is written on the policy BEFORE Submit Details is pressed, and a note that blocks (or a write that fails)
//     means nothing is pressed;
//   - Submit Details is pressed at most once, whatever the click reports;
//   - an answer that is not certain blocks re-runs like a successful one; a refusal that stays on the page does not;
//   - the number is saved before the PDF is touched, and never onto a record that is not certainly this policy's;
//   - the PDF is only taken from a NEW, finished, really-PDF file, and the number's own link is clicked (never "the first").
// The portal is a scripted stand-in with a fake clock, the database an in-memory fake, the download folder a fake file
// system and the bucket a recording function. No browser, no network, no real database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const issue = require("../fullPolicycompany/relianceWalletIssue");
const cdtModule = require("../fullPolicycompany/relianceWalletCdt");
const hold = require("../fullPolicycompany/relianceWalletHold");
const { beautifyError } = require("../lib/errorHandler");
const { AutomationStoppedError } = require("../automationStopper");

/** Run fn with the (chatty) logging switched off. */
async function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const PROPOSAL = "R141026125974";
const NUMBER = "120122623750221335";
const OP_ID = "OP1760400000000ABC";
const DOC_ID = "6700000000000000000000a1";
const PAISE = 626800; // 6,268.00
const DIR = "/job_dir";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(3000, 0x20), Buffer.from("\n%%EOF\n")]);

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

test("the switch is ON unless explicitly false / 0 / no / off, and is read at call time", () => {
  const withSwitch = (value, fn) => {
    const before = process.env.RELIANCE_WALLET_SUBMIT_ENABLED;
    if (value === undefined) delete process.env.RELIANCE_WALLET_SUBMIT_ENABLED;
    else process.env.RELIANCE_WALLET_SUBMIT_ENABLED = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.RELIANCE_WALLET_SUBMIT_ENABLED;
      else process.env.RELIANCE_WALLET_SUBMIT_ENABLED = before;
    }
  };
  withSwitch(undefined, () => assert.equal(hold.isWalletSubmitEnabled(), true));
  for (const on of ["true", "1", "yes", "on", ""]) withSwitch(on, () => assert.equal(hold.isWalletSubmitEnabled(), true, on));
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) withSwitch(off, () => assert.equal(hold.isWalletSubmitEnabled(), false, off));
  assert.equal(issue.isWalletSubmitEnabled, hold.isWalletSubmitEnabled);
});

test("amountsIn reads every plain rupee amount of a row, in whole paise, and nothing else", () => {
  assert.deepEqual(issue.amountsIn("CDT 6,268.00 Delete"), [626800]);
  assert.deepEqual(issue.amountsIn("₹ 1,23,456.50 CDT"), [12345650]);
  assert.deepEqual(issue.amountsIn("CDT 6268 6268.0"), [626800, 626800]);
  // a number with more than two decimals is not money; a proposal number is read as one big token, not as amounts
  assert.deepEqual(issue.amountsIn("v 1.2345"), []);
  assert.ok(!issue.amountsIn("R141026125974 CDT").includes(PAISE));
});

test("addedCdtRows: the new row with the exact amount — over 2,000 random amounts, formatted every way", () => {
  let seed = 20261014;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const paise = (next() % 9999999) + 1;
    const shown = cdtModule.formatPaise(paise);
    const variants = [shown, cdtModule.plainAmount(paise), `₹ ${shown}`];
    for (const v of variants) {
      const before = ["Proposal No Customer 1,200.00", "Payment Type Amount"];
      const after = [...before, `CDT ${v} 14-10-2026 Delete`];
      const r = issue.addedCdtRows(before, after, paise);
      assert.equal(r.matching.length, 1, `${paise} as ${v}`);
      assert.equal(r.duplicated, false);
      assert.equal(r.cdtWordMissing, false);
      // a different amount is not the row
      assert.equal(issue.addedCdtRows(before, [...before, `CDT ${cdtModule.formatPaise(paise + 1)} Delete`], paise).matching.length, 0);
    }
  }
});

test("addedCdtRows: unchanged rows, a changed amount, a doubled row and a row without the word CDT are all told apart", () => {
  const before = ["A 1", "Total 6,268.00"];
  // nothing new
  assert.equal(issue.addedCdtRows(before, [...before], PAISE).matching.length, 0);
  // a row that was there before and shows the amount is NOT the added one
  assert.equal(issue.addedCdtRows(["CDT 6,268.00 Delete"], ["CDT 6,268.00 Delete"], PAISE).matching.length, 0);
  // the same row twice = Add pressed twice
  const twice = issue.addedCdtRows(before, [...before, "CDT 6,268.00 Delete", "CDT 6,268.00 Delete"], PAISE);
  assert.equal(twice.matching.length, 2);
  assert.equal(twice.duplicated, true);
  // the same row that already existed once plus one more = the new one is found
  const oneMore = issue.addedCdtRows(["CDT 6,268.00 Delete"], ["CDT 6,268.00 Delete", "CDT 6,268.00 Delete"], PAISE);
  assert.equal(oneMore.matching.length, 1);
  // a single new row with the amount but no word CDT is accepted and flagged; two of them are not
  const bare = issue.addedCdtRows(before, [...before, "Wallet 6,268.00 Delete"], PAISE);
  assert.equal(bare.matching.length, 1);
  assert.equal(bare.cdtWordMissing, true);
  assert.equal(issue.addedCdtRows(before, [...before, "Wallet 6,268.00 a", "Other 6,268.00 b"], PAISE).matching.length, 0);
  // the word CDT must be a word
  assert.equal(issue.addedCdtRows(before, [...before, "ACDTX 6,268.00"], PAISE).cdtWordMissing, true);
});

test("policyNumberFromHref / isPlausiblePolicyNumber", () => {
  assert.equal(issue.policyNumberFromHref("../../Motor/GenerateMotorSchedule?policyNo=120122623750221335"), NUMBER);
  assert.equal(issue.policyNumberFromHref("https://x/Motor/GenerateMotorSchedule?a=1&policyNo=1201%2F2262%2F3750&b=2"), "1201/2262/3750");
  assert.equal(issue.policyNumberFromHref("https://x/Motor/GenerateMotorSchedule?policyno=12 0122623750 221335"), NUMBER);
  assert.equal(issue.policyNumberFromHref("https://x/other"), "");
  assert.equal(issue.policyNumberFromHref(null), "");

  assert.equal(issue.isPlausiblePolicyNumber(NUMBER), true);
  assert.equal(issue.isPlausiblePolicyNumber("1201-2262-3750-22"), true);
  for (const bad of ["", "Search", "12345", "ABCDEFGHIJ", OP_ID, "OP1760400000000ABC", "a b", "120122623750221335;DROP"]) {
    assert.equal(issue.isPlausiblePolicyNumber(bad), false, JSON.stringify(bad));
  }
  assert.equal(issue.isPlausiblePolicyNumber(PROPOSAL, PROPOSAL), false, "the proposal number is not a policy number");
});

test("policyFileNames follow the backend's own convention: <d><m><yyyy>-<9 random>-Policy.pdf in the Policy folder", () => {
  const r = issue.policyFileNames(new Date(2026, 9, 4), () => 0); // 4 Oct 2026, always the first character
  assert.equal(r.fileName, "4102026-AAAAAAAAA-Policy.pdf", "day and month are NOT zero padded, like getFileName");
  assert.equal(r.key, "Policy/4102026-AAAAAAAAA-Policy.pdf");
  const real = issue.policyFileNames(new Date(2026, 11, 14));
  assert.match(real.fileName, /^14122026-[A-Z0-9]{9}-Policy\.pdf$/);
  assert.notEqual(issue.policyFileNames().fileName, issue.policyFileNames().fileName, "random part differs");
});

test("markerFieldFor: one note per policy, one per part of a multi-company policy", () => {
  assert.equal(issue.markerFieldFor({}), "walletPayment");
  assert.equal(issue.markerFieldFor({ _partKey: "motor" }), "walletPayment");
  assert.equal(issue.markerFieldFor({ _partKey: "od" }), "walletPayment_od");
  assert.equal(issue.markerFieldFor({ _partKey: "TP" }), "walletPayment_tp");
  assert.equal(issue.markerFieldFor({ _partKey: "o d$" }), "walletPayment_od");
});

test("whenText and gateMessage carry no colon (beautifyError keeps only what follows the last colon)", () => {
  assert.equal(issue.whenText(new Date(2026, 9, 14, 14, 5)), "14 Oct 2026 14.05");
  assert.equal(issue.whenText("garbage"), "an unknown time");
  for (const state of ["submit-pressed", "issued", "unconfirmed"]) {
    const message = issue.gateMessage({
      state,
      proposalNumber: PROPOSAL,
      amountPaise: PAISE,
      at: new Date(2026, 9, 14, 14, 32),
      policyNumber: state === "issued" ? NUMBER : undefined,
      field: "walletPayment",
    });
    assert.ok(!message.includes(":"), message);
    assert.equal(beautifyError(message, "Reliance"), `[Reliance] ${message}`);
    assert.match(message, /already submitted for this policy at Reliance/);
    assert.match(message, /proposal R141026125974, CDT 6,268\.00, on 14 Oct 2026 14\.32, state/);
    assert.match(message, /not started so the customer is not charged twice/);
    assert.match(message, /clear the walletPayment note/);
  }
});

/* -------------------------------------------------------------------------- */
/* classifyIssuePage                                                          */
/* -------------------------------------------------------------------------- */

const successPageFor = (number, extra = {}) => ({
  url: "https://smartzone.reliancegeneral.co.in/Payment/PaymentSuccess",
  links: [{ href: `https://smartzone.reliancegeneral.co.in/Motor/GenerateMotorSchedule?policyNo=${number}`, text: number, shown: true }],
  success: true,
  policyNoTexts: [number],
  transactionNo: "TXN9981",
  dialogs: [],
  ...extra,
});

test("classifyIssuePage: success needs the schedule link's number, consistent with the page's own words", () => {
  const ok = issue.classifyIssuePage(successPageFor(NUMBER), { proposalNumber: PROPOSAL });
  assert.equal(ok.kind, "success");
  assert.equal(ok.policyNumber, NUMBER);
  assert.equal(ok.transactionNo, "TXN9981");
  assert.equal(ok.confirmedByText, true);

  // link only (the text does not name a number): still success
  const linkOnly = issue.classifyIssuePage(successPageFor(NUMBER, { policyNoTexts: [], success: false }), {});
  assert.equal(linkOnly.kind, "success");
  assert.equal(linkOnly.confirmedByText, false);

  // the text names ANOTHER number: a contradiction — nothing is saved on a doubt
  const mismatch = issue.classifyIssuePage(successPageFor(NUMBER, { policyNoTexts: ["120122623750229999"] }), {});
  assert.equal(mismatch.kind, "conflict");
  assert.match(mismatch.why, /names policy 120122623750229999 but its link names 120122623750221335/);

  // two links with two numbers
  const two = successPageFor(NUMBER);
  two.links.push({ href: "https://x/Motor/GenerateMotorSchedule?policyNo=120122623750220000", text: "other", shown: true });
  assert.equal(issue.classifyIssuePage(two, {}).kind, "conflict");

  // the proposal number, or our placeholder, is not a policy number
  assert.equal(issue.classifyIssuePage(successPageFor(PROPOSAL), { proposalNumber: PROPOSAL }).kind, "conflict");
  assert.equal(issue.classifyIssuePage(successPageFor(OP_ID), {}).kind, "conflict");
});

test("classifyIssuePage: no link yet = pending; a refusal is only a refusal when it carries no success words", () => {
  const empty = issue.classifyIssuePage({ links: [], dialogs: [], success: false }, { alerts: [] });
  assert.equal(empty.kind, "pending");
  assert.equal(empty.refusal, "");

  const refused = issue.classifyIssuePage({ links: [], dialogs: ["Insufficient CDT balance"] }, { alerts: [] });
  assert.equal(refused.kind, "pending");
  assert.equal(refused.refusal, "Insufficient CDT balance");

  // an alert that says the payment worked (even with a refusal word in it) is NOT a refusal
  const mixed = issue.classifyIssuePage({ links: [], dialogs: [] }, { alerts: ["Payment successful but policy generation failed, please wait"] });
  assert.equal(mixed.refusal, "");
  assert.equal(mixed.successWords, true);

  const successWordsOnly = issue.classifyIssuePage({ links: [], dialogs: [], success: true }, { alerts: [] });
  assert.equal(successWordsOnly.kind, "pending");
  assert.equal(successWordsOnly.successWords, true);
});

/* -------------------------------------------------------------------------- */
/* A fake database                                                            */
/* -------------------------------------------------------------------------- */

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (o[parts[i]] === undefined || o[parts[i]] === null || typeof o[parts[i]] !== "object") o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}
function matches(doc, filter) {
  return Object.entries(filter).every(([key, want]) => {
    const have = getPath(doc, key);
    if (want && typeof want === "object" && !Array.isArray(want) && !(want instanceof Date)) {
      if ("$in" in want) return want.$in.includes(have);
      if ("$nin" in want) return !want.$nin.includes(have);
      if ("$exists" in want) return (have !== undefined) === want.$exists;
      throw new Error(`fake db: operator not supported ${JSON.stringify(want)}`);
    }
    return String(have) === String(want);
  });
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * @param {Object} seed        { onlinePolicy: [...], policy: [...] }
 * @param {Object} [o]
 * @param {string[]} [o.order]       a shared log; every write is pushed as "db:<collection>:<fields>"
 * @param {string}   [o.connectError]
 * @param {Function} [o.updateError] (collection, filter, update) -> Error | undefined
 */
function makeMongo(seed, o = {}) {
  const data = { onlinePolicy: clone(seed.onlinePolicy || []), policy: clone(seed.policy || []) };
  const writes = [];
  const collection = (name) => ({
    async findOne(filter) {
      const hit = data[name].find((d) => matches(d, filter));
      return hit ? clone(hit) : null;
    },
    find(filter) {
      return { toArray: async () => data[name].filter((d) => matches(d, filter)).map(clone) };
    },
    async updateOne(filter, update) {
      const err = o.updateError && o.updateError(name, filter, update);
      if (err) throw err;
      const hit = data[name].find((d) => matches(d, filter));
      writes.push({ name, filter: clone(filter), update: clone(update), matched: !!hit });
      if (!hit) return { matchedCount: 0, modifiedCount: 0 };
      if (o.order) o.order.push(`db:${name}:${Object.keys(update.$set || {}).filter((k) => k !== "updatedAt").join(",")}`);
      for (const [k, v] of Object.entries(update.$set || {})) setPath(hit, k, clone(v));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  class Client {
    async connect() {
      if (o.connectError) throw new Error(o.connectError);
    }
    db() {
      return { collection };
    }
    async close() {}
  }
  return { Client, data, writes };
}

const seedPolicy = (extra = {}) => ({
  onlinePolicy: [{ _id: DOC_ID, policyId: OP_ID, clientId: "client1", proposalNumber: PROPOSAL, ...(extra.onlinePolicy || {}) }],
  policy: extra.policy || [
    { _id: "pol1", isOnlinePolicy: true, clientId: "client1", policyNumber: OP_ID, policyFile: {} },
    { _id: "pol2", isOnlinePolicy: true, clientId: "client2", policyNumber: "OP999", policyFile: {} },
  ],
});

/* -------------------------------------------------------------------------- */
/* The gate and the store                                                     */
/* -------------------------------------------------------------------------- */

test("checkSubmitGate: blocks submit-pressed / issued / unconfirmed, lets none / failed through, per part", async () => {
  const gate = async (note, data = { _id: DOC_ID, policyId: OP_ID }, field = "walletPayment") => {
    const db = makeMongo(seedPolicy({ onlinePolicy: note ? { [field]: note } : {} }));
    return quiet(() => issue.checkSubmitGate(data, "J", { MongoClient: db.Client }));
  };
  for (const state of ["submit-pressed", "issued", "unconfirmed"]) {
    const g = await gate({ state, proposalNumber: PROPOSAL, amountPaise: PAISE, at: new Date(), policyNumber: NUMBER });
    assert.equal(g.blocked, true, state);
    assert.equal(g.state, state);
    assert.match(g.message, /already submitted for this policy/);
  }
  assert.equal((await gate({ state: "failed" })).blocked, false, "a refusal that stayed on the payment page may be run again");
  assert.equal((await gate(null)).blocked, false);
  // the OD part's note does not block the TP part, nor the policy's own
  assert.equal((await gate({ state: "issued" }, { _id: DOC_ID, _partKey: "tp" }, "walletPayment_od")).blocked, false);
  assert.equal((await gate({ state: "issued" }, { _id: DOC_ID, _partKey: "od" }, "walletPayment_od")).blocked, true);
  // no policy id / a database that cannot be read: not blocked, said so (the guarded write decides later)
  assert.equal((await quiet(() => issue.checkSubmitGate({}, "J", { MongoClient: makeMongo(seedPolicy()).Client }))).blocked, false);
  const down = await quiet(() => issue.checkSubmitGate({ _id: DOC_ID }, "J", { MongoClient: makeMongo(seedPolicy(), { connectError: "ECONNREFUSED" }).Client }));
  assert.equal(down.blocked, false);
  assert.equal(down.unknown, true);
});

test("store.claim is a GUARDED write: it matches only when no blocking note is there", async () => {
  const note = { state: "submit-pressed", amountPaise: PAISE };
  const fresh = makeMongo(seedPolicy());
  const store = issue.createIssueStore({ MongoClient: fresh.Client, field: "walletPayment", policyId: DOC_ID });
  assert.deepEqual(await store.claim(note), { matched: 1, modified: 1 });
  assert.equal(fresh.data.onlinePolicy[0].walletPayment.state, "submit-pressed");
  // a second claim (another run of the same policy) matches nothing and changes nothing
  const second = await store.claim({ state: "submit-pressed", amountPaise: 1 });
  assert.equal(second.matched, 0);
  assert.equal(fresh.data.onlinePolicy[0].walletPayment.amountPaise, PAISE);

  for (const state of ["issued", "unconfirmed"]) {
    const db = makeMongo(seedPolicy({ onlinePolicy: { walletPayment: { state } } }));
    const s = issue.createIssueStore({ MongoClient: db.Client, policyId: DOC_ID });
    assert.equal((await s.claim(note)).matched, 0, state);
  }
  // after a refusal that stayed on the page the policy can be claimed again
  const failed = makeMongo(seedPolicy({ onlinePolicy: { walletPayment: { state: "failed" } } }));
  assert.equal((await issue.createIssueStore({ MongoClient: failed.Client, policyId: DOC_ID }).claim(note)).matched, 1);
});

test("store.saveNumber: the policy record is found by the placeholder id, and never guessed", async () => {
  const run = async (seed, number = NUMBER, o = {}) => {
    const db = makeMongo(seed, o);
    const store = issue.createIssueStore({ MongoClient: db.Client, policyId: DOC_ID });
    return { db, result: await store.saveNumber(number) };
  };

  // the normal case: online policy and the record with the OP id both get the number; another client's record is untouched
  const a = await run(seedPolicy());
  assert.equal(a.result.onlinePolicy, "saved");
  assert.equal(a.result.policy, "saved");
  assert.equal(a.result.policyDocId, "pol1");
  assert.equal(a.db.data.onlinePolicy[0].policyNumber, NUMBER);
  assert.equal(a.db.data.policy.find((p) => p._id === "pol1").policyNumber, NUMBER);
  assert.equal(a.db.data.policy.find((p) => p._id === "pol2").policyNumber, "OP999");
  assert.deepEqual(a.result.warnings, []);

  // the same number again: nothing changes
  const b = await run(seedPolicy({ onlinePolicy: { policyNumber: NUMBER }, policy: [{ _id: "pol1", isOnlinePolicy: true, clientId: "client1", policyNumber: NUMBER }] }));
  assert.equal(b.result.onlinePolicy, "already");
  assert.equal(b.result.policy, "already");

  // a DIFFERENT number is already there: first writer wins, reported, nothing replaced
  const c = await run(seedPolicy({ onlinePolicy: { policyNumber: "999999999999" }, policy: [{ _id: "pol1", isOnlinePolicy: true, clientId: "client1", policyNumber: "888888888888" }] }));
  assert.equal(c.result.onlinePolicy, "other-number");
  assert.equal(c.result.policy, "not-found", "a record holding another number is not this policy's (not matched by the placeholder)");
  assert.equal(c.db.data.onlinePolicy[0].policyNumber, "999999999999");
  assert.equal(c.db.data.policy[0].policyNumber, "888888888888");

  // no record / two records: never guessed
  const none = await run(seedPolicy({ policy: [{ _id: "x", isOnlinePolicy: true, clientId: "client9", policyNumber: OP_ID }] }));
  assert.equal(none.result.policy, "not-found");
  assert.match(none.result.warnings.join(" "), /no policy record of this online policy was found/);
  assert.equal(none.db.data.policy[0].policyNumber, OP_ID, "another client's record is never touched");
  const two = await run(
    seedPolicy({
      policy: [
        { _id: "p1", isOnlinePolicy: true, clientId: "client1", policyNumber: OP_ID },
        { _id: "p2", isOnlinePolicy: true, clientId: "client1", policyNumber: NUMBER },
      ],
    })
  );
  assert.equal(two.result.policy, "ambiguous");
  assert.deepEqual(
    two.db.data.policy.map((p) => p.policyNumber),
    [OP_ID, NUMBER]
  );

  // a record that is not an online policy's is not matched
  const offline = await run(seedPolicy({ policy: [{ _id: "p1", isOnlinePolicy: false, clientId: "client1", policyNumber: OP_ID }] }));
  assert.equal(offline.result.policy, "not-found");

  // the unique index (client, policyNumber): reported, the online policy still got the number
  const dup = await run(seedPolicy(), NUMBER, {
    updateError: (name, filter, update) => {
      if (name === "policy" && update.$set.policyNumber) return Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    },
  });
  assert.equal(dup.result.policy, "duplicate");
  assert.equal(dup.result.onlinePolicy, "saved");
  assert.equal(dup.result.policyDocId, "pol1", "the record is still known, so the PDF can be set on it");
  assert.match(dup.result.warnings.join(" "), /another policy record of this client already holds the policy number/);

  // the database is down: said, not thrown
  const down = await run(seedPolicy(), NUMBER, { connectError: "ECONNREFUSED" });
  assert.match(down.result.warnings.join(" "), /could not be saved \(ECONNREFUSED\)/);
});

test("store.savePdf: policyFile when empty, mergedPolicyPdf only when empty, an existing file is never replaced", async () => {
  const file = { fileName: "4102026-ABC123XYZ-Policy.pdf", key: "Policy/4102026-ABC123XYZ-Policy.pdf", location: "https://b/Policy/x.pdf" };
  const db = makeMongo(seedPolicy());
  const store = issue.createIssueStore({ MongoClient: db.Client, policyId: DOC_ID });
  const r = await store.savePdf(file, "pol1");
  assert.equal(r.policy, "saved");
  assert.equal(r.onlinePolicy, "saved");
  assert.deepEqual(db.data.policy.find((p) => p._id === "pol1").policyFile, file);
  assert.deepEqual(db.data.onlinePolicy[0].mergedPolicyPdf, file);

  // a file is already on the policy and on the online policy: both kept, reported for the policy record
  const had = { fileName: "old.pdf", key: "Policy/old.pdf", location: "https://b/old.pdf" };
  const db2 = makeMongo(seedPolicy({ onlinePolicy: { mergedPolicyPdf: had }, policy: [{ _id: "pol1", isOnlinePolicy: true, clientId: "client1", policyNumber: NUMBER, policyFile: had }] }));
  const r2 = await issue.createIssueStore({ MongoClient: db2.Client, policyId: DOC_ID }).savePdf(file, "pol1");
  assert.equal(r2.policy, "kept-other");
  assert.equal(r2.onlinePolicy, "kept-other");
  assert.deepEqual(db2.data.policy[0].policyFile, had);
  assert.deepEqual(db2.data.onlinePolicy[0].mergedPolicyPdf, had);
  assert.match(r2.warnings.join(" "), /already has a policy file/);

  // the record is not known: the object is stored, said so
  const r3 = await issue.createIssueStore({ MongoClient: makeMongo(seedPolicy()).Client, policyId: DOC_ID }).savePdf(file, null);
  assert.equal(r3.policy, "not-saved");
  assert.match(r3.warnings.join(" "), /policy record was not found/);
});

/* -------------------------------------------------------------------------- */
/* waitForDownloadedPdf                                                       */
/* -------------------------------------------------------------------------- */

/** An in-memory download folder with a fake clock; files can be scheduled to appear. */
function makeFolder() {
  const f = {
    clock: 0,
    files: new Map(), // full path -> { size, mtimeMs, buf }
    due: [],
    add(name, buf, mtimeMs = f.clock) {
      f.files.set(path.join(DIR, name), { size: buf.length, mtimeMs, buf });
    },
    remove(name) {
      f.files.delete(path.join(DIR, name));
    },
    at(ms, fn) {
      f.due.push({ at: f.clock + ms, fn });
    },
    async sleep(ms) {
      f.clock += ms;
      f.due.filter((d) => d.at <= f.clock).forEach((d) => d.fn());
      f.due = f.due.filter((d) => d.at > f.clock);
    },
    fsImpl: {
      existsSync: (p) => p === DIR || f.files.has(p),
      readdirSync: (dir) => {
        if (dir !== DIR) throw new Error("ENOENT");
        return [...f.files.keys()].map((p) => path.basename(p));
      },
      statSync: (p) => {
        const e = f.files.get(p);
        if (!e) throw new Error("ENOENT");
        return { isFile: () => true, size: e.size, mtimeMs: e.mtimeMs };
      },
      openSync: (p) => {
        if (!f.files.has(p)) throw new Error("ENOENT");
        return p;
      },
      readSync: (fd, buffer, offset, length, position) => {
        const e = f.files.get(fd);
        return e.buf.copy(buffer, offset, position, position + length);
      },
      closeSync: () => {},
    },
  };
  return f;
}

const waitOpts = (folder, o = {}) => ({
  dir: DIR,
  before: issue.listFiles(DIR, folder.fsImpl),
  timeoutMs: 20000,
  pollMs: 500,
  stableMs: 1500,
  now: () => folder.clock,
  sleep: (ms) => folder.sleep(ms),
  fsImpl: folder.fsImpl,
  ...o,
});

test("waitForDownloadedPdf: a NEW finished PDF is returned only once its size is stable and its bytes are a PDF", async () => {
  const folder = makeFolder();
  folder.add("old-kyc.pdf", PDF, 1);
  const opts = waitOpts(folder);
  folder.at(3000, () => folder.add("GenerateMotorSchedule.pdf", PDF));
  const got = await issue.waitForDownloadedPdf(opts);
  assert.equal(got.ok, true);
  assert.equal(got.name, "GenerateMotorSchedule.pdf", "the old PDF that was already there is ignored");
  assert.equal(got.size, PDF.length);
  assert.equal(got.truncated, false);
  assert.ok(folder.clock >= 3000 + 1500, "not accepted before its size had been stable for stableMs");
});

test("waitForDownloadedPdf: a Chrome download still in progress is waited for, then the finished file taken", async () => {
  const folder = makeFolder();
  const opts = waitOpts(folder);
  folder.add("GenerateMotorSchedule.pdf.crdownload", Buffer.from("%PDF-1.4 partial"));
  folder.at(6000, () => {
    folder.remove("GenerateMotorSchedule.pdf.crdownload");
    folder.add("GenerateMotorSchedule.pdf", PDF);
  });
  const got = await issue.waitForDownloadedPdf(opts);
  assert.equal(got.ok, true);
  assert.ok(folder.clock >= 6000);
});

test("waitForDownloadedPdf: while ANOTHER download is still in progress nothing is taken (it could be the one)", async () => {
  const folder = makeFolder();
  const opts = waitOpts(folder);
  folder.add("a.pdf", PDF);
  folder.add("b.pdf.crdownload", Buffer.from("%PDF-1.4 partial"));
  folder.at(7000, () => folder.remove("b.pdf.crdownload"));
  const got = await issue.waitForDownloadedPdf(opts);
  assert.equal(got.ok, true);
  assert.ok(folder.clock >= 7000, `taken only after the other download finished (clock ${folder.clock})`);
});

test("waitForDownloadedPdf: a growing file is not taken until it stops growing", async () => {
  const folder = makeFolder();
  const opts = waitOpts(folder);
  const half = PDF.subarray(0, 1500);
  folder.add("p.pdf", half);
  folder.at(1000, () => folder.add("p.pdf", PDF.subarray(0, 2500)));
  folder.at(2000, () => folder.add("p.pdf", PDF));
  const got = await issue.waitForDownloadedPdf(opts);
  assert.equal(got.ok, true);
  assert.equal(got.size, PDF.length, "the whole file, not a half one");
});

test("waitForDownloadedPdf: an HTML page saved as a download is not a PDF, and is reported as what it is", async () => {
  const html = Buffer.from("<!DOCTYPE html><html><body>Session expired</body></html>");
  // a file that was already there before the click is not new, whatever it holds
  const before = makeFolder();
  before.add("GenerateMotorSchedule.pdf", html);
  const old = await issue.waitForDownloadedPdf(waitOpts(before, { timeoutMs: 4000 }));
  assert.equal(old.ok, false);
  assert.equal(old.reason, "timeout");

  // one that arrives is looked at: not a PDF
  const folder = makeFolder();
  const opts = waitOpts(folder, { timeoutMs: 8000 });
  folder.at(500, () => folder.add("GenerateMotorSchedule.pdf", html));
  const got = await issue.waitForDownloadedPdf(opts);
  assert.equal(got.ok, false);
  assert.equal(got.reason, "not-pdf");
  assert.match(got.detail, /GenerateMotorSchedule\.pdf is a web page/);

  // an error document says so
  const xml = makeFolder();
  const xmlOpts = waitOpts(xml, { timeoutMs: 8000 });
  xml.at(500, () => xml.add("x.pdf", Buffer.from("<?xml version='1.0'?><Error><Code>ExpiredToken</Code></Error>")));
  const gotXml = await issue.waitForDownloadedPdf(xmlOpts);
  assert.equal(gotXml.reason, "not-pdf");
  assert.match(gotXml.detail, /x\.pdf is an error document/);
});

test("waitForDownloadedPdf: nothing arrives = a timeout that says so; a file without a trailing %%EOF is kept but flagged", async () => {
  const folder = makeFolder();
  const none = await issue.waitForDownloadedPdf(waitOpts(folder, { timeoutMs: 5000 }));
  assert.equal(none.ok, false);
  assert.equal(none.reason, "timeout");

  const folder2 = makeFolder();
  const opts = waitOpts(folder2);
  folder2.at(500, () => folder2.add("x.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(500, 0x41)])));
  const got = await issue.waitForDownloadedPdf(opts);
  assert.equal(got.ok, true);
  assert.equal(got.truncated, true);
});

/* -------------------------------------------------------------------------- */
/* A scripted portal                                                          */
/* -------------------------------------------------------------------------- */

function alertError(text) {
  const e = new Error(`unexpected alert open: {Alert text : ${text}}\n  (Session info: chrome=150.0.0.0)`);
  e.name = "UnexpectedAlertOpenError";
  return e;
}
function named(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

/**
 * The payment page (Submit Details), then Reliance's answer, then the View Policy search page. Everything that matters
 * is logged in `order`, which is shared with the fake database.
 *
 * @param {Object} o
 * @param {number}  [o.resultDelayMs=3000]   how long the answer takes after Submit Details
 * @param {string}  [o.answer="success"]     success | refused | none | successNoLink | conflict | login | numberMismatch
 * @param {string}  [o.refusalWords]
 * @param {string}  [o.alertOnSubmit]        the click raises this native alert (ChromeDriver dismisses it, fails the command)
 * @param {string}  [o.submitClickError]     "intercepted" | "timeout" | "gone" — what the real click throws
 * @param {boolean} [o.submitDisabled]
 * @param {boolean} [o.submitMissing]
 * @param {string}  [o.dialog]               a message of Reliance's open on the payment page
 * @param {boolean} [o.dialogCloses]         ... that closes itself after a second
 * @param {boolean} [o.linkDownloads=true]   the schedule link downloads a PDF
 * @param {boolean} [o.linkOpensHtml]        the schedule link downloads an HTML page named .pdf
 * @param {boolean} [o.viewDownloads=true]   the View Policy result link downloads a PDF
 * @param {string}  [o.searchDefault="Proposal Number"]
 * @param {boolean} [o.listClickIgnored]     clicking the list item does nothing (the Kendo API must do it)
 * @param {Object[]} [o.results]             rows the search lists [{text, href}] (default: the policy's own)
 * @param {boolean} [o.noMenu]               Utilities is not on the page
 * @param {boolean} [o.noMenuHref]           the page has no "View Policy" link at all (so no address to read from it)
 * @param {string}  [o.menuHref]             the address of the page's "View Policy" link
 * @param {boolean} [o.viewAddressFails]     opening the View Policy address lands on the login page (a lost session)
 * @param {boolean} [o.menuItemMissing]      hovering Utilities opens nothing (the schedule page's scripts are broken)
 * @param {boolean} [o.searchClickIgnored]   the Search button's click does nothing (only the page's own function searches)
 * @param {string[]} [o.rowsBefore]
 * @param {string[]} [o.rowsAdded]
 */
function makeWorld(o = {}) {
  const folder = makeFolder();
  const w = {
    folder,
    order: [],
    submitClicks: 0,
    scheduleClicks: 0,
    searchClicks: 0,
    resultClicks: [],
    typed: [],
    hovers: 0,
    backs: 0,
    kendoCalls: [],
    gets: [],
    nudges: 0,
    scriptClicks: 0,
    alertText: "",
    page: "pay",
    page2: null, // the page of a second window ("w2"), when the press opens one
    current: "main",
    refused: false,
    view: { open: false, option: o.searchDefault || "Proposal Number", listOpen: false, box: "", searched: false, results: [] },
    dialog: o.dialog || "",
    windows: ["main"],
    uploads: [],
    shots: [],
    checkpoints: [],
  };
  const log = (s) => w.order.push(s);
  w.log = log;

  const rowsBefore = o.rowsBefore || ["Proposal No Customer Amount", `${PROPOSAL} A CUSTOMER 6,268.00`];
  const rowsAdded = o.rowsAdded || ["CDT 6,268.00 14-10-2026 Delete"];
  w.rowsBefore = rowsBefore;
  const BASE = "https://smartzone.reliancegeneral.co.in";

  const numberOnPage = o.numberOnPage || NUMBER;
  const cur = () => (w.current === "w2" ? w.page2 : w.page);
  const setCur = (kind) => {
    if (w.current === "w2") w.page2 = kind;
    else w.page = kind;
  };
  const urlOf = (kind) =>
    ({
      pay: `${BASE}/Payment/Payments`,
      success: `${BASE}/Payment/PaymentSuccessMsg?PolicyNo=ENC`,
      "success-no-link": `${BASE}/Payment/PaymentSuccessMsg?PolicyNo=ENC`,
      schedule: `${BASE}/Motor/GenerateMotorSchedule?policyNo=${NUMBER}`,
      view: `${BASE}/Policy/ViewPolicySearch`,
      login: `${BASE}/Login/IMDLogin`,
    }[kind] || `${BASE}/Motor/Other`);
  w.issuePage = () => {
    const pageKind = cur();
    const common = { title: "", loading: false, dialogButtons: [], rowTexts: [], links: [], policyNoTexts: [], transactionNo: "", success: false, excerpt: "" };
    if (pageKind === "pay") {
      return {
        ...common,
        url: `${BASE}/Payment/Payments`,
        submit: {
          exists: !o.submitMissing,
          shown: !o.submitMissing,
          enabled: !(o.submitDisabled || (o.submitDisabledFromRead && (w.issueReads || 0) >= o.submitDisabledFromRead)),
        },
        rowTexts: [...rowsBefore, ...rowsAdded],
        dialogs: w.dialog ? [w.dialog] : [],
        dialogButtons: w.dialog ? ["Ok"] : [],
      };
    }
    if (pageKind === "success") {
      return {
        ...common,
        url: `${BASE}/Payment/PaymentSuccess`,
        submit: { exists: false, shown: false, enabled: false },
        links: [{ href: `${BASE}/Motor/GenerateMotorSchedule?policyNo=${numberOnPage}`, text: "click here", shown: true }],
        policyNoTexts: [o.answer === "numberMismatch" ? "120122623750229999" : numberOnPage],
        success: true,
        transactionNo: "TXN9981",
      };
    }
    if (pageKind === "success-no-link") {
      return { ...common, url: `${BASE}/Payment/PaymentSuccess`, submit: { exists: false, shown: false, enabled: false }, success: true };
    }
    if (pageKind === "login") {
      return { ...common, url: `${BASE}/Login/IMDLogin`, submit: { exists: false, shown: false, enabled: false } };
    }
    // "gone": the page navigated away to something that is neither
    return { ...common, url: `${BASE}/Motor/Other`, submit: { exists: false, shown: false, enabled: false } };
  };

  w.viewPage = () => {
    const v = w.view;
    if (cur() !== "view") {
      // any other page: the search box and dropdown are not there
      return { url: `${BASE}/Motor/Other`, loading: false, dropdowns: [], inputs: [], buttons: [], links: [], noRecords: false };
    }
    return {
      url: `${BASE}/Policy/ViewPolicySearch`,
      loading: false,
      dropdowns: [
        {
          token: "dd-0",
          current: v.option,
          listId: "ddlSearchBy_listbox",
          items: ["Proposal Number", "Policy Number", "Customer Name"],
          shown: true,
        },
      ],
      inputs: [{ token: "in-3", id: "txtSearchText", name: "SearchText", value: v.box, shown: true, enabled: true }],
      buttons: [{ token: "bt-5", id: "btnViewPolicySearch", label: "Search", shown: true, enabled: true }],
      links: v.searched ? v.results.map((r, i) => ({ token: `lk-${i}`, text: r.text, href: r.href, shown: true, inGrid: true })) : [],
      noRecords: v.searched && v.results.length === 0,
    };
  };

  const endAnswer = () => {
    const answer = o.answer || "success";
    if (o.answerWindow) {
      // the press opens the answer in a window of its own; the payment page stays as it was
      w.windows.push("w2");
      w.page2 = "success";
    } else if (answer === "success" || answer === "conflict" || answer === "numberMismatch") w.page = "success";
    else if (answer === "successNoLink") w.page = "success-no-link";
    else if (answer === "login") w.page = "login";
    else if (answer === "refused") {
      w.refused = true;
      w.dialog = o.refusalWords || "Insufficient CDT balance";
    }
    // "none": nothing ever changes
  };

  const addPdf = (name, html = false) => folder.add(name, html ? Buffer.from("<!DOCTYPE html><html><body>expired</body></html>") : PDF);

  const submitButton = {
    async click() {
      log("submit-click");
      w.submitClicks += 1;
      if (o.alertOnSubmit) {
        w.alertText = "";
        // the alert is dismissed by ChromeDriver, the command fails with its text
        w.folder.at(o.resultDelayMs ?? 3000, endAnswer);
        throw alertError(o.alertOnSubmit);
      }
      if (o.submitClickError === "intercepted") {
        throw named("ElementClickInterceptedError", "element click intercepted: Element <input> is not clickable at point (10, 10)");
      }
      folder.at(o.resultDelayMs ?? 3000, endAnswer);
      if (o.submitClickError === "timeout") throw named("TimeoutError", "timeout: Timed out receiving message from renderer: 300.000");
    },
  };
  w.submitButton = submitButton;

  const scheduleLink = {
    async getAttribute(name) {
      return name === "href" ? `${BASE}/Motor/GenerateMotorSchedule?policyNo=${numberOnPage}` : null;
    },
    async click() {
      log("link-click");
      w.linkAt = folder.clock;
      w.scheduleClicks += 1;
      if (o.linkOpensHtml) folder.at(1500, () => addPdf("GenerateMotorSchedule.pdf", true));
      else if (o.linkDownloads !== false) folder.at(1500, () => addPdf("GenerateMotorSchedule.pdf"));
      else setCur("schedule"); // the live portal: the tab is taken to the schedule page, nothing is downloaded
    },
    async isDisplayed() {
      return true;
    },
  };

  const menu = {
    async isDisplayed() {
      return true;
    },
  };
  const viewPolicyItem = {
    async isDisplayed() {
      return true;
    },
    async click() {
      log("view-policy-click");
      w.view.open = true;
      setCur("view");
    },
  };
  const listItem = (text) => ({
    async isDisplayed() {
      return w.view.listOpen;
    },
    async click() {
      log(`list-click:${text}`);
      if (o.listClickIgnored) return;
      w.view.option = text;
      w.view.listOpen = false;
    },
  });
  const dropdownWrap = {
    async click() {
      log("dropdown-open");
      w.view.listOpen = true;
    },
  };
  const searchBox = {
    async clear() {
      w.view.box = "";
    },
    async sendKeys(text) {
      w.typed.push(text);
      if (o.typingIgnored) return;
      w.view.box += String(text);
    },
    get value() {
      return w.view.box;
    },
  };
  const runSearch = () => {
    w.view.searched = true;
    const own = { text: NUMBER, href: `/Policy/GenerateSheduleEncrption?policyNumber=ENC${NUMBER}` };
    w.view.results = o.results || [own];
  };
  const searchButton = {
    async click() {
      log("search-click");
      w.searchClicks += 1;
      if (o.searchClickIgnored) return;
      runSearch();
    },
  };
  const resultLink = (i) => ({
    async click() {
      const row = w.view.results[i];
      log(`result-click:${row.text}`);
      w.resultClicks.push(row.text);
      if (row.text === NUMBER && o.viewDownloads !== false) folder.at(1500, () => addPdf("Policy_" + NUMBER + ".pdf"));
    },
  });

  const elementByToken = (t) => {
    if (t === "dd-0") return dropdownWrap;
    if (t === "in-3") return searchBox;
    if (t === "bt-5") return searchButton;
    const m = /^lk-(\d+)$/.exec(t);
    return m ? resultLink(Number(m[1])) : null;
  };

  const driver = {
    async executeScript(fn, ...args) {
      if (fn === issue.readIssuePageInPage) {
        w.issueReads = (w.issueReads || 0) + 1;
        if (o.failReadsFrom && w.issueReads >= o.failReadsFrom) throw new Error("javascript error: document unloaded while waiting for result");
        return clone(w.issuePage());
      }
      if (fn === issue.readViewPolicyInPage) return clone(w.viewPage());
      if (fn === issue.findViewPolicyHrefInPage) {
        return o.noMenuHref ? "" : o.menuHref || `${BASE}/Policy/ViewPolicySearch`;
      }
      if (fn === issue.runPolicySearchInPage) {
        w.nudges += 1;
        log("search-nudge");
        if (cur() !== "view") return false;
        runSearch();
        return true;
      }
      if (fn === issue.selectKendoOptionInPage) {
        w.kendoCalls.push(args);
        w.view.option = args[1];
        w.view.listOpen = false;
        return { done: true, text: args[1] };
      }
      if (typeof fn === "string") {
        if (/arguments\[0\]\.click\(\)/.test(fn)) {
          w.scriptClicks += 1;
          log("script-click");
          if (args[0] && args[0] === submitButton) {
            log("submit-click");
            w.submitClicks += 1;
            folder.at(o.resultDelayMs ?? 3000, endAnswer);
          }
          return null;
        }
        if (/String\(arguments\[0\]\.value/.test(fn)) return String(args[0].value);
        return null;
      }
      throw new Error(`fake portal: unexpected script ${String(fn).slice(0, 60)}`);
    },
    async findElement(locator) {
      const value = String(locator.value);
      if (/id="btnPaymentSubmit"/.test(value)) {
        if (o.submitMissing || cur() !== "pay") throw named("NoSuchElementError", "no such element: btnPaymentSubmit");
        return submitButton;
      }
      const token = /data-rwi="([^"]+)"/.exec(value);
      if (token) {
        const el = elementByToken(token[1]);
        if (!el) throw named("NoSuchElementError", `no such element ${token[1]}`);
        return el;
      }
      throw new Error(`fake portal: unexpected findElement ${value}`);
    },
    async findElements(locator) {
      const value = String(locator.value);
      if (/GenerateMotorSchedule/.test(value)) return cur() === "success" ? [scheduleLink] : [];
      if (/id="divMainUtility"/.test(value)) return o.noMenu ? [] : [menu];
      if (/View Policy/.test(value)) return w.hovered && !o.menuItemMissing ? [viewPolicyItem] : [];
      const m = /normalize-space\(\.\)='([^']+)'/.exec(value);
      if (m) return [listItem(m[1])];
      throw new Error(`fake portal: unexpected findElements ${value}`);
    },
    actions() {
      return {
        move: () => ({
          perform: async () => {
            w.hovers += 1;
            w.hovered = true;
            log("hover-utilities");
          },
        }),
      };
    },
    async get(url) {
      w.gets.push(url);
      log(`get:${url}`);
      w.getAt = folder.clock;
      if (/\/Policy\/ViewPolicySearch/i.test(url)) {
        if (o.viewAddressFails) setCur("login");
        else {
          w.view.open = true;
          setCur("view");
        }
      } else {
        setCur("other");
      }
    },
    async getCurrentUrl() {
      return urlOf(cur());
    },
    switchTo() {
      return {
        alert: async () => {
          if (!w.alertText) throw named("NoSuchAlertError", "no such alert");
          return {
            getText: async () => w.alertText,
            accept: async () => {
              w.alertText = "";
            },
          };
        },
        window: async (handle) => {
          w.current = handle;
        },
      };
    },
    async getWindowHandle() {
      return w.current;
    },
    async getAllWindowHandles() {
      return [...w.windows]; // a fresh array each time, like the real driver
    },
    async close() {
      w.windows = w.windows.filter((h) => h !== w.current);
    },
    async sleep(ms) {
      await folder.sleep(ms);
    },
  };
  w.driver = driver;

  // the shared deps
  w.sleep = (ms) => folder.sleep(ms);
  w.now = () => folder.clock;
  return w;
}

/** Everything payWithCdtAndIssue needs, with the CDT step stubbed (it is tested in relianceWalletCdt.test.js). */
function setup(world, o = {}) {
  const seed = o.seed || seedPolicy();
  const mongo = makeMongo(seed, { order: world.order, ...(o.mongo || {}) });
  const uploads = [];
  const stub = async (driver, opts) => {
    world.log("cdt-step");
    world.cdtOpts = opts;
    if (o.cdtResult) return o.cdtResult;
    return {
      ok: true,
      paise: PAISE,
      amount: "6,268.00",
      rowsBefore: 40,
      rowsAfter: 41,
      rowTextsBefore: world.rowsBefore,
      rowTextsAfter: [...world.rowsBefore, "CDT 6,268.00 14-10-2026 Delete"],
      dialogs: [],
      dialogButtons: [],
      options: [],
      via: "typed",
      url: "https://smartzone.reliancegeneral.co.in/Payment/Payments",
      message: "The CDT payment of 6,268.00 ... is entered and added ... It is not submitted and nothing was paid — waiting for the next step.",
    };
  };
  const args = {
    driver: world.driver,
    data: { _id: DOC_ID, policyId: OP_ID, username: "TNAGAR2W", _jobId: "job-1", _attemptNumber: 1, ...(o.data || {}) },
    jobId: "Test_1",
    proposalNumber: PROPOSAL,
    selectionVerified: true,
    checkpoint: (name) => {
      world.log(`checkpoint:${name}`);
      world.checkpoints.push(name);
      if (o.checkpoint) o.checkpoint(name);
    },
    log: () => {},
    shot: async (label) => {
      world.log(`shot:${label}`);
      world.shots.push(label);
      return { url: `https://s3/${label}.png`, key: `screenshots/wallet/${label}.png` };
    },
    downloadDir: DIR,
    uploadPolicyPdf:
      o.uploadPolicyPdf ||
      (async (filePath, { key, fileName }) => {
        world.log("upload");
        uploads.push({ filePath, key, fileName, bytes: world.folder.files.get(filePath).buf.length });
        return { key, location: `https://bucket.s3.ap-south-1.amazonaws.com/${key}` };
      }),
    deps: {
      MongoClient: mongo.Client,
      fsImpl: world.folder.fsImpl,
      now: world.now,
      sleep: world.sleep,
      ...(o.deps || {}),
    },
  };
  return { args, mongo, uploads, stub };
}

/** Run the flow with the CDT step stubbed; resolves {result} or {error}. */
async function runFlow(world, o = {}) {
  const s = setup(world, o);
  const original = cdtModule.payWithCdt;
  cdtModule.payWithCdt = s.stub;
  try {
    const result = await quiet(() => issue.payWithCdtAndIssue(s.args));
    return { result, ...s };
  } catch (error) {
    return { error, ...s };
  } finally {
    cdtModule.payWithCdt = original;
  }
}

const indexOf = (order, needle, from = 0) => {
  const i = order.findIndex((s, idx) => idx >= from && s === needle);
  return i;
};

/* -------------------------------------------------------------------------- */
/* The happy paths                                                            */
/* -------------------------------------------------------------------------- */

test("issued, PDF by the policy number link: the note BEFORE the press, the press once, the number BEFORE the PDF, the file stored and set", async () => {
  const w = makeWorld();
  const r = await runFlow(w);
  assert.ok(!r.error, r.error && r.error.message);
  const res = r.result;
  assert.equal(res.ok, true);
  assert.equal(res.policyNumber, NUMBER);
  assert.equal(res.transactionNo, "TXN9981");
  assert.equal(res.pdf.via, "link");
  assert.deepEqual(res.warnings, []);

  // exactly one press; the link clicked; View Policy never opened
  assert.equal(w.submitClicks, 1);
  assert.equal(w.scheduleClicks, 1);
  assert.equal(w.hovers, 0);

  // the ORDER of things: cdt step -> row check/shot -> checkpoint -> note -> press -> outcome -> number -> link -> upload -> file
  const o = w.order;
  const idx = {
    cdt: indexOf(o, "cdt-step"),
    shot: indexOf(o, "shot:cdt-added"),
    checkpoint: indexOf(o, "checkpoint:wallet-cdt-submit"),
    note: o.findIndex((s) => s === "db:onlinePolicy:walletPayment"),
    press: indexOf(o, "submit-click"),
    issued: o.findIndex((s) => s.startsWith("db:onlinePolicy:walletPayment.state")),
    numberOnline: o.findIndex((s) => s === "db:onlinePolicy:policyNumber"),
    numberPolicy: o.findIndex((s) => s === "db:policy:policyNumber"),
    link: indexOf(o, "link-click"),
    upload: indexOf(o, "upload"),
    file: o.findIndex((s) => s === "db:policy:policyFile"),
  };
  for (const [k, v] of Object.entries(idx)) assert.ok(v >= 0, `${k} happened: ${o.join(" > ")}`);
  assert.ok(idx.cdt < idx.shot && idx.shot < idx.checkpoint, "the CDT row, the picture, then the last look");
  assert.ok(idx.checkpoint < idx.note, "the Breaker's last look comes before the note");
  assert.ok(idx.note < idx.press, "THE NOTE IS WRITTEN BEFORE SUBMIT DETAILS IS PRESSED");
  assert.ok(idx.press < idx.issued, "the outcome is recorded after the press");
  assert.ok(idx.issued < idx.numberOnline && idx.numberOnline < idx.numberPolicy, "the number goes on the online policy, then the policy record");
  assert.ok(idx.numberPolicy < idx.link, "THE NUMBER IS SAVED BEFORE THE PDF IS TOUCHED");
  assert.ok(idx.link < idx.upload && idx.upload < idx.file, "the PDF is stored, then set as the policyFile");

  // what was written
  const op = r.mongo.data.onlinePolicy[0];
  assert.equal(op.walletPayment.state, "issued");
  assert.equal(op.walletPayment.policyNumber, NUMBER);
  assert.equal(op.walletPayment.transactionNo, "TXN9981");
  assert.equal(op.walletPayment.amountPaise, PAISE);
  assert.equal(op.walletPayment.proposalNumber, PROPOSAL);
  assert.equal(op.walletPayment.jobId, "job-1");
  assert.equal(op.policyNumber, NUMBER);
  const pol = r.mongo.data.policy.find((p) => p._id === "pol1");
  assert.equal(pol.policyNumber, NUMBER);
  assert.equal(r.uploads.length, 1);
  assert.match(r.uploads[0].key, /^Policy\/\d{6,8}-[A-Z0-9]{9}-Policy\.pdf$/);
  assert.equal(r.uploads[0].bytes, PDF.length);
  assert.deepEqual(pol.policyFile, {
    fileName: r.uploads[0].fileName,
    key: r.uploads[0].key,
    location: `https://bucket.s3.ap-south-1.amazonaws.com/${r.uploads[0].key}`,
  });
  assert.deepEqual(op.mergedPolicyPdf, pol.policyFile, "the View page's file is set when it was empty");
  assert.equal(r.mongo.data.policy.find((p) => p._id === "pol2").policyNumber, "OP999", "another client's record is untouched");
  assert.deepEqual(w.shots, ["cdt-added", "issued"]);
});

test("the link opens a page, not a PDF: View Policy is opened by the menu link's ADDRESS, the option chosen and read back, the number's OWN row clicked (not the first)", async () => {
  const other = { text: "120122623750229999", href: "/Policy/GenerateSheduleEncrption?policyNumber=ENC9999" };
  const own = { text: NUMBER, href: `/Policy/GenerateSheduleEncrption?policyNumber=ENC${NUMBER}` };
  const w = makeWorld({ linkDownloads: false, results: [other, own], menuHref: "https://smartzone.reliancegeneral.co.in/Policy/ViewPolicySearch?menu=1" });
  const r = await runFlow(w);
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.result.pdf.via, "view-policy");
  assert.equal(w.scheduleClicks, 1, "the link was tried first");
  assert.equal(w.hovers, 0, "no menu hover was needed");
  assert.deepEqual(w.gets, ["https://smartzone.reliancegeneral.co.in/Policy/ViewPolicySearch?menu=1"], "the menu link's own address, once");
  assert.deepEqual(w.resultClicks, [NUMBER], "ONLY the row whose text is the policy number was clicked, though it was not the first");
  assert.deepEqual(w.typed, [NUMBER]);
  assert.equal(w.view.option, "Policy Number");
  assert.equal(w.submitClicks, 1, "Submit Details was NOT pressed again for the second way");
  const o = w.order;
  const open = indexOf(o, "dropdown-open");
  const pick = indexOf(o, "list-click:Policy Number");
  const search = indexOf(o, "search-click");
  const result = indexOf(o, `result-click:${NUMBER}`);
  assert.ok(open > 0 && open < pick && pick < search && search < result, o.join(" > "));
  assert.ok(indexOf(o, "link-click") < o.findIndex((x) => x.startsWith("get:")));
  // the schedule link is only a short wait — on the live portal it opens a page and downloads nothing
  assert.ok(w.getAt - w.linkAt <= 25000, `View Policy was opened ${w.getAt - w.linkAt} ms after the link click`);
  // saved as before
  assert.equal(r.mongo.data.policy.find((p) => p._id === "pol1").policyFile.key, r.uploads[0].key);
});

test("View Policy by address: the page has no menu link — the known address is used; a lost session falls to the menu hover; all three failing is one error naming each", async () => {
  // no "View Policy" link on the page at all (the schedule page): the address the KYC step reaches
  const known = makeWorld({ linkDownloads: false, noMenuHref: true });
  const a = await runFlow(known);
  assert.ok(!a.error, a.error && a.error.message);
  assert.deepEqual(known.gets, ["https://smartzone.reliancegeneral.co.in/Policy/ViewPolicySearch"]);
  assert.equal(known.hovers, 0);

  // the address lands on the login page (a lost session or a token the address does not carry): the menu is the last way
  const menu = makeWorld({ linkDownloads: false, viewAddressFails: true });
  const b = await runFlow(menu, { deps: { timing: { searchPageWaitMs: 2000 } } });
  assert.ok(!b.error, b.error && b.error.message);
  assert.equal(b.result.pdf.via, "view-policy");
  assert.equal(menu.hovers, 1, "the menu hover ran only after the addresses did not work");
  assert.equal(menu.gets.length, 1, "the link address and the known address are the same address here, tried once");

  // nothing works: one error that says what each way did
  const none = makeWorld({ linkDownloads: false, viewAddressFails: true, menuItemMissing: true, noMenuHref: true });
  const c = await runFlow(none, { deps: { timing: { searchPageWaitMs: 1500, menuWaitMs: 1500 } } });
  assert.equal(c.error.code, "PDF_MISSING");
  assert.match(c.error.message, /View Policy could not be opened — the View Policy address did not show the search page \(Reliance's login page came up\); then the View Policy item was not found under Utilities/);
  assert.equal(c.uploads.length, 0);
  assert.equal(c.mongo.data.onlinePolicy[0].policyNumber, NUMBER, "the number stays saved");
});

test("View Policy: a Search click that does nothing is helped once by the page's own search function — and only once", async () => {
  const w = makeWorld({ linkDownloads: false, searchClickIgnored: true });
  const r = await runFlow(w);
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(w.nudges, 1);
  assert.equal(w.searchClicks, 1);
  assert.deepEqual(w.resultClicks, [NUMBER]);

  // a search that finds nothing is nudged once, then reported
  const empty = makeWorld({ linkDownloads: false, results: [] });
  const e = await runFlow(empty, { deps: { timing: { searchResultWaitMs: 3000 } } });
  assert.equal(e.error.code, "PDF_MISSING");
  assert.match(e.error.message, /did not list that policy number \(Reliance said no records were found\)/);
  assert.equal(empty.nudges, 1);
});

test("View Policy: the search option already says Policy Number — no list is opened; a list click that does nothing falls back to the Kendo API", async () => {
  const already = makeWorld({ linkDownloads: false, searchDefault: "Policy Number" });
  const a = await runFlow(already);
  assert.ok(!a.error, a.error && a.error.message);
  assert.equal(indexOf(already.order, "dropdown-open"), -1);
  assert.equal(a.result.pdf.via, "view-policy");

  const ignored = makeWorld({ linkDownloads: false, listClickIgnored: true });
  const b = await runFlow(ignored);
  assert.ok(!b.error, b.error && b.error.message);
  assert.equal(ignored.kendoCalls.length, 1);
  assert.deepEqual(ignored.kendoCalls[0], ["ddlSearchBy_listbox", "Policy Number"]);
});

test("a click error that says the click may have happened is never repeated; one refused before it happened is retried by script, once", async () => {
  // the renderer timed out receiving the answer: the click happened (the page is loading)
  const slow = makeWorld({ submitClickError: "timeout" });
  const a = await runFlow(slow);
  assert.ok(!a.error, a.error && a.error.message);
  assert.equal(slow.submitClicks, 1);
  assert.equal(slow.scriptClicks, 0, "no second press by script");

  // the click was intercepted before it happened: the script click presses it, once
  const blocked = makeWorld({ submitClickError: "intercepted" });
  const b = await runFlow(blocked);
  assert.ok(!b.error, b.error && b.error.message);
  assert.equal(blocked.submitClicks, 2, "one refused real click + the one script click that pressed it");
  assert.equal(blocked.scriptClicks, 1);
  assert.equal(b.result.ok, true);

  // an alert raised by the click counts as pressed
  const alerted = makeWorld({ alertOnSubmit: "Are you sure you want to submit?", answer: "success" });
  const c = await runFlow(alerted);
  assert.ok(!c.error, c.error && c.error.message);
  assert.equal(alerted.submitClicks, 1);
});

/* -------------------------------------------------------------------------- */
/* What it refuses BEFORE the press                                           */
/* -------------------------------------------------------------------------- */

const pressedNothing = (r, w) => {
  assert.equal(w.submitClicks, 0, "Submit Details was not pressed");
  assert.ok(!w.order.includes("submit-click"));
  assert.deepEqual(
    r.mongo.writes.filter((x) => x.matched),
    [],
    "nothing was written on any record"
  );
};

test("the CDT step failing ends the run before anything else (its own message, kept)", async () => {
  const w = makeWorld();
  const r = await runFlow(w, { cdtResult: { ok: false, code: "NO_CDT", message: "This Reliance login does not have the CDT payment option, so nothing was paid." } });
  assert.equal(r.error.code, "NO_CDT");
  assert.equal(r.error.keepMessage, true);
  assert.equal(r.error.portalRejected, true);
  assert.match(r.error.message, /does not have the CDT payment option/);
  pressedNothing(r, w);
});

test("no new row of the amount in the payment details: refused, the rows that did appear are named, nothing pressed or written", async () => {
  const w = makeWorld({ rowsAdded: ["CDT 6,268.01 14-10-2026 Delete"] });
  const r = await runFlow(w, { deps: { timing: { rowWaitMs: 2000 } } });
  assert.equal(r.error.code, "ROW_MISSING");
  assert.match(r.error.message, /does not show a row of 6,268\.00, so Submit Details was not pressed/);
  assert.match(r.error.message, /The rows that appeared are "CDT 6,268\.01 14-10-2026 Delete"/);
  assert.match(r.error.message, /Nothing was submitted or paid\./);
  pressedNothing(r, w);
  assert.equal(r.mongo.writes.length, 0);

  const none = makeWorld({ rowsAdded: [] });
  const n = await runFlow(none, { deps: { timing: { rowWaitMs: 2000 } } });
  assert.equal(n.error.code, "ROW_MISSING");
  assert.match(n.error.message, /No new row appeared/);
});

test("the same row twice (Add pressed twice): refused", async () => {
  const w = makeWorld({ rowsAdded: ["CDT 6,268.00 14-10-2026 Delete", "CDT 6,268.00 14-10-2026 Delete"] });
  const r = await runFlow(w);
  assert.equal(r.error.code, "ROW_DUPLICATED");
  assert.match(r.error.message, /more than once/);
  pressedNothing(r, w);
});

test("Submit Details missing, hidden or disabled: refused with the reason", async () => {
  for (const [opts, why] of [
    [{ submitMissing: true }, "it is not on the page"],
    [{ submitDisabled: true }, "it is disabled"],
  ]) {
    const w = makeWorld(opts);
    const r = await runFlow(w);
    assert.equal(r.error.code, "SUBMIT_MISSING", JSON.stringify(opts));
    assert.ok(r.error.message.includes(why), r.error.message);
    pressedNothing(r, w);
  }
});

test("the Submit button is judged on the LAST look before the press: disabled after the row was seen = not pressed", async () => {
  const w = makeWorld({ submitDisabledFromRead: 2 });
  const r = await runFlow(w);
  assert.equal(r.error.code, "SUBMIT_MISSING");
  assert.match(r.error.message, /\(it is disabled\)/);
  pressedNothing(r, w);
});

test("a message of Reliance's open on the payment page: read, never clicked away, nothing pressed — but a harmless one that closes is waited out", async () => {
  const w = makeWorld({ dialog: "Please select the payment mode" });
  const r = await runFlow(w);
  assert.equal(r.error.code, "DIALOG_OPEN");
  assert.match(r.error.message, /Reliance shows "Please select the payment mode" with the buttons "Ok" on the payment page/);
  assert.match(r.error.message, /Submit Details was not pressed\. Nothing was submitted or paid\./);
  pressedNothing(r, w);
  assert.equal(r.error.portalText, "Please select the payment mode");

  const closes = makeWorld({ dialog: "Payment details added", dialogCloses: true });
  closes.folder.at(1500, () => {
    closes.dialog = "";
  });
  const c = await runFlow(closes);
  assert.ok(!c.error, c.error && c.error.message);
  assert.equal(closes.submitClicks, 1);
});

test("a message of Reliance's stays open and the page cannot be re-read: still the dialog error, not a crash", async () => {
  // reads 1 (the row) + 9 (the dialog wait) succeed; the 11th, taken to quote the dialog, fails
  const w = makeWorld({ dialog: "Please select the payment mode", failReadsFrom: 11 });
  const r = await runFlow(w);
  assert.equal(r.error.code, "DIALOG_OPEN");
  assert.match(r.error.message, /Reliance shows "Please select the payment mode"/);
  assert.equal(w.submitClicks, 0);
});

test("the note cannot be written: Submit Details is NOT pressed", async () => {
  const w = makeWorld();
  const r = await runFlow(w, { mongo: { connectError: "ECONNREFUSED 127.0.0.1:27017" } });
  assert.equal(r.error.code, "NOTE_NOT_SAVED");
  assert.match(r.error.message, /could not be saved on the policy \(ECONNREFUSED 127\.0\.0\.1 - 27017\), so Submit Details was not pressed/);
  pressedNothing(r, w);

  const unmatched = makeWorld();
  const u = await runFlow(unmatched, { data: { _id: "no-such-policy" } });
  assert.equal(u.error.code, "NOTE_NOT_SAVED");
  assert.match(u.error.message, /the policy was not found/);
  pressedNothing(u, unmatched);

  const noId = makeWorld();
  const n = await runFlow(noId, { data: { _id: undefined, policyId: undefined } });
  assert.equal(n.error.code, "NO_POLICY_ID");
  pressedNothing(n, noId);
});

test("a payment already submitted (another run won the note): Submit Details is NOT pressed, the message says what was recorded", async () => {
  for (const state of ["submit-pressed", "issued", "unconfirmed"]) {
    const w = makeWorld();
    const seed = seedPolicy({
      onlinePolicy: { walletPayment: { state, proposalNumber: PROPOSAL, amountPaise: PAISE, at: new Date(2026, 9, 14, 14, 5), policyNumber: NUMBER } },
    });
    const r = await runFlow(w, { seed });
    assert.equal(r.error.code, "ALREADY_SUBMITTED", state);
    assert.match(r.error.message, /already submitted for this policy at Reliance/);
    assert.ok(r.error.message.includes(`state ${state}`));
    pressedNothing(r, w);
    assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.state, state, "the existing note is untouched");
  }
});

test("the Breaker's last look stops the run before the note and the press", async () => {
  const w = makeWorld();
  const stop = new AutomationStoppedError("stopped at Reliance/wallet-cdt-submit", { stage: "breaker" });
  const r = await runFlow(w, {
    checkpoint: (name) => {
      if (name === "wallet-cdt-submit") throw stop;
    },
  });
  assert.equal(r.error, stop, "the stop travels up untouched");
  pressedNothing(r, w);
  assert.equal(r.mongo.writes.length, 0);
});

/* -------------------------------------------------------------------------- */
/* After the press                                                            */
/* -------------------------------------------------------------------------- */

test("a refusal that stays on the payment page: state failed (re-run allowed), Submit Details pressed once, the words quoted", async () => {
  const w = makeWorld({ answer: "refused", refusalWords: "Insufficient CDT balance" });
  const r = await runFlow(w);
  assert.equal(r.error.code, "SUBMIT_REFUSED");
  assert.match(r.error.message, /Reliance refused the CDT payment of 6,268\.00 for proposal R141026125974 when Submit Details was pressed — it said "Insufficient CDT balance"/);
  assert.match(r.error.message, /The payment page is still showing and no policy number appeared, so this run is marked refused and the policy can be run again\./);
  assert.equal(r.error.portalText, "Insufficient CDT balance");
  assert.equal(w.submitClicks, 1);
  assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.state, "failed");
  assert.equal(r.mongo.data.onlinePolicy[0].policyNumber, undefined, "no number was saved");
  assert.equal(r.uploads.length, 0);
  // and the gate lets it through again
  const gate = await quiet(() => issue.checkSubmitGate({ _id: DOC_ID }, "J", { MongoClient: r.mongo.Client }));
  assert.equal(gate.blocked, false);
});

test("a refusal that is only seen while the page still moves on to success is NOT a failure", async () => {
  // an alert at once, then the success page arrives 3 s later (inside the grace period)
  const w = makeWorld({ alertOnSubmit: "Payment failed, retrying with the bank", answer: "success", resultDelayMs: 3000 });
  const r = await runFlow(w);
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.result.policyNumber, NUMBER);
});

test("no answer at all: unconfirmed — it blocks re-runs like an issued policy and says the payment may have gone through", async () => {
  const w = makeWorld({ answer: "none" });
  const r = await runFlow(w);
  assert.equal(r.error.code, "SUBMIT_UNCONFIRMED");
  assert.match(r.error.message, /Reliance's answer could not be confirmed \(no Payment Success page appeared within 120 seconds\)/);
  assert.match(r.error.message, /The payment may have gone through\. Check the policy at Reliance before running this policy again/);
  assert.equal(w.submitClicks, 1);
  assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.state, "unconfirmed");
  const gate = await quiet(() => issue.checkSubmitGate({ _id: DOC_ID }, "J", { MongoClient: r.mongo.Client }));
  assert.equal(gate.blocked, true);
  assert.equal(r.uploads.length, 0);
});

test("an alert shown while Submit Details was pressed (a confirm the dismissal cancelled) is in the operator's message", async () => {
  const w = makeWorld({ alertOnSubmit: "Are you sure you want to submit the payment?", answer: "none" });
  const r = await runFlow(w);
  assert.equal(r.error.code, "SUBMIT_UNCONFIRMED");
  assert.match(r.error.message, /Reliance showed "Are you sure you want to submit the payment\?" while it was pressed\./);
  assert.equal(r.error.portalText, "Are you sure you want to submit the payment?");
  assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.words, "Are you sure you want to submit the payment?");
  assert.equal(w.submitClicks, 1, "pressed once, not again to answer the confirm");
});

test("the answer opens in a new window: that window is read, and the PDF steps run from it", async () => {
  const w = makeWorld({ answerWindow: true });
  const r = await runFlow(w);
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.result.policyNumber, NUMBER);
  assert.equal(w.current, "w2", "the run stays on the window that holds the answer (the PDF steps ran from it)");
  assert.equal(w.scheduleClicks, 1);
  assert.equal(w.submitClicks, 1);
  assert.equal(r.uploads.length, 1);
});

test("success words but no policy number link; two different numbers; the login page — all unconfirmed, nothing saved on a doubt", async () => {
  const cases = [
    [{ answer: "successNoLink" }, /the page says the payment was successful but the policy number link never appeared/],
    [{ answer: "numberMismatch" }, /the page's text names policy 120122623750229999 but its link names 120122623750221335/],
    [{ answer: "login" }, /Reliance went back to its login page/],
    [{ answer: "success", numberOnPage: "ABC" }, /does not look like a policy number/],
  ];
  for (const [opts, pattern] of cases) {
    const w = makeWorld(opts);
    const r = await runFlow(w);
    assert.equal(r.error.code, "SUBMIT_UNCONFIRMED", JSON.stringify(opts));
    assert.match(r.error.message, pattern, JSON.stringify(opts));
    assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.state, "unconfirmed");
    assert.equal(r.mongo.data.onlinePolicy[0].policyNumber, undefined);
    assert.equal(w.submitClicks, 1);
    assert.equal(r.uploads.length, 0);
  }
});

/* -------------------------------------------------------------------------- */
/* The PDF                                                                    */
/* -------------------------------------------------------------------------- */

test("the PDF comes neither by the link nor by View Policy: an ERROR, the policy is issued and its number is saved", async () => {
  const w = makeWorld({ linkDownloads: false, viewDownloads: false });
  const r = await runFlow(w);
  assert.equal(r.error.code, "PDF_MISSING");
  assert.match(r.error.message, /^Policy 120122623750221335 was issued at Reliance for proposal R141026125974 and its number is saved on the policy, but its PDF could not be downloaded/);
  assert.match(r.error.message, /clicking the policy number did not download a PDF \(no PDF arrived in the download folder\)/);
  assert.match(r.error.message, /the policy number's link in the results did not download a PDF/);
  assert.match(r.error.message, /Download it from Reliance's View Policy page and upload it on the policy by hand\./);
  assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.state, "issued");
  assert.equal(r.mongo.data.onlinePolicy[0].policyNumber, NUMBER);
  assert.equal(r.mongo.data.policy.find((p) => p._id === "pol1").policyNumber, NUMBER);
  assert.deepEqual(r.mongo.data.policy.find((p) => p._id === "pol1").policyFile, {});
  assert.equal(r.uploads.length, 0);
  assert.equal(w.submitClicks, 1);
});

test("the link gives an HTML page named .pdf: not accepted, View Policy is tried, its real PDF is what is stored", async () => {
  const w = makeWorld({ linkOpensHtml: true });
  const r = await runFlow(w);
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.result.pdf.via, "view-policy");
  assert.equal(r.uploads.length, 1);
  assert.equal(r.uploads[0].bytes, PDF.length);
});

test("View Policy: the search lists other policies only — the number's link is not there, so nothing else is clicked", async () => {
  const w = makeWorld({
    linkDownloads: false,
    results: [{ text: "120122623750229999", href: "/Policy/GenerateSheduleEncrption?policyNumber=ENC9999" }],
  });
  const r = await runFlow(w, { deps: { timing: { searchResultWaitMs: 3000 } } });
  assert.equal(r.error.code, "PDF_MISSING");
  assert.match(r.error.message, /did not list that policy number \(the results show "120122623750229999"\)/);
  assert.deepEqual(w.resultClicks, [], "another customer's policy link was not clicked");
});

test("View Policy: a search box that does not hold the typed number stops before Search is pressed", async () => {
  const w = makeWorld({ linkDownloads: false, typingIgnored: true });
  const r = await runFlow(w);
  assert.equal(r.error.code, "PDF_MISSING");
  assert.match(r.error.message, /the search box reads "" after the policy number was typed/);
  assert.equal(w.searchClicks, 0, "Search was not pressed with the wrong text in the box");
  assert.deepEqual(w.resultClicks, []);
});

test("the PDF cannot be stored: an error, the downloaded file and the policy number are not lost", async () => {
  const w = makeWorld();
  const r = await runFlow(w, {
    uploadPolicyPdf: async () => {
      throw new Error("The security token included in the request is expired");
    },
  });
  assert.equal(r.error.code, "PDF_NOT_STORED");
  assert.match(r.error.message, /was issued at Reliance for proposal R141026125974 and its PDF was downloaded, but it could not be stored \(The security token included in the request is expired\)/);
  assert.equal(r.mongo.data.onlinePolicy[0].policyNumber, NUMBER);
  assert.ok(w.folder.files.size === 1, "the downloaded file is still in the job folder");
});

test("problems saving on the policy records are warnings: the run completes, the warning names each problem", async () => {
  // no policy record for this online policy
  const w = makeWorld();
  const seed = seedPolicy({ policy: [{ _id: "x", isOnlinePolicy: true, clientId: "client9", policyNumber: OP_ID }] });
  const r = await runFlow(w, { seed });
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.result.ok, true);
  assert.match(r.result.warning, /^Policy 120122623750221335 was issued and its PDF is stored, but /);
  assert.match(r.result.warning, /no policy record of this online policy was found/);
  assert.match(r.result.warning, /could not be set as the policyFile because the policy record was not found/);
  assert.equal(r.result.saved.pdf.onlinePolicy, "saved", "the View page's file is still set");
  assert.equal(r.uploads.length, 1);

  // a warning has no colon either
  assert.ok(!r.result.warning.includes(":"), r.result.warning);
});

/* -------------------------------------------------------------------------- */
/* A policy that was already issued: only its PDF is left                      */
/* -------------------------------------------------------------------------- */

const issuedSeed = (extra = {}) =>
  seedPolicy({
    onlinePolicy: {
      walletPayment: { state: "issued", proposalNumber: PROPOSAL, amountPaise: PAISE, at: new Date(2026, 9, 14, 17, 26), policyNumber: NUMBER },
      ...(extra.onlinePolicy || {}),
    },
    ...(extra.policy ? { policy: extra.policy } : {}),
  });

/** Run the recovery step against the fake portal (the browser is on the portal's home page after login). */
async function runRecovery(world, o = {}) {
  world.page = "home";
  const seed = o.seed || issuedSeed();
  const mongo = makeMongo(seed, { order: world.order, ...(o.mongo || {}) });
  const uploads = [];
  const args = {
    driver: world.driver,
    data: { _id: DOC_ID, policyId: OP_ID, _jobId: "job-2", ...(o.data || {}) },
    jobId: "Test_2",
    proposalNumber: PROPOSAL,
    policyNumber: o.policyNumber === undefined ? NUMBER : o.policyNumber,
    log: () => {},
    downloadDir: DIR,
    uploadPolicyPdf: async (filePath, { key, fileName }) => {
      world.log("upload");
      uploads.push({ filePath, key, fileName, bytes: world.folder.files.get(filePath).buf.length });
      return { key, location: `https://bucket.s3.ap-south-1.amazonaws.com/${key}` };
    },
    deps: { MongoClient: mongo.Client, fsImpl: world.folder.fsImpl, now: world.now, sleep: world.sleep, ...(o.deps || {}) },
  };
  try {
    const result = await quiet(() => issue.recoverIssuedPolicyPdf(args));
    return { result, mongo, uploads };
  } catch (error) {
    return { error, mongo, uploads };
  }
}

test("issuedNumberOf: only an `issued` gate with a plausible number is finished; every other state still refuses", async () => {
  const gateFor = (state, policyNumber) => ({ blocked: true, state, marker: { state, policyNumber } });
  assert.equal(issue.issuedNumberOf(gateFor("issued", NUMBER), PROPOSAL), NUMBER);
  assert.equal(issue.issuedNumberOf(gateFor("issued", "1201 2262 3750 221335"), PROPOSAL), "120122623750221335", "spaces are normalised");
  for (const state of ["submit-pressed", "unconfirmed", "failed"]) assert.equal(issue.issuedNumberOf(gateFor(state, NUMBER), PROPOSAL), "", state);
  for (const bad of [undefined, "", "OP1760400000000ABC", PROPOSAL, "Search"]) {
    assert.equal(issue.issuedNumberOf(gateFor("issued", bad), PROPOSAL), "", JSON.stringify(bad));
  }
  assert.equal(issue.issuedNumberOf({ blocked: false, state: "issued", marker: { policyNumber: NUMBER } }, PROPOSAL), "");
  assert.equal(issue.issuedNumberOf(null), "");
  // the switch
  const before = process.env.RELIANCE_WALLET_RECOVER_ENABLED;
  try {
    delete process.env.RELIANCE_WALLET_RECOVER_ENABLED;
    assert.equal(hold.isWalletRecoverEnabled(), true);
    for (const off of ["false", "0", "no", "off", " OFF "]) {
      process.env.RELIANCE_WALLET_RECOVER_ENABLED = off;
      assert.equal(hold.isWalletRecoverEnabled(), false, off);
    }
  } finally {
    if (before === undefined) delete process.env.RELIANCE_WALLET_RECOVER_ENABLED;
    else process.env.RELIANCE_WALLET_RECOVER_ENABLED = before;
  }
});

test("decideAfterGate: go / recover / refuse — every blocking state but a usable `issued` refuses, and the switch turns recovery off", () => {
  const blocked = (state, policyNumber) => ({ blocked: true, state, marker: { state, policyNumber }, message: `blocked ${state}` });
  assert.deepEqual(issue.decideAfterGate({ blocked: false }), { action: "go" });
  assert.deepEqual(issue.decideAfterGate(null), { action: "go" });
  assert.deepEqual(issue.decideAfterGate({ blocked: false, state: "failed" }), { action: "go" });

  const recover = issue.decideAfterGate(blocked("issued", NUMBER), { proposalNumber: PROPOSAL });
  assert.equal(recover.action, "recover");
  assert.equal(recover.number, NUMBER);
  assert.equal(recover.marker.state, "issued");

  for (const state of ["submit-pressed", "unconfirmed"]) {
    const d = issue.decideAfterGate(blocked(state, NUMBER), { proposalNumber: PROPOSAL });
    assert.deepEqual(d, { action: "refuse", message: `blocked ${state}` }, state);
  }
  // issued but nothing usable in the note: refused, never finished on a guess
  for (const bad of [undefined, "", "OP1760400000000ABC", PROPOSAL]) {
    assert.equal(issue.decideAfterGate(blocked("issued", bad), { proposalNumber: PROPOSAL }).action, "refuse", JSON.stringify(bad));
  }
  // recovery switched off: an issued policy is refused like the others
  assert.equal(issue.decideAfterGate(blocked("issued", NUMBER), { recoverEnabled: false, proposalNumber: PROPOSAL }).action, "refuse");
});

test("recovery: the PDF is fetched from View Policy by the number, stored and set on the policy — nothing is pressed, nothing is paid", async () => {
  const w = makeWorld({ linkDownloads: false });
  const r = await runRecovery(w);
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.result.ok, true);
  assert.equal(r.result.recovered, true);
  assert.equal(r.result.policyNumber, NUMBER);
  assert.equal(r.result.pdf.via, "view-policy");
  // nothing of the payment was touched: no Submit Details, no schedule link, no payment note written
  assert.equal(w.submitClicks, 0);
  assert.equal(w.scheduleClicks, 0);
  assert.ok(!w.order.includes("submit-click"));
  assert.deepEqual(w.typed, [NUMBER]);
  assert.deepEqual(w.resultClicks, [NUMBER]);
  // the number (again) and the file are on the policy
  const op = r.mongo.data.onlinePolicy[0];
  assert.equal(op.policyNumber, NUMBER);
  assert.equal(op.walletPayment.state, "issued", "the note is not moved back");
  assert.ok(op.walletPayment.pdfFetchedAt, "the note says when its PDF was fetched");
  const pol = r.mongo.data.policy.find((p) => p._id === "pol1");
  assert.equal(pol.policyNumber, NUMBER);
  assert.equal(r.uploads.length, 1);
  assert.match(r.uploads[0].key, /^Policy\/\d{6,8}-[A-Z0-9]{9}-Policy\.pdf$/);
  assert.equal(pol.policyFile.key, r.uploads[0].key);
  assert.deepEqual(r.result.warnings, []);
  // the note was never written as a NEW payment (no claim): the only writes are the number, the file and the pdf time
  const fields = r.mongo.writes.filter((x) => x.matched).map((x) => `${x.name}:${Object.keys(x.update.$set).filter((k) => k !== "updatedAt").join(",")}`);
  assert.ok(!fields.includes("onlinePolicy:walletPayment"), fields.join(" | "));
});

test("recovery: no PDF from View Policy and none stored yet is an ERROR that says nothing was paid again", async () => {
  const w = makeWorld({ linkDownloads: false, viewDownloads: false });
  const r = await runRecovery(w);
  assert.equal(r.error.code, "PDF_MISSING");
  assert.match(r.error.message, /^Policy 120122623750221335 was issued at Reliance earlier for proposal R141026125974 and its number is saved on the policy, but its PDF could not be downloaded/);
  assert.match(r.error.message, /Nothing was paid again\./);
  assert.equal(r.error.keepMessage, true);
  assert.equal(r.mongo.data.onlinePolicy[0].walletPayment.state, "issued");
  assert.equal(r.uploads.length, 0);
  assert.ok(!r.error.message.replace(/"[^"]*"/g, '""').includes(":"));
  assert.equal(beautifyError(r.error.message, "Reliance"), `[Reliance] ${r.error.message}`);
});

test("recovery: a policy that already has its PDF file is not given a second object", async () => {
  const had = { fileName: "old.pdf", key: "Policy/old.pdf", location: "https://b/old.pdf" };
  const seed = issuedSeed({ policy: [{ _id: "pol1", isOnlinePolicy: true, clientId: "client1", policyNumber: NUMBER, policyFile: had }] });

  // the PDF is fetched again (the merge step needs the file) but not stored again
  const w = makeWorld({ linkDownloads: false });
  const r = await runRecovery(w, { seed });
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.uploads.length, 0, "no second object in the bucket");
  assert.equal(r.result.file, null);
  assert.ok(r.result.pdf && r.result.pdf.path, "the downloaded file is there for the merge step");
  assert.deepEqual(r.mongo.data.policy[0].policyFile, had);

  // and when it cannot be fetched again the run goes on, with a warning
  const down = makeWorld({ linkDownloads: false, viewDownloads: false });
  const d = await runRecovery(down, { seed });
  assert.ok(!d.error, d.error && d.error.message);
  assert.equal(d.uploads.length, 0);
  assert.match(d.result.warning, /its PDF could not be fetched again .* but the policy already has its file/);
});

test("recovery: a note whose number is not a policy number is refused before anything is touched", async () => {
  for (const bad of ["", "OP1760400000000ABC", PROPOSAL, "abc"]) {
    const w = makeWorld({ linkDownloads: false });
    const r = await runRecovery(w, { policyNumber: bad });
    assert.equal(r.error.code, "RECOVER_NUMBER", JSON.stringify(bad));
    assert.match(r.error.message, /does not look like one, so its PDF was not fetched\. Nothing was paid\./);
    assert.deepEqual(w.gets, []);
    assert.equal(r.mongo.writes.length, 0);
  }
});

test("recovery: problems saving on the policy records are warnings, the PDF is still stored", async () => {
  const w = makeWorld({ linkDownloads: false });
  const seed = issuedSeed({ policy: [{ _id: "x", isOnlinePolicy: true, clientId: "client9", policyNumber: OP_ID }] });
  const r = await runRecovery(w, { seed });
  assert.ok(!r.error, r.error && r.error.message);
  assert.equal(r.uploads.length, 1);
  assert.match(r.result.warning, /^Policy 120122623750221335 was already issued and its PDF was fetched now, but /);
  assert.match(r.result.warning, /no policy record of this online policy was found/);
});

/* -------------------------------------------------------------------------- */
/* The uploader                                                               */
/* -------------------------------------------------------------------------- */

test("createPolicyPdfUploader: private, the Policy key as given, the file's bytes, the bucket read at call time", async () => {
  const calls = [];
  const fakeS3 = {
    upload(params) {
      calls.push(params);
      return { promise: async () => ({ Key: params.Key, Location: `https://b.s3.amazonaws.com/${params.Key}` }) };
    },
  };
  const fakeFs = { readFileSync: (p) => Buffer.from(`bytes of ${p}`) };
  let bucket = "bucket-one";
  const up = issue.createPolicyPdfUploader(fakeS3, { bucket: () => bucket, fsImpl: fakeFs });
  const r = await up("/job_dir/x.pdf", { key: "Policy/4102026-ABC123XYZ-Policy.pdf" });
  assert.deepEqual(r, { key: "Policy/4102026-ABC123XYZ-Policy.pdf", location: "https://b.s3.amazonaws.com/Policy/4102026-ABC123XYZ-Policy.pdf" });
  assert.equal(calls[0].Bucket, "bucket-one");
  assert.equal(calls[0].Key, "Policy/4102026-ABC123XYZ-Policy.pdf");
  assert.equal(calls[0].ACL, "private");
  assert.equal(calls[0].ContentType, "application/pdf");
  assert.equal(calls[0].Body.toString(), "bytes of /job_dir/x.pdf");
  bucket = "bucket-two";
  await up("/job_dir/y.pdf", { key: "Policy/k.pdf" });
  assert.equal(calls[1].Bucket, "bucket-two");
  // a failure of the bucket travels up (the caller turns it into a PDF_NOT_STORED error)
  const failing = issue.createPolicyPdfUploader({ upload: () => ({ promise: async () => { throw new Error("AccessDenied"); } }) }, { fsImpl: fakeFs });
  await assert.rejects(() => failing("/x.pdf", { key: "k" }), /AccessDenied/);
});

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

test("every failure message survives beautifyError unchopped (no colon outside the portal's quoted words)", async () => {
  const scenarios = [
    { world: { rowsAdded: [] }, opts: { deps: { timing: { rowWaitMs: 1500 } } } },
    { world: { rowsAdded: ["CDT 6,268.00 a", "CDT 6,268.00 a"] } },
    { world: { submitDisabled: true } },
    { world: { dialog: "Please select the payment mode" } },
    { world: {}, opts: { mongo: { connectError: "ECONNREFUSED" } } },
    { world: { answer: "refused" } },
    { world: { answer: "none" } },
    { world: { answer: "successNoLink" } },
    { world: { answer: "numberMismatch" } },
    { world: { linkDownloads: false, viewDownloads: false } },
    { world: { linkDownloads: false, noMenuHref: true, viewAddressFails: true, menuItemMissing: true }, opts: { deps: { timing: { menuWaitMs: 1500, searchPageWaitMs: 1500 } } } },
  ];
  for (const s of scenarios) {
    const w = makeWorld(s.world);
    const r = await runFlow(w, s.opts || {});
    assert.ok(r.error, `an error for ${JSON.stringify(s.world)}`);
    const withoutQuoted = r.error.message.replace(/"[^"]*"/g, '""');
    assert.ok(!withoutQuoted.includes(":"), `colon outside quotes in: ${r.error.message}`);
    assert.equal(beautifyError(r.error.message, "Reliance"), `[Reliance] ${r.error.message}`, r.error.message);
    assert.equal(r.error.keepMessage, true);
    assert.equal(r.error.portalRejected, true, "the form's nested catches let it through");
  }
});

/* -------------------------------------------------------------------------- */
/* The wiring in relianceForm.js and the module's own order                   */
/* -------------------------------------------------------------------------- */

const formSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
const issueSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceWalletIssue.js"), "utf8");
const at = (src, needle, from = 0) => {
  const i = src.indexOf(needle, from);
  assert.ok(i >= 0, `missing: ${needle}`);
  return i;
};

test("relianceForm.js: the gate runs before any browser opens; the issue step is behind the switch and the run carries on after it", () => {
  const gate = at(formSrc, "const gate = await checkSubmitGate(data, jobId);");
  const switchOn = at(formSrc, "if (isWalletSubmitEnabled()) {");
  const browser = at(formSrc, "jobBrowser = await createRelianceJobBrowser(jobId);");
  assert.ok(switchOn < gate && gate < browser, "the gate is before the browser");
  const blocked = formSrc.slice(gate, browser);
  assert.match(blocked, /postSubmissionFailed: true/);
  assert.match(blocked, /retryable: false/);

  const walletArgs = at(formSrc, "const walletArgs = {");
  const branchSwitch = at(formSrc, "if (isWalletSubmitEnabled()) {", walletArgs);
  const issueCall = at(formSrc, "const issued = await payWithCdtAndIssue({", branchSwitch);
  assert.ok(
    /^if \(isWalletSubmitEnabled\(\)\) \{\s*\/\/ After Add/.test(formSrc.slice(branchSwitch, branchSwitch + 120)),
    "the issue step sits directly behind the switch"
  );
  const warn = at(formSrc, "if (issued.warning && !documentUploadError) documentUploadError = issued.warning;", issueCall);
  const fallthrough = at(formSrc, 'console.log("✅ Payment flow completed, continuing to Brisk API...");', warn);
  const brisk = at(formSrc, "// === STEP 9: Call Brisk Certificate API ===", fallthrough);
  assert.ok(issueCall < warn && warn < fallthrough && fallthrough < brisk, "after the issue step the run goes on to the Brisk step");
  const body = formSrc.slice(issueCall, warn);
  assert.match(body, /downloadDir:\s*\n?\s*jobBrowser\?\.profileInfo\?\.downloadDir/);
  // the bucket, the Policy key and the private ACL are the uploader's (createPolicyPdfUploader, tested above), built on the
  // form's own s3 client — the same one the merged PDF goes through
  assert.match(body, /uploadPolicyPdf: uploadPolicyPdfToS3,/);
  assert.ok(formSrc.includes("const uploadPolicyPdfToS3 = createPolicyPdfUploader(s3);"));
  // nothing stops the run around the issue step: the only `stopper(` in the whole CDT branch is the lambda handed to the
  // wait-after-Add (used only when RELIANCE_WALLET_SUBMIT_ENABLED is off)
  const holdBranch = at(formSrc, "} else if (shouldHoldForWallet(data.Paymentmethod)) {", warn);
  const branch = formSrc.slice(walletArgs, holdBranch);
  assert.equal(branch.split("stopper(").length - 1, 1);
  assert.ok(/stop: \(message, details\) => stopper\(message, details\)/.test(branch));
  assert.ok(!/stopper\(/.test(body));
});

test("relianceForm.js: an `issued` policy is finished — the gate lets it through, the form body is skipped, the completion steps still run", () => {
  const gate = at(formSrc, "const gate = await checkSubmitGate(data, jobId);");
  const decide = at(formSrc, "const decision = decideAfterGate(gate, {", gate);
  const recoverSwitch = at(formSrc, "recoverEnabled: isWalletRecoverEnabled(),", decide);
  const toRecover = at(formSrc, 'if (decision.action === "recover") {', recoverSwitch);
  const flag = at(formSrc, "issuedRecovery = decision;", toRecover);
  const toRefuse = at(formSrc, '} else if (decision.action === "refuse") {', flag);
  const refusal = at(formSrc, "console.error(`[${jobId}] ⛔ ${decision.message}`);", toRefuse);
  const browser = at(formSrc, "jobBrowser = await createRelianceJobBrowser(jobId);", refusal);
  const login = at(formSrc, "const loginSuccess = await performLogin(driver, {", browser);
  // the login really landed on the dashboard (the Motors menu is there) before anything else happens
  const motors = at(formSrc, 'console.log("Motors menu detected!");', login);
  const recovery = at(formSrc, "const recovered = await recoverIssuedPolicyPdf({", motors);
  const skip = at(formSrc, "if (!issuedRecovery) {", recovery);
  const step2 = at(formSrc, "// === STEP 3: hover Motors and click Two Wheeler ===", skip);
  const skipEnd = at(formSrc, "} // end of: if (!issuedRecovery) — the form", step2);
  const failure = at(formSrc, "// If any post-submission/calculation failure occurred, return it", skipEnd);
  const brisk = at(formSrc, "// === STEP 9: Call Brisk Certificate API ===", failure);
  assert.ok(decide < recoverSwitch && recoverSwitch < toRecover && toRecover < flag && flag < toRefuse && toRefuse < refusal);
  assert.ok(refusal < browser && browser < login && login < recovery);
  assert.ok(recovery < skip && skip < step2 && step2 < skipEnd && skipEnd < failure && failure < brisk);
  // a failed recovery is a post-submission failure (never retried by itself), with a screenshot
  const body = formSrc.slice(recovery, skip);
  assert.match(body, /postSubmissionFailed: true/);
  assert.match(body, /captureErrorScreenshot\(driver, recoveryErr, data, "recovery-error"\)/);
  assert.match(body, /if \(recovered\.warning && !documentUploadError\) documentUploadError = recovered\.warning;/);
  // it never reaches the payment code: Submit Details / Pay / the CDT step are all inside the skipped form
  assert.ok(at(formSrc, "const issued = await payWithCdtAndIssue({") > skip);
  assert.ok(at(formSrc, 'console.log("✅ Clicked Pay button");') > skip);
});

test("relianceForm.js: once the policy PDF is stored there is no merge-service call, and that call can no longer stall the job", () => {
  assert.ok(formSrc.includes("let policyPdfOnPolicy = false;"));
  // set after the issue step and after the recovery
  const issued = at(formSrc, "const issued = await payWithCdtAndIssue({");
  const setIssued = at(formSrc, "policyPdfOnPolicy = true; // issued, and its PDF is stored", issued);
  const recovered = at(formSrc, "const recovered = await recoverIssuedPolicyPdf({");
  const setRecovered = at(formSrc, "policyPdfOnPolicy = true; // the policy has its PDF", recovered);
  assert.ok(setIssued > issued && setRecovered > recovered);
  // the no-Brisk branch checks it BEFORE the merge call, and only the else-branch calls the merge service
  const branch = at(formSrc, "if (!shouldCreateBrisk) {");
  const check = at(formSrc, "if (policyPdfOnPolicy) {", branch);
  const elseIf = at(formSrc, "} else if (reliancePdfPath) {", check);
  const merge = at(formSrc, "mergedPdfInfo = await mergePDFsAndUpload(reliancePdfPath, null, data);", elseIf);
  assert.ok(branch < check && check < elseIf && elseIf < merge);
  // the merge service call has a timeout (an unreachable host used to hold a finished policy for minutes)
  const post = at(formSrc, "'http://192.168.1.7:3010/api/merge-pdf',");
  const timeout = at(formSrc, "timeout: Number(process.env.MERGE_PDF_TIMEOUT_MS) || 30000,", post);
  assert.ok(timeout - post < 400);
});

test("relianceWalletIssue.js: the note is claimed before the press; Submit Details has exactly one press site; the number is saved before the PDF", () => {
  const claim = at(issueSrc, "claim = await store.claim(pressedNote);");
  const press = at(issueSrc, "const button = await driver.findElement(By.id(IDS.submit));");
  const check = at(issueSrc, 'checkpoint("wallet-cdt-submit");');
  const save = at(issueSrc, "const savedNumber = await store.saveNumber(number);");
  const link = at(issueSrc, "let pdf = await pdfFromScheduleLink(pdfCtx);");
  assert.ok(check < claim && claim < press && press < save && save < link);
  assert.equal(issueSrc.split("By.id(IDS.submit)").length - 1, 1, "one place presses Submit Details");
  assert.equal(issueSrc.split("clickOnce(driver, button)").length - 1, 1);
  // a script click of Submit Details exists only inside clickOnce's refused-before-it-happened branch
  assert.ok(!/executeScript\([^)]*submit/i.test(issueSrc));
});
