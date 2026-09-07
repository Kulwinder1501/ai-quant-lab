import "dotenv/config";
import { loadEnvironment } from "./apps/api/src/config/environment.js";
import { createDatabasePool } from "./apps/api/src/infrastructure/database/database.js";
import { FyersTokenService } from "./apps/api/src/infrastructure/market-data/fyers-token-service.js";

async function main() {
  const env = loadEnvironment();
  const pool = createDatabasePool(env.DATABASE_URL);
  try {
    const ts = new FyersTokenService({
      pool,
      appId: process.env.FYERS_APP_ID!,
      appSecret: process.env.FYERS_APP_SECRET!,
      pin: process.env.FYERS_PIN!
    });
    const token = await ts.getAccessToken();
    const url = "https://api-t1.fyers.in/data/quotes?symbols=NSE:NIFTY50-INDEX";
    const res = await fetch(url, {
      headers: { Authorization: `${process.env.FYERS_APP_ID}:${token}` }
    });
    console.log(await res.text());
  } finally {
    await pool.end();
  }
}
main().catch(console.error);
