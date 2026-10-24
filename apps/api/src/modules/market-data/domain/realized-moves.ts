/**
 * How far an index future actually moved, session by session. Pure.
 *
 * The option chain prices a typical move (the implied volatility); this is the other side of that comparison, measured from
 * stored 1-minute futures bars. Everything here is observed, and each rule that keeps it honest is stated:
 *
 * - **Close to close needs the same contract on both days.** A futures contract's price carries a basis to the index, and a roll
 *   changes the contract, so a "move" across a roll is partly the basis. It is reported as unavailable (`null`), never computed.
 * - **Close to close needs both closes to be real closes.** A session that stops early (a day the stored bars end at 14:43)
 *   has no close, so neither its own move nor the next day's move from it is reported.
 * - **A session still running is not in the statistics.** Its range so far is not the day's range.
 * - **Range is high minus low of the regular session (09:15-15:30 IST)** and needs only that one session to be complete.
 * - **Close-to-close moves include the overnight gap**, as the options being compared with do: an option's time value runs over
 *   the night as well as the day. Intraday range does not.
 *
 * Percentages are of the previous close (close to close) and of the session's open (range), both stated beside the figure.
 */
import type { FuturesBar } from "./session-volume-profile.js";
import { selectRegularSessionBars, summariseSession, COMPLETE_SESSION_MIN_BAR_SHARE, EXPECTED_SESSION_MINUTES } from "./session-volume-profile.js";

export const MOVE_WINDOW_CHOICES = [5, 10, 20] as const;

export interface SessionInput {
  sessionDate: string;
  symbol: string;
  /** The session's bars (any, they are filtered to the regular session). */
  bars: readonly FuturesBar[];
  /** The session is today and not over. */
  inProgress: boolean;
}

export interface SessionMove {
  sessionDate: string;
  symbol: string;
  /** Enough of the 375 regular minutes are stored to take the session's close and range as the day's. */
  complete: boolean;
  inProgress: boolean;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  /** High minus low, in index points; null unless the session is complete. */
  rangePoints: number | null;
  /** Range as a percentage of the open; null unless the session is complete. */
  rangePercentOfOpen: number | null;
  /** Close minus the previous session's close; null across a roll, an incomplete session or a missing previous day. */
  closeToClosePoints: number | null;
  /** Close to close as a percentage of the previous close. */
  closeToClosePercent: number | null;
  /** The previous session's date when a close-to-close move was taken from it. */
  previousSessionDate: string | null;
}

/** Each session's move, oldest first. `sessions` must be in date order, oldest first; the previous one is the one before it. */
export function buildSessionMoves(sessions: readonly SessionInput[]): SessionMove[] {
  const moves: SessionMove[] = [];
  let previous: { move: SessionMove; input: SessionInput } | null = null;
  for (const input of sessions) {
    const { regular } = selectRegularSessionBars(input.bars as FuturesBar[]);
    const summary = summariseSession(regular);
    const distinctMinutes = new Set(regular.map((bar) => Math.floor(bar.openTime.getTime() / 60_000))).size;
    const complete = !input.inProgress && summary !== null && distinctMinutes >= EXPECTED_SESSION_MINUTES * COMPLETE_SESSION_MIN_BAR_SHARE;

    const sameContractAsPrevious = previous !== null && previous.input.symbol === input.symbol && previous.move.complete && previous.move.close !== null;
    const closeMove = complete && sameContractAsPrevious && summary !== null
      ? summary.close - previous!.move.close!
      : null;
    const move: SessionMove = {
      sessionDate: input.sessionDate,
      symbol: input.symbol,
      complete,
      inProgress: input.inProgress,
      open: summary?.open ?? null,
      high: summary?.high ?? null,
      low: summary?.low ?? null,
      close: summary?.close ?? null,
      rangePoints: complete && summary ? summary.high - summary.low : null,
      rangePercentOfOpen: complete && summary && summary.open > 0 ? ((summary.high - summary.low) / summary.open) * 100 : null,
      closeToClosePoints: closeMove,
      closeToClosePercent: closeMove !== null && previous!.move.close! > 0 ? (closeMove / previous!.move.close!) * 100 : null,
      previousSessionDate: closeMove !== null ? previous!.input.sessionDate : null,
    };
    moves.push(move);
    previous = { move, input };
  }
  return moves;
}

export interface MoveStatistics {
  /** Sessions in the window that were asked for (the newest complete-or-not sessions, today's running one excluded). */
  sessionsInWindow: number;
  /** Of those, how many have a close-to-close move, and how many a range. */
  closeToCloseCount: number;
  rangeCount: number;
  meanAbsCloseToClosePoints: number | null;
  medianAbsCloseToClosePoints: number | null;
  meanAbsCloseToClosePercent: number | null;
  meanRangePoints: number | null;
  meanRangePercentOfOpen: number | null;
  /** The dates the window covers, oldest first. */
  fromDate: string | null;
  toDate: string | null;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Statistics over the newest `window` sessions that are not still running. Absolute values: the size of a move, not its sign,
 * is what an implied volatility is compared with. A session without a figure is left out of that figure's mean and counted in
 * the counts, so a window with holes says so rather than averaging fewer days as if they were `window`.
 */
export function summariseMoves(moves: readonly SessionMove[], window: number): MoveStatistics {
  const finished = moves.filter((move) => !move.inProgress);
  const inWindow = finished.slice(Math.max(0, finished.length - window));
  const closeMoves = inWindow.map((move) => move.closeToClosePoints).filter((value): value is number => value !== null);
  const closePercents = inWindow.map((move) => move.closeToClosePercent).filter((value): value is number => value !== null);
  const ranges = inWindow.map((move) => move.rangePoints).filter((value): value is number => value !== null);
  const rangePercents = inWindow.map((move) => move.rangePercentOfOpen).filter((value): value is number => value !== null);
  return {
    sessionsInWindow: inWindow.length,
    closeToCloseCount: closeMoves.length,
    rangeCount: ranges.length,
    meanAbsCloseToClosePoints: mean(closeMoves.map(Math.abs)),
    medianAbsCloseToClosePoints: median(closeMoves.map(Math.abs)),
    meanAbsCloseToClosePercent: mean(closePercents.map(Math.abs)),
    meanRangePoints: mean(ranges),
    meanRangePercentOfOpen: mean(rangePercents),
    fromDate: inWindow[0]?.sessionDate ?? null,
    toDate: inWindow[inWindow.length - 1]?.sessionDate ?? null,
  };
}

export const REALIZED_MOVE_DEFINITIONS = {
  observed: "Observed from stored 1-minute futures bars (front month of each day, regular session 09:15-15:30 IST). Nothing is estimated.",
  closeToClose: "Close minus the previous session's close, including the overnight gap. Not computed across a contract roll (the futures price carries a basis that a roll changes) or from a session that stops early.",
  range: "High minus low of the regular session, in index points, and as a percentage of the open. Only for a complete session (96% of the 375 regular minutes).",
  window: "The newest N sessions that are not still running. A session without a figure is left out of that figure's average and counted in the counts, so a window with holes says so.",
  absolute: "Averages are of absolute moves: the size of a move, not its direction.",
} as const;
