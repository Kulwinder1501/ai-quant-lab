import type { DatabasePool, DatabaseQueryable } from "../../infrastructure/database/database.js";
import { PostgresAiJournalRepository } from "../../infrastructure/database/repositories/postgres-ai-journal-repository.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresDashboardQueryRepository } from "../../infrastructure/database/repositories/postgres-dashboard-query-repository.js";
import { PostgresInstitutionalFlowRepository } from "../../infrastructure/database/repositories/postgres-institutional-flow-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresMarketScannerQueryRepository } from "../../infrastructure/database/repositories/postgres-market-scanner-query-repository.js";
import { PostgresModelPerformanceQueryRepository } from "../../infrastructure/database/repositories/postgres-model-performance-query-repository.js";
import { PostgresModelPredictionQueryRepository } from "../../infrastructure/database/repositories/postgres-model-prediction-query-repository.js";
import { PostgresNewsRepository } from "../../infrastructure/database/repositories/postgres-news-repository.js";
import { PostgresOffshoreDerivativeRepository } from "../../infrastructure/database/repositories/postgres-offshore-derivative-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeHistoryQueryRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-history-query-repository.js";
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
import { ClosePaperTrade } from "../../modules/paper-trading/application/close-paper-trade.js";
import { CreatePaperAccount } from "../../modules/paper-trading/application/create-paper-account.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { GetPaperAccountSummary } from "../../modules/paper-trading/application/get-paper-account-summary.js";
import { ListPaperTradeHistory } from "../../modules/paper-trading/application/list-paper-trade-history.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { AiAutonomousAgent } from "../../modules/strategy-engine/application/ai-autonomous-agent.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";

export function buildHttpDependencies(database: DatabaseQueryable) {
  // Production passes a Pool; HTTP unit tests intentionally pass only its query
  // surface. Repository constructors do not access pool lifecycle methods here.
  const pool = database as DatabasePool;
  const predictionRepository = new PostgresModelPredictionQueryRepository(pool);
  const marketScannerRepository = new PostgresMarketScannerQueryRepository(pool);
  const tradeHistoryRepository = new PostgresPaperTradeHistoryQueryRepository(pool);
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

  const evaluateOpenPaperTrades = new EvaluateOpenPaperTrades(
    paperTradeRepository,
    candleRepository,
    new PostgresIndiaVixImpliedVolatilitySource(pool),
  );

  const aiAutonomousAgent = new AiAutonomousAgent(
    pool,
    strategyContextRepository,
    tradeIdeaRepository,
    paperAccountRepository,
    paperTradeRepository,
    candleRepository,
    newsRepository,
    new PostgresAiJournalRepository(pool),
  );

  return {
    database,
    listModelPredictions: new ListModelPredictions(predictionRepository),
    getModelPrediction: new GetModelPrediction(predictionRepository),
    listWatchlist: new ListWatchlist(marketScannerRepository),
    listMarketScanner: new ListMarketScanner(marketScannerRepository),
    listPaperTradeHistory: new ListPaperTradeHistory(tradeHistoryRepository),
    listModelVersions: new ListModelVersions(modelPerformanceRepository),
    dashboardRepository,
    paperTradeRepository,
    instrumentRepository,
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
    getInstitutionalContext: new GetInstitutionalContextService(
      new PostgresInstitutionalFlowRepository(pool),
      new PostgresOffshoreDerivativeRepository(pool),
      candleRepository,
    ),
    aiAutonomousAgent,
  };
}

export type HttpDependencies = ReturnType<typeof buildHttpDependencies>;
