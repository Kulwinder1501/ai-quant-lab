import type { Migration } from "../migration-runner.js";

// Makes "one provider per candle series" a database constraint, and moves 15m to Fyers.
//
// The rule already existed as prose in `fyers-historical-data-provider.ts`: the provenance
// split is by timeframe "so that no single series is ever half Fyers and half Yahoo -- a
// train/serve skew that would be invisible at the data layer." `collect-historical-data.ts`
// enforced it, but only there. Seeds, the scheduler and any other writer went straight to
// `candles`, and the rule was broken in exactly the way it warned about:
//
//   NIFTY50 15m  fyers-api-v3  21,102 bars  2023-01-02 -> 2026-06-05   27% with volume
//   NIFTY50 15m  yahoo          1,069 bars  2026-06-08 -> 2026-08-05    0% with volume
//
// One series, two providers, handing over on 2026-06-08, with volume dropping to zero across
// the seam. A 15m volume feature on that series has a provider-driven break there.
//
// A per-row check in the repository would mean a lookup per candle on a 300k-bar backfill, so
// this is a declaration table plus a foreign key instead: `candle_series_provenance` names the
// one permitted source per (instrument, timeframe), and `candles` references it. Postgres then
// refuses a mismatched row on every write path at no per-row cost, and reassigning ownership
// means updating the declaration -- which the key blocks until the old rows are gone. The
// purge-then-backfill discipline stops being something to remember.
//
// 15m moves to Fyers because that is where the seam and the missing index volume are. Yahoo
// serves 15m equities with full volume but only ~2 months of history, and no index volume at
// all; Fyers serves both natively and reaches back years. The Yahoo 15m rows are deleted here
// rather than overwritten because the upsert's `WHERE candles.is_complete = FALSE` means a
// backfill cannot replace a complete row.
//
// INDIAVIX stays Yahoo across every timeframe, as the CLI already documented: its 1m/5m/15m
// series has only ever been Yahoo-sourced and the INDIA_VIX_INTRADAY job keeps collecting it
// that way, so re-sourcing it would itself be the mix this forbids.
export const candleSeriesProvenanceMigration: Migration = {
  id: "043-candle-series-provenance",
  sql: `
    CREATE TABLE IF NOT EXISTS candle_series_provenance (
      instrument_id UUID        NOT NULL REFERENCES instruments (id) ON DELETE CASCADE,
      timeframe     TEXT        NOT NULL,
      source        TEXT        NOT NULL,
      declared_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (instrument_id, timeframe)
    );

    -- The composite the candles key points at. The primary key already forbids two sources
    -- for one series; this is what makes it referenceable.
    CREATE UNIQUE INDEX IF NOT EXISTS candle_series_provenance_target_idx
      ON candle_series_provenance (instrument_id, timeframe, source);

    -- 15m becomes Fyers-owned, so the Yahoo 15m rows go. Everything except INDIAVIX, which
    -- is Yahoo for every timeframe.
    DELETE FROM candles
    WHERE timeframe = '15m'
      AND source = 'yahoo'
      AND instrument_id NOT IN (SELECT id FROM instruments WHERE upper(symbol) = 'INDIAVIX');

    -- Declare ownership for every series that has rows, from the policy rather than from
    -- whatever happens to be stored: seeding from the data would enshrine a mix as correct.
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT DISTINCT
      c.instrument_id,
      c.timeframe,
      CASE
        WHEN upper(i.symbol) = 'INDIAVIX' THEN 'yahoo'
        WHEN c.timeframe IN ('1m', '3m', '5m', '10m', '15m') THEN 'fyers-api-v3'
        ELSE 'yahoo'
      END
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    ON CONFLICT (instrument_id, timeframe) DO NOTHING;

    -- Also declare 15m for the instruments whose Yahoo rows were just removed, so the Fyers
    -- backfill has a parent row to reference. Without this the key would reject every insert
    -- into a series that is legitimately empty and awaiting collection.
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT DISTINCT c.instrument_id, '15m', 'fyers-api-v3'
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    WHERE upper(i.symbol) <> 'INDIAVIX'
    ON CONFLICT (instrument_id, timeframe) DO NOTHING;

    -- Any row still disagreeing with its declaration would block the key. There should be
    -- none; deleting is safer than failing the migration, and the count is recoverable from
    -- the provider either way.
    DELETE FROM candles c
    USING candle_series_provenance p
    WHERE p.instrument_id = c.instrument_id
      AND p.timeframe = c.timeframe
      AND p.source <> c.source;

    ALTER TABLE candles DROP CONSTRAINT IF EXISTS candles_series_provenance_fkey;
    ALTER TABLE candles
      ADD CONSTRAINT candles_series_provenance_fkey
      FOREIGN KEY (instrument_id, timeframe, source)
      REFERENCES candle_series_provenance (instrument_id, timeframe, source);

    COMMENT ON TABLE candle_series_provenance IS
      'The one provider permitted per (instrument, timeframe). candles references it, so a second provider in one series is rejected by the database on every write path. To reassign: delete that series'' candles, then update this row.';
  `,
};
