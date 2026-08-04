/**
 * Form-field helpers for the KSHEMA quote form.
 *
 * The portal is Angular Material, so almost nothing on it is a plain HTML
 * control. A dropdown is a `<mat-select>`, and three things about it break the
 * obvious approach:
 *
 *  1. It is NOT a `<select>`. sendKeys does nothing; the value only changes by
 *     opening the panel and clicking an option.
 *  2. The options are not inside the mat-select. Material renders the panel
 *     into a CDK overlay appended to the END OF <body>, so they have to be
 *     looked for globally after the trigger is clicked.
 *  3. The option ids (`mat-option-2`, `mat-option-3`) are numbered across the
 *     whole app in render order — they shift as soon as another dropdown is
 *     added. Options are matched on their TEXT, never their id.
 *
 * Every helper reports a plain-English reason on failure rather than throwing a
 * Selenium message, because those reasons end up in the policy's error log.
 */
const { By, Key } = require("selenium-webdriver");
const { log, debug, warn } = require("./kshemaLog");

/** The open panel itself — present but empty means "no choices", which is a
 *  different problem from "the dropdown never opened". */
const PANEL_SELECTOR =
  ".cdk-overlay-container div[role='listbox'], .cdk-overlay-container .mat-mdc-select-panel";

/**
 * The search box some panels put above their list.
 *
 *   <input aria-label="Search" placeholder="Search" matinput ...>
 *
 * On these dropdowns the list is EMPTY until something is typed — the Make list
 * has hundreds of manufacturers and the portal will not render them all. So the
 * search term has to go in before the options are worth reading.
 */
const PANEL_SEARCH_SELECTORS = [
  '.cdk-overlay-container input[aria-label="Search"]',
  '.cdk-overlay-container input[placeholder="Search"]',
  '.cdk-overlay-container .mat-mdc-select-panel input[matinput]',
];

/** Where Material puts an open select's options. */
const OPTION_PANEL_SELECTORS = [
  ".cdk-overlay-container div[role='listbox'] mat-option",
  ".cdk-overlay-container mat-option",
  "div.mat-mdc-select-panel mat-option",
  "mat-option",
];

/** The text of a mat-select's current value. */
const SELECT_VALUE_SELECTORS = [
  ".mat-mdc-select-min-line",
  ".mat-mdc-select-value-text",
  ".mat-mdc-select-value",
];

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * How long to keep looking for a field before calling it missing.
 *
 * This form reveals itself in stages — a product type brings out the Insured
 * Declared Value, "is it new?" swaps a whole block of fields — and each stage
 * is an Angular re-render plus, often, a fetch. Ten seconds is long enough that
 * a field which is genuinely coming will have arrived, and short enough that a
 * field which is genuinely absent does not hold the job up.
 */
const FIELD_WAIT_MS = 10000;

/**
 * Strip an option down to the words that actually identify a place.
 *
 * The locality list is India Post's, so every entry carries a branch marker —
 * "ARANTANGI S.O", "ALIYANILAI B.O", "MUSLIM STREET B.O". A policy only ever
 * stores "ARANTANGI", so those suffixes have to come off before anything is
 * compared, along with the punctuation that varies between "S.O" and "SO".
 */
const LOCATION_NOISE = new Set([
  "bo", "so", "ho", "po",           // branch / sub / head / post office
  "b", "s", "h", "o",               // what "B.O" leaves behind once split
  "office", "post", "branch", "sub", "head",
]);

/**
 * Noise words are per-LIST, never global.
 *
 * Stripping the post-office markers is right for localities and wrong for
 * everything else: a variant list contains "S.EDITION OBD2B AE DLX", and the
 * location rules would throw away its leading "S" as if it were part of "S.O".
 * So a caller opts into a noise set; by default nothing is discarded.
 */
function textTokens(text, noise = null) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !(noise && noise.has(t.toLowerCase())));
}

/**
 * How well does `optionText` answer `wantedText`? 0 = not at all, 100 = exact.
 *
 * Word-based rather than a straight string compare, because the two sides are
 * never written the same way: the policy has "ARANTANGI" and the portal has
 * "ARANTANGI S.O"; the policy has "MUSLIM STREET, ARANTANGI" and the portal has
 * "MUSLIM STREET B.O".
 *
 * Scored from BOTH directions on purpose. Only counting how much of the wanted
 * text appears in the option would rank "ARANTANGI FORT S.O" as highly as
 * "ARANTANGI S.O" for a policy that just says "ARANTANGI" — the extra word in
 * the option has to cost something, or the automation quietly picks the wrong
 * post office.
 *
 * Exported so it can be reasoned about and tested on its own.
 */
function scoreTextMatch(optionText, wantedText, noise = null) {
  const want = textTokens(wantedText, noise);
  const opt = textTokens(optionText, noise);
  if (!want.length || !opt.length) return 0;

  const wantJoined = want.join(" ");
  const optJoined = opt.join(" ");
  if (wantJoined === optJoined) return 100;

  let matched = 0;
  const unusedOpt = [...opt];
  for (const w of want) {
    const exactAt = unusedOpt.indexOf(w);
    if (exactAt !== -1) {
      matched += 1;
      unusedOpt.splice(exactAt, 1);
      continue;
    }
    // A shortened or slightly different spelling still counts, but for less.
    const partialAt = unusedOpt.findIndex(
      (o) => (o.length >= 4 && w.startsWith(o)) || (w.length >= 4 && o.startsWith(w))
    );
    if (partialAt !== -1) {
      matched += 0.7;
      unusedOpt.splice(partialAt, 1);
    }
  }

  if (!matched) return 0;

  // Half for "the option is explained by the policy" (penalises an option with
  // extra words), half for "the policy is covered by the option".
  const optionCoverage = matched / opt.length;
  const wantedCoverage = matched / want.length;
  return Math.round(optionCoverage * 50 + wantedCoverage * 50);
}

/**
 * Pick the closest option, or null when nothing is close enough.
 *
 * @param {string[]} optionTexts
 * @param {string} wantedText
 * @param {number} minScore - below this the guess is not worth making; a wrong
 *   locality on a policy is worse than an honest failure the operator can fix.
 * @returns {{index: number, text: string, score: number}|null}
 */
function pickBestMatch(optionTexts, wantedText, minScore = 45, noise = null) {
  let best = null;
  optionTexts.forEach((text, index) => {
    const score = scoreTextMatch(text, wantedText, noise);
    if (score > 0 && (!best || score > best.score)) best = { index, text, score };
  });
  return best && best.score >= minScore ? best : null;
}

/** Click, falling back to a JS click when Material's ripple eats the event. */
async function clickElement(driver, element, label) {
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", element);
  try {
    await element.click();
  } catch (e) {
    warn(`   Normal click on ${label} was intercepted, using a JS click`);
    await driver.executeScript("arguments[0].click();", element);
  }
}

/** CSS cannot match on text, so a selector starting with // is run as XPath. */
const asLocator = (selector) =>
  selector.trim().startsWith("//") || selector.trim().startsWith("(")
    ? By.xpath(selector)
    : By.css(selector);

/** One pass over the selectors, no waiting. */
async function findVisibleOnce(driver, selectors, root = null) {
  for (const selector of selectors) {
    let elements = [];
    try {
      const locator = asLocator(selector);
      elements = root
        ? await root.findElements(locator)
        : await driver.findElements(locator);
    } catch (e) {
      continue;
    }
    for (const el of elements) {
      try {
        if (await el.isDisplayed()) return { element: el, selector };
      } catch (e) { }
    }
  }
  return { element: null, selector: null };
}

/**
 * First visible element matching any selector — WAITING for it to appear.
 *
 * The wait is the whole point. This form reveals itself in stages: choosing a
 * product type brings out the Insured Declared Value, answering "new vehicle"
 * rearranges what is asked, and the Make/Model/Variant selects are built from
 * lists the portal fetches. A single look reports "not on the page" for a field
 * that renders 300ms later, which is exactly how Make, Model, Variant and
 * Invoice Date all came back missing on a form that plainly had them.
 *
 * Accepts XPath as well as CSS so a control with no `data-iid` can still be
 * anchored to something stable — its visible placeholder text.
 */
async function findVisible(driver, selectors, root = null, timeoutMs = FIELD_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let found = await findVisibleOnce(driver, selectors, root);
  while (!found.element && Date.now() < deadline) {
    await driver.sleep(300);
    found = await findVisibleOnce(driver, selectors, root);
  }
  return found;
}

/**
 * Log every dropdown and input the page is actually showing.
 *
 * Called when a field cannot be found, so the log answers "then what IS there?"
 * instead of leaving the next step to guesswork. A selector written against a
 * placeholder the portal has since reworded fails silently otherwise — this
 * turns that into a visible mismatch.
 */
async function dumpAvailableControls(driver, label) {
  try {
    warn(`   "${label}" not found — here is what the page is showing:`);

    const selects = await driver.findElements(By.css("mat-select"));
    const shown = [];
    for (const sel of selects) {
      try {
        if (!(await sel.isDisplayed())) continue;
        const iid = (await sel.getAttribute("data-iid")) || "-";
        const text = ((await sel.getText()) || "").replace(/\s+/g, " ").trim();
        shown.push(`data-iid=${iid} text="${text}"`);
      } catch (e) { }
    }
    debug(`      ${shown.length} dropdown(s): ${shown.join(" | ") || "none"}`);

    const inputs = await driver.findElements(By.css("input"));
    const boxes = [];
    for (const input of inputs) {
      try {
        if (!(await input.isDisplayed())) continue;
        const iid = (await input.getAttribute("data-iid")) || "-";
        const ph = (await input.getAttribute("placeholder")) || "-";
        boxes.push(`data-iid=${iid} placeholder="${ph}"`);
      } catch (e) { }
    }
    debug(`      ${boxes.length} input(s): ${boxes.join(" | ") || "none"}`);
  } catch (e) {
    warn(`   Could not list the page's controls: ${e.message}`);
  }
}

/** What a mat-select currently displays, or "" when it is empty. */
async function readMatSelectValue(driver, selectElement) {
  for (const selector of SELECT_VALUE_SELECTORS) {
    try {
      const els = await selectElement.findElements(By.css(selector));
      for (const el of els) {
        const text = (await el.getText()).trim();
        if (text) return text;
      }
    } catch (e) { }
  }
  return "";
}

/**
 * Close an open option panel.
 *
 * Matters on the failure path: Material's panel comes with a full-screen
 * backdrop, so a panel left open makes every later field unclickable — one
 * bad dropdown would cascade into "nothing on this form works".
 */
async function closeOverlay(driver) {
  try {
    await driver.actions().sendKeys(Key.ESCAPE).perform();
  } catch (e) {
    try {
      await driver.executeScript(
        "document.querySelector('.cdk-overlay-backdrop')?.click();"
      );
    } catch (e2) { }
  }
}

/**
 * Type into an open panel's search box, if it has one.
 *
 * @returns {Promise<boolean>} whether a search box was found and used
 */
async function searchInPanel(driver, term) {
  const box = await findVisible(driver, PANEL_SEARCH_SELECTORS, null, 4000);
  if (!box.element) return false;
  try {
    await box.element.clear();
    // Some search boxes only re-filter on a real keystroke, so the text is
    // typed rather than set.
    await box.element.sendKeys(String(term || ""));
    // The list is filtered client-side or fetched — either way it needs a beat.
    await driver.sleep(800);
    return true;
  } catch (e) {
    warn(`   Could not type into the dropdown's search box: ${e.message}`);
    return false;
  }
}

/**
 * Watch for an open panel and the options inside it.
 *
 * Returns as soon as options appear, so the caller can wait a long time for a
 * slow list without paying that wait on every dropdown.
 */
async function collectOptions(driver, timeoutMs) {
  let options = [];
  let panelOpened = false;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!panelOpened) {
      try {
        const panels = await driver.findElements(By.css(PANEL_SELECTOR));
        for (const panel of panels) {
          if (await panel.isDisplayed()) {
            panelOpened = true;
            break;
          }
        }
      } catch (e) { }
    }
    for (const selector of OPTION_PANEL_SELECTORS) {
      try {
        const els = await driver.findElements(By.css(selector));
        if (els.length) {
          options = els;
          break;
        }
      } catch (e) { }
    }
    if (options.length) break;
    await driver.sleep(200);
  }

  return { options, panelOpened };
}

/**
 * Set an Angular Material dropdown to a given option.
 *
 * @param {string[]} selectSelectors - how to find the <mat-select>, most
 *   specific first. Prefer the portal's own `data-iid` attribute.
 * @param {string|string[]} optionText - what to choose. With `fuzzy` off this
 *   must be the option's text. With it on this is what we are looking FOR, and
 *   the closest option wins; pass an ARRAY to try several candidates in
 *   priority order — the first one that finds a match is used.
 * @param {string} label - the field's name, for logs and error messages
 * @param {Object} [opts]
 * @param {boolean} [opts.fuzzy] - match on words instead of the whole string.
 *   For lists the portal writes differently from the way a policy stores it —
 *   the locality list is India Post's ("ARANTANGI S.O") while the policy just
 *   says "ARANTANGI".
 * @param {number} [opts.minScore] - how close a fuzzy match has to be
 * @param {Set<string>} [opts.noise] - words to ignore when comparing. Pass
 *   LOCATION_NOISE for a list of post offices; leave it out for anything else.
 * @param {string} [opts.emptyReason] - what it MEANS when the list opens with
 *   nothing in it. Worth setting on any dropdown the portal fills from an
 *   earlier answer.
 * @param {number} [opts.emptyRetryMs] - how long to keep waiting when the list
 *   opens empty before giving up. A list the portal fetches (localities for a
 *   pin code) is regularly not there on the first look.
 * @param {boolean} [opts.searchable] - the panel carries a search box and its
 *   list only fills in once something is typed there.
 * @param {string} [opts.searchTerm] - what to TYPE into that search box, when
 *   it differs from what is being matched. The RTO list needs this: the code
 *   is what narrows it reliably, but the code alone does not identify a row —
 *   the portal has AP40-VIJAYAWADA, AP40-CHITTOOR and AP40-KADAPA — so the
 *   code is searched and the code-with-city is matched.
 * @param {Function} [opts.beforeClose] - awaited while the panel is STILL OPEN,
 *   just before it is dismissed on a failure. This is the only moment a
 *   screenshot can show the open dropdown, which for an empty list is the whole
 *   of the evidence.
 * @returns {Promise<{ok, value, reason, matchedScore?}>}
 */
async function selectMatOption(driver, selectSelectors, optionText, label, opts = {}) {
  const {
    fuzzy = false,
    minScore = 45,
    emptyReason = null,
    emptyRetryMs = 5000,
    searchable = false,
    searchTerm = null,
    noise = null,
    beforeClose = null,
  } = opts;

  // Give the caller its one chance to photograph the open panel, then dismiss
  // it. Dismissing matters even on a failure: Material's backdrop covers the
  // whole page, so a panel left open makes every field after this one
  // unclickable.
  const closePanel = async (why) => {
    if (beforeClose) {
      try {
        await beforeClose(why);
      } catch (e) {
        warn(`   Could not capture the open "${label}" dropdown: ${e.message}`);
      }
    }
    await closeOverlay(driver);
  };
  const want = norm(Array.isArray(optionText) ? optionText[0] : optionText);

  const found = await findVisible(driver, selectSelectors);
  if (!found.element) {
    await dumpAvailableControls(driver, label);
    return {
      ok: false,
      value: null,
      reason: `the "${label}" dropdown was not on the page`,
    };
  }

  // Already right? Material re-renders the panel on every open, so skipping a
  // no-op is not just faster — it avoids a needless chance to leave an overlay
  // stuck open over the rest of the form.
  const current = await readMatSelectValue(driver, found.element);
  if (norm(current) === want) {
    log(`   ✓ ${label} already set to "${current}"`);
    return { ok: true, value: current, reason: null };
  }

  try {
    await clickElement(driver, found.element, `the "${label}" dropdown`);
  } catch (e) {
    return {
      ok: false,
      value: current || null,
      reason: `the "${label}" dropdown could not be opened`,
    };
  }

  // The panel animates in, and a list the portal is still fetching arrives
  // later still — poll rather than assuming either is ready.
  let { options, panelOpened } = await collectOptions(driver, FIELD_WAIT_MS);

  // Opened but empty: the portal has not answered yet. Wait it out with the
  // panel still open — Material's list is bound to the data, so options appear
  // in place as soon as they arrive — then close and reopen once in case this
  // portal only fills the list when the panel is opened.
  // A searchable panel is EMPTY until something is typed — that is how it is
  // meant to work, so skip the "waiting for data" retry and go straight to
  // searching.
  if (!options.length && panelOpened && searchable) {
    debug(`   … "${label}" list waits for a search term`);
  } else if (!options.length && panelOpened && emptyRetryMs > 0) {
    debug(`   … "${label}" list is empty, waiting ${emptyRetryMs / 1000}s for the portal`);
    const waited = await collectOptions(driver, emptyRetryMs);
    options = waited.options;

    if (!options.length) {
      debug(`   … reopening "${label}" to try once more`);
      await closeOverlay(driver);
      await driver.sleep(500);
      try {
        await clickElement(driver, found.element, `the "${label}" dropdown`);
      } catch (e) { }
      const reopened = await collectOptions(driver, emptyRetryMs);
      options = reopened.options;
      panelOpened = panelOpened || reopened.panelOpened;
    }
  }

  // A panel that never opened is usually a click that landed mid-re-render.
  // One more try costs a second and rescues a slow page.
  if (!options.length && !panelOpened) {
    debug(`   … "${label}" did not open, clicking it once more`);
    await closeOverlay(driver);
    await driver.sleep(600);
    try {
      await clickElement(driver, found.element, `the "${label}" dropdown`);
    } catch (e) { }
    const retried = await collectOptions(driver, FIELD_WAIT_MS);
    options = retried.options;
    panelOpened = panelOpened || retried.panelOpened;
  }

  if (!options.length && !(searchable && panelOpened)) {
    await closePanel(panelOpened ? "empty" : "did-not-open");
    // These are two different problems and they need two different answers.
    // A panel that opened EMPTY means the portal has nothing to offer — for a
    // list the portal builds from an earlier answer (localities come from the
    // pin code) that points at the earlier answer being wrong, not at the
    // dropdown being broken. Saying "the dropdown would not open" there would
    // send the operator looking in completely the wrong place.
    return {
      ok: false,
      value: current || null,
      reason: panelOpened
        ? emptyReason || `the "${label}" dropdown had no choices to offer`
        : `the "${label}" dropdown did not open its list of choices`,
      panelWasEmpty: panelOpened,
    };
  }

  /** Read the text of whatever options are currently rendered. */
  const readOptionTexts = async (els) => {
    const texts = [];
    for (const option of els) {
      try {
        texts.push((await option.getText()).trim());
      } catch (e) {
        texts.push("");
      }
    }
    return texts;
  };

  let seen = await readOptionTexts(options);

  let target = null;
  let matchedScore = null;
  let matchedCandidate = null;
  let triedCandidates = [];

  if (fuzzy) {
    // Candidates are tried in the order given, and the FIRST that matches wins
    // rather than the best-scoring one overall. The order carries meaning the
    // score cannot see: an address is split into parts on purpose, and the
    // caller decided which part is the likeliest locality.
    const candidates = (Array.isArray(optionText) ? optionText : [optionText])
      .map((c) => String(c || "").trim())
      .filter(Boolean);

    for (const candidate of candidates) {
      // A searchable panel shows only what matches what is typed, so each
      // candidate needs its own search — the list from the previous one says
      // nothing about this one.
      if (searchable) {
        const searched = await searchInPanel(driver, searchTerm || candidate);
        if (searched) {
          const refreshed = await collectOptions(driver, FIELD_WAIT_MS);
          if (refreshed.options.length) {
            options = refreshed.options;
            seen = await readOptionTexts(options);
          } else {
            debug(`   · ${label}: the portal found nothing for "${candidate}"`);
            continue;
          }
        }
      }

      const best = pickBestMatch(seen, candidate, minScore, noise);
      if (best) {
        target = { option: options[best.index], text: best.text };
        matchedScore = best.score;
        matchedCandidate = candidate;
        debug(`   ~ ${label}: "${candidate}" → "${best.text}" (match ${best.score}%)`);
        break;
      }
      debug(`   · ${label}: nothing close to "${candidate}"`);
    }
    triedCandidates = candidates;
  } else {
    if (searchable) {
      const searched = await searchInPanel(driver, searchTerm || optionText);
      if (searched) {
        const refreshed = await collectOptions(driver, FIELD_WAIT_MS);
        if (refreshed.options.length) {
          options = refreshed.options;
          seen = await readOptionTexts(options);
        }
      }
    }
    // Exact text first, then a contains-match. Exact avoids picking "Individual
    // Corporate" when "Individual" was asked for; contains covers an option
    // whose label carries an extra suffix.
    for (const pass of ["exact", "contains"]) {
      for (let i = 0; i < seen.length; i++) {
        const t = norm(seen[i]);
        if ((pass === "exact" && t === want) || (pass === "contains" && t && t.includes(want))) {
          target = { option: options[i], text: seen[i] };
          break;
        }
      }
      if (target) break;
    }
  }

  if (!target) {
    await closePanel("no-match");
    return {
      ok: false,
      value: current || null,
      reason: fuzzy
        ? `none of ${triedCandidates.map((c) => `"${c}"`).join(", ")} was close ` +
          `enough to anything in the "${label}" list ` +
          `(the portal offered: ${seen.filter(Boolean).join(", ") || "nothing"})`
        : `"${optionText}" was not one of the choices for "${label}" ` +
          `(the portal offered: ${seen.filter(Boolean).join(", ") || "nothing"})`,
    };
  }

  try {
    await clickElement(driver, target.option, `the "${target.text}" option`);
  } catch (e) {
    await closePanel("click-failed");
    return {
      ok: false,
      value: current || null,
      reason: `the "${target.text}" choice for "${label}" could not be clicked`,
    };
  }

  // Read the value back. Material's click can land on the ripple layer instead
  // of the option, which looks like it worked and leaves the field unchanged.
  await driver.sleep(400);
  // Re-found for the same reason the text boxes are: choosing an option
  // re-renders this form, and reading a detached mat-select gives "" — which
  // would report a selection that plainly worked as a failure.
  const verifyAgainst =
    (await findVisible(driver, selectSelectors, null, 3000)).element || found.element;
  const after = await readMatSelectValue(driver, verifyAgainst);
  // On a fuzzy pick the field will read back the OPTION's wording, not what was
  // asked for, so it is checked against the option that was actually clicked.
  const expected = fuzzy ? norm(target.text) : want;
  if (norm(after) !== expected && !norm(after).includes(expected)) {
    return {
      ok: false,
      value: after || null,
      reason:
        `"${label}" still shows "${after || "nothing"}" after choosing ` +
        `"${optionText}"`,
    };
  }

  log(`   ✓ ${label} set to "${after}"`);
  return { ok: true, value: after, reason: null, matchedScore, matchedCandidate };
}

/**
 * Type into a Material text input and CONFIRM the value landed.
 *
 * The read-back is not optional. A matinput sits behind a form-field wrapper
 * that swallows keystrokes when the control never took focus, and sendKeys
 * reports success either way — so without it a blank Mobile Number reaches the
 * insurer looking like it was filled in.
 *
 * @param {string[]} selectors - how to find the input, most specific first
 * @param {string|number} value
 * @param {string} label - the field's name, for logs and error messages
 * @param {Object} opts
 * @param {boolean} opts.stripSpaces - some fields refuse spaces outright
 *   (the portal's own hint on First/Last Name is "without space")
 * @param {number} opts.maxLength - trim before typing rather than letting the
 *   portal silently truncate
 * @returns {Promise<{ok: boolean, value: string|null, reason: string|null}>}
 */
async function typeIntoField(driver, selectors, value, label, opts = {}) {
  const { stripSpaces = false, maxLength = null } = opts;

  let text = value === null || value === undefined ? "" : String(value);
  if (stripSpaces) text = text.replace(/\s+/g, "");
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);

  if (!text) {
    return { ok: false, value: null, reason: `no ${label} was available to enter` };
  }

  // Typed up to three times, re-finding the box each go.
  //
  // Answering a dropdown re-renders this form, and Angular does it by REPLACING
  // the input rather than updating it. A reference grabbed a moment earlier
  // then points at a detached node: sendKeys reports success, and reading the
  // value back gives "" — which is exactly how a chassis number came back as
  // "it holds nothing instead of MB2AA22E2ERT89876" when the box on screen was
  // sitting there perfectly typeable. Re-finding is what makes the retry mean
  // anything; retrying against the same stale handle would fail identically.
  let landed = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const found = await findVisible(driver, selectors);
    if (!found.element) {
      if (attempt === 1) await dumpAvailableControls(driver, label);
      return { ok: false, value: null, reason: `the "${label}" box was not on the page` };
    }

    try {
      await clickElement(driver, found.element, `the "${label}" box`);
      await found.element.clear();
      await found.element.sendKeys(text);
      // Let Angular finish whatever the keystrokes set off before reading back.
      await driver.sleep(250);
      landed = await found.element.getAttribute("value");
    } catch (e) {
      // A stale-element error here means the re-render happened mid-type. That
      // is the case the retry exists for, so it is not fatal yet.
      lastError = e.message;
      landed = null;
    }

    if (landed === text) {
      log(`   ✓ ${label}: ${text}`);
      return { ok: true, value: text, reason: null };
    }

    if (attempt < 3) {
      debug(`   … "${label}" did not hold its value, typing it again (${attempt}/2)`);
      await driver.sleep(600);
    }
  }

  return {
    ok: false,
    value: landed || null,
    reason:
      `"${label}" did not keep what was typed after three tries — it holds ` +
      `"${landed || "nothing"}" instead of "${text}"` +
      (lastError ? ` (${lastError.split("\n")[0]})` : ""),
  };
}

/**
 * Choose an option in an Angular Material radio group.
 *
 *   <mat-radio-group data-iid="...">
 *     <mat-radio-button>
 *       <input type="radio" class="mdc-radio__native-control"
 *              id="mat-radio-33-input" name="mat-radio-group-20"
 *              value="Yes" tabindex="-1">
 *
 * The native input is the thing that holds the value, and it is also the thing
 * you cannot click: Material hides it under its own drawn circle and takes it
 * out of the tab order. Selenium refuses to click a hidden element, so the
 * click goes to the <mat-radio-button> wrapper — which is what a person clicks
 * too — and only falls back to a JS click straight at the input.
 *
 * @param {string[]} selectors - how to find the group OR the radio inputs
 *   themselves. Prefer the portal's `data-iid`; `mat-radio-group-20` is a
 *   number Material generates and can renumber on a rebuild.
 * @param {string} wantedValue - the input's `value`, e.g. "Yes"
 * @param {string} label - the question's name, for logs and error messages
 */
async function selectMatRadio(driver, selectors, wantedValue, label) {
  const want = norm(wantedValue);

  // Deliberately NOT findVisible: the native radio is hidden by design, so a
  // visibility check would skip the very element that holds the value. It still
  // waits, though — these groups appear and disappear as the form rearranges.
  let radios = [];
  const deadline = Date.now() + FIELD_WAIT_MS;
  while (!radios.length) {
    for (const selector of selectors) {
      try {
        const found = await driver.findElements(asLocator(selector));
        if (!found.length) continue;
        // The selector may point at the group or straight at the inputs.
        const tag = (await found[0].getTagName()).toLowerCase();
        radios =
          tag === "input"
            ? found
            : await found[0].findElements(By.css('input[type="radio"]'));
        if (radios.length) break;
      } catch (e) { }
    }
    if (radios.length || Date.now() >= deadline) break;
    await driver.sleep(300);
  }

  if (!radios.length) {
    await dumpAvailableControls(driver, label);
    return { ok: false, value: null, reason: `the "${label}" choice was not on the page` };
  }

  const seen = [];
  let target = null;
  for (const radio of radios) {
    let value = "";
    try {
      value = (await radio.getAttribute("value")) || "";
    } catch (e) {
      continue;
    }
    seen.push(value);
    if (norm(value) === want) {
      target = radio;
      break;
    }
  }

  if (!target) {
    return {
      ok: false,
      value: null,
      reason:
        `"${wantedValue}" was not one of the choices for "${label}" ` +
        `(it offered: ${seen.filter(Boolean).join(", ") || "nothing"})`,
    };
  }

  // Already on the right answer — clicking again is harmless for a radio, but
  // skipping avoids the re-render some of these questions trigger.
  try {
    if (await target.isSelected()) {
      log(`   ✓ ${label} already "${wantedValue}"`);
      return { ok: true, value: wantedValue, reason: null };
    }
  } catch (e) { }

  // Click the wrapper Material actually draws, not the input it hides.
  let clicked = false;
  for (const wrapperSelector of ["./ancestor::mat-radio-button[1]", "./ancestor::label[1]"]) {
    try {
      const wrapper = await target.findElement(By.xpath(wrapperSelector));
      await clickElement(driver, wrapper, `the "${wantedValue}" option of "${label}"`);
      clicked = true;
      break;
    } catch (e) { }
  }
  if (!clicked) {
    try {
      await driver.executeScript("arguments[0].click();", target);
      clicked = true;
    } catch (e) {
      return {
        ok: false,
        value: null,
        reason: `the "${wantedValue}" option of "${label}" could not be clicked`,
      };
    }
  }

  // Read it back — a click that lands on the ripple layer instead of the
  // control looks like it worked and leaves the answer unchanged.
  await driver.sleep(300);
  try {
    if (!(await target.isSelected())) {
      return {
        ok: false,
        value: null,
        reason: `"${label}" did not take "${wantedValue}" — it is still unset`,
      };
    }
  } catch (e) { }

  log(`   ✓ ${label}: ${wantedValue}`);
  return { ok: true, value: wantedValue, reason: null };
}

/**
 * Check or uncheck a Material checkbox.
 *
 * @param {string[]} selectors - how to find the checkbox (usually its id)
 * @param {boolean} wantedValue - true to check, false to uncheck
 * @param {string} label - the field's name for logs
 */
async function setMatCheckbox(driver, selectors, wantedValue, label) {
  let target = null;
  const deadline = Date.now() + FIELD_WAIT_MS;
  while (!target) {
    for (const selector of selectors) {
      try {
        const found = await driver.findElements(asLocator(selector));
        if (found.length) {
          target = found[0];
          break;
        }
      } catch (e) { }
    }
    if (target || Date.now() >= deadline) break;
    await driver.sleep(300);
  }

  if (!target) {
    await dumpAvailableControls(driver, label);
    return { ok: false, value: null, reason: `the "${label}" checkbox was not on the page` };
  }

  let isChecked = false;
  try {
    isChecked = await target.isSelected();
  } catch (e) {
    return { ok: false, value: null, reason: `could not read "${label}" state` };
  }

  if (isChecked === wantedValue) {
    log(`   ✓ ${label} already ${wantedValue ? "checked" : "unchecked"}`);
    return { ok: true, value: wantedValue, reason: null };
  }

  // Click the wrapper or directly
  let clicked = false;
  for (const wrapperSelector of ["./ancestor::mat-checkbox[1]", "./ancestor::label[1]"]) {
    try {
      const wrapper = await target.findElement(By.xpath(wrapperSelector));
      await clickElement(driver, wrapper, label);
      clicked = true;
      break;
    } catch (e) { }
  }
  if (!clicked) {
    try {
      await driver.executeScript("arguments[0].click();", target);
    } catch (e) {
      return { ok: false, value: null, reason: `could not click "${label}"` };
    }
  }

  await driver.sleep(300);
  try {
    const after = await target.isSelected();
    if (after === wantedValue) {
      log(`   ✓ ${label} ${wantedValue ? "checked" : "unchecked"}`);
      return { ok: true, value: wantedValue, reason: null };
    }
    return { ok: false, value: null, reason: `"${label}" did not change state` };
  } catch (e) {
    return { ok: false, value: null, reason: `could not confirm state of "${label}"` };
  }
}

/**
 * Toggle a Kshema custom slider switch (like Nil Depreciation).
 * The slider is a div that gets "slider-on" or "slider-off" class.
 *
 * @param {string[]} selectors - how to find the slider div
 * @param {boolean} wantedValue - true to turn on, false to turn off
 * @param {string} label - the field's name for logs
 */
async function setSlider(driver, selectors, wantedValue, label) {
  let target = null;
  const deadline = Date.now() + FIELD_WAIT_MS;
  while (!target) {
    for (const selector of selectors) {
      try {
        const found = await driver.findElements(asLocator(selector));
        if (found.length) {
          target = found[0];
          break;
        }
      } catch (e) { }
    }
    if (target || Date.now() >= deadline) break;
    await driver.sleep(300);
  }

  if (!target) {
    return { ok: false, value: null, reason: `the "${label}" slider was not found on the page` };
  }

  let className = "";
  try {
    className = await target.getAttribute("class");
  } catch (e) {
    return { ok: false, value: null, reason: `could not read "${label}" state` };
  }

  const isOn = className.includes("slider-on") || className.includes("mat-checked");
  
  if (isOn === wantedValue) {
    log(`   ✓ ${label} already ${wantedValue ? "ON" : "OFF"}`);
    return { ok: true, value: wantedValue, reason: null };
  }

  // Click it
  try {
    await clickElement(driver, target, `the ${label} slider`);
  } catch (e) {
    return { ok: false, value: null, reason: `the "${label}" slider could not be clicked: ${e.message}` };
  }

  await driver.sleep(300);
  
  try {
    const newClass = await target.getAttribute("class");
    if ((newClass.includes("slider-on") || newClass.includes("mat-checked")) !== wantedValue) {
      return { ok: false, value: null, reason: `"${label}" did not toggle when clicked` };
    }
  } catch (e) { }

  log(`   ✓ ${label}: ${wantedValue ? "ON" : "OFF"}`);
  return { ok: true, value: wantedValue, reason: null };
}

/**
 * Fill a Material datepicker input by TYPING, not by driving the calendar.
 *
 *   <input matinput class="mat-datepicker-input" data-iid="registration_date"
 *          data-mat-calendar="mat-datepicker-3">
 *
 * The calendar popup is a month grid that needs paging back a year at a time
 * for anything older than the current month — dozens of clicks for a
 * registration date, each one a chance to land on the wrong cell. The input
 * accepts typed text and Material parses it, so that is what is used.
 *
 * The catch is that the format Material parses is set by the app's locale, and
 * nothing in the markup says what it is. Rather than guess once, each candidate
 * format is typed and the value read back — the one the portal keeps is the
 * right one. A date silently dropped is the failure mode worth ruling out here:
 * an empty registration date would sail through as "not provided".
 *
 * @param {string} value - the date as the policy stores it (DD-MM-YYYY)
 */
async function typeIntoDateField(driver, selectors, value, label) {
  const raw = String(value || "").trim();
  if (!raw) return { ok: false, value: null, reason: `no ${label} was available to enter` };

  const found = await findVisible(driver, selectors);
  if (!found.element) {
    await dumpAvailableControls(driver, label);
    return { ok: false, value: null, reason: `the "${label}" box was not on the page` };
  }

  // formData hands over DD-MM-YYYY (server.js formats it that way). Derive the
  // other common Indian orderings from those same parts.
  const m = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);

  // The portal narrows some date boxes with min/max attributes. They are read
  // for the ERROR MESSAGE ONLY, never used to refuse a date up front.
  //
  // Learned the hard way: the Invoice Date carried max="2026-07-31" while its
  // own calendar had 01-08-2026 enabled and every later day disabled. The
  // attribute lags what the picker actually allows, so gating on it rejected a
  // date the portal was perfectly happy with. Let the portal decide — it is the
  // authority — and quote the window only when it turns the date down.
  let min = "";
  let max = "";
  try {
    min = (await found.element.getAttribute("min")) || "";
    max = (await found.element.getAttribute("max")) || "";
  } catch (e) { }
  const pretty = (isoDate) => {
    const p = String(isoDate).split("-");
    return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : isoDate;
  };
  const candidates = m
    ? [`${m[1]}-${m[2]}-${m[3]}`, `${m[1]}/${m[2]}/${m[3]}`, `${m[3]}-${m[2]}-${m[1]}`, raw]
    : [raw];

  let lastSeen = "";
  for (const candidate of [...new Set(candidates)]) {
    try {
      // Re-found each go: answering the field above this one re-renders the
      // form, and Angular replaces the input rather than updating it, leaving
      // any earlier reference pointing at a detached node.
      const box = (await findVisible(driver, selectors)).element || found.element;
      await clickElement(driver, box, `the "${label}" box`);
      await box.clear();
      await box.sendKeys(candidate);
      // Blur so Material parses and reformats what was typed.
      await box.sendKeys(Key.TAB);
      await driver.sleep(300);

      lastSeen = (await box.getAttribute("value")) || "";
      // Material rewrites the text into its own format, so the check is "did
      // anything survive", not "does it read back exactly as typed".
      if (lastSeen.trim()) {
        log(`   ✓ ${label}: ${lastSeen}`);
        return { ok: true, value: lastSeen, reason: null };
      }
    } catch (e) {
      lastSeen = "";
    }
  }

  const window =
    min || max
      ? ` The portal will take a date from ${min ? pretty(min) : "any"} to ` +
        `${max ? pretty(max) : "any"}.`
      : "";
  return {
    ok: false,
    value: null,
    reason:
      `"${label}" would not accept "${raw}" — the box is still empty, so the ` +
      `portal turned that date down.${window} Check it on the policy`,
  };
}

module.exports = {
  selectMatOption,
  selectMatRadio,
  typeIntoDateField,
  scoreTextMatch,
  pickBestMatch,
  LOCATION_NOISE,
  typeIntoField,
  readMatSelectValue,
  findVisible,
  clickElement,
  closeOverlay,
  setMatCheckbox,
  setSlider,
};
