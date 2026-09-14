import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  buildFyersAuthorizeUrl,
  FYERS_ACCESS_TOKEN_TTL_MS,
  FYERS_REFRESH_TOKEN_TTL_MS,
  FYERS_VALIDATE_AUTHCODE_PATH,
} from "./fyers-oauth.js";

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
 * refusing, and bounded to a few seconds because a second caller that wants a token waits
 * out exactly this window before it gets one.
 */
export function refreshRetryDelayMs(attempt: number): number {
  return 2_000 * 3 ** Math.max(0, attempt - 1);
}

/** Refresh a little before expiry so a long chunked backfill never races the boundary. */
const REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_BASE_URL = "https://api-t1.fyers.in";

/**
 * Advisory-lock key for "a refresh against the Fyers credential is in flight".
 *
 * Session-scoped rather than transaction-scoped, and *tried* rather than waited on. Both
 * matter: the lock has to outlive the short statements that read and write the row, and a
 * caller that cannot have it must be told so in one round trip instead of queueing behind
 * somebody else's backoff. Unlike `FOR UPDATE` on the row, holding it blocks no reader.
 *
 * The namespace is ASCII "FYER" so the key is recognisable in `pg_locks`.
 */
const REFRESH_LOCK_NAMESPACE = 0x46594552;
const REFRESH_LOCK_ID = 1;

/** How often a caller that lost the refresh lock re-reads the row waiting for the winner. */
const PEER_REFRESH_POLL_MS = 1_000;

/** Allowance per refresh HTTP attempt when sizing how long to wait for the winner. */
const PEER_REFRESH_HTTP_ALLOWANCE_MS = 5_000;

/**
 * How long to wait for whoever holds the refresh lock: every attempt they are allowed plus
 * every gap between those attempts.
 *
 * Bounded rather than open-ended on purpose. A waiter that never returns is the shape of the
 * failure this whole path exists to avoid — it just moves the stall from Postgres into Node.
 */
export function peerRefreshWaitMs(attempts: number): number {
  const budget = Math.max(1, Math.floor(attempts));
  let total = budget * PEER_REFRESH_HTTP_ALLOWANCE_MS;
  for (let attempt = 1; attempt < budget; attempt += 1) {
    total += refreshRetryDelayMs(attempt);
  }
  return total;
}

type FetchFunction = typeof fetch;

/** Anything that can run a query: the pool itself, or one checked-out client. */
type QueryExecutor = { query: Pool["query"] };

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
   * Deliberately small. Nothing in `provider_credentials` is locked while the retry backs off,
   * so the budget no longer blocks callers that only want to read the stored token -- but a
   * caller that needs a *new* token still waits out this window before it gets one, so this
   * is the latency every Fyers job pays while the provider is refusing.
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
  /** The one refresh this process has in flight, shared by every caller that arrives during it. */
  private refreshInFlight: Promise<string> | null = null;

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

  buildAuthorizeUrl(redirectUri: string, state: string): string {
    return buildFyersAuthorizeUrl({
      baseUrl: this.baseUrl,
      appId: this.options.appId,
      redirectUri,
      state,
    });
  }

  /**
   * Exchange a one-time auth_code from the Fyers redirect for access + refresh tokens.
   * Does not persist — call `storeTokens` after a successful exchange.
   */
  async exchangeAuthCode(authCode: string): Promise<{ accessToken: string; refreshToken: string }> {
    const code = authCode.trim();
    if (!code) {
      throw new Error("No auth_code was supplied.");
    }

    let response: Awaited<ReturnType<FetchFunction>>;
    try {
      response = await this.fetch(`${this.baseUrl}${FYERS_VALIDATE_AUTHCODE_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          appIdHash: this.appIdHash(),
          code,
        }),
      });
    } catch (error) {
      throw new Error(
        `Fyers auth-code exchange could not reach the provider: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }

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

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
    };
  }

  /** Persist tokens from a fresh authorize (CLI or web OAuth callback). */
  async storeTokens(tokens: { accessToken: string; refreshToken: string }): Promise<{
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
  }> {
    const now = this.now();
    const accessTokenExpiresAt = new Date(now.getTime() + FYERS_ACCESS_TOKEN_TTL_MS);
    const refreshTokenExpiresAt = new Date(now.getTime() + FYERS_REFRESH_TOKEN_TTL_MS);
    await this.options.pool.query(
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
        tokens.accessToken,
        accessTokenExpiresAt,
        tokens.refreshToken,
        refreshTokenExpiresAt,
        now,
      ],
    );
    return { accessTokenExpiresAt, refreshTokenExpiresAt };
  }

  /**
   * Record a failed, state-verified interactive login attempt.
   *
   * Do not clear an older token here: a mistyped/replayed auth code must not stop a
   * session that is still serving market data. The health endpoint nevertheless needs
   * to surface the failed attempt, otherwise the Settings page shows a green `OK` badge
   * beside the OAuth error. A later successful `storeTokens` clears this field.
   */
  async recordAuthenticationFailure(message: string): Promise<void> {
    await this.options.pool.query(
      `INSERT INTO provider_credentials (provider, last_error)
       VALUES ($1, $2)
       ON CONFLICT (provider) DO UPDATE SET
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [FYERS_PROVIDER_ID, redactTokens(message)],
    );
  }

  /**
   * Clear stored tokens so the lab is "logged out" of Fyers until Connect runs again.
   * Keeps the row so `last_error` can explain the disconnect.
   */
  async disconnect(): Promise<void> {
    await this.options.pool.query(
      `INSERT INTO provider_credentials (
         provider, access_token, access_token_expires_at,
         refresh_token, refresh_token_expires_at, last_refreshed_at, last_error
       ) VALUES ($1, NULL, NULL, NULL, NULL, NULL, $2)
       ON CONFLICT (provider) DO UPDATE SET
         access_token = NULL,
         access_token_expires_at = NULL,
         refresh_token = NULL,
         refresh_token_expires_at = NULL,
         last_refreshed_at = NULL,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [FYERS_PROVIDER_ID, "Disconnected via Settings. Connect Fyers again to resume."],
    );
  }

  /**
   * Returns a usable access token, refreshing at most once across the deployment.
   *
   * Nothing is locked while a refresh backs off. The previous shape held `FOR UPDATE` on the
   * credential row across `refreshWithRetry`'s sleeps, which is exactly the sequence that
   * broke on 2026-08-25: the access token expired overnight, every refresh came back
   * "Refresh token API is currently disabled" (code -16, retryable), and the scheduler
   * container spent the backoff window holding the row while every other Fyers caller queued
   * on it. That process logged 206 missed cron executions, stalled for ~22 minutes, and its
   * hour-restricted schedules never fired again until it was restarted.
   *
   * Mutual exclusion is still real, it just no longer runs through a lock anyone can queue
   * on: an in-process single flight collapses concurrent callers onto one refresh, and a
   * session advisory lock keeps a second *process* from burning one too. A caller that loses
   * either race waits for the winner's token instead of failing, which is the property the
   * row lock was there to provide.
   */
  async getAccessToken(): Promise<string> {
    const credential = await this.readCredential();
    if (!credential) {
      throw new Error(
        "No Fyers credential is stored. Run `npm run data:auth:fyers` to authorize once.",
      );
    }

    const usable = this.usableAccessToken(credential);
    if (usable) return usable;

    const refreshExpiry = credential.refreshTokenExpiresAt;
    if (
      !credential.refreshToken
      || (refreshExpiry && refreshExpiry.getTime() <= this.now().getTime())
    ) {
      const message = "Fyers refresh token expired; re-run `npm run data:auth:fyers`.";
      await this.recordError(this.options.pool, message);
      throw new Error(message);
    }

    return this.refreshSingleFlight(credential.refreshToken);
  }

  /**
   * One refresh per process at a time; concurrent callers share the winner's outcome.
   *
   * Cheaper than the advisory lock and it covers the case that actually occurs -- a scheduler
   * tick firing several Fyers jobs at once -- without a round trip each. Sharing the *failure*
   * as well as the success is deliberate: a caller that struck out on the lock has nothing to
   * gain from immediately hammering a provider that just refused three times.
   */
  private refreshSingleFlight(refreshToken: string): Promise<string> {
    const inFlight = this.refreshInFlight;
    if (inFlight) return inFlight;
    // Assigned before any caller can await it, so a racer sees the promise rather than
    // starting a second refresh; cleared once it settles so the next caller starts a real one.
    const started = this.refreshExclusively(refreshToken);
    this.refreshInFlight = started.finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  /**
   * Refresh while holding the advisory lock, or wait for whoever does.
   *
   * The lock is held across the retry window, but it is neither a row lock nor an open
   * transaction: readers of `provider_credentials` never touch it, and a second process that
   * wants to refresh is refused in one round trip rather than parked on it.
   */
  private async refreshExclusively(refreshToken: string): Promise<string> {
    const client = await this.options.pool.connect();
    let holdsLock = false;
    try {
      holdsLock = await this.tryAcquireRefreshLock(client);
      if (holdsLock) return await this.refreshAndStore(client, refreshToken);
    } finally {
      await this.releaseRefreshLock(client, holdsLock);
    }
    // Lock refused, and the connection is already back in the pool: wait holding nothing.
    return this.awaitPeerRefresh();
  }

  private async tryAcquireRefreshLock(client: PoolClient): Promise<boolean> {
    const result = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [REFRESH_LOCK_NAMESPACE, REFRESH_LOCK_ID],
    );
    return result.rows[0]?.locked === true;
  }

  /**
   * A connection that might still hold the lock must never go back into the pool: the next
   * borrower would silently inherit it and no caller could ever refresh again. If the unlock
   * itself fails, destroy the connection so Postgres drops the lock with the session.
   */
  private async releaseRefreshLock(client: PoolClient, holdsLock: boolean): Promise<void> {
    if (!holdsLock) {
      client.release();
      return;
    }
    try {
      await client.query(
        "SELECT pg_advisory_unlock($1, $2)",
        [REFRESH_LOCK_NAMESPACE, REFRESH_LOCK_ID],
      );
      client.release();
    } catch (error) {
      client.release(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Refresh and publish the result, under the advisory lock and under no other lock. */
  private async refreshAndStore(client: PoolClient, refreshToken: string): Promise<string> {
    // Re-read now the lock is ours: a peer may have refreshed between our unlocked read and
    // here, and its token is as good as one we would spend an attempt to fetch.
    const current = await this.readCredential(client);
    const alreadyFresh = current && this.usableAccessToken(current);
    if (alreadyFresh) return alreadyFresh;

    let refreshed: { accessToken: string; expiresAt: Date };
    try {
      refreshed = await this.refreshWithRetry(refreshToken);
    } catch (error) {
      await this.recordError(client, error instanceof Error ? error.message : String(error));
      throw error;
    }

    await client.query(
      `UPDATE provider_credentials
       SET access_token = $2, access_token_expires_at = $3,
           last_refreshed_at = $4, last_error = NULL, updated_at = NOW()
       WHERE provider = $1`,
      [FYERS_PROVIDER_ID, refreshed.accessToken, refreshed.expiresAt, this.now()],
    );
    return refreshed.accessToken;
  }

  /**
   * Wait for the process that holds the refresh lock, holding nothing ourselves.
   *
   * Polling rather than blocking on the lock is the point. A waiter that queued on the lock
   * would be asleep inside somebody else's backoff again, which is the defect one layer down;
   * a waiter that polls costs one cheap `SELECT` a second and can be abandoned.
   */
  private async awaitPeerRefresh(): Promise<string> {
    const budgetMs = peerRefreshWaitMs(this.refreshAttempts);
    const polls = Math.max(1, Math.ceil(budgetMs / PEER_REFRESH_POLL_MS));
    for (let poll = 0; poll < polls; poll += 1) {
      await this.sleep(PEER_REFRESH_POLL_MS);
      const credential = await this.readCredential();
      const fresh = credential && this.usableAccessToken(credential);
      if (fresh) return fresh;
    }
    throw new Error(
      "Another caller has been refreshing the Fyers credential for over "
      + `${Math.round(budgetMs / 1_000)}s without publishing a token.`
      + " Check provider_credentials.last_error.",
    );
  }

  /** Reads the stored credential. Takes no lock — the fast path must not serialise callers. */
  private async readCredential(
    executor: QueryExecutor = this.options.pool,
  ): Promise<FyersCredentialRow | null> {
    const result = await executor.query(
      `SELECT access_token, access_token_expires_at, refresh_token, refresh_token_expires_at
       FROM provider_credentials WHERE provider = $1`,
      [FYERS_PROVIDER_ID],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      accessToken: row.access_token ? String(row.access_token) : null,
      accessTokenExpiresAt: (row.access_token_expires_at as Date | null) ?? null,
      refreshToken: row.refresh_token ? String(row.refresh_token) : null,
      refreshTokenExpiresAt: (row.refresh_token_expires_at as Date | null) ?? null,
    };
  }

  /** The stored token, but only while it is further from expiry than the refresh skew. */
  private usableAccessToken(credential: FyersCredentialRow): string | null {
    const expiry = credential.accessTokenExpiresAt;
    if (!credential.accessToken || !expiry) return null;
    const remainingMs = expiry.getTime() - this.now().getTime();
    return remainingMs > REFRESH_SKEW_MS ? credential.accessToken : null;
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
   * should not cover: every caller that needs a new token waits out this window before it
   * gets one, so a budget that long turns a provider refusal into an outage of its own. This
   * is for a refusal measured in seconds. A longer one still needs `assessFyersAuthHealth` to
   * raise it and a human to run `data:auth:fyers` -- the retry narrows the window, it does not
   * remove the failure mode.
   *
   * Runs with no row lock and no open transaction. Only the refresh advisory lock is held,
   * and that one blocks nobody who merely wants to read the stored token.
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
      expiresAt: new Date(this.now().getTime() + FYERS_ACCESS_TOKEN_TTL_MS),
    };
  }

  private async recordError(executor: QueryExecutor, message: string): Promise<void> {
    await executor.query(
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
