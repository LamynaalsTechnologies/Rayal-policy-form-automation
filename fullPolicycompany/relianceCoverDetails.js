/**
 * Reliance full-company — what the portal answered to "Get Coverage Details".
 *
 * Reliance answers inside #DivCoverDetails: either the cover table (PA to Owner Driver ChkBox24, Zero Depreciation
 * ChkBox10, Helmet ChkBox500, the TPPD list ...) or, when it refuses, ONLY a sentence, e.g.
 *
 *   <div class="blocks" id="DivCoverDetails" style="display: block;">No Discount available for mentioned
 *   Details.Please Contact Corporate Motor Underwriter ErrorCode - BZ|004|14102609663573|BZ|002|14102609409445</div>
 *
 * The flow used to go straight to ChkBox24 — which can then never appear — and the job was reported as "PA to Owner
 * Driver checkbox not found" after a 10 s wait, with Reliance's actual words lost. This file reads the div, tells a
 * refusal from a table that is still loading, and words the failure for the operator.
 *
 * RELIANCE_COVER_DETAILS_CHECK_ENABLED in the automation's .env: ON unless it is explicitly false / 0 / no / off.
 *   on (the default): after Get Coverage Details the flow waits for ChkBox24 OR a refusal in #DivCoverDetails and
 *        fails at once, with the portal's words, on a refusal.
 *   off: the old behaviour — straight to the ChkBox24 wait.
 * Read at CALL time, so a restart after editing .env is all it needs and a test can flip it.
 *
 * What it will NOT do: change the discount. A different discount is a different premium than the one the customer
 * was quoted; the discount lives in the Make & Model master (or the user's own make/model discount) and is fixed there.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

/** A refusal is a sentence. Anything longer is a page we do not understand — never call it a refusal. */
const MAX_MESSAGE_LENGTH = 600;

/**
 * What a refusal reads like. Used to FAIL FAST, where a wrong "yes" would fail a policy that was about to load, so it
 * is deliberately tight; "ErrorCode" is the marker every Reliance business error carries.
 */
const ERROR_TEXT_RE =
  /error\s*code|please contact|no discount|not available|unavailable|not allowed|not eligible|invalid|unable to|failed|exceed/i;

function isCoverDetailsCheckEnabled() {
  return !isOff(process.env.RELIANCE_COVER_DETAILS_CHECK_ENABLED);
}

/**
 * Runs IN THE PAGE: selenium serialises this function's source, so it must stay self-contained (no closure
 * variables, no helpers from this file).
 *
 * @returns {{exists:boolean, shown:boolean, hasPaCheckbox:boolean, controls:number, text:string}}
 *   controls = inputs / selects / textareas / tables / buttons inside #DivCoverDetails — the cover table has them,
 *   a refusal sentence has none.
 */
function readCoverDetailsInPage() {
  var box = document.getElementById("DivCoverDetails");
  var info = {
    exists: !!box,
    shown: false,
    hasPaCheckbox: !!document.getElementById("ChkBox24"),
    controls: 0,
    text: "",
  };
  if (!box) return info;
  var style = window.getComputedStyle(box);
  info.shown =
    style.display !== "none" && style.visibility !== "hidden" && (box.offsetHeight > 0 || box.offsetWidth > 0);
  info.controls = box.querySelectorAll("input, select, textarea, table, button").length;
  info.text = String(box.innerText || box.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  return info;
}

const EMPTY = { exists: false, shown: false, hasPaCheckbox: false, controls: 0, text: "" };

/** One read of #DivCoverDetails. Never throws: a page that is navigating or a driver that is gone reads as empty. */
async function readCoverDetails(driver) {
  try {
    const info = await driver.executeScript(readCoverDetailsInPage);
    return info && typeof info === "object" ? { ...EMPTY, ...info } : { ...EMPTY };
  } catch (e) {
    return { ...EMPTY };
  }
}

/**
 * Is #DivCoverDetails showing a refusal sentence — and nothing else?
 *
 * @param {Object} info  from readCoverDetails
 * @param {Object} [opts]
 * @param {boolean} [opts.strict=true]  true: the sentence must also READ like an error (use while the flow could
 *   still succeed). false: any short sentence will do (use after the flow has already failed — a div that holds
 *   only a sentence, and no cover table, is the cause).
 */
function isCoverDetailsRejection(info, { strict = true } = {}) {
  if (!info || !info.exists || !info.shown) return false;
  if (info.hasPaCheckbox || info.controls > 0) return false;
  const text = String(info.text || "").trim();
  if (!text || text.length > MAX_MESSAGE_LENGTH) return false;
  return strict ? ERROR_TEXT_RE.test(text) : true;
}

/**
 * Wait until the cover table is there (ChkBox24) or Reliance has refused.
 *
 * `rejected` needs the SAME refusal text on every read for `stableMs`: the flow fires Get Coverage Details up to
 * four ways, and a message that is replaced by the cover table a moment later must not fail the policy. When
 * neither happens the caller carries on to its own ChkBox24 wait, so the worst case is today's behaviour.
 *
 * @returns {Promise<{state:"loaded"}|{state:"rejected", text:string}|{state:"timeout", text:string}>}
 */
async function waitForCoverDetails(
  driver,
  { timeoutMs = 6000, pollMs = 500, stableMs = 1000, now = Date.now, sleep = (ms) => driver.sleep(ms) } = {}
) {
  const deadline = now() + timeoutMs;
  let seenText = null;
  let seenSince = 0;
  for (;;) {
    const info = await readCoverDetails(driver);
    if (info.hasPaCheckbox) return { state: "loaded" };

    if (isCoverDetailsRejection(info)) {
      const t = now();
      if (info.text !== seenText) {
        seenText = info.text;
        seenSince = t;
      }
      if (t - seenSince >= stableMs) return { state: "rejected", text: info.text };
    } else {
      seenText = null;
    }

    if (now() >= deadline) return { state: "timeout", text: info.text || "" };
    await sleep(pollMs);
  }
}

/** A colon in the portal's words would let beautifyError's root-cause trimming cut the sentence in half. */
const plain = (value) =>
  String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .replace(/\s*:\s*/g, " - ")
    .trim();

/** What the flow typed into the portal for this policy, for the operator's sentence. */
function sentDetails(data = {}) {
  return {
    discount: data.discount,
    vehicle: [data.vehicleMake, data.vehicleModel].filter(Boolean).join(" "),
    rto: data.rtoCityLocation,
  };
}

/**
 * The sentence the operator reads in the policy's error log. Names what Reliance said (verbatim — support will ask
 * for the error code), what was sent, and what to fix; says plainly the policy has to be run again.
 * No colons outside the portal's own words, which `plain` strips of theirs.
 */
function coverDetailsFailureMessage(text, { discount, vehicle, rto } = {}) {
  const portal = plain(text);

  const sent = [];
  const digits = String(discount == null ? "" : discount).replace(/[^0-9.]/g, "");
  if (digits !== "" && Number.isFinite(Number(digits))) sent.push(`OD discount sent ${Number(digits)}%`);
  if (plain(vehicle)) sent.push(`vehicle ${plain(vehicle)}`);
  if (plain(rto)) sent.push(`RTO ${plain(rto)}`);
  const details = sent.length ? ` (${sent.join(", ")})` : "";

  if (/no discount available/i.test(portal)) {
    return (
      `No discount is available for the details entered, so the portal did not return the cover details${details}. ` +
      `The portal said "${portal}". ` +
      `Set a discount Reliance offers for this make and model (Make & Model master, or the user's own make/model ` +
      `discount) or ask Reliance's Corporate Motor Underwriter with that error code, then run the policy again.`
    );
  }
  return (
    `The portal did not return the cover details${details}. ` +
    `The portal said "${portal}". ` +
    `Check the vehicle and discount details on the policy, or ask Reliance's Corporate Motor Underwriter with that ` +
    `message, then run the policy again.`
  );
}

/**
 * For the error-screenshot handler, after something has ALREADY failed: is the cover section only a sentence?
 * Lenient on purpose (see isCoverDetailsRejection). Null when the switch is off, there is no such sentence, or the
 * page cannot be read.
 *
 * @returns {Promise<{text:string, message:string}|null>}
 */
async function readCoverDetailsRejection(driver, data = {}) {
  if (!isCoverDetailsCheckEnabled()) return null;
  const info = await readCoverDetails(driver);
  if (!isCoverDetailsRejection(info, { strict: false })) return null;
  return { text: info.text, message: coverDetailsFailureMessage(info.text, sentDetails(data)) };
}

/** Words that make a banner a complaint even when it also says "successfully". */
const FAILURE_WORDS_RE =
  /error|fail|unable|cannot|can not|could not|not (?:be |been )?(?:saved|found|allowed|available|valid|eligible)|invalid|please (?:provide|enter|select|contact)|mandatory|required/i;

/**
 * Is this banner Reliance reporting SUCCESS ("Proposal Saved Successfully. The Proposal number is:R14102611761 & ...")?
 * #containerMain also carries that banner, and the error-screenshot handler used to take whatever #containerMain
 * held as THE error — so a run that failed AFTER the proposal was saved was recorded as "Proposal Saved
 * Successfully", and the real reason was lost.
 */
function isPortalSuccessMessage(text) {
  const t = String(text == null ? "" : text).trim();
  return t.length > 0 && /\bsuccess(?:fully)?\b/i.test(t) && !FAILURE_WORDS_RE.test(t);
}

module.exports = {
  isPortalSuccessMessage,
  isCoverDetailsCheckEnabled,
  readCoverDetailsInPage,
  readCoverDetails,
  isCoverDetailsRejection,
  waitForCoverDetails,
  coverDetailsFailureMessage,
  readCoverDetailsRejection,
  sentDetails,
  MAX_MESSAGE_LENGTH,
};
