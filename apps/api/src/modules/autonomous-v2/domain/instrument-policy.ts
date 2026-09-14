import { yearsToExpiry } from "@ai-quant-lab/pricing";
import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import {
  atmStrikeOf,
  expiriesOf,
  moneynessOf,
  quoteSpread,
  type ExpiryKind,
  type Moneyness,
  type OptionChainSnapshot,
  type OptionType,
} from "../../market-data/domain/option-chain.js";
import { assessContractSize } from "../../paper-trading/domain/contract-specs.js";
import type { DualSidedRiskApproval, PositionSize } from "./risk-approver.js";
import type { ThesisSide } from "./thesis-producer.js";
import type { BaseDecisionContext } from "./decision-context.js";
import { approved, deferred, rejected, type EvaluationResult } from "./decision-outcome.js";

/**
 * P9: Instrument Policy -- selects and validates the option contract that expresses each side of a
 * risk-approved thesis. Per the frozen architecture's extraction table, V1's `OpenOptionPositionFromIdea`
 * splits `OptionPolicy` (strike selection) and `InstrumentEligibility` (contract sanity check) apart;
 * the readiness plan folds them into this one stage, the same way P8 folded `RiskEngine`+`PositionSizer`.
 *
 * ## I19: this stage never reads thesis confidence
 *
 * `strategy-engine/domain/options-entry-validator.ts`'s `validateOptionsEntry` gates the option leg
 * directly on `proposedIdea.confidence` in three places (a floor, a 0-DTE exception, reasoning-string
 * sniffing) -- exactly the underlying/option coupling I19 forbids. This module re-derives the
 * legitimate contract-sanity rules (spread, open-interest-decreasing, minimum days-to-expiry) with no
 * confidence input anywhere in its signature.
 *
 * ## Why this stage does not re-size (I7)
 *
 * V1's real wiring (`paper-trading/application/open-option-position-from-idea.ts`) sizes risk in
 * *premium* space, after the contract is already picked. Brain V2.2's fixed pipeline is the opposite:
 * `decision-lifecycle.ts` requires `RISK_APPROVED -> INSTRUMENT_SELECTED`, and P8 already sized every
 * side from the thesis's own *underlying*-priced geometry. So this stage selects a contract and carries
 * P8's `PositionSize` forward unchanged -- reconciling underlying-point risk with a premium-based order
 * quantity is P10 (Execution Simulator)'s job, not this one's.
 *
 * ## Why no premium/bid/ask is carried in the output
 *
 * A value that depends on a later price belongs at that later moment, not baked into this decision --
 * the same principle V1's own `intendedContractDelta` comment states. `PaperExecutor` (P10) fills at
 * the live ask when it actually executes; carrying today's premium into `INSTRUMENT_SELECTED` would let
 * a stale price leak into execution.
 *
 * ## What is deliberately deferred, not omitted
 *
 * IV-percentile ceiling and delta-based OTM screening are real parts of V1's `validateOptionsEntry`,
 * but neither has a quarantine-clean, confidence-decoupled input threaded anywhere in V2.2 yet. Chain
 * freshness against the sealed `PitInstants` is also not checked here. Both are future work, not a
 * silent gap -- the same posture P8 took leaving volatility-adjusted sizing undone.
 */

export const instrumentSelectionPolicyVersion = "NATIVE_INSTRUMENT_SELECTION_POLICY_V1";

// Native starting values, independently owned -- not imported from options-entry-validator.ts.
const maxSpreadPercentOfMid = 3.0;
const minimumDaysToExpiry = 1;

export interface SelectedContract {
  readonly strikePrice: number;
  readonly optionType: OptionType;
  readonly expiryDate: Date;
  readonly expiryKind: ExpiryKind;
  readonly moneyness: Moneyness;
  /** The measured cost that justified eligibility, carried for audit. */
  readonly spreadPercentOfMid: number;
}

export interface SideInstrumentSelection {
  readonly side: ThesisSide;
  readonly contract: SelectedContract;
  /** Carried forward from P8 unchanged -- this stage selects a contract, it does not re-size (I7). */
  readonly positionSize: PositionSize;
}

export type InstrumentRefusal =
  | "NO_APPROVED_RISK_FOR_SIDE"
  | "NO_ELIGIBLE_STRIKE"
  | "NO_ELIGIBLE_EXPIRY"
  | "SPREAD_TOO_WIDE"
  | "OPEN_INTEREST_DECREASING"
  | "CONTRACT_SIZE_IMPLAUSIBLE";

export type SideInstrumentResult = EvaluationResult<SideInstrumentSelection, InstrumentRefusal>;

export interface DualSidedInstrumentSelection {
  readonly instrumentSymbol: string;
  readonly decisionAt: Date;
  readonly observedIn: SnapshotRef;
  readonly long: SideInstrumentResult;
  readonly short: SideInstrumentResult;
  readonly policyVersion: string;
}

/**
 * Stage-level: DEFERRED when no usable option chain exists for this bar. Unlike P7/P8's
 * always-complete caller-supplied facts, a chain snapshot is a genuinely intermittent dependency --
 * the same posture P6b took for `ATR_NOT_AVAILABLE_FOR_BAR`.
 */
export type InstrumentPolicyRefusal = "OPTION_CHAIN_NOT_AVAILABLE";
export type InstrumentPolicyResult = EvaluationResult<DualSidedInstrumentSelection, InstrumentPolicyRefusal>;

export class InstrumentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstrumentPolicyError";
  }
}

/**
 * The P9 proof: kind: "INSTRUMENT_SELECTED", matching decision-lifecycle.ts's wired vocabulary, not
 * the frozen architecture doc's illustrative "INSTRUMENT_APPROVED" -- same precedent every prior stage
 * except P8 applied.
 */
export interface InstrumentSelected {
  readonly kind: "INSTRUMENT_SELECTED";
  readonly instrument: DualSidedInstrumentSelection;
  readonly risk: DualSidedRiskApproval;
  readonly context: Readonly<BaseDecisionContext>;
}

export interface InstrumentPolicyInput {
  readonly risk: DualSidedRiskApproval;
  readonly context: Readonly<BaseDecisionContext>;
  /** Caller-supplied sibling input; null/empty/no-spot -> stage DEFERRED. */
  readonly optionChain: OptionChainSnapshot | null;
}

function assessSide(
  side: ThesisSide,
  input: InstrumentPolicyInput,
  chain: OptionChainSnapshot,
  underlyingValue: number,
): SideInstrumentResult {
  const riskSide = side === "LONG" ? input.risk.long : input.risk.short;
  if (riskSide.outcome !== "APPROVED") {
    return rejected(["NO_APPROVED_RISK_FOR_SIDE"]);
  }

  const optionType: OptionType = side === "LONG" ? "CE" : "PE";

  const atmStrike = atmStrikeOf(chain.quotes, underlyingValue);
  if (atmStrike === null) {
    return rejected(["NO_ELIGIBLE_STRIKE"]);
  }

  const eligibleExpiry = expiriesOf(chain).find(
    (expiry) => yearsToExpiry(chain.observedAt, expiry.expiryDate) * 365 >= minimumDaysToExpiry,
  );
  if (eligibleExpiry === undefined) {
    return rejected(["NO_ELIGIBLE_EXPIRY"]);
  }

  const quote = chain.quotes.find(
    (candidate) =>
      candidate.strikePrice === atmStrike
      && candidate.optionType === optionType
      && candidate.expiryDate.getTime() === eligibleExpiry.expiryDate.getTime(),
  );
  if (quote === undefined) {
    return rejected(["NO_ELIGIBLE_STRIKE"]);
  }

  const spread = quoteSpread(quote);
  if (spread === null || spread.percentOfMid > maxSpreadPercentOfMid) {
    return rejected(["SPREAD_TOO_WIDE"]);
  }

  if (quote.openInterestChange !== null && quote.openInterestChange < 0) {
    return rejected(["OPEN_INTEREST_DECREASING"]);
  }

  const positionSize = riskSide.value.positionSize;
  const sizeAssessment = assessContractSize(positionSize.lotSize, underlyingValue);
  if (sizeAssessment.verdict !== "PLAUSIBLE") {
    return rejected(["CONTRACT_SIZE_IMPLAUSIBLE"]);
  }

  return approved(Object.freeze({
    side,
    contract: Object.freeze({
      strikePrice: atmStrike,
      optionType,
      expiryDate: eligibleExpiry.expiryDate,
      expiryKind: eligibleExpiry.expiryKind,
      moneyness: moneynessOf(quote, underlyingValue, atmStrike),
      spreadPercentOfMid: spread.percentOfMid,
    }),
    positionSize,
  }));
}

/**
 * Selects and validates both sides' contracts independently. Total by construction: the throw below is
 * a caller/data defect, never a business refusal.
 */
export function selectInstrument(input: InstrumentPolicyInput): InstrumentPolicyResult {
  const chain = input.optionChain;
  if (chain !== null && chain.underlyingSymbol !== input.risk.instrumentSymbol) {
    throw new InstrumentPolicyError(
      `optionChain.underlyingSymbol (${chain.underlyingSymbol}) does not match `
      + `risk.instrumentSymbol (${input.risk.instrumentSymbol}).`,
    );
  }

  if (chain === null || chain.quotes.length === 0 || chain.underlyingValue === null) {
    return deferred({
      reason: "OPTION_CHAIN_NOT_AVAILABLE",
      blockingDependency: "option chain snapshot with a spot value",
      retryAt: null,
    });
  }

  const underlyingValue = chain.underlyingValue;
  const long = assessSide("LONG", input, chain, underlyingValue);
  const short = assessSide("SHORT", input, chain, underlyingValue);

  return approved(Object.freeze({
    instrumentSymbol: input.risk.instrumentSymbol,
    decisionAt: input.risk.decisionAt,
    observedIn: input.risk.observedIn,
    long,
    short,
    policyVersion: instrumentSelectionPolicyVersion,
  }));
}
