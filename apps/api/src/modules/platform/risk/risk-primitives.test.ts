import { describe, expect, it } from "vitest";
import { approve, decideCapacity, refuse } from "./risk-primitives.js";
import {
  InstrumentNotCoveredError,
  narrowToInstrument,
  sealRiskSnapshot,
  type AccountRiskSnapshot,
} from "./risk-snapshot.js";
import { decideDailyTradeCap } from "../../paper-trading/domain/daily-trade-cap.js";
import type { VolatilityRegimeEvidence } from "../../risk-management/domain/risk.js";

const asOf = new Date("2026-08-31T09:46:00.000Z");

const niftyEvidence: VolatilityRegimeEvidence = {
  prediction: "EXPANSION",
  confidence: 0.7,
  evidenceCutoffAt: new Date("2026-08-31T09:45:59.999Z"),
};

/*
 * Typed at the real domain evidence rather than cast.
 *
 * The first draft used `{ regime: "EXPANSION", confidence: 0.7 } as never`, and the cast hid that the
 * field is `prediction`, not `regime` -- a test asserting against a shape the domain does not have.
 * Parameterising the snapshot restores the check, which is the point of the type parameter: the
 * platform stays ignorant of what evidence is while a consumer stays fully checked.
 */
const snapshot: AccountRiskSnapshot<VolatilityRegimeEvidence> = {
  asOf,
  accountEquity: 100_000,
  peakEquity: 120_000,
  openPositionCount: 2,
  realizedPnlToday: -1_500,
  volatilityEvidenceByInstrument: {
    "instrument-nifty": niftyEvidence,
    "instrument-banknifty": null,
  },
};

describe("decideCapacity", () => {
  it("matches the paper-trading implementation it generalises, across the whole boundary", () => {
    /*
     * The extraction is only safe if it is behaviour-identical. Rather than assert chosen outputs,
     * compare against the live implementation over the range where the two most plausibly diverge:
     * around zero, at the cap, and one either side of it.
     */
    for (const cap of [null, 0, 1, 3] as const) {
      for (const used of [0, 1, 2, 3, 4]) {
        const mine = decideCapacity({ used, cap });
        const theirs = decideDailyTradeCap({ openedToday: used, cap });
        expect(mine.allowed, `used=${used} cap=${cap}`).toBe(theirs.allowed);
      }
    }
  });

  it("treats a cap of zero as blocking and null as unlimited", () => {
    // The pair that is easiest to get backwards, and the difference is "this account cannot trade"
    // versus "this account is unlimited".
    expect(decideCapacity({ used: 0, cap: 0 })).toEqual({
      allowed: false, outcome: "CAP_REACHED", used: 0, cap: 0,
    });
    expect(decideCapacity({ used: 9_999, cap: null })).toEqual({
      allowed: true, outcome: "NO_CAP", used: 9_999, cap: null,
    });
  });

  it("blocks at the cap, not past it", () => {
    expect(decideCapacity({ used: 2, cap: 3 }).outcome).toBe("WITHIN_CAP");
    expect(decideCapacity({ used: 3, cap: 3 }).outcome).toBe("CAP_REACHED");
  });

  it("refuses counts and caps that cannot mean anything", () => {
    expect(() => decideCapacity({ used: -1, cap: 3 })).toThrow(/non-negative integer/);
    expect(() => decideCapacity({ used: 1.5, cap: 3 })).toThrow(/non-negative integer/);
    expect(() => decideCapacity({ used: 1, cap: -1 })).toThrow(/non-negative integer/);
  });
});

describe("StructuralRiskDecision carries no score (I18)", () => {
  it("exposes exactly approved and reasonCodes, and nothing that could be summed", () => {
    /*
     * I18 forbids a composite confidence score anywhere in Brain V2, because a score makes gates
     * commensurable -- a strong reading on one dimension silently offsets a failure on another. A
     * type alone would not stop a later edit adding `score`, so the key set is pinned.
     */
    expect(Object.keys(approve()).sort()).toEqual(["approved", "reasonCodes"]);
    expect(Object.keys(refuse(["EXPOSURE_LIMIT"])).sort()).toEqual(["approved", "reasonCodes"]);
  });

  it("names every reason, not just the first", () => {
    // Reporting one failure hides the rest and makes the next fix look sufficient.
    const decision = refuse(["EXPOSURE_LIMIT", "DAILY_LOSS_LIMIT"]);

    expect(decision.reasonCodes).toEqual(["EXPOSURE_LIMIT", "DAILY_LOSS_LIMIT"]);
    expect(decision.approved).toBe(false);
  });

  it("refuses a refusal with no reason", () => {
    expect(() => refuse([])).toThrow(/at least one reason/);
  });

  it("is frozen, and an approval carries no reasons", () => {
    const approved = approve();

    expect(approved.reasonCodes).toEqual([]);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(() => { (approved as { approved: boolean }).approved = false; }).toThrow();
  });
});

describe("AccountRiskSnapshot", () => {
  it("freezes the snapshot and its evidence map", () => {
    const sealed = sealRiskSnapshot(snapshot);

    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.volatilityEvidenceByInstrument)).toBe(true);
  });

  it("refuses a peak below current equity", () => {
    // Peak is a running maximum. A peak below equity means it was computed over the wrong window, and
    // every drawdown check downstream would understate the drawdown.
    expect(() => sealRiskSnapshot({ ...snapshot, peakEquity: 90_000 }))
      .toThrow(/running maximum/);
  });

  it("refuses non-finite money and a fractional position count", () => {
    expect(() => sealRiskSnapshot({ ...snapshot, accountEquity: Number.NaN })).toThrow(/finite/);
    expect(() => sealRiskSnapshot({ ...snapshot, realizedPnlToday: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => sealRiskSnapshot({ ...snapshot, openPositionCount: 1.5 })).toThrow(/non-negative integer/);
  });
});

describe("narrowToInstrument", () => {
  it("carries the account scalars through unchanged", () => {
    const narrowed = narrowToInstrument(snapshot, "instrument-nifty");

    expect(narrowed.accountEquity).toBe(100_000);
    expect(narrowed.peakEquity).toBe(120_000);
    expect(narrowed.openPositionCount).toBe(2);
    expect(narrowed.realizedPnlToday).toBe(-1_500);
    expect(narrowed.volatilityRegime).toEqual(niftyEvidence);
  });

  it("distinguishes covered-with-no-regime from not covered at all", () => {
    /*
     * The distinction this function exists for.
     *
     * `null` means the snapshot looked and found no regime -- a reading the domain may act on. An
     * absent key means the snapshot was never built for that instrument, which is a pipeline defect.
     * Collapsing them lets a proposal be judged against evidence nobody gathered, and once stored the
     * two are indistinguishable. The same conflation is what made an earlier feature-coverage gap
     * invisible, where "not computed" and "computed, found nothing" shared a representation.
     */
    expect(narrowToInstrument(snapshot, "instrument-banknifty").volatilityRegime).toBeNull();
    expect(() => narrowToInstrument(snapshot, "instrument-finnifty"))
      .toThrow(InstrumentNotCoveredError);
    expect(() => narrowToInstrument(snapshot, "instrument-finnifty"))
      .toThrow(/does not cover instrument/);
  });

  it("does not mistake an inherited property for coverage", () => {
    // `hasOwnProperty` rather than `in`, or every snapshot would appear to cover an instrument named
    // "toString" and return a function as its regime evidence.
    expect(() => narrowToInstrument(snapshot, "toString")).toThrow(InstrumentNotCoveredError);
    expect(() => narrowToInstrument(snapshot, "constructor")).toThrow(InstrumentNotCoveredError);
  });

  it("produces a shape the existing RiskState consumer can accept", () => {
    // The narrowed view is deliberately field-compatible with `risk-management`'s `RiskState`, so
    // adopting the primitive later is a substitution rather than a rewrite of `evaluateRisk`.
    const narrowed = narrowToInstrument(snapshot, "instrument-nifty");

    expect(Object.keys(narrowed).sort()).toEqual([
      "accountEquity", "openPositionCount", "peakEquity", "realizedPnlToday", "volatilityRegime",
    ]);
  });
});
