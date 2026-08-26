import { describe, expect, it } from "vitest";
import {
  defaultMomentumScalpIndexStrategyConfiguration,
} from "../../../strategy-engine/domain/momentum-scalp-index-strategy.js";
import {
  defaultMomentumScalpPatternStrategyConfiguration,
} from "../../../strategy-engine/domain/momentum-scalp-pattern-strategy.js";
import {
  defaultMomentumScalpStrategyConfiguration,
} from "../../../strategy-engine/domain/momentum-scalp-strategy.js";
import { researchScalpStrategies } from "./research-strategies.js";

/**
 * Pins the Option-A ungating: the research versions must capture the setups the historical gate threw
 * away, while remaining able to reconstruct the historical population exactly.
 *
 * These are configuration-level assertions rather than end-to-end evaluations because the failure mode
 * being guarded is silent: a research version that quietly re-acquires its score gate still produces
 * plausible-looking rows, just of a filtered population, and no downstream estimate would look wrong.
 */
describe("research strategy ungating", () => {
  const byKey = Object.fromEntries(researchScalpStrategies.map((s) => [s.definition.strategyKey, s]));

  it("registers the ungated research versions, distinct from the gated historical ones", () => {
    // A version string must mean one definition forever; the gated captures live under the old keys.
    // `pattern-v4-research-v2` is the Pattern Intelligence sibling cohort: a separate key running in
    // parallel, deliberately not a replacement for `pattern-v4-research`, whose rows keep their
    // meaning.
    expect(Object.keys(byKey).sort()).toEqual([
      "index-v3-research", "momentum-v5-research", "pattern-v4-research", "pattern-v4-research-v2",
    ]);
  });

  it("lifts each strategy's own score gate, not a generically-named one", () => {
    // The pattern strategy gates on scoreThreshold and has no minimumConfidence at all. Setting the
    // wrong key would leave its 5-of-9 confluence gate fully active while looking ungated.
    expect(byKey["momentum-v5-research"]!.definition.configuration.minimumConfidence).toBe(0);
    expect(byKey["index-v3-research"]!.definition.configuration.minimumConfidence).toBe(0);
    expect(byKey["pattern-v4-research"]!.definition.configuration.scoreThreshold).toBe(0);
    expect(byKey["pattern-v4-research"]!.definition.configuration.minimumConfidence).toBeUndefined();
  });

  it("keeps the trigger conditions that define a setup", () => {
    // Ungating removes the score filter, not the strategy. The every-bar baseline already exists as
    // the matched control grid; an EMA/RSI/pattern trigger is still what makes a bar a candidate.
    const index = byKey["index-v3-research"]!.definition.configuration;
    expect(index.rsiLongMin).toBe(defaultMomentumScalpIndexStrategyConfiguration.rsiLongMin);
    expect(index.atrStopMultiple).toBe(defaultMomentumScalpIndexStrategyConfiguration.atrStopMultiple);
    expect(index.expiryCandles).toBe(defaultMomentumScalpIndexStrategyConfiguration.expiryCandles);
  });

  it("changes the definition hash, so ungated captures can never merge with gated ones", () => {
    // The hash covers the configuration, so this is structural rather than a naming convention.
    const hashes = researchScalpStrategies.map((s) => s.definition.strategyDefinitionHash);
    // Tied to the registry length rather than a literal: the invariant is that every registered
    // strategy has its own hash, which must hold as cohorts are added, not just at a count of three.
    expect(new Set(hashes).size).toBe(researchScalpStrategies.length);
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still recognises the historical thresholds, so the gated subset stays reconstructible", () => {
    // The recorded legacyScoreGate reads these values; if a default moved and the research copy did
    // not, the reconstruction filter would silently describe a population that never existed.
    expect(defaultMomentumScalpStrategyConfiguration.minimumConfidence).toBe(0.5);
    expect(defaultMomentumScalpIndexStrategyConfiguration.minimumConfidence).toBe(0.5);
    expect(defaultMomentumScalpPatternStrategyConfiguration.scoreThreshold).toBe(5);
  });
});
