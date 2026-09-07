import { describe, expect, it } from "vitest";
import {
  nextWeeklyExpiry,
  mapIdeaToOptionBuyerFill,
  resolveOptionExpiryInstant,
  type OptionBuyerFillInput,
} from "./option-buyer-fill.js";

const NOW = new Date("2026-07-27T04:00:00.000Z"); // Monday
const EXPIRY = new Date("2026-07-30T10:00:00.000Z"); // Thursday 15:30 IST

function niftyIdea(overrides: Partial<OptionBuyerFillInput> = {}): OptionBuyerFillInput {
  return {
    ideaSide: "LONG",
    underlyingEntry: 24_371,
    underlyingStop: 24_250,
    underlyingTarget: 24_600,
    impliedVolatility: 0.14,
    expiryDate: EXPIRY,
    now: NOW,
    strikeStep: 50,
    ...overrides,
  };
}

describe("mapIdeaToOptionBuyerFill", () => {
  it("buys a call for a long idea and a put for a short one, always as a LONG position", () => {
    const long = mapIdeaToOptionBuyerFill(niftyIdea());
    const short = mapIdeaToOptionBuyerFill(niftyIdea({
      ideaSide: "SHORT",
      underlyingStop: 24_600,
      underlyingTarget: 24_100,
    }));

    expect(long.optionType).toBe("CE");
    expect(short.optionType).toBe("PE");
    // An option buyer is long premium whichever way the underlying view points.
    expect(long.side).toBe("LONG");
    expect(short.side).toBe("LONG");
  });

  it("snaps the strike to the instrument's interval", () => {
    const nifty = mapIdeaToOptionBuyerFill(niftyIdea({ strikeStep: 50 }));
    const banknifty = mapIdeaToOptionBuyerFill(niftyIdea({
      underlyingEntry: 57_189, underlyingStop: 56_900, underlyingTarget: 57_800, strikeStep: 100,
    }));

    expect(nifty.strike % 50).toBe(0);
    // The bug this replaced gave BANKNIFTY a 50-point step, producing strikes like
    // 57,150 that do not exist on the exchange.
    expect(banknifty.strike % 100).toBe(0);
    expect(banknifty.strike).toBe(57_200);
  });

  it("refuses to guess a strike interval", () => {
    for (const strikeStep of [0, -50, Number.NaN]) {
      expect(() => mapIdeaToOptionBuyerFill(niftyIdea({ strikeStep })))
        .toThrow(/Strike step/);
    }
  });

  it("produces tradable premium geometry in the option's own price space", () => {
    const fill = mapIdeaToOptionBuyerFill(niftyIdea());

    expect(fill.stopPremium).toBeLessThan(fill.fillPremium);
    expect(fill.fillPremium).toBeLessThan(fill.targetPremium);
    expect(fill.timeToExpiryYears).toBeGreaterThan(0);
    expect(fill.entryGreeks.premium).toBeGreaterThan(0);
  });

  it("rejects an idea whose stop and target are not on opposite sides of the entry", () => {
    // A long whose stop sits above the entry is not a long.
    expect(() => mapIdeaToOptionBuyerFill(niftyIdea({ underlyingStop: 24_500 })))
      .toThrow(/opposite sides/);
    // A short whose target sits above the entry is not a short.
    expect(() => mapIdeaToOptionBuyerFill(niftyIdea({
      ideaSide: "SHORT", underlyingStop: 24_600, underlyingTarget: 24_700,
    }))).toThrow(/opposite sides/);
  });

  it("refuses a worthless contract instead of inventing a band around it", () => {
    // Entry 24 points below its snapped strike with one minute to expiry: one standard
    // deviation is ~1.7 points, so the call is ~14 sigma out of the money and worth
    // nothing at both the entry and the stop. Both collapse onto the 0.05 tick floor,
    // so `stop < fill` no longer holds and no tradable geometry exists in premium space.
    //
    // This used to fabricate one -- a symmetric band of `fillPremium * 0.3` -- and
    // return it as though Black-Scholes had produced it.
    expect(() => mapIdeaToOptionBuyerFill(niftyIdea({
      underlyingEntry: 24_326,
      underlyingStop: 24_300,
      underlyingTarget: 24_600,
      strikeStep: 50,
      impliedVolatility: 0.05,
      now: new Date("2026-07-30T09:59:00.000Z"),
    }))).toThrow(/no tradable premium geometry/);
  });
});

describe("nextWeeklyExpiry", () => {
  it("returns this Thursday's close from earlier in the week", () => {
    expect(nextWeeklyExpiry(new Date("2026-07-27T04:00:00.000Z"), 4).toISOString())
      .toBe("2026-07-30T10:00:00.000Z");
  });

  it("keeps today when today is expiry day and the close has not passed", () => {
    // The bug: `(4 - day + 7) % 7 || 7` turned today's zero offset into a full week, so
    // an expiry-morning trade was priced seven days out.
    expect(nextWeeklyExpiry(new Date("2026-07-30T04:00:00.000Z"), 4).toISOString())
      .toBe("2026-07-30T10:00:00.000Z");
  });

  it("rolls to next week once expiry day's close has passed", () => {
    expect(nextWeeklyExpiry(new Date("2026-07-30T10:00:00.000Z"), 4).toISOString())
      .toBe("2026-08-06T10:00:00.000Z");
    expect(nextWeeklyExpiry(new Date("2026-07-30T11:30:00.000Z"), 4).toISOString())
      .toBe("2026-08-06T10:00:00.000Z");
  });

  it("returns the coming Thursday from a Friday, not the one just gone", () => {
    expect(nextWeeklyExpiry(new Date("2026-07-31T04:00:00.000Z"), 4).toISOString())
      .toBe("2026-08-06T10:00:00.000Z");
  });

  it("honours a different expiry weekday, since not every underlying uses Thursday", () => {
    // Tuesday from a Monday.
    expect(nextWeeklyExpiry(new Date("2026-07-27T04:00:00.000Z"), 2).toISOString())
      .toBe("2026-07-28T10:00:00.000Z");
  });

  it("rejects a weekday outside the week", () => {
    expect(() => nextWeeklyExpiry(NOW, 7)).toThrow(/weekday/);
    expect(() => nextWeeklyExpiry(NOW, -1)).toThrow(/weekday/);
  });
});

describe("resolveOptionExpiryInstant", () => {
  it("reads a date-only expiry as that day's 15:30 IST close", () => {
    // The defect this replaces: new Date("2026-08-04") is 00:00 UTC = 05:30 IST, and the
    // expiry evaluator force-closes at that instant -- before the market opens.
    expect(resolveOptionExpiryInstant("2026-08-04").toISOString())
      .toBe("2026-08-04T10:00:00.000Z");
    expect(new Date("2026-08-04").toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });

  it("keeps a full timestamp as supplied, since a caller who gave a time meant it", () => {
    expect(resolveOptionExpiryInstant("2026-08-25T09:15:00.000Z").toISOString())
      .toBe("2026-08-25T09:15:00.000Z");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveOptionExpiryInstant("  2026-08-25  ").toISOString())
      .toBe("2026-08-25T10:00:00.000Z");
  });

  it("refuses a date that does not exist rather than rolling it forward", () => {
    // Date.UTC(2026, 12, 32) silently becomes a real instant in the next year, which would
    // price a contract on a day the caller never named.
    expect(Number.isNaN(resolveOptionExpiryInstant("2026-02-30").getTime())).toBe(true);
    expect(Number.isNaN(resolveOptionExpiryInstant("2026-13-01").getTime())).toBe(true);
  });

  it("reports an unparseable expiry as NaN for the caller to reject", () => {
    expect(Number.isNaN(resolveOptionExpiryInstant("next Tuesday").getTime())).toBe(true);
    expect(Number.isNaN(resolveOptionExpiryInstant("").getTime())).toBe(true);
  });
});

describe("mapIdeaToOptionBuyerFill with an observed chain fill", () => {
  const base: OptionBuyerFillInput = {
    ideaSide: "LONG",
    underlyingEntry: 57_739.95,
    underlyingStop: 57_400,
    underlyingTarget: 58_300,
    impliedVolatility: 0.1193,
    expiryDate: new Date("2026-08-25T10:00:00.000Z"),
    now: new Date("2026-08-05T11:47:00.000Z"),
    strikeStep: 100,
  };

  it("fills at the observed price instead of the model premium", () => {
    // The measured gap this exists to close: the model said 770.22 where the book was
    // offering 752.75, so a position opened 2.9% underwater on model error alone.
    const modelled = mapIdeaToOptionBuyerFill(base);
    const observed = mapIdeaToOptionBuyerFill({
      ...base,
      observedFill: { premium: 752.75, impliedVolatility: 0.12983 },
    });

    expect(observed.fillPremium).toBe(752.75);
    expect(observed.fillSource).toBe("OPTION_CHAIN_QUOTE");
    expect(modelled.fillSource).toBe("OPTION_MODEL");
    expect(modelled.fillPremium).not.toBe(observed.fillPremium);
  });

  it("reprices stop and target on the observed IV, not the caller's estimate", () => {
    // Entry from the market and exits from a different volatility would put the two ends of
    // the same trade on different surfaces. A wider stop keeps the geometry valid across
    // both volatilities so the comparison is about IV alone; the target widens with it to
    // preserve the idea's 1.5:1 shape, because moving the stop alone leaves a 0.45:1 setup
    // that the risk-reward invariant refuses on geometry this test never meant to exercise.
    const wide = { ...base, underlyingStop: 56_500, underlyingTarget: 59_600 };
    const lower = mapIdeaToOptionBuyerFill({
      ...wide, observedFill: { premium: 752.75, impliedVolatility: 0.12 },
    });
    const higher = mapIdeaToOptionBuyerFill({
      ...wide, observedFill: { premium: 752.75, impliedVolatility: 0.15 },
    });

    // Same entry price, different surface: only the repriced exits may move.
    expect(lower.fillPremium).toBe(higher.fillPremium);
    expect(higher.stopPremium).toBeGreaterThan(lower.stopPremium);
    expect(higher.targetPremium).toBeGreaterThan(lower.targetPremium);
  });

  it("moves both barriers onto the bid basis the exit evaluator measures against", () => {
    // The defect this closes, measured across the 19 positions closed on 2026-08-14: barriers
    // carried the model's mid basis while `evaluate-open-paper-trades` compares them against the
    // observed bid. The bid sits below the mid, so a mid-basis stop was reached early and a
    // mid-basis target needed an extra half-spread — both against the position.
    const midBasis = mapIdeaToOptionBuyerFill({
      ...base, observedFill: { premium: 752.75, impliedVolatility: 0.12983 },
    });
    const bidBasis = mapIdeaToOptionBuyerFill({
      ...base,
      observedFill: { premium: 752.75, impliedVolatility: 0.12983, bid: 748.25 },
    });

    // The entry is untouched: a buyer still pays the ask.
    expect(bidBasis.fillPremium).toBe(midBasis.fillPremium);
    // Both barriers shift down by the same offset, so the stop is no longer reached early
    // and the target is no longer out of reach by the spread.
    expect(bidBasis.exitBasisOffset).toBeLessThan(0);
    expect(bidBasis.stopPremium).toBeLessThan(midBasis.stopPremium);
    expect(bidBasis.targetPremium).toBeLessThan(midBasis.targetPremium);
    // And the cost is now visible in the geometry rather than landing silently in the exit.
    expect(bidBasis.fillPremium - bidBasis.stopPremium)
      .toBeGreaterThan(midBasis.fillPremium - midBasis.stopPremium);
  });

  it("records a zero exit basis when no bid is observable", () => {
    // Without a bid the barriers stay on the model basis and the old asymmetry returns. That is
    // a real state, not an error, so it is recorded rather than hidden.
    const noBid = mapIdeaToOptionBuyerFill({
      ...base, observedFill: { premium: 752.75, impliedVolatility: 0.12983 },
    });
    expect(noBid.exitBasisOffset).toBe(0);
  });

  it("refuses premium geometry that is no longer the idea's risk model", () => {
    // Ordering alone accepts anything monotonic, which is how the 19 positions closed on
    // 2026-08-14 carried a constant 1.5:1 underlying risk-reward into premium geometry ranging
    // from 0.30:1 to 24.40:1. Two hours from expiry is the honest version of that collapse:
    // gamma dominates, and the contract stops resembling the underlying setup entirely.
    expect(() => mapIdeaToOptionBuyerFill({
      ...base,
      now: new Date("2026-08-25T08:00:00.000Z"),
      observedFill: { premium: 752.75, impliedVolatility: 0.12983, bid: 748.25 },
    })).toThrow(/risk-reward beyond 3x/);
  });

  it("admits the convexity a healthy contract genuinely has", () => {
    // The guard has to pass normal repricing or it is just a ban on options. The same setup a
    // day from expiry distorts 1.94x -- real convexity, well inside the bound.
    expect(() => mapIdeaToOptionBuyerFill({
      ...base,
      now: new Date("2026-08-24T10:00:00.000Z"),
      observedFill: { premium: 752.75, impliedVolatility: 0.12983, bid: 748.25 },
    })).not.toThrow();
  });

  it("refuses a fill and an IV that cannot describe the same market", () => {
    // Found by a test that passed the market's ask with a volatility 3 points away from the
    // one implied by it. At IV 0.16 the option is worth 809.76 at the stop level while the
    // entry paid 752.75 -- a stop-loss above the entry premium, which is not a long trade.
    // The route cannot produce this pairing, because it takes both from the same solve; the
    // guard exists so a future caller cannot either.
    expect(() => mapIdeaToOptionBuyerFill({
      ...base,
      observedFill: { premium: 752.75, impliedVolatility: 0.16 },
    })).toThrow(/no tradable premium geometry/);
  });

  it("keeps entry greeks on the observed IV so they match the position mark", () => {
    const observed = mapIdeaToOptionBuyerFill({
      ...base,
      observedFill: { premium: 752.75, impliedVolatility: 0.12983 },
    });

    expect(observed.entryGreeks.delta).toBeGreaterThan(0);
    expect(observed.entryGreeks.delta).toBeLessThan(1);
    expect(observed.entryGreeks.theta).toBeLessThan(0);
  });

  it("still refuses when the observed fill leaves no tradable geometry", () => {
    // An ask above the target premium is not a setup, and inventing a band around it is the
    // behaviour this function already refuses for the model path.
    expect(() => mapIdeaToOptionBuyerFill({
      ...base,
      observedFill: { premium: 99_999, impliedVolatility: 0.12983 },
    })).toThrow(/no tradable premium geometry/);
  });

  it("falls back to the model when no snapshot covers the contract", () => {
    const modelled = mapIdeaToOptionBuyerFill({ ...base, observedFill: undefined });

    expect(modelled.fillSource).toBe("OPTION_MODEL");
    expect(modelled.fillPremium).toBeGreaterThan(0);
  });
});
