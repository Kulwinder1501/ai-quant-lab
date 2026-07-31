import { describe, expect, it } from "vitest";
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
    expect(strategyKeys()).toEqual(["trend-breakout", "momentum-scalp"]);
    expect(requireRegisteredStrategy("trend-breakout").StrategyClass).toBe(TrendBreakoutStrategy);
    expect(requireRegisteredStrategy("momentum-scalp").StrategyClass).toBe(MomentumScalpStrategy);
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
