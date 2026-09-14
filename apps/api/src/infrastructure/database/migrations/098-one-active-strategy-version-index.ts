import type { Migration } from "../migration-runner.js";

/**
 * Re-creates the one-active-version index, after removing the writer that made it unsurvivable.
 *
 * ## Why this is 098 and not a correction to 097
 *
 * 097 ran successfully and is recorded as applied, so it will never run again. Its `UPDATE` did the
 * right thing; its `CREATE UNIQUE INDEX` was correct and premature. Editing 097 would leave the
 * index absent on this database forever while pretending otherwise on a fresh one -- the migration
 * ledger's whole value is that "applied" means what it says.
 *
 * ## What went wrong the first time
 *
 * `seedMarketData` ran on every API startup and executed
 *
 *     INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
 *     VALUES ($1, 1, ..., TRUE)
 *     ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE
 *
 * for `trend-breakout` -- an obsolete version, forced active on every boot, against a code
 * registration that declares version 2. That is why the database carried two active versions, and it
 * is what violated the index: the seed upserted before the process could serve anything, so the API
 * crash-looped and stayed down for about eleven minutes until the index was dropped by hand.
 *
 * The lesson is narrow and worth stating: I identified `ensure()` as the writer to fix and never
 * enumerated the others. A constraint is only as deployable as the least careful writer of the column
 * it constrains.
 *
 * ## Why it is safe now
 *
 * The seed no longer touches `strategies` or `strategy_versions` at all -- `ensure()` creates the
 * strategy and the version the code declares, and refuses to proceed if a stored configuration has
 * drifted. Verified before writing this migration: the stale `trend-breakout` version was
 * deactivated by hand, the API was restarted, and it stayed inactive, leaving exactly one active
 * version for each of the five registered strategies.
 *
 * `IF NOT EXISTS` because the index may already be present on a database where 097 succeeded and was
 * never dropped -- a fresh deployment, for instance.
 *
 * Zero active versions remains permitted: `ai-autonomous-agent` is inactive by design (096), and
 * `ensure()`'s deactivate-then-activate passes through zero rather than through two.
 */
export const oneActiveStrategyVersionIndexMigration: Migration = {
  id: "098-one-active-strategy-version-index",
  sql: `
    /*
     * Guard rather than assume. If two versions of any strategy are still active, creating the index
     * would fail here -- inside the migration, where it is visible and recoverable -- rather than at
     * the first startup write, where it took the API down. The message names the offenders.
     */
    DO $$
    DECLARE
      offenders TEXT;
    BEGIN
      SELECT string_agg(strategy_key || ' (' || n || ' active)', ', ')
      INTO offenders
      FROM (
        SELECT s.strategy_key, count(*) AS n
        FROM strategy_versions sv
        JOIN strategies s ON s.id = sv.strategy_id
        WHERE sv.is_active
        GROUP BY s.strategy_key
        HAVING count(*) > 1
      ) x;

      IF offenders IS NOT NULL THEN
        RAISE EXCEPTION
          'Refusing to create the one-active-version index: % still has more than one active '
          'version. Deactivate all but the version the code declares first. Creating the index over '
          'this data is what crash-looped the API on 2026-09-03.', offenders;
      END IF;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS strategy_versions_one_active_per_strategy
      ON strategy_versions (strategy_id) WHERE is_active;

    COMMENT ON INDEX strategy_versions_one_active_per_strategy IS
      'At most one active version per strategy. is_active defaults to TRUE, so before migration 098 '
      'every writer that inserted a version left its predecessor active: seedMarketData forced '
      'trend-breakout version 1 active on every API startup, and ensure() never deactivated a '
      'predecessor. Both are fixed. Zero active is permitted -- the agent version is inactive by '
      'design and ensure() passes through zero rather than two. See migrations 097 and 098.';
  `,
};
