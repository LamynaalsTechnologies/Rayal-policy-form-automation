/**
 * Reliance TP — login only for now. Logs in through common/login (same loading,
 * invalid-credential and error handling as every other handler), then stops
 * cleanly: the Reliance TP form is not built yet. Replace with a runHandler body
 * (see odCompany/relianceOD/relianceOD.js) when it is.
 */
const { makeLoginOnlyHandler } = require("../../common/loginOnlyHandler");

const fillRelianceTP = makeLoginOnlyHandler("reliance", "tp");

module.exports = { fillRelianceTP };
