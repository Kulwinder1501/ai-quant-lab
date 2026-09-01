import { describe, expect, it } from "vitest";
import {
  attributeShortfall,
  OutcomeReconciliationError,
  reconcileOutcome,
  theoreticalPnlFor,
  type LayeredOutcome,
} from "./outcome-layers.js";

/** A closed LONG that worked: underlying up, option captured it, small erosion. */
function outcome(overrides: {
  underlying?: Partial<LayeredOutcome["underlying"]>;
  instrument?: Partial<LayeredOutcome["instrument"]>;
  execution?: Partial<LayeredOutcome["execution"]>;
  closed?: boolean;
  decisionId?: string;
} = {}): LayeredOutcome {
  const instrument = {
    contractSymbol: "NSE:BANKNIFTY26SEP57500CE",
    entryPrice: 200,
    exitPrice: 260,
    quantity: 15,
    direction: "LONG" as const,
    priceSource: "OBSERVED_BOOK" as const,
    captureRatio: 0.42,
    ...overrides.instrument,
  };
  const theoreticalPnl = theoreticalPnlFor(instrument);
  const realisedPnl = overrides.execution?.realisedPnl ?? theoreticalPnl - 45;
  return {
    decisionId: overrides.decisionId ?? "decision-1",
    closed: overrides.closed ?? true,
    underlying: {
      resolution: "TARGET_REACHED",
      entryReference: 57_400,
      exitReference: 57_620,
      favourableExcursion: 240,
      adverseExcursion: 60,
      excursionTimeframe: "1m",
      ...overrides.underlying,
    },
    instrument,
    execution: {
      theoreticalPnl,
      realisedPnl,
      erosion: theoreticalPnl - realisedPnl,
      fees: 30,
      entrySlippage: 10,
      exitSlippage: 5,
      ...overrides.execution,
    },
  };
}

describe("reconciling the three layers", () => {
  it("accepts layers that describe one event, and freezes them", () => {
    const reconciled = reconcileOutcome(outcome());

    expect(Object.isFrozen(reconciled)).toBe(true);
    expect(Object.isFrozen(reconciled.underlying)).toBe(true);
    expect(Object.isFrozen(reconciled.instrument)).toBe(true);
    expect(Object.isFrozen(reconciled.execution)).toBe(true);
  });

  it("recomputes theoreticalPnl from the recorded prices and refuses a supplied one that disagrees", () => {
    /*
     * The mark-pricing defect, in the form it actually took: a friendlier number reported alongside
     * prices that imply a different one. Splitting the outcome into three fields achieves nothing if
     * they are filled in from different sources; this is what makes the split load-bearing.
     */
    expect(() => reconcileOutcome(outcome({ execution: { theoreticalPnl: 2_032, realisedPnl: -651, erosion: 2_683 } })))
      .toThrow(/recorded instrument prices imply 900/);
  });

  it("refuses a closed outcome priced from a model mark", () => {
    /*
     * A model mark is legitimate for an open position -- there may be no trade to observe -- and never
     * for a settled one, where the fill is a fact. That substitution is what reported +Rs 2,032 on a
     * position down Rs 651.
     */
    expect(() => reconcileOutcome(outcome({ instrument: { priceSource: "MODEL_MARK" } })))
      .toThrow(/must be priced from the observed book/);
  });

  it("allows a model mark while the position is still open", () => {
    expect(() => reconcileOutcome(outcome({ closed: false, instrument: { priceSource: "MODEL_MARK" } })))
      .not.toThrow();
  });

  it("requires erosion to be exactly theoretical minus realised", () => {
    expect(() => reconcileOutcome(outcome({ execution: { erosion: 999 } })))
      .toThrow(/erosion is 999 but theoreticalPnl - realisedPnl is 45/);
  });

  it("permits negative erosion, because favourable slippage is real", () => {
    // Forcing erosion non-negative would make a better-than-expected fill impossible to record, and
    // the field would silently absorb the difference somewhere else.
    const better = outcome({ execution: { realisedPnl: theoreticalPnlFor(outcome().instrument) + 20 } });

    expect(() => reconcileOutcome({ ...better, execution: { ...better.execution, erosion: -20 } })).not.toThrow();
  });

  it("computes SHORT P&L from the other side", () => {
    const short = outcome({ instrument: { direction: "SHORT", entryPrice: 260, exitPrice: 200 } });

    expect(theoreticalPnlFor(short.instrument)).toBe(900);
    expect(() => reconcileOutcome(short)).not.toThrow();
  });
});

describe("excursions are upper bounds, and unmeasured is not zero", () => {
  it("keeps null distinct from zero", () => {
    /*
     * Zero is a strong claim -- "the position never moved against us" -- and it is the claim most
     * likely to make a bad stop look safe. Carried from `buildTradeReview`, which returns null when no
     * holding-period candles were available.
     */
    const unmeasured = reconcileOutcome(outcome({
      underlying: { favourableExcursion: null, adverseExcursion: null, excursionTimeframe: null },
    }));

    expect(unmeasured.underlying!.adverseExcursion).toBeNull();
    expect(unmeasured.underlying!.adverseExcursion).not.toBe(0);
  });

  it("accepts a wholly unmeasured underlying layer, and then declines to attribute", () => {
    /*
     * The state the adoption audit found: `paper_trades` records `underlying_entry_price` and no
     * underlying exit, and the holding-period candles belong to the option contract rather than the
     * underlying. So for a closed option trade there is no observed underlying exit at all.
     *
     * Null rather than a fabricated level, because `attributeShortfall` reads `resolution` to decide
     * whether the thesis was wrong -- a guessed reference would produce confident attribution out of
     * nothing, which is worse than declining.
     */
    const loss = outcome({ instrument: { exitPrice: 150 }, execution: { realisedPnl: -800 } });
    const withoutUnderlying = reconcileOutcome({
      ...loss,
      underlying: null,
      execution: {
        ...loss.execution,
        theoreticalPnl: theoreticalPnlFor(loss.instrument),
        erosion: theoreticalPnlFor(loss.instrument) - (-800),
      },
    });

    expect(withoutUnderlying.underlying).toBeNull();
    expect(attributeShortfall(withoutUnderlying)).toBeNull();
  });

  it("requires a timeframe whenever an excursion was measured", () => {
    /*
     * A bound without its timeframe is not interpretable: a 1d-derived excursion is nearly
     * uninformative and must not be compared against a 1m-derived one, and without the timeframe
     * nobody can tell which they hold.
     */
    expect(() => reconcileOutcome(outcome({
      underlying: { favourableExcursion: 240, adverseExcursion: null, excursionTimeframe: null },
    }))).toThrow(/record the timeframe they were read at/);
  });

  it("refuses a timeframe with no measurement behind it", () => {
    expect(() => reconcileOutcome(outcome({
      underlying: { favourableExcursion: null, adverseExcursion: null, excursionTimeframe: "1m" },
    }))).toThrow(/claims a measurement that was not made/);
  });

  it("refuses a negative excursion, which means the sign convention was applied twice", () => {
    expect(() => reconcileOutcome(outcome({ underlying: { adverseExcursion: -60 } })))
      .toThrow(/non-negative magnitude or null/);
  });
});

describe("captureRatio", () => {
  it("is null when the underlying did not move, rather than zero", () => {
    // Zero would say "the instrument captured nothing" when the truth is "there was nothing to capture".
    const flat = reconcileOutcome(outcome({
      underlying: { entryReference: 57_400, exitReference: 57_400, resolution: "UNRESOLVED_AT_HORIZON" },
      instrument: { captureRatio: null },
    }));

    expect(flat.instrument.captureRatio).toBeNull();
    expect(flat.underlying).not.toBeNull();
  });
});

describe("attributing a shortfall", () => {
  it("blames the underlying when the thesis was invalidated", () => {
    const loss = outcome({
      underlying: { resolution: "INVALIDATED", exitReference: 57_200 },
      instrument: { exitPrice: 150 },
      execution: { realisedPnl: -800 },
    });
    const fixed = { ...loss, execution: { ...loss.execution, theoreticalPnl: theoreticalPnlFor(loss.instrument), erosion: theoreticalPnlFor(loss.instrument) - (-800) } };

    expect(attributeShortfall(reconcileOutcome(fixed))).toBe("UNDERLYING");
  });

  it("blames execution when the instrument gained and the fill took all of it", () => {
    /*
     * The case the split exists for, and the one a single P&L number reports as a failed thesis: the
     * underlying reached target, the option gained, and the fill path erased the gain. Three real
     * defects of this shape have been measured, including a dense-tick lookup that booked a target as
     * a stop-loss.
     */
    const loss = outcome({ execution: { realisedPnl: -50 } });
    const fixed = { ...loss, execution: { ...loss.execution, erosion: loss.execution.theoreticalPnl + 50 } };

    expect(attributeShortfall(reconcileOutcome(fixed))).toBe("EXECUTION");
  });

  it("blames the instrument when the target was reached and the option still lost", () => {
    // Strike or expiry chosen badly: the thesis was right and the expression could not capture it.
    const loss = outcome({ instrument: { exitPrice: 180 }, execution: { realisedPnl: -320 } });
    const fixed = { ...loss, execution: { ...loss.execution, theoreticalPnl: theoreticalPnlFor(loss.instrument), erosion: theoreticalPnlFor(loss.instrument) - (-320) } };

    expect(attributeShortfall(reconcileOutcome(fixed))).toBe("INSTRUMENT");
  });

  it("returns null for a profitable outcome, and when the layers do not single one out", () => {
    /*
     * Deliberately refuses to guess. The value of the split is that it can say "the thesis was right
     * and the fill was wrong"; a function that always produced an answer would reintroduce the
     * confident-but-unfounded attribution it exists to remove.
     */
    expect(attributeShortfall(reconcileOutcome(outcome()))).toBeNull();

    const ambiguous = outcome({
      underlying: { resolution: "UNRESOLVED_AT_HORIZON" },
      instrument: { exitPrice: 195 },
      execution: { realisedPnl: -100 },
    });
    const fixed = { ...ambiguous, execution: { ...ambiguous.execution, theoreticalPnl: theoreticalPnlFor(ambiguous.instrument), erosion: theoreticalPnlFor(ambiguous.instrument) - (-100) } };

    expect(attributeShortfall(reconcileOutcome(fixed))).toBeNull();
  });
});

describe("structural refusals", () => {
  it("requires a decisionId and a real position", () => {
    expect(() => reconcileOutcome(outcome({ decisionId: "  " }))).toThrow(/must name the decision/);
    expect(() => reconcileOutcome(outcome({ instrument: { quantity: 0 } })))
      .toThrow(OutcomeReconciliationError);
  });

  it("refuses non-finite money", () => {
    expect(() => reconcileOutcome(outcome({ execution: { realisedPnl: Number.NaN } }))).toThrow(/finite/);
  });
});
