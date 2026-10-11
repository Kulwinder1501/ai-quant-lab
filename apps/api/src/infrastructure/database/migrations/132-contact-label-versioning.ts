import type { Migration } from "../migration-runner.js";

/**
 * Versions the liquidity research tables so rows from the defective legacy generators can never be
 * silently mixed with rows from the corrected ones, and makes candidate generation idempotent.
 *
 * `liquidity_pool_candidates` and `liquidity_contact_labels` were created outside the migration
 * chain, so every statement below is guarded with `to_regclass(...)`: on a database that does not
 * have them the migration is a no-op instead of a failure.
 *
 * ## `liquidity_contact_labels.labeling_version` (DEFAULT 'v1-legacy')
 *
 * - Every existing row becomes `v1-legacy`: the forward window started at the OPEN of the
 *   confirming bar (look-ahead), the "30s" horizon was computed from 1m bars (a 60s span) and
 *   `contact_time` was the touch bar's open. See `liquidity-label-versions.ts`.
 * - `generate-contact-labels.ts` writes `v2-causal`.
 * - The old UNIQUE (candidate_id, horizon_seconds) is replaced by UNIQUE
 *   (candidate_id, horizon_seconds, labeling_version) so a candidate can carry both a legacy and a
 *   v2 label; with the old key a v2 re-label would be silently skipped by ON CONFLICT DO NOTHING.
 *
 * ## `liquidity_pool_candidates.candidate_version` (DEFAULT 'v1-legacy') and `session_date`
 *
 * - Legacy rows keep `v1-legacy` and a NULL `session_date` (no backfill is attempted: the legacy
 *   duplicates cannot be told apart from real level-days without re-running the generator).
 * - The idempotency key (instrument_id, timeframe, pool_type, price, session_date) is enforced by
 *   a PARTIAL unique index limited to `candidate_version = 'v2-dedup'`. A full unique index cannot
 *   be created: the legacy table holds up to ~1,700 duplicate rows per level-day (5m BANKNIFTY PDL:
 *   104,749 rows for 191 level-days), and this migration deliberately does not touch them.
 *
 * ## Documented, NOT executed here: legacy de-duplication
 *
 * If a decision is made to purge legacy duplicates, run something like the following manually
 * AFTER dependent labels are re-pointed or deleted (labels reference candidates by FK):
 *
 *   -- inspect only: level-days with more than one legacy PDL/PDH row
 *   SELECT instrument_id, timeframe, pool_type, price,
 *          (known_at_time AT TIME ZONE 'Asia/Kolkata')::date AS ist_day, count(*)
 *   FROM liquidity_pool_candidates
 *   WHERE candidate_version = 'v1-legacy' AND pool_type IN ('PDH', 'PDL')
 *   GROUP BY 1, 2, 3, 4, 5 HAVING count(*) > 1 ORDER BY count(*) DESC;
 *
 * Prefer regenerating with `generate-liquidity-candidates` (writes v2-dedup rows) and evaluating
 * only `labeling_version = 'v2-causal'` over `candidate_version = 'v2-dedup'`.
 *
 * Index creation is not CONCURRENT (the runner wraps migrations in a transaction); the unique
 * index on `liquidity_contact_labels` scans ~4M rows once and takes a short write lock.
 */
export const contactLabelVersioningMigration: Migration = {
  id: "132-contact-label-versioning",
  sql: `
    DO $$
    BEGIN
      IF to_regclass('public.liquidity_contact_labels') IS NOT NULL THEN
        ALTER TABLE liquidity_contact_labels
          ADD COLUMN IF NOT EXISTS labeling_version TEXT NOT NULL DEFAULT 'v1-legacy';

        CREATE UNIQUE INDEX IF NOT EXISTS lcl_candidate_horizon_version_key
          ON liquidity_contact_labels (candidate_id, horizon_seconds, labeling_version);

        ALTER TABLE liquidity_contact_labels
          DROP CONSTRAINT IF EXISTS liquidity_contact_labels_candidate_id_horizon_seconds_key;

        COMMENT ON COLUMN liquidity_contact_labels.labeling_version IS
          'v1-legacy: look-ahead window (started at the confirming bar OPEN), 30s horizon computed from 1m bars, contact_time = touch bar open; do not evaluate. v2-causal: window starts at the confirming bar CLOSE, bars must close inside the horizon, contact_time = touch bar close.';
      END IF;

      IF to_regclass('public.liquidity_pool_candidates') IS NOT NULL THEN
        ALTER TABLE liquidity_pool_candidates
          ADD COLUMN IF NOT EXISTS candidate_version TEXT NOT NULL DEFAULT 'v1-legacy';
        ALTER TABLE liquidity_pool_candidates
          ADD COLUMN IF NOT EXISTS session_date DATE;

        CREATE UNIQUE INDEX IF NOT EXISTS lpc_v2_level_session_key
          ON liquidity_pool_candidates (instrument_id, timeframe, pool_type, price, session_date)
          WHERE candidate_version = 'v2-dedup';

        COMMENT ON COLUMN liquidity_pool_candidates.candidate_version IS
          'v1-legacy: PDH/PDL re-registered on every bar after a breach (massive duplicates, selection bias). v2-dedup: one row per (instrument_id, timeframe, pool_type, price, session_date), enforced by lpc_v2_level_session_key.';
      END IF;
    END
    $$;
  `,
};
