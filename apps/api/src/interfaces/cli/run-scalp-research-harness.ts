import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresResearchRiskSnapshotProvider } from "../../infrastructure/database/repositories/postgres-research-risk-snapshot-provider.js";
import { PostgresScalpResearchRepository } from "../../infrastructure/database/repositories/postgres-scalp-research-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { CaptureScalpResearchDecision } from "../../modules/research/scalp-harness/application/capture-research-decision.js";
import { NseMarketSession } from "../../modules/market-data/domain/nse-market-session.js";
import { getOption } from "./arguments.js";
import { requireIsolatedResearchDatabaseUrl } from "./scalp-research-database.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--catch-up-limit must be a positive integer.");
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const catchUpLimit = positiveInteger(getOption(args, "catch-up-limit"), 30);
  const symbols = (getOption(args, "instruments") ?? "NIFTY50,BANKNIFTY")
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (symbols.length === 0) throw new Error("--instruments must contain at least one NSE symbol.");
  const environment = loadEnvironment();
  const database = createDatabasePool(requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL,
    environment.SCALP_RESEARCH_DATABASE_URL,
  ));
  try {
    const instruments = [];
    const instrumentRepository = new PostgresInstrumentRepository(database);
    for (const symbol of [...new Set(symbols)]) {
      const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", symbol);
      if (!instrument) throw new Error(`NSE instrument ${symbol} is not registered.`);
      instruments.push(instrument);
    }
    const accounts = await database.query<{ id: string }>(
      "SELECT id FROM paper_accounts WHERE is_active = TRUE ORDER BY id",
    );
    const contextRepository = new PostgresStrategyMarketContextRepository(database);
    const riskProvider = new PostgresResearchRiskSnapshotProvider(database);
    const capture = new CaptureScalpResearchDecision(new PostgresScalpResearchRepository(database));
    const reports: Record<string, unknown>[] = [];
    const instrumentIds = instruments.map((item) => item.id);

    for (const instrument of instruments) {
      const latest = await contextRepository.findLatestCompleted({ instrumentId: instrument.id, timeframe: "1m" });
      if (!latest) {
        reports.push({ symbol: instrument.symbol, skipped: "NO_COMPLETED_1M_REFERENCE" });
        continue;
      }
      const pending = await database.query<{ close_time: Date }>(`
        SELECT candle.close_time
        FROM candles candle
        WHERE candle.instrument_id = $1 AND candle.timeframe = '1m' AND candle.is_complete = TRUE
          AND candle.close_time <= $2
          AND (candle.close_time AT TIME ZONE 'Asia/Kolkata')::date
            = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
          AND (candle.close_time AT TIME ZONE 'Asia/Kolkata')::time
            BETWEEN TIME '09:16:00' AND TIME '15:30:00'
          AND (SELECT COUNT(DISTINCT control.evaluation_direction)
               FROM research_scalp.control_points control
               WHERE control.source_candle_id = candle.id) < 2
        ORDER BY candle.close_time ASC
        LIMIT $3
      `, [instrument.id, latest.candle.closeTime, catchUpLimit]);
      const totals = { strategyDefinitions: 0, controls: 0, proposals: 0, opportunities: 0, riskSubjects: 0, riskDecisions: 0 };
      const capturedDecisionTimes: Date[] = [];
      for (const row of pending.rows) {
        const reference = row.close_time.getTime() === latest.candle.closeTime.getTime()
          ? latest
          : await contextRepository.findCompletedAt({
              instrumentId: instrument.id, timeframe: "1m", closeTime: row.close_time,
            });
        if (!reference) throw new Error(`Completed 1m context disappeared at ${row.close_time.toISOString()}.`);
        const contexts = [reference];
        for (const timeframe of ["3m", "5m"] as const) {
          const context = await contextRepository.findCompletedAt({
            instrumentId: instrument.id, timeframe, closeTime: reference.candle.closeTime,
          });
          if (context) contexts.push(context);
        }
        const session = new NseMarketSession().getSession(reference.candle.closeTime);
        if (!session) throw new Error(`No NSE session for completed candle ${reference.candle.id}.`);
        const accountSnapshots = [];
        for (const account of accounts.rows) {
          accountSnapshots.push({
            accountId: account.id,
            state: await riskProvider.capture({
              accountId: account.id,
              instrumentIds,
              asOf: reference.candle.closeTime,
            }),
          });
        }
        const result = await capture.execute({
          reference1mContext: reference,
          strategyContexts: contexts,
          sessionCloseAt: session.closesAt,
          tickSize: Number(instrument.tickSize),
          lotSize: instrument.lotSize,
          accountSnapshots,
        });
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += result[key];
        capturedDecisionTimes.push(reference.candle.closeTime);
      }
      reports.push({
        symbol: instrument.symbol,
        capturedDecisionCount: capturedDecisionTimes.length,
        oldestDecisionAt: capturedDecisionTimes[0] ?? null,
        newestDecisionAt: capturedDecisionTimes.at(-1) ?? null,
        catchUpLimit,
        ...totals,
      });
    }
    console.info(JSON.stringify({
      level: "info",
      message: "Physically isolated scalp research capture completed",
      executionEnabled: false,
      reports,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
