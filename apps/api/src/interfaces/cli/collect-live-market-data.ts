import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { KiteLiveMarketDataProvider } from "../../infrastructure/market-data/kite-live-market-data-provider.js";
import { FyersLiveMarketDataProvider } from "../../infrastructure/market-data/fyers-live-market-data-provider.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresMarketDataIngestionRepository } from "../../infrastructure/database/repositories/postgres-market-data-ingestion-repository.js";
import { CollectLiveMarketData, type LiveMarketSubscription } from "../../modules/market-data/application/collect-live-market-data.js";
import type { Instrument } from "../../modules/market-data/domain/instrument.js";
import type { LiveMarketDataProvider } from "../../modules/market-data/domain/live-market-data-provider.js";
import { resolveFyersSymbol } from "../../modules/market-data/domain/fyers-symbol-resolver.js";
import { NseMarketSession } from "../../modules/market-data/domain/nse-market-session.js";
import { getOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

function parsePositiveSeconds(value: string | undefined): number {
  const seconds = Number(value ?? "30");
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3_600) {
    throw new Error("--poll-seconds must be an integer between 1 and 3600.");
  }
  return seconds;
}

function readHolidays(value: string | undefined): string[] {
  return (value ?? "").split(",").map((holiday) => holiday.trim()).filter((holiday) => /^\d{4}-\d{2}-\d{2}$/.test(holiday));
}

function providerQuoteSymbol(instrument: Instrument, provider: string): string {
  if (provider === "fyers") {
    return resolveFyersSymbol(instrument.symbol);
  }
  const configured = instrument.metadata.kiteQuoteSymbol;
  return typeof configured === "string" && configured.trim()
    ? configured
    : `${instrument.exchange}:${instrument.symbol}`;
}

function selectSubscriptions(instruments: Instrument[], requestedSymbols: string | undefined, provider: string): LiveMarketSubscription[] {
  const requested = requestedSymbols
    ? new Set(requestedSymbols.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))
    : null;
  const subscriptions = instruments
    .filter((instrument) => !requested || requested.has(instrument.symbol))
    .map((instrument) => ({ instrument, providerInstrumentId: providerQuoteSymbol(instrument, provider) }));
  if (requested && subscriptions.length !== requested.size) {
    const found = new Set(subscriptions.map((subscription) => subscription.instrument.symbol));
    throw new Error(`Unknown active instrument(s): ${[...requested].filter((symbol) => !found.has(symbol)).join(", ")}.`);
  }
  return subscriptions;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const providerName = requireOption(argumentsList, "provider").toLowerCase();
  if (providerName !== "kite" && providerName !== "fyers") {
    throw new Error("Live collection currently supports kite or fyers. Use --provider kite or --provider fyers.");
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const ingestionRepository = new PostgresMarketDataIngestionRepository(database);
  let ingestionId: string | undefined;
  try {
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const requestedSymbols = getOption(argumentsList, "instruments");
    const instrumentRepository = new PostgresInstrumentRepository(database);
    const instruments = requestedSymbols
      ? (await Promise.all(
          requestedSymbols.split(",")
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean)
            .map((symbol) => instrumentRepository.findByExchangeAndSymbol("NSE", symbol)),
        )).filter((instrument): instrument is Instrument => instrument !== null)
      : await instrumentRepository.listActive();
    const subscriptions = selectSubscriptions(
      instruments,
      requestedSymbols,
      providerName
    );
    if (subscriptions.length === 0) {
      throw new Error("No active instruments are configured for live collection.");
    }
    
    let provider: LiveMarketDataProvider;
    if (providerName === "kite") {
      const apiKey = process.env.KITE_API_KEY;
      const accessToken = process.env.KITE_ACCESS_TOKEN;
      if (!apiKey || !accessToken) {
        throw new Error("Live Kite collection requires KITE_API_KEY and KITE_ACCESS_TOKEN in .env.");
      }
      provider = new KiteLiveMarketDataProvider({ apiKey, accessToken });
    } else {
      const appId = process.env.FYERS_APP_ID;
      const appSecret = process.env.FYERS_APP_SECRET;
      const pin = process.env.FYERS_PIN;
      if (!appId || !appSecret || !pin) {
        throw new Error("Live Fyers collection requires FYERS_APP_ID, FYERS_APP_SECRET and FYERS_PIN in .env.");
      }
      provider = new FyersLiveMarketDataProvider({
        appId,
        tokenService: new FyersTokenService({ pool: database, appId, appSecret, pin }),
      });
    }
    const pollingSeconds = parsePositiveSeconds(getOption(argumentsList, "poll-seconds"));
    const session = new NseMarketSession(readHolidays(getOption(argumentsList, "holidays") ?? process.env.NSE_HOLIDAYS));
    const ingestion = await ingestionRepository.start({
      provider: provider.id,
      mode: "LIVE",
      requestMetadata: {
        timeframe,
        pollSeconds: pollingSeconds,
        symbols: subscriptions.map((subscription) => subscription.instrument.symbol),
        providerInstrumentIds: subscriptions.map((subscription) => subscription.providerInstrumentId),
      },
    });
    ingestionId = ingestion.id;
    const collector = new CollectLiveMarketData(provider, new PostgresCandleRepository(database), session);
    let finalizedCount = 0;
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    do {
      const result = await collector.execute({ subscriptions, timeframe, ingestionId, now: new Date() });
      finalizedCount += result.candlesFinalized;
      console.info(JSON.stringify({ level: "info", message: "Live poll complete", ...result }));
      if (getOption(argumentsList, "once") === "true" || argumentsList.includes("--once") || stopping) {
        break;
      }
      await delay(pollingSeconds * 1_000);
    } while (!stopping);

    await ingestionRepository.complete(ingestionId, finalizedCount);
  } catch (error) {
    if (ingestionId) {
      const message = error instanceof Error ? error.message : "Unknown live collection failure.";
      try {
        await ingestionRepository.fail(ingestionId, message);
      } catch (ingestionError) {
        console.error("Unable to mark live ingestion as failed", ingestionError);
      }
    }
    throw error;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
