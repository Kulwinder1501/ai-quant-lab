import { describe, expect, it } from "vitest";
import {
  defaultWeeklyExpiry,
  mapIdeaToOptionBuyerFill,
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

describe("defaultWeeklyExpiry", () => {
  it("returns this Thursday's close from earlier in the week", () => {
    expect(defaultWeeklyExpiry(new Date("2026-07-27T04:00:00.000Z")).toISOString())
      .toBe("2026-07-30T10:00:00.000Z");
  });

  it("keeps today when today is expiry day and the close has not passed", () => {
    // The bug: `(4 - day + 7) % 7 || 7` turned today's zero offset into a full week, so
    // an expiry-morning trade was priced seven days out.
    expect(defaultWeeklyExpiry(new Date("2026-07-30T04:00:00.000Z")).toISOString())
      .toBe("2026-07-30T10:00:00.000Z");
  });

  it("rolls to next week once expiry day's close has passed", () => {
    expect(defaultWeeklyExpiry(new Date("2026-07-30T10:00:00.000Z")).toISOString())
      .toBe("2026-08-06T10:00:00.000Z");
    expect(defaultWeeklyExpiry(new Date("2026-07-30T11:30:00.000Z")).toISOString())
      .toBe("2026-08-06T10:00:00.000Z");
  });

  it("returns the coming Thursday from a Friday, not the one just gone", () => {
    expect(defaultWeeklyExpiry(new Date("2026-07-31T04:00:00.000Z")).toISOString())
      .toBe("2026-08-06T10:00:00.000Z");
  });

  it("honours a different expiry weekday, since not every underlying uses Thursday", () => {
    // Tuesday from a Monday.
    expect(defaultWeeklyExpiry(new Date("2026-07-27T04:00:00.000Z"), 2).toISOString())
      .toBe("2026-07-28T10:00:00.000Z");
  });

  it("rejects a weekday outside the week", () => {
    expect(() => defaultWeeklyExpiry(NOW, 7)).toThrow(/weekday/);
    expect(() => defaultWeeklyExpiry(NOW, -1)).toThrow(/weekday/);
  });
});
