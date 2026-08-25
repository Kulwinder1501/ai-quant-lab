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

/**
 * How long a minute waits for its candlestick and price-action layers before it is captured anyway.
 *
 * `PATTERN_DETECTION_INTRADAY` runs on a quarter-hour cron and rescans the full series -- measured at
 * 5-6s per instrument on 5m and ~14s on 1m -- so a bar's features land up to roughly fifteen minutes
 * plus a pass after it closes. Twenty-five minutes clears that with slack while staying well inside
 * the session, so an ordinary day defers a few minutes and captures every one of them complete.
 *
 * There is a deadline at all because the alternative is losing the grid point permanently: the
 * pending query is scoped to the current IST session, so a minute never captured today is never
 * captured. A control marked ineligible is a hole a reader can see and reason about; a missing row
 * silently biases the matched-control population. Past the deadline the control is still written and
 * no proposals are minted from the incomplete context.
 */
const featureWaitMs = 25 * 60 * 1000;

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
      const pending = await database.query<{ close_time: Date; features_covered: boolean }>(`
        SELECT
          candle.close_time,
          -- Every timeframe this minute will be read at must be covered, not just the 1m
          -- reference: the 5m strategies read a 5m context and would be just as blind.
          --
          -- Matched by open_time rather than close_time on purpose. A sibling closing at this
          -- minute opens one span earlier, and (instrument_id, timeframe, open_time) is the unique
          -- index; the close_time form is unindexed and measured 455ms against 52ms here, because it
          -- bitmap-scanned ~73k rows per candidate minute and got worse as history grew.
          --
          -- A missing sibling must FAIL this check, not vanish from it.
          --
          -- This was an inner join until 2026-08-25, which meant an absent or not-yet-complete
          -- sibling contributed no row and bool_and simply ignored it -- a missing requirement
          -- silently became no requirement. Measured by LIVE_BACKFILL_FEATURE_PARITY_V1 on
          -- 2026-08-25: 259 of 268 mismatches were 5m, every one of them live-null against a
          -- reconstructed value. The 5m candle finalises after the capture runs, so its row dropped
          -- out, the gate passed on the 1m sibling alone, and the minute was captured blind to its
          -- 5m context. That is the same defect the coverage table exists to prevent, one level
          -- down: at candle level rather than feature level.
          --
          -- 3m is deliberately not required. No 3m series exists in this system, so requiring it was
          -- vacuous under the inner join and would block every minute under the left join. Listing a
          -- requirement the data cannot satisfy is worse than not listing it.
          --
          -- 5m is required only at a 5m boundary. Off-boundary there is legitimately no 5m context
          -- and none is read, so demanding one would defer every minute forever.
          --
          -- Both layers are matched at exact algorithm versions. An ANY test would pass on either
          -- layer alone, and ignoring the version would let the ATR price-action variant open the
          -- gate for strategies that consume the percent-mode events.
          (
            SELECT bool_and(
              sibling.id IS NOT NULL
              AND (
                SELECT count(*) FROM candle_feature_coverage coverage
                WHERE coverage.candle_id = sibling.id
                  AND (coverage.feature_layer, coverage.algorithm_version) IN (
                    ('CANDLESTICK_PATTERN', 'candlestick-v1'),
                    ('PRICE_ACTION', 'price-action-v2')
                  )
              ) = 2
            )
            FROM (VALUES
              ('1m', INTERVAL '1 minute'),
              ('5m', INTERVAL '5 minutes')
            ) AS wanted(timeframe, span)
            LEFT JOIN candles sibling
              ON sibling.instrument_id = candle.instrument_id
             AND sibling.timeframe = wanted.timeframe
             AND sibling.open_time = candle.close_time - wanted.span
             AND sibling.is_complete = TRUE
            WHERE wanted.timeframe = '1m'
               OR EXTRACT(MINUTE FROM candle.close_time AT TIME ZONE 'Asia/Kolkata')::int % 5 = 0
          ) AS features_covered
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
      let deferredForFeatures = 0;
      let capturedWithoutFeatures = 0;
      for (const row of pending.rows) {
        const featuresCovered = row.features_covered === true;
        const ageMs = Date.now() - row.close_time.getTime();
        // Deferring is the normal path and costs nothing: the minute stays pending and is captured
        // on a later tick, by which point the detection pass has run and the context is whole.
        if (!featuresCovered && ageMs < featureWaitMs) {
          deferredForFeatures += 1;
          continue;
        }
        if (!featuresCovered) capturedWithoutFeatures += 1;
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
          featureCoverage: featuresCovered ? "COMPLETE" : "INCOMPLETE",
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
        // Reported so a quiet tick is legible: "captured nothing" now has two very different causes,
        // and a persistent `capturedWithoutFeatures` means the detection job is not keeping up
        // rather than that the market was quiet.
        deferredForFeatures,
        capturedWithoutFeatures,
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
