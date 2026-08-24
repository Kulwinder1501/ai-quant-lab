import type { HistoricalTimeframe } from "./historical-data-provider.js";

const istOffsetMs = 5.5 * 60 * 60_000;
const sessionOpenMinutes = 9 * 60 + 15;
const sessionCloseMinutes = 15 * 60 + 30;

/**
 * NSE trades its cash and equity-derivatives segments to different closing bells.
 *
 * This mattered silently: everything here assumed 15:30, so any option-based rule that ran past it
 * was reasoning about a market it believed was shut. Phase 29 D2 exits 30 minutes after a decision,
 * so a 15:15 signal schedules a 15:45 exit -- and with a 15:30 close the scheduler and the harness
 * disagree with the tape about whether quotes should exist at all.
 */
export type NseSegment = "CASH" | "EQUITY_DERIVATIVES";

/**
 * The equity-derivatives close, and the date it moved.
 *
 * Kept as a dated constant rather than folded into the numbers above so the change is auditable and
 * correctable in one place.
 *
 * **Provenance:** verified 2026-08-24 against NSE's published market timings, which list the normal
 * market close for equity derivatives at 15:40, and against NSE's Closing Auction documentation,
 * which separately states equity derivatives trade 09:15-15:40. Correct this constant if the regime
 * changes again -- do not paper over it at a call site.
 */
const derivativesCloseMinutes = 15 * 60 + 40;
const derivativesCloseEffectiveFrom = "2026-08-03";

export interface NseSessionWindow {
  opensAt: Date;
  closesAt: Date;
  /** Which segment's bell `closesAt` refers to, so a stored window is self-describing. */
  segment: NseSegment;
}

export interface CandleWindow extends NseSessionWindow {
  openTime: Date;
  closeTime: Date;
}

function localDateKey(value: Date): string {
  const ist = new Date(value.getTime() + istOffsetMs);
  return ist.toISOString().slice(0, 10);
}

function closeMinutesFor(segment: NseSegment, dateKey: string): number {
  if (segment === "CASH") return sessionCloseMinutes;
  // Before the change the derivatives segment closed with cash, so a historical window must not be
  // widened retroactively -- that would invent quotes that could not have existed.
  return dateKey >= derivativesCloseEffectiveFrom ? derivativesCloseMinutes : sessionCloseMinutes;
}

function sessionWindow(value: Date, segment: NseSegment): NseSessionWindow {
  const ist = new Date(value.getTime() + istOffsetMs);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  const closeMinutes = closeMinutesFor(segment, localDateKey(value));
  const startOfDayUtc = Date.UTC(year, month, day) - istOffsetMs;
  return {
    opensAt: new Date(startOfDayUtc + sessionOpenMinutes * 60_000),
    closesAt: new Date(startOfDayUtc + closeMinutes * 60_000),
    segment,
  };
}

const intradayDurationMs: Partial<Record<HistoricalTimeframe, number>> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
};

/**
 * NSE session rules. Holiday exceptions are injected rather than guessed.
 *
 * The segment defaults to `CASH`, which is what every existing caller meant and keeps their
 * behaviour byte-identical. A caller reasoning about options must ask for `EQUITY_DERIVATIVES`
 * explicitly -- the default is deliberately not "widest", because silently extending the day would
 * make a missing quote look like a data gap rather than a closed market.
 */
export class NseMarketSession {
  private readonly holidays: Set<string>;
  private readonly segment: NseSegment;

  constructor(holidays: Iterable<string> = [], segment: NseSegment = "CASH") {
    if (segment !== "CASH" && segment !== "EQUITY_DERIVATIVES") {
      throw new Error(`Unknown NSE segment "${String(segment)}".`);
    }
    this.holidays = new Set(holidays);
    this.segment = segment;
  }

  getSession(value: Date, segment: NseSegment = this.segment): NseSessionWindow | null {
    if (Number.isNaN(value.getTime())) {
      throw new Error("NseMarketSession requires a valid timestamp.");
    }
    const ist = new Date(value.getTime() + istOffsetMs);
    const weekday = ist.getUTCDay();
    if (weekday === 0 || weekday === 6 || this.holidays.has(localDateKey(value))) {
      return null;
    }
    return sessionWindow(value, segment);
  }

  isOpen(value: Date, segment: NseSegment = this.segment): boolean {
    const session = this.getSession(value, segment);
    return session !== null && value >= session.opensAt && value < session.closesAt;
  }

  candleWindow(value: Date, timeframe: HistoricalTimeframe): CandleWindow | null {
    const session = this.getSession(value);
    if (!session || value < session.opensAt || value >= session.closesAt) {
      return null;
    }
    if (timeframe === "1d") {
      return { ...session, openTime: session.opensAt, closeTime: session.closesAt };
    }
    const duration = intradayDurationMs[timeframe];
    if (!duration) {
      throw new Error(`Unsupported live timeframe ${timeframe}.`);
    }
    const elapsed = value.getTime() - session.opensAt.getTime();
    const openTime = new Date(session.opensAt.getTime() + Math.floor(elapsed / duration) * duration);
    const closeTime = new Date(Math.min(openTime.getTime() + duration, session.closesAt.getTime()));
    return { ...session, openTime, closeTime };
  }
}
