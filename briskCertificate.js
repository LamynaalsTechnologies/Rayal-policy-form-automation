/**
 * Brisk CPA/RSA certificate creation — shared by every insurer flow.
 *
 * This lived inside relianceForm.js, so National policies with PA Cover
 * provided by Brisk silently never got a certificate: national.js had no Brisk
 * code at all. Rather than copy ~600 lines into it (and let the two drift), the
 * whole thing moved here and both flows import it.
 *
 * Nothing in here touches Selenium or any insurer's page — it is purely the
 * Brisk API call, the PDF download, and storing the result on the policy.
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const axios = require("axios");
const moment = require("moment");
const AWS = require("aws-sdk");
require("dotenv").config();

// Same credentials/region relianceForm.js used before this code moved here —
// uploadBriskCertificate puts the certificate PDF in this bucket.
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_S3_ACCESSKEY_ID,
  secretAccessKey: process.env.AWS_S3_SECRET_ACCESSKEY,
  region: "ap-south-1",
});

/**
 * Helper function to convert state code to state name
 * @param {string} stateCode - State code (e.g., "30")
 * @returns {string} - State name
 */
function getStateName(stateCode) {
  const stateMap = {
    // NOTE: "30" and "26" are the Reliance portal codes produced by server.js
    // formData (30 = TAMILNADU, 26 = KARNATAKA) — not GST codes
    "30": "TAMIL NADU",
    "26": "KARNATAKA",
    "33": "TAMIL NADU",
    "29": "KERALA",
    "32": "TELANGANA",
    "28": "ANDHRA PRADESH",
    "27": "MAHARASHTRA",
    "07": "DELHI",
    "19": "WEST BENGAL",
    "10": "BIHAR",
    "09": "UTTAR PRADESH",
    "24": "GUJARAT",
    "23": "MADHYA PRADESH",
    "22": "CHHATTISGARH",
    "21": "ODISHA",
    "20": "JHARKHAND",
    "18": "ASSAM",
    "06": "HARYANA",
    "03": "PUNJAB",
    "02": "HIMACHAL PRADESH",
    "01": "JAMMU AND KASHMIR",
    "35": "ANDAMAN AND NICOBAR ISLANDS",
    "31": "LAKSHADWEEP",
    "34": "PUDUCHERRY",
    "04": "CHANDIGARH",
    "25": "GOA",
    "05": "UTTARAKHAND",
    "36": "LADAKH",
    "11": "SIKKIM",
    "12": "ARUNACHAL PRADESH",
    "13": "NAGALAND",
    "14": "MANIPUR",
    "15": "MIZORAM",
    "16": "TRIPURA",
    "17": "MEGHALAYA",
    "08": "RAJASTHAN"
  };
  return stateMap[stateCode] || "TAMIL NADU";
}

// Brisk accepts only this exact set of nominee relations (they mirror the
// dropdown on the Brisk UI page). The policy form stores relations
// UPPERCASED ("SON"), which Brisk rejects — map onto its own casing.
const BRISK_RELATIONS = [
  "Father", "Mother", "Wife", "Husband",
  "Sister", "Son", "Daughter", "Brother",
];

const toBriskRelation = (relation) => {
  const norm = String(relation || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (!norm) return "Son";
  const exact = BRISK_RELATIONS.find((r) => r.toUpperCase() === norm);
  if (exact) return exact;
  // Common synonyms from the policy form
  const synonyms = {
    SPOUSE: "Wife", WIFE: "Wife", HUSBAND: "Husband",
    DAD: "Father", MOM: "Mother", MOTHER: "Mother", FATHER: "Father",
    SELF: "Son", CHILD: "Son", DAUGHTER: "Daughter", SON: "Son",
  };
  return synonyms[norm] || "Son";
};

/** Brisk expects "Male" / "Female"; the policy stores "male"/"female"/"other". */
const toBriskGender = (gender) => {
  const g = String(gender || "").trim().toLowerCase();
  if (g.startsWith("f")) return "Female";
  return "Male";
};

/**
 * Wallet pre-check, mirroring the Brisk UI page.
 *
 * BriskCreateCertificate.js refuses to call the create API when the master
 * wallet cannot cover the premium:
 *     if (Number(data.totalPremium) > walletBalance) -> "Insufficient wallet balance"
 * The automation skipped this and called anyway. Brisk validates the request
 * first (returning a clear message like "Age Should be between 18 to 70
 * years"), but a VALID request goes on to the wallet deduction — and when that
 * fails Brisk answers without a Message, which the backend reports as the
 * useless "Something went wrong".
 *
 * Returns { ok, balance, reason }. Never throws: if the balance cannot be read
 * we let the call proceed rather than blocking on a diagnostic.
 */
const checkBriskWallet = async (requiredAmount, jobId = "") => {
  try {
    const axios = require("axios");
    const res = await axios.get(`${BRISK_API_BASE}/getBriskWalletAmount`, { timeout: 20000 });
    const body = res?.data;

    if (body?.error) {
      console.warn(
        `[${jobId}] ⚠️ Brisk wallet lookup failed: ${body?.message || "unknown"} — the Brisk account may be unavailable.`
      );
      return { ok: true, balance: null, reason: "wallet-unreadable" };
    }

    const balance = Number(
      body?.data?.balance ?? body?.balance ?? body?.data?.Balance
    );
    if (!Number.isFinite(balance)) {
      return { ok: true, balance: null, reason: "wallet-unreadable" };
    }

    console.log(`[${jobId}] 💰 Brisk wallet balance: ${balance} (need ${requiredAmount})`);
    if (balance < requiredAmount) {
      return {
        ok: false,
        balance,
        reason: `Insufficient Brisk wallet balance: need ₹${requiredAmount}, available ₹${balance}`,
      };
    }
    return { ok: true, balance, reason: null };
  } catch (e) {
    console.warn(`[${jobId}] ⚠️ Could not read Brisk wallet balance: ${e.message}`);
    return { ok: true, balance: null, reason: "wallet-unreadable" };
  }
};

/**
 * Brisk expects the SAME date shape the Brisk UI page sends — an ISO string
 * ("2026-07-28T18:30:00.000Z"), because that page uses a DatePicker and posts
 * the raw Date. The automation was sending "17-11-1995" (DD-MM-YYYY), which
 * the backend then re-parsed with an ambiguous MM/DD guess.
 */
const toBriskIsoDob = (value) => {
  if (!value) return null;
  if (value instanceof Date && !isNaN(value)) return value.toISOString();
  const raw = String(value).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  // buildFullJobFormData produces DD-MM-YYYY, so try that first.
  const parsed = moment(raw, ["DD-MM-YYYY", "YYYY-MM-DD", "MM-DD-YYYY"], true);
  return parsed.isValid() ? parsed.toDate().toISOString() : null;
};

// ---------------------------------------------------------------------------
// Brisk make/model resolution
//
// Brisk keeps its OWN vehicle catalogue, with its own spellings ("Hero
// Motocorp", "BAJAJ auto ltd", …). The Brisk UI works because the operator
// picks Make and Model from dropdowns fed by that catalogue.
//
// The automation was sending the RELIANCE policy's values straight through —
// e.g. "HERO MOTOCORP LTD" / "SUPER SPLENDOR XTEC 2.0" — which do not exist in
// Brisk's list, and the API answered every one of them with a bare
// 500 "Something went wrong".
//
// So we look the values up in the real catalogue first and send Brisk the
// exact strings it knows. Lists are cached for the process lifetime.
// ---------------------------------------------------------------------------
const BRISK_API_BASE = (
  process.env.BRISK_CERT_API_URL || "https://coreapi.rayalbrokers.com/api/createBriskCertificate"
).replace(/\/createBriskCertificate.*$/, "");

let briskMakeCache = null;
const briskModelCache = new Map();

const briskGet = async (path) => {
  const axios = require("axios");
  const res = await axios.get(`${BRISK_API_BASE}${path}`, { timeout: 20000 });
  const payload = res?.data?.data;
  const list = Array.isArray(payload) ? payload : payload?.data;
  return Array.isArray(list) ? list : [];
};

const normalizeCatalogValue = (v) =>
  String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Words that carry no identifying value when matching a manufacturer. */
const MAKE_NOISE = /\b(LTD|LIMITED|PVT|PRIVATE|INDIA|MOTORS?|MOTOCORP|COMPANY|CO|AUTO|VEHICLES?)\b/gi;

/**
 * Best entry in `catalog` for `query`, or null when nothing is close enough.
 * Scored: exact > one contains the other > shared words.
 */
const bestCatalogMatch = (query, catalog, { stripNoise = false } = {}) => {
  const raw = String(query || "").trim();
  if (!raw || !Array.isArray(catalog) || catalog.length === 0) return null;

  const q = normalizeCatalogValue(raw);
  const qLoose = stripNoise ? normalizeCatalogValue(raw.replace(MAKE_NOISE, " ")) : q;
  const qWords = raw.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);

  let best = null;
  let bestScore = 0;

  for (const entry of catalog) {
    const e = normalizeCatalogValue(entry);
    if (!e) continue;

    let score = 0;
    if (e === q) score = 100;
    else if (qLoose && e === qLoose) score = 95;
    else if (q.includes(e) || e.includes(q)) score = 80 - Math.abs(e.length - q.length);
    else if (qLoose && (qLoose.includes(e) || e.includes(qLoose))) score = 70 - Math.abs(e.length - qLoose.length);
    else {
      const eUpper = String(entry).toUpperCase();
      const hits = qWords.filter((w) => eUpper.includes(w)).length;
      if (hits > 0) score = 30 + hits * 10 - Math.abs(e.length - q.length) / 10;
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  // Below this the "match" is more likely to be noise than a real hit.
  return bestScore >= 40 ? best : null;
};

/**
 * Translate the policy's make/model into the exact strings Brisk expects.
 * Never throws: on any failure the original values are kept (previous
 * behaviour) and the reason is logged.
 */
const resolveBriskVehicle = async (make, model, jobId = "") => {
  const result = { Make: make, Model: model, matched: false };
  try {
    if (!briskMakeCache) briskMakeCache = await briskGet("/briskMakeList");

    const matchedMake = bestCatalogMatch(make, briskMakeCache, { stripNoise: true });
    if (!matchedMake) {
      console.warn(
        `[${jobId}] ⚠️ Brisk has no make matching "${make}" — sending it unchanged (Brisk may reject it).`
      );
      return result;
    }
    result.Make = matchedMake;
    if (normalizeCatalogValue(matchedMake) !== normalizeCatalogValue(make)) {
      console.log(`[${jobId}] 🔁 Brisk make "${make}" -> "${matchedMake}"`);
    }

    if (!briskModelCache.has(matchedMake)) {
      // Production exposes this as a PATH param (/briskModelList/<make>);
      // ?make= returns "Cannot GET". The query form is kept as a fallback in
      // case the deployed route changes back.
      let models = [];
      try {
        models = await briskGet(`/briskModelList/${encodeURIComponent(matchedMake)}`);
      } catch (pathErr) {
        models = await briskGet(`/briskModelList?make=${encodeURIComponent(matchedMake)}`);
      }
      briskModelCache.set(matchedMake, models);
    }
    const models = briskModelCache.get(matchedMake) || [];

    const matchedModel = bestCatalogMatch(model, models);
    if (matchedModel) {
      result.Model = matchedModel;
      result.matched = true;
      if (normalizeCatalogValue(matchedModel) !== normalizeCatalogValue(model)) {
        console.log(`[${jobId}] 🔁 Brisk model "${model}" -> "${matchedModel}"`);
      }
    } else if (models.length > 0) {
      // A valid make with an unrecognised model still fails, so fall back to a
      // real entry from this make rather than sending something Brisk rejects.
      result.Model = models[0];
      console.warn(
        `[${jobId}] ⚠️ Brisk has no model matching "${model}" for ${matchedMake} — falling back to "${models[0]}".`
      );
    }
  } catch (e) {
    console.warn(`[${jobId}] ⚠️ Could not resolve Brisk vehicle catalogue: ${e.message}`);
  }
  return result;
};

async function createBriskCertificate(data) {
  // Translate the policy's vehicle make/model into the exact strings Brisk's
  // own catalogue uses, before building the payload.
  const briskVehicle = await resolveBriskVehicle(
    data.vehicleMake || data.make,
    data.vehicleModel || data.model,
    data._jobIdentifier || ""
  );

  // Premium, split exactly the way the Brisk UI page does it (verified against
  // a real working request: 200 -> net 169.49 + gst 30.51, i.e. 18% GST with
  // net = total / 1.18). Sent as STRINGS, like that page.
  const paCoverPremium =
    Number(data.paCoverAmount || data.flaxprice || data.Flaxprice || 244) || 244;
  const briskNetPremium = Number((paCoverPremium / 1.18).toFixed(2));
  const briskGst = Number((paCoverPremium - briskNetPremium).toFixed(2));

  // Same guard the Brisk UI page applies before it calls create — it refuses
  // when the master wallet cannot cover the premium.
  const wallet = await checkBriskWallet(paCoverPremium, data._jobIdentifier || "");
  if (!wallet.ok) {
    throw new Error(wallet.reason);
  }

  return new Promise((resolve, reject) => {
    // Helper function to format date from MongoDB date object or ISO string
    const formatDate = (dateValue, fallback = "01-01-2000") => {
      if (!dateValue) return fallback;
      try {
        let date;
        if (dateValue.$date) {
          date = new Date(dateValue.$date);
        } else if (typeof dateValue === 'string') {
          date = new Date(dateValue);
        } else if (dateValue instanceof Date) {
          date = dateValue;
        } else {
          return fallback;
        }

        // Check if date is valid
        if (isNaN(date.getTime())) {
          console.warn("Invalid date detected, using fallback:", fallback);
          return fallback;
        }

        // Format as MM-DD-YYYY
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const year = date.getFullYear();
        return `${month}-${day}-${year}`;
      } catch (e) {
        console.error("Error formatting date:", e.message);
        return fallback;
      }
    };

    // Prepare the payload
    const payload = {
      CustomerName: data.customerName || `${data.fullName || data.firstName || "TESTING"} ${data.surname || data.lastName || ""}`.trim(),
      MobileNo: data.mobileNumber || data.mobile || data.mobileNo || "6789054367",
      EmailID: data.email || data.emailID || "test@gmail.com",
      City: data.city || "CHENNAI",
      State: getStateName(data.state) || "TAMIL NADU",
      // Real values, mapped onto the exact strings Brisk accepts. These were
      // hardcoded to "Male"/passed through raw, so an UPPERCASED relation from
      // the policy form ("SON") reached Brisk unchanged.
      CustomerGender: toBriskGender(data.gender || data.customerGender),
      NomineeName: data.nomineeName || "FERNANDO",
      NomineeGender: toBriskGender(data.nomineeGender || data.gender),
      Relation: toBriskRelation(data.nomineeRelation || data.relation),
      // Resolved against Brisk's catalogue above — sending Reliance's own
      // spelling (e.g. "HERO MOTOCORP LTD") made Brisk fail with a bare 500.
      Make: briskVehicle.Make || data.vehicleMake || data.make || "DACUS",
      Model: briskVehicle.Model || data.vehicleModel || data.model || "GOLD PLUS",
      EngineNo: data.engineNumber || data.engineNo || "674r56732",
      ChassisNo: data.chassisNumber || data.chassisNo || "567r74w",
      RegistrationNo: data.registrationNo || data.registrationNumber || "tyu66456",
      PaymentMode: data.paymentMode || "FromWallet",
      Address_Line1: data.addressLine1 || data.address_Line1 || `${data.flatDoorNo || data.flatNo || "TEST"} ${data.buildingName || data.premisesName || "ADDR 1"}`.trim(),
      Address_Line2: data.addressLine2 || data.address_Line2 || `${data.roadStreetLane || data.road || "TEST"} ${data.areaAndLocality || data.area || "ADDR 2"}`.trim(),
      // Plan must exist in the live Brisk plan list (GET /briskPlanList) —
      // stale plan names make the Brisk API fail with "Something went wrong".
      // Current live plan is the FLAX (flexible-price) plan; Flaxprice below
      // sets the actual amount. Override with BRISK_PLAN_NAME in .env.
      PlanName: data.planName || process.env.BRISK_PLAN_NAME || "FLAXTWHRT40K5S",
      // ISO, matching the Brisk UI page (see toBriskIsoDob).
      CustomerDOB:
        toBriskIsoDob(data.dateOfBirth || data.dob || data.customerDOB) ||
        new Date("2000-01-01").toISOString(),

      // ── Premium fields ────────────────────────────────────────────────────
      // Mirror the working Brisk UI page (BriskCreateCertificate.js) exactly.
      //
      // That page sends totalPremium / netPremium / gst / minimumPremium and
      // does NOT send Flaxprice, loginid, VehicleType or Gstno — the backend
      // derives all four itself:
      //     receivedData.Flaxprice = receivedData.Flaxprice || totalPremium || "244"
      //     receivedData.loginid   = process.env.BRISK_LOGIN_ID
      //     receivedData.VehicleType = "TW"; receivedData.Gstno = "";
      //
      // The automation used to do the opposite: omit the premium fields and
      // send Flaxprice as a STRING plus its own loginid. That made the final
      // payload structurally different from the one Brisk accepts. Sending the
      // same shape as the UI removes every remaining difference.
      totalPremium: String(paCoverPremium),
      netPremium: String(briskNetPremium),
      gst: String(briskGst),
      minimumPremium: 0,
      policyType: data.policyType || "CPA/RSA"
    };

    console.log("📤 Sending Brisk Certificate request with payload:", JSON.stringify(payload, null, 2));

    const postData = JSON.stringify(payload);

    // Extract userId from data (handle both string and MongoDB ObjectId format)
    const userId = data.userId?.$oid || data.userId || '65a343220a6016a8f93424e7';

    // Full endpoint URL, overridable via env (e.g. https://motorapi.rayal.in/motor/api/createBriskCertificate)
    const briskApiUrl =
      "https://coreapi.rayalbrokers.com/api/createBriskCertificate";
    const parsedUrl = new URL(briskApiUrl);
    const httpModule = parsedUrl.protocol === "https:" ? https : http;

    console.log(`🌐 Brisk Certificate endpoint: ${briskApiUrl}`);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'clientid': userId,
        'userid': userId
      }
    };

    const req = httpModule.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        console.log(`📥 Brisk API Response Status: ${res.statusCode}`);
        console.log(`📥 Brisk API Response: ${responseData}`);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedResponse = JSON.parse(responseData);

            // Check if API returned an error
            if (parsedResponse.error === true) {
              reject(new Error(parsedResponse.message || "API returned an error"));
              return;
            }

            // Extract the important data
            const result = {
              success: true,
              message: parsedResponse.message,
              policyId: parsedResponse.data?.policyId,
              downloadUrl: parsedResponse.data?.downloadUrl,
              fullResponse: parsedResponse
            };

            console.log(`✅ Brisk Certificate created - Policy ID: ${result.policyId}`);
            console.log(`📄 Download URL: ${result.downloadUrl}`);

            resolve(result);
          } catch (e) {
            console.error("❌ Error parsing response:", e.message);
            resolve({ success: true, raw: responseData });
          }
        } else {
          reject(new Error(`API returned status ${res.statusCode}: ${responseData}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error("❌ Error calling Brisk API:", error.message);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}


/**
 * Upload the Brisk certificate PDF to S3 and record it on the policy.
 *
 * Previously the certificate was only downloaded to a local folder and then
 * merged with the Reliance PDF — so if the Reliance PDF was missing (as it can
 * be when the portal download does not land), the certificate was uploaded
 * NOWHERE and the customer's CPA/RSA document was lost. It is now stored in its
 * own right, on both the onlinePolicy document and the linked Policy record.
 */
async function uploadBriskCertificate(briskPdfPath, certificateNo, data, jobId = "") {
  try {
    if (!briskPdfPath || !fs.existsSync(briskPdfPath)) {
      console.warn(`[${jobId}] ⚠️ Brisk certificate PDF not found, nothing to upload.`);
      return null;
    }

    const policyRef =
      data.policyId || data._id?.$oid || data._id || `policy_${Date.now()}`;
    const fileName = `${certificateNo || policyRef}_brisk_certificate.pdf`;
    const s3Key = `BriskCertificates/${fileName}`;

    console.log(`[${jobId}] ☁️  Uploading Brisk certificate to S3: ${s3Key}`);
    const s3UploadResult = await s3
      .upload({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: s3Key,
        Body: fs.readFileSync(briskPdfPath),
        ContentType: "application/pdf",
        ACL: "private",
      })
      .promise();

    const fileInfo = {
      fileName,
      key: s3Key,
      location: s3UploadResult.Location,
      certificateNo: certificateNo || null,
    };
    console.log(`[${jobId}] ✅ Brisk certificate uploaded: ${s3UploadResult.Location}`);

    // Record it on the policy documents.
    const policyIdForUpdate = data._id || data.policyId;
    if (!policyIdForUpdate) {
      console.warn(`[${jobId}] ⚠️ No policy id on the job — certificate uploaded but not linked.`);
      return fileInfo;
    }

    const { MongoClient } = require("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI);
    try {
      await client.connect();
      const db = client.db();

      const onlineResult = await db.collection("onlinePolicy").updateOne(
        { _id: policyIdForUpdate },
        { $set: { briskCertificate: fileInfo, updatedAt: new Date() } }
      );
      console.log(
        `[${jobId}] 📝 onlinePolicy.briskCertificate updated (matched ${onlineResult.matchedCount})`
      );

      // The Policy collection keeps the customer-facing document. Only fill it
      // when it is still empty, so a merged policy PDF is never overwritten by
      // the certificate alone.
      const policyResult = await db.collection("policy").updateOne(
        {
          $or: [{ onlinePolicyId: policyIdForUpdate }, { policyId: data.policyId }],
          $and: [{ $or: [{ policyFile: { $exists: false } }, { policyFile: {} }] }],
        },
        { $set: { policyFile: fileInfo, updatedAt: new Date() } }
      );
      if (policyResult.matchedCount > 0) {
        console.log(`[${jobId}] 📝 policy.policyFile set from the Brisk certificate`);
      }
    } finally {
      await client.close();
    }

    return fileInfo;
  } catch (e) {
    console.error(`[${jobId}] ❌ Failed to upload Brisk certificate: ${e.message}`);
    return null;
  }
}

/**
 * Download PDF from Brisk API response URL and save to file
 * @param {string} downloadUrl - URL to download the PDF from
 * @param {string} policyId - Policy ID to use for filename
 * @returns {Promise<string>} - Path to the downloaded file
 */
async function downloadBriskPDF(downloadUrl, policyId) {
  return new Promise((resolve, reject) => {
    if (!downloadUrl) {
      reject(new Error("No download URL provided"));
      return;
    }

    // Create downloads directory if it doesn't exist
    const downloadsDir = path.join(__dirname, 'brisk_certificates');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Generate filename
    const filename = `${policyId || 'certificate_' + Date.now()}.pdf`;
    const filepath = path.join(downloadsDir, filename);

    console.log(`📥 Downloading PDF from: ${downloadUrl}`);
    console.log(`💾 Saving to: ${filepath}`);

    // Determine if URL is HTTPS or HTTP
    const protocol = downloadUrl.startsWith('https') ? https : http;

    const file = fs.createWriteStream(filepath);

    protocol.get(downloadUrl, (response) => {
      // Check if response is successful
      if (response.statusCode !== 200) {
        fs.unlinkSync(filepath); // Delete the file
        reject(new Error(`Failed to download PDF. Status: ${response.statusCode}`));
        return;
      }

      // Pipe the response to file
      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log(`✅ PDF downloaded successfully: ${filepath}`);
        resolve(filepath);
      });

      file.on('error', (err) => {
        fs.unlinkSync(filepath); // Delete the file on error
        reject(err);
      });
    }).on('error', (err) => {
      if (fs.existsSync(filepath)) {
        fs.unlinkSync(filepath); // Delete the file on error
      }
      reject(err);
    });
  });
}


/**
 * Should this policy get a Brisk certificate?
 *
 * Two conditions, both required:
 *   - PA Cover is selected at all (nothing to certify otherwise), and
 *   - it is provided by BRISK rather than the insurer ("Company"), in which
 *     case the insurer handles it in its own portal and calling Brisk would
 *     create — and charge for — a certificate nobody asked for.
 *
 * Accepts the booleans and the "true"/"1"/"yes" strings that arrive from
 * FormData. Any future provider falls through as "not Brisk" and is skipped
 * until its own flow exists.
 *
 * @returns {{ create: boolean, reason: string }}
 */
const shouldCreateBriskCertificate = (data) => {
  const raw = data?.paCover;
  const paCoverSelected =
    raw === true || ["true", "1", "yes"].includes(String(raw).trim().toLowerCase());

  if (!paCoverSelected) {
    return { create: false, reason: "PA Cover not selected (nothing to certify)" };
  }

  const provider = String(data?.paCoverCompany || "").trim().toLowerCase();
  if (provider !== "brisk") {
    return {
      create: false,
      reason: `PA Cover is through "${data?.paCoverCompany || "Company"}", not Brisk`,
    };
  }

  return { create: true, reason: "PA Cover through Brisk" };
};

module.exports = {
  createBriskCertificate,
  downloadBriskPDF,
  uploadBriskCertificate,
  checkBriskWallet,
  resolveBriskVehicle,
  shouldCreateBriskCertificate,
  getStateName,
};
