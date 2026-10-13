/**
 * National TP — its one switch.
 *
 * NATIONAL_TP_FORM_ENABLED in the automation's .env: ON unless it is explicitly false / 0 / no / off.
 *   on (the default): a National TP part runs the whole duplicated National form for a third-party-only policy — it
 *        selects "5 Year Long Term Liability Only" and goes on, up to and including the payment link that goes to the
 *        customer.
 *   off (NATIONAL_TP_FORM_ENABLED=false): it logs in, opens the quote form, lists the "Your Plan" options and stops
 *        (stopBeforePlan.js). Nothing is chosen or bought, no nominee lookup, no database call.
 * MULTI_COMPANY_AUTOMATION_ENABLED (featureGate.js) still comes first: with that off nothing here runs at all.
 *
 * It started life default-OFF (a form that sends payment links should not switch itself on by being deployed); the
 * owner asked for it to just continue, so the default is on and the switch is the way back. To look at the TP quote
 * before anything is sent, use the Breaker instead: BREAKER_ENABLED=true, BREAKER_STOP_AT=National TP/quote.
 *
 * Read at CALL time, not at load, so a restart after editing .env is the only thing it needs and a test can flip it.
 */
require("dotenv").config({ quiet: true });

const isOff = (value) => /^(0|false|no|off)$/i.test(String(value == null ? "" : value).trim());

function isNationalTpFormEnabled() {
  return !isOff(process.env.NATIONAL_TP_FORM_ENABLED);
}

module.exports = { isNationalTpFormEnabled };
