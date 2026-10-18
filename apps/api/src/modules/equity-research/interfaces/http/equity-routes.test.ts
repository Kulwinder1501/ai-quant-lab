import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import { loadEnvironment } from "../../../../config/environment.js";
import { createDatabasePool } from "../../../../infrastructure/database/database.js";
import type { Pool } from "pg";
import { PostgresEquityWatchlistRepository } from "../../infrastructure/repositories/postgres-equity-watchlist-repository.js";
import { PostgresEquityPriceBarRepository } from "../../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import { PostgresEquityCorporateActionRepository } from "../../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import { PostgresEquitySecondaryFactRepository } from "../../infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import { PostgresEquityRawRecordRepository } from "../../infrastructure/repositories/postgres-equity-raw-record-repository.js";
import { PostgresEquityQuoteCacheRepository } from "../../infrastructure/repositories/postgres-equity-quote-cache-repository.js";
import { PostgresEquitySourceHealthRepository } from "../../infrastructure/repositories/postgres-equity-source-health-repository.js";
import { YahooClient } from "../../infrastructure/yahoo-client.js";
import { EquityWatchlistService } from "../../application/equity-watchlist-service.js";
import { createEquityRouter } from "./equity.routes.js";
import { errorHandler } from "../../../../interfaces/http/common/middleware.js";

describe("Equity Research HTTP Routes (Gates S1, S6, S7, S8)", () => {
  let pool: Pool;
  let server: Server;
  let baseUrl: string;

  let watchlistRepo: PostgresEquityWatchlistRepository;
  let priceBarRepo: PostgresEquityPriceBarRepository;
  let corporateActionRepo: PostgresEquityCorporateActionRepository;
  let secondaryFactRepo: PostgresEquitySecondaryFactRepository;
  let rawRecordRepo: PostgresEquityRawRecordRepository;
  let quoteCacheRepo: PostgresEquityQuoteCacheRepository;
  let sourceHealthRepo: PostgresEquitySourceHealthRepository;
  let yahooClient: YahooClient;
  let service: EquityWatchlistService;

  const TEST_SYMBOL = "TESTAPISTK";
  const TEST_SOURCE = "TEST_API_SOURCE";

  // Mock fetch handler to simulate Yahoo responses without hitting real Yahoo reliability logs
  const fetchMock = vi.fn();

  beforeAll(async () => {
    const env = loadEnvironment();
    pool = createDatabasePool(env.DATABASE_URL);

    watchlistRepo = new PostgresEquityWatchlistRepository(pool);
    priceBarRepo = new PostgresEquityPriceBarRepository(pool);
    corporateActionRepo = new PostgresEquityCorporateActionRepository(pool);
    secondaryFactRepo = new PostgresEquitySecondaryFactRepository(pool);
    rawRecordRepo = new PostgresEquityRawRecordRepository(pool);
    quoteCacheRepo = new PostgresEquityQuoteCacheRepository(pool);
    sourceHealthRepo = new PostgresEquitySourceHealthRepository(pool);

    // Defect 1 Fix: Explicitly pass test source name so tests NEVER write to live YAHOO records!
    yahooClient = new YahooClient({
      source: TEST_SOURCE,
      fetchFn: fetchMock as any,
      sourceHealthRepo,
      minIntervalMs: 0,
    });

    service = new EquityWatchlistService({
      watchlistRepo,
      priceBarRepo,
      corporateActionRepo,
      secondaryFactRepo,
      rawRecordRepo,
      quoteCacheRepo,
      sourceHealthRepo,
      yahooClient,
    });

    const app = express();
    app.use(express.json());
    app.use("/api/v1/equity", createEquityRouter(service));
    app.use(errorHandler);

    // Clean up any leftover test data before starting
    await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE symbol LIKE 'TESTAPI%'`);
    await pool.query(
      `DELETE FROM equity_research.raw_record WHERE symbol LIKE 'TESTAPI%' OR symbol LIKE 'UNKNOWN%' OR symbol LIKE 'ZZZ%' OR source = $1`,
      [TEST_SOURCE],
    );
    await pool.query(`DELETE FROM equity_research.source_call_log WHERE source = $1`, [TEST_SOURCE]);
    await pool.query(`DELETE FROM equity_research.source_health WHERE source = $1`, [TEST_SOURCE]);

    await new Promise<void>((resolvePromise) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}/api/v1/equity`;
        resolvePromise();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    // Clean up test data completely
    try {
      await pool.query(`DELETE FROM equity_research.watchlist_stock WHERE symbol LIKE 'TESTAPI%'`);
      await pool.query(
        `DELETE FROM equity_research.raw_record WHERE symbol LIKE 'TESTAPI%' OR symbol LIKE 'UNKNOWN%' OR symbol LIKE 'ZZZ%' OR source = $1`,
        [TEST_SOURCE],
      );
      await pool.query(`DELETE FROM equity_research.source_call_log WHERE source = $1`, [TEST_SOURCE]);
      await pool.query(`DELETE FROM equity_research.source_health WHERE source = $1`, [TEST_SOURCE]);
    } finally {
      await pool.end();
    }
  });



  describe("Gate S1: Identity & Input Validation", () => {
    it("rejects invalid symbols (SQL injection, lowercase, empty, >20 chars) before any network call", async () => {
      fetchMock.mockClear();

      const invalidSymbols = [
        "SUZLON;DROP",
        "suzlon",
        "",
        "A".repeat(21),
        "SUZLON/EQ",
        "SUZ$LON",
      ];

      for (const symbol of invalidSymbols) {
        const res = await fetch(`${baseUrl}/watchlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol, exchange: "NSE" }),
        });

        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.error).toBeDefined();
      }

      // Hard rule (Gate S1): Verify zero network calls were made!
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects malformed JSON payload with 400 Bad Request (Defect 7)", async () => {
      const res = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ malformed json string without closing bracket",
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Malformed JSON payload");
    });

    it("rejects unknown symbol with 404, does not store stock, and does NOT degrade health (Defect 2)", async () => {
      fetchMock.mockClear();
      fetchMock.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ chart: { error: { code: "Not Found", description: "Symbol not found" } } }),
            { status: 404 },
          ),
      );

      // Probe 3 times with unknown symbols to verify breaker does NOT trip
      for (const unknownSym of ["UNKNOWN1", "UNKNOWN2", "UNKNOWN3"]) {
        const res = await fetch(`${baseUrl}/watchlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: unknownSym, exchange: "NSE" }),
        });

        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toContain(unknownSym);

        const inDb = await watchlistRepo.findBySymbol("NSE", unknownSym);
        expect(inDb).toBeNull();
      }

      // Defect 2 verification: consecutive failures must NOT be incremented for 404s!
      const health = await sourceHealthRepo.getHealth(TEST_SOURCE, "chart");
      expect(health?.status).not.toBe("UNAVAILABLE");
      expect(health?.consecutive_failures ?? 0).toBe(0);
    });

    it("adds a valid stock, lands raw, stores bars, actions and quote", async () => {
      fetchMock.mockClear();

      const nowSec = Math.floor(Date.now() / 1000);
      const prevSec = nowSec - 86400;

      const mockChartData = {
        chart: {
          result: [
            {
              meta: {
                symbol: `${TEST_SYMBOL}.NS`,
                currency: "INR",
                regularMarketPrice: 55.4,
                regularMarketTime: nowSec,
                dataGranularity: "1d",
                longName: "Test API Stock Limited",
              },
              timestamp: [prevSec, nowSec],
              indicators: {
                quote: [
                  {
                    open: [52.0, 54.0],
                    high: [53.5, 56.0],
                    low: [51.5, 53.8],
                    close: [53.0, 55.4],
                    volume: [100000, 150000],
                  },
                ],
              },
              events: {
                dividends: {
                  [String(nowSec)]: { amount: 1.5, date: nowSec },
                },
              },
            },
          ],
        },
      };

      const mockFundData = {
        timeseries: {
          result: [
            {
              meta: { symbol: [`${TEST_SYMBOL}.NS`], type: ["annualTotalRevenue"] },
              annualTotalRevenue: [{ asOfDate: "2025-03-31", reportedValue: { raw: 2500000000 } }],
            },
          ],
        },
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/chart/")) {
          return new Response(JSON.stringify(mockChartData), { status: 200 });
        }
        return new Response(JSON.stringify(mockFundData), { status: 200 });
      });

      const res = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: TEST_SYMBOL, exchange: "NSE", note: "API integration test" }),
      });

      expect(res.status).toBe(201);
      const stock = await res.json();
      expect(stock.id).toBeDefined();
      expect(stock.symbol).toBe(TEST_SYMBOL);
      expect(stock.exchange).toBe("NSE");
      expect(stock.displayName).toBe("Test API Stock Limited");
      expect(stock.active).toBe(true);
      expect(stock.historyDepth.totalBars).toBe(2);


      const bars = await priceBarRepo.getBarsByStockId(stock.id);
      expect(bars.length).toBe(2);
      expect(Number(bars[0].close)).toBe(53.0);
      expect(Number(bars[1].close)).toBe(55.4);

      const actions = await corporateActionRepo.getActionsByStockId(stock.id);
      expect(actions.length).toBe(1);
      expect(Number(actions[0].value)).toBe(1.5);

      const quote = await quoteCacheRepo.getQuoteByStockId(stock.id);
      expect(quote).toBeDefined();
      expect(Number(quote?.last_price)).toBe(55.4);
    });

    it("rejects duplicate addition of existing stock with 409 Conflict (Gate S1)", async () => {
      fetchMock.mockClear();

      const res = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: TEST_SYMBOL, exchange: "NSE" }),
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already exists in watchlist");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps BSE and NSE listings as two separate rows, not merged (Gate S1)", async () => {
      fetchMock.mockClear();

      const nowSec = Math.floor(Date.now() / 1000);

      const mockBseChart = {
        chart: {
          result: [
            {
              meta: {
                symbol: `${TEST_SYMBOL}.BO`,
                currency: "INR",
                regularMarketPrice: 55.3,
                regularMarketTime: nowSec,
                dataGranularity: "1d",
                longName: "Test API Stock Limited (BSE)",
              },
              timestamp: [nowSec],
              indicators: {
                quote: [
                  {
                    open: [54.0],
                    high: [56.0],
                    low: [53.5],
                    close: [55.3],
                    volume: [45000],
                  },
                ],
              },
            },
          ],
        },
      };

      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/chart/")) {
          return new Response(JSON.stringify(mockBseChart), { status: 200 });
        }
        return new Response(JSON.stringify({ timeseries: { result: [] } }), { status: 200 });
      });

      const res = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: TEST_SYMBOL, exchange: "BSE" }),
      });

      expect(res.status).toBe(201);
      const bseStock = await res.json();
      expect(bseStock.exchange).toBe("BSE");
      expect(bseStock.symbol).toBe(TEST_SYMBOL);

      const nse = await watchlistRepo.findBySymbol("NSE", TEST_SYMBOL);
      const bse = await watchlistRepo.findBySymbol("BSE", TEST_SYMBOL);
      expect(nse).toBeDefined();
      expect(bse).toBeDefined();
      expect(nse?.id).not.toBe(bse?.id);
    });

    it("enforces watchlist cap (max 50 stocks)", async () => {
      vi.spyOn(watchlistRepo, "countActive").mockResolvedValueOnce(50);

      const res = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "CAPCHECK", exchange: "NSE" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("maximum 50 active stocks");
    });
  });

  describe("Watchlist Listing & Detail Endpoints", () => {
    it("GET /watchlist returns active stocks with price, change %, label, state badge and depth", async () => {
      const res = await fetch(`${baseUrl}/watchlist`);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.stocks).toBeInstanceOf(Array);
      expect(data.totalCount).toBeGreaterThanOrEqual(1);
      expect(data.sourceStatus).toBeDefined();

      const item = data.stocks.find((s: any) => s.symbol === TEST_SYMBOL && s.exchange === "NSE");
      expect(item).toBeDefined();
      expect(item.lastPrice).toBe(55.4);
      expect(typeof item.label).toBe("string");
      expect(["PREVIOUS-CLOSE", "DELAYED", "LAST-TRADED"]).toContain(item.label);
      expect(item.state).toBe("OK");
      expect(item.stateReason).toBeNull();
      expect(item.historyDepth.totalBars).toBe(2);
      expect(typeof item.hasDataGap).toBe("boolean");
      expect(item.changePercent).toBeCloseTo(4.53, 1);
    });

    it("GET /watchlist/:id/detail returns detail with latencySeconds as number and range filtering (Defects 6, 8)", async () => {
      const nse = (await watchlistRepo.findBySymbol("NSE", TEST_SYMBOL))!;

      // 1. Default request (range=1y)
      const res = await fetch(`${baseUrl}/watchlist/${nse.id}/detail`);
      expect(res.status).toBe(200);

      const detail = await res.json();
      expect(detail.stock.id).toBe(nse.id);
      expect(detail.stock.symbol).toBe(TEST_SYMBOL);
      expect(detail.quote.lastPrice).toBe(55.4);
      // Defect 6 verification: latencySeconds must be number
      expect(typeof detail.quote.latencySeconds).toBe("number");
      expect(detail.range).toBe("1y");
      expect(detail.priceBars.length).toBe(2);

      // Verify no adjclose is present in the bars payload (Gate S5)
      for (const bar of detail.priceBars) {
        expect(bar.close).toBeDefined();
        expect((bar as any).adjclose).toBeUndefined();
      }

      // Corporate actions
      expect(detail.corporateActions.length).toBe(1);
      expect(detail.corporateActions[0].kind).toBe("DIVIDEND");

      // Secondary fundamentals heading check (Checklist Gate G3)
      expect(detail.secondaryFundamentals.header).toBe("Secondary, from Yahoo, not verified");
      expect(detail.secondaryFundamentals.basisNotice).toContain("Basis (consolidated/standalone) is recorded as UNKNOWN");

      // Collection logs present
      expect(detail.collectionLogs).toBeInstanceOf(Array);
      expect(detail.collectionLogs.length).toBeGreaterThanOrEqual(1);

      // 2. Filtered request with range parameter (Defect 8)
      const resRange = await fetch(`${baseUrl}/watchlist/${nse.id}/detail?range=max`);
      expect(resRange.status).toBe(200);
      const detailRange = await resRange.json();
      expect(detailRange.range).toBe("max");
    });

    it("GET /watchlist/:id/detail returns 404 for unknown stock ID", async () => {
      const res = await fetch(`${baseUrl}/watchlist/00000000-0000-0000-0000-000000000000/detail`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("not found");
    });
  });

  describe("Soft Deletion (DELETE /watchlist/:id)", () => {
    it("soft-deletes stock, keeps history in database, returns 404 on repeat", async () => {
      const bse = (await watchlistRepo.findBySymbol("BSE", TEST_SYMBOL))!;

      const res = await fetch(`${baseUrl}/watchlist/${bse.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.message).toContain("History is preserved");

      const updated = await watchlistRepo.findById(bse.id);
      expect(updated?.active).toBe(false);
      expect(updated?.removed_at).toBeDefined();

      const bars = await priceBarRepo.getBarsByStockId(bse.id, { range: "max" });
      expect(bars.length).toBe(1);

      const repeatRes = await fetch(`${baseUrl}/watchlist/${bse.id}`, { method: "DELETE" });
      expect(repeatRes.status).toBe(404);
    });
  });

  describe("Gate S6: Localhost Binding & Security Assertions", () => {
    it("asserts that all published compose ports are strictly bound to 127.0.0.1", () => {
      const composePaths = [
        resolve(process.cwd(), "../../docker-compose.yml"),
        resolve(process.cwd(), "../../docker-compose.v2.yml"),
      ];

      for (const composePath of composePaths) {
        const content = readFileSync(composePath, "utf8");
        const portLines = content
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.startsWith("- ") && l.includes(":"));

        for (const line of portLines) {
          const match = line.match(/^-\s*["']?([^"']+)["']?$/);
          if (match) {
            const mapping = match[1];
            if (mapping.includes("/") || mapping.includes("\\")) continue;

            const parts = mapping.split(":");
            if (parts.length >= 2) {
              const hostBinding = parts.length === 3 ? parts[0] : "";
              expect(hostBinding).toBe("127.0.0.1");
            }
          }
        }
      }
    });
  });

  describe("Gate S7: Rate Discipline & 429 Cooldown", () => {
    it("handles 429 response: returns 429, sets RATE_LIMITED status, and enforces cooldown", async () => {
      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Too Many Requests" }), { status: 429 }),
      );

      const res = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "TEST429", exchange: "NSE" }),
      });

      expect(res.status).toBe(429);
      const data = await res.json();
      expect(data.error).toContain("rate limit");

      // Verify test source health was updated to RATE_LIMITED
      const health = await sourceHealthRepo.getHealth(TEST_SOURCE, "chart");
      expect(health?.status).toBe("RATE_LIMITED");

      // Next call during cooldown is blocked immediately before hitting network
      fetchMock.mockClear();
      const blockedRes = await fetch(`${baseUrl}/watchlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: "TESTBLOCKED", exchange: "NSE" }),
      });

      expect(blockedRes.status).toBe(429);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("Gate S8: Per-Stock Failure Isolation", () => {
    it("shows UNAVAILABLE with reason for failing stock while healthy stock shows OK (Defect 4)", async () => {
      // Re-enable test chart endpoint status
      await sourceHealthRepo.setStatus(TEST_SOURCE, "chart", "OK");

      // Plant a mock raw record with outcome = 'ERROR' for a failing stock
      const failedStock = await watchlistRepo.addStock({
        symbol: "TESTAPI_FAILING",
        exchange: "NSE",
        yahooSymbol: "TESTAPI_FAILING.NS",
        displayName: "Failing Stock Corp",
      });

      await rawRecordRepo.saveRawRecord({
        source: TEST_SOURCE,
        endpoint: "chart",
        symbol: "TESTAPI_FAILING.NS",
        httpStatus: 500,
        bodySha256: "fakefailsha",
        body: { error: "Symbol failed during upstream collect" },
        outcome: "ERROR",
        warnings: ["Upstream returned 500 Internal Error during daily collection"],
      });

      const res = await fetch(`${baseUrl}/watchlist`);
      expect(res.status).toBe(200);
      const data = await res.json();

      // Healthy stock TESTAPISTK shows OK
      const healthyItem = data.stocks.find((s: any) => s.symbol === TEST_SYMBOL && s.exchange === "NSE");
      expect(healthyItem.state).toBe("OK");
      expect(healthyItem.stateReason).toBeNull();

      // Failing stock TESTAPI_FAILING shows UNAVAILABLE with the specific error reason
      const failingItem = data.stocks.find((s: any) => s.symbol === "TESTAPI_FAILING" && s.exchange === "NSE");
      expect(failingItem).toBeDefined();
      expect(failingItem.state).toBe("UNAVAILABLE");
      expect(failingItem.stateReason).toContain("Upstream returned 500 Internal Error");

      // Detail endpoint also reflects per-stock failure state
      const detailRes = await fetch(`${baseUrl}/watchlist/${failedStock.id}/detail`);
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json();
      expect(detail.stock.state).toBe("UNAVAILABLE");
      expect(detail.stock.stateReason).toContain("Upstream returned 500 Internal Error");
    });
  });

  describe("Slice 1: Descriptive Trend Panel & Summary Routes (Gates T5, T6, T7, T9)", () => {
    it("includes trendSummary on each watchlist item in GET /watchlist", async () => {
      const res = await fetch(`${baseUrl}/watchlist`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.stocks)).toBe(true);

      const testStock = data.stocks.find((s: any) => s.symbol === TEST_SYMBOL);
      expect(testStock).toBeDefined();
      expect(testStock.trendSummary).toBeDefined();
      expect(testStock.trendSummary).toHaveProperty("return1M");
      expect(testStock.trendSummary).toHaveProperty("return1Y");
      expect(testStock.trendSummary).toHaveProperty("position52W");
      expect(["OK", "INSUFFICIENT_HISTORY", "NOT_MEANINGFUL", "SUSPENDED"]).toContain(
        testStock.trendSummary.state,
      );
    });

    it("returns full trend panel for a stock via GET /watchlist/:id/trend (T6, T7)", async () => {
      const stock = (await watchlistRepo.findBySymbol("NSE", TEST_SYMBOL))!;

      // Measure call log before request (T7)
      const callLogBefore = await pool.query(
        `SELECT count(*)::text as count FROM equity_research.source_call_log`,
      );
      const rawRecordsBefore = await pool.query(
        `SELECT count(*)::text as count FROM equity_research.raw_record`,
      );

      const res = await fetch(`${baseUrl}/watchlist/${stock.id}/trend`);
      expect(res.status).toBe(200);
      const data = await res.json();

      // Verify stock identity
      expect(data.stock).toBeDefined();
      expect(data.stock.id).toBe(stock.id);
      expect(data.stock.symbol).toBe(TEST_SYMBOL);
      expect(data.stock.exchange).toBe("NSE");
      expect(data.stock.active).toBe(true);

      // Verify disclaimer is present (T6)
      expect(data.disclaimer).toBe(
        "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.",
      );

      // Verify all 20 required metrics are present
      expect(data.metrics).toBeDefined();
      const requiredMetricKeys = [
        "latestClose",
        "return1M",
        "return3M",
        "return6M",
        "returnYTD",
        "return1Y",
        "sma50",
        "sma200",
        "distanceFromSma50",
        "distanceFromSma200",
        "sma50VsSma200",
        "high52W",
        "low52W",
        "position52W",
        "distanceFrom52WHigh",
        "volatility20D",
        "volatility1Y",
        "maxDrawdown1Y",
        "relativeActivity",
        "largeDailyMovesCount",
      ];
      for (const k of requiredMetricKeys) {
        expect(data.metrics[k]).toBeDefined();
        expect(data.metrics[k]).toHaveProperty("formulaId");
        expect(data.metrics[k]).toHaveProperty("formulaText");
        expect(data.metrics[k]).toHaveProperty("state");
      }

      // Verify largeDailyMoves array and trendSummary
      expect(Array.isArray(data.largeDailyMoves)).toBe(true);
      expect(data.trendSummary).toBeDefined();

      // Verify ZERO new Yahoo calls were made (T7)
      const callLogAfter = await pool.query(
        `SELECT count(*)::text as count FROM equity_research.source_call_log`,
      );
      const rawRecordsAfter = await pool.query(
        `SELECT count(*)::text as count FROM equity_research.raw_record`,
      );
      expect(callLogAfter.rows[0].count).toBe(callLogBefore.rows[0].count);
      expect(rawRecordsAfter.rows[0].count).toBe(rawRecordsBefore.rows[0].count);
    });

    it("returns 400 for an invalid UUID on GET /watchlist/:id/trend", async () => {
      const res = await fetch(`${baseUrl}/watchlist/not-a-uuid/trend`);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid stock ID");
    });

    it("returns 404 for an unknown stock ID on GET /watchlist/:id/trend", async () => {
      const randomUuid = "a0000000-0000-0000-0000-000000000000";
      const res = await fetch(`${baseUrl}/watchlist/${randomUuid}/trend`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("not found");
    });

    it("returns trend panel for an inactive/removed stock with active: false", async () => {
      // Create and remove a test stock
      const removedStock = await watchlistRepo.addStock({
        symbol: "TESTAPI_REMOVED",
        exchange: "NSE",
        yahooSymbol: "TESTAPI_REMOVED.NS",
        displayName: "Removed Stock Ltd",
      });
      await watchlistRepo.removeStock(removedStock.id);

      const res = await fetch(`${baseUrl}/watchlist/${removedStock.id}/trend`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.stock.id).toBe(removedStock.id);
      expect(data.stock.active).toBe(false);
      expect(data.disclaimer).toBeDefined();
    });

    it("answers GET /watchlist rapidly (< 500ms) with batch recent bars query (T9)", async () => {
      const start = performance.now();
      const res = await fetch(`${baseUrl}/watchlist`);
      const durationMs = performance.now() - start;

      expect(res.status).toBe(200);
      expect(durationMs).toBeLessThan(500);
    });

    it("flags staleness (isStale: true, staleDays > 4) for a stock whose last bar is older than 4 calendar days (T4)", async () => {
      const staleStock = await watchlistRepo.addStock({
        symbol: "TESTAPI_STALE",
        exchange: "NSE",
        yahooSymbol: "TESTAPI_STALE.NS",
        displayName: "Stale Stock Ltd",
      });

      await priceBarRepo.saveBars([
        {
          stockId: staleStock.id,
          barDate: "2026-09-01",
          open: 100,
          high: 105,
          low: 95,
          close: 102,
          volume: 10000,
          source: TEST_SOURCE,
        },
      ]);

      const res = await fetch(`${baseUrl}/watchlist/${staleStock.id}/trend`);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.isStale).toBe(true);
      expect(data.staleDays).toBeGreaterThan(4);
      expect(data.asOfDate).toBe("2026-09-01");
      expect(data.warnings.some((w: string) => w.includes("Price data is as of 2026-09-01"))).toBe(true);
    });
  });
});
