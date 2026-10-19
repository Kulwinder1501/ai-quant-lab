import { isValidSymbol, validateEquityIdentity } from "../domain/symbol-validator.js";
import { deriveQuoteLabel, deriveStockState } from "../domain/state-rules.js";
import type {
  EquityExchange,
  PriceQuoteLabel,
  StockHealthStatus,
  TrendSummaryItem,
  WatchlistStockItem,
  WatchlistStockRecord,
} from "../domain/types.js";
import { computeTrendPanel, getTodayIstDate } from "../domain/trend-metrics.js";
import { computeLevels } from "../domain/levels.js";
import { parseChartRawRecord, parseFundamentalsRawRecord } from "./parsers.js";
import type { PostgresEquityWatchlistRepository } from "../infrastructure/repositories/postgres-equity-watchlist-repository.js";
import type { PostgresEquityPriceBarRepository } from "../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import type { PostgresEquityCorporateActionRepository } from "../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import type { PostgresEquitySecondaryFactRepository } from "../infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import type { PostgresEquityRawRecordRepository } from "../infrastructure/repositories/postgres-equity-raw-record-repository.js";
import type { PostgresEquityQuoteCacheRepository } from "../infrastructure/repositories/postgres-equity-quote-cache-repository.js";
import type { PostgresEquitySourceHealthRepository } from "../infrastructure/repositories/postgres-equity-source-health-repository.js";
import type { YahooClient } from "../infrastructure/yahoo-client.js";

export class InvalidSymbolError extends Error {
  constructor(symbol: string) {
    super(
      `Invalid equity symbol '${symbol}'. Symbols must be 1-20 uppercase letters, numbers, hyphens or ampersands.`,
    );
    this.name = "InvalidSymbolError";
  }
}

export class WatchlistCapError extends Error {
  constructor(limit = 50) {
    super(`Watchlist cap reached: maximum ${limit} active stocks.`);
    this.name = "WatchlistCapError";
  }
}

export class DuplicateStockError extends Error {
  constructor(exchange: string, symbol: string) {
    super(`Stock '${symbol}' on exchange '${exchange}' already exists in watchlist.`);
    this.name = "DuplicateStockError";
  }
}

export class StockNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StockNotFoundError";
  }
}

export class RateLimitedError extends Error {
  constructor(message = "Yahoo Finance rate limit reached; cooldown active.") {
    super(message);
    this.name = "RateLimitedError";
  }
}

export class UpstreamDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamDataError";
  }
}

export interface EquityWatchlistServiceDependencies {
  watchlistRepo: PostgresEquityWatchlistRepository;
  priceBarRepo: PostgresEquityPriceBarRepository;
  corporateActionRepo: PostgresEquityCorporateActionRepository;
  secondaryFactRepo: PostgresEquitySecondaryFactRepository;
  rawRecordRepo: PostgresEquityRawRecordRepository;
  quoteCacheRepo: PostgresEquityQuoteCacheRepository;
  sourceHealthRepo: PostgresEquitySourceHealthRepository;
  yahooClient: YahooClient;
  nowFn?: () => Date;
}

export class EquityWatchlistService {
  private readonly nowFn: () => Date;

  constructor(private readonly deps: EquityWatchlistServiceDependencies) {
    this.nowFn = deps.nowFn ?? (() => new Date());
  }

  private formatStockItemFromData(
    stock: WatchlistStockRecord,
    sourceHealthStatus?: StockHealthStatus,
    trendSummary?: TrendSummaryItem,
    quote?: { last_price: number | string; market_time: Date; fetched_at?: Date | null; label?: PriceQuoteLabel | null } | null,
    barSummary?: {
      totalBars: number;
      firstBarDate: string | null;
      lastBarDate: string | null;
      latestClose: number | null;
      previousClose: number | null;
      hasDataGap: boolean;
    },
    lastRaw?: { outcome?: string | null; warnings?: string[] | null } | null,
  ): WatchlistStockItem {
    let lastPrice: number | null = null;
    let asOf: string | null = null;
    let label: PriceQuoteLabel | null = null;

    if (quote) {
      lastPrice = Number(quote.last_price);
      asOf = quote.market_time instanceof Date ? quote.market_time.toISOString() : new Date(quote.market_time).toISOString();
      label = deriveQuoteLabel({ marketTime: quote.market_time });
    } else if (barSummary && barSummary.latestClose !== null) {
      lastPrice = barSummary.latestClose;
      asOf = barSummary.lastBarDate ? new Date(`${barSummary.lastBarDate}T00:00:00Z`).toISOString() : null;
      label = barSummary.lastBarDate
        ? deriveQuoteLabel({ marketTime: new Date(`${barSummary.lastBarDate}T00:00:00Z`) })
        : "PREVIOUS-CLOSE";
    }

    let changePercent: number | null = null;
    if (lastPrice !== null && barSummary && barSummary.previousClose !== null && barSummary.previousClose > 0) {
      changePercent = Math.round(((lastPrice - barSummary.previousClose) / barSummary.previousClose) * 10000) / 100;
    }

    const totalBars = barSummary?.totalBars ?? 0;
    const derived = deriveStockState({
      hasBars: totalBars > 0,
      sourceHealthStatus,
      lastRawOutcome: lastRaw?.outcome as any,
      lastRawWarning: lastRaw?.warnings?.[0] ?? null,
      lastBarDate: barSummary?.lastBarDate ?? null,
      lastFetchedAt: quote?.fetched_at ?? undefined,
      rebackfillNeeded: stock.rebackfill_needed,
    });

    return {
      id: stock.id,
      symbol: stock.symbol,
      exchange: stock.exchange,
      yahooSymbol: stock.yahoo_symbol,
      displayName: stock.display_name ?? stock.symbol,
      currency: stock.currency,
      active: stock.active,
      note: stock.note,
      addedAt: stock.added_at.toISOString(),
      lastPrice,
      changePercent,
      asOf,
      label,
      state: derived.state,
      stateReason: derived.reason,
      historyDepth: {
        firstBarDate: barSummary?.firstBarDate ?? null,
        lastBarDate: barSummary?.lastBarDate ?? null,
        totalBars,
      },
      hasDataGap: barSummary?.hasDataGap ?? false,
      rebackfillNeeded: stock.rebackfill_needed ?? false,
      seriesVersion: stock.series_version ?? 1,
      trendSummary,
    };
  }

  private async formatStockItem(
    stock: WatchlistStockRecord,
    sourceHealthStatus?: StockHealthStatus,
    trendSummary?: TrendSummaryItem,
  ): Promise<WatchlistStockItem> {
    const quote = await this.deps.quoteCacheRepo.getQuoteByStockId(stock.id);
    const barSummary = await this.deps.priceBarRepo.getPriceBarSummary(stock.id);
    const lastRaw = await this.deps.rawRecordRepo.findLatestBySymbolAndEndpoint(
      stock.yahoo_symbol,
      "chart",
    );
    return this.formatStockItemFromData(
      stock,
      sourceHealthStatus,
      trendSummary,
      quote,
      barSummary,
      lastRaw,
    );
  }

  async getWatchlist() {
    const activeStocks = await this.deps.watchlistRepo.findActiveStocks();
    const sourceHealth = await this.deps.sourceHealthRepo.getHealth(
      this.deps.yahooClient.sourceName,
      "chart",
    );

    const stockIds = activeStocks.map((s) => s.id);
    const symbols = activeStocks.map((s) => s.yahoo_symbol);

    const [barsByStockId, summariesByStockId, quotesByStockId, rawBySymbol] = await Promise.all([
      this.deps.priceBarRepo.getRecentBarsForStocks(stockIds, 400),
      this.deps.priceBarRepo.getPriceBarSummariesForStocks(stockIds),
      this.deps.quoteCacheRepo.getQuotesByStockIds(stockIds),
      this.deps.rawRecordRepo.findLatestBySymbolsAndEndpoint(symbols, "chart"),
    ]);

    const todayIst = getTodayIstDate(this.nowFn());

    const items: WatchlistStockItem[] = activeStocks.map((stock) => {
      const bars = barsByStockId.get(stock.id) ?? [];
      const trend = computeTrendPanel({
        bars,
        rebackfillNeeded: stock.rebackfill_needed,
        seriesVersion: stock.series_version,
        asOfEvaluationDate: todayIst,
      });

      const quote = quotesByStockId.get(stock.id) ?? null;
      const barSummary = summariesByStockId.get(stock.id) ?? {
        totalBars: 0,
        firstBarDate: null,
        lastBarDate: null,
        latestClose: null,
        previousClose: null,
        hasDataGap: false,
      };
      const lastRaw = rawBySymbol.get(stock.yahoo_symbol) ?? null;

      return this.formatStockItemFromData(
        stock,
        sourceHealth?.status,
        trend.trendSummary,
        quote,
        barSummary,
        lastRaw,
      );
    });

    return {
      stocks: items,
      totalCount: items.length,
      sourceStatus: sourceHealth?.status ?? "UNKNOWN",
    };
  }

  async getTrend(id: string) {
    const stock = await this.deps.watchlistRepo.findById(id);
    if (!stock) {
      throw new StockNotFoundError(`Stock with ID '${id}' not found.`);
    }

    const bars = await this.deps.priceBarRepo.getRecentBars(id, 400);
    const todayIst = getTodayIstDate(this.nowFn());
    const trend = computeTrendPanel({
      bars,
      rebackfillNeeded: stock.rebackfill_needed,
      seriesVersion: stock.series_version,
      asOfEvaluationDate: todayIst,
    });

    return {
      stock: {
        id: stock.id,
        symbol: stock.symbol,
        exchange: stock.exchange,
        yahooSymbol: stock.yahoo_symbol,
        displayName: stock.display_name ?? stock.symbol,
        active: stock.active,
        seriesVersion: stock.series_version ?? 1,
        rebackfillNeeded: stock.rebackfill_needed ?? false,
      },
      asOfDate: trend.asOfDate,
      isStale: trend.isStale,
      staleDays: trend.staleDays,
      rebackfillNeeded: trend.rebackfillNeeded,
      seriesVersion: trend.seriesVersion,
      metrics: trend.metrics,
      largeDailyMoves: trend.largeDailyMoves,
      trendSummary: trend.trendSummary,
      disclaimer: trend.disclaimer,
      warnings: trend.warnings,
    };
  }

  async getLevels(id: string) {
    const stock = await this.deps.watchlistRepo.findById(id);
    if (!stock) {
      throw new StockNotFoundError(`Stock with ID '${id}' not found.`);
    }

    const bars = await this.deps.priceBarRepo.getRecentBars(id, 600);
    const todayIst = getTodayIstDate(this.nowFn());
    const levelsResult = computeLevels({
      bars,
      rebackfillNeeded: stock.rebackfill_needed,
      seriesVersion: stock.series_version,
      asOfEvaluationDate: todayIst,
    });

    return {
      stock: {
        id: stock.id,
        symbol: stock.symbol,
        exchange: stock.exchange,
        yahooSymbol: stock.yahoo_symbol,
        displayName: stock.display_name ?? stock.symbol,
        active: stock.active,
        seriesVersion: stock.series_version ?? 1,
        rebackfillNeeded: stock.rebackfill_needed ?? false,
      },
      asOfDate: levelsResult.asOfDate,
      isStale: levelsResult.isStale,
      staleDays: levelsResult.staleDays,
      rebackfillNeeded: levelsResult.rebackfillNeeded,
      seriesVersion: levelsResult.seriesVersion,
      state: levelsResult.state,
      atr14: levelsResult.atr14,
      atrPercent: levelsResult.atrPercent,
      levels: levelsResult.levels,
      nearestSupport: levelsResult.nearestSupport,
      nearestResistance: levelsResult.nearestResistance,
      riskDistanceAtr: levelsResult.riskDistanceAtr,
      warnings: levelsResult.warnings,
      disclaimer: levelsResult.disclaimer,
      empiricalNote: levelsResult.empiricalNote,
      formulas: levelsResult.formulas,
    };
  }

  async addStock(input: { symbol: string; exchange: EquityExchange; note?: string }) {
    // 1. Validation before ANY network call (Gate S1)
    if (!isValidSymbol(input.symbol)) {
      throw new InvalidSymbolError(input.symbol);
    }

    const { symbol, exchange, yahooSymbol } = validateEquityIdentity(input.symbol, input.exchange);

    // 2. Watchlist capacity check (Gate S1: cap 50 active stocks)
    const activeCount = await this.deps.watchlistRepo.countActive();
    if (activeCount >= 50) {
      throw new WatchlistCapError(50);
    }

    // 3. Duplicate check (Gate S1: duplicate rejected; BSE and NSE listings not merged)
    const existing = await this.deps.watchlistRepo.findBySymbol(exchange, symbol);
    if (existing && existing.active) {
      throw new DuplicateStockError(exchange, symbol);
    }

    // 4. Validate by a real chart call (Gate S1)
    let chartCall;
    try {
      chartCall = await this.deps.yahooClient.fetchChart(symbol, exchange, "max");
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes("cooling down") ||
          err.message.includes("rate-limit") ||
          err.message.includes("budget exceeded"))
      ) {
        throw new RateLimitedError(err.message);
      }
      throw new UpstreamDataError(
        err instanceof Error ? err.message : "Failed to fetch chart data from Yahoo Finance.",
      );
    }

    // Land raw chart record FIRST (Gate S2)
    const rawChart = await this.deps.rawRecordRepo.saveRawRecord({
      source: this.deps.yahooClient.sourceName,
      endpoint: "chart",
      symbol: yahooSymbol,
      requestedAt: chartCall.requestedAt,
      httpStatus: chartCall.httpStatus,
      bodySha256: chartCall.bodySha256,
      body: chartCall.body,
      outcome: chartCall.outcome,
      warnings: chartCall.warnings,
    });

    if (chartCall.outcome !== "OK") {
      if (chartCall.outcome === "RATE_LIMITED") {
        throw new RateLimitedError();
      }
      if (chartCall.httpStatus === 404) {
        throw new StockNotFoundError(
          `Symbol '${symbol}' not found on Yahoo Finance for exchange '${exchange}'.`,
        );
      }
      throw new UpstreamDataError(
        `Failed to fetch market data from Yahoo Finance (HTTP ${chartCall.httpStatus}).`,
      );
    }

    const body = chartCall.body as any;
    const result = body?.chart?.result?.[0];
    if (!result) {
      throw new StockNotFoundError(
        `Symbol '${symbol}' returned no chart data on Yahoo Finance for exchange '${exchange}'.`,
      );
    }

    // Parse chart data
    const parsed = parseChartRawRecord(rawChart, "pending");
    if (parsed.warnings.length > 0) {
      await this.deps.rawRecordRepo.appendWarnings(rawChart.id, parsed.warnings);
    }

    const displayName = parsed.meta.longName || parsed.meta.shortName || symbol;
    const currency = parsed.meta.currency || "INR";

    // Add stock to watchlist
    const stock = await this.deps.watchlistRepo.addStock({
      exchange,
      symbol,
      yahooSymbol,
      displayName,
      currency,
      note: input.note ?? null,
    });

    // Save initial price bars and corporate actions
    if (parsed.priceBars.length > 0) {
      const barsWithId = parsed.priceBars.map((b) => ({ ...b, stockId: stock.id }));
      await this.deps.priceBarRepo.saveBars(barsWithId);
    }

    if (parsed.corporateActions.length > 0) {
      const actionsWithId = parsed.corporateActions.map((a) => ({ ...a, stockId: stock.id }));
      await this.deps.corporateActionRepo.saveActions(actionsWithId);
    }

    // Update quote cache from chart meta if available
    if (parsed.meta.regularMarketPrice !== undefined && parsed.meta.regularMarketTime) {
      const marketTime = new Date(parsed.meta.regularMarketTime * 1000);
      const latencySeconds = Math.max(0, Math.round((Date.now() - marketTime.getTime()) / 1000));
      const label = deriveQuoteLabel({ marketTime });

      await this.deps.quoteCacheRepo.upsertQuote({
        stockId: stock.id,
        lastPrice: parsed.meta.regularMarketPrice,
        marketTime,
        label,
        latencySeconds,
      });
    }

    // Fetch initial fundamentals (best effort, isolated)
    try {
      const fundCall = await this.deps.yahooClient.fetchFundamentals(symbol, exchange);
      const rawFund = await this.deps.rawRecordRepo.saveRawRecord({
        source: this.deps.yahooClient.sourceName,
        endpoint: "fundamentals",
        symbol: yahooSymbol,
        requestedAt: fundCall.requestedAt,
        httpStatus: fundCall.httpStatus,
        bodySha256: fundCall.bodySha256,
        body: fundCall.body,
        outcome: fundCall.outcome,
        warnings: fundCall.warnings,
      });

      if (fundCall.outcome === "OK") {
        const parsedFund = parseFundamentalsRawRecord(rawFund, stock.id);
        if (parsedFund.length > 0) {
          await this.deps.secondaryFactRepo.saveFacts(parsedFund);
        }
      }
    } catch {
      // Best effort isolation: fundamentals failure does not break stock addition
    }

    const sourceHealth = await this.deps.sourceHealthRepo.getHealth(
      this.deps.yahooClient.sourceName,
      "chart",
    );
    const initialBars = await this.deps.priceBarRepo.getRecentBars(stock.id, 400);
    const initialTrend = computeTrendPanel({
      bars: initialBars,
      rebackfillNeeded: stock.rebackfill_needed,
      seriesVersion: stock.series_version,
      asOfEvaluationDate: getTodayIstDate(this.nowFn()),
    });
    return await this.formatStockItem(stock, sourceHealth?.status, initialTrend.trendSummary);
  }


  async removeStock(id: string) {
    const stock = await this.deps.watchlistRepo.findById(id);
    if (!stock || !stock.active) {
      throw new StockNotFoundError(`Stock with ID '${id}' not found in active watchlist.`);
    }

    const removed = await this.deps.watchlistRepo.removeStock(id);
    return {
      success: removed,
      id,
      message: `Stock '${stock.symbol}' removed from watchlist. History is preserved in the database.`,
    };
  }

  async getStockDetail(
    id: string,
    options?: {
      range?: "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max";
      limit?: number;
    },
  ) {
    const stock = await this.deps.watchlistRepo.findById(id);
    if (!stock) {
      throw new StockNotFoundError(`Stock with ID '${id}' not found.`);
    }

    const quote = await this.deps.quoteCacheRepo.getQuoteByStockId(id);
    const range = options?.range ?? "1y";
    const bars = await this.deps.priceBarRepo.getBarsByStockId(id, {
      range,
      limit: options?.limit,
    });
    const actions = await this.deps.corporateActionRepo.getActionsByStockId(id);
    const revisions = await this.deps.priceBarRepo.getRevisionsByStockId(id);
    const facts = await this.deps.secondaryFactRepo.getFactsByStockId(id);
    const recentLogs = await this.deps.rawRecordRepo.findBySymbol(stock.yahoo_symbol, 20);
    const barSummary = await this.deps.priceBarRepo.getPriceBarSummary(id);
    const sourceHealth = await this.deps.sourceHealthRepo.getHealth("YAHOO", "chart");
    const lastRaw = await this.deps.rawRecordRepo.findLatestBySymbolAndEndpoint(
      stock.yahoo_symbol,
      "chart",
    );

    const derived = deriveStockState({
      hasBars: barSummary.totalBars > 0,
      sourceHealthStatus: sourceHealth?.status,
      lastRawOutcome: lastRaw?.outcome,
      lastRawWarning: lastRaw?.warnings?.[0] ?? null,
      lastBarDate: barSummary.lastBarDate,
      lastFetchedAt: quote?.fetched_at,
    });

    return {
      stock: {
        id: stock.id,
        symbol: stock.symbol,
        exchange: stock.exchange,
        yahooSymbol: stock.yahoo_symbol,
        displayName: stock.display_name,
        currency: stock.currency,
        active: stock.active,
        note: stock.note,
        addedAt: stock.added_at.toISOString(),
        removedAt: stock.removed_at?.toISOString() ?? null,
        state: derived.state,
        stateReason: derived.reason,
      },
      quote: quote
        ? {
            lastPrice: Number(quote.last_price),
            marketTime: quote.market_time.toISOString(),
            fetchedAt: quote.fetched_at.toISOString(),
            label: deriveQuoteLabel({ marketTime: quote.market_time }),
            latencySeconds:
              quote.latency_seconds !== null && quote.latency_seconds !== undefined
                ? Math.round(Number(quote.latency_seconds))
                : null,
          }
        : null,
      range,
      summary: {
        totalBars: barSummary.totalBars,
        firstBarDate: barSummary.firstBarDate,
        lastBarDate: barSummary.lastBarDate,
        latestClose: barSummary.latestClose,
        previousClose: barSummary.previousClose,
        hasDataGap: barSummary.hasDataGap,
      },
      priceBars: bars.map((b) => ({
        barDate: b.bar_date,
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
        volume: Number(b.volume),
        source: b.source,
      })),
      corporateActions: actions.map((a) => ({
        exDate: a.ex_date,
        kind: a.kind,
        value: Number(a.value),
        source: a.source,
      })),
      secondaryFundamentals: {
        header: "Secondary, from Yahoo, not verified",
        basisNotice:
          "Basis (consolidated/standalone) is recorded as UNKNOWN because Yahoo does not report basis.",
        facts: facts.map((f) => ({
          item: f.item,
          periodType: f.period_type,
          periodEnd: f.period_end,
          value: Number(f.value),
          currency: f.currency,
          basis: f.basis,
          firstSeenAt: f.first_seen_at.toISOString(),
        })),
      },
      revisions: revisions.map((r) => ({
        barDate: r.bar_date,
        previousValues: r.previous_values,
        newValues: r.new_values,
        seenAt: r.seen_at.toISOString(),
      })),
      collectionLogs: recentLogs.map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        symbol: r.symbol,
        requestedAt: r.requested_at.toISOString(),
        httpStatus: r.http_status,
        outcome: r.outcome,
        warnings: r.warnings,
      })),
    };
  }

  async getSourceHealth() {
    const health = await this.deps.sourceHealthRepo.getAllHealth();
    const recentLogs = await this.deps.sourceHealthRepo.getRecentLogs(50);
    return {
      sources: health,
      recentCallLogs: recentLogs,
    };
  }
}
