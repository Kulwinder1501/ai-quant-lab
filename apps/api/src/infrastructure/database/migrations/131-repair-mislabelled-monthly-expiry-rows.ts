import type { Migration } from "../migration-runner.js";

/**
 * Repairs `option_chain_snapshots` rows that `expiryFromSymbol` filed under a WEEKLY expiry date
 * although the contract is a MONTHLY one.
 *
 * ## The defect
 *
 * `fyers-option-chain-client.ts` used to test a monthly symbol token (`26SEP` in
 * `NSE:NIFTY26SEP22600CE`) against EVERY expiry date in the header in ascending order, weekly
 * dates included. The first date of that month always matched, so the 29-Sep monthly book was
 * stored on the 22-Sep weekly date and flagged WEEKLY -- two books per collection run both
 * labelled 2026-09-22 WEEKLY. Measured before this migration was written: NIFTY50, 51 snapshots,
 * 3,162 rows, all on 2026-09-22.
 *
 * ## What counts as a mislabelled row (all must hold)
 *
 * - `provider_symbol` ends in `<yy><MON><strike><CE|PE>`, i.e. carries the MONTHLY month-name token.
 *   Weekly symbols use a digit / O / N / D month code and never match.
 * - `expiry_kind = 'WEEKLY'`.
 * - The token's year and month equal the stored `expiry_date`'s year and month (so the row was
 *   plainly attracted to a date inside its own contract month).
 * - `option_expiry_calendar` lists exactly ONE distinct MONTHLY date for that underlying in that
 *   month, and it differs from the stored date. That date is the target. Zero or several monthly
 *   dates -> the target is ambiguous and the row is left alone.
 *
 * ## Unique-index handling
 *
 * `option_chain_snapshots_identity_idx` is UNIQUE (underlying_symbol, observed_at, expiry_date,
 * strike_price, option_type). Re-filing a row onto the target date would violate it if a row
 * already exists there for the same observation. In that case the existing correct row wins and
 * the mislabelled duplicate is DELETED instead (step 1). Step 2 then re-files the rest.
 *
 * ## Idempotent
 *
 * After step 2 the rows are `expiry_kind = 'MONTHLY'` on the monthly date, so neither step matches
 * them again; a second run is a no-op. Rows are never inserted and no other column is changed.
 */
export const repairMislabelledMonthlyExpiryRowsMigration: Migration = {
  id: "131-repair-mislabelled-monthly-expiry-rows",
  sql: `
    DO $repair$
    BEGIN
      -- Step 1: delete mislabelled rows whose correct slot is already occupied.
      WITH monthly_target AS (
        SELECT underlying_symbol,
               date_trunc('month', expiry_date)::date AS month_start,
               MIN(expiry_date) AS target_expiry
        FROM option_expiry_calendar
        WHERE expiry_kind = 'MONTHLY'
        GROUP BY underlying_symbol, date_trunc('month', expiry_date)
        HAVING COUNT(DISTINCT expiry_date) = 1
      ),
      candidate AS (
        SELECT s.id, s.underlying_symbol, s.observed_at, s.strike_price, s.option_type, t.target_expiry
        FROM option_chain_snapshots s
        CROSS JOIN LATERAL (
          SELECT substring(s.provider_symbol FROM '^(?:[A-Z]+:)?[A-Z&-]+([0-9]{2})(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9.]+(?:CE|PE)$') AS yy,
                 substring(s.provider_symbol FROM '^(?:[A-Z]+:)?[A-Z&-]+[0-9]{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9.]+(?:CE|PE)$') AS mon
        ) tok
        INNER JOIN monthly_target t
          ON t.underlying_symbol = s.underlying_symbol
         AND t.month_start = date_trunc('month', s.expiry_date)::date
        WHERE s.expiry_kind = 'WEEKLY'
          AND tok.yy IS NOT NULL
          AND tok.mon IS NOT NULL
          AND 2000 + tok.yy::int = EXTRACT(YEAR FROM s.expiry_date)::int
          AND array_position(ARRAY['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], tok.mon)
              = EXTRACT(MONTH FROM s.expiry_date)::int
          AND t.target_expiry <> s.expiry_date
      )
      DELETE FROM option_chain_snapshots d
      USING candidate c
      WHERE d.id = c.id
        AND EXISTS (
          SELECT 1 FROM option_chain_snapshots existing
          WHERE existing.underlying_symbol = c.underlying_symbol
            AND existing.observed_at = c.observed_at
            AND existing.expiry_date = c.target_expiry
            AND existing.strike_price = c.strike_price
            AND existing.option_type = c.option_type
        );

      -- Step 2: re-file the remainder under the unique monthly expiry date.
      WITH monthly_target AS (
        SELECT underlying_symbol,
               date_trunc('month', expiry_date)::date AS month_start,
               MIN(expiry_date) AS target_expiry
        FROM option_expiry_calendar
        WHERE expiry_kind = 'MONTHLY'
        GROUP BY underlying_symbol, date_trunc('month', expiry_date)
        HAVING COUNT(DISTINCT expiry_date) = 1
      ),
      candidate AS (
        SELECT s.id, t.target_expiry
        FROM option_chain_snapshots s
        CROSS JOIN LATERAL (
          SELECT substring(s.provider_symbol FROM '^(?:[A-Z]+:)?[A-Z&-]+([0-9]{2})(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9.]+(?:CE|PE)$') AS yy,
                 substring(s.provider_symbol FROM '^(?:[A-Z]+:)?[A-Z&-]+[0-9]{2}(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[0-9.]+(?:CE|PE)$') AS mon
        ) tok
        INNER JOIN monthly_target t
          ON t.underlying_symbol = s.underlying_symbol
         AND t.month_start = date_trunc('month', s.expiry_date)::date
        WHERE s.expiry_kind = 'WEEKLY'
          AND tok.yy IS NOT NULL
          AND tok.mon IS NOT NULL
          AND 2000 + tok.yy::int = EXTRACT(YEAR FROM s.expiry_date)::int
          AND array_position(ARRAY['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'], tok.mon)
              = EXTRACT(MONTH FROM s.expiry_date)::int
          AND t.target_expiry <> s.expiry_date
      )
      UPDATE option_chain_snapshots u
      SET expiry_date = c.target_expiry,
          expiry_kind = 'MONTHLY'
      FROM candidate c
      WHERE u.id = c.id;
    END
    $repair$;
  `,
};
