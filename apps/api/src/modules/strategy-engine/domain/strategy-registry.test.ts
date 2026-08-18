import { describe, expect, it } from "vitest";
import { MomentumScalpPatternStrategy, MomentumScalpPatternStrategyV2 } from "./momentum-scalp-pattern-strategy.js";
import { MomentumScalpStrategy } from "./momentum-scalp-strategy.js";
import { TrendBreakoutStrategy } from "./trend-breakout-strategy.js";
import {
  findRegisteredStrategy,
  registeredStrategies,
  requireRegisteredStrategy,
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
});
