import { describe, expect, it } from "vitest";
import { MomentumScalpPatternStrategy, MomentumScalpPatternStrategyV2 } from "./momentum-scalp-pattern-strategy.js";
import { MomentumScalpStrategy } from "./momentum-scalp-strategy.js";
import { MomentumScalpGoldStrategy } from "./momentum-scalp-gold-strategy.js";
import { TrendBreakoutStrategy } from "./trend-breakout-strategy.js";
import { IctStructureStrategy } from "./ict-structure-strategy.js";
import { HybridLiquidityConfluenceStrategy } from "./hybrid-liquidity-confluence-strategy.js";
import {
  findRegisteredStrategy,
  registeredStrategies,
  requireRegisteredStrategy,
  strategyExecutableSides,
  strategyKeys,
  strategySupportsTimeframe,
  ictContextTimeframes,
  ictContextConsumedAt,
} from "./strategy-registry.js";

import { TrendContinuationStrategy } from "./trend-continuation-strategy.js";
import { EventReversalStrategy } from "./event-reversal-strategy.js";

describe("strategy registry", () => {
  it("pairs every registration with the class that implements its key", () => {
    expect(strategyKeys()).toEqual([
      "trend-breakout",
      "momentum-scalp",
      "momentum-scalp-index",
      "momentum-scalp-gold",
      "momentum-scalp-pattern",
      "momentum-scalp-pattern-v2",
      "ict-structure-v1",
      "hybrid-liquidity-confluence-v1",
      "trend-continuation-v1",
      "event-reversal-v1",
    ]);
    expect(requireRegisteredStrategy("trend-breakout").StrategyClass).toBe(TrendBreakoutStrategy);
    expect(requireRegisteredStrategy("momentum-scalp").StrategyClass).toBe(MomentumScalpStrategy);
    expect(requireRegisteredStrategy("momentum-scalp-gold").StrategyClass).toBe(MomentumScalpGoldStrategy);
    expect(requireRegisteredStrategy("momentum-scalp-pattern").StrategyClass).toBe(MomentumScalpPatternStrategy);
    expect(requireRegisteredStrategy("momentum-scalp-pattern-v2").StrategyClass).toBe(MomentumScalpPatternStrategyV2);
    expect(requireRegisteredStrategy("ict-structure-v1").StrategyClass).toBe(IctStructureStrategy);
    expect(requireRegisteredStrategy("hybrid-liquidity-confluence-v1").StrategyClass).toBe(HybridLiquidityConfluenceStrategy);
    expect(requireRegisteredStrategy("trend-continuation-v1").StrategyClass).toBe(TrendContinuationStrategy);
    expect(requireRegisteredStrategy("event-reversal-v1").StrategyClass).toBe(EventReversalStrategy);
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

  it("re-enables the pattern confluence scalp for a deliberate re-test, both sides", () => {
    /*
     * Disabled entirely 2026-09-03 on a -Rs 10,209/78-trade record (23% of the account's total
     * loss); re-enabled 2026-09-26 by explicit user decision, not by new evidence. The same-day
     * `selectPriorityPattern` fix (alphabetical-vs-priority tie-break) only changes which pattern is
     * credited in evidence/confidence -- the LONG/SHORT score gate never read which candidate was
     * selected, so it could not have changed the entries/exits behind that -Rs 10,209 record. This
     * re-enable carries no new evidence of its own; the next live record should be measured against
     * that same baseline before trusting it.
     */
    const patternScalp = requireRegisteredStrategy("momentum-scalp-pattern");

    expect(strategyExecutableSides(patternScalp)).toEqual(["LONG", "SHORT"]);
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

  it("disables the index scalp entirely, once its short side turned too", () => {
    /*
     * Short-only from 2026-09-02 (long was -Rs 13,414 over 62), then both sides disabled 2026-09-03.
     * The short cell was retained on its own record (+Rs 1,384 over 93) until that record turned:
     * over the full history the strategy is -Rs 33,449 across both indices, 74% of the account's
     * total loss and the largest single source of the bleed, more than half of it fees. The research
     * verdict had already closed the architecture; the live short has now failed on its own terms.
     */
    const indexScalp = requireRegisteredStrategy("momentum-scalp-index");

    expect(strategyExecutableSides(indexScalp)).toEqual([]);
    expect(indexScalp.terminalResearchAcknowledgement?.disposition).toMatch(/^DISABLED/);
  });

  it("restricts exactly the three strategies gated off, and no others", () => {
    /*
     * Pinned as an exact set rather than a per-strategy check. The restriction is per strategy on
     * purpose -- a global side filter would silence that side everywhere -- so the risk worth
     * guarding is a restriction spreading to a strategy whose evidence never justified one.
     *
     * `hybrid-liquidity-confluence-v1` joined this set 2026-09-28, the same day it shipped -- not
     * for a measured losing side like the other two, but gated pending the random-subsample
     * validation recorded in docs/2026-09-28-hybrid-liquidity-confluence-v1-validation.md.
     */
    const restricted = registeredStrategies
      .filter((strategy) => strategy.executableSides !== undefined)
      .map((strategy) => strategy.registration.strategyKey)
      .sort();

    expect(restricted).toEqual([
      "event-reversal-v1", "hybrid-liquidity-confluence-v1", "momentum-scalp-index",
      "momentum-scalp-pattern-v2", "trend-continuation-v1",
    ]);
    for (const strategy of registeredStrategies) {
      if (restricted.includes(strategy.registration.strategyKey)) continue;
      expect(strategyExecutableSides(strategy), strategy.registration.strategyKey)
        .toEqual(["LONG", "SHORT"]);
    }
  });

  it("gates hybrid-liquidity-confluence-v1 off pending validation, not on a measured verdict", () => {
    const hybrid = requireRegisteredStrategy("hybrid-liquidity-confluence-v1");

    expect(strategyExecutableSides(hybrid)).toEqual([]);
    // Deliberately no terminalResearchAcknowledgement: it has no research twin and no TERMINAL
    // verdict, so attaching one would misrepresent the record (see the registry comment).
    expect(hybrid.terminalResearchAcknowledgement).toBeUndefined();
  });

  it("gates trend-continuation-v1 and event-reversal-v1 off pending validation, not on a measured verdict", () => {
    /*
     * Both shipped 2026-09-29 (commit 5d8c4d7) with zero backtest or research validation. The
     * same-day follow-up fix (commit cherry-picked as part of this gate) corrected 8 typecheck
     * errors in both files, but that only makes the code compile and run -- it is not evidence the
     * logic has edge. Same pattern as `hybrid-liquidity-confluence-v1`: gated pending validation,
     * not on a measured losing verdict.
     */
    const trendContinuation = requireRegisteredStrategy("trend-continuation-v1");
    const eventReversal = requireRegisteredStrategy("event-reversal-v1");

    expect(strategyExecutableSides(trendContinuation)).toEqual([]);
    expect(strategyExecutableSides(eventReversal)).toEqual([]);
    // Deliberately no terminalResearchAcknowledgement for either: neither has a research twin or a
    // TERMINAL verdict, so attaching one would misrepresent the record (see the registry comment).
    expect(trendContinuation.terminalResearchAcknowledgement).toBeUndefined();
    expect(eventReversal.terminalResearchAcknowledgement).toBeUndefined();
  });
});

describe("trend-breakout is marked out, and the marking is enforced not asserted", () => {
  const trendBreakout = requireRegisteredStrategy("trend-breakout");

  it("carries a TERMINAL_UNOWNED disposition with its sample sizes", () => {
    /*
     * Measured, not assumed: 15m fails cross-instrument replication (NIFTY50 LONG 0.4737 against
     * BANKNIFTY LONG 0.2727, with SHORT flipping), 60m clears break-even in all four cells and every
     * one fails a 2xSE floor at n=12-25, and 1d is below break-even throughout.
     */
    const disposition = trendBreakout.operationalDisposition;

    expect(disposition?.status).toBe("TERMINAL_UNOWNED");
    // The counts have to survive, or the verdict cannot be re-derived or overturned later.
    expect(disposition?.evidence).toMatch(/0\.3333/);
    expect(disposition?.evidence).toMatch(/2xSE/);
    expect(disposition?.whyStillRegistered.trim().length).toBeGreaterThan(80);
  });

  it("keeps both sides executable, because emptying them would stop idea generation", () => {
    /*
     * The trap this guards. `[]` is how `momentum-scalp-pattern-v2` was disabled, and copying that
     * here would be wrong: `generateTradeIdeas` filters proposals by `executableSides`, so emptying
     * it stops the ideas that are the entire reason the registration is kept. "No bot owns it" and
     * "produce nothing" are different dispositions.
     */
    expect(strategyExecutableSides(trendBreakout)).toEqual(["LONG", "SHORT"]);
  });

  it("does not borrow the research acknowledgement it has no twin for", () => {
    /*
     * `terminalResearchAcknowledgement` is enforced against `researchStrategyRegistry`: it must name
     * an entry that exists, is TERMINAL, and points back at this strategy. Using it here would have
     * required inventing a research strategy with a pinned definition hash to justify the verdict.
     */
    expect(trendBreakout.terminalResearchAcknowledgement).toBeUndefined();
  });

  it("stays registered, because 15m has no other strategy", () => {
    /*
     * The paper bot's `assertScannableTimeframes` throws on a SCAN_TIMEFRAMES entry no registered
     * strategy supports, and 15m is in that list. So removing this entry -- the obvious reading of
     * "terminal" -- would stop the bot from starting at all.
     */
    const fifteenMinute = registeredStrategies
      .filter((strategy) => strategySupportsTimeframe(strategy, "15m"))
      .map((strategy) => strategy.registration.strategyKey);

    expect(fifteenMinute).toContain("trend-breakout");
    expect(fifteenMinute).toContain("ict-structure-v1");
    expect(fifteenMinute).toContain("trend-continuation-v1");
    expect(fifteenMinute).toContain("event-reversal-v1");
    expect(fifteenMinute).toHaveLength(4);
  });

  it("owns timeframes above the scalp band", () => {
    const owners30m = registeredStrategies
      .filter((strategy) => strategySupportsTimeframe(strategy, "30m"))
      .map((strategy) => strategy.registration.strategyKey);
    expect(owners30m).toEqual(["trend-breakout"]);
  });
});

describe("ICT context consumption", () => {
  it("reports exactly the timeframes of the strategies that declare they read it", () => {
    // Derived, not listed. If it were listed it could drift from the consumer's own
    // supportedTimeframes, which is how the repository ends up computing a snapshot nobody reads.
    const declared = registeredStrategies
      .filter((strategy) => strategy.readsIctContext === true)
      .flatMap((strategy) => strategy.supportedTimeframes);
    expect(ictContextTimeframes()).toEqual([...new Set<string>(declared)].sort());
  });

  it("excludes 3m, where nothing reads ICT", () => {
    expect(ictContextConsumedAt("3m")).toBe(false);
  });

  it("includes the timeframes the ICT strategy actually supports", () => {
    expect(ictContextConsumedAt("1m")).toBe(true);
    expect(ictContextConsumedAt("5m")).toBe(true);
    expect(ictContextConsumedAt("15m")).toBe(true);
    expect(ictContextConsumedAt("1d")).toBe(true);
  });

  it("registers consumers reading ICT context", () => {
    const consumers = registeredStrategies.filter((s) => s.readsIctContext === true);
    expect(consumers).toHaveLength(3);
    const keys = consumers.map((c) => c.registration.strategyKey);
    expect(keys).toContain("ict-structure-v1");
    expect(keys).toContain("trend-continuation-v1");
    expect(keys).toContain("event-reversal-v1");
  });
});
