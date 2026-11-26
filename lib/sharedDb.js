"use strict";

/**
 * The server's own open database connection, lent to the forms' saves (2026-11-26, speed round 4).
 *
 * Why: every save of a run (proposal number, KYC links, stages, wallet notes, policy files) opened a NEW connection to
 * the `mongodb+srv` cluster and closed it again: a DNS lookup, a TLS handshake and a login each time, 0.2-0.6 s on the
 * server (one took 5.3 s). A Reliance wallet policy made ~17 of them. server.js already holds an open connection
 * (`mongoose.connect(process.env.MONGODB_URI)`), with the same driver (`node_modules/mongodb`) and the same database.
 *
 * How: only the line that made the client changes at each place:
 *     const client = new MongoClient(uri, options);            // before
 *     const client = sharedDb.clientFor(MongoClient, uri, options);   // now
 * The lent client's connect() and close() do nothing (the connection belongs to the server, never closed by a form);
 * db() is the server connection's database. Anything else (a test's fake MongoClient, another address, the server's
 * connection not open yet or dropped) gets `new MongoClient(uri, options)` exactly as before.
 */

/** The server's open client, or null (not connected, not this address, no mongoose). */
function serverClient(uri) {
  if (!uri || uri !== process.env.MONGODB_URI) return null;
  try {
    const mongoose = require("mongoose");
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1 || typeof conn.getClient !== "function") return null;
    const client = conn.getClient();
    return client && typeof client.db === "function" ? client : null;
  } catch (e) {
    return null;
  }
}

/** The real driver's class (what every form requires); a test's fake class is never swapped. */
function isRealMongoClient(Client) {
  try {
    return Client === require("mongodb").MongoClient;
  } catch (e) {
    return false;
  }
}

/**
 * A client for one piece of work: the server's open connection (lent) or a new one (as before).
 *
 * @param {Function} [Client]  the MongoClient class the caller would have used (undefined = the real one)
 * @param {string} uri
 * @param {Object} [options]
 */
function clientFor(Client, uri, options) {
  const Real = Client || require("mongodb").MongoClient;
  if (isRealMongoClient(Real)) {
    const shared = serverClient(uri);
    if (shared) {
      const lent = {
        lent: true,
        connect: async () => lent,
        db: (name, opts) => shared.db(name, opts),
        close: async () => {},
      };
      return lent;
    }
  }
  return options === undefined ? new Real(uri) : new Real(uri, options);
}

module.exports = { clientFor, serverClient };
