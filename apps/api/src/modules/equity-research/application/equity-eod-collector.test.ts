import { describe, expect, it, vi } from "vitest";
import { EquityEodCollector } from "./equity-eod-collector.js";
import { parseChartRawRecord, parseFundamentalsRawRecord } from "./parsers.js";
import type { WatchlistStockRecord, RawRecord } from "../domain/types.js";
import { createHash } from "node:crypto";

describe("EquityEodCollector and Land-First parser (Gates S2, S3, S4, S8)", () => {
  const mockStock: WatchlistStockRecord = {
    id: "stock-1",
    exchange: "NSE",
    symbol: "SUZLON",
    yahoo_symbol: "SUZLON.NS",
    display_name: "Suzlon Energy",
    currency: "INR",
    active: true,
    note: null,
    added_at: new Date(),
    removed_at: null,
    rebackfill_needed: false,
    series_version: 1,
  };

  const sampleChartBody = {
    chart: {
      result: [
        {
          meta: {
            currency: "INR",
            symbol: "SUZLON.NS",
            regularMarketPrice: 42.0,
            regularMarketTime: 1792144735,
          },
          timestamp: [1791949500, 1792035900],
          indicators: {
            quote: [
              {
                open: [40.0, 40.5],
                high: [41.0, 41.5],
                low: [39.5, 40.0],
                close: [40.8, 41.2],
                volume: [1000000, 1200000],
              },
            ],
          },
          events: {
            dividends: {
              "1138732200": { amount: 0.5, date: 1138938300 },
            },
            splits: {
              "1199125800": { date: 1200887100, numerator: 5, denominator: 1 },
            },
          },
        },
      ],
    },
  };

  const sampleFundBody = {
    timeseries: {
      result: [
        {
          meta: { type: ["annualTotalRevenue"] },
          annualTotalRevenue: [
            {
              asOfDate: "2025-03-31",
              periodType: "12M",
              currencyCode: "INR",
              reportedValue: { raw: 1000000000 },
            },
          ],
        },
      ],
    },
  };

  it("lands raw record first before parsing (Gate S2)", async () => {
    let rawSaved = false;
    let barsSavedAfterRaw = false;

    const mockRawRepo = {
      saveRawRecord: vi.fn().mockImplementation(async (r) => {
        rawSaved = true;
        return {
          id: "raw-1",
          ...r,
          requested_at: new Date(),
        };
      }),
    };

    const mockWatchlistRepo = {
      setRebackfillNeeded: vi.fn().mockResolvedValue(undefined),
      setRebackfillStatus: vi.fn().mockResolvedValue(undefined),
    };

    const mockPriceRepo = {
      hasBars: vi.fn().mockResolvedValue(false),
      saveBars: vi.fn().mockImplementation(async () => {
        barsSavedAfterRaw = rawSaved;
        return { inserted: 2, revisions: 0, unchanged: 0, restatedDates: [] };
      }),
    };

    const mockCorpRepo = {
      saveActions: vi.fn().mockResolvedValue({ inserted: 2, skipped: 0 }),
    };

    const mockFundRepo = {
      saveFacts: vi.fn().mockResolvedValue({ inserted: 1, unchanged: 0 }),
    };

    const mockQuoteRepo = {
      upsertQuote: vi.fn().mockResolvedValue(undefined),
    };

    const mockClient = {
      fetchChart: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleChartBody,
        bodySha256: "abc123hash",
        outcome: "OK",
        warnings: [],
        requestedAt: new Date(),
      }),
      fetchFundamentals: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleFundBody,
        bodySha256: "def456hash",
        outcome: "OK",
        warnings: [],
        requestedAt: new Date(),
      }),
    };

    const collector = new EquityEodCollector(
      mockWatchlistRepo as any,
      mockRawRepo as any,
      mockPriceRepo as any,
      mockCorpRepo as any,
      mockFundRepo as any,
      mockQuoteRepo as any,
      mockClient as any,
    );

    const summary = await collector.collectStock(mockStock);

    expect(summary.success).toBe(true);
    expect(mockRawRepo.saveRawRecord).toHaveBeenCalledTimes(2); // 1 for chart, 1 for fundamentals
    expect(barsSavedAfterRaw).toBe(true); // Raw was saved before bars
  });

  it("replays parsing identically from stored raw record with network disabled (Gate S2)", () => {
    const rawJson = JSON.stringify(sampleChartBody);
    const hash = createHash("sha256").update(rawJson).digest("hex");

    const storedRawRecord: RawRecord = {
      id: "stored-raw-99",
      source: "YAHOO",
      endpoint: "chart",
      symbol: "SUZLON.NS",
      requested_at: new Date(),
      http_status: 200,
      body_sha256: hash,
      body: sampleChartBody,
      outcome: "OK",
      warnings: [],
    };

    // Verify hash matches body
    expect(createHash("sha256").update(JSON.stringify(storedRawRecord.body)).digest("hex")).toBe(hash);

    // Parse once
    const parse1 = parseChartRawRecord(storedRawRecord, "stock-1");
    // Parse twice (reprocess after deleting derived rows)
    const parse2 = parseChartRawRecord(storedRawRecord, "stock-1");

    expect(parse1.priceBars).toEqual(parse2.priceBars);
    expect(parse1.corporateActions).toEqual(parse2.corporateActions);
    expect(parse1.priceBars.length).toBe(2);
    expect(parse1.priceBars[0].rawRecordId).toBe("stored-raw-99");
    expect(parse1.corporateActions.length).toBe(2); // 1 dividend, 1 split
  });

  it("ensures second identical collection run inserts 0 new rows (Gate S3 Idempotency)", async () => {
    let existingBars = 0;
    const mockWatchlistRepo = {
      setRebackfillNeeded: vi.fn().mockResolvedValue(undefined),
      setRebackfillStatus: vi.fn().mockResolvedValue(undefined),
    };
    const mockPriceRepo = {
      hasBars: vi.fn().mockImplementation(async () => existingBars > 0),
      saveBars: vi.fn().mockImplementation(async () => {
        if (existingBars === 0) {
          existingBars = 2;
          return { inserted: 2, revisions: 0, unchanged: 0, restatedDates: [] };
        }
        return { inserted: 0, revisions: 0, unchanged: 2, restatedDates: [] };
      }),
    };

    let existingActions = 0;
    const mockCorpRepo = {
      saveActions: vi.fn().mockImplementation(async () => {
        if (existingActions === 0) {
          existingActions = 2;
          return { inserted: 2, skipped: 0 };
        }
        return { inserted: 0, skipped: 2 };
      }),
    };

    let existingFacts = 0;
    const mockFundRepo = {
      saveFacts: vi.fn().mockImplementation(async () => {
        if (existingFacts === 0) {
          existingFacts = 1;
          return { inserted: 1, unchanged: 0 };
        }
        return { inserted: 0, unchanged: 1 };
      }),
    };

    const mockRawRepo = {
      saveRawRecord: vi.fn().mockImplementation(async (r) => ({ id: "raw-1", ...r })),
    };

    const mockQuoteRepo = {
      upsertQuote: vi.fn().mockResolvedValue(undefined),
    };

    const mockClient = {
      fetchChart: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleChartBody,
        outcome: "OK",
        warnings: [],
      }),
      fetchFundamentals: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleFundBody,
        outcome: "OK",
        warnings: [],
      }),
    };

    const collector = new EquityEodCollector(
      mockWatchlistRepo as any,
      mockRawRepo as any,
      mockPriceRepo as any,
      mockCorpRepo as any,
      mockFundRepo as any,
      mockQuoteRepo as any,
      mockClient as any,
    );

    // Run 1: initial backfill
    const run1 = await collector.collectStock(mockStock);
    expect(run1.barsInserted).toBe(2);
    expect(run1.actionsInserted).toBe(2);
    expect(run1.factsInserted).toBe(1);

    // Run 2: idempotent daily collection
    const run2 = await collector.collectStock(mockStock);
    expect(run2.barsInserted).toBe(0);
    expect(run2.barsUnchanged).toBe(2);
    expect(run2.actionsInserted).toBe(0);
    expect(run2.factsInserted).toBe(0);
  });

  it("triggers full re-backfill as a versioned series when an older restated bar appears (Gate S4)", async () => {
    const mockWatchlistRepo = {
      setRebackfillNeeded: vi.fn().mockResolvedValue(undefined),
      setRebackfillStatus: vi.fn().mockResolvedValue(undefined),
    };

    const mockPriceRepo = {
      hasBars: vi.fn().mockResolvedValue(true), // daily run (chartRange = 1mo)
      saveBars: vi.fn().mockResolvedValue({
        inserted: 0,
        revisions: 1,
        unchanged: 20,
        restatedDates: ["2026-10-01"], // 16 days ago > 4 days
      }),
    };

    const mockCorpRepo = {
      saveActions: vi.fn().mockResolvedValue({ inserted: 0, skipped: 2 }),
    };

    const mockFundRepo = {
      saveFacts: vi.fn().mockResolvedValue({ inserted: 0, unchanged: 1 }),
    };

    const mockRawRepo = {
      saveRawRecord: vi.fn().mockImplementation(async (r) => ({ id: "raw-1", ...r })),
      appendWarnings: vi.fn().mockResolvedValue(undefined),
    };

    const mockQuoteRepo = {
      upsertQuote: vi.fn().mockResolvedValue(undefined),
    };

    const mockClient = {
      fetchChart: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleChartBody,
        bodySha256: "hash123",
        outcome: "OK",
        warnings: [],
        requestedAt: new Date(),
      }),
      fetchFundamentals: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleFundBody,
        outcome: "OK",
        warnings: [],
        requestedAt: new Date(),
      }),
    };

    const collector = new EquityEodCollector(
      mockWatchlistRepo as any,
      mockRawRepo as any,
      mockPriceRepo as any,
      mockCorpRepo as any,
      mockFundRepo as any,
      mockQuoteRepo as any,
      mockClient as any,
    );

    const summary = await collector.collectStock(mockStock);
    expect(summary.success).toBe(true);
    // Verified: marked stock as needing rebackfill
    expect(mockWatchlistRepo.setRebackfillNeeded).toHaveBeenCalledWith("stock-1", true);
    // Verified: rebackfill executed with 'max' range
    expect(mockClient.fetchChart).toHaveBeenCalledWith("SUZLON", "NSE", "max");
    // Verified: rebackfill status updated to version 2
    expect(mockWatchlistRepo.setRebackfillStatus).toHaveBeenCalledWith("stock-1", false, 2);
  });

  it("isolates failures so one failing stock never stops other stocks (Gate S8)", async () => {
    const stock1 = { ...mockStock, id: "stock-1", symbol: "SUZLON" };
    const stock2 = { ...mockStock, id: "stock-2", symbol: "BADSYM" };
    const stock3 = { ...mockStock, id: "stock-3", symbol: "TCS" };

    const mockWatchlistRepo = {
      findActiveStocks: vi.fn().mockResolvedValue([stock1, stock2, stock3]),
    };

    const mockClient = {
      fetchChart: vi.fn().mockImplementation(async (sym: string) => {
        if (sym === "BADSYM") throw new Error("HTTP 404 Symbol Not Found");
        return {
          httpStatus: 200,
          body: sampleChartBody,
          outcome: "OK",
          warnings: [],
        };
      }),
      fetchFundamentals: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleFundBody,
        outcome: "OK",
        warnings: [],
      }),
    };

    const mockRawRepo = { saveRawRecord: vi.fn().mockResolvedValue({ id: "raw-1" }) };
    const mockPriceRepo = {
      hasBars: vi.fn().mockResolvedValue(true),
      saveBars: vi.fn().mockResolvedValue({ inserted: 2, revisions: 0, unchanged: 0 }),
    };
    const mockCorpRepo = { saveActions: vi.fn().mockResolvedValue({ inserted: 0, skipped: 0 }) };
    const mockFundRepo = { saveFacts: vi.fn().mockResolvedValue({ inserted: 0, unchanged: 0 }) };
    const mockQuoteRepo = { upsertQuote: vi.fn().mockResolvedValue(undefined) };

    const collector = new EquityEodCollector(
      mockWatchlistRepo as any,
      mockRawRepo as any,
      mockPriceRepo as any,
      mockCorpRepo as any,
      mockFundRepo as any,
      mockQuoteRepo as any,
      mockClient as any,
    );

    const result = await collector.collectAll();

    expect(result.totalStocks).toBe(3);
    expect(result.successfulStocks).toBe(2);
    expect(result.failedStocks).toBe(1);

    const badStockSummary = result.summaries.find((s) => s.symbol === "BADSYM");
    expect(badStockSummary?.success).toBe(false);
    expect(badStockSummary?.error).toContain("HTTP 404");

    const goodStockSummary = result.summaries.find((s) => s.symbol === "TCS");
    expect(goodStockSummary?.success).toBe(true);
  });

  it("actively rejects storing monthly bars as daily bars if Yahoo returns 1mo dataGranularity (Defect 1 guard)", async () => {
    const monthlyChartBody = {
      chart: {
        result: [
          {
            meta: {
              currency: "INR",
              symbol: "SUZLON.NS",
              dataGranularity: "1mo", // SILENT MONTHLY FALLBACK
            },
            timestamp: [1130716800, 1133308800],
            indicators: {
              quote: [
                {
                  open: [131.85, 161.58],
                  high: [156.33, 164.29],
                  low: [120.0, 150.0],
                  close: [156.33, 164.29],
                  volume: [176280382, 153215684],
                },
              ],
            },
          },
        ],
      },
    };

    const monthlyRawRecord: RawRecord = {
      id: "raw-monthly-1",
      source: "YAHOO",
      endpoint: "chart",
      symbol: "SUZLON.NS",
      requested_at: new Date(),
      http_status: 200,
      body_sha256: "hash123",
      body: monthlyChartBody,
      outcome: "OK",
      warnings: [],
    };

    // Parser must throw on 1mo
    expect(() => parseChartRawRecord(monthlyRawRecord, "stock-1")).toThrow(
      /Invalid dataGranularity '1mo' in chart response. Expected '1d' daily bars/,
    );

    // Collector must record failure and store zero bars
    const mockRawRepo = { saveRawRecord: vi.fn().mockResolvedValue(monthlyRawRecord) };
    const mockPriceRepo = {
      hasBars: vi.fn().mockResolvedValue(false),
      saveBars: vi.fn(),
    };
    const mockClient = {
      fetchChart: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: monthlyChartBody,
        bodySha256: "hash123",
        outcome: "OK",
        warnings: [],
        requestedAt: new Date(),
      }),
      fetchFundamentals: vi.fn().mockResolvedValue({
        httpStatus: 200,
        body: sampleFundBody,
        outcome: "OK",
        warnings: [],
        requestedAt: new Date(),
      }),
    };

    const collector = new EquityEodCollector(
      {} as any,
      mockRawRepo as any,
      mockPriceRepo as any,
      {} as any,
      { saveFacts: vi.fn().mockResolvedValue({ inserted: 0 }) } as any,
      { upsertQuote: vi.fn() } as any,
      mockClient as any,
    );

    const summary = await collector.collectStock(mockStock);
    expect(summary.success).toBe(false);
    expect(summary.error).toMatch(/Invalid dataGranularity '1mo'/);
    expect(summary.barsInserted).toBe(0);
    expect(mockPriceRepo.saveBars).not.toHaveBeenCalled();
  });
});
