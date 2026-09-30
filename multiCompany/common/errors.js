/**
 * The ONE error type every multiCompany handler throws, and the ONE result
 * shape it returns when it fails.
 *
 * Why this exists: each insurer's legacy flow reports failure its own way
 * (Reliance throws a tagged string, National throws an untagged one, KSHEMA
 * returns an object), so the same wrong password ended up as a 25-login retry
 * storm on one portal and a single clean failure on another. Here a failure
 * carries its own code and its own retry decision, and server.js acts on those
 * — never on guesses from the message wording.
 *
 * Codes and their retry defaults come from lib/errorHandler.js ERROR_CODES, so
 * there is still one catalogue, not a second one:
 *   E202 captcha failed (retry)   E203 invalid credentials (no retry)
 *   E204 account locked/OTP (no)  E205 no credentials (no)
 *   E302 timeout (retry)          E304 page failed to load (retry)
 *   E306 dropdown/field fill failed (retry)   E110 feature disabled (no)
 */
const { ERROR_CODES, classifyError } = require("../../lib/errorHandler");

const RETRYABLE_BY_CODE = Object.values(ERROR_CODES).reduce((map, entry) => {
  map[entry.code] = entry.retryable;
  return map;
}, {});

class MultiCompanyError extends Error {
  /**
   * @param {string} code    ERROR_CODES code, e.g. "E203"
   * @param {string} message Operator-facing sentence (no code prefix)
   * @param {Object} [opts]
   * @param {boolean} [opts.retryable]      overrides the code's default
   * @param {string}  [opts.stage]          where it failed ("login", "vehicle_identity", ...)
   * @param {string}  [opts.portalMessage]  the portal's own words, verbatim, if it gave any
   * @param {string}  [opts.company]        "reliance" | "national" | "kshema"
   */
  constructor(code, message, opts = {}) {
    // The [Ennn] prefix is what classifyError honours on server.js's
    // exception path, so a MultiCompanyError classifies correctly even if it
    // is thrown instead of returned.
    super(`[${code}] ${message}`);
    this.name = "MultiCompanyError";
    this.code = code;
    this.friendly = message;
    this.retryable =
      typeof opts.retryable === "boolean"
        ? opts.retryable
        : RETRYABLE_BY_CODE[code] !== undefined
          ? RETRYABLE_BY_CODE[code]
          : true;
    this.stage = opts.stage || "login";
    this.portalMessage = opts.portalMessage || "";
    this.company = opts.company || "";
  }
}

const isMultiCompanyError = (e) => e instanceof MultiCompanyError || e?.name === "MultiCompanyError";

/**
 * Turn any error into the result object server.js already understands
 * (`success:false`, `retryable`, `stage`, `error`, screenshot fields) plus an
 * `errorCode` that server.js records as-is instead of a blanket E300.
 *
 * `onPageError` is deliberately NOT set: server.js prefers it over `error`,
 * which would replace our sentence with the portal's bare text. The portal's
 * words travel inside `error` and separately as `portalMessage`.
 */
function failureResult(error, extra = {}) {
  const known = isMultiCompanyError(error);
  const classified = known ? null : classifyError(error);
  return {
    success: false,
    errorCode: known ? error.code : classified.code,
    retryable: known ? error.retryable : classified.retryable,
    stage: known ? error.stage : "login",
    error: known ? error.friendly : String(error?.message || error),
    portalMessage: known ? error.portalMessage : "",
    ...extra,
  };
}

module.exports = { MultiCompanyError, isMultiCompanyError, failureResult };
