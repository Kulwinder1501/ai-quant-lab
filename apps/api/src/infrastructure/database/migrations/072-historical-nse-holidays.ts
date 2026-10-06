import type { Migration } from "../migration-runner.js";

/**
 * Backfills the official cash-market holidays needed by historical research.
 * Migration 056 intentionally seeded only the forward 2026 calendar, which made
 * older holidays look like missing candle sessions in strict coverage audits.
 */
export const historicalNseHolidaysMigration: Migration = {
  id: "072-historical-nse-holidays",
  sql: `
    INSERT INTO nse_holidays (holiday_date, name) VALUES
      ('2023-01-26', 'Republic Day'),
      ('2023-03-07', 'Holi'),
      ('2023-03-30', 'Ram Navami'),
      ('2023-04-04', 'Mahavir Jayanti'),
      ('2023-04-07', 'Good Friday'),
      ('2023-04-14', 'Dr Ambedkar Jayanti'),
      ('2023-05-01', 'Maharashtra Day'),
      ('2023-06-29', 'Bakri Id'),
      ('2023-08-15', 'Independence Day'),
      ('2023-09-19', 'Ganesh Chaturthi'),
      ('2023-10-02', 'Mahatma Gandhi Jayanti'),
      ('2023-10-24', 'Dussehra'),
      ('2023-11-14', 'Diwali-Balipratipada'),
      ('2023-11-27', 'Guru Nanak Jayanti'),
      ('2023-12-25', 'Christmas'),
      ('2024-01-22', 'Special market holiday'),
      ('2024-01-26', 'Republic Day'),
      ('2024-03-08', 'Mahashivratri'),
      ('2024-03-25', 'Holi'),
      ('2024-03-29', 'Good Friday'),
      ('2024-04-11', 'Id-Ul-Fitr'),
      ('2024-04-17', 'Ram Navami'),
      ('2024-05-01', 'Maharashtra Day'),
      ('2024-05-20', 'Lok Sabha election'),
      ('2024-06-17', 'Bakri Id'),
      ('2024-07-17', 'Muharram'),
      ('2024-08-15', 'Independence Day'),
      ('2024-10-02', 'Mahatma Gandhi Jayanti'),
      ('2024-11-15', 'Guru Nanak Jayanti'),
      ('2024-11-20', 'Maharashtra Assembly election'),
      ('2024-12-25', 'Christmas'),
      ('2025-02-26', 'Mahashivratri'),
      ('2025-03-14', 'Holi'),
      ('2025-03-31', 'Id-Ul-Fitr'),
      ('2025-04-10', 'Mahavir Jayanti'),
      ('2025-04-14', 'Dr Ambedkar Jayanti'),
      ('2025-04-18', 'Good Friday'),
      ('2025-05-01', 'Maharashtra Day'),
      ('2025-08-15', 'Independence Day'),
      ('2025-08-27', 'Ganesh Chaturthi'),
      ('2025-10-02', 'Mahatma Gandhi Jayanti/Dussehra'),
      ('2025-10-22', 'Diwali-Balipratipada'),
      ('2025-11-05', 'Guru Nanak Jayanti'),
      ('2025-12-25', 'Christmas')
    ON CONFLICT (holiday_date) DO UPDATE SET name = EXCLUDED.name;
  `,
};
