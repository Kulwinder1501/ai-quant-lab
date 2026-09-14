const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const SESSION_OPEN_MINUTES = 9 * 60 + 15;
const SESSION_CLOSE_MINUTES = 15 * 60 + 30;
const SESSION_DURATION_MS = (SESSION_CLOSE_MINUTES - SESSION_OPEN_MINUTES) * 60_000;

function validHolidayDates(values: Iterable<string>): Set<string> {
  return new Set([...values].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)));
}

function localDateKey(localMidnightMs: number): string {
  return new Date(localMidnightMs).toISOString().slice(0, 10);
}

/**
 * Returns elapsed NSE cash-session milliseconds between two instants.
 *
 * India has no daylight-saving transitions, so shifting onto an IST-local UTC
 * timeline makes day/session overlap deterministic in browsers in every timezone.
 */
export function calculateNseMarketElapsedMs(
  openedAt: string | null | undefined,
  nowMs: number = Date.now(),
  holidays: Iterable<string> = [],
): number | null {
  if (!openedAt || !Number.isFinite(nowMs)) return null;
  const openedMs = new Date(openedAt).getTime();
  if (!Number.isFinite(openedMs) || openedMs > nowMs) return null;

  const startLocalMs = openedMs + IST_OFFSET_MS;
  const endLocalMs = nowMs + IST_OFFSET_MS;
  const startLocal = new Date(startLocalMs);
  const firstLocalMidnight = Date.UTC(
    startLocal.getUTCFullYear(),
    startLocal.getUTCMonth(),
    startLocal.getUTCDate(),
  );
  const holidayDates = validHolidayDates(holidays);
  let elapsedMs = 0;

  for (let localMidnight = firstLocalMidnight; localMidnight <= endLocalMs; localMidnight += 86_400_000) {
    const weekday = new Date(localMidnight).getUTCDay();
    if (weekday === 0 || weekday === 6 || holidayDates.has(localDateKey(localMidnight))) continue;

    const sessionOpen = localMidnight + SESSION_OPEN_MINUTES * 60_000;
    const sessionClose = localMidnight + SESSION_CLOSE_MINUTES * 60_000;
    const overlapStart = Math.max(startLocalMs, sessionOpen);
    const overlapEnd = Math.min(endLocalMs, sessionClose);
    if (overlapEnd > overlapStart) elapsedMs += overlapEnd - overlapStart;
  }

  return elapsedMs;
}

function configuredNseHolidays(): string[] {
  return (process.env.NEXT_PUBLIC_NSE_HOLIDAYS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Formats accumulated market time, where one `d` is one complete 6h15m session. */
export function formatNseMarketElapsedDuration(
  openedAt: string | null | undefined,
  nowMs: number = Date.now(),
): string {
  const elapsedMs = calculateNseMarketElapsedMs(openedAt, nowMs, configuredNseHolidays());
  if (elapsedMs === null) return "—";

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const sessionSeconds = SESSION_DURATION_MS / 1000;
  const tradingDays = Math.floor(totalSeconds / sessionSeconds);
  const remainingSeconds = totalSeconds % sessionSeconds;
  const hours = Math.floor(remainingSeconds / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;

  if (tradingDays > 0) return `${tradingDays}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
