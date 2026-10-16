// Run with: node --require ./test/support/noRealWorld.js --test test/kshemaLog.test.js
//
// A KSHEMA TP-only policy's log said "[kshema Full ]" on every line (2026-10-16): the helpers (kshemaLog, kshemaFields,
// kshemaSection ...) are ONE set of files used by the full-company flow and by the TP-only copy, and the bracket was a fixed
// string — so a TP-only job looked like it was running the full flow. The word in the bracket now comes from the flow that
// is running (kshemaLog.withFlow, wrapped around the whole TP run by kshemaTP.js). No browser: a stubbed TP form.
const path = require("path");
// featureGate reads this once, when it first loads — set it before anything below can load it.
process.env.MULTI_COMPANY_AUTOMATION_ENABLED = "true";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const kshemaLog = require(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaLog.js"));

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Run fn and return what console.log / warn / error printed (one string per call) plus fn's result. */
async function capture(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const take = (...args) => lines.push(args.join(" "));
  console.log = console.warn = console.error = take;
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    Object.assign(console, saved);
  }
}
const withEnv = async (vars, fn) => {
  const before = {};
  for (const key of Object.keys(vars)) {
    before[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
};

/* ------------------------------ the bracket ------------------------------ */

test("outside any flow the bracket is exactly what it always was - the full-company flow's output is unchanged", async () => {
  assert.equal(kshemaLog.prefix(), "[kshema Full ]");
  assert.equal(kshemaLog.currentFlow(), "Full");
  const { lines } = await capture(async () => {
    kshemaLog.log("✅ LOGGED IN");
    kshemaLog.warn("slow");
    kshemaLog.err("failed");
  });
  assert.deepEqual(lines, ["[kshema Full ] ✅ LOGGED IN", "[kshema Full ] ⚠️  slow", "[kshema Full ] ❌ failed"]);
});

test("inside withFlow('TP') every line says TP, in a bracket of the same width", async () => {
  const { lines } = await capture(() =>
    kshemaLog.withFlow("TP", async () => {
      kshemaLog.log("a");
      kshemaLog.warn("b");
      kshemaLog.err("c");
    })
  );
  assert.deepEqual(lines, ["[kshema TP   ] a", "[kshema TP   ] ⚠️  b", "[kshema TP   ] ❌ c"]);
  assert.equal(kshemaLog.withFlow("TP", () => kshemaLog.prefix()).length, kshemaLog.prefix().length, "the messages still line up");
});

test("withFlow returns what the function returns, passes a rejection on, and the flow does not outlive it", async () => {
  assert.equal(await kshemaLog.withFlow("TP", async () => 42), 42);
  await assert.rejects(() => kshemaLog.withFlow("TP", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(kshemaLog.prefix(), "[kshema Full ]", "back to the default after the run");

  // a flow that is awaited across several ticks is still in scope at the end of it, and gone right after
  let inside;
  await kshemaLog.withFlow("TP", async () => {
    await tick();
    await tick();
    inside = kshemaLog.prefix();
  });
  assert.equal(inside, "[kshema TP   ]");
  assert.equal(kshemaLog.prefix(), "[kshema Full ]");
});

test("two jobs in one process keep their own word (KSHEMAMAXWINDOW runs them side by side)", async () => {
  const seen = [];
  const job = (flow) => async () => {
    for (let i = 0; i < 3; i++) {
      await tick();
      seen.push(`${flow || "plain"}:${kshemaLog.prefix()}`);
    }
  };
  await Promise.all([kshemaLog.withFlow("TP", job("TP")), job(null)(), kshemaLog.withFlow("OD", job("OD"))]);
  for (const line of seen) {
    const [who, bracket] = line.split(":");
    const expected = { TP: "[kshema TP   ]", plain: "[kshema Full ]", OD: "[kshema OD   ]" }[who];
    assert.equal(bracket, expected, line);
  }
  assert.equal(seen.length, 9);
});

test("FLOW_LOG_PREFIX_ENABLED false / 0 / no / off puts the old fixed 'Full' back - read like the Reliance flow tag reads it", async () => {
  const flowLog = require(path.join(ROOT, "lib", "flowLogPrefix.js")); // loads dotenv: required here, after the env above is set
  for (const value of [undefined, "", "true", "1", "yes", "on", "false", "FALSE", "0", "no", "off", " OFF ", "garbage"]) {
    await withEnv({ FLOW_LOG_PREFIX_ENABLED: value }, async () => {
      const on = flowLog.isFlowLogPrefixEnabled();
      const word = kshemaLog.withFlow("TP", () => kshemaLog.currentFlow());
      assert.equal(word, on ? "TP" : "Full", `FLOW_LOG_PREFIX_ENABLED=${JSON.stringify(value)}`);
      assert.equal(kshemaLog.withFlow("TP", () => 7), 7, "the function still runs when the switch is off");
    });
  }
});

test("debug lines (KSHEMA_VERBOSE=true) carry the flow word too", async () => {
  await withEnv({ KSHEMA_VERBOSE: "true" }, async () => {
    // VERBOSE is read when the module loads: a fresh copy, put back afterwards
    const id = require.resolve(path.join(ROOT, "fullPolicycompany", "kshema", "kshemaLog.js"));
    const saved = require.cache[id];
    delete require.cache[id];
    try {
      const verbose = require(id);
      const { lines } = await capture(async () => {
        verbose.debug("outside");
        await verbose.withFlow("TP", async () => verbose.debug("detail"));
      });
      assert.deepEqual(lines, ["[kshema Full ] outside", "[kshema TP   ] detail"]);
    } finally {
      require.cache[id] = saved;
    }
  });
});

/* ------------------------------ the KSHEMA TP handler ------------------------------ */

// The TP form is stubbed (it would open a browser); the handler is loaded fresh around the stub.
const formPath = require.resolve(path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"));
let formBehaviour = async () => ({ success: true });
require.cache[formPath] = { id: formPath, filename: formPath, loaded: true, exports: { fillKshemaForm: (data) => formBehaviour(data) } };
const handlerPath = path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTP.js");
let fillKshemaTP;
test.before(async () => {
  await capture(() => {
    ({ fillKshemaTP } = require(handlerPath));
  });
});

test("the TP handler runs the WHOLE form under 'TP', after a first line that says which flow it is", async () => {
  await withEnv({ KSHEMA_TP_FORM_ENABLED: "true", KSHEMA_TP_PRODUCT_TYPE: "Two Wheeler-Long term Liability only", FLOW_LOG_PREFIX_ENABLED: undefined }, async () => {
    formBehaviour = async (data) => {
      kshemaLog.log("✅ LOGGED IN");
      await tick();
      kshemaLog.warn("slow field");
      await tick();
      kshemaLog.err("a failure");
      return { success: true, seen: data.firstName };
    };
    const { lines, result } = await capture(() => fillKshemaTP({ firstName: "ANMOLA" }));
    assert.deepEqual(result, { success: true, seen: "ANMOLA" }, "the form's result is handed back untouched");
    assert.deepEqual(lines, [
      '[kshema TP   ] ▶ KSHEMA third-party-only flow (Product Type "Two Wheeler-Long term Liability only")',
      "[kshema TP   ] ✅ LOGGED IN",
      "[kshema TP   ] ⚠️  slow field",
      "[kshema TP   ] ❌ a failure",
    ]);
    assert.equal(lines.some((l) => l.includes("kshema Full")), false, "not one line of a TP-only job says Full");
    assert.equal(kshemaLog.prefix(), "[kshema Full ]", "and the next, unrelated line is back to the default");
  });
});

test("held at the Product Type (not ready): the first line says so, and the notice is printed", async () => {
  await withEnv({ KSHEMA_TP_FORM_ENABLED: "false", KSHEMA_TP_PRODUCT_TYPE: "Two Wheeler-Long term Liability only" }, async () => {
    formBehaviour = async () => ({ success: false });
    const { lines } = await capture(() => fillKshemaTP({}));
    assert.equal(lines[0], "[kshema TP   ] ▶ KSHEMA third-party-only flow (held at the Product Type)");
    assert.ok(lines.some((l) => l.includes("[KSHEMA TP] a KSHEMA TP part logs in")), "the hold notice is still there");
  });
});

test("a failure of the TP form still reaches the caller, and its lines were TP too", async () => {
  await withEnv({ KSHEMA_TP_FORM_ENABLED: "true", KSHEMA_TP_PRODUCT_TYPE: "X" }, async () => {
    formBehaviour = async () => {
      await tick();
      kshemaLog.err("about to fail");
      throw new Error("[E302] Job timeout");
    };
    const { result, lines } = await capture(() => fillKshemaTP({}).then(() => "resolved", (e) => e.message));
    assert.match(result, /^\[E302\] Job timeout/, "the caller still sees the error");
    assert.ok(lines.includes("[kshema TP   ] ❌ about to fail"));
    assert.equal(kshemaLog.prefix(), "[kshema Full ]");
  });
});

test("a TP job and a full-company job running side by side do not borrow each other's word", async () => {
  await withEnv({ KSHEMA_TP_FORM_ENABLED: "true", KSHEMA_TP_PRODUCT_TYPE: "X" }, async () => {
    formBehaviour = async () => {
      for (let i = 1; i <= 3; i++) {
        await tick();
        kshemaLog.log(`tp-${i}`);
      }
    };
    const fullFlow = async () => {
      for (let i = 1; i <= 3; i++) {
        await tick();
        kshemaLog.log(`full-${i}`);
      }
    };
    const { lines } = await capture(() => Promise.all([fillKshemaTP({}), fullFlow()]));
    for (const line of lines.filter((l) => /tp-\d$/.test(l))) assert.ok(line.startsWith("[kshema TP   ] "), line);
    for (const line of lines.filter((l) => /full-\d$/.test(l))) assert.ok(line.startsWith("[kshema Full ] "), line);
    assert.equal(lines.filter((l) => /full-\d$/.test(l)).length, 3);
    assert.equal(lines.filter((l) => /tp-\d$/.test(l)).length, 3);
  });
});

test("with the switch off the TP handler prints the old '[kshema Full ]' (the way back)", async () => {
  await withEnv({ KSHEMA_TP_FORM_ENABLED: "true", KSHEMA_TP_PRODUCT_TYPE: "X", FLOW_LOG_PREFIX_ENABLED: "false" }, async () => {
    formBehaviour = async () => {
      kshemaLog.log("inside");
    };
    const { lines } = await capture(() => fillKshemaTP({}));
    assert.ok(lines.length >= 2);
    assert.ok(lines.every((l) => l.startsWith("[kshema Full ] ") || l.includes("[KSHEMA TP]")), lines.join("\n"));
  });
});

test("the handler is still the registry's KSHEMA TP entry, and the gate still comes before the form", () => {
  const { registry } = require(path.join(ROOT, "multiCompany", "registry.js"));
  assert.equal(registry.kshema.tp, fillKshemaTP);
  const src = fs.readFileSync(handlerPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const body = src.slice(src.indexOf("async function fillKshemaTP"));
  assert.ok(body.indexOf("assertMultiCompanyEnabled()") < body.indexOf('withFlow("TP"'), "gate, then the flow");
  assert.ok(body.indexOf('withFlow("TP"') < body.indexOf("fillKshemaForm(data)"), "the form runs INSIDE the flow");
});

/* ------------------------------ why the handler has to do it ------------------------------ */

test("both KSHEMA flows log through the SAME kshemaLog module - which is why the word has to come from the running flow", () => {
  const original = fs.readFileSync(path.join(ROOT, "fullPolicycompany", "kshemaForm.js"), "utf8");
  const copy = fs.readFileSync(path.join(ROOT, "multiCompany", "tpCompany", "kshemaTP", "kshemaTPForm.js"), "utf8");
  assert.match(original, /require\("\.\/kshema\/kshemaLog"\)/);
  assert.match(copy, /require\("\.\.\/\.\.\/\.\.\/fullPolicycompany\/kshema\/kshemaLog"\)/);
});
