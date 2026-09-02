import {
  reconcileOutcome,
  theoreticalPnlFor,
  type InstrumentOutcome,
  type LayeredOutcome,
  type TradeDirection,
  type UnderlyingOutcome,
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
 * ## The underlying layer, and how it stopped being permanently null
 *
 * An audit found `paper_trades` recording `underlying_entry_price` and **no underlying exit**, so the
 * underlying layer was absent on every trade and `attributeShortfall` declined on all of them --
 * meaning the one question the three-layer split exists to answer, "was the thesis wrong or did the
 * fill erase a correct one?", was unanswerable for the whole book.
 *
 * Deriving the exit level from the underlying's candles was considered and rejected: mid-bar, that
 * bar's close is a future value relative to the exit instant, and a reconstruction standing beside
 * observed fills is exactly what produces confident attribution from an inference.
 *
 * Migration 089 supplies it properly instead. Production exits resolve from the option's own quoted
 * bid series, and `option_premium_ticks.underlying_value` was already populated on 100% of 606,244
 * ticks -- so the underlying level is read from **the same tick that crossed the barrier**, observed
 * at the exit instant rather than reconstructed around it.
 *
 * The layer is still null whenever the data does not support one: a close with no such sample, a
 * trade closed before 089, or a trade with no originating idea to read thesis levels from. Null keeps
 * meaning "not observed", and attribution still declines there.
 *
 * ## Partial exits were going to be excluded, and the data said not to
 *
 * The first version reported a partially exited trade as `NOT_COMPARABLE`, reasoning that
 * `(exit - entry) x quantity` cannot hold when `exit_price` is one slice's price and `realized_pnl`
 * covers all of them. Measured against the closed book, the exclusion would have discarded all but
 * one trade, so it is not applied and the residual is always computed. That is what turns this from a
 * filter into a detector: with the exclusion in place it would have reported nothing at all on real
 * data, while the residual finds the one trade whose P&L means something different from the rest.
 *
 * ## Why the identity holds, corrected
 *
 * An earlier version of this note said the identity survives because `exit_price` reconciles across
 * tranches. That was wrong, and migration 088's audit establishes the real reason: **every close to
 * date has been a single slice covering the full quantity**. Measured 2026-09-01, 338 of 339 closed
 * trades carry exactly one `paper_trade_partial_exits` row for the whole position; the remaining one
 * is `951a0ecb`, which carries none because it was closed by a hand-written `UPDATE`.
 *
 * So the identity holds trivially rather than by reconciliation, and a genuine multi-slice close has
 * never happened. When one does, `(exit_price - entry_price) x quantity` stops meaning anything for
 * that trade and this adapter will report a residual it cannot explain. That is the correct
 * behaviour -- it is a detector -- but the residual will be a data-shape change rather than a defect,
 * and the flag below is how a reader tells the two apart.
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
  readonly underlyingEntryPrice: number | null;
  /**
   * The underlying's observed level at the exit instant (migration 089), or null when none was.
   *
   * Null for every trade closed before that migration, and for closes resolved without a sample
   * pairing an option quote to an underlying level.
   */
  readonly underlyingExitPrice: number | null;
  /**
   * The underlying levels the trade was taken on, from the originating trade idea.
   *
   * Required to say whether the *thesis* resolved, which is a different question from whether the
   * option's barrier was hit -- and the question `attributeShortfall` reads. Null when the trade has
   * no idea to read them from, in which case the underlying layer stays absent rather than guessed.
   */
  readonly underlyingThesis: {
    readonly direction: TradeDirection;
    readonly stop: number;
    readonly target: number;
  } | null;
  /**
   * True when a `paper_trade_partial_exits` row exists -- which to date means one slice for the whole
   * position, not a position exited in pieces. It does not make the P&L identity inapplicable; see the
   * correction above. A *false* value is the interesting one, because every close the application
   * performs writes a slice.
   */
  readonly hasPartialExits: boolean;
}

export interface AdaptedOutcome {
  readonly outcome: Readonly<LayeredOutcome>;
  /** Recorded so a residual can be interpreted, not used to suppress one. */
  readonly hasPartialExits: boolean;
  /**
   * `erosion - fees`: what the recorded prices and the booked P&L disagree about, beyond fees.
   *
   * Zero is the expected state, and is what all but one closed trade produces (338 of 339 as of
   * 2026-09-01) -- `realized_pnl` is net of fees by convention, now recorded in migration 088, so
   * `(gross - net) - fees` cancels exactly.
   *
   * A non-zero residual means slippage nobody recorded, or a P&L that does not mean what the column
   * says. It is the class of fault that once reported +Rs 2,032 on a position down Rs 651, and on real
   * data it finds exactly one trade -- `951a0ecb`, whose residual is precisely its own fees because
   * its `realized_pnl` is gross.
   *
   * That trade is *not* evidence of a code path booking gross, and an earlier version of this note
   * left that open. Both writers of `status = 'CLOSED'` have shared one closing expression since
   * `fe84dc6`, and `951a0ecb` carries none of the five artifacts either path writes. It was a manual
   * `UPDATE` run at 19:18 IST, four hours after the close. See migration 088 and
   * `postgres-paper-trade-repository.pnl-convention.test.ts`, which fails if the two paths diverge.
   */
  readonly unexplainedResidual: number;
}

/**
 * The underlying layer, when the data supports one, and null when it does not.
 *
 * ## This is an endpoint classification, not a path one
 *
 * `resolution` is decided by where the underlying stood **at the exit instant**, because that is the
 * one underlying observation a closed trade carries. It cannot see a target that was touched and
 * given back, or a stop brushed intrabar and recovered from -- those are what
 * `favourableExcursion` / `adverseExcursion` exist to report, and they are left null here precisely
 * because the underlying's path is not read.
 *
 * The asymmetry to hold in mind when reading an attribution: an endpoint `INVALIDATED` is a strong
 * reading (the underlying finished through the stop), while `UNRESOLVED_AT_HORIZON` is weak -- it
 * means "not resolved *at the end*", not "never reached a barrier". `attributeShortfall` only blames
 * the underlying on `INVALIDATED`, so the weak case declines rather than misattributing, which is
 * the correct direction for the uncertainty to fall.
 *
 * `excursionTimeframe` must stay null alongside null excursions: `reconcileOutcome` refuses a
 * timeframe with no measurement behind it, which is what keeps this honest rather than decorative.
 */
function underlyingLayerFor(trade: LegacyClosedTrade): UnderlyingOutcome | null {
  const entry = trade.underlyingEntryPrice ?? null;
  const exit = trade.underlyingExitPrice ?? null;
  const thesis = trade.underlyingThesis ?? null;
  /*
   * `?? null` rather than `=== null`, because these arrive from database rows through a caller that
   * maps columns by hand. A missing property is the same fact as a null one -- "not observed" -- and
   * treating undefined as present would read `thesis.direction` off nothing.
   */
  if (entry === null || exit === null || thesis === null) return null;

  const reachedTarget = thesis.direction === "LONG" ? exit >= thesis.target : exit <= thesis.target;
  const throughStop = thesis.direction === "LONG" ? exit <= thesis.stop : exit >= thesis.stop;
  /*
   * Target is checked first, and only one can be true for coherent geometry: a LONG thesis has
   * stop < target, so `exit >= target` and `exit <= stop` cannot both hold. Ordering it this way
   * means malformed geometry reports the favourable reading rather than throwing inside an outcome
   * adapter, and `reconcileOutcome` is where structural refusals belong.
   */
  const resolution = reachedTarget
    ? "TARGET_REACHED"
    : throughStop ? "INVALIDATED" : "UNRESOLVED_AT_HORIZON";

  return {
    resolution,
    entryReference: entry,
    exitReference: exit,
    // The underlying's path between entry and exit is not read here. Null, never zero: zero would
    // claim the position never moved against the thesis, which is the claim most likely to make a
    // bad stop look safe.
    favourableExcursion: null,
    adverseExcursion: null,
    excursionTimeframe: null,
  };
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
    underlying: underlyingLayerFor(trade),
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
