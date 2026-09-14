import {
  istSessionDate,
  resolveTradingSession,
  type SessionKind,
} from "../../platform/calendar/trading-session.js";
import type { HistoricalTimeframe } from "./historical-data-provider.js";
import {
  knownNseNonRegularSessionMap,
  NSE_CASH_CLOSE_IST_MINUTE,
  NSE_DERIVATIVES_CLOSE_EFFECTIVE_FROM,
  NSE_DERIVATIVES_CLOSE_IST_MINUTE,
  NSE_REGULAR_SESSION_OPEN_IST_MINUTE,
} from "./nse-non-regular-sessions.js";

const istOffsetMs = 5.5 * 60 * 60_000;

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
const derivativesCloseMinutes = NSE_DERIVATIVES_CLOSE_IST_MINUTE;
const derivativesCloseEffectiveFrom = NSE_DERIVATIVES_CLOSE_EFFECTIVE_FROM;

export interface NseSessionWindow {
  opensAt: Date;
  closesAt: Date;
  /** Which segment's bell `closesAt` refers to, so a stored window is self-describing. */
  segment: NseSegment;
  /**
   * `REGULAR` or `NON_REGULAR`. Added when this class adopted the platform calendar.
   *
   * A caller that only reads `opensAt`/`closesAt` is unaffected, but the distinction matters for
   * anything that assumes a session runs 09:15 to the bell: on a `NON_REGULAR` session it does not,
   * and `closesAt` is the exchange's announced close rather than the segment's.
   */
  kind: Exclude<SessionKind, "CLOSED">;
  /** Why this session is non-regular, verbatim from the catalogue. Null for a regular session. */
  reason: string | null;
}

export interface CandleWindow extends NseSessionWindow {
  openTime: Date;
  closeTime: Date;
}

function closeMinutesFor(segment: NseSegment, dateKey: string): number {
  if (segment === "CASH") return NSE_CASH_CLOSE_IST_MINUTE;
  // Before the change the derivatives segment closed with cash, so a historical window must not be
  // widened retroactively -- that would invent quotes that could not have existed.
  return dateKey >= derivativesCloseEffectiveFrom ? derivativesCloseMinutes : NSE_CASH_CLOSE_IST_MINUTE;
}

/**
 * Resolves a session through the shared platform calendar.
 *
 * Before this, tradability was decided here from the weekday plus a holiday set, and the non-regular
 * catalogue carried only dates. Measured against the stored tape, that was wrong on **six of the eight
 * known non-regular sessions** in two opposite directions: four weekend sittings carrying 105-750 bars
 * per instrument were reported closed, and two ordinary weekdays that had *no* regular trading
 * (2024-11-01 and 2025-10-21, both Diwali) were reported as full 09:15-15:30 days.
 *
 * The concrete failure that made this worth adopting rather than leaving as an available primitive:
 * `run-scalp-research-harness.ts` throws `No NSE session for completed candle` when `getSession`
 * returns null. On the next weekend special session it would not have mis-priced anything -- it would
 * have crashed, mid-capture, on a day holding 1,500 bars.
 *
 * The dated derivatives close stays here because it is an NSE fact, not a platform one. The platform
 * takes the shape as input and never learns that a bell moved on 2026-08-03.
 */
function resolveNseSession(value: Date, segment: NseSegment, holidays: ReadonlySet<string>): NseSessionWindow | null {
  const sessionDate = istSessionDate(value);
  const resolved = resolveTradingSession({
    sessionDate,
    regularShape: {
      opensAtIstMinute: NSE_REGULAR_SESSION_OPEN_IST_MINUTE,
      closesAtIstMinute: closeMinutesFor(segment, sessionDate),
    },
    holidays,
    nonRegularSessions: knownNseNonRegularSessionMap(),
  });
  if (resolved.kind === "CLOSED") return null;
  return {
    opensAt: resolved.opensAt!,
    closesAt: resolved.closesAt!,
    segment,
    kind: resolved.kind,
    reason: resolved.reason,
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
    return resolveNseSession(value, segment, this.holidays);
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
