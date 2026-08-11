import type { Migration } from "../migration-runner.js";

/**
 * Repairs installations that ran migration 056 before calendar rows became source-verified.
 */
export const calendarVerificationMigration: Migration = {
  id: "057-calendar-verification",
  sql: `
    ALTER TABLE scheduled_macro_events ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE scheduled_macro_events ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;

    DELETE FROM scheduled_macro_events
    WHERE source = 'seed' OR name ILIKE '%verify date%';

    DELETE FROM nse_holidays
    WHERE holiday_date IN ('2026-08-15', '2026-11-08');

    INSERT INTO nse_holidays (holiday_date, name) VALUES
      ('2026-05-28', 'Bakri Id'),
      ('2026-06-26', 'Muharram'),
      ('2026-11-10', 'Diwali-Balipratipada')
    ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name;

    INSERT INTO scheduled_macro_events (
      event_date, name, region, source, source_url, verified
    ) VALUES
      ('2026-04-08', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-06-05', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-08-05', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-10-07', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-12-04', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2027-02-05', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE)
    ON CONFLICT (event_date, name, region) DO UPDATE SET
      source = EXCLUDED.source,
      source_url = EXCLUDED.source_url,
      verified = EXCLUDED.verified;
  `,
};
