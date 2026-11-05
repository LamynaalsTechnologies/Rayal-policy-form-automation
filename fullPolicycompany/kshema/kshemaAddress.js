/**
 * The one Address line on KSHEMA's proposal page (`c_address_one`), made from the policy's address boxes in the order
 * the form asks them: Flat / Room, Floor, Premises, Block, Road / Street / Lane, Area and Locality.
 *
 * The owner, 2026-11-05 (a live line read
 *   "# 272, FLOOR, RAMANA, JALANDHAR, ARANTHANGI TK,PUDUKOTTAI DISC,EGANIVAYAL POST, BASTI PEER DAD,ARANT"):
 *   - no commas: each comma becomes a space;
 *   - a word already written is not written again. Since 2026-10-28 an Aadhaar read puts the village / district into
 *     Block and Premises AND keeps them in Area, so the same names came twice.
 *
 * How the repeat is found, so the line still reads as an address:
 *   - every box is split at its commas into pieces ("ARANTHANGI TK", "PUDUKOTTAI DIST");
 *   - a piece written before (same words) is left out, and so is a piece that is only names written already plus
 *     their TK / DIST / POST ("PUDUKOTTAI DIST" after "PUDUKOTTAI DISC");
 *   - in any other piece only the name written before is left out, the rest stays ("PUDUKOTTAI MAIN ROAD" after
 *     "PUDUKOTTAI" keeps "MAIN ROAD");
 *   - numbers and the small address words (STREET, ROAD, POST, NAGAR, NO, TK ...) may repeat: "2ND STREET 3RD STREET"
 *     needs both STREETs. Words of up to three letters count as small words.
 *   - at most 100 characters, cut between words (the old cut left "ARANT").
 */

/** The words that say what kind of place a name is: a piece of only these and names already written is a repeat. */
const QUALIFIERS = new Set([
  "PO", "POST", "TK", "TQ", "TALUK", "TALUKA", "TEH", "TEHSIL", "MANDAL", "DT", "DIST", "DISTT", "DISTRICT", "DISC",
  "VIL", "VILL", "VILLAGE", "CITY", "TOWN", "VIA", "STATE",
]);

/** Address words that may appear more than once (compared without dots, upper case). */
const MAY_REPEAT = new Set([
  ...QUALIFIERS,
  "STREET", "STREETS", "ROAD", "LANE", "CROSS", "MAIN", "NAGAR", "COLONY", "AVENUE", "BAZAAR", "BAZAR",
  "WARD", "BLOCK", "FLOOR", "FLAT", "HOUSE", "DOOR", "PLOT", "BUILDING", "TOWER", "APARTMENT", "APARTMENTS",
  "COMPLEX", "SOCIETY", "LAYOUT", "EXTN", "EXTENSION", "SECTOR", "PHASE", "STAGE", "AREA",
  "NEAR", "BEHIND", "BESIDE", "OPPOSITE", "FRONT", "BACK", "SIDE",
  "EAST", "WEST", "NORTH", "SOUTH", "NEW", "OLD", "UPPER", "LOWER", "MIDDLE",
]);

const MAX_LENGTH = 100;

/** The comparison key of a word: letters and digits only, upper case. */
const keyOf = (word) => String(word).toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A name (counted for repeats): has letters, more than three, and is not a small address word or a number. */
const isName = (key) => /^[A-Z]{4,}$/.test(key) && !MAY_REPEAT.has(key);

/** The policy's address boxes, in the form's order, as found on the job. */
const addressBoxes = (data = {}) => [
  data.flatDoorNo,
  data.floorNo,
  data.buildingName,
  data.blockName || data.blockNameNo,
  data.roadStreetLane,
  data.areaAndLocality || data.locality || data.area,
];

/** Cut to `max` characters between words (a single word longer than that is cut where it must be). */
const cutBetweenWords = (line, max) => {
  if (line.length <= max) return line;
  const room = line.slice(0, max + 1);
  const at = room.lastIndexOf(" ");
  return (at > 0 ? room.slice(0, at) : line.slice(0, max)).trim();
};

/**
 * @returns {{ line: string, left: string[] }} the Address line, and what was left out because it was written already
 *   (for the log)
 */
function kshemaAddressLine(data, { maxLength = MAX_LENGTH } = {}) {
  const names = new Set();
  const pieces = new Set();
  const kept = [];
  const left = [];

  for (const box of addressBoxes(data)) {
    if (box === null || box === undefined) continue;
    for (const raw of String(box).split(",")) {
      const words = raw.trim().split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      const keys = words.map(keyOf).filter(Boolean);
      const pieceKey = keys.join(" ");
      const pieceNames = keys.filter(isName);
      const onlyKnownPlaces =
        pieceNames.length > 0 &&
        pieceNames.every((n) => names.has(n)) &&
        keys.every((k) => isName(k) || QUALIFIERS.has(k));

      if ((pieceKey && pieces.has(pieceKey)) || onlyKnownPlaces) {
        left.push(words.join(" "));
        continue;
      }
      if (pieceKey) pieces.add(pieceKey);

      const stays = [];
      for (const word of words) {
        const key = keyOf(word);
        if (isName(key) && names.has(key)) {
          left.push(word);
          continue;
        }
        if (isName(key)) names.add(key);
        stays.push(word);
      }
      if (stays.length) kept.push(stays.join(" "));
    }
  }

  return { line: cutBetweenWords(kept.join(" ").replace(/\s+/g, " ").trim(), maxLength), left };
}

module.exports = { kshemaAddressLine, addressBoxes, MAY_REPEAT, QUALIFIERS, MAX_LENGTH };
