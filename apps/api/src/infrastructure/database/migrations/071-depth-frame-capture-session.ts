import type { Migration } from "../migration-runner.js";

/**
 * Attributes every depth frame to the capture process that wrote it.
 *
 * Added immediately after `070-depth-frames` because the first real capture exposed the hole. The
 * run report reads its own rows back out of the table to compute the sequence-health verdict, and it
 * scoped that read by symbol and time window alone — which silently trusts that nothing else wrote
 * to the same symbol in the same window.
 *
 * Something did. Two orphaned collector processes, left behind when a shell `timeout` killed the
 * `npx` wrapper but not the `tsx` child, kept capturing the same contract. A one-minute window then
 * held 239 rows carrying only 124 distinct payload digests, and the health summary reported 236
 * examined frames for a capture that had written 118. Every rate computed over that window was
 * meaningless, and nothing in the output said so — the verdict still read `RECONSTRUCTIBLE`.
 *
 * That is the precise failure mode this whole table exists to prevent, arriving through the back
 * door: a metric that looks authoritative while describing data the process never wrote. Scoping the
 * readback to `capture_session_id` makes the report describe *this* capture, and counting the rows
 * in the window that belong to other sessions turns contamination from an invisible corruption into
 * a reported number.
 *
 * Nullable rather than NOT NULL: rows written by 070's collector predate the column, and
 * backfilling them with a fabricated session id would assert an attribution that was never
 * observed.
 */
export const depthFrameCaptureSessionMigration: Migration = {
  id: "071-depth-frame-capture-session",
  sql: `
    ALTER TABLE depth_frames
      ADD COLUMN IF NOT EXISTS capture_session_id UUID;

    CREATE INDEX IF NOT EXISTS depth_frames_capture_session_idx
    ON depth_frames (capture_session_id, provider_symbol, received_at)
    WHERE capture_session_id IS NOT NULL;

    COMMENT ON COLUMN depth_frames.capture_session_id IS
      'The collector run that wrote this row. Health reports scope to it so a concurrent writer cannot silently corrupt a gap rate. NULL for rows written before this column existed.';
  `,
};
