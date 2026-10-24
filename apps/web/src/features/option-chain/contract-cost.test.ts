import { describe, expect, it } from "vitest";
import { buildImpliedMove } from "./implied-move";
import {
  buildContractCost,
  contractCostNotes,
  hurdleSentence,
  type CostLeg,
  type ContractCostInput,
} from "./contract-cost";

/** Synthetic contracts, hand-built for the arithmetic (not recorded from the API). */
const SPOT = 54_300;

const leg = (overrides: Partial<CostLeg> = {}): CostLeg => ({
  bid: 330, ask: 336, impliedVolatility: 0.15, delta: 0.5, gamma: 0.0004, theta: -12, daysToExpiry: 4, ...overrides,
});

const input = (overrides: Partial<ContractCostInput> = {}): ContractCostInput => ({
  optionType: "CE", strike: 54_300, spot: SPOT, leg: leg(), ...overrides,
});

const implied = buildImpliedMove({ spot: SPOT, atmStrike: 54_300, atmCall: null, atmPut: null, atmIv: 0.15, daysToExpiry: 4 });

describe("the price of getting in and out", () => {
  it("takes the spread from the bid and the ask, and the round trip as a share of what was paid", () => {
    const { quote, roundTripPercentOfAsk } = buildContractCost(input(), null);
    expect(quote).toMatchObject({ bid: 330, ask: 336, mid: 333, spreadPoints: 6 });
    expect(quote!.spreadPercentOfMid).toBeCloseTo((6 / 333) * 100, 12);     // 1.8018%
    expect(roundTripPercentOfAsk).toBeCloseTo((6 / 336) * 100, 12);         // 1.7857%
  });

  it("derives nothing from a quote that is not two-sided: a zero bid is nobody bidding, a crossed one is not a price", () => {
    for (const bad of [{ bid: 0 }, { bid: null }, { ask: null }, { bid: 340, ask: 336 }, { bid: Number.NaN }]) {
      const cost = buildContractCost(input({ leg: leg(bad) }), implied);
      expect([cost.quote, cost.roundTripPercentOfAsk, cost.breakevenAtExpiry, cost.neededMove, cost.neededOverDaily, cost.neededOverToExpiry, cost.timeValue, cost.thetaLossPercentOfAsk], JSON.stringify(bad)).toEqual([null, null, null, null, null, null, null, null]);
    }
  });

  it("has nothing for a contract that is not in the chain", () => {
    const cost = buildContractCost(input({ leg: null }), implied);
    expect(cost.quote).toBeNull();
    expect(cost.delta).toBeNull();
  });
});

describe("breakeven at expiry and the move it needs", () => {
  it("is the strike plus the ask for a call, and the index has to rise by that much from the money", () => {
    const { breakevenAtExpiry, neededMove } = buildContractCost(input(), null);
    expect(breakevenAtExpiry).toBe(54_636);
    expect(neededMove).toMatchObject({ points: 336, direction: "up", alreadyPastBreakeven: false });
    expect(neededMove!.percentOfSpot).toBeCloseTo((336 / 54_300) * 100, 12);   // 0.6188%
  });

  it("is the strike minus the ask for a put, and out of the money the hurdle includes the distance to the strike", () => {
    // Put 54,000, ask 150: breakeven 53,850, which is 450 below the 54,300 spot (300 of distance plus 150 of premium).
    const { breakevenAtExpiry, neededMove } = buildContractCost(input({ optionType: "PE", strike: 54_000, leg: leg({ bid: 146, ask: 150 }) }), null);
    expect(breakevenAtExpiry).toBe(53_850);
    expect(neededMove).toMatchObject({ points: 450, direction: "down" });
  });

  it("is only the time value in the money: ITM call 53,900 at 486 breaks even at 54,386, 86 above the spot", () => {
    const cost = buildContractCost(input({ strike: 53_900, leg: leg({ bid: 480, ask: 486 }) }), null);
    expect(cost.breakevenAtExpiry).toBe(54_386);
    expect(cost.neededMove!.points).toBe(86);
    expect(cost.intrinsic).toBe(400);
    expect(cost.timeValue).toBe(86);
    expect(cost.timeValueShareOfAsk).toBeCloseTo(86 / 486, 12);
    expect(cost.belowIntrinsic).toBe(false);
  });

  it("is behind the index only when the ask is below intrinsic value, and says so rather than hiding it", () => {
    // Call 53,900 at 390: intrinsic 400, so time value -10 and the breakeven 54,290 is 10 under the spot.
    const cost = buildContractCost(input({ strike: 53_900, leg: leg({ bid: 385, ask: 390 }) }), implied);
    expect(cost.timeValue).toBe(-10);
    expect(cost.belowIntrinsic).toBe(true);
    expect(cost.neededMove).toMatchObject({ points: -10, alreadyPastBreakeven: true });
    // No hurdle left, so no ratio against a typical move.
    expect(cost.neededOverDaily).toBeNull();
    expect(cost.neededOverToExpiry).toBeNull();
  });

  it("is absent without a spot, but the quote arithmetic that needs no spot is kept", () => {
    const cost = buildContractCost(input({ spot: null }), null);
    expect(cost.neededMove).toBeNull();
    expect(cost.intrinsic).toBeNull();
    expect(cost.timeValue).toBeNull();
    expect(cost.breakevenAtExpiry).toBe(54_636);
    expect(cost.quote!.spreadPoints).toBe(6);
  });
});

describe("the hurdle against a typical move", () => {
  it("divides the needed points by the expected absolute day (a range over the day-count conventions) and by one sigma to expiry", () => {
    const cost = buildContractCost(input(), implied);
    // 336 over 409.4 and 340.2 points a day, and over 852.7 points of one sigma to expiry: about 0.82 to 0.99, and 0.39.
    expect(cost.neededOverDaily!.low).toBeCloseTo(336 / implied.expectedAbsDailyPoints!.high, 12);
    expect(cost.neededOverDaily!.high).toBeCloseTo(336 / implied.expectedAbsDailyPoints!.low, 12);
    expect(cost.neededOverDaily!.low).toBeCloseTo(0.8208, 3);
    expect(cost.neededOverDaily!.high).toBeCloseTo(0.9877, 3);
    expect(cost.neededOverToExpiry).toBeCloseTo(336 / (54_300 * 0.15 * Math.sqrt(4 / 365)), 12);
    expect(cost.neededOverToExpiry).toBeCloseTo(0.394, 3);
  });

  it("has no ratio without an implied move, or without its volatility", () => {
    expect(buildContractCost(input(), null).neededOverDaily).toBeNull();
    const noVol = buildImpliedMove({ spot: SPOT, atmStrike: 54_300, atmCall: null, atmPut: null, atmIv: null, daysToExpiry: 4 });
    const cost = buildContractCost(input(), noVol);
    expect([cost.neededOverDaily, cost.neededOverToExpiry]).toEqual([null, null]);
  });
});

describe("theta", () => {
  it("turns the model's negative theta into a loss per calendar day, and a share of the ask", () => {
    const cost = buildContractCost(input(), null);
    expect(cost.thetaLossPerDay).toBe(12);
    expect(cost.thetaLossPercentOfAsk).toBeCloseTo((12 / 336) * 100, 12);   // 3.5714%
  });

  it("is absent, not zero, when no volatility could be solved for the leg", () => {
    const cost = buildContractCost(input({ leg: leg({ theta: null, delta: null, gamma: null, impliedVolatility: null }) }), null);
    expect([cost.thetaLossPerDay, cost.thetaLossPercentOfAsk, cost.delta, cost.gamma, cost.impliedVolatility]).toEqual([null, null, null, null, null]);
  });
});

describe("hurdleSentence", () => {
  it("states the breakeven, the needed move and where it sits against a typical day and against the move to expiry", () => {
    const cost = buildContractCost(input(), implied);
    expect(hurdleSentence(cost, "CE", 54_300)).toBe(
      "Bought at the ask of 336.00, the 54,300 call breaks even at expiry at 54,636: 336 points (0.62%) up from here, 0.82×–0.99× a typical day's absolute move and 0.39× one standard deviation to expiry.",
    );
  });

  it("says down for a put, and stops after the move when there is no implied move to compare with", () => {
    const cost = buildContractCost(input({ optionType: "PE", strike: 54_000, leg: leg({ bid: 146, ask: 150 }) }), null);
    expect(hurdleSentence(cost, "PE", 54_000)).toBe("Bought at the ask of 150.00, the 54,000 put breaks even at expiry at 53,850: 450 points (0.83%) down from here.");
  });

  it("calls a breakeven behind the index a bad quote", () => {
    const cost = buildContractCost(input({ strike: 53_900, leg: leg({ bid: 385, ask: 390 }) }), implied);
    const sentence = hurdleSentence(cost, "CE", 53_900)!;
    expect(sentence).toContain("already past by 10 points");
    expect(sentence).toContain("ask is below intrinsic value");
  });

  it("is null without a two-sided quote", () => {
    expect(hurdleSentence(buildContractCost(input({ leg: leg({ bid: 0 }) }), implied), "CE", 54_300)).toBeNull();
  });
});

describe("contractCostNotes", () => {
  it("is silent for an ordinary contract", () => {
    expect(contractCostNotes(buildContractCost(input(), implied), leg())).toEqual([]);
  });

  it("says when the contract is not stored, when there is no two-sided quote, and when the ask is below intrinsic", () => {
    expect(contractCostNotes(buildContractCost(input({ leg: null }), implied), null).map((n) => n.text)).toEqual(["This contract is not in the stored chain."]);
    const oneSided = leg({ bid: 0 });
    expect(contractCostNotes(buildContractCost(input({ leg: oneSided }), implied), oneSided)[0]!.text).toContain("No two-sided quote");
    const crossed = leg({ bid: 385, ask: 390 });
    const texts = contractCostNotes(buildContractCost(input({ strike: 53_900, leg: crossed }), implied), crossed).map((n) => n.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("below the option's intrinsic value");
  });

  it("says why there is no theta rather than showing a zero", () => {
    const unsolved = leg({ theta: null });
    const [note] = contractCostNotes(buildContractCost(input({ leg: unsolved }), implied), unsolved);
    expect(note).toMatchObject({ tone: "info" });
    expect(note!.text).toContain("No theta");
  });
});
