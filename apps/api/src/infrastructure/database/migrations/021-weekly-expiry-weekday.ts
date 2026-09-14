import type { Migration } from "../migration-runner.js";

// Moves the weekly-expiry weekday out of code and into instrument data.
//
// `defaultWeeklyExpiry` hardcoded Thursday. Two facts make a code constant the wrong
// home for that: NSE has consolidated weekly expiries, so which weekday an index expires
// on is not fixed and is not the same across indices, and **not every underlying has a
// weekly series at all**. A constant cannot express "this one has none", so a caller
// asking for the next weekly expiry of a monthly-only index silently received a date for
// a contract that does not exist.
//
// Deliberately left NULL for every instrument. NULL means "no weekly series is
// configured", and nothing may assume one -- the option endpoint now requires an
// explicit expiry rather than deriving a default, so an unset value produces a clear
// refusal instead of a fabricated contract. Populating a row is how you opt an
// instrument into weekly-expiry helpers, once its real expiry weekday is known.
//
// This intentionally encodes no guess. Setting NIFTY50 to 4 here would have moved the
// hardcoded Thursday from code into data without establishing that it is correct.
export const weeklyExpiryWeekdayMigration: Migration = {
  id: "021-weekly-expiry-weekday",
  sql: `
    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS weekly_expiry_weekday SMALLINT;
    ALTER TABLE instruments DROP CONSTRAINT IF EXISTS instruments_weekly_expiry_weekday_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_weekly_expiry_weekday_check
      CHECK (weekly_expiry_weekday IS NULL OR weekly_expiry_weekday BETWEEN 0 AND 6);

    COMMENT ON COLUMN instruments.weekly_expiry_weekday IS
      'Day of week (0=Sunday) this instrument''s weekly options expire, or NULL when it has no weekly series. NULL means no weekly expiry may be inferred.';
  `,
};
