/**
 * Session Calendar & Boundaries for Directional Intelligence V2 (Phase 29).
 *
 * Implements strict NSE session invariants:
 * - Sessions open at 09:15:00 and close at 15:30:00 (or point-in-time special session close).
 * - No cross-session forward labels: if `labelEndAt > session.closeAt`, the label is strictly INVALID.
 * - No intraday rolling window crosses an overnight boundary.
 */

export interface MarketSession {
  /** Unique session identifier (e.g. "2026-01-02") */
  readonly sessionId: string;
  /** The calendar date of the trading session (YYYY-MM-DD) */
  readonly sessionDate: string;
  /** The exact time the continuous trading session opens (e.g., 09:15:00) */
  readonly openAt: Date;
  /** The exact time the continuous trading session closes (e.g., 15:30:00) */
  readonly closeAt: Date;
  /** Whether this is a special abbreviated session (e.g., Muhurat trading) */
  readonly isSpecialSession: boolean;
}

export interface SessionCandle {
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/**
 * Creates a standard NSE session from a date string (YYYY-MM-DD).
 * Continuous trading: 09:15:00 to 15:30:00 IST (UTC+05:30).
 */
export function createStandardNseSession(sessionDate: string, isSpecialSession = false, customCloseTime?: string): MarketSession {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new Error("sessionDate must use YYYY-MM-DD.");
  if (customCloseTime !== undefined && !/^\d{2}:\d{2}:\d{2}$/.test(customCloseTime)) {
    throw new Error("customCloseTime must use HH:mm:ss.");
  }
  // IST is UTC+05:30
  const openAt = new Date(`${sessionDate}T09:15:00+05:30`);
  const closeTimeStr = customCloseTime ?? "15:30:00";
  const closeAt = new Date(`${sessionDate}T${closeTimeStr}+05:30`);
  if (Number.isNaN(openAt.getTime()) || Number.isNaN(closeAt.getTime()) || closeAt <= openAt) {
    throw new Error(`Invalid NSE session window for ${sessionDate}.`);
  }

  return {
    sessionId: sessionDate,
    sessionDate,
    openAt,
    closeAt,
    isSpecialSession,
  };
}

/**
 * Validates whether a forward label interval stays strictly within the same session.
 * Phase 29 Invariant: `if (labelEndAt > session.closeAt) { INVALID }`.
 */
export function isLabelWithinSession(labelEndAt: Date, session: MarketSession): boolean {
  return labelEndAt.getTime() <= session.closeAt.getTime();
}

/**
 * Partitions chronological 1m candles into distinct trading sessions.
 * Drops out-of-session bars (e.g. pre-open / post-close).
 */
export function groupCandlesBySession(
  candles: readonly SessionCandle[],
  customSessions?: readonly MarketSession[],
): Map<string, { session: MarketSession; candles: SessionCandle[] }> {
  const sessionMap = new Map<string, { session: MarketSession; candles: SessionCandle[] }>();
  const customMap = new Map<string, MarketSession>();
  if (customSessions) {
    for (const session of customSessions) {
      customMap.set(session.sessionDate, session);
    }
  }

  for (const candle of candles) {
    if (Number.isNaN(candle.openTime.getTime()) || Number.isNaN(candle.closeTime.getTime())) {
      throw new Error("Candle timestamps must be valid dates.");
    }
    const sessionDateKey = new Date(candle.openTime.getTime() + 330 * 60_000).toISOString().slice(0, 10);

    let sessionEntry = sessionMap.get(sessionDateKey);
    const configuredSession = customMap.get(sessionDateKey);
    if (customSessions && !configuredSession) continue; // supplied calendar is authoritative
    const session = sessionEntry?.session ?? configuredSession ?? createStandardNseSession(sessionDateKey);

    // Keep only candles strictly within openAt and closeAt
    if (
      candle.openTime.getTime() >= session.openAt.getTime()
      && candle.closeTime.getTime() <= session.closeAt.getTime()
    ) {
      if (!sessionEntry) {
        sessionEntry = { session, candles: [] };
        sessionMap.set(sessionDateKey, sessionEntry);
      }
      sessionEntry.candles.push(candle);
    }
  }

  // Sort each session's candles chronologically
  for (const entry of sessionMap.values()) {
    entry.candles.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }

  return sessionMap;
}
