import type { Migration } from "../migration-runner.js";

/**
 * Stamps `evidence_policy_version` on every study trial, closing Gate A7 / Gap 6.
 *
 * ## Why the grade alone is not enough
 *
 * `study_trials.evidence_state` is frozen before a result is computed, so the governance label cannot
 * be chosen after seeing the outcome. But nothing recorded *which* boundaries produced it. The day
 * 5 / 20 / 60 change, all 180 stored grades silently become ambiguous -- unreadable in exactly the way
 * a control point would be if `controlPolicyVersion` were not stored beside it.
 *
 * `evidencePolicyVersion` in `study-registry.ts` carries the obligation: if any boundary changes, the
 * version changes with it. Storing it here is what makes a stored grade self-describing.
 *
 * ## Backfilling is honest here, unlike migration 089
 *
 * Every existing row was graded by the boundaries that are still in force -- 5 / 20 / 60 are unchanged
 * by this migration -- so writing `EVIDENCE_POLICY_V1` onto them states a fact. That is the opposite
 * of `underlying_exit_price`, which was deliberately left unbackfilled because a reconstructed value
 * would have been indistinguishable from an observed one. A version label is a statement about which
 * code ran; a price is a claim about the market.
 *
 * ## ADD DEFAULT then DROP DEFAULT, because the table is append-only
 *
 * `study_trials` carries `study_trials_reject_mutation`, so an `UPDATE ... SET` backfill would be
 * refused by its own trigger -- correctly, since the table is a research record. `ADD COLUMN ... NOT
 * NULL DEFAULT` fills existing rows through the catalog without an UPDATE, so no row trigger fires.
 *
 * The default is then dropped immediately, and that is the load-bearing half: leaving it would let a
 * future insert acquire a version it never declared, which is the same silent-provenance failure this
 * migration exists to fix. After the drop, `declareTrials` must supply the value explicitly or the
 * NOT NULL rejects the row.
 *
 * Verified on the live database inside a rolled-back transaction: 180 of 180 rows stamped, default
 * confirmed absent afterwards.
 *
 * Idempotent: `ADD COLUMN IF NOT EXISTS`, and dropping an already-absent default is a no-op.
 */
export const studyTrialEvidencePolicyMigration: Migration = {
  id: "091-study-trial-evidence-policy",
  sql: `
    ALTER TABLE research_scalp.study_trials
      ADD COLUMN IF NOT EXISTS evidence_policy_version TEXT NOT NULL
        DEFAULT 'EVIDENCE_POLICY_V1';

    ALTER TABLE research_scalp.study_trials
      ALTER COLUMN evidence_policy_version DROP DEFAULT;

    COMMENT ON COLUMN research_scalp.study_trials.evidence_policy_version IS
      'Which evidence boundaries produced evidence_state, from evidencePolicyVersion in '
      'study-registry.ts. Frozen with the grade, before any result is computed. Rows under '
      'different versions were graded by different session boundaries and are NOT directly '
      'comparable. Has no column default on purpose: an insert must declare its version rather '
      'than acquire one silently. See migration 091.';
  `,
};
