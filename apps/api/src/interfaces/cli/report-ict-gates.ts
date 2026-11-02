import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  ICT_STATE_ENGINE_VERSION,
  computeIctConfigHash,
  defaultIctEngineConfig,
} from "../../modules/technical-analysis/domain/ict/config.js";
import { formatIctGateLine, summariseIctGates, type IctGateBar } from "../../modules/strategy-engine/domain/ict-gate-report.js";
import {
  defaultIctStructureStrategyConfiguration,
  type IctStructureStrategyConfiguration,
} from "../../modules/strategy-engine/domain/ict-structure-strategy.js";
import {
  firstSweepMssGate,
  formatSweepMssGateLine,
  summariseSweepMssGates,
  type SweepMssGate,
} from "../../modules/strategy-engine/domain/ict-sweep-mss-gates.js";
import type { IctStateCompositeSnapshot } from "../../modules/technical-analysis/domain/ict/config.js";
import { DUAL_BOT_SANDBOX } from "./bot-sandboxes.js";

/**
 * Prints, for one IST trading day, why each ICT bot did or did not trade, and the ideas and trades that resulted. Read-only.
 *
 * The headline is the funnel of the model that is live (`SWEEP_MSS_RETRACE`): the first gate that stopped each bar, from "no
 * market structure shift" through "retrace has not tapped and held the OTE band" to "setup would fire". It is the strategy's own
 * conditions applied to the stored snapshot and bar, so it names the real reason. `legacyAlignmentSummary` is the older
 * pillar-alignment count, kept for continuity; version 3 does not read it, so it must not be taken as the reason for a quiet day.
 * A bot run that failed because a strategy threw is counted too: the funnel is then not what the bot saw.
 *
 * The cells are not listed here: every sandbox that allows `ict-structure-v1` on specific series is a cell, so a
 * bot added to `bot-sandboxes.ts` shows up without touching this file.
 *
 *   npm run research:ict-gates:report -- [--date YYYY-MM-DD]
 */
const ICT_STRATEGY_KEY = "ict-structure-v1";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface IctCell {
  readonly account: string;
  readonly symbol: string;
  readonly timeframe: string;
}

function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDate(argv: readonly string[]): string {
  const index = argv.indexOf("--date");
  if (index < 0) return istToday();
  const value = argv[index + 1];
  if (value === undefined || !DATE_PATTERN.test(value)) throw new Error("--date must be YYYY-MM-DD");
  return value;
}

function ictCells(): IctCell[] {
  return DUAL_BOT_SANDBOX
    .filter((sandbox) => sandbox.allowedStrategies.includes(ICT_STRATEGY_KEY))
    .flatMap((sandbox) => (sandbox.allowedSeries ?? []).map((series) => ({
      account: sandbox.name,
      symbol: series.symbol,
      timeframe: series.timeframe,
    })));
}

async function readBars(database: DatabasePool, date: string, cell: IctCell): Promise<IctGateBar[]> {
  // Only the live engine's own rows: the table also holds the previous engine version's (v2 until 2026-10-12) and
  // other configs' rows for the same bars, and on 2026-10-09 they disagreed about BANKNIFTY's bias (BEARISH vs
  // UNKNOWN). The strategy reads exactly this version and config hash, so this is what it saw.
  const result = await database.query(`
    SELECT s.alignment_status, s.bias_direction
    FROM ict_state_snapshots s
    JOIN instruments i ON i.id = s.instrument_id
    WHERE i.symbol = $1 AND s.timeframe = $2
      AND (s.bar_time AT TIME ZONE 'Asia/Kolkata')::date = $3::date
      AND s.engine_version = $4 AND s.config_hash = $5
    ORDER BY s.bar_time
  `, [cell.symbol, cell.timeframe, date, ICT_STATE_ENGINE_VERSION, computeIctConfigHash(defaultIctEngineConfig)]);
  return result.rows.map((row) => ({
    alignmentStatus: String(row.alignment_status),
    biasDirection: String(row.bias_direction),
  }));
}

async function readCounts(database: DatabasePool, date: string, cell: IctCell): Promise<{ ideas: number; trades: number }> {
  // Ideas carry no timeframe, so this is the instrument's ideas from the ICT strategy that day; each cell is a
  // different instrument today, and a second cell on the same instrument would share the figure.
  const ideas = await database.query(`
    SELECT count(*)::int AS n
    FROM trade_ideas ti
    JOIN strategy_versions sv ON sv.id = ti.strategy_version_id
    JOIN strategies st ON st.id = sv.strategy_id
    JOIN instruments i ON i.id = ti.instrument_id
    WHERE st.name ILIKE 'ICT Sweep%' AND i.symbol = $1
      AND (ti.generated_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
  `, [cell.symbol, date]);
  const trades = await database.query(`
    SELECT count(*)::int AS n
    FROM paper_trades t
    JOIN paper_accounts a ON a.id = t.account_id
    WHERE a.name = $1 AND (t.opened_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
  `, [cell.account, date]);
  return { ideas: Number(ideas.rows[0]?.n ?? 0), trades: Number(trades.rows[0]?.n ?? 0) };
}

/** What the live strategy runs with: the active stored version over the code defaults, exactly as `evaluate` merges them. */
async function readActiveConfiguration(database: DatabasePool): Promise<IctStructureStrategyConfiguration> {
  const result = await database.query(`
    SELECT sv.configuration
    FROM strategy_versions sv JOIN strategies st ON st.id = sv.strategy_id
    WHERE st.strategy_key = $1 AND sv.is_active
  `, [ICT_STRATEGY_KEY]);
  return { ...defaultIctStructureStrategyConfiguration, ...(result.rows[0]?.configuration ?? {}) };
}

async function readSweepMssGates(
  database: DatabasePool, date: string, cell: IctCell, config: IctStructureStrategyConfiguration,
): Promise<SweepMssGate[]> {
  const result = await database.query(`
    SELECT s.snapshot_payload, c.open_time, c.open, c.high, c.low, c.close
    FROM ict_state_snapshots s
    JOIN instruments i ON i.id = s.instrument_id
    JOIN candles c ON c.instrument_id = s.instrument_id AND c.timeframe = s.timeframe AND c.open_time = s.bar_time
    WHERE i.symbol = $1 AND s.timeframe = $2
      AND (s.bar_time AT TIME ZONE 'Asia/Kolkata')::date = $3::date
      AND s.engine_version = $4 AND s.config_hash = $5
    ORDER BY s.bar_time
  `, [cell.symbol, cell.timeframe, date, ICT_STATE_ENGINE_VERSION, computeIctConfigHash(defaultIctEngineConfig)]);
  return result.rows.map((row) => firstSweepMssGate(
    row.snapshot_payload as IctStateCompositeSnapshot,
    { open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), openTime: row.open_time as Date },
    config,
  ));
}

/** Bot runs that day recorded FAILED because this strategy threw on this series (see `describeStrategyFailures`). */
async function readStrategyErrorRuns(database: DatabasePool, date: string, cell: IctCell): Promise<number> {
  const result = await database.query(`
    SELECT count(*)::int AS n
    FROM scheduled_job_runs
    WHERE job_type IN ('PAPER_TRADING_BOT', 'PAPER_TRADING_BOT_DELAYED') AND status = 'FAILED'
      AND (scheduled_for AT TIME ZONE 'Asia/Kolkata')::date = $1::date
      AND error_details ILIKE '%strategy evaluation(s) threw%'
      AND error_details ILIKE $2
  `, [date, `%${ICT_STRATEGY_KEY} on ${cell.symbol} ${cell.timeframe}%`]);
  return Number(result.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  const date = parseDate(process.argv.slice(2));
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const configuration = await readActiveConfiguration(database);
    for (const cell of ictCells()) {
      const label = `${cell.symbol}/${cell.timeframe}`;
      const counts = await readCounts(database, date, cell);
      const legacy = summariseIctGates(await readBars(database, date, cell), counts);
      const funnel = summariseSweepMssGates(await readSweepMssGates(database, date, cell, configuration), {
        ...counts,
        strategyErrorRuns: await readStrategyErrorRuns(database, date, cell),
      });
      console.info(JSON.stringify({
        level: "info",
        message: "ICT gate report",
        date,
        account: cell.account,
        cell: label,
        entryModel: configuration.entryModel,
        // The funnel describes the sweep -> shift -> retrace models only; on the ALIGNMENT model the pillar count is the right reason.
        summary: configuration.entryModel === "ALIGNMENT"
          ? formatIctGateLine(date, label, legacy)
          : formatSweepMssGateLine(date, label, funnel),
        detail: configuration.entryModel === "ALIGNMENT" ? legacy : funnel,
        legacyAlignmentSummary: formatIctGateLine(date, label, legacy),
      }));
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("ICT gate report failed:", error);
  process.exitCode = 1;
});
