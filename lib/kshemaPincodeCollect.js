/**
 * KSHEMA Pin code -> Locality collector (2026-11-23, the owner: "run KSHEMA like the make/model script, enter each pin code,
 * read the Locality dropdown it gives, save it on the Pincode & Locality page"). Run BY HAND (scripts/kshemaCollectPincodes.js);
 * it is not part of any policy run.
 *
 * The walk, after the normal KSHEMA steps (login, Two-Wheeler, the customer details of the quote form):
 *
 *   for each pin code from the shared list:
 *     type it into "Pin Code" (read back: the box must hold it)  ->  wait as a normal run does (loader + 2 s)
 *     ->  open "Pin code Locality", read EVERY option, close it  ->  check the Pin Code box still holds the pin
 *     ->  save the names for that pin (insert only)  ->  the next pin code
 *
 * Wrong data is worse than no data, so a list is saved ONLY when it surely belongs to the pin just typed:
 *   - a list identical to the previous pin's list is read again for a few seconds; still the same = "stale": the pin is
 *     put back once for later, and if it is stale again it is reported, never saved;
 *   - an empty list = KSHEMA does not know that pin code: reported, nothing saved;
 *   - the Pin Code box no longer holding the pin after the read (the portal reset it) = reported, nothing saved.
 *
 * Nothing else on the form is touched and nothing is saved at KSHEMA. Saving = lib/pincodeLocalitySave.saveLocalities
 * (collection pincodeLocality, unique pin code + name: a name already there is skipped, never changed, never repeated).
 * This file starts no browser and opens no database: driver, form helpers (ctx) and db come in (test/kshemaPincodeCollect.test.js).
 */
const { readFollowingList } = require("./kshemaModelCollect");
const { saveLocalities, pincodeOf } = require("./pincodeLocalitySave");
const { cleanName } = require("./relianceModelCollect");

// After typing a pin code: shorter than the normal run's 2 s (owner 2026-11-23: "fast") - safe because a list that is still
// the previous pin's is read again until it changes (READ_WAIT_MS) and is never saved under the new pin.
const SETTLE_MS = 700;
const READ_WAIT_MS = 8000; // how long a list identical to the previous pin's is read again before it counts as stale

const sleep = (driver, ms) => (driver && driver.sleep ? driver.sleep(ms) : new Promise((r) => setTimeout(r, ms)));
const keysOf = (texts) => (texts || []).map(cleanName).sort().join("\u0000");
const firstLine = (e) => String((e && e.message) || e).split("\n")[0];
/** The browser window itself is gone: this window cannot do any more pins. */
const windowIsGone = (e) => /invalid session id|no such window|session deleted|chrome not reachable|target window already closed|disconnected/i.test(firstLine(e));

function newPinTotals() {
  return { pinsDone: 0, namesAdded: 0, namesAlreadyThere: 0, withLocalities: [], empty: [], stale: [], failed: [] };
}

/** One list of pin codes for every window: a window takes the next pin nobody has taken; a pin may be given back ONCE. */
function createPinQueue(pins, districtOf = {}) {
  const queue = {
    targets: pins.map(pincodeOf).filter(Boolean),
    districtOf: (pin) => districtOf[pin] || "",
    next: 0,
    retry: [],
    retried: new Set(),
    take() {
      if (queue.retry.length) return { pin: queue.retry.shift(), again: true };
      if (queue.next < queue.targets.length) return { pin: queue.targets[queue.next++], again: false };
      return null;
    },
    giveBack(pin) {
      if (queue.retried.has(pin)) return false;
      queue.retried.add(pin);
      queue.retry.push(pin);
      return true;
    },
    /** A window died while on this pin: not the pin's fault, so it always goes back (does not use up its one retry). */
    putBack(pin) {
      queue.retry.push(pin);
    },
    left() {
      return queue.targets.length - queue.next + queue.retry.length;
    },
  };
  return queue;
}

async function readPinBox(driver, ctx, pinField) {
  try {
    const found = await ctx.kshemaFields.findVisible(driver, pinField.selectors);
    if (!found || !found.element) return null;
    return String((await found.element.getAttribute("value")) || "").replace(/\D/g, "");
  } catch (e) {
    return null;
  }
}

/**
 * The walk for ONE window. Returns { done:true } when the queue is empty; throws only when the window itself is gone
 * (its pin is given back first, so another window or the next run does it).
 *
 * @param {Object} opts { fields (CUSTOMER_FIELDS), db, data, queue, totals, log, onScreenPin, readList, settleMs, readWaitMs }
 */
async function collectPincodeLocalities(driver, ctx, opts = {}) {
  const {
    fields = [],
    db,
    data = {},
    queue,
    totals = newPinTotals(),
    log = () => {},
    readList = readFollowingList,
    settleMs = SETTLE_MS,
    readWaitMs = READ_WAIT_MS,
  } = opts;
  const pinField = fields.find((f) => f.key === "pinCode");
  const localityField = fields.find((f) => f.key === "locality");
  if (!pinField || !localityField) throw new Error("The Pin Code / Pin code Locality fields are not in the customer fields list.");

  // The list on screen now belongs to the policy's own pin code (the customer details just picked from it): it is the
  // "previous list" the first pin's list must differ from.
  let onScreenPin = pincodeOf(opts.onScreenPin != null ? opts.onScreenPin : data.pinCode || data.pincode);
  let previousKeys = null;
  try {
    const first = await readList(driver, ctx, localityField.selectors, localityField.label, { previousKeys: null, waitMs: 0, log });
    previousKeys = first.texts.length ? keysOf(first.texts) : null;
  } catch (e) {
    if (windowIsGone(e)) throw e;
  }

  for (let item = queue.take(); item; item = queue.take()) {
    const { pin, again } = item;
    const district = queue.districtOf ? queue.districtOf(pin) : "";
    const tag = `${pin}${district ? ` (${district})` : ""}${again ? " [second try]" : ""}`;
    try {
      const typed = await ctx.fillOneField(driver, data, pinField, pin, { capture: null, screenshots: [] });
      if (!typed || !typed.ok) throw new Error((typed && typed.reason) || "the Pin Code box did not take it");
      await ctx.waitForLoader(driver, 20000);
      await sleep(driver, settleMs);
      await ctx.waitForLoader(driver, 20000);

      // Typing the same pin that is already on screen gives the same list on purpose: then it is not "stale".
      const compareWith = pin === onScreenPin ? null : previousKeys;
      const { texts, stale } = await readList(driver, ctx, localityField.selectors, localityField.label, { previousKeys: compareWith, waitMs: readWaitMs, log });

      const held = await readPinBox(driver, ctx, pinField);
      if (held !== null && held !== pin) {
        throw new Error(`the Pin Code box shows "${held || "nothing"}" after reading the list, not ${pin}`);
      }

      if (!texts.length) {
        onScreenPin = pin;
        totals.empty.push(pin);
        log(`${tag}: KSHEMA lists NO locality for this pin code - nothing saved`);
        continue;
      }
      if (stale) {
        if (queue.giveBack(pin)) {
          log(`${tag}: the list did not change from the previous pin code's - not saved, tried again later`);
        } else {
          totals.stale.push(pin);
          log(`${tag}: the list still did not change from the previous pin code's - NOT saved (run again for this pin)`);
        }
        continue;
      }

      // only now is the list on screen known to be THIS pin's (a stale list never makes its pin "on screen": its second
      // try must be compared with the previous pin's list again, or that list would be saved under this pin)
      onScreenPin = pin;
      previousKeys = keysOf(texts);
      const saved = await saveLocalities(db, { pincode: pin, names: texts, district });
      totals.pinsDone++;
      totals.namesAdded += saved.added;
      totals.namesAlreadyThere += saved.alreadyThere;
      totals.withLocalities.push(pin);
      log(`${tag}: ${texts.length} localities - ${saved.added} new, ${saved.alreadyThere} already saved`);
    } catch (e) {
      if (windowIsGone(e)) {
        queue.putBack(pin);
        throw e;
      }
      if (queue.giveBack(pin)) {
        log(`${tag}: could not be read (${firstLine(e)}) - tried again later`);
      } else {
        totals.failed.push({ pin, why: firstLine(e) });
        log(`${tag}: FAILED again (${firstLine(e)}) - run the script again for this pin`);
      }
    }
  }
  return { done: true };
}

module.exports = { SETTLE_MS, READ_WAIT_MS, newPinTotals, createPinQueue, collectPincodeLocalities, windowIsGone, keysOf };
