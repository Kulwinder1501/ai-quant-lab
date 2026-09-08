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

  it("keeps fixed quantity as the default so recorded runs stay reproducible", () => {
    const source = context("signal-source", "2026-01-05");
    const entry = context("entry", "2026-01-06", { open: 100, high: 104, low: 98, close: 102 });

    const result = backtest([source, entry], { "signal-source": longProposal() });

    expect(result.trades[0].quantity).toBe(1);
    expect(result.trades[0].reasoning).toContain("Sizing: FIXED_QUANTITY at 1 unit(s).");
  });

  it("risks the same capital on a wide stop as on a narrow one", () => {
    // Two signals with identical 1:1 geometry but stops 5 and 20 points away. A
    // 1% budget of 100_000 is 1_000, so the narrow stop buys 200 units and the
    // wide one buys 50 -- and losing either costs the same 1_000.
    const narrow = () => backtest(
      [context("source", "2026-01-05"), context("stopped", "2026-01-06", { open: 100, high: 101, low: 90, close: 94 })],
      { source: longProposal({ stopLoss: 95, targetPrice: 105 }) },
      { positionSizing: "CONSTANT_RISK_FRACTION", riskFractionPerTrade: 0.01 },
    );
    const wide = () => backtest(
      [context("source", "2026-01-05"), context("stopped", "2026-01-06", { open: 100, high: 101, low: 75, close: 78 })],
      { source: longProposal({ stopLoss: 80, targetPrice: 120 }) },
      { positionSizing: "CONSTANT_RISK_FRACTION", riskFractionPerTrade: 0.01 },
    );

    expect(narrow().trades[0]).toMatchObject({ quantity: 200, exitReason: "STOP_LOSS", pnl: -1_000 });
    expect(wide().trades[0]).toMatchObject({ quantity: 50, exitReason: "STOP_LOSS", pnl: -1_000 });
  });

  it("rounds the risk-sized quantity down so realised risk never exceeds the budget", () => {
    const source = context("source", "2026-01-05");
    const stopped = context("stopped", "2026-01-06", { open: 100, high: 101, low: 90, close: 94 });

    // 1_000 budget over a 3-point stop is 333.33 units, so 333 are filled.
    const result = backtest(
      [source, stopped],
      { source: longProposal({ stopLoss: 97, targetPrice: 103 }) },
      { positionSizing: "CONSTANT_RISK_FRACTION", riskFractionPerTrade: 0.01 },
    );

    expect(result.trades[0].quantity).toBe(333);
    expect(result.trades[0].pnl).toBe(-999);
    expect(result.trades[0].reasoning).toContain(
      "Sizing: CONSTANT_RISK_FRACTION at 1.0000% of 100000 initial capital, giving 333 unit(s).",
    );
  });

  it("counts a signal it cannot size separately from one whose geometry was invalidated", () => {
    const source = context("source", "2026-01-05");
    const entry = context("entry", "2026-01-06", { open: 100, high: 104, low: 98, close: 102 });

    // A 10-point stop against a 1-unit budget cannot buy a whole unit, and a
    // fractional fill would misstate the risk, so the signal is skipped.
    const result = backtest(
      [source, entry],
      { source: longProposal({ stopLoss: 90, targetPrice: 110 }) },
      { positionSizing: "CONSTANT_RISK_FRACTION", riskFractionPerTrade: 0.00001 },
    );

    expect(result.trades).toEqual([]);
    expect(result.metrics).toMatchObject({
      signalCount: 1,
      skippedSignalsUnsizable: 1,
      skippedSignalsInvalidGap: 0,
      skippedSignalsInsufficientCapital: 0,
    });
  });

  it("rejects a risk or margin fraction that is not a usable fraction of capital", () => {
    const contexts = [context("source", "2026-01-05"), context("entry", "2026-01-06")];

    expect(() => backtest(contexts, {}, { riskFractionPerTrade: 0 })).toThrow("configuration is invalid");
    expect(() => backtest(contexts, {}, { riskFractionPerTrade: 1.5 })).toThrow("configuration is invalid");
    expect(() => backtest(contexts, {}, { marginFraction: 0 })).toThrow("configuration is invalid");
    expect(() => backtest(contexts, {}, { marginFraction: 1.5 })).toThrow("configuration is invalid");
  });

  it("cash-secures a position by default but funds it on margin when asked", () => {
    const source = context("source", "2026-01-05");
    const entry = context("entry", "2026-01-06", { open: 100, high: 104, low: 98, close: 102 });
    const proposals = { source: longProposal() };
    // 2_000 units at 100 is 200_000 of notional against 100_000 of capital.
    const overrides = { quantity: 2_000 } as const;

    const cashSecured = backtest([source, entry], proposals, overrides);
    expect(cashSecured.trades).toEqual([]);
    expect(cashSecured.metrics).toMatchObject({ skippedSignalsInsufficientCapital: 1 });

    // At 20% margin the same position needs only 40_000, so it opens.
    const margined = backtest([source, entry], proposals, { ...overrides, marginFraction: 0.2 });
    expect(margined.trades).toHaveLength(1);
    expect(margined.metrics).toMatchObject({ skippedSignalsInsufficientCapital: 0 });
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

describe("BacktestEngine concurrency", () => {
  /*
   * Three signals on consecutive bars, none of which can resolve: the bars never touch 95 or 110,
   * so every position stays open until END_OF_DATA. That isolates admission from exit behaviour.
   */
  const flatBar = { open: 100, high: 101, low: 99, close: 100 };
  const contexts = [
    context("c1", "2026-01-05", flatBar),
    context("c2", "2026-01-06", flatBar),
    context("c3", "2026-01-07", flatBar),
    context("c4", "2026-01-08", flatBar),
    context("c5", "2026-01-09", flatBar),
  ];
  const strategy = new FixedSignalStrategy({
    c1: longProposal(), c2: longProposal(), c3: longProposal(),
  });
  const config = (overrides: Partial<BacktestConfiguration>): BacktestConfiguration =>
    ({ ...defaultBacktestConfiguration, ...overrides });

  it("still admits exactly one position at the default, and blocks the rest", () => {
    // The default is deliberately unchanged, so previously recorded runs stay reproducible.
    expect(defaultBacktestConfiguration.maxConcurrentPositions).toBe(1);
    const result = new BacktestEngine(strategy).run(contexts, {}, config({}));
    expect(result.metrics.signalCount).toBe(3);
    expect(result.metrics.tradeCount).toBe(1);
    expect(result.metrics.skippedSignalsWhilePositionOpen).toBe(2);
  });

  it("admits up to maxConcurrentPositions and blocks only beyond it", () => {
    const two = new BacktestEngine(strategy).run(contexts, {}, config({ maxConcurrentPositions: 2 }));
    expect(two.metrics.tradeCount).toBe(2);
    expect(two.metrics.skippedSignalsWhilePositionOpen).toBe(1);

    const three = new BacktestEngine(strategy).run(contexts, {}, config({ maxConcurrentPositions: 3 }));
    expect(three.metrics.tradeCount).toBe(3);
    expect(three.metrics.skippedSignalsWhilePositionOpen).toBe(0);
  });

  it("counts a pending fill against the limit, since it is already committed to open", () => {
    // With a limit of 1, the signal on c2 arrives while c1's fill is pending, not yet open. It must
    // still be refused: treating a pending slot as free would over-admit by one on every bar.
    const result = new BacktestEngine(strategy).run(contexts, {}, config({ maxConcurrentPositions: 1 }));
    expect(result.metrics.skippedSignalsWhilePositionOpen).toBe(2);
  });

  it("charges each concurrent position against available capital, not gross equity", () => {
    // 100 units at ~100 with marginFraction 1 needs ~10,000 per position. Capital for two, asked
    // for three: the third is refused for capital, not for concurrency.
    const result = new BacktestEngine(strategy).run(contexts, {}, config({
      maxConcurrentPositions: 3, quantity: 100, initialCapital: 25_000, marginFraction: 1,
    }));
    expect(result.metrics.tradeCount).toBe(2);
    expect(result.metrics.skippedSignalsInsufficientCapital).toBe(1);
    expect(result.metrics.skippedSignalsWhilePositionOpen).toBe(0);
  });

  it("rejects a non-integer or sub-1 concurrency rather than silently clamping", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => new BacktestEngine(strategy).run(contexts, {}, config({ maxConcurrentPositions: bad })))
        .toThrow(/Backtest configuration is invalid/);
    }
  });
});
