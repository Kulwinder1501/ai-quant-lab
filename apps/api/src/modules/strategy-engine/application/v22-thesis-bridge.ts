import { approved, rejected } from "../../autonomous-v2/domain/decision-outcome.js";
import {
  structuralGateThesisProducer,
  thesisPolicyVersion,
  type AuthorizedThesisProducer,
  type NativeThesis,
  type ThesisGateInput,
  type ThesisRefusal,
  type ThesisResult,
  type ThesisSide,
} from "../../autonomous-v2/domain/thesis-producer.js";
import {
  registeredStrategies,
  strategyExecutableSides,
  strategySupportsTimeframe,
  type RegisteredStrategy,
} from "../domain/strategy-registry.js";
import type { ProposedTradeIdea, StrategyMarketContext } from "../domain/strategy.js";

/**
 * V1 publishing its entry rule into V2.2's thesis port, for differential analysis only.
 *
 * ## Why this file lives in `strategy-engine/` and not in `autonomous-v2/`
 *
 * §6's QUARANTINE bucket carries one rule: "zero import path into `autonomous-v2/`", enforced by
 * `autonomous-v2-quarantine.test.ts` walking the real import graph. A ported producer inside
 * `autonomous-v2/` would have to import V1's evaluators, and the guard would fail -- correctly.
 *
 * So the dependency is inverted. `autonomous-v2` defines the port and knows nothing about V1; the
 * legacy module adapts *itself* to the new contract and hands the result in. The arrow points from the
 * system being replaced toward the system replacing it, which is the direction that lets V1 be deleted
 * later without touching V2.2 -- and the direction that keeps the quarantine true rather than merely
 * intended.
 *
 * ## Why a ported producer exists at all
 *
 * P13 asks whether V2.2 can substitute for V1. A V2.2 carrying a *different* entry rule cannot answer
 * that: every bar would differ, every difference would be expected, and the gate would be measuring
 * two strategies instead of one platform. Porting the rule unchanged makes the decisions match by
 * construction, so a divergence means a defect in the plumbing -- sealing, coverage, instants,
 * geometry rounding -- which is what the migration actually needs to prove.
 *
 * The entry edge is a separate question, and an open one. Nothing here claims V1's rule works; the
 * live book is 362 trades at 39.2% for -Rs 39,924. This is a migration instrument, not a strategy.
 *
 * ## It can never hold authority, and that is typed
 *
 * `authority: "DIFFERENTIAL_ONLY"`, which `assertMayHoldAuthority` rejects. §6 licenses a legacy
 * thesis for "differential analysis only, not live decisions", and if that stayed a comment then P19
 * -- which grants paper authority to *some* producer -- would have nothing to check. Trading this rule
 * requires re-deriving it as a native producer under V2.2's own tests. That is deliberately not a flag.
 *
 * ## What is ported, and what is emphatically not
 *
 * Ported: the direction conditions and the geometry. Both are plain conjunctions and arithmetic --
 * Supertrend direction, EMA ordering, an RSI band, an ATR-multiple stop, an R-multiple target.
 *
 * Not ported, and not reachable from here: any *selection* among candidates. V1's evaluators each
 * return a list, and more than one registered strategy can own a timeframe. Ranking those by
 * confidence would be `scoreDirectionalSetup` rebuilt; taking the first would be `patterns[0]`. Both
 * are quarantined by name, so two distinct candidates produce `AMBIGUOUS_PROPOSALS` and no thesis.
 * I3's Opportunity Resolver is the component entitled to choose, and it does not exist yet.
 *
 * The composite confidence stays inside V1. This file never reads `proposal.confidence`, so the score
 * is not reproduced in V2.2 -- V1 applies its own `minimumConfidence` floor internally while deciding
 * whether to return a proposal at all, which is V1 deciding for itself, not V2.2 scoring a bar.
 *
 * ## V2.2's gates still apply, and the divergences they cause are the finding
 *
 * The structural gates run first and unchanged: frozen tape, executable window, pattern coverage,
 * executable side. V1 has none of them, so on a frozen-tape bar V1 proposes and this producer refuses.
 * That is a real divergence and it is the *point* -- D3 found 52 refused control points in one minute
 * on 2026-09-01 and 41 proposals already stored at prices nobody was quoting. Those rows classify as
 * `EXPECTED_ARCHITECTURAL_CHANGE` with the measurement attached, which is exactly the evidence P13
 * wants and exactly what an all-noise comparison would have buried.
 *
 * Porting the entry rule is therefore not porting V1 wholesale. The rule comes across; the defects
 * stay behind.
 */

export const portedV1PolicyVersion = "PORTED_V1_THESIS_POLICY_V1";

export class V22ThesisBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V22ThesisBridgeError";
  }
}

/** A candidate thesis with the rule that produced it, before selection is attempted. */
interface Candidate {
  readonly ruleId: string;
  readonly proposal: ProposedTradeIdea;
}

/**
 * Every proposal V1 would have acted on for this bar.
 *
 * The side restrictions apply here, not after selection: a proposal V1 would not have traded must not
 * appear as one V1 made. Reading them from the operational registry is deliberate -- §6 lists
 * empirical side restrictions under KEEP AS PRINCIPLE, because the long side being -Rs 13,414 over 62
 * trades is a measurement about the instrument rather than V1 decision logic.
 */
function candidatesFor(
  context: StrategyMarketContext,
  strategies: readonly RegisteredStrategy[],
): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const strategy of strategies) {
    if (!strategySupportsTimeframe(strategy, context.candle.timeframe)) continue;
    const executable = strategyExecutableSides(strategy);
    const evaluator = new strategy.StrategyClass();
    for (const proposal of evaluator.evaluate(context, strategy.registration.configuration)) {
      if (!executable.includes(proposal.side)) continue;
      candidates.push({ ruleId: `${strategy.registration.strategyKey}:v${strategy.registration.version}`, proposal });
    }
  }
  return candidates;
}

/**
 * Whether two candidates are the same decision.
 *
 * Geometry, not identity: two strategies proposing an identical side, entry, stop and target are one
 * decision arrived at twice, and refusing to act on it as ambiguous would throw away a bar where V1
 * plainly acted. Two strategies proposing *different* geometry is a genuine choice, and this producer
 * is not entitled to make it.
 *
 * Compared at full precision, because V1's own tick rounding has already run. Quantising again here
 * would be a second rounding policy, and the two would drift.
 */
function sameDecision(a: Candidate, b: Candidate): boolean {
  return a.proposal.side === b.proposal.side
    && a.proposal.entryPrice === b.proposal.entryPrice
    && a.proposal.stopLoss === b.proposal.stopLoss
    && a.proposal.targetPrice === b.proposal.targetPrice;
}

function distinctDecisions(candidates: readonly Candidate[]): readonly Candidate[] {
  const distinct: Candidate[] = [];
  for (const candidate of candidates) {
    if (!distinct.some((kept) => sameDecision(kept, candidate))) distinct.push(candidate);
  }
  return distinct;
}

/**
 * Builds the ported producer for one sealed bar.
 *
 * A factory rather than a bare `ThesisProducer` because V1's evaluators need a
 * `StrategyMarketContext`, which `ThesisGateInput` does not carry -- and must not start carrying, or
 * the V2.2 port would take on V1's shape permanently.
 *
 * The caller passes **the same in-memory context the snapshot was sealed from**. Not a context
 * re-read for this bar, and not one rebuilt from the snapshot: `MarketSnapshot` drops
 * `contextCandleIds` and pattern `details`, so a rebuild would silently hand V1 a thinner world than
 * V1 evaluated, and every resulting difference would be misread as a platform defect. That is checked,
 * not trusted.
 */
export function portedV1ThesisProducer(input: {
  readonly context: StrategyMarketContext;
  readonly instrumentSymbol: string;
  /**
   * Which V1 strategies to consult. Defaults to the operational registry, which is what production
   * uses; injectable so the refusal-to-select behaviour can be proved on a constructed disagreement
   * rather than on two real strategies happening to disagree on some future bar.
   */
  readonly strategies?: readonly RegisteredStrategy[];
}): AuthorizedThesisProducer {
  const strategies = input.strategies ?? registeredStrategies;
  const produce = (gate: ThesisGateInput): ThesisResult => {
    /*
     * One context, one bar. The snapshot's bar and the legacy context must describe the same instant,
     * or V1's answer is about a different bar than the one V2.2 sealed -- and the comparison would be
     * uninterpretable in exactly the way `assertComparable` refuses at the P13 boundary. Checked on
     * the close instant and the close price: the instant catches a stale or mismatched context, and
     * the price catches a bar that was revised under the same timestamp, which this system has seen.
     */
    if (gate.snapshot.bar.closeTime.getTime() !== input.context.candle.closeTime.getTime()) {
      throw new V22ThesisBridgeError(
        `The sealed snapshot closes at ${gate.snapshot.bar.closeTime.toISOString()} but the legacy `
        + `context closes at ${input.context.candle.closeTime.toISOString()}. A ported thesis must be `
        + "produced from the context the snapshot was sealed from, or V1 and V2.2 answer about "
        + "different bars and the divergence means nothing.",
      );
    }
    if (gate.snapshot.bar.close !== input.context.candle.close) {
      throw new V22ThesisBridgeError(
        `The sealed snapshot closes at ${gate.snapshot.bar.close} but the legacy context closes at `
        + `${input.context.candle.close} for the same instant. The bar was revised between sealing `
        + "and evaluation; refusing rather than comparing two versions of one bar.",
      );
    }

    /*
     * V2.2's gates first, unchanged.
     *
     * Reusing the native producer rather than restating its conditions: two copies of the frozen-tape
     * rule would drift, and the one that drifts silently is the one nobody is looking at. Its only
     * non-refusal outcome is the abstention, so anything else is passed straight through and the gate
     * order -- which is itself a finding -- is preserved by construction.
     */
    const structural = structuralGateThesisProducer(gate);
    if (structural.outcome !== "NO_ACTION") return structural;

    const distinct = distinctDecisions(candidatesFor(input.context, strategies));
    if (distinct.length === 0) {
      /*
       * V1 had nothing either. Reported as a rejection rather than the native abstention, because
       * they are different facts: `NO_ESTABLISHED_ENTRY_RULE` means V2.2 owns no rule, and this means
       * a rule ran and declined. Collapsing them would make the ported producer indistinguishable
       * from the native one in exactly the runs where P13 needs to tell them apart.
       */
      return rejected<ThesisRefusal>(["NO_ESTABLISHED_ENTRY_RULE"]);
    }
    if (distinct.length > 1) {
      return rejected<ThesisRefusal>(["AMBIGUOUS_PROPOSALS"]);
    }

    const only = distinct[0]!;
    const side: ThesisSide = only.proposal.side === "LONG" ? "LONG" : "SHORT";
    const thesis: NativeThesis = {
      instrumentSymbol: input.instrumentSymbol,
      side,
      entryReference: only.proposal.entryPrice,
      stopLoss: only.proposal.stopLoss,
      targetPrice: only.proposal.targetPrice,
      /*
       * The originating V1 rule, at its version. An outcome from this thesis must be attributable to
       * `momentum-scalp-index:v1` and not to "V2.2" -- otherwise a ported rule's losses would be
       * recorded against the new architecture, which is the specific misattribution this whole
       * migration exists to avoid.
       */
      ruleId: only.ruleId,
      policyVersion: portedV1PolicyVersion,
    };
    return approved(thesis);
  };

  return Object.freeze({
    producerId: `ported-v1@${thesisPolicyVersion}`,
    authority: "DIFFERENTIAL_ONLY" as const,
    produce,
  });
}
