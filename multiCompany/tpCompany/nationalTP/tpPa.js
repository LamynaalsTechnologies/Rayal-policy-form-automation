/**
 * National TP — what the portal's "Compulsory PA for Owner Driver" (No / 1 Year / 5 Years) gets.
 *
 * ONE field decides it: the PA term of the policy (`paCoverYears`, "No of Year" on the Online Policy form — asked in
 * the TP panel when PA Cover is not ticked, and inside PA Cover Details when it is). The portal gets exactly that year.
 *
 * The one exception is PA Cover bought from Brisk: its CPA certificate is the owner-driver's cover, so the portal stays
 * "No" — otherwise the customer would be covered, and charged, twice. That is read from `settings.PACompany`
 * ("Brisk", an insurer, or "" when PA Cover is off), which every multi-company job carries.
 *
 * Before this the year was used only when PA Cover = National (`paCover` + `paCoverCompany: "Company"`): a policy with
 * PA Cover off and "1 Year" in the TP panel went to the portal as "No".
 *
 * @returns {0|1|5|null} 0 = "No" (PA from Brisk) · 1 / 5 = that term · null = the policy's year is not 1 or 5, which
 *   no run may guess at (the original fell back to "1 Year" for anything else)
 */
const norm = (value) => String(value == null ? "" : value).trim().toLowerCase();

/** PA Cover is ticked and bought from Brisk (a separate CPA certificate). */
const paViaBrisk = (data) => norm(data && data.settings && data.settings.PACompany) === "brisk";

function portalPaTerm(data) {
  const d = data || {};
  if (paViaBrisk(d)) return 0;
  const years = Number(d.paCoverYears);
  return years === 1 || years === 5 ? years : null;
}

module.exports = { portalPaTerm, paViaBrisk };
