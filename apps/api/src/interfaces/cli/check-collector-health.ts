import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import { NseMarketSession } from "../../modules/market-data/domain/nse-market-session.js";
import {
  describeCollectorHealth,
  evaluateCollectorHealth,
  type CollectorObservation,
} from "../../modules/market-data/domain/collector-health.js";
import { getOption } from "./arguments.js";

/**
 * Operational health of the option-premium collector for one session. **Monitoring only.**
 *
 * Runs in-session as well as after the close, so a silence is reported while there is still time to
 * act on it. Discovering at 15:40 that 11:00-12:45 disappeared is too late to recover the session.
 *
 * It reads ticks and prints a status. It writes nothing, and — enforced by
 * `collector-health-isolation.test.ts` — nothing in the research path may import the module it uses.
 * D2 session qualification stays derived from the frozen quote rules alone.
 */

const UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;

interface TickRow {
  observed_at: Date;
  exchange_feed_time: Date | null;
  created_at: Date;
  collector_regime: string | null;
}

async function loadObservations(
  database: DatabasePool, symbol: string, sessionDate: string,
): Promise<CollectorObservation[]> {
  const result = await database.query<TickRow>(`
    SELECT observed_at, exchange_feed_time, created_at, collector_regime
    FROM option_premium_ticks
    WHERE underlying_symbol = $1
      AND (observed_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
    ORDER BY observed_at ASC
  `, [symbol, sessionDate]);
  return result.rows.map((row) => ({
    observedAt: row.observed_at,
    exchangeFeedTime: row.exchange_feed_time,
    persistedAt: row.created_at,
    collectorRegime: row.collector_regime,
  }));
}

function istDateKey(value: Date): string {
  return new Date(value.getTime() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const now = new Date();
  const sessionDate = getOption(args, "session") ?? istDateKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) throw new Error("--session must be YYYY-MM-DD.");
  const symbols = (getOption(args, "instruments") ?? UNDERLYINGS.join(","))
    .split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);

  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    // The collector serves options, so its expected day is the derivatives day. Asking the cash
    // calendar here would declare the collector "stopped early" at 15:30 every single session.
    const calendar = new NseMarketSession([], "EQUITY_DERIVATIVES");
    const noonIst = new Date(`${sessionDate}T06:30:00.000Z`);
    const session = calendar.getSession(noonIst);
    if (!session) {
      console.info(JSON.stringify({ level: "info", message: "Not a trading session", sessionDate }));
      return;
    }

    let degraded = false;
    for (const symbol of symbols) {
      const health = evaluateCollectorHealth({
        sessionDate,
        expectedOpenAt: session.opensAt,
        expectedCloseAt: session.closesAt,
        observations: await loadObservations(database, symbol, sessionDate),
        now,
      });
      if (health.status === "DEGRADED") degraded = true;
      console.info(JSON.stringify({
        // Warn, not error: a degraded collector is an operational alert, and this process must not
        // read as a failed research run.
        level: health.status === "DEGRADED" ? "warn" : "info",
        message: "Collector health",
        symbol,
        summary: describeCollectorHealth(health),
        status: health.status,
        segment: health.segment,
        expectedOpenAt: health.expectedOpenAt,
        expectedCloseAt: health.expectedCloseAt,
        firstObservedAt: health.firstObservedAt,
        lastObservedAt: health.lastObservedAt,
        maxGapMs: health.maxGapMs,
        gaps: health.gaps,
        collectorRegimes: health.collectorRegimes,
        reconnectCount: health.reconnectCount,
        receiptMaxGapMs: health.receipt.maxGapMs,
        exchangeFeed: health.exchangeFeed.available
          ? { maxGapMs: health.exchangeFeed.maxGapMs, gapCount: health.exchangeFeed.gaps.length }
          : { unavailableReason: health.exchangeFeed.unavailableReason },
        persistenceLagMs: health.persistenceLagMs,
        findings: health.findings,
      }));
    }
    // Non-zero on DEGRADED so a scheduler or shell caller can alert without parsing the log.
    if (degraded) process.exitCode = 2;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
