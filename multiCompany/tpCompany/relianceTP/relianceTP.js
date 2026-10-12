/**
 * Reliance TP — login only for now. Logs in through common/login, which for
 * Reliance is a copy of the full-company Reliance login
 * (common/reliance/fullCompanyLogin.js, the same one Reliance OD uses), then
 * stops cleanly: the Reliance TP form is not built yet. Replace with a runHandler body
 * (the shape is in common/loginOnlyHandler.js and relianceOD.js's header) when it is.
 */
const { makeLoginOnlyHandler } = require("../../common/loginOnlyHandler");

const fillRelianceTP = makeLoginOnlyHandler("reliance", "tp");

module.exports = { fillRelianceTP };
