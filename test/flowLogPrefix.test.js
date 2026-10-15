// Run with: node --test test/flowLogPrefix.test.js
//
// Every console line a Reliance job prints starts with its flow ("Reliance TP+OD | ..."). lib/flowLogPrefix.js does it
// with an AsyncLocalStorage + one wrap of the console methods. These tests run it against a stand-in console, never
// the real one, and read server.js as text for the places that make it work.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const flow = require("../lib/flowLogPrefix");

/** Run fn with FLOW_LOG_PREFIX_ENABLED set (undefined = absent), then put it back. */
function withSwitch(value, fn) {
  const before = process.env.FLOW_LOG_PREFIX_ENABLED;
  if (value === undefined) delete process.env.FLOW_LOG_PREFIX_ENABLED;
  else process.env.FLOW_LOG_PREFIX_ENABLED = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.FLOW_LOG_PREFIX_ENABLED;
    else process.env.FLOW_LOG_PREFIX_ENABLED = before;
  }
}

/** A console stand-in: every call that reaches the "real" output is recorded with the method it came in on. */
function fakeConsole() {
  const out = [];
  const record = (method) => (...args) => out.push({ method, args });
  return {
    out,
    log: record("log"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  };
}

/** A fake console with the wrap installed (colours off, so object formatting is the same in a terminal and in CI). */
function tagged() {
  const c = fakeConsole();
  assert.equal(withSwitch(undefined, () => flow.install(c, { colors: false })), true);
  return c;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (c) => c.out.map((o) => o.args[0]);

/* ------------------------------ which flow is which ------------------------------ */

test("flowLabel: the bundled part and a legacy job are TP+OD, tp is TP, od is OD", () => {
  const label = (job) => flow.flowLabel(job);
  assert.equal(label({ company: "reliance", partKey: "motor" }), "Reliance TP+OD");
  assert.equal(label({ company: "Reliance", partKey: "motor" }), "Reliance TP+OD", "the part's company is capitalised");
  assert.equal(label({ company: "reliance", partKey: "tp" }), "Reliance TP");
  assert.equal(label({ company: "reliance", partKey: "od" }), "Reliance OD");
  // a job from before parts existed: only policyType says anything, and only "od" / "tp" — as server.js dispatches it
  assert.equal(label({ company: "reliance" }), "Reliance TP+OD");
  assert.equal(label({ company: "reliance", policyType: "" }), "Reliance TP+OD");
  assert.equal(label({ company: "reliance", policyType: "full" }), "Reliance TP+OD");
  assert.equal(label({ company: "reliance", policyType: "OD" }), "Reliance OD");
  assert.equal(label({ company: "reliance", policyType: "tp" }), "Reliance TP");
  // a part key beats a stale policyType on the same job
  assert.equal(label({ company: "reliance", partKey: "motor", policyType: "od" }), "Reliance TP+OD");
});

test("flowLabel: only the tagged insurers, and never the Brisk PA part", () => {
  assert.deepEqual(flow.TAGGED_COMPANIES, ["reliance"]);
  assert.equal(flow.flowLabel({ company: "national", partKey: "motor" }), null);
  assert.equal(flow.flowLabel({ company: "kshema", partKey: "tp" }), null);
  assert.equal(flow.flowLabel({ company: "Brisk", partKey: "pa" }), null);
  assert.equal(flow.flowLabel({ company: "reliance", partKey: "pa" }), null, "pa has no label even on a Reliance job");
  assert.equal(flow.flowLabel({ company: "reliance", partKey: "something-new" }), null);
  assert.equal(flow.flowLabel({}), null);
  assert.equal(flow.flowLabel(), null);
});

test("flowLabel: uses the brand label the caller passes", () => {
  assert.equal(
    flow.flowLabel({ company: "reliance", partKey: "od", companyLabel: () => "RELIANCE" }),
    "RELIANCE OD"
  );
});

test("the prefix: label padded to the longest one, then ' | '", () => {
  assert.equal(flow.formatPrefix("Reliance TP+OD"), "Reliance TP+OD | ");
  assert.equal(flow.formatPrefix("Reliance TP"), "Reliance TP    | ");
  assert.equal(flow.formatPrefix("Reliance OD"), "Reliance OD    | ");
  assert.equal(flow.LABEL_WIDTH, "Reliance TP+OD".length);
});

/* ------------------------------ the switch ------------------------------ */

test("the switch is ON unless explicitly false / 0 / no / off", () => {
  withSwitch(undefined, () => assert.equal(flow.isFlowLogPrefixEnabled(), true));
  for (const on of ["true", "1", "yes", "on", "", "anything"]) {
    withSwitch(on, () => assert.equal(flow.isFlowLogPrefixEnabled(), true, `"${on}" keeps it on`));
  }
  for (const off of ["false", "FALSE", "0", "no", "Off", " off "]) {
    withSwitch(off, () => assert.equal(flow.isFlowLogPrefixEnabled(), false, `"${off}" turns it off`));
  }
});

test("switch off: install wraps nothing, run just calls the function, outside just calls it", () => {
  withSwitch("false", () => {
    const c = fakeConsole();
    const before = { log: c.log, warn: c.warn, error: c.error };
    assert.equal(flow.install(c), false);
    assert.equal(c.log, before.log, "console.log is the very same function");
    assert.equal(c.warn, before.warn);
    assert.equal(c.error, before.error);

    const result = flow.run("Reliance TP+OD", () => {
      assert.equal(flow.currentLabel(), undefined, "no label is put in scope");
      c.log("plain");
      return 42;
    });
    assert.equal(result, 42);
    assert.deepEqual(c.out, [{ method: "log", args: ["plain"] }]);
    assert.equal(flow.outside(() => "x"), "x");
  });
});

test("install is done once: a second call changes nothing and the line is not tagged twice", () => {
  const c = tagged();
  const wrapped = c.log;
  assert.equal(withSwitch(undefined, () => flow.install(c, { colors: false })), false);
  assert.equal(c.log, wrapped);
  flow.run("Reliance OD", () => c.log("once"));
  assert.deepEqual(lines(c), ["Reliance OD    | once"]);
});

/* ------------------------------ what gets printed ------------------------------ */

test("outside a flow every call reaches the real console exactly as it came in", () => {
  const c = tagged();
  const obj = { a: 1 };
  c.log("plain %s", "text", obj);
  c.error("bad", new Error("boom"));
  assert.equal(c.out[0].method, "log");
  assert.deepEqual(c.out[0].args, ["plain %s", "text", obj], "same arguments, same object — nothing formatted");
  assert.equal(c.out[1].method, "error");
  assert.equal(c.out[1].args[0], "bad");
  assert.ok(c.out[1].args[1] instanceof Error);
});

test("inside a flow log / info / warn / error / debug keep their own method and are tagged", () => {
  const c = tagged();
  flow.run("Reliance TP+OD", () => {
    c.log("a");
    c.info("b");
    c.warn("c");
    c.error("d");
    c.debug("e");
  });
  assert.deepEqual(
    c.out.map((o) => [o.method, o.args[0]]),
    [
      ["log", "Reliance TP+OD | a"],
      ["info", "Reliance TP+OD | b"],
      ["warn", "Reliance TP+OD | c"],
      ["error", "Reliance TP+OD | d"],
      ["debug", "Reliance TP+OD | e"],
    ]
  );
});

test("every physical line is tagged; a blank line gets the bare pipe, with no trailing space", () => {
  const c = tagged();
  flow.run("Reliance TP", () => {
    c.log("first\nsecond\n\nfourth");
    c.log("\n" + "=".repeat(5));
    c.log();
  });
  assert.deepEqual(lines(c), [
    "Reliance TP    | first\nReliance TP    | second\nReliance TP    |\nReliance TP    | fourth",
    "Reliance TP    |\nReliance TP    | =====",
    "Reliance TP    |",
  ]);
});

test("printf placeholders, objects and Errors are formatted the way console would, then tagged", () => {
  const c = tagged();
  flow.run("Reliance OD", () => {
    c.log("%s is %d years", "Asha", 31);
    c.log("data:", { a: 1, b: [1, 2] });
    c.error("failed:", new Error("boom"));
  });
  const out = lines(c);
  assert.equal(out[0], "Reliance OD    | Asha is 31 years");
  assert.equal(out[1], "Reliance OD    | data: { a: 1, b: [ 1, 2 ] }");
  // an Error prints its stack: several lines, and EVERY one of them is tagged
  const errorLines = out[2].split("\n");
  assert.match(errorLines[0], /^Reliance OD {4}\| failed: Error: boom$/);
  assert.ok(errorLines.length > 1, "the stack is more than one line");
  for (const l of errorLines) assert.ok(l.startsWith("Reliance OD    |"), `untagged line: ${l}`);
});

test("what an awaited step prints after a delay still carries the flow's tag", async () => {
  const c = tagged();
  await flow.run("Reliance TP+OD", async () => {
    await sleep(5);
    c.log("after the wait");
    await Promise.all([sleep(3), sleep(1)]);
    c.log("after Promise.all");
  });
  assert.deepEqual(lines(c), ["Reliance TP+OD | after the wait", "Reliance TP+OD | after Promise.all"]);
});

test("two flows running side by side keep their own tag on every line", async () => {
  const c = tagged();
  const job = (label, delays) =>
    flow.run(label, async () => {
      for (const [i, d] of delays.entries()) {
        await sleep(d);
        c.log(`step ${i}`);
      }
    });
  await Promise.all([job("Reliance TP+OD", [6, 10, 4]), job("Reliance OD", [9, 3, 11])]);

  const out = lines(c);
  assert.equal(out.length, 6);
  assert.equal(out.filter((l) => l.startsWith("Reliance TP+OD | ")).length, 3);
  assert.equal(out.filter((l) => l.startsWith("Reliance OD    | ")).length, 3);
  // the tag is the first LABEL_WIDTH characters: the two jobs must have taken turns, or this proves nothing
  const tagOf = (l) => l.slice(0, flow.LABEL_WIDTH);
  const turns = out.filter((l, i) => i > 0 && tagOf(l) !== tagOf(out[i - 1])).length;
  assert.ok(turns >= 2, `the two jobs really did interleave (${turns} switches)`);
});

test("run hands back what the function returns, and does nothing for a null label", async () => {
  const c = tagged();
  assert.equal(await flow.run("Reliance OD", async () => "done"), "done");
  assert.equal(flow.run(null, () => (c.log("untagged"), 7)), 7);
  assert.deepEqual(lines(c), ["untagged"]);
  assert.equal(flow.currentLabel(), undefined);
});

test("outside: code started from inside a flow can opt out — a queue pass is not that job's line", async () => {
  const c = tagged();
  await flow.run("Reliance TP+OD", () =>
    new Promise((resolve) => {
      // a timer created INSIDE the job inherits its tag...
      setTimeout(() => {
        c.log("the job's own timer");
        // ...unless the code it runs steps outside
        flow.outside(() => c.log("Found 1 pending jobs"));
        resolve();
      }, 1);
    })
  );
  assert.deepEqual(lines(c), ["Reliance TP+OD | the job's own timer", "Found 1 pending jobs"]);
});

test("outside leaves the job's own context alone for the rest of the job", async () => {
  const c = tagged();
  await flow.run("Reliance OD", async () => {
    flow.outside(() => c.log("outside"));
    await sleep(1);
    c.log("back inside");
  });
  assert.deepEqual(lines(c), ["outside", "Reliance OD    | back inside"]);
});

/* ------------------------------ server.js is wired the way the above needs ------------------------------ */

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const at = (needle, from = 0) => {
  const i = serverSrc.indexOf(needle, from);
  assert.ok(i >= 0, `missing in server.js: ${needle}`);
  return i;
};

test("server.js: the wrap is installed right after .env loads, before anything captures console.log", () => {
  const dotenv = at('require("dotenv").config();');
  const install = at("flowLog.install();");
  assert.ok(dotenv < install, "the switch is read from .env, so dotenv comes first");
  assert.ok(install < at('require("./breaker")'), "breaker.js captures console.log when it is created");
  assert.ok(install < at('require("./fullPolicycompany/relianceForm")'));
  assert.ok(install < at('require("./sessionManager")'));
});

test("server.js: the part run and the legacy run are BOTH started inside the flow tag", () => {
  const inFlowDef = at("const inFlow = (fn) => flowLog.run(flow, fn);");
  const label = at("const flow = flowLog.flowLabel({");
  assert.ok(label < inFlowDef);

  const run = at("inFlow(() => (part ? partRunner.runPartJob(partRunnerDeps, job) : runPolicyJob(job)))");
  assert.ok(inFlowDef < run);
  // and nothing starts them outside it
  assert.equal(serverSrc.split("partRunner.runPartJob(").length - 1, 1, "runPartJob is started in one place");
  assert.equal(serverSrc.split("runPolicyJob(job)").length - 1, 1, "runPolicyJob is started in one place");

  // the "Starting ... part" line and the UNEXPECTED ERROR lines are tagged too
  assert.ok(inFlowDef < at("inFlow(() =>\n        console.log("), "the Starting line goes through inFlow");
  assert.ok(run < at("inFlow(() => {\n            console.error("), "the safety-net error lines go through inFlow");
});

test("server.js: the queue pass always runs outside any flow tag", () => {
  const wrapper = at("const processRelianceQueue = () => flowLog.outside(runQueuePass);");
  const body = at("const runQueuePass = async () => {");
  assert.ok(wrapper < body);
  assert.equal(
    serverSrc.split("const processRelianceQueue").length - 1,
    1,
    "processRelianceQueue is defined once — every caller goes through the wrapper"
  );
});
