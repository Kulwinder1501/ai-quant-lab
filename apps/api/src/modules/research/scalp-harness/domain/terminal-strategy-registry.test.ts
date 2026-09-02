import { describe, expect, it } from "vitest";
import {
  assertRegisteredAndUnchanged,
  assertRegistryWellFormed,
  benchmarkResearchStrategyKeys,
  registryEntryFor,
  researchStrategyRegistry,
  selectCaptureStrategies,
  StrategyRegistryError,
  terminalStrategyRegistryVersion,
  type RegisteredResearchStrategy,
} from "./terminal-strategy-registry.js";
import { researchScalpStrategies } from "./research-strategies.js";
import type { ResearchStrategyDefinition } from "./contracts.js";

function entry(overrides: Partial<RegisteredResearchStrategy> = {}): RegisteredResearchStrategy {
  return {
    strategyKey: "some-research",
    researchVersion: 1,
    researchStatus: "RESEARCH",
    productionEligibility: "NOT_YET_ELIGIBLE",
    closureReason: null,
    pinnedDefinitionHash: "a".repeat(64),
    lineage: { parentStrategyKey: null, parentResearchVersion: null, parentTerminalReason: null },
    ...overrides,
  };
}

function definitionOf(strategyKey: string): ResearchStrategyDefinition {
  const adapter = researchScalpStrategies.find((a) => a.definition.strategyKey === strategyKey);
  if (!adapter) throw new Error(`No running adapter for ${strategyKey}.`);
  return adapter.definition;
}

describe("the shipped registry", () => {
  it("is internally consistent", () => {
    expect(() => assertRegistryWellFormed()).not.toThrow();
    expect(terminalStrategyRegistryVersion).toBe("TERMINAL_STRATEGY_REGISTRY_V1");
  });

  it("covers every strategy definition persisted in research_scalp, not just the four in the plan", () => {
    /*
     * The seven keys read out of `research_scalp.strategy_definitions` on 2026-09-02. The plan's §2
     * table lists four; the three v1-schema definitions are real rows that predate it and are exactly
     * the kind of forgotten artifact someone could revive believing it was never tried.
     *
     * Pinned as a set so adding a strategy to the harness without registering it fails here as well
     * as at the selection guard.
     */
    expect([...researchStrategyRegistry.map((e) => e.strategyKey)].sort()).toEqual([
      "index-v2-research",
      "index-v3-research",
      "momentum-v4-research",
      "momentum-v5-research",
      "pattern-v3-research",
      "pattern-v4-research",
      "pattern-v4-research-v2",
    ]);
  });

  it("records the two measured terminal verdicts as permanently ineligible", () => {
    for (const key of ["index-v3-research", "pattern-v4-research"]) {
      const found = registryEntryFor(key)!;
      expect(found.researchStatus).toBe("TERMINAL");
      expect(found.productionEligibility).toBe("NEVER_ELIGIBLE");
      expect(found.closureReason).toBeTruthy();
    }
  });

  it("keeps the superseded generations distinct from the terminal ones", () => {
    /*
     * The distinction is the point: nothing was concluded about these three, they were migrated away
     * from with zero captured proposals. Recording them as TERMINAL would assert a finding that was
     * never made, and the reason strings are read by people deciding whether to retry an idea.
     */
    for (const key of ["momentum-v4-research", "index-v2-research", "pattern-v3-research"]) {
      const found = registryEntryFor(key)!;
      expect(found.researchStatus).toBe("SUPERSEDED");
      expect(found.closureReason).toContain("zero captured proposals");
    }
  });

  it("carries the generation-2 lineage with its parent's reason verbatim", () => {
    const generation2 = registryEntryFor("pattern-v4-research-v2")!;
    const parent = registryEntryFor("pattern-v4-research")!;

    expect(generation2.lineage.parentStrategyKey).toBe("pattern-v4-research");
    expect(generation2.lineage.parentResearchVersion).toBe(4);
    expect(generation2.lineage.parentTerminalReason).toBe(parent.closureReason);
  });

  it("holds no proposal or session counts, which would be stale within a day", () => {
    // momentum-v5 was at 5 sessions when §2's table was written and 6 two days later.
    const serialised = JSON.stringify(researchStrategyRegistry);
    expect(serialised).not.toMatch(/"sessions"|"proposals"|proposalCount/);
  });
});

describe("well-formedness rules", () => {
  it("refuses a closed entry with no reason", () => {
    expect(() => assertRegistryWellFormed([entry({ researchStatus: "TERMINAL", productionEligibility: "NEVER_ELIGIBLE" })]))
      .toThrow(/must record why/);
    expect(() => assertRegistryWellFormed([entry({ researchStatus: "SUPERSEDED", closureReason: "   " })]))
      .toThrow(/must record why/);
  });

  it("refuses a still-active entry that carries a closure reason", () => {
    expect(() => assertRegistryWellFormed([entry({ closureReason: "closed" })]))
      .toThrow(/still RESEARCH but carries a closure reason/);
  });

  it("refuses a TERMINAL entry that is not permanently ineligible", () => {
    expect(() => assertRegistryWellFormed([
      entry({ researchStatus: "TERMINAL", closureReason: "measured", productionEligibility: "NOT_YET_ELIGIBLE" }),
    ])).toThrow(/TERMINAL but not NEVER_ELIGIBLE/);
  });

  it("refuses a paraphrased parent reason", () => {
    /*
     * The rule §2 states in prose and this makes mechanical. A paraphrase is how "degrades the base
     * strategy monotonically on both deep ETFs" becomes "underperformed" -- and the second reads like
     * a tuning problem rather than a closed line of inquiry.
     */
    const parent = entry({
      strategyKey: "parent-research",
      researchStatus: "TERMINAL",
      productionEligibility: "NEVER_ELIGIBLE",
      closureReason: "degrades the base strategy monotonically on both deep ETFs",
    });
    const child = entry({
      strategyKey: "parent-research-v2",
      lineage: {
        parentStrategyKey: "parent-research",
        parentResearchVersion: 1,
        parentTerminalReason: "underperformed",
      },
    });

    expect(() => assertRegistryWellFormed([parent, child])).toThrow(/verbatim/);
  });

  it("accepts the same lineage once the reason matches exactly", () => {
    const reason = "degrades the base strategy monotonically on both deep ETFs";
    const parent = entry({
      strategyKey: "parent-research",
      researchStatus: "TERMINAL",
      productionEligibility: "NEVER_ELIGIBLE",
      closureReason: reason,
    });
    const child = entry({
      strategyKey: "parent-research-v2",
      lineage: { parentStrategyKey: "parent-research", parentResearchVersion: 1, parentTerminalReason: reason },
    });

    expect(() => assertRegistryWellFormed([parent, child])).not.toThrow();
  });

  it("refuses a terminal reason attributed to a parent that concluded nothing", () => {
    const parent = entry({
      strategyKey: "parent-research",
      researchStatus: "SUPERSEDED",
      productionEligibility: "NEVER_ELIGIBLE",
      closureReason: "migrated away from",
    });
    const child = entry({
      strategyKey: "parent-research-v2",
      lineage: { parentStrategyKey: "parent-research", parentResearchVersion: 1, parentTerminalReason: "invented" },
    });

    expect(() => assertRegistryWellFormed([parent, child])).toThrow(/concluded nothing/);
  });

  it("refuses lineage pointing at an unregistered parent", () => {
    expect(() => assertRegistryWellFormed([entry({
      lineage: { parentStrategyKey: "ghost", parentResearchVersion: 1, parentTerminalReason: null },
    })])).toThrow(/not registered/);
  });

  it("refuses a parent version that disagrees with the parent's own entry", () => {
    const parent = entry({ strategyKey: "parent-research", researchVersion: 7 });
    const child = entry({
      strategyKey: "child-research",
      lineage: { parentStrategyKey: "parent-research", parentResearchVersion: 3, parentTerminalReason: null },
    });

    expect(() => assertRegistryWellFormed([parent, child])).toThrow(/registered at v7/);
  });

  it("refuses duplicates and malformed hashes", () => {
    expect(() => assertRegistryWellFormed([entry(), entry()])).toThrow(/Duplicate/);
    expect(() => assertRegistryWellFormed([entry({ pinnedDefinitionHash: "short" })]))
      .toThrow(/malformed definition hash/);
  });
});

describe("guarding the running strategies", () => {
  it("reproduces every running strategy's definition hash, so the pins are real", () => {
    /*
     * The load-bearing test. The pins were read out of `research_scalp.strategy_definitions`, which
     * records what the code produced when those rows were written; this asserts the code still
     * produces them. If it did not, the pins would be a decorative constant rather than a guard.
     */
    for (const adapter of researchScalpStrategies) {
      expect(() => assertRegisteredAndUnchanged(adapter.definition)).not.toThrow();
    }
  });

  it("detects in-place tuning, which the source-file checksums cannot", () => {
    /*
     * `scalp-research-isolation.test.ts` pins the three frozen strategy *source files*. Editing the
     * `configuration` override in `research-strategies.ts` -- say `minimumConfidence: 0` to `0.5` --
     * leaves every one of those checksums intact while redefining what the accumulating cohort
     * measures. The definition hash moves, so this catches it.
     */
    const tuned = { ...definitionOf("momentum-v5-research"), strategyDefinitionHash: "b".repeat(64) };

    expect(() => assertRegisteredAndUnchanged(tuned)).toThrow(StrategyRegistryError);
    expect(() => assertRegisteredAndUnchanged(tuned)).toThrow(/edited in place/);
    // Says what to do instead, because the tempting fix is to update the pin.
    expect(() => assertRegisteredAndUnchanged(tuned)).toThrow(/Do not update the pin to match/);
  });

  it("refuses an unregistered strategy", () => {
    const unknown = { ...definitionOf("momentum-v5-research"), strategyKey: "momentum-v6-research" };

    expect(() => assertRegisteredAndUnchanged(unknown)).toThrow(/not in the Terminal Strategy Registry/);
  });

  it("refuses a version the registry does not have live", () => {
    const rewound = { ...definitionOf("momentum-v5-research"), researchVersion: 4 };

    expect(() => assertRegisteredAndUnchanged(rewound)).toThrow(/registered at 5/);
  });
});

describe("terminal strategies default to disabled", () => {
  it("excludes both terminal strategies when nothing is opted in", () => {
    const selection = selectCaptureStrategies(researchScalpStrategies, { benchmarkStrategyKeys: [] });

    expect([...selection.disabled].sort()).toEqual(["index-v3-research", "pattern-v4-research"]);
    expect(selection.active.map((a) => a.definition.strategyKey).sort())
      .toEqual(["momentum-v5-research", "pattern-v4-research-v2"]);
    expect(selection.benchmarkActivated).toEqual([]);
  });

  it("keeps today's capture behaviour identical under the shipped defaults", () => {
    /*
     * Deliberate. Disabling the terminals removes 1,135 of 1,881 opportunities (60%) and changes the
     * payload hash of 137 momentum-v5 opportunities that are co-membered with a terminal proposer, so
     * §2 requires the switch to be thrown on a recorded session boundary. A registry that did it on
     * the day it landed would be indistinguishable from a regression.
     */
    const selection = selectCaptureStrategies(researchScalpStrategies);

    expect(selection.active).toHaveLength(researchScalpStrategies.length);
    expect(selection.disabled).toEqual([]);
    expect([...selection.benchmarkActivated].sort()).toEqual(["index-v3-research", "pattern-v4-research"]);
    expect([...benchmarkResearchStrategyKeys].sort()).toEqual(["index-v3-research", "pattern-v4-research"]);
  });

  it("preserves adapter order among the active set, so capture order does not shift", () => {
    // Proposal rows are written in iteration order; reordering them would churn nothing semantically
    // but would make a diff of captured rows unreadable against history.
    const selection = selectCaptureStrategies(researchScalpStrategies);

    expect(selection.active.map((a) => a.definition.strategyKey))
      .toEqual(researchScalpStrategies.map((a) => a.definition.strategyKey));
  });

  it("refuses to benchmark-activate a superseded strategy", () => {
    expect(() => selectCaptureStrategies(researchScalpStrategies, {
      benchmarkStrategyKeys: ["pattern-v3-research"],
    })).toThrow(/SUPERSEDED and cannot be benchmark-activated/);
  });

  it("refuses an unregistered benchmark key rather than silently capturing nothing", () => {
    expect(() => selectCaptureStrategies(researchScalpStrategies, {
      benchmarkStrategyKeys: ["typo-v9-research"],
    })).toThrow(/not registered/);
  });
});
