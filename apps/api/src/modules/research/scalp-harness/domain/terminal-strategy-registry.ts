import type { ResearchStrategyDefinition } from "./contracts.js";

/**
 * Scalp Engine V2 §2's Terminal Strategy Registry: the permanent record of what each research
 * strategy's line of inquiry concluded, so a closed one cannot be re-activated or tuned in place.
 *
 * ## Why a registry rather than a boolean on the adapter
 *
 * The thing being recorded is not "is this running" -- that is a scheduling question and it changes.
 * It is "what did this line of inquiry conclude, and may it ever reach production", which must
 * outlive the adapter. `index-v3-research`'s horizon sweep returned `NO_VIABLE_HORIZON`; that verdict
 * has to survive the deletion of the adapter that produced it, or the next person re-runs the sweep.
 *
 * §2 is explicit that entries key on `strategyKey` and never on an implementation class name -- the
 * previous revision of that document listed `PatternIntelligenceResearchAdapter`, a TypeScript class.
 * `strategyKey` is the artifact identity; the class is an implementation detail that can be rewritten
 * without changing what was measured.
 *
 * ## The registry holds seven entries, not the four the plan tabulates
 *
 * Found by querying `research_scalp.strategy_definitions` rather than reading the plan: three further
 * definitions are persisted -- `index-v2-research`, `momentum-v4-research` and `pattern-v3-research`,
 * all on the superseded `scalp-raw-context-v1` feature schema, all with **zero** captured proposals.
 * They were registered and then replaced when the feature schema moved to v2, before any of them
 * produced evidence.
 *
 * Leaving them out would defeat the registry's purpose on its first real test: an unrecorded
 * `strategyKey` that already exists in the database is precisely the thing someone could revive
 * believing it was never tried.
 *
 * ## `SUPERSEDED` is a third status, and conflating it with `TERMINAL` would be a false claim
 *
 * §2 names two states. The data forces a third. `TERMINAL` in that document means "the measured line
 * of inquiry is closed" and each terminal entry carries a measured reason. The three v1-schema
 * definitions have no such reason: nothing was concluded about them, they were migrated away from
 * with no captured rows at all.
 *
 * Recording them as `TERMINAL` would assert a research finding that was never made -- and the reason
 * strings are read by people deciding whether to retry an idea. `SUPERSEDED` says the true thing: not
 * eligible, not revivable under this key, and *not* evidence against the idea.
 *
 * ## Terminal strategies default to disabled, and disabling is not measurement-neutral
 *
 * §2 requires `TERMINAL -> default DISABLED` with benchmark capture as an explicit per-strategy
 * opt-in, and warns why the switch cannot be thrown casually: `resolveOpportunities` groups proposals
 * strategy-agnostically, so proposals from different strategies at one decision instant share an
 * opportunity and `payloadHash` covers `proposalIds`. Measured 2026-08-31: 1,135 of 1,881
 * opportunities (60%) have a terminal strategy as their sole proposer and would disappear, and 137 of
 * `momentum-v5-research`'s 436 are co-membered with a terminal strategy and would change hash.
 *
 * So `selectCaptureStrategies` implements the default, and both terminal strategies are currently
 * listed in `benchmarkResearchStrategyKeys` -- which keeps today's capture behaviour byte-identical
 * while making the cost explicit and revocable at a session boundary. Removing a key from that list
 * is a research decision with a recorded step in opportunity payload hashes, never a tidy-up.
 */

export const terminalStrategyRegistryVersion = "TERMINAL_STRATEGY_REGISTRY_V1";

/**
 * `RESEARCH` -- accumulating evidence. `TERMINAL` -- measured and closed. `SUPERSEDED` -- replaced
 * before concluding anything, carrying no evidence either way.
 */
export type StrategyResearchStatus = "RESEARCH" | "TERMINAL" | "SUPERSEDED";

/** `NEVER_ELIGIBLE` is permanent under this key; a retry must be a new artifact with a new key. */
export type ProductionEligibility = "NEVER_ELIGIBLE" | "NOT_YET_ELIGIBLE";

export interface StrategyLineage {
  readonly parentStrategyKey: string | null;
  readonly parentResearchVersion: number | null;
  /**
   * The parent's closure reason, carried forward **verbatim**.
   *
   * §2 requires this and forbids paraphrase, which is enforceable rather than merely asked for:
   * `assertRegistryWellFormed` compares this string to the parent's own `closureReason` and refuses
   * a mismatch. A paraphrase is how "degrades the base strategy monotonically on both deep ETFs"
   * becomes "underperformed", and the second reads like a tuning problem.
   *
   * Non-null exactly when the parent is `TERMINAL`: a `SUPERSEDED` parent concluded nothing, so
   * there is no terminal reason to carry and inventing one would misrepresent the history.
   */
  readonly parentTerminalReason: string | null;
}

export interface RegisteredResearchStrategy {
  readonly strategyKey: string;
  readonly researchVersion: number;
  readonly researchStatus: StrategyResearchStatus;
  readonly productionEligibility: ProductionEligibility;
  /** Required for `TERMINAL` and `SUPERSEDED`, and necessarily null for `RESEARCH`. */
  readonly closureReason: string | null;
  /**
   * The definition hash this entry was recorded against.
   *
   * This is the in-place tuning guard. `scalp-research-isolation.test.ts` already pins the *source
   * files* of the three frozen strategy classes, which catches an edit to a strategy's own code. It
   * does not catch an edit to the `configuration` override in `research-strategies.ts` -- changing
   * `minimumConfidence: 0` there leaves every source checksum intact while silently redefining what
   * the accumulating cohort measures. The definition hash covers that, so pinning it closes the gap.
   *
   * Asymmetry worth knowing: for the four live strategies the pin is a real guard, and the test suite
   * re-derives it from the running adapters on every run. For the three `SUPERSEDED` entries no code
   * produces a definition any more, so their pins were read from
   * `research_scalp.strategy_definitions` and cannot be re-derived -- they identify the historical
   * artifact rather than guarding a live one.
   */
  readonly pinnedDefinitionHash: string;
  readonly lineage: StrategyLineage;
  /**
   * The operational `strategyKey` this research artifact is a frozen copy of, or null.
   *
   * Declared here so a TERMINAL verdict can be *propagated* rather than merely recorded. Without it,
   * a research line of inquiry can be closed as never-eligible while its production twin keeps
   * trading, which is exactly the state found on 2026-09-02: both TERMINAL entries had live
   * operational twins and nothing connected the two.
   *
   * It cannot be an import. `scalp-research-isolation.test.ts` forbids execution code from reaching
   * into research internals, and that severance is the harness's whole guarantee -- so the link is a
   * declared key, checked by a test that is allowed to see both sides.
   *
   * Derived from which class each research adapter wraps, not from name similarity. Note that
   * `pattern-v4-research` wraps `MomentumScalpPatternStrategyV2`, so its twin is the operational
   * *v2* key despite the research key reading as generation 1.
   *
   * Null for the three SUPERSEDED entries: their implementations are no longer in the codebase, so a
   * twin cannot be verified from current code, and guessing one would assert an unverifiable link.
   * They are also never eligible under any key, so nothing turns on it.
   */
  readonly operationalStrategyKey: string | null;
}

export class StrategyRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrategyRegistryError";
  }
}

/** Verbatim from Scalp Engine V2 §2, and re-used by `pattern-v4-research-v2`'s lineage. */
const PATTERN_V4_TERMINAL_REASON =
  "degrades the base strategy monotonically on both deep ETFs";
const INDEX_V3_TERMINAL_REASON =
  "horizon sweep returned NO_VIABLE_HORIZON; both width and holding period exhausted";
/** The three v1-schema definitions share one history, so they share one reason string. */
const V1_SCHEMA_SUPERSEDED_REASON =
  "replaced when the feature schema moved from scalp-raw-context-v1 to v2; zero captured proposals, "
  + "so it carries no evidence for or against the idea";

/**
 * Deliberately holds no session or proposal counts.
 *
 * §2's table carries them and they were accurate on 2026-08-31. In code they would be wrong the next
 * trading day -- `momentum-v5-research` was at 5 sessions when that table was written and 6 by
 * 2026-09-02. Counts belong in a document with a measurement date, or in a query. Status and reason
 * are what the registry is for, and they only change by decision.
 */
export const researchStrategyRegistry: readonly RegisteredResearchStrategy[] = [
  {
    strategyKey: "momentum-v5-research",
    operationalStrategyKey: "momentum-scalp",
    researchVersion: 5,
    researchStatus: "RESEARCH",
    productionEligibility: "NOT_YET_ELIGIBLE",
    closureReason: null,
    pinnedDefinitionHash: "9c4f0cdfd26e15c69308e54c418aca71b116b3ef9757897fb6b5756f868b963b",
    lineage: {
      parentStrategyKey: "momentum-v4-research",
      parentResearchVersion: 4,
      parentTerminalReason: null,
    },
  },
  {
    strategyKey: "index-v3-research",
    operationalStrategyKey: "momentum-scalp-index",
    researchVersion: 3,
    researchStatus: "TERMINAL",
    productionEligibility: "NEVER_ELIGIBLE",
    closureReason: INDEX_V3_TERMINAL_REASON,
    pinnedDefinitionHash: "f1adfdef985986b9e0d4d10737c1943f78b2d6e8c6f92ab79bd3cf6cde594030",
    lineage: {
      parentStrategyKey: "index-v2-research",
      parentResearchVersion: 2,
      parentTerminalReason: null,
    },
  },
  {
    strategyKey: "pattern-v4-research",
    // Wraps MomentumScalpPatternStrategyV2, so the twin is the v2 operational key.
    operationalStrategyKey: "momentum-scalp-pattern-v2",
    researchVersion: 4,
    researchStatus: "TERMINAL",
    productionEligibility: "NEVER_ELIGIBLE",
    closureReason: PATTERN_V4_TERMINAL_REASON,
    pinnedDefinitionHash: "1f9befea4d1c93121d1e33bfda23daca790c25bc3854f9cbd154e79e1d71e47b",
    lineage: {
      parentStrategyKey: "pattern-v3-research",
      parentResearchVersion: 3,
      parentTerminalReason: null,
    },
  },
  {
    /*
     * The generation-2 retry §2 requires to be machine-readable, so the research history is not
     * misread as a fresh idea. Its prior is strongly negative and the registry says so through the
     * carried parent reason rather than by staying silent.
     */
    strategyKey: "pattern-v4-research-v2",
    // Its own PatternIntelligenceResearchAdapter; no operational strategy implements it.
    operationalStrategyKey: null,
    researchVersion: 2,
    researchStatus: "RESEARCH",
    productionEligibility: "NOT_YET_ELIGIBLE",
    closureReason: null,
    pinnedDefinitionHash: "16e8edea3670520c2beb0b0572ca7152ca96abe92f1bf952be92fa6ab6c3186d",
    lineage: {
      parentStrategyKey: "pattern-v4-research",
      parentResearchVersion: 4,
      parentTerminalReason: PATTERN_V4_TERMINAL_REASON,
    },
  },
  {
    strategyKey: "momentum-v4-research",
    operationalStrategyKey: null,
    researchVersion: 4,
    researchStatus: "SUPERSEDED",
    productionEligibility: "NEVER_ELIGIBLE",
    closureReason: V1_SCHEMA_SUPERSEDED_REASON,
    pinnedDefinitionHash: "04a5098b76243d1993b3ad0e92775929bee3f05aaa3db7a4996fd515aac46b0a",
    lineage: { parentStrategyKey: null, parentResearchVersion: null, parentTerminalReason: null },
  },
  {
    strategyKey: "index-v2-research",
    operationalStrategyKey: null,
    researchVersion: 2,
    researchStatus: "SUPERSEDED",
    productionEligibility: "NEVER_ELIGIBLE",
    closureReason: V1_SCHEMA_SUPERSEDED_REASON,
    pinnedDefinitionHash: "b659f7953df2d63ae3a9c255b2bb09ebf9b738651c163cfea4741df322cbd81c",
    lineage: { parentStrategyKey: null, parentResearchVersion: null, parentTerminalReason: null },
  },
  {
    strategyKey: "pattern-v3-research",
    operationalStrategyKey: null,
    researchVersion: 3,
    researchStatus: "SUPERSEDED",
    productionEligibility: "NEVER_ELIGIBLE",
    closureReason: V1_SCHEMA_SUPERSEDED_REASON,
    pinnedDefinitionHash: "8117219358598c80b750387c87193da7707058763f0c1f636e15775167fa7253",
    lineage: { parentStrategyKey: null, parentResearchVersion: null, parentTerminalReason: null },
  },
];

/**
 * The explicit per-strategy benchmark opt-in §2 requires.
 *
 * Both terminal strategies are listed, so capture behaviour is unchanged by the introduction of this
 * registry. That is intentional: a registry that silently removed 60% of opportunities on the day it
 * landed would be indistinguishable from a regression, and §2 requires the change to happen on a
 * recorded session boundary.
 */
export const benchmarkResearchStrategyKeys: readonly string[] = [
  "index-v3-research",
  "pattern-v4-research",
];

export function registryEntryFor(strategyKey: string): RegisteredResearchStrategy | null {
  return researchStrategyRegistry.find((entry) => entry.strategyKey === strategyKey) ?? null;
}

/**
 * Internal consistency of the registry itself, so a malformed entry cannot ship.
 *
 * Every rule here is one §2 states in prose. Stating them as assertions is what makes the difference
 * between a table someone maintains and a record that cannot drift.
 */
export function assertRegistryWellFormed(
  entries: readonly RegisteredResearchStrategy[] = researchStrategyRegistry,
): void {
  const lookup = (key: string): RegisteredResearchStrategy | null =>
    entries.find((candidate) => candidate.strategyKey === key) ?? null;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.strategyKey)) {
      throw new StrategyRegistryError(`Duplicate registry entry for ${entry.strategyKey}.`);
    }
    seen.add(entry.strategyKey);

    const closed = entry.researchStatus === "TERMINAL" || entry.researchStatus === "SUPERSEDED";
    if (closed && (entry.closureReason === null || entry.closureReason.trim() === "")) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} is ${entry.researchStatus} and must record why. An unexplained closure `
        + "is indistinguishable from an abandoned experiment, and the next person re-runs it.",
      );
    }
    if (entry.researchStatus === "RESEARCH" && entry.closureReason !== null) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} is still RESEARCH but carries a closure reason.`,
      );
    }
    if (entry.researchStatus === "TERMINAL" && entry.productionEligibility !== "NEVER_ELIGIBLE") {
      throw new StrategyRegistryError(
        `${entry.strategyKey} is TERMINAL but not NEVER_ELIGIBLE. A closed line of inquiry cannot `
        + "become production-eligible without becoming a new artifact under a new key.",
      );
    }
    if (!/^[0-9a-f]{64}$/.test(entry.pinnedDefinitionHash)) {
      throw new StrategyRegistryError(`${entry.strategyKey} has a malformed definition hash pin.`);
    }

    const { parentStrategyKey, parentResearchVersion, parentTerminalReason } = entry.lineage;
    if ((parentStrategyKey === null) !== (parentResearchVersion === null)) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} names a parent key without a version, or the reverse.`,
      );
    }
    if (parentStrategyKey === null) {
      if (parentTerminalReason !== null) {
        throw new StrategyRegistryError(`${entry.strategyKey} carries a parent reason with no parent.`);
      }
      continue;
    }
    const parent = lookup(parentStrategyKey);
    if (parent === null) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} names parent ${parentStrategyKey}, which is not registered. Lineage `
        + "pointing at an unrecorded artifact is how a retry gets read as a fresh idea.",
      );
    }
    if (parent.researchVersion !== parentResearchVersion) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} claims parent ${parentStrategyKey} at v${parentResearchVersion}, but it `
        + `is registered at v${parent.researchVersion}.`,
      );
    }
    const parentIsTerminal = parent.researchStatus === "TERMINAL";
    if (parentIsTerminal && parentTerminalReason !== parent.closureReason) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} must carry parent ${parentStrategyKey}'s terminal reason verbatim.\n`
        + `  parent:  ${parent.closureReason}\n  carried: ${parentTerminalReason}`,
      );
    }
    if (!parentIsTerminal && parentTerminalReason !== null) {
      throw new StrategyRegistryError(
        `${entry.strategyKey} carries a terminal reason for parent ${parentStrategyKey}, which is `
        + `${parent.researchStatus} and concluded nothing.`,
      );
    }
  }
}

/**
 * Every strategy that runs must be registered, at its registered version, with its pinned hash.
 *
 * The three failures this separates matter, because the remedy differs: an unregistered key means
 * someone added a strategy without recording what it is for; a version mismatch means the registry
 * and the code disagree about which generation is live; a hash mismatch means a registered strategy
 * was edited in place, which is the thing §2 exists to prevent.
 */
export function assertRegisteredAndUnchanged(
  definition: ResearchStrategyDefinition,
): RegisteredResearchStrategy {
  const entry = registryEntryFor(definition.strategyKey);
  if (entry === null) {
    throw new StrategyRegistryError(
      `${definition.strategyKey} is not in the Terminal Strategy Registry. Add an entry recording its `
      + "research status, production eligibility and lineage before it captures anything.",
    );
  }
  if (entry.researchVersion !== definition.researchVersion) {
    throw new StrategyRegistryError(
      `${definition.strategyKey} runs at researchVersion ${definition.researchVersion} but is `
      + `registered at ${entry.researchVersion}.`,
    );
  }
  if (entry.pinnedDefinitionHash !== definition.strategyDefinitionHash) {
    throw new StrategyRegistryError(
      `${definition.strategyKey} was edited in place: its definition hash is now `
      + `${definition.strategyDefinitionHash} but the registry pins `
      + `${entry.pinnedDefinitionHash}.\nA changed definition is a new artifact -- give it a new `
      + "researchVersion (or a new strategyKey) and a new registry entry, so the accumulating cohort "
      + "keeps meaning what it meant. Do not update the pin to match.",
    );
  }
  return entry;
}

export interface CaptureStrategySelection<TAdapter> {
  /** The adapters that will run: every `RESEARCH` entry, plus terminals opted in as benchmarks. */
  readonly active: readonly TAdapter[];
  readonly benchmarkActivated: readonly string[];
  readonly disabled: readonly string[];
}

/**
 * Applies §2's `TERMINAL -> default DISABLED` rule to a set of adapters.
 *
 * Also validates each adapter through `assertRegisteredAndUnchanged`, because the selection point is
 * the one place every capture path passes through, and a guard that runs everywhere is worth more
 * than one that runs where someone remembered to call it.
 *
 * A `SUPERSEDED` strategy cannot be benchmark-activated. Its rows would be captured under an obsolete
 * feature schema and would not be comparable with anything current, so silently honouring the request
 * would produce exactly the incomparable population the harness refuses elsewhere.
 */
export function selectCaptureStrategies<TAdapter extends { readonly definition: ResearchStrategyDefinition }>(
  adapters: readonly TAdapter[],
  options: { readonly benchmarkStrategyKeys: readonly string[] } = {
    benchmarkStrategyKeys: benchmarkResearchStrategyKeys,
  },
): CaptureStrategySelection<TAdapter> {
  assertRegistryWellFormed();

  for (const key of options.benchmarkStrategyKeys) {
    const entry = registryEntryFor(key);
    if (entry === null) {
      throw new StrategyRegistryError(`Benchmark key ${key} is not registered.`);
    }
    if (entry.researchStatus === "SUPERSEDED") {
      throw new StrategyRegistryError(
        `${key} is SUPERSEDED and cannot be benchmark-activated: it is defined against an obsolete `
        + "feature schema, so its rows would not be comparable with current capture.",
      );
    }
  }

  const active: TAdapter[] = [];
  const benchmarkActivated: string[] = [];
  const disabled: string[] = [];
  for (const adapter of adapters) {
    const entry = assertRegisteredAndUnchanged(adapter.definition);
    if (entry.researchStatus === "RESEARCH") {
      active.push(adapter);
      continue;
    }
    if (entry.researchStatus === "TERMINAL" && options.benchmarkStrategyKeys.includes(entry.strategyKey)) {
      active.push(adapter);
      benchmarkActivated.push(entry.strategyKey);
      continue;
    }
    disabled.push(entry.strategyKey);
  }
  return { active, benchmarkActivated, disabled };
}
