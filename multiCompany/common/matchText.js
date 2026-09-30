/**
 * Cross-company text-matching helpers.
 *
 * Lifted from fullPolicycompany/kshema/kshemaFields.js, which already had no
 * Angular-Material dependency — this is the one piece of that file that
 * belongs in the portal-agnostic core rather than a widget-specific adapter.
 * See that file for the fuller reasoning behind word-based (not substring)
 * scoring; kshemaFields.js itself is left untouched.
 */

/**
 * Strip text down to comparable word tokens.
 *
 * @param {string} text
 * @param {Set<string>} [noise] - lowercase words to drop; per-list, never global.
 */
function textTokens(text, noise = null) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !(noise && noise.has(t.toLowerCase())));
}

/**
 * How well does `optionText` answer `wantedText`? 0 = not at all, 100 = exact.
 *
 * Scored from both directions: only counting how much of the wanted text
 * appears in the option would rank an option with extra words just as highly
 * as an exact match, so an option with extra words has to cost something.
 */
function scoreTextMatch(optionText, wantedText, noise = null) {
  const want = textTokens(wantedText, noise);
  const opt = textTokens(optionText, noise);
  if (!want.length || !opt.length) return 0;

  const wantJoined = want.join(" ");
  const optJoined = opt.join(" ");
  if (wantJoined === optJoined) return 100;

  let matched = 0;
  const unusedOpt = [...opt];
  for (const w of want) {
    const exactAt = unusedOpt.indexOf(w);
    if (exactAt !== -1) {
      matched += 1;
      unusedOpt.splice(exactAt, 1);
      continue;
    }
    // A shortened or slightly different spelling still counts, but for less.
    const partialAt = unusedOpt.findIndex(
      (o) => (o.length >= 4 && w.startsWith(o)) || (w.length >= 4 && o.startsWith(w))
    );
    if (partialAt !== -1) {
      matched += 0.7;
      unusedOpt.splice(partialAt, 1);
    }
  }

  if (!matched) return 0;

  const optionCoverage = matched / opt.length;
  const wantedCoverage = matched / want.length;
  return Math.round(optionCoverage * 50 + wantedCoverage * 50);
}

/**
 * Pick the closest option, or null when nothing is close enough.
 *
 * @param {string[]} optionTexts
 * @param {string} wantedText
 * @param {number} [minScore] - below this the guess is not worth making.
 * @returns {{index: number, text: string, score: number}|null}
 */
function pickBestMatch(optionTexts, wantedText, minScore = 45, noise = null) {
  let best = null;
  optionTexts.forEach((text, index) => {
    const score = scoreTextMatch(text, wantedText, noise);
    if (score > 0 && (!best || score > best.score)) best = { index, text, score };
  });
  return best && best.score >= minScore ? best : null;
}

module.exports = { textTokens, scoreTextMatch, pickBestMatch };
