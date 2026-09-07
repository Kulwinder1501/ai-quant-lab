import type { Migration } from "../migration-runner.js";

// Records whether a weekly-expiry weekday was confirmed or assumed.
//
// Migration 021 left `weekly_expiry_weekday` NULL on purpose, so no expiry day was
// asserted without evidence. Migration 022 then seeded NIFTY50 = 4 (Thursday) and
// BANKNIFTY = 3 (Wednesday). Those may well be right, but neither was verified against
// an NSE contract note, and BANKNIFTY = 3 additionally asserts that BANKNIFTY *has* a
// weekly series -- which is the specific fact in doubt, since NSE consolidated weekly
// expiries and monthly-only indices exist.
//
// Deleting the values would throw away work; leaving them bare would let a guess look
// like a fact, and pricing a contract that does not exist is silent rather than loud.
// So the value stays and its provenance is stored next to it. `ASSUMED` means "believed,
// not checked", and `resolveWeeklyExpiryWeekday` refuses to derive an expiry from it --
// the protection is executable rather than a comment nobody reads.
//
// To promote a value once you have the contract note in front of you:
//
//   UPDATE instruments
//   SET weekly_expiry_weekday = 4, weekly_expiry_source = 'CONFIRMED'
//   WHERE symbol = 'NIFTY50';
//
// And for an index with no weekly series at all, NULL is the correct answer:
//
//   UPDATE instruments
//   SET weekly_expiry_weekday = NULL, weekly_expiry_source = NULL
//   WHERE symbol = 'BANKNIFTY';
export const weeklyExpiryProvenanceMigration: Migration = {
  id: "024-weekly-expiry-provenance",
  sql: `
    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS weekly_expiry_source TEXT;

    ALTER TABLE instruments DROP CONSTRAINT IF EXISTS instruments_weekly_expiry_source_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_weekly_expiry_source_check
      CHECK (weekly_expiry_source IS NULL OR weekly_expiry_source IN ('CONFIRMED', 'ASSUMED'));

    -- Backfill before the pairing constraint exists. The seeded weekdays currently have no
    -- provenance, so adding the constraint first fails on those very rows.
    UPDATE instruments
    SET weekly_expiry_source = 'ASSUMED'
    WHERE weekly_expiry_weekday IS NOT NULL AND weekly_expiry_source IS NULL;

    -- A weekday without provenance is exactly the ambiguity this column removes, so the
    -- two are required to travel together.
    ALTER TABLE instruments DROP CONSTRAINT IF EXISTS instruments_weekly_expiry_paired_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_weekly_expiry_paired_check
      CHECK ((weekly_expiry_weekday IS NULL) = (weekly_expiry_source IS NULL));

    COMMENT ON COLUMN instruments.weekly_expiry_source IS
      'CONFIRMED when weekly_expiry_weekday was checked against an NSE contract note, ASSUMED when it is a working guess. Code must not derive a tradable expiry from an ASSUMED weekday.';
  `,
};
