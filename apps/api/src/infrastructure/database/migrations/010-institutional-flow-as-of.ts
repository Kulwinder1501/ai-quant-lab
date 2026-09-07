import type { Migration } from "../migration-runner.js";

// Institutional flows are published *after* the session they describe closes
// (NSE posts FII/DII around 18:30 IST for that same trading date). A feature
// keyed only on `date` therefore leaks: a candle closing at 15:30 IST on day D
// would read numbers that did not exist until three hours later.
//
// `published_at` is the same as-of discipline `candles.received_at` already
// carries, and it is what the ML loader filters on. Existing rows are backfilled
// to 18:30 IST on their own trading date, which is when they would in fact have
// become visible.
export const institutionalFlowAsOfMigration: Migration = {
  id: "010-institutional-flow-as-of",
  sql: `
    ALTER TABLE institutional_flows
      ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

    UPDATE institutional_flows
      SET published_at = (date + TIME '18:30') AT TIME ZONE 'Asia/Kolkata'
      WHERE published_at IS NULL;

    ALTER TABLE institutional_flows
      ALTER COLUMN published_at SET NOT NULL,
      ALTER COLUMN published_at SET DEFAULT NOW();

    ALTER TABLE offshore_derivatives
      ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

    UPDATE offshore_derivatives
      SET published_at = (date + TIME '18:30') AT TIME ZONE 'Asia/Kolkata'
      WHERE published_at IS NULL;

    ALTER TABLE offshore_derivatives
      ALTER COLUMN published_at SET NOT NULL,
      ALTER COLUMN published_at SET DEFAULT NOW();

    -- The collector previously wrote a hardcoded 0 close for GIFT Nifty whenever
    -- no real quote was available, which is indistinguishable from a genuine
    -- price. There is no such thing as a zero index print, so those rows are
    -- fabricated data and are removed; the collector no longer writes them.
    DELETE FROM offshore_derivatives WHERE close_price <= 0;

    -- Postgres has no ADD CONSTRAINT IF NOT EXISTS, and every other migration in
    -- this project is safe to replay, so the guard is explicit.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'offshore_derivatives_close_price_positive_chk'
      ) THEN
        ALTER TABLE offshore_derivatives
          ADD CONSTRAINT offshore_derivatives_close_price_positive_chk
          CHECK (close_price > 0);
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS institutional_flows_published_idx
      ON institutional_flows (published_at DESC, date DESC);

    CREATE INDEX IF NOT EXISTS offshore_derivatives_published_idx
      ON offshore_derivatives (instrument_id, published_at DESC, date DESC);
  `,
};
