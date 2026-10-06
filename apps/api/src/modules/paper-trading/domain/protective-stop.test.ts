import { describe, expect, it } from "vitest";
import {
  advanceProtectiveStop,
  momentumScalp1mStopPolicy,
  type ProtectiveStopPolicy,
} from "./protective-stop.js";

/** Entry 100, stop 90, so 1R = 10 premium points. */
const base = { entryPrice: 100, initialStopLoss: 90, currentStopLoss: 90 };
const withTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 1, distanceR: 0.5 } };
/** Break-even only -- what the shipped policy *would* be if it were enabled. Not the live default
 * as of 2026-09-21 (see "the shipped 1m policy" below); kept local so these mechanics stay covered
 * independent of whatever the shipped default currently is. */
const breakEvenOnly: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: null };

describe("break-even stage", () => {
  it("does not move the stop below the trigger", () => {
    expect(advanceProtectiveStop({ ...base, markPremium: 104, policy: breakEvenOnly })).toBeNull();
  });

  it("moves the stop to one tick below entry at the trigger, not onto entry itself", () => {
    // `paper_trades_check` requires stop_loss < entry_price for a LONG, strictly. Landing on 100
    // exactly (the textbook break-even) fails that constraint every time -- confirmed live,
    // 2026-09-21 -- so the closest value this schema can actually persist is one tick short.
    const advance = advanceProtectiveStop({ ...base, markPremium: 105, policy: breakEvenOnly });
    expect(advance?.stopLoss).toBe(99.95);
    expect(advance?.reason).toContain("break-even");
  });

  it("does not move again once already at the break-even floor", () => {
    // Monotonic: the candidate equals the stop already in force, so there is nothing to do.
    expect(advanceProtectiveStop({
      ...base, currentStopLoss: 99.95, markPremium: 106, policy: breakEvenOnly,
    })).toBeNull();
  });

  it("is inert with no trail configured, however far the trade runs", () => {
    const advance = advanceProtectiveStop({
      ...base, currentStopLoss: 99.95, markPremium: 130, policy: breakEvenOnly,
    });
    expect(advance).toBeNull();
  });
});

describe("trail stage", () => {
  it("stays on the break-even floor between the two triggers", () => {
    const advance = advanceProtectiveStop({ ...base, markPremium: 107, policy: withTrail });
    expect(advance?.stopLoss).toBe(99.95);
  });

  it("applies its own math unclamped while the trailed level is still below entry", () => {
    // triggerR 0.6, distanceR 0.8, risk 10: at the trigger (106), candidate = 106 - 8 = 98 -- under
    // the entry ceiling (99.95), so nothing clamps it.
    const wideTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 0.6, distanceR: 0.8 } };
    const advance = advanceProtectiveStop({ ...base, currentStopLoss: 90, markPremium: 106, policy: wideTrail });
    expect(advance?.stopLoss).toBe(98);
    expect(advance?.reason).toContain("trailed");
  });

  it("ratchets upward as the mark advances, still below entry", () => {
    const wideTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 0.6, distanceR: 0.8 } };
    const first = advanceProtectiveStop({ ...base, currentStopLoss: 90, markPremium: 106, policy: wideTrail });
    expect(first?.stopLoss).toBe(98);
    const second = advanceProtectiveStop({
      ...base, currentStopLoss: first?.stopLoss ?? 0, markPremium: 107, policy: wideTrail,
    });
    expect(second?.stopLoss).toBe(99);
  });

  it("caps at one tick below entry once the trail's own math would cross it", () => {
    // Same schema floor as break-even: `paper_trades_check` forbids stop_loss >= entry_price for a
    // LONG regardless of which branch computed the candidate. +1R at 110, trailing 0.5R behind would
    // want 105 -- a real profit lock the current schema cannot represent -- so it floors at 99.95
    // exactly like break-even, until locking in profit above entry is itself a registered decision.
    const advance = advanceProtectiveStop({ ...base, currentStopLoss: 90, markPremium: 110, policy: withTrail });
    expect(advance?.stopLoss).toBe(99.95);
  });

  it("refuses to widen when the mark falls back", () => {
    /*
     * The load-bearing property. A stop that could widen would hand back risk the trade had already
     * banked, and would make the outcome depend on the order marks arrived in.
     */
    const wideTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 0.6, distanceR: 0.8 } };
    expect(advanceProtectiveStop({
      ...base, currentStopLoss: 99, markPremium: 106.5, policy: wideTrail,
    })).toBeNull();
  });
});

describe("refusals", () => {
  it("refuses a non-positive risk rather than dividing by it", () => {
    expect(advanceProtectiveStop({
      entryPrice: 100, initialStopLoss: 100, currentStopLoss: 100, markPremium: 120, policy: withTrail,
    })).toBeNull();
    expect(advanceProtectiveStop({
      entryPrice: 100, initialStopLoss: 110, currentStopLoss: 110, markPremium: 120, policy: withTrail,
    })).toBeNull();
  });

  it("refuses a non-finite or non-positive mark", () => {
    for (const markPremium of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(advanceProtectiveStop({ ...base, markPremium, policy: withTrail })).toBeNull();
    }
  });

  it("never returns a stop that is not an improvement, nor at or past entry", () => {
    // Property sweep over the trail policy: whatever it returns must beat the stop in force, stay
    // under the mark, and stay strictly under entry -- the schema's own invariant for a LONG.
    for (let mark = 90; mark <= 140; mark += 0.5) {
      for (const currentStopLoss of [90, 99.95, 105, 115, 130]) {
        const advance = advanceProtectiveStop({ ...base, currentStopLoss, markPremium: mark, policy: withTrail });
        if (advance) {
          expect(advance.stopLoss).toBeGreaterThan(currentStopLoss);
          expect(advance.stopLoss).toBeLessThan(mark);
          expect(advance.stopLoss).toBeLessThan(base.entryPrice);
        }
      }
    }
  });
});

/*
 * Until migration 117 the trail could not lock profit, so `trail` and `breakEvenTriggerR` described
 * the same stop. Measured over the stored premium ticks of all 439 closed option trades, a
 * `trail 0.5R/0.25R` policy and a plain break-even produced the identical book: +9,632.96 against the
 * recorded baseline, both, to the rupee. These tests pin the difference `lockProfit` makes.
 */
describe("profit-locking trail", () => {
  const lockTrail: ProtectiveStopPolicy = {
    breakEvenTriggerR: 0.5,
    trail: { triggerR: 1, distanceR: 0.5, lockProfit: true },
  };

  it("places the stop above entry, where the clamped trail could not", () => {
    // +2R at 120, trailing 0.5R behind => 115, genuinely above entry.
    expect(advanceProtectiveStop({ ...base, markPremium: 120, policy: lockTrail })?.stopLoss).toBe(115);
    // The same geometry without the flag is break-even and nothing more.
    expect(advanceProtectiveStop({ ...base, markPremium: 120, policy: withTrail })?.stopLoss).toBe(99.95);
  });

  it("leaves an omitted lockProfit clamped, so every existing config is byte-identical", () => {
    expect(withTrail.trail?.lockProfit).toBeUndefined();
    expect(advanceProtectiveStop({ ...base, markPremium: 130, policy: withTrail })?.stopLoss).toBe(99.95);
  });

  it("still refuses a stop at or above the mark, which would fire on the tick that set it", () => {
    const zeroDistance: ProtectiveStopPolicy = {
      breakEvenTriggerR: 0.5,
      trail: { triggerR: 1, distanceR: 0, lockProfit: true },
    };
    expect(advanceProtectiveStop({ ...base, markPremium: 120, policy: zeroDistance })).toBeNull();
  });

  it("stays monotonic above entry: a lower trail candidate cannot hand risk back", () => {
    expect(advanceProtectiveStop({
      ...base, currentStopLoss: 118, markPremium: 120, policy: lockTrail,
    })).toBeNull();
  });
});

describe("the shipped 1m policy", () => {
  it("is fully inert as of 2026-09-21: break-even backtested worse, not better", () => {
    // t=-1.86 (NIFTY50) / -2.63 (BANKNIFTY) against real cost. See the file docstring.
    expect(momentumScalp1mStopPolicy.breakEvenTriggerR).toBeNull();
    expect(momentumScalp1mStopPolicy.trail).toBeNull();
  });

  it("never advances a stop under the shipped policy, however far the trade runs", () => {
    const advance = advanceProtectiveStop({
      ...base, markPremium: 130, policy: momentumScalp1mStopPolicy,
    });
    expect(advance).toBeNull();
  });
});
