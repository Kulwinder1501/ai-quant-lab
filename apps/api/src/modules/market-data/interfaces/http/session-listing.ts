import type { HttpDependencies } from "../../../../interfaces/http/dependencies.js";
import { upcomingIndexFutures, type IndexFutureContract } from "../../domain/index-futures-contracts.js";
import { COMPLETE_SESSION_MIN_BAR_SHARE, EXPECTED_SESSION_MINUTES } from "../../domain/session-volume-profile.js";
import { SESSION_LOOKBACK_DAYS, addDays, type IndexUnderlying } from "./session-query.js";

/**
 * The stored sessions of an index future, shared by the routes that read futures bars (the volume profile, volume by time).
 * Which contract was front month on a day is the calendar's call; whether its bars are stored is the database's.
 */

const IST_OFFSET_MS = 330 * 60_000;

/** UTC instant of a wall-clock time on an IST calendar date. */
export function istInstant(date: string, hour: number, minute = 0): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, hour, minute) - IST_OFFSET_MS);
}

/**
 * The contract that was the front month on a date, or undefined. Never the next month: that is a different, thinner
 * market, and a profile of it would pass for the day's volume.
 */
export function frontContractOn(underlying: IndexUnderlying, date: string): IndexFutureContract | undefined {
  return upcomingIndexFutures(date, 1).find((contract) => contract.underlyingSymbol === underlying);
}

export interface SessionListing {
  sessionDate: string;
  symbol: string;
  bars: number;
  barsWithVolume: number;
  firstAt: string;
  lastAt: string;
  /** Enough of the 375 regular minutes are present to treat the session as the day's. */
  complete: boolean;
}

/** Each stored day with volume in the look-back, under the contract that was front month on it, newest first. */
export async function listStoredSessions(
  repository: HttpDependencies["futuresBarRepository"],
  underlying: IndexUnderlying,
  today: string,
): Promise<SessionListing[]> {
  const lookbackStart = addDays(today, -SESSION_LOOKBACK_DAYS);
  const frontSymbols = new Set<string>();
  for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset += 1) {
    const contract = frontContractOn(underlying, addDays(lookbackStart, offset));
    if (contract) frontSymbols.add(contract.symbol);
  }
  const sessions: SessionListing[] = [];
  for (const symbol of frontSymbols) {
    const days = await repository.sessionDays({ symbol, fromDate: lookbackStart, toDate: today });
    for (const day of days) {
      if (frontContractOn(underlying, day.date)?.symbol !== symbol || day.barsWithVolume === 0) continue;
      sessions.push({
        sessionDate: day.date,
        symbol,
        bars: day.bars,
        barsWithVolume: day.barsWithVolume,
        firstAt: day.firstAt.toISOString(),
        lastAt: day.lastAt.toISOString(),
        complete: day.bars >= EXPECTED_SESSION_MINUTES * COMPLETE_SESSION_MIN_BAR_SHARE,
      });
    }
  }
  return sessions.sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));
}
