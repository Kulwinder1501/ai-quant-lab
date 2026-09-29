import { sealDecisionContext, type BaseDecisionContext } from "../domain/decision-context.js";
import type { DecisionPipelineInput } from "../domain/decision-pipeline.js";
import { legacyPatternObservations, type LegacyCandlestickPattern } from "./pattern-adapter.js";
import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import type { PitInstants } from "../../platform/pit/pit-instants.js";
import type { InstrumentRiskSnapshot } from "../../platform/risk/risk-snapshot.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { opportunityGroupingPolicyVersion } from "../domain/opportunity-resolver.js";
import { stateInterpretationPolicyVersion } from "../domain/state-interpreter.js";
import { thesisBuilderPolicyVersion, thesisGeometryPolicyVersion } from "../domain/thesis-builder.js";
import { edgeAssessmentPolicyVersion } from "../domain/edge-assessor.js";
import { riskApprovalPolicyVersion } from "../domain/risk-approver.js";
import { instrumentSelectionPolicyVersion } from "../domain/instrument-policy.js";
import { executionSimulationPolicyVersion } from "../domain/execution-simulator.js";

/**
 * Assembles a real `DecisionPipelineInput` from live facts the shadow-decision CLI already has in
 * scope, plus a few small additional live lookups the CLI performs alongside its existing ones.
 *
 * Pure: every field here is caller-supplied data, not a database call. The CLI does the fetching
 * (reusing what it already has, plus `PostgresInstitutionalFlowRepository.findLatest`,
 * `PostgresStrategyMarketContextRepository.findRawVolatilityReading`, and
 * `PostgresOptionChainRepository.latestSnapshot` twice); this function only maps and combines.
 *
 * ## `decisionAt`/`dataThrough` needs its own instants, not the sealed snapshot's
 *
 * `sealDecisionContext` requires `instants.dataThrough` strictly before `decisionAt` (I10 -- an
 * equality would admit the bar the decision is about). The CLI's existing `instants` for
 * `marketSnapshotFromLegacyContext` stamps `dataThrough` *equal to* the bar's close -- a different,
 * looser convention that must not change, since it is part of the sealed `MarketSnapshot`'s content
 * address and the old shadow path already depends on that address matching what was stored. So this
 * builds a **separate** `PitInstants` for the decision context: `decisionAt` is the same grid slot
 * (the bar's close), but `dataThrough` is `decisionAt - 1ms`, the same convention `decision-pipeline.test.ts`'s
 * own fixtures already use. The pattern observations still carry the *original*, unmodified instants --
 * they describe when the sealed snapshot was built, not this decision's own leakage boundary.
 *
 * ## Two documented placeholders
 *
 * `accountSnapshot` and `costBps` are synthetic, not sourced from a real account or a real option-cost
 * model -- see their own constants below for why. Both are cheap to replace later because P13's
 * `canonicalDecisionPipelineOutcome` only reads the thesis stage; neither placeholder affects what is
 * currently graded.
 */

/**
 * Synthetic account state, not a real paper account's.
 *
 * There is no canonical/default paper account in this system -- every live account is created and
 * resolved by name, per bot spec. Coupling the shadow pipeline's P8 risk stage to one specific named
 * account would make its verdict depend on unrelated trading activity in that account. Since P13 does
 * not grade past the thesis stage (V1's own shadow comparison never touches risk either -- V1's
 * `evaluateRisk` runs only at real paper-trade open time), which account state feeds P8-P10 has no
 * effect on what is compared today. A fixed, generously-capitalised snapshot lets those stages run for
 * real and start accumulating ledger history without inventing a false account dependency.
 */
export function placeholderAccountSnapshot(): InstrumentRiskSnapshot<unknown> {
  const accountEquity = 1_000_000;
  return {
    accountEquity,
    peakEquity: accountEquity,
    openPositionCount: 0,
    realizedPnlToday: 0,
    volatilityRegime: null,
  };
}

/**
 * A measured transaction-cost summary statistic -- not a considered options-cost model, and not a
 * fresh guess either. Replaces the earlier flat `2` (borrowed from `canonical-friction.ts`'s
 * underlying-notional research ladder) with a number actually derived from real data, per
 * `docs/2026-09-29-brain-v22-cost-model.md`.
 *
 * ## Derivation
 *
 * `run-brain-v22-cost-adjusted-grading.ts` repriced all 118 of the 110 accumulated native-pipeline
 * approvals (2026-09-15 through 2026-09-21, 100% real-data coverage) as real ATM option-buyer fills:
 * `nearestStrike`/`mapIdeaToOptionBuyerFill` (the same functions `prepare-option-entry.ts` and
 * `run-atm-vs-itm-strike-backtest.ts` use) against real historical `option_premium_ticks`, with real
 * brokerage/STT/exchange/GST/stamp fees (`brokerage-calculator.ts`) and the real observed bid/ask
 * spread (entry at the ask, exit at the bid, matching V1's live convention). The mean one-way
 * round-trip cost (fees + spread) across all 118, expressed as basis points of **underlying**
 * notional -- the same basis `roundTripCostR` charges `costBps` against in `edge-assessor.ts` -- came
 * to approximately 0.32 bps.
 *
 * ## Why this number is smaller than the placeholder it replaces, and what that does NOT mean
 *
 * It does not mean options got cheaper to trade. The same repricing found the cost is a real ~30 bps
 * of *premium* turnover (fees alone; the spread adds more) -- a meaningful drag, consistent with this
 * project's other findings that spread is the dominant real options cost
 * (`premium-target-unreachable-at-index-target`). The bps-of-underlying-notional basis this constant
 * has to use, though, is `canonical-friction.ts`'s Track A -- built for an equity/index-proxy
 * *underlying* bracket, where cost naturally scales with the underlying's own notional. An option's
 * premium is a small, convex fraction of that notional, so any real per-trade options cost, when
 * forced into this unit, reads as a tiny number by construction, however large it actually is against
 * the premium the position is sized in. Restated: **this constant's unit is structurally unsuited to
 * representing option execution cost**, and a future cost-aware gate for options must be built on
 * Track B (premium-space cost, `d2-premium-cost-gate`'s territory) rather than trusting this slot to
 * mean what it means for `canonical-friction.ts`'s own underlying brackets.
 *
 * ## What changing this number does today: nothing
 *
 * `assessEdge` (P7) is the only consumer (`decision-pipeline.ts`; P8's `approveRisk` never received
 * `costBps` at all, correcting an earlier version of this comment that claimed otherwise). P7 is
 * uninhabited-refusal by design (I5) -- it always approves and only *records*
 * `costAdjustedBreakEvenHitRate` for later review. Nothing downstream reads that field to gate
 * anything yet, so this replacement changes zero pass/fail outcomes across the 110 decisions graded.
 * It matters only once a future gate is wired to read it -- and when that happens, whoever wires it
 * should read the derivation above before trusting this number to mean "options got safer."
 */
export const placeholderCostBps = 0.32;

export interface DecisionPipelineInputFacts {
  readonly decisionId: string;
  readonly instrumentSymbol: string;
  readonly instrumentTickSize: string;
  readonly instrumentLotSize: number;
  readonly latestClose: number;
  readonly latestCloseTime: Date;
  readonly evaluationAt: Date;
  /** The sealed MarketSnapshot's own instants -- unmodified, describing when it was built. */
  readonly snapshotInstants: Readonly<PitInstants>;
  readonly observedIn: SnapshotRef;
  readonly indicators: readonly {
    readonly code: string;
    readonly algorithmVersion: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly values: Readonly<Record<string, unknown>>;
  }[];
  readonly legacyPatterns: readonly LegacyCandlestickPattern[];
  readonly patternsComputed: boolean;
  readonly volatilityReading: { readonly vixClose: number; readonly vixSma20: number } | null;
  readonly institutionalFlow: { readonly fiiCashNetCr: number | null; readonly diiCashNetCr: number | null } | null;
  readonly optionChain: OptionChainSnapshot | null;
  readonly executionChain: OptionChainSnapshot | null;
}

/** The canonical ATR definition every live consumer keys on (`ai-autonomous-agent.ts`'s `PRODUCTION_INDICATOR_VERSION`, etc.). */
const ATR_ALGORITHM_VERSION = "ta-v1";
const ATR_PARAMETERS: Readonly<Record<string, unknown>> = { period: 14, smoothing: "WILDER" };

function extractAtrValue(indicators: DecisionPipelineInputFacts["indicators"]): number | null {
  const atr = indicators.find((indicator) => (
    indicator.code === "ATR"
    && indicator.algorithmVersion === ATR_ALGORITHM_VERSION
    && indicator.parameters.period === ATR_PARAMETERS.period
    && indicator.parameters.smoothing === ATR_PARAMETERS.smoothing
  ));
  const value = atr?.values.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildContext(facts: DecisionPipelineInputFacts): Readonly<BaseDecisionContext> {
  const decisionAt = facts.latestCloseTime;
  const contextInstants: PitInstants = {
    eventAt: facts.snapshotInstants.eventAt,
    knownAt: facts.snapshotInstants.knownAt,
    dataThrough: new Date(decisionAt.getTime() - 1),
    dataThroughConvention: facts.snapshotInstants.dataThroughConvention,
    earliestExecutionAt: facts.snapshotInstants.earliestExecutionAt,
    referenceAt: facts.snapshotInstants.referenceAt,
  };
  return sealDecisionContext({
    decisionId: facts.decisionId,
    decisionAt,
    evaluationAt: facts.evaluationAt,
    schedulerLagMs: facts.evaluationAt.getTime() - decisionAt.getTime(),
    instants: contextInstants,
    snapshotRef: facts.observedIn,
    policyVersions: {
      opportunityGrouping: opportunityGroupingPolicyVersion,
      stateInterpretation: stateInterpretationPolicyVersion,
      thesisBuilder: thesisBuilderPolicyVersion,
      thesisGeometry: thesisGeometryPolicyVersion,
      edgeAssessment: edgeAssessmentPolicyVersion,
      riskApproval: riskApprovalPolicyVersion,
      instrumentSelection: instrumentSelectionPolicyVersion,
      executionSimulation: executionSimulationPolicyVersion,
    },
  });
}

export function buildDecisionPipelineInput(facts: DecisionPipelineInputFacts): DecisionPipelineInput {
  return {
    decisionId: facts.decisionId,
    instrumentSymbol: facts.instrumentSymbol,
    context: buildContext(facts),
    patternObservations: legacyPatternObservations({
      patterns: facts.legacyPatterns,
      instants: facts.snapshotInstants,
      observedIn: facts.observedIn,
      patternsComputed: facts.patternsComputed,
    }),
    patternCoverage: facts.patternsComputed ? "LOADED" : "NOT_LOADED",
    volatilityReading: facts.volatilityReading,
    institutionalFlow: {
      fiiCashNetCr: facts.institutionalFlow?.fiiCashNetCr ?? null,
      diiCashNetCr: facts.institutionalFlow?.diiCashNetCr ?? null,
    },
    tickSize: Number(facts.instrumentTickSize),
    entryReference: facts.latestClose,
    atrValue: extractAtrValue(facts.indicators),
    costBps: placeholderCostBps,
    accountSnapshot: placeholderAccountSnapshot(),
    lotSize: facts.instrumentLotSize,
    optionChain: facts.optionChain,
    executionChain: facts.executionChain,
  };
}
