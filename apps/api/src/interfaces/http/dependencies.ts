import type { DatabasePool, DatabaseQueryable } from "../../infrastructure/database/database.js";
import { PostgresAiJournalRepository } from "../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { FyersLiveStreamer } from "../../infrastructure/market-data/fyers-live-streamer.js";
import { LiveQuoteCache } from "../../infrastructure/market-data/live-quote-cache.js";
import { FyersQuoteClient } from "../../infrastructure/market-data/fyers-quote-client.js";
import { QuoteSessionClock, UiQuoteBudget } from "../../infrastructure/market-data/quote-guards.js";
import { PostgresFyersRequestLedger } from "../../infrastructure/database/repositories/postgres-fyers-request-ledger.js";
import { StreamFirstQuoteReader } from "../../infrastructure/market-data/stream-first-quote-reader.js";
import type { MarketQuoteReader } from "../../modules/market-data/domain/market-quote.js";
import { ProviderRoutedQuoteClient } from "../../infrastructure/market-data/provider-routed-quote-client.js";
import { OandaQuoteClient } from "../../infrastructure/market-data/oanda-quote-client.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresDashboardQueryRepository } from "../../infrastructure/database/repositories/postgres-dashboard-query-repository.js";
import { PostgresInstitutionalFlowRepository } from "../../infrastructure/database/repositories/postgres-institutional-flow-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresJournalQueryRepository } from "../../infrastructure/database/repositories/postgres-journal-query-repository.js";
import { PostgresMarketScannerQueryRepository } from "../../infrastructure/database/repositories/postgres-market-scanner-query-repository.js";
import { PostgresMarketContextReader } from "../../infrastructure/database/repositories/postgres-market-context-reader.js";
import { PostgresModelPerformanceQueryRepository } from "../../infrastructure/database/repositories/postgres-model-performance-query-repository.js";
import { PostgresModelPredictionQueryRepository } from "../../infrastructure/database/repositories/postgres-model-prediction-query-repository.js";
import { PostgresNewsRepository } from "../../infrastructure/database/repositories/postgres-news-repository.js";
import { PostgresOffshoreDerivativeRepository } from "../../infrastructure/database/repositories/postgres-offshore-derivative-repository.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeHistoryQueryRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-history-query-repository.js";
import { PostgresPaperTradeNotificationRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-notification-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { PostgresTradeIdeaRepository } from "../../infrastructure/database/repositories/postgres-trade-idea-repository.js";
import { RunBacktest } from "../../modules/backtesting/application/run-backtest.js";
import { PostgresBacktestMarketDataRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-market-data-repository.js";
import { PostgresBacktestRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-repository.js";
import { GetInstitutionalContextService } from "../../modules/market-data/application/get-institutional-context.js";
import { ListMarketScanner } from "../../modules/market-scanner/application/list-market-scanner.js";
import { ListWatchlist } from "../../modules/market-scanner/application/list-watchlist.js";
import { ListModelVersions } from "../../modules/model-performance/application/list-model-versions.js";
import { GetModelPrediction } from "../../modules/model-predictions/application/get-model-prediction.js";
import { ListModelPredictions } from "../../modules/model-predictions/application/list-model-predictions.js";
import { IngestRssNewsService } from "../../modules/news-sentiment/application/ingest-rss-news.js";
import { ListMarketNewsService } from "../../modules/news-sentiment/application/list-market-news.js";
import { CheckMacroEventsService } from "../../modules/news-sentiment/application/check-macro-events.js";
import { ClosePaperTrade } from "../../modules/paper-trading/application/close-paper-trade.js";
import { CreatePaperAccount } from "../../modules/paper-trading/application/create-paper-account.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { GetPaperAccountSummary } from "../../modules/paper-trading/application/get-paper-account-summary.js";
import { ListJournalTrades } from "../../modules/paper-trading/application/list-journal.js";
import { ListPaperTradeHistory } from "../../modules/paper-trading/application/list-paper-trade-history.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { AiAutonomousAgent } from "../../modules/strategy-engine/application/ai-autonomous-agent.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";

export interface HttpDependencyOptions {
  /**
   * Serve spot quotes from the live websocket's ticks (see stream-first-quote-reader.ts). Only a long-running
   * process should ask for this: the reader subscribes its symbols on first use, and a subscription opens the
   * Fyers socket, which keeps a short-lived CLI alive after its work is done and, on a dropped connection,
   * reconnects forever against a closed database pool. On 2026-10-19 three `run-agent-tick` processes hung that
   * way, and their sockets pushed the API's own socket into a reconnect loop every two minutes, which sent every
   * quote back to REST.
   */
  streamQuotes?: boolean;
}

export function buildHttpDependencies(database: DatabaseQueryable, options: HttpDependencyOptions = {}) {
  // Production passes a Pool; HTTP unit tests intentionally pass only its query
  // surface. Repository constructors do not access pool lifecycle methods here.
  const pool = database as DatabasePool;
  const predictionRepository = new PostgresModelPredictionQueryRepository(pool);
  const marketScannerRepository = new PostgresMarketScannerQueryRepository(pool);
  const tradeHistoryRepository = new PostgresPaperTradeHistoryQueryRepository(pool);
  const journalRepository = new PostgresJournalQueryRepository(pool);
  const paperTradeNotificationRepository = new PostgresPaperTradeNotificationRepository(pool);
  const modelPerformanceRepository = new PostgresModelPerformanceQueryRepository(pool);
  const dashboardRepository = new PostgresDashboardQueryRepository(pool);
  const paperAccountRepository = new PostgresPaperAccountRepository(pool);
  const paperTradeRepository = new PostgresPaperTradeRepository(pool);
  const candleRepository = new PostgresCandleRepository(pool);
  const instrumentRepository = new PostgresInstrumentRepository(pool);
  const tradeIdeaRepository = new PostgresTradeIdeaRepository(pool);
  const strategyVersionRepository = new PostgresStrategyVersionRepository(pool);
  const strategyContextRepository = new PostgresStrategyMarketContextRepository(pool);
  const newsRepository = new PostgresNewsRepository(pool);
  const optionPremiumTickRepository = new PostgresOptionPremiumTickRepository(pool);
  const appId = process.env.FYERS_APP_ID;
  const appSecret = process.env.FYERS_APP_SECRET;
  const fyersTokenService = appId && appSecret
    ? new FyersTokenService({
      pool,
      appId,
      appSecret,
      pin: process.env.FYERS_PIN ?? "",
    })
    : null;
  const oandaAccountId = process.env.OANDA_ACCOUNT_ID;
  const oandaAccessToken = process.env.OANDA_ACCESS_TOKEN;
  const oandaEnvironment = (process.env.OANDA_ENVIRONMENT ?? "practice") as "practice" | "trade";
  
  const oandaQuoteClient = oandaAccountId && oandaAccessToken
    ? new OandaQuoteClient({ accountId: oandaAccountId, accessToken: oandaAccessToken, environment: oandaEnvironment })
    : null;
  let fyersLiveStreamer: FyersLiveStreamer | null = null;
  if (appId && fyersTokenService) {
    fyersLiveStreamer = new FyersLiveStreamer({
      tokenService: fyersTokenService,
      appId,
    });
  }

  // Remembers the latest bid and ask the live socket has shown for each symbol, so a manual buy can be filled at
  // the price the option-chain stream is showing -- for any strike, not only the ones the collector subscribes.
  const liveQuoteCache = new LiveQuoteCache();
  if (fyersLiveStreamer) liveQuoteCache.attach(fyersLiveStreamer);

  // Spot prices come from the live socket's ticks when they are fresh, and Fyers REST only refreshes the base they are
  // laid over (previous close, open, volume). The market-watch and live-agent streams asked REST for the same few
  // symbols every 2.5 seconds per open tab; see stream-first-quote-reader.ts.
  // The API stops asking Fyers for quotes that cannot have changed (market shut) and caps what the browser may spend.
  // On 2026-10-20, a holiday, an open dashboard tab used 4,779 of the day's 5,000 requests with nothing new to show.
  const quoteSessionClock = options.streamQuotes
    ? new QuoteSessionClock(async () => {
      const result = await pool.query("SELECT holiday_date::text AS holiday FROM nse_holidays WHERE holiday_date >= CURRENT_DATE - 1");
      return (result.rows as Array<{ holiday: string }>).map((row) => row.holiday);
    })
    : null;
  const requestLedger = new PostgresFyersRequestLedger(pool);
  const uiQuoteBudget = options.streamQuotes
    ? new UiQuoteBudget(() => requestLedger.getDailyEndpointTotal(
      new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      "quotes:api",
    ))
    : null;
  const streamFirst = (inner: MarketQuoteReader): MarketQuoteReader =>
    options.streamQuotes
      ? new StreamFirstQuoteReader({
        inner,
        ticks: liveQuoteCache,
        subscriber: fyersLiveStreamer,
        ...(quoteSessionClock === null ? {} : { isSessionOpen: () => quoteSessionClock.isOpen() }),
        ...(uiQuoteBudget === null ? {} : { restBudget: uiQuoteBudget }),
        // Ten seconds between REST calls for the same symbols, so a dropped socket cannot turn open tabs into a burst.
        minRestIntervalMs: 10_000,
      })
      : inner;

  // Identical quote requests within this window share one Fyers call. The UI's live-price, market-watch and live-agent
  // polls asked for the same few symbols about 860 times in two hours on 2026-10-16.
  const QUOTE_CACHE_TTL_MS = 2_000;
  const marketQuoteClient = new ProviderRoutedQuoteClient(
    fyersTokenService && appId
      ? streamFirst(new FyersQuoteClient({ tokenService: fyersTokenService, appId, cacheTtlMs: QUOTE_CACHE_TTL_MS }))
      : null,
    undefined,
    oandaQuoteClient,
  );

  /**
   * Quote reader for the streaming panels, with retries turned off.
   *
   * In-call retries make sense for a one-shot request whose caller has nothing else to try. They
   * are waste on a poll loop that will ask again in 2.5 seconds regardless: with the default three
   * retries and the 10s backoff cap, one rate-limited poll occupied the shared poller for ~30s --
   * measured on the live stack -- so the panel got one status update per 30s instead of per tick,
   * and every retry spent more of the quote budget that caused the rate limit in the first place.
   *
   * Failing immediately is strictly better here: the next tick is the retry.
   */
  const streamingQuoteClient = new ProviderRoutedQuoteClient(
    fyersTokenService && appId
      ? streamFirst(new FyersQuoteClient({ tokenService: fyersTokenService, appId, maxRetries: 0, cacheTtlMs: QUOTE_CACHE_TTL_MS }))
      : null,
    undefined,
    oandaQuoteClient,
  );

  const evaluateOpenPaperTrades = new EvaluateOpenPaperTrades(
    paperTradeRepository,
    candleRepository,
    new PostgresIndiaVixImpliedVolatilitySource(pool),
    optionPremiumTickRepository,
  );

  const checkMacroEvents = new CheckMacroEventsService(newsRepository, pool);

  const aiAutonomousAgent = new AiAutonomousAgent(
    pool,
    strategyContextRepository,
    tradeIdeaRepository,
    paperAccountRepository,
    paperTradeRepository,
    candleRepository,
    newsRepository,
    new PostgresAiJournalRepository(pool),
    checkMacroEvents,
    { marketQuotes: marketQuoteClient },
  );


  return {
    database,
    listModelPredictions: new ListModelPredictions(predictionRepository),
    getModelPrediction: new GetModelPrediction(predictionRepository),
    listWatchlist: new ListWatchlist(marketScannerRepository),
    listMarketScanner: new ListMarketScanner(marketScannerRepository),
    listPaperTradeHistory: new ListPaperTradeHistory(tradeHistoryRepository),
    listJournalTrades: new ListJournalTrades(journalRepository),
    listModelVersions: new ListModelVersions(modelPerformanceRepository),
    dashboardRepository,
    paperTradeRepository,
    paperTradeNotificationRepository,
    optionPremiumTickRepository,
    marketQuoteClient,
    streamingQuoteClient,
    instrumentRepository,
    strategyContextRepository,
    createPaperAccount: new CreatePaperAccount(paperAccountRepository),
    getPaperAccountSummary: new GetPaperAccountSummary(paperTradeRepository),
    openPaperTrade: new OpenPaperTrade(paperTradeRepository),
    evaluateOpenPaperTrades,
    closePaperTrade: new ClosePaperTrade(paperTradeRepository),
    generateTradeIdeas: new GenerateTradeIdeas(strategyVersionRepository, strategyContextRepository, tradeIdeaRepository),
    runBacktest: new RunBacktest(
      new PostgresBacktestRepository(pool),
      new PostgresBacktestMarketDataRepository(pool),
    ),
    ingestNews: new IngestRssNewsService(newsRepository),
    listNews: new ListMarketNewsService(newsRepository),
    checkMacroEvents,
    getInstitutionalContext: new GetInstitutionalContextService(
      new PostgresInstitutionalFlowRepository(pool),
      new PostgresOffshoreDerivativeRepository(pool),
      candleRepository,
      new PostgresMarketContextReader(pool),
    ),
    optionChainRepository: new PostgresOptionChainRepository(pool),
    fyersLiveStreamer,
    liveQuoteCache,
    aiAutonomousAgent,
  };
}

export type HttpDependencies = ReturnType<typeof buildHttpDependencies>;
