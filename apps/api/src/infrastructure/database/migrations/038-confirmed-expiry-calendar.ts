import type { Migration } from "../migration-runner.js";

// Replaces the guessed weekly-expiry calendar with the provider's own, and moves stored
// option expiries to the instant contracts actually settle.
//
// Migration 022 seeded NIFTY50 = 4 (Thursday) and BANKNIFTY = 3 (Wednesday); migration 024
// marked both ASSUMED and left them, on the grounds that a guess should be labelled rather
// than deleted. Both were wrong, and 024 named the exact risk: "BANKNIFTY = 3 additionally
// asserts that BANKNIFTY *has* a weekly series -- which is the specific fact in doubt".
//
// It does not. Queried against Fyers `options-chain-v3` on 2026-08-04, BANKNIFTY returns
// 25-08-2026, 29-09-2026, 27-10-2026, 29-12-2026 and beyond with **every entry flagged `M`**.
// NIFTY50 returns 04-08, 11-08, 18-08 and 01-09-2026 flagged `W`. SBIN and RELIANCE are
// monthly-only. Every expiry the provider lists, weekly or monthly, falls on a **Tuesday**.
//
// So: NIFTY50 becomes 2 (Tuesday) CONFIRMED, and every monthly-only underlying becomes NULL
// -- the encoding 024 documented for "no weekly series at all". The paired-null constraint
// from 024 means the weekday and its provenance have to move together.
//
// What the guess cost: two paper trades were booked against a BANKNIFTY 2026-08-04 expiry,
// a contract that never traded. Their recorded premiums reproduce the model on that phantom
// 1.4-day and 0.7-day tenor to the cent, against a real tenor of ~22 days, so entry, exit
// and return are all fiction -- +214% recorded where the real contract returned +38%. Those
// rows are deliberately NOT rewritten below. Their expiry is part of what went wrong, and
// editing a closed trade's contract would hide the defect instead of recording it; they are
// excluded from evidence rather than repaired.
//
// The second half is the settlement instant. `option_expiry` was stored at 00:00 UTC, which
// is 05:30 IST -- ten hours before the 15:30 IST close. `evaluate-open-paper-trades`
// force-closes as soon as `asOf >= expiry`, so a position settled at the pre-open of expiry
// day against the prior session's spot, discarding the final trading day. Open positions are
// moved to 10:00 UTC; `resolveOptionExpiryInstant` now stops new ones being written at
// midnight.
export const confirmedExpiryCalendarMigration: Migration = {
  id: "038-confirmed-expiry-calendar",
  sql: `
    -- Weekday and provenance are constrained to be both-null or both-set, so each
    -- statement has to set the pair.
    UPDATE instruments
    SET weekly_expiry_weekday = 2, weekly_expiry_source = 'CONFIRMED'
    WHERE symbol = 'NIFTY50';

    UPDATE instruments
    SET weekly_expiry_weekday = NULL, weekly_expiry_source = NULL
    WHERE symbol IN ('BANKNIFTY', 'SBIN', 'RELIANCE');

    -- Any other instrument still carrying an ASSUMED weekday is an unverified guess that
    -- resolveWeeklyExpiryWeekday already refuses. Clearing it makes the refusal say
    -- "no weekly series configured" instead of implying a series exists but is unchecked.
    UPDATE instruments
    SET weekly_expiry_weekday = NULL, weekly_expiry_source = NULL
    WHERE weekly_expiry_source = 'ASSUMED';

    -- Open positions only. Closed rows keep the expiry they were priced against.
    UPDATE paper_trades
    SET option_expiry = date_trunc('day', option_expiry) + INTERVAL '10 hours',
        updated_at = CURRENT_TIMESTAMP
    WHERE status = 'OPEN'
      AND option_expiry IS NOT NULL
      AND option_expiry = date_trunc('day', option_expiry);

    COMMENT ON COLUMN paper_trades.option_expiry IS
      'Settlement instant, 10:00 UTC = 15:30 IST. A date at 00:00 UTC would settle the position at 05:30 IST on expiry day, before the market opens.';
  `,
};
