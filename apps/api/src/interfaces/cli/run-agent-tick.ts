import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { quoteLabSymbol } from "../../infrastructure/market-data/yahoo-quote-client.js";
import { buildHttpDependencies } from "../http/dependencies.js";
import { AiAgentTickCoordinator } from "../../modules/strategy-engine/application/ai-agent-tick-coordinator.js";

/**
 * One autonomous-agent evaluation pass, owned by the scheduler.
 *
 * This exists because the tick used to be driven from inside `GET /api/v1/stream/live-agent`.
 * The agent evaluates open positions, tightens stops, closes on the sentiment circuit breaker
 * and opens new paper trades, so that arrangement had four defects that are all structural
 * rather than incidental:
 *
 * 1. Trading only happened while a browser tab was open on the dashboard, and stopped when it
 *    was closed. Whether a position gets its stop honoured is not a property of the UI.
 * 2. The mutation rate limiter deliberately exempts GET (`readOnlyMethods` in
 *    `common/middleware.ts`), so the one path that mutates trades had no limit at all, and
 *    `?symbol=`/`?timeframe=` let any caller steer it at anything.
 * 3. The tick was awaited before the stream's own payload was written, so a slow agent pass
 *    stalled the live price the panel exists to show.
 * 4. `scheduler.ts` documents at length why owning time and serving HTTP are separate
 *    processes -- only one of them may be replicated freely. An in-request trading loop puts
 *    them back together.
 *
 * The price is read here, from the provider, and a pass is **skipped** when there is no live
 * quote. The stream's version passed whatever `livePrice` it had, which after a provider
 * failure was the last stored candle's close -- so the agent sized stops and booked entries
 * against a stale bar while the comment above it said "real prices".
 */

interface Options {
  symbols: string[];
  timeframe: string;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }
  const symbols = (values.get("symbols") ?? "NIFTY50,BANKNIFTY")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) {
    throw new Error("--symbols must name at least one instrument.");
  }
  return { symbols, timeframe: (values.get("timeframe") ?? "5m").trim().toLowerCase() };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const dependencies = buildHttpDependencies(database);
    // The coordinator's per-key interval guard is what keeps a slow pass from being entered
    // twice when the scheduler's cron and a manual run land together.
    const coordinator = new AiAgentTickCoordinator();
    const outcomes: Array<Record<string, unknown>> = [];

    for (const symbol of options.symbols) {
      const quote = await quoteLabSymbol(symbol);
      if (quote === null) {
        // Reported, not silently skipped: "the agent evaluated and did nothing" and "the
        // agent never ran" are the same empty output otherwise, and only one is a market
        // observation. This is the same reasoning `run-paper-trading-bot.ts` applies.
        outcomes.push({ symbol, ticked: false, reason: "NO_LIVE_QUOTE" });
        continue;
      }
      const ticked = await coordinator.run(
        dependencies.aiAutonomousAgent,
        symbol,
        options.timeframe,
        quote.regularMarketPrice!,
      );
      outcomes.push({
        symbol,
        ticked,
        ...(ticked ? { livePrice: quote.regularMarketPrice } : { reason: "COALESCED" }),
      });
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Agent tick complete",
      timeframe: options.timeframe,
      outcomes,
      thoughts: dependencies.aiAutonomousAgent.getThoughts(5),
    }));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Agent tick failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
