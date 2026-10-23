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
  // Reliance OD never starts without the existing TP policy (lib/existingTpGate.js; test/existingTpGate.test.js)
  existingTpPolicyNumber: "NIC/TP/0001",
  existingTpInsurer: "National",
  existingTpStartDate: "01-10-2026",
  existingTpEndDate: "30-09-2031",
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

/** What the policy's `settings` say, to agree with the parts built for it. */
const SINGLE_SETTINGS = { isMultipleCompany: false, ODCompany: "Reliance", TPCompany: "Reliance", PACompany: "Brisk" };

const jobDoc = (parts, extra = {}) => ({
  _id: "job1",
  captchaId: "policy1",
  status: "pending",
  rev: 0,
  parts,
  // One bundled `motor` part is a single-company policy; od + tp are two insurers.
  formData: formData(parts.some((p) => p.key === "motor") ? { settings: SINGLE_SETTINGS } : {}),
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
/**
 * $set on a dotted path, with `$[name]` resolved by arrayFilters of the form { "name.field": value } (the run-history
 * writes: "runHistory.$[run].steps.kyc"). An identifier that matches nothing changes nothing, as in MongoDB.
 */
function setPath(doc, path, value, arrayFilters = []) {
  const parts = path.split(".");
  const walk = (node, i) => {
    if (node == null) return;
    const p = parts[i];
    const last = i === parts.length - 1;
    const m = p.match(/^\$\[(\w+)\]$/);
    if (m) {
      if (!Array.isArray(node)) return;
      const f = (arrayFilters || []).find((af) => Object.keys(af).some((k) => k.startsWith(`${m[1]}.`)));
      const [fk, fv] = f ? Object.entries(f)[0] : [null, null];
      const field = fk ? fk.slice(m[1].length + 1) : null;
      node.forEach((el, idx) => {
        if (!field || (el && el[field] === fv)) {
          if (last) node[idx] = value;
          else walk(el, i + 1);
        }
      });
      return;
    }
    if (last) {
      node[p] = value;
      return;
    }
    if (node[p] == null) node[p] = {};
    walk(node[p], i + 1);
  };
  walk(doc, 0);
}

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
    async updateOne(filter, update, options) {
      if (state.beforeUpdate) {
        const hook = state.beforeUpdate;
        state.beforeUpdate = null;
        hook(state.doc);
      }
      if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
      const d = state.doc;
      for (const [k, v] of Object.entries(update.$set || {})) {
        if (k.includes(".")) setPath(d, k, structuredClone(v), options && options.arrayFilters);
        else d[k] = structuredClone(v);
      }
      for (const k of Object.keys(update.$unset || {})) delete d[k];
      for (const [k, v] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + v;
      for (const [k, v] of Object.entries(update.$push || {})) {
        d[k] = d[k] || [];
        d[k].push(...(v && v.$each ? structuredClone(v.$each) : [structuredClone(v)]));
        if (v && typeof v.$slice === "number" && v.$slice < 0) d[k] = d[k].slice(v.$slice);
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
  SINGLE_SETTINGS,
  jobDoc,
  withPart,
  partOf,
  silentLogger,
  fakeCollection,
};
