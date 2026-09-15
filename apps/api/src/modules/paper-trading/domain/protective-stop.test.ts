import { describe, expect, it } from "vitest";
import {
  advanceProtectiveStop,
  momentumScalp1mStopPolicy,
  type ProtectiveStopPolicy,
} from "./protective-stop.js";

/** Entry 100, stop 90, so 1R = 10 premium points. */
const base = { entryPrice: 100, initialStopLoss: 90, currentStopLoss: 90 };
const withTrail: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 1, distanceR: 0.5 } };

describe("break-even stage", () => {
  it("does not move the stop below the trigger", () => {
    expect(advanceProtectiveStop({ ...base, markPremium: 104, policy: momentumScalp1mStopPolicy })).toBeNull();
  });

  it("moves the stop to entry exactly at the trigger", () => {
    const advance = advanceProtectiveStop({ ...base, markPremium: 105, policy: momentumScalp1mStopPolicy });
    expect(advance?.stopLoss).toBe(100);
    expect(advance?.reason).toContain("break-even");
  });

  it("does not move again once already at entry", () => {
    // Monotonic: the candidate equals the stop in force, so there is nothing to do.
    expect(advanceProtectiveStop({
      ...base, currentStopLoss: 100, markPremium: 106, policy: momentumScalp1mStopPolicy,
    })).toBeNull();
  });

  it("is inert with no trail configured, however far the trade runs", () => {
    const advance = advanceProtectiveStop({
      ...base, currentStopLoss: 100, markPremium: 130, policy: momentumScalp1mStopPolicy,
    });
    expect(advance).toBeNull();
  });
});

describe("trail stage", () => {
  it("stays on break-even between the two triggers", () => {
    const advance = advanceProtectiveStop({ ...base, markPremium: 107, policy: withTrail });
    expect(advance?.stopLoss).toBe(100);
  });

  it("takes over at its own trigger", () => {
    // +1R at 110, trailing 0.5R behind => 105.
    const advance = advanceProtectiveStop({ ...base, currentStopLoss: 100, markPremium: 110, policy: withTrail });
    expect(advance?.stopLoss).toBe(105);
    expect(advance?.reason).toContain("trailed");
  });

  it("ratchets upward as the mark advances", () => {
    const first = advanceProtectiveStop({ ...base, currentStopLoss: 100, markPremium: 110, policy: withTrail });
    const second = advanceProtectiveStop({
      ...base, currentStopLoss: first?.stopLoss ?? 0, markPremium: 120, policy: withTrail,
    });
    expect(second?.stopLoss).toBe(115);
  });

  it("refuses to widen when the mark falls back", () => {
    /*
     * The load-bearing property. A stop that could widen would hand back risk the trade had already
     * banked, and would make the outcome depend on the order marks arrived in.
     */
    expect(advanceProtectiveStop({
      ...base, currentStopLoss: 115, markPremium: 112, policy: withTrail,
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

  it("refuses a stop at or above the mark instead of booking an unoffered exit", () => {
    // distanceR 0 would place the stop exactly on the mark, firing on the tick that set it.
    const onTheMark: ProtectiveStopPolicy = { breakEvenTriggerR: 0.5, trail: { triggerR: 1, distanceR: 0 } };
    expect(advanceProtectiveStop({
      ...base, currentStopLoss: 100, markPremium: 110, policy: onTheMark,
    })).toBeNull();
  });

  it("refuses a non-finite or non-positive mark", () => {
    for (const markPremium of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(advanceProtectiveStop({ ...base, markPremium, policy: withTrail })).toBeNull();
    }
  });

  it("never returns a stop that is not an improvement", () => {
    // Property sweep over the trail policy: whatever it returns must beat the stop in force.
    for (let mark = 90; mark <= 140; mark += 0.5) {
      for (const currentStopLoss of [90, 100, 105, 115, 130]) {
        const advance = advanceProtectiveStop({ ...base, currentStopLoss, markPremium: mark, policy: withTrail });
        if (advance) {
          expect(advance.stopLoss).toBeGreaterThan(currentStopLoss);
          expect(advance.stopLoss).toBeLessThan(mark);
        }
      }
    }
  });
});

describe("the shipped 1m policy", () => {
  it("reproduces the live behaviour: break-even at +0.5R, no trail", () => {
    expect(momentumScalp1mStopPolicy.breakEvenTriggerR).toBe(0.5);
    expect(momentumScalp1mStopPolicy.trail).toBeNull();
  });
});
