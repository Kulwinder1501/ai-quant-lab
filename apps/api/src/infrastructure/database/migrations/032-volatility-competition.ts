import type { Migration } from "../migration-runner.js";

/**
 * Role state for the volatility-regime competition.
 *
 * A separate table from `model_competition_state`, not a new value in its role column.
 * That table's consumers read a PRIMARY as the directional call that drives the scanner,
 * strategies, and paper activity. A volatility PRIMARY authorises none of that — it
 * informs risk and regime context only — and the last time the two shared a pool a
 * volatility model was enrolled as PRIMARY of a BULLISH/BEARISH/NEUTRAL group it could
 * never score in. Separate tables make that mistake unrepresentable rather than merely
 * discouraged.
 *
 * `label_scheme` is stored even though this table currently serves one scheme, so a
 * second non-directional target does not need a migration to join.
 */
export const volatilityCompetitionMigration: Migration = {
  id: "032-volatility-competition",
  sql: `
    CREATE TABLE IF NOT EXISTS volatility_competition_state (
      model_version_id UUID PRIMARY KEY REFERENCES model_versions(id) ON DELETE CASCADE,
      label_scheme TEXT NOT NULL CHECK (length(trim(label_scheme)) > 0),
      -- CHALLENGER is the ranked runner-up, kept so the scoreboard can show who is
      -- next without implying it has any authority.
      role TEXT NOT NULL CHECK (role IN ('PRIMARY', 'CHALLENGER')),
      -- The clock that guards a role holder's predictions against backdating, exactly
      -- as model_competition_state.enrolled_at does for the directional pool.
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      became_primary_at TIMESTAMPTZ,
      -- Why the last decision landed this way, so a role change is auditable without
      -- re-deriving it from settled rows.
      last_decision_reason TEXT,
      last_decision_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- At most one PRIMARY per scheme. Enforced by the database rather than by the
    -- service that writes it: a bug that produced two would otherwise be silent, and
    -- risk consumers would read whichever row they happened to select.
    CREATE UNIQUE INDEX IF NOT EXISTS volatility_competition_single_primary_idx
    ON volatility_competition_state (label_scheme)
    WHERE role = 'PRIMARY';

    COMMENT ON TABLE volatility_competition_state IS
      'Role state for non-directional model competitions. A PRIMARY here informs risk and regime context only; it is never a trade direction.';
  `,
};
