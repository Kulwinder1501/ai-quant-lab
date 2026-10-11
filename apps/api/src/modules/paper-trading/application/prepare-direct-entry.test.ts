import { describe, expect, it } from "vitest";
import { PrepareDirectEntry } from "./prepare-direct-entry.js";
import type { MarketQuote, MarketQuoteReader } from "../../market-data/domain/market-quote.js";

const NOW = new Date("2026-09-22T10:00:00.000Z");

function ideaRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "idea-1",
    side: "LONG",
    entry_price: "4300.00",
    stop_loss: "4290.00",
    target_price: "4315.00",
    instrument_id: "instrument-1",
    lot_size: 1,
    symbol: "XAU_USD",
    tick_size: "0.01",
    ...overrides,
  };
}

function fakeDatabase(row: Record<string, unknown> | null) {
  return {
    query: async <T = Record<string, unknown>>() => ({ rows: (row ? [row] : []) as T[] }),
  };
}

function fakeQuoteReader(quote: MarketQuote | null): MarketQuoteReader {
  return {
    quoteSymbol: async () => quote,
    quoteSymbols: async () => new Map(),
  };
}

function freshQuote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: "XAU_USD",
    provider: "oanda",
    shortName: null,
    exchange: null,
    regularMarketPrice: 4302.5,
    regularMarketPreviousClose: null,
    regularMarketChange: null,
    regularMarketChangePercent: null,
    regularMarketOpen: null,
    regularMarketDayHigh: null,
    regularMarketDayLow: null,
    regularMarketVolume: null,
    regularMarketTime: new Date("2026-09-22T09:59:00.000Z"),
    ...overrides,
  };
}

describe("PrepareDirectEntry", () => {
  it("refuses an idea that does not exist", async () => {
    const prepare = new PrepareDirectEntry(fakeDatabase(null), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "missing", now: NOW });
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("IDEA_NOT_FOUND");
  });

  it("refuses when no quote is available", async () => {
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(null));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("NO_FRESH_QUOTE");
  });

  it("refuses a stale quote outside the freshness window", async () => {
    const stale = freshQuote({ regularMarketTime: new Date("2026-09-22T09:00:00.000Z") });
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(stale));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("NO_FRESH_QUOTE");
  });

  it("fills at the live quote, not the idea's stale entry price", async () => {
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.entry.fillPrice).toBe(4302.5);
      expect(result.entry.fillPrice).not.toBe(4300);
    }
  });

  it("re-derives stop/target as the idea's own risk/reward distance from the live fill", async () => {
    // idea: entry 4300, stop 4290 (risk 10), target 4315 (reward 15), LONG
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.entry.stopLossOverride).toBeCloseTo(4302.5 - 10, 2);
      expect(result.entry.targetPriceOverride).toBeCloseTo(4302.5 + 15, 2);
    }
  });

  it("mirrors the distances for a SHORT idea", async () => {
    const row = ideaRow({ side: "SHORT", entry_price: "4300.00", stop_loss: "4310.00", target_price: "4285.00" });
    const prepare = new PrepareDirectEntry(fakeDatabase(row), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.entry.side).toBe("SHORT");
      expect(result.entry.stopLossOverride).toBeCloseTo(4302.5 + 10, 2);
      expect(result.entry.targetPriceOverride).toBeCloseTo(4302.5 - 15, 2);
    }
  });

  it("charges no fees, since no cost schedule exists for this instrument", async () => {
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(true);
    if (result.approved) expect(result.entry.entryFees).toBe(0);
  });

  it("sizes quantity from lots x lot size when quantity is not supplied", async () => {
    const row = ideaRow({ lot_size: 1 });
    const prepare = new PrepareDirectEntry(fakeDatabase(row), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", lots: 2, now: NOW });
    expect(result.approved).toBe(true);
    if (result.approved) expect(result.entry.quantity).toBe(2);
  });

  it("refuses when the re-derived bracket is not valid", async () => {
    // A zero risk distance collapses stop onto entry, which must not approve.
    const row = ideaRow({ entry_price: "4300.00", stop_loss: "4300.00", target_price: "4315.00" });
    const prepare = new PrepareDirectEntry(fakeDatabase(row), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({ tradeIdeaId: "idea-1", now: NOW });
    expect(result.approved).toBe(false);
    if (!result.approved) expect(result.reason).toBe("INVALID_GEOMETRY");
  });

  it("calculates required margin at 20x leverage and approves when available margin is sufficient", async () => {
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(freshQuote()));
    // fill 4302.5, lots 1, qty 1. Notional 4302.5. 20x margin = 215.125
    const result = await prepare.execute({
      tradeIdeaId: "idea-1",
      lots: 1,
      now: NOW,
      leverage: 20,
      availableMargin: 1000,
    });
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.entry.leverage).toBe(20);
      expect(result.entry.requiredMargin).toBeCloseTo(4302.5 / 20, 2);
    }
  });

  it("refuses with INSUFFICIENT_MARGIN when required margin exceeds free margin", async () => {
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(freshQuote()));
    // fill 4302.5, lots 1, qty 1. 20x margin = 215.125. Available free margin = 100
    const result = await prepare.execute({
      tradeIdeaId: "idea-1",
      lots: 1,
      now: NOW,
      leverage: 20,
      availableMargin: 100,
    });
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toBe("INSUFFICIENT_MARGIN");
      expect(result.explanation).toContain("Required margin of $215.13");
    }
  });

  it("calculates dynamic lots based on account equity and 20x leverage cap", async () => {
    // entry 4300, stop 4290 -> risk distance 10
    // equity 100,000, 1% risk budget = 1,000. Desired qty = 1,000 / 10 = 100 units.
    // free margin 10,000 at 20x leverage -> max leverage qty = 10,000 * 20 / 4302.5 = 46.48 units.
    // min(100, 46.48) = 46 units.
    const prepare = new PrepareDirectEntry(fakeDatabase(ideaRow()), fakeQuoteReader(freshQuote()));
    const result = await prepare.execute({
      tradeIdeaId: "idea-1",
      now: NOW,
      leverage: 20,
      accountEquity: 100_000,
      availableMargin: 10_000,
      riskPercent: 1.0,
      dynamicSizing: true,
    });
    expect(result.approved).toBe(true);
    if (result.approved) {
      expect(result.entry.quantity).toBe(46);
      expect(result.entry.requiredMargin).toBeCloseTo((4302.5 * 46) / 20, 2);
    }
  });
});

