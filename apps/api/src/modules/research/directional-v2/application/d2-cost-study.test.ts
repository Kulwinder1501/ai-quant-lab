import { describe, expect, it } from "vitest";
import type { SessionCandle } from "../domain/session-calendar.js";
import { generateDirectionalDataset } from "./generate-directional-dataset.js";
import { runD2CostStudy } from "./run-d2-cost-study.js";
import {
  calculateDeflatedSharpe,
  evaluateD2PremiumCostGate,
  type D2PremiumTick,
  type D2Signal,
} from "../domain/d2-premium-cost-gate.js";

function signal(overrides: Partial<D2Signal> = {}): D2Signal {
  return {
    sessionDate: "2026-08-20",
    decisionAt: new Date("2026-08-20T04:05:00.000Z"),
    dataThrough: new Date("2026-08-20T04:04:59.999Z"),
    score: 2,
    side: "UP",
    underlyingReferencePrice: 25_000,
    ...overrides,
  };
}

function tick(overrides: Partial<D2PremiumTick> = {}): D2PremiumTick {
  return {
    underlyingSymbol: "NIFTY50",
    observedAt: new Date("2026-08-20T04:05:10.000Z"),
    expiryDate: "2026-08-25",
    strikePrice: 25_000,
    optionType: "CE",
    providerSymbol: "NSE:NIFTY2682525000CE",
    bid: 99,
    ask: 100,
    underlyingValue: 25_010,
    ...overrides,
  };
}

function sessionCandles(sessionDate: string, dayIndex: number, count = 120): SessionCandle[] {
  const start = new Date(`${sessionDate}T09:15:00+05:30`).getTime();
  const result: SessionCandle[] = [];
  let price = 20_000 + dayIndex * 25;
  for (let index = 0; index < count; index += 1) {
    const open = price;
    const drift = (dayIndex % 2 === 0 ? 1 : -1) * (0.00003 + dayIndex * 0.000002);
    price = open * (1 + drift + Math.sin((index + dayIndex) / 7) * 0.00015);
    const openTime = new Date(start + index * 60_000);
    result.push({
      openTime,
      closeTime: new Date(openTime.getTime() + 60_000),
      open,
      high: Math.max(open, price) + 1,
      low: Math.min(open, price) - 1,
      close: price,
      volume: 10_000 + dayIndex * 100 + (index % 20) * 25,
    });
  }
  return result;
}

describe("Directional V2 D2 premium cost gate", () => {
  it("buys at the ask, exits at the bid, adds the frozen one-tick buffer, and charges itemized fees", () => {
    const result = evaluateD2PremiumCostGate({
      underlyingSymbol: "NIFTY50",
      signals: [signal()],
      ticks: [
        tick(),
        tick({
          observedAt: new Date("2026-08-20T04:35:10.000Z"),
          bid: 110,
          ask: 111,
        }),
      ],
      quantity: 75,
      premiumSessionDates: ["2026-08-20"],
    });

    expect(result.resolvedQuotePairCount).toBe(1);
    const observed = result.scenarios.find((scenario) => scenario.scenario.name === "observed-book")!.trades[0]!;
    const primary = result.scenarios.find((scenario) => scenario.scenario.name === "primary-one-tick")!.trades[0]!;
    expect(observed.entryFill).toBe(100);
    expect(observed.exitFill).toBe(110);
    expect(primary.entryFill).toBe(100.05);
    expect(primary.exitFill).toBe(109.95);
    expect(primary.fees).toBeGreaterThan(0);
    expect(primary.netPnl).toBeLessThan(primary.grossPnl);
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("refuses a feature timestamp that is not strictly before the decision", () => {
    expect(() => evaluateD2PremiumCostGate({
      underlyingSymbol: "NIFTY50",
      signals: [signal({ dataThrough: new Date("2026-08-20T04:05:00.000Z") })],
      ticks: [],
      quantity: 75,
    })).toThrow(/strictly earlier/);
  });

  it("keeps overlapping 5-minute signals from manufacturing concurrent positions", () => {
    const first = signal();
    const second = signal({
      decisionAt: new Date("2026-08-20T04:10:00.000Z"),
      dataThrough: new Date("2026-08-20T04:09:59.999Z"),
    });
    const result = evaluateD2PremiumCostGate({
      underlyingSymbol: "NIFTY50",
      signals: [first, second],
      ticks: [tick(), tick({ observedAt: new Date("2026-08-20T04:35:10.000Z"), bid: 101 })],
      quantity: 75,
    });
    expect(result.resolvedQuotePairCount).toBe(1);
    expect(result.skips.overlappingPosition).toBe(1);
  });

  it("reports a finite selection-adjusted Sharpe diagnostic", () => {
    const diagnostic = calculateDeflatedSharpe([0.01, -0.005, 0.012, 0.004, -0.002, 0.008], 24);
    expect(diagnostic).not.toBeNull();
    expect(diagnostic!.probabilitySharpeExceedsSelectionBias).toBeGreaterThanOrEqual(0);
    expect(diagnostic!.probabilitySharpeExceedsSelectionBias).toBeLessThanOrEqual(1);
  });

  it("passes only after the frozen session and trade minimums and a positive day-level interval", () => {
    const signals: D2Signal[] = [];
    const ticks: D2PremiumTick[] = [];
    const premiumSessionDates: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const day = new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10);
      const decisionAt = new Date(`${day}T09:35:00+05:30`);
      const providerSymbol = `NSE:NIFTY-${day}-CE`;
      premiumSessionDates.push(day);
      signals.push(signal({
        sessionDate: day,
        decisionAt,
        dataThrough: new Date(decisionAt.getTime() - 1),
      }));
      ticks.push(
        tick({
          observedAt: new Date(decisionAt.getTime() + 10_000),
          expiryDate: "2027-01-01",
          providerSymbol,
          bid: 99,
          ask: 100,
        }),
        tick({
          observedAt: new Date(decisionAt.getTime() + 30 * 60_000 + 10_000),
          expiryDate: "2027-01-01",
          providerSymbol,
          bid: 120,
          ask: 121,
        }),
      );
    }
    const result = evaluateD2PremiumCostGate({
      underlyingSymbol: "NIFTY50",
      signals,
      ticks,
      quantity: 75,
      premiumSessionDates,
    });
    expect(result.premiumSessionDates).toHaveLength(60);
    expect(result.resolvedQuotePairCount).toBe(60);
    expect(result.verdict).toBe("PASS");
  });

  it("fits only pre-premium index history and scores the frozen 30-minute candidate", () => {
    const dates = [
      "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09",
      "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-16", "2026-01-19", "2026-01-20",
    ];
    const candles = dates.flatMap((date, index) => sessionCandles(date, index));
    const dataset = generateDirectionalDataset("NIFTY50", candles);
    const result = runD2CostStudy({
      underlyingSymbol: "NIFTY50",
      dataset,
      candles,
      premiumTicks: [],
      premiumSessionDates: ["2026-01-20"],
      lotSize: 75,
    });

    expect(result.model.trainingCutoffSessionExclusive).toBe("2026-01-20");
    expect(result.model.trainingLastSession).toBe("2026-01-19");
    expect(result.model.trainingSampleCount).toBeGreaterThan(0);
    expect(result.model.lowerScoreThreshold).toBeLessThan(result.model.upperScoreThreshold);
    expect(result.evaluatedDecisionCount).toBeGreaterThan(0);
    expect(result.costGate.verdict).toBe("INSUFFICIENT_DATA");
  });
});
