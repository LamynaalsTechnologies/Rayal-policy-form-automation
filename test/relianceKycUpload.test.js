// Run with: node --test test/relianceKycUpload.test.js
//
// The Reliance KYC page after "Continue (with OVD UPLOAD)": choose UPLOAD DOCUMENT, then put the document into
// Identity Verification and Address Verification. These tests run relianceKycUpload.js — its in-page functions and its
// node side together — against a stand-in page that has the real page's traps (read from a saved page source of the
// failed run, 2026-10-14):
//   * FIVE options with ng-click="selectDoc(..)"; PAN comes first. The chosen one's wrapper gets "active-r".
//   * several upload areas with the SAME handler string, only the ones of the chosen option on screen
//   * leftover <input type=file> elements: the FIRST in the page is an Address (file2) input and the LAST an Identity
//     (file1,'pan') input — taking inputs in page order swaps the two documents
//   * a refusal is a toast that is gone after ~5 s
// A fake clock; no browser, no network. (The same page in real headless Chrome: scratch run, see the memory note.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const up = require("../fullPolicycompany/reliance/relianceKycUpload");
const kyc = require("../fullPolicycompany/reliance/relianceKycSubmit");

const IDENTITY = "uploadFile($file,'file1', true, 'pan')";
const ADDRESS = "uploadFile($file,'file2')";
const ERR = "Please upload valid OVD file only.";

/* -------------------------------------------------------------------------- */
/* A stand-in for the page                                                    */
/* -------------------------------------------------------------------------- */

const SELECTORS = {
  "[ng-click]": (e) => e.hasAttribute("ng-click"),
  ".doc-type": (e) => e.classes.includes("doc-type"),
  ".doc-type, [ng-click*='selectDoc']": (e) => e.classes.includes("doc-type") || (e.attrs["ng-click"] || "").includes("selectDoc"),
  "[ng-click*='selectDoc']": (e) => (e.attrs["ng-click"] || "").includes("selectDoc"),
  "[ngf-select]": (e) => e.hasAttribute("ngf-select"),
  "input[type=file]": (e) => e.tag === "INPUT" && e.attrs.type === "file",
  "button[ng-click='uploadFilesToAPI()'], input[type=button][ng-click='uploadFilesToAPI()']": (e) =>
    e.tag === "BUTTON" && e.attrs["ng-click"] === "uploadFilesToAPI()",
  "button[ng-click='redirectToURL()'], input[type=button][ng-click='redirectToURL()']": (e) =>
    e.tag === "BUTTON" && e.attrs["ng-click"] === "redirectToURL()",
  "button, input[type=button], input[type=submit]": (e) => e.tag === "BUTTON",
  "[role='alert'], .alert-danger": () => false,
};

class El {
  constructor(page, { tag = "DIV", attrs = {}, text = "", classes = [], shown = () => true, onClick = null, parent = null } = {}) {
    Object.assign(this, { page, tag, attrs, text, classes, shown, onClickFn: onClick, parentElement: parent });
    this.children = [];
    this.style = {};
    this.clicks = 0;
    this.sent = [];
    if (parent) parent.children.push(this);
  }
  get tagName() {
    return this.tag;
  }
  get innerText() {
    return this.text;
  }
  get textContent() {
    return this.text;
  }
  get className() {
    return this.classNameFn ? this.classNameFn() : this.classes.join(" ");
  }
  get disabled() {
    return false;
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  hasAttribute(n) {
    return n in this.attrs;
  }
  getBoundingClientRect() {
    return this.shown() ? { width: 120, height: 30 } : { width: 0, height: 0 };
  }
  scrollIntoView() {}
  click() {
    this.clicks++;
    if (this.onClickFn) this.onClickFn(this);
  }
  querySelector(sel) {
    const test = SELECTORS[sel];
    if (!test) throw new Error(`stand-in page: unsupported selector ${sel}`);
    return this.children.find(test) || null;
  }
  async sendKeys(file) {
    if (this.page.sendKeysFails) throw new Error("element not interactable");
    this.sent.push(file);
    this.page.fileChosen(this, file);
  }
}

/**
 * @param {Object} [o]
 * @param {number}  [o.ignoreClicks]   the first N option clicks do nothing (a page that did not take them)
 * @param {string}  [o.rejectWith]     a refusal toast instead of taking a document
 * @param {boolean} [o.sendKeysFails]  the file inputs refuse the path (selenium: not interactable)
 * @param {boolean} [o.scopeReadable]  Angular's scope can be read (window.angular present)
 * @param {boolean} [o.corporateOnly]  no upload areas for the individual tab at all
 */
function makePage(o = {}) {
  const page = {
    clock: { t: 0 },
    docType: "pan",
    scope: { file1: null, file2: null },
    log: [], // every document the page took: { expr|model, via, file }
    optionClicks: [],
    toasts: [],
    ignoreClicks: o.ignoreClicks || 0,
    rejectWith: o.rejectWith || null,
    sendKeysFails: !!o.sendKeysFails,
  };
  const all = [];
  const make = (opts) => {
    const e = new El(page, opts);
    all.push(e);
    return e;
  };

  // the five options, each in its own wrapper
  const options = {};
  const wrappers = {};
  for (const key of ["pan", "aadhaar", "ckyc", "upload", "aa"]) {
    const wrapper = make({ attrs: key === "upload" ? { id: "upload-radio" } : {}, classes: ["radio-wrap"] });
    wrapper.classNameFn = () => `radio-wrap${page.docType === key ? " active-r" : ""}`;
    const option = make({
      attrs: { "ng-click": `selectDoc('${key}')` },
      classes: ["doc-type"],
      text: key === "upload" ? "UPLOAD DOCUMENT" : key.toUpperCase(),
      parent: wrapper,
      onClick: () => {
        page.optionClicks.push(key);
        if (page.ignoreClicks > 0) {
          page.ignoreClicks--;
          return;
        }
        page.docType = key;
      },
    });
    options[key] = option;
    wrappers[key] = wrapper;
  }

  // upload areas: only the chosen option's are on screen; the same handler strings occur under several options
  const area = (expr, label, shownWhen) => {
    const a = make({ attrs: { "ngf-select": expr, "ngf-drop": expr }, classes: ["inner-upload"], text: label, shown: shownWhen });
    a.scopeObj = page.scope;
    a.onClickFn = (self) => {
      // ng-file-upload: a click makes the area's own input, appended to <body>; its previous one is removed
      if (self.generated) all.splice(all.indexOf(self.generated), 1);
      self.generated = make({ tag: "INPUT", attrs: { type: "file", "ngf-select": expr } });
    };
    return a;
  };
  const individual = !o.corporateOnly;
  const decoys = [];
  decoys.push(make({ tag: "INPUT", attrs: { type: "file", "ngf-select": ADDRESS } })); // FIRST input in the page: file2
  decoys.push(make({ tag: "INPUT", attrs: { type: "file", "ngf-select": ADDRESS } }));
  // the PAN option (first in the page) has an area with the same handler; so has the Corporate tab — neither is on
  // screen once UPLOAD DOCUMENT is chosen, and both come BEFORE the Identity / Address areas
  area(IDENTITY, "Corporate identity", () => false);
  area(ADDRESS, "Corporate address", () => false);
  if (individual) {
    area(IDENTITY, "PAN card", () => page.docType === "pan");
    page.identityArea = area(IDENTITY, "Identity Verification", () => page.docType === "upload" && !page.scope.file1);
    page.addressArea = area(ADDRESS, "Address Verification", () => page.docType === "upload" && !page.scope.file2);
  }
  decoys.push(make({ tag: "INPUT", attrs: { type: "file", "ngf-select": IDENTITY } })); // LAST input in the page: file1,'pan'

  // buttons: two SUBMIT (Corporate tab first, hidden), PROCEED
  make({ tag: "BUTTON", attrs: { "ng-click": "uploadFilesToAPI()" }, text: "SUBMIT", shown: () => false });
  make({ tag: "BUTTON", attrs: { "ng-click": "uploadFilesToAPI()" }, text: "SUBMIT", shown: () => !!(page.scope.file1 || page.scope.file2) });
  make({ tag: "BUTTON", attrs: { "ng-click": "redirectToURL()" }, text: "PROCEED", shown: () => !!page.proceedShown });

  // what the page does with a document handed to one of its handlers
  page.take = (expr, file, via) => {
    if (page.rejectWith) {
      page.toasts.push({ message: page.rejectWith, from: page.clock.t + 500, until: page.clock.t + 500 + 5000 });
      return;
    }
    if (expr === IDENTITY) page.scope.file1 = { name: path.basename(file) };
    else if (expr === ADDRESS) page.scope.file2 = { name: path.basename(file) };
    page.log.push({ expr, via, file: path.basename(file) });
  };
  page.fileChosen = (input, file) => page.take(input.attrs["ngf-select"], file, "input");

  page.scope.uploadFile = (file, model, flag, type) => {
    page.scopeCalls = (page.scopeCalls || []).concat([{ model, flag, type, name: file.name }]);
    if (page.rejectWith) return page.take(null, file.name, "scope");
    page.scope[model] = { name: file.name };
    page.log.push({ model, via: "scope", file: file.name });
  };
  page.scope.$apply = () => {};

  const toastEls = () =>
    page.toasts
      .filter((t) => t.from <= page.clock.t && page.clock.t < t.until)
      .map((t) => {
        const toast = new El(page, { classes: ["ui-notification", "error"], text: `× ${t.message}` });
        toast.children.push(new El(page, { classes: ["message"], text: t.message }));
        toast.children[0].attrs = {};
        toast.querySelector = (sel) => (sel === ".message" ? toast.children[0] : null);
        return toast;
      });

  const document = {
    getElementById: (id) => all.find((e) => e.attrs.id === id) || null,
    querySelector: (sel) => {
      const test = SELECTORS[sel];
      return test ? all.find(test) || null : null;
    },
    querySelectorAll: (sel) => {
      if (sel === ".ui-notification") return toastEls();
      const test = SELECTORS[sel];
      if (!test) throw new Error(`stand-in page: unsupported selector ${sel}`);
      return all.filter(test);
    },
  };
  const window = {
    getComputedStyle: (e) => ({ display: e.shown() ? "block" : "none", visibility: "visible", opacity: "1" }),
  };
  if (o.scopeReadable !== false) {
    window.angular = { element: (el) => ({ scope: () => el.scopeObj || page.scope }) };
  }

  // the driver: runs the page functions against the stand-in page; time is the fake clock
  const savedFile = globalThis.File;
  const driver = {
    async executeScript(fn, ...args) {
      const saved = { document: globalThis.document, window: globalThis.window };
      globalThis.document = document;
      globalThis.window = window;
      if (typeof globalThis.File === "undefined" || true) {
        globalThis.File = class {
          constructor(parts, name, opts) {
            this.parts = parts;
            this.name = name;
            this.type = opts && opts.type;
          }
        };
      }
      try {
        return fn(...args);
      } finally {
        if (saved.document === undefined) delete globalThis.document;
        else globalThis.document = saved.document;
        if (saved.window === undefined) delete globalThis.window;
        else globalThis.window = saved.window;
        if (savedFile === undefined) delete globalThis.File;
        else globalThis.File = savedFile;
      }
    },
    async sleep(ms) {
      page.clock.t += ms;
    },
  };
  const opts = {
    now: () => page.clock.t,
    sleep: async (ms) => {
      page.clock.t += ms;
    },
  };
  return { page, all, options, wrappers, decoys, driver, opts, time: () => page.clock.t };
}

function withTempDoc(fn, { name = "aadhaar.jpg", bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kyc_upload_"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  const done = () => fs.rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(file);
  } catch (e) {
    done();
    throw e;
  }
  return Promise.resolve(result).finally(done);
}

/* -------------------------------------------------------------------------- */
/* The handlers                                                               */
/* -------------------------------------------------------------------------- */

test("the two handlers are exactly what the page writes in ngf-select", () => {
  assert.equal(up.SLOT_HANDLERS.identity, "uploadFile($file,'file1', true, 'pan')");
  assert.equal(up.SLOT_HANDLERS.address, "uploadFile($file,'file2')");
  assert.equal(up.SLOT_MODEL.identity, "file1");
  assert.equal(up.SLOT_MODEL.address, "file2");
});

/* -------------------------------------------------------------------------- */
/* Choosing UPLOAD DOCUMENT                                                   */
/* -------------------------------------------------------------------------- */

test("UPLOAD DOCUMENT is chosen — never the first selectDoc option (PAN)", async () => {
  const s = makePage();
  const r = await up.chooseUploadDocument(s.driver, s.opts);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual(s.page.optionClicks, ["upload"], "only UPLOAD DOCUMENT was clicked");
  assert.equal(s.page.docType, "upload");
  assert.match(s.wrappers.upload.className, /active-r/, "and the page shows it as the selected one");
});

test("a click the page ignored is tried once more, and the page's own state decides", async () => {
  const s = makePage({ ignoreClicks: 1 });
  const r = await up.chooseUploadDocument(s.driver, s.opts);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.deepEqual(s.page.optionClicks, ["upload", "upload"]);
});

test("a page that never takes the click is reported — the caller stops, nothing is uploaded", async () => {
  const s = makePage({ ignoreClicks: 99 });
  const r = await up.chooseUploadDocument(s.driver, s.opts);
  assert.equal(r.ok, false);
  assert.equal(r.found, true);
  assert.equal(r.shown, true);
  assert.equal(r.attempts, 2);
  assert.ok(s.time() >= 5000, "each attempt gives the page time to settle");
});

test("the option is found by its exact handler when the wrapper id is not there, and by its label as the last resort", async () => {
  // no #upload-radio: found by ng-click="selectDoc('upload')"
  const s = makePage();
  s.wrappers.upload.attrs = {};
  const found = await s.driver.executeScript(up.findUploadOptionInPage);
  assert.equal(found, s.options.upload);

  // neither the wrapper id nor the exact handler: found by its label — and still never PAN
  const t = makePage();
  t.wrappers.upload.attrs = {};
  t.options.upload.attrs["ng-click"] = "chooseDocument('x')";
  t.options.upload.classes = ["doc-type"];
  const byLabel = await t.driver.executeScript(up.findUploadOptionInPage);
  assert.equal(byLabel, t.options.upload);
  assert.notEqual(byLabel, t.options.pan);
});

test("no UPLOAD DOCUMENT on the page is 'not found', not a click on something else", async () => {
  const s = makePage();
  s.all.splice(s.all.indexOf(s.options.upload), 1);
  s.all.splice(s.all.indexOf(s.wrappers.upload), 1);
  assert.equal(await s.driver.executeScript(up.findUploadOptionInPage), null);
  const r = await up.chooseUploadDocument(s.driver, s.opts);
  assert.equal(r.ok, false);
  assert.equal(r.found, false);
  assert.deepEqual(s.page.optionClicks, [], "nothing was clicked");
});

/* -------------------------------------------------------------------------- */
/* Uploading into Identity / Address                                          */
/* -------------------------------------------------------------------------- */

test("each document goes into the input of ITS handler — not the first or the last input in the page", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  await withTempDoc(async (file) => {
    const id = await up.uploadKycDocument(s.driver, "identity", file, s.opts);
    assert.equal(id.state, "accepted");
    assert.equal(id.via, "input");
    const ad = await up.uploadKycDocument(s.driver, "address", file, s.opts);
    assert.equal(ad.state, "accepted");
    assert.equal(ad.via, "input");

    assert.deepEqual(
      s.page.log.map((l) => l.expr),
      [IDENTITY, ADDRESS],
      "Identity went to the file1,'pan' handler and Address to file2 — in that order"
    );
    assert.equal(s.page.identityArea.generated.sent.length, 1, "Identity: the input its own click made took the document");
    assert.equal(s.page.addressArea.generated.sent.length, 1, "Address: the input its own click made took the document");
    assert.deepEqual(s.decoys[0].sent, [], "the first input of the page (an Address input) did not take the Identity document");
    assert.deepEqual(s.decoys[2].sent, [], "the last input of the page (an Identity input) did not take the Address document");
    assert.ok(s.page.scope.file1 && s.page.scope.file2);
  });
});

test("the visible area is the one clicked, even though other areas carry the same handler", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  await withTempDoc(async (file) => {
    await up.uploadKycDocument(s.driver, "identity", file, s.opts);
    const clicked = s.all.filter((e) => e.classes.includes("inner-upload") && e.clicks > 0).map((e) => e.text);
    assert.deepEqual(clicked, ["Identity Verification"], "not 'PAN card' (hidden) and not 'Corporate identity'");
  });
});

test("when the file input will not take the path, the page's own handler is called with the right arguments", async () => {
  const s = makePage({ sendKeysFails: true });
  await up.chooseUploadDocument(s.driver, s.opts);
  await withTempDoc(async (file) => {
    const id = await up.uploadKycDocument(s.driver, "identity", file, { ...s.opts, fileName: "Aadhaar.pdf" });
    assert.equal(id.state, "accepted");
    assert.equal(id.via, "scope");
    const ad = await up.uploadKycDocument(s.driver, "address", file, s.opts);
    assert.equal(ad.state, "accepted");
    assert.equal(ad.via, "scope");
    assert.deepEqual(
      s.page.scopeCalls.map(({ model, flag, type }) => ({ model, flag, type })),
      [
        { model: "file1", flag: true, type: "pan" },
        { model: "file2", flag: undefined, type: undefined },
      ],
      "Identity is uploadFile(file,'file1',true,'pan'); Address is uploadFile(file,'file2')"
    );
    assert.equal(s.page.scopeCalls[0].name, "Aadhaar.pdf", "the name the portal sees is the policy's document name");
  });
});

test("a slot that already holds a document is left alone ('already')", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  s.page.scope.file1 = { name: "earlier.jpg" }; // taken by an earlier try; its area is gone from the screen
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "identity", file, s.opts);
    assert.equal(r.state, "already");
    assert.deepEqual(s.page.log, [], "nothing was uploaded again");
  });
});

test("the area is there but not on screen (UPLOAD DOCUMENT not chosen) -> hidden; no such area at all -> missing", async () => {
  const hidden = makePage();
  hidden.page.docType = "aa"; // an option whose view has no Identity / Address area (PAN's has an Identity-handler area)
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(hidden.driver, "identity", file, hidden.opts);
    assert.equal(r.state, "hidden");
    assert.deepEqual(hidden.page.log, []);
  });

  const missing = makePage({ corporateOnly: true });
  // remove the corporate areas too, so no area carries the Identity handler
  for (const e of missing.all.filter((x) => x.classes.includes("inner-upload"))) missing.all.splice(missing.all.indexOf(e), 1);
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(missing.driver, "identity", file, missing.opts);
    assert.equal(r.state, "missing");
  });
});

/* -------------------------------------------------------------------------- */
/* The page's answer                                                          */
/* -------------------------------------------------------------------------- */

test("a refusal toast that is gone in 5 s is still the answer (latched), after the stable window", async () => {
  const s = makePage({ rejectWith: ERR });
  await up.chooseUploadDocument(s.driver, s.opts);
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "identity", file, s.opts);
    assert.equal(r.state, "rejected");
    assert.equal(r.text, ERR);
    assert.equal(r.seen, ERR);
    // the toast lived 500 ms .. 5500 ms; the answer came 8 s after it first appeared, long after it was gone
    assert.ok(r.waitedMs >= 8000, `waited ${r.waitedMs} ms`);
    assert.ok(s.time() > 5500, "the toast had gone by the time the wait ended");
  });
});

test("no document taken and no message: timeout, with no text", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  // the input takes the path but the page does nothing with it
  s.page.fileChosen = () => {};
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "identity", file, { ...s.opts, timeoutMs: 30000 });
    assert.equal(r.state, "timeout");
    assert.equal(r.text, "");
    assert.ok(r.waitedMs >= 30000);
  });
});

test("an error met while the slot was waiting is carried out with the accepted slot (seen), and seeds the next one", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  // a toast shows up while the document goes in, and the page takes the document anyway
  s.page.toasts.push({ message: ERR, from: 0, until: 3000 });
  await withTempDoc(async (file) => {
    const first = await up.uploadKycDocument(s.driver, "identity", file, s.opts);
    assert.equal(first.state, "accepted");
    // accepted at the first look: the toast is not yet counted as seen only if it was never on screen
    const second = await up.uploadKycDocument(s.driver, "address", file, { ...s.opts, seenText: ERR });
    assert.equal(second.state, "accepted");
    assert.equal(second.seen, ERR, "the seed is carried through");
  });
});

test("a seeded error that nothing contradicts ends the wait as a refusal after the stable window", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  s.page.fileChosen = () => {};
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "address", file, { ...s.opts, seenText: ERR });
    assert.equal(r.state, "rejected");
    assert.equal(r.text, ERR);
    assert.ok(r.waitedMs >= 8000 && r.waitedMs < 9000, `${r.waitedMs} ms`);
  });
});

test("what the page already showed before the upload is not a refusal", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  s.page.toasts.push({ message: "Only JPG, PNG and PDF", from: 0, until: 1e9 });
  s.page.fileChosen = () => {};
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "identity", file, {
      ...s.opts,
      timeoutMs: 25000,
      ignoreErrors: ["Only JPG, PNG and PDF"],
    });
    assert.equal(r.state, "timeout");
    assert.equal(r.text, "");
  });
});

test("a long wait says it is still waiting, and a logger that throws does not end it", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  s.page.fileChosen = () => {};
  const seen = [];
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "identity", file, {
      ...s.opts,
      timeoutMs: 50000,
      onProgress: (p) => {
        seen.push(p);
        throw new Error("a logger that throws");
      },
    });
    assert.equal(r.state, "timeout");
    assert.ok(seen.length >= 3, `${seen.length} progress lines`);
    assert.equal(seen[0].slot, "identity");
  });
});

/* -------------------------------------------------------------------------- */
/* In page: slot state                                                        */
/* -------------------------------------------------------------------------- */

test("in page: dropzoneStateInPage counts the areas with exactly this handler, and the ones on screen", async () => {
  const s = makePage();
  await up.chooseUploadDocument(s.driver, s.opts);
  const id = await s.driver.executeScript(up.dropzoneStateInPage, IDENTITY);
  assert.deepEqual(id, { exists: 3, shown: 1 }, "Identity: the upload area, the PAN area, the Corporate one — one on screen");
  const ad = await s.driver.executeScript(up.dropzoneStateInPage, ADDRESS);
  assert.deepEqual(ad, { exists: 2, shown: 1 });
  // inputs carry the same attribute but are not areas
  assert.equal((await s.driver.executeScript(up.dropzoneStateInPage, "uploadFile($file,'nope')")).exists, 0);
});

test("in page: slotFileInPage reads the page's model; null when Angular cannot be read", async () => {
  const s = makePage();
  assert.equal(await s.driver.executeScript(up.slotFileInPage, IDENTITY, "file1"), false);
  s.page.scope.file1 = { name: "a.jpg" };
  assert.equal(await s.driver.executeScript(up.slotFileInPage, IDENTITY, "file1"), true);

  const blind = makePage({ scopeReadable: false });
  assert.equal(await blind.driver.executeScript(up.slotFileInPage, IDENTITY, "file1"), null);
});

test("without Angular's scope the slot counts as taken when its area has left the screen (ng-show='!file1')", async () => {
  const s = makePage({ scopeReadable: false });
  await up.chooseUploadDocument(s.driver, s.opts);
  await withTempDoc(async (file) => {
    const r = await up.uploadKycDocument(s.driver, "identity", file, s.opts);
    assert.equal(r.state, "accepted");
    assert.equal(r.via, "input");
  });
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

test("relianceForm.js: UPLOAD DOCUMENT is chosen with the exact finder under the switch; the first-selectDoc search survives only in the switch-off branch", () => {
  const step1 = at('// === STEP 1: Click "UPLOAD DOCUMENT" div ===');
  const finder = at("driver.executeScript(findUploadOptionInPage)", step1);
  const oldQuery = at(`document.querySelector("[ng-click*='selectDoc']")`, step1);
  assert.ok(finder < oldQuery, "the exact finder comes first");
  assert.match(
    formSrc.slice(finder - 120, finder),
    /isKycSubmitWaitEnabled\(\)\s*\?\s*$/,
    "the exact finder is the switch-on side of a ternary; the old query is the other side"
  );

  const choose = at("await chooseUploadDocument(driver)", oldQuery);
  const stop = at('kycReasonText({ step: "option" })', choose);
  const thrown = at("throw new PortalRejectedError(", stop);
  const oldClick = at('console.log("✅ Clicked UPLOAD DOCUMENT div");', thrown);
  assert.ok(choose < stop && stop < thrown && thrown < oldClick);
  assert.match(formSrc.slice(choose - 600, choose), /if \(isKycSubmitWaitEnabled\(\)\) \{/);
  assert.match(formSrc.slice(thrown, oldClick), /\} else \{/, "the old click is the else branch");
});

test("relianceForm.js: both documents go in through uploadKycDocument (Identity then Address); the old input-order code is the switch-off branch", () => {
  const baseline = at("const kycBaseline = isKycSubmitWaitEnabled()");
  const gate = at("if (isKycSubmitWaitEnabled()) {", baseline);
  const loop = at('for (const slot of ["identity", "address"]) {', gate);
  const upload = at("await uploadKycDocument(driver, slot, absoluteFilePath, {", loop);
  assert.match(formSrc.slice(upload, upload + 400), /ignoreErrors: kycBaseline/);
  assert.match(formSrc.slice(upload, upload + 400), /seenText: kycSeen/);
  const reason = at('kycReasonText({ step: "upload"', upload);
  const thrown = at("throw new PortalRejectedError(", reason);
  assert.doesNotMatch(formSrc.slice(reason, thrown), /\b(continue|break|return)\b/, "a refused slot ends the policy: nothing between the reason and the throw");
  const elseBranch = at("} else {", thrown);
  const oldFile1 = at("=== UPLOADING TO IDENTITY VERIFICATION (file1) ===", elseBranch);
  const oldFile2 = at("=== UPLOADING TO ADDRESS VERIFICATION (file2) ===", oldFile1);
  const both = at('console.log("✅ Both document uploads attempted");', oldFile2);
  assert.ok(gate < loop && loop < upload && upload < reason && reason < thrown && thrown < elseBranch);
  assert.ok(elseBranch < oldFile1 && oldFile1 < oldFile2 && oldFile2 < both);
  // the new branch has none of the old page-order input handling
  assert.doesNotMatch(formSrc.slice(gate, elseBranch), /input\[type='file'\]/);
});

test("relianceForm.js: SUBMIT and PROCEED are the ones on screen (the page has several buttons with the same ng-click)", () => {
  const live = at('await findKycButton(driver, "submit")');
  assert.match(formSrc.slice(live - 300, live), /use the live one that is on screen/);
  const proceed = at('await findKycButton(driver, "proceed")');
  assert.match(formSrc.slice(proceed - 120, proceed), /isKycSubmitWaitEnabled\(\) \? $/);
  // the old first-match relocate is gone
  assert.equal(formSrc.includes('submitButton = await driver.findElement(By.css("button[ng-click=\'uploadFilesToAPI()\']"));'), false);
});

test("relianceForm.js imports what it uses from the upload module", () => {
  for (const name of ["SLOT_LABEL", "findUploadOptionInPage", "chooseUploadDocument", "uploadKycDocument"]) {
    assert.match(formSrc, new RegExp(`\\b${name}\\b[^\\n]*\\n(?:[^\\n]*\\n){0,6}[^\\n]*require\\("\\./reliance/relianceKycUpload"\\)`), name);
  }
  assert.match(formSrc, /findKycButton,\s*\n\s*waitForKycSubmitReady/);
});
