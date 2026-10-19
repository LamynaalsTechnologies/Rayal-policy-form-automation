/**
 * Reliance — when the KYC does not work.
 *
 * Until now a KYC that did not go through simply ended the run on the KYC page (a portal refusal) or was logged as a
 * "non-fatal warning" and the run carried on to buy the Brisk PA certificate for a proposal nobody could pay (every other
 * way it can fail). Either way the operator had a failed policy, a screenshot taken after the toast was gone, and no way
 * to the payment page.
 *
 * Now, with RELIANCE_KYC_FALLBACK_ENABLED (relianceKycSubmit.js isKycFallbackEnabled), when the KYC step ends without
 * Reliance accepting a document — whatever the reason — the form hands over to this module:
 *
 *   1. the screenshot of the error: taken the moment a toast / popup was first seen (a toast is gone in ~5 s), kept in
 *      memory and uploaded only now, because the KYC failed (createKycShotKeeper). A page shot is taken if there was no
 *      toast. At most 2 images.
 *   2. the KYC tab is closed and the run goes to Pending Quotes -> ticks THIS proposal (an exact match on the proposal
 *      number, never "the first one" — that could be another customer's) -> the TP declaration -> Pay, and reads the page
 *      it lands on (reachPaymentPage). It stops there: no "Send Payment Link", no wallet, nothing is paid or sent.
 *   3. the proposal page (where DO KYC was clicked) and the payment page are saved on the policy as `proposalLink` and
 *      `paymentLink` — the "Proposal Page" and "Make Payment Page" cards of the View page, the same fields KSHEMA writes.
 *      A link on another website (a KSHEMA TP's customer payment link) is never replaced.
 *   4. one operator sentence: what Reliance said, what was done, what to do next (kycFailureMessage).
 *
 * Everything here takes the driver / S3 / Mongo as arguments and never throws, so it is tested with fakes.
 * Used by relianceForm.js and, being shared, by the Reliance OD / TP copy.
 */
const { plain, saveKycStatus, kycGenericReasonText } = require("./relianceKycSubmit");
// The proposal's checkbox is looked for on EVERY page of Pending Quotes (a Kendo grid, 10 rows to a page); the exact-match
// finder lives there and is re-exported below.
const {
  isQuotesPagingEnabled,
  findProposalCheckboxInPage,
  findProposalAcrossPages,
  describeScan,
} = require("./relianceQuotesPaging");

/** Pending Quotes, relative to the portal's origin — the same address the success path navigates to. */
const PENDING_QUOTES_PATH = "/Payment/Payments?pageName=XhIEGvE4S2ipze7xJW7wmIFef%252b42e%252b6H6mk6l%252f76i0s%253d";

/** Thrown after the KYC step when it ended without Reliance accepting a document and nothing else was thrown. */
class KycIncompleteError extends Error {
  constructor(message, { reason = "" } = {}) {
    super(message);
    this.name = "KycIncompleteError";
    this.kycIncomplete = true;
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* The screenshots                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Keeps the screenshots of a KYC step in memory and uploads them only when asked (the KYC failed). A toast that flashes
 * while the upload is processed and then goes away leaves nothing in S3.
 *
 * @param {Object} o
 * @param {() => Promise<string>} o.takeScreenshot   base64 PNG of the page right now
 * @param {(base64: string, key: string) => Promise<string>} o.upload   returns the URL
 * @param {(label: string) => string} o.makeKey      the S3 key for a label ("toast" / "page")
 * @param {Function} [o.log]
 * @param {number} [o.maxShots]
 */
function createKycShotKeeper({ takeScreenshot, upload, makeKey, log = () => {}, maxShots = 2 } = {}) {
  const shots = [];
  const seen = new Set();

  async function capture(label, text = "") {
    if (shots.length >= maxShots) return null;
    let base64 = null;
    try {
      base64 = await takeScreenshot();
    } catch (e) {
      log(`⚠️ KYC screenshot could not be taken (${e && e.message})`);
    }
    if (!base64) return null;
    const shot = { label, text, base64, key: null, url: null, error: "", uploaded: false };
    shots.push(shot);
    return shot;
  }

  return {
    /** A new toast / popup text was seen: capture it NOW. Awaited by the waits, so the page is read before it moves on. */
    async noteError(text) {
      const t = String(text == null ? "" : text).trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      await capture("toast", t);
      log(`📸 KYC error on screen — screenshot kept: "${t}"`);
    },
    /** The page as it is now, when no toast was ever caught (a timeout, a missing link). */
    async capturePage() {
      if (shots.length === 0) await capture("page");
    },
    count: () => shots.length,
    /** Upload what was kept. The toast shot is the one to show; never throws. */
    async flush() {
      await Promise.all(
        shots.map(async (shot) => {
          if (shot.uploaded) return;
          shot.uploaded = true;
          try {
            shot.key = makeKey(shot.label);
            shot.url = await upload(shot.base64, shot.key);
          } catch (e) {
            shot.error = (e && e.message) || String(e);
            log(`⚠️ KYC screenshot upload failed (${shot.error})`);
          }
          shot.base64 = null;
        })
      );
      const best = shots.find((s) => s.label === "toast" && s.url) || shots.find((s) => s.url) || null;
      return {
        url: best ? best.url : null,
        key: best ? best.key : null,
        shots: shots.map(({ label, text, key, url, error }) => ({ label, text, key, url, error })),
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* In the page (self-contained: selenium serialises their source)             */
/* -------------------------------------------------------------------------- */

/** An element by id (the TP declaration, the Pay button), or null. */
function findControlInPage(id) {
  return document.getElementById(id) || null;
}

/** The "Pending Quotes" menu link's address, for the case the direct address did not open the page. */
function findPendingQuotesHrefInPage() {
  var links = document.querySelectorAll("a");
  for (var i = 0; i < links.length; i++) {
    var text = String(links[i].textContent || "").replace(/\s+/g, " ").trim();
    if (/^pending quotes$/i.test(text) && links[i].getAttribute("href")) return links[i].href;
  }
  return null;
}

/** What the page shows right now — enough to tell "the payment page opened" from "Reliance said no". */
function readPaymentPageInPage() {
  function shown(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }
  var dialog = "";
  var dialogs = document.querySelectorAll(".ui-dialog");
  for (var i = 0; i < dialogs.length; i++) {
    if (!shown(dialogs[i])) continue;
    var body = dialogs[i].querySelector(".ui-dialog-content") || dialogs[i];
    var text = String(body.innerText || body.textContent || "").replace(/\s+/g, " ").trim();
    if (text) {
      dialog = text.slice(0, 300);
      break;
    }
  }
  var amount = document.getElementById("txtTotalAmountPaidCurrency");
  return {
    url: String(window.location.href),
    title: String(document.title || ""),
    // the payment panel's amount field — present only once Pay has opened the payment step
    paymentPanel: !!(amount && shown(amount)),
    dialog: dialog,
    onPendingQuotes: /pending/i.test(String((document.body && document.body.innerText) || "").slice(0, 4000)),
  };
}

/* -------------------------------------------------------------------------- */
/* Reaching the payment page                                                  */
/* -------------------------------------------------------------------------- */

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch (e) {
    const m = String(url || "").match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : "";
  }
};

async function pollFor(read, { timeoutMs, pollMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await read();
    } catch (e) {
      value = null;
    }
    if (value) return value;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
}

async function clickElement(driver, element) {
  try {
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", element);
  } catch (e) {
    /* best effort */
  }
  try {
    await element.click();
  } catch (e) {
    await driver.executeScript("arguments[0].click();", element);
  }
}

async function isChecked(driver, element) {
  try {
    return !!(await driver.executeScript("return !!arguments[0].checked;", element));
  } catch (e) {
    return false;
  }
}

/** A JavaScript alert left open by Pay: read it and dismiss it, or "" when there is none. */
async function takeAlertText(driver) {
  try {
    const alert = await driver.switchTo().alert();
    const text = String((await alert.getText()) || "").trim();
    try {
      await alert.accept();
    } catch (e) {
      /* already gone */
    }
    return text;
  } catch (e) {
    return "";
  }
}

/**
 * Close the KYC tab, go to Pending Quotes, tick this proposal, tick the TP declaration, press Pay, read where it lands.
 * Never throws. Stops there — see the header.
 *
 * @returns {Promise<{reached:boolean, paymentUrl:string|null, pendingQuotesUrl:string|null, proposalFound:boolean,
 *                    blockedBy:string, reason:string, steps:string[]}>}
 */
async function reachPaymentPage(driver, opts = {}) {
  const {
    proposalNumber = "",
    kycWindowHandle = null,
    log = () => {},
    sleep = (ms) => driver.sleep(ms),
    now = Date.now,
    budgetMs = 90000,
    checkboxWaitMs = 15000,
    afterPayWaitMs = 12000,
    pollMs = 500,
  } = opts;

  const out = {
    reached: false,
    paymentUrl: null,
    pendingQuotesUrl: null,
    proposalFound: false,
    blockedBy: "",
    reason: "",
    steps: [],
  };
  const step = (text) => {
    out.steps.push(text);
    log(`↳ ${text}`);
  };
  const started = now();
  const outOfTime = () => now() - started > budgetMs;
  const waitOpts = { pollMs, now, sleep };

  try {
    if (!String(proposalNumber || "").trim()) {
      out.reason = "the policy has no proposal number to look for in Pending Quotes";
      step(out.reason);
      return out;
    }

    // 1. the KYC tab out of the way — back to the portal's own tab (the success path's "STEP 5")
    const handles = await driver.getAllWindowHandles();
    if (handles.length > 1) {
      const target = handles.find((h) => h !== kycWindowHandle) || handles[0];
      if (kycWindowHandle && handles.includes(kycWindowHandle)) {
        try {
          await driver.switchTo().window(kycWindowHandle);
          await driver.close();
          step("closed the KYC tab");
        } catch (e) {
          step(`could not close the KYC tab (${e && e.message})`);
        }
      }
      await driver.switchTo().window(target);
      step("back on the portal's own tab");
    }

    // 2. Pending Quotes
    const here = await driver.getCurrentUrl();
    const base = originOf(here);
    if (!base) {
      out.reason = `the portal address could not be read from "${here}"`;
      step(out.reason);
      return out;
    }
    await driver.get(base + PENDING_QUOTES_PATH);
    await sleep(3000);
    let page = await driver.executeScript(readPaymentPageInPage);
    if (!(page && page.onPendingQuotes)) {
      const href = await driver.executeScript(findPendingQuotesHrefInPage);
      if (href) {
        await driver.get(href);
        await sleep(3000);
        step("opened Pending Quotes from the menu link");
      }
    }
    out.pendingQuotesUrl = await driver.getCurrentUrl();
    step(`on Pending Quotes (${out.pendingQuotesUrl})`);

    // 3. THIS proposal's checkbox — exact match only, on whichever page of the list it is
    let box = null;
    if (isQuotesPagingEnabled()) {
      const search = await findProposalAcrossPages(driver, proposalNumber, {
        log: (line) => step(line),
        sleep,
        now,
        gridWaitMs: Math.min(checkboxWaitMs, Math.max(0, budgetMs - (now() - started))),
      });
      box = search.found ? search.checkbox : null;
      if (!box) {
        out.reason = `proposal ${proposalNumber} is not listed in Reliance's Pending Quotes (${describeScan(search)})`;
        step(out.reason);
        return out;
      }
      if (search.page && search.pages > 1) step(`proposal ${proposalNumber} is on page ${search.page} of ${search.pages}`);
    } else {
      box = await pollFor(() => driver.executeScript(findProposalCheckboxInPage, proposalNumber), {
        ...waitOpts,
        timeoutMs: Math.min(checkboxWaitMs, Math.max(0, budgetMs - (now() - started))),
      });
      if (!box) {
        out.reason = `proposal ${proposalNumber} is not listed in Reliance's Pending Quotes`;
        step(out.reason);
        return out;
      }
    }
    out.proposalFound = true;
    await clickElement(driver, box);
    await sleep(2000);
    if (!(await isChecked(driver, box))) {
      await driver.executeScript("arguments[0].click();", box); // the first click did not tick it
      await sleep(1000);
    }
    step(`ticked proposal ${proposalNumber}`);
    if (outOfTime()) {
      out.reason = "ran out of time before Pay";
      return out;
    }

    // 4. the TP declaration — ticked only if it is not ticked already (a click toggles)
    const declaration = await pollFor(() => driver.executeScript(findControlInPage, "TPDeclaration1"), {
      ...waitOpts,
      timeoutMs: 5000,
    });
    if (!declaration) {
      out.reason = "the TP declaration did not appear after the proposal was ticked";
      step(out.reason);
      return out;
    }
    if (!(await isChecked(driver, declaration))) await clickElement(driver, declaration);
    await sleep(1500);
    step("TP declaration ticked");

    // 5. Pay
    const pay = await pollFor(() => driver.executeScript(findControlInPage, "Paymentbtn"), { ...waitOpts, timeoutMs: 5000 });
    if (!pay) {
      out.reason = "the Pay button did not appear";
      step(out.reason);
      return out;
    }
    const before = await driver.getCurrentUrl();
    await clickElement(driver, pay);
    step("Pay pressed");
    await sleep(3000);

    // 6. where did it land
    let alertText = await takeAlertText(driver);
    let state = null;
    const deadline = now() + afterPayWaitMs;
    for (;;) {
      try {
        state = await driver.executeScript(readPaymentPageInPage);
      } catch (e) {
        state = null;
        alertText = alertText || (await takeAlertText(driver));
      }
      if (state && (state.url !== before || state.paymentPanel)) break;
      if (now() >= deadline) break;
      await sleep(pollMs);
    }
    const url = state && state.url ? state.url : await driver.getCurrentUrl().catch(() => before);
    const opened = !!(state && (state.url !== before || state.paymentPanel));
    if (opened) {
      out.reached = true;
      out.paymentUrl = url;
      step(`payment page open (${url})`);
    } else {
      out.blockedBy = alertText || (state && state.dialog) || "";
      out.reason = out.blockedBy
        ? `Reliance did not open the payment page - it said "${plain(out.blockedBy)}"`
        : "Pay was pressed but the payment page did not open";
      step(out.reason);
    }
    return out;
  } catch (e) {
    out.reason = out.reason || `the payment page could not be reached (${(e && e.message) || e})`;
    step(out.reason);
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Saving the links                                                           */
/* -------------------------------------------------------------------------- */

const hostOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return "";
  }
};

/**
 * Write `proposalLink` / `paymentLink` on the policy with the raw driver (like saveKycUrls). Only what was captured is
 * written, and a link already there on ANOTHER website is left alone — a KSHEMA TP's customer payment link must not be
 * replaced by a Reliance page. Never throws.
 *
 * @returns {Promise<{saved: Object, skipped: Object}>}
 */
async function saveProcessLinks({ proposalLink, paymentLink } = {}, data = {}, jobId = "", { MongoClient } = {}) {
  const saved = {};
  const skipped = {};
  const wanted = { proposalLink, paymentLink };
  if (!proposalLink && !paymentLink) return { saved, skipped };
  const policyId = data && (data._id || data.policyId);
  if (!policyId) {
    console.warn(`[${jobId}] ⚠️ No policy id on the job — the proposal / payment page links were not saved.`);
    return { saved, skipped };
  }
  let client = null;
  try {
    const Client = MongoClient || require("mongodb").MongoClient;
    client = new Client(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const collection = client.db().collection("onlinePolicy");
    const existing = (await collection.findOne({ _id: policyId }, { projection: { proposalLink: 1, paymentLink: 1 } })) || {};
    for (const [field, url] of Object.entries(wanted)) {
      if (!url) continue;
      const there = existing[field];
      if (there && hostOf(there) && hostOf(url) && hostOf(there) !== hostOf(url)) {
        skipped[field] = `the policy already has a ${field} on ${hostOf(there)}`;
        continue;
      }
      saved[field] = url;
    }
    if (Object.keys(saved).length) {
      const result = await collection.updateOne({ _id: policyId }, { $set: { ...saved, updatedAt: new Date() } });
      console.log(
        `[${jobId}] 📝 onlinePolicy ${Object.keys(saved).join(" + ")} saved (matched ${result.matchedCount})`
      );
      if (!result.matchedCount) {
        for (const field of Object.keys(saved)) skipped[field] = "no policy matched";
        for (const field of Object.keys(skipped)) delete saved[field];
      }
    }
    for (const [field, why] of Object.entries(skipped)) console.warn(`[${jobId}] ⚠️ ${field} not saved - ${why}`);
  } catch (e) {
    console.warn(`[${jobId}] ⚠️ Could not save the proposal / payment page links: ${e && e.message}`);
    for (const field of Object.keys(saved)) {
      skipped[field] = (e && e.message) || "database error";
      delete saved[field];
    }
  } finally {
    if (client) await client.close().catch(() => {});
  }
  return { saved, skipped };
}

/**
 * Save the address of the page the driver is on as `field` ("proposalLink" / "paymentLink") on the policy — the success
 * path's use of the same links (the run is on Pending Quotes, or on the page Pay opened). Saved at once, so the link is
 * on the policy whatever the steps after it do. Never throws.
 *
 * @param {Object} driver
 * @param {"proposalLink"|"paymentLink"} field
 * @param {Object} data     the job data (policy id)
 * @param {string} jobId
 * @param {Object} [o]
 * @param {string} [o.notSameAs]  the address of the page before — a link that would only repeat it is not saved
 * @param {RegExp} [o.reject]     an address that is NOT the page meant (a login page after a lost session)
 * @param {Function} [o.MongoClient]
 * @returns {Promise<{url: string|null, saved: boolean, skipped: string}>}
 */
async function saveCurrentPageLink(driver, field, data = {}, jobId = "", { notSameAs = "", reject = null, MongoClient } = {}) {
  let url = "";
  try {
    url = String((await driver.getCurrentUrl()) || "").trim();
  } catch (e) {
    const skipped = `the page address could not be read (${e && e.message})`;
    console.warn(`[${jobId}] ⚠️ ${field} not saved - ${skipped}`);
    return { url: null, saved: false, skipped };
  }
  if (!/^https?:\/\//i.test(url)) return { url: url || null, saved: false, skipped: "not a web address" };
  if (reject && reject.test(url)) {
    console.warn(`[${jobId}] ⚠️ ${field} not saved - the run is not on the page meant (${hostOf(url)})`);
    return { url, saved: false, skipped: "not the page meant" };
  }
  if (notSameAs && url === notSameAs) {
    console.log(`[${jobId}] ℹ️ ${field} not saved - it is the same page as the Proposal Page`);
    return { url, saved: false, skipped: "the same page as the Proposal Page" };
  }
  const { saved, skipped } = await saveProcessLinks({ [field]: url }, data, jobId, { MongoClient });
  return { url, saved: !!saved[field], skipped: skipped[field] || "" };
}

/**
 * A new attempt starts a NEW proposal, so the proposal / payment page links an earlier failed attempt saved point at the
 * old one — "Make Payment Page" would open the wrong proposal's page. Cleared when the KYC step of a new attempt starts,
 * but only the ones on the Reliance website itself: a KSHEMA TP's customer payment link is not ours to touch.
 * Never throws.
 *
 * @returns {Promise<{cleared: string[]}>}
 */
async function clearStaleProcessLinks({ portalUrl } = {}, data = {}, jobId = "", { MongoClient } = {}) {
  const host = hostOf(portalUrl);
  const policyId = data && (data._id || data.policyId);
  if (!host || !policyId) return { cleared: [] };
  let client = null;
  try {
    const Client = MongoClient || require("mongodb").MongoClient;
    client = new Client(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const collection = client.db().collection("onlinePolicy");
    const existing = (await collection.findOne({ _id: policyId }, { projection: { proposalLink: 1, paymentLink: 1 } })) || {};
    const stale = ["proposalLink", "paymentLink"].filter((f) => existing[f] && hostOf(existing[f]) === host);
    if (!stale.length) return { cleared: [] };
    const unset = {};
    for (const f of stale) unset[f] = "";
    await collection.updateOne({ _id: policyId }, { $unset: unset, $set: { updatedAt: new Date() } });
    console.log(`[${jobId}] 🧹 onlinePolicy ${stale.join(" + ")} cleared (an earlier attempt's page of ${host})`);
    return { cleared: stale };
  } catch (e) {
    console.warn(`[${jobId}] ⚠️ Could not clear an earlier attempt's links: ${e && e.message}`);
    return { cleared: [] };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* The operator's sentence                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What was done about payment, in plain words (no colon outside the portal's own quoted words — beautifyError keeps only
 * the text after the last colon of a message).
 */
function paymentSentence({ payment = {}, saved = {}, proposalNumber = "" } = {}) {
  const proposal = proposalNumber ? `The proposal ${plain(proposalNumber)}` : "The proposal";
  const nothing = "Nothing was paid and no payment link was sent to the customer.";
  if (payment.reached && saved.paymentLink) {
    const both = saved.proposalLink ? "The Proposal Page and Make Payment Page links are" : "The Make Payment Page link is";
    return (
      `${proposal} is saved at Reliance and its KYC is not complete. ${both} saved on the policy. ${nothing} ` +
      `Upload the Aadhaar by hand on the Document Upload Page, then pay from the Make Payment Page.`
    );
  }
  if (payment.reached && saved.proposalLink && payment.paymentUrl === saved.proposalLink) {
    return (
      `${proposal} is saved at Reliance and its KYC is not complete. Pay opened the payment step on the Pending Quotes ` +
      `page, and that page is saved as the Proposal Page link on the policy. ${nothing} Upload the Aadhaar by hand on ` +
      `the Document Upload Page, then pay from the Proposal Page.`
    );
  }
  if (payment.reached) {
    return (
      `${proposal} is saved at Reliance and its KYC is not complete. Reliance opened its payment page but the link could ` +
      `not be saved on the policy. ${nothing} Upload the Aadhaar by hand on the Document Upload Page, then pay from ` +
      `Reliance's Pending Quotes.`
    );
  }
  const saidLink = saved.proposalLink ? " The Proposal Page link is saved on the policy." : "";
  if (payment.blockedBy) {
    return (
      `${proposal} is saved at Reliance and its KYC is not complete. Reliance did not open its payment page - it said ` +
      `"${plain(payment.blockedBy)}".${saidLink} ${nothing} Upload the Aadhaar by hand on the Document Upload Page, ` +
      `then pay from Reliance's Pending Quotes.`
    );
  }
  const why = payment.reason ? ` (${plain(payment.reason)})` : "";
  return (
    `${proposal} is saved at Reliance and its KYC is not complete. The payment page could not be reached${why}, so no ` +
    `payment page link was saved.${saidLink} ${nothing} Upload the Aadhaar by hand on the Document Upload Page, then ` +
    `pay from Reliance's Pending Quotes.`
  );
}

/** The sentence for a failure that is not a portal refusal (nothing of Reliance's to quote). */
function genericFailureSentence(message) {
  const text = plain(String(message == null ? "" : message).replace(/^\[E\d+\]\s*/, ""));
  return text ? `The KYC could not be completed - ${text}.` : "The KYC could not be completed.";
}

/* -------------------------------------------------------------------------- */
/* The whole fallback                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The fallback, start to end. Never throws.
 *
 * @param {Object} o
 * @param {Object} o.driver
 * @param {Object} o.data                the job data (policy id, proposal number)
 * @param {string} o.jobId
 * @param {Error}  o.error               what ended the KYC (PortalRejectedError / KycIncompleteError / anything)
 * @param {string} [o.proposalNumber]
 * @param {string} [o.proposalPageUrl]   the View Policy page the KYC was started from
 * @param {string} [o.kycWindowHandle]
 * @param {Object} [o.shots]             createKycShotKeeper()
 * @param {Function} [o.log]
 * @param {Object} [o.deps]              reach / saveLinks / saveStatus, for tests
 * @returns {Promise<{message:string, screenshotUrl:string|null, screenshotKey:string|null, payment:Object, saved:Object}>}
 */
async function rescueAfterKycFailure({
  driver,
  data = {},
  jobId = "",
  error,
  proposalNumber = "",
  proposalPageUrl = "",
  kycWindowHandle = null,
  shots = null,
  log = console.log,
  deps = {},
} = {}) {
  const reach = deps.reach || reachPaymentPage;
  const saveLinks = deps.saveLinks || saveProcessLinks;
  const saveStatus = deps.saveStatus || saveKycStatus;
  const proposal = String(proposalNumber || (data && (data.proposalNumber || data.proposal_number)) || "").trim();

  // what happened, in the portal's words when it had any
  let failure;
  if (error && error.portalRejected) failure = String(error.message || "").trim();
  else failure = genericFailureSentence(error && (error.reason || error.message));

  // 1. the picture — BEFORE the page is left; the upload runs while the payment page is being reached
  let flushed = Promise.resolve({ url: null, key: null });
  if (shots) {
    try {
      await shots.capturePage();
      flushed = shots.flush();
    } catch (e) {
      log(`⚠️ KYC screenshot step failed (${e && e.message})`);
    }
  }

  // 2. the payment page
  let payment = { reached: false, reason: "not attempted", blockedBy: "", steps: [] };
  try {
    payment = await reach(driver, {
      proposalNumber: proposal,
      kycWindowHandle,
      log: (line) => log(`[${jobId}] ${line}`),
    });
  } catch (e) {
    payment = { reached: false, reason: (e && e.message) || String(e), blockedBy: "", steps: [] };
  }

  // 3. the links, and the note the View page shows
  let saved = {};
  try {
    // "Proposal Page" = where this proposal is listed and paid from (Pending Quotes), the same page the success path
    // saves; the page KYC was started from is only the stand-in when Pending Quotes could not be opened.
    const proposalLink = payment.pendingQuotesUrl || proposalPageUrl || null;
    const paymentLink = payment.reached && payment.paymentUrl && payment.paymentUrl !== proposalLink ? payment.paymentUrl : null;
    ({ saved } = await saveLinks({ proposalLink, paymentLink }, data, jobId));
  } catch (e) {
    log(`[${jobId}] ⚠️ Could not save the links (${e && e.message})`);
  }
  if (!(error && error.portalRejected)) {
    // a portal refusal already wrote its own, more exact, note; every other way needs one
    try {
      await saveStatus(kycGenericReasonText(error && (error.reason || error.message)), data, jobId);
    } catch (e) {
      log(`[${jobId}] ⚠️ Could not save the KYC note (${e && e.message})`);
    }
  }

  let shot = { url: null, key: null };
  try {
    shot = await flushed;
  } catch (e) {
    /* flush never rejects; belt and braces */
  }

  const message = `${failure} ${paymentSentence({ payment, saved, proposalNumber: proposal })}`.replace(/\s+/g, " ").trim();
  return { message, screenshotUrl: shot.url || null, screenshotKey: shot.key || null, payment, saved };
}

module.exports = {
  PENDING_QUOTES_PATH,
  KycIncompleteError,
  createKycShotKeeper,
  findProposalCheckboxInPage,
  findControlInPage,
  findPendingQuotesHrefInPage,
  readPaymentPageInPage,
  reachPaymentPage,
  saveProcessLinks,
  saveCurrentPageLink,
  clearStaleProcessLinks,
  hostOf,
  paymentSentence,
  genericFailureSentence,
  rescueAfterKycFailure,
};
