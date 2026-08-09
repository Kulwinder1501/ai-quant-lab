import type { Migration } from "../migration-runner.js";

export const addVolatilityIndicesMigration: Migration = {
  id: "051-add-volatility-indices",
  sql: `
    INSERT INTO instruments (exchange, symbol, display_name, instrument_type, tick_size, lot_size, is_active, metadata)
    VALUES
      ('NSE', 'FINNIFTY',   'Nifty Financial Services', 'INDEX', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'MIDCPNIFTY', 'Nifty Midcap Select',      'INDEX', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb),
      ('NSE', 'NIFTYNXT50', 'Nifty Next 50',            'INDEX', 0.05, 1, FALSE, '{"purpose":"ml-training-breadth"}'::jsonb)
    ON CONFLICT (exchange, symbol) DO NOTHING;
  `,
};
