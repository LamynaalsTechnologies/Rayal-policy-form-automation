// Run with: npm test   (or: node --require ./test/support/noRealWorld.js --test test/relianceKycFallback.test.js)
//
// When the Reliance KYC does not work — whatever the reason — the run screenshots the error, goes to Pending Quotes, ticks
// THIS proposal, the TP declaration and Pay, saves the proposal / payment page as links on the policy and ends as a
// failed KYC. relianceKycFallback.js does it with a driver, an S3 uploader and Mongo that are handed in; these tests give
// it fakes (a stand-in Pending Quotes page with other customers' rows, a fake bucket, a fake database). No browser, no
// network.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fb = require("../fullPolicycompany/relianceKycFallback");
const kyc = require("../fullPolicycompany/relianceKycSubmit");
const { beautifyError } = require("../lib/errorHandler");

const OURS = "R14102628432";
const ORIGIN = "https://smartzone.reliancegeneral.co.in";
const MAIN_URL = `${ORIGIN}/Policy/ViewPolicy`;
const KYC_URL = "https://kyc.example/onboarding/upload";
const PAYMENT_URL = `${ORIGIN}/Payment/MakePayment?token=abc`;

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

/* -------------------------------------------------------------------------- */
/* A stand-in Reliance portal: two tabs, Pending Quotes with several customers */
/* -------------------------------------------------------------------------- */

class El {
  constructor(portal, props = {}) {
    Object.assign(this, { portal, attrs: {}, text: "", shownNow: true, checked: false, ...props });
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  get id() {
    return this.attrs.id || "";
  }
  closest(sel) {
    return sel === "tr" ? this.row || null : null;
  }
  get innerText() {
    return this.text;
  }
  get textContent() {
    return this.text;
  }
  getBoundingClientRect() {
    return this.shownNow ? { width: 100, height: 20 } : { width: 0, height: 0 };
  }
  click() {
    this.portal.clicked.push(this.name || this.attrs.id || "element");
    if (this.onClick) this.onClick(this);
  }
}

/**
 * @param {Object} o
 * @param {string[]} [o.rows]            proposal numbers listed in Pending Quotes (ours is added unless `without`)
 * @param {boolean} [o.without]          our proposal is not listed
 * @param {"navigates"|"panel"|"alert"|"dialog"|"nothing"} [o.pay]
 * @param {boolean} [o.declarationTicked]  the TP declaration is already ticked when it appears
 * @param {boolean} [o.noPendingMarker]  the direct address shows a page without the word "pending"
 */
function makePortal(o = {}) {
  const portal = {
    clicked: [],
    gets: [],
    closed: [],
    alertsAccepted: 0,
    clock: 0,
    windows: { main: MAIN_URL, kyc: KYC_URL },
    order: ["main", "kyc"],
    current: "kyc",
    payOutcome: o.pay || "navigates",
    alertText: "KYC is not completed for this proposal",
    dialogText: "Please complete KYC before payment",
    boxes: [],
  };

  const proposals = [...(o.rows || ["R14102600001", "R14102628431", "R141026284321"])];
  if (!o.without) proposals.splice(1, 0, OURS);
  portal.rowsFor = proposals;

  const makeBoxes = () => {
    portal.boxes = proposals.map((number, i) => {
      const row = new El(portal, { text: `${number} Customer ${i} Two Wheeler 1,200` });
      const box = new El(portal, {
        name: `checkbox ${number}`,
        attrs: { onclick: `SelectProposal('${number}', ${i})`, id: `chkR${i}` },
        row,
        onClick: (self) => {
          self.checked = !self.checked;
        },
      });
      box.proposal = number;
      return box;
    });
  };
  makeBoxes();

  portal.declaration = new El(portal, {
    name: "TPDeclaration1",
    attrs: { id: "TPDeclaration1" },
    checked: !!o.declarationTicked,
    onClick: (self) => {
      self.checked = !self.checked;
    },
  });
  portal.payButton = new El(portal, {
    name: "Paymentbtn",
    attrs: { id: "Paymentbtn" },
    onClick: () => {
      if (portal.payOutcome === "navigates") portal.windows[portal.current] = PAYMENT_URL;
      else if (portal.payOutcome === "panel") portal.panel = true;
      else if (portal.payOutcome === "alert") portal.alertOpen = true;
      else if (portal.payOutcome === "dialog") portal.dialogOpen = true;
    },
  });
  portal.amountField = new El(portal, { attrs: { id: "txtTotalAmountPaidCurrency" } });
  portal.menuLink = new El(portal, { text: "Pending Quotes", attrs: { href: "/Payment/Payments?menu=1" } });
  portal.menuLink.href = `${ORIGIN}/Payment/Payments?menu=1`;

  const onPending = () => /\/Payment\/Payments/.test(portal.windows[portal.current]) && !o.noPendingMarker;
  const anyTicked = () => portal.boxes.some((b) => b.checked);

  const documentStub = () => ({
    title: "Reliance",
    body: { innerText: onPending() ? "Pending Quotes list" : "Dashboard" },
    getElementById(id) {
      if (id === "TPDeclaration1") return onPending() && anyTicked() ? portal.declaration : null;
      if (id === "Paymentbtn") return onPending() && anyTicked() && portal.declaration.checked ? portal.payButton : null;
      if (id === "txtTotalAmountPaidCurrency") return portal.panel ? portal.amountField : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "input[type='checkbox']") return onPending() ? portal.boxes : [];
      if (sel === "a") return [portal.menuLink];
      if (sel === ".ui-dialog") {
        if (!portal.dialogOpen) return [];
        const dialog = new El(portal, { text: portal.dialogText });
        dialog.querySelector = () => null;
        return [dialog];
      }
      return [];
    },
  });

  portal.driver = {
    async getAllWindowHandles() {
      return [...portal.order];
    },
    async getWindowHandle() {
      return portal.current;
    },
    switchTo() {
      return {
        async window(handle) {
          if (!portal.order.includes(handle)) throw new Error(`no such window: ${handle}`);
          portal.current = handle;
        },
        async alert() {
          if (!portal.alertOpen) throw new Error("no such alert");
          return {
            async getText() {
              return portal.alertText;
            },
            async accept() {
              portal.alertOpen = false;
              portal.alertsAccepted++;
            },
          };
        },
      };
    },
    async close() {
      portal.closed.push(portal.current);
      portal.order = portal.order.filter((h) => h !== portal.current);
      delete portal.windows[portal.current];
      portal.current = null;
    },
    async getCurrentUrl() {
      if (!portal.current) throw new Error("no such window: target window already closed");
      return portal.windows[portal.current];
    },
    async get(url) {
      if (o.getThrows) throw new Error("net::ERR_CONNECTION_RESET");
      portal.gets.push(url);
      portal.windows[portal.current] = url.replace(/^(https?:\/\/[^/]+)\/Payment\/Payments.*$/, (m, origin) =>
        o.noPendingMarker ? `${origin}/Home/Dashboard` : m
      );
      if (/Home\/Dashboard$/.test(portal.windows[portal.current]) && /menu=1/.test(url)) {
        portal.windows[portal.current] = url;
      }
      if (/menu=1/.test(url)) o.noPendingMarker = false;
    },
    async executeScript(fn, ...args) {
      if (portal.alertOpen) {
        const e = new Error("unexpected alert open");
        e.name = "UnexpectedAlertOpenError";
        throw e;
      }
      if (typeof fn === "string") return new Function(fn).apply(null, args);
      const saved = { document: globalThis.document, window: globalThis.window };
      globalThis.document = documentStub();
      globalThis.window = {
        location: { href: portal.windows[portal.current] },
        getComputedStyle: (el) => ({ display: el.shownNow === false ? "none" : "block", visibility: "visible" }),
      };
      try {
        return fn(...args);
      } finally {
        if (saved.document === undefined) delete globalThis.document;
        else globalThis.document = saved.document;
        if (saved.window === undefined) delete globalThis.window;
        else globalThis.window = saved.window;
      }
    },
    async sleep(ms) {
      portal.clock += ms;
    },
  };
  // a fake clock for the waits
  portal.opts = {
    now: () => portal.clock,
    sleep: async (ms) => {
      portal.clock += ms;
    },
  };
  return portal;
}

/* -------------------------------------------------------------------------- */
/* reachPaymentPage                                                           */
/* -------------------------------------------------------------------------- */

test("reaches the payment page: KYC tab closed, THIS proposal ticked (not the neighbours), declaration, Pay, URL read", async () => {
  const p = makePortal();
  const r = await quiet(() =>
    fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts })
  );
  assert.equal(r.reached, true);
  assert.equal(r.paymentUrl, PAYMENT_URL);
  assert.equal(r.proposalFound, true);
  assert.equal(r.blockedBy, "");
  assert.deepEqual(p.closed, ["kyc"], "the KYC tab is closed");
  assert.equal(p.current, "main", "the run is back on the portal's own tab");
  assert.deepEqual(p.gets, [ORIGIN + fb.PENDING_QUOTES_PATH], "Pending Quotes by its address, on the portal's own origin");
  assert.deepEqual(
    p.boxes.filter((b) => b.checked).map((b) => b.proposal),
    [OURS],
    "only this proposal is ticked — the others (including R14102628431 and R141026284321) are not"
  );
  assert.deepEqual(p.clicked, [`checkbox ${OURS}`, "TPDeclaration1", "Paymentbtn"], "nothing else was clicked");
  assert.equal(p.declaration.checked, true);
});

test("a proposal number that is only part of another number is not a match; an absent proposal means nothing is clicked", async () => {
  const p = makePortal({ without: true, rows: ["R14102628431", "R141026284321", "XR14102628432"] });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, false);
  assert.equal(r.proposalFound, false);
  assert.match(r.reason, /proposal R14102628432 is not listed in Reliance's Pending Quotes/);
  assert.deepEqual(p.clicked, [], "no checkbox, no declaration, no Pay — never 'the first one'");
  assert.equal(r.pendingQuotesUrl, ORIGIN + fb.PENDING_QUOTES_PATH, "the page it looked at is reported");
});

test("the row text finds the proposal when the checkbox has no onclick naming it", async () => {
  const p = makePortal();
  for (const b of p.boxes) b.attrs.onclick = "return false;";
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, true);
  assert.deepEqual(p.boxes.filter((b) => b.checked).map((b) => b.proposal), [OURS]);
});

test("a TP declaration that is already ticked is left ticked (a click would untick it)", async () => {
  const p = makePortal({ declarationTicked: true });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, true);
  assert.equal(p.declaration.checked, true);
  assert.deepEqual(p.clicked, [`checkbox ${OURS}`, "Paymentbtn"], "the declaration was not clicked");
});

test("Reliance refuses Pay with an alert: its words are kept, the alert is dismissed, nothing is saved as a payment page", async () => {
  const p = makePortal({ pay: "alert" });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, false);
  assert.equal(r.paymentUrl, null);
  assert.equal(r.blockedBy, "KYC is not completed for this proposal");
  assert.match(r.reason, /Reliance did not open the payment page - it said "KYC is not completed for this proposal"/);
  assert.equal(p.alertsAccepted, 1);
});

test("Reliance refuses Pay with a dialog: its words are kept", async () => {
  const p = makePortal({ pay: "dialog" });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, false);
  assert.equal(r.blockedBy, "Please complete KYC before payment");
});

test("a payment panel that opens without a new address still counts — the page is where payment is made", async () => {
  const p = makePortal({ pay: "panel" });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, true);
  assert.equal(r.paymentUrl, ORIGIN + fb.PENDING_QUOTES_PATH);
});

test("Pay pressed and nothing changes: not reached, and it says so", async () => {
  const p = makePortal({ pay: "nothing" });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, false);
  assert.equal(r.paymentUrl, null);
  assert.match(r.reason, /Pay was pressed but the payment page did not open/);
});

test("no proposal number: nothing is touched, not even the tabs", async () => {
  const p = makePortal();
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: "", kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, false);
  assert.match(r.reason, /no proposal number/);
  assert.deepEqual(p.closed, []);
  assert.deepEqual(p.gets, []);
  assert.deepEqual(p.clicked, []);
});

test("one tab only: nothing is closed; an unknown second tab is switched away from, never closed", async () => {
  const single = makePortal();
  single.order = ["main"];
  single.current = "main";
  delete single.windows.kyc;
  const r1 = await quiet(() => fb.reachPaymentPage(single.driver, { proposalNumber: OURS, kycWindowHandle: null, ...single.opts }));
  assert.equal(r1.reached, true);
  assert.deepEqual(single.closed, []);

  const unknown = makePortal();
  const r2 = await quiet(() => fb.reachPaymentPage(unknown.driver, { proposalNumber: OURS, kycWindowHandle: null, ...unknown.opts }));
  assert.equal(r2.reached, true);
  assert.deepEqual(unknown.closed, [], "a tab that is not known to be the KYC tab is not closed");
  assert.equal(unknown.current, "main");
});

test("when the direct address does not show Pending Quotes, the menu link is used", async () => {
  const p = makePortal({ noPendingMarker: true });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(p.gets.length, 2);
  assert.match(p.gets[1], /\/Payment\/Payments\?menu=1$/);
  assert.equal(r.reached, true);
});

test("never throws: a driver that fails comes back as 'not reached' with the reason", async () => {
  const p = makePortal({ getThrows: true });
  const r = await quiet(() => fb.reachPaymentPage(p.driver, { proposalNumber: OURS, kycWindowHandle: "kyc", ...p.opts }));
  assert.equal(r.reached, false);
  assert.match(r.reason, /could not be reached \(net::ERR_CONNECTION_RESET\)/);

  const dead = { getAllWindowHandles: async () => { throw new Error("chrome not reachable"); } };
  const r2 = await quiet(() => fb.reachPaymentPage(dead, { proposalNumber: OURS, sleep: async () => {} }));
  assert.equal(r2.reached, false);
  assert.match(r2.reason, /chrome not reachable/);
});

test("it never goes near the payment-link / wallet controls of the success path", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceKycFallback.js"), "utf8");
  const code = source.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const forbidden of ["Send Payment Link", "SendMail", "k-dropdown-wrap", "shouldHoldForWallet", "createBriskCertificate"]) {
    assert.equal(code.includes(forbidden), false, `${forbidden} must not appear in the fallback`);
  }
});

/* -------------------------------------------------------------------------- */
/* The screenshots                                                            */
/* -------------------------------------------------------------------------- */

function fakeBucket({ failFor = null } = {}) {
  const uploaded = [];
  return {
    uploaded,
    upload: async (base64, key) => {
      if (failFor && key.includes(failFor)) throw new Error("S3 down");
      uploaded.push({ base64, key });
      return `https://bucket.test/${key}`;
    },
  };
}

test("shot keeper: an error is captured at once, uploaded only on flush, and the toast shot is the one to show", async () => {
  const bucket = fakeBucket();
  let n = 0;
  const keeper = fb.createKycShotKeeper({
    takeScreenshot: async () => `PNG${++n}`,
    upload: bucket.upload,
    makeKey: (label) => `screenshots/kyc/${label}/job/attempt_1/x.png`,
  });
  await keeper.noteError("Please upload valid OVD file only.");
  await keeper.noteError("Please upload valid OVD file only."); // the same text again: not a new error
  assert.equal(keeper.count(), 1);
  assert.equal(bucket.uploaded.length, 0, "nothing is uploaded while the KYC may still succeed");

  await keeper.capturePage(); // a toast shot exists: no page shot
  assert.equal(keeper.count(), 1);

  const out = await keeper.flush();
  assert.equal(bucket.uploaded.length, 1);
  assert.equal(bucket.uploaded[0].base64, "PNG1");
  assert.equal(out.key, "screenshots/kyc/toast/job/attempt_1/x.png");
  assert.equal(out.url, "https://bucket.test/screenshots/kyc/toast/job/attempt_1/x.png");
  assert.equal((await keeper.flush()).url, out.url, "a second flush uploads nothing again");
  assert.equal(bucket.uploaded.length, 1);
});

test("shot keeper: no toast -> a page shot; at most two images; a failing screenshot or upload is never fatal", async () => {
  const bucket = fakeBucket();
  const keeper = fb.createKycShotKeeper({
    takeScreenshot: async () => "PNG",
    upload: bucket.upload,
    makeKey: (label) => `k/${label}`,
  });
  await keeper.capturePage();
  assert.equal(keeper.count(), 1);
  await keeper.capturePage();
  assert.equal(keeper.count(), 1, "one page shot is enough");

  const many = fb.createKycShotKeeper({ takeScreenshot: async () => "PNG", upload: bucket.upload, makeKey: (l) => `m/${l}` });
  for (const text of ["a", "b", "c", "d"]) await many.noteError(text);
  assert.equal(many.count(), 2, "at most 2 images per failed KYC");

  const broken = fb.createKycShotKeeper({
    takeScreenshot: async () => {
      throw new Error("no such window");
    },
    upload: bucket.upload,
    makeKey: (l) => l,
  });
  await broken.noteError("x");
  await broken.capturePage();
  assert.equal(broken.count(), 0);
  assert.deepEqual(await broken.flush(), { url: null, key: null, shots: [] });

  const s3Down = fakeBucket({ failFor: "toast" });
  const noUpload = fb.createKycShotKeeper({ takeScreenshot: async () => "PNG", upload: s3Down.upload, makeKey: (l) => `k/${l}` });
  await noUpload.noteError("boom");
  const out = await quiet(() => noUpload.flush());
  assert.equal(out.url, null);
  assert.equal(out.shots[0].error, "S3 down");
});

/* -------------------------------------------------------------------------- */
/* Saving the links                                                           */
/* -------------------------------------------------------------------------- */

function fakeMongo({ existing = {}, matched = 1, connectError = null } = {}) {
  const log = { constructed: 0, connected: 0, closed: 0, updates: [], finds: [] };
  class FakeClient {
    constructor() {
      log.constructed++;
    }
    async connect() {
      log.connected++;
      if (connectError) throw connectError;
    }
    db() {
      return {
        collection: (name) => ({
          async findOne(filter, options) {
            log.finds.push({ name, filter, options });
            return existing;
          },
          async updateOne(filter, update) {
            log.updates.push({ name, filter, update });
            return { matchedCount: matched };
          },
        }),
      };
    }
    async close() {
      log.closed++;
    }
  }
  return { FakeClient, log };
}

test("saveProcessLinks: writes only what was captured, on the policy, with the raw driver", async () => {
  const { FakeClient, log } = fakeMongo();
  const out = await quiet(() =>
    fb.saveProcessLinks({ proposalLink: `${ORIGIN}/Policy/ViewPolicy`, paymentLink: PAYMENT_URL }, { _id: "p1" }, "job1", {
      MongoClient: FakeClient,
    })
  );
  assert.deepEqual(out.saved, { proposalLink: `${ORIGIN}/Policy/ViewPolicy`, paymentLink: PAYMENT_URL });
  assert.equal(log.updates.length, 1);
  assert.equal(log.updates[0].name, "onlinePolicy");
  assert.deepEqual(log.updates[0].filter, { _id: "p1" });
  assert.equal(log.updates[0].update.$set.paymentLink, PAYMENT_URL);
  assert.ok(log.updates[0].update.$set.updatedAt instanceof Date);
  assert.equal(log.closed, 1);

  const onlyProposal = fakeMongo();
  const out2 = await quiet(() =>
    fb.saveProcessLinks({ proposalLink: MAIN_URL, paymentLink: null }, { _id: "p1" }, "job1", { MongoClient: onlyProposal.FakeClient })
  );
  assert.deepEqual(out2.saved, { proposalLink: MAIN_URL });
  assert.equal("paymentLink" in onlyProposal.log.updates[0].update.$set, false, "an empty link never overwrites a good one");
});

test("saveProcessLinks: another website's link on the policy is never replaced; the same website's is", async () => {
  const kshema = fakeMongo({ existing: { paymentLink: "https://rzp.io/l/abc123" } });
  const out = await quiet(() =>
    fb.saveProcessLinks({ proposalLink: MAIN_URL, paymentLink: PAYMENT_URL }, { _id: "p1" }, "job1", { MongoClient: kshema.FakeClient })
  );
  assert.deepEqual(out.saved, { proposalLink: MAIN_URL }, "the KSHEMA customer link stays");
  assert.match(out.skipped.paymentLink, /already has a paymentLink on rzp\.io/);
  assert.equal("paymentLink" in kshema.log.updates[0].update.$set, false);

  const sameSite = fakeMongo({ existing: { paymentLink: `${ORIGIN}/Payment/MakePayment?token=old` } });
  const out2 = await quiet(() =>
    fb.saveProcessLinks({ paymentLink: PAYMENT_URL }, { _id: "p1" }, "job1", { MongoClient: sameSite.FakeClient })
  );
  assert.deepEqual(out2.saved, { paymentLink: PAYMENT_URL }, "a re-run's new proposal replaces its own old link");
});

test("saveProcessLinks: nothing to save / no policy id -> the database is not even contacted; failures never throw", async () => {
  const none = fakeMongo();
  assert.deepEqual(await fb.saveProcessLinks({}, { _id: "p1" }, "j", { MongoClient: none.FakeClient }), { saved: {}, skipped: {} });
  assert.equal(none.log.constructed, 0);

  const noId = fakeMongo();
  const out = await quiet(() => fb.saveProcessLinks({ paymentLink: PAYMENT_URL }, {}, "j", { MongoClient: noId.FakeClient }));
  assert.deepEqual(out.saved, {});
  assert.equal(noId.log.constructed, 0);

  const down = fakeMongo({ connectError: new Error("connection refused") });
  const out2 = await quiet(() => fb.saveProcessLinks({ paymentLink: PAYMENT_URL }, { _id: "p1" }, "j", { MongoClient: down.FakeClient }));
  assert.deepEqual(out2.saved, {});
  assert.equal(down.log.closed, 1);

  const gone = fakeMongo({ matched: 0 });
  const out3 = await quiet(() => fb.saveProcessLinks({ paymentLink: PAYMENT_URL }, { _id: "p1" }, "j", { MongoClient: gone.FakeClient }));
  assert.deepEqual(out3.saved, {}, "a policy that matched nothing is not reported as saved");
});

test("clearStaleProcessLinks: an earlier attempt's pages on the Reliance website go; another website's link stays", async () => {
  const both = fakeMongo({
    existing: { proposalLink: `${ORIGIN}/Policy/ViewPolicy`, paymentLink: `${ORIGIN}/Payment/MakePayment?token=old` },
  });
  const out = await quiet(() =>
    fb.clearStaleProcessLinks({ portalUrl: MAIN_URL }, { _id: "p1" }, "job1", { MongoClient: both.FakeClient })
  );
  assert.deepEqual(out.cleared.sort(), ["paymentLink", "proposalLink"]);
  assert.deepEqual(both.log.updates[0].update.$unset, { proposalLink: "", paymentLink: "" });
  assert.equal(both.log.closed, 1);

  const kshema = fakeMongo({ existing: { paymentLink: "https://rzp.io/l/abc123", proposalLink: `${ORIGIN}/Policy/ViewPolicy` } });
  const out2 = await quiet(() =>
    fb.clearStaleProcessLinks({ portalUrl: MAIN_URL }, { _id: "p1" }, "job1", { MongoClient: kshema.FakeClient })
  );
  assert.deepEqual(out2.cleared, ["proposalLink"], "the KSHEMA customer link is left alone");
  assert.deepEqual(kshema.log.updates[0].update.$unset, { proposalLink: "" });

  const clean = fakeMongo({ existing: {} });
  assert.deepEqual((await fb.clearStaleProcessLinks({ portalUrl: MAIN_URL }, { _id: "p1" }, "j", { MongoClient: clean.FakeClient })).cleared, []);
  assert.equal(clean.log.updates.length, 0, "nothing to clear -> no write");
});

test("clearStaleProcessLinks: no portal address / no policy id -> the database is not contacted; a failure never throws", async () => {
  const none = fakeMongo();
  assert.deepEqual((await fb.clearStaleProcessLinks({ portalUrl: null }, { _id: "p1" }, "j", { MongoClient: none.FakeClient })).cleared, []);
  assert.deepEqual((await fb.clearStaleProcessLinks({ portalUrl: MAIN_URL }, {}, "j", { MongoClient: none.FakeClient })).cleared, []);
  assert.equal(none.log.constructed, 0);

  const down = fakeMongo({ connectError: new Error("connection refused") });
  const out = await quiet(() =>
    fb.clearStaleProcessLinks({ portalUrl: MAIN_URL }, { _id: "p1" }, "j", { MongoClient: down.FakeClient })
  );
  assert.deepEqual(out.cleared, []);
  assert.equal(down.log.closed, 1);
});

/* -------------------------------------------------------------------------- */
/* Saving the page the run is on (the success path)                           */
/* -------------------------------------------------------------------------- */

const PENDING_URL = ORIGIN + fb.PENDING_QUOTES_PATH;

test("saveCurrentPageLink: the address of the page the driver is on is saved as that link", async () => {
  const { FakeClient, log } = fakeMongo();
  const driver = { getCurrentUrl: async () => PENDING_URL };
  const out = await quiet(() =>
    fb.saveCurrentPageLink(driver, "proposalLink", { _id: "p1" }, "job1", { MongoClient: FakeClient })
  );
  assert.deepEqual(out, { url: PENDING_URL, saved: true, skipped: "" });
  assert.equal(log.updates.length, 1);
  assert.equal(log.updates[0].update.$set.proposalLink, PENDING_URL);
  assert.equal("paymentLink" in log.updates[0].update.$set, false);
});

test("saveCurrentPageLink: a Pay page that is the same page as the Proposal Page is not saved twice", async () => {
  const { FakeClient, log } = fakeMongo();
  const driver = { getCurrentUrl: async () => PENDING_URL };
  const out = await quiet(() =>
    fb.saveCurrentPageLink(driver, "paymentLink", { _id: "p1" }, "job1", { notSameAs: PENDING_URL, MongoClient: FakeClient })
  );
  assert.equal(out.saved, false);
  assert.match(out.skipped, /same page as the Proposal Page/);
  assert.equal(log.constructed, 0, "nothing was even written");

  const other = { getCurrentUrl: async () => PAYMENT_URL };
  const out2 = await quiet(() =>
    fb.saveCurrentPageLink(other, "paymentLink", { _id: "p1" }, "job1", { notSameAs: PENDING_URL, MongoClient: FakeClient })
  );
  assert.equal(out2.saved, true);
  assert.equal(log.updates[0].update.$set.paymentLink, PAYMENT_URL);
});

test("saveCurrentPageLink: a login page (lost session), a non-address and an unreadable page save nothing and never throw", async () => {
  const { FakeClient, log } = fakeMongo();
  const reject = /\/(Login|Logout)\b/i;
  for (const [url, why] of [
    [`${ORIGIN}/Login/IMDLogin`, /not the page meant/],
    ["about:blank", /not a web address/],
    ["", /not a web address/],
  ]) {
    const out = await quiet(() =>
      fb.saveCurrentPageLink({ getCurrentUrl: async () => url }, "proposalLink", { _id: "p1" }, "job1", { reject, MongoClient: FakeClient })
    );
    assert.equal(out.saved, false, url);
    assert.match(out.skipped, why, url);
  }
  const dead = {
    getCurrentUrl: async () => {
      throw new Error("no such window: target window already closed");
    },
  };
  const out = await quiet(() => fb.saveCurrentPageLink(dead, "proposalLink", { _id: "p1" }, "job1", { MongoClient: FakeClient }));
  assert.equal(out.saved, false);
  assert.match(out.skipped, /could not be read \(no such window/);
  assert.equal(log.constructed, 0);
});

test("saveCurrentPageLink: another website's link on the policy stays (the host guard of saveProcessLinks applies)", async () => {
  const { FakeClient, log } = fakeMongo({ existing: { paymentLink: "https://rzp.io/l/abc123" } });
  const out = await quiet(() =>
    fb.saveCurrentPageLink({ getCurrentUrl: async () => PAYMENT_URL }, "paymentLink", { _id: "p1" }, "job1", { MongoClient: FakeClient })
  );
  assert.equal(out.saved, false);
  assert.match(out.skipped, /already has a paymentLink on rzp\.io/);
  assert.equal(log.updates.length, 0);
});

test("the process-links switch is ON unless explicitly false / 0 / no / off", () => {
  const withSwitch = (value, fn) => {
    const before = process.env.RELIANCE_PROCESS_LINKS_ENABLED;
    if (value === undefined) delete process.env.RELIANCE_PROCESS_LINKS_ENABLED;
    else process.env.RELIANCE_PROCESS_LINKS_ENABLED = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.RELIANCE_PROCESS_LINKS_ENABLED;
      else process.env.RELIANCE_PROCESS_LINKS_ENABLED = before;
    }
  };
  withSwitch(undefined, () => assert.equal(kyc.isProcessLinksEnabled(), true));
  for (const on of ["true", "1", "yes", "on", ""]) withSwitch(on, () => assert.equal(kyc.isProcessLinksEnabled(), true, on));
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) withSwitch(off, () => assert.equal(kyc.isProcessLinksEnabled(), false, off));
});

/* -------------------------------------------------------------------------- */
/* The whole fallback                                                         */
/* -------------------------------------------------------------------------- */

const TOAST = "Please upload valid OVD file only.";

function rescueDeps({ payment, saveLinksResult = null } = {}) {
  const calls = { reach: [], links: [], status: [] };
  return {
    calls,
    deps: {
      reach: async (driver, opts) => {
        calls.reach.push(opts);
        return payment;
      },
      saveLinks: async (links, data, jobId) => {
        calls.links.push(links);
        if (saveLinksResult) return saveLinksResult;
        const saved = {};
        if (links.proposalLink) saved.proposalLink = links.proposalLink;
        if (links.paymentLink) saved.paymentLink = links.paymentLink;
        return { saved, skipped: {} };
      },
      saveStatus: async (status) => {
        calls.status.push(status);
        return true;
      },
    },
  };
}

const portalRefusal = () =>
  Object.assign(
    new kyc.PortalRejectedError(
      kyc.kycStuckMessage({ step: "submit", state: "rejected", text: TOAST, waitedMs: 41000, brief: true }),
      { stage: "kyc-submit", portalText: TOAST }
    )
  );

test("rescue: a portal refusal -> the toast shot, both links saved, one sentence that says what was and was not done", async () => {
  const bucket = fakeBucket();
  const keeper = fb.createKycShotKeeper({
    takeScreenshot: async () => "PNG",
    upload: bucket.upload,
    makeKey: (l) => `screenshots/kyc/${l}/job/attempt_1/t.png`,
  });
  await keeper.noteError(TOAST);
  const { calls, deps } = rescueDeps({ payment: { reached: true, paymentUrl: PAYMENT_URL, steps: [] } });
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({
      driver: {},
      data: { _id: "p1" },
      jobId: "job1",
      error: portalRefusal(),
      proposalNumber: OURS,
      proposalPageUrl: MAIN_URL,
      kycWindowHandle: "kyc",
      shots: keeper,
      deps,
    })
  );

  assert.deepEqual(calls.reach[0].proposalNumber, OURS);
  assert.equal(calls.reach[0].kycWindowHandle, "kyc");
  assert.deepEqual(calls.links, [{ proposalLink: MAIN_URL, paymentLink: PAYMENT_URL }]);
  assert.deepEqual(calls.status, [], "a refusal already wrote its own note");
  assert.equal(out.screenshotUrl, "https://bucket.test/screenshots/kyc/toast/job/attempt_1/t.png");
  assert.equal(out.screenshotKey, "screenshots/kyc/toast/job/attempt_1/t.png");

  assert.match(out.message, /Reliance did not accept the Aadhaar document uploaded for KYC/);
  assert.ok(out.message.includes(`"${TOAST}"`), "the portal's words, verbatim");
  assert.match(out.message, /The proposal R14102628432 is saved at Reliance and its KYC is not complete/);
  assert.match(out.message, /The Proposal Page and Make Payment Page links are saved on the policy/);
  assert.match(out.message, /Nothing was paid and no payment link was sent to the customer/);
  assert.match(out.message, /Upload the Aadhaar by hand on the Document Upload Page, then pay from the Make Payment Page/);
  const outside = out.message.replace(/"[^"]*"/g, "");
  assert.ok(!outside.includes(":"), `no colon outside the portal's words: ${out.message}`);
  assert.equal(beautifyError(out.message, "Reliance"), `[Reliance] ${out.message}`, "survives beautifyError unchopped");
});

test("rescue: a failure that is not a refusal gets its own note and a sentence without a made-up portal quote", async () => {
  const { calls, deps } = rescueDeps({ payment: { reached: true, paymentUrl: PAYMENT_URL, steps: [] } });
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({
      driver: {},
      data: { _id: "p1" },
      jobId: "job1",
      error: new fb.KycIncompleteError("KYC did not complete - no Aadhaar", { reason: "No Aadhaar document was found on the policy" }),
      proposalNumber: OURS,
      proposalPageUrl: MAIN_URL,
      shots: null,
      deps,
    })
  );
  assert.deepEqual(calls.status, ["KYC did not complete - No Aadhaar document was found on the policy"]);
  assert.match(out.message, /^The KYC could not be completed - No Aadhaar document was found on the policy\./);
  assert.equal(out.screenshotUrl, null, "no picture, no screenshot fields");
  assert.equal(out.screenshotKey, null);
  assert.match(out.message, /The Proposal Page and Make Payment Page links are saved on the policy/);
});

test("rescue: the Proposal Page is the Pending Quotes page that was reached (the page KYC started from is only the stand-in)", async () => {
  const { calls, deps } = rescueDeps({
    payment: { reached: true, paymentUrl: PAYMENT_URL, pendingQuotesUrl: PENDING_URL, steps: [] },
  });
  await quiet(() =>
    fb.rescueAfterKycFailure({ driver: {}, data: { _id: "p1" }, error: portalRefusal(), proposalNumber: OURS, proposalPageUrl: MAIN_URL, deps })
  );
  assert.deepEqual(calls.links, [{ proposalLink: PENDING_URL, paymentLink: PAYMENT_URL }]);
});

test("rescue: Pay that opened its step on the Pending Quotes page itself saves one link, and the sentence says so", async () => {
  const { calls, deps } = rescueDeps({
    payment: { reached: true, paymentUrl: PENDING_URL, pendingQuotesUrl: PENDING_URL, steps: [] },
  });
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({ driver: {}, data: { _id: "p1" }, error: portalRefusal(), proposalNumber: OURS, deps })
  );
  assert.deepEqual(calls.links, [{ proposalLink: PENDING_URL, paymentLink: null }]);
  assert.match(out.message, /Pay opened the payment step on the Pending Quotes page, and that page is saved as the Proposal Page link/);
  assert.match(out.message, /then pay from the Proposal Page/);
  assert.doesNotMatch(out.message, /Make Payment Page link/);
});

test("rescue: Reliance refuses the payment page -> its words, only the proposal page is saved, nothing claimed about payment", async () => {
  const { calls, deps } = rescueDeps({
    payment: { reached: false, paymentUrl: null, blockedBy: "KYC is not completed for this proposal", reason: "x", steps: [] },
  });
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({
      driver: {},
      data: { _id: "p1" },
      jobId: "job1",
      error: portalRefusal(),
      proposalNumber: OURS,
      proposalPageUrl: MAIN_URL,
      deps,
    })
  );
  assert.deepEqual(calls.links, [{ proposalLink: MAIN_URL, paymentLink: null }]);
  assert.match(out.message, /Reliance did not open its payment page - it said "KYC is not completed for this proposal"/);
  assert.match(out.message, /The Proposal Page link is saved on the policy/);
  assert.doesNotMatch(out.message, /Make Payment Page link is saved/);
  assert.match(out.message, /then pay from Reliance's Pending Quotes/);
});

test("rescue: proposal not in Pending Quotes / page not reached -> says so, still ends cleanly", async () => {
  const { deps } = rescueDeps({
    payment: { reached: false, paymentUrl: null, blockedBy: "", reason: "proposal R14102628432 is not listed in Reliance's Pending Quotes", steps: [] },
  });
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({ driver: {}, data: { _id: "p1" }, error: portalRefusal(), proposalNumber: OURS, proposalPageUrl: MAIN_URL, deps })
  );
  assert.match(out.message, /The payment page could not be reached \(proposal R14102628432 is not listed in Reliance's Pending Quotes\)/);
  assert.match(out.message, /so no payment page link was saved/);
});

test("rescue: the picture is taken BEFORE the page is left, and is uploading while the payment page is being reached", async () => {
  const order = [];
  const keeper = fb.createKycShotKeeper({
    takeScreenshot: async () => {
      order.push("shot");
      return "PNG";
    },
    upload: async (base64, key) => {
      order.push("upload");
      return `https://bucket.test/${key}`;
    },
    makeKey: (label) => `k/${label}`,
  });
  const deps = {
    reach: async () => {
      order.push("reach");
      return { reached: false, paymentUrl: null, reason: "x", blockedBy: "", steps: [] };
    },
    saveLinks: async () => ({ saved: {}, skipped: {} }),
    saveStatus: async () => true,
  };
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({ driver: {}, data: { _id: "p1" }, error: new Error("no answer"), proposalNumber: OURS, shots: keeper, deps })
  );
  assert.deepEqual(order, ["shot", "upload", "reach"]);
  assert.equal(out.screenshotKey, "k/page", "no toast was caught: the page shot is the one reported");
});

test("rescue: never throws, whatever fails inside", async () => {
  const bucket = fakeBucket();
  const keeper = fb.createKycShotKeeper({ takeScreenshot: async () => "PNG", upload: bucket.upload, makeKey: (l) => l });
  const out = await quiet(() =>
    fb.rescueAfterKycFailure({
      driver: {},
      data: { _id: "p1" },
      error: new Error("boom"),
      proposalNumber: OURS,
      shots: keeper,
      deps: {
        reach: async () => {
          throw new Error("driver died");
        },
        saveLinks: async () => {
          throw new Error("mongo down");
        },
        saveStatus: async () => {
          throw new Error("mongo down");
        },
      },
    })
  );
  assert.match(out.message, /^The KYC could not be completed - boom\./);
  assert.match(out.message, /payment page could not be reached \(driver died\)/);
});

/* -------------------------------------------------------------------------- */
/* The messages and the switch                                                */
/* -------------------------------------------------------------------------- */

test("the brief forms stop where the portal's part ends — the fallback adds the rest; the long forms are unchanged", () => {
  const long = kyc.kycStuckMessage({ step: "submit", state: "rejected", text: TOAST, waitedMs: 1000, proposalNumber: OURS, file: "a.jpg" });
  const brief = kyc.kycStuckMessage({ step: "submit", state: "rejected", text: TOAST, waitedMs: 1000, proposalNumber: OURS, file: "a.jpg", brief: true });
  assert.ok(long.startsWith(brief), "the brief form is the beginning of the long one");
  assert.doesNotMatch(brief, /nothing was paid|run the policy again|is saved at Reliance/);
  assert.match(long, /run the policy again/);

  const doc = { inspected: { ok: false, kind: "xml", size: 387, s3: { code: "AccessDenied", message: "Request has expired" } }, fileName: "a.pdf" };
  assert.match(kyc.kycDocumentMessage({ ...doc, brief: true }), /^The Aadhaar document \(a\.pdf\) could not be downloaded from storage[\s\S]*Nothing was uploaded to Reliance\.$/);
  assert.match(kyc.kycDocumentMessage(doc), /Run the policy again/);

  assert.equal(kyc.kycGenericReasonText("[E302] Wait timed out: no el"), "KYC did not complete - Wait timed out - no el");
  assert.equal(kyc.kycGenericReasonText(""), "KYC did not complete");
});

test("the switch is ON unless explicitly false / 0 / no / off", () => {
  const withSwitch = (value, fn) => {
    const before = process.env.RELIANCE_KYC_FALLBACK_ENABLED;
    if (value === undefined) delete process.env.RELIANCE_KYC_FALLBACK_ENABLED;
    else process.env.RELIANCE_KYC_FALLBACK_ENABLED = value;
    try {
      return fn();
    } finally {
      if (before === undefined) delete process.env.RELIANCE_KYC_FALLBACK_ENABLED;
      else process.env.RELIANCE_KYC_FALLBACK_ENABLED = before;
    }
  };
  withSwitch(undefined, () => assert.equal(kyc.isKycFallbackEnabled(), true));
  for (const on of ["true", "1", "yes", "on", ""]) withSwitch(on, () => assert.equal(kyc.isKycFallbackEnabled(), true, on));
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) withSwitch(off, () => assert.equal(kyc.isKycFallbackEnabled(), false, off));
});

/* -------------------------------------------------------------------------- */
/* The waits report a new error the moment it is seen                         */
/* -------------------------------------------------------------------------- */

function scripted(timeline, initial) {
  let t = 0;
  let state = initial;
  const steps = [...timeline].sort((a, b) => a.at - b.at);
  return {
    driver: {
      async executeScript() {
        while (steps.length && steps[0].at <= t) state = { ...state, ...steps.shift().set };
        return state;
      },
    },
    opts: { now: () => t, sleep: async (ms) => (t += ms) },
    time: () => t,
  };
}
const btn = (over = {}) => ({ exists: true, shown: false, enabled: true, ...over });
const page = (over = {}) => ({ submit: btn(), proceed: btn(), errors: [], ...over });

test("onNewError: called once per NEW text, awaited before the wait goes on, with the text; a callback that throws is ignored", async () => {
  const seen = [];
  const s = scripted(
    [
      { at: 1000, set: { errors: ["first toast"] } },
      { at: 4000, set: { errors: [] } },
      { at: 6000, set: { errors: ["second toast"] } },
    ],
    page()
  );
  const r = await kyc.waitForKycSubmitReady(s.driver, {
    ...s.opts,
    errorStableMs: 30000,
    timeoutMs: 20000,
    onNewError: async (text) => {
      seen.push([text, s.time()]);
      throw new Error("a screenshot callback that fails");
    },
  });
  assert.equal(r.state, "timeout");
  assert.deepEqual(seen.map((x) => x[0]), ["first toast", "second toast"]);
  assert.ok(seen[0][1] >= 1000 && seen[0][1] < 2000, `seen at the first read after it appeared (${seen[0][1]} ms)`);
  assert.equal(r.text, "second toast");
});

test("onNewError: not called for text the page already showed before the upload, nor for a seeded text", async () => {
  const seen = [];
  const s = scripted([{ at: 2000, set: { submit: btn({ shown: true }) } }], page({ errors: ["permanent hint"] }));
  const r = await kyc.waitForKycSubmitReady(s.driver, {
    ...s.opts,
    ignoreErrors: ["permanent hint"],
    onNewError: (t) => seen.push(t),
  });
  assert.equal(r.state, "ready");
  assert.deepEqual(seen, []);

  const s2 = scripted([], page());
  await kyc.waitForKycSubmitReady(s2.driver, { ...s2.opts, seenText: "from the upload step", errorStableMs: 5000, onNewError: (t) => seen.push(t) });
  assert.deepEqual(seen, [], "a seeded text is not a new error");
});

test("onNewError: the same hook works in the slot wait (document upload)", async () => {
  const up = require("../fullPolicycompany/relianceKycUpload");
  const seen = [];
  let t = 0;
  const driver = {
    async executeScript(fn) {
      // slotFileInPage -> not taken yet; dropzoneStateInPage never asked (file === false); readKycPageInPage -> a toast
      if (fn === up.slotFileInPage) return false;
      return { submit: btn(), proceed: btn(), errors: ["Please upload valid OVD file only."] };
    },
  };
  const r = await up.waitForSlotAccepted(driver, "identity", {
    now: () => t,
    sleep: async (ms) => (t += ms),
    errorStableMs: 3000,
    onNewError: (text) => seen.push(text),
  });
  assert.equal(r.state, "rejected");
  assert.deepEqual(seen, ["Please upload valid OVD file only."]);
});

/* -------------------------------------------------------------------------- */
/* relianceForm.js uses it in the right places                                */
/* -------------------------------------------------------------------------- */

const formSrc = fs.readFileSync(path.join(__dirname, "..", "fullPolicycompany", "relianceForm.js"), "utf8");
const at = (needle, from = 0) => {
  const i = formSrc.indexOf(needle, from);
  assert.ok(i >= 0, `missing in relianceForm.js: ${needle}`);
  return i;
};

test("relianceForm.js: the flags are declared before the flow, set in order, and the screenshots are kept for the KYC step", () => {
  const declared = at("let kycStarted = false;");
  const accepted = at("let kycAccepted = false;", declared);
  const handle = at("let kycWindowHandle = null; // the KYC tab", accepted);
  const tryStart = at("// === STEP 0: Open this job's own browser window ===");
  assert.ok(declared < accepted && accepted < handle && handle < tryStart, "declared at the top of the function");

  const started = at("kycStarted = true;", tryStart);
  const keeper = at("createKycShotKeeper({", started);
  const proposalPage = at("kycProposalPageUrl = await driver.getCurrentUrl()", keeper);
  const stale = at("await clearStaleProcessLinks({ portalUrl: kycProposalPageUrl }, data, jobId);", proposalPage);
  const click = at('console.log("Clicking DO KYC link...");', stale);
  assert.ok(started < keeper && keeper < proposalPage && proposalPage < stale && stale < click, "kept state is prepared before DO KYC is clicked");
  assert.doesNotMatch(formSrc.slice(click, click + 120), /let kycWindowHandle/, "the tab handle is the hoisted one, not a new local");
  assert.match(formSrc.slice(started, keeper), /if \(isKycFallbackEnabled\(\)\) \{/, "the screenshots are the fallback's");
  assert.match(
    formSrc.slice(keeper, proposalPage),
    /if \(isKycFallbackEnabled\(\) \|\| isProcessLinksEnabled\(\)\) \{/,
    "the address and the clean-up serve either feature"
  );
});

test("relianceForm.js: all three waits (and the failed option) hand a new error to the screenshot keeper", () => {
  const upload = at("await uploadKycDocument(driver, slot, absoluteFilePath, {");
  assert.match(formSrc.slice(upload, upload + 500), /onNewError: noteKycError/);
  const submit = at("await waitForKycSubmitReady(driver, {");
  assert.match(formSrc.slice(submit, submit + 300), /onNewError: noteKycError/);
  const proceed = at("await waitForKycProceed(driver, {");
  assert.match(formSrc.slice(proceed, proceed + 250), /onNewError: noteKycError/);
  assert.match(formSrc, /if \(pageSaid\) await noteKycError\(pageSaid\);/);
});

test("relianceForm.js: accepted is set exactly where Reliance accepted SUBMIT; the decision sits after the KYC step", () => {
  const accepted = at("kycAccepted = true; // the KYC is done");
  const cleared = at("await saveKycStatus(null, data, jobId);", accepted);
  assert.ok(accepted < cleared);
  assert.equal(formSrc.split("kycAccepted = true;").length - 1, 2, "the accepted path and the switch-off path, nowhere else");

  const completed = at('console.log("✅ All new flow steps completed successfully!");');
  const incomplete = at("throw new KycIncompleteError(", completed);
  const oldFlow = at("// === OLD FLOW COMMENTED OUT ===", incomplete);
  assert.ok(completed < incomplete && incomplete < oldFlow);
  assert.match(formSrc.slice(incomplete - 400, incomplete), /if \(isKycFallbackEnabled\(\) && kycStarted && !kycAccepted\) \{/);
});

test("relianceForm.js: the failure catch hands a KYC that did not work to the fallback BEFORE the generic screenshot", () => {
  const catchAt = at('console.log("Error handling post-calculation elements:", err.message);');
  const rescue = at("await rescueAfterKycFailure({", catchAt);
  const generic = at('"post-calculation-error"', rescue);
  assert.ok(catchAt < rescue && rescue < generic);
  // a KYC name mismatch stops on the KYC page instead (relianceKycName.js skipsKycFallback, the owner's rule 2026-10-17)
  assert.match(formSrc.slice(catchAt, rescue), /if \(isKycFallbackEnabled\(\) && kycStarted && !kycAccepted && !skipsKycFallback\(err\)\) \{/);
  assert.match(formSrc.slice(rescue, generic), /\} else \{/, "the old handling is the else branch");
  // a stop on purpose is still thrown before any of this
  assert.match(formSrc.slice(catchAt - 120, catchAt), /if \(isAutomationStop\(err\)\) throw err;/);
  // what the result carries
  const body = formSrc.slice(rescue, generic);
  for (const needle of ["postCalculationFailed = true;", "postCalculationError = rescued.message;", "thisScreenshotUrl = rescued.screenshotUrl;", "thisScreenshotKey = rescued.screenshotKey;"]) {
    assert.ok(body.includes(needle), needle);
  }
});

test("relianceForm.js: every KYC message thrown inside the step is the brief form when the fallback adds the rest", () => {
  // every call site: from "kycStuckMessage({" to the closing of ITS argument object (balanced braces)
  const sites = [];
  for (let i = formSrc.indexOf("kycStuckMessage({"); i >= 0; i = formSrc.indexOf("kycStuckMessage({", i + 1)) {
    let depth = 0;
    let j = i + "kycStuckMessage(".length;
    for (; j < formSrc.length; j++) {
      if (formSrc[j] === "{") depth++;
      if (formSrc[j] === "}" && --depth === 0) break;
    }
    sites.push(formSrc.slice(i, j + 1));
  }
  assert.ok(sites.length >= 4, `found ${sites.length} kycStuckMessage call sites`);
  for (const site of sites) assert.match(site, /brief: isKycFallbackEnabled\(\)/, site.slice(0, 120));
  const doc = at("kycDocumentMessage({");
  assert.match(formSrc.slice(doc, doc + 300), /brief: isKycFallbackEnabled\(\)/);
});

test("relianceForm.js: the success path is untouched — the payment link flow and the wallet hold are where they were, once", () => {
  assert.equal(formSrc.split("Selecting 'Send Payment Link'...").length - 1, 1);
  assert.equal(formSrc.split("shouldHoldForWallet(data.Paymentmethod)").length - 1, 1);
  const accepted = at("kycAccepted = true; // the KYC is done");
  const pendingQuotes = at('console.log("Navigating to Pending Quotes page...");', accepted);
  const sendLink = at("Selecting 'Send Payment Link'...", pendingQuotes);
  const rescue = at("await rescueAfterKycFailure({");
  assert.ok(accepted < pendingQuotes && pendingQuotes < sendLink && sendLink < rescue);
});


test("relianceForm.js: the success path saves the Pending Quotes page on arrival and the Pay page right after Pay — behind the switch", () => {
  const onPending = at('console.log("✅ On Pending Quotes page");');
  const proposalSave = at('await saveCurrentPageLink(driver, "proposalLink", data, jobId, {', onPending);
  const checkbox = at('console.log("Looking for proposal checkbox...");', proposalSave);
  assert.ok(onPending < proposalSave && proposalSave < checkbox, "saved before the steps that can still fail");
  assert.match(formSrc.slice(onPending, proposalSave), /if \(isProcessLinksEnabled\(\)\) \{/);

  const pay = at('console.log("✅ Clicked Pay button");', checkbox);
  const paymentSave = at('await saveCurrentPageLink(driver, "paymentLink", data, jobId, {', pay);
  const linkFlow = at("// === Payment Link Flow (Conditional) ===", paymentSave);
  assert.ok(pay < paymentSave && paymentSave < linkFlow, "saved before the payment link / wallet steps");
  assert.match(formSrc.slice(pay, paymentSave), /if \(isProcessLinksEnabled\(\)\) \{/);
  assert.match(formSrc.slice(paymentSave, linkFlow), /notSameAs: pendingQuotesPageUrl/, "a Pay page that is the same page is not saved twice");

  // the wallet hold still stops where it did, after the link was saved
  const hold = at("stopper(WALLET_HOLD_MESSAGE", paymentSave);
  assert.ok(paymentSave < hold);
});
