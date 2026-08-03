import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FYERS_PROVIDER_ID, FyersTokenService, redactTokens } from "../../infrastructure/market-data/fyers-token-service.js";

/**
 * Interactive Fyers bootstrap. Run at the start of a backfill campaign and at most
 * fortnightly, because the refresh token Fyers issues is valid for 15 days and there
 * is no non-interactive path past that.
 *
 * This is the only step in the pipeline that requires a human.
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

    const authorizeUrl = new URL("https://api-t1.fyers.in/api/v3/generate-authcode");
    authorizeUrl.searchParams.set("client_id", appId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", "ai-quant-lab");

    console.info("\nOpen this URL, log in, and copy the `auth_code` from the redirect:\n");
    console.info(`  ${authorizeUrl.toString()}\n`);
    const authCode = (await readline.question("auth_code: ")).trim();
    if (!authCode) {
      throw new Error("No auth_code was supplied.");
    }

    const response = await fetch("https://api-t1.fyers.in/api/v3/validate-authcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        appIdHash: service.appIdHash(),
        code: authCode,
      }),
    });
    const payload = await response.json().catch(() => undefined) as
      | { s?: string; code?: number; message?: string; access_token?: string; refresh_token?: string }
      | undefined;

    if (payload?.code === -371) {
      throw new Error(
        "Fyers rejected the appIdHash (-371). Check FYERS_APP_ID and FYERS_APP_SECRET —"
        + " this is a credential-format problem, not an expired code.",
      );
    }
    if (!response.ok || payload?.s !== "ok" || !payload.access_token || !payload.refresh_token) {
      throw new Error(
        `Fyers auth-code exchange failed (HTTP ${response.status}, code ${payload?.code ?? "none"}).`
        + ` ${redactTokens(payload?.message ?? "No message supplied.")}`,
      );
    }

    const now = new Date();
    await database.query(
      `INSERT INTO provider_credentials (
         provider, access_token, access_token_expires_at,
         refresh_token, refresh_token_expires_at, last_refreshed_at, last_error
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (provider) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         access_token_expires_at = EXCLUDED.access_token_expires_at,
         refresh_token = EXCLUDED.refresh_token,
         refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
         last_refreshed_at = EXCLUDED.last_refreshed_at,
         last_error = NULL,
         updated_at = NOW()`,
      [
        FYERS_PROVIDER_ID,
        payload.access_token,
        new Date(now.getTime() + 8 * 60 * 60_000),
        payload.refresh_token,
        // Fyers refresh tokens last 15 days; after that this command must run again.
        new Date(now.getTime() + 15 * 24 * 60 * 60_000),
        now,
      ],
    );

    // Deliberately reports only the expiry. Printing a token would put a live secret
    // into shell history and terminal scrollback.
    console.info(JSON.stringify({
      level: "info",
      message: "Fyers credential stored",
      provider: FYERS_PROVIDER_ID,
      refreshTokenExpiresAt: new Date(now.getTime() + 15 * 24 * 60 * 60_000).toISOString(),
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
