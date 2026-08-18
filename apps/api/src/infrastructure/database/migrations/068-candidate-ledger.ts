import type { Migration } from "../migration-runner.js";

/**
 * The counterfactual ledger: what each account decided about every candidate, and what the candidate
 * went on to do.
 *
 * `trade_ideas` already records every candidate and `trade_reviews` already records the geometry of
 * trades that were *taken*. The gap is the ones that were not, and it is a large gap: 97 candidates a
 * day against 61 closed trades in the system's whole history. Nothing recorded why the rest were
 * declined, or whether declining them was right.
 *
 * ## Why the decision half matters more than it looks
 *
 * Every refusal reason -- NO_FRESH_EXECUTABLE_QUOTE, OPTIONS_ENTRY_REJECTED, ALREADY_HOLDING,
 * POSITION_LIMIT, RISK_CONTROL_VETO, TRADE_IDEA_ALREADY_TAKEN -- existed only in the scheduler's
 * container log, which rotates. The reason a signal was passed over is precisely the "what did we get
 * wrong" data, and it was being destroyed daily.
 *
 * A decision is keyed on **(candidate, account)** rather than on the candidate. Since 2026-08-18 two
 * accounts can legitimately act on one idea and decide differently, and that difference is the
 * comparison the dual-bot sandbox exists to make.
 *
 * ## Index space, deliberately
 *
 * Settlement resolves the idea's own geometry, which is in **index** space. The executed option trade
 * overrides stop and target into **premium** space, so `trade_reviews.realized_r` is not comparable
 * to `candidate_settlements.r_multiple` and the two must not be joined into one hit rate. This ledger
 * answers "was the signal right about the index", not "would the trade have made money". Naming it
 * `r_multiple` rather than borrowing `realized_r` is the reminder.
 *
 * ## Nothing here is read at decision time
 *
 * Both tables are append-only and no execution path consults either. A failure to write a decision or
 * a settlement leaves trading untouched.
 */
export const candidateLedgerMigration: Migration = {
  id: "068-candidate-ledger",
  sql: `
    CREATE TABLE IF NOT EXISTS candidate_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trade_idea_id UUID NOT NULL REFERENCES trade_ideas(id) ON DELETE CASCADE,
      account_id UUID NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
      decided_at TIMESTAMPTZ NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('EXECUTED', 'REFUSED')),
      -- The refusal code, or 'OPENED'. Not constrained to an enum: the reason set is owned by the
      -- executors and grows, and a CHECK here would turn adding a refusal into a migration.
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      explanation TEXT NOT NULL DEFAULT '',
      paper_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL,
      regime_observation_id UUID REFERENCES regime_observations(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    COMMENT ON COLUMN candidate_decisions.paper_trade_id IS
      'The position this decision opened, when it was EXECUTED. Nullable even then: the reference is ON DELETE SET NULL, so a deleted trade must not be able to wedge an append-only row.';

    -- Deliberately not unique on (trade_idea_id, account_id). The bot re-evaluates a live candidate on
    -- every cycle, so one idea legitimately draws several decisions, and "refused fifteen times for
    -- the same reason" says the signal persisted -- which a deduplicated row would erase.
    CREATE INDEX IF NOT EXISTS candidate_decisions_idea_idx
      ON candidate_decisions (trade_idea_id);
    CREATE INDEX IF NOT EXISTS candidate_decisions_account_idx
      ON candidate_decisions (account_id, decided_at DESC);
    -- The question this table exists to answer: which reasons dominate, and did that change.
    CREATE INDEX IF NOT EXISTS candidate_decisions_reason_idx
      ON candidate_decisions (reason, decided_at DESC);

    CREATE TABLE IF NOT EXISTS candidate_settlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      trade_idea_id UUID NOT NULL UNIQUE REFERENCES trade_ideas(id) ON DELETE CASCADE,
      -- UNSETTLEABLE is a first-class verdict, not an absent row. Missing bars must never be recorded
      -- as "the target was not reached": the series here has a history of silent truncation, and a
      -- fabricated STOP is worse than an admitted gap.
      outcome TEXT NOT NULL CHECK (outcome IN ('TARGET', 'STOP', 'UNRESOLVED', 'UNSETTLEABLE')),
      r_multiple NUMERIC(12, 6),
      bars_to_resolution INTEGER CHECK (bars_to_resolution IS NULL OR bars_to_resolution > 0),
      -- Measured only over the bars up to resolution. Over the full horizon a stopped-out candidate
      -- would report favourable movement the position would never have been alive to see.
      mae_r NUMERIC(12, 6) CHECK (mae_r IS NULL OR mae_r >= 0),
      mfe_r NUMERIC(12, 6) CHECK (mfe_r IS NULL OR mfe_r >= 0),
      horizon_end TIMESTAMPTZ NOT NULL,
      resolved_timeframe TEXT NOT NULL CHECK (length(trim(resolved_timeframe)) BETWEEN 2 AND 16),
      bars_available INTEGER NOT NULL CHECK (bars_available >= 0),
      -- Stamped so a later change to the shared resolver is visible as a version break rather than as
      -- a drift in the hit rate.
      resolver_version TEXT NOT NULL CHECK (length(trim(resolver_version)) > 0),
      settled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- A resolved barrier carries both its multiple and the bar it resolved on.
      CONSTRAINT candidate_settlements_resolved_complete CHECK (
        outcome NOT IN ('TARGET', 'STOP')
        OR (r_multiple IS NOT NULL AND bars_to_resolution IS NOT NULL)
      ),
      -- An unresolved or unsettleable candidate has neither.
      CONSTRAINT candidate_settlements_unresolved_empty CHECK (
        outcome IN ('TARGET', 'STOP')
        OR (r_multiple IS NULL AND bars_to_resolution IS NULL)
      ),
      -- Nothing can be measured from no bars, so an unsettleable row has no excursions either.
      CONSTRAINT candidate_settlements_unsettleable_has_no_excursions CHECK (
        outcome <> 'UNSETTLEABLE' OR (mae_r IS NULL AND mfe_r IS NULL)
      ),
      -- Half an excursion pair is not a measurement.
      CONSTRAINT candidate_settlements_excursions_together CHECK ((mae_r IS NULL) = (mfe_r IS NULL))
    );

    -- The research access path: outcomes over time, and the sweep's own "already settled?" check is
    -- served by the UNIQUE above.
    CREATE INDEX IF NOT EXISTS candidate_settlements_outcome_idx
      ON candidate_settlements (outcome, horizon_end DESC);

    -- The sweep selects candidates whose horizon has elapsed and which have no settlement yet. Without
    -- this it degrades into a full scan of trade_ideas as the table grows.
    CREATE INDEX IF NOT EXISTS trade_ideas_expiry_idx
      ON trade_ideas (expires_at)
      WHERE expires_at IS NOT NULL;
  `,
};
