import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  ICT_STATE_ENGINE_VERSION,
  computeIctConfigHash,
  defaultIctEngineConfig,
} from "../../modules/technical-analysis/domain/ict/config.js";
import { formatIctGateLine, summariseIctGates, type IctGateBar } from "../../modules/strategy-engine/domain/ict-gate-report.js";
import { DUAL_BOT_SANDBOX } from "./bot-sandboxes.js";

/**
 * Prints, for one IST trading day, why each ICT bot did or did not trade: the share of closed bars blocked by each
 * pillar, the higher-timeframe bias, and the ideas and trades that resulted. Read-only.
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

async function main(): Promise<void> {
  const date = parseDate(process.argv.slice(2));
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    for (const cell of ictCells()) {
      const label = `${cell.symbol}/${cell.timeframe}`;
      const summary = summariseIctGates(await readBars(database, date, cell), await readCounts(database, date, cell));
      console.info(JSON.stringify({
        level: "info",
        message: "ICT gate report",
        date,
        account: cell.account,
        cell: label,
        summary: formatIctGateLine(date, label, summary),
        detail: summary,
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
