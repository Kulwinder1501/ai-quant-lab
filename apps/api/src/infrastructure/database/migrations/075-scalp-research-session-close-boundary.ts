import type { Migration } from "../migration-runner.js";

/** A decision exactly at the close is recordable; all of its forward horizons are ineligible. */
export const scalpResearchSessionCloseBoundaryMigration: Migration = {
  id: "075-scalp-research-session-close-boundary",
  sql: `
    ALTER TABLE research_scalp.opportunities
      DROP CONSTRAINT IF EXISTS opportunities_check,
      ADD CONSTRAINT opportunities_session_close_not_before_decision
        CHECK (session_close_at >= canonical_decision_at);

    ALTER TABLE research_scalp.control_points
      DROP CONSTRAINT IF EXISTS control_points_check,
      ADD CONSTRAINT control_points_session_close_not_before_decision
        CHECK (session_close_at >= decision_at);

    ALTER TABLE research_scalp.risk_subjects
      DROP CONSTRAINT IF EXISTS risk_subjects_check,
      ADD CONSTRAINT risk_subjects_session_close_not_before_decision
        CHECK (session_close_at >= decision_at);
  `,
};
