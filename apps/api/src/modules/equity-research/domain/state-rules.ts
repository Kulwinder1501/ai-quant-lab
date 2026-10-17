import type { EquityOutcome, PriceQuoteLabel, StockHealthStatus, StockViewState } from "./types.js";

/**
 * Checks whether the Indian equity market (NSE / BSE) is currently in regular trading session.
 * Regular trading session: Monday - Friday, 09:15 to 15:30 IST (UTC + 05:30).
 */
export function isIndianMarketOpen(now: Date = new Date()): boolean {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  const day = istDate.getUTCDay(); // 0 is Sun, 6 is Sat
  if (day === 0 || day === 6) {
    return false;
  }
  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const minuteOfDay = hours * 60 + minutes;

  const openMinute = 9 * 60 + 15; // 09:15 IST = 555
  const closeMinute = 15 * 60 + 30; // 15:30 IST = 930
  return minuteOfDay >= openMinute && minuteOfDay < closeMinute;
}

export function formatIstDateString(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export interface DeriveStateParams {
  hasBars: boolean;
  sourceHealthStatus?: StockHealthStatus;
  lastRawOutcome?: EquityOutcome | null;
  lastRawWarning?: string | null;
  lastBarDate?: string | null;
  lastFetchedAt?: Date | null;
  now?: Date;
  /** Days of inactivity after which data is considered stale. Default 4 (covers long weekends). */
  staleThresholdDays?: number;
  rebackfillNeeded?: boolean;
}

export interface DerivedStockState {
  state: StockViewState;
  reason: string | null;
}

/**
 * Pure state derivation with per-stock failure isolation (Gate S8).
 * States: OK | STALE | NEVER_FETCHED | UNAVAILABLE | RATE_LIMITED | REBACKFILL_NEEDED.
 */
export function deriveStockState(params: DeriveStateParams): DerivedStockState {
  if (params.rebackfillNeeded) {
    return {
      state: "REBACKFILL_NEEDED",
      reason: "Historical restatement or corporate action detected; series re-backfill pending.",
    };
  }

  if (params.sourceHealthStatus === "RATE_LIMITED") {
    return { state: "RATE_LIMITED", reason: "Yahoo Finance rate limit cooldown active." };
  }

  if (params.sourceHealthStatus === "UNAVAILABLE") {
    return { state: "UNAVAILABLE", reason: "Data source is unavailable." };
  }

  // Per-stock failure isolation (Gate S8): a failure on this stock does NOT mark other stocks unavailable
  if (params.lastRawOutcome === "ERROR") {
    return {
      state: "UNAVAILABLE",
      reason: params.lastRawWarning ?? "Collection failed for stock symbol.",
    };
  }

  if (!params.hasBars && !params.lastFetchedAt) {
    return { state: "NEVER_FETCHED", reason: "No historical bars collected yet." };
  }

  if (params.lastBarDate) {
    const now = params.now ?? new Date();
    const barDate = new Date(`${params.lastBarDate}T00:00:00Z`);
    const diffMs = now.getTime() - barDate.getTime();
    const thresholdMs = (params.staleThresholdDays ?? 4) * 24 * 60 * 60 * 1000;

    if (diffMs > thresholdMs) {
      return {
        state: "STALE",
        reason: `No new daily bars collected since ${params.lastBarDate}.`,
      };
    }
  }

  return { state: "OK", reason: null };
}

export interface DeriveQuoteLabelParams {
  marketTime: Date;
  now?: Date;
  isMarketOpen?: boolean;
}

/**
 * Determines the honest label for a quote.
 * Hard rule (Section 2 & Gate G3): Under no circumstances may any label claim "REAL-TIME".
 * Labels: DELAYED | LAST-TRADED | PREVIOUS-CLOSE.
 */
export function deriveQuoteLabel(params: DeriveQuoteLabelParams): PriceQuoteLabel {
  const now = params.now ?? new Date();
  const isMarketOpen =
    params.isMarketOpen !== undefined ? params.isMarketOpen : isIndianMarketOpen(now);

  const marketDateStr = formatIstDateString(params.marketTime);
  const nowDateStr = formatIstDateString(now);
  const isToday = marketDateStr === nowDateStr;

  if (isMarketOpen) {
    // During active market hours on trading days, Yahoo free quote is delayed
    if (isToday) {
      return "DELAYED";
    }
    return "PREVIOUS-CLOSE";
  }

  // Market is closed
  if (isToday) {
    // If market closed today, check if it's the immediate post-market reconciliation window (15:30 - 16:30 IST)
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    const minuteOfDay = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
    if (minuteOfDay >= 15 * 60 + 30 && minuteOfDay < 16 * 60 + 30) {
      return "LAST-TRADED";
    }
    return "PREVIOUS-CLOSE";
  }

  return "PREVIOUS-CLOSE";
}
