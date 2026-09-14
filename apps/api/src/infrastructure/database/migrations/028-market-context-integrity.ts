import type { Migration } from "../migration-runner.js";

export const marketContextIntegrityMigration: Migration = {
  id: "028-market-context-integrity",
  sql: `
    ALTER TABLE institutional_flows
      ADD COLUMN IF NOT EXISTS source VARCHAR(80) NOT NULL DEFAULT 'NSE_CURRENT_API',
      ADD COLUMN IF NOT EXISTS is_provisional BOOLEAN NOT NULL DEFAULT TRUE;

    COMMENT ON COLUMN institutional_flows.source IS
      'Provenance of the stored print. Historical imports must retain their upstream source and may not masquerade as direct NSE collection.';
    COMMENT ON COLUMN institutional_flows.is_provisional IS
      'NSE cash-segment FII/DII activity is provisional and may be revised after custodial confirmation.';

    INSERT INTO instruments (
      exchange, symbol, display_name, instrument_type, tick_size, lot_size, is_active, metadata
    ) VALUES (
      'NSE', 'INDIAVIX', 'India VIX', 'INDEX', 0.01, 1, FALSE,
      '{"market":"India","canonicalName":"India VIX","purpose":"volatility-regime","yahooSymbol":"^INDIAVIX"}'::jsonb
    )
    ON CONFLICT (exchange, symbol) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      instrument_type = EXCLUDED.instrument_type,
      tick_size = EXCLUDED.tick_size,
      lot_size = EXCLUDED.lot_size,
      metadata = instruments.metadata || EXCLUDED.metadata;

    CREATE INDEX IF NOT EXISTS institutional_flows_source_date_idx
      ON institutional_flows (source, date DESC);
  `,
};
