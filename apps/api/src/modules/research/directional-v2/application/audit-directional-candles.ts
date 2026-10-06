import type { MarketSession, SessionCandle } from "../domain/session-calendar.js";

export type DirectionalAuditIssueCode =
  | "EMPTY_SERIES"
  | "EMPTY_REGULAR_SERIES"
  | "DUPLICATE_TIMESTAMP"
  | "UNKNOWN_SESSION"
  | "OUT_OF_SESSION"
  | "MISALIGNED_BAR"
  | "INVALID_TIMESTAMP"
  | "INVALID_OHLC"
  | "INVALID_VOLUME"
  | "MISSING_SESSION"
  | "MISSING_MINUTE";

export interface DirectionalAuditIssue {
  readonly code: DirectionalAuditIssueCode;
  readonly sessionDate?: string;
  readonly at?: Date;
  readonly message: string;
}

export interface DirectionalCandleAudit {
  readonly instrument: string;
  readonly ready: boolean;
  readonly candleCount: number;
  readonly expectedSessionCount: number;
  readonly observedSessionCount: number;
  readonly excludedSpecialSessionCount: number;
  readonly excludedSpecialCandleCount: number;
  readonly excludedDataQualitySessionCount: number;
  readonly excludedDataQualityCandleCount: number;
  readonly issues: readonly DirectionalAuditIssue[];
}

export interface DirectionalAuditOptions {
  /** Explicitly versioned special sessions excluded from the regular-session study. */
  readonly excludedSpecialSessions?: ReadonlyMap<string, { readonly reason: string }>;
  /** Whole sessions excluded after the sole missing source bar failed deterministic validation. */
  readonly excludedDataQualitySessions?: ReadonlyMap<string, { readonly reason: string }>;
  /** Exact non-continuous-session prints retained in storage but excluded from this study. */
  readonly excludedCandleOpens?: ReadonlyMap<number, { readonly reason: string }>;
}

function istDateKey(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Strict, deterministic gate for the exact candle series consumed by D0/D1. */
export function auditDirectionalCandles(
  instrument: string,
  candles: readonly SessionCandle[],
  expectedSessions: readonly MarketSession[],
  options: DirectionalAuditOptions = {},
): DirectionalCandleAudit {
  const issues: DirectionalAuditIssue[] = [];
  if (candles.length === 0) {
    issues.push({ code: "EMPTY_SERIES", message: `${instrument} has no audited 1m candles.` });
  }

  const sessionsByDate = new Map(expectedSessions.map((session) => [session.sessionDate, session]));
  const opensSeen = new Set<number>();
  const observedDates = new Set<string>();
  const excludedSpecialDates = new Set<string>();
  let excludedSpecialCandleCount = 0;
  const excludedDataQualityDates = new Set<string>();
  let excludedDataQualityCandleCount = 0;
  const openTimesByDate = new Map<string, Set<number>>();
  let includedCandleCount = 0;

  for (const candle of candles) {
    const openMs = candle.openTime.getTime();
    const closeMs = candle.closeTime.getTime();
    if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) {
      issues.push({ code: "INVALID_TIMESTAMP", message: `${instrument} contains an invalid candle timestamp.` });
      continue;
    }
    const sessionDate = istDateKey(candle.openTime);
    const session = sessionsByDate.get(sessionDate);

    if (opensSeen.has(openMs)) {
      issues.push({
        code: "DUPLICATE_TIMESTAMP",
        sessionDate,
        at: candle.openTime,
        message: `${instrument} contains duplicate 1m open ${candle.openTime.toISOString()}.`,
      });
    }
    opensSeen.add(openMs);

    if (options.excludedCandleOpens?.has(openMs)) {
      excludedDataQualityCandleCount += 1;
      continue;
    }

    if (!session && options.excludedSpecialSessions?.has(sessionDate)) {
      excludedSpecialDates.add(sessionDate);
      excludedSpecialCandleCount += 1;
      continue;
    }

    if (!session && options.excludedDataQualitySessions?.has(sessionDate)) {
      excludedDataQualityDates.add(sessionDate);
      excludedDataQualityCandleCount += 1;
      continue;
    }

    if (!session) {
      issues.push({
        code: "UNKNOWN_SESSION",
        sessionDate,
        at: candle.openTime,
        message: `${instrument} contains a candle on non-calendar session ${sessionDate}.`,
      });
      continue;
    }
    if (openMs < session.openAt.getTime() || closeMs > session.closeAt.getTime()) {
      issues.push({
        code: "OUT_OF_SESSION",
        sessionDate,
        at: candle.openTime,
        message: `${instrument} candle ${candle.openTime.toISOString()} is outside the configured session.`,
      });
      continue;
    }
    observedDates.add(sessionDate);
    includedCandleCount += 1;

    if (openMs % 60_000 !== 0 || closeMs - openMs !== 60_000) {
      issues.push({
        code: "MISALIGNED_BAR",
        sessionDate,
        at: candle.openTime,
        message: `${instrument} candle ${candle.openTime.toISOString()} is not an exact one-minute bar.`,
      });
    }

    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (
      !prices.every((price) => Number.isFinite(price) && price > 0)
      || candle.high < Math.max(candle.open, candle.close)
      || candle.low > Math.min(candle.open, candle.close)
    ) {
      issues.push({
        code: "INVALID_OHLC",
        sessionDate,
        at: candle.openTime,
        message: `${instrument} candle ${candle.openTime.toISOString()} has invalid OHLC values.`,
      });
    }
    if (!Number.isFinite(candle.volume) || candle.volume < 0) {
      issues.push({
        code: "INVALID_VOLUME",
        sessionDate,
        at: candle.openTime,
        message: `${instrument} candle ${candle.openTime.toISOString()} has invalid volume.`,
      });
    }

    let opens = openTimesByDate.get(sessionDate);
    if (!opens) {
      opens = new Set<number>();
      openTimesByDate.set(sessionDate, opens);
    }
    opens.add(openMs);
  }

  if (candles.length > 0 && includedCandleCount === 0) {
    issues.push({
      code: "EMPTY_REGULAR_SERIES",
      message: `${instrument} has no includable regular-session candles after calendar filtering.`,
    });
  }

  for (const session of expectedSessions) {
    const opens = openTimesByDate.get(session.sessionDate);
    if (!opens || opens.size === 0) {
      issues.push({
        code: "MISSING_SESSION",
        sessionDate: session.sessionDate,
        message: `${instrument} is missing the entire ${session.sessionDate} session.`,
      });
      continue;
    }
    const expectedBars = Math.round((session.closeAt.getTime() - session.openAt.getTime()) / 60_000);
    for (let index = 0; index < expectedBars; index += 1) {
      const expectedOpen = session.openAt.getTime() + index * 60_000;
      if (!opens.has(expectedOpen)) {
        issues.push({
          code: "MISSING_MINUTE",
          sessionDate: session.sessionDate,
          at: new Date(expectedOpen),
          message: `${instrument} is missing ${new Date(expectedOpen).toISOString()} within ${session.sessionDate}.`,
        });
      }
    }
  }

  return {
    instrument,
    ready: issues.length === 0,
    candleCount: candles.length,
    expectedSessionCount: expectedSessions.length,
    observedSessionCount: observedDates.size,
    excludedSpecialSessionCount: excludedSpecialDates.size,
    excludedSpecialCandleCount,
    excludedDataQualitySessionCount: excludedDataQualityDates.size,
    excludedDataQualityCandleCount,
    issues,
  };
}
