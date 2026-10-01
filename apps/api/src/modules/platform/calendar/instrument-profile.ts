export interface InstrumentProfile {
  symbol: string;
  timezone: string;
  sessionDateResolver(now: Date): Date;
  isDailyBreak(now: Date): boolean;
  isSessionActive(now: Date): boolean;
}

/**
 * Convert a Date to New York local time components using Intl.DateTimeFormat (DST-aware).
 */
export function getNewYorkParts(now: Date): {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  dayOfWeek: number; // 0=Sun, 1=Mon, ..., 6=Sat
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "narrow",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  // Get weekday number in America/New_York
  const dayNameFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  const dayName = dayNameFormatter.format(now);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const hourRaw = parseInt(map.hour ?? "0", 10);
  const hour = hourRaw === 24 ? 0 : hourRaw;

  return {
    year: parseInt(map.year ?? "1970", 10),
    month: parseInt(map.month ?? "1", 10),
    day: parseInt(map.day ?? "1", 10),
    dayOfWeek: dayMap[dayName] ?? 0,
    hour,
    minute: parseInt(map.minute ?? "0", 10),
    second: parseInt(map.second ?? "0", 10),
  };
}

export const XAUUSD_OANDA_PROFILE: InstrumentProfile = {
  symbol: "XAU_USD",
  timezone: "America/New_York",

  sessionDateResolver(now: Date): Date {
    const ny = getNewYorkParts(now);

    // If NY time is 18:00-23:59:59 (Sunday through Thursday evening),
    // it belongs to the NEXT trading session date.
    let targetYear = ny.year;
    let targetMonth = ny.month;
    let targetDay = ny.day;

    if (ny.hour >= 18) {
      // Add 1 calendar day to NY date
      const tempDate = new Date(Date.UTC(ny.year, ny.month - 1, ny.day + 1));
      targetYear = tempDate.getUTCFullYear();
      targetMonth = tempDate.getUTCMonth() + 1;
      targetDay = tempDate.getUTCDate();
    }

    // Return UTC Date representation YYYY-MM-DD 00:00:00 UTC
    return new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, 0, 0, 0, 0));
  },

  isDailyBreak(now: Date): boolean {
    const ny = getNewYorkParts(now);
    // Daily break occurs Mon-Thu 17:00 to 18:00 NY time
    // On Friday, 17:00 marks weekend close, not just a 1-hour break.
    return ny.dayOfWeek >= 1 && ny.dayOfWeek <= 4 && ny.hour === 17;
  },

  isSessionActive(now: Date): boolean {
    const ny = getNewYorkParts(now);

    // Weekend close: Friday 17:00 NY time to Sunday 18:00 NY time
    if (ny.dayOfWeek === 5 && ny.hour >= 17) return false;
    if (ny.dayOfWeek === 6) return false; // All Saturday closed
    if (ny.dayOfWeek === 0 && ny.hour < 18) return false; // Sunday before 18:00 closed

    // Mon-Thu 17:00-18:00 daily break
    if (this.isDailyBreak(now)) return false;

    return true;
  },
};
