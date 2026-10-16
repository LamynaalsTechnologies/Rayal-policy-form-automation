// Run with: node --require ./test/support/noRealWorld.js --test test/browserRetention.test.js
//
// A completed KSHEMA job's Chrome window stayed open and its profile folder stayed on disk (2026-10-15). Cause: the
// forms' cleanup got `null`, because runKshemaFlow was handed a callback to register the browser with and never called
// it — so cleanupKshemaJobBrowser returned at once on every path. Now it is registered, and one rule decides
// (debugRetention.shouldKeepBrowserOpen): failed / stopped -> KEEP_BROWSER_OPEN_ON_ERROR, completed ->
// CLOSE_BROWSER_AFTER_COMPLETE. No browser here: a fake driver and a temp folder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const RETENTION = path.join(ROOT, "debugRetention.js");

/** debugRetention reads its switches at load: a fresh copy for a given environment. */
function load(env) {
  const names = ["KEEP_BROWSER_OPEN_ON_ERROR", "CLOSE_BROWSER_AFTER_COMPLETE", "HEADLESS", "DISPLAY"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, { HEADLESS: "false", DISPLAY: ":99" }, env);
  delete require.cache[RETENTION];
  const mod = require(RETENTION);
  // quiet: the headless warning is expected here
  const warn = console.warn;
  console.warn = () => {};
  return {
    mod,
    restore() {
      console.warn = warn;
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
      delete require.cache[RETENTION];
    },
  };
}

const decide = (env, hadError) => {
  const { mod, restore } = load(env);
  try {
    return mod.shouldKeepBrowserOpen(hadError);
  } finally {
    restore();
  }
};

test("a completed job closes its window by default, whatever KEEP_BROWSER_OPEN_ON_ERROR says", () => {
  assert.equal(decide({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, false), false);
  assert.equal(decide({ KEEP_BROWSER_OPEN_ON_ERROR: "true", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, false), false);
});

test("CLOSE_BROWSER_AFTER_COMPLETE=false keeps a completed job's window (and only that setting does)", () => {
  assert.equal(decide({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "false" }, false), true);
  for (const off of ["0", "no", "off", "FALSE"]) {
    assert.equal(decide({ CLOSE_BROWSER_AFTER_COMPLETE: off, KEEP_BROWSER_OPEN_ON_ERROR: "false" }, false), true, off);
  }
});

test("a failed / stopped job follows KEEP_BROWSER_OPEN_ON_ERROR, not the completed-job setting", () => {
  assert.equal(decide({ KEEP_BROWSER_OPEN_ON_ERROR: "true", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, true), true);
  assert.equal(decide({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "false" }, true), false);
});

test("headless never keeps a window — there is nothing to look at, only a leaked process", () => {
  assert.equal(decide({ HEADLESS: "true", KEEP_BROWSER_OPEN_ON_ERROR: "true", CLOSE_BROWSER_AFTER_COMPLETE: "false" }, true), false);
  assert.equal(decide({ HEADLESS: "true", KEEP_BROWSER_OPEN_ON_ERROR: "true", CLOSE_BROWSER_AFTER_COMPLETE: "false" }, false), false);
});

/* ---- the KSHEMA cleanup: this job's window and this job's folder, nothing else ---- */

function jobFolder(base, name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  fs.mkdirSync(path.join(dir, "downloads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Default", "Cookies"), "x");
  return dir;
}

async function cleanupWith(env, hadError) {
  const { restore } = load(env);
  const manager = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSessionManager.js");
  delete require.cache[manager];
  const { cleanupKshemaJobBrowser } = require(manager);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kshema-retention-"));
  const mine = jobFolder(base, "kshema_job_A_1");
  const other = jobFolder(base, "kshema_job_B_2"); // another job running at the same time
  let quit = 0;
  const jobBrowser = {
    driver: { async quit() { quit += 1; } },
    profileInfo: { userDataDir: mine, fullPath: path.join(mine, "Default"), downloadDir: path.join(mine, "downloads") },
    jobId: "A",
  };
  const log = console.log;
  console.log = () => {};
  try {
    await cleanupKshemaJobBrowser(jobBrowser, { hadError });
  } finally {
    console.log = log;
    restore();
  }
  const result = { quit, mineExists: fs.existsSync(mine), otherExists: fs.existsSync(other), otherCookie: fs.existsSync(path.join(other, "Default", "Cookies")) };
  fs.rmSync(base, { recursive: true, force: true });
  return result;
}

test("completed: the browser is quit and ITS profile folder is deleted; another job's folder is untouched", async () => {
  const r = await cleanupWith({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, false);
  assert.deepEqual(r, { quit: 1, mineExists: false, otherExists: true, otherCookie: true });
});

test("completed with CLOSE_BROWSER_AFTER_COMPLETE=false: nothing is closed or deleted", async () => {
  const r = await cleanupWith({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "false" }, false);
  assert.deepEqual(r, { quit: 0, mineExists: true, otherExists: true, otherCookie: true });
});

test("failed with KEEP_BROWSER_OPEN_ON_ERROR=true is kept; with it false it is closed and deleted like any other job", async () => {
  const kept = await cleanupWith({ KEEP_BROWSER_OPEN_ON_ERROR: "true", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, true);
  assert.deepEqual(kept, { quit: 0, mineExists: true, otherExists: true, otherCookie: true });
  const closed = await cleanupWith({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, true);
  assert.deepEqual(closed, { quit: 1, mineExists: false, otherExists: true, otherCookie: true });
});

/* ---- the same rule for every company: Reliance and National close the same way ---- */

const COMPANIES = [
  {
    name: "Reliance",
    manager: path.join(ROOT, "sessionManager.js"),
    cleanup: "cleanupJobBrowser",
    profile: (base, id) => {
      const mine = jobFolder(base, `reliance_job_${id}_1`);
      const downloads = fs.mkdirSync(path.join(base, `reliance_pdf_job_${id}`), { recursive: true }) || path.join(base, `reliance_pdf_job_${id}`);
      return { userDataDir: mine, profileDirectory: "Default", fullPath: path.join(mine, "Default"), downloadDir: downloads };
    },
  },
  {
    name: "National",
    manager: path.join(ROOT, "nationalSessionManager.js"),
    cleanup: "cleanupNationalJobBrowser",
    profile: (base, id) => {
      const mine = jobFolder(base, `national_job_${id}_1`);
      return { userDataDir: mine, profileDirectory: "Default", fullPath: path.join(mine, "Default") };
    },
  },
];

async function companyCleanup(company, env, hadError) {
  const { restore } = load(env);
  delete require.cache[company.manager];
  const manager = require(company.manager);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "retention-co-"));
  const profileInfo = company.profile(base, "A");
  const other = jobFolder(base, "someone_elses_job_2"); // a parallel job's folder, and any shared profile
  let quit = 0;
  const logs = ["log", "warn", "error"].map((k) => [k, console[k]]);
  logs.forEach(([k]) => (console[k] = () => {}));
  try {
    await manager[company.cleanup]({ driver: { async quit() { quit += 1; } }, profileInfo, jobId: "A" }, { hadError });
  } finally {
    logs.forEach(([k, fn]) => (console[k] = fn));
    restore();
  }
  const result = {
    quit,
    mineExists: fs.existsSync(profileInfo.userDataDir),
    downloadsExist: profileInfo.downloadDir ? fs.existsSync(profileInfo.downloadDir) : false,
    otherIntact: fs.existsSync(path.join(other, "Default", "Cookies")),
  };
  fs.rmSync(base, { recursive: true, force: true });
  return result;
}

for (const company of COMPANIES) {
  test(`${company.name}: completed -> window closed, this job's profile (and downloads) deleted, nobody else's touched`, async () => {
    const r = await companyCleanup(company, { KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, false);
    assert.deepEqual(r, { quit: 1, mineExists: false, downloadsExist: false, otherIntact: true });
  });

  test(`${company.name}: CLOSE_BROWSER_AFTER_COMPLETE=false keeps a completed job's window and profile`, async () => {
    const r = await companyCleanup(company, { KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "false" }, false);
    assert.equal(r.quit, 0);
    assert.equal(r.mineExists, true);
    assert.equal(r.otherIntact, true);
  });

  test(`${company.name}: a failed job follows KEEP_BROWSER_OPEN_ON_ERROR`, async () => {
    const kept = await companyCleanup(company, { KEEP_BROWSER_OPEN_ON_ERROR: "true", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, true);
    assert.equal(kept.quit, 0);
    assert.equal(kept.mineExists, true);
    const closed = await companyCleanup(company, { KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" }, true);
    assert.equal(closed.quit, 1);
    assert.equal(closed.mineExists, false);
    assert.equal(closed.otherIntact, true);
  });
}

/* ---- the wiring that was missing ---- */

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshemaForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"),
]) {
  test(`${path.basename(file)}: the browser is handed to the cleanup, and only a completed policy counts as clean`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(
      src,
      /jobBrowser = await createKshemaJobBrowser\(jobId\);\s*(?:\/\/[^\n]*\n\s*)*registerBrowser\(jobBrowser\);/,
      "registerBrowser(jobBrowser) follows createKshemaJobBrowser — without it the finally cleans up `null`"
    );
    assert.match(src, /hadError = !\(outcome && outcome\.success === true\);/);
    assert.doesNotMatch(src, /outcome\.inProgress === true\s*\)/, "a stop is not treated as clean any more");
  });
}

/* ---- two policies running at the same time (parallel windows) ---- */

const jobDirs = require(path.join(ROOT, "lib", "jobDirs.js"));

test("jobDirs: a folder is deleted only by the last job holding it; unclaimed folders are free", () => {
  const dir = path.join(os.tmpdir(), `jobdirs-${process.pid}`);
  assert.equal(jobDirs.release(dir), true, "never claimed -> free to delete");
  jobDirs.claim(dir);
  jobDirs.claim(dir);
  assert.equal(jobDirs.holdersOf(dir), 2);
  assert.equal(jobDirs.release(dir), false, "another job still holds it");
  assert.equal(jobDirs.release(dir), true, "the last one may delete it");
  assert.equal(jobDirs.holdersOf(dir), 0);
  assert.notEqual(jobDirs.uniqueSuffix(), jobDirs.uniqueSuffix());
});

for (const company of COMPANIES) {
  test(`${company.name}: two policies at once — the first to finish closes only its own window and folder`, async () => {
    const { restore } = load({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" });
    delete require.cache[company.manager];
    const manager = require(company.manager);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "retention-two-"));
    const a = company.profile(base, "A");
    const b = company.profile(base, "B");
    jobDirs.claim(a.userDataDir);
    jobDirs.claim(b.userDataDir);
    const quits = { A: 0, B: 0 };
    const browserOf = (id, profileInfo) => ({ driver: { async quit() { quits[id] += 1; } }, profileInfo, jobId: id });
    const logs = ["log", "warn", "error"].map((k) => [k, console[k]]);
    logs.forEach(([k]) => (console[k] = () => {}));
    try {
      await manager[company.cleanup](browserOf("A", a), { hadError: false }); // A completes first
      assert.equal(fs.existsSync(a.userDataDir), false, "A's own folder is gone");
      assert.equal(fs.existsSync(path.join(b.userDataDir, "Default", "Cookies")), true, "B's session is intact");
      assert.deepEqual(quits, { A: 1, B: 0 }, "B's window was not closed");

      await manager[company.cleanup](browserOf("B", b), { hadError: false });
      assert.equal(fs.existsSync(b.userDataDir), false);
      assert.deepEqual(quits, { A: 1, B: 1 });
    } finally {
      logs.forEach(([k, fn]) => (console[k] = fn));
      restore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test(`${company.name}: even if two jobs were handed the SAME folder, it survives until the last one is done`, async () => {
    const { restore } = load({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" });
    delete require.cache[company.manager];
    const manager = require(company.manager);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "retention-same-"));
    const shared = company.profile(base, "SAME");
    jobDirs.claim(shared.userDataDir); // job 1
    jobDirs.claim(shared.userDataDir); // job 2, same folder
    const logs = ["log", "warn", "error"].map((k) => [k, console[k]]);
    logs.forEach(([k]) => (console[k] = () => {}));
    try {
      await manager[company.cleanup]({ driver: { async quit() {} }, profileInfo: shared, jobId: "1" }, { hadError: false });
      assert.equal(fs.existsSync(path.join(shared.userDataDir, "Default", "Cookies")), true, "kept: job 2 still uses it");
      await manager[company.cleanup]({ driver: { async quit() {} }, profileInfo: shared, jobId: "2" }, { hadError: false });
      assert.equal(fs.existsSync(shared.userDataDir), false, "the last job removes it");
    } finally {
      logs.forEach(([k, fn]) => (console[k] = fn));
      restore();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}

test("KSHEMA: two policies at once — the first to finish closes only its own window and folder", async () => {
  const { restore } = load({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" });
  const managerPath = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSessionManager.js");
  delete require.cache[managerPath];
  const { cleanupKshemaJobBrowser } = require(managerPath);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "retention-kshema-two-"));
  const mk = (name) => {
    const dir = jobFolder(base, name);
    jobDirs.claim(dir);
    return { userDataDir: dir, fullPath: path.join(dir, "Default"), downloadDir: path.join(dir, "downloads") };
  };
  const a = mk("kshema_job_A_1_aaa");
  const b = mk("kshema_job_B_1_bbb");
  const quits = { A: 0, B: 0 };
  const logs = ["log", "warn", "error"].map((k) => [k, console[k]]);
  logs.forEach(([k]) => (console[k] = () => {}));
  try {
    await cleanupKshemaJobBrowser({ driver: { async quit() { quits.A += 1; } }, profileInfo: a, jobId: "A" }, { hadError: false });
    assert.equal(fs.existsSync(a.userDataDir), false);
    assert.equal(fs.existsSync(path.join(b.userDataDir, "Default", "Cookies")), true);
    assert.deepEqual(quits, { A: 1, B: 0 });
  } finally {
    logs.forEach(([k, fn]) => (console[k] = fn));
    restore();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the three job browsers name their folders with a random token, so same-millisecond starts cannot collide", () => {
  for (const f of ["sessionManager.js", "nationalSessionManager.js", path.join("fullPolicycompany", "kshema", "kshemaSessionManager.js")]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.match(src, /uniqueSuffix\(\)/, `${f} adds a random suffix`);
    assert.match(src, /jobDirs\)?\.claim\(|jobDirs"\)\.claim\(/, `${f} claims its folder`);
  }
});

test("KSHEMA: even if two jobs were handed the SAME folder, it survives until the last one is done", async () => {
  const { restore } = load({ KEEP_BROWSER_OPEN_ON_ERROR: "false", CLOSE_BROWSER_AFTER_COMPLETE: "true" });
  const managerPath = path.join(ROOT, "fullPolicycompany", "kshema", "kshemaSessionManager.js");
  delete require.cache[managerPath];
  const { cleanupKshemaJobBrowser } = require(managerPath);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "retention-kshema-same-"));
  const dir = jobFolder(base, "kshema_job_SAME_1");
  jobDirs.claim(dir);
  jobDirs.claim(dir);
  const profileInfo = { userDataDir: dir, fullPath: path.join(dir, "Default"), downloadDir: path.join(dir, "downloads") };
  const logs = ["log", "warn", "error"].map((k) => [k, console[k]]);
  logs.forEach(([k]) => (console[k] = () => {}));
  try {
    await cleanupKshemaJobBrowser({ driver: { async quit() {} }, profileInfo, jobId: "1" }, { hadError: false });
    assert.equal(fs.existsSync(path.join(dir, "Default", "Cookies")), true, "kept: job 2 still uses it");
    await cleanupKshemaJobBrowser({ driver: { async quit() {} }, profileInfo, jobId: "2" }, { hadError: false });
    assert.equal(fs.existsSync(dir), false, "the last job removes it");
  } finally {
    logs.forEach(([k, fn]) => (console[k] = fn));
    restore();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* ---- review follow-ups (2026-10-15) ---- */

test("a closed window is not described as 'left open on screen' (all three KSHEMA sentences reworded, no colon added)", () => {
  const { closedWindowWording } = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaWindowNote.js"));
  const { kycValidationMessage } = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaKycDocument.js"));
  const samples = [
    "The KSHEMA KYC did not complete. The KYC page has been left open on screen so it can be finished by hand, and its link is saved on the policy.",
    kycValidationMessage("The gender on your document doesn't match your profile."),
    "The KSHEMA KYC was still processing after 30 seconds, so the payment step was not reached. The page has been left open and photographed — check whether the KYC went through.",
  ];
  for (const text of samples) {
    const out = closedWindowWording(text);
    assert.doesNotMatch(out, /left open/, out);
    assert.equal((out.match(/:/g) || []).length, (text.match(/:/g) || []).length, "no colon added");
  }
  assert.match(closedWindowWording(samples[1]), /KSHEMA said "The gender on your document/, "the portal's words survive");
  assert.equal(closedWindowWording(undefined), undefined);
});

for (const file of [
  path.join(ROOT, "fullPolicycompany", "kshemaForm.js"),
  path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"),
]) {
  test(`${path.basename(file)}: the wording is corrected only when the window is actually closed`, () => {
    const src = fs.readFileSync(file, "utf8");
    assert.match(src, /if \(!browserLeftOpen\) \{\s*const \{ closedWindowWording \} = require\([^)]*kshemaWindowNote"\);\s*result\.error = closedWindowWording\(result\.error\);/);
  });
}

test("the orphan-profile sweep never removes a folder a running (or kept) job still holds", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const sweep = src.slice(src.indexOf("const sweepOrphanedProfiles = () =>"));
  const ageCheck = sweep.indexOf("if (ageMs < ORPHAN_PROFILE_MAX_AGE_MS) continue;");
  const heldCheck = sweep.indexOf('require("./lib/jobDirs").holdersOf(profilePath) > 0) continue;');
  const remove = sweep.indexOf("fs.rmSync(profilePath");
  assert.ok(ageCheck > 0 && heldCheck > ageCheck && remove > heldCheck, "held folders are skipped before anything is removed");
});
