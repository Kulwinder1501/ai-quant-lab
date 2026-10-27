import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandidateLedgerRepository } from "../../infrastructure/database/repositories/postgres-candidate-ledger-repository.js";
import { isHealSessionActive } from "../../modules/market-data/application/scan-oanda-gaps.js";
import { followThrough, reanchorBracket } from "../../modules/paper-trading/domain/gold-follow-through.js";
import type { CompletedPriceCandle } from "../../modules/paper-trading/domain/paper-trade-exit-policy.js";
import type { TradeSide } from "../../modules/strategy-engine/domain/strategy.js";
import { getOption } from "./arguments.js";

/**
 * Resolves gold shadow ideas by following each bracket to its target or stop, with no time window.
 *
 * The regular candidate sweep (`research:settle-candidates`) stops at an idea's own `expires_at`, about
 * ten minutes for a gold scalp, and records "no hit yet" as UNRESOLVED -- which the Gold Shadow Ledger
 * showed as EXPIRED. A paper position is held until it hits a level, so this follows the bracket on 1m bars
 * for as long as it takes:
 *
 *  - TARGET / STOP are written to `candidate_settlements` (upgrading an UNRESOLVED or UNSETTLEABLE row, never
 *    touching one that is already TARGET or STOP).
 *  - Ideas still running are left alone and reported OPEN.
 *  - Ideas with in-session minutes missing from the bars (the machine was asleep) before any touch are
 *    DEFERRED_GAP: no verdict until `data:heal-gold-gaps` fills the hole, then the next run resolves them.
 *    Safe to run any time, any number of times.
 *
 * Fill model -- what the live gold bot does (`PrepareDirectEntry`): the position is entered at the live price
 * when the idea is acted on, and the stop and target keep the idea's own risk and reward DISTANCES from that
 * fill. So the entry here is the last 1m close at the moment the idea was generated (not the idea's own
 * entry_price, which can be minutes stale), and bars before that moment are never read -- a level touched
 * before the idea existed cannot count. Prices are mid, not bid/ask: spread (~0.4 on gold) is not charged.
 *
 * Dry-run by default. `--apply` writes. Usage:
 *   resolve-gold-shadow [--apply] [--max-age-days 30] [--limit 1000] [--strategies momentum-scalp-gold,ict-structure-v1]
 */

const MINUTE_MS = 60_000;
const DEFAULT_STRATEGIES = ["momentum-scalp-gold", "ict-structure-v1", "gold-asian-sweep-v1"];

interface IdeaRow {
  id: string;
  generated_at: Date;
  side: TradeSide;
  entry_price: string;
  stop_loss: string;
  target_price: string;
  strategy: string;
  existing_outcome: string | null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const maxAgeDays = Number(getOption(argv, "max-age-days") ?? "30");
  const limit = Number(getOption(argv, "limit") ?? "1000");
  const strategies = (getOption(argv, "strategies") ?? DEFAULT_STRATEGIES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  if (![maxAgeDays, limit].every((n) => Number.isFinite(n) && n > 0) || strategies.length === 0) {
    throw new Error("--max-age-days and --limit must be positive numbers and --strategies must not be empty.");
  }

  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const since = new Date(Date.now() - maxAgeDays * 24 * 60 * MINUTE_MS);
    const ideas = (await database.query<IdeaRow>(`
      SELECT ti.id, ti.generated_at, ti.side, ti.entry_price, ti.stop_loss, ti.target_price,
             ti.evidence->>'strategy' AS strategy, cs.outcome AS existing_outcome
        FROM trade_ideas ti
        JOIN instruments i ON i.id = ti.instrument_id
        LEFT JOIN candidate_settlements cs ON cs.trade_idea_id = ti.id
       WHERE i.exchange = 'OANDA' AND i.symbol = 'XAU_USD'
         AND ti.evidence->>'strategy' = ANY($1)
         AND ti.generated_at >= $2
         AND (cs.id IS NULL OR cs.outcome IN ('UNRESOLVED', 'UNSETTLEABLE'))
       ORDER BY ti.generated_at ASC
       LIMIT $3
    `, [strategies, since, limit])).rows;

    if (ideas.length === 0) {
      console.info(JSON.stringify({ level: "info", message: "Gold shadow follow-through: nothing to resolve", mode: apply ? "apply" : "dry-run" }));
      return;
    }

    // One read of the 1m series covering every idea, rather than one per idea.
    const firstOpen = new Date(Math.floor(ideas[0]!.generated_at.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
    const bars = (await database.query<{ id: string; open_time: Date; close_time: Date; open: string; high: string; low: string; close: string }>(`
      SELECT c.id, c.open_time, c.close_time, c.open, c.high, c.low, c.close
        FROM candles c JOIN instruments i ON i.id = c.instrument_id
       WHERE i.exchange = 'OANDA' AND i.symbol = 'XAU_USD' AND c.timeframe = '1m' AND c.is_complete = TRUE
         AND c.open_time >= $1
       ORDER BY c.open_time ASC
    `, [firstOpen])).rows.map((row): CompletedPriceCandle => ({
      id: row.id, openTime: row.open_time, closeTime: row.close_time,
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    }));
    const barIndexByOpenMs = new Map(bars.map((bar, index) => [bar.openTime.getTime(), index]));

    const ledger = new PostgresCandidateLedgerRepository(database);
    const tally = { RESOLVED: 0, OPEN: 0, DEFERRED_GAP: 0, NO_FILL_BAR: 0, written: 0, TARGET: 0, STOP: 0 };
    const lines: Array<Record<string, unknown>> = [];

    for (const idea of ideas) {
      // First minute the idea could be acted on: the next whole minute after it was generated.
      const firstExpectedOpen = new Date(Math.floor(idea.generated_at.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
      const fillIndex = barIndexByOpenMs.get(firstExpectedOpen.getTime() - MINUTE_MS);
      if (fillIndex === undefined) {
        tally.NO_FILL_BAR += 1;
        lines.push({ idea: idea.id, generatedAt: idea.generated_at.toISOString(), status: "NO_FILL_BAR" });
        continue;
      }
      const fill = bars[fillIndex]!.close;
      const levels = reanchorBracket(
        { side: idea.side, entryPrice: Number(idea.entry_price), stopLoss: Number(idea.stop_loss), targetPrice: Number(idea.target_price) },
        fill,
      );
      const result = followThrough({
        side: idea.side,
        ...levels,
        forwardCandles: bars.slice(fillIndex + 1).filter((bar) => bar.openTime.getTime() >= firstExpectedOpen.getTime()),
        firstExpectedOpen,
        isSessionActive: isHealSessionActive,
      });
      tally[result.status] += 1;
      if (result.status === "RESOLVED") {
        tally[result.settlement.outcome as "TARGET" | "STOP"] += 1;
        if (apply && await ledger.recordFollowThrough(idea.id, result.settlement)) tally.written += 1;
      }
      lines.push({
        idea: idea.id,
        strategy: idea.strategy,
        generatedAt: idea.generated_at.toISOString(),
        side: idea.side,
        previously: idea.existing_outcome,
        status: result.status,
        ...(result.status === "RESOLVED"
          ? { outcome: result.settlement.outcome, rMultiple: Number(result.settlement.rMultiple!.toFixed(2)), minutesToResolve: result.settlement.barsToResolution }
          : result.status === "DEFERRED_GAP" ? { missingFrom: result.gapFrom.toISOString() } : {}),
      });
    }

    console.info(JSON.stringify({
      level: "info",
      message: apply ? "Gold shadow follow-through applied" : "Gold shadow follow-through plan (dry-run -- pass --apply to write)",
      mode: apply ? "apply" : "dry-run",
      considered: ideas.length,
      ...tally,
      ideas: lines,
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Gold shadow follow-through failed:", error);
  process.exitCode = 1;
});
