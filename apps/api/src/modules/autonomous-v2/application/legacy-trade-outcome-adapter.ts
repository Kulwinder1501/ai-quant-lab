import {
  reconcileOutcome,
  theoreticalPnlFor,
  type InstrumentOutcome,
  type LayeredOutcome,
  type TradeDirection,
} from "../domain/outcome-layers.js";

/**
 * The Execution/Outcome adapter §6 prescribes: a legacy closed trade translated into the V2.2
 * three-layer outcome.
 *
 * ## Why it lives here and takes a structural input
 *
 * §6's migration ladder names this adapter explicitly, and states the rule every adapter follows: "An
 * adapter translates legacy information into a V2.2 contract. It must not reproduce V1 decision logic
 * inside V2.2."
 *
 * So it takes a plain shape rather than importing `paper-trading` types. `autonomous-v2` staying free of
 * V1 imports is what the quarantine guard enforces, and an adapter that reached into V1 to be
 * convenient would be the first crack in it. The caller -- an interface, which may see both -- builds the
 * input from rows.
 *
 * ## The underlying layer is null, and that is a data fact rather than a shortcut
 *
 * Found by audit: `paper_trades` records `underlying_entry_price` and **no underlying exit**, and the
 * holding-period candles a review reads belong to the option contract rather than the underlying. So
 * there is no observed underlying exit for a closed option trade, and no underlying path either.
 *
 * Deriving one from the underlying's candles at the exit instant was considered and rejected: it would
 * be a reconstruction presented alongside observed fills, and `attributeShortfall` reads `resolution`
 * to decide whether the *thesis* was wrong. A reconstructed level would produce confident attribution
 * from an inference. Recording `underlying_exit_price` at close is the fix; until then this layer is
 * honestly absent and attribution declines.
 *
 * ## Partial exits were going to be excluded, and the data said not to
 *
 * The first version reported a partially exited trade as `NOT_COMPARABLE`, reasoning that
 * `(exit - entry) x quantity` cannot hold when `exit_price` is one tranche's price and `realized_pnl`
 * covers all of them. Measured against the 322 closed trades, that reasoning was wrong here and the
 * exclusion would have discarded **321 of them**: the identity holds for every partially exited trade,
 * because `exit_price` reconciles across tranches.
 *
 * So partial exits are *recorded* rather than excluded, and the residual is always computed. That is
 * what turns this from a filter into a detector -- with the exclusion in place it would have reported
 * nothing at all on real data, while the residual finds the one trade whose P&L means something
 * different from the other 321.
 *
 * `hasPartialExits` still travels on the result, because a large residual on a partially exited trade
 * has a benign explanation available that a full-exit trade does not, and a reader needs to know which
 * they are looking at.
 */

export interface LegacyClosedTrade {
  readonly tradeId: string;
  readonly contractSymbol: string;
  readonly side: TradeDirection;
  readonly quantity: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly realisedPnl: number;
  readonly fees: number | null;
  /** Recorded on the trade, but with no exit counterpart. Carried for provenance only. */
  readonly underlyingEntryPrice: number | null;
  /** True when the position was closed in tranches, which makes the simple P&L identity inapplicable. */
  readonly hasPartialExits: boolean;
}

export interface AdaptedOutcome {
  readonly outcome: Readonly<LayeredOutcome>;
  /** Recorded so a residual can be interpreted, not used to suppress one. */
  readonly hasPartialExits: boolean;
  /**
   * `erosion - fees`: what the recorded prices and the booked P&L disagree about, beyond fees.
   *
   * Zero is the expected state, and is what 321 of 322 real closed trades produce -- their
   * `realized_pnl` is net of fees, so `(gross - net) - fees` cancels exactly.
   *
   * A non-zero residual means slippage nobody recorded, or a P&L that does not mean what the column
   * says. It is the class of fault that once reported +Rs 2,032 on a position down Rs 651, and on real
   * data it currently finds exactly one trade -- whose residual is precisely its fees, because that
   * trade booked P&L gross while every other booked it net.
   */
  readonly unexplainedResidual: number;
}

export function layeredOutcomeFromClosedTrade(trade: LegacyClosedTrade): AdaptedOutcome {
  const instrument: InstrumentOutcome = {
    contractSymbol: trade.contractSymbol,
    entryPrice: trade.entryPrice,
    exitPrice: trade.exitPrice,
    quantity: trade.quantity,
    direction: trade.side,
    /*
     * A closed paper trade prices from the observed book. That is not an assumption: the mark-pricing
     * defect was fixed on 2026-08-05 and both legs now price from the observed book, and
     * `reconcileOutcome` refuses `MODEL_MARK` on a closed outcome -- so if that ever regresses, this
     * adapter throws rather than quietly reporting a modelled number as a fill.
     */
    priceSource: "OBSERVED_BOOK",
    // Requires an underlying move to divide by, and there is no underlying exit to compute one from.
    captureRatio: null,
  };

  const theoreticalPnl = theoreticalPnlFor(instrument);
  const outcome = reconcileOutcome({
    decisionId: trade.tradeId,
    closed: true,
    underlying: null,
    instrument,
    execution: {
      theoreticalPnl,
      realisedPnl: trade.realisedPnl,
      erosion: theoreticalPnl - trade.realisedPnl,
      fees: trade.fees,
      // Not recorded per-leg on a paper trade; null rather than 0, which would claim a measurement.
      entrySlippage: null,
      exitSlippage: null,
    },
  });

  return {
    outcome,
    hasPartialExits: trade.hasPartialExits,
    unexplainedResidual: outcome.execution.erosion - (trade.fees ?? 0),
  };
}
