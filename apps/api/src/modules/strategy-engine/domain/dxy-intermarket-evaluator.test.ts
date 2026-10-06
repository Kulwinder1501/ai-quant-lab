import { describe, expect, it } from "vitest";
import {
  DxyIntermarketEvaluator,
  evaluateAlignment,
  evaluateDxyBias,
  evaluateDxyMomentum,
  evaluateDxyTrend,
  evaluateSmtDivergence,
  type ConfirmedSwing,
  type DxyEvaluatorInputs,
} from "./dxy-intermarket-evaluator.js";

describe("DxyIntermarketEvaluator & Domain Utilities", () => {
  const baseInputs: DxyEvaluatorInputs = {
    proposalSide: "LONG",
    proposalTimeframe: "15m",
    candidateAt: "2026-09-30T19:00:00.000Z",
    dataCutoff: "2026-09-30T19:00:00.000Z",
    decisionAt: "2026-09-30T19:00:02.000Z",

    dxyCandleAvailableAt: "2026-09-30T18:55:00.000Z",
    dxyEma20: { value: 97.2, availableAt: "2026-09-30T18:55:00.000Z" },
    dxyEma50: { value: 97.3, availableAt: "2026-09-30T18:55:00.000Z" },
    dxyEma20Slope: -0.01,
    dxyRoc3: { value: -0.002, availableAt: "2026-09-30T18:55:00.000Z" },
    dxyRoc5: { value: -0.003, availableAt: "2026-09-30T18:55:00.000Z" },
    dxyStructure: { event: "BOS_DOWN", confirmedAt: "2026-09-30T18:55:00.000Z" },
    dxyLocation: { location: "AT_BEARISH_FVG", availableAt: "2026-09-30T18:55:00.000Z" },

    xauCandleAvailableAt: "2026-09-30T18:55:00.000Z",
    xauATR14: { value: 2.5, availableAt: "2026-09-30T18:55:00.000Z" },
    dxyATR14: { value: 0.05, availableAt: "2026-09-30T18:55:00.000Z" },

    xauSwings: [],
    dxySwings: [],
  };

  it("enforces timestamp hierarchy invariant (candidateAt <= dataCutoff <= decisionAt)", () => {
    const evaluator = new DxyIntermarketEvaluator();

    expect(() =>
      evaluator.evaluate({
        ...baseInputs,
        candidateAt: "2026-09-30T19:05:00.000Z", // Invalid: > dataCutoff
      })
    ).toThrowError(/PIT Timestamp Hierarchy Violation/);

    expect(() =>
      evaluator.evaluate({
        ...baseInputs,
        decisionAt: "2026-09-30T18:59:59.000Z", // Invalid: < dataCutoff
      })
    ).toThrowError(/PIT Timestamp Hierarchy Violation/);
  });

  it("calculates dxyBias according to deterministic hierarchy", () => {
    expect(evaluateDxyBias("BOS_UP", "STRONG_UP")).toBe("BULLISH");
    expect(evaluateDxyBias("CHOCH_DOWN", "DOWN")).toBe("BEARISH");
    expect(evaluateDxyBias("BOS_UP", "FLAT")).toBe("BULLISH");
    expect(evaluateDxyBias("CHOCH_DOWN", "FLAT")).toBe("BEARISH");
    expect(evaluateDxyBias("NONE", "STRONG_UP")).toBe("BULLISH");
    expect(evaluateDxyBias("NONE", "STRONG_DOWN")).toBe("BEARISH");
    expect(evaluateDxyBias("NONE", "FLAT")).toBe("NEUTRAL");
  });

  it("calculates dxyTrend and dxyMomentum correctly", () => {
    expect(evaluateDxyTrend(97.5, 97.2, 0.01)).toBe("BULLISH");
    expect(evaluateDxyTrend(97.1, 97.4, -0.01)).toBe("BEARISH");
    expect(evaluateDxyTrend(97.5, 97.2, -0.01)).toBe("NEUTRAL");

    expect(evaluateDxyMomentum(0.002, 0.003)).toBe("STRONG_UP");
    expect(evaluateDxyMomentum(0.0005, 0.0001)).toBe("UP");
    expect(evaluateDxyMomentum(-0.002, -0.003)).toBe("STRONG_DOWN");
    expect(evaluateDxyMomentum(-0.0005, 0)).toBe("DOWN");
    expect(evaluateDxyMomentum(0, 0)).toBe("FLAT");
  });

  it("evaluates opposite-type SMT divergence correctly (Bullish: Gold Low vs DXY High)", () => {
    const dataCutoff = "2026-09-30T19:00:00.000Z";
    const xauSwings: ConfirmedSwing[] = [
      { type: "LOW", price: 3810.0, swingAt: "2026-09-30T18:00:00.000Z", confirmedAt: "2026-09-30T18:05:00.000Z" },
      { type: "LOW", price: 3805.0, swingAt: "2026-09-30T18:30:00.000Z", confirmedAt: "2026-09-30T18:35:00.000Z" }, // Lower Low (-5.00)
    ];
    const dxySwings: ConfirmedSwing[] = [
      { type: "HIGH", price: 97.5, swingAt: "2026-09-30T18:00:00.000Z", confirmedAt: "2026-09-30T18:05:00.000Z" },
      { type: "HIGH", price: 97.4, swingAt: "2026-09-30T18:30:00.000Z", confirmedAt: "2026-09-30T18:35:00.000Z" }, // Failed Higher High (-0.10)
    ];

    const res = evaluateSmtDivergence(xauSwings, dxySwings, dataCutoff, 2.5, 0.05);
    expect(res.state).toBe("BULLISH_XAU_DXY");
  });

  it("evaluates opposite-type SMT divergence correctly (Bearish: Gold High vs DXY Low)", () => {
    const dataCutoff = "2026-09-30T19:00:00.000Z";
    const xauSwings: ConfirmedSwing[] = [
      { type: "HIGH", price: 3810.0, swingAt: "2026-09-30T18:00:00.000Z", confirmedAt: "2026-09-30T18:05:00.000Z" },
      { type: "HIGH", price: 3815.0, swingAt: "2026-09-30T18:30:00.000Z", confirmedAt: "2026-09-30T18:35:00.000Z" }, // Higher High (+5.00)
    ];
    const dxySwings: ConfirmedSwing[] = [
      { type: "LOW", price: 97.1, swingAt: "2026-09-30T18:00:00.000Z", confirmedAt: "2026-09-30T18:05:00.000Z" },
      { type: "LOW", price: 97.2, swingAt: "2026-09-30T18:30:00.000Z", confirmedAt: "2026-09-30T18:35:00.000Z" }, // Failed Lower Low (+0.10)
    ];

    const res = evaluateSmtDivergence(xauSwings, dxySwings, dataCutoff, 2.5, 0.05);
    expect(res.state).toBe("BEARISH_XAU_DXY");
  });

  it("tests voting matrix for LONG and SHORT", () => {
    // LONG
    expect(evaluateAlignment("LONG", "BEARISH", "BULLISH_XAU_DXY")).toBe("SUPPORTIVE"); // +2
    expect(evaluateAlignment("LONG", "BEARISH", "NONE_CONFIRMED")).toBe("SUPPORTIVE");  // +1
    expect(evaluateAlignment("LONG", "NEUTRAL", "NONE_CONFIRMED")).toBe("NEUTRAL");     // 0
    expect(evaluateAlignment("LONG", "BULLISH", "NONE_CONFIRMED")).toBe("OPPOSING");    // -1

    // SHORT
    expect(evaluateAlignment("SHORT", "BULLISH", "BEARISH_XAU_DXY")).toBe("SUPPORTIVE"); // +2
    expect(evaluateAlignment("SHORT", "BULLISH", "NONE_CONFIRMED")).toBe("SUPPORTIVE");  // +1
    expect(evaluateAlignment("SHORT", "NEUTRAL", "NONE_CONFIRMED")).toBe("NEUTRAL");     // 0
    expect(evaluateAlignment("SHORT", "BEARISH", "NONE_CONFIRMED")).toBe("OPPOSING");    // -1
  });

  it("tests freshness boundary rules (299s, 300s, 301s)", () => {
    const evaluator = new DxyIntermarketEvaluator();

    // 299s age -> Available
    const payload299 = evaluator.evaluate({
      ...baseInputs,
      dataCutoff: "2026-09-30T19:00:00.000Z",
      dxyCandleAvailableAt: "2026-09-30T18:55:01.000Z", // 299s
      dxyEma20: { value: 97.2, availableAt: "2026-09-30T18:55:01.000Z" },
      dxyEma50: { value: 97.3, availableAt: "2026-09-30T18:55:01.000Z" },
      dxyRoc3: { value: -0.002, availableAt: "2026-09-30T18:55:01.000Z" },
      dxyRoc5: { value: -0.003, availableAt: "2026-09-30T18:55:01.000Z" },
      dxyStructure: { event: "BOS_DOWN", confirmedAt: "2026-09-30T18:55:01.000Z" },
      dxyLocation: { location: "AT_BEARISH_FVG", availableAt: "2026-09-30T18:55:01.000Z" },
      xauCandleAvailableAt: "2026-09-30T18:55:01.000Z",
      xauATR14: { value: 2.5, availableAt: "2026-09-30T18:55:01.000Z" },
      dxyATR14: { value: 0.05, availableAt: "2026-09-30T18:55:01.000Z" },
    });
    expect(payload299.freshness.ageSeconds).toBe(299);
    expect(payload299.alignment).toBe("SUPPORTIVE");

    // 300s age -> Available
    const payload300 = evaluator.evaluate({
      ...baseInputs,
      dataCutoff: "2026-09-30T19:00:00.000Z",
      dxyCandleAvailableAt: "2026-09-30T18:55:00.000Z", // 300s
      dxyEma20: { value: 97.2, availableAt: "2026-09-30T18:55:00.000Z" },
      dxyEma50: { value: 97.3, availableAt: "2026-09-30T18:55:00.000Z" },
      dxyRoc3: { value: -0.002, availableAt: "2026-09-30T18:55:00.000Z" },
      dxyRoc5: { value: -0.003, availableAt: "2026-09-30T18:55:00.000Z" },
      dxyStructure: { event: "BOS_DOWN", confirmedAt: "2026-09-30T18:55:00.000Z" },
      dxyLocation: { location: "AT_BEARISH_FVG", availableAt: "2026-09-30T18:55:00.000Z" },
      xauCandleAvailableAt: "2026-09-30T18:55:00.000Z",
      xauATR14: { value: 2.5, availableAt: "2026-09-30T18:55:00.000Z" },
      dxyATR14: { value: 0.05, availableAt: "2026-09-30T18:55:00.000Z" },
    });
    expect(payload300.freshness.ageSeconds).toBe(300);
    expect(payload300.alignment).toBe("SUPPORTIVE");

    // 301s age -> FEATURE_UNAVAILABLE
    const payload301 = evaluator.evaluate({
      ...baseInputs,
      dataCutoff: "2026-09-30T19:00:00.000Z",
      dxyCandleAvailableAt: "2026-09-30T18:54:59.000Z", // 301s
      dxyEma20: { value: 97.2, availableAt: "2026-09-30T18:54:59.000Z" },
      dxyEma50: { value: 97.3, availableAt: "2026-09-30T18:54:59.000Z" },
      dxyRoc3: { value: -0.002, availableAt: "2026-09-30T18:54:59.000Z" },
      dxyRoc5: { value: -0.003, availableAt: "2026-09-30T18:54:59.000Z" },
      dxyStructure: { event: "BOS_DOWN", confirmedAt: "2026-09-30T18:54:59.000Z" },
      dxyLocation: { location: "AT_BEARISH_FVG", availableAt: "2026-09-30T18:54:59.000Z" },
      xauCandleAvailableAt: "2026-09-30T18:54:59.000Z",
      xauATR14: { value: 2.5, availableAt: "2026-09-30T18:54:59.000Z" },
      dxyATR14: { value: 0.05, availableAt: "2026-09-30T18:54:59.000Z" },
    });
    expect(payload301.freshness.ageSeconds).toBe(301);
    expect(payload301.alignment).toBe("FEATURE_UNAVAILABLE");
  });

  it("calculates deterministic counterfactual outcomes (1m OPEN at entryAt, 1m CLOSE at exitAt)", () => {
    const evaluator = new DxyIntermarketEvaluator();

    const payload = evaluator.evaluate({
      ...baseInputs,
      proposalSide: "LONG",
      decisionAt: "2026-09-30T19:00:02.000Z",
      xau1mBars: [
        {
          openAt: "2026-09-30T19:01:00.000Z",
          closeAt: "2026-09-30T19:02:00.000Z",
          open: 3800.0,
          high: 3802.0,
          low: 3799.0,
          close: 3801.0,
        },
        {
          openAt: "2026-09-30T19:15:00.000Z",
          closeAt: "2026-09-30T19:16:00.000Z",
          open: 3802.0,
          high: 3805.0,
          low: 3801.0,
          close: 3804.5,
        },
      ],
    });

    expect(payload.entryAt).toBe("2026-09-30T19:01:00.000Z");
    expect(payload.exitTargetAt).toBe("2026-09-30T19:16:00.000Z");
    expect(payload.exitAt).toBe("2026-09-30T19:16:00.000Z");
    expect(payload.outcomes).toBeDefined();
    expect(payload.outcomes?.researchEntryPrice).toBe(3800.0);
    expect(payload.outcomes?.researchExitPrice).toBe(3804.5);
    expect(payload.outcomes?.grossForwardOutcome15m).toBe(4.5);
    expect(payload.outcomes?.netForwardOutcome15m).toBe(4.3); // 4.5 - 0.20
    expect(payload.outcomes?.outcomeStatus).toBe("AVAILABLE");
  });
});
