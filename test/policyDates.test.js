// Run with: node --require ./test/support/noRealWorld.js --test test/policyDates.test.js
//
// lib/policyDates.js — policy dates read in INDIA time, whatever timezone the server runs in.
//
// The bug (2026-10-15): a nominee DOB picked as 16/10/2000 was typed into KSHEMA as 15/10/2000 on the production
// server and as 16/10/2000 on the developer's laptop. The picker stores local midnight in India
// (2000-10-15T18:30:00.000Z); `moment(x).format("DD-MM-YYYY")` formats in the SERVER's timezone, so a server on UTC
// printed the 15th. The same copy of these cases runs in the backend (RayalBrokers-backend/test/policyDates.test.js).
//
// No browser, no network, no database. The process timezone is switched at run time (Node re-reads TZ on assignment).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const moment = require("moment");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "lib", "policyDates.js");
const { formatPolicyDate, indiaCalendarDay } = require(HELPER);

/** Run fn once for each timezone, restoring the process timezone after. */
function underTimezones(zones, fn) {
  const before = process.env.TZ;
  try {
    for (const zone of zones) {
      process.env.TZ = zone;
      fn(zone);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const ZONES = ["UTC", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Auckland", "Europe/London"];

/** What a browser in India makes when a person picks a day: that day, at local midnight. */
function pickerDate(year, monthIndex, day) {
  const before = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
  try {
    return new Date(year, monthIndex, day);
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

test("the bug: an India-midnight instant is the 16th in every server timezone", () => {
  underTimezones(ZONES, (zone) => {
    assert.equal(formatPolicyDate("2000-10-15T18:30:00.000Z"), "16-10-2000", zone);
    assert.equal(formatPolicyDate(new Date("2000-10-15T18:30:00.000Z")), "16-10-2000", zone);
  });
});

test("control: the old expression gives the 15th on a UTC server — this test file can fail", () => {
  underTimezones(["UTC"], () => {
    assert.equal(moment("2000-10-15T18:30:00.000Z").format("DD-MM-YYYY"), "15-10-2000");
  });
  underTimezones(["Asia/Kolkata"], () => {
    assert.equal(moment("2000-10-15T18:30:00.000Z").format("DD-MM-YYYY"), "16-10-2000", "which is why it worked locally");
  });
});

test("a date the browser made (local midnight in India) is read back as the same day on any server", () => {
  const picked = [
    [pickerDate(2000, 9, 16), "16-10-2000"],
    [pickerDate(1990, 0, 1), "01-01-1990"],
    [pickerDate(2026, 11, 31), "31-12-2026"],
    [pickerDate(2024, 1, 29), "29-02-2024"],
    // India ran on +06:30 in the war years; a fixed +05:30 would be a day off here
    [pickerDate(1943, 5, 15), "15-06-1943"],
    [pickerDate(1942, 0, 1), "01-01-1942"],
  ];
  underTimezones(ZONES, (zone) => {
    for (const [date, expected] of picked) assert.equal(formatPolicyDate(date), expected, `${zone}: ${expected}`);
  });
});

test("the edges of the India day: 23:59:59.999 is still that day, midnight is the next", () => {
  underTimezones(ZONES, (zone) => {
    assert.equal(formatPolicyDate("2000-10-16T18:29:59.999Z"), "16-10-2000", zone);
    assert.equal(formatPolicyDate("2000-10-16T18:30:00.000Z"), "17-10-2000", zone);
    assert.equal(formatPolicyDate("2000-10-16T00:00:00.000Z"), "16-10-2000", `${zone}: UTC midnight is 05:30 the same day`);
  });
});

test("the shapes a stored date arrives in: Date, ISO string, { $date }, epoch ms", () => {
  const instant = "2000-10-15T18:30:00.000Z";
  underTimezones(ZONES, (zone) => {
    assert.equal(formatPolicyDate({ $date: instant }), "16-10-2000", zone);
    assert.equal(formatPolicyDate(Date.parse(instant)), "16-10-2000", zone);
    assert.equal(formatPolicyDate(moment(instant).toDate()), "16-10-2000", zone);
  });
});

test("a bare calendar day is kept as that day in every timezone, not shifted as an instant", () => {
  underTimezones(ZONES, (zone) => {
    assert.equal(formatPolicyDate("2000-10-16"), "16-10-2000", zone);
    assert.equal(formatPolicyDate("  2000-10-16 "), "16-10-2000", zone);
  });
});

test("a day that does not exist is 'Invalid date', never a rolled-over neighbour (V8's new Date rolls 31 Feb to 2 Mar)", () => {
  assert.equal(new Date("2000-02-31").getUTCDate(), 2, "the trap: the platform itself says 2 March");
  for (const bad of ["2000-02-31", "2000-02-31T10:00:00.000Z", "1900-02-29", "2001-04-31", "2000-13-01", "2000-00-10"]) {
    assert.equal(formatPolicyDate(bad), "Invalid date", bad);
  }
  assert.equal(formatPolicyDate("2000-02-29"), "29-02-2000", "2000 was a leap year");
  assert.equal(formatPolicyDate("2000-02-29T18:30:00.000Z"), "01-03-2000", "an instant is read in India: 00:00 on 1 March");
});

test("other formats: only YYYY, MM and DD are substituted", () => {
  assert.equal(formatPolicyDate("2000-10-15T18:30:00.000Z", "DD/MM/YYYY"), "16/10/2000");
  assert.equal(formatPolicyDate("2000-10-15T18:30:00.000Z", "YYYY-MM-DD"), "2000-10-16");
});

test("nothing there is '', not a date is 'Invalid date' — as the payload builders always did", () => {
  for (const empty of ["", null, undefined, 0, false]) assert.equal(formatPolicyDate(empty), "", String(empty));
  for (const bad of ["garbage", "31-31-2000", "not a date", {}, NaN]) {
    // a bare {} / NaN is falsy-or-invalid; whichever it is, it never throws and never returns a date
    const out = formatPolicyDate(bad);
    assert.ok(out === "Invalid date" || out === "", `${String(bad)} -> ${out}`);
  }
  assert.equal(formatPolicyDate("garbage"), "Invalid date");
});

test("a runtime without timezone data falls back to the fixed +05:30 and is still right", () => {
  const realDtf = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function brokenDateTimeFormat() {
    throw new RangeError("Invalid time zone specified: Asia/Kolkata");
  };
  try {
    underTimezones(ZONES, (zone) => {
      assert.equal(formatPolicyDate("2000-10-15T18:30:00.000Z"), "16-10-2000", zone);
      assert.deepEqual(indiaCalendarDay(new Date("2000-10-16T18:30:00.000Z")), [2000, 10, 17], zone);
    });
  } finally {
    Intl.DateTimeFormat = realDtf;
  }
});

test("the helper has no requires (it is copied between repos as is) and is not tied to moment", () => {
  const src = fs.readFileSync(HELPER, "utf8");
  assert.equal(/\brequire\s*\(/.test(src), false);
});

test("wiring: server.js builds all four dates with formatPolicyDate and no longer formats them with moment", () => {
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(src, /require\("\.\/lib\/policyDates"\)/);
  for (const [field, source] of [
    ["dob", "dateOfBirth"],
    ["purchaseDate", "purchaseDate"],
    ["registrationDate", "registrationDate"],
    ["nomineeDob", "nomineeDob"],
  ]) {
    assert.ok(
      src.includes(`${field}: formatPolicyDate(data?.${source}),`),
      `${field} is built from data?.${source} with formatPolicyDate`
    );
  }
  assert.equal(/moment\(data[?.]/.test(src), false, "no policy date is still formatted with moment() in server.js");
});
