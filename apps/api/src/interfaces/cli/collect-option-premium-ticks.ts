import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { CollectOptionPremiumTicks } from "../../modules/market-data/application/collect-option-premium-ticks.js";
import { getOption } from "./arguments.js";

const DEFAULT_UNDERLYINGS = ["NIFTY50", "BANKNIFTY"];

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const appId = process.env.FYERS_APP_ID;
  const appSecret = process.env.FYERS_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Premium-tick collection requires FYERS_APP_ID and FYERS_APP_SECRET in .env.");
  }

  const underlyingsOption = getOption(argumentsList, "underlyings");
  const underlyingSymbols = underlyingsOption
    ? underlyingsOption.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_UNDERLYINGS;
  const bandOption = getOption(argumentsList, "strike-band");
  const strikeBand = bandOption ? Number(bandOption) : 1;
  if (!Number.isInteger(strikeBand) || strikeBand < 0 || strikeBand > 3) {
    throw new Error("--strike-band must be an integer 0–3.");
  }

  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const { isNseHoliday } = await import("../../modules/market-data/domain/nse-session-calendar.js");
    const holiday = await isNseHoliday(database);
    if (holiday.holiday) {
      console.info(JSON.stringify({
        level: "info",
        message: "NSE holiday; premium-tick collection skipped.",
        holiday: holiday.name,
      }));
      return;
    }

    const tokenService = new FyersTokenService({
      pool: database,
      appId,
      appSecret,
      pin: process.env.FYERS_PIN ?? "",
    });
    const service = new CollectOptionPremiumTicks(
      new PostgresOptionChainRepository(database),
      new PostgresOptionPremiumTickRepository(database),
      { appId, tokenService },
      {
        listForUnderlying: async (underlyingSymbol) => {
          const result = await database.query<{
            underlying_symbol: string;
            expiry_date: string;
            strike_price: string;
            option_type: "CE" | "PE";
            provider_symbol: string;
          }>(`
            SELECT DISTINCT ON (pt.option_expiry, pt.option_strike, pt.option_type)
                   pt.underlying_symbol,
                   to_char(pt.option_expiry AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS expiry_date,
                   pt.option_strike AS strike_price,
                   pt.option_type,
                   known.provider_symbol
            FROM paper_trades pt
            JOIN LATERAL (
              SELECT provider_symbol
              FROM option_premium_ticks
              WHERE underlying_symbol = pt.underlying_symbol
                AND expiry_date = (pt.option_expiry AT TIME ZONE 'UTC')::date
                AND strike_price = pt.option_strike
                AND option_type = pt.option_type
              ORDER BY observed_at DESC
              LIMIT 1
            ) known ON TRUE
            WHERE pt.status = 'OPEN'
              AND pt.underlying_symbol = $1
              AND pt.option_type IN ('CE', 'PE')
            ORDER BY pt.option_expiry, pt.option_strike, pt.option_type
          `, [underlyingSymbol]);
          return result.rows.map((row) => ({
            underlyingSymbol: row.underlying_symbol,
            expiryDate: row.expiry_date,
            strikePrice: Number(row.strike_price),
            optionType: row.option_type,
            providerSymbol: row.provider_symbol,
          }));
        },
      },
    );
    const result = await service.execute({ underlyingSymbols, strikeBand });
    console.info(JSON.stringify({
      level: result.inserted === 0 ? "warn" : "info",
      message: "Option premium tick collection complete",
      ...result,
    }));
    if (result.inserted === 0) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
