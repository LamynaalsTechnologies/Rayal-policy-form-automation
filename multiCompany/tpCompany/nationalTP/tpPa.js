/**
 * National TP — what the portal's "Compulsory PA for Owner Driver" (No / 1 Year / 5 Years) gets.
 *
 *   PA Cover OFF                       -> "No"   (nothing is bought, so nothing is asked: no "No of Year" for a TP)
 *   PA Cover ON, bought from Brisk     -> "No"   (Brisk's CPA certificate is the owner-driver's cover; otherwise the
 *                                                  customer would be covered, and charged, twice)
 *   PA Cover ON, bought from National  -> the year the policy carries, 1 or 5 (`paCoverYears`, "No of Year" in PA
 *                                         Cover Details — it is asked only when PA Cover is ticked)
 *
 * "PA Cover ON" is `paCover` of the part's own data: lib/partRunner.js buildPartFormData sets it to true only for a part
 * that carries PA (`carriesPa`), so a TP whose PA is bought with another insurer's part gets "No" as well. Brisk is read
 * from `settings.PACompany` ("Brisk", an insurer, or "" when PA Cover is off), which every multi-company job carries.
 *
 * Before this the year was sent whenever one was saved — PA Cover off with "1 Year" in the TP panel went to the portal
 * as "1 Year", the quote included PA, and the policy's premium did not.
 *
 * @returns {0|1|5|null} 0 = "No" · 1 / 5 = that term · null = PA is bought from National but the policy's year is not
 *   1 or 5, which no run may guess at (the original fell back to "1 Year" for anything else)
 */
const norm = (value) => String(value == null ? "" : value).trim().toLowerCase();

/** PA Cover is ticked on this part's data. */
const paCoverOn = (data) => !!data && (data.paCover === true || norm(data.paCover) === "true");

/** PA Cover is ticked and bought from Brisk (a separate CPA certificate). */
const paViaBrisk = (data) => norm(data && data.settings && data.settings.PACompany) === "brisk";

function portalPaTerm(data) {
  const d = data || {};
  if (!paCoverOn(d) || paViaBrisk(d)) return 0;
  const years = Number(d.paCoverYears);
  return years === 1 || years === 5 ? years : null;
}

module.exports = { portalPaTerm, paViaBrisk, paCoverOn };
