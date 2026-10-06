import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersHistoricalDataProvider } from "../../infrastructure/market-data/fyers-historical-data-provider.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresMarketDataIngestionRepository } from "../../infrastructure/database/repositories/postgres-market-data-ingestion-repository.js";
import { ImportHistoricalMarketData } from "../../modules/market-data/application/import-historical-market-data.js";
import { scanCandleCoverage, type ScannedSession } from "../../modules/market-data/application/scan-candle-coverage.js";
import { parseDateOption, parseHistoricalTimeframe } from "./arguments.js";

/**
 * Backfills the exact sessions the detector flags as confirmed collection gaps.
 *
 * This is the write half of the gap machinery, deliberately kept separate from `data:detect-gaps` and
 * off by default. The August 2026 gaps were silent, and the detector fixes the *silence*; this fixes
 * the *gap*, but a live-series write earns more caution than a read, so the safety comes from four
 * standing guarantees rather than from trust:
 *
 * 1. **Dry-run unless `--apply`.** Without the flag it only reports the plan — which sessions it would
 *    fetch and the exact command — and writes nothing.
 * 2. **Append-only.** Every fetch runs with `skipExisting`, so an already-stored bar is left untouched.
 *    The healer can only *add* minutes that are missing; it can never revise or overwrite a bar that
 *    the collector already wrote. The candle immutability guard still stands behind that.
 * 3. **Fyers only, CONFIRMED_GAP only.** It fetches from the authoritative source for these index
 *    series, and acts only on unambiguous misses (missing open or interior hole) — never on an
 *    ambiguous short tail, which a half-day produces legitimately.
 * 4. **Verified.** After applying, it re-scans the same window and reports which gaps actually closed.
 *    In `--apply` mode it exits non-zero if any confirmed gap survives the repair, so a heal that could
 *    not complete (Fyers unauthenticated, a bar the provider itself is missing) still surfaces loudly
 *    rather than reporting a false all-clear.
 *
 * The provenance foreign key on `candles` remains the final backstop: this only ever collects Fyers
 * bars for a Fyers-declared series, so a misdirected write is rejected at the database, not merely here.
 *
 * Usage: heal-candle-gaps [--apply] [--instruments NIFTY50,BANKNIFTY] [--timeframe 1m] [--lookback-days 5]
 */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  const apply = argv.includes("--apply");

  const instruments = (flag("--instruments") ?? "NIFTY50,BANKNIFTY").split(",").map((s) => s.trim()).filter(Boolean);
  const timeframe = flag("--timeframe") ?? "1m";
  const lookbackDays = Number(flag("--lookback-days") ?? "5");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const scan = await scanCandleCoverage(database, { instruments, timeframe, lookbackDays });

    if (scan.confirmed.length === 0) {
      console.info(JSON.stringify({
        level: "info",
        message: "Candle gap heal: nothing to do",
        mode: apply ? "apply" : "dry-run",
        instruments, timeframe, lookbackDays,
        sessionsChecked: scan.sessionsChecked,
      }, null, 2));
      return;
    }

    const plan = scan.confirmed.map((c) => ({
      instrument: c.instrument,
      session: c.session,
      timeframe: c.timeframe,
      summary: c.coverage.summary,
      command: `npm run data:collect:historical -- --provider fyers --instrument ${c.instrument} `
        + `--timeframe ${timeframe} --from ${c.session} --to ${c.session} --skip-existing`,
    }));

    if (!apply) {
      console.info(JSON.stringify({
        level: "info",
        message: "Candle gap heal plan (dry-run — pass --apply to backfill)",
        mode: "dry-run",
        instruments, timeframe, lookbackDays,
        sessionsChecked: scan.sessionsChecked,
        wouldHeal: plan,
      }, null, 2));
      return;
    }

    // --- apply ---
    const appId = process.env.FYERS_APP_ID;
    const appSecret = process.env.FYERS_APP_SECRET;
    if (!appId || !appSecret) throw new Error("Healing requires FYERS_APP_ID and FYERS_APP_SECRET in .env.");
    const provider = new FyersHistoricalDataProvider({
      appId,
      tokenService: new FyersTokenService({ pool: database, appId, appSecret, pin: process.env.FYERS_PIN ?? "" }),
    });
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const service = new ImportHistoricalMarketData(
      new PostgresMarketDataIngestionRepository(database),
      new PostgresCandleRepository(database),
    );

    // Narrows the string to the historical-timeframe union the import service accepts; a bad --timeframe
    // fails here rather than at the first insert.
    const importTimeframe = parseHistoricalTimeframe(timeframe);
    const outcomes: Record<string, unknown>[] = [];
    for (const gap of scan.confirmed) {
      try {
        const instrument = await instrumentRepository.findByExchangeAndSymbol("NSE", gap.instrument.toUpperCase());
        if (!instrument) throw new Error(`NSE instrument "${gap.instrument}" is not registered.`);
        const result = await service.execute({
          instrument,
          provider,
          providerInstrumentId: instrument.symbol,
          timeframe: importTimeframe,
          from: parseDateOption(gap.session, false),
          to: parseDateOption(gap.session, true),
          skipExisting: true, // append-only: fill the missing minutes, never touch the stored ones.
          skipInvalid: false,
        });
        outcomes.push({
          instrument: gap.instrument, session: gap.session, status: "collected",
          candlesFetched: result.candlesFetched,
          candlesPersisted: result.candlesPersisted,
          candlesSkipped: result.candlesSkipped,
        });
      } catch (error) {
        outcomes.push({
          instrument: gap.instrument, session: gap.session, status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Prove the repair rather than assume it: re-scan the same window and see which confirmed gaps
    // survived. A session the provider itself cannot fill (a genuine venue gap, or an unauthenticated
    // feed) stays confirmed, and that must not read as success.
    const after = await scanCandleCoverage(database, { instruments, timeframe, lookbackDays });
    const residual = after.confirmed;
    const key = (s: ScannedSession) => `${s.instrument}:${s.session}`;
    const healed = scan.confirmed.filter((b) => !residual.some((r) => key(r) === key(b)));

    console.info(JSON.stringify({
      level: residual.length > 0 ? "error" : "info",
      message: "Candle gap heal complete",
      mode: "apply",
      instruments, timeframe, lookbackDays,
      attempted: scan.confirmed.length,
      healed: healed.map((c) => ({ instrument: c.instrument, session: c.session })),
      outcomes,
      residualGaps: residual.map((c) => ({ instrument: c.instrument, session: c.session, ...c.coverage })),
    }, null, 2));

    // A gap that survived the repair is a real, unhealed miss; fail the run so it surfaces the same day.
    if (residual.length > 0) {
      throw new Error(`${residual.length} confirmed gap(s) remain after the heal attempt; see residualGaps.`);
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("Candle gap heal failed:", error);
  process.exitCode = 1;
});
