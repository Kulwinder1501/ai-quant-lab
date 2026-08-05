import { createHash } from "node:crypto";
import type { Pool } from "pg";

export const FYERS_PROVIDER_ID = "fyers-api-v3";

/** Refresh a little before expiry so a long chunked backfill never races the boundary. */
const REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_BASE_URL = "https://api-t1.fyers.in";

type FetchFunction = typeof fetch;

export interface FyersCredentialRow {
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

export interface FyersTokenServiceOptions {
  pool: Pool;
  appId: string;
  appSecret: string;
  /** Fyers requires the account PIN on every refresh; there is no PIN-less path. */
  pin: string;
  fetch?: FetchFunction;
  baseUrl?: string;
  now?: () => Date;
}

/**
 * Fyers issues a short-lived access token plus a refresh token valid for 15 days.
 * Past that a human must log in again — there is no non-interactive path, which is
 * why the scheduler never owns a Fyers timeframe.
 *
 * Tokens live in Postgres rather than `.env` because each CLI invocation is a new
 * process and both host and container runs already share `DATABASE_URL`. Writing a
 * live secret back into a file the repo ships an example of is the pattern this
 * deliberately avoids.
 */
export class FyersTokenService {
  private readonly fetch: FetchFunction;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: FyersTokenServiceOptions) {
    if (!options.appId.trim() || !options.appSecret.trim()) {
      throw new Error("Fyers access requires FYERS_APP_ID and FYERS_APP_SECRET.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.now = options.now ?? (() => new Date());
  }

  /** sha256("<appId>:<appSecret>"). A malformed hash is Fyers error -371. */
  appIdHash(): string {
    return createHash("sha256")
      .update(`${this.options.appId}:${this.options.appSecret}`)
      .digest("hex");
  }

  /**
   * Returns a usable access token, refreshing under a row lock so two concurrent
   * backfills cannot both burn a refresh against the same credential.
   */
  async getAccessToken(): Promise<string> {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT access_token, access_token_expires_at, refresh_token, refresh_token_expires_at
         FROM provider_credentials WHERE provider = $1 FOR UPDATE`,
        [FYERS_PROVIDER_ID],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          "No Fyers credential is stored. Run `npm run data:auth:fyers` to authorize once.",
        );
      }

      const now = this.now();
      const accessExpiry = row.access_token_expires_at as Date | null;
      if (row.access_token && accessExpiry && accessExpiry.getTime() - now.getTime() > REFRESH_SKEW_MS) {
        await client.query("COMMIT");
        return String(row.access_token);
      }

      const refreshExpiry = row.refresh_token_expires_at as Date | null;
      if (!row.refresh_token || (refreshExpiry && refreshExpiry.getTime() <= now.getTime())) {
        const message = "Fyers refresh token expired; re-run `npm run data:auth:fyers`.";
        await this.recordError(client, message);
        await client.query("COMMIT");
        throw new Error(message);
      }

      let refreshed: { accessToken: string; expiresAt: Date };
      try {
        refreshed = await this.refresh(String(row.refresh_token));
      } catch (error) {
        await this.recordError(client, error instanceof Error ? error.message : String(error));
        await client.query("COMMIT");
        throw error;
      }

      await client.query(
        `UPDATE provider_credentials
         SET access_token = $2, access_token_expires_at = $3,
             last_refreshed_at = $4, last_error = NULL, updated_at = NOW()
         WHERE provider = $1`,
        [FYERS_PROVIDER_ID, refreshed.accessToken, refreshed.expiresAt, now],
      );
      await client.query("COMMIT");
      return refreshed.accessToken;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Refuses to start work a credential cannot finish, so a multi-hour backfill fails
   * up front rather than partway through.
   */
  async assertUsableFor(estimatedDurationMs: number): Promise<void> {
    const result = await this.options.pool.query(
      "SELECT refresh_token, refresh_token_expires_at FROM provider_credentials WHERE provider = $1",
      [FYERS_PROVIDER_ID],
    );
    const row = result.rows[0];
    if (!row?.refresh_token) {
      throw new Error("No Fyers credential is stored. Run `npm run data:auth:fyers` first.");
    }
    const expiry = row.refresh_token_expires_at as Date | null;
    if (expiry && expiry.getTime() < this.now().getTime() + estimatedDurationMs) {
      throw new Error(
        `The stored Fyers refresh token expires at ${expiry.toISOString()}, before this job is`
        + " estimated to finish. Re-run `npm run data:auth:fyers` before starting.",
      );
    }
  }

  /** Read-only snapshot of the stored credential, for a health check that never mutates it. */
  /**
   * Both clocks, because they mean different things now.
   *
   * `accessTokenExpiresAt` decides whether Fyers calls work. `refreshTokenExpiresAt` used to
   * imply the access token could be renewed programmatically; since Fyers disabled the
   * refresh API it implies nothing, and reporting it alone made the credential look healthy
   * for a fortnight while every job failed.
   */
  async checkCredentialHealth(): Promise<{
    hasCredential: boolean;
    accessTokenExpiresAt: Date | null;
    refreshTokenExpiresAt: Date | null;
    lastError: string | null;
  }> {
    const result = await this.options.pool.query(
      "SELECT refresh_token, access_token_expires_at, refresh_token_expires_at, last_error "
      + "FROM provider_credentials WHERE provider = $1",
      [FYERS_PROVIDER_ID],
    );
    const row = result.rows[0];
    if (!row?.refresh_token) {
      return {
        hasCredential: false,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        lastError: (row?.last_error as string | null) ?? null,
      };
    }
    return {
      hasCredential: true,
      accessTokenExpiresAt: row.access_token_expires_at as Date | null,
      refreshTokenExpiresAt: row.refresh_token_expires_at as Date | null,
      lastError: row.last_error as string | null,
    };
  }

  private async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
    const response = await this.fetch(`${this.baseUrl}/api/v3/validate-refresh-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        appIdHash: this.appIdHash(),
        refresh_token: refreshToken,
        pin: this.options.pin,
      }),
    });
    const payload = await response.json().catch(() => undefined) as
      | { s?: string; code?: number; message?: string; access_token?: string }
      | undefined;

    // Fyers reports failures in the body with HTTP 200, so status alone is not a verdict.
    if (payload?.code === -371) {
      throw new Error(
        "Fyers rejected the appIdHash (-371). Check FYERS_APP_ID and FYERS_APP_SECRET;"
        + " the hash is sha256 of \"appId:appSecret\". This is not an expired token.",
      );
    }
    if (!response.ok || payload?.s !== "ok" || !payload.access_token) {
      throw new Error(
        `Fyers token refresh failed (HTTP ${response.status}, code ${payload?.code ?? "none"}).`
        + ` ${redactTokens(payload?.message ?? "No message supplied.")}`,
      );
    }

    // Fyers access tokens are same-day; expiry is not returned, so assume a
    // conservative window rather than trusting the token past it.
    return {
      accessToken: payload.access_token,
      expiresAt: new Date(this.now().getTime() + 8 * 60 * 60_000),
    };
  }

  private async recordError(client: { query: Pool["query"] }, message: string): Promise<void> {
    await client.query(
      "UPDATE provider_credentials SET last_error = $2, updated_at = NOW() WHERE provider = $1",
      [FYERS_PROVIDER_ID, redactTokens(message)],
    );
  }
}

/**
 * Upstream error bodies routinely echo the token back. Storing that in `last_error`
 * would leak a live secret into a column people paste into bug reports.
 */
export function redactTokens(message: string): string {
  return message
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted-jwt>")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "<redacted>");
}
