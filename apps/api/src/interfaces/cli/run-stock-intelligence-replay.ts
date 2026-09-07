import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStockIntelligenceStore } from "../../infrastructure/database/repositories/postgres-stock-intelligence-store.js";
import { RunHistoricalReplay } from "../../modules/stock-intelligence/application/run-historical-replay.js";
import {
  buildReplayPairs,
  HISTORICAL_REPLAY_WINDOW_FROM,
  HISTORICAL_REPLAY_WINDOW_TO,
  monthlyMonthEndCutoffs,
} from "../../modules/stock-intelligence/domain/replay.js";
import { getOption, parseDateOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const from = parseDateOption(getOption(argumentsList, "from") ?? HISTORICAL_REPLAY_WINDOW_FROM, false);
  const to = parseDateOption(getOption(argumentsList, "to") ?? HISTORICAL_REPLAY_WINDOW_TO, true);
  const jobId = getOption(argumentsList, "job-id");
  const batchSizeRaw = getOption(argumentsList, "batch-size");
  const interruptRaw = getOption(argumentsList, "interrupt-after");
  const limitRaw = getOption(argumentsList, "limit-pairs");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const store = new PostgresStockIntelligenceStore(database);
    const instruments = new PostgresInstrumentRepository(database);
    const nifty50 = await instruments.findByExchangeAndSymbol("NSE", "NIFTY50");
    const indiaVix = await instruments.findByExchangeAndSymbol("NSE", "INDIAVIX");
    const memberships = await store.listAllMemberships(["NIFTY50"]);
    const instrumentIds = [...new Set(memberships.map((row) => row.instrumentId))];
    const asOfDates = monthlyMonthEndCutoffs(from, to);
    let pairs = buildReplayPairs(instrumentIds, asOfDates);
    if (limitRaw) pairs = pairs.slice(0, Number(limitRaw));

    const result = await new RunHistoricalReplay(store).execute({
      pairs,
      windowFrom: from.toISOString().slice(0, 10),
      windowTo: to.toISOString().slice(0, 10),
      jobId,
      batchSize: batchSizeRaw ? Number(batchSizeRaw) : undefined,
      interruptAfter: interruptRaw ? Number(interruptRaw) : undefined,
      indexInstrumentId: nifty50?.id,
      vixInstrumentId: indiaVix?.id,
      scopeToInputPairs: Boolean(jobId),
    });

    console.info(JSON.stringify({
      level: "info",
      message: "Stock Intelligence historical replay",
      method: "historical_replay_backtest",
      windowFrom: from.toISOString(),
      windowTo: to.toISOString(),
      instrumentCount: instrumentIds.length,
      monthCount: asOfDates.length,
      pairCount: pairs.length,
      jobId: result.job.jobId,
      jobStatus: result.job.status,
      remaining: result.job.remainingPairs.length,
      verification: result.summary,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
