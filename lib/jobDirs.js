/**
 * Who is using which job folder, so finishing one job can never delete the folder of another that is still running.
 *
 * Several policies run at the same time (one Chrome window each). Each job has its own profile folder and, for
 * Reliance, its own download folder, named from the job id and the start time. Two jobs ending up with the SAME folder
 * name is unlikely (the same first name started in the same millisecond) — but if it ever happened, the first to
 * finish used to delete the folder under the second one's live window. Every job therefore CLAIMS its folders when it
 * opens its browser and RELEASES them when it cleans up, and a folder is deleted only by the last one holding it.
 *
 * In-memory and per process: the queue workers are in this one process, which is what runs the windows.
 */
const path = require("path");

const holders = new Map(); // normalised folder path -> number of live jobs holding it

const key = (dir) => path.resolve(String(dir));

/** A job starts using `dir`. Returns the number of holders now. */
function claim(dir) {
  if (!dir) return 0;
  const k = key(dir);
  const n = (holders.get(k) || 0) + 1;
  holders.set(k, n);
  return n;
}

/**
 * A job is done with `dir`. Returns true when nobody else holds it any more — the caller may delete it — and false
 * when another live job still does (the folder must be left alone). A folder nobody claimed is free to delete.
 */
function release(dir) {
  if (!dir) return true;
  const k = key(dir);
  const n = holders.get(k) || 0;
  if (n <= 1) {
    holders.delete(k);
    return true;
  }
  holders.set(k, n - 1);
  return false;
}

/** For logs and tests. */
const holdersOf = (dir) => holders.get(key(dir)) || 0;

/** A short random token for folder names, so two jobs started in the same millisecond still get different folders. */
const uniqueSuffix = () => Math.random().toString(36).slice(2, 8);

module.exports = { claim, release, holdersOf, uniqueSuffix };
