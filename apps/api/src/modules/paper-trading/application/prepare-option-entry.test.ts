import { describe, expect, it } from "vitest";
import { PrepareOptionEntry, MINIMUM_DAYS_TO_EXPIRY } from "./prepare-option-entry.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import type { OptionExpiryCalendar } from "../../market-data/domain/option-expiry-calendar.js";

/**
 * The gates here each exist because of a defect that had already been paid for, and each is
 * invisible when missing -- the trade prices cleanly and books. So the tests that matter are
 * the refusals: a bot that can only be observed succeeding cannot be observed breaking.
 */

const NOW = new Date("2026-08-07T06:00:00.000Z");
const MONTHLY = new Date("2026-08-25T10:00:00.000Z");

function calendar(overrides: Partial<OptionExpiryCalendar> = {}): OptionExpiryCalendar {
  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers-api-v3",
    observedAt: NOW,
    // BANKNIFTY as it actually is: monthly only. Verified against the live calendar --
    // 246 listed expiries, the nearest 2026-08-25.
    expiries: [
      { expiryDate: MONTHLY, expiryKind: "MONTHLY" },
      { expiryDate: new Date("2026-09-29T10:00:00.000Z"), expiryKind: "MONTHLY" },
    ],
    ...overrides,
  };
}

function chain(overrides: Partial<OptionChainSnapshot> = {}): OptionChainSnapshot {
  const quote = {
    strikePrice: 57700,
    optionType: "CE" as const,
    expiryDate: MONTHLY,
    expiryKind: "MONTHLY" as const,
    providerSymbol: "NSE:BANKNIFTY26082557700CE",
    providerToken: null,
    lastPrice: 748,
    bid: 745,
    ask: 752,
    volume: 120_000,
    openInterest: 900_000,
    previousOpenInterest: 800_000,
    openInterestChange: 100_000,
  };
  return {
    underlyingSymbol: "BANKNIFTY",
    provider: "fyers-api-v3",
    observedAt: NOW,
    underlyingValue: 57_720,
    quotes: [
      quote,
      { ...quote, optionType: "PE" as const, bid: 500, ask: 505, lastPrice: 502, openInterest: 1_200_000 },
    ],
    listedExpiries: calendar().expiries,
    ...overrides,
  };
}

const IDEA = {
  id: "idea-1",
  side: "LONG",
  entry_price: "57720",
  stop_loss: "57300",
  target_price: "58400",
  instrument_id: "instrument-1",
  lot_size: 15,
  symbol: "BANKNIFTY",
  strike_step: "100",
  confidence: 0.75,
  reasoning: ["VOLATILITY_EXPANSION regime", "volume confirms the break"],
  source_candle_id: "candle-1",
};

interface Overrides {
  idea?: Record<string, unknown> | null;
  calendar?: OptionExpiryCalendar | null;
  snapshot?: OptionChainSnapshot | null;
  barVolume?: {
    volume: string | null;
    timeframe: string;
    nearby_volume_bars: string;
    instrument_type?: string;
    proxy_volume?: string | null;
    proxy_symbol?: string | null;
  } | null;
  scheduledEvents?: number | "error";
  premiumTick?: {
    observedAt: Date;
    bid: number | null;
    ask: number | null;
    lastPrice: number | null;
    underlyingValue: number | null;
  } | null;
}

function service(overrides: Overrides = {}) {
  const database = {
    query: async <T,>(text: string): Promise<{ rows: T[] }> => {
      if (text.includes("FROM trade_ideas")) {
        const idea = overrides.idea === undefined ? IDEA : overrides.idea;
        return { rows: (idea ? [idea] : []) as T[] };
      }
      if (text.includes("nearby_volume_bars")) {
        const bar = overrides.barVolume === undefined
          ? { volume: "150000", timeframe: "5m", nearby_volume_bars: "10000", instrument_type: "EQUITY" }
          : overrides.barVolume;
        return { rows: (bar ? [bar] : []) as T[] };
      }
      if (text.includes("FROM scheduled_macro_events")) {
        if (overrides.scheduledEvents === "error") {
          throw new Error("calendar unavailable");
        }
        return { rows: [{ count: String(overrides.scheduledEvents ?? 0) }] as T[] };
      }
      // India VIX daily close, as a percentage.
      return { rows: [{ close: "13.5" }] as T[] };
    },
  };
  const chainReader = {
    latestExpiryCalendar: async () => overrides.calendar === undefined ? calendar() : overrides.calendar,
    latestSnapshot: async () => overrides.snapshot === undefined ? chain() : overrides.snapshot,
  };
  const premiumTicks = {
    latestForContract: async () => overrides.premiumTick === undefined
      ? {
        observedAt: NOW,
        bid: 745,
        ask: 752,
        lastPrice: 748,
        underlyingValue: 57_720,
      }
      : overrides.premiumTick,
  };
  return new PrepareOptionEntry(database, chainReader, premiumTicks);
}

describe("PrepareOptionEntry - choosing the contract", () => {
  it("picks the nearest listed expiry rather than deriving one from a weekday", async () => {
    // BANKNIFTY has no weekly series. A weekday rule produces 11 Aug; the underlying lists
    // nothing before 25 Aug. Two trades were once booked on exactly that kind of date, priced
    // against a 1-day tenor when the real contract had 22, and the account reported +212%.
    const result = await service().execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.optionContract.optionExpiry.toISOString()).toBe(MONTHLY.toISOString());
  });

  it("refuses a caller-supplied expiry the provider does not list", async () => {
    const result = await service().execute({
      tradeIdeaId: "idea-1", expiryDate: "2026-08-11", now: NOW,
    });

    expect(result.approved).toBe(false);
    if (result.approved) return;
    expect(result.reason).toBe("EXPIRY_NOT_LISTED");
    expect(result.explanation).toContain("no weekly series");
  });

  it("refuses when no calendar has been collected, rather than guessing", async () => {
    const result = await service({ calendar: null }).execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "NO_CALENDAR" });
  });

  it("refuses when every listed expiry is nearer than the minimum tenor", async () => {
    // An expiry-day option is nearly all gamma: a stop derived in premium space stops
    // describing the underlying move it came from.
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const result = await service({
      calendar: calendar({ expiries: [{ expiryDate: tomorrow, expiryKind: "MONTHLY" }] }),
    }).execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "NO_EXPIRY_FAR_ENOUGH_OUT" });
    if (result.approved) return;
    expect(result.explanation).toContain(String(MINIMUM_DAYS_TO_EXPIRY));
  });

  it("refuses an instrument with no strike step instead of inferring one from price", async () => {
    const result = await service({ idea: { ...IDEA, strike_step: null } })
      .execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "NO_STRIKE_STEP" });
  });
});

describe("PrepareOptionEntry - pricing the entry", () => {
  it("fills at the observed ask, not at the model premium", async () => {
    // A buyer pays the offer. On a live BANKNIFTY 57700 CE the model said 770.22 against a
    // quoted mid of 748.25 -- Rs 329 a lot of model error before any market cost.
    const result = await service().execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.fillPrice).toBe(752);
    expect(result.entry.feeBreakdown.entryChecks).toMatchObject({
      fillSource: "OPTION_PREMIUM_TICK_ASK",
      observedAsk: 752,
      quoteObservedAt: NOW.toISOString(),
    });
  });

  it("refuses a stale chain when no fresh executable tick exists", async () => {
    // The measured failure was a model entry at 124.65 while the real ask was about 67.50.
    // A missing quote is a refusal, not permission to invent a fill.
    const stale = chain({ observedAt: new Date(NOW.getTime() - 90 * 60 * 1000) });
    const result = await service({ snapshot: stale, premiumTick: null })
      .execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "NO_FRESH_EXECUTABLE_QUOTE" });
  });

  it("uses the latest dense ask when the chain context is older", async () => {
    const olderChain = chain({ observedAt: new Date(NOW.getTime() - 15 * 60 * 1000) });
    const result = await service({ snapshot: olderChain }).execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.fillPrice).toBe(752);
    expect(result.entry.feeBreakdown.entryChecks).toMatchObject({
      fillSource: "OPTION_PREMIUM_TICK_ASK",
      quoteObservedAt: NOW.toISOString(),
    });
  });

  it("sizes in whole lots, never in units", async () => {
    // `quantity: 1` against a lot of 15 is not a small position, it is an impossible one.
    const result = await service().execute({ tradeIdeaId: "idea-1", lots: 2, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.quantity).toBe(30);
    expect(result.entry.lotSize).toBe(15);
    expect(result.entry.entryFees).toBeGreaterThan(0);
  });
});

describe("PrepareOptionEntry - the pre-trade gate", () => {
  it("refuses a wide spread and says by how much", async () => {
    const wide = chain();
    wide.quotes[0] = { ...wide.quotes[0]!, bid: 700, ask: 800 };
    const result = await service({
      snapshot: wide,
      premiumTick: {
        observedAt: NOW,
        bid: 700,
        ask: 800,
        lastPrice: 750,
        underlyingValue: 57_720,
      },
    }).execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "OPTIONS_ENTRY_REJECTED" });
    if (result.approved) return;
    expect(result.reasons?.join(" ")).toContain("Bid-Ask spread");
  });

  it("refuses falling open interest on the intended strike", async () => {
    const falling = chain();
    falling.quotes[0] = { ...falling.quotes[0]!, openInterestChange: -50_000 };
    const result = await service({ snapshot: falling }).execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "OPTIONS_ENTRY_REJECTED" });
    if (result.approved) return;
    expect(result.reasons?.join(" ")).toContain("Open interest is decreasing");
  });

  it("refuses a low-confidence idea", async () => {
    const result = await service({ idea: { ...IDEA, confidence: 0.4 } })
      .execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "OPTIONS_ENTRY_REJECTED" });
    if (result.approved) return;
    expect(result.reasons?.join(" ")).toContain("confidence is too low");
  });

  it("reports what it could not evaluate on an approved entry, not only on a refusal", async () => {
    // `isValid: true` with a non-empty unchecked list is a weaker statement than one with an
    // empty list, and a caller that cannot tell them apart is the failure this project has
    // shipped twice.
    const result = await service({ scheduledEvents: "error" })
      .execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.unchecked.join(" ")).toContain("Macro events");
  });

  it("records a verified empty calendar as checked rather than unknown", async () => {
    const result = await service({ scheduledEvents: 0 })
      .execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.unchecked.join(" ")).not.toContain("Macro events");
  });

  it("does not read a zero as absent participation when the feed itself stopped reporting", async () => {
    // The case the old "has this series ever carried volume" test got wrong. Yahoo stopped
    // supplying index 1d volume on 2026-08-01: June and July ~100% populated, all 8 August
    // bars zero. Every idea raised on one was refused for low volume -- a data outage
    // reported as a market observation. The window asks about bars near this one instead.
    const result = await service({
      idea: { ...IDEA, reasoning: ["VOLATILITY_EXPANSION regime"] },
      barVolume: { volume: "0", timeframe: "1d", nearby_volume_bars: "0" },
    }).execute({ tradeIdeaId: "idea-1", lots: 1, now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.unchecked.join(" ")).toContain("absent feed rather than absent participation");
  });

  it("still refuses a quiet bar sitting among active ones", async () => {
    // The window must not turn the check off. A zero among neighbours that traded is the
    // observation the gate exists to act on.
    const result = await service({
      idea: { ...IDEA, reasoning: ["VOLATILITY_EXPANSION regime"] },
      barVolume: { volume: "0", timeframe: "5m", nearby_volume_bars: "10000" },
    }).execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "OPTIONS_ENTRY_REJECTED" });
  });

  it("uses the exact 5m ETF proxy bar to confirm index participation", async () => {
    const result = await service({
      idea: { ...IDEA, reasoning: ["VOLATILITY_EXPANSION regime"] },
      barVolume: {
        volume: "0",
        timeframe: "5m",
        nearby_volume_bars: "0",
        instrument_type: "INDEX",
        proxy_volume: "42000",
        proxy_symbol: "BANKBEES",
      },
    }).execute({ tradeIdeaId: "idea-1", now: NOW });

    expect(result.approved).toBe(true);
    if (!result.approved) return;
    expect(result.entry.unchecked.join(" ")).not.toContain("Volume confirmation");
  });

  it("refuses an unknown trade idea", async () => {
    const result = await service({ idea: null }).execute({ tradeIdeaId: "nope", now: NOW });

    expect(result).toMatchObject({ approved: false, reason: "IDEA_NOT_FOUND" });
  });
});
