import { describe, expect, it } from "vitest";
import { buildContractCost, type CostLeg } from "./contract-cost";
import {
  CHECKLIST_RULES,
  buildChecklist,
  buildSizing,
  feeModelFromEstimates,
  feesForLots,
  findOiWalls,
  thetaOverHoldPercent,
  typicalHoldMovePoints,
  type ChecklistInput,
  type PlanInput,
} from "./pre-trade-checklist";

/** Synthetic figures, hand-built for the arithmetic (not recorded from the API). */
const SPOT = 54_300;
// Round trip Rs 66 for one lot and Rs 85 for two: Rs 47 flat plus Rs 19 a lot.
const FEES = feeModelFromEstimates(65, 66, 85)!;

const leg = (overrides: Partial<CostLeg> = {}): CostLeg => ({
  bid: 330, ask: 336, impliedVolatility: 0.15, delta: 0.5, gamma: 0.0004, theta: -12, daysToExpiry: 4, ...overrides,
});
const costOf = (overrides: Partial<CostLeg> = {}, side: "CE" | "PE" = "CE") =>
  buildContractCost({ optionType: side, strike: 54_300, spot: SPOT, leg: leg(overrides) }, null);

const plan = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  stopPremium: 300, targetPremium: 420, holdMinutes: 30, reason: "Breakout above the day high should carry about 150 points by noon.", riskBudgetInr: 10_000, ...overrides,
});

const walls = { callWall: { strike: 54_500, oi: 900_000 }, putWall: { strike: 54_000, oi: 800_000 } };

const input = (overrides: Partial<ChecklistInput> = {}): ChecklistInput => ({
  side: "CE", cost: costOf(), quoteWarning: null, plan: plan(), fees: FEES, walls, spot: SPOT, typicalDay: { low: 150, high: 180 }, ...overrides,
});

const byId = (list: ReturnType<typeof buildChecklist>, id: string) => list.checks.find((check) => check.id === id)!;

describe("the charges line", () => {
  it("is fitted from the one-lot and two-lot estimates: a flat part and a part per lot", () => {
    expect(FEES).toEqual({ lotSize: 65, flatInr: 47, perLotInr: 19 });
    expect(feesForLots(FEES, 4)).toBe(123);
  });

  it("refuses estimates that are not numbers or that fall as lots rise, and clamps a rounding-sized negative intercept to zero", () => {
    expect(feeModelFromEstimates(65, Number.NaN, 85)).toBeNull();
    expect(feeModelFromEstimates(0, 66, 85)).toBeNull();
    expect(feeModelFromEstimates(65, 85, 66)).toBeNull();
    const clamped = feeModelFromEstimates(65, 40, 80.01)!;
    expect(clamped.flatInr).toBe(0);
    expect(clamped.perLotInr).toBeCloseTo(40.01, 9);
  });
});

describe("sizing from the amount you will lose", () => {
  it("buys the most lots whose loss at the stop, charges included, fits the limit", () => {
    // ask 336, stop 300: Rs 36 a unit = Rs 2,340 a lot. floor((10,000 - 47) / (2,340 + 19)) = 4.
    const sizing = buildSizing(336, plan(), FEES)!;
    expect(sizing.lots).toBe(4);
    expect(sizing).toMatchObject({ basisLots: 4, quantity: 260, charges: 123, premiumPaid: 336 * 260 });
    expect(sizing.lossAtStop).toBe(9_360 + 123);
    expect(sizing.lossAtStop).toBeLessThanOrEqual(10_000);
    // one more lot would break the limit
    expect(5 * 2_340 + feesForLots(FEES, 5)).toBeGreaterThan(10_000);
    expect(sizing.chargesShareOfRisk).toBeCloseTo(123 / 9_360, 12);
    expect(sizing.gainAtTarget).toBe(84 * 260 - 123);
    expect(sizing.netRewardToRisk).toBeCloseTo((84 * 260 - 123) / (9_360 + 123), 12);
  });

  it("says zero lots when the limit does not cover one, and works the other figures at one lot", () => {
    const sizing = buildSizing(336, plan({ riskBudgetInr: 300 }), FEES)!;
    expect(sizing.lots).toBe(0);
    expect(sizing.basisLots).toBe(1);
    expect(sizing.lossAtStop).toBe(2_340 + 66);
  });

  it("has no sizing without a stop below the ask, a quote, or the charges", () => {
    expect(buildSizing(336, plan({ stopPremium: 336 }), FEES)).toBeNull();
    expect(buildSizing(336, plan({ stopPremium: null }), FEES)).toBeNull();
    expect(buildSizing(null, plan(), FEES)).toBeNull();
    expect(buildSizing(336, plan(), null)).toBeNull();
  });

  it("gives lots of null, not zero, when no limit was entered", () => {
    expect(buildSizing(336, plan({ riskBudgetInr: null }), FEES)!.lots).toBeNull();
  });
});

describe("charges against the risk", () => {
  it("passes when the charges are a small part of what the stop risks", () => {
    expect(byId(buildChecklist(input()), "charges").status).toBe("pass");               // 1.3%
  });

  it("fails a tight stop: Rs 66 of charges on a Rs 325 risk is 20.3%", () => {
    const tight = input({ cost: costOf({ bid: 99, ask: 100 }), plan: plan({ stopPremium: 95, targetPremium: 110, riskBudgetInr: 400 }) });
    const check = byId(buildChecklist(tight), "charges");
    expect(check.status).toBe("fail");
    expect(check.value).toContain("20.3%");
  });

  it("is unknown, not a pass, when there is no stop or no charges", () => {
    expect(byId(buildChecklist(input({ plan: plan({ stopPremium: null }) })), "charges").status).toBe("unknown");
    expect(byId(buildChecklist(input({ fees: null })), "charges").status).toBe("unknown");
  });
});

describe("spread and quote", () => {
  it("passes a tight spread, cautions a wider one and fails a wide one, on the mid", () => {
    expect(byId(buildChecklist(input()), "spread").status).toBe("pass");                                         // 6 / 333 = 1.80%
    expect(byId(buildChecklist(input({ cost: costOf({ bid: 320 }) })), "spread").status).toBe("caution");        // 16 / 328 = 4.88%
    expect(byId(buildChecklist(input({ cost: costOf({ bid: 300 }) })), "spread").status).toBe("fail");           // 36 / 318 = 11.3%
  });

  it("fails a contract with no two-sided quote: unquoted is unknown, not cheap", () => {
    for (const bad of [{ bid: 0 }, { bid: null }, { ask: null }, { bid: 340, ask: 336 }]) {
      expect(byId(buildChecklist(input({ cost: costOf(bad) })), "spread").status, JSON.stringify(bad)).toBe("fail");
    }
  });

  it("lowers a pass to a caution when the quote has stopped moving, and keeps a fail a fail", () => {
    const warning = "This quote has not changed in the last 4 snapshots.";
    const cautioned = byId(buildChecklist(input({ quoteWarning: warning })), "spread");
    expect(cautioned.status).toBe("caution");
    expect(cautioned.detail).toBe(warning);
    expect(byId(buildChecklist(input({ cost: costOf({ bid: 300 }), quoteWarning: warning })), "spread").status).toBe("fail");
  });

  it("is unknown with no contract selected", () => {
    expect(byId(buildChecklist(input({ cost: null })), "spread").status).toBe("unknown");
  });
});

describe("time left", () => {
  const heldFor = (minutes: number | null, cost = costOf()) => input({ cost, plan: plan({ holdMinutes: minutes }) });

  it("takes the worse of days to expiry and the theta over the planned hold", () => {
    expect(byId(buildChecklist(input()), "time").status).toBe("pass");                                                  // 4 days; 30 min of a 3.57% a day theta is 0.07%
    expect(byId(buildChecklist(input({ cost: costOf({ daysToExpiry: 2 }) })), "time").status).toBe("caution");          // under 3 days
    expect(byId(buildChecklist(input({ cost: costOf({ daysToExpiry: 0.5 }) })), "time").status).toBe("fail");           // under 1 day
    // Held a whole day, the per-day figure is the cost of waiting: 3.57% and 5.95% caution (over 3%), 8.93% fail (over 6%).
    expect(byId(buildChecklist(heldFor(1440)), "time").status).toBe("caution");
    expect(byId(buildChecklist(heldFor(1440, costOf({ theta: -20 }))), "time").status).toBe("caution");
    expect(byId(buildChecklist(heldFor(1440, costOf({ theta: -30 }))), "time").status).toBe("fail");
  });

  it("scales theta by the hold: a steep weekly decay does not fail a 30-minute trade, and a two-day hold costs twice a one-day hold", () => {
    const weekly = costOf({ theta: -50 });                                                                               // 14.9% of the ask a calendar day
    expect(byId(buildChecklist(heldFor(30, weekly)), "time").status).toBe("pass");                                       // 0.31%
    expect(byId(buildChecklist(heldFor(1440, weekly)), "time").status).toBe("fail");                                     // 14.9%
    expect(byId(buildChecklist(heldFor(60, weekly)), "time").value).toContain("about 0.6% over your 60 min hold");
    expect(thetaOverHoldPercent(weekly, 2880)).toBeCloseTo(2 * thetaOverHoldPercent(weekly, 1440)!, 12);
  });

  it("shows the per-day figure and asks for a hold time when none was entered, without scoring theta", () => {
    const check = byId(buildChecklist(heldFor(null)), "time");
    expect(check.status).toBe("pass");
    expect(check.value).toContain("enter a hold time");
    expect(thetaOverHoldPercent(costOf(), null)).toBeNull();
  });

  it("is unknown without days to expiry, and does not penalise a missing theta", () => {
    expect(byId(buildChecklist(input({ cost: costOf({ daysToExpiry: null }) })), "time").status).toBe("unknown");
    expect(byId(buildChecklist(heldFor(1440, costOf({ theta: null }))), "time").status).toBe("pass");
    expect(thetaOverHoldPercent(costOf({ theta: null }), 30)).toBeNull();
  });
});

describe("implied volatility", () => {
  it("is shown but never scored, because there is no IV history to rank it against", () => {
    const check = byId(buildChecklist(input()), "iv");
    expect(check.status).toBe("not-scored");
    expect(check.value).toBe("IV 15.00%");
  });
});

describe("open-interest walls", () => {
  it("finds the biggest call OI strictly above the index and the biggest put OI strictly below it", () => {
    const found = findOiWalls([
      { strike: 54_000, callOi: 5, putOi: 800_000 },
      { strike: 54_200, callOi: 1, putOi: 100 },
      { strike: 54_300, callOi: 999, putOi: 999 },          // at the index: neither above nor below
      { strike: 54_400, callOi: 300_000, putOi: 1 },
      { strike: 54_500, callOi: 900_000, putOi: null },
      { strike: 54_600, callOi: 0, putOi: 0 },
    ], SPOT);
    expect(found).toEqual({ callWall: { strike: 54_500, oi: 900_000 }, putWall: { strike: 54_000, oi: 800_000 } });
    expect(findOiWalls([], SPOT)).toEqual({ callWall: null, putWall: null });
    expect(findOiWalls([{ strike: 54_500, callOi: 5, putOi: 5 }], null)).toEqual({ callWall: null, putWall: null });
  });

  it("passes a call when the call wall is beyond the move the target needs, and cautions when it comes first", () => {
    // target 420 vs ask 336 at delta 0.5 needs about 168 points; the wall is 200 away
    expect(byId(buildChecklist(input()), "levels").status).toBe("pass");
    const near = input({ walls: { callWall: { strike: 54_400, oi: 900_000 }, putWall: null } });
    expect(byId(buildChecklist(near), "levels").status).toBe("caution");                                          // 100 away
  });

  it("uses the put wall below the index for a put, and the size of delta whatever its sign", () => {
    const put = input({ side: "PE", cost: costOf({ delta: -0.5 }, "PE") });
    const check = byId(buildChecklist(put), "levels");
    expect(check.value).toContain("put OI wall at 54,000");
    expect(check.status).toBe("pass");                                                                            // 300 points away, past the 168 the target needs
    const near = input({ side: "PE", cost: costOf({ delta: -0.5 }, "PE"), walls: { callWall: null, putWall: { strike: 54_250, oi: 800_000 } } });
    expect(byId(buildChecklist(near), "levels").status).toBe("caution");                                          // 50 points away: the index would have to move through it
  });

  it("is unknown without a wall, without a target above the ask, or without a usable delta", () => {
    expect(byId(buildChecklist(input({ walls: { callWall: null, putWall: null } })), "levels").status).toBe("unknown");
    expect(byId(buildChecklist(input({ plan: plan({ targetPremium: null }) })), "levels").status).toBe("unknown");
    expect(byId(buildChecklist(input({ cost: costOf({ delta: 0.01 }) })), "levels").status).toBe("unknown");
  });
});

describe("the written plan", () => {
  it("fails and names what is missing, including a reason that is not a sentence", () => {
    const check = byId(buildChecklist(input({ plan: plan({ stopPremium: null, holdMinutes: null, reason: "up" }) })), "exit-plan");
    expect(check.status).toBe("fail");
    expect(check.value).toBe("missing: stop, time limit, reason");
  });

  it("fails a stop at or above the ask and a target at or below it", () => {
    expect(byId(buildChecklist(input({ plan: plan({ stopPremium: 340 }) })), "exit-plan").status).toBe("fail");
    expect(byId(buildChecklist(input({ plan: plan({ targetPremium: 330 }) })), "exit-plan").status).toBe("fail");
  });

  it("passes a complete plan with reward at least as big as the risk after charges, and cautions one below", () => {
    const pass = byId(buildChecklist(input()), "exit-plan");
    expect(pass.status).toBe("pass");
    expect(pass.value).toContain("2.29× reward to risk after charges");
    // target 350: gain 14 a unit, Rs 910 a lot, against Rs 2,340 at the stop
    expect(byId(buildChecklist(input({ plan: plan({ targetPremium: 350 }) })), "exit-plan").status).toBe("caution");
  });

  it("requires the minimum reason length from the rules, ignoring surrounding spaces", () => {
    const short = "x".repeat(CHECKLIST_RULES.minReasonLength - 1);
    expect(byId(buildChecklist(input({ plan: plan({ reason: `   ${short}   ` }) })), "exit-plan").status).toBe("fail");
    expect(byId(buildChecklist(input({ plan: plan({ reason: "x".repeat(CHECKLIST_RULES.minReasonLength) }) })), "exit-plan").status).toBe("pass");
  });
});

describe("stop outside normal noise", () => {
  // Typical move over a 30 minute hold: 165 points a day scaled by sqrt(30 / 375) = 0.2828, so about 46.7 points.
  it("scales a typical day down to the hold by the square root of the share of the session, capped at one day", () => {
    expect(typicalHoldMovePoints({ low: 150, high: 180 }, 30)).toBeCloseTo(165 * Math.sqrt(30 / 375), 12);
    expect(typicalHoldMovePoints({ low: 150, high: 180 }, 375)).toBe(165);
    expect(typicalHoldMovePoints({ low: 150, high: 180 }, 5_000)).toBe(165);        // past a session: capped, not extrapolated
    expect(typicalHoldMovePoints(null, 30)).toBeNull();
    expect(typicalHoldMovePoints({ low: 150, high: 180 }, null)).toBeNull();
    expect(typicalHoldMovePoints({ low: 0, high: 180 }, 30)).toBeNull();
  });

  it("passes a stop outside the typical move, cautions one between half and all of it, and fails one inside half", () => {
    // ask 336, delta 0.5: a stop at 300 is 72 index points away (1.54x), 315 is 42 (0.90x), 330 is 12 (0.26x)
    expect(byId(buildChecklist(input()), "stop-noise").status).toBe("pass");
    expect(byId(buildChecklist(input({ plan: plan({ stopPremium: 315 }) })), "stop-noise").status).toBe("caution");
    const tight = byId(buildChecklist(input({ plan: plan({ stopPremium: 330 }) })), "stop-noise");
    expect(tight.status).toBe("fail");
    expect(tight.value).toContain("12 index points away");
    expect(tight.value).toContain("0.26×");
  });

  it("gets easier the shorter the hold, because a typical move over a few minutes is small", () => {
    expect(byId(buildChecklist(input({ plan: plan({ stopPremium: 315, holdMinutes: 5 }) })), "stop-noise").status).toBe("pass");   // typical about 19 points
  });

  it("is unknown without a stop below the ask, a hold, a usable delta, or the implied daily move", () => {
    expect(byId(buildChecklist(input({ plan: plan({ stopPremium: null }) })), "stop-noise").status).toBe("unknown");
    expect(byId(buildChecklist(input({ plan: plan({ holdMinutes: null }) })), "stop-noise").status).toBe("unknown");
    expect(byId(buildChecklist(input({ cost: costOf({ delta: 0.01 }) })), "stop-noise").status).toBe("unknown");
    expect(byId(buildChecklist(input({ typicalDay: null })), "stop-noise").status).toBe("unknown");
  });
});

describe("position size", () => {
  it("passes with the lots the limit allows and shows what is paid and what the stop loses", () => {
    const check = byId(buildChecklist(input()), "size");
    expect(check.status).toBe("pass");
    expect(check.value).toContain("4 lots (260 units)");
    expect(check.value).toContain("loses ₹9,483 at the stop");
  });

  it("fails when the limit does not cover one lot, and is unknown with no limit", () => {
    const zero = byId(buildChecklist(input({ plan: plan({ riskBudgetInr: 300 }) })), "size");
    expect(zero.status).toBe("fail");
    expect(zero.value).toContain("0 lots");
    expect(byId(buildChecklist(input({ plan: plan({ riskBudgetInr: null }) })), "size").status).toBe("unknown");
  });
});

describe("the summary", () => {
  it("counts the scored checks, leaves IV out as not scored, and never says to trade or not to", () => {
    const list = buildChecklist(input());
    expect(list.summary).toMatchObject({ pass: 7, caution: 0, fail: 0, unknown: 0, notScored: 1 });
    expect(list.summary.sentence).toContain("7 of 7 checks pass (1 not scored)");
    expect(list.summary.sentence).toContain("the decision is yours");
    expect(list.summary.sentence).not.toMatch(/\b(buy|sell|enter|avoid|take this trade)\b/i);
  });

  it("lists cautions, fails and unknowns beside the passes", () => {
    const list = buildChecklist(input({ cost: costOf({ bid: 320 }), plan: plan({ stopPremium: null }) }));
    expect(list.summary.caution).toBeGreaterThan(0);
    expect(list.summary.unknown).toBeGreaterThan(0);
    expect(list.summary.fail).toBeGreaterThan(0);                                                                 // the exit plan has no stop
    expect(list.checks).toHaveLength(8);
  });
});
