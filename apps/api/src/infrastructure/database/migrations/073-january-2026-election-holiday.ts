import type { Migration } from "../migration-runner.js";

/** Late exchange-calendar amendment for the Maharashtra municipal elections. */
export const january2026ElectionHolidayMigration: Migration = {
  id: "073-january-2026-election-holiday",
  sql: `
    INSERT INTO nse_holidays (holiday_date, name) VALUES
      ('2026-01-15', 'Maharashtra Municipal Corporation Elections')
    ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name;
  `,
};
