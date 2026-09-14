import type { Migration } from "../migration-runner.js";

export const institutionalFlowsAndOffshoreMigration: Migration = {
  id: "007-institutional-flows-and-offshore",
  sql: `
    CREATE TABLE IF NOT EXISTS institutional_flows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      date DATE NOT NULL UNIQUE,
      fii_cash_net_cr NUMERIC,
      dii_cash_net_cr NUMERIC,
      fii_index_futures_net_cr NUMERIC,
      fii_index_options_net_cr NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS offshore_derivatives (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id VARCHAR(50) NOT NULL,
      date DATE NOT NULL,
      close_price NUMERIC NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (instrument_id, date)
    );
  `,
};
