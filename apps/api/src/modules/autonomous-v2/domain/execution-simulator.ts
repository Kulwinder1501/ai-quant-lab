import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { quantityToLots } from "../../paper-trading/domain/lot-size-validator.js";
import { calculateEntryFees, type FeeBreakdown } from "../../paper-trading/domain/brokerage-calculator.js";
import type { DualSidedInstrumentSelection, SelectedContract } from "./instrument-policy.js";
import type { ThesisSide } from "./thesis-producer.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { approved, deferred, rejected, type EvaluationResult } from "./decision-outcome.js";

/**
 * P10: Execution Simulator -- fills the exact contract P9 already selected at the exact quantity P8
 * already sized. The last *live* decision stage: `decision-lifecycle.ts` makes `EXECUTED` terminal
 * (`PERMITTED_TRANSITIONS.EXECUTED = []`), because everything after execution belongs to the position
 * aggregate (I9). Readiness Plan Gap 3 is explicit this phase is "FULL PIPELINE SIMULATABLE (not paper
 * authority)": this stage produces a deterministic fill decision, not a `PaperTrade` write.
 *
 * ## Why this stage does not re-derive strike/IV or reprice into premium space
 *
 * `paper-trading/domain/option-buyer-fill.ts`'s `mapIdeaToOptionBuyerFill` is the natural-looking
 * reference, but it re-solves strike and IV (P9 already owns strike selection) and reprices stop/target
 * into premium space with a risk-reward-distortion refusal. That repricing is real, valuable work this
 * baseline does not attempt -- it needs a full Black-Scholes pass neither P8 nor P9 asked for.
 *
 * **What this baseline does instead:** P8's `PositionSize.quantity` was computed in underlying
 * index-point terms and floored to a lot multiple; this stage reinterprets that same unit count
 * directly as the number of option units to buy (`quantityToLots`, exact since P8 guarantees the
 * multiple). This is a **declared simplification, not a premium-preserving risk-reward mapping** --
 * true reconciliation (matching `option-buyer-fill.ts`'s repricing + distortion check) is future work.
 *
 * ## Why fill price is a fresh, caller-supplied execution-time quote, not P9's decision-time chain
 *
 * V1's `prepare-option-entry.ts` always fills at the observed ask, never a model or mid price, from a
 * chain fresher than the decision itself. This stage takes a second, later `OptionChainSnapshot` (an
 * `executionChain` sibling input, reusing P9's exact chain types) and looks up the ask for the precise
 * `{strikePrice, optionType, expiryDate}` P9 already selected -- never re-picking it (I8).
 *
 * ## Why a per-side quote gap is DEFERRED, not REJECTED
 *
 * Unlike every prior per-side refusal (a structural absence that will never resolve on retry), a
 * missing or stale ask for one specific contract at one specific instant is exactly the transient,
 * retriable gap the four-outcome discipline's `DEFERRED` exists for.
 */

export const executionSimulationPolicyVersion = "NATIVE_EXECUTION_SIMULATION_POLICY_V1";

export interface ExecutionFill {
  readonly side: ThesisSide;
  /** Carried from P9 unchanged -- this stage never re-picks the contract (I8). */
  readonly contract: SelectedContract;
  /** Carried from P8 unchanged, reinterpreted as option units -- see module docstring. */
  readonly quantity: number;
  readonly lots: number;
  /** The observed ask, never modeled. */
  readonly fillPremium: number;
  readonly fillSource: "OPTION_CHAIN_QUOTE";
  readonly entryFees: FeeBreakdown;
  readonly totalCost: number;
}

export type ExecutionRefusal =
  | "NO_APPROVED_INSTRUMENT_FOR_SIDE"
  | "NO_OBSERVED_QUOTE_FOR_SIDE";

export type SideExecutionResult = EvaluationResult<ExecutionFill, ExecutionRefusal>;

export interface DualSidedExecutionFill {
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly observedIn: SnapshotRef;
  readonly long: SideExecutionResult;
  readonly short: SideExecutionResult;
  readonly policyVersion: string;
}

/** Uninhabited: this stage never legitimately refuses at the stage level. See module docstring. */
export type ExecutionSimulatorRefusal = never;
export type ExecutionSimulatorResult = EvaluationResult<DualSidedExecutionFill, ExecutionSimulatorRefusal>;

export class ExecutionSimulatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionSimulatorError";
  }
}

/**
 * The P10 proof: kind: "EXECUTED", decision-lifecycle.ts's real terminal name, not the frozen
 * architecture doc's illustrative "EXECUTION_APPROVED" -- same precedent every prior stage except P8
 * applied.
 */
export interface Executed {
  readonly kind: "EXECUTED";
  readonly execution: DualSidedExecutionFill;
  readonly instrument: DualSidedInstrumentSelection;
  readonly context: Readonly<BaseDecisionContext>;
}

export interface ExecutionSimulationInput {
  readonly instrument: DualSidedInstrumentSelection;
  readonly context: Readonly<BaseDecisionContext>;
  /** A fresh, execution-time chain -- a later snapshot than P9's, same shape. Caller-supplied sibling. */
  readonly executionChain: OptionChainSnapshot | null;
}

function assessSide(side: ThesisSide, input: ExecutionSimulationInput): SideExecutionResult {
  const instrumentSide = side === "LONG" ? input.instrument.long : input.instrument.short;
  if (instrumentSide.outcome !== "APPROVED") {
    return rejected(["NO_APPROVED_INSTRUMENT_FOR_SIDE"]);
  }

  const { contract, positionSize } = instrumentSide.value;
  const quote = input.executionChain?.quotes.find(
    (candidate) =>
      candidate.strikePrice === contract.strikePrice
      && candidate.optionType === contract.optionType
      && candidate.expiryDate.getTime() === contract.expiryDate.getTime(),
  );

  if (quote === undefined || !Number.isFinite(quote.ask) || (quote.ask as number) <= 0) {
    return deferred({
      reason: "NO_OBSERVED_QUOTE_FOR_SIDE",
      blockingDependency: "a fresh executable ask for the selected contract",
      retryAt: null,
    });
  }

  const fillPremium = quote.ask as number;
  const quantity = positionSize.quantity;
  const lots = quantityToLots(quantity, positionSize.lotSize);
  const entryFees = calculateEntryFees(fillPremium, quantity);

  return approved(Object.freeze({
    side,
    contract,
    quantity,
    lots,
    fillPremium,
    fillSource: "OPTION_CHAIN_QUOTE",
    entryFees,
    totalCost: entryFees.turnover + entryFees.total,
  }));
}

/**
 * Fills both sides independently. Total by construction: the throw below is a caller/data defect,
 * never a business refusal -- this stage has no rule that refuses a well-formed instrument selection,
 * whatever its two sides individually resolved to.
 */
export function simulateExecution(input: ExecutionSimulationInput): ExecutionSimulatorResult {
  if (
    input.executionChain !== null
    && input.executionChain.underlyingSymbol !== input.instrument.instrumentSymbol
  ) {
    throw new ExecutionSimulatorError(
      `executionChain.underlyingSymbol (${input.executionChain.underlyingSymbol}) does not match `
      + `instrument.instrumentSymbol (${input.instrument.instrumentSymbol}).`,
    );
  }

  const long = assessSide("LONG", input);
  const short = assessSide("SHORT", input);

  return approved(Object.freeze({
    instrumentSymbol: input.instrument.instrumentSymbol,
    decisionAt: input.instrument.decisionAt,
    observedIn: input.instrument.observedIn,
    long,
    short,
    policyVersion: executionSimulationPolicyVersion,
  }));
}
