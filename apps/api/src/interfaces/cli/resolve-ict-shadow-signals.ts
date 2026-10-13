import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresIctShadowSignalRepository } from "../../infrastructure/database/repositories/postgres-ict-shadow-signal-repository.js";
import { resolveIctShadowSignals } from "../../modules/strategy-engine/application/ict-shadow-signals.js";
import { getOption } from "./arguments.js";

/**
 * Follows every unresolved ICT shadow signal's bracket on stored 1m bars to a target, a stop or the
 * 15:15 IST square-off. Reads stored candles only and writes only to `ict_shadow_signals`; a settled
 * row is never rewritten, so it is safe to run any time, any number of times.
 *
 * Usage: resolve-ict-shadow-signals [--limit 500]
 */
async function main(): Promise<void> {
  const limit = Number(getOption(process.argv.slice(2), "limit") ?? "500");
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive number.");

  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const store = new PostgresIctShadowSignalRepository(database);
    const now = new Date();
    const summary = await resolveIctShadowSignals({
      listUnresolved: (max) => store.listUnresolved(max),
      loadOneMinuteBars: (instrumentId, from, to) => store.loadOneMinuteBars(instrumentId, from, to),
      recordResolution: (id, resolution, at) => store.recordResolution(id, resolution, at),
    }, now, limit);
    console.info(JSON.stringify({ level: "info", message: "ICT shadow resolution", at: now.toISOString(), ...summary }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("ICT shadow resolution failed:", error);
  process.exitCode = 1;
});
