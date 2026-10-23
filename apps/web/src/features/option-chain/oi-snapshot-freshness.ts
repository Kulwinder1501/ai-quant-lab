/**
 * Option-chain snapshot freshness relative to the collector cron.
 *
 * Schedule (scheduler.ts): `11,23,41,53 9-15 * * 1-5` — Mon–Fri, 09:11–15:53 IST,
 * with alternating 12/18 minute gaps (not a flat 15). In-session stale uses 20 minutes so a
 * single missed run (~30m gaps seen 2026-10-21/22) still flags.
 *
 * Holidays cannot be detected here: the cron has no holiday calendar. Measured 2026-10-20
 * (a holiday) still produced 8 snapshots; treat weekday clock bounds only and do not claim
 * "market holiday".
 */

export const OI_IN_SESSION_STALE_AFTER_MS = 20 * 60_000;

/** Inclusive IST bounds matching the first/last cron minutes in hour 9–15. */
const SESSION_START_MINUTE_OF_DAY = 9 * 60 + 11; // 09:11
const SESSION_END_MINUTE_OF_DAY = 15 * 60 + 53; // 15:53

export type OiFreshnessState =
  | "in_session_fresh"
  | "in_session_stale"
  | "outside_collection_hours";

export interface OiFreshnessAssessment {
  state: OiFreshnessState;
  ageMs: number | null;
  /** True when `now` falls inside Mon–Fri 09:11–15:53 Asia/Kolkata. */
  nowInCollectionHours: boolean;
}

function istParts(ms: number): { weekday: number; minuteOfDay: number } {
  // en-US gives weekday; 24h clock avoids AM/PM parsing.
  const weekdayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  }).format(new Date(ms));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[weekdayLabel];
  if (weekday === undefined) {
    throw new Error(`Unexpected IST weekday label: ${weekdayLabel}`);
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Could not parse IST clock from ${ms}`);
  }
  // en-GB 24h can emit hour "24" at midnight in some engines — normalise.
  const normalisedHour = hour === 24 ? 0 : hour;
  return { weekday, minuteOfDay: normalisedHour * 60 + minute };
}

/**
 * Whether `nowMs` is inside the collector's weekday IST window (inclusive of 09:11 and 15:53).
 * Pure aside from Intl timezone tables.
 */
export function isOiCollectionHours(nowMs: number): boolean {
  const { weekday, minuteOfDay } = istParts(nowMs);
  if (weekday < 1 || weekday > 5) return false;
  return minuteOfDay >= SESSION_START_MINUTE_OF_DAY && minuteOfDay <= SESSION_END_MINUTE_OF_DAY;
}

/**
 * Classify snapshot age for the OI freshness bar.
 *
 * Outside collection hours never uses the "stale / delayed until next collect" copy — overnight
 * and weekend age is expected.
 */
export function assessOiSnapshotFreshness(input: {
  observedAtMs: number | null;
  nowMs: number;
  staleAfterMs?: number;
}): OiFreshnessAssessment {
  const staleAfterMs = input.staleAfterMs ?? OI_IN_SESSION_STALE_AFTER_MS;
  const nowInCollectionHours = isOiCollectionHours(input.nowMs);
  const ageMs =
    input.observedAtMs !== null && Number.isFinite(input.observedAtMs)
      ? Math.max(0, input.nowMs - input.observedAtMs)
      : null;

  if (!nowInCollectionHours) {
    return { state: "outside_collection_hours", ageMs, nowInCollectionHours };
  }
  if (ageMs === null || ageMs > staleAfterMs) {
    return { state: "in_session_stale", ageMs, nowInCollectionHours };
  }
  return { state: "in_session_fresh", ageMs, nowInCollectionHours };
}
