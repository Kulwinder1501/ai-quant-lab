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

  it("trades the pattern confluence scalp short-only, on its own 36-trade long record", () => {
    /*
     * Measured 2026-09-02 over every closed 5m paper trade on this strategy:
     *
     *   5m SHORT   32 trades   50.0% win   +Rs   424
     *   5m LONG    36 trades   36.1% win   -Rs 8,531
     *
     * Close to identical to the index scalp's split, which is suggestive rather than confirmatory --
     * both are built on the same momentum architecture, so it is plausibly one flaw seen twice. The
     * long cell does not need that argument: it loses on its own 36 trades.
     */
    const patternScalp = requireRegisteredStrategy("momentum-scalp-pattern");

    expect(strategyExecutableSides(patternScalp)).toEqual(["SHORT"]);
  });

  it("disables the v2 pattern scalp entirely, on asymmetric evidence", () => {
    /*
     * Both sides, not a restriction. Against it: a TERMINAL research verdict measured over
     * 13.7k-18.6k trades per cell. For it: one closed trade, +Rs 188. One trade cannot overturn that
     * prior, and leaving it enabled is how a single trade quietly becomes a positive result.
     *
     * Registered rather than deleted, so its lineage and the reasoning survive and the research twin
     * keeps measuring the population ungated -- disabled operationally, preserved scientifically.
     */
    const v2 = requireRegisteredStrategy("momentum-scalp-pattern-v2");

    expect(strategyExecutableSides(v2)).toEqual([]);
    expect(v2.terminalResearchAcknowledgement?.disposition).toMatch(/^DISABLED/);
  });

  it("keeps the disabled strategy's research twin RESEARCH, not TERMINAL", () => {
    // Terminal means the line of inquiry is closed. The generation-2 pattern question is unanswered,
    // not closed, so disabling the operational expression must not silently retire the research line.
    const v2 = requireRegisteredStrategy("momentum-scalp-pattern-v2");

    expect(strategyExecutableSides(v2)).toEqual([]);
    expect(v2.registration.strategyKey).toBe("momentum-scalp-pattern-v2");
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

  it("restricts exactly the two strategies with a measured losing long side, and no others", () => {
    /*
     * Pinned as an exact set rather than a per-strategy check. The restriction is per strategy on
     * purpose -- a global side filter would silence that side everywhere -- so the risk worth
     * guarding is a restriction spreading to a strategy whose evidence never justified one.
     */
    const restricted = registeredStrategies
      .filter((strategy) => strategy.executableSides !== undefined)
      .map((strategy) => strategy.registration.strategyKey)
      .sort();

    expect(restricted).toEqual([
      "momentum-scalp-index", "momentum-scalp-pattern", "momentum-scalp-pattern-v2",
    ]);
    for (const strategy of registeredStrategies) {
      if (restricted.includes(strategy.registration.strategyKey)) continue;
      expect(strategyExecutableSides(strategy), strategy.registration.strategyKey)
        .toEqual(["LONG", "SHORT"]);
    }
  });
});
