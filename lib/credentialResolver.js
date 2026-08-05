/**
 * Portal-credential resolution.
 *
 * Every insurer resolves its login the same way, from the ProviderCredential
 * collection, using the two ids the policy carries: `userId` (who filed it) and
 * `clientId` (the client they belong to).
 *
 * The two fields on a credential row mean different things:
 *   userId   — the row's own identity: a `user` _id or a `client` _id
 *   clientId — the OWNING client. Every user under a client shares this value.
 *
 * That is why nothing here matches on `clientId` alone: a client with five users
 * has five rows carrying the same clientId, and `findOne` would return whichever
 * one Mongo reached first — a policy filed through a colleague's portal login,
 * issued under the wrong IMD code, with nothing in the logs to say so.
 *
 * There is deliberately NO "any active credential for this insurer" fallback.
 * Failing loudly is the correct outcome: the operator is told exactly what to
 * add and where.
 */

const { ProviderCredential } = require("../models");

const sameId = (a, b) => a && b && String(a) === String(b);

/**
 * The lookups, in priority order. Each is skipped when the id it needs is
 * missing, and every one of them requires `isActive: true` — a login removed on
 * the User page is soft-deleted (isActive:false) and must never be picked up.
 */
const buildTiers = ({ provider, userId, clientId }) => {
  const tiers = [];

  // 1. The policy's own user. Also hits when the CLIENT filed the policy
  //    themselves, because a client's row carries its own _id in userId.
  if (userId) {
    tiers.push({
      matchedBy: "user-id",
      describe: `user ${userId}`,
      query: { provider, userId, isActive: true },
    });
  }

  // 2. Rows written before `clientId` came to mean the owning client — back
  //    then it held the record's own _id, so a user's row can still be found
  //    this way. Kept so credentials saved before that change keep working.
  if (userId) {
    tiers.push({
      matchedBy: "legacy-client-id",
      describe: `legacy client-id ${userId}`,
      query: { provider, clientId: userId, isActive: true },
    });
  }

  // 3. The client's OWN login — for a user who has none of their own.
  //    `userId: clientId` pins it to the client's own row rather than any of
  //    the users sitting under that client. Skipped when it would repeat
  //    tier 1.
  if (clientId && !sameId(clientId, userId)) {
    tiers.push({
      matchedBy: "client-own",
      describe: `client ${clientId}`,
      query: { provider, clientId, userId: clientId, isActive: true },
    });
  }

  return tiers;
};

/**
 * Resolve the portal login for one policy.
 *
 * @param {Object}   params
 * @param {string}   params.provider  lowercased insurer name ("reliance", ...)
 * @param {*}        params.userId    the policy's userId
 * @param {*}        params.clientId  the policy's clientId
 * @param {Function} [params.log]     called with a progress line per tier
 * @returns {Promise<{creds, source, matchedBy}|null>}
 *          `source` describes WHOSE login it is, taken from the matched row
 *          rather than from the tier that found it — so a policy the client
 *          filed themselves reads as "client" even though tier 1 matched.
 */
const resolvePortalCredentials = async ({ provider, userId, clientId, log }) => {
  const say = typeof log === "function" ? log : () => {};

  for (const tier of buildTiers({ provider, userId, clientId })) {
    say(`Looking for ${provider} credentials on ${tier.describe}`);

    const creds = await ProviderCredential.findOne(tier.query);
    if (!creds) {
      say(`   ✗ none on this ${tier.describe.split(" ")[0]}`);
      continue;
    }

    const source = sameId(creds.userId, creds.clientId) ? "client" : "user";
    return { creds, source, matchedBy: tier.matchedBy };
  }

  return null;
};

module.exports = { resolvePortalCredentials };
