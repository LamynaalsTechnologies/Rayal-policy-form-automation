/**
 * National's saved default nominee.
 *
 * National's portal now demands a nominee on EVERY quote, including policies
 * with no PA cover — where the Online Policy form never asks for one (see
 * companyRules.js's hasNomineeAge/hasPaCoverYears on the frontend). Operators
 * can save one default nominee per user/client in Account & Policy Settings →
 * National (RayalBrokers-Frontend/src/Components/Navbar/ChangePasswordModal.js),
 * and this is used ONLY when the policy itself left nomineeName/Age/Relation
 * blank — the policy's own nominee always wins (see server.js dispatch).
 *
 * The saved nominee lives on the `user`/`client` document itself, not on
 * ProviderCredential (RayalBrokers-backend/Model/user.js `nationalNominee`,
 * Model/client.js `nationalNominee`): ProviderCredential requires a
 * username/password, so a nominee saved without a portal login would be
 * skipped by syncProviderCredentials and then soft-deleted.
 *
 * Same tier order and "no wildcard fallback" doctrine as
 * lib/credentialResolver.js, using the raw driver (via mongoose.connection,
 * same access pattern server.js already uses for db.collection("onlinePolicy"))
 * since `user`/`client` have no Mongoose model in this repo.
 */

const mongoose = require("mongoose");

const toObjectId = (id) => {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(id);
  } catch (e) {
    return null; // not a valid ObjectId — skip the tier that needed it
  }
};

const hasNominee = (doc) =>
  !!(doc?.nationalNominee?.name && doc?.nationalNominee?.relation && doc?.nationalNominee?.age);

/**
 * The lookups, in priority order. Mirrors buildTiers in credentialResolver.js:
 *   1. the policy's own user (also hits a client who filed it themselves)
 *   2. the client they belong to, for a user with no default of their own
 */
const buildTiers = ({ userId, clientId }) => {
  const tiers = [];
  const userObjectId = toObjectId(userId);
  const clientObjectId = toObjectId(clientId);
  const sameId = userObjectId && clientObjectId && userObjectId.equals(clientObjectId);

  if (userObjectId) {
    tiers.push({
      matchedBy: "user-id",
      describe: `user ${userId}`,
      collection: "user",
      query: { _id: userObjectId },
    });
    tiers.push({
      matchedBy: "user-as-client",
      describe: `client ${userId}`,
      collection: "client",
      query: { _id: userObjectId },
    });
  }

  if (clientObjectId && !sameId) {
    tiers.push({
      matchedBy: "client-id",
      describe: `client ${clientId}`,
      collection: "client",
      query: { _id: clientObjectId },
    });
  }

  return tiers;
};

/**
 * Resolve National's saved default nominee for one policy.
 *
 * @param {Object}   params
 * @param {*}        params.userId    the policy's userId
 * @param {*}        params.clientId  the policy's clientId
 * @param {Function} [params.log]     called with a progress line per tier
 * @returns {Promise<{name, relation, age}|null>} null when nothing usable was
 *          saved anywhere — the caller decides what to do about that (the
 *          policy may still have its own nominee).
 */
const resolveNationalNominee = async ({ userId, clientId, log }) => {
  const say = typeof log === "function" ? log : () => {};

  for (const tier of buildTiers({ userId, clientId })) {
    say(`Looking for a saved National nominee on ${tier.describe}`);

    let doc;
    try {
      doc = await mongoose.connection.collection(tier.collection).findOne(tier.query);
    } catch (e) {
      say(`   ✗ could not read ${tier.describe}: ${e.message}`);
      continue;
    }

    if (!doc || !hasNominee(doc)) {
      say(`   ✗ no saved nominee on this ${tier.describe.split(" ")[0]}`);
      continue;
    }

    say(`   ✓ found a saved nominee on ${tier.describe}`);
    return {
      name: doc.nationalNominee.name,
      relation: doc.nationalNominee.relation,
      age: doc.nationalNominee.age,
    };
  }

  return null;
};

module.exports = { resolveNationalNominee };
