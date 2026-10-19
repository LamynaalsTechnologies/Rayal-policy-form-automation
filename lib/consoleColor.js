/**
 * Colours for the console, so a developer sees at a glance how a part ended:
 *   [Reliance Queue][motor] success -> completed (job now completed)     <- "completed" in green
 *
 * No .env switch (the owner's rule since 2026-10-19). The usual terminal conventions decide instead:
 *   - colour only when the output is a terminal (nodemon / node in a shell); a pipe or a file gets plain text
 *   - NO_COLOR set (any value) = never;  FORCE_COLOR=1 = always (FORCE_COLOR=0 = never)
 * Read at call time.
 */
const CODES = { green: 32, red: 31, yellow: 33, bold: 1 };

function colorEnabled(stream = process.stdout) {
  if (Object.prototype.hasOwnProperty.call(process.env, "NO_COLOR")) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "") return force !== "0" && String(force).toLowerCase() !== "false";
  return !!(stream && stream.isTTY);
}

function paint(color, text, { enabled = colorEnabled() } = {}) {
  const code = CODES[color];
  const plain = String(text);
  return enabled && code ? `\x1b[${code}m${plain}\x1b[0m` : plain;
}

/** The colour of a job / part status: completed green, failed red, waiting / retrying / held amber, anything else none. */
function statusColor(status) {
  const s = String(status == null ? "" : status).trim().toLowerCase();
  if (s === "completed" || s === "complete") return "green";
  if (s === "failed" || s.startsWith("failed_")) return "red";
  if (s === "completed_with_errors" || s === "pending" || s === "hold") return "yellow";
  return null;
}

/** A status word in its colour (plain when colour is off or the status has none). */
function colorStatus(status, options) {
  const color = statusColor(status);
  return color ? paint(color, status, options) : String(status);
}

module.exports = { colorEnabled, paint, statusColor, colorStatus };
