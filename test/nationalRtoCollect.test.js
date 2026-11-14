// Run with: node --require ./test/support/noRealWorld.js --test test/nationalRtoCollect.test.js
//
// The owner's request (2026-11-14): National's RTO Location options ("Gurgaon - NCR", "Delhi - South - DL 03", "Ambala") are saved ONCE
// into a JSON file on the backend - NOT into the RTO City Location master - and shown in the policy form's optional "National RTO
// (City - Branch)" dropdown. City - branch split at the first " - "; no " - " = city only. Entries are only added. Fakes only.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rto = require("../lib/nationalRtoCollect");
const { RTO_LIST, fakeNationalPage } = require("./nationalFakePage");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const tmpFile = (name = "locations.json") => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nat-rto-")), "json", name);

test("City - Branch splits at the FIRST ' - '; no ' - ' = the whole text is the city", () => {
  assert.deepEqual(rto.parseRtoText("Gurgaon - NCR"), { text: "GURGAON - NCR", city: "GURGAON", branch: "NCR" });
  assert.deepEqual(rto.parseRtoText("Delhi - South - DL 03"), { text: "DELHI - SOUTH - DL 03", city: "DELHI", branch: "SOUTH - DL 03" });
  assert.deepEqual(rto.parseRtoText("Chennai - North West"), { text: "CHENNAI - NORTH WEST", city: "CHENNAI", branch: "NORTH WEST" });
  assert.deepEqual(rto.parseRtoText("Ambala"), { text: "AMBALA", city: "AMBALA", branch: "" });
  assert.deepEqual(rto.parseRtoText("  Jagadhari  "), { text: "JAGADHARI", city: "JAGADHARI", branch: "" });
  assert.deepEqual(rto.parseRtoText("Port-Blair"), { text: "PORT-BLAIR", city: "PORT-BLAIR", branch: "" }, "a dash inside a name is not a split");
  assert.deepEqual(rto.parseRtoText("Noida - NCR"), { text: "NOIDA - NCR", city: "NOIDA", branch: "NCR" }, "a non-breaking space counts as a space");
  assert.match(rto.parseRtoText("").skip, /empty/);
  assert.match(rto.parseRtoText(" - NCR").skip, /no city before the dash/);
  assert.match(rto.parseRtoText("<b>x</b>").skip, /not a usable location text/);
});

test("saving writes the JSON file: sorted, one entry per text, text + city + branch, and creates the folder", () => {
  const file = tmpFile();
  const now = () => new Date("2026-11-14T10:00:00Z");
  const res = rto.saveLocationsFile(file, [...RTO_LIST, "Gurgaon - NCR", ""], { now });
  assert.deepEqual({ added: res.added, alreadyThere: res.alreadyThere, total: res.total, skipped: res.skipped.length, file: res.file }, { added: 6, alreadyThere: 0, total: 6, skipped: 1, file });
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(body.updatedAt, "2026-11-14T10:00:00.000Z");
  assert.deepEqual(body.locations.map((l) => l.text), ["AMBALA", "CHENNAI - WEST", "FARIDABAD - NCR", "GURGAON - NCR", "JAGADHARI", "NOIDA - NCR"]);
  assert.deepEqual(body.locations.find((l) => l.text === "GURGAON - NCR"), { text: "GURGAON - NCR", city: "GURGAON", branch: "NCR" });
  assert.deepEqual(body.locations.find((l) => l.text === "AMBALA"), { text: "AMBALA", city: "AMBALA", branch: "" });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["locations.json"], "no temporary file is left behind");
});

test("a second run adds nothing and does not touch the file; a new text is ADDED; nothing is ever removed", () => {
  const file = tmpFile();
  rto.saveLocationsFile(file, RTO_LIST, { now: () => new Date("2026-11-14T10:00:00Z") });
  const before = fs.readFileSync(file, "utf8");
  const again = rto.saveLocationsFile(file, RTO_LIST, { now: () => new Date("2027-01-01T00:00:00Z") });
  assert.deepEqual({ added: again.added, alreadyThere: again.alreadyThere, total: again.total }, { added: 0, alreadyThere: 6, total: 6 });
  assert.equal(fs.readFileSync(file, "utf8"), before, "the file is the same bytes");

  // the portal now lists fewer places and one new one: the old ones stay
  const third = rto.saveLocationsFile(file, ["Ambala", "Delhi - North"], { now: () => new Date("2027-02-01T00:00:00Z") });
  assert.deepEqual({ added: third.added, alreadyThere: third.alreadyThere, total: third.total }, { added: 1, alreadyThere: 1, total: 7 });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).locations.length, 7);
});

test("a broken file does not stop a run: it is read as empty and rewritten with what was found", () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const res = rto.saveLocationsFile(file, ["Ambala"]);
  assert.equal(res.added, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).locations.map((l) => l.text), ["AMBALA"]);
});

test("the backend and this script write the SAME file for the same texts (the two writers are kept alike)", (t) => {
  const backend = path.join(__dirname, "..", "..", "RayalBrokers-backend", "shared", "nationalRtoLocations.js");
  if (!fs.existsSync(backend)) return t.skip("backend repo not next to this one");
  const theirs = require(backend);
  const a = tmpFile("a.json");
  const b = tmpFile("b.json");
  const texts = ["Gurgaon - NCR", "Delhi - South - DL 03", "Ambala", "ambala", "Port-Blair", "Chennai - West", "", " - X", "Noida - NCR"];
  const now = () => new Date("2026-11-14T10:00:00Z");
  rto.saveLocationsFile(a, texts, { now });
  theirs.mergeLocations(b, texts, { now });
  assert.equal(fs.readFileSync(a, "utf8"), fs.readFileSync(b, "utf8"));
  // and the backend reads what this wrote
  assert.deepEqual(theirs.readLocations(a).locations.map((l) => l.text), JSON.parse(fs.readFileSync(a, "utf8")).locations.map((l) => l.text));
});

test("the default file is the backend's json folder when it is next to this one", () => {
  const file = rto.defaultFile();
  assert.match(file, /nationalRtoLocations\.json$/);
  const backend = path.join(__dirname, "..", "..", "RayalBrokers-backend", "json");
  if (fs.existsSync(backend)) assert.equal(file, path.join(backend, "nationalRtoLocations.json"));
  else assert.equal(file, path.join(__dirname, "..", "data", "nationalRtoLocations.json"));
});

test("end to end on the fake page: the list is read (nothing picked) and added to the file; the log says what happened", async () => {
  const page = fakeNationalPage();
  const file = tmpFile();
  const lines = [];
  const out = await rto.collectNationalRto(page.driver, page.ctx, { file, log: (l) => lines.push(l), read: { openWaitMs: 50, searchWaitMs: 20 } });
  assert.deepEqual({ found: out.found, added: out.added, alreadyThere: out.alreadyThere, total: out.total }, { found: 6, added: 6, alreadyThere: 0, total: 6 });
  assert.equal(page.events.some((e) => e.startsWith("pick:")), false, "no RTO was picked");
  assert.ok(lines.some((l) => /The RTO list has 6 locations\./.test(l)));
  assert.ok(lines.some((l) => /6 new locations added to .*locations\.json, 0 already there \(6 in all\)/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /Locations with no branch .*AMBALA, JAGADHARI/.test(l)), lines.join("\n"));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).locations.length, 6);
});

test("an RTO box that lists nothing is one plain sentence and the file is not touched", async () => {
  const page = fakeNationalPage({ rtoList: [] });
  const file = tmpFile();
  await assert.rejects(rto.collectNationalRto(page.driver, page.ctx, { file, log: () => {}, read: { openWaitMs: 30, searchWaitMs: 10, tokens: ["A"] } }), (e) => {
    assert.match(e.message, /^National's RTO location box listed no locations\.$/);
    return true;
  });
  assert.equal(fs.existsSync(file), false);
});

test("script arguments (RTO locations)", () => {
  const { parseArgs } = require("../scripts/nationalCollectRtoLocations");
  const id = "0123456789abcdef01234567";
  assert.deepEqual(parseArgs(["--policy", id]), { policy: id, show: false, notFound: false, file: "" });
  assert.deepEqual(parseArgs(["--policy", id, "--show", "--not-found", "--file", "/tmp/x.json"]), { policy: id, show: true, notFound: true, file: "/tmp/x.json" });
  assert.match(parseArgs(["--policy", id, "--file"]).error, /--file needs a path/);
  assert.match(parseArgs([]).error, /which policy/);
  assert.match(parseArgs(["--policy", "abc"]).error, /not a policy id/);
  assert.match(parseArgs(["--policy", id, "honda"]).error, /takes no makes/);
  assert.match(parseArgs(["--nope"]).error, /Unknown option/);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("nothing from the RTO collector goes into a database: no collection is named, no write call exists", () => {
  const src = read("lib", "nationalRtoCollect.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/collection\(|insertMany|insertOne|updateOne|deleteOne|deleteMany|RTOCityLocation|pincodeLocality/i.test(src), false);
  const script = read("scripts", "nationalCollectRtoLocations.js").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/insertMany|insertOne|updateOne|deleteOne|deleteMany|RTOCityLocation/i.test(script), false);
});

test("National's flow types the operator's own National location when the policy has one, and the collector uses it too", () => {
  for (const src of [read("fullPolicycompany", "national.js"), read("multiCompany", "tpCompany", "nationalTP", "nationalTPForm.js")]) {
    const own = src.indexOf("if (data.nationalRto && String(data.nationalRto).trim()) {");
    const type = src.indexOf('await selectAutocompleteOption(driver, rtoInput, rtoText, "RTO location");');
    const fallback = src.indexOf('rtoText = "Chennai - North West";');
    assert.ok(fallback > 0 && own > fallback && type > own, "the own location is applied after the City - Region text is made and before it is typed");
  }
  assert.match(read("server.js"), /nationalRto: data\?\.nationalRto \|\| ""/);
  const nat = require("../lib/nationalModelCollect");
  assert.equal(nat.rtoTextOf({ nationalRto: " DELHI - SOUTH - DL 03 ", RTOCity: "Chennai", RTORegion: "West" }), "DELHI - SOUTH - DL 03");
  assert.equal(nat.rtoTextOf({ nationalRto: "", RTOCity: "Chennai", RTORegion: "West" }), "Chennai - West");
});
