import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  createStandardNseSession,
  type MarketSession,
  type SessionCandle,
} from "../../modules/research/directional-v2/domain/session-calendar.js";
import { phase29ExcludedSpecialSessionMap } from "../../modules/research/directional-v2/domain/excluded-special-sessions.js";
import { auditDirectionalCandles } from "../../modules/research/directional-v2/application/audit-directional-candles.js";
import { generateDirectionalDataset } from "../../modules/research/directional-v2/application/generate-directional-dataset.js";
import {
  FROZEN_D2_MODEL,
  FROZEN_D2_PARENT_MANIFEST_HASH,
  FROZEN_D2_TARGET,
  runD2CostStudy,
  type D2CostStudyResult,
} from "../../modules/research/directional-v2/application/run-d2-cost-study.js";
import {
  D2_EXECUTION_SCENARIOS,
  D2_HORIZON_MINUTES,
  D2_MAX_QUOTE_LAG_MS,
  D2_MINIMUM_PREMIUM_SESSIONS,
  D2_MINIMUM_RESOLVED_TRADES,
  D2_PRIMARY_ADVERSE_TICKS,
  D2_SIGNAL_TAIL_FRACTION,
  type D2PremiumTick,
} from "../../modules/research/directional-v2/domain/d2-premium-cost-gate.js";

const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL("../../../../../logs/directional-v2/", import.meta.url));
const UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;

interface CliOptions {
  readonly outputDir: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Unknown D2 argument '${argument}'. Only --output-dir=<path> is supported.`);
    values.set(match[1]!, match[2]!);
  }
  for (const key of values.keys()) {
    if (key !== "output-dir") throw new Error(`Unknown D2 option --${key}; the execution protocol is frozen.`);
  }
  return { outputDir: values.get("output-dir") ?? DEFAULT_OUTPUT_DIR };
}

async function loadCandles(database: DatabasePool, symbol: string): Promise<SessionCandle[]> {
  const result = await database.query<{
    open_time: Date;
    close_time: Date;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string | null;
  }>(`
    SELECT c.open_time, c.close_time, c.open, c.high, c.low, c.close, c.volume
    FROM candles c
    JOIN instruments i ON i.id = c.instrument_id
    WHERE i.symbol = $1
      AND c.timeframe = '1m'
      AND c.is_complete = TRUE
      AND c.source = 'fyers-api-v3'
    ORDER BY c.open_time ASC
  `, [symbol]);
  return result.rows.map((row) => ({
    openTime: new Date(row.open_time),
    closeTime: new Date(row.close_time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
  }));
}

async function loadExpectedSessions(
  database: DatabasePool,
  candles: readonly SessionCandle[],
): Promise<MarketSession[]> {
  if (candles.length === 0) return [];
  const toIstDate = (value: Date): string => (
    new Date(value.getTime() + 330 * 60_000).toISOString().slice(0, 10)
  );
  const firstDate = toIstDate(candles[0]!.openTime);
  const lastDate = toIstDate(candles[candles.length - 1]!.openTime);
  const result = await database.query<{ session_date: string }>(`
    SELECT day::date::text AS session_date
    FROM generate_series($1::date, $2::date, INTERVAL '1 day') AS dates(day)
    WHERE EXTRACT(ISODOW FROM day) BETWEEN 1 AND 5
      AND NOT EXISTS (
        SELECT 1 FROM nse_holidays holiday WHERE holiday.holiday_date = day::date
      )
    ORDER BY day ASC
  `, [firstDate, lastDate]);
  const specialSessions = phase29ExcludedSpecialSessionMap();
  return result.rows
    .filter((row) => !specialSessions.has(row.session_date))
    .map((row) => createStandardNseSession(row.session_date));
}

async function loadPremiumTicks(database: DatabasePool, symbol: string): Promise<{
  ticks: D2PremiumTick[];
  sessionDates: string[];
}> {
  const result = await database.query<{
    underlying_symbol: string;
    observed_at: Date;
    session_date: string;
    expiry_date: string;
    strike_price: string;
    option_type: "CE" | "PE";
    provider_symbol: string;
    bid: string | null;
    ask: string | null;
    underlying_value: string | null;
  }>(`
    SELECT underlying_symbol, observed_at,
           (observed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS session_date,
           expiry_date::text, strike_price, option_type, provider_symbol,
           bid, ask, underlying_value
    FROM option_premium_ticks
    WHERE underlying_symbol = $1
      AND provider = 'fyers-api-v3'
    ORDER BY observed_at ASC, provider_symbol ASC
  `, [symbol]);
  return {
    ticks: result.rows.map((row) => ({
      underlyingSymbol: row.underlying_symbol,
      observedAt: new Date(row.observed_at),
      expiryDate: row.expiry_date,
      strikePrice: Number(row.strike_price),
      optionType: row.option_type,
      providerSymbol: row.provider_symbol,
      bid: row.bid === null ? null : Number(row.bid),
      ask: row.ask === null ? null : Number(row.ask),
      underlyingValue: row.underlying_value === null ? null : Number(row.underlying_value),
    })),
    sessionDates: [...new Set(result.rows.map((row) => row.session_date))].sort(),
  };
}

async function loadLotSize(database: DatabasePool, symbol: string): Promise<number> {
  const result = await database.query<{ lot_size: string | number }>(
    "SELECT lot_size FROM instruments WHERE symbol = $1 AND is_active = TRUE LIMIT 1",
    [symbol],
  );
  const lotSize = Number(result.rows[0]?.lot_size);
  if (!Number.isInteger(lotSize) || lotSize <= 0) throw new Error(`Missing valid lot size for ${symbol}.`);
  return lotSize;
}

function overallVerdict(results: readonly D2CostStudyResult[]): "PASS" | "FAIL" | "INSUFFICIENT_DATA" {
  if (results.some((result) => result.costGate.verdict === "FAIL")) return "FAIL";
  if (results.every((result) => result.costGate.verdict === "PASS")) return "PASS";
  return "INSUFFICIENT_DATA";
}

function printResult(result: D2CostStudyResult): void {
  const gate = result.costGate;
  const primary = gate.scenarios.find((scenario) => scenario.scenario.name === gate.primaryScenario)!;
  const ci = primary.expectancy.ci95;
  console.info("======================================================================================");
  console.info(`DIRECTIONAL INTELLIGENCE V2 — D2 PREMIUM COST GATE: ${result.underlyingSymbol}`);
  console.info("======================================================================================");
  console.info(`Training: ${result.model.trainingFirstSession}..${result.model.trainingLastSession} (${result.model.trainingSampleCount} rows)`);
  console.info(`Premium sessions: ${gate.premiumSessionDates.length}; decisions: ${result.evaluatedDecisionCount}; tail signals: ${gate.signalCount}`);
  console.info(`Resolved trades: ${gate.resolvedQuotePairCount}; skips=${JSON.stringify(gate.skips)}`);
  console.info(`Primary net P&L: ₹${primary.netPnl.toFixed(2)}; fees: ₹${primary.fees.toFixed(2)}`);
  console.info(`Mean daily net premium return: ${(primary.expectancy.meanDailyR * 100).toFixed(4)}%`);
  console.info(`Day-level 95% CI: ${ci ? `[${(ci[0] * 100).toFixed(4)}%, ${(ci[1] * 100).toFixed(4)}%]` : "unavailable"}`);
  console.info(`Verdict: ${gate.verdict}${gate.verdictReasons.length ? ` — ${gate.verdictReasons.join(" ")}` : ""}`);
  console.info(`PBO: unavailable — ${gate.pboUnavailableReason}`);
  console.info("");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const manifest = {
    protocol: "directional-intelligence-v2-d2-cost-gate-v1",
    parentManifestHash: FROZEN_D2_PARENT_MANIFEST_HASH,
    candidate: { target: FROZEN_D2_TARGET, model: FROZEN_D2_MODEL, horizonMinutes: D2_HORIZON_MINUTES },
    underlyings: UNDERLYINGS,
    trainingPolicy: "per-index-history-strictly-before-first-premium-session-v1",
    signalPolicy: {
      tailFraction: D2_SIGNAL_TAIL_FRACTION,
      thresholds: "pre-evaluation-training-score-distribution",
      concurrency: "one-open-position-per-underlying",
    },
    executionPolicy: {
      entry: "first-observed-ask-at-or-after-decision",
      exit: "same-contract-first-observed-bid-at-or-after-decision-plus-30m",
      maxQuoteLagMs: D2_MAX_QUOTE_LAG_MS,
      scenarios: D2_EXECUTION_SCENARIOS,
      primaryAdverseTicksPerLeg: D2_PRIMARY_ADVERSE_TICKS,
      quantity: "one-exchange-lot",
      feeModel: "paper-trading/brokerage-calculator.ts",
    },
    evidenceGate: {
      minimumPremiumSessions: D2_MINIMUM_PREMIUM_SESSIONS,
      minimumResolvedTrades: D2_MINIMUM_RESOLVED_TRADES,
      pass: "both-indices-nonnegative-primary-net-expectancy-and-day-ci-lower-above-zero",
    },
  } as const;
  const manifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  console.info(`Frozen D2 manifest SHA-256: ${manifestHash}`);
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const results: D2CostStudyResult[] = [];
    for (const symbol of UNDERLYINGS) {
      const candles = await loadCandles(database, symbol);
      const expectedSessions = await loadExpectedSessions(database, candles);
      const audit = auditDirectionalCandles(symbol, candles, expectedSessions, {
        excludedSpecialSessions: phase29ExcludedSpecialSessionMap(),
      });
      if (!audit.ready) {
        throw new Error(`${symbol} failed its D2 index candle audit: ${audit.issues.map((issue) => issue.message).join(" | ")}`);
      }
      const premium = await loadPremiumTicks(database, symbol);
      if (premium.sessionDates.length === 0) throw new Error(`${symbol} has no real option premium sessions.`);
      const dataset = generateDirectionalDataset(symbol, candles, { marketSessions: expectedSessions });
      const result = runD2CostStudy({
        underlyingSymbol: symbol,
        dataset,
        candles,
        premiumTicks: premium.ticks,
        premiumSessionDates: premium.sessionDates,
        lotSize: await loadLotSize(database, symbol),
      });
      results.push(result);
      printResult(result);
    }

    const verdict = overallVerdict(results);
    const outputDir = resolve(options.outputDir);
    await mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = resolve(outputDir, `phase29-d2-${manifestHash.slice(0, 12)}-${timestamp}.json`);
    await writeFile(outputPath, JSON.stringify({
      manifest,
      manifestHash,
      generatedAt: new Date().toISOString(),
      verdict,
      results,
    }, null, 2), "utf8");
    console.info(`Cross-instrument D2 verdict: ${verdict}`);
    console.info(`D2 artifact written to ${outputPath}`);
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
