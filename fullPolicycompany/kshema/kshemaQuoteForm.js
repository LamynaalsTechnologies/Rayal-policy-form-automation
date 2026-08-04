/**
 * The KSHEMA Two-Wheeler quote form — customer details section.
 *
 * Every control on this form carries the portal's own `data-iid` attribute
 * (`c_category`, `c_first_name`, `c_last_name`, `c_mobile_number` …). That is a
 * test hook KSHEMA put there deliberately, so it is used as the primary
 * selector everywhere: it survives the styling and class churn that would break
 * anything keyed on `mat-input-4` or the `ng-tns-c*` scoping classes, both of
 * which are renumbered on every build.
 *
 * Fields are declared as data rather than code so adding the next one is a
 * single entry, and so a failure can name the field the operator has to look
 * at.
 */
const {
  selectMatOption,
  selectMatRadio,
  typeIntoField,
  typeIntoDateField,
  LOCATION_NOISE,
} = require("./kshemaFields");
const { log, debug, warn, err } = require("./kshemaLog");

/** Build the `data-iid` selector list for a control. */
const byIid = (iid, tag = "input") => [
  `${tag}[data-iid="${iid}"]`,
  `[data-iid="${iid}"]`,
];

/**
 * Find a mat-select by the placeholder text it shows.
 *
 * For the controls KSHEMA did not give a `data-iid` — Make and Model — every
 * id, name and class on them is Angular-generated and renumbers on a rebuild.
 * The placeholder is the one thing on them a person can read, which makes it
 * the one thing worth keying on.
 */
const bySelectPlaceholder = (placeholder) => {
  // "+ Make" / "* Variant" — the leading marker is the portal's required-ness
  // flag and is the part most likely to be restyled, so the fallbacks drop it.
  const bare = placeholder.replace(/^[+*]\s*/, "").trim();
  return [
    `//mat-select[.//span[normalize-space()='${placeholder}']]`,
    // Same idea, but only inside the element Material uses for a placeholder —
    // a bare contains() would also match a select whose CHOSEN VALUE happens to
    // contain the word, and on this form "Model" and "Variant" values do.
    `//mat-select[.//span[contains(@class,'mat-mdc-select-placeholder')][contains(normalize-space(),'${bare}')]]`,
    // Last resort: the form field's own label.
    `//mat-form-field[.//mat-label[contains(normalize-space(),'${bare}')]]//mat-select`,
  ];
};

/**
 * Find a radio group by the question printed above it.
 *
 * The form now has several Yes/No groups — "Is New Vehicle?", "Is Vehicle
 * Modified?" — and Material names them `mat-radio-group-20`, a number it hands
 * out in render order. Keying on that number picked the wrong group as soon as
 * the form grew another one: the run logged "New vehicle: Yes" while the page
 * plainly still said No, and the Make/Model/Variant fields that only exist for
 * a NEW vehicle were then reported missing — which they were.
 *
 * The question text is what a person uses to tell these apart, so it is what
 * this uses too.
 */
const byRadioQuestion = (question) => [
  `//*[contains(normalize-space(), "${question}")]/following::mat-radio-group[1]`,
  `//mat-radio-group[preceding::*[contains(normalize-space(), "${question}")]][1]`,
];

/**
 * The RTO code as the portal writes it: letters and digits only.
 *
 * The RTO master is inconsistent — "TN-55", "TN 55" and "TN55" all appear —
 * while the portal's list has no separator inside the code at all
 * ("AN01-PORT BLAIR", "AP40-VIJAYAWADA"; that hyphen divides code from city).
 * Its search box matches literally, so a stored "TN-55" comes back as
 * "No results found!".
 */
const rtoCode = (data) =>
  String(data.rtoCityLocation || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();

/**
 * The state, worked out from the RTO code's two-letter prefix.
 *
 * NOT from formData.state — server.js rewrites that into "30" or "26"
 * (server.js:458), numeric codes the Reliance and National portals want. KSHEMA
 * wants a name, and those codes cannot produce one for any state but the two
 * that map is hardcoded for.
 *
 * The RTO prefix is the better source anyway: it is the same field the RTO
 * Location dropdown is chosen from, so the state can never disagree with the
 * RTO sitting next to it.
 */
const RTO_PREFIX_TO_STATE = {
  AN: "ANDAMAN AND NICOBAR ISLANDS", AP: "ANDHRA PRADESH", AR: "ARUNACHAL PRADESH",
  AS: "ASSAM", BR: "BIHAR", CH: "CHANDIGARH", CG: "CHHATTISGARH", DD: "DAMAN AND DIU",
  DL: "DELHI", DN: "DADRA AND NAGAR HAVELI", GA: "GOA", GJ: "GUJARAT", HR: "HARYANA",
  HP: "HIMACHAL PRADESH", JH: "JHARKHAND", JK: "JAMMU AND KASHMIR", KA: "KARNATAKA",
  KL: "KERALA", LA: "LADAKH", LD: "LAKSHADWEEP", MH: "MAHARASHTRA", ML: "MEGHALAYA",
  MN: "MANIPUR", MP: "MADHYA PRADESH", MZ: "MIZORAM", NL: "NAGALAND", OD: "ODISHA",
  OR: "ODISHA", PB: "PUNJAB", PY: "PUDUCHERRY", RJ: "RAJASTHAN", SK: "SIKKIM",
  TN: "TAMIL NADU", TR: "TRIPURA", TS: "TELANGANA", TG: "TELANGANA",
  UK: "UTTARAKHAND", UA: "UTTARAKHAND", UP: "UTTAR PRADESH", WB: "WEST BENGAL",
};

const stateFromPolicy = (data) => {
  const prefix = rtoCode(data).slice(0, 2);
  if (RTO_PREFIX_TO_STATE[prefix]) return RTO_PREFIX_TO_STATE[prefix];
  // Fall back to whatever the policy carries, in case it still holds a name.
  const raw = String(data.state || "").trim();
  if (raw === "30") return "TAMIL NADU";
  if (raw === "26") return "KARNATAKA";
  return raw && !/^\d+$/.test(raw) ? raw.toUpperCase() : "";
};

/**
 * Customer details, in the order the form asks for them.
 *
 * `value` is a function of the job's formData so a field can normalise what it
 * gets (a 10-digit mobile out of whatever the policy stored, for instance).
 */
const CUSTOMER_FIELDS = [
  {
    key: "customerCategory",
    label: "Customer Category",
    type: "select",
    selectors: byIid("c_category", "mat-select"),
    // Only Individual and Corporate exist. Everything this automation files is
    // a personal two-wheeler policy, so Individual is the constant — not
    // something read off the policy.
    value: () => "Individual",
    required: true,
  },
  {
    key: "firstName",
    label: "First Name",
    type: "text",
    selectors: byIid("c_first_name"),
    value: (data) => data.firstName,
    // The portal's own hint on this box is "Enter First name without space".
    stripSpaces: true,
    required: true,
  },
  {
    key: "lastName",
    label: "Last Name",
    type: "text",
    selectors: byIid("c_last_name"),
    value: (data) => data.lastName,
    stripSpaces: true,
    // No asterisk on the portal's placeholder — a customer with one name is
    // allowed through rather than blocked.
    required: false,
  },
  {
    key: "mobileNumber",
    label: "Mobile Number",
    type: "text",
    selectors: byIid("c_mobile_number"),
    // Digits only, last 10. Policies store numbers with +91, spaces and dashes
    // in them, and the portal takes a bare 10-digit number.
    value: (data) => {
      const digits = String(data.mobile || data.mobileNumber || "").replace(/\D/g, "");
      return digits.length > 10 ? digits.slice(-10) : digits;
    },
    maxLength: 10,
    required: true,
  },
  {
    key: "pinCode",
    label: "Pin Code",
    type: "text",
    selectors: byIid("c_pincode"),
    // server.js maps the policy's `pincode` onto formData as `pinCode`
    // (server.js:459) — both spellings are read so this keeps working if that
    // mapping is ever tidied up.
    value: (data) =>
      String(data.pinCode || data.pincode || "").replace(/\D/g, ""),
    maxLength: 6,
    required: true,
    // Typing a pin code makes the portal look up the localities that belong to
    // it, and the dropdown below is built from that answer. Give it a moment to
    // come back rather than opening an empty list.
    settleMs: 2000,
  },
  {
    key: "locality",
    label: "Pin code Locality",
    type: "select",
    selectors: byIid("pincode_locality", "mat-select"),
    // A policy stores the whole area line — "ANDUR, PONBEITHY, KARAIKAL" —
    // while the portal wants ONE post office. Split it up and hand over every
    // part as a candidate, LAST FIRST: an Indian address runs from the most
    // specific to the broadest, and the broader name (the town) is the one the
    // portal's list is far more likely to carry. The whole line goes on the end
    // as a fallback for a single-part address.
    value: (data) => {
      const line = data.areaAndLocality || data.area || data.locality || "";
      const parts = String(line)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .reverse();
      return parts.length > 1 ? [...parts, line] : parts;
    },
    required: true,
    // The portal lists India Post offices — "ARANTANGI S.O", "MUSLIM STREET
    // B.O" — while the policy stores a plain locality name. They will never be
    // written the same way, so this matches on words and takes the closest.
    fuzzy: true,
    // Ignore the branch markers when comparing. Only this list gets that —
    // see the note on LOCATION_NOISE.
    noise: LOCATION_NOISE,
    // This list is built from the pin code above. An empty one means the
    // portal did not recognise that pin code, and pointing at the dropdown
    // would send the operator to the wrong field entirely.
    emptyReason:
      "the portal returned no localities for this pin code — check the pin " +
      "code on the policy, it is not one the portal recognises",
  },
];

/**
 * Fill one section of the form.
 *
 * Carries on after a failure instead of stopping at the first one: a single run
 * then reports EVERY field that needs attention, rather than making the
 * operator fix one, re-run, and discover the next.
 *
 * @param {Array} fields - one of the *_FIELDS lists above
 * @param {string} sectionName - used in the message the operator reads
 * @param {Function} [capture] - `(name, stage) => Promise<{screenshotUrl}>`.
 *   Called for a dropdown failure WHILE THE PANEL IS STILL OPEN — an empty
 *   locality list is only evidence if the open, empty list is in the picture.
 * @returns {Promise<{ok, filled, failures, error, screenshots}>}
 */
async function fillSection(driver, data, fields, sectionName, capture = null) {
  const filled = [];
  const failures = [];
  const screenshots = [];

  for (const field of fields) {
    const value = field.value(data);
    let isEmpty = Array.isArray(value) ? value.length === 0 : !value;
    if (field.type === "checkbox" && value === false) {
      isEmpty = false; // false is a valid value for a checkbox (uncheck)
    }

    if (isEmpty) {
      const isRequired = typeof field.required === "function" ? field.required(data) : field.required;
      if (isRequired) {
        failures.push({
          label: field.label,
          reason: `this policy has no ${field.label.toLowerCase()} to enter`,
        });
      } else {
        log(`   – ${field.label}: nothing to enter, skipping`);
      }
      continue;
    }

    let result;
    if (field.type === "radio") {
      result = await selectMatRadio(driver, field.selectors, value, field.label);
    } else if (field.type === "checkbox") {
      result = await require("./kshemaFields").setMatCheckbox(driver, field.selectors, value, field.label);
    } else if (field.type === "slider") {
      result = await require("./kshemaFields").setSlider(driver, field.selectors, value, field.label);
    } else if (field.type === "date") {
      result = await typeIntoDateField(driver, field.selectors, value, field.label);
    } else if (field.type === "select") {
      result = await selectMatOption(driver, field.selectors, value, field.label, {
        fuzzy: field.fuzzy,
        searchable: field.searchable,
        searchTerm: field.searchValue ? field.searchValue(data) : null,
        noise: field.noise,
        emptyReason: field.emptyReason,
        beforeClose: capture
          ? async (why) => {
            const shot = await capture(
              `kshema_${field.key}_${why}`,
              `${field.key}_${why.replace(/-/g, "_")}`
            );
            if (shot && shot.screenshotUrl) screenshots.push(shot);
          }
          : null,
      });
    } else {
      result = await typeIntoField(driver, field.selectors, value, field.label, {
        stripSpaces: field.stripSpaces,
        maxLength: field.maxLength,
      });
    }

    if (result.ok) {
      filled.push(field.label);
      // Some fields kick off an async lookup that re-renders the ones below
      // them. Wait it out rather than typing into a form that is mid-rebuild.
      if (field.settleMs) {
        // Give the loader a moment to appear, then wait for it to disappear
        await driver.sleep(300);
        await require("../kshemaForm").waitForKshemaLoaderToDisappear(driver, 20000);
        
        // Check if an error toast appeared after the reload (e.g. "Quotation already converted to proposal")
        const { readToast: getToast } = require("./kshemaToast");
        const toast = await getToast(driver);
        if (toast && toast.isError) {
          const errMsg = `Portal rejected the field update: "${toast.text}"`;
          warn(`   ✗ ${field.label}: ${errMsg}`);
          failures.push({ label: field.label, reason: errMsg });
        }
      }
    } else if (field.required) {
      warn(`   ✗ ${field.label}: ${result.reason}`);
      failures.push({ label: field.label, reason: result.reason });
    } else {
      warn(`   – ${field.label}: ${result.reason} (not required, carrying on)`);
    }
  }

  const ok = failures.length === 0;
  log(`${ok ? "✓" : "⚠️ "} ${sectionName}: ${filled.length} field(s) filled` +
    (failures.length ? `, ${failures.length} failed` : ""));

  return {
    ok,
    filled,
    failures,
    screenshots,
    error: ok
      ? null
      : `Could not fill the ${sectionName} on the KSHEMA quote form: ` +
      failures.map((f) => `${f.label} — ${f.reason}`).join("; ") +
      ".",
  };
}

/** Fill the customer details section. */
async function fillCustomerDetails(driver, data, capture = null) {
  log("📝 Filling the customer details...");
  return fillSection(driver, data, CUSTOMER_FIELDS, "customer details", capture);
}

/**
 * Vehicle details, in the order the form asks for them.
 */
const VEHICLE_FIELD_DEFS = [
  {
    key: "productType",
    label: "Product Type",
    type: "select",
    // `data-iid`, like the rest of the form. This was first written against the
    // VALUE text ("Two Wheeler-Bundled") because that was all the markup showed
    // — and it could never work: on a fresh form there IS no value, only the
    // "* Product Type" placeholder, so the anchor matched nothing and the field
    // was reported missing.
    selectors: byIid("product_type", "mat-select"),
    // Bundled — one year own-damage plus five years third-party — is what a new
    // two-wheeler is sold with.
    value: () => "Two Wheeler-Bundled",
    required: true,
    fuzzy: true,
    // The Insured Declared Value box only exists once this is set, which is
    // why IDV follows it immediately in VEHICLE_FIELD_ORDER.
    settleMs: 1500,
  },
  {
    key: "isNewVehicle",
    label: "New vehicle",
    type: "radio",
    // Anchored on the question, NOT on Material's generated group name — see
    // byRadioQuestion. The name approach silently drove the wrong group.
    selectors: byRadioQuestion("Is New Vehicle"),
    // Everything filed through here is a brand-new two-wheeler. The portal
    // defaults this to "No", so it always has to be changed.
    value: () => "Yes",
    required: true,
    // Answering this re-renders the fields below it.
    settleMs: 1500,
  },
  {
    key: "isVehicleModified",
    label: "Is Vehicle Modified?",
    type: "radio",
    selectors: byRadioQuestion("Is Vehicle Modified"),
    // Nothing filed through here is a modified vehicle, and No is the portal's
    // own default — so this normally just reads back and moves on.
    value: () => "No",
    required: false,
  },
  {
    key: "engineNumber",
    label: "Engine Number",
    type: "text",
    selectors: byIid("engine_number"),
    value: (data) => data.engineNumber,
    stripSpaces: true,
    required: true,
  },
  {
    key: "make",
    label: "Make",
    type: "select",
    selectors: bySelectPlaceholder("+ Make"),
    value: (data) => data.vehicleMake,
    required: true,
    // The list holds every manufacturer the portal knows and only renders what
    // is typed into its search box, so it is empty until searched.
    searchable: true,
    // "TVS" in a policy vs "TVS MOTOR COMPANY LTD" on the portal — the two are
    // never written identically.
    fuzzy: true,
    // Choosing a make reloads the model list below it.
    settleMs: 1500,
  },
  {
    key: "model",
    label: "Model",
    type: "select",
    selectors: bySelectPlaceholder("+ Model"),
    value: (data) => data.vehicleModel,
    required: true,
    searchable: true,
    fuzzy: true,
    // This list only exists once a make is chosen, so an empty one points at
    // the make, not at this dropdown.
    emptyReason:
      "the portal listed no models — check the vehicle's make on the policy, " +
      "the model list is built from it",
    settleMs: 1500,
  },
  {
    key: "chassisNumber",
    label: "Chassis Number",
    type: "text",
    selectors: byIid("chassis_number"),
    value: (data) => data.chassisNumber,
    stripSpaces: true,
    required: true,
  },
  {
    key: "variant",
    label: "Variant",
    type: "select",
    selectors: bySelectPlaceholder("+ Variant"),
    value: (data) => data.vehicleVariant,
    required: true,
    // No search box on this one — the whole variant list renders at once, so it
    // is read and matched like the locality dropdown.
    searchable: false,
    // "DLX" on the policy against a list holding DLX, DLX 2A, DLX OBD2A,
    // DLX OBD2B and S.EDITION OBD2B AE DLX. Matching on words with a penalty
    // for the option's extra ones is what keeps a bare "DLX" from landing on
    // "DLX OBD2B".
    fuzzy: true,
    // Deliberately no noise set. The location rules would strip the leading
    // "S" out of "S.EDITION" as if it were a post-office marker.
    emptyReason:
      "the portal listed no variants — check the vehicle's make and model on " +
      "the policy, the variant list is built from them",
    settleMs: 1200,
  },
  {
    key: "registrationDate",
    label: "Registration Date",
    type: "date",
    selectors: byIid("registration_date"),
    // server.js already formats this as DD-MM-YYYY (server.js:496).
    value: (data) => data.registrationDate,
    required: false,
  },
  {
    key: "invoiceDate",
    label: "Invoice Date",
    type: "date",
    selectors: byIid("invoice_date"),
    // The policy records one date. A brand-new two-wheeler is invoiced and
    // registered together, so that date serves for both — and on the new-vehicle
    // form this is the box the portal actually asks for.
    value: (data) => data.registrationDate,
    required: false,
  },
  {
    key: "state",
    label: "State",
    type: "select",
    selectors: bySelectPlaceholder("* State"),
    value: (data) => stateFromPolicy(data),
    required: false,
    // "TAMIL NADU" here against however the portal spells it — "Tamilnadu",
    // "TAMIL NADU", "Tamil Nadu".
    fuzzy: true,
  },
  {
    key: "rtoLocation",
    label: "RTO Location",
    type: "select",
    selectors: bySelectPlaceholder("+ RTO Location"),
    // TYPE the code, MATCH on the code with the city.
    //
    // The two have to differ here. The portal's search box matches text
    // literally, and the city half is spelt differently on the two sides often
    // enough to sink a combined search — the policy has "CENTRAL-REDHILS"
    // where the portal has "CENTRAL REDHILS". So the code, which is written
    // identically everywhere, is what gets typed.
    //
    // But the code alone does not identify a row: the portal lists
    // AP40-VIJAYAWADA, AP40-CHITTOOR and AP40-KADAPA. Picking the first of
    // those would file the policy against the wrong RTO. So once the search
    // has narrowed the list, the city decides which row.
    //
    // ALL punctuation comes out of the code, not just spaces. The master stores
    // writing it solid — "AN01-PORT BLAIR", "AP40-VIJAYAWADA", where the only
    // hyphen is the one separating the code from the city. Typing "TN-55" into
    // the search box returns "No results found!".
    searchValue: (data) => {
      return rtoCode(data) || null;
    },
    value: (data) => {
      const code = rtoCode(data);
      const city = String(data.RTOCity || "").trim();
      if (code && city) return [`${code} ${city}`, code];
      return [code || city].filter(Boolean);
    },
    searchValue: (data) => rtoCode(data),
    required: true,
    searchable: true,
    fuzzy: true,
    emptyReason:
      "the portal found no RTO matching this policy's RTO code and city — " +
      "check the RTO City/Location on the policy",
    settleMs: 1200,
  },
  {
    key: "idv",
    label: "Insured Declared Value",
    type: "text",
    selectors: byIid("insured_declared_value"),
    // Digits only. The policy stores this as a number but it can arrive as
    // "1,25,000" or "125000.00" depending on where it was entered, and the
    // portal takes a plain figure. Rounded rather than truncated — dropping
    // the paise by cutting the string would change the sum insured.
    value: (data) => {
      const n = Number(String(data.idv ?? "").replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : "";
    },
    required: true,
    // The portal recalculates the premium from this, so give it a beat.
    settleMs: 1200,
  },
];

/**
 * The order the vehicle section is filled in. THIS IS THE ORDER, and it is not
 * incidental — the form reveals itself as it is answered:
 *
 *   - "Is New Vehicle? = Yes" is what makes Make, Model and Variant appear at
 *     all. Answered late, they are simply not on the page.
 *   - Model is built from Make, and Variant from Model.
 *   - The Insured Declared Value box only exists once a Product Type is set,
 *     which is why IDV comes straight after it.
 *
 * Kept as a list of keys rather than the order of the definitions above so it
 * can be read and changed in one place.
 */
const VEHICLE_FIELD_ORDER = [
  "isNewVehicle",
  "make",
  "model",
  "variant",
  "engineNumber",
  "chassisNumber",
  "invoiceDate",
  "rtoLocation",
  "productType",
  "idv",
  // Below: fields the portal also shows but which were not part of the agreed
  // sequence. They come last and none of them blocks the job — "Is Vehicle
  // Modified" already defaults to No, and State and Registration Date may not
  // even be rendered once the vehicle is marked new.
  "isVehicleModified",
  // "state",
  // "registrationDate",
];

const VEHICLE_FIELDS = VEHICLE_FIELD_ORDER
  .map((key) => VEHICLE_FIELD_DEFS.find((f) => f.key === key))
  .filter(Boolean);

/** Fill the vehicle details section. Same behaviour as the customer one. */
async function fillVehicleDetails(driver, data, capture = null) {
  log("🏍️  Filling the vehicle details...");
  const result = await fillSection(driver, data, VEHICLE_FIELDS, "vehicle details", capture);

  if (!result.ok) return result;

  // Check if there is an IDV range hint and validate against it
  try {
    const { By } = require("selenium-webdriver");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const hintEls = await driver.findElements(By.xpath('//mat-hint[contains(., "Range")] | //mat-hint[contains(., "Min")]'));
      let checked = false;

      for (const hint of hintEls) {
        if (await hint.isDisplayed()) {
          const hintText = await hint.getText();

          const minMatch = hintText.match(/Min\s*:\s*([\d.]+)/i);
          const maxMatch = hintText.match(/Max\s*:\s*([\d.]+)/i);

          if (minMatch && maxMatch) {
            checked = true;
            const minIdv = parseFloat(minMatch[1]);
            const maxIdv = parseFloat(maxMatch[1]);
            const providedIdv = Number(String(data.idv ?? "").replace(/[^0-9.]/g, ""));

            if (providedIdv > 0 && (providedIdv < minIdv || providedIdv > maxIdv)) {
              log(`❌ IDV ${providedIdv} is out of range. Allowed: ${hintText}`);
              return {
                ok: false,
                screenshots: [],
                filled: result.filled || 0,
                failures: result.failures || [],
                error: `The provided IDV (${providedIdv}) is outside the portal's allowed range (${hintText}). Please update the IDV to be between ${Math.ceil(minIdv)} and ${Math.floor(maxIdv)}.`
              };
            }
          }
        }
      }

      if (checked) break; // found and processed the hint
      await driver.sleep(500);
    }
  } catch (e) {
    debug(`Could not check IDV hint: ${e.message}`);
  }

  return result;
}

const PA_COVER_FIELDS = [
  {
    key: "paCover",
    label: "PA Cover",
    type: "checkbox",
    selectors: [
      '//mat-checkbox[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "personal accident")]//input[@type="checkbox"]',
      '//mat-checkbox[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "pa cover")]//input[@type="checkbox"]',
      '//mat-checkbox[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "cpa cover")]//input[@type="checkbox"]',
      'input[type="checkbox"]'
    ],
    value: (data) => {
      const paCoverVal = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
      const paCompanyVal = String(data.paCoverCompany || "").toLowerCase();
      const isCompanyPA = paCoverVal && (paCompanyVal === "" || paCompanyVal === "company" || paCompanyVal === "kshema" || paCompanyVal === "kshema general insurance");
      console.log(`[PA Logic] paCover: ${data.paCover} (${paCoverVal}), paCoverCompany: ${data.paCoverCompany} (${paCompanyVal}) => isCompanyPA: ${isCompanyPA}`);
      return isCompanyPA;
    },
    required: true,
    settleMs: 1500,
  },
  {
    key: "notPaCoverReason",
    label: "Reason for unselecting PA Cover",
    type: "select",
    selectors: [
      '//mat-select[.//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "reason")]]',
      '//mat-select[.//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "unselecting")]]',
      '//input[@type="checkbox"]/ancestor::mat-checkbox/following::mat-select[1]'
    ],
    value: (data) => {
      const paCoverVal = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
      const paCompanyVal = String(data.paCoverCompany || "").toLowerCase();
      const isCompanyPA = paCoverVal && (paCompanyVal === "" || paCompanyVal === "company" || paCompanyVal === "kshema" || paCompanyVal === "kshema general insurance");
      if (!isCompanyPA) {
        return data.notPaCoverReason || "Already have personal accident policy With 15L Sum Insured";
      }
      return null; // Skip if PA is ON
    },
    required: (data) => {
      const paCoverVal = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
      const paCompanyVal = String(data.paCoverCompany || "").toLowerCase();
      return !(paCoverVal && (paCompanyVal === "" || paCompanyVal === "company" || paCompanyVal === "kshema" || paCompanyVal === "kshema general insurance"));
    },
    fuzzy: true,
    settleMs: 1000,
  },
  {
    key: "paCoverYear",
    label: "PA Cover Year",
    type: "select",
    selectors: [
      '//mat-select[.//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "tenure")]]',
      '//mat-select[.//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "year")]]',
      '//input[@type="checkbox"]/ancestor::mat-checkbox/following::mat-select[1]'
    ],
    value: (data) => {
      const paCoverVal = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
      const paCompanyVal = String(data.paCoverCompany || "").toLowerCase();
      const isCompanyPA = paCoverVal && (paCompanyVal === "" || paCompanyVal === "company" || paCompanyVal === "kshema" || paCompanyVal === "kshema general insurance");
      if (isCompanyPA) {
        return data.paCoverYears ? String(data.paCoverYears) : "1";
      }
      return null;
    },
    required: (data) => {
      const paCoverVal = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
      const paCompanyVal = String(data.paCoverCompany || "").toLowerCase();
      return paCoverVal && (paCompanyVal === "" || paCompanyVal === "company" || paCompanyVal === "kshema" || paCompanyVal === "kshema general insurance");
    },
    fuzzy: true,
    settleMs: 1000,
  },
  {
    key: "tppdRestrict",
    label: "TPPD Restrict",
    type: "radio",
    selectors: [
      '//*[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "tppd")]/following::mat-radio-group[1]',
      '//*[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "property damage")]/following::mat-radio-group[1]',
      '//*[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "third party property")]/following::mat-radio-group[1]',
      '//*[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "6000")]/following::mat-radio-group[1]'
    ],
    value: (data) => {
      const isRestrict = String(data.tppdRestrict).toLowerCase() === "true" || data.tppdRestrict === true;
      return isRestrict ? "Yes" : "No";
    },
    required: false,
    settleMs: 1000,
  }
];

/** Fill the PA cover section. */
async function fillPaCoverDetails(driver, data, capture = null) {
  log("🛡️  Filling PA Cover details...");
  return fillSection(driver, data, PA_COVER_FIELDS, "PA Cover details", capture);
}

const PREMIUM_FIELDS = [
  {
    key: "discountRadio",
    label: "Discount / Loading Choice",
    type: "radio",
    selectors: [
      '//mat-radio-group[.//input[@value="Discount"]]'
    ],
    value: (data) => {
      const disc = parseFloat(data.discount || data.ODDiscount || 0);
      return disc > 0 ? "Discount" : null;
    },
    required: false,
    settleMs: 1000,
  },
  {
    key: "discountAmount",
    label: "Discount Value",
    type: "text",
    selectors: [
      'input[data-iid="broker_load_disc_value"]',
      'input[placeholder*="Value (In %)"]',
      '//mat-radio-group[.//input[@value="Discount"]]/following::input[1]'
    ],
    value: (data) => {
      const disc = parseFloat(data.discount || data.ODDiscount || 0);
      return disc > 0 ? String(disc) : null;
    },
    required: (data) => {
      const disc = parseFloat(data.discount || data.ODDiscount || 0);
      return disc > 0;
    },
    settleMs: 1500,
  }
];

/** Fill the Premium / Discount section. */
async function fillPremiumDetails(driver, data, capture = null) {
  log("💰  Filling Premium & Discount details...");
  return fillSection(driver, data, PREMIUM_FIELDS, "Premium details", capture);
}

/** Click Save and Continue and check for errors. */
async function submitQuoteForm(driver) {
  const { asLocator, clickElement, findVisible } = require("./kshemaFields");
  const { waitForKshemaLoaderToDisappear } = require("../kshemaForm");
  const { readToast } = require("./kshemaToast");

  log("🚀 Submitting Quote Form...");
  const buttonSelectors = [
    '//button[.//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save and continue")]]',
    '//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save and continue")]/ancestor::button[1]',
    '//button[contains(., "Save and Continue")]'
  ];

  // The button might not appear immediately if a recalculation is happening
  const button = await findVisible(driver, buttonSelectors, null, 10000);

  if (!button || !button.element) {
    return { ok: false, error: 'Could not find the "Save and Continue" button on the page.' };
  }

  try {
    await clickElement(driver, button.element, "Save and Continue button");
    await driver.sleep(500);

    // Wait for the loader to clear
    try {
      await waitForKshemaLoaderToDisappear(driver, 30000);
    } catch (e) {
      debug("Loader wait timed out after clicking Save and Continue");
    }

    // Wait up to 15 seconds for the next page to appear, or for an error toast
    const deadline = Date.now() + 15000;
    let pageChanged = false;

    while (Date.now() < deadline) {
      const toast = await readToast(driver);
      if (toast && toast.text) {
        // If it's asking about add-ons, that's just the next page loading normally!
        if (toast.text.toLowerCase().includes("add-ons")) {
          debug(`💬 Ignoring toast: "${toast.text}" (this is expected on the next page)`);
          pageChanged = true;
          break;
        }

        if (toast.isError) {
          return { ok: false, error: `Portal rejected the submission: "${toast.text}"`, toast: toast.text };
        }
      }

      // Check if the add-ons radio group appeared
      try {
        const els = await driver.findElements(asLocator('//mat-radio-group[.//input[@value="Yes" or @value="No"]]'));
        if (els.length > 0 && await els[0].isDisplayed()) {
          pageChanged = true;
          break;
        }
      } catch (e) { }

      await driver.sleep(500);
    }

    if (!pageChanged) {
      return {
        ok: false,
        error: "The page did not change after 15 seconds. There might be a silent validation error on the quote form. Please check the screenshot."
      };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Failed to click Save and Continue: ${e.message}` };
  }
}

const ADDON_FIELDS = [
  {
    key: "wantAddons",
    label: "Do you want add-ons?",
    type: "radio",
    selectors: [
      '//mat-radio-group[ancestor::div[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "add-ons")]]',
      '//mat-radio-group[ancestor::div[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "add on")]]',
      '//mat-radio-group[.//input[@value="Yes"]]'
    ],
    value: (data) => {
      const zd = String(data.zeroDepreciation).toLowerCase() === "true" || data.zeroDepreciation === true;
      return zd ? "Yes" : "No";
    },
    required: true,
    settleMs: 1500,
  },
  {
    key: "nilDepreciation",
    label: "Nil Depreciation",
    type: "slider",
    selectors: [
      '//div[contains(@class, "i-slider") and following-sibling::div[contains(text(), "Nil Depreciation")]]',
      '//div[@data-iid="addon_cover.0.opted"]'
    ],
    value: (data) => {
      const zd = String(data.zeroDepreciation).toLowerCase() === "true" || data.zeroDepreciation === true;
      return zd; // true means turn it ON
    },
    required: (data) => {
      const zd = String(data.zeroDepreciation).toLowerCase() === "true" || data.zeroDepreciation === true;
      return zd; // only require it if zeroDepreciation is requested
    },
  }
];

/** Fill the Add-ons section on the next page. */
async function fillAddonsDetails(driver, data, capture = null) {
  log("📦  Filling Add-ons details...");
  return fillSection(driver, data, ADDON_FIELDS, "Add-ons details", capture);
}

/**
 * Click the download proposal button, wait for the file to download, and upload it to S3.
 */
async function downloadProposal(driver, data, jobBrowser, jobId, capture = null) {
  const { clickElement } = require("./kshemaFields");
  const { By } = require("selenium-webdriver");
  const fs = require("fs");
  const path = require("path");
  const { uploadToS3 } = require("../../s3Uploader");

  log("📄  Downloading proposal PDF...");

  // First, submit the Add-ons page to transition to the Summary tab
  try {
    const { findVisible } = require("./kshemaFields");
    const { readToast: getToast } = require("./kshemaToast");

    const buttonSelectors = [
      '//button[.//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save and finalize")]]',
      '//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save and finalize")]/ancestor::button[1]',
      '//button[contains(., "Save and Finalize")]'
    ];

    const button = await findVisible(driver, buttonSelectors, null, 10000);
    if (button && button.element) {
      await clickElement(driver, button.element, "Save and Finalize (Add-ons)");
      await driver.sleep(1000); // Wait for API and toast

      // Wait for next page or error toast
      const deadline = Date.now() + 15000;
      let movedForward = false;
      while (Date.now() < deadline) {
        const toast = await getToast(driver);
        if (toast && toast.isError) {
          return { ok: false, error: `Portal rejected the submission: "${toast.text}"`, toast: toast.text };
        }

        try {
          const downloadBtn = await driver.findElements(By.xpath('//mat-icon[@data-iid="dnld-download-quote"]'));
          if (downloadBtn.length > 0 && await downloadBtn[0].isDisplayed()) {
            movedForward = true;
            break;
          }
        } catch (e) { }

        await driver.sleep(500);
      }

      if (!movedForward) {
        log("⚠️ Could not confirm transition to Summary tab. Trying to find the download button anyway.");
      }
    } else {
      log("⚠️ No Save and Finalize button found. Trying to find the download button anyway.");
    }
  } catch (e) {
    log(`⚠️ Could not click Save and Continue: ${e.message}`);
  }

  // ── Fill Gender on the Summary/Proposal page ─────────────────────────────
  try {
    const rawGender = String(data.gender || "").trim().toLowerCase();
    let genderOption = null;
    if (rawGender === "male" || rawGender === "m") genderOption = "Male";
    else if (rawGender === "female" || rawGender === "f") genderOption = "Female";
    else if (rawGender === "other") genderOption = "Other";

    if (genderOption) {
      // Find the Gender mat-select — look for placeholder text "* Gender"
      let genderSelect = null;
      const allSelects = await driver.findElements(By.css("mat-select"));
      for (const sel of allSelects) {
        try {
          if (!(await sel.isDisplayed())) continue;
          const txt = (await sel.getText()).trim();
          if (txt.toLowerCase().includes("gender") || txt === "") {
            // Check if the label nearby contains "Gender"
            const label = await driver.executeScript(
              "return arguments[0].closest('mat-form-field')?.querySelector('mat-label,label,span')?.innerText || ''",
              sel
            );
            if (String(label).toLowerCase().includes("gender") || txt.toLowerCase().includes("gender")) {
              genderSelect = sel;
              break;
            }
          }
        } catch (e) { }
      }

      // Wider fallback: find mat-select whose placeholder span says "Gender"
      if (!genderSelect) {
        const genderSpans = await driver.findElements(By.xpath(
          '//mat-select[.//span[contains(normalize-space(text()), "Gender")]]'
        ));
        for (const sel of genderSpans) {
          if (await sel.isDisplayed()) { genderSelect = sel; break; }
        }
      }

      if (genderSelect) {
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", genderSelect);
        await genderSelect.click();
        await driver.sleep(500);

        const options = await driver.findElements(By.xpath(
          `//mat-option//span[normalize-space(text())="${genderOption}"]`
        ));
        if (options.length > 0) {
          await options[0].click();
          log(`   ✓ Gender set to "${genderOption}"`);
          await driver.sleep(400);
        } else {
          log(`   ⚠️ Gender option "${genderOption}" not found`);
          try { await driver.actions().sendKeys("\u001b").perform(); } catch (e) { }
        }
      } else {
        log("   – Gender dropdown not found on this page, skipping");
      }
    } else {
      log(`   – Gender: no recognised value (got "${data.gender}"), skipping`);
    }
  } catch (e) {
    log(`   ⚠️ Could not fill gender: ${e.message}`);
  }

  // ── Fill Date of Birth ─────────────────────────────────────────────────────
  try {
    const rawDob = data.dateOfBirth || data.dob;
    if (rawDob) {
      const { Key } = require("selenium-webdriver");
      // Format as DD/MM/YYYY
      let dobStr = String(rawDob).trim();
      if (dobStr.includes("T")) {
        dobStr = dobStr.split("T")[0]; // handle ISO strings like 1990-01-01T00:00:00.000Z
      }
      if (dobStr.includes("-")) {
        const parts = dobStr.split("-");
        if (parts[0].length === 4) { // YYYY-MM-DD -> DD/MM/YYYY
          dobStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
        } else {
          dobStr = dobStr.replace(/-/g, "/");
        }
      }
      const dobInput = await driver.findElements(By.xpath('//input[@data-iid="c_date_of_birth" or contains(translate(@placeholder, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "date of birth")]'));
      if (dobInput.length > 0 && await dobInput[0].isDisplayed()) {
        const field = dobInput[0];
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", field);
        await field.sendKeys(Key.CONTROL, "a");
        await field.sendKeys(Key.BACK_SPACE);
        await field.sendKeys(dobStr);
        await field.sendKeys(Key.TAB); // To close datepicker
        log(`   ✓ Date of Birth set to "${dobStr}"`);
      } else {
        log("   – Date of Birth field not found, skipping");
      }
    } else {
      log(`   – Date of Birth: no recognised value in data, skipping`);
    }
  } catch (e) {
    log(`   ⚠️ Could not fill Date of Birth: ${e.message}`);
  }

  // ── Fill Email ─────────────────────────────────────────────────────────────
  try {
    const rawEmail = data.email || data.emailId;
    if (rawEmail) {
      const { Key } = require("selenium-webdriver");
      const emailInput = await driver.findElements(By.xpath('//input[@data-iid="c_email" or @data-iid="c_email_id" or contains(translate(@placeholder, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "email")]'));
      if (emailInput.length > 0 && await emailInput[0].isDisplayed()) {
        const field = emailInput[0];
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", field);
        await field.sendKeys(Key.CONTROL, "a");
        await field.sendKeys(Key.BACK_SPACE);
        await field.sendKeys(String(rawEmail).trim());
        log(`   ✓ Email set to "${rawEmail}"`);
      } else {
        log("   – Email field not found, skipping");
      }
    } else {
      log(`   – Email: no recognised value in data, skipping`);
    }
  } catch (e) {
    log(`   ⚠️ Could not fill Email: ${e.message}`);
  }

  // ── Fill Address ───────────────────────────────────────────────────────────
  try {
    const addressParts = [
      data.flatDoorNo,
      data.floorNo,
      data.buildingName,
      data.blockName || data.blockNameNo,
      data.roadStreetLane,
      data.areaAndLocality || data.locality || data.area
    ].filter(p => p && String(p).trim() !== "");

    if (addressParts.length > 0) {
      const { Key } = require("selenium-webdriver");
      let fullAddress = addressParts.join(", ");
      // Portal often limits address to 100 or 50 chars, let's limit to 100 just in case
      if (fullAddress.length > 100) {
        fullAddress = fullAddress.substring(0, 100).replace(/,\s*$/, "");
      }
      const addressInput = await driver.findElements(By.xpath('//input[@data-iid="c_address_one" or contains(translate(@placeholder, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "address")]'));
      if (addressInput.length > 0 && await addressInput[0].isDisplayed()) {
        const field = addressInput[0];
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", field);
        await field.sendKeys(Key.CONTROL, "a");
        await field.sendKeys(Key.BACK_SPACE);
        await field.sendKeys(fullAddress);
        log(`   ✓ Address set to "${fullAddress}"`);
      } else {
        log("   – Address field not found, skipping");
      }
    } else {
      log(`   – Address: no recognised parts in data, skipping`);
    }
  } catch (e) {
    log(`   ⚠️ Could not fill Address: ${e.message}`);
  }


  try {
    const downloadBtn = await driver.findElement(By.xpath('//mat-icon[@data-iid="dnld-download-quote"]'));
    await clickElement(driver, downloadBtn, "download proposal button");
  } catch (e) {
    return { ok: false, error: `Could not find or click the download proposal button: ${e.message}` };
  }

  // Poll the download directory for the PDF
  const downloadDir = jobBrowser?.profileInfo?.downloadDir;
  if (!downloadDir) {
    return { ok: false, error: "Download directory is not configured for this browser session." };
  }

  const deadline = Date.now() + 30000; // 30 seconds max
  let pdfPath = null;

  while (Date.now() < deadline) {
    if (fs.existsSync(downloadDir)) {
      const files = fs.readdirSync(downloadDir);
      // Look for a completed PDF download (not .crdownload)
      const pdf = files.find(f => f.toLowerCase().endsWith(".pdf"));
      const crdownload = files.find(f => f.toLowerCase().endsWith(".crdownload"));

      if (pdf && !crdownload) {
        // Double check file size isn't 0
        const stat = fs.statSync(path.join(downloadDir, pdf));
        if (stat.size > 0) {
          await new Promise(r => setTimeout(r, 1000)); // wait a second for Chrome to release the file lock
          pdfPath = path.join(downloadDir, pdf);
          break;
        }
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!pdfPath) {
    return { ok: false, error: "Proposal PDF did not download within 30 seconds." };
  }

  log(`   ✓ Downloaded: ${path.basename(pdfPath)}`);

  // Upload to S3
  try {
    const { uploadToS3, getPresignedUrl } = require("../../s3Uploader");
    const s3Key = `proposals/kshema/proposalpdf_${jobId}_${Date.now()}.pdf`;
    const s3Url = await uploadToS3(pdfPath, s3Key);
    const presignedUrl = await getPresignedUrl(s3Key);
    log(`   ✓ Uploaded to S3: ${s3Url}`);
    return { ok: true, pdfUrl: s3Url, pdfKey: s3Key, presignedUrl };
  } catch (e) {
    return { ok: false, error: `Failed to upload proposal PDF to S3: ${e.message}` };
  }
}

/**
 * Click Next to proceed to Nominee Details.
 * If Kshema's PA cover is enabled, click Add Entry to start filling nominee details.
 * If not, we skip nominee filling.
 */
async function fillNomineeDetails(driver, data, capture = null) {
  const { clickElement } = require("./kshemaFields");
  const { By } = require("selenium-webdriver");

  log("👥 Navigating to Nominee Details...");

  // 1. Click Next button on the summary page
  try {
    const nextBtn = await driver.findElement(By.xpath('//mat-icon[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "navigate_next")]'));
    await clickElement(driver, nextBtn, "navigate next button");
    await driver.sleep(2000); // Wait for transition
  } catch (e) {
    return { ok: false, error: `Could not find or click the next button to go to nominee details: ${e.message}` };
  }

  // Determine if we need to add Nominee
  const paCoverOn = String(data.paCover).toLowerCase() === "true" || data.paCover === true;
  const isBrisk = String(data.paCoverCompany || "").toLowerCase() === "brisk";
  const needsNominee = paCoverOn && !isBrisk;

  if (needsNominee) {
    log("📝 PA Cover is ON (Kshema) — clicking Add Entry for nominee details...");
    try {
      const addEntryBtn = await driver.findElement(By.xpath('//span[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "add entry")]/ancestor::button | //button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "add entry")]'));
      await clickElement(driver, addEntryBtn, "Add Entry button");
      await driver.sleep(1500); // Wait for modal or fields to open
      
      const { Key } = require("selenium-webdriver");

      // 1. Nominee Name
      const nomineeName = String(data.nomineeName || "").trim();
      if (nomineeName) {
        const nameInput = await driver.findElements(By.xpath('//input[@data-iid="beneficiary_name_tmpl" or contains(translate(@placeholder, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee name")]'));
        if (nameInput.length > 0) {
          await nameInput[0].sendKeys(Key.CONTROL, "a");
          await nameInput[0].sendKeys(Key.BACK_SPACE);
          await nameInput[0].sendKeys(nomineeName);
          log(`   ✓ Nominee Name set to "${nomineeName}"`);
        } else {
          log(`   ⚠️ Nominee Name field not found`);
        }
      }

      // 2. Nominee Type (Dropdown)
      const nomineeType = String(data.nomineeType || "Individual").trim();
      if (nomineeType) {
        const typeSelect = await driver.findElements(By.xpath('//mat-select[.//span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee type")]] | //span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee type")]/ancestor::mat-select | //span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee type")]/ancestor::mat-form-field//mat-select'));
        if (typeSelect.length > 0) {
          await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", typeSelect[0]);
          await clickElement(driver, typeSelect[0], "Nominee Type dropdown");
          await driver.sleep(500);
          
          const options = await driver.findElements(By.xpath(`//mat-option//span[translate(normalize-space(text()), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")="${nomineeType.toLowerCase()}"]`));
          if (options.length > 0) {
            await clickElement(driver, options[0], "Nominee Type option");
            log(`   ✓ Nominee Type set to "${nomineeType}"`);
          } else {
            log(`   ⚠️ Nominee Type option "${nomineeType}" not found`);
            try { await driver.actions().sendKeys(Key.ESCAPE).perform(); } catch(e) {}
          }
          await driver.sleep(400);
        } else {
          log(`   ⚠️ Nominee Type dropdown not found`);
        }
      }

      // 3. Nominee Relationship (Dropdown)
      let nomineeRelation = String(data.nomineeRelation || "").trim();
      if (nomineeRelation) {
        const relSelect = await driver.findElements(By.xpath('//mat-select[.//span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee relationship")]] | //span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee relationship")]/ancestor::mat-select | //span[contains(translate(text(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee relationship")]/ancestor::mat-form-field//mat-select'));
        if (relSelect.length > 0) {
          await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", relSelect[0]);
          await clickElement(driver, relSelect[0], "Nominee Relationship dropdown");
          await driver.sleep(500);
          
          const options = await driver.findElements(By.xpath(`//mat-option//span[translate(normalize-space(text()), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")="${nomineeRelation.toLowerCase()}"]`));
          if (options.length > 0) {
            await clickElement(driver, options[0], "Nominee Relationship option");
            log(`   ✓ Nominee Relationship set to "${nomineeRelation}"`);
          } else {
            log(`   ⚠️ Nominee Relationship option "${nomineeRelation}" not found`);
            try { await driver.actions().sendKeys(Key.ESCAPE).perform(); } catch(e) {}
          }
          await driver.sleep(400);
        } else {
          log(`   ⚠️ Nominee Relationship dropdown not found`);
        }
      }

      // 4. Nominee Share
      const nomineeShare = String(data.nomineeShare || "100").trim();
      if (nomineeShare) {
        const shareInput = await driver.findElements(By.xpath('//input[@data-iid="beneficiary_share_tmpl" or contains(translate(@placeholder, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee share")]'));
        if (shareInput.length > 0) {
          await shareInput[0].sendKeys(Key.CONTROL, "a");
          await shareInput[0].sendKeys(Key.BACK_SPACE);
          await shareInput[0].sendKeys(nomineeShare);
          log(`   ✓ Nominee Share set to "${nomineeShare}"`);
        } else {
          log(`   ⚠️ Nominee Share field not found`);
        }
      }

      // 5. Nominee DOB
      const rawDob = data.nomineeDob || data.nomineeDateOfBirth;
      if (rawDob) {
        let dobStr = String(rawDob).trim();
        if (dobStr.includes("T")) dobStr = dobStr.split("T")[0];
        if (dobStr.includes("-")) {
          const parts = dobStr.split("-");
          if (parts[0].length === 4) {
            dobStr = `${parts[2]}/${parts[1]}/${parts[0]}`;
          } else {
            dobStr = dobStr.replace(/-/g, "/");
          }
        }
        const dobInput = await driver.findElements(By.xpath('//input[@data-iid="beneficiary_dob_tmpl" or contains(translate(@placeholder, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "nominee dob")]'));
        if (dobInput.length > 0) {
          await dobInput[0].sendKeys(Key.CONTROL, "a");
          await dobInput[0].sendKeys(Key.BACK_SPACE);
          await dobInput[0].sendKeys(dobStr);
          await dobInput[0].sendKeys(Key.TAB);
          log(`   ✓ Nominee DOB set to "${dobStr}"`);
        } else {
          log(`   ⚠️ Nominee DOB field not found`);
        }
      }
      
      // Wait a moment for UI to register fields before we leave
      await driver.sleep(500);

      // 6. Click Save button
      try {
        const saveBtn = await driver.findElement(By.xpath('//button[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save")]'));
        await clickElement(driver, saveBtn, "Save Nominee button");
        await driver.sleep(1500); // Wait for modal to close
      } catch (e) {
        log(`   ⚠️ Could not find or click the Save button for nominee: ${e.message}`);
      }

    } catch (e) {
      log(`⚠️ Could not fill nominee details: ${e.message}`);
      return { ok: false, error: `Could not fill nominee details: ${e.message}` };
    }
  } else {
    log("⏭️  PA Cover is OFF or Brisk — skipping nominee entry.");
  }

  // 7. Click Save and Finalize button
  try {
    log("🚀 Clicking Save and Finalize...");
    const finalizeBtn = await driver.findElement(By.xpath('//button[@data-iid="finalize" or contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "save and finalize")]'));
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", finalizeBtn);
    
    // Sometimes it's disabled for a moment, wait for it to be enabled
    await driver.wait(async () => {
      const disabled = await finalizeBtn.getAttribute("disabled");
      const cls = await finalizeBtn.getAttribute("class");
      return disabled !== "true" && disabled !== "disabled" && (!cls || !cls.includes("mat-mdc-button-disabled"));
    }, 10000).catch(() => {});
    
    await clickElement(driver, finalizeBtn, "Save and Finalize button");
    await driver.sleep(2000); // Wait for navigation
    
    // Check if an error toast appeared (e.g. "Quotation already converted to proposal")
    const { readToast: getToast } = require("./kshemaToast");
    const toast = await getToast(driver);
    if (toast && toast.isError) {
      log(`   ⚠️ Portal rejected Save and Finalize: "${toast.text}"`);
      return { ok: false, error: `Portal rejected Save and Finalize: "${toast.text}"` };
    }
  } catch (e) {
    log(`   ⚠️ Could not find or click the Save and Finalize button: ${e.message}`);
    return { ok: false, error: `Could not find or click the Save and Finalize button: ${e.message}` };
  }

  return { ok: true, needsNominee };
}

/**
 * Click the KYC button to proceed to the next stage and capture the KYC URL from the new tab.
 */
/**
 * What the KYC page shows when a verification is refused:
 *
 *   <div role="alert" class="... border-destructive/30 bg-destructive/5 ...">
 *     <p class="text-destructive text-sm">No record found</p>
 *
 * On a refusal the portal hands over to DigiLocker — "Complete your KYC",
 * "Continue to DigiLocker", "Try with different document" — and that card is
 * what the operator actually sees.
 *
 * Searched in any iframes as well as the main document: DigiLocker is embedded,
 * and an element inside a frame is invisible to findElements on the page that
 * hosts it.
 */
const KYC_ERROR_SELECTORS = [
  'div[role="alert"] p.text-destructive',
  "p.text-destructive",
  'div[role="alert"]',
];

/** Text that means the KYC has NOT gone through, even without an alert box. */
const KYC_INCOMPLETE_MARKERS = [
  "no record found",
  "continue to digilocker",
  "try with different document",
  "complete your kyc",
];

async function readKycErrorHere(driver) {
  // Read through JavaScript rather than Selenium's getText().
  //
  // getText() returns only what Selenium considers RENDERED, and it decides
  // that from its own visibility rules — which is how a "No record found" box
  // filling the screen kept coming back as an empty string. innerText is what
  // the browser itself has laid out, so it agrees with the screenshot.
  let alertText = "";
  try {
    alertText = await driver.executeScript(`
      const sels = ['[role="alert"] .text-destructive', '.text-destructive', '[role="alert"]'];
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t) return t;
        }
      }
      return '';
    `);
  } catch (e) { }
  if (alertText) return String(alertText).trim();

  // No alert box, but the DigiLocker hand-off card says the same thing.
  let pageText = "";
  try {
    pageText = await driver.executeScript(
      "return document.body ? (document.body.innerText || '') : '';"
    );
  } catch (e) { }
  const lower = String(pageText || "").toLowerCase();
  for (const marker of KYC_INCOMPLETE_MARKERS) {
    if (lower.includes(marker)) {
      return marker === "no record found" ? "No record found" : "KYC was not completed";
    }
  }
  return null;
}

/** Same check, run in the page and in every iframe on it. */
async function readKycError(driver) {
  const here = await readKycErrorHere(driver);
  if (here) return here;

  let frames = [];
  try {
    frames = await driver.findElements(By.css("iframe"));
  } catch (e) {
    return null;
  }
  for (const frame of frames) {
    try {
      await driver.switchTo().frame(frame);
      const inFrame = await readKycErrorHere(driver);
      await driver.switchTo().defaultContent();
      if (inFrame) return inFrame;
    } catch (e) {
      try {
        await driver.switchTo().defaultContent();
      } catch (e2) { }
    }
  }
  return null;
}

/**
 * Watch for up to `timeoutMs` to see whether the KYC was refused, across EVERY
 * open tab.
 *
 * Two things had to be fixed here, and the second is the one that mattered:
 *
 *  - It was checked ONCE, three seconds after Confirm & Verify, before the
 *    DigiLocker card had rendered. Now it is polled, and returns the moment the
 *    refusal appears rather than sitting out the full wait.
 *  - It only looked at the tab the driver happened to be on. The portal opens
 *    DigiLocker in a NEW tab, so the refusal was on screen — filling the whole
 *    browser — while the driver was still parked on the previous one, finding
 *    nothing. Every handle is checked each pass, and the driver is left ON the
 *    tab holding the error so the operator sees it and the screenshot captures
 *    it.
 */
async function waitForKycRefusal(driver, timeoutMs = 30000, pollMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let described = false;

  while (Date.now() < deadline) {
    let handles = [];
    try {
      handles = await driver.getAllWindowHandles();
    } catch (e) {
      // The tab the driver was parked on can be closed by the portal during the
      // hand-off. Losing it must not blind the search — that is what made this
      // sit out the whole wait doing nothing while the refusal was on screen.
      warn(`   Lost track of the browser windows: ${e.message}`);
      handles = [];
    }

    for (const handle of [...handles].reverse()) {
      try {
        // Switched to unconditionally. Comparing against getWindowHandle()
        // first meant a dead current window skipped the switch entirely.
        await driver.switchTo().window(handle);
        await driver.switchTo().defaultContent();

        const found = await readKycError(driver);

        if (!described) {
          // One line per tab, once, so a run that finds nothing still says
          // WHERE it looked. Guessing at this from the outside cost two rounds.
          let url = "";
          try {
            url = await driver.getCurrentUrl();
          } catch (e) { }
          log(`   · checked tab: ${url || "(no url)"}${found ? ` → "${found}"` : ""}`);
        }

        if (found) return found; // stay on this tab — it is the one to look at
      } catch (e) { }
    }
    described = true; // only list the tabs on the first pass

    await driver.sleep(pollMs);
  }
  return null;
}

async function fillKYCDetails(driver, data, capture = null) {
  const { clickElement } = require("./kshemaFields");
  const { By } = require("selenium-webdriver");

  log("🆔 Navigating to KYC...");

  try {
    // Wait for the KYC button to appear on the new page
    const kycBtn = await driver.wait(async () => {
      const elements = await driver.findElements(By.xpath('//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "kyc")] | //i-kyc//button'));
      if (elements.length > 0) return elements[0];
      return null;
    }, 15000, "KYC button did not appear after 15 seconds");

    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", kycBtn);

    const originalWindow = await driver.getWindowHandle();

    // The page the KYC button was pressed FROM. Worth keeping alongside the KYC
    // link itself: KYC opens in a new tab, so once the run moves over there
    // this is the only record of where to come back to — the proposal the KYC
    // belongs to. Read before the click, because the click is what takes the
    // browser away from it.
    let proposalUrl = "";
    try {
      proposalUrl = await driver.getCurrentUrl();
      log(`   ✓ Proposal page: ${proposalUrl}`);
    } catch (e) {
      warn(`   Could not read the proposal page URL: ${e.message}`);
    }

    await clickElement(driver, kycBtn, "KYC button");
    
    // Wait for the new tab to open
    await driver.wait(async () => {
      const handles = await driver.getAllWindowHandles();
      return handles.length > 1;
    }, 10000);

    const handles = await driver.getAllWindowHandles();
    let kycUrl = "";
    // Only a Confirm & Verify the portal accepted sets this.
    let kycCompleted = false;

    for (let handle of handles) {
      if (handle !== originalWindow) {
        await driver.switchTo().window(handle);
        // Wait for page to load
        await driver.sleep(3000);
        kycUrl = await driver.getCurrentUrl();
        
        // Interact with KYC page elements
        try {
          const result = await driver.wait(
            async () => {
              const continueBtns = await driver.findElements(By.xpath('//button[translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")="continue"]'));
              if (continueBtns.length > 0) return { type: 'continue', element: continueBtns[0] };
              
              const aadhaarBtns = await driver.findElements(By.xpath('//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "aadhaar")]'));
              if (aadhaarBtns.length > 0) return { type: 'aadhaar', element: aadhaarBtns[0] };
              
              return null;
            },
            15000,
            "Neither Aadhaar nor Continue button found"
          );
          
          if (result.type === 'continue') {
            log("   ✅ KYC is already complete, clicking Continue...");
            await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", result.element);
            await clickElement(driver, result.element, "KYC Continue Button");
            await driver.sleep(2000);
            // This branch means the portal had already verified this customer,
            // so the KYC IS done — without setting the flag here a perfectly
            // good KYC would be reported as unfinished and its tab held open.
            kycCompleted = true;
          } else {
            const aadhaarBtn = result.element;
            await clickElement(driver, aadhaarBtn, "Aadhaar KYC Button");
            await driver.sleep(1000);
            
            // Enter last 4 digits of Aadhaar number
            const aadharNumber = data.aadharNumber || data.formData?.aadharNumber || data.AadharNumber || "";
            if (aadharNumber && aadharNumber.length >= 4) {
              const lastFour = aadharNumber.slice(-4);
              const aadharInput = await driver.findElement(By.id("number-input"));
              await aadharInput.sendKeys(lastFour);
              log(`   ✓ Entered last 4 digits of Aadhaar: ${lastFour}`);
              
              await driver.sleep(500); // Small wait before submitting
              
              // 3. Click Submit for Verification button
              const submitBtn = await driver.findElement(By.xpath('//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "submit for verification")]'));
              await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", submitBtn);
              await clickElement(driver, submitBtn, "Submit for Verification Button");
              log(`   🚀 Clicked Submit for Verification`);
              await driver.sleep(2000); // Wait for dialog to open
              
              // 4. Click Confirm & Verify in the dialog
              const confirmBtn = await driver.wait(
                async () => {
                  const btns = await driver.findElements(By.xpath('//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "confirm & verify")] | //button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "confirm and verify")]'));
                  if (btns.length > 0) return btns[0];
                  return null;
                },
                10000,
                "Confirm & Verify button not found"
              );
              await clickElement(driver, confirmBtn, "Confirm & Verify Button");
              log(`   ✅ Clicked Confirm & Verify`);
              await driver.sleep(2000); // let the transition start

              // Did the portal accept it? "No record found" means the Aadhaar
              // details do not match anything at its end — a data problem on
              // the policy, not something a retry can shift.
              log("   ⏳ Watching 30s to see whether the KYC is accepted...");
              const kycError = await waitForKycRefusal(driver, 30000);
              if (kycError) {
                err(`KYC refused: ${kycError}`);
                if (capture) {
                  await capture("kyc_rejected", "kyc_rejected");
                }
                // Deliberately NOT switching back to the proposal tab — see the
                // note on the switch below.
                // The tab holding the error is the one the driver is on now —
                // read its URL so the operator opens the right page.
                let refusedUrl = kycUrl;
                try {
                  refusedUrl = await driver.getCurrentUrl();
                } catch (e) { }
                return {
                  ok: false,
                  kycUrl: refusedUrl || kycUrl,
                  proposalUrl,
                  stayedOnKycPage: true,
                  kycStatus: kycError,
                  error:
                    `The KSHEMA KYC page refused the verification: "${kycError}". ` +
                    "Check the customer's Aadhaar number and name on the policy " +
                    "against their card, then run this policy again. The KYC page " +
                    "has been left open on screen.",
                };
              }
              kycCompleted = true;
            } else {
              log("   ⚠️ No valid Aadhaar number found to extract last 4 digits.");
            }
          }
        } catch (innerErr) {
          log(`   ⚠️ Could not select Aadhaar method or enter digits: ${innerErr.message}`);
        }
        
        break;
      }
    }

    log(`   ✓ KYC Link captured: ${kycUrl}`);

    // Back to the proposal tab ONLY when the KYC went through.
    //
    // This switch used to be unconditional, which is why an unfinished KYC
    // "navigated back to the proposal page on its own": the automation moved
    // the browser, not the portal. Leaving the KYC tab in front means whoever
    // picks it up is looking at the step that needs finishing.
    // One last look before leaving. The "already complete → Continue" branch
    // does not watch for a refusal the way the Aadhaar one does, and this is
    // the last moment the KYC tab is in front — a check here costs a second and
    // stops a refused KYC being carried into the payment step.
    if (kycCompleted) {
      const lateError = await readKycError(driver);
      if (lateError) {
        err(`KYC refused: ${lateError}`);
        if (capture) await capture("kyc_rejected", "kyc_rejected");
        let refusedUrl = kycUrl;
        try {
          refusedUrl = await driver.getCurrentUrl();
        } catch (e) { }
        return {
          ok: false,
          kycUrl: refusedUrl || kycUrl,
          proposalUrl,
          stayedOnKycPage: true,
          kycStatus: lateError,
          error:
            `The KSHEMA KYC page refused the verification: "${lateError}". ` +
            "Check the customer's Aadhaar number and name on the policy against " +
            "their card, then run this policy again. The KYC page has been left " +
            "open on screen.",
        };
      }
    }

    if (kycCompleted) {
      await driver.switchTo().window(originalWindow);
    } else {
      warn("   KYC did not complete — leaving the KYC tab open and in front.");
      if (capture) await capture("kyc_incomplete", "kyc_incomplete");
    }

    return { ok: kycCompleted, kycUrl, proposalUrl, stayedOnKycPage: !kycCompleted,
      ...(kycCompleted ? {} : {
        error:
          "The KSHEMA KYC did not complete. The KYC page has been left open on " +
          "screen so it can be finished by hand, and its link is saved on the " +
          "policy.",
      }) };
  } catch (e) {
    return { ok: false, error: `Could not find or click the KYC button, or capture link: ${e.message}` };
  }
}

module.exports = {
  fillCustomerDetails,
  fillVehicleDetails,
  fillPaCoverDetails,
  fillPremiumDetails,
  submitQuoteForm,
  fillAddonsDetails,
  downloadProposal,
  fillNomineeDetails,
  fillKYCDetails,
  proceedToPayment,
  CUSTOMER_FIELDS,
  VEHICLE_FIELDS,
  PA_COVER_FIELDS,
  PREMIUM_FIELDS,
  ADDON_FIELDS,
};

/**
 * Wait for the loader to finish and click Make Payment on the original page.
 */
async function proceedToPayment(driver, capture = null, jobId = "") {
  const { clickElement } = require("./kshemaFields");
  const { By } = require("selenium-webdriver");

  log("💳 Proceeding to Payment...");

  try {
    // 1. Wait for loader to disappear
    // Wait for the KYC processing spinner, but only for 30 seconds.
    //
    // It used to throw after 60, which killed the run with a Selenium timeout
    // and no picture of what the page was stuck on. A spinner still turning
    // after half a minute means KYC has not come back — that is worth SEEING,
    // so the wait ends quietly, the page is photographed, and the caller is
    // told the KYC never finished rather than the run dying mid-step.
    log("   ⏳ Waiting for KYC processing loader to finish (up to 30s)...");
    const loaderGone = await driver
      .wait(async () => {
        const loaders = await driver.findElements(By.xpath('//mat-spinner[@data-iid="__loading"] | //div[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "processing")]'));
        return loaders.length === 0;
      }, 30000)
      .then(() => true)
      .catch(() => false);

    if (!loaderGone) {
      warn("   KYC is still processing after 30s — capturing the page.");
      let stuckUrl = "";
      try {
        stuckUrl = await driver.getCurrentUrl();
      } catch (e) { }
      let shotUrl = null;
      if (capture) {
        const shot = await capture("kyc_still_processing", `kshema_kyc_still_processing_${jobId}`);
        shotUrl = shot && shot.screenshotUrl ? shot.screenshotUrl : null;
      }
      return {
        ok: false,
        stuckOnKyc: true,
        kycUrl: stuckUrl,
        screenshotUrl: shotUrl,
        error:
          "The KSHEMA KYC was still processing after 30 seconds, so the payment " +
          "step was not reached. The page has been left open and photographed — " +
          "check whether the KYC went through at the portal before running this " +
          "policy again.",
      };
    }

    // 2. Click Make Payment
    const makePaymentBtn = await driver.wait(
      async () => {
        const btns = await driver.findElements(By.xpath('//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "make payment")] | //span[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "make payment")]/ancestor::button'));
        for (const b of btns) {
          try {
            if (await b.isDisplayed()) return b;
          } catch (e) { }
        }
        return null;
      },
      15000,
      "Make Payment button not found"
    );

    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", makePaymentBtn);
    await clickElement(driver, makePaymentBtn, "Make Payment Button");
    log("   🚀 Clicked Make Payment");
    await driver.sleep(4000); // Wait for transition to payment gateway
    
    let qrScreenshotUrl = null;
    let qrScreenshotKey = null;

    // 3. Select Razorpay option
    //
    // The option is a <button>, and that is what has to be clicked:
    //
    //   <button type="button" class="... border-primary ring-2 ...">
    //     <div class="flex items-center gap-4 px-5 py-4">
    //       <p class="font-medium">Razorpay</p>
    //
    // This used to look for //div[contains(@class,"flex") and .//p[text()=
    // "Razorpay"]] and take els[0]. XPath returns document order, so els[0] was
    // the OUTERMOST div wrapping the payment list — a layout container with no
    // click handler on it at all. The option was never actually chosen, which
    // is why "Pay with Razorpay" then appeared to do nothing.
    try {
      const razorpayOption = await driver.wait(
        async () => {
          const btns = await driver.findElements(
            By.xpath('//button[.//p[normalize-space()="Razorpay"]]')
          );
          for (const b of btns) {
            try {
              if (await b.isDisplayed()) return b;
            } catch (e) { }
          }
          return null;
        },
        10000,
        "Razorpay option not found"
      );

      // Is it already chosen? Read the radio DOT at the end of the card, not
      // the card's own class list:
      //
      //   chosen   <div class="h-4 w-4 rounded-full border border-primary bg-primary">
      //   not      <div class="h-4 w-4 rounded-full border border-muted-foreground/40">
      //
      // The card itself carries `hover:border-primary/60` whether or not it is
      // selected, and a /border-primary/ test matches inside that — which is
      // exactly what made this report "already selected" every time and never
      // click at all. `bg-primary` appears only on the filled dot.
      const isRazorpaySelected = async () => {
        try {
          const dots = await razorpayOption.findElements(
            By.css("div.rounded-full")
          );
          for (const dot of dots) {
            const cls = (await dot.getAttribute("class")) || "";
            if (/(^|\s)bg-primary(\s|$)/.test(cls)) return true;
          }
        } catch (e) { }
        return false;
      };

      if (await isRazorpaySelected()) {
        log("   ✓ Razorpay already selected");
      } else {
        await clickElement(driver, razorpayOption, "Razorpay Option");
        await driver.sleep(1000); // short wait for selection UI

        // Verify rather than assume. A click that lands but does not select
        // leaves the Pay button disabled, and the run would sail on believing
        // it had chosen a payment method.
        if (!(await isRazorpaySelected())) {
          debug("   … Razorpay did not take, clicking it once more");
          await clickElement(driver, razorpayOption, "Razorpay Option");
          await driver.sleep(1200);
        }

        if (await isRazorpaySelected()) {
          log("   ✓ Selected Razorpay");
        } else {
          throw new Error(
            "Razorpay could not be selected on the payment page — the option " +
            "did not switch on when clicked"
          );
        }
      }

      // 4. Click Pay with Razorpay button
      const payBtn = await driver.wait(
        async () => {
          const btns = await driver.findElements(By.xpath('//button[contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "pay with razorpay")]'));
          for (const b of btns) {
            try {
              if (await b.isDisplayed()) return b;
            } catch (e) { }
          }
          return null;
        },
        10000,
        "Pay with Razorpay button not found"
      );

      // A disabled button swallows the click silently and the run carries on
      // believing it paid. Wait for it to become live, and say so if it does
      // not — that points at the option above, not at this button.
      const payEnabled = await driver.wait(
        async () => {
          try {
            const ariaDisabled = await payBtn.getAttribute("aria-disabled");
            return (await payBtn.isEnabled()) && ariaDisabled !== "true";
          } catch (e) {
            return false;
          }
        },
        8000
      ).then(() => true).catch(() => false);

      if (!payEnabled) {
        throw new Error(
          "The 'Pay with Razorpay' button stayed disabled — the payment method " +
          "was not accepted by the page"
        );
      }

      await clickElement(driver, payBtn, "Pay with Razorpay Button");
      log("   🚀 Clicked Pay with Razorpay");
      
      await driver.sleep(5000); // Wait for Razorpay checkout to open / redirect
      
      // 5. Interact with Razorpay UI (usually inside an iframe)
      let iframeSwitched = false;
      try {
        const frames = await driver.findElements(By.css('iframe.razorpay-checkout-frame'));
        if (frames.length > 0) {
          await driver.switchTo().frame(frames[0]);
          iframeSwitched = true;
          log("   ✓ Switched to Razorpay iframe");
        }
      } catch (e) { }

      // Click "Show QR"
      const showQrBtn = await driver.wait(
        async () => {
          const btns = await driver.findElements(By.xpath('//span[@name="generateQR" or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "show qr")]'));
          for (const b of btns) {
            try {
              if (await b.isDisplayed()) return b;
            } catch (e) { }
          }
          return null;
        },
        15000,
        "Show QR button not found"
      );
      await clickElement(driver, showQrBtn, "Show QR Button");
      log("   🚀 Clicked Show QR");
      await driver.sleep(2000);

      // Click "Continue & Pay"
      const continuePayBtn = await driver.wait(
        async () => {
          const btns = await driver.findElements(By.xpath('//button[@data-testid="fee-bearer-cta" or contains(translate(normalize-space(.), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "continue & pay")]'));
          for (const b of btns) {
            try {
              if (await b.isDisplayed()) return b;
            } catch (e) { }
          }
          return null;
        },
        10000,
        "Continue & Pay button not found"
      );
      await clickElement(driver, continuePayBtn, "Continue & Pay Button");
      log("   🚀 Clicked Continue & Pay");
      await driver.sleep(3000); // Wait for QR code to generate

      // Capture screenshot
      if (capture) {
        log("   📸 Capturing Payment QR Code screenshot...");
        const shot = await capture("payment_qr", `kshema_payment_qr_${jobId}`);
        if (shot && shot.screenshotUrl) {
          log(`   ✓ Saved Payment QR Code screenshot: ${shot.screenshotUrl}`);
          qrScreenshotUrl = shot.screenshotUrl;
          qrScreenshotKey = shot.screenshotKey;
        }
      }

      if (iframeSwitched) {
        await driver.switchTo().defaultContent();
      }
    } catch (paymentErr) {
      log(`   ⚠️ Could not select Razorpay option or interact with QR flow: ${paymentErr.message}`);
    }
    
    const paymentUrl = await driver.getCurrentUrl();
    log(`   ✓ Payment Link captured: ${paymentUrl}`);

    return { ok: true, paymentUrl, qrScreenshotUrl, qrScreenshotKey };
  } catch (e) {
    return { ok: false, error: `Could not proceed to payment: ${e.message}` };
  }
}
