/**
 * Where a finished job recording is recorded on the job document, and which
 * older video goes when it is replaced. No requires: lib/jobRecorder.js passes
 * in what touches S3, so this is testable against a bare collection.
 *
 *  - a job WITHOUT parts keeps one recording per policy: `recordings` is $set
 *    to just this entry (original behaviour);
 *  - a job WITH parts keeps one per part: this part's entry is replaced
 *    ($pull then $push, tagged `part`) and the other parts' entries — and their
 *    S3 objects — are left alone. Still bounded: one entry per part.
 */
async function saveRecordingEntry(
  collection,
  jobId,
  { entry, partKey = null, s3Key, deleteOld = async () => {}, warn = () => {} }
) {
  // Any earlier recording of this job under a DIFFERENT key (the company
  // changed between runs) would otherwise be left behind: the upload only
  // overwrites the key it wrote to.
  try {
    const prev = await collection.findOne({ _id: jobId }, { projection: { recordings: 1 } });
    for (const old of (prev && prev.recordings) || []) {
      // With parts, the other parts' videos are not ours to delete.
      if (partKey && (!old || old.part !== partKey)) continue;
      if (old && old.s3Key && old.s3Key !== s3Key) {
        await deleteOld(old.s3Key);
      }
    }
  } catch (e) {
    warn(`Could not check for an older recording: ${e.message}`);
  }

  if (partKey) {
    await collection.updateOne({ _id: jobId }, { $pull: { recordings: { part: partKey } } });
    await collection.updateOne(
      { _id: jobId },
      { $push: { recordings: { ...entry, part: partKey } } }
    );
  } else {
    // $set, not $push: one recording per policy — the newest run wins.
    await collection.updateOne({ _id: jobId }, { $set: { recordings: [entry] } });
  }
}

module.exports = { saveRecordingEntry };
