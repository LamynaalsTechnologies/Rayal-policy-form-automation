/**
 * Where a finished job recording is recorded on the job document. No requires, so this is testable against a bare
 * collection.
 *
 * Every run keeps its own video (2026-11-05, the owner: History -> Runs plays each run's video). Before, a new video
 * REPLACED the part's earlier one (its entry pulled, its S3 object deleted) and a job without parts kept one in all.
 * Now the entry is added at the end and nothing is deleted: each video has its own key (s3Uploader generateRecordingKey)
 * and S3's lifecycle rule deletes it RECORDING_RETENTION_DAYS after its upload. Bounded: the newest RECORDINGS_MAX
 * entries are kept, the same number as the runs (lib/runHistory.js RUN_HISTORY_MAX).
 */
const RECORDINGS_MAX = 100;

async function saveRecordingEntry(collection, jobId, { entry, partKey = null, s3Key = null } = {}) {
  const row = partKey ? { ...entry, part: partKey } : { ...entry };
  // The same video saved twice (never expected - one finalize per run) is one entry, not two.
  if (s3Key) await collection.updateOne({ _id: jobId }, { $pull: { recordings: { s3Key } } });
  await collection.updateOne(
    { _id: jobId },
    { $push: { recordings: { $each: [row], $slice: -RECORDINGS_MAX } } }
  );
}

module.exports = { saveRecordingEntry, RECORDINGS_MAX };
