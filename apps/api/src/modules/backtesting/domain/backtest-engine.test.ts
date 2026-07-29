import { describe, expect, it } from "vitest";
import type { ProposedTradeIdea, StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import { BacktestEngine, defaultBacktestConfiguration, type BacktestStrategyEvaluator } from "./backtest-engine.js";
import type { BacktestConfiguration } from "./backtesting.js";

function context(
  id: string,
  date: string,
  overrides: Partial<StrategyMarketContext["candle"]> = {},
): StrategyMarketContext {
  return {
    candle: {
      id,
      instrumentId: "instrument-1",
      timeframe: "1d",
      openTime: new Date(`${date}T09:15:00.000Z`),
      closeTime: new Date(`${date}T15:30:00.000Z`),
      open: 100,
      high: 104,
      low: 96,
      close: 101,
      volume: 10_000,
      tickSize: 0.05,
      ...overrides,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  };
}

function longProposal(overrides: Partial<ProposedTradeIdea> = {}): ProposedTradeIdea {
  return {
    side: "LONG",
    entryPrice: 100,
    stopLoss: 95,
    targetPrice: 110,
    riskReward: 2,
    confidence: 0.8,
    reasoning: ["test signal"],
    evidence: {},
    expiresAt: null,
    evidenceItems: [],
    ...overrides,
  };
}

class FixedSignalStrategy implements BacktestStrategyEvaluator {
  constructor(private readonly proposalsByCandleId: Readonly<Record<string, ProposedTradeIdea>>) {}

  evaluate(contextToEvaluate: StrategyMarketContext, _configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const proposal = this.proposalsByCandleId[contextToEvaluate.candle.id];
    return proposal ? [proposal] : [];
  }
}

function backtest(
  contexts: StrategyMarketContext[],
  proposalsByCandleId: Record<string, ProposedTradeIdea>,
  overrides: Partial<BacktestConfiguration> = {},
) {
  const strategy = new FixedSignalStrategy(proposalsByCandleId);
  return new BacktestEngine(strategy).run(
    contexts,
    {},
    { ...defaultBacktestConfiguration, ...overrides },
  );
}

describe("BacktestEngine", () => {
  it("evaluates a close-time signal at the next candle open, never the source candle", () => {
    const source = context("signal-source", "2026-01-05", {
      high: 130,
      low: 90,
      close: 100,
    });
    const entry = context("next-candle", "2026-01-06", {
      open: 101,
      high: 104,
      low: 98,
      close: 102,
    });

    const result = backtest([source, entry], { "signal-source": longProposal() });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryPrice: 101,
      exitPrice: 102,
      exitReason: "END_OF_DATA",
    });
    expect(result.trades[0].entryTime).toEqual(entry.candle.openTime);
    expect(result.trades[0].exitTime).toEqual(entry.candle.closeTime);
    expect(result.trades[0].reasoning).toContain("Signal source candle: signal-source.");
    expect(result.trades[0].reasoning).toContain("Entry candle: next-candle; exit candle: next-candle.");
  });

  it("uses the conservative stop-first rule when an entry candle reaches both protective levels", () => {
    const source = context("signal-source", "2026-01-05");
    const execution = context("execution", "2026-01-06", {
      open: 100,
      high: 111,
      low: 94,
      close: 99,
    });

    const result = backtest([source, execution], { "signal-source": longProposal() });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      entryPrice: 100,
      exitPrice: 95,
      exitReason: "STOP_LOSS",
      pnl: -5,
    });
    expect(result.trades[0].exitTime).toEqual(execution.candle.closeTime);
    expect(result.trades[0].reasoning).toContain("Exit policy: CONSERVATIVE_STOP_FIRST.");
  });

  it("skips a signal whose next opening price has already invalidated its risk geometry", () => {
    const source = context("signal-source", "2026-01-05");
    const invalidOpeningGap = context("gapped-open", "2026-01-06", {
      open: 110,
      high: 112,
      low: 109,
      close: 111,
    });

    const result = backtest([source, invalidOpeningGap], { "signal-source": longProposal() });

    expect(result.trades).toEqual([]);
    expect(result.metrics).toMatchObject({
      signalCount: 1,
      skippedSignalsInvalidGap: 1,
      skippedSignalsNoNextCandle: 0,
    });
  });

  it("closes a remaining position at the final completed candle close", () => {
    const source = context("signal-source", "2026-01-05");
    const finalCandle = context("final", "2026-01-06", {
      open: 100,
      high: 108,
      low: 96,
      close: 105,
    });

    const result = backtest(
      [source, finalCandle],
      { "signal-source": longProposal({ targetPrice: 120 }) },
    );

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      exitReason: "END_OF_DATA",
      exitPrice: 105,
      pnl: 5,
    });
    expect(result.trades[0].exitTime).toEqual(finalCandle.candle.closeTime);
    expect(result.trades[0].reasoning).toContain("Exit policy: END_OF_DATA_CLOSE.");
  });

  it("applies adverse slippage and both order fees before reporting net P/L", () => {
    const source = context("signal-source", "2026-01-05");
    const finalCandle = context("final", "2026-01-06", {
      open: 100,
      high: 111,
      low: 96,
      close: 110,
    });

    const result = backtest(
      [source, finalCandle],
      { "signal-source": longProposal({ targetPrice: 120 }) },
      { feePerOrder: 2, slippageBps: 10 },
    );

    expect(result.trades[0]).toMatchObject({
      entryPrice: 100.1,
      exitPrice: 109.85,
      pnl: 5.75,
    });
    expect(result.metrics).toMatchObject({ netPnl: 5.75, endingEquity: 100_005.75 });
  });

  it("rejects overlapping contexts so an earlier signal cannot see a later bar before its next open", () => {
    const source = context("source", "2026-01-05", {
      openTime: new Date("2026-01-05T09:15:00.000Z"),
      closeTime: new Date("2026-01-05T10:30:00.000Z"),
    });
    const overlapping = context("overlapping", "2026-01-05", {
      openTime: new Date("2026-01-05T10:00:00.000Z"),
      closeTime: new Date("2026-01-05T10:15:00.000Z"),
    });

    expect(() => backtest([source, overlapping], {})).toThrow("must not overlap");
  });
});
