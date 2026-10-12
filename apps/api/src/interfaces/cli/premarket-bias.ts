import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPremarketBiasRepository } from "../../infrastructure/database/repositories/postgres-premarket-repository.js";
import { NseApiClient } from "../../infrastructure/external/nse-api-client.js";
import { geminiClientFromEnvironment } from "../../infrastructure/external/gemini-client.js";
import { NseIxClient } from "../../infrastructure/external/nse-ix-client.js";
import { quoteLabSymbols } from "../../infrastructure/market-data/yahoo-quote-client.js";
import { CapturePremarketSnapshot, type CueQuote } from "../../modules/premarket-intelligence/application/capture-premarket-snapshot.js";
import { RunPremarketBias, type RunSlot } from "../../modules/premarket-intelligence/application/run-premarket-bias.js";
import { isNseHoliday } from "../../modules/market-data/domain/nse-session-calendar.js";

function readSlot(argv: readonly string[]): RunSlot {
  const index = argv.indexOf("--slot");
  const value = index >= 0 ? argv[index + 1] : "0850";
  if (value !== "0850" && value !== "0910") throw new Error(`--slot must be 0850 or 0910; got ${String(value)}.`);
  return value;
}

/**
 * One pre-market run. `--slot 0850` is the primary snapshot; `--slot 0910` is the conditional
 * update and writes nothing unless NSE is publishing a true indicative pre-open print (it still
 * records a probe attempt, so the feed's real behaviour is visible in the attempts table).
 * `--final` lets a no-data run, or a failed model call, become the slot's terminal row; the early try
 * omits it so a transient outage can still be retried. NSE holidays are skipped.
 */
async function main(): Promise<void> {
  const slot = readSlot(process.argv);
  const finalAttempt = process.argv.includes("--final");
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const repository = new PostgresPremarketBiasRepository(database);
    const nseIx = new NseIxClient();
    const nse = new NseApiClient();
    const source = new CapturePremarketSnapshot({
      giftNiftyQuote: () => nseIx.getGiftNiftyFuturesQuote(),
      cueQuotes: async (symbols) => {
        const quotes = await quoteLabSymbols(symbols);
        const result = new Map<string, CueQuote>();
        for (const symbol of symbols) {
          const quote = quotes.get(symbol);
          if (quote) {
            result.set(symbol, {
              changePercent: quote.regularMarketChangePercent,
              price: quote.regularMarketPrice,
              observedAt: quote.regularMarketTime,
            });
          }
        }
        return result;
      },
      indexIndicatives: () => nse.getIndexIndicatives(),
      dailyBars: (instrument, beforeDate, count) => repository.dailyBars(instrument, beforeDate, count),
    });

    const result = await new RunPremarketBias(
      source,
      repository,
      geminiClientFromEnvironment(),
      () => new Date(),
      async () => (await isNseHoliday(database, new Date())).name,
    ).execute({
      slot,
      finalAttempt: finalAttempt || slot === "0910",
      requirePreOpen: slot === "0910",
    });
    console.info(JSON.stringify({ level: "info", message: "Pre-market bias run complete", slot, ...result }));
    if (result.outcome === "NO_DATA") process.exitCode = 2;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
