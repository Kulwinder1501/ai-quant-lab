import { deriveQuoteLabel } from "../domain/state-rules.js";
import type { WatchlistStockRecord } from "../domain/types.js";
import type { PostgresEquityCorporateActionRepository } from "../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import type { PostgresEquityPriceBarRepository } from "../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import type { PostgresEquityQuoteCacheRepository } from "../infrastructure/repositories/postgres-equity-quote-cache-repository.js";
import type { PostgresEquityRawRecordRepository } from "../infrastructure/repositories/postgres-equity-raw-record-repository.js";
import type { PostgresEquitySecondaryFactRepository } from "../infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import type { PostgresEquityWatchlistRepository } from "../infrastructure/repositories/postgres-equity-watchlist-repository.js";
import type { YahooClient } from "../infrastructure/yahoo-client.js";
import { parseChartRawRecord, parseFundamentalsRawRecord } from "./parsers.js";

export interface StockCollectionSummary {
  stockId: string;
  symbol: string;
  exchange: "NSE" | "BSE";
  success: boolean;
  barsInserted: number;
  barsRestated: number;
  barsUnchanged: number;
  actionsInserted: number;
  factsInserted: number;
  error?: string;
}

export interface EodCollectionResult {
  totalStocks: number;
  successfulStocks: number;
  failedStocks: number;
  totalBarsInserted: number;
  totalBarsRestated: number;
  totalActionsInserted: number;
  totalFactsInserted: number;
  summaries: StockCollectionSummary[];
}

export class EquityEodCollector {
  constructor(
    private readonly watchlistRepo: PostgresEquityWatchlistRepository,
    private readonly rawRecordRepo: PostgresEquityRawRecordRepository,
    private readonly priceBarRepo: PostgresEquityPriceBarRepository,
    private readonly corporateActionRepo: PostgresEquityCorporateActionRepository,
    private readonly secondaryFactRepo: PostgresEquitySecondaryFactRepository,
    private readonly quoteCacheRepo: PostgresEquityQuoteCacheRepository,
    private readonly yahooClient: YahooClient,
  ) {}

  /**
   * Collects daily data for a single stock with land-first discipline.
   * If stock has no price history, collects range='max' to backfill.
   */
  async collectStock(stock: WatchlistStockRecord): Promise<StockCollectionSummary> {
    const summary: StockCollectionSummary = {
      stockId: stock.id,
      symbol: stock.symbol,
      exchange: stock.exchange,
      success: false,
      barsInserted: 0,
      barsRestated: 0,
      barsUnchanged: 0,
      actionsInserted: 0,
      factsInserted: 0,
    };

    try {
      // 1. Check if backfill is required
      const hasHistory = await this.priceBarRepo.hasBars(stock.id);
      const isRebackfillPending = stock.rebackfill_needed;
      const chartRange = !hasHistory || isRebackfillPending ? "max" : "1mo";
      const targetSeriesVersion = isRebackfillPending ? (stock.series_version ?? 1) + 1 : (stock.series_version ?? 1);

      // 2. Fetch Chart Data (bars + events)
      const chartCall = await this.yahooClient.fetchChart(stock.symbol, stock.exchange, chartRange);

      // LAND FIRST: save raw chart record
      const rawChart = await this.rawRecordRepo.saveRawRecord({
        source: "YAHOO",
        endpoint: "chart",
        symbol: stock.yahoo_symbol,
        requestedAt: chartCall.requestedAt,
        httpStatus: chartCall.httpStatus,
        bodySha256: chartCall.bodySha256,
        body: chartCall.body,
        outcome: chartCall.outcome,
        warnings: chartCall.warnings,
      });

      // PARSE LATER: if outcome is OK, extract and store bars, actions and quote cache
      if (chartCall.outcome === "OK") {
        const parsed = parseChartRawRecord(rawChart, stock.id);

        if (parsed.warnings.length > 0) {
          await this.rawRecordRepo.appendWarnings(rawChart.id, parsed.warnings);
        }

        let barResult = { inserted: 0, revisions: 0, unchanged: 0, restatedDates: [] as string[] };
        if (parsed.priceBars.length > 0) {
          barResult = await this.priceBarRepo.saveBars(parsed.priceBars, { seriesVersion: targetSeriesVersion });
          summary.barsInserted = barResult.inserted;
          summary.barsRestated = barResult.revisions;
          summary.barsUnchanged = barResult.unchanged;
        }

        let actionResult = { inserted: 0 };
        if (parsed.corporateActions.length > 0) {
          actionResult = await this.corporateActionRepo.saveActions(parsed.corporateActions);
          summary.actionsInserted = actionResult.inserted;
        }

        // Check if an older bar restatement or corporate action occurred
        if (chartRange === "1mo") {
          const now = new Date();
          const isOldRestatement = barResult.restatedDates.some((dateStr) => {
            const barDate = new Date(`${dateStr}T00:00:00Z`);
            const diffDays = Math.floor((now.getTime() - barDate.getTime()) / (1000 * 60 * 60 * 24));
            return diffDays > 4;
          });
          const hasNewSplit =
            parsed.corporateActions.some((a) => a.kind === "SPLIT") && actionResult.inserted > 0;

          if (isOldRestatement || hasNewSplit) {
            // Mark stock as needing re-backfill
            await this.watchlistRepo.setRebackfillNeeded(stock.id, true);

            // Trigger full history re-backfill as a new versioned series
            const rebackfillResult = await this.rebackfillStock(stock);
            if (rebackfillResult.success) {
              summary.barsInserted += rebackfillResult.barsInserted;
              summary.barsRestated += rebackfillResult.barsRestated;
            }
          }
        } else if (isRebackfillPending) {
          // Rebackfill completed successfully: clear flag and update series version
          await this.watchlistRepo.setRebackfillStatus(stock.id, false, targetSeriesVersion);
        }

        // Quote cache update from chart meta
        if (parsed.meta.regularMarketPrice !== undefined && parsed.meta.regularMarketTime) {
          const marketTime = new Date(parsed.meta.regularMarketTime * 1000);
          const latencySeconds = Math.max(0, Math.round((Date.now() - marketTime.getTime()) / 1000));
          const label = deriveQuoteLabel({ marketTime, isMarketOpen: false });

          await this.quoteCacheRepo.upsertQuote({
            stockId: stock.id,
            lastPrice: parsed.meta.regularMarketPrice,
            marketTime,
            label,
            latencySeconds,
          });
        }
      }

      // 3. Fetch Fundamentals
      const fundCall = await this.yahooClient.fetchFundamentals(stock.symbol, stock.exchange);

      // LAND FIRST: save raw fundamentals record
      const rawFund = await this.rawRecordRepo.saveRawRecord({
        source: "YAHOO",
        endpoint: "fundamentals",
        symbol: stock.yahoo_symbol,
        requestedAt: fundCall.requestedAt,
        httpStatus: fundCall.httpStatus,
        bodySha256: fundCall.bodySha256,
        body: fundCall.body,
        outcome: fundCall.outcome,
        warnings: fundCall.warnings,
      });

      // PARSE LATER: extract and store secondary facts
      if (fundCall.outcome === "OK") {
        const parsedFacts = parseFundamentalsRawRecord(rawFund, stock.id);
        if (parsedFacts.length > 0) {
          const factResult = await this.secondaryFactRepo.saveFacts(parsedFacts);
          summary.factsInserted = factResult.inserted;
        }
      }

      summary.success = chartCall.outcome === "OK" || fundCall.outcome === "OK";
      if (!summary.success) {
        summary.error = `Collection failed with chart=${chartCall.outcome}, fundamentals=${fundCall.outcome}`;
      }
    } catch (err: unknown) {
      summary.success = false;
      summary.error = err instanceof Error ? err.message : String(err);
    }

    return summary;
  }

  /**
   * Re-backfills the entire history for a stock as a new versioned series.
   * Land first: stores raw record, then updates price_bar with the new series version.
   */
  async rebackfillStock(
    stock: WatchlistStockRecord,
  ): Promise<{ success: boolean; barsInserted: number; barsRestated: number; error?: string }> {
    try {
      const nextVersion = (stock.series_version ?? 1) + 1;
      const chartCall = await this.yahooClient.fetchChart(stock.symbol, stock.exchange, "max");

      const rawChart = await this.rawRecordRepo.saveRawRecord({
        source: "YAHOO",
        endpoint: "chart",
        symbol: stock.yahoo_symbol,
        requestedAt: chartCall.requestedAt,
        httpStatus: chartCall.httpStatus,
        bodySha256: chartCall.bodySha256,
        body: chartCall.body,
        outcome: chartCall.outcome,
        warnings: chartCall.warnings,
      });

      if (chartCall.outcome !== "OK") {
        return {
          success: false,
          barsInserted: 0,
          barsRestated: 0,
          error: `Rebackfill fetch failed with outcome ${chartCall.outcome}`,
        };
      }

      const parsed = parseChartRawRecord(rawChart, stock.id);
      if (parsed.warnings.length > 0) {
        await this.rawRecordRepo.appendWarnings(rawChart.id, parsed.warnings);
      }

      let barsInserted = 0;
      let barsRestated = 0;
      if (parsed.priceBars.length > 0) {
        const barResult = await this.priceBarRepo.saveBars(parsed.priceBars, { seriesVersion: nextVersion });
        barsInserted = barResult.inserted;
        barsRestated = barResult.revisions;
      }

      if (parsed.corporateActions.length > 0) {
        await this.corporateActionRepo.saveActions(parsed.corporateActions);
      }

      // Re-backfill complete: clear flag and update series version
      await this.watchlistRepo.setRebackfillStatus(stock.id, false, nextVersion);

      return {
        success: true,
        barsInserted,
        barsRestated,
      };
    } catch (err: unknown) {
      return {
        success: false,
        barsInserted: 0,
        barsRestated: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Runs collection across active watchlist stocks with failure isolation (Gate S8).
   * One stock failing never halts collection of other stocks.
   */
  async collectAll(options?: { symbol?: string; exchange?: "NSE" | "BSE" }): Promise<EodCollectionResult> {
    let stocks = await this.watchlistRepo.findActiveStocks();

    if (options?.symbol) {
      stocks = stocks.filter((s) => s.symbol === options.symbol);
      if (options.exchange) {
        stocks = stocks.filter((s) => s.exchange === options.exchange);
      }
    }

    const summaries: StockCollectionSummary[] = [];
    let successfulStocks = 0;
    let failedStocks = 0;
    let totalBarsInserted = 0;
    let totalBarsRestated = 0;
    let totalActionsInserted = 0;
    let totalFactsInserted = 0;

    for (const stock of stocks) {
      // Failure isolation: individual stock error does not throw here
      const summary = await this.collectStock(stock);
      summaries.push(summary);

      if (summary.success) {
        successfulStocks++;
      } else {
        failedStocks++;
      }

      totalBarsInserted += summary.barsInserted;
      totalBarsRestated += summary.barsRestated;
      totalActionsInserted += summary.actionsInserted;
      totalFactsInserted += summary.factsInserted;
    }

    return {
      totalStocks: stocks.length,
      successfulStocks,
      failedStocks,
      totalBarsInserted,
      totalBarsRestated,
      totalActionsInserted,
      totalFactsInserted,
      summaries,
    };
  }
}
