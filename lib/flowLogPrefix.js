/**
 * The flow tag at the start of every console line a Reliance job prints:
 *
 *   Reliance TP+OD | Clicking 'Get Coverage Details' button...
 *   Reliance TP    | Logging in to Reliance...
 *   Reliance OD    | Motors -> Two Wheeler opened
 *
 * With two Reliance windows running side by side the lines interleave, and ~2,650 console calls (551 in
 * relianceForm.js alone) say nothing about which flow printed them. Instead of editing every call site, the job is
 * run inside an AsyncLocalStorage that carries the flow's label, and console.log / info / warn / error / debug are
 * wrapped ONCE (install) to add the tag whenever a label is in scope. Everything the job awaits inherits the label —
 * the form code, sessionManager, the captcha reader, partRunner's `logger = console` — and two parallel jobs keep
 * their own.
 *
 * Which flow is which (flowLabel):
 *   Reliance TP+OD  the bundled full-policy flow: part `motor`, or a legacy job without a policyType
 *   Reliance TP     part `tp`  / policyType "tp"
 *   Reliance OD     part `od`  / policyType "od"
 * Anything else (the Brisk PA part, National, KSHEMA) has no label: its lines print exactly as before. Which insurers
 * are tagged is ONE list (TAGGED_COMPANIES), so adding National or KSHEMA later is one word.
 *
 * FLOW_LOG_PREFIX_ENABLED in the automation's .env: ON unless it is explicitly false / 0 / no / off. Off means the
 * code does not run at all: install() wraps nothing and run() just calls the function.
 * Read at CALL time, so a restart after editing .env is all it needs and a test can flip it.
 *
 * Lines that belong to no job (the queue poller, the DB watcher, boot messages) have no label and stay untagged.
 * install() must run before anything captures `console.log` by value — breaker.js does, when it is created.
 */
require("dotenv").config({ quiet: true });

const { AsyncLocalStorage } = require("node:async_hooks");
const util = require("node:util");

const store = new AsyncLocalStorage();

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());
const norm = (value) => String(value == null ? "" : value).trim().toLowerCase();

/** Insurers whose flows are tagged. */
const TAGGED_COMPANIES = ["reliance"];

/** part key (or a legacy job's policyType) -> what the flow covers. `pa` (Brisk) is deliberately absent. */
const KIND_LABEL = { motor: "TP+OD", od: "OD", tp: "TP" };

/** "Reliance TP+OD" is the longest label; the rest are padded to it so the messages line up in a column. */
const LABEL_WIDTH = 14;

const defaultCompanyLabel = (company) => {
  const key = norm(company);
  return key.charAt(0).toUpperCase() + key.slice(1);
};

function isFlowLogPrefixEnabled() {
  return !isOff(process.env.FLOW_LOG_PREFIX_ENABLED);
}

/**
 * The label for a job, or null when its flow is not tagged.
 *
 * @param {Object} job
 * @param {string} job.company       "reliance" / "Reliance" ...
 * @param {string} [job.partKey]     "motor" | "od" | "tp" | "pa" — set for a job with parts
 * @param {string} [job.policyType]  a legacy job's formData.policyType; only "od" / "tp" mean anything,
 *                                   everything else is the bundled full-policy flow (as server.js dispatches it)
 * @param {Function} [job.companyLabel]  brand label ("KSHEMA" is not just capitalised); server.js passes its own
 * @returns {string|null}
 */
function flowLabel({ company, partKey, policyType, companyLabel = defaultCompanyLabel } = {}) {
  const insurer = norm(company);
  if (!TAGGED_COMPANIES.includes(insurer)) return null;

  const legacyType = norm(policyType);
  const key = norm(partKey) || (legacyType === "od" || legacyType === "tp" ? legacyType : "motor");
  const kind = KIND_LABEL[key];
  return kind ? `${companyLabel(insurer)} ${kind}` : null;
}

/** "Reliance OD" -> "Reliance OD    | " */
function formatPrefix(label) {
  return `${label.padEnd(LABEL_WIDTH)} | `;
}

/** Every physical line of `text` starts with the prefix; a blank line gets the bare pipe (no trailing space). */
function prefixLines(text, label) {
  const prefix = formatPrefix(label);
  const bare = prefix.trimEnd();
  return String(text)
    .split("\n")
    .map((line) => (line === "" ? bare : prefix + line))
    .join("\n");
}

const METHODS = ["log", "info", "warn", "error", "debug"];
/** warn / error go to stderr, the rest to stdout — object colouring follows the stream's own TTY. */
const STREAM_OF = { log: "stdout", info: "stdout", debug: "stdout", warn: "stderr", error: "stderr" };
const INSTALLED = Symbol.for("rayal.flowLogPrefix.installed");

/**
 * Wrap the console methods once. Outside a flow the original runs untouched; inside one the arguments are
 * formatted exactly as console would (util.formatWithOptions: %s / %d, objects, Errors) and every line is tagged.
 *
 * @param {Object} [target=console]
 * @param {Object} [opts]
 * @param {boolean} [opts.colors]  force object colouring on/off (tests); default follows the stream's TTY
 * @returns {boolean} true when this call wrapped the console; false when the switch is off or it was done already
 */
function install(target = console, { colors } = {}) {
  if (!isFlowLogPrefixEnabled()) return false;
  if (target[INSTALLED]) return false;

  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    const stream = STREAM_OF[method];
    target[method] = function flowTaggedConsole(...args) {
      const label = store.getStore();
      if (!label) return original.apply(target, args);
      const useColors = typeof colors === "boolean" ? colors : Boolean(process[stream] && process[stream].isTTY);
      const text = util.formatWithOptions({ colors: useColors }, ...args);
      return original.call(target, prefixLines(text, label));
    };
  }

  Object.defineProperty(target, INSTALLED, { value: true });
  return true;
}

/** Run `fn` with `label` in scope. No label, or the switch off: just `fn()`. Returns whatever `fn` returns. */
function run(label, fn) {
  if (!label || !isFlowLogPrefixEnabled()) return fn();
  return store.run(label, fn);
}

/**
 * Run `fn` with NO label, even when called from inside a flow. For code that is not part of any job but can be
 * kicked off from one — a queue pass started by a setTimeout or a .finally created inside a job's context would
 * otherwise print "Found N pending jobs" under that job's tag.
 */
function outside(fn) {
  if (!isFlowLogPrefixEnabled()) return fn();
  return store.exit(fn);
}

/** The label in scope right now, or undefined (diagnostics and tests). */
const currentLabel = () => store.getStore();

module.exports = {
  isFlowLogPrefixEnabled,
  flowLabel,
  formatPrefix,
  prefixLines,
  install,
  run,
  outside,
  currentLabel,
  TAGGED_COMPANIES,
  LABEL_WIDTH,
};
