// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaWalletIssue.test.js
//
// KSHEMA wallet - Pay with CD Balance, the policy number and the policy PDF (fullPolicycompany/kshema/kshemaWalletIssue.js).
// It REALLY PAYS, so the tests are about the money rules first: the premium is checked against the CD balance, the note is
// written BEFORE the press, the button is pressed exactly once, anything unclear after the press blocks re-runs, a re-run
// never presses again, and the number / PDF are saved properly.
//
// Fakes only - a fake page, a fake clock, a fake file system, a fake store, a fake uploader. No browser, no database, no S3.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const wi = require("../fullPolicycompany/kshema/kshemaWalletIssue");
const issue = require("../fullPolicycompany/reliance/relianceWalletIssue");

async function quiet(fn) {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

const PAY_PAGE = "https://motorinsurance.kshema.co/app/payment/choose?q=1";
const POLICY_PAGE = "https://motorinsurance.kshema.co/app/policy?policy_id=P000000432856&err=0&msg=Paymentupdated&key=P000000432856";
const NUMBER = "IP11000121826270298896";
const DIR = "/downloads/job1";
const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

/** A fake file system holding the job's download folder. */
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([name, buf]) => [name, { buf, mtimeMs: 1 }]));
  const fds = new Map();
  let nextFd = 3;
  return {
    files,
    add(name, buf, mtimeMs = 1000) {
      files.set(name, { buf, mtimeMs });
    },
    existsSync: (p) => p === DIR,
    readdirSync: () => [...files.keys()],
    statSync: (p) => {
      const f = files.get(path.basename(p));
      if (!f) throw new Error("ENOENT");
      return { isFile: () => true, size: f.buf.length, mtimeMs: f.mtimeMs };
    },
    openSync: (p) => {
      const fd = nextFd++;
      fds.set(fd, files.get(path.basename(p)).buf);
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => fds.get(fd).copy(buffer, offset, position, position + length),
    closeSync: (fd) => fds.delete(fd),
  };
}

/**
 * The fake KSHEMA world after the CD Balance card is chosen.
 *   premium        the top bar's INR texts
 *   payButtons     [{text, enabled}] - the Pay with CD Balance buttons shown
 *   arriveAfterMs  when the policy page opens after the press (null = never); `arriveUrl` its address; `inNewTab`
 *   toast          { atMs, text } an error toast after the press; `toastBefore` one already showing
 *   number         what the Summary table's Policy Number cell says; `numberAfterMs` when it renders
 *   icon           the download icon is there; `downloadName` / `downloadBytes` what the click puts in the folder
 */
function world(over = {}) {
  const o = {
    premium: ["INR 6,437"],
    payButtons: [{ text: "Pay with CD Balance", enabled: true }],
    arriveAfterMs: 20000,
    arriveUrl: POLICY_PAGE,
    inNewTab: false,
    toast: null,
    toastBefore: null,
    number: NUMBER,
    numberAfterMs: 2000,
    icon: true,
    downloadName: "Policy_P000000432856.pdf",
    downloadBytes: PDF_BYTES,
    clickRefused: false,
    url: PAY_PAGE,
    ...over,
  };
  const clock = { t: 0 };
  const events = [];
  const state = { url: o.url, window: "main", handles: ["main"], pressedAt: null, presses: 0, iconClicks: 0, gets: [] };
  const fsImpl = fakeFs({ "proposal_quote.pdf": PDF_BYTES }); // the proposal PDF downloaded earlier in the same run
  const payEl = {
    click: async () => {
      if (o.clickRefused) {
        const e = new Error("element click intercepted");
        e.name = "ElementClickInterceptedError";
        throw e;
      }
      state.presses += 1;
      state.pressedAt = clock.t;
      events.push("press");
    },
  };
  const iconEl = {
    isDisplayed: async () => true,
    click: async () => {
      state.iconClicks += 1;
      events.push("icon");
      if (o.downloadBytes) fsImpl.add(o.downloadName, o.downloadBytes, 5000 + clock.t);
    },
  };
  const onPolicyPage = () => !!wi.readPolicyPageUrl(currentUrl());
  const currentUrl = () => {
    if (state.window !== "main") return state.tabUrl;
    return state.url;
  };
  const tick = () => {
    if (state.pressedAt !== null && o.arriveAfterMs !== null && clock.t - state.pressedAt >= o.arriveAfterMs) {
      if (o.inNewTab) {
        if (!state.handles.includes("tab2")) {
          state.handles.push("tab2");
          state.tabUrl = o.arriveUrl;
        }
      } else {
        state.url = o.arriveUrl;
      }
    }
  };
  const driver = {
    state,
    events,
    async executeScript(script, el) {
      tick();
      if (script === wi.PREMIUM_SCRIPT) return o.premium;
      if (script === wi.PAY_BUTTON_SCRIPT) return o.payButtons.map((b) => [payEl, b.text, b.enabled]);
      if (script === wi.POLICY_NUMBER_SCRIPT) {
        if (!onPolicyPage() || state.pressedAt === null && !state.gets.length) return { label: false, value: "" };
        const since = state.gets.length ? 0 : clock.t - state.pressedAt - o.arriveAfterMs;
        return since >= o.numberAfterMs || state.gets.length ? { label: true, value: o.number } : { label: false, value: "" };
      }
      if (/arguments\[0\]\.click\(\)/.test(script)) return el && el.click ? el.click() : undefined;
      return undefined;
    },
    async getCurrentUrl() {
      tick();
      return currentUrl();
    },
    async getAllWindowHandles() {
      tick();
      return [...state.handles];
    },
    async getWindowHandle() {
      return state.window;
    },
    switchTo: () => ({
      window: async (h) => {
        state.window = h;
      },
    }),
    async close() {
      state.handles = state.handles.filter((h) => h !== state.window);
    },
    async findElements(locator) {
      tick();
      const css = String(locator && locator.value);
      if (css.includes("dnld-download-policy")) return onPolicyPage() && o.icon ? [iconEl] : [];
      return [];
    },
    async get(url) {
      state.gets.push(url);
      state.url = url;
    },
    async sleep(ms) {
      clock.t += ms;
    },
  };
  const readToast = async () => {
    if (state.pressedAt === null) return o.toastBefore ? { text: o.toastBefore, isError: true } : null;
    if (o.toast && clock.t - state.pressedAt >= o.toast.atMs) return { text: o.toast.text, isError: true };
    return null;
  };
  return { driver, clock, fsImpl, readToast, events, state, o };
}

/** A store that records every write in order (the events list is shared with the page, so order is checkable). */
function fakeStore(events, over = {}) {
  const calls = { claim: [], outcome: [], payable: [], number: [], pdf: [] };
  const store = {
    calls,
    async claim(note) {
      events.push("claim");
      calls.claim.push(note);
      if (over.claimThrows) throw new Error("database down");
      return { matched: over.claimMatched === undefined ? 1 : over.claimMatched, modified: 1 };
    },
    async readNote() {
      return over.note || { found: true, marker: null };
    },
    async savePayable(entry) {
      calls.payable.push(entry);
      return { ok: true };
    },
    async outcome(patch) {
      events.push(`outcome:${patch.state || Object.keys(patch).join(",")}`);
      calls.outcome.push(patch);
      return { ok: true };
    },
    async saveNumber(number) {
      events.push("saveNumber");
      calls.number.push(number);
      return { onlinePolicy: "saved", policy: "saved", warnings: over.numberWarnings || [], policyDocId: "pd1" };
    },
    async savePdf(file, policyDocId) {
      events.push("savePdf");
      calls.pdf.push({ file, policyDocId });
      return { policy: "saved", onlinePolicy: "saved", warnings: over.pdfWarnings || [] };
    },
    async policyFileKey() {
      return over.storedKey || "";
    },
  };
  return store;
}

const DATA = { _id: "op1", _partKey: "tp", _jobId: "job1", username: "agent7" };
const CHOICE = { ok: true, wallet: true, chosen: true, balance: "₹65,329", paymentUrl: PAY_PAGE };

async function pay(over = {}, storeOver = {}, { data = DATA, choice = CHOICE, uploadThrows = false } = {}) {
  const w = world(over);
  const store = fakeStore(w.events, storeOver);
  const uploads = [];
  const r = await quiet(() =>
    wi.payWithCdBalanceAndIssue({
      driver: w.driver,
      data,
      jobId: "job1",
      choice,
      downloadDir: DIR,
      deps: {
        store,
        readToast: w.readToast,
        fsImpl: w.fsImpl,
        now: () => w.clock.t,
        sleep: async (ms) => w.driver.sleep(ms),
        policyFileNames: () => ({ fileName: "2210-ABC-Policy.pdf", key: "Policy/2210-ABC-Policy.pdf" }),
        uploadPolicyPdf: async (filePath, { key }) => {
          if (uploadThrows) throw new Error("S3 refused: access denied");
          uploads.push({ filePath, key });
          return { key, location: `https://bucket.example/${key}` };
        },
      },
    })
  );
  return { r, w, store, uploads };
}

const noColonIn = (s) => assert.doesNotMatch(String(s), /:/, String(s));

/* ------------------------------------ the happy road ------------------------------------ */

test("issued: premium checked, the note BEFORE the one press, the policy page, the number saved, the NEW PDF stored", async () => {
  const { r, w, store, uploads } = await pay();
  assert.equal(r.ok, true, r.error);
  assert.equal(w.state.presses, 1, "Pay with CD Balance pressed exactly once");
  const order = w.events.filter((e) => ["claim", "press", "outcome:issued", "saveNumber", "icon", "savePdf"].includes(e));
  assert.deepEqual(order, ["claim", "press", "outcome:issued", "saveNumber", "icon", "savePdf"], "note, press, issued, number, PDF");

  const note = store.calls.claim[0];
  assert.equal(note.state, "submit-pressed");
  assert.equal(note.insurer, "KSHEMA");
  assert.equal(note.method, "CD Balance");
  assert.equal(note.amountPaise, 643700);
  assert.equal(note.paymentPage, PAY_PAGE);
  assert.equal(note.part, "tp");
  assert.deepEqual(store.calls.payable.map((p) => [p.insurer, p.method, p.amountPaise]), [["KSHEMA", "CD Balance", 643700]]);

  const issued = store.calls.outcome.find((p) => p.state === "issued");
  assert.equal(issued.policyPageUrl, POLICY_PAGE);
  assert.equal(issued.kshemaPolicyId, "P000000432856");
  assert.deepEqual(store.calls.number, [NUMBER]);
  assert.ok(store.calls.outcome.some((p) => p.policyNumber === NUMBER));

  assert.deepEqual(uploads, [{ filePath: path.join(DIR, "Policy_P000000432856.pdf"), key: "Policy/2210-ABC-Policy.pdf" }], "the new PDF, not the proposal PDF already there");
  assert.deepEqual(store.calls.pdf[0], { file: { fileName: "2210-ABC-Policy.pdf", key: "Policy/2210-ABC-Policy.pdf", location: "https://bucket.example/Policy/2210-ABC-Policy.pdf" }, policyDocId: "pd1" });
  assert.ok(store.calls.outcome.some((p) => p.pdfStoredAt && p.pdfKey === "Policy/2210-ABC-Policy.pdf"));
  assert.equal(r.policyNumber, NUMBER);
  assert.equal(r.policyPageUrl, POLICY_PAGE);
  assert.equal(r.premiumPaise, 643700);
  assert.equal(r.warning, "");
});

test("the policy page opened in a NEW tab is followed", async () => {
  const { r, w } = await pay({ inNewTab: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(w.state.presses, 1);
  assert.equal(r.policyNumber, NUMBER);
});

test("an error toast that is followed by the policy page within its grace still counts as issued", async () => {
  const { r } = await pay({ toast: { atMs: 15000, text: "Something went wrong" }, arriveAfterMs: 18000 });
  assert.equal(r.ok, true, r.error);
});

test("warnings of the saves ride along on a completed policy, without a colon", async () => {
  const { r } = await pay({}, { numberWarnings: ["no policy record of this online policy was found in the policy collection"] });
  assert.equal(r.ok, true);
  assert.match(r.warning, /^Policy IP11000121826270298896 was issued and its PDF is stored, but no policy record/);
  noColonIn(r.warning);
});

/* ------------------------------------ before the press: nothing paid ------------------------------------ */

test("the CD balance lower than KSHEMA's premium: an error, no note, nothing pressed", async () => {
  const { r, w, store } = await pay({ premium: ["INR 70,000"] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "LOW_BALANCE");
  assert.equal(r.paid, false);
  assert.equal(w.state.presses, 0);
  assert.equal(store.calls.claim.length, 0);
  assert.equal(r.error, "The CD Balance at KSHEMA (₹65,329.00) is lower than the premium KSHEMA asks (₹70,000.00), so Pay with CD Balance was not pressed. Add money to the CD account, then run the policy again. Nothing was paid");
  // the same amount is enough
  const same = await pay({ premium: ["INR 65,329"] });
  assert.equal(same.r.ok, true, same.r.error);
});

test("the premium cannot be read (none, or two different INR figures): no check, no payable kept, KSHEMA decides", async () => {
  for (const premium of [[], ["INR 6,437", "INR 7,000"], ["Premium"]]) {
    const { r, w, store } = await pay({ premium });
    assert.equal(r.ok, true, JSON.stringify(premium));
    assert.equal(w.state.presses, 1);
    assert.equal(store.calls.payable.length, 0, "nothing kept as what KSHEMA asked");
    assert.equal(store.calls.claim[0].amountPaise, null);
  }
});

test("no Pay with CD Balance button, a switched-off one, or two of them: nothing pressed, nothing written", async () => {
  for (const [payButtons, words] of [
    [[], /is not on the KSHEMA payment page/],
    [[{ text: "Pay with CD Balance", enabled: false }], /is switched off on the KSHEMA payment page/],
    [[{ text: "Pay with CD Balance", enabled: true }, { text: "Pay with CD Balance", enabled: true }], /more than one Pay with CD Balance button/],
  ]) {
    const { r, w, store } = await pay({ payButtons });
    assert.equal(r.ok, false);
    assert.equal(r.code, "PAY_BUTTON");
    assert.equal(r.paid, false);
    assert.match(r.error, words);
    assert.equal(w.state.presses, 0);
    assert.equal(store.calls.claim.length, 0);
  }
});

test("a KSHEMA error toast already showing: nothing pressed", async () => {
  const { r, w, store } = await pay({ toastBefore: "Session expired." });
  assert.equal(r.code, "TOAST_BEFORE");
  assert.equal(r.error, 'KSHEMA shows "Session expired" on the payment page, so Pay with CD Balance was not pressed. Nothing was paid');
  assert.equal(w.state.presses, 0);
  assert.equal(store.calls.claim.length, 0);
});

test("the note cannot be written: NOT pressed; a blocking note already there: NOT pressed and told as paid", async () => {
  const thrown = await pay({}, { claimThrows: true });
  assert.equal(thrown.r.code, "NOTE_NOT_SAVED");
  assert.equal(thrown.r.paid, false);
  assert.equal(thrown.w.state.presses, 0);

  const nothing = await pay({}, { claimMatched: 0, note: { found: false, marker: null } });
  assert.equal(nothing.r.code, "NOTE_NOT_SAVED");
  assert.match(nothing.r.error, /the policy was not found/);
  assert.equal(nothing.w.state.presses, 0);

  const already = await pay({}, { claimMatched: 0, note: { found: true, marker: { state: "unconfirmed", amountPaise: 643700, at: new Date(2026, 9, 22, 15, 44) } } });
  assert.equal(already.r.code, "ALREADY_PAID");
  assert.equal(already.r.paid, true, "a payment may already have been made - never as a plain failure");
  assert.equal(already.w.state.presses, 0);
  assert.match(already.r.error, /^A CD Balance payment was already made for this policy at KSHEMA \(₹6,437\.00, on 22 Oct 2026 15\.44, state unconfirmed\) and KSHEMA's answer was never confirmed\./);
  assert.match(already.r.error, /clear the walletPayment_tp note/);
});

test("no policy id: nothing written, nothing pressed", async () => {
  const { r, w, store } = await pay({}, {}, { data: { _partKey: "tp" } });
  assert.equal(r.code, "NO_POLICY_ID");
  assert.equal(w.state.presses, 0);
  assert.equal(store.calls.claim.length, 0);
});

test("a click refused both ways: the note says failed, nothing was paid", async () => {
  const { r, w, store } = await pay({ clickRefused: true });
  assert.equal(r.code, "PAY_NOT_CLICKED");
  assert.equal(r.paid, false);
  assert.equal(w.state.presses, 0);
  assert.equal(store.calls.outcome[0].state, "failed");
});

/* ------------------------------------ after the press: anything unclear BLOCKS ------------------------------------ */

test("no policy page within 40 s: unconfirmed, blocked, pressed only once, waited the whole 40 s with a line every 10 s", async () => {
  const lines = [];
  const saved = console.log;
  const w = world({ arriveAfterMs: null });
  const store = fakeStore(w.events);
  console.log = (...a) => lines.push(a.join(" "));
  let r;
  try {
    r = await wi.payWithCdBalanceAndIssue({
      driver: w.driver,
      data: DATA,
      jobId: "job1",
      choice: CHOICE,
      downloadDir: DIR,
      deps: { store, readToast: w.readToast, fsImpl: w.fsImpl, now: () => w.clock.t, sleep: async (ms) => w.driver.sleep(ms), uploadPolicyPdf: async () => ({}) },
    });
  } finally {
    console.log = saved;
  }
  assert.equal(r.ok, false);
  assert.equal(r.code, "PAY_UNCONFIRMED");
  assert.equal(r.paid, true);
  assert.equal(r.state, "unconfirmed");
  assert.equal(w.state.presses, 1, "never pressed a second time");
  assert.ok(w.clock.t - w.state.pressedAt >= 40000, "the whole 40 seconds");
  assert.ok(w.clock.t - w.state.pressedAt < 45000, "and not much more");
  assert.equal(lines.filter((l) => /… waiting for KSHEMA's policy page \(/.test(l)).length, 3, "a line at 10, 20 and 30 s - the stuck-step watch never sees silence");
  assert.equal(store.calls.outcome.at(-1).state, "unconfirmed");
  assert.equal(
    r.error,
    "Pay with CD Balance was pressed for ₹6,437.00 and KSHEMA did not open its policy page within 40 seconds. The payment may have gone through. Check the policy at KSHEMA before running it again - it is marked so that it is not run again by itself"
  );
  assert.deepEqual(wi.failureResultOf(r), { stage: "post-submission", postSubmissionFailed: true, retryable: false, error: r.error, walletState: "unconfirmed" });
});

test("an error toast after the press (no page within its grace): unconfirmed with KSHEMA's words, blocked", async () => {
  const { r, w, store } = await pay({ toast: { atMs: 3000, text: "Payment failed: insufficient balance." }, arriveAfterMs: null });
  assert.equal(r.code, "PAY_UNCONFIRMED");
  assert.equal(r.paid, true);
  assert.equal(w.state.presses, 1);
  assert.match(r.error, /^Pay with CD Balance was pressed for ₹6,437\.00 and KSHEMA showed "Payment failed - insufficient balance" and its policy page did not open\./);
  assert.ok(w.clock.t - w.state.pressedAt < 12000, "it does not wait the whole 40 s once KSHEMA has said no");
  assert.equal(store.calls.outcome.at(-1).state, "unconfirmed");
  noColonIn(r.error);
});

test("the policy page with an error flag, or KSHEMA's login page: unconfirmed, blocked", async () => {
  const flag = await pay({ arriveUrl: "https://motorinsurance.kshema.co/app/policy?policy_id=P1&err=1&msg=Paymentfailed" });
  assert.equal(flag.r.code, "PAY_UNCONFIRMED");
  assert.match(flag.r.error, /KSHEMA opened its policy page with an error \(Paymentfailed\)/);
  const login = await pay({ arriveUrl: "https://motorinsurance.kshema.co/login" });
  assert.equal(login.r.code, "PAY_UNCONFIRMED");
  assert.match(login.r.error, /KSHEMA went back to its login page/);
});

test("the policy page opened but no number could be read: paid, the note stays issued with the page, nothing saved", async () => {
  for (const number of ["", "OP12345678", "Policy"]) {
    const { r, store } = await pay({ number });
    assert.equal(r.code, "NUMBER_MISSING", number);
    assert.equal(r.paid, true);
    assert.equal(r.state, "issued");
    assert.equal(r.policyPageUrl, POLICY_PAGE);
    assert.equal(store.calls.number.length, 0, "nothing saved on a doubt");
    assert.ok(store.calls.outcome.some((p) => p.state === "issued" && p.policyPageUrl === POLICY_PAGE), "a re-run can finish it");
    assert.match(r.error, /run the policy again to read the number and the PDF from the saved policy page/);
  }
});

test("the PDF: no icon, no new file (only the proposal PDF), or an upload refused - paid and numbered, a re-run fetches it", async () => {
  for (const [over, uploadThrows, words] of [
    [{ icon: false }, false, /could not be downloaded \(the policy download icon is not on the policy page\)/],
    [{ downloadBytes: null }, false, /could not be downloaded \(no PDF arrived in 60 seconds\)/],
    [{ downloadBytes: Buffer.from("<!doctype html><html>error</html>") }, false, /is a web page/],
    [{}, true, /was downloaded but it could not be stored \(S3 refused - access denied\)/],
  ]) {
    const { r, store } = await pay(over, {}, { uploadThrows });
    assert.equal(r.code, "PDF_MISSING");
    assert.equal(r.paid, true);
    assert.equal(r.policyNumber, NUMBER);
    assert.deepEqual(store.calls.number, [NUMBER], "the number is saved before the PDF is touched");
    assert.equal(store.calls.pdf.length, 0);
    assert.match(r.error, words);
    assert.match(r.error, /^Policy IP11000121826270298896 was issued at KSHEMA from CD Balance and its number is saved, but its PDF /);
    noColonIn(r.error);
  }
});

/* ------------------------------------ the gate and the recovery ------------------------------------ */

test("decideKshemaGate: no note = go; pressed / unconfirmed / issued without a page = refuse; issued with page = recover; all stored = done", () => {
  const data = { _id: "op1", _partKey: "tp" };
  assert.deepEqual(wi.decideKshemaGate({ blocked: false }, data), { action: "go" });
  assert.deepEqual(wi.decideKshemaGate(null, data), { action: "go" });
  for (const state of ["submit-pressed", "unconfirmed"]) {
    const d = wi.decideKshemaGate({ blocked: true, state, marker: { state, amountPaise: 643700 } }, data);
    assert.equal(d.action, "refuse", state);
    assert.match(d.message, /This run was not started so the CD account is not charged twice/);
    assert.match(d.message, /clear the walletPayment_tp note/);
    noColonIn(d.message);
  }
  assert.match(wi.decideKshemaGate({ blocked: true, state: "submit-pressed", marker: { state: "submit-pressed" } }, {}).message, /clear the walletPayment note/, "the bundled part's own field");
  // money first: a pressed / unconfirmed note is refused WHATEVER else it carries - only an issued one is finished
  for (const state of ["submit-pressed", "unconfirmed"]) {
    const full = { state, policyPageUrl: POLICY_PAGE, policyNumber: NUMBER, pdfStoredAt: new Date() };
    assert.equal(wi.decideKshemaGate({ blocked: true, state, marker: full }, data).action, "refuse", `${state} with a page and a number`);
  }
  const noPage = wi.decideKshemaGate({ blocked: true, state: "issued", marker: { state: "issued", policyNumber: NUMBER } }, data);
  assert.equal(noPage.action, "refuse");
  assert.match(noPage.message, /the policy was issued but its page was not kept\. The policy number is IP11000121826270298896\./);
  const recover = wi.decideKshemaGate({ blocked: true, state: "issued", marker: { state: "issued", policyPageUrl: POLICY_PAGE } }, data);
  assert.equal(recover.action, "recover");
  const done = wi.decideKshemaGate({ blocked: true, state: "issued", marker: { state: "issued", policyPageUrl: POLICY_PAGE, policyNumber: NUMBER, pdfStoredAt: new Date() } }, data);
  assert.deepEqual([done.action, done.number], ["done", NUMBER]);
  const numberNoPdf = wi.decideKshemaGate({ blocked: true, state: "issued", marker: { state: "issued", policyPageUrl: POLICY_PAGE, policyNumber: NUMBER } }, data);
  assert.equal(numberNoPdf.action, "recover", "the PDF is still missing");
});

async function recover(markerOver = {}, over = {}, storeOver = {}) {
  const w = world({ url: "https://motorinsurance.kshema.co/app/dashboard", ...over });
  const store = fakeStore(w.events, storeOver);
  const uploads = [];
  const r = await quiet(() =>
    wi.recoverKshemaIssue({
      driver: w.driver,
      data: DATA,
      jobId: "job1",
      marker: { state: "issued", policyPageUrl: POLICY_PAGE, ...markerOver },
      downloadDir: DIR,
      deps: {
        store,
        fsImpl: w.fsImpl,
        now: () => w.clock.t,
        sleep: async (ms) => w.driver.sleep(ms),
        policyFileNames: () => ({ fileName: "2310-XYZ-Policy.pdf", key: "Policy/2310-XYZ-Policy.pdf" }),
        uploadPolicyPdf: async (filePath, { key }) => {
          uploads.push({ filePath, key });
          return { key, location: `https://bucket.example/${key}` };
        },
      },
    })
  );
  return { r, w, store, uploads };
}

test("recovery: the saved policy page is opened, the number saved, the PDF stored - Pay is never pressed", async () => {
  const { r, w, store, uploads } = await recover();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.recovered, true);
  assert.deepEqual(w.state.gets, [POLICY_PAGE]);
  assert.equal(w.state.presses, 0, "nothing is paid again");
  assert.equal(w.events.includes("claim"), false, "no new note");
  assert.deepEqual(store.calls.number, [NUMBER]);
  assert.equal(uploads.length, 1);
  assert.ok(store.calls.outcome.some((p) => p.pdfStoredAt));
});

test("recovery: a page that shows another number than the note saves nothing; one that shows none says so; a stored PDF is not fetched again", async () => {
  const other = await recover({ policyNumber: "IP99999999999999999999" });
  assert.equal(other.r.code, "RECOVER_CONFLICT");
  assert.equal(other.store.calls.number.length, 0);
  noColonIn(other.r.error);

  const none = await recover({}, { number: "" });
  assert.equal(none.r.code, "RECOVER_NUMBER");
  assert.equal(none.r.paid, true);

  const stored = await recover({ policyNumber: NUMBER }, {}, { storedKey: "Policy/old-Policy.pdf" });
  assert.equal(stored.r.ok, true);
  assert.equal(stored.w.state.iconClicks, 0);
  assert.equal(stored.uploads.length, 0);
  assert.ok(stored.store.calls.outcome.some((p) => p.pdfKey === "Policy/old-Policy.pdf"));

  const noPage = await quiet(() => wi.recoverKshemaIssue({ driver: world().driver, data: DATA, marker: { state: "issued" }, deps: { store: fakeStore([]) } }));
  assert.equal(noPage.code, "RECOVER_NO_PAGE");
});

test("the stage refusals name the insurer that took the money - KSHEMA's note says KSHEMA, Reliance's (no insurer) Reliance", () => {
  const core = require("../lib/relianceStagesCore");
  const stages = { tp: { proposal: { status: "completed", link: "https://x.example/p" }, kyc: { status: "completed" }, payment: { status: "completed", mode: "wallet" } } };
  const kshema = { walletPayment_tp: { state: "issued", insurer: "KSHEMA" }, relianceStages: stages };
  assert.equal(core.whyNotReset({ policy: kshema, key: "tp", stage: "payment" }), "This policy was paid from the wallet at KSHEMA, so its stages cannot be redone");
  assert.equal(core.whyNotSetByHand({ policy: kshema, key: "tp", stage: "kyc", to: "completed" }), "This policy was paid from the wallet at KSHEMA, so its steps cannot be changed");
  const reliance = { walletPayment_tp: { state: "issued" }, relianceStages: stages };
  assert.match(core.whyNotReset({ policy: reliance, key: "tp", stage: "payment" }), /at Reliance,/);
  assert.equal(core.walletInsurerOf({}, "tp", "KSHEMA"), "KSHEMA", "no note - the part's company");
});

/* ------------------------------------ small pieces ------------------------------------ */

test("readPolicyPageUrl / premiumOf / failureResultOf", () => {
  assert.deepEqual(wi.readPolicyPageUrl(POLICY_PAGE), { url: POLICY_PAGE, policyId: "P000000432856", err: "0", msg: "Paymentupdated" });
  assert.equal(wi.isGoodPolicyPage(wi.readPolicyPageUrl(POLICY_PAGE)), true);
  assert.equal(wi.isGoodPolicyPage(wi.readPolicyPageUrl("https://x.example/app/policy?err=2")), false);
  assert.equal(wi.isGoodPolicyPage(wi.readPolicyPageUrl("https://x.example/app/policy?policy_id=P1")), true, "no flag at all");
  for (const no of [PAY_PAGE, "https://x.example/app/policy-list", "https://x.example/app/policyholder", "not a url", ""]) assert.equal(wi.readPolicyPageUrl(no), null, no);
  assert.equal(wi.premiumOf(["INR 6,437"]), 643700);
  assert.equal(wi.premiumOf(["INR 6,437", "INR 6,437"]), 643700, "the same figure twice is one amount");
  assert.equal(wi.premiumOf(["INR 6,437.50"]), 643750);
  assert.equal(wi.premiumOf(["INR 6,437", "INR 1,000"]), null);
  assert.equal(wi.premiumOf([]), null);
  assert.deepEqual(wi.failureResultOf({ paid: false, error: "x" }), { stage: "payment", retryable: false, error: "x", walletState: null });
});

/* ------------------------------------ the wiring in both flows (source) ------------------------------------ */

for (const [name, file] of [
  ["kshemaForm.js (full company)", ["fullPolicycompany", "kshemaForm.js"]],
  ["kshemaTPForm.js (multiple company TP)", ["multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"]],
]) {
  const src = fs.readFileSync(path.join(ROOT, ...file), "utf8");
  const flow = src.slice(src.indexOf("async function runKshemaFlow("));
  const at = (needle, from = 0) => {
    const i = flow.indexOf(needle, from);
    assert.ok(i >= 0, `${name}: "${needle}" is in runKshemaFlow`);
    return i;
  };

  test(`${name}: the gate is read before any browser; refused and done runs never open one`, () => {
    const gate = at("const walletGate = decideKshemaGate(await checkKshemaWalletGate(data, jobId), data);");
    const refuse = at('if (walletGate.action === "refuse") {', gate);
    const done = at('if (walletGate.action === "done") {', refuse);
    const browser = at("jobBrowser = await createKshemaJobBrowser(jobId);", done);
    assert.ok(gate < refuse && refuse < done && done < browser);
    assert.match(flow.slice(refuse, done), /postSubmissionFailed: true, retryable: false/);
  });

  test(`${name}: the recovery runs right after the login, past the payment point (no Hold, no stuck-step cut), and never reaches the quote`, () => {
    const login = at('await stopIfHeld(data, "after the login");');
    const branch = at('if (walletGate.action === "recover") {', login);
    const disarm = at("disarmLiveHold(data);", branch);
    const run = at("await recoverKshemaIssue({", disarm);
    const back = at("return {", run);
    const resume = at("const resume = await loadKshemaResume(data, { jobId });", back);
    assert.ok(login < branch && branch < disarm && disarm < run && run < resume);
  });

  test(`${name}: a paid wallet policy completes with its number; a failed one is failed with the money-aware result`, () => {
    const issue = at("await payWithCdBalanceAndIssue({");
    const failed = flow.slice(issue, flow.indexOf("await markStage(data, \"payment\", \"completed\"", issue));
    assert.match(failed, /\.\.\.failureResultOf\(issued\)/);
    assert.match(failed, /await markStage\(data, "payment", "failed", \{ mode: "wallet", error: issued\.error \}/);
    const done = flow.slice(issue, flow.indexOf('log("🎉 KSHEMA flow successfully completed', issue));
    assert.match(done, /policyNumber: issued\.policyNumber,/);
    assert.match(done, /documentUploadError: issued\.warning/);
  });
}

test("the module: no .env switch, one press site, and the press only after the note", () => {
  const src = fs.readFileSync(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaWalletIssue.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/process\.env/.test(code));
  const fn = code.slice(code.indexOf("async function payWithCdBalanceAndIssue("), code.indexOf("async function recoverKshemaIssue("));
  assert.equal(fn.split("issue.clickOnce(driver, button.element)").length - 1, 1, "Pay with CD Balance is pressed in one place");
  assert.ok(fn.indexOf("await store.claim(note)") < fn.indexOf("issue.clickOnce(driver, button.element)"), "the note before the press");
  const rec = code.slice(code.indexOf("async function recoverKshemaIssue("), code.indexOf("module.exports"));
  assert.ok(!/button\.element|PAY_BUTTON_SCRIPT|store\.claim/.test(rec), "the recovery cannot press Pay or write a new note");
});
