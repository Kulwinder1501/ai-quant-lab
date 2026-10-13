import type { Migration } from "../migration-runner.js";

// A shadow ledger for ICT sweep -> MSS -> retrace variants. Records what a variant would have
// proposed, then what following its bracket would have returned. It holds no account and no order:
// nothing here can open a position, and nothing that trades reads it.
//
// One row per (variant, instrument, timeframe, source candle, side), so re-evaluating a bar on a
// later tick cannot create a second row. The outcome columns are filled by a separate resolver and
// stay NULL while the bracket is still running; a settled row is never rewritten.
export const ictShadowSignalsMigration: Migration = {
  id: "135-ict-shadow-signals",
  sql: `
    CREATE TABLE IF NOT EXISTS ict_shadow_signals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      variant VARCHAR(60) NOT NULL,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      timeframe VARCHAR(8) NOT NULL,
      source_candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE CASCADE,
      bar_close_time TIMESTAMPTZ NOT NULL,
      side VARCHAR(5) NOT NULL CHECK (side IN ('LONG', 'SHORT')),
      entry_price NUMERIC(20, 6) NOT NULL,
      stop_loss NUMERIC(20, 6) NOT NULL,
      target_price NUMERIC(20, 6) NOT NULL,
      risk_reward NUMERIC(10, 4) NOT NULL,
      setup_id TEXT,
      -- The daily and higher-timeframe bias the live strategy actually saw, and whether this
      -- signal agrees with each. A counter-bias signal has bias_aligned = FALSE.
      bias VARCHAR(10) NOT NULL,
      htf_bias VARCHAR(10),
      bias_aligned BOOLEAN NOT NULL,
      htf_aligned BOOLEAN NOT NULL,
      -- Whether the unmodified live strategy proposed the same side on this bar.
      live_would_fire BOOLEAN NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      outcome VARCHAR(16) CHECK (outcome IN ('TARGET', 'STOP', 'SESSION_END', 'UNMEASURABLE')),
      r_multiple NUMERIC(10, 4),
      mae_r NUMERIC(10, 4),
      mfe_r NUMERIC(10, 4),
      minutes_to_resolution INTEGER,
      resolved_at TIMESTAMPTZ,
      resolver_version VARCHAR(60),
      CONSTRAINT ict_shadow_signals_one_per_bar UNIQUE (variant, instrument_id, timeframe, source_candle_id, side)
    );

    CREATE INDEX IF NOT EXISTS ict_shadow_signals_unresolved_idx
      ON ict_shadow_signals (bar_close_time) WHERE outcome IS NULL;
    CREATE INDEX IF NOT EXISTS ict_shadow_signals_variant_idx
      ON ict_shadow_signals (variant, instrument_id, timeframe, bar_close_time DESC);
  `,
};
