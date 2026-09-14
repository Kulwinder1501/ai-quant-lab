import type { Migration } from "../migration-runner.js";

/**
 * Dated calendars for honest event gates — distinct from keyword "macro" headlines.
 *
 * NSE holidays and scheduled macro events (RBI, budget, etc.) are seeded here.
 * Keyword headline heat remains a separate soft signal; only dated rows may hard-gate.
 */
export const scheduledEventsAndHolidaysMigration: Migration = {
  id: "056-scheduled-events-and-holidays",
  sql: `
    CREATE TABLE IF NOT EXISTS nse_holidays (
      holiday_date DATE PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS scheduled_macro_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_date DATE NOT NULL,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      region TEXT NOT NULL DEFAULT 'IN' CHECK (length(trim(region)) > 0),
      source TEXT NOT NULL DEFAULT 'seed',
      source_url TEXT,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (event_date, name, region)
    );

    CREATE INDEX IF NOT EXISTS scheduled_macro_events_date_idx
    ON scheduled_macro_events (event_date);

    -- Official 2026 NSE F&O trading holidays (NSE/FAOP/71777).
    INSERT INTO nse_holidays (holiday_date, name) VALUES
      ('2026-01-26', 'Republic Day'),
      ('2026-03-03', 'Holi'),
      ('2026-03-26', 'Ram Navami'),
      ('2026-03-31', 'Mahavir Jayanti'),
      ('2026-04-03', 'Good Friday'),
      ('2026-04-14', 'Dr Ambedkar Jayanti'),
      ('2026-05-01', 'Maharashtra Day'),
      ('2026-05-28', 'Bakri Id'),
      ('2026-06-26', 'Muharram'),
      ('2026-09-14', 'Ganesh Chaturthi'),
      ('2026-10-02', 'Mahatma Gandhi Jayanti'),
      ('2026-10-20', 'Dussehra'),
      ('2026-11-10', 'Diwali-Balipratipada'),
      ('2026-11-24', 'Guru Nanak Jayanti'),
      ('2026-12-25', 'Christmas')
    ON CONFLICT (holiday_date) DO NOTHING;

    -- RBI FY2026-27 MPC decision dates. Only verified rows may hard-gate entries.
    INSERT INTO scheduled_macro_events (
      event_date, name, region, source, source_url, verified
    ) VALUES
      ('2026-04-08', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-06-05', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-08-05', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-10-07', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2026-12-04', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE),
      ('2027-02-05', 'RBI MPC policy decision', 'IN', 'RBI MPC schedule 2026-27', 'https://www.rbi.org.in/', TRUE)
    ON CONFLICT (event_date, name, region) DO NOTHING;

    COMMENT ON TABLE nse_holidays IS
      'NSE cash-market holidays. Used for session/calendar honesty; not keyword news.';
    COMMENT ON TABLE scheduled_macro_events IS
      'Dated macro events for hard gates. Keyword headline heat is separate and must stay soft.';
  `,
};
