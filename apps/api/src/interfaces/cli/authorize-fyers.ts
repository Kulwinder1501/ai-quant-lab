import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { createFyersOAuthState } from "../../infrastructure/market-data/fyers-oauth.js";
import { FyersTokenService, redactTokens } from "../../infrastructure/market-data/fyers-token-service.js";

/**
 * Interactive Fyers bootstrap. Prefer Settings → Connect Fyers in the web UI;
 * this CLI remains for headless / first-time ops when the browser flow is unavailable.
 *
 * The refresh token Fyers issues is valid for 15 days; past that a human must log in again.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const appId = requireSecret("FYERS_APP_ID");
  const appSecret = requireSecret("FYERS_APP_SECRET");
  const redirectUri = requireSecret("FYERS_REDIRECT_URI");

  const database = createDatabasePool(environment.DATABASE_URL);
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const service = new FyersTokenService({
      pool: database,
      appId,
      appSecret,
      pin: process.env.FYERS_PIN ?? "",
    });

    const state = createFyersOAuthState(appSecret);
    const authorizeUrl = service.buildAuthorizeUrl(redirectUri, state);

    console.info("\nOpen this URL, log in, and copy the `auth_code` from the redirect:\n");
    console.info(`  ${authorizeUrl}\n`);
    console.info(
      "(Or use Settings → Connect Fyers in the web UI so the callback stores tokens automatically.)\n",
    );
    const authCode = (await readline.question("auth_code: ")).trim();
    const tokens = await service.exchangeAuthCode(authCode);
    const stored = await service.storeTokens(tokens);

    // Deliberately reports only the expiry. Printing a token would put a live secret
    // into shell history and terminal scrollback.
    console.info(JSON.stringify({
      level: "info",
      message: "Fyers credential stored",
      provider: "fyers-api-v3",
      refreshTokenExpiresAt: stored.refreshTokenExpiresAt.toISOString(),
    }));
  } finally {
    readline.close();
    await database.end();
  }
}

function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in .env for Fyers authorization.`);
  }
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? redactTokens(error.message) : error);
  process.exitCode = 1;
});
