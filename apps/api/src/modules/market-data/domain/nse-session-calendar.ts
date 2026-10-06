/**
 * NSE cash-session helpers backed by `nse_holidays` when a DB is available.
 */

const IST = "Asia/Kolkata";

export function istDateKey(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(instant);
}

interface QueryableDatabase {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * True when `nse_holidays` lists this IST calendar day.
 * On lookup failure returns false (do not invent a holiday and skip trading silently).
 */
export async function isNseHoliday(
  database: QueryableDatabase,
  instant = new Date(),
): Promise<{ holiday: boolean; name: string | null }> {
  const day = istDateKey(instant);
  try {
    const result = await database.query<{ name: string }>(`
      SELECT name FROM nse_holidays WHERE holiday_date = $1::date LIMIT 1
    `, [day]);
    const name = result.rows[0]?.name ?? null;
    return { holiday: name !== null, name };
  } catch {
    return { holiday: false, name: null };
  }
}

/**
 * Every date in `nse_holidays`, as `YYYY-MM-DD` strings.
 *
 * For callers that need the whole set up front rather than a per-instant lookup --
 * `NseMarketSession` takes a holiday set at construction. On lookup failure returns an empty
 * list for the same reason `isNseHoliday` does: inventing "no holidays" is safer than inventing
 * one that skips a real trading day silently.
 */
export async function loadNseHolidays(database: QueryableDatabase): Promise<string[]> {
  try {
    const result = await database.query<{ holiday_date: string }>(`
      SELECT to_char(holiday_date, 'YYYY-MM-DD') AS holiday_date FROM nse_holidays
    `);
    return result.rows.map((row) => row.holiday_date);
  } catch {
    return [];
  }
}
