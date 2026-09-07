import type { Migration } from "../migration-runner.js";

/**
 * Stores the inferential object a trial's verdict was actually read from.
 *
 * `curve` and `common_eligible_curve` hold per-horizon estimates, and under `POINTWISE_INTERVAL_V1` the
 * verdict came straight out of them. Under `SIMULTANEOUS_DAY_MAXT_V1` it does not: the authority is a
 * single band over the whole ladder, carrying a critical value, the common-support day set it was
 * resampled from, and the horizons excluded before resampling. None of that fits in an array of horizon
 * rows, and folding it in would leave the one number the claim rests on — the critical value —
 * unrecorded.
 *
 * Nullable, and null is meaningful rather than missing: it marks a trial whose verdict came from
 * pointwise intervals. The two methodologies stay distinguishable in the ledger without a second table.
 */
export const scalpResearchTrialInferenceMigration: Migration = {
  id: "083-scalp-research-trial-inference",
  sql: `
    ALTER TABLE research_scalp.study_trial_results
      ADD COLUMN IF NOT EXISTS inference JSONB
        CHECK (inference IS NULL OR jsonb_typeof(inference) = 'object');

    COMMENT ON COLUMN research_scalp.study_trial_results.inference IS
      'The inferential object the verdict was read from, e.g. a SIMULTANEOUS_DAY_MAXT_V1 band. Null '
      'means the verdict came from pointwise intervals.';
  `,
};
