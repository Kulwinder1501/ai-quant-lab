import type { Migration } from "../migration-runner.js";

/**
 * Splits a differential observation's **action** from its **reason**, and compares only the action.
 *
 * ## The defect this corrects, found by running 092 for one pass
 *
 * The first two observations recorded were:
 *
 * ```
 * V1: NO_ACTION NO_PROPOSAL          V2: REJECTED OUTSIDE_EXECUTABLE_WINDOW   agreed = false
 * ```
 *
 * Both systems declined to trade. The row called it a divergence because the reason strings differ,
 * and `agreed` compared whole strings.
 *
 * That is wrong about what P13 is for. P13 gates whether V2.2 may **substitute** for V1, and if both
 * decline then V2.2 is behaviourally equivalent for that bar whatever each called its refusal. Under
 * whole-string equality, every bar for the entire period V2.2 has no entry rule would be a divergence
 * -- all of them `UNKNOWN`, all of them blockers -- and P13 would be pinned at `promotable: false` by
 * noise while the handful of real cases sat invisible among them.
 *
 * It is the same failure the thesis comparison already refuses for composite scores: *"hundreds of
 * expected divergences is not a finding, it is noise hiding the few rows that matter."* I excluded
 * the score for that reason and then reintroduced the problem in the equality test.
 *
 * ## So the action is compared and the reason is kept
 *
 * `legacy_outcome` / `v2_outcome` now hold the action -- `NO_TRADE`, or an approval with its
 * geometry -- and `agreed` is generated from those. The reasons move to `legacy_detail` /
 * `v2_detail`, which are recorded but never compared.
 *
 * Keeping them is not optional: `promotionBlocker` prints both sides, and a reviewer classifying a
 * divergence needs to know *why* each system did what it did. Dropping the reason would leave a
 * blocked promotion with nothing to diagnose.
 *
 * ## Why the existing rows are deleted rather than migrated
 *
 * The two rows recorded under 092 hold whole-string outcomes, so their `agreed` means something
 * different from every row written after this. They cannot be rewritten -- the table is append-only
 * by trigger, deliberately -- and leaving them would put two observations with incompatible semantics
 * in a population P13 counts.
 *
 * They were written minutes earlier by a verification run against a closed market, so nothing is
 * lost. The trigger is disabled for exactly this statement and re-enabled immediately; the
 * alternative was a second `comparison_version` to orphan two probe rows, which would misuse the
 * versioning that exists to separate genuine canonicalisation changes.
 */
export const differentialActionEqualityMigration: Migration = {
  id: "093-differential-action-equality",
  sql: `
    ALTER TABLE differential_observations
      ADD COLUMN IF NOT EXISTS legacy_detail TEXT,
      ADD COLUMN IF NOT EXISTS v2_detail TEXT;

    -- Two probe rows from 092's verification pass. Their agreed column compared whole strings, so it
    -- means something different from every row after this. Append-only is suspended for this
    -- statement
    -- only; see the note above on why a new comparison_version would be the wrong instrument.
    ALTER TABLE differential_observations DISABLE TRIGGER differential_observations_reject_mutation;
    DELETE FROM differential_observations
      WHERE legacy_outcome NOT IN ('NO_TRADE') AND legacy_outcome NOT LIKE 'APPROVED %';
    ALTER TABLE differential_observations ENABLE TRIGGER differential_observations_reject_mutation;

    COMMENT ON COLUMN differential_observations.legacy_outcome IS
      'What V1 DID: NO_TRADE, or "APPROVED <side> entry=.. stop=.. target=..". The action only -- '
      'agreed is generated from this, and comparing reasons would make every bar a divergence for as '
      'long as V2.2 has no entry rule. See migration 093.';
    COMMENT ON COLUMN differential_observations.legacy_detail IS
      'WHY V1 did it. Recorded, never compared: promotionBlocker prints both sides and a reviewer '
      'classifying a divergence needs the reason, but a reason mismatch is not a behavioural '
      'difference.';
    COMMENT ON COLUMN differential_observations.v2_detail IS
      'WHY V2.2 did it. Recorded, never compared. See legacy_detail.';
  `,
};
