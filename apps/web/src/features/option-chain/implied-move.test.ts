import { describe, expect, it } from "vitest";
import {
  NORMAL_MEAN_ABSOLUTE,
  bandText,
  buildImpliedMove,
  compareMoves,
  comparisonSentence,
  impliedMoveNotes,
  type ImpliedMoveInput,
  type RealizedStatsInput,
} from "./implied-move";

/** Synthetic inputs, hand-built for the arithmetic (not recorded from the API). */
const SPOT = 22_600;

const input = (overrides: Partial<ImpliedMoveInput> = {}): ImpliedMoveInput => ({
  spot: SPOT,
  atmStrike: 22_600,
  atmCall: { bid: 160, ask: 164 },     // mid 162
  atmPut: { bid: 148, ask: 152 },      // mid 150
  atmIv: 0.15,
  daysToExpiry: 4,
  ...overrides,
});

const realized = (overrides: Partial<RealizedStatsInput> = {}): RealizedStatsInput => ({
  sessionsInWindow: 10, closeToCloseCount: 10, rangeCount: 10,
  meanAbsCloseToClosePoints: 150, meanAbsCloseToClosePercent: 0.66, meanRangePoints: 260, meanRangePercentOfOpen: 1.15,
  fromDate: "2026-10-09", toDate: "2026-10-22", ...overrides,
});

describe("straddle", () => {
  it("is the ATM call mid plus the put mid, with the breakevens at the strike plus and minus it", () => {
    const { straddle } = buildImpliedMove(input());
    expect(straddle).toMatchObject({ callMid: 162, putMid: 150, points: 312, lowerBreakeven: 22_288, upperBreakeven: 22_912 });
    expect(straddle!.percentOfSpot).toBeCloseTo((312 / 22_600) * 100, 12);
  });

  it("is absent, not zero, when either leg is not two-sided", () => {
    expect(buildImpliedMove(input({ atmCall: { bid: null, ask: 164 } })).straddle).toBeNull();
    expect(buildImpliedMove(input({ atmPut: { bid: 148, ask: null } })).straddle).toBeNull();
    expect(buildImpliedMove(input({ atmCall: null })).straddle).toBeNull();
  });

  it("does not take a zero bid or a crossed quote as a price", () => {
    expect(buildImpliedMove(input({ atmCall: { bid: 0, ask: 164 } })).straddle).toBeNull();
    expect(buildImpliedMove(input({ atmPut: { bid: 152, ask: 148 } })).straddle).toBeNull();
  });

  it("is absent without an ATM strike or a spot", () => {
    expect(buildImpliedMove(input({ atmStrike: null })).straddle).toBeNull();
    expect(buildImpliedMove(input({ spot: null })).straddle).toBeNull();
  });
});

describe("implied move from the volatility", () => {
  it("gives one standard deviation to expiry on calendar time, and a daily band over the two day-count conventions", () => {
    const move = buildImpliedMove(input());
    expect(move.oneSigmaToExpiryPoints).toBeCloseTo(SPOT * 0.15 * Math.sqrt(4 / 365), 9);
    expect(move.oneSigmaDailyPoints!.low).toBeCloseTo((SPOT * 0.15) / Math.sqrt(365), 9);
    expect(move.oneSigmaDailyPoints!.high).toBeCloseTo((SPOT * 0.15) / Math.sqrt(252), 9);
    // The trading-day convention is sqrt(365 / 252) = 1.2035 times the calendar-day one.
    expect(move.oneSigmaDailyPoints!.high / move.oneSigmaDailyPoints!.low).toBeCloseTo(Math.sqrt(365 / 252), 12);
  });

  it("takes the expected absolute daily move as sqrt(2/pi) of one standard deviation, in points and in percent", () => {
    const move = buildImpliedMove(input());
    expect(NORMAL_MEAN_ABSOLUTE).toBeCloseTo(0.7978845608, 9);
    expect(move.expectedAbsDailyPoints!.low).toBeCloseTo(move.oneSigmaDailyPoints!.low * NORMAL_MEAN_ABSOLUTE, 9);
    expect(move.expectedAbsDailyPercent!.low).toBeCloseTo((0.15 / Math.sqrt(365)) * NORMAL_MEAN_ABSOLUTE * 100, 9);
    expect(move.expectedAbsDailyPercent!.high).toBeCloseTo((0.15 / Math.sqrt(252)) * NORMAL_MEAN_ABSOLUTE * 100, 9);
  });

  it("has no volatility-based figure without a volatility, a spot, or (for the move to expiry) days to expiry", () => {
    const none = buildImpliedMove(input({ atmIv: null }));
    expect([none.oneSigmaToExpiryPoints, none.oneSigmaDailyPoints, none.expectedAbsDailyPoints, none.expectedAbsDailyPercent]).toEqual([null, null, null, null]);
    expect(buildImpliedMove(input({ atmIv: 0 })).oneSigmaDailyPoints).toBeNull();
    expect(buildImpliedMove(input({ spot: null })).oneSigmaDailyPoints).toBeNull();
    const noDays = buildImpliedMove(input({ daysToExpiry: 0 }));
    expect(noDays.oneSigmaToExpiryPoints).toBeNull();
    expect(noDays.oneSigmaDailyPoints).not.toBeNull();
  });

  /**
   * An independent check of the convention against option prices: for a forward-at-the-money straddle with no interest, the
   * Black-Scholes premium is 2F(2N(s/2) - 1) with s = sigma sqrt(T), written here with its own normal CDF, and it is within about
   * 0.1% of sqrt(2/pi) F s, the expected absolute move this module takes from the same volatility and time.
   */
  it("agrees with the Black-Scholes at-the-money straddle premium for the same volatility and time", () => {
    const cdf = (x: number) => {
      const z = Math.abs(x) / Math.SQRT2;
      const t = 1 / (1 + 0.3275911 * z);
      const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
      return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
    };
    const forward = 100;
    const sigma = 0.2;
    const days = 91.25;     // a quarter of 365
    const s = sigma * Math.sqrt(days / 365);
    const straddlePremium = 2 * forward * (2 * cdf(s / 2) - 1);
    const move = buildImpliedMove({ spot: forward, atmStrike: forward, atmCall: null, atmPut: null, atmIv: sigma, daysToExpiry: days });
    const expectedAbsToExpiry = move.oneSigmaToExpiryPoints! * NORMAL_MEAN_ABSOLUTE;
    expect(Math.abs(expectedAbsToExpiry - straddlePremium) / straddlePremium).toBeLessThan(0.002);
    expect(straddlePremium).toBeCloseTo(7.9756, 3);
  });
});

describe("compareMoves", () => {
  it("divides the realized mean absolute move by the implied expected absolute daily move, as a range over the convention", () => {
    const implied = buildImpliedMove(input());
    const { ratio, realizedPoints, realizedPercent } = compareMoves(implied, realized());
    expect(realizedPoints).toBe(150);
    expect(realizedPercent).toBe(0.66);
    expect(ratio!.low).toBeCloseTo(150 / implied.expectedAbsDailyPoints!.high, 12);
    expect(ratio!.high).toBeCloseTo(150 / implied.expectedAbsDailyPoints!.low, 12);
    expect(ratio!.low).toBeLessThan(ratio!.high);
  });

  it("has no ratio without both sides", () => {
    expect(compareMoves(buildImpliedMove(input({ atmIv: null })), realized()).ratio).toBeNull();
    expect(compareMoves(buildImpliedMove(input()), null).ratio).toBeNull();
    expect(compareMoves(buildImpliedMove(input()), realized({ meanAbsCloseToClosePoints: null })).ratio).toBeNull();
  });
});

describe("bandText", () => {
  it("prints low-high, or one figure when they agree at the displayed precision", () => {
    expect(bandText({ low: 141.2, high: 170.9 })).toBe("141–171");
    expect(bandText({ low: 150.2, high: 150.4 })).toBe("150");
    expect(bandText({ low: 0.5, high: 0.6 }, (v) => `${v.toFixed(2)}×`)).toBe("0.50×–0.60×");
  });
});

describe("comparisonSentence", () => {
  const implied = buildImpliedMove(input());     // expected abs daily 141.5 to 170.4 points

  it("says the realized move is below the implied one when it is below the whole range", () => {
    const sentence = comparisonSentence(implied, realized({ meanAbsCloseToClosePoints: 100 }))!;
    expect(sentence).toContain("moved 100 points on average from one close to the next, below the 142–170 points");
    expect(sentence).toContain("Over the last 10 sessions (2026-10-09 to 2026-10-22)");
    expect(sentence).toContain("(0.59×–0.71× of it, over the two day-count conventions)");
  });

  it("says above when it is above the whole range, and around when the range straddles one", () => {
    expect(comparisonSentence(implied, realized({ meanAbsCloseToClosePoints: 250 }))).toContain("above the");
    expect(comparisonSentence(implied, realized({ meanAbsCloseToClosePoints: 155 }))).toContain("around the");
  });

  it("uses the singular for one session, and is null without both sides", () => {
    expect(comparisonSentence(implied, realized({ closeToCloseCount: 1, sessionsInWindow: 1 }))).toContain("the last 1 session (");
    expect(comparisonSentence(buildImpliedMove(input({ atmIv: null })), realized())).toBeNull();
    expect(comparisonSentence(implied, null)).toBeNull();
  });
});

describe("impliedMoveNotes", () => {
  it("is silent when everything is present and the whole window has a move", () => {
    expect(impliedMoveNotes(buildImpliedMove(input()), input(), realized())).toEqual([]);
  });

  it("says why a figure is missing instead of showing a blank or a zero", () => {
    const texts = impliedMoveNotes(buildImpliedMove(input({ atmCall: null, atmIv: null })), input({ atmCall: null, atmIv: null }), null).map((note) => note.text);
    expect(texts).toEqual([
      "The ATM straddle is not shown: one of the ATM legs has no two-sided quote (an unquoted leg is unknown, not cheap).",
      "No implied volatility could be solved at the money, so no implied daily move is shown.",
      "No realized moves are available: no finished futures session is stored.",
    ]);
  });

  it("does not warn about missing realized data that was not due: still loading, failed, or no futures for the underlying", () => {
    const texts = impliedMoveNotes(buildImpliedMove(input()), input(), null, false).map((note) => note.text);
    expect(texts).toEqual([]);
  });

  it("says how many sessions of the window have no close-to-close move, and that they are left out rather than counted as zero", () => {
    const [note] = impliedMoveNotes(buildImpliedMove(input()), input(), realized({ closeToCloseCount: 8 }));
    expect(note!.text).toBe("8 of the 10 sessions in the window have a close-to-close move (the others follow a contract roll or an incomplete session) and are left out of that average, not counted as zero.");
  });
});
