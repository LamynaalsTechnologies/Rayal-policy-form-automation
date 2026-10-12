// Run with: node --test test/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { createBreaker } = require("../breaker");
const { isAutomationStop, stoppedResult } = require("../automationStopper");
const runner = require("../lib/partRunner");

const NAME = "RTO/Make/Model/Variant";

/** A Breaker reading a fake env, writing to an array, with a short swallow-warning delay. */
function make(env = {}, graceMs = 20) {
  const logs = [];
  const breaker = createBreaker({ env, log: (line) => logs.push(String(line)), graceMs });
  return { breaker, env, logs };
}
const hit = (breaker, name = NAME) => {
  try {
    breaker.checkpoint(name);
  } catch (e) {
    return e;
  }
  return null;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("off: a checkpoint does nothing and says nothing when .env does not ask for a stop there", () => {
  for (const env of [{}, { BREAKER_ENABLED: "false" }, { BREAKER_ENABLED: "", BREAKER_STOP_AT: "Payment" }, { BREAKER_STOP_AT: "" }]) {
    const { breaker, logs } = make(env);
    assert.equal(breaker.isEnabled(), false);
    assert.equal(breaker.checkpoint(NAME), undefined);
    assert.deepEqual(logs, [], "a disabled Breaker is silent unless .env lists this checkpoint");
  }
});

test("off, but .env lists this checkpoint: it does not stop, and says why — once per checkpoint", () => {
  const one = make({ BREAKER_STOP_AT: NAME });
  assert.equal(hit(one.breaker), null, "no stop");
  assert.equal(one.logs.length, 1);
  assert.match(one.logs[0], /"RTO\/Make\/Model\/Variant" is listed in BREAKER_STOP_AT but BREAKER_ENABLED is not true — NOT stopping/);
  assert.match(one.logs[0], /BREAKER_ENABLED=true/);
  hit(one.breaker);
  hit(one.breaker, ` ${NAME.toUpperCase()} `);
  assert.equal(one.logs.length, 1, "said once per checkpoint");
  hit(one.breaker, "Some other point");
  assert.equal(one.logs.length, 1, "a checkpoint .env does not list stays silent");

  const star = make({ BREAKER_ENABLED: "false", BREAKER_STOP_AT: "*" });
  hit(star.breaker, "A");
  hit(star.breaker, "B");
  hit(star.breaker, "A");
  assert.equal(star.logs.length, 2, "once for each checkpoint");
});

test("a checkpoint with a missing or odd name never throws while it is not stopping", () => {
  const { breaker } = make({});
  for (const name of [undefined, null, "", 0, 123, {}, []]) assert.doesNotThrow(() => breaker.checkpoint(name));
  const on = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: NAME }).breaker;
  for (const name of [undefined, null, "", 0, {}]) assert.doesNotThrow(() => on.checkpoint(name));
});

test("enabled and named in BREAKER_STOP_AT: stops, as a deliberate stop that the job code already understands", () => {
  const { breaker, logs } = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: NAME });
  const stop = hit(breaker);
  assert.ok(stop, "it threw");
  assert.ok(isAutomationStop(stop));
  assert.match(stop.message, /Stopped on purpose at checkpoint "RTO\/Make\/Model\/Variant"/);
  assert.deepEqual(stop.details, { stage: "breaker", checkpoint: NAME, breaker: true });
  assert.ok(logs.some((l) => /BREAKER — stopped at checkpoint "RTO\/Make\/Model\/Variant"/.test(l)));

  const result = stoppedResult(stop);
  assert.equal(result.inProgress, true, "a calm stop, not a failure");
  assert.equal(result.retryable, false, "running it again would stop at the same place");
  assert.equal(result.success, false, "nothing was submitted");
  assert.equal(result.stage, "breaker");
});

test("a Breaker stop is a 'stopped' outcome for a part, not a retryable failure", () => {
  const stop = hit(make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "*" }).breaker);
  const outcome = runner.mapThrownError(stop, {
    part: { key: "od", kind: "portal", company: "Reliance" },
    companyName: "reliance",
    companyLabel: (c) => c,
  });
  assert.equal(outcome.type, "stopped");
  assert.equal(outcome.errorCode, "E100");
});

test("names match without regard to case or surrounding spaces; a name with slashes and spaces is one name", () => {
  const { breaker } = make({ BREAKER_ENABLED: "TRUE", BREAKER_STOP_AT: "  rto/make/model/variant  " });
  assert.ok(hit(breaker, "RTO/Make/Model/Variant"));
  assert.ok(hit(breaker, " RTO/MAKE/MODEL/VARIANT "));
  assert.equal(hit(breaker, "RTO"), null, "only the whole name matches");
  assert.equal(hit(breaker, "Make/Model"), null);

  const spaced = make({ BREAKER_ENABLED: "1", BREAKER_STOP_AT: "Nominee Details" }).breaker;
  assert.ok(hit(spaced, "nominee details"));
});

test("BREAKER_ENABLED accepts true / 1 / yes / on", () => {
  for (const on of ["true", "TRUE", "1", "yes", "on"]) {
    assert.ok(hit(make({ BREAKER_ENABLED: on, BREAKER_STOP_AT: NAME }).breaker), on);
  }
  for (const off of ["false", "0", "no", "off", "enabled", " "]) {
    assert.equal(hit(make({ BREAKER_ENABLED: off, BREAKER_STOP_AT: NAME }).breaker), null, off);
  }
});

test("BREAKER_STOP_AT is a comma-separated list; `*` stops at the first checkpoint reached", () => {
  const { breaker } = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "Login done, RTO/Make/Model/Variant ,Payment" });
  assert.ok(hit(breaker, "login done"));
  assert.ok(hit(breaker, "RTO/Make/Model/Variant"));
  assert.ok(hit(breaker, "payment"));
  assert.equal(hit(breaker, "Nominee"), null);
  assert.deepEqual(breaker.stopPoints(), ["login done", "rto/make/model/variant", "payment"]);

  const star = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "*" }).breaker;
  assert.ok(hit(star, "anything at all"));
  assert.ok(hit(star, ""), "even an unnamed checkpoint");
});

test("enabled but the checkpoint is not listed (or the list is empty): runs on, and says which checkpoint it passed", () => {
  const { breaker, logs } = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "Payment" });
  assert.equal(hit(breaker, NAME), null);
  assert.ok(logs.some((l) => l.includes(`checkpoint "${NAME}" reached — continuing`) && l.includes("BREAKER_STOP_AT=Payment")));

  const empty = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: "" });
  assert.equal(hit(empty.breaker, NAME), null);
  assert.ok(empty.logs.some((l) => l.includes("BREAKER_STOP_AT=(empty)")));
});

test(".env is read on every call, so the switch can be flipped without rebuilding the Breaker", () => {
  const { breaker, env } = make({ BREAKER_ENABLED: "false", BREAKER_STOP_AT: NAME });
  assert.equal(hit(breaker), null);
  env.BREAKER_ENABLED = "true";
  assert.ok(hit(breaker));
  env.BREAKER_STOP_AT = "Payment";
  assert.equal(hit(breaker), null);
});

test("a stop that reaches a handler is acknowledged: no swallowed-stop warning", async () => {
  const { breaker, logs } = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: NAME }, 20);
  const stop = hit(breaker);
  stoppedResult(stop); // what every handler does with a stop
  await sleep(80);
  assert.equal(logs.some((l) => /swallowed/.test(l)), false);
});

test("a stop that nobody reports (a try/catch swallowed it) is called out after the grace period", async () => {
  const { breaker, logs } = make({ BREAKER_ENABLED: "true", BREAKER_STOP_AT: NAME }, 20);
  hit(breaker); // thrown, then "swallowed": nobody calls stoppedResult
  assert.equal(logs.some((l) => /swallowed/.test(l)), false, "not at once");
  await sleep(80);
  const warning = logs.find((l) => /swallowed/.test(l));
  assert.ok(warning, "the warning was printed");
  assert.match(warning, /RTO\/Make\/Model\/Variant/);
  assert.match(warning, /isAutomationStop\(e\)\) throw e/);
});

test("the shared instance is off in this test run (no BREAKER_* in the environment)", () => {
  const { Breaker } = require("../breaker");
  if (/^(1|true|yes|on)$/i.test(String(process.env.BREAKER_ENABLED || ""))) return; // .env switched on: nothing to assert
  assert.equal(Breaker.isEnabled(), false);
  assert.equal(Breaker.checkpoint(NAME), undefined);
});
