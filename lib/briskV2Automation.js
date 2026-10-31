/**
 * The Brisk PA certificate through OUR server's new Brisk API code (RayalBrokers-backend "Brisk V2",
 * POST /api/briskV2/automation/certificates) instead of production's /createBriskCertificate.
 *
 * Switch (.env, restart the automation after editing):
 *   BRISK_V2_AUTOMATION_ENABLED  exactly "true" = on. Anything else (the default) = the old production call, unchanged.
 *   BRISK_V2_BACKEND_URL         the server's API base, e.g. http://localhost:4005/api
 *   BRISK_V2_AUTOMATION_KEY      the same key as the server's BRISK_V2_AUTOMATION_KEY (16+ characters)
 *   BRISK_V2_AUTOMATION_TIMEOUT_MS  how long to wait for the server (default 150000; Brisk's create alone may take 60 s)
 *
 * The server does the rest: it matches the policy's make / model / relation / gender to Brisk's own lists, never
 * charges (the PA was paid with the policy), answers the SAME certificate when asked again for the same policy, and
 * saves every request sent to Brisk and Brisk's answer on the certificate (shown on the Online Policy View page).
 *
 * Answers, in the shape createBriskCertificate always returned (briskPartRunner.js and the inline flows read them):
 *   LIVE certificate made        -> { success: true, policyId: <certificate number>, downloadUrl }
 *   TEST certificate made        -> throws: a TEST certificate must never be stored on a real policy
 *   refused (Brisk or the server)-> throws the server's sentence (nothing was bought, a re-run is safe)
 *   not known whether it was made-> { success: false, message } with NO number, so briskPartRunner says "check Brisk
 *                                   before running this again"; a re-run is still safe (the server answers the
 *                                   certificate it made, or says it is still unclear)
 */
const DEFAULT_TIMEOUT_MS = 150000;
const MIN_KEY = 16;

const isEnabled = (env = process.env) => String(env.BRISK_V2_AUTOMATION_ENABLED || "").trim().toLowerCase() === "true";

/** The Online Policy _id of the job's data (a string, an ObjectId or an exported { $oid }). */
const policyIdOf = (data = {}) => {
  for (const v of [data._id, data.onlinePolicyId, data.captchaId]) {
    if (!v) continue;
    const id = typeof v === "object" && v.$oid ? v.$oid : String(v);
    if (/^[0-9a-fA-F]{24}$/.test(id)) return id;
  }
  return "";
};

const readSettings = (env = process.env) => {
  const baseUrl = String(env.BRISK_V2_BACKEND_URL || "").trim().replace(/\/+$/, "");
  const key = String(env.BRISK_V2_AUTOMATION_KEY || "").trim();
  const timeout = Number(env.BRISK_V2_AUTOMATION_TIMEOUT_MS);
  const problems = [];
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) problems.push("BRISK_V2_BACKEND_URL is not set");
  if (key.length < MIN_KEY) problems.push("BRISK_V2_AUTOMATION_KEY is not set");
  return { baseUrl, key, timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS, problems };
};

/** Connection refused / unknown host: the request never reached the server, so nothing can have been bought. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);
const errorCode = (err) => (err && ((err.cause && err.cause.code) || err.code)) || "";

async function createViaBackend(data = {}, { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const jobId = data._jobIdentifier || "";
  const tag = `[${jobId}] Brisk V2 |`;
  const settings = readSettings(env);
  if (settings.problems.length) {
    throw new Error(`Brisk certificate not bought. ${settings.problems.join(" and ")} in the automation .env`);
  }
  const onlinePolicyId = policyIdOf(data);
  if (!onlinePolicyId) throw new Error("Brisk certificate not bought. The job has no Online Policy id to send the server");

  const url = `${settings.baseUrl}/briskV2/automation/certificates`;
  log(`${tag} asking the server for policy ${onlinePolicyId}'s certificate`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  let res;
  let text = "";
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-brisk-automation-key": settings.key },
      body: JSON.stringify({ onlinePolicyId, jobId: String(jobId) }),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (NOT_SENT_CODES.has(errorCode(err))) {
      throw new Error(`Brisk certificate not bought. Could not reach the server at ${settings.baseUrl} (${errorCode(err)})`);
    }
    const why = controller.signal.aborted ? `no answer in ${Math.round(settings.timeoutMs / 1000)} s` : (err && err.message) || String(err);
    return { success: false, unknown: true, message: `The server did not answer (${why}). It may have bought the certificate; running the job again answers the same one` };
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = null;
  }
  if (!res.ok || !body || typeof body !== "object") {
    return { success: false, unknown: true, message: `The server answered HTTP ${res.status} without a result. Check the Brisk Certificate List before running this again` };
  }

  if (body.error) {
    log(`${tag} server said ${body.code || "error"} - ${body.message}`);
    if (body.code === "UNKNOWN_OUTCOME" || body.code === "IN_PROGRESS") return { success: false, unknown: true, message: body.message };
    if (body.code === "POLICY_HAS_CERTIFICATE" && body.data) {
      const certificateNo = String(body.data.certificateNo || "");
      log(`${tag} policy already has a Brisk certificate${certificateNo ? ` ${certificateNo}` : ""}; skipping another purchase`);
      return {
        success: true,
        alreadyExisted: true,
        policyId: certificateNo,
        downloadUrl: body.data.downloadUrl || "",
        viaBackend: true,
      };
    }
    throw new Error(body.message || "The server refused the Brisk certificate");
  }

  const d = body.data || {};
  if (d.apiEnv !== "LIVE") {
    const no = d.certificateNo ? ` ${d.certificateNo}` : "";
    throw new Error(
      `Brisk TEST certificate${no} was made on the TEST account, so it is not stored on this policy. The PA certificate is still not bought on the live Brisk account`
    );
  }
  if (!d.certificateNo) return { success: false, unknown: true, message: body.message || "The server answered without a certificate number" };
  log(`${tag} certificate ${d.certificateNo}${d.replayed ? " (already made earlier)" : ""}`);
  return {
    success: true,
    message: body.message,
    policyId: d.certificateNo,
    downloadUrl: d.downloadUrl || "",
    recordId: d.recordId,
    viaBackend: true,
  };
}

module.exports = { isEnabled, createViaBackend, policyIdOf, readSettings, DEFAULT_TIMEOUT_MS };
