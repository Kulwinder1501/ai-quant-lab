import type { Migration } from "../migration-runner.js";

/**
 * The execution ledger: what was actually run, against which data and which code.
 *
 * Migration 080 records what was *predeclared*. This records what was *examined*, and the pair is what
 * the deflated-Sharpe and probability-of-backtest-overfitting corrections consume. A predeclared study
 * with no execution record cannot be corrected for, because the number of configurations looked at is
 * unknown.
 *
 * ## Two tables, because the schema is append-only
 *
 * `research_scalp` forbids UPDATE, so a trial cannot carry a mutable status column. Instead a trial is
 * *declared* before anything is computed and its result is written afterwards as a separate row. That
 * gives the property the design needs for free:
 *
 *   trial row + result row  =  a completed, accountable trial
 *   trial row, no result    =  a trial that started and did not finish
 *
 * The second state is visible rather than absent, which is the whole point. Under a
 * compute-then-log design a crash between computation and the write leaves an examined configuration
 * with no record at all, and the trial count silently understates the search. Here the runner must
 * insert the declaration first and abort if it cannot, so an unrecorded trial is not reachable.
 *
 * ## Why the grouping cell is the unit
 *
 * One row per (cohort, instrument, timeframe, direction) rather than one per study execution. G1 has no
 * free parameter — the horizon ladder is frozen — but examining twenty curves and reporting the one
 * that peaks most cleanly is twenty configurations examined, not one. Counting executions instead of
 * cells would undercount the search by exactly the factor that matters.
 *
 * `dataset_cutoff` is frozen in the declaration for the same reason: it is the boundary nothing later
 * may be read past, and recording it after the fact would let it follow the data.
 */
export const scalpResearchStudyTrialsMigration: Migration = {
  id: "081-scalp-research-study-trials",
  sql: `
    CREATE TABLE IF NOT EXISTS research_scalp.study_trials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trial_key CHAR(64) NOT NULL UNIQUE CHECK (trial_key ~ '^[0-9a-f]{64}$'),
      -- Groups every cell examined by one invocation, so a run can be read as a whole.
      run_key CHAR(64) NOT NULL CHECK (run_key ~ '^[0-9a-f]{64}$'),
      study_key TEXT NOT NULL
        REFERENCES research_scalp.study_registrations(study_key) ON DELETE RESTRICT,
      -- Carried alongside the key so a trial states which *version* of the study it ran, and a later
      -- reader does not have to trust that the registration was never superseded.
      study_definition_hash CHAR(64) NOT NULL CHECK (study_definition_hash ~ '^[0-9a-f]{64}$'),
      -- Content hash of the source files that produce the result. The registration hash covers declared
      -- policy only; this is what makes "the implementation is unchanged" a checkable claim rather than
      -- an assumption.
      code_version CHAR(64) NOT NULL CHECK (code_version ~ '^[0-9a-f]{64}$'),
      cohort_key TEXT NOT NULL CHECK (length(trim(cohort_key)) > 0),
      instrument_symbol TEXT NOT NULL CHECK (length(trim(instrument_symbol)) > 0),
      timeframe TEXT NOT NULL CHECK (length(trim(timeframe)) > 0),
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      parameter_family TEXT NOT NULL CHECK (length(trim(parameter_family)) > 0),
      parameter_values JSONB NOT NULL CHECK (jsonb_typeof(parameter_values) = 'object'),
      -- Nothing after this instant may be read. Frozen here so it cannot follow the data.
      dataset_cutoff TIMESTAMPTZ NOT NULL,
      session_range_start TEXT NOT NULL CHECK (session_range_start ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      session_range_end TEXT NOT NULL CHECK (session_range_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      session_count INTEGER NOT NULL CHECK (session_count >= 0),
      -- Frozen pre-computation, so the governance label cannot be chosen after seeing the result.
      evidence_state TEXT NOT NULL CHECK (evidence_state IN
        ('EARLY_DIAGNOSTIC', 'PROVISIONAL', 'RESEARCH_USABLE', 'STRONGER_VALIDATION')),
      subjects_declared INTEGER NOT NULL CHECK (subjects_declared >= 0),
      declared_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS research_scalp_study_trials_run_idx
      ON research_scalp.study_trials (study_key, run_key, declared_at);

    CREATE TABLE IF NOT EXISTS research_scalp.study_trial_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      result_key CHAR(64) NOT NULL UNIQUE CHECK (result_key ~ '^[0-9a-f]{64}$'),
      trial_key CHAR(64) NOT NULL UNIQUE
        REFERENCES research_scalp.study_trials(trial_key) ON DELETE RESTRICT,
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      subjects_examined INTEGER NOT NULL CHECK (subjects_examined >= 0),
      -- The available-case curve: every subject legally eligible at each horizon.
      curve JSONB NOT NULL CHECK (jsonb_typeof(curve) = 'array'),
      -- The same ladder restricted to subjects eligible and complete at every horizon. Reported beside
      -- the first because horizon eligibility falls through a session, so an available-case curve can
      -- show apparent decay that is purely session composition.
      common_eligible_curve JSONB NOT NULL CHECK (jsonb_typeof(common_eligible_curve) = 'array'),
      verdict TEXT NOT NULL CHECK (length(trim(verdict)) > 0),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    DO $$
    DECLARE target TEXT;
    BEGIN
      FOREACH target IN ARRAY ARRAY['study_trials', 'study_trial_results'] LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgname = target || '_reject_mutation'
            AND tgrelid = ('research_scalp.' || target)::regclass
        ) THEN
          EXECUTE format(
            'CREATE TRIGGER %I_reject_mutation BEFORE UPDATE OR DELETE ON research_scalp.%I '
            || 'FOR EACH ROW EXECUTE FUNCTION research_scalp.reject_mutation()',
            target, target
          );
        END IF;
      END LOOP;
    END;
    $$;

    COMMENT ON TABLE research_scalp.study_trials IS
      'Declared before computation. A trial with no result row is a trial that did not finish.';
  `,
};
