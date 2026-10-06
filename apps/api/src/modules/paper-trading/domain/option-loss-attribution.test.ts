import { describe, expect, it } from "vitest";
import { computeOptionLossAttribution } from "./option-loss-attribution.js";

const ENTRY_TIME = new Date("2026-08-07T09:30:00.000Z");
const EXIT_TIME = new Date("2026-08-07T10:00:00.000Z");
const EXPIRY = new Date("2026-08-25T10:00:00.000Z");

describe("computeOptionLossAttribution (O3 Counterfactual Attribution)", () => {
  it("returns RESEARCH_MARK_UNAVAILABLE when research marks are missing", () => {
    const res = computeOptionLossAttribution({
      side: "LONG",
      quantity: 15,
      optionType: "CE",
      optionStrike: 56000,
      optionExpiry: EXPIRY,
      openedAt: ENTRY_TIME,
      closedAt: EXIT_TIME,
      actualEntryPrice: 2110,
      actualExitPrice: 2150,
      entryFees: 20,
      exitFees: 20,
      underlyingEntryPrice: 57720,
      underlyingExitPrice: 57800,
      entryIv: 0.33,
      exitIv: 0.34,
      researchEntryOptionPrice: null,
      researchExitOptionPrice: 2148,
    });

    expect(res.attributionStatus).toBe("RESEARCH_MARK_UNAVAILABLE");
    expect(res.deltaPResearch).toBeNull();
    expect(res.attributionResidual).toBeNull();
    expect(res.deltaPSpot).toBeNull();
    expect(res.realizedGrossPnL).toBe(15 * 1 * (2150 - 2110));
    expect(res.realizedNetPnL).toBe(600 - 40);
  });

  it("calculates attributionResidual = deltaPResearch - (P3 - P0)", () => {
    const res = computeOptionLossAttribution({
      side: "LONG",
      quantity: 15,
      optionType: "CE",
      optionStrike: 56000,
      optionExpiry: EXPIRY,
      openedAt: ENTRY_TIME,
      closedAt: EXIT_TIME,
      actualEntryPrice: 2110,
      actualExitPrice: 2150,
      entryFees: 20,
      exitFees: 20,
      underlyingEntryPrice: 57720,
      underlyingExitPrice: 57800,
      entryIv: 0.33,
      exitIv: 0.34,
      researchEntryOptionPrice: 2105,
      researchExitOptionPrice: 2148,
      researchEntryBarTime: ENTRY_TIME,
      researchExitBarTime: EXIT_TIME,
    });

    expect(res.attributionStatus).toBe("COMPLETED");
    expect(res.deltaPResearch).toBe(2148 - 2105); // 43
    expect(res.deltaPModel).not.toBeNull();
    expect(res.attributionResidual).not.toBeNull();
    // Verify residual equation: attributionResidual = deltaPResearch - deltaPModel
    expect(res.attributionResidual!).toBeCloseTo(res.deltaPResearch! - res.deltaPModel!, 6);
  });

  it("decomposes deltaPModel into deltaPSpot, deltaPTime, and deltaPVol", () => {
    const res = computeOptionLossAttribution({
      side: "LONG",
      quantity: 15,
      optionType: "CE",
      optionStrike: 56000,
      optionExpiry: EXPIRY,
      openedAt: ENTRY_TIME,
      closedAt: EXIT_TIME,
      actualEntryPrice: 2110,
      actualExitPrice: 2150,
      entryFees: 20,
      exitFees: 20,
      underlyingEntryPrice: 57720,
      underlyingExitPrice: 57800,
      entryIv: 0.33,
      exitIv: 0.34,
      researchEntryOptionPrice: 2105,
      researchExitOptionPrice: 2148,
    });

    expect(res.deltaPSpot).not.toBeNull();
    expect(res.deltaPTime).not.toBeNull();
    expect(res.deltaPVol).not.toBeNull();

    // Verify model sum: P3 - P0 = deltaPSpot + deltaPTime + deltaPVol
    const modelSum = res.deltaPSpot! + res.deltaPTime! + res.deltaPVol!;
    expect(res.deltaPModel!).toBeCloseTo(modelSum, 6);
  });
});
