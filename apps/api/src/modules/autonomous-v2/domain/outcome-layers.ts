/**
 * The three-layer outcome split (Brain V2.2 §6), and the reconciliation that makes it load-bearing.
 *
 * ## Why three measurements and not one P&L
 *
 * A single realised number cannot tell these apart, and this system has paid for the confusion three
 * times:
 *
 * | Layer | Asks | The failure it isolates |
 * | :--- | :--- | :--- |
 * | Underlying | did the asset reach the target before invalidation? | the pattern or thesis was wrong |
 * | Instrument | did the chosen option capture that move? | the strike or expiry was wrong |
 * | Execution | did fills, spreads and slippage erode the capture? | the fill path was wrong |
 *
 * Measured examples, all of which read as "the strategy lost money" without the split: a model mark
 * reported **+Rs 2,032 on a position that was down Rs 651**; a dense-tick lookup that discarded future
 * rows booked a **target as a stop-loss** three times; and 215 ungradeable verdicts moved a headline
 * accuracy from 91.7% to 69.6% once cleared. The first two are execution-layer faults that would have
 * been attributed to the thesis.
 *
 * ## The reconciliation is the point, not the three structs
 *
 * Splitting a number into three fields achieves nothing on its own -- someone fills them in from
 * different sources and they quietly disagree. `reconcileOutcome` refuses a set of layers that do not
 * add up:
 *
 *     theoreticalPnl  must equal  (exit - entry) x quantity x direction, from the RECORDED prices
 *     erosion         must equal  theoreticalPnl - realisedPnl
 *
 * The first is what catches the mark-pricing defect. The +Rs 2,032 came from a *model mark* while the
 * book was down Rs 651; recomputing the theoretical figure from the recorded instrument prices makes
 * the two irreconcilable instead of letting the friendlier number be reported.
 *
 * ## `priceSource` exists because that defect had a specific cause
 *
 * A closed outcome must be priced from the observed book. A model mark is legitimate for an *open*
 * position -- there may be no trade to observe -- and illegitimate for a settled one, where the fill
 * is a fact. `reconcileOutcome` refuses `MODEL_MARK` on a closed outcome rather than trusting the
 * caller to remember which it had.
 *
 * ## Excursions are an upper bound, and unmeasured is not zero
 *
 * Carried from `buildTradeReview`, whose numbers seed this: excursions are read from candle extremes,
 * so the intrabar path is unknown and a single candle containing both entry and exit reports its full
 * range. `excursionTimeframe` travels with them so a 1m-derived bound is distinguishable from a
 * 1d-derived one -- a 1d excursion is nearly uninformative and must not be compared against a 1m one.
 *
 * `null` means not measured. It must never be defaulted to 0, because 0 is a strong claim -- "the
 * position never moved against us" -- and it is the claim most likely to make a bad stop look safe.
 */

export type UnderlyingResolution = "TARGET_REACHED" | "INVALIDATED" | "UNRESOLVED_AT_HORIZON";
export type OutcomePriceSource = "OBSERVED_BOOK" | "MODEL_MARK";
export type TradeDirection = "LONG" | "SHORT";

export interface UnderlyingOutcome {
  readonly resolution: UnderlyingResolution;
  /** The underlying's level at the decision, and at the exit. */
  readonly entryReference: number;
  readonly exitReference: number;
  /** Upper bounds from candle extremes. Null means not measured, never zero. */
  readonly favourableExcursion: number | null;
  readonly adverseExcursion: number | null;
  /** Which timeframe the bounds were read at. Null exactly when both excursions are null. */
  readonly excursionTimeframe: string | null;
}

export interface InstrumentOutcome {
  readonly contractSymbol: string;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly quantity: number;
  readonly direction: TradeDirection;
  readonly priceSource: OutcomePriceSource;
  /**
   * How much of the underlying move the instrument captured, or null when the ratio is undefined.
   *
   * Null when the underlying did not move: the ratio's denominator is zero, and reporting 0 would say
   * "the instrument captured nothing" when the truth is "there was nothing to capture".
   */
  readonly captureRatio: number | null;
}

export interface ExecutionOutcome {
  /** P&L implied by the recorded instrument prices. Recomputed, never supplied. */
  readonly theoreticalPnl: number;
  /** What the book actually did. */
  readonly realisedPnl: number;
  /** `theoreticalPnl - realisedPnl`. Signed: favourable slippage is negative erosion. */
  readonly erosion: number;
  readonly fees: number | null;
  readonly entrySlippage: number | null;
  readonly exitSlippage: number | null;
}

export interface LayeredOutcome {
  readonly decisionId: string;
  readonly closed: boolean;
  /**
   * Null when the underlying layer was not measured.
   *
   * Added after the adoption audit contradicted the first design, which required entry and exit
   * references. `paper_trades` records `underlying_entry_price` and **no underlying exit**, and the
   * holding-period candles a review reads belong to the option contract rather than the underlying --
   * so for an option trade there is no observed underlying exit to record.
   *
   * Fabricating one to satisfy the type would be precisely the invented number this module exists to
   * refuse, and it would be the most damaging kind: `attributeShortfall` reads `resolution` to decide
   * whether the thesis was wrong, so a guessed level would produce confident attribution from nothing.
   * Null instead, and `attributeShortfall` declines to attribute -- which is the honest answer while the
   * data is missing.
   */
  readonly underlying: UnderlyingOutcome | null;
  readonly instrument: InstrumentOutcome;
  readonly execution: ExecutionOutcome;
}

export class OutcomeReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeReconciliationError";
  }
}

/** Currency comparisons need a tolerance; prices carry six decimals elsewhere in this system. */
const CURRENCY_EPSILON = 1e-6;

function assertFinite(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new OutcomeReconciliationError(`${field} must be a finite number.`);
}

/** P&L implied by the recorded instrument prices, which is the only figure allowed to be theoretical. */
export function theoreticalPnlFor(instrument: InstrumentOutcome): number {
  const perUnit = instrument.direction === "LONG"
    ? instrument.exitPrice - instrument.entryPrice
    : instrument.entryPrice - instrument.exitPrice;
  return perUnit * instrument.quantity;
}

/**
 * Validates that the three layers describe one event.
 *
 * Every check here corresponds to a way the layers have actually been observed to disagree, or could
 * disagree without anyone noticing.
 */
export function reconcileOutcome(outcome: LayeredOutcome): Readonly<LayeredOutcome> {
  const { underlying, instrument, execution } = outcome;

  if (outcome.decisionId.trim().length === 0) {
    throw new OutcomeReconciliationError("An outcome must name the decision it measures.");
  }
  for (const [field, value] of [
    ...(underlying === null ? [] : [
      ["underlying.entryReference", underlying.entryReference] as const,
      ["underlying.exitReference", underlying.exitReference] as const,
    ]),
    ["instrument.entryPrice", instrument.entryPrice],
    ["instrument.exitPrice", instrument.exitPrice],
    ["execution.realisedPnl", execution.realisedPnl],
  ] as const) {
    assertFinite(value, field);
  }
  if (!Number.isFinite(instrument.quantity) || instrument.quantity <= 0) {
    throw new OutcomeReconciliationError("instrument.quantity must be positive; an outcome measures a position that existed.");
  }

  if (outcome.closed && instrument.priceSource === "MODEL_MARK") {
    /*
     * The mark-pricing defect, refused structurally. A model mark is legitimate for an open position --
     * there may be no trade to observe -- and never for a settled one, where the fill is a fact. That
     * substitution reported +Rs 2,032 on a position down Rs 651.
     */
    throw new OutcomeReconciliationError(
      "A closed outcome must be priced from the observed book, not a model mark: the fill is a fact by "
      + "then, and substituting a mark is how +Rs 2,032 was once reported on a position down Rs 651.",
    );
  }

  const expectedTheoretical = theoreticalPnlFor(instrument);
  if (Math.abs(execution.theoreticalPnl - expectedTheoretical) > CURRENCY_EPSILON) {
    throw new OutcomeReconciliationError(
      `execution.theoreticalPnl is ${execution.theoreticalPnl} but the recorded instrument prices imply `
      + `${expectedTheoretical}. The layers are describing different trades, which is exactly what a `
      + "single realised number cannot reveal.",
    );
  }
  const expectedErosion = execution.theoreticalPnl - execution.realisedPnl;
  if (Math.abs(execution.erosion - expectedErosion) > CURRENCY_EPSILON) {
    throw new OutcomeReconciliationError(
      `execution.erosion is ${execution.erosion} but theoreticalPnl - realisedPnl is ${expectedErosion}.`,
    );
  }

  if (underlying === null) {
    return Object.freeze({
      ...outcome,
      underlying: null,
      instrument: Object.freeze({ ...instrument }),
      execution: Object.freeze({ ...execution }),
    });
  }

  for (const [field, value] of [
    ["favourableExcursion", underlying.favourableExcursion],
    ["adverseExcursion", underlying.adverseExcursion],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      // Excursions are magnitudes; a negative one means the sign convention was applied twice.
      throw new OutcomeReconciliationError(`underlying.${field} must be a non-negative magnitude or null.`);
    }
  }
  const measured = underlying.favourableExcursion !== null || underlying.adverseExcursion !== null;
  if (measured && underlying.excursionTimeframe === null) {
    /*
     * A bound without its timeframe is not interpretable. A 1d-derived excursion is nearly
     * uninformative and must not be compared against a 1m-derived one, and without the timeframe
     * nobody can tell which they are holding.
     */
    throw new OutcomeReconciliationError(
      "Measured excursions must record the timeframe they were read at: they are upper bounds from "
      + "candle extremes, and their precision is the timeframe.",
    );
  }
  if (!measured && underlying.excursionTimeframe !== null) {
    throw new OutcomeReconciliationError(
      "excursionTimeframe is set but no excursion was measured, which claims a measurement that was not made.",
    );
  }

  return Object.freeze({
    ...outcome,
    underlying: Object.freeze({ ...underlying }),
    instrument: Object.freeze({ ...instrument }),
    execution: Object.freeze({ ...execution }),
  });
}

/**
 * Which layer a loss is attributable to, or null when the layers do not single one out.
 *
 * Returns null rather than guessing. The whole value of the split is that it can say "the thesis was
 * right and the fill was wrong"; a function that always produced an answer would reintroduce the
 * confident-but-unfounded attribution the split exists to remove.
 */
export function attributeShortfall(outcome: Readonly<LayeredOutcome>): "UNDERLYING" | "INSTRUMENT" | "EXECUTION" | null {
  if (outcome.execution.realisedPnl >= 0) return null;

  if (outcome.underlying === null) {
    /*
     * Without the underlying layer there is no way to tell a wrong thesis from a wrong expression: both
     * present as an option that lost money. Declining is the honest answer -- guessing here would
     * manufacture the confident attribution the split exists to remove, and it would do it silently.
     */
    return null;
  }
  if (outcome.underlying.resolution === "INVALIDATED") return "UNDERLYING";

  // The underlying went the right way, so the loss came from the expression or the fill.
  if (outcome.execution.theoreticalPnl > 0 && outcome.execution.erosion >= outcome.execution.theoreticalPnl) {
    return "EXECUTION";
  }
  if (outcome.execution.theoreticalPnl <= 0 && outcome.underlying?.resolution === "TARGET_REACHED") {
    // The target was reached and the instrument still lost: the expression failed to capture it.
    return "INSTRUMENT";
  }
  return null;
}
