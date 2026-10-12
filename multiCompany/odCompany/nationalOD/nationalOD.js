/**
 * National OD — login only for now. Logs in through common/login (same loading,
 * invalid-credential and error handling as every other handler), then stops
 * cleanly: the National OD form is not built yet. Replace with a runHandler body
 * (the shape is in common/loginOnlyHandler.js and relianceOD.js's header) when it is.
 */
const { makeLoginOnlyHandler } = require("../../common/loginOnlyHandler");

const fillNationalOD = makeLoginOnlyHandler("national", "od");

module.exports = { fillNationalOD };
