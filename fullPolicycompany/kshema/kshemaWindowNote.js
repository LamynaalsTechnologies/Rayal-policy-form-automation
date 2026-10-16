/**
 * Keep the KSHEMA failure sentences true about the browser window.
 *
 * Several KSHEMA failures say "The KYC page has been left open on screen". That was always true by accident: the
 * window was never closed (the cleanup never received the browser). Now a failed job's window is closed unless
 * KEEP_BROWSER_OPEN_ON_ERROR is on, so when it WAS closed those sentences are reworded to point at the link saved on
 * the policy instead. No colon in any replacement (beautifyError keeps only the text after the last one).
 */
const REWORDS = [
  [
    /The KYC page has been left open on screen so it can be finished by hand, and its link is saved on the policy\./g,
    "The browser window was closed, so finish it from the KYC link saved on the policy.",
  ],
  [/The KYC page has been left open on screen\./g, "The browser window was closed - the KYC link is saved on the policy."],
  [/The page has been left open and photographed/g, "The page was photographed"],
];

/** `text` as it should read when the window was closed. Anything else is returned unchanged. */
function closedWindowWording(text) {
  if (typeof text !== "string") return text;
  return REWORDS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

module.exports = { closedWindowWording };
