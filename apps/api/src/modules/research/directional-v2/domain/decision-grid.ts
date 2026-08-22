import type { MarketSession, SessionCandle } from "./session-calendar.js";

/**
 * Anchored 5-Minute Decision Grid (Phase 29 §1).
 *
 * Enforces strict lookahead prevention:
 * - `decisionAt`: The exact decision moment (e.g., 09:20:00.000).
 * - `dataThrough`: The timestamp up to which data is legally observable (e.g., 09:19:59.999).
 * - `referenceCandle`: The last completed 1m bar whose `closeTime <= decisionAt`.
 * - No intraday rolling window crosses an overnight boundary.
 */

export interface DecisionPoint {
  readonly sampleId: string;
  readonly instrument: string;
  readonly session: MarketSession;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly minuteOfDay: number; // 0 at 09:15, 5 at 09:20, etc.
  readonly timeToSessionCloseMinutes: number;
  readonly referenceCandle: SessionCandle;
  readonly trailingSessionCandles: readonly SessionCandle[]; // strictly from current session up to dataThrough
}

export interface GridOptions {
  readonly gridIntervalMinutes?: number; // default 5m
}

/**
 * Builds the 5-minute decision grid for a session given its 1m candles.
 */
export function buildDecisionGridForSession(
  instrument: string,
  session: MarketSession,
  sessionCandles: readonly SessionCandle[],
  options: GridOptions = {},
): DecisionPoint[] {
  const gridIntervalMinutes = options.gridIntervalMinutes ?? 5;
  if (!Number.isInteger(gridIntervalMinutes) || gridIntervalMinutes <= 0) {
    throw new Error("gridIntervalMinutes must be a positive integer.");
  }
  const gridIntervalMs = gridIntervalMinutes * 60_000;
  const sessionStartMs = session.openAt.getTime();
  const sessionCloseMs = session.closeAt.getTime();

  const sortedCandles = [...sessionCandles].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());

  const decisionPoints: DecisionPoint[] = [];

  // Step through 5m increments from session open to close
  for (let currentMs = sessionStartMs; currentMs < sessionCloseMs; currentMs += gridIntervalMs) {
    const decisionAt = new Date(currentMs);
    const dataThrough = new Date(currentMs - 1); // 1ms before decisionAt

    // Identify trailing candles completed on or before decisionAt
    const trailingCandles: SessionCandle[] = [];
    for (const candle of sortedCandles) {
      if (candle.closeTime.getTime() <= currentMs) {
        trailingCandles.push(candle);
      } else {
        break;
      }
    }

    // Reference candle is the most recently completed 1m bar
    const referenceCandle = trailingCandles.length > 0
      ? trailingCandles[trailingCandles.length - 1]!
      : null;

    if (!referenceCandle) {
      // At exactly 09:15:00, no 1m bar has closed yet in this session.
      // The first decision point with an intraday reference candle is 09:20 (after 09:15-09:20 bar completes).
      continue;
    }

    const minuteOfDay = Math.round((currentMs - sessionStartMs) / 60_000);
    const timeToSessionCloseMinutes = Math.round((sessionCloseMs - currentMs) / 60_000);

    const istDecisionTime = new Date(currentMs + 330 * 60_000).toISOString().slice(11, 16).replace(":", "");
    const sampleId = `${instrument}--${session.sessionDate}--${istDecisionTime}`;

    decisionPoints.push({
      sampleId,
      instrument,
      session,
      decisionAt,
      dataThrough,
      minuteOfDay,
      timeToSessionCloseMinutes,
      referenceCandle,
      trailingSessionCandles: trailingCandles,
    });
  }

  return decisionPoints;
}
