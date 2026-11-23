/**
 * Tamil Nadu districts and their PIN codes, read from pincodeapi.in - run it BY HAND whenever the list should be refreshed.
 *
 *   node scripts/collectTnPincodes.js                 writes Data/tamil_nadu_district_pincodes.json
 *   node scripts/collectTnPincodes.js --out <file>    somewhere else
 *
 * 1. the state page -> every district's name and its OWN link (a district whose web address is spelt differently
 *    from its name is still found);
 * 2. each district page -> the six-digit PIN codes of its "PIN codes in <district>" list (and any next pages);
 * 3. per district: no repeats, smallest first, kept as text ("609001"); a PIN listed under two districts stays in both;
 * 4. checks: every district of the state page is in the file; the PIN count each page states ("has 51 unique PIN codes")
 *    and the state page's count ("31 PIN codes") must equal what was read. A district that failed or does not match is
 *    named at the end and the script ends with code 1. Nothing is guessed: a failed district is written with
 *    "error" and no PIN codes.
 *
 * The file is what scripts/kshemaCollectPincodes.js reads. No database, no browser.
 */
const fs = require("fs");
const path = require("path");

const BASE = "https://pincodeapi.in";
const STATE_PATH = "/state/tamil-nadu/";
const DEFAULT_OUT = path.join(__dirname, "..", "Data", "tamil_nadu_district_pincodes.json");
const PAUSE_MS = 400; // between pages: one page at a time, the site is not hammered
const TRIES = 3;
const TIMEOUT_MS = 30000;
const MAX_PAGES = 20; // per district, a guard against a "next" link that never ends

const decode = (s) =>
  String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The state page -> [{ district, url, statedCount }] in the page's order, each district once. */
function parseStatePage(html, statePath = STATE_PATH) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]*\/district\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (!href.startsWith(`${statePath}district/`)) continue;
    const url = new URL(href, BASE).href;
    if (seen.has(url)) continue;
    const inner = m[2];
    const nameHtml = (/<span[^>]*>([\s\S]*?)<\/span>/i.exec(inner) || [])[1];
    const district = decode(nameHtml != null ? nameHtml : inner);
    if (!district) continue;
    const counted = /(\d[\d,]*)\s*PIN codes?/i.exec(decode(inner));
    seen.add(url);
    out.push({ district, url, statedCount: counted ? Number(counted[1].replace(/,/g, "")) : null });
  }
  return out;
}

/** A district page -> { pincodes (as listed), statedCount, nextUrl }. Only the "PIN codes in ..." list is read. */
function parseDistrictPage(html, pageUrl) {
  const head = html.search(/<h2[^>]*>\s*PIN codes in /i);
  let pincodes = [];
  if (head >= 0) {
    const rest = html.slice(head);
    const end = rest.search(/<\/section>/i);
    const block = end >= 0 ? rest.slice(0, end) : rest;
    const re = /<a\b[^>]*class="[^"]*\bchip\b[^"]*"[^>]*>\s*([0-9]{6})\s*<\/a>/gi;
    let m;
    while ((m = re.exec(block))) pincodes.push(m[1]);
  }
  const stated = /has\s+(\d[\d,]*)\s+unique PIN codes/i.exec(decode(html));
  const next = /<a\b[^>]*rel="next"[^>]*href="([^"]+)"|<a\b[^>]*href="([^"]+)"[^>]*rel="next"/i.exec(html);
  const nextHref = next ? next[1] || next[2] : null;
  return {
    pincodes,
    foundList: head >= 0,
    statedCount: stated ? Number(stated[1].replace(/,/g, "")) : null,
    nextUrl: nextHref ? new URL(nextHref, pageUrl).href : null,
  };
}

/** No repeats, smallest first, text. */
const tidyPins = (pins) => Array.from(new Set(pins.map(String).filter((p) => /^[0-9]{6}$/.test(p)))).sort();

async function fetchPage(url, { fetchImpl = fetch, tries = TRIES, sleep } = {}) {
  let lastError;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: { "User-Agent": "Mozilla/5.0 (pincode list refresh)", Accept: "text/html" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
      return await res.text();
    } catch (error) {
      lastError = error;
      if (i < tries) await sleep(1500 * i);
    }
  }
  throw new Error(`${url}: ${lastError && lastError.message ? lastError.message : lastError}`);
}

/** The whole collection. Returns { rows, problems, districts }. */
async function collect({ fetchImpl = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = PAUSE_MS } = {}) {
  const stateUrl = new URL(STATE_PATH, BASE).href;
  const stateHtml = await fetchPage(stateUrl, { fetchImpl, sleep });
  const districts = parseStatePage(stateHtml);
  if (!districts.length) throw new Error(`No district links were found on ${stateUrl} (the page layout may have changed).`);
  log(`${districts.length} districts on the state page.`);

  const rows = [];
  const problems = [];
  for (const d of districts) {
    await sleep(pauseMs);
    const pins = [];
    let stated = null;
    let url = d.url;
    let pages = 0;
    try {
      const visited = new Set();
      while (url && !visited.has(url) && pages < MAX_PAGES) {
        visited.add(url);
        pages++;
        const page = parseDistrictPage(await fetchPage(url, { fetchImpl, sleep }), url);
        if (!page.foundList) throw new Error(`no "PIN codes in ${d.district}" list on ${url}`);
        pins.push(...page.pincodes);
        if (stated == null) stated = page.statedCount;
        url = page.nextUrl;
        if (url) await sleep(pauseMs);
      }
    } catch (error) {
      problems.push(`${d.district}: page failed - ${error.message}`);
      rows.push({ district: d.district, pincodes: [], error: error.message });
      log(`  ✗ ${d.district}: ${error.message}`);
      continue;
    }
    const pincodes = tidyPins(pins);
    const checks = [];
    if (stated != null && stated !== pincodes.length) checks.push(`its page says ${stated} unique PIN codes, ${pincodes.length} were read`);
    if (d.statedCount != null && d.statedCount !== pincodes.length) checks.push(`the state page says ${d.statedCount}, ${pincodes.length} were read`);
    if (!pincodes.length) checks.push("no PIN codes were read");
    checks.forEach((c) => problems.push(`${d.district}: ${c}`));
    rows.push({ district: d.district, pincodes });
    log(`  ${checks.length ? "⚠" : "✓"} ${d.district}: ${pincodes.length} PIN codes${stated != null ? ` (page says ${stated})` : ""}${checks.length ? ` - ${checks.join("; ")}` : ""}`);
  }

  // every district of the state page must be in the result
  const inResult = new Set(rows.map((r) => r.district));
  districts.filter((d) => !inResult.has(d.district)).forEach((d) => problems.push(`${d.district}: missing from the result`));
  return { rows, problems, districts };
}

async function main(argv = process.argv.slice(2)) {
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = path.resolve(argv[++i] || "");
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/collectTnPincodes.js [--out <file>]");
      return 0;
    } else {
      console.error(`Unknown option ${argv[i]}`);
      return 2;
    }
  }
  const { rows, problems } = await collect();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`);
  const total = rows.reduce((n, r) => n + r.pincodes.length, 0);
  const unique = new Set(rows.flatMap((r) => r.pincodes)).size;
  console.log(`\nSaved ${out}`);
  console.log(`${rows.length} districts, ${total} district-PIN pairs, ${unique} different PIN codes.`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  - ${p}`));
    return 1;
  }
  console.log("No failed pages, no count mismatches.");
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`Stopped: ${error && error.message ? error.message : error}`);
      process.exit(1);
    }
  );
}

module.exports = { parseStatePage, parseDistrictPage, tidyPins, collect, DEFAULT_OUT };
