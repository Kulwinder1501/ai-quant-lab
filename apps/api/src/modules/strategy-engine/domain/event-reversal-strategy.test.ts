import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "./strategy.js";
import {
  defaultEventReversalStrategyConfiguration,
  EventReversalStrategy,
  EVENT_REVERSAL_STRATEGY_KEY,
} from "./event-reversal-strategy.js";

function buildMockContext(sweepLevelType: "PDH" | "PDL" = "PDH"): StrategyMarketContext {
  const closeTime = new Date("2026-09-29T10:00:00Z");

  return {
    candle: {
      id: "candle-1",
      instrumentId: "BANKNIFTY",
      timeframe: "15m",
      openTime: new Date("2026-09-29T09:45:00Z"),
      closeTime,
      open: 50000,
      high: 50100,
      low: 49900,
      close: 50050,
      volume: 2000,
      tickSize: 0.05,
    },
    indicators: [
      { code: "ATR", algorithmVersion: "v1", parameters: {}, values: { value: 30 } },
    ],
    ictSnapshot: {
      timestamp: closeTime,
      liquidity: {
        unmitigatedSweeps: [
          {
            levelType: sweepLevelType,
            sweptAt: closeTime,
            sweptPrice: 50100,
          },
        ],
      },
      cisd: {
        direction: sweepLevelType === "PDH" ? "BEARISH" : "BULLISH",
        ageBars: 1,
      },
    } as any,
  } as unknown as StrategyMarketContext;
}

describe("EventReversalStrategy", () => {
  it("generates a sell proposal on macro PDH sweep confirmed by bearish CISD", () => {
    const strategy = new EventReversalStrategy();
    const context = buildMockContext("PDH");
    const ideas = strategy.evaluate(context, defaultEventReversalStrategyConfiguration);

    expect(ideas.length).toBe(1);
    expect(ideas[0].side).toBe("SHORT");
    expect(ideas[0].riskReward).toBe(2.5);
  });

  it("generates a buy proposal on macro PDL sweep confirmed by bullish CISD", () => {
    const strategy = new EventReversalStrategy();
    const context = buildMockContext("PDL");
    const ideas = strategy.evaluate(context, defaultEventReversalStrategyConfiguration);

    expect(ideas.length).toBe(1);
    expect(ideas[0].side).toBe("LONG");
  });
});
