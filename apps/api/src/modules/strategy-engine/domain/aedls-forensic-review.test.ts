import { describe, expect, it } from "vitest";
import {
  calculatePlannedRiskRupees,
  calculateRealizedR,
  evaluate3BarExcursion,
  assessImmediateAdverseExcursion,
  assessUnderlyingOptionPnlDivergence,
  assessExcessiveSpreadSlippage,
  selectPrimaryObservedEvent,
  type ObservedEventEvidence,
  type CandleExtreme,
  type SynchronizedTickOrBar,
} from "./aedls-forensic-review.js";

describe("aedls-forensic-review", () => {
  describe("calculatePlannedRiskRupees", () => {
    it("calculates exact planned risk without multiplier", () => {
      // Entry 100, Stop 90, 50 units -> 10 * 50 = 500
      const risk = calculatePlannedRiskRupees({
        entryPrice: 100,
        stopLoss: 90,
        quantityUnits: 50,
      });
      expect(risk).toBe(500);
    });

    it("applies contract multiplier correctly when quantity is in lots", () => {
      // Entry 25000, Stop 24900, 2 lots, multiplier 25 -> 100 * 2 * 25 = 5000
      const risk = calculatePlannedRiskRupees({
        entryPrice: 25000,
        stopLoss: 24900,
        quantityUnits: 2,
        contractMultiplier: 25,
      });
      expect(risk).toBe(5000);
    });

    it("evaluates multiple lots when quantity is already total option units without double-multiplying", () => {
      // In paper_trades, 3 lots of NIFTY (lot size 25) is stored as quantityUnits = 75.
      // Entry 150, Stop 120 (30 pts unit risk) * 75 units = 2250 INR. Multiplier is 1.
      const risk = calculatePlannedRiskRupees({
        entryPrice: 150,
        stopLoss: 120,
        quantityUnits: 75,
        contractMultiplier: 1,
      });
      expect(risk).toBe(2250);
    });

    it("handles partial fills by pricing risk strictly on executed fill units", () => {
      // Planned was 75 units, but only 50 filled.
      // Unit risk = 30 pts * 50 filled units = 1500 INR.
      const partialFillRisk = calculatePlannedRiskRupees({
        entryPrice: 150,
        stopLoss: 120,
        quantityUnits: 50,
      });
      expect(partialFillRisk).toBe(1500);
    });

    it("throws on non-positive entry, stop, or quantity", () => {
      expect(() =>
        calculatePlannedRiskRupees({ entryPrice: 0, stopLoss: 90, quantityUnits: 10 }),
      ).toThrow("Entry price must be a positive finite number.");

      expect(() =>
        calculatePlannedRiskRupees({ entryPrice: 100, stopLoss: 0, quantityUnits: 10 }),
      ).toThrow("Stop loss must be a positive finite number.");

      expect(() =>
        calculatePlannedRiskRupees({ entryPrice: 100, stopLoss: 90, quantityUnits: 0 }),
      ).toThrow("Quantity units must be a positive finite number.");

      expect(() =>
        calculatePlannedRiskRupees({ entryPrice: 100, stopLoss: 90, quantityUnits: -25 }),
      ).toThrow("Quantity units must be a positive finite number.");

      expect(() =>
        calculatePlannedRiskRupees({ entryPrice: 100, stopLoss: 90, quantityUnits: NaN }),
      ).toThrow("Quantity units must be a positive finite number.");
    });

    it("throws when entry and stop are identical (zero risk denominator)", () => {
      expect(() =>
        calculatePlannedRiskRupees({ entryPrice: 100, stopLoss: 100, quantityUnits: 10 }),
      ).toThrow("Entry price and stop loss cannot be identical");
    });
  });

  describe("calculateRealizedR", () => {
    it("normalizes profit and loss correctly", () => {
      expect(calculateRealizedR(1000, 500)).toBe(2);
      expect(calculateRealizedR(-500, 500)).toBe(-1);
      expect(calculateRealizedR(-750, 500)).toBe(-1.5);
    });

    it("throws on non-positive or NaN planned risk, preventing NaN or infinity leaks", () => {
      expect(() => calculateRealizedR(100, 0)).toThrow("Planned risk rupees must be a positive finite number.");
      expect(() => calculateRealizedR(100, -50)).toThrow("Planned risk rupees must be a positive finite number.");
      expect(() => calculateRealizedR(100, NaN)).toThrow("Planned risk rupees must be a positive finite number.");
      expect(() => calculateRealizedR(100, Infinity)).toThrow("Planned risk rupees must be a positive finite number.");
      expect(() => calculateRealizedR(NaN, 500)).toThrow("Realized rupees must be a finite number.");
    });
  });

  describe("evaluate3BarExcursion & assessImmediateAdverseExcursion", () => {
    const entryTime = new Date("2026-10-14T09:30:00Z");
    const entryFillPrice = 100;
    const riskPerUnit = 10; // 1R = 10 points

    it("returns UNOBSERVABLE (INSUFFICIENT_DATA) if fewer than 3 bars are available", () => {
      const candles: CandleExtreme[] = [
        { openTime: new Date("2026-10-14T09:31:00Z"), high: 101, low: 99, close: 100 },
        { openTime: new Date("2026-10-14T09:32:00Z"), high: 102, low: 98, close: 101 },
      ];

      const assessment = assessImmediateAdverseExcursion({
        side: "LONG",
        entryFillPrice,
        riskPerUnit,
        postEntry1mCandles: candles,
        entryTime,
      });

      expect(assessment.label).toBe("UNOBSERVABLE");
      expect(assessment.evidenceStatus).toBe("INSUFFICIENT_DATA");
    });

    it("labels POSITIVE when MAE_3 >= 1.0R and MFE_3 < 0.2R (clear adverse breakdown)", () => {
      // 1R = 10 points. Entry = 100, Stop = 90.
      // Adverse >= 1.0R means price touched <= 90.
      // MFE_3 < 0.2R means high never exceeded 101.9 (0.19R = 1.9 pts).
      const candles: CandleExtreme[] = [
        { openTime: new Date("2026-10-14T09:31:00Z"), high: 101, low: 95, close: 96 },   // adverse 5 pts (0.5R), mfe 1 pt (0.1R)
        { openTime: new Date("2026-10-14T09:32:00Z"), high: 97, low: 89, close: 89.5 },  // adverse 11 pts (1.1R), mfe 0
        { openTime: new Date("2026-10-14T09:33:00Z"), high: 90, low: 88, close: 88.5 },
      ];

      const assessment = assessImmediateAdverseExcursion({
        side: "LONG",
        entryFillPrice,
        riskPerUnit,
        postEntry1mCandles: candles,
        entryTime,
      });

      expect(assessment.label).toBe("POSITIVE");
      expect(assessment.evidenceStatus).toBe("BAR_DERIVED_UNAMBIGUOUS");
    });

    it("labels NEGATIVE when trade had favorable follow-through (MFE_3 >= 0.2R)", () => {
      // High reaches 103 (0.3R >= 0.2R), then later drops to 89
      const candles: CandleExtreme[] = [
        { openTime: new Date("2026-10-14T09:31:00Z"), high: 103, low: 99, close: 102 },  // mfe 3 pts = 0.3R
        { openTime: new Date("2026-10-14T09:32:00Z"), high: 102, low: 95, close: 96 },
        { openTime: new Date("2026-10-14T09:33:00Z"), high: 96, low: 89, close: 89.5 },
      ];

      const assessment = assessImmediateAdverseExcursion({
        side: "LONG",
        entryFillPrice,
        riskPerUnit,
        postEntry1mCandles: candles,
        entryTime,
      });

      expect(assessment.label).toBe("NEGATIVE");
      expect(assessment.evidenceStatus).toBe("BAR_DERIVED_UNAMBIGUOUS");
    });

    it("labels UNOBSERVABLE (INTRABAR_AMBIGUOUS) if a single bar touches both adverse 1.0R and favorable 0.2R without tick order", () => {
      // Bar 1 touches high 103 (0.3R >= 0.2R) AND low 89 (1.1R >= 1.0R)
      // Without sub-bar tick ordering, it is impossible to know whether the trade stopped out first or ran favorably first.
      const candles: CandleExtreme[] = [
        { openTime: new Date("2026-10-14T09:31:00Z"), high: 103, low: 89, close: 91 },
        { openTime: new Date("2026-10-14T09:32:00Z"), high: 93, low: 88, close: 90 },
        { openTime: new Date("2026-10-14T09:33:00Z"), high: 91, low: 87, close: 88 },
      ];

      const assessment = assessImmediateAdverseExcursion({
        side: "LONG",
        entryFillPrice,
        riskPerUnit,
        postEntry1mCandles: candles,
        entryTime,
        tickSequenceVerified: false,
      });

      expect(assessment.label).toBe("UNOBSERVABLE");
      expect(assessment.evidenceStatus).toBe("INTRABAR_AMBIGUOUS");
    });

    it("labels TICK_VERIFIED when sub-bar tick sequence is confirmed", () => {
      const candles: CandleExtreme[] = [
        { openTime: new Date("2026-10-14T09:31:00Z"), high: 100.5, low: 88, close: 88.5 },
        { openTime: new Date("2026-10-14T09:32:00Z"), high: 89, low: 87, close: 87.5 },
        { openTime: new Date("2026-10-14T09:33:00Z"), high: 88, low: 86, close: 86.5 },
      ];

      const assessment = assessImmediateAdverseExcursion({
        side: "LONG",
        entryFillPrice,
        riskPerUnit,
        postEntry1mCandles: candles,
        entryTime,
        tickSequenceVerified: true,
      });

      expect(assessment.label).toBe("POSITIVE");
      expect(assessment.evidenceStatus).toBe("TICK_VERIFIED");
    });
  });

  describe("assessUnderlyingOptionPnlDivergence", () => {
    const entryTime = new Date("2026-10-14T09:30:00Z");
    const entrySpotPrice = 25000;
    const entryFillPrice = 120; // Option premium 120

    it("returns UNOBSERVABLE if trade is not an option buyer trade", () => {
      const assessment = assessUnderlyingOptionPnlDivergence({
        isOptionBuyerTrade: false,
        optionType: "CE",
        entryFillPrice,
        entrySpotPrice,
        entryTime,
        synchronizedObservations: [],
      });
      expect(assessment.label).toBe("UNOBSERVABLE");
    });

    it("labels POSITIVE for Long Call when spot moves up >= 0.05% and option bid <= entry fill at same timestamp", () => {
      // 0.05% of 25000 is 12.5 points -> spot 25013
      const observations: SynchronizedTickOrBar[] = [
        {
          timestamp: new Date("2026-10-14T09:35:00Z"), // 5 min after entry
          underlyingSpotPrice: 25015,                  // +0.06% favorable
          optionBidPrice: 118,                         // <= 120 (stagnant/losing)
        },
      ];

      const assessment = assessUnderlyingOptionPnlDivergence({
        isOptionBuyerTrade: true,
        optionType: "CE",
        entryFillPrice,
        entrySpotPrice,
        entryTime,
        synchronizedObservations: observations,
      });

      expect(assessment.label).toBe("POSITIVE");
      expect(assessment.evidenceStatus).toBe("BAR_DERIVED_UNAMBIGUOUS");
    });

    it("labels POSITIVE for Long Put when spot moves down <= -0.05% and option bid <= entry fill at same timestamp", () => {
      // -0.05% of 25000 is -12.5 points -> spot 24985
      const observations: SynchronizedTickOrBar[] = [
        {
          timestamp: new Date("2026-10-14T09:34:00Z"),
          underlyingSpotPrice: 24980, // -0.08% favorable for PUT
          optionBidPrice: 115,        // <= 120 (vega crush / trap)
        },
      ];

      const assessment = assessUnderlyingOptionPnlDivergence({
        isOptionBuyerTrade: true,
        optionType: "PE",
        entryFillPrice,
        entrySpotPrice,
        entryTime,
        synchronizedObservations: observations,
      });

      expect(assessment.label).toBe("POSITIVE");
    });

    it("labels NEGATIVE when option expands in profit with underlying move", () => {
      const observations: SynchronizedTickOrBar[] = [
        {
          timestamp: new Date("2026-10-14T09:35:00Z"),
          underlyingSpotPrice: 25020, // +0.08%
          optionBidPrice: 135,        // > 120 (healthy profit)
        },
      ];

      const assessment = assessUnderlyingOptionPnlDivergence({
        isOptionBuyerTrade: true,
        optionType: "CE",
        entryFillPrice,
        entrySpotPrice,
        entryTime,
        synchronizedObservations: observations,
      });

      expect(assessment.label).toBe("NEGATIVE");
    });

    it("ignores observations past 15 minutes", () => {
      const observations: SynchronizedTickOrBar[] = [
        {
          timestamp: new Date("2026-10-14T09:48:00Z"), // 18 min after entry
          underlyingSpotPrice: 25025,
          optionBidPrice: 110,
        },
      ];

      const assessment = assessUnderlyingOptionPnlDivergence({
        isOptionBuyerTrade: true,
        optionType: "CE",
        entryFillPrice,
        entrySpotPrice,
        entryTime,
        synchronizedObservations: observations,
      });

      expect(assessment.label).toBe("NEGATIVE");
    });
  });

  describe("assessExcessiveSpreadSlippage", () => {
    const entryTime = new Date("2026-10-14T09:30:00Z");
    const plannedRiskRupees = 1000;

    it("labels POSITIVE when frictionRupees / plannedRiskRupees > 0.5R", () => {
      const assessment = assessExcessiveSpreadSlippage({
        frictionRupees: 600, // 0.6R > 0.5R
        plannedRiskRupees,
        entryTime,
      });
      expect(assessment.label).toBe("POSITIVE");
    });

    it("labels NEGATIVE when frictionRupees / plannedRiskRupees <= 0.5R", () => {
      const assessment = assessExcessiveSpreadSlippage({
        frictionRupees: 200, // 0.2R <= 0.5R
        plannedRiskRupees,
        entryTime,
      });
      expect(assessment.label).toBe("NEGATIVE");
    });
  });

  describe("selectPrimaryObservedEvent", () => {
    it("strictly follows priority: IMMEDIATE_ADVERSE_EXCURSION > UNDERLYING_OPTION_PNL_DIVERGENCE > FAVORABLE_STALL_REVERSAL > EXCESSIVE_SPREAD_SLIPPAGE", () => {
      const events: ObservedEventEvidence[] = [
        {
          event: "EXCESSIVE_SPREAD_SLIPPAGE",
          evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
          eventWindowStart: "",
          eventWindowEnd: "",
          evidenceReferences: [],
        },
        {
          event: "UNDERLYING_OPTION_PNL_DIVERGENCE",
          evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
          eventWindowStart: "",
          eventWindowEnd: "",
          evidenceReferences: [],
        },
      ];

      // DIVERGENCE beats EXCESSIVE_SPREAD_SLIPPAGE
      expect(selectPrimaryObservedEvent(events)).toBe("UNDERLYING_OPTION_PNL_DIVERGENCE");

      // Adding IMMEDIATE_ADVERSE_EXCURSION must take top priority
      events.push({
        event: "IMMEDIATE_ADVERSE_EXCURSION",
        evidenceStatus: "BAR_DERIVED_UNAMBIGUOUS",
        eventWindowStart: "",
        eventWindowEnd: "",
        evidenceReferences: [],
      });
      expect(selectPrimaryObservedEvent(events)).toBe("IMMEDIATE_ADVERSE_EXCURSION");
    });

    it("returns null when no events occurred", () => {
      expect(selectPrimaryObservedEvent([])).toBeNull();
    });
  });
});
