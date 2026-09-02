import { describe, expect, it } from "vitest";
import { MomentumScalpPatternStrategy, MomentumScalpPatternStrategyV2 } from "./momentum-scalp-pattern-strategy.js";
import { MomentumScalpStrategy } from "./momentum-scalp-strategy.js";
import { TrendBreakoutStrategy } from "./trend-breakout-strategy.js";
import {
  findRegisteredStrategy,
  registeredStrategies,
  requireRegisteredStrategy,
  strategyExecutableSides,
  strategyKeys,
} from "./strategy-registry.js";

describe("strategy registry", () => {
  it("pairs every registration with the class that implements its key", () => {
    expect(strategyKeys()).toEqual(["trend-breakout", "momentum-scalp", "momentum-scalp-index", "momentum-scalp-pattern", "momentum-scalp-pattern-v2"]);
    expect(requireRegisteredStrategy("trend-breakout").StrategyClass).toBe(TrendBreakoutStrategy);
    expect(requireRegisteredStrategy("momentum-scalp").StrategyClass).toBe(MomentumScalpStrategy);
    expect(requireRegisteredStrategy("momentum-scalp-pattern").StrategyClass).toBe(MomentumScalpPatternStrategy);
    expect(requireRegisteredStrategy("momentum-scalp-pattern-v2").StrategyClass).toBe(MomentumScalpPatternStrategyV2);
  });

  it("keeps the scalp and swing timeframe sets disjoint", () => {
    const scalp = requireRegisteredStrategy("momentum-scalp").supportedTimeframes;
    const swing = requireRegisteredStrategy("trend-breakout").supportedTimeframes;
    expect(scalp).toEqual(["1m"]);
    expect(swing.some((timeframe) => scalp.includes(timeframe))).toBe(false);
  });

  it("registers each key exactly once so a lookup cannot be ambiguous", () => {
    expect(new Set(strategyKeys()).size).toBe(registeredStrategies.length);
  });

  it("names the supported keys when asked for one that does not exist", () => {
    expect(findRegisteredStrategy("no-such-strategy")).toBeNull();
    expect(() => requireRegisteredStrategy("no-such-strategy")).toThrow(/trend-breakout, momentum-scalp/);
  });

  it("hands back a fresh evaluator, since a replay must not inherit prior state", () => {
    const { StrategyClass } = requireRegisteredStrategy("momentum-scalp");
    expect(new StrategyClass()).not.toBe(new StrategyClass());
  });

  it("trades the index scalp short-only, because its long side is a measured loser", () => {
    /*
     * Measured 2026-09-02 over every closed paper trade on this strategy:
     *
     *   5m SHORT   93 trades   47.3% win   +Rs  1,384
     *   5m LONG    62 trades   35.5% win   -Rs 13,414
     *
     * The long side accounts for the whole of the loss and is negative on almost every session in
     * the record. No edge is claimed for short; this narrows a measured loser.
     */
    const indexScalp = requireRegisteredStrategy("momentum-scalp-index");

    expect(strategyExecutableSides(indexScalp)).toEqual(["SHORT"]);
  });

  it("leaves every other strategy free to trade both sides", () => {
    // The restriction is per strategy on purpose: the evidence is about one strategy, and a global
    // side filter would silence that side everywhere.
    for (const strategy of registeredStrategies) {
      if (strategy.registration.strategyKey === "momentum-scalp-index") continue;
      expect(strategyExecutableSides(strategy), strategy.registration.strategyKey)
        .toEqual(["LONG", "SHORT"]);
    }
  });
});
