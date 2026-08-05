import { createHash } from "node:crypto";
import type { Pool } from "pg";

export const FYERS_PROVIDER_ID = "fyers-api-v3";

/**
 * A refresh that failed, carrying whether trying again could plausibly help.
 *
 * The distinction is the whole point of the retry: hammering a terminal failure -- a wrong
 * appIdHash, an expired refresh token -- wastes the attempt budget and walks into the 429 the
 * provider returns after about a dozen rapid calls, while giving up on a transient one throws
 * away a session's collection for no reason.
 */
export class FyersRefreshError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: number | null,
    readonly httpStatus: number | null,
  ) {
    super(message);
    this.name = "FyersRefreshError";
  }
}

/**
 * Whether a refresh failure is worth retrying.
 *
 * `-16` is the case this was built for: on 2026-08-05 Fyers answered
 * "Refresh token API is currently disabled to comply with SEBI regulations", which reads
 * permanent and was not -- a refresh succeeded 19 minutes later. 429 and 5xx are the ordinary
 * transient shapes, and a fetch that throws never reached the provider at all.
 *
 * Everything else is treated as terminal. That is deliberate: an unrecognised code is more
 * likely a credential or contract problem than a blip, and retrying it costs the budget that
 * a real blip needs.
 */
export function isRetryableRefreshFailure(input: {
  code: number | null;
  httpStatus: number | null;
  networkError: boolean;
}): boolean {
  if (input.networkError) return true;
  if (input.code === -16) return true;
  if (input.httpStatus === 429) return true;
  return input.httpStatus !== null && input.httpStatus >= 500;
}

/**
 * Backoff between refresh attempts: 2s, then 6s.
 *
 * Seconds rather than milliseconds because a provider that just refused needs time to stop
 * refusing, and bounded to a few seconds because the credential row stays locked throughout.
 */
export function refreshRetryDelayMs(attempt: number): number {
  return 2_000 * 3 ** Math.max(0, attempt - 1);
}

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
  /** Injectable so a retry test does not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Total refresh attempts, including the first. Defaults to 3.
   *
   * Deliberately small. The retry runs while `getAccessToken` holds `FOR UPDATE` on the
   * credential row, which is correct -- that lock is what stops two callers each burning a
   * refresh, and a caller that waits then gets the fresh token instead of failing -- but it
   * means the budget is also how long every other Fyers caller is blocked.
   */
  refreshAttempts?: number;
}

/**
 * Fyers issues a short-lived access token (observed ~8 hours) plus a refresh token valid for
 * 15 days. Past that a human must log in again — there is no non-interactive path, which is
 * why the scheduler never owns a Fyers timeframe.
 *
 * A refresh can also refuse while both tokens are nominally valid: on 2026-08-05 it answered
 * code -16, "Refresh token API is currently disabled to comply with SEBI regulations", and
 * then succeeded 19 minutes later. `refreshWithRetry` covers the short version of that.
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
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly refreshAttempts: number;

  constructor(private readonly options: FyersTokenServiceOptions) {
    if (!options.appId.trim() || !options.appSecret.trim()) {
      throw new Error("Fyers access requires FYERS_APP_ID and FYERS_APP_SECRET.");
    }
    this.fetch = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
    this.refreshAttempts = Math.max(1, Math.floor(options.refreshAttempts ?? 3));
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
        refreshed = await this.refreshWithRetry(String(row.refresh_token));
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

  /**
   * Refresh, retrying only failures that could plausibly clear on their own.
   *
   * Bounded on purpose. The observed outage lasted **19 minutes**, which this does not and
   * should not cover: waiting that long would hold the credential row locked and stall every
   * other caller behind it. This is for a refusal measured in seconds. A longer one still
   * needs `assessFyersAuthHealth` to raise it and a human to run `data:auth:fyers` -- the
   * retry narrows the window, it does not remove the failure mode.
   *
   * The final error names the attempt count, so a `last_error` row says whether one refusal
   * or a sustained outage was seen.
   */
  private async refreshWithRetry(
    refreshToken: string,
  ): Promise<{ accessToken: string; expiresAt: Date }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.refreshAttempts; attempt += 1) {
      try {
        return await this.refresh(refreshToken);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof FyersRefreshError && error.retryable;
        if (!retryable || attempt === this.refreshAttempts) break;
        await this.sleep(refreshRetryDelayMs(attempt));
      }
    }

    const attempted = this.refreshAttempts;
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    const wasRetried = lastError instanceof FyersRefreshError && lastError.retryable && attempted > 1;
    throw new FyersRefreshError(
      wasRetried ? `${detail} Retried ${attempted} times without success.` : detail,
      lastError instanceof FyersRefreshError ? lastError.retryable : false,
      lastError instanceof FyersRefreshError ? lastError.code : null,
      lastError instanceof FyersRefreshError ? lastError.httpStatus : null,
    );
  }

  private async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
    let response: Awaited<ReturnType<FetchFunction>>;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v3/validate-refresh-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          appIdHash: this.appIdHash(),
          refresh_token: refreshToken,
          pin: this.options.pin,
        }),
      });
    } catch (error) {
      // Never reached the provider, so nothing was spent and another attempt is free.
      throw new FyersRefreshError(
        `Fyers token refresh could not reach the provider: `
        + `${error instanceof Error ? error.message : String(error)}`,
        true,
        null,
        null,
      );
    }
    const payload = await response.json().catch(() => undefined) as
      | { s?: string; code?: number; message?: string; access_token?: string }
      | undefined;

    // Fyers reports failures in the body with HTTP 200, so status alone is not a verdict.
    if (payload?.code === -371) {
      // A configuration fault, not a blip: retrying cannot change the hash.
      throw new FyersRefreshError(
        "Fyers rejected the appIdHash (-371). Check FYERS_APP_ID and FYERS_APP_SECRET;"
        + " the hash is sha256 of \"appId:appSecret\". This is not an expired token.",
        false,
        -371,
        response.status,
      );
    }
    if (!response.ok || payload?.s !== "ok" || !payload.access_token) {
      const code = payload?.code ?? null;
      throw new FyersRefreshError(
        `Fyers token refresh failed (HTTP ${response.status}, code ${code ?? "none"}).`
        + ` ${redactTokens(payload?.message ?? "No message supplied.")}`,
        isRetryableRefreshFailure({ code, httpStatus: response.status, networkError: false }),
        code,
        response.status,
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
