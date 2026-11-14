// United India: Update -> the proposal (the owner, 2026-11-13). Update pressed once, the GSTIN/UIN question answered OK, the
// loader WATCHED (its start / stop said in the log); not done in 15 s -> the page refreshed (the reload + the loader stopping:
// 20 s), Update pressed again (unless the refreshed page already shows the proposal), 15 s; still not = [E302]. The Proposal
// Number / Reference Date / Transaction NO / Customer ID read and saved: the part's Proposal step completed,
// onlinePolicy.unitedIndiaProposal, and proposalNumber only when empty. A fake portal (it acts like ChromeDriver: any other
// command sent while a popup is open closes it with CANCEL) and a fake database; no Chrome.
// Run: node --require ./test/support/noRealWorld.js --test test/unitedIndiaProposal.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const prop = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaProposal");
const nav = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaNavigate");
const steps = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaSteps");
const { scrollToEndInPage } = require("../multiCompany/tpCompany/unitedIndiaTP/unitedIndiaCompute");

const GST = "GSTIN/UIN HAS NOT BEEN INSERTED. The Insured will not be able to take input credit of GST/UIN on premium on policy and endorsements. Do you want to proceed? If Yes, Click On Ok. If No, Click on Cancel to update GSTIN/UIN.";
const SHOWN = { proposalNumber: "202611131194829", transactionNo: "GC202611130155864493", referenceDate: "13/11/2026", customerId: "23676065442" };

/**
 *   asks: the popup Update opens (default the GSTIN question)
 *   tries: what each Update press does - { loaderPolls (looks the loader runs; Infinity = never stops), none (no proposal
 *          comes) }; the last one repeats
 *   shows: what the proposal block reads (default SHOWN); showsAfter: reads before it appears
 *   doneDuringRefresh: the first Update finishes while the page is refreshed (the refreshed page shows the proposal)
 *   spinsAfterRefresh: the loader keeps spinning on the refreshed page; refreshFails: the reload does not finish in time
 */
function portal(over = {}) {
  const st = { alert: null, answered: [], clicks: 0, busy: false, busyFor: 0, none: false, reads: 0, scrolled: 0, mark: null, shown: false, refreshes: 0, tryNo: 0, pageLoad: 300000, refreshLimit: null };
  const tries = over.tries || [{}];
  const meets = () => {
    if (st.alert) {
      st.answered.push("cancel");
      const t = st.alert.text;
      st.alert = null;
      throw Object.assign(new Error(`unexpected alert open: {Alert text : ${t}}`), { name: "UnexpectedAlertOpenError" });
    }
  };
  // one look at the page = one step of time for the loader
  const tick = () => {
    if (st.busy && st.busyFor !== Infinity) {
      st.busyFor -= 1;
      if (st.busyFor < 0) {
        st.busy = false;
        if (!st.none) st.shown = true; // the proposal is on the page
      }
    }
  };
  const btn = {
    async isDisplayed() {
      return true;
    },
    async click() {
      meets();
      st.clicks += 1;
      const asks = over.asks === undefined ? GST : over.asks;
      const t = tries[Math.min(st.tryNo, tries.length - 1)];
      st.tryNo += 1;
      const after = () => {
        st.busy = true;
        st.busyFor = t.loaderPolls === undefined ? 12 : t.loaderPolls;
        st.none = !!t.none;
      };
      if (asks) st.alert = { text: asks, ok: after };
      else after();
    },
  };
  return {
    st,
    async findElements(locator) {
      meets();
      return /updt|Update|'update'/.test(String((locator && locator.value) || "")) ? [btn] : [];
    },
    async executeScript(script, ...args) {
      meets();
      if (script === scrollToEndInPage) {
        st.scrolled += 1;
        return 700;
      }
      if (script === nav.markPageInPage) {
        st.mark = args[0];
        return true;
      }
      if (script === nav.pageStateInPage) {
        tick();
        return { marked: st.mark === args[0], leaving: false, ready: "complete", url: "https://uiic/risk" };
      }
      if (script === steps.portalBusyInPage) return { loader: st.busy ? "div#dialog.window" : null, cover: null, ajax: 0, ready: "complete" };
      if (typeof args[0] === "string" && args[0].includes("blockUI")) return st.busy;
      if (String(script).trim() === "return document.readyState") return "complete";
      if (script === prop.readProposalInPage) {
        const empty = { proposalNumber: "", transactionNo: "", referenceDate: "", customerId: "" };
        if (!st.shown) return empty;
        st.reads += 1;
        if (st.reads <= (over.showsAfter || 0)) return empty;
        return over.shows || SHOWN;
      }
      return null;
    },
    manage: () => ({
      getTimeouts: async () => ({ pageLoad: st.pageLoad }),
      setTimeouts: async (t) => {
        if (t && t.pageLoad) st.pageLoad = t.pageLoad;
      },
    }),
    async getAllWindowHandles() {
      meets();
      return ["main"];
    },
    navigate: () => ({
      refresh: async () => {
        st.refreshes += 1;
        st.refreshLimit = st.pageLoad;
        if (over.refreshFails) throw Object.assign(new Error("timeout: Timed out receiving message from renderer: 20.000"), { name: "TimeoutError" });
        st.mark = null;
        if (!over.spinsAfterRefresh) {
          st.busy = false;
          st.busyFor = 0;
        }
        if (over.doneDuringRefresh) st.shown = true;
      },
    }),
    switchTo() {
      return {
        alert: async () => {
          if (!st.alert) throw new Error("no such alert");
          const a = st.alert;
          return {
            getText: async () => a.text,
            accept: async () => {
              st.answered.push("ok");
              st.alert = null;
              a.ok();
            },
            dismiss: async () => {
              st.answered.push("cancel");
              st.alert = null;
            },
          };
        },
      };
    },
    async getCurrentUrl() {
      return "https://uiic/risk";
    },
    async sleep() {},
  };
}

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (_d, ms) => (t += ms), at: () => t };
};
const run = (driver, over = {}) => {
  const lines = [];
  const marked = [];
  const saved = [];
  const c = clock();
  const deps = {
    markStage: over.markStage || (async (data, stage, status, extra, opts) => (marked.push({ stage, status, extra, insurer: opts.insurer }), true)),
    saveProposal: over.saveProposal || (async (data, p) => (saved.push(p), true)),
  };
  return { lines, marked, saved, c, go: () => prop.updateAndSaveProposal(driver, { _id: "6650aa", _partKey: "tp" }, { now: c.now, sleep: c.sleep, log: (l) => lines.push(String(l)), jobId: "j1", deps }) };
};

test("Update pressed ONCE, the GSTIN question OK (never Cancel), the loader WATCHED - start and stop in the log - the proposal read and SAVED", async () => {
  const driver = portal();
  const { lines, marked, saved, go } = run(driver);
  const out = await go();
  assert.deepEqual(out, SHOWN);
  assert.equal(driver.st.scrolled, 1);
  assert.deepEqual(driver.st.answered, ["ok"]);
  assert.equal(driver.st.clicks, 1);
  assert.equal(driver.st.refreshes, 0);
  assert.deepEqual(marked, [{ stage: "proposal", status: "completed", extra: SHOWN, insurer: "United India" }]);
  assert.deepEqual(saved, [SHOWN]);
  assert.ok(lines.some((l) => /🧮 United India - "Update" pressed - watching the portal's loader \(up to 15 seconds\)/.test(l)));
  assert.ok(lines.some((l) => /⏳ United India - the portal's loader is showing \(div#dialog\.window\) [\d.]+ s after "Update"/.test(l)));
  assert.ok(lines.some((l) => /^ {3}the loader stopped [\d.]+ s after "Update"$/.test(l)));
  assert.ok(lines.some((l) => /📄 United India - proposal 202611131194829 made \(Reference Date 13\/11\/2026, Transaction GC202611130155864493, Customer ID 23676065442\)/.test(l)));
  assert.ok(lines.some((l) => /✅ United India - proposal 202611131194829 saved on the policy, Proposal step = completed/.test(l)));
});

test("the proposal block a moment after the loader: waited for", async () => {
  const driver = portal({ showsAfter: 6 });
  const { go } = run(driver);
  assert.equal((await go()).proposalNumber, "202611131194829");
  assert.equal(driver.st.refreshes, 0);
});

test("no proposal ever (the loader done, nothing on the page): refreshed ONCE, Update pressed again, then [E302] - nothing saved", async () => {
  const driver = portal({ tries: [{ none: true }] });
  const { marked, saved, lines, go } = run(driver);
  await assert.rejects(go(), (e) => {
    assert.equal(e.code, "E302");
    assert.equal(
      e.message,
      '[E302] United India - no Proposal Number came on the page 15 seconds after "Update" was pressed again (after a refresh) - a loader issue at United India, so the run stopped there. It will try again shortly.'
    );
    return true;
  });
  assert.equal(driver.st.refreshes, 1);
  assert.equal(driver.st.clicks, 2);
  assert.equal(marked.length, 0);
  assert.equal(saved.length, 0);
  assert.ok(lines.some((l) => /⟳ United India - 15 seconds after "Update" no Proposal Number came on the page - refreshing the page/.test(l)));
});

test("Update still spinning after 15 s: the page REFRESHED (under a 20 s page-load limit), Update pressed ONCE more (GSTIN OK again), the proposal saved", async () => {
  const driver = portal({ tries: [{ loaderPolls: Infinity }, { loaderPolls: 8 }] });
  const { marked, lines, c, go } = run(driver);
  const out = await go();
  assert.equal(out.proposalNumber, "202611131194829");
  assert.equal(driver.st.refreshes, 1);
  assert.equal(driver.st.clicks, 2);
  assert.deepEqual(driver.st.answered, ["ok", "ok"]);
  assert.equal(marked.length, 1);
  assert.equal(driver.st.refreshLimit, 20000, "a refresh that meets a short page-load limit is STOPPED by ChromeDriver (real Chrome, 2026-11-13)");
  assert.equal(driver.st.pageLoad, 300000, "the run's own page-load limit is back afterwards");
  assert.ok(lines.some((l) => /⟳ United India - 15 seconds after "Update" the portal's loader is still spinning - refreshing the page/.test(l)));
  assert.ok(lines.some((l) => /^ {3}the page reloaded in [\d.]+ s - watching the portal's loader$/.test(l)));
  assert.ok(lines.some((l) => /after the refresh the loader has stopped - pressing "Update" again/.test(l)));
  assert.ok(c.at() >= 15000 && c.at() < 25000, `${c.at()} ms`);
  assert.equal(prop.UPDATE_WAIT_MS, 15000);
});

test("the first Update finished WHILE the page was refreshed: its proposal is taken, Update is NOT pressed again (no second proposal)", async () => {
  const driver = portal({ tries: [{ loaderPolls: Infinity }], doneDuringRefresh: true });
  const { lines, marked, go } = run(driver);
  const out = await go();
  assert.equal(out.proposalNumber, "202611131194829");
  assert.equal(driver.st.clicks, 1, "pressed once only");
  assert.equal(marked.length, 1);
  assert.ok(lines.some((l) => /the refreshed page already shows proposal 202611131194829 - Update is NOT pressed again/.test(l)));
});

test("the loader still spinning on the refreshed page: [E302] - it did not stop within 20 seconds; Update NOT pressed again", async () => {
  const driver = portal({ tries: [{ loaderPolls: Infinity }], spinsAfterRefresh: true });
  const { saved, c, go } = run(driver);
  await assert.rejects(go(), (e) => {
    assert.equal(e.code, "E302");
    assert.equal(
      e.message,
      '[E302] United India - the portal\'s loader was still spinning 15 seconds after "Update", and after the page was refreshed its loader did not stop within 20 seconds - a loader issue at United India, so the run stopped there. It will try again shortly.'
    );
    return true;
  });
  assert.equal(driver.st.clicks, 1);
  assert.equal(saved.length, 0);
  assert.ok(c.at() >= 35000 && c.at() < 37000, `${c.at()} ms (15 + 20)`);
});

test("the refreshed page does not load within 20 s: [E302] saying so; Update NOT pressed again", async () => {
  const driver = portal({ tries: [{ loaderPolls: Infinity }], refreshFails: true });
  const { lines, go } = run(driver);
  await assert.rejects(go(), (e) => e.code === "E302" && /after "Update", and after the page was refreshed it did not load within 20 seconds - a loader issue/.test(e.message));
  assert.equal(driver.st.clicks, 1);
  assert.ok(lines.some((l) => /the refreshed page did not load within 20 seconds/.test(l)));
});

test("spinning on the second press too: [E302] - 15 seconds after it was pressed again (after a refresh)", async () => {
  const driver = portal({ tries: [{ loaderPolls: Infinity }] });
  await assert.rejects(
    run(driver).go(),
    (e) => e.code === "E302" && /^\[E302\] United India - the portal's loader was still spinning 15 seconds after "Update" was pressed again \(after a refresh\)/.test(e.message)
  );
  assert.equal(driver.st.refreshes, 1);
  assert.equal(driver.st.clicks, 2);
});

test("a popup other than the GSTIN question: Cancel, [E308] in its words", async () => {
  const driver = portal({ asks: "Please enter the Nominee details" });
  await assert.rejects(run(driver).go(), (e) => e.code === "E308" && /after "Update" the portal said "Please enter the Nominee details"/.test(e.message));
  assert.deepEqual(driver.st.answered, ["cancel"]);
});

test("a database write that fails never fails the run (the proposal exists at United India) - said in the log", async () => {
  const driver = portal();
  const { lines, go } = run(driver, {
    markStage: async () => {
      throw new Error("db down");
    },
    saveProposal: async () => {
      throw new Error("db down");
    },
  });
  const out = await go();
  assert.equal(out.proposalNumber, "202611131194829");
  assert.ok(lines.some((l) => /could not be saved on the policy \(db down\)/.test(l)));
  assert.ok(lines.some((l) => /⚠️ United India - proposal 202611131194829 was made at United India, but the Proposal step and the proposal number and date on the policy could not be saved - complete the Proposal by hand in Edit -> Status with this number/.test(l)));
});

test("proposal numbers: digits only", () => {
  assert.equal(prop.proposalNumberOf(" 202611131194829 "), "202611131194829");
  assert.equal(prop.proposalNumberOf("2026 1113 1194829"), "202611131194829");
  assert.equal(prop.proposalNumberOf("R141026119597"), "");
  assert.equal(prop.proposalNumberOf("123"), "");
});

test("the policy's fields: unitedIndiaProposal always; proposalNumber ONLY when the policy has none (Reliance OD keeps its own)", async () => {
  const writes = [];
  class FakeClient {
    async connect() {}
    async close() {}
    db() {
      return {
        collection: () => ({
          updateOne: async (filter, update) => {
            writes.push({ filter, update });
            return { matchedCount: 1 };
          },
        }),
      };
    }
  }
  const at = new Date("2026-11-13T07:00:00Z");
  const ok = await prop.defaultSaveProposal({ _id: "6650aa6650aa6650aa6650aa" }, SHOWN, { MongoClient: FakeClient, now: () => at });
  assert.equal(ok, true);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].update, { $set: { unitedIndiaProposal: { ...SHOWN, at }, updatedAt: at } });
  assert.deepEqual(writes[1].filter.$or, [{ proposalNumber: { $exists: false } }, { proposalNumber: null }, { proposalNumber: "" }]);
  assert.deepEqual(writes[1].update, { $set: { proposalNumber: "202611131194829" } });
  assert.equal(await prop.defaultSaveProposal({}, SHOWN, { MongoClient: FakeClient }), false, "no policy id: nothing written");
});

test("the owner's Update button", () => {
  assert.equal(prop.UPDATE.target[0], "#updt");
  assert.equal(prop.INSURER, "United India");
});

test("a proposal's NEW Reference Date (Modify moved it): ONLY the date written - on the step and unitedIndiaProposal, each only while it is THIS proposal; never the steps' statuses", async () => {
  const writes = [];
  class FakeClient {
    async connect() {}
    async close() {}
    db() {
      return {
        collection: () => ({
          updateOne: async (filter, update) => {
            writes.push({ filter, update });
            return { matchedCount: 1 };
          },
        }),
      };
    }
  }
  const at = new Date("2026-11-14T05:00:00Z");
  const ok = await prop.saveReferenceDate({ _id: "6650aa6650aa6650aa6650aa", _partKey: "tp" }, { proposalNumber: "202611131393359", referenceDate: "14/11/2026" }, { MongoClient: FakeClient, now: () => at });
  assert.equal(ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].filter["relianceStages.tp.proposal.proposalNumber"], "202611131393359");
  assert.deepEqual(writes[0].update, { $set: { "relianceStages.tp.proposal.referenceDate": "14/11/2026", updatedAt: at } });
  assert.equal(writes[1].filter["unitedIndiaProposal.proposalNumber"], "202611131393359");
  assert.deepEqual(writes[1].update, { $set: { "unitedIndiaProposal.referenceDate": "14/11/2026" } });
  assert.ok(!JSON.stringify(writes).includes("status"), "no step status touched (a 'proposal completed' write would put a done KYC back to pending)");
  for (const bad of [{ proposalNumber: "R1410", referenceDate: "14/11/2026" }, { proposalNumber: "202611131393359", referenceDate: "2026-11-14" }]) {
    assert.equal(await prop.saveReferenceDate({ _id: "6650aa6650aa6650aa6650aa" }, bad, { MongoClient: FakeClient }), false);
  }
  assert.equal(await prop.saveReferenceDate({}, { proposalNumber: "202611131393359", referenceDate: "14/11/2026" }, { MongoClient: FakeClient }), false, "no policy id");
  class Down extends FakeClient {
    async connect() {
      throw new Error("db down");
    }
  }
  assert.equal(await prop.saveReferenceDate({ _id: "6650aa6650aa6650aa6650aa" }, { proposalNumber: "202611131393359", referenceDate: "14/11/2026" }, { MongoClient: Down }), false, "never throws");
});

test("the proposal FRESH after Modify: number, date, transaction, customer on the step + unitedIndiaProposal; a NEW number keeps the old as previous and takes the list column - never a status", async () => {
  const writes = [];
  class FakeClient {
    async connect() {}
    async close() {}
    db() {
      return {
        collection: () => ({
          updateOne: async (filter, update) => {
            writes.push({ filter, update });
            return { matchedCount: 1 };
          },
        }),
      };
    }
  }
  const at = new Date("2026-11-14T05:00:00Z");
  const fresh = { proposalNumber: "202611141761445", referenceDate: "14/11/2026", transactionNo: "GC2026111401", customerId: "23676065442" };
  const ok = await prop.saveFreshProposal({ _id: "6650aa6650aa6650aa6650aa", _partKey: "tp" }, { was: "202611131393359", fresh }, { MongoClient: FakeClient, now: () => at });
  assert.equal(ok, true);
  assert.equal(writes.length, 3);
  assert.equal(writes[0].filter["relianceStages.tp.proposal.proposalNumber"], "202611131393359", "only while the step is still the old proposal");
  assert.deepEqual(writes[0].update.$set, {
    "relianceStages.tp.proposal.proposalNumber": "202611141761445",
    "relianceStages.tp.proposal.referenceDate": "14/11/2026",
    "relianceStages.tp.proposal.transactionNo": "GC2026111401",
    "relianceStages.tp.proposal.customerId": "23676065442",
    "relianceStages.tp.proposal.previousProposalNumber": "202611131393359",
    updatedAt: at,
  });
  assert.deepEqual(writes[1].update, { $set: { unitedIndiaProposal: { ...fresh, at, afterModify: true } } });
  assert.deepEqual(writes[2], { filter: { _id: writes[2].filter._id, proposalNumber: "202611131393359" }, update: { $set: { proposalNumber: "202611141761445" } } });
  assert.ok(!JSON.stringify(writes).includes(".status"), "no step status touched");
  // the same number: no previous, no column change
  writes.length = 0;
  await prop.saveFreshProposal({ _id: "6650aa6650aa6650aa6650aa", _partKey: "tp" }, { was: "202611141761445", fresh }, { MongoClient: FakeClient, now: () => at });
  assert.equal(writes.length, 2);
  assert.equal(writes[0].update.$set["relianceStages.tp.proposal.previousProposalNumber"], undefined);
  // the step no longer this proposal: nothing more written
  class Moved extends FakeClient {
    db() {
      return { collection: () => ({ updateOne: async (filter, update) => (writes.push({ filter, update }), { matchedCount: 0 }) }) };
    }
  }
  writes.length = 0;
  assert.equal(await prop.saveFreshProposal({ _id: "6650aa6650aa6650aa6650aa" }, { was: "202611131393359", fresh }, { MongoClient: Moved }), false);
  assert.equal(writes.length, 1);
  assert.equal(await prop.saveFreshProposal({ _id: "6650aa6650aa6650aa6650aa" }, { was: "202611131393359", fresh: { proposalNumber: "x", referenceDate: "14/11/2026" } }, { MongoClient: FakeClient }), false);
});
