import { describe, expect, it } from "vitest";
import { researchStrategyRegistry } from "./domain/terminal-strategy-registry.js";
import { findRegisteredStrategy, registeredStrategies } from "../../strategy-engine/domain/strategy-registry.js";

/**
 * Binds the research Terminal Strategy Registry to the operational strategy registry.
 *
 * ## The gap this closes
 *
 * Found 2026-09-02. The research harness recorded `index-v3-research` and `pattern-v4-research` as
 * TERMINAL / NEVER_ELIGIBLE -- measured, permanent verdicts -- while both of their operational twins
 * were live and trading. The verdict was written down and propagated nowhere, and the index twin was
 * -Rs 12,030 over 155 trades on its enabled timeframe while carrying a registry comment justifying it
 * as "roughly break-even -Rs 674 over 76 trades".
 *
 * ## Why a test rather than an import
 *
 * `scalp-research-isolation.test.ts` forbids execution code from importing research internals, and
 * that severance is the harness's central guarantee -- production must not be able to reach into
 * research at runtime. Its scans exclude `*.test.ts`, so a test is the one place allowed to hold both
 * registries at once. The link itself is therefore a *declared* key
 * (`RegisteredResearchStrategy.operationalStrategyKey`) verified here, not a runtime dependency.
 *
 * ## What it demands, and what it deliberately does not
 *
 * It does not force a TERMINAL verdict to disable its twin. A research TERMINAL judges a line of
 * inquiry under the harness's canonical geometry; whether the live strategy keeps trading is a
 * separate decision with its own evidence, and letting a research conclusion silently close a
 * production strategy would be the same failure pointing the other way.
 *
 * What it forbids is the verdict going unnoticed. A registered twin must carry an explicit
 * acknowledgement naming the research key, repeating the closure reason verbatim, and stating its
 * disposition -- which is required whether the strategy is enabled or disabled, so that turning one
 * off cannot delete the reasoning that justified it. Silence fails.
 */

describe("terminal research verdicts reach the operational registry", () => {
  const terminal = researchStrategyRegistry.filter((entry) => entry.researchStatus === "TERMINAL");

  it("has terminal entries to check, so a pass cannot come from an empty set", () => {
    // The self-check. Without it, deleting the terminal entries would make this file vacuously green.
    expect(terminal.length).toBeGreaterThanOrEqual(2);
    expect(terminal.map((entry) => entry.strategyKey).sort())
      .toEqual(["index-v3-research", "pattern-v4-research"]);
  });

  it("names an operational twin that actually exists, or none at all", () => {
    /*
     * A stale key would make the whole guard silently inert -- it would look for an acknowledgement
     * on a strategy that no longer exists and find nothing to complain about.
     */
    for (const entry of researchStrategyRegistry) {
      if (entry.operationalStrategyKey === null) continue;
      expect(findRegisteredStrategy(entry.operationalStrategyKey), entry.strategyKey).not.toBeNull();
    }
  });

  it("requires an enabled twin of a TERMINAL verdict to acknowledge it explicitly", () => {
    for (const entry of terminal) {
      if (entry.operationalStrategyKey === null) continue;
      const twin = findRegisteredStrategy(entry.operationalStrategyKey);
      if (twin === null) continue; // Disabling by removal is a valid response.

      const acknowledgement = twin.terminalResearchAcknowledgement;
      expect(
        acknowledgement,
        `${entry.operationalStrategyKey} is registered while its research twin ${entry.strategyKey} `
        + "is TERMINAL, and carries no acknowledgement. Either remove it from the operational "
        + "registry entirely, or record terminalResearchAcknowledgement stating its disposition -- "
        + "required even when disabled, so the reasoning survives the disable.",
      ).toBeDefined();
      expect(acknowledgement!.researchStrategyKey).toBe(entry.strategyKey);
      // Verbatim, so the reason cannot soften into a paraphrase on the production side.
      expect(acknowledgement!.closureReason).toBe(entry.closureReason);
      expect(acknowledgement!.disposition.trim().length).toBeGreaterThan(40);
    }
  });

  it("does not let a non-terminal strategy carry a terminal acknowledgement", () => {
    // The reverse error: an acknowledgement referring to a verdict that was never reached would
    // misrepresent the research record just as badly.
    for (const strategy of registeredStrategies) {
      const acknowledgement = strategy.terminalResearchAcknowledgement;
      if (!acknowledgement) continue;
      const research = researchStrategyRegistry
        .find((entry) => entry.strategyKey === acknowledgement.researchStrategyKey);

      expect(research, acknowledgement.researchStrategyKey).toBeDefined();
      expect(research!.researchStatus, acknowledgement.researchStrategyKey).toBe("TERMINAL");
      expect(research!.operationalStrategyKey).toBe(strategy.registration.strategyKey);
    }
  });
});
