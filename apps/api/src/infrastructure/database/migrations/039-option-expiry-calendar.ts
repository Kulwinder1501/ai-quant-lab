import type { Migration } from "../migration-runner.js";

// Stores which option contracts each underlying actually lists.
//
// Migration 038 corrected the weekly-expiry weekdays against the provider's calendar, which
// stops a phantom expiry being *derived*. It does nothing about one being *supplied*: the
// open-trade route requires an explicit `expiryDate` and, until this table exists, had
// nothing to check it against. That is precisely how a BANKNIFTY 2026-08-04 contract -- an
// expiry that underlying does not carry, since it has no weekly series -- was traded twice.
//
// The chain client already parses the provider's full expiry list out of the response header
// on every collection and then discarded it. Persisting it costs nothing extra at the API and
// turns "is this a real contract?" from a question nobody could answer into a lookup.
//
// Rows are an observation, not a current-state cache: each collection writes the list as seen
// at that instant, so a later question about what was listed on a past date has an answer.
// `ON CONFLICT DO NOTHING` against the identity index makes a re-run inside one observation
// idempotent, matching option_chain_snapshots.
export const optionExpiryCalendarMigration: Migration = {
  id: "039-option-expiry-calendar",
  sql: `
    CREATE TABLE IF NOT EXISTS option_expiry_calendar (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      underlying_symbol TEXT        NOT NULL,
      provider          TEXT        NOT NULL,
      observed_at       TIMESTAMPTZ NOT NULL,
      expiry_date       DATE        NOT NULL,
      expiry_kind       TEXT        NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE option_expiry_calendar DROP CONSTRAINT IF EXISTS option_expiry_calendar_kind_check;
    ALTER TABLE option_expiry_calendar
      ADD CONSTRAINT option_expiry_calendar_kind_check
      CHECK (expiry_kind IN ('WEEKLY', 'MONTHLY'));

    -- One row per contract per observation. Two flags for the same expiry in one observation
    -- would mean the provider contradicted itself, and the write should fail rather than pick.
    CREATE UNIQUE INDEX IF NOT EXISTS option_expiry_calendar_identity_idx
      ON option_expiry_calendar (underlying_symbol, observed_at, expiry_date);

    -- The read is always "the newest calendar for this underlying".
    CREATE INDEX IF NOT EXISTS option_expiry_calendar_latest_idx
      ON option_expiry_calendar (underlying_symbol, observed_at DESC);

    COMMENT ON TABLE option_expiry_calendar IS
      'Expiries the provider lists per underlying, as observed. Checked before pricing a caller-supplied expiry, so a contract that does not trade cannot be booked.';
    COMMENT ON COLUMN option_expiry_calendar.expiry_kind IS
      'WEEKLY or MONTHLY, from the provider W/M flag rather than inferred from the weekday: NSE consolidated weeklies onto one index and moved them to Tuesday, so any weekday rule is stale.';
  `,
};
