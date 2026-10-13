// Shared by the drift-guard tests (test/nationalTP.test.js, test/kshemaTP.test.js). Not a test file (no .test.js suffix).
//
// A TP handler is a DUPLICATE of a full-company flow plus lines tagged "[TP]". These helpers say where the copy and the
// original differ, and which of those places carry no "[TP]" tag.

/**
 * Line diff of `a` (original) against `b` (copy) as a list of hunks { removed, added }. Both files are nearly
 * identical, so this walks them together and, at a mismatch, looks for the closest point where `lookahead`
 * consecutive lines agree again. Anything it cannot re-synchronise becomes one last big hunk — which has no [TP]
 * and therefore fails the guard, the safe direction.
 */
function diffHunks(a, b, { lookahead = 3, window = 400 } = {}) {
  const hunks = [];
  const same = (i, j, n) => {
    for (let k = 0; k < n; k++) {
      if (i + k >= a.length || j + k >= b.length || a[i + k] !== b[j + k]) return false;
    }
    return true;
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    let found = null;
    // closest resync first: smallest x + y wins
    for (let d = 0; d <= window && !found; d++) {
      for (let x = 0; x <= d && !found; x++) {
        const y = d - x;
        const atEndA = i + x >= a.length;
        const atEndB = j + y >= b.length;
        if ((atEndA && atEndB) || (!atEndA && !atEndB && same(i + x, j + y, lookahead))) found = { x, y };
      }
    }
    if (!found) found = { x: a.length - i, y: b.length - j };
    hunks.push({ removed: a.slice(i, i + found.x), added: b.slice(j, j + found.y) });
    i += found.x;
    j += found.y;
  }
  return hunks;
}

/** The hunks in which no added line is tagged "[TP]" — the changes nobody owned up to. */
const untagged = (hunks) => hunks.filter((h) => !h.added.some((line) => line.includes("[TP]")));

module.exports = { diffHunks, untagged };
