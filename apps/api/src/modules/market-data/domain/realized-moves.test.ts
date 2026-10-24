import { describe, expect, it } from "vitest";
import { buildSessionMoves, summariseMoves, type SessionInput } from "./realized-moves.js";
import type { FuturesBar } from "./session-volume-profile.js";

/**
 * A synthetic session (hand-built, not recorded): `count` one-minute bars from 09:15 IST, flat at the open except that the
 * second bar reaches `high`, the third reaches `low`, and the last bar closes at `close`.
 */
function session(
  sessionDate: string,
  symbol: string,
  figures: { open: number; high: number; low: number; close: number },
  { count = 375, inProgress = false }: { count?: number; inProgress?: boolean } = {},
): SessionInput {
  const start = Date.parse(`${sessionDate}T03:45:00.000Z`);
  const bars: FuturesBar[] = [];
  for (let i = 0; i < count; i += 1) {
    const last = i === count - 1;
    const close = last ? figures.close : figures.open;
    bars.push({
      openTime: new Date(start + i * 60_000),
      open: figures.open,
      high: Math.max(figures.open, close, i === 1 ? figures.high : 0),
      low: Math.min(figures.open, close, i === 2 ? figures.low : Number.POSITIVE_INFINITY),
      close,
      volume: 30,
    });
  }
  return { sessionDate, symbol, bars, inProgress };
}

const OCT = "BANKNIFTY26OCTFUT";
const NOV = "BANKNIFTY26NOVFUT";

describe("buildSessionMoves", () => {
  it("takes close to close from the previous session of the same contract, with the percentage of the previous close", () => {
    const moves = buildSessionMoves([
      session("2026-10-19", OCT, { open: 100, high: 101, low: 99, close: 100 }),
      session("2026-10-20", OCT, { open: 100, high: 106, low: 99, close: 104 }),
      session("2026-10-21", OCT, { open: 104, high: 105, low: 100, close: 101 }),
    ]);
    expect(moves[0]).toMatchObject({ closeToClosePoints: null, closeToClosePercent: null, previousSessionDate: null });
    expect(moves[1]).toMatchObject({ closeToClosePoints: 4, closeToClosePercent: 4, previousSessionDate: "2026-10-19" });
    expect(moves[2]!.closeToClosePoints).toBe(-3);
    expect(moves[2]!.closeToClosePercent).toBeCloseTo((-3 / 104) * 100, 12);
  });

  it("takes the range of a complete session as high minus low, in points and as a percentage of the open", () => {
    const [move] = buildSessionMoves([session("2026-10-20", OCT, { open: 100, high: 106, low: 99, close: 104 })]);
    expect(move).toMatchObject({ complete: true, open: 100, high: 106, low: 99, close: 104, rangePoints: 7 });
    expect(move!.rangePercentOfOpen).toBeCloseTo(7, 12);
  });

  it("does not compute a move across a contract roll, only between sessions of one contract", () => {
    const moves = buildSessionMoves([
      session("2026-10-26", OCT, { open: 100, high: 101, low: 99, close: 100 }),
      session("2026-10-28", NOV, { open: 130, high: 131, low: 129, close: 130 }),      // a roll: the basis changes, not the market
      session("2026-10-29", NOV, { open: 130, high: 133, low: 129, close: 132 }),
    ]);
    expect(moves[1]).toMatchObject({ closeToClosePoints: null, closeToClosePercent: null, rangePoints: 2 });
    expect(moves[2]).toMatchObject({ closeToClosePoints: 2 });
  });

  it("reports a session that stops early as incomplete: no range, no close-to-close move, and none for the day after it", () => {
    const moves = buildSessionMoves([
      session("2026-10-21", OCT, { open: 100, high: 101, low: 99, close: 100 }),
      session("2026-10-22", OCT, { open: 100, high: 105, low: 99, close: 103 }, { count: 300 }),
      session("2026-10-23", OCT, { open: 103, high: 104, low: 102, close: 103 }),
    ]);
    expect(moves[1]).toMatchObject({ complete: false, rangePoints: null, rangePercentOfOpen: null, closeToClosePoints: null });
    // The incomplete day still shows what it traded, but its last bar is not a close.
    expect(moves[1]!.high).toBe(105);
    expect(moves[2]).toMatchObject({ complete: true, closeToClosePoints: null, rangePoints: 2 });
  });

  it("does not treat a session still running as complete, even with all its bars so far", () => {
    const [move] = buildSessionMoves([session("2026-10-23", OCT, { open: 100, high: 105, low: 99, close: 103 }, { inProgress: true })]);
    expect(move).toMatchObject({ complete: false, inProgress: true, rangePoints: null, closeToClosePoints: null });
  });

  it("is empty for no sessions, and has no figures for a session with no regular bars", () => {
    expect(buildSessionMoves([])).toEqual([]);
    const [move] = buildSessionMoves([{ sessionDate: "2026-10-21", symbol: OCT, bars: [], inProgress: false }]);
    expect(move).toMatchObject({ complete: false, open: null, high: null, low: null, close: null, rangePoints: null });
  });
});

describe("summariseMoves", () => {
  // Closes 100, 104, 101, 106, 104: close-to-close +4, -3, +5, -2.
  const moves = buildSessionMoves([
    session("2026-10-19", OCT, { open: 100, high: 101, low: 99, close: 100 }),
    session("2026-10-20", OCT, { open: 100, high: 106, low: 99, close: 104 }),
    session("2026-10-21", OCT, { open: 104, high: 105, low: 100, close: 101 }),
    session("2026-10-22", OCT, { open: 101, high: 108, low: 100, close: 106 }),
    session("2026-10-23", OCT, { open: 106, high: 107, low: 102, close: 104 }),
  ]);

  it("averages the absolute close-to-close moves and the ranges over the window, and says which dates it covers", () => {
    const stats = summariseMoves(moves, 4);
    // The newest four sessions: 10-20 (+4), 10-21 (-3), 10-22 (+5), 10-23 (-2).
    expect(stats).toMatchObject({ sessionsInWindow: 4, closeToCloseCount: 4, rangeCount: 4, fromDate: "2026-10-20", toDate: "2026-10-23" });
    expect(stats.meanAbsCloseToClosePoints).toBe(3.5);          // (4 + 3 + 5 + 2) / 4
    expect(stats.medianAbsCloseToClosePoints).toBe(3.5);        // 2, 3, 4, 5
    expect(stats.meanRangePoints).toBe(6.25);                   // (7 + 5 + 8 + 5) / 4 = 25 / 4
    expect(stats.meanAbsCloseToClosePercent).toBeCloseTo((4 / 100 + 3 / 104 + 5 / 101 + 2 / 106) / 4 * 100, 10);
    expect(stats.meanRangePercentOfOpen).toBeCloseTo((7 / 100 + 5 / 104 + 8 / 101 + 5 / 106) / 4 * 100, 10);
  });

  it("uses only the newest sessions when the window is shorter than what is stored", () => {
    const stats = summariseMoves(moves, 2);
    expect(stats).toMatchObject({ sessionsInWindow: 2, fromDate: "2026-10-22", toDate: "2026-10-23" });
    expect(stats.meanAbsCloseToClosePoints).toBe(3.5);          // (5 + 2) / 2
  });

  it("counts the sessions that have no figure instead of averaging fewer as if they were the window", () => {
    // 10-19 has no previous session, so with a window of 5 it has a range but no close-to-close move.
    const stats = summariseMoves(moves, 5);
    expect(stats).toMatchObject({ sessionsInWindow: 5, closeToCloseCount: 4, rangeCount: 5 });
  });

  it("leaves a session that is still running out of the window altogether", () => {
    const running = [...moves.slice(0, 4), { ...moves[4]!, inProgress: true }];
    const stats = summariseMoves(running, 4);
    expect(stats).toMatchObject({ sessionsInWindow: 4, toDate: "2026-10-22" });
  });

  it("has no figures for an empty history", () => {
    expect(summariseMoves([], 10)).toEqual({
      sessionsInWindow: 0, closeToCloseCount: 0, rangeCount: 0, meanAbsCloseToClosePoints: null, medianAbsCloseToClosePoints: null,
      meanAbsCloseToClosePercent: null, meanRangePoints: null, meanRangePercentOfOpen: null, fromDate: null, toDate: null,
    });
  });
});
