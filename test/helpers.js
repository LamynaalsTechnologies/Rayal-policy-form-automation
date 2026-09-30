// Shared fixtures for the part-runner tests. Not a test file (no .test.js suffix).
const NOW = new Date("2026-09-30T10:00:00Z");
const later = (ms) => new Date(NOW.getTime() + ms);

const LABEL = { od: "OD", tp: "TP", motor: "OD + TP", pa: "PA" };
const part = (key, kind, company, extra = {}) => ({
  key,
  label: LABEL[key],
  kind,
  company,
  status: "pending",
  stopped: false,
  carriesPa: false,
  paCoverCompany: null,
  dependsOn: null,
  mirrors: null,
  attempts: 0,
  maxAttempts: kind === "brisk" ? 1 : 5,
  nextRetryAt: null,
  lastError: null,
  lastErrorCode: null,
  stage: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  result: {},
  ...extra,
});

const formData = (extra = {}) => ({
  firstName: "Asha",
  lastName: "Kumar",
  mobile: "9999999999",
  userId: "user1",
  clientId: "client1",
  Companyname: "reliance",
  paCover: true,
  paCoverCompany: "Brisk",
  settings: { isMultipleCompany: true, ODCompany: "Reliance", TPCompany: "National", PACompany: "Brisk" },
  ...extra,
});

/** OD at Reliance + TP at National + Brisk PA that waits for OD. */
const multiParts = () => [
  part("od", "portal", "Reliance"),
  part("tp", "portal", "National"),
  part("pa", "brisk", "Brisk", { dependsOn: "od", paCoverCompany: "Brisk" }),
];
/** One bundled part at Reliance + Brisk PA that waits for it. */
const singleParts = () => [
  part("motor", "bundled", "Reliance"),
  part("pa", "brisk", "Brisk", { dependsOn: "motor", paCoverCompany: "Brisk" }),
];

const jobDoc = (parts, extra = {}) => ({
  _id: "job1",
  captchaId: "policy1",
  status: "pending",
  rev: 0,
  parts,
  formData: formData(),
  needsHydration: false,
  createdAt: NOW,
  nextRetryAt: NOW,
  attempts: 0,
  maxAttempts: 5,
  errorLogs: [],
  statusHistory: [],
  ...extra,
});

const withPart = (parts, key, patch) => parts.map((p) => (p.key === key ? { ...p, ...patch } : p));
const partOf = (doc, key) => doc.parts.find((p) => p.key === key);

const silentLogger = { log() {}, warn() {}, error() {} };

/**
 * Just enough of a collection for the write-back and runner tests: findOne /
 * updateOne on ONE document, honouring the `rev` condition and the operators
 * the runner uses. `beforeUpdate` lets a test change the document right before
 * a write, i.e. simulate an edit that lands mid-run.
 */
function fakeCollection(initial) {
  const state = { doc: structuredClone(initial), writes: [], beforeUpdate: null };
  const matches = (filter) =>
    !!state.doc &&
    (filter._id === undefined || filter._id === state.doc._id) &&
    (filter.rev === undefined || (state.doc.rev == null ? null : state.doc.rev) === filter.rev);
  return {
    state,
    async findOne(filter) {
      return matches({ _id: filter._id }) ? structuredClone(state.doc) : null;
    },
    async updateOne(filter, update) {
      if (state.beforeUpdate) {
        const hook = state.beforeUpdate;
        state.beforeUpdate = null;
        hook(state.doc);
      }
      if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
      const d = state.doc;
      for (const [k, v] of Object.entries(update.$set || {})) d[k] = structuredClone(v);
      for (const k of Object.keys(update.$unset || {})) delete d[k];
      for (const [k, v] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + v;
      for (const [k, v] of Object.entries(update.$push || {})) {
        d[k] = d[k] || [];
        d[k].push(...(v && v.$each ? structuredClone(v.$each) : [structuredClone(v)]));
      }
      state.writes.push(update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
}

module.exports = {
  NOW,
  later,
  part,
  formData,
  multiParts,
  singleParts,
  jobDoc,
  withPart,
  partOf,
  silentLogger,
  fakeCollection,
};
