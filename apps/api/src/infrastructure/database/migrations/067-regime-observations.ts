import type { Migration } from "../migration-runner.js";

/**
 * Append-only record of the market regime observed at decision time, plus a nullable pointer to it
 * from the trades opened on that observation.
 *
 * Both readings are derived from mutable inputs -- `candles` and `indicator_snapshots` get
 * backfilled and recomputed, and the model reading is filtered to whichever model is in PRODUCTION
 * now -- so re-deriving a past bar's regime months later answers a different question than the bot
 * answered at the time. This table makes that answer stable. It has no read path into execution.
 *
 * Nothing here can change trading behaviour: the column on `paper_trades` is nullable, no code
 * gates on it, and a failure to record an observation leaves the trade unstamped rather than
 * unopened. Existing trades keep a null pointer, which is honest -- the observation was not taken.
 *
 * Append-only is enforced by convention rather than a trigger: nothing in the codebase updates or
 * deletes these rows, and the unique key below makes a repeat observation of the same bar a no-op
 * instead of an overwrite. A first-writer-wins key is deliberate. Successive bot cycles inside one
 * five-minute bar re-read the same completed bar, and the reading that matters is the one that was
 * in hand when the bar was first acted on; last-writer-wins would quietly replace it with a later
 * one and make the record non-reproducible.
 *
 * Both regime columns are nullable because both sources return "unknown" as a real answer -- a gap
 * in the VIX series must not be recorded as a calm market. A row with both null is kept
 * deliberately: `completeness` says the market was observed and could not be classified, which is a
 * different fact from never having looked, and no `IS NULL` query could tell those apart otherwise.
 */
export const regimeObservationsMigration: Migration = {
  id: "067-regime-observations",
  sql: `
    CREATE TABLE IF NOT EXISTS regime_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      timeframe TEXT NOT NULL CHECK (length(trim(timeframe)) BETWEEN 2 AND 16),
      source_candle_id UUID REFERENCES candles(id) ON DELETE SET NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      volatility_regime TEXT CHECK (volatility_regime IN ('HIGH_VOL', 'LOW_VOL')),
      volatility_value_ratio NUMERIC(12, 6),
      model_regime TEXT CHECK (model_regime IN ('CONTRACTION', 'STABLE', 'EXPANSION')),
      model_confidence NUMERIC(5, 4) CHECK (model_confidence IS NULL OR (model_confidence >= 0 AND model_confidence <= 1)),
      model_evidence_cutoff_at TIMESTAMPTZ,
      completeness TEXT NOT NULL CHECK (completeness IN ('BOTH', 'VOLATILITY_ONLY', 'MODEL_ONLY', 'NEITHER')),
      provenance JSONB NOT NULL CHECK (jsonb_typeof(provenance) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- A label and its ratio travel together or not at all; half a reading is not a reading.
      CHECK ((volatility_regime IS NULL) = (volatility_value_ratio IS NULL)),
      -- The model reading is a triple. Its evidence boundary is what makes it point-in-time, so a
      -- prediction stored without one could not be audited against the clock that accepted it.
      CHECK (
        (model_regime IS NULL AND model_confidence IS NULL AND model_evidence_cutoff_at IS NULL)
        OR (model_regime IS NOT NULL AND model_confidence IS NOT NULL AND model_evidence_cutoff_at IS NOT NULL)
      ),
      -- The point-in-time guard, restated in the schema. The domain drops a future reading before it
      -- gets here; this makes it impossible for any other writer to bypass that.
      CHECK (model_evidence_cutoff_at IS NULL OR model_evidence_cutoff_at <= observed_at),
      -- Redundant with the columns, and that is the point: it is the one fact a query cannot
      -- reconstruct, since NULL means "observed, unclassifiable" here rather than "no row".
      CHECK (
        completeness = (CASE
          WHEN volatility_regime IS NOT NULL AND model_regime IS NOT NULL THEN 'BOTH'
          WHEN volatility_regime IS NOT NULL THEN 'VOLATILITY_ONLY'
          WHEN model_regime IS NOT NULL THEN 'MODEL_ONLY'
          ELSE 'NEITHER'
        END)
      )
    );

    -- One observation per bar per series. Partial, because an observation not taken on a bar has no
    -- natural key and must not collapse with others: NULLs would not conflict in a plain unique
    -- index, but a partial index states the intent rather than relying on that.
    CREATE UNIQUE INDEX IF NOT EXISTS regime_observations_bar_idx
      ON regime_observations (instrument_id, timeframe, source_candle_id)
      WHERE source_candle_id IS NOT NULL;

    -- The research access path: regime over time for one series.
    CREATE INDEX IF NOT EXISTS regime_observations_series_idx
      ON regime_observations (instrument_id, timeframe, observed_at DESC);

    ALTER TABLE paper_trades
      ADD COLUMN IF NOT EXISTS regime_observation_id UUID
      REFERENCES regime_observations(id) ON DELETE SET NULL;

    COMMENT ON COLUMN paper_trades.regime_observation_id IS
      'The regime observed when this trade was opened. Audit and research only: no execution path reads it, and a null means the observation was not recorded rather than that the market had no regime.';

    -- Serves the question the table exists for: outcomes grouped by the regime they were opened in.
    CREATE INDEX IF NOT EXISTS paper_trades_regime_observation_idx
      ON paper_trades (regime_observation_id)
      WHERE regime_observation_id IS NOT NULL;
  `,
};
