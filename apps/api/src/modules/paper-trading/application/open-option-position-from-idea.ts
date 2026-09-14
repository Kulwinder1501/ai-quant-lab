import { evaluateRisk } from "../../risk-management/domain/risk.js";
import type { PaperTrade } from "../domain/paper-trading.js";
import { PrepareOptionEntry, type PrepareOptionEntryResult } from "./prepare-option-entry.js";
import type { OpenPaperTrade } from "./open-paper-trade.js";
import { isAtOrAfterSessionEntryCutoff } from "../domain/session-close.js";

/**
 * Turns a stored trade idea into an option position, through every gate, for any caller.
 *
 * `prepare-option-entry.ts` opens by warning that "the moment the bot opens positions there are
 * two callers, and the cost of the copy is not duplication -- it is that the copy is where the
 * gates get left out". That is exactly what happened. The second caller, `AiAutonomousAgent`,
 * never went through `PrepareOptionEntry` at all: it called `openFromTradeIdea` directly with
 * `fillPrice: livePrice`, so it booked a cash-style position **at the index level**.
 *
 * Three things were wrong with that, and only the third is cosmetic:
 *
 * 1. NIFTY50 spot is not tradable. The agent's positions were 75 units of an index at ~24,590 --
 *    an instrument that cannot be bought, priced at a level no broker fills. Every P&L it
 *    reported was against a contract that does not exist, which is the same class of error as
 *    the phantom BANKNIFTY weekly expiry that once overstated returns by 214%.
 * 2. It bypassed the risk engine. The bot evaluates `evaluateRisk` against concurrent-position,
 *    daily-loss and drawdown limits before every entry; the agent evaluated none of them, so
 *    the one component that trades unattended was also the one with no portfolio-level brake.
 * 3. Its costs could not be modelled honestly. `brokerage-calculator.ts` prices option premium
 *    turnover, so an index notional had to be charged with invented constants -- see the fee
 *    literals this change deletes.
 *
 * Routing through here fixes all three at once, because the gates are the shared path rather
 * than something each caller remembers. A refusal is returned rather than thrown, and it carries
 * the reason: callers report refusals, and "refused" must never be indistinguishable from
 * "nothing to do".
 *
 * `run-paper-trading-bot.ts` still carries its own inlined copy of this sequence, interleaved
 * with the per-idea reporting its output contract promises. It should adopt this service, and
 * until it does the two must be changed together -- which is the situation this module exists to
 * end, so that adoption is the next step rather than an optional cleanup.
 */

export interface RiskStateReader {
  findRiskState(input: {
    accountId: string;
    instrumentId: string;
    asOf: Date;
    maxRegimeAgeMinutes?: number;
  }): Promise<Parameters<typeof evaluateRisk>[1]>;
}

export interface OpenOptionPositionInput {
  accountId: string;
  instrumentId: string;
  tradeIdeaId: string;
  /** Base lot count. The risk engine may reduce it; it can never silently raise it. */
  lots?: number;
  now: Date;
  notes: string;
  /** How stale a regime snapshot may be before the risk state refuses to rely on it. */
  maxRegimeAgeMinutes?: number;
}

export type OpenOptionPositionResult =
  | {
    opened: true;
    trade: PaperTrade;
    contract: {
      underlyingSymbol: string;
      optionStrike: number;
      optionExpiry: Date;
      optionType: "CE" | "PE";
    };
    /** The premium actually filled at, not the underlying's level. */
    fillPremium: number;
    stopPremium: number;
    targetPremium: number;
    quantity: number;
    entryFees: number;
    /** Gates that could not be evaluated. Surfaced, never swallowed. */
    unchecked: string[];
  }
  | {
    opened: false;
    /** Machine-readable. `RISK_CONTROL_VETO` is this service's; the rest come from the entry gate. */
    reason: Extract<PrepareOptionEntryResult, { approved: false }>["reason"]
      | "RISK_CONTROL_VETO"
      | "SESSION_ENTRY_CUTOFF";
    explanation: string;
    reasons?: string[];
    unchecked?: string[];
  };

export class OpenOptionPositionFromIdea {
  constructor(
    private readonly prepareEntry: PrepareOptionEntry,
    private readonly openTrade: OpenPaperTrade,
    private readonly riskStates: RiskStateReader,
  ) {}

  async execute(input: OpenOptionPositionInput): Promise<OpenOptionPositionResult> {
    // Refused before the entry gate, which calls the provider: there is no point pricing a
    // contract for a position that must be squared off on the next sweep. This is the opening
    // half of the session-boundary policy whose closing half lives in the exit evaluator.
    if (isAtOrAfterSessionEntryCutoff(input.now)) {
      return {
        opened: false,
        reason: "SESSION_ENTRY_CUTOFF",
        explanation: "New entries are closed for the session: the square-off cutoff has passed.",
      };
    }

    // The entry gate picks the contract from the provider's listed calendar and fills at the
    // observed ask. It is what stops a derived expiry, a model-priced premium, or a skipped
    // pre-trade checklist -- each of which has already cost this project a wrong number once.
    const prepared = await this.prepareEntry.execute({
      tradeIdeaId: input.tradeIdeaId,
      lots: input.lots ?? 1,
      now: input.now,
    });
    if (!prepared.approved) {
      return {
        opened: false,
        reason: prepared.reason,
        explanation: prepared.explanation,
        ...(prepared.reasons ? { reasons: prepared.reasons } : {}),
        ...(prepared.unchecked ? { unchecked: prepared.unchecked } : {}),
      };
    }

    const entry = prepared.entry;
    const riskState = await this.riskStates.findRiskState({
      accountId: input.accountId,
      instrumentId: input.instrumentId,
      asOf: input.now,
      maxRegimeAgeMinutes: input.maxRegimeAgeMinutes ?? 60,
    });
    // Evaluated in **premium** space, which is the space the position actually lives in. The
    // bracket the risk engine sees has to be the one the trade will be exited on.
    const riskDecision = evaluateRisk({
      instrumentId: input.instrumentId,
      decisionTimestamp: input.now,
      side: entry.side,
      entryPrice: entry.fillPrice,
      stopLoss: entry.stopLossOverride,
      targetPrice: entry.targetPriceOverride,
      lotSize: entry.lotSize,
    }, riskState);
    if (!riskDecision.approved) {
      return {
        opened: false,
        reason: "RISK_CONTROL_VETO",
        explanation: `Risk engine refused the entry: ${riskDecision.reasonCodes.join(", ")}.`,
        reasons: riskDecision.reasonCodes,
      };
    }

    // The engine may size down, never up: an unattended strategy does not get to grow its own
    // position because a limit happened to be generous.
    const quantity = Math.min(entry.quantity, riskDecision.approvedQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return {
        opened: false,
        reason: "RISK_CONTROL_VETO",
        explanation: `Risk engine approved a non-tradable quantity (${quantity}).`,
        reasons: riskDecision.reasonCodes,
      };
    }

    const riskNote = riskDecision.reasonCodes.length > 0
      ? ` Risk checks: ${riskDecision.reasonCodes.join(", ")}.`
      : "";
    const trade = await this.openTrade.execute({
      accountId: input.accountId,
      tradeIdeaId: input.tradeIdeaId,
      fillPrice: entry.fillPrice,
      quantity,
      openedAt: input.now,
      entryFees: entry.entryFees,
      // Zero, and deliberately: the fill is already the observed **ask**, so the spread has been
      // paid. Adding a slippage estimate on top would charge for crossing it twice.
      entrySlippage: 0,
      notes: `${input.notes}${riskNote}`,
      orderType: "MARKET",
      stopLossOverride: entry.stopLossOverride,
      targetPriceOverride: entry.targetPriceOverride,
      sideOverride: entry.side,
      feeBreakdown: entry.feeBreakdown,
      // The entry gate already computed fees from the observed premium; recomputing here would
      // charge a second, differently-derived set.
      applyBrokerageFees: false,
      optionContract: entry.optionContract,
    });

    return {
      opened: true,
      trade,
      contract: {
        underlyingSymbol: entry.optionContract.underlyingSymbol,
        optionStrike: entry.optionContract.optionStrike,
        optionExpiry: entry.optionContract.optionExpiry,
        optionType: entry.optionContract.optionType,
      },
      fillPremium: entry.fillPrice,
      stopPremium: entry.stopLossOverride,
      targetPremium: entry.targetPriceOverride,
      quantity,
      entryFees: entry.entryFees,
      unchecked: entry.unchecked,
    };
  }
}
