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

const IST_OFFSET_MS = 5.5 * 60 * 60_000;

/**
 * NSE's session-date resolver, expressed as an `InstrumentProfile`.
 *
 * India does not observe DST, so "the IST calendar date of an instant" is a fixed +5:30 shift with
 * no timezone-table lookup involved -- this intentionally duplicates `istSessionDate`'s own
 * arithmetic (`trading-session.ts`) rather than importing it, because `sessionDateResolver` must
 * return a `Date` (this interface's contract) where `istSessionDate` returns a `YYYY-MM-DD` string.
 * The two are proven equivalent -- same calendar date, every existing NSE test case -- in
 * `instrument-profile.test.ts`.
 *
 * `isDailyBreak`/`isSessionActive` below are intentionally conservative: they know only the regular
 * Mon-Fri, 09:15-15:30 IST shape, with no holiday or non-regular-session calendar. Nothing this
 * profile is actually wired into (`session-levels.ts`, `bias.ts`) calls either method -- both
 * callers resolve session *dates*, never tradability -- so these two exist only to satisfy the
 * `InstrumentProfile` contract. A caller that needs real NSE tradability (holidays, Muhurat,
 * Saturday specials) must use `NseMarketSession`/`resolveTradingSession`, which carry the actual
 * exchange calendar; this profile does not attempt to duplicate that.
 */
export const NSE_IST_PROFILE: InstrumentProfile = {
  symbol: "NSE_IST",
  timezone: "Asia/Kolkata",

  sessionDateResolver(now: Date): Date {
    const istDateString = new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    return new Date(`${istDateString}T00:00:00.000Z`);
  },

  isDailyBreak(): boolean {
    return false; // The NSE regular session has no intraday break.
  },

  isSessionActive(now: Date): boolean {
    const shifted = new Date(now.getTime() + IST_OFFSET_MS);
    const dayOfWeek = shifted.getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return false; // Weekend, only ever a default.
    const minuteOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
    return minuteOfDay >= 555 && minuteOfDay < 930; // 09:15-15:30 IST regular cash session.
  },
};

/**
 * Resolves the `InstrumentProfile` a given instrument symbol should use for session-date bucketing.
 *
 * Defaults to `NSE_IST_PROFILE` -- every instrument this platform trades except gold is NSE-listed,
 * and defaulting there keeps every existing caller's behaviour unchanged. `XAU_USD` is the one
 * registered exception: its session boundary is NY-local 18:00, DST-aware via `getNewYorkParts`,
 * which an IST-fixed-offset default would get wrong across the US DST transition.
 */
export function instrumentProfileForSymbol(symbol: string): InstrumentProfile {
  return symbol === XAUUSD_OANDA_PROFILE.symbol ? XAUUSD_OANDA_PROFILE : NSE_IST_PROFILE;
}

/**
 * The session-date key `session-levels.ts`/`bias.ts` group bars by: `profile.sessionDateResolver`'s
 * `Date` result, formatted the same way `istSessionDate` always has (`YYYY-MM-DD`) so date keys stay
 * sortable as strings and Map-keyable exactly as before.
 */
export function sessionDateKey(profile: InstrumentProfile, instant: Date): string {
  return profile.sessionDateResolver(instant).toISOString().slice(0, 10);
}
