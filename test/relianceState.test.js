// Run with: node --require ./test/support/noRealWorld.js --test test/relianceState.test.js
//
// Reliance's State box always showed TAMIL NADU: it was set to data.state || "30", and data.state was "30" for every
// policy (server.js compared the saved "tamilnadu" with "TAMILNADU"). Now the policy's own State/Union Territory is
// matched by name to the option the page offers, and read back (fullPolicycompany/reliance/relianceState.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const {
  RELIANCE_STATE_OPTIONS,
  stateKey,
  customerStateOf,
  stateOptionFor,
  planRelianceState,
  selectRelianceState,
  checkStateAfterPincode,
  StateError,
} = require(path.join(ROOT, "fullPolicycompany", "reliance", "relianceState.js"));

const textOf = (wanted) => (stateOptionFor(RELIANCE_STATE_OPTIONS, wanted) || {}).text;

test("every state the Online Policy form offers is found in Reliance's list", () => {
  const file = path.join(ROOT, "..", "RayalBrokers-Frontend", "src", "Components", "Policy", "OnlinePolicy", "constants", "formOptions.js");
  if (!fs.existsSync(file)) return; // the frontend is not checked out next to the automation
  const src = fs.readFileSync(file, "utf8");
  const block = src.slice(src.indexOf("export const stateOptions"));
  const values = [...block.slice(0, block.indexOf("];")).matchAll(/value:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 10, "the form's state list was read");
  for (const v of values) assert.ok(textOf(v), `"${v}" has a Reliance option`);
});

test("the form's values, Aadhaar's spellings and Reliance's own all land on the right option", () => {
  assert.equal(textOf("tamilnadu"), "TAMIL NADU");
  assert.equal(textOf("Tamil Nadu"), "TAMIL NADU");
  assert.equal(textOf("TAMIL NADU"), "TAMIL NADU");
  assert.equal(textOf("karnataka"), "KARNATAKA");
  assert.equal(textOf("pondicherry"), "PUDUCHERRY U T");
  assert.equal(textOf("Puducherry (U.T.)"), "PUDUCHERRY U T");
  assert.equal(textOf("westbengal"), "WEST BENGAL");
  assert.equal(textOf("andhrapradesh"), "ANDHRA PRADESH");
  assert.equal(textOf("telangana"), "TELANGANA");
  assert.equal(textOf("Jammu & Kashmir"), "JAMMU AND KASHMIR");
  assert.equal(textOf("Chandigarh"), "CHANDIGARH U.T.");
  assert.equal(textOf("Ladakh"), "LADHAKH U.T.");
  assert.equal(textOf("Orissa"), "ODISHA");
  assert.equal(textOf("Uttar Pradesh"), "UTTAR PRADESH");
  assert.equal(textOf("Uttarakhand"), "UTTARAKHAND");
  assert.equal(textOf("Atlantis"), undefined);
  assert.equal(textOf(""), undefined);
  assert.equal(stateKey("PUDUCHERRY U T"), stateKey("pondicherry"));
});

test("KARNATAKA is option 17 - the old code's 26 is PUDUCHERRY on the portal", () => {
  assert.equal(stateOptionFor(RELIANCE_STATE_OPTIONS, "karnataka").value, "17");
  assert.equal(RELIANCE_STATE_OPTIONS.find((o) => o.value === "26").text, "PUDUCHERRY U T");
});

test("the policy's own state wins; the old numeric code is never read as a state", () => {
  assert.equal(customerStateOf({ customerState: "karnataka", state: "30" }), "karnataka");
  assert.equal(customerStateOf({ customerState: "  kerala ", state: "30" }), "kerala");
  assert.equal(customerStateOf({ state: "30" }), "", "\"30\" was every policy's code - it says nothing");
  assert.equal(customerStateOf({ state: "26" }), "");
  assert.equal(customerStateOf({ state: "Kerala" }), "Kerala", "a name in state is used when there is nothing else");
  assert.equal(customerStateOf({}), "");
});

test("no state, or one Reliance does not list, is a problem said in one sentence (no colon)", () => {
  const none = planRelianceState({ state: "30" });
  assert.equal(none.option, null);
  assert.match(none.problem, /has no State\/Union Territory/);
  assert.ok(!none.problem.includes(":"));
  const odd = planRelianceState({ customerState: "Atlantis" });
  assert.match(odd.problem, /"Atlantis" is not in Reliance's State list/);
  assert.ok(!odd.problem.includes(":"));
  const ok = planRelianceState({ customerState: "kerala", state: "30" });
  assert.equal(ok.problem, null);
  assert.equal(ok.option.text, "KERALA");
});

/** A page whose #state <select> behaves like the real one: setting value moves selectedIndex, unknown values clear it. */
function fakePage(options = RELIANCE_STATE_OPTIONS, { refuse = false, selected = "" } = {}) {
  const opts = [{ value: "", text: "State*" }, ...options].map((o) => ({ value: String(o.value), text: o.text, disabled: false }));
  const box = {
    options: opts,
    selectedIndex: Math.max(0, opts.findIndex((o) => o.value === selected)),
    get value() {
      return this.selectedIndex >= 0 ? this.options[this.selectedIndex].value : "";
    },
    set value(v) {
      if (refuse) return;
      this.selectedIndex = this.options.findIndex((o) => o.value === String(v));
    },
    dispatchEvent() {
      return true;
    },
  };
  const driver = {
    async executeScript(fn, ...args) {
      const saved = globalThis.document;
      globalThis.document = { getElementById: (id) => (id === "state" ? box : null) };
      try {
        return fn(...args);
      } finally {
        if (saved === undefined) delete globalThis.document;
        else globalThis.document = saved;
      }
    },
    async sleep() {},
  };
  return { box, driver };
}

/** The real pick, as selectLikeUser does it on a page: chooses the value it is given. */
const picker = (box) => async (driver, id, value) => {
  box.value = value;
  return { how: "list" };
};

const quiet = { pause: async () => {}, timeoutMs: 50 };

test("the policy's state is chosen and read back - not TAMIL NADU", async () => {
  const { box, driver } = fakePage();
  const lines = [];
  const got = await selectRelianceState(driver, { customerState: "karnataka", state: "30" }, { picker: picker(box), log: (l) => lines.push(l), ...quiet });
  assert.equal(got.text, "KARNATAKA");
  assert.equal(box.value, "17");
  assert.match(lines.join("\n"), /Selected State KARNATAKA \(the policy's State\/Union Territory "karnataka"\)/);
});

test("the option is found by NAME on the page, so a renumbered list still gets the right state", async () => {
  const renumbered = RELIANCE_STATE_OPTIONS.map((o) => (o.text === "KERALA" ? { value: "99", text: "KERALA" } : o));
  const { box, driver } = fakePage(renumbered);
  const got = await selectRelianceState(driver, { customerState: "kerala" }, { picker: picker(box), ...quiet });
  assert.equal(got.value, "99");
  assert.equal(box.value, "99");
});

test("with the real pick switched off the old scripted setter gets the page's value", async () => {
  const before = process.env.RELIANCE_REALISTIC_SELECT_ENABLED;
  process.env.RELIANCE_REALISTIC_SELECT_ENABLED = "false";
  try {
    const { box, driver } = fakePage();
    const calls = [];
    const select = async (d, id, value) => {
      calls.push([id, value]);
      box.value = value;
    };
    const got = await selectRelianceState(driver, { customerState: "pondicherry" }, { select, ...quiet });
    assert.deepEqual(calls, [["state", "26"]]);
    assert.equal(got.text, "PUDUCHERRY U T");
  } finally {
    if (before === undefined) delete process.env.RELIANCE_REALISTIC_SELECT_ENABLED;
    else process.env.RELIANCE_REALISTIC_SELECT_ENABLED = before;
  }
});

test("no state on the policy stops at the box with no retry, and nothing is chosen", async () => {
  const { box, driver } = fakePage();
  let picked = false;
  await assert.rejects(
    selectRelianceState(driver, { state: "30" }, { picker: async () => ((picked = true), { how: "list" }), ...quiet }),
    (e) => e instanceof StateError && e.nonRetryable === true && !e.message.includes(":")
  );
  assert.equal(picked, false);
  assert.equal(box.value, "");
});

test("a state the page does not offer stops with no retry and names what it offers", async () => {
  const { box, driver } = fakePage(RELIANCE_STATE_OPTIONS.filter((o) => o.text !== "GOA"));
  await assert.rejects(
    selectRelianceState(driver, { customerState: "goa" }, { picker: picker(box), ...quiet }),
    (e) => e instanceof StateError && /does not offer the policy's State\/Union Territory "goa"/.test(e.message) && /TAMIL NADU/.test(e.message)
  );
});

test("a box that does not take the state is an error (retryable, like any flaky page)", async () => {
  const { box, driver } = fakePage(RELIANCE_STATE_OPTIONS, { refuse: true });
  await assert.rejects(
    selectRelianceState(driver, { customerState: "kerala" }, { picker: picker(box), ...quiet }),
    (e) => !(e instanceof StateError) && /Reliance did not take the State "KERALA"/.test(e.message) && !e.message.includes(":")
  );
});

test("after the pincode the box is only read: same state, or a warning line - never changed", async () => {
  const same = fakePage(RELIANCE_STATE_OPTIONS, { selected: "17" });
  const lines = [];
  assert.equal(await checkStateAfterPincode(same.driver, { text: "KARNATAKA", raw: "karnataka" }, { log: (l) => lines.push(l) }), "same");
  const moved = fakePage(RELIANCE_STATE_OPTIONS, { selected: "30" });
  assert.equal(
    await checkStateAfterPincode(moved.driver, { text: "KARNATAKA", raw: "karnataka" }, { log: (l) => lines.push(l), pinCode: "614630" }),
    "changed"
  );
  assert.equal(moved.box.value, "30", "nothing was changed");
  assert.match(lines.join("\n"), /After pincode 614630 Reliance's State box reads "TAMIL NADU", not KARNATAKA/);
});

test("both Reliance flows choose the state this way (the old scripted 'data.state || \"30\"' is gone)", () => {
  for (const rel of [["fullPolicycompany", "relianceForm.js"], ["multiCompany", "common", "reliance", "relianceMultiForm.js"]]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel), "utf8");
    assert.ok(!src.includes('safeSelectDropdown(driver, "state",'), `${rel.join("/")} no longer sets the State box to data.state || "30"`);
    assert.ok(src.includes("await selectRelianceState(driver, data,"), `${rel.join("/")} chooses the policy's state`);
    assert.ok(src.includes("await checkStateAfterPincode("), `${rel.join("/")} reads the State back after the pincode`);
  }
});

test("server.js hands the policy's own state to the old one-job path too", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(src.includes('customerState: data?.state ? String(data.state).trim() : ""'), "thin jobs built here carry it");
  assert.ok(src.includes("job.formData.customerState = String(existingBrisk.state).trim();"), "an old job is given the policy's state now");
});
