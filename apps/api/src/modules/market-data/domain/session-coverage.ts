/**
 * What a full trading session should have left in the database, and whether it did.
 *
 * Two sessions in a row lost data without anything saying so: on 2026-10-16 the ETF bars stopped at 11:03 and the
 * option chain and premium ticks at 10:53 and 12:04, and the only way to know was to count rows by hand the next day.
 * This is the same count made automatically after the close, with a verdict, so a gap is a FAILED job row the same
 * evening -- while the series that can be healed from history still can be, and while the ones that cannot (option
 * snapshots and ticks) are at least known to be missing.
 *
 * Expected bar counts are for a normal 09:15-15:30 IST session. The 60m series has six bars because the 15:15 bar
 * covers only fifteen minutes and is not sealed as a 60m bar.
 */
export const EXPECTED_BARS: Readonly<Record<string, number>> = Object.freeze({
  "1m": 375,
  "5m": 75,
  "15m": 25,
  "30m": 13,
  "60m": 6,
});

/** How many bars of a series may be missing before it counts as a gap. One-minute bars are allowed a few. */
export const ALLOWED_MISSING_BARS: Readonly<Record<string, number>> = Object.freeze({
  "1m": 5,
  "5m": 1,
  "15m": 0,
  "30m": 0,
  "60m": 0,
});

export const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
/** The last snapshot or tick of a healthy session is within this many minutes of the close. */
export const MAXIMUM_MINUTES_BEFORE_CLOSE_FOR_LAST_OBSERVATION = 20;
export const MINIMUM_CHAIN_SNAPSHOTS = 20;
export const MINIMUM_TICK_MINUTES = 340;
export const MINIMUM_DEPTH_FRAMES = 30_000;

export interface BarCoverage {
  symbol: string;
  timeframe: string;
  bars: number;
}

export interface ChainCoverage {
  underlying: string;
  snapshots: number;
  /** IST minute of the day of the last snapshot, or null if there was none. */
  lastMinute: number | null;
}

export interface TickCoverage {
  underlying: string;
  minutesWithTicks: number;
  lastMinute: number | null;
}

export interface SessionCoverageInput {
  date: string;
  bars: readonly BarCoverage[];
  chains: readonly ChainCoverage[];
  ticks: readonly TickCoverage[];
  depthFrames: number;
}

export interface SessionCoverageVerdict {
  ok: boolean;
  issues: string[];
  /** Series that history can fill (bars), as opposed to snapshots and ticks, which cannot be recovered. */
  healable: string[];
  unrecoverable: string[];
}

function clock(minute: number | null): string {
  if (minute === null) return "none";
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

export function assessSessionCoverage(input: SessionCoverageInput): SessionCoverageVerdict {
  const issues: string[] = [];
  const healable: string[] = [];
  const unrecoverable: string[] = [];

  for (const series of input.bars) {
    const expected = EXPECTED_BARS[series.timeframe];
    if (expected === undefined) continue;
    const missing = expected - series.bars;
    if (missing > (ALLOWED_MISSING_BARS[series.timeframe] ?? 0)) {
      issues.push(`${series.symbol} ${series.timeframe}: ${series.bars} of ${expected} bars (${missing} missing)`);
      healable.push(`${series.symbol} ${series.timeframe}`);
    }
  }

  const lastAllowed = SESSION_CLOSE_MINUTE - MAXIMUM_MINUTES_BEFORE_CLOSE_FOR_LAST_OBSERVATION;
  for (const chain of input.chains) {
    if (chain.snapshots < MINIMUM_CHAIN_SNAPSHOTS || chain.lastMinute === null || chain.lastMinute < lastAllowed) {
      issues.push(
        `${chain.underlying} option chain: ${chain.snapshots} snapshots (need ${MINIMUM_CHAIN_SNAPSHOTS}), last at ${clock(chain.lastMinute)}`,
      );
      unrecoverable.push(`${chain.underlying} option chain`);
    }
  }
  for (const tick of input.ticks) {
    if (tick.minutesWithTicks < MINIMUM_TICK_MINUTES || tick.lastMinute === null || tick.lastMinute < lastAllowed) {
      issues.push(
        `${tick.underlying} option premium ticks: ${tick.minutesWithTicks} minutes covered (need ${MINIMUM_TICK_MINUTES}), last at ${clock(tick.lastMinute)}`,
      );
      unrecoverable.push(`${tick.underlying} option premium ticks`);
    }
  }
  if (input.depthFrames < MINIMUM_DEPTH_FRAMES) {
    issues.push(`market depth: ${input.depthFrames} frames (need ${MINIMUM_DEPTH_FRAMES})`);
    unrecoverable.push("market depth");
  }

  return { ok: issues.length === 0, issues, healable, unrecoverable };
}

/** One line for the log, whatever the verdict. */
export function formatSessionCoverageLine(date: string, verdict: SessionCoverageVerdict): string {
  return JSON.stringify({
    level: verdict.ok ? "info" : "error",
    message: verdict.ok ? "Session data coverage complete" : "Session data coverage has gaps",
    date,
    issues: verdict.issues,
    healable: verdict.healable,
    unrecoverable: verdict.unrecoverable,
  });
}
