import type { Migration } from "../migration-runner.js";

/**
 * G2 of the Gold Bot & Option Scalper spec: the persistence `audit-gold-shadow-failures.ts` has
 * always been written against but never had. `select to_regclass('public.shadow_decisions')`
 * returned NULL on the live database as of 2026-10-05 -- see
 * `gold-shadow-audit-availability.ts`'s docstring for the full investigation, including why
 * `decision_ledger`/`differential_observations` (Brain V2.2's unrelated, NSE-only shadow-decision
 * pipeline) is not a substitute: it carries none of the fields this table exists to hold
 * (`protectedStatusAtCutoff`, `swingHierarchyPresent`, `sessionDateMismatch`, `staleMacroTarget`),
 * which previously lived only inside `ict-structure-strategy.ts`'s in-memory `evaluate()` call and
 * were never persisted anywhere.
 *
 * ## What a row records
 *
 * One row per (account, strategy, bar): `generate-trade-ideas.ts` evaluates `ict-structure-v1`
 * against the latest completed candle on every scheduler tick, and the engine's own causal state
 * (`IctStateCompositeSnapshot`) does not change again until the next bar closes. Re-evaluating the
 * same bar on a later tick (the scheduler runs more often than XAU_USD's 5m/15m bars close) must
 * not create a second row for it, so `source_candle_id` is part of the row's identity rather than
 * merely a reference -- `shadow_decisions_one_per_bar` is the idempotency boundary, the same role
 * `entry_id` plays in migration 107 and `trade_idea_id` plays in `candidate_settlements` (068).
 *
 * `strategy_metadata` carries the `IctShadowDiagnostics` object (see
 * `ict-shadow-diagnostics.ts`) computed AT WRITE TIME, not re-derived later from a replayed
 * engine -- `audit-gold-shadow-failures.ts` reads these flags back out rather than replaying
 * anything, which is both simpler and more PIT-safe (no risk of a later engine version silently
 * answering a different question than the one asked at decision time).
 *
 * ## Why no append-only trigger
 *
 * Unlike `candidate_dataset_entries` (migration 107) or `differential_observations`, this is a
 * decision log in the same spirit as `candidate_decisions` (migration 068), which also carries no
 * such trigger -- a row here is an audit record of what the strategy observed and decided, not a
 * frozen research dataset entry with its own content-addressed identity. `ON CONFLICT DO NOTHING`
 * already makes accidental overwrite impossible in practice; a trigger would only guard against a
 * deliberate UPDATE, which nothing in this codebase has a reason to issue.
 */
export const shadowDecisionsMigration: Migration = {
  id: "123-shadow-decisions",
  sql: `
    CREATE TABLE IF NOT EXISTS shadow_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id UUID NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
      strategy_key TEXT NOT NULL CHECK (length(trim(strategy_key)) > 0),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      timeframe TEXT NOT NULL CHECK (length(trim(timeframe)) BETWEEN 2 AND 16),
      source_candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      evaluated_at TIMESTAMPTZ NOT NULL,
      proposal_count INTEGER NOT NULL CHECK (proposal_count >= 0),
      decision TEXT NOT NULL CHECK (decision IN ('EXECUTED', 'REFUSED', 'NO_SIGNAL')),
      -- IctShadowDiagnostics and whatever generated it (engineVersion/configHash/barTime). Not
      -- CHECK-constrained the way candidate_dataset_entries' closed unions are: this shape is
      -- expected to grow as new diagnostics are added, and a CHECK here would turn every addition
      -- into a migration for no safety benefit -- there is no second writer to constrain against.
      context_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      strategy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT shadow_decisions_one_per_bar UNIQUE (account_id, strategy_key, source_candle_id)
    );

    -- The G2 audit's own access path: one account's decisions for one strategy, oldest first.
    CREATE INDEX IF NOT EXISTS shadow_decisions_account_strategy_idx
      ON shadow_decisions (account_id, strategy_key, evaluated_at ASC);

    -- Secondary access path: every shadow decision for an instrument/timeframe, newest first.
    CREATE INDEX IF NOT EXISTS shadow_decisions_instrument_idx
      ON shadow_decisions (instrument_id, timeframe, evaluated_at DESC);

    COMMENT ON TABLE shadow_decisions IS
      'G2: one row per (account, strategy, bar) evaluation, carrying the ict-structure failure '
      'taxonomy (protectedStatusAtCutoff, swingHierarchyPresent, sessionDateMismatch, '
      'staleMacroTarget) in strategy_metadata. Read by audit-gold-shadow-failures.ts. See '
      'migration 123''s own header comment for why source_candle_id is part of the row identity.';
  `,
};
